import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractOpenRouterModelRecords, toOpenRouterModelMeta, toOpenAICompatibleDiscoveredModelMeta } from '../lib/server.js'
import { getLatestModelFamilyKey, getModelIdentityKey, getScore, isSameModelIdentity, resolveAliasedModelId, canonicalizeModelId } from '../sources.js'

describe('OpenRouter model discovery', () => {
  it('extracts records from various payload shapes', () => {
    assert.deepEqual(extractOpenRouterModelRecords(null), [])
    assert.deepEqual(extractOpenRouterModelRecords({}), [])
    assert.deepEqual(extractOpenRouterModelRecords([]), [])
    
    const data = [{ id: 'a' }, { id: 'b' }]
    assert.deepEqual(extractOpenRouterModelRecords(data), data)
    assert.deepEqual(extractOpenRouterModelRecords({ data }), data)
  })

  it('converts records to model meta, filtering for free models', () => {
    const freeRecord = {
      id: 'google/gemma-7b-it:free',
      name: 'Gemma 7B IT (free)',
      context_length: 8192
    }
    const paidRecord = {
      id: 'openai/gpt-4o',
      name: 'GPT-4o'
    }

    const freeMeta = toOpenRouterModelMeta(freeRecord)
    assert.ok(freeMeta)
    assert.equal(freeMeta.modelId, 'google/gemma-7b-it:free')
    assert.equal(freeMeta.label, 'Gemma 7B IT')
    assert.equal(freeMeta.ctx, '8192')
    assert.equal(freeMeta.ctxSource, 'provider-reported')
    assert.equal(freeMeta.providerKey, 'openrouter')

    const paidMeta = toOpenRouterModelMeta(paidRecord)
    assert.equal(paidMeta, null)
  })

  it('cleans model labels by removing lab prefix and (free) suffix', () => {
    const record = {
      id: 'google/gemma-7b-it:free',
      name: 'Google: Gemma 7B IT (free)',
      context_length: 8192
    }
    const meta = toOpenRouterModelMeta(record)
    assert.equal(meta.label, 'Gemma 7B IT')

    assert.equal(toOpenRouterModelMeta({ id: 'a:free', name: 'Meta: Llama 3 (free)' }).label, 'Llama 3')
    assert.equal(toOpenRouterModelMeta({ id: 'b:free', name: 'Mistral: Mistral 7B free' }).label, 'Mistral 7B')
    assert.equal(toOpenRouterModelMeta({ id: 'c:free', name: 'Giga Potato' }).label, 'Giga Potato')
  })

  it('handles missing or malformed fields in records', () => {
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).label, 'only-id:free')
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).ctx, null)
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).ctxSource, null)
  })
})

