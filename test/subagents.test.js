// @ts-check
/**
 * The subagent contract, without a browser or a live provider: the catalogue the parent
 * chooses from, the policy that clamps a spawn, the registry that survives a restart, and
 * one real child driven by the same fake Pi the console tests use.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildActiveGroups,
  buildSubagentPool,
  cataloguePayload,
  formatCatalogueText,
  nearestModel,
  resolveSpawnGroup,
  speedBandForRate,
} from '../lib/subagents/catalogue.js'
import { aggregateUsageBands, usageBandFromEvidence } from '../lib/subagents/usage-bands.js'
import {
  decorateModelRowsForUsage,
  modelUsageEvidence,
  usageTagLabel,
} from '../lib/subagents/model-usage.js'
import {
  CAPS,
  canControlRecord,
  canMessageRecord,
  canReadRecord,
  minimalStatus,
  normalizeSpawnRequest,
  PI_TOOL_NAMES,
  reportPayload,
} from '../lib/subagents/policy.js'
import { SubagentRegistry, rootIdForConsole } from '../lib/subagents/registry.js'
import { SubagentManager, renderTranscriptRecords } from '../lib/subagents/manager.js'
import { setActiveSubagentManager } from '../lib/subagents/live.js'
import { reportSubagentPick } from '../lib/http/routes/proxy.js'
import { childCharter, materializeSubagentExtension } from '../lib/subagents/extension.js'
import { materializeWebExtension, webExtensionPath } from '../lib/pi/web-tools.js'

const FAKE_PI = fileURLToPath(new URL('./support/fake-pi.mjs', import.meta.url))

async function waitFor(predicate, { timeoutMs = 8_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('timed out waiting for the expected subagent state')
}

function row({
  providerKey = 'p',
  modelId = 'model',
  label = modelId,
  status = 'up',
  aa = 0,
  intell = 0,
  ttft = 1000,
  tps = 50,
  ctx = '128k',
  toolSupport = 'native',
  knownQuota = null,
  quotaWindows = [],
  recordedUsage = {},
  rateLimit = null,
} = {}) {
  return {
    providerKey,
    modelId,
    label,
    status,
    aa,
    intell,
    ttft,
    tps,
    ctx,
    toolSupport,
    knownQuota,
    quotaWindows,
    recordedUsage,
    rateLimit,
    pings: [],
    lastResponse: null,
    ctxSource: null,
  }
}

function parentPrincipal(overrides = {}) {
  return {
    type: 'parent',
    requesterId: 'root',
    parent: true,
    parentId: null,
    rootId: 'root:test',
    depth: 0,
    consoleKey: 'test',
    tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
    grants: { transcripts: true, message: true, spawn: true },
    ...overrides,
  }
}

function childPrincipal(overrides = {}) {
  return {
    type: 'child',
    requesterId: 'sa_child',
    parent: false,
    parentId: null,
    rootId: 'root:test',
    depth: 1,
    consoleKey: 'sub-child',
    tools: ['read', 'grep'],
    grants: { transcripts: false, message: false, spawn: false },
    ...overrides,
  }
}

function nestedFixture(prefix = 'nested') {
  const root = mkdtempSync(join(tmpdir(), `hammer-subagent-${prefix}-`))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  let rootSession = '/tmp/root-session.jsonl'
  class FixtureBridge extends EventEmitter {
    prompts = []
    promptOptions = []
    sessionFile = null
    aborted = 0
    disposed = false
    async start() {}
    async prompt(message, options) {
      this.prompts.push(message)
      this.promptOptions.push(options)
      return { data: { disposition: 'started' } }
    }
    status() {
      return {
        sessionFile: this.sessionFile,
        isStreaming: false,
        isCompacting: false,
        pendingMessages: 0,
      }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      this.aborted += 1
      return {}
    }
    dispose() {
      this.disposed = true
    }
  }
  const bridges = new Map()
  const rootBridge = new FixtureBridge()
  rootBridge.sessionFile = rootSession
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ record }) => {
      const bridge = new FixtureBridge()
      bridge.sessionFile = join(settings.sessions, 'subagents', `${record.id}.jsonl`)
      bridges.set(record.id, bridge)
      return bridge
    },
    parentBridge: () => rootBridge,
  })
  const principal = parentPrincipal({
    sessionFile: rootSession,
    tools: [...PI_TOOL_NAMES],
  })
  return {
    manager,
    principal,
    bridges,
    rootBridge,
    setRootSession(sessionFile) {
      rootSession = sessionFile
      rootBridge.sessionFile = sessionFile
    },
    async spawnAlpha(overrides = {}) {
      const receipt = await manager.spawn(principal, {
        name: 'alpha',
        task: 'Spawn a child of your own.',
        model: 'fast',
        tools: ['read', 'spawn'],
        background: true,
        notify: 'silent',
        ...overrides,
      })
      const record = manager.registry.get(receipt.id)
      return {
        record,
        principal: manager.tokens.verify(manager.childToken(record, record.runs.at(-1))),
      }
    },
    async spawnBeta(alpha, overrides = {}) {
      const receipt = await manager.spawn(alpha.principal, {
        name: 'beta',
        task: 'Return a nested report.',
        model: 'fast',
        tools: ['read'],
        background: true,
        notify: 'silent',
        ...overrides,
      })
      return manager.registry.get(receipt.id)
    },
  }
}

test('usage bands read published allowances, live windows and unlimited providers', () => {
  const unlimited = usageBandFromEvidence({ knownQuota: { unlimited: true } })
  assert.equal(unlimited.band, 'unlimited')

  const scarce = usageBandFromEvidence({
    knownQuota: { limits: [{ metric: 'requests', limit: 500, period: 'day' }] },
    recordedUsage: { requestsToday: 460 },
  })
  // The Router table bands a daily request window on the calls left, not a percentage:
  // forty daily calls is Limited, and only fewer than five is Scarce.
  assert.equal(scarce.band, 'limited')
  assert.match(scarce.reason, /361|left/)

  const exhausted = usageBandFromEvidence({
    quotaWindows: [{ metric: 'requests', period: 'day', limit: 10, remaining: 0 }],
  })
  assert.equal(exhausted.band, 'exhausted')

  const ample = usageBandFromEvidence({
    quotaWindows: [{ metric: 'requests', period: 'minute', limit: 100, remaining: 90 }],
  })
  assert.equal(ample.band, 'ample')

  // An account-scoped allowance is spent by every model on the provider, not only this row.
  const accountScoped = usageBandFromEvidence({
    knownQuota: {
      limitScope: 'account',
      limits: [{ metric: 'tokens', limit: 1_000_000, period: 'month' }],
    },
    recordedUsage: { tokensThisMonth: 526_665 },
    providerRecordedUsage: { tokensThisMonth: 947_000 },
  })
  assert.equal(accountScoped.band, 'scarce')
  assert.match(accountScoped.reason, /53,000|left/)

  assert.equal(speedBandForRate(101), 'Very Fast')
  assert.equal(speedBandForRate(51), 'Fast')
  assert.equal(speedBandForRate(26), 'Normal')
  assert.equal(speedBandForRate(11), 'Slow')
  assert.equal(speedBandForRate(2), 'Very Slow')

  // One spent route does not make the whole group spent while another route carries it.
  const combined = aggregateUsageBands([
    { band: 'exhausted', reason: 'spent', fraction: 0 },
    { band: 'ample', reason: 'room', fraction: 0.9 },
  ])
  assert.equal(combined.band, 'scarce')

  // A silent sibling is not a wall: the Router heading takes the published route's reading.
  const mixed = aggregateUsageBands([
    { band: 'ample', reason: 'room', fraction: 0.9 },
    { band: 'unknown', reason: 'no published limit', fraction: null },
  ])
  assert.equal(mixed.band, 'ample')
  assert.equal(mixed.reason, 'room')
  assert.equal(
    aggregateUsageBands([{ band: 'unknown', reason: 'none', fraction: null }]).band,
    'unknown',
  )
})

test('the catalogue reads the same published allowance, provider report and traffic as the Router table', () => {
  const [decorated] = decorateModelRowsForUsage(
    [row({ providerKey: 'fixture', modelId: 'model' })],
    {
      quotaTable: {
        fixture: { limits: [{ metric: 'requests', limit: 100, period: 'day' }] },
      },
      providerUsageReports: new Map([
        [
          'fixture',
          [
            {
              providerKey: 'fixture',
              metric: 'percent',
              used: 10,
              limit: 100,
              remaining: 90,
              window: 'monthly',
              source: 'fixture-usage-endpoint',
            },
          ],
        ],
      ]),
    },
  )
  assert.equal(decorated.knownQuota.limits[0].limit, 100)
  assert.equal(decorated.providerUsage.remaining, 90)
  assert.equal(decorated.recordedUsage.requestsToday, 0)
  assert.equal(decorated.recordedUsage.tokensToday, 0)

  const evidence = modelUsageEvidence(decorated, {
    quotaTable: {
      fixture: { limits: [{ metric: 'requests', limit: 100, period: 'day' }] },
    },
  })
  assert.equal(evidence.knownQuota.limits[0].period, 'day')
  assert.equal(usageTagLabel('ample'), 'Ample Quota')
  assert.equal(usageTagLabel('unknown'), null)

  const [group] = buildActiveGroups({
    results: [{ ...decorated, aa: 50, intell: 50, status: 'up' }],
  })
  assert.notEqual(group.usage, 'unknown')
  assert.equal(usageTagLabel(group.usage), 'Ample Quota')

  // A provider report can be the only quota evidence, exactly as it is for Codex. The
  // catalogue has to pass that field through rather than reading only the catalog limits.
  const [reported] = buildActiveGroups({
    results: [
      {
        ...row({ providerKey: 'report-only', modelId: 'reported', aa: 50, intell: 50 }),
        providerUsage: {
          metric: 'percent',
          used: 0,
          limit: 100,
          remaining: 100,
          window: 'monthly',
        },
      },
    ],
  })
  assert.equal(reported.usage, 'ample')
  assert.equal(usageTagLabel(reported.usage), 'Ample Quota')
})

test('the catalogue returns every active group in compact form', () => {
  const groups = buildActiveGroups({
    results: [
      row({
        providerKey: 'zeta',
        modelId: 'slow-smart',
        label: 'Slow Smart',
        aa: 51,
        ttft: 5000,
        tps: 5,
        ctx: '262k',
        knownQuota: { limits: [{ metric: 'requests', limit: 100, period: 'day' }] },
      }),
      row({
        providerKey: 'alpha',
        modelId: 'fast-average',
        label: 'Fast Average',
        aa: 28,
        ttft: 500,
        tps: 200,
        ctx: '1m',
        knownQuota: { unlimited: true },
      }),
      row({ providerKey: 'alpha', modelId: 'mid', label: 'Mid', aa: 39, ttft: 2000, tps: 50 }),
      row({ providerKey: 'beta', modelId: 'mid', label: 'Mid', aa: 39, ttft: 2000, tps: 50 }),
      row({ modelId: 'down', label: 'Down', status: 'down', aa: 90 }),
      row({ modelId: 'unrated', label: 'Unrated', aa: 0, intell: 0 }),
    ],
    inUseCounts: { mid: 2 },
  })
  const keys = groups.map((group) => group.key)
  assert.ok(keys.includes('slow-smart'))
  assert.ok(!keys.includes('down'), 'a group with no route that can take a request is omitted')
  assert.ok(!keys.includes('unrated'), 'unrated groups are opt-in')

  const payload = cataloguePayload({ groups })
  assert.equal(payload.view, 'compact')
  assert.deepEqual(payload.detail, [])
  assert.deepEqual(
    payload.compact.map((entry) => entry.key),
    ['slow-smart', 'mid', 'fast-average'],
  )
  assert.equal(payload.compact.length, 3)
  assert.equal(payload.total_active, 3)
  assert.ok(payload.compact.every((entry) => entry.intelligence))
  assert.ok(payload.compact.every((entry) => entry.speed))
  const mid = payload.compact.find((entry) => entry.key === 'mid')
  assert.equal(mid.in_use, 2)
  assert.equal(mid.provider, 'alpha,beta')
  assert.equal(mid.context, '128k')
  assert.equal(payload.compact.find((entry) => entry.key === 'slow-smart').context, '262k')
  assert.equal(payload.compact.find((entry) => entry.key === 'slow-smart').usage, 'Ample Quota')
  assert.equal(payload.compact.find((entry) => entry.key === 'fast-average').context, '1M')
  assert.equal(
    payload.compact.find((entry) => entry.key === 'fast-average').usage,
    'Unlimited Quota',
  )
  assert.doesNotMatch(
    JSON.stringify(payload),
    /Slow Smart|Fast Average/,
    'labels stay out of the catalogue',
  )

  const text = formatCatalogueText(payload)
  assert.ok(
    text.startsWith(
      'SUBAGENT MODELS\nkey  provider  intelligence  speed  usage  context_window  in_use',
    ),
  )
  assert.match(text, /All groups are free to run/)
  assert.match(text, /a key named "free" is a model name, not a price/)
  assert.match(text, /usage means quota headroom, not cost/)
  assert.doesNotMatch(text, /compact groups|intel and speed|ctx = context window/)
  assert.match(text, /slow-smart/)
  assert.match(text, /Very Smart/)
  assert.match(text, /zeta/)
  assert.match(text, /262k/)
  assert.match(text, /Ample Quota/)
  assert.doesNotMatch(text, /tokens\/s|ttft|status/)
})

test('an empty catalogue says why it is empty instead of printing a bare header', () => {
  // This is the transcript that motivated the change: the parent asked for models twice
  // while provider discovery was still marking routes up, saw only headers, concluded the
  // tool was broken, and spent the turn re-planning instead of spawning.
  const duringDiscovery = formatCatalogueText(cataloguePayload({ groups: [] }), { rows: 2270 })
  assert.match(duringDiscovery, /No active model group yet/)
  assert.match(duringDiscovery, /the router holds 2270 model rows/)
  assert.match(duringDiscovery, /call models again in about a minute/)
  assert.match(duringDiscovery, /not a missing tool/)

  const noRows = formatCatalogueText(cataloguePayload({ groups: [] }), { rows: 0 })
  assert.match(noRows, /the router holds 0 model rows/)

  const groups = buildActiveGroups({
    results: [row({ modelId: 'alpha', label: 'Alpha', aa: 50, ttft: 500, tps: 100 })],
  })
  const filteredOut = formatCatalogueText(cataloguePayload({ groups, query: 'zzz' }))
  assert.match(filteredOut, /No active group matches those filters \(1 active\)/)
  assert.match(filteredOut, /Loosen or drop the filters/)
})

test('catalogue filters search the whole active set and pages the compact table', () => {
  const groups = buildActiveGroups({
    results: [
      row({ modelId: 'alpha', label: 'Alpha', aa: 50, ttft: 500, tps: 100 }),
      row({ modelId: 'beta', label: 'Beta', aa: 30, ttft: 500, tps: 100 }),
      row({ modelId: 'gamma', label: 'Gamma', aa: 20, ttft: 500, tps: 100 }),
    ],
  })
  const filtered = cataloguePayload({ groups, query: 'be' })
  assert.deepEqual(
    filtered.compact.map((entry) => entry.key),
    ['beta'],
  )
  const page = cataloguePayload({ groups, limit: 2, offset: 1 })
  assert.equal(page.compact.length, 2)
  assert.equal(page.compact_total, 3)
  assert.equal(page.next_offset, null)
  assert.equal(page.compact_offset, 1)
  assert.deepEqual(page.detail, [])
})

test('catalogue filters treat small numbers as tag floors and reject unknown usage words', () => {
  const groups = buildActiveGroups({
    results: [
      row({ modelId: 'very-dumb', label: 'Very Dumb', aa: 8, ttft: 1000, tps: 100 }),
      row({ modelId: 'average', label: 'Average', aa: 28, ttft: 1000, tps: 100 }),
      row({ modelId: 'very-smart-slow', label: 'Very Smart Slow', aa: 50, ttft: 5000, tps: 5 }),
    ],
  })
  const intelligent = cataloguePayload({ groups, min_intelligence: 3 })
  assert.deepEqual(
    intelligent.compact.map((entry) => entry.key).sort(),
    ['average', 'very-smart-slow'],
    '3 means Average or better, not raw AA >= 3',
  )
  const fastEnough = cataloguePayload({ groups, min_speed: 2 })
  assert.deepEqual(
    fastEnough.compact.map((entry) => entry.key).sort(),
    ['average', 'very-dumb'],
    '2 means Slow or better, not raw speed >= 2',
  )
  assert.throws(
    () => cataloguePayload({ groups, usage: 'reported' }),
    /Unknown usage filter "reported"/,
  )
})

test('tier resolution prefers an unused group, and an explicit key is honored', () => {
  const groups = buildActiveGroups({
    results: [
      row({ modelId: 'smart', label: 'Smart', aa: 55, ttft: 7000, tps: 5 }),
      row({ modelId: 'speedster', label: 'Speedster', aa: 30, ttft: 300, tps: 200 }),
      row({ modelId: 'speedster2', label: 'Speedster Two', aa: 28, ttft: 250, tps: 210 }),
    ],
  })
  const tier = resolveSpawnGroup(groups, 'fast', { inUseCounts: { speedster: 1 } })
  assert.equal(tier.tier, 'fast')
  assert.equal(tier.group.key, 'speedster-two')
  const explicit = resolveSpawnGroup(groups, 'speedster')
  assert.equal(explicit.group.key, 'speedster')
  assert.match(resolveSpawnGroup(groups, 'nope').error, /Closest active keys|Unknown model key/)
})

test('fallback stays on the same group first, then picks a nearest route; strict never gets dumber', () => {
  const groups = buildActiveGroups({
    results: [
      row({ providerKey: 'a', modelId: 'primary', label: 'Primary', aa: 41, ttft: 6000, tps: 40 }),
      row({ providerKey: 'a2', modelId: 'primary', label: 'Primary', aa: 41, ttft: 5000, tps: 45 }),
      row({ providerKey: 'b', modelId: 'near', label: 'Near', aa: 38, ttft: 3000, tps: 70 }),
      row({ providerKey: 'c', modelId: 'dumb', label: 'Dumb', aa: 20, ttft: 300, tps: 200 }),
    ],
  })
  const target = groups.find((group) => group.key === 'primary')
  const pool = buildSubagentPool({ groups, group: target, fallback: 'nearest' })
  assert.equal(pool.error, null)
  assert.ok(pool.pool.slice(0, 2).every((entry) => entry.modelId === 'primary'))
  assert.ok(pool.pool.some((entry) => entry.modelId === 'near'))
  assert.ok(
    !pool.pool.some((entry) => entry.modelId === 'dumb'),
    'a slower/dumber far route is not a fallback',
  )

  const strict = buildSubagentPool({ groups, group: target, fallback: 'strict' })
  assert.ok(!strict.pool.some((entry) => entry.modelId === 'dumb'))
  const nearest = nearestModel(groups, target, { policy: 'strict' })
  assert.equal(nearest, null, 'nothing is smarter than the target on this field')
})

test('a spawn is clamped to the parent, the depth cap and the workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hammer-subagent-policy-'))
  const principal = parentPrincipal()
  const request = normalizeSpawnRequest({
    principal,
    workspace,
    params: { name: 'Audit This', task: 'check', model: 'fast', tools: ['read', 'bash'] },
  })
  assert.equal(request.name, 'audit-this')
  assert.deepEqual(request.tools, ['read', 'bash'])
  assert.equal(request.depth, 1)
  assert.equal(request.limits.maxTurns, 40)

  assert.ok(PI_TOOL_NAMES.includes('web_search'))
  assert.ok(PI_TOOL_NAMES.includes('web_fetch'))
  const webRequest = normalizeSpawnRequest({
    principal: { ...principal, tools: [...PI_TOOL_NAMES] },
    workspace,
    params: { name: 'web', task: 'research', model: 'fast', tools: ['web_search', 'web_fetch'] },
  })
  assert.deepEqual(webRequest.tools, ['web_search', 'web_fetch'])
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: { ...principal, tools: ['read'] },
        workspace,
        params: { name: 'web', task: 'research', model: 'fast', tools: ['web_search'] },
      }),
    /does not have the "web_search" tool/,
  )

  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: { ...principal, tools: ['read'] },
        workspace,
        params: { name: 'x', task: 't', model: 'fast', tools: ['bash'] },
      }),
    /does not have the "bash" tool/,
  )
  const recursive = normalizeSpawnRequest({
    principal,
    workspace,
    params: { name: 'x', task: 't', model: 'fast', tools: ['read', 'spawn'] },
  })
  assert.equal(recursive.depth, 1)
  assert.equal(recursive.grants.spawn, true)
  assert.deepEqual(recursive.tools, ['read'])

  const nestedParent = childPrincipal({
    grants: { transcripts: false, message: false, spawn: true },
    tools: ['read'],
  })
  const nested = normalizeSpawnRequest({
    principal: nestedParent,
    workspace,
    params: { name: 'grandchild', task: 't', model: 'fast', tools: ['read'] },
  })
  assert.equal(nested.depth, 2)
  assert.equal(nested.parentId, 'sa_child')
  assert.equal(nested.grants.spawn, false)
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: nestedParent,
        workspace,
        params: { name: 'x', task: 't', model: 'fast', tools: ['spawn'] },
      }),
    /cannot spawn again/,
  )
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: { ...nestedParent, depth: 2, grants: { spawn: true } },
        workspace,
        params: { name: 'x', task: 't', model: 'fast' },
      }),
    /cannot spawn again/,
  )
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal,
        workspace,
        params: { name: 'x', task: 't', model: 'fast', cwd: '/tmp/outside' },
      }),
    /outside the parent workspace/,
  )

  const child = childPrincipal({ grants: { transcripts: false, message: false, spawn: false } })
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: child,
        workspace,
        params: { name: 'x', task: 't', model: 'fast' },
      }),
    /not allowed|does not hold/,
  )
})

test('spawn accepts model filters, keeps a 500-token budget and rejects unknown usage words', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hammer-subagent-filters-'))
  const request = normalizeSpawnRequest({
    principal: parentPrincipal(),
    workspace,
    params: {
      name: 'filtered',
      task: 'check',
      model: 'fast',
      min_intelligence: 3,
      min_speed: 2,
      min_context: 32000,
      usage: 'ample',
      token_budget: 500,
    },
  })
  assert.deepEqual(request.filters, {
    min_intelligence: 3,
    min_speed: 2,
    min_context: 32000,
    usage: 'ample',
  })
  assert.equal(
    request.limits.tokenBudget,
    500,
    'a requested token budget is not rounded up to 1000',
  )
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal: parentPrincipal(),
        workspace,
        params: { name: 'filtered', task: 'check', model: 'fast', usage: 'reported' },
      }),
    /Unknown usage filter "reported"/,
  )
})

test('target authorization is same-root, parent-controlled and grant-checked', () => {
  const root = parentPrincipal()
  const child = childPrincipal({ grants: { transcripts: true, message: true, spawn: false } })
  const sibling = childPrincipal({ requesterId: 'sa_sibling', consoleKey: 'sub-sibling' })
  const records = new Map([
    ['sa_child', { ...sibling, id: 'sa_child', parentId: null }],
    ['sa_sibling', { ...sibling, id: 'sa_sibling', parentId: null }],
  ])
  assert.equal(canReadRecord(root, records.get('sa_child'), records), true)
  assert.equal(canReadRecord(child, records.get('sa_sibling'), records), true)
  assert.equal(canMessageRecord(child, records.get('sa_sibling'), records), true)
  assert.equal(canControlRecord(child, records.get('sa_sibling'), records), false)
  assert.equal(canControlRecord(root, records.get('sa_child'), records), true)
  assert.equal(
    canReadRecord({ ...child, rootId: 'root:other' }, records.get('sa_child'), records),
    false,
  )
  const noGrants = childPrincipal({ requesterId: 'sa_none', grants: {} })
  assert.equal(canReadRecord(noGrants, records.get('sa_child'), records), false)
  assert.equal(canMessageRecord(noGrants, records.get('sa_child'), records), false)
})

test('the minimal status carries no task, transcript or report text', () => {
  const record = {
    id: 'sa_1',
    name: 'audit',
    rootId: 'root:test',
    parentId: null,
    depth: 1,
    phase: 'busy',
    status: 'running',
    model: { groupId: 'fast', requested: 'fast', rowKey: 'p/m', fallbacks: [] },
    task: 'SECRET TASK',
    instructions: 'SECRET ROLE',
    result: { text: 'SECRET REPORT' },
    tools: ['read'],
    usage: { turns: 2, totalTokens: 10 },
    limits: { maxTurns: 40, timeoutMs: 1000, tokenBudget: 100 },
    thinking: 'high',
    runs: [{ number: 1, sessionFile: '/tmp/session.jsonl' }],
    createdAt: 1,
    startedAt: 2,
    last: { eventAt: 3, tool: 'read', toolStartedAt: 3 },
  }
  const status = minimalStatus(record, 10)
  const serialized = JSON.stringify(status)
  assert.doesNotMatch(serialized, /SECRET/)
  assert.doesNotMatch(serialized, /session\.jsonl/)
  assert.equal(status.queueLength, 0)
  assert.equal(status.thinking, 'high')
  const report = reportPayload(record)
  assert.equal(report.text, 'SECRET REPORT')
  assert.equal(report.model, 'fast')
})

test('a saved child transcript renders its messages, calls and results', () => {
  const transcript = renderTranscriptRecords(
    [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Read the news.' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'toolCall', name: 'web_search', arguments: { query: 'news' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'web_search',
          content: [{ type: 'text', text: 'Headline: something happened.' }],
        },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: '# Final report' }] },
      },
    ],
    8_000,
  )
  assert.match(transcript.text, /user: Read the news\./)
  assert.match(transcript.text, /assistant: Let me search\./)
  assert.match(transcript.text, /tool web_search \{"query":"news"\}/)
  assert.match(transcript.text, /result web_search: Headline: something happened\./)
  assert.match(transcript.text, /assistant: # Final report/)
})

test('the registry persists records atomically and bounds itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-subagent-registry-'))
  const path = join(dir, 'subagents.json')
  const registry = new SubagentRegistry({ path, limit: 2 })
  registry.insert({ id: 'sa_a', name: 'a', rootId: 'r', status: 'completed', createdAt: 1 })
  registry.insert({ id: 'sa_b', name: 'b', rootId: 'r', status: 'completed', createdAt: 2 })
  registry.insert({ id: 'sa_c', name: 'c', rootId: 'r', status: 'completed', createdAt: 3 })
  assert.equal(registry.all().length, 2)
  const again = new SubagentRegistry({ path })
  assert.deepEqual(
    again
      .all()
      .map((record) => record.id)
      .sort(),
    ['sa_b', 'sa_c'],
  )
  assert.equal(rootIdForConsole('7352'), 'root:7352')
  assert.doesNotMatch(readFileSync(path, 'utf8'), /transcript/)
  registry.addNotice('r', 'old report', '/sessions/old.jsonl')
  registry.addNotice('r', 'new report', '/sessions/new.jsonl')
  assert.deepEqual(
    registry.takeNotices('r', '/sessions/new.jsonl').map((notice) => notice.text),
    ['new report'],
  )
  assert.deepEqual(
    registry.takeNotices('r', '/sessions/old.jsonl').map((notice) => notice.text),
    ['old report'],
  )
})

test('a real fake-Pi child runs, reports and can be read back through the manager', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-manager-'))
  const settings = {
    command: FAKE_PI,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  const supervisor = process.env.HAMMER_PI_SUPERVISOR
  const fakeSession = process.env.FAKE_PI_SESSION_FILE
  const fakeLog = join(root, 'fake-pi.log')
  const previousLog = process.env.FAKE_PI_LOG
  process.env.HAMMER_PI_SUPERVISOR = '0'
  process.env.FAKE_PI_SETTLE_DELAY_MS = '30'
  process.env.FAKE_PI_SESSION_FILE = join(settings.sessions, 'subagents', 'fake-child.jsonl')
  process.env.FAKE_PI_LOG = fakeLog
  const principal = parentPrincipal({
    sessionFile: '/tmp/root-session.jsonl',
    tools: [...PI_TOOL_NAMES],
  })
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const spawnParams = {
      name: 'fake-child',
      task: 'Say hello and finish.',
      model: 'fast',
      thinking: 'high',
      tools: ['read', 'web_search', 'web_fetch'],
      background: false,
      request_id: 'call_test_spawn',
    }
    const spawned = await manager.spawn(principal, spawnParams)
    assert.equal(spawned.id.startsWith('sa_'), true)
    await waitFor(() => manager.registry.get(spawned.id)?.status !== 'running')
    const record = manager.registry.get(spawned.id)
    // The request id makes a spawn whose response was lost retry-safe: it returns the same
    // child (and now its report) instead of colliding with the name it already created.
    const replay = await manager.spawn(principal, spawnParams)
    assert.equal(replay.id, spawned.id)
    assert.equal(replay.report?.id, spawned.id)
    assert.match(replay.report?.text || '', /Hello/)
    const parentClaims = manager.tokens.verify(manager.parentTokenValue)
    assert.deepEqual(parentClaims.tools, [...PI_TOOL_NAMES])
    assert.ok(parentClaims.tools.includes('web_search'))
    assert.ok(parentClaims.tools.includes('web_fetch'))
    assert.equal(record.status, 'completed')
    assert.equal(record.thinking, 'high')
    assert.match(record.result.text || '', /Hello/)
    assert.ok(record.runs[0].sessionFile)
    const childWebTool = join(
      settings.agentRoot,
      'subagents',
      spawned.id,
      'agent',
      'extensions',
      'web.ts',
    )
    assert.ok(existsSync(childWebTool), 'a child agent must receive the web extension')
    assert.match(readFileSync(childWebTool, 'utf8'), /name: 'web_search'/)
    const childCharterFile = join(
      settings.agentRoot,
      'subagents',
      spawned.id,
      'agent',
      'APPEND_SYSTEM.md',
    )
    assert.ok(existsSync(childCharterFile), 'a web-only child must receive its charter')
    const childCharterText = readFileSync(childCharterFile, 'utf8')
    assert.match(childCharterText, /web_search, web_fetch/)
    const parentAgent = join(root, 'parent-agent')
    manager.prepareParentAgentDir(parentAgent)
    assert.ok(existsSync(join(parentAgent, 'extensions', 'web.ts')))
    const ui = manager.tokens.verify(manager.uiToken())
    const listed = manager.list(ui).subagents.find((entry) => entry.id === spawned.id)
    assert.ok(Array.isArray(listed.runs), 'the UI list must carry run rows, not only a count')
    assert.ok(listed.runs[0].sessionFile)
    assert.equal(listed.thinking, 'high')
    assert.equal(listed.parentSessionFile, '/tmp/root-session.jsonl')
    const report = manager.status(principal, spawned.id, { includeReport: true })
    assert.equal(report.report.id, spawned.id)
    const transcript = manager.transcript(principal, spawned.id, 8000)
    assert.match(transcript.transcript, /assistant|hello/i)
    const runFile = record.runs[0].sessionFile
    assert.ok(runFile)
    await assert.rejects(
      () => manager.send(principal, spawned.id, 'later', 'followUp'),
      /Unknown message mode/,
    )
    writeFileSync(fakeLog, '')
    await manager.send(principal, spawned.id, 'Correction only.', 'queue')
    await waitFor(() => manager.registry.get(spawned.id)?.status !== 'running')
    const resumedLog = readFileSync(fakeLog, 'utf8')
    assert.match(resumedLog, /Correction only\./)
    assert.doesNotMatch(resumedLog, /Say hello and finish\./)
    const deleted = await manager.delete(principal, spawned.id)
    assert.deepEqual(deleted, { deleted: true, id: spawned.id })
    assert.equal(manager.registry.get(spawned.id), null)
    assert.equal(existsSync(runFile), false)
    assert.equal(existsSync(join(settings.agentRoot, 'subagents', spawned.id)), false)
    await assert.rejects(() =>
      manager.spawn(childPrincipal(), { name: 'x', task: 't', model: 'fast' }),
    )
  } finally {
    manager.dispose()
    if (supervisor === undefined) delete process.env.HAMMER_PI_SUPERVISOR
    else process.env.HAMMER_PI_SUPERVISOR = supervisor
    if (fakeSession === undefined) delete process.env.FAKE_PI_SESSION_FILE
    else process.env.FAKE_PI_SESSION_FILE = fakeSession
    if (previousLog === undefined) delete process.env.FAKE_PI_LOG
    else process.env.FAKE_PI_LOG = previousLog
    delete process.env.FAKE_PI_SETTLE_DELAY_MS
  }
})

test('a child that stops on a planning sentence is asked to continue, then finishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-continue-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class StubBridge extends EventEmitter {
    prompts = []
    async start() {}
    async prompt(message) {
      this.prompts.push(message)
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    dispose() {}
  }
  const bridge = new StubBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => bridge,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'planning-child',
      task: 'Research the news.',
      model: 'fast',
      tools: ['web_search'],
    })
    bridge.emit('event', { type: 'tool_execution_start', toolName: 'web_search' })
    bridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'I have enough. Let me fetch one more article.' }],
      },
    })
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => bridge.prompts.length === 2)
    assert.match(bridge.prompts[1], /Continue the delegated task/)
    assert.equal(manager.registry.get(spawned.id)?.status, 'running')

    bridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: '# Final report\nDone.' }],
      },
    })
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    assert.match(manager.registry.get(spawned.id)?.result?.text || '', /# Final report/)
  } finally {
    manager.dispose()
  }
})

test('a max-turns child gets its first turn, and token usage is recorded before finish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-budget-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class StubBridge extends EventEmitter {
    async start() {}
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    dispose() {}
  }
  const bridge = new StubBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => bridge,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'one-turn-child',
      task: 'Reply with pong.',
      model: 'fast',
      max_turns: 1,
    })
    const record = manager.registry.get(spawned.id)
    assert.equal(record.usage.turns, 0)
    bridge.emit('event', { type: 'agent_start' })
    // Starting a turn does not spend it. Counting here is what made a one-turn child abort
    // its first request before the provider could answer.
    assert.equal(record.usage.turns, 0)
    bridge.emit('usage', { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0 })
    assert.equal(record.usage.totalTokens, 150)
    bridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'pong' }],
        usage: { input: 120, output: 30, totalTokens: 150 },
      },
    })
    bridge.emit('event', { type: 'agent_end' })
    assert.equal(record.usage.turns, 1)
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    assert.equal(manager.registry.get(spawned.id)?.result?.text, 'pong')
    assert.equal(manager.registry.get(spawned.id)?.usage?.totalTokens, 150)
  } finally {
    manager.dispose()
  }
})

test('a console turn on a finished child reopens its record and records the new answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-console-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class ConsoleBridge extends EventEmitter {
    prompts = []
    running = true
    async start() {}
    async prompt(message) {
      this.prompts.push(message)
      return { data: { disposition: 'started' } }
    }
    status() {
      return {
        isStreaming: false,
        isCompacting: false,
        pendingMessages: 0,
        running: this.running,
        sessionFile: '/tmp/child-session.jsonl',
      }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    dispose() {}
  }
  const bridge = new ConsoleBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => bridge,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'console-child',
      task: 'Reply with pong.',
      model: 'fast',
      max_turns: 6,
    })
    // The keeper is the liveness signal: a finished child whose keeper still listens gets a
    // new turn on the same process, while one whose socket refuses a connection is restarted.
    const socketPath = manager.registry.get(spawned.id)?.runs?.at(-1)?.keeperSocket
    assert.ok(socketPath, 'a child records the keeper socket it launched under')
    mkdirSync(join(settings.agentRoot, 'sockets'), { recursive: true })
    const keeper = createServer(() => {})
    await new Promise((resolve) => keeper.listen(socketPath, resolve))
    bridge.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pong' }] },
    })
    bridge.emit('event', { type: 'agent_end' })
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    assert.equal(manager.registry.get(spawned.id)?.result?.text, 'pong')
    assert.equal(manager.registry.get(spawned.id)?.usage?.turns, 1)

    // A turn typed into the child's own console is still a managed turn: before this, the
    // child answered while its record stayed completed with the old report and token count.
    await manager.promptFromConsole(principal, spawned.id, 'Say ping instead.')
    const reopened = manager.registry.get(spawned.id)
    assert.equal(reopened?.status, 'running')
    assert.equal(reopened?.result?.text, null)
    assert.equal(bridge.prompts.at(-1), 'Say ping instead.')

    bridge.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ping' }] },
    })
    bridge.emit('event', { type: 'agent_end' })
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    const after = manager.registry.get(spawned.id)
    assert.equal(after?.result?.text, 'ping')
    assert.equal(after?.usage?.turns, 2)
    // The process was never restarted, so the record keeps its one run.
    assert.equal(after?.runs?.length, 1)
    await new Promise((resolve) => keeper.close(resolve))
    rmSync(socketPath, { force: true })
  } finally {
    manager.dispose()
  }
})

test('a console turn on a child whose process is gone restarts it on its session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-console-restart-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class ConsoleBridge extends EventEmitter {
    prompts = []
    running = true
    async start() {}
    async prompt(message) {
      this.prompts.push(message)
      return { data: { disposition: 'started' } }
    }
    status() {
      return {
        isStreaming: false,
        isCompacting: false,
        pendingMessages: 0,
        running: this.running,
        sessionFile: '/tmp/child-session-2.jsonl',
      }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    dispose() {}
  }
  const bridges = []
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => {
      const bridge = new ConsoleBridge()
      bridges.push(bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'restart-child',
      task: 'Reply with pong.',
      model: 'fast',
      max_turns: 6,
    })
    bridges[0].emit('event', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pong' }] },
    })
    bridges[0].emit('event', { type: 'agent_end' })
    bridges[0].emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    // The keeper has reaped the child: its bridge is still on record but no process is left.
    bridges[0].running = false

    await manager.promptFromConsole(principal, spawned.id, 'Are you still there?')
    assert.equal(bridges.length, 2)
    assert.equal(bridges[1].prompts.at(-1), 'Are you still there?')
    const restarted = manager.registry.get(spawned.id)
    assert.equal(restarted?.status, 'running')
    assert.equal(restarted?.runs?.length, 2)
  } finally {
    manager.dispose()
  }
})

test('wall-clock budgets stop an idle child and stop wins the completion race', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-limits-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class LimitsBridge extends EventEmitter {
    async start() {}
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    status() {
      // A provider that has not sent agent_start yet reports no streaming. The wall-clock
      // budget must still stop it: this is the live failure a 3-second timeout ran 86s on.
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      // A successful abort makes Pi settle. That settle used to write completed before
      // manager.stop could write stopped; the record has to be stopped first.
      this.emit('event', { type: 'agent_settled' })
      return {}
    }
    dispose() {}
  }
  const bridge = new LimitsBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  let created = 0
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => {
      // Launching the first child is slow enough to outlast its budget. The timer must
      // already be counting from spawn, not from the end of bridge creation.
      if (created++ === 0) await new Promise((resolve) => setTimeout(resolve, 6_000))
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const timed = await manager.spawn(principal, {
      name: 'timeout-child',
      task: 'Wait forever.',
      model: 'fast',
      background: true,
      notify: 'silent',
      timeout_ms: 1_000,
      max_turns: 2,
    })
    await waitFor(() => manager.registry.get(timed.id)?.status === 'stopped', {
      timeoutMs: 8_000,
    })
    const timedRecord = manager.registry.get(timed.id)
    assert.match(timedRecord?.result?.error || '', /time or token budget/)
    // It stopped on the first budget tick, not after the six-second launch and another tick.
    assert.ok(Number(timedRecord?.endedAt) - Number(timedRecord?.startedAt) < 7_000)

    const stoppedChild = await manager.spawn(principal, {
      name: 'stop-child',
      task: 'Wait for a stop.',
      model: 'fast',
      background: true,
      notify: 'silent',
      max_turns: 2,
    })
    const stopped = await manager.stop(principal, stoppedChild.id)
    assert.equal(stopped.subagent.status, 'stopped')
    assert.equal(stopped.report.error, 'Stopped by the parent.')
    assert.equal(manager.registry.get(stoppedChild.id)?.status, 'stopped')
  } finally {
    manager.dispose()
  }
})

test('token budgets stop mid-stream and measured over-budget usage cannot settle completed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-token-budget-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class TokenBridge extends EventEmitter {
    aborted = 0
    async start() {}
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      this.aborted += 1
      return {}
    }
    dispose() {}
  }
  const bridges = []
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => {
      const bridge = new TokenBridge()
      bridges.push(bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const streamed = await manager.spawn(principal, {
      name: 'stream-budget',
      task: 'Keep writing.',
      model: 'fast',
      token_budget: 500,
      background: true,
      notify: 'silent',
    })
    const streamRecord = manager.registry.get(streamed.id)
    assert.equal(streamRecord.limits.tokenBudget, 500)
    bridges[0].emit('event', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(2_100) },
    })
    await waitFor(() => manager.registry.get(streamed.id)?.status === 'stopped')
    assert.match(manager.registry.get(streamed.id)?.result?.error || '', /time or token budget/)
    assert.equal(bridges[0].aborted, 1)

    const measured = await manager.spawn(principal, {
      name: 'measured-budget',
      task: 'Answer in one turn.',
      model: 'fast',
      token_budget: 500,
      background: true,
      notify: 'silent',
    })
    bridges[1].emit('usage', {
      inputTokens: 400,
      outputTokens: 600,
      totalTokens: 1_000,
      cost: 0,
    })
    await waitFor(() => manager.registry.get(measured.id)?.status === 'stopped')
    // The old five-second tick lost this race: message_end settled the child completed first.
    bridges[1].emit('event', { type: 'agent_settled' })
    assert.equal(manager.registry.get(measured.id)?.status, 'stopped')
    assert.equal(manager.registry.get(measured.id)?.usage?.totalTokens, 1_000)

    const cleared = await manager.spawn(principal, {
      name: 'cleared-estimate',
      task: 'Keep writing.',
      model: 'fast',
      token_budget: 1_000,
      background: true,
      notify: 'silent',
    })
    bridges[2].emit('event', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(2_400) },
    })
    // 600 estimated on top of 500 measured would cross 1,000 if the estimate were kept after
    // measured usage replaced it. The measured message already includes that text.
    bridges[2].emit('usage', { inputTokens: 300, outputTokens: 200, totalTokens: 500, cost: 0 })
    assert.equal(manager.registry.get(cleared.id)?.status, 'running')
    assert.equal(manager.registry.get(cleared.id)?.streamChars, 0)
    bridges[2].emit('event', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    })
    bridges[2].emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(cleared.id)?.status === 'completed')

    const deferred = await manager.spawn(principal, {
      name: 'deferred-empty',
      task: 'Answer.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    manager.deferFinish(deferred.id)
    await waitFor(() => manager.registry.get(deferred.id)?.status === 'failed')
    assert.match(
      manager.registry.get(deferred.id)?.result?.error || '',
      /finished without a final report/,
    )
  } finally {
    manager.dispose()
  }
})

test('a provider error is a failed child, not an empty completed report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-error-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class ErrorBridge extends EventEmitter {
    async start() {}
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      return {}
    }
    dispose() {}
  }
  const bridge = new ErrorBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => bridge,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'provider-error',
      task: 'Answer.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    bridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '400: the provider refused the request',
        content: [],
      },
    })
    bridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'failed')
    assert.match(manager.registry.get(spawned.id)?.result?.error || '', /provider refused/)
    assert.equal(manager.registry.get(spawned.id)?.result?.text, null)
  } finally {
    manager.dispose()
  }
})

test('live children are not capped per root or per router', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-fanout-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class FanoutBridge extends EventEmitter {
    async start() {}
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      return {}
    }
    dispose() {}
  }
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => new FanoutBridge(),
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    for (let index = 0; index < 9; index += 1) {
      await manager.spawn(principal, {
        name: `fanout-${index}`,
        task: 'Wait.',
        model: 'fast',
        background: true,
        notify: 'silent',
      })
    }
    assert.equal(
      manager.registry.all().filter((record) => record.status === 'running').length,
      9,
      'the old 4-per-root / 8-per-router caps rejected the fifth and ninth children',
    )
    assert.equal('maxLivePerRoot' in CAPS, false)
    assert.equal('maxLiveTotal' in CAPS, false)

    await assert.rejects(
      manager.spawn(principal, {
        name: 'too-smart',
        task: 'Wait.',
        model: 'fast',
        min_intelligence: 5,
        background: true,
        notify: 'silent',
      }),
      /does not meet the requested/,
      'spawn applies the same tag-floor filters as models',
    )
  } finally {
    manager.dispose()
  }
})

test('a child with the spawn grant creates a depth-2 child that reports to its own parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-nested-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class NestedBridge extends EventEmitter {
    prompts = []
    sessionFile = null
    async start() {}
    async prompt(message) {
      this.prompts.push(message)
      return { data: { disposition: 'started' } }
    }
    status() {
      return {
        sessionFile: this.sessionFile,
        isStreaming: false,
        isCompacting: false,
        pendingMessages: 0,
      }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    dispose() {}
  }
  const bridges = new Map()
  const rootBridge = new NestedBridge()
  rootBridge.status = () => ({
    sessionFile: '/tmp/root-session.jsonl',
    isStreaming: false,
    isCompacting: false,
    pendingMessages: 0,
  })
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ record }) => {
      const bridge = new NestedBridge()
      bridge.sessionFile = join(settings.sessions, 'subagents', `${record.id}.jsonl`)
      bridges.set(record.id, bridge)
      return bridge
    },
    parentBridge: () => rootBridge,
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const alphaReceipt = await manager.spawn(principal, {
      name: 'alpha',
      task: 'Spawn a child of your own.',
      model: 'fast',
      tools: ['read', 'spawn'],
      background: true,
      notify: 'silent',
    })
    const alpha = manager.registry.get(alphaReceipt.id)
    assert.equal(alpha.depth, 1)
    assert.equal(alpha.grants.spawn, true)
    const alphaAgentDir = join(settings.agentRoot, 'subagents', alpha.id, 'agent')
    assert.ok(existsSync(join(alphaAgentDir, 'extensions', 'subagent.ts')))
    assert.match(
      readFileSync(join(alphaAgentDir, 'APPEND_SYSTEM.md'), 'utf8'),
      /You may spawn child agents/,
    )

    const alphaToken = manager.childToken(alpha, alpha.runs.at(-1))
    const alphaPrincipal = manager.tokens.verify(alphaToken)
    assert.equal(alphaPrincipal.depth, 1)
    assert.equal(alphaPrincipal.grants.spawn, true)
    const betaReceipt = await manager.spawn(alphaPrincipal, {
      name: 'beta',
      task: 'Return a nested report.',
      model: 'fast',
      tools: ['read'],
      background: true,
      notify: 'auto',
    })
    const beta = manager.registry.get(betaReceipt.id)
    assert.equal(beta.depth, 2)
    assert.equal(beta.parentId, alpha.id)
    assert.equal(beta.grants.spawn, false)
    assert.equal(beta.parent.sessionFile, alpha.runs.at(-1).sessionFile)
    assert.notEqual(beta.parent.sessionFile, '/tmp/root-session.jsonl')
    assert.match(
      readFileSync(
        join(settings.agentRoot, 'subagents', beta.id, 'agent', 'APPEND_SYSTEM.md'),
        'utf8',
      ),
      /cannot spawn further subagents/,
    )

    const alphaBridge = bridges.get(alpha.id)
    const betaBridge = bridges.get(beta.id)
    const before = alphaBridge.prompts.length
    betaBridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Nested report.' }],
      },
    })
    betaBridge.emit('event', { type: 'agent_settled' })
    await waitFor(
      () =>
        manager.registry.get(beta.id)?.status === 'completed' &&
        alphaBridge.prompts.length === before + 1,
    )
    assert.match(alphaBridge.prompts.at(-1), /<subagent-result/)
    assert.match(alphaBridge.prompts.at(-1), /Nested report/)
    assert.equal(rootBridge.prompts.length, 0, 'the root must not receive its grandchild report')
    assert.deepEqual(
      manager
        .list(principal)
        .subagents.map((entry) => entry.id)
        .sort(),
      [alpha.id],
    )
    assert.deepEqual(
      manager.list(alphaPrincipal).subagents.map((entry) => entry.id),
      [beta.id],
    )

    const betaToken = manager.childToken(
      manager.registry.get(beta.id),
      manager.registry.get(beta.id).runs.at(-1),
    )
    const betaPrincipal = manager.tokens.verify(betaToken)
    await assert.rejects(
      () => manager.spawn(betaPrincipal, { name: 'gamma', task: 't', model: 'fast' }),
      /not allowed/,
    )
  } finally {
    manager.dispose()
  }
})

test('a child spawn stays in the child conversation when the root switches sessions', async () => {
  const fixture = nestedFixture('nested-session')
  try {
    const alpha = await fixture.spawnAlpha()
    const alphaSession = alpha.record.runs.at(-1).sessionFile
    assert.ok(alphaSession)
    assert.equal(alpha.record.parent.sessionFile, '/tmp/root-session.jsonl')

    fixture.setRootSession('/tmp/other-root-session.jsonl')
    const beta = await fixture.spawnBeta(alpha)
    assert.equal(beta.parentId, alpha.record.id)
    assert.equal(beta.parent.sessionFile, alphaSession)
    assert.notEqual(beta.parent.sessionFile, '/tmp/other-root-session.jsonl')

    // The root is on another conversation now: it must not see alpha's child, and the
    // child's spawn must not have been stamped with the root's current session.
    assert.deepEqual(fixture.manager.list(fixture.principal).subagents, [])
    assert.deepEqual(
      fixture.manager.list(alpha.principal).subagents.map((entry) => entry.id),
      [beta.id],
    )

    fixture.setRootSession('/tmp/root-session.jsonl')
    assert.deepEqual(
      fixture.manager.list(fixture.principal).subagents.map((entry) => entry.id),
      [alpha.record.id],
    )
  } finally {
    fixture.manager.dispose()
  }
})

test('a spawn belongs to the console whose token asked, not always the main console', async () => {
  const fixture = nestedFixture('parent-console')
  try {
    fixture.manager.attachParent(fixture.rootBridge)
    const instanceBridge = new EventEmitter()
    instanceBridge.status = () => ({
      sessionFile: '/tmp/parallel-session.jsonl',
      isStreaming: false,
      isCompacting: false,
      pendingMessages: 0,
    })
    fixture.manager.attachParentBridge('test-parallel', instanceBridge)
    const env = fixture.manager.parentEnv('test-parallel')
    const principal = fixture.manager.tokens.verify(env.HAMMER_SUBAGENT_TOKEN)
    assert.equal(principal.consoleKey, 'test-parallel')

    const receipt = await fixture.manager.spawn(principal, {
      name: 'parallel-child',
      task: 'Work in the parallel conversation.',
      model: 'fast',
      tools: ['read'],
      background: true,
      notify: 'silent',
    })
    const record = fixture.manager.registry.get(receipt.id)
    assert.equal(record.parent.consoleKey, 'test-parallel')
    assert.equal(record.parent.sessionFile, '/tmp/parallel-session.jsonl')
    const ui = fixture.manager.uiRecords().find((entry) => entry.id === receipt.id)
    assert.equal(ui.parentSessionFile, '/tmp/parallel-session.jsonl')
    assert.equal(ui.parentConsoleKey, 'test-parallel')
  } finally {
    fixture.manager.dispose()
  }
})

test('a parent session learned after spawn is adopted rather than following the open row', async () => {
  const fixture = nestedFixture('parent-backfill')
  try {
    fixture.rootBridge.sessionFile = null
    fixture.manager.attachParent(fixture.rootBridge)
    const principal = fixture.manager.tokens.verify(fixture.manager.parentTokenValue)
    const receipt = await fixture.manager.spawn(principal, {
      name: 'first-turn-child',
      task: 'Start before this conversation has a file.',
      model: 'fast',
      tools: ['read'],
      background: true,
      notify: 'silent',
    })
    assert.equal(fixture.manager.registry.get(receipt.id)?.parent?.sessionFile, null)

    fixture.rootBridge.sessionFile = '/tmp/late-session.jsonl'
    fixture.rootBridge.emit('status', { sessionFile: '/tmp/late-session.jsonl' })
    assert.equal(
      fixture.manager.registry.get(receipt.id)?.parent?.sessionFile,
      '/tmp/late-session.jsonl',
    )
    const ui = fixture.manager.uiRecords().find((entry) => entry.id === receipt.id)
    assert.equal(ui.parentSessionFile, '/tmp/late-session.jsonl')
  } finally {
    fixture.manager.dispose()
  }
})

test('a tree snapshot reuses the display catalogue instead of rebuilding it per child', async () => {
  const fixture = nestedFixture('ui-groups')
  try {
    const alpha = await fixture.spawnAlpha()
    await fixture.spawnBeta(alpha)
    fixture.manager.uiGroupsCache = null
    let builds = 0
    const original = fixture.manager.groups.bind(fixture.manager)
    fixture.manager.groups = () => {
      builds += 1
      return original()
    }
    assert.equal(fixture.manager.uiRecords().length, 2)
    assert.equal(fixture.manager.uiRecords().length, 2)
    assert.equal(builds, 1, 'one catalogue build serves the burst of tree snapshots')
  } finally {
    fixture.manager.dispose()
  }
})

test('a child message into the parent chat is always steered, even while the parent is busy', async () => {
  const fixture = nestedFixture('parent-steer')
  try {
    const alpha = await fixture.spawnAlpha()
    fixture.rootBridge.status = () => ({
      sessionFile: '/tmp/root-session.jsonl',
      isStreaming: true,
      isCompacting: false,
      pendingMessages: 0,
    })

    const steered = await fixture.manager.send(alpha.principal, 'parent', 'child-to-parent-OK')
    assert.equal(steered.mode, 'steer')
    assert.equal(fixture.rootBridge.promptOptions.at(-1), undefined)
    assert.match(fixture.rootBridge.prompts.at(-1), /<agent-message[^>]*mode="steer"/)
    assert.match(fixture.rootBridge.prompts.at(-1), /child-to-parent-OK/)

    // A parent-bound message is never held for the next turn boundary, even when the caller
    // asks for queue: the parent chat receives it as a steer.
    const queued = await fixture.manager.send(alpha.principal, 'parent', 'do-not-queue', 'queue')
    assert.equal(queued.mode, 'steer')
    assert.equal(fixture.rootBridge.promptOptions.at(-1), undefined)
    assert.match(fixture.rootBridge.prompts.at(-1), /<agent-message[^>]*mode="steer"/)
    assert.match(fixture.rootBridge.prompts.at(-1), /do-not-queue/)
  } finally {
    fixture.manager.dispose()
  }
})

test('stopping a parent stops its running grandchild', async () => {
  const fixture = nestedFixture('nested-stop')
  try {
    const alpha = await fixture.spawnAlpha()
    const beta = await fixture.spawnBeta(alpha)
    assert.equal(beta.status, 'running')

    const stopped = await fixture.manager.stop(fixture.principal, alpha.record.id)
    assert.equal(stopped.subagent.status, 'stopped')
    assert.equal(fixture.manager.registry.get(alpha.record.id)?.status, 'stopped')
    assert.equal(fixture.manager.registry.get(beta.id)?.status, 'stopped')
    assert.match(fixture.manager.registry.get(beta.id)?.result?.error || '', /parent was stopped/)
    assert.equal(fixture.bridges.get(beta.id)?.aborted, 1)
  } finally {
    fixture.manager.dispose()
  }
})

test('stopping a completed parent still stops its running grandchild', async () => {
  const fixture = nestedFixture('nested-stop-completed')
  try {
    const alpha = await fixture.spawnAlpha()
    const beta = await fixture.spawnBeta(alpha)
    const alphaBridge = fixture.bridges.get(alpha.record.id)
    alphaBridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Parent finished first.' }],
      },
    })
    alphaBridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => fixture.manager.registry.get(alpha.record.id)?.status === 'completed')
    assert.equal(fixture.manager.registry.get(beta.id)?.status, 'running')

    const stopped = await fixture.manager.stop(fixture.principal, alpha.record.id)
    assert.equal(stopped.subagent.status, 'completed')
    assert.equal(fixture.manager.registry.get(alpha.record.id)?.status, 'completed')
    assert.equal(fixture.manager.registry.get(beta.id)?.status, 'stopped')
    assert.match(fixture.manager.registry.get(beta.id)?.result?.error || '', /parent was stopped/)
    assert.equal(fixture.bridges.get(beta.id)?.aborted, 1)
  } finally {
    fixture.manager.dispose()
  }
})

test('deleting a parent removes its running grandchild and its bridge', async () => {
  const fixture = nestedFixture('nested-delete')
  try {
    const alpha = await fixture.spawnAlpha()
    const beta = await fixture.spawnBeta(alpha)
    const betaBridge = fixture.bridges.get(beta.id)
    const betaAgentDir = join(fixture.manager.agentRoot, 'subagents', beta.id)
    assert.equal(beta.status, 'running')

    const deleted = await fixture.manager.delete(fixture.principal, alpha.record.id)
    assert.deepEqual(deleted, { deleted: true, id: alpha.record.id })
    assert.equal(fixture.manager.registry.get(alpha.record.id), null)
    assert.equal(fixture.manager.registry.get(beta.id), null)
    assert.equal(fixture.manager.bridges.has(beta.id), false)
    assert.equal(betaBridge?.aborted, 1)
    assert.equal(betaBridge?.disposed, true)
    assert.equal(existsSync(betaAgentDir), false)
    const ui = fixture.manager.tokens.verify(fixture.manager.uiToken())
    assert.deepEqual(fixture.manager.list(ui).subagents, [])
  } finally {
    fixture.manager.dispose()
  }
})

test('model-facing subagent reads are scoped to the parent conversation', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-session-scope-'))
  let currentSession = '/sessions/new.jsonl'
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings: { agentRoot: join(root, 'agent'), sessions: join(root, 'sessions'), workspace: root },
    agentRoot: join(root, 'agent'),
    sessionsRoot: join(root, 'sessions'),
    workspace: root,
    parentKey: 'test',
    results: () => [],
    parentBridge: () => ({ status: () => ({ sessionFile: currentSession }) }),
  })
  const record = (id, name, sessionFile) => ({
    id,
    name,
    rootId: 'root:test',
    parentId: null,
    parent: { consoleKey: 'test', sessionFile },
    task: `${name} task`,
    tools: ['read'],
    grants: { transcripts: true, message: true, spawn: false },
    depth: 1,
    model: { requested: 'fast', groupId: 'p/fast', rowKey: 'p/fast', fallbacks: [] },
    thinking: null,
    phase: 'done',
    status: 'completed',
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    runs: [],
    usage: { turns: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    last: { eventAt: 2 },
    result: { text: `${name} report` },
  })
  manager.registry.insert(record('sa_old', 'duck-researcher', '/sessions/old.jsonl'))
  manager.registry.insert(record('sa_new', 'duck-researcher', '/sessions/new.jsonl'))
  manager.registry.insert(record('sa_old_sibling', 'smoke', '/sessions/old.jsonl'))
  const parent = parentPrincipal({ sessionFile: currentSession })
  try {
    assert.deepEqual(
      manager.list(parent).subagents.map((entry) => entry.id),
      ['sa_new'],
    )
    assert.equal(manager.resolveTarget('duck-researcher', parent).id, 'sa_new')
    assert.throws(() => manager.status(parent, 'sa_old'), /another conversation/)
    assert.throws(() => manager.transcript(parent, 'sa_old'), /another conversation/)
    // A name is reusable in a different conversation; the registry still distinguishes them.
    assert.equal(
      manager.registry.findByName('duck-researcher', manager.rootId, currentSession).id,
      'sa_new',
    )
    assert.equal(
      manager.registry.findByName('duck-researcher', manager.rootId, '/sessions/old.jsonl').id,
      'sa_old',
    )
    const child = childPrincipal({
      requesterId: 'sa_new',
      grants: { transcripts: true, message: false, spawn: false },
    })
    assert.deepEqual(
      manager.list(child).subagents.map((entry) => entry.id),
      ['sa_new'],
    )
    // Switching the console back shows the old branch and hides the new one from the model,
    // while the UI token still sees both conversations.
    currentSession = '/sessions/old.jsonl'
    assert.deepEqual(
      manager
        .list(parent)
        .subagents.map((entry) => entry.id)
        .sort(),
      ['sa_old', 'sa_old_sibling'],
    )
    const ui = manager.tokens.verify(manager.uiToken())
    assert.equal(manager.list(ui).subagents.length, 3)
  } finally {
    manager.dispose()
  }
})

test('the child charter is generic and the extension is materialized outside the asar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-subagent-extension-'))
  const path = materializeSubagentExtension(dir)
  const extension = readFileSync(path, 'utf8')
  assert.match(extension, /registerTool/)
  assert.match(extension, /All models are free to run/)
  assert.match(extension, /cost is never a reason to choose a weaker model/)
  assert.match(extension, /steer \| queue/)
  assert.doesNotMatch(extension, /followUp/)
  assert.match(extension, /action === 'delete'/)
  assert.doesNotMatch(extension, /action === 'resume'/)
  assert.match(extension, /separate models avoid sharing a rate limit/)
  const charter = childCharter({
    instructions: 'Review the diff.',
    cwd: '/workspace',
    tools: ['read'],
    grants: { spawn: true },
    depth: 1,
    maxDepth: 2,
  })
  assert.match(charter, /Review the diff/)
  assert.match(charter, /final assistant message is your report/)
  assert.match(charter, /instead of answering from memory/)
  assert.match(charter, /You may spawn child agents/)
  assert.match(
    charter,
    /wait for a write, edit or mkdir result before a later read or bash command/,
  )
  assert.ok(!/web access/.test(charter))
  const terminalCharter = childCharter({
    tools: ['read'],
    grants: { spawn: true },
    depth: 2,
    maxDepth: 2,
  })
  assert.doesNotMatch(terminalCharter, /You may spawn child agents/)
  assert.match(terminalCharter, /cannot spawn further subagents/)
  assert.match(terminalCharter, /do not invent or claim use of a tool you were not given/)
  assert.doesNotMatch(charter, /reviewer|scout|worker persona/i)
  const webCharter = childCharter({ tools: ['read', 'web_fetch'] })
  assert.match(webCharter, /You have web access/)
})

test('the keyless web extension is materialized with both tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-web-extension-'))
  const path = materializeWebExtension(dir)
  assert.equal(path, webExtensionPath(dir))
  const extension = readFileSync(path, 'utf8')
  assert.match(extension, /name: 'web_search'/)
  assert.match(extension, /name: 'web_fetch'/)
  assert.match(extension, /mcp\.exa\.ai\/mcp/)
  assert.match(extension, /web_search_exa/)
  assert.match(extension, /web_fetch_exa/)
  assert.match(extension, /html\.duckduckgo\.com/)
  assert.match(extension, /Local and private network URLs are not allowed/)
  assert.doesNotMatch(extension, /x-api-key|Authorization:\s*Bearer/i)
})

test('the harness paints the subagent tree, child view and result cards', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(harness, /function renderSubagents\(/)
  assert.match(harness, /function renderSubagentChrome\(/)
  assert.match(harness, /data-subagent-open=/)
  assert.match(harness, /data-subagent-stop=/)
  assert.match(harness, /function subagentToolMarkup\(/)
  assert.match(harness, /function subagentModelsMarkup\(/)
  assert.match(harness, /function parseSubagentModelRows\(/)
  assert.match(harness, /SUBAGENT MODELS — detail/)
  assert.match(harness, /function formatCatalogueContext\(/)
  assert.match(harness, /if \(action === 'models' && output\)/)
  assert.match(harness, /function parseSubagentListRows\(/)
  assert.match(harness, /function subagentListMarkup\(/)
  assert.match(harness, /if \(action === 'list' && output\)/)
  assert.match(harness, /hx-sub-table/)
  assert.match(harness, /hx-cat-list/)
  assert.match(harness, /hx-cat-title/)
  // The catalogue header is its title alone; the active-group count and "compact" label
  // crowded the top of the card without telling a reader anything the list did not.
  assert.doesNotMatch(harness, /active group\$\{rows\.length/)
  assert.match(harness, /parentSessionFile/)
  assert.match(harness, /function applySubagents\(/)
  assert.match(harness, /nextRevision < state\.subagentRevision/)
  assert.doesNotMatch(harness, /currentFile === session\.file && record\.rootId/)
  assert.match(harness, /hx-subagent-branch/)
  assert.match(harness, /hx-session-item/)
  assert.match(
    harness,
    /if \(ctx\.subagentId \|\| isSubagentSession\(ctx\.sessionFile\)\) continue/,
  )
  assert.match(harness, /verdict === 'normal' \? 'Normal Speed' : value/)
  assert.match(harness, /hx-cat-meta/)
  assert.match(harness, /hx-cat-ctx/)
  assert.match(harness, /intel-tag intel-\$\{escapeHtml\(cls\)\}/)
  assert.match(harness, /capacity-tag\$\{known \? ` cap-\$\{band\}` : ''\}/)
  assert.match(harness, /<subagent-result\b/i)
  assert.match(harness, /<agent-message\b/i)
  assert.match(harness, /policy only · not a sandbox/)
  assert.match(harness, /function initSubagents\(/)
  assert.match(harness, /async function deleteSubagent\(/)
  assert.match(harness, /method: 'DELETE'/)
  assert.match(harness, /data-subagent-delete/)
  // Opening the child already on screen must not overwrite its own return target.
  assert.match(harness, /if \(!ctx \|\| from\?\.id !== ctx\.id\) state\.subagentReturnId/)
  // The back button falls back to the parent conversation rather than becoming a no-op.
  assert.match(harness, /if \(back\?\.id === current\?\.id\) back = state\.consoles\.get\('main'\)/)

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /id="hx-subagent-tree"/)
  assert.match(html, /id="hx-subagent-strip"/)
  assert.match(html, /id="hx-subagent-strip-thinking"/)
  assert.match(html, /data-subagent-delete/)
  // The child's chosen effort is a read-only tag beside its name; the composer's thinking
  // control is hidden there, so this is the only place the level is stated.
  assert.match(harness, /const thinking = \$\('hx-subagent-strip-thinking'\)/)
  assert.match(harness, /thinking\.textContent = applicable \? `thinking \$\{chosen\}` : ''/)
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  assert.match(css, /\.hx-subagent-strip \.hx-subagent-tag\[hidden\] \{[^}]*display: none/)
  assert.match(css, /\.hx-subagent-strip \.hx-subagent-delete \{/)
  assert.match(css, /\.hx-subagent-row/)
  assert.match(css, /\.hx-subagent-branch \{/)
  assert.match(css, /\.hx-subagent-children \{/)
  assert.match(css, /\.hx-subagent-card/)
  assert.match(css, /\.hx-cat-list \{/)
  assert.match(css, /\.hx-cat-row \{/)
  assert.match(css, /\.hx-cat-meta \{/)
  assert.match(css, /\.hx-cat-title \{/)
  assert.doesNotMatch(css, /\.hx-cat-provider \{[^}]*font-family: var\(--hx-mono\)/)
  assert.match(css, /max-height: min\(420px, 55vh\);/)
})

test('a child that answered with its plan is continued, and a report is not its reasoning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-plan-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  /** @type {Array<{ message: string, options: any }>} */
  const prompts = []
  class CaptureBridge extends EventEmitter {
    async start() {}
    async prompt(message, options) {
      prompts.push({ message, options })
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0, sessionFile: null }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      return {}
    }
    dispose() {}
  }
  const bridges = new Map()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ record }) => {
      const bridge = new CaptureBridge()
      bridges.set(record.id, bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    // A forty-turn child re-sends its context every turn; a 300,000-token ceiling is spent in
    // minutes and killed three research children before they wrote a report.
    assert.equal(manager.limits.tokenBudget, 2_000_000)

    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const planned = await manager.spawn(principal, {
      name: 'plan-only',
      task: 'Research paper roads.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const planBridge = bridges.get(planned.id)
    // The first prompt of a child is an ack from a Pi that is still starting, so it gets more
    // than the twenty-second command timeout that once failed a healthy child outright.
    assert.equal(prompts[0].options.timeoutMs, 90_000)
    planBridge.emit('event', { type: 'agent_start' })
    planBridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'text', text: 'Let me start researching. I will begin with the NSW definition.' },
        ],
      },
    })
    planBridge.emit('event', { type: 'agent_end' })
    planBridge.emit('event', { type: 'agent_settled' })
    assert.equal(manager.registry.get(planned.id)?.status, 'running')
    await waitFor(() => prompts.length === 2)
    assert.match(prompts[1].message, /make that tool call now/)
    // No tool had run, and that used to be an exemption from the continuation check.
    assert.equal(manager.registry.get(planned.id)?.last?.sawTool, undefined)
    assert.equal(manager.registry.get(planned.id)?.status, 'running')

    const reasoning = await manager.spawn(principal, {
      name: 'reasoning-report',
      task: 'Report the findings.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const reportBridge = bridges.get(reasoning.id)
    reportBridge.emit('event', { type: 'agent_start' })
    reportBridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          {
            type: 'text',
            text: ' thinking\nI should search more.\n</think>\n\n# Report\n\nAll done.',
          },
        ],
      },
    })
    reportBridge.emit('event', { type: 'agent_end' })
    reportBridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(reasoning.id)?.status === 'completed')
    assert.equal(manager.registry.get(reasoning.id)?.result?.text, '# Report\n\nAll done.')
  } finally {
    manager.dispose()
  }
})

