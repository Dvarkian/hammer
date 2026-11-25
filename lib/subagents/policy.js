// @ts-check
/**
 * @file policy.js
 * @description The router's grant policy, principal resolution and minimal status shapes.
 *
 * These are policy checks, not an OS security boundary. They decide what a model is
 * *allowed* to ask the router for; a child with `bash` can still read the user's files and
 * call loopback routes. The token is what stops a child claiming to be another agent, and
 * the target checks are what keep a transcript read inside one root.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { normalizeUsageFilter } from './usage-bands.js'

/** The web tools are materialized as a Pi extension; `webfetch` is kept for older grants. */
export const WEB_TOOL_NAMES = Object.freeze(['webfetch', 'web_search', 'web_fetch'])

export const PI_TOOL_NAMES = Object.freeze([
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write',
  'bash',
  'todo',
  'task',
  ...WEB_TOOL_NAMES,
])

export const CAPABILITY_NAMES = Object.freeze(['transcripts', 'message', 'spawn'])

export const DEFAULT_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls'])

// `tokenBudget` is a spend ceiling over the whole run, and Pi reports input tokens for every
// turn: a child doing twenty web searches re-sends its growing context each time, so a 300,000
// ceiling was reached in under two minutes and killed three research children before they wrote
// a word. The ceiling now leaves room for the 40 turns and 20 minutes it sits beside; a caller
// that wants a tighter spend cap still sets `token_budget`.
export const DEFAULT_LIMITS = Object.freeze({
  maxTurns: 40,
  timeoutMs: 20 * 60 * 1000,
  tokenBudget: 2_000_000,
})

export const MAX_LIMITS = Object.freeze({
  maxTurns: 40,
  timeoutMs: 60 * 60 * 1000,
  tokenBudget: 5_000_000,
})

export const CAPS = Object.freeze({
  maxDepth: 2,
  maxSpawnsPerHour: 32,
  maxTranscriptChars: 8000,
  maxReportChars: 16000,
  maxMessageChars: 8000,
  maxMessagesPer10Min: 10,
  maxTranscriptReadsPer10Min: 10,
  maxMessageTurnsPer10Min: 20,
})

/** @param {unknown} value @returns {number|null} */
function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** @param {string} value */
export function slugName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** @param {string} workspace @param {string|null|undefined} requested */
export function clampCwd(workspace, requested) {
  const root = resolve(workspace)
  const target = resolve(root, requested || '.')
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`cwd ${target} is outside the parent workspace ${root}.`)
  }
  return target
}

/** @param {any} principal */
export function principalTools(principal) {
  const tools = Array.isArray(principal?.tools) ? principal.tools : []
  return new Set(tools.length ? tools : PI_TOOL_NAMES)
}

/** @param {any} principal */
export function principalGrants(principal) {
  const grants = principal?.grants && typeof principal.grants === 'object' ? principal.grants : {}
  return {
    transcripts: grants.transcripts === true,
    message: grants.message === true,
    spawn: grants.spawn === true || principal?.parent === true,
  }
}

/**
 * Normalizes one spawn request against the caller's own rights. Throws when a request asks
 * for a tool the parent does not have, a grant it does not hold, a depth beyond the cap, or
 * a cwd outside its workspace.
 *
 * @param {{
 *   principal: any,
 *   params: any,
 *   workspace: string,
 *   maxDepth?: number,
 *   limits?: typeof DEFAULT_LIMITS,
 * }} input
 */
