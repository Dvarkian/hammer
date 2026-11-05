/**
 * @file lib/benchmarklist-quality.js
 * @description Intelligence scoring from benchmarklist.com evidence.
 *
 * benchmarklist.com publishes a documented public API with 2600+ benchmarks and 24,600+
 * models. Each benchmark exposes a `/api/v1/results/{id}.json` endpoint that returns
 * timestamped snapshots with provenance (source_url, source_type, self_reported flag,
 * aliases). Multiple snapshots per benchmark let us pick the one with the most
 * AA-rated overlap.
 *
 * We fit the same isotonic (pool-adjacent-violators) calibrations used by
 * lib/model-quality.js, projecting each benchmark's scores onto the AA Intelligence
 * Index (0–100) scale. Predictions combine in inverse-error proportion. A model with
 * no evidence on any selected benchmark stays unscored.
 */

import { fetchJsonWithRetry } from './providers/discovery.js'
import { qualityLookupKeys } from './model-quality.js'
import { resolveAliasedModelId } from '../sources.js'
import { fetch } from 'undici'

export const BENCHMARKLIST_API_BASE = 'https://benchmarklist.com/api/v1'

// Coding/agentic benchmarks on benchmarklist with strong AA overlap (tested 2026-11).
// Each entry: { benchmarkId, label, minAnchors }
// minAnchors is the AA calibration threshold; benchmarks below it are skipped.
export const BENCHMARKLIST_CALIBRATION_BENCHMARKS = [
  { id: 'scicode', label: 'SciCode', minAnchors: 8 },
  { id: 'vals_terminal_bench_2_1', label: 'Terminal-Bench 2.1 (vals)', minAnchors: 8 },
  { id: 'swe_marathon', label: 'SWE-Marathon', minAnchors: 8 },
  { id: 'kernelbench_cuda', label: 'KernelBench CUDA', minAnchors: 8 },
  { id: 'frontierswe', label: 'FrontierSWE', minAnchors: 8 },
  { id: 'vals_vibe_code', label: 'Vibe Code (vals)', minAnchors: 8 },
  { id: 'vals_swebench', label: 'SWE-bench Verified (vals)', minAnchors: 8 },
  { id: 'deepswe_1_1', label: 'DeepSWE 1.1', minAnchors: 8 },
  { id: 'vals_lcb', label: 'LiveCodeBench (vals)', minAnchors: 8 },
  { id: 'vals_code_migration', label: 'Code Migration (vals)', minAnchors: 8 },
  { id: 'vals_vals_index', label: 'VALS Index', minAnchors: 8 },
  { id: 'vals_vals_multimodal_index', label: 'VALS Multimodal Index', minAnchors: 8 },
  { id: 'frontiercode', label: 'FrontierCode', minAnchors: 8 },
  { id: 'swe_bench_pro', label: 'SWE-bench Pro', minAnchors: 8 },
  { id: 'openai_swe_bench_verified', label: 'SWE-bench Verified', minAnchors: 8 },
]

// We only need the latest snapshot with the most AA anchors, so walk until exhausted.

// A curve through fewer anchors than this is not a calibration, it is a coincidence.
const MIN_CALIBRATION_ANCHORS = 8
// Held-out error assumed for a calibration too small to measure its own.
const DEFAULT_CALIBRATION_MAE = 10

let cachedQuality = null
let cachedAt = 0
let cachedModelIds = new Set()
const CACHE_MS = 24 * 60 * 60 * 1000

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function scoreUnit(result) {
  const metric = Object.values(result?.metrics || {}).find((entry) => entry?.unit)
  const unit = String(metric?.unit || '')
    .trim()
    .toLowerCase()
  if (unit === '%' || unit === 'percent' || unit === 'percentage' || unit === 'fraction')
    return 'proportion'
  return unit || null
}

function normalizedScore(result) {
  const score = finiteOrNull(result?.score)
  if (score == null) return null
  const metric = Object.values(result?.metrics || {}).find((entry) => entry?.unit)
  const unit = String(metric?.unit || '')
    .trim()
    .toLowerCase()
  if (unit === '%' || unit === 'percent' || unit === 'percentage') return score / 100
  return score
}

