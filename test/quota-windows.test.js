import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractQuotaWindows,
  googleDailyQuotaResetAt,
  nextPacificMidnight,
  parseQuotaMetric,
  parseQuotaPeriod,
  resetAtFromErrorText,
} from '../lib/quota-windows.js'
import { extractRateLimitResetMs } from '../lib/utils.js'

const NOW = 1_800_000_000_000

function googleText(limit = 25) {
  return `You exceeded your current quota.
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${limit}, model: gemini-x, description: Generate content requests per day limit exceeded on Free Tier. See https://ai.google.dev/gemini-api/docs/rate-limits.
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-x, description: Generate content requests per minute limit exceeded on Free Tier. See https://ai.google.dev/gemini-api/docs/rate-limits.
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-x, description: Generate content input tokens per minute limit exceeded on Free Tier. See https://ai.google.dev/gemini-api/docs/rate-limits.
Please retry in 22h2m4.963847456s.`
}

test('the quota id and metric spellings Google uses are recognized', () => {
  assert.equal(parseQuotaPeriod('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 'day')
  assert.equal(parseQuotaPeriod('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), 'minute')
  assert.equal(parseQuotaPeriod('GenerateContentInputTokensPerModelPerMinute-FreeTier'), 'minute')
  assert.equal(
    parseQuotaMetric('generativelanguage.googleapis.com/generate_content_free_tier_requests'),
    'requests',
  )
  assert.equal(
    parseQuotaMetric(
      'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
    ),
    'tokens',
  )
})

test('every Google request and token window survives a plain-text quota failure', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'models/gemini-x',
      lastResponse: { status: 429, at: NOW, error: googleText(25) },
    },
    NOW,
  )
  assert.equal(windows.length, 3)
  const day = windows.find((window) => window.metric === 'requests' && window.period === 'day')
  const minuteRequests = windows.find(
    (window) => window.metric === 'requests' && window.period === 'minute',
  )
  const minuteTokens = windows.find(
    (window) => window.metric === 'tokens' && window.period === 'minute',
  )
  assert.equal(day.limit, 25)
  assert.equal(day.remaining, 0)
  assert.equal(day.used, 25)
  assert.equal(day.scope, 'model')
  assert.equal(day.unavailable, false)
  assert.equal(minuteRequests.limit, 5)
  assert.equal(minuteTokens.limit, 250_000)
  // 22h 2m 4.963847456s, rounded to the nearest millisecond.
  assert.equal(day.resetAt - NOW, 79_324_964)
  // The shortest window comes first, and requests sort before tokens within a period.
  assert.deepEqual(
    windows.map((window) => `${window.metric}:${window.period}`),
    ['requests:minute', 'tokens:minute', 'requests:day'],
  )
})

test('structured QuotaFailure details and zero free-tier limits are kept', () => {
  const error = JSON.stringify([
    {
      error: {
        code: 429,
        details: [
          {
            QuotaFailure: {
              violations: [
                {
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                  quotaMetric:
                    'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                  quotaValue: '0',
                  quotaDimensions: { model: 'gemini-paid-only' },
                },
              ],
            },
          },
        ],
      },
    },
  ])
  const windows = extractQuotaWindows(
    { modelId: 'models/gemini-paid-only', lastResponse: { status: 429, at: NOW, error } },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].metric, 'requests')
  assert.equal(windows[0].period, 'day')
  assert.equal(windows[0].limit, 0)
  assert.equal(windows[0].remaining, 0)
  assert.equal(windows[0].scope, 'model')
  assert.equal(windows[0].unavailable, true)
  assert.equal(windows[0].resetAt, null)
})

test('a rate-limit quota is read when no error body survives', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'models/gemini-x',
      rateLimit: {
        capturedAt: NOW - 1_000,
        wasRateLimited: true,
        resetRequestsAt: NOW + 60_000,
        quota: {
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaValue: null,
        },
      },
    },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].metric, 'requests')
  assert.equal(windows[0].period, 'day')
  assert.equal(windows[0].limit, null)
  assert.equal(windows[0].remaining, 0)
  assert.equal(windows[0].resetAt, NOW + 60_000)
})

