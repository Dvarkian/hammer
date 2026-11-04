/**
 * Tests for the shared transport-failure classifier.
 *
 * The pattern set is compiled into one RegExp at import time, so a malformed entry does not
 * break one match — it breaks every module that imports this file (the pi bridge, the proxy),
 * at load, in every test file that touches them. That is exactly how an unbalanced parenthesis
 * once sat unnoticed in a committed tree: nothing imported the module yet. These tests keep the
 * set loadable and pin the verdicts both callers rely on: a dropped connection reads as
 * retryable, a verdict about the request does not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { autoRetryNote, isTransportStreamFailure } from '../lib/stream-failure.js'

test('transport-shaped failures read as retryable', () => {
  // The generic shapes pi-ai itself emits, the relay's resets, and the provider-side capacity
  // words — each of these must survive to the next candidate rather than end the turn.
  for (const text of [
    'Connection error.',
    'fetch failed',
    'socket hang up (ECONNRESET)',
    'getaddrinfo ENOTFOUND api.example.com',
    // The literal the parenthesised entry pins, and the reason it needs the escape.
    'stream terminated (ETIMEDOUT)',
    'upstream connect error or disconnect/reset before headers',
    // The relay's own words for a stream that ended before the agent answered: the agent
    // decides whether to continue the turn from this text, so it must read as transport.
    'Stream interrupted before the agent answered',
    'Upstream stream stalled (idle timeout).',
  ]) {
    assert.equal(isTransportStreamFailure(text), true, JSON.stringify(text))
  }
})

test('a numeric or object status outranks the body text', () => {
  // "503: {...}" is unambiguous even when the body inside is about something else, and the
  // relay hands over plain numbers as often as wrapped ones.
  assert.equal(isTransportStreamFailure(503), true)
  assert.equal(isTransportStreamFailure({ status: 502, message: 'anything' }), true)
  assert.equal(isTransportStreamFailure(400), false)
})

test('a verdict about the request does not read as retryable', () => {
  // These are answers, not dropped connections: repeating them is asking again with a
  // different name, so the bridge must hand the turn back to the user instead.
  for (const text of [
    'The model refused to answer this request.',
    'insufficient_quota: You exceeded your current quota.',
    'content_policy_violation',
    'The user cancelled the run.',
  ]) {
    assert.equal(isTransportStreamFailure(text), false, JSON.stringify(text))
  }
})

test('the retry note names the attempt only once past the first', () => {
  // A reader watching the console should learn a retry happened and which one it is, without
  // "attempt 1 of 1" noise on the first failure.
  assert.equal(autoRetryNote(), 'Retrying after a transport failure.')
  assert.equal(
    autoRetryNote({ attempt: 2, of: 3 }),
    'Retrying after a transport failure (attempt 2 of 3).',
  )
})
