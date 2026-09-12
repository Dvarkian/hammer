/**
 * @file test/router-harness.test.js
 * @description In-process, behavioral tests for the router's request paths.
 *
 * Most of the existing suite asserts on the *source text* of lib/server.js, which
 * cannot catch anything that only shows up at runtime. This harness boots the real
 * server against a stubbed upstream provider on an ephemeral port, with HOME
 * redirected to a throwaway directory, and drives its HTTP surface so defects like
 * a bulk-retest fan-out targeting the wrong port or a garbage HTTP 200 being
 * counted as a healthy sample are pinned by observable behavior.
 *
 * Run with: node --test test/router-harness.test.js
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sources } from '../sources.js'

// ── Isolate the run before the server module is loaded ──────────────────────
// The router resolves ~/.hammer.json, its usage/log caches and the upstream
// timeouts when it is imported, so redirect HOME and shrink the upstream budget
// first.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'hammer-router-'))
process.env.HOME = HOME_DIR
process.env.USERPROFILE = HOME_DIR
process.env.HAMMER_UPSTREAM_TIMEOUT_MS = '2000'
process.env.HAMMER_UPSTREAM_IDLE_MS = '2000'
process.env.HAMMER_PING_TIMEOUT_MS = '3000'
// A developer shell may have legacy OpenAI-compatible vars exported; they would
// add a phantom endpoint, so drop them.
for (const key of ['OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_MODEL']) {
  delete process.env[key]
}

// Timers the router schedules (ping cycle, log flush, update check) would hold the
// test process open long after the assertions finish. Let them still fire, but stop
// them from keeping the event loop alive; listeners are closed in teardown so the
// process can exit and the runner can flush every individual test result.
const nativeSetTimeout = globalThis.setTimeout
const nativeSetInterval = globalThis.setInterval
globalThis.setTimeout = (...args) => {
  const handle = nativeSetTimeout(...args)
  if (handle && typeof handle.unref === 'function') handle.unref()
  return handle
}
globalThis.setInterval = (...args) => {
  const handle = nativeSetInterval(...args)
  if (handle && typeof handle.unref === 'function') handle.unref()
  return handle
}

// Remember every listener created from here on (the stub, the probe, the router).
const trackedServers = []
const nativeListen = HttpServer.prototype.listen
HttpServer.prototype.listen = function trackedListen(...args) {
  trackedServers.push(this)
  return nativeListen.apply(this, args)
}

const STUB_INSTANCE_KEY = 'openai-compatible:stub'
// The last two entries reuse real catalog ids so they inherit a real intelligence
// score from scores.js (the slope selector needs both speed and intelligence).
const SMART_MODEL = 'z-ai/glm5'                       // highest catalog score
const FAST_MODEL = 'microsoft/phi-3.5-mini-instruct'  // lower score, seeded much faster
const STUB_MODELS = ['stub-alpha', 'stub-beta', 'stub-gamma', 'stub-delta', 'stub-epsilon', 'stub-zeta', SMART_MODEL, FAST_MODEL]
// Seeded with clean test responses to pin the readiness promotion's freshness
// window: one far outside it, one inside. Both are then contradicted by a probe, so
// the only thing that can still mark them up is the readiness promotion itself.
const STALE_READY_MODEL = 'stub-delta'      // clean 12h ago — outside the window
const RECENT_READY_MODEL = 'stub-zeta'      // clean 30m ago — inside the window
// A row whose provider only ever answers with an error envelope (never a manual Test
// assertion, never seeded), so its status is untouched by other tests.
const PROBE_MODEL = 'stub-epsilon'
// The FreeModels catalog row the FreeModels-specific tests drive.
const FREEMODELS_ROW = 'claude-sonnet-5'
const TEST_PROMPT = 'Respond with exactly the single word: Ready'

const OK_COMPLETION = {
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
}
// HTTP 200 with nothing a client can use — the "garbage 200" the router must not
// mistake for proof of health.
const EMPTY_COMPLETION = {
  id: 'chatcmpl-empty',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
}
const OVERLENGTH_ERROR = {
  error: {
    message: "This model's maximum context length is 4096 tokens. However, you requested 16404 tokens (20 in the messages, 16384 in the completion). Please reduce the length of the messages or completion.",
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
  },
}

// mode: 'ok' | 'empty-200' | 'overlength-once' | 'hang' | 'freemodels-503-then-ok'
//     | 'freemodels-error-always' | 'error-envelope-200'
const stubState = { mode: 'ok', chatCalls: [], overlengthFired: false, heldResponses: [], freemodelsErrorsFired: 0 }

function resetStub(mode = 'ok') {
  stubState.mode = mode
  stubState.chatCalls = []
  stubState.overlengthFired = false
  stubState.freemodelsErrorsFired = 0
}

const stubServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: STUB_MODELS.map(id => ({ id, object: 'model', owned_by: 'stub' })) }))
    return
  }
  // The FreeModels worker accepts a chat POST on any path (Hammer points its
  // baseUrl at the worker root), so the stub accepts any path too — restricting
  // this to /v1/chat/completions would make the freemodels row 404 before its SSE
  // guard could ever run.
  if (req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* recorded as an unparsable call */ }
    const stream = body.stream === true
    const messages = Array.isArray(body.messages) ? body.messages : []
    stubState.chatCalls.push({
      model: body.model,
      // FreeModels-style payloads carry the id as `modelId` instead of `model`.
      modelId: body.modelId,
      stream,
      prompt: typeof messages[0]?.content === 'string' ? messages[0].content : null,
      // Credentials as the provider would see them, so a test can prove the probe and
      // the request path send the same thing.
      auth: req.headers.authorization || null,
    })

    if (stubState.mode === 'hang') {
      // Never answer: pins the router's (and the Anthropic facade's) upstream budget.
      stubState.heldResponses.push(res)
      return
    }

    if (stubState.mode === 'freemodels-503-then-ok' && stubState.freemodelsErrorsFired === 0) {
      // The FreeModels failure mode: HTTP 200 whose SSE stream opens with an error
      // frame instead of a completion. Exactly once per test, then healthy.
      stubState.freemodelsErrorsFired += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }

    if (stubState.mode === 'error-envelope-200') {
      // A relay folding a backend fault into a success status: HTTP 200, JSON error
      // envelope, no completion. Must never read as "this model can't chat".
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } }))
      return
    }

    if (stubState.mode === 'freemodels-error-always') {
      // The same overload frame, served to every request: pins how a probe
      // classifies a relay whose backend is (here: persistently) overloaded.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }

    if (stubState.mode === 'overlength-once' && !stubState.overlengthFired) {
      stubState.overlengthFired = true
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(OVERLENGTH_ERROR))
      return
    }

    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const frame = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      // The FreeModels relay reports the real upstream model in every frame; the
      // 'freemodels-503-then-ok' mode carries one so the router's real-name capture
      // can be pinned end to end.
      const firstDelta = stubState.mode === 'freemodels-503-then-ok'
        ? { role: 'assistant', model: 'stub-real-backend' }
        : { role: 'assistant' }
      frame({ choices: [{ index: 0, delta: firstDelta }] })
      if (stubState.mode !== 'empty-200') frame({ choices: [{ index: 0, delta: { content: 'pong' } }] })
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
      res.end('data: [DONE]\n\n')
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(stubState.mode === 'empty-200' ? EMPTY_COMPLETION : OK_COMPLETION))
  })
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

