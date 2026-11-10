import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALIAS_CONTEXT_WINDOW, hammerModelsConfig } from '../lib/pi/agent-dir.js'
import { DEFAULT_CONTEXT_WINDOW, effectiveContextWindow } from '../lib/pi/bridge.js'

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
  assert.match(harness, /const window_ = routedWindow \|\| piWindow/)
  assert.match(harness, /const ceiling = limits\.length \? Math\.min\(\.\.\.limits\) : window_/)
})
