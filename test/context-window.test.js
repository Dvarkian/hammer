import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ALIAS_CONTEXT_WINDOW,
  hammerModelsConfig,
  routedCompactionReserve,
} from '../lib/pi/agent-dir.js'
import { DEFAULT_CONTEXT_WINDOW, effectiveContextWindow } from '../lib/pi/bridge.js'
import {
  accumulateContextObservation,
  accumulateUsageSample,
  deriveContextState,
} from '../lib/utils.js'

test('the prompt preflight and the meter read the same conversation’s pick', () => {
  // The bridge meters and compacts against `routedSelection(consoleSlopePercent(key))`, and
  // /status reports the same. The prompt preflight used `routedSelection()` — the exported
  // default slope — so a conversation at 55% was measured against a different model than the
  // one on its meter: a 113k row compacted near 31k because the default pick carried a
  // learned 47k bound. One conversation must have one budget.
  const routes = readFileSync(new URL('../lib/http/routes/pi.js', import.meta.url), 'utf8')
  // The selection is read once so the window and its kind (context window or prompt cap)
  // cannot come from two different picks.
  assert.match(
    routes,
    /const routedPick = routedSelection\(\s*consoleSlopePercent\(console\.bridge\.consoleKey\),?\s*\)/,
  )
  assert.match(routes, /const routedWindow = routedPick\?\.contextTokens/)
  assert.match(routes, /const routedPromptCap = routedPick\?\.contextPromptCap === true/)
  assert.doesNotMatch(routes, /routedWindow: routedSelection\(\)\?\.contextTokens/)
})

test('a routed budget reserves room for the reply, and only drift against a prompt cap', () => {
  // A real total window has to leave the reply room; Pi's default is capped at a quarter of a
  // small one so it cannot compact a 25.6k model at 9.3k.
  assert.equal(routedCompactionReserve(25_639), 6_409)
  assert.equal(routedCompactionReserve(131_072), 16_384)
  // A prompt cap does not include the reply, so only a small drift margin is needed.
  assert.equal(routedCompactionReserve(25_639, null, { promptCap: true }), 1_281)
  // An explicit reserve is the user's number, whatever the window's kind.
  assert.equal(routedCompactionReserve(25_639, 16_384, { promptCap: true }), 16_384)
})

test("the routed row's window is the budget, whether it is smaller or larger than the declaration", () => {
  assert.equal(
    effectiveContextWindow({ piWindow: ALIAS_CONTEXT_WINDOW, routedWindow: 200000 }),
    200000,
  )
  assert.equal(
    effectiveContextWindow({ piWindow: ALIAS_CONTEXT_WINDOW, routedWindow: 262144 }),
    262144,
  )
  // The route wins even over a declaration still in memory from an older start: a running Pi
  // that was launched before the alias changed must not keep compacting at the old wall.
  assert.equal(effectiveContextWindow({ piWindow: 131072, routedWindow: 200000 }), 200000)
})

test('a prompt cap is drawn as a prompt cap, not as an overrun', () => {
  // OrcaRouter's free tiers cap the prompt, and Pi's context figure is the prompt *plus* the
  // reply. Comparing the two said "31k of 26k · 5.5k over" about a conversation the model was
  // answering, with the overshoot equal to the reply it had just written.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(
    harness,
    /function routedPromptCap\(ctx\) \{\s*return ctx\?\.routedModel\?\.contextPromptCap === true/,
  )
  assert.match(harness, /const over = measured && !promptCap && used > window_/)
  assert.match(harness, /in context · prompt caps at \$\{compact\(window_\)\}/)
  assert.match(
    harness,
    /renderContext\(bar, usage, compact, fallbackWindow, fallbackExact, fallbackPromptCap\)/,
  )
})

