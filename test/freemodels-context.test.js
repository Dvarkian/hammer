import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createFreeModelsConversationStore,
  extractFreeModelsAssistantMessage,
  packFreeModelsMessages,
} from '../lib/freemodels-context.js'
import { buildProviderRequestBody, transformFreeModelsResponse } from '../lib/server.js'
import { getProvider } from '../lib/providers/index.js'
import { normalizeDescriptor, validateDescriptor } from '../lib/providers/schema.js'

test('FreeModels advertises its relay capabilities in the provider descriptor', () => {
  const provider = getProvider('freemodels')
  assert.equal(provider.continuity, 'local-transcript')
  assert.equal(provider.toolSupport, 'best-effort')
})

test('invalid capability claims are rejected instead of becoming optimistic defaults', () => {
  const descriptor = normalizeDescriptor('broken', { continuity: 'session-guess', toolSupport: 'maybe' })
  assert.deepEqual(validateDescriptor(descriptor).filter(problem => problem.includes('continuity') || problem.includes('toolSupport')), [
    'invalid continuity "session-guess"',
    'invalid toolSupport "maybe"',
  ])
})

test('FreeModels context keeps system turns and the newest conversational window', () => {
  const messages = [
    { role: 'system', content: 'system contract' },
    { role: 'developer', content: 'developer contract' },
    ...Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` })),
  ]

  const packed = packFreeModelsMessages(messages)
  assert.equal(packed.filter(message => message.role === 'system' || message.role === 'developer').length, 2)
  assert.equal(packed.length, 40)
  assert.equal(packed.at(-1).content, 'turn 59')
  assert.equal(packed.some(message => message.content === 'system contract'), true)
  assert.equal(packed.some(message => message.content === 'turn 0'), false)
})

test('FreeModels context keeps instruction turns in their original transcript positions', () => {
  const packed = packFreeModelsMessages([
    { role: 'user', content: 'old user' },
    { role: 'developer', content: 'mid-conversation instruction' },
    { role: 'user', content: 'new user' },
    { role: 'assistant', content: 'new assistant' },
    { role: 'developer', content: 'latest instruction' },
  ], { maxMessages: 4, maxBytes: 4096 })

  assert.deepEqual(packed.map(message => message.content), [
    'mid-conversation instruction',
    'new user',
    'new assistant',
    'latest instruction',
  ])
  assert.deepEqual(packFreeModelsMessages([{ role: 'user', content: 'drop' }], { maxMessages: 0 }), [])

  const instructionOnly = packFreeModelsMessages(
    Array.from({ length: 5 }, (_, index) => ({ role: 'system', content: `instruction ${index}` })),
    { maxMessages: 3, maxBytes: 4096 },
  )
  assert.deepEqual(instructionOnly.map(message => message.content), ['instruction 2', 'instruction 3', 'instruction 4'])
})

test('FreeModels context enforces its byte cap even for oversized instructions', () => {
  const [system] = packFreeModelsMessages([
    { role: 'system', content: 'x'.repeat(10_000) },
  ], { maxMessages: 40, maxBytes: 200 })

  assert.ok(system)
  assert.ok(system.content.length > 0)
  assert.ok(Buffer.byteLength(JSON.stringify([system])) <= 200)
})

test('FreeModels context preserves tool activity as text instead of dropping it', () => {
  const [message] = packFreeModelsMessages([{
    role: 'assistant',
    content: 'I will inspect the file.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
  }])

  assert.match(message.content, /read_file/)
  assert.match(message.content, /README\.md/)
  assert.equal(message.tool_calls, undefined)

  const [legacy] = packFreeModelsMessages([{
    role: 'assistant',
    function_call: { name: 'lookup', arguments: '{"q":"hammer"}' },
  }])
  assert.match(legacy.content, /function_call name=lookup/)
  assert.match(legacy.content, /hammer/)
})

test('an explicit conversation store reconstructs short continuations without guessing', () => {
  let now = 100
  const store = createFreeModelsConversationStore({ now: () => now, ttlMs: 50 })
  const first = store.merge('thread-a', [{ role: 'user', content: 'first' }])
  store.appendAssistant('thread-a', { role: 'assistant', content: 'answer' })
  const continued = store.merge('thread-a', [{ role: 'user', content: 'second' }])

  assert.deepEqual(first.map(message => message.content), ['first'])
  assert.deepEqual(continued.map(message => message.content), ['first', 'answer', 'second'])
  store.appendAssistant('thread-a', { role: 'assistant', content: 'answer two' })
  assert.deepEqual(store.merge('thread-a', [{ role: 'user', content: 'second' }]).map(message => message.content), ['first', 'answer', 'second', 'answer two'])
  assert.deepEqual(store.merge('thread-a', [{ role: 'user', content: 'unrelated thread' }, { role: 'assistant', content: 'new topic' }]).map(message => message.content), ['unrelated thread', 'new topic'])

  now = 151
  assert.deepEqual(store.get('thread-a'), [])
  assert.equal(store.merge('thread-b', [{ role: 'user', content: 'new' }]).length, 1)
})

test('a full transcript is authoritative and a repeated short turn is not duplicated', () => {
  const store = createFreeModelsConversationStore()
  const original = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ]
  store.merge('thread', original)
  assert.deepEqual(store.merge('thread', original), original)
  assert.deepEqual(store.merge('thread', [{ role: 'user', content: 'three' }]), [
    ...original,
    { role: 'user', content: 'three' },
  ])
  assert.deepEqual(store.merge('thread', [{ role: 'user', content: 'three' }]), [
    ...original,
    { role: 'user', content: 'three' },
  ])
})

test('overlapping turns record replies in conversation order, not completion order', () => {
  const store = createFreeModelsConversationStore()
  const first = store.beginTurn('thread', [{ role: 'user', content: 'first' }])
  const second = store.beginTurn('thread', [{ role: 'user', content: 'second' }])

  // The second upstream response wins the race, but its answer still belongs after
  // the second user turn rather than at the store's then-current tail.
  store.appendAssistant('thread', { content: 'answer two' }, second.turnId)
  store.appendAssistant('thread', { content: 'answer one' }, first.turnId)

  assert.deepEqual(store.get('thread'), [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer two' },
  ])
})

test('a superseded in-flight turn cannot append into an unrelated replacement transcript', () => {
  const store = createFreeModelsConversationStore()
  const oldTurn = store.beginTurn('thread', [{ role: 'user', content: 'old topic' }])
  store.merge('thread', [
    { role: 'user', content: 'replacement topic' },
    { role: 'assistant', content: 'replacement answer' },
  ])
  store.appendAssistant('thread', { content: 'late old answer' }, oldTurn.turnId)
  assert.deepEqual(store.get('thread'), [
    { role: 'user', content: 'replacement topic' },
    { role: 'assistant', content: 'replacement answer' },
  ])
})

test('the local conversation store bounds both message count and packed size', () => {
  const store = createFreeModelsConversationStore({ maxMessages: 5, maxBytes: 180 })
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message-${index}-${'x'.repeat(30)}`,
  }))
  const packed = store.merge('bounded', messages)
  assert.ok(packed.length < 5)
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) <= 180)
  assert.equal(packed.at(-1).content, messages.at(-1).content)
})

