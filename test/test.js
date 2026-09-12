import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'

import { sources, MODELS, PROVIDER_QUOTAS, canonicalizeModelId, getPreferredModelContext, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js'
import { TAG_VOCABULARY, MODEL_TAGS, getModelTags as getBuiltInModelTags } from '../tags.js'
import {
  getAvg,
  getVerdict,
  getUptime,
  sortResults,
  findBestModel,
  rankModelsForRouting,
  rankModelsForSmartest,
  getRoutingModelKey,
  latencyScore,
  computeQoS,
  DEFAULT_QOS_LATENCY_TARGET_MS,
  buildModelGroups,
  filterModelsByRequested,
  isRetryableProxyStatus,
  isQuotaExhaustionError,
  computeFailedRefreshRetryAt,
  pruneDiscoverableRows,
  parseContextSize,
  parseArgs,
  parseOpenRouterKeyRateLimit,
  selectNextApiKeyFromPool,
  pickKeyLevelRateLimit,
  mergeRateLimits,
  reconcileRateLimitState,
  applyRateLimitCapture,
  hostnameOf,
  isLoopbackHostname,
  isLoopbackRemoteAddress,
  checkApiRequestAllowed,
  accumulateUsageSample,
  accumulateContextObservation,
  isMicroContextBound,
  computeContextDisplay,
  computeUsageAverages,
  resolveCompletionTokens,
  roundMeasuredRate,
  parseAllowedModelNamesFromRefusal,
  isKnownChatModelName,
  estimateMessageTokens,
  formatTokenCount,
  isOverLengthErrorText,
  parseContextLimitFromError,
  parseMaxTokensCapFromError,
  parseEpochResetValue,
  parseRateLimitResetValue,
  extractQuotaFailure,
  extractRateLimitResetMs,
  parseRetryDelayMs,
  isPaymentRequiredError,
  isDeadModelError,
  isEmptyModelResponseText,
  hasUsableChatCompletionBody,
  findUpstreamSseError,
  isIncompatibleModelError,
  isLastResponseReady,
  isRateLimitedErrorText,
  selectModelBySlope,
  selectorSlopeOf,
  computeRowSpeed,
  shouldKeepUpAfterFailedProbe,
  VERDICT_ORDER,
} from '../lib/utils.js'
import { normalizeProviderUsageReport, selectProviderUsageReport, serializeProviderUsage } from '../lib/provider-usage.js'
import { buildOpenClawProviderConfig } from '../lib/onboard.js'
import { normalizeMissingScoreId } from '../lib/score-fetcher.js'
import {
  aaForPercentile,
  buildOpenRouterQualityIndex,
  convertSelectorToAaScale,
  scoreForAa,
  extractLMArenaEntries,
  findLMArenaEntry,
  fitAAFromEloRegression,
  fitLinearRegression,
  getArtificialAnalysisIndex,
  lmArenaMatchScore,
  predictAAFromElo,
  qualityLookupKeys,
  resolveModelQuality,
} from '../lib/model-quality.js'
import { getConfiguredTagNames, getModelTagKey, getModelTags as getUserModelTags, normalizeTag, normalizeTags, setModelTags } from '../lib/tags.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'
import { exportConfigToken, getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, getProviderPingIntervalMs, hasMultipleKeys, importConfigToken, normalizeConfigShape, isOpenAICompatibleInstanceKey, getBaseProviderKey, getOpenAICompatibleInstanceId, buildOpenAICompatibleInstanceKey, listOpenAICompatibleEndpoints, upsertOpenAICompatibleEndpoint, removeOpenAICompatibleEndpoint, isProviderEnabled } from '../lib/config.js'
import { buildNpmInstallInvocation, buildWindowsPostUpdateRestartCommand, getForcedUpdateVersion, getLocalUpdateTarballPath, getLocalUpdateVersion, isRunningFromSource, shouldStopAutostartBeforeUpdate } from '../lib/update.js'
import {  buildKiroRequestPayload,
  buildProviderRequestBody, buildKiroSocialLoginUrl, buildOpencodeHeaders, buildOpencodeProjectId, buildProviderRequestHeaders, exchangeKiroSocialAuthFlow, exchangeKiroSocialCode, extractKiroEmailFromAccessToken, extractOllamaModelRecords, extractOpenAICompatibleModelRecords, buildOpenAICompatibleModelsListUrl, getAccountStatus, getKiroRefreshToken, hasKiroAuthConfigured, getPinnedModelCandidate, getPinnedModelMatches,  isProviderAuthOptional, isProviderBearerAuthEnabled, parseKiroEventFrame, parseConnectFrames, pollKiroBuilderIdToken, providerWantsBearerAuth, resolveKiroOAuthAccessToken, shouldRetryOptionalProviderWithBearer, startKiroBuilderIdDeviceAuth, startKiroSocialAuthFlow, toOllamaModelMeta, toOpenAICompatibleDiscoveredModelMeta, toOpenCodeModelMeta, toOpenRouterModelMeta, toKiloCodeModelMeta, decodeDevinChatResponsePayload, decodeDevinModelConfigsPayload, fetchDevinModelConfigs, transformDevinResponse, transformFreeModelsResponse, transformKiroResponse, buildDevinOAuthLoginUrl, cancelDevinOAuthFlow, exchangeDevinOAuthCode, exchangeDevinOAuthFlow, getDevinOAuthFlowStatus, startDevinOAuthFlow, _setKeyPoolState } from '../lib/server.js'
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    providerKey: 'nvidia',
    intell: 10,
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

function withEnv(overrides, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const TEST_CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  TEST_CRC32_TABLE[i] = c >>> 0
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = TEST_CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeKiroFrame(headers, payload) {
  const encoder = new TextEncoder()
  const encodedHeaders = Object.entries(headers).map(([name, value]) => ({
    nameBytes: encoder.encode(name),
    valueBytes: encoder.encode(String(value)),
  }))
  const headersLength = encodedHeaders.reduce((sum, header) => sum + 1 + header.nameBytes.length + 1 + 2 + header.valueBytes.length, 0)
  const payloadBytes = encoder.encode(payload == null ? '' : JSON.stringify(payload))
  const totalLength = 12 + headersLength + payloadBytes.length + 4
  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)

  view.setUint32(0, totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, crc32(frame.slice(0, 8)), false)

  let offset = 12
  for (const { nameBytes, valueBytes } of encodedHeaders) {
    frame[offset] = nameBytes.length
    offset += 1
    frame.set(nameBytes, offset)
    offset += nameBytes.length
    frame[offset] = 7
    offset += 1
    frame[offset] = (valueBytes.length >> 8) & 0xff
    frame[offset + 1] = valueBytes.length & 0xff
    offset += 2
    frame.set(valueBytes, offset)
    offset += valueBytes.length
  }
  frame.set(payloadBytes, offset)

  view.setUint32(totalLength - 4, crc32(frame.slice(0, totalLength - 4)), false)
  return frame
}

function encodeKiroEventFrame(eventType, payload) {
  return encodeKiroFrame({ ':event-type': eventType }, payload)
}

describe('config helpers', () => {
  it('resolves one global ping interval', () => {
    const config = {
      pingIntervalMinutes: 5,
      providers: {
        nvidia: { pingIntervalMinutes: 10 },
      }
    }

    assert.equal(getProviderPingIntervalMs(config), 5 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'nvidia'), 5 * 60_000)
    assert.equal(getProviderPingIntervalMs({ providers: { nvidia: { pingIntervalMinutes: 10 } } }, 'nvidia'), 30 * 60_000)
    assert.equal(getPinningMode(config), 'canonical')
  })

  it('exports/imports full config through transfer token', () => {
    const config = {
      apiKeys: { nvidia: '  nv-key  ', groq: 'gsk-key' },
      providers: { nvidia: { enabled: true }, groq: { enabled: false } },
      bannedModels: ['a', 'b'],
      autoUpdate: { enabled: true, intervalHours: 12 },
      minSweScore: 0.45,
      excludedProviders: ['openrouter'],
      pinningMode: 'exact',
    }

    const token = exportConfigToken(config)
    assert.equal(token.startsWith('mrconf:v1:'), true)

    const imported = importConfigToken(token)
    assert.equal(imported.apiKeys.nvidia, 'nv-key')
    assert.equal(imported.apiKeys.groq, 'gsk-key')
    assert.equal(imported.providers.groq.enabled, false)
    assert.deepEqual(imported.bannedModels, ['a', 'b'])
    assert.equal(imported.autoUpdate.intervalHours, 12)
    assert.equal(imported.minSweScore, 0.45)
    assert.deepEqual(imported.excludedProviders, ['openrouter'])
    assert.equal(imported.pinningMode, 'exact')
  })

  it('imports legacy plain-base64 config payloads', () => {
    const json = JSON.stringify({ apiKeys: { kilocode: 'abc' }, providers: {} })
    const plainBase64 = Buffer.from(json, 'utf8').toString('base64')
    const imported = importConfigToken(plainBase64)
    assert.equal(imported.apiKeys.kilocode, 'abc')
  })

  it('normalizes new security and logging fields with safe defaults', () => {
    const normalized = normalizeConfigShape({})
    assert.equal(normalized.host, '127.0.0.1')
    assert.equal(normalized.accessToken, null)
    assert.equal(normalized.logRequestContent, true)
    assert.equal(normalized.persistRequestLogs, true)

    const preserved = normalizeConfigShape({
      host: '0.0.0.0',
      accessToken: 'tok-123',
      logRequestContent: false,
      persistRequestLogs: false,
    })
    assert.equal(preserved.host, '0.0.0.0')
    assert.equal(preserved.accessToken, 'tok-123')
    assert.equal(preserved.logRequestContent, false)
    assert.equal(preserved.persistRequestLogs, false)
  })

  it('honors HAMMER_HOST and logging env overrides', () => {
    withEnv({
      HAMMER_HOST: '0.0.0.0',
      HAMMER_LOG_CONTENT: '0',
      HAMMER_PERSIST_LOGS: 'false',
    }, () => {
      const normalized = normalizeConfigShape({})
      assert.equal(normalized.host, '0.0.0.0')
      assert.equal(normalized.logRequestContent, false)
      assert.equal(normalized.persistRequestLogs, false)
    })
  })

  it('normalizes the slope-line selector with safe defaults', () => {
    // The selector is always active: enabled is forced true even when absent
    // or stored as false by an older build.
    const normalized = normalizeConfigShape({})
    assert.equal(normalized.selector.enabled, true)
    assert.equal(normalized.selector.slope, null)
    assert.equal(normalized.selector.minSpeed, null)
    assert.equal(normalized.selector.minIntell, null)

    const preserved = normalizeConfigShape({
      selector: { enabled: false, slope: 42.5, minSpeed: 0.001, minIntell: 1200 },
    })
    assert.equal(preserved.selector.enabled, true)
    assert.equal(preserved.selector.slope, 42.5)
    assert.equal(preserved.selector.minSpeed, 0.001)
    assert.equal(preserved.selector.minIntell, 1200)

    const invalid = normalizeConfigShape({
      selector: { enabled: 'yes', slope: -5, minSpeed: 'abc', minIntell: null },
    })
    assert.equal(invalid.selector.enabled, true)
    assert.equal(invalid.selector.slope, null)
    assert.equal(invalid.selector.minSpeed, null)
    assert.equal(invalid.selector.minIntell, null)

    // A selector written before the AA scale carries no marker, so the server knows
    // those numbers are still Elo-scale and restates them once; only the current
    // marker survives normalization.
    assert.equal(preserved.selector.intellScale, null)
    assert.equal(normalizeConfigShape({ selector: { intellScale: 'aa' } }).selector.intellScale, 'aa')
    assert.equal(normalizeConfigShape({ selector: { intellScale: 'elo' } }).selector.intellScale, null)
  })
})

describe('sources data integrity', () => {
  it('does not include the removed Qwen Code provider', () => {
    assert.equal('qwencode' in sources, false)
  })

  it('includes OpenAI-compatible provider', () => {
    assert.ok(sources['openai-compatible'])
    assert.equal(sources['openai-compatible'].name, 'OpenAI-Compatible')
    assert.ok(Array.isArray(sources['openai-compatible'].models))
  })

  it('includes Ollama provider', () => {
    assert.ok(sources.ollama)
    assert.equal(sources.ollama.name, 'Ollama')
    assert.ok(Array.isArray(sources.ollama.models))
  })

  it('includes OpenCode Zen provider', () => {
    assert.ok(sources.opencode)
    assert.equal(sources.opencode.name, 'OpenCode Zen')
    assert.ok(Array.isArray(sources.opencode.models))
  })

  it('includes Kiro provider', () => {
    assert.ok(sources.kiro)
    assert.equal(sources.kiro.name, 'Kiro')
    assert.ok(Array.isArray(sources.kiro.models))
  })

  it('includes Empero Free provider', () => {
    assert.ok(sources.empero)
    assert.equal(sources.empero.name, 'Empero Free')
    assert.equal(sources.empero.url, 'https://free.empero.org/v1/chat/completions')
    assert.equal(sources.empero.discoverable, true)
    assert.deepEqual(sources.empero.models.map(model => model[0]), ['glm-5.3-flash', 'qwen3.8-flash'])
  })

  it('includes keyless FreeModels provider enabled by default', () => {
    assert.ok(sources.freemodels)
    assert.equal(sources.freemodels.url, 'https://freemodels-chat.freemodels.workers.dev')
    assert.deepEqual(sources.freemodels.models.map(model => model[0]), [
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5.1',
      'sol',
      'terra',
      'glm-5.2',
      'kimi-k3'
    ])
    assert.equal(isProviderEnabled({ providers: {} }, 'freemodels'), true)
  })

  it('does not enable discovery for Codestral because its API has no models endpoint', () => {
    assert.equal(sources.codestral.discoverable, undefined)
  })

  it('has expected provider structure', () => {
    for (const [providerKey, provider] of Object.entries(sources)) {
      assert.equal(typeof providerKey, 'string')
      assert.equal(typeof provider.name, 'string')
      assert.equal(typeof provider.url, 'string')
      assert.ok(Array.isArray(provider.models))
    }
  })

  it('provider model tuples have 3 or 5 fields', () => {
    for (const provider of Object.values(sources)) {
      for (const model of provider.models) {
        assert.ok(Array.isArray(model))
        assert.ok(model.length === 3 || model.length === 5)
        assert.equal(typeof model[0], 'string')
        assert.equal(typeof model[1], 'string')
        assert.equal(typeof model[2], 'string')
      }
    }
  })

  it('flat MODELS tuples include context provenance', () => {
    for (const model of MODELS) {
      assert.ok(Array.isArray(model))
      assert.equal(model.length, 7)
      assert.equal(typeof model[0], 'string')
      assert.equal(typeof model[1], 'string')
      assert.equal(typeof model[4], 'string')
      assert.equal(model[5], 'curated')
      assert.equal(typeof model[6], 'string')
    }
  })

  it('flat MODELS count matches sources sum', () => {
    const sum = Object.values(sources).reduce((acc, provider) => acc + provider.models.length, 0)
    assert.equal(MODELS.length, sum)
  })

  it('has no duplicate provider/model IDs', () => {
    const seen = new Set()
    for (const [modelId, , , , providerKey] of MODELS) {
      const key = `${providerKey}/${modelId}`
      assert.equal(seen.has(key), false, `Duplicate model key found: ${key}`)
      seen.add(key)
    }
  })
})

describe('PROVIDER_QUOTAS', () => {
  const knownProviderKeys = new Set(Object.keys(sources));

  it('only references known provider keys', () => {
    for (const key of Object.keys(PROVIDER_QUOTAS)) {
      assert.ok(knownProviderKeys.has(key), `PROVIDER_QUOTAS key "${key}" is not a known provider in sources`);
    }
  });

  it('numeric entries have at least one numeric limit field', () => {
    const fields = ['requestsPerDay', 'requestsPerMinute', 'requestsPerSecond', 'tokensPerDay', 'tokensPerMinute', 'creditsPerMonth'];
    for (const [key, quota] of Object.entries(PROVIDER_QUOTAS)) {
      const hasLimit = fields.some(f => quota[f] != null && Number.isFinite(quota[f]) && quota[f] > 0);
      assert.ok(hasLimit || quota.source, `PROVIDER_QUOTAS entry "${key}" has no limit or source description`);
    }
  });

  it('does not define unverified numeric quota estimates', () => {
    const fields = ['requestsPerDay', 'requestsPerMinute', 'requestsPerSecond', 'tokensPerDay', 'tokensPerMinute', 'creditsPerMonth'];
    for (const [key, quota] of Object.entries(PROVIDER_QUOTAS)) {
      const hasNumericLimit = fields.some(f => quota[f] != null);
      assert.equal(hasNumericLimit && quota.approximate === true, false, `Unverified numeric quota estimate found for "${key}"`);
    }
  });

  it('covers every configured provider, including providers with opaque limits', () => {
    for (const key of Object.keys(sources)) assert.ok(PROVIDER_QUOTAS[key], `Missing quota metadata for "${key}"`);
  });

  it('each entry has a source description', () => {
    for (const [key, quota] of Object.entries(PROVIDER_QUOTAS)) {
      assert.equal(typeof quota.source, 'string', `PROVIDER_QUOTAS entry "${key}" is missing a source description`);
      assert.ok(quota.source.length > 0, `PROVIDER_QUOTAS entry "${key}" has an empty source description`);
    }
  });

  it('covers all major providers with static models', () => {
    // KiloCode, OpenCode Zen, Ollama, and openai-compatible are intentionally
    // excluded — their limits are either unknown or user-specific.
    const expected = ['nvidia', 'groq', 'cerebras', 'googleai', 'openrouter', 'codestral', 'scaleway', 'kiro'];
    for (const key of expected) {
      assert.ok(PROVIDER_QUOTAS[key], `Expected PROVIDER_QUOTAS to cover "${key}"`);
    }
  });
})

describe('provider usage reports', () => {
  it('normalizes used, limit, remaining, scope, and reset without inventing limits', () => {
    const [report] = normalizeProviderUsageReport('openrouter', {
      usage: 2.5, limit: 10, model: 'demo', projectId: 'proj-1', reset: '2030-01-01T00:00:00Z',
    }, { source: 'provider-api' })
    assert.equal(report.used, 2.5)
    assert.equal(report.remaining, 7.5)
    assert.equal(report.limit, 10)
    assert.equal(report.project, 'proj-1')
    assert.equal(report.scope, 'account')
    assert.equal(report.source, 'provider-api')
    assert.ok(report.resetAt > Date.now())
    assert.equal(normalizeProviderUsageReport('groq', { usage: 4 }).at(0).limit, null)
  })

  it('normalizes request/token aliases into separate metric reports', () => {
    const reports = normalizeProviderUsageReport('groq', [
      { requestsUsed: 12, requestsLimit: 100, requestsRemaining: 88, resetAt: 1893456000000 },
      { tokensUsed: 40, tokensLimit: 1000, tokensRemaining: 960, unit: 'tokens' },
    ], { fetchedAt: 123, freshness: 'fresh' })
    assert.equal(reports[0].metric, 'requests')
    assert.equal(reports[0].used, 12)
    assert.equal(reports[0].remaining, 88)
    assert.equal(reports[1].metric, 'tokens')
    assert.equal(reports[1].limit, 1000)
    assert.equal(reports[0].fetchedAt, 123)
    assert.equal(reports[0].freshness, 'fresh')
  })

  it('emits separate metrics when one payload contains request and token fields', () => {
    const reports = normalizeProviderUsageReport('googleai', {
      requestsUsed: 2, requestsLimit: 20,
      tokensUsed: 100, tokensLimit: 1000,
    })
    assert.deepEqual(reports.map(report => report.metric), ['requests', 'tokens'])
    assert.equal(reports[1].remaining, 900)
  })

  it('selects model reports before account reports and serializes a stable API shape', () => {
    const reports = normalizeProviderUsageReport('googleai', [
      { used: 1, limit: 5, scope: 'project' },
      { used: 2, limit: 5, model: 'gemini-1.5-pro' },
    ])
    const selected = selectProviderUsageReport(reports, { providerKey: 'googleai', model: 'gemini-1.5-pro' })
    assert.equal(selected.used, 2)
    assert.equal(serializeProviderUsage([selected])[0].providerKey, 'googleai')
  })

  it('unwraps nested provider windows and preserves reset-only records', () => {
    const reports = normalizeProviderUsageReport('googleai', {
      data: { limit: 1500, remaining: 1499, resetAt: '2030-01-01T00:00:00Z', period: 'day' },
    })
    assert.equal(reports.length, 1)
    assert.equal(reports[0].used, 1)
    assert.equal(reports[0].window, 'day')
    assert.ok(serializeProviderUsage(reports)[0].resetAt > Date.now())
  })

  it('retains reset-only and multiple-window reports', () => {
    const reports = normalizeProviderUsageReport('groq', [
      { resetAt: 1893456000000, scope: 'account', unit: 'requests' },
      { used: 3, limit: 30, resetAt: 1893459600000, scope: 'account', unit: 'tokens' },
    ])
    assert.equal(reports.length, 2)
    assert.equal(reports[0].used, null)
    assert.equal(reports[0].resetAt, 1893456000000)
    assert.equal(reports[1].remaining, 27)
  })
})

describe('tags data integrity', () => {
  const knownModelIds = new Set(MODELS.map(([modelId]) => modelId))

  it('has no duplicate entries in TAG_VOCABULARY', () => {
    assert.equal(TAG_VOCABULARY.length, new Set(TAG_VOCABULARY).size)
  })

  it('only assigns tags that are in TAG_VOCABULARY', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      for (const tag of tags) {
        assert.ok(TAG_VOCABULARY.includes(tag), `Unknown tag "${tag}" on ${modelId}`)
      }
    }
  })

  it('does not assign duplicate tags to the same model', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      assert.equal(tags.length, new Set(tags).size, `Duplicate tag on ${modelId}`)
    }
  })

  it('only keys MODEL_TAGS by model IDs that exist in sources.js', () => {
    for (const modelId of Object.keys(MODEL_TAGS)) {
      assert.ok(knownModelIds.has(modelId), `MODEL_TAGS has a stale key: ${modelId}`)
    }
  })

  it('assigns at least one tag to every model in sources.js', () => {
    for (const modelId of knownModelIds) {
      assert.ok(getBuiltInModelTags(modelId).length > 0, `No tags assigned to ${modelId}`)
    }
  })
})

