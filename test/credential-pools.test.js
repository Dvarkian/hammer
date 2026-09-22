/**
 * How a provider's credential pool is spent.
 *
 * The policy these tests pin is deliberately *not* round-robin. Pools here are sets of
 * free-tier credentials — one API key per account, or one signed-in ChatGPT plan — and the
 * useful behaviour is to wring the first one dry before touching the second, so that a user
 * with three accounts gets three accounts' worth of allowance in sequence rather than a third
 * of each spread thinly across the same moment.
 *
 * Two things make that policy work, and both are tested here:
 *
 *   - "spent" has to mean *until a moment*, not "was limited at some point in the past".
 *     `benchCredential` therefore stores an absolute `exhaustedUntil`, taken from the
 *     provider's own `retry-after` when it gave one, because a daily quota and a per-minute
 *     burst window are not the same length.
 *   - a pool with nothing left must say so rather than hand back a credential it knows is
 *     spent, leaving the caller to decide what a request against it is worth.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CREDENTIAL_BENCH_MS,
  benchCredential,
  isCredentialSpent,
  selectNextApiKeyFromPool,
} from '../lib/utils.js'

import {
  _setKeyPoolState,
  credentialResetHintMs,
  describeCredentialPool,
} from '../lib/server.js'

/** Pool state in the shape the server keeps: one entry per provider. */
function poolState(entries = []) {
  return { currentIdx: 0, accounts: new Map(entries) }
}

const COOLDOWN = 60_000

// ── Spending one credential before the next ────────────────────────────────────────────

test('the first credential serves until it is spent, not one request at a time', () => {
  const pool = ['k1', 'k2', 'k3']
  const entry = poolState()
  const now = Date.now()
  const picks = [0, 1, 2, 3, 4].map(() => selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN))
  assert.deepEqual(picks, ['k1', 'k1', 'k1', 'k1', 'k1'])
  // The serving credential is what `currentIdx` means now: there is no "next" in a policy that
  // spends in order.
  assert.equal(entry.currentIdx, 0)
  assert.equal(entry.accounts.get(0).requests, 5)
})

test('spending the first moves to the second, and the third waits its turn', () => {
  const pool = ['k1', 'k2', 'k3']
  const entry = poolState()
  const now = Date.now()
  selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN)

  benchCredential(entry, 0, now, null, COOLDOWN)
  assert.deepEqual(
    [0, 1].map(() => selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN)),
    ['k2', 'k2'],
  )

  benchCredential(entry, 1, now, null, COOLDOWN)
  assert.deepEqual(
    [0, 1].map(() => selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN)),
    ['k3', 'k3'],
  )
  assert.equal(entry.currentIdx, 2)
})

test('a credential whose window has passed takes the traffic back', () => {
  const pool = ['k1', 'k2']
  const entry = poolState()
  const now = Date.now()
  benchCredential(entry, 0, now, null, COOLDOWN)
  assert.equal(selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN), 'k2')
  // The pool is ordered, so the earlier credential is preferred as soon as it is usable again.
  assert.equal(selectNextApiKeyFromPool(pool, entry, 0, now + COOLDOWN + 1, COOLDOWN), 'k1')
})

test('a pool with nothing left reports that, rather than a spent credential', () => {
  const pool = ['k1', 'k2']
  const entry = poolState()
  const now = Date.now()
  benchCredential(entry, 0, now, null, COOLDOWN)
  benchCredential(entry, 1, now, null, COOLDOWN)
  assert.equal(selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN), null)
})

test('an exhausted pool still refuses while one credential is merely over its budget', () => {
  const pool = ['k1', 'k2']
  const entry = poolState()
  const now = Date.now()
  // A request budget is ours to reset; a provider's exhaustion is not. This is the distinction
  // the rollover below depends on.
  benchCredential(entry, 0, now, null, COOLDOWN)
  entry.accounts.set(1, { requests: 0, rateLimitedAt: 0, exhaustedUntil: 0 })
  assert.equal(selectNextApiKeyFromPool(pool, entry, 0, now, COOLDOWN), 'k2')
})

test('a request budget paces the pool, then rolls over when every credential is over it', () => {
  const pool = ['k1', 'k2']
  const entry = poolState()
  const now = Date.now()
  const picks = [0, 1, 2, 3, 4].map(() => selectNextApiKeyFromPool(pool, entry, 2, now, COOLDOWN))
  // Two requests each, in order, then the budgets reset and the first credential serves again
  // rather than the pool reporting that it has nothing.
  assert.deepEqual(picks, ['k1', 'k1', 'k2', 'k2', 'k1'])
})

// ── What "spent" means ─────────────────────────────────────────────────────────────────

test('a bench lasts as long as the provider said, and no longer than a day', () => {
  const entry = poolState()
  const now = Date.now()
  benchCredential(entry, 0, now, 6 * 60 * 60 * 1000, COOLDOWN)
  assert.equal(entry.accounts.get(0).exhaustedUntil, now + 6 * 60 * 60 * 1000)
  // A provider answering with a year is not a reason to retire a credential for good.
  benchCredential(entry, 1, now, 400 * 24 * 60 * 60 * 1000, COOLDOWN)
  assert.equal(entry.accounts.get(1).exhaustedUntil, now + MAX_CREDENTIAL_BENCH_MS)
})

