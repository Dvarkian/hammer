import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachLMArenaBoards,
  buildOpenRouterQualityIndex,
  combinePredictions,
  extractLMArenaEntries,
  fetchLMArenaBoards,
  fitMonotone,
  LMARENA_BOARD_URLS,
  LMARENA_DATASET_URLS,
  parameterlessModelIds,
  predictMonotone,
  qualityLookupKeys,
  resolveModelQuality,
  scoreForAa,
} from '../lib/model-quality.js'
import { canonicalizeModelId } from '../sources.js'

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
