/**
 * @file lib/google-oauth.js
 * @description Google Gemini OAuth credentials, Cloud Code project discovery, and quota buckets.
 *
 * Hammer's Google provider used to be API-key only. An API key identifies a project but has
 * no readable quota surface: successful Gemini responses carry no rate-limit headers, and the
 * model list has no allowance fields. The Gemini CLI OAuth credential is different — Google
 * exposes the same project's remaining quota through the Code Assist RPCs the CLI uses.
 *
 * The OAuth access token is also accepted by the normal Gemini API when the request carries
 * `x-goog-user-project`, so the provider can keep its existing OpenAI-compatible endpoint and
 * only swap the credential. This module owns the token exchange, project discovery, and the
 * quota response parser; it deliberately has no server state.
 */

import { createHash, randomBytes } from 'node:crypto'

import { requireOAuthClient } from './oauth-clients.js'

export const GOOGLE_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal'
export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const GOOGLE_CLOUD_PROJECTS_URL = 'https://cloudresourcemanager.googleapis.com/v1/projects'
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
// The OAuth client is the Gemini CLI's, and Google only accepts the scopes registered for it:
// asking for `generative-language.retriever` is refused before consent with
// `403 restricted_client — Unregistered scope(s) in the request`, which locks the user out of
// signing in at all. The Gemini API scope therefore stays out of this list, and Google AI is
// served by an API key; the sign-in is the quota credential (Code Assist), not a bearer for
// the model API.
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

/**
 * Gemini CLI's installed-application OAuth client. The id and secret come from
 * `lib/oauth-clients.js`: a client secret in tracked source is a leaked credential, so a build
 * that carries one is refused by secret scanning before it can be pushed.
 */

const GOOGLE_OAUTH_TIMEOUT_MS = 30_000
const GOOGLE_QUOTA_CACHE_MS = 60 * 60_000
const GOOGLE_PROJECT_ENV_VARS = [
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
]

