/**
 * ── The providers module ───────────────────────────────────────────────────────────────
 *
 * Importing this module populates the registry: hammer's own catalog first, then
 * OmniRoute's imported roster. That ordering is load-bearing — hammer's hand-configured
 * rows win any key collision — and eager registration is deliberate, because the
 * consumers of the derived tables (`sources.js`, `config.js`, `providerLinks.js`,
 * `request-sanitize.js`) read them at module load.
 *
 * Registration validates, so a malformed descriptor fails here, at import, rather than
 * somewhere downstream as a provider that mysteriously never routes.
 */

import { PROVIDER_DESCRIPTORS, PROVIDER_QUOTAS, PROVIDER_USAGE_URLS } from './catalog.js'
import {
  findProviders,
  getProvider,
  getProviderHooks,
  hasProvider,
  keylessProviders,
  legacyAccountSecretFieldTable,
  listProviders,
  matchesProviderDeadError,
  modelIdEnvVarTable,
  oauthAccountProviders,
  providerClassifyPatterns,
  providerKeys,
  providerQuotaTable,
  providersByOrigin,
  providersByTosFlag,
  providersNeedingKeys,
  registerProvider,
  registerProviderHooks,
  resetRegistry,
  seededFieldStripTable,
  signupUrlTable,
  apiKeyEnvVarTable,
  baseUrlEnvVarTable,
} from './registry.js'
import { loadOmniRouteCatalog, registerOmniRouteProviders } from './omniroute.js'
import { importSummary, lazyProviderSourceEntries, activeResolutions } from './resolutions.js'

/**
 * Roster allowances whose provider hammer configures itself.
 *
 * The roster is keyed by the service it lists, which is not always the key hammer uses for
 * the same service: hosted Ollama is `ollama-cloud` there and `ollama` here. That mapping is
 * spelled out rather than guessed, and hosted Ollama carries `appliesToHosts` because the
 * same key also serves a local server whose limits are hardware-bound — a monthly grant read
 * against local traffic would be a made-up number, which is worse than no number.
 */
const ROSTER_ALLOWANCE_TARGETS = {
  'ollama-cloud': [{ key: 'ollama', appliesToHosts: ['ollama.com'] }],
}

let rosterAllowances = null

/**
 * Reads the vendored roster once and indexes its numeric allowances by hammer provider key.
 *
 * @returns {{ attribution: string, byKey: Map<string, object> }}
 */
function getRosterAllowances() {
  if (rosterAllowances) return rosterAllowances
  const roster = loadOmniRouteCatalog()
  const version = roster?.source?.documentVersion
  rosterAllowances = {
    attribution: `OmniRoute free-tier roster${version ? ` v${version}` : ''}`,
    byKey: new Map(),
  }
  for (const row of Array.isArray(roster?.providers) ? roster.providers : []) {
    const steadyTokensPerMonth = Number.isFinite(row?.steadyTokensPerMonth) ? row.steadyTokensPerMonth : null
    const signupCreditTokens = Number.isFinite(row?.signupCreditTokens) ? row.signupCreditTokens : null
    if (steadyTokensPerMonth == null && signupCreditTokens == null) continue
    const allowance = { steadyTokensPerMonth, signupCreditTokens }
    rosterAllowances.byKey.set(row.key, allowance)
    for (const target of ROSTER_ALLOWANCE_TARGETS[row.key] || []) {
      if (rosterAllowances.byKey.has(target.key)) continue
      rosterAllowances.byKey.set(target.key, { ...allowance, appliesToHosts: target.appliesToHosts })
    }
  }
  return rosterAllowances
}

/**
 * Fills in the numbers the roster publishes for a provider hammer also configures itself.
 *
 * Registration order is why this is needed at all: hammer's rows are registered first (they
 * are the authoritative endpoint configuration), so the import skips every key hammer already
 * provides — including the roster's free-tier figures. The provider's own citation is kept and
 * the figure is attributed separately, so the card can show a limit and still link the page
 * that describes the plan.
 *
 * @param {string} key
 * @param {object} descriptor raw descriptor, before normalization
 * @returns {object} the descriptor, with the roster's allowance merged in when it had none
 */
function withPublishedAllowance(key, descriptor) {
  const allowance = getRosterAllowances().byKey.get(key)
  if (!allowance) return descriptor
  const quota = descriptor?.quota || {}
  // A descriptor that already states a number keeps it: it was authored against the provider,
  // and the roster is a second-hand source.
  if (Number.isFinite(quota.steadyTokensPerMonth) || Number.isFinite(quota.signupCreditTokens)) return descriptor
  return {
    ...descriptor,
    quota: {
      ...quota,
      steadyTokensPerMonth: allowance.steadyTokensPerMonth ?? null,
      signupCreditTokens: allowance.signupCreditTokens ?? null,
      numericSource: getRosterAllowances().attribution,
      ...(allowance.appliesToHosts ? { appliesToHosts: allowance.appliesToHosts } : {}),
    },
  }
}

