// @ts-check
/**
 * @file proxy.js
 * @description the /v1 OpenAI and Anthropic surfaces.
 *
 * Extracted from runServer. Mutable state arrives through the shared route
 * context (never as a destructured snapshot), because these handlers reassign
 * it and the composer must observe the change: lastProxyError, pinnedSelection, requestLogs, results, usageStats.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} ctx the composition-root seed (see http/context.js)
 */

import chalk from 'chalk'
import { transformCodexResponse } from '../../openai-codex.js'
import { shapedTimeoutMs } from '../../providers/adapters.js'
import {
  isProviderAuthOptional,
  resolveRequestModels,
  shouldRetryOptionalProviderWithBearer,
} from '../../providers/discovery.js'
import { NLPCLOUD_PROVIDER_KEY, transformNlpCloudResponse } from '../../providers/nlpcloud.js'
import { canonicalizeModelId } from '../../../sources.js'
import { loadConfig } from '../../config.js'
import { normalizeErrorEnvelope } from '../../error-envelope.js'
import {
  describeRejection,
  isHealableFieldRejection,
  parseRejectedFields,
  recordLearnedStrips,
} from '../../request-sanitize.js'
import { createResidueStreamFilter, scrubChatCompletionBody } from '../../tool-call-residue.js'
import {
  DEFAULT_QOS_LATENCY_TARGET_MS,
  buildModelGroups,
  estimateMessageTokens,
  filterModelsByRequested,
  findUpstreamSseError,
  getRoutingModelKey,
  hasUsableChatCompletionBody,
  isBlockedModelName,
  isPaymentRequiredError,
  isProviderBenched,
  isQuotaExhaustionError,
  isRequestTooLargeErrorText,
  isRetryableProxyStatus,
  parseMaxTokensCapFromError,
  preferHealthyProviders,
  providerBenchState,
  providerScopeKey,
  rankModelsForRouting,
  rankModelsForSmartest,
  reconcileRateLimitState,
  requestedOutputBudget,
  resolveCompletionTokens,
  resolveOutputBudgetCap,
  resolveStreamGenerationMs,
  selectModelBySlope,
  selectorSlopeOf,
  withOutputBudgetCap,
} from '../../utils.js'

/**
 * The request path reads runtime and legacy config keys the shared JSDoc does
 * not enumerate (logging policy, qosLatencyTargetMs, per-provider auth extras).
 * One widening read keeps that gap visible in a single place.
 */
const readConfig = () => /** @type {any} */ (loadConfig())

/**
 * Retry delay configuration matching OpenCode's retry discipline.
 * Uses exponential backoff: base * 2^attempt with jitter, capped at max.
 */
const RETRY_BASE_DELAY_MS = 2000
const RETRY_MAX_DELAY_MS = 8000

/**
 * Calculate retry delay with exponential backoff and jitter.
 * @param {number} attempt - The retry attempt number (0-indexed)
 * @returns {number} Delay in milliseconds
 */
function calculateRetryDelay(attempt) {
  if (attempt === 0) return 0
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS)
  // Add 25% jitter to avoid thundering herd
  const jitter = capped * (0.875 + Math.random() * 0.25)
  return Math.floor(jitter)
}