test('a bench with no stated reset falls back to the local window', () => {
  const entry = poolState()
  const now = Date.now()
  benchCredential(entry, 0, now, null, COOLDOWN)
  assert.equal(entry.accounts.get(0).exhaustedUntil, now + COOLDOWN)
  // A nonsense value is treated as no statement at all rather than as an instant reset.
  benchCredential(entry, 1, now, -5, COOLDOWN)
  assert.equal(entry.accounts.get(1).exhaustedUntil, now + COOLDOWN)
})

test('a stored timestamp from before this policy still reads as spent', () => {
  // Credentials benched by the previous code carry `rateLimitedAt` and no `exhaustedUntil`.
  const now = Date.now()
  assert.equal(isCredentialSpent({ requests: 1, rateLimitedAt: now }, now, COOLDOWN), true)
  assert.equal(isCredentialSpent({ requests: 1, rateLimitedAt: now - COOLDOWN - 1 }, now, COOLDOWN), false)
  assert.equal(isCredentialSpent(null, now, COOLDOWN), false)
  assert.equal(isCredentialSpent({ requests: 3 }, now, COOLDOWN), false)
  // A stated window wins over the fallback, which is the whole point of storing it.
  assert.equal(isCredentialSpent({ rateLimitedAt: now - COOLDOWN - 1, exhaustedUntil: now + 1000 }, now, COOLDOWN), true)
})

// ── Reading the provider's own answer ──────────────────────────────────────────────────

test('retry-after is read as seconds or as an HTTP date, and nothing else is invented', () => {
  assert.equal(credentialResetHintMs(new Response('', { status: 429, headers: { 'retry-after': '120' } })), 120_000)
  const at = new Date(Date.now() + 90_000).toUTCString()
  const fromDate = credentialResetHintMs(new Response('', { status: 429, headers: { 'retry-after': at } }))
  assert.ok(fromDate > 80_000 && fromDate <= 90_000, `expected ~90s, got ${fromDate}`)
  assert.equal(credentialResetHintMs(new Response('', { status: 429 })), null)
  assert.equal(credentialResetHintMs(new Response('', { status: 429, headers: { 'retry-after': 'soon' } })), null)
})

// ── What the dashboard is told ─────────────────────────────────────────────────────────

test('a card is told the pool size, who is serving, and who is spent', () => {
  const now = Date.now()
  const state = new Map([['googleai', poolState([[0, { requests: 7, rateLimitedAt: now, exhaustedUntil: now + 30_000 }]])]])
  _setKeyPoolState(state)
  try {
    const described = describeCredentialPool({ apiKeys: { googleai: ['key-one-value', 'key-two-value'] }, providers: {} }, 'googleai')
    assert.equal(described.count, 2)
    assert.equal(described.policy, 'exhaust')
    // The spent credential is first in the pool, so the second one is serving.
    assert.equal(described.servingIndex, 0)
    assert.deepEqual(described.accounts.map(a => a.exhausted), [true, false])
    assert.equal(described.accounts[0].requests, 7)
    assert.ok(described.accounts[0].resetsInMs > 0 && described.accounts[0].resetsInMs <= 30_000)
    assert.equal(described.accounts[1].resetsInMs, null)
  } finally {
    _setKeyPoolState(null)
  }
})

test('a described pool never carries a credential value', () => {
  const state = new Map([['googleai', poolState()]])
  _setKeyPoolState(state)
  try {
    const described = describeCredentialPool({ apiKeys: { googleai: ['AIzaSySuperSecretKeyMaterial'] }, providers: {} }, 'googleai')
    const serialized = JSON.stringify(described)
    assert.equal(serialized.includes('AIzaSySuperSecretKeyMaterial'), false)
    // Masked, so the row is still recognisable to the person who pasted it.
    assert.equal(described.accounts[0].label, 'AIza...rial')
  } finally {
    _setKeyPoolState(null)
  }
})

test('an account pool is described by its identities, not its tokens', () => {
  const state = new Map([['openai-codex', poolState()]])
  _setKeyPoolState(state)
  try {
    const config = { providers: { 'openai-codex': { accounts: [{ secret: 'refresh-secret-value', email: 'a@example.com' }] } } }
    const described = describeCredentialPool(config, 'openai-codex')
    assert.equal(described.count, 1)
    assert.equal(described.accounts[0].label, 'a@example.com')
    assert.equal(JSON.stringify(described).includes('refresh-secret-value'), false)
  } finally {
    _setKeyPoolState(null)
  }
})

test('a provider with no credential at all has no pool to draw', () => {
  // `gemini` rather than a provider with an env var: `getApiKeyPool` reads the environment
  // first, so a key exported on the machine running the tests would answer for it.
  assert.equal(describeCredentialPool({ apiKeys: {}, providers: {} }, 'gemini'), null)
})
