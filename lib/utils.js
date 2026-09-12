/**
 * @file lib/utils.js
 * @description Pure utility functions for scoring and CLI parsing.
 */

import { MODELS, cleanModelDisplayLabel, getPreferredModelLabel, resolveAliasedModelId } from '../sources.js'
import { getModelTags as getBuiltInModelTags } from '../tags.js'

export const VERDICT_ORDER = ['Perfect', 'Normal', 'Slow', 'Very Slow', 'Overloaded', 'Unstable', 'Not Active', 'Pending']

export const DEFAULT_PING_WINDOW_MS = 35 * 60 * 1000

// Reference latency (ms) for QoS scoring. A model averaging this speed keeps its full
// quality-driven score; slower models are discounted continuously by latencyScore() below.
// Overridable per deployment via the `qosLatencyTargetMs` config setting (see config.js /
// the Settings tab), same pattern as the existing minSweScore filter.
export const DEFAULT_QOS_LATENCY_TARGET_MS = 3000

const QOS_REFERENCE_INTELL = MODELS
  .map(m => Number(m[2]))
  .filter(v => Number.isFinite(v) && v > 0)

export const getAvg = (r, windowMs = DEFAULT_PING_WINDOW_MS) => {
  const now = Date.now()
  const successfulPings = (r.pings || [])
    .filter(p => p.code === '200' && (p.ts == null || now - p.ts <= windowMs))
  if (successfulPings.length === 0) return Infinity
  return Math.round(successfulPings.reduce((a, b) => a + b.ms, 0) / successfulPings.length)
}

export const getVerdict = (r) => {
  const avg = getAvg(r)
  const wasUpBefore = r.pings.length > 0 && r.pings.some(p => p.code === '200')

  if (r.httpCode === '429') return 'Overloaded'
  if ((r.status === 'timeout' || r.status === 'down') && wasUpBefore) return 'Unstable'
  if (r.status === 'timeout' || r.status === 'down') return 'Not Active'
  if (avg === Infinity) return 'Pending'
  if (avg < 400) return 'Perfect'
  if (avg < 1000) return 'Normal'
  if (avg < 3000) return 'Slow'
  if (avg < 5000) return 'Very Slow'
  if (avg < 10000) return 'Unstable'
  return 'Unstable'
}

export const getUptime = (r) => {
  if (r.pings.length === 0) return 0
  const successful = r.pings.filter(p => p.code === '200').length
  return Math.round((successful / r.pings.length) * 100)
}

export const sortResults = (results, sortColumn, sortDirection) => {
  return [...results].sort((a, b) => {
    let cmp = 0

    switch (sortColumn) {
      case 'rank':
        cmp = a.idx - b.idx
        break
      case 'model':
        cmp = (a.label || '').localeCompare(b.label || '')
        break
      case 'intell':
        cmp = (a.intell || 0) - (b.intell || 0)
        break
      case 'avg':
        cmp = getAvg(a) - getAvg(b)
        break
      case 'ctx':
        cmp = (parseContextSize(a.ctx) || 0) - (parseContextSize(b.ctx) || 0)
        break
      case 'condition':
        cmp = a.status.localeCompare(b.status)
        break
      case 'verdict': {
        const aVerdict = getVerdict(a)
        const bVerdict = getVerdict(b)
        cmp = VERDICT_ORDER.indexOf(aVerdict) - VERDICT_ORDER.indexOf(bVerdict)
        break
      }
      case 'uptime':
        cmp = getUptime(a) - getUptime(b)
        break
    }

    return sortDirection === 'asc' ? cmp : -cmp
  })
}

function toValidPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function percentileRank(values, target) {
  const n = values.length
  if (n === 0 || target == null) return null
  if (n === 1) return 100

  let lt = 0
  let eq = 0
  for (const v of values) {
    if (v < target) lt += 1
    else if (v === target) eq += 1
  }

  const rank01 = (lt + (0.5 * eq)) / n
  return rank01 * 100
}

function availabilityMultiplierForUptime(uptime) {
  if (uptime >= 95) return 1.0
  if (uptime >= 85) return 0.9
  if (uptime >= 70) return 0.6
  return 0.2
}

/**
 * Continuous, monotonic latency discount in (0, 1]. Never fully saturates the way the old
 * `Math.max(0, 1000 - ping) / 1000` tiebreaker did: that expression hit exactly 0 once avg
 * ping crossed 1000ms and stayed there, so a model averaging 1.1s and one averaging 291s
 * (a real incident -- nvidia/z-ai/glm-5.2 sat at a 200-290s avg for ~24h) scored identically
 * on latency. This keeps differentiating at every scale: a 100ms and an 800ms model are
 * still meaningfully separated, and a 250s model is discounted toward zero instead of being
 * treated as equivalent to a fast one, as long as it's technically still "up" (HTTP 200).
 * Unpinged/no-data models (avg === Infinity) get the neutral midpoint (target vs target).
 */
export function latencyScore(avgMs, targetMs = DEFAULT_QOS_LATENCY_TARGET_MS) {
  const effectiveAvg = (avgMs === Infinity || avgMs == null) ? targetMs : avgMs
  return targetMs / (targetMs + effectiveAvg)
}

function computeQoSFromNormalizedScores(r, normalizedScores, latencyTargetMs) {
  if (r.status !== 'up') return 0
  const qualityScore = normalizedScores.gpqa != null ? normalizedScores.gpqa : 0

  const speed = latencyScore(getAvg(r), latencyTargetMs)
  const uptime = getUptime(r)
  // speed multiplies the quality-driven score (so catastrophic latency suppresses even a
  // top-quality model, not just nudges it) and is also added on its own so equally- or
  // un-rated candidates still rank by speed alone.
  const availabilityScore = qualityScore * availabilityMultiplierForUptime(uptime) * speed
  return availabilityScore + speed
}

/**
 * Accumulates a per-request usage sample (ttft ms, completion tokens, generation ms)
 * into a persistent per-model-per-provider stats object.
 *
 * @param {object|null} stats existing stats (or null to start fresh)
 * @param {{ttft?:number, completionTokens?:number, genMs?:number}} sample
 * @returns {object} a new stats object with the sample merged in
 */
export function accumulateUsageSample(stats, sample) {
  const prev = stats || {
    requests: 0,
    ttftSamples: 0,
    ttftSum: 0,
    completionTokensSum: 0,
    genMsSum: 0,
    lastTtft: null,
    lastTps: null,
    contextMin: 0,
    contextMax: null,
    contextMaxExact: false,
    updatedAt: null,
  }
  const next = { ...prev }
  // Older test responses could create an entry containing only `lastResponse`.
  // Normalize missing counters before accumulating so that first real metrics do
  // not turn into NaN and disappear from the dashboard.
  next.requests = Number.isFinite(Number(prev.requests)) && Number(prev.requests) >= 0 ? Number(prev.requests) : 0
  next.ttftSamples = Number.isFinite(Number(prev.ttftSamples)) && Number(prev.ttftSamples) >= 0 ? Number(prev.ttftSamples) : 0
  next.ttftSum = Number.isFinite(Number(prev.ttftSum)) && Number(prev.ttftSum) >= 0 ? Number(prev.ttftSum) : 0
  next.completionTokensSum = Number.isFinite(Number(prev.completionTokensSum)) && Number(prev.completionTokensSum) >= 0 ? Number(prev.completionTokensSum) : 0
  next.genMsSum = Number.isFinite(Number(prev.genMsSum)) && Number(prev.genMsSum) >= 0 ? Number(prev.genMsSum) : 0
  next.requests += 1

  const ttft = sample?.ttft != null ? Number(sample.ttft) : null
  if (ttft != null && ttft >= 0 && Number.isFinite(ttft)) {
    next.ttftSamples += 1
    next.ttftSum += ttft
    next.lastTtft = ttft
  }

  // A successful request proves the context window fits prompt + completion tokens,
  // so it raises the observed lower bound for this model/provider.
  const ctxTokens = sample?.contextTokens != null ? Number(sample.contextTokens) : null
  if (ctxTokens != null && ctxTokens > 0 && Number.isFinite(ctxTokens)) {
    next.contextMin = Math.max(prev.contextMin || 0, ctxTokens)
  }

  const completionTokens = sample?.completionTokens != null ? Number(sample.completionTokens) : null
  if (completionTokens != null && completionTokens >= 0 && Number.isFinite(completionTokens)) {
    next.completionTokensSum += completionTokens
  }

  // Generation time only counts towards the average when the same sample reported
  // output tokens. A request that failed, stalled, or predates the token estimate
  // contributes seconds with no tokens, and folding those into the denominator drags
  // the model's measured rate down for good — a single 34-second 503 halves the tok/s
  // of every later sample. The token total never counted them, so neither may the time.
  const genMs = sample?.genMs != null ? Number(sample.genMs) : null
  if (genMs != null && genMs > 0 && Number.isFinite(genMs) && completionTokens != null && completionTokens > 0) {
    next.genMsSum += genMs
  }

  if (completionTokens != null && completionTokens >= 0 && genMs != null && genMs > 0) {
    next.lastTps = completionTokens / (genMs / 1000)
  }

  next.updatedAt = Date.now()
  return next
}

/**
 * Output-token count for a response we actually measured.
 *
 * Several providers never report one: the FreeModels relay sets `usage: null` on
 * every stream frame (asking for `stream_options.include_usage` does not help) and
 * answers non-streaming with a bare {content}. A response with no token count has
 * no tok/s, and a model with no tok/s is silently absent from the speed axis, the
 * slope-line selector and the QoS ranking — it looks unmeasured rather than slow.
 * Fall back to the same ~4-characters-per-token estimate the Kiro stream already
 * uses, so a response we received always yields a measurable speed.
 *
 * `outputText` is everything the model emitted for this response (content, any
 * reasoning it streamed, and tool-call arguments), since generation speed covers
 * all of it. Returns null when the provider reported nothing and there is no text
 * to measure — an unmeasurable response stays unmeasured rather than becoming 0.
 */