test('a reset-only snapshot never overwrites a stated zero allowance', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'models/nano-banana-pro-preview',
      rateLimit: {
        capturedAt: NOW,
        wasRateLimited: true,
        resetRequestsAt: NOW + 60_000,
        quota: {
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaValue: null,
        },
      },
      lastResponse: {
        status: 429,
        at: NOW,
        error:
          '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: nano-banana-pro-preview, description: Generate content requests per day limit exceeded on Free Tier. Please retry in 1m.',
      },
    },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].limit, 0)
  assert.equal(windows[0].unavailable, true)
  assert.equal(windows[0].resetAt, null)
})

test('a reset-only text quota is useful for providers that state no number', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'codestral-latest',
      lastResponse: {
        status: 429,
        at: NOW,
        error: 'Daily token quota exceeded. Retry after 84066 seconds.',
      },
    },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].metric, 'tokens')
  assert.equal(windows[0].period, 'day')
  assert.equal(windows[0].limit, null)
  assert.equal(windows[0].remaining, 0)
  assert.equal(windows[0].resetAt, NOW + 84_066_000)
})

test("InferX's tenant refusal still says the account is spent", () => {
  // The gateway refuses at the tenant, not at a window: no metric, no limit, no reset. The
  // window keeps only what the refusal proves — nothing will be served — so the Quota cell
  // stops showing an empty dash while the provider is saying the account is exhausted.
  const windows = extractQuotaWindows(
    {
      modelId: 'deepseek-v4.1-flash-1017-basic',
      lastResponse: {
        status: 429,
        at: NOW,
        error: 'service failure: tenant tn-5foy8e963f quota exceeded',
      },
    },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].metric, 'requests')
  assert.equal(windows[0].period, 'window')
  assert.equal(windows[0].limit, null)
  assert.equal(windows[0].remaining, 0)
  assert.equal(windows[0].scope, 'account')
  assert.equal(windows[0].resetAt, null)
  // No denominator is published, but the refusal proves the allowance is spent: the cell
  // draws a full bar instead of an unknown one next to "0 left".
  assert.equal(windows[0].usedPercent, 100)
  assert.match(windows[0].detail, /tn-5foy8e963f/)
})

test('a positive window whose reset has passed is no longer shown', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'models/gemini-x',
      lastResponse: {
        status: 429,
        at: NOW - 10 * 60_000,
        error:
          '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 25, model: gemini-x, description: Generate content requests per day limit exceeded on Free Tier. Please retry in 1m.',
      },
    },
    NOW,
  )
  assert.equal(windows.length, 0)
})

test('a rate-limit message that names no metric is not guessed into a quota', () => {
  assert.deepEqual(
    extractQuotaWindows(
      {
        modelId: 'mistral-large-4',
        lastResponse: { status: 429, at: NOW, error: 'Rate limit exceeded' },
      },
      NOW,
    ),
    [],
  )
})

test("Antigravity's 429 names its window in hours, not as a retry", () => {
  // The real body: "Individual quota reached. Please upgrade your subscription to increase
  // your limits. Resets in 161h41m31s." There is no "retry" in it, and the delay is in the
  // compact h/m/s form, so the old parser found no window and the row kept a bare clock.
  const now = 1_700_000_000_000
  const body = JSON.stringify({
    error: {
      code: 429,
      message:
        'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 161h41m31s.',
      status: 'RESOURCE_EXHAUSTED',
    },
  })
  assert.equal(resetAtFromErrorText(body, now), now + ((161 * 60 + 41) * 60 + 31) * 1000)
  // The wordings that already worked still do.
  assert.equal(resetAtFromErrorText('Retry after 84066 seconds.', now), now + 84_066_000)
  assert.equal(resetAtFromErrorText('Please retry in 22h2m4.963847456s.', now), now + 79_324_964)
  // Google also states days: "Resets in 6d 22h" is 166 hours, not 22.
  assert.equal(resetAtFromErrorText('Resets in 6d 22h.', now), now + 166 * 3_600_000)
  assert.equal(resetAtFromErrorText('Rate limit exceeded', now), null)
})

