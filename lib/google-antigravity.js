/**
 * @file lib/google-antigravity.js
 * @description Google Antigravity (Cloud Code Assist) OAuth credential and wire adapter.
 *
 * Gemini models are not reachable from Hammer's Google AI provider with a sign-in: the
 * Generative Language API takes an API key, and the scope that would let an OAuth token act
 * there is not registered on Gemini CLI's client (Google answers `restricted_client` before
 * consent). Gemini CLI's own free tier is gone as well — `loadCodeAssist` now reports it
 * ineligible with "This client is no longer supported ... migrate to the Antigravity suite".
 *
 * Antigravity's Cloud Code Assist backend is the surface that does accept an OAuth login, and
 * it is what oh-my-pi uses (`google-antigravity`). It needs its own OAuth client — the extra
 * scopes and the callback port below are the ones registered for it — and a project the
 * backend provisions on first login. Everything after that is a Gemini request wrapped in
 * `{project, model, request}` and streamed back as `{response: ...}` SSE frames.
 *
 * This module owns the credential exchange, the project onboarding, the request/response
 * translation, and the loopback shim that lets the existing router reach all of it through its
 * normal OpenAI-compatible dispatch. It deliberately has no server state beyond a token cache.
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

export const ANTIGRAVITY_PROVIDER_KEY = 'google-antigravity'

/** Production daily endpoint first, sandbox as the failover the real client uses. */
export const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]
export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'

/** The callback the Antigravity client registers; Google matches the redirect exactly. */
export const ANTIGRAVITY_CALLBACK_HOST = '127.0.0.1'
export const ANTIGRAVITY_CALLBACK_PORT = 51121
export const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'
export const ANTIGRAVITY_REDIRECT_URI = `http://${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`

/**
 * Antigravity's installed-application OAuth client. Google treats a desktop client's secret as
 * public (it ships inside the IDE), and both values can be overridden for a private client.
 */
export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  ''
export const ANTIGRAVITY_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET || ''

/**
 * `cloud-platform` is what the Code Assist calls are authorised by; `cclog`,
 * `experimentsandconfigs` and `aicode` are part of Antigravity's registered grant and are asked
 * for because the backend's tier check looks at the grant it issued, not just the token.
 */
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
]

/** The client version gates which models the backend will serve. */
export const ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_VERSION || '2.19.1'
export const ANTIGRAVITY_USER_AGENT =
  process.env.ANTIGRAVITY_USER_AGENT ||
  `antigravity/hub/${ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`

const ANTIGRAVITY_TIMEOUT_MS = 60_000
const ANTIGRAVITY_ONBOARD_TIMEOUT_MS = 45_000
const ANTIGRAVITY_ONBOARD_POLL_MS = 1_000
const ANTIGRAVITY_STREAM_FIRST_EVENT_MS = 120_000

/**
 * The roster, taken from the wire ids the Antigravity client itself sends. These are not
 * discoverable: `fetchAvailableModels` answers `403 PERMISSION_DENIED` even for an entitled
 * account, so a curated list is the only honest source, and each row carries the output cap and
 * telemetry label the backend expects for that id.
 *
 * `contextLength` stays null rather than guessed — nothing here publishes a window.
 *
 * Verified against this backend on 2026-11-09, per wire id: `gemini-3.8-flash-{low,medium,high}`,
 * `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium` answer; the older
 * `gemini-3-flash-agent` / `gemini-3.5-flash-*` ids now return HTTP 200 carrying only “no longer
 * available, switch to Gemini 3.7 Flash”, and `gemini-3.1-pro-low`, `gemini-pro-agent` and the
 * 3.6/3.7 wire ids answer 404 for this project. A row that cannot answer is worse than no row:
 * a 200 prose notice reads as a model answer, so those ids are not listed here.
 */
export const ANTIGRAVITY_MODELS = [
  {
    modelId: 'gemini-3.8-flash-medium',
    label: 'Gemini 3.8 Flash (Medium)',
    modelEnum: null,
    maxOutputTokens: 65536,
  },
  {
    modelId: 'gemini-3.8-flash-high',
    label: 'Gemini 3.8 Flash (High)',
    modelEnum: null,
    maxOutputTokens: 65536,
  },
  {
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    modelEnum: null,
    maxOutputTokens: 64000,
  },
  {
    modelId: 'claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (Thinking)',
    modelEnum: null,
    maxOutputTokens: 64000,
  },
  {
    modelId: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    modelEnum: null,
    maxOutputTokens: 32768,
  },
]

