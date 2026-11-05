import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachLMArenaBoards,
  buildOpenRouterQualityIndex,
  combinePredictions,
  extractLMArenaEntries,
  fetchLMArenaBoards,
  fetchOpenRouterQualityIndex,
  fitMonotone,
  LMARENA_BOARD_URLS,
  LMARENA_DATASET_URLS,
  OPENROUTER_MODELS_URL,
  parameterlessModelIds,
  predictMonotone,
  qualityLookupKeys,
  resolveModelQuality,
  resolveModelQualityWithFallback,
  scoreForAa,
} from '../lib/model-quality.js'
import {
  benchmarklistLookupKeys,
  BENCHMARKLIST_CALIBRATION_BENCHMARKS,
  resolveBenchmarkListQuality,
  buildBenchmarkListQualityIndex,
} from '../lib/benchmarklist-quality.js'
import { canonicalizeModelId } from '../sources.js'

test('a free twin inherits the measured score of the same weights', () => {
  // KiloCode advertises `reflection/beam-free` and Ollama publishes the same weights as bare
  // `beam`; the benchmark catalog measures the paid OpenRouter spelling. Both aliases must
  // resolve to the measured index entry, and a model with no public evidence must stay
  // unscored rather than being given a guessed number.
  const quality = {
    benchmarklistOnly: true,
    aaValues: [10, 20, 30, 40],
    benchmarklist: {
      modelIndex: new Map([
        [
          'reflection-beam-1-0-501b-a23b',
          {
            aa: 17.7,
            name: 'Beam 1.0',
            sampledAt: '2026-10-29T00:00:00.000Z',
            sampleTime: 1,
            isProxy: false,
          },
        ],
      ]),
      calibrations: {},
      scoreLookups: {},
    },
  }
  for (const id of ['reflection/beam-free', 'beam', 'beam:latest']) {
    const scored = resolveModelQuality(quality, id)
    assert.equal(scored.aa, 17.7, `${id} resolves to the measured Beam`)
    assert.equal(scored.source, 'benchmarklist-aa-index')
    assert.equal(scored.isEstimated, false)
  }
  for (const id of ['stealth/crouton-alpha', 'stealth/glyph-cluster']) {
    assert.equal(resolveModelQuality(quality, id).source, 'unscored')
  }
})

test('the index keys a requested alias under its measured twin', async () => {
  // The model index is built from the *requested* ids. A requested id that is a provider's
  // spelling of a catalog model must therefore be indexed under the catalog spelling too,
  // otherwise the direct AA measurement is never found and the row falls back to a weaker
  // cross-benchmark estimate.
  const catalog = Array.from({ length: 10 }, (_, i) =>
    catalogModel(`openai/gpt-${i}`, { intelligence: 10 + i * 2 }),
  )
  const indexSnapshots = [
    benchmarklistSnapshot(
      catalog
        .map((model, i) => benchmarklistRow(`openai-gpt-${i}`, `GPT ${i}`, 40 + i * 2))
        .concat([benchmarklistRow('reflection/beam-1.0-501b-a23b', 'Beam 1.0', 17.7)]),
    ),
  ]
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('artificial_analysis_intelligence_index')) {
        return { snapshots: indexSnapshots, next_cursor: null }
      }
      return { snapshots: [], next_cursor: null }
    },
  })
  const benchmarklist = await buildBenchmarkListQualityIndex(catalog, {
    fetchImpl,
    modelIds: ['reflection/beam-free'],
  })
  const quality = buildOpenRouterQualityIndex(catalog)
  quality.benchmarklistOnly = true
  quality.benchmarklist = benchmarklist

  const beam = resolveModelQuality(quality, 'reflection/beam-free')
  assert.equal(beam.source, 'benchmarklist-aa-index')
  assert.equal(beam.aa, 17.7)
  assert.equal(beam.isEstimated, false)
})

function catalogModel(id, { intelligence = null, coding = null, agentic = null, elo = null } = {}) {
  return {
    id,
    created: 1_700_000_000,
    context_length: 128_000,
    supported_parameters: ['tools', 'reasoning'],
    benchmarks: {
      artificial_analysis: {
        intelligence_index: intelligence,
        coding_index: coding,
        agentic_index: agentic,
      },
      design_arena: elo == null ? [] : [{ arena: 'models', category: 'codecategories', elo }],
    },
  }
}

function boardEntry(displayName, elo, votes = 250) {
  return { displayName, elo, votes }
}

// ── LMArena fetches ────────────────────────────────────────────────────────────────────

