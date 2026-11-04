// @ts-check
/**
 * @file pi.js
 * @description The Pi console: its status, its event stream, and its controls.
 *
 * The browser cannot talk to Pi directly — Pi is a child process speaking JSONL on
 * stdin/stdout. This module is the whole adaptation layer: one bridge per console, one SSE
 * stream per open page, and the controls a harness needs (prompt, stop, new session,
 * restart, and an allowlisted RPC passthrough).
 *
 * A conversation outlives the process that produced it — pi persists every session as JSONL
 * in the session store (lib/pi/sessions.js reads it back) — so the console can do three
 * things with that: resume a past session in place, list what is in the store, and open a
 * second session in *parallel* by running a second child beside the first. Parallel
 * consoles live under `/api/pi/instances/:id/…`, each with its own bridge and its own
 * subscribers; the default routes without an id are the main console.
 *
 * Nothing here starts the agent on its own: the first status request does. The dashboard
 * only asks when the Pi tab is opened, so a router that nobody is watching the console on
 * pays for no child process.
 *
 * Free-standing dependencies (`piBridge`, `piCommand`, `piArgs`, `piCwd`, `piBaseUrl`,
 * `piAgentDir`) exist so a test can mount these routes without a real agent.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} [ctx] the composition-root seed (see http/context.js)
 */

import { randomUUID } from 'node:crypto'
import { PiBridge } from '../../pi/bridge.js'
import { planPiLaunch } from '../../pi/runtime.js'
import {
  materializeSupervisor,
  supervisorScriptPath,
  supervisorSocketPath,
} from '../../pi/supervisor.js'
import { ensureHarnessDirs, readPiSettings } from '../../pi/settings.js'
import {
  appendSessionName,
  listSessions,
  resolveSessionReference,
  sessionLabel,
  summarizeSession,
} from '../../pi/sessions.js'

const MAX_PROMPT_CHARS = 20_000
const KEEP_ALIVE_MS = 20_000
// Parallel consoles used to be hard-capped at four, which turned a full UI into silent no-ops:
// the page cannot free a console it does not know about, so New session and opening an old
// conversation both failed with 429 and looked dead. There is no arbitrary ceiling now. Set
// this to a positive number only if you want a guard against a runaway loop spawning agents
// without bound.
const MAX_INSTANCES = Number(process.env.HAMMER_PI_MAX_INSTANCES) || 0

/**
 * Bridges that still need shutting down. They are children of this process, so they must not
 * outlive it; one hook covers every bridge a test or a restart creates.
 * @type {Set<PiBridge>}
 */
const livingBridges = new Set()
let exitHookInstalled = false

/** @param {PiBridge} bridge */
function ownBridge(bridge) {
  livingBridges.add(bridge)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    // A release, not a disposal: a supervised agent outlives this process on purpose, which is
    // what lets a restart — or a rebuilt app relaunched — happen in the middle of a turn. Its
    // keeper stops it once no router has been attached for its idle window, so nothing is left
    // behind by a Hammer that never comes back. This hook runs while the process is leaving, so
    // it must never throw: a bridge that only knows `dispose` (a stand-in in a test) is stopped.
    for (const owned of livingBridges) {
      try {
        if (typeof owned.release === 'function') owned.release()
        else owned.dispose()
      } catch {
        // Nothing left to save.
      }
    }
    livingBridges.clear()
  })
}

