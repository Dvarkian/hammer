import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createToolCallRecoveryStreamFilter,
  recoverChatCompletionToolCalls,
  recoverSerializedToolCalls,
  toolNamesFromRequest,
} from '../lib/tool-call-recovery.js'

/** The block a route wrote into `content` in session 01a1f1f1, byte for byte. */
const LEAKED =
  '{"tool_calls":[{"id":"call_00_waitall","type":"function","function":{"name":"subagent","arguments":"{\\"action\\":\\"wait\\",\\"id\\":\\"sa_ca803c4a\\",\\"wait_ms\\":600000}"}}]}'

const REQUEST = {
  tools: [
    { type: 'function', function: { name: 'subagent' } },
    { type: 'function', function: { name: 'web_search' } },
  ],
}

const allowed = () => toolNamesFromRequest(REQUEST)

/** One SSE line as a provider wrote it. */
const frame = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'best',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

/** Feeds a whole SSE body in small chunks, so a frame boundary lands mid-token. */
const runStream = (filter, sse, size = 7) => {
  let out = ''
  for (let index = 0; index < sse.length; index += size) {
    out += filter.push(sse.slice(index, index + size))
  }
  return out + filter.flush()
}

const outputFrames = (out) =>
  out
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter((text) => text && text !== '[DONE]')
    .map((text) => JSON.parse(text))

const outputContent = (out) =>
  outputFrames(out)
    .map((entry) => entry.choices?.[0]?.delta?.content)
    .filter((text) => typeof text === 'string')
    .join('')

test('the tool names a request offered, and nothing when it offered none', () => {
  assert.deepEqual([...toolNamesFromRequest(REQUEST)], ['subagent', 'web_search'])
  assert.equal(toolNamesFromRequest({}), null)
  assert.equal(toolNamesFromRequest({ tools: [] }), null)
  // A tool without a name is not something a call could name.
  assert.equal(toolNamesFromRequest({ tools: [{ type: 'function', function: {} }] }), null)
})

test('a call serialized into the answer is split off, keeping the answer', () => {
  const content = `Good reconnaissance so far. Now let me collect the subagent findings.\n\n${LEAKED}`
  const recovered = recoverSerializedToolCalls(content, allowed())
  assert.ok(recovered)
  assert.equal(
    recovered.text,
    'Good reconnaissance so far. Now let me collect the subagent findings.',
  )
  assert.equal(recovered.toolCalls.length, 1)
  const call = recovered.toolCalls[0]
  assert.equal(call.id, 'call_00_waitall')
  assert.equal(call.type, 'function')
  assert.equal(call.function.name, 'subagent')
  assert.deepEqual(JSON.parse(call.function.arguments), {
    action: 'wait',
    id: 'sa_ca803c4a',
    wait_ms: 600000,
  })
})

test('a request with no tools has no call to recover', () => {
  assert.equal(recoverSerializedToolCalls(LEAKED, null), null)
  assert.equal(recoverSerializedToolCalls(LEAKED, toolNamesFromRequest({})), null)
})

test('the legacy single function_call shape is recovered too', () => {
  const content =
    'Checking the weather.\n{"function_call":{"name":"web_search","arguments":{"q":"x"}}}'
  const recovered = recoverSerializedToolCalls(content, allowed())
  assert.equal(recovered.text, 'Checking the weather.')
  assert.equal(recovered.toolCalls[0].function.name, 'web_search')
  assert.equal(recovered.toolCalls[0].function.arguments, '{"q":"x"}')
})

test('an answer that merely discusses the JSON is left alone', () => {
  // A name the request never offered: this is a quotation, not a call.
  const foreign = '{"tool_calls":[{"function":{"name":"run_terminal_command","arguments":"{}"}}]}'
  assert.equal(recoverSerializedToolCalls(`The client sends ${foreign}`, allowed()), null)
  // A real name, but the answer carries on afterwards — so it is not the turn's call.
  assert.equal(
    recoverSerializedToolCalls(`${LEAKED}\n\nThat is the shape Pi expects.`, allowed()),
    null,
  )
  // Prose braces never throw the scan off.
  assert.equal(recoverSerializedToolCalls('Use {curly} braces.', allowed()), null)
})

test('a non-streamed body comes back with the call and the right finish reason', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'best',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: `Seven researchers are running.\n\n${LEAKED}` },
      },
    ],
  })
  const out = JSON.parse(recoverChatCompletionToolCalls(body, allowed()))
  const choice = out.choices[0]
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(choice.message.content, 'Seven researchers are running.')
  assert.equal(choice.message.tool_calls[0].function.name, 'subagent')
  // A body with nothing to recover is returned byte for byte.
  const plain = JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: 'all done' } }],
  })
  assert.equal(recoverChatCompletionToolCalls(plain, allowed()), plain)
})

