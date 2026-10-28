import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractLMArenaEntries,
  fetchLMArenaBoards,
  LMARENA_BOARD_URLS,
  LMARENA_DATASET_URLS,
  MODEL_QUALITY_FLOOR_AA,
  modelFamilyKey,
  qualityLookupKeys,
  resolveModelQuality,
} from '../lib/model-quality.js'
import { resolveAliasedModelId, canonicalizeModelId, getScore } from '../sources.js'
import { scores } from '../scores.js'

function jsonResponse(payload) {
  return { ok: true, json: async () => payload }
}

test('LMArena boards use the official JSON dataset before scraping the large pages', async () => {
  const calls = []
  const boards = await fetchLMArenaBoards({
    force: true,
    nowMs: 1_000,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url === LMARENA_DATASET_URLS.coding) {
        return jsonResponse({
          rows: [{ row: { model_name: 'coding-model', rating: 1818, vote_count: 42 } }],
        })
      }
      if (url === LMARENA_DATASET_URLS.overall) {
        return jsonResponse({
          rows: [{ row: { model_name: 'overall-model', rating: 1505, vote_count: 84 } }],
        })
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

test('the final quality fallback is an explicit 0.1 AA-scale score', () => {
  const quality = resolveModelQuality(
    { index: new Map(), aaValues: [] },
    'srv_unknown:made-up-model',
  )
  assert.equal(quality.source, 'default-fallback')
  assert.equal(quality.aa, MODEL_QUALITY_FLOOR_AA)
  assert.equal(quality.aa, 0.1)
  assert.ok(Number.isFinite(quality.score))
  assert.ok(quality.score > 0)
  assert.match(quality.detail, /floor 0\.1/)
})

test('same-family matching is spelling-insensitive but does not collapse model sizes', () => {
  assert.equal(modelFamilyKey('srv_x:vendor/ministral-3:3b'), 'ministral 3b')
  assert.equal(modelFamilyKey('ministral-3b-2512'), 'ministral 3b')
  assert.notEqual(modelFamilyKey('ministral-3b'), modelFamilyKey('ministral-8b'))

  const quality = resolveModelQuality({ index: new Map(), aaValues: [] }, 'ministral-3b-2512')
  assert.equal(quality.source, 'family-estimate')
  assert.match(quality.detail, /ministral-3:3b/)
  assert.ok(quality.score > 0.1)
})

test("Airforce's unmoderated-gpt resolves to its published GPT-3.5 Turbo estimate", () => {
  assert.equal(resolveAliasedModelId('unmoderated-gpt'), 'openai/gpt-3.5-turbo')
  const quality = resolveModelQuality({ index: new Map(), aaValues: [] }, 'unmoderated-gpt', 0.05)
  assert.equal(quality.source, 'local-fallback')
  assert.equal(quality.score, 0.05)
  assert.match(quality.detail, /scores\.js offline fallback/)
})

test('an unrelated model receives the floor rather than a guessed family score', () => {
  const quality = resolveModelQuality({ index: new Map(), aaValues: [] }, 'totally-new-model')
  assert.equal(quality.source, 'default-fallback')
  assert.equal(quality.aa, MODEL_QUALITY_FLOOR_AA)
})

test('LMArena still understands the legacy RSC page payload', () => {
  const payload = JSON.stringify({
    entries: [
      {
        modelDisplayName: 'page-model',
        rating: 1600,
        votes: 10,
      },
    ],
  })
  assert.deepEqual(extractLMArenaEntries(payload), [
    { displayName: 'page-model', elo: 1600, votes: 10 },
  ])
})

// ── Cloudflare's `@cf/<vendor>/<model>` naming ────────────────────────────────────────
//
// Cloudflare nests a namespace AND a vendor directory, and appends how it serves a model
// (`-fp8`, `-lora`, `-fp8-fast`). Every id-stripping helper used to remove exactly one path
// segment, so the vendor directory survived and no lookup ever matched the catalog's own
// spelling of the same weights. Most of those rows fell to the AA floor, which feeds the QoS
// percentile — i.e. a working model ranked as the dumbest in the app.

test('a Cloudflare id finds the curated score published under its un-namespaced name', () => {
  // The scores were never missing; `scores.js` always held these under the vendor path.
  assert.equal(scores['qwen/qwq-32b'], 0.5)
  assert.equal(getScore('@cf/qwen/qwq-32b'), 0.5)
  assert.equal(getScore('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'), 0.439)
  assert.equal(getScore('@cf/qwen/qwen2.5-coder-32b-instruct'), 0.46)

  // The namespace-stripped spelling is a third key, never a replacement: routing and grouping
  // read `base`/`unprefixed`, so both must stay exactly what they were.
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').base, '@cf/qwen/qwq-32b')
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').unprefixed, 'qwq-32b')
  assert.equal(canonicalizeModelId('@cf/qwen/qwq-32b').unscoped, 'qwen/qwq-32b')
})

test('every curated score still resolves to itself', () => {
  // The guard on the lookup change: widening the candidate list must never re-point an
  // existing key at a different value.
  for (const [id, expected] of Object.entries(scores)) {
    assert.equal(getScore(id), expected, `getScore drifted for ${id}`)
  }
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
  assert.equal(getScore('qwen/qwq-32b'), 0.5)
  assert.equal(getScore('qwen/qwq-32b:free'), 0.5)
  assert.equal(getScore('meta-llama/llama-3.2-3b-instruct:free'), 0.106)
})

test('a family key ignores how deeply the catalog nests the name', () => {
  // The bug: one segment came off, so `meta` stayed and `meta llama 3 1 8b` never matched the
  // catalog's `llama 3 1 8b`. Depth has to stop mattering.
  assert.equal(
    modelFamilyKey('@cf/meta/llama-3.1-8b-instruct-fp8'),
    modelFamilyKey('meta-llama/llama-3.1-8b-instruct'),
  )
  assert.equal(modelFamilyKey('@cf/qwen/qwq-32b'), modelFamilyKey('qwen/qwq-32b'))
  assert.equal(modelFamilyKey('@cf/meta/llama-3.1-8b-instruct-fp8'), 'llama 3 1 8b')

  // `-lora` (adapter) and `-fast` (latency tier) name how the weights are served, not which
  // model they are, so they scrub with the quantization tags.
  assert.equal(
    modelFamilyKey('@cf/mistral/mistral-7b-instruct-v0.2-lora'),
    modelFamilyKey('mistralai/mistral-7b-instruct-v0.2'),
  )

  // Single-segment ids are unaffected by the leaf rule.
  assert.equal(modelFamilyKey('gpt-4o-mini'), 'gpt 4o mini')
  assert.equal(modelFamilyKey('codestral-latest'), 'codestral')
})

test('lookup keys reach the bare weights behind a serving suffix', () => {
  const keys = qualityLookupKeys('@cf/meta/llama-3.1-8b-instruct-fp8')
  assert.ok(keys.includes('llama-3.1-8b-instruct'), 'the de-quantized spelling must be offered')
  // The exact id still leads, so a catalog entry published under the provider's own spelling
  // keeps winning over a de-quantized match.
  assert.equal(keys[0], '@cf/meta/llama-3.1-8b-instruct-fp8')

  // Both halves of a two-token suffix come off, longest match first.
  assert.ok(
    qualityLookupKeys('@cf/meta/llama-3.3-70b-instruct-fp8-fast').includes(
      'llama-3.3-70b-instruct',
    ),
  )
})

test('a Cloudflare row resolves through the real resolver instead of the floor', () => {
  // The user-visible symptom: a model that answers gets a real intelligence number rather
  // than the AA floor that ranked it below everything else.
  const index = new Map([
    [
      'llama-3.1-8b-instruct',
      { score: 0.4, source: 'artificial-analysis', aa: 40, isEstimated: false },
    ],
  ])
  const quality = resolveModelQuality(
    { index, aaValues: [40] },
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  )
  assert.equal(quality.source, 'artificial-analysis')
  assert.equal(quality.aa, 40)
})