function normalizedModelIdentity(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[/:]/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function benchmarklistIdentityAliases(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
  if (/(?:^|\/)allam-2-7b$/.test(raw)) return ['olmo-2-7b']
  if (/(?:^|\/)nemotron-3\.5-bolt-e4b$/.test(raw)) {
    return ['nvidia-nemotron-3.5-bolt-74b-a9b']
  }
  return []
}

function benchmarklistProxyLabel(value) {
  const alias = benchmarklistIdentityAliases(value)[0]
  if (alias === 'olmo-2-7b') return 'OLMo 2 7B'
  if (alias === 'nvidia-nemotron-3.5-bolt-74b-a9b') return 'Nemotron 3.5 Bolt 74B-A9B'
  return null
}

function exactModelIdentityKeys(value, includeAliases = true) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  // The index is keyed from the *requested* ids, and a requested id may be a provider's own
  // spelling of a catalog model (`reflection/beam-free`). Resolve the alias here too, so the
  // measured row for the catalog spelling is indexed under the provider's id and the direct
  // AA entry outranks a cross-benchmark estimate.
  const resolved = resolveAliasedModelId(raw) || raw
  const values = new Set([
    raw,
    resolved,
    ...(includeAliases ? benchmarklistIdentityAliases(raw) : []),
  ])
  if (raw.includes('/')) values.add(raw.slice(raw.lastIndexOf('/') + 1))
  const slug = normalizedModelIdentity(raw).split('-')
  if (slug.length > 2 && slug[0] === slug[1]) values.add(slug.slice(1).join('-'))
  const stepfunVariant = raw.match(/^stepfun-ai[/:](.+)$/)
  if (stepfunVariant) values.add(`stepfun-${stepfunVariant[1]}`)
  const devinVariant = raw.match(/^(?:devin[/:])?swe-(\d+)[.-](\d+)-slow$/)
  if (devinVariant) values.add(`cognition-swe-${devinVariant[1]}.${devinVariant[2]}`)
  if (/^(?:devin[/:])?swe-2-(?:flash-)?(?:medium|high|max)$/.test(raw)) {
    values.add('cognition-swe-2')
  }
  const keys = new Set()
  for (const item of values) {
    const normalized = normalizedModelIdentity(item)
    if (!normalized) continue
    keys.add(normalized)
    keys.add(normalized.replace(/\./g, '-'))
    keys.add(normalized.replace(/-/g, '.'))
  }
  return keys
}

async function fetchModelIndexScores(modelIds, snapshots) {
  const scores = new Map()
  const requested = [...new Set((modelIds || []).map(String).filter(Boolean))]
  if (!requested.length) return { scores, modelIds: new Set() }

  const keysByModel = new Map(
    requested.map((modelId) => [modelId, exactModelIdentityKeys(modelId)]),
  )
  const directKeysByModel = new Map(
    requested.map((modelId) => [modelId, exactModelIdentityKeys(modelId, false)]),
  )
  const latestByModel = new Map()
  for (const snapshot of snapshots) {
    for (const result of snapshot.results || []) {
      const score = finiteOrNull(result?.score)
      if (score == null || score > 100) continue
      const sampledAt = result.sampled_at || snapshot.sampled_at || null
      const sampleTime = Date.parse(sampledAt || '') || 0
      const rowKeys = exactModelIdentityKeys(result?.model_id)
      for (const [modelId, modelKeys] of keysByModel) {
        const matchedKeys = [...modelKeys].filter((key) => rowKeys.has(key))
        if (!matchedKeys.length) continue
        const isProxy = ![...directKeysByModel.get(modelId)].some((key) => rowKeys.has(key))
        const previous = latestByModel.get(modelId)
        if (
          !previous ||
          sampleTime > previous.sampleTime ||
          (sampleTime === previous.sampleTime && score > previous.aa)
        ) {
          latestByModel.set(modelId, {
            aa: score,
            name: result.display_name || result.model_id,
            sampledAt,
            sampleTime,
            isProxy,
          })
        }
      }
    }
  }
  for (const [modelId, entry] of latestByModel) {
    for (const key of keysByModel.get(modelId)) scores.set(key, entry)
  }
  return { scores, modelIds: new Set(requested.map(normalizedModelIdentity)) }
}

/**
 * Normalize a benchmarklist `model_id` / `display_name` slug into the same key space
 * the catalog uses, falling back to the leaf forms behind a vendor prefix.
 *
 * benchmarklist publishes vendor-prefixed kebab slugs (`anthropic-claude-opus-5`) and the
 * OpenRouter catalog publishes namespaced ones (`anthropic/claude-opus-5`), so a row can
 * only be matched through the bare model name. Version dots are also spelled either way
 * (`swe-1.6` and `swe-1-6`), so both are offered.
 */
