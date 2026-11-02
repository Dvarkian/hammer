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
    /** Every conversation this page holds open, by console id. `main` always exists. */
    consoles: new Map(),
    /** Which of them is on screen. `null` until init binds the main console. */
    activeId: null,
    /** Conversations reported as working from /api/pi/instances, including other tabs'. */
    runningSessions: new Set(),
    items: [],
    mounted: 0,
    phase: 'idle',
    running: false,
    status: null,
    usage: null,
    /** Images staged for the next prompt: { name, mimeType, dataUrl, data }. */
    attachments: [],
    sessions: [],
    sessionQuery: '',
    /** The session file the rename dialog is editing, or null while it is closed. */
    /** Whether the next render should select the rename input's text (edit just opened). */
    renamingSelect: false,
    /** Where the caret was, so a re-render does not throw it to the end. */
    renamingCaret: 0,
    /** The session file whose rail row is being renamed in place, or null. */
    renamingFile: null,
    /** Value typed so far, so a re-render (a status frame) keeps the edit. */
    renamingValue: '',
    patchQueued: false,
    notesSeen: new Set(),
    tools: new Map(),
    view: 'agent',
    /** What Send does to a busy conversation: `steer` mid-run, or `followUp` next turn. */
    queueMode: localStorage.getItem('hammer.hx.queueMode') === 'followUp' ? 'followUp' : 'steer',
  }

  // ── Conversations ───────────────────────────────────────────────────────────────────
  //
  // A conversation is a console on the server: the main one at `/api/pi`, or a parallel one at
  // `/api/pi/instances/:id/console`. Each keeps its own event stream open for the life of this
  // page, so a turn that is not on screen keeps running — and keeps its spinner in the sidebar
  // turning — instead of being torn down when the reader looks at another conversation. `state`
  // mirrors the console on screen, which is why every renderer below is still written against
  // one conversation.

  function createConsole({ id, instanceId = null, sessionFile = null }) {
    const console = {
      id,
      instanceId,
      sessionFile,
      items: [],
      tools: new Map(),
      phase: 'idle',
      running: false,
      /** A prompt is in flight for *this* conversation; another one's send is its own. */
      sending: false,
      /** The hint line belongs to the conversation too — see setHint. */
      hint: '',
      hintTone: null,
      status: null,
      usage: null,
      /** Messages pi is holding for this conversation: steering and follow-up, by source. */
      queuedSteering: [],
      queuedFollowUp: [],
      notesSeen: new Set(),
      source: null,
      /** True once the transcript came from the session file rather than the replay log. */
      historyLoaded: false,
      /** The model `best` resolved to, as the router reported it (see renderRouting). */
      routedModel: null,
      createdAt: Date.now(),
    }
    state.consoles.set(id, console)
    return console
  }

  function active() {
    return state.consoles.get(state.activeId) || state.consoles.get('main') || null
  }

  /** Where one console's routes live; the main console has no instance id. */
  function consoleApi(console, path = '') {
    return console && console.instanceId
      ? `${API}/instances/${console.instanceId}/console${path}`
      : `${API}${path}`
  }

  /** Points `state` at one console and repaints what it owns. */
  function activate(console) {
    if (!console || console.id === state.activeId) return
    state.activeId = console.id
    state.items = console.items
    state.tools = console.tools
    state.notesSeen = console.notesSeen
    state.phase = console.phase
    state.running = console.running
    state.status = console.status
    state.usage = console.usage
    state.mounted = 0
    setPhase(console.phase, console)
    setRunning(console.running, console)
    renderQueue(console)
    if (console.status) renderRouting(console.status, console)
    renderUsage(console)
    syncTranscript({ reset: true }, console)
    paintHint(console)
    updateComposer()
    renderSessions()
    saveOpenConversations()
  }

  /** Where the open conversations are remembered between page loads (and restarts). */
  const OPEN_KEY = 'hammer.hx.open'
  /** A page restores this many conversations: the server caps parallel consoles at four. */
  const MAX_RESTORE = 3

  /**
   * The conversations this page has open, remembered by session file.
   *
   * Kept as a set rather than recomputed from the live consoles: a fresh page, or one whose
   * consoles are still starting, legitimately has no open instance yet — and writing that
   * emptiness into storage is exactly how the saved tabs were being lost. Only an explicit
   * close removes a file.
   */
  const openFiles = new Map()
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        // Older pages saved bare paths; a path is simply a tab that was not running.
        if (typeof entry === 'string' && entry) openFiles.set(entry, false)
        else if (entry && typeof entry.file === 'string' && entry.file) {
          openFiles.set(entry.file, entry.running === true)
        }
      }
    }
  } catch {
    // A browser without storage simply does not restore anything.
  }

  /** Writes the remembered conversations, the one on screen last, capped for reopening. */
  function saveOpenConversations() {
    try {
      // A console on this page is the truth about whether its turn is still running; the flag
      // is what a later page uses to decide which tabs to pick back up.
      for (const ctx of state.consoles.values()) {
        if (ctx.instanceId && ctx.sessionFile && openFiles.has(ctx.sessionFile)) {
          openFiles.set(ctx.sessionFile, Boolean(ctx.running))
        }
      }
      const entries = [...openFiles].map(([file, running]) => ({ file, running }))
      // The conversation on screen goes last, so restoring in order leaves it on screen again.
      // It is only reordered, never required: looking at the main console must not forget the
      // parallel tabs still open beside it.
      const activeFile = active()?.sessionFile
      const ordered =
        activeFile && openFiles.has(activeFile)
          ? [
              ...entries.filter((entry) => entry.file !== activeFile),
              ...entries.filter((entry) => entry.file === activeFile),
            ]
          : entries
      localStorage.setItem(OPEN_KEY, JSON.stringify(ordered.slice(-MAX_RESTORE)))
    } catch {
      // A browser without storage simply does not restore anything.
    }
  }

  /** Notes that a conversation is open, so the next page (or restart) reopens it. */
  function rememberOpenFile(file, running = false) {
    if (!file || typeof file !== 'string') return
    if (!openFiles.has(file)) {
      openFiles.set(file, Boolean(running))
      while (openFiles.size > MAX_RESTORE) openFiles.delete(openFiles.keys().next().value)
    }
    saveOpenConversations()
  }

  /** What a resumed tab is sent: the shortest instruction that means "carry on". */
  const RESUME_PROMPT = 'Continue'

  /** Sends one message to a console without going through the composer. */
  async function promptConsole(ctx, text) {
    const res = await fetch(consoleApi(ctx, '/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `The agent rejected the prompt (${res.status}).`)
    return data
  }

  /**
   * Picks a conversation back up.
   *
   * A tab that was mid-turn when Hammer closed comes back holding an interrupted conversation.
   * Sending it "Continue" is what makes reopening the app resume the work instead of leaving
   * every tab stopped until someone types into it. The flag is cleared first, so a conversation
   * is only ever sent it once per interruption.
   */
  async function resumeRunning(ctx) {
    if (!ctx || !ctx.sessionFile || ctx.running) return
    openFiles.set(ctx.sessionFile, false)
    saveOpenConversations()
    try {
      await promptConsole(ctx, RESUME_PROMPT)
    } catch (err) {
      // That conversation's hint, not the page's: it was resumed in the background.
      setHint(`Could not resume that conversation: ${err?.message || err}`, 'error', ctx)
    }
  }

  /** Reopens the conversations the last page had, each rebuilt from its own session file. */
  let restoringTabs = false

  async function restoreOpenConversations() {
    // One restore at a time, and one console per file: the same conversation opened twice would
    // put two agents on one session file, and they would interleave writes into its transcript.
    if (restoringTabs) return
    restoringTabs = true
    const started = new Set()
    const mainFile = state.consoles.get('main')?.sessionFile
    for (const [file, wasRunning] of [...openFiles]) {
      if (file === mainFile || started.has(file)) continue
      started.add(file)
      if ([...state.consoles.values()].some((ctx) => ctx.sessionFile === file)) continue
      try {
        const ctx = await openInstance(file)
        if (wasRunning) await resumeRunning(ctx)
      } catch (err) {
        // Gone from the store: forget it rather than retrying on every load. One that merely
        // failed to start this time keeps its slot for the next page.
        if (/unknown|not found|no such|missing/i.test(err?.message || '')) {
          openFiles.delete(file)
          saveOpenConversations()
        }
      }
    }
    restoringTabs = false
    saveOpenConversations()
  }

  /**
   * Rebuilds a conversation from its session file, once.
   *
   * The event stream only replays the last few hundred records the router happens to hold, and
   * after a restart that log starts empty — which is why a tab used to come back blank while
   * its JSONL on disk still held the whole conversation. The file is the authoritative
   * transcript, so an idle console is rebuilt from it before the stream is even opened.
   */
  async function restoreHistory(ctx) {
    if (!ctx || !ctx.sessionFile || ctx.historyLoaded) return
    try {
      await loadMessages(ctx)
    } catch {
      // The agent may still be starting; the stream will fill the transcript instead.
    }
  }

  /** Whether a conversation is working, on this page or in another tab. */
  function isSessionRunning(file) {
    if (!file) return false
    for (const console of state.consoles.values()) {
      if (console.running && console.sessionFile === file) return true
    }
    return state.runningSessions.has(file)
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
   * Inline Markdown. The text arrives raw and is escaped exactly once, first — so a
   * `<script>` in model output stays text, and the only tags written after that are the
   * renderer's own. Only the constructs a model actually answers with: code, strong,
   * emphasis, and links — and links only when they are http(s), never `javascript:` or
   * anything else a href could carry.
   */
  function renderInline(raw) {
    const escaped = escapeHtml(raw)
    return escaped
      .replace(/`([^`\n]+)`/g, '<code class="hx-inline-code">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, href) => {
        const safe = href.replace(/"/g, '%22')
        return `<a class="hx-link" href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      })
  }

  /** An alignment cell of a table's divider row: `---`, `:---`, `---:` or `:---:`. */
  const TABLE_DIVIDER = /^:?-{3,}:?$/

  /**
   * One block-level chunk of Markdown (a run of lines with no fenced code in it). Line-based,
   * because the constructs that matter here — headings, tables, lists — are line grammar.
   * Every block is escaped before its inline pass, so nothing the model writes becomes markup.
   */
  function renderBlocks(chunk) {
    const lines = chunk.split('\n')
    /** @type {string[]} */
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      // A blank line closes whatever paragraph was open; nothing else to emit.
      if (!trimmed) {
        i += 1
        continue
      }

      // Headings: `#` through `######`.
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (heading) {
        const level = heading[1].length
        out.push(`<h${level} class="hx-h${level}">${renderInline(heading[2])}</h${level}>`)
        i += 1
        continue
      }

      // A horizontal rule is three or more of -, * or _ alone on a line.
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push('<hr class="hx-hr">')
        i += 1
        continue
      }

      // Tables: a header row of `|`-separated cells followed by a divider row. The pipes at
      // the ends are optional, and `\|` inside a cell is a literal pipe, not a boundary.
      if (trimmed.includes('|')) {
        const cells = (row) =>
          row
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split(/(?<!\\)\|/)
            .map((cell) => cell.trim().replace(/\\\|/g, '|'))
        const divider = cells(lines[i + 1] || '')
        if (divider.length && divider.every((cell) => TABLE_DIVIDER.test(cell))) {
          const header = cells(trimmed)
          const aligns = divider.map((cell) =>
            cell.startsWith(':') && cell.endsWith(':')
              ? ' center'
              : cell.endsWith(':')
                ? ' right'
                : cell.startsWith(':')
                  ? ' left'
                  : '',
          )
          const row = (values, tag, align) =>
            `<tr>${values
              .map(
                (value, index) =>
                  `<${tag}${align[index] ? ` style="text-align:${align[index].trim()}"` : ''}>${renderInline(value)}</${tag}>`,
              )
              .join('')}</tr>`
          /** @type {string[][]} */
          const body = []
          i += 2
          while (i < lines.length && lines[i].trim().includes('|')) {
            body.push(cells(lines[i]))
            i += 1
          }
          out.push(
            `<div class="hx-table-wrap"><table class="hx-table"><thead>${row(header, 'th', aligns)}</thead><tbody>${body
              .map((values) => row(values, 'td', aligns))
              .join('')}</tbody></table></div>`,
          )
          continue
        }
      }

      // Blockquotes: consecutive `>` lines form one, quoted as a group.
      if (trimmed.startsWith('>')) {
        /** @type {string[]} */
        const quoted = []
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoted.push(lines[i].trim().replace(/^>\s?/, ''))
          i += 1
        }
        out.push(`<blockquote class="hx-quote">${renderBlocks(quoted.join('\n'))}</blockquote>`)
        continue
      }

      // Lists: a run of `- `, `* ` or `1. ` lines. Ordered and unordered do not mix, but
      // consecutive lines of the same kind are one list; continuation lines (indented) and
      // nested markers are flattened into the item above rather than dropped.
      const bullet = /^\s*[-*]\s+(.*)$/
      const ordered = /^\s*\d+[.)]\s+(.*)$/
      const open = bullet.test(trimmed)
        ? 'ul'
        : ordered.test(trimmed)
          ? 'ol'
          : null
      if (open) {
        const marker = open === 'ul' ? bullet : ordered
        /** @type {string[]} */
        const items = []
        while (i < lines.length) {
          const current = lines[i]
          const match = marker.exec(current.trim())
          if (match) {
            items.push(match[1])
            i += 1
          } else if (items.length && /^\s{2,}\S/.test(current)) {
            // A continuation line belongs to the item it follows.
            items[items.length - 1] += ` ${current.trim()}`
            i += 1
          } else if (items.length && !current.trim() && i + 1 < lines.length && marker.test((lines[i + 1] || '').trim())) {
            // One blank line between items keeps the list open.
            i += 1
          } else {
            break
          }
        }
        out.push(
          `<${open} class="hx-list">${items
            .map((item) => `<li>${renderInline(item)}</li>`)
            .join('')}</${open}>`,
        )
        continue
      }

      // Anything else is a paragraph: gather lines until a blank one or a construct that
      // starts another block, so a wrapped sentence stays one paragraph.
      /** @type {string[]} */
      const paragraph = [trimmed]
      i += 1
      while (i < lines.length) {
        const current = lines[i].trim()
        if (
          !current ||
          /^(#{1,6})\s/.test(current) ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(current) ||
          current.startsWith('>') ||
          bullet.test(current) ||
          ordered.test(current)
        )
          break
        paragraph.push(current)
        i += 1
      }
      out.push(`<p class="hx-p">${renderInline(paragraph.join(' '))}</p>`)
    }
    return out.join('')
  }

  /**
   * The agent answers in Markdown, and a harness is where people read it. Headings, tables,
   * lists, quotes and fenced code get real elements. Block grammar is matched on the *raw*
   * lines (a `>` quote marker or a `|` table pipe is unrecognizable once escaped); the only
   * place text becomes safe is renderInline, which escapes each leaf exactly once before any
   * tag is written — so nothing the model writes can become markup on this page. Fenced code
   * is the one region escaped on its own: it has no inline rules at all.
   */
  function renderText(text) {
    return clip(text, MAX_TEXT)
      .split(/```/)
      .map((chunk, index) => {
        if (index % 2 === 1) {
          // The fence's info string (the language) is not part of the code; the body starts
          // after the first newline, and one trailing newline closes the fence.
          const nl = chunk.indexOf('\n')
          const body = nl >= 0 ? chunk.slice(nl + 1) : ''
          return `<pre class="hx-code">${escapeHtml(body.replace(/\n$/, ''))}</pre>`
        }
        return renderBlocks(chunk)
      })
      .join('')
  }

  /**
   * The hint line belongs to a conversation, not to the page.
   *
   * Two conversations can be sending at once, and "Sending…" left behind by one must not sit
   * over another one's working composer — which is exactly what a page-wide hint did when the
   * request outlived the tab that started it.
   */
  function setHint(text, tone, ctx = active()) {
    if (ctx) {
      ctx.hint = text || ''
      ctx.hintTone = tone || null
    }
    paintHint(ctx)
  }

  /** Draws one console's hint, when that console is the one on screen. */
  function paintHint(ctx = active()) {
    const el = $('hx-hint')
    if (!el || (ctx && ctx !== active())) return
    el.textContent = (ctx && ctx.hint) || ''
    if (ctx && ctx.hintTone) el.dataset.tone = ctx.hintTone
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
      <p>This agent edits the workspace, runs commands and reads files.</p>
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

  /**
   * Paints one conversation's transcript. `ctx` defaults to the console on screen; a background
   * console's events are folded into its own buffers and drawn when it is activated — painting
   * them here would put two conversations in one log.
   */
  function syncTranscript({ reset = false } = {}, ctx = active()) {
    if (ctx !== active()) return
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
  function patchStreamingItem(ctx = active()) {
    if (ctx !== active()) return
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

  function lastAssistant(ctx = active()) {
    if (!ctx) return null
    for (let i = ctx.items.length - 1; i >= 0; i -= 1) {
      if (ctx.items[i].kind === 'assistant') return ctx.items[i]
    }
    return null
  }

  function appendDelta(kind, contentIndex, delta, ctx = active()) {
    const item = lastAssistant(ctx)
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
    patchStreamingItem(ctx)
  }

  function ensureTool(id, name, ctx = active()) {
    const key = String(id || name || 'tool')
    let item = ctx.tools.get(key)
    if (item) return item
    item = { kind: 'tool', id: key, name: name || 'tool', args: null, status: 'preparing', result: '', partial: '' }
    ctx.tools.set(key, item)
    ctx.items.push(item)
    syncTranscript({}, ctx)
    return item
  }

  function contentParts(content) {
    if (typeof content === 'string') {
      return content ? [{ kind: 'text', index: 0, text: clip(content, MAX_TEXT) }] : []
    }
    if (!Array.isArray(content)) return []
    const blocks = []
    content.forEach((part, index) => {
      if (!part || typeof part !== 'object') return
      // Pi keeps reasoning in `thinking` (with a signature) and prose in `text`. Reading only
      // `text` dropped every reasoning-only turn, which is most of them, and left a bubble with
      // nothing in it — the "…" a resumed transcript was full of. A part with neither is a tool
      // call, which is rendered as its own row from the tool result.
      const thinking = part.type === 'thinking' || part.type === 'reasoning'
      const text = thinking
        ? typeof part.thinking === 'string'
          ? part.thinking
          : typeof part.text === 'string'
            ? part.text
            : ''
        : typeof part.text === 'string'
          ? part.text
          : ''
      const kind = thinking ? 'thinking' : text ? 'text' : null
      if (kind && text) blocks.push({ kind, index, text: clip(text, MAX_TEXT) })
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
  function applyRecord(record, ctx = active()) {
    if (!record || typeof record !== 'object' || !ctx) return
    switch (record.type) {
      case 'agent_start':
        setRunning(true, ctx)
        break
      case 'agent_settled':
        setRunning(false, ctx)
        break
      case 'queue_update':
        applyQueue(record.steering, record.followUp, ctx)
        break
      case 'message_start': {
        const message = record.message || {}
        if (message.role === 'user') {
          ctx.items.push({ kind: 'user', text: textFromBlocks(message.content) })
          syncTranscript({}, ctx)
        } else if (message.role === 'assistant') {
          ctx.items.push({ kind: 'assistant', blocks: [] })
          syncTranscript({}, ctx)
        }
        break
      }
      case 'message_update': {
        const update = record.assistantMessageEvent || {}
        if (update.type === 'text_delta') appendDelta('text', update.contentIndex, update.delta, ctx)
        else if (update.type === 'thinking_delta')
          appendDelta('thinking', update.contentIndex, update.delta, ctx)
        else if (update.type === 'toolcall_start') ensureTool(update.id, update.toolName, ctx)
        else if (update.type === 'toolcall_end') {
          const call = update.toolCall || {}
          const item = ensureTool(call.id || update.id, call.name || update.toolName, ctx)
          if (call.arguments) item.args = call.arguments
          syncTranscript({ reset: true }, ctx)
        }
        break
      }
      case 'message_end': {
        const message = record.message || {}
        if (message.role === 'assistant') {
          const item = lastAssistant(ctx)
          if (item) {
            const streamed = item.blocks.some((block) => block.text)
            if (!streamed) item.blocks = contentParts(message.content)
            if (!item.blocks.length && item.node) {
              // A turn that produced nothing leaves no empty bubble; the notice explains it.
              ctx.items.splice(ctx.items.indexOf(item), 1)
              syncTranscript({ reset: true }, ctx)
            } else {
              syncTranscript({ reset: true }, ctx)
            }
          }
          const failure =
            message.errorMessage ||
            (message.stopReason === 'error' ? 'The model call failed.' : '')
          if (failure) {
            ctx.items.push({
              kind: 'notice',
              tone: 'error',
              text: String(failure).replace(/\s+/g, ' ').trim().slice(0, 800),
            })
            syncTranscript({}, ctx)
          }
        }
        break
      }
      case 'tool_execution_start': {
        const item = ensureTool(record.toolCallId, record.toolName, ctx)
        if (record.args) item.args = record.args
        item.status = 'running'
        syncTranscript({}, ctx)
        break
      }
      case 'tool_execution_update': {
        const item = ensureTool(record.toolCallId, record.toolName, ctx)
        item.partial = clip(resultText(record.partialResult), MAX_TOOL)
        item.status = 'running'
        syncTranscript({}, ctx)
        break
      }
      case 'tool_execution_end': {
        const item = ensureTool(record.toolCallId, record.toolName, ctx)
        item.status = record.isError ? 'error' : record.isError === false ? 'ok' : 'ok'
        item.result = clip(resultText(record.result), MAX_TOOL)
        item.partial = ''
        if (record.durationMs != null) item.durationMs = record.durationMs
        syncTranscript({}, ctx)
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

  // ── Thinking effort ─────────────────────────────────────────────────────────────────

  /** The levels the pill cycles, quietest first. `minimal` is left to clients that can spell it. */
  const THINKING_CYCLE = ['off', 'low', 'medium', 'high']

  /**
   * Asks the agent for a different thinking level. The agent declares that it can send one, and
   * the router translates it per provider and per model — a level set here is `high` on a
   * reasoning model and simply absent on one that cannot think, never an error either way.
   */
  async function cycleThinking() {
    const current = String($('hx-thinking-level')?.textContent || 'off')
      .trim()
      .toLowerCase()
    const index = THINKING_CYCLE.indexOf(current)
    const level = THINKING_CYCLE[(index + 1) % THINKING_CYCLE.length]
    const ctx = active()
    try {
      const res = await fetch(consoleApi(ctx, '/command'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'set_thinking_level', args: { level } }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Could not set the thinking level (${res.status}).`)
      }
      const el = $('hx-thinking-level')
      if (el) el.textContent = level
      setHint(
        level === 'off'
          ? 'Thinking off — the next turn asks for no extra reasoning.'
          : `Thinking ${level} — the router sends it in the form the chosen model understands.`,
        'success',
        ctx,
      )
      // The agent's own answer is authoritative: a level it clamps is a level worth showing.
      await refreshStatus(ctx)
    } catch (err) {
      setHint(err?.message || 'Could not change the thinking level.', 'error', ctx)
    }
  }

  /**
   * One console's turn state. The sidebar is drawn from every console, not only this one, so a
   * background conversation turns its own spinner whether or not it is on screen.
   */
  function setRunning(running, ctx = active()) {
    const changed = ctx.running !== Boolean(running)
    ctx.running = Boolean(running)
    if (ctx === active()) {
      state.running = ctx.running
      updateComposer()
    }
    if (changed) {
      renderSessions()
      // A turn is when a session file is written: pi creates it with the first message and
      // appends through the run. Checking the store on both edges is what puts a conversation
      // that was just started into the rail without anyone pressing Refresh.
      refreshSessionsSoon()
      // A turn that was followed live left the transcript holding only that turn; once it
      // settles the session file is complete, so the conversation is rebuilt from it in full.
      if (!ctx.running && !ctx.historyLoaded) void restoreHistory(ctx)
      // Remembered per tab: a conversation still working when the app closes is the one a
      // later page resumes, and settling clears the flag again.
      if (ctx.instanceId && ctx.sessionFile) {
        openFiles.set(ctx.sessionFile, ctx.running)
        saveOpenConversations()
      }
    }
  }

  function setPhase(phase, ctx = active()) {
    ctx.phase = phase || 'idle'
    if (ctx !== active()) return
    state.phase = ctx.phase
    const pill = $('hx-phase')
    const label = $('hx-phase-label')
    if (pill) pill.dataset.phase = state.phase
    if (label) label.textContent = state.phase === 'dead' ? 'down' : state.phase
  }

  /**
   * Adopts a queue snapshot for one conversation. Pi's `queue_update` event (and the counts
   * `get_state` carries) are the only authoritative source — a message the agent already
   * consumed leaves the queue by an event, not by anything this page could infer.
   */
  function applyQueue(steering, followUp, ctx = active()) {
    if (!ctx) return
    ctx.queuedSteering = Array.isArray(steering) ? steering.map(String) : []
    ctx.queuedFollowUp = Array.isArray(followUp) ? followUp.map(String) : []
    renderQueue(ctx)
  }

  /** Draws the queue strip between transcript and composer, and the button's queued count. */
  function renderQueue(ctx = active()) {
    if (!ctx || ctx !== active()) return
    const wrap = $('hx-queue')
    const list = $('hx-queue-list')
    const items = [
      ...ctx.queuedSteering.map((text) => ({ text, mode: 'steer' })),
      ...ctx.queuedFollowUp.map((text) => ({ text, mode: 'followUp' })),
    ]
    if (wrap) wrap.hidden = items.length === 0
    if (list) {
      list.innerHTML = items
        .map(
          (item) =>
            `<li data-queue-mode="${item.mode}"><span>${escapeHtml(clip(item.text, 200))}</span><b>${item.mode === 'followUp' ? 'next turn' : 'this turn'}</b></li>`,
        )
        .join('')
    }
    const send = $('hx-send')
    if (send) {
      const count = items.length
      send.dataset.queued = count > 0 ? String(count) : ''
    }
  }

  /** What the queue button says, and what it will do when clicked. */
  function renderQueueMode() {
    const btn = $('hx-queue-mode')
    if (btn) {
      const followUp = state.queueMode === 'followUp'
      btn.dataset.mode = state.queueMode
      btn.title = followUp
        ? 'Messages send while the agent works are held until the current turn finishes (click to deliver mid-turn instead)'
        : 'Messages send while the agent works are delivered mid-turn, after its current tool call (click to hold them for the next turn instead)'
      btn.textContent = followUp ? 'After turn' : 'Queue: steer'
    }
  }

  function setQueueMode(mode) {
    state.queueMode = mode === 'followUp' ? 'followUp' : 'steer'
    try {
      localStorage.setItem('hammer.hx.queueMode', state.queueMode)
    } catch {
      // A browser without storage just does not remember the choice.
    }
    renderQueueMode()
    setHint(
      state.queueMode === 'followUp'
        ? 'Messages sent while the agent works will be held until the current turn completes.'
        : 'Messages sent while the agent works will be delivered mid-turn, after its current tool call.',
      'success',
    )
  }

  function renderRouting(data, ctx = active()) {
    if (!data || ctx !== active()) return
    const model = data.model
    const nameEl = $('hx-model-name')
    const providerEl = $('hx-model-provider')
    const viaEl = $('hx-model-via')
    const badgeEl = $('hx-routed-badge')
    const thinkingEl = $('hx-thinking-level')
    // Pi calls its alias "Hammer's selected model", which names the mechanism rather than the
    // model doing the answering. The router's pick — model and the provider offering it — is what
    // the strip shows; the alias stands in only when nothing is routed at all.
    if (data.routedModel) ctx.routedModel = data.routedModel
    const routed = ctx.routedModel
    if (nameEl) {
      nameEl.textContent = routed
        ? [routed.label || routed.modelId, routed.providerName].filter(Boolean).join(' · ')
        : model
          ? model.name || model.id || 'unknown'
          : 'no model yet'
    }
    // "GLM 5.3 Flash · NVIDIA" already names the provider, so the separate "via" line goes.
    if (viaEl) viaEl.hidden = Boolean(routed)
    if (providerEl) providerEl.textContent = model ? model.provider || 'provider' : '—'
    if (badgeEl) {
      // `routed` is the server's answer to "does the agent take its model from this router",
      // which is the whole reason a routing harness has an agent at all.
      const routed = data.routed !== false
      badgeEl.textContent = routed ? '' : 'fixed model'
      badgeEl.classList.toggle('off', !routed)
      badgeEl.hidden = routed
      badgeEl.title = routed
        ? ''
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
      setHint(`Agent unavailable — ${data.error || 'the pi runtime was not found'}`, 'error', console)
    }
  }

  function renderUsage(ctx = active()) {
    if (ctx !== active()) return
    const usage = state.usage
    const el = $('hx-usage-text')
    const bar = $('hx-usage-fill')
    if (!el) return
    if (!usage) {
      el.textContent = 'No tokens reported yet'
      if (bar) bar.style.width = '0%'
      return
    }
    // The bridge reports pi's per-message usage split into its real components (input,
    // output, and the cached halves of the prompt). Older builds sent a single cumulative
    // `tokens` count with no split; those still render, as one undivided total.
    const input = Number(usage.inputTokens ?? usage.input ?? 0)
    const output = Number(usage.outputTokens ?? usage.output ?? 0)
    const cacheRead = Number(usage.cacheReadTokens ?? usage.cacheRead ?? 0)
    const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cacheWrite ?? 0)
    const total =
      Number(usage.totalTokens ?? usage.tokens) || input + output + cacheRead + cacheWrite
    if (total <= 0 && !(Number(usage.cost) > 0)) {
      // A session that has not billed anything yet is a fresh one; say so instead of a
      // row of zeros that reads like the reporting is broken.
      el.textContent = 'No tokens reported yet'
      if (bar) bar.style.width = '0%'
      return
    }
    const parts = []
    if (total > 0 && input + output + cacheRead + cacheWrite === 0) {
      // No split available: show the one number we were given.
      parts.push(`${total.toLocaleString()} tokens`)
    } else {
      parts.push(`${input.toLocaleString()} in · ${output.toLocaleString()} out`)
      const cached = cacheRead + cacheWrite
      if (cached > 0) parts.push(`${cached.toLocaleString()} cached`)
    }
    const cost = Number(usage.cost) || 0
    if (cost > 0) parts.push(`$${cost.toFixed(cost >= 1 ? 2 : 4)}`)
    el.textContent = parts.join(' · ')
    if (bar) {
      // A context meter without a declared window is still useful as a magnitude bar; it is
      // labelled as a share of the turn, not of a limit we were not told.
      const context = Number(usage.contextTokens ?? usage.context ?? 0)
      const share = total > 0 ? Math.min(100, Math.round((context / total) * 100)) : 0
      bar.style.width = `${share}%`
    }
  }

  async function refreshStatus(console = active()) {
    if (!console) return
    try {
      const res = await fetch(consoleApi(console, '/status'))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `status ${res.status}`)
      console.status = data
      if (data.sessionFile) rememberSessionFile(console, data.sessionFile)
      setPhase(data.phase, console)
      setRunning(data.phase === 'busy' || Boolean(data.isStreaming), console)
      renderRouting(data, console)
      if (Array.isArray(data.queuedSteering) || Array.isArray(data.queuedFollowUp)) {
        applyQueue(data.queuedSteering, data.queuedFollowUp, console)
      }
      if (data.usage) {
        console.usage = data.usage
        if (console === active()) {
          state.usage = data.usage
          renderUsage(console)
        }
      }
      if (console === active()) updateComposer()
      renderSessions()
    } catch (err) {
      setHint(`Could not reach the agent: ${err?.message || err}`, 'error', console)
      setPhase('dead', console)
    }
  }

  function updateComposer() {
    const send = $('hx-send')
    const stop = $('hx-stop')
    const unavailable = Boolean(state.status && state.status.available === false)
    if (send) {
      send.disabled = Boolean(active()?.sending) || unavailable
      send.textContent = state.running ? (state.queueMode === 'followUp' ? 'Queue' : 'Steer') : 'Send'
    }
    if (stop) stop.disabled = !state.running
    renderQueueMode()
  }

  // ── The event stream ────────────────────────────────────────────────────────────────

  /** Opens one console's event stream. Every console keeps its own, on screen or not. */
  function connectEvents(ctx) {
    if (!ctx || ctx.source) return
    if (!window.EventSource) {
      setHint('This browser cannot stream the agent transcript.', 'error', ctx)
      return
    }
    const source = new EventSource(consoleApi(ctx, '/events'))
    ctx.source = source
    source.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === 'hello') {
        // The replay log describes the conversation only when the transcript was not rebuilt
        // from the session file. Resetting here unconditionally is what emptied a tab that had
        // just been restored: the file's history was cleared and the log was then skipped.
        if (!ctx.historyLoaded) {
          ctx.items = []
          ctx.tools.clear()
          ctx.notesSeen.clear()
          if (ctx === active()) {
            state.items = ctx.items
            state.tools = ctx.tools
            state.notesSeen = ctx.notesSeen
            state.mounted = 0
          }
          // A page opened mid-run catches up from the log instead of starting from whatever
          // this tab happened to witness.
          ;(payload.log || []).forEach((record) => applyRecord(record, ctx))
        }
        if (payload.status) {
          ctx.status = payload.status
          if (payload.status.sessionFile) rememberSessionFile(ctx, payload.status.sessionFile)
          setPhase(payload.status.phase, ctx)
          setRunning(
            payload.status.phase === 'busy' || Boolean(payload.status.isStreaming),
            ctx,
          )
          renderRouting(payload.status, ctx)
          // The status carries pi's own queue accounting, so a page opened mid-run sees what
          // is already waiting without waiting for a fresh `queue_update`.
          if (
            Array.isArray(payload.status.queuedSteering) ||
            Array.isArray(payload.status.queuedFollowUp)
          ) {
            applyQueue(payload.status.queuedSteering, payload.status.queuedFollowUp, ctx)
          }
          // The status frame carries the session's rehydrated totals, so a page opened after
          // the tokens were spent still shows them without waiting for a fresh turn.
          if (payload.status.usage) {
            ctx.usage = payload.status.usage
            if (ctx === active()) {
              state.usage = ctx.usage
              renderUsage(ctx)
            }
          }
        }
        if (ctx === active()) updateComposer()
        syncTranscript({ reset: true }, ctx)
        renderSessions()
        return
      }
      if (payload.type === 'event') {
        applyRecord(payload.record, ctx)
        return
      }
      if (payload.type === 'status' && payload.status) {
        ctx.status = payload.status
        if (payload.status.sessionFile) rememberSessionFile(ctx, payload.status.sessionFile)
        setPhase(payload.status.phase, ctx)
        setRunning(payload.status.phase === 'busy' || Boolean(payload.status.isStreaming), ctx)
        renderRouting(payload.status, ctx)
        if (
          Array.isArray(payload.status.queuedSteering) ||
          Array.isArray(payload.status.queuedFollowUp)
        ) {
          applyQueue(payload.status.queuedSteering, payload.status.queuedFollowUp, ctx)
        }
        if (payload.status.usage) {
          ctx.usage = payload.status.usage
          if (ctx === active()) {
            state.usage = ctx.usage
            renderUsage(ctx)
          }
        }
        if (ctx === active()) updateComposer()
        return
      }
      if (payload.type === 'usage') {
        ctx.usage = payload.usage || payload
        if (ctx === active()) {
          state.usage = ctx.usage
          renderUsage(ctx)
        }
        return
      }
      if (payload.type === 'log' && payload.text) {
        ctx.items.push({
          kind: 'notice',
          tone: 'info',
          text: String(payload.text).slice(0, 500),
        })
        syncTranscript({}, ctx)
        return
      }
      if (payload.type === 'exit') {
        setRunning(false, ctx)
        ctx.items.push({
          kind: 'notice',
          tone: 'error',
          text: payload.message || 'The agent exited.',
        })
        syncTranscript({}, ctx)
        refreshStatus(ctx)
        return
      }
      if (payload.type === 'notice' && payload.text) {
        ctx.items.push({ kind: 'notice', tone: 'info', text: String(payload.text) })
        syncTranscript({}, ctx)
      }
    }
    source.onerror = () => {
      if (ctx === active()) setHint('Lost the event stream — reconnecting…', 'error')
    }
    source.onopen = () => {
      if (ctx === active()) setHint('')
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────────────────

  /**
   * How long a send waits for an answer before the composer is handed back.
   *
   * The bridge answers every command within 20s, so this only fires when the request never
   * reached an agent at all — a page left open across a restart, a socket the OS holds open, a
   * route that died mid-flight. Without it the button stayed disabled and the hint stayed on
   * "Sending…" until the page was reloaded.
   */
  const PROMPT_TIMEOUT_MS = 35_000

  // ── Attachments ─────────────────────────────────────────────────────────────────────

  /** How many images may ride on one prompt; the bridge refuses more. */
  const MAX_ATTACHMENTS = 4
  /** Longest edge of the thumbnail shown on a staged chip. */
  const THUMB_SIZE = 64

  /**
   * Reads chosen files into staged attachments. Images only: Pi's prompt command takes an
   * `images` array, and a PDF is a job for a tool call, not a paste. Oversized files are
   * skipped with a hint rather than failing the whole batch.
   * @param {FileList | File[]} files
   */
  async function addAttachments(files) {
    const list = Array.from(files || [])
    if (!list.length) return
    for (const file of list) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        setHint(`Skipped ${file.name || 'file'} — only PNG, JPEG, GIF or WebP images attach.`, 'error')
        continue
      }
      if (state.attachments.length >= MAX_ATTACHMENTS) {
        setHint(`At most ${MAX_ATTACHMENTS} images per message.`, 'error')
        break
      }
      if (file.size > 6 * 1024 * 1024) {
        setHint(`Skipped ${file.name || 'image'} — larger than 6 MB.`, 'error')
        continue
      }
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('Could not read the file.'))
          reader.readAsDataURL(file)
        })
        const marker = 'base64,'
        const at = dataUrl.indexOf(marker)
        if (at < 0) throw new Error('Could not read the file.')
        state.attachments.push({
          name: file.name || 'image',
          mimeType: file.type,
          dataUrl,
          data: dataUrl.slice(at + marker.length),
        })
      } catch {
        setHint(`Could not read ${file.name || 'that file'}.`, 'error')
      }
    }
    renderAttachments()
  }

  /** Draws the staged chips (thumbnail, name, remove button) above the composer bar. */
  function renderAttachments() {
    const strip = $('hx-attachments')
    if (!strip) return
    strip.replaceChildren()
    strip.hidden = state.attachments.length === 0
    for (const [index, att] of state.attachments.entries()) {
      const chip = document.createElement('span')
      chip.className = 'hx-attachment'
      chip.title = att.name
      const img = document.createElement('img')
      img.src = att.dataUrl
      img.alt = att.name
      img.width = THUMB_SIZE
      img.height = THUMB_SIZE
      chip.appendChild(img)
      const name = document.createElement('span')
      name.className = 'hx-attachment-name'
      name.textContent = att.name
      chip.appendChild(name)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'hx-attachment-remove'
      remove.setAttribute('aria-label', `Remove ${att.name}`)
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        state.attachments.splice(index, 1)
        renderAttachments()
      })
      chip.appendChild(remove)
      strip.appendChild(chip)
    }
  }

  /**
   * Drag-and-drop onto the composer: the whole form is the target, because a drop on the
   * textarea alone misses the chrome around it. The dragover preventDefault is what makes
   * the browser treat this page as a drop site at all.
   * @param {DragEvent} event
   */
  function wireComposerDrop() {
    const form = $('hx-composer')
    if (!form) return
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files')
    form.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      form.classList.add('hx-dropping')
    })
    form.addEventListener('dragleave', () => form.classList.remove('hx-dropping'))
    form.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      form.classList.remove('hx-dropping')
      addAttachments(event.dataTransfer?.files || [])
    })
  }

  async function sendPrompt() {
    const input = $('hx-input')
    const console = active()
    if (!input || !console || console.sending) return
    const text = input.value.replace(/\r\n/g, '\n').trim()
    if (!text && state.attachments.length === 0) {
      setHint('Type a message before sending.', 'error', console)
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

    console.sending = true
    updateComposer()
    setHint(console.running ? 'Steering the agent…' : 'Sending…', null, console)
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), PROMPT_TIMEOUT_MS)
    // The staged images go with the text; clearing them before the send means a failed send
    // does not silently re-attach on the retry the user retypes.
    const images = state.attachments.map((att) => ({ data: att.data, mimeType: att.mimeType }))
    state.attachments = []
    renderAttachments()
    try {
      const res = await fetch(consoleApi(console, '/prompt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, images: images.length ? images : undefined }),
        signal: control.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The agent rejected the prompt (${res.status}).`)
      input.value = ''
      autoGrow()
      if (data.disposition === 'queued')
        setHint('Queued — the agent picks it up after this turn.', null, console)
      else if (data.disposition === 'handled') setHint('The agent handled that command.', null, console)
      else setHint('', null, console)
      refreshSessionsSoon()
    } catch (err) {
      // The staged images are restored on failure: the user picked them once, and a network
      // hiccup should not make them pick again.
      state.attachments = images.concat(
        state.attachments.map((att) => ({ name: att.name, mimeType: att.mimeType, dataUrl: att.dataUrl, data: att.data })),
      )
      renderAttachments()
      const lost = err?.name === 'AbortError'
      setHint(
        lost
          ? 'No answer from the agent — it may still be starting. Try again.'
          : err?.message || 'Could not reach the agent.',
        'error',
        console,
      )
    } finally {
      clearTimeout(timer)
      console.sending = false
      if (console === active()) updateComposer()
      input.focus()
    }
  }

  async function stopRun() {
    const console = active()
    setHint('Stopping…', null, console)
    try {
      const res = await fetch(consoleApi(console, '/abort'), { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not stop the agent (${res.status}).`)
      setRunning(false, console)
      setHint('Stopped.', null, console)
    } catch (err) {
      setHint(err?.message || 'Could not stop the agent.', 'error', console)
    }
  }

  async function newSession() {
    const console = active()
    // A fresh conversation must not end the one on screen: while it is working, start beside it
    // and leave it streaming, which is the whole point of more than one conversation.
    if (console?.running) {
      try {
        await openInstance(null)
      } catch (err) {
        setHint(err?.message || 'Could not start a new session.', 'error')
      }
      return
    }
    try {
      const res = await fetch(consoleApi(console, '/reset'), { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not start a session (${res.status}).`)
      if (data.cancelled) {
        setHint('The agent declined to start a new session.', 'error')
        return
      }
      console.items = []
      console.tools.clear()
      if (console === active()) {
        state.items = console.items
        state.tools = console.tools
        state.mounted = 0
        syncTranscript({ reset: true }, console)
      }
      setHint('New session.', 'success')
      refreshStatus(console)
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
      const console = active()
      const res = await fetch(consoleApi(console, '/restart'), { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not restart the agent (${res.status}).`)
      setRunning(false, console)
      console.items.push({ kind: 'notice', tone: 'info', text: 'Agent restarted.' })
      syncTranscript({}, console)
      await refreshStatus(console)
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

  /**
   * Records the file a console is writing, and checks the store as soon as it is known.
   *
   * The file and the row it deserves can arrive in either order: pi writes the JSONL during the
   * first turn, while a status frame can name it before the store's next read sees it.
   */
  function rememberSessionFile(ctx, file) {
    if (!file || ctx.sessionFile === file) return
    ctx.sessionFile = file
    // A parallel conversation is one the next page should reopen, whatever brought its file in.
    if (ctx.instanceId) rememberOpenFile(file)
    renderSessions()
    refreshSessionsSoon()
  }

  /**
   * The rail's rows: the store's sessions, plus every open conversation that the store does not
   * list yet.
   *
   * A conversation is open before it is saved — a fresh one has no file, and a just-prompted
   * one has a file the last read of the store predates — so the list is built from both. That
   * is why a session that was started and given a first prompt could be missing from the rail
   * entirely while its own transcript streamed on screen.
   */
  function sessionRows() {
    const rows = state.sessions.map((session) => ({ ...session, open: false }))
    const listed = new Set(rows.map((row) => row.file))
    const open = []
    for (const ctx of state.consoles.values()) {
      if (!ctx.sessionFile || listed.has(ctx.sessionFile)) continue
      listed.add(ctx.sessionFile)
      open.push({
        file: ctx.sessionFile,
        fileName: ctx.sessionFile.split('/').pop() || ctx.sessionFile,
        label: ctx.status?.sessionName || 'New conversation',
        preview: null,
        modifiedMs: ctx.createdAt || Date.now(),
        userMessages: 0,
        toolCalls: 0,
        open: true,
      })
    }
    return [...open, ...rows]
  }

  /** The label a rail row shows: the session's name, or what it can be recognized by. */
  function rowLabel(session) {
    return session.label || session.name || session.preview || session.fileName
  }

  function renderSessions() {
    const list = $('hx-session-list')
    if (!list) return
    const query = state.sessionQuery.trim().toLowerCase()
    const rows = sessionRows().filter((session) => {
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
    const current = active()?.sessionFile
    list.innerHTML = rows
      .slice(0, 60)
      .map((session) => {
        const stats = []
        if (session.userMessages) stats.push(`${session.userMessages} msg`)
        if (session.toolCalls) stats.push(`${session.toolCalls} tools`)
        const meta = [sessionWhen(session.modifiedMs), ...stats].join(' · ')
        // The spinner is the conversation's own state, so it turns for a turn running in the
        // background — the one thing a list of session files cannot otherwise tell you.
        const running = isSessionRunning(session.file)
        // A row being renamed swaps its label for an input. The row itself stops being a
        // button while it edits, so a stray click or Enter cannot also open the conversation.
        if (session.file === state.renamingFile) {
          return `<div class="hx-session-row current renaming" data-renaming="${escapeHtml(session.file)}" title="${escapeHtml(session.file)}">
            <div class="hx-session-top">
              <input class="hx-session-rename-input" data-rename-input="${escapeHtml(session.file)}" type="text" maxlength="120" value="${escapeHtml(state.renamingValue)}" placeholder="Session name…" aria-label="Session name">
            </div>
            <div class="hx-session-meta">Enter to save · Esc to cancel</div>
          </div>`
        }
        return `<button class="hx-session-row${session.file === current ? ' current' : ''}${
          running ? ' running' : ''
        }" data-session="${escapeHtml(session.file)}" title="${escapeHtml(session.file)}${
          running ? ' · running' : ''
        }">
            <div class="hx-session-top">
              ${running ? '<span class="hx-session-spin" aria-hidden="true"></span>' : ''}
              <span class="hx-session-label">${escapeHtml(rowLabel(session))}</span>
              <span class="hx-session-rename" data-rename="${escapeHtml(session.file)}" role="button" title="Rename this session" aria-label="Rename session">✎</span>
            </div>
            <div class="hx-session-meta">${escapeHtml(meta || session.fileName)}</div>
          </button>`
      })
      .join('')
    // A re-render replaced the input the edit lived in: put the caret back, with the
    // selection only when the edit was just opened (the flag is cleared after use).
    if (state.renamingFile) {
      const input = list.querySelector('[data-rename-input]')
      if (input instanceof HTMLInputElement) {
        input.focus()
        if (state.renamingSelect) {
          input.select()
          state.renamingSelect = false
        } else {
          // The caret goes where the user left it; a fresh element defaults to the end.
          const caret = state.renamingCaret
          input.setSelectionRange(caret, caret)
        }
      }
    }
  }

  async function loadSessions() {
    try {
      const res = await fetch(`${API}/sessions`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `sessions ${res.status}`)
      state.sessions = Array.isArray(data.sessions) ? data.sessions : []
      const main = state.consoles.get('main')
      if (main && data.current) main.sessionFile = data.current
      renderSessions()
      // A conversation another page started is running too, and the spinner has to say so.
      void refreshInstances()
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

  // ── Renaming a session ──────────────────────────────────────────────────────────────
  //
  // A conversation is identified in the rail by whatever pi wrote into it — usually the
  // first thing the user said, which reads like a command, not a title. Naming a session
  // writes the same `session_info` entry pi's own `/name` writes, so the label sticks
  // everywhere the store is read, and the running agent (if any) is told through its bridge.
  // The edit happens in place on the row: the label becomes an input, Enter saves, Escape
  // or a click elsewhere cancels.

  /**
   * Starts editing one session's name on its own rail row. A row the store does not list
   * yet (a conversation opened but not saved) cannot be renamed — there is no file to
   * append the name to.
   * @param {string} file
   */
  function openRename(file) {
    if (!file) return
    const session = state.sessions.find((row) => row.file === file)
    if (!session) return
    state.renamingFile = file
    state.renamingValue = session.name || rowLabel(session)
    state.renamingSelect = true
    state.renamingCaret = 0
    renderSessions()
  }

  /** Stops editing without saving. */
  function closeRename() {
    if (!state.renamingFile) return
    state.renamingFile = null
    state.renamingValue = ''
    renderSessions()
  }

  /** The input of the row currently being renamed, if any. */
  function renameInput() {
    return /** @type {HTMLInputElement | null} */ ($('hx-session-list')?.querySelector('[data-rename-input]')) || null
  }

  /** Reads the in-place input and writes the name to the store. */
  async function saveRename() {
    const file = state.renamingFile
    const input = renameInput()
    const name = input ? input.value.trim() : ''
    if (!file) return
    if (!name) {
      closeRename()
      return
    }
    try {
      const res = await fetch(`${API}/sessions/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: file, name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || `rename ${res.status}`)
      state.renamingFile = null
      state.renamingValue = ''
      setHint(`Session renamed: ${data.label || name}`, 'success')
      await loadSessions()
    } catch (err) {
      // The edit stays open so the user can fix or escape it; the message says what failed.
      setHint(err?.message || 'Could not rename that session.', 'error')
    }
  }

  /** Rebuilds one conversation from the session file its agent is attached to. */
  async function loadMessages(ctx = active()) {
    const res = await fetch(consoleApi(ctx, '/messages'))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Could not read the conversation.')
    }
    ctx.items = []
    ctx.tools.clear()
    if (ctx === active()) {
      state.items = ctx.items
      state.tools = ctx.tools
      state.mounted = 0
    }
    // A tool's command line is part of the assistant message that called it (`toolCall` parts
    // carry `arguments`), while the row is rebuilt from the `toolResult` that follows — which
    // holds only the output. Collecting the calls first is what puts the command back on a row
    // after a restart; without it every resumed bash call read as a bare "bash done".
    const calls = new Map()
    for (const message of data.messages || []) {
      if (message.role === 'user') {
        ctx.items.push({ kind: 'user', text: textFromBlocks(message.content) })
      } else if (message.role === 'assistant') {
        const blocks = contentParts(message.content)
        // A turn that only called tools wrote no prose. Its tool rows carry that story, and an
        // empty bubble would sit in the transcript as "…" forever after a resume.
        if (blocks.length) ctx.items.push({ kind: 'assistant', blocks })
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (!part || part.type !== 'toolCall') continue
          calls.set(String(part.id || part.name || 'tool'), {
            name: part.name || 'tool',
            args: part.arguments && typeof part.arguments === 'object' ? part.arguments : null,
          })
        }
      } else if (message.role === 'toolResult') {
        const key = String(message.toolCallId || message.toolName || 'tool')
        const call = calls.get(key)
        calls.delete(key)
        const item = {
          kind: 'tool',
          id: key,
          name: message.toolName || call?.name || 'tool',
          args: call?.args || null,
          status: message.isError ? 'error' : 'ok',
          result: clip(resultText(message), MAX_TOOL),
          partial: '',
        }
        ctx.tools.set(key, item)
        ctx.items.push(item)
      }
    }
    // A call that never returned — the turn was interrupted, or the app was closed while the
    // command ran — still happened, so it keeps its row instead of disappearing on a reopen.
    for (const [key, call] of calls) {
      const item = {
        kind: 'tool',
        id: key,
        name: call.name,
        args: call.args,
        status: 'running',
        result: '',
        partial: '',
      }
      ctx.tools.set(key, item)
      ctx.items.push(item)
    }
    syncTranscript({ reset: true }, ctx)
    // This console's transcript now comes from its session file, which is authoritative and
    // survives a restart; the replay log is no longer needed to describe it.
    ctx.historyLoaded = true
  }

  /**
   * Bring a conversation on screen without disturbing any other.
   *
   * Clicking a session used to resume it into the one console, which restarted the agent and
   * ended whatever was running. Every conversation is its own console now: one already open
   * here is simply shown, one another page opened is attached to, and one nobody has open gets
   * a parallel console of its own beside the ones that are working.
   */
  async function openConversation(file) {
    if (!file) return
    const open = [...state.consoles.values()].find((candidate) => candidate.sessionFile === file)
    if (open) {
      activate(open)
      return
    }
    setHint('Opening that conversation…')
    try {
      const remote = await findInstanceFor(file)
      if (remote) {
        await attachConsole(remote)
        return
      }
      await openInstance(file)
    } catch (err) {
      setHint(err?.message || 'Could not open that conversation.', 'error')
    }
  }

  /** A parallel console the server is already running on that session, if any. */
  async function findInstanceFor(file) {
    try {
      const res = await fetch(`${API}/instances`)
      if (!res.ok) return null
      const data = await res.json().catch(() => ({}))
      return (data.instances || []).find((entry) => entry.sessionFile === file) || null
    } catch {
      return null
    }
  }

  /** Adopts a console another page opened: its event stream is the conversation. */
  async function attachConsole(entry) {
    const ctx = createConsole({
      id: entry.id,
      instanceId: entry.id,
      sessionFile: entry.sessionFile || null,
    })
    ctx.phase = entry.phase || 'idle'
    connectEvents(ctx)
    activate(ctx)
    rememberOpenFile(ctx.sessionFile)
    saveOpenConversations()
    try {
      await loadMessages(ctx)
      await refreshStatus(ctx)
      setHint('')
    } catch (err) {
      setHint(err?.message || 'Could not read that conversation.', 'error')
    }
  }

  /** Starts a conversation beside the others. No session starts a fresh one. */
  async function openInstance(sessionFile) {
    // A conversation has one console: opening it again focuses the one already running rather
    // than starting a second agent on the same session file.
    if (sessionFile) {
      const open = [...state.consoles.values()].find((ctx) => ctx.sessionFile === sessionFile)
      if (open) {
        activate(open)
        return open
      }
    }
    const body = sessionFile ? { session: sessionFile } : {}
    const start = () =>
      fetch(`${API}/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    let res = await start()
    if (res.status === 429) {
      // The server caps parallel consoles. An idle conversation nobody is looking at is not
      // doing anything, so its slot is the one to reuse rather than refusing the new one.
      if (await closeIdleConsole()) res = await start()
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Could not start a conversation (${res.status}).`)
    const ctx = createConsole({
      id: data.id,
      instanceId: data.id,
      sessionFile: data.instance?.sessionFile || sessionFile,
    })
    connectEvents(ctx)
    activate(ctx)
    // Every open tab is one the next page reopens, whether it was just started or restored.
    rememberOpenFile(ctx.sessionFile)
    if (sessionFile) await restoreHistory(ctx)
    saveOpenConversations()
    setHint(sessionFile ? '' : 'New conversation.', 'success')
    renderSessions()
    return ctx
  }

  /** Closes an idle console that is not on screen, freeing a parallel slot. */
  async function closeIdleConsole() {
    const spare = [...state.consoles.values()].find(
      (candidate) => candidate.instanceId && !candidate.running && candidate.id !== state.activeId,
    )
    if (!spare) return false
    await fetch(`${API}/instances/${spare.id}/close`, { method: 'POST' }).catch(() => {})
    spare.source?.close()
    state.consoles.delete(spare.id)
    // Closing a conversation is the one thing that forgets it: it is not idle by accident.
    if (spare.sessionFile) openFiles.delete(spare.sessionFile)
    saveOpenConversations()
    return true
  }

  /** Which conversations are working right now, including ones another page started. */
  async function refreshInstances() {
    let instances
    try {
      const res = await fetch(`${API}/instances`)
      if (!res.ok) return
      instances = (await res.json().catch(() => ({}))).instances || []
    } catch {
      return
    }
    const running = new Set()
    for (const entry of instances) {
      if (entry.sessionFile && (entry.phase === 'busy' || entry.isStreaming)) {
        running.add(entry.sessionFile)
      }
    }
    const changed =
      running.size !== state.runningSessions.size ||
      [...running].some((file) => !state.runningSessions.has(file))
    state.runningSessions = running
    if (changed) renderSessions()
  }

  // ── Command palette ─────────────────────────────────────────────────────────────────

  const COMMANDS = [
    { label: 'Focus the prompt', hint: 'Enter', run: () => $('hx-input')?.focus() },
    { label: 'New session', hint: '/new', run: newSession },
    { label: 'Stop the agent', hint: '/stop', run: stopRun },
    { label: 'Restart the agent', run: restartAgent },
    {
      label: 'Rename the current session…',
      run: () => {
        const file = active()?.sessionFile
        if (!file) {
          setHint('This conversation has not been saved yet.', 'error')
          return
        }
        openRename(file)
      },
    },
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
    $('hx-attach')?.addEventListener('click', () => $('hx-file')?.click())
    $('hx-file')?.addEventListener('change', (event) => {
      addAttachments(event.target?.files || [])
      // Clearing the value lets the same file be chosen again after a remove.
      event.target.value = ''
    })
    wireComposerDrop()
    $('hx-queue-mode')?.addEventListener('click', () =>
      setQueueMode(state.queueMode === 'followUp' ? 'steer' : 'followUp'),
    )
    $('hx-thinking')?.addEventListener('click', cycleThinking)

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

    // In-place rename on a rail row: keystrokes keep the value and caret so a re-render
    // (a status frame) cannot throw the edit away, Enter saves, Escape cancels.
    $('hx-session-list')?.addEventListener('input', (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || !input.matches('[data-rename-input]')) return
      state.renamingValue = input.value
      state.renamingCaret = input.selectionStart ?? input.value.length
    })
    $('hx-session-list')?.addEventListener('keydown', (event) => {
      if (!state.renamingFile) return
      if (event.key === 'Enter') {
        event.preventDefault()
        void saveRename()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeRename()
      }
    })
    // A click anywhere else cancels the edit — but a click inside the list (the pencil of
    // another row, or the input itself) is handled by its own listener below, so it passes.
    document.addEventListener('pointerdown', (event) => {
      if (!state.renamingFile) return
      if (event.target instanceof Node && $('hx-session-list')?.contains(event.target)) return
      closeRename()
    })

    $('hx-session-list')?.addEventListener('click', (event) => {
      // The pencil is inside the row button; it renames instead of opening, so it has to be
      // caught first and the click kept from reaching the row's own handler.
      const pencil = event.target.closest('[data-rename]')
      if (pencil) {
        event.preventDefault()
        event.stopPropagation()
        openRename(pencil.dataset.rename)
        return
      }
      const row = event.target.closest('[data-session]')
      if (!row) return
      document.body.classList.remove('hx-drawer-open')
      openConversation(row.dataset.session)
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
        if (state.renamingFile) {
          closeRename()
          return
        }
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
    // The main console is the conversation this page has always opened on; every other one is
    // added beside it as it is opened, and neither disturbs the other's turn.
    const main = createConsole({ id: 'main' })
    state.activeId = null
    activate(main)
    renderSessions()
    // Status first: it is what names the conversation. An idle console is then rebuilt from its
    // session file before the stream opens, so the first paint after a restart shows the whole
    // conversation rather than whatever the router still had in memory (often nothing).
    await refreshStatus(main)
    if (main.sessionFile && !main.running) await restoreHistory(main)
    connectEvents(main)
    await loadSessions()
    autoGrow()
    void restoreOpenConversations()
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
