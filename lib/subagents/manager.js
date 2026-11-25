// @ts-check
/**
 * @file manager.js
 * @description The live subagent runtime: one real Pi child per record, owned by a keeper.
 *
 * The manager is the only place that turns a principal token into a spawn, a route pool or
 * a transcript read. It creates a private Pi agent directory per child (models.json carries
 * `X-Hammer-Pi-Console: sub-<id>`, the extension and a generic charter), starts the bridge
 * through the same keeper the console uses, and records completion.
 *
 * The parent is never given a child's token, and a child is never given the parent's.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PiBridge, endsOnAnnouncement } from '../pi/bridge.js'
import { planPiLaunch } from '../pi/runtime.js'
import {
  materializeSupervisor,
  supervisorScriptPath,
  supervisorSocketPath,
} from '../pi/supervisor.js'
import { getRoutingModelKey } from '../utils.js'
import {
  buildActiveGroups,
  buildSubagentPool,
  cataloguePayload,
  formatCatalogueText,
  matchesCatalogueFilters,
  resolveSpawnGroup,
} from './catalogue.js'
import { usageTagLabel } from './model-usage.js'
import { childCharter, materializeSubagentExtension, writeChildCharter } from './extension.js'
import {
  CAPS,
  canControlRecord,
  canMessageRecord,
  canReadRecord,
  DEFAULT_LIMITS,
  isUiPrincipal,
  minimalStatus,
  normalizeSpawnRequest,
  PI_TOOL_NAMES,
  reportPayload,
  sameRoot,
  xmlReport,
} from './policy.js'
import {
  SubagentRegistry,
  generateSubagentId,
  rootIdForConsole,
  subagentRegistryPath,
  subagentReportPath,
} from './registry.js'
import { SubagentTokenStore, subagentTokenPath } from './token-store.js'
import { setActiveSubagentManager } from './live.js'
import { materializeWebExtension } from '../pi/web-tools.js'

const SAVE_DEBOUNCE_MS = 400
const BUDGET_TICK_MS = 5_000
/**
 * A child's first prompt is sent while Pi is still coming up. `send`'s ordinary twenty-second
 * command timeout is right for a request and too short for a launch: a first prompt that timed
 * out failed a healthy child ("Pi did not answer prompt within 20s") before it could take a turn.
 */
const CHILD_PROMPT_ACK_MS = 90_000
/**
 * A turn that has produced no text, no reasoning and no tool call for this long is not thinking,
 * it is a request hanging on a route. Failing it names the route and frees the parent instead of
 * leaving a child "running" with zero tokens until its twenty-minute budget runs out.
 */
const CHILD_FIRST_OUTPUT_MS = 180_000
/** How many times a child that stopped while announcing the next step is asked to carry on. */
const CHILD_CONTINUATION_LIMIT = 2
const CHILD_CONTINUE_MESSAGE =
  'Continue the delegated task. You ended your turn after describing the next step; make that tool call now using the tool interface, not by writing tool-call JSON in your message. If the task is complete, write your final report instead.'
const CHILD_WRAPUP_MESSAGE =
  'Stop researching now and write your final report to the parent. Do not make another tool call and do not describe a next step.'

/** @param {unknown} value @returns {number|null} */
function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** @param {string} url */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** @param {any} content */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('')
}

/** @param {any} record */
function assistantText(record) {
  const message = record?.message
  if (!message || message.role !== 'assistant') return ''
  return textOfContent(message.content)
}

/** A closing tag for a reasoning block a route left in the visible text. */
const REASONING_CLOSE = /<\/think(?:ing)?>|<\/thought>/i

/** A tool result that failed for a reason retrying the same tool cannot fix. */
const TOOL_FAILURE_RE =
  /\b429\b|rate limit|quota|web fetch failed|web search failed|request failed|HTTP [45]\d\d|captcha|challenge|forbidden|blocked/i
/** Consecutive failed tool results before the child is told to stop retrying. */
const TOOL_FAILURE_NUDGE_AT = 4
/**
 * A malformed tool-call argument is a formatting slip, not a dead route: the model wrote two
 * JSON objects into one `arguments` string and Pi refused the call. Two research children died
 * outright on this. One retry, on the same session, is enough to re-issue the call properly.
 */
const TOOL_ARGUMENT_ERROR_RE =
  /Unexpected non-whitespace character after JSON|Unexpected token .{0,40}in JSON|Expected .{0,40}in JSON|not valid JSON/i
const MALFORMED_ARGUMENTS_MESSAGE =
  'Your last tool call was rejected because its arguments were not valid JSON (more than one JSON object was written into a single call). Re-issue that one tool call now with a single valid JSON object, then finish the task and write the report.'
/**
 * A free route can drop the connection mid-turn. Recorded live: a child doing real work was
 * aborted after 253 seconds with a bare `This operation was aborted` and lost everything it had
 * found. A dropped connection is not a finished task; one retry on a fresh request is.
 */
const RECOVERABLE_TURN_ERROR_RE =
  /This operation was aborted|Connection error|stream stalled|socket hang up|ECONNRESET|fetch failed|\b50[234]\b|\b429\b/i
const ABORTED_TURN_MESSAGE =
  'The model connection failed mid-turn and your last tool call was cut off. Continue from the evidence you already have, retry only what is essential, and finish with the report.'
const STOP_TOOLS_MESSAGE =
  'Stop using tools now. Write your final report from the evidence you already have, name the sources you reached, and say explicitly what could not be checked.'
const TOOL_FAILURE_NUDGE_MESSAGE =
  'Several tool calls in a row just failed on the upstream service (rate limit, blocked or error). Stop retrying the same tool. Write your report now from the evidence you already have, and name in it which tools failed and what could not be checked.'

/**
 * Whether a final message is only call payload — JSON objects with no prose around them.
 *
 * A route that drops the function name serializes the *arguments* of the next call into the
 * answer, so a child that was still working ends with `{"url": …}` instead of a report. That is
 * neither a plan nor an answer, and it used to be stored as a 146-character "completed report".
 * @param {string} text
 * @returns {boolean}
 */