describe('provider api key resolution', () => {
  it('does not resolve the removed Qwen Code provider from env vars', () => {
    const originalQwen = process.env.QWEN_CODE_API_KEY
    const originalDashScope = process.env.DASHSCOPE_API_KEY

    try {
      delete process.env.QWEN_CODE_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.DASHSCOPE_API_KEY = 'dashscope-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.QWEN_CODE_API_KEY = 'qwen-code-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)
    } finally {
      if (originalQwen == null) delete process.env.QWEN_CODE_API_KEY
      else process.env.QWEN_CODE_API_KEY = originalQwen

      if (originalDashScope == null) delete process.env.DASHSCOPE_API_KEY
      else process.env.DASHSCOPE_API_KEY = originalDashScope
    }
  })

  it('supports KiloCode provider env var override', () => {
    const original = process.env.KILOCODE_API_KEY

    try {
      delete process.env.KILOCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), null)

      process.env.KILOCODE_API_KEY = 'kilocode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), 'kilocode-env-key')

      assert.equal(getApiKey({ apiKeys: { kilocode: 'file-key' } }, 'kilocode'), 'kilocode-env-key')
    } finally {
      if (original == null) delete process.env.KILOCODE_API_KEY
      else process.env.KILOCODE_API_KEY = original
    }
  })

  it('resolves the g4f key from G4F_API_KEY or the config', () => {
    const original = process.env.G4F_API_KEY

    try {
      delete process.env.G4F_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'g4f'), null)
      assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'g4f'), [])

      const config = { apiKeys: { g4f: 'g4f-config-key' } }
      assert.equal(getApiKey(config, 'g4f'), 'g4f-config-key')
      assert.deepEqual(getApiKeyPool(config, 'g4f'), ['g4f-config-key'])

      // Env var wins over the config file.
      process.env.G4F_API_KEY = 'g4f-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'g4f'), 'g4f-env-key')
      assert.equal(getApiKey(config, 'g4f'), 'g4f-env-key')

      // The g4f key is not borrowed by other providers.
      assert.equal(getApiKey(config, 'groq'), null)
    } finally {
      if (original == null) delete process.env.G4F_API_KEY
      else process.env.G4F_API_KEY = original
    }
  })

  it('supports OpenAI-compatible provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      delete process.env.OPENAI_COMPATIBLE_API_KEY
      delete process.env.OPENAI_COMPATIBLE_BASE_URL
      delete process.env.OPENAI_COMPATIBLE_MODEL

      const config = {
        apiKeys: { 'openai-compatible': 'config-key' },
        providers: { 'openai-compatible': { baseUrl: 'https://example.test/v1', modelId: 'foo/bar' } },
      }

      assert.equal(getApiKey(config, 'openai-compatible'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://example.test/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'foo/bar')

      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      assert.equal(getApiKey(config, 'openai-compatible'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'env/model')
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('supports Ollama provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    const originalBaseUrl = process.env.OLLAMA_BASE_URL
    const originalModel = process.env.OLLAMA_MODEL

    try {
      delete process.env.OLLAMA_API_KEY
      delete process.env.OLLAMA_BASE_URL
      delete process.env.OLLAMA_MODEL

      const config = {
        apiKeys: { ollama: 'config-key' },
        providers: { ollama: { baseUrl: 'https://ollama.com/v1', modelId: 'gpt-oss:120b' } },
      }

      assert.equal(getApiKey(config, 'ollama'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'gpt-oss:120b')

      process.env.OLLAMA_API_KEY = 'env-key'
      process.env.OLLAMA_BASE_URL = 'https://ollama.com/v1'
      process.env.OLLAMA_MODEL = 'llama3.3'

      assert.equal(getApiKey(config, 'ollama'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'llama3.3')
    } finally {
      if (originalKey == null) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OLLAMA_MODEL
      else process.env.OLLAMA_MODEL = originalModel
    }
  })

  it('uses Ollama cloud base URL when none is configured', () => {
    const originalBaseUrl = process.env.OLLAMA_BASE_URL

    try {
      delete process.env.OLLAMA_BASE_URL
      assert.equal(getProviderBaseUrl({ providers: { ollama: {} } }, 'ollama'), null)
    } finally {
      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl
    }
  })

  it('supports Empero provider env var override', () => {
    const original = process.env.EMPERO_API_KEY
    try {
      delete process.env.EMPERO_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'empero'), null)
      process.env.EMPERO_API_KEY = 'empero-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'empero'), 'empero-env-key')
      assert.equal(getApiKey({ apiKeys: { empero: 'file-key' } }, 'empero'), 'empero-env-key')
    } finally {
      if (original == null) delete process.env.EMPERO_API_KEY
      else process.env.EMPERO_API_KEY = original
    }
  })

  it('supports OpenCode provider env var override', () => {
    const original = process.env.OPENCODE_API_KEY

    try {
      delete process.env.OPENCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), null)

      process.env.OPENCODE_API_KEY = 'opencode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), 'opencode-env-key')
      assert.equal(getApiKey({ apiKeys: { opencode: 'file-key' } }, 'opencode'), 'opencode-env-key')
    } finally {
      if (original == null) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
    }
  })

  it('resolves Kiro OAuth refresh token from env and config', () => {
    const original = process.env.KIRO_REFRESH_TOKEN

    try {
      delete process.env.KIRO_REFRESH_TOKEN
      assert.equal(getKiroRefreshToken({ providers: {} }), null)
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'config-refresh-token')

      process.env.KIRO_REFRESH_TOKEN = 'env-refresh-token'
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'env-refresh-token')
    } finally {
      if (original === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = original
    }
  })

  it('reports Kiro auth configured when OAuth refresh token is present', () => {
    assert.equal(hasKiroAuthConfigured({ providers: {} }), false)
    assert.equal(hasKiroAuthConfigured({ providers: { kiro: { refreshToken: 'rtok' } } }), true)
  })

  it('refreshes Kiro OAuth access tokens from the Kiro refresh endpoint', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const refreshToken = 'aorAAAAAG-test-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = refreshToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    globalThis.fetch = async (url, init) => {
      callCount += 1
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.refreshToken, refreshToken)
      return new Response(JSON.stringify({
        accessToken: 'oauth-access-token',
        refreshToken,
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token')
      assert.equal(tokenB, 'oauth-access-token')
      assert.equal(callCount, 1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('uses rotated refresh token for subsequent cache-miss refreshes', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const initialToken = 'aorAAAAAG-initial-refresh-token'
    const rotatedToken = 'aorAAAAAG-rotated-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = initialToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    const tokensReceived = []
    // expiresIn: 1 puts the expiry inside the 60-second skew window so the cache immediately misses on the next call
    globalThis.fetch = async (url, init) => {
      callCount += 1
      const body = JSON.parse(String(init?.body || '{}'))
      tokensReceived.push(body.refreshToken)
      return new Response(JSON.stringify({
        accessToken: `oauth-access-token-${callCount}`,
        refreshToken: rotatedToken,
        expiresIn: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      // First call: cache miss → fetch with initialToken → response includes rotatedToken
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token-1')
      assert.equal(tokensReceived[0], initialToken)
      assert.equal(callCount, 1)

      // Second call: cache is expired (expiresIn:1 < skew), but sourceRefreshToken matches
      // so effectiveRefreshToken should be the rotated token, not the original
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenB, 'oauth-access-token-2')
      assert.equal(tokensReceived[1], rotatedToken)
      assert.equal(callCount, 2)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('builds Kiro browser OAuth URLs for Google and GitHub', () => {
    const googleUrl = new URL(buildKiroSocialLoginUrl('google', 'challenge-google', 'state-google'))
    assert.equal(`${googleUrl.origin}${googleUrl.pathname}`, 'https://prod.us-east-1.auth.desktop.kiro.dev/login')
    assert.equal(googleUrl.searchParams.get('idp'), 'Google')
    assert.equal(googleUrl.searchParams.get('code_challenge'), 'challenge-google')
    assert.equal(googleUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(googleUrl.searchParams.get('state'), 'state-google')
    assert.equal(googleUrl.searchParams.get('redirect_uri'), 'kiro://kiro.kiroAgent/authenticate-success')

    const githubUrl = new URL(buildKiroSocialLoginUrl('github', 'challenge-github', 'state-github'))
    assert.equal(githubUrl.searchParams.get('idp'), 'Github')
  })

  it('exchanges Kiro browser OAuth codes for tokens', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.equal(body.code_verifier, 'browser-verifier')
      assert.equal(body.redirect_uri, 'kiro://kiro.kiroAgent/authenticate-success')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialCode('browser-code', 'browser-verifier')
      assert.deepEqual(tokenData, {
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps Kiro browser OAuth PKCE verifier server-side during exchange', async () => {
    const flow = startKiroSocialAuthFlow('google')
    assert.match(flow.flowId, /^[0-9a-f-]{36}$/)
    assert.equal(flow.codeVerifier, undefined)
    assert.equal(flow.authUrl.includes('code_challenge='), true)
    const state = new URL(flow.authUrl).searchParams.get('state')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.match(body.code_verifier, /^[A-Fa-f0-9]{64}$/)
      assert.notEqual(body.code_verifier, 'attacker-controlled-verifier')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-flow-refresh',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state)
      assert.equal(tokenData.refreshToken, 'aorAAAAAG-flow-refresh')
      await assert.rejects(
        () => exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state),
        /Unknown or expired Kiro browser OAuth flow/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('extracts Kiro auth email from JWT access tokens when present', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'kiro@example.com' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const token = `header.${payload}.signature`
    assert.equal(extractKiroEmailFromAccessToken(token), 'kiro@example.com')
    assert.equal(extractKiroEmailFromAccessToken('not-a-jwt'), null)
  })

  it('starts Kiro AWS Builder ID device authorization', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/client/register') {
        return new Response(JSON.stringify({
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/device_authorization') {
        const body = JSON.parse(String(init?.body || '{}'))
        assert.equal(body.clientId, 'builder-client-id')
        assert.equal(body.clientSecret, 'builder-client-secret')
        assert.equal(body.startUrl, 'https://view.awsapps.com/start')
        return new Response(JSON.stringify({
          deviceCode: 'device-code-123',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://device.sso.aws/verify',
          verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
          expiresIn: 600,
          interval: 5,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }

    try {
      const auth = await startKiroBuilderIdDeviceAuth()
      assert.deepEqual(auth, {
        clientId: 'builder-client-id',
        clientSecret: 'builder-client-secret',
        deviceCode: 'device-code-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://device.sso.aws/verify',
        verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
        expiresIn: 600,
        interval: 5,
      })
      assert.equal(calls.length, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and surfaces pending status', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'authorization_pending',
      error_description: 'Still waiting for approval',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    try {
      const pending = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(pending, {
        success: false,
        pending: true,
        error: 'authorization_pending',
        errorDescription: 'Still waiting for approval',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and returns refresh credentials on success', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://oidc.us-east-1.amazonaws.com/token')
      assert.equal(init?.method, 'POST')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.clientId, 'builder-client-id')
      assert.equal(body.clientSecret, 'builder-client-secret')
      assert.equal(body.deviceCode, 'device-code-123')
      assert.equal(body.grantType, 'urn:ietf:params:oauth:grant-type:device_code')
      return new Response(JSON.stringify({
        accessToken: 'builder-access-token',
        refreshToken: 'aorAAAAAG-builder-refresh',
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const result = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(result, {
        success: true,
        tokens: {
          accessToken: 'builder-access-token',
          refreshToken: 'aorAAAAAG-builder-refresh',
          expiresIn: 3600,
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('treats OpenCode and KiloCode auth as optional bearer auth providers, and local Ollama as optional', () => {
    assert.equal(isProviderAuthOptional({}, 'opencode'), true)
    assert.equal(isProviderAuthOptional({}, 'kilocode'), true)
    assert.equal(isProviderAuthOptional({}, 'freemodels'), true)
    // g4f anonymous traffic is credit-gated, so its key is required, not optional.
    assert.equal(isProviderAuthOptional({}, 'g4f'), false)
    assert.equal(isProviderAuthOptional({}, 'ollama'), false)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://localhost:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({}, 'openrouter'), false)

    assert.equal(isProviderBearerAuthEnabled({}, 'opencode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'kilocode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'freemodels'), false)
    assert.equal(isProviderBearerAuthEnabled({}, 'g4f'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'ollama'), true)
    assert.equal(isProviderBearerAuthEnabled({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)

    assert.equal(providerWantsBearerAuth({}, 'opencode'), true)
    assert.equal(providerWantsBearerAuth({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)
    assert.equal(providerWantsBearerAuth({}, 'openrouter'), true)
  })

  it('registers gpt4free as one discoverable provider whose key is required setup', () => {
    const source = sources.g4f
    assert.ok(source, 'g4f must be registered in sources.js')
    assert.equal(source.url, 'https://g4f.space/v1/chat/completions')
    assert.equal(source.discoverable, true)
    assert.equal(source.modelsUrl, undefined, 'the hosted gateway needs no modelsUrl override')
    assert.ok(source.models.length > 0, 'g4f must ship a fallback catalog')
    assert.ok(PROVIDER_QUOTAS.g4f, 'g4f must have a quota note')
    assert.ok(MODELS.some(([id, , , , providerKey]) => providerKey === 'g4f'), 'g4f models must reach the catalog')

    // Exactly one g4f provider — the per-upstream relays are gone.
    assert.deepEqual(Object.keys(sources).filter(key => key.startsWith('g4f')), ['g4f'])

    assert.equal(isProviderEnabled({}, 'g4f'), true, 'g4f is enabled by default')
    // Anonymous g4f traffic is credit-gated, so the free account key is required
    // setup rather than optional: without it the row reports 'noauth' and the
    // dashboard files the provider under "Require setup".
    assert.equal(isProviderAuthOptional({}, 'g4f'), false)
    assert.equal(isProviderBearerAuthEnabled({}, 'g4f'), true)
  })

  it('builds stable OpenCode CLI headers for unauthenticated requests', () => {
    assert.equal(buildOpencodeProjectId('C:/example/project'), buildOpencodeProjectId('C:/example/project'))
    assert.match(buildOpencodeProjectId('C:/example/project'), /^[a-f0-9]{40}$/)

    const headers = buildOpencodeHeaders({
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.deepEqual(headers, {
      'x-opencode-project': buildOpencodeProjectId('C:/example/project'),
      'x-opencode-session': 'ses_test',
      'x-opencode-request': 'req_test',
      'x-opencode-client': 'cli',
    })
  })

  it('adds OpenCode CLI headers to provider requests without requiring a bearer token', () => {
    const headers = buildProviderRequestHeaders('opencode', {
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Authorization, undefined)
    assert.equal(headers['x-opencode-project'], buildOpencodeProjectId('C:/example/project'))
    assert.equal(headers['x-opencode-session'], 'ses_test')
    assert.equal(headers['x-opencode-request'], 'req_test')
    assert.equal(headers['x-opencode-client'], 'cli')

    const freemodelsHeaders = buildProviderRequestHeaders('freemodels', { apiKey: 'ignored' })
    assert.equal(freemodelsHeaders.Authorization, undefined)

    // A leaked (env/config) key must not turn keyless browser-shaped traffic into
    // authenticated traffic: only an explicit freemodels key earns the header.
    const freemodelsLeakedKeyHeaders = buildProviderRequestHeaders('freemodels', { apiKey: 'sk-leaked' })
    assert.equal(freemodelsLeakedKeyHeaders.Authorization, undefined)
    const freemodelsExplicitHeaders = buildProviderRequestHeaders('freemodels', { apiKey: 'sk-mine', isExplicitFreemodelsKey: true })
    assert.equal(freemodelsExplicitHeaders.Authorization, 'Bearer sk-mine')
  })

  it('finds an upstream error envelope in JSON bodies and SSE transcripts', () => {
    const jsonBody = JSON.stringify({ error: { message: 'overloaded', type: 'service_unavailable', code: 503 } })
    assert.deepEqual(findUpstreamSseError(jsonBody), { message: 'overloaded', type: 'service_unavailable', code: 503 })

    const sse = [
      'data: {"choices":[{"delta":{"content":"fine"}}]}',
      'data: {"error":{"message":"Service temporarily overloaded","code":503}}',
      'data: [DONE]',
    ].join('\n')
    assert.deepEqual(findUpstreamSseError(sse), { message: 'Service temporarily overloaded', code: 503 })

    assert.equal(findUpstreamSseError('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]'), null)
    assert.equal(findUpstreamSseError(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })), null)
    assert.equal(findUpstreamSseError(''), null)
    assert.equal(findUpstreamSseError(null), null)
    assert.equal(findUpstreamSseError('definitely not json'), null)
  })

  it('builds a Devin Connect request and handles empty credentials safely', () => {
    const payload = buildProviderRequestBody('devin', {
      messages: [{ role: 'user', content: 'Hello' }],
    }, 'swe-1.6', { apiKey: '' });
    assert.ok(Buffer.isBuffer(payload));
    assert.ok(payload.length > 5);
  })

  it('maps Devin SWE row ids to the gateway\'s hyphenated wire uids', () => {
    // The gateway's GetCliModelConfigs catalog names Devin SWE with hyphens
    // (swe-1-6 / swe-1-5), while hammer's rows use dots.
    const payload = buildProviderRequestBody('devin', {
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'swe-1.6', { apiKey: 'tok' })
    assert.ok(Buffer.isBuffer(payload))
    const wire = gunzipSync(payload.subarray(5)).toString('utf8')
    assert.ok(wire.includes('swe-1-6'))
    assert.ok(!wire.includes('swe-1.6'))
  })

  it('decodes GetCliModelConfigs entries (uid, label, disabled, maxTokens)', () => {
    const payload = Buffer.concat([
      devTestMsgField(1, [
        devTestStrField(1, 'SWE-1.6 Slow'),
        devTestVarintField(18, 200000),
        devTestStrField(22, 'swe-1-6-slow'),
      ]),
      devTestMsgField(1, [
        devTestStrField(1, 'SWE 1.5'),
        devTestVarintField(4, 1),
        devTestStrField(22, 'swe-1-5'),
      ]),
    ])
    const configs = decodeDevinModelConfigsPayload(payload)
    assert.equal(configs.length, 2)
    assert.deepEqual(
      configs.find(c => c.uid === 'swe-1-6-slow'),
      { uid: 'swe-1-6-slow', label: 'SWE-1.6 Slow', disabled: false, maxTokens: 200000 },
    )
    assert.equal(configs.find(c => c.uid === 'swe-1-5').disabled, true)
  })

  it('fetchDevinModelConfigs gunzips the unary response and reports HTTP errors readably', async () => {
    const originalFetch = globalThis.fetch
    try {
      const payload = devTestMsgField(1, [
        devTestStrField(1, 'SWE-1.6 Slow'),
        devTestStrField(22, 'swe-1-6-slow'),
        devTestVarintField(18, 200000),
      ])
      globalThis.fetch = async (url, init) => {
        assert.ok(String(url).includes('GetCliModelConfigs'))
        assert.equal(init.headers['Content-Type'], 'application/proto')
        return new Response(gzipSync(payload), { status: 200, headers: { 'content-type': 'application/proto' } })
      }
      const configs = await fetchDevinModelConfigs('devin-session-token$abc')
      assert.equal(configs.length, 1)
      assert.equal(configs[0].uid, 'swe-1-6-slow')

      globalThis.fetch = async () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 })
      await assert.rejects(() => fetchDevinModelConfigs('devin-session-token$abc'), /HTTP 403[\s\S]*nope/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('adds an entitlement hint to opaque permission_denied trailers', async () => {
    const trailer = Buffer.from(JSON.stringify({ error: { code: 'permission_denied', message: 'an internal error occurred (trace ID: abc)' } }))
    const frames = devFrame(trailer, { compressed: false, end: true })
    const upstream = new Response(frames, { status: 200, headers: { 'content-type': 'application/connect+proto' } })
    const transformed = await transformDevinResponse(upstream, 'swe-1.6', false)
    const data = JSON.parse(await transformed.text())
    assert.equal(data.error.code, 'permission_denied')
    assert.match(data.error.message, /may not be entitled/)
  })

  // ---- Devin Connect wire helpers (unit-level) ----
  function devTestVarint(value) {
    const bytes = []
    let n = value
    while (n > 127) { bytes.push((n & 127) | 128); n = Math.floor(n / 128) }
    bytes.push(n)
    return Buffer.from(bytes)
  }
  function devTestStrField(field, text) {
    const data = Buffer.from(text, 'utf8')
    return Buffer.concat([devTestVarint((field << 3) | 2), devTestVarint(data.length), data])
  }
  function devTestMsgField(field, parts) {
    const data = Buffer.concat(parts)
    return Buffer.concat([devTestVarint((field << 3) | 2), devTestVarint(data.length), data])
  }
  function devTestVarintField(field, value) {
    return Buffer.concat([devTestVarint((field << 3) | 0), devTestVarint(value)])
  }
  function devResponseProto({ messageId = 'r1', deltaText = '', stopReason = 0, toolCalls = [], deltaThinking = '', usage = null } = {}) {
    const parts = [devTestStrField(1, messageId)]
    if (deltaText) parts.push(devTestStrField(3, deltaText))
    if (stopReason) parts.push(devTestVarintField(5, stopReason))
    for (const tc of toolCalls) {
      const tcParts = []
      if (tc.id) tcParts.push(devTestStrField(1, tc.id))
      if (tc.name) tcParts.push(devTestStrField(2, tc.name))
      if (tc.argumentsJson) tcParts.push(devTestStrField(3, tc.argumentsJson))
      parts.push(devTestMsgField(6, tcParts))
    }
    if (deltaThinking) parts.push(devTestStrField(9, deltaThinking))
    if (usage) {
      const usageParts = [
        devTestVarintField(1, usage.inputTokens || 0),
        devTestVarintField(2, usage.outputTokens || 0),
        devTestVarintField(3, usage.cacheReadTokens || 0),
        devTestVarintField(4, usage.cacheWriteTokens || 0),
      ]
      parts.push(devTestMsgField(7, usageParts))
    }
    return Buffer.concat(parts)
  }
  function devFrame(protoBuffer, { compressed = true, end = false } = {}) {
    const payload = compressed ? gzipSync(protoBuffer) : protoBuffer
    const out = Buffer.alloc(5 + payload.length)
    out[0] = (compressed ? 0x01 : 0) | (end ? 0x02 : 0)
    out.writeUInt32BE(payload.length, 1)
    payload.copy(out, 5)
    return out
  }

  it('decodes a Devin ChatMessageResponse protobuf delta', () => {
    const raw = devResponseProto({
      messageId: 'r1',
      deltaText: 'Hello there',
      stopReason: 2,
      toolCalls: [{ id: 'call_1', name: 'bash', argumentsJson: '{"cmd":"ls"}' }],
      usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })
    const msg = decodeDevinChatResponsePayload(raw)
    assert.equal(msg.messageId, 'r1')
    assert.equal(msg.deltaText, 'Hello there')
    assert.equal(msg.stopReason, 2)
    assert.equal(msg.deltaToolCalls.length, 1)
    assert.equal(msg.deltaToolCalls[0].name, 'bash')
    assert.equal(msg.usage.inputTokens, 11)
    assert.equal(msg.usage.outputTokens, 5)
  })

  it('splits Connect frames and keeps partial trailing bytes', () => {
    const single = devFrame(devResponseProto({ deltaText: 'first' }))
    const partial = parseConnectFrames(single.subarray(0, single.length - 3))
    assert.equal(partial.frames.length, 0)
    assert.equal(partial.rest.length, single.length - 3)

    const body = Buffer.concat([single, devFrame(devResponseProto({ deltaText: 'second' }))])
    const full = parseConnectFrames(body)
    assert.equal(full.frames.length, 2)
    assert.equal(full.rest.length, 0)
  })

  it('transforms Devin Connect frames into a non-streaming OpenAI completion', async () => {
    const frames = Buffer.concat([
      devFrame(devResponseProto({ deltaText: 'Hello' })),
      devFrame(devResponseProto({ deltaText: ' there', stopReason: 2, usage: { inputTokens: 11, outputTokens: 7 } })),
    ])
    const upstream = new Response(frames, { status: 200, headers: { 'content-type': 'application/connect+proto' } })
    const transformed = await transformDevinResponse(upstream, 'swe-1.6', false)
    const data = JSON.parse(await transformed.text())
    assert.equal(data.choices[0].message.content, 'Hello there')
    assert.equal(data.choices[0].finish_reason, 'stop')
    assert.equal(data.usage.completion_tokens, 7)
  })

  it('streams Devin Connect frames as OpenAI SSE chunks', async () => {
    const frames = Buffer.concat([
      devFrame(devResponseProto({ deltaText: 'Hi' })),
      devFrame(devResponseProto({ deltaText: ' there' })),
      devFrame(devResponseProto({ stopReason: 2 }), { end: true, compressed: false }), // end marker
    ])
    const upstream = new Response(frames, { status: 200, headers: { 'content-type': 'application/connect+proto' } })
    const transformed = await transformDevinResponse(upstream, 'swe-1.6', true)
    const sse = await transformed.text()
    const chunks = sse.split('\n')
      .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)))
    const text = chunks
      .filter(chunk => chunk.choices?.[0]?.delta?.content)
      .map(chunk => chunk.choices[0].delta.content)
      .join('')
    assert.equal(text, 'Hi there')
    assert.ok(chunks.some(chunk => chunk.choices && chunk.choices[0].finish_reason === 'stop'))
    assert.ok(sse.endsWith('data: [DONE]\n\n'))
  })

  it('turns a Devin Connect error trailer into a readable error instead of raw bytes', async () => {
    const trailer = Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'account quota exhausted' } }), 'utf8')
    const body = devFrame(trailer, { compressed: true, end: true })
    const upstream = new Response(body, { status: 200, headers: { 'content-type': 'application/connect+proto' } })
    const transformed = await transformDevinResponse(upstream, 'swe-1.6', false)
    assert.equal(transformed.status, 502)
    const payload = JSON.parse(await transformed.text())
    assert.match(payload.error.message, /account quota exhausted/)
    assert.equal(payload.error.code, 'resource_exhausted')
  })

  it('adds Kiro SDK headers to provider requests', () => {
    const headers = buildProviderRequestHeaders('kiro', {
      apiKey: 'kiro-key',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Accept, 'application/vnd.amazon.eventstream')
    assert.equal(headers.Authorization, 'Bearer kiro-key')
    assert.equal(headers['X-Amz-Target'], 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse')
    assert.equal(headers['User-Agent'], 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0')
    assert.equal(headers['X-Amz-User-Agent'], 'aws-sdk-js/3.0.0 kiro-ide/1.0.0')
  })

  it('translates OpenAI chat payloads into Kiro conversation state', () => {
    const payload = buildKiroRequestPayload({
      messages: [
        { role: 'system', content: 'Keep it short.' },
        { role: 'user', content: 'Say hi.' },
      ],
      max_tokens: 32,
      temperature: 0.4,
    }, 'claude-haiku-4.5')

    assert.equal(payload.conversationState.chatTriggerType, 'MANUAL')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.modelId, 'claude-haiku-4.5')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.origin, 'AI_EDITOR')
    assert.match(payload.conversationState.currentMessage.userInputMessage.content, /\[Context: Current time is .*]\n\nSay hi\./)
    assert.equal(payload.conversationState.history.length, 1)
    assert.equal(payload.conversationState.history[0].userInputMessage.content, 'Keep it short.')
    assert.equal(payload.inferenceConfig.maxTokens, 32)
    assert.equal(payload.inferenceConfig.temperature, 0.4)
  })

  it('routes provider request body translation through Kiro only', () => {
    const kiroBody = buildProviderRequestBody('kiro', {
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Hello there' }],
    }, 'claude-haiku-4.5')

    assert.ok(kiroBody.conversationState)
    assert.equal(kiroBody.model, undefined)

    const passthrough = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] }
    assert.equal(buildProviderRequestBody('openrouter', passthrough, 'gpt-4o-mini'), passthrough)
  })

  it('transforms FreeModels OpenAI requests to custom format', () => {
    const freemodelsBody = buildProviderRequestBody('freemodels', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      stream: true,
    }, 'claude-sonnet-5')

    assert.equal(freemodelsBody.modelId, 'claude-sonnet-5')
    assert.equal(freemodelsBody.stream, true)
    assert.equal(freemodelsBody.thinking, false)
    assert.equal(freemodelsBody.deepSearch, false)
    assert.equal(freemodelsBody.temperature, 0.7)
    assert.deepEqual(freemodelsBody.messages, [{ role: 'user', content: 'Hello' }])
  })

  it('aggregates FreeModels SSE into a non-streaming OpenAI response', async () => {
    const upstream = new Response([
      'data: {"id":"chatcmpl-test","created":123,"model":"qwen3-30b-a3b","choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"HELLO"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"_FREEMODELS"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n'))

    const response = await transformFreeModelsResponse(upstream, 'claude-sonnet-5', false)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'HELLO_FREEMODELS')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.model, 'qwen3-30b-a3b')
  })

  it('converts a FreeModels 200 SSE that opens with an error frame into a retryable 503 (non-streaming)', async () => {
    const upstream = new Response([
      'data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}',
      'data: [DONE]',
      '',
    ].join('\n'))

    const response = await transformFreeModelsResponse(upstream, 'claude-sonnet-5', false)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.message, 'Service temporarily overloaded')
    assert.equal(body.error.code, 503)
  })

  it('converts a FreeModels 200 SSE error frame into a synthetic 503 for streaming callers', async () => {
    const upstream = new Response(
      [
        'data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}',
        'data: [DONE]',
        '',
      ].join('\n')
    )

    const response = await transformFreeModelsResponse(upstream, 'claude-sonnet-5', true)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.code, 503)
  })

  it('passes a healthy FreeModels stream through with its first frame intact', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"HE"}}]}',
      'data: {"choices":[{"delta":{"content":"LLO"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ]
    const upstream = new Response(frames.join('\n\n'))

    const response = await transformFreeModelsResponse(upstream, 'claude-sonnet-5', true)
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.includes('"content":"HE"'), 'the peeked first frame must not be dropped')
    assert.ok(text.includes('"content":"LLO"'))
  })

  it('parses Kiro AWS EventStream frames', () => {
    const frame = encodeKiroEventFrame('assistantResponseEvent', { content: 'hello' })
    const parsed = parseKiroEventFrame(frame)

    assert.equal(parsed.headers[':event-type'], 'assistantResponseEvent')
    assert.equal(parsed.payload.content, 'hello')
  })

  it('transforms Kiro EventStream responses into OpenAI JSON responses', async () => {
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: 'Hello' })),
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: ' there' })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 11, outputTokens: 3 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.headers.get('content-type'), 'application/json')
    assert.equal(data.choices[0].message.role, 'assistant')
    assert.equal(data.choices[0].message.content, 'Hello there')
    assert.equal(data.usage.prompt_tokens, 11)
    assert.equal(data.usage.completion_tokens, 3)
  })

  it('transforms Kiro EventStream exception frames into OpenAI error responses', async () => {
    const bytes = Buffer.from(encodeKiroFrame({
      ':message-type': 'exception',
      ':exception-type': 'ThrottlingException',
    }, { message: 'Rate exceeded' }))
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.status, 502)
    assert.equal(data.error.message, 'Rate exceeded')
    assert.equal(data.error.type, 'kiro_error')
    assert.equal(data.error.code, 'ThrottlingException')
  })

  it('assembles Kiro streaming tool call input.raw fragments into complete arguments', async () => {
    // Kiro sends toolUseEvent multiple times for the same toolId:
    // first with {toolUseId, name} announcing the tool, then with {toolUseId, input: {raw: "fragment"}}
    // carrying partial JSON fragments that must be concatenated.
    const toolId = 'tool-use-id-123'
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, name: 'exec', input: null })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: '{"command"' } })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: ': "echo hi"}' } })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 5, outputTokens: 2 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(data.choices[0].finish_reason, 'tool_calls')
    assert.equal(data.choices[0].message.tool_calls.length, 1)
    const tc = data.choices[0].message.tool_calls[0]
    assert.equal(tc.id, toolId)
    assert.equal(tc.function.name, 'exec')
    assert.equal(tc.function.arguments, '{"command": "echo hi"}')
  })

  it('does not add Kiro SDK headers for non-Kiro providers', () => {
    const headers = buildProviderRequestHeaders('openrouter', {
      apiKey: 'openrouter-key',
    })

    assert.equal(headers['User-Agent'], undefined)
    assert.equal(headers['X-Amz-User-Agent'], undefined)
  })

  it('retries optional providers with bearer auth when an unauthenticated probe is rejected', () => {
    const config = {
      apiKeys: { opencode: 'opencode-key' },
      providers: { opencode: { useBearerAuth: false } },
    }

    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Missing API key.'),
      true
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Unauthorized'),
      true
    )
  })

  it('does not retry optional providers with bearer auth when there is no fallback key or a token was already used', () => {
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: {}, providers: { opencode: { useBearerAuth: false } } }, 'opencode', { token: null }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { opencode: 'opencode-key' } }, 'opencode', { token: 'already-used' }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { openrouter: 'openrouter-key' } }, 'openrouter', { token: null }, '401', 'Unauthorized'),
      false
    )
  })
})

