import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  finalizeOnboardStatus,
  onboardVerdictRank,
  sortOnboardResults,
  summarizeOnboardResults,
} from '../lib/provider-onboard.js'
import { VERDICT_ORDER } from '../lib/utils.js'

const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

test('onboarding orders models by the same verdict vocabulary the table uses', () => {
  // The popup and the table must agree on what "current status" means, so the order is the
  // shared VERDICT_ORDER rather than a list invented for the popup.
  assert.ok(VERDICT_ORDER.length > 0)
  assert.equal(onboardVerdictRank('Perfect'), 0)
  assert.equal(onboardVerdictRank('Normal'), 1)
  assert.ok(onboardVerdictRank('Not Active') > onboardVerdictRank('Slow'))
  // A verdict the shared order does not know sorts after every known one: no verdict is the least
  // informative, not the healthiest.
  assert.equal(onboardVerdictRank('gibberish'), VERDICT_ORDER.length)
  assert.equal(onboardVerdictRank(null), VERDICT_ORDER.length)
})

test('onboarding sorts healthy first, then by name', () => {
  const rows = [
    { modelId: 'zeta', label: 'Zeta', verdict: 'Not Active' },
    { modelId: 'beta', label: 'Beta', verdict: 'Perfect' },
    { modelId: 'alpha', label: 'Alpha', verdict: 'Perfect' },
    { modelId: 'mid', label: 'Mid', verdict: 'Slow' },
  ]
  const sorted = sortOnboardResults(rows)
  assert.deepEqual(sorted.map(r => r.modelId), ['alpha', 'beta', 'mid', 'zeta'])
  // The input is never mutated.
  assert.equal(rows[0].modelId, 'zeta')
})

test('onboarding summarizes how many models can serve right now', () => {
  const summary = summarizeOnboardResults([
    { verdict: 'Perfect' },
    { verdict: 'Normal' },
    { verdict: 'Slow' },
    { verdict: 'Not Active' },
    { verdict: 'Not Active' },
  ])
  assert.equal(summary.total, 5)
  // Perfect, Normal and Slow all answered, so all three can serve; a Not Active row cannot.
  assert.equal(summary.ready, 3)
  assert.equal(summary.byVerdict['Not Active'], 2)
})

test('a finished run is cancelled, empty, partial, or done', () => {
  assert.equal(finalizeOnboardStatus({ completed: 3, total: 3 }), 'done')
  assert.equal(finalizeOnboardStatus({ completed: 1, total: 3 }), 'partial')
  assert.equal(finalizeOnboardStatus({ completed: 0, total: 0 }), 'empty')
  // Cancellation wins over the counts: a run stopped on purpose is not "done" for completing some.
  assert.equal(finalizeOnboardStatus({ completed: 3, total: 5, cancelled: true }), 'cancelled')
})

test('the onboarding job is wired to the shared test path and the verdict helpers', () => {
  // The job must test through /api/test-model — the same endpoint the table's Test button uses —
  // so a tested row's status is recorded once and shows the same everywhere.
  assert.match(server, /app\.post\('\/api\/providers\/:providerKey\/onboard'/)
  assert.match(server, /app\.get\('\/api\/providers\/onboard-status'/)
  assert.match(server, /app\.post\('\/api\/providers\/onboard-cancel'/)
  assert.match(server, /const runProviderOnboarding = async \(jobId\)/)
  assert.match(server, /fetch\(`\$\{selfOrigin\}\/api\/test-model`/)
  assert.match(server, /finalizeOnboardStatus\(/)
  // Discovery reuses the per-provider refresh, so a keyless or templated provider is read the way
  // it is everywhere else.
  assert.match(server, /await refreshProviderModelsForApi\(job\.providerKey\)/)
})

test('the dashboard popup drives, polls, and hands off to the plots', () => {
  assert.match(index, /id="provider-onboard-modal"/)
  assert.match(index, /id="provider-onboard-stages"/)
  assert.match(index, /id="provider-onboard-body"/)
  assert.match(dashboard, /function runProviderOnboarding\(/)
  assert.match(dashboard, /function pollOnboardJob\(/)
  assert.match(dashboard, /function resumeOnboardingIfRunning\(/)
  // The handoff: a completed run repaints and briefly highlights the provider on the plots. The
  // emphasis lives in state so the idle repaint the completion schedules cannot clobber it.
  assert.match(dashboard, /async function finishProviderOnboarding\(/)
  assert.match(dashboard, /function emphasizeProviderPlots\(/)
  assert.match(dashboard, /onboardHighlight = \{ modelId: best\.modelId, providerKey: job\.providerKey \}/)
  assert.match(dashboard, /const highlight = onboardHighlight/)
  // Closing the popup must not let an in-flight poll or start reopen it.
  assert.match(dashboard, /onboardSession \+= 1/)
  assert.match(dashboard, /session !== onboardSession \|\| onboardJobId !== jobId/)
  assert.match(dashboard, /if \(onboardStarting && onboardProviderKey === key\) return/)
  // A key save or an OAuth connect is the trigger.
  assert.match(dashboard, /maybeOnboardProvider\(key\)/)
  assert.match(dashboard, /maybeOnboardProvider\('github-copilot'\)/)
})
