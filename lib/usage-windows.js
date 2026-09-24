/**
 * @file lib/usage-windows.js
 * @description How much traffic hammer itself has carried, bucketed by the windows a
 * published free-tier limit can apply to.
 *
 * A published limit is only meaningful beside what has been spent against it, and the spend
 * has to be counted in the window the limit is stated in: 15,000,000 tokens per month drawn
 * against one day's traffic is a percentage of nothing, and a monthly grant drawn against a
 * lifetime total can never reset. These counters supply the numerator — UTC day, ISO week,
 * calendar month, and a lifetime total — and are deliberately free of server state so the
 * rollover boundaries (a Sunday, a month end, the turn of a year) can be tested directly.
 *
 * The unit is the request: one served call adds one to each window, and its tokens
 * (what was sent plus what came back) to the same three. Only traffic hammer carried is
 * counted, which is why the dashboard labels these numbers "recorded by hammer" and never
 * presents them as the provider's own accounting.
 */

/**
 * Tokens a single served request moved.
 *
 * `contextTokens` is the whole request's size — the prompt plus the answer — which is what a
 * token allowance is actually spent on. The response tokens must therefore not be added on
 * top of it: the proxy call sites build the sample as `prompt_tokens + completion_tokens`, so
 * summing both fields would bill every answer twice and make recorded usage outrun the real
 * spend. The response is used only when the total is missing.
 */
export function tokensForSample(sample) {
  const total = Number(sample?.contextTokens)
  if (Number.isFinite(total) && total > 0) return total
  const output = Number(sample?.completionTokens)
  return Number.isFinite(output) && output > 0 ? output : 0
}

/** `YYYY-MM-DD` in UTC. */
export const utcDayKey = (date) => date.toISOString().slice(0, 10)

/** `YYYY-MM` in UTC. */
export const utcMonthKey = (date) => date.toISOString().slice(0, 7)

/**
 * ISO-8601 week key (`YYYY-Www`): the week containing the year's first Thursday is week 1.
 *
 * The calendar week would let a "per week" limit reset on a different weekday depending on
 * the year, and every provider that states a weekly window resets on Monday.
 *
 * @param {Date} date
 * @returns {string}
 */
export function isoWeekKey(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The storage key for a window, or null for a window that has no rollover (`lifetime`). */
export const periodKeyFor = (period, date) => (period === 'day'
  ? utcDayKey(date)
  : period === 'week'
    ? isoWeekKey(date)
    : period === 'month'
      ? utcMonthKey(date)
      : null)

/** The stored windows of one usage entry, as a plain object. */
export const recordedBuckets = (entry) => (entry && typeof entry.recorded === 'object' && entry.recorded !== null ? entry.recorded : {})

/**
 * The bucket for the *current* window, or null when the stored one has rolled over.
 *
 * A bucket from last month is not this month's usage: reporting it would show a spent limit
 * that had already reset. It is left in the entry (the lifetime total still counts it) rather
 * than cleared, because the next recorded request overwrites it anyway.
 *
 * @param {object} entry a usage entry
 * @param {'day'|'week'|'month'|'lifetime'} period
 * @param {Date} [date]
 * @returns {{ key?: string, requests: number, tokens: number }|null}
 */
export function readRecordedBucket(entry, period, date = new Date()) {
  const bucket = recordedBuckets(entry)[period]
  if (!bucket || typeof bucket !== 'object') return null
  const expected = periodKeyFor(period, date)
  if (expected != null && bucket.key !== expected) return null
  return bucket
}

/**
 * Adds one request and its tokens to every window of an entry.
 *
 * @param {object} entry the usage entry to mutate
 * @param {{ contextTokens?: number, completionTokens?: number }} sample
 * @param {Date} [date]
 * @returns {object} the entry's new `recorded` object
 */
export function recordUsageBuckets(entry, sample, date = new Date()) {
  const tokens = tokensForSample(sample)
  const buckets = { ...recordedBuckets(entry) }
  const bump = (bucket, key) => (bucket && typeof bucket === 'object' && bucket.key === key
    ? { key, requests: (Number(bucket.requests) || 0) + 1, tokens: (Number(bucket.tokens) || 0) + tokens }
    : { key, requests: 1, tokens })
  buckets.day = bump(buckets.day, utcDayKey(date))
  buckets.week = bump(buckets.week, isoWeekKey(date))
  buckets.month = bump(buckets.month, utcMonthKey(date))
  const lifetime = buckets.lifetime && typeof buckets.lifetime === 'object' ? buckets.lifetime : {}
  buckets.lifetime = { requests: (Number(lifetime.requests) || 0) + 1, tokens: (Number(lifetime.tokens) || 0) + tokens }
  entry.recorded = buckets
  return buckets
}

/**
 * Everything recorded for a provider, per window, summed across its models.
 *
 * @param {Map<string, object>} usageStats the server's usage map, keyed `provider::model`
 * @param {string} providerKey
 * @param {Date} [date] the moment the windows are resolved against
 * @returns {{ tokensToday:number, tokensThisWeek:number, tokensThisMonth:number, tokensLifetime:number, requestsToday:number, requestsThisWeek:number, requestsThisMonth:number }}
 */
export function buildRecordedUsage(usageStats, providerKey, date = new Date()) {
  const totals = {
    tokensToday: 0, tokensThisWeek: 0, tokensThisMonth: 0, tokensLifetime: 0,
    requestsToday: 0, requestsThisWeek: 0, requestsThisMonth: 0,
  }
  const prefix = `${providerKey}::`
  for (const [key, entry] of usageStats) {
    if (!key.startsWith(prefix)) continue
    for (const [period, suffix] of [['day', 'Today'], ['week', 'ThisWeek'], ['month', 'ThisMonth']]) {
      const bucket = readRecordedBucket(entry, period, date)
      if (!bucket) continue
      totals[`tokens${suffix}`] += Number(bucket.tokens) || 0
      totals[`requests${suffix}`] += Number(bucket.requests) || 0
    }
    const lifetime = recordedBuckets(entry).lifetime
    if (lifetime && typeof lifetime === 'object') totals.tokensLifetime += Number(lifetime.tokens) || 0
  }
  return totals
}