describe('Devin browser OAuth', () => {
  it('builds the omp-style Devin authorize URL', () => {
    const url = buildDevinOAuthLoginUrl({
      codeChallenge: 'challenge-abc',
      state: 'state-123',
      redirectUri: 'http://127.0.0.1:59653/callback',
    })
    assert.ok(url.startsWith('https://app.devin.ai/auth/cli/continue?'))
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('response_type'), 'code')
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:59653/callback')
    assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-abc')
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(parsed.searchParams.get('state'), 'state-123')
    assert.equal(parsed.searchParams.get('prompt'), 'select_account')
    assert.equal(parsed.searchParams.get('client_id'), null)
  })

  it('exchanges an authorization code for a Devin session token', async () => {
    let captured = null
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return new Response(JSON.stringify({ token: 'devin-jwt-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const { token } = await exchangeDevinOAuthCode('auth-code-1', 'verifier-1', { fetchImpl })
    assert.equal(token, 'devin-jwt-1')
    assert.equal(captured.url, 'https://api.devin.ai/auth/cli/token')
    assert.equal(captured.opts.method, 'POST')
    assert.equal(captured.opts.headers['Content-Type'], 'application/json')
    assert.equal(captured.opts.headers.Accept, 'application/json')
    assert.deepEqual(JSON.parse(captured.opts.body), { code: 'auth-code-1', code_verifier: 'verifier-1' })
  })

  it('surfaces readable errors from a failed Devin token exchange', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
    await assert.rejects(
      exchangeDevinOAuthCode('bad-code', 'verifier-1', { fetchImpl }),
      /invalid_grant/
    )
  })

  it('runs a full loopback flow through start/status/cancel', async () => {
    const started = await startDevinOAuthFlow()
    try {
      assert.ok(started.flowId)
      assert.equal(started.autoCallback, true)
      assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:5965[0-9]\/callback$/)
      assert.ok(started.authUrl.startsWith('https://app.devin.ai/auth/cli/continue?'))
      const parsed = new URL(started.authUrl)
      assert.equal(parsed.searchParams.get('redirect_uri'), started.redirectUri)
      assert.equal(parsed.searchParams.get('state'), started.state)

      const pending = getDevinOAuthFlowStatus(started.flowId)
      assert.equal(pending.status, 'pending')

      assert.equal(cancelDevinOAuthFlow(started.flowId), true)
      assert.equal(getDevinOAuthFlowStatus(started.flowId).status, 'missing')
    } finally {
      cancelDevinOAuthFlow(started.flowId)
    }
  })

  it('rejects manual code exchange when the state does not match', async () => {
    const started = await startDevinOAuthFlow()
    try {
      await assert.rejects(
        exchangeDevinOAuthFlow(started.flowId, 'some-code', 'wrong-state'),
        /state did not match/
      )
    } finally {
      cancelDevinOAuthFlow(started.flowId)
    }
  })
})

describe('user-defined model tags', () => {
  it('normalizes and deduplicates tag input', () => {
    assert.equal(normalizeTag(' Code Review! '), 'code-review')
    assert.deepEqual(normalizeTags(['Fast', 'fast', 'agentic']), ['fast', 'agentic'])
  })

  it('stores tags under the canonical model id shared by providers', () => {
    const config = {}
    const updated = setModelTags(config, 'minimax-m2.5-free', ['Coding', 'agentic'])
    assert.equal(updated.key, 'minimax/minimax-m2.5')
    assert.deepEqual(getUserModelTags(config, 'minimax/minimax-m2.5:free'), ['coding', 'agentic'])
    assert.deepEqual(getConfiguredTagNames(config), ['agentic', 'coding'])
    assert.equal(getModelTagKey('minimax-m2.5-free'), 'minimax/minimax-m2.5')
  })

  it('clears persisted entries when the last tag is removed', () => {
    const config = { modelTags: { 'openai/gpt-oss-120b': ['general'] } }
    setModelTags(config, 'openai/gpt-oss-120b:free', [])
    assert.deepEqual(config.modelTags, {})
  })

  it('routes tag requests across all matching provider rows', () => {
    const results = [
      mockResult({ modelId: 'one', tags: ['coding'] }),
      mockResult({ modelId: 'two', tags: ['fast', 'coding'] }),
      mockResult({ modelId: 'three', tags: ['reasoning'] }),
    ]
    assert.deepEqual(filterModelsByRequested(results, 'tag:coding').map(model => model.modelId), ['one', 'two'])
    assert.deepEqual(filterModelsByRequested(results, 'tag:missing'), [])
    assert.deepEqual(filterModelsByRequested(results, 'tag:'), [])
  })

  it('filters tag requests by a min_ctx modifier', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['general'], ctx: '32k' }),
      mockResult({ modelId: 'large', tags: ['general'], ctx: '1m' }),
      mockResult({ modelId: 'maximum-only', tags: ['general'], ctx: '1m', ctxSource: 'model-maximum' }),
      mockResult({ modelId: 'no-ctx', tags: ['general'], ctx: null }),
      mockResult({ modelId: 'wrong-tag', tags: ['coding'], ctx: '1m' }),
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32000').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Exact boundary: a 32k model satisfies a 32000-token floor.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32001').map(m => m.modelId),
      ['large'],
    )
    // Shorthand k/m suffixes on the modifier value itself.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:1m').map(m => m.modelId),
      ['large'],
    )
    // No modifier -- unchanged plain tag behavior, unparseable/missing ctx included.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general').map(m => m.modelId),
      ['small', 'medium', 'large', 'maximum-only', 'no-ctx'],
    )
  })

  it('ignores unknown or malformed tag modifiers instead of rejecting the request', () => {
    const results = [mockResult({ modelId: 'one', tags: ['general'], ctx: '128k' })]
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+unknown_modifier:whatever').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:not-a-number').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+').map(m => m.modelId),
      ['one'],
    )
  })

  it('filters smartest by min_ctx regardless of capability tags (issue #42)', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['coding'], ctx: '128k' }),
      mockResult({ modelId: 'large', ctx: '1m' }), // no tags at all -- still eligible
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'smartest+min_ctx:128k').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Plain smartest is untouched -- still returns everything for the ranking stage.
    assert.deepEqual(
      filterModelsByRequested(results, 'smartest').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
    // A malformed/unknown modifier falls back to plain smartest behavior.
    assert.deepEqual(
      filterModelsByRequested(results, 'smartest+bogus:xyz').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
  })

  it('normalizes persisted model tags safely', () => {
    const normalized = normalizeConfigShape({
      modelTags: {
        ' Model/One ': [' Fast ', 'fast', 'Code Review!', null],
        broken: 'not-an-array',
      },
    })
    assert.deepEqual(normalized.modelTags, { 'model/one': ['fast', 'code-review'] })
  })
})

describe('OpenRouter model quality scoring', () => {
  const catalog = [
    {
      id: 'vendor/direct-model',
      created: 1_750_000_000,
      context_length: 131072,
      supported_parameters: ['reasoning', 'tools', 'structured_outputs'],
      benchmarks: {
        artificial_analysis: { intelligence_index: 72 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1300 }],
      },
    },
    {
      id: 'vendor/training-model',
      benchmarks: {
        artificial_analysis: { intelligence_index: 52 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1100 }],
      },
    },
    {
      id: 'vendor/arena-only:free',
      benchmarks: {
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1200 }],
      },
    },
    {
      id: 'vendor/metadata-only:free',
      created: 1_750_000_000,
      context_length: 262144,
      supported_parameters: ['reasoning', 'tools'],
    },
  ]

  it('normalizes provider and runtime variants for cross-catalog matching', () => {
    assert.ok(qualityLookupKeys('deepseek-v4-flash:0731').includes('deepseek-v4-flash-0731'))
    assert.ok(qualityLookupKeys('inclusionai/ling-3.0-flash:free').includes('ling-3.0-flash'))
  })

  it('fits a deterministic linear regression for Design Arena conversion', () => {
    assert.deepEqual(fitLinearRegression([[1000, 40], [1200, 60]]), {
      slope: 0.1,
      intercept: -60,
      sampleSize: 2,
    })
  })

  it('uses the AA index, then a Design Arena Elo, then metadata in that order', () => {
    const quality = buildOpenRouterQualityIndex(catalog, [...catalog].reverse(), 1_760_000_000_000)
    const direct = resolveModelQuality(quality, 'vendor/direct-model', 0.99)
    const arena = resolveModelQuality(quality, 'arena-only-free', 0.99)
    const metadata = resolveModelQuality(quality, 'vendor/metadata-only:free', 0.99)

    // AA's own rating is the displayed value, on AA's own 0-100 scale. The row's
    // 0-1 score is that same index read back as its position in the measured
    // distribution (72 is the highest of [52, 72] -> the top of the range), so the
    // column and everything that orders rows agree.
    assert.equal(direct.aa, 72)
    assert.equal(direct.score, 0.95)
    assert.equal(aaForPercentile(direct.score, [52, 72]), direct.aa)
    assert.equal(direct.aaEstimated, false)
    assert.equal(direct.source, 'artificial-analysis')
    assert.equal(direct.isEstimated, false)
    // No AA rating, but a Design Arena Elo: the AA index is interpolated from it
    // through the two anchors above (0.1 per Elo point) and flagged as an estimate.
    assert.equal(arena.aa, 62)
    assert.equal(arena.score, 0.5)    // midway between the only two measured values
    assert.equal(aaForPercentile(arena.score, [52, 72]), arena.aa)
    assert.equal(arena.aaEstimated, true)
    assert.equal(arena.source, 'design-arena')
    assert.match(arena.detail, /AA interpolated/)
    assert.equal(metadata.source, 'metadata')
    assert.ok(metadata.score >= 0.35 && metadata.score <= 0.65)
    // Metadata is placed on the AA scale by percentile, so it still has a number.
    assert.ok(metadata.aa > 0)
  })

  it('labels local and blind defaults when no catalog match exists', () => {
    const quality = buildOpenRouterQualityIndex(catalog)
    assert.equal(resolveModelQuality(quality, 'unknown/local', 0.61).source, 'local-fallback')
    const blind = resolveModelQuality(quality, 'unknown/blind')
    assert.equal(blind.score, null)
    assert.equal(blind.source, 'default-fallback')
  })
})

describe('LMArena Elo leaderboard parsing', () => {
  it('extracts the entries array from a Next.js RSC payload', () => {
    // Real payload shape captured from lmarena.ai/leaderboard/text/coding.
    const rsc = `a:["$","$L31",null,{"leaderboard":{"id":"leaderboard-sets/public/leaderboards/text-coding-style_control/leaderboard-snapshots/latest","entries":[{"rank":1,"modelDisplayName":"claude-opus-4-7-high","rating":1551.55,"votes":17212},{"rank":2,"modelDisplayName":"deepseek-v4-pro-high-20260813","rating":1530.1,"votes":1000}]}}]`
    const entries = extractLMArenaEntries(rsc)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].displayName, 'claude-opus-4-7-high')
    assert.equal(entries[0].elo, 1551.55)
    assert.equal(entries[0].votes, 17212)
  })

  it('returns [] for payloads without an entries array', () => {
    assert.deepEqual(extractLMArenaEntries('{"foo":"bar"}'), [])
    assert.deepEqual(extractLMArenaEntries(''), [])
    assert.deepEqual(extractLMArenaEntries(null), [])
  })

  it('ignores braces inside string values while scanning', () => {
    const rsc = `{"entries":[{"modelDisplayName":"weird {model} [v2]","rating":1200,"votes":3}]}`
    assert.equal(extractLMArenaEntries(rsc).length, 1)
  })
})

describe('LMArena Elo model matching', () => {
  const boards = {
    coding: [
      { displayName: 'gpt-oss-20b', elo: 1370, votes: 2184 },
      { displayName: 'llama-3.3-70b-instruct', elo: 1346, votes: 8757 },
      { displayName: 'mistral-small-2506', elo: 1350, votes: 500 },
    ],
    overall: [
      { displayName: 'claude-sonnet-4-5-20250929', elo: 1455, votes: 80858 },
      { displayName: 'nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4', elo: 1348, votes: 3392 },
      { displayName: 'deepseek-v4-flash', elo: 1436, votes: 49001 },
      { displayName: 'glm-5.2-max', elo: 1470, votes: 30637 },
      { displayName: 'hy3', elo: 1457, votes: 5877 },
      { displayName: 'inkling', elo: 1440, votes: 18488 },
    ],
  }

  it('matches :free variants to their base LMArena entry', () => {
    const m = findLMArenaEntry('nvidia/nemotron-3.5-lightning:free', boards)
    assert.ok(m)
    assert.equal(m.displayName, 'nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4')
    assert.equal(m.board, 'overall')
  })

  it('uses the curated alias map when tokens disagree', () => {
    const m = findLMArenaEntry('z-ai/glm-5.2:free', boards)
    assert.ok(m)
    assert.equal(m.displayName, 'glm-5.2-max')
  })

  it('falls back to the overall board when the model is absent from the coding board', () => {
    const m = findLMArenaEntry('claude-sonnet-4.5', boards)
    assert.ok(m)
    assert.equal(m.board, 'overall')
    assert.equal(m.displayName, 'claude-sonnet-4-5-20250929')
  })

  it('prefers the coding board when a model is listed on both boards', () => {
    // Mirrors the live boards: gpt-oss-120b appears on the overall board only
    // because it just makes the served top-of-board cutoff (Elo == board floor),
    // while its coding rating is the meaningful one. The overall entry's larger
    // vote count must not win the tie.
    const dual = {
      coding: [
        { displayName: 'gpt-oss-120b', elo: 1391, votes: 6336 },
        { displayName: 'gpt-oss-20b', elo: 1370, votes: 2184 },
      ],
      overall: [
        { displayName: 'gpt-oss-120b', elo: 1352, votes: 29955 },
      ],
    }
    const m = findLMArenaEntry('openai/gpt-oss-120b', dual)
    assert.ok(m)
    assert.equal(m.board, 'coding')
    assert.equal(m.displayName, 'gpt-oss-120b')
    assert.equal(m.elo, 1391)
  })

  it('keeps the GPT-OSS family on one board so the 120B outranks the 20B', () => {
    const dual = {
      coding: [
        { displayName: 'gpt-oss-120b', elo: 1391, votes: 6336 },
        { displayName: 'gpt-oss-20b', elo: 1370, votes: 2184 },
      ],
      overall: [
        { displayName: 'gpt-oss-120b', elo: 1352, votes: 29955 },
      ],
    }
    const m120 = findLMArenaEntry('openai/gpt-oss-120b', dual)
    const m20 = findLMArenaEntry('openai/gpt-oss-20b', dual)
    assert.equal(m120.board, 'coding')
    assert.equal(m20.board, 'coding')
    // The AA index is interpolated from the same board rating, and that interpolation
    // is monotonic, so the 120B still outranks the 20B on the metric the dashboard and
    // the router actually use.
    const regression = fitLinearRegression([[1370, 12], [1391, 20]])
    assert.ok(predictAAFromElo(m120.elo, regression) > predictAAFromElo(m20.elo, regression))
  })

  it('keeps size tokens distinct (gpt-oss-20b vs gpt-oss-120b)', () => {
    assert.ok(lmArenaMatchScore('openai/gpt-oss-20b', 'gpt-oss-20b') > 0)
    assert.equal(lmArenaMatchScore('openai/gpt-oss-20b', 'gpt-oss-120b'), 0)
  })

  it('rejects version mismatches (gemini-3 vs gemini-3.7)', () => {
    assert.equal(lmArenaMatchScore('gemini-3-flash-preview', 'gemini-3.7-flash-high'), 0)
    assert.ok(lmArenaMatchScore('gemini-3.7-flash', 'gemini-3.7-flash-high') > 0)
  })

  it('returns null when nothing matches', () => {
    assert.equal(findLMArenaEntry('cohere/north-mini-code:free', boards), null)
    assert.equal(findLMArenaEntry('totally-unknown-model', boards), null)
    assert.equal(findLMArenaEntry('x', null), null)
  })

  it('interpolates a higher AA index from a higher Elo rating', () => {
    // Both board sources feed one AA-from-Elo regression, so the ordering the old
    // percentile scale guaranteed has to survive the mapping.
    const regression = fitLinearRegression([[1348, 9], [1436, 18], [1470, 24]])
    const low = predictAAFromElo(1348, regression)
    const mid = predictAAFromElo(1436, regression)
    const high = predictAAFromElo(1470, regression)
    assert.ok(low < mid && mid < high, `expected a monotonic mapping, got ${low}/${mid}/${high}`)
    // A non-finite rating has no prediction rather than a default.
    assert.equal(predictAAFromElo('nope', regression), null)
  })
})

describe('LMArena Elo priority in score resolution', () => {
  const catalog = [
    {
      id: 'vendor/direct-model',
      created: 1_750_000_000,
      context_length: 131072,
      supported_parameters: ['reasoning', 'tools', 'structured_outputs'],
      benchmarks: {
        artificial_analysis: { coding_index: 72, intelligence_index: 60 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1300 }],
      },
    },
  ]
  const boards = {
    coding: [{ displayName: 'direct-model', elo: 1400, votes: 5000 }],
    overall: [{ displayName: 'direct-model', elo: 1500, votes: 9000 }],
  }

  it('prefers the measured AA rating over an Elo interpolation', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    quality.lmArenaBoards = boards
    quality.aaFromEloRegression = fitAAFromEloRegression(catalog, boards)
    // The model is listed on both boards *and* carries an AA rating. The measured AA
    // index wins: a rating AA recorded beats one interpolated from an Elo.
    const direct = resolveModelQuality(quality, 'vendor/direct-model', 0.99)
    assert.equal(direct.source, 'artificial-analysis')
    assert.equal(direct.isEstimated, false)
    assert.equal(direct.aaEstimated, false)
    assert.equal(direct.aa, 60)
    assert.match(direct.detail, /AA intelligence index 60/)
    // The catalog holds a single measured index, so the row's percentile position
    // within it is the midpoint rather than an invented range.
    assert.equal(direct.score, 0.5)
  })

  it('falls back to the catalog index when LMArena has no match', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    quality.lmArenaBoards = boards
    // No LMArena match -> catalog lookup; no catalog match -> local fallback.
    const local = resolveModelQuality(quality, 'vendor/no-elo-match', 0.99)
    assert.equal(local.source, 'local-fallback')
    const blind = resolveModelQuality(quality, 'vendor/no-elo-match')
    assert.equal(blind.source, 'default-fallback')
  })

  it('keeps old behavior when no boards are attached', () => {
    const quality = buildOpenRouterQualityIndex(catalog, [...catalog].reverse(), 1_760_000_000_000)
    const direct = resolveModelQuality(quality, 'vendor/direct-model', 0.99)
    assert.equal(direct.source, 'artificial-analysis')
    assert.equal(direct.isEstimated, false)
  })
})

describe('Artificial Analysis index mapping', () => {
  const catalog = [
    { id: 'vendor/alpha', benchmarks: { artificial_analysis: { intelligence_index: 40 }, design_arena: [{ arena: 'models', category: 'codecategories', elo: 1050 }] } },
    { id: 'vendor/beta', benchmarks: { artificial_analysis: { intelligence_index: 60 }, design_arena: [{ arena: 'models', category: 'codecategories', elo: 1250 }] } },
    { id: 'vendor/gamma', benchmarks: { artificial_analysis: { intelligence_index: 80 } } },
    { id: 'vendor/delta', benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
    { id: 'vendor/epsilon', benchmarks: { artificial_analysis: { intelligence_index: 20 } } },
    { id: 'vendor/arena-only', benchmarks: { design_arena: [{ arena: 'models', category: 'codecategories', elo: 1200 }] } },
    { id: 'vendor/meta-only', created: 1_750_000_000, context_length: 262144, supported_parameters: ['reasoning', 'tools'] },
  ]
  const boards = {
    overall: [
      { displayName: 'alpha', elo: 1100, votes: 100 },
      { displayName: 'beta', elo: 1300, votes: 100 },
      { displayName: 'gamma', elo: 1500, votes: 100 },
    ],
    coding: [],
  }

  it('reads an AA index only when the catalog actually carries one', () => {
    assert.equal(getArtificialAnalysisIndex({ benchmarks: { artificial_analysis: { intelligence_index: 42 } } }), 42)
    // A missing metric has to stay absent: Number(null) is 0, and a 0 both scores
    // the model as the worst in the app and suppresses the Elo interpolation that
    // should have covered it.
    assert.equal(getArtificialAnalysisIndex({ benchmarks: { artificial_analysis: {} } }), null)
    assert.equal(getArtificialAnalysisIndex({ benchmarks: { artificial_analysis: { intelligence_index: null } } }), null)
    assert.equal(getArtificialAnalysisIndex({ benchmarks: { artificial_analysis: { intelligence_index: '' } } }), null)
    assert.equal(getArtificialAnalysisIndex({ benchmarks: {} }), null)
    assert.equal(getArtificialAnalysisIndex(null), null)
    // A measured 0 is a rating, not an absence.
    assert.equal(getArtificialAnalysisIndex({ benchmarks: { artificial_analysis: { intelligence_index: 0 } } }), 0)
  })

  it('fits an AA-from-Elo regression over the models that carry both', () => {
    const regression = fitAAFromEloRegression(catalog, boards)
    assert.ok(regression)
    assert.equal(regression.sampleSize, 3)
    assert.equal(regression.slope, 0.1)
    assert.equal(regression.intercept, -70)
    assert.equal(regression.aaMin, 40)
    assert.equal(regression.aaMax, 80)
  })

  it('returns null without at least two anchor points', () => {
    assert.equal(fitAAFromEloRegression([catalog[0]], boards), null)
    assert.equal(fitAAFromEloRegression([], boards), null)
    assert.equal(fitAAFromEloRegression(catalog, { overall: [], coding: [] }), null)
  })

  it('interpolates an AA index from an Elo for a model AA has no rating for', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    // The catalog index interpolates from the Design Arena Elo — the only Elo a
    // catalog entry carries — through the two anchors above: 0.1 per Elo point.
    const arena = resolveModelQuality(quality, 'vendor/arena-only', 0.99)
    assert.equal(arena.source, 'design-arena')
    assert.equal(arena.aa, 55)          // 1200 * 0.1 - 65
    assert.equal(arena.score, 0.6125)   // 55 sits midway between 50 and 60
    assert.equal(aaForPercentile(arena.score, quality.aaValues), arena.aa)
    assert.equal(arena.aaEstimated, true)
  })

  it('clamps an interpolated AA index to the range AA actually recorded', () => {
    // Design Arena Elo 900 extrapolates to AA 25, below every anchor -> 40.
    const quality = buildOpenRouterQualityIndex([
      ...catalog,
      { id: 'vendor/weak', benchmarks: { design_arena: [{ arena: 'models', category: 'codecategories', elo: 900 }] } },
    ], catalog, 1_760_000_000_000)
    assert.equal(resolveModelQuality(quality, 'vendor/weak', 0.99).aa, 40)
  })

  it('prefers a measured AA rating over an Elo interpolation and over the local score', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    quality.lmArenaBoards = boards
    quality.aaFromEloRegression = fitAAFromEloRegression(catalog, boards)
    // gamma is AA-rated and also on the board: AA's own rating wins.
    const measured = resolveModelQuality(quality, 'vendor/gamma', 0.99)
    assert.equal(measured.source, 'artificial-analysis')
    assert.equal(measured.aa, 80)
    assert.equal(measured.aaEstimated, false)
    // A local score never displaces a catalog AA rating either.
    assert.equal(resolveModelQuality(quality, 'vendor/delta', 0.99).aa, 50)
    assert.equal(resolveModelQuality(quality, 'vendor/epsilon', 0.99).aa, 20)
  })

  it('interpolates an AA index from an LMArena Elo when AA has no rating', () => {
    const eloOnly = [{ id: 'vendor/boards-only', created: 1_750_000_000, context_length: 131072 }]
    const quality = buildOpenRouterQualityIndex(eloOnly, eloOnly, 1_760_000_000_000)
    quality.lmArenaBoards = { overall: [{ displayName: 'boards-only', elo: 1250, votes: 900 }], coding: [] }
    quality.aaFromEloRegression = { slope: 0.1, intercept: -100, aaMin: 10, aaMax: 40, sampleSize: 12 }
    const result = resolveModelQuality(quality, 'vendor/boards-only', 0.99)
    assert.equal(result.source, 'lmarena-overall')
    assert.equal(result.aa, 25)          // 1250 * 0.1 - 100
    // This catalog carries no measured index at all, so there is no distribution to
    // read a position from and the score falls back to the raw 0-100 reading.
    assert.equal(result.score, 0.25)
    assert.equal(result.aaEstimated, true)
    assert.match(result.detail, /LMArena overall Elo 1250 \(900 votes\); AA interpolated \(n=12\)/)
  })

  it('places metadata and local estimates on the AA scale by percentile', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    const metadata = resolveModelQuality(quality, 'vendor/meta-only', 0.99)
    assert.equal(metadata.source, 'metadata')
    assert.ok(metadata.score >= 0.35 && metadata.score <= 0.65)
    assert.equal(metadata.aa, aaForPercentile(metadata.score, quality.aaValues))
    assert.equal(metadata.aaEstimated, true)

    const offline = resolveModelQuality(quality, 'vendor/unknown-offline', 0.5)
    assert.equal(offline.source, 'local-fallback')
    assert.equal(offline.aa, aaForPercentile(0.5, quality.aaValues))
    assert.equal(offline.aa, 50)         // the median of [20, 40, 50, 60, 80]
    assert.equal(offline.aaEstimated, true)
  })

  it('leaves the index absent when nothing can place a model', () => {
    const quality = buildOpenRouterQualityIndex(catalog, catalog, 1_760_000_000_000)
    const blind = resolveModelQuality(quality, 'totally/unknown')
    assert.equal(blind.source, 'default-fallback')
    assert.equal(blind.score, null)
    assert.equal(blind.aa, null)
  })

  it('restates an Elo-scale slope-line selector in AA units', () => {
    const regression = { slope: 0.1, intercept: -70, aaMin: 40, aaMax: 80, sampleSize: 3 }
    assert.deepEqual(convertSelectorToAaScale({ slope: 400, minSpeed: 0.002, minIntell: 1400 }, regression), {
      slope: 40,
      minSpeed: 0.002,
      minIntell: 70,
      intellScale: 'aa',
    })
    // The floor is translated on the raw line, not clamped to the AA band the
    // anchors recorded: that clamp would saturate a high floor at the top of the
    // catalog and exclude every model instead of translating it.
    assert.equal(convertSelectorToAaScale({ minIntell: 1600 }, regression).minIntell, 90)
    // Nothing configured to convert, or no regression to convert with, converts nothing.
    assert.equal(convertSelectorToAaScale({ slope: null, minIntell: null }, regression), null)
    assert.equal(convertSelectorToAaScale({ slope: 10, minIntell: 1400 }, null), null)
    assert.equal(convertSelectorToAaScale({ slope: 10 }, { slope: NaN, intercept: 0 }), null)
  })

  it('reads an index back to the score position it came from', () => {
    const aaValues = [20, 40, 50, 60, 80]
    // The two directions are exact inverses. That is what keeps a row's score and
    // its displayed index from disagreeing about which row is smarter.
    for (const value of [20, 25, 40, 55, 60, 79, 80]) {
      assert.equal(aaForPercentile(scoreForAa(value, aaValues), aaValues), value)
    }
    assert.equal(scoreForAa(80, aaValues), 0.95)   // the top of the measured range
    assert.equal(scoreForAa(20, aaValues), 0.05)   // the bottom, and the floor
    assert.equal(scoreForAa(5, aaValues), 0.05)    // below it: still the floor
    // A single measured value has no range to sit in, so every row is the midpoint.
    assert.equal(scoreForAa(42, [42]), 0.5)
    // Repeated values are common in a real catalog (137 measured models collapse to
    // 81 distinct indexes), and a zero-width segment must not divide by zero —
    // including one at the bottom, which is the first segment a value can land in.
    assert.equal(scoreForAa(50, [20, 50, 50, 80]), 0.35)
    assert.equal(scoreForAa(20, [20, 20, 50]), 0.05)
    // No measured distribution at all: the raw 0-100 reading is the same scale.
    assert.equal(scoreForAa(25, []), 0.25)
    assert.equal(scoreForAa('nope', aaValues), null)
  })

  it('scores a measured model above a heuristic one, so routing can tell them apart', () => {
    // The dashboard sorts on the score while displaying the index, and QoS turns the
    // score into a percentile of the curated reference distribution. Scoring a
    // measured index as `aa / 100` put the measured half of the catalog below the
    // heuristic estimates on that scale: the live catalog sorted a 30-point estimate
    // above a 53-point measurement, and `best` routed to the unmeasured model.
    //
    // A realistic index spread is required to see it — AA's own indices run ~4-53,
    // not 0-100 — paired with the most favourable heuristic the estimator can
    // produce, so the two scales genuinely collide rather than by luck.
    const unmeasured = {
      id: 'vendor/unmeasured-flagship',
      created: 1_755_000_000,
      context_length: 262144,
      supported_parameters: ['reasoning', 'tools', 'structured_outputs'],
    }
    const realistic = [
      unmeasured,                                                    // rank 1 of the popularity list
      { id: 'vendor/tiny', benchmarks: { artificial_analysis: { intelligence_index: 3.8 } } },
      { id: 'vendor/mid', benchmarks: { artificial_analysis: { intelligence_index: 30 } } },
      { id: 'vendor/best-measured', benchmarks: { artificial_analysis: { intelligence_index: 53.4 } } },
    ]
    const quality = buildOpenRouterQualityIndex(realistic, realistic, 1_760_000_000_000)
    const measured = resolveModelQuality(quality, 'vendor/best-measured', 0.99)
    const heuristic = resolveModelQuality(quality, 'vendor/unmeasured-flagship', 0.99)
    assert.equal(measured.source, 'artificial-analysis')
    assert.equal(heuristic.source, 'metadata')
    assert.equal(measured.aa, 53.4)
    assert.ok(measured.score > heuristic.score, `expected score ${measured.score} > ${heuristic.score}`)
    // The estimate still reads on the same scale, it just cannot claim the top.
    assert.ok(heuristic.aa < measured.aa)

    // Identical speed and uptime: the only difference is how the rows were scored.
    const base = { status: 'up', pings: [{ ms: 1200, code: '200', ts: Date.now() }], uptimeSamples: 10, uptimeOk: 10 }
    const qosMeasured = computeQoS({ ...base, modelId: 'vendor/best-measured', intell: measured.score, aa: measured.aa }, 3000)
    const qosHeuristic = computeQoS({ ...base, modelId: 'vendor/unmeasured-flagship', intell: heuristic.score, aa: heuristic.aa }, 3000)
    assert.ok(qosMeasured > qosHeuristic, `expected QoS ${qosMeasured} > ${qosHeuristic}`)
  })
})

