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
 * 3. **Hammer's own providers win.** Several keys overlap (`nvidia`, `groq`,
 *    `openrouter`, `scaleway`, `kiro`). Those are hand-configured here with
 *    verified model rows, so an import never overwrites one, and each skip is recorded
 *    with its reason rather than silently dropped.
 *
 * No network access happens here or anywhere else at import time: the model list for an
 * active import comes from lazy discovery at request time, not from this file.
 *
 * One fact comes from neither vendored file. Upstream's roster has no column for *where a
 * credential is obtained* — not in the roster, not in its resolution file, and not in its
 * per-provider registry entries, which it was checked against. So that URL is curated in
 * `key-pages.json` and attached here, because this is the only place a descriptor for an
 * imported provider is built: the registry derives its URL table from descriptors, so a URL
 * attached once at import reaches the dashboard without any consumer knowing the difference
 * between a curated provider and an imported one.
 */

import { readFileSync, existsSync } from 'node:fs'

import { registerProvider, hasProvider } from './registry.js'
import {
  joinRosterWithResolutions,
  loadRoster,
  loadResolutions,
} from './resolutions.js'

const KEY_PAGES_URL = new URL('./key-pages.json', import.meta.url)

/**
 * The curated map of provider key -> `{ url, evidence, verifiedAt, httpStatus, note? }`.
 *
 * Missing or malformed is a fallback to `{}` rather than a throw, for the same reason the
 * vendored JSON reads fall back: losing a link must never stop hammer from booting.
 *
 * @returns {Record<string, { url: string, evidence?: string, verifiedAt?: string|null, httpStatus?: number|null, note?: string }>}
 */
export function loadKeyPages() {
  if (!existsSync(KEY_PAGES_URL)) return {}
  try {
    const raw = JSON.parse(readFileSync(KEY_PAGES_URL, 'utf8'))
    return raw && typeof raw.pages === 'object' && raw.pages ? raw.pages : {}
  } catch {
    return {}
  }
}

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
 * Imported catalogs key providers by slug (`cloudflare-ai`, `muse-spark-web`), not by
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
  const keyPages = loadKeyPages()

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
        // Curated, not imported: see `key-pages.json`. `null` when nobody has confirmed a
        // page for this provider yet, which renders its card title as plain text. That is
        // the honest outcome — a guessed URL is worse than no link at all.
        signupUrl: keyPages[key]?.url || null,
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
