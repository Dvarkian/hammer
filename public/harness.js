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

  /** The width at which both sidebars stop being columns and become drawers (harness.css). */
  const DRAWER_QUERY = '(max-width: 960px)'

  /**
   * Whether the page is showing drawers rather than columns.
   *
   * Read from the same query the stylesheet uses, because the two layouts are controlled by
   * different things: a column is folded by a `*-collapsed` class on the body, a drawer is
   * moved by a `*drawer-open` class. A toggle that always flipped the column class did nothing
   * at all on a narrow window — the media query deliberately re-displays the collapsed column
   * as a drawer — which is what made the header buttons look broken there.
   */
  function drawerLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia(DRAWER_QUERY).matches
  }

  /** The body class that holds one sidebar's drawer open, and the one belonging to the other. */
  function drawerClasses(which) {
    return which === 'sessions'
      ? { open: 'hx-sessions-drawer-open', other: 'hx-drawer-open' }
      : { open: 'hx-drawer-open', other: 'hx-sessions-drawer-open' }
  }

  /** `aria-pressed` means "on screen", whichever layout is drawing the sidebar. */
  function syncSidebarPressed() {
    const drawers = drawerLayout()
    const stored = loadSidebarState()
    const sessionsOn = drawers
      ? document.body.classList.contains('hx-sessions-drawer-open')
      : stored.sessions
    const detailsOn = drawers ? document.body.classList.contains('hx-drawer-open') : stored.details
    const sessionsBtn = $('hx-toggle-sessions')
    const detailsBtn = $('hx-toggle-details')
    if (sessionsBtn) sessionsBtn.setAttribute('aria-pressed', String(sessionsOn))
    if (detailsBtn) detailsBtn.setAttribute('aria-pressed', String(detailsOn))
  }

  /** Opens or closes one drawer, and never both: they cover the same narrow screen. */
  function setDrawer(which, open) {
    const { open: cls, other } = drawerClasses(which)
    document.body.classList.remove(other)
    document.body.classList.toggle(cls, Boolean(open))
    syncSidebarPressed()
  }

  /** Closes whichever drawer is open, if any. */
  function closeDrawers() {
    document.body.classList.remove('hx-drawer-open', 'hx-sessions-drawer-open')
    syncSidebarPressed()
  }

  function applySidebarState(state) {
    document.body.classList.toggle('hx-sessions-collapsed', !state.sessions)
    document.body.classList.toggle('hx-details-collapsed', !state.details)
    syncSidebarPressed()
  }

  function toggleSidebar(which) {
    // A narrow window has no columns to fold: the same button moves the drawer the CSS is
    // actually showing, or it would appear to do nothing.
    if (drawerLayout()) {
      const { open: cls } = drawerClasses(which)
      setDrawer(which, !document.body.classList.contains(cls))
      return
    }
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
      /** True while a rebuild from that file is in flight, so it is not started twice. */
      historyLoading: false,
      /** The model `best` resolved to, as the router reported it (see renderRouting). */
      routedModel: null,
      /** The route's identity, so a repeated status does not erase the last answer's label. */
      routedModelKey: null,
      /** The concrete model named by the newest assistant message, when one is known. */
      answeredModel: null,
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
    // The details rail belongs to the conversation on screen. Repaint it here as well as on
    // status frames: a tab switch must not leave the previous conversation's compaction state
    // (or its disabled button) sitting beside the newly active transcript.
    renderCompactionPanel(console)
    syncTranscript({ reset: true }, console)
    paintHint(console)
    updateComposer()
    renderSessions()
    saveOpenConversations()
    // The tabs above leave this conversation out, so it is remembered on its own: a restart has
    // to know which one to put back in front of the reader (see LAST_KEY).
    rememberViewed(console)
    // A console can be shown before its transcript was ever rebuilt — it is the one the rail
    // click had to activate, or the one a restart resumed mid-turn. Arm the stall check here so
    // the wait ends in the file being read rather than in an empty log.
    watchStalledHistory(console)
    // The rail follows the conversation on screen: the plot is this console's history now,
    // which is the difference between "the last hour" (the router's own view) and "this
    // conversation, all of it". A console with no file yet publishes the router's view back.
    void publishSessionUsage(console)
  }

  /** Where the open conversations are remembered between page loads (and restarts). */
  const OPEN_KEY = 'hammer.hx.open'
  /** Where the conversation last on screen is remembered, whichever console held it. */
  const LAST_KEY = 'hammer.hx.last'
  /** Where unsent composer text is remembered, one entry per conversation. */
  const DRAFT_PREFIX = 'hammer.hx.draft:'

  /**
   * Remembers the conversation on screen.
   *
   * `OPEN_KEY` records the tabs, which is every conversation *except* the one the page lands
   * on: a single conversation was never a tab to reopen, so a restart had nothing to put back
   * in front of the reader and left them on an empty console. This is that missing half,
   * written whenever a conversation takes the screen or starts writing its file.
   */
  function rememberViewed(console) {
    if (!console?.sessionFile) return
    try {
      localStorage.setItem(LAST_KEY, console.sessionFile)
    } catch {
      // A browser without storage simply does not remember.
    }
  }

  /** The conversation the last page was showing, if it remembered one. */
  function lastViewedFile() {
    try {
      return localStorage.getItem(LAST_KEY) || null
    } catch {
      return null
    }
  }

  // Read once, before boot can overwrite it: the page activates its main console — a fresh,
  // empty conversation after a restart — long before the restore pass runs, and remembering
  // that would replace the very file the restore is meant to put back.
  const bootLastViewed = lastViewedFile()

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
    // A restored draft is something to send, so the send control belongs back on screen.
    updateComposer()
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
      // The conversation on screen goes last: a restore reopens the others quietly and then
      // puts the reader back on this one.
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

  /**
   * Puts a remembered conversation back on the main console.
   *
   * False means the file is gone (deleted while the app was closed, or never written), and the
   * page falls back to the tabs it remembers rather than landing on nothing.
   */
  async function resumeOnMain(main, file) {
    try {
      const res = await fetch(`${API}/sessions/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: file }),
      })
      if (!res.ok) return false
      const data = await res.json().catch(() => ({}))
      rememberSessionFile(main, data.sessionFile || file)
      // What the console already rebuilt was the conversation it was on a moment ago — after a
      // restart that is an empty one — so the file it just attached to has to be read: a
      // rebuild is otherwise skipped as "already loaded".
      main.historyLoaded = false
      await restoreHistory(main)
      return true
    } catch {
      return false
    }
  }

  /** Reopens the conversations the last page had, each rebuilt from its own session file. */
  let restoringTabs = false
  /**
   * The consoles this restore pass reopened. The parallel-console cap recycles an idle console
   * when it is reached, and a tab that is being restored must not be the one it recycles.
   * @type {Set<string>}
   */
  const restoreProtected = new Set()

  async function restoreOpenConversations() {
    // One restore at a time, and one console per file: the same conversation opened twice would
    // put two agents on one session file, and they would interleave writes into its transcript.
    if (restoringTabs) return
    restoringTabs = true
    const started = new Set()
    // Where to land is decided before the tabs are reopened, because the remembered
    // conversation may need the main console itself. `hammer.hx.open` writes the conversation
    // on screen last, so its last entry is the fallback for a page from before LAST_KEY.
    const lastFile = bootLastViewed || [...openFiles.keys()].at(-1) || null
    let focusFile = lastFile
    const main = state.consoles.get('main')
    if (lastFile && main && ![...state.consoles.values()].some((ctx) => ctx.sessionFile === lastFile)) {
      if (!main.sessionFile || (!main.items.length && !main.running)) {
        // A restart starts a fresh agent, so main has nothing of its own to show: resuming the
        // remembered conversation here is what puts the reader back on the one they left. A
        // console mid-turn is not empty, whatever its transcript has rebuilt so far — switching
        // its session under the turn would end the work the reader was watching.
        if (await resumeOnMain(main, lastFile)) focusFile = lastFile
      } else if (!openFiles.has(lastFile)) {
        // Main is on a conversation of its own (a reload with a tab in front), so the
        // remembered one comes back as a tab of its own and is focused below.
        openFiles.set(lastFile, false)
        saveOpenConversations()
      }
    }
    const mainFile = main?.sessionFile
    for (const [file, wasRunning] of [...openFiles]) {
      if (file === mainFile || started.has(file)) continue
      started.add(file)
      if ([...state.consoles.values()].some((ctx) => ctx.sessionFile === file)) continue
      try {
        const ctx = await openInstance(file, { focus: false })
        if (ctx?.id) restoreProtected.add(ctx.id)
        // A tab that was mid-turn still picks its work back up; it just does it off screen.
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
    restoreProtected.clear()
    // Put the reader back where they left off. A conversation that failed to reopen leaves the
    // page on whatever it was already showing rather than jumping to a background one.
    const onScreen = focusFile
      ? [...state.consoles.values()].find((ctx) => ctx.sessionFile === focusFile)
      : null
    if (onScreen) activate(onScreen)
    restoringTabs = false
    usageSettling = false
    saveOpenConversations()
    // The page has settled on its conversation: one read and one repaint, however many tabs
    // came back beside it.
    const settled = active()
    if (settled) void publishSessionUsage(settled)
  }

  /**
   * How long a console that says it is running may produce no record before its transcript is
   * rebuilt from its file anyway.
   *
   * "Running" is the child's flag, not evidence that anything is arriving. After a restart the
   * router adopts an agent mid-turn, and a turn whose model was lost never settles: the flag
   * stays true, no record ever comes, and the transcript stayed on the replay log — which starts
   * empty after a restart — so a long conversation looked gone. A live turn emits records
   * continuously; quiet is a stale flag, and the file is the whole conversation either way.
   */
  const HISTORY_STALL_MS = 2500

  /** Arms the stall check for one console; harmless when it is loaded, idle or already armed. */
  function watchStalledHistory(ctx, delayMs = HISTORY_STALL_MS) {
    if (!ctx || ctx.historyLoaded || !ctx.running || !ctx.sessionFile || ctx.stallTimer) return
    ctx.stallTimer = setTimeout(() => {
      ctx.stallTimer = null
      if (!ctx || ctx.historyLoaded || !ctx.running) return
      // A record arrived: this really is a live turn, so leave its stream alone and look again.
      if (Date.now() - (ctx.lastRecordAt || 0) < HISTORY_STALL_MS) {
        watchStalledHistory(ctx)
        return
      }
      void restoreHistory(ctx, { force: true })
    }, delayMs)
  }

  /**
   * Rebuilds a conversation from its session file, once.
   *
   * The event stream only replays the last few hundred records the router happens to hold, and
   * after a restart that log starts empty — which is why a tab used to come back blank while
   * its JSONL on disk still held the whole conversation. The file is the authoritative
   * transcript, so an idle console is rebuilt from it before the stream is even opened.
   */
  async function restoreHistory(ctx, { force = false } = {}) {
    if (!ctx || !ctx.sessionFile || ctx.historyLoaded || ctx.historyLoading) return
    // A live turn is left to its own stream: a rebuild underneath it would meet the same message
    // twice. `force` is the stall check's answer to a "running" flag with nothing behind it.
    if (ctx.running && !force) return
    ctx.historyLoading = true
    try {
      await loadMessages(ctx)
      ctx.pendingFullRestore = false
      // The transcript that was just rebuilt is the conversation the rail describes, so the
      // plot is published here rather than only when its file is first named — a reopened
      // conversation has a file before it has a turn in this page's life.
      void publishSessionUsage(ctx)
    } catch {
      // The agent may still be starting; the stream will fill the transcript instead.
    } finally {
      ctx.historyLoading = false
      if (ctx.historyLoaded && ctx.stallTimer) {
        clearTimeout(ctx.stallTimer)
        ctx.stallTimer = null
      }
    }
  }

  /** How long a burst of publishes waits so it becomes one read and one repaint. */
  const USAGE_PUBLISH_DELAY_MS = 150
  /** The console the next scheduled read is for, and its pending timer. */
  let pendingUsageConsole = null
  let usagePublishTimer = null
  /** True while the page is still opening the conversations it remembers. */
  let usageSettling = false

  /**
   * Asks for the rail's plot to describe a conversation, once per burst of changes.
   *
   * Only the conversation on screen owns that plot. A tab restored beside this one, or a
   * parallel console landing a turn in the background, describes a history the rail is not
   * showing, so it publishes nothing: opening Hammer used to read and redraw the plot for every
   * conversation the page reopened, one after another, which is the flitting it is meant to
   * avoid.
   *
   * The read is coalesced as well. A page load republishes from several places at once — the
   * activation, the rebuilt transcript, the first status frame — and each read walks its whole
   * session file before a full SVG rebuild, so only the last of a burst is read.
   */
  function publishSessionUsage(ctx) {
    if (!ctx || ctx !== active() || usageSettling) return
    pendingUsageConsole = ctx
    if (usagePublishTimer) clearTimeout(usagePublishTimer)
    usagePublishTimer = setTimeout(() => {
      usagePublishTimer = null
      const target = pendingUsageConsole
      pendingUsageConsole = null
      void readSessionUsage(target)
    }, USAGE_PUBLISH_DELAY_MS)
  }

  /**
   * Points the rail's plot at a conversation's usage history, read from its session file.
   *
   * The plot is drawn by dashboard.js, in another script scope, so this only publishes the
   * points it should describe (window.publishSessionUsage) and asks for the repaint. A
   * conversation with no file yet — one that has never answered — publishes nothing rather
   * than an empty plot, which is read as "this history is gone".
   *
   * Failures are silent: the plot is decoration, and a conversation that opens while the
   * store is unreadable must not also fail its transcript.
   */
  async function readSessionUsage(ctx) {
    const file = ctx?.sessionFile
    if (!file) {
      window.publishSessionUsage?.(null, [])
      return
    }
    try {
      const res = await fetch(`${API}/sessions/usage?session=${encodeURIComponent(file)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `usage ${res.status}`)
      // A console that switched conversations while this read was in flight must not have its
      // plot handed the earlier conversation's history, and one that is no longer the
      // conversation on screen must not take the plot off it.
      if (ctx.sessionFile !== file || ctx !== active()) return
      window.publishSessionUsage?.(file, data.points || [])
    } catch {
      // The router view is the better answer than a plot stuck on the last conversation, and
      // it is what the rail already showed before the agent published anything.
      window.publishSessionUsage?.(null, [])
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

  // ── Syntax highlighting ─────────────────────────────────────────────────────────────
  /*
   * Code the agent shows is meant to be read: a fence that names its language, and the body of
   * a `read` call. Both arrive here as text, already escaped — this pass only wraps spans
   * around the parts that carry meaning (a comment, a string, a keyword, a number, a call), so
   * a file's structure is visible before its words are. It is a tokenizer, not a parser: a
   * handful of families rather than a language list, and anything it does not recognise stays
   * plain, which is the right answer for prose and for a language nobody has taught it.
   */

  /** The family that colours each name a fence's info string or a file extension can carry. */
  const HL_LANGUAGES = {
    js: 'js',
    javascript: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    ts: 'js',
    tsx: 'js',
    typescript: 'js',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'css',
    sass: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    xml: 'html',
    svg: 'html',
    vue: 'html',
    svelte: 'html',
    hbs: 'html',
    py: 'py',
    python: 'py',
    rb: 'py',
    ruby: 'py',
    yml: 'py',
    yaml: 'py',
    toml: 'py',
    ini: 'py',
    sh: 'sh',
    bash: 'sh',
    zsh: 'sh',
    shell: 'sh',
    console: 'sh',
    fish: 'sh',
    sql: 'sql',
    postgres: 'sql',
    postgresql: 'sql',
    mysql: 'sql',
    go: 'c',
    rust: 'c',
    rs: 'c',
    java: 'c',
    kt: 'c',
    kotlin: 'c',
    swift: 'c',
    c: 'c',
    h: 'c',
    cpp: 'c',
    cc: 'c',
    hpp: 'c',
    cs: 'c',
    csharp: 'c',
    php: 'c',
    lua: 'c',
    dart: 'c',
    scala: 'c',
  }

  /** The words that are structure rather than names, per family. */
  const HL_WORDS = {
    js: new Set(
      (
        'as async await break case catch class const continue debugger default delete do else ' +
        'export extends false finally for from function get if import in instanceof let new null ' +
        'of return set static super switch this throw true try typeof undefined var void while ' +
        'with yield interface type enum implements readonly public private protected namespace ' +
        'declare abstract satisfies keyof infer'
      ).split(' '),
    ),
    py: new Set(
      (
        'and as assert async await break class continue def del elif else except False finally ' +
        'for from global if import in is lambda None nonlocal not or pass raise return True try ' +
        'while with yield match case self'
      ).split(' '),
    ),
    sh: new Set(
      (
        'if then elif else fi for in do done while until case esac function return export local ' +
        'readonly unset shift source alias echo cd set trap exit'
      ).split(' '),
    ),
    sql: new Set(
      (
        'select from where insert into values update delete join left right inner outer full on ' +
        'group by order having limit offset create table index alter drop add column primary key ' +
        'foreign references not null and or as distinct union all case when then else end begin ' +
        'commit rollback'
      ).split(' '),
    ),
    c: new Set(
      (
        'auto break case char const continue default do double else enum extern float for goto if ' +
        'inline int long register restrict return short signed sizeof static struct switch typedef ' +
        'union unsigned void volatile while fn let mut pub impl trait use mod match loop where ' +
        'struct enum true false nil func type interface package import go defer chan range select ' +
        'map var class public private protected final new this super extends implements throws ' +
        'try catch finally throw async await'
      ).split(' '),
    ),
  }

  const HL_COMMENTS = {
    js: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    json: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    css: [/\/\*[\s\S]*?\*\//g],
    py: [/#[^\n]*/g],
    sh: [/#[^\n]*/g],
    sql: [/--[^\n]*/g, /\/\*[\s\S]*?\*\//g],
    c: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
  }

  const HL_STRINGS = {
    js: /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g,
    json: /"(?:\\[\s\S]|[^"\\\n])*"/g,
    css: /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/g,
    html: /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/g,
    py: /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/g,
    sh: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    sql: /'(?:''|[^'])*'/g,
    c: /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/g,
  }

  const HL_NUMBER = /(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  const HL_WORD = /[A-Za-z_$][\w$]*/g

  /**
   * The language a fence's info string, or a file path's extension, asks to be coloured as.
   * @param {string} language
   * @returns {string} a family key, or '' when nothing here colours it
   */
  function languageKey(language) {
    const value = String(language || '')
      .trim()
      .toLowerCase()
      .replace(/^language-/, '')
    return HL_LANGUAGES[value] || ''
  }

  /**
   * The language of a file path, so a read's body is coloured by what it read.
   * @param {string} path
   * @returns {string} a family key, or '' for a file this page does not colour
   */
  function languageForPath(path) {
    const name = String(path || '')
      .split(/[?#]/)[0]
      .split(/[\\/]/)
      .pop()
    if (/^(makefile|dockerfile|procfile|bashrc|zshrc|profile)$/i.test(String(name).replace(/^\./, '')))
      return 'sh'
    const extension = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
    return extension ? languageKey(extension[1]) : ''
  }

  /**
   * The language a run block is running, when its command is a program rather than a shell line.
   *
   * A call that runs code through an interpreter is code the reader is meant to follow —
   * `python3 - <<'EOF' … EOF` puts the whole script in the block — so the block takes the
   * interpreter's language. An ordinary shell line (`ls -la`, `grep -n x file`) names no
   * language, and stays plain: guessing from a word that merely appears on the line is how a
   * `grep python` would end up coloured as Python.
   * @param {string} command
   * @returns {string} a family key, or '' when the line runs no language
   */
  function languageForCommand(command) {
    const text = String(command || '').trim()
    if (!text) return ''
    const line = text.split('\n').find((part) => part.trim()) || ''
    // The program is the first word of the last pipeline stage, skipping flags and the
    // wrappers that carry nothing: `cd x && python3 …` and `sudo -E node …` both find it.
    const segment = line.split(/[;&|]+/).filter((part) => part.trim()).pop() || ''
    const program = (segment.match(/\S+/g) || []).find(
      (word) =>
        !word.startsWith('-') &&
        !/^\w+=/.test(word) &&
        !/^(sudo|env|time|nohup|exec|command|nice)$/.test(word),
    )
    const base = String(program || '')
      .replace(/^["']|["']$/g, '')
      .split('/')
      .pop()
      .toLowerCase()
    if (/^python[0-9.]*$/.test(base) || base === 'pypy' || base === 'pypy3') return 'python'
    if (/^(node|nodejs|deno|bun)$/.test(base)) return 'js'
    if (/^(bash|sh|zsh|dash|fish)$/.test(base)) return 'sh'
    if (/^(sqlite3|psql|mysql)$/.test(base)) return 'sql'
    if (/^(ruby|irb)$/.test(base)) return 'ruby'
    // `cat > script.py <<'EOF'` writes code without naming a program for it.
    if (/<<-?\s*['"]?\w+['"]?/.test(text) && /\.py\b/.test(line)) return 'python'
    return ''
  }

  /**
   * Code as escaped HTML with its tokens in spans.
   *
   * Every token is escaped as it is written, exactly once, so a `<script>` in a file is text
   * here just as it is in prose. A language this page does not know is escaped whole and left
   * uncoloured rather than guessed at.
   * @param {string} source raw code
   * @param {string} language a fence's info string, a path, or a family key
   * @returns {string}
   */
  function highlightCode(source, language) {
    const code = String(source == null ? '' : source)
    const family = languageKey(language)
    if (!family) return escapeHtml(code)
    const words = HL_WORDS[family] || HL_WORDS.c
    const comments = HL_COMMENTS[family] || []
    const strings = HL_STRINGS[family] || HL_STRINGS.c
    const foldCase = family === 'sql'
    let html = ''
    let i = 0
    /** The text a rule matches exactly at the cursor, or '' when it does not apply here. */
    const test = (pattern) => {
      pattern.lastIndex = i
      const match = pattern.exec(code)
      return match && match.index === i ? match[0] : ''
    }
    const span = (kind, text) => {
      html += kind ? `<span class="hx-hl-${kind}">${escapeHtml(text)}</span>` : escapeHtml(text)
    }
    while (i < code.length) {
      if (family === 'html') {
        const comment = test(/<!--[\s\S]*?-->/g)
        if (comment) {
          span('com', comment)
          i += comment.length
          continue
        }
        const doctype = test(/<!DOCTYPE[^>]*>/gi)
        if (doctype) {
          span('com', doctype)
          i += doctype.length
          continue
        }
        const tag = test(/<\/?[A-Za-z][\w:.-]*/g)
        if (tag) {
          span('tag', tag)
          i += tag.length
          continue
        }
        const attribute = test(/[A-Za-z_:][\w:.-]*(?=\s*=)/g)
        if (attribute) {
          span('attr', attribute)
          i += attribute.length
          continue
        }
      } else {
        let comment = ''
        for (const rule of comments) {
          comment = test(rule)
          if (comment) break
        }
        if (comment) {
          span('com', comment)
          i += comment.length
          continue
        }
      }
      const string = test(strings)
      if (string) {
        // A JSON key is a string followed by `:`; colouring it as one is what makes a blob of
        // JSON readable at a glance rather than a wall of quoted text.
        let after = i + string.length
        while (after < code.length && /\s/.test(code[after])) after += 1
        const isKey = family === 'json' && code[after] === ':'
        span(isKey ? 'prop' : 'str', string)
        i += string.length
        continue
      }
      const number = test(HL_NUMBER)
      if (number) {
        span('num', number)
        i += number.length
        continue
      }
      const word = test(HL_WORD)
      if (word) {
        const rest = code.slice(i + word.length)
        const before = i > 0 ? code[i - 1] : ''
        const key = foldCase ? word.toLowerCase() : word
        if (family === 'css' && before === '@') span('key', word)
        else if (family === 'css' && /^\s*:/.test(rest)) span('prop', word)
        else if (words.has(key)) span('key', word)
        else if (/^\s*\(/.test(rest)) span('fn', word)
        else span('', word)
        i += word.length
        continue
      }
      // Whitespace in runs, everything else one character at a time: indentation is most of a
      // file, and re-testing every rule for each of its columns is the one cost worth avoiding.
      const space = test(/\s+/g)
      if (space) {
        html += escapeHtml(space)
        i += space.length
        continue
      }
      html += escapeHtml(code[i])
      i += 1
    }
    return html
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
          const info = (nl >= 0 ? chunk.slice(0, nl) : '').trim()
          const body = nl >= 0 ? chunk.slice(nl + 1) : ''
          const lang = languageKey(info)
          return `<pre class="hx-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${highlightCode(body.replace(/\n$/, ''), lang)}</pre>`
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

  // The console is served from this machine, so an outage never stops the page loading: it
  // stops the turn, at the round trip to somebody else's model. Chromium reports the link state,
  // and the composer's hint says which silence this is — the one place a reader is already
  // looking after a send — then clears itself the moment the link returns. It is cleared only
  // when the offline line is still the one showing, so an outage does not wipe a message that
  // arrived after it.
  const OFFLINE_HINT = 'No internet connection — the agent cannot reach a model provider right now.'

  function watchConnectivity() {
    const announce = (offline) => {
      if (offline) {
        setHint(OFFLINE_HINT, 'error')
        return
      }
      const ctx = active()
      if (ctx && ctx.hint === OFFLINE_HINT) setHint('', null, ctx)
    }
    window.addEventListener('offline', () => announce(true))
    window.addEventListener('online', () => announce(false))
    if (typeof navigator !== 'undefined' && navigator.onLine === false) announce(true)
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
      // The republish re-reads the file: a turn that landed in another tab was appended to
      // this conversation's transcript while the rail was not showing it.
      if (typeof window.drawUsagePlots === 'function') {
        requestAnimationFrame(() => window.drawUsagePlots())
      }
      const ctx = active()
      if (ctx?.sessionFile) void publishSessionUsage(ctx)
      // The outline rail was measured at 0px while this view was display:none, so its last
      // paint bailed on an empty track and left it blank: a conversation restored while the
      // app was closed on the router view came back with no notches. Its rows are already
      // mounted, so a repaint is all it needs — and the column has a real width now, so a
      // thought that wraps differently can fold.
      scheduleMinimap()
      scheduleThoughtFolds()
    }
  }

  // ── Rendering the transcript ────────────────────────────────────────────────────────

  const EMPTY_MARKUP = `
    <div class="hx-empty">
      <svg class="hx-empty-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="#7d2231"/>
        <g transform="translate(-2.2 5.18) rotate(32 16 16) translate(16 16) scale(1.1) translate(-16 -16)">
          <path d="M12.55 8.4L14.45 8.4C14.6 9.6 14.72 10.6 14.72 12.2C14.72 14.5 14.5 17.5 14.55 19.4C14.6 21.2 14.85 22.6 14.86 23.4C14.88 24.6 14.4 25.1 13.5 25.1C12.6 25.1 12.12 24.6 12.14 23.4C12.15 22.6 12.4 21.2 12.45 19.4C12.5 17.5 12.28 14.5 12.28 12.2C12.28 10.6 12.4 9.6 12.55 8.4Z" fill="#d9c3bb"/>
          <path d="M21.76 2.91L19.86 2.91C19 2.91 18.49 3.6 17.63 3.6C16.6 3.6 16.08 2.91 15.05 2.91L11.95 2.91C8.17 2.91 5.42 4.63 3.18 8.07C5.93 5.83 8.34 6 11.09 6.69C11.78 6.86 11.95 7.72 12.12 9.1L14.88 9.1C15.05 7.72 15.22 6.86 16.08 6.52C16.77 6.18 17.11 6 17.63 6C18.49 6 19 6.69 19.86 6.69L21.76 6.69L22.27 6.18L22.27 3.42Z" fill="#f6ece5"/>
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
    // A windowed read names the range it read, not just the file: `path:480-639`. The end is
    // the last line the call asked for, offset + limit - 1. A whole-file read has neither
    // number, and a call with only one of them cannot state a range without inventing it.
    if (args.path && /^read(?:_files)?$/i.test(String(item.name || ''))) {
      const offset = Number(args.offset)
      const limit = Number(args.limit)
      if (Number.isFinite(offset) && Number.isFinite(limit) && offset >= 1 && limit >= 1) {
        return `${args.path}:${offset}-${offset + limit - 1}`
      }
    }
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

  /** 1500 -> "1.5k tokens"; 26 -> "26 tokens". */
  function formatThinkingTokens(tokens) {
    const n = Number(tokens)
    if (!Number.isFinite(n) || n <= 0) return ''
    if (n < 1000) return `${Math.round(n)} token${Math.round(n) === 1 ? '' : 's'}`
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`
  }

  /**
   * Spreads one message's reported reasoning tokens over the thought blocks it contains.
   *
   * `usage.reasoning` counts the message, not the block: a turn that thought twice reports one
   * figure, so it is shared out by the length of each thought. Most providers do not report
   * such a figure at all — Pi's usage carries input, output and cache tokens and no reasoning
   * count — so a figure close to the text is used instead and flagged as an estimate. A head
   * that says only "Thought" reads as if the reasoning cost nothing, which is the one thing it
   * must not say.
   */
  function assignThinkingStats(item, reasoningTokens) {
    const blocks = (item.blocks || []).filter(
      (block) => block.kind === 'thinking' && String(block.text || '').trim(),
    )
    if (!blocks.length) return
    const reported = Number(reasoningTokens)
    if (!Number.isFinite(reported) || reported <= 0) {
      for (const block of blocks) {
        // A rememberd figure is better than a new estimate: it may be the provider's own.
        if (block.tokens) continue
        // Four characters per token is what these tokenizers average closely enough for a
        // sentence or a paragraph of reasoning; the `~` on the head keeps it honest.
        block.tokens = Math.max(1, Math.round(block.text.trim().length / 4))
        block.tokensEstimated = true
      }
      return
    }
    if (blocks.length === 1) {
      blocks[0].tokens = Math.round(reported)
      blocks[0].tokensEstimated = false
      return
    }
    const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0)
    let assigned = 0
    blocks.forEach((block, index) => {
      block.tokensEstimated = false
      if (index === blocks.length - 1) {
        block.tokens = Math.max(0, Math.round(reported) - assigned)
        return
      }
      const share = totalChars
        ? Math.max(0, Math.round((reported * block.text.length) / totalChars))
        : 0
      block.tokens = share
      assigned += share
    })
  }

  // ── Thought stats a reload must not forget ─────────────────────────────────────────
  //
  // A thought's duration is measured from its own deltas and its token count arrives on
  // `message_end`, so both live only in the page that watched the turn. A rebuilt transcript —
  // a restart, a reattach, another tab — came from the session file, which records neither, so
  // every head fell back to a bare "Thought." The numbers are remembered here, keyed by the
  // session and the message's own timestamp (which the session file does keep), and put back
  // on the blocks when the row is rebuilt.
  const THOUGHT_STATS_KEY = 'hammer.hx.thoughtStats'
  const THOUGHT_STATS_SESSIONS = 40
  const THOUGHT_STATS_MESSAGES = 400

  /** @returns {Record<string, Record<string, any[]>>} */
  function readThoughtStats() {
    try {
      const parsed = JSON.parse(localStorage.getItem(THOUGHT_STATS_KEY) || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /** The key a conversation's stats live under: the file survives a restart, the id may not. */
  function thoughtStatsKey(ctx) {
    return String(ctx?.sessionFile || ctx?.sessionId || '')
  }

  /**
   * Records what the thoughts of one assistant message cost, so a later rebuild can show it.
   * `message.timestamp` is the message's own stamp in the session file, which is the only
   * handle both this event and a later read of that file agree on.
   */
  function rememberThoughtStats(ctx, message, blocks) {
    const key = thoughtStatsKey(ctx)
    const stamp = typeof message?.timestamp === 'string' ? message.timestamp : ''
    const thoughts = (blocks || []).filter((block) => block.kind === 'thinking')
    if (!key || !stamp || !thoughts.length) return
    const stats = thoughts.map((block) => ({
      ms: Number.isFinite(Number(block.durationMs)) ? Math.round(Number(block.durationMs)) : null,
      tokens: Number.isFinite(Number(block.tokens)) ? Math.round(Number(block.tokens)) : null,
      estimated: block.tokensEstimated === true,
    }))
    const all = readThoughtStats()
    const session = { ...(all[key] || {}), [stamp]: stats }
    const stamps = Object.keys(session).sort()
    for (const stale of stamps.slice(0, Math.max(0, stamps.length - THOUGHT_STATS_MESSAGES))) {
      delete session[stale]
    }
    const next = { ...all, [key]: session }
    const keys = Object.keys(next)
    for (const stale of keys.slice(0, Math.max(0, keys.length - THOUGHT_STATS_SESSIONS))) {
      delete next[stale]
    }
    try {
      localStorage.setItem(THOUGHT_STATS_KEY, JSON.stringify(next))
    } catch {
      // Storage full or disabled: the live numbers still render, and a rebuild falls back to
      // whatever the provider itself reports.
    }
  }

  /** Puts a message's remembered figures back on the blocks rebuilt from the session file. */
  function applyRememberedThoughtStats(ctx, message, blocks) {
    const key = thoughtStatsKey(ctx)
    const stamp = typeof message?.timestamp === 'string' ? message.timestamp : ''
    if (!key || !stamp) return
    const stats = readThoughtStats()[key]?.[stamp]
    if (!Array.isArray(stats)) return
    const thoughts = (blocks || []).filter((block) => block.kind === 'thinking')
    thoughts.forEach((block, index) => {
      const stat = stats[index]
      if (!stat) return
      const ms = Number(stat.ms)
      if (block.durationMs == null && Number.isFinite(ms) && ms > 0) block.durationMs = ms
      const tokens = Number(stat.tokens)
      if (!Number.isFinite(Number(block.tokens)) || Number(block.tokens) <= 0) {
        if (Number.isFinite(tokens) && tokens > 0) {
          block.tokens = tokens
          block.tokensEstimated = stat.estimated === true
        }
      }
    })
  }

  /**
   * The sentence on a thinking head, e.g. "Thought for 10s · 1.5k tokens."
   *
   * The duration is the span its deltas streamed for; a rebuilt row gets it back from the
   * remembered stats, and only a message this install never watched falls back to a bare
   * "Thought". The token figure is the provider's own when it reports one, and an estimate —
   * marked with `~` — when it does not.
   */
  function thinkingLabel(block, settled) {
    if (!settled) return 'Thinking…'
    const ms = Number(block.durationMs)
    const parts = []
    if (Number.isFinite(ms) && ms > 0) {
      parts.push(`Thought for ${Math.max(1, Math.round(ms / 1000))}s`)
    } else {
      parts.push('Thought')
    }
    const tokens = formatThinkingTokens(block.tokens)
    // An estimate is marked as one: the head states what the thought cost, and a figure this
    // page derived from the text must not look like a number the provider billed.
    if (tokens) parts.push(block.tokensEstimated ? `~${tokens}` : tokens)
    return `${parts.join(' · ')}.`
  }

  /**
   * The thinking station's mark: Gemini's "AI" sparkle — the void between four circles — drawn
   * as one outlined path, so it reads as line art on the spine rather than a filled glyph. A
   * stub enters at (12,0) and leaves at (12,24) to meet the star's top and bottom points, so the
   * maroon line runs through the mark the way it runs through a tool's drawing.
   */
  function thinkingIcon() {
    return `<span class="hx-thinking-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0v3.2M12 20.8V24"/><path d="M12 3.2C12.7 8 16 11.3 20.8 12C16 12.7 12.7 16 12 20.8C11.3 16 8 12.7 3.2 12C8 11.3 11.3 8 12 3.2Z"/></svg></span>`
  }

  /**
   * The thinking blocks of an assistant item, in the order the row renders them.
   *
   * `item.blocks` interleaves reasoning with prose, so a DOM node index is not a block index:
   * everything that walks the rendered thoughts (the toggle handler, the fold pass) needs this
   * one filtered list to map a `.hx-thinking` node back to the block it was drawn from.
   */
  function thinkingBlocks(item) {
    return (item.blocks || []).filter((block) => block.kind === 'thinking')
  }

  /**
   * Ends every block of a message that is still being written.
   *
   * A thought is finished as soon as the model moves on — to prose, to a tool call, or to the
   * end of the message — not when the whole turn settles. `message_end` is the only place that
   * used to fold them, so a turn that thought, called three tools and then answered left every
   * finished thought open above the answer it produced.
   *
   * @param {any} item an assistant item
   */
  function finishBlocks(item) {
    if (!item || !Array.isArray(item.blocks)) return
    const now = Date.now()
    for (const block of item.blocks) {
      if (block.finished) continue
      block.finished = true
      // The head reports how long the thought ran; a thought that ended mid-turn gets the same
      // figure a settled one does, stopped at its last delta rather than at the message's end.
      if (block.kind === 'thinking' && block.startedAt && block.durationMs == null) {
        block.durationMs = Math.max(0, (block.lastDeltaAt || now) - block.startedAt)
      }
    }
  }
  /**
   * A thought is a station on the spine, so it behaves like a tool call: while the model is
   * still writing it the row is open, and once its message settles it folds away. The answer
   * stays in the log; the reasoning that produced it stays one click behind it.
   *
   * The open state lives on the block, not on the <details>: a streaming repaint replaces the
   * element, and without it every delta would slam an opened thought shut again.
   *
   * One line of reasoning is the exception, and it takes the other branch below: a head reading
   * "Thought for 2s · 40 tokens" is longer than the thought it hides, so the line is shown in
   * place and the head is dropped. Whether a thought is one line is a question about the pane —
   * the same sentence wraps at a narrow width — so the answer is measured after the row mounts
   * and cached on the block (see applyThoughtFolds), never guessed from the string here.
   */
  function thinkingMarkup(block, item) {
    const settled = item.settled === true
    // A thought is complete when the model stops writing it — it moved on to prose, a tool
    // call, or the end of the message — not only when the whole turn settles. Folding at
    // message_end is what kept every finished thought open for the rest of the turn.
    const complete = settled || block.finished === true
    // Only a settled thought is ever inline: while the model is still writing, the row grows
    // with every delta and a measurement taken mid-stream would be stale before it was used.
    if (settled && block.inline) {
      // The same station, without the disclosure: the mark still names it as the model's work
      // and the spine still runs through it, but the prose sits where the head's label would
      // have been, so there is nothing to open and nothing to click.
      return `<div class="hx-thinking inline">${thinkingIcon()}<div class="hx-thinking-text">${renderText(block.text || '')}</div></div>`
    }
    const open = block.open ?? !complete
    return `<details class="hx-thinking ${complete ? 'settled' : 'running'}"${open ? ' open' : ''}>
          <summary class="hx-thinking-head">
            ${thinkingIcon()}
            <span class="hx-thinking-label">${thinkingLabel(block, complete)}</span>
          </summary>
          <div class="hx-thinking-text">${renderText(block.text || '')}</div>
        </details>`
  }

  function assistantMarkup(item) {
    const blocks = item.blocks || []
    if (!blocks.length) {
      return `<div class="hx-assistant hx-pending">…</div>`
    }
    const body = blocks
      .map((block) => {
        if (block.kind === 'thinking') return thinkingMarkup(block, item)
        return `<div>${renderText(block.text || '')}</div>`
      })
      .join('')
    return `<div class="hx-assistant">${body}</div>`
  }

  // ── Folding the short thoughts ─────────────────────────────────────────────────────
  //
  // A thought that fits on one line should not cost a head and a click to read: the line is
  // the whole of it, and hiding it behind "Thought for 2s" makes the folded row longer than
  // the reasoning inside it. The catch is that "one line" is a claim about rendered layout —
  // the same sentence is one line on a wide pane and three on a narrow one — so it cannot be
  // decided from the text alone. It is decided here instead, once per row per width, after the
  // row has mounted: measure, record the answer on the block, repaint the row once if it
  // changed. Every later sync reads the recorded answer for free.

  /** One fold pass queued for the next frame; a drag-resize fires `resize` on every tick. */
  let thoughtFoldFrame = 0

  /** True for a text node that occupies a single line box at the width it is rendered at. */
  function thoughtIsOneLine(node) {
    const text = node.querySelector('.hx-thinking-text')
    const parent = node.parentNode
    if (!text || !parent) return false
    // `clientWidth` is the row's content width, which is what the text is laid out in. A row
    // that is not mounted (or is hidden behind an inactive conversation) has none, and a
    // measurement taken at width 0 would call every thought multi-line.
    const width = node.clientWidth
    if (!width) return false
    // A closed <details> does not render its contents at all, so the thought cannot be measured
    // where it stands — it is copied into a hidden probe of exactly the row's width instead.
    // `box-sizing: border-box` makes the probe's content box the same 20px-narrower box the
    // real text sits in (it inherits .hx-thinking-text's spine indent), so the copy wraps at
    // exactly the column the reader would see.
    const probe = document.createElement('div')
    probe.className = 'hx-thinking-text'
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = `position: absolute; left: 0; top: 0; visibility: hidden; pointer-events: none; box-sizing: border-box; width: ${width}px`
    probe.innerHTML = text.innerHTML
    parent.insertBefore(probe, node.nextSibling)
    const styles = getComputedStyle(probe)
    const fontSize = Number.parseFloat(styles.fontSize) || 0
    // `line-height: 1.55` is what the stylesheet asks for; the fallback only exists for a page
    // whose stylesheet has not applied yet, where the measurement is meaningless anyway.
    const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.55
    const height = probe.getBoundingClientRect().height
    probe.remove()
    if (!lineHeight) return false
    // A paragraph's own 6px margins are zeroed at first/last child by the stylesheet, so one
    // line is one line box, two lines are two. The half-line of slack is for the fractional
    // heights a browser reports once a font's ascent is rounded to whole pixels.
    return height <= lineHeight * 1.5
  }

  /**
   * Decides, per settled thought, whether it is short enough to stand in its own place.
   *
   * Runs after a transcript sync and after a resize — the two moments the width a thought wraps
   * at can change. It is deliberately skipped for a row that is still streaming: its text is
   * not final, and the row is patched on every delta, so the answer would be re-decided dozens
   * of times per second to say nothing. The width is cached on the block so a conversation that
   * did not change shape costs one `clientWidth` read per thought and nothing else.
   */
  function applyThoughtFolds(ctx = active()) {
    if (ctx !== active()) return
    let repainted = false
    for (const item of state.items) {
      if (item.kind !== 'assistant' || item.settled !== true) continue
      if (!item.node || !item.node.isConnected) continue
      const blocks = thinkingBlocks(item)
      // Empty reasoning is left folded: a blank line is not worth showing in place, and its
      // head ("Thought for 2s") is the only thing that would say the turn thought at all.
      const nodes = [...item.node.querySelectorAll('.hx-thinking')]
      if (!nodes.length || nodes.length !== blocks.length) continue
      let changed = false
      nodes.forEach((node, index) => {
        const block = blocks[index]
        // A reader who opened or closed this thought has stated what they want to see, and a
        // repaint that silently re-folded it would be the same bug the toggle handler prevents.
        if (block.open !== undefined) return
        if (!String(block.text || '').trim()) return
        const width = node.clientWidth
        if (!width || block.foldWidth === width) return
        block.foldWidth = width
        const inline = thoughtIsOneLine(node)
        if (block.inline === inline) return
        block.inline = inline
        changed = true
      })
      if (changed) {
        // One repaint per row, not per thought: the row is the unit the transcript mounts.
        item.node.innerHTML = itemMarkup(item)
        repainted = true
      }
    }
    // The row heights just changed, so the rail's marks are stale; it repaints next frame.
    if (repainted) scheduleMinimap()
  }

  /** One fold pass per frame, for the resize path where `resize` fires on every mouse tick. */
  function scheduleThoughtFolds() {
    if (thoughtFoldFrame) return
    thoughtFoldFrame = requestAnimationFrame(() => {
      thoughtFoldFrame = 0
      applyThoughtFolds()
    })
  }

  // ── Waiting for the first token ────────────────────────────────────────────────
  //
  // A tool row whose head shows only a timing is not the agent still working: what the reader is
  // watching at the bottom of the log is the model, which has been handed the tool's result
  // and has not written anything yet. There is no row to stream into during that gap, so the
  // log simply stopped — and a stop is indistinguishable from a hang. The router measures
  // every model's time to first token, so the gap gets a mark of its own: a ring under the
  // spine that fills from 0 to 100% over that model's known TTFT. A full ring is the wait this
  // model usually needs; a wait that outlasts it leaves the ring full.
  const DEFAULT_TTFT_MS = 2000

  /** modelId -> the router's measured time to first token, in ms. */
  const ttftByModel = new Map()
  /** providerKey -> the name the router's own table gives it ("puter" -> "Puter"). */
  const providerNameByKey = new Map()
  /** modelId -> the provider that offers it, so an old message can still name who served it. */
  const providerKeyByModel = new Map()
  /** providerKey::modelId -> that row's quota fields, from the same table read. */
  const quotaRowByModel = new Map()
  /** When the table must be read again; a failed read ages out like a successful one. */
  let ttftFreshUntil = 0
  let ttftLoad = null
  // The row a missing-table read was already made for, and when. A routed model the table does
  // not mention must not become one fetch per status frame; after one look the answer stands
  // for a while (see renderQuota).
  let quotaMissLookup = { key: null, at: 0 }
  // When the table was last re-read for a route change. The table is megabytes, so a drag that
  // crosses several models must not ask for a fresh copy at every step.
  let ttftForcedAt = 0
  /** The composer slope slider's notches, as percentages of the data's slope ceiling. */
  let slopeNotches = []
  /** The field the popup draws: one {intelligence, speed} per routable row of /api/models. */
  let slopePlotPoints = []
  /**
   * The slope at 100%, as the router measures it over the rows its minimums leave. The popup used
   * to compute its own copy from the plotted dots, which are measured differently, so the line it
   * drew for a percentage was not the line the router followed at that percentage.
   */
  let slopePlotCeilingSlope = null

  /**
   * Reads the router's per-model TTFT table.
   *
   * The harness is a second client of the same router, so it asks the route the dashboard
   * asks rather than inventing a number: a ring running on a guessed period would call a
   * model nobody has measured as normal.
   */
  async function loadKnownTtfts({ force = false } = {}) {
    if (ttftLoad) return ttftLoad
    // `force` is for a route change: the rail's bars belong to the model that is routed now,
    // and the table it is drawing from may predate that model entirely.
    if (!force && Date.now() < ttftFreshUntil) return
    ttftLoad = (async () => {
      try {
        const res = await fetch('/api/models', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          ttftByModel.clear()
          quotaRowByModel.clear()
          for (const row of Array.isArray(data.models) ? data.models : []) {
            const id = row && (row.modelId || row.id)
            const ms = row && row.ttft != null ? Number(row.ttft) : NaN
            if (id && Number.isFinite(ms) && ms > 0) ttftByModel.set(String(id), ms)
            const providerKey = String(row?.providerKey || '')
            const providerName = String(row?.providerName || row?.brand || '')
            if (providerKey && providerName) providerNameByKey.set(providerKey, providerName)
            if (providerKey && id) providerKeyByModel.set(String(id), providerKey)
            if (providerKey && id) {
              // Keep only what the rail's quota meter reads. The full table is thousands of
              // rows; holding every row in the page would be a second copy of the router.
              quotaRowByModel.set(`${providerKey}::${id}`, {
                // The row's own name, so a bar drawn for this model can say which model it is
                // without the caller re-deriving a label from the id (see quotaSubject).
                label: row.label || null,
                providerName: providerName || null,
                context: row.context || null,
                // The table's own resolved figure. It is the number the column is sorted
                // and compared on, and it survives a display such as ">238k" that cannot be
                // read back as a denominator by parsing.
                contextTokens: Number.isFinite(Number(row.contextTokens))
                  ? Number(row.contextTokens)
                  : null,
                contextBound: row.contextBound || null,
                knownQuota: row.knownQuota || null,
                quotaWindows: Array.isArray(row.quotaWindows) ? row.quotaWindows : [],
                providerUsage: row.providerUsage || null,
                rateLimit: row.rateLimit || null,
                quota: row.quota || null,
                recordedUsage: row.recordedUsage || null,
                providerRecordedUsage: row.providerRecordedUsage || null,
                // The pool, when there is one. Without it the rail had no accounts to fan out,
                // so a provider the table drew as two columns read in the sidebar as one bar —
                // or as ∞, because the row's own windows are endpoint-scoped and the pool's
                // traffic had nothing to be measured against. It is the same payload the
                // table's account columns read; the rail just has to keep it.
                credentials: Array.isArray(row.credentials) ? row.credentials : null,
              })
            }
          }
          slopeNotches = (Array.isArray(data.selector?.notchesPercent)
            ? data.selector.notchesPercent
            : []
          )
            .map(Number)
            .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
          paintSlopeNotches()
          const ceilingSlope = Number(data.selector?.ceilingSlope)
          slopePlotCeilingSlope =
            Number.isFinite(ceilingSlope) && ceilingSlope > 0 ? ceilingSlope : null
          slopePlotPoints = collectSlopePlotPoints(
            Array.isArray(data.models) ? data.models : [],
          )
          if (!$('hx-slope-pop')?.hidden) renderSlopePlot(Number($('hx-slope-slider')?.value))
        }
      } catch {
        // No measurement, no table: the ring keeps its default period rather than vanishing.
      } finally {
        ttftFreshUntil = Date.now() + 60_000
        ttftLoad = null
      }
    })()
    return ttftLoad
  }

  /** The current model's own time to first token: what the router measured, or a plain period. */
  function knownTtftMs(ctx) {
    const routed = ctx && ctx.routedModel
    const id = routed && (routed.modelId || routed.id)
    const measured = id ? ttftByModel.get(String(id)) : null
    return measured && measured > 0 ? measured : DEFAULT_TTFT_MS
  }

  /**
   * Whether the run is live but nothing has been written yet — the model composing, or a turn
   * just handed the result of a tool. A tool that is actually executing is work, not a wait.
   */
  function awaitingFirstToken(ctx) {
    if (!ctx || !ctx.running) return false
    const last = ctx.items[ctx.items.length - 1]
    if (!last) return false
    if (last.kind === 'tool') return last.status !== 'running'
    if (last.kind === 'assistant')
      return !(last.blocks || []).some((block) => String(block.text || '').trim())
    return true
  }

  /** The wait's identity: a new last row, or a new state on it, starts the ring over. */
  function waitKeyFor(ctx) {
    const last = ctx.items[ctx.items.length - 1]
    return last ? `${ctx.items.length}:${last.kind}:${last.status || ''}` : ''
  }

  /**
   * Draws, moves or removes the wait badge.
   *
   * It lives in the transcript rather than in a row because it belongs to no item — it marks
   * the space after the last one — and it is re-appended on every sync so rows arriving above
   * it cannot leave it stranded mid-log.
   */
  function syncWaitBadge(ctx = active()) {
    const transcript = $('hx-transcript')
    if (!transcript || !ctx || ctx !== active()) return
    let badge = transcript.querySelector('.hx-ttft')
    if (!awaitingFirstToken(ctx)) {
      if (badge) badge.remove()
      return
    }
    if (!badge) {
      badge = document.createElement('div')
      badge.className = 'hx-ttft'
      badge.setAttribute('role', 'status')
      badge.setAttribute('aria-live', 'polite')
      badge.setAttribute('aria-label', 'Waiting for the model’s first token')
      badge.innerHTML =
        '<span class="hx-ttft-ring" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><circle class="hx-ttft-track" cx="12" cy="12" r="9"/>' +
        '<circle class="hx-ttft-arc" cx="12" cy="12" r="9"/></svg></span>'
    }
    const ms = knownTtftMs(ctx)
    badge.style.setProperty('--hx-ttft-ms', `${ms}ms`)
    badge.title = `Waiting for the first token — this model usually takes ${(ms / 1000).toFixed(1)}s`
    const waitKey = waitKeyFor(ctx)
    if (badge.dataset.waitKey !== waitKey) {
      badge.dataset.waitKey = waitKey
      // Restart the turn: the ring must report this wait, not carry on from the last one.
      badge.classList.remove('hx-ttft-running')
      void badge.offsetWidth
      badge.classList.add('hx-ttft-running')
    }
    transcript.appendChild(badge)
    if (Date.now() > ttftFreshUntil) void loadKnownTtfts().then(() => syncWaitBadge(ctx))
  }

  /**
   * The state a tool row's head shows while it is live. A finished call says nothing here — the
   * row's fold, its maroon spine colour, and the duration beside this label already say it ended,
   * and the row is not the place for a verdict.
   */
  function toolStateLabel(item) {
    if (item.status === 'preparing') return 'preparing'
    if (item.status === 'running') return 'running'
    if (item.status === 'interrupted') return 'interrupted'
    if (item.status === 'error') return 'failed'
    return ''
  }

  /**
   * A tool call is one line of the log; its output is what you open when you need it. The whole
  /**
   * Line art for each tool that links directly into the maroon spine line at top (12,0) and
   * bottom (12,24). The spine line itself branches into the tool glyph and reconnects, making
   * the tool icon an organic part of the spine stream rather than a separate badge.
   */
  function toolIcon(name) {
    const key = String(name || '').toLowerCase()
    const icons = {
      // Terminal prompt chevron branching out of and back into the spine at 45 degree angles.
      bash: '<path d="M12 0v4l8 8-8 8v4"/>',
      // Curly book pages fanned off the spine, which runs straight down the middle.
      read: '<path d="M12 0v24"/><path d="M12 5c-3-1.5-6.5-1.5-9 0v11c2.5-1.5 6-1.5 9 0M12 5c3-1.5 6.5-1.5 9 0v11c-2.5-1.5-6-1.5-9 0"/>',
      // Stylized drafting nib angled across a spine capsule.
      edit: '<path d="M12 0v3C6 3 4 7 4 12c0 5 2 9 6.5 9.5l1.5 2.5M12 3c6 0 8 4 8 9s-2 9-7 9"/><path d="M14 7.5l2 2-6.5 6.5H7.5v-2.5z"/>',
      // Plus node inside the same capsule frame the drafting nib sits in.
      write: '<path d="M12 0v3C6 3 4 7 4 12c0 5 2 9 6.5 9.5l1.5 2.5M12 3c6 0 8 4 8 9s-2 9-7 9"/><path d="M12 8v8M8 12h8"/>',
      // Magnifying lens built into the spine stream with handle angling off it.
      grep: '<path d="M12 0v3C8 3 5.5 5.5 5.5 9.5C5.5 13.5 8 16 12 16v8M12 3C16 3 18.5 5.5 18.5 9.5C18.5 13.5 16 16 12 16"/><path d="M12 16l4.5 4.5M9 8.5h6M10 11h4"/>',
      // Target reticle locator node woven into the spine.
      find: '<path d="M12 0v3C7 3 4.5 5.5 4.5 10.5C4.5 15.5 7 18 12 18v6M12 3c5 0 7.5 2.5 7.5 7.5s-2.5 7.5-7.5 7.5"/><path d="M8 10.5h2.5M13.5 10.5h2.5M12 6.5v2M12 12.5v2"/><circle cx="12" cy="10.5" r="1"/>',
      // 3-way branching tree node returning to the spine.
      glob: '<path d="M12 0v4C8 4 6 7 6 12c0 5 2 8 6 8v4M12 4c4 0 6 3 6 8s-2 8-6 8M12 4v16"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>',
      // Directory tree listing branching from the spine trunk.
      ls: '<path d="M12 0v24M12 6h7M12 12h7M12 18h7M7.5 6h2M7.5 12h2M7.5 18h2"/>',
      // Checklist badge node with checkmark woven into the spine.
      task: '<path d="M12 0v3C7 3 5 5.5 5 10.5C5 15.5 7 18 12 18v6M12 3c5 0 7 2.5 7 7.5s-2 7.5-7 7.5"/><path d="M8.5 10.5l2.5 2.5 4.5-4.5"/>',
      // Diamond checkbox node woven into the spine stream.
      todo: '<path d="M12 0v3L5 10.5L12 18v6M12 3l7 7.5L12 18"/><path d="M9 10.5l2 2 4-4"/>',
      // Globe node with equator and meridians linking top and bottom to spine.
      webfetch: '<path d="M12 0v2.5C6.5 2.5 4 6.5 4 12c0 5.5 2.5 9.5 8 9.5v2.5M12 2.5c5.5 0 8 4 8 9.5s-2.5 9.5-8 9.5"/><path d="M4 12h16M12 2.5C8.5 6 8.5 18 12 21.5M12 2.5C15.5 6 15.5 18 12 21.5"/>',
      // Question mark node branching out of the spine stream.
      question: '<path d="M12 0v3C7 3 5 5.5 5 10.5C5 15.5 7 18 12 18v6M12 3c5 0 7 2.5 7 7.5s-2 7.5-7 7.5"/><path d="M10 8c0-1.2 1-2 2-2s2 .8 2 2c0 1.5-2 1.8-2 3.5M12 14v.5"/>',
      // Gear node woven into the spine stream.
      other: '<path d="M12 0v3C7 3 5 5.5 5 10.5C5 15.5 7 18 12 18v6M12 3c5 0 7 2.5 7 7.5s-2 7.5-7 7.5"/><circle cx="12" cy="10.5" r="2.5"/><path d="M12 6.5v1.5M12 13v1.5M8 10.5h1.5M14.5 10.5h1.5"/>',
    }
    const body = icons[key] || icons.other
    return `<span class="hx-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${body}</svg></span>`
  }

  /**
   * The transcript's name for a tool. A `bash` call is the shell running a command, so its row
   * reads RUN; the icon table still keys on `bash`, which is the tool's own name.
   */
  function toolLabel(name) {
    const raw = String(name || 'tool')
    return raw.toLowerCase() === 'bash' ? 'run' : raw
  }

  /** The before/after pairs an edit call asked for, one per replacement. */
  function editPairs(item) {
    const edits = item.args && Array.isArray(item.args.edits) ? item.args.edits : []
    return edits
      .map((edit) => ({
        before: typeof edit?.oldText === 'string' ? edit.oldText : '',
        after: typeof edit?.newText === 'string' ? edit.newText : '',
      }))
      .filter((pair) => pair.before || pair.after)
  }

  /**
   * Line rows for one replacement: `context` lines are unchanged, `del` lines only existed
   * before and `add` lines only exist after. Common head and tail lines are not drawn — the
   * edit's own oldText/newText are the region that changed — but they are trimmed before the
   * table so a one-word change in a long block stays cheap.
   */
  function diffRows(before, after) {
    const a = before.split('\n')
    const b = after.split('\n')
    let head = 0
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1
    let tailA = a.length
    let tailB = b.length
    while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
      tailA -= 1
      tailB -= 1
    }
    const midA = a.slice(head, tailA)
    const midB = b.slice(head, tailB)
    const rows = []
    if (midA.length * midB.length > 250000) {
      // A wall of changed lines is not worth a quadratic table: the old block, then the new.
      for (const text of midA) rows.push({ op: 'del', text })
      for (const text of midB) rows.push({ op: 'add', text })
      return rows
    }
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1))
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i][j] =
          midA[i] === midB[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        rows.push({ op: 'context', text: midA[i] })
        i += 1
        j += 1
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        rows.push({ op: 'del', text: midA[i] })
        i += 1
      } else {
        rows.push({ op: 'add', text: midB[j] })
        j += 1
      }
    }
    while (i < midA.length) rows.push({ op: 'del', text: midA[i++] })
    while (j < midB.length) rows.push({ op: 'add', text: midB[j++] })
    return rows
  }

  /** How many diff rows an opened edit draws before it summarises the rest. */
  const DIFF_MAX_ROWS = 400

  /**
   * An edit's body is the change itself: removed lines on the error tint, added lines on the
   * success tint, unchanged lines quiet between them, each with its own mark. The tool's
   * result sentence ("Edited …") says less than the diff and is not shown in its place.
   */
  function diffMarkup(item) {
    const pairs = editPairs(item)
    if (!pairs.length) return ''
    return pairs
      .map((pair) => {
        const rows = diffRows(pair.before, pair.after)
        const shown = rows.slice(0, DIFF_MAX_ROWS)
        // The change is code from a named file, so it is coloured by that file. Each row is
        // highlighted on its own: a diff is read line by line, and a construct that spans rows
        // simply stays plain on the rows that do not hold both its ends.
        const diffLang = languageForPath(item.args?.path || item.args?.file_path || '')
        const body = shown
          .map((row) => {
            const mark = row.op === 'add' ? '+' : row.op === 'del' ? '−' : ' '
            const text = diffLang ? highlightCode(row.text, diffLang) : escapeHtml(row.text)
            return `<div class="hx-diff-row ${row.op}"><span class="hx-diff-mark">${mark}</span><span class="hx-diff-text">${text}</span></div>`
          })
          .join('')
        const more =
          rows.length > shown.length
            ? `<div class="hx-diff-more">… ${rows.length - shown.length} more lines</div>`
            : ''
        return `<div class="hx-diff">${body}${more}</div>`
      })
      .join('')
  }

  function toolMarkup(item) {
    const output = item.result || item.partial || ''
    const took = item.durationMs != null ? `${(item.durationMs / 1000).toFixed(2)}s` : ''
    // A finished call's meta is its timing alone: the state label says nothing for it, so the
    // separator only belongs between two live fragments.
    const meta = [toolStateLabel(item), took].filter(Boolean).join(' · ')
    // An edit whose call finished shows its diff instead of its result sentence — the change is
    // the output. A failed edit keeps the error text, which is the thing worth reading.
    const isEdit = /^edit$/i.test(String(item.name || ''))
    const diff =
      isEdit && item.status !== 'error' && item.status !== 'interrupted' ? diffMarkup(item) : ''
    // A read's body is code from a named file, so its language is the file's; any other tool's
    // output is text and is escaped uncoloured, which is what it is.
    const readPath = /^read(?:_files)?$/i.test(String(item.name || '')) ? item.args?.path : ''
    const readLang = readPath ? languageForPath(readPath) : ''
    const readBody = output
      ? `<pre class="hx-tool-out"${readLang ? ` data-lang="${escapeHtml(readLang)}"` : ''}>${highlightCode(output, readLang)}</pre>`
      : ''
    const body = diff || readBody
    // A run block's head is the program it ran, which for an interpreter is the code itself.
    const runCommand = /^(run|bash|shell|exec|command|terminal)$/i.test(String(item.name || ''))
      ? toolSummary(item)
      : ''
    const runLang = runCommand ? languageForCommand(runCommand) : ''
    // A finished call folds away, whatever its verdict: failure is a word in the summary ("failed",
    // in the error colour) and its output is one click away, exactly like a call that succeeded.
    // Keeping every failure open meant one broken command pushed the rest of the turn off screen,
    // which is the opposite of what a reader scanning a log needs. Only a call still in flight
    // stays open, because that output is arriving as you watch; a row the reader opened by hand
    // (item.open) is theirs and stays as they left it.
    const open =
      body && (item.open || item.status === 'running' || item.status === 'preparing') ? ' open' : ''
    return `<details class="hx-tool ${item.status}${body ? '' : ' hx-tool-empty'}"${open}>
          <summary class="hx-tool-head">
            ${toolIcon(item.name || 'tool')}
            <span class="hx-tool-name">${escapeHtml(toolLabel(item.name))}</span>
            <span class="hx-tool-cmd"${runLang ? ` data-lang="${escapeHtml(runLang)}"` : ''}>${runLang ? highlightCode(runCommand, runLang) : escapeHtml(toolSummary(item))}</span>
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
    if (item.kind === 'compaction') return compactionMarkup(item)
    if (item.kind === 'model') return modelMarkup(item)
    const tone = item.tone === 'error' ? ' error' : item.tone === 'success' ? ' success' : ''
    return `<div class="hx-notice${tone}"><span class="hx-notice-text">${escapeHtml(item.text)}</span></div>`
  }

  /**
   * A compaction row: the boundary in the conversation, and what it cost.
   *
   * The summary is behind a disclosure because it is past context — it stays available (a
   * reader who wants to know what survived can look) without being re-read as the current
   * instruction.
   */

  /** How much of a still-arriving summary the row keeps on screen. */
  const COMPACTION_PREVIEW = 8000

  /**
   * The compaction mark: a capacitor on the spine.
   *
   * A compaction banks the conversation and hands back a smaller one — a store and a release,
   * which is exactly what the symbol means. Two plates across the spine, each joined to the
   * row's edge above and below, so the mark is a station on the same line the tool calls sit
   * on rather than a badge beside it.
   */
  function compactionIcon() {
    return `<span class="hx-compaction-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0v9M4 9h16M4 15h16M12 15v9"/></svg></span>`
  }

  /**
   * Two lines diverging: one leaving the spine to the right, one arriving from the left.
   *
   * It enters at the row's top edge (12,0) and leaves at its bottom edge (12,24), so the
   * spine appears to pass through the station and split rather than stop at a badge beside
   * it. The top stroke is the outgoing model, the bottom stroke the incoming one.
   */
  function modelIcon() {
    return `<span class="hx-model-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0v4c0 3 3 4 8 4M4 16c5 0 8 1 8 4v4"/></svg></span>`
  }

  /** A model as a string: Pi sends ids, but a message can carry a model object. */
  function modelName(model) {
    if (typeof model === 'string') return model
    return (model && (model.name || model.id)) || 'unknown model'
  }

  /** Hammer's alias for the router's live pick. It is not a model and must not be shown as one. */
  function isRouterAlias(model) {
    const names = [modelName(model)]
    if (model && typeof model === 'object') names.push(modelName(model.id))
    return names.some(
      (name) => name === 'best' || name === 'hammer::best' || name === 'hammer/best',
    )
  }

  /**
   * The model a message names.
   *
   * Pi records `best` as the request's model; the provider's `responseModel` is the one that
   * actually answered. Live, an alias can be resolved through the router's current pick so the
   * transcript and composer never claim a model called `best`. History passes
   * `resolveAlias: false`: an old alias cannot be resolved after the fact, and painting today's
   * route over it would invent an answer.
   */
  function messageModelName(message, ctx, { resolveAlias = true } = {}) {
    const candidates = [message?.responseModel, message?.model].filter(Boolean)
    const concrete = candidates.find((value) => {
      const name = modelName(value)
      return name && name !== 'unknown model' && !isRouterAlias(value)
    })
    if (concrete) return modelName(concrete)
    if (!resolveAlias) return null
    const routed = ctx && ctx.routedModel
    if (!routed) return null
    // The id, not the label. A message that named a model records the provider's id, so resolving
    // an alias-only message to the row's display label made the next answer from the same model
    // read as a change ("swe-2-flash-medium" -> "Devin SWE-2 Flash Medium").
    const name = modelName(routed.modelId || routed.realModelId || routed.label)
    return name && name !== 'unknown model' ? name : null
  }

  /**
   * Whether two recorded model names are the same answer's model.
   *
   * A message names what the provider reported — an id such as `swe-2-flash-medium`. An older
   * message, or one whose answer was resolved through Hammer's alias, can name the same row by
   * its display label ("Devin SWE-2 Flash Medium"). Comparing those as strings puts a model-change
   * station between two answers from the same model, which is worse than saying nothing: the
   * reader is told the route moved when it did not. Both sides are folded, and either side may be
   * any of the route's own names.
   */
  function sameAnswerIdentity(ctx, left, right) {
    const fold = (value) =>
      printableModelName(value).toLowerCase().replace(/\s+/g, ' ').trim()
    if (!left || !right) return false
    if (fold(left) === fold(right)) return true
    const routed = ctx && ctx.routedModel
    if (!routed) return false
    const names = [routed.modelId, routed.realModelId, routed.label, routed.realModelLabel]
      .filter(Boolean)
      .map(fold)
    return names.includes(fold(left)) && names.includes(fold(right))
  }

  /**
   * The message that answered the most recent turn, as the transcript itself recorded it.
   *
   * Read back from the rows rather than from a field that only the live stream fills: a
   * conversation rebuilt from its session file has the same rows, so it can answer this too.
   * The row is returned whole because a model change also names the provider that served it.
   */
  function lastAnsweredRow(ctx) {
    for (let i = ctx.items.length - 1; i >= 0; i -= 1) {
      const item = ctx.items[i]
      if (item.kind === 'assistant' && item.model) return item
    }
    return null
  }

  /** That row's model name. */
  function lastAnsweredModel(ctx) {
    return lastAnsweredRow(ctx)?.model || null
  }

  /**
   * Whether a value names the router itself rather than a provider that served an answer.
   *
   * Pi is configured with Hammer as its provider, so every message it writes says
   * `provider: "hammer"` — the mechanism, not the host. Printing that beside a model says
   * nothing about who answered, which is the one thing a model-change line exists to say.
   */
  function isRouterProviderValue(value) {
    const name = String(value || '')
      .trim()
      .toLowerCase()
    return (
      name === 'hammer' ||
      name === 'best' ||
      name === 'router' ||
      name === 'hammer-router' ||
      name === 'hammer/best' ||
      name === 'hammer::best'
    )
  }

  /**
   * A provider key as a reader should see it: the table's own name when it has one, otherwise
   * the key spaced and capitalised (`openai-codex` -> "Openai Codex") rather than left raw.
   */
  function providerDisplayName(key) {
    const value = String(key || '').trim()
    if (!value) return ''
    const known = providerNameByKey.get(value)
    if (known) return known
    return value
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  }

  /**
   * The provider that served a message, when it can be known.
   *
   * A message that names the router's current pick can borrow that pick's provider — it is the
   * same answer. One that carries a provider of its own (a session written by a newer Pi, or a
   * tool result from a sub-model) is read directly. Anything else falls back to the router's
   * model table, which knows which provider offers the model even when the route has moved on.
   */
  function messageProviderName(message, ctx) {
    const direct = [
      message?.providerName,
      message?.provider?.name,
      message?.provider,
      message?.model?.provider,
    ].find(
      (value) =>
        typeof value === 'string' && value && !isRouterProviderValue(value) && !isRouterAlias(value),
    )
    if (direct) return providerDisplayName(direct)
    const name = modelName(message?.responseModel || message?.model)
    const routed = ctx && ctx.routedModel
    const routedNames = routed
      ? [routed.modelId, routed.label, routed.realModelId, routed.realModelLabel]
          .filter(Boolean)
          .map((value) => modelName(value))
      : []
    if (routed && name && routedNames.includes(name)) {
      const providerName = routed.providerName || providerDisplayName(routed.providerKey)
      // Learn the brand from the route while it is here: the model table names keys, not hosts,
      // and a later message from the same provider should not fall back to a prettified key.
      if (routed.providerKey && providerName) providerNameByKey.set(routed.providerKey, providerName)
      return providerName
    }
    const key = name ? providerKeyByModel.get(name) : ''
    return key ? providerDisplayName(key) : ''
  }

  /**
   * A model's name as it is printed, without its free-tier marker.
   *
   * `(free)` is the row's tier, not part of the model's name — the same weights are sold paid
   * under the same label — so a printed name is "DeepSeek V4.1 Flash", not "DeepSeek V4.1
   * Flash (free)". The marker is stripped here, at the one place names are printed, rather
   * than from the router's labels: the table still needs it to tell a free row from its paid
   * twin. A name that is nothing but the marker keeps it rather than becoming blank.
   */
  function printableModelName(name) {
    const label = modelName(name)
    const stripped = label
      .replace(/\s*\(free\)\s*$/i, '')
      .replace(/\s+free\s*$/i, '')
      .trim()
    return stripped || label
  }

  /** "Model · Provider", or just the model when the provider would only repeat it. */
  function modelWithProvider(name, provider) {
    const label = printableModelName(name)
    if (!provider || label.toLowerCase().includes(String(provider).toLowerCase())) return label
    return `${label} · ${provider}`
  }

  /**
   * A change of model is a station on the spine, like a tool call: the turn passed through it,
   * and the reply that follows is not from the model that was talking before. It names both
   * ends — "changed to X" alone leaves the reader guessing what X replaced.
   */
  function modelMarkup(item) {
    // Both ends name their provider: a model id alone rarely says who served the answer, and a
    // change is exactly the moment the reader asks.
    const from = modelWithProvider(item.from, item.fromProvider)
    const to = modelWithProvider(item.to, item.toProvider)
    return `<div class="hx-model">
      <div class="hx-model-head">
        ${modelIcon()}
        <span class="hx-model-name">Model</span>
        <span class="hx-model-change">changed from ${escapeHtml(from)} to ${escapeHtml(to)}</span>
      </div>
    </div>`
  }

  /**
   * A compaction row: a station on the spine, drawn like a tool call.
   *
   * It is the agent's own work — the turn paused, tokens were spent, and what the rest of the
   * turn can see changed — so it belongs on the line with the tool calls, not in a card of its
   * own beside the log. The summary stays behind a disclosure because it is past context:
   * available to a reader who wants to know what survived, without being re-read as the
   * current instruction.
   */
  function compactionMarkup(item) {
    const state = item.state || 'done'
    // The tool row's own tone names, so one set of state rules styles both kinds of station.
    const tone =
      state === 'running'
        ? 'running'
        : state === 'error'
          ? 'error'
          : state === 'aborted'
            ? 'interrupted'
            : 'ok'
    const figures = item.figures
      ? `<span class="hx-compaction-figures">${escapeHtml(item.figures)}</span>`
      : ''
    // Prose, not code: a compaction summary is sentences a reader scans, and models write it
    // as Markdown (headings, bullets, bold). It goes through the same renderer as an answer,
    // which escapes every leaf exactly once, so the summary reads instead of showing its
    // syntax — and none of it can become markup on the page.
    const summary = item.summary
      ? `<details class="hx-compaction-summary"><summary>What was kept</summary><div class="hx-compaction-kept">${renderText(item.summary.slice(0, 20000))}</div></details>`
      : ''
    // While it is being written, the summary is shown in place: the pause is the model working,
    // and a row that says only "Compacting the context…" hides the one thing that explains it.
    // The tail is kept rather than the whole text — the reader wants to watch it arrive, not to
    // scroll back through a page that is still growing.
    const stream = state === 'running' && item.stream
      ? `<div class="hx-compaction-stream" data-compaction-stream>${renderText(item.stream.slice(-COMPACTION_PREVIEW))}</div>`
      : ''
    return `<div class="hx-compaction ${tone}" data-state="${state}">
      <div class="hx-compaction-head">
        ${compactionIcon()}
        <span class="hx-compaction-name">Compaction</span>
        <span class="hx-compaction-cmd">${escapeHtml(item.text || compactionText(item))}</span>
        ${figures}
      </div>
      ${stream}
      ${summary}
    </div>`
  }

  /**
   * Repaints one compaction row while its summary streams.
   *
   * The row is already mounted and nothing before it moved, so only its own markup is rebuilt:
   * a summary arrives a token at a time, and a full transcript sync per token would rebuild
   * every row on the page to change one of them.
   */
  function patchCompactionItem(item, ctx = active()) {
    if (ctx !== active()) return
    const transcript = $('hx-transcript')
    if (!item?.node || !item.node.isConnected) {
      syncTranscript({}, ctx)
      return
    }
    const stick = transcript && atBottom(transcript)
    // Each repaint replaces the stream's markup, which would snap the box back to the top on
    // every token. Follow the newest line instead — unless the reader scrolled up to read
    // something earlier, in which case their place is kept.
    const previous = item.node.querySelector('[data-compaction-stream]')
    const follow = !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 24
    const wasAt = previous ? previous.scrollTop : 0
    item.node.innerHTML = compactionMarkup(item)
    const stream = item.node.querySelector('[data-compaction-stream]')
    if (stream)
      stream.scrollTop = follow ? stream.scrollHeight : Math.min(wasAt, stream.scrollHeight)
    if (stick && transcript) transcript.scrollTop = transcript.scrollHeight
    scheduleMinimap()
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
      // Nothing can be waiting when there is no log to wait at the end of: the badge a reset
      // left behind would sit under the empty state claiming a run had not started.
      syncWaitBadge(ctx)
      return
    }
    if (transcript.querySelector('.hx-empty')) transcript.innerHTML = ''
    const stick = atBottom(transcript)
    // Mounted means "has a row in the log", not "has been passed over". The cursor below used
    // to advance past an assistant row that was skipped for having no text yet — and that is the
    // row a turn is about to stream into. `message_start` pushes it empty, the sync skips it and
    // moves the cursor to the end, so every later sync started AFTER it and never built the row:
    // the answer arrived in one piece at `message_end`, which rebuilds the transcript from
    // scratch. A tool row, which mounts the moment it exists, streamed normally beside it — which
    // is why only some turns looked like they were streaming. The node is the honest test.
    for (let i = 0; i < state.items.length; i += 1) {
      const item = state.items[i]
      if (item.node && item.node.isConnected) continue
      // An assistant row with no visible text is not a message: the pending "…" belongs to a
      // turn that is still arriving, and a settled one has already been dropped at message_end.
      // Not mounting it is what keeps a restored or background conversation free of them; it
      // mounts on the first sync after its first token, because the cursor no longer passes it.
      if (
        item.kind === 'assistant' &&
        !(item.blocks || []).some((block) => String(block.text || '').trim())
      )
        continue
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
    // Folded here, in the same task as the mount, rather than on a frame: a thought that turns
    // out to be one line is repainted before the browser ever paints the head it arrived with,
    // so the head does not flash up and vanish on a settled turn or a reopened conversation.
    applyThoughtFolds(ctx)
    scheduleMinimap()
    syncWaitBadge(ctx)
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

  /** Frames left to retry a paint the layout was not ready for. */
  let minimapRetries = 0

  /**
   * About two seconds of frames: long enough for a hidden pane to be laid out, short enough
   * that a rail which is genuinely display:none (below 960px) stops asking.
   */
  const MINIMAP_RETRY_LIMIT = 120

  /** Coalesces paint requests: streaming appends many rows a second, the rail needs one frame. */
  function scheduleMinimap() {
    // A real change — a row mounted, a resize, the view coming back — restores the budget.
    minimapRetries = 0
    queueMinimapFrame()
  }

  /**
   * Requests one paint frame without touching the retry budget, so a paint that bailed for an
   * unsized track can ask again next frame without resetting its own allowance.
   */
  function queueMinimapFrame() {
    if (minimapFrame) return
    minimapFrame = requestAnimationFrame(() => {
      minimapFrame = 0
      renderMinimap()
    })
  }

  /**
   * Retries a paint that measured a 0px track, rather than dropping it for the rest of the
   * session. The track is 0 while the rail is display:none — a narrow window, or the agent view
   * off screen because the app was restarted on the router view — and a dropped paint there used
   * to leave a restored conversation with no notches until a resize or the next turn.
   */
  function scheduleMinimapRetry() {
    if (minimapRetries >= MINIMAP_RETRY_LIMIT) return
    minimapRetries += 1
    queueMinimapFrame()
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
    // could never unhide itself. An off-screen agent view measures 0 for the same reason;
    // retried rather than dropped (see scheduleMinimapRetry).
    rail.hidden = false
    if (!rail.clientHeight) return scheduleMinimapRetry()

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
      // The whole conversation fits on screen: there is nowhere to pan, so the pane-window
      // that says where you are would be a full-height grab that cannot be moved.
      windowEl.hidden = true
      return
    }
    windowEl.hidden = false
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
    // A resize changes both the scale and the track, so the whole rail is redrawn — and it
    // changes the column a thought wraps at, so a line that fitted may now need a fold.
    window.addEventListener('resize', scheduleMinimap)
    window.addEventListener('resize', scheduleThoughtFolds)
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
      if (item.node) item.node.innerHTML = assistantMarkup(item)
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
      // A new block is the model moving on: whatever it was writing before is finished, and
      // folds where it stands.
      finishBlocks(item)
      block = { kind, index: contentIndex, text: '' }
      // The head reports how long the thought took to arrive, so the clock starts on its first
      // delta; `lastDeltaAt` is what stops before the model moves on to writing the answer.
      if (kind === 'thinking') block.startedAt = Date.now()
      item.blocks.push(block)
      // Pi restarts `contentIndex` at 0 for every assistant message and grows it in production
      // order, so the index is the model's order — not the order the frames happened to arrive.
      item.blocks.sort((a, b) => a.index - b.index)
    }
    block.text = clip(block.text + (delta || ''), MAX_TEXT)
    if (kind === 'thinking') block.lastDeltaAt = Date.now()
    patchStreamingItem(ctx)
    // The first token is the wait ending; the badge goes on the frame it becomes false.
    syncWaitBadge(ctx)
  }

  function ensureTool(id, name, ctx = active()) {
    const key = String(id || name || 'tool')
    let item = ctx.tools.get(key)
    if (item) return item
    // The call ends whatever the model was writing to introduce it: that thought folds now.
    finishBlocks(lastAssistant(ctx))
    item = { kind: 'tool', id: key, name: name || 'tool', args: null, status: 'preparing', result: '', partial: '' }
    ctx.tools.set(key, item)
    ctx.items.push(item)
    syncTranscript({}, ctx)
    return item
  }

  /**
   * Closes the rows whose end never arrived.
   *
   * `tool_execution_start` and `tool_execution_end` are two separate records, and anything that
   * ends a run between them — Stop, a crashed or replaced child, a replay log whose bounded
   * tail is a start — leaves the row claiming to be running for as long as it stays on screen.
   * A tool cannot still be executing once its turn is over, so every place a run stops being
   * live settles what is still open here; a row the agent already finished is left untouched.
   *
   * @returns {boolean} whether any row changed
   */
  function settleOpenTools(ctx = active()) {
    if (!ctx) return false
    let changed = false
    for (const item of ctx.tools.values()) {
      if (item.status !== 'running' && item.status !== 'preparing') continue
      item.status = 'interrupted'
      item.partial = ''
      changed = true
    }
    // The rows are already mounted, so a repaint is what makes the settled state visible.
    if (changed) syncTranscript({ reset: true }, ctx)
    return changed
  }

  function contentParts(content) {
    if (typeof content === 'string') {
      // Whitespace is not an answer. A turn that produced only a newline used to keep a row
      // that rendered as the pending "…", which reads as a message nobody sent.
      return content.trim() ? [{ kind: 'text', index: 0, text: clip(content, MAX_TEXT) }] : []
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
      if (kind && text.trim()) blocks.push({ kind, index, text: clip(text, MAX_TEXT) })
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
    // Proof the console's stream is alive, which is what the stall check measures: a busy
    // console that produces nothing is a flag nobody is behind.
    ctx.lastRecordAt = Date.now()
    switch (record.type) {
      case 'agent_start':
        setRunning(true, ctx)
        break
      case 'agent_settled':
        // Pi is finished with the run — retries, compaction and queued work included — so no
        // tool can still be executing. Whatever the stream left open was cut off, not in flight.
        settleOpenTools(ctx)
        setRunning(false, ctx)
        break
      case 'agent_end':
        // A tool still open when the run's messages are finished is one whose end never arrived
        // (a crash or a stop mid-command). `agent_settled` follows and settles again harmlessly.
        settleOpenTools(ctx)
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
          const model = messageModelName(message, ctx)
          // The mark belongs to the transcript, not to a variable: which model answered is kept
          // on the row, so a restart can rebuild the same stations from the same messages (see
          // loadMessages) instead of remembering a change it never saw arrive. `ctx.routedModel`
          // is the router's *selection* — an object, and the badge's own reading — so a message
          // never overwrites it with a bare id. `ctx.answeredModel` is the composer's separate
          // reading of the newest answer, which is what lets a fallback update the strip at once.
          if (model) noteAnsweredModel(ctx, model)
          const provider = messageProviderName(message, ctx)
          // The row is the transcript's record, but it is not the record of the last answer: a
          // message that only called a tool leaves no row behind (`message_end` drops it), and
          // in a tool-heavy run that is every message. Comparing against surviving rows alone
          // therefore kept finding the one old row that had prose and drew the same "changed
          // from" line on every turn, while the agent answered on the same model throughout.
          // `ctx.lastAnswer` is the message immediately before this one, row or no row; the
          // last row is only the fallback for a console that has not seen a message yet.
          const previousRow = lastAnsweredRow(ctx)
          const previous = ctx.lastAnswer?.model || previousRow?.model || null
          const previousProvider = ctx.lastAnswer?.model
            ? ctx.lastAnswer.provider || ''
            : previousRow?.provider || ''
          if (model && previous && !sameAnswerIdentity(ctx, previous, model)) {
            ctx.items.push({
              kind: 'model',
              from: previous,
              to: model,
              fromProvider: previousProvider,
              toProvider: provider,
            })
          }
          if (model) ctx.lastAnswer = { model, provider }
          ctx.items.push({ kind: 'assistant', blocks: [], settled: false, model, provider })
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
          // The turn just settled in the file the plot reads, so a console that is on screen
          // republishes its history — this is the only live update the plot gets, and it is
          // the one that keeps the rail's newest bar level with the newest answer. A console
          // in the background waits for the switch (see activate).
          if (ctx.sessionFile === active()?.sessionFile) void publishSessionUsage(ctx)
          // The message's own report is the truth, not the route it was sent on: a fallback
          // answers with a model the pick did not name. This is the base the next message is
          // compared against, so it has to be what answered rather than what was asked.
          const reported = messageModelName(message, ctx)
          if (reported) {
            ctx.lastAnswer = { model: reported, provider: messageProviderName(message, ctx) }
            noteAnsweredModel(ctx, reported)
          }
          const item = lastAssistant(ctx)
          if (item) {
            // The message is complete: its thoughts stop being live and fold away with it.
            item.settled = true
            finishBlocks(item)
            // Only visible text counts as streamed: a turn whose one delta was a newline is as
            // empty as one that streamed nothing, and must not keep the block it made.
            const streamed = item.blocks.some((block) => String(block.text || '').trim())
            if (!streamed) item.blocks = contentParts(message.content)
            // The head reports what the thought cost: the span its deltas streamed for, and the
            // reasoning tokens the provider billed for this message.
            for (const block of item.blocks) {
              if (block.kind !== 'thinking' || !block.startedAt) continue
              block.durationMs = Math.max(0, (block.lastDeltaAt || Date.now()) - block.startedAt)
            }
            assignThinkingStats(item, message.usage?.reasoning)
            rememberThoughtStats(ctx, message, item.blocks)
            if (!item.blocks.some((block) => String(block.text || '').trim())) {
              // A turn that produced nothing leaves no row at all: neither an empty bubble nor
              // the pending "…" it was drawn as. The notice below, if any, explains the turn.
              item.settled = true
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
      // ── Compaction ───────────────────────────────────────────────────────────────────
      //
      // Pi replaces everything above a boundary with a summary. The reader keeps the whole
      // transcript on screen, so without a row here the conversation would appear to lose
      // turns it never lost, and a long unexplained pause would read as a hung agent. Both
      // halves of the pair are needed: `compaction_start` says it is happening and why, and
      // `compaction_end` says whether it worked, what it cost, and how much room is left.
      case 'compaction_delta': {
        // Pi has no summary event of its own: the text arrives because the proxy tapped the
        // completion it streams while this console is compacting (see lib/pi/compaction-stream.js).
        const item = lastCompaction(ctx)
        const delta = typeof record.delta === 'string' ? record.delta : ''
        if (!item || !delta) break
        item.stream = clip((item.stream || '') + delta, MAX_TEXT)
        patchCompactionItem(item, ctx)
        break
      }
      case 'compaction_start':
        ctx.items.push({
          kind: 'compaction',
          reason: String(record.reason || ''),
          text: 'Compacting the context…',
          figures: '',
          tokensBefore: null,
          tokensAfter: null,
          summary: '',
          stream: '',
          error: '',
          state: 'running',
        })
        syncTranscript({}, ctx)
        break
      case 'compaction_end': {
        const result = record.result || {}
        const before = Number(result.tokensBefore)
        const after = Number(result.estimatedTokensAfter)
        const item = lastCompaction(ctx) || {
          kind: 'compaction',
          reason: String(record.reason || ''),
          text: '',
          figures: '',
          tokensBefore: null,
          tokensAfter: null,
          summary: '',
          stream: '',
          error: '',
          state: 'running',
        }
        if (!lastCompaction(ctx)) ctx.items.push(item)
        item.state = record.aborted ? 'aborted' : record.errorMessage ? 'error' : 'done'
        if (record.reason) item.reason = String(record.reason)
        item.error = String(record.errorMessage || '')
        item.tokensBefore = Number.isFinite(before) ? before : null
        item.tokensAfter = Number.isFinite(after) ? after : null
        if (typeof result.summary === 'string') item.summary = result.summary
        // The finished summary takes over the row; the live preview is done.
        item.stream = ''
        item.text = compactionText(item)
        item.figures = compactionFigures(item)
        // The row this ends is already on screen, and `syncTranscript` paints only rows it has
        // never mounted — so asking it to sync left the compaction saying "Compacting the
        // context…" for as long as the page stayed open: no figures, no failure, no sign it had
        // finished, which is exactly what a compaction that did nothing looks like. Patching the
        // row itself is what ends it. A row that was never mounted falls back to a sync inside.
        patchCompactionItem(item, ctx)
        break
      }
      default:
        break
    }
  }

  /**
   * The compaction row still waiting for its outcome.
   *
   * Search runs backwards because a second `compaction_start` with no end between them is
   * the only shape a cancelled compaction can leave (pi aborts on cancel, and an abort can
   * race the record that reports it).
   * @returns {any|null}
   */
  function lastCompaction(ctx = active()) {
    for (let i = ctx.items.length - 1; i >= 0; i -= 1) {
      const item = ctx.items[i]
      if (item.kind !== 'compaction') continue
      if (item.state === 'running') return item
    }
    return null
  }

  /** Why it compacted, in the words a reader needs. Pi's three reasons are not three states. */
  function compactionReasonLabel(reason) {
    if (reason === 'threshold') return 'the context was nearly full'
    if (reason === 'overflow') return 'the context overflowed'
    if (reason === 'manual') return 'you asked for it'
    return ''
  }

  /**
   * One phrase for a pair of token figures, rounded to the same thousands the token strip uses.
   *
   * A compaction only ever removes text, so the figure measured before it cannot be the smaller
   * of the two. It can come back that way: Pi reads the context size off the last assistant
   * message's usage, and a provider that reports no prompt tokens — or only the tokens it
   * generated — leaves it with the length of an answer, so a context that had just overflowed
   * was reported as "122 tokens". Printed beside the 17k Pi estimated afterwards, that pair said
   * the opposite of what happened, which is worse than saying less. An inverted pair is not a
   * shrink, so only the size afterwards is shown; the figure dropped was never a context's size.
   */
  function compactionPair(before, after) {
    const fmt = (n) => (typeof window.hxCompact === 'function' ? window.hxCompact(n) : String(n))
    const b = before == null ? null : Number(before)
    const a = after == null ? null : Number(after)
    const known = (v) => v != null && Number.isFinite(v)
    if (known(b) && known(a)) return b > a ? `${fmt(b)} → ${fmt(a)} tokens` : `to ${fmt(a)} tokens`
    if (known(b)) return `from ${fmt(b)} tokens`
    if (known(a)) return `to ${fmt(a)} tokens`
    return ''
  }

  /** The figures Pi reported for one compaction row. */
  function compactionFigures(item) {
    return compactionPair(item.tokensBefore, item.tokensAfter)
  }

  /** The row's sentence, which is what the notice summary shows. */
  function compactionText(item) {
    if (item.state === 'error') {
      // Pi's own message already opens with "Compaction failed: ", and this sentence does too:
      // the reader needs the reason once, not twice.
      const why = item.error
        ? item.error
            .replace(/^compaction failed:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim()
        : 'Pi could not compact.'
      return `Compaction failed: ${why.slice(0, 300)}`
    }
    if (item.state === 'aborted') return 'Compaction was cancelled.'
    if (item.state === 'running') return 'Compacting the context…'
    const why = compactionReasonLabel(item.reason)
    return why ? `Context compacted — ${why}.` : 'Context compacted.'
  }

  // ── Status and routing ──────────────────────────────────────────────────────────────

  // ── Thinking effort ─────────────────────────────────────────────────────────────────

  /**
   * The levels the slider maps to when the route cannot say what it takes: quietest first.
   * `minimal` is left to clients that can spell it. The route's own answer replaces this (see
   * paintThinking), so a model with no reasoning mode is not offered three steps that do nothing.
   */
  const THINKING_DEFAULT_LEVELS = ['off', 'low', 'medium', 'high']

  /** The levels the slider is showing now: the current model's steps, or the default set. */
  let thinkingLevels = THINKING_DEFAULT_LEVELS

  /** Every level pi's own control knows, quietest first, for placing one in a shorter list. */
  const THINKING_RANK = ['off', 'minimal', 'low', 'medium', 'high']

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

  /** Reads the slider's notch and applies it — a step of the model on screen, not a fixed one. */
  function thinkingFromSlider() {
    const slider = $('hx-thinking-slider')
    if (!slider || slider.disabled) return
    setThinkingLevel(thinkingLevels[Number(slider.value)] || 'off')
  }

  /**
   * Where a level sits in the list the slider is showing.
   *
   * The agent's level can be one this model has no step for — a conversation moved from a
   * model that takes `minimal` to one whose quietest real step is `low`. The control then rests
   * on the nearest step instead of snapping to the first one, which would read as "off".
   */
  function thinkingPosition(levels, level) {
    const exact = levels.indexOf(level)
    if (exact >= 0) return exact
    const want = THINKING_RANK.indexOf(level)
    if (want < 0) return 0
    let best = 0
    let distance = Infinity
    levels.forEach((candidate, index) => {
      const rank = THINKING_RANK.indexOf(candidate)
      const gap = rank < 0 ? Infinity : Math.abs(rank - want)
      // A tie goes to the harder step: `minimal` on a list without it is nearer `low` than `off`,
      // and a control that reads "off" while the agent holds a level is the worse lie.
      if (gap <= distance) {
        distance = gap
        best = index
      }
    })
    return best
  }

  /**
   * Paints the thinking control from the route's own answer.
   *
   * The router reports the steps the current model and wire actually take. A control that
   * offers four of them on a model with none is a control that lies: the level is dropped on
   * the way out, so dragging it changes nothing. So the slider is built from exactly the
   * reported steps — one step disables it, with the route's reason on its title — and the
   * slider's value is the step the console is really on.
   */
  function paintThinking(choices, level) {
    const levels =
      Array.isArray(choices?.levels) && choices.levels.length
        ? choices.levels
        : THINKING_DEFAULT_LEVELS
    thinkingLevels = levels
    const inert = levels.length < 2
    // A route with one step has nothing to set, and a slider that cannot move reads as a broken
    // one — so the block is not shown at all. It returns the moment a route reports steps.
    const control = $('hx-thinking')
    if (control) control.hidden = inert
    const slider = $('hx-thinking-slider')
    if (slider) {
      slider.min = '0'
      slider.max = String(Math.max(0, levels.length - 1))
      slider.step = '1'
      slider.value = String(thinkingPosition(levels, level || 'off'))
      slider.disabled = inert
      slider.title = inert
        ? `${choices?.reason || 'This model has no thinking levels.'} Nothing to choose here.`
        : `Thinking effort — ${levels.join(', ')}. Sent in whatever form the chosen model understands.`
    }
    // With no step to set, the level the console holds is not going anywhere: showing `low`
    // beside a disabled control would claim thinking this model never receives.
    const label = $('hx-thinking-level')
    if (label) label.textContent = inert ? 'off' : level || 'off'
  }

  /** Paints the conversation's slope, which the router reports with every status. */
  function paintSlopePercent(percent) {
    const value = Number(percent)
    const shown = Number.isFinite(value) ? Math.round(value) : 4
    const label = $('hx-slope-value')
    if (label) label.textContent = shown + '%'
    const slider = $('hx-slope-slider')
    if (slider && String(slider.value) !== String(shown)) slider.value = String(shown)
  }

  /** The slope thumb's width in px, matching the router page selector it was copied from. */
  const SLOPE_THUMB_PX = 12
  /** The CSS width of a composer slider, used when the control has not been laid out yet. */
  const SLOPE_TRACK_PX = 88

  /**
   * Where a slider value puts the thumb's *centre* on the track, as a percentage of its width.
   * The slope thumb is 12px wide on an 88px track, so its centre travels 6px→82px while the
   * value travels 0→100: a hairline painted at the raw percentage would sit beside the dot that
   * is supposed to rest on it. `width` is the measured track, or 0 before layout.
   */
  function thumbCentrePercent(percent, width) {
    const span = width > SLOPE_THUMB_PX ? width : SLOPE_TRACK_PX
    const clamped = Math.max(0, Math.min(100, Number(percent)))
    return ((SLOPE_THUMB_PX / 2 + (clamped / 100) * (span - SLOPE_THUMB_PX)) / span) * 100
  }

  /**
   * Paints the slope slider's notches: one per region in which the router's pick does not
   * change, at the region's midpoint, so dragging across a notch is dragging across a model.
   * Each hairline is placed under the thumb's centre for its value, not at the value itself.
   */
  function paintSlopeNotches() {
    const slider = $('hx-slope-slider')
    if (!slider) return
    const width = slider.getBoundingClientRect?.().width || 0
    const stops = slopeNotches.map((pct) => `${thumbCentrePercent(pct, width).toFixed(2)}%`)
    slider.style.setProperty(
      '--slope-notches',
      stops.length
        ? `linear-gradient(to right, ${stops
            .map(
              (stop) =>
                `transparent calc(${stop} - 1px), var(--border) calc(${stop} - 1px) calc(${stop} + 1px), transparent calc(${stop} + 1px)`,
            )
            .join(', ')})`
        : 'none',
    )
  }

  // ── The slope popup ─────────────────────────────────────────────────────────────────────
  //
  // The slider is three words wide and a percentage; the choice it makes is a picture — every
  // model placed by how smart and how fast it is, and the line this conversation's slope lowers
  // onto them. Dragging it used to change a number with no way to see what moved, so the field
  // is drawn above the composer while the control is in hand and folds away when it is not.
  //
  // The numbers are copies of lib/utils.js (computeRowSpeed, selectorSlopeCeiling), for the same
  // reason the dashboard keeps one: the browser cannot import the server's module, and a line
  // drawn from a different constant would name a model the router would not pick.
  /** The answered length every row is scored at, in output tokens. */
  const SLOPE_PLOT_REFERENCE_TOKENS = 500
  /** How far past the last takeover the top of the slider sits (lib/utils.js' headroom). */
  const SLOPE_PLOT_HEADROOM = 1.5

  /** A response that actually answered. A refusal measures the provider's mood, not its speed. */
  function plottedResponse(lastResponse) {
    if (!lastResponse || lastResponse.ok === false || lastResponse.error) return null
    if (lastResponse.text == null || String(lastResponse.text).trim() === '') return null
    return lastResponse
  }

  /**
   * The rows the popup plots: a rating and a speed, and nothing else it would have to trust.
   *
   * Every measured row is drawn, routable or not — a benched or exhausted row is still a place
   * on this map, and its absence would quietly shrink the field the slider is choosing within.
   * The line, though, is only lowered onto rows the router would actually use, so it lands on
   * the model the router would pick.
   */
  function collectSlopePlotPoints(models) {
    const points = []
    for (const row of models) {
      // A `noauth` row has never been measured against a model; there is nothing to place.
      if (!row || row.status === 'noauth') continue
      const id = String(row.modelId || row.id || '')
      const aa = Number(row.aa)
      // The router's own two numbers, when the payload carries them: the line, the pick and the
      // strip all have to be talking about the same row, and a dot placed by a different speed
      // formula puts the line on a dot the router would not choose.
      const routingIntell = Number(row.routingIntell)
      const routingSpeed = Number(row.routingSpeed)
      const routerNumbers =
        Number.isFinite(routingIntell) &&
        routingIntell > 0 &&
        Number.isFinite(routingSpeed) &&
        routingSpeed > 0
      const intell = routerNumbers
        ? routingIntell
        : Number.isFinite(aa) && aa > 0
          ? aa
          : Number(row.intell) * 100
      // The row's own measurement, or the last response that answered — the same fallback the
      // table's columns and the dashboard's scatter read.
      const served = plottedResponse(row.lastResponse)
      const ttft =
        row.ttft != null
          ? Number(row.ttft)
          : served && served.ttftMs != null
            ? Number(served.ttftMs)
            : null
      const tps =
        row.tps != null
          ? Number(row.tps)
          : served && served.tps != null
            ? Number(served.tps)
            : null
      if (!id || !(Number.isFinite(intell) && intell > 0)) continue
      let speed = routerNumbers ? routingSpeed : null
      if (speed == null) {
        if (ttft == null || !Number.isFinite(ttft) || ttft < 0) continue
        if (tps == null || !Number.isFinite(tps) || tps <= 0) continue
        speed = SLOPE_PLOT_REFERENCE_TOKENS / (ttft / 1000 + SLOPE_PLOT_REFERENCE_TOKENS / tps)
      }
      points.push({
        modelId: id,
        providerKey: String(row.providerKey || ''),
        label: String(row.label || row.name || id),
        intell,
        speed,
        // The router's own flag, so "what the line picks" and "what the router routes" cannot
        // drift apart. Payloads from an older server fall back to the table's verdict.
        routable: typeof row.routingEligible === 'boolean' ? row.routingEligible : row.status === 'up',
      })
    }
    return points
  }

  /**
   * The slope at the top of the slider, over the plotted field.
   *
   * A copy of selectorSlopeCeiling: the intelligence spread over the speed spread, or the
   * fastest row's own takeover slope when that is larger (a row can be both smart and fast, and
   * then it keeps winning past the spread), times the headroom that gives the top of the track
   * a region of its own.
   */
  function slopePlotCeiling(points) {
    if (points.length < 2) return null
    let intellMin = Infinity
    let intellMax = -Infinity
    let speedMin = Infinity
    let speedMax = -Infinity
    for (const point of points) {
      intellMin = Math.min(intellMin, point.intell)
      intellMax = Math.max(intellMax, point.intell)
      speedMin = Math.min(speedMin, point.speed)
      speedMax = Math.max(speedMax, point.speed)
    }
    const speedSpan = speedMax - speedMin
    const intellSpan = intellMax - intellMin
    const spread = speedSpan > 0 && intellSpan > 0 ? intellSpan / speedSpan : 0
    // The upper envelope of `intelligence + slope × speed`: at a given speed only the smartest
    // row can win, and a row whose takeover comes no later than its predecessor's never does.
    const bySpeed = new Map()
    for (const point of points) {
      const previous = bySpeed.get(point.speed)
      if (!previous || point.intell > previous.intell) bySpeed.set(point.speed, point)
    }
    const hull = []
    for (const point of [...bySpeed.values()].sort((a, b) => a.speed - b.speed)) {
      let start = -Infinity
      while (hull.length) {
        const last = hull[hull.length - 1]
        const crossing = (last.intell - point.intell) / (point.speed - last.speed)
        if (crossing <= last.start) {
          hull.pop()
          continue
        }
        start = crossing
        break
      }
      if (hull.length === 0) start = -Infinity
      hull.push({ intell: point.intell, speed: point.speed, start })
    }
    const takeover = hull.length >= 2 ? hull[hull.length - 1].start : 0
    const base = Math.max(spread, Number.isFinite(takeover) && takeover > 0 ? takeover : 0)
    return base > 0 ? base * SLOPE_PLOT_HEADROOM : null
  }

  /**
   * A stable hue per provider, the same function the router page's scatter uses: two providers
   * offering the same model have to be told apart at a glance in both pictures, or the popup is
   * showing a field the page beside it does not.
   */
  function slopePlotHue(providerKey) {
    let h = 0
    for (const ch of String(providerKey || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0
    return Math.abs(h) % 360
  }

  /** How far past the field a row may sit before the axis stops calling that speed a scale. */
  const SLOPE_PLOT_OUTLIER_FACTOR = 2

  /**
   * The router's own minimums, mirrored so the popup filters the field the way the router does.
   * They belong to the router, not to one conversation, which is why they are read from and
   * written back to /api/selector while the slope itself stays per-conversation.
   */
  let slopeMinima = { minSpeed: null, minIntell: null }
  /** Extents from the last draw, so a dragged line can be turned back into a data value. */
  let slopePlotScales = null
  let slopeMinimaDrag = null
  let slopeMinimaSaveTimer = null

  /** The router plot's number formats, so both pictures label an axis the same way. */
  const fmtSlopeSpeed = (v) =>
    v >= 1000
      ? v.toFixed(0)
      : v >= 1
        ? v.toPrecision(3).replace(/\.?0+$/, '')
        : v.toPrecision(2).replace(/\.?0+$/, '')
  const fmtSlopeIntell = (v) =>
    v >= 100 ? String(Math.round(v)) : Number.isInteger(v) ? String(v) : v.toFixed(1)

  /**
   * The axis maximum the field supports, plus how many rows sit past it — the router plot's rule,
   * so one very fast row cannot flatten every other dot in the popup either. A cut only counts
   * while the rows above the gap stay a strict minority: a 2x ratio between two small speeds is
   * ordinary jitter, not an outlier.
   */
  function slopeAxisLimit(speeds) {
    const sorted = speeds.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1] > sorted[i] * SLOPE_PLOT_OUTLIER_FACTOR) {
        if (i >= sorted.length - i) break
        return { limit: sorted[i], offScale: i }
      }
    }
    return { limit: sorted[0] ?? 0, offScale: 0 }
  }

  /** A row clearing the router's minimums. An unset minimum imposes nothing. */
  function pointClearsMinimums(point) {
    if (slopeMinima.minSpeed != null && point.speed < slopeMinima.minSpeed) return false
    if (slopeMinima.minIntell != null && point.intell < slopeMinima.minIntell) return false
    return true
  }

  /**
   * The part of a line through a pixel point that lies inside the plot box.
   *
   * The line is a contour of `intelligence + slope × speed`: as speed rises the score it holds
   * falls, so on the screen it descends to the right — the way this plot has always drawn it,
   * and the direction that makes "steeper" mean "faster is worth more". Screen y grows
   * downward, so descending means y *increases* with x.
   *
   * The line turns through the whole quadrant, so its ends leave the viewBox long before the
   * track ends; clipping to the box keeps every frame inside the picture instead of letting a
   * steep line's endpoints run thousands of pixels off it.
   */
  /**
   * The screen gradient of a contour of `intelligence + slope × speed`.
   *
   * A contour holds one score: intelligence falls by `slope` for every unit of speed. The two
   * axes are scaled independently — plotH pixels per ySpan of intelligence, plotW pixels per
   * xSpan of speed — and screen y grows downward, which is what turns `intelligence` falling as
   * speed rises into a line that descends to the right on the picture. This is the angle the
   * pick maximises along; any other angle is a different line, drawn through the same dot.
   */
  function slopeContourScreenSlope(slope, plotH, ySpan, plotW, xSpan) {
    if (!(slope > 0) || !(plotH > 0) || !(plotW > 0) || !(ySpan > 0) || !(xSpan > 0)) return 0
    return (slope * plotH * xSpan) / (ySpan * plotW)
  }

  function slopeLineSegment(px, py, screenSlope, pad, plotW, plotH) {
    const left = pad.left
    const right = pad.left + plotW
    const top = pad.top
    const bottom = pad.top + plotH
    if (!(screenSlope > 0) || !Number.isFinite(screenSlope)) {
      const y = Math.max(top, Math.min(bottom, py))
      return { x1: left, y1: y, x2: right, y2: y }
    }
    // x = px + t, y = py + screenSlope · t, kept to the part inside the box.
    let tMin = Math.max(left - px, (top - py) / screenSlope)
    let tMax = Math.min(right - px, (bottom - py) / screenSlope)
    if (!(tMax > tMin)) {
      tMin = 0
      tMax = 0
    }
    return {
      x1: px + tMin,
      y1: py + screenSlope * tMin,
      x2: px + tMax,
      y2: py + screenSlope * tMax,
    }
  }

  /** The plot, as markup: dots, the line this slope lowers, and the row it lands on. */
  function slopePlotMarkup(percent) {
    const points = slopePlotPoints
    if (!points.length) {
      return '<p class="hx-slope-pop-empty">No measured model to plot yet.</p>'
    }
    const W = 340
    const H = 214
    const pad = { top: 18, right: 14, bottom: 28, left: 32 }
    const plotW = W - pad.left - pad.right
    const plotH = H - pad.top - pad.bottom
    let xMin = Math.min(...points.map((point) => point.speed))
    let xMax = Math.max(...points.map((point) => point.speed))
    if (!(xMax > xMin)) {
      const span = Math.abs(xMax) * 0.2 || 0.001
      xMin -= span
      xMax += span
    }
    // A row far faster than the rest rests on the edge with an arrow instead of stretching the
    // axis until every other dot collapses into the left margin — the router plot's rule.
    const { limit, offScale } = slopeAxisLimit(points.map((point) => point.speed))
    if (offScale > 0) xMax = Math.min(xMax, limit)
    const xPad = (xMax - xMin) * 0.06
    xMin = Math.max(0, xMin - xPad)
    xMax += xPad
    let yMin = Math.min(...points.map((point) => point.intell))
    let yMax = Math.max(...points.map((point) => point.intell))
    const ySpan0 = yMax - yMin || Math.abs(yMax) * 0.05 || 10
    yMin = Math.max(0, yMin - ySpan0 * 0.08)
    // An Artificial Analysis index cannot exceed 100, so the axis never needs to.
    yMax = Math.min(100, yMax + ySpan0 * 0.08)
    if (!(yMax > yMin)) yMax = yMin + 1
    const xSpan = Math.max(1e-9, xMax - xMin)
    const ySpan = Math.max(1e-9, yMax - yMin)
    const xOf = (speed) => pad.left + ((Math.min(speed, xMax) - xMin) / xSpan) * plotW
    const yOf = (intell) => pad.top + (1 - (intell - yMin) / ySpan) * plotH

    // The line and the pick belong to the rows the router would use, and to nothing else. With
    // fewer than two of them there is no slope to speak of, so the scale is missing and the
    // line is left off — but the pick still may not fall back to the dots the router would
    // never choose: it used to, which is how the popup could ring a benched row at a
    // percentage where the router would have taken a live one.
    const field = points.filter((point) => point.routable)
    // The router filters this same field by its minimums before it picks, so the popup has to
    // as well: a line lowered onto rows the router will not consider names a model that will
    // not answer. With nothing clearing the minimums the router falls back to its ranking, and
    // the caption says so rather than inventing a pick.
    const eligible = field.filter((point) => pointClearsMinimums(point))
    // The router's own scale when the payload carries it; the local copy only stands in for an
    // older server. Two ceilings over two slightly different fields is how the line came to rest
    // on a dot the pick did not choose.
    const ceiling = slopePlotCeilingSlope ?? slopePlotCeiling(eligible)
    const slope = ceiling ? (percent / 100) * ceiling : 0
    // The line is a constant score: intelligence + slope × speed. The row on it with the
    // highest score is the router's pick at this slope, which is what the caption names.
    // The pick is the row that clears the minimums and sits highest on `intelligence + slope ×
    // speed` — the same argmax the router computes.
    let pick = null
    let best = -Infinity
    let bestSpeed = -Infinity
    for (const point of eligible) {
      const value = point.intell + slope * point.speed
      // selectModelBySlope's own rule: rows within rounding of one another are equally good on
      // this line, and the faster one is the pick. Without it the popup could ring a dot the
      // router would not choose from a tie.
      const tied = pick !== null && Math.abs(value - best) <= 1e-9 * Math.max(1, Math.abs(value))
      if (pick === null || (value > best && !tied) || (tied && point.speed > bestSpeed)) {
        pick = point
        best = value
        bestSpeed = point.speed
      }
    }
    // The line is lowered until it touches the pick, and drawn as the contour of the score the
    // pick maximises — `intelligence + slope × speed`, at the gradient those two numbers and
    // these axes give it. It used to be turned by the thumb instead, tan(percentage) through the
    // whole quadrant whatever the data said, so the picture showed a steeper line than the pick
    // maximised and the row it appeared to rest on was not the row the router took. Drawn
    // through the pick, at its own angle, it now says exactly which row this percentage selects
    // and why: the higher the percentage, the flatter the score still buys speed.
    const screenSlope = slopeContourScreenSlope(slope, plotH, ySpan, plotW, xSpan)
    // A contour steeper than the box is tall has left the box before moving a pixel sideways;
    // upright through the pick is that same line in the limit.
    const upright = !Number.isFinite(screenSlope) || screenSlope > plotH
    const pickX = pick ? xOf(pick.speed).toFixed(1) : '0'
    const line =
      !ceiling || !pick
        ? ''
        : upright
          ? `<line class="hx-slope-line" x1="${pickX}" y1="${pad.top}" x2="${pickX}" y2="${(pad.top + plotH).toFixed(1)}"/>`
          : (() => {
              const segment = slopeLineSegment(
                xOf(pick.speed),
                yOf(pick.intell),
                screenSlope,
                pad,
                plotW,
                plotH,
              )
              return segment
                ? `<line class="hx-slope-line" x1="${segment.x1.toFixed(1)}" y1="${segment.y1.toFixed(1)}" x2="${segment.x2.toFixed(1)}" y2="${segment.y2.toFixed(1)}"/>`
                : ''
            })()
    // The router plot's dot vocabulary, in miniature: a routable row is a provider-hued disc, a
    // row the router will not use is a smaller mark in the same hue, and the pick wears an accent
    // ring. A row below a minimum keeps its place but fades — it is still on the field, it just
    // cannot win at this setting.
    const dots = points
      .map((point) => {
        const isPick = pick && point === pick
        const clears = pointClearsMinimums(point)
        const offAxis = point.speed > xMax
        const r = isPick ? 3.4 : point.routable ? 2.4 : 1.3
        const cls = [
          'hx-slope-dot',
          isPick ? 'hx-slope-dot-pick' : '',
          point.routable ? '' : 'hx-slope-dot-idle',
          clears ? '' : 'hx-slope-dot-muted',
        ]
          .filter(Boolean)
          .join(' ')
        // Coloured the way the router page's scatter colours its dots — one stable hue per
        // provider — so the two views of the same rows agree dot for dot. The pick keeps the
        // accent and its ring: it is the one thing that answers what this slope does.
        const fill = isPick ? '' : ` style="fill:hsl(${slopePlotHue(point.providerKey)} 62% 58%)"`
        const ring = isPick
          ? `<circle class="hx-slope-ring" cx="${xOf(point.speed).toFixed(1)}" cy="${yOf(point.intell).toFixed(1)}" r="${(r + 3).toFixed(1)}"/>`
          : ''
        // A row past the axis cap is drawn at the edge with an arrow: its position is capped,
        // its speed is not.
        const arrow = offAxis
          ? `<text class="hx-slope-axis" x="${Math.min(xOf(point.speed) + r + 1, pad.left + plotW - 2).toFixed(1)}" y="${(yOf(point.intell) + 3).toFixed(1)}">➤</text>`
          : ''
        return (
          `<circle class="${cls}" cx="${xOf(point.speed).toFixed(1)}" cy="${yOf(point.intell).toFixed(1)}" r="${r}"${fill}>` +
          `<title>${escapeHtml(point.label)} · ${Math.round(point.intell)} intelligence · ${fmtSlopeSpeed(point.speed)} tok/s${clears ? '' : ' · below the minimums'}</title></circle>` +
          ring +
          arrow
        )
      })
      .join('')
    // The extents are kept for the drag handlers: a line being moved has to turn a pixel back
    // into the value it names.
    slopePlotScales = { pad, plotW, plotH, xMin, xMax, xSpan, yMin, yMax, ySpan }
    // The router plot's grid and its tick labels, so the popup's axes say what its dots mean.
    const grid = [0, 1, 2, 3, 4]
      .map((i) => {
        const gx = pad.left + (i / 4) * plotW
        const gy = pad.top + (i / 4) * plotH
        return (
          `<line class="hx-slope-grid" x1="${gx.toFixed(1)}" y1="${pad.top}" x2="${gx.toFixed(1)}" y2="${(pad.top + plotH).toFixed(1)}"/>` +
          `<line class="hx-slope-grid" x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${gy.toFixed(1)}"/>` +
          `<text class="hx-slope-tick" x="${gx.toFixed(1)}" y="${(pad.top + plotH + 11).toFixed(1)}" text-anchor="middle">${fmtSlopeSpeed(xMin + (i / 4) * xSpan)}${offScale > 0 && i === 4 ? ' ➤' : ''}</text>` +
          `<text class="hx-slope-tick" x="${(pad.left - 5).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${fmtSlopeIntell(yMax - (i / 4) * ySpan)}</text>`
        )
      })
      .join('')
    // The two minimums, drawn where the router applies them: on the floor and at the left edge
    // while unset (a faint affordance, no label), wherever they are set once they carry one. The
    // fat transparent twins are the drag targets — a 1px line is not something a hand can catch.
    const minIntellSet = slopeMinima.minIntell != null
    const minIntellValue = minIntellSet ? Math.min(Math.max(slopeMinima.minIntell, yMin), yMax) : yMin
    const minIntellY = yOf(minIntellValue)
    const minSpeedSet = slopeMinima.minSpeed != null
    const minSpeedValue = minSpeedSet ? Math.min(Math.max(slopeMinima.minSpeed, xMin), xMax) : xMin
    const minSpeedX = xOf(minSpeedValue)
    const minima =
      `<line class="hx-slope-min${minIntellSet ? ' is-set' : ''}" x1="${pad.left}" y1="${minIntellY.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${minIntellY.toFixed(1)}"/>` +
      `<line class="hx-slope-min-hit" data-sel-drag="minIntell" x1="${pad.left}" y1="${minIntellY.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${minIntellY.toFixed(1)}"/>` +
      `<line class="hx-slope-min${minSpeedSet ? ' is-set' : ''}" x1="${minSpeedX.toFixed(1)}" y1="${pad.top}" x2="${minSpeedX.toFixed(1)}" y2="${(pad.top + plotH).toFixed(1)}"/>` +
      `<line class="hx-slope-min-hit" data-sel-drag="minSpeed" x1="${minSpeedX.toFixed(1)}" y1="${pad.top}" x2="${minSpeedX.toFixed(1)}" y2="${(pad.top + plotH).toFixed(1)}"/>` +
      (minIntellSet
        ? `<text class="hx-slope-min-label" x="${(pad.left + plotW - 3).toFixed(1)}" y="${Math.min(Math.max(minIntellY - 4, pad.top + 12), pad.top + plotH - 2).toFixed(1)}" text-anchor="end">min ${fmtSlopeIntell(minIntellValue)}</text>`
        : '') +
      (minSpeedSet
        ? `<text class="hx-slope-min-label" x="${Math.min(Math.max(minSpeedX + 3, pad.left + 2), pad.left + plotW - 40).toFixed(1)}" y="${(pad.top + plotH - 5).toFixed(1)}">min ${fmtSlopeSpeed(minSpeedValue)}</text>`
        : '')
    // The router plot's labels, at the popup's scale: the pick always, then the smartest and the
    // fastest, then the rest by height, each dropped rather than allowed to collide with a dot or
    // another label. Hovering still names every row, so a dropped label hides nothing.
    const maxLabels = Math.min(6, points.length)
    const smartest = Math.max(...points.map((point) => point.intell))
    const fastest = Math.max(...points.map((point) => point.speed))
    const rank = (point) =>
      (pick && point === pick ? 1000 : 0) +
      (point.intell >= smartest ? 200 : 0) +
      (point.speed >= fastest ? 200 : 0) +
      (point.routable ? 0 : -400) +
      ((point.intell - yMin) / ySpan) * 100
    const occupied = points.map((point) => ({
      x0: xOf(point.speed) - 4,
      x1: xOf(point.speed) + 4,
      y0: yOf(point.intell) - 4,
      y1: yOf(point.intell) + 4,
    }))
    const collides = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
    const placedLabels = []
    for (const point of points.slice().sort((a, b) => rank(b) - rank(a))) {
      if (placedLabels.length >= maxLabels) break
      const text = point.label.length > 16 ? `${point.label.slice(0, 15)}…` : point.label
      const w = text.length * 4.2
      const cx = xOf(point.speed)
      const cy = yOf(point.intell)
      const rectFor = (right) =>
        right
          ? { x0: cx + 4, x1: cx + 4 + w, y0: cy - 4, y1: cy + 4, right }
          : { x0: cx - 4 - w, x1: cx - 4, y0: cy - 4, y1: cy + 4, right }
      const fits = (rect) =>
        rect.x0 >= pad.left + 1 &&
        rect.x1 <= pad.left + plotW - 1 &&
        !placedLabels.some((placed) => collides(placed.rect, rect)) &&
        !occupied.some((dot) => collides(dot, rect))
      const isPick = pick && point === pick
      let rect = fits(rectFor(true)) ? rectFor(true) : fits(rectFor(false)) ? rectFor(false) : null
      // The pick keeps its name even in a crowded plot: the roomier side, clamped inside the frame.
      if (!rect && isPick) rect = rectFor(cx < pad.left + plotW / 2)
      if (!rect) continue
      placedLabels.push({ rect, text, cx, cy, isPick, right: rect.right })
    }
    const labelMarkup = placedLabels
      .map(
        (label) =>
          `<text class="hx-slope-label${label.isPick ? ' is-pick' : ''}" x="${(label.right ? label.rect.x0 : label.rect.x1).toFixed(1)}" y="${(label.cy + 2.5).toFixed(1)}" text-anchor="${label.right ? 'start' : 'end'}">${escapeHtml(label.text)}</text>`,
      )
      .join('')
    const svg =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Intelligence against speed, smarter upward and faster rightward">` +
      `<defs><clipPath id="hx-slope-clip"><rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/></clipPath></defs>` +
      `<rect class="hx-slope-frame" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/>` +
      grid +
      `<g clip-path="url(#hx-slope-clip)">${line}${dots}${labelMarkup}</g>` +
      minima +
      `</svg>`
    // Neither the pick's name nor its percentage is printed here: the composer bar under the text
    // field names the model, and the readout beside the slider carries the percentage the thumb
    // is on. The one message that stays is the case neither of them can explain.
    const pickNote = pick
      ? ''
      : `<div class="hx-slope-pop-pick">${field.length ? 'nothing clears the minimums' : 'no model the router would use'}</div>`
    const minimums = [
      minSpeedSet ? `min ${fmtSlopeSpeed(minSpeedValue)} tok/s` : '',
      minIntellSet ? `min ${fmtSlopeIntell(minIntellValue)} int` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      svg +
      pickNote +
      (minimums ? `<div class="hx-slope-pop-mins">${escapeHtml(minimums)}</div>` : '') +
      `<div class="hx-slope-pop-hint">drag the edge lines to set minimums</div>`
    )
  }

  /** Draws the popup for a slope. Called on every drag step, so it stays a single write. */
  function renderSlopePlot(percent) {
    const pop = $('hx-slope-pop')
    if (!pop) return
    const value = Number(percent)
    const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 4
    pop.innerHTML = slopePlotMarkup(pct)
  }

  let slopePlotHideTimer = null

  /**
   * Keeps the plot inside the window.
   *
   * The panel is 340px wide and hangs off an 88px slider that sits near the composer's edge, so
   * on a narrow window most of it was past the side of the screen. It slides along its anchor
   * instead: the control's right edge by default, clamped to the viewport on both sides, and
   * narrowed only when the window itself is narrower than the panel.
   */
  function placeSlopePlot() {
    const pop = $('hx-slope-pop')
    const anchor = pop?.parentElement
    if (!pop || pop.hidden || !anchor) return
    const margin = 8
    const available = Math.max(160, window.innerWidth - margin * 2)
    // The panel's own box model is content-box, so a max-width of the viewport would still
    // overflow by its padding and border; the clamp has to be on the box that is drawn.
    pop.style.boxSizing = 'border-box'
    pop.style.maxWidth = `${available}px`
    // A window shorter than the panel scrolls it rather than letting it hang off the bottom.
    pop.style.maxHeight = `${Math.max(120, window.innerHeight - margin * 2)}px`
    pop.style.overflow = 'auto'
    // Measured after the clamp: a panel wider than the window would otherwise be positioned
    // by a width it does not have.
    const width = Math.min(available, pop.offsetWidth || 340)
    const box = anchor.getBoundingClientRect()
    const preferred = box.right - width + 8
    const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin))
    pop.style.left = `${left - box.left}px`
    pop.style.right = 'auto'
    // It opens above the control, which is where the room usually is; a window too short for
    // that opens it below. Either way it is then slid in until both edges are on screen.
    pop.style.top = ''
    pop.style.bottom = ''
    if (box.top - 10 - (pop.offsetHeight || 240) < margin) {
      pop.style.top = 'calc(100% + 10px)'
      pop.style.bottom = 'auto'
    }
    const rect = pop.getBoundingClientRect()
    const overflow =
      rect.top < margin
        ? margin - rect.top
        : rect.bottom > window.innerHeight - margin
          ? window.innerHeight - margin - rect.bottom
          : 0
    if (overflow !== 0) {
      pop.style.top = `${rect.top - box.top + overflow}px`
      pop.style.bottom = 'auto'
    }
  }

  /** Shows the plot while the slider is in hand, with the value it currently holds. */
  function showSlopePlot(percent) {
    const pop = $('hx-slope-pop')
    if (!pop) return
    if (slopePlotHideTimer) {
      clearTimeout(slopePlotHideTimer)
      slopePlotHideTimer = null
    }
    renderSlopePlot(percent)
    pop.hidden = false
    placeSlopePlot()
  }

  /** Folds it away. A delay keeps the last frame legible after the thumb is let go. */
  function hideSlopePlot(delayMs = 0) {
    const pop = $('hx-slope-pop')
    if (!pop) return
    if (slopePlotHideTimer) clearTimeout(slopePlotHideTimer)
    const hide = () => {
      slopePlotHideTimer = null
      if (pop) pop.hidden = true
    }
    if (delayMs > 0) slopePlotHideTimer = setTimeout(hide, delayMs)
    else hide()
  }

  /** Turns a pointer position inside the plot back into the minimum the line sits at. */
  function applySlopeMinimaDrag(event) {
    const svg = $('hx-slope-pop')?.querySelector('svg')
    const scales = slopePlotScales
    if (!svg || !scales) return
    let point = null
    try {
      const ctm = svg.getScreenCTM?.()
      if (ctm) point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    } catch {
      point = null
    }
    if (!point) return
    if (slopeMinimaDrag === 'minSpeed') {
      const ratio = (point.x - scales.pad.left) / scales.plotW
      // Past the edge of the plot is the way back to "no minimum": an unset line rests on the
      // axis, so dragging it off the axis clears it rather than pinning a floor at zero.
      slopeMinima.minSpeed =
        ratio <= 0.005 ? null : Math.max(0, Math.round((scales.xMin + ratio * scales.xSpan) * 10) / 10)
    } else {
      const ratio = (scales.pad.top + scales.plotH - point.y) / scales.plotH
      slopeMinima.minIntell =
        ratio <= 0.005 ? null : Math.max(0, Math.round((scales.yMin + ratio * scales.ySpan) * 10) / 10)
    }
    renderSlopePlot(Number($('hx-slope-slider')?.value ?? 4))
  }

  /**
   * Saves the minimums on the router, which owns them: they describe the field the line chooses
   * from, not one conversation. `slope` is deliberately not sent — the popup never read the
   * router page's slider, and posting one would overwrite a setting the user did not touch.
   */
  function saveSlopeMinima() {
    if (slopeMinimaSaveTimer) clearTimeout(slopeMinimaSaveTimer)
    slopeMinimaSaveTimer = setTimeout(async () => {
      slopeMinimaSaveTimer = null
      try {
        const res = await fetch('/api/selector', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            minSpeed: slopeMinima.minSpeed,
            minIntell: slopeMinima.minIntell,
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || 'Could not save the minimums (' + res.status + ').')
        }
        // The table's lit row is the router's pick at these minimums, so re-read it.
        void loadKnownTtfts()
      } catch (err) {
        setHint((err && err.message) || 'Could not save the minimums.', 'error', active())
      }
    }, 250)
  }

  /** Reads the minimums the router already applies, so the lines start where routing is. */
  async function loadSlopeMinima() {
    try {
      const res = await fetch('/api/selector')
      if (!res.ok) return
      const sel = await res.json()
      const num = (value) => {
        const n = Number(value)
        return value != null && Number.isFinite(n) && n >= 0 ? n : null
      }
      slopeMinima = { minSpeed: num(sel.minSpeed), minIntell: num(sel.minIntell) }
      if (!$('hx-slope-pop')?.hidden) renderSlopePlot(Number($('hx-slope-slider')?.value ?? 4))
    } catch {
      // The field still draws without them; the lines simply rest on their axes.
    }
  }

  let slopeSaveTimer = null
  /** A save in flight, and the newest slope that arrived while it was. */
  let slopeSaveInFlight = false
  let slopeSavePending = null
  /**
   * How long a drag may go unsaved. The strip and the rail name the model the router has picked,
   * so a drag that crosses a handoff has to be named while it crosses it; a request per pixel
   * would be one per frame, and a single trailing timer named nothing until the thumb stopped.
   */
  const SLOPE_SAVE_INTERVAL_MS = 90

  /**
   * Saves the slope at most one request at a time: whatever the thumb reached while a save was in
   * flight goes out as soon as it returns, so the last position always wins.
   */
  function saveSlopeSoon(percent) {
    if (slopeSaveInFlight) {
      slopeSavePending = percent
      return
    }
    if (slopeSaveTimer) clearTimeout(slopeSaveTimer)
    slopeSaveTimer = setTimeout(() => {
      slopeSaveTimer = null
      if (slopeSaveInFlight) {
        slopeSavePending = percent
        return
      }
      slopeSaveInFlight = true
      void setSlopePercent(percent).finally(() => {
        slopeSaveInFlight = false
        const next = slopeSavePending
        slopeSavePending = null
        if (next != null) saveSlopeSoon(next)
      })
    }, SLOPE_SAVE_INTERVAL_MS)
  }

  /** Saves the slider's slope for this conversation; the router uses it on the next turn. */
  async function setSlopePercent(percent) {
    const ctx = active()
    if (!ctx) return
    const slider = $('hx-slope-slider')
    try {
      const res = await fetch(consoleApi(ctx, '/slope'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not change the slope (' + res.status + ').')
      // A save the thumb has already left must not pull the slider back to where it was: while a
      // drag is running, answers arrive for positions it has long passed. The new pick below is
      // still painted — a later save supersedes it within a frame or two of the thumb.
      if (!slider || Number(slider.value) === Number(percent)) paintSlopePercent(data.percent)
      // The slope *is* a model choice the user just made, so the strip names the new pick now.
      // Waiting for the status round trip left it showing the previous model — and waiting for
      // an answer left it there until the next message, which is the failure this fixes. The
      // answer the readout preferred is about the model this conversation was on until this
      // moment, so the user's own choice supersedes it.
      if (data.routedModel) {
        const key = routedModelKey(data.routedModel)
        const changed = key !== ctx.routedModelKey
        ctx.routedModel = data.routedModel
        ctx.routedModelKey = key
        // Whether or not the pick moved: the user has just chosen the model dimension, so the
        // last answer no longer speaks for the strip or the rail. Clearing it only on a changed
        // key left both naming the answered model for as long as the router resolved a new
        // slope to the same pick — which is most of the slider — until the next answer arrived.
        ctx.answeredModel = null
        quotaMissLookup = { key: null, at: 0 }
        if (ctx === active()) {
          paintModelLabel(ctx, ctx.status?.model)
          renderQuota(ctx)
        }
        if (changed && Date.now() - ttftForcedAt > 5_000) {
          ttftForcedAt = Date.now()
          void loadKnownTtfts({ force: true }).then(() => {
            if (ctx === active()) renderQuota(ctx)
          })
        }
      }
      // The models table now lights one row per conversation, so its pick is stale after this.
      refreshStatus(ctx).catch(() => {})
    } catch (err) {
      setHint((err && err.message) || 'Could not change the slope.', 'error', ctx)
    }
  }

  function slopeFromSlider() {
    const slider = $('hx-slope-slider')
    if (!slider) return
    paintSlopePercent(Number(slider.value))
    // The plot follows the thumb, not the saved value: a drag crosses dozens of slopes and the
    // one under the thumb is the one being read.
    if (!$('hx-slope-pop')?.hidden) renderSlopePlot(Number(slider.value))
    // A drag crosses dozens of values; coalescing sends the position it has reached every few
    // frames instead of one request per input — or one after it stops.
    saveSlopeSoon(Number(slider.value))
  }

  /**
   * One console's turn state. The sidebar is drawn from every console, not only this one, so a
   * background conversation turns its own spinner whether or not it is on screen.
   */
  function setRunning(running, ctx = active()) {
    const changed = ctx.running !== Boolean(running)
    ctx.running = Boolean(running)
    // The gap the badge marks exists only while a run is live, so it turns with the run.
    syncWaitBadge(ctx)
    if (ctx === active()) {
      state.running = ctx.running
      updateComposer()
    }
    if (changed) {
      // Nothing executes while no turn does, so a status frame that says idle is the authority
      // on rows whose end the page never saw — a dead child, or a stop the stream did not report.
      if (!ctx.running) settleOpenTools(ctx)
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
      // A turn that is reported as running is watched: if it never says anything, its flag is
      // the only thing keeping the transcript from being rebuilt from the file.
      if (ctx.running) watchStalledHistory(ctx)
      else if (ctx.stallTimer) {
        clearTimeout(ctx.stallTimer)
        ctx.stallTimer = null
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
   * The row being edited, if one is: `{ ctx, index, text }`. It exists so an incoming
   * `queue_update` cannot repaint the strip out from under an open field.
   */
  let queueEditing = null

  /**
   * Adopts a queue snapshot for one conversation. Pi's `queue_update` event (and the counts
   * `get_state` carries) are the only authoritative source — a message the agent already
   * consumed leaves the queue by an event, not by anything this page could infer.
   */
  function applyQueue(steering, followUp, ctx = active()) {
    if (!ctx) return
    ctx.queuedSteering = Array.isArray(steering) ? steering.map(String) : []
    ctx.queuedFollowUp = Array.isArray(followUp) ? followUp.map(String) : []
    // An editor belongs to the row it opened on. If that row moved or is gone — Pi consumed it, or
    // another tab rewrote the queue — the field is editing nothing, so it closes rather than
    // saving its text onto whichever message took the position.
    if (
      queueEditing &&
      (queueEditing.ctx !== ctx || queueItems(ctx)[queueEditing.index]?.text !== queueEditing.text)
    ) {
      queueEditing = null
    }
    renderQueue(ctx)
  }

  /** The queue as one list: steering first, then the follow-ups, in Pi's own order. */
  function queueItems(ctx = active()) {
    if (!ctx) return []
    return [
      ...ctx.queuedSteering.map((text) => ({ text, mode: 'steer' })),
      ...ctx.queuedFollowUp.map((text) => ({ text, mode: 'followUp' })),
    ]
  }

  /** Draws the queue strip between transcript and composer, and the button's queued count. */
  function renderQueue(ctx = active()) {
    if (!ctx || ctx !== active()) return
    // An open editor owns its row: a `queue_update` arriving mid-edit must not wipe the field out
    // from under the caret. Saving or cancelling repaints from state.
    if (queueEditing && queueEditing.ctx === ctx) return
    const wrap = $('hx-queue')
    const list = $('hx-queue-list')
    const items = queueItems(ctx)
    if (wrap) wrap.hidden = items.length === 0
    const count = $('hx-queue-count')
    if (count) count.textContent = String(items.length)
    if (list) {
      // A move stays inside its own list (see the /queue route), so the ends of that list are what
      // the arrows report as unavailable rather than the ends of the whole strip.
      const firstOf = (mode) => items.findIndex((item) => item.mode === mode)
      const lastOf = (mode) => items.map((item) => item.mode).lastIndexOf(mode)
      list.innerHTML = items
        .map((item, index) => {
          const atTop = index === firstOf(item.mode)
          const atBottom = index === lastOf(item.mode)
          return [
            `<li data-queue-mode="${item.mode}" data-queue-index="${index}">`,
            `<span>${escapeHtml(clip(item.text, 200))}</span>`,
            `<b>${item.mode === 'followUp' ? 'next turn' : 'this turn'}</b>`,
            '<span class="hx-queue-actions">',
            `<button type="button" class="hx-queue-act" data-queue-act="up" title="Move earlier" aria-label="Move this message earlier"${atTop ? ' disabled' : ''}>↑</button>`,
            `<button type="button" class="hx-queue-act" data-queue-act="down" title="Move later" aria-label="Move this message later"${atBottom ? ' disabled' : ''}>↓</button>`,
            '<button type="button" class="hx-queue-act" data-queue-act="edit" title="Edit this message" aria-label="Edit this message">✎</button>',
            '<button type="button" class="hx-queue-act" data-queue-act="remove" title="Remove this message" aria-label="Remove this message">×</button>',
            '</span>',
            '</li>',
          ].join('')
        })
        .join('')
    }
  }

  /**
   * Turns one queued row into a field in place, so an edit never moves the message elsewhere.
   * Enter saves; Escape or leaving the field cancels. Either way the strip is repainted from the
   * queue the agent reports, which is the only copy that matters.
   */
  function beginQueueEdit(ctx, index) {
    const item = queueItems(ctx)[index]
    const row = $('hx-queue-list')?.querySelector(`li[data-queue-index="${index}"]`)
    const span = row?.querySelector('span')
    if (!ctx || !item || !row || !span) return
    queueEditing = { ctx, index, text: item.text }
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hx-queue-edit'
    input.value = item.text
    input.setAttribute('aria-label', 'Edit queued message')
    span.replaceWith(input)
    input.focus()
    input.select()
    let settled = false
    const finish = (save) => {
      if (settled) return
      settled = true
      // The queue is a row per message, and Pi's `queue_update` carries plain text: a line break
      // here would arrive as text the sender cannot see, so it collapses to one line.
      const text = input.value.replace(/\s+/g, ' ').trim()
      queueEditing = null
      renderQueue(ctx)
      if (save && text && text !== item.text) void changeQueue('edit', index, { message: text })
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(false))
  }

  /**
   * Sends one queue change and adopts the queue that comes back.
   *
   * The operation and the position travel with the text the page was showing: the server checks
   * that text against what the agent holds, so a click that raced a `queue_update` is refused and
   * repainted instead of changing the wrong message.
   */
  async function changeQueue(op, index, extra = {}) {
    const ctx = active()
    const item = queueItems(ctx)[index]
    if (!ctx || !item) return
    try {
      const res = await fetch(consoleApi(ctx, '/queue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, index, text: item.text, ...extra }),
      })
      const data = await res.json().catch(() => ({}))
      if (Array.isArray(data.steering) || Array.isArray(data.followUp)) {
        applyQueue(data.steering, data.followUp, ctx)
      }
      if (!res.ok) {
        throw new Error(data.error || `The agent refused the queue change (${res.status}).`)
      }
    } catch (err) {
      setHint(err?.message || 'Could not change the queue.', 'error', ctx)
    }
  }

  function routedModelKey(model) {
    return model
      ? [model.providerKey, model.realModelId, model.modelId, model.label].join('\u0000')
      : ''
  }

  /** Paints the composer's model strip from the newest answer, or the router's current pick. */
  function paintModelLabel(ctx, statusModel) {
    const nameEl = $('hx-model-name')
    const providerEl = $('hx-model-provider')
    const viaEl = $('hx-model-via')
    if (!nameEl) return
    const routed = ctx.routedModel
    const answered = ctx.answeredModel
    const routedNames = routed
      ? [routed.modelId, routed.label, routed.realModelId, routed.realModelLabel].filter(Boolean)
      : []
    const shared = answered && routedNames.includes(answered) ? routed : null
    const answeredLabel = answered
      ? printableModelName(shared ? shared.label || shared.modelId : answered)
      : ''
    const routedLabel = routed ? printableModelName(routed.label || routed.modelId) : ''
    nameEl.textContent = answeredLabel
      ? [answeredLabel, shared ? shared.providerName : ''].filter(Boolean).join(' · ')
      : routedLabel
        ? [routedLabel, routed.providerName].filter(Boolean).join(' · ')
        : statusModel && !isRouterAlias(statusModel)
          ? printableModelName(statusModel.name || statusModel.id || 'unknown')
          : 'no model yet'
    // "GLM 5.3 Flash · NVIDIA" already names the provider, so the separate "via" line goes.
    if (viaEl) viaEl.hidden = Boolean(answered || routed)
    if (providerEl) providerEl.textContent = statusModel ? statusModel.provider || 'provider' : '—'
  }

  /** The newest answer is the composer's immediate truth; it outranks a stale status route. */
  function noteAnsweredModel(ctx, model) {
    if (!ctx || !model) return
    ctx.answeredModel = model
    if (ctx === active()) {
      paintModelLabel(ctx, ctx.status?.model)
      // The rail's bars belong to the model that answered, so a fallback that just served this
      // turn has to move them now — not at the next status frame, which keeps the pick.
      renderQuota(ctx)
    }
  }

  function renderRouting(data, ctx = active()) {
    if (!data || ctx !== active()) return
    const model = data.model
    const badgeEl = $('hx-routed-badge')
    // Pi calls its alias "Hammer's selected model", which names the mechanism rather than the
    // model doing the answering. The router's pick — model and the provider offering it — is what
    // the strip shows; the alias stands in only when nothing is routed at all.
    // The route's identity, not just its presence: every status frame repeats the same pick,
    // and only a real change should drop the last answer's label.
    if (data.routedModel) {
      const key = routedModelKey(data.routedModel)
      if (ctx.routedModelKey && key !== ctx.routedModelKey) {
        ctx.answeredModel = null
        // A new route is a new set of limits. The cached table is up to a minute old and may
        // not list the new row at all, so it is re-read now rather than at the next expiry:
        // until it answers, the rail must not keep the previous model's windows on screen.
        quotaMissLookup = { key: null, at: 0 }
        void loadKnownTtfts({ force: true }).then(() => {
          if (ctx === active()) renderQuota(ctx)
        })
      }
      ctx.routedModel = data.routedModel
      ctx.routedModelKey = key
    }
    paintModelLabel(ctx, model)
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
    // The route names the steps its model takes; the control follows that, not a fixed four.
    paintThinking(data.thinking, data.thinkingLevel || 'off')
    if (data.slopePercent != null) paintSlopePercent(data.slopePercent)
    paintSlopeNotches()
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
    // A route can move without a usage frame (a fresh status after a restart), so paint the
    // quota meter from the route itself as well as from renderUsage.
    renderQuota(ctx)
  }

  /** The routed row's own context window — the number the models table shows for it. */
  function routedContextWindow(ctx) {
    const routed = ctx?.routedModel
    if (!routed) return 0
    // The router already resolved this pick's bound (catalog window, tightened by anything a
    // provider has stated in a refusal). That is exactly what the table's context column
    // derives, so reading it here is what keeps the two figures the same number.
    const resolved = Number(routed.contextTokens)
    if (Number.isFinite(resolved) && resolved > 0) return Math.round(resolved)
    const row = quotaRowByModel.get(`${routed.providerKey}::${routed.modelId}`)
    // Prefer a real upper bound from the table. A row learned only from successful prompts
    // can show ">2.3k": that is a lower bound, and using it as the denominator turned a
    // 39k context into "100% of 2.3k".
    const max = Number(row?.contextBound?.max)
    if (Number.isFinite(max) && max > 0) return Math.round(max)
    const label = String(row?.context || '')
    // A bound such as ">238k" is not a denominator. An exact table figure is the fallback
    // for a page that has the routed pick but no resolved bound on it.
    if (!label || /[<>≤≥]/.test(label)) return 0
    const known = Number(row?.contextTokens)
    if (Number.isFinite(known) && known > 0) return Math.round(known)
    const match = label.replace(/,/g, '').match(/([\d.]+)\s*([kKmM])?/)
    const value = Number(match?.[1])
    if (!Number.isFinite(value) || value <= 0) return 0
    const unit = String(match?.[2] || '').toLowerCase()
    return Math.round(value * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1))
  }

  /**
   * Whether the routed row's window is an exact statement rather than a floor.
   *
   * "At least 131k" is not a denominator. The models table prints such a bound as `>131k`, and
   * drawing its context against that figure is what made the meter read
   * `100% · 233k of 131k · 0 free` for a conversation the model was comfortably holding. The
   * meter asks the same two sources the table does: the pick's own lower-bound flag, and the
   * label the row's context column prints.
   */
  /**
   * Whether the routed window is a prompt cap rather than a context window.
   *
   * OrcaRouter's free tiers refuse a request whose *prompt* is too long, and the bound Hammer
   * learns from that refusal caps the prompt — it does not describe the whole context, which is
   * the prompt plus the reply Pi reports. Comparing the two as if they were the same quantity
   * drew a working conversation as "over window" by exactly the reply's length.
   */
  function routedPromptCap(ctx) {
    return ctx?.routedModel?.contextPromptCap === true
  }

  function routedContextWindowExact(ctx) {
    const routed = ctx?.routedModel
    if (!routed) return false
    if (routed.contextLowerBoundOnly === true) return false
    const row = quotaRowByModel.get(`${routed.providerKey}::${routed.modelId}`)
    // No row yet: the pick's resolved figure is a catalog/provider window, which is an upper
    // bound and can be drawn against. A catalog window is not "exact" in the learned-bound
    // sense (`contextExact`), but it is not a floor either — only a leading `>` is, and that is
    // the label the table prints for "at least this much" (see deriveContextState).
    if (!row) return true
    return !String(row.context || '').startsWith('>')
  }

  function renderUsage(ctx = active()) {
    if (ctx !== active()) return
    const usage = state.usage
    const el = $('hx-usage-text')
    const bar = $('hx-context-bar')
    if (!el) return
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
    // The same rounding everywhere a token figure is shown. The compaction row calls it through
    // the window object, which is the only place a classic script can share a helper between
    // two function scopes without a build step.
    window.hxCompact = compact
    const fallbackWindow = routedContextWindow(ctx)
    const fallbackExact = routedContextWindowExact(ctx)
    const fallbackPromptCap = routedPromptCap(ctx)
    if (!usage) {
      el.textContent = 'No tokens reported yet'
      // A fresh console can still know the context ceiling from its routed row. Painting the
      // meter here keeps the bar honest ("not measured") instead of clearing a useful limit.
      renderContext(bar, {}, compact, fallbackWindow, fallbackExact, fallbackPromptCap)
      renderQuota(ctx)
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
      // row of zeros that reads like the reporting is broken. Its context figure may still
      // be the only thing Pi has measured, so paint that before returning.
      el.textContent = 'No tokens reported yet'
      renderContext(bar, usage, compact, fallbackWindow, fallbackExact, fallbackPromptCap)
      renderQuota(ctx)
      return
    }
    const parts = []
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
    // The meter is drawn against the model's own window, not against the turn's spend: only
    // the window says how close compaction is. Both figures come from the frame.
    renderContext(bar, usage, compact, fallbackWindow, fallbackExact, fallbackPromptCap)
    // Quota is about the routed row, not this conversation. Paint it from the same table the
    // router uses, and refresh that table when its cache has aged out.
    renderQuota(ctx)
    void loadKnownTtfts().then(() => {
      if (ctx === active()) renderQuota(ctx)
    })
  }

  /**
   * The context meter.
   *
   * Drawn against pi's own context window — the number that decides compaction — rather than
   * against the turn's tokens. The turn total is a spending report; the window is a limit,
   * and only the limit can show a reader that compaction is about to happen.
   *
   * Pi reports three states and each is answered differently, because a bar drawn from a
   * number pi would not vouch for is a bar that lies:
   *   - `{tokens, contextWindow}` — the real meter, with pi's own trigger marked on it.
   *   - `{tokens: null, contextWindow}` — pi cannot measure yet (no post-compaction usage);
   *     it says so rather than guessing a magnitude.
   *   - absent — a pi too old to compute anything; the older turn-share bar stays, labelled.
   * @param {HTMLElement|null} bar
   * @param {any} usage
   * @param {(n: number) => string} compact
   * @param {number} [fallbackWindow] the routed row's published window, when it is exact
   */
  /**
   * A token count in the meter's own units, rounded down.
   *
   * The remainder a full window leaves must never round up to the whole window: "349 of
   * 262k · 262k free" reads as both nothing spent and 349 tokens spent. Truncating is the
   * honest direction for room that is left.
   * @param {number} n
   */
  function compactFloor(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return String(n)
    if (v >= 1e9) { const u = v / 1e9; return `${u >= 10 ? Math.floor(u) : Math.floor(u * 10) / 10}B` }
    if (v >= 1e6) { const u = v / 1e6; return `${u >= 10 ? Math.floor(u) : Math.floor(u * 10) / 10}M` }
    if (v >= 1e3) { const u = v / 1e3; return `${u >= 10 ? Math.floor(u) : Math.floor(u * 10) / 10}k` }
    return String(Math.floor(v))
  }

  function setContextValue(text) {
    const el = $('hx-context-value')
    if (el) el.textContent = text
  }

  function renderContext(bar, usage, compact, fallbackWindow = 0, windowExact = true, promptCap = false) {
    const note = $('hx-context-note')
    const compactsAt = $('hx-context-compacts')
    const fill = bar?.firstElementChild || null
    // `contextUsage` is pi's figure (it may also ride along on a live usage frame);
    // `usage.contextWindow` is the flat estimate a bare per-message count would give.
    const context = usage.contextUsage || null
    // The model's own window is the limit the models table reports for the routed row, and it
    // is what the router compacts against (see lib/pi/bridge.js). Pi's `contextUsage` window
    // records what the bridge measured against at the last message, so it can still name the
    // previous model after a fallback; keep it only for a route with no bound.
    const measuredWindow = Number(context?.contextWindow) || Number(usage.contextWindow) || 0
    const routedWindow = Number(fallbackWindow) || 0
    const window_ = routedWindow || measuredWindow
    if (window_ <= 0) {
      // No window declared: the turn-share bar, kept and labelled for what it actually is.
      if (bar) {
        bar.classList.remove('is-context', 'is-full')
        bar.setAttribute('aria-valuenow', '0')
        bar.removeAttribute('aria-valuetext')
        bar.style.removeProperty('--hx-context-trigger')
        const spent = Number(usage.totalTokens ?? usage.tokens) || 0
        const contextTokens = Number(usage.contextTokens ?? usage.context) || 0
        if (fill) {
          fill.style.width = `${spent > 0 ? Math.min(100, Math.round((contextTokens / spent) * 100)) : 0}%`
        }
      }
      setContextValue('—')
      if (note) {
        note.hidden = true
        note.textContent = ''
      }
      if (compactsAt) {
        compactsAt.hidden = true
        compactsAt.textContent = ''
        compactsAt.removeAttribute('title')
      }
      return
    }
    const used = Number(context?.tokens)
    const measured = Number.isFinite(used) && used >= 0
    // A live tally is an estimate from the text streamed so far, and it says so: a figure the
    // bridge guessed must not read like one Pi vouched for.
    const estimated = context?.estimated === true
    // Pi reserves room for the reply: it compacts at `window - reserve`, which is why a
    // meter filled to 100% is a meter that has already compacted. The server publishes the
    // reserve actually in force, because a small routed window or a prompt-cap bound changes
    // it. The launch setting is only a fallback for an older status payload.
    const status = active()?.status || state.status
    const publishedReserve = Number(status?.compactionReserve)
    const configuredReserve = Number(status?.compactionReserveTokens)
    const RESERVE =
      Number.isFinite(publishedReserve) && publishedReserve > 0
        ? publishedReserve
        : Number.isFinite(configuredReserve) && configuredReserve > 0
          ? configuredReserve
          : 16384
    // Auto-compaction switched off is a wall Pi will walk straight past, so the meter must not
    // draw a trigger for it. `null` is Pi not reporting the switch, which is not off.
    const autoCompactionOff = status?.autoCompactionEnabled === false
    // Where the bridge actually compacts: against the routed window it reports now. Do not
    // min this with `measuredWindow`; after a fallback that figure can be the previous model's
    // window, which drew a 24k trigger under a 262k meter.
    const ceiling = window_
    const trigger = Math.max(0, ceiling - RESERVE)
    // A threshold is a fact about the window, not about this turn's usage: it can be shown
    // before Pi has measured anything. With auto-compaction off there is no wall to describe,
    // so the line stays hidden, matching the trigger tick's own rule.
    if (compactsAt) {
      const show = !autoCompactionOff && trigger > 0
      compactsAt.hidden = !show
      compactsAt.textContent = show ? `Compacts at ${compact(trigger)} tokens` : ''
      if (show) {
        compactsAt.title = `Pi compacts when the context passes ${Math.round(trigger).toLocaleString()} tokens (${Math.round(ceiling).toLocaleString()} window minus ${Math.round(RESERVE).toLocaleString()} reserved for the reply).`
      } else {
        compactsAt.removeAttribute('title')
      }
    }
    const pct = measured ? Math.max(0, Math.min(100, (used / window_) * 100)) : null
    // A conversation already larger than the window it is drawn against has no true share:
    // either the window is a floor the model has outgrown, or a streamed estimate overshot it.
    // "100% · 233k of 131k · 0 free" is the reading that looked wrong, because none of those
    // three numbers is a real measurement once the first is past the second.
    // A prompt cap bounds the prompt, never the context: a full conversation sits above a cap
    // it has not violated, so there is no overrun to report.
    const over = measured && !promptCap && used > window_
    const shareKnown = windowExact && !over
    if (bar) {
      bar.classList.add('is-context')
      bar.classList.toggle('is-full', pct != null && pct >= 95)
      bar.classList.toggle('is-over', over)
      bar.setAttribute('aria-valuenow', pct != null ? String(Math.round(pct)) : '')
      bar.setAttribute(
        'aria-valuetext',
        pct == null
          ? 'context not measured'
          : promptCap
            ? `${compact(used)} tokens in context, prompt cap ${compact(window_)}`
            : !windowExact
              ? `${compact(used)} tokens in context, window at least ${compact(window_)}`
              : over
              ? `${compact(used)} tokens in context, past a window of ${compact(window_)}`
              : `${compact(used)} of ${compact(window_)} tokens`,
      )
      // The trigger tick sits at the share of the window pi holds back for its reply.
      if (autoCompactionOff) bar.style.removeProperty('--hx-context-trigger')
      else bar.style.setProperty('--hx-context-trigger', `${(trigger / window_) * 100}%`)
      if (fill) fill.style.width = pct != null ? `${pct}%` : '0%'
    }
    // Half a percent of a large window is still tokens in the context, so a measured sliver
    // says "<1%" rather than "0%" — the rounding is this page's, not Pi's.
    let share = pct == null ? 'not measured' : pct > 0 && pct < 0.5 ? '<1%' : `${Math.round(pct)}%`
    if (promptCap && pct != null) {
      // The share is of the prompt cap, and a context that is past it is not a violation: the
      // cap fills up, and the note names the figure it would have to be compared with.
      share = `${Math.min(100, Math.round(pct))}%`
    } else if (pct != null && !shareKnown) {
      // Neither state gives a true percentage. A floor is exceeded by an unknown amount, so the
      // share is only a lower bound; an overrun is past the whole window, so "100%" would claim
      // exactly full. The tokens are measured in both, and the note names the window.
      share = !windowExact
        ? over
          ? `>${compact(window_)}`
          : pct >= 1
            ? `\u2265${Math.round(pct)}%`
            : // A sliver of a floor is still a sliver: "≥0%" would claim a bound on
              // nothing, so the plain reading stands.
              share
        : 'over window'
    } else if (estimated && pct != null && pct >= 0.5) {
      share = `~${share}`
    }
    setContextValue(share)
    if (note) {
      note.hidden = false
      const approx = estimated ? '~' : ''
      if (!measured) {
        // Pi's own answer to "how full is it": it cannot tell until a model answers again.
        note.textContent = `context not measured · window ${compact(window_)}`
      } else if (!windowExact) {
        // The window is a floor, so the free space against it is not knowable; the tokens in the
        // context are. This is the case the meter used to draw as a full bar with "0 free".
        note.textContent = `${approx}${compact(used)} in context · window at least ${compact(window_)}`
      } else if (promptCap) {
        note.textContent = `${approx}${compact(used)} in context · prompt caps at ${compact(window_)}`
      } else if (over) {
        note.textContent = `${approx}${compact(used)} of ${compact(window_)} · ${compactFloor(used - window_)} over`
      } else if (estimated) {
        note.textContent = `~${compact(used)} of ${compact(window_)} · estimating while it answers`
      } else {
        const left = Math.max(0, window_ - used)
        note.textContent = `${compact(used)} of ${compact(window_)} · ${compactFloor(left)} free`
      }
    }
  }

  // ── Quota meter ───────────────────────────────────────────────────────────────────
  //
  // The row in the Router table already answers "what allowance does this model have?" by
  // merging published limits, provider usage, response headers and observed quota refusals.
  // The rail asks the same question about the one row the agent is on, so it reads the same
  // fields from /api/models and keeps the table's vocabulary rather than inventing a second
  // quota model. The formatting is narrower, but the numbers are the row's own.

  const RAIL_QUOTA_PERIOD_LABEL = {
    minute: 'MINUTE',
    hour: 'HOUR',
    day: 'DAY',
    week: 'WEEK',
    month: 'MONTH',
    lifetime: 'ONE-OFF',
    rolling: 'ROLLING',
    window: 'WINDOW',
  }
  const RAIL_QUOTA_RECORDED_FIELD = {
    tokens: {
      minute: 'tokensLastMinute',
      hour: 'tokensLastHour',
      day: 'tokensToday',
      week: 'tokensThisWeek',
      month: 'tokensThisMonth',
      lifetime: 'tokensLifetime',
    },
    requests: {
      minute: 'requestsLastMinute',
      hour: 'requestsLastHour',
      day: 'requestsToday',
      week: 'requestsThisWeek',
      month: 'requestsThisMonth',
    },
  }
  const RAIL_QUOTA_PERIOD_ORDER = {
    minute: 0,
    hour: 0.5,
    day: 1,
    week: 2,
    month: 3,
    lifetime: 4,
    rolling: 5,
    window: 6,
  }
  const RAIL_QUOTA_METRIC_ORDER = { requests: 0, tokens: 1, credits: 2 }

  function railQuotaPeriod(value) {
    const text = String(value || '').toLowerCase()
    if (/\bminute\b|per\s*minute|\brpm\b/.test(text)) return 'minute'
    if (/\bday\b|daily|24\s*hour|rolling\s*24/.test(text)) return 'day'
    if (/\bhour\b|hourly|per\s*hour/.test(text)) return 'hour'
    if (/\bweek\b|weekly|7\s*day/.test(text)) return 'week'
    if (/\bmonth\b|monthly|30\s*day/.test(text)) return 'month'
    if (/lifetime|one[- ]?off|one[- ]?time|signup/.test(text)) return 'lifetime'
    if (/rolling/.test(text)) return 'rolling'
    return 'window'
  }

  function railQuotaPeriodLabel(period, rawWindow) {
    return (
      RAIL_QUOTA_PERIOD_LABEL[period] ||
      (rawWindow ? String(rawWindow).toUpperCase() : 'WINDOW')
    )
  }

  // A cap a response states is not automatically a throttle. g4f answers with 500 requests and
  // 5M tokens that reopen the next day: an allowance, not a burst, and it belongs in Quota
  // rather than Rate limit. The reset clock the response carried is the only evidence of the
  // window, so the period is read off it — and a cap with no clock is capacity, because
  // nothing about it says it reopens within the hour.
  function railQuotaLimitPeriod(resetAt, now = Date.now()) {
    const at = Number(resetAt)
    if (!Number.isFinite(at) || at <= 0) return 'window'
    const left = at - now
    if (left <= 5 * 60_000) return 'minute'
    if (left <= 6 * 3_600_000) return 'hour'
    if (left <= 36 * 3_600_000) return 'day'
    if (left <= 10.5 * 86_400_000) return 'week'
    return 'month'
  }

  function railQuotaResetAt(period) {
    if (period === 'day') {
      const d = new Date()
      d.setUTCHours(24, 0, 0, 0)
      return d.getTime()
    }
    if (period === 'week') {
      const d = new Date()
      const weekday = d.getUTCDay() || 7
      d.setUTCDate(d.getUTCDate() + 8 - weekday)
      d.setUTCHours(0, 0, 0, 0)
      return d.getTime()
    }
    if (period === 'month') {
      const d = new Date()
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime()
    }
    return null
  }

  function railQuotaResetText(ms) {
    const raw = Number(ms)
    if (!Number.isFinite(raw) || raw <= 0) return ''
    const total = Math.max(1, Math.floor(raw / 1000))
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m`
    return `${total}s`
  }

  function railQuotaPercentText(raw) {
    if (raw == null || !Number.isFinite(raw)) return 'not reported'
    if (raw > 0 && raw < 0.01) return '<0.01'
    if (raw < 10) return raw.toFixed(2)
    if (raw < 100) return raw.toFixed(1)
    return Math.round(raw).toLocaleString()
  }

  function railQuotaCompact(n) {
    return typeof window.hxCompact === 'function' ? window.hxCompact(n) : String(n)
  }

  function railQuotaWindow({
    period,
    metric = 'tokens',
    rawWindow,
    used,
    total,
    remaining,
    resetAt,
    detail,
    stale,
    unavailable,
    usedPercent,
    percentOnly,
    estimated,
    kind,
  }) {
    const normalizedMetric =
      metric === 'requests' ? 'requests' : metric === 'credits' ? 'credits' : 'tokens'
    let totalValue = total == null ? null : Number(total)
    let remainingValue = remaining == null ? null : Number(remaining)
    let usedValue = used == null ? null : Number(used)
    let usedPercentValue = usedPercent == null ? null : Number(usedPercent)
    if (!Number.isFinite(totalValue) || totalValue < 0) totalValue = null
    if (!Number.isFinite(remainingValue)) remainingValue = null
    if (!Number.isFinite(usedValue)) usedValue = null
    if (!Number.isFinite(usedPercentValue) || usedPercentValue < 0) usedPercentValue = null
    if (usedPercentValue != null) usedPercentValue = Math.min(100, usedPercentValue)
    const isPercentOnly = Boolean(percentOnly) || (totalValue == null && usedPercentValue != null)
    const zeroLimit = totalValue === 0 || Boolean(unavailable)
    if (zeroLimit) {
      usedValue = 0
      remainingValue = 0
    }
    if (usedValue == null && totalValue != null && totalValue > 0 && remainingValue != null) {
      usedValue = Math.max(0, totalValue - remainingValue)
    }
    if (remainingValue == null && totalValue != null && totalValue > 0 && usedValue != null) {
      remainingValue = Math.max(0, totalValue - usedValue)
    }
    if (usedPercentValue == null && totalValue != null && totalValue > 0 && usedValue != null) {
      usedPercentValue = Math.max(0, (usedValue / totalValue) * 100)
    }
    if (
      usedValue == null &&
      totalValue == null &&
      remainingValue == null &&
      usedPercentValue == null
    ) {
      return null
    }
    return {
      kind: kind || (period === 'minute' || period === 'hour' ? 'rate-limit' : 'quota'),
      period,
      metric: normalizedMetric,
      rawWindow,
      total: totalValue,
      remaining: remainingValue,
      used: usedValue,
      usedPercent: usedPercentValue,
      percentOnly: isPercentOnly,
      estimated: estimated === true,
      resetAt: Number.isFinite(Number(resetAt)) && Number(resetAt) > 0 ? Number(resetAt) : null,
      detail: detail || '',
      stale: Boolean(stale),
      unavailable: zeroLimit,
    }
  }

  function railQuotaWindows(row) {
    const windows = []
    const byWindow = new Map()
    const add = (window, replace = false) => {
      if (!window) return
      // A positive window whose reset has already passed is history, not a live quota.
      if (
        window.total != null &&
        window.total > 0 &&
        window.resetAt != null &&
        window.resetAt <= Date.now()
      ) {
        return
      }
      const key = `${window.metric}:${window.period}`
      const existing = byWindow.get(key)
      if (existing && !replace) return
      if (existing) {
        const index = windows.indexOf(existing)
        if (index >= 0) windows.splice(index, 1)
      }
      byWindow.set(key, window)
      windows.push(window)
    }

    const known = row?.knownQuota
    const knownLimits = Array.isArray(known?.limits) ? known.limits : []
    const scope = known?.limitScope === 'model' ? 'model' : 'account'
    const recorded = scope === 'model' ? row?.recordedUsage : row?.providerRecordedUsage || row?.recordedUsage
    for (const limit of knownLimits) {
      const metric = limit?.metric === 'requests' ? 'requests' : limit?.metric === 'tokens' ? 'tokens' : null
      if (!metric) continue
      const total = Number(limit.limit)
      if (!Number.isFinite(total) || total < 0) continue
      const period = railQuotaPeriod(limit.period)
      const field = RAIL_QUOTA_RECORDED_FIELD[metric]?.[period]
      const recordedValue = field ? Number(recorded?.[field]) : NaN
      const used = field ? (Number.isFinite(recordedValue) ? recordedValue : 0) : null
      add(
        railQuotaWindow({
          period,
          metric,
          rawWindow: limit.period,
          used,
          total,
          remaining: used == null ? null : Math.max(0, total - used),
          resetAt: railQuotaResetAt(period),
          detail: limit.label || 'published limit',
        }),
      )
    }

    const report = row?.providerUsage
    const reportMetric =
      report?.metric === 'requests' ? 'requests' : report?.metric === 'tokens' ? 'tokens' : null
    if (report && reportMetric) {
      add(
        railQuotaWindow({
          period: railQuotaPeriod(report.window),
          metric: reportMetric,
          rawWindow: report.window,
          used: report.used,
          total: report.limit ?? report.total,
          remaining: report.remaining,
          resetAt: report.resetAt,
          detail: report.accountLabel || report.model || report.window || 'provider usage',
          stale: report.freshness === 'stale',
        }),
        true,
      )
    }

    // Capacity (credit balance, free-tier percentage) lives on the quota half; throttle
    // counters (limitRequests/limitTokens) stay on rateLimit. Both feed the rail, because the
    // split is about ownership, not about hiding either from the user.
    const rateLimit = row?.rateLimit
    const quotaState = row?.quota
    const capacity = quotaState || rateLimit
    if (capacity) {
      // The provider key endpoint reports an account credit balance (OpenRouter's
      // creditLimit/creditRemaining). Every model on that key draws from the same pot, and the
      // rail had no window for it at all, so the one figure that answers "is there money left"
      // never appeared beside the models spending it.
      if (capacity.creditLimit != null || capacity.creditRemaining != null) {
        add(
          railQuotaWindow({
            kind: 'quota',
            period: 'lifetime',
            metric: 'credits',
            rawWindow: 'account credit',
            total: capacity.creditLimit,
            remaining: capacity.creditRemaining,
            used:
              capacity.creditLimit != null && capacity.creditRemaining != null
                ? Math.max(0, Number(capacity.creditLimit) - Number(capacity.creditRemaining))
                : null,
            resetAt: capacity.creditResetAt,
            detail: 'account credit reported by the provider key endpoint',
          }),
        )
      }
      const retryReset =
        rateLimit?.capturedAt && rateLimit?.retryAfterMs
          ? Number(rateLimit.capturedAt) + Number(rateLimit.retryAfterMs)
          : null
      // Token Harbor's free tier is a percentage of a rolling seven-day allowance, not a
      // token total. Show the percentage the gateway reported rather than inventing a limit.
      if (
        capacity.freeUsedPercent != null &&
        (capacity.freeResetAt == null || Number(capacity.freeResetAt) > Date.now())
      ) {
        add(
          railQuotaWindow({
            period: 'week',
            metric: 'tokens',
            rawWindow: 'rolling 7-day free allowance',
            usedPercent: capacity.freeUsedPercent,
            resetAt: capacity.freeResetAt,
            detail: 'Token Harbor free-tier allowance',
            percentOnly: true,
          }),
        )
      }
      if (rateLimit?.limitTokens != null || rateLimit?.remainingTokens != null) {
        add(
          railQuotaWindow({
            period: railQuotaLimitPeriod(rateLimit.resetTokensAt || retryReset),
            metric: 'tokens',
            rawWindow: 'last response',
            used:
              rateLimit.limitTokens != null && rateLimit.remainingTokens != null
                ? Math.max(0, Number(rateLimit.limitTokens) - Number(rateLimit.remainingTokens))
                : null,
            total: rateLimit.limitTokens,
            remaining: rateLimit.remainingTokens,
            resetAt: rateLimit.resetTokensAt || retryReset,
            detail: 'from the last response',
          }),
        )
      }
      if (rateLimit?.limitRequests != null || rateLimit?.remainingRequests != null) {
        add(
          railQuotaWindow({
            period: railQuotaLimitPeriod(rateLimit.resetRequestsAt || retryReset),
            metric: 'requests',
            rawWindow: 'last response',
            used:
              rateLimit.limitRequests != null && rateLimit.remainingRequests != null
                ? Math.max(0, Number(rateLimit.limitRequests) - Number(rateLimit.remainingRequests))
                : null,
            total: rateLimit.limitRequests,
            remaining: rateLimit.remainingRequests,
            resetAt: rateLimit.resetRequestsAt || retryReset,
            detail: 'from the last response',
          }),
        )
      }
    }

    for (const observed of Array.isArray(row?.quotaWindows) ? row.quotaWindows : []) {
      add(
        railQuotaWindow({
          kind: observed.kind,
          period: railQuotaPeriod(observed.period || observed.rawWindow),
          metric: observed.metric,
          rawWindow: observed.rawWindow,
          used: observed.used,
          total: observed.limit ?? observed.total,
          remaining: observed.remaining,
          resetAt: observed.resetAt,
          detail: observed.detail,
          stale: observed.stale,
          unavailable: observed.unavailable,
          usedPercent: observed.usedPercent,
          percentOnly: observed.percentOnly,
        }),
        true,
      )
    }

    // No published cap and no observed window: estimate a ceiling from the traffic this endpoint
    // has carried, exactly as the Router table's Quota column does. The rail reads the same row,
    // so it must not be the one surface that still says no limit was ever stated — the table drew
    // an active bar for "requests this minute" and the rail beside it drew nothing.
    //
    // The estimator lives in dashboard.js and is handed over rather than copied: two versions of
    // "the next round tier above the busiest traffic" would disagree the moment one was tuned.
    // A provider that states there is no limit is not estimated against, for the same reason the
    // table skips it: an inferred ceiling would turn ∞ back into a number the provider disclaimed.
    const estimateCeiling =
      typeof window.hxEstimateLimitCeiling === 'function' ? window.hxEstimateLimitCeiling : null
    const observedUsage = row?.knownQuota?.unlimited === true ? {} : row?.recordedUsage || {}
    if (estimateCeiling) {
      for (const metric of ['requests', 'tokens']) {
        for (const period of ['minute', 'hour', 'day']) {
          const field = RAIL_QUOTA_RECORDED_FIELD[metric]?.[period]
          if (!field) continue
          if (windows.some((w) => w.metric === metric && w.period === period)) continue
          const seen = Number(observedUsage[field])
          if (!Number.isFinite(seen) || seen <= 0) continue
          const ceiling = estimateCeiling(seen)
          add(
            railQuotaWindow({
              period,
              metric,
              rawWindow: `estimated ${period}`,
              used: seen,
              total: ceiling,
              remaining: Math.max(0, ceiling - seen),
              detail: 'ceiling estimated from traffic Hammer has carried; no published limit',
              estimated: true,
            }),
          )
        }
      }
    }

    const sorted = windows.sort(
      (a, b) =>
        (RAIL_QUOTA_PERIOD_ORDER[a.period] ?? 9) -
          (RAIL_QUOTA_PERIOD_ORDER[b.period] ?? 9) ||
        (RAIL_QUOTA_METRIC_ORDER[a.metric] ?? 9) - (RAIL_QUOTA_METRIC_ORDER[b.metric] ?? 9),
    )
    // Four zero-limit windows say the same thing four times. If any real window exists,
    // drop the zeros; otherwise collapse the whole row into one "not available" statement.
    const available = sorted.filter((window) => !window.unavailable)
    if (available.length > 0) return available
    if (sorted.length === 0) return []
    const first = sorted[0]
    return [
      {
        period: 'window',
        metric: first.metric,
        rawWindow: 'free tier',
        total: 0,
        remaining: 0,
        used: 0,
        usedPercent: null,
        percentOnly: false,
        resetAt: null,
        detail: 'Requests and tokens are not included in the free tier.',
        stale: false,
        unavailable: true,
      },
    ]
  }

  function railQuotaWindowHtml(window) {
    const noFreeTier = window.unavailable && !window.percentOnly && window.period === 'window'
    const basePeriodLabel = noFreeTier
      ? 'FREE TIER'
      : railQuotaPeriodLabel(window.period, window.rawWindow)
    // An estimated ceiling is labelled as one, in the table's own words: the bar is real, the
    // figure under it is a bound Hammer inferred from traffic, not something the provider said.
    const periodLabel = window.estimated ? `${basePeriodLabel} · EST` : basePeriodLabel
    const unit = window.metric === 'requests' ? 'req' : 'tok'
    const remainingPercent =
      (window.unavailable && !window.percentOnly) || window.usedPercent == null
        ? null
        : 100 - Math.min(100, window.usedPercent)
    const totalText = noFreeTier
      ? 'not included'
      : window.percentOnly
        ? 'allowance not published'
        : window.total != null
          ? `${railQuotaCompact(window.total)} ${unit} / ${periodLabel.toLowerCase()}`
          : 'limit not reported'
    const remainingText = noFreeTier
      ? ''
      : window.percentOnly
        ? remainingPercent == null
          ? 'remaining not reported'
          : `${railQuotaPercentText(remainingPercent)}% left`
        : window.unavailable
          ? 'no free-tier allowance'
          : window.remaining != null
            ? `${railQuotaCompact(window.remaining)} left`
            : 'remaining not reported'
    const resetMs = window.resetAt == null ? null : window.resetAt - Date.now()
    const resetText =
      noFreeTier || resetMs == null || resetMs <= 0
        ? ''
        : `resets in ${railQuotaResetText(resetMs)}`
    const percentText = noFreeTier
      ? 'no allowance'
      : window.percentOnly && window.usedPercent != null
        ? `${railQuotaPercentText(window.usedPercent)}% used`
        : window.unavailable
          ? 'not available'
          : window.usedPercent == null
            ? 'usage not reported'
            : `${railQuotaPercentText(window.usedPercent)}% used`
    const barWidth =
      window.usedPercent == null || (window.unavailable && !window.percentOnly)
        ? 0
        : Math.min(100, window.usedPercent)
    const tone =
      remainingPercent == null
        ? 'unknown'
        : remainingPercent <= 10
          ? 'error'
          : remainingPercent <= 30
            ? 'warning'
            : 'success'
    const titleParts = noFreeTier
      ? ['No free-tier requests or tokens', window.detail]
      : [
          window.percentOnly ? `${percentText} · allowance not published` : percentText,
          window.used != null && window.total != null && !window.unavailable
            ? `${window.used.toLocaleString()} of ${window.total.toLocaleString()} ${unit}`
            : '',
          window.remaining != null && !window.unavailable
            ? `${window.remaining.toLocaleString()} ${unit} remaining`
            : '',
          window.percentOnly && remainingPercent != null
            ? `${railQuotaPercentText(remainingPercent)}% remaining`
            : '',
          resetText,
          window.detail,
          window.stale ? 'stale' : '',
        ]
    const meta = noFreeTier
      ? window.detail
      : [totalText, remainingText, resetText].filter(Boolean).join(' · ')
    return `<div class="hx-quota-window${window.stale ? ' is-stale' : ''}${
      window.unavailable ? ' is-unavailable' : ''
    }${window.estimated ? ' is-estimated' : ''}" title="${escapeHtml(
      titleParts.filter(Boolean).join(' · '),
    )}">
      <div class="hx-quota-head"><span class="hx-quota-pct">${escapeHtml(
        percentText,
      )}</span></div>
      <div class="hx-quota-track${
        (window.unavailable && !window.percentOnly) || window.usedPercent == null
          ? ' hx-quota-track-unknown'
          : ''
      }" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${
        (window.unavailable && !window.percentOnly) || window.usedPercent == null
          ? ''
          : Math.round(Math.min(100, window.usedPercent))
      }" aria-label="${escapeHtml(noFreeTier ? 'Free-tier quota' : `${periodLabel} quota`)}" aria-valuetext="${escapeHtml(
        percentText,
      )}"><div class="hx-quota-fill hx-quota-fill-${tone}" style="width:${barWidth.toFixed(
        2,
      )}%"></div></div>
      ${meta ? `<div class="hx-quota-meta">${escapeHtml(meta)}</div>` : ''}
    </div>`
  }

  /**
   * The rail's two empty readings, which are the table's, not a third of its own.
   *
   * A provider that states it has no limit has ∞: nothing can exhaust it. A provider nothing has
   * measured yet has not said that — its bar is unknown, and it starts filling once traffic or a
   * response named a window. The rail printed ∞ for both, which claimed a limit the provider had
   * never disclaimed, and it was the one surface that did.
   */
  function railQuotaUnlimitedHtml(kind) {
    const throttle = kind === 'rate-limit'
    const title = throttle
      ? 'The provider states there is no rate limit for this endpoint — nothing can exhaust it.'
      : 'The provider states there is no usage limit for this endpoint — nothing can exhaust it.'
    // The meter above the bars already names the limit, so a bar never repeats the noun: ∞ is
    // the whole reading, and the line underneath says why. The name assistive tech announces is
    // the one the eye no longer needs.
    return `<div class="hx-quota-window" title="${escapeHtml(title)}">
      <div class="hx-quota-head"><span class="hx-quota-pct" aria-label="${throttle ? 'Rate limit' : 'Quota'}">∞</span></div>
      <div class="hx-quota-meta">no usage limit published</div>
    </div>`
  }

  /**
   * Whether a recorded-usage bag carries anything at all.
   *
   * The bags arrive fully populated with zeros, so "never measured" and "measured, carried
   * nothing" look the same on the wire; only the values tell them apart. A pooled provider
   * draws one column per account, and an account whose counter is empty beside a row that has
   * traffic must not repeat "no usage recorded yet" under a plot of that traffic.
   */
  function railUsageHasSamples(usage) {
    if (!usage || typeof usage !== 'object') return false
    return Object.values(usage).some((value) => Number.isFinite(Number(value)) && Number(value) > 0)
  }

  function railQuotaUnknownHtml(kind, meta) {
    const throttle = kind === 'rate-limit'
    const title = throttle
      ? 'No rate limit is published or has been observed for this endpoint yet. The bar starts filling as Hammer records traffic; a ceiling is estimated once there is usage to learn from.'
      : 'No limit is published or has been observed for this endpoint yet. The bar starts filling as Hammer records traffic; a ceiling is estimated once there is usage to learn from.'
    return `<div class="hx-quota-window" title="${escapeHtml(title)}">
      <div class="hx-quota-head"><span class="hx-quota-pct">limit not published</span></div>
      <div class="hx-quota-track hx-quota-track-unknown" role="progressbar" aria-label="${throttle ? 'Rate limit' : 'Quota'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="" aria-valuetext="limit not published"><div class="hx-quota-fill hx-quota-fill-unknown" style="width:0%"></div></div>
      <div class="hx-quota-meta">${meta || 'no usage recorded yet'}</div>
    </div>`
  }

  // One set of windows per credential, when the routed provider pools several accounts.
  //
  // The row's own numbers describe the pool: a per-key allowance drawn against the pool's
  // traffic is wrong in both directions (over when another key carried the requests, under
  // when this one is the only account serving). The API sends each account's own traffic and
  // the windows its responses stated, so the rail answers per account exactly like the table.
  function railQuotaAccounts(row) {
    const accounts = Array.isArray(row?.credentials) ? row.credentials : []
    if (accounts.length < 2) return null
    return accounts.map((account, i) => {
      const index = Number.isInteger(account?.index) ? account.index : i
      const quota = account?.quota && typeof account.quota === 'object' ? account.quota : null
      const remaining = quota?.remaining == null ? null : Number(quota.remaining)
      const limit = quota?.limit == null ? null : Number(quota.limit)
      const hasReport = Number.isFinite(remaining) || Number.isFinite(limit)
      const reportedWindows = hasReport
        ? [
            {
              kind: 'quota',
              period: 'window',
              metric: 'requests',
              rawWindow: 'last response',
              used:
                Number.isFinite(remaining) && Number.isFinite(limit)
                  ? Math.max(0, limit - remaining)
                  : null,
              limit: Number.isFinite(limit) ? limit : null,
              remaining: Number.isFinite(remaining) ? remaining : null,
              resetAt:
                Number(quota.resetsInMs) > 0 ? Date.now() + Number(quota.resetsInMs) : null,
              detail: quota.modelId ? `reported for ${quota.modelId}` : 'from the last response',
              percentOnly: quota.percentOnly === true,
              usedPercent:
                quota.percentOnly === true && Number.isFinite(remaining)
                  ? Math.max(0, 100 - remaining)
                  : null,
            },
          ]
        : []
      // Only the windows that describe *this* account. A provider that reports per key stamps
      // the key's index on the window it reported; an endpoint-scoped window carries none and
      // belongs to every key. Passing the whole list drew another key's bar in this column —
      // and the same bar twice in the Google pools, where both keys had reported one.
      const observed = (Array.isArray(row?.quotaWindows) ? row.quotaWindows : []).filter(
        (window) => window?.accountIndex == null || Number(window.accountIndex) === index,
      )
      return {
        index,
        label: account?.label ? String(account.label) : `Account ${i + 1}`,
        serving: account?.serving === true,
        exhausted: account?.exhausted === true,
        // This account's own counter, so an empty column can say which counter is empty.
        hasUsage:
          railUsageHasSamples(account?.usage) || railUsageHasSamples(account?.usageAcrossModels),
        windows: railQuotaWindows({
          ...row,
          rateLimit: account?.rateLimit || null,
          quota: account?.quota || null,
          recordedUsage: account?.usage || {},
          // An account-scoped limit is spent by all of that account's models.
          providerRecordedUsage: account?.usageAcrossModels || account?.usage || {},
          providerUsage: null,
          quotaWindows: [...reportedWindows, ...observed],
        }),
      }
    })
  }

  /**
   * The model whose limits the rail draws, with the words that name it.
   *
   * One decision for both the label and the row beneath it. The composer's strip already treats
   * the model that answered as the truth — the router's pick is a request, and a fallback answers
   * with a model the pick never named (`noteAnsweredModel`) — while the rail read only the pick.
   * So a turn served by a fallback left the pick's windows in the sidebar beside a strip naming
   * another model, and nothing said which model those bars belonged to. An answer that fits a
   * table row wins; the pick is used when nothing has answered, or when the answer does not name
   * the same model the transcript recorded (that field is cleared whenever the route moves, so a
   * new route never inherits the previous answer's bars).
   */
  function quotaSubject(ctx) {
    const routed = ctx?.routedModel
    const routedKey = routed ? `${routed.providerKey}::${routed.modelId}` : ''
    const answeredName = modelName(ctx?.answeredModel || '')
    const rowName = modelName(lastAnsweredRow(ctx)?.model || '')
    // The answer is only this turn's answer when the transcript's newest row agrees with it.
    if (answeredName && rowName && answeredName === rowName) {
      const providerKey = providerKeyByModel.get(answeredName) || ''
      const key = providerKey ? `${providerKey}::${answeredName}` : ''
      const stored = key ? quotaRowByModel.get(key) : null
      if (key && key !== routedKey && stored) {
        const label = printableModelName(stored.label || answeredName)
        const providerName = stored.providerName || providerDisplayName(providerKey)
        return { key, label, title: [label, providerName].filter(Boolean).join(' · ') }
      }
    }
    if (!routed) return null
    const label = printableModelName(routed.label || routed.modelId || routed.realModelId || 'model')
    return {
      key: routedKey,
      label,
      title: [label, routed.providerName].filter(Boolean).join(' · '),
    }
  }

  function renderQuota(ctx = active()) {
    const list = $('hx-quota-windows')
    const rateList = $('hx-rate-windows')
    const rateMeter = rateList?.closest('.hx-meter') || null
    const modelEl = $('hx-quota-model')
    const subject = quotaSubject(ctx)
    if (!list) return
    // Both meters answer with a bar or ∞. Nothing here is a dash or a link: the routed row
    // is either under a window this endpoint named, or it is not limited by one.
    const paint = (windows, accounts = null) => {
      const quota = windows.filter((window) => window.kind !== 'rate-limit')
      const throttles = windows.filter((window) => window.kind === 'rate-limit')
      // A provider that says "no limit" gets ∞ and one that has not been measured gets the
      // unknown bar — the same two readings the table's cells make.
      const unlimited = row?.knownQuota?.unlimited === true
      // Whether the row itself has traffic: an account column with no counter of its own says
      // that, instead of claiming nothing has been recorded while the row's plot shows it was.
      const rowHasUsage =
        railUsageHasSamples(row?.recordedUsage) || railUsageHasSamples(row?.providerRecordedUsage)
      const empty = (kind, meta) =>
        unlimited ? railQuotaUnlimitedHtml(kind) : railQuotaUnknownHtml(kind, meta)
      // A pooled provider draws a column per credential. A single-credential provider has one
      // account, which is the row bar itself, so it keeps the plain list.
      const accountColumn = (kind) => {
        if (!accounts || accounts.length < 2) return null
        return `<div class="hx-quota-account-list">${accounts
          .map((account) => {
            const state = account.exhausted ? 'exhausted' : account.serving ? 'serving' : ''
            const accountWindows = account.windows.filter((window) =>
              kind === 'rate-limit' ? window.kind === 'rate-limit' : window.kind !== 'rate-limit',
            )
            return `<div class="hx-quota-account is-${state || 'idle'}" title="${escapeHtml(
              account.label,
            )}"><div class="hx-quota-account-head"><span class="hx-quota-account-tag">A${
              account.index + 1
            }</span>${
              state ? `<span class="hx-quota-account-state">${state}</span>` : ''
            }</div>${
              accountWindows.length
                ? accountWindows.map(railQuotaWindowHtml).join('')
                : empty(
                    kind,
                    rowHasUsage && !account.hasUsage ? 'no per-account usage recorded' : undefined,
                  )
            }</div>`
          })
          .join('')}</div>`
      }
      const body = (kind, windowsForKind) =>
        accountColumn(kind) ||
        (windowsForKind.length
          ? windowsForKind.map(railQuotaWindowHtml).join('')
          : empty(
              kind,
              rowHasUsage ? 'usage recorded · no limit published' : undefined,
            ))
      list.innerHTML = body('quota', quota)
      if (rateList) rateList.innerHTML = body('rate-limit', throttles)
    }
    if (rateMeter) rateMeter.hidden = !subject
    if (!subject) {
      if (modelEl) {
        modelEl.textContent = 'no model'
        modelEl.title = ''
      }
      list.innerHTML = '<div class="hx-quota-empty">No model routed yet.</div>'
      if (rateList) rateList.innerHTML = '<div class="hx-quota-empty">No model routed yet.</div>'
      return
    }
    // The label and the row are one subject: the words above the bars always name the model the
    // bars were read from, whichever of the two it is.
    if (modelEl) {
      modelEl.textContent = subject.label
      modelEl.title = subject.title
    }
    const rowKey = subject.key
    const row = quotaRowByModel.get(rowKey)
    if (!row) {
      // The table does not mention this endpoint. A table read minutes ago is not evidence
      // that the row publishes no limit — it is evidence that the row was not in that read —
      // so the answer is fetched for this pick, once, and then allowed to stand.
      const settled =
        quotaMissLookup.key === rowKey && Date.now() - quotaMissLookup.at < 30_000
      if (settled) {
        paint([])
      } else {
        list.innerHTML = '<div class="hx-quota-empty">Reading quota…</div>'
        if (rateList) rateList.innerHTML = '<div class="hx-quota-empty">Reading quota…</div>'
        void loadKnownTtfts({ force: true }).then(() => {
          quotaMissLookup = { key: rowKey, at: Date.now() }
          if (ctx === active()) renderQuota(ctx)
        })
      }
      return
    }
    paint(railQuotaWindows(row), railQuotaAccounts(row))
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
      setRunning(
        data.phase === 'busy' || Boolean(data.isStreaming) || data.isCompacting === true,
        console,
      )
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
      // Pi's context figure rides on the status, not on `usage`. A reopened conversation
      // carries it here with an otherwise empty usage object, so dropping it left the context
      // bar blank even though the agent had answered exactly how full the window was.
      if (data.contextUsage) {
        console.usage = { ...(console.usage || {}), contextUsage: data.contextUsage }
        if (console === active()) {
          state.usage = console.usage
          renderUsage(console)
        }
      }
      if (console === active()) updateComposer()
      renderSessions()
      // A background console's status must not repaint the rail: the panel is one element, and
      // a running inactive tab would otherwise disable the button while the active tab is idle.
      if (console === active()) renderCompactionPanel(console)
      // Status can be the first word of the conversation's file (the main console learns it
      // here). With no turn running there is no settle to wait for, so the transcript is
      // rebuilt now rather than at the end of a turn that may never come.
      if (!console.running && !console.historyLoaded && console.sessionFile) {
        void restoreHistory(console)
      }
    } catch (err) {
      setHint(`Could not reach the agent: ${err?.message || err}`, 'error', console)
      setPhase('dead', console)
    }
  }

  function updateComposer() {
    const stop = $('hx-stop')
    const running = Boolean(state.running)
    const unavailable = Boolean(state.status && state.status.available === false)
    const busy = Boolean(active()?.sending) || unavailable
    // A message into a running turn is not sent, it is delivered one of two ways — so the plain
    // send gives its place to the two buttons that say which. Nothing offers a third meaning, and
    // nothing asks the reader to notice what a shared button would have done.
    // Nothing to send is not a button with nothing to do. An empty box with no image staged
    // shows no send control at all — a disabled one still asks the reader what is wrong with
    // it — and the control appears the moment there is something to send. Stop is not part of
    // this: it is about the turn, not the composer, and it stays while a turn runs.
    const hasContent =
      Boolean(($('hx-input')?.value || '').trim()) || state.attachments.length > 0
    const send = $('hx-send')
    if (send) {
      send.disabled = busy
      send.hidden = running || !hasContent
    }
    for (const id of ['hx-send-steer', 'hx-send-queue']) {
      const button = $(id)
      if (!button) continue
      button.disabled = busy
      button.hidden = !running || !hasContent
    }
    if (stop) stop.hidden = !running
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
    // The file this console is attached to is settled on the hello frame, so the rail is
    // published from here too: a tab restored from storage knows its file, but the plot
    // only describes the conversation once the agent has confirmed the name.
    if (ctx === active() && ctx.sessionFile) void publishSessionUsage(ctx)
    // A replay log that ends on a tool start — the usual tail after a crash or a replaced
    // child — would otherwise restore a spinner with nothing behind it.
    if (!ctx.running) settleOpenTools(ctx)
    // If the turn already settled by the time hello arrived, restore immediately instead
    // of waiting for a running-edge that will never come.
    // An idle console has no running-edge to wait for: hello is its last chance to be rebuilt
    // from its file. This is the ordinary shape after a restart — a conversation that had
    // already finished — and waiting for a settle that never comes left it blank.
    if (!ctx.running && !ctx.historyLoaded) {
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
    // Compaction is work even though it is not a turn: pi stops the agent, spends a model call
    // writing the summary, and says nothing for tens of seconds. Left idle, the composer offered
    // to send into a conversation being rewritten underneath it, and the only sign anything was
    // happening was a line in the rail. Busy gives it the shape a turn has — steer and queue
    // instead of send, and Stop, which pi's abort routes to the compaction itself.
    setRunning(
      status.phase === 'busy' || Boolean(status.isStreaming) || status.isCompacting === true,
      ctx,
    )
    renderRouting(status, ctx)
    // The status carries pi's own queue accounting, so a page opened mid-run sees what is
    // already waiting without waiting for a fresh `queue_update`.
    if (Array.isArray(status.queuedSteering) || Array.isArray(status.queuedFollowUp)) {
      applyQueue(status.queuedSteering, status.queuedFollowUp, ctx)
    }
    // The compaction panel reads the same status, and is repainted from every status frame
    // rather than only on a poll: a threshold compaction mid-turn carries its `isCompacting`
    // on the frame the event stream delivers, and this panel is the only thing on screen that
    // can explain why a turn is taking longer than it should. Without it the "Pi is
    // compacting" note stayed hidden until the next refresh, and a compaction nobody asked
    // for looked exactly like a hang. Only the active console owns this panel; a background
    // conversation keeps its status on its own ctx and paints when it comes on screen.
    if (ctx === active()) renderCompactionPanel(ctx)
    // The status frame carries the session's rehydrated totals, so a page opened after the
    // tokens were spent still shows them without waiting for a fresh turn.
    if (status.usage) {
      ctx.usage = status.usage
      if (ctx === active()) {
        state.usage = ctx.usage
        renderUsage(ctx)
      }
    }
    if (ctx === active()) updateComposer()

    // Pi's context figure lives on the status, not the usage frame, after a rehydration — so a
    // page opened onto a full context sees the meter (not an empty one) on the first frame.
    if (status.contextUsage && ctx === active()) {
      state.usage = state.usage || {}
      state.usage.contextUsage = status.contextUsage
      renderUsage(ctx)
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
        // The usage frame may carry pi's context figure alongside the totals; the compaction
        // the bridge just finished is exactly when it changes.
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
    // Staging or removing an image changes whether there is anything to send.
    updateComposer()
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

  async function sendPrompt(mode = 'followUp') {
    const input = $('hx-input')
    const console = active()
    if (!input || !console || console.sending) return
    const text = input.value.replace(/\r\n/g, '\n').trim()
    // An empty send does nothing at all. The button already looks unavailable without text, and
    // a line of hint telling the reader to type a message only repeats that in another colour.
    if (!text && state.attachments.length === 0) return

    // Slash commands are the few things a harness must do without a round trip through the
    // model: start over, stop, and compact. `/compact help` is not a compaction — it explains
    // one, so it is matched before the bare word and answers in place.
    if (text === '/new') {
      input.value = ''
      saveDraft(console, '')
      await newSession()
      return
    }
    if (text === '/compact help') {
      input.value = ''
      saveDraft(console, '')
      setHint(
        'Compaction replaces the older turns with a summary. /compact does it now; '
          + 'text after it becomes your instructions to the summariser.',
        null,
        console,
      )
      return
    }
    if (text === '/compact' || text.startsWith('/compact ') || text.startsWith('/compact\n')) {
      // Everything after the command is the instruction the summary is written against, which
      // is the part of a compaction a user most wants to control.
      const instructions = text.slice('/compact').trim()
      input.value = ''
      saveDraft(console, '')
      await compactNow(instructions)
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
    setHint(
      mode === 'followUp'
        ? 'Queueing for the next turn…'
        : console.running
          ? 'Steering the agent…'
          : 'Sending…',
      null,
      console,
    )
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
          queueMode: mode,
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
      // The reset clears the transcript, so the plot has no history to describe either.
      void publishSessionUsage(console)
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

  /**
   * Compacts this conversation by hand.
   *
   * Pi aborts the running turn to do it, so a busy agent is refused by the server (409) and
   * the hint says why rather than silently truncating an answer the model was still writing.
   * The compaction row is not pushed here: it is appended by the `compaction_start` record
   * that arrives with the agent's own event, so a threshold compaction and this one are
   * indistinguishable in the transcript and neither can disagree with the other.
   */
  async function compactNow(instructions = '') {
    const console = active()
    if (!console) return
    const button = $('hx-compaction-panel')?.querySelector('[data-compaction-now]')
    if (console.running) {
      setHint('Pi is answering — stop the turn before compacting.', 'error', console)
      return
    }
    // The button carries its own in-flight state as well as the hint does. A compaction is
    // an LLM call that can run for many seconds, and during it the only thing that changed
    // on screen was a line of hint text the user may not have read. Without this the button
    // sits there looking available — and a second click starts a second compaction, on a
    // conversation the first one has not finished resetting. The label says what is happening,
    // which is the feedback the panel's own "Pi is compacting" note gives a moment later.
    if (button) {
      button.disabled = true
      button.dataset.working = 'true'
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent
      button.textContent = 'Compacting…'
    }
    const restore = () => {
      if (!button) return
      button.disabled = Boolean(console.running) || console.status?.available === false
      delete button.dataset.working
      button.textContent = button.dataset.idleLabel || 'Compact now'
    }
    // No hint while it runs: the compaction row in the transcript already says
    // "Compacting the context…", and saying it twice — once there, once beside the composer —
    // reads as two things happening. The button's own "Compacting…" label carries the wait.
    try {
      const res = await fetch(consoleApi(console, '/compact'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(instructions ? { instructions } : {}),
      })
      const data = await res.json().catch(() => {})
      if (!res.ok) throw new Error(data?.error || `Could not compact (${res.status}).`)
      // "Nothing here grew" is the answer to a question well asked, not a failure.
      const figures = compactionPair(data?.tokensBefore, data?.tokensAfter)
      if (!figures) setHint('Compacted.', 'success', console)
      else setHint(`Compacted — ${figures}.`, 'success', console)
      await refreshStatus(console)
    } catch (err) {
      setHint(err?.message || 'Could not compact the context.', 'error', console)
    } finally {
      restore()
    }
  }

  /**
   * Turns Pi's auto-compaction on or off.
   *
   * The server reads the answer back from the agent rather than trusting the request, so an
   * older Pi that ignores the command shows as "not reported" instead of as a switch that
   * claims to have moved.
   */
  async function setAutoCompaction(enabled) {
    const console = active()
    if (!console) return
    try {
      const res = await fetch(consoleApi(console, '/auto-compaction'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await res.json().catch(() => {})
      if (!res.ok) throw new Error(data?.error || `Could not change auto-compaction (${res.status}).`)
      // The server reads the switch back from Pi; use that answer rather than the provisional
      // pressed state, so the compaction panel and the context note agree immediately.
      if (console.status && Object.prototype.hasOwnProperty.call(data, 'reported')) {
        console.status = { ...console.status, autoCompactionEnabled: data.reported }
        if (console === active()) state.status = console.status
      }
      renderCompactionPanel(console)
      if (console === active()) renderUsage(console)
      // No hint line here: the panel's own switch reads the state back as "on" or "off", which
      // is the same fact on the same screen. A pop-up only repeated it in another colour, and a
      // pi that reports nothing simply leaves the switch hidden. Failures still speak.
    } catch (err) {
      setHint(err?.message || 'Could not change auto-compaction.', 'error', console)
    }
  }

  /**
   * Paints the compaction panel in the details rail: the context figure, whether Pi will
   * compact on its own, and the button that does it now.
   *
   * Every field is read from what the agent actually reported. A pi that reports nothing
   * (too old for the state) leaves the panel saying so, rather than presenting a toggle that
   * would be a lie.
   */
  function renderCompactionPanel(console = active()) {
    const panel = $('hx-compaction-panel')
    if (!panel) return
    // `state.status` is the active console's, so it is a fallback only when this *is* that
    // console. An inactive one must not borrow another conversation's availability.
    const status = console?.status || (console === active() ? state.status : null) || {}
    const auto = status.autoCompactionEnabled
    const toggle = panel.querySelector('[data-compaction-toggle]')
    if (toggle) {
      toggle.hidden = auto == null
      toggle.setAttribute('aria-pressed', String(auto === true))
      const label = toggle.querySelector('[data-compaction-state]')
      if (label) label.textContent = auto === true ? 'on' : auto === false ? 'off' : '—'
    }
    const badge = panel.querySelector('[data-compaction-count]')
    if (badge) {
      const n = Number(status.compactionCount) || 0
      badge.textContent = n === 1 ? '1 compaction' : `${n} compactions`
      badge.hidden = n === 0
    }
    const note = panel.querySelector('[data-compaction-note]')
    if (note) {
      note.hidden = status.isCompacting !== true
      if (status.isCompacting === true) {
        const why =
          status.compactionReason === 'manual'
            ? 'you asked for it'
            : status.compactionReason === 'overflow'
              ? 'the context overflowed'
              : 'the context is nearly full'
        note.textContent = `Pi is compacting — ${why}.`
      }
    }
    // The button is repainted from every status frame, so its own in-flight marker must
    // be respected here or a frame arriving mid-compaction would wipe it: the label would
    // snap back to "Compact now" with a compaction still running. Either side can own the
    // working state (`compactNow` set it, or the agent is compacting on its own), and both
    // read the same way.
    const button = panel.querySelector('[data-compaction-now]')
    if (button) {
      const working = button.dataset.working === 'true' || status.isCompacting === true
      const idleLabel = button.dataset.idleLabel || 'Compact now'
      button.textContent = working ? 'Compacting…' : idleLabel
      button.disabled = working || Boolean(console?.running) || status.available === false
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
      // Nothing to describe, so the rail goes back to the router's own view rather than
      // holding a conversation that is no longer attached to this console.
      if (ctx === active()) void publishSessionUsage(ctx)
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
    // A conversation that starts writing is the one on screen, unless something switched since.
    if (ctx === active()) rememberViewed(ctx)
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
          // The file is gone, so it has no history to publish. A console that was on screen
          // hands the plot straight back to the router's own view rather than leaving the
          // deleted conversation drawn there.
          if (ctx === active()) void publishSessionUsage(ctx)
        }
      }
      await loadSessions()
    } catch (err) {
      setHint(err?.message || 'Could not delete that session.', 'error')
    }
  }

  /** Rebuilds one conversation from the session file its agent is attached to. */
  async function loadMessages(ctx = active()) {
    // A rebuilt row names its provider from the router's model table (a message records
    // "hammer", which is the router). Read it first, or a conversation opened after a restart
    // labels every model and leaves the provider that served it blank.
    await loadKnownTtfts().catch(() => {})
    // Name the conversation explicitly. A bridge that has not yet heard its child's `get_state`
    // cannot say which file it is on, and a route that trusts only that answers with the
    // agent's compacted view instead of the file this tab is rebuilding.
    const session = ctx && ctx.sessionFile
    const res = await fetch(
      consoleApi(ctx, session ? `/messages?session=${encodeURIComponent(session)}` : '/messages'),
    )
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
    // The model stations are rebuilt from the sequence, never remembered: each assistant message
    // names the model that answered it, so where that name changes is exactly where a mark
    // belongs. That is what makes a model change survive a restart — or a conversation opened
    // for the first time in this page, which never saw the live event at all.
    let previousModel = null
    let previousProvider = ''
    for (const message of data.messages || []) {
      if (message.role === 'user') {
        ctx.items.push({ kind: 'user', text: textFromBlocks(message.content) })
      } else if (message.role === 'assistant') {
        const blocks = contentParts(message.content)
        const model = messageModelName(message, ctx, { resolveAlias: false })
        // Before the answer it changed for, the way the live stream draws it: the reader sees the
        // reply that is not from the model talking a line earlier. A historical message that
        // only names Hammer's `best` alias has no recoverable model, so it is left unset rather
        // than having today's route painted over an old turn.
        const provider = messageProviderName(message, ctx)
        if (model && previousModel && !sameAnswerIdentity(ctx, previousModel, model)) {
          ctx.items.push({
            kind: 'model',
            from: previousModel,
            to: model,
            fromProvider: previousProvider,
            toProvider: provider,
          })
        }
        if (model) {
          previousModel = model
          previousProvider = provider
        }
        // A turn that only called tools wrote no prose. Its tool rows carry that story, and an
        // empty bubble would sit in the transcript as "…" forever after a resume.
        if (blocks.length) {
          const item = { kind: 'assistant', blocks, settled: true, model, provider }
          // A remembered figure goes on first, so a provider-reported one can replace it and
          // an estimate only fills what neither the session file nor the memory has.
          applyRememberedThoughtStats(ctx, message, blocks)
          assignThinkingStats(item, message.usage?.reasoning)
          ctx.items.push(item)
        }
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (!part || part.type !== 'toolCall') continue
          const key = String(part.id || part.name || 'tool')
          // The row is created here, where the call was made — not at the end of the rebuild.
          // Unpaired calls used to be collected and pushed after the loop, which put every call
          // whose result never came back at the bottom of the transcript: an interrupted
          // command from earlier in the conversation sat underneath the final answer, reading
          // as a call the model had just made, and it was a different call each time. The call
          // happened at this point in the conversation, so its row belongs at this point.
          const item = {
            kind: 'tool',
            id: key,
            name: part.name || 'tool',
            args: part.arguments && typeof part.arguments === 'object' ? part.arguments : null,
            // A call that never returned — the turn was interrupted, or the app was closed
            // while the command ran — still happened, so it keeps its row. It is only
            // "running" when this console really has a turn in flight; a reopened session has
            // none, and a row that claims one is the stale spinner this settles instead.
            status: ctx.running ? 'running' : 'interrupted',
            result: '',
            partial: '',
          }
          calls.set(key, item)
          ctx.tools.set(key, item)
          ctx.items.push(item)
        }
      } else if (message.role === 'toolResult') {
        const key = String(message.toolCallId || message.toolName || 'tool')
        const call = calls.get(key)
        calls.delete(key)
        // A result whose call is not in this file — compacted away, or written by an older
        // build — still gets a row, in place, carrying what the result itself knows.
        const item = call || {
          kind: 'tool',
          id: key,
          name: message.toolName || 'tool',
          args: null,
          status: 'ok',
          result: '',
          partial: '',
        }
        item.status = message.isError ? 'error' : 'ok'
        item.result = resultText(message)
        item.partial = ''
        if (!call) {
          ctx.tools.set(key, item)
          ctx.items.push(item)
        }
      }
    }
    // A rebuilt transcript must hand the live stream the same base it compares against: the
    // last message that answered here, so the first new one is measured against it rather
    // than against a row or against nothing.
    ctx.lastAnswer = previousModel
      ? { model: previousModel, provider: previousProvider }
      : null
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
  async function attachConsole(entry, { focus = true } = {}) {
    const ctx = createConsole({
      id: entry.id,
      instanceId: entry.id,
      sessionFile: entry.sessionFile || null,
    })
    ctx.phase = entry.phase || 'idle'
    connectEvents(ctx)
    if (focus) activate(ctx)
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
  async function openInstance(sessionFile, { focus = true } = {}) {
    // A conversation has one console: opening it again focuses the one already running rather
    // than starting a second agent on the same session file.
    if (sessionFile) {
      const open = [...state.consoles.values()].find((ctx) => ctx.sessionFile === sessionFile)
      if (open) {
        if (focus) activate(open)
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
    if (res.status === 409) {
      // The conversation is already open — on the main console, usually, and the page may not
      // have been told which file that console is on yet. Asking it once turns "already open"
      // into the conversation appearing, instead of an error over a transcript that is there.
      const main = state.consoles.get('main')
      if (main) await refreshStatus(main)
      const open = [...state.consoles.values()].find((ctx) => ctx.sessionFile === sessionFile)
      if (open) {
        if (focus) activate(open)
        return open
      }
    }
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
    if (focus) activate(ctx)
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
      (candidate) =>
        candidate.instanceId &&
        !candidate.running &&
        candidate.id !== state.activeId &&
        !restoreProtected.has(candidate.id),
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
      // A compacting console is working too, so its row spins: a conversation that is being
      // summarised cannot be joined and sent to any more than one mid-turn can.
      if (
        entry.sessionFile &&
        (entry.phase === 'busy' || entry.isStreaming || entry.isCompacting === true)
      ) {
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
    { label: 'Compact the context', hint: '/compact', run: compactNow },
    { label: 'Stop the agent', hint: '/stop', run: stopRun },
    { label: 'Previous prompt', hint: 'Alt+↑', run: () => jumpPrompt(-1) },
    { label: 'Next prompt', hint: 'Alt+↓', run: () => jumpPrompt(1) },
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
        setDrawer('sessions', true)
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
      // The button that submitted says how the message is delivered. Enter takes the default,
      // which is the primary action: queued for the next turn if one is running, otherwise a
      // new one. Steer stays available as its own button for the reader who wants it now.
      sendPrompt(event.submitter?.dataset?.queueMode === 'steer' ? 'steer' : 'followUp')
    })

    const input = $('hx-input')
    input?.addEventListener('input', () => {
      autoGrow()
      // Every keystroke is one worth keeping: the draft survives a tab switch and a restart.
      saveDraft(active(), input.value)
      // ...and it decides whether there is anything to send, so the send control comes and goes
      // with the text rather than sitting there empty.
      updateComposer()
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

    // The queue's own controls, delegated: the strip is redrawn from state on every update, so a
    // listener per row would be thrown away with it.
    $('hx-queue-list')?.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-queue-act]') : null
      if (!(button instanceof HTMLButtonElement) || button.disabled) return
      const row = button.closest('li[data-queue-index]')
      const index = Number(row?.getAttribute('data-queue-index'))
      const ctx = active()
      if (!ctx || !Number.isInteger(index)) return
      const act = button.getAttribute('data-queue-act')
      if (act === 'edit') return beginQueueEdit(ctx, index)
      if (act === 'remove') return void changeQueue('remove', index)
      if (act === 'up' || act === 'down') {
        return void changeQueue('move', index, { direction: act === 'up' ? -1 : 1 })
      }
    })
    $('hx-thinking-slider')?.addEventListener('input', thinkingFromSlider)
    const slopeSlider = $('hx-slope-slider')
    slopeSlider?.addEventListener('input', slopeFromSlider)
    // The plot is a tooltip on the control: it appears when the thumb is taken or the slider is
    // focused, and leaves when either is let go. A click anywhere ends the drag, not only one
    // released over the track.
    slopeSlider?.addEventListener('pointerdown', () => showSlopePlot(Number(slopeSlider.value)))
    slopeSlider?.addEventListener('focus', () => showSlopePlot(Number(slopeSlider.value)))
    // A window that narrows while the panel is open would push it off the side again.
    window.addEventListener('resize', () => placeSlopePlot())
    slopeSlider?.addEventListener('blur', () => hideSlopePlot(300))
    slopeSlider?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      hideSlopePlot(0)
      slopeSlider.blur()
    })
    window.addEventListener('pointerup', () => {
      const pop = $('hx-slope-pop')
      if (!pop || pop.hidden) return
      // A minimum is being dragged, or the pointer is on the panel reading it: leave it up.
      if (slopeMinimaDrag || pop.matches(':hover')) return
      hideSlopePlot(900)
    })
    // The minimums are the router plot's edge lines, moved in here: while the panel is open it
    // takes the pointer, so the two lines can be dragged to say which rows the slope may choose
    // from. They are saved on the router, where they already live.
    const slopePop = $('hx-slope-pop')
    slopePop?.addEventListener('pointerdown', (event) => {
      const handle = event.target instanceof Element ? event.target.closest('[data-sel-drag]') : null
      if (!handle) return
      event.preventDefault()
      slopeMinimaDrag = handle.getAttribute('data-sel-drag')
      // Capture keeps the drag alive when the pointer leaves the panel. A released pointer throws
      // here, and losing capture is not worth losing the drag over.
      try {
        slopePop.setPointerCapture(event.pointerId)
      } catch {
        /* no capture, still draggable */
      }
      showSlopePlot(Number(slopeSlider?.value ?? 4))
    })
    slopePop?.addEventListener('pointermove', (event) => {
      if (slopeMinimaDrag) applySlopeMinimaDrag(event)
    })
    const endMinimaDrag = () => {
      if (!slopeMinimaDrag) return
      slopeMinimaDrag = null
      saveSlopeMinima()
    }
    slopePop?.addEventListener('pointerup', endMinimaDrag)
    slopePop?.addEventListener('pointercancel', endMinimaDrag)
    // Hovering the panel keeps it open; leaving it folds away the way letting go of the thumb does.
    slopePop?.addEventListener('pointerenter', () => {
      if (slopePlotHideTimer) {
        clearTimeout(slopePlotHideTimer)
        slopePlotHideTimer = null
      }
    })
    slopePop?.addEventListener('pointerleave', () => {
      if (!slopeMinimaDrag) hideSlopePlot(300)
    })
    // The router owns the minimums, so the lines start where routing already is.
    void loadSlopeMinima()
    // The notches come from the model table, which may not have been read yet.
    void loadKnownTtfts()

    // The outline rail on the transcript's right edge. Bound once; renderMinimap repaints it.
    bindMinimap()

    document.addEventListener('click', (event) => {
      if (!document.body.classList.contains('hx-drawer-open')) {
        if (!document.body.classList.contains('hx-sessions-drawer-open')) return
      }
      // A click inside the open drawer, or on the button that toggles it, is not a dismissal.
      if (event.target.closest('.hx-side')) return
      if (event.target.closest('#hx-toggle-details, #hx-toggle-sessions')) return
      closeDrawers()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawers()
    })
    // A drawer belongs to the narrow layout. Widening the window must not leave the body
    // claiming one is open, and the toggles then report the column state they control.
    const drawerQuery = window.matchMedia?.(DRAWER_QUERY)
    drawerQuery?.addEventListener?.('change', () => {
      closeDrawers()
      syncSidebarPressed()
    })
    $('hx-new')?.addEventListener('click', newSession)

    // Compaction controls. The toggle is hidden until Pi reports whether auto-compaction is
    // on, so an agent that cannot answer does not present a switch that would do nothing.
    // `$` is getElementById, so a selector has to be reached through the panel element: a
    // bare `$('[data-compaction-toggle]')` was null, which left both buttons unbound and the
    // panel looking live while doing nothing.
    const compactionPanel = $('hx-compaction-panel')
    compactionPanel
      ?.querySelector('[data-compaction-now]')
      ?.addEventListener('click', () => compactNow())
    compactionPanel?.querySelector('[data-compaction-toggle]')?.addEventListener('click', () => {
      const toggle = compactionPanel.querySelector('[data-compaction-toggle]')
      if (!toggle) return
      const next = toggle.getAttribute('aria-pressed') !== 'true'
      toggle.disabled = true
      // The pressed state is optimistic and provisional: the server's answer sets it for
      // real, and a Pi that ignores the request leaves it where the agent put it.
      Promise.resolve(setAutoCompaction(next)).finally(() => {
        toggle.disabled = false
      })
    })

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
      // Picking a conversation dismisses the drawer that listed it — through the same helper as
      // every other dismissal, so the toggle's pressed state cannot be left claiming it is open.
      closeDrawers()
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

    // A re-render replaces the element a disclosure lived in, so the open state the reader chose
    // has to live on the item. It is recorded from the click, never from the `toggle` event: a
    // running row is painted open, and the toggle the browser fires for the page's own `open`
    // attribute is indistinguishable from a reader opening it. Recording that made every
    // finished edit and thought stay open for the rest of the turn — only a restart, whose fresh
    // items carry no recorded state, folded them. The default action has not run when the click
    // arrives, so the state is read on the next frame.
    $('hx-transcript')?.addEventListener(
      'click',
      (event) => {
        const summary = event.target.closest?.('summary.hx-tool-head, summary.hx-thinking-head')
        const node = summary?.parentElement
        if (!node) return
        requestAnimationFrame(() => {
          if (node.classList?.contains('hx-thinking')) {
            // Thinking is one disclosure per reasoning block; the block keeps the state so a
            // repaint does not fold an opened thought (or reopen one the reader closed).
            const item = state.items.find((entry) => entry.node?.contains(node))
            if (!item) return
            const nodes = [...(item.node?.querySelectorAll('.hx-thinking') || [])]
            const block = thinkingBlocks(item)[nodes.indexOf(node)]
            // A thought shown in place has no disclosure: it is a div, so this path never sees it.
            if (block && !block.inline) block.open = node.open
            return
          }
          if (!node.classList?.contains('hx-tool')) return
          const item = state.items.find((entry) => entry.node?.contains(node))
          if (item) item.open = node.open
        })
      },
      true,
    )

    // The tool head doubles as a disclosure trigger and as selectable text. A drag that ends on
    // it would otherwise toggle the row closed/open as a side effect of copying, so swallow the
    // summary's default activation whenever the click is actually the end of a selection.
    $('hx-transcript')?.addEventListener(
      'click',
      (event) => {
        const summary = event.target.closest?.('summary.hx-tool-head, summary.hx-thinking-head')
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
        else closeDrawers()
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
    // The remembered tabs are reopened beside this one before the page settles on the
    // conversation it showed last. Until that pass finishes the rail has no conversation to
    // describe, so publishing is held back rather than painting each one on the way in.
    usageSettling = openFiles.size > 0
    const main = createConsole({ id: 'main' })
    state.activeId = null
    activate(main)
    watchConnectivity()
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