describe('AA scale percentile mapping', () => {
  const aaValues = [40, 50, 60]

  it('maps the endpoints of the percentile range to the AA extremes', () => {
    assert.equal(aaForPercentile(0.05, aaValues), 40)
    assert.equal(aaForPercentile(0.95, aaValues), 60)
  })

  it('maps the median score to the median AA value', () => {
    assert.equal(aaForPercentile(0.5, aaValues), 50)
  })

  it('is monotonic and interpolates between values', () => {
    assert.ok(aaForPercentile(0.3, aaValues) > 40)
    assert.ok(aaForPercentile(0.3, aaValues) < 50)
    assert.ok(aaForPercentile(0.8, aaValues) > 50)
    assert.ok(aaForPercentile(0.8, aaValues) < 60)
  })

  it('returns null for an empty list or a non-finite score', () => {
    assert.equal(aaForPercentile(0.5, []), null)
    assert.equal(aaForPercentile('nope', aaValues), null)
  })
})

describe('dynamic model score resolution', () => {
  it('extracts Ollama model records from tags payloads', () => {
    const payload = {
      models: [
        { name: 'gpt-oss:120b', model: 'gpt-oss:120b' },
        { name: 'llama3.3', model: 'llama3.3' },
      ],
    }

    assert.deepEqual(extractOllamaModelRecords(payload), payload.models)
    assert.deepEqual(extractOllamaModelRecords(null), [])
  })

  it('uses scores.js entries for Ollama models when available', () => {
    const model = toOllamaModelMeta({
      name: 'openai/gpt-oss-120b',
      model: 'openai/gpt-oss-120b',
    })

    assert.ok(model)
    assert.equal(model.providerKey, 'ollama')
    assert.equal(model.label, 'GPT OSS 120B')
    assert.equal(model.isEstimatedScore, false)
  })

  it('keeps GPT OSS 120B outranking 20B in the offline fallback', () => {
    // Regression: the offline scores were inverted so the 20B showed a higher
    // intelligence score than the 120B. The 120B is the larger model and must
    // always outrank the 20B, for both vendor-prefixed and bare keys.
    const sizeKeys = [
      ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      ['gpt-oss-120b', 'gpt-oss-20b'],
    ]
    for (const [big, small] of sizeKeys) {
      const bigScore = getScore(big)
      const smallScore = getScore(small)
      assert.ok(bigScore != null, `${big} should have a score`)
      assert.ok(smallScore != null, `${small} should have a score`)
      assert.ok(bigScore > smallScore, `${big} (${bigScore}) should outrank ${small} (${smallScore})`)
    }
  })

  it('maps Ollama-style aliases like qwen3:4b to existing score entries', () => {
    assert.equal(resolveAliasedModelId('qwen3:4b'), 'qwen/qwen3-4b')
    assert.equal(getScore('qwen3:4b'), 0.542)

    const model = toOllamaModelMeta({
      name: 'qwen3:4b',
      model: 'qwen3:4b',
      details: { family: 'qwen3', parameter_size: '4.0B' },
    })

    assert.ok(model)
    assert.equal(model.label, 'Qwen3:4b')
    assert.equal(model.intell, 0.542)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Devstral Small 2 Ollama IDs to a verified score entry', () => {
    assert.equal(resolveAliasedModelId('devstral-small-2:24b'), 'devstral-small-2-24b')
    assert.equal(getScore('devstral-small-2:24b'), 0.658)

    const model = toOllamaModelMeta({
      name: 'devstral-small-2:24b',
      model: 'devstral-small-2:24b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Devstral Small 2 24B')
    assert.equal(model.intell, 0.658)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps common Ollama cloud aliases onto existing benchmark entries', () => {
    assert.equal(getScore('deepseek-v3.2'), 0.731)
    assert.equal(getScore('cogito-2.1:671b'), 0.42)
    assert.equal(getScore('gemma3:4b'), 0.428)
    assert.equal(getScore('glm-5'), 0.778)
    assert.equal(getScore('kimi-k2.5'), 0.768)
    assert.equal(getScore('mimo-v2-pro-free'), 0.78)
    assert.equal(getScore('minimax-m2.5-free'), 0.802)
    assert.equal(getScore('ministral-3:3b'), 0.548)
    assert.equal(getScore('ministral-3:8b'), 0.616)
    assert.equal(getScore('mistral-large-3:675b'), 0.58)
    assert.equal(getScore('nemotron-3-super'), 0.377)
    assert.equal(getScore('qwen/qwen3.6-plus-preview:free'), 0.68)
    assert.equal(getScore('qwen3-vl:235b'), 0.7)
    assert.equal(getScore('qwen3-vl:235b-instruct'), 0.7)
    assert.equal(getScore('qwen3-coder:480b'), 0.706)
    assert.equal(getScore('qwen3-next:80b'), 0.65)
    assert.equal(getScore('qwen3.5:397b'), 0.68)
  })

  it('applies direct score entries for new cloud-only models we track explicitly', () => {
    assert.equal(getScore('gemini-3-flash-preview'), 0.78)
    assert.equal(getScore('qwen3-coder-next'), 0.706)
    assert.equal(getScore('rnj-1:8b'), 0.208)
  })

  it('resolves researched benchmark scores for newly discovered coding models', () => {
    assert.equal(getScore('arcee-ai/trinity-large-thinking:free'), 0.632)
    assert.equal(getScore('bytedance-seed/dola-seed-2.0-pro:free'), 0.765)
    assert.equal(getScore('glm-5.1'), 0.584)
    assert.equal(getScore('google/gemma-4-26b-a4b-it:free'), 0.393)
    assert.equal(getScore('google/gemma-4-31b-it:free'), 0.8)
    assert.equal(getScore('kimi-k2.6'), 0.802)
  })

  it('maps Gemma 4 Ollama aliases onto researched score entries', () => {
    assert.equal(resolveAliasedModelId('gemma4:26b'), 'google/gemma-4-26b-a4b-it')
    assert.equal(resolveAliasedModelId('gemma4:31b'), 'google/gemma-4-31b-it')
    assert.equal(getScore('gemma4:31b'), 0.8)

    const model = toOllamaModelMeta({
      name: 'gemma4:31b',
      model: 'gemma4:31b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Gemma 4 31B')
    assert.equal(model.intell, 0.8)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Ollama cloud remote models to canonical score entries', () => {
    const model = toOllamaModelMeta({
      name: 'Minimax-m2.7:cloud',
      model: 'Minimax-m2.7:cloud',
      remote_model: 'minimax-m2.7',
    })

    assert.ok(model)
    assert.equal(model.intell, 0.822)
    assert.equal(model.isEstimatedScore, false)
  })

  it('does not apply another provider context to Ollama discovery', () => {
    const model = toOllamaModelMeta({
      name: 'kimi-k2.6',
      model: 'kimi-k2.6',
    })

    assert.ok(model)
    assert.equal(model.label, 'Kimi K2.6')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
  })

  it('uses the allocated Ollama context before the model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _running: { context_length: 4096 },
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '4096')
    assert.equal(model.ctxSource, 'runtime-allocated')
  })

  it('labels an unallocated Ollama model limit as a model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '131072')
    assert.equal(model.ctxSource, 'model-maximum')
  })

  it('keeps MiniMax M-series SWE scores monotonic as versions increase', () => {
    assert.ok(getScore('minimax-m2') < getScore('minimax-m2.1'))
    assert.ok(getScore('minimax-m2.1') < getScore('minimax-m2.5'))
    assert.ok(getScore('minimax-m2.5') < getScore('minimax-m2.7'))
  })

  it('uses scores.js entry for OpenRouter models outside static sources', () => {
    const model = toOpenRouterModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      name: 'Google: Gemma 3N E2B (free)',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered OpenRouter coding models', () => {
    const gemma = toOpenRouterModelMeta({
      id: 'google/gemma-4-31b-it:free',
      name: 'Google: Gemma 4 31B (free)',
      context_length: 262144,
    })

    assert.ok(gemma)
    assert.equal(gemma.label, 'Gemma 4 31B')
    assert.equal(gemma.intell, 0.8)
    assert.equal(gemma.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered OpenRouter free coding models', () => {
    const cases = [
      ['baidu/cobuddy:free', 0.715],
      ['deepseek-v4-flash-free', 0.521],
      ['inclusionai/ring-2.6-1t:free', 0.727],
      ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.138],
      ['poolside/laguna-m.1:free', 0.725],
      ['poolside/laguna-xs.2:free', 0.682],
      ['ring-2.6-1t-free', 0.727],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('uses verified scores for the latest free coding models across providers', () => {
    const cases = [
      ['tencent/hy3:free', 0.78],
      ['hy3-free', 0.78],
      ['poolside/laguna-xs-2.1:free', 0.592],
      ['cohere/north-mini-code:free', 0.365],
      ['north-mini-code-free', 0.365],
      ['nvidia/nemotron-3-ultra-550b-a55b:free', 0.493],
      ['nemotron-3-ultra-free', 0.493],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('resolves every coding model reported by the refresh-scores audit', () => {
    const cases = [
      ['glm-5.2', 0.688],
      ['z-ai/glm-5.2', 0.688],
      ['kimi-k2.7-code', 0.62],
      ['moonshotai/kimi-k2.7-code', 0.62],
      ['mimo-v2.5-free', 0.568],
      ['minimax-m3', 0.586],
      ['minimaxai/minimax-m3', 0.586],
      ['nemotron-3-ultra', 0.493],
      ['stepfun/step-3.7-flash:free', 0.396],
      ['stepfun-ai/step-3.7-flash', 0.396],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('keeps offline fallbacks for the newest discovered free models', () => {
    const cases = [
      ['deepseek-v4-flash:0731', 0.691],
      ['kimi-k3', 0.762],
      ['inclusionai/ling-3.0-flash:free', 0.608],
      ['ling-3.0-flash-free', 0.608],
      ['poolside/laguna-s-2.1:free', 0.625],
      ['laguna-s-2.1-free', 0.625],
    ]
    for (const [modelId, expectedScore] of cases) assert.equal(getScore(modelId), expectedScore)
  })

  it('includes newly available NIM coding models in the static catalog', () => {
    const nvidiaModelIds = new Set(sources.nvidia.models.map(([modelId]) => modelId))
    const expected = [
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.7-code',
      'minimaxai/minimax-m3',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'stepfun-ai/step-3.7-flash',
    ]

    for (const modelId of expected) {
      assert.equal(nvidiaModelIds.has(modelId), true, `Missing NIM model: ${modelId}`)
    }
  })

  it('ignores safety-only dynamic models that should not be routed as coding models', () => {
    assert.equal(toKiloCodeModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toKiloCodeModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free', name: 'NVIDIA: Nemotron 3.5 Content Safety (free)' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free', name: 'NVIDIA: Nemotron 3.5 Content Safety (free)' }), null)
    // ...while genuinely free chat models with image-capable names still pass
    assert.ok(toOpenRouterModelMeta({ id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'NVIDIA: Nemotron 3 Nano Omni 30B A3B Reasoning (free)' }))
    assert.ok(toOpenRouterModelMeta({ id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B IT (free)' }))
  })

  it('admits KiloCode free models flagged by the provider isFree field', () => {
    const autoFree = toKiloCodeModelMeta({ id: 'kilo-auto/free', isFree: true })
    assert.ok(autoFree)
    assert.equal(autoFree.modelId, 'kilo-auto/free')

    const router = toKiloCodeModelMeta({ id: 'openrouter/free', isFree: true })
    assert.ok(router)
    assert.equal(router.modelId, 'openrouter/free')

    // The field is authoritative: without isFree (or the ':free' suffix) the model is not admitted
    assert.equal(toKiloCodeModelMeta({ id: 'kilo-auto/free' }), null)
    assert.equal(toKiloCodeModelMeta({ id: 'kilo-auto/free', isFree: false }), null)
    // ':free' suffix remains a valid free signal when the field is absent
    assert.ok(toKiloCodeModelMeta({ id: 'google/gemma-3n-e2b-it:free' }))
  })

  it('resolves newly discovered OpenCode Zen free models through catalog aliases', () => {
    const nemotron = toOpenCodeModelMeta({ id: 'nemotron-3.5-lightning-free' })
    assert.ok(nemotron)
    assert.equal(resolveAliasedModelId('nemotron-3.5-lightning-free'), 'nvidia/nemotron-3.5-lightning')
    assert.equal(nemotron.providerKey, 'opencode')
  })

  it('uses scores.js entry for KiloCode models when payload omits scores', () => {
    const model = toKiloCodeModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      display_name: 'Gemma 3N E2B',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered KiloCode coding models', () => {
    const model = toKiloCodeModelMeta({
      id: 'arcee-ai/trinity-large-thinking:free',
      display_name: 'Arcee Trinity Large Thinking',
    })

    assert.ok(model)
    assert.equal(model.label, 'Trinity Large Thinking')
    assert.equal(model.intell, 0.632)
    assert.equal(model.isEstimatedScore, false)
  })

  it('applies preferred labels to KiloCode dynamic models', () => {
    const model = toKiloCodeModelMeta({
      id: 'xiaomi/mimo-v2-omni:free',
      display_name: 'xiaomi/mimo-v2-omni:free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiMo V2 Omni')
  })

  it('uses aliased scores.js entries for OpenCode Zen chat models', () => {
    const model = toOpenCodeModelMeta({
      id: 'minimax-m2.5-free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiniMax M2.5')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
  })

  it('does not copy Ling 2.6 context metadata between providers', () => {
    assert.equal(resolveAliasedModelId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(resolveAliasedModelId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
    assert.equal(getScore('ling-2.6-flash-free'), 0.771)
    assert.equal(getScore('inclusionai/ling-2.6-flash:free'), 0.771)
    assert.equal(getPreferredModelContext('ling-2.6-flash-free'), '262k')

    const model = toOpenCodeModelMeta({ id: 'ling-2.6-flash-free' })

    assert.ok(model)
    assert.equal(model.label, 'Ling 2.6 Flash')
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
    assert.equal(model.intell, 0.771)
    assert.equal(model.isEstimatedScore, false)

    const openRouterModel = toOpenRouterModelMeta({
      id: 'inclusionai/ling-2.6-flash:free',
      name: 'inclusionAI: Ling-2.6-flash (free)',
      context_length: 262144,
    })

    assert.ok(openRouterModel)
    assert.equal(openRouterModel.intell, 0.771)
    assert.equal(openRouterModel.ctx, '262144')
    assert.equal(openRouterModel.ctxSource, 'provider-reported')
    assert.equal(openRouterModel.isEstimatedScore, false)
  })

  it('deduplicates missing score audit entries by canonical model id', () => {
    assert.equal(normalizeMissingScoreId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(normalizeMissingScoreId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
  })

  it('includes OpenCode Zen free models that end with -free', () => {
    const qwen = toOpenCodeModelMeta({ id: 'qwen3.6-plus-free' })
    const trinity = toOpenCodeModelMeta({ id: 'trinity-large-preview-free' })
    const flash = toOpenCodeModelMeta({ id: 'mimo-v2-flash-free' })

    assert.ok(qwen)
    assert.equal(qwen.intell, 0.68)
    assert.equal(qwen.isEstimatedScore, false)

    assert.ok(trinity)
    assert.equal(trinity.intell, 0.778)
    assert.equal(trinity.isEstimatedScore, false)

    assert.ok(flash)
    assert.equal(flash.intell, 0.734)
    assert.equal(flash.isEstimatedScore, false)
  })

  it('ignores OpenCode Zen models that are not free/chat-compatible for routing', () => {
    assert.equal(toOpenCodeModelMeta({ id: 'gpt-5.4' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'big-pickle' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'glm-5' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'kimi-k2' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'minimax-m2.5' }), null)
  })

  it('applies preferred MiMo display labels', () => {
    assert.equal(getPreferredModelLabel('mimo-v2-omni-free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-omni:free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-pro:free'), 'MiMo V2 Omni Pro')
    assert.equal(getPreferredModelLabel('x-ai/grok-code-fast-1:optimized:free'), 'Grok Code Fast')
    assert.equal(getPreferredModelLabel('minimax-m2.5-free', 'MiniMax M2.5 Free'), 'MiniMax M2.5')
    assert.equal(getPreferredModelLabel('nemotron-3-super-free', 'Nemotron 3 Super Free'), 'Nemotron 3 Super')
  })

  it('preserves Ollama size tags while stripping runtime suffixes', () => {
    assert.deepEqual(canonicalizeModelId('devstral-small-2:24b'), { base: 'devstral-small-2-24b', unprefixed: 'devstral-small-2-24b' })
    assert.deepEqual(canonicalizeModelId('qwen3:4b'), { base: 'qwen/qwen3-4b', unprefixed: 'qwen3-4b' })
    assert.deepEqual(canonicalizeModelId('gpt-oss:120b'), { base: 'openai/gpt-oss-120b', unprefixed: 'gpt-oss-120b' })
    assert.deepEqual(canonicalizeModelId('Minimax-m2.7:cloud'), { base: 'minimax-m2.7', unprefixed: 'minimax-m2.7' })
    assert.deepEqual(canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free'), { base: 'x-ai/grok-code-fast-1', unprefixed: 'grok-code-fast-1' })
  })
})

describe('getAvg', () => {
  it('returns Infinity with no successful pings', () => {
    assert.equal(getAvg(mockResult({ pings: [] })), Infinity)
    assert.equal(getAvg(mockResult({ pings: [{ ms: 20, code: '500' }] })), Infinity)
  })

  it('uses only HTTP 200 pings', () => {
    const result = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '200' },
        { ms: 800, code: '429' },
      ],
    })
    assert.equal(getAvg(result), 300)
  })

  it('applies sliding window when ts is present', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 100, code: '200', ts: now - 5_000 },
        { ms: 900, code: '200', ts: now - 60_000 },
      ],
    })
    assert.equal(getAvg(result, 10_000), 100)
  })

  it('keeps successful pings within the default long window', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 240, code: '200', ts: now - 20 * 60_000 },
        { ms: 900, code: '200', ts: now - 40 * 60_000 },
      ],
    })
    assert.equal(getAvg(result), 240)
  })
})

describe('getVerdict', () => {
  it('maps overloaded and inactive states', () => {
    assert.equal(getVerdict(mockResult({ httpCode: '429', pings: [{ ms: 0, code: '429' }] })), 'Overloaded')
    assert.equal(getVerdict(mockResult({ status: 'timeout', pings: [{ ms: 0, code: '000' }] })), 'Not Active')
  })

  it('maps unstable when model was previously up', () => {
    const result = mockResult({
      status: 'down',
      pings: [{ ms: 150, code: '200' }, { ms: 0, code: '500' }],
    })
    assert.equal(getVerdict(result), 'Unstable')
  })

  it('maps latency tiers', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 200, code: '200' }] })), 'Perfect')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 600, code: '200' }] })), 'Normal')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 1_600, code: '200' }] })), 'Slow')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 4_000, code: '200' }] })), 'Very Slow')
  })
})

describe('getUptime', () => {
  it('returns percentage of successful pings', () => {
    assert.equal(getUptime(mockResult({ pings: [] })), 0)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 20, code: '200' }] })), 100)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 0, code: '500' }] })), 50)
  })
})