test('LMArena boards use the official JSON dataset before scraping the large pages', async () => {
  const calls = []
  const boards = await fetchLMArenaBoards({
    force: true,
    nowMs: 1_000,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url === LMARENA_DATASET_URLS.coding) {
        return {
          ok: true,
          json: async () => ({
            rows: [{ row: { model_name: 'coding-model', rating: 1818, vote_count: 42 } }],
          }),
        }
      }
      if (url === LMARENA_DATASET_URLS.overall) {
        return {
          ok: true,
          json: async () => ({
            rows: [{ row: { model_name: 'overall-model', rating: 1505, vote_count: 84 } }],
          }),
        }
      }
      throw new Error(`unexpected URL: ${url}`)
    },
  })

  assert.deepEqual(boards.coding, [{ displayName: 'coding-model', elo: 1818, votes: 42 }])
  assert.deepEqual(boards.overall, [{ displayName: 'overall-model', elo: 1505, votes: 84 }])
  assert.deepEqual(calls.sort(), [LMARENA_DATASET_URLS.coding, LMARENA_DATASET_URLS.overall].sort())
  assert.equal(
    calls.some((url) => Object.values(LMARENA_BOARD_URLS).includes(url)),
    false,
  )
})

test('LMArena still understands the legacy RSC page payload', () => {
  const payload = JSON.stringify({
    entries: [{ modelDisplayName: 'page-model', rating: 1600, votes: 10 }],
  })
  assert.deepEqual(extractLMArenaEntries(payload), [
    { displayName: 'page-model', elo: 1600, votes: 10 },
  ])
})

// ── Monotone calibration ──────────────────────────────────────────────────────────────
//
// The evidence is monotone but not linear, and a line fitted through a handful of anchors
// can even invert (higher Elo scoring as lower intelligence), which reorders the table
// backwards. Isotonic regression cannot: it pools the anchors until the curve only rises.

test('a calibration never falls as its evidence rises, whatever the anchors say', () => {
  const noisy = [
    [10, 12],
    [20, 30],
    [30, 20],
    [40, 34],
    [50, 15],
    [60, 40],
    [70, 22],
    [80, 50],
  ]
  const fit = fitMonotone(noisy)
  assert.ok(fit, 'eight anchors are a calibration')
  assert.equal(fit.n, 8)
  for (let i = 0; i < fit.ys.length - 1; i += 1) {
    assert.ok(fit.ys[i] <= fit.ys[i + 1], 'the fitted curve must be non-decreasing')
  }
})

test('too few anchors are not a calibration', () => {
  assert.equal(
    fitMonotone([
      [1, 10],
      [2, 20],
      [3, 30],
    ]),
    null,
  )
})

test('a prediction interpolates between knots and refuses to extrapolate past them', () => {
  const fit = fitMonotone(Array.from({ length: 10 }, (_, i) => [1000 + i * 20, 10 + i * 4]))
  assert.ok(fit)
  const middle = predictMonotone(1045, fit)
  assert.ok(middle > 18 && middle < 22, `expected the curve between 18 and 22, got ${middle}`)
  assert.equal(predictMonotone(1000, fit), fit.ys[0], 'the lowest anchor is a real reading')
  assert.equal(
    predictMonotone(1180, fit),
    fit.ys[fit.ys.length - 1],
    'the highest anchor is a real reading',
  )
  // Both alternatives were measured and both are worse: holding the curve flat gave
  // gemma-3-12b and three 2024-era LMArena models one identical 4.3, and continuing the
  // local slope gave gemma-3-12b a 2.2 and raised held-out MAE from 4.26 to 5.10.
  assert.equal(predictMonotone(990, fit), null, 'below the anchors is not a prediction')
  assert.equal(predictMonotone(0, fit), null, 'far below the anchors likewise')
  assert.equal(predictMonotone(1e9, fit), null, 'above the anchors likewise')
})

test('a missing measurement is never read as a zero', () => {
  // `Number(null)` is 0, which used to predict the bottom of the curve for every model
  // that lacked a metric — a fabricated floor score instead of no evidence at all.
  const fit = fitMonotone(Array.from({ length: 10 }, (_, i) => [1000 + i * 10, 10 + i * 2]))
  assert.ok(fit)
  for (const missing of [null, undefined, '']) {
    assert.equal(predictMonotone(missing, fit), null)
  }
  assert.equal(predictMonotone(0, fit), null, 'zero below the anchor range is out of range')
  const zeroAnchored = fitMonotone(Array.from({ length: 10 }, (_, i) => [i * 10, 10 + i * 2]))
  assert.equal(predictMonotone(0, zeroAnchored), zeroAnchored.ys[0], 'a real zero is still a value')
})

