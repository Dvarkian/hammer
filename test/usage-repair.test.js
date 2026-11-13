/**
 * The usage a provider streams back is the only thing Pi sizes a conversation from: it reads the
 * context out of the last assistant message's usage. A provider that reports the tokens it
 * generated and nothing it was sent leaves Pi measuring 122 tokens for a context that had just
 * overflowed, and Pi then compacted against that figure. A provider that reports 372 for a
 * hundred thousand tokens of conversation does the same thing less obviously (devin). These
 * tests pin the relay's half of it: a prompt count the provider left out — or reported far
 * below the request — is filled from the request, and one that could describe the request is
 * never touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createUsageRepair } from '../lib/http/routes/proxy.js'

/** One SSE frame carrying the usage block a provider ended its stream with. */
const usageFrame = (usage) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [], usage })}\n\n`

test('a usage block with no prompt count is relayed with the request’s own estimate', () => {
  const repair = createUsageRepair(40_000)
  assert.ok(repair, 'a positive estimate installs a repair')
  const stream =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    usageFrame({ prompt_tokens: 0, completion_tokens: 122, total_tokens: 122 }) +
    'data: [DONE]\n\n'

  const out = repair.push(stream) + repair.flush()
  const frames = out
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))

  // The content frame is not a usage frame and is handed on byte for byte.
  assert.deepEqual(frames[0], { choices: [{ delta: { content: 'hi' } }] })
  assert.equal(frames[1].usage.prompt_tokens, 40_000)
  // Pi falls back to the parts when no total is reported, so the total has to agree with them.
  assert.equal(frames[1].usage.total_tokens, 40_122)
  assert.match(out, /data: \[DONE\]/)
})

test('a prompt count the provider did report is never replaced', () => {
  const repair = createUsageRepair(40_000)
  const frame = usageFrame({ prompt_tokens: 31_500, completion_tokens: 90, total_tokens: 31_590 })
  assert.equal(repair.push(frame) + repair.flush(), frame)
  // Denser tokenizers than chars/4 are ordinary (code, CJK): their count is lower than the
  // estimate without being a different number.
  const dense = createUsageRepair(40_000)
  const denseFrame = usageFrame({ prompt_tokens: 18_000, completion_tokens: 90 })
  assert.equal(dense.push(denseFrame) + dense.flush(), denseFrame)
})

test('a prompt count far below the request cannot be describing it', () => {
  // Devin: a hundred thousand tokens of conversation, answered, reported as 372 prompt tokens.
  // Pi sized the context from that, so the meter read 751 tokens (0.3% of a 262k window) while
  // the conversation was well over a third of the way to the wall.
  const repair = createUsageRepair(100_000)
  const frame = usageFrame({ prompt_tokens: 372, completion_tokens: 379, total_tokens: 751 })
  const out = repair.push(frame) + repair.flush()
  const usage = JSON.parse(out.trim().slice(6)).usage
  assert.equal(usage.prompt_tokens, 100_000)
  assert.equal(usage.total_tokens, 100_379)
})

test('frames the repair has no business in pass through unchanged', () => {
  const repair = createUsageRepair(1_000)
  const plain = 'data: {"choices":[{"delta":{"content":"still here"}}]}\n\n'
  const notJson = 'data: provider said no\n\n'
  const done = 'data: [DONE]\n\n'
  assert.equal(repair.push(plain + notJson + done) + repair.flush(), plain + notJson + done)
  // Usage without a completion count is still a prompt count Pi would otherwise read as zero.
  const out = repair.push(usageFrame({ prompt_tokens: 0 })) + repair.flush()
  const usage = JSON.parse(out.trim().slice(6)).usage
  assert.equal(usage.prompt_tokens, 1_000)
  assert.equal(usage.total_tokens, 1_000)
})

test('a frame split across chunks is held until it is whole, then repaired once', () => {
  const repair = createUsageRepair(2_500)
  const frame = usageFrame({ prompt_tokens: 0, completion_tokens: 40, total_tokens: 40 })
  const cut = frame.indexOf('"total_tokens"')
  assert.ok(cut > 0)

  const first = repair.push(Buffer.from(frame.slice(0, cut)))
  const rest = repair.push(Buffer.from(frame.slice(cut))) + repair.flush()
  // Nothing complete came out of the first chunk: a client never sees half a usage object.
  assert.equal(first, '')
  const usage = JSON.parse(rest.trim().slice(6)).usage
  assert.equal(usage.prompt_tokens, 2_500)
  assert.equal(usage.total_tokens, 2_540)
})

test('a character split across two chunks survives the repair', () => {
  const repair = createUsageRepair(1_500)
  const body = Buffer.from(
    'data: {"choices":[{"delta":{"content":"café"}}]}\n\n' +
      usageFrame({ prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 }),
  )
  const at = body.indexOf(Buffer.from('é')) + 1 // inside the two bytes of "é"
  const out = repair.push(body.subarray(0, at)) + repair.push(body.subarray(at)) + repair.flush()
  assert.match(out, /café/)
  assert.equal(JSON.parse(out.split('\n\n')[1].trim().slice(6)).usage.prompt_tokens, 1_500)
})

test('no estimate, no repair', () => {
  assert.equal(createUsageRepair(0), null)
  assert.equal(createUsageRepair(Number.NaN), null)
})
