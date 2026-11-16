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
 *   3. The page reopened the tabs it remembered and left the reader on an empty main console,
 *      because the conversation that is *not* a tab — the one Hammer lands on — was the one
 *      thing no storage key described.
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

test('a restart lands on the conversation the page was showing', () => {
  // The conversation on screen is remembered on its own: the open-tabs key only carries the
  // tabs, so a single conversation had nowhere to come back from.
  assert.match(harness, /const LAST_KEY = 'hammer\.hx\.last'/)
  assert.match(harness, /function rememberViewed\(console\) \{/)
  assert.match(harness, /if \(ctx === active\(\)\) rememberViewed\(ctx\)/)
  // A fresh main console takes the remembered conversation back instead of showing an empty one
  // (a restart starts a new agent, so main has no file of its own to resume).
  // Never while that console is streaming: switching its session would end the turn.
  assert.match(harness, /!main\.items\.length && !main\.running\)\)/)
  assert.match(harness, /if \(await resumeOnMain\(main, lastFile\)\) focusFile = lastFile/)
  assert.match(harness, /fetch\(`\$\{API\}\/sessions\/open`/)
  // And the page settles on that file, not on whichever tab happened to be written last.
  assert.match(harness, /const onScreen = focusFile/)
  // Read once at load: boot activates an empty main console before the restore runs, and
  // remembering that would overwrite the file the restore is about to put back.
  assert.match(harness, /const bootLastViewed = lastViewedFile\(\)/)
  assert.match(harness, /const lastFile =\s*bootLastViewed \|\|/)
  // A child belongs to the subagent tree: neither its file nor an old saved tab may be
  // adopted as the page's main conversation after a restart.
  assert.match(
    harness,
    /console\.subagentId \|\| isSubagentSession\(console\.sessionFile\)\) return/,
  )
  assert.match(
    harness,
    /if \(isSubagentSession\(file\)\) \{\s*localStorage\.removeItem\(LAST_KEY\)/,
  )
  assert.match(harness, /if \(isSubagentSession\(file\)\) openFiles\.delete\(file\)/)
  // The console's earlier rebuild (an empty conversation, after a restart) must not stop the
  // remembered file from being read now.
  assert.match(harness, /main\.historyLoaded = false\n\s*await restoreHistory\(main\)/)
})