const CATALOG_NAMESPACE_RE = /^srv_[a-z0-9]+:/i

/**
 * The model part of a gateway catalog id. g4f namespaces entries per backend server
 * ("srv_ab12:model"), so a server's stated roster has to be compared against model
 * names rather than namespaced ids.
 */
function modelNameFromCatalogId(modelId) {
  const raw = String(modelId || '').trim()
  if (!CATALOG_NAMESPACE_RE.test(raw)) return raw
  const colon = raw.indexOf(':')
  return colon > 0 ? raw.slice(colon + 1) : raw
}

/**
 * The roster a backend names when it refuses a model: "Model 'x' is not allowed on
 * this server. Allowed: a, b, c" (g4f.space, HTTP 400 model_not_allowed). Returns []
 * for any other text, so callers can hand it every failure safely.
 */
export function parseAllowedModelNamesFromRefusal(errorText) {
  const t = String(errorText || '')
  if (!/not allowed on this server/i.test(t)) return []
  // Stop at a quote or brace so a JSON body's remaining fields are not swallowed.
  const match = t.match(/allowed\s*:\s*([^"}\n]+)/i)
  if (!match) return []
  const seen = new Set()
  const names = []
  for (const raw of match[1].split(',')) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Whether a name a backend says it serves is recognisably one of the chat models the
 * gateway's catalog already carries — the same model, or the same family with a
 * variant suffix ("gemma-4-26b" against a catalog "gemma-4-26b-a4b-it").
 *
 * The gateway's catalog is chat-only, while a backend's roster spans everything it
 * runs (speech, image, embeddings). A roster name matching nothing in the catalog is
 * one of those non-chat models, and adding it as a chat row would offer the user a
 * model that cannot answer.
 */
export function isKnownChatModelName(name, catalogModelIds) {
  const target = String(name || '').trim().toLowerCase()
  if (!target) return false
  for (const id of catalogModelIds || []) {
    const candidate = modelNameFromCatalogId(id).replace(/(?::(?:free|optimized|cloud))+$/i, '')
    const tail = candidate.includes('/') ? candidate.split('/').pop() : candidate
    for (const value of [candidate, tail]) {
      const known = String(value || '').trim().toLowerCase()
      if (!known) continue
      if (known === target) return true
      // Family match: the backend serves a variant the catalog lists under a suffix.
      if (known.startsWith(`${target}-`) || target.startsWith(`${known}-`)) return true
    }
  }
  return false
}

export function resolveCompletionTokens(reported, outputText) {
  const n = Number(reported)
  if (Number.isFinite(n) && n > 0) return Math.round(n)
  const chars = typeof outputText === 'string' ? outputText.length : 0
  if (chars <= 0) return null
  return Math.max(1, Math.ceil(chars / 4))
}

/**
 * Rounds a measured rate for display without ever rounding a real measurement down
 * to zero. `toFixed(1)` collapsed every rate below ~0.05 tok/s to exactly 0 — a relay
 * that emits a couple of tokens and stalls — which is indistinguishable from "never
 * measured": the table printed "0 tok/s" as if it had observed it, and the speed
 * plot's `tps > 0` gate dropped the row as unmeasured. Rates at or above 1 keep the
 * single decimal they always had; smaller ones keep two significant digits.
 */
export function roundMeasuredRate(value) {
  if (!(value > 0)) return 0
  return value >= 1 ? Number(value.toFixed(1)) : Number(value.toPrecision(2))
}

/**
 * Computes display-ready averages from accumulated usage stats.
 * tps is a token-weighted average (total tokens / total generation seconds).
 *
 * @param {object|null} stats
 * @returns {{ttft:number|null, tps:number|null, requests:number}}
 */
export function computeUsageAverages(stats) {
  if (!stats || !(stats.requests > 0)) return { ttft: null, tps: null, requests: 0 }
  const ttft = stats.ttftSamples > 0 ? Math.round(stats.ttftSum / stats.ttftSamples) : null
  const tps = stats.genMsSum > 0 && stats.completionTokensSum > 0
    ? roundMeasuredRate(stats.completionTokensSum / (stats.genMsSum / 1000))
    : null
  return { ttft, tps, requests: stats.requests }
}

/**
 * Merges an observed context-window bound into a usage-stats entry (see
 * accumulateUsageSample for the shape). Success samples raise `contextMin`;
 * over-length failures lower `contextMax` (with `contextMaxExact` marking whether
 * the number came from a provider-stated limit vs an inferred prompt-size ceiling).
 * Returns the original stats object unchanged when nothing changed.
 */
export function accumulateContextObservation(stats, observation) {
  const prev = stats || {}
  const next = { ...prev }
  const minTokens = observation?.minTokens != null ? Number(observation.minTokens) : null
  if (minTokens != null && Number.isFinite(minTokens) && minTokens > 0) {
    next.contextMin = Math.max(prev.contextMin || 0, minTokens)
  }
  const maxTokens = observation?.maxTokens != null ? Number(observation.maxTokens) : null
  if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
    if (prev.contextMax == null || maxTokens < prev.contextMax) {
      next.contextMax = maxTokens
      next.contextMaxExact = observation.exact === true
    }
  }
  if (next.contextMin === prev.contextMin && next.contextMax === prev.contextMax) return prev
  next.contextUpdatedAt = Date.now()
  return next
}

/** Formats a raw token count like the catalog's context strings: "128k", "1.5M", "32000". */
export function formatTokenCount(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

/**
 * Builds the display string + sortable token value for a model's context column.
 * A provider-stated exact maximum observed in an error (e.g. "maximum context
 * length is 4096 tokens") is authoritative for that model/provider and overrides
 * catalog data; otherwise known catalog data wins over loose observed bounds, e.g.
 * ">120k, <500k" (exact provider-stated maxima render as "≤500k").
 *
 * @param {string|null} knownCtx  catalog/provider-reported context string ("128k", "1m")
 * @param {object|null} stats     usage-stats entry (contextMin/contextMax/contextMaxExact)
 * @returns {{display:string|null, tokens:number|null, source:'known'|'observed'|'none'}}
 */
export function computeContextDisplay(knownCtx, stats) {
  const knownTokens = parseContextSize(knownCtx)
  const min = stats?.contextMin || null
  const max = stats?.contextMax || null
  const exactMax = stats?.contextMaxExact === true ? max : null

  // Provider-stated exact maximum beats catalog data: it reflects what the
  // provider actually enforces, so the column can't show a limit the provider
  // rejects (e.g. catalog "131k" vs the provider's real "4096").
  if (exactMax != null && knownTokens != null) {
    return { display: '≤' + formatTokenCount(exactMax), tokens: exactMax, source: 'observed' }
  }

  if (knownTokens != null) {
    return { display: formatTokenCount(knownTokens), tokens: knownTokens, source: 'known' }
  }

  if (min == null && max == null) return { display: null, tokens: null, source: 'none' }
  const parts = []
  if (min != null) parts.push('>' + formatTokenCount(min))
  if (max != null) parts.push((stats.contextMaxExact ? '≤' : '<') + formatTokenCount(max))
  return { display: parts.join(', '), tokens: min ?? max, source: 'observed' }
}

/**
 * Context windows experimentally bounded at or below this many tokens (by a
 * provider over-length rejection observed in real request errors) are "Micro":
 * too small to be usable, so the dashboard moves those models to the
 * unavailable table. Catalog-stated small windows don't count — only bounds
 * proven by actual errors.
 */
export const MICRO_CONTEXT_MAX_TOKENS = 16_384

/**
 * True when accumulated error observations bound this model/provider's
 * context window at or below MICRO_CONTEXT_MAX_TOKENS.
 *
 * @param {object|null} stats  usage-stats entry (contextMax set by accumulateContextObservation)
 * @returns {boolean}
 */
export function isMicroContextBound(stats) {
  const max = stats?.contextMax
  return Number.isFinite(max) && max <= MICRO_CONTEXT_MAX_TOKENS
}

/**
 * Extracts a provider-stated context maximum from an error body, e.g.
 * "This model's maximum context length is 128000 tokens" (OpenAI),
 * "prompt is too long: 216102 tokens > 200000 maximum" (Anthropic), or a
 * max_tokens cap like "`max_tokens` must be less than or equal to `8192`".
 * Returns the raw token count, or null when no limit is stated.
 */
export function parseContextLimitFromError(errorText) {
  const t = String(errorText || '')
  const patterns = [
    // vLLM/TGI-style validation: "max_tokens=16384 cannot be greater than
    // max_model_len=max_total_tokens=8192". The latter value is the provider's
    // enforced total context maximum, even though the error is phrased as an
    // output-token validation failure.
    /max_?tokens\s*[=:]\s*[\d,.]+[^\n]{0,120}?max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i,
    /max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i,
    /(?:maximum|max(?:imum)?)\s+context\s+(?:length|window)\s+(?:is|of)\s+([\d,.]+)/i,
    /context\s+(?:length|window)\s+(?:is|of|limited\s+to)\s+([\d,.]+)/i,
    /max(?:imum)?\s*(?:context|ctx)\s*(?:length|window)?\s*[=:]\s*([\d,.]+)/i,
    /prompt\s+is\s+too\s+long[\s\S]*?>\s*([\d,.]+)/i,
    /([\d,.]+)\s*tokens?\s*>\s*([\d,.]+)/i,
    /context_length_exceeded[^\d]{0,60}([\d,.]+)/i,
    /max_?tokens[^\d]{0,60}must be (?:less than or equal to|no more than|at most)[^\d]{0,12}([\d,.]+)/i,
    // "Request too large ... Limit 8000, Requested 16463" (provider-stated cap)
    /limit\s+([\d,.]+),?[^\d]{0,60}requested\s+[\d,.]+/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (!m) continue
    const candidate = (m[2] || m[1] || '').replace(/,/g, '')
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return null
}

/**
 * Detects payment-required rejections: HTTP 402, or error text demanding a paid
 * plan / billing action (e.g. OpenAI's "Payment required...", Ollama cloud's
 * "requires both a Pro, Max, or Team plan ... upgrade for access"). Free-tier
 * rate limits ("add 10 credits to unlock") are NOT treated as payment walls.
 */
export function isPaymentRequiredError(errorText, status) {
  if (status === 402) return true
  const t = String(errorText || '')
  if (/payment.required|payment required/i.test(t)) return true
  if (/requires? (?:both )?(?:a |an )?[a-z, ]*?\b(?:pro|max|team|premium|paid|subscription)\s+plan/i.test(t)) return true
  if (/requires? (?:both )?(?:a |an )?(?:paid )?subscription/i.test(t)) return true
  if (/upgrade for access/i.test(t)) return true
  if (/billing (?:required|tab)/i.test(t) || /visit (?:your|the) billing/i.test(t)) return true
  if (/add extra usage/i.test(t)) return true
  return false
}

/**
 * Detects a model whose API can't accept plain text chat requests.
 * Examples: Google's "Content cannot be a plain string" — these are
 * multimodal-only models (image/video gen) that do support a valid
 * HTTP response but reject chat completions with a 400. Also Google's
 * "This model only supports Interactions API" — newer Gemini models
 * served exclusively through the v1beta/interactions surface, unreachable
 * via any OpenAI-compatible chat completions endpoint.
 *
 * Also models that only support Gemini Live's bidirectional WebSocket protocol
 * (bidiGenerateContent) cannot be tested through the generateContent text-chat
 * path, so they are permanently incompatible with this benchmark.
 *
 * Also OpenRouter's agentic-harness-only gate: free models such as
 * thinkingmachines/inkling-small:free reject every request with HTTP 403
 * and "is only available on agentic harnesses. Try plugging it into a
 * coding agent or productivity app listed on https://openrouter.ai/apps".
 * That's a permanent provider policy (the free endpoint isn't callable from
 * a plain API client), not an auth error or a transient outage, so it belongs
 * in the unavailable table as Incompatible rather than noauth/down.
 *
 * Also route-level refusals: providers such as Scaleway answer a chat-completions
 * probe with HTTP 422 and a body like {"status":422,"error":"ROUTE NOT
 * SUPPORTED","message":"endpoint '/v1/chat/completions' is not supported for
 * model 'bge-multilingual-gemma2'"}. The model exists but is not servable through
 * this route (bge-multilingual-gemma2 is embeddings-only, so any chat call is
 * refused), which is a permanent mismatch rather than an outage. Relays can
 * surface only the `error` field, so the bare "route not supported" phrasing is
 * matched on its own too.
 */
export function isIncompatibleModelError(errorText, status) {
  const t = String(errorText || '')
  return /content cannot be a plain string|model does not support text input|only supports (?:the )?interactions api|only supports (?:real[- ]time )?bidirectional streaming(?: via websocket)?|bidiGenerateContent(?: via websocket)?|gemini live api|chat.completions.*(?:is not supported|not available|unsupported)|route not supported|only available on agentic harnesses|calibration/i.test(t)
}

/**
 * True when a successful model test produced no usable text response.
 * Providers may return HTTP 200 with an empty completion for models that
 * cannot actually serve the requested text-chat interaction.
 */
export function isEmptyModelResponseText(text) {
  return text == null || (typeof text === 'string' && text.trim() === '')
}

// A completion payload counts as usable only when a choice carries real content
// in one of the shapes providers actually use. An empty message, an empty
// choices array, or an error envelope all fail this check.
function isUsableCompletionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (payload.error) return false
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  return choices.some(choice => {
    if (!choice || typeof choice !== 'object') return false
    const node = choice.message || choice.delta
    if (node && typeof node === 'object') {
      if (Array.isArray(node.tool_calls) && node.tool_calls.length > 0) return true
      if (node.function_call && typeof node.function_call === 'object') return true
      if (typeof node.reasoning === 'string' && node.reasoning.trim() !== '') return true
      if (typeof node.reasoning_content === 'string' && node.reasoning_content.trim() !== '') return true
      if (hasNonEmptyText(node.content)) return true
    }
    // Legacy text-completions shape (choices[].text).
    return hasNonEmptyText(choice.text)
  })
}

// Content can be a string, an array of content parts, or null depending on the
// provider. Anything that resolves to non-whitespace text counts.
function hasNonEmptyText(value) {
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.some(hasNonEmptyText)
  if (value && typeof value === 'object') return hasNonEmptyText(value.text ?? value.content)
  return false
}

/**
 * True only when a provider's "successful" (HTTP 200) chat completion actually
 * carries a usable assistant response. Some providers answer 200 with an empty
 * `choices` array, a blank message, an HTML error page, or an SSE stream that
 * never emits a delta — none of which proves the model is healthy. Trusting
 * that 200 inflates uptime/latency/QoS and hands clients empty answers.
 *
 * Accepts either a JSON body or a raw OpenAI-SSE transcript, because the proxy
 * has to validate streamed responses after the fact.
 *
 * @param {string|null|undefined} text  response body (JSON or SSE transcript)
 * @returns {boolean}
 */
export function hasUsableChatCompletionBody(text) {
  if (text == null) return false
  const raw = typeof text === 'string' ? text : String(text)
  const trimmed = raw.trim()
  if (!trimmed) return false

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return isUsableCompletionPayload(Array.isArray(parsed) ? parsed[0] : parsed)
    } catch {
      return false
    }
  }

  // Anything else (an SSE transcript, an HTML/plain-text error page) is only
  // usable if one of its data: frames carries a real delta or message.
  for (const line of raw.split('\n')) {
    const lineText = line.trim()
    if (!lineText.startsWith('data:')) continue
    const frame = lineText.slice(5).trim()
    if (!frame || frame === '[DONE]') continue
    try {
      if (isUsableCompletionPayload(JSON.parse(frame))) return true
    } catch {
      /* not a JSON frame — keep scanning */
    }
  }
  return false
}

/**
 * Extract the error payload from a response body whose HTTP transport said
 * success but whose frames carry an error. Some relays (FreeModels in
 * particular) answer 200 with an SSE stream whose first frame is
 * `data: {"error":{"message":"Service temporarily overloaded",...}}` — the
 * router must treat that as a retryable upstream failure, not pipe it to the
 * client.
 *
 * Accepts either a JSON body or a raw SSE transcript. Returns the error object
 * from the first frame that carries one, or null when the body holds no error.
 *
 * @param {string|null|undefined} text  response body (JSON or SSE transcript)
 * @returns {object|null}
 */
export function findUpstreamSseError(text) {
  if (text == null) return null
  const raw = typeof text === 'string' ? text : String(text)
  const trimmed = raw.trim()
  if (!trimmed) return null

  const isErrorEnvelope = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const error = payload.error
    if (!error || typeof error !== 'object') return null
    if (typeof error === 'string') return { message: error }
    if (typeof error.message !== 'string' && error.code == null && error.type == null) return null
    return error
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return isErrorEnvelope(Array.isArray(parsed) ? parsed.find(entry => entry && typeof entry === 'object') : parsed)
    } catch {
      return null
    }
  }

  for (const line of raw.split('\n')) {
    const lineText = line.trim()
    if (!lineText.startsWith('data:')) continue
    const frame = lineText.slice(5).trim()
    if (!frame || frame === '[DONE]') continue
    try {
      const error = isErrorEnvelope(JSON.parse(frame))
      if (error) return error
    } catch {
      /* not a JSON frame — keep scanning */
    }
  }
  return null
}

