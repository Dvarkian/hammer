import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ANTIGRAVITY_CALLBACK_HOST,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_KEY,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_USER_AGENT,
  antigravityAccountOrder,
  antigravityQuotaModelAliases,
  fetchAntigravityQuotaPayload,
  antigravityModelProfile,
  buildAntigravityAuthUrl,
  readAntigravityEvents,
  startAntigravityShim,
  toAntigravityRequest,
  toOpenAiDeltas,
} from '../lib/google-antigravity.js'
import {
  captureAntigravitySignatures,
  THOUGHT_SIGNATURE_SENTINEL,
} from '../lib/google-antigravity.js'
import { registerAntigravityOAuthRoutes } from '../lib/http/routes/oauth-antigravity.js'
import {
  addOrUpdateProviderAccount,
  getProviderAccounts,
  removeProviderAccount,
} from '../lib/config.js'
import { getProvider } from '../lib/providers/index.js'
import { oauthAccountProviders } from '../lib/providers/registry.js'
import { validateDescriptor } from '../lib/providers/schema.js'

test('the consent URL asks for the grant Antigravity registers', () => {
  const url = new URL(
    buildAntigravityAuthUrl({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      state: 'flow-1',
      codeChallenge: 'challenge-1',
    }),
  )
  assert.equal(url.searchParams.get('client_id'), ANTIGRAVITY_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), ANTIGRAVITY_REDIRECT_URI)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  const scopes = url.searchParams.get('scope').split(' ')
  assert.deepEqual(scopes, ANTIGRAVITY_SCOPES)
  // The scope that locks the Gemini CLI client out must never be requested here either.
  assert.equal(
    scopes.some((scope) => scope.includes('generative-language')),
    false,
  )
  assert.ok(scopes.includes('https://www.googleapis.com/auth/aicode'))
})

test("the callback is the one Antigravity registered, not Hammer's own port", () => {
  assert.equal(ANTIGRAVITY_REDIRECT_URI, 'http://127.0.0.1:51121/oauth-callback')
  assert.equal(ANTIGRAVITY_ENDPOINTS[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.match(ANTIGRAVITY_USER_AGENT, /^antigravity\/hub\/[\d.]+ \(aidev_client;/)
})

test('the roster carries a wire profile for every row', () => {
  assert.ok(ANTIGRAVITY_MODELS.length >= 5)
  for (const model of ANTIGRAVITY_MODELS) {
    assert.ok(model.modelId, 'every row names a wire id')
    assert.ok(model.maxOutputTokens > 0, `${model.modelId} states an output cap`)
    assert.equal(antigravityModelProfile(`models/${model.modelId}`).modelId, model.modelId)
  }
  assert.equal(antigravityModelProfile('not-a-model'), null)
})

test('an OpenAI body becomes a Code Assist envelope', () => {
  const envelope = toAntigravityRequest(
    {
      model: 'gemini-3.8-flash-medium',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
      max_tokens: 999999,
      temperature: 0.4,
    },
    { projectId: 'aicode-consumers', modelId: 'gemini-3.8-flash-medium', sessionId: 'sess-1' },
  )
  assert.equal(envelope.project, 'aicode-consumers')
  assert.equal(envelope.model, 'gemini-3.8-flash-medium')
  assert.equal(envelope.userAgent, 'antigravity')
  assert.equal(envelope.request.sessionId, 'sess-1')
  assert.deepEqual(envelope.request.systemInstruction, { parts: [{ text: 'be brief' }] })
  assert.deepEqual(
    envelope.request.contents.map((entry) => entry.role),
    ['user', 'model', 'user'],
  )
  // The cap is the model's, not the caller's: 999999 would be refused outright.
  assert.equal(envelope.request.generationConfig.maxOutputTokens, 65536)
  assert.equal(envelope.request.generationConfig.temperature, 0.4)
})

test("tools are declared in Gemini's casing", () => {
  const envelope = toAntigravityRequest(
    {
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up the weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    },
    { projectId: 'p', modelId: 'gemini-3-flash-agent' },
  )
  const declaration = envelope.request.tools[0].functionDeclarations[0]
  assert.equal(declaration.name, 'get_weather')
  assert.equal(declaration.parameters.type, 'OBJECT')
  assert.equal(declaration.parameters.properties.city.type, 'STRING')
})

test('streamed frames become OpenAI chunks with usage and a finish reason', () => {
  const deltas = toOpenAiDeltas(
    {
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
      },
    },
    { id: 'chatcmpl-1', model: 'gemini-3-flash-agent', created: 1 },
  )
  assert.equal(deltas[0].choices[0].delta.content, 'ok')
  assert.equal(deltas[1].choices[0].finish_reason, 'stop')
  assert.equal(deltas[2].usage.total_tokens, 5)
})

test('a tool call frame becomes an OpenAI tool_call delta', () => {
  const deltas = toOpenAiDeltas(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Hobart' } } }],
            },
          },
        ],
      },
    },
    { id: 'chatcmpl-2', model: 'gemini-3-flash-agent', created: 1 },
  )
  const call = deltas[0].choices[0].delta.tool_calls[0]
  assert.equal(call.function.name, 'get_weather')
  assert.ok(call.id, 'a call needs an id the caller can replay')
  assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Hobart' })
  // `stop` would tell an OpenAI client the turn is finished, so it would never send the result.
  assert.equal(deltas.at(-1).choices[0].finish_reason, 'tool_calls')
})