const stubPort = await listen(stubServer)

async function findFreePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise(resolve => probe.close(resolve))
  return port
}

// ── Boot the router ─────────────────────────────────────────────────────────
// Everything except the stub endpoint is excluded, so routing decisions are
// deterministic instead of depending on whatever real providers are configured.
const config = {
  providers: {
    ...Object.fromEntries(Object.keys(sources).map(key => [key, { enabled: false }])),
    [STUB_INSTANCE_KEY]: {
      name: 'Stub',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      enabled: true,
      discoverModels: true,
    },
    // The freemodels provider is left enabled with its baseUrl pointed at the
    // stub — this exercises the resolveProviderUrl override seam and lets the
    // FreeModels SSE guard / retry path be pinned against a local upstream.
    freemodels: { enabled: true, baseUrl: `http://127.0.0.1:${stubPort}` },
    // A g4f relay left enabled with its baseUrl pointed at the stub. Its discovery
    // URL is off-host, so it fails under the harness network guard and the provider
    // falls back to its curated catalog instead of pulling the stub's models — which
    // keeps routing deterministic while exercising the g4f baseUrl-override seam.
    'g4f-groq': { enabled: true, baseUrl: `http://127.0.0.1:${stubPort}` },
  },
  apiKeys: { [STUB_INSTANCE_KEY]: 'stub-key' },
  excludedProviders: Object.keys(sources).filter(key => key !== 'freemodels' && key !== 'g4f-groq'),
  autoUpdate: { enabled: false },
  autoPingEnabled: false,
  persistRequestLogs: false,
}
writeFileSync(join(HOME_DIR, '.hammer.json'), JSON.stringify(config, null, 2))