test('tool-call JSON is not a report, and a failing tool stops being retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-payload-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  /** @type {Array<{ message: string, options: any }>} */
  const prompts = []
  class CaptureBridge extends EventEmitter {
    async start() {}
    async prompt(message, options) {
      prompts.push({ message, options })
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0, sessionFile: null }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      return {}
    }
    dispose() {}
  }
  const bridges = new Map()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ record }) => {
      const bridge = new CaptureBridge()
      bridges.set(record.id, bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'payload-only',
      task: 'Find the page.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const bridge = bridges.get(spawned.id)
    const payload = {
      role: 'assistant',
      stopReason: 'stop',
      content: [
        { type: 'text', text: '{"url":"https://a.example"}\n\n{"url":"https://b.example"}' },
      ],
    }
    const settle = () => {
      bridge.emit('event', { type: 'agent_start' })
      bridge.emit('event', { type: 'message_end', message: payload })
      bridge.emit('event', { type: 'agent_end' })
      bridge.emit('event', { type: 'agent_settled' })
    }
    settle()
    await waitFor(() => prompts.length === 2)
    assert.match(prompts[1].message, /make that tool call now/)
    assert.equal(manager.registry.get(spawned.id)?.status, 'running')
    settle()
    await waitFor(() => prompts.length === 3)
    assert.match(prompts[2].message, /Stop researching now/)
    settle()
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'failed')
    assert.match(manager.registry.get(spawned.id)?.result?.error || '', /tool-call JSON/)

    const failing = await manager.spawn(principal, {
      name: 'failing-tools',
      task: 'Search.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const failingBridge = bridges.get(failing.id)
    const before = prompts.length
    for (let index = 0; index < 4; index += 1) {
      failingBridge.emit('event', {
        type: 'tool_execution_end',
        toolName: 'web_fetch',
        result: 'Web fetch failed. Exa MCP returned 429: rate limit.',
      })
    }
    await waitFor(() => prompts.length === before + 1)
    assert.match(prompts.at(-1).message, /Stop retrying the same tool/)
    // The nudge is sent once, not on every further failure.
    failingBridge.emit('event', {
      type: 'tool_execution_end',
      toolName: 'web_fetch',
      result: 'Web fetch failed. 429 rate limit.',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(prompts.length, before + 1)
  } finally {
    manager.dispose()
  }
})

test('a malformed tool call is retried once instead of killing the child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-json-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  const prompts = []
  class CaptureBridge extends EventEmitter {
    async start() {}
    async prompt(message, options) {
      prompts.push({ message, options })
      return { data: { disposition: 'started' } }
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0, sessionFile: null }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {
      return {}
    }
    dispose() {}
  }
  const bridges = new Map()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ record }) => {
      const bridge = new CaptureBridge()
      bridges.set(record.id, bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'bad-arguments',
      task: 'Search.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const bridge = bridges.get(spawned.id)
    const failTurn = () => {
      bridge.emit('event', { type: 'agent_start' })
      bridge.emit('event', {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            'Unexpected non-whitespace character after JSON at position 380 (line 2 column 1)',
          content: [],
        },
      })
      bridge.emit('event', { type: 'agent_end' })
      bridge.emit('event', { type: 'agent_settled' })
    }
    failTurn()
    await waitFor(() => prompts.length === 2)
    assert.match(prompts[1].message, /not valid JSON/)
    assert.equal(manager.registry.get(spawned.id)?.status, 'running')
    assert.equal(manager.registry.get(spawned.id)?.result?.error, null)

    // A second slip is answered with "stop using tools and write what you have", which is the
    // only thing that salvages a report from a model that cannot format a call.
    failTurn()
    await waitFor(() => prompts.length === 3)
    assert.match(prompts[2].message, /Stop using tools now/)
    assert.equal(manager.registry.get(spawned.id)?.status, 'running')

    // A third is a real failure, and the parent gets the reason.
    failTurn()
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'failed')
    assert.match(manager.registry.get(spawned.id)?.result?.error || '', /non-whitespace character/)

    // A dropped connection mid-turn is retried rather than thrown away: a live child was
    // aborted after 253 seconds with everything it had found.
    const aborted = await manager.spawn(principal, {
      name: 'aborted-turn',
      task: 'Search.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    const abortedBridge = bridges.get(aborted.id)
    const before = prompts.length
    abortedBridge.emit('event', { type: 'agent_start' })
    abortedBridge.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'This operation was aborted',
        content: [],
      },
    })
    abortedBridge.emit('event', { type: 'agent_end' })
    abortedBridge.emit('event', { type: 'agent_settled' })
    await waitFor(() => prompts.length === before + 1)
    assert.match(prompts.at(-1).message, /connection failed mid-turn/)
    assert.equal(manager.registry.get(aborted.id)?.status, 'running')
  } finally {
    manager.dispose()
  }
})

