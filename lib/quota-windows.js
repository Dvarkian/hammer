/**
 * @file lib/quota-windows.js
 * @description Quota windows observed in a provider's own refusal.
 *
 * Google publishes project/model limits in AI Studio rather than a static table, so the most
 * reliable numeric quota for a Google model is the one in its `QuotaFailure` response. Those
 * bodies list several metrics at once — requests/minute, requests/day, tokens/minute,
 * tokens/day — and the dashboard used to throw all of them away unless the metric was tokens
 * and the value came from a published table. This module reads the refusal itself and returns
 * every window it names, including a `limit: 0` that means "this model is not on the free
 * tier". The provider's `QuotaFailure` shape is covered both as structured JSON and as the
 * flattened text form some relay layers preserve.
 *
 * The result is plain data: no server state, no clock other than the caller's, so the parsing
 * can be tested directly.
 */

/** Short windows first; a minute bar is the most immediate limit on a row. */
const PERIOD_ORDER = { minute: 0, day: 1, week: 2, month: 3, window: 4 }
const METRIC_ORDER = { requests: 0, tokens: 1 }

/** @param {*} value */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * The period a quota id or description names. IDs are camel-cased
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), so the spaces are optional.
 * @param {*} value
 * @returns {'minute'|'day'|'week'|'month'|null}
 */
export function parseQuotaPeriod(value) {
  const text = textOf(value).toLowerCase()
  if (!text) return null
  if (/per\s*minute|perminute|\bminute\b|\brpm\b/.test(text)) return 'minute'
  if (/per\s*day|perday|\bdaily\b|\b24\s*hour/.test(text)) return 'day'
  if (/per\s*week|perweek|\bweekly\b|\b7\s*day/.test(text)) return 'week'
  if (/per\s*month|permonth|\bmonthly\b|\b30\s*day/.test(text)) return 'month'
  return null
}

/**
 * The unit a quota metric names.
 * @param {*} value
 * @returns {'requests'|'tokens'|null}
 */
export function parseQuotaMetric(value) {
  const text = textOf(value).toLowerCase()
  if (/token/.test(text)) return 'tokens'
  if (/request/.test(text)) return 'requests'
  return null
}

/**
 * A response description often ends with "See https://…" on the same line. That link is
 * provenance, not part of the window's label, so it is trimmed from the tooltip/detail.
 * @param {*} value
 */
function cleanDescription(value) {
  return textOf(value)
    .replace(/\s+See\s+https?:\/\/\S+.*$/i, '')
    .trim()
}

/**
 * Parses Google's retry strings ("22h2m4.963s", "Retry after 58 seconds") into milliseconds.
 * @param {*} value
 * @returns {number|null}
 */
function parseDurationMs(value) {
  const text = textOf(value).trim()
  if (!text) return null
  const unit =
    /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi
  let total = 0
  let matched = false
  for (const match of text.matchAll(unit)) {
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) continue
    const name = match[2].toLowerCase()
    const factor =
      name.startsWith('ms') || name.startsWith('millisecond')
        ? 1
        : name.startsWith('d')
          ? 86_400_000
          : name.startsWith('h')
            ? 3_600_000
            : name.startsWith('m') && !name.startsWith('ms') && !name.startsWith('millisecond')
              ? 60_000
              : 1_000
    total += amount * factor
    matched = true
  }
  if (matched) return Math.round(total)
  const bare = Number(text)
  return Number.isFinite(bare) && bare > 0 ? Math.round(bare * 1000) : null
}

/**
 * The reset time stated by a quota body. `retry in …` is relative to the response, so the
 * response's own timestamp is the base when one is known. Using `Date.now()` would move an
 * old refusal's reset further away on every dashboard refresh.
 * @param {*} text
 * @param {number} observedAt
 * @returns {number|null}
 */
export function resetAtFromErrorText(text, observedAt) {
  const body = textOf(text)
  if (!body) return null
  const retryIn = /(?:please\s+)?retry\s+in\s+([0-9dhms.\s]+)/i.exec(body)
  if (retryIn) {
    const delay = parseDurationMs(retryIn[1])
    if (delay != null) return observedAt + delay
  }
  const retryAfter =
    /retry\s+after\s+([0-9.]+\s*(?:milliseconds?|ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s))/i.exec(
      body,
    )
  if (retryAfter) {
    const delay = parseDurationMs(retryAfter[1])
    if (delay != null) return observedAt + delay
  }
  // "Resets in 161h41m31s" — Antigravity's 429 states the window in the compact form and
  // never says "retry", so every branch above missed it and the quota row had no reset to
  // count down to.
  const resetsIn = /(?:resets?|renews?)\s+(?:in|after)\s+([0-9dhms.\s]+)/i.exec(body)
  if (resetsIn) {
    const delay = parseDurationMs(resetsIn[1])
    if (delay != null) return observedAt + delay
  }
  return null
}

