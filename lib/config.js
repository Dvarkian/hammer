/**
 * @file lib/config.js
 * @description JSON config management for hammer multi-provider support.
 *
 * 📖 This module manages ~/.hammer.json, the config file that
 *    stores API keys and per-provider settings for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.). Providers are always enabled: the
 *    legacy `enabled` flag is ignored (see isProviderEnabled).
 *
 * 📖 Config file location: ~/.hammer.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "openrouter": "sk-or-xxx",
 *       "codestral":  "csk-xxx",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza...",
 *       "github-copilot": "gho_xxx"
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true }
 *     }
 *   }
 *
 * 📖 Multi-account round-robin:
 *   apiKeys values can be string | string[].
 *   Array = multiple accounts, rotated per-request with max-turns + 429 backoff.
 *
 * 📖 Sign-in providers use the same rotation over an account pool:
 *   providers["<key>"].accounts = [{ secret, email, accountId, ... }]
 *   Used by kiro / devin / openai-codex (see getProviderAccounts).
 *
 * @functions
 *   → loadConfig() — Read ~/.hammer.json
 *   → saveConfig(config) — Write config to ~/.hammer.json with 0o600 permissions
 *   → getApiKey(config, providerKey) — Get first API key (backward-compatible)
 *   → getApiKeyPool(config, providerKey) — Get all API keys as array
 *   → hasMultipleKeys(config, providerKey) — Whether provider has multiple accounts
 *   → getProviderAccounts(config, providerKey) — Ordered OAuth account pool
 *   → addOrUpdateProviderAccount / removeProviderAccount / setProviderAccounts
 *
 * @exports loadConfig, saveConfig, getApiKey, getApiKeyPool, hasMultipleKeys
 * @exports getProviderAccounts, getProviderAccountSecrets, getLegacyProviderAccountSecret
 * @exports addOrUpdateProviderAccount, removeProviderAccount, setProviderAccounts
 * @exports OAUTH_ACCOUNT_PROVIDERS
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/hammer.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// 📖 Primary JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.hammer.json')
const CONFIG_TRANSFER_PREFIX = 'mrconf:v1:'

// 📖 OpenAI-compatible multi-instance support
// 📖 Each endpoint is keyed as `openai-compatible:<id>` (e.g. `openai-compatible:default`).
// 📖 The bare `openai-compatible` provider key is a template only and is migrated to `:default`.
export const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible'
const OPENAI_COMPATIBLE_INSTANCE_PREFIX = `${OPENAI_COMPATIBLE_PROVIDER_KEY}:`
const DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID = 'default'

export function isOpenAICompatibleInstanceKey(providerKey) {
  return typeof providerKey === 'string' && providerKey.startsWith(OPENAI_COMPATIBLE_INSTANCE_PREFIX)
}

export function getBaseProviderKey(providerKey) {
  if (isOpenAICompatibleInstanceKey(providerKey)) return OPENAI_COMPATIBLE_PROVIDER_KEY
  return providerKey
}

export function getOpenAICompatibleInstanceId(providerKey) {
  if (!isOpenAICompatibleInstanceKey(providerKey)) return null
  return providerKey.slice(OPENAI_COMPATIBLE_INSTANCE_PREFIX.length)
}

export function buildOpenAICompatibleInstanceKey(id) {
  const trimmed = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!trimmed) return null
  return `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${trimmed}`
}

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  empero: 'EMPERO_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  codestral: 'CODESTRAL_API_KEY',
  scaleway: 'SCALEWAY_API_KEY',
  googleai: 'GOOGLE_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
  devin: 'DEVIN_API_KEY',
  // GitHub OAuth token ("gho_…") from the Copilot device flow. The dashboard
  // sign-in writes it to config; this env var is the headless equivalent.
  'github-copilot': 'GITHUB_COPILOT_TOKEN',
  // (OpenAI Codex is deliberately absent here: its credential is a ChatGPT OAuth
  // *refresh* token, which is exchanged for a short-lived access token rather than
  // sent as a bearer. The headless override is OPENAI_CODEX_REFRESH_TOKEN, read by
  // lib/server.js alongside the account pool — see getProviderAccounts.)
  // Optional: the g4f relays are keyless; a free key only raises the hosted
  // pool's per-day limits. See https://g4f.dev/api_key.html
  g4f: 'G4F_API_KEY',
}

const PROVIDER_BASE_URL_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  // Point the hosted g4f pool at a self-hosted g4f server, e.g. http://localhost:1337/v1
  g4f: 'G4F_BASE_URL',
}

const PROVIDER_MODEL_ID_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
  ollama: 'OLLAMA_MODEL',
}


function normalizeSecret(value) {
  return typeof value === 'string'
    ? value.trim().replace(/[\s\u2580-\u259F]+$/g, '').trim()
    : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.hammer.json
 *   2. If missing or invalid, return an empty default config
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, bannedModels: string[], minSweScore: number|null, excludedProviders: string[] }}
 */