export function isPayloadOnly(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  let parsed = 0
  for (const line of lines) {
    if (/^```/.test(line)) continue
    if (!/^[[{]/.test(line)) return false
    try {
      JSON.parse(line)
      parsed += 1
    } catch {
      return false
    }
  }
  return parsed > 0
}

/**
 * The answer without the route's reasoning block in front of it.
 *
 * Several relays hand the model's ` thinking… response` preamble back inside `content` instead of
 * a separate thinking part, and every word of it became the child's report: one research child's
 * 16,000-character report was 9,300 characters of reasoning followed by the real thing. Nothing is
 * removed when the text before the close tag already looks like the answer (it has a markdown
 * heading), so a report that quotes a reasoning block keeps its own shape.
 * @param {string} text
 * @returns {string}
 */
export function stripReasoning(text) {
  const raw = String(text ?? '')
  if (!raw) return raw
  const close = raw.search(REASONING_CLOSE)
  if (close < 0) return raw
  const head = raw.slice(0, close)
  if (/^#{1,6}\s/m.test(head)) return raw
  return raw.slice(close).replace(REASONING_CLOSE, '').replace(/^\s+/, '')
}

/**
 * Pi reports a provider refusal as a final assistant message with `stopReason: "error"` and
 * the provider's own `errorMessage`. A child that carried that message into `completed`
 * looked like a silent empty report; keep the reason so the parent gets a failure it can act
 * on.
 * @param {any} message
 */
function assistantErrorMessage(message) {
  if (!message || message.role !== 'assistant') return ''
  const raw = message.errorMessage ?? message.error?.message ?? message.error
  const text =
    typeof raw === 'string' ? raw.trim() : raw && typeof raw === 'object' ? JSON.stringify(raw) : ''
  if (text) return text.slice(0, 2_000)
  if (message.stopReason === 'error') return "The child's model call failed."
  return ''
}

/**
 * Whether a keeper is still listening on a child's socket.
 *
 * The bridge's own `running` flag is not a liveness proof: a child killed with SIGKILL reports
 * running until the bridge notices the pipe close, and a prompt sent in that window queued
 * into nothing and left the record `running` with no process behind it. Connecting to the
 * keeper is the real signal — a stale socket file refuses the connection.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
function keeperAccepts(path) {
  return new Promise((resolve) => {
    if (!path) return resolve(false)
    const socket = connect(path)
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * The rough output estimate Pi streams before its measured `message_end` usage arrives. Four
 * characters per token is enough to stop a runaway answer inside its budget; the measured
 * figure replaces it when the message ends.
 * @param {any} event
 */
function streamedDeltaLength(event) {
  const update = event?.assistantMessageEvent || event?.delta
  if (!update || !['text_delta', 'thinking_delta'].includes(update.type)) return 0
  return typeof update.delta === 'string' ? update.delta.length : 0
}

/**
 * A bounded, readable transcript from Pi's session records. It names tool calls but never
 * dumps a raw protocol record, and it is the only place transcript text is assembled.
 * @param {any[]} records
 * @param {number} limit
 */
export function renderTranscriptRecords(records, limit = CAPS.maxTranscriptChars) {
  const lines = []
  let bytes = 0
  const push = (line) => {
    const text = String(line || '').trim()
    if (!text) return
    bytes += Buffer.byteLength(text, 'utf8')
    lines.push(text)
  }
  // A tool result can be a whole web page. The transcript is for context, not for replaying
  // that page: keep its opening, where the tool names the URL and the answer starts.
  const clipResult = (text) => {
    const value = String(text || '').trim()
    return value.length > 2_000 ? `${value.slice(0, 2_000)}\n…` : value
  }
  const pushMessage = (message) => {
    if (!message || typeof message !== 'object') return
    const role = message.role
    if (role === 'toolResult') {
      const result = clipResult(textOfContent(message.content))
      if (result) push(`result ${message.toolName || 'tool'}: ${result}`)
      return
    }
    if (role !== 'user' && role !== 'assistant') return
    const content = Array.isArray(message.content) ? message.content : null
    if (!content) {
      const text = textOfContent(message.content)
      if (text) push(`${role}: ${text}`)
      return
    }
    const text = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
    if (text) push(`${role}: ${text}`)
    for (const part of content) {
      if (!part || part.type !== 'toolCall') continue
      const args =
        part.arguments && typeof part.arguments === 'object' ? JSON.stringify(part.arguments) : ''
      push(`tool ${part.name || 'tool'}${args ? ` ${args}` : ''}`)
    }
  }
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue
    // Live bridge history carries protocol records (`message_end`), while a finished child's
    // session file carries Pi's persisted records (`message`). Reading only the former is why
    // a completed child's transcript was empty even though its session was complete.
    if (record.type === 'message' || record.type === 'message_end') {
      pushMessage(record.message)
      continue
    }
    if (record.type === 'tool_execution_start') {
      const args = record.args && typeof record.args === 'object' ? JSON.stringify(record.args) : ''
      push(`tool ${record.toolName || 'tool'}${args ? ` ${args}` : ''}`)
      continue
    }
    if (record.type === 'tool_execution_end') {
      const result = clipResult(textOfContent(record.result) || textOfContent(record.partialResult))
      if (result) push(`result ${record.toolName || ''}: ${result}`)
    }
  }
  let text = lines.join('\n')
  const wasTruncated = text.length > limit
  if (wasTruncated) text = text.slice(Math.max(0, text.length - limit))
  return { text, bytes, truncated: wasTruncated }
}

export class SubagentManager {
  /** @param {Record<string, any>} options */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '')
    this.apiBase = options.apiBase || originOf(this.baseUrl)
    this.settings = {
      brain: { command: '', args: [] },
      ...(options.settings || {}),
    }
    this.agentRoot = String(options.agentRoot || this.settings.agentRoot || '')
    this.sessionsRoot = String(options.sessionsRoot || this.settings.sessions || '')
    this.workspace = String(options.workspace || this.settings.workspace || process.cwd())
    this.parentKey = String(options.parentKey || 'default')
    this.rootId = rootIdForConsole(this.parentKey)
    this.results = typeof options.results === 'function' ? options.results : () => []
    this.canonicalize = options.canonicalize || null
    this.collectResults = typeof options.ensureResults === 'function' ? options.ensureResults : null
    this.createBridge = typeof options.createBridge === 'function' ? options.createBridge : null
    this.attachConsole = typeof options.attachConsole === 'function' ? options.attachConsole : null
    this.detachConsole = typeof options.detachConsole === 'function' ? options.detachConsole : null
    this.parentBridge =
      typeof options.parentBridge === 'function' ? options.parentBridge : () => null
    /** @type {Map<string, PiBridge>} every live parent console, by console key */
    this.parentBridges = new Map()
    /** @type {Map<string, { bridge: PiBridge, handler: (status: any) => void }>} */
    this.parentStatusHandlers = new Map()
    this.parentRoute = typeof options.parentRoute === 'function' ? options.parentRoute : () => null
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
    this.maxDepth = finite(options.maxDepth) ?? CAPS.maxDepth
    this.limits = options.limits || { ...DEFAULT_LIMITS }
    this.tokens = new SubagentTokenStore({ path: subagentTokenPath(this.agentRoot) })
    this.registry = new SubagentRegistry({ path: subagentRegistryPath(this.agentRoot) })
    /** @type {Map<string, PiBridge>} */
    this.bridges = new Map()
    /** @type {Map<string, any>} */
    this.childConsoles = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map()
    /** @type {Map<string, string>} */
    this.lastAssistant = new Map()
    /** @type {Map<string, any>} the full assistant message that ended the last turn */
    this.lastAssistantMessage = new Map()
    /** @type {Map<string, NodeJS.Timeout>} deferred completion while a continuation is due */
    this.finishTimers = new Map()
    /** @type {Map<string, { at:number, count:number }>} */
    this.messageRates = new Map()
    /** @type {Map<string, { at:number, count:number }>} */
    this.transcriptRates = new Map()
    /** @type {Map<string, { at:number, count:number }>} */
    this.lastMessageTurn = new Map()
    this.saveTimer = null
    this.changeTimer = null
    // The rail's group badges are cosmetic and the catalogue is expensive; a burst of child
    // events must not rebuild it more than once every few seconds.
    this.uiGroupsCache = null
    this.uiGroupsCachedAt = 0
    this.supervisor = null
    this.disposed = false
    this.uiTokenValue = ''
    this.uiRevision = 0
    this.parentTokenValue = this.parentTokenFor(this.parentKey)
    setActiveSubagentManager(this)
  }

  // ── identity ─────────────────────────────────────────────────────────────────────────

  /** @param {any} req */
  identify(req) {
    const auth = req?.get?.('authorization') || req?.headers?.authorization || ''
    const bearer = /^Bearer\s+(.+)$/i.exec(String(auth))?.[1]
    const header =
      req?.get?.('x-hammer-subagent-token') || req?.headers?.['x-hammer-subagent-token']
    const query = typeof req?.query?.token === 'string' ? req.query.token : ''
    const token = String(bearer || header || query || '').trim()
    return this.tokens.verify(token)
  }

  /** A scoped token for the local UI. The browser has no parent console process to hold one. */
  uiToken() {
    if (this.uiTokenValue) {
      const claims = this.tokens.verify(this.uiTokenValue)
      if (claims?.ui === true) return this.uiTokenValue
    }
    this.uiTokenValue = this.tokens.issue({
      type: 'ui',
      requesterId: 'ui',
      ui: true,
      parent: false,
      parentId: null,
      rootId: null,
      depth: 0,
      consoleKey: this.parentKey,
      tools: [],
      grants: { transcripts: true, message: true, spawn: false },
    })
    return this.uiTokenValue
  }

  /**
   * The parent token for one console. Each console carries its own so a spawn names the
   * conversation that asked for it, not whichever session the main console happens to be on.
   * @param {string} [consoleKey]
   */
  parentTokenFor(consoleKey) {
    const key = String(consoleKey || this.parentKey)
    const existing = this.tokens.parentToken(key)
    const token = this.tokens.issue(
      {
        type: 'parent',
        requesterId: 'root',
        parent: true,
        parentId: null,
        rootId: this.rootId,
        depth: 0,
        consoleKey: key,
        tools: [...PI_TOOL_NAMES],
        grants: { transcripts: true, message: true, spawn: true },
      },
      existing,
    )
    if (key === this.parentKey) this.parentTokenValue = token
    return token
  }

  /** @param {string} consoleKey */
  parentEnv(consoleKey = this.parentKey) {
    return {
      HAMMER_SUBAGENT_API: this.apiBase,
      HAMMER_SUBAGENT_TOKEN: this.parentTokenFor(consoleKey),
    }
  }

  /** @param {string} agentDir @param {string} [consoleKey] */
  prepareParentAgentDir(agentDir, consoleKey = this.parentKey) {
    materializeSubagentExtension(agentDir)
    materializeWebExtension(agentDir)
    return this.parentEnv(consoleKey)
  }

  /** @param {string} [consoleKey] */
  parentBridgeFor(consoleKey) {
    const key = String(consoleKey || this.parentKey)
    return this.parentBridges.get(key) || (key === this.parentKey ? this.parentBridge() : null)
  }

  /** The conversation one parent console is on, or null before it has one. */
  parentSessionFileFor(consoleKey) {
    try {
      return this.parentBridgeFor(consoleKey)?.status?.()?.sessionFile || null
    } catch {
      return null
    }
  }

  /** The conversation the main parent console is on, or null before it has one. */
  parentSessionFile() {
    return this.parentSessionFileFor(this.parentKey)
  }

  /**
   * The conversation a record hangs from. A nested child hangs from its immediate parent's
   * own run session; a root child hangs from the console that issued its spawn.
   * @param {any} record
   */
  parentSessionFileForRecord(record) {
    if (record?.parent?.sessionFile) return record.parent.sessionFile
    if (record?.parentId) return this.childSessionFile(this.registry.get(record.parentId))
    return this.parentSessionFileFor(record?.parent?.consoleKey)
  }

  /**
   * A console can be known before it has named its session file, which is exactly the window
   * a first-turn spawn happens in. Fill that value once the console reports it so the tree
   * stays under the conversation that asked instead of following whichever row is on screen.
   */
  syncParentSessionFiles() {
    let changed = false
    for (const record of this.registry.all()) {
      if (!record?.parent || record.parent.sessionFile) continue
      const sessionFile = this.parentSessionFileForRecord(record)
      if (!sessionFile) continue
      record.parent = { ...record.parent, sessionFile }
      changed = true
    }
    if (changed) this.persistSoon()
    return changed
  }

  /**
   * The session a child is actually running, which is the conversation its own children
   * belong to. A child that has not reported its session yet falls back to the conversation
   * it was spawned from, so startup does not split the branch.
   * @param {any} record
   */
  childSessionFile(record) {
    if (!record) return null
    const bridge = this.bridges.get(record.id)
    return (
      record.runs?.at(-1)?.sessionFile ||
      bridge?.status?.()?.sessionFile ||
      record.parent?.sessionFile ||
      null
    )
  }

  /**
   * The conversation whose children a model-facing principal may see. The UI is deliberately
   * unscoped: its rail shows each conversation's historical branch. The root follows the live
   * console, so switching sessions switches what it can list. A child stays on its own run
   * session, so its children do not move when the root changes conversations.
   * @param {any} principal
   */
  principalSessionFile(principal) {
    if (!principal || isUiPrincipal(principal)) return null
    if (principal.parent === true) {
      return this.parentSessionFileFor(principal.consoleKey) || principal.sessionFile || null
    }
    return this.childSessionFile(this.registry.get(String(principal.requesterId || '')))
  }

  /** @param {any} principal @param {any} record */
  inPrincipalSession(principal, record) {
    if (isUiPrincipal(principal)) return true
    const sessionFile = this.principalSessionFile(principal)
    return Boolean(sessionFile && record?.parent?.sessionFile === sessionFile)
  }

  // ── model catalogue ─────────────────────────────────────────────────────────────────

  allResults() {
    try {
      if (this.collectResults) this.collectResults()
    } catch {
      // The catalogue is a read of whatever the router has.
    }
    try {
      return this.results() || []
    } catch {
      return []
    }
  }

  inUseCounts() {
    const counts = new Map()
    for (const record of this.registry.all()) {
      if (record.status !== 'running') continue
      const key = record.model?.groupId
      if (!key) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }

  /** @param {any[]|null} [results] rows already read, so one catalogue does not read them twice */
  groups(results = null) {
    return buildActiveGroups({
      results: results || this.allResults(),
      canonicalize: this.canonicalize,
      inUseCounts: this.inUseCounts(),
    })
  }

  /** The rail's display catalogue, shared across the burst of events a turn produces. */
  groupsForSnapshot() {
    const now = Date.now()
    if (this.uiGroupsCache && now - this.uiGroupsCachedAt < 10_000) return this.uiGroupsCache
    this.uiGroupsCache = this.groups()
    this.uiGroupsCachedAt = now
    return this.uiGroupsCache
  }

  catalogue(params = {}) {
    const results = this.allResults()
    const groups = this.groups(results)
    const payload = cataloguePayload({ groups, ...params })
    return { payload, text: formatCatalogueText(payload, { rows: results.length }) }
  }

  /** @param {string} key @param {any[]|null} [groups] already-built groups, when listing many records */
  groupDisplay(key, groups = null) {
    const group = (groups || this.groups()).find((entry) => entry.key === key)
    if (!group) return null
    return {
      key: group.key,
      label: group.label,
      intelligence: {
        aa: Number(group.intelligence?.toFixed?.(2) ?? group.intelligence),
        band: group.intelligenceBand,
      },
      speed: group.speedBand
        ? {
            band: group.speedBand,
            rate: Number(group.speed?.toFixed?.(2) ?? group.speed),
            ttft: group.ttft,
          }
        : null,
      usage: {
        band: group.usage,
        reason: group.usageReason,
        tag: usageTagLabel(group.usage),
      },
      context: group.context,
      tools: group.tools,
      in_use: group.inUse,
    }
  }

  // ── spawn ───────────────────────────────────────────────────────────────────────────

  /** @param {any} principal @param {any} params */
  async spawn(principal, params) {
    if (this.disposed) throw new Error('The subagent manager has been disposed.')
    if (isUiPrincipal(principal))
      throw new Error('The UI cannot spawn agents; only a parent console can.')
    if (principal?.parent !== true && principal?.grants?.spawn !== true)
      throw new Error('This principal is not allowed to spawn subagents.')
    const request = normalizeSpawnRequest({
      principal,
      params,
      workspace: this.workspace,
      maxDepth: this.maxDepth,
      limits: this.limits,
    })
    request.fallback =
      params?.fallback === 'strict' || params?.fallback === 'none' ? params.fallback : 'nearest'

    // A transport failure can lose the response after the server has already created the
    // child. A tool call id is stable across the client's retry, so treating it as an
    // idempotency key turns that ambiguous failure into the same receipt instead of a
    // duplicate-child collision.
    // Never fall back to main here: a nested child whose own session is not known yet
    // belongs to no file, not to the root console's current conversation.
    const parentSessionFile = this.principalSessionFile(principal) || principal?.sessionFile || null
    const requestId =
      typeof params?.request_id === 'string' ? params.request_id.trim().slice(0, 200) : ''
    if (requestId) {
      const existing = this.registry
        .forRoot(this.rootId)
        .find(
          (record) =>
            record.requestId === requestId && record.parent?.sessionFile === parentSessionFile,
        )
      if (existing) return this.spawnReceipt(existing)
    }

    // There is deliberately no live-child cap here. Child processes are supervised
    // independently, and a fixed number made a legitimate fan-out fail at the fourth child
    // with transport-level errors instead of doing the work the parent asked for. The hourly
    // spawn budget below still bounds runaway loops.
    const hourAgo = Date.now() - 60 * 60 * 1000
    const recent = this.registry
      .all()
      .filter((record) => record.status !== 'draft' && record.createdAt >= hourAgo)
    if (recent.length >= CAPS.maxSpawnsPerHour)
      throw new Error(`The router has spent its ${CAPS.maxSpawnsPerHour} spawns this hour.`)
    const sameName = parentSessionFile
      ? this.registry.findByName(request.name, this.rootId, parentSessionFile)
      : this.registry.findByName(request.name, this.rootId)
    if (sameName)
      throw new Error(
        `A subagent named "${request.name}" already exists for this root (${sameName.id}). Reuse that id or choose another name.`,
      )

    const groups = this.groups()
    // This is the same catalogue the rail's badges use; hand it to the next snapshot instead
    // of making the spawn's tree frame build the whole table again.
    this.uiGroupsCache = groups
    this.uiGroupsCachedAt = Date.now()
    const filteredGroups = groups.filter((group) => matchesCatalogueFilters(group, request.filters))
    const wantedGroup = String(request.model || '')
      .trim()
      .toLowerCase()
    if (
      groups.some((group) => group.key === wantedGroup) &&
      !filteredGroups.some((group) => group.key === wantedGroup)
    ) {
      throw new Error(
        `Model group "${request.model}" does not meet the requested usage/intelligence/speed/context filters.`,
      )
    }
    // An empty groups list is not a filter miss, and saying it was sent the parent looking
    // for a usage/intelligence mistake during provider discovery. Name the real state.
    if (groups.length === 0) {
      throw new Error(
        'No active model group yet: no route is marked up, which is what a router that is still discovering providers looks like. Retry the spawn in about a minute.',
      )
    }
    if (filteredGroups.length === 0) {
      throw new Error(
        'No active model group matches the requested usage/intelligence/speed/context filters.',
      )
    }
    const resolved = resolveSpawnGroup(filteredGroups, request.model, {
      inUseCounts: this.inUseCounts(),
    })
    if (!resolved.group)
      throw new Error(
        resolved.error ||
          'No active model groups are available. Run the router once so its model catalogue is populated.',
      )
    const parentRoute = this.parentRoute() || this.parentBridge()?.status?.()?.routedModel || null
    const usedProviders = new Set()
    for (const record of this.registry.all()) {
      if (record.status !== 'running') continue
      for (const key of record.model?.pool || []) {
        const provider = String(key).split('/')[0]
        if (provider) usedProviders.add(provider)
      }
    }
    if (parentRoute?.providerKey) usedProviders.add(parentRoute.providerKey)
    const pool = buildSubagentPool({
      groups,
      group: resolved.group,
      provider: request.provider,
      fallback: request.fallback,
      usedProviders,
    })
    if (pool.error) throw new Error(pool.error)

    const id = generateSubagentId()
    const now = Date.now()
    const warning = resolved.group.inUse
      ? `Model group ${resolved.group.key} already has ${resolved.group.inUse} live child${resolved.group.inUse === 1 ? '' : 'ren'}; they share its rate limit. Prefer another unused group.`
      : null
    const record = {
      id,
      name: request.name,
      requestId: requestId || null,
      rootId: this.rootId,
      parentId: request.parentId,
      taskId: null,
      parent: {
        consoleKey: principal?.consoleKey || this.parentKey,
        sessionFile: parentSessionFile,
        toolCallId: params?.tool_call_id || null,
      },
      task: request.task,
      instructions: request.instructions,
      tools: request.tools,
      grants: request.grants,
      depth: request.depth,
      cwd: request.cwd,
      model: {
        requested: request.model,
        tier: resolved.tier,
        groupId: resolved.group.key,
        rowKey: pool.rowKey,
        pool: pool.pool.map((entry) => entry.key),
        selectedKey: null,
        fallbacks: [],
        policy: pool.policy,
      },
      limits: request.limits,
      filters: request.filters,
      thinking: request.thinking,
      notify: request.notify,
      background: request.background,
      phase: 'starting',
      status: 'running',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      runs: [],
      usage: { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: null },
      last: { eventAt: now, tool: null, toolStartedAt: null },
      queueLength: 0,
      result: { text: null, reportPath: null, truncated: false, error: null },
      audit: [],
      notified: false,
      warning,
    }
    this.registry.insert(record)
    this.emitChange()
    try {
      await this.startRun(record, { prompt: this.taskPrompt(record) })
    } catch (err) {
      this.finish(record.id, 'failed', /** @type {Error} */ (err)?.message || String(err))
      throw err
    }
    return this.spawnReceipt(this.registry.get(record.id))
  }

  /**
   * The receipt for a spawn, including a completed report when the child was fast enough to
   * finish before the HTTP response. Foreground callers use that report directly; without it
   * a fast child rendered as "(no output)".
   * @param {any} record
   */
  spawnReceipt(record) {
    const status = minimalStatus(record)
    return {
      id: record.id,
      status,
      warning: record.warning || null,
      report:
        status?.status === 'completed' || status?.status === 'failed'
          ? reportPayload(record)
          : null,
    }
  }

  /** @param {any} record */
  taskPrompt(record) {
    return [
      'Begin the delegated task below. Your final assistant message is the report the parent receives.',
      '',
      record.task,
    ].join('\n')
  }

  /** @param {any} record */
  resumePrompt(record) {
    return [
      'Resume the delegated task. You have run before on this session; continue from the work already present and finish with a concise report to the parent.',
      '',
      record.task,
    ].join('\n')
  }

  /** @param {any} record @param {{ prompt?: string, resume?: boolean }} [options] */
  async startRun(record, { prompt = '', resume = false } = {}) {
    const previous = resume ? record.runs.at(-1)?.sessionFile || null : null
    const runNumber = (record.runs.at(-1)?.number || 0) + 1
    const consoleKey = record.runs.at(-1)?.consoleKey || `sub-${record.id.slice(3)}`
    const run = {
      number: runNumber,
      sessionFile: previous,
      consoleKey,
      keeperSocket: supervisorSocketPath(this.agentRoot, consoleKey),
    }
    record.runs.push(run)
    record.status = 'running'
    record.phase = 'starting'
    record.endedAt = null
    record.result = { text: null, reportPath: null, truncated: false, error: null }
    record.notified = false
    record.wrapUpSent = false
    // A resume is a new process with a new budget window; the logical record keeps its id and
    // runs, but the old run's clock must not spend the new run's allowance before it starts.
    record.startedAt = Date.now()
    // The clock starts before the bridge is created: launching Pi can take tens of seconds
    // when the app is busy, and a 3-second wall-clock limit must not wait for that launch
    // before it begins counting. The timer works without a bridge and closes the record; the
    // guards after bridge creation keep a stopped record from launching a live child.
    this.startBudgetTimer(record.id)
    record.last = { eventAt: Date.now(), tool: null, toolStartedAt: null }
    record.queueLength = 0
    record.continuations = 0
    record.consecutiveToolFailures = 0
    record.toolFailureNudgeSent = false
    record.recoveries = {}
    record.streamChars = 0
    // A resume is a new run with its own turn allowance. Tokens are re-read from the new
    // bridge as soon as it reports, so keeping the previous run's counts here only makes
    // the old budget abort the new process before its first answer.
    record.usage = {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: null,
    }
    this.lastAssistant.set(record.id, '')
    this.lastAssistantMessage.delete(record.id)
    clearTimeout(this.finishTimers.get(record.id))
    this.finishTimers.delete(record.id)
    this.persistSoon()
    this.emitChange()

    const agentDir = join(this.agentRoot, 'subagents', record.id, 'agent')
    mkdirSync(agentDir, { recursive: true })
    materializeWebExtension(agentDir)
    const childSessions = join(this.sessionsRoot, 'subagents')
    mkdirSync(childSessions, { recursive: true })
    const settings = {
      ...this.settings,
      sessions: childSessions,
      workspace: record.cwd || this.workspace,
      thinking: record.thinking || this.settings.thinking || null,
      extraArgs: Array.isArray(this.settings.extraArgs) ? [...this.settings.extraArgs] : [],
    }
    const capabilityTool =
      record.grants.transcripts || record.grants.message || record.grants.spawn ? ['subagent'] : []
    const childTools = [...new Set([...record.tools, ...capabilityTool])]
    if (childTools.length > 0) settings.extraArgs.push('--tools', childTools.join(','))
    else settings.extraArgs.push('--no-tools')
    if (capabilityTool.length > 0) materializeSubagentExtension(agentDir)
    // Every child gets the generic charter, not only capability and web children. It is
    // where a plain read-only child learns its depth, that its final message is the report,
    // and that it must not claim tools or nested spawns it was not granted.
    writeChildCharter(
      agentDir,
      childCharter({
        instructions: record.instructions,
        cwd: record.cwd,
        tools: record.tools,
        grants: record.grants,
        depth: record.depth,
        maxDepth: this.maxDepth,
      }),
    )
    const plan = planPiLaunch(settings, {
      baseUrl: this.baseUrl,
      agentDir,
      consoleKey,
    })
    if (plan.error) throw new Error(plan.error)
    if (!plan.routed) throw new Error('Subagents require the console to be routed through Hammer.')
    // Pi starts a *new* session when it is only given `--session-dir`. A resume used to rely
    // on the previous child process still being held by its keeper, so its history came back
    // by accident; once that process was gone (a router restart, the keeper's idle reaper, a
    // crash) the child was restarted with no context and its next turn was written to a fresh
    // file while `runs` still named the old one. Name the child's own session explicitly.
    const resumeSession = resume && previous && existsSync(previous) ? previous : null
    const launch = resumeSession
      ? { ...plan, args: [...plan.args, '--session', resumeSession] }
      : plan

    const token = this.childToken(record, run)
    const env = {
      ...plan.env,
      HAMMER_SUBAGENT_API: this.apiBase,
      HAMMER_SUBAGENT_TOKEN: token,
      HAMMER_SUBAGENT_ID: record.id,
    }
    const supervisor = this.supervisorFor(plan, consoleKey)
    let bridge
    if (this.createBridge) {
      bridge = await this.createBridge({
        record,
        run,
        plan: launch,
        env,
        supervisor,
        agentDir,
      })
    } else {
      bridge = new PiBridge({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env,
        notes: plan.notes,
        launchError: plan.error,
        supervisor,
        compactionReserveTokens: this.settings.compaction?.reserveTokens ?? null,
      })
    }
    bridge.subagentId = record.id
    bridge.consoleKey = consoleKey
    bridge.subagentInfo = () => this.childInfo(record.id)
    this.bridges.set(record.id, bridge)
    if (this.attachConsole) {
      const console = this.attachConsole(consoleKey, bridge)
      if (console) this.childConsoles.set(record.id, console)
    }
    this.wireBridge(record.id, bridge)
    try {
      if (record.status !== 'running') {
        bridge.dispose?.()
        return
      }
      await bridge.start()
      if (record.status !== 'running') {
        bridge.dispose?.()
        return
      }
      if (prompt) await bridge.prompt(prompt, { timeoutMs: CHILD_PROMPT_ACK_MS })
      const status = bridge.status?.()
      if (status?.sessionFile) {
        run.sessionFile = status.sessionFile
        this.persistSoon()
      }
    } catch (err) {
      this.finish(record.id, 'failed', /** @type {Error} */ (err)?.message || String(err))
      throw err
    }
  }

  /**
   * The identity a child console shows. Both the spawned and the reattached bridge publish
   * this shape: a restored child used to report a bare status, so opening its console after a
   * router restart showed no brief, grants or session file.
   * @param {string} id
   */
  childInfo(id) {
    const current = this.registry.get(id)
    if (!current) return null
    return {
      ...minimalStatus(current),
      task: current.task || '',
      instructions: current.instructions || '',
      grants: current.grants || {},
      cwd: current.cwd || null,
      runs: (current.runs || []).map((entry) => ({
        number: entry.number,
        sessionFile: entry.sessionFile,
      })),
    }
  }

  /** @param {any} record @param {any} run */
  childToken(record, run) {
    const existing = this.tokens.find('child', record.id)
    return this.tokens.issue(
      {
        type: 'child',
        requesterId: record.id,
        parent: false,
        parentId: record.parentId,
        rootId: record.rootId,
        depth: record.depth,
        consoleKey: run.consoleKey,
        tools: record.tools,
        grants: record.grants,
      },
      existing,
    )
  }

  /** @param {any} plan @param {string} consoleKey */
  supervisorFor(plan, consoleKey) {
    if (process.env.HAMMER_PI_SUPERVISOR === '0') return null
    if (!this.agentRoot) return null
    try {
      if (!this.supervisor) {
        this.supervisor = {
          script: materializeSupervisor(supervisorScriptPath(this.agentRoot)),
          node: plan.node || process.execPath,
        }
      }
      return {
        ...this.supervisor,
        env: plan.env,
        socket: supervisorSocketPath(this.agentRoot, consoleKey),
        idleMs: Number(process.env.HAMMER_PI_SUPERVISOR_IDLE_MS) || undefined,
      }
    } catch {
      return null
    }
  }

  // ── child events and lifecycle ─────────────────────────────────────────────────────

  /** @param {string} id @param {PiBridge} bridge */
  wireBridge(id, bridge) {
    bridge.on('event', (record) => this.onChildEvent(id, record))
    bridge.on('status', (status) => this.onChildStatus(id, status))
    // The bridge accounts for every assistant message as it arrives, including a turn that
    // is aborted before the next status poll. Without this listener a fast child can finish
    // with real usage in its session and still show 0 tokens in the registry.
    bridge.on('usage', (usage) => this.onChildUsage(id, usage))
    bridge.on('exit', (info) => {
      const record = this.registry.get(id)
      if (!record || record.status !== 'running') return
      if (info?.signal === 'SIGTERM' && bridge.disposed) return
      // A process that dies mid-run never settles, so nothing else closes its record and the
      // parent waits on it until the twenty-minute budget. Give a settle that is already in
      // flight a moment to land, then write the failure.
      const timer = setTimeout(() => {
        const current = this.registry.get(id)
        if (!current || current.status !== 'running' || this.bridges.get(id) !== bridge) return
        this.finish(id, 'failed', 'The child process exited without a final report.')
      }, 1_500)
      timer.unref?.()
      this.persistSoon()
    })
  }

  /** @param {string} id @param {any} event */
  onChildEvent(id, event) {
    const record = this.registry.get(id)
    if (!record || record.status !== 'running' || !event || typeof event !== 'object') return
    const now = Date.now()
    record.last = record.last || { eventAt: now }
    record.last.eventAt = now
    if (event.type === 'agent_start') {
      // A turn is not spent when it starts: a `max_turns: 1` child used to be counted here,
      // so the budget timer aborted its first request before the model could answer.
      record.last.turnStartedAt = now
      record.last.turnSawOutput = false
      record.streamChars = 0
      record.phase = 'busy'
    } else if (event.type === 'message_start') {
      if (event.message?.role === 'assistant') record.streamChars = 0
    } else if (event.type === 'message_update') {
      record.last.turnSawOutput = true
      record.streamChars = (Number(record.streamChars) || 0) + streamedDeltaLength(event)
      // The budget timer only ticks every five seconds, which is longer than a child takes
      // to finish one long answer. Check the streamed estimate now so a token budget stops
      // the turn instead of being discovered after it has already settled completed.
      if (this.enforceBudget(record)) return
    } else if (event.type === 'agent_end') {
      record.usage.turns = (Number(record.usage.turns) || 0) + 1
      record.last.turnEndedAt = now
    } else if (event.type === 'tool_execution_start') {
      record.last.tool = event.toolName || 'tool'
      record.last.toolStartedAt = now
      record.last.sawTool = true
      record.last.turnSawOutput = true
      record.phase = 'busy'
    } else if (event.type === 'tool_execution_end') {
      record.last.tool = null
      record.last.toolStartedAt = null
      // A rate-limited search makes a child fetch the same pages over and over: one live child
      // spent twenty calls inside a single turn after the search backend started answering
      // 429. Four failures in a row is not exploration, it is a loop, and the turn has to end
      // with a report that says what could not be checked.
      const outcome = textOfContent(event.result) || textOfContent(event.partialResult)
      record.consecutiveToolFailures = TOOL_FAILURE_RE.test(outcome.slice(0, 400))
        ? (Number(record.consecutiveToolFailures) || 0) + 1
        : 0
      if (record.consecutiveToolFailures >= TOOL_FAILURE_NUDGE_AT && !record.toolFailureNudgeSent) {
        record.toolFailureNudgeSent = true
        void this.bridges
          .get(id)
          ?.prompt(TOOL_FAILURE_NUDGE_MESSAGE, { queueMode: 'followUp' })
          .catch(() => {})
        this.registry.audit(record, 'tool_failure_nudge', {
          failures: record.consecutiveToolFailures,
        })
      }
    } else if (event.type === 'compaction_start') {
      record.phase = 'compacting'
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      record.last.turnSawOutput = true
      const text = assistantText(event)
      const failure = assistantErrorMessage(event.message)
      if (failure) {
        // The failed turn has no report. Keeping an earlier turn's text would make the
        // failure look like a successful answer.
        record.last.error = failure
        this.lastAssistant.set(id, '')
      } else {
        delete record.last.error
        // The report is the answer, not the reasoning a relay left in front of it.
        const answer = stripReasoning(text)
        if (answer) this.lastAssistant.set(id, answer)
      }
      record.streamChars = 0
      record.last.continuationExhausted = false
      this.lastAssistantMessage.set(id, event.message)
    } else if (event.type === 'agent_settled') {
      if (this.enforceBudget(record)) return
      const bridge = this.bridges.get(id)
      const status = bridge?.status?.()
      if (status?.isStreaming || status?.isCompacting || Number(status?.pendingMessages) > 0) return
      // Pi settles between turns. A continuation the bridge has already scheduled is another
      // turn, so completing the record here would orphan the nudge and freeze its result.
      if (bridge?.willContinue?.()) {
        this.deferFinish(id)
        return
      }
      if (record.last?.error && this.maybeRecoverFailedTurn(record, bridge)) return
      if (record.last?.error) {
        this.finish(id, 'failed', record.last.error)
        return
      }
      if (this.maybeContinueChild(record, bridge)) return
      const finalText = this.lastAssistant.get(id) || ''
      if (!finalText) {
        this.finish(id, 'failed', 'The child finished without a final report.')
        return
      }
      if (isPayloadOnly(finalText)) {
        this.finish(
          id,
          'failed',
          `The child answered with tool-call JSON instead of a report after ${CHILD_CONTINUATION_LIMIT} continuation prompts. Its route is probably serializing calls into the message text; retry the spawn, or choose another model group.`,
        )
        return
      }
      this.finish(
        id,
        'completed',
        record.last?.continuationExhausted
          ? Number(record.usage?.turns) >= Number(record.limits?.maxTurns)
            ? 'The child stopped without a final report after reaching its turn budget.'
            : `The child stopped without a final report after ${CHILD_CONTINUATION_LIMIT} continuation prompts.`
          : null,
      )
      return
    }
    this.persistSoon()
    this.emitChangeSoon()
  }

  /** @param {string} id @param {any} usage */
  onChildUsage(id, usage) {
    const record = this.registry.get(id)
    if (!record || record.status !== 'running' || !usage) return
    const previousTotal = Number(record.usage?.totalTokens) || 0
    const nextTotal = Number(usage.totalTokens) || 0
    record.usage = {
      ...record.usage,
      turns: Number(record.usage?.turns) || 0,
      inputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      totalTokens: nextTotal,
      cost: finite(usage.cost),
    }
    // A growing measured total means a message ended. Its usage already includes the text
    // this record counted while it streamed; keeping both would charge that text twice and
    // stop a child that is still inside its budget. A context-only estimate re-emits the same
    // total and must not clear the live estimate.
    if (nextTotal > previousTotal) record.streamChars = 0
    // Measured usage arrives at `message_end`, immediately before the child settles. The
    // five-second timer would lose that race and write completed over an over-budget turn.
    if (this.enforceBudget(record)) return
    this.persistSoon()
    this.emitChangeSoon()
  }

  /** @param {string} id @param {any} status */
  onChildStatus(id, status) {
    const record = this.registry.get(id)
    if (!record || record.status !== 'running' || !status) return
    const now = Date.now()
    record.last = record.last || { eventAt: now }
    record.usage = {
      ...record.usage,
      turns: Number(record.usage?.turns) || 0,
      inputTokens: Number(status.usage?.inputTokens) || 0,
      outputTokens: Number(status.usage?.outputTokens) || 0,
      totalTokens: Number(status.usage?.totalTokens) || 0,
      cost: finite(status.usage?.cost),
    }
    if (this.enforceBudget(record)) return
    record.queueLength =
      (Array.isArray(status.queuedSteering) ? status.queuedSteering.length : 0) +
      (Array.isArray(status.queuedFollowUp) ? status.queuedFollowUp.length : 0)
    if (status.sessionFile) {
      const run = record.runs.at(-1)
      if (run) run.sessionFile = status.sessionFile
    }
    if (status.phase === 'error') record.last.error = status.error || record.last.error || null
    if (status.isCompacting) record.phase = 'compacting'
    else if (status.isStreaming) record.phase = 'busy'
    else if (record.phase !== 'starting') record.phase = 'idle'
    this.persistSoon()
  }

  /**
   * Turns a failed turn back into work when the failure was a slip or a dropped connection
   * rather than a task that cannot be done. Two attempts at most: the first asks for the same
   * work again, the second asks for a report from what the child already has. A third failure is
   * a real failure and the parent hears the error.
   * @param {any} record @param {PiBridge|undefined} bridge
   * @returns {boolean} whether a retry was started
   */
  maybeRecoverFailedTurn(record, bridge) {
    const error = String(record.last?.error || '')
    if (!error) return false
    if (!bridge || typeof bridge.prompt !== 'function' || record.status !== 'running') return false
    const malformed = TOOL_ARGUMENT_ERROR_RE.test(error)
    if (!malformed && !RECOVERABLE_TURN_ERROR_RE.test(error)) return false
    const used = Number(record.recoveries?.turn) || 0
    if (used >= 2) return false
    const message =
      used === 0
        ? malformed
          ? MALFORMED_ARGUMENTS_MESSAGE
          : ABORTED_TURN_MESSAGE
        : STOP_TOOLS_MESSAGE
    record.recoveries = { ...(record.recoveries || {}), turn: used + 1 }
    delete record.last.error
    this.registry.audit(record, 'recover_failed_turn', {
      attempt: used + 1,
      kind: malformed ? 'malformed_arguments' : 'transport',
      error: error.slice(0, 300),
    })
    void bridge.prompt(message, { queueMode: 'followUp' }).catch((err) => {
      const current = this.registry.get(record.id)
      if (!current || current.status !== 'running') return
      this.finish(
        record.id,
        'failed',
        `The child could not be retried after a failed turn: ${/** @type {Error} */ (err)?.message || err}`,
      )
    })
    return true
  }

  /**
   * A child can stop with a planning sentence instead of its report. Models that put a native
   * tool call into the text are the common case: Pi sees no call, so it settles and the parent
   * receives the plan as if it were the answer. Ask the child to carry on once, then ask for
   * the report directly; both turns stay on the same session and the same process.
   * @param {any} record @param {PiBridge|undefined} bridge
   * @returns {boolean} whether a continuation was started
   */
  maybeContinueChild(record, bridge) {
    if (!bridge || typeof bridge.prompt !== 'function' || record.status !== 'running') return false
    const message = this.lastAssistantMessage.get(record.id)
    if (!message || message.role !== 'assistant') return false
    if (message.stopReason && message.stopReason !== 'stop') return false
    const content = Array.isArray(message.content) ? message.content : []
    if (content.some((part) => part && part.type === 'toolCall')) return false
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false
    // Whether an earlier tool ran is irrelevant, and requiring it hid the worst case: a child
    // that answered with its plan and never took a single tool call was marked completed with
    // the plan as its report. One research child's report was "Let me start researching."
    const text = this.lastAssistant.get(record.id) || textOfContent(message.content).trim()
    if (!text) return false
    // Call payload with no prose is the same stall in another spelling: the child was still
    // trying to call a tool when the turn ended.
    if (!endsOnAnnouncement(text) && !isPayloadOnly(text)) return false
    const used = Number(record.continuations) || 0
    if (
      used >= CHILD_CONTINUATION_LIMIT ||
      Number(record.usage?.turns) >= Number(record.limits?.maxTurns)
    ) {
      record.last.continuationExhausted = true
      return false
    }
    record.continuations = used + 1
    const prompt = used === 0 ? CHILD_CONTINUE_MESSAGE : CHILD_WRAPUP_MESSAGE
    this.registry.audit(record, 'continue_child', { attempt: record.continuations })
    void bridge.prompt(prompt, { queueMode: 'followUp' }).catch((err) => {
      const current = this.registry.get(record.id)
      if (!current || current.status !== 'running') return
      this.finish(
        record.id,
        'failed',
        `The child could not be continued: ${/** @type {Error} */ (err)?.message || err}`,
      )
    })
    return true
  }

  /**
   * Waits out a continuation the bridge has armed. If its prompt never starts, the bridge has
   * nowhere else to report that, so this retry is the only thing that stops the record from
   * staying "running" forever after the agent is already idle.
   * @param {string} id
   */
  deferFinish(id) {
    clearTimeout(this.finishTimers.get(id))
    const timer = setTimeout(() => {
      this.finishTimers.delete(id)
      const record = this.registry.get(id)
      if (!record || record.status !== 'running') return
      const bridge = this.bridges.get(id)
      const status = bridge?.status?.()
      if (
        bridge?.willContinue?.() ||
        status?.isStreaming ||
        status?.isCompacting ||
        Number(status?.pendingMessages) > 0
      ) {
        this.deferFinish(id)
        return
      }
      if (record.last?.error) {
        this.finish(id, 'failed', record.last.error)
        return
      }
      if (!(this.lastAssistant.get(id) || '')) {
        this.finish(id, 'failed', 'The child finished without a final report.')
        return
      }
      this.finish(id, 'completed', null)
    }, 2_000)
    timer.unref?.()
    this.finishTimers.set(id, timer)
  }

  /** @param {string} id @param {'completed'|'failed'|'stopped'} status @param {string|null} error */
  finish(id, status, error) {
    const record = this.registry.get(id)
    if (!record || record.status !== 'running') return record
    const now = Date.now()
    let text = this.lastAssistant.get(id) || ''
    if (!text) {
      const entry = record.result?.text
      text = typeof entry === 'string' ? entry : ''
    }
    const cap = CAPS.maxReportChars
    let reportPath = null
    let truncated = false
    if (text.length > cap) {
      try {
        reportPath = subagentReportPath(this.agentRoot, record.id)
        mkdirSync(join(this.agentRoot, 'subagents', record.id), { recursive: true })
        writeFileSync(reportPath, `${text}\n`, { mode: 0o600 })
        text = text.slice(0, cap)
        truncated = true
      } catch {
        text = text.slice(0, cap)
        truncated = true
      }
    }
    record.status = status
    record.phase = 'done'
    record.endedAt = now
    record.queueLength = 0
    record.last = { ...(record.last || {}), eventAt: now }
    record.result = {
      text: text || null,
      reportPath,
      truncated,
      error: error || record.last?.error || null,
    }
    clearInterval(this.timers.get(id))
    this.timers.delete(id)
    clearTimeout(this.finishTimers.get(id))
    this.finishTimers.delete(id)
    this.persistSoon()
    this.emitChange()
    if (record.background && record.notify !== 'silent') void this.notifyParent(record)
    return record
  }

  /** @param {any} record */
  async notifyParent(record) {
    if (record.notified) return
    const current = this.registry.get(record.id)
    if (!current || current.notified) return
    const text = xmlReport(current)
    // A nested child reports to the subagent that spawned it, not to the root chooser. When
    // that parent is still live, prompt it directly; if it has gone, fall back to the root
    // so the report is not lost.
    const immediateParent = record.parentId ? this.registry.get(record.parentId) : null
    const immediateBridge = immediateParent ? this.bridges.get(immediateParent.id) : null
    if (immediateParent && immediateBridge && immediateParent.status === 'running') {
      try {
        const status = /** @type {any} */ (immediateBridge.status?.()) || {}
        const busy = status.isStreaming || status.isCompacting
        await immediateBridge.prompt(text, busy ? { queueMode: 'followUp' } : undefined)
        this.registry.update(record.id, { notified: true })
        this.registry.audit(this.registry.get(record.id), 'notify_parent', {
          bytes: Buffer.byteLength(text),
          queued: Boolean(busy),
          target: immediateParent.id,
        })
        return
      } catch {
        // The parent may have finished while the notification was in flight. The root
        // fallback below keeps the report in the conversation's notice queue.
      }
    }
    const parent = this.parentBridgeFor(record.parent?.consoleKey)
    if (!parent) {
      this.registry.addNotice(this.rootId, text, record.parent?.sessionFile || null)
      this.registry.update(record.id, { notified: true })
      return
    }
    try {
      const sessionFile = this.parentSessionFileFor(record.parent?.consoleKey)
      if (record.parent?.sessionFile && record.parent.sessionFile !== sessionFile) {
        // The user has moved this console to another conversation. The report belongs to the
        // conversation that asked for it, not the one on screen; it is delivered on return.
        this.registry.addNotice(this.rootId, text, record.parent.sessionFile)
        this.registry.update(record.id, { notified: true })
        return
      }
      const status = parent.status?.() || {}
      const busy = status.isStreaming || status.isCompacting
      await parent.prompt(text, busy ? { queueMode: 'followUp' } : undefined)
      this.registry.update(record.id, { notified: true })
      this.registry.audit(this.registry.get(record.id), 'notify_parent', {
        bytes: Buffer.byteLength(text),
        queued: Boolean(busy),
      })
    } catch {
      this.registry.addNotice(this.rootId, text, record.parent?.sessionFile || null)
      this.registry.update(record.id, { notified: true })
    }
  }

  /**
   * Registers one parent console. The main and every parallel console get their own bridge
   * and token, so a spawn can name the conversation that actually asked for the child.
   * @param {string} consoleKey @param {PiBridge} bridge
   */
  attachParentBridge(consoleKey, bridge) {
    const key = String(consoleKey || this.parentKey)
    if (!bridge) return null
    this.parentBridges.set(key, bridge)
    if (key === this.parentKey) this.parentBridgeRef = bridge
    const previous = this.parentStatusHandlers.get(key)
    if (previous?.bridge === bridge) return bridge
    if (previous) previous.bridge.off?.('status', previous.handler)
    const handler = (status) => {
      if (!status?.sessionFile) return
      if (!this.syncParentSessionFiles()) return
      this.emitChange()
    }
    if (typeof bridge.on === 'function') {
      bridge.on('status', handler)
      this.parentStatusHandlers.set(key, { bridge, handler })
    }
    if (this.syncParentSessionFiles()) this.emitChange()
    return bridge
  }

  /** @param {string} consoleKey @param {PiBridge} [bridge] */
  detachParentBridge(consoleKey, bridge) {
    const key = String(consoleKey || this.parentKey)
    if (bridge && this.parentBridges.get(key) !== bridge) return
    const previous = this.parentStatusHandlers.get(key)
    if (previous) previous.bridge.off?.('status', previous.handler)
    this.parentStatusHandlers.delete(key)
    this.parentBridges.delete(key)
    if (key === this.parentKey) this.parentBridgeRef = null
    // An instance key is never reused. Its parent token would otherwise sit in the token
    // store forever after the parallel console it belonged to has closed.
    if (key !== this.parentKey) this.tokens.revoke(this.tokens.parentToken(key))
  }

  /** @param {PiBridge} bridge */
  attachParent(bridge) {
    this.attachParentBridge(this.parentKey, bridge)
    this.deliverNotices()
  }

  async deliverNotices() {
    const bridges = new Map(this.parentBridges)
    if (this.parentBridgeRef && ![...bridges.values()].includes(this.parentBridgeRef)) {
      bridges.set(this.parentKey, this.parentBridgeRef)
    }
    const delivered = new Set()
    for (const parent of bridges.values()) {
      let sessionFile
      try {
        sessionFile = parent.status?.()?.sessionFile || null
      } catch {
        continue
      }
      if (!sessionFile || delivered.has(sessionFile)) continue
      delivered.add(sessionFile)
      for (const notice of this.registry.takeNotices(this.rootId, sessionFile)) {
        try {
          const status = /** @type {any} */ (parent.status?.()) || {}
          await parent.prompt(
            notice.text,
            status.isStreaming ? { queueMode: 'followUp' } : undefined,
          )
        } catch {
          this.registry.addNotice(this.rootId, notice.text, sessionFile)
        }
      }
    }
  }

  /**
   * Whether this child has spent its wall-clock or token budget, and if so close it before a
   * later settle can call it completed. The token figure includes the streamed text estimate
   * so a long answer is interrupted inside the budget rather than after `message_end`.
   * @param {any} record
   * @returns {boolean} whether the record was stopped
   */
  enforceBudget(record) {
    if (!record || record.status !== 'running') return false
    const now = Date.now()
    const elapsed = now - (Number(record.startedAt) || now)
    const measuredTokens = Number(record.usage?.totalTokens) || 0
    const streamedTokens = Math.ceil((Number(record.streamChars) || 0) / 4)
    const tokens = measuredTokens + streamedTokens
    const timeBudget = Math.max(1, Number(record.limits?.timeoutMs) || 1)
    const tokenBudget = Math.max(1, Number(record.limits?.tokenBudget) || 1)
    const timeExpired = elapsed >= timeBudget
    const tokenExpired = tokens >= tokenBudget
    if (!timeExpired && !tokenExpired) return false
    const detail = [
      timeExpired ? `time ${Math.round(elapsed / 1000)}s/${Math.round(timeBudget / 1000)}s` : '',
      tokenExpired ? `tokens ${tokens}/${tokenBudget}` : '',
    ]
      .filter(Boolean)
      .join(', ')
    // A budget-stopped parent is still going away; its descendants must not remain live.
    this.stopDescendants(record.id)
    this.finish(record.id, 'stopped', `The child reached its time or token budget (${detail}).`)
    void this.bridges
      .get(record.id)
      ?.abort()
      .catch(() => {})
    return true
  }

  startBudgetTimer(id) {
    clearInterval(this.timers.get(id))
    const timer = setInterval(() => {
      const record = this.registry.get(id)
      if (!record || record.status !== 'running') {
        clearInterval(timer)
        this.timers.delete(id)
        return
      }
      const elapsed = Date.now() - (Number(record.startedAt) || Date.now())
      const tokens =
        (Number(record.usage?.totalTokens) || 0) + Math.ceil((Number(record.streamChars) || 0) / 4)
      const timeRatio = elapsed / Math.max(1, record.limits.timeoutMs)
      const tokenRatio = tokens / Math.max(1, record.limits.tokenBudget)
      const ratio = Math.max(timeRatio, tokenRatio)
      const bridge = this.bridges.get(id)
      const status = bridge?.status?.()
      const busy = Boolean(
        status?.isStreaming ||
        status?.isCompacting ||
        Number(status?.pendingMessages) > 0 ||
        bridge?.willContinue?.(),
      )
      if (ratio >= 0.8 && busy && !record.wrapUpSent) {
        record.wrapUpSent = true
        void bridge
          ?.prompt(
            'Budget notice: you are near your time or token budget. Wrap up, make no new tool calls, and return a concise report now.',
            { queueMode: 'followUp' },
          )
          .catch(() => {})
      }
      // Turn limits belong to `agent_settled`, not to a wall-clock tick: aborting here is
      // what cut off the one turn a `max_turns: 1` child was allowed to take. A wall-clock
      // limit still has to fire while the child waits for its first `agent_start`; the
      // shared check handles that without requiring observed usage first.
      const now = Date.now()
      const turnStartedAt = Number(record.last?.turnStartedAt) || 0
      const turnEndedAt = Number(record.last?.turnEndedAt) || 0
      if (
        turnStartedAt > turnEndedAt &&
        !record.last?.turnSawOutput &&
        now - turnStartedAt >= CHILD_FIRST_OUTPUT_MS &&
        !status?.isCompacting
      ) {
        // Six children once sat "running" for thirteen minutes with zero tokens on a route
        // that never answered. A silent turn is the one state a parent cannot diagnose, so
        // it is failed with the route named rather than waited out to the budget.
        this.stopDescendants(record.id)
        this.finish(
          record.id,
          'failed',
          `The child's model call produced nothing for ${Math.round((now - turnStartedAt) / 1000)}s on ${record.model?.selectedKey || record.model?.rowKey || 'its route'}. Retry the spawn, or choose another model group.`,
        )
        void bridge?.abort?.().catch(() => {})
        return
      }
      this.enforceBudget(record)
    }, BUDGET_TICK_MS)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  // ── reads and controls ─────────────────────────────────────────────────────────────

  /** @param {string} target @param {any} principal */
  resolveTarget(target, principal) {
    if (target === 'parent') {
      if (!principal || Number(principal.depth) <= 0)
        throw new Error('Only a child can address the parent chooser.')
      return { parent: true, id: 'parent', rootId: principal.rootId }
    }
    const sessionFile = this.principalSessionFile(principal)
    const record =
      this.registry.get(String(target || '')) ||
      this.registry.findByName(
        String(target || ''),
        principal?.rootId || '',
        sessionFile === null ? undefined : sessionFile,
      )
    if (!record) throw new Error(`No subagent "${target}" in this root.`)
    if (!isUiPrincipal(principal) && !sameRoot(principal, record))
      throw new Error('That subagent belongs to another root.')
    if (!this.inPrincipalSession(principal, record))
      throw new Error('That subagent belongs to another conversation.')
    return record
  }

  /** @param {any} principal @param {string} target @param {{ includeReport?: boolean, ui?: boolean }} [options] */
  status(principal, target, { includeReport = false, ui = false } = {}) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) {
      const status = this.parentBridge()?.status?.() || {}
      return {
        subagent: {
          id: 'parent',
          name: 'parent',
          parentId: null,
          phase: status.isStreaming ? 'busy' : 'idle',
          status: 'running',
          model: { group: status.routedModel?.modelId || null, selected: null },
          elapsedMs: 0,
          tokens: status.usage?.totalTokens || 0,
        },
      }
    }
    const readable =
      canReadRecord(principal, record, this.registry.records) ||
      canMessageRecord(principal, record, this.registry.records)
    if (!readable) throw new Error('This principal cannot read that subagent.')
    const base = minimalStatus(record)
    if (ui && principal?.ui) {
      base.task = record.task
      base.instructions = record.instructions
      base.grants = record.grants
      base.cwd = record.cwd
      base.display = this.groupDisplay(record.model?.groupId || '')
      base.audit = Array.isArray(record.audit) ? record.audit.slice(-40) : []
      base.runs = (record.runs || []).map((run) => ({
        number: run.number,
        sessionFile: run.sessionFile,
        consoleKey: run.consoleKey,
      }))
    }
    if (includeReport) {
      if (!canReadRecord(principal, record, this.registry.records))
        throw new Error(
          'Only an ancestor or a child with the transcripts grant may read this report.',
        )
      return { subagent: base, report: reportPayload(record) }
    }
    return { subagent: base }
  }

  /** @param {any} principal */
  list(principal) {
    if (isUiPrincipal(principal)) this.syncParentSessionFiles()
    const records = isUiPrincipal(principal)
      ? this.registry.all()
      : this.registry
          .all()
          .filter(
            (record) => sameRoot(principal, record) && this.inPrincipalSession(principal, record),
          )
    if (
      !isUiPrincipal(principal) &&
      principal?.parent !== true &&
      !principal?.grants?.transcripts &&
      !principal?.grants?.message &&
      !principal?.grants?.spawn
    ) {
      throw new Error('This principal cannot list subagents.')
    }
    // Building the catalogue reads every provider's model table. It is the same catalogue
    // for every record in this response, so build it once rather than once per row.
    const groups = isUiPrincipal(principal) ? this.groupsForSnapshot() : null
    const list = records.map((record) => {
      const base = minimalStatus(record)
      // The parent's `list` action is the minimal view: task text, cwd and the audit trail
      // belong to the UI's separately scoped token, not to a model-facing payload.
      if (isUiPrincipal(principal)) {
        base.task = record.task
        // A child belongs to the conversation that spawned it, not to the console's current
        // session: the rail nests the tree under that session's row.
        base.parentSessionFile = this.parentSessionFileForRecord(record)
        base.parentConsoleKey = record.parent?.consoleKey || null
        base.display = groups ? this.groupDisplay(record.model?.groupId || '', groups) : null
        base.cwd = record.cwd
        base.background = record.background
        base.warning = record.warning || null
        base.audit = Array.isArray(record.audit) ? record.audit.slice(-20) : []
        // `minimalStatus` carries the run count; the UI needs the run rows so opening a
        // finished child can name its session file. Keep both payloads identical.
        base.runs = (record.runs || []).map((run) => ({
          number: run.number,
          sessionFile: run.sessionFile,
          consoleKey: run.consoleKey,
        }))
      }
      return base
    })
    return { subagents: list }
  }

  /** Records for the page's tree. This is a UI payload, so display metadata is allowed. */
  uiRecords() {
    this.syncParentSessionFiles()
    // `groupDisplay()` otherwise builds the entire provider/model catalogue itself. Calling it
    // per record made every tree snapshot O(children × models) — with a few dozen children the
    // SSE hello and each spawn frame took many seconds to paint. One catalogue per snapshot.
    const groups = this.groupsForSnapshot()
    return this.registry.all().map((record) => ({
      ...minimalStatus(record),
      task: record.task,
      parentSessionFile: this.parentSessionFileForRecord(record),
      parentConsoleKey: record.parent?.consoleKey || null,
      cwd: record.cwd,
      background: record.background,
      thinking: record.thinking || null,
      warning: record.warning || null,
      display: this.groupDisplay(record.model?.groupId || '', groups),
      audit: Array.isArray(record.audit) ? record.audit.slice(-10) : [],
      runs: (record.runs || []).map((run) => ({
        number: run.number,
        sessionFile: run.sessionFile,
      })),
    }))
  }

  /** @param {any} principal @param {string} target @param {number} limit */
  transcript(principal, target, limit = CAPS.maxTranscriptChars) {
    const record = this.resolveTarget(target, principal)
    const max = Math.max(1_000, Math.min(32_000, Number(limit) || CAPS.maxTranscriptChars))
    if (record.parent === true) {
      // The chooser is not a record, but a child with `transcripts` may still read what the
      // parent has said in this root. The bridge holds the bounded history; there is no file
      // handle on the parent's session here, and a parent reading itself is not a use case.
      if (principal?.parent === true || isUiPrincipal(principal))
        throw new Error('The parent chooser has no subagent transcript.')
      if (!principal?.grants?.transcripts)
        throw new Error('This principal may not read the parent transcript.')
      const rendered = renderTranscriptRecords(this.parentBridge()?.history?.() || [], max)
      return {
        transcript: rendered.text,
        bytes: rendered.bytes,
        truncated: rendered.truncated,
      }
    }
    if (!canReadRecord(principal, record, this.registry.records))
      throw new Error('This principal may not read that transcript.')
    if (!isUiPrincipal(principal) && principal?.parent !== true) {
      const now = Date.now()
      const rate = this.transcriptRates.get(principal.requesterId) || { at: now, count: 0 }
      if (now - rate.at > 10 * 60_000) {
        rate.at = now
        rate.count = 0
      }
      rate.count += 1
      this.transcriptRates.set(principal.requesterId, rate)
      if (rate.count > CAPS.maxTranscriptReadsPer10Min) {
        this.registry.audit(record, 'transcript_read_rejected', {
          sender: principal?.requesterId || null,
          reason: 'rate limit',
        })
        throw new Error('Transcript reads are capped at 10 per 10 minutes for a child.')
      }
    }
    let text
    let bytes = 0
    let truncated = false
    const bridge = this.bridges.get(record.id)
    if (bridge && record.status === 'running') {
      const rendered = renderTranscriptRecords(bridge.history?.() || [], max)
      text = rendered.text
      bytes = rendered.bytes
      truncated = rendered.truncated
    } else {
      const file = record.runs.at(-1)?.sessionFile
      if (file) {
        try {
          const records = readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line)
              } catch {
                return null
              }
            })
            .filter(Boolean)
          const rendered = renderTranscriptRecords(records, max)
          text = rendered.text
          bytes = rendered.bytes
          truncated = rendered.truncated
        } catch {
          text = record.result?.text || ''
        }
      } else {
        text = record.result?.text || ''
      }
    }
    this.registry.audit(record, 'transcript_read', {
      sender: principal?.requesterId || null,
      bytes: Buffer.byteLength(text),
      truncated,
    })
    return { transcript: text, bytes, truncated }
  }

  /** @param {any} principal @param {string} target @param {number} timeoutMs */
  async wait(principal, target, timeoutMs = 60_000) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true)
      throw new Error('There is nothing to wait for on the parent chooser.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('wait is a parent-only control action.')
    const deadline = Date.now() + Math.max(0, Math.min(30 * 60_000, Number(timeoutMs) || 0))
    while (record.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return this.status(principal, target, {
      includeReport: canReadRecord(principal, record, this.registry.records),
    })
  }

  /** @param {any} principal @param {string} target @param {string} message @param {string} mode */
  async send(principal, target, message, mode = 'steer') {
    const text = String(message || '').trim()
    if (!text) throw new Error('A message is required.')
    if (text.length > CAPS.maxMessageChars)
      throw new Error(`A message is capped at ${CAPS.maxMessageChars} characters.`)
    if (!['steer', 'queue'].includes(mode)) throw new Error('Unknown message mode.')
    const record = this.resolveTarget(target, principal)
    const parentTarget = record.parent === true
    if (!parentTarget && !canMessageRecord(principal, record, this.registry.records))
      throw new Error('This principal may not message that subagent.')
    if (!parentTarget && record.id === principal?.requesterId)
      throw new Error('An agent cannot message itself.')
    if (!parentTarget) {
      const now = Date.now()
      const rate = this.messageRates.get(principal.requesterId) || { at: now, count: 0 }
      if (now - rate.at > 10 * 60_000) {
        rate.at = now
        rate.count = 0
      }
      rate.count += 1
      this.messageRates.set(principal.requesterId, rate)
      if (principal?.parent !== true && rate.count > CAPS.maxMessagesPer10Min) {
        this.registry.audit(record, 'message_rejected', {
          sender: principal?.requesterId || null,
          mode,
          reason: 'rate limit',
        })
        throw new Error(
          `Messages are capped at ${CAPS.maxMessagesPer10Min} per 10 minutes for a child.`,
        )
      }
    }
    const turnNow = Date.now()
    const turnWindow = this.lastMessageTurn.get(this.rootId)
    if (!turnWindow || turnNow - turnWindow.at > 10 * 60_000) {
      this.lastMessageTurn.set(this.rootId, { at: turnNow, count: 1 })
    } else {
      turnWindow.count += 1
      if (turnWindow.count > CAPS.maxMessageTurnsPer10Min) {
        if (!parentTarget)
          this.registry.audit(this.registry.get(record.id), 'message_rejected', {
            sender: principal?.requesterId || null,
            mode,
            reason: 'root message-triggered turn cap',
          })
        throw new Error('The root has reached its message-triggered turn cap for this window.')
      }
    }
    // A message addressed to the parent belongs in the parent conversation as a steer: it
    // has to reach a running turn instead of waiting behind it. `mode` still chooses steer
    // or queue for messages to other agents.
    const deliveryMode = parentTarget ? 'steer' : mode
    const wrapped = `<agent-message from="${principal?.requesterId || 'unknown'}" mode="${deliveryMode}">\n${text}\n</agent-message>`

    if (parentTarget) {
      const parent = this.parentBridge()
      if (!parent) throw new Error('The parent chooser is not attached to a live console.')
      try {
        await parent.prompt(wrapped)
      } catch (err) {
        throw new Error(`delivery_failed: ${/** @type {Error} */ (err)?.message || err}`, {
          cause: err,
        })
      }
      return { delivered: true, target: 'parent', mode: deliveryMode }
    }

    if (record.status !== 'running') {
      if (principal?.parent !== true)
        throw new Error('delivery_failed: the target finished before delivery.')
      // Restart onto the child's session, but do not send the resume prompt first: the
      // message below is the next turn. Prompting the original task and then queueing the
      // message made a finished child do its old work again before reading the correction.
      await this.resume(principal, record.id, { prompt: '' })
    }
    const bridge = this.bridges.get(record.id)
    if (!bridge) throw new Error('delivery_failed: the target has no live bridge.')
    try {
      await bridge.prompt(wrapped, deliveryMode === 'steer' ? undefined : { queueMode: 'followUp' })
    } catch (err) {
      throw new Error(`delivery_failed: ${/** @type {Error} */ (err)?.message || err}`, {
        cause: err,
      })
    }
    this.registry.audit(this.registry.get(record.id), 'message', {
      sender: principal?.requesterId || null,
      mode: deliveryMode,
      bytes: Buffer.byteLength(text),
      result: 'delivered',
    })
    return { delivered: true, target: record.id, mode: deliveryMode }
  }

  /**
   * A turn started from a child's own console.
   *
   * The console route used to prompt the bridge directly, which the manager never saw: a
   * finished child answered again while its record kept the previous report, turn count and
   * token total, and the rail never moved. A console turn is a managed turn — reopen the
   * record on the process its keeper still holds, or restart a child whose process has gone,
   * so the ordinary event, budget and report handling applies to it.
   * @param {any} principal @param {string} target @param {string} message
   * @param {{ queueMode?: string, images?: any[] }} [options]
   */
  async promptFromConsole(principal, target, message, { queueMode = 'steer', images } = {}) {
    const text = String(message || '').trim()
    if (!text) throw new Error('A message is required.')
    if (text.length > CAPS.maxMessageChars)
      throw new Error(`A message is capped at ${CAPS.maxMessageChars} characters.`)
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('The parent chooser is not a subagent console.')
    // A child opening its own console addresses itself, which the message tool forbids;
    // the console is the one place where talking to itself is the point.
    if (
      record.id !== principal?.requesterId &&
      !canMessageRecord(principal, record, this.registry.records)
    )
      throw new Error('This principal may not message that subagent.')
    let bridge = this.bridges.get(record.id)
    if (record.status !== 'running') {
      const run = record.runs?.at(-1)
      const alive = Boolean(
        bridge && bridge.status?.()?.running === true && (await keeperAccepts(run?.keeperSocket)),
      )
      if (alive) {
        // The keeper still holds the child's process: this is another turn on the session
        // it is already on, not another launch.
        this.reopenForConsole(record)
      } else {
        await this.resume(principal, record.id, { prompt: '' })
        bridge = this.bridges.get(record.id)
      }
    }
    if (!bridge) throw new Error('delivery_failed: the target has no live bridge.')
    this.registry.audit(this.registry.get(record.id), 'message', {
      sender: principal?.requesterId || null,
      mode: queueMode,
      bytes: Buffer.byteLength(text),
      result: 'console',
    })
    await bridge.prompt(text, {
      ...(queueMode === 'followUp' ? { queueMode: 'followUp' } : {}),
      ...(images === undefined ? {} : { images }),
    })
    return { delivered: true, target: record.id, mode: queueMode }
  }

  /**
   * Puts a finished record back to `running` on the live process its console holds. The
   * clock and the turn allowances are the new turn's: the old run's window has already
   * expired, and keeping its start time would abort this turn the moment the timer ticks.
   * @param {any} record
   */
  reopenForConsole(record) {
    const now = Date.now()
    record.status = 'running'
    record.phase = 'busy'
    record.endedAt = null
    record.result = { text: null, reportPath: null, truncated: false, error: null }
    record.notified = false
    record.wrapUpSent = false
    record.startedAt = now
    record.last = { eventAt: now, tool: null, toolStartedAt: null }
    record.queueLength = 0
    record.continuations = 0
    record.consecutiveToolFailures = 0
    record.toolFailureNudgeSent = false
    record.recoveries = {}
    record.streamChars = 0
    this.lastAssistant.set(record.id, '')
    this.lastAssistantMessage.delete(record.id)
    clearTimeout(this.finishTimers.get(record.id))
    this.finishTimers.delete(record.id)
    this.startBudgetTimer(record.id)
    this.persistSoon()
    this.emitChange()
  }

  /**
   * Promotes a foreground child to background after the tool's wait window. From then on its
   * completion is delivered to the parent instead of dying with the tool call's interest.
   * @param {any} principal @param {string} target
   */
  promote(principal, target) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('The parent chooser is not a subagent record.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('promote is a parent-only control action.')
    if (record.status === 'running' && !record.background) {
      record.background = true
      this.registry.audit(record, 'promote', { sender: principal?.requesterId || null })
      this.persistSoon()
      this.emitChange()
    }
    return this.status(principal, target)
  }

  /**
   * Every record below a parent, nearest first. The registry is the tree; a missing or
   * cyclic parentId must not make cleanup recurse forever.
   * @param {string} id
   */
  descendantsOf(id) {
    const byParent = new Map()
    for (const record of this.registry.all()) {
      if (!record?.parentId) continue
      if (!byParent.has(record.parentId)) byParent.set(record.parentId, [])
      byParent.get(record.parentId).push(record)
    }
    const out = []
    const queue = [id]
    const seen = new Set([id])
    while (queue.length > 0) {
      for (const child of byParent.get(queue.shift()) || []) {
        if (!child?.id || seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child)
        queue.push(child.id)
      }
    }
    return out
  }

  /** @param {string} id */
  stopDescendants(id) {
    // Deepest first: a child must not be able to report into a parent that is already
    // terminal, and a stopped parent must never leave a live grandchild behind.
    for (const child of this.descendantsOf(id).reverse()) {
      if (child.status !== 'running') continue
      child.notify = 'silent'
      this.finish(child.id, 'stopped', 'Stopped because its parent was stopped.')
      void this.bridges
        .get(child.id)
        ?.abort()
        .catch(() => {})
    }
  }

  /** @param {any} principal @param {string} target */
  async stop(principal, target) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('There is nothing to stop on the parent chooser.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('stop is a parent-only control action.')
    // A parent is a subtree, not one process. A completed parent can still own a live
    // grandchild, so cascade before deciding whether the parent itself has anything to
    // stop; otherwise stop on an already-finished parent leaves that grandchild running.
    this.stopDescendants(record.id)
    if (record.status !== 'running') return this.status(principal, target, { includeReport: true })
    // Mark the record stopped before asking Pi to abort. Aborting makes the child settle,
    // and the settle handler can otherwise write `completed` first, leaving stop reporting
    // a success where the status still says completed. Once this record is stopped, those
    // late lifecycle events are ignored and the status is unambiguous.
    this.finish(record.id, 'stopped', 'Stopped by the parent.')
    // Do not make the HTTP response wait for a long bash call to unwind. The abort command
    // is on its way; the record is already terminal and its late events are ignored.
    void this.bridges
      .get(record.id)
      ?.abort()
      .catch(() => {})
    return this.status(principal, target, { includeReport: true })
  }

  /**
   * Internal restart of a finished child on its session. There is no public `resume`
   * action: sending a message to a finished child is the resume, and it must not replay
   * the original task. `prompt` is left undefined for the rare caller that wants the
   * stored task repeated; an empty string starts the process and lets the caller send.
   * @param {any} principal @param {string} target @param {{ prompt?: string }} [options]
   */
  async resume(principal, target, { prompt } = {}) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('The parent chooser cannot be resumed.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('resume is a parent-only control action.')
    if (record.status === 'running') throw new Error('That subagent is already running.')
    await this.startRun(record, {
      prompt: prompt === undefined ? this.resumePrompt(record) : prompt,
      resume: true,
    })
    return this.status(principal, target)
  }

  /**
   * Remove one record's live handles and private artifacts. The caller owns abort/dispose
   * and decides whether the registry emits; this keeps subtree deletion from emitting once
   * per grandchild.
   * @param {any} record
   */
  discardRecord(record) {
    this.bridges.delete(record.id)
    this.childConsoles.delete(record.id)
    this.lastAssistant.delete(record.id)
    this.lastAssistantMessage.delete(record.id)
    this.tokens.revoke(this.tokens.find('child', record.id))
    clearInterval(this.timers.get(record.id))
    this.timers.delete(record.id)
    clearTimeout(this.finishTimers.get(record.id))
    this.finishTimers.delete(record.id)

    if (this.sessionsRoot) {
      const childSessions = resolve(this.sessionsRoot, 'subagents')
      for (const run of Array.isArray(record.runs) ? record.runs : []) {
        if (!run?.sessionFile) continue
        const file = resolve(String(run.sessionFile))
        const rel = relative(childSessions, file)
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
        try {
          rmSync(file, { force: true })
        } catch {
          // A file the user already removed needs no second deletion.
        }
      }
    }
    if (this.agentRoot) {
      const childRoot = resolve(this.agentRoot, 'subagents')
      const childDir = resolve(childRoot, String(record.id))
      const rel = relative(childRoot, childDir)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        try {
          rmSync(childDir, { recursive: true, force: true })
        } catch {
          // The registry entry is still removed below.
        }
      }
    }
    this.registry.remove(record.id)
  }

  /**
   * Removes a child, its descendants and the private artifacts they own. Running bridges are
   * aborted before their records disappear, so deleting a parent cannot leave live
   * grandchildren behind. Only session files inside this router's `sessions/subagents`
   * directory, and each child's own `subagents/<id>` directory, are removed.
   * @param {any} principal @param {string} target
   */
  async delete(principal, target) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('There is nothing to delete on the parent chooser.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('delete is a parent-only control action.')

    // Delete the subtree deepest first. Aborting is the only way to stop a running Pi
    // process; disposing alone releases the pipes and would leave the grandchild alive.
    const targets = [...this.descendantsOf(record.id).reverse(), record]
    for (const target of targets) {
      target.notify = 'silent'
      const bridge = this.bridges.get(target.id)
      if (target.status === 'running') {
        try {
          await bridge?.abort()
        } catch {
          // The child may already be gone; deletion is still the record's outcome.
        }
      }
      try {
        if (typeof bridge?.dispose === 'function') bridge.dispose()
        else bridge?.release?.()
      } catch {
        // The record is removed whether or not the process had already stopped.
      }
      this.discardRecord(target)
    }
    this.emitChange()
    return { deleted: true, id: record.id }
  }

  // ── persistence / recovery ──────────────────────────────────────────────────────────

  persistSoon() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.registry.save()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  emitChangeSoon() {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.emitChange()
    }, 300)
    this.changeTimer.unref?.()
  }

  emitChange() {
    this.uiRevision += 1
    try {
      this.onChange(this.uiRecords())
    } catch {
      // The UI is not the runtime.
    }
  }

  /** A resumable tree snapshot for a page that just opened or reconnected. */
  uiSnapshot() {
    return { records: this.uiRecords(), revision: this.uiRevision }
  }

  /** @param {string} id */
  consoleForId(id) {
    return this.childConsoles.get(String(id || '')) || null
  }

  /** @param {string} consoleKey */
  recordForConsoleKey(consoleKey) {
    if (!consoleKey || !String(consoleKey).startsWith('sub-')) return null
    for (const record of this.registry.all()) {
      const run = record.runs?.at(-1)
      if (record.status === 'running' && run?.consoleKey === consoleKey) return record
    }
    return null
  }

  /**
   * The row the proxy actually used. `rowKey` is the route chosen at spawn time; a child's
   * pool can run dry mid-run, so the row that answers may be a fallback — or, at the last
   * resort, one the proxy reached by widening past the pool entirely. Both belong on the
   * record, or a finished child's report names a route that never served it.
   * @param {string} consoleKey @param {any} row
   * @param {{ widened?: boolean }} [options]
   */
  noteRoute(consoleKey, row, { widened = false } = {}) {
    const record = this.recordForConsoleKey(consoleKey)
    if (!record || !row) return
    const key = getRoutingModelKey(row)
    if (!key) return
    if (widened) record.model.widened = true
    const previous = record.model.selectedKey || record.model.rowKey
    if (previous === key) {
      if (widened) this.persistSoon()
      return
    }
    record.model.selectedKey = key
    const fallbacks = Array.isArray(record.model.fallbacks) ? record.model.fallbacks : []
    if (!fallbacks.some((entry) => entry.to === key)) {
      fallbacks.push({
        from: previous,
        to: key,
        reason: widened
          ? 'pool exhausted; widened to the live catalogue'
          : 'provider unavailable; pool fallback',
      })
      record.model.fallbacks = fallbacks.slice(-20)
    }
    this.persistSoon()
  }

  /**
   * Reattaches running children through their keepers after a router restart. A record
   * whose keeper is gone is failed with its partial output preserved, never silently
   * treated as still running.
   */
  async restore() {
    for (const record of this.registry.all()) {
      if (record.status !== 'running') continue
      const run = record.runs?.at(-1)
      if (!run) {
        this.finish(record.id, 'failed', 'The child never produced a run record.')
        continue
      }
      try {
        const agentDir = join(this.agentRoot, 'subagents', record.id, 'agent')
        const childSessions = join(this.sessionsRoot, 'subagents')
        const settings = {
          ...this.settings,
          sessions: childSessions,
          workspace: record.cwd || this.workspace,
          thinking: record.thinking || this.settings.thinking || null,
          extraArgs: Array.isArray(this.settings.extraArgs) ? [...this.settings.extraArgs] : [],
        }
        const capabilityTool =
          record.grants?.transcripts || record.grants?.message || record.grants?.spawn
            ? ['subagent']
            : []
        const childTools = [...new Set([...(record.tools || []), ...capabilityTool])]
        if (childTools.length > 0) settings.extraArgs.push('--tools', childTools.join(','))
        else settings.extraArgs.push('--no-tools')
        const plan = planPiLaunch(settings, {
          baseUrl: this.baseUrl,
          agentDir,
          consoleKey: run.consoleKey,
        })
        if (plan.error) throw new Error(plan.error)
        const bridge = this.createBridge
          ? await this.createBridge({ record, run, plan, env: plan.env, agentDir, adopt: true })
          : new PiBridge({
              command: plan.command,
              args: plan.args,
              cwd: plan.cwd,
              env: plan.env,
              notes: plan.notes,
              launchError: plan.error,
              supervisor: this.supervisorFor(plan, run.consoleKey),
            })
        bridge.subagentId = record.id
        bridge.consoleKey = run.consoleKey
        bridge.subagentInfo = () => this.childInfo(record.id)
        if (typeof bridge.adoptKeeper !== 'function')
          throw new Error('The bridge cannot adopt a keeper.')
        await bridge.adoptKeeper()
        this.bridges.set(record.id, bridge)
        if (this.attachConsole) {
          const consoleEntry = this.attachConsole(run.consoleKey, bridge)
          if (consoleEntry) this.childConsoles.set(record.id, consoleEntry)
        }
        this.wireBridge(record.id, bridge)
        this.startBudgetTimer(record.id)
        this.emitChange()
      } catch (err) {
        this.finish(
          record.id,
          'failed',
          `The child could not be reattached after restart: ${/** @type {Error} */ (err)?.message || err}`,
        )
      }
    }
  }

  dispose() {
    this.disposed = true
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const timer of this.finishTimers.values()) clearTimeout(timer)
    this.finishTimers.clear()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    for (const bridge of this.bridges.values()) {
      try {
        if (typeof bridge.release === 'function') bridge.release()
        else bridge.dispose?.()
      } catch {
        // Nothing left to save.
      }
    }
    this.bridges.clear()
  }
}

export { EventEmitter }
