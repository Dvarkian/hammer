import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')

// ── The loading shell ────────────────────────────────────────────────────────────────────
//
// The first snapshot is not instant, and until it lands none of the page's content exists: the
// table, both plots and the provider grid are all built from it. Every readout used to ship a
// literal `0` and both KPI cards a literal `Calculating...`, which is pixel-for-pixel what the
// dashboard shows when the router genuinely has nothing online — so a slow first read was
// indistinguishable from a broken one, and a broken one offered no way back.

test('the shell states that it is loading instead of printing zeroes', () => {
  assert.match(html, /<p id="load-status" class="load-status" role="status" aria-live="polite">/)
  assert.match(html, /id="load-status-text"/)
  // The only action a failed first load can offer.
  assert.match(html, /id="load-retry-btn"[^>]*onclick="retryInitialLoad\(\)"/)

  // No readout may be seeded with a value: "not read yet" has to stop looking like "none online".
  for (const id of ['readout-models', 'readout-combos', 'readout-providers', 'readout-rows']) {
    assert.match(html, new RegExp(`class="readout-value is-loading" id="${id}"`))
    assert.doesNotMatch(html, new RegExp(`id="${id}">\\d`))
  }
  assert.match(html, /class="kpi-value is-loading" id="kpi-best"/)
  assert.doesNotMatch(html, /id="kpi-best"[^>]*>Calculating/)
  assert.match(html, /class="kpi-value is-loading" id="speed-intell-count"/)

  // The containers the snapshot fills announce their state to assistive tech too.
  assert.match(html, /<div class="kpi-grid" id="kpi-grid" aria-busy="true">/)
  assert.match(html, /<div id="models-view" aria-busy="true">/)
  assert.match(html, /<div id="providers-panel"[^>]*aria-busy="true">/)

  assert.match(dashboard, /function beginLoadingState\(\)/)
  assert.match(dashboard, /function endLoadingState\(\)/)
  assert.match(dashboard, /function failLoadingState\(err\)/)
  assert.match(dashboard, /function setContainersBusy\(busy\)/)
})

