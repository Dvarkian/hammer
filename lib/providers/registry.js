/**
 * ── The provider registry ──────────────────────────────────────────────────────────────
 *
 * Holds one descriptor per provider and derives the tables that used to be maintained by
 * hand in five files. Registration validates, so a bad descriptor (a typo'd key, an
 * unknown auth kind, a provider with no endpoint and no models) fails immediately and
 * loudly instead of producing a provider that silently cannot route.
 *
 * The registry is also the seam for behavior. Providers such as `kiro`, `devin`,
 * `openai-codex` and `gptfree` are not OpenAI-shaped and need real code for request
 * building, response translation or credential minting. That code still lives in
 * `lib/server.js` — moving it out is the next stage — but it is *named* here, so a
 * provider's descriptor and its behavior have one address instead of two. Registering
 * the implementations through {@link registerProviderHooks} keeps `server.js` free to
 * import this module without a cycle, because the implementations are handed *in*
 * rather than imported.
 */

import {
  normalizeDescriptor,
  validateDescriptor,
  PROVIDER_KEY_PATTERN,
} from './schema.js'

/** @type {Map<string, object>} */
const descriptors = new Map()

/** @type {Map<string, object>} provider key -> behavior implementations */
const hooks = new Map()

/**
 * Registers (or replaces) a provider.
 *
 * @param {string} key
 * @param {object} raw  a partial descriptor; see `schema.js`
 * @param {{ replace?: boolean }} [options]
 * @returns {object} the normalized descriptor
 * @throws {Error} when the key is malformed, already taken, or the descriptor is invalid
 */
export function registerProvider(key, raw = {}, options = {}) {
  if (!PROVIDER_KEY_PATTERN.test(String(key || ''))) {
    throw new Error(`provider key "${key}" must be lowercase letters, digits and dashes`)
  }
  if (descriptors.has(key) && options.replace !== true) {
    throw new Error(`provider "${key}" is already registered`)
  }
  const descriptor = normalizeDescriptor(key, raw)
  const problems = validateDescriptor(descriptor)
  if (problems.length > 0) {
    throw new Error(`invalid provider "${key}": ${problems.join('; ')}`)
  }
  descriptors.set(key, descriptor)
  return descriptor
}

/**
 * @param {string} key
 * @returns {object|null}
 */
export function getProvider(key) {
  return descriptors.get(key) || null
}

/** @param {string} key */
export function hasProvider(key) {
  return descriptors.has(key)
}

/** @returns {string[]} provider keys in registration order */
export function providerKeys() {
  return [...descriptors.keys()]
}

/** @returns {object[]} every descriptor in registration order */
export function listProviders() {
  return [...descriptors.values()]
}

/**
 * Providers matching a predicate, as descriptors.
 *
 * @param {(descriptor: object) => boolean} predicate
 * @returns {object[]}
 */
export function findProviders(predicate) {
  return listProviders().filter(predicate)
}

/** Providers that answer with no credential at all. */
export function keylessProviders() {
  return findProviders(d => d.auth.kind === 'none' || d.auth.optional === true)
}

/**
 * Providers that cannot work until the user supplies a credential. These are what a
 * bulk catalog import lands as: routable in principle, unproven in fact.
 */
export function providersNeedingKeys() {
  return findProviders(d => d.auth.kind !== 'none' && d.auth.optional !== true)
}

/**
 * @param {string} flag  one of `TOS_FLAGS` in `schema.js`
 * @returns {object[]}
 */
export function providersByTosFlag(flag) {
  return findProviders(d => d.tos === flag)
}

/** @param {string} origin  one of `ORIGINS` in `schema.js` */
export function providersByOrigin(origin) {
  return findProviders(d => d.origin === origin)
}

/** Empties the registry. For tests and for reloading a generated catalog. */
export function resetRegistry() {
  descriptors.clear()
  hooks.clear()
}

/**
 * ── Behavior hook seam ────────────────────────────────────────────────────────────────
 *
 * `lib/server.js` owns the implementations today (request payload builders, response
 * translators, token minters). It hands them in here at module load, which lets the
 * request path ask the registry for behavior by provider key and gives the eventual
 * move-out of `server.js` a single, already-wired destination.
 */

