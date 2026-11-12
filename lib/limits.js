/**
 * @file lib/limits.js
 * @description The two vocabularies Hammer keeps apart: a **rate limit** and a **quota**.
 *
 * A rate limit is a *throttle*: the provider is refusing this request right now because a
 * short window (a second, a minute, an hour) is full, and the same endpoint will serve again
 * when that window rolls over. A quota is *capacity*: an allowance the account has, spends
 * down, and eventually runs out of — credits, a daily or monthly token budget, a free-tier
 * grant. The two blur into one another constantly in the wild ("rate limit reached for 8000
 * tokens per minute" is a throttle; "you exceeded your current quota ... resets at midnight"
 * is capacity), and for a long time Hammer stored both under a single `model.rateLimit` bag.
 *
 * This module owns the split. It is deliberately dependency-free: `lib/utils.js`,
 * `lib/quota-windows.js` and the server all read the same field lists and the same
 * classification from here rather than each spelling the boundary out again.
 *
 * The persisted shape is two sibling fields on a model row:
 *
 *   model.rateLimit — the throttle half:
 *     wasRateLimited, capturedAt, retryAfterMs, resetRequestsAt, resetTokensAt,
 *     limitRequests, remainingRequests, limitTokens, remainingTokens
 *
 *   model.quota — the capacity half:
 *     creditLimit, creditRemaining, creditResetAt,
 *     freeUsedPercent, freeResetAt, freeCapturedAt,
 *     failure (a parsed QuotaFailure: { code, quotaId, quotaMetric, quotaValue })
 *
 * The reset times stay in the throttle half on purpose: a reset is *when the current wait
 * ends*, which is what the rate-limit bench and the routing gate both need, and the
 * quota-window parser keeps reading them from there (see `lib/quota-windows.js`). The
 * QuotaFailure itself moves to `model.quota.failure`, because that is an observation about
 * capacity rather than about a throttle.
 */

/** Fields that describe a burst/throttle window (or the bench that stands on one). */
export const RATE_LIMIT_FIELDS = [
  'wasRateLimited',
  'capturedAt',
  'retryAfterMs',
  'resetRequestsAt',
  'resetTokensAt',
  'limitRequests',
  'remainingRequests',
  'limitTokens',
  'remainingTokens',
]

/**
 * Fields that describe capacity: account credits, a free-tier allowance, and the provider's
 * own QuotaFailure object (`failure`). They survive a successful response and a closed bench,
 * because neither of those changes how much allowance the account has.
 */
export const QUOTA_FIELDS = [
  'creditLimit',
  'creditRemaining',
  'creditResetAt',
  'freeUsedPercent',
  'freeResetAt',
  'freeCapturedAt',
  'failure',
]

/** Credit facts that describe the API *key* rather than one model (OpenRouter's /key). */
export const KEY_LEVEL_QUOTA_FIELDS = ['creditLimit', 'creditRemaining', 'creditResetAt']

/** How long a bench stands when the provider named no window at all. */
export const RATE_LIMIT_UNSTATED_GRACE_MS = 60_000

const QUOTA_FIELD_SET = new Set(QUOTA_FIELDS)

/** A bag with no own fields is no bag at all. */
function emptyToNull(bag) {
  return bag && Object.keys(bag).length > 0 ? bag : null
}

/**
 * Merges two field bags, `incoming` winning. Null-safe; returns null when both are empty.
 */
export function mergeRateLimitBags(base, incoming) {
  if (!base && !incoming) return null
  if (!base) return incoming
  if (!incoming) return base
  return { ...base, ...incoming }
}

/**
 * Splits a raw captured bag into its two halves. This is the migration-on-read boundary: a
 * payload written before the split (one combined `rateLimit`) comes back split here, so every
 * caller downstream only ever sees the two shapes.
 *
 * The legacy nested `quota` key (the parsed QuotaFailure) is carried across as `failure`.
 * Unknown fields stay on the throttle half, its historical home, rather than being dropped or
 * silently filed as capacity.
 *
 * @param {object|null|undefined} captured
 * @returns {{ rateLimit: object|null, quota: object|null }}
 */
export function splitRateLimitCapture(captured) {
  if (!captured || typeof captured !== 'object') return { rateLimit: null, quota: null }
  const rateLimit = {}
  const quota = {}
  const absorb = (key, value) => {
    if (value === undefined) return
    if (QUOTA_FIELD_SET.has(key)) quota[key] = value
    else rateLimit[key] = value
  }
  for (const [key, value] of Object.entries(captured)) {
    if (value === undefined) continue
    if (key === 'rateLimit') {
      // Already a pair's throttle half.
      if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) absorb(k, v)
      continue
    }
    if (key === 'quota') {
      // Either a pair's capacity half, or a legacy raw QuotaFailure.
      if (!value || typeof value !== 'object') continue
      if (looksLikeQuotaFailure(value)) quota.failure = value
      else for (const [k, v] of Object.entries(value)) absorb(k, v)
      continue
    }
    absorb(key, value)
  }
  return { rateLimit: emptyToNull(rateLimit), quota: emptyToNull(quota) }
}

