/**
 * FreeModels continuity helpers.
 *
 * FreeModels is a stateless relay: its own web client stores the transcript in
 * localStorage and sends the messages again on every request. There is no upstream
 * conversation id to replay. This module gives Hammer a safe local equivalent for
 * clients that opt in with an explicit conversation id, plus the same bounded
 * context window the public client uses.
 *
 * The store never guesses a thread from an IP address or a `user` field. A caller
 * that wants server-side continuity must name the conversation explicitly.
 */

export const FREEMODELS_CONTEXT_MESSAGES = 40
export const FREEMODELS_CONTEXT_BYTES = 512 * 1024
export const FREEMODELS_STORE_TTL_MS = 30 * 60 * 1000
export const FREEMODELS_STORE_MAX_CONVERSATIONS = 128
export const FREEMODELS_STORE_MAX_MESSAGES = 256
export const FREEMODELS_STORE_MAX_BYTES = 1024 * 1024

function clone(value) {
  if (value == null) return value
  try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.input_text === 'string') return part.input_text
    return ''
  }).join('')
}

function messageKey(message) {
  try { return JSON.stringify(message) } catch { return '' }
}

function hasTextValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasToolCallValue(call) {
  return hasTextValue(call?.id)
    || hasTextValue(call?.function?.name)
    || hasTextValue(call?.function?.arguments)
}

function hasFunctionCallValue(call) {
  return hasTextValue(call?.name) || hasTextValue(call?.arguments)
}

function validMessage(message) {
  return Boolean(message && typeof message === 'object' && !Array.isArray(message)
    && typeof message.role === 'string' && message.role.trim())
}

function normalizeMessage(message) {
  if (!validMessage(message)) return null
  const next = clone(message)
  next.role = next.role.trim()
  return next
}

function normalizeMessages(messages) {
  return Array.isArray(messages) ? messages.map(normalizeMessage).filter(Boolean) : []
}

function isPrefix(prefix, full) {
  if (prefix.length > full.length) return false
  return prefix.every((message, index) => messageKey(message) === messageKey(full[index]))
}

function suffixMatch(previous, incoming) {
  const max = Math.min(previous.length, incoming.length)
  for (let size = max; size > 0; size -= 1) {
    const start = previous.length - size
    if (isPrefix(incoming.slice(0, size), previous.slice(start))) return size
  }
  return 0
}

function isInstruction(message) {
  return message.role === 'system' || message.role === 'developer'
}

function trimMessages(messages, maxMessages, maxBytes) {
  const all = normalizeMessages(messages)
  const messageLimit = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : all.length
  const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Infinity
  const instructionIndexes = new Set()
  for (let index = 0; index < all.length; index += 1) {
    if (isInstruction(all[index])) instructionIndexes.add(index)
  }

  // Keep instruction turns wherever the caller placed them. Hoisting every system and
  // developer message to the front changes a mid-conversation developer instruction into
  // a global one, so selection must retain original indexes rather than rebuild a list
  // from separately filtered roles.
  const selectedIndexes = new Set()
  if (all.length <= messageLimit) {
    for (let index = 0; index < all.length; index += 1) selectedIndexes.add(index)
  } else if (instructionIndexes.size >= messageLimit) {
    // Pathological transcripts can contain more instruction turns than the entire
    // context budget. Honoring the hard count limit is more important than retaining
    // every instruction; keep the newest ones in their original order.
    const instructionOrder = [...instructionIndexes]
    for (const index of messageLimit > 0 ? instructionOrder.slice(-messageLimit) : []) selectedIndexes.add(index)
  } else {
    for (const index of instructionIndexes) selectedIndexes.add(index)
    let conversationalSlots = messageLimit - instructionIndexes.size
    for (let index = all.length - 1; index >= 0 && conversationalSlots > 0; index -= 1) {
      if (instructionIndexes.has(index)) continue
      selectedIndexes.add(index)
      conversationalSlots -= 1
    }
  }
  let selected = all.filter((_, index) => selectedIndexes.has(index))

  // Drop the oldest conversational turns first. If instructions alone still exceed
  // the byte budget, shorten one before removing any; this keeps the memory bound hard
  // even though the accepted request body can be several megabytes.
  while (selected.length > 0 && byteLength(selected) > byteLimit) {
    const firstConversation = selected.findIndex(message => !isInstruction(message))
    if (firstConversation >= 0) {
      selected.splice(firstConversation, 1)
      continue
    }

    const oversizedInstruction = selected.findIndex(message => {
      const content = message.content == null ? '' : (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
      return typeof content === 'string' && content.length > 0
    })
    if (oversizedInstruction < 0) {
      if (selected.length > 0) selected.splice(0, 1)
      continue
    }

    const original = selected[oversizedInstruction].content
    const text = typeof original === 'string' ? original : JSON.stringify(original)
    selected[oversizedInstruction].content = ''
    let length = Math.min(text.length, Math.max(0, byteLimit - byteLength(selected)))
    while (length > 0) {
      selected[oversizedInstruction].content = text.slice(0, length)
      if (byteLength(selected) <= byteLimit) break
      length = Math.floor(length / 2)
    }
    if (length === 0) selected[oversizedInstruction].content = ''
  }
  return selected
}

function byteLength(messages) {
  try { return new TextEncoder().encode(JSON.stringify(messages)).byteLength } catch { return 0 }
}

/**
 * Convert an OpenAI transcript to the role/content shape used by FreeModels' own
 * client. Tool calls are represented as text instead of being silently discarded;
 * this is a continuity format, not a fabricated native tool-call protocol.
 */
export function normalizeFreeModelsMessage(message) {
  const normalized = normalizeMessage(message)
  if (!normalized) return null
  const role = normalized.role
  let content = normalized.content
  if (content == null) content = ''
  if (role === 'assistant') {
    const activity = []
    if (Array.isArray(normalized.tool_calls) && normalized.tool_calls.length > 0) {
      activity.push(...normalized.tool_calls.map(call => {
        const fn = call?.function || {}
        return `[tool_call name=${fn.name || 'tool'} arguments=${fn.arguments || '{}'}]`
      }))
    }
    if (normalized.function_call && typeof normalized.function_call === 'object') {
      activity.push(`[function_call name=${normalized.function_call.name || 'tool'} arguments=${normalized.function_call.arguments || '{}'}]`)
    }
    if (activity.length > 0) content = [textOf(content), ...activity].filter(Boolean).join('\n')
  }
  return { role, content }
}

/**
 * Match the public client's bounded replay: retain every system/developer turn and
 * fill the remaining slots with the newest conversational turns.
 */
export function packFreeModelsMessages(messages, {
  maxMessages = FREEMODELS_CONTEXT_MESSAGES,
  maxBytes = FREEMODELS_CONTEXT_BYTES,
} = {}) {
  const normalized = normalizeMessages(messages).map(normalizeFreeModelsMessage).filter(Boolean)
  return trimMessages(normalized, maxMessages, maxBytes)
}

export function normalizeConversationId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > 200) return null
  return id
}

