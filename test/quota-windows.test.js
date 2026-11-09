import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractQuotaWindows, parseQuotaMetric, parseQuotaPeriod } from '../lib/quota-windows.js'

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
