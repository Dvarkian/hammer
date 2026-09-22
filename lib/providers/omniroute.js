/**
 * ── Importing OmniRoute's free-tier providers ──────────────────────────────────────────
 *
 * Turns the vendored roster plus its resolution file into provider descriptors. Three
 * honesty constraints shape this, and each is load-bearing:
 *
 * 1. **Activation is a decision, not a default.** A row is `active` only when OmniRoute's
 *    registry describes it as an OpenAI-format chat endpoint whose credential hammer can
 *    send, and whose request differs from a plain one only in *fields* — a header, a request
 *    default, an auth prefix, a URL template. Everything else is `staged` with the specific
 *    protocol it needs (a JS challenge, a cookie jar, GraphQL, an OAuth device flow), so
 *    "not working yet" is always attributable to something specific rather than to
 *    "the import is incomplete".
 *
 * 2. **A refusal is recorded, never silent.** A row whose terms flag is `avoid` is
 *    registered with `activation: 'refused'` and its reason, and *no endpoint* — so there
 *    is no path by which it could begin routing by accident.
 *
 * 3. **Hammer's own providers win.** Several keys overlap (`nvidia`, `groq`, `cerebras`,
 *    `openrouter`, `scaleway`, `kiro`, `opencode`). Those are hand-configured here with
 *    verified model rows, so an import never overwrites one, and each skip is recorded
 *    with its reason rather than silently dropped.
 *
 * No network access happens here or anywhere else at import time: the model list for an
 * active import comes from lazy discovery at request time, not from this file.
 */

import { registerProvider, hasProvider } from './registry.js'
import {
  joinRosterWithResolutions,
  loadRoster,
  loadResolutions,
} from './resolutions.js'

/** Words that should not be title-cased into nonsense when a label is derived. */
const LABEL_ACRONYMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['llm', 'LLM'],
  ['llm7', 'LLM7'],
  ['ui', 'UI'],
  ['tos', 'ToS'],
  ['qwen', 'Qwen'],
  ['glm', 'GLM'],
  ['gpt', 'GPT'],
  ['cn', 'CN'],
  ['dev', 'Dev'],
])

/**
 * Derives a display label from a provider key.
 *
 * Imported catalogs key providers by slug (`cloudflare-ai`, `opencode-zen`), not by
 * display name. This is a best-effort rendering and is explicitly *derived*: curated
 * names belong in the catalog data, not in a title-casing rule.
 *
 * @param {string} key
 * @returns {string}
 */
export function humanizeProviderKey(key) {
  return String(key || '')
    .split('-')
    .filter(Boolean)
    .map(part => LABEL_ACRONYMS.get(part) || part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Reads the vendored roster. Kept as a named export because the sync tool and the tests
 * both reason about the roster directly rather than through the registry.
 *
 * @returns {{ source: object, providers: object[] }}
 */
export function loadOmniRouteCatalog() {
  return loadRoster()
}

/**
 * Registers every imported provider with its resolution applied.
 *
 * @param {{ skipExisting?: boolean }} [options]
 * @returns {{ active: string[], refused: string[], staged: string[], skipped: Array<{ key: string, reason: string }>, source: object }}
 */
export function registerOmniRouteProviders(options = {}) {
  const skipExisting = options.skipExisting !== false
  const resolutions = loadResolutions()
  const rows = joinRosterWithResolutions()

  const active = []
  const refused = []
  const staged = []
  const skipped = []

  for (const row of rows) {
    const { key, resolution } = row

    if (skipExisting && hasProvider(key)) {
      skipped.push({ key, reason: 'hammer already provides this provider' })
      continue
    }

    const activation = resolution.activation
    const blockedReason = resolution.reason || resolution.blockedReason || null

    try {
      registerProvider(key, {
        label: row.label || humanizeProviderKey(key),
        origin: 'omniroute',
        activation,
        blockedReason,
        verification: activation === 'active' ? 'unverified' : 'unresolved',
        access: row.access,
        tos: row.tos,
        // Endpoint configuration exists only for what was actually resolved. A refused or
        // staged row is registered with no chatUrl at all, which is what makes "cannot
        // route" a structural fact rather than a flag someone has to remember to check.
        chatUrl: activation === 'active' ? resolution.chatUrl : null,
        modelsUrl: activation === 'active' ? resolution.modelsUrl || null : null,
        discoverable: activation === 'active',
        // Models come from lazy discovery, never from this file: a declared list would be
        // stale the moment the provider rotated its roster, and would rank rows that were
        // never actually observed to work.
        modelsSource: 'inline',
        models: [],
        // The credential shape travels whole: header name, scheme and keylessness are all
        // properties of the provider, so the request path reads them rather than branching.
        auth: activation === 'active' ? (resolution.auth || { kind: 'bearer' }) : { kind: 'bearer' },
        // How this provider's request differs from a bare OpenAI one, as data. Read only by
        // `lib/providers/adapters.js`; a plain endpoint carries none and needs no code.
        shaping: activation === 'active' ? (resolution.shaping || null) : null,
        notes: row.note || blockedReason,
        quota: {
          source: `OmniRoute free-tier catalog v${resolutions.source.documentVersion || 'unknown'}`,
          sourceUrl: resolutions.source.repo || null,
          steadyTokensPerMonth: row.steadyTokensPerMonth,
          signupCreditTokens: row.signupCreditTokens,
        },
        source: {
          project: resolutions.source.project || 'OmniRoute',
          version: resolutions.source.documentVersion || null,
          lastUpdated: resolutions.source.documentLastUpdated || null,
          url: resolutions.source.repo || null,
          resolvedAt: resolutions.source.generatedAt || null,
        },
      }, { replace: true })

      if (activation === 'active') active.push(key)
      else if (activation === 'refused') refused.push(key)
      else staged.push(key)
    } catch (error) {
      skipped.push({ key, reason: `invalid descriptor: ${error.message}` })
    }
  }

  return { active, refused, staged, skipped, source: resolutions.source }
}