export function normalizeSpawnRequest({
  principal,
  params,
  workspace,
  maxDepth = CAPS.maxDepth,
  limits = DEFAULT_LIMITS,
}) {
  const body = params && typeof params === 'object' ? params : {}
  if (principal?.parent !== true && principalGrants(principal).spawn !== true)
    throw new Error('This principal is not allowed to spawn subagents.')
  if (Number(principal?.depth || 0) >= maxDepth)
    throw new Error(
      `A child at depth ${Number(principal.depth) + 1} cannot spawn again (max depth ${maxDepth}).`,
    )
  const parentTools = principalTools(principal)
  const parentGrants = principalGrants(principal)
  const requested = Array.isArray(body.tools) ? body.tools : DEFAULT_TOOLS
  if (requested.length > 12) throw new Error('At most 12 tools may be requested.')
  const tools = []
  const grantedCapabilities = { transcripts: false, message: false, spawn: false }
  for (const raw of requested) {
    const name = String(raw || '')
      .trim()
      .toLowerCase()
    if (!name) continue
    if (CAPABILITY_NAMES.includes(name)) {
      if (!parentGrants[name])
        throw new Error(`The parent does not hold the "${name}" grant, so it cannot pass it on.`)
      if (name === 'spawn' && Number(principal.depth || 0) + 1 >= maxDepth)
        throw new Error(
          `A child at depth ${Number(principal.depth || 0) + 1} cannot spawn again (max depth ${maxDepth}).`,
        )
      grantedCapabilities[name] = true
      continue
    }
    if (!PI_TOOL_NAMES.includes(name))
      throw new Error(`Unknown tool "${name}". Allowed: ${PI_TOOL_NAMES.join(', ')}.`)
    if (!parentTools.has(name))
      throw new Error(`The parent does not have the "${name}" tool, so it cannot grant it.`)
    tools.push(name)
  }

  const task = typeof body.task === 'string' ? body.task.trim() : ''
  if (!task)
    throw new Error('spawn requires a task: pass task with the work the child must complete.')
  if (task.length > 20_000) throw new Error('The task is capped at 20,000 characters.')
  const instructions =
    typeof body.instructions === 'string' ? body.instructions.trim().slice(0, 12_000) : ''

  const name = slugName(body.name) || `agent-${Math.random().toString(36).slice(2, 8)}`
  if (!name) throw new Error('A name must contain a letter or number.')
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model)
    throw new Error('spawn requires a model: pass a catalogue key or fast | balanced | smart.')

  const maxTurns = Math.max(1, Math.min(limits.maxTurns, finite(body.max_turns) ?? limits.maxTurns))
  const timeoutMs = Math.max(
    1_000,
    Math.min(limits.timeoutMs, finite(body.timeout_ms) ?? limits.timeoutMs),
  )
  // A token budget is a spend ceiling, not a unit with a floor of its own. The old 1,000-token
  // floor silently changed a requested 500 into 1,000 and made the number in `limits` disagree
  // with the one the caller asked for.
  const tokenBudget = Math.max(
    1,
    Math.min(limits.tokenBudget, finite(body.token_budget) ?? limits.tokenBudget),
  )
  const minIntelligence = finite(body.min_intelligence)
  const minSpeed = finite(body.min_speed)
  const minContext = finite(body.min_context)
  for (const [name, value, raw] of [
    ['min_intelligence', minIntelligence, body.min_intelligence],
    ['min_speed', minSpeed, body.min_speed],
    ['min_context', minContext, body.min_context],
  ]) {
    if (raw != null && (value == null || value < 0))
      throw new Error(`${name} must be a non-negative number.`)
  }
  const notify = body.notify === 'queue' || body.notify === 'silent' ? body.notify : 'auto'
  const thinking = ['off', 'low', 'medium', 'high'].includes(body.thinking) ? body.thinking : null
  const provider =
    typeof body.provider === 'string' && body.provider.trim()
      ? body.provider.trim().toLowerCase()
      : null

  return {
    name,
    task,
    instructions,
    tools,
    grants: grantedCapabilities,
    model,
    provider,
    background: body.background === true,
    notify,
    thinking,
    cwd: clampCwd(workspace, typeof body.cwd === 'string' ? body.cwd : null),
    limits: { maxTurns, timeoutMs, tokenBudget },
    filters: {
      min_intelligence: minIntelligence,
      min_speed: minSpeed,
      min_context: minContext,
      usage: normalizeUsageFilter(body.usage),
    },
    depth: Number(principal.depth || 0) + 1,
    parentId:
      principal.parent === true || Number(principal.depth || 0) === 0
        ? null
        : principal.requesterId,
    rootId: principal.rootId,
    thinkingBudget: finite(body.thinking_budget),
  }
}

/**
 * Whether `record` is below `ancestorId` in the registry tree.
 * @param {any} record @param {string} ancestorId @param {Map<string, any>} records
 */
export function isDescendant(record, ancestorId, records) {
  let parentId = record?.parentId
  const seen = new Set()
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true
    seen.add(parentId)
    parentId = records.get(parentId)?.parentId || null
  }
  return false
}

/** @param {any} principal */
export function isUiPrincipal(principal) {
  return principal?.ui === true
}

/** @param {any} principal @param {any} record */
export function sameRoot(principal, record) {
  return Boolean(principal && record && principal.rootId && principal.rootId === record.rootId)
}

/** @param {any} principal @param {any} record @param {Map<string, any>} records */
export function isAncestorOf(principal, record, records) {
  if (!principal || !record) return false
  if (!sameRoot(principal, record)) return false
  if (principal.parent === true) return true
  if (principal.requesterId && record.id === principal.requesterId) return false
  if (principal.requesterId && record.parentId === principal.requesterId) return true
  return Boolean(principal.requesterId && isDescendant(record, principal.requesterId, records))
}

/**
 * Whether the principal may read a target's report or transcript.
 * @param {any} principal @param {any} record @param {Map<string, any>} records
 */
export function canReadRecord(principal, record, records) {
  if (!principal || !record) return false
  if (isUiPrincipal(principal)) return true
  if (!sameRoot(principal, record)) return false
  if (isAncestorOf(principal, record, records)) return true
  return principalGrants(principal).transcripts === true
}

/**
 * Whether the principal may send to a target. Parent authority is inherent; a child needs
 * the explicit `message` grant and remains inside its root.
 * @param {any} principal @param {any} record @param {Map<string, any>} records
 */
