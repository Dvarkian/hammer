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
 *
 * The trailing hour is kept as sixty one-minute buckets rather than one hourly bucket: a
 * provider that states "200 requests/hour" (KiloCode's keyless free pool) enforces a rolling
 * window, and a fixed hour bucket would report zero at 11:01 for traffic that was still being
 * throttled at 10:59.
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

/** The minute a request landed in, as an integer since the epoch. */
const utcMinuteIndex = (date) => Math.floor(date.getTime() / 60000)

/** How many minutes of traffic the trailing-hour window remembers. */
const ROLLING_HOUR_MINUTES = 60

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
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The storage key for a window, or null for a window that has no rollover (`lifetime`). */
export const periodKeyFor = (period, date) =>
  period === 'day'
    ? utcDayKey(date)
    : period === 'week'
      ? isoWeekKey(date)
      : period === 'month'
        ? utcMonthKey(date)
        : null

/** The stored windows of one usage entry, as a plain object. */
export const recordedBuckets = (entry) =>
  entry && typeof entry.recorded === 'object' && entry.recorded !== null ? entry.recorded : {}

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
 * The trailing-hour window: the requests and tokens of the last sixty minutes, summed from the
 * per-minute buckets kept on the entry. Minutes that have fallen out of the window are ignored
 * here and dropped on the next recorded request, so an idle model's ring stays bounded.
 *
 * @param {object|undefined} entry a usage entry
 * @param {Date} [date] the moment the window is resolved against
 * @returns {{ key: number, requests: number, tokens: number }}
 */
export function readRollingHourBucket(entry, date = new Date()) {
  const current = utcMinuteIndex(date)
  const stored = recordedBuckets(entry).hour
  const minutes = Array.isArray(stored) ? stored : []
  let requests = 0
  let tokens = 0
  for (const minute of minutes) {
    const key = Number(minute?.key)
    if (!Number.isFinite(key) || key > current || key <= current - ROLLING_HOUR_MINUTES) continue
    requests += Number(minute.requests) || 0
    tokens += Number(minute.tokens) || 0
  }
  return { key: current, requests, tokens }
}

/**
 * Adds one request to the trailing-hour ring: it extends the current minute's bucket, or starts
 * one, and drops the minutes that have fallen out of the window.
 *
 * @param {object[]|undefined} previous the stored ring
 * @param {Date} date
 * @param {number} tokens
 * @returns {{ key: number, requests: number, tokens: number }[]}
 */
function bumpRollingHour(previous, date, tokens) {
  const current = utcMinuteIndex(date)
  const minutes = (Array.isArray(previous) ? previous : [])
    .map((minute) => ({
      key: Number(minute?.key),
      requests: Number(minute?.requests) || 0,
      tokens: Number(minute?.tokens) || 0,
    }))
    .filter(
      (minute) =>
        Number.isFinite(minute.key) &&
        minute.key <= current &&
        minute.key > current - ROLLING_HOUR_MINUTES,
    )
  const last = minutes[minutes.length - 1]
  if (last && last.key === current) {
    last.requests += 1
    last.tokens += tokens
  } else {
    minutes.push({ key: current, requests: 1, tokens })
  }
  return minutes
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
  const bump = (bucket, key) =>
    bucket && typeof bucket === 'object' && bucket.key === key
      ? {
          key,
          requests: (Number(bucket.requests) || 0) + 1,
          tokens: (Number(bucket.tokens) || 0) + tokens,
        }
      : { key, requests: 1, tokens }
  buckets.day = bump(buckets.day, utcDayKey(date))
  buckets.week = bump(buckets.week, isoWeekKey(date))
  buckets.month = bump(buckets.month, utcMonthKey(date))
  buckets.hour = bumpRollingHour(buckets.hour, date, tokens)
  const lifetime = buckets.lifetime && typeof buckets.lifetime === 'object' ? buckets.lifetime : {}
  buckets.lifetime = {
    requests: (Number(lifetime.requests) || 0) + 1,
    tokens: (Number(lifetime.tokens) || 0) + tokens,
  }
  entry.recorded = buckets
  return buckets
}

/**
 * Everything recorded for one usage entry, per window.
 *
 * This is the numerator for a limit scoped to a single model: the provider counts that
 * model's traffic, not every model sharing the account. `buildRecordedUsage` below sums
 * these totals across a provider for account-scoped limits.
 *
 * @param {object|undefined} entry a usage entry
 * @param {Date} [date] the moment the windows are resolved against
 * @returns {{ tokensLastHour:number, requestsLastHour:number, tokensToday:number, tokensThisWeek:number, tokensThisMonth:number, tokensLifetime:number, requestsToday:number, requestsThisWeek:number, requestsThisMonth:number }}
 */
export function buildRecordedUsageForEntry(entry, date = new Date()) {
  const totals = {
    tokensLastHour: 0,
    requestsLastHour: 0,
    tokensToday: 0,
    tokensThisWeek: 0,
    tokensThisMonth: 0,
    tokensLifetime: 0,
    requestsToday: 0,
    requestsThisWeek: 0,
    requestsThisMonth: 0,
  }
  for (const [period, suffix] of [
    ['day', 'Today'],
    ['week', 'ThisWeek'],
    ['month', 'ThisMonth'],
  ]) {
    const bucket = readRecordedBucket(entry, period, date)
    if (!bucket) continue
    totals[`tokens${suffix}`] += Number(bucket.tokens) || 0
    totals[`requests${suffix}`] += Number(bucket.requests) || 0
  }
  const hour = readRollingHourBucket(entry, date)
  totals.tokensLastHour += hour.tokens
  totals.requestsLastHour += hour.requests
  const lifetime = recordedBuckets(entry).lifetime
  if (lifetime && typeof lifetime === 'object')
    totals.tokensLifetime += Number(lifetime.tokens) || 0
  return totals
}

/**
 * Everything recorded for a provider, per window, summed across its models.
 *
 * @param {Map<string, object>} usageStats the server's usage map, keyed `provider::model`
 * @param {string} providerKey
 * @param {Date} [date] the moment the windows are resolved against
 * @returns {{ tokensLastHour:number, requestsLastHour:number, tokensToday:number, tokensThisWeek:number, tokensThisMonth:number, tokensLifetime:number, requestsToday:number, requestsThisWeek:number, requestsThisMonth:number }}
 */
export function buildRecordedUsage(usageStats, providerKey, date = new Date()) {
  const totals = {
    tokensLastHour: 0,
    requestsLastHour: 0,
    tokensToday: 0,
    tokensThisWeek: 0,
    tokensThisMonth: 0,
    tokensLifetime: 0,
    requestsToday: 0,
    requestsThisWeek: 0,
    requestsThisMonth: 0,
  }
  const prefix = `${providerKey}::`
  for (const [key, entry] of usageStats) {
    if (!key.startsWith(prefix)) continue
    const recorded = buildRecordedUsageForEntry(entry, date)
    for (const field of Object.keys(totals)) totals[field] += recorded[field]
  }
  return totals
}
