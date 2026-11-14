import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { providerQuotaTable } from '../lib/providers/index.js'
import { quotaAppliesToHost } from '../lib/providers/schema.js'
import { getDefaultProviderBaseUrl } from '../lib/providers/discovery.js'
import { parseTokenHarborFreeTierHeaders } from '../lib/utils.js'

const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const dashboardCss = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
const modelsRoute = readFileSync(new URL('../lib/http/routes/models.js', import.meta.url), 'utf8')
const proxyRoute = readFileSync(new URL('../lib/http/routes/proxy.js', import.meta.url), 'utf8')

test('the providers tables put Rate limit directly beside Quota', () => {
  for (const id of ['active-providers-table', 'setup-providers-table']) {
    const start = indexHtml.indexOf(`id="${id}"`)
    assert.ok(start > 0, `${id} exists`)
    const header = indexHtml.slice(start, indexHtml.indexOf('</thead>', start))
    assert.match(
      header,
      /Credentials<\/th>\s*<th[^>]*>Usage<\/th>\s*<th[^>]*>Quota<\/th>\s*<th[^>]*>Rate limit<\/th>\s*<th[^>]*>Latest error<\/th>/,
    )
  }
  assert.equal((dashboard.match(/\$\{providerUsageCell\}/g) || []).length, 7)
  // Every provider row template writes the same three cells in that same order: the four
  // account-specific branches, Devin, and the generic row.
  assert.match(
    dashboard,
    /<td class="provider-quota-cell">\$\{providerQuotaHtml\}<\/td>\s*<td class="provider-limits-cell">\$\{rateLimitHtml\}<\/td>\s*<td class="provider-error-cell">\$\{providerErrorHtml\}<\/td>/,
  )
  assert.doesNotMatch(
    dashboard,
    /<td class="provider-quota-cell">\$\{providerQuotaHtml\}<\/td>\s*<td class="provider-error-cell">\$\{providerErrorHtml\}<\/td>/,
  )
  assert.equal(
    (dashboard.match(/<td class="provider-limits-cell">\$\{rateLimitHtml\}<\/td>/g) || []).length,
    7,
  )
})

