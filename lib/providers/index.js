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

import { PROVIDER_DESCRIPTORS, PROVIDER_QUOTAS } from './catalog.js'
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
import { registerOmniRouteProviders } from './omniroute.js'
import { importSummary, lazyProviderSourceEntries, activeResolutions } from './resolutions.js'

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
    registerProvider(key, descriptor, { replace: true })
  }

  const imported = includeImported
    ? registerOmniRouteProviders()
    : { registered: [], skipped: [], source: {} }

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
