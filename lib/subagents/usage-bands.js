// @ts-check
/**
 * @file usage-bands.js
 * @description One server-side reading of how much room a model group has left.
 *
 * The dashboard's quota column has always known how to read a provider's published
 * allowance, a provider's own refused window and the traffic Hammer has recorded. The
 * subagent catalogue needs the same answer, and a second copy of that logic would drift
 * from the first. This module is the shared, pure reading: it returns a band and a
 * short reason, never HTML and never a promise that a particular route will answer.
 *
 * The band is deliberately coarse. It is a capacity summary across a group's routes:
 *
 *   unlimited  the provider publishes that no allowance exists
 *   ample      the least-spent known window is above 70% left
 *   limited    between 35% and 70% left
 *   scarce     some allowance is left, but below 35%
 *   exhausted  every known window is spent, or a refusal said so
 *   unknown    neither a published limit nor a usable window is known
 */

export const USAGE_BANDS = ['unlimited', 'ample', 'limited', 'scarce', 'exhausted', 'unknown']

const REQUEST_FIELDS = {
  minute: 'requestsLastMinute',
  hour: 'requestsLastHour',
  day: 'requestsToday',
  week: 'requestsThisWeek',
  month: 'requestsThisMonth',
  lifetime: 'requestsLifetime',
}

const TOKEN_FIELDS = {
  minute: 'tokensLastMinute',
  hour: 'tokensLastHour',
  day: 'tokensToday',
  week: 'tokensThisWeek',
  month: 'tokensThisMonth',
  lifetime: 'tokensLifetime',
}

/** @param {unknown} value @returns {number|null} */
function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** @param {string|undefined|null} value */
function normalizePeriod(value) {
  const text = String(value || '').toLowerCase()
  if (/\bminute\b|\brpm\b/.test(text)) return 'minute'
  if (/\bhour\b|\brph\b/.test(text)) return 'hour'
  if (/\bday\b|daily/.test(text)) return 'day'
  if (/\bweek\b|weekly/.test(text)) return 'week'
  if (/\bmonth\b|monthly/.test(text)) return 'month'
  if (/lifetime|one[- ]?off|signup/.test(text)) return 'lifetime'
  return 'window'
}

/** @param {string|undefined|null} value */
function normalizeMetric(value) {
  return String(value || 'requests').toLowerCase() === 'tokens' ? 'tokens' : 'requests'
}

/** @param {string} metric @param {string} period */
function recordedField(metric, period) {
  const fields = metric === 'tokens' ? TOKEN_FIELDS : REQUEST_FIELDS
  return fields[period] || fields.day
}

/** @param {number} left @param {number} total */
function fractionLeft(left, total) {
  if (!(total > 0)) return null
  return Math.max(0, Math.min(1, left / total))
}

/**
 * The Router table's capacity thresholds. Calls are banded on what the window can sustain
 * over an hour, not on the snapshot left in this minute; tokens and credits are banded on
 * the share remaining. Both branches keep the same labels the Router shows.
 *
 * @param {{ metric?: string, period?: string, total?: number|null, remaining?: number|null, usedPercent?: number|null }} window
 */
function bandForCapacity({ metric, period = 'window', total, remaining, usedPercent }) {
  const totalValue = finite(total)
  const remainingValue = finite(remaining)
  const usedPercentValue = finite(usedPercent)
  if (
    (remainingValue != null && remainingValue <= 0) ||
    (usedPercentValue != null && usedPercentValue >= 100)
  ) {
    return 'exhausted'
  }
  if (normalizeMetric(metric) === 'requests' && remainingValue != null) {
    const perHour =
      period === 'minute'
        ? totalValue > 0
          ? totalValue * 60
          : remainingValue * 60
        : period === 'hour'
          ? totalValue > 0
            ? totalValue
            : remainingValue
          : null
    if (perHour != null) {
      return perHour < 12 ? 'scarce' : perHour < 60 ? 'limited' : 'ample'
    }
    return remainingValue < 5 ? 'scarce' : remainingValue < 50 ? 'limited' : 'ample'
  }
  const leftPercent =
    usedPercentValue != null
      ? 100 - Math.min(100, Math.max(0, usedPercentValue))
      : totalValue != null && totalValue > 0 && remainingValue != null
        ? (remainingValue / totalValue) * 100
        : null
  if (leftPercent == null) return null
  return leftPercent < 10 ? 'scarce' : leftPercent < 50 ? 'limited' : 'ample'
}