test('the UI opens only after imported-provider startup discovery is awaited', () => {
  const discovery = server.indexOf('const discoverySettled = await Promise.allSettled')
  const listen = server.indexOf('const httpServer = app.listen')
  assert.ok(discovery >= 0 && listen > discovery, 'the web UI bind must follow startup discovery')
  assert.match(server, /startupImportedDiscoveryTasks/)
  assert.match(server, /lazyDiscoveryCandidates\(/)
  assert.doesNotMatch(dashboard, /\/api\/providers\/discover-pending/)
  assert.doesNotMatch(dashboard, /discoverPendingProviders/)

  const discoveryDone = server.indexOf('Discovery completed in')
  const clearProgress = server.indexOf('clearStartupProgress()', discoveryDone)
  const listenAfterDiscovery = server.indexOf('const httpServer = app.listen', discoveryDone)
  assert.ok(discoveryDone >= 0, 'the startup summary must be printed')
  assert.ok(clearProgress > discoveryDone, 'startup progress must be cleared after the summary')
  assert.ok(listenAfterDiscovery > clearProgress, 'the UI bind must follow progress cleanup')
})

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

test('a quota record with no numeric limit is a provider note, not a published bar', () => {
  assert.match(dashboard, /knownHasNumericLimits/)
  assert.match(dashboard, /knownHasNumericLimits \? 'Published limits' : 'Provider note'/)
  assert.doesNotMatch(dashboard, /provenanceLabel = known \? 'Published limits'/)
})

test('a pooled provider draws one remaining-quota bar per account, side by side', () => {
  assert.match(dashboard, /credential-pool-grid/)
  assert.match(dashboard, /data-pool-account=/)
  assert.match(dashboard, /data-pool-quota-remaining=/)
  assert.match(dashboard, /credential-pool-fill-\$\{state\}/)
  assert.doesNotMatch(dashboard, /data-pool-segment=/)
  assert.doesNotMatch(dashboard, /% of traffic/)
  assert.doesNotMatch(dashboard, /requests \/ totalRequests/)
  assert.match(dashboard, /Quota not reported/)
  assert.match(dashboard, /account\.quota/)
  assert.match(
    dashboard,
    /const exhaustedAccounts = accounts\.filter\(account => account\.exhausted\)/,
  )
  assert.match(dashboard, /a model is at quota on every account/)
  assert.match(dashboard, /A model at 0 does not mean the account is exhausted/)
  assert.match(dashboard, /'Model limited'/)
  assert.match(dashboardCss, /credential-pool-fill-unknown/)
  assert.match(dashboardCss, /credential-pool-state-limited/)
  assert.match(
    dashboardCss,
    /\.credential-pool-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  )
})

test('Token Harbor free-tier headers become a percent-only weekly window', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z')
  const parsed = parseTokenHarborFreeTierHeaders(
    new Headers({
      'x-th-free-used-pct': '42.5',
      'x-th-free-resets': '2026-11-17T00:00:00.000Z',
    }),
    now,
  )
  assert.equal(parsed.freeUsedPercent, 42.5)
  assert.equal(parsed.freeResetAt, Date.parse('2026-11-17T00:00:00.000Z'))
  assert.equal(parsed.freeCapturedAt, now)
  // The allowance's size is unpublished, so nothing may turn 42.5% into a token count.
  assert.equal('limitTokens' in parsed, false)
  assert.equal(parseTokenHarborFreeTierHeaders(new Headers(), now), null)

  const relative = parseTokenHarborFreeTierHeaders(
    { 'X-TH-Free-Used-Pct': '12%', 'X-TH-Free-Resets': '3600' },
    now,
  )
  assert.equal(relative.freeUsedPercent, 12)
  assert.equal(relative.freeResetAt, now + 3600_000)

  // Both response paths capture the headers, and both UI surfaces render the percentage.
  // The allowance is capacity, so the UI reads it off the quota half (with the legacy
  // rateLimit read kept for rows persisted before the split).
  assert.match(server, /parseTokenHarborFreeTierHeaders\(rl\)/)
  assert.match(server, /parseTokenHarborFreeTierHeaders\(headers\)/)
  assert.match(dashboard, /creditSource\.freeUsedPercent/)
  assert.match(dashboard, /quota\.freeUsedPercent/) // via creditSource = m.quota || m.rateLimit
  assert.match(harness, /freeUsedPercent/)

  // Token Harbor states the allowance only on a non-streamed answer, and the proxy forces
  // SSE upstream — so the free rows need a check of their own or the percentage never lands.
  assert.match(proxyRoute, /refreshTokenHarborFreeAllowance/)
  assert.match(proxyRoute, /parseTokenHarborFreeTierHeaders\(response\.headers\)/)
  assert.match(proxyRoute, /\/:free\$\/i\.test/)
  // The allowance is account state, so the check has to persist it: a route context that does
  // not seed the saver turns the write into a silent no-op that a restart erases.
  assert.match(proxyRoute, /ctx\.saveUsageStats\?\.\(\)/)
  assert.match(server, /\bsaveUsageStats,\n\s*scheduleLogSave,/)
})