/**
 * True when the model's most recent test response is a clean 'Ready': a
 * non-expired, successful result with non-empty text and no error.
 *
 * This is the authoritative definition of "the test passed" used by both the
 * dashboard status display and the bulk-retest filter. A model whose last
 * response reads Ready is considered up regardless of what its stale ping/
 * status field says — the last real request is the ground truth.
 *
 * @param {object|null} lastResponse  the persisted lastResponse entry
 * @param {number} [now]              epoch ms for expiry checks (defaults to Date.now())
 * @returns {boolean}
 */
export function isLastResponseReady(lastResponse, now = Date.now()) {
  if (!lastResponse) return false
  if (lastResponse.ok === false) return false
  if (lastResponse.error) return false
  if (isEmptyModelResponseText(lastResponse.text)) return false
  if (lastResponse.expiresAt != null && Number(lastResponse.expiresAt) < now) return false
  return true
}

/**
 * Detects rate-limit rejections that arrive outside an HTTP 429 — some
 * gateways wrap a provider rate limit in another status with a text-only
 * signal, e.g. Anthropic-style bodies:
 * {"type":"error","error":{"type":"FreeUsageLimitError",
 *  "message":"Error from provider (Console): Rate limit exceeded. Please try again later."}}
 */
export function isRateLimitedErrorText(errorText) {
  const t = String(errorText || '')
  return /freeusagelimiterror|rate\s*limit[^.\n]{0,40}(?:exceeded|reached)|too many requests/i.test(t)
}

