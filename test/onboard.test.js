import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  finalizeOnboardStatus,
  onboardVerdictRank,
  sortOnboardResults,
  summarizeOnboardResults,
} from '../lib/provider-onboard.js'
import {
  getVerdict,
  INTELLIGENCE_BANDS,
  intelligenceBandForAa,
  VERDICT_ORDER,
} from '../lib/utils.js'

const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

test('onboarding orders models by the same verdict vocabulary the table uses', () => {
  // The popup and the table must agree on what "current status" means, so the order is the
  // shared VERDICT_ORDER rather than a list invented for the popup.
  assert.ok(VERDICT_ORDER.length > 0)
  assert.equal(onboardVerdictRank('Very Fast'), 0)
  assert.equal(onboardVerdictRank('Fast'), 1)
  assert.equal(onboardVerdictRank('Normal'), 2)
  assert.ok(onboardVerdictRank('Not Active') > onboardVerdictRank('Slow'))
  // A verdict the shared order does not know sorts after every known one: no verdict is the least
  // informative, not the healthiest.
  assert.equal(onboardVerdictRank('gibberish'), VERDICT_ORDER.length)
  assert.equal(onboardVerdictRank(null), VERDICT_ORDER.length)
})

test('onboarding sorts healthy first, then by name', () => {
  const rows = [
    { modelId: 'zeta', label: 'Zeta', verdict: 'Not Active' },
    { modelId: 'beta', label: 'Beta', verdict: 'Fast' },
    { modelId: 'alpha', label: 'Alpha', verdict: 'Very Fast' },
    { modelId: 'mid', label: 'Mid', verdict: 'Slow' },
  ]
  const sorted = sortOnboardResults(rows)
  assert.deepEqual(
    sorted.map((r) => r.modelId),
    ['alpha', 'beta', 'mid', 'zeta'],
  )
  // The input is never mutated.
  assert.equal(rows[0].modelId, 'zeta')
})

test('onboarding summarizes how many models can serve right now', () => {
  const summary = summarizeOnboardResults([
    { verdict: 'Very Fast' },
    { verdict: 'Normal' },
    { verdict: 'Slow' },
    { verdict: 'Not Active' },
    { verdict: 'Not Active' },
  ])
  assert.equal(summary.total, 5)
  // Very Fast, Normal and Slow all answered, so all three can serve; a Not Active row cannot.
  assert.equal(summary.ready, 3)
  assert.equal(summary.byVerdict['Not Active'], 2)
})

test('the speed verdicts band average ping latency into Very Fast through Very Slow', () => {
  // The bands the Speed column and the onboarding popup both read. 'Unstable' is not a speed:
  // it is reserved for repeated recent failures (see the failure-evidence test below), so every
  // successful-ping average lands on a speed tag however slow it is.
  const row = (ms) => ({
    status: 'up',
    httpCode: null,
    pings: [{ code: '200', ms, ts: Date.now() }],
  })
  assert.equal(getVerdict(row(50)), 'Very Fast')
  assert.equal(getVerdict(row(199)), 'Very Fast')
  assert.equal(getVerdict(row(200)), 'Fast')
  assert.equal(getVerdict(row(599)), 'Fast')
  assert.equal(getVerdict(row(600)), 'Normal')
  assert.equal(getVerdict(row(999)), 'Normal')
  assert.equal(getVerdict(row(1000)), 'Slow')
  assert.equal(getVerdict(row(2999)), 'Slow')
  assert.equal(getVerdict(row(3000)), 'Very Slow')
  assert.equal(getVerdict(row(9999)), 'Very Slow')
  // A 30-second average is slow, not unstable: speed and reliability are different statements.
  assert.equal(getVerdict(row(30000)), 'Very Slow')
  // No successful ping in the window falls back to the persisted usage figures — the estimate
  // is what keeps a tag alive across a restart, and it applies to a row that is not currently
  // active too, because the tag reports speed, not health.
  assert.equal(getVerdict({ status: 'up', pings: [] }), 'Not Active')
  assert.equal(
    getVerdict({ status: 'up', pings: [], ttft: 250, tps: 40, speedTokens: 200 }),
    'Fast',
  )
  assert.equal(getVerdict({ status: 'down', pings: [], ttft: 100 }), 'Very Fast')
  assert.equal(getVerdict({ status: 'noauth', pings: [], ttft: 5000 }), 'Very Slow')
  // The estimate needs a ttft to stand on: tok/s alone says nothing about latency.
  assert.equal(getVerdict({ status: 'up', pings: [], tps: 40, speedTokens: 200 }), 'Not Active')
  // 'Perfect' is no longer a verdict: it must not appear in the shared order the popup sorts by.
  assert.equal(VERDICT_ORDER.includes('Perfect'), false)
  // Neither is 'Overloaded': a 429 is a statement about the account, not the model's speed, so
  // the row keeps reporting the last speed it measured instead of losing its tag.
  assert.equal(VERDICT_ORDER.includes('Overloaded'), false)
  assert.equal(
    getVerdict({
      status: 'rate-limited',
      httpCode: '429',
      pings: [{ code: '200', ms: 250, ts: Date.now() }],
    }),
    'Fast',
  )
  assert.equal(
    getVerdict({ status: 'rate-limited', httpCode: '429', pings: [], ttft: 5000 }),
    'Very Slow',
  )
  // With no measurement at all a refused row has no speed to report, same as any other row.
  assert.equal(getVerdict({ status: 'rate-limited', httpCode: '429', pings: [] }), 'Not Active')
})

