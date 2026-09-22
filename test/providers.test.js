/**
 * Provider registry + imported-catalog tests.
 *
 * The repo's previous suite was retired with the model-test feature, so this file also
 * re-establishes the harness: `npm test` runs it with the built-in Node test runner, no
 * dependencies.
 *
 * The tests that carry most of the weight:
 *
 *   - the derived-table parity test, which catches a future edit changing routing behavior
 *     while the refactor was supposed to be behavior-preserving;
 *   - the request-path test, which proves a cold request for an import-only model triggers
 *     on-demand discovery and then becomes a routable candidate, by driving the exact
 *     `resolveRequestModels` the handler calls; and
 *   - the builder test, which proves an imported descriptor feeds the *real* header/body
 *     builders in `lib/server.js` rather than a mock of them. It deliberately does **not**
 *     claim to prove dispatch — the request-path test above does.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  apiKeyEnvVarTable,
  baseUrlEnvVarTable,
  getProvider,
  getProviderHooks,
  importSummary,
  initProviders,
  keylessProviders,
  lazyProviderSourceEntries,
  legacyAccountSecretFieldTable,
  listProviders,
  matchesProviderDeadError,
  modelIdEnvVarTable,
  oauthAccountProviders,
  providerClassifyPatterns,
  providerKeys,
  providerQuotaTable,
  providerSummary,
  providersByTosFlag,
  registerProvider,
  registerProviderHooks,
  resetRegistry,
  routableImports,
  seededFieldStripTable,
  signupUrlTable,
} from '../lib/providers/index.js'

import { PROVIDER_DESCRIPTORS } from '../lib/providers/catalog.js'
import {
  lazyProviderSourceEntries as lazyEntriesDirect,
  loadResolutions,
} from '../lib/providers/resolutions.js'
import { normalizeDescriptor, validateDescriptor, derivedModelsUrl } from '../lib/providers/schema.js'
import {
  applyRequestShaping,
  flattenTextContent,
  resolveShapedChatUrl,
  shapedHeaders,
  shapedModelNeedsKey,
  shapedTimeoutMs,
} from '../lib/providers/adapters.js'
import { humanizeProviderKey, loadOmniRouteCatalog } from '../lib/providers/omniroute.js'
import {
  buildProviderRequestBody,
  buildProviderRequestHeaders,
  PING_TIMEOUT,
} from '../lib/server.js'
import {
  DISCOVERY_TIMEOUT_MS,
  isProviderAuthOptional,
  isProviderBearerAuthEnabled,
  lazyDiscoveryCandidates,
  resolveDiscoveryModelsUrl,
  resolveRequestModels,
} from '../lib/providers/discovery.js'
import { sources, canonicalizeModelId } from '../sources.js'
import { getApiKey } from '../lib/config.js'
import { rankModelsForRouting } from '../lib/utils.js'
import { parseTokenFigure, parseProviderRoster, parseFrontmatter } from '../tools/sync-omniroute-catalog.mjs'
import { parseRegistryEntry, parseRegistryIndex, decideResolution, termsRefusal } from '../tools/resolve-omniroute-endpoints.mjs'

/** Order-insensitive deep comparison, because these tables are lookups, not sequences. */
function sortsDeepEqual(actual, expected) {
  const canonical = value =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  assert.deepEqual(canonical(actual), canonical(expected))
}

const imported = () => listProviders().filter(d => d.origin === 'omniroute')
const activationOf = activation => imported().filter(d => d.activation === activation)

// ── Behavior parity with the tables the registry replaced ──────────────────────────────

test('apiKeyEnvVarTable reproduces the old hand-maintained ENV_VARS exactly', () => {
  sortsDeepEqual(apiKeyEnvVarTable(), {
    nvidia: 'NVIDIA_API_KEY',
    groq: 'GROQ_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    opencode: 'OPENCODE_API_KEY',
    empero: 'EMPERO_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
    ollama: 'OLLAMA_API_KEY',
    codestral: 'CODESTRAL_API_KEY',
    scaleway: 'SCALEWAY_API_KEY',
    googleai: 'GOOGLE_API_KEY',
    kilocode: 'KILOCODE_API_KEY',
    devin: 'DEVIN_API_KEY',
    'github-copilot': 'GITHUB_COPILOT_TOKEN',
    g4f: 'G4F_API_KEY',
  })
})

test('base URL and model id env tables reproduce the old ones', () => {
  sortsDeepEqual(baseUrlEnvVarTable(), {
    'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
    ollama: 'OLLAMA_BASE_URL',
    g4f: 'G4F_BASE_URL',
  })
  sortsDeepEqual(modelIdEnvVarTable(), {
    'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
    ollama: 'OLLAMA_MODEL',
  })
})

test('the OAuth account-pool set stays exactly kiro, devin and openai-codex', () => {
  assert.deepEqual([...oauthAccountProviders()].sort(), ['devin', 'kiro', 'openai-codex'])
  sortsDeepEqual(legacyAccountSecretFieldTable(), {
    kiro: 'refreshToken',
    devin: 'sessionToken',
    'openai-codex': 'refreshToken',
  })
})

test('seeded field strips stay exactly the Groq record', () => {
  sortsDeepEqual(seededFieldStripTable(), {
    groq: { fields: ['reasoning_content'], rejectsUnknownFields: true },
  })
})

// ── The deliberate asymmetries the derivation must preserve ────────────────────────────

test('openai-codex has no API-key env var, because its credential is an OAuth refresh token', () => {
  assert.equal('openai-codex' in apiKeyEnvVarTable(), false)
  assert.equal(getProvider('openai-codex').auth.refreshTokenEnvVar, 'OPENAI_CODEX_REFRESH_TOKEN')
})

test('github-copilot is a bearer but never joins the OAuth account pool', () => {
  assert.equal(getProvider('github-copilot').auth.kind, 'bearer')
  assert.equal(oauthAccountProviders().has('github-copilot'), false)
})

test('freemodels has no signup URL, matching the gap in the old table', () => {
  assert.equal('freemodels' in signupUrlTable(), false)
})

