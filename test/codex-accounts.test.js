/**
 * Multiple ChatGPT accounts behind one Codex provider.
 *
 * Codex is the one provider whose credential is an *account* rather than a key: the OAuth
 * refresh token a device-flow sign-in returns. That makes a second sign-in a distinct thing
 * from a second API key, and there are three separate promises to keep, so this file keeps
 * them apart:
 *
 *   1. the pool stores one entry per signed-in account and never grows a duplicate;
 *   2. signing one account out leaves the others alone, and only the last sign-out clears the
 *      legacy single-credential field;
 *   3. a request picks a different account when the last one hit its plan limit — which is the
 *      entire reason to have a second account, since a ChatGPT plan's windows are per account.
 *
 * The third one is the reason this file does not simply test storage. A pool that is written
 * but never rotated away from a 429 is decoration, so the selector is driven through the same
 * benching state the proxy path uses.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addOrUpdateProviderAccount,
  getProviderAccounts,
  getProviderAccountSecrets,
  removeProviderAccount,
} from '../lib/config.js'

import {
  applyProviderSignOut,
  rotatableCredentialPool,
  selectCodexRefreshToken,
} from '../lib/server.js'

const CODEX = 'openai-codex'

/** A config shaped the way the server holds it, with one or more signed-in accounts. */
function configWithAccounts(accounts) {
  return { providers: { [CODEX]: { authMode: 'device-flow', accounts } } }
}

/** The pool state `runServer` owns: one entry per provider, keyed by pool index. */
function poolState(providerKey, entries) {
  return new Map([[providerKey, { currentIdx: 0, accounts: new Map(entries) }]])
}

// ── The pool holds accounts, not one credential ────────────────────────────────────────

test('a second sign-in is appended, and the same account is refreshed in place', () => {
  const config = configWithAccounts([])
  addOrUpdateProviderAccount(config, CODEX, { secret: 'refresh-a', email: 'a@example.com', planType: 'plus' })
  addOrUpdateProviderAccount(config, CODEX, { secret: 'refresh-b', email: 'b@example.com', planType: 'pro' })
  assert.equal(getProviderAccounts(config, CODEX).length, 2)

  // The same email signing in again rotates its secret: one account, not a third entry.
  addOrUpdateProviderAccount(config, CODEX, { secret: 'refresh-a2', email: 'a@example.com' })
  const accounts = getProviderAccounts(config, CODEX)
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0].secret, 'refresh-a2')
  // Metadata the second sign-in did not repeat is kept rather than blanked.
  assert.equal(accounts[0].planType, 'plus')
})

test('the pool refuses duplicates of one credential, however they were added', () => {
  const config = configWithAccounts([
    { secret: 'refresh-a', email: null },
    { secret: 'refresh-a', email: null },
  ])
  assert.equal(getProviderAccounts(config, CODEX).length, 1)
  // Signing the same account in under two emails is one account too: the credential matches,
  // and two entries would rotate onto the same ChatGPT plan.
  const second = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-a', email: 'aliased@example.com' },
  ])
  assert.equal(getProviderAccounts(second, CODEX).length, 1)
})

// ── Signing out of one account ─────────────────────────────────────────────────────────

test('signing one account out leaves the other accounts signed in', () => {
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com', accountId: 'acct-a' },
    { secret: 'refresh-b', email: 'b@example.com', accountId: 'acct-b' },
    { secret: 'refresh-c', email: 'c@example.com', accountId: 'acct-c' },
  ])
  config.providers[CODEX].authEmail = 'c@example.com'

  const result = applyProviderSignOut(config, CODEX, 'b@example.com')
  assert.deepEqual(result, { removed: 1, remaining: 2 })
  assert.deepEqual(
    getProviderAccounts(config, CODEX).map(account => account.email),
    ['a@example.com', 'c@example.com'],
  )
  // The single-value display field followed the pool instead of still naming the account
  // that just left.
  assert.equal(config.providers[CODEX].authEmail, 'a@example.com')
})

test('an identifier that matches nothing signs nobody out', () => {
  // A typo must be reported, not rounded down to "you probably meant everyone else".
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  assert.deepEqual(applyProviderSignOut(config, CODEX, 'nobody@example.com'), { removed: 0, remaining: 2 })
  assert.equal(getProviderAccounts(config, CODEX).length, 2)
})