/**
 * Detects a "model is gone" rejection: HTTP 410 Gone, or error text declaring
 * the model retired/removed (e.g. NVIDIA's "has reached its end of life",
 * Cerebras' "is archived and unavailable"). The dashboard shows these as a
 * persistent "Dead" status instead of a generic "Down".
 */
export function isDeadModelError(errorText, status) {
  if (Number(status) === 410) return true
  const t = String(errorText || '')
  // NVIDIA NIM: "Function '...' Not found for account ..." (404 with a UUID)
  if (/not found for account/i.test(t)) return true
  // Google AI: model exists but isn't compatible with generateContent (404)
  if (/not found for api version/i.test(t)) return true
  // NVIDIA NIM: plain "404 page not found" for removed models
  if (Number(status) === 404 && /page not found/i.test(t)) return true
  // NVIDIA NIM: generic "Model not found" with 404 — definitively removed
  if (Number(status) === 404 && /\bmodel not found\b/i.test(t)) return true
  // OpenAI-compatible providers: a structured model_not_found response is a
  // permanent catalog/access failure, not a transient provider outage. The ping
  // path may pass along only the extracted message, so match that message too.
  if (/model_not_found|not_found_error/i.test(t) && /model does not exist|do not have access to it/i.test(t)) return true
  if (/model does not exist or you do not have access to it/i.test(t)) return true
  // Relay gateways (g4f.space): the catalog advertises a model that no backend
  // server actually serves — "No server found that supports model 'X'" with HTTP
  // 404. That is a permanent catalog failure, not a transient provider outage, so
  // it must land in the graveyard rather than as a generic 'down'.
  if (/no (?:server|provider|backend) (?:was )?found (?:that )?(?:supports?|for) (?:the )?model/i.test(t)) return true
  // Same family, per-server: the gateway routes to a backend that does not serve
  // this model and says so — "Model 'x' is not allowed on this server" (HTTP 400,
  // type model_not_allowed). No retry can make that backend serve it.
  if (/not allowed on this server|model_not_allowed/i.test(t)) return true
  return /(?:reached|has reached|at) (?:its )?end of life|eol|no longer (?:available|supported)|gone|archived|discontinued|deprecated|retired/i.test(t)
}

/**
 * Decides whether a failed ping probe should be ignored (model stays 'up')
 * based on how recently the model+provider actually served a successful
 * request. Real traffic / manual tests are the ground truth; a probe failure
 * is treated as a transient blip (cold start, slow wake) when liveness is
 * recent.
 *
 * - `keepUpMs`: any failed probe is ignored when a success happened within
 *   this window (an endpoint that answered 5 minutes ago isn't down now).
 * - `timeoutGraceMs`: a *timeout* (code '000') is non-authoritative — it means
 *   "no answer within the probe budget", which a slow-but-alive endpoint can
 *   easily produce. Within this (longer) window a timeout never condemns a
 *   row that has real liveness evidence. Real errors like 401/404/5xx remain
 *   authoritative and are only papered over within `keepUpMs`.
 *
 * Returns true when the failed probe should be ignored (row keeps its status;
 * 'pending' rows are promoted to 'up'), false when the verdict applies.
 */
export function shouldKeepUpAfterFailedProbe({ status, code, lastServedAt, now, keepUpMs, timeoutGraceMs }) {
  if (code === '200') return false
  if (!['up', 'pending'].includes(status)) return false
  if (!Number.isFinite(lastServedAt) || lastServedAt <= 0) return false
  const served = Number(lastServedAt)
  const nowMs = Number(now)
  if (served > nowMs - keepUpMs) return true
  if (String(code) === '000' && Number.isFinite(timeoutGraceMs) && served > nowMs - timeoutGraceMs) return true
  return false
}

/**
 * Extracts a provider-stated max_tokens cap, e.g.
 * "`max_tokens` must be less than or equal to `8192`, the maximum value for
 * `max_tokens` is less than the `context_window` for this model" -> 8192.
 * Unlike parseContextLimitFromError, this only matches the max_tokens-cap
 * phrasing (used to retry test requests with a legal max_tokens value).
 */
export function parseMaxTokensCapFromError(errorText) {
  const t = String(errorText || '')
  const patterns = [
    // vLLM/TGI-style validation: max_tokens is bounded by max_model_len.
    /max_?tokens\s*[=:]\s*[\d,.]+[^\n]{0,120}?max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i,
    /max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i,
    /max_?tokens[^\d]{0,60}must be (?:less than or equal to|no more than|at most)[^\d]{0,12}([\d,.]+)/i,
  ]
  for (const pattern of patterns) {
    const match = t.match(pattern)
    if (!match) continue
    const n = Number((match[1] || '').replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return null
}

/** Heuristic: does this error text look like a context/input-too-long rejection? */
export function isOverLengthErrorText(errorText) {
  const t = String(errorText || '').toLowerCase()
  if (t.includes('context_length_exceeded')) return true
  if (t.includes('contextwindowexceeded')) return true
  if (/max_?model_?len\s*=\s*max_?total_?tokens/i.test(t)) return true
  if (/(maximum|max(?:imum)?)\s+context/i.test(t)) return true
  if (/context\s+(?:length|window).{0,40}(?:max|exceed|limit|too long)/i.test(t)) return true
  return /(context|prompt|input|messages|request).{0,60}(too long|exceed|maximum|max|longer than|over.?limit)/.test(t)
}

/** Rough prompt-size estimate (chars/4) used only to infer a soft context ceiling. */
export function estimateMessageTokens(messages) {
  let chars = 0
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = m && m.content
    chars += typeof content === 'string' ? content.length : JSON.stringify(content || '').length
    chars += 32 // per-message overhead (role, metadata)
  }
  return Math.max(1, Math.ceil(chars / 4))
}

/**
 * Coerces a rate-limit reset value (epoch seconds or epoch ms, as a string or
 * number) into an epoch-ms timestamp. Returns null when absent/unparseable.
 */
export function parseEpochResetValue(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  // 10-digit values are epoch seconds; 13-digit are already epoch ms
  return n < 1e12 ? n * 1000 : n
}

/**
 * Parses relative duration strings into milliseconds: "37.71s", "1m30s",
 * "12ms", or a bare number (assumed seconds — the common retry-after style).
 * Returns null when unparseable.
 */
export function parseRetryDelayMs(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const num = Number(s)
  if (Number.isFinite(num) && num > 0) return num * 1000 // plain number = seconds
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i)
  if (!m) return null
  let ms = 0
  if (m[1]) ms += parseFloat(m[1]) * 3_600_000
  if (m[2]) ms += parseFloat(m[2]) * 60_000
  if (m[3]) ms += parseFloat(m[3]) * 1000
  if (m[4]) ms += parseFloat(m[4])
  return ms > 0 ? Math.round(ms) : null
}

/**
 * Extracts quota-exhaustion metadata from a provider error body. Handles the
 * Google (Gemini) `details[].QuotaFailure.violations[]` shape and simple
 * `error.code` markers like "quota_exceeded" / "insufficient_quota". Returns
 * { code, quotaId, quotaValue, quotaMetric } (string fields, null when absent).
 */
export function extractQuotaFailure(text) {
  const result = { code: null, quotaId: null, quotaValue: null, quotaMetric: null }
  if (!text) return result
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return result
  }
  // Google/Gemini wraps 429 bodies in a single-element array: [{error:...}]
  const err = Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' ? data[0].error
    : (data && typeof data === 'object' ? data.error : null);
  if (err && typeof err === 'object') {
    const code = String(err.code ?? err.status ?? '')
    if (/quota|quota_exceeded|insufficient_quota|resource_exhausted|rate_limit/i.test(code)) {
      result.code = code
    }
    // Google/Gemini flatten QuotaFailure directly on each detail object
    for (const detail of Array.isArray(err.details) ? err.details : []) {
      if (!detail || typeof detail !== 'object') continue
      const violations = detail.QuotaFailure?.violations ?? detail.quotaFailure?.violations ?? (Array.isArray(detail.violations) ? detail.violations : null)
      if (Array.isArray(violations) && violations.length > 0) {
        const v = violations[0]
        result.quotaId = v.quotaId ?? result.quotaId
        result.quotaMetric = v.quotaMetric ?? result.quotaMetric
        result.quotaValue = v.quotaValue ?? result.quotaValue
      }
    }
  }
  return result
}

/**
 * Extracts an epoch-ms reset timestamp from a rate-limit (HTTP 429) response.
 * Checks, in order:
 *  1. response headers: x-ratelimit-reset (epoch), retry-after (seconds)
 *  2. parsed JSON body error.metadata.headers["X-RateLimit-Reset"] (epoch)
 *  3. parsed JSON body error.headers["X-RateLimit-Reset"] (epoch)
 *  4. parsed JSON body error.details[].RetryInfo.retryDelay (relative duration,
 *     Google/Gemini shape) — returned as now + delay
 * Returns null when the provider didn't communicate a reset time.
 * @param {string|null} text raw response body
 * @param {function(string): (string|null)} [headerGet] header lookup, e.g. (n) => res.headers.get(n)
 */
