/**
 * @file lib/request-sanitize.js
 * @description Outbound request normalization for upstream providers.
 *
 * The router forwards conversations it did not create, and clients replay them
 * verbatim: assistant turns come back carrying whatever the previous backend
 * emitted, including fields only that backend understands. Strict providers
 * validate the *shape* of every message and reject the entire request over one
 * unknown property — Groq, for example, answers HTTP 400 to any assistant turn
 * carrying `reasoning_content` ("property 'reasoning_content' is unsupported"),
 * even though the model is healthy and other providers accept the same body.
 *
 * Two mechanisms live here, both pure so they can be exercised without booting a
 * server:
 *
 *   1. `stripAssistantReasoning` — unconditional removal of reasoning residue.
 *      Chain-of-thought a model wrote for itself is not useful input to any
 *      backend: some reject it outright, the rest ignore it, and every provider
 *      still bills the tokens. Removing it universally is therefore never a loss
 *      of answer quality. Tool wiring is preserved, including Google's
 *      `thought_signature`, which the router deliberately re-injects.
 *
 *   2. Field-level healing — `parseRejectedFields` reads the offending property
 *      names out of a provider's validation error and `stripFields` removes
 *      exactly those keys. This is deliberately not a hardcoded per-provider deny
 *      list: the router learns what an upstream refuses the first time it refuses
 *      it, so a provider added tomorrow is covered without a code change.
 *
 * The seeded records below are still pure data, but they are now read from the
 * provider catalog rather than declared here, so a provider and the fields it rejects
 * are described in one place (see lib/providers/catalog.js).
 */

import { seededFieldStripTable } from './providers/index.js'

/** Assistant fields that only ever carry model-scribbled reasoning residue. */
export const REASONING_MESSAGE_FIELDS = [
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'analysis',
  'thinking',
]

/** Content-part types that are model-internal rather than conversational. */
export const REASONING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * Keys the router must never trade away to satisfy a provider.
 *
 * At the body root these three are the API contract itself; the tool keys are the
 * agent's ability to act. Dropping any of them would "fix" a 400 by destroying
 * the request, so a provider that rejects them is a failover case, never a
 * healing case.
 */
export const PROTECTED_BODY_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
])

/** Message keys that carry conversation structure or tool wiring. */
export const PROTECTED_MESSAGE_KEYS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'function_call',
  'refusal',
  'audio',
])

/**
 * Message keys the OpenAI chat-completions contract defines. Used only for the
 * unnamed case ("extra inputs are not permitted"): when a strict provider refuses
 * extras without naming them, everything outside this set is what it objected to.
 * `reasoning_content` is intentionally absent — it is residue, handled by the
 * unconditional strip above.
 */
export const KNOWN_MESSAGE_KEYS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'function_call',
  'refusal',
  'audio',
])

/**
 * Providers verified to reject specific request fields, so the very first request
 * to them is already clean instead of paying a healing round trip.
 *
 * Derived from the provider catalog: a descriptor's `sanitize.strips` and
 * `sanitize.rejectsUnknownFields` are projected back into this map's shape.
 *
 * `rejectsUnknownFields` is currently on for Groq alone, because its validator is
 * OpenAI-strict: it refuses any message key outside the contract. The observed refusal
 * that put it there (now recorded in lib/providers/catalog.js):
 *   {"error":{"message":"'messages.3' : for 'role:assistant' the following must be
 *    satisfied[('messages.3' : property 'reasoning_content' is unsupported)]"}}
 */
export const SEEDED_FIELD_STRIPS = seededFieldStripTable()

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Normalizes any parsed/seed/learned shape into the canonical rejection record. */
function normalizeRejection(rejection) {
  const fields = Array.isArray(rejection?.fields) ? rejection.fields.filter(Boolean) : []
  const messageScoped = Array.isArray(rejection?.messageScoped)
    ? rejection.messageScoped.filter(Boolean)
    : []
  return {
    fields: [...new Set(fields)],
    messageScoped: [...new Set(messageScoped)],
    rejectsUnknownFields: Boolean(rejection?.rejectsUnknownFields),
  }
}

/**
 * Removes reasoning residue from every assistant turn.
 *
 * Scoped to `role: 'assistant'` on purpose: a user or tool turn carrying one of
 * these keys is client data, not model residue, and silently dropping it could
 * change what the model is being asked. The top-level `reasoning` *parameter*
 * (OpenRouter's effort control) is a different thing again and is never touched,
 * because only message objects are walked here.
 *
 * @param {object} body  outbound chat-completions body
 * @returns {{ body: object, stripped: string[] }} body plus the field names removed
 */
export function stripAssistantReasoning(body) {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return { body, stripped: [] }
  const stripped = new Set()
  let modified = false
  const messages = body.messages.map(message => {
    if (!isPlainObject(message) || message.role !== 'assistant') return message
    let next = message
    for (const field of REASONING_MESSAGE_FIELDS) {
      if (!(field in next)) continue
      if (next === message) next = { ...message }
      delete next[field]
      stripped.add(field)
    }
    if (Array.isArray(next.content)) {
      const filtered = next.content.filter(part => !(isPlainObject(part) && REASONING_BLOCK_TYPES.has(String(part.type))))
      if (filtered.length !== next.content.length) {
        if (next === message) next = { ...message }
        next.content = filtered
        stripped.add('content[thinking]')
      }
    }
    if (next !== message) modified = true
    return next
  })
  return { body: modified ? { ...body, messages } : body, stripped: [...stripped] }
}