/** Whether an already-split quota half looks like a raw QuotaFailure rather than a quota bag. */
function looksLikeQuotaFailure(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    ('quotaId' in value || 'quotaMetric' in value || 'quotaValue' in value || 'code' in value)
  )
}

/**
 * Normalizes anything a caller might hold — a pair, a legacy combined bag, or null — into a
 * pair. A value that already is a pair is passed through; a raw capture is split.
 */
export function asLimitState(value) {
  if (!value || typeof value !== 'object') return { rateLimit: null, quota: null }
  // A model row carries its throttle half under `rateLimit` and (optionally) its capacity
  // half under `quota`. A bare capture or a `{rateLimit, quota}` pair is normalized the same
  // way: split whatever is under `rateLimit`, and treat a non-failure `quota` object as the
  // capacity half. A legacy QuotaFailure nested at `rateLimit.quota` is split out by
  // splitRateLimitCapture.
  const throttleSource =
    value.rateLimit && typeof value.rateLimit === 'object' ? value.rateLimit : value
  const throttle = splitRateLimitCapture(throttleSource)
  const ownQuota =
    value.quota && typeof value.quota === 'object' && !looksLikeQuotaFailure(value.quota)
      ? value.quota
      : null
  return {
    rateLimit: throttle.rateLimit,
    quota: mergeRateLimitBags(throttle.quota, ownQuota),
  }
}

/**
 * The parsed QuotaFailure from a model row, whether it is stored as `model.quota.failure`
 * (current) or `model.rateLimit.quota` (legacy). Returns null when the row names none.
 *
 * @param {{ rateLimit?: object|null, quota?: object|null }|null} row
 */
export function quotaFailureOf(row) {
  if (!row || typeof row !== 'object') return null
  const { quota } = asLimitState(row)
  const failure = quota?.failure
  return failure && typeof failure === 'object' ? failure : null
}

/** Merges two pairs (each may be a pair, a legacy bag, or null). Null-safe. */
export function mergeLimitState(base, incoming) {
  const a = asLimitState(base)
  const b = asLimitState(incoming)
  return {
    rateLimit: mergeRateLimitBags(a.rateLimit, b.rateLimit),
    quota: mergeRateLimitBags(a.quota, b.quota),
  }
}

/**
 * Reconciles a fresh provider response against the stored state. A successful response proves
 * an old 429 cooldown is no longer active for this model, while numeric counters and capacity
 * facts stay useful after success.
 *
 * @param {{rateLimit?: object|null, quota?: object|null}|object|null} existing stored pair (or legacy bag)
 * @param {object|null} captured raw capture from this response (split here)
 * @param {number|string|null} status
 * @param {number} [now]
 * @returns {{ rateLimit: object|null, quota: object|null }}
 */
export function reconcileLimitState(existing, captured, status, now = Date.now()) {
  const incoming = splitRateLimitCapture(captured)
  const merged = mergeLimitState(existing, incoming)
  let rateLimit = merged.rateLimit ? { ...merged.rateLimit } : null
  const quota = merged.quota ? { ...merged.quota } : null
  const numericStatus = Number(status)
  if (numericStatus === 200) {
    if (rateLimit) {
      delete rateLimit.wasRateLimited
      if (incoming.rateLimit?.resetRequestsAt == null) delete rateLimit.resetRequestsAt
      if (incoming.rateLimit?.resetTokensAt == null) delete rateLimit.resetTokensAt
      if (incoming.rateLimit?.retryAfterMs == null) delete rateLimit.retryAfterMs
    }
    // A successful response retires the *failure* statement, not the account's capacity:
    // credit and free-tier fields stay. (Only the QuotaFailure object is cleared.)
    if (quota && incoming.quota?.failure == null) delete quota.failure
  }
  if (numericStatus === 429) {
    rateLimit = rateLimit || {}
    rateLimit.wasRateLimited = true
    rateLimit.capturedAt = now
  }
  return { rateLimit: emptyToNull(rateLimit), quota: emptyToNull(quota) }
}

/**
 * True when a `wasRateLimited` flag is no longer evidence about anything.
 *
 * The flag describes a *window*, and the window is what expires: the latest reset time the
 * provider stated (`resetRequestsAt` / `resetTokensAt`), or — when it stated none — the short
 * grace after the capture. An entry with neither a reset nor a capture time has no window at
 * all and is treated as expired rather than as an eternal bench.
 */
export function isRateLimitBenchExpired(
  rateLimit,
  now = Date.now(),
  fallbackGraceMs = RATE_LIMIT_UNSTATED_GRACE_MS,
) {
  if (!rateLimit || rateLimit.wasRateLimited !== true) return false
  const latestReset = Math.max(
    Number(rateLimit.resetRequestsAt) || 0,
    Number(rateLimit.resetTokensAt) || 0,
  )
  if (latestReset > 0) return latestReset < now
  return (Number(rateLimit.capturedAt) || 0) + fallbackGraceMs < now
}