/**
 * A small in-memory, TTL-bounded conversation store. `merge` treats the incoming
 * transcript as authoritative unless it is demonstrably a continuation of the
 * stored one. A client sending an unrelated transcript resets the entry rather than
 * allowing a guessed merge to contaminate it.
 */
export function createFreeModelsConversationStore({
  now = () => Date.now(),
  ttlMs = FREEMODELS_STORE_TTL_MS,
  maxConversations = FREEMODELS_STORE_MAX_CONVERSATIONS,
  maxMessages = FREEMODELS_STORE_MAX_MESSAGES,
  maxBytes = FREEMODELS_STORE_MAX_BYTES,
} = {}) {
  const entries = new Map()
  let nextTurnId = 0

  function prune() {
    const currentTime = now()
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(id)
    }
    while (entries.size > maxConversations) {
      entries.delete(entries.keys().next().value)
    }
  }

  function save(id, messages, markers = []) {
    // Carry turn identity through the trimming clone on a private field, then remove it
    // before anything is returned or retained. Matching markers by message content would
    // misattach a late reply when trimming removes the older of two identical user turns.
    const markerField = '\u0000hammer.freeModels.turnIds'
    const byIndex = new Map()
    for (const marker of markers) {
      const list = byIndex.get(marker.index) || []
      list.push(marker.turnId)
      byIndex.set(marker.index, list)
    }
    const tagged = normalizeMessages(messages).map((message, index) => {
      const turnIds = byIndex.get(index)
      return turnIds ? { ...message, [markerField]: turnIds } : message
    })
    const normalized = trimMessages(tagged, maxMessages, maxBytes)
    const retainedMarkers = []
    normalized.forEach((message, index) => {
      const turnIds = message[markerField]
      delete message[markerField]
      if (!Array.isArray(turnIds) || turnIds.length === 0) return
      for (const turnId of turnIds) retainedMarkers.push({ turnId, index })
    })

    const entry = {
      messages: normalized,
      markers: retainedMarkers.sort((a, b) => a.index - b.index),
      bytes: byteLength(normalized),
      expiresAt: now() + ttlMs,
    }
    entries.delete(id)
    entries.set(id, entry)
    prune()
    return clone(normalized)
  }

  function mergedState(idValue, incoming) {
    const id = normalizeConversationId(idValue)
    const messages = normalizeMessages(incoming)
    if (!id) return { id: null, messages, markers: [] }
    prune()
    const entry = entries.get(id)
    const previous = entry?.messages || []
    const previousMarkers = entry?.markers || []
    let merged
    let markers = previousMarkers
    if (!previous.length) merged = messages
    else if (isPrefix(previous, messages)) merged = messages
    else if (isPrefix(messages, previous)) merged = previous
    else {
      const overlap = suffixMatch(previous, messages)
      const previousUserIndex = previous.findLastIndex(message => message.role === 'user')
      const repeatsLastUser = messages.length === 1 && previousUserIndex >= 0
        && messageKey(previous[previousUserIndex]) === messageKey(messages[0])
      if (repeatsLastUser) merged = previous
      else if (overlap > 0) merged = [...previous, ...messages.slice(overlap)]
      else if (messages.length === 1) merged = [...previous, ...messages]
      else {
        merged = messages
        // A multi-turn transcript with no demonstrable overlap is authoritative and
        // supersedes turns whose late responses must no longer be spliced into it.
        markers = []
      }
    }
    // Do not append a repeated short request when a client retries the same turn.
    if (merged.length > previous.length && merged.length === previous.length + 1
      && messageKey(merged.at(-1)) === messageKey(merged.at(-2))) merged = previous
    return { id, messages: merged, markers }
  }

  function merge(idValue, incoming) {
    const state = mergedState(idValue, incoming)
    return state.id ? save(state.id, state.messages, state.markers) : clone(state.messages)
  }

  function beginTurn(idValue, incoming) {
    const state = mergedState(idValue, incoming)
    if (!state.id) return { turnId: null, messages: clone(state.messages) }
    if (!state.messages.length) return { turnId: null, messages: [] }
    const turnId = `turn-${++nextTurnId}`
    const messages = save(state.id, state.messages, [
      ...state.markers,
      { turnId, index: state.messages.length - 1 },
    ])
    return { turnId, messages }
  }

  function appendAssistant(idValue, assistant, turnId = null) {
    const id = normalizeConversationId(idValue)
    if (!id) return []
    prune()
    const entry = entries.get(id)
    const previous = entry?.messages || []
    const message = normalizeMessage({ ...assistant, role: 'assistant' })
    if (!message) return clone(previous)

    if (turnId) {
      const marker = entry?.markers?.find(candidate => candidate.turnId === turnId)
      // No marker means a full transcript superseded this in-flight turn. Appending at
      // the tail now would put its answer after an unrelated later user message.
      if (!marker) return clone(previous)
      const insertAt = marker.index + 1
      const messages = [...previous]
      messages.splice(insertAt, 0, message)
      const markers = entry.markers
        .filter(candidate => candidate.turnId !== turnId)
        .map(candidate => candidate.index >= insertAt
          ? { turnId: candidate.turnId, index: candidate.index + 1 }
          : candidate)
      return save(id, messages, markers)
    }

    if (previous.length && messageKey(previous.at(-1)) === messageKey(message)) return clone(previous)
    return save(id, [...previous, message], entry?.markers || [])
  }

  return {
    merge,
    beginTurn,
    appendAssistant,
    get(idValue) {
      const id = normalizeConversationId(idValue)
      if (!id) return []
      prune()
      return clone(entries.get(id)?.messages || [])
    },
    clear(idValue) {
      const id = normalizeConversationId(idValue)
      if (id) entries.delete(id)
    },
    get size() { prune(); return entries.size },
  }
}