export function loadConfig() {
  const current = _readConfigFile(CONFIG_PATH)
  if (current) return current

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.hammer.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}> }} config
 */
export function saveConfig(config) {
  try {
    const normalized = normalizeConfigShape(config)
    writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), { mode: 0o600 })
  } catch {
    // 📖 Silently fail — the app is still usable, keys just won't persist
  }
}

export function exportConfigToken(config) {
  const normalized = normalizeConfigShape(config)
  const json = JSON.stringify(normalized)
  const encoded = Buffer.from(json, 'utf8').toString('base64url')
  return `${CONFIG_TRANSFER_PREFIX}${encoded}`
}

export function importConfigToken(token) {
  const raw = typeof token === 'string' ? token.trim() : ''
  if (!raw) throw new Error('Config token is empty.')

  let parsed = null

  if (raw.startsWith('{')) {
    parsed = JSON.parse(raw)
  } else if (raw.startsWith(CONFIG_TRANSFER_PREFIX)) {
    const encoded = raw.slice(CONFIG_TRANSFER_PREFIX.length)
    if (!encoded) throw new Error('Config token payload is missing.')
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } else {
    // Backward-compatible import path for plain base64 payloads.
    const json = Buffer.from(raw, 'base64').toString('utf8')
    parsed = JSON.parse(json)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config payload must be a JSON object.')
  }

  return normalizeConfigShape(parsed)
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.hammer.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeSecret(process.env[envVar]);
  }
  // 📖 Config file value (string or array — return first element)
  const key = config?.apiKeys?.[providerKey]
  if (Array.isArray(key)) {
    const pool = key.map(normalizeSecret).filter(Boolean)
    return pool.length > 0 ? pool[0] : null
  }
  if (key) return normalizeSecret(key) || null
  return null
}

/**
 * 📖 getApiKeyPool: Get all configured API keys for a provider.
 * Returns an array of keys. Env var override returns single-element array.
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function getApiKeyPool(config, providerKey) {
  const envVar = ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, ENV_VARS)
  if (envVar && process.env[envVar]) {
    const k = normalizeSecret(process.env[envVar])
    return k ? [k] : []
  }
  const raw = config?.apiKeys?.[providerKey]
  if (Array.isArray(raw)) return raw.map(normalizeSecret).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) return [normalizeSecret(raw)]
  return []
}

/**
 * 📖 hasMultipleKeys: Check if a provider has multiple API key accounts.
 * @param {object} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function hasMultipleKeys(config, providerKey) {
  return getApiKeyPool(config, providerKey).length > 1
}

// ── OAuth account pools ─────────────────────────────────────────────────────
// 📖 Providers that authenticate with a *sign-in* rather than an API key keep an
// 📖 ordered account pool at `providers[key].accounts`. Each entry is one signed-in
// 📖 account: `{ secret, email, accountId, planType, profileArn, addedAt }`, where
// 📖 `secret` is whatever the provider exchanges for access (a Codex/Kiro refresh
// 📖 token, a Devin session token). Pools rotate per request exactly like
// 📖 `apiKeys` arrays, which is why the two share one shape: an ordered list of
// 📖 credential strings plus per-entry metadata.
// 📖
// 📖 The legacy single-credential fields (`refreshToken`, `sessionToken`) stay
// 📖 authoritative when no pool exists, so an existing config keeps working and
// 📖 the Kiro AWS-cache auto-discovery path is untouched.

export const OAUTH_ACCOUNT_PROVIDERS = new Set(['kiro', 'devin', 'openai-codex'])

/** 📖 The legacy single-credential field each OAuth provider used before pools. */
const LEGACY_ACCOUNT_SECRET_FIELDS = {
  kiro: 'refreshToken',
  devin: 'sessionToken',
  'openai-codex': 'refreshToken',
}

