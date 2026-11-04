/**
 * Devin streams a tool call once (id + name) and then its arguments as raw fragments with
 * neither. Reassembling that wrongly is what produced a transcript full of phantom calls
 * named "tool": every argument-only frame minted a fresh random id, and a call whose name
 * had not arrived yet was announced as "tool" — a name the OpenAI stream cannot correct,
 * because a function name is sent exactly once.
 *
 * These tests drive the real codec end to end: Connect frames in, OpenAI SSE (or a
 * chat.completion body) out, reassembled the way a client would.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

import { buildProviderRequestBody, transformDevinResponse } from '../lib/server.js'

// ── protobuf + Connect frame builders (the inverse of the decoders under test) ──────────

function varint(value) {
  const out = []
  let n = value
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

function tag(field, wireType) {
  return varint((field << 3) | wireType)
}

function stringField(field, value) {
  const bytes = Buffer.from(String(value), 'utf8')
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes])
}

function messageField(field, payload) {
  return Buffer.concat([tag(field, 2), varint(payload.length), payload])
}

function varintField(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)])
}

/** exa.chat_pb.ChatToolCall: 1 id, 2 name, 3 argumentsJson. */
function toolCall({ id, name, argumentsJson }) {
  const parts = []
  if (id) parts.push(stringField(1, id))
  if (name) parts.push(stringField(2, name))
  if (argumentsJson !== undefined) parts.push(stringField(3, argumentsJson))
  return Buffer.concat(parts)
}

/** GetChatMessageResponse: 3 deltaText, 5 stopReason, 6 deltaToolCalls (repeated). */
function deltaPayload({ text, stopReason, calls }) {
  const parts = []
  if (text) parts.push(stringField(3, text))
  if (stopReason != null) parts.push(varintField(5, stopReason))
  for (const call of calls || []) parts.push(messageField(6, toolCall(call)))
  return Buffer.concat(parts)
}

/** Connect framing: 1 flag byte + 4-byte big-endian length + payload. */
function frame(payload, flags = 0) {
  const head = Buffer.alloc(5)
  head[0] = flags
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

const END_STREAM = frame(Buffer.alloc(0), 0x02)

function devinResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/grpc' } })
}

function sseObjects(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data))
}

/** Reassembles streamed deltas into whole tool calls, the way an OpenAI client does. */
function collectStreamedCalls(chunks) {
  const calls = new Map()
  let finishReason = null
  for (const chunk of chunks) {
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    for (const piece of choice.delta?.tool_calls || []) {
      let entry = calls.get(piece.index)
      if (!entry) {
        entry = { id: null, name: '', arguments: '' }
        calls.set(piece.index, entry)
      }
      if (piece.id) entry.id = piece.id
      if (piece.function?.name) entry.name = piece.function.name
      if (piece.function?.arguments) entry.arguments += piece.function.arguments
    }
  }
  return { calls: [...calls.values()], finishReason }
}

// ── tests ───────────────────────────────────────────────────────────────────────────────

test('argument-only fragments continue the call in flight instead of minting phantom calls', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ calls: [{ id: 'call_1', name: 'bash', argumentsJson: '{"comm' }] })),
      frame(deltaPayload({ calls: [{ argumentsJson: 'and":"ls"}' }] })),
      END_STREAM,
    ]),
    'devin-model',
    true,
  )

  const { calls, finishReason } = collectStreamedCalls(sseObjects(await transformed.text()))
  assert.equal(calls.length, 1, 'one fragment stream is one call')
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].name, 'bash')
  assert.equal(calls[0].arguments, '{"command":"ls"}')
  assert.equal(finishReason, 'tool_calls')
})

test('a name that arrives after the id is announced once, never as "tool"', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ calls: [{ id: 'call_2', argumentsJson: '{"path":"a"}' }] })),
      frame(deltaPayload({ calls: [{ id: 'call_2', name: 'read' }] })),
      END_STREAM,
    ]),
    'devin-model',
    true,
  )

  const { calls } = collectStreamedCalls(sseObjects(await transformed.text()))
  assert.deepEqual(calls, [{ id: 'call_2', name: 'read', arguments: '{"path":"a"}' }])
})

