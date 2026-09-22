/**
 * ── The provider descriptor contract ────────────────────────────────────────────────────
 *
 * A provider used to be knowledge scattered across five files: its request/response
 * behavior and auth in `lib/server.js`, its env var and base URL in `lib/config.js`,
 * its quota in `sources.js` (since moved to `lib/providers/catalog.js`), its field-rejection
 * record in `lib/request-sanitize.js`,
 * and its signup link in `lib/providerLinks.js`. Nothing owned "a provider", so adding
 * one meant editing all five, and `lib/server.js` grew 109 `providerKey ===` branches
 * (~10 per provider) as a result.
 *
 * A descriptor is that knowledge in one object. Everything is optional except `key`;
 * anything omitted falls back to {@link DESCRIPTOR_DEFAULTS}, which describes a plain
 * OpenAI-compatible endpoint. A provider that needs no special behavior is therefore
 * pure data — which is what makes bulk-importing a catalog possible at all.
 *
 * Descriptors are validated at registration (see `registry.js`), so a malformed entry
 * imported from an external catalog fails loudly in a test rather than silently
 * producing a provider that cannot route.
 */

/** How a provider authenticates. `oauth` and `token-mint` own a credential lifecycle. */
export const AUTH_KINDS = ['none', 'bearer', 'header', 'oauth', 'token-mint', 'custom']

/**
 * How the provider's free access is granted. Kept as data because it is what the user
 * actually cares about when deciding whether to enable an imported provider.
 *  - `permanent`     always free, rate-limited, no published token cap
 *  - `recurring`     a documented monthly free grant
 *  - `signup-credit` one-time credit granted at signup (does not recur)
 *  - `oauth`         free via an account sign-in rather than a key
 *  - `keyless`       no credential at all
 *  - `unknown`       not established
 */
export const ACCESS_KINDS = ['permanent', 'recurring', 'signup-credit', 'oauth', 'keyless', 'unknown']

/**
 * The upstream terms-of-service flag for personal/self-hosted proxy use.
 *  - `ok`        explicitly permitted
 *  - `caution`   a personal-use or proxy clause worth reading
 *  - `ambiguous` unclear
 *  - `avoid`     terms appear to prohibit this kind of use
 *  - `unknown`   no terms could be reviewed
 *
 * Advisory, never a routing gate: it exists so a bulk-imported provider cannot be
 * enabled by accident without the user seeing what its terms say.
 */
export const TOS_FLAGS = ['ok', 'caution', 'ambiguous', 'avoid', 'unknown']

/** How a provider's row set is maintained. */
export const ORIGINS = ['hammer', 'omniroute']

/** Where a descriptor's model rows live, when they are not inline. */
export const MODEL_SOURCES = ['inline', 'sources']

/**
 * Whether a provider may carry traffic, and if not, which kind of "not".
 *
 *  - `active`  routable. Its endpoint is known and it can ride the generic path.
 *  - `staged`  resolvable in principle, but needs provider-specific work first (a
 *              translator, an adapter, a sign-in flow). Never routed to.
 *  - `refused` deliberately withheld — currently because the upstream terms forbid
 *              this kind of use. Never routed to, and always carries a reason.
 *
 * The distinction between `staged` and `refused` is the point: one is "not built yet",
 * the other is "decided against", and collapsing them would lose the decision.
 */
export const ACTIVATIONS = ['active', 'staged', 'refused']

