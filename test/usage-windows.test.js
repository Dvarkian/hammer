import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRecordedUsage,
  buildRecordedUsageForEntry,
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

test("recorded usage sums a provider's models and excludes every other provider", () => {
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
  const stale = {
    recorded: {
      month: { key: '2026-08', requests: 40, tokens: 40000 },
      lifetime: { requests: 40, tokens: 40000 },
    },
  }
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

test('a model-scoped total counts only that model', () => {
  const usageStats = new Map()
  const first = {}
  recordUsageBuckets(first, { contextTokens: 1200, completionTokens: 0 }, at('2026-09-24'))
  usageStats.set('groq::llama-3', first)
  const second = {}
  recordUsageBuckets(second, { contextTokens: 9000, completionTokens: 0 }, at('2026-09-24'))
  usageStats.set('groq::mixtral', second)

  const row = buildRecordedUsageForEntry(usageStats.get('groq::llama-3'), at('2026-09-24'))
  assert.equal(row.tokensToday, 1200)
  assert.equal(row.tokensThisMonth, 1200)
  assert.equal(row.tokensLifetime, 1200)
  // The provider total still sums both models: an account-scoped limit needs the other one.
  assert.equal(buildRecordedUsage(usageStats, 'groq', at('2026-09-24')).tokensToday, 10200)
})

// "200 requests/hour" is a rolling window at the provider, so the counter has to be one too: a
// fixed hourly bucket would report zero at 11:01 for traffic the provider was still throttling
// at 10:59.
test('the trailing hour counts the last sixty minutes and forgets the rest', () => {
  const entry = {}
  recordUsageBuckets(entry, { contextTokens: 100 }, new Date('2026-09-24T12:00:00.000Z'))
  recordUsageBuckets(entry, { contextTokens: 300 }, new Date('2026-09-24T12:59:00.000Z'))

  const inside = buildRecordedUsageForEntry(entry, new Date('2026-09-24T12:59:30.000Z'))
  assert.equal(inside.requestsLastHour, 2)
  assert.equal(inside.tokensLastHour, 400)
  // The minute window is the newest bucket of the same ring: only the 12:59 request counts.
  assert.equal(inside.requestsLastMinute, 1)
  assert.equal(inside.tokensLastMinute, 300)
  // The day window is unaffected: the hour is a trailing count, not a slice of the day.
  assert.equal(inside.requestsToday, 2)

  // At 13:00 the 12:00 request is exactly sixty minutes old and no longer counts.
  const later = buildRecordedUsageForEntry(entry, new Date('2026-09-24T13:00:00.000Z'))
  assert.equal(later.requestsLastHour, 1)
  assert.equal(later.tokensLastHour, 300)
  // Nothing landed in the new minute yet, so a per-minute cap reads zero rather than the
  // previous minute's count.
  assert.equal(later.requestsLastMinute, 0)
  assert.equal(later.tokensLastMinute, 0)

  // Recording again trims the expired minute instead of keeping it forever.
  recordUsageBuckets(entry, { contextTokens: 50 }, new Date('2026-09-24T13:00:10.000Z'))
  assert.equal(entry.recorded.hour.length, 2)
  const afterRecord = buildRecordedUsageForEntry(entry, new Date('2026-09-24T13:00:20.000Z'))
  assert.equal(afterRecord.requestsLastHour, 2)
  assert.equal(afterRecord.requestsLastMinute, 1)
})

test('the trailing hour sums a provider across its models', () => {
  const usageStats = new Map()
  const first = {}
  recordUsageBuckets(first, { contextTokens: 100 }, new Date('2026-09-24T12:10:00.000Z'))
  usageStats.set('kilocode::a', first)
  const second = {}
  recordUsageBuckets(second, { contextTokens: 200 }, new Date('2026-09-24T12:20:00.000Z'))
  recordUsageBuckets(second, { contextTokens: 200 }, new Date('2026-09-24T12:21:00.000Z'))
  usageStats.set('kilocode::b', second)

  const provider = buildRecordedUsage(usageStats, 'kilocode', new Date('2026-09-24T12:30:00.000Z'))
  assert.equal(provider.requestsLastHour, 3)
  assert.equal(provider.tokensLastHour, 500)
  assert.equal(
    buildRecordedUsageForEntry(first, new Date('2026-09-24T12:30:00.000Z')).requestsLastHour,
    1,
  )
})
