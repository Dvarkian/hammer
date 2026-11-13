/**
 * Per-account traffic and limit state.
 *
 * A provider that pools several credentials spends a per-key allowance, so the model-level
 * counters cannot fill any one account's bar: with two keys that each allow 20 requests a
 * minute, 30 recorded requests against the published 20 reads as a key at 150% when it may be
 * two keys at 15 and 0. These tests pin the two halves that make an account bar honest — the
 * traffic counted against the credential that carried it, and the pool describing each account
 * with its own windows — because a bar that borrows its sibling's numbers is worse than no bar.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  _setCredentialUsageStats,
  _setKeyPoolState,
  credentialRecordedUsage,
  credentialUsageKey,
  credentialUsageTotals,
  describeCredentialPool,
} from '../lib/server.js'
import { recordUsageBuckets } from '../lib/usage-windows.js'

/** Runs `body` with fresh module state so one test cannot see another's accounts. */
function withPoolState(body) {
  _setCredentialUsageStats(new Map())
  _setKeyPoolState(null)
  try {
    return body()
  } finally {
    _setCredentialUsageStats(new Map())
    _setKeyPoolState(null)
  }
}

test('traffic is counted against the credential that carried it', () => {
  withPoolState(() => {
    const entry = {}
    recordUsageBuckets(entry, { contextTokens: 1200 })
    _setCredentialUsageStats(new Map([[credentialUsageKey('openrouter', 1, 'llama-x'), entry]]))

    const own = credentialRecordedUsage('openrouter', 1, 'llama-x')
    assert.equal(own.requestsToday, 1)
    assert.equal(own.tokensToday, 1200)

    // The sibling account carried nothing: the pool's traffic must never be attributed to it.
    const sibling = credentialRecordedUsage('openrouter', 0, 'llama-x')
    assert.equal(sibling.requestsToday, 0)
    assert.equal(sibling.tokensToday, 0)

    // A provider-wide total for one credential sums only that credential's models.
    assert.equal(credentialUsageTotals('openrouter', 1).tokensToday, 1200)
    assert.equal(credentialUsageTotals('openrouter', 0).tokensToday, 0)
  })
})

test('a model has its own per-account counters, not a share of the provider total', () => {
  withPoolState(() => {
    const first = {}
    recordUsageBuckets(first, { contextTokens: 300 })
    const second = {}
    recordUsageBuckets(second, { contextTokens: 700 })
    recordUsageBuckets(second, { contextTokens: 100 })
    _setCredentialUsageStats(
      new Map([
        [credentialUsageKey('openrouter', 0, 'model-a'), first],
        [credentialUsageKey('openrouter', 0, 'model-b'), second],
      ]),
    )

    assert.equal(credentialRecordedUsage('openrouter', 0, 'model-a').tokensToday, 300)
    assert.equal(credentialRecordedUsage('openrouter', 0, 'model-b').tokensToday, 800)
    // The provider-wide figure is the sum across models, which is what the account card shows.
    assert.equal(credentialUsageTotals('openrouter', 0).tokensToday, 1100)
  })
})

test('the pool describes each account with its own traffic and stated windows', () => {
  withPoolState(() => {
    const config = { apiKeys: { openrouter: ['k1', 'k2'] }, providers: {} }
    const entry = {
      currentIdx: 1,
      accounts: new Map([
        [0, { requests: 3 }],
        [
          1,
          {
            requests: 7,
            rateLimit: { limitRequests: 20, remainingRequests: 5 },
            rateLimits: new Map([['model-a', { limitRequests: 9, remainingRequests: 1 }]]),
          },
        ],
      ]),
    }
    _setKeyPoolState(new Map([['openrouter', entry]]))
    const bucket = {}
    recordUsageBuckets(bucket, { contextTokens: 500 })
    _setCredentialUsageStats(new Map([[credentialUsageKey('openrouter', 1, 'model-a'), bucket]]))

    const scoped = describeCredentialPool(config, 'openrouter', { modelId: 'model-a' })
    assert.equal(scoped.count, 2)
    assert.equal(scoped.servingIndex, 1)
    assert.equal(scoped.accounts[1].usage.tokensToday, 500)
    assert.equal(scoped.accounts[0].usage.tokensToday, 0)
    // A per-model capture stays with its model: the account's other rows must not inherit it.
    assert.equal(scoped.accounts[1].rateLimit.limitRequests, 9)

    const accountWide = describeCredentialPool(config, 'openrouter')
    assert.equal(accountWide.accounts[1].rateLimit.limitRequests, 20)
    assert.equal(accountWide.accounts[1].usage.tokensToday, 500)
  })
})

test('a single-credential provider has nothing to fan out to', () => {
  withPoolState(() => {
    const described = describeCredentialPool(
      { apiKeys: { openrouter: 'k1' }, providers: {} },
      'openrouter',
    )
    assert.equal(described.count, 1)
  })
})