/** The next round tier above observed traffic, the Router table's estimated ceiling. */
function estimateLimitCeiling(seen) {
  const target = Math.max(1, Number(seen) * 1.25)
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)))
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude
    if (candidate >= target) return Math.round(candidate)
  }
  return Math.round(10 * magnitude)
}

/**
 * The reason a reader can act on: "500 req/day · 361 left", "no published limit".
 * @param {number} limit
 * @param {number} left
 * @param {string} metric
 * @param {string} period
 */
function reasonForLimit(limit, left, metric, period) {
  const unit = metric === 'tokens' ? 'tokens' : 'req'
  const window = period === 'window' ? '' : `/${period}`
  return `${Math.round(limit)} ${unit}${window} · ${Math.round(left)} left`
}

/**
 * Reads one row's quota evidence. Nothing here writes or guesses a provider limit; only
 * figures the provider published or a response actually stated are used.
 *
 * @param {{
 *   knownQuota?: any,
 *   quotaWindows?: any[],
 *   recordedUsage?: any,
 *   providerRecordedUsage?: any,
 *   rateLimit?: any,
 *   quota?: any,
 *   providerUsage?: any,
 *   freeUsedPercent?: number|null,
 *   isRateLimited?: boolean,
 * }} evidence
 * @returns {{ band: string, reason: string, fraction: number|null }}
 */