export const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** A descriptor with nothing supplied but a key behaves as a plain OpenAI endpoint. */
export const DESCRIPTOR_DEFAULTS = Object.freeze({
  label: null,
  chatUrl: null,
  /** Derived from `chatUrl` when null (see {@link derivedModelsUrl}). */
  modelsUrl: null,
  contextUrl: null,
  signupUrl: null,
  auth: Object.freeze({
    kind: 'bearer',
    /** Env var holding the API key for headless use. */
    envVar: null,
    /** Env var overriding the endpoint URL. */
    baseUrlEnvVar: null,
    /** Env var pinning a single model id. */
    modelIdEnvVar: null,
    /** True when the provider works with no credential and a key only raises limits. */
    optional: false,
    /** True when several credentials can be rotated (see config's key pools). */
    pool: false,
    /**
     * Which request header carries the credential. Almost every provider uses
     * `Authorization`; a few take the key in a provider-specific header, and saying so
     * here is the whole adapter — no per-provider code in the request path.
     */
    headerName: 'Authorization',
    /**
     * The scheme prefix in front of the credential, or `null` for a bare value. `Bearer`
     * is the OpenAI convention and the default; a provider that wants the raw key with no
     * prefix sets this to null rather than hammer being taught its name.
     */
    scheme: 'Bearer',
    /** The single-credential config field an OAuth provider used before pools. */
    legacySecretField: null,
    /** Env var holding an OAuth refresh token, for OAuth providers. */
    refreshTokenEnvVar: null,
  }),
  /**
   * How this provider's request differs from a bare OpenAI one, as data.
   *
   * This is the whole adapter story for everything but a wire protocol: a static header, a
   * frozen request default, a URL with a placeholder in it, a body the provider insists be
   * shaped a particular way. `lib/providers/adapters.js` is the only reader, so adding a
   * provider with one of these needs no code in the request path.
   *
   * `null` when the provider is a plain OpenAI endpoint.
   */
  shaping: null,
  /** Published free-tier limits. `null` when nothing is observable. */
  quota: null,
  sanitize: Object.freeze({ strips: Object.freeze([]), rejectsUnknownFields: false }),
  /** Provider-scoped failure evidence, consumed by the error classifier. */
  classify: Object.freeze({ dead: Object.freeze([]), incompatible: Object.freeze([]) }),
  /** Whether `/v1/models` (or the provider's own list) can be probed. */
  discoverable: false,
  /** Keep curated rows even when discovery returns a healthy list. */
  keepStaticOnDiscovery: false,
  /** True when the provider is configured as named instances rather than one endpoint. */
  instanceBased: false,
  /** Free-access grant kind (see {@link ACCESS_KINDS}). */
  access: 'unknown',
  /** Terms-of-service flag (see {@link TOS_FLAGS}). */
  tos: 'unknown',
  origin: 'hammer',
  /** `verified` only after a real completion succeeded — never assumed. */
  verification: 'unverified',
  /** See {@link ACTIVATIONS}. */
  activation: 'active',
  /**
   * Why this provider is not `active`. Required for `refused` — a refusal without a
   * recorded reason is indistinguishable from an oversight — and populated for `staged`
   * so the gap is actionable rather than mysterious.
   */
  blockedReason: null,
  /** Provenance for imported descriptors: `{ version, lastUpdated, url }`. */
  source: null,
  modelsSource: 'sources',
  models: Object.freeze([]),
  /** Notes carried from an imported catalog, shown in the UI. */
  notes: null,
})

/**
 * The conventional `/v1/models` URL for a chat-completions endpoint.
 *
 * Providers on the OpenAI wire expose discovery at the sibling of the chat path
 * (`.../v1/chat/completions` -> `.../v1/models`), so this is the default rather than a
 * per-provider decision. Providers whose list lives somewhere else set `modelsUrl`.
 *
 * @param {string|null} chatUrl
 * @returns {string|null}
 */
export function derivedModelsUrl(chatUrl) {
  if (typeof chatUrl !== 'string' || !chatUrl) return null
  const trimmed = chatUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return `${trimmed.slice(0, -'/chat/completions'.length)}/models`
  if (trimmed.endsWith('/responses')) return `${trimmed.slice(0, -'/responses'.length)}/models`
  return null
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : []
}

function asRegExpArray(value) {
  return Array.isArray(value) ? value.filter(v => v instanceof RegExp) : []
}

function normalizeAuth(auth) {
  const input = auth && typeof auth === 'object' ? auth : {}
  // `kind` is deliberately NOT coerced to the default when unrecognized. Auth kind is
  // authored by hand (it is code, not imported data), so an unknown value is a typo that
  // must reach `validateDescriptor` and fail, rather than silently becoming `bearer` and
  // sending a credential the provider never asked for. The `access`/`tos`/`origin`
  // vocabularies, by contrast, do fall back — those describe imported data whose
  // vocabulary can drift without making the provider unusable.
  const kind = typeof input.kind === 'string' && input.kind ? input.kind : DESCRIPTOR_DEFAULTS.auth.kind
  return {
    kind,
    envVar: asString(input.envVar),
    baseUrlEnvVar: asString(input.baseUrlEnvVar),
    modelIdEnvVar: asString(input.modelIdEnvVar),
    optional: input.optional === true,
    pool: input.pool === true,
    headerName: asString(input.headerName) || DESCRIPTOR_DEFAULTS.auth.headerName,
    // `scheme: null` is meaningful (send the bare credential), so it is distinguished
    // from "not specified", which falls back to Bearer.
    scheme: input.scheme === null ? null : (asString(input.scheme) || DESCRIPTOR_DEFAULTS.auth.scheme),
    legacySecretField: asString(input.legacySecretField),
    refreshTokenEnvVar: asString(input.refreshTokenEnvVar),
  }
}

