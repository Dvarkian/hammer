/**
 * ── The tool-call envelope in `content` ─────────────────────────────────────────────────
 *
 * NVIDIA's `deepseek-ai/deepseek-v4.1-flash` returns DeepSeek's tool calls correctly in
 * `tool_calls` and *also* leaves an envelope remnant in `content`. Verified live 2026-09-22; the
 * exact bytes it leaked on 10 of 50 captured turns are pinned here, because the whole point of
 * this module is that the leak is reproducible and the removal has to be total.
 *
 * The tests that carry most of the weight:
 *
 *   - the leaked fragment byte for byte, including its U+FF5C delimiters, so an edit that
 *     quietly stops matching the real thing fails here rather than in someone's transcript;
 *   - the split case — these arrive a token at a time, so the fragment must come out even when it
 *     is spread across several chunks, and the withheld prefix must never be dropped;
 *   - the negative case: an answer that merely contains `<` must survive untouched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createResidueStreamFilter,
  scrubChatCompletionBody,
  scrubContentResidue,
  stripResidueTags,
} from '../lib/tool-call-residue.js'
import { stripResidueFromHistory } from '../lib/request-sanitize.js'

// Exactly what the provider leaked, recovered from the request log.
const LEAKED = '\n\n<｜DSML｜ calls>\n'

test('the leaked envelope remnant is removed byte for byte', () => {
  assert.equal(stripResidueTags(LEAKED), '\n\n\n')
  // U+FF5C is what makes it a DeepSeek special token rather than a stray angle bracket.
  assert.equal([...LEAKED][3], '｜')
  assert.equal(LEAKED.codePointAt(3), 0xff5c)
})

test('a full envelope and its ASCII spelling both go', () => {
  const full = '<｜DSML｜function▁calls><｜DSML｜invoke name="run_terminal_command">'
    + '</｜DSML｜invoke></｜DSML｜function▁calls>'
  assert.equal(stripResidueTags(full), '')
  assert.equal(stripResidueTags('<|DSML|function_calls></|DSML|function_calls>'), '')
  assert.equal(stripResidueTags('answer <｜DSML｜ calls> more'), 'answer  more')
})

test('ordinary text, HTML and code are untouched', () => {
  const prose = 'Use `a < b` and <div class="x">html</div> — nothing to strip.'
  assert.equal(stripResidueTags(prose), prose)
  assert.equal(stripResidueTags('no tags at all'), 'no tags at all')
  assert.equal(stripResidueTags(''), '')
})

test('a message content array is scrubbed part by part', () => {
  const input = [{ type: 'text', text: LEAKED }, { type: 'image_url', image_url: { url: 'x' } }]
  const { content, changed } = scrubContentResidue(input)
  assert.equal(changed, true)
  assert.equal(content[0].text, '\n\n\n')
  assert.equal(content[1], input[1], 'a non-text part is passed through by reference')
  // A clean array reports no change, so a caller never rewrites a payload needlessly.
  const clean = [{ type: 'text', text: 'hi' }]
  assert.deepEqual(scrubContentResidue(clean), { content: clean, changed: false })
})

test('a non-streamed body is scrubbed, and an unreadable one is handed over as it arrived', () => {
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: LEAKED }, finish_reason: 'tool_calls' }],
  })
  assert.equal(JSON.parse(scrubChatCompletionBody(body)).choices[0].message.content, '\n\n\n')

  assert.equal(scrubChatCompletionBody('not json'), 'not json')
  const noChoices = JSON.stringify({ error: { message: 'rate limited' } })
  assert.equal(scrubChatCompletionBody(noChoices), noChoices)
  // A body the module has nothing to do with is not even parsed again.
  const clean = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] })
  assert.equal(scrubChatCompletionBody(clean), clean)
})

test('a tag split across chunks is still removed, and nothing is dropped', () => {
  const filter = createResidueStreamFilter()
  // The real case: the model emits the envelope a token at a time.
  let out = ''
  for (const chunk of ['\n\n', '<｜DSML｜', ' calls>', '\n']) out += filter.push(chunk)
  out += filter.flush()
  assert.equal(out, '\n\n\n')
  assert.equal(out.includes('DSML'), false)
})

test('a whole tag inside one chunk is removed in that chunk', () => {
  const filter = createResidueStreamFilter()
  assert.equal(filter.push(LEAKED), '\n\n\n')
  assert.equal(filter.flush(), '')
})

test('a withheld prefix is released when the stream ends mid-tag', () => {
  const filter = createResidueStreamFilter()
  assert.equal(filter.push('answer <'), 'answer ')
  assert.equal(filter.flush(), '<')
})

test('an answer that merely contains < passes through untouched', () => {
  const filter = createResidueStreamFilter()
  let out = ''
  for (const chunk of ['a ', '<', ' b', ' and ', '<div>', '</div>']) out += filter.push(chunk)
  out += filter.flush()
  assert.equal(out, 'a < b and <div></div>')
})

// ── The outbound half: history that already carries the remnant ─────────────────────────
//
// The proxy stops a client *storing* the remnant; this is what stops a transcript that already
// stores it from feeding it back on every later turn. The roles matter: the observed transcript
// had it inside a user turn and inside a conversation summary, not only in the assistant turn
// that produced it, so scoping this to assistant turns (as the reasoning scrub does) would miss
// the cases the log actually showed.

test('a replayed transcript loses the remnant whatever role or shape carries it', () => {
  const body = {
    model: 'x',
    stream: true,
    messages: [
      { role: 'assistant', content: LEAKED, tool_calls: [{ id: 'call_1', type: 'function' }] },
      { role: 'user', content: 'Progress note:\n<｜DSML｜ calls>' },
      { role: 'user', content: [{ type: 'text', text: `<conversation_summary>${LEAKED}</conversation_summary>` }] },
      { role: 'assistant', content: 'clean' },
    ],
  }
  const { body: out, stripped } = stripResidueFromHistory(body)
  // Named for the nested part it acted on, like the existing `content[thinking]` disclosure.
  assert.deepEqual(stripped, ['content[dsml]'])
  assert.equal(out.messages[0].content, '\n\n\n')
  assert.equal(out.messages[1].content, 'Progress note:\n')
  assert.equal(out.messages[2].content[0].text, '<conversation_summary>\n\n\n</conversation_summary>')
  // The scrub touches content and nothing else: the calls the turn must keep are still there.
  assert.equal(out.messages[0].tool_calls, body.messages[0].tool_calls)
  assert.equal(out.messages[3], body.messages[3], 'a clean turn is passed through by reference')

  // No remnant means no rewrite and no disclosure, so ordinary traffic is untouched.
  const clean = { messages: [{ role: 'user', content: 'hi' }] }
  assert.deepEqual(stripResidueFromHistory(clean), { body: clean, stripped: [] })
})