/** @param {string} modelId */
export function antigravityModelProfile(modelId) {
  const id = String(modelId || '').replace(/^models\//, '')
  return ANTIGRAVITY_MODELS.find((entry) => entry.modelId === id) || null
}

/**
 * The roster ids one quota bucket covers.
 *
 * Antigravity reports a bucket per family (`gemini-3.8-flash`, `gpt-oss-120b`), while the roster
 * spells the effort as a suffix (`gemini-3.8-flash-medium`, `gpt-oss-120b-medium`). One bucket is
 * shared by every effort of its family, so it answers all of them; an exact id is only itself.
 *
 * @param {string} bucketModelId
 * @returns {string[]}
 */
export function antigravityQuotaModelAliases(bucketModelId) {
  const id = String(bucketModelId || '')
    .replace(/^models\//i, '')
    .toLowerCase()
    .trim()
  if (!id) return []
  const aliases = new Set([id])
  for (const entry of ANTIGRAVITY_MODELS) {
    const roster = entry.modelId.toLowerCase()
    const base = roster.replace(/-(low|medium|high|thinking)$/, '')
    if (roster === id || base === id) aliases.add(roster)
  }
  return [...aliases]
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** @returns {{verifier:string, challenge:string}} */
export function createAntigravityPkcePair() {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Build the consent URL for Antigravity's installed-app loopback flow. */
export function buildAntigravityAuthUrl({ redirectUri, state, codeChallenge }) {
  const url = new URL(ANTIGRAVITY_AUTH_URL)
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

async function jsonOrNull(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function exchangeAntigravityCode({ code, codeVerifier, redirectUri }) {
  const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    throw new Error(
      `Antigravity token exchange failed (HTTP ${response.status})${text(payload?.error_description) ? `: ${text(payload.error_description)}` : ''}`,
    )
  }
  const accessToken = text(payload?.access_token)
  const refreshToken = text(payload?.refresh_token)
  if (!accessToken || !refreshToken) {
    throw new Error('Antigravity did not return both an access token and a refresh token.')
  }
  return {
    accessToken,
    refreshToken,
    scope: text(payload?.scope) || null,
    expiresIn: Number(payload?.expires_in) || null,
  }
}

export async function refreshAntigravityAccessToken(refreshToken) {
  const secret = text(refreshToken)
  if (!secret) throw new Error('An Antigravity refresh token is required.')
  const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: secret,
    }),
    signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed (HTTP ${response.status})${text(payload?.error_description) ? `: ${text(payload.error_description)}` : ''}`,
    )
  }
  const accessToken = text(payload?.access_token)
  if (!accessToken) throw new Error('Antigravity token refresh returned no access token.')
  return {
    accessToken,
    refreshToken: text(payload?.refresh_token) || null,
    expiresIn: Number(payload?.expires_in) || null,
  }
}

export async function fetchAntigravityUserInfo(accessToken) {
  const response = await fetch(ANTIGRAVITY_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
  })
  if (!response.ok) return { email: null, id: null }
  const payload = await jsonOrNull(response)
  return {
    email: text(payload?.email).toLowerCase() || null,
    id: text(payload?.id) || null,
  }
}

async function postCodeAssist(endpoint = ANTIGRAVITY_ENDPOINTS[0], method, accessToken, body) {
  const response = await fetch(`${endpoint}/v1internal:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    const message =
      text(payload?.error?.message) || text(payload?.error?.status) || `HTTP ${response.status}`
    const error = new Error(`Antigravity ${method} failed: ${message}`)
    ;/** @type {any} */ (error).status = response.status
    ;/** @type {any} */ (error).payload = payload
    throw error
  }
  return payload
}

/**
 * Call `v1internal:<method>` against the first endpoint that answers.
 *
 * `loadCodeAssist` used to be passed an empty endpoint, which produced a relative URL and failed
 * with "Failed to parse URL from /v1internal:loadCodeAssist" — so a fresh sign-in came back with
 * no project and no tier. A 5xx or a network failure moves to the sandbox endpoint; a 4xx is the
 * account's answer and is thrown as-is.
 */
async function postCodeAssistAny(method, accessToken, body) {
  let lastError = null
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      return await postCodeAssist(endpoint, method, accessToken, body)
    } catch (error) {
      lastError = error
      const status = Number(/** @type {any} */ (error)?.status) || 0
      if (status && status < 500) break
    }
  }
  throw lastError || new Error(`Antigravity ${method} failed.`)
}

