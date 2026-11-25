/**
 * @file lib/tool-call-recovery.js
 * @description A tool call a backend wrote as text, and how to turn it back into a call.
 *
 * `lib/tool-call-residue.js` covers the same family of defect one notch quieter: a backend that
 * parses the model's envelope *and* leaves the tags behind. This module covers the failure that
 * has no recovery anywhere else — a route that never parses the call at all and hands the whole
 * assistant object back inside `content`:
 *
 *     Let me collect the subagent findings.
 *
 *     {"tool_calls":[{"id":"call_00_waitall","type":"function","function":{"name":"subagent",
 *     "arguments":"{\"action\":\"wait\",\"id\":\"sa_ca803c4a\",\"wait_ms\":600000}"}}]}
 *
 * A route can also write the call in Anthropic's shape, without the wrapper:
 *
 *     {"name":"web_search","arguments":{"query":"paper roads in Australia"}}
 *
 * Both are recovered. Recorded live 2026-11-19: a six-agent research team's reports came back
 * containing exactly that second block — the child had announced its searches and written them
 * as text, so Pi ran nothing and the team looked like it had simply given up.
 *
 * Verified live 2026-11-19 in session 01a1f1f1, where every turn from that point on arrived with
 * `finish_reason: "stop"` and this block as its answer. Pi reads `delta.content` and runs nothing,
 * so the agent settles on a message that *looks* like a call to a human and is a dead end to the
 * loop. The parent had seven children running and spent the rest of the session asking for their
 * results in prose.
 *
 * The block is valid JSON, names real tools from the request it was answering, and sits at the end
 * of the answer. That is enough to turn it back into the call the model meant to make, and doing
 * so is the only outcome that keeps the turn alive: nudging the model to "continue" makes it write
 * the same block again, and the route that mangles the wire format is not always the route the
 * next turn lands on (the session above leaked on two different providers).
 *
 * Nothing is guessed. A block is recovered only when it parses, every call in it names a tool the
 * request actually offered, and every call has a name and arguments — so an answer that merely
 * *discusses* the JSON (a transcript quoted back, a doc example, this file's own comment) passes
 * through untouched.
 *
 * Three consumers, one rule:
 *
 *   - inbound streamed — `createToolCallRecoveryStreamFilter` holds the text back from the `{` that
 *     could still become the envelope and, at the end of the stream, emits the call instead;
 *   - inbound non-streamed — `recoverChatCompletionToolCalls` edits `message.content` and
 *     `finish_reason` in the one body;
 *   - the tool names — `toolNamesFromRequest` reads the request the call is answering. No tools in
 *     the request means no call to recover, and the filter is never built.
 */

