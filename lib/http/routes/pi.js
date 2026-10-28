// @ts-check
/**
 * @file pi.js
 * @description The Pi coding-agent console: its status, its event stream, and its controls.
 *
 * The browser cannot talk to Pi directly — Pi is a child process speaking JSONL on
 * stdin/stdout. This module is the whole adaptation layer: one bridge per server process,
 * one SSE stream per open page, and three commands (prompt, abort, new session).
 *
 * The conversation is process-scoped, exactly like the child that owns it. A page that opens
 * mid-run gets the buffered events and the current status, so a reload does not lose the
 * transcript the agent is still writing to.
 *
 * Nothing here starts the agent on its own: the first status request does. The dashboard only
 * asks when the Pi tab is opened, so a router that nobody is watching the console on pays for
 * no child process.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} [ctx] the composition-root seed (see http/context.js); only
 *   `piBridge`, `piCommand`, `piArgs` and `piCwd` are read, because the console owns its state
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiBridge } from '../../pi/bridge.js'

const MAX_PROMPT_CHARS = 20_000
const KEEP_ALIVE_MS = 20_000

/** The Hammer install, not the directory the router happened to be started from. */
const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))

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
  const bridge =
    /** @type {PiBridge} */ (ctx.piBridge) ||
    new PiBridge({
      // Tests inject a stand-in executable and working directory; the app reads the
      // environment so a pi installed elsewhere (or a repo cloned elsewhere) still works.
      command: ctx.piCommand || process.env.HAMMER_PI_COMMAND || undefined,
      args: ctx.piArgs || undefined,
      cwd: ctx.piCwd || process.env.HAMMER_PI_CWD || PROJECT_ROOT,
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
    })
  })

  app.get('/api/pi/events', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    res.write(
      `data: ${JSON.stringify({ type: 'hello', status: bridge.status(), log: bridge.history() })}\n\n`,
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

  return bridge
}