/**
 * @param {string} key
 * @param {object} implementations  e.g. `{ buildBody, buildHeaders, transformResponse }`
 */
export function registerProviderHooks(key, implementations = {}) {
  const current = hooks.get(key) || {}
  hooks.set(key, { ...current, ...implementations })
}

/**
 * @param {string} key
 * @returns {object|null}
 */
export function getProviderHooks(key) {
  return hooks.get(key) || null
}

/**
 * Provider-scoped failure evidence, consumed by the error classifier.
 *
 * `lib/utils.js` matches a shared set of patterns. These are the ones that only make
 * sense for one provider — NVIDIA's account-scoped 404, Google's api-version 404,
 * OpenCode Zen's withdrawn model — collected here so the classifier can consult them
 * without knowing which provider it is looking at.
 *
 * @param {string} key
 * @returns {{ dead: RegExp[], incompatible: RegExp[] }}
 */
export function providerClassifyPatterns(key) {
  const descriptor = getProvider(key)
  return {
    dead: descriptor ? [...descriptor.classify.dead] : [],
    incompatible: descriptor ? [...descriptor.classify.incompatible] : [],
  }
}

/**
 * @param {string} key
 * @param {string} errorText
 * @param {number|string|null} [status]
 * @returns {boolean} true when this provider's own evidence classifies the failure as permanent
 */
export function matchesProviderDeadError(key, errorText, status = null) {
  const text = String(errorText || '')
  if (Number(status) === 410) return true
  return providerClassifyPatterns(key).dead.some(pattern => pattern.test(text))
}

/**
 * ── Derived tables ────────────────────────────────────────────────────────────────────
 *
 * Each of these returns the exact shape its old hand-maintained table had, so the
 * consumers (`sources.js`, `config.js`, `providerLinks.js`, `request-sanitize.js`) keep
 * their exported API and their callers are untouched.
 */

/**
 * The quota table, derived from the descriptors.
 *
 * It used to be hand-maintained in `sources.js` and read from there by the router, while
 * this function claimed to replace it; the data now lives in the catalog it describes, so
 * this is the path the dashboard actually reads.
 */
export function providerQuotaTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.quota) table[key] = descriptor.quota
  }
  return table
}

/** Replaces `lib/providerLinks.js`'s `API_KEY_SIGNUP_URLS`. */
export function signupUrlTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.signupUrl) table[key] = descriptor.signupUrl
  }
  return table
}

/** Replaces `lib/config.js`'s `ENV_VARS`. */
export function apiKeyEnvVarTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.auth.envVar) table[key] = descriptor.auth.envVar
  }
  return table
}

/** Replaces `lib/config.js`'s `PROVIDER_BASE_URL_ENV_VARS`. */
export function baseUrlEnvVarTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.auth.baseUrlEnvVar) table[key] = descriptor.auth.baseUrlEnvVar
  }
  return table
}

/** Replaces `lib/config.js`'s `PROVIDER_MODEL_ID_ENV_VARS`. */
export function modelIdEnvVarTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.auth.modelIdEnvVar) table[key] = descriptor.auth.modelIdEnvVar
  }
  return table
}

/** Replaces `lib/config.js`'s `OAUTH_ACCOUNT_PROVIDERS`. */
export function oauthAccountProviders() {
  return new Set(findProviders(d => d.auth.kind === 'oauth').map(d => d.key))
}

/** Replaces `lib/config.js`'s `LEGACY_ACCOUNT_SECRET_FIELDS`. */
export function legacyAccountSecretFieldTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    if (descriptor.auth.legacySecretField) table[key] = descriptor.auth.legacySecretField
  }
  return table
}

/**
 * Replaces `lib/request-sanitize.js`'s `SEEDED_FIELD_STRIPS`.
 *
 * The consumer's shape is `{ [providerKey]: { fields, rejectsUnknownFields } }`, so a
 * provider with nothing to strip is omitted entirely rather than emitted empty.
 */
export function seededFieldStripTable() {
  const table = {}
  for (const [key, descriptor] of descriptors) {
    const { strips, rejectsUnknownFields } = descriptor.sanitize
    if (strips.length === 0 && !rejectsUnknownFields) continue
    table[key] = { fields: [...strips], rejectsUnknownFields }
  }
  return table
}