test('every placeholder readout is one the loader knows how to clear', () => {
  // The failure this guards: a readout added to the markup but not to LOADING_VALUES keeps its
  // shimmer bar forever, which is a worse lie than the `0` it replaced.
  const listMatch = dashboard.match(/const LOADING_VALUES = \[([\s\S]*?)\];/)
  assert.ok(listMatch, 'LOADING_VALUES must exist')
  const listed = [...listMatch[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1])
  const inMarkup = [...html.matchAll(/class="[^"]*\bis-loading\b[^"]*"\s+id="([^"]+)"/g)].map(m => m[1])
  assert.ok(inMarkup.length > 0, 'the loading markup must be present')
  assert.deepEqual([...inMarkup].sort(), [...listed].sort())

  // Cleared by the loader that owns the values, not by a timer: a slow snapshot would otherwise
  // drop the placeholders while they were still the only thing on screen.
  assert.match(dashboard, /function markValuesLoaded\(\)/)
  assert.match(dashboard, /function endLoadingState\(\) \{[\s\S]{0,200}markValuesLoaded\(\)/)
})

test('placeholder rows and cards keep the layout and are removed before real data', () => {
  assert.match(html, /<template id="skeleton-row-template">/)
  assert.match(html, /<template id="skeleton-card-template">/)
  assert.match(dashboard, /function showSkeletonRows\(/)
  assert.match(dashboard, /function showSkeletonProviders\(/)
  // Placeholder rows carry no row key, so the keyed reconciler in render() could neither match
  // nor retire them: they must be gone before the first real render.
  assert.match(dashboard, /function clearSkeletonRows\(\)/)
  assert.match(dashboard, /clearSkeletonRows\(\);\s*try \{ render\(false, displayGroups\); \}/)
  assert.match(dashboard, /function failLoadingState\(err\) \{[\s\S]{0,400}clearSkeletonRows\(\)/)

  assert.match(css, /\.skeleton \{/)
  assert.match(css, /\.is-loading::after/)
  assert.match(css, /@keyframes skeleton-sweep/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.skeleton,/)
  assert.match(css, /\.skeleton-card \{/)

  // The network plot is the largest and last thing drawn, and it has no empty-state text of its
  // own, so it carries a placeholder until its first draw — which clears it, because both draw
  // paths empty the element before painting into it.
  assert.match(dashboard, /function setTopologyPlaceholder\(visible\)/)
  assert.match(dashboard, /svg\.dataset\.placeholder = '1';/)
  assert.match(dashboard, /if \(svg\.dataset\.placeholder !== '1'\) return; \/\/ never clear a real plot/)
  // And the first real draw drops the flag along with the markup it replaces.
  assert.match(dashboard, /svg\.innerHTML = '';\s*\/\/[\s\S]{0,300}delete svg\.dataset\.placeholder;/)
  assert.match(dashboard, /setTopologyPlaceholder\(true\);/)
  assert.match(dashboard, /function failLoadingState\(err\) \{[\s\S]{0,600}setTopologyPlaceholder\(false\);/)
})

test('a failed first snapshot is reported with a way back, and only the first one owns it', () => {
  assert.match(dashboard, /function retryInitialLoad\(\) \{[\s\S]{0,200}loadModelSnapshot\(\)/)
  assert.match(dashboard, /if \(loadingStateActive\) failLoadingState\(e\)/)
  // A failed *background* refresh must not replace a working dashboard with an error screen.
  assert.match(dashboard, /if \(loadingStateActive\) endLoadingState\(\)/)
})

// ── Staged boot ──────────────────────────────────────────────────────────────────────────

test('the model table does not wait for the provider roster', () => {
  // /api/models and /api/config used to be joined in one Promise.all, so the whole dashboard
  // waited for the slower of the two on every load — and the provider half is the one that can
  // sit on network work server-side.
  assert.doesNotMatch(dashboard, /Promise\.all\(\[\s*fetch\('\/api\/models'\)/)
  assert.match(dashboard, /const providersPromise = fetchProviderConfig\(\);/)
  assert.match(dashboard, /const modelsRes = await fetch\('\/api\/models'\);/)
  assert.match(dashboard, /function fetchProviderConfig\(\)/)
  assert.match(dashboard, /function applyProviderRoster\(providers\)/)
})

test('the boot paints the table, then the numbers, then decorates on idle', () => {
  assert.match(dashboard, /function whenIdle\(fn, timeoutMs = 1000\)/)
  assert.match(dashboard, /requestIdleCallback\(run, \{ timeout: timeoutMs \}\)/)
  // Browsers without requestIdleCallback still get the staging.
  assert.match(dashboard, /else setTimeout\(run, 32\)/)

  const boot = dashboard.indexOf('beginLoadingState();')
  const load = dashboard.indexOf('loadModelSnapshot().catch', boot)
  assert.ok(boot >= 0 && load > boot, 'the shell must be up before the snapshot is requested')
  // The provider grid is no longer built straight from the boot tail: that plus the snapshot's
  // own call made every page load render ~125 cards twice.
  assert.doesNotMatch(dashboard, /\n    loadSettings\(\)\.catch\(e => console\.error\('Initial loadSettings failed/)

  assert.match(dashboard, /const displayGroups = searchTerm \? null : splitDisplayGroups\(sortedGroups\(groupModels\(allModels\)\)\);/)
  assert.match(dashboard, /updateKpiNumbers\(allModels, currentBestModelId, currentBestProviderKey, displayGroups\);/)
  assert.match(dashboard, /whenIdle\(async \(\) => \{/)
  // The grid: refreshed from this snapshot's roster once it exists, and built through its own
  // idle slot the first time (painting ~125 cards is itself a long task). Two snapshots can
  // arrive while that first build is still queued, so the state distinguishes "already built"
  // from "being built" — otherwise each of them decides to build it and every card renders twice.
  assert.match(dashboard, /if \(providerPanelState === 'ready'\) \{\s*await loadSettings\(lastProviderRoster\);/)
  assert.match(dashboard, /if \(providerPanelState === 'building'\) \{/)
  assert.match(dashboard, /providerPanelState = 'building';\s*whenIdle\(\(\) => \{\s*loadSettings\(lastProviderRoster\)\.catch\(e => console\.error\('Initial loadSettings failed:', e\)\);/)
  assert.match(dashboard, /providerPanelState = 'ready';/)
})

test('one grouping per snapshot serves both the table and the readouts', () => {
  assert.match(dashboard, /function render\(isUserAction = false, precomputedGroups = null\)/)
  assert.match(dashboard, /\(precomputedGroups && !searchTerm\)/)
  assert.match(dashboard, /function updateKpiNumbers\(models, bestModelId, bestProviderKey = null, displayGroups = null\)/)
  assert.match(dashboard, /const \{ mainGroups \} = displayGroups \|\| splitDisplayGroups\(sortedGroups\(groupModels\(models\)\)\);/)
})

test('a live event still paints numbers and both plots on its own frame', () => {
  // The staging above applies to the boot only. A fallback names a model on the SSE frame, and
  // every surface that names it — pictures included — has to move on that same frame.
  assert.match(dashboard, /function updateKPIs\(models, bestModelId, bestProviderKey = null\) \{\s*updateKpiNumbers\(models, bestModelId, bestProviderKey\);\s*drawPlots\(models, bestModelId, bestProviderKey\);\s*\}/)
  assert.match(dashboard, /render\(\);\s*updateKPIs\(allModels, currentBestModelId, currentBestProviderKey\);/)
  assert.match(dashboard, /function drawPlots\(models, bestModelId, bestProviderKey = null\)/)
})

test('brand marks are decoration and arrive after the first paint', () => {
  assert.match(dashboard, /let decorationsReady = false;/)
  assert.match(dashboard, /function faviconHrefs\(domains\) \{\s*if \(!decorationsReady\) return \[\];/)
  // In the rebuild key, or a plot drawn during the wait would keep its monograms until its
  // membership happened to change.
  assert.match(dashboard, /\$\{W\}:\$\{H\}:dec=\$\{decorationsReady \? 1 : 0\}/)
  assert.match(dashboard, /decorationsReady = true;\s*drawPlots\(allModels, currentBestModelId, currentBestProviderKey\);/)
})

test('the ping history is no longer shipped on every row', () => {
  assert.match(server, /const includePings = String\(req\.query\?\.pings \|\| ''\) === '1';/)
  // The row is built by spreading the internal result, so the history has to be removed rather
  // than merely not added: a key the spread already copied cannot be un-copied by a later
  // property in the same literal.
  assert.match(server, /if \(!includePings\) delete out\.pings;/)
  assert.match(server, /lastProbeSuccessAt,/)
  // The dashboard reads the field, keeps the old scan only for a router that predates it.
  assert.match(dashboard, /const reported = Number\(m\?\.lastProbeSuccessAt\);/)
})

// ── Server: the snapshot is not gated on the usage fan-out ───────────────────────────────

const routeWindow = (start) => server.slice(start, start + 2400)

test('neither boot route waits on the provider-usage refresh', () => {
  const models = server.indexOf("app.get('/api/models', async (req, res) => {")
  const config = server.indexOf("app.get('/api/config', async (req, res) => {")
  assert.ok(models > 0 && config > models, 'both routes must exist')

  for (const start of [models, config]) {
    const body = routeWindow(start)
    assert.match(body, /const usagePending = providerUsagePending\(\);/)
    assert.match(body, /if \(usagePending\) kickProviderUsageRefresh\(\);/)
    // The statement this replaces — a single slow usage endpoint held the model table, both KPIs
    // and both plots for as long as PING_TIMEOUT while the page showed an empty grid. Matched on
    // its own line, because the comments above it quote the call they are explaining.
    assert.doesNotMatch(body, /^\s+await refreshProviderUsageReports\(\);$/m)
  }
  // /api/usage is the explicit "refresh now" surface and still waits for its answer.
  const usage = server.indexOf("app.get('/api/usage', async (req, res) => {")
  assert.match(routeWindow(usage), /await refreshProviderUsageReports\(\)/)
})

test('the payload says whether its usage reports are current', () => {
  assert.match(server, /function providerUsagePending\(\) \{/)
  assert.match(server, /function kickProviderUsageRefresh\(\) \{/)
  // Single-flight on the promise the waiting callers use, so a page asking during a refresh joins
  // it rather than starting a second wave of provider calls.
  assert.match(server, /return refreshProviderUsageReports\(\)/)
  assert.match(server, /providerUsageRevision \+= 1;/)
  assert.match(server, /broadcastRouterEvent\(\{ type: 'provider-usage', revision: providerUsageRevision \}\)/)

  const payload = server.indexOf('models: formatted,')
  assert.ok(payload > 0, 'the /api/models payload must exist')
  assert.match(server.slice(payload, payload + 900), /usagePending,/)

  // A card says "checking" rather than "this provider reports nothing" while the refresh it is
  // waiting on is still outstanding.
  assert.match(server, /quotaPending: usagePending/)
  assert.match(dashboard, /provider\?\.quotaPending === true/)
  assert.match(dashboard, /Quota <span class="quota-provenance">Checking…<\/span>/)
  assert.match(css, /\.quota-bars-pending \.quota-provenance/)
})

test('the page re-reads when the refresh lands, from either side of the race', () => {
  // The event covers a page that is connected; the delayed re-read covers a refresh that settled
  // before the stream attached. Both refresh the *provider payload* rather than the model
  // snapshot: the cards' quota boxes are the only surface on the page that reads these reports,
  // and re-reading ~341 rows to change none of them is a second of server work for nothing.
  assert.match(dashboard, /function scheduleUsageFollowUp\(\)/)
  assert.match(dashboard, /if \(data\.usagePending === true\) scheduleUsageFollowUp\(\);/)
  assert.match(dashboard, /function refreshProviderUsageUi\(\) \{\s*if \(!providerPanelReady\(\)\) return;\s*loadSettings\(\)\.catch\(\(\) => \{ \}\);/)
  assert.match(dashboard, /payload\.type === 'provider-usage'\) \{[\s\S]{0,240}refreshProviderUsageUi\(\);/)
  // Handled before the revision bump: it moves no row and no selection, and it arrives while the
  // first snapshot is usually still on the wire — counting it would discard that snapshot and
  // leave the page on its skeleton.
  assert.match(dashboard, /if \(payload\.type === 'provider-usage'\) \{[\s\S]{0,400}return;\s*\}\s*routerEventRevision\+\+;/)
  assert.doesNotMatch(dashboard, /\|\| payload\.type === 'provider-usage'\) \{\s*scheduleRefresh/)
})

test('one unreachable usage endpoint cannot hold the refresh for the full ping timeout', () => {
  assert.match(server, /const PROVIDER_USAGE_BUDGET_MS = Number\(process\.env\.HAMMER_USAGE_REFRESH_BUDGET_MS\) \|\| 5_000;/)
  assert.match(server, /async function fetchProviderUsageReportWithinBudget\(config, providerKey\)/)
  assert.match(server, /Promise\.race\(\[\s*fetchProviderUsageReport\(config, providerKey\),/)
  assert.match(server, /const result = await fetchProviderUsageReportWithinBudget\(currentConfig, providerKey\);/)
})

test('a cold favicon is fetched once per domain, not once per node', () => {
  // The plot draws a node per model and per provider and asks about a handful of domains, so
  // without this a first page load issued hundreds of identical multi-hop fetches — all of them
  // competing with the snapshot the page was actually waiting for.
  assert.match(server, /const faviconInFlight = new Map\(\)/)
  assert.match(server, /const inFlight = faviconInFlight\.get\(domain\)/)
  assert.match(server, /async function fetchFaviconUncached\(domain\) \{/)
  assert.match(server, /\.finally\(\(\) => faviconInFlight\.delete\(domain\)\)/)
  // The shared promise resolves to a miss rather than rejecting, so a failed icon is a monogram
  // and not an unhandled rejection.
  assert.match(server, /\.catch\(\(\) => \(\{ body: Buffer\.alloc\(0\), contentType: 'text\/plain', ok: false, at: Date\.now\(\) \}\)\)/)
})

// ── The instrument ───────────────────────────────────────────────────────────────────────

test('boot timing is available on request and never changes what is drawn', () => {
  assert.match(dashboard, /const PERF_ENABLED = \/\(\^\|\[\?&\]\)perf\(\[=&\]\|\$\)\/\.test\(window\.location\.search\);/)
  assert.match(dashboard, /function perfMark\(name\) \{[\s\S]{0,120}if \(!PERF_ENABLED\) return;/)
  assert.match(dashboard, /function perfReport\(\) \{[\s\S]{0,160}if \(!PERF_ENABLED \|\| perfReported \|\| perfMarks\.length === 0\) return;/)
  assert.match(dashboard, /perfMark\('table'\);/)
  assert.match(dashboard, /perfMark\('providers'\);/)
  // A stage that never completes still leaves the marks that did.
  assert.match(dashboard, /if \(PERF_ENABLED\) setTimeout\(perfReport, 15000\);/)
})