test('tool call ids survive both directions, so Claude can answer a tool result', () => {
  // Claude models are validated as Anthropic messages behind this backend: a result without its
  // `tool_use.id` is refused with `messages.N.content.0.tool_use.id: Field required`.
  const envelope = toAntigravityRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Hobart"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_abc', content: '18C' },
      ],
    },
    { projectId: 'p', modelId: 'claude-sonnet-4-6' },
  )
  assert.equal(envelope.request.contents[1].parts[0].functionCall.id, 'call_abc')
  assert.equal(envelope.request.contents[2].parts[0].functionResponse.id, 'call_abc')

  const deltas = toOpenAiDeltas(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'toolu_01', name: 'get_weather', args: { city: 'Hobart' } } },
              ],
            },
          },
        ],
      },
    },
    { id: 'chatcmpl-3', model: 'claude-sonnet-4-6', created: 1 },
  )
  assert.equal(deltas[0].choices[0].delta.tool_calls[0].id, 'toolu_01')
})

test('the SSE reader skips malformed frames instead of inventing an answer', async () => {
  const response = new Response(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"}]}}]}}\n\n' +
      'data: {not json}\n\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"b"}]}}]}}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
  const texts = []
  for await (const event of readAntigravityEvents(response)) {
    texts.push(event.response.candidates[0].content.parts[0].text)
  }
  assert.deepEqual(texts, ['a', 'b'])
})

test('the shim reports a missing credential as 401, not an empty answer', async () => {
  const shim = startAntigravityShim({
    resolveCredential: async () => {
      throw new Error('not signed in')
    },
  })
  const url = await shim.ensure()
  try {
    const models = await fetch(`${url}/v1/models`)
    assert.equal(models.status, 200)
    const list = await models.json()
    assert.equal(list.data.length, ANTIGRAVITY_MODELS.length)

    const chat = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3-flash-agent', messages: [] }),
    })
    assert.equal(chat.status, 401)
    const body = await chat.json()
    assert.match(body.error.message, /not signed in/)

    // Dispatch joins the override with the configured provider URL, so the shim is reached on
    // other paths too (the source path, or the host root). A strict `/v1/...` check answered
    // 404 after the model was already chosen — reproduced live before this was widened.
    const sourcePath = await fetch(`${url}/v1internal:streamGenerateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3-flash-agent', messages: [] }),
    })
    assert.equal(sourcePath.status, 401)
    await sourcePath.body?.cancel()

    const root = await fetch(`${url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3-flash-agent', messages: [] }),
    })
    assert.equal(root.status, 401)
    await root.body?.cancel()

    const unknown = await fetch(`${url}/v1/embeddings`, { method: 'POST', body: '{}' })
    assert.equal(unknown.status, 404)
    assert.match((await unknown.json()).error.message, /Not found: POST \/v1\/embeddings/)
  } finally {
    shim.close()
  }
})

