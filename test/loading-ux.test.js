import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { serverSource } from './support/server-source.js'

const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const harnessJs = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')
const server = serverSource

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
  // The plot's card carried a "Current" readout of the routed model; the card is gone, and
  // nothing else names it, so nothing has to be seeded for it.
  assert.doesNotMatch(html, /id="kpi-best"/)
  assert.doesNotMatch(dashboard, /kpi-best|setKpiBest/)
  // The scatter moved into the composer popup, so the shell no longer seeds it.
  assert.doesNotMatch(html, /id="speed-intell-svg"/)

  // The containers the snapshot fills announce their state to assistive tech too.
  assert.match(html, /<div class="kpi-grid" id="kpi-grid" aria-busy="true">/)
  assert.match(html, /<div id="models-view" aria-busy="true">/)
  assert.match(html, /<div id="providers-panel"[^>]*aria-busy="true">/)

  // An outage has its own line rather than borrowing the loading or failed one: the router is
  // fine and the page is fine, so it must neither pulse like a wait nor offer a retry that
  // cannot help.
  assert.match(html, /<p id="offline-notice" class="load-status is-offline"[^>]*hidden>/)
  assert.match(dashboard, /function setOfflineNotice\(visible\)/)
  assert.match(dashboard, /window\.addEventListener\('offline', \(\) => setOfflineNotice\(true\)\)/)
  assert.match(
    dashboard,
    /window\.addEventListener\('online', \(\) => \{[\s\S]{0,160}loadModelSnapshot\(\)/,
  )
  // The console says the same thing where a failed send is read, and only clears the line it
  // wrote itself.
  assert.match(harnessJs, /const OFFLINE_HINT = 'No internet connection/)
  assert.match(harnessJs, /function watchConnectivity\(\) \{/)
  assert.match(harnessJs, /if \(ctx && ctx\.hint === OFFLINE_HINT\) setHint\('', null, ctx\)/)
  assert.match(harnessJs, /activate\(main\)\n\s*watchConnectivity\(\)/)

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
  const listed = [...listMatch[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  const inMarkup = [...html.matchAll(/class="[^"]*\bis-loading\b[^"]*"\s+id="([^"]+)"/g)].map(
    (m) => m[1],
  )
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
  assert.doesNotMatch(
    dashboard,
    /\n {4}loadSettings\(\)\.catch\(e => console\.error\('Initial loadSettings failed/,
  )

  assert.match(
    dashboard,
    /const displayGroups = searchTerm \? null : splitDisplayGroups\(sortedGroups\(groupModels\(allModels\)\)\);/,
  )
  assert.match(
    dashboard,
    /updateKpiNumbers\(allModels, currentBestModelId, currentBestProviderKey, displayGroups\);/,
  )
  assert.match(dashboard, /whenIdle\(async \(\) => \{/)
  // The grid: refreshed from this snapshot's roster once it exists, and built through its own
  // idle slot the first time (painting ~125 cards is itself a long task). Two snapshots can
  // arrive while that first build is still queued, so the state distinguishes "already built"
  // from "being built" — otherwise each of them decides to build it and every card renders twice.
  assert.match(
    dashboard,
    /if \(providerPanelState === 'ready'\) \{\s*await loadSettings\(lastProviderRoster\);/,
  )
  assert.match(dashboard, /if \(providerPanelState === 'building'\) \{/)
  assert.match(
    dashboard,
    /providerPanelState = 'building';\s*whenIdle\(\(\) => \{\s*loadSettings\(lastProviderRoster\)\.catch\(e => console\.error\('Initial loadSettings failed:', e\)\);/,
  )
  assert.match(dashboard, /providerPanelState = 'ready';/)
})

test('one grouping per snapshot serves both the table and the readouts', () => {
  assert.match(dashboard, /function render\(isUserAction = false, precomputedGroups = null\)/)
  assert.match(dashboard, /\(precomputedGroups && !searchTerm\)/)
  assert.match(
    dashboard,
    /function updateKpiNumbers\(models, bestModelId, bestProviderKey = null, displayGroups = null\)/,
  )
  assert.match(
    dashboard,
    /const \{ mainGroups \} = displayGroups \|\| splitDisplayGroups\(sortedGroups\(groupModels\(models\)\)\);/,
  )
})

test('a live event still paints the numbers on its own frame', () => {
  // The staging above applies to the boot only. A fallback names a model on the SSE frame, and
  // every surface that names it has to move on that same frame. The wrapper is numbers-only now
  // that the network plot is gone.
  assert.match(
    dashboard,
    /function updateKPIs\(models, bestModelId, bestProviderKey = null\) \{\s*updateKpiNumbers\(models, bestModelId, bestProviderKey\);\s*\}/,
  )
  assert.match(
    dashboard,
    /render\(\);\s*updateKPIs\(allModels, currentBestModelId, currentBestProviderKey\);/,
  )
  assert.doesNotMatch(dashboard, /drawPlots|drawBipartiteTopology|bg-topology-svg/)
})

test('brand marks are decoration and arrive after the first paint', () => {
  assert.match(dashboard, /let decorationsReady = false;/)
  assert.match(
    dashboard,
    /function faviconHrefs\(domains\) \{\s*if \(!decorationsReady\) return \[\];/,
  )
  // The idle pass flips the flag and re-renders once, which is what swaps the monograms for the
  // marks in the table.
  assert.match(dashboard, /decorationsReady = true;[\s\S]{0,500}render\(false\);/)
  assert.doesNotMatch(dashboard, /:dec=\$\{decorationsReady/)
})

test('the ping history is no longer shipped on every row', () => {
  assert.match(server, /const includePings = String\(req\.query\?\.pings \|\| ''\) === '1'$/m)
  // The row is built by spreading the internal result, so the history has to be removed rather
  // than merely not added: a key the spread already copied cannot be un-copied by a later
  // property in the same literal.
  assert.match(server, /if \(!includePings\) delete out\.pings$/m)
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
    assert.match(body, /const usagePending = providerUsagePending\(\)$/m)
    assert.match(body, /if \(usagePending\) kickProviderUsageRefresh\(\)$/m)
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
  assert.match(
    server,
    /broadcastRouterEvent\(\{ type: 'provider-usage', revision: providerUsageRevision \}\)/,
  )

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
  assert.match(
    dashboard,
    /function refreshProviderUsageUi\(\) \{\s*if \(!providerPanelReady\(\)\) return;\s*loadSettings\(\)\.catch\(\(\) => \{ \}\);/,
  )
  assert.match(
    dashboard,
    /payload\.type === 'provider-usage'\) \{[\s\S]{0,240}refreshProviderUsageUi\(\);/,
  )
  // Handled before the revision bump: it moves no row and no selection, and it arrives while the
  // first snapshot is usually still on the wire — counting it would discard that snapshot and
  // leave the page on its skeleton.
  assert.match(
    dashboard,
    /if \(payload\.type === 'provider-usage'\) \{[\s\S]{0,400}return;\s*\}\s*routerEventRevision\+\+;/,
  )
  assert.doesNotMatch(dashboard, /\|\| payload\.type === 'provider-usage'\) \{\s*scheduleRefresh/)
})

test('one unreachable usage endpoint cannot hold the refresh for the full ping timeout', () => {
  assert.match(
    server,
    /const PROVIDER_USAGE_BUDGET_MS = Number\(process\.env\.HAMMER_USAGE_REFRESH_BUDGET_MS\) \|\| 5_000;/,
  )
  assert.match(server, /async function fetchProviderUsageReportWithinBudget\(config, providerKey\)/)
  assert.match(server, /Promise\.race\(\[\s*fetchProviderUsageReport\(config, providerKey\),/)
  assert.match(
    server,
    /const result = await fetchProviderUsageReportWithinBudget\(currentConfig, providerKey\);/,
  )
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
  assert.match(
    server,
    /\.catch\(\(\) => \(\{ body: Buffer\.alloc\(0\), contentType: 'text\/plain', ok: false, at: Date\.now\(\) \}\)\)/,
  )
})

// ── The instrument ───────────────────────────────────────────────────────────────────────

test('boot timing is available on request and never changes what is drawn', () => {
  assert.match(
    dashboard,
    /const PERF_ENABLED = \/\(\^\|\[\?&\]\)perf\(\[=&\]\|\$\)\/\.test\(window\.location\.search\);/,
  )
  assert.match(dashboard, /function perfMark\(name\) \{[\s\S]{0,120}if \(!PERF_ENABLED\) return;/)
  assert.match(
    dashboard,
    /function perfReport\(\) \{[\s\S]{0,160}if \(!PERF_ENABLED \|\| perfReported \|\| perfMarks\.length === 0\) return;/,
  )
  assert.match(dashboard, /perfMark\('table'\);/)
  assert.match(dashboard, /perfMark\('providers'\);/)
  // A stage that never completes still leaves the marks that did.
  assert.match(dashboard, /if \(PERF_ENABLED\) setTimeout\(perfReport, 15000\);/)
})
// ── Waiting for the first token ──────────────────────────────────────────────────────────

test('the inspector rail carries both context and routed-row quota', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  // The context meter is named and separate from the quota meter: one says how full this
  // conversation is, the other how much of the routed model's allowance is left.
  assert.match(html, /id="hx-context-bar"/)
  assert.match(html, /id="hx-context-value"/)
  assert.match(html, /id="hx-quota-windows"/)
  assert.match(html, /id="hx-quota-model"/)
  // Quota comes from the same /api/models row the Router table reads, not a second estimate.
  assert.match(harness, /const quotaRowByModel = new Map\(\)/)
  assert.match(harness, /quotaRowByModel\.set\(/)
  assert.match(harness, /function renderQuota\(/)
  // The rail's two meters belong to the model that is routed now. A route change re-reads the
  // table instead of waiting for its minute to expire, and a row the table does not mention is
  // looked up once rather than answered with "no limit reported" from a stale read.
  assert.match(harness, /async function loadKnownTtfts\(\{ force = false \} = \{\}\)/)
  assert.match(harness, /if \(!force && Date\.now\(\) < ttftFreshUntil\) return/)
  assert.match(harness, /quotaMissLookup = \{ key: null, at: 0 \}/)
  assert.match(harness, /loadKnownTtfts\(\{ force: true \}\)/)
  assert.match(harness, /const settled =\n\s*quotaMissLookup\.key === rowKey/)
  assert.match(harness, /function railQuotaWindows\(/)
  assert.match(harness, /function railQuotaWindowHtml\(/)
  assert.match(harness, /row\?\.quotaWindows/)
  assert.match(harness, /row\?\.providerUsage/)
  // Pi's context figure arrives on status; a status refresh must not discard it.
  assert.match(harness, /if \(data\.contextUsage\)/)
  assert.match(harness, /if \(ctx\.routedModelKey && key !== ctx\.routedModelKey\)/)
  assert.match(harness, /contextUsage: data\.contextUsage/)
  assert.match(harness, /function routedContextWindow\(/)
  // The meter's own figures have to be readable and true: the remainder floors instead of
  // rounding up to the whole window, a measured sliver is not "0%", and a Pi with
  // auto-compaction off gets neither a "compacts at" wall nor a trigger tick.
  assert.match(harness, /function compactFloor\(n\)/)
  assert.match(harness, /compactFloor\(left\)/)
  assert.match(harness, /'<1%'/)
  assert.match(harness, /autoCompactionEnabled === false/)
  assert.match(
    harness,
    /if \(autoCompactionOff\) bar\.style\.removeProperty\('--hx-context-trigger'\)/,
  )
  // A window that is only a floor, or one the conversation has already outgrown, has no true
  // share. The meter says which case it is instead of pinning "100%" above "0 free" — the
  // reading that looked wrong whenever an estimate or a lower-bound window was in play.
  assert.match(harness, /function routedContextWindowExact\(/)
  assert.match(harness, /routed\.contextLowerBoundOnly === true/)
  assert.match(harness, /return !String\(row\.context \|\| ''\)\.startsWith\('>'\)/)
  // A prompt cap bounds the prompt, not the context Pi reports, so it never reads as an
  // overrun (see the prompt-cap case in context-window.test.js).
  assert.match(harness, /const over = measured && !promptCap && used > window_/)
  assert.match(harness, /const shareKnown = windowExact && !over/)
  // A share is never claimed against a floor: the value says the tokens are "over window"
  // or a lower bound, and the note names the window it could not fill.
  assert.match(harness, /in context · window at least/)
  assert.match(harness, /compactFloor\(used - window_\)\} over/)
  assert.match(harness, /bar\.classList\.toggle\('is-over', over\)/)
  // Past a floor the value states the bound it passed, not a share of it.
  assert.match(harness, /`>\$\{compact\(window_\)\}`/)
  assert.match(css, /\.hx-usage-bar\.is-context\.is-over > span/)
  assert.match(css, /repeating-linear-gradient/)
})

test('a live wait below the spine runs on the model’s own TTFT', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const harnessCss = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  // A tool row that says done is not the agent working: the gap before the next message is the
  // model composing, and a log that simply stops there is indistinguishable from a hang. The
  // ring's period is the router's measurement for the model it picked, not a guess.
  assert.match(harness, /function awaitingFirstToken\(ctx\)/)
  assert.match(harness, /if \(last\.kind === 'tool'\) return last\.status !== 'running'/)
  assert.match(harness, /function knownTtftMs\(ctx\)/)
  assert.match(harness, /fetch\('\/api\/models', \{ cache: 'no-store' \}\)/)
  assert.match(harness, /badge\.style\.setProperty\('--hx-ttft-ms'/)
  // It is the transcript's last child, so it hangs under the spine's end rather than mid-log.
  assert.match(harness, /transcript\.appendChild\(badge\)/)
  // It comes and goes with the wait, and restarts for each new one.
  assert.match(harness, /if \(badge\) badge\.remove\(\)/)
  assert.match(harness, /badge\.classList\.add\('hx-ttft-running'\)/)
  // A determinate 0-100% fill over the expected wait, not an endless spin: one pass, holding
  // full at 100%. The ring sits on the spine's own 2px column.
  assert.match(harnessCss, /animation: hx-ttft-fill var\(--hx-ttft-ms, 2000ms\) linear forwards;/)
  assert.match(harnessCss, /@keyframes hx-ttft-fill \{/)
  assert.match(harnessCss, /\.hx-ttft-arc \{[\s\S]{0,320}stroke-dashoffset: 56\.5;/)
  assert.doesNotMatch(harnessCss, /animation: hx-ttft-run/)
  assert.doesNotMatch(harnessCss, /@keyframes hx-ttft-run/)
  assert.match(harnessCss, /\.hx-ttft-ring \{[\s\S]{0,220}margin-left: -11px;/)
  assert.match(harnessCss, /@media \(prefers-reduced-motion: reduce\)/)
})

test('the rail estimates a quota ceiling the way the table does, and says so', () => {
  // The Router table synthesises an EST window from the traffic a model has carried when no
  // limit is published. The rail reads the same row and used to draw nothing for exactly those
  // models, so the one place a reader looks at the model the agent is on was the one place with
  // no allowance at all. Same rule, handed over rather than copied, and labelled the same way.
  const dashboardJs = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const harnessJs = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const harnessCss = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  assert.match(dashboardJs, /window\.hxEstimateLimitCeiling = estimateLimitCeiling/)
  assert.match(
    harnessJs,
    /window\.hxEstimateLimitCeiling === 'function' \? window\.hxEstimateLimitCeiling : null/,
  )
  assert.match(
    harnessJs,
    /const observedUsage = row\?\.knownQuota\?\.unlimited === true \? \{\} : row\?\.recordedUsage \|\| \{\}/,
  )
  assert.match(harnessJs, /estimated: true,/)
  assert.match(harnessJs, /window\.estimated \? `\$\{basePeriodLabel\} · EST` : basePeriodLabel/)
  assert.match(harnessJs, /window\.estimated \? ' is-estimated' : ''/)
  assert.match(harnessCss, /\.hx-quota-window\.is-estimated \.hx-quota-fill \{[^}]*opacity: 0\.62;/)
})

test('the send controls appear only when there is something to send', () => {
  // An empty composer is not a button with nothing to do. Send (or steer/queue, into a running
  // turn) used to be there always, disabled or not, which asks the reader what is wrong with it.
  // It now comes and goes with the text — or with a staged image — and Stop stays put, because
  // Stop is about the turn rather than the composer.
  const harnessJs = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(harnessJs, /const hasContent =/)
  assert.match(harnessJs, /state\.attachments\.length > 0/)
  assert.match(harnessJs, /send\.hidden = running \|\| !hasContent/)
  assert.match(harnessJs, /button\.hidden = !running \|\| !hasContent/)
  assert.match(harnessJs, /if \(stop\) stop\.hidden = !running\n/)
  // Every way the composer can gain or lose content repaints it: a keystroke, a restored draft,
  // and a staged or removed image.
  assert.match(
    harnessJs,
    /saveDraft\(active\(\), input\.value\)\n\s*\/\/[\s\S]{0,300}?updateComposer\(\)/,
  )
  assert.match(
    harnessJs,
    /input\.value = text\n\s*autoGrow\(\)\n\s*\/\/[\s\S]{0,200}?updateComposer\(\)/,
  )
  assert.match(
    harnessJs,
    /strip\.appendChild\(chip\)\n\s*\}\n\s*\/\/[\s\S]{0,200}?updateComposer\(\)/,
  )
})

test('the rail compaction buttons are bound through the panel element', () => {
  // `$` is getElementById, so `$('[data-compaction-toggle]')` was null and neither the
  // auto-compaction switch nor "Compact now" had a listener at all: the panel looked live and
  // did nothing. A selector is only ever reached through the panel element.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.doesNotMatch(harness, /\$\(\s*'\[[^\]]*\]'\)\s*\??\.addEventListener/)
  assert.match(harness, /compactionPanel\s*\??\.\s*querySelector\('\[data-compaction-now\]'\)/)
  assert.match(harness, /compactionPanel\s*\??\.\s*querySelector\('\[data-compaction-toggle\]'\)/)
})

// ── The models table order ──────────────────────────────────────────────────────────────
//
// The table has exactly one order: intelligence descending. The key it sorts on has to be the
// number the INT cell prints, or the column and the order disagree — a 40.9 heading above a 30
// one read as a bug because the comparator was reading the leading provider's own score and the
// heading was printing the strongest listed one.

test('the models table orders headings by the rating they print', () => {
  // The number a heading is banded and ordered by: the AA index when the row carries one, else
  // the local score as a percentage (the column itself now prints the band; see providers).
  assert.match(
    dashboard,
    /function benchmarkDisplayNumber\(m\) \{[\s\S]*?Number\.isFinite\(aa\) && aa > 0\) return aa;[\s\S]*?getBenchmarkSortValue\(m\.intell\) \* 100;/,
  )
  // Read from the strongest provider still listed: struck rows are summarised out of the
  // heading before it is drawn, so a paid row's better rating must not pull its model up.
  assert.match(
    dashboard,
    /function groupSortIntell\(group\) \{[\s\S]*?if \(isRowStruck\(m\)\) continue;[\s\S]*?return benchmarkDisplayNumber\(bestMember\);/,
  )
  // Intelligence descending is the primary key, ahead of the status/QoS/name tiebreakers.
  assert.match(
    dashboard,
    /const intellDelta = groupSortIntell\(b\) - groupSortIntell\(a\);\s*\n\s*if \(intellDelta !== 0\) return intellDelta;/,
  )
})
