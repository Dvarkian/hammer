import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRecordedUsage,
  isoWeekKey,
  readRecordedBucket,
  recordUsageBuckets,
  tokensForSample,
  utcDayKey,
  utcMonthKey,
} from '../lib/usage-windows.js'

const at = (iso) => new Date(`${iso}T12:00:00.000Z`)

test('a request counts its tokens once, not once per field', () => {
  // The proxy call sites build the sample as `prompt_tokens + completion_tokens`, so the total
  // is already the whole request. Adding the response again would bill every answer twice and
  // make recorded usage outrun the real spend against a published limit.
  assert.equal(tokensForSample({ contextTokens: 1000, completionTokens: 100 }), 1000)
  // With no total to use, the response stands in for what moved; nothing about a missing or
  // negative side may turn the figure into NaN or a negative spend.
  assert.equal(tokensForSample({ completionTokens: 40 }), 40)
  assert.equal(tokensForSample({ contextTokens: -5, completionTokens: 10 }), 10)
  assert.equal(tokensForSample(undefined), 0)
})

test('ISO weeks follow the calendar, not the year boundary', () => {
  // The week containing 2027-01-01 (a Friday) still belongs to 2026: its Thursday does.
  assert.equal(isoWeekKey(at('2026-12-28')), '2026-W53')
  assert.equal(isoWeekKey(at('2027-01-01')), '2026-W53')
  assert.equal(isoWeekKey(at('2027-01-04')), '2027-W01')
  // And the mirror case, a January that opens inside the previous year's last week.
  assert.equal(isoWeekKey(at('2025-12-29')), '2026-W01')
  assert.equal(isoWeekKey(at('2026-09-24')), '2026-W39')
  assert.equal(utcDayKey(at('2026-09-24')), '2026-09-24')
  assert.equal(utcMonthKey(at('2026-09-24')), '2026-09')
})

test('one request lands in the day, week, month and lifetime windows at once', () => {
  const entry = {}
  recordUsageBuckets(entry, { contextTokens: 1000, completionTokens: 400 }, at('2026-09-24'))
  recordUsageBuckets(entry, { contextTokens: 1000, completionTokens: 500 }, at('2026-09-24'))

  for (const period of ['day', 'week', 'month']) {
    const bucket = readRecordedBucket(entry, period, at('2026-09-24'))
    assert.equal(bucket.requests, 2, period)
    assert.equal(bucket.tokens, 2000, period)
  }
  assert.equal(entry.recorded.lifetime.requests, 2)
  assert.equal(entry.recorded.lifetime.tokens, 2000)
})

test('a rolled-over window reports nothing while the lifetime total keeps counting', () => {
  const entry = {}
  recordUsageBuckets(entry, { contextTokens: 200, completionTokens: 100 }, at('2026-09-30'))

  // Same week and month: still the current window.
  assert.equal(readRecordedBucket(entry, 'month', at('2026-09-30'))?.tokens, 200)
  // Next day is a new day, next month is a new month — neither may report September's spend
  // as its own, or a limit that already reset would look spent.
  assert.equal(readRecordedBucket(entry, 'day', at('2026-10-01')), null)
  assert.equal(readRecordedBucket(entry, 'month', at('2026-10-01')), null)
  assert.equal(readRecordedBucket(entry, 'lifetime', at('2026-10-01'))?.tokens, 200)

  // Recording again starts the new windows rather than adding to the old ones.
  recordUsageBuckets(entry, { contextTokens: 100, completionTokens: 50 }, at('2026-10-01'))
  assert.equal(readRecordedBucket(entry, 'day', at('2026-10-01')).tokens, 100)
  assert.equal(readRecordedBucket(entry, 'month', at('2026-10-01')).tokens, 100)
  assert.equal(entry.recorded.lifetime.tokens, 300)
})

test('recorded usage sums a provider\'s models and excludes every other provider', () => {
  const usageStats = new Map()
  const gpt = {}
  recordUsageBuckets(gpt, { contextTokens: 1000, completionTokens: 0 }, at('2026-09-24'))
  recordUsageBuckets(gpt, { contextTokens: 0, completionTokens: 500 }, at('2026-09-24'))
  usageStats.set('groq::llama-3', gpt)
  const other = {}
  recordUsageBuckets(other, { contextTokens: 14000, completionTokens: 7000 }, at('2026-09-24'))
  usageStats.set('groq::mixtral', other)
  const stranger = {}
  recordUsageBuckets(stranger, { contextTokens: 19998, completionTokens: 9999 }, at('2026-09-24'))
  usageStats.set('llm7::gpt-oss', stranger)
  // A bucket from an earlier month must not be counted as the current one when the caller asks
  // in September — the limit it belonged to has already reset.
  const stale = { recorded: { month: { key: '2026-08', requests: 40, tokens: 40000 }, lifetime: { requests: 40, tokens: 40000 } } }
  usageStats.set('groq::deprecated', stale)

  const recorded = buildRecordedUsage(usageStats, 'groq', at('2026-09-24'))
  assert.equal(recorded.tokensToday, 15500)
  assert.equal(recorded.tokensThisWeek, 15500)
  assert.equal(recorded.tokensThisMonth, 15500)
  // Lifetime is the one window with no date: the retired model's total counts in September too.
  assert.equal(recorded.tokensLifetime, 55500)
  assert.equal(recorded.requestsToday, 3)

  // In October the September days are gone but the lifetime spend is not: the retired model's
  // own lifetime total is part of what this provider has ever been recorded spending.
  const nextMonth = buildRecordedUsage(usageStats, 'groq', at('2026-10-01'))
  assert.equal(nextMonth.tokensThisMonth, 0)
  assert.equal(nextMonth.tokensToday, 0)
  assert.equal(nextMonth.tokensLifetime, 55500)
})

test('an entry with no recorded buckets reads as zero rather than throwing', () => {
  const usageStats = new Map([['groq::llama-3', { requests: 4 }]])
  const recorded = buildRecordedUsage(usageStats, 'groq', at('2026-09-24'))
  assert.equal(recorded.tokensToday, 0)
  assert.equal(recorded.requestsToday, 0)
  assert.equal(readRecordedBucket({}, 'month', at('2026-09-24')), null)
})