// ── Scoring from fetched evidence ─────────────────────────────────────────────────────

test("AA's coding index becomes an intelligence estimate for models AA did not rate", () => {
  // Ten anchors where the coding index tracks intelligence exactly, so a correct
  // calibration has to reproduce the relationship for a model that lacks a rating.
  const anchors = Array.from({ length: 10 }, (_, i) =>
    catalogModel(`vendor/rated-${i}`, { intelligence: 10 + i * 2, coding: 20 + i * 5 }),
  )
  const quality = buildOpenRouterQualityIndex([
    ...anchors,
    catalogModel('vendor/unrated', { coding: 45 }),
  ])
  assert.ok(quality.calibrations.coding, 'ten anchors fit a coding calibration')

  const rated = resolveModelQuality(quality, 'vendor/rated-4')
  assert.equal(rated.source, 'artificial-analysis')
  assert.equal(rated.aa, 18)

  const unrated = resolveModelQuality(quality, 'vendor/unrated')
  assert.equal(unrated.source, 'coding-index')
  assert.equal(unrated.isEstimated, true)
  assert.ok(Math.abs(unrated.aa - 20) <= 1.5, `expected about 20, got ${unrated.aa}`)
})

test('a measured rating always beats an estimate for the same model', () => {
  const catalog = Array.from({ length: 10 }, (_, i) =>
    catalogModel(`vendor/m-${i}`, { intelligence: 10 + i * 3, coding: 20 + i * 4 }),
  )
  const quality = buildOpenRouterQualityIndex(catalog)
  const measured = resolveModelQuality(quality, 'vendor/m-6')
  assert.equal(measured.source, 'artificial-analysis')
  assert.equal(measured.aa, 28)
  assert.equal(measured.isEstimated, false)
  assert.equal(measured.aaEstimated, false)
})

test('several evidence sources are averaged in inverse-error proportion', () => {
  // A weaker reading still contributes, just less: measured against picking the single most
  // accurate source per row, the weighted blend was the better estimator (5.46 vs 6.00).
  const blended = combinePredictions([
    { value: 20, weight: 0.04, source: 'coding-index' },
    { value: 40, weight: 0.01, source: 'design-arena' },
  ])
  assert.ok(blended)
  assert.equal(blended.source, 'combined-estimate')
  // 20*(0.04) + 40*(0.01) / 0.05 = 24
  assert.ok(Math.abs(blended.value - 24) < 0.001)

  const single = combinePredictions([{ value: 20, weight: 0.04, source: 'coding-index' }])
  assert.equal(single.source, 'coding-index')
  assert.equal(single.value, 20)
})

test('a model with no fetched evidence is unscored rather than invented', () => {
  const quality = buildOpenRouterQualityIndex([
    catalogModel('vendor/rated', { intelligence: 30, coding: 40 }),
  ])
  const quality2 = resolveModelQuality(quality, 'vendor/unknown-model')
  assert.equal(quality2.source, 'unscored')
  assert.equal(quality2.aa, null)
  assert.equal(quality2.score, 0)
  assert.match(quality2.detail, /no fetched intelligence evidence/)
})

// ── benchmarklist scoring ───────────────────────────────────────────────────────────────

function benchmarklistSnapshot(rows) {
  return { sampled_at: '2026-10-29T00:00:00.000Z', results: rows }
}

function benchmarklistRow(modelId, displayName, score) {
  return {
    model_id: modelId,
    display_name: displayName,
    score,
    metrics: { score: { unit: '%', label: 'Score', value: score } },
  }
}