describe('g4f OpenAI-compatible discovery', () => {
  it('resolves common Claude gateway ids to curated intelligence scores', () => {
    assert.equal(resolveAliasedModelId('srv_abc123:anthropic/claude-sonnet-4-5'), 'claude-sonnet-4.5')
    assert.equal(resolveAliasedModelId('srv_abc123:anthropic/claude-haiku-4-5'), 'claude-haiku-4.5')
    assert.equal(getScore('srv_abc123:anthropic/claude-sonnet-4-5'), 0.772)
    assert.equal(getScore('srv_abc123:anthropic/claude-haiku-4-5'), 0.733)
  })

  it('resolves g4f Grok repo spellings to curated intelligence scores', () => {
    // Only grok-code-fast-1 was seeded, so every Grok 4 Fast row scored as
    // unknown even though the family is well known. Wire ids use dotted-vs-
    // hyphenated versions and backend repo prefixes (xai-z/, tb/).
    assert.equal(resolveAliasedModelId('srv_mtsj8uzo97d3c0d49960:xai-z/grok-4-fast-non-reasoning'), 'grok-4-fast-non-reasoning')
    assert.equal(resolveAliasedModelId('srv_msjkstt04622bf04c675:tb/grok-4-fast'), 'grok-4-fast')
    assert.equal(resolveAliasedModelId('srv_mtsj8uzo97d3c0d49960:xai-z/grok-4-1-fast-non-reasoning'), 'grok-4.1-fast-non-reasoning')
    assert.equal(getScore('srv_msjkstt04622bf04c675:tb/grok-4-fast'), 0.70)
    assert.equal(getScore('srv_mtsj8uzo97d3c0d49960:xai-z/grok-4-fast-non-reasoning'), 0.64)
    assert.equal(getScore('srv_mtsj8uzo97d3c0d49960:xai-z/grok-4-1-fast-non-reasoning'), 0.68)
    assert.equal(getScore('xai-z/grok-4-1-fast'), 0.74)
  })

  it('sees through the per-server routing namespace for identity, scores, and labels', () => {
    assert.equal(resolveAliasedModelId('srv_abc123:zai-z/zai-org-glm-5-3-flash'), 'glm-5.3-flash')
    assert.equal(getScore('srv_abc123:nvidia/nemotron-3-super-120b-a12b'), getScore('nvidia/nemotron-3-super-120b-a12b'))
    assert.equal(canonicalizeModelId('srv_abc123:z-ai/glm5').unprefixed, 'glm5')
  })

  it('normalizes Latest family names independently of provider prefixes', () => {
    assert.equal(getLatestModelFamilyKey('models/gemini-flash-latest'), 'gemini flash')
    assert.equal(getLatestModelFamilyKey('google/gemini-3.8-flash'), 'gemini flash')
    assert.equal(getLatestModelFamilyKey('srv_abc123:google/gemini-3.8-flash:free'), 'gemini flash')
  })

  it('maps namespaced and repo-spelled ids onto the shared catalog model', () => {
    // g4f discovery namespaces ids per backend server and backends spell model
    // names their own way (zai-z/zai-org-glm-5-3-flash). The row keeps the
    // namespaced routing id upstream, but its label and score come from the
    // shared catalog entry — that is what makes every provider share one row.
    const namespaced = toOpenAICompatibleDiscoveredModelMeta(
      { id: 'srv_mtsj8uzo:zai-z/zai-org-glm-5-3-flash' }, 'g4f')
    assert.ok(namespaced)
    assert.equal(namespaced.modelId, 'srv_mtsj8uzo:zai-z/zai-org-glm-5-3-flash')
    assert.equal(namespaced.label, 'GLM 5.3 Flash')

    const bare = toOpenAICompatibleDiscoveredModelMeta(
      { id: 'zai-z/zai-org-glm-5-3-flash' }, 'g4f')
    assert.ok(bare)
    assert.equal(bare.label, 'GLM 5.3 Flash')
  })
})

describe('model identity grouping', () => {
  it('collapses provider spellings of one model to a single identity', () => {
    // The table must show one row per model, whatever spelling each backend uses.
    assert.equal(getModelIdentityKey('qwen/qwen3.8-27b'), 'qwen3827b')
    assert.equal(getModelIdentityKey('qwen-3.8-27b'), 'qwen3827b')
    assert.equal(getModelIdentityKey('srv_mkom688d57c76d8a3542:qwen/qwen3.8-27b'), 'qwen3827b')
    assert.equal(getModelIdentityKey('@cf/qwen/qwen3.8-27b'), 'qwen3827b')

    assert.ok(isSameModelIdentity('qwen/qwen3.8-27b', 'qwen-3.8-27b'))
    // Size-qualified aliases: g4f/long-form ids vs the short catalogue name.
    assert.ok(isSameModelIdentity('nemotron-3-super', 'nvidia/nemotron-3-super-120b-a12b'))
    assert.ok(isSameModelIdentity('nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3.5-lightning'))
    assert.ok(isSameModelIdentity('srv_mt4quyfw26b0a700926a:nemotron-3.5-lightning-30b', 'nvidia/nemotron-3.5-lightning-30b-a3b'))
    assert.ok(isSameModelIdentity('nemotron-3-nano:30b', 'srv_mrgykg8eea645e7bb006:nemotron-3-nano:30b'))
    assert.ok(isSameModelIdentity('nemotron-3-ultra', 'nvidia/nemotron-3-ultra-550b-a55b'))
  })

  it('keeps genuinely different siblings under separate headings', () => {
    assert.equal(isSameModelIdentity('qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'), false)
    assert.equal(isSameModelIdentity('qwen3.8-flash', 'qwen3.8-27b'), false)
    // Two sizes of one instruct family are different models, not aliases.
    assert.equal(isSameModelIdentity('nvidia/llama-3.1-nemotron-51b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'), false)
    // A ':' size tag (ollama) is meaningful, so 3b and 8b stay apart.
    assert.equal(isSameModelIdentity('ministral-3:3b', 'ministral-3:8b'), false)
    // Omni/reasoning variants and 'extended' context are distinct models.
    assert.equal(isSameModelIdentity('nemotron-3-nano-omni-30b-a3b-reasoning', 'nemotron-3-nano:30b'), false)
    assert.equal(isSameModelIdentity('nvidia/nemotron-3-super-120b-extended', 'nvidia/nemotron-3-super-120b-a12b'), false)
  })
})