function projectIdOf(value) {
  if (typeof value === 'string') return text(value) || null
  if (value && typeof value === 'object' && 'id' in value) return text(value.id) || null
  return null
}

/**
 * Read the account's Code Assist tier and, when one exists, its provisioned project.
 *
 * `ideType: ANTIGRAVITY` is what the backend routes the Antigravity grant by: the same token
 * asked as `GEMINI_CLI` is told the free tier is retired, while this identity reports the
 * Antigravity tier. Nothing here assumes a tier — the caller gets what Google answered.
 */
export async function loadAntigravityAssist(accessToken) {
  const payload = await postCodeAssistAny('loadCodeAssist', accessToken, {
    metadata: { ideType: 'ANTIGRAVITY' },
  })
  return {
    projectId: projectIdOf(payload?.cloudaicompanionProject),
    currentTier: text(payload?.currentTier?.id) || null,
    paidTier: text(payload?.paidTier?.name) || null,
    allowedTiers: Array.isArray(payload?.allowedTiers)
      ? payload.allowedTiers.map((tier) => text(tier?.id)).filter(Boolean)
      : [],
    raw: payload,
  }
}

/**
 * Provision the free tier, then hand back the project the backend assigned.
 *
 * The operation is polled rather than assumed: a half-onboarded account answers `done: false`
 * and every later call fails with a permission error that says nothing about onboarding.
 */
export async function onboardAntigravityUser(accessToken) {
  const endpoint = ANTIGRAVITY_ENDPOINTS[0]
  let operation = await postCodeAssist(endpoint, 'onboardUser', accessToken, {
    tierId: 'free-tier',
    metadata: { ideType: 'ANTIGRAVITY' },
  })
  const deadline = Date.now() + ANTIGRAVITY_ONBOARD_TIMEOUT_MS
  while (operation?.done !== true) {
    if (Date.now() > deadline) throw new Error('Antigravity onboarding did not finish in time.')
    const name = text(operation?.name)
    if (!name) throw new Error('Antigravity onboarding returned no operation name.')
    await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_ONBOARD_POLL_MS))
    const response = await fetch(`${endpoint}/v1internal/${name}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': ANTIGRAVITY_USER_AGENT,
      },
      signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Antigravity onboarding poll failed (HTTP ${response.status}).`)
    }
    operation = await jsonOrNull(response)
  }
  if (operation?.error) {
    throw new Error(
      `Antigravity onboarding failed: ${text(operation.error.message) || 'unknown error'}`,
    )
  }
  return projectIdOf(operation?.response?.cloudaicompanionProject)
}

/**
 * Settle on the project an account can actually bill.
 *
 * A tier without a project still refuses every request, so the order is: the stored project, the
 * tier's own project, then onboarding. `google_no_project` is returned only when all three fail,
 * which is a fact about the account rather than about Hammer.
 */
export async function resolveAntigravityProject(accessToken, projectHint = null) {
  const stored = text(projectHint)
  let assist = await loadAntigravityAssist(accessToken)
  if (assist.projectId) {
    return { projectId: assist.projectId, tier: assist.currentTier, paidTier: assist.paidTier }
  }
  if (stored) {
    const withHint = await postCodeAssistAny('loadCodeAssist', accessToken, {
      cloudaicompanionProject: stored,
      metadata: { ideType: 'ANTIGRAVITY' },
    }).catch(() => null)
    const hintedProject = projectIdOf(withHint?.cloudaicompanionProject)
    if (hintedProject) {
      return {
        projectId: hintedProject,
        tier: text(withHint?.currentTier?.id) || assist.currentTier,
        paidTier: text(withHint?.paidTier?.name) || assist.paidTier,
      }
    }
  }
  if (!assist.currentTier) {
    await onboardAntigravityUser(accessToken)
    assist = await loadAntigravityAssist(accessToken)
    if (assist.projectId) {
      return { projectId: assist.projectId, tier: assist.currentTier, paidTier: assist.paidTier }
    }
  }
  const error = Object.assign(
    new Error('The Antigravity account has no provisioned Cloud Code Assist project.'),
    { code: 'antigravity_no_project' },
  )
  throw error
}