test('benchmarklist leaf slugs reach the bare model behind a vendor prefix', () => {
  // Benchmarklist publishes vendor-prefixed ids while the catalog may use a bare namespace.
  assert.ok(benchmarklistLookupKeys('anthropic-claude-opus-5').includes('claude-opus-5'))
  assert.ok(benchmarklistLookupKeys('cognition-swe-1-6').includes('swe-1-6'))
  const terra = benchmarklistLookupKeys('gpt-5.6-terra')
  assert.equal(terra[0], 'gpt-5.6-terra')
  assert.ok(!terra.includes('5.6-terra'), 'a model-family token is not a vendor prefix')
  assert.ok(terra.includes('gpt-5-6-terra'), 'the dotted version keeps its dash spelling')

  // A version digit is not a suffix: it names the model, so no leaf may drop it. This is
  // what keeps `jamba-large-1.6` from answering for `swe-1.6`, two different families that
  // share only the 1.6.
  const swe = benchmarklistLookupKeys('cognition-swe-1.6')
  assert.ok(swe.includes('swe-1.6'))
  assert.ok(!swe.includes('1'), 'the bare version alone is never a match')
  assert.ok(benchmarklistLookupKeys('swe-1-6-slow').includes('cognition-swe-1.6'))
  assert.ok(benchmarklistLookupKeys('swe-2-flash-medium').includes('cognition-swe-2'))

  // Keep the family name on size-based IDs; `2-7b` alone matches unrelated 2.7B models.
  assert.ok(!benchmarklistLookupKeys('ALLaM-2-7b').includes('2-7b'))
  assert.ok(!benchmarklistLookupKeys('groq/ALLaM-2-7b').includes('2-7b'))
  assert.ok(benchmarklistLookupKeys('ALLaM-2-7b').includes('olmo-2-7b'))
  assert.ok(
    benchmarklistLookupKeys('nvidia/nemotron-3.5-bolt-e4b').includes(
      'nvidia-nemotron-3.5-bolt-74b-a9b',
    ),
  )
  assert.ok(benchmarklistLookupKeys('stepfun-ai/step-5-preview').includes('stepfun-step-5-preview'))

  // The fast/slow tiers of the same family are different models: dropping the tier changes
  // the identity of the row, so the leaf keeps it.
  assert.ok(benchmarklistLookupKeys('swe-1-6-fast').includes('swe-1-6-fast'))
})

test('user-approved Benchmarklist proxies resolve ALLaM and Nemotron Bolt variants', () => {
  const quality = {
    calibrations: {
      scicode: { xs: [0, 1], ys: [0, 100], weight: 1, source: 'scicode', n: 8 },
    },
    scoreLookups: {
      scicode: new Map([
        ['olmo-2-7b', 0.037],
        ['nvidia-nemotron-3.5-bolt-74b-a9b', 0.4449],
      ]),
    },
  }

  const allam = resolveBenchmarkListQuality(quality, 'ALLaM-2-7b')
  const bolt = resolveBenchmarkListQuality(quality, 'nvidia/nemotron-3.5-bolt-e4b')
  assert.equal(allam.aa, 3.7)
  assert.equal(allam.source, 'scicode')
  assert.equal(bolt.aa, 44.5)
  assert.equal(bolt.source, 'scicode')

  const allamIndex = resolveBenchmarkListQuality(
    {
      modelIndex: new Map([['olmo-2-7b', { aa: 5.6, sampledAt: '2026-10-18T00:00:00.000Z' }]]),
    },
    'ALLaM-2-7b',
  )
  assert.equal(allamIndex.aa, 5.6)
  assert.equal(allamIndex.isEstimated, true)
  assert.match(allamIndex.detail, /proxy model: OLMo 2 7B/)
})

test('a benchmarklist benchmark with 8+ AA anchors fits a calibration', async () => {
  // Twelve AA-rated anchors, so a fitted curve is a real calibration and not a guess.
  const catalog = Array.from({ length: 12 }, (_, i) =>
    catalogModel(`openai/gpt-${i}`, { intelligence: 10 + i * 2 }),
  )
  const anchors = catalog.map((model) => model)
  const snapshots = [
    benchmarklistSnapshot(
      anchors
        .map((model, i) => benchmarklistRow(`openai-gpt-${i}`, `GPT ${i}`, 40 + i * 2))
        .concat(benchmarklistRow('cognition-swe-1-6', 'Devin SWE 1.6', 47)),
    ),
  ]
  let call = 0
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => {
      call += 1
      if (String(url).includes('/api/v1/models')) return { data: catalog }
      return { snapshots, next_cursor: null }
    },
  })
  const quality = await buildBenchmarkListQualityIndex(catalog, { fetchImpl })
  assert.ok(quality.calibrations, 'at least one benchmark calibrated')
  assert.ok(call >= 1, 'the catalog was consulted for AA anchors')
})