test('the optional-auth set stays the pre-refactor five, and ollama stays local-only', () => {
  // The refactor replaced a hardcoded `OPTIONAL_BEARER_AUTH_PROVIDERS` set with a lookup on
  // `auth.optional`. These are the five it held, and each must still declare it.
  const config = { apiKeys: {}, providers: {} }
  for (const key of ['kilocode', 'opencode', 'empero', 'freemodels', 'gptfree']) {
    assert.equal(getProvider(key).auth.optional, true, `${key} must declare optional`)
    assert.equal(isProviderAuthOptional(config, key), true, `${key} must stay optional`)
  }
  // Ollama is the asymmetry: only a *local* base URL is keyless, so it must not be
  // unconditionally optional. Hosted Ollama (the default https://ollama.com/v1) needs a key.
  assert.equal(getProvider('ollama').auth.optional, false)
  assert.equal(isProviderAuthOptional(config, 'ollama'), false)
  assert.equal(
    isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } }, 'ollama'),
    true,
  )
})

test('signup URLs cover the same 18 providers as before', () => {
  assert.equal(Object.keys(signupUrlTable()).length, 18)
})

// ── Registry integrity ─────────────────────────────────────────────────────────────────

test('every registered descriptor is valid and unique', () => {
  const keys = providerKeys()
  assert.equal(new Set(keys).size, keys.length, 'provider keys must be unique')
  for (const key of keys) {
    assert.deepEqual(validateDescriptor(getProvider(key)), [], `descriptor for "${key}" must be valid`)
  }
})

test('hammer ships 19 providers and none of them regressed', () => {
  assert.equal(Object.keys(PROVIDER_DESCRIPTORS).length, 19)
  for (const [key, descriptor] of Object.entries(PROVIDER_DESCRIPTORS)) {
    const registered = getProvider(key)
    assert.equal(registered.origin, 'hammer', `${key} must stay hammer-owned`)
    assert.equal(registered.activation, 'active', `${key} must stay routable`)
    if (descriptor.chatUrl) assert.equal(registered.chatUrl, descriptor.chatUrl)
  }
})

test('every provider carries a terms flag from the vocabulary', () => {
  const allowed = new Set(['ok', 'caution', 'ambiguous', 'avoid', 'unknown'])
  for (const descriptor of listProviders()) {
    assert.ok(allowed.has(descriptor.tos), `${descriptor.key} has tos "${descriptor.tos}"`)
  }
})

test('registration rejects malformed descriptors instead of accepting a dead provider', () => {
  resetRegistry()
  assert.throws(() => registerProvider('Bad Key', {}), /lowercase letters/)
  assert.throws(() => registerProvider('ok-key', { label: 'x', auth: { kind: 'telepathy' } }), /invalid auth\.kind/)
  // No endpoint and no models: it could never be routed to, so it is a catalog bug.
  assert.throws(() => registerProvider('nowhere', { label: 'Nowhere' }), /missing chatUrl/)
  // Unless it is explicitly staged as not-yet-routable.
  assert.doesNotThrow(() => registerProvider('staged', { label: 'Staged', activation: 'staged' }))
  // Refusing a provider is a decision, so it has to record why.
  assert.throws(
    () => registerProvider('refuser', { label: 'Refuser', activation: 'refused' }),
    /needs a blockedReason/,
  )
  assert.doesNotThrow(() =>
    registerProvider('refuser', { label: 'Refuser', activation: 'refused', blockedReason: 'terms forbid it' }))
  initProviders({ reset: true })
})

test('derivedModelsUrl only rewrites the OpenAI-shaped paths', () => {
  assert.equal(
    derivedModelsUrl('https://api.groq.com/openai/v1/chat/completions'),
    'https://api.groq.com/openai/v1/models',
  )
  assert.equal(derivedModelsUrl('https://freemodels-chat.freemodels.workers.dev'), null)
  assert.equal(derivedModelsUrl(null), null)
})

test('normalizeDescriptor derives a models URL and defaults to active', () => {
  const descriptor = normalizeDescriptor('demo', { label: 'Demo', chatUrl: 'https://x.test/v1/chat/completions' })
  assert.equal(descriptor.modelsUrl, 'https://x.test/v1/models')
  assert.equal(descriptor.activation, 'active')
})

// ── Classification evidence and behavior hooks ─────────────────────────────────────────

test('provider-scoped dead-model evidence is reachable through the registry', () => {
  assert.ok(providerClassifyPatterns('nvidia').dead.length > 0)
  assert.ok(matchesProviderDeadError('nvidia', "Function 'x' Not found for account abc"))
  assert.ok(matchesProviderDeadError('opencode', 'Model is unavailable.'))
  assert.ok(matchesProviderDeadError('g4f', "No server found that supports model 'x'"))
  assert.ok(matchesProviderDeadError('groq', '', 410))
  assert.equal(matchesProviderDeadError('nvidia', 'upstream timeout'), false)
})

test('behavior hooks are addressable per provider', () => {
  resetRegistry()
  registerProvider('hooky', { label: 'Hooky', chatUrl: 'https://h.test/v1/chat/completions' })
  assert.equal(getProviderHooks('hooky'), null)
  const buildBody = () => ({ ok: true })
  registerProviderHooks('hooky', { buildBody })
  registerProviderHooks('hooky', { transformResponse: () => 'x' })
  assert.equal(getProviderHooks('hooky').buildBody, buildBody)
  initProviders({ reset: true })
})

// ── The imported catalog: activation ───────────────────────────────────────────────────

test('the vendored catalog parses and carries provenance', () => {
  const { source, providers } = loadOmniRouteCatalog()
  assert.equal(source.project, 'OmniRoute')
  assert.equal(source.license, 'MIT')
  assert.ok(providers.length > 50, `expected a substantial roster, got ${providers.length}`)
})

test('imported providers never overwrite hammer-owned keys', () => {
  const importedKeys = imported().map(d => d.key)
  for (const key of ['nvidia', 'groq', 'cerebras', 'openrouter', 'scaleway', 'kiro', 'opencode']) {
    assert.equal(importedKeys.includes(key), false, `${key} must stay hammer-owned`)
    assert.equal(getProvider(key).origin, 'hammer')
  }
})

test('every imported provider is active, staged or refused — never undefined', () => {
  const rows = imported()
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.ok(['active', 'staged', 'refused'].includes(row.activation), `${row.key}: ${row.activation}`)
  }
})

