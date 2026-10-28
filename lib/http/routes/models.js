// @ts-check
/**
 * @file models.js
 * @description model table reads.
 *
 * Extracted from runServer. Mutable state arrives through the shared route
 * context (never as a destructured snapshot), because these handlers reassign
 * it and the composer must observe the change: fallbackSelection, lastProxyError, pinnedSelection, results, usageStats.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} ctx the composition-root seed (see http/context.js)
 */

import { formatGenericProviderModelLabel } from '../../providers/discovery.js'
import {
  canonicalizeModelId,
  getPreferredModelLabel,
  resolveAliasedModelId,
  stripRoutingNamespace,
} from '../../../sources.js'
import { loadConfig } from '../../config.js'
import { selectProviderUsageReport, serializeProviderUsage } from '../../provider-usage.js'
import { getProvider, providerQuotaTable } from '../../providers/index.js'
import {
  DEFAULT_QOS_LATENCY_TARGET_MS,
  buildModelGroups,
  computeQoSMap,
  computeUsageAverages,
  deriveContextState,
  getAvg,
  getRoutingModelKey,
  getUptime,
  getVerdict,
  isModelEligibleForRouting,
  normalizeContextEvidence,
  preferHealthyProviders,
  providerBenchState,
  providerScopeKey,
  rankModelsForSmartest,
  resolveSelectionSource,
  selectModelBySlope,
  selectorSlopeOf,
} from '../../utils.js'

/**
 * The config and the provider descriptors carry runtime and legacy keys their
 * shared JSDoc does not enumerate. Reading them through one widening helper
 * keeps that gap in a single place instead of sprinkling casts through a
 * 260-line handler.
 */
const readConfig = () => /** @type {any} */ (loadConfig())
/** @param {string} providerKey */
const readProvider = (providerKey) => /** @type {any} */ (getProvider(providerKey))