test('the account bars are fed by quota captured per credential', () => {
  assert.match(server, /function recordCredentialQuota/)
  assert.match(server, /function credentialQuotaView/)
  assert.match(
    server,
    /recordCredentialQuota\(model\.providerKey, options\.credential \|\| providerApiKey/,
  )
  assert.match(
    server,
    /quota: credentialQuotaView\(state, entry, idx, now, exhausted\) \|\| codeAssistQuota\(idx\)/,
  )
  assert.match(server, /x-ratelimit-limit'/)
  assert.match(server, /x-ratelimit-remaining'/)
  // Every 429 belongs to the account that answered it, including the one that triggers a
  // retry with the next account, and the zero-free-tier 429 that is read as a payment wall.
  assert.match(
    server,
    /Number\(response\.status\) === 429 && attempt \+ 1 < MAX_TEST_ATTEMPTS\)[\s\S]{0,900}?recordCredentialQuota\(/,
  )
  assert.match(
    server,
    /Number\(response\.status\) === 429 && permanentVerdict\)[\s\S]{0,900}?recordCredentialQuota\(/,
  )
})

test('Google quota reaches the antigravity card from the Code Assist cache', () => {
  // Google has no usage endpoint: its allowance is read from Code Assist, which is what the
  // model table already draws. The card is the only place an account-wide view belongs, and
  // without this it said "Quota not reported" beside a table showing the very buckets Google
  // had just sent.
  assert.match(server, /const cardQuotaReports = \(key\) =>/)
  assert.match(server, /quotaReports: serializeProviderUsage\(cardQuotaReports\(key\)\)/)
  assert.match(server, /getGoogleQuotaCardReports\(key\)/)
  assert.match(server, /getGoogleQuotaCardReports\(providerKey\)/)
  // A percentage window is not a count of anything: the account bar must say "98% left"
  // rather than "98 of 100 left".
  assert.match(dashboard, /const percentOnly = Boolean\(quota\?\.percentOnly\)/)
  assert.match(dashboard, /% left/)
  // One account's failed read costs that account's bar, so the card names the failure rather
  // than silently showing fewer accounts than the pool has.
  assert.match(server, /quotaError: providerUsageErrors\.get\(key\) \|\| cardQuotaError\(key\)/)
  assert.match(server, /getGoogleQuotaError\(key\)/)
  // The pool's reset countdown sits after the request count: "…0 requestsresets in 6d" read as
  // one word.
  assert.match(dashboard, /reset \? ` \\u00b7 \$\{reset\}` : ''/)
})

test('the model table shows a quota window for every endpoint', () => {
  assert.match(indexHtml, /<th id="th-quota"/)
  assert.match(indexHtml, /<tbody id="table-body"/)
  assert.match(dashboard, /function quotaRowViews\(m\)/)
  assert.match(dashboard, /function quotaRowWindowHtml\(w\)/)
  // A multi-provider model heading reports capacity the router can use now; provider rows
  // each carry their own stack. A benched or down provider must not paint its 100% window
  // across a model that still has an up provider with allowance. When nothing is usable the
  // whole group remains visible so the heading can explain what is blocking it.
  assert.match(dashboard, /\$\{quotaGroupCell\(g\)\}/)
  assert.match(dashboard, /\$\{quotaRowCell\(m\)\}/)
  assert.match(dashboard, /function quotaGroupViews\(members\)/)
  assert.match(dashboard, /function groupCapacityMembers\(members\)/)
  assert.match(dashboard, /const usable = all\.filter\(isRowUsable\)/)
  assert.match(dashboard, /return usable\.length > 0 \? usable : all/)
  assert.match(dashboard, /const capacityMembers = groupCapacityMembers\(members\)/)
  assert.match(dashboard, /function quotaWindowExhausted\(window\)/)
  assert.match(dashboard, /function quotaGroupCapacityWindows\(windows\)/)
  assert.match(
    dashboard,
    /const windows = quotaGroupCapacityWindows\(quotaGroupViews\(capacityMembers\)\)/,
  )
  assert.doesNotMatch(dashboard, /view\.estimated \? 'estimated' : 'published'/)
  assert.match(
    dashboard,
    /const authoritative = views\.every\(\(view\) => view\.estimated !== true\)/,
  )
  assert.match(dashboard, /const tightestView = views\.reduce/)
  assert.match(dashboard, /tightest across \$\{views\.length\}/)
  // The provider-count label and its gross/tightest basis were removed from the cell: the
  // windows themselves carry the reading, and the meta line already names the unit.
  assert.doesNotMatch(dashboard, /provider\$\{providers === 1 \? '' : 's'\} · \$\{basis\}/)
  assert.doesNotMatch(dashboard, /const basis =/)
  assert.doesNotMatch(dashboard, /const mixedEstimate = windows\.some\(/)
  assert.doesNotMatch(dashboard, /window\.estimated === true \|\| window\.mixed === true/)
  // A heading totals allowances, not rows: an account-scoped limit (KiloCode's 200 requests/hour
  // pool, whose recorded usage is already provider-wide) must count once however many of that
  // provider's models sit under the heading, while a model-scoped limit adds up per model.
  assert.match(dashboard, /const perModel = view\.scope === 'model'/)
  assert.match(dashboard, /account:\$\{providerKey\}/)
  assert.match(dashboard, /quotaGroupProviderCount\(members\)/)
  assert.match(dashboard, /shared by \$\{rows\} rows/)
  // Google publishes only a remaining fraction, which cannot be added up: a heading over
  // those windows reports the tightest allowance instead of blanking back to "usage not
  // reported" while every row beneath it shows a number.
  // Percentages are not addable: the gross reports the tightest fraction it saw.
  assert.match(dashboard, /const fractions = views\.map\(groupTightness\)/)
  assert.match(dashboard, /highest use across/)
  // Different reset clocks survive the gross as a warning rather than one countdown.
  assert.match(dashboard, /resets vary/)
  assert.match(dashboard, /const rolling =\s*\n\s*view\.period === 'rolling'/)
  assert.match(dashboard, /m\?\.quotaWindows/)
  assert.match(modelsRoute, /quotaWindows: \[[\s\S]{0,200}?extractQuotaWindows\(/)
  assert.match(dashboard, /quotaRowCellInnerHTML\(m\)/)
  // Percent used, the per-window total, remaining tokens and the reset countdown are all in
  // the same cell. Multiple published periods survive the merge.
  assert.match(dashboard, /QUOTA_ROW_PERIOD_LABEL/)
  assert.match(dashboard, /resets in \$\{formatQuotaReset/)
  assert.match(dashboard, /\$\{unit\} \/ \$\{periodLabel\.toLowerCase\(\)\}/)
  assert.match(dashboard, /QUOTA_ROW_METRIC_ORDER/)
  assert.match(dashboard, /data-quota-metric/)
  assert.match(dashboard, /no free-tier allowance/)
  assert.match(dashboard, /const available = sorted\.filter/)
  assert.match(
    dashboard,
    /const noFreeTier = w\.unavailable && !w\.percentOnly && w\.period === 'window'/,
  )
  assert.match(dashboard, /allowance not published/)
  assert.match(dashboard, /no free-tier allowance across/)
  assert.match(dashboard, /% used/)
  assert.match(dashboard, /left/)
  assert.match(dashboardCss, /\.quota-cell \{/)
  assert.match(dashboardCss, /\.quota-row-fill-success/)
  assert.match(dashboardCss, /\.quota-row-fill-warning/)
  assert.match(dashboardCss, /\.quota-row-fill-error/)
  // The server sends both numerators: the row's own tokens for model-scoped limits and the
  // provider total for account-scoped limits.
  assert.match(modelsRoute, /recordedUsage: buildRecordedUsageForEntry\(usageEntry\)/)
  assert.match(modelsRoute, /providerRecordedUsage:/)
  assert.match(modelsRoute, /buildRecordedUsage\(ctx\.usageStats, r\.providerKey\)/)
})

test('the graveyard carries the quota column and Google rows link to live project limits', () => {
  // InferX publishes no usage endpoint, so a row with nothing observed points at its model
  // list instead of showing a dash that reads like "no limit".
  assert.match(dashboard, /QUOTA_PROVIDER_NOTES\[m\?\.providerKey\]/)
  assert.match(dashboard, /No usage API/)
  assert.match(indexHtml, /<th id="th-graveyard-quota"/)
  assert.match(dashboard, /\$\{quotaRowCell\(first\)\}/)
  assert.match(dashboard, /function quotaProviderNote\(m\)/)
  assert.match(dashboard, /aistudio\.google\.com\/rate-limit/)
  assert.match(dashboardCss, /\.quota-row-note \{/)
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
test("hammer's own rows carry the roster's published allowance", () => {
  const table = providerQuotaTable()
  assert.equal(table.groq.steadyTokensPerMonth, 15_000_000)
  assert.equal(table.openrouter.steadyTokensPerMonth, 1_000_000)
  assert.equal(table.kiro.steadyTokensPerMonth, 25_000)
  // Providers the roster owns outright keep their own figures.
  assert.equal(table['api-airforce'].steadyTokensPerMonth, 24_000_000)
})

// The roster is a second-hand source and one row is demonstrably wrong: it records 150M
// tokens/month for llm7 where the vendor publishes 100,000 tokens per rolling 24 hours. A
// bar drawn against a figure ~50x the real cap reports a spent allowance as unspent, so the
// corrected record replaces the number, names the vendor doc it came from, and keeps the
// window the vendor publishes rather than restating a daily cap as a monthly grant.
test("a vendor-corrected allowance replaces the roster's figure", () => {
  const llm7 = providerQuotaTable().llm7
  assert.equal(llm7.steadyTokensPerMonth, null)
  assert.deepEqual(
    { metric: llm7.limits[0].metric, limit: llm7.limits[0].limit, period: llm7.limits[0].period },
    { metric: 'tokens', limit: 100_000, period: 'day' },
  )
  // The corrected daily cap leads; the published minute/hour request ceilings follow it.
  assert.equal(llm7.limits.length, 3)
  assert.ok(llm7.limits.some((limit) => limit.metric === 'requests' && limit.period === 'minute'))
  assert.ok(llm7.limits.some((limit) => limit.metric === 'requests' && limit.period === 'hour'))
  assert.match(llm7.numericSource, /LLM7 limits doc/)
  assert.equal(llm7.sourceUrl, 'https://docs.llm7.io/limits')
  // A provider with no correction keeps both the roster's figure and its attribution.
  assert.equal(providerQuotaTable().groq.steadyTokensPerMonth, 15_000_000)
  assert.match(providerQuotaTable().groq.numericSource, /OmniRoute free-tier roster/)
})

// KiloCode's free pool is published as 200 requests/hour per IP, which is a rolling window:
// hammer keeps sixty one-minute buckets so the row can draw against the traffic it actually
// carried in the last hour, and a fixed hour bucket that reset at the top of the hour would
// report zero for calls still inside the provider's window.
test('a per-hour limit draws against the rolling hour hammer records', () => {
  const kilocode = providerQuotaTable().kilocode
  assert.deepEqual(
    kilocode.limits.map(({ metric, limit, period }) => ({ metric, limit, period })),
    [{ metric: 'requests', limit: 200, period: 'hour' }],
  )
  assert.equal(kilocode.window, 'hour')
  assert.match(kilocode.source, /200 requests\/hour per IP/)
  assert.match(dashboard, /hour: 'HOUR'/)
  assert.match(dashboard, /hour: 'requestsLastHour'/)
  assert.match(dashboard, /hour: \['requestsLastHour', 'in the last hour'/)
  // The hourly window is recognised, and a window with no recorded counter keeps its total and
  // gets no bar instead of being dropped.
  assert.match(dashboard, /if \(\/\\bhour\\b\|hourly\|per\\s\*hour\/\.test\(text\)\) return 'hour'/)
  assert.match(dashboard, /const used = field \?/)
  assert.match(dashboard, /remaining: used == null \? null : Math\.max\(0, total - used\)/)
})

test("a published figure is attributed without displacing the provider's own citation", () => {
  const table = providerQuotaTable()
  const groq = table.groq
  assert.match(groq.numericSource, /OmniRoute free-tier roster/)
  // The link still answers "where do I read about this plan?" — it is the provider's page.
  assert.equal(groq.sourceUrl, 'https://console.groq.com/docs/rate-limits')
  // The free-tier request ceilings sit beside the roster's monthly token grant: the
  // catalog states 30 requests/minute and 1,000/day, while the month figure keeps its
  // own attribution.
  assert.equal(groq.limits.length, 3)
  const monthly = groq.limits.find((limit) => limit.metric === 'tokens' && limit.period === 'month')
  assert.deepEqual(
    { metric: monthly.metric, limit: monthly.limit, period: monthly.period },
    { metric: 'tokens', limit: 15_000_000, period: 'month' },
  )
  assert.match(monthly.source, /OmniRoute free-tier roster/)
  assert.ok(groq.limits.some((limit) => limit.metric === 'requests' && limit.period === 'minute'))
  // ∞ is a statement, not a default: exactly one provider record is allowed to make it.
  assert.equal(providerQuotaTable().gptfree.unlimited, true)
  assert.equal(
    Object.values(providerQuotaTable()).filter((quota) => quota.unlimited === true).length,
    1,
  )
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
  assert.match(
    server,
    /if \(countProxyRequest\) \{[\s\S]{0,1200}?recordUsageBuckets\(entry, sample\)/,
  )
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
  const numeric = Object.values(table).filter(
    (quota) => Array.isArray(quota.limits) && quota.limits.length > 0,
  )
  // 17, down from 19: the vendored `gemini` row carried a 60M tokens/month figure that was
  // retired with the row (2026-11-08) — Google no longer publishes free-tier numbers, quotas
  // are per project in AI Studio (see docs/PROVIDER-FREE-TIER-AUDIT.md) — and the duplicate
  // `ollama-cloud` row went the same day, its 20M/month figure staying on `ollama`. A figure
  // nobody can source must not render a bar.
  assert.ok(
    numeric.length >= 17,
    `expected a wide spread of published limits, saw ${numeric.length}`,
  )
  for (const quota of numeric) {
    for (const limit of quota.limits) {
      assert.ok(limit.limit > 0, `${quota.source} limit must be positive`)
      // Every period here has a recorded counter to draw against: KiloCode's 200 requests/hour
      // free pool is measured against the trailing hour, and Token Harbor's 60 requests/minute
      // against the current minute of the same ring.
      assert.ok(['minute', 'hour', 'day', 'week', 'month', 'lifetime'].includes(limit.period))
    }
  }
  // The minute limit needs the same treatment as the hourly one: both surfaces read the
  // newest bucket of the trailing-hour ring for it.
  assert.match(dashboard, /minute: 'requestsLastMinute'/)
  assert.match(harness, /minute: 'requestsLastMinute'/)
})

// A stated reset that has already passed means the window it described no longer exists: the
// counter's "18 left" is history, and a countdown has nothing to count. Hammer used to render
// both, which is how a BazaarLink row read "20 requests / window · 18 left · resets in now"
// while every one of its nine stated resets sat ~43 minutes in the past.
test('an elapsed reset drops the window instead of counting down to "now"', () => {
  assert.doesNotMatch(dashboard, /return 'now'/)
  assert.match(
    dashboard,
    /if \(window\.total != null && window\.total > 0\s*\n\s*&& window\.resetAt != null && window\.resetAt <= Date\.now\(\)\) return/,
  )
  assert.match(dashboard, /const resetMs = w\.resetAt == null \? null : w\.resetAt - Date\.now\(\)/)
  assert.match(dashboard, /resetMs <= 0 \? '' : `resets in \$\{formatQuotaReset\(resetMs\)\}`/)
  // Under a minute the countdown counts seconds; rounding used to print "resets in 0m".
  assert.match(dashboard, /if \(minutes > 0\) return `\$\{minutes\}m`/)
  assert.match(dashboard, /return `\$\{total\}s`/)
})

test('an Antigravity model is not exhausted while another account has allowance', () => {
  // Antigravity scopes its allowance per model and per account. One account at 100% must
  // not paint its reset clock across a model when the other signed-in account still has
  // 61% of the same model's window left.
  assert.match(dashboard, /function hasAlternativeAntigravityQuota\(m\)/)
  assert.match(dashboard, /window\.percentOnly && window\.usedPercent != null/)
  assert.match(dashboard, /100 - Number\(window\.usedPercent\)/)
  assert.match(dashboard, /Number\.isFinite\(remaining\) && remaining > 0/)
  assert.ok(dashboard.includes('hasAlternativeAntigravityQuota(m)'))
})

test('an exhausted weekly allowance supplies the countdown over a shorter retry header', () => {
  // Token Harbor's free-tier 429 carries retry-after: 3600 while the body says the weekly
  // allowance returns days later. Both are real statements, but only the allowance reset can
  // reopen the row; the dashboard must not count down one hour and then re-bench it.
  assert.match(dashboard, /const exhaustedQuotaResets =/)
  assert.match(dashboard, /\.\.\.exhaustedQuotaResets/)
})

test("a clock's countdown also follows a reset the body states in words", () => {
  // A row kept a bare clock unless the response said "retry in Ns" or carried an
  // X-RateLimit-Reset header. Antigravity's 429 says "Resets in 161h41m31s": the same
  // promise in different words, which the parser now reads.
  assert.ok(dashboard.includes('(?:retry|resets?|renews?)'))
  assert.ok(dashboard.includes('durationFromText(statedDelay[1])'))
  assert.ok(dashboard.includes("name.startsWith('ms') || name.startsWith('millisecond')"))
})

test('a clock with a countdown suppresses the refusal under Test', () => {
  // The status column already names the window and when it ends; the provider's raw 429 body
  // under the Test button repeats that statement. A bare clock still keeps the body, because
  // then the text is the only thing that says what the row is waiting for.
  assert.ok(dashboard.includes('const clockedWithCountdown ='))
  assert.ok(
    dashboard.includes(
      'owner != null && isRateLimitedRow(owner) && getRateLimitResetAt(owner) != null',
    ),
  )
  assert.ok(dashboard.includes('!expired && !clockedWithCountdown && lastResponse.error'))
  assert.ok(!dashboard.includes('void clocked'))
})

test('plot colours come from the model mark, not the provider', () => {
  // Both plots used to hue by provider, so every model of one provider shared a colour and a
  // usage plot could not tell two families apart. The accent is the mark's most common
  // colour, greys skipped; a greyscale mark falls back to its second most common bucket,
  // because the first is the ground.
  assert.ok(dashboard.includes('function accentFromImage('))
  assert.ok(dashboard.includes('function modelAccent('))
  assert.ok(dashboard.includes('function modelMarkHrefs('))
  assert.ok(dashboard.includes('Math.max(r, g, b) - Math.min(r, g, b) <= 24'))
  assert.ok(
    dashboard.includes(
      'ranked.find((bucket) => !bucket.grey) || (ranked.length > 1 ? ranked[1] : ranked[0])',
    ),
  )
  assert.ok(dashboard.includes('bucket.n >= total * 0.02'))
  // A monochrome mark has no colour to lend: black or white would vanish against the plot.
  assert.ok(dashboard.includes('if (lum < 0.12 || lum > 0.9) return null'))
  // Every plot that used to paint a provider hue now prefers the model's own colour.
  // The scatter that read the mark's accent is gone: the slope plot lives in the composer
  // popup now, where each dot is hued by provider because there are no model marks to read.
  assert.ok(dashboard.includes('fill: accent || `hsl(${hue} 65% 55%)`'))
  assert.ok(dashboard.includes('fill: accent || `hsl(${hue} 70% 55%)`'))
})

test('the model table and the rail draw one limit bar per account', () => {
  // The row carries the accounts, so every bar surface reads the same facts rather than each
  // inventing a per-account view of its own.
  assert.match(modelsRoute, /credentials: \(\(\) => \{/)
  assert.match(modelsRoute, /if \(!pool \|\| pool\.count < 2\) return null/)
  assert.match(modelsRoute, /usage: ctx\.credentialRecordedUsage\b/)
  assert.match(dashboard, /function accountBarsHtml\(m, kind\)/)
  assert.match(dashboard, /data-quota-accounts=/)
  // A credential's reported number is an allowance, so it is a quota window in both columns:
  // stamping it with the column's kind drew the same report in Rate limit as a throttle.
  assert.match(dashboard, /function accountWindows\(account\)/)
  assert.match(dashboard, /const kind = 'quota'/)
  // Quota and Rate limit both fan out, on the model rows and on the provider tables.
  assert.match(dashboard, /const accountBars = accountBarsHtml\(m, 'quota'\)/)
  assert.match(dashboard, /const accountBars = accountBarsHtml\(m, 'rate-limit'\)/)
  assert.match(
    dashboard,
    /const accountBars = accountBarsHtml\(model \|\| poolAccountRow\(provider\), 'quota'\)/,
  )
  assert.match(
    dashboard,
    /const accountBars = accountBarsHtml\(model \|\| poolAccountRow\(provider\), 'rate-limit'\)/,
  )
  assert.match(dashboardCss, /\.quota-row-accounts \{[\s\S]*?display: flex/)
  assert.match(harness, /function railQuotaAccounts\(row\)/)
  assert.match(harness, /hx-quota-account-list/)
  assert.match(harness, /paint\(railQuotaWindows\(row\), railQuotaAccounts\(row\)\)/)
  // The rail's copy of the row has to carry the pool, or the fan-out above never runs: the
  // sidebar drew one bar (or ∞) for a provider the table drew as two columns.
  assert.match(
    harness,
    /credentials: Array\.isArray\(row\.credentials\) \? row\.credentials : null/,
  )
  // A window a provider reported for one key belongs to that key's column only. Handing every
  // column every window drew the other key's bar, and the same bar twice in the Google pools.
  assert.match(
    dashboard,
    /window\?\.accountIndex == null \|\| Number\(window\.accountIndex\) === account\.index/,
  )
  assert.match(
    harness,
    /window\?\.accountIndex == null \|\| Number\(window\.accountIndex\) === index/,
  )
  // The rail's empty readings are the table's two: ∞ is a stated absence of a limit, and the
  // unknown bar is "nothing measured yet". The rail used to call both of them ∞.
  // The signature carries the line under the bar now: a column with no counter of its own
  // says which counter is empty (see the test below).
  assert.match(harness, /function railQuotaUnknownHtml\(kind, meta\)/)
  assert.match(harness, /function railQuotaUnlimitedHtml\(kind\)/)
  assert.match(harness, /const unlimited = row\?\.knownQuota\?\.unlimited === true/)

  const harnessCss = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  assert.match(harnessCss, /\.hx-quota-account-list \{[\s\S]*?display: flex/)
})

test('the rail draws the bars of the model that answered, not just the pick', () => {
  // A fallback answers with a model the router's pick never named, and the composer's strip
  // already says so (`noteAnsweredModel` outranks the status route). The rail read only
  // `ctx.routedModel`, so a turn served by a fallback left the pick's windows in the sidebar
  // beside a strip naming another model — a quota read for a model that was not the one serving.
  // One subject now decides both the label and the row, so the two cannot name different models.
  assert.match(harness, /function quotaSubject\(ctx\) \{/)
  assert.match(harness, /const subject = quotaSubject\(ctx\)/)
  assert.match(harness, /modelEl\.textContent = subject\.label/)
  assert.match(harness, /const rowKey = subject\.key/)
  // An answer the transcript's newest row does not agree with is not this turn's answer, and an
  // answer that resolves to no table row is no better than the pick.
  assert.match(harness, /answeredName === rowName/)
  assert.match(harness, /key !== routedKey && stored/)
  // The answer's row is stored with the name it prints, so the label is not guessed back out of
  // the id when the bars switch to another model.
  assert.match(harness, /label: row\.label \|\| null,/)
  assert.match(harness, /providerName: providerName \|\| null,/)
  // A new answer repaints the rail now: the next status frame keeps naming the pick.
  assert.match(
    harness,
    /function noteAnsweredModel\(ctx, model\) \{[\s\S]{0,400}renderQuota\(ctx\)/,
  )
})

test('the row counter is only sent while it is today’s, and the log write leaves the loop', () => {
  // `recordUsage` rolls the daily counter over by rewriting `dailyDate` on the next request, so
  // a row idle since yesterday still holds yesterday's figure. The provider total skips those
  // entries; the row field did not, and /api/models served eight-day-old traffic as today's.
  assert.match(
    modelsRoute,
    /dailyProxyCount:\s*usageEntry\?\.dailyDate === today \? Number\(usageEntry\.dailyProxyCount\) \|\| 0 : 0,/,
  )
  // The request log reaches tens of megabytes (50 entries × ~620 KB), and writeFileSync on it
  // stalled the event loop — the one serving /v1 — for hundreds of milliseconds per burst.
  assert.match(server, /let logSaveInFlight = null;/)
  assert.match(server, /await fsp\.rename\(tmpPath, LOGS_PATH\);/)
  assert.doesNotMatch(server, /writeFileSync\(LOGS_PATH/)
  // Infinity cannot cross the wire: /api/models sends null, so a filter written against
  // Infinity excluded nothing and let unmeasured rows through a gate meant to keep them out.
  assert.match(dashboard, /isRowUp\(m\) && Number\.isFinite\(m\.avg\)/)
})

test('a cell never calls a row unused when its own plot shows traffic', () => {
  // The Google row draws one column per signed-in account. Those counters are empty (traffic
  // is not attributed per key there) while the row's own counter — the one the plot and the
  // row bar read — carries the requests, so the cell said "no usage recorded yet" directly
  // beside a plot of that usage. The line now describes the counter the cell was given.
  assert.match(dashboard, /function usageHasSamples\(usage\)/)
  assert.match(dashboard, /function quotaUnknownHtml\(kind, \{ meta \} = \{\}\)/)
  assert.match(dashboard, /no per-account usage recorded/)
  // "limit not published" is the cell's own readout line now, so the meta says the traffic was
  // recorded without repeating the claim about the limit.
  assert.match(
    dashboard,
    /meta: usageHasSamples\(m\?\.recordedUsage\) \|\| usageHasSamples\(m\?\.providerRecordedUsage\)\s*\? 'usage recorded'/,
  )
  assert.match(harness, /function railUsageHasSamples\(usage\)/)
  assert.match(harness, /function railQuotaUnknownHtml\(kind, meta\)/)
  assert.match(harness, /no per-account usage recorded/)
})

test('a served request is attributed to the credential that answered it', () => {
  // The sample is taken where the answer is relayed, so the account that actually served it
  // is the one whose bar moves — not whichever account the pool would pick next.
  assert.match(proxyRoute, /let selectedCredential = null/)
  assert.equal((proxyRoute.match(/credential: selectedCredential/g) || []).length, 3)
  assert.match(server, /credentialUsageStats\.set\(/)
  assert.match(server, /CREDENTIAL_USAGE_PATH/)
})

test('a stated allowance is a quota, and only a short clock makes it a rate limit', () => {
  // g4f answers with 500 requests and 5M tokens that reopen the next day. The header fields
  // describe an allowance, but the cell stamped them as `kind: 'rate-limit'` with the period
  // hardcoded, so the row carried two quotas in its Rate limit box and nothing in Quota.
  assert.match(dashboard, /function quotaRowLimitPeriod\(resetAt, now = Date\.now\(\)\)/)
  assert.match(dashboard, /period: quotaRowLimitPeriod\(rateLimit\.resetTokensAt \|\| retryReset\)/)
  assert.match(
    dashboard,
    /period: quotaRowLimitPeriod\(rateLimit\.resetRequestsAt \|\| retryReset\)/,
  )
  assert.match(harness, /function railQuotaLimitPeriod\(resetAt, now = Date\.now\(\)\)/)
  assert.match(harness, /period: railQuotaLimitPeriod\(rateLimit\.resetTokensAt \|\| retryReset\)/)
  assert.match(
    harness,
    /period: railQuotaLimitPeriod\(rateLimit\.resetRequestsAt \|\| retryReset\)/,
  )
  // Nothing else may pin one of those counters to the throttle column.
  assert.doesNotMatch(dashboard, /kind: 'rate-limit',\s*period: 'window'/)
  assert.doesNotMatch(harness, /kind: 'rate-limit',\s*period: 'window'/)
})