/**
 * The digits a slug carries (`swe-1.6` -> 16, `gpt-5.6-terra` -> 56), or null when it
 * carries none.
 */
function slugDigits(slug) {
  const digits = String(slug || '').match(/\d/g)
  return digits ? digits.join('') : null
}

const BENCHMARKLIST_VENDOR_PREFIXES = new Set([
  'alibaba',
  'allenai',
  'amazon',
  'anthropic',
  'baidu',
  'bytedance',
  'cohere',
  'cognition',
  'databricks',
  'deepinfra',
  'deepseek',
  'fireworks',
  'google',
  'groq',
  'ibm',
  'meta',
  'microsoft',
  'minimax',
  'mistral',
  'moonshotai',
  'nvidia',
  'openai',
  'perplexity',
  'poolside',
  'qwen',
  'reka',
  'stepfun',
  'tencent',
  'tiiuae',
  'upstage',
  'writer',
  'xai',
  'zhipu',
])

export function benchmarklistLookupKeys(raw) {
  const keys = []
  // Only the id's own spellings are offered. `qualityLookupKeys` also returns the
  // fast/fp8-stripped form of a model, and on this catalog that would be a *different*
  // model: `swe-1-6-fast` (Devin's fast tier) and `swe-1.6` (the slow one) share every
  // token once the tier is stripped, so a row for one would answer for the other.
  // We collect spellings from the raw id and also from `qualityLookupKeys`, but then we
  // filter out any spelling that lost a serving suffix the raw id had (i.e., the raw id
  // keeps 'fast' or 'fp8' but the derived one does not).
  const rawSpelling = String(raw || '').toLowerCase()
  const rawDigits = slugDigits(rawSpelling)
  const spellings = new Set([rawSpelling])
  const explicitAliases = new Set(benchmarklistIdentityAliases(rawSpelling))
  for (const alias of explicitAliases) spellings.add(alias)
  // Devin's catalog exposes effort/latency variants while BenchmarkList records the
  // underlying Cognition model. These are the documented SWE model configurations, not
  // generic serving suffixes: retain the model version while mapping to its base identity.
  const devinVariant = rawSpelling.match(/^(?:devin[/:])?swe-(\d+)[.-](\d+)-slow$/)
  if (devinVariant) {
    const alias = `cognition-swe-${devinVariant[1]}.${devinVariant[2]}`
    spellings.add(alias)
    explicitAliases.add(alias)
  }
  const swe2Variant = rawSpelling.match(/^(?:devin[/:])?swe-2-(?:flash-)?(?:medium|high|max)$/)
  if (swe2Variant) {
    spellings.add('cognition-swe-2')
    explicitAliases.add('cognition-swe-2')
  }
  const stepfunVariant = rawSpelling.match(/^stepfun-ai[/:](.+)$/)
  if (stepfunVariant) {
    const alias = `stepfun-${stepfunVariant[1]}`
    spellings.add(alias)
    explicitAliases.add(alias)
  }
  for (const key of qualityLookupKeys(raw)) spellings.add(key)
  for (const spelling of spellings) {
    // Drop spellings that are a fast/fp8/lora-stripped version of the raw id.
    // If the raw keeps the tier and the candidate drops it, it is a different model.
    const derivedDigits = slugDigits(spelling)
    if (
      rawDigits &&
      derivedDigits === rawDigits &&
      !spelling.includes(rawSpelling) &&
      spelling !== rawSpelling &&
      !explicitAliases.has(spelling)
    ) {
      // The candidate has the same digits but is missing the tier — reject.
      continue
    }
    for (const value of [spelling, spelling.replace(/\./g, '-'), spelling.replace(/-/g, '.')]) {
      const tokens = String(value || '')
        .split(/[\s:/_-]+/)
        .filter(Boolean)
      if (!tokens.length) continue
      const full = tokens.join('-')
      // Only remove a known vendor prefix; dropping the first token of a model slug
      // can make unrelated size variants collide (for example `allam-2-7b` -> `2-7b`).
      const leafs = [full]
      if (tokens.length > 1 && BENCHMARKLIST_VENDOR_PREFIXES.has(tokens[0])) {
        leafs.push(tokens.slice(1).join('-'))
      }
      for (const leaf of leafs) {
        // Keep model digits and a family name so unrelated size variants cannot collide.
        if (slugDigits(leaf) !== slugDigits(full)) continue
        if (!/[a-z]/.test(leaf)) continue
        keys.push(leaf)
      }
    }
  }
  return [...new Set(keys.filter((key) => key.length > 1))]
}