test('a widened pool pick is recorded as the route that served the child', () => {
  // The spawn-time row is a snapshot. When a child outlives it, the proxy widens to the live
  // catalogue rather than 503 — and the record must name that row, or the finished report
  // credits a route the child never reached.
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-widened-route-'))
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings: {
      agentRoot: join(root, 'agent'),
      sessions: join(root, 'sessions'),
      workspace: root,
    },
    agentRoot: join(root, 'agent'),
    sessionsRoot: join(root, 'sessions'),
    workspace: root,
    parentKey: 'test',
    results: () => [],
  })
  try {
    manager.registry.insert({
      id: 'sa_widened',
      name: 'widened',
      rootId: manager.rootId,
      parentId: null,
      status: 'running',
      phase: 'working',
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      model: {
        requested: 'fast',
        groupId: 'fast-group',
        rowKey: 'spent/primary',
        pool: ['spent/primary'],
        selectedKey: null,
        fallbacks: [],
      },
      runs: [{ number: 1, consoleKey: 'sub-widened', sessionFile: '/tmp/child.jsonl' }],
      usage: { turns: 1, inputTokens: 0, outputTokens: 0, totalTokens: 40 },
      result: { text: 'report', reportPath: null, truncated: false, error: null },
    })
    setActiveSubagentManager(manager)

    reportSubagentPick('sub-widened', row({ providerKey: 'live', modelId: 'spare' }), {
      widened: true,
    })
    const record = manager.registry.get('sa_widened')
    const status = minimalStatus(record)
    assert.equal(status.model.selected, 'live/spare')
    assert.equal(status.model.widened, true)
    assert.deepEqual(status.model.fallback, ['live/spare'])
    // The snapshot stays intact: the deviation is recorded, not rewritten.
    assert.equal(record.model.rowKey, 'spent/primary')

    const report = reportPayload(record)
    assert.equal(report.selected, 'live/spare')
    assert.equal(report.widened, true)
    assert.equal(report.model, 'fast-group')
    assert.deepEqual(report.fallback, [
      {
        from: 'spent/primary',
        to: 'live/spare',
        reason: 'pool exhausted; widened to the live catalogue',
      },
    ])

    // A move inside the child's own pool keeps its own reason, so the last-resort widening
    // does not get confused with an ordinary group fallback.
    reportSubagentPick('sub-widened', row({ providerKey: 'live', modelId: 'second' }))
    const fallback = reportPayload(manager.registry.get('sa_widened')).fallback.at(-1)
    assert.equal(fallback.to, 'live/second')
    assert.equal(fallback.reason, 'provider unavailable; pool fallback')
  } finally {
    setActiveSubagentManager(null)
    manager.dispose()
  }
})