test('a sign-in is a credential, so the account pool has to know the provider', () => {
  // Regression: the account pool is derived from descriptors whose `auth.kind` is `oauth`. The
  // key was missing from the catalog, so a completed sign-in was invisible — `getProviderAccounts`
  // returned [] and the card reported hasKey/canServe false with 0 models.
  const descriptor = getProvider(ANTIGRAVITY_PROVIDER_KEY)
  assert.ok(descriptor, 'google-antigravity must be registered')
  assert.equal(descriptor.auth.kind, 'oauth')
  assert.deepEqual(validateDescriptor(descriptor), [])
  assert.equal(oauthAccountProviders().has(ANTIGRAVITY_PROVIDER_KEY), true)

  const config = { providers: { [ANTIGRAVITY_PROVIDER_KEY]: { accounts: [] } } }
  addOrUpdateProviderAccount(config, ANTIGRAVITY_PROVIDER_KEY, {
    secret: '1//refresh-token',
    email: 'someone@example.com',
  })
  assert.equal(getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY).length, 1)
})

test('two Google accounts are two pool entries, and one can go without the other', () => {
  const config = { providers: { [ANTIGRAVITY_PROVIDER_KEY]: { accounts: [] } } }
  addOrUpdateProviderAccount(config, ANTIGRAVITY_PROVIDER_KEY, {
    secret: '1//one',
    email: 'one@example.com',
    projectId: 'project-one',
  })
  addOrUpdateProviderAccount(config, ANTIGRAVITY_PROVIDER_KEY, {
    secret: '1//two',
    email: 'two@example.com',
    projectId: 'project-two',
  })
  // Distinct accounts are appended rather than merged: the pool is the list of sign-ins.
  assert.equal(getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY).length, 2)
  assert.equal(removeProviderAccount(config, ANTIGRAVITY_PROVIDER_KEY, 'one@example.com'), true)
  assert.deepEqual(
    getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY).map((account) => account.email),
    ['two@example.com'],
  )
})

test('the account order rotates and wraps, so every sign-in is spent', () => {
  assert.deepEqual(antigravityAccountOrder(1, 0), [0])
  assert.deepEqual(antigravityAccountOrder(3, 0), [0, 1, 2])
  assert.deepEqual(antigravityAccountOrder(3, 1), [1, 2, 0])
  assert.deepEqual(antigravityAccountOrder(3, 2), [2, 0, 1])
  assert.deepEqual(antigravityAccountOrder(0, 0), [])
})

function sseAnswer(text) {
  return new Response(
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

test('the shim rotates accounts and fails over inside a request', async () => {
  const seen = []
  const shim = startAntigravityShim({
    accountCount: async () => 2,
    resolveCredential: async (index) => ({
      accessToken: `token-${index}`,
      projectId: `project-${index}`,
    }),
    openStream: async ({ accessToken, envelope }) => {
      seen.push({ accessToken, project: envelope.project })
      if (accessToken === 'token-0') {
        const error = new Error('Antigravity stream failed (HTTP 429): RESOURCE_EXHAUSTED')
        ;/** @type {any} */ (error).status = 429
        throw error
      }
      return sseAnswer('ok')
    },
  })
  const url = await shim.ensure()
  const ask = () =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })
  try {
    const first = await ask()
    assert.equal(first.status, 200)
    assert.equal((await first.json()).choices[0].message.content, 'ok')
    // The turn starts on account 0, is refused for quota, and account 1 answers it with its own
    // project rather than the first account's.
    assert.deepEqual(seen, [
      { accessToken: 'token-0', project: 'project-0' },
      { accessToken: 'token-1', project: 'project-1' },
    ])
    seen.length = 0
    const second = await ask()
    assert.equal(second.status, 200)
    await second.body?.cancel()
    // The cursor advanced, so the next turn starts where the last one finished.
    assert.deepEqual(seen, [{ accessToken: 'token-1', project: 'project-1' }])
  } finally {
    shim.close()
  }
})

test('a rejected request is not replayed against every account', async () => {
  const seen = []
  const shim = startAntigravityShim({
    accountCount: async () => 2,
    resolveCredential: async (index) => ({ accessToken: `token-${index}`, projectId: 'p' }),
    openStream: async ({ accessToken }) => {
      seen.push(accessToken)
      const error = new Error(
        'Antigravity stream failed (HTTP 400): messages.1.content.0.tool_use.id: Field required',
      )
      ;/** @type {any} */ (error).status = 400
      throw error
    },
  })
  const url = await shim.ensure()
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [], stream: false }),
    })
    // A 400 is the request, not the allowance: replaying it on the second account would only
    // spend the turn twice and hide the real error.
    assert.equal(res.status, 502)
    assert.deepEqual(seen, ['token-0'])
    assert.match((await res.json()).error.message, /tool_use\.id/)
  } finally {
    shim.close()
  }
})