test('benchmarklist evidence scores Devin SWE 1.6 from its own benchmark rows', async () => {
  // Devin SWE 1.6 has no AA rating, no LMArena row, and no Design Arena row, so it is
  // unscored everywhere else. benchmarklist's own board carries it, and the row is
  // inside the fitted curve's range, so it must resolve rather than stay unscored.
  const catalog = Array.from({ length: 12 }, (_, i) =>
    catalogModel(`openai/gpt-${i}`, { intelligence: 10 + i * 2 }),
  )
  const snapshots = [
    benchmarklistSnapshot(
      catalog
        .map((model, i) => benchmarklistRow(`openai-gpt-${i}`, `GPT ${i}`, 40 + i * 2))
        .concat([benchmarklistRow('cognition-swe-1-6', 'Devin SWE 1.6', 47)]),
    ),
  ]
  const fetchImpl = async () => ({ ok: true, json: async () => ({ snapshots, next_cursor: null }) })
  const quality = await buildBenchmarkListQualityIndex(catalog, { fetchImpl })
  const only = Object.values(quality.calibrations)[0]
  assert.ok(only, 'one calibration is enough to resolve a row')
  const single = {
    calibrations: { vals_terminal_bench_2_1: only },
    scoreLookups: {
      vals_terminal_bench_2_1: new Map([
        ['cognition-swe-1-6', 0.47],
        ['devin-swe-1-6', 0.47],
        ['swe-1-6', 0.47],
        ['openai-gpt-0', 0.47],
      ]),
    },
  }
  const resolved = resolveBenchmarkListQuality(single, 'devin/swe-1.6')
  assert.ok(resolved, 'a benchmarklist row resolves the model')
  assert.equal(resolved.isEstimated, true)
  assert.ok(resolved.aa > 0 && resolved.aa <= 100)
  assert.match(resolved.detail, /vals_terminal_bench_2_1/)
  const integratedQuality = buildOpenRouterQualityIndex(catalog)
  integratedQuality.benchmarklistOnly = true
  integratedQuality.benchmarklist = single
  const integrated = resolveModelQuality(integratedQuality, 'devin/swe-1.6')
  assert.equal(integrated.source, 'vals_terminal_bench_2_1')
  assert.equal(integrated.aa, resolved.aa)
  const measuredCatalogModel = resolveModelQuality(integratedQuality, 'openai/gpt-0')
  assert.equal(measuredCatalogModel.source, 'vals_terminal_bench_2_1')
  assert.equal(measuredCatalogModel.aa, resolved.aa, 'benchmarklist overrides AA direct ratings')
  assert.equal(measuredCatalogModel.isEstimated, true)
})

test('benchmarklist is the exclusive score source when its endpoints have no data', async () => {
  const catalog = [catalogModel('vendor/measured', { intelligence: 42 })]
  let catalogCalls = 0
  const fetchImpl = async (url) => {
    if (url === OPENROUTER_MODELS_URL) {
      catalogCalls += 1
      return { ok: true, json: async () => ({ data: catalog }) }
    }
    return { ok: false, status: 404 }
  }
  const quality = await fetchOpenRouterQualityIndex({
    fetchImpl,
    force: true,
    nowMs: Date.now(),
  })

  assert.equal(catalogCalls, 1, 'the benchmark provider reuses the already-fetched catalog')
  assert.equal(resolveModelQuality(quality, 'vendor/measured').source, 'unscored')
  assert.deepEqual(quality.benchmarklist.benchmarks, [])
})

test('a model with no benchmarklist row is unscored by that source', () => {
  const single = {
    calibrations: {
      scicode: { xs: [10, 50], ys: [3, 30], weight: 0.01, source: 'scicode', n: 20 },
    },
    scoreLookups: { scicode: new Map([['gpt-5.6-terra', 12]]) },
  }
  assert.equal(resolveBenchmarkListQuality(single, 'vendor/total-unknown'), null)
})