/** Keeps only the final path segment, so "messages.3.reasoning_content" reads as a field. */
function finalPathSegment(raw) {
  const last = String(raw || '').split('.').filter(Boolean).pop() || ''
  const cleaned = last.replace(/[^A-Za-z0-9_$-]/g, '')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : ''
}

/**
 * Pulls field names out of a validation error, and records whether the provider
 * refused unnamed extras.
 *
 * Providers phrase this differently and there is no standard, so each known shape
 * is matched explicitly rather than fuzzily: naming is what makes healing safe,
 * and a loose match risks stripping a field the request genuinely needs.
 *
 * @param {string} errorText  raw provider error body (JSON or plain text)
 * @returns {{ fields: string[], messageScoped: string[], rejectsUnknownFields: boolean }}
 */
export function parseRejectedFields(errorText) {
  const text = typeof errorText === 'string' ? errorText : String(errorText || '')
  const fields = new Set()
  const messageScoped = new Set()
  if (!text.trim()) return { fields: [], messageScoped: [], rejectsUnknownFields: false }

  // Structured validators (FastAPI/pydantic, and anything mirroring it) report the
  // location of the offending field as an array, which is both a name and a scope.
  // {"detail":[{"type":"extra_forbidden","loc":["body","messages",3,"reasoning_content"]}]}
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const queue = [JSON.parse(trimmed)]
      let guard = 0
      while (queue.length > 0 && guard < 500) {
        guard += 1
        const node = queue.shift()
        if (Array.isArray(node)) {
          queue.push(...node)
          continue
        }
        if (!isPlainObject(node)) continue
        if (Array.isArray(node.loc)) {
          const scoped = node.loc.some(part => String(part) === 'messages')
          const name = finalPathSegment([...node.loc].reverse().find(part => typeof part === 'string') || '')
          if (name) {
            fields.add(name)
            if (scoped) messageScoped.add(name)
          }
        }
        queue.push(...Object.values(node))
      }
    } catch {
      /* not JSON — the text patterns below still apply */
    }
  }

  const add = (raw, scoped) => {
    const name = finalPathSegment(raw)
    if (!name) return
    fields.add(name)
    if (scoped) messageScoped.add(name)
  }

  // Groq / pydantic-style naming: "property 'reasoning_content' is unsupported".
  // The surrounding text also carries the message path ("'messages.3' : ..."), and
  // the two are close together, so a nearby messages.N reference means message scope.
  // Quotes may arrive JSON-escaped (\"), since this runs on the raw body text.
  for (const match of text.matchAll(/property\s+\\?['"`]([A-Za-z_][\w.-]*)\\?['"`]/gi)) {
    const window = text.slice(Math.max(0, match.index - 120), match.index + 120)
    add(match[1], /messages\s*[.[]\s*\d/.test(window))
  }

  // OpenAI: "Unrecognized request argument supplied: foo" (optionally a list).
  for (const match of text.matchAll(/unrecognized\s+request\s+arguments?\s+supplied[:\s]+([^\n]*)/gi)) {
    for (const part of String(match[1]).split(/[,;]/)) add(part.trim(), false)
  }

  // Azure OpenAI: "Unknown parameter: 'foo'" / "Unsupported parameter: 'foo'".
  for (const match of text.matchAll(/(?:unknown|unsupported|unrecognized)\s+parameter[:\s]+['"`]?([A-Za-z_][\w.-]*)['"`]?/gi)) {
    add(match[1], false)
  }

  // Google: "Unknown name \"foo\": Cannot find field." — the name is quoted on the
  // wire, and those quotes are backslash-escaped when read from a raw JSON body.
  for (const match of text.matchAll(/unknown\s+name\s*\\?['"\u201c]([A-Za-z_][\w.-]*)\\?['"\u201d]/gi)) {
    add(match[1], false)
  }

  // Generic unnamed-phrasing companions: "unexpected field 'foo'", "extraneous key foo".
  for (const match of text.matchAll(/(?:unexpected|unknown|unrecognized|extraneous|additional)\s+(?:field|property|key|attribute|input)s?[:\s]+\\?['"`]?([A-Za-z_][\w.-]*)['"`]?/gi)) {
    add(match[1], false)
  }

  // A refusal that names nothing: "extra inputs are not permitted", pydantic's
  // extra_forbidden, or an unknown-keyword complaint. Healing then falls back to
  // dropping message keys outside the OpenAI contract.
  const rejectsUnknownFields = /extra_forbidden|extras?\s+(?:inputs?\s+)?(?:are|is)\s+not\s+permitted|additional\s+properties\s+are\s+not\s+permitted|unexpected\s+keyword|too\s+many\s+(?:fields|properties)|unknown\s+(?:fields|properties|arguments|keys)|unrecognized\s+(?:fields|properties|keys)/i.test(text)

  return {
    fields: [...fields],
    messageScoped: [...messageScoped],
    rejectsUnknownFields,
  }
}

/** True when the parsed rejection is something `stripFields` can act on. */
export function isHealableFieldRejection(rejection) {
  return Boolean(rejection) && (rejection.fields?.length > 0 || rejection.rejectsUnknownFields)
}

/** Human-readable rejection summary for logs and error hints. */
export function describeRejection(rejection) {
  const parts = []
  if (rejection?.fields?.length) parts.push(rejection.fields.join(', '))
  if (rejection?.rejectsUnknownFields) parts.push('non-standard message fields')
  return parts.join(', ')
}

/**
 * Removes the named fields (and, when the provider refused unnamed extras, message
 * keys outside the OpenAI contract) from the outbound body.
 *
 * Named fields are removed wherever they appear rather than scope-by-scope: the
 * provider has stated the field is not acceptable, and no legitimate chat payload
 * carries the same name at two levels with different meanings. Protected keys are
 * skipped regardless, so a provider naming `content` or `tools` cannot make the
 * router hollow out the request — that becomes a failover instead.
 *
 * @param {object} body  outbound chat-completions body
 * @param {object} rejection  parsed rejection record
 * @returns {{ body: object, stripped: string[] }}
 */
export function stripFields(body, rejection) {
  const { fields, rejectsUnknownFields } = normalizeRejection(rejection)
  if (!isPlainObject(body)) return { body, stripped: [] }
  const targets = new Set(fields.filter(f => !PROTECTED_BODY_KEYS.has(f) && !PROTECTED_MESSAGE_KEYS.has(f)))
  if (targets.size === 0 && !rejectsUnknownFields) return { body, stripped: [] }

  const stripped = new Set()
  const next = { ...body }

  for (const key of Object.keys(body)) {
    if (PROTECTED_BODY_KEYS.has(key)) continue
    if (!targets.has(key)) continue
    delete next[key]
    stripped.add(key)
  }

  if (Array.isArray(body.messages)) {
    let messagesChanged = false
    const messages = body.messages.map(message => {
      if (!isPlainObject(message)) return message
      let copy = message
      for (const key of Object.keys(message)) {
        if (PROTECTED_MESSAGE_KEYS.has(key)) continue
        const named = targets.has(key)
        const unknown = rejectsUnknownFields && !KNOWN_MESSAGE_KEYS.has(key)
        if (!named && !unknown) continue
        if (copy === message) copy = { ...message }
        delete copy[key]
        stripped.add(key)
      }
      if (copy !== message) messagesChanged = true
      return copy
    })
    if (messagesChanged) next.messages = messages
  }

  return { body: stripped.size > 0 ? next : body, stripped: [...stripped] }
}

/** Builds the server-lifetime learned-strip store, seeded with verified providers. */
export function createLearnedStrips(seed = SEEDED_FIELD_STRIPS) {
  const learned = new Map()
  for (const [providerKey, rejection] of Object.entries(seed || {})) {
    learned.set(providerKey, normalizeRejection(rejection))
  }
  return learned
}

/** The learned record for a provider, or null when nothing has been learned yet. */
export function getLearnedStrips(learned, providerKey) {
  if (!learned || !providerKey) return null
  return learned.get(providerKey) || null
}

/**
 * Folds a freshly observed rejection into a provider's learned record, so every
 * later request to that provider is sanitized up front instead of paying another
 * failed round trip.
 */
export function recordLearnedStrips(learned, providerKey, rejection) {
  const merged = normalizeRejection({
    fields: [...(learned.get(providerKey)?.fields || []), ...(rejection?.fields || [])],
    messageScoped: [...(learned.get(providerKey)?.messageScoped || []), ...(rejection?.messageScoped || [])],
    rejectsUnknownFields: Boolean(learned.get(providerKey)?.rejectsUnknownFields || rejection?.rejectsUnknownFields),
  })
  if (learned && providerKey) learned.set(providerKey, merged)
  return merged
}

/**
 * The single outbound sanitizer: reasoning residue plus everything learned about
 * this provider, optionally including a rejection observed on the current attempt.
 *
 * @param {object} body  outbound chat-completions body
 * @param {string} providerKey  upstream being called
 * @param {Map} learned  store from `createLearnedStrips`
 * @param {object|null} [extraRejection]  rejection parsed from this attempt's error
 * @returns {{ body: object, stripped: string[] }}
 */
export function sanitizeProviderPayload(body, providerKey, learned, extraRejection = null) {
  const stripped = new Set()
  let current = body

  const reasoning = stripAssistantReasoning(current)
  current = reasoning.body
  for (const field of reasoning.stripped) stripped.add(field)

  for (const rejection of [getLearnedStrips(learned, providerKey), extraRejection]) {
    if (!isHealableFieldRejection(rejection)) continue
    const result = stripFields(current, rejection)
    current = result.body
    for (const field of result.stripped) stripped.add(field)
  }

  return { body: current, stripped: [...stripped] }
}
