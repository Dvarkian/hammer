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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PiBridge } from '../pi/bridge.js'
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
  resolveSpawnGroup,
} from './catalogue.js'
import { usageTagLabel } from './model-usage.js'
import { childCharter, materializeSubagentExtension, writeChildCharter } from './extension.js'
import {
  CAPS,
  canControlRecord,
  canMessageRecord,
  canReadRecord,
  isUiPrincipal,
  minimalStatus,
  normalizeSpawnRequest,
  PI_TOOL_NAMES,
  reportPayload,
  sameRoot,
  WEB_TOOL_NAMES,
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
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'message_end') {
      const message = record.message
      if (!message) continue
      const role =
        message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : ''
      if (!role) continue
      const text = textOfContent(message.content)
      if (text) push(`${role}: ${text}`)
      continue
    }
    if (record.type === 'tool_execution_start') {
      const args = record.args && typeof record.args === 'object' ? JSON.stringify(record.args) : ''
      push(`tool ${record.toolName || 'tool'}${args ? ` ${args}` : ''}`)
      continue
    }
    if (record.type === 'tool_execution_end') {
      const result = textOfContent(record.result) || textOfContent(record.partialResult)
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
    this.parentRoute = typeof options.parentRoute === 'function' ? options.parentRoute : () => null
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
    this.maxDepth = finite(options.maxDepth) ?? CAPS.maxDepth
    this.limits = options.limits || { maxTurns: 40, timeoutMs: 20 * 60_000, tokenBudget: 300_000 }
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
    /** @type {Map<string, { at:number, count:number }>} */
    this.messageRates = new Map()
    /** @type {Map<string, { at:number, count:number }>} */
    this.transcriptRates = new Map()
    /** @type {Map<string, { at:number, count:number }>} */
    this.lastMessageTurn = new Map()
    this.saveTimer = null
    this.changeTimer = null
    this.supervisor = null
    this.disposed = false
    this.uiTokenValue = ''

    const existing = this.tokens.parentToken(this.parentKey)
    this.parentTokenValue = this.tokens.issue(
      {
        type: 'parent',
        requesterId: 'root',
        parent: true,
        parentId: null,
        rootId: this.rootId,
        depth: 0,
        consoleKey: this.parentKey,
        tools: [...PI_TOOL_NAMES],
        grants: { transcripts: true, message: true, spawn: true },
      },
      existing,
    )
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

  /** @param {string} agentDir */
  prepareParentAgentDir(agentDir) {
    materializeSubagentExtension(agentDir)
    materializeWebExtension(agentDir)
    return {
      HAMMER_SUBAGENT_API: this.apiBase,
      HAMMER_SUBAGENT_TOKEN: this.parentTokenValue,
    }
  }

  /** The conversation the live parent console is on, or null before it has one. */
  parentSessionFile() {
    try {
      return this.parentBridge()?.status?.()?.sessionFile || null
    } catch {
      return null
    }
  }

  /**
   * The conversation whose children a model-facing principal may see. The UI is deliberately
   * unscoped: its rail shows each conversation's historical branch. A parent follows the live
   * console, so switching sessions switches what it can list. A child keeps the conversation
   * it was spawned from instead of following the parent.
   * @param {any} principal
   */
  principalSessionFile(principal) {
    if (!principal || isUiPrincipal(principal)) return null
    if (principal.parent === true) {
      return this.parentSessionFile() || principal.sessionFile || null
    }
    return this.registry.get(String(principal.requesterId || ''))?.parent?.sessionFile || null
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

  groups() {
    return buildActiveGroups({
      results: this.allResults(),
      canonicalize: this.canonicalize,
      inUseCounts: this.inUseCounts(),
    })
  }

  catalogue(params = {}) {
    const groups = this.groups()
    const payload = cataloguePayload({ groups, ...params })
    return { payload, text: formatCatalogueText(payload) }
  }

  /** @param {string} key */
  groupDisplay(key) {
    const group = this.groups().find((entry) => entry.key === key)
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

    const records = this.registry.forRoot(this.rootId)
    const liveRoot = records.filter((record) => record.status === 'running')
    if (liveRoot.length >= (finite(params?.max_live) ?? CAPS.maxLivePerRoot))
      throw new Error(
        `This root already has ${liveRoot.length} live children (cap ${CAPS.maxLivePerRoot}).`,
      )
    const liveTotal = this.registry.all().filter((record) => record.status === 'running').length
    if (liveTotal >= CAPS.maxLiveTotal)
      throw new Error(
        `The router already has ${liveTotal} live children (cap ${CAPS.maxLiveTotal}).`,
      )
    const hourAgo = Date.now() - 60 * 60 * 1000
    const recent = this.registry
      .all()
      .filter((record) => record.status !== 'draft' && record.createdAt >= hourAgo)
    if (recent.length >= CAPS.maxSpawnsPerHour)
      throw new Error(`The router has spent its ${CAPS.maxSpawnsPerHour} spawns this hour.`)
    const parentSessionFile = this.parentSessionFile() || principal?.sessionFile || null
    const sameName = parentSessionFile
      ? this.registry.findByName(request.name, this.rootId, parentSessionFile)
      : this.registry.findByName(request.name, this.rootId)
    if (sameName)
      throw new Error(`A subagent named "${request.name}" already exists for this root.`)

    const groups = this.groups()
    const resolved = resolveSpawnGroup(groups, request.model, {
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
      rootId: this.rootId,
      parentId: request.parentId,
      taskId: null,
      parent: {
        consoleKey: this.parentKey,
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
    return {
      id: record.id,
      status: minimalStatus(this.registry.get(record.id)),
      warning,
      report: null,
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
    record.last = { eventAt: Date.now(), tool: null, toolStartedAt: null }
    record.queueLength = 0
    this.lastAssistant.set(record.id, '')
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
    // A web-only child needs the charter just as much as a capability child: it is where
    // the child learns which web tools it actually has and not to answer from memory.
    const hasWebTools =
      Array.isArray(record.tools) && record.tools.some((name) => WEB_TOOL_NAMES.includes(name))
    if (capabilityTool.length > 0 || hasWebTools) {
      writeChildCharter(
        agentDir,
        childCharter({
          instructions: record.instructions,
          cwd: record.cwd,
          tools: record.tools,
          depth: record.depth,
          maxDepth: this.maxDepth,
        }),
      )
    }
    const plan = planPiLaunch(settings, {
      baseUrl: this.baseUrl,
      agentDir,
      consoleKey,
    })
    if (plan.error) throw new Error(plan.error)
    if (!plan.routed) throw new Error('Subagents require the console to be routed through Hammer.')

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
        plan,
        env,
        supervisor,
        agentDir,
      })
    } else {
      bridge = new PiBridge({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env,
        notes: plan.notes,
        launchError: plan.error,
        supervisor,
        compactionReserveTokens: this.settings.compaction?.reserveTokens ?? null,
      })
    }
    bridge.subagentId = record.id
    bridge.consoleKey = consoleKey
    bridge.subagentInfo = () => {
      const current = this.registry.get(record.id)
      const status = current ? minimalStatus(current) : null
      return {
        ...status,
        task: current?.task || '',
        instructions: current?.instructions || '',
        grants: current?.grants || {},
        cwd: current?.cwd || null,
        runs: (current?.runs || []).map((entry) => ({
          number: entry.number,
          sessionFile: entry.sessionFile,
        })),
      }
    }
    this.bridges.set(record.id, bridge)
    if (this.attachConsole) {
      const console = this.attachConsole(consoleKey, bridge)
      if (console) this.childConsoles.set(record.id, console)
    }
    this.wireBridge(record.id, bridge)
    this.startBudgetTimer(record.id)
    try {
      await bridge.start()
      if (prompt) await bridge.prompt(prompt)
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
    bridge.on('exit', (info) => {
      const record = this.registry.get(id)
      if (!record || record.status !== 'running') return
      if (info?.signal === 'SIGTERM' && bridge.disposed) return
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
      record.usage.turns = (Number(record.usage.turns) || 0) + 1
      record.phase = 'busy'
    } else if (event.type === 'tool_execution_start') {
      record.last.tool = event.toolName || 'tool'
      record.last.toolStartedAt = now
      record.phase = 'busy'
    } else if (event.type === 'tool_execution_end') {
      record.last.tool = null
      record.last.toolStartedAt = null
    } else if (event.type === 'compaction_start') {
      record.phase = 'compacting'
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = assistantText(event)
      if (text) this.lastAssistant.set(id, text)
    } else if (event.type === 'agent_settled') {
      const status = this.bridges.get(id)?.status?.()
      if (status?.isStreaming || Number(status?.pendingMessages) > 0) return
      this.finish(id, 'completed', null)
      return
    }
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
    const parent = this.parentBridge()
    if (!parent) {
      this.registry.addNotice(this.rootId, text, record.parent?.sessionFile || null)
      this.registry.update(record.id, { notified: true })
      return
    }
    try {
      const sessionFile = this.parentSessionFile()
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

  /** @param {PiBridge} bridge */
  attachParent(bridge) {
    this.parentBridgeRef = bridge
    this.deliverNotices()
  }

  async deliverNotices() {
    const parent = this.parentBridge()
    if (!parent) return
    const sessionFile = this.parentSessionFile()
    if (!sessionFile) return
    for (const notice of this.registry.takeNotices(this.rootId, sessionFile)) {
      try {
        const status = parent.status?.() || {}
        await parent.prompt(notice.text, status.isStreaming ? { queueMode: 'followUp' } : undefined)
      } catch {
        this.registry.addNotice(this.rootId, notice.text, sessionFile)
      }
    }
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
      const tokens = Number(record.usage?.totalTokens) || 0
      const turns = Number(record.usage?.turns) || 0
      const ratio = Math.max(
        elapsed / Math.max(1, record.limits.timeoutMs),
        tokens / Math.max(1, record.limits.tokenBudget),
        turns / Math.max(1, record.limits.maxTurns),
      )
      if (ratio >= 0.8 && !record.wrapUpSent) {
        record.wrapUpSent = true
        void this.bridges
          .get(id)
          ?.prompt(
            'Budget notice: you are near your time or token budget. Wrap up, make no new tool calls, and return a concise report now.',
            { queueMode: 'followUp' },
          )
          .catch(() => {})
      }
      if (ratio >= 1) {
        void this.bridges
          .get(id)
          ?.abort()
          .catch(() => {})
        this.finish(id, 'stopped', 'The child reached its time, turn or token budget.')
      }
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
      !principal?.grants?.message
    ) {
      throw new Error('This principal cannot list subagents.')
    }
    const list = records.map((record) => {
      const base = minimalStatus(record)
      // The parent's `list` action is the minimal view: task text, cwd and the audit trail
      // belong to the UI's separately scoped token, not to a model-facing payload.
      if (isUiPrincipal(principal)) {
        base.task = record.task
        // A child belongs to the conversation that spawned it, not to the console's current
        // session: the rail nests the tree under that session's row.
        base.parentSessionFile = record.parent?.sessionFile || null
        base.display = this.groupDisplay(record.model?.groupId || '')
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
    return this.registry.all().map((record) => ({
      ...minimalStatus(record),
      task: record.task,
      parentSessionFile: record.parent?.sessionFile || null,
      cwd: record.cwd,
      background: record.background,
      thinking: record.thinking || null,
      warning: record.warning || null,
      display: this.groupDisplay(record.model?.groupId || ''),
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
    const wrapped = `<agent-message from="${principal?.requesterId || 'unknown'}" mode="${mode}">\n${text}\n</agent-message>`

    if (parentTarget) {
      const parent = this.parentBridge()
      if (!parent) throw new Error('The parent chooser is not attached to a live console.')
      const status = parent.status?.() || {}
      try {
        await parent.prompt(
          wrapped,
          status.isStreaming || status.isCompacting ? { queueMode: 'followUp' } : undefined,
        )
      } catch (err) {
        throw new Error(`delivery_failed: ${/** @type {Error} */ (err)?.message || err}`, {
          cause: err,
        })
      }
      return { delivered: true, target: 'parent', mode }
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
      await bridge.prompt(wrapped, mode === 'steer' ? undefined : { queueMode: 'followUp' })
    } catch (err) {
      throw new Error(`delivery_failed: ${/** @type {Error} */ (err)?.message || err}`, {
        cause: err,
      })
    }
    this.registry.audit(this.registry.get(record.id), 'message', {
      sender: principal?.requesterId || null,
      mode,
      bytes: Buffer.byteLength(text),
      result: 'delivered',
    })
    return { delivered: true, target: record.id, mode }
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

  /** @param {any} principal @param {string} target */
  async stop(principal, target) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('There is nothing to stop on the parent chooser.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('stop is a parent-only control action.')
    if (record.status !== 'running') return this.status(principal, target)
    try {
      await this.bridges.get(record.id)?.abort()
    } catch {
      // The child may already be dead; the record is still stopped.
    }
    this.finish(record.id, 'stopped', 'Stopped by the parent.')
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
   * Removes a child and the private artifacts it owns. A running child is aborted first.
   * Only session files inside this router's `sessions/subagents` directory, and the child's
   * own `subagents/<id>` directory, are removed; nothing else on disk is touched.
   * @param {any} principal @param {string} target
   */
  async delete(principal, target) {
    const record = this.resolveTarget(target, principal)
    if (record.parent === true) throw new Error('There is nothing to delete on the parent chooser.')
    if (!canControlRecord(principal, record, this.registry.records))
      throw new Error('delete is a parent-only control action.')

    const bridge = this.bridges.get(record.id)
    if (record.status === 'running') {
      // Deleting is not a completion event; do not wake the parent with a stop notice for
      // a child it just asked to forget.
      record.notify = 'silent'
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
    this.bridges.delete(record.id)
    this.childConsoles.delete(record.id)
    this.lastAssistant.delete(record.id)
    this.tokens.revoke(this.tokens.find('child', record.id))
    clearInterval(this.timers.get(record.id))
    this.timers.delete(record.id)

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
    try {
      this.onChange(this.uiRecords())
    } catch {
      // The UI is not the runtime.
    }
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

  /** @param {string} consoleKey @param {any} row */
  noteRoute(consoleKey, row) {
    const record = this.recordForConsoleKey(consoleKey)
    if (!record || !row) return
    const key = getRoutingModelKey(row)
    if (!key) return
    const previous = record.model.selectedKey || record.model.rowKey
    if (previous === key) return
    record.model.selectedKey = key
    const fallbacks = Array.isArray(record.model.fallbacks) ? record.model.fallbacks : []
    if (!fallbacks.some((entry) => entry.to === key)) {
      fallbacks.push({ from: previous, to: key, reason: 'provider unavailable; pool fallback' })
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
        bridge.subagentInfo = () => minimalStatus(this.registry.get(record.id))
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
