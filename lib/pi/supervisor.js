// @ts-check
/**
 * @file supervisor.js
 * @description The keeper that owns the agent's pipes, so a router restart is not a turn's end.
 *
 * The agent is a child of the router: `pi --mode rpc` writes one JSON object per line to
 * stdout and reads commands from stdin. Those pipes belong to whoever spawned it, so when the
 * router exits — the dashboard's Restart, a rebuilt desktop app, a crash — the child's stdin
 * closes and the turn dies with it. That is why a change to Hammer could not be shipped while
 * an agent was working in it, and it is the whole reason this file exists.
 *
 * The keeper is spawned detached, holds the child's stdio, and speaks a small line protocol
 * over a socket. The router is a client, not a parent: kill it, start a new one, and the child
 * — and the turn it is running — never notices. The new router attaches to the same socket and
 * carries on. The client lives in this file too, so the protocol has one home.
 *
 * Three decisions keep it small enough to trust:
 *
 * 1. **It holds no policy.** No restart schedule, no phase, no usage accounting; the bridge
 *    keeps all of that. This process spawns, relays, reports exits, and gets out of the way.
 * 2. **One controller at a time.** A second `attach` takes over and tells the previous client
 *    it was detached. Two routers relaying one child would duplicate every record.
 * 3. **It cannot outlive its usefulness.** With no client attached for `--idle-ms` (ten
 *    minutes by default) it stops the child and exits, so a router that was never restarted
 *    leaves no agent behind. `shutdown` stops it at once.
 *
 * It is copied out of the install before it runs (`materializeSupervisor`): a packaged Hammer
 * keeps its modules inside `app.asar`, which a plain `node` cannot read.
 *
 * Wire protocol, one JSON object per LF-terminated line:
 *
 *   client → keeper   {op:'ping'}                 → {ok, child}
 *                     {op:'attach'}               → {ok, child, replay:[line…], protocol}
 *                     {op:'spawn', command, args, cwd, env} → {ok, pid, argv}
 *                     {op:'kill', signal}         → {ok}
 *                     {op:'stdin', line}          → (no reply)
 *                     {op:'detach'}               → {ok}
 *                     {op:'shutdown'}             → {ok}, then exit
 *   keeper → client   {type:'res', opId, ok, error?, …}     a reply to one of the above
 *                     {type:'out', line}                     one complete stdout line
 *                     {type:'stderr', text}
 *                     {type:'exit', code, signal}
 *                     {type:'spawned', pid, argv}
 *                     {type:'detached', reason}
 *                     {type:'protocol-error', text}
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect as netConnect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUPERVISOR_PROTOCOL = 1

const MAX_LINE_BYTES = 8 * 1024 * 1024
const REPLAY_LIMIT = 400
const REPLAY_MAX_CHARS = 512 * 1024
const STDERR_LIMIT = 4_000
const KILL_GRACE_MS = 2_000
const DEFAULT_IDLE_MS = 600_000
const CONNECT_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 20_000

const SELF = fileURLToPath(import.meta.url)

/** Where the executed copy of this file lives. */
export function supervisorScriptPath(agentRoot) {
  return join(agentRoot, 'bin', 'supervisor.mjs')
}

/**
 * The address a router and its agent meet on: one per console.
 * @param {string} agentRoot
 * @param {string} key the console's name, `7352` for the main one on that port
 */
export function supervisorSocketPath(agentRoot, key) {
  const slug = String(key || 'main').replace(/[^a-zA-Z0-9_-]/g, '-')
  if (process.platform === 'win32') return `\\\\.\\pipe\\hammer-pi-${slug}`
  return join(agentRoot, 'sockets', `${slug}.sock`)
}

/**
 * Writes this module out where a plain Node can run it, and only when it changed — a router
 * restart must not churn a file. Reading the module itself works inside an asar archive
 * because Electron patches `fs` for the process that runs the router.
 * @param {string} scriptPath
 * @returns {string} the path to run
 */
