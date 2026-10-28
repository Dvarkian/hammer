// @ts-check
/**
 * @file pi.js
 * @description The Pi console: its status, its event stream, and its controls.
 *
 * The browser cannot talk to Pi directly — Pi is a child process speaking JSONL on
 * stdin/stdout. This module is the whole adaptation layer: one bridge per server process,
 * one SSE stream per open page, and the controls a harness needs (prompt, stop, new
 * session, restart, and an allowlisted RPC passthrough).
 *
 * The conversation is process-scoped, exactly like the child that owns it. A page that opens
 * mid-run gets the buffered events and the current status, so a reload does not lose the
 * transcript the agent is still writing to.
 *
 * Nothing here starts the agent on its own: the first status request does. The dashboard only
 * asks when the Pi tab is opened, so a router that nobody is watching the console on pays for
 * no child process.
 *
 * Free-standing dependencies (`piBridge`, `piCommand`, `piArgs`, `piCwd`, `piBaseUrl`,
 * `piAgentDir`) exist so a test can mount these routes without a real agent.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} [ctx] the composition-root seed (see http/context.js)
 */

import { PiBridge } from '../../pi/bridge.js'
import { planPiLaunch } from '../../pi/runtime.js'
import { ensureHarnessDirs, readPiSettings } from '../../pi/settings.js'

const MAX_PROMPT_CHARS = 20_000
const KEEP_ALIVE_MS = 20_000

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

  /** @type {PiBridge} */
  const bridge =
    /** @type {PiBridge} */ (ctx.piBridge) ||
    new PiBridge({
      // The overrides are the test seam; in the app the plan is the only source of truth.
      command: ctx.piCommand || plan.command || 'pi',
      args: ctx.piArgs || plan.args,
      cwd: ctx.piCwd || plan.cwd,
      env: plan.env,
      notes: plan.notes,
      // A plan that failed refuses the agent whatever the command override is: the overrides
      // are a test seam for *which* pi to run, not a way to run one on the wrong model.
      launchError: plan.error,
    })

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

  app.get('/api/pi/status', async (req, res) => {
    // Starting the child is part of answering: the tab has to say whether Pi is installed
    // *before* a prompt is attempted, or the first thing a user sees is a failed send.
    let session = null
    let error = null
    try {
      session = await bridge.describe()
    } catch (err) {
      error = /** @type {Error} */ (err)?.message || 'Could not start the Pi agent.'
    }
    res.json({
      ...bridge.status(),
      session,
      error: error || bridge.status().error,
      // Whether the agent takes its model from this router; false means a named model or a
      // replacement brain was configured.
      routed: plan.routed,
    })
  })

  app.get('/api/pi/events', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    res.write(
      `data: ${JSON.stringify({ type: 'hello', status: bridge.status(), log: bridge.history(), routed: plan.routed })}\n\n`,
    )
    subscribers.add(res)
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        /* dropped on close below */
      }
    }, KEEP_ALIVE_MS)
    const drop = () => {
      clearInterval(keepAlive)
      subscribers.delete(res)
    }
    req.on('close', drop)
    res.on('close', drop)
  })

  app.post('/api/pi/prompt', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!message) return res.status(400).json({ error: 'A message is required.' })
    if (message.length > MAX_PROMPT_CHARS) {
      return res
        .status(413)
        .json({ error: `A prompt may be at most ${MAX_PROMPT_CHARS} characters.` })
    }

    try {
      const record = await bridge.prompt(message)
      return res.json({ success: true, disposition: record.data?.disposition || 'started' })
    } catch (err) {
      const unavailable = bridge.status().available === false
      return res
        .status(unavailable ? 503 : 502)
        .json({ error: /** @type {Error} */ (err)?.message || 'Pi rejected the prompt.' })
    }
  })

  app.post('/api/pi/abort', async (req, res) => {
    try {
      await bridge.abort()
      return res.json({ success: true })
    } catch (err) {
      return res
        .status(502)
        .json({ error: /** @type {Error} */ (err)?.message || 'Could not stop Pi.' })
    }
  })

  app.post('/api/pi/reset', async (req, res) => {
    try {
      const record = await bridge.reset()
      return res.json({ success: true, cancelled: record.data?.cancelled === true })
    } catch (err) {
      return res
        .status(502)
        .json({ error: /** @type {Error} */ (err)?.message || 'Could not start a new session.' })
    }
  })

  app.post('/api/pi/restart', async (req, res) => {
    try {
      const status = await bridge.restart()
      return res.json({ success: true, status })
    } catch (err) {
      return res
        .status(502)
        .json({ error: /** @type {Error} */ (err)?.message || 'Could not restart Pi.' })
    }
  })

  app.post('/api/pi/command', async (req, res) => {
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : ''
    const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {}
    if (!command) return res.status(400).json({ error: 'A command is required.' })
    try {
      const record = await bridge.runCommand(command, args)
      return res.json({ success: true, response: record })
    } catch (err) {
      const message = /** @type {Error} */ (err)?.message || 'Pi rejected the command.'
      // "not allowed" is the caller's mistake; anything else is the agent's.
      return res.status(/not allowed/i.test(message) ? 400 : 502).json({ error: message })
    }
  })

  return bridge
}
