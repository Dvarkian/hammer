import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractLMArenaEntries,
  fetchLMArenaBoards,
  LMARENA_BOARD_URLS,
  LMARENA_DATASET_URLS,
  MODEL_QUALITY_FLOOR_AA,
  modelFamilyKey,
  resolveModelQuality,
} from '../lib/model-quality.js'
import { resolveAliasedModelId } from '../sources.js'

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
        return jsonResponse({ rows: [{ row: { model_name: 'coding-model', rating: 1818, vote_count: 42 } }] })
      }
      if (url === LMARENA_DATASET_URLS.overall) {
        return jsonResponse({ rows: [{ row: { model_name: 'overall-model', rating: 1505, vote_count: 84 } }] })
      }
      throw new Error(`unexpected URL: ${url}`)
    },
  })

  assert.deepEqual(boards.coding, [{ displayName: 'coding-model', elo: 1818, votes: 42 }])
  assert.deepEqual(boards.overall, [{ displayName: 'overall-model', elo: 1505, votes: 84 }])
  assert.deepEqual(calls.sort(), [LMARENA_DATASET_URLS.coding, LMARENA_DATASET_URLS.overall].sort())
  assert.equal(calls.some(url => Object.values(LMARENA_BOARD_URLS).includes(url)), false)
})

test('the final quality fallback is an explicit 0.1 AA-scale score', () => {
  const quality = resolveModelQuality({ index: new Map(), aaValues: [] }, 'srv_unknown:made-up-model')
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
  const payload = JSON.stringify({ entries: [{
    modelDisplayName: 'page-model',
    rating: 1600,
    votes: 10,
  }] })
  assert.deepEqual(extractLMArenaEntries(payload), [{ displayName: 'page-model', elo: 1600, votes: 10 }])
})
