/**
 * @file lib/utils.js
 * @description Pure utility functions for scoring and CLI parsing.
 */

import { MODELS, cleanModelDisplayLabel, getLatestModelFamilyKey, getModelVersionTuple, getPreferredModelLabel, isLatestModelName, isSameModelIdentity, resolveAliasedModelId, stripRoutingNamespace } from '../sources.js'

export const VERDICT_ORDER = ['Perfect', 'Normal', 'Slow', 'Very Slow', 'Overloaded', 'Unstable', 'Not Active', 'Pending']

export const DEFAULT_PING_WINDOW_MS = 35 * 60 * 1000

// Reference latency (ms) for QoS scoring. A model averaging this speed keeps its full
// quality-driven score; slower models are discounted continuously by latencyScore() below.
// Overridable per deployment via the `qosLatencyTargetMs` config setting in
// ~/.hammer.json, same pattern as the existing minSweScore filter.
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
    // Samples that actually produced output, so the mean response length divides by
    // responses and not by attempts (see computeUsageAverages).
    completionSamples: 0,
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
  next.completionSamples = Number.isFinite(Number(prev.completionSamples)) && Number(prev.completionSamples) >= 0 ? Number(prev.completionSamples) : 0
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
    // Counted exactly when the same sample is usable as a response length: a request
    // that returned nothing is an attempt, not an answer, and letting it divide the
    // mean length would make a model look instant because it kept failing.
    if (completionTokens > 0) next.completionSamples += 1
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
 * How long a streamed answer actually took to generate, judged from the frames the
 * client received.
 *
 * The obvious figure — total time minus time-to-first-token — is the generation window
 * only when the provider emits the answer as it produces it. Providers that *bank* an
 * answer (Devin's gateway releases a tool-call payload, and any endpoint that holds the
 * response until the model is done) send almost nothing until the very end: the first
 * frame the client sees already contains the whole answer, so `total - ttft` collapses
 * to a few tens of milliseconds. Dividing a full answer by that measures nothing but
 * the network delivery, which is how one row came to advertise ~6000 tok/s — an order of
 * magnitude past any real serving stack, and enough to make it the fastest dot on the
 * plot and the router's pick for every request.
 *
 * So the window is trusted only when it covers enough of the request to be a generation
 * window at all (a quarter of the total). Below that there is no way to separate the
 * time the model spent producing those tokens from the time it spent waiting, and the
 * conservative figure is the whole request — the same one the non-streaming path uses.
 * Erring here can only understate a rate, never invent one.
 *
 * @param {number} elapsedMs  total time from sending the request to the last frame
 * @param {number} outputWindowMs  time spanned by the output-bearing frames (0 when all
 *   of the answer arrived in a single frame)
 * @returns {number} milliseconds to charge to generation, at least 1
 */
export function resolveStreamGenerationMs(elapsedMs, outputWindowMs) {
  const elapsed = Math.max(1, Math.round(Number(elapsedMs) || 0))
  const window = Math.max(0, Math.round(Number(outputWindowMs) || 0))
  if (window <= 0) return elapsed
  return window >= elapsed * BURST_WINDOW_RATIO ? window : elapsed
}

/**
 * The share of a request an output window must cover before it is believed to be the
 * generation window rather than the tail of a banked answer (see
 * resolveStreamGenerationMs). Dimensionless on purpose: it describes the *shape* of the
 * stream, so it holds whatever the provider's tokens-per-second happens to be.
 */
export const BURST_WINDOW_RATIO = 0.25

/**
 * A measured throughput no serving stack reaches. Used only to disown samples an older
 * build got wrong, never to reject a fresh measurement: the fastest real chat endpoints
 * answer in the low hundreds of tokens per second, so a row *averaging* thousands is
 * evidence about the measurement, not about the model.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1000

/**
 * Withdraws a row's accumulated rate samples when the stored average cannot be a
 * measurement of a language model (see MAX_PLAUSIBLE_TOKENS_PER_SECOND).
 *
 * The sums are what the speed metric, the tok/s column and the slope selector read, and
 * they are cumulative: a row that banked its answers for 250 requests keeps averaging
 * thousands of tokens per second long after the code that measured it is gone, because
 * the next correct sample adds ~1s of generation time against an existing pile of
 * tens of milliseconds. Nothing selective can be repaired — the sums do not say which
 * samples were bad — so the whole rate history is dropped and re-learned from the next
 * answers, exactly as an unreadable context bound is.
 *
 * Rate-limit state, quota state, the last test response, context bounds and learned
 * output caps are untouched: none of them came from these samples.
 *
 * @returns {object} the original object when nothing changed
 */
