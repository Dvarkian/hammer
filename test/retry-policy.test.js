/**
 * The policy the router spends before it blames a model.
 *
 * A transport failure is not evidence about a candidate: the request never got an answer.
 * These tests pin the two things that used to turn one `fetch failed` into a model change —
 * the same-model budget and the OpenCode 2s/4s/8s backoff that precedes each retry.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateRetryDelay,
  isRetryableTransportFailure,
  isTransientProxyStatus,
  shouldRetrySameModel,
} from '../lib/http/routes/proxy.js'

const firstFailure = {
  clientGone: false,
  sameModelTries: 1,
  retry: 0,
  attemptLimit: 5,
  retryable: true,
}

test('one fetch failure retries the same model rather than switching', () => {
  assert.equal(shouldRetrySameModel(firstFailure), true)
  // The fourth failure has spent the three-retry budget and may now fail over.
  assert.equal(shouldRetrySameModel({ ...firstFailure, sameModelTries: 4 }), false)
  // A client that already hung up is not retried, and neither is a configuration error.
  assert.equal(shouldRetrySameModel({ ...firstFailure, clientGone: true }), false)
  assert.equal(shouldRetrySameModel({ ...firstFailure, retryable: false }), false)
})

test('a transient HTTP status retries the same model; a verdict does not', () => {
  for (const status of [408, 500, 502, 503, 504]) {
    assert.equal(isTransientProxyStatus(status), true, String(status))
    assert.equal(
      shouldRetrySameModel({ ...firstFailure, retryable: isTransientProxyStatus(status) }),
      true,
      String(status),
    )
  }
  for (const status of [400, 401, 410, 429]) {
    assert.equal(isTransientProxyStatus(status), false, String(status))
  }
})

test('a fetch wrapper stays retryable even when its cause names a socket error', () => {
  const wrapped = new TypeError('fetch failed')
  wrapped.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
    code: 'ENOTFOUND',
  })
  assert.equal(isRetryableTransportFailure(wrapped), true)

  // Without the wrapper, those codes really are a configuration answer.
  assert.equal(
    isRetryableTransportFailure(new Error('getaddrinfo ENOTFOUND api.example.com')),
    false,
  )
  assert.equal(isRetryableTransportFailure(new Error('connect ECONNREFUSED 127.0.0.1:9')), false)
})

test('timeouts and resets are retryable transport failures', () => {
  assert.equal(
    isRetryableTransportFailure(
      Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
    ),
    true,
  )
  assert.equal(isRetryableTransportFailure(new Error('socket hang up (ECONNRESET)')), true)
  assert.equal(isRetryableTransportFailure(new Error('network error')), true)
})

test('the retry delay follows the OpenCode 2s/4s/8s schedule with jitter', () => {
  assert.equal(calculateRetryDelay(0), 0)
  // 25% jitter around 2s, 4s and 8s; the cap is 8s.
  const ranges = [
    [1750, 2250],
    [3500, 4500],
    [7000, 9000],
  ]
  for (const [index, [low, high]] of ranges.entries()) {
    for (let sample = 0; sample < 20; sample += 1) {
      const delay = calculateRetryDelay(index + 1)
      assert.ok(delay >= low && delay <= high, `${delay}ms outside ${low}-${high}ms`)
    }
  }
  assert.ok(calculateRetryDelay(4) <= 9000)
})
