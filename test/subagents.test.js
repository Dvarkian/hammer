// @ts-check
/**
 * The subagent contract, without a browser or a live provider: the catalogue the parent
 * chooses from, the policy that clamps a spawn, the registry that survives a restart, and
 * one real child driven by the same fake Pi the console tests use.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  canControlRecord,
  canMessageRecord,
  canReadRecord,
  minimalStatus,
  normalizeSpawnRequest,
  PI_TOOL_NAMES,
  reportPayload,
} from '../lib/subagents/policy.js'
import { SubagentRegistry, rootIdForConsole } from '../lib/subagents/registry.js'
import { SubagentManager } from '../lib/subagents/manager.js'
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
  assert.throws(
    () =>
      normalizeSpawnRequest({
        principal,
        workspace,
        params: { name: 'x', task: 't', model: 'fast', tools: ['spawn'] },
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
    const spawned = await manager.spawn(principal, {
      name: 'fake-child',
      task: 'Say hello and finish.',
      model: 'fast',
      thinking: 'high',
      tools: ['read', 'web_search', 'web_fetch'],
      background: false,
    })
    assert.equal(spawned.id.startsWith('sa_'), true)
    await waitFor(() => manager.registry.get(spawned.id)?.status !== 'running')
    const record = manager.registry.get(spawned.id)
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
    depth: 1,
    maxDepth: 1,
  })
  assert.match(charter, /Review the diff/)
  assert.match(charter, /final assistant message is your report/)
  assert.match(charter, /instead of answering from memory/)
  assert.ok(!/web access/.test(charter))
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
  assert.match(harness, /hx-cat-list/)
  assert.match(harness, /hx-cat-title/)
  assert.match(harness, /parentSessionFile/)
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
