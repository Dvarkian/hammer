import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SELECTOR_DEFAULT_PERCENT,
  selectModelBySlope,
  selectorSlopeCeiling,
  selectorSlopeForPercent,
} from '../lib/utils.js'
import {
  consoleSlopePercent,
  listConsoleSlopes,
  registerConsoleSlope,
  resetConsoleSlopesForTests,
  setConsoleSlopePercent,
} from '../lib/pi/console-slope.js'

const rows = [
  { providerKey: 'a', modelId: 'smart', label: 'Smart', status: 'up', aa: 90, ttft: 900, tps: 40 },
  { providerKey: 'b', modelId: 'fast', label: 'Fast', status: 'up', aa: 55, ttft: 100, tps: 300 },
]

test('the slope ceiling is the intelligence spread over the speed spread', () => {
  const ceiling = selectorSlopeCeiling(rows)
  assert.equal(typeof ceiling, 'number')
  assert.ok(ceiling > 0)
  assert.equal(selectorSlopeCeiling([rows[0]]), null, 'one row spans no range')
  assert.equal(selectorSlopeCeiling([]), null)
  assert.equal(selectorSlopeCeiling(undefined), null)
})

test('a percentage of the ceiling is the absolute slope routing takes', () => {
  const ceiling = selectorSlopeCeiling(rows)
  assert.equal(selectorSlopeForPercent(0, rows), 0)
  assert.equal(selectorSlopeForPercent(50, rows), ceiling / 2)
  assert.equal(selectorSlopeForPercent('100', rows), ceiling)
  assert.equal(selectorSlopeForPercent(-1, rows), null)
  assert.equal(selectorSlopeForPercent('wide open', rows), null)
  assert.equal(selectorSlopeForPercent(250, rows), ceiling, 'clamped to the ceiling')
  assert.equal(selectorSlopeForPercent(SELECTOR_DEFAULT_PERCENT, rows), ceiling * 0.04)
})

test('0% picks the smartest row and 100% the fastest', () => {
  const smart = selectModelBySlope(rows, { slope: 0 })
  assert.equal(smart.model.modelId, 'smart')
  const fast = selectModelBySlope(rows, { slope: selectorSlopeForPercent(100, rows) })
  assert.equal(fast.model.modelId, 'fast')
})

test('every console starts at the exported default and keeps its own value', () => {
  resetConsoleSlopesForTests()
  assert.equal(consoleSlopePercent('7352'), null, 'an unknown conversation has no slope')
  assert.equal(registerConsoleSlope('7352'), SELECTOR_DEFAULT_PERCENT)
  assert.equal(setConsoleSlopePercent('7352', 37), 37)
  assert.equal(registerConsoleSlope('7352', 90), 37, 'registering never overwrites a choice')
  assert.equal(consoleSlopePercent('7352'), 37)
  assert.equal(registerConsoleSlope('7352-abc123'), SELECTOR_DEFAULT_PERCENT)
  assert.deepEqual(listConsoleSlopes(), [
    { consoleKey: '7352', percent: 37 },
    { consoleKey: '7352-abc123', percent: SELECTOR_DEFAULT_PERCENT },
  ])
  assert.equal(setConsoleSlopePercent('7352', -5), null)
  assert.equal(setConsoleSlopePercent('', 10), null)
  resetConsoleSlopesForTests()
  assert.deepEqual(listConsoleSlopes(), [])
})

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the slope control lives in the composer, not under the plot', () => {
  const html = read('public/index.html')
  assert.match(html, /id="hx-slope-slider"/)
  assert.match(html, /id="hx-slope-value"/)
  assert.doesNotMatch(html, /id="sel-slope-slider"/)
  assert.doesNotMatch(html, /id="sel-slope-value"/)
})

test('the composer saves the slope for its own conversation', () => {
  const harness = read('public/harness.js')
  assert.match(harness, /function setSlopePercent\(percent\)/)
  assert.match(harness, /consoleApi\(ctx, '\/slope'\)/)
  assert.match(harness, /paintSlopePercent\(data\.slopePercent\)/)
})

test("routing reads the slope of the request's conversation", () => {
  const proxy = read('lib/http/routes/proxy.js')
  assert.match(
    proxy,
    /const requestSlopePercent =\s*\n?\s*consoleSlopePercent\(req\.get\('x-hammer-pi-console'\)\)/,
  )
  assert.match(proxy, /selectorSlopeForPercent\(requestSlopePercent, pool\)/)
  assert.doesNotMatch(proxy, /selectorSlopeOf\(/)
  const models = read('lib/http/routes/models.js')
  assert.match(models, /SELECTOR_DEFAULT_PERCENT/)
  assert.match(models, /activePicks,/)
  assert.match(models, /listConsoleSlopes\(\)/)
  const pi = read('lib/http/routes/pi.js')
  assert.match(pi, /app\.post\(`\$\{base\}\/slope`/)
  assert.match(pi, /slopePercent: consoleSlopePercent/)
})
