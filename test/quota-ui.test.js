import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { providerQuotaTable } from '../lib/providers/index.js'
import { quotaAppliesToHost } from '../lib/providers/schema.js'
import { getDefaultProviderBaseUrl } from '../lib/providers/discovery.js'

const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')

// The quota box was the one part of a provider card that could be absent entirely: a
// provider with no live usage endpoint rendered nothing, which read as "hammer has no
// opinion" when the catalog in fact publishes a limit for it. These pin the contract that
// every card answers the question and names where the answer came from.
test('the quota box renders for every provider, with its provenance', () => {
  assert.match(dashboard, /function quotaBarsHtml\(/)
  assert.doesNotMatch(dashboard, /if \(reports\.length === 0\) return ''/)
  assert.match(dashboard, /quota-provenance/)
  assert.match(dashboard, /Published limits/)
  assert.match(dashboard, /Not reported/)
})

test('the card reads the published and observed quota the server sends', () => {
  assert.match(dashboard, /provider\?\.knownQuota/)
  assert.match(dashboard, /provider\?\.observedQuota/)
  assert.match(server, /knownQuota,/)
  assert.match(server, /observedQuota: observedQuota\.reports/)
  assert.match(server, /function buildObservedQuota/)
})

test('a quota source link is limited to http(s)', () => {
  assert.match(dashboard, /function safeExternalHref/)
  assert.match(dashboard, /parsed\.protocol === 'http:'/)
})

test('the published quota table covers every provider that ships a record', () => {
  const table = providerQuotaTable()
  assert.ok(table['openrouter'])
  assert.ok(table['github-copilot'])
  assert.ok(table['openai-codex'])
  assert.ok(table['gptfree'])
})

// The published numbers were missing exactly where users look. Hammer registers its own
// endpoint rows first, so the import skips those keys — including the free-tier figures the
// vendored roster documents for them, which left the card with a citation and no limit.
test('hammer\'s own rows carry the roster\'s published allowance', () => {
  const table = providerQuotaTable()
  assert.equal(table.groq.steadyTokensPerMonth, 15_000_000)
  assert.equal(table.openrouter.steadyTokensPerMonth, 1_000_000)
  assert.equal(table.kiro.steadyTokensPerMonth, 25_000)
  assert.equal(table.scaleway.signupCreditTokens, 1_000_000)
  // Providers the roster owns outright keep their own figures.
  assert.equal(table.llm7.steadyTokensPerMonth, 150_000_000)
  assert.equal(table['ollama-cloud'].steadyTokensPerMonth, 20_000_000)
})

test('a published figure is attributed without displacing the provider\'s own citation', () => {
  const table = providerQuotaTable()
  const groq = table.groq
  assert.match(groq.numericSource, /OmniRoute free-tier roster/)
  // The link still answers "where do I read about this plan?" — it is the provider's page.
  assert.equal(groq.sourceUrl, 'https://console.groq.com/docs/rate-limits')
  assert.equal(groq.limits.length, 1)
  assert.deepEqual(
    { metric: groq.limits[0].metric, limit: groq.limits[0].limit, period: groq.limits[0].period },
    { metric: 'tokens', limit: 15_000_000, period: 'month' },
  )
  assert.match(groq.limits[0].source, /OmniRoute free-tier roster/)
})

// The hosted Ollama plan is a monthly grant; a local Ollama server is bound by the machine it
// runs on. One provider key serves both, so the number is marked with the host it applies to
// and the server drops it everywhere else.
test('the hosted Ollama allowance is scoped to ollama.com', () => {
  const table = providerQuotaTable()
  assert.equal(table.ollama.steadyTokensPerMonth, 20_000_000)
  assert.deepEqual(table.ollama.appliesToHosts, ['ollama.com'])
  // Every other published record applies wherever its provider points.
  assert.deepEqual(table.groq.appliesToHosts, [])
  assert.match(server, /function publishedQuotaFor\(/)
  assert.match(server, /appliesToHosts/)
})

test('a host-scoped grant follows the endpoint that will actually answer', () => {
  const ollama = providerQuotaTable().ollama
  assert.equal(quotaAppliesToHost(ollama, 'https://ollama.com/v1'), true)
  assert.equal(quotaAppliesToHost(ollama, 'https://api.ollama.com/v1/'), true)
  // Ollama with nothing configured is the hosted endpoint — the default is where its traffic
  // goes — so hiding the grant unless a base URL is set would hide it from exactly the users
  // it describes. A local server must not see a monthly hosted grant.
  assert.equal(getDefaultProviderBaseUrl('ollama'), 'https://ollama.com/v1')
  assert.equal(quotaAppliesToHost(ollama, getDefaultProviderBaseUrl('ollama')), true)
  assert.match(server, /\|\| getDefaultProviderBaseUrl\(baseKey\)/)
  assert.equal(quotaAppliesToHost(ollama, 'http://localhost:11434/v1'), false)
  assert.equal(quotaAppliesToHost(ollama, 'http://ollama.truenas:11434'), false)
  assert.equal(quotaAppliesToHost(ollama, ''), false)
  // A record with no host list applies to any endpoint at all.
  assert.equal(quotaAppliesToHost(providerQuotaTable().groq, 'http://localhost:1234'), true)
})

test('the card pairs each published limit with the recorded window it applies to', () => {
  assert.match(server, /recordedUsage: buildRecordedUsage\(usageStats, key\)/)
  assert.match(server, /recordUsageBuckets\(entry, sample\)/)
  // Counted inside the proxy-request branch, not next to the call: a manual Test is real usage
  // but not traffic the router served, and counting it would inflate the recorded side against
  // a published limit every time somebody pressed Test.
  assert.match(server, /if \(countProxyRequest\) \{[\s\S]{0,1200}?recordUsageBuckets\(entry, sample\)/)
  assert.match(dashboard, /provider\?\.recordedUsage/)
  assert.match(dashboard, /const RECORDED_BY_PERIOD = \{/)
  // A monthly grant draws against this month's tokens, a one-off credit against lifetime
  // tokens — pairing any other way would be a percentage of the wrong window.
  assert.match(dashboard, /month: \['tokensThisMonth', 'this month', /)
  assert.match(dashboard, /lifetime: \['tokensLifetime', 'so far', /)
  // The empty-window copy is per period: a lifetime window has no "yet" to wait for.
  assert.match(dashboard, /lifetime: \['tokensLifetime', 'so far', 'Nothing recorded yet'\]/)
  assert.match(dashboard, /function publishedLimitHtml\(limit, recorded\)/)
  assert.match(dashboard, /quota-track-published/)
  assert.match(dashboard, /recorded by hammer/)
})

// "Unavailable" was the whole story before: a key that may not read its own balance, a URL
// that moved and a provider that is down all produced the same sentence on the card.
test('a refused usage endpoint reports why it was refused', () => {
  assert.match(server, /let failureNote = null/)
  assert.match(server, /failureNote = `\$\{response\.status\}/)
  assert.match(server, /Usage endpoint unavailable\$\{failureNote/)
  // The per-account case still names the count, which is the right answer when some keys read
  // and others do not.
  assert.match(server, /\$\{failedAccounts\} account\(s\) unavailable\./)
})

test('every published numeric limit renders a bar, and none without a number does', () => {
  const table = providerQuotaTable()
  const numeric = Object.values(table).filter(quota => Array.isArray(quota.limits) && quota.limits.length > 0)
  assert.ok(numeric.length > 20, `expected a wide spread of published limits, saw ${numeric.length}`)
  for (const quota of numeric) {
    for (const limit of quota.limits) {
      assert.ok(limit.limit > 0, `${quota.source} limit must be positive`)
      assert.ok(['day', 'week', 'month', 'lifetime'].includes(limit.period))
    }
  }
  // A record with no figure at all still has to exist for providers like Pollinations, whose
  // plan is credit-based — it renders the citation without inventing a bar.
  assert.deepEqual(table.pollinations.limits, [])
})