test('removing one account keeps the others and their own project', () => {
  const handlers = new Map()
  const config = {
    providers: {
      [ANTIGRAVITY_PROVIDER_KEY]: {
        accounts: [
          { secret: 'rt-one', email: 'one@example.com', projectId: 'project-one' },
          { secret: 'rt-two', email: 'two@example.com', projectId: 'project-two' },
        ],
        authEmail: 'two@example.com',
        googleProjectId: 'project-two',
      },
    },
  }
  let saves = 0
  registerAntigravityOAuthRoutes(
    {
      get: (path, handler) => handlers.set(path, handler),
      post: (path, handler) => handlers.set(path, handler),
    },
    {
      loadConfig: () => config,
      saveConfig: () => {
        saves++
      },
      ensureProviderConfig: (target, key) => (target.providers[key] ||= {}),
      addOrUpdateProviderAccount: () => {},
    },
  )
  const remove = handlers.get('/api/oauth/antigravity/accounts/remove')
  assert.equal(typeof remove, 'function')
  const res = fakeExpressRes()
  remove({ body: { index: 0 } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.remaining, 1)
  assert.equal(saves, 1)
  assert.deepEqual(
    getProviderAccounts(config, ANTIGRAVITY_PROVIDER_KEY).map((account) => account.email),
    ['two@example.com'],
  )
  // The surviving account's project is the provider's project; the removed one's is gone.
  assert.equal(config.providers[ANTIGRAVITY_PROVIDER_KEY].googleProjectId, 'project-two')
})

test('a Gemini tool call is replayed with the signature the model returned', () => {
  const signatures = new Map()
  captureAntigravitySignatures(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'call_1', name: 'bash', args: { cmd: 'ls' } },
                  thoughtSignature: 'sig-from-model',
                },
              ],
            },
          },
        ],
      },
    },
    signatures,
  )
  assert.equal(signatures.get('call_1'), 'sig-from-model')

  const envelope = toAntigravityRequest(
    {
      model: 'gemini-3.8-flash-medium',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'a.txt' },
      ],
    },
    { projectId: 'p', modelId: 'gemini-3.8-flash-medium', signatures },
  )
  const part = envelope.request.contents[1].parts[0]
  assert.equal(part.thoughtSignature, 'sig-from-model')
  // Cloud Code Assist refuses a Gemini functionCall that carries an id, and pairs the result by
  // name instead; the id only exists so the shim can find the signature again.
  assert.equal(part.functionCall.id, undefined)
  assert.equal(envelope.request.contents[2].parts[0].functionResponse.id, undefined)
})

test('an unsigned Gemini tool call is replayed with the documented sentinel', () => {
  const envelope = toAntigravityRequest(
    {
      model: 'gemini-3.8-flash-medium',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_old', type: 'function', function: { name: 'bash', arguments: '{}' } },
            { id: 'call_old_2', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
      ],
    },
    { projectId: 'p', modelId: 'gemini-3.8-flash-medium' },
  )
  const parts = envelope.request.contents[0].parts
  // Google validates the first functionCall of a step only, so only it needs the placeholder.
  assert.equal(parts[0].thoughtSignature, THOUGHT_SIGNATURE_SENTINEL)
  assert.equal(parts[1].thoughtSignature, undefined)
  assert.equal(parts[0].functionCall.id, undefined)
})

test('a Claude replay behind Antigravity carries no Gemini signature', () => {
  const envelope = toAntigravityRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'toolu_1', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
      ],
    },
    { projectId: 'p', modelId: 'claude-sonnet-4-6', signatures: new Map([['toolu_1', 'sig']]) },
  )
  const part = envelope.request.contents[0].parts[0]
  assert.equal(part.thoughtSignature, undefined)
  // Claude pairs its result to the call by id, so that one stays.
  assert.equal(part.functionCall.id, 'toolu_1')
})