export function registerModelRoutes(app, ctx) {
  const {
    applyUsageDerivedMetrics,
    effectiveSelectorSettings,
    fallbackDisplayRow,
    getLastServedAt,
    getPinnedModelCandidate,
    kickProviderUsageRefresh,
    pinnedSelectionPayload,
    providerHealth,
    providerUsageErrors,
    providerUsageFetchedAt,
    providerUsagePending,
    providerUsageReports,
  } = ctx
  app.get('/api/models', async (req, res) => {
    // Provider cards and the model table share one usage snapshot, so this is the one place the
    // refresh is asked for — but not waited on. It used to be `await refreshProviderUsageReports()`
    // here and in /api/config, and the dashboard fetched both in one Promise.all: a single slow or
    // unreachable usage endpoint could therefore hold back the model table, both KPIs and both
    // plots for as long as PING_TIMEOUT (60s) while the page showed an empty grid. The rows do not
    // need the reports — they carry the last known ones — so the payload serves what is cached,
    // says whether a refresh is outstanding, and the refresh announces itself over /api/events
    // when it lands (see kickProviderUsageRefresh).
    const usagePending = providerUsagePending()
    if (usagePending) kickProviderUsageRefresh()
    const currentConfig = readConfig()
    const qosOptions = {
      latencyTargetMs: currentConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS,
    }
    const qosMap = computeQoSMap(ctx.results, [], qosOptions)
    // The API carries the same canonical model partition that routing and /v1/models use.
    // This is deliberately computed once here and attached to each row: the dashboard must
    // not re-derive model identity from a second, browser-local alias table.
    const modelGroups = buildModelGroups(ctx.results, canonicalizeModelId)
    const modelGroupByRowKey = new Map()
    for (const group of modelGroups) {
      for (const model of group.models) {
        modelGroupByRowKey.set(getRoutingModelKey(model), group)
      }
    }
    const today = new Date().toISOString().slice(0, 10)
    const providerDailyCounts = new Map()
    for (const [key, entry] of ctx.usageStats) {
      if (entry?.dailyDate !== today) continue
      const providerKey = key.split('::', 1)[0]
      providerDailyCounts.set(
        providerKey,
        (providerDailyCounts.get(providerKey) || 0) + (Number(entry.dailyProxyCount) || 0),
      )
    }
    // One read of the derived table per request, rather than per row: the quota a provider
    // publishes is now attached to its descriptor (see lib/providers/catalog.js), so the
    // table is built from the registry instead of read from a hand-maintained copy.
    const quotaTable = providerQuotaTable()
    // The ping *history* is opt-in. Up to 50 entries per row rode along on every snapshot — for
    // a federated catalog that is most of the payload — while the dashboard reads exactly one
    // thing out of it (when the row last answered a probe with 200, see lastProbeSuccessAt).
    // The field below states that answer; `?pings=1` still serves the whole history to an API
    // client that wants it, so nothing is lost, only stopped being compulsory on the page's
    // critical path.
    const includePings = String(req.query?.pings || '') === '1'
    const formatted = ctx.results.map((r) => {
      applyUsageDerivedMetrics(r)
      const lastPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null
      // The newest successful probe, or 0 when the row has never answered one. Same scan the
      // dashboard used to run over the history it was sent (see lib/utils.js getUptime for the
      // other reader of the same array).
      let lastProbeSuccessAt = 0
      for (let i = r.pings.length - 1; i >= 0; i--) {
        if (String(r.pings[i]?.code) === '200') {
          lastProbeSuccessAt = Number(r.pings[i].ts) || 0
          break
        }
      }
      const now = Date.now()
      const rateLimit = r.rateLimit || null
      // The provider-level outage bench for this row, if any (see the ledger in utils.js).
      const outage = providerBenchState(providerHealth, providerScopeKey(r), now)
      let isRateLimited = false
      if (rateLimit) {
        if (rateLimit.wasRateLimited === true) {
          isRateLimited = true
        }
        if (
          rateLimit.creditLimit > 0 &&
          rateLimit.creditRemaining != null &&
          rateLimit.creditRemaining <= 0
        ) {
          isRateLimited = true
        }
        if (rateLimit.resetRequestsAt && rateLimit.resetRequestsAt <= now) {
          // informative only; status is refreshed by ping cycle
        }
      }

      // Real usage stats captured when this model was actually proxied
      const usageEntry = ctx.usageStats.get(`${r.providerKey}::${r.modelId}`)
      const providerReports = providerUsageReports.get(r.providerKey) || []
      const usageFetchedAt = providerUsageFetchedAt.get(r.providerKey) || null
      const usageError = providerUsageErrors.get(r.providerKey) || null
      const providerUsages = providerReports
        .filter((report) => !report.model || report.model === r.modelId)
        .map(
          (report) =>
            serializeProviderUsage([
              {
                ...report,
                fetchedAt: report.fetchedAt || usageFetchedAt,
                freshness: usageError ? 'stale' : report.freshness || 'fresh',
                error: usageError,
              },
            ])[0],
        )
        .filter(Boolean)
      const providerUsage =
        selectProviderUsageReport(providerReports, {
          providerKey: r.providerKey,
          model: r.modelId,
        }) || selectProviderUsageReport(providerReports, { providerKey: r.providerKey })
      const usageAverages = computeUsageAverages(usageEntry)
      // The speed numbers come off the row (see applyUsageDerivedMetrics) so the
      // payload, the KPI, and the router share one definition of a row's speed.
      const displayTtft = r.ttft
      const displayTps = r.tps
      // Context window: one derivation feeds the column, the min_ctx filter, and the
      // Micro flag, so a row can never display a window and be struck out over that same
      // window at once (see deriveContextState).
      const ctxInfo = deriveContextState(r.ctx, usageEntry)
      const contextBoundMax = Number(usageEntry?.contextMax)
      const contextBoundMin = Number(usageEntry?.contextMin)
      const hasContextBoundMax =
        usageEntry?.contextMax != null && Number.isFinite(contextBoundMax) && contextBoundMax > 0
      const hasContextBoundMin =
        usageEntry?.contextMin != null && Number.isFinite(contextBoundMin) && contextBoundMin > 0

      const out = {
        ...r,
        modelGroupId: modelGroupByRowKey.get(getRoutingModelKey(r))?.id || null,
        modelGroupLabel: modelGroupByRowKey.get(getRoutingModelKey(r))?.label || r.label,
        avg: getAvg(r),
        uptime: getUptime(r),
        verdict: getVerdict(r),
        qos: isRateLimited ? 0 : qosMap.get(r) || 0,
        isRateLimited,
        lastPing: lastPing ? lastPing.ms : null,
        rateLimit,
        lastServedAt: getLastServedAt(r),
        lastProxiedAt: usageEntry?.lastServedAt || 0,
        dailyProxyCount: usageEntry?.dailyProxyCount || 0,
        providerDailyProxyCount: providerDailyCounts.get(r.providerKey) || 0,
        continuity: readProvider(r.providerKey)?.continuity || 'request',
        toolSupport: readProvider(r.providerKey)?.toolSupport || 'native',
        knownQuota: quotaTable[r.providerKey] || null,
        providerUsage: providerUsage
          ? serializeProviderUsage([
              {
                ...providerUsage,
                fetchedAt: providerUsage.fetchedAt || usageFetchedAt,
                freshness: usageError ? 'stale' : providerUsage.freshness || 'fresh',
                error: usageError,
              },
            ])[0]
          : null,
        providerUsages,
        providerUsageFetchedAt: usageFetchedAt,
        providerUsageError: usageError,
        providerUsageFreshness: usageError
          ? 'stale'
          : providerReports.length > 0
            ? 'fresh'
            : 'unavailable',
        ttft: displayTtft,
        tps: displayTps,
        usageRequests: usageAverages.requests,
        context: ctxInfo.display,
        contextTokens: ctxInfo.tokens,
        contextSource: ctxInfo.source,
        microContext: ctxInfo.micro,
        // Whether the bound behind `context` is an exact, evidence-backed provider
        // statement (the only kind the dashboard may treat as a verdict).
        contextExact: ctxInfo.exact,
        // The error body a learned bound was read from, so a client can say why a row
        // is bounded where it is instead of asserting a number with no provenance.
        contextEvidence: normalizeContextEvidence(usageEntry?.contextEvidence),
        // The learned bound itself (which `context` only shows when it is exact and the
        // provider states nothing), so a client can inspect or withdraw it.
        contextBound:
          hasContextBoundMax || hasContextBoundMin
            ? {
                min: hasContextBoundMin ? contextBoundMin : null,
                max: hasContextBoundMax ? contextBoundMax : null,
                exact: ctxInfo.exact,
                updatedAt: Number.isFinite(Number(usageEntry?.contextUpdatedAt))
                  ? Number(usageEntry.contextUpdatedAt)
                  : null,
              }
            : null,
        lastResponse: r.lastResponse,
        // Whether the router would actually consider this row. The display status
        // below can be promoted to 'up' by a clean lastResponse, so the dashboard
        // must not infer routing eligibility from it.
        routingEligible: r.status === 'up' && isModelEligibleForRouting(r) && outage == null,
        // A provider the outage ledger has benched is only ever a *fallback* — the router
        // prefers any other provider while one can serve, and uses this row when nothing can
        // (see preferHealthyProviders). Reporting it lets the dashboard say why a row that its
        // own probe still calls 'up' is not the one answering requests.
        providerBenched: outage != null,
        providerOutage: outage
          ? {
              since: outage.since,
              until: outage.benchedUntil,
              consecutive: outage.consecutive,
              distinctModels: outage.distinctModels,
              reason: outage.reason,
            }
          : null,
        // When this row last answered a probe successfully, in epoch ms (0 when never). This is
        // the one fact the dashboard needs out of the ping history.
        lastProbeSuccessAt,
      }
      // The `...r` spread above copies the row's ping history along with everything else, and the
      // history is opt-in (see includePings). It has to be *removed* rather than merely not added:
      // a key the spread already copied cannot be un-copied by a later property in the same
      // literal, which is what made this field survive the first attempt at dropping it.
      if (!includePings) delete out.pings
      // The real backend behind a catalog entry. Relay-backed entries may report a
      // rotating upstream id in every response; when it is known and is genuinely
      // another model, the dashboard shows it as the primary name. "Genuinely
      // another" ignores the g4f routing namespace and alias-equivalent spellings:
      // a relay echoing its own id (zai-z/zai-org-glm-5-3-flash for a glm-5.3-flash
      // row) must not overwrite the row's human label and split it out of the
      // shared dashboard heading all its providers group under.
      const resolvedModelId =
        typeof usageEntry?.resolvedModelId === 'string' ? usageEntry.resolvedModelId : null
      if (
        resolvedModelId &&
        resolveAliasedModelId(stripRoutingNamespace(resolvedModelId)) !==
          resolveAliasedModelId(stripRoutingNamespace(r.modelId))
      ) {
        out.realModelId = resolvedModelId
        out.realModelLabel =
          getPreferredModelLabel(resolvedModelId) ||
          formatGenericProviderModelLabel(resolvedModelId)
      }
      // The status is the row's own (applyUsageDerivedMetrics owns the single
      // readiness promotion, including its freshness bound) — the payload must not
      // re-derive it, or the dashboard and the router can disagree about "up".
      return out
    })
    // The picks below say which model the router would use, so they have to respect the same
    // provider bench the router does — otherwise the dashboard would name a benched model as
    // "Current Model" while real requests go elsewhere. preferHealthyProviders falls back to the
    // full list when every provider is benched, exactly as the router does.
    const smartestBest =
      preferHealthyProviders(rankModelsForSmartest(ctx.results), providerHealth)[0] || null
    // A fallback is a report about the request that just moved, not a fourth selection rule.
    // The current model below is therefore always the same pin > slope > ranking result the
    // next router request will use; `fallbackRow` is kept only for the explanatory metadata.
    const fallbackRow = fallbackDisplayRow()
    const pinnedResult = getPinnedModelCandidate(ctx.results, ctx.pinnedSelection, [], qosOptions)
    // Mirror pickNextModel precedence so the dashboard KPI matches real routing:
    // manual pin > slope-line pick > Elo ranking.
    const modelsConfig = loadConfig()
    let slopePick = null
    const selCfg = effectiveSelectorSettings(modelsConfig)
    const selSlope = selectorSlopeOf(selCfg)
    if (selSlope != null) {
      const selPick = selectModelBySlope(
        preferHealthyProviders(ctx.results, providerHealth),
        /** @type {any} */ ({
          slope: selSlope,
          minSpeed: selCfg.minSpeed,
          minIntell: selCfg.minIntell,
        }),
      )
      slopePick = selPick ? selPick.model : null
    }
    const effectiveBest = pinnedResult || slopePick || smartestBest
    res.json({
      models: formatted,
      // Provider-card consumers need account-attributed reports, not one report selected
      // from a model row. Keep the complete snapshot beside the rows and sanitize it at
      // the same boundary as /api/usage.
      providerQuotaReports: Object.fromEntries(
        Array.from(providerUsageReports, ([key, reports]) => [
          key,
          serializeProviderUsage(reports),
        ]),
      ),
      // Whether the reports above are all current. False means a refresh this request just started
      // is still outstanding: the table is complete, the cards' quota boxes are not, and the page
      // may re-read after the `provider-usage` event (or after its own short delay).
      usagePending,
      proxyError:
        ctx.lastProxyError && Date.now() - ctx.lastProxyError.at < 10 * 60_000
          ? ctx.lastProxyError
          : null,
      best: effectiveBest ? effectiveBest.modelId : null,
      bestProviderKey: effectiveBest ? effectiveBest.providerKey : null,
      // The normal selection is always pin > slope > ranking. A recent fallback is reported
      // separately as evidence of what the last request did; it never changes this precedence.
      selection: {
        source: resolveSelectionSource({
          pinned: pinnedResult,
          slope: slopePick,
          ranked: smartestBest,
        }),
        modelId: effectiveBest ? effectiveBest.modelId : null,
        providerKey: effectiveBest ? effectiveBest.providerKey : null,
        // The last fallback is metadata, not a fourth selection rule. Include the model it
        // named so the dashboard can show the explanation only while that model is still
        // the current one; after a slope/pin change the old fallback must not relabel it.
        fallback:
          fallbackRow && ctx.fallbackSelection
            ? {
                modelId: fallbackRow.modelId,
                providerKey: fallbackRow.providerKey,
                fromModelId: ctx.fallbackSelection.fromModelId,
                fromProviderKey: ctx.fallbackSelection.fromProviderKey,
                reason: ctx.fallbackSelection.reason,
                at: ctx.fallbackSelection.at,
              }
            : null,
      },
      ...pinnedSelectionPayload(),
      selector: {
        // The selector has no enable toggle: it is active whenever a slope is set,
        // which is exactly when the router's pick above can produce a model.
        enabled: selSlope != null,
        slope: selSlope,
        minSpeed: selCfg ? selCfg.minSpeed : null,
        minIntell: selCfg ? selCfg.minIntell : null,
        pickedModelId: slopePick ? slopePick.modelId : null,
        fallbackActive: false,
      },
    })
  })
}
