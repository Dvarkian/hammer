/**
 * @file lib/tool-call-residue.js
 * @description The tool-call envelope a backend writes into `content`, and how to remove it.
 *
 * DeepSeek-family models do not describe a call as OpenAI's `tool_calls` JSON. They write it as
 * text inside their own envelope, delimited with U+FF5C — the same character family as
 * `<｜begin▁of▁sentence｜>`:
 *
 *     <｜DSML｜function▁calls>
 *     <｜DSML｜invoke name="run_terminal_command">
 *     <｜DSML｜parameter name="command">git status</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *     </｜DSML｜function▁calls>
 *
 * A backend that parses that envelope into `tool_calls` is expected to keep it out of `content`.
 * NVIDIA's `deepseek-ai/deepseek-v4.1-flash` does the first half and not the second: the real
 * calls arrive correctly in `tool_calls` *and* a remnant of the opening token is left in
 * `content`. Verified live 2026-09-22 over 50 captured turns — byte-for-byte identical on each of
 * the 10 that leaked:
 *
 *     '\n\n<｜DSML｜ calls>\n'  =  0a 0a 3c ff5c 44 53 4d 4c ff5c 20 63 61 6c 6c 73 3e 0a
 *
 * `function` has collapsed to a space — what a parser that consumed the block keyword and then
 * failed to suppress the opening token would leave behind.
 *
 * The remnant asserts nothing the `tool_calls` array does not already say, but it is not harmless
 * either, because it is *text*: a client renders it as the assistant's message, stores that turn,
 * and replays it in every later request. The noise then re-enters the prompt as context, and is
 * copied into the client's own conversation summaries — ten turns after the leak the request log
 * still carried it in three of them, one of those inside a `<conversation_summary>`.
 *
 * Two consumers, one rule:
 *
 *   - outbound — `lib/request-sanitize.js` strips it from replayed history, so a transcript that
 *     already carries it stops feeding it back;
 *   - inbound — the proxy strips it from `content` before the client sees it, which is what stops
 *     a client storing it in the first place. A streamed answer needs
 *     `createResidueStreamFilter`, because these arrive a token at a time and a delta can split
 *     the tag in half.
 *
 * Only envelope tags are ever removed. The pattern requires the `DSML` name between two delimiter
 * bars inside `<>`, which ordinary prose, HTML and source code never spell — and a body without
 * the letters `DSML` in it is returned untouched without being parsed at all.
 */

/** An envelope tag: `<｜DSML｜…>`, `</｜DSML｜…>`, and the ASCII-bar spelling of either. */
export const DSML_TAG_RE = /<\/?[｜|]DSML[｜|][^>]*>/g

/** Every way a tag can open, so streamed text can be withheld until it cannot become one. */
const TAG_OPENINGS = ['<｜DSML｜', '</｜DSML｜', '<|DSML|', '</|DSML|']

/** Length of the longest opening; one less than this is what a chunk can actually hold back. */
const MAX_OPENING_LENGTH = Math.max(...TAG_OPENINGS.map(opening => opening.length))

/**
 * Removes every envelope tag from a string.
 *
 * @param {string} text
 * @returns {string} the same string when it holds no tag (and when it is not a string)
 */
export function stripResidueTags(text) {
  if (typeof text !== 'string' || !text.includes('DSML')) return text
  return text.replace(DSML_TAG_RE, '')
}

/**
 * Scrubs one message `content`, which the chat-completions contract allows to be a string or an
 * array of parts (`{type: 'text', text: '…'}` and friends).
 *
 * @param {string|Array} content
 * @returns {{ content: string|Array, changed: boolean }}
 */
export function scrubContentResidue(content) {
  if (typeof content === 'string') {
    const next = stripResidueTags(content)
    return { content: next, changed: next !== content }
  }
  if (!Array.isArray(content)) return { content, changed: false }
  let changed = false
  const parts = content.map(part => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part
    const next = stripResidueTags(part.text)
    if (next === part.text) return part
    changed = true
    return { ...part, text: next }
  })
  return { content: changed ? parts : content, changed }
}

/**
 * Scrubs a serialized non-streamed chat-completions body.
 *
 * Returns the input untouched on anything it cannot parse: this runs on the way to a client, and
 * a body this module does not recognize is not a reason to hand over nothing.
 *
 * @param {string} text  the upstream response body, as received
 * @returns {string}
 */
export function scrubChatCompletionBody(text) {
  if (typeof text !== 'string' || !text.includes('DSML')) return text
  let body
  try { body = JSON.parse(text) } catch { return text }
  if (!body || !Array.isArray(body.choices)) return text
  let changed = false
  const choices = body.choices.map(choice => {
    const message = choice && typeof choice === 'object' ? choice.message : null
    if (!message || typeof message !== 'object') return choice
    const { content, changed: hit } = scrubContentResidue(message.content)
    if (!hit) return choice
    changed = true
    return { ...choice, message: { ...message, content } }
  })
  return changed ? JSON.stringify({ ...body, choices }) : text
}

/** How many trailing characters must be withheld, because a tag could still complete them. */
function heldBackLength(text) {
  const most = Math.min(text.length, MAX_OPENING_LENGTH - 1)
  for (let n = most; n > 0; n--) {
    const suffix = text.slice(text.length - n)
    if (TAG_OPENINGS.some(opening => opening.startsWith(suffix))) return n
  }
  return 0
}

/**
 * Filters envelope tags out of a streamed text body.
 *
 * Deliberately text-level rather than frame-level. Every character a tag is spelled from — `<`,
 * `>`, `｜`, letters and a space — is legal unescaped inside a JSON string, so a tag can never
 * straddle anything but a chunk boundary; parsing the SSE frames would buy nothing and would put
 * every provider's framing rules in the way of one provider's leak. (It must also not be done per
 * chunk on raw bytes: see readStreamedAnswer on why a half frame parsed for content is worse than
 * no parse at all.)
 *
 * A tag *can* straddle a chunk boundary, because the model emits it a token at a time, so the
 * filter withholds the longest trailing run that is still a prefix of a tag opening and prepends
 * it to the next chunk. That window is bounded by the longest opening — eight characters — and
 * `flush` releases it if the stream ends mid-prefix, so nothing is ever dropped.
 *
 * @returns {{ push: (chunk: string) => string, flush: () => string }}
 */
export function createResidueStreamFilter() {
  let carry = ''
  return {
    push(chunk) {
      if (!chunk) return ''
      const text = carry + chunk
      // Fast path: with nothing withheld and no `<` in sight, no tag can start or complete here.
      if (carry === '' && !text.includes('<')) return text
      carry = ''
      const stripped = stripResidueTags(text)
      const held = heldBackLength(stripped)
      if (held > 0) {
        carry = stripped.slice(stripped.length - held)
        return stripped.slice(0, stripped.length - held)
      }
      return stripped
    },
    flush() {
      const tail = carry
      carry = ''
      return tail
    },
  }
}