export function canMessageRecord(principal, record, records) {
  if (!principal || !record) return false
  if (isUiPrincipal(principal)) return true
  if (!sameRoot(principal, record)) return false
  if (isAncestorOf(principal, record, records)) return true
  if (record.id === principal.requesterId) return false
  return principalGrants(principal).message === true
}

/**
 * Wait, stop and delete are parent-only. A child with `message` may talk; it may not
 * reach into another agent's lifecycle.
 * @param {any} principal @param {any} record @param {Map<string, any>} records
 */
export function canControlRecord(principal, record, records) {
  if (!principal || !record) return false
  if (isUiPrincipal(principal)) return true
  return isAncestorOf(principal, record, records)
}

/**
 * The minimal list/status view. It never contains task text, instructions, transcript or
 * report text; the UI and the parent's own report request are the only readers of those.
 * @param {any} record
 * @param {number} [now]
 */
export function minimalStatus(record, now = Date.now()) {
  if (!record) return null
  const lastAt = Number(record.last?.eventAt) || Number(record.startedAt) || now
  const startedAt = Number(record.startedAt) || now
  const endedAt = Number(record.endedAt) || null
  const queued = Number(record.queueLength) || 0
  return {
    id: record.id,
    name: record.name,
    parentId: record.parentId ?? null,
    rootId: record.rootId,
    phase: record.phase,
    status: record.status,
    depth: record.depth,
    model: {
      requested: record.model?.requested || null,
      group: record.model?.groupId || null,
      selected: record.model?.selectedKey || record.model?.rowKey || null,
      // True when the serving row came from widening past the child's own pool, so a caller
      // can tell a planned fallback from the proxy's last-resort deviation.
      widened: record.model?.widened === true,
      fallback: (record.model?.fallbacks || [])
        .map((entry) => entry.to || entry.key)
        .filter(Boolean),
    },
    tools: Array.isArray(record.tools) ? record.tools.slice() : [],
    turns: Number(record.usage?.turns) || 0,
    tokens: Number(record.usage?.totalTokens) || 0,
    elapsedMs: Math.max(0, (endedAt || now) - startedAt),
    quietMs: record.status === 'running' ? Math.max(0, now - lastAt) : 0,
    currentTool: record.last?.tool || null,
    currentToolStartedAt: record.last?.toolStartedAt || null,
    queueLength: queued,
    limits: record.limits ? { ...record.limits } : null,
    // The level chosen when this child was spawned. Without it a chooser can name the
    // model but not the effort it is running at, so the setting looked ignored.
    thinking: record.thinking || null,
    runs: Number(record.runs?.length) || 0,
    createdAt: record.createdAt,
    endedAt,
  }
}

/** @param {any[]} records @param {number} [now] */
export function minimalList(records, now = Date.now()) {
  return (Array.isArray(records) ? records : []).map((record) => minimalStatus(record, now))
}

/**
 * The parent-facing report. Keys, not labels; the text is capped and the full report's
 * path is sent when it had to be written to disk.
 * @param {any} record
 */
export function reportPayload(record) {
  if (!record) return null
  const text = typeof record.result?.text === 'string' ? record.result.text : ''
  return {
    id: record.id,
    name: record.name,
    state: record.status,
    model: record.model?.groupId || record.model?.requested || null,
    selected: record.model?.selectedKey || record.model?.rowKey || null,
    widened: record.model?.widened === true,
    fallback: (record.model?.fallbacks || []).map((entry) => ({
      from: entry.from || null,
      to: entry.to || null,
      reason: entry.reason || null,
    })),
    turns: Number(record.usage?.turns) || 0,
    tokens: Number(record.usage?.totalTokens) || 0,
    elapsedMs: Math.max(
      0,
      (Number(record.endedAt) || Date.now()) - (Number(record.startedAt) || Date.now()),
    ),
    text,
    truncated: record.result?.truncated === true,
    reportPath: record.result?.reportPath || null,
    error: record.result?.error || null,
  }
}

/** @param {any} record */
export function xmlReport(record) {
  if (!record) return ''
  const payload = reportPayload(record)
  const attrs = [
    `id="${record.id}"`,
    `name="${record.name}"`,
    `state="${record.status}"`,
    `model="${payload.model || ''}"`,
    `selected="${payload.selected || ''}"`,
    `fallback="${payload.fallback.length > 0 ? payload.fallback.map((entry) => entry.to).join(',') : 'none'}"`,
    `turns="${payload.turns}"`,
    `tokens="${payload.tokens}"`,
    `elapsed="${Math.round(payload.elapsedMs / 1000)}s"`,
  ]
  const body = payload.text || payload.error || '(no output)'
  const path = payload.reportPath ? `\nreport=${payload.reportPath}` : ''
  // This is the background notification wrapper, not the foreground tool result. The
  // harness uses the tag to draw a notification card instead of a user message; Pi still
  // sees an ordinary user-shaped message and must treat its contents as untrusted.
  return `<subagent-result ${attrs.join(' ')}>\n<result>${body}</result>${path}\n</subagent-result>`
}
