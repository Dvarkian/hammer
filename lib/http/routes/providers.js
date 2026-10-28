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
    providerUsagePending,
    refreshOpenAICompatibleModels,
    refreshProviderModelsForApi,
    triggerImmediateProviderPing,
  } = ctx
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
      const models = await refreshProviderModelsForApi(providerKey)
      const providerModels = ctx.results.filter((r) => r.providerKey === providerKey)
      void Promise.allSettled(providerModels.map((r) => pingModel(r)))
      return res.json({
        success: true,
        providerKey,
        providerName,
        // An empty list is not automatically a success story. `state`/`note` say which kind of
        // empty it is, so the card can show "needs accountId" rather than "0 models".
        modelDiscovery: modelDiscoveryOutcomes.get(providerKey) || null,
        models: models.map((model) => {
          const ranked = providerModels.find((row) => row.modelId === model.modelId) || model
          return {
            modelId: ranked.modelId,
            label: ranked.label,
            ctx: ranked.ctx,
            ctxSource: ranked.ctxSource,
            ctxSourceUrl: ranked.ctxSourceUrl,
            intell: ranked.intell,
            isEstimatedScore: ranked.isEstimatedScore === true,
            qualitySource: ranked.qualitySource,
            qualityDetail: ranked.qualityDetail,
          }
        }),
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
    const results_arr = []

    for (const providerKey of providerKeys) {
      const providerName = sources[getBaseProviderKey(providerKey)]?.name || providerKey
      try {
        const models = await refreshProviderModelsForApi(providerKey)
        results_arr.push({
          success: true,
          providerKey,
          providerName,
          modelCount: models.length,
        })
      } catch (err) {
        results_arr.push({
          success: false,
          providerKey,
          providerName,
          error: describeSyncError(err),
        })
      }
    }

    // Ping all models after refreshing
    void Promise.allSettled(ctx.results.map((r) => pingModel(r)))

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