describe('sortResults', () => {
  it('sorts by avg', () => {
    const results = [
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'asc')
    assert.equal(sorted[0].label, 'Fast')
  })

  it('sorts by verdict using VERDICT_ORDER', () => {
    const results = [
      mockResult({ label: 'Pending', pings: [] }),
      mockResult({ label: 'Perfect', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'verdict', 'asc')
    assert.equal(sorted[0].label, 'Perfect')
    assert.equal(VERDICT_ORDER.includes('Pending'), true)
  })

  it('sorts ctx values with k/m suffixes', () => {
    const results = [
      mockResult({ label: 'Small', ctx: '8k' }),
      mockResult({ label: 'Large', ctx: '1m' }),
      mockResult({ label: 'Mid', ctx: '128k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.deepEqual(sorted.map(r => r.label), ['Small', 'Mid', 'Large'])
  })

  it('sorts ctx values with raw token counts and em dashes', () => {
    const results = [
      mockResult({ label: 'Tiny', ctx: '4096' }),
      mockResult({ label: 'NoData', ctx: '—' }),
      mockResult({ label: 'Big', ctx: '1.5M' }),
      mockResult({ label: 'Mid', ctx: '128k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.deepEqual(sorted.map(r => r.label), ['NoData', 'Tiny', 'Mid', 'Big'])
  })

  it('does not mutate the original array', () => {
    const results = [
      mockResult({ label: 'B', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'A', pings: [{ ms: 100, code: '200' }] }),
    ]
    const copy = [...results]
    sortResults(results, 'avg', 'asc')
    assert.equal(results[0].label, copy[0].label)
  })
})

describe('findBestModel', () => {
  it('returns null on empty input', () => {
    assert.equal(findBestModel([]), null)
  })

  it('ignores banned and disabled models', () => {
    const results = [
      mockResult({ label: 'Banned', status: 'banned', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Disabled', status: 'disabled', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Valid', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Valid')
  })

  it('prefers better QoS among eligible models', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 700, code: '200' }, { ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }, { ms: 200, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Faster')
  })

  it('skips proxy-rate-limited models even when their QoS would be highest (regression: dashboard "Current Model" pointed at a wasRateLimited=429 model)', () => {
    // Top-tier intell + low latency + 100% uptime -- every QoS input screams "pick me".
    // The proxy has flagged this model as rate-limited, so it must be excluded.
    const results = [
      mockResult({
        label: 'Gemini 3.7 Flash',
        status: 'up',
        pings: [{ ms: 100, code: '200' }, { ms: 150, code: '200' }],
        intell: 76,
        rateLimit: { wasRateLimited: true, capturedAt: Date.now() },
      }),
      mockResult({
        label: 'Faster',
        status: 'up',
        pings: [{ ms: 200, code: '200' }, { ms: 250, code: '200' }],
        intell: 35,
      }),
    ]
    assert.equal(findBestModel(results).label, 'Faster')
  })
})

describe('rankModelsForRouting', () => {
  it('returns candidates sorted by QoS', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results)
    assert.equal(ranked[0].label, 'Faster')
    assert.equal(ranked[1].label, 'Slower')
  })

  it('excludes requested model IDs and ineligible states', () => {
    const results = [
      mockResult({ modelId: 'a', label: 'A', status: 'up', pings: [{ ms: 100, code: '200' }] }),
      mockResult({ modelId: 'b', label: 'B', status: 'banned', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'c', label: 'C', status: 'disabled', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'd', label: 'D', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results, ['a'])
    assert.deepEqual(ranked.map(r => r.modelId), ['d'])
  })

  it('ranks smartest by AA index, then excludes rate-limited and non-working models', () => {
    const results = [
      mockResult({ modelId: 'highest', label: 'Highest AA', status: 'up', aa: 60, intell: 0.2 }),
      mockResult({ modelId: 'middle', label: 'Middle AA', status: 'up', aa: 55, intell: 0.9 }),
      mockResult({ modelId: 'down', label: 'Down Highest', status: 'down', aa: 99, intell: 0.99 }),
      mockResult({ modelId: 'limited', label: 'Limited', status: 'up', aa: 70, rateLimit: { wasRateLimited: true } }),
    ]
    assert.deepEqual(rankModelsForSmartest(results).map(r => r.modelId), ['highest', 'middle'])
    assert.deepEqual(rankModelsForSmartest(results, ['highest']).map(r => r.modelId), ['middle'])
    // No AA index anywhere in the pool: the local score is the same fallback the
    // dashboard uses.
    assert.deepEqual(rankModelsForSmartest([
      mockResult({ modelId: 'fallback-high', status: 'up', intell: 90 }),
      mockResult({ modelId: 'fallback-low', status: 'up', intell: 10 }),
    ]).map(r => r.modelId), ['fallback-high', 'fallback-low'])
  })

  it('never ranks an unscored row as if it had a zero rating', () => {
    // Number(null) is 0 and 0 is finite, so reading the raw field put every
    // unscored row in the pool as a zero-rated runner-up — above a scored row
    // whenever the model-id tie-break happened to favour it — and it made the
    // intelligence fallback unreachable. Unscored rows come last, but stay
    // reachable so a request still has a candidate.
    const results = [
      mockResult({ modelId: 'aaa-unscored', label: 'Unscored', status: 'up', aa: null, intell: null }),
      mockResult({ modelId: 'mmm-local', label: 'Local', status: 'up', aa: null, intell: 0.5 }),
      mockResult({ modelId: 'zzz-catalog', label: 'Catalog', status: 'up', aa: 30 }),
    ]
    assert.deepEqual(rankModelsForSmartest(results).map(r => r.modelId), ['zzz-catalog', 'mmm-local', 'aaa-unscored'])
    // With no AA index at all the locally scored rows still lead.
    assert.deepEqual(rankModelsForSmartest([
      mockResult({ modelId: 'aaa-unscored', status: 'up', aa: null, intell: null }),
      mockResult({ modelId: 'mmm-local', status: 'up', aa: null, intell: 0.5 }),
    ]).map(r => r.modelId), ['mmm-local', 'aaa-unscored'])
  })

  it('computes the combined speed metric from TTFT and tok/s', () => {
    // 1 / (500 + 1000/100) = 1/510
    assert.ok(Math.abs(computeRowSpeed({ ttft: 500, tps: 100 }) - 1 / 510) < 1e-12)
    assert.equal(computeRowSpeed({ ttft: -1, tps: 100 }), null)
    assert.equal(computeRowSpeed({ ttft: 500, tps: 0 }), null)
    assert.equal(computeRowSpeed({}), null)
    // lastResponse fallback
    assert.ok(Math.abs(computeRowSpeed({ lastResponse: { ttftMs: 500, tps: 100 } }) - 1 / 510) < 1e-12)
  })

  it('selects the first model a slope line touches, honoring minimums', () => {
    // Speeds: slow-genius 1/2020 ≈ 0.000495, mid 1/510 ≈ 0.00196, fast-dumb 1/105 ≈ 0.00952.
    // slow-genius and fast-dumb span the Pareto hull; mid sits above the line
    // joining them, so it is the first touch at intermediate slopes.
    const slowGenius = mockResult({ modelId: 'slow-genius', label: 'SlowGenius', status: 'up', aa: 50, ttft: 2000, tps: 50 })
    const mid = mockResult({ modelId: 'mid', label: 'Mid', status: 'up', aa: 48, ttft: 500, tps: 100 })
    const fastDumb = mockResult({ modelId: 'fast-dumb', label: 'FastDumb', status: 'up', aa: 30, ttft: 100, tps: 200 })
    const results = [slowGenius, mid, fastDumb]

    // Slope 0: the highest AA index wins (line lowered flat).
    assert.equal(selectModelBySlope(results, { slope: 0 }).model.modelId, 'slow-genius')

    // Steep slope: the fast-and-dumb model becomes the first contact.
    assert.equal(selectModelBySlope(results, { slope: 3000 }).model.modelId, 'fast-dumb')

    // Moderate slope lands on the balanced pick on the hull.
    assert.equal(selectModelBySlope(results, { slope: 1800 }).model.modelId, 'mid')

    // Minimum intelligence filters the first geometric hit out (fast-dumb is
    // below 40, so the line falls through to the next model it touches).
    const withMinIntell = selectModelBySlope(results, { slope: 3000, minIntell: 40 })
    assert.equal(withMinIntell.model.modelId, 'mid')

    // Minimum speed filters slow rows even when they would win at low slope.
    const withMinSpeed = selectModelBySlope(results, { slope: 0, minSpeed: 1 / 1000 })
    assert.equal(withMinSpeed.model.modelId, 'mid')

    // Impossible minimums select nothing.
    assert.equal(selectModelBySlope(results, { slope: 0, minIntell: 99999 }), null)

    // Invalid slope is inert.
    assert.equal(selectModelBySlope(results, { slope: null }), null)
    assert.equal(selectModelBySlope(results, { slope: -1 }), null)

    // A slope that is merely absent (null / undefined / '') must read as "no
    // selector". Number(null) is 0, so a bare finite-number check would turn an
    // inert selector into slope 0 and reroute smartest requests through the
    // plot's argmax instead of the Elo ranking.
    assert.equal(selectorSlopeOf({ slope: null }), null)
    assert.equal(selectorSlopeOf({}), null)
    assert.equal(selectorSlopeOf({ slope: '' }), null)
    assert.equal(selectorSlopeOf({ slope: -1 }), null)
    assert.equal(selectorSlopeOf({ slope: 'nope' }), null)
    assert.equal(selectorSlopeOf(undefined), null)
    // ...while a configured 0 (and a numeric string) stays a real setting.
    assert.equal(selectorSlopeOf({ slope: 0 }), 0)
    assert.equal(selectorSlopeOf({ slope: '1234.5' }), 1234.5)

    // Minimums read through the same rule: an unset minimum is not a 0 minimum.
    const zeroMinSpeed = selectModelBySlope(results, { slope: 0, minSpeed: null })
    assert.equal(zeroMinSpeed.model.modelId, 'slow-genius')
    assert.equal(selectModelBySlope(results, { slope: 0, minSpeed: '' }).model.modelId, 'slow-genius')

    // Ineligible rows are skipped: banned, rate-limited, and down models never win.
    const mixed = [
      mockResult({ modelId: 'banned', status: 'banned', aa: 90, ttft: 10, tps: 500 }),
      mockResult({ modelId: 'limited', status: 'up', aa: 85, ttft: 10, tps: 500, rateLimit: { wasRateLimited: true } }),
      mockResult({ modelId: 'down', status: 'down', aa: 80, ttft: 10, tps: 500 }),
      mockResult({ modelId: 'ok', status: 'up', aa: 50, ttft: 10, tps: 500 }),
    ]
    assert.equal(selectModelBySlope(mixed, { slope: 0 }).model.modelId, 'ok')
  })

  it('excludes proxy-rate-limited models (wasRateLimited === true)', () => {
    const results = [
      mockResult({
        modelId: 'rate-limited',
        label: 'RateLimited',
        status: 'up',
        pings: [{ ms: 100, code: '200' }],
        intell: 99,
        rateLimit: { wasRateLimited: true, capturedAt: Date.now() },
      }),
      mockResult({
        modelId: 'healthy',
        label: 'Healthy',
        status: 'up',
        pings: [{ ms: 300, code: '200' }],
        intell: 20,
      }),
    ]

    const ranked = rankModelsForRouting(results)
    assert.deepEqual(ranked.map(r => r.modelId), ['healthy'])
  })
})

describe('rate-limit scoping', () => {
  it('pickKeyLevelRateLimit returns only the key-level credit fields', () => {
    const payload = {
      creditLimit: 10,
      creditRemaining: 4,
      creditResetAt: 123456,
      wasRateLimited: true,
      capturedAt: 999,
      resetRequestsAt: 555,
      limitRequests: 20,
    }
    assert.deepEqual(pickKeyLevelRateLimit(payload), {
      creditLimit: 10,
      creditRemaining: 4,
      creditResetAt: 123456,
    })
  })

  it('pickKeyLevelRateLimit returns null for empty or invalid input', () => {
    assert.equal(pickKeyLevelRateLimit(null), null)
    assert.equal(pickKeyLevelRateLimit({}), null)
    assert.equal(pickKeyLevelRateLimit('nope'), null)
  })

  it('mergeRateLimits lets the secondary payload win and handles nulls', () => {
    assert.deepEqual(mergeRateLimits({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
    assert.deepEqual(mergeRateLimits({ a: 1 }, { a: 2 }), { a: 2 })
    assert.deepEqual(mergeRateLimits(null, { b: 2 }), { b: 2 })
    assert.deepEqual(mergeRateLimits({ a: 1 }, null), { a: 1 })
    assert.equal(mergeRateLimits(null, null), null)
  })

  it('scopes a captured 429 to the model that produced it, keeping same-provider siblings routable', () => {
    const providerKey = 'acme'
    const rateLimited = mockResult({
      modelId: 'acme/model-a',
      providerKey,
      label: 'Acme A',
      status: 'up',
      pings: [{ ms: 100, code: '200' }],
      intell: 99,
    })
    const healthy = mockResult({
      modelId: 'acme/model-b',
      providerKey,
      label: 'Acme B',
      status: 'up',
      pings: [{ ms: 200, code: '200' }],
      intell: 30,
    })
    const otherProvider = mockResult({
      modelId: 'other/model',
      providerKey: 'other',
      label: 'Other',
      status: 'up',
      pings: [{ ms: 300, code: '200' }],
      intell: 10,
    })

    const results = [rateLimited, healthy, otherProvider]
    const captured = { limitRequests: 5, remainingRequests: 0, wasRateLimited: true, capturedAt: Date.now() }
    applyRateLimitCapture(rateLimited, results, captured, null)

    // The model that actually got the 429 is flagged...
    assert.equal(rateLimited.rateLimit.wasRateLimited, true)
    // ...but neither its same-provider sibling nor other providers inherit it.
    assert.ok(!healthy.rateLimit, 'sibling model must not inherit the 429 flag')
    assert.ok(!otherProvider.rateLimit)

    const ranked = rankModelsForRouting(results)
    assert.ok(ranked.includes(healthy), 'healthy same-provider sibling must stay routable')
    assert.ok(!ranked.includes(rateLimited), 'the 429 model itself must be excluded')
    assert.equal(findBestModel(results).modelId, 'acme/model-b')
  })

  it('clears expired 429 state after a successful response but keeps fresh headers', () => {
    const state = reconcileRateLimitState({
      wasRateLimited: true,
      capturedAt: 1,
      resetRequestsAt: 2,
      quota: { quotaId: 'old' },
      limitRequests: 100,
      remainingRequests: 0,
    }, { limitRequests: 100, remainingRequests: 99 }, 200, 10)
    assert.equal(state.wasRateLimited, undefined)
    assert.equal(state.resetRequestsAt, undefined)
    assert.equal(state.quota, undefined)
    assert.equal(state.limitRequests, 100)
    assert.equal(state.remainingRequests, 99)
  })

  it('clears old reset and quota fields after a successful response without headers', () => {
    const state = reconcileRateLimitState({
      wasRateLimited: true, resetRequestsAt: 500, quota: { quotaId: 'old' }, retryAfterMs: 20,
    }, {}, 200, 10)
    assert.equal(state, null)
  })

  it('keeps a future reset and 429 state until the provider window expires', () => {
    const state = reconcileRateLimitState({
      wasRateLimited: true,
      capturedAt: 100,
      resetRequestsAt: 500,
    }, null, 429, 200)
    assert.equal(state.wasRateLimited, true)
    assert.equal(state.resetRequestsAt, 500)
  })

  it('merges OpenRouter key credits provider-wide without leaking per-model 429 state', () => {
    const providerKey = 'openrouter'
    const rateLimited = mockResult({
      modelId: 'openrouter/model-a',
      providerKey,
      label: 'OR A',
      status: 'up',
      pings: [{ ms: 100, code: '200' }],
    })
    const healthy = mockResult({
      modelId: 'openrouter/model-b',
      providerKey,
      label: 'OR B',
      status: 'up',
      pings: [{ ms: 200, code: '200' }],
    })

    const results = [rateLimited, healthy]
    const captured = { limitRequests: 5, remainingRequests: 0, wasRateLimited: true, capturedAt: Date.now() }
    const keyRateLimit = { creditLimit: 10, creditRemaining: 2, creditResetAt: 123456 }

    applyRateLimitCapture(rateLimited, results, captured, keyRateLimit)

    assert.equal(rateLimited.rateLimit.wasRateLimited, true)
    assert.equal(rateLimited.rateLimit.creditLimit, 10)
    // Key credits are shared provider-wide...
    assert.equal(healthy.rateLimit.creditLimit, 10)
    assert.equal(healthy.rateLimit.creditRemaining, 2)
    assert.equal(healthy.rateLimit.creditResetAt, 123456)
    // ...but the sibling must not inherit the 429 flag.
    assert.equal(healthy.rateLimit.wasRateLimited, undefined)
    assert.equal(healthy.rateLimit.capturedAt, undefined)

    const ranked = rankModelsForRouting(results)
    assert.deepEqual(ranked.map(r => r.modelId), ['openrouter/model-b'])
  })

  it('keeps existing per-model data when key credits are merged during ping cycles', () => {
    const providerKey = 'openrouter'
    const r = mockResult({ modelId: 'openrouter/model-a', providerKey, label: 'OR A', status: 'up' })
    const sibling = mockResult({ modelId: 'openrouter/model-b', providerKey, label: 'OR B', status: 'up' })
    sibling.rateLimit = { wasRateLimited: false, capturedAt: 1, limitRequests: 3, resetRequestsAt: 555 }

    const results = [r, sibling]
    const keyRateLimit = { creditLimit: 10, creditRemaining: 2, creditResetAt: 123456 }

    applyRateLimitCapture(r, results, null, keyRateLimit)

    // Sibling keeps its own per-model data and gains the key-level credits.
    assert.equal(sibling.rateLimit.limitRequests, 3)
    assert.equal(sibling.rateLimit.resetRequestsAt, 555)
    assert.equal(sibling.rateLimit.wasRateLimited, false)
    assert.equal(sibling.rateLimit.creditLimit, 10)
  })
})

describe('request security gate', () => {
  it('hostnameOf strips ports and brackets', () => {
    assert.equal(hostnameOf('localhost:7352'), 'localhost')
    assert.equal(hostnameOf('127.0.0.1:7352'), '127.0.0.1')
    assert.equal(hostnameOf('[::1]:7352'), '::1')
    assert.equal(hostnameOf('192.168.1.5'), '192.168.1.5')
    assert.equal(hostnameOf(''), '')
    assert.equal(hostnameOf(null), '')
  })

  it('classifies loopback hostnames and remote addresses', () => {
    assert.equal(isLoopbackHostname('localhost'), true)
    assert.equal(isLoopbackHostname('127.0.0.1'), true)
    assert.equal(isLoopbackHostname('127.8.8.8'), true)
    assert.equal(isLoopbackHostname('::1'), true)
    assert.equal(isLoopbackHostname('192.168.1.5'), false)
    assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('::1'), true)
    assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('10.0.0.4'), false)
  })

  it('blocks cross-origin and rebinding requests in loopback mode', () => {
    // Same-origin / no-origin dashboard calls pass.
    assert.equal(checkApiRequestAllowed({ origin: null, host: 'localhost:7352' }), null)
    assert.equal(checkApiRequestAllowed({ origin: 'http://127.0.0.1:7352', host: '127.0.0.1:7352' }), null)
    // Drive-by exfiltration from a malicious website.
    assert.ok(checkApiRequestAllowed({ origin: 'https://evil.example', host: 'localhost:7352' }))
    // Sandboxed iframes / file:// pages.
    assert.ok(checkApiRequestAllowed({ origin: 'null', host: 'localhost:7352' }))
    // DNS rebinding: page served from an attacker domain that resolves to 127.0.0.1.
    assert.ok(checkApiRequestAllowed({ origin: 'http://evil.example:7352', host: 'evil.example:7352' }))
    // Valid loopback origin on a LAN-bound server is still allowed.
    assert.equal(checkApiRequestAllowed({ origin: 'http://localhost:7352', host: '192.168.1.5:7352', lanMode: true }), null)
  })

  it('allows LAN origins that match the requested host in LAN mode', () => {
    assert.equal(checkApiRequestAllowed({ origin: 'http://192.168.1.5:7352', host: '192.168.1.5:7352', lanMode: true }), null)
    // A malicious website is still blocked even in LAN mode.
    assert.ok(checkApiRequestAllowed({ origin: 'https://evil.example', host: '192.168.1.5:7352', lanMode: true }))
  })
})

describe('latencyScore', () => {
  it('returns 1 at zero latency and 0.5 exactly at the target', () => {
    assert.equal(latencyScore(0, 1000), 1)
    assert.equal(latencyScore(1000, 1000), 0.5)
  })

  it('decays continuously and never saturates to zero', () => {
    const at1s = latencyScore(1_000, 1000)
    const at10s = latencyScore(10_000, 1000)
    const at250s = latencyScore(250_000, 1000)
    assert.ok(at1s > at10s)
    assert.ok(at10s > at250s)
    assert.ok(at250s > 0)
  })

  it('treats missing ping data (Infinity/null avg) as the neutral midpoint', () => {
    assert.equal(latencyScore(Infinity, 1000), 0.5)
    assert.equal(latencyScore(null, 1000), 0.5)
  })

  it('defaults to DEFAULT_QOS_LATENCY_TARGET_MS when no target is given', () => {
    assert.equal(latencyScore(DEFAULT_QOS_LATENCY_TARGET_MS), 0.5)
  })
})

describe('QoS latency weighting (regression: nvidia/z-ai/glm-5.2 sat at a 200-290s avg for ~24h while still ranking near the top by quality score alone)', () => {
  it('a catastrophically slow but high-quality model no longer beats a fast, lower-quality one', () => {
    const catastrophicallySlow = mockResult({
      label: 'HighQualitySlow',
      intell: 0.9,
      pings: [{ ms: 250_000, code: '200' }, { ms: 240_000, code: '200' }],
    })
    const fastButLowerQuality = mockResult({
      label: 'FastLowerQuality',
      intell: 0.3,
      pings: [{ ms: 1_500, code: '200' }, { ms: 1_600, code: '200' }],
    })

    const ranked = rankModelsForRouting([catastrophicallySlow, fastButLowerQuality])
    assert.equal(ranked[0].label, 'FastLowerQuality')
  })

  it('still prefers the higher-quality model when both are reasonably fast', () => {
    const higherQuality = mockResult({ label: 'HigherQuality', intell: 0.9, pings: [{ ms: 1_200, code: '200' }] })
    const lowerQuality = mockResult({ label: 'LowerQuality', intell: 0.3, pings: [{ ms: 900, code: '200' }] })

    const ranked = rankModelsForRouting([higherQuality, lowerQuality])
    assert.equal(ranked[0].label, 'HigherQuality')
  })

  it('a stuck-slow model still scores above zero -- a last resort, not fully excluded', () => {
    const stuckSlow = mockResult({ label: 'StuckSlow', intell: 0.9, pings: [{ ms: 291_194, code: '200' }] })
    assert.ok(computeQoS(stuckSlow) > 0)
  })

  it('is tunable via latencyTargetMs for deployments with different latency expectations', () => {
    const model = mockResult({ intell: 0.5, pings: [{ ms: 5_000, code: '200' }] })
    const strict = computeQoS(model, 500)
    const lenient = computeQoS(model, 10_000)
    assert.ok(lenient > strict)
  })
})

describe('isRetryableProxyStatus', () => {
  it('recognizes quota exhaustion bodies for smartest fallback', () => {
    assert.equal(isQuotaExhaustionError('quota exceeded for this model', 400), true)
    assert.equal(isQuotaExhaustionError('insufficient credits remaining', 402), true)
    assert.equal(isQuotaExhaustionError('invalid API key', 403), false)
    assert.equal(isQuotaExhaustionError('anything', 429), true)
    assert.equal(isQuotaExhaustionError('bad request', 400), false)
  })

  it('detects Gemini-style quota bodies regardless of transport status', () => {
    // Google/Gemini native shape, array-wrapped: [{error:{code:429,
    // status:'RESOURCE_EXHAUSTED', details:[{QuotaFailure},{RetryInfo}]}}]
    const geminiBody = JSON.stringify([{
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
              quotaValue: '20',
            }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '24s' },
        ],
      },
    }])
    // A relay can rewrite the transport status; the body is the ground truth.
    assert.equal(isQuotaExhaustionError(geminiBody, 400), true)
    assert.equal(isQuotaExhaustionError(geminiBody, 403), true)
    assert.equal(isQuotaExhaustionError(geminiBody, 500), true)
    assert.equal(isQuotaExhaustionError(geminiBody, null), true)
    // QuotaFailure metadata alone (no code/status in the body) still counts.
    const quotaOnly = JSON.stringify({ error: { message: 'quota gone', details: [{ QuotaFailure: { violations: [{ quotaId: 'x', quotaValue: '1' }] } }] } })
    assert.equal(isQuotaExhaustionError(quotaOnly, 500), true)
    // An embedded rpc code 429 without quota keywords also counts.
    assert.equal(isQuotaExhaustionError(JSON.stringify({ error: { code: 429, message: 'rate limited' } }), 500), true)
    // Non-quota errors must NOT be classified as quota exhaustion.
    assert.equal(isQuotaExhaustionError(JSON.stringify({ error: { message: 'bad request', code: 'invalid_request_error' } }), 400), false)
    assert.equal(isQuotaExhaustionError(JSON.stringify({ error: { message: 'invalid api key' } }), 401), false)
  })

  it('returns true for 429 and 5xx', () => {
    assert.equal(isRetryableProxyStatus(429), true)
    assert.equal(isRetryableProxyStatus('500'), true)
    assert.equal(isRetryableProxyStatus(503), true)
  })

  it('returns true for 410 (model retired/gone upstream)', () => {
    assert.equal(isRetryableProxyStatus(410), true)
    assert.equal(isRetryableProxyStatus('410'), true)
  })

  it('returns false for non-retryable statuses', () => {
    assert.equal(isRetryableProxyStatus(200), false)
    assert.equal(isRetryableProxyStatus(400), false)
    assert.equal(isRetryableProxyStatus(404), false)
    assert.equal(isRetryableProxyStatus('not-a-status'), false)
  })
})

describe('computeFailedRefreshRetryAt', () => {
  it('allows a retry after retryBackoffMs instead of the full refresh TTL', () => {
    const now = 1_000_000_000
    const refreshIntervalMs = 60 * 60_000 // 1 hour, e.g. OpenCode Zen's TTL
    const retryBackoffMs = 2 * 60_000 // 2 minutes
    const stampedAt = computeFailedRefreshRetryAt(now, refreshIntervalMs, retryBackoffMs)

    // Immediately after the failure, the TTL guard (`now - stampedAt < refreshIntervalMs`)
    // must still say "not yet" -- otherwise every failure would retry on every ping cycle.
    assert.equal((now - stampedAt) < refreshIntervalMs, true)
    assert.ok((now - stampedAt) >= refreshIntervalMs - retryBackoffMs)

    // retryBackoffMs later, the TTL guard must allow a retry.
    const afterBackoff = now + retryBackoffMs
    assert.equal((afterBackoff - stampedAt) >= refreshIntervalMs, true)

    // Just before retryBackoffMs elapses, it must still be blocked.
    const justBefore = now + retryBackoffMs - 1
    assert.equal((justBefore - stampedAt) >= refreshIntervalMs, false)
  })

  it('never returns a timestamp in the future relative to a fresh success stamp', () => {
    const now = Date.now()
    const stampedAt = computeFailedRefreshRetryAt(now, 30 * 60_000, 2 * 60_000)
    assert.ok(stampedAt < now)
  })
})

describe('pruneDiscoverableRows', () => {
  const staticIds = ['a/one', 'b/two', 'c/three']
  const rows = [
    { modelId: 'a/one', providerKey: 'p' },
    { modelId: 'b/two', providerKey: 'p' },
    { modelId: 'c/three', providerKey: 'p' },
    { modelId: 'x/prev-discovered', providerKey: 'p' },
  ]

  it('prunes static rows absent from a healthy discovery', () => {
    const kept = pruneDiscoverableRows(rows, staticIds, [{ modelId: 'a/one' }, { modelId: 'b/two' }], false)
    assert.deepEqual(kept.map(r => r.modelId), ['a/one', 'b/two'])
  })

  it('keeps everything when discovery is empty (failed refresh)', () => {
    const kept = pruneDiscoverableRows(rows, staticIds, [], false)
    assert.deepEqual(kept.map(r => r.modelId), ['a/one', 'b/two', 'c/three'])
  })

  it('keeps all static rows when keepStaticOnDiscovery is set', () => {
    const kept = pruneDiscoverableRows(rows, staticIds, [{ modelId: 'a/one' }], true)
    assert.deepEqual(kept.map(r => r.modelId), ['a/one', 'b/two', 'c/three'])
  })

  it('never keeps previously-discovered rows that disappeared', () => {
    const kept = pruneDiscoverableRows(rows, staticIds, [{ modelId: 'a/one' }, { modelId: 'x/prev-discovered' }], false)
    assert.deepEqual(kept.map(r => r.modelId), ['a/one', 'x/prev-discovered'])
  })
})

describe('parseContextSize', () => {
  it('parses k and m suffixes into raw token counts', () => {
    assert.equal(parseContextSize('128k'), 128_000)
    assert.equal(parseContextSize('1m'), 1_000_000)
    assert.equal(parseContextSize('1M'), 1_000_000)
    assert.equal(parseContextSize('10M'), 10_000_000)
    assert.equal(parseContextSize('0.5m'), 500_000)
  })

  it('parses plain numbers, string or numeric', () => {
    assert.equal(parseContextSize('32000'), 32_000)
    assert.equal(parseContextSize(32000), 32_000)
  })

  it('returns null for unparseable, empty, or negative input', () => {
    assert.equal(parseContextSize(null), null)
    assert.equal(parseContextSize(undefined), null)
    assert.equal(parseContextSize(''), null)
    assert.equal(parseContextSize('—'), null)
    assert.equal(parseContextSize('not-a-number'), null)
    assert.equal(parseContextSize(-5), null)
    assert.equal(parseContextSize('-5'), null)
    assert.equal(parseContextSize('-5k'), null)
    assert.equal(parseContextSize('128garbage'), null)
    assert.equal(parseContextSize('1.2.3m'), null)
    assert.equal(parseContextSize(0), null)
  })
})

describe('parseArgs', () => {
  const argv = (...args) => ['node', 'script', ...args]

  it('parses router runtime flags', () => {
    const result = parseArgs(argv('--port', '8080', '--ban', 'a,b,c', '--log'))
    assert.equal(result.portValue, 8080)
    assert.deepEqual(result.bannedModels, ['a', 'b', 'c'])
    assert.equal(result.enableLog, true)
  })

  it('parses --host and falls back to loopback when absent', () => {
    assert.equal(parseArgs(argv('--host', '0.0.0.0')).hostValue, '0.0.0.0')
    assert.equal(parseArgs(argv()).hostValue, null)
  })

  it('rejects invalid ports instead of silently accepting them', () => {
    assert.equal(parseArgs(argv('--port', '0')).portValue, 7352)
    assert.equal(parseArgs(argv('--port', '-1')).portValue, 7352)
    assert.equal(parseArgs(argv('--port', '99999')).portValue, 7352)
    assert.equal(parseArgs(argv('--port', 'not-a-number')).portValue, 7352)
    assert.equal(parseArgs(argv('--port', '65535')).portValue, 65535)
  })

  it('defaults to port 7352 and logs disabled', () => {
    const result = parseArgs(argv())
    assert.equal(result.portValue, 7352)
    assert.equal(result.enableLog, false)
  })

  it('lets --no-log override --log', () => {
    const result = parseArgs(argv('--log', '--no-log'))
    assert.equal(result.enableLog, false)
  })

  it('detects onboard subcommand and flag', () => {
    assert.equal(parseArgs(argv('onboard')).onboard, true)
    assert.equal(parseArgs(argv('--onboard')).onboard, true)
  })

  it('detects help aliases', () => {
    assert.equal(parseArgs(argv('--help')).help, true)
    assert.equal(parseArgs(argv('-h')).help, true)
    assert.equal(parseArgs(argv('help')).help, true)
  })

  it('parses autostart command variants', () => {
    const install = parseArgs(argv('install', '--autostart'))
    assert.equal(install.command, 'install')
    assert.equal(install.autostart, true)
    assert.equal(install.autostartAction, 'install')

    const start = parseArgs(argv('start', '--autostart'))
    assert.equal(start.command, 'start')
    assert.equal(start.autostart, true)
    assert.equal(start.autostartAction, 'start')

    const uninstall = parseArgs(argv('uninstall', 'autostart'))
    assert.equal(uninstall.command, 'uninstall')
    assert.equal(uninstall.autostart, true)
    assert.equal(uninstall.autostartAction, 'uninstall')

    const status = parseArgs(argv('status', '--autostart'))
    assert.equal(status.command, 'status')
    assert.equal(status.autostart, true)
    assert.equal(status.autostartAction, 'status')
  })

  it('parses autostart alias commands', () => {
    assert.equal(parseArgs(argv('autostart')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--status')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--install')).autostartAction, 'install')
    assert.equal(parseArgs(argv('autostart', '--start')).autostartAction, 'start')
    assert.equal(parseArgs(argv('autostart', 'uninstall')).autostartAction, 'uninstall')
  })

  it('parses update subcommand', () => {
    const result = parseArgs(argv('update'))
    assert.equal(result.command, 'update')
    assert.equal(result.autostartAction, null)
  })

  it('parses autoupdate status by default', () => {
    const result = parseArgs(argv('autoupdate'))
    assert.equal(result.command, 'autoupdate')
    assert.equal(result.autoUpdateAction, 'status')
  })

  it('parses autoupdate enable/disable with interval', () => {
    const enabled = parseArgs(argv('autoupdate', '--enable', '--interval', '12'))
    assert.equal(enabled.autoUpdateAction, 'enable')
    assert.equal(enabled.autoUpdateIntervalHours, 12)

    const disabled = parseArgs(argv('autoupdate', '--disable'))
    assert.equal(disabled.autoUpdateAction, 'disable')
    assert.equal(disabled.autoUpdateIntervalHours, null)
  })

  it('parses config export/import commands', () => {
    const exported = parseArgs(argv('config', 'export'))
    assert.equal(exported.command, 'config')
    assert.equal(exported.configAction, 'export')
    assert.equal(exported.configPayload, null)

    const imported = parseArgs(argv('config', 'import', 'mrconf:v1:abc123'))
    assert.equal(imported.command, 'config')
    assert.equal(imported.configAction, 'import')
    assert.equal(imported.configPayload, 'mrconf:v1:abc123')
  })

  it('parses config set-keys command', () => {
    const result = parseArgs(argv('config', 'set-keys', 'kilocode', 'key1,key2,key3'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-keys')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configKeys, 'key1,key2,key3')
  })

  it('parses config add-key command', () => {
    const result = parseArgs(argv('config', 'add-key', 'nvidia', 'nvapi-extra'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'add-key')
    assert.equal(result.configProvider, 'nvidia')
    assert.equal(result.configKeys, 'nvapi-extra')
  })

  it('parses config remove-key command', () => {
    const result = parseArgs(argv('config', 'remove-key', 'groq', '1'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'remove-key')
    assert.equal(result.configProvider, 'groq')
    assert.equal(result.configKeys, '1')
  })

  it('parses config set-maxturns command', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '20'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configMaxTurns, '20')
  })

  it('parses config set-maxturns with 0 to disable', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '0'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configMaxTurns, '0')
  })

  it('parses status command', () => {
    const result = parseArgs(argv('status'))
    assert.equal(result.command, 'status')
  })
})

describe('parseOpenRouterKeyRateLimit', () => {
  it('extracts credit limits from key payload', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        limit: 25,
        limit_remaining: 12.5,
        limit_reset: '2026-03-01T00:00:00.000Z',
      }
    })

    assert.equal(parsed.creditLimit, 25)
    assert.equal(parsed.creditRemaining, 12.5)
    assert.equal(parsed.creditResetAt, Date.parse('2026-03-01T00:00:00.000Z'))
  })

  it('parses deprecated nested rate_limit shape when present', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        rate_limit: {
          limit_requests: 20,
          remaining_requests: 8,
          reset_requests: 120,
          limit_tokens: 40000,
          remaining_tokens: 15000,
          reset_tokens: 45,
        }
      }
    })

    assert.equal(parsed.limitRequests, 20)
    assert.equal(parsed.remainingRequests, 8)
    assert.equal(parsed.limitTokens, 40000)
    assert.equal(parsed.remainingTokens, 15000)
    assert.ok(parsed.resetRequestsAt > Date.now())
    assert.ok(parsed.resetTokensAt > Date.now())
  })

  it('returns null for invalid payloads', () => {
    assert.equal(parseOpenRouterKeyRateLimit(null), null)
    assert.equal(parseOpenRouterKeyRateLimit({ data: {} }), null)
  })
})