export function extractRateLimitResetMs(text, headerGet) {
  if (typeof headerGet === 'function') {
    const hdr = headerGet('x-ratelimit-reset')
    if (hdr != null && String(hdr).trim() !== '') {
      const ms = parseEpochResetValue(hdr)
      if (ms != null) return ms
    }
    const retryAfter = headerGet('retry-after')
    if (retryAfter != null) {
      const s = Number(String(retryAfter).trim())
      if (Number.isFinite(s) && s > 0) return Date.now() + s * 1000
    }
  }
  if (text) {
    try {
      const data = JSON.parse(text)
      // Google/Gemini wraps 429 bodies in a single-element array: [{error:...}]
      const err = Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' ? data[0].error
        : (data && typeof data === 'object' ? data.error : null);
      if (err && typeof err === 'object') {
        // metadata.headers (OpenRouter style) and error.headers (OpenAI style)
        for (const container of [err.metadata?.headers, err.headers]) {
          if (!container || typeof container !== 'object') continue
          const reset = container['X-RateLimit-Reset'] ?? container['x-ratelimit-reset'] ?? container['X-Ratelimit-Reset']
          const ms = parseEpochResetValue(reset)
          if (ms != null) return ms
        }
        // error.retry_after (seconds), some providers include it inline
        if (err.retry_after != null) {
          const delay = parseRetryDelayMs(err.retry_after)
          if (delay != null) return Date.now() + delay
        }
        // details[].RetryInfo.retryDelay — Google/Gemini shape (both the nested
        // object form and the flattened detail with an inline retryDelay)
        if (Array.isArray(err.details)) {
          for (const detail of err.details) {
            if (!detail || typeof detail !== 'object') continue
            const retryInfo = detail.RetryInfo ?? detail.retryInfo
            const delay = parseRetryDelayMs(retryInfo?.retryDelay ?? detail.retryDelay)
            if (delay != null) {
              const at = Date.now() + delay
              if (Number.isFinite(at)) return at
            }
          }
        }
      }
    } catch {
      /* non-JSON body — no reset time available */
    }
  }
  return null
}

export function computeQoSMap(results, excludedModelIds = [], { latencyTargetMs = DEFAULT_QOS_LATENCY_TARGET_MS } = {}) {
  const excluded = new Set(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !excluded.has(r.modelId))

  const qosMap = new Map()
  for (const r of eligible) {
    const intellNorm = percentileRank(QOS_REFERENCE_INTELL, toValidPositiveNumber(r.intell))
    const qos = computeQoSFromNormalizedScores(r, { gpqa: intellNorm }, latencyTargetMs)
    qosMap.set(r, qos)
  }

  return qosMap
}

export function computeQoS(r, latencyTargetMs) {
  const qosMap = computeQoSMap([r], [], { latencyTargetMs })
  return qosMap.get(r) || 0
}

/**
 * Name-based incompatibility rule: models whose id contains 'calibration'
 * (benchmark/analysis endpoints) or 'saudi' are not general chat models, so hammer
 * pins them 'incompatible' no matter what their probes return. Shared by the row
 * factory, the ping cycle, and the routing gate so all three classify the row the
 * same way.
 */
export function isBlockedModelName(modelId) {
  return /calibration|saudi/i.test(String(modelId || ''))
}

export function isModelEligibleForRouting(r) {
  if (r.status === 'banned' || r.status === 'disabled' || r.status === 'excluded') return false;
  // The name rule is a property of the model, not of a probe result: a row matching
  // a blocked name is never routable even while a recent response keeps it up.
  if (isBlockedModelName(r?.modelId)) return false;
  // Models the proxy has flagged as rate-limited (HTTP 429) are excluded from routing
  // until the rate-limit window expires (auto-cleared server-side). Without this gate,
  // rankModelsForRouting/findBestModel can still select a model the dashboard shows at
  // QoS 0 with isRateLimited=true, which (a) misleads the "Current Model" KPI and
  // (b) sends the next smartest request straight back into the same 429. Credit
  // exhaustion (rateLimit.creditRemaining <= 0 with a positive creditLimit) is left
  // to provider-specific handling -- some providers report credits inconsistently,
  // and the proxy's 429 + auto-expiry is the authoritative signal here.
  if (r.rateLimit && r.rateLimit.wasRateLimited === true) return false;
  return true;
}

export function getRoutingModelKey(r) {
  const provider = normalizeModelAlias(r?.providerKey)
  const model = normalizeModelAlias(r?.modelId)
  return provider ? `${provider}/${model}` : model
}

function normalizeExcludedModelKeys(excludedModelIds = []) {
  return new Set(excludedModelIds.map(value => normalizeModelAlias(value)))
}

function isRoutingModelExcluded(r, excluded) {
  return excluded.has(normalizeModelAlias(r?.modelId)) || excluded.has(getRoutingModelKey(r))
}

export function rankModelsForRouting(results, excludedModelIds = [], options = {}) {
  const excluded = normalizeExcludedModelKeys(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !isRoutingModelExcluded(r, excluded))
  const qosMap = computeQoSMap(eligible, [], options)
  const scored = eligible.map(r => ({ r, qos: qosMap.get(r) || 0 }))
  scored.sort((a, b) => b.qos - a.qos)
  return scored.map(s => s.r)
}

/**
 * Ranks the working models for the `smartest` virtual model. The Artificial
 * Analysis Intelligence Index is the primary ordering; models without one follow on
 * the normalized local intelligence score (the same catalog fallback the dashboard
 * uses), and rows with neither rating come last — still reachable, so a pool that
 * ran out of rated models fails over to an unrated one instead of failing the
 * request. A null rating means absent, not zero: `Number(null)` is 0 and 0 is
 * finite, so reading the raw field ranked every unscored row as a zero-rated
 * runner-up — above a scored row whenever the name tie-break favoured it — and made
 * the intelligence fallback unreachable. Latency is deliberately not part of this
 * ranking. Rate-limited models are already excluded by isModelEligibleForRouting,
 * and attempted models are removed between retries so quota failures fall through to
 * the next highest score.
 */
export function rankModelsForSmartest(results, excludedModelIds = []) {
  const excluded = normalizeExcludedModelKeys(excludedModelIds)
  const eligible = results.filter(r => (
    r.status === 'up'
    && isModelEligibleForRouting(r)
    && !isRoutingModelExcluded(r, excluded)
  ))
  const rateOf = (r, field) => {
    const value = r[field]
    if (value == null) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const tiered = eligible.map(r => {
    const aa = rateOf(r, 'aa')
    if (aa != null) return { r, tier: 0, rate: aa }
    const intell = rateOf(r, 'intell')
    if (intell != null) return { r, tier: 1, rate: intell }
    return { r, tier: 2, rate: 0 }
  })
  return tiered.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (b.rate !== a.rate) return b.rate - a.rate
    return String(a.r.modelId || '').localeCompare(String(b.r.modelId || ''))
  }).map(({ r }) => r)
}

export function findBestModel(results, options = {}) {
  const ranked = rankModelsForRouting(results, [], options)
  return ranked[0] || null
}

export function findSmartestModel(results, excludedModelIds = []) {
  return rankModelsForSmartest(results, excludedModelIds)[0] || null
}

/**
 * Combined speed metric shared by the dashboard scatter and slope-line routing:
 * 1 / (TTFT + 600 / tok-per-second). Higher is faster overall. Returns null when
 * either input is missing or invalid so callers can skip the row consistently.
 * TTFT falls back to the last recorded test response, mirroring the /api/models
 * formatter, so routing and the plot always evaluate the same number.
 */
export function computeRowSpeed(r) {
  const ttft = r?.ttft != null ? Number(r.ttft) : (r?.lastResponse && r.lastResponse.ttftMs != null ? Number(r.lastResponse.ttftMs) : null)
  const tps = r?.tps != null ? Number(r.tps) : (r?.lastResponse && r.lastResponse.tps != null ? Number(r.lastResponse.tps) : null)
  if (!Number.isFinite(ttft) || ttft < 0) return null
  if (!Number.isFinite(tps) || tps <= 0) return null
  return 1 / (ttft + 600 / tps)
}

/**
 * Intelligence value used consistently by the dashboard scatter and slope-line
 * routing: the Artificial Analysis Intelligence Index when the row has one (AA's
 * own rating, or the one interpolated from an Elo where AA has none), otherwise the
 * local score mapped onto that same 0-100 scale (score * 100). Returns null when
 * neither source has a usable value.
 */
export function computeRowIntelligence(r) {
  const aaNum = Number(r?.aa)
  if (Number.isFinite(aaNum) && aaNum > 0) return aaNum
  const intellNum = Number(r?.intell) * 100
  if (Number.isFinite(intellNum) && intellNum > 0) return intellNum
  return null
}

/**
 * Slope-line model selection ("lower a line of the given slope onto the
 * intelligence-vs-speed plot; the first model it touches wins").
 *
 * The line descends to the right — intelligence = intercept − slope × speed —
 * so raising the slope trades intelligence for speed. Lowering the intercept
 * from above makes first contact with the row maximizing
 * (intelligence + slope × speed), so the geometric "lower the line" process is
 * exactly an argmax — O(n), no incremental sweep needed. slope 0 therefore
 * picks the smartest eligible row; larger slopes favor faster rows.
 *
 * Options:
 *   slope    — required, finite number >= 0 (intelligence traded per unit speed)
 *   minSpeed   — optional minimum speed a row must meet
 *   minIntell  — optional minimum intelligence a row must meet
 *   excludeModelIds — rows already attempted this request, so a retry moves on
 *
 * Rows must be status 'up', pass isModelEligibleForRouting (banned / disabled /
 * excluded / rate-limited rows are skipped), and have both speed and intelligence.
 * Rows failing a minimum are skipped, so the pick falls through to the next
 * reachable row that clears both thresholds. Returns { model, margin } where
 * margin is the gap to the runner-up, or null when no row qualifies.
 */
/**
 * The configured slope of the slope-line selector, or null when the selector is
 * inert. A slope of 0 is meaningful — it selects the smartest row on the plot —
 * but a missing/null slope is not, and because Number(null) is 0 a bare
 * isFinite(Number(...)) test silently turns "no selector" into slope 0 and
 * reroutes smartest requests through the plot's argmax instead of the Elo
 * ranking. The API payload, the router's pick, and the dashboard all read the
 * setting through this one predicate so they can never disagree.
 */