export function usageBandFromEvidence(evidence = {}) {
  const knownQuota = evidence.knownQuota || {}
  if (knownQuota.unlimited === true) {
    return { band: 'unlimited', reason: 'no published usage limit', fraction: 1 }
  }

  /** @type {{ fraction:number, band:string, reason:string }[]} */
  const windows = []
  /** Metrics with a published or provider-reported window; those never get an estimate. */
  const publishedMetrics = new Set()

  // The provider's own window is the strongest evidence: it is a live reading, not a
  // published ceiling paired with our guess at today's traffic.
  for (const raw of Array.isArray(evidence.quotaWindows) ? evidence.quotaWindows : []) {
    const window = raw && typeof raw === 'object' ? raw : {}
    const limit = finite(window.limit)
    const remaining = finite(window.remaining)
    const usedPercent = finite(window.usedPercent)
    if (window.unavailable === true || (limit != null && limit === 0)) {
      windows.push({
        fraction: 0,
        band: 'exhausted',
        reason: String(window.detail || window.rawWindow || 'no allowance on this route'),
      })
      continue
    }
    if (limit == null && remaining == null && usedPercent == null) continue
    const metric = normalizeMetric(window.metric)
    const period = normalizePeriod(window.period || window.rawWindow)
    publishedMetrics.add(metric)
    let left = remaining
    if (left == null && limit != null && usedPercent != null)
      left = limit * (1 - Math.min(100, Math.max(0, usedPercent)) / 100)
    const fraction =
      limit != null && limit > 0 && left != null
        ? fractionLeft(left, limit)
        : usedPercent != null
          ? fractionLeft(100 - usedPercent, 100)
          : null
    if (fraction == null) continue
    const band = bandForCapacity({ metric, period, total: limit, remaining: left, usedPercent })
    if (band == null) continue
    const reason =
      limit != null && left != null
        ? reasonForLimit(limit, left, metric, period)
        : `${Math.max(0, Math.round(100 - (usedPercent || 0)))}% left`
    windows.push({ fraction, band, reason })
  }

  // A provider that publishes a usage endpoint states its own window. The Router table uses
  // this report ahead of an estimate, and the catalogue must read it too: Codex and the free
  // allowances are reported only here, never as a catalog quota or a refusal window.
  const report =
    evidence.providerUsage && typeof evidence.providerUsage === 'object'
      ? evidence.providerUsage
      : null
  if (report) {
    const resetAt = finite(report.resetAt)
    if (resetAt == null || resetAt > Date.now()) {
      const percentMetric = String(report.metric || '').toLowerCase() === 'percent'
      const reportMetric = percentMetric ? 'tokens' : normalizeMetric(report.metric)
      const reportPeriod = normalizePeriod(report.window)
      const limit = finite(report.limit)
      const remaining = finite(report.remaining)
      const used = finite(report.used)
      const usedPercent =
        String(report.metric || '').toLowerCase() === 'percent' || limit === 100
          ? used
          : limit != null && limit > 0 && used != null
            ? Math.min(100, Math.max(0, (used / limit) * 100))
            : null
      const left =
        remaining != null
          ? remaining
          : limit != null && usedPercent != null
            ? limit * (1 - usedPercent / 100)
            : null
      const fraction =
        limit != null && limit > 0 && left != null
          ? fractionLeft(left, limit)
          : usedPercent != null
            ? fractionLeft(100 - usedPercent, 100)
            : null
      if (fraction != null) {
        publishedMetrics.add(reportMetric)
        windows.push({
          fraction,
          band:
            bandForCapacity({
              metric: reportMetric,
              period: reportPeriod,
              total: limit,
              remaining: left,
              usedPercent,
            }) || 'unknown',
          reason:
            percentMetric && usedPercent != null
              ? `${Math.max(0, Math.round(100 - usedPercent))}% left`
              : limit != null && left != null
                ? reasonForLimit(limit, left, reportMetric, reportPeriod)
                : `${Math.max(0, Math.round(100 - (usedPercent || 0)))}% left`,
        })
      }
    }
  }

  // A published allowance without a live window. The recorded traffic for the same
  // period is the best numerator there is; a group whose route has never been used is
  // ample rather than unknown because the limit itself is the useful fact.
  const limits = Array.isArray(knownQuota.limits) ? knownQuota.limits : []
  // A limit scoped to the account is spent by every model on that provider, so reading the
  // row's own traffic alone understates the spend — the Router table draws the provider-wide
  // figure for exactly this reason. A model-scoped grant keeps the row counter.
  const recorded =
    knownQuota.limitScope === 'model'
      ? evidence.recordedUsage || {}
      : evidence.providerRecordedUsage || evidence.recordedUsage || {}
  for (const raw of limits) {
    const limitSpec = raw && typeof raw === 'object' ? raw : {}
    const limit = finite(limitSpec.limit)
    if (limit == null || limit < 0) continue
    const metric = normalizeMetric(limitSpec.metric)
    const period = normalizePeriod(limitSpec.period || knownQuota.window)
    const used = finite(recorded[recordedField(metric, period)]) || 0
    const left = Math.max(0, limit - used)
    const fraction = fractionLeft(left, limit)
    if (fraction == null) continue
    publishedMetrics.add(metric)
    windows.push({
      fraction,
      band:
        bandForCapacity({
          metric,
          period,
          total: limit,
          remaining: left,
        }) || 'unknown',
      reason: reasonForLimit(limit, left, metric, period),
    })
  }

  // No published window for this unit: estimate a ceiling from the traffic Hammer has
  // carried, as the Router table does. A route with no traffic has nothing to estimate from
  // and stays unknown; a metric with a published window never gets a guessed one beside it.
  const observedUsage = evidence.recordedUsage || {}
  for (const metric of ['tokens', 'requests']) {
    if (publishedMetrics.has(metric)) continue
    for (const period of ['minute', 'hour', 'day']) {
      const seen = finite(observedUsage[recordedField(metric, period)])
      if (seen == null || seen <= 0) continue
      const ceiling = estimateLimitCeiling(seen)
      const left = Math.max(0, ceiling - seen)
      const band = bandForCapacity({ metric, period, total: ceiling, remaining: left })
      if (band == null) continue
      windows.push({
        fraction: fractionLeft(left, ceiling),
        band,
        reason: `${reasonForLimit(ceiling, left, metric, period)} · est`,
      })
    }
  }

  const freeUsed = finite(evidence.freeUsedPercent ?? evidence.rateLimit?.freeUsedPercent)
  if (freeUsed != null) {
    const remaining = 100 - Math.min(100, Math.max(0, freeUsed))
    const fraction = fractionLeft(remaining, 100)
    if (fraction != null)
      windows.push({
        fraction,
        band: bandForCapacity({
          metric: 'percent',
          total: 100,
          remaining,
          usedPercent: freeUsed,
        }),
        reason: `free allowance · ${Math.max(0, Math.round(100 - freeUsed))}% left`,
      })
  }

  const creditLimit = finite(evidence.quota?.creditLimit ?? evidence.rateLimit?.creditLimit)
  const creditLeft = finite(evidence.quota?.creditRemaining ?? evidence.rateLimit?.creditRemaining)
  if (creditLimit != null && creditLimit > 0 && creditLeft != null) {
    const fraction = fractionLeft(creditLeft, creditLimit)
    if (fraction != null)
      windows.push({
        fraction,
        band: bandForCapacity({ metric: 'credits', total: creditLimit, remaining: creditLeft }),
        reason: `${Math.round(creditLeft)}/${Math.round(creditLimit)} credit left`,
      })
  }

  if (windows.length === 0) {
    if (evidence.isRateLimited === true || evidence.rateLimit?.wasRateLimited === true) {
      return { band: 'exhausted', reason: 'the provider refused this route', fraction: 0 }
    }
    return { band: 'unknown', reason: 'no published limit', fraction: null }
  }

  windows.sort((a, b) => a.fraction - b.fraction)
  const tightest = windows[0]
  return { band: tightest.band, reason: tightest.reason, fraction: tightest.fraction }
}

