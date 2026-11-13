import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NO_INTERNET_MESSAGE,
  everyAttemptLostConnection,
  isNoInternetCode,
  isNoInternetFailure,
} from '../lib/connectivity.js'

// ── Reading a failure that never left the machine ───────────────────────────────────────
//
// From the router's side a missing link and a provider that will not answer look the same: a
// request that produced no response. Only one of them is the reader's to fix, and the router used
// to answer both with "No models currently available for this request." — which is how a machine
// with no internet sent someone hunting for a broken provider.

test('codes that can only mean the machine has no path to the network', () => {
  for (const code of [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NAME_NOT_RESOLVED',
  ]) {
    assert.equal(isNoInternetCode(code), true, code)
    assert.equal(isNoInternetCode(code.toLowerCase()), true, `${code} in any case`)
  }
})

test('a refusal, a reset and a timeout are about the provider, not the connection', () => {
  // Each of these means something answered on the other side — a closed port, a dropped stream,
  // a provider that is merely slow. Blaming the user's internet for them is the mistake in
  // reverse, and it hides a provider the router should be avoiding.
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EACCES', '']) {
    assert.equal(isNoInternetCode(code), false, code || '(empty)')
  }
  assert.equal(isNoInternetCode(null), false)
  assert.equal(isNoInternetCode(undefined), false)
})

test('the message alone is enough when the code did not survive the wrapper', () => {
  // undici reduces every transport failure to "fetch failed"; the cause is what carries the DNS
  // error, and by the time a proxy attempt records it only the text may be left.
  assert.equal(isNoInternetFailure('fetch failed: getaddrinfo ENOTFOUND api.example.com'), true)
  assert.equal(isNoInternetFailure({ message: 'getaddrinfo EAI_AGAIN api.example.com' }), true)
  assert.equal(isNoInternetFailure({ message: 'Network is unreachable' }), true)
  assert.equal(isNoInternetFailure({ code: 'ENETUNREACH', message: 'fetch failed' }), true)
  // A bare "fetch failed" is a transport failure of some kind and nothing more.
  assert.equal(isNoInternetFailure({ message: 'fetch failed' }), false)
  assert.equal(isNoInternetFailure({ message: 'This operation was aborted' }), false)
  assert.equal(isNoInternetFailure(null), false)
})

test('only a set of attempts that all lost the connection reads as an outage', () => {
  const lost = { status: 'ERR', code: 'ENOTFOUND', error: 'fetch failed' }
  const lostAgain = { status: 'ERR', code: 'ENETUNREACH', error: 'fetch failed' }
  const refused = { status: 'ERR', message: 'fetch failed', error: 'fetch failed' }
  const noKey = { status: 'NO_KEY', error: 'No API key configured for provider x.' }
  const timedOut = { status: 'ERR', error: 'This operation was aborted' }

  assert.equal(everyAttemptLostConnection([lost, lostAgain]), true)
  // One provider that was actually reached means the link works; the others failed for their own
  // reasons and the answer must stay about models.
  assert.equal(everyAttemptLostConnection([lost, refused]), false)
  assert.equal(everyAttemptLostConnection([lost, noKey]), false)
  assert.equal(everyAttemptLostConnection([lost, timedOut]), false)
  // A request that never tried anything is an empty plan, not an outage.
  assert.equal(everyAttemptLostConnection([]), false)
  assert.equal(everyAttemptLostConnection(null), false)
})

test('the answer names the connection and is not another way of saying "no models"', () => {
  assert.match(NO_INTERNET_MESSAGE, /No internet connection/)
  assert.doesNotMatch(NO_INTERNET_MESSAGE, /no models/i)
  // It says what to do next, because the reader is the one who can do it.
  assert.match(NO_INTERNET_MESSAGE, /Check the connection/)
})

test('the router uses the classification instead of answering an outage with "no models"', () => {
  const proxy = readFileSync(new URL('../lib/http/routes/proxy.js', import.meta.url), 'utf8')
  // The attempt keeps its transport code: without it the answer cannot tell an unreachable fleet
  // from a machine with no link, because every message is "fetch failed".
  assert.match(proxy, /attemptMeta\.code = String\(err\?\.cause\?\.code \|\| err\?\.code \|\| ''\)/)
  // An outage benches nothing: the providers did nothing wrong, and a cooldown would outlive the
  // link that failed.
  assert.match(proxy, /if \(!lostConnection\) \{\s*noteProviderUnreachable\(/)
  assert.match(proxy, /evidence: !lostConnection,/)
  // And the final response carries the message and a code a client can branch on.
  assert.match(proxy, /lostConnection \? \{ code: 'no-internet' \} : \{\}/)
  assert.match(proxy, /logEntry\.code = 'no-internet'/)
})
