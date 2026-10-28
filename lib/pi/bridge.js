// @ts-check
/**
 * @file bridge.js
 * @description The Pi coding agent, driven over its RPC mode, with the harness around it.
 *
 * Pi is a CLI, not a server: `pi --mode rpc` speaks one JSON object per line on
 * stdin/stdout. This module owns that child process, correlates its command responses,
 * re-emits its session events, and supervises it the way a long-lived harness must:
 * a phase the page can show, usage the page can count, and a restart after a crash.
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
 *    (with terminal escapes stripped) for the status card and the transcript.
 * 4. **A prompt sent while Pi is streaming is an error unless it says how to queue it.**
 *    `streamingBehavior: 'steer'` delivers it after the current turn's tool calls. Rather
 *    than trusting tracked state that a missed event can leave stale, the bridge asks to
 *    steer when it believes a run is active and retries as a steer if Pi disagrees.
 *
 * Supervision is deliberately conservative: only a child that actually ran is restarted,
 * with exponential backoff and a hard limit, and a disposal clears the timer so a stopped
 * router cannot leave an agent respawning behind it.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

export const PI_DEFAULT_COMMAND = 'pi'
/** RPC mode. Session storage is the launcher's business (see runtime.js). */
export const PI_DEFAULT_ARGS = ['--mode', 'rpc']

const COMMAND_TIMEOUT_MS = 20_000
const LOG_LIMIT = 400
const LOG_MAX_CHARS = 512 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
const STDERR_LIMIT = 4_000
const DISPOSE_GRACE_MS = 2_000
const RESTART_LIMIT = 6

/** RPC commands the console may send on a caller's behalf. */
export const PI_COMMANDS = new Set([
  'get_state',
  'get_messages',
  'get_available_models',
  'set_model',
  'cycle_model',
  'set_thinking_level',
  'compact',
  'clear_queue',
])

/** @typedef {{ kind: string, [key: string]: any }} PiRecord */
/** @typedef {'idle'|'starting'|'alive'|'busy'|'dead'|'error'|'stopped'} PiPhase */