test('a streamed call is delivered as a call, not as answer text', () => {
  const sse =
    frame({ role: 'assistant', content: '' }) +
    frame({ content: 'Good reconnaissance so far. ' }) +
    frame({ content: 'Now let me collect the subagent findings.\n\n' }) +
    frame({ content: LEAKED }) +
    frame({}, 'stop') +
    'data: [DONE]\n\n'
  const out = runStream(createToolCallRecoveryStreamFilter(allowed()), sse)
  const content = outputContent(out)
  // The blank line before the block was already answer text when the `{` arrived, and a stream
  // cannot take back what it has sent. Only the block itself is withheld.
  assert.equal(content, 'Good reconnaissance so far. Now let me collect the subagent findings.\n\n')
  const calls = outputFrames(out).flatMap((entry) => entry.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].index, 0)
  assert.equal(calls[0].function.name, 'subagent')
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    action: 'wait',
    id: 'sa_ca803c4a',
    wait_ms: 600000,
  })
  const finishes = outputFrames(out).map((entry) => entry.choices?.[0]?.finish_reason)
  assert.equal(finishes.filter(Boolean).at(-1), 'tool_calls')
  assert.equal(finishes.filter((reason) => reason === 'stop').length, 0)
  // The turn's own usage is not lost to the rewrite.
  assert.ok(out.trimEnd().endsWith('data: [DONE]'))
})

test('prose sharing a frame with the envelope is kept, the block is not', () => {
  // One frame carrying both: the answer is already on the wire before the `{` is judged, so the
  // frame is split rather than dropped.
  const sse =
    frame({ content: `Seven researchers are running.\n\n${LEAKED}` }) +
    frame({}, 'stop') +
    'data: [DONE]\n\n'
  const out = runStream(createToolCallRecoveryStreamFilter(allowed()), sse)
  assert.equal(outputContent(out), 'Seven researchers are running.\n\n')
  const calls = outputFrames(out).flatMap((entry) => entry.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, 'subagent')
})

test('a held run that turns out not to be a call gives every byte back', () => {
  // A real tool name, at the end — but the answer is a doc example the request was not making a
  // call with, which is why the name check is the gate. Nothing may be swallowed.
  const sse =
    frame({ content: 'The shape is\n\n' }) +
    frame({
      content: '{"tool_calls":[{"function":{"name":"run_terminal_command","arguments":"{}"}}]}',
    }) +
    frame({}, 'stop') +
    'data: [DONE]\n\n'
  const out = runStream(createToolCallRecoveryStreamFilter(allowed()), sse)
  assert.equal(
    outputContent(out),
    'The shape is\n\n' +
      '{"tool_calls":[{"function":{"name":"run_terminal_command","arguments":"{}"}}]}',
  )
  assert.equal(
    outputFrames(out).some((entry) => entry.choices?.[0]?.delta?.tool_calls),
    false,
  )
})

test('a stream with no envelope passes through untouched', () => {
  const sse =
    frame({ role: 'assistant', content: '' }) +
    frame({ content: 'Here is the plan: ' }) +
    frame({ content: 'read the {file} and report.' }) +
    frame({}, 'stop') +
    'data: [DONE]\n\n'
  const out = runStream(createToolCallRecoveryStreamFilter(allowed()), sse)
  assert.equal(out, sse)
})

test('a bare name-and-arguments call is recovered, not reported as prose', () => {
  // The block a research child's report contained on 2026-11-19: Anthropic's shape, no
  // `tool_calls` wrapper, written into the answer where a delivered call belonged.
  const content =
    'Let me search for that.\n\n{"name":"web_search","arguments":{"query":"paper roads","num_results":8}}'
  const recovered = recoverSerializedToolCalls(content, allowed())
  assert.ok(recovered)
  assert.equal(recovered.text, 'Let me search for that.')
  assert.equal(recovered.toolCalls.length, 1)
  assert.equal(recovered.toolCalls[0].function.name, 'web_search')
  assert.deepEqual(JSON.parse(recovered.toolCalls[0].function.arguments), {
    query: 'paper roads',
    num_results: 8,
  })
  // Some relays spell the argument field `parameters`.
  const viaParameters = recoverSerializedToolCalls(
    '{"name":"web_search","parameters":{"q":"stock routes"}}',
    allowed(),
  )
  assert.equal(viaParameters.toolCalls[0].function.arguments, '{"q":"stock routes"}')
  // The name gate still applies: a tool the request never offered is a quotation, and an
  // object with no arguments is not a call.
  assert.equal(recoverSerializedToolCalls('{"name":"computer","arguments":{}}', allowed()), null)
  assert.equal(recoverSerializedToolCalls('{"name":"web_search"}', allowed()), null)
})

test('a streamed bare call is delivered as a call, and a body agrees', () => {
  const bare = '{"name":"web_search","arguments":{"query":"stock routes"}}'
  const sse =
    frame({ content: 'Searching. ' }) +
    frame({ content: bare }) +
    frame({}, 'stop') +
    'data: [DONE]\n\n'
  const out = runStream(createToolCallRecoveryStreamFilter(allowed()), sse)
  assert.equal(outputContent(out), 'Searching. ')
  const calls = outputFrames(out).flatMap((entry) => entry.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, 'web_search')
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { query: 'stock routes' })

  const body = JSON.stringify({
    id: 'chatcmpl-1',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: `Searching. ${bare}` },
      },
    ],
  })
  const recovered = JSON.parse(recoverChatCompletionToolCalls(body, allowed()))
  assert.equal(recovered.choices[0].finish_reason, 'tool_calls')
  assert.equal(recovered.choices[0].message.content, 'Searching.')
  assert.equal(recovered.choices[0].message.tool_calls[0].function.name, 'web_search')
})
