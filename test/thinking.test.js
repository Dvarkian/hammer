// @ts-check
/**
 * Thinking effort, and what each provider is actually sent.
 *
 * The rules worth pinning are the ones that decide whether a request *works*: the level a
 * caller asks for wins over the configured default, a model with no reasoning mode never sees
 * the field, and a wire Hammer builds itself is never handed an OpenAI parameter. The
 * translation table itself is data; these tests read it through the public functions so a
 * family can be added without rewriting them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  THINKING_LEVELS,
  applyThinkingLevel,
  canonicalModelName,
  modelTakesThinking,
  normalizeThinkingLevel,
  resolveThinkingLevel,
  thinkingStyleFor,
} from '../lib/thinking.js'

test('the vocabulary absorbs the spellings clients actually send', () => {
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high'])
  for (const off of ['off', 'none', 'false', '0', 'disabled', false]) {
    assert.equal(normalizeThinkingLevel(off), 'off', String(off))
  }
  assert.equal(normalizeThinkingLevel(' MINIMAL '), 'minimal')
  assert.equal(normalizeThinkingLevel('med'), 'medium')
  for (const high of ['high', 'max', 'xhigh', 'maximum', 'extra']) {
    assert.equal(normalizeThinkingLevel(high), 'high', high)
  }
  // A numeric scale is a client's own: 0 is off, 3 is as hard as it gets.
  assert.equal(normalizeThinkingLevel(0), 'off')
  assert.equal(normalizeThinkingLevel(1), 'low')
  assert.equal(normalizeThinkingLevel(2), 'medium')
  assert.equal(normalizeThinkingLevel(9), 'high')
  // Anything else is not a level, and must not be forwarded as though it were.
  assert.equal(normalizeThinkingLevel('turbo'), null)
  assert.equal(normalizeThinkingLevel(''), null)
  assert.equal(normalizeThinkingLevel(null), null)
})

test('the caller level wins over the configured default', () => {
  // The agent sends `reasoning_effort`; a client written against OpenRouter sends
  // `reasoning.effort`. Both are the same instruction.
  assert.equal(resolveThinkingLevel({ reasoning_effort: 'high' }, 'low'), 'high')
  assert.equal(resolveThinkingLevel({ reasoning: { effort: 'minimal' } }, 'high'), 'minimal')
  // Silence falls back to the default, and silence everywhere means "do not touch the body".
  assert.equal(resolveThinkingLevel({}, 'medium'), 'medium')
  assert.equal(resolveThinkingLevel({}, null), null)
  assert.equal(resolveThinkingLevel(null), null)
  // An unrecognized value is not an instruction: the default still applies.
  assert.equal(resolveThinkingLevel({ reasoning_effort: 'turbo' }, 'low'), 'low')
})

test('model names canonicalize across provider prefixes, tags and snapshots', () => {
  assert.equal(canonicalModelName('openai/gpt-5-mini-2024-08-06'), 'gpt-5-mini')
  assert.equal(canonicalModelName('z-ai/glm-4.6:free'), 'glm-4.6')
  assert.equal(canonicalModelName('deepseek-ai/DeepSeek-R1'), 'deepseek-r1')
  assert.equal(
    canonicalModelName('qwen/qwen3-coder-480b-a35b-instruct'),
    'qwen3-coder-480b-a35b-instruct',
  )
  assert.equal(canonicalModelName(''), '')
})

test('only families that reason are offered a level', () => {
  for (const model of [
    'openai/gpt-5',
    'gpt-oss-120b',
    'o3-mini',
    'deepseek-r1-distill-llama-70b',
    'deepseek-r1',
    'qwen3-32b',
    'qwen/qwq-32b',
    'kimi-k2-thinking',
    'glm-4.6',
    'gemini-2.5-pro',
    'grok-4',
    'minimax-m2',
    'magistral-small-2506',
  ]) {
    assert.equal(modelTakesThinking(model), true, model)
  }
  for (const model of [
    'llama-3.3-70b-versatile',
    'meta/llama-4-maverick-17b-128e-instruct',
    'qwen2.5-coder-32b-instruct',
    'mistral-large-675b-instruct',
    'gemini-1.5-pro',
    'gpt-4o',
    'gpt-4.1',
    'kimi-k2-instruct',
    'glm-4',
    'phi-4-mini-instruct',
  ]) {
    assert.equal(modelTakesThinking(model), false, model)
  }
  assert.equal(modelTakesThinking(''), false, 'an unknown model is a plain chat model')
})

test('an OpenAI-compatible model gets reasoning_effort, in the word it accepts', () => {
  const body = { model: 'openai/gpt-5', messages: [] }
  const applied = applyThinkingLevel('nvidia', body, 'minimal', 'openai/gpt-5')
  assert.equal(applied.applied, true)
  assert.equal(applied.body.reasoning_effort, 'minimal')
  assert.equal(applied.style, 'effort')

  // `minimal` is an OpenAI reasoning step; everywhere else the quietest real setting is low.
  const qwen = applyThinkingLevel('groq', body, 'minimal', 'qwen3-32b')
  assert.equal(qwen.body.reasoning_effort, 'low')

  // The input body is never mutated: the proxy rebuilds one per candidate model.
  assert.equal('reasoning_effort' in body, false)

  // The model is usually the body's own, when the caller did not pass one separately.
  const fromBody = applyThinkingLevel('groq', { model: 'qwen3-32b' }, 'high')
  assert.equal(fromBody.body.reasoning_effort, 'high')
})

test('OpenRouter gets the object form it documents', () => {
  const applied = applyThinkingLevel(
    'openrouter',
    { model: 'qwen/qwen3-coder:free' },
    'medium',
    'qwen/qwen3-coder:free',
  )
  assert.equal(applied.style, 'openrouter')
  assert.deepEqual(applied.body.reasoning, { effort: 'medium' })
  assert.equal('reasoning_effort' in applied.body, false)
})

test('a model with no reasoning mode never receives the field', () => {
  // The agent sends `reasoning_effort` on every turn; routing one of those to a plain chat
  // model used to spend a 400 on it. The field is removed, and the request is left valid.
  const applied = applyThinkingLevel(
    'groq',
    { model: 'llama-3.3-70b-versatile', reasoning_effort: 'high', messages: [] },
    'high',
    'llama-3.3-70b-versatile',
  )
  assert.equal(applied.applied, false)
  assert.match(String(applied.reason), /no reasoning mode/)
  assert.equal('reasoning_effort' in applied.body, false)
  assert.deepEqual(applied.body.messages, [])
})

test('off removes the field rather than sending the word', () => {
  const applied = applyThinkingLevel(
    'nvidia',
    { model: 'deepseek-r1', reasoning_effort: 'high' },
    'off',
    'deepseek-r1',
  )
  assert.equal(applied.applied, false)
  assert.equal('reasoning_effort' in applied.body, false)

  // An empty OpenRouter reasoning object is noise, so it goes as well.
  const openrouter = applyThinkingLevel(
    'openrouter',
    { model: 'qwen/qwen3-coder:free', reasoning: { effort: 'high' } },
    'off',
    'qwen/qwen3-coder:free',
  )
  assert.equal('reasoning' in openrouter.body, false)
})

test('a wire hammer builds itself is never handed an OpenAI parameter', () => {
  for (const providerKey of ['kiro', 'devin', 'gptfree', 'nlpcloud', 'openai-codex']) {
    assert.equal(thinkingStyleFor(providerKey), 'none', providerKey)
    const applied = applyThinkingLevel(
      providerKey,
      { model: 'swe-1.6', reasoning_effort: 'high' },
      'high',
      'swe-1.6',
    )
    assert.equal(applied.applied, false, providerKey)
    assert.equal('reasoning_effort' in applied.body, false, providerKey)
  }
  // Every OpenAI-compatible provider, including a bulk import, rides the one translation.
  for (const providerKey of ['nvidia', 'groq', 'googleai', 'cerebras', 'some-import']) {
    assert.equal(thinkingStyleFor(providerKey), 'effort', providerKey)
  }
})