/**
 * @typedef {object} QuotaWindow
 * @property {'requests'|'tokens'} metric
 * @property {'minute'|'day'|'week'|'month'|'window'} period
 * @property {string} rawWindow
 * @property {number|null} limit
 * @property {number|null} remaining
 * @property {number|null} used
 * @property {number|null} resetAt
 * @property {'model'|'account'} scope
 * @property {string} source
 * @property {string} detail
 * @property {number} observedAt
 * @property {boolean} unavailable
 */

/**
 * Build one normalized window. A quota failure means the named allowance was reached, so
 * `remaining` is zero. A zero allowance is kept — it is how Google says a model has no free
 * tier — but is marked `unavailable` so the table can say so instead of drawing a 0%-left bar
 * as if it were a spent window that resets.
 *
 * @param {object} candidate
 * @returns {QuotaWindow|null}
 */
function makeWindow(candidate) {
  const metric =
    candidate.metric === 'requests' ? 'requests' : candidate.metric === 'tokens' ? 'tokens' : null
  if (!metric) return null
  const rawLimit = candidate.limit == null ? null : Number(candidate.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : null
  const period = candidate.period || 'window'
  const observedAt = Number(candidate.observedAt) || Date.now()
  const resetAt = Number(candidate.resetAt) > 0 ? Number(candidate.resetAt) : null
  const unavailable = limit === 0
  return {
    metric,
    period,
    rawWindow:
      cleanDescription(candidate.description) ||
      textOf(candidate.quotaId) ||
      `${metric} per ${period}`,
    limit,
    remaining: 0,
    used: limit == null ? null : limit,
    // A zero allowance is not a window anyone can wait out; a countdown beside it would
    // promise a reset that never comes.
    resetAt: unavailable ? null : resetAt,
    scope: candidate.model || /permodel/i.test(textOf(candidate.quotaId)) ? 'model' : 'account',
    source: candidate.source || 'quota-failure',
    detail: cleanDescription(candidate.description) || textOf(candidate.quotaId) || '',
    observedAt,
    unavailable,
  }
}

/**
 * Extracts every quota window from the evidence saved on one model row. The row's last
 * response is the durable evidence; `rateLimit.quota` is the same observation when it was
 * captured live and survives separately.
 *
 * @param {{ modelId?: string|null, rateLimit?: object|null, lastResponse?: object|null }} evidence
 * @param {number} [now] only used to mark old positive windows stale
 * @returns {QuotaWindow[]}
 */
export function extractQuotaWindows(evidence = {}, now = Date.now()) {
  const rateLimit =
    evidence?.rateLimit && typeof evidence.rateLimit === 'object' ? evidence.rateLimit : null
  const lastResponse =
    evidence?.lastResponse && typeof evidence.lastResponse === 'object'
      ? evidence.lastResponse
      : null
  const errorText = textOf(lastResponse?.error)
  const observedAt = Number(lastResponse?.at) || Number(rateLimit?.capturedAt) || now
  const statedReset = Number(lastResponse?.rateLimitResetAt) || null
  const retryAt = resetAtFromErrorText(errorText, observedAt)
  const fallbackReset = statedReset || retryAt
  // Every error body would otherwise run the quota regexes on every /api/models read.
  if (!/quota/i.test(errorText) && !rateLimit?.quota) return []
  const windows = new Map()

  const add = (candidate) => {
    const window = makeWindow({
      ...candidate,
      observedAt,
      resetAt: candidate.resetAt || fallbackReset,
    })
    if (!window) return
    // A positive window whose stated reset has already passed is history, not a current
    // quota. Zero allowances are permanent statements about the free tier, so they stay.
    if (window.limit !== 0 && window.resetAt != null && window.resetAt <= now) return
    const key = `${window.metric}:${window.period}:${window.scope}`
    const existing = windows.get(key)
    if (!existing) {
      windows.set(key, window)
      return
    }
    const existingUnknown = existing.limit == null
    const incomingKnown = window.limit != null
    const incomingReplacesZero = existing.limit === 0 && window.limit != null && window.limit > 0
    // A reset-only snapshot (rateLimit.quota with no quotaValue) must not replace a stated
    // zero: "this model has no free tier" is a stronger fact than "a window reset exists".
    const incomingAddsReset =
      existing.resetAt == null && window.resetAt != null && existing.limit === window.limit
    if ((existingUnknown && incomingKnown) || incomingReplacesZero || incomingAddsReset) {
      windows.set(key, window)
    }
  }

  const addText = (text) => {
    const body = textOf(text)
    if (!body) return
    // Some relays save the JSON string with escaped newlines; normalizing those lets the
    // same line parser work on both a structured body and a truncated serialized one.
    const normalized = body.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    const line =
      /Quota exceeded for metric:\s*([^,\n]+),\s*limit:\s*(\d+)(?:,\s*model:\s*([^,\n]+))?(?:,\s*description:\s*([^\n]+))?/gi
    for (const match of normalized.matchAll(line)) {
      const metricText = `${match[1] || ''} ${match[4] || ''}`
      add({
        metric: parseQuotaMetric(metricText),
        period: parseQuotaPeriod(`${match[4] || ''} ${match[1] || ''}`),
        limit: Number(match[2]),
        model: match[3] ? match[3].trim() : null,
        quotaId: match[1] ? match[1].trim() : null,
        description: match[4] || '',
      })
    }
    // LLM7 and similar plain-text refusals name no numeric limit, but still state a window
    // and a retry delay. A reset-only window is useful: it says the row is exhausted and
    // when it becomes usable again.
    const generic =
      /(?:^|\n|\s)(daily|weekly|monthly|per\s*minute)\s+(tokens?|requests?)\s+quota\s+(?:exceeded|exhausted|reached)/i.exec(
        normalized,
      )
    if (generic) {
      add({
        metric: parseQuotaMetric(generic[2]),
        period: parseQuotaPeriod(generic[1]),
        limit: null,
        description: generic[0].trim(),
      })
    }
  }

  const addStructured = (text) => {
    const body = textOf(text)
    if (!body) return
    let data
    try {
      data = JSON.parse(body)
    } catch {
      return
    }
    const err = Array.isArray(data)
      ? data[0]?.error
      : data && typeof data === 'object'
        ? data.error
        : null
    if (!err || typeof err !== 'object') return
    for (const detail of Array.isArray(err.details) ? err.details : []) {
      if (!detail || typeof detail !== 'object') continue
      const violations =
        detail.QuotaFailure?.violations ??
        detail.quotaFailure?.violations ??
        (Array.isArray(detail.violations) ? detail.violations : [])
      for (const violation of Array.isArray(violations) ? violations : []) {
        if (!violation || typeof violation !== 'object') continue
        add({
          metric:
            parseQuotaMetric(violation.quotaMetric) || parseQuotaMetric(violation.description),
          period: parseQuotaPeriod(violation.quotaId) || parseQuotaPeriod(violation.description),
          limit: violation.quotaValue,
          model: violation.quotaDimensions?.model || null,
          quotaId: violation.quotaId || null,
          description: violation.description || violation.quotaId || '',
        })
      }
    }
  }

  const addRateLimitQuota = () => {
    const quota = rateLimit?.quota
    if (!quota || typeof quota !== 'object') return
    if (quota.quotaId == null && quota.quotaValue == null && quota.quotaMetric == null) return
    const metric = parseQuotaMetric(quota.quotaMetric) || parseQuotaMetric(quota.quotaId)
    const period = parseQuotaPeriod(quota.quotaId) || parseQuotaPeriod(quota.quotaMetric)
    const explicitReset = metric === 'tokens' ? rateLimit.resetTokensAt : rateLimit.resetRequestsAt
    const retryReset =
      rateLimit.capturedAt && rateLimit.retryAfterMs
        ? Number(rateLimit.capturedAt) + Number(rateLimit.retryAfterMs)
        : null
    add({
      metric,
      period,
      limit: quota.quotaValue,
      model: quota.modelId || evidence?.modelId || null,
      quotaId: quota.quotaId || null,
      description: quota.quotaId || '',
      resetAt: explicitReset || retryReset,
    })
  }

  // Structured details carry quotaId/description; the message text carries the same values
  // and often the only retry time, so both are read and deduplicated.
  addStructured(errorText)
  addText(errorText)
  addRateLimitQuota()

  return [...windows.values()].sort(
    (a, b) =>
      (PERIOD_ORDER[a.period] ?? 9) - (PERIOD_ORDER[b.period] ?? 9) ||
      (METRIC_ORDER[a.metric] ?? 9) - (METRIC_ORDER[b.metric] ?? 9),
  )
}
