// @ts-check
/**
 * ── A transcript that will not come back ────────────────────────────────────────────────────
 *
 * Two ways a conversation can be open and still look gone after a restart, both fixed here:
 *
 *   1. The console is adopted mid-turn, the turn's model was lost, and `running` stays true
 *      forever. A rebuild used to be refused for a running console, so the page kept the replay
 *      log — which starts empty after a restart — and the file it should have read was never
 *      read. A console that produces no record is now rebuilt from the file anyway.
 *   2. The conversation is already open on the main console. Opening it from the rail answered
 *      409 "That conversation is already open." and the click did nothing, because the page had
 *      not yet been told which file the main console is on.
 *
 * These are source assertions, like the rest of the harness's UI rules: the page is a classic
 * script inside an IIFE, so the shape of the two paths is what a test can pin.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

test('a console stuck "running" still rebuilds its transcript from its file', () => {
  assert.match(harness, /async function restoreHistory\(ctx, \{ force = false \} = \{\}\)/)
  assert.match(harness, /if \(ctx\.running && !force\) return/)
  assert.match(harness, /const HISTORY_STALL_MS = \d+/)
  assert.match(harness, /function watchStalledHistory\(ctx/)
  assert.match(harness, /void restoreHistory\(ctx, \{ force: true \}\)/)
  // The check measures quiet, not a flag: a record on the stream is proof the turn is alive.
  assert.match(harness, /ctx\.lastRecordAt = Date\.now\(\)/)
  assert.match(harness, /watchStalledHistory\(console\)/)
})

test('opening a conversation that is already open shows it instead of failing', () => {
  assert.match(harness, /if \(res\.status === 409\)/)
  // The main console is asked for its file once, because that is the one that answers 409.
  assert.match(harness, /const main = state\.consoles\.get\('main'\)/)
  assert.match(harness, /await refreshStatus\(main\)/)
  assert.match(harness, /if \(focus\) activate\(open\)/)
})