/** A complete envelope opening. Once this matches, the JSON body follows and the tail is held. */
const ENVELOPE_RE = /\{\s*"(?:tool_calls|function_call|name)"\s*:/

/** The shapes an opening can still have while text is arriving a token at a time. */
const PENDING_RE = /^\{\s*(?:"[a-z_]{0,16}"?\s*:?\s*)?$/

/** A quoted key with no closing quote yet — it must still be able to become `tool_calls`. */
const PARTIAL_KEY_RE = /"([a-z_]*)$/

/** A quoted key that is closed: from here it either names a call field or it never will. */
const CLOSED_KEY_RE = /"([a-z_]+)"/

const ENVELOPE_KEYS = ['tool_calls', 'function_call', 'name']

/** How far back an opening is looked for. A key is at most sixteen characters. */
const MAX_PENDING = 64

/** How many `{` positions are tried before the block is declared unparseable. */
const MAX_ANCHORS = 8

/** More calls than this in one answer is not an envelope; it is a document about one. */
const MAX_CALLS = 64

/**
 * The tool names a request offered, or null when it offered none.
 *
 * Null is the gate every other function here honours: a request without tools cannot have
 * answered with a call, so nothing in its content is ever rewritten.
 *
 * @param {any} body the chat-completions request the response is answering
 * @returns {Set<string> | null}
 */
export function toolNamesFromRequest(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : null
  if (!tools || tools.length === 0) return null
  const names = new Set()
  for (const tool of tools) {
    const name = String(tool?.function?.name || tool?.name || '').trim()
    if (name) names.add(name)
  }
  return names.size > 0 ? names : null
}

/**
 * The text of a `content` field, string or parts.
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (typeof part === 'string') out += part
    else if (part && typeof part === 'object' && typeof part.text === 'string') out += part.text
  }
  return out
}

/**
 * One call in the OpenAI shape the client accumulates.
 *
 * `arguments` is always a JSON string: that is what the wire promises and what Pi parses, and a
 * provider that wrote the block as an object left it as an object inside its own text.
 *
 * @param {any} entry
 * @param {number} index
 * @returns {{ id: string, type: 'function', function: { name: string, arguments: string } } | null}
 */
function normalizeCall(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const fn = entry.function && typeof entry.function === 'object' ? entry.function : null
  const name = String(fn?.name || entry.name || '').trim()
  if (!name) return null
  let args = fn ? fn.arguments : entry.arguments
  if (typeof args !== 'string') args = args == null ? '{}' : JSON.stringify(args)
  return {
    id: String(entry.id || '').trim() || `call_recovered_${index}`,
    type: 'function',
    function: { name, arguments: args },
  }
}

/**
 * The calls an envelope object carries, or null when it is not one.
 * @param {any} value a parsed object
 * @param {Set<string> | null} allowed tool names the request offered
 */
function envelopeCalls(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let list = null
  if (Array.isArray(value.tool_calls)) list = value.tool_calls
  else if (value.function_call && typeof value.function_call === 'object')
    list = [{ function: value.function_call }]
  else if (typeof value.name === 'string' && (value.arguments != null || value.parameters != null))
    // Anthropic's shape and the one several relays copy: a bare name and its arguments, with
    // no `function` wrapper and no `tool_calls` array. `normalizeCall` already reads it.
    list = [{ name: value.name, arguments: value.arguments ?? value.parameters }]
  if (!list || list.length === 0 || list.length > MAX_CALLS) return null
  const calls = []
  for (let index = 0; index < list.length; index += 1) {
    const call = normalizeCall(list[index], index)
    if (!call) return null
    if (allowed && !allowed.has(call.function.name)) return null
    calls.push(call)
  }
  return calls
}

/**
 * Splits a serialized envelope off the end of an answer.
 *
 * The block is only ever accepted at the end (trailing whitespace and an optional closing code
 * fence aside), which is where a model that mistook the wire format puts it and is the reason the
 * answer preceding it can be kept.
 *
 * @param {unknown} content the assistant's text
 * @param {Set<string> | null} [allowed] tool names the request offered; null disables recovery
 * @returns {{ text: string, toolCalls: any[] } | null} null when there is no envelope to recover
 */
export function recoverSerializedToolCalls(content, allowed = null) {
  if (typeof content !== 'string' || !allowed) return null
  const body = content.replace(/\s+$/, '').replace(/```\s*$/, '')
  const anchor = Math.max(
    body.lastIndexOf('"tool_calls"'),
    body.lastIndexOf('"function_call"'),
    body.lastIndexOf('"name"'),
  )
  if (anchor < 0) return null
  let index = body.lastIndexOf('{', anchor)
  for (let attempt = 0; index >= 0 && attempt < MAX_ANCHORS; attempt += 1) {
    let calls
    try {
      calls = envelopeCalls(JSON.parse(body.slice(index)), allowed)
    } catch {
      calls = null
    }
    if (calls) {
      return { text: content.slice(0, index).replace(/\s+$/, ''), toolCalls: calls }
    }
    index = body.lastIndexOf('{', index - 1)
  }
  return null
}

/**
 * Recovers a serialized call from a non-streamed chat-completions body.
 *
 * Returns the input untouched on anything it cannot parse: this runs on the way to a client, and
 * a body this module does not recognize is not a reason to hand over nothing.
 *
 * @param {string} text the upstream response body
 * @param {Set<string> | null} [allowed]
 * @returns {string}
 */
export function recoverChatCompletionToolCalls(text, allowed = null) {
  if (typeof text !== 'string' || !allowed) return text
  // A serialized body escapes the block's quotes (`\"name\"`), so this cheap pre-check
  // looks for the bare word; the parse and the name gate below are what actually decide.
  if (!text.includes('tool_calls') && !text.includes('function_call') && !text.includes('name'))
    return text
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!body || !Array.isArray(body.choices)) return text
  let changed = false
  const choices = body.choices.map((choice) => {
    const message = choice && typeof choice === 'object' ? choice.message : null
    if (!message || typeof message !== 'object') return choice
    // A call the route did deliver is the call; never look past it.
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return choice
    if (message.function_call) return choice
    const recovered = recoverSerializedToolCalls(contentText(message.content), allowed)
    if (!recovered) return choice
    changed = true
    const next = { ...message, content: recovered.text, tool_calls: recovered.toolCalls }
    return { ...choice, message: next, finish_reason: 'tool_calls' }
  })
  return changed ? JSON.stringify({ ...body, choices }) : text
}

/**
 * Whether a run that starts at `{` is an envelope opening.
 *
 * `marker` is a complete `{"tool_calls":`, after which the argument object follows and the run is
 * held to the end of the stream. `pending` is a run that is still being spelled out a character
 * at a time and could still become one. `null` means it has diverged: `{"note"`, `{curly}`, a
 * quoted sentence — answer text that happens to start with a brace.
 *
 * The length bound applies to an opening alone. A marker is followed by the whole argument object,
 * which is as long as the call is, so it is recognised before the bound is consulted.
 *
 * @param {string} run text beginning at a `{`
 * @returns {'marker' | 'pending' | null}
 */
function openingKind(run) {
  if (ENVELOPE_RE.test(run)) return 'marker'
  if (run.length > MAX_PENDING) return null
  if (!PENDING_RE.test(run)) return null
  const partial = PARTIAL_KEY_RE.exec(run)
  if (partial && !ENVELOPE_KEYS.some((key) => key.startsWith(partial[1]))) return null
  const closed = CLOSED_KEY_RE.exec(run)
  if (closed && !ENVELOPE_KEYS.includes(closed[1])) return null
  return 'pending'
}

/**
 * The `{` index of a run that could be an envelope opening, or -1.
 *
 * A block is held from its `{` rather than from its keyword because content that has already been
 * written to the client cannot be taken back: by the time `{"tool_calls"` is recognisable, the `{"`
 * before it has gone out as answer text.
 *
 * The marker is looked up first, because the `{` it belongs to is not necessarily the last brace in
 * the text: a whole envelope can arrive in one frame, and its own arguments contain braces of their
 * own. `from` is the point after which a run is worth looking at — it stops a block that was
 * already released from being picked up again.
 *
 * @param {string} text every content character seen so far
 * @param {number} from earliest index a run may start at
 */
function pendingStart(text, from) {
  // Every keyword an opening can use is tried, and the earliest brace that could be the
  // *whole* envelope wins. Looking only at the latest keyword was wrong for a wrapped call:
  // the `"name"` inside `{"tool_calls":[…,{"function":{"name":…` points at the inner
  // function object, so the outer block was never recognised and the whole call went out as
  // answer text.
  let best = -1
  for (const keyword of ['"tool_calls"', '"function_call"', '"name"']) {
    const anchor = text.lastIndexOf(keyword)
    if (anchor < 0) continue
    const brace = text.lastIndexOf('{', anchor)
    if (brace < from) continue
    if (!openingKind(text.slice(brace))) continue
    if (best < 0 || brace < best) best = brace
  }
  if (best >= 0) return best
  const index = text.lastIndexOf('{')
  if (index < from) return -1
  return openingKind(text.slice(index)) ? index : -1
}

/**
 * One SSE `data:` line parsed, or null for anything else (a blank line, `[DONE]`, an event line).
 * @param {string} raw
 */
function parseDataFrame(raw) {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('data:')) return null
  const text = trimmed.slice(5).trim()
  if (!text || text === '[DONE]') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Puts an edited frame back on its own line, keeping the line's prefix and ending.
 * @param {string} raw the line it came from
 * @param {any} frame
 */
function rewriteFrameLine(raw, frame) {
  const ending = raw.endsWith('\r\n') ? '\r\n' : '\n'
  return `${raw.slice(0, raw.indexOf('data:'))}data: ${JSON.stringify(frame)}${ending}`
}

/**
 * Filters a serialized tool call out of a streamed answer and delivers it as a call.
 *
 * The shape of the work is `createResidueStreamFilter`'s: withhold what cannot yet be judged,
 * release it if the stream proves it was answer text after all. One difference matters. A tag is
 * eight characters at most, so the residue filter can withhold a fixed prefix; an envelope is as
 * long as its arguments, so the hold lasts from the `{` to the end of the stream. That is safe
 * precisely because a model that writes its call as text writes it last — and when the block turns
 * out not to parse, every withheld frame is handed back in `flush`, so an answer is never lost to
 * a false positive.
 *
 * @param {Set<string>} allowed the tool names the request offered
 * @returns {{ push: (chunk: any) => string, flush: () => string }}
 */
export function createToolCallRecoveryStreamFilter(allowed) {
  const decoder = new TextDecoder()
  let line = ''
  let contentSeen = ''
  /** Absolute index in `contentSeen` where the withheld run starts, or -1. */
  let parkStart = -1
  /** Whether the withheld run is a complete marker, and so is held to the end of the stream. */
  let holding = false
  /** Where a new run may begin. Set past a release so a rejected brace is not re-examined. */
  let scanFrom = 0
  /** Non-content lines received after the hold began (finish, usage, `[DONE]`, blanks). */
  let trailing = []
  /** The first frame's identity, so a synthesized frame describes the same completion. */
  let framing = null

  const frameLine = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id: framing?.id || 'chatcmpl-recovered',
      object: 'chat.completion.chunk',
      ...(framing && framing.created != null ? { created: framing.created } : {}),
      ...(framing && framing.model ? { model: framing.model } : {}),
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  /** Gives back every withheld byte, because the run turned out to be the answer. */
  const release = () => {
    const text = contentSeen.slice(parkStart)
    const out = (text ? frameLine({ content: text }) : '') + trailing.join('')
    trailing = []
    parkStart = -1
    holding = false
    scanFrom = contentSeen.length
    return out
  }

  /** Handles one complete line and returns what the client should now receive. */
  const handleLine = (raw) => {
    const frame = parseDataFrame(raw)
    if (!frame) {
      if (parkStart >= 0) {
        trailing.push(raw)
        return ''
      }
      return raw
    }
    if (!framing && frame.id) {
      framing = { id: frame.id, model: frame.model, created: frame.created }
    }
    const delta = frame?.choices?.[0]?.delta
    const content = typeof delta?.content === 'string' ? delta.content : null
    if (content == null) {
      if (parkStart >= 0) {
        trailing.push(raw)
        return ''
      }
      return raw
    }
    contentSeen += content
    if (parkStart >= 0) {
      // A marker is held to the end: its argument object follows and belongs to the call.
      if (holding) return ''
      const kind = openingKind(contentSeen.slice(parkStart))
      if (kind === 'marker') {
        holding = true
        return ''
      }
      // Still able to become one. Keep waiting, without sending anything.
      if (kind) return ''
      // It diverged — `{curly}`, `{"note":`, a quoted sentence. Hand back every withheld byte
      // and stop treating the rest of the answer as suspect.
      return release()
    }
    const start = pendingStart(contentSeen, scanFrom)
    if (start < 0) return raw
    parkStart = start
    holding = openingKind(contentSeen.slice(start)) === 'marker'
    // Keep whatever prose shared this frame; only the suspected envelope is withheld.
    const keep = content.slice(0, Math.max(0, content.length - (contentSeen.length - start)))
    if (!keep) return ''
    const choices = frame.choices.map((choice, index) =>
      index === 0 ? { ...choice, delta: { ...choice.delta, content: keep } } : choice,
    )
    return rewriteFrameLine(raw, { ...frame, choices })
  }

  return {
    push(chunk) {
      if (!chunk) return ''
      line += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let out = ''
      let index = line.indexOf('\n')
      while (index >= 0) {
        out += handleLine(line.slice(0, index + 1))
        line = line.slice(index + 1)
        index = line.indexOf('\n')
      }
      return out
    },
    flush() {
      line += decoder.decode()
      let out = ''
      if (line) {
        out += handleLine(line)
        line = ''
      }
      if (parkStart < 0) return out
      const recovered = recoverSerializedToolCalls(contentSeen.slice(parkStart), allowed)
      if (!recovered) return out + release()
      const calls = recovered.toolCalls.map((call, index) => ({ index, ...call }))
      let frames = frameLine({ tool_calls: calls })
      let finished = false
      for (const raw of trailing) {
        const frame = parseDataFrame(raw)
        const choice = frame?.choices?.[0]
        if (choice && choice.finish_reason) {
          // One finish frame, saying what this turn actually did.
          if (!finished) {
            const choices = frame.choices.map((entry, index) =>
              index === 0 ? { ...entry, finish_reason: 'tool_calls' } : entry,
            )
            frames += rewriteFrameLine(raw, { ...frame, choices })
            finished = true
          }
          continue
        }
        if (raw.trim() === 'data: [DONE]' && !finished) {
          frames += frameLine({}, 'tool_calls')
          finished = true
        }
        frames += raw
      }
      if (!finished) frames += frameLine({}, 'tool_calls')
      return out + frames
    },
  }
}