/**
 * Fetch all snapshots for a benchmark, following pagination cursors.
 */
async function fetchAllSnapshots(fetchImpl, benchmarkId) {
  const url = `${BENCHMARKLIST_API_BASE}/results/${encodeURIComponent(benchmarkId)}.json`
  let cursor = null
  const snapshots = []
  for (;;) {
    const pageUrl = cursor ? `${url}?cursor=${encodeURIComponent(cursor)}` : url
    const payload = await fetchJsonWithRetry(pageUrl, { fetchImpl, timeoutMs: 30000 })
    const snaps = Array.isArray(payload?.snapshots) ? payload.snapshots : []
    snapshots.push(...snaps)
    cursor = payload?.next_cursor || null
    if (!cursor || snaps.length === 0) break
  }
  return snapshots
}

/**
 * For a benchmark's snapshots, find the one with the most AA-rated anchors.
 * Returns { points: [[score, aa]], snapshotMeta, rows: Map<key, score> } or null.
 */
function bestSnapshot(snapshots, aaByKey) {
  let best = null
  for (const snap of snapshots) {
    const rows = new Map()
    const pointsByModel = new Map()
    for (const r of snap.results || []) {
      const score = normalizedScore(r)
      if (score == null) continue
      const modelKeys = benchmarklistLookupKeys(r?.model_id)
      for (const key of modelKeys) {
        if (!rows.has(key)) rows.set(key, score)
      }
      const nameKeys = benchmarklistLookupKeys(r?.display_name)
      for (const key of nameKeys) {
        if (!rows.has(key)) rows.set(key, score)
      }
      const anchor = [...modelKeys, ...nameKeys]
        .map((key) => aaByKey.get(key))
        .find((aa) => aa != null)
      if (anchor != null) {
        const modelKey = normalizedModelIdentity(r?.model_id || r?.display_name)
        if (modelKey && !pointsByModel.has(modelKey)) pointsByModel.set(modelKey, [score, anchor])
      }
    }
    const points = [...pointsByModel.values()]
    if (points.length >= MIN_CALIBRATION_ANCHORS && (!best || points.length > best.points.length)) {
      best = { points, snapshotMeta: snap, rows }
    }
  }
  return best
}

/**
 * Build a lookup table from all snapshots: model key -> score.
 * Used at resolution time to find a model's score on a benchmark.
 */
function buildScoreLookup(snapshots) {
  const lookup = new Map()
  for (const snap of snapshots) {
    for (const r of snap.results || []) {
      const score = normalizedScore(r)
      if (score == null) continue
      for (const key of benchmarklistLookupKeys(r?.model_id)) {
        if (!lookup.has(key)) lookup.set(key, score)
      }
      for (const key of benchmarklistLookupKeys(r?.display_name)) {
        if (!lookup.has(key)) lookup.set(key, score)
      }
    }
  }
  return lookup
}

/**
 * Isotonic regression (pool adjacent violators) of y on x.
 * Identical to fitMonotone in model-quality.js, kept here to avoid a circular dep.
 */
function fitMonotone(points) {
  const valid = (points || [])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0])
  if (valid.length < MIN_CALIBRATION_ANCHORS) return null
  const stacked = []
  for (const [x, y] of valid) {
    stacked.push({ sumX: x, sumY: y, n: 1, mean: y })
    while (
      stacked.length > 1 &&
      stacked[stacked.length - 2].mean > stacked[stacked.length - 1].mean
    ) {
      const upper = stacked.pop()
      const lower = stacked.pop()
      const sumY = lower.sumY + upper.sumY
      const n = lower.n + upper.n
      stacked.push({ sumX: lower.sumX + upper.sumX, sumY, n, mean: sumY / n })
    }
  }
  const xs = stacked.map((block) => block.sumX / block.n)
  const ys = stacked.map((block) => block.mean)
  if (!(Math.max(...ys) - Math.min(...ys) > 0)) return null
  return { xs, ys, n: valid.length }
}