/**
 * Gives imported providers hammer's own live-usage surface when nobody else declares one.
 *
 * Applied after registration and only where the descriptor has no `usageUrl` of its own, so a
 * resolution that later carries the provider's real endpoint wins without an edit here. The
 * registry hands out its stored descriptors by reference and every consumer reads them lazily,
 * which is what makes setting the field in place safe at import time.
 */
function applyUsageUrlOverlays() {
  for (const [key, usageUrl] of Object.entries(PROVIDER_USAGE_URLS)) {
    const descriptor = getProvider(key)
    if (descriptor && !descriptor.usageUrl) descriptor.usageUrl = usageUrl
  }
}

/**
 * Registers every provider. Called once at import; call again with `reset: true` from a
 * test that wants a clean registry.
 *
 * @param {{ reset?: boolean, includeImported?: boolean }} [options]
 * @returns {{ hammer: number, imported: number, skippedImported: Array<{ key: string, reason: string }>, total: number }}
 */
export function initProviders(options = {}) {
  const includeImported = options.includeImported !== false
  if (options.reset === true) resetRegistry()

  for (const [key, descriptor] of Object.entries(PROVIDER_DESCRIPTORS)) {
    registerProvider(key, withPublishedAllowance(key, descriptor), { replace: true })
  }

  const imported = includeImported
    ? registerOmniRouteProviders()
    : { registered: [], skipped: [], source: {} }

  applyUsageUrlOverlays()

  return {
    hammer: Object.keys(PROVIDER_DESCRIPTORS).length,
    imported: imported.active.length + imported.staged.length + imported.refused.length,
    importedActive: imported.active.length,
    importedStaged: imported.staged.length,
    importedRefused: imported.refused.length,
    skippedImported: imported.skipped,
    total: providerKeys().length,
  }
}

/**
 * A count-and-coverage summary, shaped for the dashboard and for the verification tool.
 *
 * @returns {object}
 */
export function providerSummary() {
  const all = listProviders()
  const imported = all.filter(d => d.origin === 'omniroute')
  const hammer = all.filter(d => d.origin === 'hammer')
  const countActivation = (list, activation) => list.filter(d => d.activation === activation).length
  return {
    total: all.length,
    hammer: hammer.length,
    imported: imported.length,
    /** Everything that may carry traffic, whatever its origin. */
    routable: countActivation(all, 'active'),
    /** How much of the routable set came from the import rather than being hammer's own. */
    routableImported: countActivation(imported, 'active'),
    activation: {
      active: countActivation(all, 'active'),
      staged: countActivation(all, 'staged'),
      refused: countActivation(all, 'refused'),
    },
    keyless: keylessProviders().length,
    needsKey: providersNeedingKeys().length,
    verified: all.filter(d => d.verification === 'verified').length,
    /**
     * Every provider that cannot carry traffic, with the reason it cannot. Reported as a
     * list rather than a count so "why is this one not working" has an answer that does
     * not require reading the catalog.
     */
    blocked: all
      .filter(d => d.activation !== 'active')
      .map(d => ({ key: d.key, activation: d.activation, reason: d.blockedReason })),
    /** Terms flags, so an import can never be enabled blind. */
    tos: {
      ok: providersByTosFlag('ok').length,
      caution: providersByTosFlag('caution').length,
      ambiguous: providersByTosFlag('ambiguous').length,
      avoid: providersByTosFlag('avoid').length,
      unknown: providersByTosFlag('unknown').length,
    },
  }
}

/**
 * The imported providers that are routable, each with the endpoint it will be called on.
 * This is the list the user actually asked for: "route every free provider OmniRoute
 * offers" resolves to exactly these.
 *
 * @returns {Array<{ key: string, chatUrl: string, auth: object, tos: string }>}
 */
export function routableImports() {
  return listProviders()
    .filter(d => d.origin === 'omniroute' && d.activation === 'active')
    .map(d => ({
      key: d.key,
      chatUrl: d.chatUrl,
      modelsUrl: d.modelsUrl,
      auth: d.auth,
      tos: d.tos,
    }))
}

const bootSummary = initProviders()

export {
  // Registry core
  findProviders,
  getProvider,
  getProviderHooks,
  hasProvider,
  keylessProviders,
  listProviders,
  providerKeys,
  providersByOrigin,
  providersByTosFlag,
  providersNeedingKeys,
  registerProvider,
  registerProviderHooks,
  resetRegistry,
  // Import resolution (what is routable, and what is not)
  activeResolutions,
  importSummary,
  lazyProviderSourceEntries,
  // Derived tables (the old hand-maintained ones)
  apiKeyEnvVarTable,
  baseUrlEnvVarTable,
  legacyAccountSecretFieldTable,
  modelIdEnvVarTable,
  oauthAccountProviders,
  providerQuotaTable,
  seededFieldStripTable,
  signupUrlTable,
  // Classification
  matchesProviderDeadError,
  providerClassifyPatterns,
  // Data
  PROVIDER_DESCRIPTORS,
  PROVIDER_QUOTAS,
  bootSummary,
}