function normalizeQuota(quota) {
  if (!quota || typeof quota !== 'object') return null
  return {
    source: asString(quota.source),
    sourceUrl: asString(quota.sourceUrl),
    window: asString(quota.window),
    limitScope: asString(quota.limitScope),
    /** Documented steady monthly free tokens, when the catalog publishes a figure. */
    steadyTokensPerMonth: Number.isFinite(quota.steadyTokensPerMonth) ? quota.steadyTokensPerMonth : null,
    /** One-time signup credit, when the catalog publishes a figure. */
    signupCreditTokens: Number.isFinite(quota.signupCreditTokens) ? quota.signupCreditTokens : null,
  }
}

/**
 * Normalizes a `shaping` block, keeping only fields the runtime actually reads.
 *
 * Deliberately permissive about *which* fields are present — they are provider data, not a
 * closed enum — but strict about their types, so a mistyped field fails here rather than
 * producing a request that silently differs from what the provider needs.
 */
function normalizeShaping(shaping) {
  if (!shaping || typeof shaping !== 'object') return null

  const headers = shaping.headers && typeof shaping.headers === 'object'
    ? Object.fromEntries(Object.entries(shaping.headers).filter(([, v]) => typeof v === 'string'))
    : null
  const requestDefaults = shaping.requestDefaults && typeof shaping.requestDefaults === 'object'
    ? { ...shaping.requestDefaults }
    : null

  const normalized = {
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(requestDefaults && Object.keys(requestDefaults).length > 0 ? { requestDefaults } : {}),
    ...(shaping.flattenTextContent === true ? { flattenTextContent: true } : {}),
    ...(shaping.jsonMode === true ? { jsonMode: true } : {}),
    ...(Array.isArray(shaping.premiumModels) ? { premiumModels: shaping.premiumModels.filter(v => typeof v === 'string') } : {}),
    ...(asString(shaping.modelIdPrefix) ? { modelIdPrefix: asString(shaping.modelIdPrefix) } : {}),
    ...(shaping.urlTemplate === true ? { urlTemplate: true } : {}),
    ...(Array.isArray(shaping.credentialFields)
      ? { credentialFields: shaping.credentialFields.filter(v => typeof v === 'string') }
      : {}),
    ...(Number.isFinite(shaping.timeoutMs) ? { timeoutMs: shaping.timeoutMs } : {}),
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

function normalizeModelRows(models) {
  if (!Array.isArray(models)) return []
  return models.map(row => (Array.isArray(row) ? row : null)).filter(Boolean)
}

/**
 * Fills a raw descriptor against {@link DESCRIPTOR_DEFAULTS}.
 *
 * @param {string} key  the provider key the descriptor is registered under
 * @param {object} input
 * @returns {object} a fully-populated descriptor
 */
export function normalizeDescriptor(key, input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const chatUrl = asString(raw.chatUrl)
  const classify = raw.classify && typeof raw.classify === 'object' ? raw.classify : {}
  const tos = TOS_FLAGS.includes(raw.tos) ? raw.tos : DESCRIPTOR_DEFAULTS.tos
  const access = ACCESS_KINDS.includes(raw.access) ? raw.access : DESCRIPTOR_DEFAULTS.access
  const origin = ORIGINS.includes(raw.origin) ? raw.origin : DESCRIPTOR_DEFAULTS.origin
  const modelsSource = MODEL_SOURCES.includes(raw.modelsSource) ? raw.modelsSource : DESCRIPTOR_DEFAULTS.modelsSource

  return {
    ...DESCRIPTOR_DEFAULTS,
    key,
    label: asString(raw.label) || key,
    chatUrl,
    modelsUrl: asString(raw.modelsUrl) || derivedModelsUrl(chatUrl),
    contextUrl: asString(raw.contextUrl),
    signupUrl: asString(raw.signupUrl),
    auth: normalizeAuth(raw.auth),
    shaping: normalizeShaping(raw.shaping),
    quota: normalizeQuota(raw.quota),
    sanitize: {
      strips: asStringArray(raw.sanitize?.strips),
      rejectsUnknownFields: raw.sanitize?.rejectsUnknownFields === true,
    },
    classify: {
      dead: asRegExpArray(classify.dead),
      incompatible: asRegExpArray(classify.incompatible),
    },
    discoverable: raw.discoverable === true,
    keepStaticOnDiscovery: raw.keepStaticOnDiscovery === true,
    instanceBased: raw.instanceBased === true,
    access,
    tos,
    origin,
    verification: asString(raw.verification) || DESCRIPTOR_DEFAULTS.verification,
    activation: ACTIVATIONS.includes(raw.activation) ? raw.activation : DESCRIPTOR_DEFAULTS.activation,
    blockedReason: asString(raw.blockedReason),
    source: raw.source && typeof raw.source === 'object' ? { ...raw.source } : null,
    modelsSource,
    models: normalizeModelRows(raw.models),
    notes: asString(raw.notes),
  }
}

/**
 * Checks a normalized descriptor. Returns every problem rather than the first, so a
 * bulk import reports all of its bad rows in one pass.
 *
 * Problems are hard errors (the descriptor is unusable); softer complaints such as a
 * missing signup URL are deliberately not reported, because several existing providers
 * legitimately have none.
 *
 * @param {object} descriptor  output of {@link normalizeDescriptor}
 * @returns {string[]} problems, empty when the descriptor is valid
 */
export function validateDescriptor(descriptor) {
  const problems = []
  const d = descriptor || {}

  if (!asString(d.key)) problems.push('missing key')
  else if (!PROVIDER_KEY_PATTERN.test(d.key)) problems.push(`invalid key "${d.key}": expected lowercase letters, digits and dashes`)
  if (!asString(d.label)) problems.push('missing label')
  if (!AUTH_KINDS.includes(d.auth?.kind)) problems.push(`invalid auth.kind "${d.auth?.kind}"`)
  if (!ACCESS_KINDS.includes(d.access)) problems.push(`invalid access "${d.access}"`)
  if (!TOS_FLAGS.includes(d.tos)) problems.push(`invalid tos "${d.tos}"`)
  if (!ORIGINS.includes(d.origin)) problems.push(`invalid origin "${d.origin}"`)
  if (!ACTIVATIONS.includes(d.activation)) problems.push(`invalid activation "${d.activation}"`)

  // Refusing a provider is a decision, so it has to say why. Without this, an `avoid`
  // entry that was never resolved and one that was consciously withheld look identical.
  if (d.activation === 'refused' && !d.blockedReason) {
    problems.push('activation "refused" needs a blockedReason recording the refusal')
  }

  // Only an `active` provider has to be reachable. A `staged` or `refused` one is
  // deliberately not routable, so its endpoint and model checks are deferred rather than
  // failed — that is what lets an import land incrementally without pretending the roster
  // and the routing configuration are the same thing.
  if (d.activation === 'active') {
    // An endpoint-less, credential-less, model-less provider can never be routed to, so
    // it is a catalog bug rather than a provider that is merely unconfigured.
    const hasEndpoint = Boolean(d.chatUrl) || d.instanceBased === true
    if (!hasEndpoint) problems.push('missing chatUrl (or instanceBased: true)')

    const routableModels = d.modelsSource === 'inline' ? (d.models?.length || 0) > 0 : true
    if (!routableModels && d.discoverable !== true) {
      problems.push('no models and not discoverable: this provider could never be routed to')
    }
  }

  if (d.auth?.kind === 'oauth' && !d.auth.legacySecretField) {
    problems.push('auth.kind "oauth" needs a legacySecretField')
  }
  // A provider with no credential concept (`auth.kind: "none"`) sends no auth header at all,
  // so it is the one case where a missing header name is correct rather than a typo.
  if (d.auth && d.auth.kind !== 'none' && !asString(d.auth.headerName)) {
    problems.push('auth.headerName must be a non-empty header name')
  }

  return problems
}
