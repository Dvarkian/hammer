import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The console decides a model change by comparing the model names two answers recorded. An
 * alias-only answer used to be resolved to the row's display label while a named one recorded
 * the provider's id, so two answers from the same model read as a change:
 * "swe-2-flash-medium · Devin SWE" to "Devin SWE-2 Flash Medium".
 */
const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

test('an alias-only answer is named the same way a named answer is', () => {
  assert.match(
    harness,
    /const name = modelName\(routed\.modelId \|\| routed\.realModelId \|\| routed\.label\)/,
  )
  assert.doesNotMatch(
    harness,
    /modelName\(routed\.realModelLabel \|\| routed\.label \|\| routed\.modelId\)/,
  )
})

test('both station sites compare identities instead of strings', () => {
  assert.match(harness, /function sameAnswerIdentity\(ctx, left, right\)/)
  assert.equal((harness.match(/!sameAnswerIdentity\(ctx,/g) || []).length, 2)
  assert.doesNotMatch(harness, /previous !== model/)
  assert.doesNotMatch(harness, /previousModel !== model/)
})

test('the identity fold drops the free-tier marker and knows the route by every name', () => {
  assert.match(
    harness,
    /printableModelName\(value\)\.toLowerCase\(\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/,
  )
  assert.match(
    harness,
    /\[routed\.modelId, routed\.realModelId, routed\.label, routed\.realModelLabel\]/,
  )
})
