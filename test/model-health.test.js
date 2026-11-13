/**
 * Three failures in a row before a model is out of action.
 *
 * The provider ledger already asks for three failures implicating a fleet; this is the same
 * discipline for one row, and it exists because a single upstream refusal used to strike a
 * model out of rotation — the next request then answered from a fallback while the model the
 * user asked for had been tried once.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createModelHealth,
  MODEL_FAILURE_DECAY_MS,
  MODEL_OUT_OF_ACTION_FAILURES,
  modelFailureStreak,
  noteModelFailure,
  noteModelSuccess,
  sortResults,
} from '../lib/utils.js'

const utilsSource = readFileSync(new URL('../lib/utils.js', import.meta.url), 'utf8')

test('an unmeasured row sorts after a measured one, whichever the direction', () => {
  // `getAvg` answers Infinity for a row with no successful ping in the window, and /api/models
  // can only carry null for that. Two unmeasured rows subtracted is Infinity - Infinity = NaN,
  // which is not an answer a comparator may give: the engine is then free to leave the pair in
  // whatever order it likes. A finite stand-in ranks them equal to each other and after every
  // measured row, which is the order Infinity produced.
  const unmeasured = [
    { label: 'Alpha', status: 'up', pings: [] },
    { label: 'Beta', status: 'up', pings: [] },
  ]
  const measured = {
    label: 'Gamma',
    status: 'up',
    pings: [{ code: '200', ms: 120, ts: Date.now() }],
  }
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(
      sortResults([...unmeasured, measured], 'avg', 'asc').map((r) => r.label),
      ['Gamma', 'Alpha', 'Beta'],
    )
    // Descending is slowest first, and "no measurement" has always ranked as the slowest end
    // of that axis — the two unmeasured rows keep their own (stable) order beside each other.
    assert.deepEqual(
      sortResults([measured, ...unmeasured], 'avg', 'desc').map((r) => r.label),
      ['Alpha', 'Beta', 'Gamma'],
    )
  }
  assert.match(utilsSource, /Number\.isFinite\(aAvg\) \? aAvg : Number\.MAX_VALUE/)
})

test('a model is out of action only on the third failure in a row', () => {
  const health = createModelHealth()
  const now = 1_000_000
  assert.equal(MODEL_OUT_OF_ACTION_FAILURES, 3)
  assert.deepEqual(noteModelFailure(health, 'p/m', { at: now }), {
    failures: 1,
    outOfAction: false,
  })
  assert.deepEqual(noteModelFailure(health, 'p/m', { at: now + 1_000 }), {
    failures: 2,
    outOfAction: false,
  })
  assert.deepEqual(noteModelFailure(health, 'p/m', { at: now + 2_000 }), {
    failures: 3,
    outOfAction: true,
  })
  assert.equal(modelFailureStreak(health, 'p/m', now + 2_000), 3)
  // A fourth failure keeps it out of action rather than resetting anything.
  assert.equal(noteModelFailure(health, 'p/m', { at: now + 3_000 }).outOfAction, true)
})

test('a success clears the streak, so only consecutive failures count', () => {
  const health = createModelHealth()
  const now = 5_000_000
  noteModelFailure(health, 'p/m', { at: now })
  noteModelFailure(health, 'p/m', { at: now + 1 })
  assert.equal(noteModelSuccess(health, 'p/m'), true)
  assert.equal(modelFailureStreak(health, 'p/m', now + 2), 0)
  assert.deepEqual(noteModelFailure(health, 'p/m', { at: now + 3 }), {
    failures: 1,
    outOfAction: false,
  })
  // Nothing recorded means nothing to clear.
  assert.equal(noteModelSuccess(health, 'p/other'), false)
})

test('a failure older than the decay window starts a new streak', () => {
  const health = createModelHealth()
  const now = 9_000_000
  noteModelFailure(health, 'p/m', { at: now })
  noteModelFailure(health, 'p/m', { at: now + 1 })
  const afterDecay = now + MODEL_FAILURE_DECAY_MS + 2
  assert.equal(modelFailureStreak(health, 'p/m', afterDecay), 0)
  assert.deepEqual(noteModelFailure(health, 'p/m', { at: afterDecay }), {
    failures: 1,
    outOfAction: false,
  })
})

test('the streak is per model, not per provider', () => {
  const health = createModelHealth()
  const now = 11_000_000
  noteModelFailure(health, 'p/one', { at: now })
  noteModelFailure(health, 'p/one', { at: now + 1 })
  noteModelFailure(health, 'p/two', { at: now + 2 })
  assert.equal(modelFailureStreak(health, 'p/one', now + 2), 2)
  assert.deepEqual(noteModelFailure(health, 'p/two', { at: now + 3 }), {
    failures: 2,
    outOfAction: false,
  })
})

test('a verdict that is a statement takes the model out of action at once', () => {
  const health = createModelHealth()
  // The verdicts the proxy and the probe pass as immediate: money, a tombstone, a modality, a
  // spent window, a refused credential, an overload.
  for (const verdict of ['dead', 'paid', 'incompatible', 'rate-limited', 'overloaded', 'noauth']) {
    assert.deepEqual(
      noteModelFailure(health, `p/${verdict}`, { immediate: true }),
      { failures: 1, outOfAction: true },
      verdict,
    )
  }
})