export function revalidateMeasuredRate(stats) {
  const prev = stats || {}
  const tokens = Number(prev.completionTokensSum)
  const genMs = Number(prev.genMsSum)
  if (!Number.isFinite(tokens) || tokens <= 0) return prev
  if (!Number.isFinite(genMs) || genMs <= 0) return prev
  const rate = tokens / (genMs / 1000)
  if (!Number.isFinite(rate) || rate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND) return prev
  const next = { ...prev }
  for (const key of ['requests', 'ttftSamples', 'ttftSum', 'completionTokensSum', 'completionSamples', 'genMsSum', 'lastTtft', 'lastTps']) {
    delete next[key]
  }
  return next
}

/**
 * Fills in the answered-sample counter for a usage entry written before it existed.
 *
 * `completionSamples` counts the samples that produced output, which is what makes
 * the mean response length a length rather than a per-attempt figure. Older entries
 * only kept the token total and their request count, and the two are not enough to
 * recover the split — so the request count is used as the estimate, and the counter
 * becomes exactly right only for the samples recorded from now on. That over-counts
 * the denominator for rows whose requests sometimes returned nothing, which errs
 * towards reporting such a row as slower than it is; leaving the field at zero would
 * instead make every historical row report no response length at all, dropping it off
 * the speed plot and out of the slope-line selector until it happened to serve again.
 *
 * Returns the original stats object when nothing changed.
 */