/** Terminal escapes in stderr are noise in a browser transcript. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const stripAnsi = (value) => String(value).replace(ANSI, '')

export class PiBridge extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.command] executable to run (default `pi`)
   * @param {string[]} [options.args] arguments; defaults to RPC mode
   * @param {string} [options.cwd] the directory the agent works in
   * @param {Record<string, string>} [options.env] variables added to this process's own; how
   *   the console points Pi at the router instead of at the user's own Pi configuration
   * @param {string[]} [options.notes] launch notes to show in the status card
   * @param {string|null} [options.launchError] why no child can be started at all
   * @param {boolean} [options.autoRestart] restart a child that dies on its own
   * @param {number} [options.restartBaseMs] first backoff step
   * @param {number} [options.restartLimit] give up after this many consecutive restarts
   * @param {number} [options.logLimit] events kept for replay to a newly opened page
   */
  constructor({
    command = PI_DEFAULT_COMMAND,
    args = PI_DEFAULT_ARGS,
    cwd = process.cwd(),
    env = {},
    notes = [],
    launchError = null,
    autoRestart = true,
    restartBaseMs = 1_000,
    restartLimit = RESTART_LIMIT,
    logLimit = LOG_LIMIT,
  } = {}) {
    super()
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.logLimit = logLimit
    this.launchError = launchError
    this.autoRestart = autoRestart
    this.restartBaseMs = restartBaseMs
    this.restartLimit = restartLimit

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {Promise<void> | null} */
    this.starting = null
    /** @type {NodeJS.Timeout | null} */
    this.restartTimer = null
    /** @type {Map<string, { resolve: (record: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** Bytes received but not yet terminated by LF. @type {Buffer<ArrayBufferLike>} */
    this.buffer = Buffer.alloc(0)
    this.stderr = ''
    /** @type {any[]} session events, bounded, for replay to a page that just opened */
    this.log = []
    this.logChars = 0
    /** @type {PiPhase} */
    this.phase = launchError ? 'error' : 'idle'
    this.restarts = 0
    this.notes = notes.slice()
    this.usage = { tokens: 0, cost: 0 }
    /** @type {{ available: boolean | null, error: string | null, model: any, isStreaming: boolean, sessionId: string | null, sessionFile: string | null, thinkingLevel: string | null }} */
    this.state = {
      available: launchError ? false : null,
      error: launchError,
      model: null,
      isStreaming: false,
      sessionId: null,
      sessionFile: null,
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
      phase: this.phase,
      command: this.command,
      cwd: this.cwd,
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      isStreaming: this.state.isStreaming,
      sessionId: this.state.sessionId,
      sessionFile: this.state.sessionFile,
      error: this.state.error,
      stderr: this.stderr,
      events: this.log.length,
      tokens: this.usage.tokens,
      cost: Number(this.usage.cost.toFixed(6)),
      restarts: this.restarts,
      notes: this.notes,
    }
  }

  /** The events a freshly opened page replays. */
  history() {
    return this.log.slice()
  }

  /** @param {PiPhase} phase */
  setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase
    if (!this.disposed) this.emit('status', this.status())
  }

  /** A note for the status card; kept bounded and deduplicated. */
  /** @param {string} note */
  addNote(note) {
    const text = stripAnsi(note).trim()
    if (!text || this.notes.includes(text)) return
    this.notes = [...this.notes, text].slice(-8)
    if (!this.disposed) this.emit('status', this.status())
  }

  /**
   * Starts the child if it is not already running. Safe to call concurrently: the second
   * caller joins the first attempt instead of spawning a second agent.
   */
  async start() {
    if (this.child) return
    if (this.starting) return this.starting
    if (this.disposed) throw new Error('The Pi bridge has been disposed.')
    if (this.launchError) {
      this.setPhase('error')
      throw new Error(this.launchError)
    }
    // An explicit start wins over a scheduled restart; otherwise a prompt sent during the
    // backoff window would spawn a second child.
    this.clearRestartTimer()
    this.setPhase('starting')

    /** @type {Promise<void>} */
    const attempt = new Promise((resolve, reject) => {
      let settled = false
      /** @param {Error} err */
      const fail = (err) => {
        if (settled) return
        settled = true
        this.state.available = false
        this.state.error = err.message
        this.setPhase('error')
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
        this.setPhase('alive')
        this.attach(child)
        // Ask which model we are on. No model call, and it makes the status card real before
        // anyone prompts.
        this.send({ type: 'get_state' }).catch(() => {})
        resolve()
      })
    })

    this.starting = attempt
    // The attempt is dropped whichever way it settles. Caching a successful one would make
    // every later `start()` resolve without spawning — a crashed agent could then never be
    // brought back — and caching a failed one would tell a user who just installed pi that it
    // is still missing.
    const settle = () => {
      if (this.starting === attempt) this.starting = null
    }
    attempt.then(settle, settle)
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
        const text = stripAnsi(String(chunk))
        this.stderr = `${this.stderr}${text}`.slice(-STDERR_LIMIT)
        if (text.trim()) this.emit('log', { level: 'stderr', text: text.trimEnd() })
      })
      stderr.on('error', () => {})
    }
    // A write to a child that has just exited raises EPIPE asynchronously; without this
    // listener that is an unhandled 'error' event, which would take the router down.
    stdin?.on('error', (err) => {
      if (!this.disposed) this.emit('protocol-error', `stdin: ${err.message}`)
    })

    child.once('exit', (code, signal) => {
      // Whether this child is still the one we are driving. A restart or a disposal detaches
      // it first, and the replacement already owns the phase — supervising the old one would
      // schedule a second spawn behind the new child's back.
      const wasCurrent = this.child === child
      if (wasCurrent) this.child = null
      this.state.isStreaming = false
      const message = signal
        ? `Pi exited on ${signal}.`
        : `Pi exited with code ${code ?? 'unknown'}.`
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`${message} (waiting on ${id})`))
      }
      this.pending.clear()
      if (!wasCurrent) return
      if (this.disposed) {
        this.setPhase('stopped')
        return
      }
      this.state.error = message
      this.notes = [...this.notes, message].slice(-8)
      this.setPhase('dead')
      this.emit('exit', { code, signal, message })
      if (this.autoRestart) this.scheduleRestart()
    })
  }

  /** Exponential backoff, bounded, with a hard stop so a broken install cannot loop. */
  scheduleRestart() {
    if (this.disposed || this.restartTimer || this.child) return
    this.setPhase('dead')
    if (this.restarts >= this.restartLimit) {
      this.addNote(`Pi keeps exiting; gave up after ${this.restartLimit} restarts.`)
      return
    }
    this.restarts += 1
    const delay = Math.min(30_000, this.restartBaseMs * 2 ** (this.restarts - 1))
    this.addNote(
      `Restarting Pi in ${Math.round(delay / 100) / 10}s (${this.restarts}/${this.restartLimit}).`,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.disposed) return
      this.start().catch((err) => this.addNote(`Restart failed: ${err.message}`))
    }, delay)
    this.restartTimer.unref?.()
  }

  clearRestartTimer() {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  /**
   * Restarts the agent, keeping the transcript: the page already holds it, and the router's
   * replay log is the conversation after all.
   */
  async restart() {
    this.clearRestartTimer()
    this.restarts = 0
    const child = this.child
    // Detached first, so the old child's exit is not mistaken for a crash and restarted
    // behind the new one's back.
    this.child = null
    if (child) {
      // Wait for it to actually go: two agents on one session directory would both write it.
      await new Promise((resolve) => {
        /** @type {NodeJS.Timeout | null} */
        let timer = null
        const done = () => {
          if (timer) clearTimeout(timer)
          resolve(null)
        }
        if (child.exitCode !== null || child.signalCode) return done()
        timer = setTimeout(done, DISPOSE_GRACE_MS)
        timer.unref?.()
        child.once('exit', done)
        try {
          child.stdin?.end()
        } catch {}
        try {
          child.kill('SIGTERM')
        } catch {
          done()
        }
      })
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    this.setPhase('starting')
    await this.start()
    return this.status()
  }

  /** @param {Buffer} chunk */
  consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    if (this.buffer.length > MAX_LINE_BYTES && this.buffer.indexOf(0x0a) < 0) {
      // One unterminated record this size is not a conversation; it is a runaway process
      // holding the stream, and keeping it would grow without bound.
      this.buffer = Buffer.alloc(0)
      this.emit('protocol-error', 'discarded an oversized record from pi')
      return
    }
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
      // The bridge sends its own `get_state` on start; that response has no waiter, and it
      // is exactly what the status card is built from.
      if (record.success === true && record.command === 'get_state' && record.data) {
        this.applyState(record.data)
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
        this.setPhase('busy')
        break
      case 'agent_settled':
        this.state.isStreaming = false
        // A completed turn is proof the agent works, so the crash budget starts over instead
        // of running out across a long, healthy session.
        this.restarts = 0
        this.setPhase('alive')
        break
      case 'message_end':
        // `turn_end` repeats the same message, so counting there would double it.
        this.addUsage(record.message)
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

  /** @param {any} message */
  addUsage(message) {
    const usage = message?.usage
    if (!usage) return
    const tokens =
      Number(usage.totalTokens) ||
      Number(usage.input || 0) +
        Number(usage.output || 0) +
        Number(usage.cacheRead || 0) +
        Number(usage.cacheWrite || 0)
    const cost = Number(usage.cost?.total) || 0
    if (!tokens && !cost) return
    this.usage.tokens += tokens
    this.usage.cost += cost
    if (!this.disposed) this.emit('usage', { ...this.usage })
  }

  /** @param {any} data a `get_state` payload */
  applyState(data) {
    this.state.model = data.model || this.state.model
    this.state.isStreaming = Boolean(data.isStreaming)
    this.state.sessionId = data.sessionId || this.state.sessionId
    this.state.sessionFile = data.sessionFile || this.state.sessionFile
    this.state.thinkingLevel = data.thinkingLevel || this.state.thinkingLevel
    if (data.isStreaming) this.setPhase('busy')
    else if (this.phase === 'busy' || this.phase === 'starting') this.setPhase('alive')
    if (!this.disposed) this.emit('status', this.status())
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
    this.applyState(data)
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
    if (disposition === 'started' || disposition === 'queued') {
      this.state.isStreaming = true
      this.setPhase('busy')
    }
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
    this.setPhase('alive')
    return record
  }

  /** Starts a fresh conversation in the same process. */
  async reset() {
    const record = await this.send({ type: 'new_session' })
    if (record.data?.cancelled !== true) {
      this.log = []
      this.logChars = 0
      this.state.sessionId = null
      this.state.sessionFile = null
      this.usage = { tokens: 0, cost: 0 }
      if (!this.disposed) this.emit('usage', { ...this.usage })
    }
    return record
  }

  /**
   * One allowlisted RPC command on a caller's behalf. The list is the harness's: it is the
   * set a UI may reasonably ask for, not every command pi accepts.
   * @param {string} type
   * @param {Record<string, any>} [args]
   */
  async runCommand(type, args = {}) {
    if (!PI_COMMANDS.has(type)) throw new Error(`Command not allowed: ${type}`)
    const record = await this.send({ ...args, type })
    if (type === 'get_state' && record.data) this.applyState(record.data)
    if (type === 'set_model' && record.data) this.state.model = record.data
    if (type === 'set_thinking_level' && args.level) this.state.thinkingLevel = args.level
    return record
  }

  /** Orderly shutdown: close stdin so Pi disposes its runtime, then kill if it lingers. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.clearRestartTimer()
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