export function materializeSupervisor(scriptPath) {
  const source = readFileSync(SELF, 'utf8')
  mkdirSync(dirname(scriptPath), { recursive: true })
  let current = null
  try {
    current = readFileSync(scriptPath, 'utf8')
  } catch {
    // First copy.
  }
  if (current !== source) writeFileSync(scriptPath, source, { mode: 0o600 })
  return scriptPath
}

/**
 * Whether something is listening on this address. A stale socket file from a killed keeper
 * answers with ECONNREFUSED, which is a "no" — and the caller may then unlink it.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isLive(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    /** @type {import('node:net').Socket} */
    const socket = netConnect(socketPath)
    let settled = false
    /** @param {boolean} live */
    const done = (live) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
      resolve(live)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs)
  })
}

/**
 * The router's end of the conversation with a keeper.
 *
 * Frames that arrive before `resume()` are held rather than dropped: the bridge has to wire its
 * listeners and read the `attach` reply before it can act on a single record, and a keeper that
 * is mid-turn is writing the whole time.
 */
export class SupervisorClient extends EventEmitter {
  /**
   * @param {string} socketPath
   * @param {{ connectTimeoutMs?: number }} [options]
   */
  constructor(socketPath, { connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    super()
    this.socketPath = socketPath
    this.connectTimeoutMs = connectTimeoutMs
    /** @type {import('node:net').Socket | null} */
    this.socket = null
    this.buffer = ''
    this.seq = 0
    /** @type {Map<string, { resolve: (frame: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
    this.waiters = new Map()
    /** @type {any[]} */
    this.queued = []
    this.paused = true
    this.closed = false
    /** @type {{ pid: number | null, argv: string[] } | null} */
    this.childInfo = null
  }

  /**
   * @param {string} socketPath
   * @param {{ connectTimeoutMs?: number }} [options]
   * @returns {Promise<SupervisorClient>}
   */
  static connect(socketPath, options = {}) {
    const client = new SupervisorClient(socketPath, options)
    return client.open().then(() => client)
  }

  /** @returns {{ pid: number | null, argv: string[] } | null} */
  get child() {
    return this.childInfo
  }

  /** @returns {Promise<void>} */
  open() {
    return new Promise((resolve, reject) => {
      const socket = netConnect(this.socketPath)
      this.socket = socket
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        socket.on('error', () => {})
        socket.destroy()
        reject(err)
      }
      socket.setTimeout(this.connectTimeoutMs)
      socket.once('timeout', () => fail(new Error('The agent supervisor did not answer.')))
      socket.once('error', (err) => fail(err))
      socket.once('connect', () => {
        if (settled) return
        settled = true
        socket.setTimeout(0)
        // A keeper that goes away is an agent that went away: the bridge supervises that the
        // same way it supervises a crashed child.
        socket.on('close', () => {
          const wasClosed = this.closed
          this.closed = true
          this.failWaiters(new Error('The agent supervisor went away.'))
          if (!wasClosed) this.emit('gone', 'the agent supervisor went away')
        })
        socket.on('data', (chunk) => this.receive(chunk))
        socket.on('error', () => {})
        resolve()
      })
    })
  }