describe('update restart coordination', () => {
  it('keeps Unix-like services alive long enough to self-update when restart is deferred', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'linux'), false)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'darwin'), false)
  })

  it('still stops background instances for normal updates and Windows handoff', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(false, 'linux'), true)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'win32'), true)
  })
})

describe('local update overrides', () => {
  it('detects local tarball updates and derives the version from the filename', () => {
    const tarballPath = join(ROOT, 'hammer-9.8.7.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ HAMMER_UPDATE_TARBALL: tarballPath, HAMMER_UPDATE_VERSION: null }, () => {
        assert.equal(getLocalUpdateTarballPath(), tarballPath)
        assert.equal(getLocalUpdateVersion(), '9.8.7')
        assert.equal(isRunningFromSource(), false)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('prefers an explicit local update version override', () => {
    const tarballPath = join(ROOT, 'hammer-build-under-test.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ HAMMER_UPDATE_TARBALL: tarballPath, HAMMER_UPDATE_VERSION: '3.2.1' }, () => {
        assert.equal(getLocalUpdateVersion(), '3.2.1')
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('accepts a forced update version for simpler local upgrade testing', () => {
    withEnv({ HAMMER_FORCE_UPDATE_VERSION: '9.9.9' }, () => {
      assert.equal(getForcedUpdateVersion(), '9.9.9')
    })
  })

  it('ignores invalid forced update versions', () => {
    withEnv({ HAMMER_FORCE_UPDATE_VERSION: 'next-build' }, () => {
      assert.equal(getForcedUpdateVersion(), null)
    })
  })
})

describe('npm install invocation', () => {
  it('builds a shell-safe Windows npm command for local tarballs', () => {
    const tarballPath = join(ROOT, 'hammer-1.8.4.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ HAMMER_UPDATE_TARBALL: tarballPath }, () => {
        const invocation = buildNpmInstallInvocation('latest', 'win32')
        assert.equal(invocation.command, 'npm')
        assert.deepEqual(invocation.args, ['install', '-g', tarballPath])
        assert.equal(invocation.shell, true)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })
})

describe('post-update restart command', () => {
  it('restarts the autostart target only when autostart is configured', () => {
    assert.equal(buildWindowsPostUpdateRestartCommand(true), 'timeout /t 2 /nobreak && hammer start --autostart')
    assert.equal(buildWindowsPostUpdateRestartCommand(false), 'timeout /t 2 /nobreak && hammer')
  })
})

describe('autostart', () => {
  it('resolves absolute executable path when available', () => {
    const binPath = join(ROOT, 'bin', 'hammer.js')
    assert.equal(resolveAutostartExecPath(binPath), binPath)
  })

  it('falls back to command name when path is missing', () => {
    assert.equal(resolveAutostartExecPath('/definitely/not/a/file/hammer'), 'hammer')
  })

  it('resolves node executable path when available', () => {
    assert.equal(resolveAutostartNodePath(process.execPath), process.execPath)
  })

  it('falls back to node command when node path is missing', () => {
    assert.equal(resolveAutostartNodePath('/definitely/not/a/file/node'), 'node')
  })
})

describe('onboard integrations', () => {
  it('builds OpenClaw provider config with required models array', () => {
    const provider = buildOpenClawProviderConfig(7352)

    assert.equal(provider.baseUrl, 'http://127.0.0.1:7352/v1')
    assert.equal(provider.api, 'openai-completions')
    assert.equal(provider.apiKey, 'no-key')
    assert.deepEqual(provider.models, [{ id: 'best', name: 'Best' }])
  })
})

describe('model grouping and filtering', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7 (NVIDIA)' }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7 (OpenRouter)' }),
    mockResult({ modelId: 'meta/llama3.3-70b', label: 'Llama 3.3 (Meta)' }),
  ]

  it('builds one catalog entry per normalized label group', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'openrouter/moonshotai/kimi-k2.5:free', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 2)
    const kimiGroup = groups.find(group => group.id === 'kimi-k2.5')
    assert.ok(kimiGroup)
    assert.equal(kimiGroup.label, 'Kimi K2.5')
    assert.equal(kimiGroup.models.length, 2)
    assert.ok(kimiGroup.aliases.includes('kimi k2.5'))
    assert.ok(kimiGroup.aliases.includes('moonshotai/kimi-k2.5'))
    assert.ok(kimiGroup.aliases.includes('kimi-k2.5'))
  })

  it('uses the canonical unprefixed model id for grouped entries', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5' }),
      mockResult({ modelId: 'vendor/minimax-m2.5', label: 'MiniMax M2.5' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'minimax-m2.5')
  })

  it('keeps duplicate raw model ids from different providers addressable', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ], canonicalizeModelId)

    assert.deepEqual(groups.map(group => group.id).sort(), [
      'openai-compatible:local/llama-3.1',
      'openai-compatible:remote/llama-3.1',
    ])
  })

  it('groups MiMo Omni aliases under one model name', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], canonicalizeModelId)

    const omniGroup = groups.find(group => group.id === 'mimo-v2-omni')
    assert.ok(omniGroup)
    assert.equal(omniGroup.label, 'MiMo V2 Omni')
    assert.equal(omniGroup.models.length, 2)
    assert.ok(omniGroup.aliases.includes('mimo-v2-omni-free'))
    assert.ok(omniGroup.aliases.includes('xiaomi/mimo-v2-omni:free'))

    const proGroup = groups.find(group => group.id === 'mimo-v2-pro')
    assert.ok(proGroup)
    assert.equal(proGroup.label, 'MiMo V2 Omni Pro')
    assert.equal(proGroup.models.length, 1)
  })

  it('filters by exact model ID', () => {
    const filtered = filterModelsByRequested(results, 'nvidia/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'nvidia/glm4.7')
  })

  it('filters by canonical base ID (removes :free)', () => {
    const filtered = filterModelsByRequested(results, 'openrouter/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'openrouter/glm4.7:free')
  })

  it('filters by unprefixed canonical name (grouping)', () => {
    const filtered = filterModelsByRequested(results, 'glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'nvidia/glm4.7'))
    assert.ok(filtered.some(r => r.modelId === 'openrouter/glm4.7:free'))
  })

  it('filters by MiMo Omni alias name', () => {
    const filtered = filterModelsByRequested([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], 'mimo-v2-omni', canonicalizeModelId)

    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'mimo-v2-omni-free'))
    assert.ok(filtered.some(r => r.modelId === 'xiaomi/mimo-v2-omni:free'))
  })

  it('canonicalizes stacked model suffixes', () => {
    const canonical = canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free')
    assert.equal(canonical.base, 'x-ai/grok-code-fast-1')
    assert.equal(canonical.unprefixed, 'grok-code-fast-1')
  })

  it('returns no models if no match is found', () => {
    const filtered = filterModelsByRequested(results, 'non-existent-model', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns all models for smartest', () => {
    const filtered = filterModelsByRequested(results, 'smartest', canonicalizeModelId)
    assert.equal(filtered.length, 3)
  })

  it('filters duplicate raw model ids by endpoint-qualified group id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ]

    const filtered = filterModelsByRequested(duplicateResults, 'openai-compatible:remote/llama-3.1', canonicalizeModelId)

    assert.deepEqual(filtered.map(r => r.providerKey), ['openai-compatible:remote'])
  })
})

describe('model tag routing', () => {
  // moonshotai/kimi-k2.7-code -> ['coding'], qwen-qwq-32b -> ['reasoning'], z-ai/glm5 -> ['agentic', 'coding', 'general']
  const taggedResults = [
    mockResult({ modelId: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' }),
    mockResult({ modelId: 'qwen-qwq-32b', label: 'QwQ 32B' }),
    mockResult({ modelId: 'z-ai/glm5', label: 'GLM 5' }),
  ]

  it('routes tag: requests to models carrying that tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('matches a model tagged with multiple tags under each of its tags', () => {
    const codingMatches = filterModelsByRequested(taggedResults, 'tag:coding', canonicalizeModelId)
    assert.ok(codingMatches.some(r => r.modelId === 'moonshotai/kimi-k2.7-code'))
    assert.ok(codingMatches.some(r => r.modelId === 'z-ai/glm5'))

    const agenticMatches = filterModelsByRequested(taggedResults, 'tag:agentic', canonicalizeModelId)
    assert.deepEqual(agenticMatches.map(r => r.modelId), ['z-ai/glm5'])
  })

  it('is case-insensitive for tag names', () => {
    const filtered = filterModelsByRequested(taggedResults, 'TAG:Reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('returns no models for an unknown tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:nonexistent', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns no models when no result carries the requested tag', () => {
    const filtered = filterModelsByRequested([mockResult({ modelId: 'moonshotai/kimi-k2.7-code' })], 'tag:reasoning', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })
})

describe('pinned model routing', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7', providerKey: 'nvidia', pings: [{ ms: 90, code: '200' }], intell: 0.7 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-a', pings: [{ ms: 120, code: '200' }], intell: 0.69 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-b', pings: [{ ms: 150, code: '200' }], intell: 0.65 }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7', providerKey: 'openrouter', pings: [{ ms: 140, code: '200' }], intell: 0.68 }),
  ]

  it('matches the full canonical group by default', () => {
    const matches = getPinnedModelMatches(results, 'nvidia/glm4.7', 'canonical')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), [
      'nvidia:nvidia/glm4.7',
      'vendor-a:glm4.7',
      'vendor-b:glm4.7',
      'openrouter:openrouter/glm4.7:free',
    ])
  })

  it('matches only the exact row in exact mode', () => {
    const matches = getPinnedModelMatches(results, 'glm4.7', 'exact', 'vendor-a')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), ['vendor-a:glm4.7'])
  })

  it('routes to the best eligible provider within a canonical pin group', () => {
    const candidate = getPinnedModelCandidate(results, 'nvidia/glm4.7', 'canonical')
    assert.equal(candidate?.modelId, 'nvidia/glm4.7')
  })

  it('can retry another provider with the same raw model id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local', pings: [{ ms: 90, code: '200' }], intell: 10 }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote', pings: [{ ms: 100, code: '200' }], intell: 10 }),
    ]
    const first = rankModelsForRouting(duplicateResults)[0]
    const second = rankModelsForRouting(duplicateResults, [getRoutingModelKey(first)])[0]

    assert.equal(first.providerKey, 'openai-compatible:local')
    assert.equal(second.providerKey, 'openai-compatible:remote')
  })
})

describe('package and entrypoint sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const binContent = readFileSync(join(ROOT, 'bin/hammer.js'), 'utf8')
  const dashboardContent = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

  it('package fields are valid', () => {
    assert.ok(pkg.name)
    assert.ok(pkg.version)
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(pkg.type, 'module')
  })

  it('CLI script has shebang and required imports', () => {
    assert.ok(binContent.startsWith('#!/usr/bin/env node'))
    assert.ok(binContent.includes("from '../lib/utils.js'"))
    assert.ok(binContent.includes("from '../lib/onboard.js'"))
  })

  it('labels dashboard scores by the current intelligence source', () => {
    assert.ok(dashboardContent.includes('>Intelligence <i class="sort-arrow"'))
    assert.ok(dashboardContent.includes('Artificial Analysis Intelligence Index'))
    assert.ok(dashboardContent.includes('LMArena overall Elo, AA-interpolated'))
    assert.ok(dashboardContent.includes('LMArena coding Elo, AA-interpolated'))
    assert.ok(dashboardContent.includes('Design Arena Elo, AA-interpolated'))
    assert.ok(dashboardContent.includes('Metadata estimate'))
    // No Elo-scale wording is left where the user reads it, and every score cell
    // reads the AA field rather than the retired Elo one.
    assert.equal(dashboardContent.includes('Elo-scale estimate'), false)
    assert.equal(dashboardContent.includes('m.elo'), false)
    assert.equal(dashboardContent.includes('>SWE% <i class="sort-arrow"'), false)
    assert.equal(dashboardContent.includes('>SWE-bench</div>'), false)
  })

  it('dashboard wires the slope-line selector controls', () => {
    assert.ok(dashboardContent.includes('id="sel-slope-slider"'))
    assert.ok(dashboardContent.includes('id="sel-pick"'))
    assert.ok(dashboardContent.includes("'data-sel-drag': 'minIntell'"))
    assert.ok(dashboardContent.includes("'data-sel-drag': 'minSpeed'"))
    assert.ok(dashboardContent.includes("fetch('/api/selector'"))
    assert.ok(dashboardContent.includes('function pickSlopeModel'))
    assert.ok(dashboardContent.includes('function initScatterControls'))
    // The enable toggle was removed — the selector is always on.
    assert.equal(dashboardContent.includes('id="sel-enabled"'), false)
  })

  it('removes the main-table filter controls', () => {
    assert.equal(dashboardContent.includes('toggleFilterBar'), false)
    assert.equal(dashboardContent.includes('class="filter-bar"'), false)
    assert.equal(dashboardContent.includes('id="filter-provider-group"'), false)
    assert.equal(dashboardContent.includes('id="filter-ping-group"'), false)
    assert.equal(dashboardContent.includes('id="filter-avail-group"'), false)
    assert.equal(dashboardContent.includes('id="filter-status-group"'), false)
  })

  it('includes the model tag editor and tag-routing guidance', () => {
    assert.ok(dashboardContent.includes('id="model-tags-input"'))
    assert.ok(dashboardContent.includes("fetch('/api/models/tags'"))
    assert.ok(dashboardContent.includes('Use <code>tag:name</code>'))
  })

  it('formats context sizes for display without changing routing data', () => {
    assert.match(dashboardContent, /function formatContextDisplay\(value\)/)
    assert.match(dashboardContent, /Math\.round\(tokens \/ 1_000\).*K/)
    // drawer + table show the merged known/observed context display
    assert.match(dashboardContent, /escapeHtml\(m\.context\)/)
    assert.ok(dashboardContent.includes("id=\"th-ctx\""))
  })

  it('includes working provider key reveal and copy controls', () => {
    assert.ok(dashboardContent.includes('toggleProviderKeyVisibility'))
    assert.ok(dashboardContent.includes('getConfiguredProviderKey'))
    assert.ok(dashboardContent.includes('copyProviderKey'))
    assert.equal(dashboardContent.includes('title="Copy API key"'), false)
    assert.equal(dashboardContent.includes('title="Copy token"'), false)
    assert.equal(dashboardContent.includes('>Delete Key</button>'), false)
    assert.equal(dashboardContent.includes('>Delete Token</button>'), false)
    assert.ok(dashboardContent.includes('id="autoping-interval"'))
    assert.ok(dashboardContent.includes("const onlineModelCount = groupModels(models.filter(m => m.status === 'up')).length"))
    assert.ok(dashboardContent.includes("document.getElementById('kpi-active').textContent = onlineModelCount"))
    assert.ok(dashboardContent.includes("document.getElementById('kpi-providers').textContent = onlineProviders.size"))
    assert.equal(dashboardContent.includes('Ping interval (min):'), false)
    assert.equal(dashboardContent.includes('pingIntervalMinutes: providerConfig'), false)
    assert.ok(dashboardContent.includes('async function addAccountKey(providerKey)'))
    assert.ok(dashboardContent.includes('title="Get API key"'))
    assert.ok(dashboardContent.includes('${escapeHtml(p.name)}'))
    assert.equal(dashboardContent.includes('>Get API key</a>'), false)
    assert.ok(dashboardContent.includes('async function removeAccountKey(providerKey, index)'))
    assert.ok(dashboardContent.includes('async function deleteProviderKey(key)'))
    assert.ok(dashboardContent.includes('await fetchData()'))
  })

  it('keeps network plot icons fully opaque', () => {
    assert.match(dashboardContent, /#bg-topology-svg\s*\{\s*opacity:\s*1;/)
    assert.match(dashboardContent, /\.topo-model-img\s*\{\s*opacity:\s*1;/)
    assert.match(dashboardContent, /\.topo-provider-img\s*\{\s*opacity:\s*1;/)
    assert.match(dashboardContent, /\.topo-provider-mono\s*\{\s*opacity:\s*1;/)
  })

  it('adds an Intelligence-vs-speed scatter plot beside the network plot', () => {
    assert.ok(dashboardContent.includes('class="plots-grid"'))
    assert.ok(dashboardContent.includes('id="speed-intell-svg"'))
    assert.ok(dashboardContent.includes('Intelligence vs Speed'))
    assert.ok(dashboardContent.includes('function drawSpeedIntellScatter(models)'))
    assert.ok(dashboardContent.includes('drawSpeedIntellScatter(models)'))
    assert.ok(dashboardContent.includes('speed: 1 / (ttft + 1000 / tps)'))
  })

  it('plots the same model set the primary table lists', () => {
    // The network plot draws a node for every provider the table lists. Filtering it
    // to providers with an online model silently dropped whole model groups the table
    // still shows — an all-down row is a primary-table row, not a graveyard row — so
    // the picture contradicted the table it exists to illustrate.
    assert.ok(dashboardContent.includes('const plotProviders = [...new Set(primaryModels.map(m => m.providerKey))]'))
    assert.equal(
      dashboardContent.includes("filter(pk => primaryModels.some(m => m.providerKey === pk && m.status === 'up'))"),
      false,
      'the topology must not drop providers whose models are all offline',
    )
    // Offline providers keep their red status styling instead of disappearing.
    assert.match(dashboardContent, /\.topo-provider-ring\.red\s*\{/)
    // The speed plot counts the rows it could not place of the rows the table shows,
    // so a row missing from the scatter is accounted for rather than silently dropped.
    assert.ok(dashboardContent.includes('tableRowsWithoutSpeed'))
    assert.ok(dashboardContent.includes('without speed data'))
  })

  it('keeps provider key inputs intact across the auto-refresh rebuild and saves on Enter', () => {
    // The ~4s poll calls loadSettings() which rebuilds the provider containers;
    // without state preservation a half-typed key would be discarded before blur.
    assert.ok(dashboardContent.includes('const inputState = new Map();'))
    assert.ok(dashboardContent.includes('const restoreInputState = () => {'))
    assert.ok(dashboardContent.includes('restoreInputState();'))
    assert.ok(dashboardContent.includes("onkeydown=\"if(event.key==='Enter'){event.preventDefault();updateProviderKey("))
    assert.ok(dashboardContent.includes("onkeydown=\"if(event.key==='Enter'){event.preventDefault();addAccountKey("))
  })

  it('refreshes a provider\'s models immediately when its first API key is saved', () => {
    const serverContent = readFileSync(join(ROOT, 'lib/server.js'), 'utf8')
    // Saving a key for a generic keyed provider (groq, cerebras, googleai, ...)
    // must run discovery + pings right away instead of waiting for the next
    // periodic ping wave (~30 min), which is what surfaced models late.
    assert.ok(serverContent.includes("const providerHasKeyAfterSave = providerKey !== KIRO_PROVIDER_KEY && getApiKeyPool(currentConfig, providerKey).length > 0;"))
    assert.ok(serverContent.includes("const keyFieldsWereWritten = apiKey !== undefined || (Array.isArray(apiKeys) && apiKeys.some(k => typeof k === 'string' && k.trim()));"))
    assert.ok(serverContent.includes('providerHasKeyAfterSave && keyFieldsWereWritten'))
    assert.ok(serverContent.includes('Generic keyed providers (Groq, Cerebras, Google AI, Codestral, ...)'))
    assert.ok(serverContent.includes('void triggerImmediateProviderPing(providerKey);'))
    // Client re-pulls shortly after a key save / enable toggle so the refreshed
    // rows land in the table without waiting for the next 4s poll.
    assert.ok(dashboardContent.includes('function scheduleKeySaveRefetch()'))
    assert.ok(dashboardContent.includes('}, 1800);'))
    assert.ok(dashboardContent.includes('scheduleKeySaveRefetch();'))
    assert.ok(dashboardContent.includes("if (!document.hidden) fetchData().catch(() => { });"))
  })

  it('adds a Response column with a Test button that captures full model responses', () => {
    const serverContent = readFileSync(join(ROOT, 'lib/server.js'), 'utf8')
    // Column headers — Status and Response are separate columns
    assert.ok(dashboardContent.includes('>Status <i class="sort-arrow"'))
    assert.ok(dashboardContent.includes('>Response</th>'))
    // Test flow: button handler, response cell renderer, and in-flight guard
    assert.ok(dashboardContent.includes("function testModelButton(btn, opts)"))
    assert.ok(dashboardContent.includes("function responseCellHTML(lastResponse, opts)"))
    assert.ok(dashboardContent.includes('const btn = testBtnHTML(opts)'))
    assert.ok(dashboardContent.includes('data.ok === false'))
    assert.ok(dashboardContent.includes('inflightTests'))
    assert.ok(dashboardContent.includes('function contradictoryRetestSignature(m)'))
    assert.ok(dashboardContent.includes('function scheduleContradictoryRetests()'))
    assert.ok(dashboardContent.includes('isLastResponseReady(response) && m.status !== \'up\''))
    assert.ok(dashboardContent.includes('response.error && m.status === \'up\''))
    assert.ok(dashboardContent.includes("scheduleContradictoryRetests();"))
    assert.ok(dashboardContent.includes("fetch('/api/test-model'"))
    // Server: route exists, persists the response, records real usage stats
    assert.ok(serverContent.includes("app.post('/api/test-model'"))
    assert.ok(serverContent.includes('const modelIdMatches ='))
    assert.ok(serverContent.includes('function recordTestResponse(result, info)'))
    assert.ok(serverContent.includes('Respond with exactly the single word: Ready'))
    assert.ok(serverContent.includes('lastResponse'))
    // Payment-required (402) results flip the status column to a dollar + 'Paid'
    assert.ok(dashboardContent.includes('paymentRequired === true'))
    assert.ok(dashboardContent.includes('paid-status'))
    assert.ok(serverContent.includes('paymentRequired'))
    assert.ok(serverContent.includes("id: 'best'"))
    assert.ok(serverContent.includes('rankModelsForSmartest'))
    assert.ok(serverContent.includes('isQuotaExhaustionError'))
    assert.ok(dashboardContent.includes('lastResponse?.rateLimitResetAt'))
    assert.ok(dashboardContent.includes("bodyError?.metadata?.headers?.['X-RateLimit-Reset']"))
    assert.ok(dashboardContent.includes('bodyRateLimited'))
    assert.ok(dashboardContent.includes('retry\\s+in\\s+(\\d+(?:\\.\\d+)?)\\s*s'))
    assert.ok(dashboardContent.includes('const groupStatusHtml = members.length === 1\n        ? statusCellHTML(first)'))
    assert.ok(serverContent.includes('body.rateLimitResetAt = resetAt'))
    assert.ok(serverContent.includes('response.status === 429 || rateLimitedByText'))
    assert.equal(dashboardContent.includes('auto-fastest'), false)
    assert.ok(dashboardContent.includes("formatTtftCell(s.minTtft, 'ttft')"))
    assert.ok(dashboardContent.includes("formatTpsCell(s.maxTps, 'tok/s')"))
  })

  it('keeps the group Test button for single-provider models', () => {
    assert.ok(dashboardContent.includes("members.length === 1\n        ? (first.status === 'up' ? 'Up' : (first.status === 'noauth' ? 'No Auth' : 'Down'))"))
    assert.ok(dashboardContent.includes("if (hasAuth) {\n              const expired = lastR && lastR.expiresAt"))
    assert.ok(dashboardContent.includes("responseCellHTML(lastR, { rowKey: 'g:' + g.key, members: g.members, hasAuth: true, status: first.status })"))
    assert.ok(dashboardContent.includes("const hideGroupError = isGroupTest && opts.members.length > 1 && lastResponse.error"))
    assert.ok(dashboardContent.includes('const collapsedModelGroups = new Set()'))
    assert.ok(dashboardContent.includes('function toggleModelGroup(groupKey)'))
    assert.ok(dashboardContent.includes("g.members.length > 1 && !collapsedModelGroups.has(g.key)"))
    assert.ok(dashboardContent.includes("lr.error == null && lr.text != null"))
    assert.ok(dashboardContent.includes("text: 'Ready', _groupReady: true"))
  })

  it('removes the quota column while preserving status and response columns', () => {
    assert.equal(dashboardContent.includes('>Quota</th>'), false)
    assert.equal(dashboardContent.includes('quotaCellHTML(m)'), false)
    assert.ok(dashboardContent.includes('>Status <i class="sort-arrow"'))
    assert.ok(dashboardContent.includes('>Response</th>'))
  })

  it('keeps unavailable models collapsed with the main table columns', () => {
    assert.match(dashboardContent, /<details class="graveyard-details" id="graveyard-details">/)
    assert.equal(dashboardContent.includes('id="graveyard-details" open'), false)
    for (const header of ['Model', 'Intelligence', 'Ping', 'TTFT', 'Tok/s', 'Context', 'Status', 'Response']) {
      assert.match(dashboardContent, new RegExp(`<th[^>]*>\\s*${header}(?:\\s|<)`), `Missing unavailable column: ${header}`)
    }
    assert.ok(dashboardContent.includes('function graveyardRowHTMLInner(g)'))
    assert.ok(dashboardContent.includes("|| m.status === 'noauth';"))
    assert.ok(dashboardContent.includes('const noAuthCount = members.filter(m => m.status === \'noauth\').length'))
    assert.ok(dashboardContent.includes("getBenchmarkTableDisplayValue(s.bestIntellMember.intell"))
    assert.ok(dashboardContent.includes("formatTtftCell(s.minTtft, 'ttft')"))
    assert.ok(dashboardContent.includes("formatTpsCell(s.maxTps, 'tok/s')"))
    assert.ok(dashboardContent.includes("hasAuth\n            ? responseCellHTML(lastResponse, { rowKey: 'g:' + g.key, members, hasAuth: true, status: first.status })"))
  })
})

describe('multi-account round-robin', () => {
  describe('getApiKeyPool', () => {
    it('returns single-element array for string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['nvapi-key1'])
    })

    it('returns array for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.deepEqual(getApiKeyPool(config, 'kilocode'), ['key1', 'key2', 'key3'])
    })

    it('returns empty array for missing provider', () => {
      const config = { apiKeys: {} }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), [])
    })

    it('filters empty strings from array', () => {
      const config = { apiKeys: { groq: ['key1', '', '  ', 'key2'] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('trims whitespace from keys', () => {
      const config = { apiKeys: { groq: ['  key1  ', '  key2  '] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('env var overrides return single-element array', () => {
      withEnv({ NVIDIA_API_KEY: 'env-key' }, () => {
        const config = { apiKeys: { nvidia: ['file-key1', 'file-key2'] } }
        assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['env-key'])
      })
    })

    it('ignores Qwen-specific env vars for the removed provider', () => {
      withEnv({ DASHSCOPE_API_KEY: 'dashscope-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
      withEnv({ QWEN_CODE_API_KEY: 'qwen-code-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
    })
  })

  describe('getApiKey backward compatibility', () => {
    it('returns first element for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.equal(getApiKey(config, 'kilocode'), 'key1')
    })

    it('returns string for string keys', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(getApiKey(config, 'nvidia'), 'nvapi-key1')
    })

    it('returns null for empty array', () => {
      const config = { apiKeys: { groq: [] } }
      assert.equal(getApiKey(config, 'groq'), null)
    })
  })

  describe('hasMultipleKeys', () => {
    it('returns true for multiple array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2'] } }
      assert.equal(hasMultipleKeys(config, 'kilocode'), true)
    })

    it('returns false for single string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(hasMultipleKeys(config, 'nvidia'), false)
    })

    it('returns false for single-element array', () => {
      const config = { apiKeys: { groq: ['key1'] } }
      assert.equal(hasMultipleKeys(config, 'groq'), false)
    })

    it('returns false for missing provider', () => {
      assert.equal(hasMultipleKeys({ apiKeys: {} }, 'nvidia'), false)
    })
  })

  describe('getMaxTurns', () => {
    it('returns configured value', () => {
      const config = { providers: { kilocode: { maxTurns: 20 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 20)
    })

    it('returns 0 when not configured', () => {
      assert.equal(getMaxTurns({ providers: {} }, 'kilocode'), 0)
      assert.equal(getMaxTurns({ providers: { kilocode: {} } }, 'kilocode'), 0)
    })

    it('returns 0 for invalid values', () => {
      const config = { providers: { kilocode: { maxTurns: -1 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 0)
      const config2 = { providers: { kilocode: { maxTurns: 'abc' } } }
      assert.equal(getMaxTurns(config2, 'kilocode'), 0)
    })

    it('floors fractional values', () => {
      const config = { providers: { kilocode: { maxTurns: 10.7 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 10)
    })
  })

  describe('normalizeConfigShape with arrays', () => {
    it('normalizes array apiKeys by trimming and filtering', () => {
      const config = {
        apiKeys: { kilocode: ['  key1  ', '', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('preserves string apiKeys unchanged', () => {
      const config = {
        apiKeys: { nvidia: '  nv-key  ' },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
    })

    it('handles mixed string and array apiKeys', () => {
      const config = {
        apiKeys: { nvidia: 'nv-key', kilocode: ['key1', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('round-trips through export/import with array keys', () => {
      const config = {
        apiKeys: { kilocode: ['key1', 'key2'], nvidia: 'nv-key' },
        providers: { kilocode: { enabled: true } },
      }
      const token = exportConfigToken(config)
      const imported = importConfigToken(token)
      assert.deepEqual(imported.apiKeys.kilocode, ['key1', 'key2'])
      assert.equal(imported.apiKeys.nvidia, 'nv-key')
    })
  })

  describe('getAccountStatus', () => {
    it('returns empty when pool state is not initialized', () => {
      const result = getAccountStatus({ apiKeys: { kilocode: ['k1', 'k2'] } })
      assert.deepEqual(result, { providers: {} })
    })

    it('reports rate-limited keys without crashing after a 429 (regression: KEY_POOL_COOLDOWN_MS was scoped inside runServer)', () => {
      const poolState = new Map([
        ['nvidia', { currentIdx: 1, accounts: new Map([[0, { requests: 2, rateLimitedAt: Date.now() - 10_000 }]]) }],
      ])
      _setKeyPoolState(poolState)
      try {
        const result = getAccountStatus({ apiKeys: { nvidia: ['k1', 'k2'] } })
        assert.equal(result.providers.nvidia.keyCount, 2)
        assert.equal(result.providers.nvidia.currentIdx, 1)
        assert.equal(result.providers.nvidia.accounts[0].rateLimited, true)
        assert.equal(result.providers.nvidia.accounts[1].rateLimited, false)
      } finally {
        _setKeyPoolState(null)
      }
    })
  })

  describe('selectNextApiKeyFromPool', () => {
    it('returns null when every key is still inside cooldown', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 1, rateLimitedAt: now - 10_000 }],
          [1, { requests: 1, rateLimitedAt: now - 20_000 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 0, now, 60_000)

      assert.equal(selected, null)
      assert.equal(entry.currentIdx, 0)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 1)
    })

    it('resets counters when only maxTurns exhaustion blocks the pool', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 2, rateLimitedAt: 0 }],
          [1, { requests: 2, rateLimitedAt: 0 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 2, now, 60_000)

      assert.equal(selected, 'key1')
      assert.equal(entry.currentIdx, 1)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 0)
    })
  })
})

describe('OpenAI-compatible multi-instance support', () => {
  it('detects instance keys and extracts ids', () => {
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:default'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:my-vllm'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible'), false)
    assert.equal(isOpenAICompatibleInstanceKey('groq'), false)

    assert.equal(getOpenAICompatibleInstanceId('openai-compatible:my-vllm'), 'my-vllm')
    assert.equal(getOpenAICompatibleInstanceId('groq'), null)

    assert.equal(getBaseProviderKey('openai-compatible:my-vllm'), 'openai-compatible')
    assert.equal(getBaseProviderKey('groq'), 'groq')
  })

  it('builds instance keys from human-friendly names', () => {
    assert.equal(buildOpenAICompatibleInstanceKey('My vLLM '), 'openai-compatible:my-vllm')
    assert.equal(buildOpenAICompatibleInstanceKey('Foo Bar 123'), 'openai-compatible:foo-bar-123')
    assert.equal(buildOpenAICompatibleInstanceKey(''), null)
    assert.equal(buildOpenAICompatibleInstanceKey('!!!'), null)
  })

  it('normalizeConfigShape migrates a legacy bare-key config to :default', () => {
    const legacy = {
      apiKeys: { 'openai-compatible': 'sk-legacy' },
      providers: { 'openai-compatible': { enabled: true, baseUrl: 'https://legacy.example/v1', modelId: 'old/model' } },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-legacy')
    assert.deepEqual(normalized.providers['openai-compatible:default'], {
      enabled: true,
      baseUrl: 'https://legacy.example/v1',
      modelId: 'old/model',
      name: 'Default',
    })
  })

  it('normalizeConfigShape leaves a config without legacy entries alone', () => {
    const cfg = {
      apiKeys: { 'openai-compatible:my-vllm': 'sk-vllm' },
      providers: { 'openai-compatible:my-vllm': { name: 'vLLM', baseUrl: 'http://localhost:8000/v1', modelId: 'qwen' } },
    }
    const normalized = normalizeConfigShape(cfg)
    assert.equal(normalized.apiKeys['openai-compatible:my-vllm'], 'sk-vllm')
    assert.equal(normalized.providers['openai-compatible:my-vllm'].baseUrl, 'http://localhost:8000/v1')
    // The bare entry should not be (re)created.
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('normalizeConfigShape does not clobber an existing :default instance', () => {
    const legacy = {
      apiKeys: {
        'openai-compatible': 'sk-legacy',
        'openai-compatible:default': 'sk-already-here',
      },
      providers: {
        'openai-compatible': { baseUrl: 'https://legacy.example/v1' },
        'openai-compatible:default': { name: 'Pre-existing', baseUrl: 'https://default.example/v1', modelId: 'm' },
      },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-already-here')
    assert.equal(normalized.providers['openai-compatible:default'].name, 'Pre-existing')
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('legacy OPENAI_COMPATIBLE_* env vars feed the :default instance', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      const config = { apiKeys: {}, providers: {} }
      assert.equal(getApiKey(config, 'openai-compatible:default'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:default'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible:default'), 'env/model')

      // Env vars should NOT apply to a non-default instance.
      assert.equal(getApiKey(config, 'openai-compatible:other'), null)
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:other'), null)
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey
      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl
      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('listOpenAICompatibleEndpoints returns instances in stable insertion order', () => {
    const config = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model', enabled: false },
      },
    })

    const list = listOpenAICompatibleEndpoints(config)
    assert.equal(list.length, 2)
    assert.equal(list[0].instanceKey, 'openai-compatible:alpha')
    assert.equal(list[0].id, 'alpha')
    assert.equal(list[0].name, 'Alpha')
    assert.equal(list[0].baseUrl, 'https://a/v1')
    assert.equal(list[0].modelId, 'a-model')
    assert.equal(list[0].apiKey, 'sk-a')
    assert.equal(list[0].enabled, true)

    assert.equal(list[1].instanceKey, 'openai-compatible:beta')
    assert.equal(list[1].enabled, false)
  })

  it('upsertOpenAICompatibleEndpoint and remove round-trip cleanly', () => {
    const config = { apiKeys: {}, providers: {} }
    const key1 = upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'https://one/v1', modelId: 'm1', apiKey: 'sk-1' })
    assert.equal(key1, 'openai-compatible:one')
    assert.equal(config.apiKeys[key1], 'sk-1')
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].name, 'One')

    // Update preserves untouched fields.
    upsertOpenAICompatibleEndpoint(config, { instanceKey: key1, modelId: 'm1-new' })
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].modelId, 'm1-new')

    const removed = removeOpenAICompatibleEndpoint(config, key1)
    assert.equal(removed, true)
    assert.equal(config.apiKeys[key1], undefined)
    assert.equal(config.providers[key1], undefined)

    // Removing again is a no-op.
    assert.equal(removeOpenAICompatibleEndpoint(config, key1), false)
    // Refusing to remove a non-instance key.
    assert.equal(removeOpenAICompatibleEndpoint(config, 'groq'), false)
  })

  it('upsertOpenAICompatibleEndpoint persists discoverModels=false explicitly', () => {
    const config = { apiKeys: {}, providers: {} }
    upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'http://h/v1' })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, undefined)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: false })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, false)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: true })
    assert.equal('discoverModels' in config.providers['openai-compatible:one'], false)
  })

  it('config export/import preserves multi-instance shape', () => {
    const original = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model' },
      },
    })

    const token = exportConfigToken(original)
    const reimported = importConfigToken(token)

    assert.equal(reimported.apiKeys['openai-compatible:alpha'], 'sk-a')
    assert.equal(reimported.apiKeys['openai-compatible:beta'], 'sk-b')
    assert.equal(reimported.providers['openai-compatible:alpha'].name, 'Alpha')
    assert.equal(reimported.providers['openai-compatible:beta'].modelId, 'b-model')
  })
})

describe('OpenAI-compatible model discovery', () => {
  it('builds the /v1/models URL from a variety of base URLs', () => {
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl(''), null)
    assert.equal(buildOpenAICompatibleModelsListUrl(null), null)
  })

  it('extracts records from common payload shapes', () => {
    assert.deepEqual(extractOpenAICompatibleModelRecords({ data: [{ id: 'a' }, { id: 'b' }] }), [{ id: 'a' }, { id: 'b' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({ models: [{ id: 'a' }] }), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords([{ id: 'a' }]), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({}), [])
    assert.deepEqual(extractOpenAICompatibleModelRecords(null), [])
  })

  it('converts a discovered record to a model-meta tagged with the instance key', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta(
      { id: 'qwen2.5-coder:7b', context_length: 32768, name: 'Qwen2.5 Coder 7B' },
      'openai-compatible:my-vllm',
      'https://host/v1/chat/completions',
    )
    assert.ok(meta)
    assert.equal(meta.modelId, 'qwen2.5-coder:7b')
    assert.equal(meta.label, 'Qwen2.5 Coder 7B')
    assert.equal(meta.providerKey, 'openai-compatible:my-vllm')
    assert.equal(meta.providerUrl, 'https://host/v1/chat/completions')
    assert.equal(meta.ctx, '32768')
    assert.equal(meta.ctxSource, 'provider-reported')
  })

  it('falls back to a synthesized label when the record has none', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta({ id: 'some_unknown-model' }, 'openai-compatible:x')
    assert.ok(meta)
    assert.equal(meta.modelId, 'some_unknown-model')
    assert.equal(meta.label, 'Some Unknown Model')
    assert.equal(meta.isEstimatedScore, true)
  })

  it('rejects records without a usable id', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({}, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: '   ' }, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta('', 'openai-compatible:x'), null)
  })

  it('filters non-chat models from discovered provider catalogs', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'nvidia/nemotron-content-safety' }, 'nvidia'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'text-embedding-3-large' }, 'nvidia'), null)
    assert.ok(toOpenAICompatibleDiscoveredModelMeta({ id: 'qwen/qwen3-coder' }, 'nvidia'))
  })
})

