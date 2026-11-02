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
import { SupervisorClient, isLive } from './supervisor.js'

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
const KEEPER_WAIT_MS = 10_000
/**
 * Attachments: how many images one prompt may carry, and how big each one's base64 payload
 * may be. 8 MB of base64 is about 6 MB of file, which is far past what a vision model can
 * use, and the HTTP body limit is 10 MB — so a larger attach has to be refused, not shrunk.
 */
const MAX_PROMPT_IMAGES = 4
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024

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
  // Session controls: switch loads another JSONL from the store, fork/clone branch or
  // duplicate the current one, and the name is what the picker shows. None of these were
  // reachable before, which is why a console could not resume anything.
  'switch_session',
  'fork',
  'clone',
  'set_session_name',
  'get_session_stats',
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
   * @param {{ socket: string, script: string, node: string, idleMs?: number } | null} [options.supervisor]
   *   hand the child's pipes to a detached keeper (see supervisor.js) so the turn survives a
   *   router restart; without one the child is this process's child and dies with it
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
    supervisor = null,
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
    /** @type {{ socket: string, script: string, node: string, idleMs?: number } | null} */
    this.supervisorConfig = supervisor
    /** @type {SupervisorClient | null} */
    this.remote = null
    /** @type {{ pid: number | null, argv: string[] } | null} */
    this.remoteChild = null

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
    /** @type {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number, cost: number }} */
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
    }
    /** @type {{ available: boolean | null, error: string | null, model: any, isStreaming: boolean, sessionId: string | null, sessionFile: string | null, sessionName: string | null, thinkingLevel: string | null, queuedSteering: string[], queuedFollowUp: string[] }} */
    this.state = {
      available: launchError ? false : null,
      error: launchError,
      model: null,
      isStreaming: false,
      sessionId: null,
      sessionFile: null,
      sessionName: null,
      thinkingLevel: null,
      queuedSteering: [],
      queuedFollowUp: [],
    }
    this.seq = 0
    this.disposed = false
  }

  /** What the dashboard needs to describe the agent without starting it. */
  status() {
    return {
      usage: { ...this.usage },
      available: this.state.available,
      running: this.isRunning(),
      phase: this.phase,
      command: this.command,
      cwd: this.cwd,
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      isStreaming: this.state.isStreaming,
      sessionId: this.state.sessionId,
      sessionFile: this.state.sessionFile,
      sessionName: this.state.sessionName,
      queuedSteering: this.state.queuedSteering,
      queuedFollowUp: this.state.queuedFollowUp,
      pendingMessages: this.state.queuedSteering.length + this.state.queuedFollowUp.length,
      error: this.state.error,
      stderr: this.stderr,
      events: this.log.length,
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
   * @param {{ replace?: boolean }} [options] `replace` asks a keeper to stop the child it
   *   holds and start the one this bridge now wants (a session switch, a restart)
   */
  async start({ replace = false } = {}) {
    if (!replace && this.isRunning()) return
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
    const attempt = this.supervisorConfig ? this.startKeeper(replace) : this.startChild()

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

  /** Whether an agent is running, wherever its pipes are. */
  isRunning() {
    return this.supervisorConfig ? Boolean(this.remote && this.remote.child) : Boolean(this.child)
  }

  /**
   * The direct spawn: the child is this process's child, so it dies with it.
   * @returns {Promise<void>}
   */
  async startChild() {
    return new Promise((resolve, reject) => {
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
  }

  /**
   * The keeper's way: the pipes belong to a detached supervisor, so the child outlives this
   * process. When a child is already alive on the socket — the router that started it has
   * gone — it is adopted rather than replaced, because that child *is* the turn this process
   * was restarted in the middle of.
   * @param {boolean} replace
   * @returns {Promise<void>}
   */
  async startKeeper(replace) {
    const client = await this.ensureKeeper()
    const attached = await client.attach()
    // Fed before `resume()` so the replay is in the log ahead of anything live.
    if (attached.replay.length) this.replayRecords(attached.replay)
    if (attached.child) this.remoteChild = attached.child
    client.resume()
    if (!attached.child || replace) {
      const spawned = await client.spawn({
        command: this.command,
        args: this.args,
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
      })
      this.remoteChild = spawned.child
    }
    this.state.available = true
    this.state.error = null
    this.setPhase('alive')
    this.send({ type: 'get_state' }).catch(() => {})
  }

  /**
   * Connects to the keeper for this console, starting one beside the router when none is
   * keeping an agent already. It is detached on purpose: it has to outlive this process.
   * @returns {Promise<SupervisorClient>}
   */
  async ensureKeeper() {
    if (this.remote && !this.remote.closed) return this.remote
    const config =
      /** @type {{ socket: string, script: string, node: string, idleMs?: number }} */ (
        this.supervisorConfig
      )
    if (!(await isLive(config.socket))) {
      const args = [config.script, '--socket', config.socket]
      if (config.idleMs != null) args.push('--idle-ms', String(config.idleMs))
      /** @type {Error | null} */
      let keeperError = null
      const keeper = spawn(config.node, args, { detached: true, stdio: 'ignore' })
      keeper.on('error', (err) => {
        keeperError = err
      })
      keeper.on('exit', (code, signal) => {
        keeperError =
          keeperError ||
          new Error(
            `the keeper exited${signal ? ` on ${signal}` : ` with code ${code ?? 'unknown'}`}`,
          )
      })
      keeper.unref()
      // The socket, not the process: a keeper that exists is not yet a keeper that listens.
      const deadline = Date.now() + KEEPER_WAIT_MS
      for (;;) {
        if (await isLive(config.socket)) break
        if (keeperError)
          throw new Error(`Could not start the agent supervisor: ${keeperError.message}`)
        if (Date.now() > deadline) throw new Error('Could not start the agent supervisor in time.')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    const client = await SupervisorClient.connect(config.socket)
    this.remote = client
    this.watchKeeper(client)
    return client
  }

  /** @param {SupervisorClient} client */
  watchKeeper(client) {
    client.on('out', (line) => this.consume(Buffer.from(`${line}\n`)))
    client.on('stderr', (text) => {
      this.stderr = `${this.stderr}${text}`.slice(-STDERR_LIMIT)
      this.emit('log', { level: 'stderr', text })
    })
    client.on('exit', (info) => this.handleRemoteExit(client, info))
    client.on('gone', (message) =>
      this.handleRemoteExit(client, { code: null, signal: null, message }),
    )
    client.on('detached', (reason) =>
      this.emit('protocol-error', `another router took the agent over (${reason})`),
    )
    client.on('protocol-error', (text) => this.emit('protocol-error', text))
  }

  /**
   * @param {SupervisorClient} client
   * @param {{ code: number | null, signal: string | null, message?: string }} info
   */
  handleRemoteExit(client, info) {
    if (client !== this.remote) return
    const wasCurrent = Boolean(this.remoteChild)
    this.remoteChild = null
    this.state.isStreaming = false
    const message =
      info.message ||
      (info.signal
        ? `Pi exited on ${info.signal}.`
        : `Pi exited with code ${info.code ?? 'unknown'}.`)
    this.rejectPending(message)
    if (!wasCurrent) return
    if (this.disposed) {
      this.setPhase('stopped')
      return
    }
    this.state.error = message
    this.notes = [...this.notes, message].slice(-8)
    this.setPhase('dead')
    this.emit('exit', { code: info.code ?? null, signal: info.signal ?? null, message })
    if (this.autoRestart) this.scheduleRestart()
  }

  /**
   * Records the agent wrote before this router attached. They go into the replay log so a page
   * opening now sees the turn it missed, but they are not *processed*: the router that saw
   * them already counted their usage, and re-emitting them would duplicate every message.
   * @param {string[]} lines
   */
  replayRecords(lines) {
    for (const line of lines) {
      try {
        const record = JSON.parse(line)
        if (record && typeof record === 'object' && typeof record.type === 'string') {
          this.remember(record)
        }
      } catch {
        // A line torn by the keeper's bounded ring is expected at its head.
      }
    }
  }

  /** @param {string} reason */
  rejectPending(reason) {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(id ? `${reason} (waiting on ${id})` : reason))
    }
    this.pending.clear()
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
    if (this.supervisorConfig) {
      // The keeper does the replacement: it stops the old child, waits for it to go, and
      // spawns the new one. That wait belongs on the side that owns the pipes, because two
      // agents on one session file both write it.
      this.rejectPending('Pi is restarting.')
      this.remoteChild = null
      await this.start({ replace: true })
      return this.status()
    }
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

  /**
   * Rebuilds the session's usage totals from pi's own accounting. Called whenever this
   * bridge attaches to a session whose history it did not witness (a resume, a crash
   * restart, a keeper handover): the per-event counter starts at zero, so the totals it
   * holds would silently reset to "0 in · 0 out" on the page.
   * @returns {Promise<void>}
   */
  async syncUsageFromSession() {
    try {
      const record = await this.send({ type: 'get_session_stats' })
      const stats = record?.data
      const tokens = stats?.tokens
      if (!tokens || typeof tokens !== 'object') return
      const total = Number(tokens.total) || 0
      // Session accounting is authoritative, but a partial read — pi persists a message
      // slightly around when it emits it — must not clobber a counter that is already ahead.
      if (total < this.usage.totalTokens) return
      this.usage = {
        inputTokens: Number(tokens.input) || 0,
        outputTokens: Number(tokens.output) || 0,
        cacheReadTokens: Number(tokens.cacheRead) || 0,
        cacheWriteTokens: Number(tokens.cacheWrite) || 0,
        totalTokens: total,
        cost: Number(stats.cost) || this.usage.cost,
      }
      if (!this.disposed) this.emit('usage', { ...this.usage })
    } catch {
      // No stats (older pi, mid-restart child): keep whatever the event counter holds.
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
        // The turn's messages are all in: converge on pi's own session accounting, which is
        // the sum this counter should always end a turn equal to.
        this.syncUsageFromSession().catch(() => {})
        break
      case 'message_end':
        // `turn_end` repeats the same message, so counting there would double it.
        this.addUsage(record.message)
        break
      case 'queue_update':
        // Pi's own accounting of what is waiting: steering (delivered into the current run
        // after its tool calls) and follow-up (held until the whole turn completes). This is
        // the only authoritative source — a message removed by a queue drain or a clear is a
        // new event, not something the bridge can infer.
        this.state.queuedSteering = Array.isArray(record.steering)
          ? record.steering.map(String)
          : []
        this.state.queuedFollowUp = Array.isArray(record.followUp)
          ? record.followUp.map(String)
          : []
        if (!this.disposed) this.emit('status', this.status())
        break
      case 'session_info_changed':
        // Carries the display name; the ids move in `get_state` payloads, which is the only
        // place a *switch* is visible.
        this.state.sessionName =
          typeof record.name === 'string' ? record.name : this.state.sessionName
        break
      case 'thinking_level_changed':
        this.state.thinkingLevel = record.level ?? null
        break
      default:
        break
    }
  }

  /**
   * Adds one message's usage to the session totals, mirroring pi's own `getSessionStats`,
   * which sums assistant messages and tool results alike: a tool that runs its own model
   * (web search, page fetch) reports usage on its result message that no assistant message
   * carries, so filtering by role would silently drop it. Aborted turns count too — those
   * tokens were still billed.
   * @param {any} message
   */
  addUsage(message) {
    const usage = message?.usage
    if (!usage || (message?.role !== 'assistant' && message?.role !== 'toolResult')) return
    const input = Number(usage.input) || 0
    const output = Number(usage.output) || 0
    const cacheRead = Number(usage.cacheRead) || 0
    const cacheWrite = Number(usage.cacheWrite) || 0
    const tokens = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite
    const cost = Number(usage.cost?.total) || 0
    if (!tokens && !cost) return
    this.usage.inputTokens = (this.usage.inputTokens || 0) + input
    this.usage.outputTokens = (this.usage.outputTokens || 0) + output
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens || 0) + cacheRead
    this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens || 0) + cacheWrite
    this.usage.totalTokens = (this.usage.totalTokens || 0) + tokens
    this.usage.cost = (this.usage.cost || 0) + cost
    if (!this.disposed) this.emit('usage', { ...this.usage })
  }

  /** @param {any} data a `get_state` payload */
  applyState(data) {
    this.state.model = data.model || this.state.model
    this.state.isStreaming = Boolean(data.isStreaming)
    // `||` on purpose: an empty payload after a restart must not wipe a name the events
    // already delivered, and a switch that clears the name simply reports the new file.
    this.state.sessionId = data.sessionId || this.state.sessionId
    this.state.sessionFile = data.sessionFile || this.state.sessionFile
    this.state.sessionName = data.sessionName ?? this.state.sessionName
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
    if (this.supervisorConfig) {
      if (!this.remote || !this.remoteChild) throw new Error('Pi is not running.')
    } else if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Pi is not running.')
    }
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

    if (this.supervisorConfig) this.remote?.writeLine(JSON.stringify(payload))
    else this.child?.stdin?.write(`${JSON.stringify(payload)}\n`)
    return response
  }

  /** Current session state, including the model Pi will use. */
  async describe() {
    const record = await this.send({ type: 'get_state' })
    const data = record.data || {}
    this.applyState(data)
    await this.syncUsageFromSession()
    return data
  }

  /**
   * Sends a prompt. While a run is streaming the message is queued, in one of two forms:
   *
   * - `steer` (the default) — Pi delivers it after the current turn's tool calls, mid-run;
   *   what a user typing into a busy console expects.
   * - `followUp` — Pi holds it until the whole turn *completes*, then starts it as the next
   *   turn. This is the answer to "I thought of the next thing while the agent works": the
   *   message must not redirect the running turn, only follow it.
   *
   * The queued message is not lost on a Stop: `abort()` clears Pi's queue as its first step,
   * which is the order Pi documents for its own Esc key.
   * @param {string} message
   * @param {{ queueMode?: 'steer'|'followUp', images?: Array<{ data: string, mimeType: string }> }} [options]
   */
  async prompt(message, { queueMode = 'steer', images } = {}) {
    const text = String(message ?? '').trim()
    if (!text) throw new Error('A prompt is required.')
    const behavior = queueMode === 'followUp' ? 'followUp' : 'steer'
    /** @type {Record<string, any>} */
    const command = { type: 'prompt', message: text }
    // An attachment rides the same prompt command: Pi's `images` field is base64 data plus a
    // mime type, and a shape it cannot parse would fail the whole turn, so it is checked here
    // rather than trusted from the wire.
    if (images != null) {
      if (!Array.isArray(images)) throw new Error('Images must be an array.')
      if (images.length > MAX_PROMPT_IMAGES) {
        throw new Error(`At most ${MAX_PROMPT_IMAGES} images may be attached to one prompt.`)
      }
      const cleaned = images.map((image) => {
        const data = typeof image?.data === 'string' ? image.data : ''
        const mimeType = typeof image?.mimeType === 'string' ? image.mimeType : ''
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data) || data.length === 0) {
          throw new Error('An attached image is not valid base64 data.')
        }
        if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
          throw new Error(`Unsupported image type: ${mimeType || 'unknown'}.`)
        }
        if (data.length > MAX_IMAGE_BASE64) {
          throw new Error('An attached image is too large (the limit is 8 MB).')
        }
        return { type: 'image', data, mimeType }
      })
      if (cleaned.length > 0) command.images = cleaned
    }
    if (this.state.isStreaming) command.streamingBehavior = behavior

    let record
    try {
      record = await this.send(command)
    } catch (err) {
      // Tracked state said idle but Pi was mid-run (a missed `agent_start`, or a second tab).
      // Pi's own answer is authoritative; retry as a queue rather than surfacing a refusal.
      const messageText = /** @type {Error} */ (err)?.message || ''
      if (command.streamingBehavior || !/stream/i.test(messageText)) throw err
      record = await this.send({ ...command, streamingBehavior: behavior })
    }

    const disposition = record.data?.disposition
    if (disposition === 'started' || disposition === 'queued') {
      this.state.isStreaming = true
      this.setPhase('busy')
    }
    return record
  }

  /**
   * Stops everything the user can see moving: queued messages (both kinds), a retry that is
   * waiting out its backoff, and then the run itself. Pi documents this order for its own Esc
   * key. The queue answer is returned so the caller can say what was thrown away.
   */
  async abort() {
    const queued = await this.send({ type: 'clear_queue' })
      .then((record) => ({
        steering: Array.isArray(record.data?.steering) ? record.data.steering.map(String) : [],
        followUp: Array.isArray(record.data?.followUp) ? record.data.followUp.map(String) : [],
      }))
      .catch(() => null)
    await this.send({ type: 'abort_retry' }).catch(() => {})
    const record = await this.send({ type: 'abort' })
    this.state.isStreaming = false
    this.state.queuedSteering = []
    this.state.queuedFollowUp = []
    if (!this.disposed) this.emit('status', this.status())
    return { ...record, clearedQueue: queued }
  }

  /** Starts a fresh conversation in the same process. */
  async reset() {
    const record = await this.send({ type: 'new_session' })
    if (record.data?.cancelled !== true) {
      this.log = []
      this.logChars = 0
      this.state.sessionId = null
      this.state.sessionFile = null
      this.usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
      }
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
    if (type === 'set_session_name' && typeof args.name === 'string') {
      this.state.sessionName = args.name
    }
    return record
  }

  /**
   * Loads a different session file into this agent. Only safe when idle: pi tears down and
   * rebuilds the runtime around the new file, and doing that under a streaming turn is a
   * good way to lose its tail. A busy agent must be restarted instead (`restartTo`); callers
   * pick which based on `state.isStreaming`.
   * @param {string} sessionPath
   */
  async switchSession(sessionPath) {
    if (this.state.isStreaming)
      throw new Error('Pi is busy; stop the run before switching sessions.')
    const record = await this.send({ type: 'switch_session', sessionPath })
    if (record.data?.cancelled === true) return record
    // A fresh `get_state` is the only authoritative answer for where the agent now sits:
    // `switch_session` itself does not report the new file, and the `session` event the
    // reload produces is swallowed by the test seams that stub `send`.
    this.log = []
    this.logChars = 0
    // The live counter belongs to the session we just left, so it starts over; the sync
    // inside `describe()` then rehydrates it from the session pi just opened.
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
    }
    await this.describe().catch(() => {})
    // A rebind also emits a `session` header. The log describes the conversation, and the one
    // it is attached to now has not produced anything yet: replaying that header would make
    // the new conversation look like the one it replaced.
    this.log = this.log.filter((item) => item.type !== 'session')
    this.logChars = this.log.reduce((total, item) => total + String(item).length, 0)
    if (!this.disposed) this.emit('usage', { ...this.usage })
    return record
  }

  /**
   * Replaces the child, attaching it to an existing session file when one is given. The
   * resume path for an agent that is mid-run — or crashed, where an RPC switch has no one to
   * answer — and the same door a crash-restart walks through to stay on its session.
   * @param {string} [sessionPath] omit to come back on the same session pi re-opens itself
   * @param {{ message?: string }} [options]
   */
  async restartTo(sessionPath, { message = 'Agent restarted.' } = {}) {
    const previousArgs = this.args
    const previousSession = this.state.sessionFile
    const target = sessionPath || previousSession
    if (target) {
      // Drop any existing `--session <value>` pair (the value belongs to the flag) and any
      // `--continue`, which pi rejects when combined with an explicit session.
      const base = []
      for (let i = 0; i < this.args.length; i += 1) {
        if (this.args[i] === '--session') {
          i += 1 // its value goes with it
          continue
        }
        if (this.args[i] === '--continue' || this.args[i] === '-c') continue
        base.push(this.args[i])
      }
      this.args = [...base, '--session', target]
    }
    try {
      await this.restart()
      if (target) {
        // Pi accepts `--session <path|id>`; the path form is unambiguous here because the
        // bridge owns the store directory.
        this.state.sessionFile = target
      }
    } catch (err) {
      this.args = previousArgs
      throw err
    }
    if (message) this.addNote(message)
    return this.status()
  }

  /**
   * Orderly shutdown: close stdin so Pi disposes its runtime, then kill if it lingers.
   *
   * `kill: false` gives the agent up *without* ending it — the keeper keeps the child and its
   * pipes for whichever router attaches next, which is what makes a restart survivable. A real
   * teardown (quitting, closing a parallel console) kills it.
   * @param {{ kill?: boolean }} [options]
   */
  dispose({ kill = true } = {}) {
    if (this.disposed) return
    this.disposed = true
    this.clearRestartTimer()
    const remote = this.remote
    this.remote = null
    this.remoteChild = null
    this.rejectPending('The Pi bridge was disposed.')
    if (remote) {
      if (kill) remote.shutdown().catch(() => {})
      else remote.close()
      return
    }
    const child = this.child
    this.child = null
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

  /**
   * Leaves the agent running for the router that replaces this one. Only a supervised agent
   * can be handed over: a directly spawned child has no keeper holding its pipes, so it goes
   * down with the process.
   */
  release() {
    if (!this.supervisorConfig) {
      this.dispose()
      return
    }
    this.dispose({ kill: false })
  }
}