test('a success above an inferred ceiling lifts it instead of contradicting it', () => {
  // A refusal-derived bound is an inference, not a quoted limit. When the route answers a
  // larger request the inference has been disproved, and keeping it left the table on "<26k"
  // and the console on "over window" for that same conversation.
  const refused = accumulateContextObservation({}, { maxTokens: 25_639, exact: false })
  assert.equal(refused.contextMax, 25_639)
  // The runtime path: a successful turn's prompt is what raises `contextMin`.
  const accepted = accumulateUsageSample(refused, { promptTokens: 31_334 })
  assert.equal(accepted.contextMax, undefined)
  assert.equal(accepted.contextMin, 31_334)
  const state = deriveContextState(null, accepted)
  assert.ok(String(state.display).startsWith('>'), `expected a floor, got ${state.display}`)
  assert.equal(state.lowerBoundOnly, true)
  // The same rule holds when the observation carries the bound directly.
  assert.equal(accumulateContextObservation(refused, { minTokens: 31_334 }).contextMax, undefined)
  // A provider-stated maximum is a statement, not an inference, and is left standing.
  const stated = accumulateContextObservation({}, { maxTokens: 32_768, exact: true })
  assert.equal(accumulateUsageSample(stated, { promptTokens: 40_000 }).contextMax, 32_768)
})

test('a route that reports no window falls back to the conservative default', () => {
  assert.equal(effectiveContextWindow({ piWindow: ALIAS_CONTEXT_WINDOW }), DEFAULT_CONTEXT_WINDOW)
  assert.equal(effectiveContextWindow({}), DEFAULT_CONTEXT_WINDOW)
  assert.equal(effectiveContextWindow({ piWindow: null, routedWindow: 0 }), DEFAULT_CONTEXT_WINDOW)
  assert.equal(effectiveContextWindow({ piWindow: 65536 }), 65536)
})

test('the alias declares a ceiling rather than a model-sized wall', () => {
  const model = hammerModelsConfig('http://127.0.0.1:7352/v1').providers.hammer.models[0]
  assert.equal(model.contextWindow, ALIAS_CONTEXT_WINDOW)
  assert.ok(ALIAS_CONTEXT_WINDOW > 262144, 'no catalog row is capped by the declaration')
  const pinned = hammerModelsConfig('http://127.0.0.1:7352/v1', { contextWindow: 262144 })
  assert.equal(pinned.providers.hammer.models[0].contextWindow, 262144)
  const junk = hammerModelsConfig('http://127.0.0.1:7352/v1', { contextWindow: -5 })
  assert.equal(junk.providers.hammer.models[0].contextWindow, ALIAS_CONTEXT_WINDOW)
})

test('the bridge publishes the effective window, not the alias declaration', () => {
  const bridge = readFileSync(new URL('../lib/pi/bridge.js', import.meta.url), 'utf8')
  assert.match(bridge, /this\.piContextWindow = contextNumber\(context\.contextWindow\)/)
  assert.match(bridge, /const window = this\.effectiveWindow\(\)/)
  assert.doesNotMatch(bridge, /contextWindow: contextNumber\(context\.contextWindow\)/)
})

test('the console reads the routed window and the router compacts at it', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(harness, /const window_ = routedWindow \|\| measuredWindow/)
  // The note must use the current routed window, not the window Pi measured against at the
  // last message: after a fallback the old measurement can belong to the previous model.
  assert.match(harness, /const ceiling = window_/)
  assert.doesNotMatch(harness, /Math\.min\(\.\.\.limits\)/)
  // The server publishes the reserve in force; the page must not reconstruct it from the
  // launch setting and draw a different trigger than the one compaction uses.
  assert.match(harness, /const publishedReserve = Number\(status\?\.compactionReserve\)/)
  // A row that only proves ">2.3k" has a lower bound, not a context window. The table's
  // numeric token count must not become the meter's denominator in that case.
  assert.match(harness, /const max = Number\(row\?\.contextBound\?\.max\)/)
  assert.match(harness, /contextBound: row\.contextBound \|\| null/)
  assert.doesNotMatch(
    harness,
    /const known = Number\(row\?\.contextTokens\)\n\s*if \(Number\.isFinite\(known\) && known > 0\) return Math\.round\(known\)\n\s*const label/,
  )
})
