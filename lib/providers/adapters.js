/**
 * ── Turning a provider's declarative shaping into a request ─────────────────────────────
 *
 * A descriptor's `shaping` block says how a provider's request differs from a bare OpenAI
 * one. This module is its only reader, and it exists so that "this provider wants its key in
 * `x-goog-api-key`", "this one rejects content-part arrays", "this one's endpoint embeds an
 * account id" are *data* rather than branches in `lib/server.js`.
 *
 * The distinction that matters here is between the two ways a provider can be unusual:
 *
 *   **Shaping (this module).** A different header, a URL with a placeholder in it, a body
 *   field the provider insists on, a content shape it refuses. Every one of these is a
 *   transformation of a request that is otherwise OpenAI-shaped, so it needs no protocol
 *   knowledge — only the field name and the value.
 *
 *   **A wire protocol (`lib/providers/wire/`).** A handshake, a session cookie jar, a
 *   non-SSE line format, a GraphQL document. That is not a transformation of an OpenAI
 *   request; it is a different request. Those live behind their own module and their own
 *   transport, and a provider without one is `staged` rather than half-wired.
 *
 * Everything here is pure and synchronous: it reads the registry and returns new values. No
 * network access, so importing this module cannot add a startup probe.
 */

import { getProvider } from './registry.js'

/** @returns {object|null} the descriptor's shaping block, or null for a plain endpoint. */
export function providerShaping(providerKey) {
  return getProvider(providerKey)?.shaping || null
}

/** True when the provider needs any kind of shaping beyond a bare OpenAI request. */
export function hasShaping(providerKey) {
  return providerShaping(providerKey) !== null
}

/**
 * Fields a template URL or a credential lifecycle needs beyond the API key itself.
 *
 * Cloudflare's Workers AI endpoint embeds the account id; Vertex's embeds the project and
 * region. Both are provider facts rather than secrets, so they live in the provider's config
 * entry (or an env var) instead of being appended to the key.
 *
 * @returns {string[]}
 */
export function requiredCredentialFields(providerKey) {
  return providerShaping(providerKey)?.credentialFields || []
}

/** Env var names consulted for a credential field, in priority order. */
const CREDENTIAL_FIELD_ENV = {
  accountId: ['CLOUDFLARE_ACCOUNT_ID'],
  project: ['VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT'],
  region: ['VERTEX_REGION', 'GOOGLE_CLOUD_REGION'],
}

/**
 * Every value a provider has for one credential field, in configured order.
 *
 * A field is normally one value, but Cloudflare's account id is one *per account*: a
 * second Workers AI key belongs to a second account, and a request sent with that key
 * against the first account's URL is rejected. So `accountId` may be stored as a list
 * (one entry per pooled credential), while a plain string stays the one-account case.
 *
 * Env vars remain a single fallback value: a process-level variable describes one
 * account, and a list in the environment would have no pool to line up against anyway.
 *
 * @param {object} config
 * @param {string} providerKey
 * @param {string} field
 * @returns {string[]}
 */
export function credentialFieldList(config, providerKey, field) {
  const providerConfig = config?.providers?.[providerKey] || {}
  const stored = providerConfig[field]
  if (Array.isArray(stored)) {
    return stored.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  }
  if (typeof stored === 'string' && stored.trim()) return [stored.trim()]
  for (const envName of CREDENTIAL_FIELD_ENV[field] || []) {
    const fromEnv = process.env[envName]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return [fromEnv.trim()]
  }
  return []
}

/**
 * Reads a provider's extra credential fields from config, then the environment.
 *
 * `credentialIndex` selects which entry of a multi-valued field this request belongs to,
 * so a pooled provider can pair its nth credential with its nth account. It defaults to
 * the first entry, which is what every single-account caller wants.
 *
 * @param {object} config
 * @param {string} providerKey
 * @param {number} [credentialIndex]
 * @returns {Record<string, string>}
 */
export function credentialFieldValues(config, providerKey, credentialIndex = 0) {
  const fields = requiredCredentialFields(providerKey)
  if (fields.length === 0) return {}

  const values = {}
  for (const field of fields) {
    const list = credentialFieldList(config, providerKey, field)
    // Past the end of a shorter list the last entry stands in, rather than the field
    // reading as missing: one account id with three keys is a legitimate setup (all
    // three keys belong to that account), and it should not report "needs accountId".
    const picked = list.length === 0 ? '' : list[Math.min(credentialIndex, list.length - 1)]
    if (picked) values[field] = picked
  }
  return values
}

/** @returns {string[]} credential fields the provider needs and does not have. */
export function missingCredentialFields(config, providerKey) {
  return requiredCredentialFields(providerKey).filter(field => !credentialFieldValues(config, providerKey)[field])
}

/**
 * Substitutes a provider's `{field}` placeholders from its credential values.
 *
 * A missing field yields `url: null` rather than a URL containing a literal `{accountId}`:
 * the request path already reports a null URL as `NO_URL`, which is a truthful "not
 * configured" instead of a 404 from a malformed host.
 *
 * Exported because more than the chat URL is account-scoped: Cloudflare's model list lives
 * at `/accounts/{accountId}/ai/models/search`, so discovery needs the same substitution or
 * it would probe a URL that still has the placeholder in it.
 *
 * @param {object} config
 * @param {string} providerKey
 * @param {string|null} template
 * @param {number} [credentialIndex]
 * @returns {{ url: string|null, missing: string[] }}
 */
