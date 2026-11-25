import test from 'node:test'
import assert from 'node:assert/strict'

// The OAuth client is configuration, not source: `lib/oauth-clients.js` resolves it from the
// environment or `~/.hammer/oauth-clients.json`, so the suite supplies its own pair.
process.env.GOOGLE_OAUTH_CLIENT_ID ||= 'test-google-client-id'
process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= 'test-google-client-secret'

import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleOAuthUrl,
  createGooglePkcePair,
  parseGoogleQuotaBuckets,
  resolveGoogleModelsProject,
  toGoogleModelRows,
} from '../lib/google-oauth.js'

test('the Google consent URL is the installed-app offline PKCE flow', () => {
  const { verifier, challenge } = createGooglePkcePair()
  assert.ok(verifier.length >= 43)
  assert.notEqual(verifier, challenge)
  const url = new URL(
    buildGoogleOAuthUrl({
      redirectUri: 'http://127.0.0.1:7352/oauth2callback',
      state: 'state-1',
      codeChallenge: challenge,
    }),
  )
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), 'test-google-client-id')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('code_challenge'), challenge)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.match(url.searchParams.get('scope'), /cloud-platform/)
})

test('the consent URL asks only for scopes this client has registered', () => {
  // Google refuses an unregistered scope before the consent screen — the user sees
  // `403 restricted_client: Unregistered scope(s) in the request` and cannot sign in at all.
  // Asking for a Gemini API scope there is therefore a lockout, not an upgrade: Google AI is
  // served by an API key, and this sign-in stays the quota credential.
  const url = new URL(
    buildGoogleOAuthUrl({
      redirectUri: 'http://127.0.0.1:7352/oauth2callback',
      state: 'state-2',
      codeChallenge: 'challenge',
    }),
  )
  const scope = url.searchParams.get('scope') || ''
  assert.match(scope, /cloud-platform/)
  assert.equal(/generative-language/.test(scope), false)
  assert.equal(
    GOOGLE_OAUTH_SCOPES.some((entry) => entry.includes('generative-language')),
    false,
  )
})

test('native Gemini models become chat rows, and non-chat ones are dropped', () => {
  const rows = toGoogleModelRows({
    models: [
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        inputTokenLimit: 1_048_576,
      },
      {
        name: 'models/text-embedding-004',
        displayName: 'Text Embedding 004',
        supportedGenerationMethods: ['embedContent'],
      },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { displayName: 'no name' },
    ],
  })
  assert.deepEqual(
    rows.map((row) => row.modelId),
    ['gemini-2.5-pro', 'gemini-2.5-flash'],
  )
  assert.equal(rows[0].label, 'Gemini 2.5 Pro')
  assert.equal(rows[0].contextLength, 1_048_576)
  assert.equal(rows[1].contextLength, null)
})

function withStubbedFetch(stub, run) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  return run().finally(() => {
    globalThis.fetch = original
  })
}

test('project resolution settles on a project that actually serves the model list', async () => {
  const calls = []
  await withStubbedFetch(
    async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, project: init.headers?.['x-goog-user-project'] || null })
      if (url.includes('cloudresourcemanager')) {
        return new Response(
          JSON.stringify({
            projects: [
              { projectId: 'empty-project', lifecycleState: 'ACTIVE' },
              { projectId: 'serving-project', lifecycleState: 'ACTIVE' },
              { projectId: 'deleted-project', lifecycleState: 'DELETE_REQUESTED' },
            ],
          }),
          { status: 200 },
        )
      }
      if (init.headers?.['x-goog-user-project'] === 'serving-project') {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ error: { code: 403, message: 'The API is not enabled.' } }),
        { status: 403 },
      )
    },
    async () => {
      const resolved = await resolveGoogleModelsProject('token', null)
      assert.equal(resolved.projectId, 'serving-project')
      assert.equal(resolved.error, null)
      assert.deepEqual(
        resolved.models.map((row) => row.modelId),
        ['gemini-2.5-flash'],
      )
    },
  )
  assert.ok(
    calls.some((call) => call.project === 'empty-project'),
    'a project that cannot serve the list is probed and skipped',
  )
})

test('a scope refusal is reported as such, not as an empty account', async () => {
  await withStubbedFetch(
    async (input) => {
      if (String(input).includes('cloudresourcemanager')) {
        return new Response(JSON.stringify({ projects: [{ projectId: 'p1' }] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
              },
            ],
          },
        }),
        { status: 403 },
      )
    },
    async () => {
      const resolved = await resolveGoogleModelsProject('token', null)
      assert.equal(resolved.models.length, 0)
      assert.equal(resolved.error?.code, 'google_scope')
    },
  )
})

test('an account with no project is reported as needing one', async () => {
  await withStubbedFetch(
    async () => new Response(JSON.stringify({ projects: [] }), { status: 200 }),
    async () => {
      const resolved = await resolveGoogleModelsProject('token', null)
      assert.equal(resolved.projectId, null)
      assert.equal(resolved.error?.code, 'google_no_project')
    },
  )
})

test('Code Assist buckets become percent-only quota windows, not invented totals', () => {
  const resetTime = '2026-11-09T00:00:00Z'
  const windows = parseGoogleQuotaBuckets(
    {
      buckets: [
        {
          modelId: 'models/gemini-3-pro-preview',
          remainingFraction: 0.25,
          resetTime,
          tokenType: 'REQUESTS',
        },
        { modelId: 'models/gemini-3-flash', remainingFraction: 1, tokenType: 'REQUESTS' },
        { modelId: 'models/no-fraction' },
        { modelId: 'models/gemini-tokens', remainingFraction: 0.5, tokenType: 'TOKENS' },
      ],
    },
    { email: 'person@example.com', observedAt: 1_700_000_000_000 },
  )

  assert.equal(windows.length, 3)
  const pro = windows.find((window) => window.modelId === 'gemini-3-pro-preview')
  assert.equal(pro.metric, 'requests')
  assert.equal(pro.percentOnly, true)
  assert.equal(pro.usedPercent, 75)
  assert.equal(pro.limit, null)
  assert.equal(pro.remaining, null)
  assert.equal(pro.resetAt, Date.parse(resetTime))
  assert.match(pro.detail, /25% remaining/)
  assert.equal(windows.find((window) => window.modelId === 'gemini-tokens').metric, 'tokens')
  assert.equal(
    windows.some((window) => window.modelId === 'no-fraction'),
    false,
  )
})