export function registerPiRoutes(app, ctx = {}) {
  // The router's own OpenAI-compatible base. Given one, the agent runs on a private Pi
  // configuration whose only provider is this router (see lib/pi/agent-dir.js), which is
  // what makes its model Hammer's current selection rather than Pi's own default.
  const baseUrl = ctx.piBaseUrl || process.env.HAMMER_PI_BASE_URL || ''
  const settings = readPiSettings()
  // The store's location is a test seam: route tests write a few JSONL files into a temp dir
  // rather than reading the developer's real session store.
  if (ctx.piSessionsDir) settings.sessions = ctx.piSessionsDir
  const plan = planPiLaunch(settings, {
    baseUrl,
    agentDir: ctx.piAgentDir || undefined,
  })
  try {
    ensureHarnessDirs(settings)
  } catch (err) {
    // A session directory the console cannot create costs the user the console, not the
    // router; the launch plan below reports it like any other launch failure.
    if (!plan.error)
      plan.error = `Could not create the Pi session directory: ${/** @type {Error} */ (err)?.message || err}`
    plan.command = null
  }

  /**
   * What `best` resolves to right now: the model, and the provider offering it.
   *
   * Pi's own name for Hammer's alias is "Hammer's selected model", which describes the mechanism
   * instead of naming the model that answers. The composer owns the routing state this module
   * deliberately does not, so the composer is what gets asked (see lib/server.js).
   */
  const routedSelection = () => {
    if (!plan.routed || typeof ctx.routedSelection !== 'function') return null
    try {
      return ctx.routedSelection() || null
    } catch {
      // A caption is not worth failing a status request over.
      return null
    }
  }

  // The keeper that owns the agent's pipes, so a router restart does not end a turn (see
  // lib/pi/supervisor.js). Tests that inject a launch keep running directly: a test must not
  // leave a detached process behind, and a fake child has nothing worth surviving.
  const supervised =
    !ctx.piBridge &&
    !ctx.piCommand &&
    !ctx.piArgs &&
    !ctx.piCwd &&
    process.env.HAMMER_PI_SUPERVISOR !== '0'
  /** The console's name on disk: one keeper per router port. */
  const consoleKey = (() => {
    try {
      return new URL(baseUrl).port || 'default'
    } catch {
      return 'default'
    }
  })()
  /** @type {{ script: string, node: string } | null} */
  let keeper = null
  if (supervised && !plan.error) {
    try {
      keeper = {
        // Copied out of the install: a packaged Hammer keeps its modules in an asar archive,
        // and a plain Node cannot read one.
        script: materializeSupervisor(supervisorScriptPath(settings.agentRoot)),
        node: plan.node || process.execPath,
      }
    } catch (err) {
      // Without a keeper the console still works; it just cannot outlive a restart.
      plan.notes.push(
        `the agent cannot survive a restart: ${/** @type {Error} */ (err)?.message || err}`,
      )
    }
  }

  /** The launch every console of this registration shares; `args` gains `--session` per console. */
  const launch = {
    command: ctx.piCommand || plan.command || 'pi',
    baseArgs: ctx.piArgs || plan.args,
    cwd: ctx.piCwd || plan.cwd,
    env: plan.env,
    notes: plan.notes,
    launchError: plan.error,
  }

  /**
   * @param {string|null} sessionFile attach the new bridge to this session file, or let pi
   *   start a fresh one
   * @param {string} [key] this console's name on disk; the main console keeps the port's own so
   *   a restarted router finds the agent it was running, parallel consoles get their own
   */
  const makeBridge = (sessionFile, key = consoleKey) => {
    const args = sessionFile ? [...launch.baseArgs, '--session', sessionFile] : launch.baseArgs
    return new PiBridge({
      // The overrides are the test seam; in the app the plan is the only source of truth.
      command: launch.command,
      args,
      cwd: launch.cwd,
      env: launch.env,
      notes: launch.notes,
      // A plan that failed refuses the agent whatever the command override is: the overrides
      // are a test seam for *which* pi to run, not a way to run one on the wrong model.
      launchError: launch.launchError,
      supervisor: keeper
        ? {
            script: keeper.script,
            node: keeper.node,
            socket: supervisorSocketPath(settings.agentRoot, key),
            idleMs: Number(process.env.HAMMER_PI_SUPERVISOR_IDLE_MS) || undefined,
          }
        : null,
    })
  }

  /**
   * Pages watching every console over one connection. A console still has its own subscribers
   * for the per-console route, but the page uses this stream: one EventSource for all of them.
   * @type {Set<import('express').Response>}
   */
  const consoleStreams = new Set()

  /**
   * One console: a bridge plus the SSE subscribers watching it. The wiring is identical for
   * the main console and every parallel one — only the child and its session differ.
   * @param {PiBridge} bridge
   * @param {string} [id] the name a multiplexed frame carries for this console
   */
  const makeConsole = (bridge, id = 'main') => {
    ownBridge(bridge)

    /** @type {Set<import('express').Response>} */
    const subscribers = new Set()

    /** @param {any} payload */
    const broadcast = (payload) => {
      const frame = `data: ${JSON.stringify(payload)}\n\n`
      // The page-level stream carries every console, so its frames name the one they belong to.
      const tagged = `data: ${JSON.stringify({ consoleId: id, ...payload })}\n\n`
      for (const res of subscribers) {
        try {
          res.write(frame)
        } catch {
          subscribers.delete(res)
        }
      }
      for (const res of consoleStreams) {
        try {
          res.write(tagged)
        } catch {
          consoleStreams.delete(res)
        }
      }
    }

    bridge.on('event', (record) => broadcast({ type: 'event', record }))
    bridge.on('exit', (info) => broadcast({ type: 'exit', ...info }))
    // The routed pick rides along with the status, so the strip follows a fallback, a pin or a
    // slope change without the page having to ask the catalog again.
    bridge.on('status', (status) =>
      broadcast({ type: 'status', status: { ...status, routedModel: routedSelection() } }),
    )
    bridge.on('usage', (usage) => broadcast({ type: 'usage', ...usage }))
    bridge.on('log', (entry) => broadcast({ type: 'log', ...entry }))
    bridge.on('protocol-error', (text) => broadcast({ type: 'notice', text }))
    return { bridge, subscribers, broadcast }
  }

  /** The main console. The `piBridge` override is the test seam for the whole console. */
  const main = makeConsole(/** @type {PiBridge} */ (ctx.piBridge) || makeBridge(null), 'main')

  /**
   * Parallel consoles, created on demand. Keyed by a short id the page carries in its URL
   * hash, so a parallel session survives a reload.
   * @type {Map<string, { id: string, sessionFile: string | null, console: ReturnType<typeof makeConsole> }>}
   */
  const instances = new Map()

  /** @returns {Record<string, any>} the JSON a listing row needs */
  const instanceInfo = (entry) => {
    const status = entry.console.bridge.status()
    return {
      ...status,
      id: entry.id,
      // A just-created console has not reported a session yet; what it was opened onto is
      // the answer until the bridge knows better.
      sessionFile: status.sessionFile || entry.sessionFile,
    }
  }

  /** Resolves what a caller clicked into one session file inside the store, or throws. */
  const resolveClicked = (reference) => {
    const value = typeof reference === 'string' ? reference.trim() : ''
    if (!value) throw new Error('A session path or id is required.')
    return resolveSessionReference(settings.sessions, value)
  }

  /**
   * Finds a console that is attached to this session file, on the main route or as a
   * parallel console. A rename is a `session_info` entry in a file the agent may have open;
   * the bridge must be told the new name or it will keep reporting the old one until the
   * next `session_info_changed` event happens to arrive.
   * @param {string} sessionPath
   * @returns {PiBridge | null}
   */
  const bridgeForSession = (sessionPath) => {
    if (main.bridge.status().sessionFile === sessionPath) return main.bridge
    for (const entry of instances.values()) {
      if (entry.console.bridge.status().sessionFile === sessionPath) return entry.console.bridge
    }
    return null
  }

  /**
   * Resume on a console: an RPC switch when the agent can answer one, a restart into
   * `--session` when it is mid-run or dead. Returns which path was taken.
   */
  const resumeConsole = async (console, sessionPath) => {
    const summary = summarizeSession(sessionPath)
    if (console.bridge.status().isStreaming) {
      await console.bridge.restartTo(sessionPath, {
        message: `Resumed session: ${sessionLabel(summary)}`,
      })
      return 'restarted'
    }
    const record = await console.bridge.switchSession(sessionPath)
    if (record.data?.cancelled === true) return 'cancelled'
    console.bridge.addNote(`Resumed session: ${sessionLabel(summary)}`)
    return 'switched'
  }

  /** The routes one console serves, resolved per request so instance routes share them. */
  const mountConsoleRoutes = (
    base,
    /** @type {(req: any) => ReturnType<typeof makeConsole> | null} */ resolve,
  ) => {
    app.get(`${base}/status`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      // Starting the child is part of answering: the tab has to say whether Pi is installed
      // *before* a prompt is attempted, or the first thing a user sees is a failed send.
      let session = null
      let error = null
      try {
        session = await console.bridge.describe()
      } catch (err) {
        error = /** @type {Error} */ (err)?.message || 'Could not start the Pi agent.'
      }
      res.json({
        ...console.bridge.status(),
        session,
        error: error || console.bridge.status().error,
        // Whether the agent takes its model from this router; false means a named model or a
        // replacement brain was configured.
        routed: plan.routed,
        routedModel: routedSelection(),
      })
    })

    app.get(`${base}/events`, (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      res.write(
        `data: ${JSON.stringify({ type: 'hello', status: console.bridge.status(), log: console.bridge.history(), routed: plan.routed, routedModel: routedSelection() })}\n\n`,
      )
      console.subscribers.add(res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {
          /* dropped on close below */
        }
      }, KEEP_ALIVE_MS)
      const drop = () => {
        clearInterval(keepAlive)
        console.subscribers.delete(res)
      }
      req.on('close', drop)
      res.on('close', drop)
    })

    app.post(`${base}/prompt`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      if (!message) return res.status(400).json({ error: 'A message is required.' })
      if (message.length > MAX_PROMPT_CHARS) {
        return res
          .status(413)
          .json({ error: `A prompt may be at most ${MAX_PROMPT_CHARS} characters.` })
      }
      // `followUp` holds the message until the running turn *completes*; anything else
      // steers, which is what a caller that names nothing has always meant.
      const queueMode = req.body?.queueMode === 'followUp' ? 'followUp' : 'steer'
      // Attached images pass through shape-checked: the bridge owns the real validation, but
      // a non-array here is a malformed call, not an attachment.
      const images = req.body?.images == null ? undefined : req.body.images

      try {
        const record = await console.bridge.prompt(message, { queueMode, images })
        return res.json({ success: true, disposition: record.data?.disposition || 'started' })
      } catch (err) {
        const unavailable = console.bridge.status().available === false
        return res
          .status(unavailable ? 503 : 502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Pi rejected the prompt.' })
      }
    })

    app.post(`${base}/abort`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      try {
        const record = await console.bridge.abort()
        // What Stop threw away, so the page can say "2 queued messages removed" rather than
        // let the sender assume the words went through.
        return res.json({ success: true, clearedQueue: record.clearedQueue })
      } catch (err) {
        return res
          .status(502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Could not stop Pi.' })
      }
    })

    app.post(`${base}/reset`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      try {
        const record = await console.bridge.reset()
        return res.json({ success: true, cancelled: record.data?.cancelled === true })
      } catch (err) {
        return res
          .status(502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Could not start a new session.' })
      }
    })

    app.post(`${base}/restart`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      try {
        const status = await console.bridge.restart()
        return res.json({ success: true, status })
      } catch (err) {
        return res
          .status(502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Could not restart Pi.' })
      }
    })

    // Resume another session on this console. The transcript a page already holds is wrong
    // the moment the underlying session changes, so the response says which session is now
    // attached and the page rebuilds from `get_messages`.
    app.post(`${base}/sessions/open`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      if (launch.launchError) return res.status(503).json({ error: launch.launchError })
      let sessionPath
      try {
        sessionPath = resolveClicked(req.body?.session)
      } catch (err) {
        return res
          .status(400)
          .json({ error: /** @type {Error} */ (err)?.message || 'Unknown session.' })
      }
      try {
        const mode = await resumeConsole(console, sessionPath)
        return res.json({ success: true, mode, sessionFile: sessionPath })
      } catch (err) {
        return res
          .status(502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Could not resume that session.' })
      }
    })

    // The full message list of the attached session, for rebuilding a transcript after a
    // resume or for catching a page up beyond the bridge's bounded replay log.
    app.get(`${base}/messages`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      try {
        const record = await console.bridge.runCommand('get_messages')
        return res.json({ success: true, messages: record.data?.messages || [] })
      } catch (err) {
        return res.status(502).json({
          error: /** @type {Error} */ (err)?.message || 'Could not read the conversation.',
        })
      }
    })

    app.post(`${base}/command`, async (req, res) => {
      const console = resolve(req)
      if (!console) return res.status(404).json({ error: 'No such console.' })
      const command = typeof req.body?.command === 'string' ? req.body.command.trim() : ''
      const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {}
      if (!command) return res.status(400).json({ error: 'A command is required.' })
      try {
        const record = await console.bridge.runCommand(command, args)
        return res.json({ success: true, response: record })
      } catch (err) {
        const message = /** @type {Error} */ (err)?.message || 'Pi rejected the command.'
        // "not allowed" is the caller's mistake; anything else is the agent's.
        return res.status(/not allowed/i.test(message) ? 400 : 502).json({ error: message })
      }
    })
  }

  // ── The session store ────────────────────────────────────────────────────────────────

  app.get('/api/pi/sessions', (req, res) => {
    // Rows are cheap summaries; a page refresh re-reads them, so the store is never cached
    // here. An unreadable file still appears — it exists, and deleting it is the user's call.
    const sessions = listSessions(settings.sessions).map((session) => ({
      file: session.file,
      fileName: session.fileName,
      sessionId: session.sessionId,
      name: session.name,
      preview: session.preview,
      label: sessionLabel(session),
      cwd: session.cwd,
      timestamp: session.timestamp,
      modifiedMs: session.modifiedMs,
      size: session.size,
      userMessages: session.userMessages,
      assistantMessages: session.assistantMessages,
      toolCalls: session.toolCalls,
      truncated: session.truncated,
    }))
    res.json({ sessions, current: main.bridge.status().sessionFile })
  })

  // Rename a saved session. The write is the same append pi's `/name` performs — one
  // `session_info` entry — so no agent restart is needed. A console attached to that file
  // has its bridge state updated in place, and its page learns the change through the
  // ordinary status broadcast.
  app.post('/api/pi/sessions/rename', (req, res) => {
    let sessionPath
    try {
      sessionPath = resolveClicked(req.body?.session)
    } catch (err) {
      return res
        .status(400)
        .json({ error: /** @type {Error} */ (err)?.message || 'Unknown session.' })
    }
    try {
      const summary = appendSessionName(sessionPath, req.body?.name)
      const bridge = bridgeForSession(sessionPath)
      if (bridge) {
        bridge.state.sessionName = summary.name
        if (!bridge.disposed) bridge.emit('status', bridge.status())
      }
      res.json({ success: true, sessionFile: sessionPath, label: sessionLabel(summary) })
    } catch (err) {
      res
        .status(400)
        .json({ error: /** @type {Error} */ (err)?.message || 'Could not rename that session.' })
    }
  })

  // ── Parallel consoles ────────────────────────────────────────────────────────────────

  // One stream for every console.
  //
  // Each console used to keep its own EventSource open, and Chromium allows only six HTTP/1.1
  // connections per host. The main console, four parallel consoles and the router's telemetry
  // stream filled all six, so the next request — a prompt — waited for a socket that never came
  // and the page sat on "Sending…". That budget, not an arbitrary number, is why the old cap was
  // four. This carries every console over one connection instead.
  app.get('/api/pi/consoles/events', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    const consoles = [
      { id: 'main', status: main.bridge.status(), log: main.bridge.history() },
      ...[...instances.values()].map((entry) => ({
        id: entry.id,
        status: entry.console.bridge.status(),
        log: entry.console.bridge.history(),
      })),
    ]
    res.write(`data: ${JSON.stringify({ type: 'hello', consoles })}\n\n`)
    consoleStreams.add(res)
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        /* dropped on close below */
      }
    }, KEEP_ALIVE_MS)
    const drop = () => {
      clearInterval(keepAlive)
      consoleStreams.delete(res)
    }
    req.on('close', drop)
    res.on('close', drop)
  })

  app.get('/api/pi/instances', (req, res) => {
    res.json({ instances: [...instances.values()].map(instanceInfo) })
  })

  // Open a session beside the main console: a second child on its own session file. An empty
  // `session` starts a fresh conversation instead — a scratch console.
  app.post('/api/pi/instances', async (req, res) => {
    if (launch.launchError) return res.status(503).json({ error: launch.launchError })
    let sessionPath = null
    const reference = typeof req.body?.session === 'string' ? req.body.session.trim() : ''
    if (reference) {
      try {
        sessionPath = resolveClicked(reference)
      } catch (err) {
        return res
          .status(400)
          .json({ error: /** @type {Error} */ (err)?.message || 'Unknown session.' })
      }
    }
    // One agent per session file. Two would each append to the same transcript without seeing
    // the other's turns, so an existing console for that session is reused — and the main
    // console's session is not opened twice either, whichever page asks.
    if (sessionPath) {
      const existing = [...instances.values()].find((entry) => entry.sessionFile === sessionPath)
      if (existing) {
        return res.json({
          success: true,
          reused: true,
          id: existing.id,
          instance: instanceInfo(existing),
        })
      }
      if (main.bridge.status().sessionFile === sessionPath) {
        return res.status(409).json({ error: 'That conversation is already open.' })
      }
    }
    if (MAX_INSTANCES > 0 && instances.size >= MAX_INSTANCES) {
      return res
        .status(429)
        .json({ error: `At most ${MAX_INSTANCES} parallel sessions can run at once.` })
    }
    const id = randomUUID().slice(0, 8)
    const console = makeConsole(makeBridge(sessionPath, `${consoleKey}-${id}`), id)
    instances.set(id, { id, sessionFile: sessionPath, console })
    // Describing starts the child now, so the tab renders immediately instead of on its first
    // poll; a launch failure is reported through `status.error` like everywhere else.
    await console.bridge.describe().catch(() => {})
    res.json({
      success: true,
      id,
      instance: instanceInfo({ id, sessionFile: sessionPath, console }),
    })
  })

  app.post('/api/pi/instances/:id/close', (req, res) => {
    const entry = instances.get(req.params.id)
    if (!entry) return res.status(404).json({ error: 'No such parallel session.' })
    instances.delete(req.params.id)
    entry.console.bridge.dispose()
    res.json({ success: true })
  })

  mountConsoleRoutes('/api/pi', () => main)
  mountConsoleRoutes('/api/pi/instances/:id/console', (req) => {
    const entry = instances.get(req.params.id)
    return entry ? entry.console : null
  })

  return main.bridge
}