export function extractFreeModelsAssistantMessage(text) {
  if (text == null) return null
  const raw = String(text)
  const frames = []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try { frames.push(JSON.parse(trimmed)) } catch { /* SSE below */ }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const value = line.slice(5).trim()
    if (!value || value === '[DONE]') continue
    try { frames.push(JSON.parse(value)) } catch { /* partial frame */ }
  }
  let content = ''
  let reasoning = ''
  const toolCalls = new Map()
  let functionCall = null
  for (const frame of frames) {
    const choice = frame?.choices?.[0]
    const delta = choice?.delta || choice?.message || {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!hasToolCallValue(call)) continue
      const index = Number.isInteger(call?.index) ? call.index : toolCalls.size
      const current = toolCalls.get(index) || { id: call?.id || '', type: call?.type || 'function', function: { name: '', arguments: '' } }
      if (call?.id) current.id = call.id
      if (call?.type) current.type = call.type
      if (call?.function?.name) current.function.name += call.function.name
      if (call?.function?.arguments) current.function.arguments += call.function.arguments
      toolCalls.set(index, current)
    }
    if (hasFunctionCallValue(delta.function_call)) {
      functionCall = functionCall || { name: '', arguments: '' }
      if (delta.function_call.name) functionCall.name += delta.function_call.name
      if (delta.function_call.arguments) functionCall.arguments += delta.function_call.arguments
    }
  }
  if (!hasTextValue(content) && !hasTextValue(reasoning) && toolCalls.size === 0 && !functionCall) return null
  const message = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  if (functionCall) message.function_call = functionCall
  return message
}
