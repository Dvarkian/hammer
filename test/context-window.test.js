import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ALIAS_CONTEXT_WINDOW,
  hammerModelsConfig,
  routedCompactionReserve,
} from '../lib/pi/agent-dir.js'
import { DEFAULT_CONTEXT_WINDOW, effectiveContextWindow } from '../lib/pi/bridge.js'

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
