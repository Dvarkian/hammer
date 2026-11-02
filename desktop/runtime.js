/**
 * @file runtime.js
 * @description Desktop-shell logic that never imports Electron, so `node --test` can exercise it
 * without a display. `desktop/main.js` supplies the windows, tray and dialogs.
 */

import net from 'node:net'

export const DEFAULT_DESKTOP_PORT = 7352
export const LOOPBACK_HOST = '127.0.0.1'

// Discovery runs before runServer() binds, so the window can wait a while on a cold start. The
// ceiling only exists so a wedged boot ends in a dialog with the log path instead of a spinner
// that never resolves.
const DEFAULT_READY_TIMEOUT_MS = 300_000
const DEFAULT_POLL_INTERVAL_MS = 500

/**
 * The window and the router share one origin, which is why the dashboard keeps using its
 * relative `/api/...` URLs unchanged inside the desktop app.
 */
export function dashboardUrl(port, host = LOOPBACK_HOST) {
  return `http://${host}:${port}/`
}

function toPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/**
 * Reads the few flags the desktop app understands. Deliberately not `lib/utils.parseArgs`:
 * Electron's argv is not the CLI's argv, and a malformed flag here must fall back to the default
 * port rather than leave the app unable to launch.
 */
export function parseDesktopArgs(argv = [], env = {}) {
  const args = { port: DEFAULT_DESKTOP_PORT, verbose: false, bannedModels: [] }
  const tokens = Array.isArray(argv) ? argv.slice(1).map(String) : []
  let portGiven = false

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1)
    const takeValue = () => (inlineValue !== undefined ? inlineValue : tokens[++i])

    if (flag === '--port') {
      const port = toPort(takeValue())
      if (port !== null) {
        args.port = port
        portGiven = true
      }
    } else if (flag === '--ban') {
      args.bannedModels = String(takeValue() || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    } else if (flag === '--verbose' || flag === '-v') {
      args.verbose = true
    }
  }

  // The env var is a fallback, not an override: an explicit flag on a desktop launcher wins.
  if (!portGiven) {
    const envPort = toPort(env?.HAMMER_PORT)
    if (envPort !== null) args.port = envPort
  }

  return args
}

function isHammerMeta(body) {
  return Boolean(body) && typeof body === 'object' && typeof body.version === 'string'
}

/**
 * Asks the port who it is. `/api/meta` is the cheapest endpoint that answers this: it is allowed on
 * loopback without a token, touches no provider state, and reports the version, so a different
 * server squatting on 7352 is distinguishable from Hammer.
 *
 * Returns the meta body, or null when nothing is listening or the answer is not Hammer.
 */
export async function probeRouter(
  baseUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {},
) {
  try {
    const response = await fetchImpl(new URL('api/meta', baseUrl), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json()
    return isHammerMeta(body) ? body : null
  } catch {
    // Connection refused while the listener is not up yet is the normal case, not a failure.
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for the router to answer, reporting progress so the splash can say how long it has been
 * discovering. `onPoll` is called after every failed attempt with the elapsed time.
 */
export async function waitForDashboard(
  baseUrl,
  {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    fetchImpl,
    onPoll = null,
    signal = null,
  } = {},
) {
  const startedAt = Date.now()
  let attempt = 0

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Startup was cancelled.')

    attempt += 1
    const meta = await probeRouter(baseUrl, {
      fetchImpl,
      timeoutMs: Math.max(1000, Math.min(4000, intervalMs * 4)),
    })
    if (meta) return meta

    if (onPoll) onPoll({ attempt, elapsedMs: Date.now() - startedAt })
    await sleep(intervalMs)
  }

  throw new Error(
    `Hammer did not answer on ${baseUrl} within ${Math.round(timeoutMs / 1000)}s. ` +
      'Check the log for a provider or configuration error.',
  )
}

/**
 * True when something is already listening on the port. Used to tell "an app I cannot use" apart
 * from "a router I can attach to", because runServer() exits the process on EADDRINUSE.
 */
export function isPortInUse(port, host = LOOPBACK_HOST, { timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (inUse) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(inUse)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
