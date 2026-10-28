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
import { registerKiroOAuthRoutes } from '../lib/http/routes/oauth-kiro.js'
import { registerDevinOAuthRoutes } from '../lib/http/routes/oauth-devin.js'

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

/** Kiro's flow engines are stubs here: the point is the HTTP contract around them. */
function makeKiroDeps(overrides = {}) {
  return {
    providerKey: 'kiro',
    browserAuthProviders: new Set(['google', 'github']),
    normalizeSecretValue: (value) => (typeof value === 'string' ? value.trim() : ''),
    ensureProviderConfig: (config, key) => {
      config.providers[key] = config.providers[key] || {}
      return config.providers[key]
    },
    clearAuthMetadata: () => {},
    clearTokenCaches: () => {},
    triggerImmediateProviderPing: () => {},
    extractRefreshTokenFromAwsCache: () => null,
    extractEmailFromAccessToken: () => 'dev@example.test',
    startDeviceAuth: async () => ({
      clientId: 'client-id',
      clientSecret: 'client-secret-that-must-not-leak',
      deviceCode: 'device-code-that-must-not-leak',
      userCode: 'KIRO-CODE',
      verificationUri: 'https://example.test/kiro',
      expiresIn: 600,
      interval: 5,
    }),
    pollDeviceToken: async () => ({ success: false, pending: true }),
    startSocialAuth: (provider) => ({ flowId: `flow-${provider}`, authorizeUrl: 'https://x.test' }),
    exchangeSocialAuth: async () => ({
      refreshToken: 'rt',
      accessToken: 'at',
      profileArn: 'arn:aws:codewhisperer:profile',
    }),
    ...overrides,
  }
}

function makeDevinDeps(overrides = {}) {
  return {
    providerKey: 'devin',
    normalizeSecretValue: (value) => (typeof value === 'string' ? value.trim() : ''),
    normalizeToken: (token) => `normalized:${token}`,
    clearAuthCaches: () => {},
    triggerImmediateProviderPing: () => {},
    startFlow: async () => ({ flowId: 'flow-1', authorizeUrl: 'https://example.test/devin' }),
    getFlowStatus: (flowId) => ({ flowId, status: 'pending' }),
    exchangeFlow: async () => ({}),
    cancelFlow: () => true,
    ...overrides,
  }
}

test('kiro device-code hands back a flow id and no client secret', async () => {
  await withApp(registerKiroOAuthRoutes, makeKiroDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/kiro/device-code`)
    assert.equal(res.status, 200)
    const raw = await res.text()
    const body = JSON.parse(raw)
    assert.ok(body.flowId)
    assert.equal(body.userCode, 'KIRO-CODE')
    assert.notEqual(body.flowId, 'device-code-that-must-not-leak')
    assert.ok(!raw.includes('client-secret-that-must-not-leak'), 'client secret stays server-side')
    assert.ok(!raw.includes('device-code-that-must-not-leak'), 'device code stays server-side')
  })
})

test('kiro poll requires and validates a flow id', async () => {
  await withApp(registerKiroOAuthRoutes, makeKiroDeps(), async (base) => {
    const missing = await fetch(`${base}/api/oauth/kiro/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
    assert.equal((await missing.json()).error, 'flowId is required.')

    const unknown = await fetch(`${base}/api/oauth/kiro/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'nope' }),
    })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /Unknown or expired flow/)
  })
})

test('kiro social-authorize rejects a provider it does not support', async () => {
  await withApp(registerKiroOAuthRoutes, makeKiroDeps(), async (base) => {
    const bad = await fetch(`${base}/api/oauth/kiro/social-authorize?provider=facebook`)
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /Invalid provider/)

    const good = await fetch(`${base}/api/oauth/kiro/social-authorize?provider=github`)
    assert.equal(good.status, 200)
    assert.equal((await good.json()).flowId, 'flow-github')
  })
})

test('kiro social-exchange requires both code and flow id', async () => {
  await withApp(registerKiroOAuthRoutes, makeKiroDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/kiro/social-exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', code: 'c' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'code and flowId are required.')
  })
})

test('kiro auto-import reports a missing AWS cache without touching config', async () => {
  await withApp(registerKiroOAuthRoutes, makeKiroDeps(), async (base) => {
    const res = await fetch(`${base}/api/oauth/kiro/auto-import`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.found, false)
    assert.ok(body.error.includes('~/.aws/sso/cache'), 'names the cache path it looked in')
  })
})

test('devin authorize forwards a token persister to the flow engine', async () => {
  let onToken
  await withApp(
    registerDevinOAuthRoutes,
    makeDevinDeps({
      startFlow: async (options) => {
        onToken = options.onToken
        return { flowId: 'flow-9', authorizeUrl: 'https://example.test/devin' }
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/oauth/devin/authorize`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), {
        flowId: 'flow-9',
        authorizeUrl: 'https://example.test/devin',
      })
    },
  )
  assert.equal(typeof onToken, 'function')
})

test('devin status and cancel require a flow id', async () => {
  await withApp(registerDevinOAuthRoutes, makeDevinDeps(), async (base) => {
    const status = await fetch(`${base}/api/oauth/devin/status`)
    assert.equal(status.status, 400)
    assert.equal((await status.json()).error, 'flowId is required.')

    const cancel = await fetch(`${base}/api/oauth/devin/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(cancel.status, 400)
    assert.equal((await cancel.json()).error, 'flowId is required.')
  })
})

test('devin exchange passes flow id, code and state straight to the engine', async () => {
  const calls = []
  await withApp(
    registerDevinOAuthRoutes,
    makeDevinDeps({
      exchangeFlow: async (flowId, code, state, options) => {
        calls.push({ flowId, code, state, hasOnToken: typeof options.onToken === 'function' })
        return {}
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/oauth/devin/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowId: 'f1', code: 'auth-code', state: 'st' }),
      })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { success: true })
    },
  )
  assert.deepEqual(calls, [{ flowId: 'f1', code: 'auth-code', state: 'st', hasOnToken: true }])
})