// Google's RPD wall often arrives without RetryInfo, unlike its per-minute refusals. The
// provider still publishes the boundary — midnight Pacific — so the clock and the quota row
// count to a real reset instead of leaving a bare clock beside a spent daily allowance.
test('a Google daily quota with no retry info resets at midnight Pacific', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0) // 9 Nov 2026, 04:00 PST
  const expected = Date.UTC(2026, 10, 10, 8, 0, 0) // 10 Nov 2026, 00:00 PST
  const body =
    'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
    'limit: 20, model: gemini-3.6-flash, description: Generate content requests per day limit exceeded on Free Tier.'
  assert.equal(nextPacificMidnight(now), expected)
  assert.equal(googleDailyQuotaResetAt(body, now), expected)
  assert.equal(extractRateLimitResetMs(body, null, now), expected)
  // The body-level duration parser only reads what the provider stated; the day window
  // itself gets the inferred reset below.
  assert.equal(resetAtFromErrorText(body, now), null)
  const windows = extractQuotaWindows(
    { modelId: 'gemini-3.5-flash', lastResponse: { status: 429, at: now, error: body } },
    now,
  )
  const day = windows.find((window) => window.period === 'day' && window.metric === 'requests')
  assert.equal(day.limit, 20)
  assert.equal(day.resetAt, expected)
})

test('the Pacific boundary follows both sides of daylight saving', () => {
  // 1 July 2026, 05:00 PDT -> 2 July 00:00 PDT.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 6, 1, 12)), Date.UTC(2026, 6, 2, 7))
  // 9 November 2026, 04:00 PST -> 10 November 00:00 PST.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 9, 12)), Date.UTC(2026, 10, 10, 8))
})

test('per-minute Google refusals and zero grants get no daily reset', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0)
  const minute =
    'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
    'limit: 5, model: gemini-3.6-flash, description: Generate content requests per minute limit exceeded on Free Tier.'
  assert.equal(googleDailyQuotaResetAt(minute, now), null)
  assert.equal(resetAtFromErrorText(minute, now), null)
  const zero =
    'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
    'limit: 0, model: gemini-3.6-pro, description: Generate content requests per day limit exceeded on Free Tier.'
  assert.equal(googleDailyQuotaResetAt(zero, now), null)
  assert.equal(extractRateLimitResetMs(zero, null, now), null)
})

// An hourly window is the one period both quota columns could already order, label and count
// (KiloCode's 200 requests/hour pool is measured against the trailing hour) while the parser
// that reads refusals had no word for it. An hourly gateway's 429 therefore produced no window
// at all: `parseQuotaPeriod('per hour')` was null, so the row that was throttled for an hour
// showed nothing about the allowance that had just run out.
test('the hour is a period a refusal can name, and "24 hour" still means a day', () => {
  assert.equal(parseQuotaPeriod('per hour'), 'hour')
  assert.equal(parseQuotaPeriod('hourly'), 'hour')
  assert.equal(parseQuotaPeriod('requests per hour'), 'hour')
  assert.equal(parseQuotaPeriod('200 requests/hour'), 'hour')
  assert.equal(parseQuotaPeriod('GenerateRequestsPerHourPerProjectPerModel-FreeTier'), 'hour')
  // The day spellings must not lose to the hour they contain.
  assert.equal(parseQuotaPeriod('24 hour'), 'day')
  assert.equal(parseQuotaPeriod('per day'), 'day')
})