// Seed usage so two models have known-but-opposite speed/intelligence profiles:
// the smartest row is slow, the fastest row is dumb. That makes the slope-line
// pick observable from the outside (the router must call the stub with the id the
// slope selects), and pins the pick to the same numbers the dashboard plots.
const usageSeed = {
  [`${STUB_INSTANCE_KEY}::${SMART_MODEL}`]: {
    requests: 20, ttftSamples: 20, ttftSum: 20 * 2200, genMsSum: 20 * 1000, completionTokensSum: 20 * 25,
    lastServedAt: Date.now(),
    lastResponse: { ok: true, text: 'Ready', status: 200, at: Date.now(), ttftMs: 2200, tps: 25, expiresAt: null },
  },
  [`${STUB_INSTANCE_KEY}::${FAST_MODEL}`]: {
    requests: 20, ttftSamples: 20, ttftSum: 20 * 120, genMsSum: 20 * 1000, completionTokensSum: 20 * 180,
    lastServedAt: Date.now(),
    lastResponse: { ok: true, text: 'Ready', status: 200, at: Date.now(), ttftMs: 120, tps: 180, expiresAt: null },
  },
  // Clean responses with no speed samples (so they stay out of the slope plot and
  // cannot disturb the routing assertions). Freshness, not just cleanliness, is what
  // may promote a row; these two entries differ only in age.
  [`${STUB_INSTANCE_KEY}::${STALE_READY_MODEL}`]: {
    requests: 3, ttftSamples: 0, genMsSum: 0,
    lastResponse: { ok: true, text: 'Ready', status: 200, at: Date.now() - 12 * 60 * 60_000, expiresAt: null },
  },
  [`${STUB_INSTANCE_KEY}::${RECENT_READY_MODEL}`]: {
    requests: 3, ttftSamples: 0, genMsSum: 0,
    lastResponse: { ok: true, text: 'Ready', status: 200, at: Date.now() - 30 * 60_000, expiresAt: null },
  },
}
writeFileSync(join(HOME_DIR, '.hammer-usage.json'), JSON.stringify(usageSeed, null, 2))

// Import after HOME/timeout redirection so the module-level paths and constants
// pick them up.
const { runServer } = await import('../lib/server.js')
const { loadConfig } = await import('../lib/config.js')
const routerPort = await findFreePort()