/**
 * Sleep for the specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function registerProxyRoutes(app, ctx) {
  const {
    AnthropicRelayStream,
    COPILOT_CLI_INTEGRATION_ID,
    DEVIN_CHAT_PATH,
    DEVIN_PROVIDER_KEY,
    GITHUB_COPILOT_PROVIDER_KEY,
    GOOGLEAI_PROVIDER_KEY,
    GPTFREE_PROVIDER_KEY,
    KIRO_PROVIDER_KEY,
    OPENAI_CODEX_PROVIDER_KEY,
    OUTPUT_FRAME_RE,
    UPSTREAM_HEADERS_TIMEOUT_MS,
    UPSTREAM_IDLE_TIMEOUT_MS,
    accountRefusalIn,
    anthropicToOpenAIBody,
    applyUsageDerivedMetrics,
    buildProviderRequestBody,
    buildProviderRequestHeaders,
    captureProxyRateLimit,
    captureResolvedModel,
    captureThoughtSignatures,
    contextUpperBoundFor,
    credentialResetHintMs,
    discoverLazyImportsForRequest,
    effectiveSelectorSettings,
    enableLog,
    extractErrorText,
    fetchDevinUserJwt,
    getNetworkErrorMessage,
    getNextApiKey,
    getNextApiKeyWithIndex,
    getPinnedAttemptLimit,
    getPinnedModelCandidate,
    getPinnedModelMatches,
    isCopilotIdentityDenied,
    isGoogleAiRequestCompatible,
    learnedFieldStrips,
    makeProviderSessionId,
    markCredentialRejected,
    markRateLimited,
    noteProviderReachable,
    noteProviderUnreachable,
    outputCapFor,
    providerHealth,
    recordContextObservation,
    recordRoutedModelFailure,
    recordUsage,
    rememberOutputCap,
    rememberUpstreamModelId,
    resolveProviderAuthToken,
    resolveProviderUrl,
    sanitizeOutboundPayload,
    scheduleLogSave,
    serializeProviderRequestBody,
    setFallbackSelection,
    syntheticUpstreamErrorResponse,
    transformDevinResponse,
    transformGptFreeResponse,
    transformKiroResponse,
    transformStreamingUpstreamErrorResponse,
    upstreamModelIdOfPayload,
  } = ctx
  app.get('/v1/models', (req, res) => {
    const groups = buildModelGroups(ctx.results, canonicalizeModelId)
    const data = [
      {
        id: 'best',
        name: 'Best',
        object: 'model',
        created: Date.now(),
        owned_by: 'router',
      },
      ...groups.map((group) => ({
        id: group.id,
        name: group.label,
        object: 'model',
        created: Date.now(),
        owned_by: 'Hammer',
      })),
    ]

    res.json({
      object: 'list',
      data,
    })
  })

  app.post('/v1/messages/count_tokens', (req, res) => {
    const body = req.body || {}
    let chars =
      typeof body.system === 'string'
        ? body.system.length
        : body.system
          ? JSON.stringify(body.system).length
          : 0
    for (const m of body.messages || []) {
      chars +=
        typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length
    }
    res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) })
  })

  app.post('/v1/messages', async (req, res) => {
    const body = req.body || {}
    const openaiBody = anthropicToOpenAIBody(body)
    // Honor the caller's model when it names a model the router actually carries;
    // Anthropic-protocol clients also send ids we don't have (e.g.
    // "claude-sonnet-4-5"), which fall back to normal best-model routing instead
    // of 404ing the way a bare pass-through would.
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (
      requestedModel &&
      requestedModel !== 'best' &&
      requestedModel !== 'smartest' &&
      filterModelsByRequested(ctx.results, requestedModel, canonicalizeModelId).length > 0
    ) {
      openaiBody.model = requestedModel
    }
    const wantsStream = Boolean(body.stream)
    const relay = new AnthropicRelayStream(body.model || 'unknown')
    if (wantsStream) {
      // Flush headers up front so the client's stream opens immediately;
      // failures surface as in-band error events instead of dead connections.
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()
    }
    let upstreamTimer = null
    let idleTimer = null
    const clearTimers = () => {
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
    try {
      // Bound the internal hop: a router that never answers must not hang the client
      // forever. The headers timer is cleared once headers arrive; an idle watchdog
      // then covers a body that stalls mid-stream.
      const upstreamController = new AbortController()
      upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_HEADERS_TIMEOUT_MS)
      const upstreamHeaders = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-anthropic-compat',
      }
      const upstream = await fetch(`${req.protocol}://${req.get('host')}/v1/chat/completions`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(openaiBody),
        signal: upstreamController.signal,
      })
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '')
        const message = errText || JSON.stringify({ error: { message: 'Router upstream failed' } })
        if (wantsStream) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`,
          )
          res.end()
        } else {
          res
            .status(upstream.status || 502)
            .type('json')
            .send(message)
        }
        return
      }
      // Anthropic-protocol clients get the same disclosure as /v1/chat/completions:
      // mirror the internal hop's headers when the response can still carry them, and
      // for a streaming caller (whose headers were flushed up front) report the served
      // model in message_start instead — otherwise a substituted model is invisible.
      const servedModel = upstream.headers.get('x-hammer-model')
      const servedProvider = upstream.headers.get('x-hammer-provider')
      const servedSubstituted = upstream.headers.get('x-hammer-substituted')
      if (!wantsStream) {
        if (servedModel) res.setHeader('X-Hammer-Model', servedModel)
        if (servedProvider) res.setHeader('X-Hammer-Provider', servedProvider)
        if (servedSubstituted) res.setHeader('X-Hammer-Substituted', servedSubstituted)
      } else if (servedModel) {
        relay.model = servedModel
      }

      const decoder = new TextDecoder()
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          try {
            upstreamController.abort()
          } catch {}
        }, UPSTREAM_IDLE_TIMEOUT_MS)
      }
      try {
        for await (const chunk of upstream.body) {
          armIdleWatchdog()
          const piece = decoder.decode(chunk, { stream: true })
          if (wantsStream) {
            res.write(relay.feed(piece))
          } else {
            relay.feed(piece)
          }
        }
      } finally {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
      if (wantsStream) {
        res.write(relay.finish())
        res.end()
      } else {
        relay.feed('\ndata: [DONE]\n\n')
        res.json(relay.toMessage())
      }
    } catch (err) {
      clearTimers()
      const message =
        err?.name === 'AbortError'
          ? 'Router upstream timed out.'
          : err?.message || 'Anthropic compat failure'
      if (wantsStream) {
        try {
          res.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`,
          )
          res.end()
        } catch {}
      } else if (!res.headersSent) {
        res.status(502).json({ error: { type: 'api_error', message } })
      } else {
        try {
          res.end()
        } catch {}
      }
    }
  })

  app.post('/v1/chat/completions', async (req, res) => {
    let logEntry = null
    // Request-logging policy: logRequestContent=false stores roles but not prompt/response
    // bodies; persistRequestLogs=false keeps logs in memory only (never touches disk).
    const logPolicyConfig = readConfig()
    const logContent = logPolicyConfig.logRequestContent !== false
    const persistLogs = logPolicyConfig.persistRequestLogs !== false
    try {
      const payload = req.body
      const attemptedModelKeys = new Set()
      // Providers this request has already spent an attempt on, so the retry loop can prefer a
      // different provider rather than re-picking the same dead fleet (see pickNextModel).
      const attemptedProviderKeys = new Set()
      const attempts = []
      const isSmartestRequest =
        payload.model === 'best' ||
        payload.model === 'smartest' ||
        String(payload.model || '').startsWith('best+') ||
        String(payload.model || '').startsWith('smartest+')

      // Selection is snapshotted per request. Take this before any await: discovery below can
      // be slow, and a dashboard pin/slope change made while it runs belongs to the next request,
      // not to this one after it resumes.
      const requestPinnedSelection = ctx.pinnedSelection ? { ...ctx.pinnedSelection } : null
      const requestPinnedFamily = requestPinnedSelection?.scope === 'family'
      const requestSelector = effectiveSelectorSettings(readConfig())
      // The retry loop rewrites payload.model to whichever model is being attempted,
      // so remember what the caller asked for before that happens.
      const requestedModelId = typeof payload.model === 'string' ? payload.model.trim() : ''
      // Whether the router (rather than the caller) chose the model for this turn: 'best'/
      // 'smartest' names no model, and neither does an empty name. Anything else names one,
      // and a model the caller named — like a model the user pinned — keeps its own error
      // visible rather than being swapped behind their back (see the size-refusal branch).
      // Such a request still gets the budget clamp above, which needs no substitution.
      const routerChosenModel = !requestedModelId || isSmartestRequest

      // 📖 A concrete model the table does not know yet may be served by an imported provider
      // whose rows have never been fetched (see resolveRequestModels): on-demand discovery
      // then makes the import routable before the 404 below, rather than only after a manual
      // refresh.
      const requestedModels = await resolveRequestModels({
        getResults: () => ctx.results,
        requestModel: payload.model,
        canonicalize: canonicalizeModelId,
        isSmartestRequest,
        discover: discoverLazyImportsForRequest,
      })
      // Discovery is allowed to replace `ctx.results`, so resolve the snapshotted pin
      // against the post-discovery catalog. Otherwise a newly discovered family
      // row could route but fail the attempt budget / pinned-identity checks that
      // were computed from the stale pre-await array.
      const requestPinnedMatches = getPinnedModelMatches(ctx.results, requestPinnedSelection)
      // Speed/intelligence for every candidate the router may actually pick, so
      // both the requested pool and a hard pin are scored from current evidence.
      for (const r of new Set([...requestedModels, ...requestPinnedMatches]))
        applyUsageDerivedMetrics(r)
      if (payload.model && !isSmartestRequest && requestedModels.length === 0) {
        return res
          .status(404)
          .json({ error: { message: `Requested model not found: ${payload.model}` } })
      }

      // Google AI thinking models 400 on tool-turn continuations whose Gemini
      // function calls lack a thought_signature we can supply; route around it.
      const incompatibleProviderKeys = new Set()
      if (!isGoogleAiRequestCompatible(payload)) {
        incompatibleProviderKeys.add(GOOGLEAI_PROVIDER_KEY)
      }

      // Ordinary named requests retain their own retry pool. A dashboard pin is
      // different: a family pin may move only to another provider in that family,
      // and an exact pin has no alternate at all.
      let retryableFailureSeen = false
      let candidatePoolWidened = false
      const pickPool = () => (candidatePoolWidened ? ctx.results : requestedModels)
      const isPinnedModel = (row) =>
        Boolean(
          requestPinnedSelection &&
          requestPinnedMatches.some(
            (match) => getRoutingModelKey(match) === getRoutingModelKey(row),
          ),
        )
      const pinnedAttemptLimit = getPinnedAttemptLimit(requestPinnedSelection, requestPinnedMatches)

      const pickNextModel = () => {
        const pickerConfig = readConfig()
        const qosOptions = {
          latencyTargetMs: pickerConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS,
        }
        const pool = pickPool()

        // A pin is a hard boundary. Family pins can only choose another row in
        // their own group; exact pins return their sole row or nothing.
        if (requestPinnedSelection) {
          let pinnedCandidate = getPinnedModelCandidate(
            ctx.results,
            requestPinnedSelection,
            Array.from(attemptedModelKeys),
            qosOptions,
          )
          // A family may skip a provider whose protocol cannot serve this request.
          // An exact pin deliberately does not: its provider's own error is exposed.
          while (
            pinnedCandidate &&
            requestPinnedFamily &&
            incompatibleProviderKeys.has(pinnedCandidate.providerKey)
          ) {
            attemptedModelKeys.add(getRoutingModelKey(pinnedCandidate))
            pinnedCandidate = getPinnedModelCandidate(
              ctx.results,
              requestPinnedSelection,
              Array.from(attemptedModelKeys),
              qosOptions,
            )
          }
          return pinnedCandidate
        }

        // Only unpinned automatic requests use the slope line or ranking here.
        const useSelector = routerChosenModel || candidatePoolWidened
        if (useSelector) {
          const sel = requestSelector
          const selSlope = selectorSlopeOf(sel)
          if (selSlope != null) {
            const pick = selectModelBySlope(
              preferHealthyProviders(pool, providerHealth),
              /** @type {any} */ ({
                slope: selSlope,
                minSpeed: sel.minSpeed,
                minIntell: sel.minIntell,
                excludeModelIds: Array.from(attemptedModelKeys),
              }),
            )
            if (pick) return pick.model
          }
        }
        const rankTop = () => {
          if (useSelector) {
            const sel = requestSelector
            const selSlope = selectorSlopeOf(sel)
            if (selSlope != null) {
              const pick = selectModelBySlope(
                preferHealthyProviders(pool, providerHealth),
                /** @type {any} */ ({
                  slope: selSlope,
                  minSpeed: sel.minSpeed,
                  minIntell: sel.minIntell,
                  excludeModelIds: Array.from(attemptedModelKeys),
                }),
              )
              if (pick) return pick.model
            }
            return rankModelsForSmartest(pool, Array.from(attemptedModelKeys))[0] || null
          }
          return rankModelsForRouting(pool, Array.from(attemptedModelKeys), qosOptions)[0] || null
        }
        let candidate = rankTop()
        while (candidate && incompatibleProviderKeys.has(candidate.providerKey)) {
          attemptedModelKeys.add(getRoutingModelKey(candidate))
          candidate = rankTop()
        }

        // Automatic requests prefer a provider that is neither benched nor already
        // spent on this request, but can still use the best remaining one.
        const steppedAside = []
        while (
          candidate &&
          (isProviderBenched(providerHealth, providerScopeKey(candidate)) ||
            attemptedProviderKeys.has(candidate.providerKey))
        ) {
          steppedAside.push(candidate)
          attemptedModelKeys.add(getRoutingModelKey(candidate))
          candidate = rankTop()
        }
        if (!candidate && steppedAside.length > 0) {
          candidate = steppedAside.reduce((best, row) => {
            const bestUntil =
              providerBenchState(providerHealth, providerScopeKey(best))?.benchedUntil || 0
            const rowUntil =
              providerBenchState(providerHealth, providerScopeKey(row))?.benchedUntil || 0
            return rowUntil < bestUntil ? row : best
          }, steppedAside[0])
        }

        // A named non-pinned request may widen after its own retryable rows are
        // exhausted. No pinned path reaches this branch.
        if (!candidate && !candidatePoolWidened && retryableFailureSeen && pool !== ctx.results) {
          candidatePoolWidened = true
          return pickNextModel()
        }
        return candidate
      }

      logEntry = {
        timestamp: new Date().toISOString(),
        model: '(pending)',
        provider: '(pending)',
        // When content capture is disabled, store only roles so the conversation shape is
        // still debuggable without persisting prompt bodies.
        messages: logContent
          ? payload.messages || []
          : (payload.messages || []).map((m) => ({ role: m?.role })),
        duration: null,
        ttft: null,
        status: 'pending',
        response: null,
        prompt_tokens: null,
        completion_tokens: null,
        tool_calls: null,
        function_call: null,
        attempts,
        retryCount: 0,
      }

      ctx.requestLogs.unshift(logEntry)
      if (ctx.requestLogs.length > 50) ctx.requestLogs.length = 50

      if (enableLog) {
        // Terminal payload logging is opt-in (--log) and never persisted, so it always
        // shows full content regardless of the disk-capture policy.
        console.log(chalk.dim('  ┌─────────────────── REQUEST PAYLOAD ───────────────────'))
        for (const msg of payload.messages || []) {
          const roleStr = (msg?.role || '?').toUpperCase().padEnd(9)
          const color =
            msg?.role === 'system' ? chalk.magenta : msg?.role === 'user' ? chalk.blue : chalk.green
          let content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg.content)

          if (content && content.length > 500) {
            content = content.substring(0, 500) + chalk.italic(' ...[truncated]')
          }
          console.log(
            color(`  │ [${roleStr}] ${String(content || '').replace(/\n/g, '\n  │           ')}`),
          )
        }
        console.log(chalk.dim('  └───────────────────────────────────────────────────────\n'))
      }

      let selectedModel = null
      let selectedResponse = null
      let selectedT0 = 0
      // Abort controller for the winning attempt, kept alive so the response-body phase
      // (non-streaming text() and streaming idle watchdog) can still cancel it.
      let selectedUpstreamController = null
      // Headers-phase duration of the winning attempt, recorded as its latency sample
      // once the body confirms the response is real.
      let selectedProbeMs = 0
      let selectedRequestMessages = payload.messages

      // A 2xx only becomes a healthy sample once the body proves it carries a real
      // completion. Providers that answer 200 with an empty body / empty choices
      // would otherwise be marked 'up' with a bogus latency sample that inflates QoS.
      const promoteSuccessfulModel = (model, probeMs) => {
        if (!model) return
        // A response the client is about to receive is the strongest evidence a provider is
        // healthy, so it lifts an outage bench immediately.
        noteProviderReachable(providerScopeKey(model))
        const now = Date.now()
        model.lastModelResponseAt = now
        // Persist liveness alongside the usage stats (saved by the recordUsage that
        // follows) so a restart doesn't forget this success.
        const livenessKey = `${model.providerKey}::${model.modelId}`
        ctx.usageStats.set(livenessKey, {
          ...(ctx.usageStats.get(livenessKey) || {}),
          lastServedAt: now,
        })
        model.pings.push({ ms: probeMs, code: '200', ts: now })
        if (model.pings.length > 50) model.pings.shift()
        // Same name-rule guard as the manual Test path above.
        if (!isBlockedModelName(model.modelId)) model.status = 'up'
        model.httpCode = null
        model.lastError = null
      }

      // The mirror image: a 200 with no completion text is evidence the model cannot
      // serve this request, so surface it as incompatible instead of counting an empty
      // answer as a healthy, fast response.
      const markModelIncompatible = (model, message) => {
        if (!model) return
        model.status = 'incompatible'
        model.httpCode = '200'
        model.lastError = {
          code: '200',
          message: message || 'Model returned no usable text.',
          updatedAt: Date.now(),
        }
      }

      // A gateway can refuse a request for an account reason inside an HTTP 200 whose body
      // otherwise reads as a completion — the key's budget, a spent credit balance (see
      // isAccountBudgetRefusalText). That is neither an answer to promote the row with nor a
      // verdict about the *model*, which is what markModelIncompatible would say: the model is
      // fine, the credential is out. So the row goes on the clock the same way a text-only rate
      // limit puts it there — and records no latency or speed sample, so a refusal's own words
      // never enter the averages the router routes on.
      const markModelBudgetRefused = (model, message) => {
        if (!model) return
        const now = Date.now()
        // An empty balance is the one account refusal a clock cannot fix, so it takes the Paid
        // verdict the manual Test and the probe give the same words (see isPaymentRequiredError)
        // instead of benching the row for a window that never opens. A spent key budget keeps the
        // clock it has always had — that one is raised, and it resets.
        if (isPaymentRequiredError(message, 0)) {
          model.status = 'paid'
          model.httpCode = '402'
          model.lastError = {
            code: '402',
            message: (message || 'Payment required to use this model.').slice(0, 500),
            updatedAt: now,
          }
          return
        }
        model.status = 'rate-limited'
        model.httpCode = '429'
        model.lastError = {
          code: '429',
          message: (
            message || 'Provider refused the request: this account is out of budget.'
          ).slice(0, 500),
          updatedAt: now,
        }
        model.rateLimit = reconcileRateLimitState(
          model.rateLimit,
          { wasRateLimited: true, capturedAt: now },
          429,
          now,
        )
      }

      // A rejected request is real evidence about a row, so it belongs in the ping
      // history and the dashboard's Last Error — but it is not an availability verdict.
      // This model is up; one request's shape was wrong. Status is deliberately left
      // alone, so the sanitized form of the next request can still route here. Non-200
      // pings never enter the latency average, so the sample cannot flatter the row.
      const recordProxyRejection = (model, status, message, ms) => {
        if (!model) return
        const now = Date.now()
        model.pings.push({ ms: Number.isFinite(ms) ? ms : 0, code: String(status), ts: now })
        if (model.pings.length > 50) model.pings.shift()
        model.httpCode = String(status)
        model.lastError = {
          code: String(status),
          message: (message || `Upstream rejected the request with HTTP ${status}.`).slice(0, 500),
          updatedAt: now,
        }
      }

      // Fields the outbound sanitizer removed for this request, disclosed to the
      // caller on the response so a rewritten payload is never invisible.
      const requestStrippedFields = new Set()

      // Set when the pre-flight body check already resolved the next candidate, so
      // the retry iteration doesn't re-rank (and re-mark) the same models.
      let pendingCandidate = null
      let lastPinnedFailure = null

      for (let retry = 0; retry <= pinnedAttemptLimit; retry++) {
        // Apply exponential backoff delay before retrying with a different provider.
        // This matches OpenCode's retry discipline: 3 retries with 2s/4s/8s delays.
        // Pi's internal retry handles same-provider retries; this handles cross-provider.
        if (retry > 0 && retryableFailureSeen) {
          const delayMs = calculateRetryDelay(retry - 1)
          if (delayMs > 0) {
            console.log(
              chalk.dim(
                `  [Router] ⏳ Waiting ${delayMs}ms before retry ${retry}/${pinnedAttemptLimit + 1}...`,
              ),
            )
            await sleep(delayMs)
          }
        }
        const best = pendingCandidate || pickNextModel()
        pendingCandidate = null
        if (!best) break

        // The router is abandoning the model it selected. Both halves of that belong outside this
        // request: the row keeps the evidence a failed Test would have left on it (so the table,
        // the plots and routing itself stop treating it as usable), and the model the retry will
        // use becomes the current selection — the value the dashboard's KPI, slope plot and
        // network plot are all drawn from, so the switch is visible the moment it happens.
        // Declared per attempt because the attempt budget is what decides whether a fallback is
        // still available at all (the last failed attempt has nothing to fall back to).
        const abandonModel = (model, { status, message }) => {
          recordRoutedModelFailure(model, { status, message })
          if (isPinnedModel(model)) {
            lastPinnedFailure =
              String(message || '')
                .trim()
                .slice(0, 500) ||
              `Pinned ${model.providerKey}/${model.modelId} failed with HTTP ${status || 'unknown'}.`
          }
          if (retry >= pinnedAttemptLimit) return null
          const next = pendingCandidate || pickNextModel()
          if (!next) return null
          pendingCandidate = next
          // Provider movement inside a family is part of the pin, not a change
          // of selection. Only unpinned fallback is recorded as an event.
          if (!isPinnedModel(model)) {
            setFallbackSelection(
              model,
              next,
              message || `Upstream request failed with HTTP ${status}.`,
            )
          }
          return next
        }

        attemptedModelKeys.add(getRoutingModelKey(best))
        attemptedProviderKeys.add(best.providerKey)
        payload.model = best.modelId

        const attemptRequestMessages = payload.messages
        const retainFailedPinnedResponse = (response, duration) => {
          selectedModel = best
          selectedResponse = response
          selectedT0 = t0
          selectedProbeMs = duration
          selectedRequestMessages = attemptRequestMessages
        }
        const attemptBasePayload = payload

        const currentConfig = readConfig()
        // Multi-account pool: the credential the pool says is serving, if any is configured
        const { key: rotKey, index: rotIndex } = getNextApiKeyWithIndex(
          currentConfig,
          best.providerKey,
        )
        let providerAuth = rotKey
          ? { token: rotKey, authSource: 'api-key', providerUrlOverride: null }
          : await resolveProviderAuthToken(currentConfig, best.providerKey)
        let providerUrl = resolveProviderUrl(
          currentConfig,
          best.providerKey,
          providerAuth.providerUrlOverride,
          best.providerUrl,
          best.modelId,
          rotIndex < 0 ? 0 : rotIndex,
        )

        const attemptMeta = {
          index: retry + 1,
          model: best.modelId,
          provider: best.providerKey,
          status: 'pending',
          duration: null,
          retryable: false,
        }

        if (!providerAuth.token && !isProviderAuthOptional(currentConfig, best.providerKey)) {
          attemptMeta.status = 'NO_KEY'
          attemptMeta.error = `No API key configured for provider ${best.providerKey}.`
          attempts.push(attemptMeta)
          if (isPinnedModel(best)) lastPinnedFailure = attemptMeta.error
          continue
        }

        if (!providerUrl) {
          attemptMeta.status = 'NO_URL'
          attemptMeta.error = `No provider URL configured for provider ${best.providerKey}.`
          attempts.push(attemptMeta)
          if (isPinnedModel(best)) lastPinnedFailure = attemptMeta.error
          continue
        }

        console.log(
          chalk.dim(
            `  [Router] ➡️ Proxying request (attempt ${retry + 1}/${pinnedAttemptLimit + 1}) to ${best.providerKey}/${best.modelId} (${best.status === 'up' && best.pings.length > 0 ? best.pings[best.pings.length - 1].ms + 'ms' : 'fallback'})`,
          ),
        )

        // Codex's workspace identity rides the headers and can only come from the
        // resolved account, so it is threaded through both the headers and the body.
        const codexOptions =
          best.providerKey === OPENAI_CODEX_PROVIDER_KEY
            ? {
                codexAccountId: providerAuth.account?.accountId || null,
                codexResidency: providerAuth.account?.residency || null,
              }
            : {}
        let headers = buildProviderRequestHeaders(best.providerKey, {
          apiKey: providerAuth.token,
          // Copilot reads X-Initiator from the conversation: a trailing user turn is
          // user-initiated, an agent/tool turn is not.
          messages: payload?.messages,
          ...codexOptions,
        })
        const kiroOptions =
          best.providerKey === KIRO_PROVIDER_KEY
            ? { profileArn: currentConfig?.providers?.kiro?.profileArn || null }
            : {}
        let devinOptions = {}
        if (best.providerKey === DEVIN_PROVIDER_KEY) {
          // The gateway expects a short-lived user JWT from the GetUserJwt prelude plus
          // the released Devin CLI metadata (mirrors the Devin CLI / @oh-my-pi client).
          const storedUserJwt = currentConfig?.providers?.[DEVIN_PROVIDER_KEY]?.userJwt || null
          try {
            const devinAuth = await fetchDevinUserJwt(providerAuth.token, {
              signal: AbortSignal.timeout(UPSTREAM_HEADERS_TIMEOUT_MS),
            })
            devinOptions = {
              apiKey: providerAuth.token,
              sessionId: makeProviderSessionId('ses'),
              userJwt: devinAuth.userJwt || storedUserJwt,
            }
            if (devinAuth.customApiServerUrl) {
              providerUrl = `${String(devinAuth.customApiServerUrl).replace(/\/+$/, '')}${DEVIN_CHAT_PATH}`
            }
          } catch (err) {
            // Surface readable Devin auth errors instead of retrying into raw binary frames.
            throw new Error(err?.message || 'Devin auth failed.', { cause: err })
          }
        }
        // An output budget belongs to the model, not to the caller: the clamp is applied
        // to a copy of the client body for this attempt only, so failing over to a model
        // with a larger ceiling still gets the budget that was actually asked for.
        //
        // The ceiling is the tightest fact the router holds for this row: the provider's own
        // stated cap (learned from an earlier refusal) and/or the model's context window less
        // what this prompt already occupies. A caller that states a budget no model can emit
        // would otherwise spend its first attempt on a refusal that was predictable before the
        // request was sent — and on a strict provider that first attempt is the whole turn.
        //
        // The window is read from above only: a row whose evidence is all soft observations has
        // a lower bound on its window, not a ceiling, and clamping answers to that would cap a
        // model at the size of its own prompt (see resolveContextUpperBound).
        const budgetCeiling = resolveOutputBudgetCap({
          learnedCap: outputCapFor(best),
          contextTokens: contextUpperBoundFor(best),
          promptTokens: estimateMessageTokens(attemptRequestMessages),
        })
        const budgetClamp =
          budgetCeiling != null ? withOutputBudgetCap(attemptBasePayload, budgetCeiling) : null
        const attemptPayload = budgetClamp ? budgetClamp.body : attemptBasePayload
        if (budgetClamp?.applied) attemptMeta.outputBudget = budgetCeiling
        let { body: providerPayload, stripped: strippedFields } = sanitizeOutboundPayload(
          buildProviderRequestBody(best.providerKey, attemptPayload, best.modelId, {
            ...kiroOptions,
            ...devinOptions,
            ...codexOptions,
          }),
          best.providerKey,
        )
        for (const field of strippedFields) requestStrippedFields.add(field)

        // The clock restarts after a healing round trip, so a latency sample always
        // belongs to the request that actually answered.
        let t0 = performance.now()
        let response
        // Bound the connect/headers phase: a provider that never responds (no headers,
        // no stream) aborts after UPSTREAM_HEADERS_TIMEOUT_MS instead of hanging forever.
        const upstreamController = new AbortController()
        selectedUpstreamController = upstreamController
        // A provider may declare a longer upstream budget than hammer's default (GLM's
        // coding plan is documented at fifty minutes). It is honoured, but capped: this
        // timer guards the connect-and-headers phase, and letting one wedged connection
        // hold a request slot for an hour would be worse than aborting it.
        const upstreamHeadersTimeoutMs = Math.min(
          shapedTimeoutMs(best.providerKey) || UPSTREAM_HEADERS_TIMEOUT_MS,
          10 * 60 * 1000,
        )
        const armUpstreamTimer = () =>
          setTimeout(() => upstreamController.abort(), upstreamHeadersTimeoutMs)
        let upstreamTimer = armUpstreamTimer()
        const clearUpstreamTimer = () => {
          clearTimeout(upstreamTimer)
          upstreamTimer = null
        }
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: serializeProviderRequestBody(providerPayload),
            signal: upstreamController.signal,
          })
          clearUpstreamTimer()

          // Copilot: a chat-surface identity denial (HTTP 403, or 400
          // model_not_supported on business hosts) means the org gates that surface,
          // not that the model is broken. Retry once as the CLI identity that the
          // Copilot CLI itself uses before treating the attempt as a failure.
          if (
            best.providerKey === GITHUB_COPILOT_PROVIDER_KEY &&
            (response.status === 403 || response.status === 400)
          ) {
            const denialBody = await response
              .clone()
              .text()
              .catch(() => '')
            if (isCopilotIdentityDenied(response.status, denialBody)) {
              console.log(
                chalk.yellow(
                  '  [Router] 🔁 GitHub Copilot chat identity denied; retrying as the Copilot CLI identity.',
                ),
              )
              upstreamTimer = armUpstreamTimer()
              response = await fetch(providerUrl, {
                method: 'POST',
                headers: buildProviderRequestHeaders(best.providerKey, {
                  apiKey: providerAuth.token,
                  copilotIntegrationId: COPILOT_CLI_INTEGRATION_ID,
                  messages: payload?.messages,
                }),
                body: serializeProviderRequestBody(providerPayload),
                signal: upstreamController.signal,
              })
              clearUpstreamTimer()
            }
          }

          if (
            shouldRetryOptionalProviderWithBearer(
              currentConfig,
              best.providerKey,
              providerAuth,
              String(response.status),
              null,
            )
          ) {
            const fallbackToken = getNextApiKey(currentConfig, best.providerKey)
            if (fallbackToken) {
              providerAuth = {
                token: fallbackToken,
                authSource: 'api-key',
                providerUrlOverride: providerAuth.providerUrlOverride,
              }
              headers = buildProviderRequestHeaders(best.providerKey, {
                apiKey: fallbackToken,
                ...codexOptions,
              })
              ;({ body: providerPayload, stripped: strippedFields } = sanitizeOutboundPayload(
                buildProviderRequestBody(best.providerKey, attemptPayload, best.modelId, {
                  ...kiroOptions,
                  ...devinOptions,
                  ...codexOptions,
                }),
                best.providerKey,
              ))
              for (const field of strippedFields) requestStrippedFields.add(field)
              upstreamTimer = armUpstreamTimer()
              response = await fetch(providerUrl, {
                method: 'POST',
                headers,
                body: serializeProviderRequestBody(providerPayload),
                signal: upstreamController.signal,
              })
              clearUpstreamTimer()
            }
          }
        } catch (err) {
          clearUpstreamTimer()
          attemptMeta.duration = Math.round(performance.now() - t0)
          attemptMeta.status = 'ERR'
          attemptMeta.error = err?.message || 'Unknown network error'
          attemptMeta.retryable = true
          attempts.push(attemptMeta)
          // Nothing reached the provider at all — the one failure mode that used to leave no trace
          // anywhere, which is how a fleet-wide timeout stayed invisible while the dashboard read
          // Up. Report it, and on the first bench of an outage ask the provider's rows directly so
          // a provider that is already answering again is noticed in seconds, not at the next
          // probe cycle.
          noteProviderUnreachable(
            providerScopeKey(best),
            err?.message || 'request could not reach the provider',
            `${best.providerKey}/${best.modelId}`,
            { reprobe: true },
          )
          if (isPinnedModel(best)) {
            lastPinnedFailure =
              getNetworkErrorMessage(err) || 'The pinned provider could not be reached.'
          }
          if (retry >= pinnedAttemptLimit) {
            throw err
          }
          const nextAfterFailure = abandonModel(best, {
            status: 0,
            message: getNetworkErrorMessage(err) || 'The request could not reach the provider.',
          })
          if (isPinnedModel(best) && !nextAfterFailure) throw err
          retryableFailureSeen = true
          continue
        }

        // A provider that refuses the *shape* of a replayed turn — a field the client
        // sent and the router dutifully forwarded — is a solvable problem, not a dead
        // end. Drop exactly the fields the provider named and ask the same model again:
        // the answer then still comes from the model the router picked, so a
        // mid-conversation turn never silently changes identity. The rejection is
        // remembered, so this costs one round trip per provider, not one per turn.
        //
        // The same round trip corrects an output budget the model cannot accept. Groq
        // answers "`max_tokens` must be less than or equal to `16384`" to every request
        // above that ceiling, which is a fact about the model rather than about this
        // prompt — without the correction the row looked healthy in the dashboard while
        // every turn aimed at it failed over to another model. Both corrections ride one
        // retry because a rejection may name either one, and re-asking per complaint
        // would spend two round trips on a model the loop might never come back to.
        let schemaRejection = null
        let schemaRejectionText = ''
        let cappedFrom = null
        if (!response.ok && response.status === 400) {
          schemaRejectionText = await response
            .clone()
            .text()
            .catch(() => '')
          const parsed = parseRejectedFields(schemaRejectionText)
          if (isHealableFieldRejection(parsed)) schemaRejection = parsed
          const statedCap = parseMaxTokensCapFromError(schemaRejectionText)
          const capped = statedCap != null ? withOutputBudgetCap(attemptPayload, statedCap) : null
          const clampApplies = Boolean(capped && capped.applied)
          // Recorded before the retry, so a model the router can already serve is not
          // left looking unrepairable if the retry itself fails.
          if (clampApplies) {
            cappedFrom = statedCap
            attemptMeta.outputBudget = statedCap
            rememberOutputCap(best, statedCap, schemaRejectionText)
          }
          if (schemaRejection || clampApplies) {
            if (schemaRejection)
              recordLearnedStrips(learnedFieldStrips, best.providerKey, schemaRejection)
            // Rebuilt from the client body rather than patched: the clamp lives on the
            // request, the field strip lives in the learned store, and both provider
            // translations (Kiro's protobuf, Codex's Responses shape) then agree with
            // the record of what was actually sent.
            const healed = sanitizeOutboundPayload(
              buildProviderRequestBody(
                best.providerKey,
                clampApplies ? capped.body : attemptPayload,
                best.modelId,
                { ...kiroOptions, ...devinOptions, ...codexOptions },
              ),
              best.providerKey,
            )
            if (healed.stripped.length > 0 || clampApplies) {
              for (const field of healed.stripped) requestStrippedFields.add(field)
              const what = [
                healed.stripped.length > 0 ? `rejected ${healed.stripped.join(', ')}` : '',
                clampApplies
                  ? `caps max_tokens at ${statedCap}${requestedOutputBudget(attemptPayload) != null ? ` (asked for ${requestedOutputBudget(attemptPayload)})` : ''}`
                  : '',
              ]
                .filter(Boolean)
                .join(' and ')
              console.log(
                chalk.yellow(
                  `  [Router] 🩹 ${best.providerKey}/${best.modelId} ${what}; retrying the same model with the corrected request.`,
                ),
              )
              upstreamTimer = armUpstreamTimer()
              try {
                response = await fetch(providerUrl, {
                  method: 'POST',
                  headers,
                  body: serializeProviderRequestBody(healed.body),
                  signal: upstreamController.signal,
                })
                clearUpstreamTimer()
                attemptMeta.healedFrom = clampApplies
                  ? [...healed.stripped, `max_tokens<=${statedCap}`]
                  : healed.stripped
                t0 = performance.now()
                // A correction the provider still refuses is reported from *its* words,
                // not from the complaint that prompted the retry.
                if (!response.ok && response.status === 400) {
                  const retryText = await response
                    .clone()
                    .text()
                    .catch(() => '')
                  if (retryText) schemaRejectionText = retryText
                }
              } catch {
                // The healed retry never reached the provider: keep the original
                // rejection so the failure is reported as what it actually was.
                clearUpstreamTimer()
              }
            }
          }
        }

        attemptMeta.duration = Math.round(performance.now() - t0)
        attemptMeta.status = String(response.status)
        attemptMeta.retryable = isRetryableProxyStatus(response.status)
        // A shape or budget rejection that healing could not resolve is evidence about
        // this payload, not about the model, so the loop fails over instead of handing
        // the caller a 400 that reads like a misconfiguration. A pinned model keeps its
        // error visible: a pin outranks substitution everywhere else too.
        if ((schemaRejection || cappedFrom != null) && !response.ok) {
          attemptMeta.error = schemaRejectionText.slice(0, 500)
          attemptMeta.rejection = schemaRejection
            ? describeRejection(schemaRejection)
            : `max_tokens > ${cappedFrom}`
          if (!requestPinnedSelection || requestPinnedFamily) attemptMeta.retryable = true
        }
        if (!attemptMeta.retryable && response.status >= 400) {
          try {
            const bodyText = await response.clone().text()
            // Whatever the loop decides below, a 4xx that states a reason is that reason: the
            // row, the request log and X-Hammer-Hint all quote the provider rather than a
            // generic "upstream failed".
            if (!attemptMeta.error && bodyText) attemptMeta.error = bodyText
            if (isQuotaExhaustionError(bodyText, response.status)) {
              if (routerChosenModel || requestPinnedFamily || candidatePoolWidened) {
                attemptMeta.retryable = true
                attemptMeta.error = bodyText
              }
            } else if (isRequestTooLargeErrorText(bodyText)) {
              // The payload cannot be made legal for this model — the prompt overflows its
              // window, or it states an output budget the model cannot emit — but a smaller
              // sibling can often still serve it. This reading is deliberately wider than
              // isOverLengthErrorText, which stays the *evidence* predicate; widening that
              // one is what once taught rows a false context window (see
              // recordContextObservation). A model the caller named keeps its own error.
              //
              // Fall through only when another candidate actually exists — otherwise keep
              // this model's explanatory 400 instead of replacing it with a generic 503.
              // A model the caller named is not this branch's to move, but its own words are
              // still what gets reported (above).
              if (routerChosenModel || requestPinnedFamily || candidatePoolWidened) {
                const alternative = retry < pinnedAttemptLimit ? pickNextModel() : null
                if (alternative) {
                  pendingCandidate = alternative
                  attemptMeta.retryable = true
                }
              }
            }
          } catch {
            // Keep the normal status-based retry decision when the body cannot be cloned.
          }
        }
        // A family pin is allowed to try every provider in the selected family.
        // Even a nonstandard 4xx belongs to that provider and must not stop the
        // family before its remaining rows have been tried.
        if (requestPinnedFamily && response.status >= 400) {
          attemptMeta.retryable = true
        }
        attempts.push(attemptMeta)

        // On 429: bench the credential this attempt used so the next retry picks a different
        // one. For a sign-in provider the thing to bench is the account secret the resolver
        // selected, not `token` — that is a short-lived access token freshly minted per
        // request, so it names no account and has nothing to fail over to.
        // The refusal is read once, here, and the credential is benched for as long as the
        // provider said — the window it states in the body when it states one (Gemini's
        // "Please retry in Ns", OpenRouter's reset header), else its `retry-after`, else the
        // local default. Benching happens after the capture because the body is the only place
        // some providers put the number, and capture is what reads it.
        const capture = await captureProxyRateLimit(best, response, providerAuth.token)
        if (response.status === 429) {
          const credential = providerAuth.account?.secret || providerAuth.token
          if (credential) {
            const stated = Number(capture?.resetAt)
            markRateLimited(
              best.providerKey,
              credential,
              Number.isFinite(stated) && stated > 0
                ? Math.max(0, stated - Date.now())
                : credentialResetHintMs(response),
            )
          }
        }

        // A credential the provider refused outright. `401` is not retryable within a request
        // (see `isRetryableProxyStatus`), so without a bench the pool would keep handing out
        // the rejected credential on every later request and never reach the one behind it.
        if (response.status === 401 && providerAuth.token) {
          markCredentialRejected(
            best.providerKey,
            providerAuth.account?.secret || providerAuth.token,
          )
        }

        if (response.ok) {
          if (best.providerKey === KIRO_PROVIDER_KEY) {
            response = await transformKiroResponse(response, best.modelId, Boolean(payload.stream))
          } else if (best.providerKey === DEVIN_PROVIDER_KEY) {
            // Decode Connect frames (gzip + protobuf) into an OpenAI-format response so
            // clients never receive the raw binary stream that appeared as mojibake.
            response = await transformDevinResponse(response, best.modelId, Boolean(payload.stream))
          } else if (best.providerKey === OPENAI_CODEX_PROVIDER_KEY) {
            // Codex answers only in Responses SSE, so every client gets the stream
            // translated into chat.completion chunks (or one body when it asked for
            // JSON) before the response is validated and piped below.
            response = await transformCodexResponse(response, best.modelId, Boolean(payload.stream))
          } else if (best.providerKey === GPTFREE_PROVIDER_KEY) {
            // gptfree's own named-event SSE is translated here — answer frames forwarded,
            // agent step frames dropped, an error frame turned into the synthetic 503 the
            // retry loop can fail over on (see transformGptFreeResponse).
            response = await transformGptFreeResponse(
              response,
              best.modelId,
              Boolean(payload.stream),
            )
          } else if (best.providerKey === NLPCLOUD_PROVIDER_KEY && response.ok) {
            response = await transformNlpCloudResponse(
              response,
              best.modelId,
              Boolean(payload.stream),
            )
          } else if (payload.stream && response.ok) {
            response = await transformStreamingUpstreamErrorResponse(response)
          }
          if (response.ok && !payload.stream) {
            const bodyPreview = await response
              .clone()
              .text()
              .catch(() => '')
            const upstreamError = findUpstreamSseError(bodyPreview)
            // The same account refusal on a JSON body instead of a stream (see the peek in
            // transformStreamingUpstreamErrorResponse): a 200 whose message *is* the gateway's
            // notice. It is a valid completion to every structural check, so it is named here —
            // before the caller can see it — rather than only in the log flush afterwards, and it
            // carries the 429 it means so the loop benches a credential that is out of budget
            // instead of reading it as a broken upstream.
            const refusal = upstreamError ? '' : accountRefusalIn(bodyPreview)
            if (upstreamError || refusal) {
              attemptMeta.status = upstreamError ? 'UPSTREAM_ERROR' : '429'
              attemptMeta.retryable = true
              attemptMeta.error = upstreamError
                ? /** @type {any} */ (upstreamError).message || 'Upstream reported an error.'
                : refusal
              response = syntheticUpstreamErrorResponse(
                upstreamError || { message: refusal, code: 429 },
                upstreamError ? 503 : 429,
              )
              ctx.lastProxyError = {
                at: Date.now(),
                message: attemptMeta.error,
                model: best.modelId,
                provider: best.providerKey,
                fallback: !isPinnedModel(best) && retry < pinnedAttemptLimit,
              }
              if (retry < pinnedAttemptLimit && (!requestPinnedSelection || requestPinnedFamily)) {
                abandonModel(best, { status: response.status, message: attemptMeta.error })
                retryableFailureSeen = true
                continue
              }
            }
          }
          if (response.status >= 400) {
            attemptMeta.status = String(response.status)
            // A family pin visits every provider even when a provider returns a
            // nonstandard 4xx. Exact pins expose that response immediately.
            attemptMeta.retryable = requestPinnedSelection
              ? requestPinnedFamily && retry < pinnedAttemptLimit
              : isRetryableProxyStatus(response.status)
            if (attemptMeta.retryable && retry < pinnedAttemptLimit) {
              // Preserve the original body: if this was the final family row,
              // the last provider's own status/body is the response, not a generic
              // later "no models" envelope.
              attemptMeta.error = await response
                .clone()
                .text()
                .catch(() => '')
              console.log(
                chalk.yellow(
                  `  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`,
                ),
              )
              const next = abandonModel(best, {
                status: response.status,
                message: attemptMeta.error,
              })
              if (isPinnedModel(best) && !next) {
                retainFailedPinnedResponse(response, attemptMeta.duration)
                break
              }
              retryableFailureSeen = true
              continue
            }
          }
          // Health is promoted only once the response body is validated below —
          // a 200 with an empty payload must not be recorded as an up/latency sample.
          selectedModel = best
          selectedResponse = response
          selectedT0 = t0
          selectedProbeMs = attemptMeta.duration
          selectedRequestMessages = attemptRequestMessages
          break
        }

        if (
          attemptMeta.retryable &&
          retry < pinnedAttemptLimit &&
          !(requestPinnedSelection && !requestPinnedFamily)
        ) {
          let retryBody = ''
          try {
            retryBody = await response.clone().text()
            attemptMeta.error = retryBody
          } catch {
            attemptMeta.error = '<Could not read retry response body>'
          }
          recordContextObservation(best, retryBody, attemptRequestMessages)
          console.log(
            chalk.yellow(
              `  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`,
            ),
          )
          const next = abandonModel(best, { status: response.status, message: attemptMeta.error })
          if (isPinnedModel(best) && !next) {
            retainFailedPinnedResponse(response, attemptMeta.duration)
            break
          }
          retryableFailureSeen = true
          ctx.lastProxyError = {
            at: Date.now(),
            message: attemptMeta.error || `Upstream request failed with HTTP ${response.status}.`,
            model: best.modelId,
            provider: best.providerKey,
            fallback: !isPinnedModel(best),
          }
          continue
        }

        // About to hand this response to the caller: record it against the row so the
        // dashboard, QoS and the request log agree with what the client actually saw.
        // Previously a relayed 4xx left the row with a clean record, which is how one
        // strict provider kept being chosen and kept refusing the same payload.
        if (!response.ok) {
          recordProxyRejection(best, response.status, attemptMeta.error, attemptMeta.duration)
          ctx.lastProxyError = {
            at: Date.now(),
            message: attemptMeta.error || `Upstream request failed with HTTP ${response.status}.`,
            model: best.modelId,
            provider: best.providerKey,
            fallback: false,
          }
        }

        selectedModel = best
        selectedResponse = response
        selectedT0 = t0
        selectedRequestMessages = attemptRequestMessages
        break
      }

      if (!selectedResponse || !selectedModel) {
        const noModelMessage =
          requestPinnedSelection && lastPinnedFailure
            ? lastPinnedFailure
            : 'No models currently available for this request.'
        logEntry.status = requestPinnedSelection ? '502' : '503'
        logEntry.error = { message: noModelMessage, attempts }
        logEntry.retryCount = Math.max(0, attempts.length - 1)
        if (persistLogs) scheduleLogSave()
        ctx.lastProxyError = {
          at: Date.now(),
          message: noModelMessage,
          fallback: false,
        }
        return res
          .status(requestPinnedSelection ? 502 : 503)
          .json({ error: { message: noModelMessage }, attempts })
      }

      // The attempt that answered is the last one the loop recorded (see attempts.push).
      // `outputBudget` is set on an attempt whose payload had its max_tokens lowered, either
      // before sending (the row's known ceiling) or by the heal below (the provider's own).
      const servedAttempt = attempts[attempts.length - 1] || null
      const servedOutputBudget = Number(servedAttempt?.outputBudget)
      logEntry.model = selectedModel.modelId
      logEntry.provider = selectedModel.providerKey
      logEntry.duration = Math.round(performance.now() - selectedT0)
      logEntry.status = String(selectedResponse.status)
      logEntry.retryCount = Math.max(0, attempts.length - 1)
      if (requestStrippedFields.size > 0) logEntry.sanitized = [...requestStrippedFields]
      if (Number.isFinite(servedOutputBudget)) logEntry.maxTokens = servedOutputBudget
      if (attempts.length > 1) {
        ctx.lastProxyError = requestPinnedSelection
          ? {
              at: Date.now(),
              message: `Pinned ${requestPinnedSelection.scope} selected ${selectedModel.providerKey}/${selectedModel.modelId} after another scoped row failed.`,
              model: selectedModel.modelId,
              provider: selectedModel.providerKey,
              fallback: false,
            }
          : {
              at: Date.now(),
              message: `Fallback selected ${selectedModel.providerKey}/${selectedModel.modelId} after an upstream failure.`,
              model: selectedModel.modelId,
              provider: selectedModel.providerKey,
              fallback: true,
            }
      } else if (selectedResponse.ok) {
        ctx.lastProxyError = null
      }

      res.status(selectedResponse.status)

      for (const [key, value] of selectedResponse.headers.entries()) {
        if (
          ['content-type', 'transfer-encoding', 'cache-control', 'connection'].includes(
            key.toLowerCase(),
          )
        ) {
          res.setHeader(key, value)
        }
      }

      // Which model actually answered. A retryable upstream failure can land the
      // request on a different model than the caller named, so a client must be able
      // to detect the substitution instead of trusting the request it sent. A
      // best/smartest request names no model, so it is never "substituted".
      const requestedCanonical =
        !isSmartestRequest && requestedModelId ? canonicalizeModelId(requestedModelId) : null
      const servedCanonical = canonicalizeModelId(String(selectedModel.modelId))
      const sameModel =
        requestedCanonical &&
        (requestedCanonical.base === servedCanonical.base ||
          requestedCanonical.unprefixed === servedCanonical.unprefixed)
      res.setHeader('X-Hammer-Model', selectedModel.modelId)
      res.setHeader('X-Hammer-Provider', selectedModel.providerKey)
      // best/smartest names no model, so it can never be "substituted".
      res.setHeader('X-Hammer-Substituted', requestedCanonical && !sameModel ? '1' : '0')
      // Disclose a rewritten payload the same way a substituted model is disclosed: a
      // client that sent a field the router removed has to be able to see that.
      if (requestStrippedFields.size > 0) {
        res.setHeader('X-Hammer-Sanitized', [...requestStrippedFields].join(','))
      }
      // And an output budget the router had to lower for the model that actually served: the
      // caller stated a number and got a smaller one, which is the same kind of rewrite
      // X-Hammer-Sanitized discloses above.
      const requestedBudget = requestedOutputBudget(payload)
      if (
        Number.isFinite(servedOutputBudget) &&
        servedOutputBudget > 0 &&
        (requestedBudget == null || servedOutputBudget < requestedBudget)
      ) {
        res.setHeader('X-Hammer-Max-Tokens', String(servedOutputBudget))
      }
      // And when an upstream 4xx is being relayed, name the reason in a header, so a
      // client banner does not read a provider-schema refusal as a configuration fault.
      if (!selectedResponse.ok && ctx.lastProxyError?.message) {
        res.setHeader(
          'X-Hammer-Hint',
          String(ctx.lastProxyError.message)
            .replace(/[^\x20-\x7E]+/g, ' ')
            .trim()
            .slice(0, 300),
        )
      }

      if (selectedResponse.body) {
        const { Readable, Transform } = await import('stream')

        let responseBodyText = ''
        let ttftCaptured = false
        // The window the *answer* frames spanned, which is the generation time when the
        // provider streams as it generates and nothing but delivery time when it banks
        // the whole answer (see resolveStreamGenerationMs). A frame counts as output
        // when it carries content, reasoning or tool-call payload — the role-only
        // opening frame of a stream is not an answer (see OUTPUT_FRAME_RE).
        let firstOutputAt = 0
        let lastOutputAt = 0
        let streamEnded = false
        const MAX_LOG_BODY_SIZE = 10 * 1024 * 1024 // 10MB limit for logging

        // Idle watchdog: if the provider stops sending data mid-stream, abort the
        // upstream fetch and end the client response instead of hanging forever.
        let idleTimer = null
        const armIdleWatchdog = () => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            try {
              selectedUpstreamController?.abort()
            } catch {}
            finalizeStream('Upstream stream stalled (idle timeout).')
          }, UPSTREAM_IDLE_TIMEOUT_MS)
        }
        const clearIdleWatchdog = () => {
          clearTimeout(idleTimer)
          idleTimer = null
        }

        // Ends the client response and finalizes the log entry after an upstream stream
        // error or idle timeout. For SSE clients, emit a well-formed error event so the
        // caller sees a failure instead of a silent truncation.
        const finalizeStream = (message) => {
          if (streamEnded) return
          streamEnded = true
          clearIdleWatchdog()
          logEntry.status = 'err'
          logEntry.error = message
          if (persistLogs) scheduleLogSave()
          try {
            if (payload.stream && !res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({ error: { message }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`,
              )
              res.end()
            } else if (!res.writableEnded) {
              res.destroy(new Error(message))
            }
          } catch {
            /* client already gone */
          }
        }

        const captureStream = new Transform({
          transform(chunk, encoding, callback) {
            armIdleWatchdog()
            if (!ttftCaptured) {
              ttftCaptured = true
              logEntry.ttft = Math.round(performance.now() - selectedT0)
            }
            if (OUTPUT_FRAME_RE.test(chunk.toString())) {
              const at = performance.now()
              if (!firstOutputAt) firstOutputAt = at
              lastOutputAt = at
            }
            // Only accumulate up to limit to prevent OOM
            if (responseBodyText.length < MAX_LOG_BODY_SIZE) {
              responseBodyText += chunk.toString()
            }
            callback(null, chunk)
          },
          flush(callback) {
            clearIdleWatchdog()
            streamEnded = true
            try {
              const wasTruncated = responseBodyText.length >= MAX_LOG_BODY_SIZE

              if (selectedResponse.status >= 400) {
                try {
                  const errorData = JSON.parse(responseBodyText)
                  logEntry.error = errorData
                } catch {
                  logEntry.error = responseBodyText + (wasTruncated ? '... (truncated)' : '')
                }
                recordContextObservation(
                  selectedModel,
                  extractErrorText(logEntry.error),
                  selectedRequestMessages,
                )
              } else if (accountRefusalIn(responseBodyText)) {
                // A gateway can refuse a request for an account reason inside a 200 whose body
                // otherwise reads as a completion — the key's own budget, a spent credit balance
                // (see markModelBudgetRefused). Named before the shape checks below, because such
                // a body is a valid completion to every one of them. One rule for both client
                // shapes: this branch is reached whether the client asked for a stream or not.
                markModelBudgetRefused(selectedModel, accountRefusalIn(responseBodyText))
              } else if (payload.stream) {
                const lines = responseBodyText.split('\n')
                let fullContent = ''
                // Everything the model emitted, for the generation-speed estimate below:
                // streamed reasoning and tool-call arguments are output tokens too, and                 // relays that report no usage may stream reasoning the most.

                let outputText = ''
                const toolCalls = []
                let functionCall = null
                for (const line of lines) {
                  const trimmed = line.trim()
                  if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(trimmed.slice(6))
                      captureResolvedModel(logEntry, data)
                      const frameModel = upstreamModelIdOfPayload(data)
                      if (frameModel) rememberUpstreamModelId(selectedModel, frameModel)
                      if (data.choices && data.choices[0] && data.choices[0].delta) {
                        const delta = data.choices[0].delta
                        if (delta.content) {
                          fullContent += delta.content
                          outputText += delta.content
                        }
                        if (typeof delta.reasoning_content === 'string')
                          outputText += delta.reasoning_content
                        if (delta.tool_calls) {
                          for (const tc of delta.tool_calls) {
                            // Gemini's OpenAI-compat streaming omits the `index` field that OpenAI
                            // includes on each tool_call chunk, so resolve the target slot: explicit
                            // index, else match by id, else append.
                            let idx = tc.index
                            if (idx == null) {
                              idx =
                                tc.id != null ? toolCalls.findIndex((t) => t && t.id === tc.id) : -1
                              if (idx === -1) idx = toolCalls.length
                            }
                            if (!toolCalls[idx])
                              toolCalls[idx] = {
                                id: tc.id || '',
                                type: tc.type || 'function',
                                function: { name: '', arguments: '' },
                              }
                            if (tc.id) toolCalls[idx].id = tc.id
                            if (tc.type) toolCalls[idx].type = tc.type
                            if (tc.function) {
                              if (tc.function.name) toolCalls[idx].function.name += tc.function.name
                              if (tc.function.arguments) {
                                toolCalls[idx].function.arguments += tc.function.arguments
                                outputText += tc.function.arguments
                              }
                            }
                            // Gemini thinking models attach thought_signature to function call parts
                            // (nested under extra_content.google in the OpenAI-compat response)
                            if (tc.extra_content) toolCalls[idx].extra_content = tc.extra_content
                            if (tc.thought_signature)
                              toolCalls[idx].thought_signature = tc.thought_signature
                          }
                        }
                        if (delta.function_call) {
                          if (!functionCall) functionCall = { name: '', arguments: '' }
                          if (delta.function_call.name)
                            functionCall.name += delta.function_call.name
                          if (delta.function_call.arguments) {
                            functionCall.arguments += delta.function_call.arguments
                            outputText += delta.function_call.arguments
                          }
                        }
                      }
                      if (data.usage) {
                        if (data.usage.prompt_tokens != null)
                          logEntry.prompt_tokens = data.usage.prompt_tokens
                        if (data.usage.completion_tokens != null)
                          logEntry.completion_tokens = data.usage.completion_tokens
                      }
                    } catch (e) {}
                  }
                }
                if (logContent && fullContent) logEntry.response = fullContent
                if (toolCalls.length > 0) {
                  if (logContent) {
                    logEntry.tool_calls = toolCalls.filter(Boolean).map((tc) => {
                      if (tc.function && tc.function.arguments) {
                        try {
                          tc.function.arguments = JSON.parse(tc.function.arguments)
                        } catch (e) {}
                      }
                      return tc
                    })
                  }
                  // Cache thought_signatures from Google AI thinking-model responses
                  // (functional requirement, independent of the content-capture policy)
                  captureThoughtSignatures(toolCalls, selectedModel?.providerKey)
                }
                if (logContent && functionCall) {
                  if (functionCall.arguments) {
                    try {
                      functionCall.arguments = JSON.parse(functionCall.arguments)
                    } catch (e) {}
                  }
                  logEntry.function_call = functionCall
                }
                // An empty or never-populated stream is not a healthy response even
                // though the transport said 200 — mark it incompatible instead of
                // promoting the model and recording a bogus sample.
                if (hasUsableChatCompletionBody(responseBodyText)) {
                  promoteSuccessfulModel(selectedModel, selectedProbeMs)
                  // Record real usage stats for this model/provider (streaming). The
                  // generation time comes from the answer's own frame window, not from
                  // "everything after the first byte": for a provider that releases the
                  // answer in one burst that remainder is delivery time, and dividing
                  // tokens by it is how a row came to claim ~6000 tok/s.
                  recordUsage(selectedModel, {
                    ttft: logEntry.ttft,
                    completionTokens: resolveCompletionTokens(
                      logEntry.completion_tokens,
                      outputText,
                    ),
                    genMs: resolveStreamGenerationMs(
                      Math.round(performance.now() - selectedT0),
                      firstOutputAt ? lastOutputAt - firstOutputAt : 0,
                    ),
                    contextTokens:
                      logEntry.prompt_tokens != null && logEntry.completion_tokens != null
                        ? logEntry.prompt_tokens + logEntry.completion_tokens
                        : null,
                  })
                } else {
                  markModelIncompatible(selectedModel)
                }
              } else if (!hasUsableChatCompletionBody(responseBodyText)) {
                // 2xx whose body carries no completion (empty choices, blank message,
                // or a non-JSON error page): never count it as a healthy sample.
                markModelIncompatible(selectedModel)
              } else {
                const data = JSON.parse(responseBodyText)
                captureResolvedModel(logEntry, data)
                const bodyModel = upstreamModelIdOfPayload(data)
                if (bodyModel) rememberUpstreamModelId(selectedModel, bodyModel)
                // Everything the model returned, for the token estimate when the
                // provider's usage block is missing (see resolveCompletionTokens).
                let outputText = ''
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  const msg = data.choices[0].message
                  if (typeof msg.content === 'string') outputText += msg.content
                  if (typeof msg.reasoning_content === 'string') outputText += msg.reasoning_content
                  else if (typeof msg.reasoning === 'string') outputText += msg.reasoning
                  if (Array.isArray(msg.tool_calls)) {
                    for (const tc of msg.tool_calls) {
                      if (typeof tc?.function?.arguments === 'string')
                        outputText += tc.function.arguments
                    }
                  }
                  if (typeof msg.function_call?.arguments === 'string')
                    outputText += msg.function_call.arguments
                  if (logContent && msg.content) logEntry.response = msg.content
                  if (msg.tool_calls) {
                    if (logContent) {
                      logEntry.tool_calls = msg.tool_calls.map((tc) => {
                        if (tc.function && typeof tc.function.arguments === 'string') {
                          try {
                            tc.function.arguments = JSON.parse(tc.function.arguments)
                          } catch (e) {}
                        }
                        return tc
                      })
                    }
                    captureThoughtSignatures(msg.tool_calls, selectedModel?.providerKey)
                  }
                  if (logContent && msg.function_call) {
                    logEntry.function_call = { ...msg.function_call }
                    if (typeof logEntry.function_call.arguments === 'string') {
                      try {
                        logEntry.function_call.arguments = JSON.parse(
                          logEntry.function_call.arguments,
                        )
                      } catch (e) {}
                    }
                  }
                }
                if (data.usage) {
                  if (data.usage.prompt_tokens != null)
                    logEntry.prompt_tokens = data.usage.prompt_tokens
                  if (data.usage.completion_tokens != null)
                    logEntry.completion_tokens = data.usage.completion_tokens
                }
                // Body validated above: record the assistant turn before promoting and
                // recording the sample. Non-streaming responses use this branch, not the
                // bodyless fallback below.
                promoteSuccessfulModel(selectedModel, selectedProbeMs)
                // Record real usage stats for this model/provider (non-streaming)
                recordUsage(selectedModel, {
                  ttft: logEntry.duration,
                  completionTokens: resolveCompletionTokens(logEntry.completion_tokens, outputText),
                  genMs: Math.max(1, Math.round(performance.now() - selectedT0)),
                  contextTokens:
                    logEntry.prompt_tokens != null && logEntry.completion_tokens != null
                      ? logEntry.prompt_tokens + logEntry.completion_tokens
                      : null,
                })
              }
            } catch (e) {
              if (logContent) logEntry.response = '<Could not parse response payload>'
            }
            if (persistLogs) scheduleLogSave()
            callback()
          },
        })

        const nodeBody = Readable.fromWeb(selectedResponse.body)
        nodeBody.on('error', (err) => {
          if (err?.name === 'AbortError') {
            finalizeStream('Upstream request timed out.')
          }
          // Otherwise the upstream failed: the captureStream error handler below
          // covers the 'stream not found' case, and the client sees the upstream
          // error body as SSE frames when the provider emits them. Do not double-
          // finalize and close the client before any relayed frames arrive.
        })
        captureStream.on('error', (err) => finalizeStream(err?.message || 'Upstream stream error.'))
        // Client disconnected before the stream finished: cancel the upstream fetch so
        // its connection is released instead of leaking until the provider ends.
        res.on('close', () => {
          if (!res.writableEnded && !streamEnded) {
            try {
              selectedUpstreamController?.abort()
            } catch {}
          }
        })
        armIdleWatchdog()
        const pipeWithErrorHandling = (src, dest) => {
          // Only genuine pipe failures finalize here. A normal src 'end' must NOT:
          // captureStream's flush() runs afterwards and owns the healthy-completion
          // path — finalizing on 'end' tears down the client mid-response.
          //
          // The error's own words are kept: the agent decides whether to continue a dropped
          // turn from this text (see lib/stream-failure.js), and "No response from agent"
          // named nothing it could classify as transport, so a dropped stream ended the turn
          // instead of being retried.
          const finished = (err) => {
            if (streamEnded) return
            const detail = err?.message ? `: ${err.message}` : ''
            finalizeStream(`Stream interrupted before the agent answered${detail}`)
          }
          src.on('error', finished)
          dest.on('error', finished)
          return src.pipe(dest)
        }
        // A provider that leaks its tool-call envelope leaves DeepSeek's special-token markup in
        // `content`, which a client renders as the assistant's message and then replays forever
        // (see lib/tool-call-residue.js). The guard sits *after* captureStream on purpose: the log
        // and the verdicts keep the provider's raw bytes, because a leak is evidence about the
        // provider and this capture is the only place it can be observed. Scrubbing before it would
        // delete the only proof that a provider does this.
        const residueFilter = createResidueStreamFilter()
        const residueDecoder = new TextDecoder()
        const residueGuard = new Transform({
          transform(chunk, encoding, callback) {
            // Decode rather than chunk.toString(): a chunk can split a multi-byte character in two,
            // which toString replaces with U+FFFD (the same reason readStreamedAnswer decodes).
            const out = residueFilter.push(residueDecoder.decode(chunk, { stream: true }))
            if (out) callback(null, out)
            else callback()
          },
          flush(callback) {
            // Release both what the decoder held for an incomplete character and the filter's
            // withheld tag prefix, so a stream that ends mid-tag loses nothing.
            const tail = residueFilter.push(residueDecoder.decode()) + residueFilter.flush()
            if (tail) this.push(tail)
            callback()
          },
        })
        // A failed attempt is relayed as the provider wrote it, but the client's SDK reads the
        // OpenAI envelope (`{"error":{"message":...}}`). NIM and DeepSeek send a bare
        // `{"message":...}`, which the SDK cannot parse, so it reports "400 status code (no
        // body)" and the provider's explanation — the one thing that names the fix — is lost.
        // Only an error response is rewritten; a successful stream passes through untouched.
        /** @type {Buffer[]} */
        const errorChunks = []
        const errorEnvelopeGuard = selectedResponse.ok
          ? null
          : new Transform({
              transform(chunk, encoding, callback) {
                errorChunks.push(Buffer.from(chunk))
                callback()
              },
              flush(callback) {
                const raw = Buffer.concat(errorChunks).toString('utf8')
                const normalized = normalizeErrorEnvelope(raw)
                if (normalized) {
                  try {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                  } catch {
                    /* headers already flushed; the body is still the right shape */
                  }
                }
                this.push(normalized || raw)
                callback()
              },
            })
        const relay = pipeWithErrorHandling(nodeBody, captureStream).pipe(residueGuard)
        if (errorEnvelopeGuard) relay.pipe(errorEnvelopeGuard).pipe(res)
        else relay.pipe(res)
      } else {
        // Bound the body read for non-streaming responses: a provider that stalls
        // mid-body aborts instead of hanging the client.
        let text
        if (selectedUpstreamController) {
          const bodyTimer = setTimeout(() => {
            try {
              selectedUpstreamController.abort()
            } catch {}
          }, UPSTREAM_HEADERS_TIMEOUT_MS)
          try {
            text = await selectedResponse.text()
          } finally {
            clearTimeout(bodyTimer)
          }
        } else {
          text = await selectedResponse.text()
        }
        const measuredTtft = Number(selectedResponse.headers.get('x-hammer-ttft-ms'))
        const measuredGeneration = Number(selectedResponse.headers.get('x-hammer-generation-ms'))
        const measuredTokens = Number(selectedResponse.headers.get('x-hammer-completion-tokens'))
        logEntry.ttft =
          Number.isFinite(measuredTtft) && measuredTtft >= 0
            ? Math.round(measuredTtft)
            : logEntry.duration
        if (Number.isFinite(measuredTokens) && measuredTokens > 0)
          logEntry.completion_tokens = Math.round(measuredTokens)
        if (selectedResponse.status >= 400) {
          try {
            logEntry.error = JSON.parse(text)
          } catch {
            logEntry.error = text
          }
          recordContextObservation(
            selectedModel,
            extractErrorText(logEntry.error),
            selectedRequestMessages,
          )
        } else {
          try {
            const data = JSON.parse(text)
            captureResolvedModel(logEntry, data)
            const textModel = upstreamModelIdOfPayload(data)
            if (textModel) rememberUpstreamModelId(selectedModel, textModel)
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const msg = data.choices[0].message
              if (logContent && msg.content) logEntry.response = msg.content
              if (msg.tool_calls) {
                if (logContent) {
                  logEntry.tool_calls = msg.tool_calls.map((tc) => {
                    if (tc.function && typeof tc.function.arguments === 'string') {
                      try {
                        tc.function.arguments = JSON.parse(tc.function.arguments)
                      } catch (e) {}
                    }
                    return tc
                  })
                }
                captureThoughtSignatures(msg.tool_calls, selectedModel?.providerKey)
              }
              if (logContent && msg.function_call) {
                logEntry.function_call = { ...msg.function_call }
                if (typeof logEntry.function_call.arguments === 'string') {
                  try {
                    logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments)
                  } catch (e) {}
                }
              }
            }
            if (data.usage) {
              if (data.usage.prompt_tokens != null)
                logEntry.prompt_tokens = data.usage.prompt_tokens
              if (data.usage.completion_tokens != null)
                logEntry.completion_tokens = data.usage.completion_tokens
            }
          } catch (e) {}
        }
        if (selectedResponse.status < 400) {
          if (hasUsableChatCompletionBody(text)) {
            promoteSuccessfulModel(selectedModel, selectedProbeMs)
            recordUsage(selectedModel, {
              ttft: logEntry.ttft,
              completionTokens: logEntry.completion_tokens,
              genMs:
                Number.isFinite(measuredGeneration) && measuredGeneration > 0
                  ? Math.round(measuredGeneration)
                  : Math.max(1, Math.round(performance.now() - selectedT0)),
              contextTokens:
                logEntry.prompt_tokens != null && logEntry.completion_tokens != null
                  ? logEntry.prompt_tokens + logEntry.completion_tokens
                  : null,
            })
          } else {
            markModelIncompatible(selectedModel)
          }
        }
        // The one place a non-streamed body reaches a client, so one strip covers every provider.
        // The header copy above forwards content-type, transfer-encoding, cache-control and
        // connection only — never content-length — so a body that changes length is safe to write.
        const clientText =
          selectedResponse.status >= 400
            ? normalizeErrorEnvelope(text) || text
            : scrubChatCompletionBody(text)
        res.end(clientText)
        if (persistLogs) scheduleLogSave()
      }
    } catch (e) {
      const requestErrorMessage = getNetworkErrorMessage(e) || e.message
      if (logEntry) {
        logEntry.status = 'err'
        logEntry.error = requestErrorMessage
      }
      console.error(chalk.red(`  [Router] Error processing request: ${requestErrorMessage}`))
      if (logEntry && persistLogs) scheduleLogSave()
      // Upstream/network failures after retries are server-side problems, not client
      // errors -- report them as 502 so clients can retry instead of misdiagnosing
      // their own request as malformed.
      res.status(502).json({ error: { message: requestErrorMessage } })
    }
  })
}
