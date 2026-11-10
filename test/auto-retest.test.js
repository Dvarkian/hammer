import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')

// ── Automatic re-tests ───────────────────────────────────────────────────────────────────
//
// A rate limit is the provider saying "later". The clock beside the Test button is the
// dashboard answering that: every row carrying a rate-limited or overloaded verdict is queued
// for another test, one at a time, and the countdown says when.
//
// The scheduler used to require the row to sit on the Intelligence-vs-Speed hull. A benched row
// is never on that hull — the hull is built from the rows that are still routable — so the
// queue was empty on every refresh and the feature never ran.

test('every waiting row is scheduled, not only the ones on the plot line', () => {
  const schedule = dashboard.match(/function scheduleAutomaticRetests\(\)[\s\S]*?\n {4}\}\n/)
  assert.ok(schedule, 'scheduleAutomaticRetests is defined')
  const body = schedule[0]
  // The queue is built from the whole snapshot...
  assert.match(body, /for \(const m of allModels\)/)
  assert.doesNotMatch(body, /const targets = rows\.filter/)
  // ...and the verdict is the qualifier, not hull membership.
  assert.match(body, /AUTO_RETEST_VERDICTS\.has\(rowVerdict\(m\)\)/)
  assert.match(body, /if \(!m \|\| m\.hasAuth === false\) continue/)
})

test('plotted rows go to the front of the queue', () => {
  assert.match(dashboard, /const plotted = new Set\(rows\.map\(r => getModelRowKey\(r\.m\)\)\)/)
  assert.match(dashboard, /targets\.push\(\{ key, rank: plotted\.has\(key\) \? 0 : 1 \}\)/)
  assert.match(dashboard, /targets\.sort\(\(a, b\) => a\.rank - b\.rank\)/)
  // Nothing in the queue depends on the hull helper: a benched row is never on the hull.
  const schedule = dashboard.match(/function scheduleAutomaticRetests\(\)[\s\S]*?\n {4}\}\n/)
  assert.ok(schedule, 'scheduleAutomaticRetests is defined')
  assert.doesNotMatch(schedule[0], /slopeSelectableRowKeys/)
})

test('only verdicts a retry can change are queued', () => {
  assert.match(
    dashboard,
    /const AUTO_RETEST_VERDICTS = new Set\(\['rate-limited', 'overloaded'\]\)/,
  )
  // Paid, dead, incompatible and unauthorised rows have no window to wait on.
  assert.doesNotMatch(dashboard, /AUTO_RETEST_VERDICTS = new Set\(\[[^\]]*\b(paid|dead|noauth)\b/)
})

test('retries are paced, staggered and never overlap a manual test', () => {
  assert.match(dashboard, /const AUTO_RETEST_INTERVAL_MS = 60_000/)
  assert.match(dashboard, /const AUTO_RETEST_GAP_MS = 4_000/)
  assert.match(dashboard, /const slot = AUTO_RETEST_INTERVAL_MS \/ Math\.max\(1, targets\.length\)/)
  assert.match(dashboard, /if \(autoRetestBusy \|\| testAllRunning\) return/)
  assert.match(dashboard, /autoRetestAt\.set\(rowKey, now \+ AUTO_RETEST_INTERVAL_MS\)/)
  // The next slot is claimed before the request, and the gap spaces the starts out.
  assert.match(dashboard, /setTimeout\(\(\) => runDueAutomaticRetest\(\), AUTO_RETEST_GAP_MS\)/)
})

test('the wait is drawn beside the Test button and ticks every second', () => {
  assert.match(dashboard, /function autoRetestNote\(rowKey\)/)
  assert.match(dashboard, /class="test-retry"/)
  assert.match(dashboard, /testing in \$\{Math\.ceil\(ms \/ 1000\)\}s/)
  assert.match(dashboard, /testing shortly…/)
  assert.match(dashboard, /function groupAutoRetestAt\(groupKey\)/)
  // The ticker is the trigger as well as the readout: a row due between polls still runs.
  assert.match(
    dashboard,
    /setInterval\(\(\) => \{\n {6}updateAutoRetestNotes\(\);\n {6}runDueAutomaticRetest\(\);/,
  )
  assert.match(css, /\.test-retry \{/)
})

test('a waiting row in a collapsed group is still tested', () => {
  assert.match(dashboard, /async function autoRetestRequest\(model\)/)
  assert.match(dashboard, /fetch\('\/api\/test-model', \{/)
  assert.match(
    dashboard,
    /const work = button\n {8}\? testModelButton\(button, \{ rowKey, providerKey: model\.providerKey, modelId: model\.modelId \}\)\n {8}: autoRetestRequest\(model\);/,
  )
})

test('the queue is rebuilt after every snapshot', () => {
  assert.match(
    dashboard,
    /scheduleContradictoryRetests\(\);\n {8}\/\/ Rows waiting on a provider window get their own clock: one retry a minute, staggered\.\n {8}scheduleAutomaticRetests\(\);/,
  )
})
