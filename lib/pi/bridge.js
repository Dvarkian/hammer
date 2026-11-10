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
import { PI_COMPACTION_DEFAULTS } from './agent-dir.js'
import { SupervisorClient, isLive } from './supervisor.js'
import { autoRetryNote, isTransportStreamFailure } from '../stream-failure.js'

export const PI_DEFAULT_COMMAND = 'pi'
/** RPC mode. Session storage is the launcher's business (see runtime.js). */
export const PI_DEFAULT_ARGS = ['--mode', 'rpc']

const COMMAND_TIMEOUT_MS = 20_000
/**
 * How long a compaction may take to answer.
 *
 * A compaction is a full model call that writes a summary of the whole conversation, not a
 * request Pi answers at once: a long session regularly takes a minute or two, and a slow
 * model on a large one takes longer still. `set_auto_compaction` is on the same budget
 * because Pi compacts during that call when it is switched back on. The generic command
 * timeout is for commands that answer immediately, and applying it here made every honest
 * compaction look like a failure.
 */
const COMPACTION_TIMEOUT_MS = 30 * 60_000
const LOG_LIMIT = 400
const LOG_MAX_CHARS = 512 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
/**
 * How often a streamed context estimate may repaint the meter. A delta can be a single
 * character, and the page repaints per frame: announcing every one would put a status frame
 * behind every token. The measured figure at `message_end` is never throttled.
 */
const CONTEXT_EMIT_MS = 250
/**
 * Mid-turn compactions one turn may make before it is left to finish or fail. A compacted
 * context has room again, so the first one is the useful one; the cap stops a boundary that
 * keeps being reached from becoming a compaction loop nobody asked for.
 */
const MID_TURN_COMPACTION_LIMIT = 2
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
/**
 * How many times one turn may be continued after a transport failure before the run is
 * handed back to the user as failed.
 *
 * Pi's own provider retry budget is three attempts of the *same* candidate; this budget is
 * what it hands on when it gives up, and it exists to keep a provider outage from becoming
 * an endless loop. Each attempt re-asks, so Hammer gets to route again — the point of the
 * feature. The counter resets on a completed turn and on a deliberate Stop, so a long
 * healthy session is never shortened by an earlier one's failures.
 */
const AUTO_CONTINUE_LIMIT = 3
/**
 * The pause before a continued turn. Pi's own backoff for the same failure is 2s * 2^n, so
 * this starts level with it; the retry is a *different* provider rather than the same one,
 * which is worth the wait it costs.
 */
const AUTO_CONTINUE_BASE_MS = 2_000
/**
 * The ceiling on a continuation's pause. OpenCode's session retry schedule is
 * exponential from 2s and capped at 10s, so the same ceiling keeps Hammer level with it.
 */
const AUTO_CONTINUE_MAX_DELAY_MS = 10_000
/**
 * The message a continued turn is sent as.
 *
 * Not "continue" alone: the model is being handed an assistant turn that failed and is
 * entitled to know the turn it is resuming produced nothing. Pi delivers it as a
 * follow-up, so the failed assistant message stays in the session as the record that the
 * turn ended there.
 */
const AUTO_CONTINUE_MESSAGE =
  'The previous turn ended without a response from the model (the connection was dropped mid-stream). Repeat your last action.'
/**
 * Beam routinely writes a plan ("Let me look at…") in one assistant message and the tool call
 * in the next. Pi ends the turn at the first message because it carries no tool call, which is
 * correct for every other model but leaves Beam waiting for a "Continue" the user has to type.
 * The continuation is deliberately unbounded: Beam does this after every prose message, so a
 * cap would only make the user type Continue again when it was reached.
 */
/** Short: nothing failed, so there is no reason to wait out a backoff. */
const PROSE_CONTINUE_DELAY_MS = 250
/**
 * How many turns in a row may be continued because the tool call they announced never
 * arrived. Asking again is the only thing that can recover a dropped call — the next request
 * often carries it — but a provider that drops every one will not be talked out of it, so the
 * chain stops and says why instead of looping forever.
 */
const DROPPED_CALL_LIMIT = 3
/** What a prose continuation is sent as. It names the mistake the model just made. */
export const PROSE_CONTINUE_MESSAGE =
  'Continue the task you were working on. You ended your turn after describing the next step; make that tool call now instead of stopping to explain it. Do not repeat work you have already done.'
/**
 * What an empty turn is continued as. An empty stop has no announcement to point at, and
 * telling the model it described a step it never wrote is what made the old prose prompt
 * ineffective here. Name the absence instead and ask for the next action.
 */
export const EMPTY_CONTINUE_MESSAGE =
  'Your last turn ended with no visible text and no tool call. Continue the task now: either make the next tool call or answer the user, and do not end your turn empty.'
/**
 * What a length cut is continued as. Hitting the output budget stops a turn mid-thought —
 * often mid-word — and nothing else about it is wrong, so the continuation has to say where
 * to resume rather than name a step the model never got to describe.
 */
export const LENGTH_CONTINUE_MESSAGE =
  'Your last turn was cut off by the output limit. Continue from exactly where you stopped, without repeating anything you have already written, and finish the thought.'

/**
 * The assistant message a turn ended on.
 *
 * The real child reports the whole run as `agent_end.messages`; the console's stub and older
 * records carry one `message`. Reading only one of those shapes is how a continuation is
 * decided against an empty object and never fires.
 * @param {any} record an `agent_end` record
 * @returns {any|null}
 */
function endingAssistantMessage(record) {
  for (const message of endingMessages(record).slice().reverse()) {
    if (message?.role === 'assistant') return message
  }
  return record?.message || record?.data?.message || null
}

/**
 * The messages an `agent_end` record carries, in either shape Pi reports them in.
 * @param {any} record
 * @returns {any[]}
 */
function endingMessages(record) {
  if (Array.isArray(record?.messages)) return record.messages
  if (Array.isArray(record?.data?.messages)) return record.data.messages
  return []
}