/**
 * The per-model allowance buckets for one account/project.
 *
 * This is the same Code Assist RPC the Gemini CLI uses, on Antigravity's daily endpoint: each
 * bucket names a model family, a remaining fraction and the window's reset. Google does not put
 * an absolute request count in it, so the numbers are read as percentages rather than counts.
 */
export async function fetchAntigravityQuotaPayload(accessToken, projectId) {
  const project = text(projectId)
  return postCodeAssistAny('retrieveUserQuota', accessToken, project ? { project } : {})
}

/** @type {Map<string, {accessToken:string, expiresAt:number, inFlight:Promise<any>|null}>} */
const tokenCache = new Map()

export async function resolveAntigravityAccessToken(refreshToken) {
  const secret = text(refreshToken)
  if (!secret) throw new Error('An Antigravity refresh token is required.')
  const cached = tokenCache.get(secret)
  if (cached?.accessToken && cached.expiresAt > Date.now() + 60_000) return cached.accessToken
  if (cached?.inFlight) return (await cached.inFlight).accessToken

  const pending = (async () => {
    const refreshed = await refreshAntigravityAccessToken(secret)
    const entry = {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + (refreshed.expiresIn ? refreshed.expiresIn * 1000 : 3_000_000),
      inFlight: null,
    }
    tokenCache.set(secret, entry)
    if (refreshed.refreshToken && refreshed.refreshToken !== secret)
      tokenCache.set(refreshed.refreshToken, entry)
    return entry
  })()
  tokenCache.set(secret, { accessToken: '', expiresAt: 0, inFlight: pending })
  try {
    return (await pending).accessToken
  } catch (error) {
    tokenCache.delete(secret)
    throw error
  }
}

export function clearAntigravityCaches() {
  tokenCache.clear()
}

/** OpenAI's JSON-schema shape differs from Gemini's: types are upper case here. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined
  const source = /** @type {any} */ (schema)
  /** @type {any} */
  const out = {}
  const type = text(source.type).toLowerCase()
  if (type) out.type = type.toUpperCase()
  if (source.description) out.description = String(source.description)
  if (Array.isArray(source.enum)) out.enum = source.enum.map((value) => String(value))
  if (Array.isArray(source.required)) out.required = source.required.map((value) => String(value))
  if (source.properties && typeof source.properties === 'object') {
    out.properties = {}
    for (const [key, value] of Object.entries(source.properties)) {
      out.properties[key] = toGeminiSchema(value)
    }
  }
  if (source.items) out.items = toGeminiSchema(source.items)
  return out
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && text(part.type) === 'text') return text(part.text)
      return ''
    })
    .join('')
}

/**
 * Translate an OpenAI chat body into a Cloud Code Assist envelope.
 *
 * The envelope is the whole contract: `project` and `model` sit beside the Gemini `request`, so
 * a body that is valid against `generativelanguage` is still refused here until it is wrapped.
 */
