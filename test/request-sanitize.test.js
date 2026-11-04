/**
 * Outbound field healing: the router forwards a caller's body, so a field one model refuses
 * must be dropped for that model rather than failing the turn.
 *
 * The case that prompted these: the Pi console asks for a thinking level, so every request
 * carries `reasoning_effort`, and Hammer routes across models. A model that cannot take it
 * answers `400 {"message":"`reasoning_effort` is not supported with this model"}`, which the
 * parser did not recognise — so the turn died instead of being repaired.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLearnedStrips,
  getLearnedStrips,
  isHealableFieldRejection,
  parseRejectedFields,
  recordLearnedStrips,
  sanitizeProviderPayload,
  stripFields,
} from '../lib/request-sanitize.js'

const NIM_REFUSAL =
  '{"message":"`reasoning_effort` is not supported with this model","type":"invalid_request_error"}'

test('a backticked field refused for the model is recognised', () => {
  const parsed = parseRejectedFields(NIM_REFUSAL)
  assert.deepEqual(parsed.fields, ['reasoning_effort'])
  assert.equal(parsed.rejectsUnknownFields, false, 'a named field is not an unknown-extras refusal')
  assert.equal(isHealableFieldRejection(parsed), true)
})

test('the same refusal phrased from the other side is recognised', () => {
  for (const text of [
    'This model does not support `reasoning_effort`.',
    "This model doesn't support `reasoning_effort`.",
    'The model does not support the "reasoning_effort" parameter',
  ]) {
    const parsed = parseRejectedFields(text)
    assert.deepEqual(parsed.fields, ['reasoning_effort'], text)
  }
})

test('a quoted capability is not mistaken for a field', () => {
  // NVIDIA phrases a missing capability the same way it phrases a refused field. Stripping a
  // field named "tool calling" would rewrite the request for nothing; the capability refusal
  // has to stay a failover.
  const parsed = parseRejectedFields(
    '{"message":"`tool calling` is not supported with this model","type":"invalid_request_error"}',
  )
  assert.deepEqual(parsed.fields, [])
  assert.equal(isHealableFieldRejection(parsed), false)
})

test('the field is removed from the body without touching the request', () => {
  const body = {
    model: 'a-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash' } }],
    reasoning_effort: 'medium',
    max_tokens: 512,
  }
  const parsed = parseRejectedFields(NIM_REFUSAL)
  const healed = stripFields(body, parsed)
  assert.deepEqual(healed.stripped, ['reasoning_effort'])
  assert.equal('reasoning_effort' in healed.body, false)
  assert.equal(healed.body.max_tokens, 512)
  assert.deepEqual(healed.body.tools, body.tools)
  assert.deepEqual(healed.body.messages, body.messages)
})

test('the whole sanitizer heals on the rejection it is given', () => {
  const body = {
    model: 'a-model',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
  }
  const healed = sanitizeProviderPayload(
    body,
    'some-provider',
    createLearnedStrips({}),
    parseRejectedFields(NIM_REFUSAL),
  )
  assert.deepEqual(healed.stripped, ['reasoning_effort'])
  assert.equal('reasoning_effort' in healed.body, false)
})

test('a refusal learned once is not paid for again on that provider', () => {
  const learned = createLearnedStrips({})
  recordLearnedStrips(learned, 'some-provider', parseRejectedFields(NIM_REFUSAL))
  assert.deepEqual(getLearnedStrips(learned, 'some-provider').fields, ['reasoning_effort'])

  const body = { model: 'a-model', messages: [], reasoning_effort: 'high' }
  const clean = sanitizeProviderPayload(body, 'some-provider', learned)
  assert.equal('reasoning_effort' in clean.body, false, 'the next turn is clean up front')

  // Another provider is unaffected: learning is per upstream, because that is what refused.
  const other = sanitizeProviderPayload(body, 'another-provider', learned)
  assert.equal(other.body.reasoning_effort, 'high')
})

test('the refusals the parser already knew still parse', () => {
  // Groq: an unknown message key, scoped to the message.
  const groq = parseRejectedFields(
    "{\"error\":{\"message\":\"'messages.3' : for 'role:assistant' the following must be satisfied[('messages.3' : property 'reasoning_content' is unsupported)]\"}}",
  )
  assert.deepEqual(groq.fields, ['reasoning_content'])
  assert.deepEqual(groq.messageScoped, ['reasoning_content'])

  // OpenAI: unnamed extras.
  const openai = parseRejectedFields(
    '{"error":{"message":"Unrecognized request argument supplied: logit_bias"}}',
  )
  assert.deepEqual(openai.fields, ['logit_bias'])

  // pydantic: no name at all, so message keys outside the contract are what it refused.
  const unnamed = parseRejectedFields('{"detail":[{"type":"extra_forbidden"}]}')
  assert.equal(unnamed.rejectsUnknownFields, true)
  assert.equal(isHealableFieldRejection(unnamed), true)
})

test('a malformed tool call replayed from history is repaired before it poisons the session', () => {
  // The concrete failure: a model emitted a call whose arguments were the bare word
  // "command". Pi executed it (the tool answered "Tool tool not found"), then replayed the
  // turn on every later request, and NIM rejected the whole conversation with
  // `messages[38].tool_calls[2].function.arguments must be a valid JSON object string`.
  const body = {
    model: 'a-model',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          { id: 'c2', type: 'function', function: { name: 'tool', arguments: 'command' } },
          { id: 'c3', type: 'function', function: { name: 'tool', arguments: '' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c2', content: 'Tool tool not found' },
    ],
  }

  const healed = sanitizeProviderPayload(body, 'nvidia', createLearnedStrips({}))
  const calls = healed.body.messages[1].tool_calls
  assert.equal(calls[0].function.arguments, '{"command":"ls"}', 'valid arguments are untouched')
  assert.equal(calls[1].function.arguments, '{}', 'a bare word becomes an empty object')
  assert.equal(calls[2].function.arguments, '{}', 'empty text becomes an empty object')
  assert.deepEqual(healed.stripped, ['tool_call_arguments'], 'the rewrite is disclosed')
  assert.equal(
    body.messages[1].tool_calls[1].function.arguments,
    'command',
    'the caller body is not mutated',
  )
})