export function selectorSlopeOf(selectorConfig) {
  const raw = selectorConfig?.slope
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Optional numeric option: null / undefined / '' mean "not set"; anything else
// must be a finite non-negative number to count. (Number(null) is 0, so a plain
// isFinite(Number(v)) check cannot tell "unset" from "zero".)
function optionalNonNegativeNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function selectModelBySlope(results, { slope, minSpeed = null, minIntell = null, excludeModelIds = [] } = {}) {
  if (slope == null) return null
  const slopeNum = Number(slope)
  if (!Number.isFinite(slopeNum) || slopeNum < 0) return null
  const minSpeedNum = optionalNonNegativeNumber(minSpeed)
  const minIntellNum = optionalNonNegativeNumber(minIntell)
  const excluded = normalizeExcludedModelKeys(excludeModelIds)

  let best = null
  let bestValue = -Infinity
  let runnerUpValue = -Infinity

  for (const r of results || []) {
    if (!r || r.status !== 'up' || !isModelEligibleForRouting(r)) continue
    if (excluded.size > 0 && isRoutingModelExcluded(r, excluded)) continue
    const speed = computeRowSpeed(r)
    const intell = computeRowIntelligence(r)
    if (speed == null || intell == null) continue
    if (minSpeedNum != null && speed < minSpeedNum) continue
    if (minIntellNum != null && intell < minIntellNum) continue
    const value = intell + slopeNum * speed
    if (value > bestValue) {
      if (best !== null) runnerUpValue = bestValue
      best = r
      bestValue = value
    } else if (value > runnerUpValue) {
      runnerUpValue = value
    }
  }

  if (!best) return null
  return { model: best, margin: bestValue - runnerUpValue }
}

function ensureKeyPoolAccount(entry, idx) {
  if (!entry.accounts.has(idx)) {
    entry.accounts.set(idx, { requests: 0, rateLimitedAt: 0 })
  }
  return entry.accounts.get(idx)
}

export function selectNextApiKeyFromPool(pool, entry, maxTurns, now, cooldownMs) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  if (!entry || !(entry.accounts instanceof Map)) return null

  const isRateLimited = idx => {
    const acct = entry.accounts.get(idx)
    return !!(acct && acct.rateLimitedAt && (now - acct.rateLimitedAt) < cooldownMs)
  }

  const trySelect = (respectMaxTurns) => {
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const idx = entry.currentIdx % pool.length
      const acct = entry.accounts.get(idx)
      const keyRateLimited = isRateLimited(idx)
      const hitMaxTurns = respectMaxTurns && maxTurns > 0 && acct && acct.requests >= maxTurns

      if (!keyRateLimited && !hitMaxTurns) {
        const selectedAccount = ensureKeyPoolAccount(entry, idx)
        selectedAccount.requests++
        entry.currentIdx = (idx + 1) % pool.length
        return pool[idx]
      }

      entry.currentIdx = (idx + 1) % pool.length
    }

    return null
  }

  const selected = trySelect(true)
  if (selected) return selected

  const hasNonRateLimitedKey = pool.some((_, idx) => !isRateLimited(idx))
  if (!hasNonRateLimitedKey) return null

  for (const [, acct] of entry.accounts) {
    acct.requests = 0
  }
  entry.currentIdx = 0

  return trySelect(false)
}

function normalizeModelAlias(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizeModelLabel(label) {
  if (typeof label !== 'string') return ''
  return cleanModelDisplayLabel(label)
    .replace(/\s+\([^)]*\)\s*$/g, '')
    .toLowerCase()
}

function toDisplayModelLabel(label, fallback) {
  if (typeof label === 'string' && label.trim()) {
    const cleaned = cleanModelDisplayLabel(label).replace(/\s+\([^)]*\)\s*$/g, '')
    if (cleaned) return cleaned
  }
  return fallback
}

function getExactModelCounts(results) {
  const counts = new Map()
  for (const r of results) {
    const key = normalizeModelAlias(r?.modelId)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function hasDuplicateExactModelId(r, exactModelCounts) {
  const key = normalizeModelAlias(r?.modelId)
  return key && normalizeModelAlias(r?.providerKey).startsWith('openai-compatible:') && (exactModelCounts.get(key) || 0) > 1
}

function getModelGroupKey(r, canonicalizeFn, exactModelCounts) {
  if (hasDuplicateExactModelId(r, exactModelCounts)) return getRoutingModelKey(r)

  const labelKey = normalizeModelLabel(r?.label)
  if (labelKey) return labelKey

  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    return normalizeModelAlias(unprefixed || base)
  }

  return normalizeModelAlias(r?.modelId || '')
}

function collectModelAliases(r, canonicalizeFn) {
  const aliases = new Set()
  const push = value => {
    const normalized = normalizeModelAlias(value)
    if (normalized) aliases.add(normalized)
  }

  push(r?.modelId)
  push(resolveAliasedModelId(r?.modelId))
  push(r?.label)
  push(getPreferredModelLabel(r?.modelId))
  if (typeof canonicalizeFn === 'function') {
    const { base, unprefixed } = canonicalizeFn(r?.modelId || '')
    push(base)
    push(unprefixed)
  }
  return aliases
}

function getModelGroupId(r, canonicalizeFn, displayLabel, exactModelCounts) {
  if (hasDuplicateExactModelId(r, exactModelCounts)) return getRoutingModelKey(r)

  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    const canonicalId = normalizeModelAlias(unprefixed || base)
    if (canonicalId) return canonicalId
  }

  const labelBasedId = normalizeModelLabel(displayLabel).replace(/\s+/g, '-')
  return labelBasedId || normalizeModelAlias(r?.modelId || '')
}

export function buildModelGroups(results, canonicalizeFn) {
  const groups = new Map()
  const exactModelCounts = getExactModelCounts(results)

  for (const r of results) {
    const key = getModelGroupKey(r, canonicalizeFn, exactModelCounts)
    if (!key) continue

    if (!groups.has(key)) {
      const displayLabel = toDisplayModelLabel(r.label, r.modelId)
      const groupId = getModelGroupId(r, canonicalizeFn, displayLabel, exactModelCounts)
      groups.set(key, {
        id: groupId,
        label: displayLabel,
        aliases: new Set(),
        models: [],
      })
    }

    const group = groups.get(key)
    group.models.push(r)
    for (const alias of collectModelAliases(r, canonicalizeFn)) {
      group.aliases.add(alias)
    }
  }

  return Array.from(groups.values())
    .map(group => ({
      id: group.id,
      label: group.label,
      aliases: Array.from(group.aliases),
      models: group.models,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

const TAG_REQUEST_PREFIX = 'tag:'

/**
 * Parses a human-readable context-size string ("128k", "1m", "32000") into a raw token count.
 * Returns null for anything unparseable/empty. Used by the `tag:<name>+min_ctx:<n>` request
 * syntax to filter out models whose context window can't fit the caller's stated requirement.
 */
export function parseContextSize(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null

  const str = String(value).trim().toLowerCase()
  if (!str || str === '—') return null
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([km])?$/)
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num) || num <= 0) return null
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return Math.round(num * multiplier)
}

/**
 * Parses `+`-delimited `key:value` modifiers, e.g. the `min_ctx:32000` in
 * `tag:general+min_ctx:32000` or `best+min_ctx:128k`. Unknown modifier keys are
 * ignored rather than rejected, so new modifiers can be added later without breaking older
 * callers or requiring a new reserved prefix per modifier.
 */
function parseModifiers(parts) {
  let minCtx = null
  for (const part of parts) {
    const sepIdx = part.indexOf(':')
    if (sepIdx === -1) continue
    const key = part.slice(0, sepIdx).trim()
    const value = part.slice(sepIdx + 1).trim()
    if (key === 'min_ctx' && value) {
      const parsed = parseContextSize(value)
      if (parsed != null) minCtx = parsed
    }
  }
  return { minCtx }
}

/**
 * Parses a `tag:<name>[+modifier...]` request. The tag name is always the first
 * `+`-delimited segment; anything after that is passed to parseModifiers().
 */
function parseTagRequest(rest) {
  const parts = String(rest || '').split('+').map(s => s.trim()).filter(Boolean)
  const tag = parts[0] || ''
  const { minCtx } = parseModifiers(parts.slice(1))
  return { tag, minCtx }
}

function matchesMinCtx(result, minCtx) {
  if (minCtx == null) return true
  if (result.ctxSource === 'model-maximum') return false
  const resultCtx = parseContextSize(result.ctx)
  return resultCtx != null && resultCtx >= minCtx
}

export function filterModelsByRequested(results, requestedModel, canonicalizeFn) {
  if (!requestedModel) return results

  const requested = normalizeModelAlias(requestedModel)
  if (requested === 'best' || requested === 'smartest') return results

  // best+min_ctx:<n>: the same Elo-driven selection as best, but restricted
  // to models that can actually fit a prompt of the caller's stated size.
  const bestRequestPrefix = requested.startsWith('best+') ? 'best+' : 'smartest+'
  if (requested.startsWith('best+') || requested.startsWith('smartest+')) {
    const parts = requested.slice(bestRequestPrefix.length).split('+').map(s => s.trim()).filter(Boolean)
    const { minCtx } = parseModifiers(parts)
    if (minCtx == null) return results
    return results.filter(result => matchesMinCtx(result, minCtx))
  }

  if (requested.startsWith(TAG_REQUEST_PREFIX)) {
    const { tag, minCtx } = parseTagRequest(requested.slice(TAG_REQUEST_PREFIX.length))
    if (!tag) return []
    return results.filter(result => {
      const tags = [...getBuiltInModelTags(result.modelId), ...(Array.isArray(result.tags) ? result.tags : [])]
      return tags.includes(tag) && matchesMinCtx(result, minCtx)
    })
  }
  const providerQualifiedMatches = results.filter(r => getRoutingModelKey(r) === requested)
  if (providerQualifiedMatches.length > 0) return providerQualifiedMatches

  const exactMatches = results.filter(r => normalizeModelAlias(r.modelId) === requested)
  if (exactMatches.length > 0) return exactMatches

  if (typeof canonicalizeFn === 'function') {
    const baseMatches = results.filter(r => {
      const { base } = canonicalizeFn(r.modelId)
      return normalizeModelAlias(base) === requested
    })
    if (baseMatches.length > 0) return baseMatches
  }

  const groups = buildModelGroups(results, canonicalizeFn)
  const matchedGroup = groups.find(group => group.aliases.includes(requested))
  return matchedGroup ? matchedGroup.models : []
}

export function isRetryableProxyStatus(status) {
  const code = Number(status)
  if (!Number.isInteger(code)) return false
  return code === 429 || code === 410 || code >= 500
}

/** Returns true for quota/credit exhaustion bodies that should advance `smartest`. */
export function isQuotaExhaustionError(errorText, status = null) {
  const code = Number(status)
  if (code === 429) return true
  const raw = String(errorText || '')
  // Body-level signals win over the transport status: relays sometimes pass a
  // provider's quota rejection through with a different HTTP status, but a body
  // that explicitly says RESOURCE_EXHAUSTED / quota_exceeded, carries QuotaFailure
  // metadata, or embeds an rpc code of 429 is definitively quota exhaustion
  // (Google/Gemini shape: [{error: {code: 429, status: 'RESOURCE_EXHAUSTED', ...}}]).
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const quota = extractQuotaFailure(raw)
    if (quota.code || quota.quotaId || quota.quotaMetric || quota.quotaValue) return true
    try {
      const data = JSON.parse(raw)
      const err = Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' ? data[0].error
        : (data && typeof data === 'object' ? data.error : null)
      if (err && typeof err === 'object' && Number(err.code) === 429) return true
    } catch {
      /* not JSON — fall through to the text heuristic */
    }
  }
  const text = raw.toLowerCase()
  if (!/(quota|rate[\s_-]*limit|credit|too many requests|resource_exhausted|insufficient)/i.test(text)) return false
  if (![400, 402, 403].includes(code)) return false
  return /(exceed|exhaust|deplet|limit|unavailable|too many|insufficient|maximum|maxed|billing)/i.test(text)
}

