// @ts-check
/**
 * The device-flow routes used to be unreachable from a test: they were closed
 * over inside `runServer`, so exercising one meant booting the whole router and
 * its discovery pass. These tests mount just the route module on a bare Express
 * app with stub dependencies, which is the point of the extraction — a route's
 * behaviour can be checked in milliseconds without a listener on 7352, a config
 * file, or a network call to GitHub/OpenAI.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerCopilotOAuthRoutes } from '../lib/http/routes/oauth-copilot.js'
import { registerCodexOAuthRoutes } from '../lib/http/routes/oauth-codex.js'

/** Stubs that record calls; any unexpected dependency use fails loudly. */
function makeDeps(overrides = {}) {
  return {
    providerKey: 'test-provider',
    deviceFlowExpiryMs: 15 * 60_000,
    normalizeSecretValue: (value) => (typeof value === 'string' ? value.trim() : ''),
    ensureProviderConfig: (config, key) => {
      config.providers[key] = config.providers[key] || {}
      return config.providers[key]
    },
    clearAuthCaches: () => {},
    triggerImmediateProviderPing: () => {},
    applyProviderSignOut: () => ({ removed: 0, remaining: 0 }),
    startDeviceAuth: async () => ({
      deviceCode: 'device-code-that-must-not-leak',
      deviceAuthId: 'device-auth-id',
      userCode: 'USER-CODE',
      verificationUri: 'https://example.test/device',
      expiresIn: 900,
      interval: 5,
    }),
    pollDeviceToken: async () => ({ success: false, pending: true }),
    fetchLogin: async () => ({ login: 'octocat' }),
    exchangeAuthorizationCode: async () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      idToken: null,
    }),
    ...overrides,
  }
}

async function withApp(register, deps, run) {
  const app = express()
  app.use(express.json())
  register(app, deps)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('copilot device-code hands the browser an opaque flow id, not the device code', async () => {
  await withApp(registerCopilotOAuthRoutes, makeDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/github-copilot/device-code`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.flowId, 'a flowId is issued')
    assert.notEqual(body.flowId, 'device-code-that-must-not-leak')
    assert.equal(body.userCode, 'USER-CODE')
    assert.equal(body.verificationUriComplete, undefined)
  })
})

test('copilot poll rejects a missing flow id before doing any work', async () => {
  await withApp(registerCopilotOAuthRoutes, makeDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/github-copilot/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'flowId is required.')
  })
})

test('copilot poll refuses a flow id it never issued', async () => {
  await withApp(registerCopilotOAuthRoutes, makeDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/github-copilot/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'not-a-real-flow' }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /Unknown or expired flow/)
  })
})

test('codex device-code reports the flow expiry the client should count down', async () => {
  await withApp(registerCodexOAuthRoutes, makeDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/openai-codex/device-code`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.flowId)
    assert.equal(body.expiresIn, 900)
    assert.equal(body.userCode, 'USER-CODE')
  })
})

test('codex poll refuses a flow id it never issued', async () => {
  await withApp(registerCodexOAuthRoutes, makeDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/openai-codex/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'not-a-real-flow' }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /Unknown or expired flow/)
  })
})

test('codex disconnect with no body signs the whole pool out', async () => {
  const calls = []
  await withApp(
    registerCodexOAuthRoutes,
    makeDeps({
      applyProviderSignOut: (config, key, identifier) => {
        calls.push({ key, identifier })
        return { removed: 2, remaining: 0 }
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/oauth/openai-codex/disconnect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { success: true, removed: 2, remaining: 0 })
    },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, 'test-provider')
  // No account was named, so the sign-out applies to the whole pool.
  assert.ok(!calls[0].identifier)
})
