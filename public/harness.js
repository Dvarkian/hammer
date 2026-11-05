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
  const SIDEBARS_KEY = 'hammer.hx.sidebars'

  /**
   * Which sidebars are open, persisted across pages. Both default to open: a first visit
   * should show everything and let the reader put it away, not hand over an empty shell.
   */
  function loadSidebarState() {
    try {
      const raw = JSON.parse(localStorage.getItem(SIDEBARS_KEY) || '{}')
      return { sessions: raw.sessions !== false, details: raw.details !== false }
    } catch {
      return { sessions: true, details: true }
    }
  }

  function saveSidebarState(next) {
    try {
      localStorage.setItem(SIDEBARS_KEY, JSON.stringify(next))
    } catch {
      // A private-mode browser without storage simply forgets the choice for the session.
    }
  }

  function applySidebarState(state) {
    document.body.classList.toggle('hx-sessions-collapsed', !state.sessions)
    document.body.classList.toggle('hx-details-collapsed', !state.details)
    const sessionsBtn = $('hx-toggle-sessions')
    const detailsBtn = $('hx-toggle-details')
    if (sessionsBtn) sessionsBtn.setAttribute('aria-pressed', String(state.sessions))
    if (detailsBtn) detailsBtn.setAttribute('aria-pressed', String(state.details))
  }

  function toggleSidebar(which) {
    const next = loadSidebarState()
    next[which] = !next[which]
    saveSidebarState(next)
    applySidebarState(next)
  }
  const MAX_TEXT = 120000

  const state = {
    /** Every conversation this page holds open, by console id. `main` always exists. */
    consoles: new Map(),
    /** Which of them is on screen. `null` until init binds the main console. */
    activeId: null,
    /** Conversations reported as working from /api/pi/instances, including other tabs'. */
    runningSessions: new Set(),
    items: [],
    mounted: 0,
    lastRole: null,
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
  // `/api/pi/instances/:id/console`. One page-wide stream carries every console, so a turn that
  // is not on screen keeps running — and keeps its spinner in the sidebar turning — without each
  // conversation spending one of the browser's six connections per host. `state` mirrors the
  // console on screen, which is why every renderer below is still written against one
  // conversation.

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
    // Unsent text belongs to the conversation, so switching tabs swaps the draft with it.
    restoreDraft(console)
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
  /** Where unsent composer text is remembered, one entry per conversation. */
  const DRAFT_PREFIX = 'hammer.hx.draft:'

  /**
   * The storage key for one conversation's unsent text.
   *
   * Keyed by session file, which is the identity that survives a restart: a tab restored after
   * reopening Hammer has a different instance id but the same session file. A conversation that
   * has not sent anything yet has no file, so it falls back to its console id — stable for the
   * main console ('main'), and close enough for a parallel tab that only exists while the page
   * does.
   */
  function draftKey(console) {
    if (!console) return null
    return DRAFT_PREFIX + (console.sessionFile || `console:${console.id}`)
  }

  /** Remembers what is in the composer for this conversation, before it has been sent. */
  function saveDraft(console, text) {
    const key = draftKey(console)
    if (!key) return
    try {
      if (text) localStorage.setItem(key, text)
      else localStorage.removeItem(key)
    } catch {
      // A browser without storage simply does not remember anything.
    }
  }

  /** Puts a conversation's remembered text back into the composer. */
  function restoreDraft(console) {
    const input = $('hx-input')
    if (!input) return
    const key = draftKey(console)
    let text = ''
    if (key) {
      try {
        text = localStorage.getItem(key) || ''
      } catch {
        text = ''
      }
    }
    input.value = text
    autoGrow()
  }

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
      // Every open conversation is remembered, not just the last few: a tab the page forgets
      // would keep its console running as an orphan the page can never close.
      localStorage.setItem(OPEN_KEY, JSON.stringify(ordered))
    } catch {
      // A browser without storage simply does not restore anything.
    }
  }

  /** Notes that a conversation is open, so the next page (or restart) reopens it. */
  function rememberOpenFile(file, running = false) {
    if (!file || typeof file !== 'string') return
    if (!openFiles.has(file)) {
      openFiles.set(file, Boolean(running))
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
      if (ctx) ctx.pendingFullRestore = false
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
      // The session usage plot (agent rail) was sized while this view was hidden, so its
      // width measurement was the fallback. Now that the rail has a real box, redraw it.
      if (typeof window.drawUsagePlots === 'function') {
        requestAnimationFrame(() => window.drawUsagePlots())
      }
    }
  }

  // ── Rendering the transcript ────────────────────────────────────────────────────────

  const EMPTY_MARKUP = `
    <div class="hx-empty">
      <svg class="hx-empty-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="#7d2231"/>
        <g transform="translate(-0.17 2.22) rotate(-32 16 16) translate(16 16) scale(1.05) translate(-16 -16)">
          <path d="M11.75 8.6L15.25 8.6C15.15 13 15 18 15 20.8C15 22.8 15.2 24.6 15.25 25.8C15.3 27.3 14.7 27.9 13.5 27.9C12.3 27.9 11.7 27.3 11.75 25.8C11.8 24.6 12 22.8 12 20.8C12 18 11.85 13 11.75 8.6Z" fill="#d9c3bb"/>
          <path d="M21.6 6.9L22.6 7.5L22.6 10.9L21.8 11.3C18.8 11.9 16.2 11.9 13.8 11.4C12.2 11.1 11 10.3 10.2 9.2C9 10.4 7.4 11.9 6.4 13.1C6 13.6 5.4 13.4 5.4 12.8C5.3 11.2 5.6 9.4 6.5 8C7.5 6.7 9 6.3 10.4 6.1C13.8 5.8 18.2 6.2 21.6 6.9Z" fill="#f6ece5"/>
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

  /**
   * The command a tool call ran, as it was written.
   *
   * Newlines are kept and nothing is trimmed: a command written over several lines is a
   * different command from the same words joined with spaces, and a summary that flattened it
   * hid exactly the part that matters. The head of the row wraps instead of clipping.
   */
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
    return String(raw)
  }

  function assistantMarkup(item, showRole = true) {
    const blocks = item.blocks || []
    const role = showRole ? '<div class="hx-role">Hammer</div>' : ''
    if (!blocks.length) {
      return `${role}<div class="hx-assistant hx-pending">…</div>`
    }
    const body = blocks
      .map((block) => {
        if (block.kind === 'thinking') {
          return `<div class="hx-thinking"><div class="hx-thinking-text">${renderText(block.text || '')}</div></div>`
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
  /**
   * An icon per tool, drawn in a 24x24 box and stroked in currentColor so the badge colour —
   * maroon while the call runs, muted once it is done, red when it failed — is the only tint
   * it needs. Kept to a handful of paths: they render at 12px.
   */
  function toolIcon(name) {
    const key = String(name || '').toLowerCase()
  const icons = {
    bash: '<path d="M5 5l5.5 5.5L5 16"/><path d="M13 8h7"/><path d="M13 17h6"/>',
    read: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h6M10 15.5h6"/>',
    edit: '<path d="M4 20l1.4-4.2L16.6 4.6a2.1 2.1 0 0 1 3 3L8.2 18.6z"/><path d="M14.6 6.6l3 3"/>',
    write: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M12 11v7M8.5 14.5h7"/>',
    grep: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 21 21"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 21 21"/>',
    glob: '<path d="M3 6.5h6l2 2h10v11H3z"/>',
    ls: '<path d="M3 5h18v14H3z"/><path d="M3 9.5h18"/><path d="M9 9.5V19M14.5 9.5V15"/>',
    task: '<path d="M4 12.5l5.5 5.5L20 6"/>',
    todo: '<path d="M4 12.5l5.5 5.5L20 6"/>',
    webfetch: '<path d="M4 11a8 8 0 0 1 16 0"/><path d="M12 11v7M8.5 14.5 12 18l3.5-3.5"/>',
  }
  const body = icons[key] || '<circle cx="12" cy="12" r="7.5"/><path d="M12 7.5V12l3.5 2"/>'
  return `<span class="hx-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${body}</svg></span>`
  }

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
            ${toolIcon(item.name || 'tool')}
            <span class="hx-tool-name">${escapeHtml(item.name || 'tool')}</span>
            <span class="hx-tool-cmd">${escapeHtml(toolSummary(item))}</span>
            <span class="hx-tool-state">${escapeHtml(meta)}</span>
          </summary>
          ${body}
        </details>`
  }

  /** The role label is shown only when the speaker changes from the row above it.
   *  A tool row is not a speaker: it sits inside an assistant's turn, so it must not
   *  move the current-speaker cursor and make the next assistant line re-print "Hammer". */
  function roleChanged(item) {
    const changed = state.lastRole !== item.kind
    // Tool and notice rows are not speakers: they sit inside an assistant's turn, so
    // they must not move the current-speaker cursor and make the next assistant line
    // re-print "Hammer". Only a real speaker (user or assistant) changes who is talking.
    if (item.kind === 'user' || item.kind === 'assistant') state.lastRole = item.kind
    return changed
  }

  function itemMarkup(item) {
    if (item.kind === 'user') {
      return `<div class="hx-role">You</div><div class="hx-turn-text">${escapeHtml(item.text)}</div>`
    }
    if (item.kind === 'assistant') return assistantMarkup(item, item.showRole !== false)
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
      state.lastRole = null
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
      item.showRole = roleChanged(item)
      row.innerHTML = itemMarkup(item)
      item.node = row
      transcript.appendChild(row)
    }
    state.mounted = state.items.length
    if (stick) transcript.scrollTop = transcript.scrollHeight
    const jump = $('hx-jump')
    if (jump) jump.style.display = atBottom(transcript) ? 'none' : ''
    scheduleMinimap()
  }

  // ── Outline rail ────────────────────────────────────────────────────────────────────
  //
  // The rail on the transcript's right edge marks the model's answers: one maroon tick per
  // turn that produced prose, at the height that turn actually occupies. The transcript's
  // maroon spine is carried by the rows that are the agent's work (tool calls, thinking);
  // the answers are the rows that stand free of it, so those are the ones the rail marks.
  // It is a mirror only — it reads `state.items` and the rows the transcript built, owns no
  // state of its own beyond one paint frame — so switching conversations repaints it from
  // scratch for free, and it can never disagree with the log for longer than one frame.

  /** A tick's height plus the gap under it; keeps proportional marks from fusing together. */
  const MINIMAP_TICK = 5

  /** Between sampled marks, a hairline stands for the rows that were dropped. */
  const MINIMAP_GAP = 3

  /** One paint frame requested, not yet run. */
  let minimapFrame = 0

  /** True while a drag moves the viewport window, so the hover tooltip stands down. */
  let minimapDragging = false

  /** The row a click jumped to, kept just long enough to flash it. */
  let minimapFlashTimer = 0

  /** Coalesces paint requests: streaming appends many rows a second, the rail needs one frame. */
  function scheduleMinimap() {
    if (minimapFrame) return
    minimapFrame = requestAnimationFrame(() => {
      minimapFrame = 0
      renderMinimap()
    })
  }

  /** The excerpt a tooltip (and nothing else) shows for one row. */
  function minimapLabel(item) {
    if (item.kind === 'user') return item.text || ''
    if (item.kind === 'assistant') {
      const text = (item.blocks || [])
        .filter((block) => block.kind === 'text' && block.text)
        .map((block) => block.text)
        .join(' ')
      // A turn that only ran tools is still a turn; its label names that instead.
      if (text.trim()) return text
      const call = (item.blocks || []).find((block) => block.kind === 'toolcall')
      if (call) return `Called ${call.name || 'a tool'}`
      return 'Working…'
    }
    if (item.kind === 'tool') return `${item.name || 'tool'} — ${toolSummary(item)}`
    return item.text || ''
  }

  /**
   * Whether one row earns a mark on the rail.
   *
   * The transcript carries a 2px maroon spine (its left border) on the rows that are the
   * agent's *work* — tool calls and thinking — while the model's answers and the reader's
   * prompts stand free of it. The rail marks those free-standing rows, and only those: the
   * maroon ticks say where Hammer actually said something, the blue ones where you asked,
   * and the hairline gaps say where it worked. A turn that only called tools is work, not
   * an answer, so it stays unmarked.
   */
  function minimapMark(item) {
    if (item.kind === 'user') return true
    if (item.kind === 'assistant') {
      return (item.blocks || []).some((block) => block.kind === 'text' && block.text)
    }
    return false
  }

  /**
   * Rebuilds the rail for the conversation on screen.
   *
   * Positions are measured, not assumed: a tool row is one line while an assistant turn can
   * be a page of prose, so a tick placed at `index / count` would lie about where things sit.
   * When every tick will not fit, user, assistant and notice ticks are kept and the tool
   * rows between them collapse into hairlines — the landmarks stay put, the filler condenses.
   */
  function renderMinimap() {
    const rail = $('hx-minimap')
    const transcript = $('hx-transcript')
    if (!rail || !transcript) return
    if (minimapFrame) {
      cancelAnimationFrame(minimapFrame)
      minimapFrame = 0
    }

    const items = state.items
    const total = items.length
    // Nothing to mirror while the empty state is up: a rail with one dot reads as a progress
    // bar stuck at zero.
    if (!total || transcript.querySelector('.hx-empty')) {
      rail.innerHTML = ''
      rail.hidden = true
      return
    }
    // Unhidden BEFORE measuring. The nav ships with `hidden` in the markup, and `display: none`
    // measures as a 0px track — a guard on clientHeight first would bail forever and the rail
    // could never unhide itself. Below 960px the media query keeps it display:none anyway, so
    // the height check below still skips the narrow layout.
    rail.hidden = false
    // Below 960px the rail is display:none, so it has no height to measure and nothing to
    // draw: measuring a 0px track maps every row onto the same tick.
    if (!rail.clientHeight) return

    // Measured geometry first, all reads before any writes so the whole pass is one layout.
    const transcriptHeight = Math.max(transcript.scrollHeight, 1)
    const measured = items.map((item, index) => {
      const node = item.node
      // A row with no node cannot be positioned — but it also cannot be jumped to, so it
      // drops out of the rail rather than sitting at a fake coordinate.
      if (!node || !node.isConnected) return null
      // A mark stands for what earned it, not for the whole row: on a turn that thought at
      // length before answering, the tick covers the prose alone, not the thinking above it.
      // Thinking and prose share one bubble, so the geometry is the union of the bubble's
      // non-thinking children — first prose top to last prose bottom.
      let markTop = node.offsetTop
      let markHeight = Math.max(node.offsetHeight, 1)
      if (item.kind === 'assistant' && minimapMark(item)) {
        const bubble = node.querySelector(':scope > .hx-assistant')
        if (bubble) {
          const nodeRect = node.getBoundingClientRect()
          const parts = [...bubble.children].filter(
            (el) => !el.classList.contains('hx-thinking'),
          )
          if (parts.length) {
            const first = parts[0].getBoundingClientRect()
            const last = parts[parts.length - 1].getBoundingClientRect()
            markTop = node.offsetTop + (first.top - nodeRect.top)
            markHeight = Math.max(last.bottom - first.top, 1)
          }
        }
      }
      return {
        index,
        item,
        top: node.offsetTop,
        height: markHeight,
        markTop,
        markHeight,
        mark: minimapMark(item),
      }
    })
    const rows = measured.filter(Boolean)
    if (!rows.length) {
      rail.innerHTML = ''
      rail.hidden = true
      return
    }

    // The scale that maps row offsets onto the rail's height. The transcript's bottom edge
    // (its scrollHeight) gets the rail's last pixel: a turn that scrolls further than its
    // last row — the composer's worth of tail — still maps to somewhere on the rail.
    const track = rail.clientHeight || MINIMAP_TICK
    const scale = Math.max((track - MINIMAP_TICK) / Math.max(transcriptHeight - MINIMAP_TICK, 1), 0)

    // Overflow: when marks would fuse, sample. The model's answers stay, the rows between
    // them (tool work, thinking) collapse into gap markers; if even that is not enough, gaps
    // themselves are sampled.
    const capacity = Math.max(Math.floor(track / MINIMAP_TICK), 1)
    let drawn = rows
    let gaps = []
    if (rows.length > capacity) {
      const kept = rows.filter((row) => row.mark)
      if (kept.length && kept.length <= capacity) {
        // Dropped rows whose neighbours are both kept become gaps: a gap between two answers
        // stands for the tool work between them.
        const keptSet = new Set(kept)
        drawn = rows.filter((row, position) => {
          if (keptSet.has(row)) return true
          const previous = rows[position - 1]
          const next = rows[position + 1]
          return !previous || !next || !keptSet.has(previous) || !keptSet.has(next)
        })
      } else {
        // The answers alone overflow: sample everything on a stride. The stride starts at the
        // count that fits and grows until the drawn set does — an even spread beats a
        // clipped tail, which would put the latest turn (the one being read) off the rail.
        let stride = Math.max(Math.ceil(rows.length / capacity), 1)
        for (;;) {
          drawn = rows.filter((_, position) => position % stride === 0)
          if (drawn.length <= capacity || stride >= rows.length) break
          stride += 1
        }
      }
      // A gap marker goes where at least MINIMAP_GAP consecutive rows were dropped.
      gaps = []
      let run = 0
      for (let position = 0; position <= rows.length; position += 1) {
        const row = rows[position]
        if (!row || !drawn.includes(row)) {
          run += 1
          continue
        }
        if (run >= MINIMAP_GAP) {
          const before = rows[position - run]
          const after = row
          // The gap runs between the neighbours' marks, not their whole rows: dropped work
          // that trails a long thinking block should not be drawn under that block's tick.
          const top = Math.round((before.markTop + before.markHeight) * scale)
          const bottom = Math.min(Math.round(after.markTop * scale), track)
          if (bottom - top >= MINIMAP_TICK) gaps.push({ top, height: bottom - top })
        }
        run = 0
      }
    }

    // One rebuild, once: the rail is tens of nodes, and a diff here would outlive its worth.
    const fragment = document.createDocumentFragment()
    for (const row of drawn) {
      if (!row.mark) continue
      const tick = document.createElement('button')
      tick.type = 'button'
      // User prompts and prose answers both carry a kind class; the CSS gives each its colour.
      tick.className = row.item.kind === 'user' ? 'hx-minimap-tick is-user' : 'hx-minimap-tick'
      tick.dataset.index = String(row.index)
      tick.style.top = `${Math.round(row.markTop * scale)}px`
      // A tool row is one line, a turn can be a page: the tick keeps the prose's own height
      // where that is visible, and never less than the tick's minimum.
      tick.style.height = `${Math.max(Math.round(row.markHeight * scale), MINIMAP_TICK)}px`
      tick.setAttribute('aria-label', minimapAriaLabel(row.item))
      fragment.appendChild(tick)
    }
    for (const gap of gaps) {
      const line = document.createElement('span')
      line.className = 'hx-minimap-gap'
      line.style.top = `${gap.top}px`
      line.style.height = `${gap.height}px`
      fragment.appendChild(line)
    }
    rail.replaceChildren(fragment)

    updateMinimapWindow()
  }

  /**
   * The rail tick's accessible name. The excerpt alone: the tick's colour carries the role,
   * and the transcript itself is right there — "Hammer:" in every label would only shout.
   */
  function minimapAriaLabel(item) {
    return minimapLabel(item).replace(/\s+/g, ' ').trim().slice(0, 120)
  }

  /**
   * Moves the translucent window over the part of the log on screen, so the rail also tells
   * you where in the conversation you are, not only what is in it.
   */
  function updateMinimapWindow() {
    const rail = $('hx-minimap')
    const transcript = $('hx-transcript')
    if (!rail || !transcript || rail.hidden) return
    let windowEl = rail.querySelector('.hx-minimap-window')
    if (!windowEl) {
      windowEl = document.createElement('div')
      windowEl.className = 'hx-minimap-window'
      rail.appendChild(windowEl)
    }
    const track = rail.clientHeight || MINIMAP_TICK
    const scrollable = transcript.scrollHeight - transcript.clientHeight
    if (scrollable <= 0) {
      // The whole conversation fits on screen: the window is the whole rail.
      windowEl.style.top = '0px'
      windowEl.style.height = `${track}px`
      return
    }
    const scale = (track - MINIMAP_TICK) / scrollable
    const top = transcript.scrollTop * scale
    const height = Math.max(transcript.clientHeight * scale, MINIMAP_TICK)
    windowEl.style.top = `${Math.round(Math.min(top, track - height))}px`
    windowEl.style.height = `${Math.round(height)}px`
  }

  /**
   * Jumps to the row one tick stands for. The tick map is fresh from the last paint, but the
   * row is re-resolved from state.items: a stream can have replaced it between paint and click.
   */
  function minimapJump(index) {
    const item = state.items[index]
    if (!item || !item.node || !item.node.isConnected) return
    const transcript = $('hx-transcript')
    if (!transcript) return
    // Instant, not smooth: streaming retargets scrollTop many times a second, and an animation
    // in the way turns "follow the bottom" into a fight — the transcript's own scroll is
    // instant for the same reason (see .hx-transcript in harness.css).
    transcript.scrollTop = Math.max(
      0,
      Math.min(
        item.node.offsetTop - transcript.clientHeight / 2 + item.node.offsetHeight / 2,
        transcript.scrollHeight - transcript.clientHeight,
      ),
    )
    if (minimapFlashTimer) clearTimeout(minimapFlashTimer)
    for (const previous of transcript.querySelectorAll('.hx-row-flash')) {
      previous.classList.remove('hx-row-flash')
    }
    item.node.classList.add('hx-row-flash')
    minimapFlashTimer = setTimeout(() => {
      item.node?.classList.remove('hx-row-flash')
      minimapFlashTimer = 0
    }, 900)
  }

  /** Shows the tooltip for the tick under the pointer. */
  function minimapHover(event) {
    const rail = $('hx-minimap')
    if (!rail || minimapDragging) return
    const tick = event.target.closest('.hx-minimap-tick')
    if (!tick) {
      minimapUnhover()
      return
    }
    const item = state.items[Number(tick.dataset.index)]
    if (!item) return
    let tip = rail.querySelector('.hx-minimap-tip')
    if (!tip) {
      tip = document.createElement('div')
      tip.className = 'hx-minimap-tip'
      rail.appendChild(tip)
    }
    // The excerpt speaks for itself: the colours already say who is talking, so the tooltip
    // is just the words.
    tip.innerHTML = escapeHtml(minimapLabel(item))
    tip.style.top = `${tick.offsetTop + tick.offsetHeight / 2}px`
    tip.hidden = false
    rail.classList.add('is-hovering')
  }

  function minimapUnhover() {
    const rail = $('hx-minimap')
    if (!rail) return
    const tip = rail.querySelector('.hx-minimap-tip')
    if (tip) tip.hidden = true
    rail.classList.remove('is-hovering')
  }

  /**
   * Wires the rail: one delegated listener each for clicks and hovers, plus the drag that
   * pans the log by moving the viewport window. Bound once from bind(), not per render.
   */
  function bindMinimap() {
    const rail = $('hx-minimap')
    if (!rail) return
    rail.addEventListener('click', (event) => {
      const tick = event.target.closest('.hx-minimap-tick')
      if (!tick) return
      minimapJump(Number(tick.dataset.index))
    })
    rail.addEventListener('pointerover', minimapHover)
    rail.addEventListener('pointerout', (event) => {
      if (!event.relatedTarget || !rail.contains(event.relatedTarget)) minimapUnhover()
      else if (!event.relatedTarget.closest('.hx-minimap-tick')) minimapUnhover()
    })
    // Dragging the window pans the log. The move is tracked on the rail — pointer capture
    // keeps a fast drag from outrunning it — and the release anywhere ends it.
    rail.addEventListener('pointerdown', (event) => {
      const windowEl = event.target.closest('.hx-minimap-window')
      if (!windowEl) return
      event.preventDefault()
      minimapDragging = true
      rail.setPointerCapture?.(event.pointerId)
      const track = rail.clientHeight || MINIMAP_TICK
      const startY = event.clientY
      const startTop = windowEl.offsetTop
      const transcript = $('hx-transcript')
      if (!transcript) return
      const onMove = (moveEvent) => {
        if (!minimapDragging) return
        const scrollable = transcript.scrollHeight - transcript.clientHeight
        const scale = scrollable / Math.max(track - MINIMAP_TICK, 1)
        const next = startTop + (moveEvent.clientY - startY)
        windowEl.style.top = `${Math.max(0, Math.min(next, track - MINIMAP_TICK))}px`
        transcript.scrollTop = windowEl.offsetTop * scale
      }
      const onUp = () => {
        minimapDragging = false
        rail.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      rail.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
    // A resize changes both the scale and the track, so the whole rail is redrawn.
    window.addEventListener('resize', scheduleMinimap)
    // Scrolling moves the window without repainting ticks: the geometry did not change.
    $('hx-transcript')?.addEventListener('scroll', () => {
      if (minimapFrame) return
      minimapFrame = requestAnimationFrame(() => {
        minimapFrame = 0
        updateMinimapWindow()
      })
    })
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
      if (item.node) item.node.innerHTML = assistantMarkup(item, item.showRole !== false)
      if (stick && transcript) transcript.scrollTop = transcript.scrollHeight
      // The row grew, so every tick after it moved: the rail is repainted rather than nudged.
      scheduleMinimap()
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
        // Tool output is kept whole: a trimmed result is a result that lies about what ran.
        item.partial = resultText(record.partialResult)
        item.status = 'running'
        syncTranscript({}, ctx)
        break
      }
      case 'tool_execution_end': {
        const item = ensureTool(record.toolCallId, record.toolName, ctx)
        item.status = record.isError ? 'error' : record.isError === false ? 'ok' : 'ok'
        item.result = resultText(record.result)
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

  /** The levels the slider maps to, quietest first. `minimal` is left to clients that can spell it. */
  const THINKING_CYCLE = ['off', 'low', 'medium', 'high']

  /**
   * Maps a slider notch (0..3) to a thinking level and tells the agent. The agent declares
   * that it can send one, and the router translates it per provider and per model — a level
   * set here is `high` on a reasoning model and simply absent on one that cannot think, never
   * an error either way. Moving the slider while a turn runs applies to the next turn, not
   * the one in flight.
   */
  async function setThinkingLevel(level) {
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
      const label = $('hx-thinking-level')
      if (label) label.textContent = level
      // The agent's own answer is authoritative: a level it clamps is a level worth showing.
      await refreshStatus(ctx)
    } catch (err) {
      setHint(err?.message || 'Could not change the thinking level.', 'error', ctx)
    }
  }

  /** Reads the slider's notch and applies it. */
  function thinkingFromSlider() {
    const slider = $('hx-thinking-slider')
    if (!slider) return
    setThinkingLevel(THINKING_CYCLE[Number(slider.value)] || 'off')
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
      // Also restore if we skipped the replay log during applyHello (pendingFullRestore).
      if (!ctx.running && (!ctx.historyLoaded || ctx.pendingFullRestore)) {
        ctx.pendingFullRestore = false
        void restoreHistory(ctx)
      }
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
    // Display names for phases whose internal value reads oddly in a pill: the runtime is
    // 'alive' to the bridge, 'Ready' to a person waiting on it.
    const labelFor = { alive: 'Ready', dead: 'down' }
    if (label) label.textContent = labelFor[state.phase] ?? state.phase
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
    const count = $('hx-queue-count')
    if (count) count.textContent = String(items.length)
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
      send.dataset.queued = items.length > 0 ? String(items.length) : ''
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
    const slider = $('hx-thinking-slider')
    if (slider) {
      slider.value = String(THINKING_CYCLE.indexOf(data.thinkingLevel || 'off') >= 0
        ? THINKING_CYCLE.indexOf(data.thinkingLevel)
        : 0)
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
    // Compact token figures — "433k", "1.2M", "8.1k" — one decimal only when a single digit
    // leads the lumped number, so the strip never widens to a full comma-grouped count.
    const compact = n => {
      const v = Number(n)
      if (!Number.isFinite(v) || v < 0) return String(n)
      if (v >= 1e9) { const u = v / 1e9; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}B` }
      if (v >= 1e6) { const u = v / 1e6; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}M` }
      if (v >= 1e3) { const u = v / 1e3; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}k` }
      return String(Math.round(v))
    }
    if (total > 0 && input + output + cacheRead + cacheWrite === 0) {
      // No split available: show the one number we were given.
      parts.push(`${compact(total)} tokens`)
    } else {
      parts.push(`${compact(input)} in · ${compact(output)} out`)
      const cached = cacheRead + cacheWrite
      if (cached > 0) parts.push(`${compact(cached)} cached`)
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
    if (stop) stop.hidden = !state.running
    renderQueueMode()
  }

  // ── The event stream ────────────────────────────────────────────────────────────────

  /**
   * Opens the console event stream.
   *
   * Every console used to keep its own EventSource, and Chromium allows only six HTTP/1.1
   * connections per host. The main console, four parallel consoles and the router's telemetry
   * stream filled that budget, so the next request — a prompt — queued for a socket that never
   * came and the composer sat on "Sending…". One stream carries every console now, and each
   * frame names the one it belongs to.
   */
  let consoleStream = null
  function connectEvents(ctx) {
    if (!window.EventSource) {
      if (ctx) setHint('This browser cannot stream the agent transcript.', 'error', ctx)
      return
    }
    if (consoleStream) return
    const source = new EventSource(`${API}/consoles/events`)
    consoleStream = source
    source.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === 'hello') {
        for (const entry of payload.consoles || []) {
          const target = state.consoles.get(entry.id)
          if (target) applyHello(target, entry)
        }
        return
      }
      const target = state.consoles.get(payload.consoleId)
      if (target) applyConsolePayload(target, payload)
    }
    source.onerror = () => {
      if (active()) setHint('Lost the event stream — reconnecting…', 'error')
    }
    source.onopen = () => {
      if (active()) setHint('')
    }
  }

  /**
   * Rebuilds one console from the stream's opening frame.
   *
   * The replay log describes the conversation only when the transcript was not rebuilt from
   * the session file. Resetting here unconditionally is what emptied a tab that had just been
   * restored: the file's history was cleared and the log was then skipped.
   *
   * For a console that is streaming when the hello arrives (mid-turn after restart), defer
   * to restoreHistory instead of using the bounded replay log. The replay log is capped at
   * 400 events or 512KB, which loses early history in long sessions.
   */
  function applyHello(ctx, entry) {
    const status = entry.status
    const isStreaming = status && (status.phase === 'busy' || Boolean(status.isStreaming))

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
      // A page opened mid-run catches up from the log instead of starting from whatever this
      // tab happened to witness.
      ;(entry.log || []).forEach((record) => applyRecord(record, ctx))
      // The replay log is bounded (REPLAY_LIMIT/REPLAY_MAX_CHARS), so a streaming console
      // after restart may only recover recent history. Mark for a full authoritative load
      // from the session file once the turn settles (setRunning edge), losing no early text.
      if (isStreaming && status && status.sessionFile) {
        ctx.pendingFullRestore = true
      }
    }
    applyStatusFrame(ctx, entry.status)
    // If the turn already settled by the time hello arrived, restore immediately instead
    // of waiting for a running-edge that will never come.
    if (!ctx.running && ctx.pendingFullRestore && !ctx.historyLoaded) {
      ctx.pendingFullRestore = false
      void restoreHistory(ctx)
    }
    if (ctx === active()) updateComposer()
    syncTranscript({ reset: true }, ctx)
    renderSessions()
  }

  /** Applies the state a console reports, from a hello or a live status frame. */
  function applyStatusFrame(ctx, status) {
    if (!status) return
    ctx.status = status
    if (status.sessionFile) rememberSessionFile(ctx, status.sessionFile)
    setPhase(status.phase, ctx)
    setRunning(status.phase === 'busy' || Boolean(status.isStreaming), ctx)
    renderRouting(status, ctx)
    // The status carries pi's own queue accounting, so a page opened mid-run sees what is
    // already waiting without waiting for a fresh `queue_update`.
    if (Array.isArray(status.queuedSteering) || Array.isArray(status.queuedFollowUp)) {
      applyQueue(status.queuedSteering, status.queuedFollowUp, ctx)
    }
    // The status frame carries the session's rehydrated totals, so a page opened after the
    // tokens were spent still shows them without waiting for a fresh turn.
    if (status.usage) {
      ctx.usage = status.usage
      if (ctx === active()) {
        state.usage = ctx.usage
        renderUsage(ctx)
      }
    }
  }

  /** Applies one live frame to the console it names. */
  function applyConsolePayload(ctx, payload) {
    switch (payload.type) {
      case 'event':
        applyRecord(payload.record, ctx)
        return
      case 'status':
        applyStatusFrame(ctx, payload.status)
        if (ctx === active()) updateComposer()
        return
      case 'usage':
        ctx.usage = payload.usage || payload
        if (ctx === active()) {
          state.usage = ctx.usage
          renderUsage(ctx)
        }
        return
      case 'log':
        if (payload.text) {
          ctx.items.push({
            kind: 'notice',
            tone: 'info',
            text: String(payload.text).slice(0, 500),
          })
          syncTranscript({}, ctx)
        }
        return
      case 'exit':
        setRunning(false, ctx)
        ctx.items.push({
          kind: 'notice',
          tone: 'error',
          text: payload.message || 'The agent exited.',
        })
        syncTranscript({}, ctx)
        refreshStatus(ctx)
        return
      case 'notice':
        if (payload.text) {
          ctx.items.push({ kind: 'notice', tone: 'info', text: String(payload.text) })
          syncTranscript({}, ctx)
        }
        return
      default:
        return
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
      saveDraft(console, '')
      await newSession()
      return
    }
    if (text === '/stop') {
      input.value = ''
      saveDraft(console, '')
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
        body: JSON.stringify({
          message: text,
          images: images.length ? images : undefined,
          queueMode: state.queueMode,
        }),
        signal: control.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The agent rejected the prompt (${res.status}).`)
      input.value = ''
      // The text was sent, so the draft's job is done. Clearing by the pre-send identity matters
      // for a first message: the reply names a new session file, and the draft key moves with it.
      saveDraft(console, '')
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
      // The old conversation's draft is gone with it: a fresh session should not inherit text
      // that belonged to the one just left behind.
      saveDraft(console, '')
      restoreDraft(console)
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
    if (ctx.sessionFile === file) return
    if (!file) {
      // A detached console (deleted session, or fresh reset) has no file.
      ctx.sessionFile = null
      return
    }
    const previousKey = draftKey(ctx)
    const wasActive = ctx === active()
    ctx.sessionFile = file
    // The draft moves with the conversation: a conversation that has not sent anything yet is
    // keyed by its console id, and the file it starts writing is what survives a restart.
    if (previousKey) {
      try {
        const pending = localStorage.getItem(previousKey)
        if (pending) {
          localStorage.setItem(draftKey(ctx), pending)
          localStorage.removeItem(previousKey)
        }
      } catch {
        // A browser without storage simply does not remember anything.
      }
    }
    // A parallel conversation is one the next page should reopen, whatever brought its file in.
    if (ctx.instanceId) rememberOpenFile(file)
    // The main console starts unnamed and learns its file from the first status frame, after
    // the page has already painted. That status is when the draft saved under the fallback key
    // becomes readable under the session-file key the next restart will look for.
    if (wasActive) restoreDraft(ctx)
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
              <span class="hx-session-rename" data-rename="${escapeHtml(session.file)}" role="button" title="Rename this session" aria-label="Rename session">✎</span><span class="hx-session-delete" data-delete="${escapeHtml(session.file)}" role="button" title="Delete this session" aria-label="Delete session">✕</span>
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

  /**
   * Deletes one saved session after a confirm. Deletion is immediate — the file is gone,
   * not moved aside — so the browser's own dialog is the one undo this affordance has. A
   * running conversation is refused by the server as well as here, but checking first keeps
   * the obvious case from being a round trip that answers "no".
   * @param {string} file
   */
  async function deleteSession(file) {
    if (!file) return
    if (isSessionRunning(file)) {
      setHint('That conversation is running — stop it before deleting it.', 'error')
      return
    }
    const session = state.sessions.find((row) => row.file === file)
    const label = session ? rowLabel(session) : 'this session'
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`${API}/sessions/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: file }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || `delete ${res.status}`)
      setHint('Session deleted.', 'success')
      // Clear the sessionFile from any console that was attached to it.
      for (const ctx of state.consoles.values()) {
        if (ctx.sessionFile === file) {
          ctx.sessionFile = null
        }
      }
      await loadSessions()
    } catch (err) {
      setHint(err?.message || 'Could not delete that session.', 'error')
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
          result: resultText(message),
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
    // The shared stream's hello was sent before this console existed, so ask for its status
    // rather than waiting for the next live frame.
    void refreshStatus(ctx)
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

  /**
   * Walks the conversation's prompts — the user turns — by `direction`. They are the
   * landmarks of a long session, so they are what the outline rail exists to reach fast.
   */
  function jumpPrompt(direction) {
    const prompts = state.items.filter((item) => item.kind === 'user')
    if (!prompts.length) return
    // Which prompt the reader is standing on: the last one at or above the top of the view.
    const transcript = $('hx-transcript')
    const edge = transcript ? transcript.scrollTop + 1 : 0
    let current = -1
    prompts.forEach((item, index) => {
      if (item.node && item.node.offsetTop <= edge) current = index
    })
    const next = Math.min(Math.max(current + direction, 0), prompts.length - 1)
    const item = prompts[next]
    if (item && item.node) minimapJump(state.items.indexOf(item))
  }

  // ── Command palette ─────────────────────────────────────────────────────────────────

  const COMMANDS = [
    { label: 'Focus the prompt', hint: 'Enter', run: () => $('hx-input')?.focus() },
    { label: 'New session', hint: '/new', run: newSession },
    { label: 'Stop the agent', hint: '/stop', run: stopRun },
    { label: 'Previous prompt', hint: 'Alt+↑', run: () => jumpPrompt(-1) },
    { label: 'Next prompt', hint: 'Alt+↓', run: () => jumpPrompt(1) },
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
        document.body.classList.add('hx-sessions-drawer-open')
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
    input?.addEventListener('input', () => {
      autoGrow()
      // Every keystroke is one worth keeping: the draft survives a tab switch and a restart.
      saveDraft(active(), input.value)
    })
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

    // Sidebar toggles: each header button folds its own column, and the choice persists.
    applySidebarState(loadSidebarState())
    $('hx-toggle-sessions')?.addEventListener('click', () => toggleSidebar('sessions'))
    $('hx-toggle-details')?.addEventListener('click', () => toggleSidebar('details'))

    $('hx-queue-mode')?.addEventListener('click', () =>
      setQueueMode(state.queueMode === 'followUp' ? 'steer' : 'followUp'),
    )
    $('hx-thinking-slider')?.addEventListener('input', thinkingFromSlider)

    // The outline rail on the transcript's right edge. Bound once; renderMinimap repaints it.
    bindMinimap()

    // The inspector is a drawer below 960px. A toggle, Escape, or a click outside closes it.
    $('hx-details')?.addEventListener('click', (event) => {
      event.stopPropagation()
      document.body.classList.toggle('hx-drawer-open')
    })
    document.addEventListener('click', (event) => {
      for (const cls of ['hx-drawer-open', 'hx-sessions-drawer-open']) {
        if (!document.body.classList.contains(cls)) continue
        if (event.target.closest('.hx-side')) return
        if (cls === 'hx-drawer-open' && event.target.closest('#hx-details')) return
        if (cls === 'hx-sessions-drawer-open' && event.target.closest('#hx-toggle-sessions')) return
        document.body.classList.remove(cls)
      }
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
      // The delete button is inside the row button; it deletes instead of opening.
      const deleteBtn = event.target.closest('[data-delete]')
      if (deleteBtn) {
        event.preventDefault()
        event.stopPropagation()
        deleteSession(deleteBtn.dataset.delete)
        return
      }
      const row = event.target.closest('[data-session]')
      if (!row) return
      document.body.classList.remove('hx-drawer-open')
      document.body.classList.remove('hx-sessions-drawer-open')
      openConversation(row.dataset.session)
    })

    $('hx-transcript')?.addEventListener('click', (event) => {
      const suggestion = event.target.closest('[data-prompt]')
      if (!suggestion) return
      const box = $('hx-input')
      if (!box) return
      box.value = suggestion.dataset.prompt || ''
      saveDraft(active(), box.value)
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

    // The tool head doubles as a disclosure trigger and as selectable text. A drag that ends on
    // it would otherwise toggle the row closed/open as a side effect of copying, so swallow the
    // summary's default activation whenever the click is actually the end of a selection.
    $('hx-transcript')?.addEventListener(
      'click',
      (event) => {
        const summary = event.target.closest?.('summary.hx-tool-head')
        if (!summary) return
        const selection = window.getSelection()
        if (selection && selection.type === 'Range' && selection.containsNode(summary, true)) {
          event.preventDefault()
          event.stopPropagation()
        }
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
        else {
          document.body.classList.remove('hx-drawer-open')
          document.body.classList.remove('hx-sessions-drawer-open')
        }
        return
      }
      // Cmd/Ctrl+J returns to the agent from anywhere in the router views.
      if (meta && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        showView('agent')
        return
      }
      // Alt+↑/↓ walk the conversation's prompts — the outline rail's landmarks, reachable
      // from the keyboard too. The composer is exempt: an arrow there moves the caret.
      if (event.altKey && !meta && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
        event.preventDefault()
        jumpPrompt(event.key === 'ArrowUp' ? -1 : 1)
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