export function toAntigravityRequest(
  body,
  { projectId, modelId, sessionId = null, signatures = null },
) {
  const source = body && typeof body === 'object' ? body : {}
  const model = antigravityModelProfile(modelId || source.model)
  const messages = Array.isArray(source.messages) ? source.messages : []
  const contents = []
  const systemParts = []
  // The Gemini-backed models (Gemini itself, and the proxied GPT-OSS) take no `id` on a
  // functionCall — Cloud Code Assist answers one with a bare `Request contains an invalid
  // argument` — and require the part-level `thoughtSignature` instead. The Claude-backed models
  // are validated as Anthropic messages: their tool_use/tool_result pairing *is* the id, and a
  // Gemini signature in their history is rejected.
  const geminiToolFamily = antigravityNeedsThoughtSignature(modelId || source.model)
  for (const message of messages) {
    const role = text(message?.role)
    if (role === 'system' || role === 'developer') {
      const value = contentText(message?.content)
      if (value) systemParts.push({ text: value })
      continue
    }
    if (role === 'tool') {
      // `tool_call_id` is the id the model's call carried. Claude models behind this backend
      // are validated as Anthropic messages, and a tool_result without its `tool_use.id` is
      // rejected with `messages.N.content.0.tool_use.id: Field required` — so the id is not
      // decoration here, it is what pair the result with its call.
      const toolCallId = text(message?.tool_call_id)
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              ...(toolCallId && !geminiToolFamily ? { id: toolCallId } : {}),
              name: text(message?.name) || 'tool',
              response: { content: contentText(message?.content) },
            },
          },
        ],
      })
      continue
    }
    if (role === 'assistant' && Array.isArray(message?.tool_calls)) {
      const parts = message.tool_calls.map((call) => {
        const callId = text(call?.id)
        return {
          functionCall: {
            ...(callId && !geminiToolFamily ? { id: callId } : {}),
            name: text(call?.function?.name),
            args: (() => {
              try {
                return JSON.parse(text(call?.function?.arguments) || '{}')
              } catch {
                return {}
              }
            })(),
          },
        }
      })
      // Gemini 3 validates a replayed functionCall against the thought signature the model
      // returned with it. The signature lives per part and is not part of OpenAI's wire, so it
      // is restored here from what the shim saw, by the id the call was emitted under. A call
      // with no known signature (history from another model, or from before a restart) takes
      // Google's documented sentinel: replaying it bare is a guaranteed 400 on Gemini 3, while
      // the sentinel is accepted and only costs some planning quality.
      if (geminiToolFamily) {
        for (const [index, call] of message.tool_calls.entries()) {
          const signature = text(signatures?.get(text(call?.id)))
          if (signature && parts[index]) parts[index].thoughtSignature = signature
        }
        if (parts[0]?.functionCall && !parts[0].thoughtSignature) {
          parts[0].thoughtSignature = THOUGHT_SIGNATURE_SENTINEL
        }
      }
      contents.push({ role: 'model', parts })
      continue
    }
    const value = contentText(message?.content)
    if (!value) continue
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: value }] })
  }

  /** @type {any} */
  const request = { contents }
  if (sessionId) request.sessionId = sessionId
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts }

  const generationConfig = {}
  const budget = Number(source.max_completion_tokens ?? source.max_tokens)
  if (Number.isFinite(budget) && budget > 0) {
    generationConfig.maxOutputTokens = model
      ? Math.min(Math.trunc(budget), model.maxOutputTokens)
      : Math.trunc(budget)
  }
  if (Number.isFinite(Number(source.temperature)))
    generationConfig.temperature = Number(source.temperature)
  if (Number.isFinite(Number(source.top_p))) generationConfig.topP = Number(source.top_p)
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig

  if (Array.isArray(source.tools) && source.tools.length > 0) {
    const declarations = []
    for (const tool of source.tools) {
      const fn = tool?.function || tool
      if (!fn?.name) continue
      declarations.push({
        name: String(fn.name),
        description: String(fn.description || ''),
        ...(fn.parameters ? { parameters: toGeminiSchema(fn.parameters) } : {}),
      })
    }
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  }

  return {
    project: projectId,
    model: model?.modelId || String(modelId || source.model || ''),
    request,
    ...(sessionId
      ? {
          requestId: `agent/hammer/${Date.now()}/${sessionId}/2`,
          userAgent: 'antigravity',
          requestType: 'agent',
        }
      : {}),
  }
}

/**
 * Google's documented placeholder for a replayed function call whose real signature is gone.
 * Only the first functionCall in a step is validated, so only it ever needs a value.
 *
 * The envelope carries this field as protobuf `bytes`, so the placeholder goes on the wire as
 * its standard base64 form; the raw sentence is refused as an invalid argument.
 */
export const THOUGHT_SIGNATURE_SENTINEL = Buffer.from(
  'skip_thought_signature_validator',
  'utf8',
).toString('base64')

/**
 * Whether a model on this provider is backed by Gemini's function calling, which replays a
 * signature beside every call. The Claude models are Anthropic-validated and take an id instead.
 */