  /** @param {Buffer|string} chunk */
  receive(chunk) {
    this.buffer += String(chunk)
    // A keeper's frame can be one 8 MB record, so the guard is on the absence of a newline
    // rather than on the total: buffered complete lines are always consumed below.
    if (this.buffer.length > MAX_LINE_BYTES * 2 && this.buffer.indexOf('\n') < 0) {
      this.buffer = ''
      this.emit('protocol-error', 'the agent supervisor sent an oversized frame')
      return
    }
    for (;;) {
      const lf = this.buffer.indexOf('\n')
      if (lf < 0) return
      const line = this.buffer.slice(0, lf)
      this.buffer = this.buffer.slice(lf + 1)
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.emit(
          'protocol-error',
          `unreadable frame from the agent supervisor: ${line.slice(0, 200)}`,
        )
        continue
      }
      this.handle(frame)
    }
  }

  /** @param {any} frame */
  handle(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'res') {
      const waiter = this.waiters.get(String(frame.opId ?? ''))
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.waiters.delete(String(frame.opId ?? ''))
      if (frame.ok === false) {
        const error = new Error(frame.error || 'The agent supervisor refused the request.')
        Object.assign(error, { code: frame.code ?? null })
        waiter.reject(error)
        return
      }
      waiter.resolve(frame)
      return
    }
    if (frame.type === 'spawned')
      this.childInfo = { pid: frame.pid ?? null, argv: frame.argv || [] }
    if (frame.type === 'exit') this.childInfo = null
    if (this.paused) {
      this.queued.push(frame)
      return
    }
    this.dispatch(frame)
  }

  /** @param {any} frame */
  dispatch(frame) {
    switch (frame.type) {
      case 'out':
        this.emit('out', String(frame.line ?? ''))
        break
      case 'stderr':
        this.emit('stderr', String(frame.text ?? ''))
        break
      case 'exit':
        this.emit('exit', { code: frame.code ?? null, signal: frame.signal ?? null })
        break
      case 'spawned':
        this.emit('spawned', this.childInfo)
        break
      case 'detached':
        this.emit('detached', String(frame.reason || 'another router attached'))
        break
      case 'protocol-error':
        this.emit('protocol-error', String(frame.text || 'the agent supervisor reported a problem'))
        break
      default:
        break
    }
  }

  /** Releases the frames held while the caller wired its listeners, in the order they came. */
  resume() {
    this.paused = false
    const queued = this.queued
    this.queued = []
    for (const frame of queued) this.dispatch(frame)
  }

  /** @param {any} frame */
  write(frame) {
    if (this.closed || !this.socket) throw new Error('The agent supervisor connection is closed.')
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  /**
   * @param {string} op
   * @param {Record<string, any>} [payload]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(op, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const opId = `o${++this.seq}`
    /** @type {Promise<any>} */
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(opId)
        reject(new Error(`The agent supervisor did not answer ${op}.`))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(opId, { resolve, reject, timer })
    })
    try {
      this.write({ ...payload, op, opId })
    } catch (err) {
      const waiter = this.waiters.get(opId)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.waiters.delete(opId)
        waiter.reject(/** @type {Error} */ (err))
      }
    }
    return answer
  }

  /** Takes control of the child, or takes over from a router that has gone. */
  async attach() {
    const frame = await this.request('attach', {}, CONNECT_TIMEOUT_MS)
    this.childInfo = frame.child || null
    return { child: this.childInfo, replay: Array.isArray(frame.replay) ? frame.replay : [] }
  }

  /**
   * @param {{ command: string, args: string[], cwd: string, env: Record<string, string> }} launch
   */
  async spawn({ command, args, cwd, env }) {
    const frame = await this.request('spawn', { command, args, cwd, env })
    this.childInfo = { pid: frame.pid ?? null, argv: frame.argv || [] }
    return { child: this.childInfo }
  }

  /** @param {string} line one command record, without its newline */
  writeLine(line) {
    this.write({ op: 'stdin', line })
  }

  /** @param {string} [signal] */
  async kill(signal = 'SIGTERM') {
    await this.request('kill', { signal })
  }

  /** @returns {Promise<void>} */
  async shutdown() {
    try {
      await this.request('shutdown', {}, 2_000)
    } catch {
      // Going away anyway; the keeper stops itself when its client list empties.
    }
    this.close()
  }

  /** @param {Error} err */
  failWaiters(err) {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.waiters.clear()
  }

  /** Hangs up without ending the agent. */
  close() {
    this.closed = true
    this.failWaiters(new Error('The agent supervisor connection was closed.'))
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.end()
    } catch {
      // Already gone.
    }
    try {
      socket.destroy()
    } catch {
      // Already gone.
    }
  }
}

/**
 * The keeper itself: one child, its pipes, and whoever is currently watching.
 */
