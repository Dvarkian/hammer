/*
 * harness.js — the agent workspace.
 *
 * The router already owns an agent: `/api/pi/*` drives a child process that runs a full turn
 * (tool calls, edits, shell) and streams every step as events. This module is the page in
 * front of it. It is separate from dashboard.js on purpose — that file is the router's
 * instrumentation, this one is the harness, and neither should have to know the other's DOM.
 *
 * What the harness shows, and why each thing is here:
 *   - the transcript, folded from the event stream the same way the server folds it, so a
 *     reload replays the conversation instead of losing it;
 *   - which model is answering, because Hammer's whole point is that the agent does not pick
 *     its own model — the router does, and the badge says so;
 *   - the workspace the agent is editing, the session it is writing, and its token usage;
 *   - the controls a harness needs: send/steer, stop, new session, restart, and resume.
 */
;(function () {
  'use strict'

  const API = '/api/pi'
  const VIEW_KEY = 'hammer.hx.view'
  const MAX_TEXT = 120000
  const MAX_TOOL = 24000

  const state = {
    items: [],
    mounted: 0,
    phase: 'idle',
    running: false,
    sending: false,
    status: null,
    usage: null,
    sessions: [],
    sessionQuery: '',
    source: null,
    patchQueued: false,
    notesSeen: new Set(),
    tools: new Map(),
    view: 'agent',
  }

  // ── Small helpers ───────────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id)

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function clip(text, limit) {
    const value = String(text == null ? '' : text)
    if (value.length <= limit) return value
    return `… ${value.length - limit} characters trimmed …\n${value.slice(-limit)}`
  }

  /**
   * The agent answers in Markdown, and a harness is where people read code. Fenced blocks and
   * inline code get real elements; everything else stays text, so nothing the model writes can
   * become markup on this page.
   */
  function renderText(text) {
    const escaped = escapeHtml(clip(text, MAX_TEXT))
    return escaped
      .split(/```/)
      .map((chunk, index) => {
        if (index % 2 === 1) {
          return `<pre class="hx-code">${chunk.replace(/^\n/, '')}</pre>`
        }
        return chunk
          .replace(/`([^`\n]+)`/g, '<code class="hx-inline-code">$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>')
      })
      .join('')
  }

  function setHint(text, tone) {
    const el = $('hx-hint')
    if (!el) return
    el.textContent = text || ''
    if (tone) el.dataset.tone = tone
    else delete el.dataset.tone
  }

  // ── View switch ─────────────────────────────────────────────────────────────────────

  /**
   * Two surfaces: the agent, and the router behind it. Telemetry keeps its own tabs; this only
   * decides which half of the app is on screen (see the `data-view` rules in harness.css).
   */
  function showView(view) {
    state.view = view === 'router' ? 'router' : 'agent'
    document.body.dataset.view = state.view
    $('hx-nav-agent')?.classList.toggle('active', state.view === 'agent')
    $('hx-nav-router')?.classList.toggle('active', state.view === 'router')
    try {
      localStorage.setItem(VIEW_KEY, state.view)
    } catch {
      // A private-mode browser without storage still gets a working switch.
    }

    if (state.view === 'router') {
      // The telemetry views were laid out at zero size while hidden, so plots and the model
      // table have to be measured again now that they have space.
      const tab = document.querySelector('.tabs .tab.active')?.id?.replace(/^tab-/, '') || 'models'
      window.switchTab?.(tab)
      if (typeof window.fetchData === 'function') window.fetchData().catch(() => {})
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    } else {
      $('hx-input')?.focus()
    }
  }

  // ── Rendering the transcript ────────────────────────────────────────────────────────

  const EMPTY_MARKUP = `
    <div class="hx-empty">
      <svg class="hx-empty-mark" viewBox="0 0 32 32" aria-hidden="true">
        <g transform="translate(-0.17 2.22) rotate(-32 16 16) translate(16 16) scale(1.05) translate(-16 -16)">
          <path d="M11.75 8.6L15.25 8.6C15.15 13 15 18 15 20.8C15 22.8 15.2 24.6 15.25 25.8C15.3 27.3 14.7 27.9 13.5 27.9C12.3 27.9 11.7 27.3 11.75 25.8C11.8 24.6 12 22.8 12 20.8C12 18 11.85 13 11.75 8.6Z" fill="currentColor"/>
          <path d="M21.6 6.9L22.6 7.5L22.6 10.9L21.8 11.3C18.8 11.9 16.2 11.9 13.8 11.4C12.2 11.1 11 10.3 10.2 9.2C9 10.4 7.4 11.9 6.4 13.1C6 13.6 5.4 13.4 5.4 12.8C5.3 11.2 5.6 9.4 6.5 8C7.5 6.7 9 6.3 10.4 6.1C13.8 5.8 18.2 6.2 21.6 6.9Z" fill="var(--hx-brand)"/>
        </g>
      </svg>
      <h3>What should Hammer build?</h3>
      <p>This agent edits the workspace, runs commands and reads files. Every call it makes is
         routed by Hammer, so the model behind it changes with the router's ranking.</p>
      <div class="hx-suggestions">
        <button class="hx-suggestion" data-prompt="Summarise this repository: what it does, how it is laid out, and where the risky parts are.">Summarise this repo</button>
        <button class="hx-suggestion" data-prompt="Run the test suite and fix whatever fails.">Run tests and fix failures</button>
        <button class="hx-suggestion" data-prompt="Find the three most important TODOs in this codebase and propose fixes.">Find and fix TODOs</button>
        <button class="hx-suggestion" data-prompt="Review the working tree diff for bugs, then explain each change.">Review my changes</button>
      </div>
    </div>`

  function toolSummary(item) {
    const args = item.args
    if (!args || typeof args !== 'object') return ''
    const raw =
      args.command ||
      args.path ||
      args.file_path ||
      args.pattern ||
      args.query ||
      args.url ||
      args.description ||
      ''
    return clip(String(raw).replace(/\s+/g, ' '), 160)
  }

  function assistantMarkup(item) {
    const blocks = item.blocks || []
    const role = '<div class="hx-role">Hammer</div>'
    if (!blocks.length) {
      return `${role}<div class="hx-assistant hx-pending">…</div>`
    }
    const body = blocks
      .map((block) => {
        if (block.kind === 'thinking') {
          return `<div class="hx-thinking"><div class="hx-block-label">thinking</div><div class="hx-thinking-text">${renderText(block.text || '')}</div></div>`
        }
        return `<div>${renderText(block.text || '')}</div>`
      })
      .join('')
    return `${role}<div class="hx-assistant">${body}</div>`
  }

  function toolStateLabel(item) {
    if (item.status === 'preparing') return 'preparing'
    if (item.status === 'running') return 'running'
    if (item.status === 'error') return 'failed'
    return 'done'
  }

  /**
   * A tool call is one line of the log; its output is what you open when you need it. The whole
   * line is the disclosure, so a turn with forty calls is forty lines rather than forty boxes —
   * and a failed call still reads as failed without expanding anything.
   */
  function toolMarkup(item) {
    const output = item.result || item.partial || ''
    const took = item.durationMs != null ? `${(item.durationMs / 1000).toFixed(2)}s` : ''
    const meta = [toolStateLabel(item), took].filter(Boolean).join(' · ')
    // Anything but a finished call shows its output: a running command is what you want to
    // read, and a failed one is what you need to read.
    const open = output && (item.open || item.status !== 'ok') ? ' open' : ''
    const body = output
      ? `<pre class="hx-tool-out">${escapeHtml(output)}</pre>`
      : ''
    return `<details class="hx-tool ${item.status}${output ? '' : ' hx-tool-empty'}"${open}>
          <summary class="hx-tool-head">
            <span class="hx-tool-dot" aria-hidden="true"></span>
            <span class="hx-tool-name">${escapeHtml(item.name || 'tool')}</span>
            <span class="hx-tool-cmd">${escapeHtml(toolSummary(item))}</span>
            <span class="hx-tool-state">${escapeHtml(meta)}</span>
          </summary>
          ${body}
        </details>`
  }

  function itemMarkup(item) {
    if (item.kind === 'user') {
      return `<div class="hx-role">You</div><div class="hx-turn-text">${escapeHtml(item.text)}</div>`
    }
    if (item.kind === 'assistant') return assistantMarkup(item)
    if (item.kind === 'tool') return toolMarkup(item)
    const tone = item.tone === 'error' ? ' error' : item.tone === 'success' ? ' success' : ''
    return `<div class="hx-notice${tone}"><span class="hx-notice-text">${escapeHtml(item.text)}</span></div>`
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function syncTranscript({ reset = false } = {}) {
    const transcript = $('hx-transcript')
    if (!transcript) return
    if (reset) {
      transcript.innerHTML = ''
      state.mounted = 0
    }
    if (!state.items.length) {
      transcript.innerHTML = EMPTY_MARKUP
      state.mounted = 0
      return
    }
    if (transcript.querySelector('.hx-empty')) transcript.innerHTML = ''
    const stick = atBottom(transcript)
    for (let i = state.mounted; i < state.items.length; i += 1) {
      const item = state.items[i]
      const row = document.createElement('div')
      row.className = `hx-row hx-row-${item.kind}`
      row.innerHTML = itemMarkup(item)
      item.node = row
      transcript.appendChild(row)
    }
    state.mounted = state.items.length
    if (stick) transcript.scrollTop = transcript.scrollHeight
    const jump = $('hx-jump')
    if (jump) jump.style.display = atBottom(transcript) ? 'none' : ''
  }

  /** A streamed desktop turn is one growing element, not a rebuilt transcript. */
  function patchStreamingItem() {
    if (state.patchQueued) return
    state.patchQueued = true
    requestAnimationFrame(() => {
      state.patchQueued = false
      const item = state.items[state.items.length - 1]
      if (!item || item.kind !== 'assistant' || !item.node) {
        syncTranscript()
        return
      }
      const transcript = $('hx-transcript')
      const stick = transcript && atBottom(transcript)
      if (item.node) item.node.innerHTML = assistantMarkup(item)
      if (stick && transcript) transcript.scrollTop = transcript.scrollHeight
    })
  }

  function lastAssistant() {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      if (state.items[i].kind === 'assistant') return state.items[i]
    }
    return null
  }

  function appendDelta(kind, contentIndex, delta) {
    const item = lastAssistant()
    if (!item) return
    let block = item.blocks.find(
      (candidate) => candidate.kind === kind && candidate.index === contentIndex,
    )
    if (!block) {
      block = { kind, index: contentIndex, text: '' }
      item.blocks.push(block)
      // Pi restarts `contentIndex` at 0 for every assistant message and grows it in production
      // order, so the index is the model's order — not the order the frames happened to arrive.
      item.blocks.sort((a, b) => a.index - b.index)
    }
    block.text = clip(block.text + (delta || ''), MAX_TEXT)
    patchStreamingItem()
  }

  function ensureTool(id, name) {
    const key = String(id || name || 'tool')
    let item = state.tools.get(key)
    if (item) return item
    item = { kind: 'tool', id: key, name: name || 'tool', args: null, status: 'preparing', result: '', partial: '' }
    state.tools.set(key, item)
    state.items.push(item)
    syncTranscript()
    return item
  }

  function contentParts(content) {
    if (!Array.isArray(content)) return []
    const blocks = []
    content.forEach((part, index) => {
      if (!part || typeof part !== 'object') return
      const kind =
        part.type === 'thinking' || part.type === 'reasoning'
          ? 'thinking'
          : part.type === 'text'
            ? 'text'
            : null
      if (kind && typeof part.text === 'string' && part.text) {
        blocks.push({ kind, index, text: clip(part.text, MAX_TEXT) })
      }
    })
    return blocks
  }

  function textFromBlocks(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((part) =>
        typeof part === 'string' ? part : part && part.type === 'text' ? part.text : '',
      )
      .filter(Boolean)
      .join('')
  }

  function resultText(result) {
    if (!result) return ''
    if (typeof result === 'string') return result
    const text = textFromBlocks(result.content)
    if (text) return text
    try {
      return JSON.stringify(result.details != null ? result.details : result, null, 2)
    } catch {
      return ''
    }
  }

  /**
   * Folds one event into the transcript. The shapes are Pi's RPC events; the rules are the
   * same ones the router's own console applies, because a second interpretation of the same
   * stream would show a different conversation than the one the agent actually had.
   */
  function applyRecord(record) {
    if (!record || typeof record !== 'object') return
    switch (record.type) {
      case 'agent_start':
        setRunning(true)
        break
      case 'agent_settled':
        setRunning(false)
        break
      case 'message_start': {
        const message = record.message || {}
        if (message.role === 'user') {
          state.items.push({ kind: 'user', text: textFromBlocks(message.content) })
          syncTranscript()
        } else if (message.role === 'assistant') {
          state.items.push({ kind: 'assistant', blocks: [] })
          syncTranscript()
        }
        break
      }
      case 'message_update': {
        const update = record.assistantMessageEvent || {}
        if (update.type === 'text_delta') appendDelta('text', update.contentIndex, update.delta)
        else if (update.type === 'thinking_delta')
          appendDelta('thinking', update.contentIndex, update.delta)
        else if (update.type === 'toolcall_start') ensureTool(update.id, update.toolName)
        else if (update.type === 'toolcall_end') {
          const call = update.toolCall || {}
          const item = ensureTool(call.id || update.id, call.name || update.toolName)
          if (call.arguments) item.args = call.arguments
          syncTranscript({ reset: true })
        }
        break
      }
      case 'message_end': {
        const message = record.message || {}
        if (message.role === 'assistant') {
          const item = lastAssistant()
          if (item) {
            const streamed = item.blocks.some((block) => block.text)
            if (!streamed) item.blocks = contentParts(message.content)
            if (!item.blocks.length && item.node) {
              // A turn that produced nothing leaves no empty bubble; the notice explains it.
              state.items.splice(state.items.indexOf(item), 1)
              syncTranscript({ reset: true })
            } else {
              syncTranscript({ reset: true })
            }
          }
          const failure =
            message.errorMessage ||
            (message.stopReason === 'error' ? 'The model call failed.' : '')
          if (failure) {
            state.items.push({
              kind: 'notice',
              tone: 'error',
              text: String(failure).replace(/\s+/g, ' ').trim().slice(0, 800),
            })
            syncTranscript()
          }
        }
        break
      }
      case 'tool_execution_start': {
        const item = ensureTool(record.toolCallId, record.toolName)
        if (record.args) item.args = record.args
        item.status = 'running'
        syncTranscript()
        break
      }
      case 'tool_execution_update': {
        const item = ensureTool(record.toolCallId, record.toolName)
        item.partial = clip(resultText(record.partialResult), MAX_TOOL)
        item.status = 'running'
        syncTranscript()
        break
      }
      case 'tool_execution_end': {
        const item = ensureTool(record.toolCallId, record.toolName)
        item.status = record.isError ? 'error' : record.isError === false ? 'ok' : 'ok'
        item.result = clip(resultText(record.result), MAX_TOOL)
        item.partial = ''
        if (record.durationMs != null) item.durationMs = record.durationMs
        syncTranscript()
        break
      }
      case 'turn_end':
      case 'message_finished':
        break
      default:
        break
    }
  }

  // ── Status and routing ──────────────────────────────────────────────────────────────

  function setRunning(running) {
    state.running = Boolean(running)
    updateComposer()
  }

  function setPhase(phase) {
    state.phase = phase || 'idle'
    const pill = $('hx-phase')
    const label = $('hx-phase-label')
    if (pill) pill.dataset.phase = state.phase
    if (label) label.textContent = state.phase === 'dead' ? 'down' : state.phase
  }

  function renderRouting(data) {
    if (!data) return
    const model = data.model
    const nameEl = $('hx-model-name')
    const providerEl = $('hx-model-provider')
    const badgeEl = $('hx-routed-badge')
    const thinkingEl = $('hx-thinking-level')
    if (nameEl) nameEl.textContent = model ? model.name || model.id || 'unknown' : 'no model yet'
    if (providerEl) providerEl.textContent = model ? model.provider || 'provider' : '—'
    if (badgeEl) {
      // `routed` is the server's answer to "does the agent take its model from this router",
      // which is the whole reason a routing harness has an agent at all.
      const routed = data.routed !== false
      badgeEl.textContent = routed ? 'routed by Hammer' : 'fixed model'
      badgeEl.classList.toggle('off', !routed)
      badgeEl.title = routed
        ? 'The agent asks Hammer for `best`; the router picks the model per turn.'
        : 'A model is named in ~/.hammer.json, so routing is bypassed for the agent.'
    }
    if (thinkingEl) {
      thinkingEl.textContent =
        data.thinkingLevel && data.thinkingLevel !== 'off' ? data.thinkingLevel : 'off'
    }
    if (data.cwd) {
      const cwdEl = $('hx-cwd')
      if (cwdEl) {
        cwdEl.textContent = data.cwd
        cwdEl.title = data.cwd
      }
    }
    const sessionEl = $('hx-session-name')
    if (sessionEl) {
      const file = data.sessionFile
      sessionEl.textContent = data.sessionName || (file ? file.split('/').pop().replace(/\.jsonl$/, '') : 'new session')
      sessionEl.title = file || ''
    }
    if (Array.isArray(data.notes)) {
      let added = false
      for (const note of data.notes) {
        if (state.notesSeen.has(note)) continue
        state.notesSeen.add(note)
        state.items.push({ kind: 'notice', tone: 'info', text: note })
        added = true
      }
      if (added) syncTranscript()
    }
    if (data.available === false) {
      const strip = $('hx-route-strip')
      if (strip) strip.dataset.unavailable = '1'
      setHint(`Agent unavailable — ${data.error || 'the pi runtime was not found'}`, 'error')
    }
  }

  function renderUsage() {
    const usage = state.usage
    const el = $('hx-usage-text')
    const bar = $('hx-usage-fill')
    if (!el) return
    if (!usage) {
      el.textContent = 'No tokens reported yet'
      if (bar) bar.style.width = '0%'
      return
    }
    const input = Number(usage.inputTokens ?? usage.input ?? usage.totalInputTokens ?? 0)
    const output = Number(usage.outputTokens ?? usage.output ?? usage.totalOutputTokens ?? 0)
    const total = Number(usage.totalTokens ?? usage.total ?? 0) || input + output
    el.textContent = `${input.toLocaleString()} in · ${output.toLocaleString()} out`
    if (bar) {
      // A context meter without a declared window is still useful as a magnitude bar; it is
      // labelled as a share of the turn, not of a limit we were not told.
      const context = Number(usage.contextTokens ?? usage.context ?? 0)
      const share = total > 0 ? Math.min(100, Math.round((context / total) * 100)) : 0
      bar.style.width = `${share}%`
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch(`${API}/status`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `status ${res.status}`)
      state.status = data
      setPhase(data.phase)
      setRunning(data.phase === 'busy' || Boolean(data.isStreaming))
      renderRouting(data)
      if (data.usage) {
        state.usage = data.usage
        renderUsage()
      }
      updateComposer()
    } catch (err) {
      setHint(`Could not reach the agent: ${err?.message || err}`, 'error')
      setPhase('dead')
    }
  }

  function updateComposer() {
    const send = $('hx-send')
    const stop = $('hx-stop')
    const unavailable = Boolean(state.status && state.status.available === false)
    if (send) {
      send.disabled = state.sending || unavailable
      send.textContent = state.running ? 'Steer' : 'Send'
    }
    if (stop) stop.disabled = !state.running
  }

  // ── The event stream ────────────────────────────────────────────────────────────────

  function connectEvents() {
    if (state.source) return
    if (!window.EventSource) {
      setHint('This browser cannot stream the agent transcript.', 'error')
      return
    }
    const source = new EventSource(`${API}/events`)
    state.source = source
    source.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === 'hello') {
        // The server's replay log is the transcript; a page opened mid-run catches up instead
        // of starting from whatever this tab happened to witness.
        state.items = []
        state.tools.clear()
        state.mounted = 0
        state.notesSeen.clear()
        ;(payload.log || []).forEach(applyRecord)
        if (payload.status) {
          state.status = payload.status
          setPhase(payload.status.phase)
          setRunning(payload.status.phase === 'busy' || Boolean(payload.status.isStreaming))
          renderRouting(payload.status)
        }
        updateComposer()
        syncTranscript({ reset: true })
        return
      }
      if (payload.type === 'event') {
        applyRecord(payload.record)
        return
      }
      if (payload.type === 'status' && payload.status) {
        state.status = payload.status
        setPhase(payload.status.phase)
        setRunning(payload.status.phase === 'busy' || Boolean(payload.status.isStreaming))
        renderRouting(payload.status)
        updateComposer()
        return
      }
      if (payload.type === 'usage') {
        state.usage = payload.usage || payload
        renderUsage()
        return
      }
      if (payload.type === 'log' && payload.text) {
        state.items.push({ kind: 'notice', tone: 'info', text: String(payload.text).slice(0, 500) })
        syncTranscript()
        return
      }
      if (payload.type === 'exit') {
        setRunning(false)
        state.items.push({
          kind: 'notice',
          tone: 'error',
          text: payload.message || 'The agent exited.',
        })
        syncTranscript()
        refreshStatus()
        return
      }
      if (payload.type === 'notice' && payload.text) {
        state.items.push({ kind: 'notice', tone: 'info', text: String(payload.text) })
        syncTranscript()
      }
    }
    source.onerror = () => setHint('Lost the event stream — reconnecting…', 'error')
    source.onopen = () => setHint('')
  }

  // ── Controls ────────────────────────────────────────────────────────────────────────

  async function sendPrompt() {
    const input = $('hx-input')
    if (!input || state.sending) return
    const text = input.value.replace(/\r\n/g, '\n').trim()
    if (!text) {
      setHint('Type a message before sending.', 'error')
      return
    }

    // Slash commands are the two things a harness must do without a round trip through the
    // model: start over, and stop.
    if (text === '/new') {
      input.value = ''
      await newSession()
      return
    }
    if (text === '/stop') {
      input.value = ''
      await stopRun()
      return
    }

    state.sending = true
    updateComposer()
    setHint(state.running ? 'Steering the agent…' : 'Sending…')
    try {
      const res = await fetch(`${API}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The agent rejected the prompt (${res.status}).`)
      input.value = ''
      autoGrow()
      if (data.disposition === 'queued') setHint('Queued — the agent picks it up after this turn.')
      else if (data.disposition === 'handled') setHint('The agent handled that command.')
      else setHint('')
      refreshSessionsSoon()
    } catch (err) {
      setHint(err?.message || 'Could not reach the agent.', 'error')
    } finally {
      state.sending = false
      updateComposer()
      input.focus()
    }
  }

  async function stopRun() {
    setHint('Stopping…')
    try {
      const res = await fetch(`${API}/abort`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not stop the agent (${res.status}).`)
      setRunning(false)
      setHint('Stopped.')
    } catch (err) {
      setHint(err?.message || 'Could not stop the agent.', 'error')
    }
  }

  async function newSession() {
    try {
      const res = await fetch(`${API}/reset`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not start a session (${res.status}).`)
      if (data.cancelled) {
        setHint('The agent declined to start a new session.', 'error')
        return
      }
      state.items = []
      state.tools.clear()
      state.mounted = 0
      syncTranscript({ reset: true })
      setHint('New session.', 'success')
      refreshStatus()
      refreshSessionsSoon()
    } catch (err) {
      setHint(err?.message || 'Could not start a new session.', 'error')
    }
  }

  async function restartAgent() {
    const btn = $('hx-restart')
    if (btn) btn.disabled = true
    setHint('Restarting the agent…')
    try {
      const res = await fetch(`${API}/restart`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not restart the agent (${res.status}).`)
      setRunning(false)
      state.items.push({ kind: 'notice', tone: 'info', text: 'Agent restarted.' })
      syncTranscript()
      await refreshStatus()
      setHint('')
    } catch (err) {
      setHint(err?.message || 'Could not restart the agent.', 'error')
    } finally {
      if (btn) btn.disabled = false
    }
  }

  // ── Sessions ────────────────────────────────────────────────────────────────────────

  function sessionWhen(modifiedMs) {
    const ms = Number(modifiedMs) || 0
    if (!ms) return ''
    const when = new Date(ms)
    const today = new Date()
    return when.toDateString() === today.toDateString()
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  function renderSessions() {
    const list = $('hx-session-list')
    if (!list) return
    const query = state.sessionQuery.trim().toLowerCase()
    const rows = state.sessions.filter((session) => {
      if (!query) return true
      return (
        String(session.label || '').toLowerCase().includes(query) ||
        String(session.preview || '').toLowerCase().includes(query) ||
        String(session.fileName || '').toLowerCase().includes(query)
      )
    })
    if (!rows.length) {
      list.innerHTML = `<div class="hx-empty-note">${
        state.sessions.length
          ? 'No session matches that search.'
          : 'No sessions yet. Conversations are saved here as the agent works.'
      }</div>`
      return
    }
    const current = state.status?.sessionFile
    list.innerHTML = rows
      .slice(0, 60)
      .map((session) => {
        const stats = []
        if (session.userMessages) stats.push(`${session.userMessages} msg`)
        if (session.toolCalls) stats.push(`${session.toolCalls} tools`)
        const meta = [sessionWhen(session.modifiedMs), ...stats].join(' · ')
        return `<button class="hx-session-row${session.file === current ? ' current' : ''}" data-session="${escapeHtml(session.file)}" title="${escapeHtml(session.file)}">
            <div class="hx-session-label">${escapeHtml(session.label || session.fileName)}</div>
            <div class="hx-session-meta">${escapeHtml(meta || session.fileName)}</div>
          </button>`
      })
      .join('')
  }

  async function loadSessions() {
    try {
      const res = await fetch(`${API}/sessions`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `sessions ${res.status}`)
      state.sessions = Array.isArray(data.sessions) ? data.sessions : []
      renderSessions()
    } catch (err) {
      const list = $('hx-session-list')
      if (list) list.innerHTML = `<div class="hx-empty-note">Could not list sessions: ${escapeHtml(err?.message || err)}</div>`
    }
  }

  let sessionsTimer = null
  function refreshSessionsSoon() {
    clearTimeout(sessionsTimer)
    sessionsTimer = setTimeout(loadSessions, 1500)
  }

  /** Rebuilds the visible conversation from the session file the agent is attached to. */
  async function loadMessages() {
    const res = await fetch(`${API}/messages`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Could not read the conversation.')
    }
    state.items = []
    state.tools.clear()
    state.mounted = 0
    for (const message of data.messages || []) {
      if (message.role === 'user') {
        state.items.push({ kind: 'user', text: textFromBlocks(message.content) })
      } else if (message.role === 'assistant') {
        state.items.push({ kind: 'assistant', blocks: contentParts(message.content) })
      } else if (message.role === 'toolResult') {
        state.items.push({
          kind: 'tool',
          id: message.toolCallId || '',
          name: message.toolName || 'tool',
          args: null,
          status: message.isError ? 'error' : 'ok',
          result: clip(resultText(message), MAX_TOOL),
          partial: '',
        })
      }
    }
    syncTranscript({ reset: true })
  }

  async function resumeSession(file) {
    if (!file) return
    setHint('Resuming session…')
    try {
      const res = await fetch(`${API}/sessions/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: file }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not resume that session (${res.status}).`)
      if (data.mode === 'cancelled') {
        setHint('The agent declined to switch sessions.', 'error')
        return
      }
      await refreshStatus()
      await loadMessages()
      setHint('Session resumed.', 'success')
      loadSessions()
    } catch (err) {
      setHint(err?.message || 'Could not resume that session.', 'error')
    }
  }

  // ── Command palette ─────────────────────────────────────────────────────────────────

  const COMMANDS = [
    { label: 'Focus the prompt', hint: 'Enter', run: () => $('hx-input')?.focus() },
    { label: 'New session', hint: '/new', run: newSession },
    { label: 'Stop the agent', hint: '/stop', run: stopRun },
    { label: 'Restart the agent', run: restartAgent },
    {
      label: 'Open a session…',
      run: () => {
        // The rail is a drawer under 960px; opening the command has to open what it points at.
        document.body.classList.add('hx-drawer-open')
        $('hx-session-search')?.focus()
      },
    },
    { label: 'Go to the router', run: () => showView('router') },
  ]

  function paletteItems(query) {
    const q = query.trim().toLowerCase()
    return q ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q)) : COMMANDS
  }

  function closePalette() {
    $('hx-palette')?.classList.remove('open')
  }

  function renderPalette() {
    const input = $('hx-palette-input')
    const list = $('hx-palette-list')
    if (!input || !list) return
    const items = paletteItems(input.value)
    if (!items.length) {
      list.innerHTML = '<div class="hx-palette-empty">No matching command.</div>'
      return
    }
    list.innerHTML = items
      .map(
        (command, index) =>
          `<button class="hx-palette-item" data-index="${index}" aria-selected="${index === 0}">${
            escapeHtml(command.label) + (command.hint ? `<kbd>${escapeHtml(command.hint)}</kbd>` : '')
          }</button>`,
      )
      .join('')
  }

  function runPaletteItem(index) {
    const input = $('hx-palette-input')
    const command = paletteItems(input ? input.value : '')[index]
    if (!command) return
    closePalette()
    if (input) input.value = ''
    command.run()
  }

  function openPalette() {
    const overlay = $('hx-palette')
    if (!overlay) return
    overlay.classList.add('open')
    const input = $('hx-palette-input')
    if (input) {
      input.value = ''
      input.focus()
    }
    renderPalette()
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────────────

  function autoGrow() {
    const input = $('hx-input')
    if (!input) return
    input.style.height = 'auto'
    // +2 covers the border the scrollHeight does not report; without it the composer shows a
    // scrollbar for content that already fits, which reads as a clipped input.
    input.style.height = `${Math.min(190, input.scrollHeight + 2)}px`
    input.style.overflowY = input.scrollHeight + 2 > 190 ? 'auto' : 'hidden'
  }

  function bind() {
    const nav = (id, view) => $(id)?.addEventListener('click', () => showView(view))
    nav('hx-nav-agent', 'agent')
    nav('hx-nav-router', 'router')
    $('hx-palette-btn')?.addEventListener('click', openPalette)

    $('hx-composer')?.addEventListener('submit', (event) => {
      event.preventDefault()
      sendPrompt()
    })

    const input = $('hx-input')
    input?.addEventListener('input', autoGrow)
    input?.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter is a newline: a harness is a chat with a keyboard shortcut,
      // and Cmd/Ctrl+Enter still works for people who expect it.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendPrompt()
      }
    })

    $('hx-stop')?.addEventListener('click', stopRun)

    // The inspector is a drawer below 960px. A toggle, Escape, or a click outside closes it.
    $('hx-details')?.addEventListener('click', (event) => {
      event.stopPropagation()
      document.body.classList.toggle('hx-drawer-open')
    })
    document.addEventListener('click', (event) => {
      if (!document.body.classList.contains('hx-drawer-open')) return
      if (event.target.closest('.hx-side') || event.target.closest('#hx-details')) return
      document.body.classList.remove('hx-drawer-open')
    })
    $('hx-new')?.addEventListener('click', newSession)
    $('hx-restart')?.addEventListener('click', restartAgent)

    $('hx-session-search')?.addEventListener('input', (event) => {
      state.sessionQuery = event.target.value
      renderSessions()
    })

    $('hx-session-list')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-session]')
      if (!row) return
      document.body.classList.remove('hx-drawer-open')
      resumeSession(row.dataset.session)
    })

    $('hx-transcript')?.addEventListener('click', (event) => {
      const suggestion = event.target.closest('[data-prompt]')
      if (!suggestion) return
      const box = $('hx-input')
      if (!box) return
      box.value = suggestion.dataset.prompt || ''
      autoGrow()
      box.focus()
    })

    // A re-render replaces the element a disclosure lived in, so the open state has to live on
    // the item: without this, every streaming update collapsed output the reader had opened.
    $('hx-transcript')?.addEventListener(
      'toggle',
      (event) => {
        const node = event.target
        if (!node.classList?.contains('hx-tool')) return
        const item = state.items.find((entry) => entry.node?.contains(node))
        if (item) item.open = node.open
      },
      true,
    )

    $('hx-transcript')?.addEventListener('scroll', () => {
      const jump = $('hx-jump')
      const transcript = $('hx-transcript')
      if (jump && transcript) jump.style.display = atBottom(transcript) ? 'none' : ''
    })

    $('hx-jump')?.addEventListener('click', () => {
      const transcript = $('hx-transcript')
      if (transcript) transcript.scrollTop = transcript.scrollHeight
    })

    $('hx-copy-cwd')?.addEventListener('click', async () => {
      const cwd = state.status?.cwd
      if (!cwd) return
      try {
        await navigator.clipboard.writeText(cwd)
        setHint('Workspace path copied.', 'success')
      } catch {
        setHint('Could not copy the path.', 'error')
      }
    })

    // Palette. Only a click on the backdrop closes it — clicking inside the card must not.
    $('hx-palette')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closePalette()
    })
    $('hx-palette-input')?.addEventListener('input', renderPalette)
    $('hx-palette-input')?.addEventListener('keydown', (event) => {
      const list = $('hx-palette-list')
      if (!list) return
      const buttons = [...list.querySelectorAll('.hx-palette-item')]
      const selected = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true')
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!buttons.length) return
        const next =
          event.key === 'ArrowDown'
            ? (selected + 1 + buttons.length) % buttons.length
            : (selected - 1 + buttons.length) % buttons.length
        buttons.forEach((button, index) =>
          button.setAttribute('aria-selected', index === next ? 'true' : 'false'),
        )
        buttons[next].scrollIntoView({ block: 'nearest' })
      } else if (event.key === 'Enter') {
        event.preventDefault()
        runPaletteItem(selected < 0 ? 0 : selected)
      }
    })
    $('hx-palette-list')?.addEventListener('click', (event) => {
      const item = event.target.closest('[data-index]')
      if (item) runPaletteItem(Number(item.dataset.index))
    })

    document.addEventListener('keydown', (event) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
        return
      }
      if (event.key === 'Escape') {
        if ($('hx-palette')?.classList.contains('open')) closePalette()
        else document.body.classList.remove('hx-drawer-open')
        return
      }
      // Cmd/Ctrl+J returns to the agent from anywhere in the router views.
      if (meta && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        showView('agent')
      }
    })
  }

  async function init() {
    let stored
    try {
      stored = localStorage.getItem(VIEW_KEY) || 'agent'
    } catch {
      // A private-mode browser without storage still gets the agent as the landing view.
      stored = 'agent'
    }
    bind()
    showView(stored === 'router' ? 'router' : 'agent')
    syncTranscript({ reset: true })
    renderSessions()
    connectEvents()
    await refreshStatus()
    await loadSessions()
    autoGrow()
  }

  // The page is a classic script and its markup already uses inline handlers (the router's
  // own buttons do), so the two the shell calls by name live on the window.
  window.harnessShow = showView
  window.harnessReloadSessions = () => loadSessions()

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