test('FreeModels response translation retains native tool calls and rejects empty successes', async () => {
  const raw = [
    'data: {"id":"x","model":"nvidia/nemotron","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"blue\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const translated = await transformFreeModelsResponse(new Response(raw, { status: 200 }), 'terra', false)
  const body = await translated.json()
  assert.equal(translated.status, 200)
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'lookup')
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"q":"blue"}')
  assert.equal(body.choices[0].finish_reason, 'tool_calls')

  const empty = await transformFreeModelsResponse(new Response('data: [DONE]\n\n', { status: 200 }), 'terra', false)
  assert.equal(empty.status, 503)
  const emptyStream = await transformFreeModelsResponse(
    new Response('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    'terra',
    true,
  )
  assert.equal(emptyStream.status, 503)
  const bodylessStream = await transformFreeModelsResponse(
    new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    'terra',
    true,
  )
  assert.equal(bodylessStream.status, 503)

  const blankJson = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: ' \n\t' }, finish_reason: 'stop' }],
  })
  assert.equal((await transformFreeModelsResponse(
    new Response(blankJson, { status: 200 }), 'terra', false,
  )).status, 503)
  assert.equal((await transformFreeModelsResponse(
    new Response(`data: ${blankJson}\n\ndata: [DONE]\n\n`, { status: 200 }), 'terra', true,
  )).status, 503)
  for (const malformedToolFrame of [
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{}] } }] },
    { choices: [{ message: { role: 'assistant', content: '', function_call: {} } }] },
  ]) {
    assert.equal((await transformFreeModelsResponse(
      new Response(JSON.stringify(malformedToolFrame), { status: 200 }), 'terra', false,
    )).status, 503)
  }

  const direct = await transformFreeModelsResponse(new Response(JSON.stringify({
    id: 'direct-json',
    model: 'upstream/model',
    choices: [{ message: { role: 'assistant', content: 'direct answer' }, finish_reason: 'stop' }],
  }), { status: 200 }), 'terra', false)
  const directBody = await direct.json()
  assert.equal(directBody.id, 'direct-json')
  assert.equal(directBody.model, 'upstream/model')
  assert.equal(directBody.choices[0].message.content, 'direct answer')

  const streamed = await transformFreeModelsResponse(new Response([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"streamed"}}]}',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }), 'terra', true)
  assert.equal(streamed.status, 200)
  assert.match(await streamed.text(), /streamed/)
})

test('FreeModels stream peeking preserves the exact upstream bytes across chunk boundaries', async () => {
  const source = ': keep-alive\r\n\r\n'
    + 'data: {"choices":[{"delta":{"role":"assistant","content":"hello"}}]}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n'
  const bytes = new TextEncoder().encode(source)
  for (const split of [1, 2, bytes.length - 1]) {
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split))
        controller.enqueue(bytes.slice(split))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const transformed = await transformFreeModelsResponse(upstream, 'terra', true)
    assert.equal(transformed.status, 200)
    assert.deepEqual(new Uint8Array(await transformed.arrayBuffer()), bytes)
  }
})

test('the live FreeModels builder keeps tools and uses the bounded role/content transcript', () => {
  const body = {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{ type: 'function', function: { name: 'lookup' } }],
    tool_choice: 'auto',
  }
  const built = buildProviderRequestBody('freemodels', body, 'terra')
  assert.equal(built.modelId, 'terra')
  assert.equal(built.stream, true)
  assert.deepEqual(built.tools, body.tools)
  assert.equal(built.tool_choice, 'auto')
  assert.deepEqual(built.messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }])
})

test('the response transcript extractor handles both SSE and aggregated JSON', () => {
  const sse = extractFreeModelsAssistantMessage('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n')
  assert.equal(sse.content, 'hello')
  const json = extractFreeModelsAssistantMessage(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }))
  assert.equal(json.content, 'hello')
  assert.equal(extractFreeModelsAssistantMessage(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '   ', tool_calls: [{}] } }],
  })), null)
})