test('Benchmarklist index-feed scores use latest exact variants, not stale model-page values', async () => {
  const modelIds = [
    'deepseek-ai/deepseek-v4.1-flash',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3.5-super-vl-120b-a12b',
    'stepfun-ai/step-5-preview',
    'ALLaM-2-7b',
  ]
  const indexSnapshots = [
    {
      sampled_at: '2026-10-29T00:00:00.000Z',
      results: [
        {
          model_id: 'deepseek-deepseek-v4.1-flash-1017',
          display_name: 'DeepSeek V4.1 Flash 1017 (Max)',
          score: 32.5,
        },
        {
          model_id: 'nvidia-nemotron-3-ultra-550b-a55b',
          display_name: 'Nemotron 3 Ultra (Reasoning)',
          score: 11.8,
        },
        {
          model_id: 'nvidia-nemotron-3.5-super-vl-120b-a12b',
          display_name: 'Nemotron 3.5 Super VL',
          score: 13.6,
        },
        {
          model_id: 'stepfun-step-5-preview',
          display_name: 'Step 5 Preview',
          score: 28.5,
        },
      ],
    },
    {
      sampled_at: '2026-10-18T00:00:00.000Z',
      results: [
        {
          model_id: 'deepseek-deepseek-v4.1-flash',
          display_name: 'DeepSeek V4.1 Flash (Max)',
          score: 39.5,
        },
        {
          model_id: 'deepseek-deepseek-v4.1-flash',
          display_name: 'DeepSeek V4.1 Flash (Non-reasoning)',
          score: 24.7,
        },
        {
          model_id: 'nvidia-nemotron-3-ultra-550b-a55b',
          display_name: 'Nemotron 3 Ultra (Reasoning)',
          score: 22.9,
        },
        {
          model_id: 'stepfun-step-5-preview',
          display_name: 'Step 5 Preview',
          score: 43.7,
        },
        {
          model_id: 'olmo-2-7b',
          display_name: 'OLMo 2 7B',
          score: 5.6,
        },
      ],
    },
    {
      sampled_at: '2026-06-10T00:00:00.000Z',
      results: [
        {
          model_id: 'nvidia-nemotron-3-ultra-550b-a55b',
          display_name: 'Nemotron 3 Ultra (Reasoning)',
          score: 47.6,
        },
      ],
    },
  ]
  const fetchImpl = async (url) => {
    const value = String(url)
    if (value.includes('/results/artificial_analysis_intelligence_index.json')) {
      return {
        ok: true,
        json: async () => ({ snapshots: indexSnapshots, next_cursor: null }),
      }
    }
    return { ok: true, json: async () => ({ snapshots: [], next_cursor: null }) }
  }
  const catalog = [catalogModel(modelIds[0], { intelligence: 10 })]
  const benchmarklist = await buildBenchmarkListQualityIndex(catalog, { fetchImpl, modelIds })
  const quality = buildOpenRouterQualityIndex(catalog)
  quality.benchmarklistOnly = true
  quality.benchmarklist = benchmarklist

  const deepseek = resolveModelQuality(quality, modelIds[0])
  const nemotron = resolveModelQuality(quality, modelIds[1])
  const superVl = resolveModelQuality(quality, modelIds[2])
  const step = resolveModelQuality(quality, modelIds[3])
  const allam = resolveModelQuality(quality, modelIds[4])
  assert.ok(deepseek.aa > nemotron.aa)
  assert.equal(deepseek.aa, 39.5, 'uses the latest exact DeepSeek V4.1 Flash index row')
  assert.equal(nemotron.aa, 11.8, 'uses Nemotron’s latest index-feed row')
  assert.equal(deepseek.source, 'benchmarklist-aa-index')
  assert.equal(deepseek.isEstimated, false)
  assert.equal(superVl.aa, 13.6, 'uses the latest exact Super VL index row')
  assert.equal(superVl.source, 'benchmarklist-aa-index')
  const resolvedSuperBackend = resolveModelQualityWithFallback(
    quality,
    'private/nvidia/nemotron-3.5-super-120b-a12b',
    modelIds[2],
  )
  assert.equal(resolvedSuperBackend.aa, 13.6, 'falls back to the exact advertised model identity')
  assert.equal(resolvedSuperBackend.source, 'benchmarklist-aa-index')
  assert.equal(
    resolveModelQualityWithFallback(quality, modelIds[3], modelIds[2]).aa,
    28.5,
    'a scored backend remains authoritative over the advertised model',
  )
  assert.equal(step.aa, 28.5, 'maps Stepfun’s provider ID to Benchmarklist’s model identity')
  assert.equal(step.source, 'benchmarklist-aa-index')
  assert.equal(allam.aa, 5.6, 'uses the explicitly accepted OLMo 2 7B proxy')
  assert.equal(allam.isEstimated, true, 'a proxy identity is not represented as an exact match')
  assert.match(allam.detail, /proxy model: OLMo 2 7B/)
})

test('an out-of-range benchmarklist score resolves to nothing, not a floor', () => {
  // Same refusal as every other source: below the fitted curve is not a prediction.
  const single = {
    calibrations: {
      scicode: { xs: [10, 50], ys: [3, 30], weight: 0.01, source: 'scicode', n: 20 },
    },
    scoreLookups: { scicode: new Map([['some-new-model', 5]]) },
  }
  assert.equal(resolveBenchmarkListQuality(single, 'some-new-model'), null)
})

