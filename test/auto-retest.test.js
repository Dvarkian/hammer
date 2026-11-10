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
  // At least a minute between any two automatic starts. The floor used to be four seconds,
  // which let a bench of twenty waiting rows fire inside a single tick and knocked on a
  // provider that was already refusing traffic; the retest is meant to notice a window
  // reopening, so one automatic test a minute is the whole budget.
  assert.match(dashboard, /const AUTO_RETEST_GAP_MS = 60_000/)
  const gap = dashboard.match(/const AUTO_RETEST_GAP_MS = ([\d_]+)/)
  assert.ok(gap, 'the automatic-start floor is stated once')
  assert.ok(Number(gap[1].replace(/_/g, '')) >= 60_000, 'the floor is at least a minute')
  // The floor is measured from the last start, not from the end of the last request, so a
  // scheduler call from a snapshot or the ticker cannot squeeze a second start in.
  assert.match(
    dashboard,
    /if \(lastAutoRetestStartedAt && now - lastAutoRetestStartedAt < AUTO_RETEST_GAP_MS\) return/,
  )
  assert.match(dashboard, /lastAutoRetestStartedAt = now/)
  // The queue is what the schedule is: rows already waiting keep their slot, and new rows
  // join behind the last one a minute apart rather than being handed a share of a minute.
  assert.match(dashboard, /const queued = autoRetestOrder\(\)/)
  assert.match(
    dashboard,
    /let slotAt = Math\.max\(\n {8}now,\n {8}lastAutoRetestStartedAt \+ AUTO_RETEST_GAP_MS,\n {8}tail \+ AUTO_RETEST_GAP_MS,\n {6}\)/,
  )
  assert.doesNotMatch(dashboard, /AUTO_RETEST_INTERVAL_MS \/ Math\.max\(1, targets\.length\)/)
  // Each row has its own interval too, so an unchanged verdict cannot bounce to the front.
  assert.match(
    dashboard,
    /if \(now - \(autoRetestLastAt\.get\(key\) \|\| 0\) < AUTO_RETEST_INTERVAL_MS\) continue/,
  )
  assert.match(dashboard, /if \(autoRetestBusy \|\| testAllRunning\) return/)
  // A row leaves the queue when its test starts instead of being held on a personal timer.
  assert.match(
    dashboard,
    /autoRetestAt\.delete\(rowKey\);\n {6}autoRetestLastAt\.set\(rowKey, now\);/,
  )
  // The next slot is claimed before the request, and the floor spaces the starts out.
  assert.match(dashboard, /setTimeout\(\(\) => runDueAutomaticRetest\(\), AUTO_RETEST_GAP_MS\)/)
})

test('the wait is drawn beside the Test button and ticks every second', () => {
  assert.match(dashboard, /function autoRetestNote\(rowKey\)/)
  assert.match(dashboard, /class="test-retry"/)
  // The note states when the row's turn comes, in units a person can read, and says "retest
  // next" only for the row whose slot has arrived. The old wording showed "testing shortly…"
  // to every row in a long queue, which was neither true nor useful.
  assert.match(dashboard, /return `retest in \$\{retestWaitText\(ms\)\}`/)
  assert.match(
    dashboard,
    /return autoRetestBusy \|\| testAllRunning \? 'retest next' : 'retest now'/,
  )
  assert.doesNotMatch(dashboard, /testing shortly…/)
  // Minutes and hours, not a bare count of seconds.
  assert.match(dashboard, /function retestWaitText\(ms\)/)
  assert.match(dashboard, /`\$\{minutes\}m \$\{String\(seconds\)\.padStart\(2, '0'\)\}s`/)
  // Its hover text names the row's place in the queue.
  assert.match(dashboard, /function autoRetestTitle\(queueKey\)/)
  assert.match(dashboard, /Automatic retest — \$\{where\}, one test a minute/)
  assert.match(
    dashboard,
    /const where =\n {8}index >= 0 \? `\$\{index \+ 1\} of \$\{order\.length\} waiting` : `\$\{order\.length\} waiting`/,
  )
  assert.match(dashboard, /function groupAutoRetestRow\(groupKey\)/)
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