test('the import actually resolves providers to real endpoints', () => {
  const active = activationOf('active')
  assert.ok(active.length >= 20, `expected a substantial routable import, got ${active.length}`)
  for (const provider of active) {
    assert.match(provider.chatUrl, /^https:\/\//, `${provider.key} needs a real https endpoint`)
    assert.ok(provider.discoverable, `${provider.key} must be discoverable so its models can be fetched`)
    assert.equal(provider.blockedReason, null, `${provider.key} is active, so it has no blocked reason`)
  }
})

test('every provider that is not active records exactly why', () => {
  for (const provider of imported().filter(d => d.activation !== 'active')) {
    assert.equal(provider.chatUrl, null, `${provider.key} must not carry an endpoint while not active`)
    assert.ok(provider.blockedReason, `${provider.key} must record a reason`)
    assert.equal(provider.discoverable, false)
  }
})

test('terms flags are advisory by default, but still travel on every descriptor', () => {
  // Matches OmniRoute, whose flag is documented as "not a routing gate". The provider is
  // usable, and the flag remains visible so the decision is never hidden.
  assert.equal(activationOf('refused').length, 0, 'nothing is withheld under the default policy')
  const flagged = imported().filter(d => d.tos === 'avoid')
  assert.ok(flagged.length > 0, 'the roster has avoid-flagged rows, so some must be imported')
  for (const provider of flagged) {
    assert.ok(['active', 'staged'].includes(provider.activation))
  }
})

test('the stricter terms posture is still reachable, and records its reason', () => {
  const refusal = termsRefusal({ tos: 'avoid', note: 'Terms prohibit proxy use.' }, true)
  assert.equal(refusal.activation, 'refused')
  assert.match(refusal.reason, /prohibit proxy use/)
  // Off by default, and a non-avoid provider is never refused either way.
  assert.equal(termsRefusal({ tos: 'avoid', note: 'x' }, false), null)
  assert.equal(termsRefusal({ tos: 'caution', note: 'x' }, true), null)
})

test('staged providers record the specific gap, not a generic failure', () => {
  const staged = activationOf('staged')
  assert.ok(staged.length > 0)
  for (const provider of staged) {
    assert.ok(provider.blockedReason.length > 10, `${provider.key} needs a substantive reason`)
  }
})

// ── End to end: a descriptor becomes a provider the router can call ────────────────────

test('the NO_KEY gate reads the registry, so a keyless import is actually callable', () => {
  // Regression test for the bug that made imports useless: providers were discovered,
  // listed in /v1/models, and then refused at dispatch with NO_KEY because the gate
  // consulted a hardcoded set of hammer's own five providers and never saw the import.
  const config = { apiKeys: {}, providers: {} }
  // `uncloseai` declares authType "optional" and was verified serving a real completion
  // with no credential at all (2026-09-22).
  assert.equal(getProvider('uncloseai').auth.optional, true)
  assert.equal(isProviderAuthOptional(config, 'uncloseai'), true)
  // A credential-requiring import must still be gated. `llm7` looks keyless (its /v1/models
  // is public) but a completion without a key returns missing_api_key, so it stays gated —
  // the reason a models-level probe is not accepted as evidence of keylessness.
  assert.equal(getProvider('llm7').auth.optional, false)
  assert.equal(isProviderAuthOptional(config, 'llm7'), false)
  assert.equal(isProviderAuthOptional(config, 'cohere'), false)
  // And hammer's own optional providers keep working, now via their descriptors.
  for (const key of ['gptfree', 'opencode', 'kilocode', 'empero', 'freemodels']) {
    assert.equal(isProviderAuthOptional(config, key), true, `${key} must stay optional`)
  }
  // FreeModels never sends a bearer even when a key exists (Cloudflare bot path).
  assert.equal(isProviderBearerAuthEnabled(config, 'freemodels'), false)
})

test('the credential header shape is data, so a non-bearer provider needs no new branch', () => {
  // A provider that wants its key sent bare, in a named header, is a descriptor field.
  const bare = buildProviderRequestHeaders('uncloseai', { apiKey: 'k', __unused: true })
  assert.equal(bare.Authorization, 'Bearer k')
  resetRegistry()
  registerProvider('barekey', {
    label: 'BareKey',
    chatUrl: 'https://bare.test/v1/chat/completions',
    discoverable: true,
    auth: { kind: 'bearer', headerName: 'x-api-key', scheme: null },
  })
  const headers = buildProviderRequestHeaders('barekey', { apiKey: 'secret' })
  assert.equal(headers['x-api-key'], 'secret')
  assert.equal(headers.Authorization, undefined)
  initProviders({ reset: true })
})

test('an active import\'s descriptor feeds the real header and body builders', () => {
  // `mistral` is imported (hammer does not ship it) and resolves to a plain OpenAI endpoint.
  // This exercises the builders only — it does not dispatch, and the name says so. Dispatch
  // after on-demand discovery is proven by the request-path tests below.
  const provider = getProvider('mistral')
  assert.equal(provider.origin, 'omniroute')
  assert.equal(provider.activation, 'active')
  assert.equal(provider.chatUrl, 'https://api.mistral.ai/v1/chat/completions')
  assert.equal(provider.modelsUrl, 'https://api.mistral.ai/v1/models')
  assert.equal(provider.auth.kind, 'bearer')

  // 1. It reaches the router's provider table, on the URL the descriptor resolved.
  assert.ok(sources[provider.key], 'the resolved provider must appear in sources')
  assert.equal(sources[provider.key].url, provider.chatUrl)
  assert.equal(sources[provider.key].discoverable, true)

  // 2. The real header builder produces a bearer for it, with no provider-specific code.
  const headers = buildProviderRequestHeaders(provider.key, { apiKey: 'test-key' })
  assert.equal(headers.Authorization, 'Bearer test-key')
  assert.equal(headers['Content-Type'], 'application/json')

  // 3. The real body builder passes the body through untouched — a generic provider.
  const body = { model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] }
  assert.deepEqual(buildProviderRequestBody(provider.key, body, body.model), body)
})

test('a withheld provider is structurally incapable of routing, whichever way it was withheld', () => {
  // No refusals exist under the default policy, so the invariant is proven the other way:
  // a registration that *is* refused must be inadmissible, and every non-active row
  // (currently the staged ones) must contribute no provider table entry at all.
  resetRegistry()
  registerProvider('withheld', {
    label: 'Withheld', activation: 'refused', blockedReason: 'terms forbid it',
    // Even given a perfectly good endpoint, a non-active row must not become reachable.
    chatUrl: 'https://withheld.test/v1/chat/completions', discoverable: true,
  })
  const withheld = getProvider('withheld')
  assert.equal(withheld.activation, 'refused')
  initProviders({ reset: true })
  assert.equal(getProvider('withheld'), null, 'the synthetic row is gone after reset')

  for (const provider of imported().filter(d => d.activation !== 'active')) {
    assert.equal(provider.chatUrl, null, `${provider.key} must carry no endpoint`)
    assert.equal(provider.discoverable, false, `${provider.key} must not be discoverable`)
    // The decisive assertion: no provider table entry, so no request can be built for it
    // even if something looked it up by name.
    assert.equal(sources[provider.key], undefined, `${provider.key} must not be a source`)
  }
})