test('an account that reported no email is still removable by its credential', () => {
  // The dashboard signs such an account out by pool position, and the route resolves that
  // position back to this secret — otherwise it would be stuck in the pool forever, since it
  // has no email or workspace id for anything to match on.
  const config = configWithAccounts([
    { secret: 'refresh-a' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  assert.deepEqual(applyProviderSignOut(config, CODEX, 'refresh-a'), { removed: 1, remaining: 1 })
  assert.deepEqual(getProviderAccountSecrets(config, CODEX), ['refresh-b'])
})

test('adding a credential to a populated pool appends instead of replacing it', () => {
  // What saving a pasted refresh token does. This used to replace the pool, which was correct
  // while the field held the only credential and destructive once several were signed in.
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  addOrUpdateProviderAccount(config, CODEX, { secret: 'refresh-pasted' })
  assert.deepEqual(
    getProviderAccountSecrets(config, CODEX),
    ['refresh-a', 'refresh-b', 'refresh-pasted'],
  )
})

test('signing every account out is what clears the legacy credential and sign-in fields', () => {
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  Object.assign(config.providers[CODEX], { refreshToken: 'legacy-refresh', authEmail: 'a@example.com' })

  const partial = applyProviderSignOut(config, CODEX, 'a@example.com')
  assert.equal(partial.remaining, 1)
  // A leftover legacy field would resurrect the credential the user just signed out of, so it
  // is only cleared once the pool itself is empty.
  assert.equal(config.providers[CODEX].refreshToken, 'legacy-refresh')

  const rest = applyProviderSignOut(config, CODEX)
  assert.deepEqual(rest, { removed: 1, remaining: 0 })
  assert.equal(config.providers[CODEX].refreshToken, undefined)
  assert.equal(config.providers[CODEX].authMode, undefined)
  assert.equal(config.providers[CODEX].authEmail, undefined)
})

test('a legacy single-token config still signs out through the pool-less path', () => {
  // The pre-pool shape has no accounts array; Disconnect-all has to keep working on it.
  const config = { providers: { [CODEX]: { refreshToken: 'legacy-refresh', authMode: 'manual-token' } } }
  assert.deepEqual(applyProviderSignOut(config, CODEX), { removed: 0, remaining: 0 })
  assert.equal(config.providers[CODEX].refreshToken, undefined)
  assert.equal(config.providers[CODEX].authMode, undefined)
})

// ── Exhaustion order, and failing over off a spent account ──────────────────────────────

test('the first account serves until it is spent, and only then does the next take over', () => {
  // Deliberately not round-robin: the pool is a set of free-tier plans, and the point of one is
  // to use it up before touching the next. Round-robin would spend every plan at once and leave
  // nothing behind for the request after that.
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  const now = Date.now()
  const state = poolState(CODEX, [])
  const picks = [0, 1, 2, 3].map(() => selectCodexRefreshToken(config, now, state))
  assert.deepEqual(picks, ['refresh-a', 'refresh-a', 'refresh-a', 'refresh-a'])

  // Alice hits her plan limit: everything moves to Bob, and stays there.
  state.get(CODEX).accounts.set(0, { requests: 4, rateLimitedAt: now, exhaustedUntil: now + 60_000 })
  assert.deepEqual(
    [0, 1, 2].map(() => selectCodexRefreshToken(config, now, state)),
    ['refresh-b', 'refresh-b', 'refresh-b'],
  )
})

test('an account whose window has passed takes the traffic back', () => {
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  const now = Date.now()
  const state = poolState(CODEX, [[0, { requests: 0, rateLimitedAt: now, exhaustedUntil: now + 60_000 }]])
  assert.equal(selectCodexRefreshToken(config, now, state), 'refresh-b')
  // Once it recovers it is first in the pool again, so it is the one that serves.
  assert.equal(selectCodexRefreshToken(config, now + 61_000, state), 'refresh-a')
})

test('a provider that states when its limit lifts is believed over the local default', () => {
  // A daily quota and a per-minute burst window are not the same length. Benching a daily-quota
  // account for the local minute would bounce every request straight back onto it.
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  const now = Date.now()
  const dayMs = 20 * 60 * 60 * 1000
  const state = poolState(CODEX, [[0, { requests: 0, rateLimitedAt: now, exhaustedUntil: now + dayMs }]])
  assert.equal(selectCodexRefreshToken(config, now + 61_000, state), 'refresh-b')
  assert.equal(selectCodexRefreshToken(config, now + dayMs - 1, state), 'refresh-b')
  assert.equal(selectCodexRefreshToken(config, now + dayMs + 1, state), 'refresh-a')
})

test('a fully benched pool still answers instead of refusing the request', () => {
  // The bench window is an estimate built from what the provider reported. With nothing left
  // to try, asking a rate-limited account again beats telling the caller there is no account.
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  const now = Date.now()
  const state = poolState(CODEX, [
    [0, { requests: 0, rateLimitedAt: now }],
    [1, { requests: 0, rateLimitedAt: now }],
  ])
  assert.equal(selectCodexRefreshToken(config, now, state), 'refresh-a')
})

test('a single account is returned as-is, and no account at all falls back to the env var', () => {
  const single = configWithAccounts([{ secret: 'refresh-a', email: 'a@example.com' }])
  assert.equal(selectCodexRefreshToken(single, Date.now(), poolState(CODEX, [])), 'refresh-a')

  const previous = process.env.OPENAI_CODEX_REFRESH_TOKEN
  try {
    process.env.OPENAI_CODEX_REFRESH_TOKEN = 'refresh-env'
    // A single credential has nowhere to rotate, so a hand-configured one is still honoured
    // rather than being reported as "not signed in".
    assert.equal(selectCodexRefreshToken({ providers: {} }), 'refresh-env')
    delete process.env.OPENAI_CODEX_REFRESH_TOKEN
    assert.equal(selectCodexRefreshToken({ providers: {} }), null)
  } finally {
    if (previous === undefined) delete process.env.OPENAI_CODEX_REFRESH_TOKEN
    else process.env.OPENAI_CODEX_REFRESH_TOKEN = previous
  }
})

test('without a running server the selector degrades to the plain rotation', () => {
  // The CLI and this test file have no key-pool state; selection must still rotate instead of
  // throwing or pinning every request to the first account.
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  const picks = [0, 1, 2].map(() => selectCodexRefreshToken(config, Date.now(), null))
  assert.equal(new Set(picks).size, 2)
})

// ── What counts as a rotatable credential ──────────────────────────────────────────────

test('API keys are the rotatable pool when a provider has them, accounts otherwise', () => {
  // `getApiKeyPool` gives an environment variable precedence over config, by design, so the
  // key is cleared here rather than assuming the machine running the tests has none set.
  const previous = process.env.GROQ_API_KEY
  delete process.env.GROQ_API_KEY
  try {
    const withKeys = { apiKeys: { groq: ['k1', 'k2'] }, providers: {} }
    assert.deepEqual(rotatableCredentialPool(withKeys, 'groq'), ['k1', 'k2'])
    // Codex has no apiKeys entry at all — its credential lives in the account pool — and the
    // 429 path has to find it there or the bench silently does nothing.
    const withAccounts = configWithAccounts([
      { secret: 'refresh-a', email: 'a@example.com' },
      { secret: 'refresh-b', email: 'b@example.com' },
    ])
    assert.deepEqual(rotatableCredentialPool(withAccounts, CODEX), ['refresh-a', 'refresh-b'])
    // A provider with exactly one way in has nowhere to fail over to.
    assert.deepEqual(rotatableCredentialPool({ apiKeys: {}, providers: {} }, 'groq'), [])
  } finally {
    if (previous !== undefined) process.env.GROQ_API_KEY = previous
  }
})

test('the legacy single credential is still the last credential standing', () => {
  const config = { providers: { [CODEX]: { refreshToken: 'legacy-refresh' } } }
  assert.deepEqual(getProviderAccountSecrets(config, CODEX), ['legacy-refresh'])
  assert.deepEqual(rotatableCredentialPool(config, CODEX), ['legacy-refresh'])
})

test('removing one account does not disturb the ones that share its pool', () => {
  const config = configWithAccounts([
    { secret: 'refresh-a', email: 'a@example.com' },
    { secret: 'refresh-b', email: 'b@example.com' },
  ])
  assert.equal(removeProviderAccount(config, CODEX, 'a@example.com'), true)
  assert.deepEqual(getProviderAccountSecrets(config, CODEX), ['refresh-b'])
  assert.equal(removeProviderAccount(config, CODEX, 'a@example.com'), false)
  assert.deepEqual(getProviderAccountSecrets(config, CODEX), ['refresh-b'])
})