export function substituteCredentialFields(config, providerKey, template, credentialIndex = 0) {
  if (typeof template !== 'string' || !template) return { url: null, missing: [] }
  if (!template.includes('{')) return { url: template, missing: [] }

  const values = credentialFieldValues(config, providerKey, credentialIndex)
  // A field can appear more than once in a template (Vertex repeats `{region}`, once in
  // the host and once in the path), so a missing field is reported once rather than once
  // per occurrence: `['project','region']` is the set the operator has to supply, and a
  // duplicated `region` reads as if two values were needed.
  const missing = []
  const seenMissing = new Set()
  const url = template.replace(/\{(\w+)\}/g, (_match, field) => {
    if (values[field]) return values[field]
    if (!seenMissing.has(field)) {
      seenMissing.add(field)
      missing.push(field)
    }
    return `{${field}}`
  })
  return { url: missing.length > 0 ? null : url, missing }
}

/**
 * Builds the chat URL, substituting any `{field}` placeholders from the credential values.
 *
 * Only a descriptor that declares `urlTemplate` is treated as one, so a provider whose URL
 * merely happens to contain a brace is passed through rather than silently rewritten.
 *
 * @returns {{ url: string|null, missing: string[] }}
 */
export function resolveShapedChatUrl(config, providerKey, fallbackUrl = null, credentialIndex = 0) {
  const descriptor = getProvider(providerKey)
  const template = descriptor?.chatUrl || fallbackUrl
  if (!template) return { url: null, missing: [] }

  const shaping = providerShaping(providerKey)
  if (!shaping?.urlTemplate || !template.includes('{')) return { url: template, missing: [] }

  return substituteCredentialFields(config, providerKey, template, credentialIndex)
}

/**
 * Static headers the provider requires regardless of the request.
 *
 * Returned as a new object so a caller can merge without mutating the descriptor — the
 * descriptor is read on every request, so a mutation here would leak across requests.
 *
 * @returns {Record<string, string>}
 */
export function shapedHeaders(providerKey) {
  return { ...(providerShaping(providerKey)?.headers || {}) }
}

/**
 * Collapses OpenAI content-part arrays to a plain string.
 *
 * Strict backends (Cloudflare's Workers AI among them) accept only a string and reject
 * `[{ type: 'text', text }]` with HTTP 400. Text parts are joined; a non-text part cannot be
 * represented in a string, so it is *dropped and reported* rather than silently emptied —
 * the caller can then tell the user their image could not be sent, which is the difference
 * between a visible limitation and a disappearing attachment.
 *
 * @returns {{ messages: object[], droppedParts: string[] }}
 */
export function flattenTextContent(messages) {
  const droppedParts = []
  if (!Array.isArray(messages)) return { messages, droppedParts }

  const flattened = messages.map(message => {
    if (!message || !Array.isArray(message.content)) return message
    const parts = []
    for (const part of message.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
      else if (typeof part === 'object' && part?.type) droppedParts.push(String(part.type))
    }
    return { ...message, content: parts.join('') }
  })
  return { messages: flattened, droppedParts }
}

/**
 * Applies everything that changes the *body*: model id rewriting, frozen request defaults,
 * and content flattening.
 *
 * Request defaults fill blanks only. A provider's declared default is where the provider's
 * own UI would start, not a value that overrides what the caller asked for — otherwise a
 * client that deliberately asked for a short answer would silently get a long one.
 *
 * @returns {{ body: object, droppedParts: string[] }}
 */
export function applyRequestShaping(providerKey, body, modelId = null) {
  const shaping = providerShaping(providerKey)
  if (!shaping || !body || typeof body !== 'object') return { body, droppedParts: [] }

  const next = { ...body }
  const droppedParts = []

  if (shaping.modelIdPrefix) {
    const id = modelId || next.model
    if (typeof id === 'string' && id && !id.startsWith(shaping.modelIdPrefix)) {
      next.model = `${shaping.modelIdPrefix}${id}`
    }
  }

  if (shaping.requestDefaults) {
    for (const [key, value] of Object.entries(shaping.requestDefaults)) {
      if (next[key] === undefined) next[key] = value
    }
  }

  if (shaping.flattenTextContent) {
    const result = flattenTextContent(next.messages)
    next.messages = result.messages
    droppedParts.push(...result.droppedParts)
  }

  return { body: next, droppedParts }
}

/** @returns {number|null} a per-provider upstream timeout in milliseconds. */
export function shapedTimeoutMs(providerKey) {
  const timeoutMs = providerShaping(providerKey)?.timeoutMs
  return Number.isFinite(timeoutMs) ? timeoutMs : null
}

/**
 * A one-line description of what this provider needs that it does not have, for the
 * dashboard and the verification tool. `null` when the provider is ready to route.
 *
 * @returns {string|null}
 */
export function shapingReadiness(config, providerKey) {
  const missing = missingCredentialFields(config, providerKey)
  if (missing.length === 0) return null
  return `needs ${missing.join(' and ')} (set it in this provider's settings or as ${missing
    .flatMap(field => CREDENTIAL_FIELD_ENV[field] || [])
    .join(' / ')})`
}