/** @type {Map<string, {accessToken:string, expiresAt:number, projectId:string|null, planType:string|null, inFlight:Promise<any>|null}>} */
const accessTokenCache = new Map()

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
export function createGooglePkcePair() {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Build the consent URL for the installed-app loopback flow. */
export function buildGoogleOAuthUrl({ redirectUri, state, codeChallenge }) {
  const client = requireOAuthClient('google')
  const url = new URL(GOOGLE_OAUTH_AUTH_URL)
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** The project an OAuth token should bill against, when the environment names one. */
export function googleProjectFromEnvironment() {
  for (const name of GOOGLE_PROJECT_ENV_VARS) {
    const value = text(process.env[name])
    if (value) return value
  }
  return null
}

/** @param {unknown} value */
function projectIdOf(value) {
  if (typeof value === 'string') return text(value) || null
  if (value && typeof value === 'object' && 'id' in value) return text(value.id) || null
  return null
}

async function jsonOrNull(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function postCodeAssist(method, accessToken, body) {
  const response = await fetch(`${GOOGLE_CODE_ASSIST_ENDPOINT}:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Hammer',
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    const message =
      text(payload?.error?.message) || text(payload?.error?.status) || `HTTP ${response.status}`
    const error = new Error(`Google Code Assist ${method} failed: ${message}`)
    ;/** @type {any} */ (error).status = response.status
    ;/** @type {any} */ (error).payload = payload
    throw error
  }
  return payload
}

export async function exchangeGoogleOAuthCode({ code, codeVerifier, redirectUri }) {
  const client = requireOAuthClient('google')
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    throw new Error(
      `Google token exchange failed (HTTP ${response.status})${text(payload?.error_description) ? `: ${text(payload.error_description)}` : ''}`,
    )
  }
  const accessToken = text(payload?.access_token)
  const refreshToken = text(payload?.refresh_token)
  if (!accessToken || !refreshToken) {
    throw new Error('Google did not return both an access token and a refresh token.')
  }
  return {
    accessToken,
    refreshToken,
    idToken: text(payload?.id_token) || null,
    expiresIn: Number(payload?.expires_in) || null,
    scope: text(payload?.scope) || null,
  }
}

export async function refreshGoogleOAuthAccessToken(refreshToken) {
  const client = requireOAuthClient('google')
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    throw new Error(
      `Google token refresh failed (HTTP ${response.status})${text(payload?.error_description) ? `: ${text(payload.error_description)}` : ''}`,
    )
  }
  const accessToken = text(payload?.access_token)
  if (!accessToken) throw new Error('Google token refresh returned no access token.')
  return {
    accessToken,
    refreshToken: text(payload?.refresh_token) || null,
    expiresIn: Number(payload?.expires_in) || null,
  }
}

export async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch(GOOGLE_OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Google userinfo failed (HTTP ${response.status}).`)
  const payload = await jsonOrNull(response)
  return {
    id: text(payload?.id) || null,
    email: text(payload?.email).toLowerCase() || null,
    name: text(payload?.name) || null,
  }
}

/**
 * Resolve the Cloud Code project and tier for an account. A workspace account can require
 * `GOOGLE_CLOUD_PROJECT`; a personal account normally gets `cloudaicompanionProject` here.
 */
export async function discoverGoogleProject(accessToken, projectHint = null) {
  const hint = text(projectHint) || googleProjectFromEnvironment()
  const body = {
    metadata: {
      ideType: 'GEMINI_CLI',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      ...(hint ? { duetProject: hint } : {}),
    },
    ...(hint ? { cloudaicompanionProject: hint } : {}),
  }
  const payload = await postCodeAssist('loadCodeAssist', accessToken, body)
  const projectId =
    projectIdOf(payload?.cloudaicompanionProject) ||
    projectIdOf(payload?.response?.cloudaicompanionProject) ||
    hint
  const currentTier = text(payload?.currentTier?.id) || null
  const paidTier = text(payload?.paidTier?.name) || null
  return {
    projectId: projectId || null,
    planType: paidTier || currentTier || null,
    payload,
  }
}

/** The per-model quota buckets Google returns for this account/project. */
export async function fetchGoogleQuotaPayload(accessToken, projectId) {
  const project = text(projectId)
  return postCodeAssist('retrieveUserQuota', accessToken, project ? { project } : {})
}

function normalizeQuotaModelId(value) {
  return text(value)
    .replace(/^models\//i, '')
    .replace(/^google\//i, '')
    .toLowerCase()
}

/**
 * Convert Code Assist buckets into the dashboard's quota-window shape.
 *
 * A bucket states a remaining fraction, not an absolute allowance, so the window is marked
 * `percentOnly`: the dashboard must not turn 0.72 into "72 requests". The reset time and the
 * percentage are the provider's real numbers.
 */
export function parseGoogleQuotaBuckets(payload, { email = null, observedAt = Date.now() } = {}) {
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets : []
  const windows = []
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue
    const modelId = normalizeQuotaModelId(bucket.modelId)
    if (!modelId) continue
    const rawFraction = Number(bucket.remainingFraction)
    if (!Number.isFinite(rawFraction)) continue
    const fraction = Math.min(1, Math.max(0, rawFraction))
    const resetAt = Date.parse(text(bucket.resetTime))
    const tokenType = `${text(bucket.tokenType)} ${text(bucket.quotaId)}`
    const metric = /token/i.test(tokenType) ? 'tokens' : 'requests'
    windows.push({
      metric,
      period: 'window',
      rawWindow: 'Code Assist quota',
      limit: null,
      remaining: null,
      used: null,
      usedPercent: (1 - fraction) * 100,
      percentOnly: true,
      resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null,
      scope: 'model',
      source: 'google-oauth',
      detail: `${email ? `${email} · ` : ''}${Math.round(fraction * 100)}% remaining`,
      observedAt,
      // Fraction 0 is an exhausted window with a reset, not a paid tier or a missing
      // allowance. The dashboard draws it as 100% used and keeps the reset time.
      unavailable: false,
      modelId,
    })
  }
  return windows
}

/**
 * Resolve an OAuth access token, caching it per refresh token. Google does not rotate the
 * refresh token on every exchange, but a new one is returned when it does and is reported so
 * the caller can persist it.
 */
export async function resolveGoogleOAuthAccessToken(refreshToken, options = {}) {
  const secret = text(refreshToken)
  if (!secret) throw new Error('A Google OAuth refresh token is required.')
  const cached = accessTokenCache.get(secret)
  if (cached && cached.accessToken && cached.expiresAt > Date.now() + 60_000) {
    return { ...cached, rotatedRefreshToken: null }
  }
  if (cached?.inFlight) return cached.inFlight

  const pending = (async () => {
    const refreshed = await refreshGoogleOAuthAccessToken(secret)
    let projectId = text(options.projectHint) || googleProjectFromEnvironment()
    let planType = null
    if (!projectId) {
      try {
        const discovered = await discoverGoogleProject(refreshed.accessToken)
        projectId = discovered.projectId
        planType = discovered.planType
      } catch {
        // The token is still usable for inference. Quota will retry project discovery later.
      }
    }
    const entry = {
      accessToken: refreshed.accessToken,
      projectId: projectId || null,
      planType,
      expiresAt:
        Date.now() + (refreshed.expiresIn ? refreshed.expiresIn * 1000 : GOOGLE_QUOTA_CACHE_MS),
      inFlight: null,
    }
    accessTokenCache.set(secret, entry)
    if (refreshed.refreshToken && refreshed.refreshToken !== secret) {
      accessTokenCache.set(refreshed.refreshToken, entry)
    }
    return { ...entry, rotatedRefreshToken: refreshed.refreshToken || null }
  })()

  accessTokenCache.set(secret, {
    accessToken: '',
    expiresAt: 0,
    projectId: null,
    planType: null,
    inFlight: pending,
  })
  try {
    return await pending
  } catch (error) {
    accessTokenCache.delete(secret)
    throw error
  }
}

/**
 * Convert one native Gemini model record into the row shape discovery stores.
 *
 * The native list spells the id `models/gemini-2.5-pro` and states what the model can do in
 * `supportedGenerationMethods`, so the prefix is stripped and anything that cannot answer a
 * chat request (embeddings, AQA, tuning-only rows) is dropped here rather than imported as a
 * row whose every request would be refused.
 *
 * @param {unknown} record
 * @returns {{modelId:string, label:string, contextLength:number|null}|null}
 */
export function toGoogleModelRow(record) {
  const name = text(/** @type {any} */ (record)?.name)
  if (!name) return null
  const modelId = name.replace(/^models\//, '')
  if (!modelId) return null
  const record_ = /** @type {any} */ (record)
  const methods = Array.isArray(record_?.supportedGenerationMethods)
    ? record_.supportedGenerationMethods.map((method) => text(method).toLowerCase())
    : []
  if (methods.length > 0 && !methods.includes('generatecontent')) return null
  const limit = Number(record_?.inputTokenLimit)
  return {
    modelId,
    label: text(record_?.displayName) || modelId,
    contextLength: Number.isFinite(limit) && limit > 0 ? limit : null,
  }
}

/** @param {unknown} payload */
export function toGoogleModelRows(payload) {
  const records = Array.isArray(/** @type {any} */ (payload)?.models)
    ? /** @type {any} */ (payload).models
    : []
  const rows = []
  for (const record of records) {
    const row = toGoogleModelRow(record)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * Read a signed-in account's model list from Google's native endpoint.
 *
 * This — not the OpenAI-compatible `/v1beta/openai/models` -- is the surface an OAuth token
 * is accepted on. A request names the Cloud project in `x-goog-user-project`, because the
 * token itself identifies a user rather than a billing project.
 *
 * The thrown error carries `code`, so a caller can tell a token that needs re-consent
 * (`google_scope`) from a project that cannot serve the API (`google_api_disabled`) or any
 * other refusal (`google_list_failed`).
 *
 * @param {string} accessToken
 * @param {string|null} [projectId]
 * @returns {Promise<Array<{modelId:string, label:string, contextLength:number|null}>>}
 */
export async function listGoogleModels(accessToken, projectId = null) {
  const token = text(accessToken)
  if (!token) throw new Error('A Google OAuth access token is required.')
  const url = new URL(GEMINI_MODELS_URL)
  url.searchParams.set('pageSize', '1000')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  const project = text(projectId)
  if (project) headers['x-goog-user-project'] = project
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
  })
  const payload = await jsonOrNull(response)
  if (!response.ok) {
    const message =
      text(payload?.error?.message) || text(payload?.error?.status) || `HTTP ${response.status}`
    const details = Array.isArray(payload?.error?.details) ? payload.error.details : []
    const reason = text(details.find((detail) => text(detail?.reason))?.reason) || null
    const code = /SCOPE/i.test(reason || '')
      ? 'google_scope'
      : /insufficient authentication scopes/i.test(message)
        ? 'google_scope'
        : /SERVICE_DISABLED|has not been used|is disabled/i.test(message)
          ? 'google_api_disabled'
          : 'google_list_failed'
    throw Object.assign(
      new Error(`Google model list failed (HTTP ${response.status}): ${message}`),
      { status: response.status, reason, code },
    )
  }
  return toGoogleModelRows(payload)
}

/**
 * Every active Cloud project the signed-in account can bill the Gemini API against.
 *
 * An account that signed in through the CLI may have no Code Assist project at all, but it
 * usually does have a project — AI Studio creates one the first time a key is made. Reading
 * them is what lets sign-in settle on a project that actually answers instead of persisting
 * none and letting discovery fail later with an unexplained empty list.
 *
 * @param {string} accessToken
 * @returns {Promise<string[]>}
 */
export async function listGoogleProjects(accessToken) {
  const token = text(accessToken)
  if (!token) return []
  try {
    const response = await fetch(GOOGLE_CLOUD_PROJECTS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const payload = await jsonOrNull(response)
    const projects = Array.isArray(payload?.projects) ? payload.projects : []
    return projects
      .filter((project) => text(project?.lifecycleState || 'ACTIVE') === 'ACTIVE')
      .map((project) => text(project?.projectId))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Settle on the project — and the model list — a signed-in account can actually use.
 *
 * A hint (the stored project, or GOOGLE_CLOUD_PROJECT) is tried first because it is the
 * operator's own answer; otherwise each of the account's own projects is probed until one
 * serves the list. Probing is the only reliable test: having a project says nothing about
 * whether the Generative Language API is enabled on it.
 *
 * @param {string} accessToken
 * @param {string|null} [projectHint]
 * @returns {Promise<{projectId:string|null, models:Array<{modelId:string,label:string,contextLength:number|null}>, error:(Error|null)}>}
 */
export async function resolveGoogleModelsProject(accessToken, projectHint = null) {
  const hinted = text(projectHint) || googleProjectFromEnvironment()
  const candidates = []
  if (hinted) candidates.push(hinted)
  for (const projectId of await listGoogleProjects(accessToken)) {
    if (!candidates.includes(projectId)) candidates.push(projectId)
  }
  if (candidates.length === 0) {
    const error = Object.assign(
      new Error('The signed-in Google account has no active Cloud project for the Gemini API.'),
      { code: 'google_no_project' },
    )
    return { projectId: null, models: [], error }
  }
  let lastError = null
  for (const projectId of candidates) {
    try {
      const models = await listGoogleModels(accessToken, projectId)
      return { projectId, models, error: null }
    } catch (error) {
      lastError = error
    }
  }
  return { projectId: hinted || candidates[0] || null, models: [], error: lastError }
}

export function clearGoogleOAuthCaches() {
  accessTokenCache.clear()
}
