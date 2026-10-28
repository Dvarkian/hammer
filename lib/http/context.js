// @ts-check
/**
 * @file context.js
 * @description The composition-root seed handed to every extracted route module.
 *
 * `runServer` builds exactly one of these objects and passes it as the second
 * argument to each `register*Routes(app, ctx)` call. It has two halves, and the
 * distinction matters:
 *
 * - **Stable references** (functions, Maps, frozen config) are plain values. A
 *   module may destructure them at registration time; they never change
 *   identity.
 * - **Mutable state** (`results`, `usageStats`, `requestLogs`, `lastProxyError`,
 *   `pinnedSelection`, `fallbackSelection`) arrives as accessor pairs. A module
 *   must therefore read and write them as `ctx.results`, never destructure them
 *   — a destructured copy would go stale the moment the composer or a handler
 *   reassigns the binding, and the dashboard would then be served a model table
 *   the router has already replaced.
 *
 * This file intentionally has no runtime exports. It documents the contract that
 * `runServer` and the route modules share; the seed itself is assembled in the
 * composer, next to the state it exposes, because that is the only place those
 * bindings exist.
 *
 * The Runtime phase moves ownership the other way: the state will live in an
 * object like this one, and the composer's `let` bindings will disappear.
 *
 * Module-level shape (fields as of the /v1 extraction):
 *
 *   Mutable, via getters/setters
 *     results             model rows the router will route over
 *     usageStats          per-model usage counters
 *     requestLogs         in-memory recent request log
 *     lastProxyError      last proxy failure surfaced by /api/models
 *     pinnedSelection     the user's manual pin, if any
 *     fallbackSelection   the last fallback the router performed
 *
 *   Stable
 *     providerHealth providerUsageReports providerUsageErrors
 *     providerUsageFetchedAt providerUsagePending modelDiscoveryOutcomes
 *     ANTHROPIC_STOP_REASONS AnthropicRelayStream anthropicToOpenAIBody
 *     anthropicBlockText captureProxyRateLimit readRateLimitHeaders
 *     recordUsage saveUsageStats scheduleLogSave applyUsageDerivedMetrics
 *     effectiveSelectorSettings fallbackDisplayRow getLastServedAt
 *     kickProviderUsageRefresh pinnedSelectionPayload publishedQuotaFor
 *     buildObservedQuota buildProviderConfigEntry discoverPendingProviderModels
 *     pingModel refreshOpenAICompatibleModels refreshProviderModelsForApi
 *     triggerImmediateProviderPing captureThoughtSignatures
 *     contextUpperBoundFor discoverLazyImportsForRequest extractErrorText
 *     getNextApiKey getNextApiKeyWithIndex isGoogleAiRequestCompatible
 *     learnedFieldStrips markCredentialRejected markRateLimited
 *     noteProviderReachable noteProviderUnreachable outputCapFor
 *     recordContextObservation recordRoutedModelFailure rememberOutputCap
 *     rememberUpstreamModelId sanitizeOutboundPayload setFallbackSelection
 */

export {}