class Keeper {
  /** @param {{ socketPath: string, idleMs: number }} options */
  constructor({ socketPath, idleMs }) {
    this.socketPath = socketPath
    this.idleMs = idleMs
    this.server = createServer((socket) => this.accept(socket))
    /** @type {import('node:net').Socket | null} */
    this.controller = null
    /** @type {Set<import('node:net').Socket>} */
    this.clients = new Set()
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {string[]} */
    this.argv = []
    /** @type {string[]} */
    this.replay = []
    this.replayChars = 0
    /** @type {Buffer<ArrayBufferLike>} */
    this.stdout = Buffer.alloc(0)
    this.stderr = ''
    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null
    this.stopping = false
  }

  /** @returns {Promise<void>} */
  async start() {
    if (process.platform !== 'win32') {
      mkdirSync(dirname(this.socketPath), { recursive: true })
      // One keeper per address: a second router for the same console must attach to the one
      // already keeping the agent, not start a rival.
      if (await isLive(this.socketPath)) process.exit(0)
      try {
        unlinkSync(this.socketPath)
      } catch {
        // No stale file to clear.
      }
    }
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject)
        resolve(null)
      })
    })
    if (process.platform !== 'win32') {
      try {
        // The agent's stdin is behind this socket: it is as private as the agent's own files.
        chmodSync(this.socketPath, 0o600)
      } catch {
        // A filesystem without mode bits still serves.
      }
    }
    this.server.on('error', (err) => process.stderr.write(`supervisor: ${err?.message || err}\n`))
    this.armIdle()
  }

  /** @param {import('node:net').Socket} socket */
  accept(socket) {
    socket.setEncoding('utf8')
    this.clients.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      for (;;) {
        const lf = buffer.indexOf('\n')
        if (lf < 0) return
        const line = buffer.slice(0, lf)
        buffer = buffer.slice(lf + 1)
        if (!line.trim()) continue
        let op
        try {
          op = JSON.parse(line)
        } catch {
          this.send(socket, { type: 'protocol-error', text: 'unreadable request' })
          continue
        }
        this.handleOp(socket, op).catch((err) =>
          this.send(socket, {
            type: 'res',
            opId: op?.opId ?? null,
            ok: false,
            error: err?.message || String(err),
          }),
        )
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.clients.delete(socket)
      if (this.controller === socket) {
        this.controller = null
        this.armIdle()
      }
    })
  }

  /**
   * @param {import('node:net').Socket} socket
   * @param {any} op
   */
  async handleOp(socket, op) {
    switch (op?.op) {
      case 'ping':
        this.reply(socket, op, { child: this.childInfo() })
        return
      case 'attach': {
        if (this.controller && this.controller !== socket && !this.controller.destroyed) {
          this.send(this.controller, { type: 'detached', reason: 'another router attached' })
        }
        this.controller = socket
        this.cancelIdle()
        this.reply(socket, op, { child: this.childInfo(), replay: this.replay.slice() })
        return
      }
      case 'spawn':
        await this.spawnChild(socket, op)
        return
      case 'kill': {
        const signal = typeof op.signal === 'string' && op.signal ? op.signal : 'SIGTERM'
        try {
          this.child?.kill(signal)
        } catch {
          // Already gone; the exit frame has been sent.
        }
        this.reply(socket, op, {})
        return
      }
      case 'stdin': {
        const child = this.child
        if (!child || !child.stdin || !child.stdin.writable) {
          this.send(socket, { type: 'protocol-error', text: 'no agent is running' })
          return
        }
        try {
          child.stdin.write(`${String(op.line ?? '')}\n`)
        } catch (err) {
          this.send(socket, {
            type: 'protocol-error',
            text: `could not reach the agent: ${/** @type {Error} */ (err)?.message || err}`,
          })
        }
        return
      }
      case 'detach':
        if (this.controller === socket) {
          this.controller = null
          this.armIdle()
        }
        this.reply(socket, op, {})
        return
      case 'shutdown':
        this.reply(socket, op, {})
        await this.stop('shutdown')
        return
      default:
        this.send(socket, {
          type: 'res',
          opId: op?.opId ?? null,
          ok: false,
          error: `unknown operation: ${op?.op}`,
        })
    }
  }

  /** @returns {{ pid: number | null, argv: string[] } | null} */
  childInfo() {
    const child = this.child
    if (!child) return null
    return { pid: child.pid ?? null, argv: this.argv.slice() }
  }

  /**
   * @param {import('node:net').Socket} socket
   * @param {any} op
   * @param {Record<string, any>} data
   */
  reply(socket, op, data) {
    this.send(socket, { type: 'res', opId: op?.opId ?? null, ok: true, ...data })
  }

  /**
   * @param {import('node:net').Socket} socket
   * @param {any} frame
   */
  send(socket, frame) {
    if (!socket || socket.destroyed) return
    try {
      socket.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // A client that went away mid-write is a client the close handler already dealt with.
    }
  }

  /** @param {any} frame */
  broadcast(frame) {
    this.send(/** @type {any} */ (this.controller), frame)
  }

  /**
   * Replaces the child: the old one is stopped and *waited for* before the new one starts,
   * because two agents on one session file both write it. The exit of a child stopped here is
   * not reported — the caller asked for it.
   * @param {import('node:net').Socket} socket
   * @param {any} op
   */
  async spawnChild(socket, op) {
    if (this.stopping) {
      this.send(socket, {
        type: 'res',
        opId: op?.opId ?? null,
        ok: false,
        error: 'The agent supervisor is shutting down.',
      })
      return
    }
    const command = typeof op.command === 'string' ? op.command : ''
    if (!command) {
      this.send(socket, {
        type: 'res',
        opId: op?.opId ?? null,
        ok: false,
        error: 'A command is required.',
      })
      return
    }
    await this.stopChild()
    const args = Array.isArray(op.args) ? op.args.map(String) : []
    const cwd = typeof op.cwd === 'string' && op.cwd ? op.cwd : undefined
    const env = op.env && typeof op.env === 'object' ? op.env : {}
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.send(socket, {
        type: 'res',
        opId: op?.opId ?? null,
        ok: false,
        error: /** @type {Error} */ (err)?.message || String(err),
      })
      return
    }
    this.argv = [command, ...args]
    this.child = child
    this.watch(child)
    await new Promise((resolve) => {
      /** @param {Error|null} err */
      const settle = (err) => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
        if (err) {
          if (this.child === child) {
            this.child = null
            this.argv = []
          }
          this.send(socket, {
            type: 'res',
            opId: op?.opId ?? null,
            ok: false,
            error: err.message,
            code: /** @type {NodeJS.ErrnoException} */ (err).code ?? null,
          })
          resolve(null)
          return
        }
        const info = this.childInfo()
        this.send(socket, { type: 'res', opId: op?.opId ?? null, ok: true, ...info })
        this.broadcast({ type: 'spawned', ...info })
        resolve(null)
      }
      const onSpawn = () => settle(null)
      /** @param {Error} err */
      const onError = (err) => settle(err)
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  /** @param {import('node:child_process').ChildProcess} child */
  watch(child) {
    if (child.stdout) {
      child.stdout.on('data', (chunk) =>
        this.relay(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
      )
      child.stdout.on('error', () => {})
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        this.stderr = `${this.stderr}${text}`.slice(-STDERR_LIMIT)
        if (text.trim()) this.broadcast({ type: 'stderr', text: text.trimEnd() })
      })
      child.stderr.on('error', () => {})
    }
    child.stdin?.on('error', () => {})
    child.once('exit', (code, signal) => {
      // A child this keeper stopped on purpose is not news: `stopChild` clears it first.
      if (this.child !== child) return
      this.child = null
      this.argv = []
      this.broadcast({ type: 'exit', code: code ?? null, signal: signal ?? null })
      this.armIdle()
    })
  }

  /** @param {Buffer} chunk */
  relay(chunk) {
    this.stdout = this.stdout.length ? Buffer.concat([this.stdout, chunk]) : chunk
    if (this.stdout.length > MAX_LINE_BYTES && this.stdout.indexOf(0x0a) < 0) {
      // One unterminated record this size is a runaway process holding the stream, not a
      // conversation; keeping it would grow without bound.
      this.stdout = Buffer.alloc(0)
      this.broadcast({ type: 'protocol-error', text: 'the agent wrote an oversized record' })
      return
    }
    for (;;) {
      const lf = this.stdout.indexOf(0x0a)
      if (lf < 0) return
      let line = this.stdout.subarray(0, lf)
      this.stdout = this.stdout.subarray(lf + 1)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (!line.length) continue
      const text = line.toString('utf8')
      this.remember(text)
      this.broadcast({ type: 'out', line: text })
    }
  }

  /**
   * The tail a router that just attached replays, bounded the way the bridge's own log is:
   * `agent_end` carries a whole conversation, so a count alone would hold megabytes.
   * @param {string} line
   */
  remember(line) {
    this.replay.push(line)
    this.replayChars += line.length
    while (
      this.replay.length > REPLAY_LIMIT ||
      (this.replayChars > REPLAY_MAX_CHARS && this.replay.length > 1)
    ) {
      const dropped = this.replay.shift()
      this.replayChars -= dropped ? dropped.length : 0
    }
  }

  /** Stops the child and waits for it: two agents on one session file both write it. */
  async stopChild() {
    const child = this.child
    if (!child) return
    // Cleared first so the exit below is not reported as a crash.
    this.child = null
    this.argv = []
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve(null)
      }, KILL_GRACE_MS)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(null)
      })
      try {
        child.stdin?.end()
      } catch {
        // Already closed.
      }
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  armIdle() {
    this.cancelIdle()
    if (this.controller || !(this.idleMs > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop('idle').catch(() => {})
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  cancelIdle() {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Stops everything and leaves. The address goes first: a router that starts while this one is
   * shutting down must fail to attach here and start a keeper of its own, rather than queue a
   * spawn behind a child that is on its way out.
   * @param {string} reason
   */
  async stop(reason) {
    if (this.stopping) return
    this.stopping = true
    this.cancelIdle()
    try {
      this.server.close()
    } catch {
      // Never listened.
    }
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // Not ours any more.
      }
    }
    for (const client of this.clients) {
      try {
        client.destroy()
      } catch {
        // Already gone.
      }
    }
    this.clients.clear()
    await this.stopChild()
    if (reason === 'idle') {
      process.stderr.write('supervisor: no router attached, stopped the agent\n')
    }
    process.exit(0)
  }
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  /** @type {Map<string, string>} */
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    if (inline !== undefined) {
      flags.set(name, inline)
      continue
    }
    flags.set(name, argv[i + 1] ?? '')
    i += 1
  }
  const socketPath = flags.get('socket') || process.env.HAMMER_PI_SUPERVISOR_SOCKET || ''
  if (!socketPath) {
    process.stderr.write('supervisor: --socket is required\n')
    process.exit(2)
  }
  const requested = Number(
    flags.get('idle-ms') ?? process.env.HAMMER_PI_SUPERVISOR_IDLE_MS ?? DEFAULT_IDLE_MS,
  )
  const idleMs = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_IDLE_MS
  const keeper = new Keeper({ socketPath, idleMs })
  process.on('SIGTERM', () => {
    keeper.stop('SIGTERM').catch(() => process.exit(0))
  })
  process.on('SIGINT', () => {
    keeper.stop('SIGINT').catch(() => process.exit(0))
  })
  keeper.start().catch((err) => {
    process.stderr.write(`supervisor: ${err?.message || err}\n`)
    process.exit(1)
  })
}

/** Only when executed, not when imported: this file is the keeper and its client. */
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(SELF)
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