function normalizeAccountEntry(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null
  const secret = normalizeSecret(account.secret)
  if (!secret) return null
  return {
    secret,
    email: normalizeText(account.email) || null,
    accountId: normalizeText(account.accountId) || null,
    planType: normalizeText(account.planType) || null,
    profileArn: normalizeText(account.profileArn) || null,
    addedAt: Number.isFinite(Number(account.addedAt)) ? Number(account.addedAt) : null,
  }
}

/**
 * 📖 getProviderAccounts: the ordered account pool for an OAuth provider.
 *    Returns `[]` for providers that authenticate with plain API keys, and for
 *    an OAuth provider whose credential only exists in its legacy single field
 *    (that path is owned by the provider's own resolver).
 * @param {object} config
 * @param {string} providerKey
 * @returns {Array<{secret:string,email:string|null,accountId:string|null,planType:string|null,profileArn:string|null,addedAt:number|null}>}
 */
export function getProviderAccounts(config, providerKey) {
  if (!OAUTH_ACCOUNT_PROVIDERS.has(providerKey)) return []
  const providerConfig = config?.providers?.[providerKey] || {}
  const raw = Array.isArray(providerConfig.accounts) ? providerConfig.accounts : []
  const seen = new Set()
  const accounts = []
  for (const entry of raw) {
    const account = normalizeAccountEntry(entry)
    if (!account || seen.has(account.secret)) continue
    seen.add(account.secret)
    accounts.push(account)
  }
  return accounts
}

/** 📖 The single legacy credential for an OAuth provider, when no pool is configured. */
export function getLegacyProviderAccountSecret(config, providerKey) {
  const field = LEGACY_ACCOUNT_SECRET_FIELDS[providerKey]
  if (!field) return null
  return normalizeSecret(config?.providers?.[providerKey]?.[field]) || null
}

/** 📖 The ordered secret list rotation walks: the account pool, else the single legacy credential. */
export function getProviderAccountSecrets(config, providerKey) {
  const accounts = getProviderAccounts(config, providerKey)
  if (accounts.length > 0) return accounts.map(account => account.secret)
  const legacy = getLegacyProviderAccountSecret(config, providerKey)
  return legacy ? [legacy] : []
}

/**
 * 📖 addOrUpdateProviderAccount: append an account to the pool (or refresh the
 *    metadata of an account already signed in, matched by secret or email).
 *    Returns the account that now represents the credential.
 */
export function addOrUpdateProviderAccount(config, providerKey, account) {
  const normalized = normalizeAccountEntry({ addedAt: Date.now(), ...account })
  if (!normalized) return null
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}
  const providerConfig = config.providers[providerKey]
  if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    config.providers[providerKey] = {}
  }
  const target = config.providers[providerKey]
  const existing = Array.isArray(target.accounts) ? target.accounts : []
  const key = normalizeAccountKey(normalized)
  const index = existing.findIndex(entry => normalizeAccountKey(normalizeAccountEntry(entry)) === key)
  const stored = {
    secret: normalized.secret,
    ...(normalized.email ? { email: normalized.email } : {}),
    ...(normalized.accountId ? { accountId: normalized.accountId } : {}),
    ...(normalized.planType ? { planType: normalized.planType } : {}),
    ...(normalized.profileArn ? { profileArn: normalized.profileArn } : {}),
    addedAt: normalized.addedAt || Date.now(),
  }
  if (index === -1) target.accounts = [...existing, stored]
  else target.accounts = existing.map((entry, i) => (i === index ? { ...entry, ...stored } : entry))
  return stored
}