test('an hourly refusal names its window and its stated limit', () => {
  const windows = extractQuotaWindows(
    {
      modelId: 'gpt-oss-120b',
      lastResponse: {
        status: 429,
        at: NOW,
        error:
          'Free tier hourly limit reached: 60 requests per hour. Please retry in 1429 seconds.',
      },
    },
    NOW,
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].metric, 'requests')
  assert.equal(windows[0].period, 'hour')
  assert.equal(windows[0].limit, 60)
  assert.equal(windows[0].remaining, 0)
  assert.equal(windows[0].resetAt, NOW + 1_429_000)
})

// Groq, Cerebras and the other OpenAI-compatible gateways never say the word "quota": they
// answer "Rate limit reached for 8000 tokens per minute" or "1000 requests per day limit
// reached". The parser's entry gate demanded "quota", so those bodies were dropped before any
// window could be read and the row kept a bare clock beside a window the provider had just
// named and numbered.
test('an OpenAI-compatible rate-limit body is read without the word "quota"', () => {
  const tpm = extractQuotaWindows(
    {
      modelId: 'gpt-oss-120b',
      lastResponse: {
        status: 429,
        at: NOW,
        error: 'Rate limit reached for 8000 tokens per minute. Please try again in 4.5 seconds.',
      },
    },
    NOW,
  )
  assert.equal(tpm.length, 1)
  assert.equal(tpm[0].metric, 'tokens')
  assert.equal(tpm[0].period, 'minute')
  assert.equal(tpm[0].limit, 8000)
  // "Please try again in 4.5 seconds" is the same promise as "retry in", which the delay
  // parser could not see until the words in the middle were allowed for.
  assert.equal(tpm[0].resetAt, NOW + 4_500)

  const rpd = extractQuotaWindows(
    {
      modelId: 'gpt-oss-20b',
      lastResponse: {
        status: 429,
        at: NOW,
        error:
          'Rate limit exceeded: 1000 requests per day limit reached. Please try again in 2h5m.',
      },
    },
    NOW,
  )
  assert.equal(rpd.length, 1)
  assert.equal(rpd[0].metric, 'requests')
  assert.equal(rpd[0].period, 'day')
  assert.equal(rpd[0].limit, 1000)
  assert.equal(rpd[0].resetAt, NOW + (2 * 60 + 5) * 60_000)
})

test('a prose window alone still fills the cell, but never doubles a named one', () => {
  // No "quota", no retry, no model: the number in the sentence is all there is, and it is
  // enough to say which allowance ran out and how big it was.
  const bare = extractQuotaWindows(
    {
      modelId: 'x',
      lastResponse: { status: 429, at: NOW, error: 'rate limit: 200 requests per hour exceeded' },
    },
    NOW,
  )
  assert.equal(bare.length, 1)
  assert.equal(bare[0].period, 'hour')
  assert.equal(bare[0].limit, 200)
  // Google's body names its windows in the QuotaFailure line, in minutes and in days. The
  // prose scan sees the same phrases; restating one would put a second, account-scoped bar
  // beside the model-scoped window that line already described.
  const google = extractQuotaWindows(
    {
      modelId: 'models/gemini-x',
      lastResponse: {
        status: 429,
        at: NOW,
        error:
          'You exceeded your current quota.\n' +
          '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-x, description: Generate content requests per minute limit exceeded on Free Tier.\n' +
          'Please retry in 30s.',
      },
    },
    NOW,
  )
  assert.equal(google.length, 1)
  assert.equal(google[0].limit, 5)
  assert.equal(google[0].scope, 'model')
})

// The gate exists so a body that says nothing about a limit costs nothing to read. Widening
// it to the rate-limit wordings must not make every failure look like a quota.
test('a body that names no window still yields no window', () => {
  for (const error of [
    'Something went wrong with the network.',
    'Incorrect API key provided.',
    'model not found',
    'Rate limit exceeded',
  ]) {
    assert.deepEqual(
      extractQuotaWindows({ modelId: 'm', lastResponse: { status: 429, at: NOW, error } }, NOW),
      [],
      error,
    )
  }
})
