// @ts-check
/**
 * @file providers.js
 * @description provider roster, endpoints and refresh.
 *
 * Extracted from runServer. Mutable state arrives through the shared route
 * context (never as a destructured snapshot), because these handlers reassign
 * it and the composer must observe the change: results.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} ctx the composition-root seed (see http/context.js)
 */

import { sources } from '../../../sources.js'

// A bulk refresh must end even when one provider's discovery endpoint never answers. The
// per-request timeouts cover most providers, but a single unresolved request used to keep the
// dashboard's button spinning for minutes; this caps the whole per-provider wait.
const PROVIDER_REFRESH_TIMEOUT_MS = 25_000
import {
  buildOpenAICompatibleInstanceKey,
  getBaseProviderKey,
  getOpenAICompatibleInstanceId,
  isProviderEnabled,
  listOpenAICompatibleEndpoints,
  loadConfig,
  removeOpenAICompatibleEndpoint,
  saveConfig,
  upsertOpenAICompatibleEndpoint,
} from '../../config.js'

export function registerProviderRoutes(app, ctx) {
  const {
    OPENAI_COMPATIBLE_PROVIDER_KEY,
    buildProviderConfigEntry,
    describeSyncError,
    discoverPendingProviderModels,
    kickProviderUsageRefresh,
    modelDiscoveryOutcomes,
    pingModel,
    pingModels,
    providerUsagePending,
    refreshOpenAICompatibleModels,
    refreshProviderModelsForApi,
    triggerImmediateProviderPing,
    withQualityScoringPaused,
  } = ctx
  // Pace one provider's probes a few rows at a time; older or mocked contexts without the
  // helper keep the direct call.
  const pingRows =
    pingModels || ((rows) => Promise.allSettled((rows || []).map((r) => pingModel(r))))
  app.get('/api/config', async (req, res) => {
    // Same decoupling as /api/models: the roster and the cached quota reports are served at once,
    // and a refresh that is still outstanding is named per card (quotaPending) rather than making
    // every provider card wait for the slowest provider's usage endpoint. Both routes used to
    // await the same shared refresh, so the two payloads the dashboard booted on were serialized
    // behind it as well.
    const usagePending = providerUsagePending()
    if (usagePending) kickProviderUsageRefresh()
    const currentConfig = loadConfig()
    const providers = []
    for (const key of Object.keys(sources)) {
      // The bare 'openai-compatible' source is a template; its instances are emitted separately.
      if (key === OPENAI_COMPATIBLE_PROVIDER_KEY) continue
      providers.push(buildProviderConfigEntry(currentConfig, key, undefined, usagePending))
    }
    for (const ep of listOpenAICompatibleEndpoints(currentConfig)) {
      providers.push(buildProviderConfigEntry(currentConfig, ep.instanceKey, ep.name, usagePending))
    }
    res.json(providers)
  })

  app.post('/api/openai-compatible/endpoints', (req, res) => {
    const { id, name, baseUrl, modelId, apiKey, enabled, discoverModels } = req.body || {}
    if (!name && !id) return res.status(400).json({ error: 'name or id is required.' })

    const currentConfig = loadConfig()
    const desiredKey = buildOpenAICompatibleInstanceKey(id || name)
    if (!desiredKey)
      return res
        .status(400)
        .json({ error: 'Could not derive a valid instance id from the supplied name.' })
    if (currentConfig.providers?.[desiredKey]) {
      return res.status(409).json({
        error: `Endpoint with id "${getOpenAICompatibleInstanceId(desiredKey)}" already exists.`,
      })
    }

    upsertOpenAICompatibleEndpoint(
      currentConfig,
      /** @type {any} */ ({
        instanceKey: desiredKey,
        name: name || getOpenAICompatibleInstanceId(desiredKey),
        baseUrl: baseUrl || '',
        modelId: modelId || '',
        apiKey: apiKey === undefined ? undefined : apiKey,
        enabled: enabled !== false,
        discoverModels: discoverModels === undefined ? undefined : discoverModels !== false,
      }),
    )
    saveConfig(currentConfig)

    void triggerImmediateProviderPing(desiredKey)

    return res.json({
      success: true,
      instanceKey: desiredKey,
      id: getOpenAICompatibleInstanceId(desiredKey),
    })
  })

  app.delete('/api/openai-compatible/endpoints/:id', (req, res) => {
    const id = req.params.id
    const instanceKey = buildOpenAICompatibleInstanceKey(id)
    if (!instanceKey) return res.status(400).json({ error: 'Invalid id.' })

    const currentConfig = loadConfig()
    const removed = removeOpenAICompatibleEndpoint(currentConfig, instanceKey)
    if (!removed) return res.status(404).json({ error: 'Endpoint not found.' })
    saveConfig(currentConfig)

    // Drop result rows for the removed instance so it disappears from the dashboard.
    void refreshOpenAICompatibleModels()

    return res.json({ success: true })
  })

  app.post('/api/providers/:providerKey/refresh', async (req, res) => {
    const { providerKey } = req.params
    const baseKey = getBaseProviderKey(providerKey)
    if (!sources[baseKey]) {
      return res.status(404).json({ error: 'Unknown provider.' })
    }
    const providerName = sources[baseKey].name

    try {
      await refreshProviderModelsForApi(providerKey)
      const providerModels = ctx.results.filter((r) => r.providerKey === providerKey)
      void pingRows(providerModels)
      return res.json({
        success: true,
        providerKey,
        providerName,
        // An empty list is not automatically a success story. `state`/`note` say which kind of
        // empty it is, so the card can show "needs accountId" rather than "0 models".
        modelDiscovery: modelDiscoveryOutcomes.get(providerKey) || null,
        // Report the rows the table now holds, not the catalog the gateway advertised. For a
        // provider with no credential the discovery returns a full list and the merge discards
        // it (see providerHasCredential), so echoing that list here would have the card announce
        // "15 models" beside a needs-key note and an empty table.
        models: providerModels.map((row) => ({
          modelId: row.modelId,
          label: row.label,
          ctx: row.ctx,
          ctxSource: row.ctxSource,
          ctxSourceUrl: row.ctxSourceUrl,
          intell: row.intell,
          isEstimatedScore: row.isEstimatedScore === true,
          qualitySource: row.qualitySource,
          qualityDetail: row.qualityDetail,
        })),
      })
    } catch (err) {
      return res.status(502).json({
        success: false,
        providerKey,
        providerName,
        error: describeSyncError(err),
      })
    }
  })

  app.post('/api/providers/refresh-all', async (req, res) => {
    const currentConfig = loadConfig()
    const sourceKeys = Object.keys(sources)
      .filter((key) => key !== OPENAI_COMPATIBLE_PROVIDER_KEY)
      .filter((key) => isProviderEnabled(currentConfig, key))
    const instanceKeys = listOpenAICompatibleEndpoints(currentConfig)
      .filter((ep) => ep.enabled)
      .map((ep) => ep.instanceKey)
    const providerKeys = [...sourceKeys, ...instanceKeys]

    const withinDeadline = (promise) => {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`refresh timed out after ${PROVIDER_REFRESH_TIMEOUT_MS / 1000}s`)),
          PROVIDER_REFRESH_TIMEOUT_MS,
        )
      })
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
    }

    // The boot discovery runs every provider at once, but this button used to refresh them
    // one at a time. A few slow catalogs then held every later provider behind them and the
    // status read "Refreshing..." for minutes. Run them together as boot does, and keep the
    // response in provider order so the summary is stable.
    const runBulkRefresh =
      typeof withQualityScoringPaused === 'function' ? withQualityScoringPaused : (task) => task()
    const results_arr = await runBulkRefresh(() =>
      Promise.all(
        providerKeys.map(async (providerKey) => {
          const providerName = sources[getBaseProviderKey(providerKey)]?.name || providerKey
          try {
            // Quality is refreshed once after the wave. Doing it inside every provider made a
            // 24-provider refresh repeatedly rebuild the same benchmark index and look hung.
            const models = await withinDeadline(
              refreshProviderModelsForApi(providerKey, { refreshQuality: false }),
            )
            return {
              success: true,
              providerKey,
              providerName,
              modelCount: models.length,
            }
          } catch (err) {
            return {
              success: false,
              providerKey,
              providerName,
              error: describeSyncError(err),
            }
          }
        }),
      ),
    )

    // The paused quality pass unwinds here and scores the merged roster once, using the index
    // boot fetched. Rebuilding or re-reading that multi-megabyte index per provider made this
    // button wait on work that changes none of the provider rows it just refreshed.
    // Ping all models after refreshing, a few per provider at a time.
    void pingRows(ctx.results)

    return res.json({
      success: true,
      providers: results_arr,
    })
  })

  app.post('/api/providers/discover-pending', async (req, res) => {
    const providers = await discoverPendingProviderModels(false)
    return res.json({ success: true, candidates: providers.length, providers })
  })
}
