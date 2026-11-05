import { MODELS, canonicalizeModelId } from '../sources.js'
import {
  fetchKiloCodeFreeModels,
  fetchOllamaModels,
  fetchOpenRouterFreeModels,
} from './providers/discovery.js'
import { isProviderEnabled } from './config.js'
import { fetchOpenRouterQualityIndex, resolveModelQuality } from './model-quality.js'
import { resolveBenchmarkListQuality } from './benchmarklist-quality.js'

export function normalizeMissingScoreId(modelId) {
  return canonicalizeModelId(modelId).base
}

/**
 * Audits every configured and live-discovered model against the current quality
 * hierarchy. Provider failures are returned instead of being silently ignored.
 */
export async function getModelScoreAudit(config, { force = true } = {}) {
  const qualityData = await fetchOpenRouterQualityIndex({
    force,
    modelIds: MODELS.map(([modelId]) => modelId),
  })
  const models = new Map()
  const providerErrors = []

  function add(modelId, label = null, providerKey = null) {
    const id = normalizeMissingScoreId(modelId)
    const current = models.get(id)
    models.set(id, {
      modelId: id,
      label: label || current?.label || id,
      providers: [
        ...new Set([...(current?.providers || []), ...(providerKey ? [providerKey] : [])]),
      ],
    })
  }

  for (const [modelId, label, , , providerKey] of MODELS) add(modelId, label, providerKey)

  const discoveries = [
    ['kilocode', fetchKiloCodeFreeModels],
    ['openrouter', fetchOpenRouterFreeModels],
    ['ollama', fetchOllamaModels],
  ]
  for (const [providerKey, discover] of discoveries) {
    if (!isProviderEnabled(config, providerKey)) continue
    try {
      for (const model of await discover(config)) add(model.modelId, model.label, providerKey)
    } catch (err) {
      providerErrors.push({ providerKey, error: err?.message || String(err) })
    }
  }

  const scored = new Map()
  for (const model of models.values()) {
    const quality = resolveModelQuality(qualityData, model.modelId)
    const modelId = normalizeMissingScoreId(quality.modelId || model.modelId)
    const current = scored.get(modelId)
    scored.set(modelId, {
      ...model,
      ...quality,
      modelId,
      label: current?.label || model.label,
      providers: [...new Set([...(current?.providers || []), ...model.providers])],
      benchmarklistContributions:
        resolveBenchmarkListQuality(qualityData.benchmarklist, model.modelId)?.contributions ||
        null,
    })
  }
  const entries = [...scored.values()].sort(
    (a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId),
  )

  const sourceCounts = Object.fromEntries(
    [...new Set(entries.map((entry) => entry.source))].map((source) => [
      source,
      entries.filter((entry) => entry.source === source).length,
    ]),
  )
  const coverage = {
    total: entries.length,
    measured: entries.filter((entry) => entry.source === 'artificial-analysis').length,
    estimated: entries.filter((entry) => entry.isEstimated === true && entry.source !== 'unscored')
      .length,
    combined: entries.filter((entry) => entry.source === 'combined-estimate').length,
    unscored: entries.filter((entry) => entry.source === 'unscored').length,
  }
  return {
    entries,
    providerErrors,
    regression: qualityData.regression,
    catalogSize: qualityData.catalogSize,
    coverage,
    sourceCounts,
    benchmarklist: qualityData.benchmarklist
      ? {
          benchmarks: qualityData.benchmarklist.benchmarks,
          builtAt: qualityData.benchmarklist.builtAt,
        }
      : null,
  }
}

// The models the fetched evidence does not cover at all. There is no score to fall back
// on by design, so these are the rows a caller may want to report as unscored.
export async function getModelsNeedingScores(config) {
  const audit = await getModelScoreAudit(config)
  return audit.entries.filter((entry) => entry.source === 'unscored').map((entry) => entry.modelId)
}
