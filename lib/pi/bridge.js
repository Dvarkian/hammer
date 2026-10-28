// @ts-check
/**
 * @file bridge.js
 * @description The Pi coding agent, driven over its RPC mode.
 *
 * Pi is a CLI, not a server: `pi --mode rpc --no-session` speaks one JSON object per line
 * on stdin/stdout. This module owns that child process, correlates its command responses,
 * and re-emits its session events for the dashboard.
 *
 * Four details of the protocol decide the shape below, and each one is a bug if ignored:
 *
 * 1. **Framing is LF only.** Node's `readline` also splits on U+2028 and U+2029, which are
 *    legal inside a JSON string, so a model answer containing one would be cut in half. The
 *    buffer here splits bytes on `0x0A` and strips a trailing `0x0D`.
 * 2. **A command response is acceptance, not completion.** `prompt` returns as soon as Pi
 *    accepts the message; the work streams afterwards. The UI therefore waits for
 *    `agent_settled`, not for the response.
 * 3. **stdout is protocol only.** Diagnostics go to stderr, which is kept as a bounded tail
 *    for the status card rather than parsed.
 * 4. **A prompt sent while Pi is streaming is an error unless it says how to queue it.**
 *    `streamingBehavior: 'steer'` delivers it after the current turn's tool calls. Rather
 *    than trusting tracked state that a missed event can leave stale, the bridge asks to
 *    steer when it believes a run is active and retries as a steer if Pi disagrees.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

export const PI_DEFAULT_COMMAND = 'pi'
/** RPC mode with no on-disk session: "New session" is the lifetime of the child. */
export const PI_DEFAULT_ARGS = ['--mode', 'rpc', '--no-session']

const COMMAND_TIMEOUT_MS = 20_000
const LOG_LIMIT = 400
const LOG_MAX_CHARS = 512 * 1024
const STDERR_LIMIT = 4_000
const DISPOSE_GRACE_MS = 2_000

/** @typedef {{ kind: string, [key: string]: any }} PiRecord */