describe('usage stats (ttft / tokens per second)', () => {
  it('accumulates a fresh sample into an empty stats object', () => {
    const stats = accumulateUsageSample(null, { ttft: 500, completionTokens: 100, genMs: 2000 })
    assert.equal(stats.requests, 1)
    assert.equal(stats.ttftSamples, 1)
    assert.equal(stats.ttftSum, 500)
    assert.equal(stats.completionTokensSum, 100)
    assert.equal(stats.genMsSum, 2000)
    assert.ok(Math.abs(stats.lastTps - 50) < 1e-9) // 100 tokens / 2s
    assert.ok(stats.updatedAt != null)
  })

  it('keeps accumulating across samples and never mutates the previous object', () => {
    let stats = accumulateUsageSample(null, { ttft: 300, completionTokens: 50, genMs: 1000 })
    const before = JSON.stringify(stats)
    stats = accumulateUsageSample(stats, { ttft: 700, completionTokens: 150, genMs: 3000 })
    assert.equal(JSON.stringify(stats) !== before, true)
    assert.equal(stats.requests, 2)
    assert.equal(stats.ttftSamples, 2)
    assert.equal(stats.ttftSum, 1000)
    assert.equal(stats.completionTokensSum, 200)
    assert.equal(stats.genMsSum, 4000)
  })

  it('keeps zero-millisecond TTFT samples visible', () => {
    const stats = accumulateUsageSample(null, { ttft: 0, completionTokens: 2, genMs: 1 })
    assert.equal(stats.ttftSamples, 1)
    assert.equal(stats.ttftSum, 0)
    assert.equal(computeUsageAverages(stats).ttft, 0)
    assert.equal(computeUsageAverages(stats).tps, 2000)
  })

  it('normalizes legacy response-only entries before adding usage metrics', () => {
    const stats = accumulateUsageSample({ lastResponse: { text: 'Ready' } }, { ttft: 120, completionTokens: 2, genMs: 80 })
    assert.equal(stats.requests, 1)
    assert.equal(stats.ttftSamples, 1)
    assert.equal(stats.ttftSum, 120)
    assert.equal(computeUsageAverages(stats).tps, 25)
  })

  it('skips samples without tokens when computing tps', () => {
    const stats = accumulateUsageSample(null, { ttft: 200, completionTokens: null, genMs: 1500 })
    assert.equal(stats.completionTokensSum, 0)
    assert.equal(stats.lastTps, null)
    // The stalled request's 1.5s must not sit in the denominator either: the token
    // total never counted it, so folding it into the time drags every later sample
    // down (the first real sample below would report 20 tok/s instead of 50).
    assert.equal(stats.genMsSum, 0)
    const recovered = accumulateUsageSample(stats, { ttft: 200, completionTokens: 50, genMs: 1000 })
    assert.equal(computeUsageAverages(recovered).tps, 50)
  })

  it('never rounds a measured rate down to zero', () => {
    // 2 tokens over 60s is 0.033 tok/s — a real measurement from a relay that stalls
    // after a couple of tokens. toFixed(1) turned it into exactly 0, which the table
    // printed as "0 tok/s" and the speed plot read as "unmeasured", dropping a row
    // that had in fact been measured.
    const stalling = computeUsageAverages(accumulateUsageSample(null, { ttft: 800, completionTokens: 2, genMs: 60_000 }))
    assert.equal(stalling.tps, 0.033)
    assert.ok(stalling.tps > 0)
    // Even an extreme case keeps a positive value (2 tokens over 805s).
    assert.ok(computeUsageAverages(accumulateUsageSample(null, { ttft: 100, completionTokens: 2, genMs: 805_749 })).tps > 0)
    // Ordinary rates keep the single decimal the dashboard has always shown.
    assert.equal(computeUsageAverages(accumulateUsageSample(null, { ttft: 100, completionTokens: 25, genMs: 1000 })).tps, 25)
    assert.equal(computeUsageAverages(accumulateUsageSample(null, { ttft: 100, completionTokens: 300, genMs: 2000 })).tps, 150)
    // The manual Test path writes its per-response rate through the same helper (a
    // private rounding there is what stored the zero), so this is the shared behaviour.
    assert.equal(roundMeasuredRate(2 / 60), 0.033)
    assert.equal(roundMeasuredRate(2 / 805.749), 0.0025)
    assert.equal(roundMeasuredRate(0), 0)
    assert.equal(roundMeasuredRate(Number.NaN), 0)
    const serverSource = readFileSync(join(ROOT, 'lib/server.js'), 'utf8')
    assert.ok(serverSource.includes('body.tps = roundMeasuredRate('))
  })

  it('estimates output tokens for providers that report no usage', () => {
    // A reported count always wins — an estimate must never overwrite real data.
    assert.equal(resolveCompletionTokens(42, 'x'.repeat(4000)), 42)
    assert.equal(resolveCompletionTokens('7', 'x'.repeat(4000)), 7)
    // FreeModels (and other relays) send no usage block: ~4 characters per token.
    assert.equal(resolveCompletionTokens(null, 'x'.repeat(48)), 12)
    assert.equal(resolveCompletionTokens(undefined, 'x'.repeat(1)), 1)
    // A response that reported nothing *and* produced nothing stays unmeasured
    // rather than being recorded as a zero-token sample.
    assert.equal(resolveCompletionTokens(null, ''), null)
    assert.equal(resolveCompletionTokens(0, null), null)
    // A provider that reports 0 tokens while returning text is still measurable.
    assert.equal(resolveCompletionTokens(0, 'x'.repeat(48)), 12)
  })

  it('computes token-weighted averages', () => {
    let stats = accumulateUsageSample(null, { ttft: 400, completionTokens: 100, genMs: 2000 })
    stats = accumulateUsageSample(stats, { ttft: 600, completionTokens: 300, genMs: 6000 })
    const avg = computeUsageAverages(stats)
    assert.equal(avg.requests, 2)
    assert.equal(avg.ttft, 500) // (400 + 600) / 2
    assert.ok(Math.abs(avg.tps - 50) < 1e-9) // 400 tokens / 8s = 50
  })

  it('returns nulls when there is no data', () => {
    assert.deepEqual(computeUsageAverages(null), { ttft: null, tps: null, requests: 0 })
    assert.deepEqual(computeUsageAverages({ requests: 0 }), { ttft: null, tps: null, requests: 0 })
  })
})