// ── Hermetic network ────────────────────────────────────────────────────────
// Only the stub upstream and the router itself may be reached. Every other
// provider in the catalog (~100 rows) answers with a synthetic 502 instead of a
// real call, so the harness neither depends on the developer's network nor
// accidentally promotes a real provider's row to 'up' mid-test.
const allowedHosts = new Set([`127.0.0.1:${stubPort}`, `127.0.0.1:${routerPort}`])
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input))
  let host = null
  try { host = new URL(url).host } catch { /* let the native fetch report it */ }
  if (host && !allowedHosts.has(host)) {
    return Promise.resolve(new Response(JSON.stringify({ error: { message: `harness: blocked outbound request to ${host}` } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  return nativeFetch(input, init)
}

await runServer(loadConfig(), routerPort, false, [], '127.0.0.1')

// What the startup probe wave actually asked the upstream, captured before any test
// resets the stub. A skipAutoPing provider must not appear here.
const startupProbeCalls = stubState.chatCalls.slice()

const baseUrl = `http://127.0.0.1:${routerPort}`

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init.headers,
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON bodies are returned raw */ }
  return { status: response.status, json, text }
}

async function modelById(modelId) {
  const { json } = await api('/api/models')
  return (json?.models || []).find(model => model.modelId === modelId) || null
}

async function freemodelsRows() {
  const { json } = await api('/api/models')
  return (json?.models || []).filter(model => model.providerKey === 'freemodels')
}

async function g4fRows() {
  const { json } = await api('/api/models')
  return (json?.models || []).filter(model => model.providerKey === 'g4f-groq')
}

async function waitForRestest(jobId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let job = null
  while (Date.now() < deadline) {
    const { json } = await api(`/api/restest-status?jobId=${encodeURIComponent(jobId)}`)
    job = json?.job || null
    if (job && ['done', 'partial', 'failed', 'cancelled'].includes(job.status)) return job
    await delay(150)
  }
  throw new Error(`bulk retest did not finish in time: ${JSON.stringify(job)}`)
}

after(async () => {
  // Release anything the stub is holding open, close every listener, and remove
  // the throwaway HOME so the process can exit cleanly.
  for (const res of stubState.heldResponses) {
    try { res.destroy() } catch { /* already gone */ }
  }
  stubState.heldResponses = []
  for (const server of trackedServers) {
    try { server.close() } catch { /* not listening */ }
    try { server.closeAllConnections?.() } catch { /* nothing to release */ }
  }
  try { rmSync(HOME_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('router harness', () => {
  it('routes smartest requests to the slope-selected model and reports the same pick', async () => {
    const setSlope = (slope) => api('/api/selector', {
      method: 'POST',
      body: JSON.stringify({ slope, minSpeed: null, minIntell: null }),
    })
    const routedModel = async () => {
      resetStub('ok')
      const res = await api('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'best', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 200)
      return stubState.chatCalls.at(-1)?.model
    }

    // Slope 0: the line is flat, so the smartest eligible row wins even though the
    // fastest row is ~18x faster.
    await setSlope(0)
    assert.equal(await routedModel(), SMART_MODEL, 'slope 0 must pick the smartest row')
    assert.equal((await api('/api/models')).json?.best, SMART_MODEL, 'the KPI must report the routed pick')

    // A steep slope trades intelligence for speed: the fastest row must win, and the
    // pick the router makes must be the one the dashboard advertises.
    await setSlope(1_000_000)
    assert.equal(await routedModel(), FAST_MODEL, 'a steep slope must pick the fastest row')
    assert.equal((await api('/api/models')).json?.best, FAST_MODEL, 'the KPI must report the routed pick')

    // Leaving a slope behind would skew the routing assertions in the other tests.
    await setSlope(null)

    // With no slope set the selector is inert. The API must say so rather than
    // report slope 0 (Number(null) === 0) and advertise a pick the router is not
    // making — that mismatch was visible on the dashboard, which highlighted and
    // named a model the router would never choose.
    const inert = (await api('/api/models')).json?.selector
    assert.equal(inert?.enabled, false, 'a null slope must leave the selector inert')
    assert.equal(inert?.slope, null, 'a null slope must not be reported as 0')
    assert.equal(inert?.pickedModelId, null, 'an inert selector must not claim a pick')
  })

  it('falls through to the next model when the top pick rejects the prompt as too long', async () => {
    resetStub('overlength-once')

    const { status, json } = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'best', messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(status, 200, `expected a served completion, got ${status}: ${JSON.stringify(json)}`)
    assert.equal(json?.choices?.[0]?.message?.content, 'pong')
    assert.equal(stubState.chatCalls.length, 2, 'the first (over-length) attempt must be retried')
    assert.notEqual(
      stubState.chatCalls[0].model,
      stubState.chatCalls[1].model,
      'the retry must go to a different model, not the one that rejected the prompt',
    )
  })

  it('classifies a ping that answers 200 with no completion as incompatible', async () => {
    const samplesBefore = (await modelById('stub-alpha'))?.pings?.length || 0
    resetStub('empty-200')

    const { status, json } = await api('/api/models/ping', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'stub-alpha' }),
    })

    assert.equal(status, 200)
    assert.equal(json?.model?.status, 'incompatible')
    // The row must not be left looking healthy, and no latency sample may be recorded
    // for a probe that carried nothing.
    const row = await modelById('stub-alpha')
    assert.equal(row?.status, 'incompatible')
    assert.equal(row?.pings?.length || 0, samplesBefore, 'an unusable 200 must not add a latency sample')
  })

  it('does not promote a buffered 200 whose body has no completion', async () => {
    const samplesBefore = (await modelById('stub-beta'))?.pings?.length || 0
    resetStub('empty-200')

    const { status } = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'stub-beta', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })

    // The proxy stays transparent — the client still receives the provider's 200 …
    assert.equal(status, 200)
    // … but the model must not be recorded as a healthy, fast responder.
    const row = await modelById('stub-beta')
    assert.equal(row?.status, 'incompatible')
    assert.equal(row?.pings?.length || 0, samplesBefore, 'an empty 200 must not add a latency sample')
  })

  it('does not promote a streamed 200 that never emits content', async () => {
    const samplesBefore = (await modelById('stub-gamma'))?.pings?.length || 0
    resetStub('empty-200')

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stub-gamma', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text()

    assert.equal(response.status, 200)
    const row = await modelById('stub-gamma')
    assert.equal(row?.status, 'incompatible')
    assert.equal(row?.pings?.length || 0, samplesBefore, 'an empty stream must not add a latency sample')
  })

  it('bulk retest reaches the router on the port it is actually listening on', async () => {
    resetStub('ok')

    const started = await api('/api/restest-models', { method: 'POST' })
    assert.equal(started.status, 200)
    assert.ok(started.json?.jobId, 'a retest job id is returned')

    const job = await waitForRestest(started.json.jobId)
    assert.ok(job.total > 0, 'there is something to retest')
    assert.equal(job.completed, job.total)

    // Regression: the fan-out used to post to process.env.PORT || 3000, so every
    // row failed with a transport error and nothing reached the upstream.
    const transportErrors = job.errors.filter(entry => /fetch failed|ECONNREFUSED|socket hang up|other side closed|terminated/i.test(String(entry.error)))
    assert.deepEqual(transportErrors, [], 'no retest row may fail to reach the router')
    assert.deepEqual(
      job.errors.filter(entry => entry.providerKey === STUB_INSTANCE_KEY),
      [],
      'the configured provider must complete its retest',
    )
    assert.ok(
      stubState.chatCalls.some(call => call.prompt === TEST_PROMPT),
      'the fan-out must actually hit the provider through the router',
    )
  })

  it('honors a requested model on /v1/messages when the router carries it', async () => {
    resetStub('ok')

    const { status, json } = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'stub-beta',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    assert.equal(status, 200)
    assert.equal(json?.content?.[0]?.text, 'pong')
    assert.equal(stubState.chatCalls.length, 1)
    assert.equal(stubState.chatCalls[0].model, 'stub-beta', 'the requested model must reach the provider')
  })

  it('falls back to best-model routing for Anthropic model ids the router does not carry', async () => {
    resetStub('ok')

    const { status, json } = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    assert.equal(status, 200)
    assert.equal(json?.content?.[0]?.text, 'pong')
    assert.ok(STUB_MODELS.includes(stubState.chatCalls[0]?.model), 'an unknown id routes to a real model instead of 404ing')
  })

  it('transparently retries a FreeModels-style 200 SSE error frame onto another model (streaming)', async () => {
    resetStub('freemodels-503-then-ok')

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes('Service temporarily overloaded'), 'the upstream error frame must never reach the client')
    assert.ok(text.includes('"content":"pong"'), 'the client must still receive a real completion')
    // The failing candidate and the serving one must be different rows.
    assert.equal(stubState.chatCalls.length, 2)
    const firstId = stubState.chatCalls[0].modelId || stubState.chatCalls[0].model
    const secondId = stubState.chatCalls[1].modelId || stubState.chatCalls[1].model
    assert.equal(firstId, 'claude-sonnet-5', 'the freemodels row must be attempted first')
    assert.notEqual(secondId, firstId)
  })

  it('transparently retries a FreeModels-style 200 SSE error frame onto another model (non-streaming)', async () => {
    resetStub('freemodels-503-then-ok')

    const { status, json } = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(status, 200)
    assert.equal(json?.choices?.[0]?.message?.content, 'pong')
    assert.equal(stubState.chatCalls.length, 2)
  })

  it('captures the real upstream model name and reports it on /api/models', async () => {
    resetStub('freemodels-503-then-ok')

    // In this stub mode every streamed response carries model: 'stub-real-backend'.
    // Whichever row serves the request must surface that as its real name.
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text()

    const { json } = await api('/api/models')
    const rowsWithReal = (json?.models || []).filter(m => m.realModelId === 'stub-real-backend')
    assert.ok(rowsWithReal.length >= 1, 'the serving row must report the captured real model id')
    assert.equal(rowsWithReal[0].realModelLabel, 'Stub Real Backend')
    assert.ok(rowsWithReal[0].modelId !== 'stub-real-backend', 'the catalog id stays untouched')
  })

  it('does not mark a model incompatible over a FreeModels 200 SSE error frame', async () => {
    resetStub('freemodels-error-always')

    const { status, json } = await api('/api/models/ping', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'claude-sonnet-5' }),
    })

    assert.equal(status, 200)
    // The relay's overload frame is a transient provider fault, not a property of
    // the model. Reading it as a body with "no usable text" would label a healthy
    // model 'incompatible', which is sticky and would drop it out of routing for
    // good after a single overloaded request.
    assert.notEqual(json?.model?.status, 'incompatible', 'an overload frame must not condemn the model')
    const row = await modelById('claude-sonnet-5')
    assert.notEqual(row?.status, 'incompatible')
  })

  it('persists the captured real model name in the usage stats file', async () => {
    resetStub('freemodels-503-then-ok')

    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await first.text()

    // Usage stats (which carry resolvedModelId) are written synchronously, so the
    // persisted file — the thing a restart reloads — must already contain the name.
    const usageRaw = readFileSync(join(HOME_DIR, '.hammer-usage.json'), 'utf8')
    const usage = JSON.parse(usageRaw)
    const captured = Object.values(usage).filter(entry => entry?.resolvedModelId === 'stub-real-backend')
    assert.ok(captured.length >= 1, 'the real model name must survive in persisted usage stats')
  })

  it('bounds its upstream wait on /v1/messages instead of hanging', async () => {
    resetStub('hang')

    const startedAt = Date.now()
    const { status, json } = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'best',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const elapsed = Date.now() - startedAt

    assert.equal(status, 502)
    assert.match(String(json?.error?.message), /timed out/i)
    // The stubbed upstream never answers, and the router's own retry loop would keep
    // the internal hop open for far longer than the facade's headers budget.
    assert.ok(elapsed < 8000, `expected the facade to give up early, waited ${elapsed}ms`)
  })

  // ── One verdict for every probe path ─────────────────────────────────────

  it('leaves every provider credential decision to one rule, so the probe matches the request path', async () => {
    const configPath = join(HOME_DIR, '.hammer.json')
    const baseConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    try {
      // The user brought their own FreeModels key. A probe that omits it asks the
      // provider a different question than chat does, so the two paths can disagree
      // about whether the row is healthy.
      writeFileSync(configPath, JSON.stringify({
        ...baseConfig,
        apiKeys: { ...baseConfig.apiKeys, freemodels: 'user-freemodels-key' },
      }, null, 2))

      resetStub('ok')
      const probe = await api('/api/models/ping', {
        method: 'POST',
        body: JSON.stringify({ modelId: FREEMODELS_ROW }),
      })
      assert.equal(probe.status, 200)
      const probeAuth = stubState.chatCalls.at(-1)?.auth

      resetStub('ok')
      await api('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: FREEMODELS_ROW, messages: [{ role: 'user', content: 'hi' }] }),
      })
      const requestAuth = stubState.chatCalls.at(-1)?.auth

      assert.equal(probeAuth, 'Bearer user-freemodels-key', 'the probe must present the configured key')
      assert.equal(probeAuth, requestAuth, 'the probe and the request path must present the same credentials')
    } finally {
      writeFileSync(configPath, JSON.stringify(baseConfig, null, 2))
    }
  })

  it('does not condemn anything on a background probe sweep of transient overload frames', async () => {
    // The sweep is fired unawaited by the refresh route, exactly like production's
    // periodic probe, so the assertions must wait for it rather than for the response.
    const before = await freemodelsRows()
    assert.ok(before.length > 0, 'the freemodels rows exist')
    const upBefore = new Set(before.filter(r => r.status === 'up').map(r => r.modelId))

    resetStub('freemodels-error-always')
    const { status } = await api('/api/providers/freemodels/refresh', { method: 'POST' })
    assert.equal(status, 200)

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && stubState.chatCalls.length < before.length) await delay(50)
    assert.ok(
      stubState.chatCalls.length >= before.length,
      `the sweep must probe every freemodels row (saw ${stubState.chatCalls.length} of ${before.length})`,
    )
    // The stub records a call the moment it arrives, but the probe's verdict is
    // applied after the response is read. Poll until the rows stop changing so the
    // assertions observe the sweep's outcome instead of racing it.
    let previous = null
    while (Date.now() < deadline) {
      const snapshot = (await freemodelsRows()).map(r => `${r.modelId}:${r.status}`).join(',')
      if (snapshot === previous) break
      previous = snapshot
      await delay(250)
    }

    const after = await freemodelsRows()
    assert.deepEqual(
      after.filter(r => r.status === 'incompatible').map(r => r.modelId), [],
      'a transient overload frame must never become a permanent verdict on the model',
    )
    // The status can be legitimately promoted back to 'up' by a recent clean
    // response, so the recorded verdict is the field that actually proves whether the
    // sweep classified the frame as the model's fault. A row that recently served has
    // nothing to learn from a transient overload, so the message must not be stored.
    assert.deepEqual(
      after.filter(r => r.lastError?.message === 'Service temporarily overloaded').map(r => r.modelId), [],
      'a transient overload frame must not be recorded as a row verdict',
    )
    assert.deepEqual(
      after.filter(r => r.status === 'up' && !upBefore.has(r.modelId)).map(r => r.modelId), [],
      'a probe that returned no completion must not be recorded as healthy',
    )
  })

  it('routes a 200 provider error envelope through the failure path instead of condemning the model', async () => {
    resetStub('error-envelope-200')

    const { status, json } = await api('/api/test-model', {
      method: 'POST',
      body: JSON.stringify({ providerKey: STUB_INSTANCE_KEY, modelId: PROBE_MODEL }),
    })

    assert.equal(status, 200)
    assert.equal(json?.ok, false, 'a provider error envelope is not a passing test')
    assert.match(String(json?.error), /overloaded/i, 'the upstream message must be surfaced')
    const row = await modelById(PROBE_MODEL)
    assert.notEqual(row?.status, 'incompatible', 'a transient provider fault is not a property of the model')
  })

  it('promotes from a clean response only while it is fresh enough to trust', async () => {
    // Two rows differ only in how old their clean test response is. Both are then
    // contradicted by a probe, so the readiness promotion is the only thing that
    // could still call them up. Twelve hours is outside the window the probe's own
    // hysteresis trusts; thirty minutes is inside it.
    resetStub('empty-200')
    for (const modelId of [STALE_READY_MODEL, RECENT_READY_MODEL]) {
      const { status } = await api('/api/models/ping', {
        method: 'POST',
        body: JSON.stringify({ modelId }),
      })
      assert.equal(status, 200)
    }

    // Both probes returned a body with no completion, so both rows were condemned.
    // Only the row whose clean response is still inside the freshness window may be
    // resurrected; the stale one must stay condemned and out of routing.
    const stale = await modelById(STALE_READY_MODEL)
    assert.equal(stale?.status, 'incompatible', 'a stale success must not keep a condemned row up')
    assert.equal(stale?.routingEligible, false, 'and the router must not consider it up')

    const recent = await modelById(RECENT_READY_MODEL)
    assert.equal(recent?.status, 'up', 'a success inside the window is still authoritative')
    assert.equal(recent?.routingEligible, true, 'and the router may use it')
  })

  // ── Which model actually answered ───────────────────────────────────────

  it('reports the serving model and flags a substituted request', async () => {
    // The requested model answers with a retryable fault, so the router serves a
    // different one — the caller must be able to tell that it was not honored.
    resetStub('freemodels-503-then-ok')
    const substituted = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FREEMODELS_ROW, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await substituted.text()
    assert.equal(substituted.status, 200)
    assert.equal(substituted.headers.get('x-hammer-substituted'), '1', 'the substitution must be flagged')
    const served = substituted.headers.get('x-hammer-model')
    assert.ok(served && served !== FREEMODELS_ROW, `expected a substitute model, got ${served}`)
    assert.equal(
      served,
      stubState.chatCalls.at(-1)?.model || stubState.chatCalls.at(-1)?.modelId,
      'the reported model must be the one the provider was actually asked for',
    )
    // The provider must be one that actually offers the model that served: the router
    // can fail over to any row, so the header has to be checked against the catalog
    // rather than a hardcoded expectation.
    const { json } = await api('/api/models')
    const providersForServed = new Set(
      (json?.models || []).filter(m => m.modelId === served).map(m => m.providerKey),
    )
    assert.ok(
      providersForServed.has(substituted.headers.get('x-hammer-provider')),
      `reported provider ${substituted.headers.get('x-hammer-provider')} does not offer ${served}`,
    )
  })

  it('reports the requested model unchanged when nothing was substituted', async () => {
    resetStub('ok')
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SMART_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text()

    assert.equal(response.headers.get('x-hammer-model'), SMART_MODEL)
    assert.equal(response.headers.get('x-hammer-provider'), STUB_INSTANCE_KEY)
    assert.equal(response.headers.get('x-hammer-substituted'), '0')
  })

  it('routes a g4f relay keylessly, sending no Authorization header', async () => {
    resetStub('ok')
    const G4F_MODEL = 'qwen/qwen3.6-27b'

    const { status, json } = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: G4F_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(status, 200)
    assert.equal(json?.choices?.[0]?.message?.content, 'pong')
    const call = stubState.chatCalls.find(c => c.model === G4F_MODEL)
    assert.ok(call, 'the g4f relay row must be the one that served the request')
    assert.equal(call.auth, null, 'a keyless g4f relay must be called without an Authorization header')
  })

  it('exposes the g4f relay catalog without requiring an API key', async () => {
    const rows = await g4fRows()
    assert.ok(rows.length > 0, 'the g4f relay must expose its catalog')
    const ids = new Set(rows.map(model => model.modelId))
    assert.ok(ids.has('qwen/qwen3.6-27b'), 'the curated fallback catalog must be present')
  })

  it('keeps skipAutoPing relays out of the startup probe wave', async () => {
    const g4fCatalogIds = sources['g4f-groq'].models.map(([id]) => id)
    // FreeModels-style payloads carry the id as `modelId`; the OpenAI-shaped relays
    // carry it as `model`.
    const probedModels = startupProbeCalls.map(call => call.model || call.modelId)
    // Control: freemodels is enabled and keyless but NOT skipAutoPing, so the
    // startup wave must have probed it. That proves the assertion below can fail.
    assert.ok(probedModels.includes(FREEMODELS_ROW), 'control: freemodels is probed at startup')
    for (const id of g4fCatalogIds) {
      assert.ok(!probedModels.includes(id), `skipAutoPing relay must not be probed at startup: ${id}`)
    }
  })
})