export class PiBridge extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.command] executable to run (default `pi`)
   * @param {string[]} [options.args] arguments; defaults to RPC mode
   * @param {string} [options.cwd] the directory the agent works in
   * @param {Record<string, string>} [options.env] variables added to this process's own; how
   *   the console points Pi at the router instead of at the user's own Pi configuration
   * @param {number} [options.logLimit] events kept for replay to a newly opened page
   */
  constructor({
    command = PI_DEFAULT_COMMAND,
    args = PI_DEFAULT_ARGS,
    cwd = process.cwd(),
    env = {},
    logLimit = LOG_LIMIT,
  } = {}) {
    super()
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.logLimit = logLimit

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {Promise<void> | null} */
    this.starting = null
    /** @type {Map<string, { resolve: (record: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** Bytes received but not yet terminated by LF. @type {Buffer<ArrayBufferLike>} */
    this.buffer = Buffer.alloc(0)
    this.stderr = ''
    /** @type {any[]} session events, bounded, for replay to a page that just opened */
    this.log = []
    this.logChars = 0
    /** @type {{ available: boolean | null, error: string | null, model: any, isStreaming: boolean, sessionId: string | null, thinkingLevel: string | null }} */
    this.state = {
      available: null,
      error: null,
      model: null,
      isStreaming: false,
      sessionId: null,
      thinkingLevel: null,
    }
    this.seq = 0
    this.disposed = false
  }

  /** What the dashboard needs to describe the agent without starting it. */
  status() {
    return {
      available: this.state.available,
      running: Boolean(this.child),
      command: this.command,
      cwd: this.cwd,
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      isStreaming: this.state.isStreaming,
      sessionId: this.state.sessionId,
      error: this.state.error,
      stderr: this.stderr,
      events: this.log.length,
    }
  }

  /** The events a freshly opened page replays. */
  history() {
    return this.log.slice()
  }

  /**
   * Starts the child if it is not already running. Safe to call concurrently: the second
   * caller joins the first attempt instead of spawning a second agent.
   */
  async start() {
    if (this.child) return
    if (this.starting) return this.starting
    if (this.disposed) throw new Error('The Pi bridge has been disposed.')

    /** @type {Promise<void>} */
    const attempt = new Promise((resolve, reject) => {
      let settled = false
      /** @param {Error} err */
      const fail = (err) => {
        if (settled) return
        settled = true
        this.state.available = false
        this.state.error = err.message
        reject(err)
      }
      let child
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        fail(new Error(`Could not start \`${this.command}\`: ${err?.message || err}`))
        return
      }

      child.once('error', (err) => {
        const missing = /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT'
        fail(
          new Error(
            missing
              ? `\`${this.command}\` is not installed or not on PATH. Install it with: curl -fsSL https://pi.dev/install.sh | sh`
              : `\`${this.command}\` failed to start: ${err.message}`,
          ),
        )
      })

      child.once('spawn', () => {
        if (settled) return
        settled = true
        this.child = child
        this.state.available = true
        this.state.error = null
        this.attach(child)
        resolve()
      })
    })

    this.starting = attempt
    // A failed attempt must not be cached for the next caller: a user who installs pi and
    // presses Retry has to get a fresh spawn, and `await start()` has to reject with the
    // real reason rather than resolve into "Pi is not running".
    attempt.catch(() => {
      if (this.starting === attempt) this.starting = null
    })
    return attempt
  }

  /** @param {import('node:child_process').ChildProcess} child */
  attach(child) {
    const { stdout, stderr, stdin } = child
    if (stdout) {
      stdout.on('data', (chunk) =>
        this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
      )
      stdout.on('error', (err) => this.emit('protocol-error', `stdout: ${err.message}`))
    }
    if (stderr) {
      stderr.on('data', (chunk) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT)
        this.emit('stderr', String(chunk))
      })
      stderr.on('error', () => {})
    }
    // A write to a child that has just exited raises EPIPE asynchronously; without this
    // listener that is an unhandled 'error' event, which would take the router down.
    stdin?.on('error', (err) => {
      if (!this.disposed) this.emit('protocol-error', `stdin: ${err.message}`)
    })

    child.once('exit', (code, signal) => {
      const wasRunning = this.child === child
      if (wasRunning) this.child = null
      this.state.isStreaming = false
      const message = signal
        ? `Pi exited on ${signal}.`
        : `Pi exited with code ${code ?? 'unknown'}.`
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`${message} (waiting on ${id})`))
      }
      this.pending.clear()
      if (!this.disposed) this.emit('exit', { code, signal, message })
    })
  }

  /** @param {Buffer} chunk */
  consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const lf = this.buffer.indexOf(0x0a)
      if (lf < 0) return
      let line = this.buffer.subarray(0, lf)
      this.buffer = this.buffer.subarray(lf + 1)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (!line.length) continue
      const text = line.toString('utf8')
      let record
      try {
        record = JSON.parse(text)
      } catch {
        this.emit('protocol-error', `unparseable record: ${text.slice(0, 400)}`)
        continue
      }
      this.handle(record)
    }
  }

  /** @param {any} record */
  handle(record) {
    if (!record || typeof record !== 'object') return
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : ''
      const waiter = id ? this.pending.get(id) : undefined
      if (waiter) {
        clearTimeout(waiter.timer)
        this.pending.delete(id)
        if (record.success === false)
          waiter.reject(new Error(record.error || `${record.command || 'command'} failed.`))
        else waiter.resolve(record)
        return
      }
      // A response nobody is waiting for is protocol noise (a parse error, or an abort that
      // raced a shutdown). Surface it rather than dropping it silently.
      if (record.success === false)
        this.emit('protocol-error', String(record.error || 'command failed'))
      return
    }
    this.track(record)
    this.remember(record)
    this.emit('event', record)
  }

  /**
   * The replay log. Bounded in both length and characters: `agent_end` carries the whole
   * conversation, so a count-only cap would let a long run hold megabytes for the next page.
   * @param {PiRecord} record
   */
  remember(record) {
    this.log.push(record)
    let size
    try {
      size = JSON.stringify(record).length
    } catch {
      size = 0
    }
    this.logChars += size
    while (
      this.log.length > this.logLimit ||
      (this.logChars > LOG_MAX_CHARS && this.log.length > 1)
    ) {
      const dropped = this.log.shift()
      try {
        this.logChars -= JSON.stringify(dropped).length
      } catch {
        this.logChars = 0
      }
    }
  }

  /** Keeps just enough state to describe the agent without asking it. */
  track(record) {
    switch (record.type) {
      case 'agent_start':
        this.state.isStreaming = true
        break
      case 'agent_settled':
        this.state.isStreaming = false
        break
      case 'session_info_changed':
        this.state.sessionId = record.sessionId ?? this.state.sessionId
        break
      case 'thinking_level_changed':
        this.state.thinkingLevel = record.level ?? null
        break
      default:
        break
    }
  }

  /**
   * Sends one command and resolves with its response record.
   * @param {Record<string, any>} command
   * @param {{ timeoutMs?: number }} [options]
   */
  async send(command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    await this.start()
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) throw new Error('Pi is not running.')
    const id = typeof command.id === 'string' && command.id ? command.id : `c${++this.seq}`
    const payload = { ...command, id }

    /** @type {Promise<any>} */
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`Pi did not answer ${command.type} within ${Math.round(timeoutMs / 1000)}s.`),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })

    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return response
  }

  /** Current session state, including the model Pi will use. */
  async describe() {
    const record = await this.send({ type: 'get_state' })
    const data = record.data || {}
    this.state.model = data.model || null
    this.state.isStreaming = Boolean(data.isStreaming)
    this.state.sessionId = data.sessionId || null
    this.state.thinkingLevel = data.thinkingLevel || null
    return data
  }

  /**
   * Sends a prompt. While a run is streaming the message is *steered* — Pi delivers it after
   * the current turn's tool calls, which is what a user typing into a busy console expects.
   * @param {string} message
   */
  async prompt(message) {
    const text = String(message ?? '').trim()
    if (!text) throw new Error('A prompt is required.')
    /** @type {Record<string, any>} */
    const command = { type: 'prompt', message: text }
    if (this.state.isStreaming) command.streamingBehavior = 'steer'

    let record
    try {
      record = await this.send(command)
    } catch (err) {
      // Tracked state said idle but Pi was mid-run (a missed `agent_start`, or a second tab).
      // Pi's own answer is authoritative; retry as a steer rather than surfacing a refusal.
      const messageText = /** @type {Error} */ (err)?.message || ''
      if (command.streamingBehavior || !/stream/i.test(messageText)) throw err
      record = await this.send({ ...command, streamingBehavior: 'steer' })
    }

    const disposition = record.data?.disposition
    if (disposition === 'started' || disposition === 'queued') this.state.isStreaming = true
    return record
  }

  /**
   * Stops everything the user can see moving: queued steer messages, a retry that is waiting
   * out its backoff, and then the run itself. Pi documents this order for its own Esc key.
   */
  async abort() {
    await this.send({ type: 'clear_queue' }).catch(() => {})
    await this.send({ type: 'abort_retry' }).catch(() => {})
    const record = await this.send({ type: 'abort' })
    this.state.isStreaming = false
    return record
  }

  /** Starts a fresh conversation in the same process. */
  async reset() {
    const record = await this.send({ type: 'new_session' })
    if (record.data?.cancelled !== true) {
      this.log = []
      this.logChars = 0
      this.state.sessionId = null
    }
    return record
  }

  /** Orderly shutdown: close stdin so Pi disposes its runtime, then kill if it lingers. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = null
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('The Pi bridge was disposed.'))
    }
    this.pending.clear()
    if (!child) return
    try {
      child.stdin?.end()
    } catch {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, DISPOSE_GRACE_MS)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }
}
