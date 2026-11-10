import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  selectModelBySlope,
  selectorSlopeForPercent,
  selectorSlopeNotchesPercent,
} from '../lib/utils.js'

const rows = [
  { providerKey: 'a', modelId: 'smart', label: 'Smart', status: 'up', aa: 90, ttft: 900, tps: 40 },
  { providerKey: 'b', modelId: 'fast', label: 'Fast', status: 'up', aa: 55, ttft: 100, tps: 300 },
]

test('one notch per selection region, inside the slider range', () => {
  const notches = selectorSlopeNotchesPercent(rows)
  // Two rows that both win somewhere give a region each. With only two rows the changeover is
  // the ceiling itself, so the faster row's region has no width to place a notch in; the smart
  // row's midpoint is the one a drag can land on.
  assert.ok(notches.length >= 1, 'a changeover gives the slider something to notch')
  assert.deepEqual(
    notches.slice().sort((a, b) => a - b),
    notches,
    'notches come back in slider order',
  )
  for (const notch of notches) assert.ok(notch >= 0 && notch <= 100, `notch ${notch} is in range`)
  // A real catalog has many rows and many regions; three of them give more than two notches.
  const many = selectorSlopeNotchesPercent([
    ...rows,
    { providerKey: 'c', modelId: 'mid', label: 'Mid', status: 'up', aa: 75, ttft: 250, tps: 160 },
  ])
  assert.ok(many.length > notches.length, 'each new region adds a notch')
})

test('a row that never wins contributes no notch', () => {
  const dominated = [
    ...rows,
    { providerKey: 'c', modelId: 'weak', label: 'Weak', status: 'up', aa: 40, ttft: 9000, tps: 5 },
  ]
  const notches = selectorSlopeNotchesPercent(dominated)
  assert.ok(notches.length > 0, 'the slider still has regions to notch')
  // The weak row is slower and dumber than both others, so no notch may land on it: a notch is
  // a place a drag can stop, and stopping there would select a model the router never picks.
  for (const percent of notches) {
    const pick = selectModelBySlope(dominated, {
      slope: selectorSlopeForPercent(percent, dominated),
    })
    assert.notEqual(pick.model.modelId, 'weak', `no notch at ${percent}% selects the weak row`)
  }
  assert.deepEqual(selectorSlopeNotchesPercent([rows[0]]), [], 'one row has no handoff')
  assert.deepEqual(selectorSlopeNotchesPercent([]), [])
})

test('the ceiling and the notches agree on the same scale', () => {
  const ceiling = selectorSlopeForPercent(100, rows)
  assert.ok(ceiling > 0)
  assert.equal(selectorSlopeForPercent(0, rows), 0)
  assert.deepEqual(selectorSlopeNotchesPercent(rows), selectorSlopeNotchesPercent(rows))
})

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the models payload carries the notches for the composer', () => {
  const models = read('lib/http/routes/models.js')
  assert.match(models, /notchesPercent: selectorSlopeNotchesPercent\(ctx\.results\)/)
  const harness = read('public/harness.js')
  assert.match(harness, /data\.selector\?\.notchesPercent/)
  assert.match(harness, /function paintSlopeNotches\(\)/)
  assert.match(harness, /setProperty\(\s*'--slope-notches'/)
  const css = read('public/harness.css')
  assert.match(
    css,
    /#hx-slope-slider::-webkit-slider-runnable-track \{[\s\S]*?var\(--slope-notches, none\)/,
  )
  // The four-step ticks belong to the thinking control and must not draw on the slope slider.
  assert.match(css, /\.hx-composer-thinking #hx-thinking-slider::-webkit-slider-runnable-track/)
  assert.doesNotMatch(
    css,
    /\.hx-composer-thinking input\[type=range\]::-webkit-slider-runnable-track/,
  )
})

test('the console reports the model its own slope resolves to', () => {
  const pi = read('lib/http/routes/pi.js')
  assert.match(
    pi,
    /routedModel: routedSelection\(consoleSlopePercent\(console\.bridge\.consoleKey\)\)/,
  )
  assert.match(pi, /routedSelection\(consoleSlopePercent\(key\)\)/)
  assert.match(pi, /ctx\.routedSelection\(percent\)/)
  const server = read('lib/server.js')
  assert.match(server, /const routedSelectionForConsole = \(percent = SELECTOR_DEFAULT_PERCENT\)/)
  assert.match(server, /const slope = selectorSlopeForPercent\(percent, results\)/)
})
