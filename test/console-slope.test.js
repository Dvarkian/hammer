import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SELECTOR_DEFAULT_PERCENT,
  selectModelBySlope,
  selectorSlopeCeiling,
  selectorSlopeForPercent,
} from '../lib/utils.js'
import {
  configureConsoleSlopeStore,
  consoleSlopePercent,
  consoleSlopeStorePath,
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

test('a conversation gets its own slope back after a restart', () => {
  // The value belongs to the conversation, not to the process: a restart used to reset every
  // composer to the exported default, which silently moved a conversation onto another model.
  resetConsoleSlopesForTests()
  const dir = mkdtempSync(join(tmpdir(), 'hammer-slopes-'))
  const path = consoleSlopeStorePath(dir)
  assert.equal(path, join(dir, 'console-slopes.json'))
  configureConsoleSlopeStore(path)
  assert.equal(registerConsoleSlope('7352'), SELECTOR_DEFAULT_PERCENT)
  assert.equal(setConsoleSlopePercent('7352', 19), 19)
  assert.equal(setConsoleSlopePercent('7352-f6a7fc43', 83), 83)

  // A restart is this module's memory going away while the file stays behind.
  resetConsoleSlopesForTests()
  configureConsoleSlopeStore(path)
  assert.equal(registerConsoleSlope('7352'), 19)
  assert.equal(registerConsoleSlope('7352-f6a7fc43'), 83)
  assert.equal(registerConsoleSlope('7352-unknown'), SELECTOR_DEFAULT_PERCENT)
  // A value chosen in this run still wins over the one on disk.
  assert.equal(setConsoleSlopePercent('7352', 60), 60)
  assert.equal(registerConsoleSlope('7352', 5), 60, 'registering never overwrites a choice')

  // Unusable content is ignored rather than crashing a console, and a value outside the range
  // comes back clamped to it.
  writeFileSync(path, JSON.stringify({ consoleSlopes: { 7352: 'wide open', '7352-other': 250 } }))
  resetConsoleSlopesForTests()
  configureConsoleSlopeStore(path)
  assert.equal(registerConsoleSlope('7352'), SELECTOR_DEFAULT_PERCENT)
  assert.equal(registerConsoleSlope('7352-other'), 100)

  // Nothing configured means nothing written: that is the mounted-test-console case.
  resetConsoleSlopesForTests()
  assert.equal(setConsoleSlopePercent('7352', 12), 12)
  rmSync(dir, { recursive: true, force: true })
})

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the slope control lives in the composer, not under the plot', () => {
  const html = read('public/index.html')
  assert.match(html, /id="hx-slope-slider"/)
  assert.match(html, /id="hx-slope-value"/)
  assert.doesNotMatch(html, /id="sel-slope-slider"/)
  assert.doesNotMatch(html, /id="sel-slope-value"/)
})

test('the slope popup plots the field the slider is choosing from', () => {
  const html = read('public/index.html')
  // The plot hangs off the slope control itself, so it can be positioned against it.
  assert.match(html, /class="hx-composer-thinking hx-composer-slope"/)
  assert.match(html, /id="hx-slope-pop"/)
  const harness = read('public/harness.js')
  assert.match(harness, /function collectSlopePlotPoints\(models\)/)
  assert.match(harness, /function slopePlotCeiling\(points\)/)
  assert.match(harness, /function renderSlopePlot\(percent\)/)
  assert.match(harness, /function showSlopePlot\(percent\)/)
  assert.match(harness, /function hideSlopePlot\(delayMs = 0\)/)
  // The line has to be the router's line, not a second scale invented for the picture.
  assert.match(harness, /const SLOPE_PLOT_REFERENCE_TOKENS = 500/)
  assert.match(harness, /const SLOPE_PLOT_HEADROOM = 1\.5/)
  // The field is every measured row; the line is lowered onto the ones the router would use.
  assert.match(harness, /row\.routingEligible/)
  assert.match(harness, /const field = routable\.length >= 2 \? routable : points/)
  assert.match(harness, /if \(!row \|\| row\.status === 'noauth'\) continue/)
  // Shown when the control is taken, and the drag repaints it.
  assert.match(harness, /addEventListener\('pointerdown', \(\) => showSlopePlot/)
  assert.match(harness, /if \(!\$\('hx-slope-pop'\)\?\.hidden\) renderSlopePlot/)
  const css = read('public/harness.css')
  assert.match(css, /\.hx-slope-pop \{/)
  assert.match(css, /\.hx-slope-dot-pick \{/)
  assert.match(css, /\.hx-slope-line \{/)
})

test('the slope line turns evenly to vertical instead of snapping at the top', () => {
  // The popup drew its line from the numeric slope. The axes are scaled independently, so on a
  // real catalogue that screen angle stayed near 45° right up to 99% and then took the vertical
  // special case at 100% in one slider step. The line's angle now advances with the track, and
  // it is clipped to the plot so a steep frame cannot run off the viewBox.
  const harness = read('public/harness.js')
  assert.match(harness, /const SLOPE_LINE_MAX_ANGLE_DEG = 89\.4/)
  assert.match(
    harness,
    /const screenAngle = \(clampedPct \/ 100\) \* \(\(SLOPE_LINE_MAX_ANGLE_DEG \* Math\.PI\) \/ 180\)/,
  )
  assert.match(harness, /function slopeLineSegment\(px, py, screenSlope, pad, plotW, plotH\)/)
  // The 340px panel hangs off an 88px control, so it is placed rather than left to CSS: on a
  // narrow window the CSS anchor put most of it past the side of the screen.
  assert.match(harness, /function placeSlopePlot\(\)/)
  assert.match(
    harness,
    /const left = Math\.max\(margin, Math\.min\(preferred, window\.innerWidth - width - margin\)\)/,
  )
  assert.match(harness, /window\.addEventListener\('resize', \(\) => placeSlopePlot\(\)\)/)
  assert.match(harness, /pop\.hidden = false\n\s*placeSlopePlot\(\)/)
  // A contour of `intelligence + slope × speed` falls as speed rises: on screen that is
  // y *increasing* with x. Drawing it the other way put the line above the rows it was
  // supposed to lean over.
  assert.match(harness, /y1: py \+ screenSlope \* tMin/)
  assert.match(harness, /y2: py \+ screenSlope \* tMax/)
  assert.doesNotMatch(harness, /y1: py - screenSlope \* tMin/)
  assert.doesNotMatch(harness, /const atMax = percent >= 100/)
})

test('the composer saves the slope for its own conversation', () => {
  const harness = read('public/harness.js')
  assert.match(harness, /function setSlopePercent\(percent\)/)
  assert.match(harness, /consoleApi\(ctx, '\/slope'\)/)
  assert.match(harness, /paintSlopePercent\(data\.slopePercent\)/)
  // The slope is a model choice, so its answer carries the pick: the composer's model strip
  // and the quota rail name the new model at once instead of waiting for the next answer.
  const piRoute = read('lib/http/routes/pi.js')
  assert.match(piRoute, /routedModel: routedSelection\(percent\)/)
  assert.match(harness, /const key = routedModelKey\(data\.routedModel\)/)
  assert.match(harness, /ctx\.answeredModel = null/)
  assert.match(harness, /paintModelLabel\(ctx, ctx\.status\?\.model\)\n\s*renderQuota\(ctx\)/)
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