/** 📖 Two accounts are the same account when they share an email or a secret. */
function normalizeAccountKey(account) {
  if (!account) return null
  if (account.email) return `email:${String(account.email).toLowerCase()}`
  return `secret:${account.secret}`
}

/** 📖 removeProviderAccount: drop one account from the pool (by secret, email, or account id). */
export function removeProviderAccount(config, providerKey, match) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig || !Array.isArray(providerConfig.accounts)) return false
  const wanted = normalizeText(match)
  const wantedSecret = normalizeSecret(match)
  if (!wanted && !wantedSecret) return false
  const kept = []
  let removed = false
  for (const entry of providerConfig.accounts) {
    const account = normalizeAccountEntry(entry)
    if (!account) continue
    const matches = (wantedSecret && account.secret === wantedSecret)
      || (wanted && account.email && account.email.toLowerCase() === wanted.toLowerCase())
      || (wanted && account.accountId === wanted)
    if (matches) {
      removed = true
      continue
    }
    kept.push(entry)
  }
  if (!removed) return false
  if (kept.length === 0) delete providerConfig.accounts
  else providerConfig.accounts = kept
  return true
}

/** 📖 setProviderAccounts: replace the pool wholesale (used by import/sign-out clears). */
export function setProviderAccounts(config, providerKey, accounts) {
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}
  const normalized = (Array.isArray(accounts) ? accounts : [])
    .map(entry => normalizeAccountEntry(entry))
    .filter(Boolean)
  const providerConfig = config.providers[providerKey]
  if (normalized.length === 0) {
    if (providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)) {
      delete providerConfig.accounts
    }
    return []
  }
  if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    config.providers[providerKey] = {}
  }
  config.providers[providerKey].accounts = normalized
  return normalized
}

/**
 * 📖 getMaxTurns: Get the per-account max-turns threshold for a provider.
 * When an account reaches this many requests, rotate to the next one
 * (proactive switching before hitting rate limits).
 * @param {object} config
 * @param {string} providerKey
 * @returns {number} 0 = no limit
 */
export function getMaxTurns(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return 0
  const val = Number(providerConfig.maxTurns)
  if (!Number.isFinite(val) || val < 1) return 0
  return Math.floor(val)
}

export function getProviderBaseUrl(config, providerKey) {
  const envVar = PROVIDER_BASE_URL_ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, PROVIDER_BASE_URL_ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const baseUrl = config?.providers?.[providerKey]?.baseUrl
  return normalizeText(baseUrl) || null
}

export function getProviderModelId(config, providerKey) {
  const envVar = PROVIDER_MODEL_ID_ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, PROVIDER_MODEL_ID_ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const modelId = config?.providers?.[providerKey]?.modelId
  return normalizeText(modelId) || null
}

// 📖 Legacy OPENAI_COMPATIBLE_* env vars apply to the `:default` instance.
function _legacyOpenAICompatibleEnvVar(providerKey, envMap) {
  if (providerKey === `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`) {
    return envMap[OPENAI_COMPATIBLE_PROVIDER_KEY] || null
  }
  return null
}

/**
 * 📖 listOpenAICompatibleEndpoints: Return all configured OpenAI-compatible endpoints.
 *
 * Walks `config.providers` for keys that start with `openai-compatible:` and pairs them
 * with their api keys from `config.apiKeys`. Stable insertion order.
 *
 * @param {object} config
 * @returns {Array<{instanceKey:string,id:string,name:string,baseUrl:string,modelId:string,apiKey:string|null,enabled:boolean}>}
 */