/**
 * Predict y from a fitted isotonic curve; null if out of range.
 */
function predictMonotone(value, calibration) {
  if (value == null || value === '') return null
  const x = Number(value)
  if (!Number.isFinite(x) || !calibration?.xs?.length) return null
  const { xs, ys } = calibration
  const n = xs.length
  if (n === 1) return clamp(ys[0])
  if (x < xs[0] || x > xs[n - 1]) return null
  if (x === xs[0]) return clamp(ys[0])
  if (x === xs[n - 1]) return clamp(ys[n - 1])
  let low = 0
  let high = n - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (xs[mid] <= x) low = mid
    else high = mid
  }
  const span = xs[high] - xs[low]
  const weight = span === 0 ? 0 : (x - xs[low]) / span
  return clamp(ys[low] + (ys[high] - ys[low]) * weight)
}

/**
 * Held-out MAE (leave-one-out). Used to weight predictions.
 */
function heldOutError(points) {
  if (points.length < MIN_CALIBRATION_ANCHORS + 2) return null
  const errors = []
  for (let i = 0; i < points.length; i++) {
    const fit = fitMonotone(points.filter((_, j) => j !== i))
    const predicted = predictMonotone(points[i][0], fit)
    if (predicted != null) errors.push(Math.abs(predicted - points[i][1]))
  }
  if (!errors.length) return null
  return errors.reduce((a, b) => a + b, 0) / errors.length
}

function makeCalibration(source, points) {
  const fit = fitMonotone(points)
  if (!fit) return null
  const mae = heldOutError(points)
  const weight = 1 / ((mae ?? DEFAULT_CALIBRATION_MAE) + 1) ** 2
  return { ...fit, source, mae, weight }
}

/**
 * Build the benchmarklist quality index from the OpenRouter catalog (for AA anchors).
 */
export async function buildBenchmarkListQualityIndex(
  catalog,
  { fetchImpl = fetch, modelIds = [] } = {},
) {
  let indexSnapshots = []
  try {
    indexSnapshots = await fetchAllSnapshots(fetchImpl, 'artificial_analysis_intelligence_index')
  } catch (err) {
    console.warn('[benchmarklist] intelligence index feed unavailable:', err?.message || err)
  }

  // Build AA lookup from catalog
  const aaByKey = new Map()
  for (const model of catalog || []) {
    const aa = model?.benchmarks?.artificial_analysis?.intelligence_index
    if (aa == null) continue
    for (const key of qualityLookupKeys(model.id)) {
      if (!aaByKey.has(key)) aaByKey.set(key, aa)
    }
  }
  const indexAnchors = new Map()
  for (const snapshot of indexSnapshots) {
    for (const result of snapshot.results || []) {
      const score = finiteOrNull(result?.score)
      if (score == null || score > 100) continue
      const sampledAt = result.sampled_at || snapshot.sampled_at || null
      const sampleTime = Date.parse(sampledAt || '') || 0
      for (const key of exactModelIdentityKeys(result?.model_id)) {
        const previous = indexAnchors.get(key)
        if (
          !previous ||
          sampleTime > previous.sampleTime ||
          (sampleTime === previous.sampleTime && score > previous.aa)
        ) {
          indexAnchors.set(key, { aa: score, sampleTime })
        }
      }
    }
  }
  for (const [key, entry] of indexAnchors) {
    if (!aaByKey.has(key)) aaByKey.set(key, entry.aa)
  }

  const calibrations = {}
  const benchmarks = []
  // scoreLookups[benchId] = { calibration: Map<key, score>, snapshots: Map<snapshotKey, Map<key, score>> }
  // where snapshotKey = `${sampled_at}|${source_key}`
  const scoreLookups = {}

  const benchmarkIndexes = await Promise.all(
    BENCHMARKLIST_CALIBRATION_BENCHMARKS.map(async (spec) => {
      try {
        const snapshots = await fetchAllSnapshots(fetchImpl, spec.id)
        const best = bestSnapshot(snapshots, aaByKey)
        if (!best) {
          console.warn(
            `[benchmarklist] ${spec.id}: no snapshot with ${MIN_CALIBRATION_ANCHORS}+ AA anchors`,
          )
          return null
        }
        const cal = makeCalibration(spec.id, best.points)
        if (!cal) {
          console.warn(`[benchmarklist] ${spec.id}: calibration fit failed`)
          return null
        }
        const calibrationLookup = buildScoreLookup([best.snapshotMeta])
        const snapshotLookups = new Map(
          snapshots.map((snap) => [
            `${snap.sampled_at}|${snap.source_key}`,
            {
              sourceKey: snap.source_key,
              unit:
                new Set((snap.results || []).map(scoreUnit).filter(Boolean)).size === 1
                  ? scoreUnit((snap.results || []).find((row) => scoreUnit(row)))
                  : null,
              scores: buildScoreLookup([snap]),
            },
          ]),
        )
        return {
          spec,
          cal,
          best,
          scoreLookup: {
            calibration: calibrationLookup,
            snapshots: snapshotLookups,
            calibrationSnapshotKey: `${best.snapshotMeta?.sampled_at}|${best.snapshotMeta?.source_key}`,
          },
        }
      } catch (err) {
        console.warn(`[benchmarklist] ${spec.id} fetch failed:`, err?.message || err)
        return null
      }
    }),
  )

  for (const result of benchmarkIndexes) {
    if (!result) continue
    const { spec, cal, best, scoreLookup } = result
    calibrations[spec.id] = cal
    benchmarks.push({
      id: spec.id,
      label: spec.label,
      anchors: best.points.length,
      snapshotAt: best.snapshotMeta?.sampled_at,
      rows: best.rows.size,
    })
    scoreLookups[spec.id] = scoreLookup
    console.log(
      `[benchmarklist] ${spec.id}: ${best.points.length} anchors, ${best.rows.size} rows, MAE=${cal.mae?.toFixed(2) ?? 'n/a'}`,
    )
  }

  let modelIndex = new Map()
  let indexedModelIds = new Set()
  try {
    const indexed = await fetchModelIndexScores(modelIds, indexSnapshots)
    modelIndex = indexed.scores
    indexedModelIds = indexed.modelIds
  } catch (err) {
    console.warn('[benchmarklist] model index unavailable:', err?.message || err)
  }

  return {
    calibrations,
    benchmarks,
    scoreLookups,
    modelIndex,
    indexedModelIds,
    catalogSize: (catalog || []).length,
    builtAt: Date.now(),
  }
}