/**
 * Computes the "last refreshed at" timestamp to record after a *failed* discovery/sync
 * attempt, so the next TTL check allows a retry after `retryBackoffMs` instead of waiting out
 * the full `refreshIntervalMs` success TTL. Without this, one transient network failure gets
 * treated the same as a successful refresh and silently locks out automatic retries for the
 * whole TTL window (up to an hour, depending on the provider) until a manual force-refresh.
 */
export function computeFailedRefreshRetryAt(now, refreshIntervalMs, retryBackoffMs) {
  return now - refreshIntervalMs + retryBackoffMs
}

/**
 * Decides which previously-known provider rows survive after a /v1/models discovery
 * refresh. Discovery is authoritative when it returned a healthy list: static rows
 * the live endpoint no longer offers are pruned (models that hit end-of-life or were
 * renamed), and only providers whose discovery is known-incomplete opt out via
 * `keepStaticOnDiscovery`. A failed/empty discovery (`models.length === 0`) keeps
 * every previously-known row untouched, so a transient error never blanks the table.
 * Returns the subset of `providerRows` to keep.
 * @param {Array<{modelId:string, providerKey:string}>} providerRows current rows
 * @param {Iterable<string>} staticIds curated static ids from sources.js
 * @param {Array<{modelId:string}>} models discovered models this round
 * @param {boolean} keepStaticOnDiscovery provider opts out of pruning
 */
export function pruneDiscoverableRows(providerRows, staticIds, models, keepStaticOnDiscovery) {
  const staticSet = new Set(staticIds || [])
  const discoveredSet = new Set((models || []).map(m => m.modelId))
  const discoveryHealthy = Array.isArray(models) && models.length > 0
  const keepStatic = keepStaticOnDiscovery === true || !discoveryHealthy
  return (providerRows || []).filter(row => {
    // Static rows survive when kept (failed refresh / opt-out) or when the live
    // endpoint still lists them; previously-discovered rows survive only when
    // the provider still lists them this round.
    if (discoveredSet.has(row.modelId)) return true
    return staticSet.has(row.modelId) && keepStatic
  })
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  const firstCommandToken = args.find(a => !a.startsWith('--'))
  const command = firstCommandToken ? firstCommandToken.toLowerCase() : 'run'
  const hasOnboardToken = args.some(a => a.toLowerCase() === 'onboard' || a.toLowerCase() === '--onboard')
  const hasAutostartToken = args.some(a => a.toLowerCase() === 'autostart' || a.toLowerCase() === '--autostart')
  const showHelp = args.some(a => ['--help', '-h', 'help'].includes(a.toLowerCase()))

  const hasLogFlag = args.some(a => a.toLowerCase() === '--log')
  const hasNoLogFlag = args.some(a => a.toLowerCase() === '--no-log')
  const enableLog = hasLogFlag && !hasNoLogFlag

  const hasInstallFlag = args.some(a => a.toLowerCase() === '--install')
  const hasStartFlag = args.some(a => a.toLowerCase() === '--start')
  const hasUninstallFlag = args.some(a => a.toLowerCase() === '--uninstall')
  const hasStatusFlag = args.some(a => a.toLowerCase() === '--status')
  const hasEnableFlag = args.some(a => a.toLowerCase() === '--enable')
  const hasDisableFlag = args.some(a => a.toLowerCase() === '--disable')

  let autostartAction = null
  let autoUpdateAction = null
  if (command === 'install' && hasAutostartToken) autostartAction = 'install'
  if (command === 'start' && hasAutostartToken) autostartAction = 'start'
  if (command === 'uninstall' && hasAutostartToken) autostartAction = 'uninstall'
  if (command === 'status' && hasAutostartToken) autostartAction = 'status'

  if (command === 'autostart') {
    const positionalAction = args.find((a, idx) => idx > 0 && ['install', 'start', 'uninstall', 'status'].includes(a.toLowerCase()))
    if (hasInstallFlag || positionalAction?.toLowerCase() === 'install') autostartAction = 'install'
    else if (hasStartFlag || positionalAction?.toLowerCase() === 'start') autostartAction = 'start'
    else if (hasUninstallFlag || positionalAction?.toLowerCase() === 'uninstall') autostartAction = 'uninstall'
    else if (hasStatusFlag || positionalAction?.toLowerCase() === 'status') autostartAction = 'status'
    else autostartAction = 'status'
  }

  if (command === 'autoupdate') {
    if (hasEnableFlag) autoUpdateAction = 'enable'
    else if (hasDisableFlag) autoUpdateAction = 'disable'
    else if (hasStatusFlag) autoUpdateAction = 'status'
    else autoUpdateAction = 'status'
  }

  if (hasEnableFlag && command !== 'autoupdate') autoUpdateAction = 'enable'
  if (hasDisableFlag && command !== 'autoupdate') autoUpdateAction = 'disable'

  const portIdx = args.findIndex(a => a.toLowerCase() === '--port')
  const portValueIdx = (portIdx !== -1 && args[portIdx + 1] && !args[portIdx + 1].startsWith('--'))
    ? portIdx + 1
    : -1

  const banIdx = args.findIndex(a => a.toLowerCase() === '--ban')
  const banValueIdx = (banIdx !== -1 && args[banIdx + 1] && !args[banIdx + 1].startsWith('--'))
    ? banIdx + 1
    : -1

  const intervalIdx = args.findIndex(a => a.toLowerCase() === '--interval')
  const intervalValueIdx = (intervalIdx !== -1 && args[intervalIdx + 1] && !args[intervalIdx + 1].startsWith('--'))
    ? intervalIdx + 1
    : -1

  const hostIdx = args.findIndex(a => a.toLowerCase() === '--host')
  const hostValueIdx = (hostIdx !== -1 && args[hostIdx + 1] && !args[hostIdx + 1].startsWith('--'))
    ? hostIdx + 1
    : -1

  let bannedModels = []
  if (banValueIdx !== -1) {
    bannedModels = args[banValueIdx].split(',').map(s => s.trim()).filter(Boolean)
  }

  let portValue = 7352
  if (portValueIdx !== -1) {
    const parsedPort = parseInt(args[portValueIdx], 10)
    // Reject 0 / negative / out-of-range ports instead of silently accepting them.
    portValue = (Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) ? parsedPort : 7352
  }

  let hostValue = null
  if (hostValueIdx !== -1) {
    hostValue = args[hostValueIdx].trim() || null
  }

  let autoUpdateIntervalHours = null
  if (intervalValueIdx !== -1) {
    const parsed = Number(args[intervalValueIdx])
    if (Number.isFinite(parsed) && parsed > 0) {
      autoUpdateIntervalHours = parsed
    }
  }

  let configAction = null
  let configPayload = null
  let configProvider = null
  let configKeys = null
  let configMaxTurns = null
  if (command === 'config') {
    const actionIdx = args.findIndex((a, idx) => idx > 0 && !a.startsWith('--'))
    const action = actionIdx !== -1 ? args[actionIdx].toLowerCase() : null
    if (action === 'export' || action === 'import') {
      configAction = action
    }
    if (configAction === 'import' && actionIdx !== -1) {
      const payload = args.slice(actionIdx + 1).join(' ').trim()
      if (payload) configPayload = payload
    }
    if (action === 'set-keys' || action === 'add-key' || action === 'remove-key') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configKeys = args.slice(3).join(' ')
      }
    }
    if (action === 'set-maxturns') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configMaxTurns = args[3]
      }
    }
  }

  return {
    command,
    autostartAction,
    autoUpdateAction,
    portValue,
    hostValue,
    enableLog,
    bannedModels,
    autoUpdateIntervalHours,
    configAction,
    configPayload,
    configProvider,
    configKeys,
    configMaxTurns,
    autostart: hasAutostartToken,
    onboard: hasOnboardToken,
    help: showHelp,
  }
}

function parseNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseDateToMs(value) {
  if (!value) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }

  if (typeof value !== 'string') return null

  const asNum = parseNumber(value)
  if (asNum != null) {
    return asNum > 1e12 ? Math.round(asNum) : Math.round(asNum * 1000)
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Converts provider reset headers into an absolute timestamp. Providers
 * variously return epoch seconds, epoch milliseconds, relative durations, or
 * HTTP dates, so callers should not assume a single wire format.
 */
export function parseRateLimitResetValue(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null
  const raw = String(value).trim()
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 1e12) return Math.round(numeric)
    if (numeric >= 1e9) return Math.round(numeric * 1000)
    return now + Math.round(numeric * 1000)
  }
  const delay = parseRetryDelayMs(raw)
  if (delay != null) return now + delay
  const date = Date.parse(raw)
  return Number.isFinite(date) ? date : null
}

function parseResetToAbsoluteMs(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return Math.round(value)
    if (value >= 1e10) return Math.round(value * 1000)
    return Date.now() + Math.round(value * 1000)
  }

  if (typeof value === 'string') {
    const numeric = parseNumber(value)
    if (numeric != null) return parseResetToAbsoluteMs(numeric)
  }

  return parseDateToMs(value)
}

export function parseOpenRouterKeyRateLimit(payload) {
  const data = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' ? payload.data : payload)
    : null
  if (!data) return null

  const rateLimit = {}

  const creditLimit = parseNumber(data.limit)
  if (creditLimit != null) rateLimit.creditLimit = creditLimit

  const creditRemaining = parseNumber(data.limit_remaining)
  if (creditRemaining != null) rateLimit.creditRemaining = creditRemaining

  const creditResetAt = parseDateToMs(data.limit_reset)
  if (creditResetAt != null) rateLimit.creditResetAt = creditResetAt

  const legacy = data.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : null
  if (legacy) {
    const reqLimit = parseNumber(legacy.limit_requests ?? legacy.requests_limit ?? legacy.request_limit ?? legacy.limit)
    if (reqLimit != null) rateLimit.limitRequests = reqLimit

    const reqRemaining = parseNumber(legacy.remaining_requests ?? legacy.requests_remaining ?? legacy.request_remaining ?? legacy.remaining)
    if (reqRemaining != null) rateLimit.remainingRequests = reqRemaining

    const reqResetAt = parseResetToAbsoluteMs(legacy.reset_requests ?? legacy.requests_reset ?? legacy.reset)
    if (reqResetAt != null) rateLimit.resetRequestsAt = reqResetAt

    const tokLimit = parseNumber(legacy.limit_tokens ?? legacy.tokens_limit)
    if (tokLimit != null) rateLimit.limitTokens = tokLimit

    const tokRemaining = parseNumber(legacy.remaining_tokens ?? legacy.tokens_remaining)
    if (tokRemaining != null) rateLimit.remainingTokens = tokRemaining

    const tokResetAt = parseResetToAbsoluteMs(legacy.reset_tokens ?? legacy.tokens_reset)
    if (tokResetAt != null) rateLimit.resetTokensAt = tokResetAt
  }

  return Object.keys(rateLimit).length > 0 ? rateLimit : null
}

/**
 * Extracts the hostname (without port / brackets) from a Host or Origin header value.
 * 'localhost:7352' -> 'localhost', '[::1]:7352' -> '::1', '192.168.1.5' -> '192.168.1.5'.
 */
export function hostnameOf(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return ''
  let h = hostHeader.toLowerCase().trim()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end !== -1 ? h.slice(1, end) : h
  }
  const idx = h.lastIndexOf(':')
  if (idx !== -1 && /^\d+$/.test(h.slice(idx + 1))) {
    h = h.slice(0, idx)
  }
  return h
}

export function isLoopbackHostname(hostname) {
  if (!hostname) return false
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname)
}

export function isLoopbackRemoteAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true
  let a = addr
  if (a.startsWith('::ffff:')) a = a.slice(7)
  return a === '127.0.0.1' || /^127\./.test(a)
}

/**
 * Decides whether an incoming dashboard/proxy request is allowed given the server's
 * bind mode. Pure (no req/res) so it is unit-testable.
 *
 * - In loopback mode (default), the Host header must resolve to a loopback hostname
 *   (DNS-rebinding protection) and any Origin header must be a loopback origin.
 * - In LAN mode (user opted in via --host 0.0.0.0), the Origin must be loopback or
 *   match the requested Host (the address the user navigated to); the Host itself is
 *   not restricted. Token enforcement for non-loopback clients is handled separately.
 *
 * Returns an error message string when the request must be rejected, or null when it
 * is allowed.
 */
export function checkApiRequestAllowed({ origin = null, host = null, lanMode = false } = {}) {
  const hostHostname = hostnameOf(host)

  if (!lanMode && hostHostname && !isLoopbackHostname(hostHostname)) {
    return 'Forbidden: unexpected Host header.'
  }

  if (origin != null) {
    const originStr = String(origin).trim()
    if (!originStr || originStr === 'null') {
      return 'Forbidden: null Origin is not allowed.'
    }
    let originHost = ''
    try {
      originHost = hostnameOf(new URL(originStr).host)
    } catch {
      return 'Forbidden: invalid Origin.'
    }
    const loopbackOrigin = isLoopbackHostname(originHost)
    if (lanMode) {
      if (!loopbackOrigin && !(hostHostname && originHost === hostHostname)) {
        return 'Forbidden: cross-origin request blocked.'
      }
    } else if (!loopbackOrigin) {
      return 'Forbidden: cross-origin request blocked.'
    }
  }

  return null
}

/**
 * Fields that describe the API *key* rather than an individual model. OpenRouter reports
 * these from GET /api/v1/key (creditLimit/creditRemaining/creditResetAt) and they are
 * shared by every model on the key, so they are the only fields safe to merge
 * provider-wide. Everything else in a captured rate-limit payload (the x-ratelimit-*
 * headers and the wasRateLimited 429 flag) is scoped to the single model that produced
 * the response, because most providers (OpenRouter included) throttle per model, not per
 * provider.
 */
export const KEY_LEVEL_RATE_LIMIT_FIELDS = ['creditLimit', 'creditRemaining', 'creditResetAt']

export function pickKeyLevelRateLimit(rateLimit) {
  if (!rateLimit || typeof rateLimit !== 'object') return null
  const picked = {}
  for (const field of KEY_LEVEL_RATE_LIMIT_FIELDS) {
    if (rateLimit[field] != null) picked[field] = rateLimit[field]
  }
  return Object.keys(picked).length > 0 ? picked : null
}

export function mergeRateLimits(primary, secondary) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  return { ...primary, ...secondary };
}

/**
 * Reconciles quota state after a fresh provider response. Numeric limits remain
 * useful after success, while a successful response proves that an old 429
 * cooldown is no longer active for this model.
 */
export function reconcileRateLimitState(existing, captured, status, now = Date.now()) {
  const merged = mergeRateLimits(existing, captured)
  if (!merged) return null
  const next = { ...merged }
  const numericStatus = Number(status)
  if (numericStatus === 200) {
    delete next.wasRateLimited
    if (captured?.resetRequestsAt == null) delete next.resetRequestsAt
    if (captured?.resetTokensAt == null) delete next.resetTokensAt
    if (captured?.retryAfterMs == null) delete next.retryAfterMs
    if (captured?.quota == null) delete next.quota
  }
  if (numericStatus === 429) {
    next.wasRateLimited = true
    next.capturedAt = now
  }
  return Object.keys(next).length > 0 ? next : null
}

/**
 * Applies a freshly captured rate-limit payload to `model` and merges key-level credit
 * data into every sibling model sharing the same providerKey. The per-model payload
 * (wasRateLimited 429 flag, x-ratelimit-* headers, capturedAt) is written ONLY to
 * `model` -- a 429 on one model must not bench the rest of the provider, since most
 * providers throttle per model. OpenRouter key credits are per API key, so those fields
 * are legitimately shared provider-wide. Mutates results in place and returns it.
 *
 * - capturedPayload: per-model data from a proxied response (may be null, e.g. ping path)
 * - keyRateLimit: key-level data from the provider's key endpoint (may be null)
 */
export function applyRateLimitCapture(model, results, capturedPayload, keyRateLimit) {
  if (!model) return results
  if (capturedPayload && Object.keys(capturedPayload).length > 0) {
    model.rateLimit = capturedPayload
  }
  if (keyRateLimit) {
    model.rateLimit = mergeRateLimits(model.rateLimit, keyRateLimit)
    const keyLevel = pickKeyLevelRateLimit(keyRateLimit)
    if (keyLevel) {
      for (const r of results) {
        if (r !== model && r.providerKey === model.providerKey) {
          r.rateLimit = mergeRateLimits(r.rateLimit, keyLevel)
        }
      }
    }
  }
  return results
}