test('a staged import is not in the provider table either', () => {
  const staged = activationOf('staged')[0]
  assert.ok(staged, 'expected at least one staged row')
  assert.equal(sources[staged.key], undefined)
  assert.equal(sources[staged.key]?.url, undefined)
})

test('routableImports() is the answer to "what did the import actually add"', () => {
  const routable = routableImports()
  assert.equal(routable.length, activationOf('active').length)
  for (const provider of routable) {
    assert.ok(provider.chatUrl.startsWith('https://'))
    assert.ok(provider.auth?.kind)
  }
  // Hammer's own providers are not part of "imported capability".
  assert.equal(routable.some(p => p.key === 'nvidia'), false)
})

// ── Lazy discovery: the import must not become a boot-time probe wave ──────────────────

test('imported providers are flagged lazy and absent from eager discovery', () => {
  const lazy = lazyEntriesDirect()
  const keys = Object.keys(lazy)
  assert.ok(keys.length > 0)
  for (const key of keys) {
    assert.equal(lazy[key].lazyDiscovery, true)
    assert.equal(lazy[key].discoverable, true, 'lazy providers are still discoverable — just not at boot')
    assert.equal(lazy[key].models.length, 0, 'no invented model rows: discovery supplies them')
  }
})

test('hammer\'s own hand-configured providers are not lazy', () => {
  for (const key of ['nvidia', 'groq', 'cerebras', 'openrouter', 'scaleway']) {
    assert.equal(sources[key].lazyDiscovery, undefined, `${key} must keep participating in startup discovery`)
  }
})

test('sources.js keeps hammer\'s entries when an imported key collides', () => {
  // `nvidia` is on both sides. The hand-configured row must win.
  assert.equal(sources.nvidia.name, 'NIM')
  assert.equal(sources.nvidia.lazyDiscovery, undefined)
  assert.ok(sources.nvidia.models.length > 0, 'hammer\'s verified model rows must survive the import')
})

