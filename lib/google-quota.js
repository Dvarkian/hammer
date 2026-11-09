/**
 * @file lib/google-quota.js
 * @description A small, cached view of Google quota for the dashboard.
 *
 * Quota is not part of a Gemini chat response, so it has to be pulled separately from the
 * Code Assist RPC the clients use. The model route is allowed to read this cache without
 * awaiting the network: one background refresh feeds every row, a minute of staleness is
 * harmless, and an outage keeps the last known numbers rather than blanking the column.
 *
 * Both Google providers are covered. Google AI signs in with Gemini CLI's client and is
 * reported by `cloudcode-pa`; Antigravity signs in with its own client, bills a project the
 * Antigravity backend provisions, and reports through its daily endpoint. They share the bucket
 * shape but not the credential, the host or — for Antigravity — the model id, which names a
 * family (`gemini-3.8-flash`) while the roster appends the effort (`gemini-3.8-flash-medium`).
 */

import { getProviderAccounts, loadConfig } from './config.js'
import {
  ANTIGRAVITY_PROVIDER_KEY,
  antigravityQuotaModelAliases,
  fetchAntigravityQuotaPayload,
  resolveAntigravityAccessToken,
  resolveAntigravityProject,
} from './google-antigravity.js'
import {
  discoverGoogleProject,
  fetchGoogleQuotaPayload,
  googleProjectFromEnvironment,
  parseGoogleQuotaBuckets,
  resolveGoogleOAuthAccessToken,
} from './google-oauth.js'

const GOOGLEAI_PROVIDER_KEY = 'googleai'
const GOOGLE_QUOTA_REFRESH_MS = 60_000
const GOOGLE_QUOTA_TIMEOUT_MS = 12_000

/**
 * @typedef {object} GoogleQuotaState
 * @property {number} at
 * @property {Map<string, Map<string, object[]>>} byProvider provider key -> model id -> windows
 * @property {object[]} reports
 * @property {string|null} error
 * @property {number|null} fetchedAt
 * @property {Promise<GoogleQuotaState>|null} inFlight
 */

/** @returns {GoogleQuotaState} */
function emptyState() {
  return {
    at: 0,
    byProvider: new Map(),
    errors: new Map(),
    reports: [],
    error: null,
    fetchedAt: null,
    inFlight: null,
  }
}

/** @type {GoogleQuotaState} */
let state = emptyState()

