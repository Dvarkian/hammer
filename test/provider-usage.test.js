import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeProviderUsageReport,
  selectProviderUsageReport,
  serializeProviderUsage,
} from '../lib/provider-usage.js'

test('quota reports preserve the original total, remaining amount, and period', () => {
  const [requests] = normalizeProviderUsageReport('example', {
    metric: 'requests',
    limit: 5000,
    used: 1200,
    window: 'day',
    reset: '2030-01-01T00:00:00.000Z',
  }, { accountIndex: 0, accountLabel: 'Account A' })

  assert.equal(requests.metric, 'requests')
  assert.equal(requests.limit, 5000)
  assert.equal(requests.used, 1200)
  assert.equal(requests.remaining, 3800)
  assert.equal(requests.window, 'day')
  assert.equal(requests.accountIndex, 0)
  assert.equal(requests.accountLabel, 'Account A')
})

test('percentage quotas are a first-class quota kind', () => {
  const [report] = normalizeProviderUsageReport('openai-codex', {
    metric: 'percent',
    used: 13,
    limit: 100,
    window: 'rolling',
    accountIndex: 1,
    accountLabel: 'person@example.com',
  })

  assert.equal(report.metric, 'percent')
  assert.equal(report.used, 13)
  assert.equal(report.remaining, 87)
  assert.equal(report.unit, 'percent')
  assert.equal(report.accountIndex, 1)
  assert.equal(report.accountLabel, 'person@example.com')
})

test('a provider may report independent quota windows for the same account', () => {
  const reports = normalizeProviderUsageReport('example', [
    { metric: 'requests', limit: 100, remaining: 25, window: 'day' },
    { metric: 'requests', limit: 50, remaining: 40, window: 'week' },
  ], { accountIndex: 0, accountLabel: 'Account A' })

  assert.equal(reports.length, 2)
  assert.deepEqual(reports.map(report => report.window), ['day', 'week'])
  assert.equal(reports[0].remaining, 25)
  assert.equal(reports[1].remaining, 40)
})

test('serialized quota reports include account identity without exposing credentials', () => {
  const [serialized] = serializeProviderUsage([{
    providerKey: 'example',
    metric: 'credits',
    used: 2,
    limit: 10,
    remaining: 8,
    unit: 'credits',
    accountIndex: 2,
    accountLabel: 'Account C',
    window: 'month',
    resetAt: 1893456000000,
    freshness: 'fresh',
  }])

  assert.equal(serialized.accountIndex, 2)
  assert.equal(serialized.accountLabel, 'Account C')
  assert.equal(serialized.remaining, 8)
  assert.equal(serialized.window, 'month')
  assert.equal('secret' in serialized, false)
})

test('a named relative reset is read as a duration, not as an epoch date', () => {
  const before = Date.now()
  const [report] = normalizeProviderUsageReport('example', {
    metric: 'requests',
    limit: 100,
    remaining: 40,
    window: 'day',
    reset_after_seconds: 3600,
  })
  const after = Date.now()

  assert.ok(report.resetAt >= before + 3600 * 1000, 'the reset lands an hour from now')
  assert.ok(report.resetAt <= after + 3600 * 1000, 'and not in 1970')
})

test('a percentage window cannot exceed its own scale', () => {
  const [report] = normalizeProviderUsageReport('example', {
    metric: 'percent',
    used: 150,
    limit: 100,
    remaining: -20,
  })

  assert.equal(report.used, 100)
  assert.equal(report.limit, 100)
  assert.equal(report.remaining, 0)
})

test('a consumption-only report keeps the amount it was given', () => {
  const [report] = normalizeProviderUsageReport('example', {
    metric: 'credits',
    used: 0.24,
  })

  assert.equal(report.used, 0.24)
  assert.equal(report.limit, null)
  assert.equal(report.remaining, null)
})

test('an envelope is unwrapped even when it also carries a direct quota field', () => {
  const reports = normalizeProviderUsageReport('example', {
    reset_after_seconds: 3600,
    data: [
      { metric: 'requests', limit: 100, remaining: 40 },
      { metric: 'percent', percentRemaining: 60 },
    ],
  })

  // Two real items, and no third report invented from the envelope's own reset duration.
  assert.equal(reports.length, 2)
  assert.deepEqual(reports.map(report => report.metric).sort(), ['percent', 'requests'])
})

test('non-object entries in a provider payload are ignored, not fatal', () => {
  const reports = normalizeProviderUsageReport('example', [
    null,
    'not-a-report',
    { metric: 'requests', limit: 10, remaining: 5 },
  ])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].remaining, 5)
})

test('selection prefers a report for the requested model, then the account-wide report', () => {
  const reports = [
    { providerKey: 'example', metric: 'requests', model: null, remaining: 8 },
    { providerKey: 'example', metric: 'requests', model: 'model-a', remaining: 2 },
  ]
  assert.equal(selectProviderUsageReport(reports, { model: 'model-a' }).model, 'model-a')
  assert.equal(selectProviderUsageReport(reports).model, null)
})