test('the import layer performs no network I/O at import time', () => {
  // The guarantee is structural: resolution runs offline in tools/. If someone ever adds a
  // fetch to the module the whole app imports, this fails rather than becoming a silent
  // boot-time probe.
  for (const file of ['lib/providers/resolutions.js', 'lib/providers/omniroute.js', 'lib/providers/catalog.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} must not call fetch`)
  }
})

// ── On-demand discovery: the request path, not the boot path ───────────────────────────

test('discovery honors a provider-declared models URL, and a base override wins over it', () => {
  // Fireworks declares a list filtered to serverless models, and ollama-cloud declares its
  // native /api/tags. Re-deriving the sibling of the chat path returns rows that then 404,
  // which would mark a healthy provider dead.
  assert.equal(
    resolveDiscoveryModelsUrl(sources.fireworks),
    'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless=true',
  )
  assert.equal(resolveDiscoveryModelsUrl(sources['ollama-cloud']), 'https://ollama.com/api/tags')
  // Hammer's own providers declare none, so the sibling of the chat path is used.
  assert.equal(resolveDiscoveryModelsUrl(sources.nvidia), 'https://integrate.api.nvidia.com/v1/models')
  // A configured base URL redirects traffic, so it redirects discovery too.
  assert.equal(
    resolveDiscoveryModelsUrl(sources.fireworks, 'https://proxy.test/v1'),
    'https://proxy.test/v1/models',
  )
})

test('only unresolved, answerable imports are probed on demand', () => {
  const config = { apiKeys: { cohere: 'k' }, providers: {} }
  const helpers = { isAuthOptional: isProviderAuthOptional, hasApiKey: getApiKey }

  const candidates = lazyDiscoveryCandidates(sources, new Set(['nvidia']), config, helpers)
  // The two keyless imports are reachable on first use...
  assert.ok(candidates.includes('uncloseai'))
  assert.ok(candidates.includes('kilo-gateway'))
  // Note on evidence: `kilo-gateway` is keyless *by declaration* (its descriptor says so),
  // which is all this asserts — the candidate set, not that it has served traffic. It is
  // easy to over-claim here: `kilo-auto/free` lives on `api.kilo.ai/api/gateway`, the same
  // host as Hammer's own `kilocode`, so requesting it routes to `kilocode` and proves
  // nothing about the import. `uncloseai` is the one keyless import proven end to end.
  // ...and a keyed import the user configured is too.
  assert.ok(candidates.includes('cohere'))
  // A credential-requiring import with no key is left to the explicit refresh: probing it
  // would spend somebody else's quota to learn nothing.
  assert.equal(candidates.includes('fireworks'), false)
  // Hammer's own providers are never probed here; they get the boot wave.
  assert.equal(candidates.includes('nvidia'), false)
  // A provider that already has rows is not probed again.
  assert.equal(
    lazyDiscoveryCandidates(sources, new Set(['uncloseai']), config, helpers).includes('uncloseai'),
    false,
  )
})

// ── The request path itself: a cold miss discovers, then routes ────────────────────────
//
// These drive `resolveRequestModels` — the exact function the chat handler calls — so the
// guard fails if the on-demand trigger is removed, rather than passing because a table is
// shaped correctly. No server is booted and no network is touched: the discovery step is
// injected, and the routing consequence is checked with the real ranker.

const row = (modelId, providerKey) => ({ modelId, providerKey, status: 'pending', pings: [], rateLimit: null })

test('a cold request for an import-only model discovers it, then it is a routable candidate', async () => {
  // The table starts with Hammer's own model only; the import has no rows yet.
  let results = [row('hammer-model', 'nvidia')]
  let sweeps = 0
  const discover = async () => {
    sweeps += 1
    // What a real discovery merge does: the provider's rows appear in the table. Returned via
    // the getter, because discovery may replace the array rather than push into it.
    results = [...results, row('import-model', 'some-import')]
  }
  const options = {
    getResults: () => results,
    requestModel: 'import-model',
    canonicalize: canonicalizeModelId,
    isSmartestRequest: false,
    discover,
  }

  const first = await resolveRequestModels(options)
  assert.equal(sweeps, 1, 'the cold miss must trigger on-demand discovery exactly once')
  assert.equal(first.length, 1, 'the discovered model must become a candidate')
  assert.equal(first[0].providerKey, 'some-import')
  // The selection that immediately precedes the upstream fetch must land on the import.
  assert.equal(rankModelsForRouting(first)[0].providerKey, 'some-import')

  // Second request for the same model: the rows exist, so nothing is discovered again.
  const second = await resolveRequestModels(options)
  assert.equal(sweeps, 1, 'a now-resolved model must not trigger a second discovery sweep')
  assert.equal(second[0].providerKey, 'some-import')
})

test('a hit in the table never triggers discovery', async () => {
  let sweeps = 0
  const results = [row('hammer-model', 'nvidia')]
  const found = await resolveRequestModels({
    getResults: () => results,
    requestModel: 'hammer-model',
    canonicalize: canonicalizeModelId,
    isSmartestRequest: false,
    discover: async () => { sweeps += 1 },
  })
  assert.equal(sweeps, 0)
  assert.equal(found[0].providerKey, 'nvidia')
})

test('an auto/best request never triggers import discovery', async () => {
  let sweeps = 0
  const results = [row('hammer-model', 'nvidia')]
  const models = await resolveRequestModels({
    getResults: () => results,
    requestModel: 'best',
    canonicalize: canonicalizeModelId,
    isSmartestRequest: true,
    discover: async () => { sweeps += 1 },
  })
  assert.equal(sweeps, 0, 'best/auto already has a full catalog and must not sweep imports')
  assert.equal(models.length, 1)
})

test('a miss invents nothing: no discovered rows means the request still 404s', async () => {
  let consulted = 0
  const results = [row('hammer-model', 'nvidia')]
  const models = await resolveRequestModels({
    getResults: () => results,
    requestModel: 'mistral-large-latest',
    canonicalize: canonicalizeModelId,
    isSmartestRequest: false,
    // The production trigger probes only keyless/keyed imports (see the candidate test,
    // which proves a credential-less import like `fireworks` is never among them). With no
    // keyless import to answer, it returns nothing and the table is unchanged.
    discover: async () => { consulted += 1; return 0 },
  })
  assert.equal(consulted, 1, 'the trigger is consulted on a miss')
  assert.deepEqual(models, [], 'no rows are fabricated, so the caller still sees a 404')
})

test('the chat handler actually resolves through the request-path function it is guarded by', () => {
  // The behavioral tests above drive `resolveRequestModels`. This asserts the handler has not
  // been reverted to a bare `filterModelsByRequested` call that skips the trigger entirely —
  // the failure mode a function-only test cannot catch. Source-level, like the no-network
  // import check, because the handler is closed over by runServer and cannot be imported.
  const source = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(source, /const requestedModels = await resolveRequestModels\(/, 'the handler must use resolveRequestModels')
  assert.match(source, /discover: discoverLazyImportsForRequest/, 'it must pass the lazy-discovery trigger')
})

// ── Summary ────────────────────────────────────────────────────────────────────────────

test('the summary counts activations and accounts for every provider', () => {
  const summary = providerSummary()
  assert.equal(summary.total, summary.hammer + summary.imported)
  assert.equal(summary.routable, summary.activation.active)
  assert.equal(summary.activation.active + summary.activation.staged + summary.activation.refused, summary.total)
  assert.equal(summary.blocked.length, summary.activation.staged + summary.activation.refused)
  assert.equal(summary.routableImported, activationOf('active').length)
})

test('terms flags partition the registry with no provider uncounted', () => {
  const summary = providerSummary()
  const total = summary.tos.ok + summary.tos.caution + summary.tos.ambiguous + summary.tos.avoid + summary.tos.unknown
  assert.equal(total, summary.total)
})

test('importSummary counts the roster, while the registry counts only what was registered', () => {
  const summary = importSummary()
  const rosterKeys = loadOmniRouteCatalog().providers.map(p => p.key)
  const resolutions = loadResolutions().providers

  // The summary describes the *import file*, so it counts every roster row — including the
  // keys hammer already ships, which the loader skips rather than overwrites.
  assert.equal(summary.roster, rosterKeys.length)
  const rosterByActivation = activation =>
    rosterKeys.filter(key => resolutions[key]?.activation === activation).length
  assert.equal(summary.active, rosterByActivation('active'))
  assert.equal(summary.refused, rosterByActivation('refused'))
  assert.equal(summary.staged, rosterByActivation('staged'))

  // The registered imports are the roster minus the hammer-owned overlaps, exactly.
  const skippedAsHammerOwned = rosterKeys.filter(key => getProvider(key).origin === 'hammer')
  assert.equal(rosterKeys.length - imported().length, skippedAsHammerOwned.length)
  // Which is why the summary's active count exceeds the registered active imports by
  // precisely the hammer-owned rows that also happen to be resolvable upstream.
  assert.equal(summary.active - activationOf('active').length,
    skippedAsHammerOwned.filter(key => resolutions[key]?.activation === 'active').length)

  assert.ok(summary.resolvedAt, 'the resolution must record when it was generated')
})

test('humanizeProviderKey renders readable labels without inventing names', () => {
  assert.equal(humanizeProviderKey('cloudflare-ai'), 'Cloudflare AI')
  assert.equal(humanizeProviderKey('llm7'), 'LLM7')
  assert.equal(humanizeProviderKey(''), '')
})

test('keyless providers are identified across both origins', () => {
  const keyless = keylessProviders().map(d => d.key)
  assert.ok(keyless.includes('gptfree'))
  assert.ok(keyless.includes('opencode'))
})

// ── Tool parsers ───────────────────────────────────────────────────────────────────────

test('parseTokenFigure reads the catalog token notation', () => {
  assert.equal(parseTokenFigure('~1.00B'), 1_000_000_000)
  assert.equal(parseTokenFigure('~150M'), 150_000_000)
  assert.equal(parseTokenFigure('~800K'), 800_000)
  assert.equal(parseTokenFigure('—'), null)
  assert.equal(parseTokenFigure('uncapped\\*'), null)
})

test('parseProviderRoster maps free types onto the access vocabulary', () => {
  const fixture = [
    '| Provider | Free type | Steady tokens/mo | First-month credit | ToS | Models |',
    '| -------- | --------- | ---------------- | ------------------ | --- | ------ |',
    '| `mistral` | recurring | ~1.00B | — | caution | 5 |',
    '| `longcat` | one-time | — | 10M | caution | 1 |',
    '| `glm-cn` | uncapped | uncapped\\* | ~20M | ok | 4 |',
    '| `agy` | keyless | — | — | avoid | 16 |',
    '| `not a provider` | nonsense | — | — | ok | 1 |',
  ].join('\n')
  const byKey = Object.fromEntries(parseProviderRoster(fixture).map(entry => [entry.key, entry]))
  assert.equal(byKey.mistral.access, 'recurring')
  assert.equal(byKey.mistral.steadyTokensPerMonth, 1_000_000_000)
  assert.equal(byKey.longcat.access, 'signup-credit')
  assert.equal(byKey.longcat.steadyTokensPerMonth, undefined)
  assert.equal(byKey['glm-cn'].access, 'permanent')
  assert.equal(byKey.agy.tos, 'avoid')
  assert.equal('not a provider' in byKey, false)
})

test('parseFrontmatter reads the document version', () => {
  const frontmatter = parseFrontmatter('---\ntitle: "Free Tiers"\nversion: 3.8.40\nlastUpdated: 2026-07-31\n---\n# body')
  assert.equal(frontmatter.version, '3.8.40')
})

test('parseRegistryIndex finds every assembled provider slug', () => {
  const slugs = parseRegistryIndex('import { aProvider } from "./registry/mistral/index.ts";\nimport { bProvider } from "./registry/glm/cn/index.ts";')
  assert.deepEqual(slugs.sort(), ['glm/cn', 'mistral'])
})

test('parseRegistryEntry reads the fields the activation rule depends on', () => {
  const entry = parseRegistryEntry(`
export const mistralProvider: RegistryEntry = {
  id: "mistral",
  alias: "mistral",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.mistral.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    { id: "devstral-latest", name: "Devstral 2" },
  ],
};`)
  assert.equal(entry.id, 'mistral')
  assert.equal(entry.format, 'openai')
  assert.equal(entry.executor, 'default')
  assert.equal(entry.baseUrl, 'https://api.mistral.ai/v1/chat/completions')
  assert.equal(entry.authType, 'apikey')
  assert.equal(entry.authHeader, 'bearer')
  assert.deepEqual(entry.models.map(m => m.id), ['mistral-large-latest', 'devstral-latest'])
})

test('parseRegistryEntry sees the OpenAI-compatible helper as an explicit format', () => {
  const entry = parseRegistryEntry(`
export const siliconflowProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "siliconflow",
  baseUrl: "https://api.siliconflow.com/v1/chat/completions",
});`)
  assert.equal(entry.format, null)
  assert.equal(entry.usesOpenAiCompatibleHelper, true)
})

test('an OpenAI-compatible endpoint override bypasses a bespoke executor', () => {
  // `gemini` targets a native wire format upstream; Google publishes an OpenAI-compatible
  // layer, so the override substitutes it rather than requiring a translator.
  const decision = decideResolution({
    key: 'gemini',
    access: 'recurring',
    tos: 'caution',
    entry: {
      format: 'gemini', executor: 'default',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      authType: 'apikey', authHeader: 'bearer', models: [],
    },
  })
  assert.equal(decision.activation, 'active')
  assert.match(decision.resolution.chatUrl, /\/v1beta\/openai\/chat\/completions$/)
  assert.ok(decision.resolution.provenance.endpointOverride)
})

test('a bare-credential provider activates with the scheme recorded as null', () => {
  const decision = decideResolution({
    key: 'longcat', access: 'signup-credit', tos: 'caution',
    entry: {
      format: 'openai', executor: 'default',
      baseUrl: 'https://api.longcat.chat/openai/v1/chat/completions',
      authType: 'apikey', authHeader: 'Authorization', models: [],
    },
  })
  assert.equal(decision.activation, 'active')
  assert.equal(decision.resolution.auth.scheme, null)
  assert.equal(decision.resolution.auth.headerName, 'Authorization')
})

test('the activation rule holds back what has no declarative equivalent, and only that', () => {
  const base = { authType: 'apikey', authHeader: 'bearer', models: [], baseUrl: 'https://x.test/v1/chat/completions' }
  // A profiled executor resolves, because every difference it makes is data.
  const shaped = decideResolution({ key: 'pollinations', access: 'keyless', tos: 'ok', entry: { ...base, format: 'openai', executor: 'pollinations' } })
  assert.equal(shaped.activation, 'active')
  assert.deepEqual(shaped.resolution.shaping.premiumModels.includes('gemini'), true)
  // An executor with no profile and no declared OpenAI alternate is still held back.
  assert.equal(
    decideResolution({ key: 'p', access: 'keyless', tos: 'ok', entry: { ...base, format: 'openai', executor: 'some-bespoke-thing' } }).activation,
    'staged',
  )
  assert.equal(
    decideResolution({ key: 'p', access: 'keyless', tos: 'ok', entry: { ...base, format: 'gemini', executor: 'default' } }).activation,
    'staged',
  )
  // A declared-openai entry whose URL is not a chat endpoint is still not callable, even when
  // the executor claims to be the plain path — the URL is the observable consequence of the
  // wire format, so it is checked directly rather than inferred from the declaration.
  assert.equal(
    decideResolution({
      key: 'some-account-root', access: 'recurring', tos: 'caution',
      entry: { format: 'openai', executor: 'default', baseUrl: 'https://api.example.com/client/v4/accounts', authType: 'apikey', authHeader: 'bearer', models: [] },
    }).activation,
    'staged',
  )
  // And the happy path activates without needing anything hammer-specific.
  const active = decideResolution({ key: 'p', access: 'recurring', tos: 'caution', entry: { ...base, format: 'openai', executor: 'default' } })
  assert.equal(active.activation, 'active')
  assert.equal(active.resolution.chatUrl, 'https://x.test/v1/chat/completions')
  assert.equal(active.resolution.auth.kind, 'bearer')
})

test('a declined protocol records the decision verbatim rather than reading as pending work', () => {
  // Duck.ai is the one executor whose "protocol" is a client attestation to defeat (an
  // anti-abuse challenge that reads navigator.webdriver and the DOM and wants a forged
  // browser fingerprint back). That is a decision not to build it, so its reason is used as
  // written and must not be composed into "...so it needs a wire adapter" — which would
  // invite the next pass to port a browser-impersonation solver as ordinary adapter work.
  const declined = decideResolution({
    key: 'duckduckgo-web', access: 'keyless', tos: 'avoid',
    note: 'Duck.ai terms prohibit automated querying and building AI services on it.',
    entry: { format: 'openai', executor: 'duckduckgo-web', baseUrl: 'https://duckduckgo.com/duckchat/v1/chat', authType: 'none', authHeader: 'none', models: [] },
  })
  assert.equal(declined.activation, 'staged')
  assert.equal(declined.resolution, null)
  assert.match(declined.reason, /anti-automation attestation/)
  assert.doesNotMatch(declined.reason, /needs a wire adapter/)
  assert.match(declined.reason, /[Dd]eclined rather than pending/)

  // Every other bespoke executor keeps the framing that names the protocol it needs.
  const cookieOnly = decideResolution({
    key: 't3-web', access: 'keyless', tos: 'avoid',
    entry: { format: 'openai', executor: 't3-web', baseUrl: 'https://t3.chat/api/chat', authType: 'apikey', authHeader: 'cookie', models: [] },
  })
  assert.equal(cookieOnly.activation, 'staged')
  assert.match(cookieOnly.reason, /session cookie/)
  assert.match(cookieOnly.reason, /needs a wire adapter/)
})

test('a profiled executor becomes data, and its shaping travels on the resolution', () => {
  // Cloudflare: the account id goes in the URL and Workers AI refuses content-part arrays.
  const cloudflare = decideResolution({
    key: 'cloudflare-ai', access: 'recurring', tos: 'caution',
    entry: {
      format: 'openai', executor: 'cloudflare-ai',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
      authType: 'apikey', authHeader: 'bearer', models: [],
    },
  })
  assert.equal(cloudflare.activation, 'active')
  assert.equal(cloudflare.resolution.chatUrl,
    'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions')
  assert.equal(cloudflare.resolution.shaping.urlTemplate, true)
  assert.deepEqual(cloudflare.resolution.shaping.credentialFields, ['accountId'])
  assert.equal(cloudflare.resolution.shaping.flattenTextContent, true)

  // Two roster rows can share one executor, so the profile is keyed by executor rather than
  // by row: `opencode-zen` inherits what `opencode` needs.
  const zen = decideResolution({
    key: 'opencode-zen', access: 'recurring', tos: 'caution',
    entry: {
      format: 'openai', executor: 'opencode', baseUrl: 'https://opencode.ai/zen/v1',
      modelsUrl: 'https://opencode.ai/zen/v1/models',
      authType: 'apikey', authHeader: 'Authorization', authPrefix: 'Bearer', models: [],
    },
  })
  assert.equal(zen.activation, 'active')
  assert.equal(zen.resolution.chatUrl, 'https://opencode.ai/zen/v1/chat/completions')
  assert.equal(zen.resolution.auth.scheme, 'Bearer')

  // A frozen request default is data too, and the 50-minute budget comes with it.
  const glm = decideResolution({
    key: 'glm-cn', access: 'recurring', tos: 'caution',
    entry: {
      format: 'openai', executor: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      authType: 'apikey', authHeader: 'bearer', models: [],
    },
  })
  assert.deepEqual(glm.resolution.shaping.requestDefaults, { max_tokens: 16384 })
  assert.equal(glm.resolution.shaping.timeoutMs, 3000000)
})

test("a provider's declared OpenAI alternate resolves without a translator", () => {
  // agentrouter is written for Anthropic's /v1/messages but declares an OpenAI alternative,
  // and that declaration carries its own auth header — which is the provider telling us how
  // to reach it rather than us guessing at a second hostname.
  const decision = decideResolution({
    key: 'agentrouter', access: 'recurring', tos: 'caution',
    entry: {
      format: 'claude', executor: 'default', baseUrl: 'https://agentrouter.org/v1/messages',
      authType: 'apikey', authHeader: 'x-api-key', models: [],
      alternateFormats: [{ format: 'openai', baseUrl: 'https://agentrouter.org/v1/chat/completions', authHeader: 'bearer' }],
    },
  })
  assert.equal(decision.activation, 'active')
  assert.equal(decision.resolution.chatUrl, 'https://agentrouter.org/v1/chat/completions')
  assert.equal(decision.resolution.auth.headerName, 'Authorization')
  assert.ok(decision.resolution.provenance.alternateFormatUsed)
})

test('a provider with no credential concept activates keyless', () => {
  const decision = decideResolution({
    key: 'some-keyless-thing', access: 'keyless', tos: 'ok',
    entry: {
      format: 'openai', executor: 'default', baseUrl: 'https://x.test/v1/chat/completions',
      authType: 'none', authHeader: 'none', models: [],
    },
  })
  assert.equal(decision.activation, 'active')
  assert.equal(decision.resolution.auth.kind, 'none')
  assert.equal(decision.resolution.auth.optional, true)
  assert.equal(decision.resolution.auth.headerName, null)
})

test('an optional-auth provider activates keyless, matching hammer\'s optional-bearer semantics', () => {
  const decision = decideResolution({
    key: 'kilo-gateway', access: 'permanent', tos: 'caution',
    entry: { format: 'openai', executor: 'default', baseUrl: 'https://api.kilo.ai/api/gateway/chat/completions', authType: 'optional', authHeader: 'bearer', models: [] },
  })
  assert.equal(decision.activation, 'active')
  assert.equal(decision.resolution.auth.optional, true)
})

test('lazyProviderSourceEntries only exposes active providers', () => {
  const lazy = Object.keys(lazyEntriesDirect())
  const refusedKeys = activationOf('refused').map(d => d.key)
  for (const key of refusedKeys) {
    assert.equal(lazy.includes(key), false, `${key} is refused and must not be offered as a source`)
  }
})

// ── Request shaping, exercised through the real builders ────────────────────────────────
//
// The decision tests above prove what the resolver concluded. These prove the conclusion
// reaches a request: a provider's declared differences have to survive the same functions the
// proxy calls, or a descriptor that reads correctly is still inert.

test('a declared request default fills a blank without overruling the caller', () => {
  const bare = buildProviderRequestBody('glm-cn', { messages: [] }, 'glm-4.7')
  assert.equal(bare.max_tokens, 16384)
  const asked = buildProviderRequestBody('glm-cn', { messages: [], max_tokens: 256 }, 'glm-4.7')
  assert.equal(asked.max_tokens, 256)
  assert.equal(shapedTimeoutMs('glm-cn'), 3000000)
})

test('a provider that refuses content-part arrays gets a plain string', () => {
  const shaped = buildProviderRequestBody('cloudflare-ai', {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }],
  }, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.equal(shaped.messages[0].content, 'hi there')
})

test('a static header is sent, but never at the cost of the credential', () => {
  assert.equal(shapedHeaders('qoder')['User-Agent'], 'Qoder-Cli')
  const headers = buildProviderRequestHeaders('qoder', { apiKey: 'k' })
  assert.equal(headers['User-Agent'], 'Qoder-Cli')
  assert.equal(headers.Authorization, 'Bearer k')
  // A descriptor cannot clobber the auth header by declaring one.
  assert.equal(buildProviderRequestHeaders('mistral', { apiKey: 'k' }).Authorization, 'Bearer k')
})

test('a template endpoint resolves from the credential, and says what is missing', () => {
  const missing = resolveShapedChatUrl({}, 'cloudflare-ai', null)
  assert.equal(missing.url, null)
  assert.deepEqual(missing.missing, ['accountId'])

  const resolved = resolveShapedChatUrl({ providers: { 'cloudflare-ai': { accountId: 'acct-42' } } }, 'cloudflare-ai', null)
  assert.equal(resolved.url, 'https://api.cloudflare.com/client/v4/accounts/acct-42/ai/v1/chat/completions')

  // Vertex repeats `{region}` in the host and the path, so the missing set is the fields the
  // operator must supply, not one entry per occurrence. A duplicated `region` would read as
  // though two values were needed.
  assert.deepEqual(resolveShapedChatUrl({}, 'vertex', null).missing.sort(), ['project', 'region'])

  // A provider with no template is returned untouched, credential or not.
  assert.equal(resolveShapedChatUrl({}, 'mistral', 'https://api.mistral.ai/v1/chat/completions').url,
    'https://api.mistral.ai/v1/chat/completions')
})

test('an image cannot be flattened into a string, so it is reported instead of dropped', () => {
  const result = flattenTextContent([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ])
  assert.equal(result.messages[0].content, 'look')
  assert.deepEqual(result.droppedParts, ['image_url'])
})

test('a keyless tier that covers only part of the catalog is a statement about the model', () => {
  assert.equal(shapedModelNeedsKey('pollinations', 'claude'), true)
  assert.equal(shapedModelNeedsKey('pollinations', 'openai'), false)
  // jsonMode is only added when the caller actually asked for JSON, because Pollinations
  // rejects any request whose messages do not mention it.
  assert.equal(applyRequestShaping('pollinations', { messages: [] }).body.jsonMode, undefined)
  assert.equal(applyRequestShaping('pollinations', { messages: [], response_format: { type: 'json_object' } }).body.jsonMode, true)
})

test('observation beats a stale declaration of keylessness', () => {
  // Pollinations declared itself `optional` on 2026-07-20; a completion with no credential now
  // answers 401 UNAUTHORIZED. Trusting the declaration would dispatch every request without a
  // key and then blame the provider's health for the resulting 401.
  const pollinations = decideResolution({
    key: 'pollinations', access: 'recurring', tos: 'ok',
    entry: {
      format: 'openai', executor: 'pollinations',
      baseUrl: 'https://gen.pollinations.ai/v1/chat/completions',
      authType: 'optional', authHeader: 'bearer', models: [],
    },
  })
  assert.equal(pollinations.activation, 'active')
  assert.equal(pollinations.resolution.auth.kind, 'bearer')
  assert.equal(pollinations.resolution.auth.optional, undefined)
  assert.match(pollinations.resolution.provenance.requiresKeyEvidence, /2026-09-22/)
  // The shaping is unaffected: needing a key does not change how its body is built.
  assert.deepEqual(pollinations.resolution.shaping.premiumModels.includes('claude'), true)

  // The declaration that a live completion *did* confirm is left alone.
  const kilo = decideResolution({
    key: 'kilo-gateway', access: 'permanent', tos: 'caution',
    entry: {
      format: 'openai', executor: 'default',
      baseUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
      authType: 'optional', authHeader: 'bearer', models: [],
    },
  })
  assert.equal(kilo.resolution.auth.kind, 'none')
  assert.equal(kilo.resolution.auth.optional, true)
})

test('every provider without a shaping block is returned byte-for-byte unchanged', () => {
  const body = { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], max_tokens: 7 }
  assert.deepEqual(buildProviderRequestBody('mistral', body, 'x'), body)
  assert.equal(applyRequestShaping('mistral', body).body.max_tokens, 7)
})