/**
 * Resolve a model's intelligence from benchmarklist evidence.
 * Returns { aa, source, detail, isEstimated, contributions } or null if no evidence.
 */
export function resolveBenchmarkListQuality(qualityData, modelId) {
  // A provider can spell a model differently from the benchmark catalog while serving the same
  // weights (`reflection/beam-free` is `reflection/beam-1.0-501b-a23b`), and this function is
  // handed the row id. Resolve the alias first, or the measured twin's index entry is never
  // found and the row stays unscored.
  const resolvedId = resolveAliasedModelId(modelId) || modelId
  const directIndex = qualityData?.modelIndex
  if (directIndex) {
    const directKeys = exactModelIdentityKeys(resolvedId, false)
    const proxyLabel = benchmarklistProxyLabel(modelId)
    for (const key of exactModelIdentityKeys(resolvedId)) {
      const entry = directIndex.get(key)
      if (!entry) continue
      const isProxy = entry.isProxy || !directKeys.has(key)
      return {
        aa: entry.aa,
        source: 'benchmarklist-aa-index',
        detail: `Benchmarklist-hosted Artificial Analysis Intelligence Index${entry.sampledAt ? ` (${entry.sampledAt})` : ''}${isProxy && proxyLabel ? ` (proxy model: ${proxyLabel})` : ''}`,
        isEstimated: isProxy,
        contributions: [],
      }
    }
  }
  if (!qualityData?.calibrations || !qualityData?.scoreLookups) return null
  const predictions = []

  for (const [benchId, cal] of Object.entries(qualityData.calibrations)) {
    const lookupBundle = qualityData.scoreLookups[benchId]
    if (!lookupBundle) continue

    // Backward-compat: support both old (Map) and new ({calibration, snapshots, calibrationSnapshotKey}) structures
    const isNewStructure = lookupBundle.calibration != null || lookupBundle.snapshots != null
    const calibrationLookup = isNewStructure ? lookupBundle.calibration : lookupBundle
    const snapshots = isNewStructure ? lookupBundle.snapshots : null
    const calibrationSnapshotKey = isNewStructure ? lookupBundle.calibrationSnapshotKey : null

    let score = null
    let rawScore = null
    let foundInCalibration = false
    for (const key of benchmarklistLookupKeys(modelId)) {
      if (calibrationLookup.has(key)) {
        rawScore = calibrationLookup.get(key)
        score = rawScore
        foundInCalibration = true
        break
      }
    }

    // If not in calibration snapshot, try cross-snapshot normalization
    if (!foundInCalibration && snapshots) {
      const calSnap = calibrationSnapshotKey ? snapshots.get(calibrationSnapshotKey) : null
      const calLookup = calSnap?.scores

      // Only normalize snapshots published by the same source. Different publishers may
      // report the same benchmark on unrelated scales (fractions, percentages, raw counts).
      for (const [snapKey, snapBundle] of snapshots) {
        if (
          snapKey === calibrationSnapshotKey ||
          !calSnap ||
          (snapBundle.sourceKey !== calSnap.sourceKey &&
            !(calSnap.unit && snapBundle.unit === calSnap.unit))
        )
          continue
        const snapLookup = snapBundle.scores
        let snapScore = null
        for (const key of benchmarklistLookupKeys(modelId)) {
          if (snapLookup.has(key)) {
            snapScore = snapLookup.get(key)
            break
          }
        }
        if (snapScore == null) continue

        // Find shared models between this snapshot and calibration snapshot
        const shared = []
        for (const [key, v] of snapLookup) {
          if (calLookup?.has(key)) {
            shared.push([key, v, calLookup.get(key)])
          }
        }
        if (snapBundle.sourceKey !== calSnap.sourceKey) {
          if (snapScore != null) {
            score = snapScore
            rawScore = snapScore
            break
          }
          continue
        }
        if (shared.length < 8) continue

        // Linear fit: calScore = a * snapScore + b
        const n = shared.length
        let sx = 0,
          sy = 0,
          sxy = 0,
          sxx = 0
        for (const [, dv, rv] of shared) {
          sx += dv
          sy += rv
          sxy += dv * rv
          sxx += dv * dv
        }
        const denominator = n * sxx - sx * sx
        if (denominator === 0) continue
        const a = (n * sxy - sx * sy) / denominator
        const b = (sy - a * sx) / n

        // Normalize
        score = a * snapScore + b
        rawScore = snapScore
        break
      }
    }

    if (score != null) {
      const predicted = predictMonotone(score, cal)
      if (predicted != null) {
        predictions.push({
          value: predicted,
          weight: cal.weight,
          source: benchId,
          rawScore: rawScore,
          benchmark: cal.source,
        })
      }
    }
  }
  if (!predictions.length) return null

  // Combine in inverse-error proportion (same as model-quality.js combinePredictions)
  const total = predictions.reduce((sum, p) => sum + p.weight, 0)
  const value = predictions.reduce((sum, p) => sum + p.value * p.weight, 0) / total
  const strongest = predictions.reduce((best, p) => (p.weight > best.weight ? p : best))

  const proxyLabel = benchmarklistProxyLabel(modelId)
  return {
    aa: Math.round(value * 10) / 10,
    source: predictions.length > 1 ? 'combined-estimate' : strongest.source,
    detail: `estimated from ${predictions.map((p) => p.source).join(' + ')} (${predictions.map((p) => `${p.source}→${p.value.toFixed(1)}`).join(', ')})${proxyLabel ? ` (proxy model: ${proxyLabel})` : ''}`,
    isEstimated: true,
    contributions: predictions,
  }
}

/**
 * Fetch and build the index, cached for a day.
 */
export async function fetchBenchmarkListQualityIndex(
  catalog,
  { fetchImpl, force = false, modelIds = [] } = {},
) {
  const requestedIds = new Set((modelIds || []).map(normalizedModelIdentity).filter(Boolean))
  const needsAdditionalModels = [...requestedIds].some((id) => !cachedModelIds.has(id))
  if (!force && cachedQuality && Date.now() - cachedAt < CACHE_MS && !needsAdditionalModels)
    return cachedQuality

  const quality = await buildBenchmarkListQualityIndex(catalog, { fetchImpl, modelIds })
  if (Object.keys(quality.calibrations).length) {
    cachedQuality = quality
    cachedAt = Date.now()
    cachedModelIds = new Set(
      [...quality.indexedModelIds].map(normalizedModelIdentity).filter(Boolean),
    )
  }
  return quality
}