test('a call that never gets a name is dropped, not announced as a placeholder', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ calls: [{ id: 'call_3', argumentsJson: '{}' }] })),
      END_STREAM,
    ]),
    'devin-model',
    true,
  )

  const { calls, finishReason } = collectStreamedCalls(sseObjects(await transformed.text()))
  assert.deepEqual(calls, [], 'a nameless call cannot be executed')
  assert.equal(finishReason, 'stop', 'and it must not claim a tool call was made')
})

test('arguments that are not a JSON object become an empty object', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ calls: [{ id: 'call_4', name: 'bash', argumentsJson: 'command' }] })),
      END_STREAM,
    ]),
    'devin-model',
    true,
  )

  const { calls } = collectStreamedCalls(sseObjects(await transformed.text()))
  assert.equal(calls[0].arguments, '{}')
})

test('text and two real calls survive a mixed stream', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ text: 'Working on it.' })),
      frame(deltaPayload({ calls: [{ id: 'a', name: 'read', argumentsJson: '{"path":"x"}' }] })),
      frame(
        deltaPayload({ calls: [{ id: 'b', name: 'bash', argumentsJson: '{"command":"ls"}' }] }),
      ),
      END_STREAM,
    ]),
    'devin-model',
    true,
  )

  const { calls } = collectStreamedCalls(sseObjects(await transformed.text()))
  assert.deepEqual(
    calls.map((call) => [call.name, call.arguments]),
    [
      ['read', '{"path":"x"}'],
      ['bash', '{"command":"ls"}'],
    ],
  )
})

/** Generic protobuf field walker, the inverse of the encoders above. */
function decodeFields(buffer) {
  const out = []
  let offset = 0
  while (offset < buffer.length) {
    let tag = 0
    let shift = 0
    let byte
    do {
      byte = buffer[offset++]
      tag |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    const field = tag >>> 3
    const wireType = tag & 7
    if (wireType === 0) {
      let value = 0
      shift = 0
      do {
        byte = buffer[offset++]
        value += (byte & 0x7f) * 2 ** shift
        shift += 7
      } while (byte & 0x80)
      out.push({ field, wireType, value })
    } else if (wireType === 2) {
      let length = 0
      shift = 0
      do {
        byte = buffer[offset++]
        length += (byte & 0x7f) * 2 ** shift
        shift += 7
      } while (byte & 0x80)
      out.push({ field, wireType, value: buffer.subarray(offset, offset + length) })
      offset += length
    } else {
      break
    }
  }
  return out
}

test('a malformed call replayed from history is not encoded into the Devin request verbatim', () => {
  const request = buildProviderRequestBody(
    'devin',
    {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'bash', arguments: 'command' } },
          ],
        },
      ],
    },
    'devin-model',
    { apiKey: 'test-key' },
  )

  const length = request.readUInt32BE(1)
  const proto = gunzipSync(request.subarray(5, 5 + length))
  const prompts = decodeFields(proto)
    .filter((entry) => entry.field === 3 && entry.wireType === 2)
    .map((entry) => decodeFields(entry.value))
  const assistant = prompts[1]
  assert.ok(assistant, 'the assistant turn is encoded')
  const toolCall = decodeFields(assistant.find((entry) => entry.field === 6).value)
  const argumentsField = toolCall.find((entry) => entry.field === 3)
  assert.equal(Buffer.from(argumentsField.value).toString('utf8'), '{}')
})

test('the non-streaming body applies the same rules', async () => {
  const transformed = await transformDevinResponse(
    devinResponse([
      frame(deltaPayload({ calls: [{ id: 'call_1', name: 'bash', argumentsJson: '{"comm' }] })),
      frame(deltaPayload({ calls: [{ argumentsJson: 'and":"ls"}' }] })),
      frame(deltaPayload({ calls: [{ id: 'call_2', argumentsJson: '{}' }] })),
      END_STREAM,
    ]),
    'devin-model',
    false,
  )

  const body = await transformed.json()
  const calls = body.choices[0].message.tool_calls || []
  assert.equal(calls.length, 1, 'the phantom and the nameless call are both gone')
  assert.equal(calls[0].function.name, 'bash')
  assert.equal(calls[0].function.arguments, '{"command":"ls"}')
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
})