export function listOpenAICompatibleEndpoints(config) {
  const providers = (config && config.providers && typeof config.providers === 'object') ? config.providers : {}
  const out = []
  const defaultKey = `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`
  let sawDefault = false
  for (const key of Object.keys(providers)) {
    if (!isOpenAICompatibleInstanceKey(key)) continue
    if (key === defaultKey) sawDefault = true
    const p = providers[key] || {}
    out.push({
      instanceKey: key,
      id: getOpenAICompatibleInstanceId(key),
      name: normalizeText(p.name) || getOpenAICompatibleInstanceId(key),
      baseUrl: getProviderBaseUrl(config, key) || '',
      modelId: getProviderModelId(config, key) || '',
      apiKey: getApiKey(config, key),
      enabled: p.enabled !== false,
      discoverModels: p.discoverModels !== false,
    })
  }

  // 📖 Surface a virtual `:default` instance when only the legacy env vars
  // 📖 OPENAI_COMPATIBLE_* are set (no JSON entry). Keeps the UI consistent
  // 📖 with prior behavior where env-var-only users still saw the provider row.
  if (!sawDefault) {
    const envBaseUrl = getProviderBaseUrl(config, defaultKey)
    const envModelId = getProviderModelId(config, defaultKey)
    const envApiKey = getApiKey(config, defaultKey)
    if (envBaseUrl || envModelId || envApiKey) {
      out.push({
        instanceKey: defaultKey,
        id: DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID,
        name: 'Default',
        baseUrl: envBaseUrl || '',
        modelId: envModelId || '',
        apiKey: envApiKey,
        enabled: true,
        discoverModels: true,
      })
    }
  }
  return out
}

/**
 * 📖 upsertOpenAICompatibleEndpoint: Add or update an endpoint instance in-place.
 *
 * @param {object} config
 * @param {{id?:string, instanceKey?:string, name?:string, baseUrl?:string, modelId?:string, apiKey?:string|null, enabled?:boolean}} fields
 * @returns {string} the instanceKey written
 */
export function upsertOpenAICompatibleEndpoint(config, fields) {
  if (!config || typeof config !== 'object') throw new Error('config required')
  if (!config.apiKeys || typeof config.apiKeys !== 'object') config.apiKeys = {}
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}

  let instanceKey = fields?.instanceKey
  if (!instanceKey) instanceKey = buildOpenAICompatibleInstanceKey(fields?.id || fields?.name || '')
  if (!instanceKey) throw new Error('endpoint id or name required')

  const existing = config.providers[instanceKey] || {}
  const merged = { ...existing }
  if (fields.name !== undefined) merged.name = normalizeText(fields.name)
  if (fields.baseUrl !== undefined) merged.baseUrl = normalizeText(fields.baseUrl)
  if (fields.modelId !== undefined) merged.modelId = normalizeText(fields.modelId)
  if (fields.enabled !== undefined) merged.enabled = fields.enabled !== false
  if (fields.discoverModels !== undefined) {
    if (fields.discoverModels === false) merged.discoverModels = false
    else delete merged.discoverModels
  }
  config.providers[instanceKey] = merged

  if (fields.apiKey !== undefined) {
    if (fields.apiKey === null || fields.apiKey === '') {
      delete config.apiKeys[instanceKey]
    } else {
      config.apiKeys[instanceKey] = normalizeSecret(fields.apiKey)
    }
  }

  return instanceKey
}

/**
 * 📖 removeOpenAICompatibleEndpoint: Delete an endpoint instance and its API key entry.
 *
 * @param {object} config
 * @param {string} instanceKey
 * @returns {boolean} true if anything was removed
 */
export function removeOpenAICompatibleEndpoint(config, instanceKey) {
  if (!isOpenAICompatibleInstanceKey(instanceKey)) return false
  let removed = false
  if (config?.providers && instanceKey in config.providers) {
    delete config.providers[instanceKey]
    removed = true
  }
  if (config?.apiKeys && instanceKey in config.apiKeys) {
    delete config.apiKeys[instanceKey]
    removed = true
  }
  return removed
}

