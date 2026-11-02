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
import { ensureHarnessDirs, readPiSettings } from '../../pi/settings.js'
import { listSessions, resolveSessionReference, sessionLabel, summarizeSession } from '../../pi/sessions.js'

const MAX_PROMPT_CHARS = 20_000
const KEEP_ALIVE_MS = 20_000
const MAX_INSTANCES = 4

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
    for (const owned of livingBridges) owned.dispose()
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
   */
  const makeBridge = (sessionFile) => {
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
    })
  }

  /**
   * One console: a bridge plus the SSE subscribers watching it. The wiring is identical for
   * the main console and every parallel one — only the child and its session differ.
   * @param {PiBridge} bridge
   */
  const makeConsole = (bridge) => {
    ownBridge(bridge)

    /** @type {Set<import('express').Response>} */
    const subscribers = new Set()

    /** @param {any} payload */
    const broadcast = (payload) => {
      const frame = `data: ${JSON.stringify(payload)}\n\n`
      for (const res of subscribers) {
        try {
          res.write(frame)
        } catch {
          subscribers.delete(res)
        }
      }
    }

    bridge.on('event', (record) => broadcast({ type: 'event', record }))
    bridge.on('exit', (info) => broadcast({ type: 'exit', ...info }))
    bridge.on('status', (status) => broadcast({ type: 'status', status }))
    bridge.on('usage', (usage) => broadcast({ type: 'usage', ...usage }))
    bridge.on('log', (entry) => broadcast({ type: 'log', ...entry }))
    bridge.on('protocol-error', (text) => broadcast({ type: 'notice', text }))
    return { bridge, subscribers, broadcast }
  }

  /** The main console. The `piBridge` override is the test seam for the whole console. */
  const main = makeConsole(
    /** @type {PiBridge} */ (ctx.piBridge) || makeBridge(null),
  )

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
  const mountConsoleRoutes = (base, /** @type {(req: any) => ReturnType<typeof makeConsole> | null} */ resolve) => {
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
        `data: ${JSON.stringify({ type: 'hello', status: console.bridge.status(), log: console.bridge.history(), routed: plan.routed })}\n\n`,
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

      try {
        const record = await console.bridge.prompt(message)
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
        await console.bridge.abort()
        return res.json({ success: true })
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
        return res.status(400).json({ error: /** @type {Error} */ (err)?.message || 'Unknown session.' })
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
        return res
          .status(502)
          .json({ error: /** @type {Error} */ (err)?.message || 'Could not read the conversation.' })
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

  // ── Parallel consoles ────────────────────────────────────────────────────────────────

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
        return res.status(400).json({ error: /** @type {Error} */ (err)?.message || 'Unknown session.' })
      }
    }
    if (instances.size >= MAX_INSTANCES) {
      return res
        .status(429)
        .json({ error: `At most ${MAX_INSTANCES} parallel sessions can run at once.` })
    }
    const id = randomUUID().slice(0, 8)
    const console = makeConsole(makeBridge(sessionPath))
    instances.set(id, { id, sessionFile: sessionPath, console })
    // Describing starts the child now, so the tab renders immediately instead of on its first
    // poll; a launch failure is reported through `status.error` like everywhere else.
    await console.bridge.describe().catch(() => {})
    res.json({ success: true, id, instance: instanceInfo({ id, sessionFile: sessionPath, console }) })
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