test('historical snapshots only normalize against the same publisher', () => {
  const sourceKey = 'artificial_analysis_api:https://example.test/benchmark'
  const calibration = new Map(Array.from({ length: 8 }, (_, i) => [`anchor-${i}`, i / 7]))
  const historical = new Map([
    ...Array.from({ length: 8 }, (_, i) => [`anchor-${i}`, i / 7]),
    [benchmarklistLookupKeys('new-model')[0], 0.5],
  ])
  const quality = {
    calibrations: {
      scicode: { xs: [0, 1], ys: [10, 90], weight: 1, source: 'scicode', n: 8 },
    },
    scoreLookups: {
      scicode: {
        calibration: calibration,
        calibrationSnapshotKey: `2026-10-29|${sourceKey}`,
        snapshots: new Map([
          [`2026-10-29|${sourceKey}`, { sourceKey, scores: calibration }],
          [`2026-10-18|${sourceKey}`, { sourceKey, scores: historical }],
        ]),
      },
    },
  }
  const comparable = resolveBenchmarkListQuality(quality, 'new-model')
  assert.ok(comparable)
  assert.equal(comparable.aa, 50)

  quality.scoreLookups.scicode.snapshots.set('2026-10-18|other-source', {
    sourceKey: 'other-source',
    scores: historical,
  })
  quality.scoreLookups.scicode.snapshots.delete(`2026-10-18|${sourceKey}`)
  assert.equal(
    resolveBenchmarkListQuality(quality, 'new-model'),
    null,
    'a different publisher may use an incompatible score scale',
  )
})

test('Devin SWE variants resolve BenchmarkList scores across percent/fraction units', () => {
  const calibrationKey = 'calibration'
  const cognitionKey = 'cognition'
  const calibrationScores = new Map(
    Array.from({ length: 8 }, (_, i) => [`anchor-${i}`, 0.1 + (0.8 * i) / 7]),
  )
  const cognitionScores = new Map([
    ['cognition-swe-1.6', 0.397],
    ['cognition-swe-2', 0.928],
  ])
  const quality = {
    calibrations: {
      vals_terminal_bench_2_1: {
        xs: [0.1, 0.9],
        ys: [10, 90],
        weight: 1,
        source: 'vals_terminal_bench_2_1',
        n: 8,
      },
      deepswe_1_1: {
        xs: [0.6, 0.8],
        ys: [20, 80],
        weight: 1,
        source: 'deepswe_1_1',
        n: 8,
      },
    },
    scoreLookups: {
      vals_terminal_bench_2_1: {
        calibration: calibrationScores,
        calibrationSnapshotKey: calibrationKey,
        snapshots: new Map([
          [
            calibrationKey,
            { sourceKey: 'artificial-analysis', unit: 'proportion', scores: calibrationScores },
          ],
          [cognitionKey, { sourceKey: 'cognition', unit: 'proportion', scores: cognitionScores }],
        ]),
      },
      deepswe_1_1: {
        calibration: calibrationScores,
        calibrationSnapshotKey: calibrationKey,
        snapshots: new Map([
          [
            calibrationKey,
            { sourceKey: 'artificial-analysis', unit: 'proportion', scores: calibrationScores },
          ],
          [
            cognitionKey,
            {
              sourceKey: 'cognition',
              unit: 'proportion',
              scores: new Map([['cognition-swe-2', 0.73]]),
            },
          ],
        ]),
      },
    },
  }

  assert.equal(resolveBenchmarkListQuality(quality, 'swe-1-6-slow').aa, 39.7)
  assert.equal(resolveBenchmarkListQuality(quality, 'swe-2-flash-medium').aa, 59)
  quality.scoreLookups.vals_terminal_bench_2_1.snapshots.get(cognitionKey).unit = null
  assert.equal(
    resolveBenchmarkListQuality(quality, 'swe-1-6-slow'),
    null,
    'cross-publisher results without a comparable unit are not used',
  )
})

test('the selected benchmarklist surfaces are coding-relevant and calibratable', () => {
  // Every entry that ships must be a coding/agentic benchmark capable of anchoring
  // against AA's intelligence index; a non-coding surface would bias scores sideways.
  const ids = BENCHMARKLIST_CALIBRATION_BENCHMARKS.map((benchmark) => benchmark.id)
  assert.ok(ids.includes('vals_terminal_bench_2_1'))
  assert.ok(ids.includes('scicode'))
  assert.ok(ids.includes('frontierswe'))
  for (const benchmark of BENCHMARKLIST_CALIBRATION_BENCHMARKS) {
    assert.equal(
      benchmark.minAnchors,
      8,
      `${benchmark.id} must not calibrate off fewer than eight AA anchors`,
    )
  }
})