export function backfillCompletionSamples(stats) {
  const prev = stats || {}
  if (Number(prev.completionSamples) > 0) return prev
  const tokens = Number(prev.completionTokensSum)
  const requests = Number(prev.requests)
  if (!Number.isFinite(tokens) || tokens <= 0) return prev
  if (!Number.isFinite(requests) || requests <= 0) return prev
  return { ...prev, completionSamples: requests }
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
/**
 * The model part of a gateway catalog id. g4f namespaces entries per backend server
 * ("srv_ab12:model"), so a server's stated roster has to be compared against model
 * names rather than namespaced ids. Delegates to the shared stripper in sources.js
 * so every consumer agrees on what a namespaced id's model part is.
 */
function modelNameFromCatalogId(modelId) {
  return stripRoutingNamespace(modelId)
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
 * The output-token count a provider actually reported, for the figure the dashboard
 * prints as the provider's own. Returns null when there is no such count.
 *
 * A zeroed usage block is not a count, it is the absence of one: g4f's hosted pool
 * answers HTTP 200 with `usage: {prompt_tokens: 0, completion_tokens: 0,
 * total_tokens: 0}` while returning real text. Printing that as "0 tokens" next to a
 * tok/s measured from the same response (resolveCompletionTokens estimates from the
 * text, so it reports a real rate) states two contradictory things about one answer,
 * and an estimate must never be presented as a reported count to resolve it.
 *
 * A total a relay reports is used only when the output count is absent altogether,
 * never to stand in for one the provider zeroed out — the two are the same silent
 * zero, and only one of them at least names a token count.
 */
export function resolveReportedOutputTokens(reportedCompletionTokens, reportedTotalTokens) {
  const completion = Number(reportedCompletionTokens)
  if (reportedCompletionTokens != null && Number.isFinite(completion) && completion > 0) {
    return Math.round(completion)
  }
  if (reportedCompletionTokens == null) {
    const total = Number(reportedTotalTokens)
    if (reportedTotalTokens != null && Number.isFinite(total) && total > 0) return Math.round(total)
  }
  return null
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
 * tps is a token-weighted average (total tokens / total generation seconds), and
 * `tokens` is the mean length of the responses that produced output — the sample
 * basis the speed metric needs, over exactly the samples that fed genMsSum.
 *
 * @param {object|null} stats
 * @returns {{ttft:number|null, tps:number|null, tokens:number|null, requests:number}}
 */
export function computeUsageAverages(stats) {
  if (!stats || !(stats.requests > 0)) return { ttft: null, tps: null, tokens: null, requests: 0 }
  const ttft = stats.ttftSamples > 0 ? Math.round(stats.ttftSum / stats.ttftSamples) : null
  const tps = stats.genMsSum > 0 && stats.completionTokensSum > 0
    ? roundMeasuredRate(stats.completionTokensSum / (stats.genMsSum / 1000))
    : null
  const tokens = stats.completionSamples > 0 && stats.completionTokensSum > 0
    ? Math.round(stats.completionTokensSum / stats.completionSamples)
    : null
  return { ttft, tps, tokens, requests: stats.requests }
}

/**
 * Bumped whenever the rules that decide what may become a context bound change.
 * Stored with each bound's evidence so a later revision can tell which rules
 * produced a number instead of trusting one a previous parser wrote.
 */
export const CONTEXT_PARSER_VERSION = 2

/** How much of the error body is kept as a bound's evidence (it must stay re-parseable). */
export const CONTEXT_EVIDENCE_MAX_CHARS = 1000

/**
 * Merges an observed context-window bound into a usage-stats entry (see
 * accumulateUsageSample for the shape). Success samples raise `contextMin`;
 * over-length failures lower `contextMax` (with `contextMaxExact` marking whether
 * the number came from a provider-stated limit vs an inferred prompt-size ceiling).
 *
 * The error body behind the number rides along as `contextEvidence`, because a
 * bound that can never be re-examined can never be corrected: a parser revision
 * that stops reading throughput quotas as context (see parseContextLimitFromError)
 * must be able to withdraw the bounds its predecessor wrote. Writers are expected
 * to have already refused non-context bodies (isContextOverflowErrorText).
 *
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
      const evidenceText = typeof observation.evidence === 'string' ? observation.evidence.trim() : ''
      next.contextEvidence = {
        text: evidenceText.slice(0, CONTEXT_EVIDENCE_MAX_CHARS),
        kind: observation.exact === true ? 'provider-stated' : 'inferred',
        parserVersion: CONTEXT_PARSER_VERSION,
        at: Date.now(),
      }
    }
  }
  if (next.contextMin === prev.contextMin && next.contextMax === prev.contextMax) return prev
  next.contextUpdatedAt = Date.now()
  return next
}

/**
 * Drops a learned context bound from a usage-stats entry, leaving everything else
 * (rate limits, latency samples, test responses) untouched. Used by the manual reset
 * and the migration; returns the original object when there is nothing to clear.
 */
export function clearContextBound(stats) {
  if (!stats || typeof stats !== 'object') return stats
  if (stats.contextMax == null && stats.contextEvidence == null) return stats
  const next = { ...stats }
  delete next.contextMax
  delete next.contextMaxExact
  delete next.contextEvidence
  return next
}

/** Splits a usage-stats key ("<providerKey>::<modelId>") into its two parts. */
export function parseUsageStatKey(key) {
  const text = String(key || '')
  const separator = text.indexOf('::')
  if (separator === -1) return { providerKey: text, modelId: '' }
  return { providerKey: text.slice(0, separator), modelId: text.slice(separator + 2) }
}

/** Normalizes a stored evidence record, or null when there is nothing usable to re-read. */
export function normalizeContextEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const text = typeof evidence.text === 'string'
    ? evidence.text.slice(0, CONTEXT_EVIDENCE_MAX_CHARS).trim()
    : ''
  if (!text) return null
  const at = Number(evidence.at)
  const parserVersion = Number(evidence.parserVersion)
  return {
    text,
    kind: evidence.kind === 'provider-stated' ? 'provider-stated' : 'inferred',
    at: Number.isFinite(at) && at > 0 ? at : null,
    parserVersion: Number.isFinite(parserVersion) && parserVersion > 0 ? parserVersion : 0,
  }
}

/**
 * True when an *exact* context bound is backed by evidence the current rules still
 * read as a provider-stated context maximum. A number whose body no longer qualifies
 * (a throughput quota, an output-token cap) is not exact, whatever flag it carries.
 */
export function isContextEvidenceTrusted(evidence) {
  const ev = normalizeContextEvidence(evidence)
  if (!ev || ev.kind !== 'provider-stated') return false
  return parseContextLimitFromError(ev.text) != null
}

/**
 * True when a usage-stats entry carries an exact, evidence-backed context maximum —
 * the only kind of bound allowed to override catalog data or condemn a row.
 */
export function hasExactContextBound(stats) {
  const max = Number(stats?.contextMax)
  if (!Number.isFinite(max) || max <= 0) return false
  if (stats?.contextMaxExact !== true) return false
  return isContextEvidenceTrusted(stats?.contextEvidence)
}

/**
 * Re-reads a stored bound against the current rules, so a parser fix heals the
 * numbers its predecessors wrote instead of leaving them in place forever.
 *
 * - Evidence that the current rules no longer accept (a quota/OTPM body read as a
 *   context window) means the number itself is wrong: the bound is dropped.
 * - A bound with no evidence at all was written before evidence was recorded. Its
 *   provenance is unknown, so it is kept as an *inferred*, display-only bound: it can
 *   no longer override catalog data or bench a row, and the next genuine over-length
 *   rejection re-earns exactness.
 *
 * Returns the original stats object when nothing changed.
 */
export function revalidateContextBound(stats) {
  const prev = stats || {}
  const max = Number(prev.contextMax)
  if (!Number.isFinite(max) || max <= 0) return prev
  const evidence = normalizeContextEvidence(prev.contextEvidence)
  if (!evidence) {
    if (prev.contextMaxExact !== true) return prev
    return { ...prev, contextMaxExact: false }
  }
  const stated = evidence.kind === 'provider-stated' ? parseContextLimitFromError(evidence.text) : null
  const stillQualifies = evidence.kind === 'provider-stated'
    ? stated === max
    : isContextOverflowErrorText(evidence.text)
  if (stillQualifies) return prev
  const next = { ...prev }
  delete next.contextMax
  delete next.contextMaxExact
  delete next.contextEvidence
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
 * @param {object|null} stats     usage-stats entry (contextMin/contextMax/contextMaxExact/contextEvidence)
 * @returns {{display:string|null, tokens:number|null, source:'known'|'observed'|'none'}}
 */
export function computeContextDisplay(knownCtx, stats) {
  const { display, tokens, source } = deriveContextState(knownCtx, stats)
  return { display, tokens, source }
}

/**
 * One derivation for everything a row says about its context window: the column's
 * display string, the tokens the `min_ctx` filter ranks on, and the Micro flag.
 *
 * These used to be computed separately, which let a single row show
 * "131k" while also being struck out as Micro — the column read catalog data while
 * the flag read a soft bound. They now come from one precedence order:
 *
 * 1. An exact, evidence-backed provider-stated maximum wins over catalog data: it is
 *    what the provider actually enforces (catalog "131k" vs the provider's real "4096").
 *    It is also the only thing that may mark a row Micro.
 * 2. Otherwise the catalog/provider-reported value stands, and the row is not Micro.
 *    A soft bound never overrides a stated window and never benches a row.
 * 3. With no stated window, the observed bounds are shown as the range they are
 *    ("&gt;22, &lt;1649"), which is display-only information either way.
 *
 * @param {string|null} knownCtx  catalog/provider-reported context string ("128k", "1m")
 * @param {object|null} stats     usage-stats entry (contextMin/contextMax/contextMaxExact/contextEvidence)
 * @returns {{display:string|null, tokens:number|null, source:'known'|'observed'|'none', micro:boolean, exact:boolean}}
 */
export function deriveContextState(knownCtx, stats) {
  const knownTokens = parseContextSize(knownCtx)
  const min = stats?.contextMin || null
  const max = stats?.contextMax || null
  const exact = hasExactContextBound(stats)
  const exactMax = exact ? max : null
  const micro = exact && max <= MICRO_CONTEXT_MAX_TOKENS

  if (exactMax != null && knownTokens != null) {
    return { display: '≤' + formatTokenCount(exactMax), tokens: exactMax, source: 'observed', micro, exact }
  }

  if (knownTokens != null) {
    return { display: formatTokenCount(knownTokens), tokens: knownTokens, source: 'known', micro: false, exact }
  }

  if (min == null && max == null) return { display: null, tokens: null, source: 'none', micro: false, exact }
  const parts = []
  if (min != null) parts.push('>' + formatTokenCount(min))
  if (max != null) parts.push((exact ? '≤' : '<') + formatTokenCount(max))
  return { display: parts.join(', '), tokens: min ?? max, source: 'observed', micro, exact }
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
 * Only an exact, evidence-backed provider-stated maximum counts. A bound inferred
 * from the size of a prompt that happened to fail is not a statement about the
 * model, so it must never condemn a row to the dashboard's unavailable table.
 *
 * @param {object|null} stats  usage-stats entry (contextMax set by accumulateContextObservation)
 * @returns {boolean}
 */
export function isMicroContextBound(stats) {
  return deriveContextState(null, stats).micro
}

/**
 * Extracts a provider-stated context maximum from an error body, e.g.
 * "This model's maximum context length is 128000 tokens" (OpenAI),
 * "prompt is too long: 216102 tokens > 200000 maximum" (Anthropic), or
 * "max_model_len=max_total_tokens=8192" (vLLM/TGI).
 *
 * Only *context* statements qualify. A "`max_tokens` must be less than or equal
 * to `8192`" message is an OUTPUT cap — treating it as a context window made
 * large-context providers (Groq's 131k-token gpt-oss-120b, for example) render
 * as "≤8k / Micro" and get benched. Output caps are the business of
 * parseMaxTokensCapFromError() and the retry in the test/probe path.
 *
 * Bodies that name a context ceiling outright are read first, because their number
 * is unambiguous. The remaining patterns only *hint* at a size (a bare "N tokens > M"
 * comparison, or a throughput quota phrased as "Limit N, Requested M") and are
 * consulted only when the body is neither rate-limit nor output-token-cap shaped:
 * the number in those two is a quota about this request's tokens-per-minute or
 * max_tokens, so reading it as context benched Groq's 131k-token compound rows as
 * "≤8k / Micro" for nine days after the body that produced it was long gone.
 * Returns the raw token count, or null when no context limit is stated.
 */
const CONTEXT_STATEMENT_PATTERNS = [
  // vLLM/TGI-style validation: "max_tokens=16384 cannot be greater than
  // max_model_len=max_total_tokens=8192". The latter value is the provider's
  // enforced total context maximum, even though the error is phrased as an
  // output-token validation failure.
  { re: /max_?tokens\s*[=:]\s*[\d,.]+[^\n]{0,120}?max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i, group: 1 },
  { re: /max_?model_?len\s*=\s*max_?total_?tokens\s*=\s*([\d,.]+)/i, group: 1 },
  // "Please reduce the length of the messages or completion. Current length is
  // 23592 while limit is 8192" — the request's own length against the enforced
  // ceiling. Gated on "length ... while limit" so a usage-vs-quota sentence (which
  // also says "limit is") cannot pass as a context statement.
  { re: /current\s+length\s+is\s+[\d,.]+\s+while\s+limit\s+is\s+([\d,.]+)/i, group: 1 },
  { re: /(?:maximum|max(?:imum)?)\s+context\s+(?:length|window)\s+(?:is|of)\s+([\d,.]+)/i, group: 1 },
  { re: /context\s+(?:length|window)\s+(?:is|of|limited\s+to)\s+([\d,.]+)/i, group: 1 },
  { re: /max(?:imum)?\s*(?:context|ctx)\s*(?:length|window)?\s*[=:]\s*([\d,.]+)/i, group: 1 },
  { re: /prompt\s+is\s+too\s+long[\s\S]*?>\s*([\d,.]+)/i, group: 1 },
  { re: /context_length_exceeded[^\d]{0,60}([\d,.]+)/i, group: 1 },
]

// The hinted shapes. Group 2 of the comparison is the ceiling (the first number is
// the request's own size); group 1 of the quota phrasing is the stated limit.
const AMBIGUOUS_LIMIT_PATTERNS = [
  { re: /([\d,.]+)\s*tokens?\s*>\s*([\d,.]+)/i, group: 2 },
  { re: /limit\s+([\d,.]+),?[^\d]{0,60}requested\s+[\d,.]+/i, group: 1 },
]

export function parseContextLimitFromError(errorText) {
  const t = String(errorText || '')
  if (!t.trim()) return null
  const read = (patterns) => {
    for (const { re, group } of patterns) {
      const m = t.match(re)
      if (!m) continue
      const n = Number((m[group] || '').replace(/,/g, ''))
      if (Number.isFinite(n) && n > 0) return Math.round(n)
    }
    return null
  }
  const stated = read(CONTEXT_STATEMENT_PATTERNS)
  if (stated != null) return stated
  if (isRateLimitBodyText(t) || isOutputCapOnlyErrorText(t)) return null
  return read(AMBIGUOUS_LIMIT_PATTERNS)
}

/**
 * True when an error body describes a throughput quota (tokens/requests per
 * minute, hour or day) rather than the model's context window.
 */
function isRateLimitBodyText(text) {
  return /per\s+(?:minute|second|hour|day)|\b(?:tpm|rpm|rpd|tpd)\b|rate\s*limit|quota|too many requests/i.test(String(text || ''))
}

/**
 * True when an error body states an OUTPUT-token budget, e.g. Groq's
 * "`max_tokens` must be less than or equal to `8192`" or the vLLM variant that
 * spells out `max_model_len`. Such a number bounds the response, not what the
 * request may contain.
 *
 * The vLLM/TGI phrasing also names the real total-context cap, so this only marks
 * the body as output-cap *shaped*: a caller that wants a context bound must read
 * parseContextLimitFromError() first, which recognizes that shape as a context
 * statement and returns its value. This predicate exists for the opposite job —
 * keeping an output budget from being recorded as a context window.
 */
export function isOutputCapOnlyErrorText(errorText) {
  return parseMaxTokensCapFromError(errorText) != null
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
  // 'requires terms acceptance' (Groq's model_terms_required, e.g. the Orpheus
  // TTS entries) means the model cannot be called by this org until an admin
  // accepts the licence. That is a permanent, non-retryable unavailability, so
  // it belongs with the other 'Incompatible' states instead of a red 'Down' that
  // keeps getting re-probed as if it were a transient failure.
  return /content cannot be a plain string|model does not support text input|only supports (?:the )?interactions api|only supports (?:real[- ]time )?bidirectional streaming(?: via websocket)?|bidiGenerateContent(?: via websocket)?|gemini live api|chat.completions.*(?:is not supported|not available|unsupported)|route not supported|only available on agentic harnesses|calibration|requires terms acceptance|model_terms_required|terms (?:have|has) not been accepted|requires acceptance of the terms/i.test(t)
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
 * Cerebras' "is archived and unavailable", GitHub Copilot's "The requested
 * model is not supported."). The dashboard shows these as a persistent "Dead"
 * status instead of a generic "Down".
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
  // OpenCode Zen: a cataloged free model whose upstream has been withdrawn
  // (HTTP 400, "Error from provider (Console): Upstream request failed: Model
  // is unavailable."). Verified live 2026-09-16 for deepseek-v4-flash-free;
  // the id stays listed in /v1/models while the backend no longer serves it.
  if (/model is unavailable/i.test(t)) return true
  // Relay gateways (g4f.space): the catalog advertises a model that no backend
  // server actually serves — "No server found that supports model 'X'" with HTTP
  // 404. That is a permanent catalog failure, not a transient provider outage, so
  // it must land in the graveyard rather than as a generic 'down'.
  if (/no (?:server|provider|backend) (?:was )?found (?:that )?(?:supports?|for) (?:the )?model/i.test(t)) return true
  // Same family, per-server: the gateway routes to a backend that does not serve
  // this model and says so — "Model 'x' is not allowed on this server" (HTTP 400,
  // type model_not_allowed). No retry can make that backend serve it.
  if (/not allowed on this server|model_not_allowed/i.test(t)) return true
  // GitHub Copilot: the surface refuses to serve the model at all — "The
  // requested model is not supported." (HTTP 400, code model_not_supported).
  // No identity retry makes it serve the model, so this is a catalog death.
  // Kept model-framed so capability lines like "does not support image
  // inputs" stay out of the graveyard (dead is checked before incompatible).
  if (/requested model is not supported/i.test(t)) return true
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

/**
 * The output budget a request explicitly asks for, or null when it states none.
 *
 * Both spellings count because providers disagree: chat-completions clients send
 * `max_tokens`, newer OpenAI-compatible ones send `max_completion_tokens`, and a
 * provider's cap applies to whichever it received.
 */
export function requestedOutputBudget(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const value = Number(body[key])
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

/**
 * Lowers a request's stated output budget to a limit a provider has stated for the
 * model, leaving every other field (and any budget already within the limit) alone.
 *
 * This never *raises* a budget and never invents one: a body that states no output
 * budget is returned untouched, because a cap the provider enforces on its own
 * default cannot be the reason it refused the request. Whether the value may come
 * from a learned record is the caller's decision — see accumulateOutputCapObservation.
 *
 * @param {object} body  outbound chat-completions body
 * @param {number} cap  provider-stated maximum for this model
 * @returns {{ body: object, applied: boolean }}
 */
export function withOutputBudgetCap(body, cap) {
  const limit = Number(cap)
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return { body, applied: false }
  if (!Number.isFinite(limit) || limit <= 0) return { body, applied: false }
  let next = body
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const current = Number(body[key])
    if (!Number.isFinite(current) || current <= limit) continue
    if (next === body) next = { ...body }
    next[key] = Math.floor(limit)
  }
  return { body: next, applied: next !== body }
}

/**
 * Bumped when the rules that decide what may become a learned output cap change.
 * Stored with the cap's evidence so a later revision can tell which rules produced
 * a number instead of trusting one a previous parser wrote.
 */
export const OUTPUT_CAP_PARSER_VERSION = 1

/** How much of the error body is kept as an output cap's evidence (re-parseable). */
export const OUTPUT_CAP_EVIDENCE_MAX_CHARS = 500

/**
 * Merges a provider-stated output cap into a usage-stats entry.
 *
 * An output cap is a property of the model, not of one request: Groq answers
 * "`max_tokens` must be less than or equal to `16384`" for every request that asks
 * for more, so without remembering the number the router fails over on *every* turn
 * aimed at that model — the row looks healthy in the dashboard while never serving.
 * The lowest stated cap wins, because the safe direction is down (an answer may be
 * shorter than the client hoped; it may never be a request the provider refuses).
 *
 * The error body rides along as evidence, for the same reason context bounds keep
 * theirs: a number that can never be re-examined can never be corrected.
 *
 * Returns the original stats object unchanged when nothing changed.
 */
export function accumulateOutputCapObservation(stats, observation) {
  const prev = stats || {}
  const cap = Math.floor(Number(observation?.cap))
  if (!Number.isFinite(cap) || cap <= 0) return prev
  const prevCap = Math.floor(Number(prev.maxOutputTokens))
  if (Number.isFinite(prevCap) && prevCap > 0 && prevCap <= cap) return prev
  const evidenceText = typeof observation?.evidence === 'string' ? observation.evidence.trim() : ''
  const now = Date.now()
  return {
    ...prev,
    maxOutputTokens: cap,
    maxOutputTokensEvidence: {
      text: evidenceText.slice(0, OUTPUT_CAP_EVIDENCE_MAX_CHARS),
      parserVersion: OUTPUT_CAP_PARSER_VERSION,
      at: now,
    },
    maxOutputTokensUpdatedAt: now,
  }
}

/** Normalizes a stored output-cap evidence record, or null when nothing is re-readable. */
export function normalizeOutputCapEvidence(evidence) {
  if (evidence == null || typeof evidence !== 'object' || Array.isArray(evidence)) return null
  const text = typeof evidence.text === 'string'
    ? evidence.text.slice(0, OUTPUT_CAP_EVIDENCE_MAX_CHARS).trim()
    : ''
  if (!text) return null
  const at = Number(evidence.at)
  const parserVersion = Number(evidence.parserVersion)
  return {
    text,
    at: Number.isFinite(at) && at > 0 ? at : null,
    parserVersion: Number.isFinite(parserVersion) && parserVersion > 0 ? parserVersion : 0,
  }
}

/**
 * Re-reads a stored output cap against the current rules: the cap stands only while
 * its own evidence still parses to it. A record whose body no longer names that
 * limit (a misread body, or a provider that changed its ceiling) is dropped, so the
 * next rejection re-learns it rather than silently truncating every answer.
 *
 * Returns the original stats object when nothing changed.
 */
export function revalidateOutputCap(stats) {
  const prev = stats || {}
  const cap = Number(prev.maxOutputTokens)
  if (!Number.isFinite(cap) || cap <= 0) return prev
  const evidence = normalizeOutputCapEvidence(prev.maxOutputTokensEvidence)
  if (evidence && parseMaxTokensCapFromError(evidence.text) === cap) return prev
  const next = { ...prev }
  delete next.maxOutputTokens
  delete next.maxOutputTokensEvidence
  delete next.maxOutputTokensUpdatedAt
  return next
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

/**
 * True only when an error body is evidence about the model's *context window*
 * rather than about a quota or an output budget. This — not isOverLengthErrorText,
 * which is deliberately loose because it also drives failover decisions — is what
 * may create a learned context bound.
 *
 * Groq's "Request too large for model X in organization Y service tier Z on output
 * tokens per minute (OTPM): Limit 1000, Requested 1413" matches
 * isOverLengthErrorText (it says "request ... exceed") while being purely a
 * throughput statement: reading it as a ceiling recorded 1000 and 1649 tokens as the
 * context of a 131k-token Qwen model, and marked the row Micro for good.
 */
export function isContextOverflowErrorText(errorText) {
  const t = String(errorText || '')
  if (!t.trim()) return false
  if (isRateLimitBodyText(t)) return false
  if (parseContextLimitFromError(t) != null) return true
  if (isOutputCapOnlyErrorText(t)) return false
  return isOverLengthErrorText(t)
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
 * (benchmark/analysis endpoints), 'saudi', or 'audio' are not general chat
 * models, so hammer pins them 'incompatible' no matter what their probes
 * return. Shared by the row factory, the ping cycle, and the routing gate so
 * all three classify the row the same way.
 */
export function isBlockedModelName(modelId) {
  return /calibration|saudi|audio/i.test(String(modelId || ''))
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
 * Effective speed shared by the dashboard scatter and slope-line routing: the number
 * of tokens the model actually produced, divided by the wall-clock time it took to
 * produce them — waiting for the first token plus generating the rest.
 *
 *     S = N / (TTFT + N / tok-per-second) = N / total-seconds
 *
 * in tokens per second. `N` is the response length the row actually served (see
 * computeUsageAverages): the caller's own prompt can be any length, so a metric that
 * divides a fixed number by the time gets the *shape* of the trade-off wrong — it
 * understates how badly a slow prefill hurts a long answer, and makes a model that
 * only ever answers in three tokens look like a fast one. The old form used a
 * hardcoded 600-token answer, which is also why this number used to be an arbitrary
 * reciprocal rather than a rate.
 *
 * Returns null when the row has no measured response length, TTFT or rate, so callers
 * skip the row consistently instead of plotting a guess. TTFT and the rate fall back
 * to the last recorded test response, mirroring the /api/models formatter, so routing
 * and the plot always evaluate the same number.
 */
export function computeRowSpeed(r) {
  const ttft = r?.ttft != null ? Number(r.ttft) : (r?.lastResponse && r.lastResponse.ttftMs != null ? Number(r.lastResponse.ttftMs) : null)
  const tps = r?.tps != null ? Number(r.tps) : (r?.lastResponse && r.lastResponse.tps != null ? Number(r.lastResponse.tps) : null)
  const tokens = r?.speedTokens != null
    ? Number(r.speedTokens)
    : (r?.lastResponse && r.lastResponse.completionTokens != null ? Number(r.lastResponse.completionTokens) : null)
  if (!Number.isFinite(ttft) || ttft < 0) return null
  if (!Number.isFinite(tps) || tps <= 0) return null
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  return tokens / (ttft / 1000 + tokens / tps)
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

function groupContainsLatestModel(group) {
  return group.models.some(model => isLatestModelName(model?.modelId) || isLatestModelName(model?.label))
}

function groupLatestFamilyKey(group) {
  const source = group.models.find(model => model?.modelId) || group.models[0]
  return getLatestModelFamilyKey(source?.modelId || source?.label || '')
}

function compareVersionTuples(a, b) {
  const left = getModelVersionTuple(a)
  const right = getModelVersionTuple(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const av = left[i] ?? -1
    const bv = right[i] ?? -1
    if (av !== bv) return av - bv
  }
  return left.length - right.length
}

/**
 * Bundles provider aliases such as "Gemini Flash Latest" into the group for the
 * newest concrete iteration ("Gemini 3.8 Flash"). This is intentionally done
 * after normal canonical grouping: the latest alias remains routable as its own
 * model id, while the dashboard/API expose one model family heading.
 */
function mergeLatestModelGroups(groups) {
  const concreteByFamily = new Map()
  for (const group of groups) {
    if (groupContainsLatestModel(group)) continue
    const family = groupLatestFamilyKey(group)
    if (!family) continue
    const current = concreteByFamily.get(family)
    if (!current || compareVersionTuples(group.id, current.id) > 0) {
      concreteByFamily.set(family, group)
    }
  }

  const merged = []
  for (const group of groups) {
    if (!groupContainsLatestModel(group)) {
      merged.push(group)
      continue
    }
    const target = concreteByFamily.get(groupLatestFamilyKey(group))
    if (!target || target === group) {
      merged.push(group)
      continue
    }
    target.models.push(...group.models)
    target.aliases = [...new Set([...target.aliases, ...group.aliases])]
  }
  return merged
}

/**
 * Collapses provider spellings of one model into a single group: the same model
 * discovered as "qwen/qwen3.8-27b", "qwen-3.8-27b" or "srv_ab12:qwen3.8-27b",
 * or a size-qualified alias such as "nemotron-3-super" vs
 * "nvidia/nemotron-3-super-120b-a12b". Matching uses each group's model ids, its
 * learned real backend ids, its canonical id and its heading label, so mirrors
 * hosted by g4f/freemodels land under the manufacturer's row.
 */
function mergeModelIdentityGroups(groups, isRoutingAddressable) {
  const buckets = []
  const passthrough = []
  for (const group of groups) {
    // Two providers can serve *different* models under the same raw id (the
    // duplicate-id case). Those groups are keyed by routing key on purpose and
    // must stay separately addressable, so identity merging must not touch them.
    if (isRoutingAddressable && isRoutingAddressable(group)) {
      passthrough.push(group)
      continue
    }
    const ids = []
    for (const model of group.models) {
      if (model && model.modelId) ids.push(model.modelId)
      if (model && model.realModelId) ids.push(model.realModelId)
    }
    if (group.id) ids.push(group.id)
    if (group.label) ids.push(group.label)
    const target = ids.length > 0
      ? buckets.find(bucket => bucket.ids.some(a => ids.some(b => isSameModelIdentity(a, b))))
      : null
    if (!target) {
      buckets.push({ group, ids })
      continue
    }
    const targetSize = target.group.models.length
    target.group.models.push(...group.models)
    target.group.aliases = [...new Set([...target.group.aliases, ...group.aliases])]
    // The heading keeps the label of whichever group brings the most providers,
    // so a single persona row cannot rename a shared catalogue row.
    if (group.models.length > targetSize) target.group.label = group.label
    target.ids.push(...ids)
  }
  return [...buckets.map(bucket => bucket.group), ...passthrough]
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

  const normalizedGroups = Array.from(groups.values())
    .map(group => ({
      id: group.id,
      label: group.label,
      aliases: Array.from(group.aliases),
      models: group.models,
    }))

  return mergeModelIdentityGroups(
    mergeLatestModelGroups(normalizedGroups),
    group => group.models.some(model => hasDuplicateExactModelId(model, exactModelCounts)))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Parses a human-readable context-size string ("128k", "1m", "32000") into a raw token count.
 * Returns null for anything unparseable/empty. Used by the `best+min_ctx:<n>` request
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
 * `best+min_ctx:128k`. Unknown modifier keys are
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
 * True when a discoverable provider's /v1/models probe was refused for lack of a
 * credential — HTTP 401/403 with no API key sent. The catalog is gated behind auth
 * that isn't set up, so probing again can only produce the same refusal.
 *
 * Note what this deliberately does *not* test: the absence of a key. Some catalogs are
 * served keylessly (the g4f relays, and any self-hosted gateway pointed at with
 * G4F_BASE_URL), so the response decides, never the missing credential on its own.
 */
export function isDiscoverableProbeAuthRefusal({ apiKey, httpStatus }) {
  if (apiKey) return false
  return Number(httpStatus) === 401 || Number(httpStatus) === 403
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
  const verbose = args.some(a => ['--verbose', '-v'].includes(a.toLowerCase())) || process.env.HAMMER_DEBUG_STARTUP === '1'

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

  // `hammer context reset [--provider <key>] [--model <id>]`
  let contextAction = null
  let contextProvider = null
  let contextModel = null
  if (command === 'context') {
    const actionToken = args.find((a, idx) => idx > 0 && !a.startsWith('--'))
    contextAction = actionToken ? actionToken.toLowerCase() : 'reset'
  }
  const providerFlagIdx = args.findIndex(a => a.toLowerCase() === '--provider')
  if (providerFlagIdx !== -1 && args[providerFlagIdx + 1] && !args[providerFlagIdx + 1].startsWith('--')) {
    contextProvider = args[providerFlagIdx + 1].trim() || null
  }
  const modelFlagIdx = args.findIndex(a => a.toLowerCase() === '--model')
  if (modelFlagIdx !== -1 && args[modelFlagIdx + 1] && !args[modelFlagIdx + 1].startsWith('--')) {
    contextModel = args[modelFlagIdx + 1].trim() || null
  }

  return {
    command,
    autostartAction,
    autoUpdateAction,
    portValue,
    hostValue,
    enableLog,
    verbose,
    bannedModels,
    autoUpdateIntervalHours,
    configAction,
    configPayload,
    configProvider,
    configKeys,
    configMaxTurns,
    contextAction,
    contextProvider,
    contextModel,
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