export function antigravityNeedsThoughtSignature(modelId) {
  const id = String(modelId || '')
    .replace(/^models\//i, '')
    .trim()
  return !/^claude-/i.test(id)
}

const THOUGHT_SIGNATURE_CACHE_LIMIT = 2_000

/**
 * Remember the thought signature of every function call a response carries.
 *
 * The key is the id the same part is emitted under (`call_…`, or the name-derived fallback), so
 * the next turn's history can be paired with it without inventing a place in the OpenAI wire
 * format for a Google-only field.
 *
 * @param {any} event
 * @param {Map<string, string>} signatures
 */
export function captureAntigravitySignatures(event, signatures) {
  const response = event?.response || event?.candidates ? event.response || event : null
  const candidate = Array.isArray(response?.candidates) ? response.candidates[0] : null
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  for (const part of parts) {
    if (!part?.functionCall?.name) continue
    const signature = text(part.thoughtSignature)
    if (!signature) continue
    const key = text(part.functionCall.id) || `call_${part.functionCall.name}`
    if (!signatures.has(key) && signatures.size >= THOUGHT_SIGNATURE_CACHE_LIMIT) {
      const oldest = signatures.keys().next().value
      if (oldest !== undefined) signatures.delete(oldest)
    }
    signatures.set(key, signature)
  }
}

const FINISH_REASONS = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
}

