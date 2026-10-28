// @ts-check
/**
 * The three route modules extracted from the composer in the /v1 pass.
 *
 * Each is mounted on a bare Express app with a stub seed, which is the point of
 * the extraction: the model table, the provider roster and the /v1 surface can
 * be exercised without booting the router, reading a config file, or reaching a
 * provider. The streaming path is verified against a real server separately
 * (see the pull request), because it depends on the upstream fetch it is a
 * proxy for and stubbing that here would test the stub.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerModelRoutes } from '../lib/http/routes/models.js'
import { registerProviderRoutes } from '../lib/http/routes/providers.js'
import { registerProxyRoutes } from '../lib/http/routes/proxy.js'

async function withApp(register, ctx, run) {
  const app = express()
  app.use(express.json())
  register(app, ctx)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** The seed fields /api/models destructures; every one must exist at registration. */
function modelContext(overrides = {}) {
  let results = []
  return {
    providerUsagePending: () => false,
    kickProviderUsageRefresh: () => {},
    applyUsageDerivedMetrics: () => {},
    effectiveSelectorSettings: () => ({}),
    fallbackDisplayRow: (row) => row,
    getLastServedAt: () => 0,
    getPinnedModelCandidate: () => null,
    pinnedSelectionPayload: () => ({}),
    providerHealth: new Map(),
    providerUsageErrors: new Map(),
    providerUsageFetchedAt: 0,
    providerUsageReports: new Map(),
    usageStats: new Map(),
    lastProxyError: null,
    pinnedSelection: null,
    fallbackSelection: null,
    get results() {
      return results
    },
    set results(value) {
      results = value
    },
    ...overrides,
  }
}

function providerContext(overrides = {}) {
  return {
    OPENAI_COMPATIBLE_PROVIDER_KEY: 'openai-compatible',
    buildProviderConfigEntry: (config, key) => ({ key, name: key, enabled: true }),
    describeSyncError: () => 'error',
    discoverPendingProviderModels: async () => [],
    kickProviderUsageRefresh: () => {},
    modelDiscoveryOutcomes: new Map(),
    pingModel: async () => ({}),
    providerUsagePending: () => false,
    refreshOpenAICompatibleModels: async () => [],
    refreshProviderModelsForApi: async () => [],
    triggerImmediateProviderPing: () => {},
    results: [],
    ...overrides,
  }
}

function proxyContext(overrides = {}) {
  return {
    ANTHROPIC_STOP_REASONS: {},
    AnthropicRelayStream: class {},
    anthropicBlockText: () => '',
    anthropicToOpenAIBody: (body) => body,
    captureProxyRateLimit: () => {},
    readRateLimitHeaders: () => ({}),
    saveUsageStats: () => {},
    scheduleLogSave: () => {},
    results: [],
    usageStats: new Map(),
    ...overrides,
  }
}

test('the model table reads results through the live seed, not a snapshot', async () => {
  let reads = 0
  const ctx = modelContext({
    get results() {
      reads++
      return []
    },
    set results(_value) {},
  })
  await withApp(registerModelRoutes, ctx, async (base) => {
    const res = await fetch(`${base}/api/models`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.models), 'the payload carries a models array')
    assert.equal(body.usagePending, false)
    assert.equal(body.proxyError, null)
  })
  assert.ok(reads > 0, 'the handler must read ctx.results when it runs')
})

test('the model table does not wait on the usage refresh it kicks off', async () => {
  let kicked = 0
  const ctx = modelContext({
    providerUsagePending: () => true,
    kickProviderUsageRefresh: () => {
      kicked++
    },
  })
  await withApp(registerModelRoutes, ctx, async (base) => {
    const res = await fetch(`${base}/api/models`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).usagePending, true)
  })
  assert.equal(kicked, 1, 'an outstanding refresh is started, not awaited')
})

test('the provider roster is served as a list of provider cards', async () => {
  await withApp(registerProviderRoutes, providerContext(), async (base) => {
    const res = await fetch(`${base}/api/config`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body))
    assert.ok(body.length > 0, 'the roster covers the known providers')
    assert.ok(body.every((entry) => typeof entry.key === 'string'))
  })
})

test('creating an endpoint without a name or id is refused before touching config', async () => {
  await withApp(registerProviderRoutes, providerContext(), async (base) => {
    const res = await fetch(`${base}/api/openai-compatible/endpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://example.test/v1' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'name or id is required.')
  })
})

test('discover-pending reports how many candidates it found', async () => {
  const ctx = providerContext({ discoverPendingProviderModels: async () => ['a', 'b'] })
  await withApp(registerProviderRoutes, ctx, async (base) => {
    const res = await fetch(`${base}/api/providers/discover-pending`, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { success: true, candidates: 2, providers: ['a', 'b'] })
  })
})

test('the /v1 model list always offers the router alias first', async () => {
  await withApp(registerProxyRoutes, proxyContext(), async (base) => {
    const res = await fetch(`${base}/v1/models`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    assert.equal(body.data[0].id, 'best')
    assert.equal(body.data[0].owned_by, 'router')
  })
})

test('count_tokens estimates from the characters it is given', async () => {
  await withApp(registerProxyRoutes, proxyContext(), async (base) => {
    const empty = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.deepEqual(await empty.json(), { input_tokens: 1 })

    const text = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(41) }] }),
    })
    // 41 characters is ceil(41/4) = 11 estimated tokens.
    assert.deepEqual(await text.json(), { input_tokens: 11 })
  })
})
