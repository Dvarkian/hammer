import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getGoogleQuotaCardReports,
  resetGoogleQuotaCacheForTests,
  stageGoogleQuotaWindowsForTests,
} from '../lib/google-quota.js'

/** One bucket exactly as `parseGoogleQuotaBuckets` emits it, after the refresh stamps it. */
function bucket(modelId, usedPercent, extra = {}) {
  return {
    metric: 'requests',
    period: 'window',
    rawWindow: 'Code Assist quota',
    limit: null,
    remaining: null,
    used: null,
    usedPercent,
    percentOnly: true,
    resetAt: Date.now() + 3_600_000,
    scope: 'model',
    source: 'google-oauth',
    detail: `${usedPercent}% used`,
    observedAt: Date.now(),
    unavailable: false,
    modelId,
    ...extra,
  }
}

test('the card gets one percent report per account, tightest window first', () => {
  resetGoogleQuotaCacheForTests()
  try {
    stageGoogleQuotaWindowsForTests('google-antigravity', [
      bucket('gemini-3.8-flash-medium', 2.2, {
        accountIndex: 0,
        accountLabel: 'first@example.com',
      }),
      bucket('claude-sonnet-4-6', 100, { accountIndex: 0, accountLabel: 'first@example.com' }),
      bucket('gemini-3.8-flash-medium', 0, { accountIndex: 1, accountLabel: 'second@example.com' }),
    ])

    const reports = getGoogleQuotaCardReports('google-antigravity')

    assert.equal(reports.length, 2)
    // The account at 0% on one model is the account that runs out first, so its bar reports
    // that window rather than the 98% its Gemini bucket still has.
    assert.deepEqual(
      reports.map((report) => [report.accountIndex, report.remaining, report.model]),
      [
        [0, 0, 'claude-sonnet-4-6'],
        [1, 100, 'gemini-3.8-flash-medium'],
      ],
    )
    for (const report of reports) {
      assert.equal(report.metric, 'percent')
      assert.equal(report.unit, 'percent')
      assert.equal(report.limit, 100)
      assert.equal(report.providerKey, 'google-antigravity')
      assert.equal(
        report.accountLabel,
        report.accountIndex === 0 ? 'first@example.com' : 'second@example.com',
      )
    }
  } finally {
    resetGoogleQuotaCacheForTests()
  }
})

test('a window whose reset has passed is not reported as live quota', () => {
  resetGoogleQuotaCacheForTests()
  try {
    stageGoogleQuotaWindowsForTests('google-antigravity', [
      bucket('claude-opus-4-6-thinking', 100, {
        accountIndex: 0,
        resetAt: Date.now() - 60_000,
      }),
      bucket('gemini-3.8-flash-medium', 25, { accountIndex: 0 }),
    ])

    const reports = getGoogleQuotaCardReports('google-antigravity')

    assert.equal(reports.length, 1)
    assert.equal(reports[0].remaining, 75)
    assert.equal(reports[0].model, 'gemini-3.8-flash-medium')
  } finally {
    resetGoogleQuotaCacheForTests()
  }
})

test('each Google provider reads only its own buckets', () => {
  resetGoogleQuotaCacheForTests()
  try {
    stageGoogleQuotaWindowsForTests('googleai', [bucket('gemini-3-pro', 40, { accountIndex: 0 })])

    assert.equal(getGoogleQuotaCardReports('googleai').length, 1)
    assert.deepEqual(getGoogleQuotaCardReports('google-antigravity'), [])
  } finally {
    resetGoogleQuotaCacheForTests()
  }
})