test('unstable takes repeated recent failures, not one blip or a slow average', () => {
  const now = Date.now()
  const ping = (code, ms = 100) => ({ code, ms, ts: now })
  // Up before, then failures at the tail: two or more in the last five is unstable.
  assert.equal(
    getVerdict({
      status: 'down',
      pings: [ping('200'), ping('200'), ping('ERR'), ping('000')],
    }),
    'Unstable',
  )
  // A single failure after a healthy run is a blip, not instability — and the row still shows
  // its speed, because the tag reports how fast it is, not whether it is answering right now.
  assert.equal(
    getVerdict({
      status: 'down',
      pings: [ping('200'), ping('200'), ping('200'), ping('ERR')],
    }),
    'Very Fast',
  )
  // Never having answered and nothing saved is Not Active, not Unstable.
  assert.equal(getVerdict({ status: 'down', pings: [ping('ERR'), ping('ERR')] }), 'Not Active')
  // A timeout with the same repeated-failure shape reads the same way.
  assert.equal(
    getVerdict({
      status: 'timeout',
      pings: [ping('200'), ping('ERR'), ping('ERR'), ping('ERR')],
    }),
    'Unstable',
  )
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
  // Discovery returns rows, not scores: the refresh has to re-attach the quality index after the
  // new roster exists, or a freshly onboarded model stays off the intelligence/speed plot.
  assert.match(
    server,
    /const refreshProviderModelsForApi = async \(providerKey\) => \{\n\s+const models = await discoverProviderModelsForApi\(providerKey[^)]*\);[\s\S]{0,600}?if \(qualityData\) \{/,
  )
  assert.match(server, /await refreshQualityScores\(false, true\);/)
})

test('the dashboard popup drives, polls, and hands off to the plots', () => {
  assert.match(index, /id="provider-onboard-modal"/)
  assert.match(index, /id="provider-onboard-stages"/)
  assert.match(index, /id="provider-onboard-body"/)
  // Cancel belongs in the fixed footer, not the scrolling body, so a long model list cannot hide it.
  assert.match(index, /id="provider-onboard-cancel"[^>]*>Cancel</)
  assert.match(dashboard, /function cancelProviderOnboardingOrClose\(/)
  assert.match(dashboard, /function setProviderOnboardFooterAction\(/)
  assert.match(dashboard, /function runProviderOnboarding\(/)
  assert.match(dashboard, /function pollOnboardJob\(/)
  assert.match(dashboard, /function resumeOnboardingIfRunning\(/)
  // The handoff: a completed run repaints and briefly highlights the provider on the plots. The
  // emphasis lives in state so the idle repaint the completion schedules cannot clobber it.
  assert.match(dashboard, /async function finishProviderOnboarding\(/)
  assert.match(dashboard, /function emphasizeProviderPlots\(/)
  assert.match(
    dashboard,
    /onboardHighlight = \{ modelId: best\.modelId, providerKey: job\.providerKey \}/,
  )
  assert.match(dashboard, /const highlight = onboardHighlight/)
  // Closing the popup must not let an in-flight poll or start reopen it.
  assert.match(dashboard, /onboardSession \+= 1/)
  assert.match(dashboard, /session !== onboardSession \|\| onboardJobId !== jobId/)
  assert.match(dashboard, /if \(onboardStarting && onboardProviderKey === key\) return/)
  // A key save or an OAuth connect is the trigger.
  assert.match(dashboard, /maybeOnboardProvider\(key\)/)
  assert.match(dashboard, /maybeOnboardProvider\('github-copilot'\)/)
})

test('the intelligence bands cut the AA index at 12, 20, 32, 45 and 55', () => {
  // Fixed points on the index, like the speed bands' milliseconds: a model's band must not move
  // because another model joined the catalogue. The anchors are the models the cut-offs were
  // calibrated on — the two Nemotrons, GLM 5.3 Flash, DeepSeek V4.1 Flash and GPT 6 Luna.
  assert.deepEqual(
    INTELLIGENCE_BANDS.map((band) => band.from),
    [55, 45, 32, 20, 12, 0],
  )
  assert.equal(intelligenceBandForAa(3.5), 'Very Dumb')
  assert.equal(intelligenceBandForAa(10.3), 'Very Dumb', 'Nemotron 3 Nano')
  assert.equal(intelligenceBandForAa(11.9), 'Very Dumb')
  assert.equal(intelligenceBandForAa(12), 'Dumb', 'Nemotron 3 Super')
  assert.equal(intelligenceBandForAa(19.9), 'Dumb')
  assert.equal(intelligenceBandForAa(20), 'Normal')
  assert.equal(intelligenceBandForAa(27.8), 'Normal', 'GLM 5.3 Flash')
  assert.equal(intelligenceBandForAa(31.9), 'Normal')
  assert.equal(intelligenceBandForAa(32), 'Smart')
  assert.equal(intelligenceBandForAa(34.6), 'Smart', 'GPT 6 Luna')
  assert.equal(intelligenceBandForAa(39.5), 'Smart', 'DeepSeek V4.1 Flash')
  assert.equal(intelligenceBandForAa(44.9), 'Smart')
  assert.equal(intelligenceBandForAa(45), 'Very Smart')
  assert.equal(intelligenceBandForAa(54.9), 'Very Smart')
  assert.equal(intelligenceBandForAa(55), 'Genius')
  assert.equal(intelligenceBandForAa(59.4), 'Genius', 'Gemini 4 Carbon')
  // No rating, no band: an unmeasured model keeps its dash rather than a tier nobody measured.
  for (const empty of [null, undefined, '', 0, -3, 'wide open', NaN]) {
    assert.equal(intelligenceBandForAa(empty), null)
  }
})