/**
 * The visible text of an assistant message. Pi stores content as parts (text, thinking,
 * toolCall), while the console's stub and older records use a plain string; reading both is
 * what keeps the announcement check working against either.
 * @param {any} message
 * @returns {string}
 */
function assistantText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Whether one assistant message carried a tool call. Both shapes exist in the wild: Pi's
 * content parts and the OpenAI-style `tool_calls` array a stub may carry.
 * @param {any} message
 * @returns {boolean}
 */
function hasToolCall(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return true
  const content = Array.isArray(message?.content) ? message.content : []
  return content.some((part) => part && part.type === 'toolCall')
}

/**
 * A line that announces a *tool action* rather than delivering one. Matching only the last
 * line keeps an answer that mentions one of these phrases in its body from being treated as
 * unfinished. The verb is part of the pattern, so closing lines ("Let me explain", "Let me
 * know") never trigger it.
 */
const CONTINUE_CUE =
  /^(?:let me|let's|i'll|i will|now i|next,? i|i'm going to|i need to|i should|first,? i|then i)\s+(?:also\s+)?(?:look|read|check|run|inspect|search|open|list|grep|review|examine|test|fix|update|write|edit|apply|trace|find|verify|add|remove|pull up|dig)\b/i

/**
 * Whether a message ended on a tool announcement and, with it, a promise the model did not
 * keep. A model's own chat template leaking into the text (`<start|user`, `<|rf|parameter`)
 * is the same signal: it is writing a turn boundary or a native tool call and Pi sees neither.
 * @param {string} text
 * @returns {boolean}
 */
function endsOnAnnouncement(text) {
  const raw = String(text || '')
  if (/<start\|user|<\|rf\|parameter/i.test(raw)) return true
  const lastLine = raw.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  return CONTINUE_CUE.test(lastLine)
}

/**
 * Beam is the one model observed ending an assistant message before its tool call. The name
 * comes from the router's selection, not the message: Pi records only the routing alias
 * (`best`), so `message.model` cannot tell the two apart.
 * @param {unknown} model
 * @returns {boolean}
 */
function isBeamModel(model) {
  return typeof model === 'string' && /beam/i.test(model)
}

/**
 * Whether an assistant message names Beam itself. Pi records the routing alias (`best`) on
 * `model`, but the provider's own `responseModel` is the model that actually answered. That
 * matters here because the router can re-pick before `agent_end`: the next request's model
 * is not the one whose empty turn this is.
 * @param {any} message
 * @returns {boolean}
 */
function assistantNamesBeam(message) {
  return [message?.responseModel, message?.model].some(
    (value) => typeof value === 'string' && /beam/i.test(value),
  )
}

/** RPC commands the console may send on a caller's behalf. */
export const PI_COMMANDS = new Set([
  'get_state',
  'get_messages',
  'get_available_models',
  'set_model',
  'cycle_model',
  'set_thinking_level',
  'compact',
  // Whether pi will compact on its own. It is on the list because "auto-compaction is off"
  // is a fact the console must be able to change without a restart, and because a router
  // whose context meter keeps climbing needs to know why.
  'set_auto_compaction',
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

/**
 * A context figure is kept only when pi actually reported a number: `null` means "not
 * measured", and coercing it with `Number()` would read as 0 — a full lie for a meter.
 * @param {unknown} value
 * @returns {number | null}
 */
function contextNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class PiBridge extends EventEmitter {
  /** The `X-Hammer-Pi-Console` name this bridge's model configuration sends. */
  consoleKey = ''

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
   * @param {boolean} [options.autoContinue] continue a turn the model dropped mid-stream
   *   (see the protocol note above); false disables it entirely
   * @param {number} [options.autoContinueLimit] how many continuations one turn may take
   * @param {number} [options.autoContinueBaseMs] first continuation backoff
   * @param {(() => string|null)|null} [options.routedModel] the model `best` currently resolves
   *   to; the router owns it because Pi itself records only the alias (see lib/server.js)
   * @param {(() => number|null)|null} [options.routedWindowTokens] that model's own request
   *   window, so a mid-turn compaction can see a ceiling tighter than Pi's alias window
   * @param {number|null} [options.compactionReserveTokens] the reserve Pi compacts against, as
   *   the launch configured it (see lib/pi/settings.js); null means Pi's default
   * @param {{ socket: string, script: string, node: string, env?: Record<string, string>, idleMs?: number } | null} [options.supervisor]
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
    autoContinue = true,
    autoContinueLimit = AUTO_CONTINUE_LIMIT,
    autoContinueBaseMs = AUTO_CONTINUE_BASE_MS,
    routedModel = null,
    routedWindowTokens = null,
    compactionReserveTokens = null,
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
    /** @type {{ socket: string, script: string, node: string, env?: Record<string, string>, idleMs?: number } | null} */
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
    /** @type {{ available: boolean | null, error: string | null, model: any, isStreaming: boolean, sessionId: string | null, sessionFile: string | null, sessionName: string | null, thinkingLevel: string | null, queuedSteering: string[], queuedFollowUp: string[], isCompacting: boolean, autoCompactionEnabled: boolean|null, compactionReason: string|null, compactionError: string|null, contextUsage: { tokens: number|null, contextWindow: number|null, percent: number|null, estimated?: boolean } }} */
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
      isCompacting: false,
      autoCompactionEnabled: null,
      compactionReason: null,
      compactionError: null,
      contextUsage: { tokens: null, contextWindow: null, percent: null },
    }
    /**
     * Compactions this session, by reason, for the status card.
     *
     * Counted from `compaction_start`, which is the one record both a successful compaction
     * and a cancelled one emit, so the total is what actually happened rather than what
     * finished. `lastCompactionAt` lets the page show when the last one was.
     */
    this.compactionCount = 0
    /** @type {number|null} Date.now() of the most recent compaction start */
    this.lastCompactionAt = null
    this.seq = 0
    this.disposed = false
    /** @type {boolean} */
    this.autoContinue = autoContinue
    /** @type {number} */
    this.autoContinueLimit = autoContinueLimit
    /** @type {number} */
    this.autoContinueBaseMs = autoContinueBaseMs
    /** @type {(() => string|null)|null} */
    this.routedModel = routedModel
    /** @type {(() => number|null)|null} the routed row's own request window, when it has one */
    this.routedWindowTokens = routedWindowTokens
    /** @type {number|null} the reserve Pi compacts against, as the launch configured it */
    this.compactionReserveTokens = compactionReserveTokens
    /** @type {NodeJS.Timeout | null} the pending continuation of a dropped turn */
    this.continueTimer = null
    /**
     * Invalidates a continuation that is already waiting out its backoff, so a Stop during
     * the pause cannot be followed by the prompt it was meant to cancel.
     * @type {number}
     */
    this.continueToken = 0
    /** @type {boolean} true while the bridge itself is sending the continuation prompt */
    this.sendingContinue = false
    /**
     * Continuations already spent by the run in flight. The budget resets where a turn
     * completes (or is stopped deliberately), which is what keeps a run from being shortened
     * by an earlier one's failures, so it must not reset merely because a turn settled.
     * @type {number}
     */
    this.continuesUsed = 0
    /** Prose continuations sent since the last user prompt, for the status note. @type {number} */
    this.proseContinuesUsed = 0
    /**
     * Output-limit continuations spent by the run in flight, for the status note. Kept apart
     * from the prose counter because the two chains are counted separately.
     * @type {number}
     */
    this.lengthContinuesUsed = 0
    /** @type {null|{errorMessage:string}} pending continuation waiting for settle */
    this.pendingContinue = null
    /** @type {boolean} a prose continuation waiting for `agent_settled` */
    this.pendingProseContinue = false
    /** @type {boolean} the armed prose continuation is for a turn with no visible text */
    this.pendingProseEmpty = false
    /** @type {boolean} the armed continuation is for a turn the output limit cut off */
    this.pendingProseLength = false
    /** @type {boolean} the armed prose continuation is for Beam, which is uncapped */
    this.pendingProseBeam = false
    /**
     * The last assistant message seen on `message_end`. `agent_end.messages` is the normal
     * source, but an older or stub-shaped record can omit it; the empty assistant message has
     * already been delivered by then, and losing it is how an empty turn goes un-nudged.
     * @type {any|null}
     */
    this.lastAssistantMessage = null
    /** Characters of the assistant message now streaming, for the live context tally. */
    this.streamChars = 0
    /** The context the streaming message is being added to, until it is measured. */
    this.streamBaseTokens = null
    /** When the estimate was last announced, so a token is not a status frame. */
    this.contextEmitAt = 0
    /** Mid-turn compactions this turn, so a boundary cannot compact in a loop. */
    this.midTurnCompactions = 0
    /** True while this bridge asked for the compaction in flight. */
    this.compactingMidTurn = false
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
      // Compaction is invisible work: the turn pauses, tokens are billed, and nothing the
      // model says mentions it. A status card that cannot show it cannot explain a long
      // silence or a context figure that dropped.
      isCompacting: this.state.isCompacting,
      autoCompactionEnabled: this.state.autoCompactionEnabled,
      compactionReason: this.state.compactionReason,
      compactionError: this.state.compactionError,
      compactionCount: this.compactionCount,
      lastCompactionAt: this.lastCompactionAt,
      contextUsage: this.state.contextUsage,
      error: this.state.error,
      stderr: this.stderr,
      events: this.log.length,
      cost: Number(this.usage.cost.toFixed(6)),
      restarts: this.restarts,
      notes: this.notes,
    }
  }

  /**
   * Hands the compaction summary pi is writing to the transcript.
   *
   * Pi says `compaction_start` and then nothing until `compaction_end`, which is a long silence
   * while a model writes thousands of tokens of summary. That summary is an ordinary completion
   * through this router, so the proxy taps the stream it relays and reports each piece here;
   * the guard is what keeps an ordinary turn's prose from being filed as a summary.
   * @param {string} text
   */
  noteCompactionText(text) {
    if (typeof text !== 'string' || !text) return
    if (!this.state.isCompacting) return
    this.handle({ type: 'compaction_delta', delta: text })
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
   * @param {{ replace?: boolean, adoptOnly?: boolean }} [options] `replace` asks a keeper to
   *   stop the child it holds and start the one this bridge now wants (a session switch, a
   *   restart); `adoptOnly` takes over an agent that is already running and never spawns one
   */
  async start({ replace = false, adoptOnly = false } = {}) {
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
    const attempt = this.supervisorConfig ? this.startKeeper(replace, adoptOnly) : this.startChild()

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
  async startKeeper(replace, adoptOnly = false) {
    const client = await this.ensureKeeper()
    const attached = await client.attach()
    // Adoption takes over an agent that is already running and nothing else. With no child
    // there is nothing to take over, and holding the keeper's controller would keep its idle
    // reaper from ever stopping the keeper.
    if (adoptOnly && !attached.child) {
      client.close()
      this.remote = null
      this.setPhase('idle')
      return
    }
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
   * Takes over the agent a previous router left running, without starting one.
   *
   * Nothing used to attach until a page asked for the console's status, so a router that came
   * back after a restart sat beside a live agent without hearing a single record from it. A
   * turn that ended in that gap settled into the keeper and stayed there: no router replayed
   * it, and so nothing armed the continuation it needed. This runs when the console's routes
   * are registered, which is the moment the new router exists.
   *
   * It is harmless when nothing is running: a keeper with no child is left alone (so its own
   * idle timer can still reap it) and an absent socket is not started.
   * @returns {Promise<boolean>} whether an agent was adopted
   */
  async adoptKeeper() {
    if (!this.supervisorConfig || this.disposed) return false
    if (this.isRunning()) return true
    if (!(await isLive(this.supervisorConfig.socket))) return false
    await this.start({ adoptOnly: true })
    return this.isRunning()
  }

  /**
   * Connects to the keeper for this console, starting one beside the router when none is
   * keeping an agent already. It is detached on purpose: it has to outlive this process.
   * @returns {Promise<SupervisorClient>}
   */
  async ensureKeeper() {
    if (this.remote && !this.remote.closed) return this.remote
    const config =
      /** @type {{ socket: string, script: string, node: string, env?: Record<string, string>, idleMs?: number }} */ (
        this.supervisorConfig
      )
    if (!(await isLive(config.socket))) {
      const args = [config.script, '--socket', config.socket]
      if (config.idleMs != null) args.push('--idle-ms', String(config.idleMs))
      /** @type {Error | null} */
      let keeperError = null
      // The keeper runs on the same interpreter as the agent (see launch.node), so when that is
      // Hammer's own electron binary it needs ELECTRON_RUN_AS_NODE to behave as Node too.
      const keeper = spawn(config.node, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...config.env },
      })
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
    /** @type {any[]} */
    const records = []
    for (const line of lines) {
      try {
        const record = JSON.parse(line)
        if (record && typeof record === 'object' && typeof record.type === 'string') {
          this.remember(record)
          records.push(record)
        }
      } catch {
        // A line torn by the keeper's bounded ring is expected at its head.
      }
    }
    this.continueReplayedTurn(records)
  }

  /**
   * Continues a turn that ended while no router was attached.
   *
   * Replayed records are remembered rather than tracked, because the router that witnessed
   * them already counted their usage. A continuation is not a counter, though: it is an
   * action nobody may have taken. A restart between `agent_end` and the follow-up prompt (the
   * turn finished during the restart, or its backoff timer died with the process) leaves one
   * trailing settle and nothing after it, and that is the only shape re-armed here. Anything
   * prompted after the settle — a user turn, or a continuation the old router managed to send
   * — puts a `message_start` or `agent_start` after it and is left alone, so the turn is never
   * continued twice.
   * @param {any[]} records the replayed records, oldest first
   * @private
   */
  continueReplayedTurn(records) {
    if (!this.autoContinue || this.disposed) return
    let settleIndex = -1
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (!record || typeof record !== 'object') continue
      if (record.type === 'agent_start') return
      if (record.type === 'message_start' && record.message?.role === 'user') return
      // A prompt the dead router queued but Pi had not begun: the continuation is already
      // waiting in the follow-up queue, and arming another would ask the same thing twice.
      if (record.type === 'queue_update') {
        const followUp = Array.isArray(record.followUp) ? record.followUp : []
        if (followUp.length) return
      }
      if (record.type === 'agent_settled') {
        settleIndex = index
        break
      }
    }
    if (settleIndex < 0) return
    /** @type {any} */
    let ending = null
    for (let index = settleIndex - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (!record || typeof record !== 'object') continue
      if (record.type === 'agent_start') break
      if (record.type === 'message_start' && record.message?.role === 'user') break
      if (record.type === 'agent_end') {
        ending = record
        break
      }
    }
    if (!ending) return
    // `agent_end` may omit `messages` (an older or stub-shaped record), and the continuation
    // checks fall back to the last assistant message seen — so keep the one this replay
    // carried rather than judging the turn against nothing.
    for (const record of records) {
      if (record?.type === 'message_end' && record.message?.role === 'assistant') {
        this.lastAssistantMessage = record.message
      }
    }
    this.considerContinuing(ending)
    this.armContinuation()
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
   * @returns {Promise<{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number, cost: number, contextUsage: { tokens: number|null, contextWindow: number|null, percent: number|null } } | undefined>}
   */
  async syncUsageFromSession() {
    try {
      const record = await this.send({ type: 'get_session_stats' })
      const stats = record?.data
      // The window is read before the token guard: a session that has not measured its tokens
      // yet still knows how large its window is, and `tokens: null` (pi's "not measured yet",
      // not "zero") must survive as null rather than be turned into an empty meter.
      const context = stats?.contextUsage
      if (context && typeof context === 'object')
        this.state.contextUsage = {
          // A finite *number* is required: `Number(null)` is 0, and letting that through
          // would turn pi's "not measured yet" into an empty meter a reader would trust.
          tokens: contextNumber(context.tokens),
          contextWindow: contextNumber(context.contextWindow),
          percent: contextNumber(context.percent),
          // Pi's own accounting is a measurement, not this bridge's estimate.
          estimated: false,
        }
      const tokens = stats?.tokens
      if (!tokens || typeof tokens !== 'object') {
        // The window is still worth announcing on its own: a session that reports no token
        // buckets but a window has said something a meter can draw.
        if (!this.disposed)
          this.emit('usage', { ...this.usage, contextUsage: this.state.contextUsage })
        return { ...this.usage, contextUsage: this.state.contextUsage }
      }
      const total = Number(tokens.total) || 0
      // Session accounting is authoritative, but a partial read — pi persists a message
      // slightly around when it emits it — must not clobber a counter that is already ahead.
      // The context window figure does not follow that rule: it was already applied above.
      if (total < this.usage.totalTokens) {
        // The token totals are behind, but the window is already updated above.
        if (!this.disposed)
          this.emit('usage', { ...this.usage, contextUsage: this.state.contextUsage })
        return { ...this.usage, contextUsage: this.state.contextUsage }
      }
      this.usage = {
        inputTokens: Number(tokens.input) || 0,
        outputTokens: Number(tokens.output) || 0,
        cacheReadTokens: Number(tokens.cacheRead) || 0,
        cacheWriteTokens: Number(tokens.cacheWrite) || 0,
        totalTokens: total,
        cost: Number(stats.cost) || this.usage.cost,
      }
      if (!this.disposed)
        this.emit('usage', { ...this.usage, contextUsage: this.state.contextUsage })
      // What it just learned, so a caller (and a test) can read the figures without digging
      // them back out of the status card.
      return { ...this.usage, contextUsage: this.state.contextUsage }
    } catch {
      // No stats (older pi, mid-restart child): keep whatever the event counter holds.
    }
  }

  /** Keeps just enough state to describe the agent without asking it. */
  track(record) {
    switch (record.type) {
      case 'agent_start':
        this.state.isStreaming = true
        // A new turn's messages are not the previous turn's; a fallback kept from the last
        // run must never make the next empty `agent_end` look like a Beam stop.
        this.lastAssistantMessage = null
        this.midTurnCompactions = 0
        this.streamChars = 0
        this.streamBaseTokens = null
        this.setPhase('busy')
        break
      case 'message_start':
        // The user message opens the turn; anything earlier is not this turn's answer.
        if (record.message?.role === 'user') this.lastAssistantMessage = null
        if (record.message?.role === 'assistant') {
          // The new message is added to the context as it was last measured; what it streams
          // is tallied on top of that until `message_end` reports the real figure.
          const measured = Number(this.state.contextUsage?.tokens)
          this.streamBaseTokens = Number.isFinite(measured) && measured > 0 ? measured : 0
          this.streamChars = 0
        }
        break
      case 'message_update': {
        const update = record.assistantMessageEvent || record.delta || {}
        if (update.type === 'text_delta' || update.type === 'thinking_delta') {
          if (typeof update.delta === 'string' && update.delta) this.noteStreamedText(update.delta)
        }
        break
      }
      case 'agent_settled':
        this.state.isStreaming = false
        // A completed turn is proof the agent works, so the crash budget starts over instead
        // of running out across a long, healthy session.
        this.restarts = 0
        this.setPhase('alive')
        // Pi has finished its own retries, compaction and queued work by the time this
        // arrives, so a continuation decided at `agent_end` can be sent now. It must not be
        // cleared first: the decision belongs to the turn that just ended, not to the next.
        this.armContinuation()
        // The turn's messages are all in: converge on pi's own session accounting, which is
        // the sum this counter should always end a turn equal to.
        this.syncUsageFromSession().catch(() => {})
        break
      case 'agent_end':
        // The turn is over and its messages are known. This is the one place both the
        // outcome and Pi's own verdict on it are readable, so the continue decision is
        // made here and carried to `agent_settled` by `pendingContinue`.
        this.considerContinuing(record)
        break
      case 'message_end':
        // `turn_end` repeats the same message, so counting there would double it.
        this.addUsage(record.message)
        // Kept for an `agent_end` that carries no messages; see lastAssistantMessage.
        if (record.message?.role === 'assistant') {
          this.lastAssistantMessage = record.message
          // The measured figure ends the estimate, and is the one event that may decide a
          // mid-turn compaction: a guessed number must never cut a turn short.
          this.measureContext(record.message)
          this.maybeCompactMidTurn()
        }
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
      case 'compaction_start':
        // Pi fires the same event for a manual `/compact`, a threshold crossing and an
        // overflow recovery, so `reason` is what the transcript should say happened.
        this.state.isCompacting = true
        this.state.compactionReason =
          typeof record.reason === 'string' ? record.reason : this.state.compactionReason
        this.state.compactionError = null
        this.compactionCount += 1
        this.lastCompactionAt = Date.now()
        // Compaction is not a turn, so this must not look like one: the phase is untouched
        // (a threshold compaction happens between turns, an overflow one inside one).
        if (!this.disposed) this.emit('status', this.status())
        break
      case 'compaction_end':
        this.state.isCompacting = false
        this.state.compactionError =
          typeof record.errorMessage === 'string' ? record.errorMessage : null
        if (!this.disposed) this.emit('status', this.status())
        break
      case 'compaction_cost':
      case 'compaction_declined':
      case 'compaction_delta':
        // Pi's own summarization telemetry: the cost frame carries the tokens the summary
        // itself billed, which `getSessionStats` already includes, and the delta is the
        // streamed summary text. Neither changes bridge state, and both are forwarded.
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

  /**
   * Tallies the context while the model writes, instead of leaving the meter at whatever the
   * previous turn ended with.
   *
   * Pi reports usage only on `message_end`, so a long answer used to leave the meter frozen
   * until it was over — the exact stretch a reader is watching. The streamed text is the only
   * signal before then: four characters per token is a rough figure, so it is published with
   * `estimated: true` rather than presented as a measurement. The model's own usage replaces
   * it at `message_end`.
   * @param {string} delta
   * @private
   */
  noteStreamedText(delta) {
    if (this.disposed) return
    if (this.streamBaseTokens == null) {
      const measured = Number(this.state.contextUsage?.tokens)
      this.streamBaseTokens = Number.isFinite(measured) && measured > 0 ? measured : 0
    }
    this.streamChars += delta.length
    this.applyContextTokens(this.streamBaseTokens + Math.round(this.streamChars / 4), {
      estimated: true,
      throttleMs: CONTEXT_EMIT_MS,
    })
  }

  /**
   * Replaces the live estimate with what the assistant message's own usage measured: the
   * request it answered plus its reply, which is the context the next step will carry.
   * @param {any} message an assistant `message_end` payload
   * @private
   */
  measureContext(message) {
    const usage = message?.usage
    if (!usage || message?.role !== 'assistant') return
    const input = Number(usage.input) || 0
    const output = Number(usage.output) || 0
    const cacheRead = Number(usage.cacheRead) || 0
    const cacheWrite = Number(usage.cacheWrite) || 0
    const tokens = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite
    if (!tokens) return
    this.streamBaseTokens = null
    this.streamChars = 0
    this.applyContextTokens(tokens, { estimated: false })
  }

  /**
   * Publishes one context figure: tokens, the share of the window, and whether it was measured
   * or estimated.
   * @param {number} tokens
   * @param {{ estimated: boolean, throttleMs?: number }} options
   * @private
   */
  applyContextTokens(tokens, { estimated, throttleMs = 0 }) {
    const window = Number(this.state.contextUsage?.contextWindow)
    const known = Number.isFinite(window) && window > 0 ? window : null
    const now = Date.now()
    if (throttleMs > 0 && estimated && now - this.contextEmitAt < throttleMs) return
    this.contextEmitAt = now
    this.state.contextUsage = {
      tokens,
      contextWindow: known,
      percent: known ? Math.round((tokens / known) * 1000) / 10 : null,
      estimated,
    }
    if (!this.disposed) this.emit('usage', { ...this.usage, contextUsage: this.state.contextUsage })
  }

  /**
   * The context budget Pi plans against, narrowed by the model it actually routes to.
   *
   * Pi compacts at `window - reserve` for the window Hammer's alias declares. A relay can
   * refuse a request well below that (`err_free_prompt_cap` is the live case), so the routed
   * row's own window is a second, tighter ceiling.
   * @private
   */
  contextCeiling() {
    const piWindow = Number(this.state.contextUsage?.contextWindow)
    const routed = Number(this.routedWindowTokens?.())
    const limits = [piWindow, routed].filter((value) => Number.isFinite(value) && value > 0)
    return limits.length ? Math.min(...limits) : null
  }

  /**
   * Compacts in the middle of a turn when the context reaches the boundary Pi will not cross.
   *
   * The preflight in the prompt route covers a full context when a prompt is sent. A long turn
   * reaches the same boundary between its own steps — after the model's message, before the
   * next request — where nobody is there to compact for it and the request fails instead.
   *
   * Pi's `compact` aborts the running turn (`session.compact()` does), so this fires only at a
   * message boundary and says in the note that it interrupted the turn to make room. It never
   * fires for an estimate: a number this bridge guessed must not cut a turn short.
   * @private
   */
  maybeCompactMidTurn() {
    if (!this.state.isStreaming || this.disposed) return
    if (this.state.isCompacting || this.compactingMidTurn) return
    // An explicit "off" is Pi's own decision and is respected; `null` (not reported) is not.
    if (this.state.autoCompactionEnabled === false) return
    if (this.midTurnCompactions >= MID_TURN_COMPACTION_LIMIT) return
    const tokens = Number(this.state.contextUsage?.tokens)
    const ceiling = this.contextCeiling()
    if (!Number.isFinite(tokens) || tokens <= 0 || !ceiling) return
    const reserve = Number(this.compactionReserveTokens)
    const room =
      Number.isFinite(reserve) && reserve > 0 ? reserve : PI_COMPACTION_DEFAULTS.reserveTokens
    if (tokens < Math.max(0, ceiling - room)) return
    this.compactingMidTurn = true
    this.midTurnCompactions += 1
    const percent = Number(this.state.contextUsage?.percent)
    this.addNote(
      `Context reached ${Number.isFinite(percent) ? `${Math.round(percent)}% of ` : ''}the ${ceiling}-token limit mid-turn; compacting now. Pi stops the turn to do it.`,
    )
    void this.runCommand('compact')
      .catch((err) => {
        this.addNote(`Could not compact mid-turn: ${/** @type {Error} */ (err)?.message || err}`)
      })
      .finally(() => {
        this.compactingMidTurn = false
      })
  }

  /**
   * Drops a continuation that has not been sent yet and resets the budget. Called when the
   * user stops, resets or restarts the run: those are deliberate decisions, not a failed
   * turn, and the next run starts with the whole budget.
   *
   * The token invalidates a timer that has already fired and is waiting out its backoff, so
   * a Stop during the pause is not followed by the prompt it was meant to cancel.
   * @private
   */
  cancelContinuation() {
    this.continueToken += 1
    if (this.continueTimer) {
      clearTimeout(this.continueTimer)
      this.continueTimer = null
    }
    this.pendingContinue = null
    this.pendingProseContinue = false
    this.pendingProseEmpty = false
    this.pendingProseLength = false
    this.pendingProseBeam = false
    this.continuesUsed = 0
    this.proseContinuesUsed = 0
    this.lengthContinuesUsed = 0
    this.droppedCallsUsed = 0
  }

  /**
   * Decides whether a turn that just ended should be continued, and carries that decision to
   * `agent_settled` in `pendingContinue`.
   * @private
   */
  considerContinuing(record) {
    if (!this.autoContinue) return
    // This turn's decision replaces the last one; only this pair of events can arm a send.
    this.pendingContinue = null
    this.pendingProseContinue = false
    this.pendingProseEmpty = false
    this.pendingProseLength = false
    this.pendingProseBeam = false
    const willRetry =
      typeof record.willRetry === 'boolean' ? record.willRetry : record.data?.willRetry
    // Pi decides whether to retry its own provider call from the same error text, and it
    // says so on agent_end (record fields for the real child, data fields when the console
    // stubbed the bridge). If pi will retry the same provider, Hammer must not add another
    // attempt on top — two retries of the same failure is just two failures in a row.
    if (willRetry) return
    const message = endingAssistantMessage(record)
    const errorMessage =
      typeof message?.errorMessage === 'string' ? message.errorMessage.trim() : ''
    if (!errorMessage) {
      // A turn with no error text finished, or was stopped deliberately. Either way this is
      // where a healthy run hands back the transport budget it did not spend.
      this.continuesUsed = 0
      // A length cut is checked first, and for every model: it is not an answer, it is the
      // provider cutting a turn off mid-thought.
      this.considerLengthContinuation(record)
      if (!this.pendingProseContinue) this.considerProseContinuation(record)
      // A turn that ended without being continued is a turn the model finished (or one whose
      // stop was a verdict): the mid-thought chain is over, so the next stuck task starts with
      // its own budget instead of whatever a previous one spent.
      if (!this.pendingProseContinue) this.proseContinuesUsed = 0
      if (!this.pendingProseLength) this.lengthContinuesUsed = 0
      // Only a turn that did not announce a call ends the dropped-call chain: the count exists
      // to stop that exact stop from looping, so it must survive the turn it skipped.
      if (endingAssistantMessage(record)?.stopReason !== 'toolUse') this.droppedCallsUsed = 0
      return
    }
    // Only a transport failure is worth continuing. A refusal, a spent quota, a policy gate
    // or the user stopping the run is a verdict about the request, and repeating it is asking
    // again.
    if (!isTransportStreamFailure(errorMessage)) {
      this.pendingContinue = null
      this.continuesUsed = 0
      this.proseContinuesUsed = 0
      return
    }
    if (this.continuesUsed >= this.autoContinueLimit) {
      this.pendingContinue = null
      this.addNote(
        `Stopped retrying after ${this.continuesUsed} transport failures; the last one was "${errorMessage.slice(0, 120)}".`,
      )
      return
    }
    this.pendingContinue = { errorMessage }
  }

  /**
   * Decides whether a turn that just ended should be continued because Beam stopped on prose.
   * The last message must either announce a tool action (in which case this run must already
   * have used a tool, because a plain answer can open with "Let me…") or carry no visible text
   * at all. Beam also stops there, and an empty message is never a final answer, so it needs no
   * tool-use guard. A final answer and an aborted run are left alone; a length cut is continued
   * by `considerLengthContinuation`, which handles every model rather than only Beam. A
   * `toolUse` stop with no call is continued for every model too: it means a call was announced
   * and its payload never arrived, which leaves Pi nothing to run.
   * @param {any} record an `agent_end` record
   * @private
   */
  considerProseContinuation(record) {
    const message = endingAssistantMessage(record) || this.lastAssistantMessage
    if (!message || message.role !== 'assistant') return
    if (hasToolCall(message)) return
    // A `toolUse` stop with nothing to run is a call that never arrived. Pi records that stop
    // only when the provider said `finish_reason: tool_calls`, so it says the same thing for
    // every model: a call was announced, and this message does not carry it. Pi has nothing to
    // execute, the turn settles, and the console sits waiting for a Continue nobody types —
    // which is how a whole session can stop after one sentence. Beam leaves this shape when
    // its native call is dropped; a relay that strips the delta leaves it for any model.
    if (message.stopReason === 'toolUse') {
      const used = Number(this.droppedCallsUsed) || 0
      if (used >= DROPPED_CALL_LIMIT) {
        this.droppedCallsUsed = used + 1
        // Say it once, then stop: repeating the same prompt against a provider that keeps
        // dropping calls is a loop, not a recovery.
        if (used === DROPPED_CALL_LIMIT) {
          this.addNote(
            `Stopped after ${DROPPED_CALL_LIMIT} turns whose tool call never arrived; the provider is announcing calls it does not send.`,
          )
        }
        return
      }
      this.droppedCallsUsed = used + 1
      this.pendingProseContinue = true
      this.pendingProseEmpty = !assistantText(message).trim()
      return
    }
    // The router's live selection is not necessarily the model that answered: routing can
    // move on before this turn settles. Prefer the assistant message's own response model,
    // and keep the routed pick as the fallback for records that do not carry one.
    if (!assistantNamesBeam(message) && !isBeamModel(this.routedModel?.())) return
    if (message.stopReason && message.stopReason !== 'stop') return
    const text = assistantText(message)
    if (text.trim()) {
      if (!endsOnAnnouncement(text)) return
      // Messages before the last user prompt belong to earlier work: their tool calls must not
      // make a fresh question look unfinished.
      const messages = endingMessages(record)
      let start = 0
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
          start = index
          break
        }
      }
      if (
        !messages.slice(start).some((entry) => entry?.role === 'assistant' && hasToolCall(entry))
      ) {
        return
      }
    }
    this.pendingProseContinue = true
    this.pendingProseEmpty = !text.trim()
  }

  /**
   * Decides whether a turn the provider cut off at the output limit should be continued.
   *
   * A `length` stop is not the model's answer: the stream ended while it was still writing.
   * With a reasoning model the whole budget can go on thinking, so the turn arrives with no
   * text and no tool call at all — Pi records it as a finished turn, and without this the
   * console simply stops and waits for someone to type "Continue".
   *
   * Not capped at any fixed number, unlike a retry ladder: the provider ended the turn, not
   * the model, so there is no count at which the cut has become an answer. The running count
   * is in the note, and Stop cancels the chain the same way it cancels everything else.
   * @param {any} record an `agent_end` record
   * @private
   */
  considerLengthContinuation(record) {
    const message = endingAssistantMessage(record) || this.lastAssistantMessage
    if (!message || message.role !== 'assistant') return
    if (message.stopReason !== 'length') return
    // A cut that still delivered a tool call completed something: the tool runs and Pi's own
    // loop carries the run on, so there is nothing to nudge.
    if (hasToolCall(message)) return
    this.pendingProseContinue = true
    this.pendingProseEmpty = !assistantText(message).trim()
    this.pendingProseLength = true
  }

  /**
   * Schedules the continuation promised by `considerContinuing`, now that Pi has settled.
   * The delay is a tracked timer so Stop/reset can cancel it, and the token prevents a timer
   * that already fired from sending after that cancellation.
   * @private
   */
  armContinuation() {
    if (!this.autoContinue || this.disposed) return
    if (this.pendingProseContinue) {
      this.pendingProseContinue = false
      const length = this.pendingProseLength
      this.pendingProseLength = false
      const empty = this.pendingProseEmpty
      this.pendingProseEmpty = false
      const proseToken = this.continueToken
      this.proseContinuesUsed += 1
      if (length) this.lengthContinuesUsed += 1
      this.addNote(
        length
          ? `Continuing a turn the output limit cut off (${this.lengthContinuesUsed}).`
          : empty
            ? `Continuing a turn that stopped with no text (${this.proseContinuesUsed}).`
            : `Continuing a turn that stopped after prose (${this.proseContinuesUsed}).`,
      )
      const message = length
        ? LENGTH_CONTINUE_MESSAGE
        : empty
          ? EMPTY_CONTINUE_MESSAGE
          : PROSE_CONTINUE_MESSAGE
      this.continueTimer = setTimeout(
        () => {
          this.continueTimer = null
          if (proseToken !== this.continueToken || this.disposed || !this.autoContinue) return
          void this.sendProseContinuation(proseToken, message)
        },
        Math.min(PROSE_CONTINUE_DELAY_MS, this.autoContinueBaseMs),
      )
      this.continueTimer.unref?.()
      return
    }
    if (!this.pendingContinue) return
    const { errorMessage } = this.pendingContinue
    this.pendingContinue = null
    this.continuesUsed += 1
    const attempt = this.continuesUsed
    const of = this.autoContinueLimit
    this.addNote(autoRetryNote({ attempt, of }))
    this.addNote(`Failure: ${errorMessage.slice(0, 200)}.`)
    const token = this.continueToken
    this.continueTimer = setTimeout(
      () => {
        this.continueTimer = null
        if (token !== this.continueToken || this.disposed || !this.autoContinue) return
        void this.sendContinuation(token)
      },
      Math.min(AUTO_CONTINUE_MAX_DELAY_MS, this.autoContinueBaseMs * 2 ** (attempt - 1)),
    )
    this.continueTimer.unref?.()
  }

  /**
   * Sends the continuation armed by `armContinuation`. Delivered as a follow-up so the
   * failed assistant message stays in the session as the record of where the turn ended,
   * and the continued turn is what comes after it.
   * @private
   * @param {number} token the cancellation generation this send belongs to
   */
  async sendContinuation(token) {
    this.sendingContinue = true
    try {
      await this.prompt(AUTO_CONTINUE_MESSAGE, { queueMode: 'followUp' })
    } catch (err) {
      // A continuation that cannot even be queued is a dead end: report it once instead of
      // spending more budget on the same broken turn.
      if (token === this.continueToken) {
        this.addNote(`Could not continue the turn: ${/** @type {Error} */ (err)?.message || err}`)
        this.continuesUsed = this.autoContinueLimit
      }
    } finally {
      this.sendingContinue = false
    }
    if (!this.disposed && token === this.continueToken) this.emit('status', this.status())
  }

  /**
   * Sends the prose continuation armed by `armContinuation`. Like a transport continuation it
   * is a follow-up, so the message that stopped stays in the transcript as the record of where
   * the turn ended. `sendingContinue` keeps `prompt` from resetting the budget it just spent.
   * @private
   * @param {number} token the cancellation generation this send belongs to
   * @param {string} [message] the prompt for this kind of stop
   */
  async sendProseContinuation(token, message = PROSE_CONTINUE_MESSAGE) {
    this.sendingContinue = true
    try {
      await this.prompt(message, { queueMode: 'followUp' })
    } catch (err) {
      if (token === this.continueToken) {
        this.addNote(`Could not continue the turn: ${/** @type {Error} */ (err)?.message || err}`)
      }
    } finally {
      this.sendingContinue = false
    }
    if (!this.disposed && token === this.continueToken) this.emit('status', this.status())
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
    // Pi's own `get_state` carries whether it will compact on its own and whether it is
    // doing so right now. Both are read as three-valued: `undefined` means "this pi does not
    // report it", which is different from a pi that reports `false`.
    if (typeof data.autoCompactionEnabled === 'boolean')
      this.state.autoCompactionEnabled = data.autoCompactionEnabled
    if (typeof data.isCompacting === 'boolean') this.state.isCompacting = data.isCompacting
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
   * Forgets the session this bridge is attached to, without touching the child.
   *
   * Deleting a session out from under a console is the caller's decision, and it has to be
   * acted on here: Pi appends to a session file with `appendFileSync`, which creates it if
   * it is gone, so a bridge left attached would resurrect the deleted file with a
   * truncated history on its next write. The agent keeps running and sits attached to
   * nothing — which is what a fresh conversation looks like — and the status broadcast lets
   * the page drop the row it can no longer open.
   */
  detachSession() {
    const had = Boolean(this.state.sessionFile || this.state.sessionId || this.state.sessionName)
    this.state.sessionFile = null
    this.state.sessionId = null
    this.state.sessionName = null
    if (had && !this.disposed) this.emit('status', this.status())
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
    // A prompt from the console is a new run and supersedes a continuation a failed turn
    // queued: the user has said what to do next, so the budget starts over rather than
    // talking over them.
    if (!this.sendingContinue) this.cancelContinuation()
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
    this.cancelContinuation()
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
    this.cancelContinuation()
    const record = await this.send({ type: 'new_session' })
    if (record.data?.cancelled !== true) {
      this.log = []
      this.logChars = 0
      this.state.sessionId = null
      this.state.sessionFile = null
      // A fresh session has no history to have compacted, and carrying the old count forward
      // would make its context meter start somewhere other than empty.
      this.compactionCount = 0
      this.lastCompactionAt = null
      this.state.compactionReason = null
      this.state.compactionError = null
      this.state.contextUsage = { tokens: null, contextWindow: null, percent: null }
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
    // Summarising is the one slow command: it waits on a model to write the whole summary,
    // so it gets the summarization budget rather than the request/response one.
    const record = await this.send(
      { ...args, type },
      type === 'compact' || type === 'set_auto_compaction'
        ? { timeoutMs: COMPACTION_TIMEOUT_MS }
        : {},
    )
    if (type === 'get_state' && record.data) this.applyState(record.data)
    if (type === 'set_model' && record.data) this.state.model = record.data
    if (type === 'set_thinking_level' && args.level) this.state.thinkingLevel = args.level
    if (type === 'set_auto_compaction' && typeof args.enabled === 'boolean') {
      // Pi compacts during this same call, so the state it changes is read back rather than
      // assumed: an older pi would ignore the command and the card would then lie.
      this.state.autoCompactionEnabled = args.enabled
      if (!this.disposed) this.emit('status', this.status())
    }
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
    this.cancelContinuation()
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
    this.cancelContinuation()
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