describe('context window bounds (known + observed)', () => {
  it('records a successful request as a lower bound and keeps the max', () => {
    let stats = accumulateUsageSample(null, { ttft: 100, completionTokens: 50, genMs: 1000, contextTokens: 120_000 })
    stats = accumulateUsageSample(stats, { ttft: 100, completionTokens: 10, genMs: 1000, contextTokens: 90_000 })
    assert.equal(stats.contextMin, 120_000)
    // samples without contextTokens leave the bound untouched
    stats = accumulateUsageSample(stats, { ttft: 100, completionTokens: 10, genMs: 1000 })
    assert.equal(stats.contextMin, 120_000)
  })

  it('lowers the upper bound across over-length observations, tracking exactness', () => {
    let stats = accumulateContextObservation(null, { maxTokens: 500_000, exact: false })
    assert.equal(stats.contextMax, 500_000)
    assert.equal(stats.contextMaxExact, false)
    stats = accumulateContextObservation(stats, { maxTokens: 200_000, exact: true })
    assert.equal(stats.contextMax, 200_000)
    assert.equal(stats.contextMaxExact, true)
    // a looser bound never raises the stored max
    stats = accumulateContextObservation(stats, { maxTokens: 900_000, exact: false })
    assert.equal(stats.contextMax, 200_000)
  })

  it('returns the same object when nothing changes', () => {
    const stats = { contextMin: 100 }
    assert.equal(accumulateContextObservation(stats, {}), stats)
  })

  it('prefers known catalog context over non-exact observed bounds', () => {
    const stats = { contextMin: 120_000, contextMax: 500_000, contextMaxExact: false }
    assert.deepEqual(computeContextDisplay('128k', stats), { display: '128k', tokens: 128_000, source: 'known' })
  })

  it('overrides catalog context with a provider-stated exact maximum', () => {
    // "This model's maximum context length is 4096 tokens..." recorded from an error
    assert.deepEqual(computeContextDisplay('131k', { contextMax: 4096, contextMaxExact: true }),
      { display: '≤4k', tokens: 4096, source: 'observed' })
    // Exact max + no known: min bound is still preserved
    assert.deepEqual(computeContextDisplay(null, { contextMin: 2000, contextMax: 4096, contextMaxExact: true }),
      { display: '>2k, ≤4k', tokens: 2000, source: 'observed' })
    // Loose (non-exact) bounds never override known catalog data
    assert.deepEqual(computeContextDisplay('128k', { contextMin: 120_000, contextMax: 200_000, contextMaxExact: false }),
      { display: '128k', tokens: 128_000, source: 'known' })
    // The exact message the user pasted parses to 4096
    assert.equal(parseContextLimitFromError("This model's maximum context length is 4096 tokens. However, you requested 16404 tokens (20 in the messages, 16384 in the completion). Please reduce the length of the messages or completion."), 4096)
  })

  it('builds bound displays from observations', () => {
    assert.deepEqual(computeContextDisplay(null, { contextMin: 120_000, contextMax: 500_000, contextMaxExact: false }),
      { display: '>120k, <500k', tokens: 120_000, source: 'observed' })
    assert.deepEqual(computeContextDisplay(null, { contextMin: 120_000, contextMax: 500_000, contextMaxExact: true }),
      { display: '>120k, ≤500k', tokens: 120_000, source: 'observed' })
    assert.deepEqual(computeContextDisplay(null, { contextMin: 120_000 }),
      { display: '>120k', tokens: 120_000, source: 'observed' })
    assert.deepEqual(computeContextDisplay(null, { contextMax: 500_000, contextMaxExact: false }),
      { display: '<500k', tokens: 500_000, source: 'observed' })
    assert.deepEqual(computeContextDisplay(null, null), { display: null, tokens: null, source: 'none' })
  })

  it('flags experimentally bounded micro context windows', () => {
    // provider-stated exact maximum observed in an error
    assert.equal(isMicroContextBound({ contextMax: 4096, contextMaxExact: true }), true)
    // loose bound inferred from an over-length rejection; inclusive at 16k
    assert.equal(isMicroContextBound({ contextMax: 16_384, contextMaxExact: false }), true)
    assert.equal(isMicroContextBound({ contextMax: 16_385, contextMaxExact: false }), false)
    // only upper bounds count; a lower bound says nothing about smallness
    assert.equal(isMicroContextBound({ contextMin: 2000 }), false)
    assert.equal(isMicroContextBound(null), false)
    assert.equal(isMicroContextBound(undefined), false)
  })

  it('formats token counts like catalog strings', () => {
    assert.equal(formatTokenCount(128_000), '128k')
    assert.equal(formatTokenCount(1_500_000), '1.5M')
    assert.equal(formatTokenCount(32_000), '32k')
    assert.equal(formatTokenCount(999), '999')
    assert.equal(formatTokenCount(0), null)
    assert.equal(formatTokenCount('128k'), null)
  })

  it('extracts stated context limits from provider error bodies', () => {
    assert.equal(parseContextLimitFromError("This model's maximum context length is 128000 tokens. However, your messages resulted in 128005 tokens."), 128_000)
    assert.equal(parseContextLimitFromError('prompt is too long: 216102 tokens > 200000 maximum'), 200_000)
    assert.equal(parseContextLimitFromError('context_length_exceeded: maximum is 131072'), 131_072)
    // A max_tokens cap also reveals a hard limit, even when catalog data exists
    assert.equal(parseContextLimitFromError('`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model'), 8192)
    assert.equal(parseContextLimitFromError('max_tokens must be less than or equal to 4096'), 4096)
    const vllmLimitError = JSON.stringify({ error: { message: 'max_tokens=16384 cannot be greater than max_model_len=max_total_tokens=8192. Please request fewer output tokens. (parameter=max_tokens, value=16384)', type: 'BadRequestError', param: 'max_tokens', code: 400 } })
    assert.equal(parseContextLimitFromError(vllmLimitError), 8192)
    assert.equal(parseMaxTokensCapFromError(vllmLimitError), 8192)
    // A "Request too large ... Limit X, Requested Y" cap reveals the same
    assert.equal(parseContextLimitFromError('Request too large for model `openai/gpt-oss-20b` in organization `org_01krf909wkear9a6bw9d7bxkn8` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 16463, please reduce your message size and try again.'), 8000)
    assert.equal(parseContextLimitFromError('Limit 1,500, Requested 3,000, retry later'), 1500)
    assert.equal(parseContextLimitFromError('This request would exceed your organization rate limit of 20000 input tokens per minute. This request would use 25000 input tokens'), null)
    assert.equal(parseContextLimitFromError('some unrelated error'), null)
    assert.equal(parseContextLimitFromError(null), null)
  })

  it('detects payment-required errors', () => {
    // Ollama cloud's paid-model rejection
    assert.equal(isPaymentRequiredError('this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access: https://ollama.com/upgrade then add extra usage: https://ollama.com/settings', 403), true)
    // Ollama subscription-style rejection
    assert.equal(isPaymentRequiredError('this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: 3cdc9063-a760-4c12-b6e7-88a3b5cf39bf)', 403), true)
    assert.equal(isPaymentRequiredError('this model requires a paid subscription to use', 403), true)
    // Classic OpenAI-style 402 body
    assert.equal(isPaymentRequiredError('Payment required to access this resource. Visit your billing tab.', 400), true)
    // Status alone (402) is enough
    assert.equal(isPaymentRequiredError('some other error', 402), true)
    // Free-tier rate limits stay rate limits, not payment walls
    assert.equal(isPaymentRequiredError('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', 429), false)
    assert.equal(isPaymentRequiredError('Invalid API key', 401), false)
    assert.equal(isPaymentRequiredError(null, 200), false)
  })

  it('detects dead-model errors (410 Gone / end-of-life)', () => {
    // NVIDIA-style 410 with EOL detail, as in the field
    assert.equal(isDeadModelError('The model \'z-ai/glm-5.2\' has reached its end of life on 2026-08-21T09:00:00Z and is no longer available.', 410), true)
    // Cerebras-style archived rejection (not a 410)
    assert.equal(isDeadModelError('Model zai-glm-4.7 is archived and unavailable for the organization.', 400), true)
    // HTTP 410 alone is enough
    assert.equal(isDeadModelError(null, 410), true)
    // NVIDIA NIM: removed model returns 404 with "Not found for account"
    assert.equal(isDeadModelError('Function \'8378ffb2-51b0-4140-9684-dda1889373e6\' not found for account', 404), true)
    assert.equal(isDeadModelError('{"status":404,"title":"Not Found","detail":"Function not found for account"}', 404), true)
    // Google AI: model not found for generateContent → definitively dead
    assert.equal(isDeadModelError('models/lyria-realtime-exp is not found for API version v1main, or is not supported for generateContent.', 404), true)
    // NVIDIA NIM: plain 404 page not found for removed models
    assert.equal(isDeadModelError('404 page not found', 404), true)
    // Relay gateways (g4f.space): a catalog entry no backend serves is dead, even
    // though the gateway answers 404 rather than 410.
    assert.equal(isDeadModelError("No server found that supports model 'GLM:GLM-5.3'", 404), true)
    assert.equal(isDeadModelError('{"error":"No server found that supports model \'GLM:GLM-5.3\'"}', 404), true)
    assert.equal(isDeadModelError('No provider found for model foo', 404), true)
    // Guardrail: a transient "nothing available right now" must stay a plain outage.
    assert.equal(isDeadModelError('No server is currently available, please retry', 503), false)
    assert.equal(isDeadModelError('The server found that model too large', 400), false)
    // g4f.space per-server refusal: the gateway routed to a backend that does not
    // serve this model and said so (HTTP 400, type model_not_allowed).
    assert.equal(isDeadModelError("Model 'glm-5.3' is not allowed on this server. Allowed: gemma-4-26b, qwen-3.8-27b", 400), true)
    assert.equal(isDeadModelError('{"error":{"message":"Model \'glm-5.3\' is not allowed on this server. Allowed: qwen-3.8-27b","type":"model_not_allowed"}}', 400), true)
    // Guardrail: a plan/entitlement restriction is not a catalog death.
    assert.equal(isDeadModelError('This model is not allowed for your plan', 403), false)
    // OpenAI-compatible providers: structured model_not_found errors are permanent
    // model/access failures even when the provider returns HTTP 400.
    assert.equal(isDeadModelError('{"message":"Model does not exist or you do not have access to it.","type":"not_found_error","param":"model","code":"model_not_found"}', 400), true)
    // NVIDIA NIM: generic "Model not found" with 404
    assert.equal(isDeadModelError('{"error":{"message":"Model not found","type":"Not Found","code":404}}', 404), true)
    // "Model not found" without 404 is not treated as dead (could be transient)
    assert.equal(isDeadModelError('Model not found', 500), false)
    // Non-dead failures stay non-dead
    assert.equal(isDeadModelError('Rate limit exceeded', 429), false)
    assert.equal(isDeadModelError('Request timed out', 503), false)
    assert.equal(isDeadModelError('Payment required', 402), false)
    assert.equal(isDeadModelError(null, 200), false)
  })

  it('reads the roster a refusing gateway names, and only its chat models', () => {
    const refusal = "Model 'glm-5.3' is not allowed on this server. Allowed: whisper-large-v3-turbo, moondream3.1, sdxl-lightning, flux-2-klein-4b, flux-2-dev, flux-1-schnell, phoenix-1.0, logfare/auto, melotts, aura-2-en, nova-3, lucid-origin, gemma-4-26b, qwen-3.8-27b"
    const allowed = parseAllowedModelNamesFromRefusal(refusal)
    assert.equal(allowed.length, 14)
    assert.equal(allowed[0], 'whisper-large-v3-turbo')
    assert.equal(allowed.at(-1), 'qwen-3.8-27b')
    // The JSON wire form ends at the closing quote rather than swallowing the rest.
    assert.deepEqual(
      parseAllowedModelNamesFromRefusal(JSON.stringify({ error: { message: refusal, type: 'model_not_allowed' } })),
      allowed,
    )
    // Anything that is not this refusal yields nothing, so callers can hand it every
    // failure without learning a roster from an unrelated error.
    assert.deepEqual(parseAllowedModelNamesFromRefusal('No server found that supports model'), [])
    assert.deepEqual(parseAllowedModelNamesFromRefusal('Model is not allowed for your plan'), [])
    assert.deepEqual(parseAllowedModelNamesFromRefusal(''), [])

    // The gateway catalog is chat-only, so a roster name is surfaced only when it is
    // recognisably one of those models — never the speech/image models it also runs.
    const catalog = ['auto', 'srv_abc:gemma-4-26b-a4b-it', 'srv_def:qwen-3.8-27b', 'srv_ghi:z-ai/glm-5.3']
    assert.equal(isKnownChatModelName('gemma-4-26b', catalog), true)   // family variant
    assert.equal(isKnownChatModelName('qwen-3.8-27b', catalog), true)  // same model
    assert.equal(isKnownChatModelName('auto', catalog), true)
    assert.equal(isKnownChatModelName('whisper-large-v3-turbo', catalog), false)
    assert.equal(isKnownChatModelName('moondream3.1', catalog), false)
    assert.equal(isKnownChatModelName('flux-1-schnell', catalog), false)
    assert.equal(isKnownChatModelName('lucid-origin', catalog), false)
    assert.equal(isKnownChatModelName('', catalog), false)
  })

  it('treats empty successful test responses as incompatible', () => {
    assert.equal(isEmptyModelResponseText(null), true)
    assert.equal(isEmptyModelResponseText(''), true)
    assert.equal(isEmptyModelResponseText('   \n\t  '), true)
    assert.equal(isEmptyModelResponseText('Ready'), false)
    assert.equal(isEmptyModelResponseText('  Ready  '), false)
  })

  describe('hasUsableChatCompletionBody', () => {
    const completion = (content) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })

    it('accepts a normal non-streaming completion', () => {
      assert.equal(hasUsableChatCompletionBody(completion('hello')), true)
      assert.equal(hasUsableChatCompletionBody(completion([{ type: 'text', text: 'hello' }])), true)
      // Legacy completions shape carries the text on the choice itself.
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ text: 'hi' }] })), true)
    })

    it('accepts tool calls and reasoning-only responses', () => {
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{}' } }] } }] })), true)
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: { content: null, function_call: { name: 'f', arguments: '{}' } } }] })), true)
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking' } }] })), true)
    })

    it('rejects 200 bodies that carry no completion (the garbage-200 case)', () => {
      assert.equal(hasUsableChatCompletionBody(''), false)
      assert.equal(hasUsableChatCompletionBody('   '), false)
      assert.equal(hasUsableChatCompletionBody(null), false)
      assert.equal(hasUsableChatCompletionBody(undefined), false)
      // Empty / missing choices, blank messages, and whitespace-only content.
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [] })), false)
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: { content: '' } }] })), false)
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: { content: '   \n ' } }] })), false)
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ choices: [{ message: {} }] })), false)
      // An error envelope is never a usable completion.
      assert.equal(hasUsableChatCompletionBody(JSON.stringify({ error: { message: 'nope' }, choices: [{ message: { content: 'ok' } }] })), false)
      // HTML error pages / non-JSON payloads served with 200.
      assert.equal(hasUsableChatCompletionBody('<html><body>Bad Gateway</body></html>'), false)
      assert.equal(hasUsableChatCompletionBody('undefined'), false)
    })

    it('validates SSE transcripts frame by frame', () => {
      const stream = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      assert.equal(hasUsableChatCompletionBody(stream), true)
      // A stream that only ever emits role/finish frames carries no answer.
      assert.equal(hasUsableChatCompletionBody('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'), false)
      assert.equal(hasUsableChatCompletionBody('data: [DONE]\n'), false)
      // Reasoning-only streams still count as a real response.
      assert.equal(hasUsableChatCompletionBody('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n'), true)
      // A completion whose text merely contains "data:" must not be mistaken for SSE.
      assert.equal(hasUsableChatCompletionBody(completion('set data: 1')), true)
    })
  })

  it('recognizes a clean Ready lastResponse (and rejects non-ready ones)', () => {
    // Clean Ready
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', at: Date.now() }), true)
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', at: Date.now(), ttftMs: 100, tps: 50 }), true)
    // Not ready: no response at all
    assert.equal(isLastResponseReady(null), false)
    assert.equal(isLastResponseReady(undefined), false)
    // Not ready: empty text
    assert.equal(isLastResponseReady({ ok: true, text: '' }), false)
    assert.equal(isLastResponseReady({ ok: true, text: '   ' }), false)
    // Not ready: error present
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', error: 'something' }), false)
    assert.equal(isLastResponseReady({ ok: false, text: 'Ready' }), false)
    assert.equal(isLastResponseReady({ ok: false, text: 'Ready', error: 'fail' }), false)
    // Not ready: expired
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', expiresAt: Date.now() - 1000 }), false)
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', expiresAt: Date.now() + 60_000 }), true)
    // Explicit now overrides default
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', expiresAt: 0 }, 100), false)
    assert.equal(isLastResponseReady({ ok: true, text: 'Ready', expiresAt: 200 }, 100), true)
    // 200 status with ready text (what the test endpoint returns on success)
    assert.equal(isLastResponseReady({ status: 200, ok: true, text: 'Ready', at: Date.now() }), true)
  })

  it('detects incompatible model errors (text-input rejected)', () => {
    assert.equal(isIncompatibleModelError('Content cannot be a plain string. The model does not support text input.', 400), true)
    assert.equal(isIncompatibleModelError('{"object":"error","message":"Content cannot be a plain string. The model does not support text input. Content cannot be a plain string. The model does not support text input.","type":"BadRequestError"}', 400), true)
    // Google AI: newer Gemini models served only via the Interactions API
    assert.equal(isIncompatibleModelError(JSON.stringify({ error: { code: 400, message: 'This model only supports Interactions API.', status: 'INVALID_ARGUMENT' } }), 400), true)
    assert.equal(isIncompatibleModelError('This model only supports the Interactions API.', 400), true)
    // Gemini Live-only models reject the generateContent probe and require
    // bidiGenerateContent over a WebSocket instead.
    const liveOnlyMsg = JSON.stringify({ error: { code: 400, message: 'models/gemini-3.5-transcribe-live only supports real-time bidirectional streaming via WebSocket (bidiGenerateContent). Please use the Gemini Live API (bidiGenerateContent via WebSocket) instead of generateContent.', status: 'INVALID_ARGUMENT' } })
    assert.equal(isIncompatibleModelError(liveOnlyMsg, 400), true)
    // Robustly handle array-wrapped Gemini errors too
    const arrayWrappedMsg = JSON.stringify([{ error: { code: 400, message: 'models/gemini-robotics-er-2-streaming-preview only supports real-time bidirectional streaming via WebSocket (bidiGenerateContent). Please use the Gemini Live API (bidiGenerateContent via WebSocket) instead of generateContent.', status: 'INVALID_ARGUMENT' } }])
    assert.equal(isIncompatibleModelError(arrayWrappedMsg, 400), true)
    assert.equal(isIncompatibleModelError('This model only supports real-time bidirectional streaming via WebSocket.', 400), true)
    // Providers can refuse a specific OpenAPI route for a model, e.g. Scaleway-style
    // OpenAI-compatible 422 rejections that say /v1/chat/completions is not supported.
    const routeNotSupportedMsg = JSON.stringify({ status: 422, error: 'ROUTE NOT SUPPORTED', message: "endpoint '/v1/chat/completions' is not supported for model 'bge-multilingual-gemma2'" })
    assert.equal(isIncompatibleModelError(routeNotSupportedMsg, 422), true)
    assert.equal(isIncompatibleModelError("endpoint '/v1/chat/completions' is not supported for model 'bge-multilingual-gemma2'", 422), true)
    // The same refusal verbatim as Scaleway puts it on the wire (this exact body
    // showed up as 'down' / Offline for bge-multilingual-gemma2). The message field
    // is what extractErrorMessage surfaces first, so this must classify even without
    // the route path being retyped for us.
    const scalewayWireMsg = `{"status":422,"error":"ROUTE NOT SUPPORTED","message":"endpoint '/v1/chat/completions' is not supported for model 'bge-multilingual-gemma2'"}`
    assert.equal(isIncompatibleModelError(scalewayWireMsg, 422), true)
    // Relays sometimes forward only the error field, so the bare phrasing must stand alone.
    assert.equal(isIncompatibleModelError('ROUTE NOT SUPPORTED', 422), true)
    // ...but a vague 'not supported' policy line with no route/model framing stays a
    // generic error rather than being swept into Incompatible.
    assert.equal(isIncompatibleModelError('This feature is not supported on the free plan', 422), false)
    assert.equal(isIncompatibleModelError('Rate limit exceeded', 429), false)
    assert.equal(isIncompatibleModelError('Payment required', 402), false)
    // Calibration-only models can return HTTP 200 while refusing normal chat.
    assert.equal(isIncompatibleModelError('Initiate calibration sequence. Please follow all instructions provided by the system.', 200), true)
    assert.equal(isIncompatibleModelError('Calibration', 200), true)
    assert.equal(isIncompatibleModelError(null, 400), false)
    // OpenRouter agentic-harness-only gate: free models like inkling-small:free reject
    // every plain-API request with HTTP 403. This is a permanent provider policy (the
    // free endpoint isn't callable from a non-agentic client), not an auth/transient error,
    // so it must surface as Incompatible in the unavailable table.
    const agenticMsg = 'thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps'
    assert.equal(isIncompatibleModelError(agenticMsg, 403), true)
    // Text match wins even without the 403 status (defensive — relay could rewrite status)
    assert.equal(isIncompatibleModelError(agenticMsg, 400), true)
    // A plain unrelated 403 stays classified as a generic error, not incompatible
    assert.equal(isIncompatibleModelError('invalid API key', 403), false)
    // Additional Gemini Live-only wording variants: only the explicit bidirectional
    // streaming / WebSocket story is treated as incompatible here; a plain
    // "WebSocket" mention without the streaming/protocol framing is not matched.
    assert.equal(isIncompatibleModelError('Please use the Gemini Live API (bidiGenerateContent via WebSocket).', 400), true)
    assert.equal(isIncompatibleModelError('only supports bidirectional streaming', 400), true)
    assert.equal(isIncompatibleModelError('only supports real-time bidirectional streaming', 400), true)
    assert.equal(isIncompatibleModelError('Gemini Live API', 400), true)
    assert.equal(isIncompatibleModelError('WebSocket', 400), false)
  })

  it('detects rate-limit errors delivered outside an HTTP 429', () => {
    // Anthropic-style gateway body wrapped in a non-429 status
    assert.equal(isRateLimitedErrorText(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Error from provider (Console): Rate limit exceeded. Please try again later.' } })), true)
    assert.equal(isRateLimitedErrorText('Rate limit exceeded. Please try again later.'), true)
    assert.equal(isRateLimitedErrorText('Rate limit has been reached'), true)
    assert.equal(isRateLimitedErrorText('Too many requests, slow down'), true)
    assert.equal(isRateLimitedErrorText('This model only supports Interactions API.'), false)
    assert.equal(isRateLimitedErrorText('Content cannot be a plain string.'), false)
    assert.equal(isRateLimitedErrorText(null), false)
  })

  describe('shouldKeepUpAfterFailedProbe', () => {
    const now = 1_800_000_000_000
    const H = 3_600_000
    const base = {
      status: 'up', code: '000', lastServedAt: now - 2 * H, now,
      keepUpMs: H, timeoutGraceMs: 6 * H,
    }

    it('keeps a recently-served model up on any failed probe', () => {
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '500', lastServedAt: now - 10 * 60_000 }), true)
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '401', lastServedAt: now - 5 * 60_000 }), true)
    })

    it('treats a timeout as non-authoritative within the longer grace window', () => {
      // Fast pings (2h stale) + timeout probe: endpoint looks "down" to a 30s
      // probe but answered a test 2h ago — must stay up (the user's scenario).
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '000', lastServedAt: now - 2 * H }), true)
      // Outside the timeout grace the verdict applies.
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '000', lastServedAt: now - 7 * H }), false)
      // Real errors are authoritative outside the short window, even in the
      // timeout grace.
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '401', lastServedAt: now - 2 * H }), false)
    })

    it('only applies to up/pending rows with real liveness evidence', () => {
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, status: 'down' }), false)
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, status: 'timeout' }), false)
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, lastServedAt: 0 }), false)
      // 'pending' rows (fresh restart) with liveness evidence survive the first slow probe.
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, status: 'pending' }), true)
    })

    it('never suppresses successful probes', () => {
      assert.equal(shouldKeepUpAfterFailedProbe({ ...base, code: '200' }), false)
    })
  })

  it('extracts max_tokens caps for test retries', () => {
    assert.equal(parseMaxTokensCapFromError('`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model'), 8192)
    assert.equal(parseMaxTokensCapFromError('max_tokens must be no more than 2048'), 2048)
    assert.equal(parseMaxTokensCapFromError('max_tokens=16384 cannot be greater than max_model_len=max_total_tokens=8192'), 8192)
    // Other limit errors are not max_tokens caps
    assert.equal(parseMaxTokensCapFromError("This model's maximum context length is 128000 tokens."), null)
    assert.equal(parseMaxTokensCapFromError('some unrelated error'), null)
    assert.equal(parseMaxTokensCapFromError(null), null)
  })

  it('detects over-length error text heuristically', () => {
    assert.equal(isOverLengthErrorText("This model's maximum context length is 128000 tokens"), true)
    assert.equal(isOverLengthErrorText('prompt is too long'), true)
    assert.equal(isOverLengthErrorText('context_length_exceeded'), true)
    assert.equal(isOverLengthErrorText('max_tokens=16384 cannot be greater than max_model_len=max_total_tokens=8192'), true)
    assert.equal(isOverLengthErrorText('Invalid API key'), false)
    assert.equal(isOverLengthErrorText(''), false)
  })

  it('estimates prompt tokens from message content', () => {
    const tokens = estimateMessageTokens([
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'y'.repeat(400) },
    ])
    assert.equal(tokens, 216) // 800 chars / 4 + 2 messages * 32 overhead
  })

  it('computes usage averages for entries that only have context observations', () => {
    const stats = accumulateContextObservation(null, { maxTokens: 500_000, exact: false })
    assert.deepEqual(computeUsageAverages(stats), { ttft: null, tps: null, requests: 0 })
  })

  it('coerces epoch rate-limit reset values to epoch ms', () => {
    assert.equal(parseEpochResetValue('1787529600000'), 1_787_529_600_000) // epoch ms
    assert.equal(parseEpochResetValue('1787529600'), 1_787_529_600_000)   // epoch seconds
    assert.equal(parseEpochResetValue(1_787_529_600_000), 1_787_529_600_000)
    assert.equal(parseEpochResetValue('0'), null)
    assert.equal(parseEpochResetValue('abc'), null)
    assert.equal(parseEpochResetValue(null), null)
    assert.equal(parseEpochResetValue(''), null)
  })

  it('normalizes absolute and relative provider reset values', () => {
    const now = 1_800_000_000_000
    assert.equal(parseRateLimitResetValue('1800000123', now), 1_800000123000)
    assert.equal(parseRateLimitResetValue('1800000123000', now), 1_800000123000)
    assert.equal(parseRateLimitResetValue('37s', now), now + 37000)
    assert.equal(parseRateLimitResetValue('Wed, 21 Oct 2030 07:28:00 GMT', now), Date.parse('Wed, 21 Oct 2030 07:28:00 GMT'))
  })

  it('parses relative retry delay durations', () => {
    assert.ok(parseRetryDelayMs('37.712472835s') >= 37_000 && parseRetryDelayMs('37.712472835s') <= 38_000)
    assert.equal(parseRetryDelayMs('1m30s'), 90_000)
    assert.equal(parseRetryDelayMs('12ms'), 12)
    assert.equal(parseRetryDelayMs('2h'), 7_200_000)
    assert.equal(parseRetryDelayMs('120'), 120_000) // bare number = seconds
    assert.equal(parseRetryDelayMs(30), 30_000)
    assert.equal(parseRetryDelayMs(''), null)
    assert.equal(parseRetryDelayMs('abc'), null)
    assert.equal(parseRetryDelayMs(null), null)
  })

  it('extracts rate-limit reset time from 429 headers and error bodies', () => {
    const body = JSON.stringify({
      error: {
        message: 'Rate limit exceeded',
        code: 429,
        metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1787529600000' }, limit_source: 'openrouter_free_tier_daily' },
      },
    })
    // From the JSON error body metadata
    assert.equal(extractRateLimitResetMs(body, () => null), 1_787_529_600_000)
    // Header wins when present
    assert.equal(extractRateLimitResetMs(body, (name) => name === 'x-ratelimit-reset' ? '1787530000000' : null), 1_787_530_000_000)
    // Retry-After (seconds) is honored
    const before = Date.now()
    const retry = extractRateLimitResetMs('', (name) => name === 'retry-after' ? '120' : null)
    assert.ok(retry >= before + 120_000 && retry <= before + 120_000 + 2000)
    // OpenAI-style error.headers container
    const oaStyle = JSON.stringify({ error: { message: 'quota', headers: { 'X-RateLimit-Reset': '1787530000000' } } })
    assert.equal(extractRateLimitResetMs(oaStyle, () => null), 1_787_530_000_000)
    // Gemini (Google) RESOURCE_EXHAUSTED shape: details[].RetryInfo.retryDelay
    const geminiBody = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '37.712472835s',
          },
        ],
      },
    })
    const geminiBefore = Date.now()
    const geminiReset = extractRateLimitResetMs(geminiBody, () => null)
    assert.ok(geminiReset != null)
    assert.ok(geminiReset >= geminiBefore + 37_000 && geminiReset <= geminiBefore + 38_000)
    // Nothing parseable -> null
    assert.equal(extractRateLimitResetMs('some other error body', () => null), null)
    assert.equal(extractRateLimitResetMs(null, null), null)
  })

  it('extracts quota failure metadata from Gemini-style bodies', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                quotaValue: '20',
              },
            ],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
        ],
      },
    })
    const quota = extractQuotaFailure(body)
    assert.equal(quota.quotaId, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier')
    assert.equal(quota.quotaValue, '20')
    assert.equal(quota.quotaMetric, 'generativelanguage.googleapis.com/generate_content_free_tier_requests')
    // Nothing quota-related -> empty fields
    const none = extractQuotaFailure(JSON.stringify({ error: { message: 'woops', code: 'invalid_request_error' } }))
    assert.equal(none.quotaId, null)
    assert.equal(none.quotaValue, null)
    assert.equal(none.code, null)
    assert.deepEqual(extractQuotaFailure('not json'), { code: null, quotaId: null, quotaValue: null, quotaMetric: null })
  })
})

describe('status reconciliation and bulk retest', () => {
  const dashboardContent = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  const serverContent = readFileSync(join(ROOT, 'lib/server.js'), 'utf8')

  it('reconciles a Ready response into status in exactly one place, with a freshness bound', () => {
    // Server-side reconcile lives in applyUsageDerivedMetrics — the single promotion
    // shared by the payload, the KPI and the router — and it only counts a success
    // within the same window the probe hysteresis trusts, so a stale success cannot
    // hold a model whose probes all fail at 'up' (and therefore routable). The
    // payload must not re-derive the status the row already carries.
    // Behavior pinned by test/router-harness.test.js.
    assert.ok(serverContent.includes('isLastResponseReady(result.lastResponse)'))
    assert.ok(serverContent.includes('RECENT_SUCCESS_KEEP_UP_MS'))
    assert.equal(serverContent.includes("out.status = 'up'"), false, 'the formatter must not re-derive status')
  })

  it('defines the same Ready check in the dashboard (isLastResponseReady in index.html)', () => {
    assert.ok(dashboardContent.includes('function isLastResponseReady(lastResponse)'))
    assert.ok(dashboardContent.includes('lastResponse.ok === false'))
    assert.ok(dashboardContent.includes('lastResponse.error'))
    assert.ok(dashboardContent.includes('lastResponse.expiresAt'))
  })

  it('statusCellHTML honors Ready lastResponse over stale status', () => {
    assert.ok(dashboardContent.includes('const effectiveUp = m.status === \'up\' || isLastResponseReady(m.lastResponse)'))
    assert.ok(dashboardContent.includes("const dotColor = effectiveUp ? 'var(--success)'"))
  })

  it('combinedStatusCellHTML honors Ready lastResponse', () => {
    assert.ok(dashboardContent.includes('const isUp = m.status === \'up\' || isLastResponseReady(m.lastResponse)'))
    assert.ok(dashboardContent.includes("paymentRequired === true && !isUp"))
    assert.ok(dashboardContent.includes("incompatible === true && !isUp"))
    assert.ok(dashboardContent.includes('microContext === true && !isUp'))
    assert.ok(dashboardContent.includes("dead === true && !isUp"))
  })

  it('contradictoryRetestSignature uses isLastResponseReady', () => {
    assert.ok(dashboardContent.includes('function contradictoryRetestSignature(m)'))
    assert.ok(dashboardContent.includes('isLastResponseReady(response) && m.status !== \'up\''))
    assert.ok(dashboardContent.includes('response.error && m.status === \'up\''))
  })

  it('compareProviders uses isLastResponseReady for Ready sorting', () => {
    assert.ok(dashboardContent.includes('const aReady = isLastResponseReady(a.lastResponse)'))
    assert.ok(dashboardContent.includes('const bReady = isLastResponseReady(b.lastResponse)'))
  })

  it('adds a Rerun Tests button and bulk retest endpoints', () => {
    assert.ok(dashboardContent.includes('id="rerun-tests-btn"'))
    assert.ok(dashboardContent.includes('function rerunTests()'))
    assert.ok(dashboardContent.includes('pollRestestStatus'))
    assert.ok(dashboardContent.includes('cancelRerun'))
    assert.ok(dashboardContent.includes('updateRerunButtonVisibility'))
    assert.ok(dashboardContent.includes('fetch(\'/api/restest-models\''))
    assert.ok(dashboardContent.includes('fetch(\'/api/restest-status'))
    assert.ok(dashboardContent.includes('fetch(\'/api/restest-cancel'))
    const serverContent = readFileSync(join(ROOT, 'lib/server.js'), 'utf8')
    assert.ok(serverContent.includes("app.post('/api/restest-models'"))
    assert.ok(serverContent.includes("app.get('/api/restest-status'"))
    assert.ok(serverContent.includes("app.post('/api/restest-cancel'"))
    assert.ok(serverContent.includes('RESTEST_STATE_PATH'))
    assert.ok(serverContent.includes('restestJobs'))
    assert.ok(serverContent.includes('restestAllNonReady'))
  })

  it('restestAllNonReady fans out tests to all non-ready members', () => {
    assert.ok(serverContent.includes('async function restestAllNonReady(jobId)'))
    assert.ok(serverContent.includes('rowsToTest.push'))
    assert.ok(serverContent.includes('isLastResponseReady(lastResponse)'))
    assert.ok(serverContent.includes('job.status === \'cancelled\''))
    assert.ok(serverContent.includes('job.progress = Math.round'))
  })

  it('discards non-ready states for a Ready lastResponse', () => {
    // A model whose last test returned Ready should never show as down,
    // regardless of what the ping cycle says.
    const ready = { ok: true, text: 'Ready', at: Date.now(), ttftMs: 100, tps: 50 }
    assert.equal(isLastResponseReady(ready), true)
    // isLastResponseReady does not look at an explicit status field — it only cares
    // about ok, text, error, and expiry. The reconcile in GET /api/models is what
    // overrides the model's status to 'up' when this returns true.
    assert.equal(isLastResponseReady({ ...ready, status: 'down' }), true)
    // A Ready with an expired window is treated as not-ready
    assert.equal(isLastResponseReady({ ...ready, expiresAt: Date.now() - 1000 }), false)
  })
})