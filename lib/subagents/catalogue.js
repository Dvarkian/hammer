// @ts-check
/**
 * @file catalogue.js
 * @description The choosing surface a parent agent sees, and the ordered route pool a child uses.
 *
 * The parent picks a model group, not a provider row. A group has one intelligence figure,
 * one speed figure and one aggregate usage reading; the router resolves which concrete row
 * answers, and re-filters that pool before every request. Labels never enter the
 * parent-facing payload: the key is the only identifier a parent needs, and the UI resolves
 * the label from the key.
 */

import {
  buildModelGroups,
  computeRowIntelligence,
  computeRowSpeed,
  formatTokenCount,
  INTELLIGENCE_BANDS,
  intelligenceBandForAa,
  isModelEligibleForRouting,
  parseContextSize,
  getRoutingModelKey,
} from '../utils.js'
import { aggregateUsageBands, normalizeUsageFilter, usageBandFromEvidence } from './usage-bands.js'
import { usageTagLabel } from './model-usage.js'

// One compact row is short; the default page is the largest the API allows so the parent's
// first models call carries the whole active set, not an arbitrary slice of it.
const DEFAULT_COMPACT_LIMIT = 200
const MAX_POOL_GROUPS = 6

/** @param {unknown} value @returns {number|null} */
function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A speed band for a composite effective-token rate (tokens at the 500-reference). */
export function speedBandForRate(rate) {
  const n = finite(rate)
  if (n == null || n <= 0) return null
  if (n >= 100) return 'Very Fast'
  if (n >= 50) return 'Fast'
  if (n >= 25) return 'Normal'
  if (n >= 10) return 'Slow'
  return 'Very Slow'
}

/** @param {any} row */
function routeEligible(row) {
  return Boolean(row && row.status === 'up' && isModelEligibleForRouting(row))
}

/** @param {any} row */
function usableContext(row) {
  const fromString = parseContextSize(row?.ctx)
  if (fromString != null) return fromString
  return finite(row?.contextTokens)
}

/** @param {any} row */
function routeToolSupport(row) {
  return row?.toolSupport === 'emulated' ? 'emulated' : 'native'
}

/**
 * The live groups, each with the metrics the catalogue and pool share. `models` keeps the
 * original rows, so a route key can be resolved without a second grouping pass.
 * @param {{results?: any[], canonicalize?: Function|null, inUseCounts?: Map<string, number>|Record<string, number>}} options
 */
