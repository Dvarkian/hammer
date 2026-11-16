// @ts-check
/**
 * @file model-usage.js
 * @description The quota evidence the Router page's Usage tags read, attached to raw rows.
 *
 * The subagent catalogue used to read the router's discovery rows directly. Those rows carry
 * the live rate-limit state but not the published allowance, the provider's own usage report,
 * or the recorded traffic the dashboard joins onto every model before it chooses a tag. The
 * result was a catalogue that answered "unknown" for models the Router page showed as Ample
 * or Limited. This module performs the same join for a caller that only has the router's raw
 * rows, so both surfaces band the same evidence.
 */

import { modelQuotaFor, providerQuotaTable } from '../providers/index.js'
import { buildRecordedUsage, buildRecordedUsageForEntry } from '../usage-windows.js'
import { extractQuotaWindows } from '../quota-windows.js'
import { getCachedGoogleQuotaWindows } from '../google-quota.js'
import { selectProviderUsageReport, serializeProviderUsage } from '../provider-usage.js'

/** @param {unknown} value @returns {number|null} */
function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * One row's quota fields, computed exactly as the Router table computes them.
 *
 * @param {any} row a discovery row
 * @param {{
 *   usageStats?: Map<string, any>|null,
 *   providerUsageReports?: Map<string, any[]>|null,
 *   providerUsageFetchedAt?: Map<string, number|null>|null,
 *   providerUsageErrors?: Map<string, string|null>|null,
 *   quotaTable?: Record<string, any>|null,
 *   providerRecordedUsage?: any,
 * }} [context]
 */
export function modelUsageEvidence(row, context = {}) {
  const providerKey = String(row?.providerKey || '')
  const modelId = String(row?.modelId || '')
  const key = `${providerKey}::${modelId}`
  const usageStats = context.usageStats instanceof Map ? context.usageStats : null
  const usageEntry = usageStats?.get(key)
  const rateLimit = row?.rateLimit || null
  const quota = row?.quota || null
  const quotaTable = context.quotaTable || providerQuotaTable()
  const providerReports =
    context.providerUsageReports instanceof Map
      ? context.providerUsageReports.get(providerKey) || []
      : []
  const usageFetchedAt =
    context.providerUsageFetchedAt instanceof Map
      ? context.providerUsageFetchedAt.get(providerKey) || null
      : null
  const usageError =
    context.providerUsageErrors instanceof Map
      ? context.providerUsageErrors.get(providerKey) || null
      : null
  const selectedReport =
    selectProviderUsageReport(providerReports, { providerKey, model: modelId }) ||
    selectProviderUsageReport(providerReports, { providerKey })
  const providerUsage = selectedReport
    ? serializeProviderUsage([
        {
          ...selectedReport,
          fetchedAt: selectedReport.fetchedAt || usageFetchedAt,
          freshness: usageError ? 'stale' : selectedReport.freshness || 'fresh',
          error: usageError,
        },
      ])[0]
    : null

  // Capacity exhaustion is a routing verdict as well as a quota reading: a zero credit
  // balance or a spent free allowance is the router's signal to stop choosing the row.
  let isRateLimited = rateLimit?.wasRateLimited === true
  if (!isRateLimited) {
    const creditSpent =
      (quota &&
        quota.creditLimit > 0 &&
        quota.creditRemaining != null &&
        quota.creditRemaining <= 0) ||
      (rateLimit &&
        rateLimit.creditLimit > 0 &&
        rateLimit.creditRemaining != null &&
        rateLimit.creditRemaining <= 0)
    const freeSpent =
      (quota && quota.freeUsedPercent != null && quota.freeUsedPercent >= 100) ||
      (rateLimit && rateLimit.freeUsedPercent != null && rateLimit.freeUsedPercent >= 100)
    if (creditSpent || freeSpent) isRateLimited = true
  }
  const expiredReset = finite(rateLimit?.resetRequestsAt)
  if (isRateLimited && expiredReset != null && expiredReset <= Date.now()) {
    isRateLimited = false
  }

  return {
    knownQuota: modelQuotaFor(providerKey, modelId) || quotaTable[providerKey] || null,
    quotaWindows: [
      ...extractQuotaWindows({
        modelId,
        rateLimit,
        quota,
        lastResponse: row?.lastResponse,
      }),
      ...getCachedGoogleQuotaWindows(providerKey, modelId),
    ],
    recordedUsage: buildRecordedUsageForEntry(usageEntry),
    providerRecordedUsage:
      context.providerRecordedUsage ||
      (usageStats ? buildRecordedUsage(usageStats, providerKey) : null),
    providerUsage,
    isRateLimited,
    rateLimit,
    quota,
  }
}

/**
 * Decorates a batch of discovery rows with the same quota fields `/api/models` serves.
 * Provider-wide recorded usage is computed once per provider, not once per row.
 *
 * @param {any[]} rows
 * @param {Parameters<typeof modelUsageEvidence>[1] & { providerRecordedUsage?: Map<string, any> }} [context]
 */
export function decorateModelRowsForUsage(rows, context = {}) {
  if (!Array.isArray(rows)) return []
  const quotaTable = context.quotaTable || providerQuotaTable()
  const recordedByProvider = new Map()
  const usageStats = context.usageStats instanceof Map ? context.usageStats : null
  return rows.map((row) => {
    const providerKey = String(row?.providerKey || '')
    let providerRecordedUsage = recordedByProvider.get(providerKey)
    if (!providerRecordedUsage && usageStats) {
      providerRecordedUsage = buildRecordedUsage(usageStats, providerKey)
      recordedByProvider.set(providerKey, providerRecordedUsage)
    }
    return {
      ...row,
      ...modelUsageEvidence(row, {
        ...context,
        quotaTable,
        providerRecordedUsage,
      }),
    }
  })
}

/**
 * Converts the internal band into the Router table's visible tag. The Router leaves a model
 * with no evidence blank rather than printing "unknown"; callers that render a tag should
 * do the same.
 *
 * @param {string|null|undefined} band
 * @returns {string|null}
 */
export function usageTagLabel(band) {
  const value = String(band || '').toLowerCase()
  if (!value || value === 'unknown') return null
  return `${value[0].toUpperCase()}${value.slice(1)} Quota`
}
