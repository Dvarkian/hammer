/**
 * A relayed provider error has to reach the caller in the envelope its SDK reads.
 *
 * The case that prompted this: NIM refused one message in Pi's history with
 * `{"message":"Validation: ...","type":"Bad Request","code":400}`. The raw body was
 * forwarded, but the OpenAI SDK looks for a top-level `error`, found none, and reported
 * "400 status code (no body)" — hiding the sentence that named the broken message.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeErrorEnvelope } from '../lib/error-envelope.js'

test('a bare provider message is wrapped in the OpenAI error envelope', () => {
  const normalized = normalizeErrorEnvelope(
    '{"message":"Validation: messages[1].tool_calls[2].function.arguments must be a valid JSON object string","type":"Bad Request","code":400}',
  )
  assert.ok(normalized, 'the body is recognized as a provider error')
  const parsed = JSON.parse(normalized)
  assert.match(parsed.error.message, /must be a valid JSON object string/)
  assert.equal(parsed.error.type, 'Bad Request')
  assert.equal(parsed.error.code, 400)
})

test('an error body the SDK can already read is relayed unchanged', () => {
  for (const body of ['{"error":{"message":"rate limited"}}', '{"error":"plain string form"}']) {
    assert.equal(normalizeErrorEnvelope(body), null, body)
  }
})

test('anything that is not a JSON object with a message is left alone', () => {
  for (const body of [
    '',
    'Bad Gateway',
    '<html>upstream error</html>',
    '[{"message":"an array is not an envelope"}]',
    '{"type":"Bad Request","code":400}',
  ]) {
    assert.equal(normalizeErrorEnvelope(body), null, JSON.stringify(body))
  }
})