test('a resumed child opens its own session instead of starting a blank one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-resume-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class ResumeBridge extends EventEmitter {
    prompts = []
    sessionFile = null
    async start() {}
    async prompt(message) {
      this.prompts.push(message)
      return { data: { disposition: 'started' } }
    }
    status() {
      return {
        sessionFile: this.sessionFile,
        isStreaming: false,
        isCompacting: false,
        pendingMessages: 0,
      }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async abort() {}
    dispose() {}
  }
  const launches = []
  const bridges = []
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async ({ plan }) => {
      launches.push(plan.args.slice())
      const bridge = new ResumeBridge()
      bridges.push(bridge)
      return bridge
    },
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    const principal = parentPrincipal({
      sessionFile: '/tmp/root-session.jsonl',
      tools: [...PI_TOOL_NAMES],
    })
    const spawned = await manager.spawn(principal, {
      name: 'resume-child',
      task: 'Say hello.',
      model: 'fast',
      background: true,
      notify: 'silent',
    })
    assert.ok(!launches[0].includes('--session'), 'a fresh child lets Pi name a new session')
    const childSessions = join(settings.sessions, 'subagents')
    mkdirSync(childSessions, { recursive: true })
    const sessionFile = join(childSessions, `${spawned.id}.jsonl`)
    writeFileSync(sessionFile, '')
    manager.registry.get(spawned.id).runs[0].sessionFile = sessionFile
    bridges[0].emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'hello' }],
      },
    })
    bridges[0].emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')

    // A message to a finished child is the resume path. Pi starts a new session when it is
    // only given --session-dir, so the child's own file has to be named or the follow-up
    // arrives with none of the work it is following up on.
    await manager.send(principal, spawned.id, 'One more thing.', 'queue')
    const resumed = launches.at(-1)
    assert.ok(resumed.includes('--session'), 'the resume names the child session')
    assert.equal(resumed[resumed.indexOf('--session') + 1], sessionFile)
    assert.match(bridges.at(-1).prompts.at(-1), /One more thing/)
    assert.doesNotMatch(
      bridges.at(-1).prompts.at(-1),
      /Say hello\./,
      'a resume does not replay the task first',
    )

    // A session file the user removed cannot be named: Pi would fail or create it blank, so
    // the run starts fresh rather than pretending to resume nothing.
    bridges.at(-1).emit('event', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    })
    bridges.at(-1).emit('event', { type: 'agent_settled' })
    await waitFor(() => manager.registry.get(spawned.id)?.status === 'completed')
    rmSync(sessionFile, { force: true })
    await manager.send(principal, spawned.id, 'Again.', 'queue')
    assert.ok(!launches.at(-1).includes('--session'))
  } finally {
    manager.dispose()
  }
})