export function buildActiveGroups({
  results = [],
  canonicalize = null,
  inUseCounts = new Map(),
} = {}) {
  const inUse =
    inUseCounts instanceof Map ? inUseCounts : new Map(Object.entries(inUseCounts || {}))
  const groups = buildModelGroups(Array.isArray(results) ? results : [], canonicalize || undefined)
  /** @type {any[]} */
  const active = []
  for (const group of groups) {
    const rows = (group.models || []).filter((row) => row && typeof row === 'object')
    const eligible = rows.filter(routeEligible)
    if (eligible.length === 0) continue

    /** @type {any|null} */
    let rated = null
    for (const row of eligible) {
      const value = computeRowIntelligence(row)
      if (value == null || value <= 0) continue
      if (!rated || value > rated.intelligence) rated = { row, intelligence: value }
    }
    if (!rated) continue

    /** @type {any|null} */
    let fastest = null
    for (const row of eligible) {
      const value = computeRowSpeed(row)
      if (value == null || value <= 0) continue
      if (!fastest || value > fastest.speed) fastest = { row, speed: value }
    }
    const context = eligible.reduce((max, row) => {
      const value = usableContext(row)
      return value != null && value > max ? value : max
    }, 0)
    const providers = [
      ...new Set(eligible.map((row) => String(row.providerKey || '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b))
    const toolSupport = eligible.every((row) => routeToolSupport(row) === 'emulated')
      ? 'emulated'
      : 'native'
    const usage = aggregateUsageBands(
      eligible.map((row) =>
        usageBandFromEvidence({
          knownQuota: row.knownQuota,
          quotaWindows: row.quotaWindows,
          recordedUsage: row.recordedUsage,
          providerRecordedUsage: row.providerRecordedUsage,
          providerUsage: row.providerUsage,
          rateLimit: row.rateLimit,
          quota: row.quota,
          isRateLimited: row.isRateLimited,
        }),
      ),
    )
    const key = String(group.id || '')
      .trim()
      .toLowerCase()
    if (!key) continue
    active.push({
      key,
      label: group.label || key,
      rows,
      eligible,
      intelligence: rated.intelligence,
      intelligenceBand: intelligenceBandForAa(rated.intelligence),
      speed: fastest ? fastest.speed : null,
      speedBand: fastest ? speedBandForRate(fastest.speed) : null,
      ttft: fastest ? finite(fastest.row.ttft) : null,
      context: context || null,
      providers,
      tools: toolSupport,
      usage: usage.band,
      usageReason: usage.reason,
      inUse: Number(inUse.get(key) || 0),
      status: 'up',
    })
  }

  // Ordered by intelligence, which is how a parent reads the trade-off; the key breaks ties
  // so the compact table is stable between calls.
  active.sort((a, b) => b.intelligence - a.intelligence || a.key.localeCompare(b.key))
  return active
}

/** @param {any} group */
export function compactLine(group) {
  return {
    key: group.key,
    provider: group.providers?.length ? group.providers.join(',') : null,
    intelligence: group.intelligenceBand,
    speed: group.speedBand,
    usage: usageTagLabel(group.usage),
    context: formatTokenCount(group.context),
    ...(group.inUse > 0 ? { in_use: group.inUse } : {}),
  }
}

/** @param {string} query @param {any} group */
function matchesQuery(query, group) {
  if (!query) return true
  return group.key.includes(query)
}

// The dashboard shows five speed tags and six intelligence tags, so a small integer names a
// tag floor rather than a raw score. A caller that wants the raw plane can pass the measured
// number: AA values start at 0, and any speed above five is a real effective tok/s figure.
const SPEED_BAND_FLOORS = [0, 10, 25, 50, 100]

/** @param {unknown} value */
export function intelligenceFilterFloor(value) {
  const n = finite(value)
  if (n == null) return null
  if (Number.isInteger(n) && n >= 1 && n <= INTELLIGENCE_BANDS.length) {
    return INTELLIGENCE_BANDS[INTELLIGENCE_BANDS.length - n].from
  }
  return n
}

/** @param {unknown} value */
export function speedFilterFloor(value) {
  const n = finite(value)
  if (n == null) return null
  if (Number.isInteger(n) && n >= 1 && n <= SPEED_BAND_FLOORS.length) {
    return SPEED_BAND_FLOORS[n - 1]
  }
  return n
}

/**
 * The one filter rule shared by the models action and spawn. `min_intelligence` and
 * `min_speed` accept 1-based tag floors below their maximum; larger values are raw AA and
 * effective tok/s thresholds. `usage` is validated so a misspelled band cannot quietly match
 * nothing.
 * @param {any} group @param {any} params
 */
export function matchesCatalogueFilters(group, params = {}) {
  const minIntelligence = intelligenceFilterFloor(params.min_intelligence)
  const minSpeed = speedFilterFloor(params.min_speed)
  const minContext = finite(params.min_context)
  if (minIntelligence != null && !(group.intelligence >= minIntelligence)) return false
  if (minSpeed != null && !(group.speed != null && group.speed >= minSpeed)) return false
  if (minContext != null && !(group.context != null && group.context >= minContext)) return false
  const usage = normalizeUsageFilter(params.usage)
  if (usage && usage !== 'any') {
    if (usage === 'ample') {
      if (!['ample', 'unlimited'].includes(group.usage)) return false
    } else if (usage === 'usable') {
      if (['exhausted', 'unknown'].includes(group.usage)) return false
    } else if (group.usage !== usage) return false
  }
  return matchesQuery(
    String(params.query || '')
      .trim()
      .toLowerCase(),
    group,
  )
}

/** @param {any} group @param {boolean} includeUnrated */
function isRated(group, includeUnrated) {
  return includeUnrated || (group.intelligence != null && group.intelligence > 0)
}

function paged(rows, limit, offset) {
  const start = Math.max(0, Math.floor(offset) || 0)
  const count = Math.max(1, Math.min(200, Math.floor(limit) || DEFAULT_COMPACT_LIMIT))
  return {
    rows: rows.slice(start, start + count),
    total: rows.length,
    offset: start,
    limit: count,
    nextOffset: start + count < rows.length ? start + count : null,
  }
}

/**
 * The catalogue payload: one compact line for every active group. A query or filter
 * searches the whole active set before the result is paged.
 * @param {{
 *   groups: any[],
 *   query?: string,
 *   min_intelligence?: number,
 *   min_speed?: number,
 *   min_context?: number,
 *   usage?: string,
 *   include_unrated?: boolean,
 *   limit?: number,
 *   offset?: number,
 * }} input
 */
export function cataloguePayload(input) {
  const includeUnrated = input.include_unrated === true
  const active = input.groups.filter((group) => isRated(group, includeUnrated))
  const filtered = active.filter((group) => matchesCatalogueFilters(group, input))
  const limit = finite(input.limit) ?? DEFAULT_COMPACT_LIMIT
  const offset = finite(input.offset) ?? 0
  const compact = paged(filtered, limit, offset)
  return {
    view: 'compact',
    total_active: active.length,
    matched: filtered.length,
    detail: [],
    compact: compact.rows.map(compactLine),
    detail_total: 0,
    detail_offset: 0,
    detail_limit: 0,
    next_offset: compact.nextOffset,
    compact_total: compact.total,
    compact_offset: compact.offset,
    compact_limit: compact.limit,
    compact_next_offset: compact.nextOffset,
  }
}

/**
 * Formats the catalogue for the parent tool: one compact line per active group. If the
 * page does not hold every group, the footer names the offset that continues it.
 *
 * An empty table always says why it is empty. A bare header used to be what a parent saw
 * when it asked during provider discovery, and a model reading it concluded the tool was
 * broken: it re-planned and never spawned (`models`, `models`, then give up). `rows` is how
 * many model rows the router holds, which separates "still discovering" from "nothing
 * reachable" from "the filters excluded everything".
 *
 * @param {ReturnType<typeof cataloguePayload>} payload
 * @param {{ rows?: number|null }} [context]
 */
export function formatCatalogueText(payload, { rows = null } = {}) {
  const lines = []
  lines.push('SUBAGENT MODELS')
  lines.push('key  provider  intelligence  speed  usage  context_window  in_use')
  lines.push(
    'All groups are free to run; a key named "free" is a model name, not a price. usage means quota headroom, not cost.',
  )
  if (payload.compact_total === 0) {
    if (payload.total_active === 0) {
      const held = Number.isFinite(rows)
        ? `the router holds ${rows} model row${rows === 1 ? '' : 's'}`
        : 'the router holds no comparable rows'
      lines.push(
        `No active model group yet: ${held} and none is marked up. While provider discovery is still running this is expected — call models again in about a minute. This is not a missing tool.`,
      )
    } else {
      lines.push(
        `No active group matches those filters (${payload.total_active} active). Loosen or drop the filters to see the whole set.`,
      )
    }
  }
  for (const row of payload.compact) {
    lines.push(
      `${row.key}  ${row.provider || '—'}  ${row.intelligence || '—'}  ${row.speed || '—'}  ${row.usage || '—'}  ${row.context ?? '—'}  ${row.in_use || '—'}`,
    )
  }
  if (payload.compact_next_offset != null) {
    lines.push(
      `… more active groups: pass offset=${payload.compact_next_offset} (total ${payload.compact_total})`,
    )
  }
  return lines.join('\n')
}

/** @param {any[]} groups @param {string} key */
function closestKeys(groups, key) {
  const normalized = String(key || '').toLowerCase()
  const scored = groups
    .map((group) => {
      const candidate = group.key
      let score = 0
      if (candidate.startsWith(normalized) || normalized.startsWith(candidate)) score = 3
      else if (candidate.includes(normalized) || normalized.includes(candidate)) score = 2
      else {
        const a = new Set(candidate.split(/[^a-z0-9]+/))
        const b = new Set(normalized.split(/[^a-z0-9]+/))
        for (const token of b) if (token && a.has(token)) score += 1
      }
      return { candidate, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
  return scored.slice(0, 3).map((entry) => entry.candidate)
}

/**
 * Resolves a spawn's `model`: a group key, or one of the three tiers. An unknown key is
 * an error naming the closest keys — never a silent substitution.
 * @param {any[]} groups
 * @param {string} requested
 * @param {{ inUseCounts?: Map<string, number>|Record<string, number> }} [options]
 */
export function resolveSpawnGroup(groups, requested, { inUseCounts = new Map() } = {}) {
  const wanted = String(requested || '')
    .trim()
    .toLowerCase()
  if (!wanted) {
    return { group: null, error: 'A model key or a tier (fast, balanced, smart) is required.' }
  }
  const byKey = groups.find((group) => group.key === wanted)
  if (byKey) return { group: byKey, tier: null, error: null }

  const tierSlopes = { fast: 85, balanced: 40, smart: 0 }
  if (wanted in tierSlopes) {
    const slope = tierSlopes[wanted]
    const inUse =
      inUseCounts instanceof Map ? inUseCounts : new Map(Object.entries(inUseCounts || {}))
    const candidates = groups
      .filter((group) => group.intelligence != null && group.speed != null)
      .map((group) => {
        const score = group.intelligence + slope * group.speed
        const busy = Number(inUse.get(group.key) || 0) > 0 || group.inUse > 0
        const risky = ['scarce', 'exhausted'].includes(group.usage)
        return { group, score, busy, risky }
      })
      .sort(
        (a, b) =>
          Number(a.busy) - Number(b.busy) ||
          Number(a.risky) - Number(b.risky) ||
          b.score - a.score ||
          a.group.key.localeCompare(b.group.key),
      )
    if (candidates.length === 0)
      return {
        group: null,
        tier: wanted,
        error: `No measured model can satisfy the ${wanted} tier.`,
      }
    return { group: candidates[0].group, tier: wanted, error: null }
  }

  const suggestions = closestKeys(groups, wanted)
  return {
    group: null,
    error:
      `Unknown model key "${requested}".` +
      (suggestions.length ? ` Closest active keys: ${suggestions.join(', ')}.` : ''),
  }
}

/**
 * The normalized distance on the intelligence/speed plane.
 * @param {any} a @param {any} b
 */
export function modelDistance(a, b) {
  if (!a || !b) return Infinity
  const ai = finite(a.intelligence)
  const bi = finite(b.intelligence)
  const as = finite(a.speed)
  const bs = finite(b.speed)
  if (ai == null || bi == null || as == null || bs == null || as <= 0 || bs <= 0) return Infinity
  const intelligenceTerm = (bi - ai) / 10
  const speedTerm = Math.log2(bs / as) / 1.5
  return Math.sqrt(intelligenceTerm * intelligenceTerm + speedTerm * speedTerm)
}

/**
 * The next group to fall back to.
 * @param {any[]} groups
 * @param {any} target
 * @param {{ policy?: 'nearest'|'strict'|'none' }} [options]
 */
export function nearestModel(groups, target, { policy = 'nearest' } = {}) {
  if (!target || policy === 'none') return null
  const candidates = groups.filter(
    (group) =>
      group.key !== target.key &&
      group.intelligence != null &&
      group.speed != null &&
      group.rows.some(routeEligible),
  )
  const strict = policy === 'strict'
  const floorIntelligence = target.intelligence - 10
  const floorSpeed = target.speed * 0.4
  const passing = candidates.filter((group) => {
    if (strict) return group.intelligence >= target.intelligence
    // "nearest" allows one band down, but never below either numeric floor. A much
    // smarter but unusably slow group (Gemini at 5 u/s beside Ling at 37) is not a
    // fallback for a routine task; a group with no measured speed is left to the pool.
    return group.intelligence >= floorIntelligence && group.speed >= floorSpeed
  })
  if (strict && passing.length === 0) return null
  const pool =
    passing.length > 0
      ? passing
      : candidates.filter((group) => {
          // An all-down or all-slow field still has to fail visibly rather than silently
          // downgrade. When nothing clears the floor, only a same-intelligence-band group may
          // serve as the last resort; otherwise the spawn is refused.
          return group.intelligenceBand === target.intelligenceBand
        })
  if (pool.length === 0) return null
  return (
    pool
      .map((group) => ({
        group,
        sameBand: group.intelligenceBand === target.intelligenceBand,
        distance: modelDistance(target, group),
      }))
      .sort(
        (a, b) =>
          Number(b.sameBand) - Number(a.sameBand) ||
          a.distance - b.distance ||
          b.group.intelligence - a.group.intelligence,
      )[0]?.group || null
  )
}

/** @param {any[]} rows @param {Set<string>} usedProviders */
function sortRoutes(rows, usedProviders = new Set()) {
  return rows
    .filter(routeEligible)
    .map((row) => {
      const band = usageBandFromEvidence({
        knownQuota: row.knownQuota,
        quotaWindows: row.quotaWindows,
        recordedUsage: row.recordedUsage,
        providerRecordedUsage: row.providerRecordedUsage,
        providerUsage: row.providerUsage,
        rateLimit: row.rateLimit,
        quota: row.quota,
        isRateLimited: row.isRateLimited,
      }).band
      return {
        row,
        native: routeToolSupport(row) === 'native' ? 1 : 0,
        providerBusy: usedProviders.has(row.providerKey) ? 1 : 0,
        exhausted: band === 'exhausted' ? 1 : 0,
        speed: computeRowSpeed(row) || 0,
      }
    })
    .sort(
      (a, b) =>
        a.exhausted - b.exhausted ||
        b.native - a.native ||
        a.providerBusy - b.providerBusy ||
        b.speed - a.speed,
    )
    .map((entry) => entry.row)
}

/**
 * The ordered route pool for a spawn. The proxy consumes this list in order, re-filtering
 * each row, so a dead primary lands on the next route without restarting the child.
 *
 * @param {{
 *   groups: any[],
 *   group: any,
 *   provider?: string|null,
 *   fallback?: 'nearest'|'strict'|'none',
 *   usedProviders?: Set<string>|string[],
 * }} input
 */
export function buildSubagentPool({
  groups,
  group,
  provider = null,
  fallback = 'nearest',
  usedProviders = [],
}) {
  if (!group) return { error: 'No model group was selected.', pool: [], rowKey: null }
  const used = usedProviders instanceof Set ? usedProviders : new Set(usedProviders || [])
  const providerKey = provider ? String(provider).trim().toLowerCase() : ''
  let groupRows = group.rows
  if (providerKey)
    groupRows = groupRows.filter(
      (row) => String(row.providerKey || '').toLowerCase() === providerKey,
    )
  const primary = sortRoutes(groupRows, used)[0] || null
  if (!primary) {
    return {
      error: providerKey
        ? `No eligible route for ${group.key} on provider ${providerKey}.`
        : `No eligible route is available for ${group.key}.`,
      pool: [],
      rowKey: null,
    }
  }

  const pool = []
  const push = (row) => {
    if (!row) return
    const key = getRoutingModelKey(row)
    if (!key || pool.some((entry) => entry.key === key)) return
    pool.push({ key, providerKey: row.providerKey, modelId: row.modelId })
  }
  // Same group, then the nearest alternatives. A named provider is an explicit boundary:
  // no alternative group is allowed to substitute for it without the parent's knowledge.
  for (const row of sortRoutes(group.rows, used)) push(row)
  if (!providerKey) {
    const chosen = []
    let current = group
    const policy = fallback === 'strict' ? 'strict' : fallback === 'none' ? 'none' : 'nearest'
    for (let i = 0; i < MAX_POOL_GROUPS; i += 1) {
      const next = nearestModel(groups, current, { policy })
      if (!next || chosen.some((entry) => entry.key === next.key)) break
      chosen.push(next)
      for (const row of sortRoutes(next.rows, used).slice(0, 2)) push(row)
      current = next
    }
  }
  return {
    error: null,
    pool,
    rowKey: getRoutingModelKey(primary),
    groupKey: group.key,
    providerKey: primary.providerKey,
    modelId: primary.modelId,
    policy: fallback === 'strict' || fallback === 'none' ? fallback : 'nearest',
  }
}

export { closestKeys }
