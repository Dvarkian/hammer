import { MODELS, canonicalizeModelId, getScore } from '../sources.js';
import { fetchEmperoModels, fetchKiloCodeFreeModels, fetchOllamaModels, fetchOpenRouterFreeModels } from './providers/discovery.js';
import { isProviderEnabled } from './config.js';
import { fetchOpenRouterQualityIndex, resolveModelQuality } from './model-quality.js';

export function normalizeMissingScoreId(modelId) {
  return canonicalizeModelId(modelId).base;
}

/**
 * Audits every configured and live-discovered model against the current quality
 * hierarchy. Provider failures are returned instead of being silently ignored.
 */
export async function getModelScoreAudit(config, { force = true } = {}) {
  const qualityData = await fetchOpenRouterQualityIndex({ force });
  const models = new Map();
  const providerErrors = [];

  function add(modelId, label = null, providerKey = null) {
    const id = normalizeMissingScoreId(modelId);
    const current = models.get(id);
    models.set(id, {
      modelId: id,
      label: label || current?.label || id,
      providers: [...new Set([...(current?.providers || []), ...(providerKey ? [providerKey] : [])])],
    });
  }

  for (const [modelId, label, , , providerKey] of MODELS) add(modelId, label, providerKey);

  const discoveries = [
    ['kilocode', fetchKiloCodeFreeModels],
    ['openrouter', fetchOpenRouterFreeModels],
    ['empero', fetchEmperoModels],
    ['ollama', fetchOllamaModels],
  ];
  for (const [providerKey, discover] of discoveries) {
    if (!isProviderEnabled(config, providerKey)) continue;
    try {
      for (const model of await discover(config)) add(model.modelId, model.label, providerKey);
    } catch (err) {
      providerErrors.push({ providerKey, error: err?.message || String(err) });
    }
  }

  const scored = new Map();
  for (const model of models.values()) {
    const quality = resolveModelQuality(qualityData, model.modelId, getScore(model.modelId));
    const modelId = normalizeMissingScoreId(quality.modelId || model.modelId);
    const current = scored.get(modelId);
    scored.set(modelId, {
      ...model,
      ...quality,
      modelId,
      label: current?.label || model.label,
      providers: [...new Set([...(current?.providers || []), ...model.providers])],
    });
  }
  const entries = [...scored.values()].sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));

  return { entries, providerErrors, regression: qualityData.regression, catalogSize: qualityData.catalogSize };
}

// Backward-compatible helper: only truly blind defaults still need manual attention.
export async function getModelsNeedingScores(config) {
  const audit = await getModelScoreAudit(config);
  return audit.entries
    .filter(entry => entry.source === 'default-fallback')
    .map(entry => entry.modelId);
}
