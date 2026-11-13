import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  contentPartsText,
  createContentFlatten,
  flattenChatCompletionContent,
  splitContentParts,
} from '../lib/http/routes/proxy.js'

/** One SSE line as a provider wrote it. */
const frame = (delta, extra = {}) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`

const deltasOf = (out) =>
  out
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta)

test('contentPartsText joins text parts and drops the ones with no string form', () => {
  assert.equal(contentPartsText('plain'), 'plain')
  assert.equal(
    contentPartsText([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]),
    'Hello',
  )
  // An image part has no string form. Stringifying it is what writes [object Object] into a
  // transcript, so it is dropped instead.
  assert.equal(
    contentPartsText([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'x' } },
    ]),
    'a',
  )
  assert.equal(contentPartsText(null), '')
  assert.equal(contentPartsText({ type: 'text', text: 'bare object' }), '')
})

test('a thinking chunk is reasoning, and the text beside it is the answer', () => {
  // The shape Mistral streams, captured from a live response: the reasoning is a content chunk,
  // and reading the array as a string is what replaced it with [object Object].
  const thinking = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'The user wants me' }], closed: true },
  ]
  assert.deepEqual(splitContentParts(thinking), { text: '', reasoning: 'The user wants me' })

  const mixed = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'thinking…' }], closed: true },
    { type: 'text', text: 'hello there' },
  ]
  assert.deepEqual(splitContentParts(mixed), { text: 'hello there', reasoning: 'thinking…' })

  assert.deepEqual(splitContentParts('plain'), { text: 'plain', reasoning: '' })
  assert.deepEqual(splitContentParts([{ type: 'image_url', image_url: { url: 'x' } }]), {
    text: '',
    reasoning: '',
  })
})

test('an array-valued delta.content is flattened before the client concatenates it', () => {
  const flatten = createContentFlatten()
  const out =
    flatten.push(frame({ content: [{ type: 'text', text: 'Sounds good' }] })) +
    flatten.push(
      frame({
        content: [
          { type: 'text', text: ',' },
          { type: 'text', text: ' then' },
        ],
      }),
    ) +
    flatten.flush()

  const deltas = deltasOf(out)
  assert.deepEqual(
    deltas.map((delta) => delta.content),
    ['Sounds good', ', then'],
  )
  // This is the whole point: Pi appends the field straight onto its message text.
  const transcript = deltas.reduce((text, delta) => text + delta.content, '')
  assert.equal(transcript, 'Sounds good, then')
  assert.ok(!transcript.includes('[object Object]'))
})

test('reasoning a provider packed into content arrives as reasoning, not as the answer', () => {
  const flatten = createContentFlatten()
  const thinking = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'The user wants me' }], closed: true },
  ]
  const out = flatten.push(frame({ content: thinking })) + flatten.flush()
  const [delta] = deltasOf(out)
  assert.equal(delta.content, '')
  assert.equal(delta.reasoning_content, 'The user wants me')
  // A provider that already names its reasoning keeps that field untouched.
  const named = deltasOf(
    createContentFlatten().push(
      frame({ content: [{ type: 'text', text: 'answer' }], reasoning_content: 'mine' }),
    ),
  )[0]
  assert.equal(named.reasoning_content, 'mine')
  assert.equal(named.content, 'answer')
})

test('a string delta is handed on byte for byte', () => {
  const line = frame({ content: 'unchanged' })
  assert.equal(createContentFlatten().push(line), line)
  assert.equal(createContentFlatten().push(line), line)
})

test('frames it does not own are left exactly as they arrived', () => {
  const flatten = createContentFlatten()
  const done = 'data: [DONE]\n\n'
  const toolCall = frame({
    tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }],
  })
  const usageOnly = `data: ${JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 1 } })}\n\n`
  const malformed = 'data: {not json\n\n'
  const eventLine = 'event: ping\n\n'
  for (const line of [done, toolCall, usageOnly, malformed, eventLine]) {
    assert.equal(flatten.push(line), line)
  }
})

test('a frame split across chunks is reassembled before it is judged', () => {
  const flatten = createContentFlatten()
  const line = frame({ content: [{ type: 'text', text: 'split' }] })
  const cut = Math.floor(line.length / 2)
  const first = flatten.push(line.slice(0, cut))
  const second = flatten.push(line.slice(cut))
  const parsed = JSON.parse((first + second).slice(6).trim())
  assert.equal(parsed.choices[0].delta.content, 'split')
})

test('the log capture and the aggregated body read the answer the same way', () => {
  // Both used to append `delta.content` whatever it was, so a chunked answer reached the log as
  // [object Object] and reached an aggregating client as nothing at all.
  const source = readFileSync(new URL('../lib/http/routes/proxy.js', import.meta.url), 'utf8')
  assert.match(source, /fullContent \+= partText/)
  assert.match(source, /content \+= contentPartsText\(delta\.content\)/)
  assert.doesNotMatch(source, /fullContent \+= delta\.content/)
})

test('a non-streamed body with array content is flattened too', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' there' },
          ],
        },
        finish_reason: 'stop',
      },
    ],
  })
  const flattened = JSON.parse(flattenChatCompletionContent(body))
  assert.equal(flattened.choices[0].message.content, 'Hello there')
  // Untouched shapes come back as the same string, not a re-serialized copy.
  const plain = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain' } }] })
  assert.equal(flattenChatCompletionContent(plain), plain)
  assert.equal(flattenChatCompletionContent('not json'), 'not json')
})