test('LMArena boards predict an Elo-only model, ordered by Elo', () => {
  const anchors = Array.from({ length: 10 }, (_, i) =>
    catalogModel(`vendor/board-${i}`, { intelligence: 10 + i * 2 }),
  )
  const boards = {
    coding: anchors.map((model, i) => boardEntry(`board-${i}`, 1000 + i * 20)),
    overall: [],
  }
  const quality = buildOpenRouterQualityIndex(anchors)
  attachLMArenaBoards(quality, boards)
  assert.ok(quality.calibrations.lmarenaCoding, 'the board anchors a calibration')

  const result = resolveModelQuality(
    {
      ...quality,
      lmArenaBoards: { coding: [...boards.coding, boardEntry('fresh-model', 1140)], overall: [] },
    },
    'vendor/fresh-model',
  )
  assert.equal(result.source, 'lmarena-coding')
  assert.ok(result.aa > 20 && result.aa < 30, `expected a mid-board value, got ${result.aa}`)
  assert.match(result.detail, /lmarena-coding/)
})

// ── Id matching ───────────────────────────────────────────────────────────────────────

test('lookup keys reach the bare weights behind a serving suffix', () => {
  const keys = qualityLookupKeys('@cf/meta/llama-3.1-8b-instruct-fp8')
  assert.ok(keys.includes('llama-3.1-8b-instruct'), 'the de-quantized spelling must be offered')
  assert.equal(keys[0], '@cf/meta/llama-3.1-8b-instruct-fp8')
  assert.ok(
    qualityLookupKeys('@cf/meta/llama-3.3-70b-instruct-fp8-fast').includes(
      'llama-3.3-70b-instruct',
    ),
  )
})

test('a parameterised id is only related to a shorter one when it trails its size', () => {
  assert.deepEqual(parameterlessModelIds('nvidia/nemotron-3.5-lightning-30b-a3b'), [
    'nvidia/nemotron-3.5-lightning-30b',
    'nvidia/nemotron-3.5-lightning',
  ])
  // `-it` / `-instruct` end these ids, so nothing is ever stripped from them.
  assert.deepEqual(parameterlessModelIds('google/gemma-3-4b-it'), [])
  assert.deepEqual(parameterlessModelIds('nvidia/llama-3.1-nemotron-70b-instruct'), [])
})

test("a provider's parameterised id uses the catalog's measured rating for the bare model", () => {
  const index = new Map([
    [
      'nvidia/nemotron-3.5-lightning',
      { kind: 'measured', aa: 5.5, modelId: 'nvidia/nemotron-3.5-lightning' },
    ],
  ])
  const quality = resolveModelQuality(
    { index, aaValues: [5.5, 27.8] },
    'nvidia/nemotron-3.5-lightning-30b-a3b',
  )
  assert.equal(quality.source, 'artificial-analysis')
  assert.equal(quality.aa, 5.5)
  assert.match(quality.detail, /catalog spelling/)

  const exact = resolveModelQuality({ index, aaValues: [5.5] }, 'nvidia/nemotron-3.5-lightning')
  assert.equal(exact.aa, 5.5)
  assert.doesNotMatch(exact.detail, /catalog spelling/)
})

test('a Cloudflare id keeps its namespaced spellings', () => {
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').base, '@cf/qwen/qwq-32b')
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').unprefixed, 'qwq-32b')
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').unscoped, 'qwen/qwq-32b')
})

test('a non-namespace id is untouched by the new spelling', () => {
  for (const id of [
    'qwen/qwq-32b',
    'deepseek-ai/deepseek-r1-distill-qwen-32b',
    'gpt-4o-mini',
    'codestral-latest',
  ]) {
    const { base, unprefixed, unscoped } = canonicalizeModelId(id)
    assert.equal(unscoped, base, `${id} gained an unexpected third spelling`)
    assert.equal(unprefixed, base.split('/').pop())
  }
})

// ── The routing scale ────────────────────────────────────────────────────────────────

test('the routing score is a bounded, monotone position in the measured distribution', () => {
  const aaValues = [4.3, 12.5, 20.1, 28.9, 36.4, 46, 58.4]
  const low = scoreForAa(12.5, aaValues)
  const high = scoreForAa(46, aaValues)
  assert.ok(low < high)
  assert.ok(low >= 0.05 && high <= 0.95)
})