test('the shim keeps the signature across the tool round trip', async () => {
  const envelopes = []
  let turn = 0
  const shim = startAntigravityShim({
    resolveCredential: async () => ({ accessToken: 'token', projectId: 'project' }),
    openStream: async ({ envelope }) => {
      envelopes.push(envelope)
      turn++
      if (turn === 1) {
        return new Response(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: { id: 'call_9', name: 'bash', args: { cmd: 'ls' } },
                        thoughtSignature: 'sig-round-trip',
                      },
                    ],
                  },
                },
              ],
            },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return sseAnswer('done')
    },
  })
  const url = await shim.ensure()
  const ask = (messages) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash-medium', messages, stream: false }),
    })
  try {
    await ask([{ role: 'user', content: 'hi' }])
    await ask([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_9', name: 'bash', content: 'a.txt' },
    ])
    const replayed = envelopes[1].request.contents[1].parts[0]
    assert.equal(replayed.thoughtSignature, 'sig-round-trip')
  } finally {
    shim.close()
  }
})

test('a family quota bucket answers every effort of that family', () => {
  // Antigravity names the bucket by family; the roster appends the effort.
  assert.deepEqual(antigravityQuotaModelAliases('gemini-3.8-flash'), [
    'gemini-3.8-flash',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
  ])
  assert.deepEqual(antigravityQuotaModelAliases('gpt-oss-120b'), [
    'gpt-oss-120b',
    'gpt-oss-120b-medium',
  ])
  assert.deepEqual(antigravityQuotaModelAliases('claude-opus-4-6'), [
    'claude-opus-4-6',
    'claude-opus-4-6-thinking',
  ])
  // A bucket that already names a roster id is not widened to unrelated ids.
  assert.deepEqual(antigravityQuotaModelAliases('claude-sonnet-4-6'), ['claude-sonnet-4-6'])
  assert.deepEqual(antigravityQuotaModelAliases(''), [])
})

test('quota is read from the Antigravity endpoint with the account project', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const resetTime = new Date(Date.now() + 3_600_000).toISOString()
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body,
      auth: init?.headers?.Authorization,
      userAgent: init?.headers?.['User-Agent'],
    })
    return new Response(
      JSON.stringify({
        buckets: [
          {
            modelId: 'gemini-3.8-flash',
            tokenType: 'REQUESTS',
            remainingFraction: 0.72,
            resetTime,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const payload = await fetchAntigravityQuotaPayload('access-token', 'project-one')
    assert.equal(payload.buckets[0].remainingFraction, 0.72)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  )
  assert.equal(JSON.parse(calls[0].body).project, 'project-one')
  assert.equal(calls[0].auth, 'Bearer access-token')
  assert.match(calls[0].userAgent, /^antigravity\/hub\//)
})

function fakeExpressRes() {
  return {
    statusCode: 200,
    body: /** @type {any} */ (null),
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    set() {
      return this
    },
  }
}

test('the callback answers the browser over raw http instead of throwing', async (t) => {
  // Regression: the callback lands on the bare node:http listener, so it holds a ServerResponse.
  // Express helpers there threw `res.status is not a function` and the tab was left hanging.
  const handlers = new Map()
  registerAntigravityOAuthRoutes(
    {
      get: (path, handler) => handlers.set(path, handler),
      post: () => {},
    },
    {
      loadConfig: () => ({ providers: {} }),
      saveConfig: () => {},
      ensureProviderConfig: (config, key) => {
        if (!config.providers[key]) config.providers[key] = {}
        return config.providers[key]
      },
      addOrUpdateProviderAccount: () => {},
    },
  )

  const authorize = handlers.get('/api/oauth/antigravity/authorize')
  assert.equal(typeof authorize, 'function')
  const authorized = fakeExpressRes()
  await authorize({ query: {} }, authorized)
  if (authorized.statusCode === 503) {
    t.skip('the Antigravity callback port is held by a running app')
    return
  }
  assert.equal(authorized.statusCode, 200)
  assert.ok(authorized.body.flowId)

  const unknown = await fetch(
    `http://${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback?state=not-a-flow`,
  )
  assert.equal(unknown.status, 400)
  assert.match(await unknown.text(), /expired/i)

  // A real state with a refusal closes the flow and the listener, so the suite holds no socket.
  const denied = await fetch(
    `http://${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback?state=${encodeURIComponent(authorized.body.flowId)}&error=access_denied&error_description=User%20denied`,
  )
  assert.equal(denied.status, 400)
  assert.match(await denied.text(), /User denied/)

  const status = handlers.get('/api/oauth/antigravity/status')
  const reported = fakeExpressRes()
  status({ query: { flowId: authorized.body.flowId } }, reported)
  assert.equal(reported.body.status, 'error')
  assert.match(reported.body.error, /User denied/)
})