// ── The provider facts the registry now owns outright ───────────────────────────────────
//
// The quota table was the last one still read from its old home (`sources.js`) while
// `registry.js` shipped a derivation of it that nothing called. These pin the live path so
// it cannot quietly revert.

test('the quota table is read through the registry, and sources.js no longer ships a copy', () => {
  const table = providerQuotaTable()

  // Every provider hammer publishes a quota for is reachable through the derived table. A
  // descriptor that carries no quota is simply absent, which is the shape the old
  // hand-maintained object had for a provider it did not describe.
  for (const key of [
    'nvidia', 'groq', 'cerebras', 'googleai', 'openrouter', 'codestral', 'scaleway',
    'kiro', 'kilocode', 'opencode', 'empero', 'freemodels', 'github-copilot',
    'openai-codex', 'g4f', 'gptfree', 'devin', 'ollama', 'openai-compatible',
  ]) {
    assert.ok(table[key], `${key} must keep its published quota`)
  }

  // Records travel whole: the window and scope the dashboard reads come off the descriptor,
  // not from a summary reconstructed at the call site.
  assert.equal(table.opencode.window, 'day')
  assert.equal(table.opencode.limitScope, 'account/model')
  assert.equal(table['github-copilot'].window, 'month')
  assert.match(table.nvidia.source, /Provider-reported limits only/)

  // And the old home is gone, so there is one source rather than two that can disagree.
  const sourcesFile = readFileSync(new URL('../sources.js', import.meta.url), 'utf8')
  assert.equal(
    /export const PROVIDER_QUOTAS/.test(sourcesFile),
    false,
    'sources.js must not export a quota table any more — the registry derives it',
  )
})

test('discovery shares the router probe window and never reaches back into the server', () => {
  // Two constants, one env var: if a default is edited in one place, the other would silently
  // keep the old value and a catalog fetch would time out on a different budget than a ping.
  assert.equal(DISCOVERY_TIMEOUT_MS, PING_TIMEOUT)

  const source = readFileSync(new URL('../lib/providers/discovery.js', import.meta.url), 'utf8')
  // Discovery sits *below* server.js: importing it would point the dependency the wrong way
  // and close a cycle.
  assert.equal(
    /from\s+['"][^'"]*server\.js['"]/.test(source),
    false,
    'discovery.js must not import lib/server.js',
  )
  // The fetches live inside functions; a top-level one would turn importing the providers
  // module into a network probe, which is the property the boot-safety guard protects.
  assert.equal(/^fetch\s*\(/m.test(source), false, 'discovery.js must not call fetch at import time')
})