const SEVERITY = new Map([
  ['unlimited', 0],
  ['ample', 1],
  ['unknown', 2],
  ['limited', 3],
  ['scarce', 4],
  ['exhausted', 5],
])

/**
 * Combines several routes' readings into one group reading.
 *
 * One route being spent is not the whole group being spent: another route may carry the
 * group. `exhausted` therefore survives only when every na known route is spent — or when
 * the only route that names an allowance is. The reason comes from the tightest route,
 * which is what the parent needs to know before fanning out.
 *
 * @param {{band:string, reason:string, fraction:number|null}[]} readings
 */
export function aggregateUsageBands(readings) {
  const rows = readings.filter((row) => row && USAGE_BANDS.includes(row.band))
  if (rows.length === 0) return { band: 'unknown', reason: 'no published limit' }
  // A route with no published limit is not evidence that the group has none. The Router
  // table reads a heading from the providers that publish a window and leaves a silent
  // sibling out of the decision; letting that sibling's `unknown` win turned a group with
  // one Ample route and one silent route into `unknown`, which is the bug the catalogue had.
  const published = rows.filter((row) => row.band !== 'unknown')
  if (published.length === 0) {
    return { band: 'unknown', reason: 'no published limit' }
  }
  const bands = new Set(published.map((row) => row.band))
  if (bands.size === 1) {
    const only = published[0]
    return { band: only.band, reason: only.reason }
  }
  const ranked = published
    .slice()
    .sort((a, b) => (SEVERITY.get(b.band) || 0) - (SEVERITY.get(a.band) || 0))
  const worst = ranked[0]
  if (worst.band === 'exhausted' && bands.size > 1) {
    return { band: 'scarce', reason: worst.reason }
  }
  return { band: worst.band, reason: worst.reason }
}