/**
 * 📖 isProviderEnabled: Reports whether a provider is active.
 *
 * 📖 Providers are always enabled. The provider cards no longer render an
 * 📖 "Enabled" checkbox, and with that control gone there is no supported way to
 * 📖 turn a provider off — so a stored `enabled: false` (written by an older
 * 📖 build, or by onboarding's clear-key path) is ignored here rather than
 * 📖 silently keeping that provider out of discovery, pinging, and score
 * 📖 fetching. A provider without an API key still appears in settings; it just
 * 📖 has nothing to ping.
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  return true
}

export function getPinningMode(config) {
  return config?.pinningMode === 'exact' ? 'exact' : 'canonical'
}

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    bannedModels: [],
    minSweScore: null,
    excludedProviders: [],
    pinningMode: 'canonical',
    // Slope-line model selector for `smartest` routing (driven from the dashboard
    // Intelligence-vs-Speed plot). slope=null disables the selector and keeps the
    // pure intelligence ranking. minSpeed/minIntell are optional floors, expressed in
    // the plot's own units — see intellScale.
    selector: {
      enabled: false,
      slope: null,
      minSpeed: null,
      minIntell: null,
      // Which intelligence axis slope/minIntell were chosen on: 'aa' is the current
      // Artificial Analysis index. A config written before that change has no marker
      // and holds Elo-scale numbers, which the server converts once with the live
      // AA-from-Elo regression (see effectiveSelectorSettings).
      intellScale: 'aa',
    },
    // Listen address. Loopback (127.0.0.1) by default so the dashboard/proxy are not
    // reachable from the LAN without an explicit opt-in; set to '0.0.0.0' (or any
    // non-loopback address) to expose over the network, which then requires an access
    // token for non-loopback clients.
    host: '127.0.0.1',
    // Auto-generated access token required from non-loopback clients when the server is
    // bound to a non-loopback host. Never set it yourself; it is generated on first run.
    accessToken: null,
    // Request logging. logRequestContent=false stores message roles but not prompt/response
    // bodies; persistRequestLogs=false keeps logs in memory only (never writes to disk).
    logRequestContent: true,
    persistRequestLogs: true,
  }
}

function _readConfigFile(path) {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return normalizeConfigShape(parsed)
  } catch {
    return null
  }
}

export function normalizeConfigShape(config) {
  const base = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...config }
    : {}

  if (!base.apiKeys || typeof base.apiKeys !== 'object' || Array.isArray(base.apiKeys)) {
    base.apiKeys = {}
  }
  if (!base.providers || typeof base.providers !== 'object' || Array.isArray(base.providers)) {
    base.providers = {}
  }
  if (!Array.isArray(base.bannedModels)) base.bannedModels = []

  if (!('minSweScore' in base) || base.minSweScore === null) base.minSweScore = null
  else if (typeof base.minSweScore === 'number' && base.minSweScore >= 0 && base.minSweScore <= 1) base.minSweScore = base.minSweScore
  else base.minSweScore = null

  if (!Array.isArray(base.excludedProviders)) base.excludedProviders = []
  base.pinningMode = base.pinningMode === 'exact' ? 'exact' : 'canonical'
  if (!('host' in base) || typeof base.host !== 'string' || !base.host.trim()) base.host = '127.0.0.1'
  else base.host = base.host.trim()
  if (!('accessToken' in base) || typeof base.accessToken !== 'string' || !base.accessToken.trim()) base.accessToken = null
  else base.accessToken = base.accessToken.trim()
  if (!('logRequestContent' in base) || base.logRequestContent === undefined) base.logRequestContent = true
  else base.logRequestContent = base.logRequestContent !== false
  if (!('persistRequestLogs' in base) || base.persistRequestLogs === undefined) base.persistRequestLogs = true
  else base.persistRequestLogs = base.persistRequestLogs !== false

  // Apply env overrides for the security/logging settings.
  if (process.env.HAMMER_HOST && typeof process.env.HAMMER_HOST === 'string' && process.env.HAMMER_HOST.trim()) {
    base.host = process.env.HAMMER_HOST.trim()
  }
  if (process.env.HAMMER_LOG_CONTENT === '0' || process.env.HAMMER_LOG_CONTENT === 'false') {
    base.logRequestContent = false
  }
  if (process.env.HAMMER_PERSIST_LOGS === '0' || process.env.HAMMER_PERSIST_LOGS === 'false') {
    base.persistRequestLogs = false
  }
  // Slope-line selector settings: numbers or null. The selector is always
  // active — smartest routing uses the slope line whenever a slope is set (the
  // dashboard no longer has an enable toggle), so enabled is forced true here
  // even for configs written by older builds that stored false.
  if (!base.selector || typeof base.selector !== 'object' || Array.isArray(base.selector)) {
    base.selector = {}
  }
  const sel = base.selector
  sel.enabled = true
  const normOptNum = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  sel.slope = normOptNum(sel.slope)
  if (sel.slope !== null && sel.slope < 0) sel.slope = null
  sel.minSpeed = normOptNum(sel.minSpeed)
  if (sel.minSpeed !== null && sel.minSpeed < 0) sel.minSpeed = null
  sel.minIntell = normOptNum(sel.minIntell)
  if (sel.minIntell !== null && sel.minIntell < 0) sel.minIntell = null
  // Preserve only the current marker. Anything else (including a config predating it)
  // stays unmarked so the server knows those numbers are still on the Elo scale.
  sel.intellScale = sel.intellScale === 'aa' ? 'aa' : null
  base.selector = sel

  // Trim API key strings to avoid copy/paste artifacts.
  for (const provider in base.apiKeys) {
    const val = base.apiKeys[provider]
    if (Array.isArray(val)) {
      base.apiKeys[provider] = val.map(normalizeSecret).filter(Boolean)
    } else if (typeof val === 'string') {
      base.apiKeys[provider] = normalizeSecret(val)
    }
  }

  for (const provider in base.providers) {
    const providerConfig = base.providers[provider]
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
      base.providers[provider] = {}
      continue
    }
    if (typeof providerConfig.baseUrl === 'string') {
      providerConfig.baseUrl = normalizeText(providerConfig.baseUrl)
    }
    if (typeof providerConfig.modelId === 'string') {
      providerConfig.modelId = normalizeText(providerConfig.modelId)
    }
    if (typeof providerConfig.name === 'string') {
      providerConfig.name = normalizeText(providerConfig.name)
    }
    // OAuth account pools: drop malformed entries so a hand-edited config can
    // never make rotation select an account with no credential.
    if (Array.isArray(providerConfig.accounts)) {
      const accounts = providerConfig.accounts
        .filter(account => account && typeof account === 'object' && !Array.isArray(account))
        .map(account => {
          const normalized = { ...account, secret: normalizeSecret(account.secret) }
          if (typeof normalized.email === 'string') normalized.email = normalizeText(normalized.email)
          return normalized
        })
        .filter(account => account.secret)
      if (accounts.length > 0) providerConfig.accounts = accounts
      else delete providerConfig.accounts
    }
  }

  _migrateLegacyOpenAICompatible(base)

  return base
}

// 📖 Legacy single-instance config (`openai-compatible` provider key with baseUrl/modelId
// 📖 fields, and apiKey at apiKeys['openai-compatible']) is migrated to the canonical
// 📖 instance key `openai-compatible:default`. The bare key is stripped after migration.
function _migrateLegacyOpenAICompatible(base) {
  const legacyProvider = base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
  const legacyKey = base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
  const hasLegacyConfig =
    (legacyProvider && (legacyProvider.baseUrl || legacyProvider.modelId || legacyProvider.enabled === false || legacyProvider.maxTurns)) ||
    (legacyKey && (typeof legacyKey === 'string' ? legacyKey.trim() : (Array.isArray(legacyKey) && legacyKey.length > 0)))

  if (!hasLegacyConfig) {
    // Drop empty bare entry if present so it doesn't shadow lookups.
    delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
    delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
    return
  }

  const targetKey = `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`
  // Don't clobber an explicit :default the user has already configured.
  if (base.providers[targetKey] || base.apiKeys[targetKey]) {
    delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
    delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
    return
  }

  if (legacyProvider) {
    const merged = { ...legacyProvider }
    if (!merged.name) merged.name = 'Default'
    base.providers[targetKey] = merged
  } else {
    base.providers[targetKey] = { name: 'Default' }
  }

  if (legacyKey != null) base.apiKeys[targetKey] = legacyKey

  delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
  delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
}