/** One upstream event → what the router's OpenAI-shaped consumer expects to see. */
export function toOpenAiDeltas(event, { id, model, created }) {
  const response = event?.response || event?.candidates ? event.response || event : null
  const out = []
  if (!response) return out
  const candidate = Array.isArray(response.candidates) ? response.candidates[0] : null
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  let toolCallIndex = 0
  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.length > 0) {
      out.push({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
      })
    }
    if (part?.functionCall?.name) {
      // The backend's own id is kept when it sends one, because the caller must replay it in
      // `tool_call_id` for the result to pair with this call.
      out.push({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex++,
                  id: text(part.functionCall.id) || `call_${part.functionCall.name}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    }
  }
  // A turn that called a tool ends in `tool_calls`, not `stop`: an OpenAI client that sees
  // `stop` treats the answer as finished and never supplies the result.
  const finish = parts.some((part) => part?.functionCall?.name)
    ? 'tool_calls'
    : FINISH_REASONS[text(candidate?.finishReason).toUpperCase()] || null
  if (finish) {
    out.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    })
  }
  const usage = response.usageMetadata
  if (usage && (Number(usage.promptTokenCount) || Number(usage.candidatesTokenCount))) {
    out.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: Number(usage.promptTokenCount) || 0,
        completion_tokens: Number(usage.candidatesTokenCount) || 0,
        total_tokens: Number(usage.totalTokenCount) || 0,
      },
    })
  }
  return out
}

/** Incremental SSE reader: yields each `data:` JSON object from a streaming response. */
export async function* readAntigravityEvents(response) {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data && data !== '[DONE]') {
            try {
              yield JSON.parse(data)
            } catch {
              // A truncated frame is dropped rather than turned into a fake answer.
            }
          }
        }
        index = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data)
        } catch {
          // Same rule for the final frame.
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * Call the backend once and return the raw streaming Response.
 *
 * Failover is only attempted before anything has been read: once frames have been yielded the
 * caller already owns them, and a retry would duplicate the answer.
 */
export async function openAntigravityStream({ accessToken, envelope, signal }) {
  let lastError = null
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify(envelope),
        signal,
      })
      if (response.ok) return response
      const body = await response.text()
      lastError = new Error(
        `Antigravity stream failed (HTTP ${response.status}): ${body.slice(0, 300)}`,
      )
      // The status is what tells a caller whether another account could answer: a 429 or a 5xx
      // is the account's allowance, a 400 is the request itself and would be refused everywhere.
      ;/** @type {any} */ (lastError).status = response.status
      if (response.status < 500) throw lastError
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Antigravity stream failed.')
}

/**
 * The pool positions to try for one request, starting at `start` and wrapping.
 *
 * A single account is the whole list. With more than one, every position is tried so a
 * rate-limited account cannot fail the turn while another signed-in account could answer it.
 *
 * @param {number} count
 * @param {number} [start]
 * @returns {number[]}
 */
export function antigravityAccountOrder(count, start = 0) {
  const total = Math.max(0, Math.trunc(Number(count) || 0))
  if (total === 0) return []
  const offset = Math.max(0, Math.trunc(Number(start) || 0)) % total
  return Array.from({ length: total }, (_, index) => (offset + index) % total)
}

/** Whether another account is worth trying after this failure, or the request itself is wrong. */
function isAntigravityAccountRetryable(error) {
  const status = Number(/** @type {any} */ (error)?.status) || 0
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true
  return /RESOURCE_EXHAUSTED|rate.?limit|quota|exhausted|capacity/i.test(
    String(/** @type {any} */ (error)?.message || ''),
  )
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

/**
 * A loopback shim that speaks OpenAI's chat-completions wire and translates to Cloud Code Assist.
 *
 * The router already owns provider dispatch, retries, budgeting and SSE parsing; teaching all of
 * that a second wire format would duplicate it. A shim keeps the new provider on the existing
 * path and confines the translation to this file. It binds an ephemeral port and is only reachable
 * from this machine; the URL is handed to dispatch as a provider-URL override, so no config file
 * ever records it.
 *
 * A provider with more than one signed-in account is rotated here rather than in dispatch: the
 * shim is the only place that knows which account's project wraps the request, so it is also
 * the only place that can hand a rate-limited turn to the next account.
 *
 * @param {{
 *   resolveCredential:(index?:number) => Promise<{accessToken:string, projectId:string, email?:string|null}>,
 *   accountCount?:(() => Promise<number>|number)|null,
 *   openStream?:typeof openAntigravityStream,
 *   log?:(message:string)=>void,
 * }} options
 */
export function startAntigravityShim({
  resolveCredential,
  accountCount = null,
  openStream = openAntigravityStream,
  log = () => {},
}) {
  /** @type {import('node:http').Server|null} */
  let server = null
  /** @type {string|null} */
  let url = null
  let starting = null
  /** Which account answers the next request; the pool is spent in turn. */
  let accountCursor = 0
  /** Thought signatures seen this process, by function-call id, for exact replay. */
  const signatures = new Map()

  async function handleChat(request, response, raw) {
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      sendJson(response, 400, { error: { message: 'Invalid JSON body.' } })
      return
    }
    const modelId = String(body?.model || 'gemini-3-flash-agent')
    /** @type {number} */
    let accountTotal
    try {
      const declared = typeof accountCount === 'function' ? await accountCount() : accountCount
      accountTotal = Math.max(1, Math.trunc(Number(declared) || 1))
    } catch {
      accountTotal = 1
    }
    // Rotate the starting account per request and walk the whole pool from there: a second
    // sign-in only earns its keep if requests actually reach it, and one account at its limit
    // is exactly when the next one should answer instead of the turn failing.
    const order = antigravityAccountOrder(accountTotal, accountCursor)
    accountCursor = (accountCursor + 1) % accountTotal

    /** @type {{accessToken:string, projectId:string, email?:string|null}|null} */
    let credential = null
    /** @type {Response|null} */
    let upstream = null
    /** @type {any} */
    let resolveError = null
    /** @type {any} */
    let streamError = null
    for (const index of order) {
      /** @type {any} */
      let candidate
      try {
        candidate = await resolveCredential(index)
      } catch (error) {
        resolveError = error
        continue
      }
      if (!candidate?.accessToken) {
        resolveError = new Error('Antigravity returned no access token.')
        continue
      }
      const envelope = toAntigravityRequest(body, {
        projectId: candidate.projectId,
        modelId,
        sessionId: `hammer-${randomUUIDShort()}`,
        signatures,
      })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), ANTIGRAVITY_STREAM_FIRST_EVENT_MS)
      try {
        upstream = await openStream({
          accessToken: candidate.accessToken,
          envelope,
          signal: controller.signal,
        })
        credential = candidate
        clearTimeout(timer)
        break
      } catch (error) {
        clearTimeout(timer)
        streamError = error
        const lastAttempt = order.indexOf(index) === order.length - 1
        if (lastAttempt || !isAntigravityAccountRetryable(error)) break
        log(
          `[antigravity] account ${index + 1}/${accountTotal} could not serve the turn, trying the next: ${
            error instanceof Error ? error.message : error
          }`,
        )
      }
    }
    if (!credential || !upstream) {
      const error = streamError || resolveError
      sendJson(response, streamError ? 502 : 401, {
        error: {
          message:
            error instanceof Error
              ? error.message
              : streamError
                ? 'Antigravity request failed.'
                : 'Antigravity is not signed in.',
        },
      })
      return
    }

    const id = `chatcmpl-${randomUUIDShort()}`
    const created = Math.floor(Date.now() / 1000)

    if (body?.stream === false) {
      let content = ''
      /** @type {any} */
      let usage = null
      let finish = null
      let sawToolCall = false
      for await (const event of readAntigravityEvents(upstream)) {
        captureAntigravitySignatures(event, signatures)
        const deltas = toOpenAiDeltas(event, { id, model: modelId, created })
        for (const delta of deltas) {
          if (delta.usage) usage = delta.usage
          const choice = delta.choices?.[0]
          if (choice?.delta?.content) content += choice.delta.content
          if (choice?.delta?.tool_calls) sawToolCall = true
          if (choice?.finish_reason) finish = choice.finish_reason
        }
      }
      // The frame that carries the call has no finish reason; the terminal frame says STOP and
      // knows nothing about the call. Without this, the turn reports `stop` and an OpenAI client
      // never supplies the tool result.
      if (sawToolCall && finish === 'stop') finish = 'tool_calls'
      sendJson(response, 200, {
        id,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: finish || 'stop' },
        ],
        ...(usage ? { usage } : {}),
      })
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders?.()
    try {
      let sawToolCall = false
      for await (const event of readAntigravityEvents(upstream)) {
        captureAntigravitySignatures(event, signatures)
        if (event?.error) {
          response.write(
            `data: ${JSON.stringify({ error: { message: String(event.error.message || 'Antigravity stream error.') } })}\n\n`,
          )
          break
        }
        for (const delta of toOpenAiDeltas(event, { id, model: modelId, created })) {
          const choice = delta.choices?.[0]
          if (choice?.delta?.tool_calls) sawToolCall = true
          if (sawToolCall && choice?.finish_reason === 'stop') choice.finish_reason = 'tool_calls'
          response.write(`data: ${JSON.stringify(delta)}\n\n`)
        }
      }
      response.write('data: [DONE]\n\n')
    } catch (error) {
      log(`[antigravity] stream failed: ${error instanceof Error ? error.message : error}`)
    } finally {
      response.end()
    }
  }

  function readBody(request) {
    return new Promise((resolve) => {
      let data = ''
      request.on('data', (chunk) => {
        data += chunk
        if (data.length > 8_000_000) request.destroy()
      })
      request.on('end', () => resolve(data))
      request.on('error', () => resolve(data))
    })
  }

  function createServer() {
    return http.createServer(async (request, response) => {
      const address = request.socket.remoteAddress || ''
      if (address && !/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(address)) {
        sendJson(response, 403, { error: { message: 'Loopback only.' } })
        return
      }
      const path = (request.url || '').split('?')[0]
      // Dispatch does not always call the override at `/v1/...`: depending on how it joins the
      // configured provider URL it can arrive on the source path or on the host root. Matching
      // by suffix keeps the shim out of that decision — a strict prefix check answered 404 with
      // the model already chosen, which looked like a missing route rather than a URL mismatch.
      const isModelsPath = request.method === 'GET' && /(?:^|\/)models\/?$/.test(path)
      const isChatPath =
        path === '/' ||
        path === '' ||
        /(?:^|\/)chat\/completions\/?$/.test(path) ||
        // The override is reached on the configured provider URL too, which for this provider
        // is the Cloud Code Assist method path.
        /streamGenerateContent\/?$/.test(path)
      if (isModelsPath) {
        sendJson(response, 200, {
          object: 'list',
          data: ANTIGRAVITY_MODELS.map((model) => ({
            id: model.modelId,
            object: 'model',
            owned_by: 'google',
            ...(model.contextLength ? { context_length: model.contextLength } : {}),
          })),
        })
        return
      }
      if (!isChatPath) {
        log(`[antigravity] unexpected request ${request.method} ${path}`)
        sendJson(response, 404, {
          error: { message: `Not found: ${request.method} ${path}` },
        })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { message: 'Use POST.' } })
        return
      }
      const raw = await readBody(request)
      void handleChat(request, response, raw)
    })
  }

  return {
    /** @returns {Promise<string>} */
    async ensure() {
      if (url) return url
      if (starting) return starting
      starting = new Promise((resolve, reject) => {
        server = createServer()
        server.once('error', (error) => {
          starting = null
          reject(error)
        })
        server.listen(0, '127.0.0.1', () => {
          const info = /** @type {import('node:net').AddressInfo} */ (server.address())
          url = `http://127.0.0.1:${info.port}`
          starting = null
          log(`[antigravity] wire shim listening on ${url}`)
          resolve(url)
        })
      })
      return starting
    },
    close() {
      url = null
      starting = null
      server?.close()
      server = null
    },
  }
}

function randomUUIDShort() {
  return randomBytes(8).toString('hex')
}