/**
 * A persisted state as it should be *restored*: identical to the stored pair while the bench
 * it describes is still live, and stripped of that bench when it is not.
 *
 * An expired (or superseded) bench loses exactly the fields that described *that* window — the
 * flag, its reset times, the retry delay, its capture time and the QuotaFailure behind it.
 * Capacity facts (`creditLimit` / `creditRemaining` / `creditResetAt`, and the free-tier
 * percentage) describe the account, not the window, and stay.
 *
 * `superseded` is for the caller that holds a *newer* observation than the stored one — the
 * restart path passes it for a row a probe answered since the process started.
 *
 * @param {{rateLimit?: object|null, quota?: object|null}|object|null} existing
 * @param {number} [now]
 * @param {{ fallbackGraceMs?: number, superseded?: boolean }} [options]
 */
export function restoreLimitState(
  existing,
  now = Date.now(),
  { fallbackGraceMs = RATE_LIMIT_UNSTATED_GRACE_MS, superseded = false } = {},
) {
  if (!existing || typeof existing !== 'object') return { rateLimit: null, quota: null }
  const { rateLimit: storedRateLimit, quota: storedQuota } = mergeLimitState(existing, null)
  const rateLimit = storedRateLimit ? { ...storedRateLimit } : null
  const quota = storedQuota ? { ...storedQuota } : null
  const benchIsGone = superseded || isRateLimitBenchExpired(storedRateLimit, now, fallbackGraceMs)
  if (rateLimit && benchIsGone) {
    delete rateLimit.wasRateLimited
    delete rateLimit.resetRequestsAt
    delete rateLimit.resetTokensAt
    delete rateLimit.retryAfterMs
    // `capturedAt` is the bench's own timestamp and is written with the flag, so it goes with it.
    delete rateLimit.capturedAt
  }
  // The QuotaFailure is the bench's *reason*; when the bench is gone its reason is gone too.
  // Capacity fields (credits, free-tier percentage) survive because they are not about this
  // window.
  if (quota && benchIsGone) delete quota.failure
  return { rateLimit: emptyToNull(rateLimit), quota: emptyToNull(quota) }
}

/**
 * The credit facts that describe the API *key* rather than one model. They are the only quota
 * fields safe to merge provider-wide, because every model on the key draws from the same pot.
 */
export function pickKeyLevelQuota(quota) {
  if (!quota || typeof quota !== 'object') return null
  const picked = {}
  for (const field of KEY_LEVEL_QUOTA_FIELDS) {
    if (quota[field] != null) picked[field] = quota[field]
  }
  return Object.keys(picked).length > 0 ? picked : null
}

/**
 * A quota window's kind, from the period it names. Minute and hour windows throttle; a day,
 * week, month or lifetime window is capacity. `window` is the parser's catch-all and is read
 * as capacity, since a refusal that names no period is a statement about an allowance rather
 * than about a burst.
 *
 * @param {string|null|undefined} period
 * @returns {'rate-limit'|'quota'}
 */
export function windowKindForPeriod(period) {
  const text = String(period || '').toLowerCase()
  return text === 'minute' || text === 'hour' ? 'rate-limit' : 'quota'
}

/** True when a parsed quota window actually describes a short burst throttle. */
export function isRateLimitWindow(window) {
  if (!window || typeof window !== 'object') return false
  if (window.kind === 'rate-limit') return true
  if (window.kind === 'quota') return false
  return windowKindForPeriod(window.period) === 'rate-limit'
}

/** True when a parsed window describes capacity. */
export function isQuotaWindow(window) {
  return !isRateLimitWindow(window)
}

// ── Named predicates for the call sites that must tell the two states apart ──────────────────

/**
 * The row is benched on a live throttle: the provider is refusing now and a clock reopens it.
 * This is what routing eligibility gates on.
 *
 * @param {{rateLimit?: object|null}|null} row
 * @param {number} [now]
 * @param {number} [fallbackGraceMs]
 */
export function isRowWaitingOnThrottle(row, now = Date.now(), fallbackGraceMs) {
  const rateLimit = row?.rateLimit
  if (!rateLimit || rateLimit.wasRateLimited !== true) return false
  if (fallbackGraceMs == null) return true
  return !isRateLimitBenchExpired(rateLimit, now, fallbackGraceMs)
}

/**
 * The account's capacity is spent: a positive credit limit with nothing left. A statement
 * about the allowance rather than about a burst window.
 *
 * @param {{quota?: object|null}|null} row
 */
export function isRowOutOfCapacity(row) {
  const quota = row?.quota
  if (!quota) return false
  return (
    Number(quota.creditLimit) > 0 &&
    quota.creditRemaining != null &&
    Number(quota.creditRemaining) <= 0
  )
}