function normalizeModelId(value) {
  return String(value || '')
    .trim()
    .replace(/^models\//i, '')
    .replace(/^google\//i, '')
    .toLowerCase()
}

function snapshot() {
  return {
    at: state.at,
    byProvider: state.byProvider,
    reports: state.reports,
    error: state.error,
    fetchedAt: state.fetchedAt,
  }
}

/**
 * The cached quota windows for one model row. Empty when no account has reported.
 *
 * Antigravity buckets are indexed under every roster id they cover (see
 * `antigravityQuotaModelAliases`), so a family bucket answers the effort-suffixed rows.
 */
export function getCachedGoogleQuotaWindows(providerKey, modelId) {
  const models = state.byProvider.get(String(providerKey || ''))
  if (!models) return []
  const windows = models.get(normalizeModelId(modelId))
  return windows ? windows.map((window) => ({ ...window })) : []
}

/**
 * Why the last refresh could not read one provider's quota, or null.
 *
 * Each account is read separately, so one failure leaves the others' bars in place. Naming it
 * per provider is what lets a card explain the account it is missing instead of showing fewer
 * accounts than the pool has.
 * @param {string} providerKey
 * @returns {string|null}
 */
export function getGoogleQuotaError(providerKey) {
  const list = state.errors?.get(String(providerKey || '')) || []
  return list.length > 0 ? list.join('; ') : null
}

/** A copy safe for route payloads and tests. */
export function getGoogleQuotaSnapshot() {
  return snapshot()
}

/**
 * Google's buckets as the provider card's quota reports, one per signed-in account.
 *
 * The card draws a bar per account, so a bucket family has to be reduced to the answer that
 * bar asks: how much is left in this account before it runs out. That is the lowest remaining
 * fraction among the account's windows — the one that will stop it first — and its model and
 * reset are kept so the bar can name which window it is. A window whose stated reset has
 * passed is dropped: the counter it describes no longer exists.
 *
 * The shape matches `serializeProviderUsage`, so a caller can hand it straight to a card.
 * @param {string} providerKey
 * @returns {object[]}
 */
export function getGoogleQuotaCardReports(providerKey) {
  const models = state.byProvider.get(String(providerKey || ''))
  if (!models) return []
  /** @type {Map<number, {left: number, window: any}>} */
  const tightest = new Map()
  for (const windows of models.values()) {
    for (const window of windows) {
      if (!Number.isFinite(Number(window?.usedPercent))) continue
      if (Number(window.resetAt) > 0 && Number(window.resetAt) <= Date.now()) continue
      const index = Number.isInteger(window.accountIndex) ? window.accountIndex : -1
      const left = 100 - Math.min(100, Math.max(0, Number(window.usedPercent)))
      const current = tightest.get(index)
      if (current && current.left <= left) continue
      tightest.set(index, { left, window })
    }
  }
  return [...tightest.entries()]
    .map(([index, { left, window }]) => ({
      providerKey: String(providerKey || ''),
      metric: 'percent',
      used: 100 - left,
      limit: 100,
      remaining: left,
      unit: 'percent',
      accountIndex: index >= 0 ? index : null,
      accountLabel: window.accountLabel || null,
      model: window.modelId || null,
      window: window.rawWindow || 'Code Assist quota',
      resetAt: window.resetAt || null,
      scope: 'model',
      source: window.source || 'google-oauth',
      fetchedAt: window.observedAt || null,
      freshness: 'fresh',
    }))
    .sort((a, b) => (a.accountIndex ?? 99) - (b.accountIndex ?? 99))
}

/** Seed the cache for tests, the way one refresh would have staged it. */
export function stageGoogleQuotaWindowsForTests(providerKey, windows) {
  const byProvider = new Map(state.byProvider)
  stageWindows(byProvider, providerKey, windows)
  state = { ...state, at: Date.now(), byProvider }
}

/**
 * Name the account a bucket belongs to. The card draws one bar per signed-in account, and the
 * bucket Google answers with says nothing about which pool entry asked for it, so the refresh
 * stamps that here — the one place that knows both.
 * @param {any} window
 * @param {number} accountIndex
 * @param {any} account
 */
function withAccount(window, accountIndex, account) {
  return {
    ...window,
    accountIndex,
    accountLabel: account.email || account.accountId || `Account ${accountIndex + 1}`,
  }
}

export function resetGoogleQuotaCacheForTests() {
  state = emptyState()
}

/** File one refresh's windows into the shared map, under every id the provider answers to. */
function stageWindows(byProvider, providerKey, windows) {
  if (windows.length === 0) return
  let models = byProvider.get(providerKey)
  if (!models) {
    models = new Map()
    byProvider.set(providerKey, models)
  }
  for (const window of windows) {
    const aliases =
      providerKey === ANTIGRAVITY_PROVIDER_KEY
        ? antigravityQuotaModelAliases(window.modelId)
        : [normalizeModelId(window.modelId)]
    for (const alias of aliases) {
      if (!alias) continue
      const list = models.get(alias) || []
      list.push(window)
      models.set(alias, list)
    }
  }
}

async function refreshUncached(config) {
  const byProvider = new Map()
  const reports = []
  const errors = []
  /** @type {Map<string, string[]>} */
  const providerErrors = new Map()
  const noteError = (providerKey, message) => {
    errors.push(message)
    const list = providerErrors.get(providerKey) || []
    list.push(message)
    providerErrors.set(providerKey, list)
  }
  const observedAt = Date.now()

  const googleAccounts = getProviderAccounts(config, GOOGLEAI_PROVIDER_KEY)
  for (const [accountIndex, account] of googleAccounts.entries()) {
    try {
      const resolved = await resolveGoogleOAuthAccessToken(account.secret, {
        projectHint: account.projectId,
      })
      let projectId =
        resolved.projectId || account.projectId || googleProjectFromEnvironment() || null
      let planType = resolved.planType || account.planType || null
      if (!projectId) {
        const discovered = await discoverGoogleProject(resolved.accessToken)
        projectId = discovered.projectId
        planType = planType || discovered.planType
      }
      if (!projectId) {
        errors.push(`${account.email || 'Google account'}: no Cloud project id`)
        continue
      }

      const payload = await fetchGoogleQuotaPayload(resolved.accessToken, projectId)
      const windows = parseGoogleQuotaBuckets(payload, {
        email: account.email,
        observedAt,
      }).map((window) => withAccount(window, accountIndex, account))
      stageWindows(byProvider, GOOGLEAI_PROVIDER_KEY, windows)
      reports.push({
        provider: GOOGLEAI_PROVIDER_KEY,
        email: account.email || null,
        accountId: account.accountId || null,
        projectId,
        planType,
        bucketCount: windows.length,
        observedAt,
      })
    } catch (error) {
      noteError(
        GOOGLEAI_PROVIDER_KEY,
        `${account.email || 'Google account'}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const antigravityAccounts = getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY)
  for (const [accountIndex, account] of antigravityAccounts.entries()) {
    try {
      const accessToken = await resolveAntigravityAccessToken(account.secret)
      // The project is the account's, not the provider's: one account's quota cannot be read
      // with another account's project, so each pool entry settles its own.
      const projectId =
        account.projectId || (await resolveAntigravityProject(accessToken)).projectId
      const payload = await fetchAntigravityQuotaPayload(accessToken, projectId)
      const windows = parseGoogleQuotaBuckets(payload, {
        email: account.email,
        observedAt,
      }).map((window) => withAccount(window, accountIndex, account))
      stageWindows(byProvider, ANTIGRAVITY_PROVIDER_KEY, windows)
      reports.push({
        provider: ANTIGRAVITY_PROVIDER_KEY,
        email: account.email || null,
        accountId: account.accountId || null,
        projectId,
        planType: account.planType || null,
        bucketCount: windows.length,
        observedAt,
      })
    } catch (error) {
      noteError(
        ANTIGRAVITY_PROVIDER_KEY,
        `${account.email || 'Antigravity account'}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (googleAccounts.length === 0 && antigravityAccounts.length === 0) {
    state = emptyState()
    state.at = Date.now()
    return snapshot()
  }

  state = {
    at: Date.now(),
    byProvider,
    errors: providerErrors,
    reports,
    error: errors.length > 0 ? errors.join('; ') : null,
    fetchedAt: observedAt,
    inFlight: null,
  }
  return snapshot()
}

/**
 * Refresh the quota cache. Concurrent callers share one refresh; a failed refresh keeps the
 * previous numbers and records why, so the dashboard has something to show while Google is
 * temporarily unreachable.
 */
export async function refreshGoogleQuota(config = loadConfig(), { force = false } = {}) {
  if (!force && state.at > 0 && Date.now() - state.at < GOOGLE_QUOTA_REFRESH_MS) {
    return snapshot()
  }
  if (state.inFlight) return state.inFlight
  const pending = refreshUncached(config)
  state.inFlight = pending
  try {
    return await pending
  } catch (error) {
    state = {
      ...state,
      at: state.at || Date.now(),
      inFlight: null,
      error: error instanceof Error ? error.message : String(error),
    }
    return snapshot()
  }
}

/**
 * Let a request-triggered refresh run for a bounded time. The model route does not wait for
 * Google; this exists so the first page after a restart can still show quota once the fetch
 * finishes, without ever holding the request open indefinitely.
 */
export async function ensureGoogleQuotaFresh(config = loadConfig(), { timeoutMs = 3000 } = {}) {
  const hasAccounts =
    getProviderAccounts(config, GOOGLEAI_PROVIDER_KEY).length > 0 ||
    getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY).length > 0
  if (!hasAccounts) return
  if (state.at > 0 && Date.now() - state.at < GOOGLE_QUOTA_REFRESH_MS) return
  await Promise.race([
    refreshGoogleQuota(config),
    new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, GOOGLE_QUOTA_TIMEOUT_MS))),
  ])
}