test('a reattached child console reports its brief, grants and run file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-subagent-reattach-'))
  const settings = {
    command: process.execPath,
    node: process.execPath,
    agentRoot: join(root, 'agent'),
    sessions: join(root, 'sessions'),
    workspace: root,
    extraArgs: [],
    compaction: {},
  }
  class KeeperBridge extends EventEmitter {
    adopted = 0
    async adoptKeeper() {
      this.adopted += 1
    }
    status() {
      return { isStreaming: false, isCompacting: false, pendingMessages: 0 }
    }
    willContinue() {
      return false
    }
    history() {
      return []
    }
    async prompt() {
      return { data: { disposition: 'started' } }
    }
    dispose() {}
  }
  const bridge = new KeeperBridge()
  const results = [row({ modelId: 'fast', label: 'Fast', aa: 40, ttft: 400, tps: 100 })]
  const manager = new SubagentManager({
    baseUrl: 'http://127.0.0.1:9/v1',
    settings,
    agentRoot: settings.agentRoot,
    sessionsRoot: settings.sessions,
    workspace: root,
    parentKey: 'test',
    results: () => results,
    createBridge: async () => bridge,
    parentBridge: () => ({ status: () => ({ sessionFile: '/tmp/root-session.jsonl' }) }),
  })
  try {
    manager.registry.insert({
      id: 'sa_restored',
      name: 'restored',
      rootId: manager.rootId,
      parentId: null,
      status: 'running',
      phase: 'busy',
      task: 'Audit the schema.',
      instructions: 'Be terse.',
      tools: ['read'],
      grants: { transcripts: false, message: false, spawn: false },
      cwd: root,
      depth: 1,
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      model: { requested: 'fast', groupId: 'fast-group', rowKey: 'a/b', pool: [], fallbacks: [] },
      runs: [{ number: 1, consoleKey: 'sub-restored', sessionFile: '/tmp/child.jsonl' }],
      usage: { turns: 1, inputTokens: 0, outputTokens: 0, totalTokens: 40 },
      result: { text: null, reportPath: null, truncated: false, error: null },
    })
    await manager.restore()
    assert.equal(bridge.adopted, 1)
    const info = bridge.subagentInfo()
    assert.equal(info.task, 'Audit the schema.')
    assert.equal(info.instructions, 'Be terse.')
    assert.deepEqual(info.grants, { transcripts: false, message: false, spawn: false })
    assert.equal(info.runs[0].sessionFile, '/tmp/child.jsonl')
    assert.equal(info.status, 'running')
  } finally {
    manager.dispose()
  }
})
