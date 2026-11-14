    // Theme toggle
    (function() {
      const saved = localStorage.getItem('hammer-theme');
      if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();

    // Attach the access token (LAN mode) to every API call and prompt for it on 401.
    // Loopback (local) usage never sends a token and is unaffected.
    (function () {
      const TOKEN_KEY = 'hammer-access-token';
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (url, options) {
        const opts = options || {};
        const headers = new Headers(opts.headers || {});
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) headers.set('Authorization', 'Bearer ' + token);
        const res = await originalFetch(url, Object.assign({}, opts, { headers }));
        if (res.status === 401) {
          const wanted = window.prompt('This server requires an access token (LAN mode). Enter the token printed when hammer started:');
          if (wanted && wanted.trim()) {
            localStorage.setItem(TOKEN_KEY, wanted.trim());
            headers.set('Authorization', 'Bearer ' + wanted.trim());
            return originalFetch(url, Object.assign({}, opts, { headers }));
          }
        }
        return res;
      };
    })();

    // Restart the router, then come back to a freshly loaded page.
    //
    // This is not `location.reload()`: the provider registry, the model table and the catalog
    // are built once per process, so nothing short of a new process picks up a change to lib/ or
    // to the vendored provider catalog. The server answers 202 before it lets go of its
    // listener, so this can report progress instead of watching the connection die.
    //
    // Readiness is polled through this page itself rather than an API route: it costs the
    // server a static file read, where /api/models would rebuild the whole model table on every
    // poll. The unique query and no-store are both load-bearing — a cached copy of this page
    // answering from disk would report a router that is still down as back up.
    async function restartHammer() {
      const btn = document.getElementById('reload-btn');
      const label = document.getElementById('reload-label');
      const setLabel = text => { if (label) label.textContent = text; };
      if (btn) btn.disabled = true;
      setLabel('Restarting…');

      try {
        await fetch('/api/restart', { method: 'POST' });
      } catch {
        // A server that drops the socket on its way out has still restarted; the poll below,
        // not this call, is what decides whether it came back.
      }

      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 750));
        try {
          const res = await fetch(`/?ready=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            location.reload();
            return;
          }
        } catch {
          // Still coming up.
        }
      }

      setLabel('Restart failed');
      if (btn) {
        btn.disabled = false;
        btn.title = 'The router did not come back within 45s. Start it again manually, then reload this page.';
      }
    }

    function toggleTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('hammer-theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('hammer-theme', 'dark');
      }
      updateThemeIcon();
    }

    function updateThemeIcon() {
      const icon = document.getElementById('theme-icon');
      if (!icon) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      icon.textContent = isDark ? '☀️' : '🌙';
    }

    function updateLocalFileWarning() {
      const warning = document.getElementById('local-file-warning');
      if (!warning) return;
      warning.style.display = window.location.protocol === 'file:' ? 'block' : 'none';
    }

    // Run on DOMContentLoaded to ensure button exists
    document.addEventListener('DOMContentLoaded', updateThemeIcon);
    document.addEventListener('DOMContentLoaded', updateLocalFileWarning);

    // ── When the page is allowed to be busy ─────────────────────────────────────────────
    //
    // Idle scheduling with a floor and a ceiling. Decoration — the two plots, the provider
    // grid — is real work but it is not what the user came for, and every bit of it competes
    // with the table for the same thread. Pushing it to idle means the table is painted,
    // scrollable and searchable first, while the floor (`setTimeout`) keeps browsers without
    // requestIdleCallback working and the ceiling keeps a permanently busy page from leaving a
    // plot blank forever.
    function whenIdle(fn, timeoutMs = 1000) {
      // Async tasks are common here (the staged passes await the provider roster) and a rejection
      // has to land somewhere: an unhandled one is a console error with no stage attached to it.
      const run = () => {
        try {
          const result = fn();
          if (result && typeof result.catch === 'function') result.catch(e => console.error('Idle task failed:', e));
        } catch (e) {
          console.error('Idle task failed:', e);
        }
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: timeoutMs });
      else setTimeout(run, 32);
    }

    // ── Boot timing (`?perf`) ───────────────────────────────────────────────────────────
    //
    // The first snapshot is a sequence of stages that each look cheap and add up to a wait the
    // user experiences as one thing. Without marks there is no way to tell which stage owns it.
    // Off by default, on with `?perf`, and it never changes what is drawn.
    const PERF_ENABLED = /(^|[?&])perf([=&]|$)/.test(window.location.search);
    const perfMarks = [];
    let perfReported = false;

    function perfMark(name) {
      if (!PERF_ENABLED) return;
      perfMarks.push({ name, at: performance.now() });
    }

    function perfReport() {
      if (!PERF_ENABLED || perfReported || perfMarks.length === 0) return;
      perfReported = true;
      const first = perfMarks[0].at;
      const lines = [];
      let prev = first;
      for (const mark of perfMarks) {
        lines.push(`${mark.name.padEnd(18)} +${(mark.at - prev).toFixed(1)}ms  (t+${(mark.at - first).toFixed(1)}ms)`);
        prev = mark.at;
      }
      console.log(`[hammer perf] boot in ${(prev - first).toFixed(1)}ms\n${lines.join('\n')}`);
    }
    perfMark('shell');

    // ── The loading shell ───────────────────────────────────────────────────────────────
    //
    // Everything the first snapshot fills is one of these containers, and until that snapshot
    // lands there is nothing honest to put in them: the table, both plots and the provider grid
    // are all built from it. The page used to answer that with a dashboard full of zeroes and
    // an empty grid — pixel-for-pixel what it draws when the router genuinely has nothing
    // online — so a slow first read was indistinguishable from a broken one, and a broken one
    // offered no way back.
    const LOADING_CONTAINERS = ['kpi-grid', 'models-view', 'models-table-container', 'providers-panel'];
    const LOADING_VALUES = [
      'readout-models', 'readout-combos', 'readout-providers', 'readout-rows',
    ];
    // Whether the shell is still the only thing on screen. Refreshes after the first snapshot
    // are silent: the skeleton is a first-load affordance, and a page that flashes placeholder
    // rows every time the user clicks Test would be worse than the wait it describes.
    let loadingStateActive = false;

    function setLoadStatus(text, kind = 'loading') {
      const line = document.getElementById('load-status');
      if (!line) return;
      const textEl = document.getElementById('load-status-text');
      if (textEl) textEl.textContent = text || '';
      line.classList.toggle('is-failed', kind === 'failed');
      line.classList.toggle('is-settled', kind === 'settled');
      line.hidden = !text;
      const retry = document.getElementById('load-retry-btn');
      if (retry) retry.style.display = kind === 'failed' ? 'inline-block' : 'none';
    }

    // An outage is not a page that will not load. The router is on this machine, so the shell,
    // the cached catalog and the plots all arrive as usual — what stops is every provider
    // answering HTTP, and the table would otherwise just go quiet. Chromium knows the link state,
    // so the header says which silence this is, and the snapshot is asked for again the moment
    // the link returns: providers were benched for an outage that has just ended, and the page
    // should describe the connection that is there now rather than the one that wasn't.
    function setOfflineNotice(visible) {
      const line = document.getElementById('offline-notice');
      if (line) line.hidden = !visible;
    }

    window.addEventListener('offline', () => setOfflineNotice(true));
    window.addEventListener('online', () => {
      setOfflineNotice(false);
      if (!loadingStateActive) loadModelSnapshot().catch(() => {});
    });
    // A page opened mid-outage says so before the first provider call can fail.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) setOfflineNotice(true);

    function setContainersBusy(busy) {
      for (const id of LOADING_CONTAINERS) {
        const el = document.getElementById(id);
        if (el) el.setAttribute('aria-busy', busy ? 'true' : 'false');
      }
    }

    // Placeholder rows and cards, cloned from the templates in index.html. They are what keeps
    // the model card and the provider grids at something like their real height while empty,
    // instead of collapsing to a header and then jumping when the rows arrive.
    function showSkeletonRows(count = 6) {
      const tbody = document.getElementById('table-body');
      const tpl = document.getElementById('skeleton-row-template');
      if (!tbody || !tpl) return;
      tbody.textContent = '';
      for (let i = 0; i < count; i++) tbody.appendChild(tpl.content.cloneNode(true));
    }

    // The network plot is the largest thing on the page and the last to be drawn (it is idle work
    // and its brand marks are fetched after the first paint), so it says it is coming instead of
    // sitting empty beside a table that already has rows. The scatter needs no equivalent: it has
    // its own "No measurements yet" text and draws itself on the one-second status ticker.
    //
    // Written into the SVG rather than overlaid, because both draw paths already clear the element
    // (`svg.innerHTML = ''`) before they paint — so the placeholder cannot survive a real draw, and
    // nothing outside this pair of functions has to know it exists.
    function setTopologyPlaceholder(visible) {
      const svg = document.getElementById('bg-topology-svg');
      if (!svg) return;
      if (!visible) {
        if (svg.dataset.placeholder !== '1') return; // never clear a real plot
        svg.textContent = '';
        delete svg.dataset.placeholder;
        return;
      }
      svg.textContent = '';
      svg.dataset.placeholder = '1';
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '50%');
      text.setAttribute('y', '50%');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', '11');
      text.style.fill = 'var(--text-muted)';
      text.textContent = 'Loading the model network…';
      svg.appendChild(text);
    }

    // The placeholder rows carry no `data-row-key`, so the keyed reconciler in render() can
    // neither match nor retire them: left in place they would sit above the real table forever.
    // They come out immediately before the first real render, and after a failed one.
    function clearSkeletonRows() {
      const tbody = document.getElementById('table-body');
      if (tbody && tbody.querySelector('.skeleton-row')) tbody.textContent = '';
    }

    function showSkeletonProviders(count = 6) {
      const tpl = document.getElementById('skeleton-card-template');
      if (!tpl) return;
      for (const id of ['active-providers-container', 'setup-providers-container']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = '';
        for (let i = 0; i < count; i++) el.appendChild(tpl.content.cloneNode(true));
      }
    }

    function beginLoadingState() {
      loadingStateActive = true;
      perfMark('loading-shell');
      setContainersBusy(true);
      setLoadStatus('Loading router state…');
      showSkeletonRows();
      showSkeletonProviders();
      setTopologyPlaceholder(true);
      // The readouts go back to placeholders too. They are empty in the markup, but a *retry*
      // after a failed load (or anything that put the shell back up) would otherwise show the
      // numbers from the snapshot that failed next to a table of skeletons.
      for (const id of LOADING_VALUES) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('is-loading');
        el.textContent = '';
      }
    }

    // The first real numbers have been written, so the readouts stop being placeholders. Called
    // by the loader that owns the values rather than by a timer, or a slow snapshot would clear
    // the placeholders while they were still the only thing on screen.
    function markValuesLoaded() {
      for (const id of LOADING_VALUES) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('is-loading');
      }
    }

    function endLoadingState() {
      loadingStateActive = false;
      setContainersBusy(false);
      setLoadStatus('', 'settled');
      markValuesLoaded();
    }

    function failLoadingState(err) {
      loadingStateActive = false;
      setContainersBusy(false);
      // Skeleton rows are placeholder *rows*: leaving them in place after a failure would show
      // six models that do not exist. The plot's placeholder goes the same way — a card waiting on
      // a load that is not coming is the same lie as a row for a model that does not exist.
      clearSkeletonRows();
      setTopologyPlaceholder(false);
      setLoadStatus(`Could not read the router state (${err && err.message ? err.message : 'request failed'}).`, 'failed');
    }

    // The one action a failed first load offers. Only the model snapshot is retried: it is the
    // payload the page is missing, and the provider panel has its own retry in its own section.
    function retryInitialLoad() {
      beginLoadingState();
      perfMark('retry');
      loadModelSnapshot().catch(() => {});
    }

    let allModels = [];
    // provider::model -> time-series usage samples for the usage plots.
    // Each entry is { t: epochMs, ttft: ms|null, tps: tok/s|null, tokens: count|null }.
    const usageSeriesByKey = new Map();
    // The same samples, restricted to the conversation the agent rail is showing. That
    // plot is the transcript's own history — every turn it ever had — not what the running
    // router process happened to serve, so it is published per console (see
    // publishSessionUsage) rather than sliced out of the map above.
    const usageSessionByKey = new Map();
    // A rail legend is a key, not the catalog: keep the newest handful and summarize the rest.
    const SESSION_USAGE_LEGEND_LIMIT = 8;
    // Which session the plot above is currently showing. The rail's plot describes one
    // conversation (see publishSessionUsage), and it is redrawn whenever that conversation
    // changes — so the label and the data are always about the same transcript.
    let usageSessionShown = null;
    // What that history looked like when the plot last drew it (see usagePointsSignature).
    let usageSessionSignature = '';
    // Last time the series was fetched (so we only pull deltas).
    let usageSeriesLastFetchedAt = null;
    // In-flight guard so overlapping series fetches can't clobber each other.
    let usageSeriesFetching = false;
    // providerKey -> color hue for per-model sparklines (stable per provider).
    const usageProviderHue = (pk) => {
      let h = 0;
      for (const ch of String(pk)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      return Math.abs(h) % 360;
    };
    // providerKey -> the domains whose favicons may mark it in the topology plot, best first.
    // Sent by the router (see providerFaviconDomains), which derives them from the sites each
    // provider's own descriptor names — this replaced a hand-written list here that covered
    // hammer's own providers only, so every imported provider drew as a blank disc. A list rather
    // than one domain because a single derivation is a single guess: an endpoint on a hosting
    // platform, or a company domain with no icon where the provider's console has one, would
    // otherwise leave a node with no mark at all.
    let providerFaviconDomainLists = new Map();
    // Whether the running router serves brand marks itself (/api/favicon — see fetchFavicon in
    // lib/server.js). This file is read from disk on every load, so the page can be newer than
    // the process answering it, and when that route was introduced the plot asked a path that
    // process did not have: every image 404'd, every one of them hid itself, and the monogram
    // underneath — which is exactly what a domain with no icon draws — made "the router is
    // stale" indistinguishable from "the favicon service is down". `faviconDomain` ships in the
    // same release as the route, so its presence on the provider list is the capability test.
    // Without it the plot asks the third party directly, as it did before the route existed, and
    // says so on the card rather than going quiet.
    let faviconProxyAvailable = false;
    let searchTerm = '';
    // There is no per-column sort state: the models table has exactly one order, intelligence
    // descending (DEFAULT_SORT_CHAIN), and no control offers another. See updateSortHeaders.
    let currentRenderedOrder = [];
    let graveyardCurrentOrder = [];
    // Unavailable rows are only built while the graveyard panel is open; this holds the
    // latest groups so opening it can build them on demand.
    let pendingGraveyardGroups = [];
    // Row keys with a 'Test' request currently in flight (guards the Response cell
    // against being clobbered by live polling re-renders while the test runs).
    const inflightTests = new Set();
    // Contradictory status/result pairs that have already received an automatic
    // re-test. The signature changes when the server reports a new result/state.
    const automaticRetestSignatures = new Map();
    // Automatic re-tests are trivial to schedule and expensive to run, so a row is held
    // to this cooldown however its signature changes: a model that keeps answering a
    // test with the same class of failure must not be re-tested every poll.
    const AUTOMATIC_RETEST_COOLDOWN_MS = 10 * 60_000;
    const automaticRetestAt = new Map();
    // ── Retrying the rows that are only waiting ────────────────────────────────────────
    //
    // A rate limit or an exhausted quota is the provider saying "later", not "never": the
    // row comes back on its own, so the one thing needed to notice is another test. A row
    // carrying one of those verdicts — never a paid or dead one, which no retry can change —
    // is therefore tested again every minute. The plot's line decides the order — rows it
    // could reach are tried first — but not who qualifies: a benched row is never on that
    // line while it is benched, so gating on it scheduled nothing at all. The waits are kept
    // here, one per row, and drawn beside the Test button as a countdown (see autoRetestNote).
    const AUTO_RETEST_INTERVAL_MS = 60_000;
    // The floor between two automatic starts: a full minute, however long the queue is. A
    // bench of twenty rows must not fire its tests into providers that are already refusing
    // traffic, and the retest exists to notice a window reopening, not to hammer it. One
    // automatic test a minute means a waiting row is re-asked at most once a minute, and a
    // queue of twenty takes twenty minutes to walk. The schedule below spaces its slots by the
    // same floor, so two rows never come due on the same tick and race each other's start.
    const AUTO_RETEST_GAP_MS = 60_000;
    // 'overloaded' is a rate limit with no quota behind it (a busy provider), so it waits on
    // the same clock. 'timeout' names no window the provider reopens, and the struck verdicts
    // (paid, dead, incompatible, micro, noauth) cannot be retried into a different answer.
    const AUTO_RETEST_VERDICTS = new Set(['rate-limited', 'overloaded']);
    const autoRetestAt = new Map();
    // When each row was last automatically retested. The queue spaces the *starts*; this spaces
    // each row, so a test that came back with the same verdict cannot bounce straight back into
    // the front of the queue and starve the rows that have been waiting longer.
    const autoRetestLastAt = new Map();
    let autoRetestBusy = false;
    // When the last automatic test actually started. The floor above is measured from this
    // rather than from the end of the previous request: a snapshot and the one-second ticker
    // both call the scheduler continuously, so a row that came due while the last test was in
    // flight would otherwise start the moment it finished, and the spacing would be that
    // request's own duration rather than a minute.
    let lastAutoRetestStartedAt = 0;
    // How long the dashboard waits for one Test before abandoning the request. The router spends
    // up to three 60s attempts on a row — a provider-stated max_tokens cap and a reasoning-only
    // answer each earn a re-ask (MAX_TEST_ATTEMPTS/TEST_TIMEOUT_MS in lib/server.js) — so this is
    // deliberately longer than that worst case plus the provider transforms. Without it a stalled
    // hop left the cell reading "⏳ Testing…" for as long as the socket stayed open: the result is
    // written server-side either way, so the row is better off falling back to the button and
    // picking the answer up on the next refresh than hanging with no way back.
    const TEST_RESPONSE_TIMEOUT_MS = 210_000;
    let activePinnedModelId = null;
    let activePinnedProviderKey = null;
    let activePinnedGroupKey = null;
    let activePinnedScope = null;
    let activePinnedAvailable = false;
    let activePinnedRowKeys = [];
    // The last state confirmed by the server. Optimistic clicks may be superseded
    // or fail, so rollback must never restore another optimistic value that never
    // reached the router.
    let confirmedPinnedState = {
      modelId: null,
      providerKey: null,
      groupKey: null,
      scope: null,
      available: false,
      rowKeys: [],
    };
    // Pin writes are serialized so rapid clicks reach the server in user order;
    // the revision prevents an older response from repainting over a newer choice.
    let pinMutationRevision = 0;
    let pendingPinMutations = 0;
    let pinMutationQueue = Promise.resolve();

    let currentBestModelId = null;  // routed 'best' row from /api/models (pin > slope > intelligence)
    let currentBestProviderKey = null;
    // The two superlatives the Speed/INT columns badge: the fastest and the smartest row among
    // the models that could take a request right now (isRowUsable). Recomputed with every
    // snapshot, so the tags always describe the catalog as it stands, not a stale pick.
    let fastestRowKey = null;
    let smartestGroupKey = null;
    // Every conversation's own pick, from /api/models. Several conversations can be answering on
    // different models, so more than one table row is lit at a time.
    let activePickRows = [];
    // The model the router moved to mid-request, because the model it had selected refused the
    // request. A fallback never changes the next request's pin > slope > intelligence rule, but
    // it is temporarily shown as the serving model everywhere in the UI until the next snapshot
    // confirms the router's current state.
    let routerFallbackSelection = null;
    // Incremented for every event delivered by the router. A snapshot that was already in flight
    // when an event arrived must not roll the UI back to the selection it read before the event.
    let routerEventRevision = 0;
    let proxyErrorState = null;
    const isTableHovered = false;
    let logsViewMode = 'history';
    let logsAutoRefreshPaused = false;
    const PROVIDER_ERROR_MAX_AGE_MS = 120 * 60_000;
    const providerRefreshInFlight = new Set();
    // Provider-onboarding cross-call state (see the onboarding block near refreshProviderModels).
    // `onboardHighlight` is held here, not passed by the caller, so the idle repaint a finished run
    // triggers cannot clobber the emphasis back to the router's pick before the user sees it.
    let onboardHighlight = null;      // { modelId, providerKey } emphasized on the plots for a few seconds
    let onboardHighlightTimer = null;
    let onboardSession = 0;           // bumped on close/start so a stale await cannot reopen the popup
    let onboardStarting = false;      // true between a start request and its response
    let onboardPollFailures = 0;      // consecutive poll failures, capped so a dead server is not hammered
    let kiroDeviceAuthState = null;
    let kiroDevicePollTimer = null;
    let kiroBrowserAuthState = null;
    let kiroUiMessage = null;
    let devinOAuthState = null;
    let devinOAuthPollTimer = null;
    let devinUiMessage = null;
    let copilotDeviceAuthState = null;
    let copilotDevicePollTimer = null;
    let copilotUiMessage = null;
    let codexDeviceAuthState = null;
    let codexDevicePollTimer = null;
    let codexUiMessage = null;
    let googleAuthState = null;
    let googleAuthPollTimer = null;
    let googleUiMessage = null;

    // OAuth consent pages belong in the user's real browser, not an embedded Electron window.
    // The desktop preload hands the URL to the main process, which validates it and calls
    // shell.openExternal; a normal browser keeps its existing new-tab behaviour.
    async function openExternalAuthUrl(url) {
      const target = String(url || '').trim();
      if (!target) return false;
      if (window.hammerDesktop && typeof window.hammerDesktop.openExternal === 'function') {
        try {
          return Boolean(await window.hammerDesktop.openExternal(target));
        } catch {
          return false;
        }
      }
      try {
        window.open(target, '_blank', 'noopener,noreferrer');
        return true;
      } catch {
        return false;
      }
    }

    const MODEL_ID_ALIASES = {
      'mimo-v2-omni-free': 'xiaomi/mimo-v2-omni:free',
      // g4f backends serve these under their own repo spellings; they are the same
      // models the catalogs list, so every provider must share one dashboard row.
      'zai-z/zai-org-glm-5-3-flash': 'glm-5.3-flash',
      'zai-org/glm-5.3-flash': 'glm-5.3-flash',
      'glm-5.3': 'z-ai/glm-5.3',
      // Grok 4 Fast family: g4f repo spellings and hyphenated version numbers
      // (mirrors sources.js so grouping, labels and scores agree client-side).
      'xai-z/grok-4-fast': 'grok-4-fast',
      'tb/grok-4-fast': 'grok-4-fast',
      'x-ai/grok-4-fast': 'grok-4-fast',
      'xai-z/grok-4-fast-reasoning': 'grok-4-fast',
      'xai-z/grok-4-fast-non-reasoning': 'grok-4-fast-non-reasoning',
      'xai-z/grok-4-1-fast': 'grok-4.1-fast',
      'grok-4-1-fast': 'grok-4.1-fast',
      'x-ai/grok-4-1-fast': 'grok-4.1-fast',
      'xai-z/grok-4-1-fast-reasoning': 'grok-4.1-fast',
      'xai-z/grok-4-1-fast-non-reasoning': 'grok-4.1-fast-non-reasoning',
      'grok-4-1-fast-non-reasoning': 'grok-4.1-fast-non-reasoning',
      'x-ai/grok-4-1-fast-non-reasoning': 'grok-4.1-fast-non-reasoning',
    };
    const PROVIDER_NAMES = {
      'groq': 'Groq', 'googleai': 'Google',
      'nvidia': 'NVIDIA', 'openrouter': 'OpenRouter', 'codestral': 'Codestral',
      'kilocode': 'KiloCode',
      'ollama': 'Ollama', 'kiro': 'Kiro', 'g4f': 'G4F',
      'gptfree': 'GPTFree',
      'github-copilot': 'GitHub Copilot',
      'openai-codex': 'OpenAI Codex',
    };

    // ---- Federated origins -------------------------------------------------------------
    // One provider can front many upstream servers: g4f.space federates dozens behind a
    // single endpoint, and discovery reports which one serves each row (originId, named by
    // originLabel). Nothing about the *account* changes — one key, one quota, one endpoint —
    // but the traffic, the latency, the uptime, the test result and the outage belong to the
    // upstream, so the table and the network plot read each origin as a provider of its own.
    // Two origins serving one model are then two rows with two statuses, instead of two rows
    // that both just say 'g4f'.
    function providerInstanceKey(m) {
      if (!m) return '';
      const key = m.providerKey || '';
      const originId = m.originId ? String(m.originId) : '';
      return originId ? `${key}:${originId}` : key;
    }

    // The origin's own name when the catalog gave one, else the provider's. Names do repeat
    // in a federated catalog (two of g4f's upstreams are both called 'qwen'); the router
    // disambiguates those before sending them, so this is only ever a display string.
    function providerInstanceName(m) {
      const base = PROVIDER_NAMES[m && m.providerKey] || (m && m.providerKey) || '';
      const origin = m && m.originLabel ? String(m.originLabel) : '';
      return origin ? `${base} · ${origin}` : base;
    }

    // The table's provider cell speaks in raw provider keys ('groq', 'nvidia'), so an origin
    // row reads 'g4f · nvidia.com' there: the same vocabulary, plus the upstream that served
    // it, which is what tells two rows of the same model apart.
    function providerRowLabel(m) {
      const key = (m && m.providerKey) || '';
      const origin = m && m.originLabel ? String(m.originLabel) : '';
      return origin ? `${key} · ${origin}` : key;
    }

    // A federated origin's catalog name is usually its own hostname ('nvidia.com'), which is
    // a truer brand mark than the gateway's. Anything else — a scraper's nickname, or a
    // sentence describing the server — resolves to nothing here, and the provider's own
    // favicon with the node's monogram stands in, exactly as for a provider with no domain.
    function originFaviconDomain(m) {
      // The router appends " · <id tail>" to an origin whose catalog name collides with another's
      // (see labelOrigins), and that suffix is not part of the name the origin gave itself, so the
      // brand mark is read from the label's own head. Without this a domain-named origin that had
      // to be disambiguated lost its favicon to the gateway's. A name that is not a domain either
      // way resolves to nothing, and the provider's own icon stands in.
      const raw = m && m.originLabel ? String(m.originLabel).trim() : '';
      const origin = raw.includes(' · ') ? raw.slice(0, raw.indexOf(' · ')).trim() : raw;
      if (!origin || origin.length > 64) return '';
      // Remove nemotron prefix if present
      const nemotronPrefix = 'nemotron:';
      const cleanedOrigin = origin.startsWith(nemotronPrefix) ? origin.slice(nemotronPrefix.length) : origin;
      return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(cleanedOrigin) ? cleanedOrigin : '';
    }

    // Brand marks are the one part of either plot that costs a request per node, and each cold
    // one costs the router up to three upstream fetches. They are decoration with a monogram
    // already drawn underneath, so the first paint does without them and the idle pass that
    // follows the table turns them on (see the boot sequence at the bottom of this file). The
    // topology includes this flag in its rebuild key, so a plot drawn during the wait redraws
    // once with marks rather than keeping its monograms until its membership changes.
    let decorationsReady = false;

    // The hrefs to try for one node's mark, in order. The router is preferred: it caches, it works
    // on a machine that cannot reach Google from the browser, and it keeps the provider roster from
    // being handed to a third party on every page load. Domains are deduped because a node's own
    // host and the provider behind it are often the same site, and an empty list means draw no
    // image at all and let the monogram stand.
    function faviconHrefs(domains) {
      if (!decorationsReady) return [];
      const seen = new Set();
      const hrefs = [];
      for (const domain of Array.isArray(domains) ? domains : [domains]) {
        const host = typeof domain === 'string' ? domain.trim() : '';
        if (!host || seen.has(host)) continue;
        seen.add(host);
        const encoded = encodeURIComponent(host);
        hrefs.push(faviconProxyAvailable
          ? `/api/favicon?domain=${encoded}`
          : `https://www.google.com/s2/favicons?domain=${encoded}&sz=64`);
      }
      return hrefs;
    }

    // How the models table resolves a row's own brand domain. The model-family → vendor map
    // lives in drawPlots, which draws the same mark on the plot's model nodes, so it publishes
    // its resolver here rather than the table keeping a second copy that could drift. A model the
    // map cannot name resolves to '' and keeps its monogram, and before the plots have drawn once
    // there is nothing to ask — which costs nothing, because the first table paint is monograms by
    // design and the brand marks arrive with decorationsReady (see the idle pass).
    let modelDomainFor = () => ''

    // ── A model's colour comes from its mark ───────────────────────────────────────────
    //
    // Both plots used to colour by provider: every Anthropic row shared one hue, so a scatter
    // of eight Claude models read as a single colour and a usage plot could not tell two
    // families apart. A model's brand mark already carries the colour people recognise, so the
    // accent is read from that icon: the most common colour in it, skipping the greys that make
    // up most marks' grounds, and the second most common when the mark is greyscale (its most
    // common bucket is the ground, which would paint every row the same grey). Shades are
    // quantised and rare buckets ignored, so anti-aliasing and a stray pixel cannot name a
    // model's colour.
    const modelAccentCache = new Map()   // rowKey -> '#rrggbb' | null
    const modelAccentPending = new Set() // rowKeys whose mark is queued or loading
    const accentQueue = []
    let accentActive = 0
    const ACCENT_PARALLEL = 6

    /**
     * The accent of an icon already loaded into `img`, or null when it cannot be read.
     * @param {HTMLImageElement} img
     * @returns {string|null}
     */
    function accentFromImage(img) {
      const size = 32
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, size, size)
      let pixels
      try {
        pixels = ctx.getImageData(0, 0, size, size).data
      } catch {
        // A cross-origin fallback favicon taints the canvas. No colour can be read without
        // CORS, so the provider hue stands in rather than an exception escaping the draw.
        return null
      }
      // Four bits per channel: close shades collapse into one colour, which is the "ignore
      // small variations" rule — an anti-aliased edge is not its own brand.
      const buckets = new Map()
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 160) continue
        const r = pixels[i]
        const g = pixels[i + 1]
        const b = pixels[i + 2]
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, grey: false }
        bucket.n += 1
        bucket.r += r
        bucket.g += g
        bucket.b += b
        // Within a few steps of equal is grey: a white page, a black glyph, a silver ring.
        bucket.grey = bucket.grey || Math.max(r, g, b) - Math.min(r, g, b) <= 24
        buckets.set(key, bucket)
      }
      const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.n, 0)
      if (total === 0) return null
      const ranked = [...buckets.values()]
        .filter((bucket) => bucket.n >= total * 0.02)
        .sort((a, b) => b.n - a.n)
      if (ranked.length === 0) return null
      const pick = ranked.find((bucket) => !bucket.grey) || (ranked.length > 1 ? ranked[1] : ranked[0])
      // A monochrome mark's second bucket is still grey — a black glyph or a white ground — and
      // either vanishes against the dashboard's own surface: black dots on a dark plot are no
      // marks at all. Such a brand has no colour to lend its rows, so no accent is returned and
      // the provider hue paints them instead of an invisible fill.
      const channels = [pick.r, pick.g, pick.b].map((sum) => sum / pick.n / 255)
      const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      const lum =
        0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2])
      if (lum < 0.12 || lum > 0.9) return null
      return '#' + [pick.r, pick.g, pick.b]
        .map((sum) => Math.round(sum / pick.n).toString(16).padStart(2, '0'))
        .join('')
    }

    /** Repaint the plots once a colour lands; many marks arrive per page, one repaint. */
    let accentRepaintQueued = false
    function scheduleAccentRepaint() {
      if (accentRepaintQueued) return
      accentRepaintQueued = true
      setTimeout(() => {
        accentRepaintQueued = false
        drawUsagePlots()
        renderSessionUsageLegend()
      }, 150)
    }

    function pumpAccentQueue() {
      while (accentActive < ACCENT_PARALLEL && accentQueue.length > 0) {
        const job = accentQueue.shift()
        accentActive += 1
        const img = new Image()
        // Same-origin through the router's proxy; the attribute keeps the read honest when
        // the Google fallback is in use, where the canvas is tainted and the read returns null.
        img.crossOrigin = 'anonymous'
        const done = (colour) => {
          modelAccentPending.delete(job.key)
          modelAccentCache.set(job.key, colour)
          accentActive -= 1
          scheduleAccentRepaint()
          pumpAccentQueue()
        }
        img.onload = () => done(accentFromImage(img))
        img.onerror = () => done(null)
        img.src = job.href
      }
    }

    /**
     * The hrefs for one model's own mark — its vendor's, never its provider's, the same rule
     * the topology's model node draws by. One composition, so the colour a row wears and the
     * icon the plot draws cannot disagree.
     */
    function modelMarkHrefs(m) {
      return faviconHrefs([modelDomainFor(m)])
    }

    /**
     * The colour of one model's mark, reading it the first time it is asked for.
     *
     * Returns null until that read finishes (or when the model has no mark), so callers draw
     * with the provider hue in the meantime and the repaint swaps in the real colour.
     * @param {any} m
     * @returns {string|null}
     */
    function modelAccent(m) {
      if (!m) return null
      const key = getModelRowKey(m)
      if (modelAccentCache.has(key)) return modelAccentCache.get(key)
      if (modelAccentPending.has(key)) return null
      const href = modelMarkHrefs(m)[0]
      // Before the idle pass there are no marks by design; the next draw asks again.
      if (!href) return null
      modelAccentPending.add(key)
      accentQueue.push({ key, href })
      pumpAccentQueue()
      return null
    }

    /** The accent for a usage-series key ('provider::model'), reading that row's mark. */
    function modelAccentForKey(key) {
      const id = String(key || '')
      if (modelAccentCache.has(id)) return modelAccentCache.get(id)
      const split = id.indexOf('::')
      const providerKey = split < 0 ? '' : id.slice(0, split)
      const modelId = split < 0 ? id : id.slice(split + 2)
      if (providerKey === 'session') {
        // No provider row behind it: match the recorded name, and a brand the router has never
        // catalogued still gets its own mark from its family.
        return modelAccent(sessionModelRow(modelId) || { providerKey: 'session', modelId })
      }
      const m = allModels.find((row) => row && row.providerKey === providerKey && String(row.modelId) === modelId)
      return m ? modelAccent(m) : null
    };

    // Named when it is the exception, silent when it is not: a stale router is worth one line on
    // the plot, and a healthy one is worth none.
    function updateLogoSourceNote() {
      const el = document.getElementById('topo-logo-note');
      if (!el) return;
      el.textContent = faviconProxyAvailable
        ? ''
        : 'Logos are being fetched from a third party because this page is newer than the running router. Restart it to serve them locally.';
      el.style.display = faviconProxyAvailable ? 'none' : 'block';
    }

    function updateProxyErrorBanner(error) {
      const el = document.getElementById('proxy-error-banner');
      if (!el) return;
      if (!error || !error.message) {
        el.style.display = 'none';
        el.textContent = '';
        proxyErrorState = null;
        return;
      }
      const fallback = error.fallback ? ' Fallback routing is active.' : '';
      const target = error.provider && error.model ? ` (${error.provider}/${error.model})` : '';
      el.textContent = `Router: ${error.message}${target}.${fallback}`;
      el.style.display = 'block';
      proxyErrorState = error;
    }



    async function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');

      document.getElementById('models-view').style.display = tab === 'models' ? 'block' : 'none';
      document.getElementById('logs-view').style.display = tab === 'logs' ? 'block' : 'none';
      document.getElementById('settings-view').style.display = tab === 'settings' ? 'block' : 'none';

      if (tab === 'settings') {
        loadSettings();
      } else if (tab === 'logs') {
        loadLogs(true);
      }
    }

    // ── Coalescing the refresh a completed Test asks for ────────────────────────────────
    // A finished Test refreshes the dashboard, and that refresh re-fetches the whole table
    // and re-renders every row. Working down a long provider — Airforce alone is 360+ rows —
    // therefore used to cost one full refresh per click, and that is what made the table lag
    // behind the cursor. The clicked cell is already painted in place by `paintTestResult`,
    // so the refresh only has to catch up the aggregate numbers, which means it can be
    // coalesced: the first completion refreshes at once (so a single Test still feels
    // immediate), and every completion landing inside the following window folds into one
    // more refresh instead of paying for its own.
    //
    // At most one fetchData() is ever in flight, so two overlapping refreshes can never
    // interleave their renders and leave the table showing the older snapshot.
    const REFRESH_COALESCE_MS = 600;
    let refreshTimer = null;
    let refreshRunning = false;
    let refreshQueued = false;

    function scheduleRefresh() {
      refreshQueued = true;
      if (refreshRunning || refreshTimer) return;
      runCoalescedRefresh();
    }

    function runCoalescedRefresh() {
      if (refreshRunning) return;
      refreshQueued = false;
      refreshRunning = true;
      fetchData()
        .catch(() => {})
        .finally(() => {
          refreshRunning = false;
          if (!refreshQueued) return;
          // Tests finished while this refresh was running: wait out the window so the
          // burst still costs one refresh, then take the trailing one.
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            runCoalescedRefresh();
          }, REFRESH_COALESCE_MS);
        });
    }

    // The provider roster, as a request the boot sequence can start early and consume late.
    // Never rejects: a roster hammer cannot read costs the plot its brand marks and is reported
    // by whoever renders the provider cards, which is a different failure from having no models.
    function fetchProviderConfig() {
      return fetch('/api/config')
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null);
    }

    // The provider roster behind the table's decorations: the domains whose favicons may mark a
    // provider in the topology plot, and whether this router serves those marks itself
    // (see fetchFavicon in lib/server.js). Applied when the roster arrives rather than as a step
    // of the snapshot, because the two arrive independently now.
    function applyProviderRoster(providers) {
      if (!Array.isArray(providers)) return;
      providerFaviconDomainLists = new Map(
        providers
          .filter(p => p && p.key)
          .map(p => [p.key, (Array.isArray(p.faviconDomains) && p.faviconDomains.length > 0
            ? p.faviconDomains
            : (p.faviconDomain ? [p.faviconDomain] : []))]),
      );
      faviconProxyAvailable = providers.some(p => p && Object.prototype.hasOwnProperty.call(p, 'faviconDomain'));
      updateLogoSourceNote();
    }

    // The most recent roster /api/config delivered, or null. Held so the staged passes — the
    // plot's brand marks and the provider grid — read it without awaiting the same promise again,
    // and so a snapshot that outlives the roster still has one to hand.
    let lastProviderRoster = null;
    // Where the provider grid is in its life: 'idle' (never built), 'building' (a build has been
    // scheduled or is running) or 'ready' (built at least once). One variable rather than a
    // boolean because the first build is deferred to idle, so a second snapshot can arrive while
    // it is still queued — and two snapshots each deciding to build the first time is how ~125
    // provider cards get rendered twice on one page load.
    let providerPanelState = 'idle';
    const providerPanelReady = () => providerPanelState === 'ready';

    // A snapshot that arrived before the router had its provider usage reports is complete as far
    // as the table is concerned — every row is there — and the only thing still filling in is the
    // quota section of the provider cards. So the follow-up re-reads *that* payload (/api/config,
    // ~100ms) and not the model snapshot (~2s): the cards are the only surface on this page that
    // reads these reports at all (the rows' own rate limits are learned from the responses the
    // router served, not from an account report), so a second full snapshot would re-read and
    // repaint 341 rows to change none of them. While this page's event stream is attached the
    // router's own `provider-usage` event drives this; the delay covers the race where that
    // refresh settled before the stream attached.
    const USAGE_FOLLOW_UP_MS = 2000;
    let usageFollowUpTimer = null;

    function scheduleUsageFollowUp() {
      if (usageFollowUpTimer) return;
      usageFollowUpTimer = setTimeout(() => {
        usageFollowUpTimer = null;
        refreshProviderUsageUi();
      }, USAGE_FOLLOW_UP_MS);
    }

    // Re-render the provider grid from a fresh roster, for the one payload that moves without
    // anything the user did: the router's provider usage reports (see the decoupling in
    // lib/server.js). A grid that has not been built yet has nothing to update — the snapshot's
    // own staged pass will read the roster when it gets there.
    function refreshProviderUsageUi() {
      if (!providerPanelReady()) return;
      loadSettings().catch(() => { });
    }

    // The model snapshot — the page's payload, and now the only thing this function reads. The
    // table, the KPI numbers and both plots are all built from it, so it is fetched and painted
    // on its own: /api/models and /api/config used to be joined in one Promise.all, which made the
    // whole dashboard wait for the slower of the two every time, and the provider half is the one
    // that can sit on network work (see the usage decoupling in lib/server.js).
    async function loadModelSnapshot() {
      const pinRevisionAtStart = pinMutationRevision;
      const pinWasPendingAtStart = pendingPinMutations > 0;
      const routerEventRevisionAtStart = routerEventRevision;
      // Started here, consumed later by the brand marks and the provider grid. Deliberately not
      // awaited with the snapshot: it must never be able to hold the table back.
      const providersPromise = fetchProviderConfig();
      try {
        const modelsRes = await fetch('/api/models');
        perfMark('models-response');
        const data = await modelsRes.json();
        perfMark('models-parsed');
        // A live event can arrive while the request is in flight. Its row and selection are
        // newer than this snapshot, so leave the DOM alone and let the queued refresh repaint
        // from a fresh server read instead of flashing the old model back.
        if (routerEventRevisionAtStart !== routerEventRevision) return true;
        updateProxyErrorBanner(data.proxyError);

        // Calculate QoS for each model. Quota reports are already attached by
        // /api/models; avoid a second usage request on every dashboard refresh.
        // `isRateLimited` is left exactly as the server sent it: it is that row's own
        // statement (wasRateLimited / exhausted credits), and the dashboard's reading —
        // which also carries the window a test response describes — is derived at the
        // point of use by rateLimitEvidence(). Re-deriving it into the field here would
        // feed a snapshot back into the rule that produced it.
        allModels = data.models.map(m => ({ ...m, qos: m.qos || 0 }));
        computeSpeedLeaders(allModels);

        // Relay-backed entries may report a real upstream model in every response. When
        // the router captures one that differs from the catalog id, show it as the model's
        // name so the label follows live responses instead of a hardcoded list.
        for (const m of allModels) {
          if (m.realModelId && m.realModelLabel) {
            m.label = m.realModelLabel;
            m.personaModelId = m.modelId;
          }
        }

        // A refresh can have started before a queued pin write and finish after
        // it. Do not let that stale catalog snapshot overwrite either the
        // optimistic row or the last server-confirmed rollback state.
        const pinSnapshotIsCurrent = pinRevisionAtStart === pinMutationRevision
          && !pinWasPendingAtStart
          && pendingPinMutations === 0;
        if (pinSnapshotIsCurrent) {
          confirmedPinnedState = {
            modelId: data.pinnedModelId || null,
            providerKey: data.pinnedModelId ? (data.pinnedProviderKey || null) : null,
            groupKey: data.pinnedModelId ? (data.pinnedGroupKey || null) : null,
            scope: data.pinnedModelId ? (data.pinnedScope || 'family') : null,
            available: data.pinnedModelId ? data.pinnedAvailable !== false : false,
            rowKeys: Array.isArray(data.pinnedRowKeys) ? [...data.pinnedRowKeys] : [],
          };
          setActivePinnedModel(
            data.pinnedModelId,
            data.pinnedProviderKey,
            data.pinnedRowKeys,
            data.pinnedScope,
            data.pinnedGroupKey,
            data.pinnedAvailable,
          );
        }
        // A response that started before a live router event can finish after it. Keep the
        // event's selection in that case; the next coalesced refresh will reconcile everything
        // else without making the UI briefly jump back to the model that just failed.
        currentBestModelId = data.best || null;
        currentBestProviderKey = data.bestProviderKey || null;
        activePickRows = Array.isArray(data.activePicks) ? data.activePicks : [];
        // A fallback is an event, not a fourth selection rule. Keep its explanation only when
        // the model it named is still the server's current pin/slope/ranking pick; after a
        // slope or pin change, the old fallback must not relabel the new current model.
        const fallback = data.selection && data.selection.fallback;
        routerFallbackSelection = fallback
          && fallback.modelId === data.selection.modelId
          && (!fallback.providerKey || fallback.providerKey === data.selection.providerKey)
          ? { modelId: data.selection.modelId, providerKey: data.selection.providerKey, ...fallback }
          : null;
        // One grouping for the table and the numbers that describe it. Both used to derive it
        // independently — groupModels, then sortedGroups, then splitDisplayGroups over every row,
        // twice per snapshot — and the table's split and the readouts' split are the same split.
        // Only reusable while nothing is filtered: with a search active the table shows a subset
        // while the readouts must keep describing the whole snapshot.
        const displayGroups = searchTerm ? null : splitDisplayGroups(sortedGroups(groupModels(allModels)));

        // 1. The table. Everything else on this page describes it, and it is the part the user
        //    is actually reading, so it is painted on this frame.
        clearSkeletonRows();
        try { render(false, displayGroups); } catch (e) { console.error('Render error:', e); }
        perfMark('table');
        // The shell's job ends with the first real rows. Later refreshes are silent by design:
        // placeholder rows flashing on every Test click would be worse than the wait they name.
        if (loadingStateActive) endLoadingState();

        // 2. The headline numbers — text only, no SVG. Cheap next to the plots and the part of
        //    the page that answers "is anything online?"
        updateKpiNumbers(allModels, currentBestModelId, currentBestProviderKey, displayGroups);

        // 3. Everything else, after the table is interactive. The roster is awaited inside this
        //    pass because the plot's brand marks are resolved from it; if the router answered
        //    slowly the monograms carry the plot and the marks arrive on the redraw (see
        //    faviconHrefs and the `dec` term in the topology's rebuild key).
        whenIdle(async () => {
          const roster = await providersPromise;
          if (Array.isArray(roster)) lastProviderRoster = roster;
          applyProviderRoster(lastProviderRoster);
          decorationsReady = true;
          drawPlots(allModels, currentBestModelId, currentBestProviderKey);
          // The table's logo column is monograms until brand marks are allowed (faviconHrefs
          // answers nothing before the flag above), and the resolver only exists once the plots
          // have drawn. One re-render swaps the marks in; later refreshes resolve them directly.
          render(false);
          perfMark('plots');
          // The grid is only touched when it is on screen (the models or settings tab). It is the
          // last thing on the page and the most expensive to build — ~125 cards — so it goes
          // after the plots rather than before them, and the roster handed to it is the one this
          // snapshot read: the cards' quotaPending state is part of that payload, so reusing an
          // older roster would leave a card saying "Checking…" after the refresh it was waiting
          // for had already landed.
          const panelVisible = document.getElementById('models-view').style.display !== 'none'
            || document.getElementById('settings-view').style.display !== 'none';
          if (!panelVisible) {
            perfReport();
            return;
          }
          if (providerPanelState === 'ready') {
            await loadSettings(lastProviderRoster);
            perfReport();
            return;
          }
          // A build is already queued or running for another snapshot: joining it would render
          // every card twice.
          if (providerPanelState === 'building') {
            perfReport();
            return;
          }
          // First build. Its own idle slot again, because painting ~125 cards is itself a long
          // task and the table must stay interactive through it.
          providerPanelState = 'building';
          whenIdle(() => {
            loadSettings(lastProviderRoster).catch(e => console.error('Initial loadSettings failed:', e));
          });
        });

        scheduleContradictoryRetests();
        // Rows waiting on a provider window get their own clock: one retry a minute, staggered.
        scheduleAutomaticRetests();
        // Show the 'Test All' button when the rendered main table has inactive rows.
        updateTestAllButtonVisibility();
        // Live-update logs if that tab is currently active
        if (document.getElementById('logs-view').style.display !== 'none') {
          loadLogs();
        }
        // The quota boxes may still be filling in on the router's side. The panel itself is kept
        // current by the staged pass above, which is the only place that holds a roster matching
        // this snapshot — see the comment there about quotaPending.
        if (data.usagePending === true) scheduleUsageFollowUp();
        // Pull the time-series usage samples for the usage plots after the table is painted.
        fetchUsageSeriesDelta().then(() => drawUsagePlots());
        return true;
      } catch (e) {
        console.error('Fetch error:', e);
        updateProxyErrorBanner({ message: e?.message || 'Could not refresh Hammer status.', fallback: false });
        // Only the *initial* load owns the loading shell: a failed background refresh must not
        // replace a working dashboard with an error screen.
        if (loadingStateActive) failLoadingState(e);
        return false;
      }
    }

    // `fetchData` is the name every existing caller knows (Tests, key saves, tab switches, the
    // visibility handler, the coalesced refresh). It is now exactly the model snapshot.
    function fetchData() {
      return loadModelSnapshot();
    }

    // Fetch time-series usage samples for the usage plots.
    // `since` limits points to those at or after that epoch ms (used for incremental pulls).
    async function fetchUsageSeries({ since, limit = 200 } = {}) {
      if (usageSeriesFetching) return;
      usageSeriesFetching = true;
      try {
        const qs = new URLSearchParams();
        if (since != null) qs.set('since', String(since));
        qs.set('limit', String(limit));
        const res = await fetch(`/api/usage-series?${qs}`);
        if (!res.ok) return;
        const data = await res.json();
        const series = data && data.series ? data.series : {};
        const session = data && data.session ? data.session : {};
        for (const [key, pts] of Object.entries(series)) {
          if (!Array.isArray(pts)) continue;
          const existing = usageSeriesByKey.get(key) || [];
          const merged = [...existing, ...pts];
          // Deduplicate by timestamp, keep last `limit` points.
          const byTime = new Map();
          for (const p of merged) byTime.set(Number(p.t), p);
          const deduped = [...byTime.values()].sort((a, b) => Number(a.t) - Number(b.t));
          usageSeriesByKey.set(key, deduped.slice(-limit));
        }
        // The session view is authoritative from the server (it knows when its own
        // process started), so it replaces the local copy rather than being merged.
        //
        // It is only the router's own view while no conversation has claimed the plot.
        // Once the agent rail has published a transcript's history, that is the answer the
        // rail's reader came for and a background snapshot must not overwrite it with the
        // uptime view (see publishSessionUsage).
        if (usageSessionShown == null) {
          usageSessionByKey.clear();
          for (const [key, pts] of Object.entries(session)) {
            // The server publishes a key for every model it knows, with an empty array when
            // this session has no samples for it. Empty rows are catalog, not history: keeping
            // them made the rail's legend list the whole catalog before the real session
            // arrived, then collapse to the models that actually answered.
            if (Array.isArray(pts) && pts.length > 0) usageSessionByKey.set(key, pts);
          }
        }
        usageSeriesLastFetchedAt = data?.at != null ? Number(data.at) : Date.now();
      } catch { /* best effort */ }
      finally { usageSeriesFetching = false; }
    }

    // Re-pull the series. The server caps each row at 200 points (see recordUsage in
    // lib/server.js), so the payload is bounded and there is no need for a delta filter —
    // and a `since` boundary could drop the sample a just-arrived event announced.
    async function fetchUsageSeriesDelta() {
      await fetchUsageSeries();
    }

    function calculateBestModel(models) {
      // Same verdict as the dots and the KPIs: the highlighted model is one that can
      // actually take a request, not one whose last test hit a quota wall.
      // `getAvg` answers Infinity for a row with no successful ping, and JSON cannot carry
      // that: /api/models sends null. Comparing against Infinity here therefore excluded
      // nothing — null !== Infinity is true — and an unmeasured row passed a gate written to
      // keep it out. `Number.isFinite` is the test the wire can actually satisfy.
      const candidates = models.filter(m => isRowUp(m) && Number.isFinite(m.avg));
      if (candidates.length === 0) return null;

      return [...candidates].sort((a, b) => (b.qos || 0) - (a.qos || 0))[0];
    }

    function canonicalizeClientModelId(modelId) {
      const raw = typeof modelId === 'string' ? modelId.trim() : '';
      // The g4f per-server namespace ("srv_ab12:model") is routing info, not model
      // identity — strip it so discovered rows share the group key their catalog
      // siblings use, then resolve the model part through the alias map.
      const unnamespaced = raw.replace(/^srv_[a-z0-9]+:/i, '');
      const resolved = MODEL_ID_ALIASES[unnamespaced] || unnamespaced;
      const base = resolved.replace(/(?::[a-z0-9-]+)+$/i, '');
      const unprefixed = base.includes('/') ? base.split('/').pop() : base;
      return { base, unprefixed };
    }

    function getModelRowKey(modelOrProviderKey, maybeModelId) {
      if (typeof modelOrProviderKey === 'object' && modelOrProviderKey) {
        return `${modelOrProviderKey.providerKey || ''}::${modelOrProviderKey.modelId || ''}`;
      }
      return `${modelOrProviderKey || ''}::${maybeModelId || ''}`;
    }

    function pinnedStateFrom(modelId, providerKey = null, rowKeys = [], scope = null, groupKey = null, available = null) {
      return {
        modelId: modelId || null,
        providerKey: modelId ? (providerKey || null) : null,
        groupKey: modelId ? (groupKey || null) : null,
        scope: modelId ? (scope === 'exact' ? 'exact' : 'family') : null,
        available: modelId ? available !== false : false,
        rowKeys: Array.isArray(rowKeys) ? [...new Set(rowKeys.filter(Boolean))] : [],
      };
    }

    function isExactPinnedRow(modelOrRowKey) {
      if (activePinnedScope !== 'exact') return false;
      const rowKey = typeof modelOrRowKey === 'object'
        ? getModelRowKey(modelOrRowKey)
        : String(modelOrRowKey || '');
      return activePinnedRowKeys.includes(rowKey);
    }

    function isFamilyPinnedGroup(members) {
      // The server's family membership includes unavailable siblings, while the
      // main table intentionally omits those rows. Therefore an active family pin
      // must not require every rendered member to be present: one legal sibling is
      // enough to keep the heading visibly pinned after another provider goes down.
      return activePinnedScope === 'family'
        && members.length > 0
        && members.some(model => activePinnedRowKeys.includes(getModelRowKey(model)));
    }

    function getPinnedRowKeysForSelection(modelId, providerKey = null, scope = 'family', groupKey = null) {
      if (!modelId) return [];
      if (scope === 'exact') return providerKey ? [getModelRowKey(providerKey, modelId)] : [];
      // A current router supplies the opaque group id. Use it directly when present so a
      // family pin follows the server's partition even when two similarly named models
      // share a family prefix or differ only by size/variant. The identity fallback keeps
      // the dashboard usable against an older router that predates the metadata field.
      if (groupKey) {
        const serverMatches = allModels.filter(m => m.modelGroupId && m.modelGroupId === groupKey);
        if (serverMatches.length > 0) return serverMatches.map(m => getModelRowKey(m));
      }
      const selectedUnprefixed = canonicalizeClientModelId(modelId).unprefixed;
      const selectedGroup = String(groupKey || selectedUnprefixed).toLowerCase();
      return allModels
        .filter(m => canonicalizeClientModelId(m.modelId).unprefixed.toLowerCase() === selectedGroup)
        .map(m => getModelRowKey(m));
    }

    function bindPinButton(button, { modelId, providerKey = null, groupKey = null, pinned = false }) {
      if (!button) return;
      button.onclick = (event) => {
        event.stopPropagation();
        return pinModel(pinned ? '' : modelId, pinned ? null : providerKey, pinned ? null : groupKey);
      };
    }

    function syncPinnedModelUI() {
      const badge = document.getElementById('pin-badge');
      if (!badge) return;
      badge.style.display = activePinnedModelId ? 'inline-block' : 'none';
      if (!activePinnedModelId) {
        badge.textContent = '📌 Pinned ×';
        badge.title = 'Click to unpin';
        return;
      }
      const row = allModels.find(m => getModelRowKey(m) === activePinnedRowKeys[0])
        || allModels.find(m => m.modelId === activePinnedModelId);
      const label = row ? cleanHeadingModelName(row.label || row.modelId) : activePinnedModelId;
      const scopeLabel = activePinnedScope === 'exact' ? 'exact provider' : 'model family';
      const unavailable = activePinnedAvailable === false ? ' · unavailable' : '';
      badge.textContent = `📌 ${label} · ${scopeLabel}${unavailable} ×`;
      badge.title = `${scopeLabel} pin — click to unpin`;
    }

    function setActivePinnedModel(modelId, providerKey = null, resolvedRowKeys = null, scope = null, groupKey = null, available = null) {
      activePinnedModelId = modelId || null;
      activePinnedProviderKey = modelId ? (providerKey || null) : null;
      activePinnedGroupKey = modelId ? (groupKey || null) : null;
      activePinnedScope = modelId ? (scope === 'exact' ? 'exact' : 'family') : null;
      activePinnedAvailable = modelId ? available !== false : false;
      activePinnedRowKeys = Array.isArray(resolvedRowKeys)
        ? [...new Set(resolvedRowKeys.filter(Boolean))]
        : getPinnedRowKeysForSelection(
          activePinnedModelId,
          activePinnedProviderKey,
          activePinnedScope,
          activePinnedGroupKey,
        );
      syncPinnedModelUI();
    }

    // The KPI's numbers, without either plot. Split out of updateKPIs so the boot sequence can
    // paint the headline counts on the frame that paints the table and leave the two SVG draws to
    // idle: the numbers are text, the plots are the two most expensive things on the page after
    // the provider grid.
    //
    // `displayGroups` is the caller's already-computed main/graveyard split when it has one (see
    // the snapshot in loadModelSnapshot). Passing it is what makes the table's grouping and the
    // readouts' grouping one pass instead of two.
    function updateKpiNumbers(models, bestModelId, bestProviderKey = null, displayGroups = null) {
      // Both counts read the same verdict the table's dots do — a model is 'active' when
      // something can actually serve it right now (see rowVerdict). One definition, or the
      // KPIs and the rows they summarise disagree.
      // Unique model groups, not provider rows, so shared models are counted once.
      const onlineModelCount = groupModels(models.filter(isRowUp)).length;

      const onlineProviders = new Set();
      models.forEach(m => {
        // Counted by origin: this is the number the network plot beside it draws a node
        // per, so counting gateways here would contradict the picture.
        if (isRowUp(m)) onlineProviders.add(providerInstanceKey(m));
      });

      // Derive main-table-only groups (mirrors render(): splitDisplayGroups drops
      // struck rows into the graveyard). From those:
      //   Endpoints = total edges in the bipartite nodes plot = model↔provider links
      //   Providers = unique provider instances in the main table (only online/up rows)
      //   Rows     = every row the main table shows (provider rows, grouped heads,
      //              excluding graveyard/unavailable rows)
      const { mainGroups } = displayGroups || splitDisplayGroups(sortedGroups(groupModels(models)));
      let endpoints = 0;
      const mainProviderKeys = new Set();
      let mainRows = 0;
      for (const g of mainGroups) {
        for (const m of g.members) {
          if (isRowUp(m)) endpoints += 1; // one edge per online member
          if (isRowUp(m)) mainProviderKeys.add(providerInstanceKey(m)); // only online providers
          mainRows += 1; // every provider row in the main table
        }
      }

      const readoutModels = document.getElementById('readout-models');
      const readoutCombos = document.getElementById('readout-combos');
      const readoutProviders = document.getElementById('readout-providers');
      const readoutRows = document.getElementById('readout-rows');
      if (readoutModels) readoutModels.textContent = onlineModelCount;
      if (readoutCombos) readoutCombos.textContent = endpoints;
      if (readoutProviders) readoutProviders.textContent = mainProviderKeys.size;
      if (readoutRows) readoutRows.textContent = mainRows;

    }

    // Both plots, from one snapshot. Deferred to idle by the boot sequence and immediate for every
    // caller that is painting a live event — a fallback must move the pictures on the SSE frame.
    function drawPlots(models, bestModelId, bestProviderKey = null) {
      // A just-onboarded provider is emphasized for a few seconds. The emphasis is read from state
      // rather than passed in, so the idle repaint a finished run schedules cannot repaint the plot
      // back to the router's pick a moment after the highlight was drawn (see emphasizeProviderPlots).
      const highlight = onboardHighlight;
      const effectiveId = highlight ? highlight.modelId : bestModelId;
      const effectiveKey = highlight ? highlight.providerKey : bestProviderKey;
      const bestModel = effectiveId
        ? models.find(m => m.modelId === effectiveId && (!effectiveKey || m.providerKey === effectiveKey))
        : null;
      drawBipartiteTopology(models, bestModel);
    }

    // Numbers *and* both plots, together and immediately. This is the shape every live-event paint
    // uses (a fallback, a provider bench, new evidence): the SSE frame names a model, and every
    // surface that names it — including the pictures — has to move on that same frame. The boot
    // sequence is the only caller that splits the two (see loadModelSnapshot).
    function updateKPIs(models, bestModelId, bestProviderKey = null) {
      updateKpiNumbers(models, bestModelId, bestProviderKey);
      drawPlots(models, bestModelId, bestProviderKey);
    }

    // ---- Intelligence-vs-speed scatter plot ----
    // One dot per model/provider combination (each row of the live models list,
    // the same rows behind the main table's TTFT / Tok/s columns).
    //   y = intelligence: the same benchmark value the Intelligence column sorts by
    //   x = speed       : N / (TTFT + N / tok-per-s) — the tokens the row actually
    //                     answered with, over the whole time that answer took
    // Dots are colored per provider (stable hue) so multi-provider duplicates of
    // the same model are distinguishable; hover a dot for its tooltip.

    const scatterSvgNS = 'http://www.w3.org/2000/svg';
    function svgEl(name, attrs) {
      const n = document.createElementNS(scatterSvgNS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }
    const cssVarValue = (name) => (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();

    const fmtScatterSpeed = (v) => {
      if (v >= 1000) return v.toFixed(0);
      if (v >= 1) return v.toPrecision(3).replace(/\.?0+$/, '');
      return v.toPrecision(2).replace(/\.?0+$/, '');
    };
    const fmtScatterIntell = (v) => v >= 100 ? String(Math.round(v)) : (Number.isInteger(v) ? String(v) : v.toFixed(1));
    // Stable hue per provider so multi-provider duplicates of the same model
    // stay distinguishable at a glance.
    const scatterProviderHue = (pk) => {
      let h = 0;
      for (const ch of String(pk)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      return Math.abs(h) % 360;
    };
    const scatterShortName = (m) => {
      const l = (m.label || '').trim();
      if (l) return l;
      return (m.modelId || '').replace(/^[a-z0-9_-]+\//i, '') || m.modelId || '?';
    };
    const scatterDotSize = (rows) => rows.length > 220 ? 3 : 4.5;

    // The answered length every dot is scored at, in output tokens. Mirrors
    // SPEED_REFERENCE_TOKENS in lib/utils.js, and it is a copy only because the browser
    // cannot import the server's module: the scatter and the router lower the *same* line
    // onto the plot, and a line drawn from a different constant would highlight a row the
    // router would not pick.
    //
    // One fixed reference for the whole table is what makes the score comparable at all:
    // the same model answering a model test's short reply and a long chat turn has one
    // prefill latency and one generation rate, but the *effective* rate between them
    // depends on how long that answer happened to be. Scoring every row at this length
    // makes the score a property of the row rather than of whoever measured it.
    const SPEED_REFERENCE_TOKENS = 500;

    // How far past the rest of the field a dot may sit before the axis stops calling
    // that speed a scale. A row at twice the speed of everything else would flatten every
    // other dot into the left margin, so the axis ends where the field ends and the row is
    // drawn at the edge with an arrow. Dimensionless: it describes the spread, not a speed.
    const SCATTER_OUTLIER_FACTOR = 2;

    // ---- The slope selector ----
    // This scatter draws the field only: no selector line, no minimum lines. What the
    // conversation's slope picks is shown in the composer's own popup (public/harness.js),
    // which lowers the contour of `intelligence + slope × speed` onto the same rows — the
    // route to that model is the pick the table's blue row names (pin > slope > ranking).

    // ──────── Usage plots ────────
    // Time-series usage plots: tokens/s over time, rendered as ~100 equal time buckets,
    // each drawn as one column carrying the bucket's average rate. Each point is one
    // successful proxy request recorded in `usageSeriesByKey`.

    const usageSvgNS = 'http://www.w3.org/2000/svg';
    function usageSvgEl(name, attrs) {
      const n = document.createElementNS(usageSvgNS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    const fmtTps = (v) => {
      if (v == null || !Number.isFinite(v)) return '—';
      if (v >= 1000) return v.toFixed(0);
      if (v >= 10) return v.toFixed(1);
      return v.toPrecision(3);
    };

    // ── The axis all three usage plots share ─────────────────────────────────────────
    //
    // Every usage plot encodes tokens as area, so two things decide a column: how many
    // tokens its slice holds, and how wide that slice is on the axis. Idle time is the trap.
    // A model can sit unused for hours between turns, and a wall-clock axis spends almost all
    // of its width on that silence: the burst at the next turn collapses into a pixel, and a
    // quiet row reads as an empty plot. Gaps longer than USAGE_GAP_CAP_MS are therefore
    // collapsed to that cap — enough to keep the shape of a quiet stretch, never enough to
    // decide the scale — and the columns are cut over that compressed axis.
    const USAGE_GAP_CAP_MS = 5 * 60_000;

    // Real sample times → the collapsed axis. Monotone, and the only place the collapse
    // happens, so all three plots map time the same way.
    function usageCompressedSeries(points) {
      const out = [];
      let cx = 0;
      let prev = null;
      for (const p of points) {
        const t = Number(p.t);
        if (prev != null) cx += Math.min(Math.max(0, t - prev), USAGE_GAP_CAP_MS);
        prev = t;
        out.push({ p, cx });
      }
      return out;
    }

    // Cuts the collapsed axis into `binTarget` equal slices and sums the tokens in each.
    // `seconds` is one slice's width on that axis — the divisor that turns a slice's token
    // total into the rate drawn as its height, and the reason height × width is its tokens.
    // A single sample has no span to divide by, so it is counted a second wide rather than
    // as milliseconds.
    function usageTokenBins(compressed, binTarget, keyOf) {
      const binCount = Math.max(1, Math.min(binTarget, compressed.length));
      const span = compressed[compressed.length - 1].cx || 1;
      const seconds = Math.max(1000, span / binCount) / 1000;
      const bins = Array.from({ length: binCount }, () => ({ tokens: 0, key: '', t: null }));
      for (const { p, cx } of compressed) {
        const b = bins[Math.min(binCount - 1, Math.floor((cx / span) * binCount))];
        b.tokens += Number(p.tokens) || 0;
        if (b.t == null) b.t = Number(p.t);
        b.key = keyOf(p) || b.key;
      }
      return { bins, binCount, seconds };
    }

    // Draw one time-series plot inside an SVG element.
    // options: { id, title, valueOf (p => number), yLabel, color, maxPoints,
    //            fallback { width, height }, pad }
    // fallback: measured size to use while the SVG's view is hidden (a hidden element has
    // no client box, and the 640x160 default would be wrong for a narrow rail plot).
    // pad: axis padding override — the rail plot is narrow, so its labels sit closer in.
    function drawUsagePlot(svgId, pointsByKey, options) {
      const svg = document.getElementById(svgId);
      const empty = document.getElementById(svgId.replace('-svg', '-empty'));
      if (!svg) return;

      const fb = options.fallback || { width: 640, height: 160 };
      const W = svg.clientWidth || fb.width;
      const H = svg.clientHeight || fb.height;
      const pad = options.pad || { top: 14, right: 40, bottom: 22, left: 34 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top - pad.bottom;

      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = '';

      // Gather all points across all rows for this plot.
      let allPoints = [];
      for (const pts of Object.values(pointsByKey)) {
        if (Array.isArray(pts)) allPoints = allPoints.concat(pts);
      }
      allPoints.sort((a, b) => Number(a.t) - Number(b.t));

      // Filter out samples that contribute no volume. The plotted quantity is the token
      // count each request accounts for (see valueOf in drawUsagePlots): a sample with no
      // reported tokens has nothing to add to the area, so it is dropped rather than drawn
      // as a zero.
      const plottable = allPoints.filter(p => {
        const v = options.valueOf(p);
        return v != null && Number.isFinite(v) && v >= 0;
      });

      if (plottable.length === 0) {
        svg.style.display = 'none';
        if (empty) empty.style.display = 'flex';
        return;
      }
      svg.style.display = 'block';
      if (empty) empty.style.display = 'none';

      // Which row each point came from, so a column can be coloured by the provider that
      // landed last in it (the points arrive flattened, without their keys attached).
      const keyOf = new Map();
      for (const [key, pts] of Object.entries(pointsByKey)) {
        if (!Array.isArray(pts)) continue;
        for (const p of pts) if (p && typeof p === 'object') keyOf.set(p, key);
      }

      // ── Cut the collapsed axis into ~100 equal slices, summing volume in each ──
      // The area under this curve is the number being read. A column's height is the tokens
      // that landed in its slice divided by the slice's own width in collapsed seconds, so
      // height × width = tokens for every column and the whole plot integrates to the tokens
      // Hammer actually served. Averaging per-request tok/s — what this used to do — drew a
      // speed instead, and integrating a speed over wall-clock time charges every idle gap as
      // tokens that were never generated. A column's colour is the hue of the request that
      // landed last in it, so a column is never a blend the legend cannot name.
      const BIN_TARGET = 100;
      const { bins, binCount, seconds } = usageTokenBins(
        usageCompressedSeries(plottable),
        BIN_TARGET,
        (p) => keyOf.get(p) || '',
      );

      // A tick label needs a real timestamp. A quiet slice carries none, so it inherits the
      // one to its left (and the stretch before the first request the one to its right): the
      // label then describes the quiet time rather than inventing a date.
      const firstKnownT = bins.find((b) => b.t != null)?.t ?? Number(plottable[0].t);
      let cursorT = firstKnownT;
      for (const b of bins) {
        if (b.t == null) b.t = cursorT;
        else cursorT = b.t;
      }

      // The tallest column sets the scale. Tokens per second is a rate, so the floor is zero:
      // a value below it would draw under the axis and read as a negative speed, which
      // nothing measures.
      const vMax = Math.max(...bins.map((b) => b.tokens / seconds), 0) || 1;
      const yHeadroom = vMax * 1.1;
      const yOf = (v) => pad.top + plotH - (v / yHeadroom) * plotH;

      // Columns: one rect per non-empty bucket. Width leaves a hair of gap so the
      // buckets read as columns rather than one solid band.
      const binW = plotW / binCount;
      const barW = Math.max(1, binW - Math.min(2, binW * 0.18));
      for (let i = 0; i < binCount; i++) {
        const b = bins[i];
        if (b.tokens <= 0) continue;
        // The slice's tokens per second of its own width — the rate whose area over
        // `seconds` is exactly the tokens that landed in the slice.
        const rate = b.tokens / seconds;
        const hue = usageKeyHue(b.key);
        const accent = modelAccentForKey(b.key || '');
        const x = pad.left + i * binW + (binW - barW) / 2;
        const y = yOf(rate);
        svg.appendChild(usageSvgEl('rect', {
          x: x.toFixed(2),
          y: y.toFixed(2),
          width: barW.toFixed(2),
          height: (pad.top + plotH - y).toFixed(2),
          fill: accent || `hsl(${hue} 65% 55%)`,
          'fill-opacity': 0.8,
          rx: Math.min(2, barW / 3).toFixed(2),
          'class': 'usage-bar',
        }));
      }

      // ── Columns drawn above replace the old per-series lines, areas and single-point
      // dots: one bucket per column describes the same data with less ink, and a lone
      // request gets its own bucket instead of disappearing (< 2 points used to mean an
      // invisible series).

      // Grid lines + axes.
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#999';
      for (let i = 0; i <= 4; i++) {
        const v = (i / 4) * vMax;
        const y = yOf(v);
        svg.appendChild(usageSvgEl('line', {
          x1: pad.left, y1: y, x2: pad.left + plotW, y2: y,
          stroke: muted, 'stroke-opacity': 0.12, 'stroke-width': 1,
        }));
        const txt = usageSvgEl('text', {
          x: pad.left - 6, y: y + 3,
          fill: muted, 'font-size': '8px', 'text-anchor': 'end',
        });
        txt.textContent = fmtTps(v);
        svg.appendChild(txt);
      }
      // Time axis labels — slice-aligned: label i sits at the centre of slice
      // round(i * binCount / 4) and carries that slice's timestamp. The axis is idle-
      // collapsed, so the stamps say when each column of activity happened rather than
      // marking a uniform fraction of the wall-clock span.
      const fmtTime = (t) => {
        const d = new Date(t);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };
      const xOfBin = (i) => pad.left + (i + 0.5) * binW;
      for (let i = 0; i <= 4; i++) {
        const bi = Math.min(binCount - 1, Math.round((i / 4) * (binCount - 1)));
        const x = xOfBin(bi);
        const txt = usageSvgEl('text', {
          x: x.toFixed(2), y: pad.top + plotH + 15,
          fill: muted, 'font-size': '8px', 'text-anchor': 'middle',
        });
        txt.textContent = fmtTime(bins[bi].t);
        svg.appendChild(txt);
      }
      // Y axis label.
      const yLab = usageSvgEl('text', {
        x: 10, y: pad.top + plotH / 2,
        fill: muted, 'font-size': '8px', 'text-anchor': 'middle',
        transform: `rotate(-90 10 ${pad.top + plotH / 2})`,
      });
      yLab.textContent = options.yLabel || 'tok/s';
      svg.appendChild(yLab);
    }

    /**
     * A cheap fingerprint of the history a publish describes.
     *
     * The plot is a full SVG rebuild, so republishing the samples already on it (a status
     * frame, a tab switch back to the conversation) must not pay for one. The count, the
     * newest timestamp and the billed total are enough: appending a turn changes all three,
     * and reordering the same samples draws the same picture.
     */
    function usagePointsSignature(session, points) {
      const list = Array.isArray(points) ? points : [];
      let total = 0;
      let newest = 0;
      for (const p of list) {
        total += Number(p?.tokens) || 0;
        const t = Number(p?.t);
        if (Number.isFinite(t) && t > newest) newest = t;
      }
      return `${session}|${list.length}|${total}|${newest}`;
    }

    /**
     * Hands the rail's session plot the transcript it should describe.
     *
     * The plot used to draw the router's "this process" view of /api/usage-series, which
     * is only what the running server happened to serve: a conversation resumed after a
     * restart, or one opened from an earlier day, drew as an empty plot with a label that
     * claimed a history it was not showing. The session file is the authority — it holds
     * every turn the conversation ever had, each with its own timestamp and billed tokens
     * — so the agent page publishes that history here and the plot draws it.
     *
     * `null` releases the plot back to the router's own view (a closed conversation, or one
     * with no session file yet). The redraw is requested rather than performed: the rail is
     * usually hidden when this is called, and a plot measured while hidden is a plot drawn
     * at the fallback size (see drawUsagePlot's fallback, and showView's redraw on the way
     * back to the agent view).
     *
     * @param {string|null} session the session file path, or null to release the plot
     * @param {{ t: number, tokens: number|null }[]} points the transcript's samples
     */
    function publishSessionUsage(session, points) {
      // The same conversation repainting (a status frame, a resumed turn) must not clear the
      // plot on its way to the same picture: that flash reads as "the history is gone". Only a
      // history that changed pays for the rebuild — the rail's plot is a whole SVG per publish,
      // and a page that reopens several conversations publishes it several times.
      if (session === usageSessionShown && Array.isArray(points)) {
        if (usagePointsSignature(session, points) === usageSessionSignature) return;
        applySessionUsagePoints(points);
        return;
      }
      usageSessionShown = session;
      usageSessionSignature = '';
      if (session == null) {
        usageSessionByKey.clear();
        return;
      }
      applySessionUsagePoints(points);
    }

    /**
     * The router's row for a model name a session recorded, or null when it has none.
     *
     * A session file records the id the upstream answered with ("claude-sonnet-4-6",
     * "models/gemini-3.6-flash"), which is not always the catalog id a row is keyed by, so the
     * comparison is on every name a row answers to, ignoring the "models/" prefix relays add.
     */
    function sessionModelRow(name) {
      const wanted = String(name || '')
        .toLowerCase()
        .replace(/^models\//, '')
      if (!wanted) return null
      const matches = (value) => {
        const id = String(value || '')
          .toLowerCase()
          .replace(/^models\//, '')
        return id && (id === wanted || id.endsWith('/' + wanted))
      }
      return (
        allModels.find(
          (row) =>
            row && [row.modelId, row.realModelId, row.personaModelId, row.label].some(matches),
        ) || null
      )
    }

    /** The name a legend should print for a series: the model, without the relay's "models/". */
    function sessionModelLabel(name) {
      return String(name || 'unknown model').replace(/^models\//, '')
    }

    /** Replaces the plot's data with one conversation's samples, then asks for a repaint. */
    function applySessionUsagePoints(points) {
      // One series per answering model, not one row for the whole conversation. Every message
      // carries the `hammer::best` alias as its key (the routed row cannot be reconstructed
      // after the fact), but each one also records the model that actually answered it.
      // Splitting by that name is what lets the rail show where the conversation changed
      // models — the same picture the transcript's model stations tell.
      usageSessionByKey.clear()
      const byModel = new Map()
      for (const p of Array.isArray(points) ? points : []) {
        const t = Number(p?.t)
        if (!Number.isFinite(t)) continue
        const model = String(p?.responseModel || '').trim() || 'unknown model'
        const key = `session::${model}`
        const series = byModel.get(key) || []
        series.push({ t, ttft: null, tps: null, tokens: Number(p?.tokens) || 0 })
        byModel.set(key, series)
      }
      for (const [key, series] of byModel) {
        series.sort((a, b) => a.t - b.t)
        usageSessionByKey.set(key, series)
      }
      renderSessionUsageLegend()
      usageSessionSignature = usagePointsSignature(usageSessionShown, points)
      requestSessionPlotRedraw()
    }

    /**
     * The rail plot's key: one swatch per model the conversation used.
     *
     * A single-model session needs no key — its plot is one colour and the title already says
     * what it is — so the legend appears only when there is something to tell apart.
     */
    function renderSessionUsageLegend() {
      const el = document.getElementById('usage-session-legend')
      if (!el) return
      // A key is evidence that a model contributed samples, not just that the router knows the
      // model. Filtering here also covers a session map populated by an older path.
      const keys = [...usageSessionByKey.entries()]
        .filter(([, series]) => Array.isArray(series) && series.length > 0)
        .map(([key]) => key)
      if (keys.length <= 1) {
        el.textContent = ''
        el.hidden = true
        return
      }
      // Keep the rail a key rather than a directory: the newest models are the ones a reader
      // is most likely to be looking for, and an unbounded flex list turns a busy session into
      // hundreds of lines of layout work.
      const visible = keys.slice(-SESSION_USAGE_LEGEND_LIMIT)
      const hidden = keys.slice(0, -SESSION_USAGE_LEGEND_LIMIT)
      el.hidden = false
      el.innerHTML =
        visible
          .map((key) => {
            const colour = modelAccentForKey(key) || `hsl(${usageKeyHue(key)} 65% 55%)`
            const name = sessionModelLabel(key.slice('session::'.length))
            return (
              '<span class="usage-session-legend-item">' +
              `<span class="usage-session-legend-swatch" style="background:${colour}"></span>` +
              `${escapeHtml(name)}</span>`
            )
          })
          .join('') +
        (hidden.length
          ? `<span class="usage-session-legend-item usage-session-legend-more" title="${escapeHtml(
              `${hidden.length} earlier model${hidden.length === 1 ? '' : 's'}: ${hidden
                .map((key) => sessionModelLabel(key.slice('session::'.length)))
                .join(', ')}`,
            )}">+${hidden.length} earlier</span>`
          : '')
    }

    /**
     * The fallback hue for one series, by the shape of its key.
     *
     * A router row's key is `provider::model`, and its provider is what the table already
     * colours by. A session series is different: it names the answering model and no provider
     * row, so hashing the provider part would paint every model in the conversation the same
     * colour — exactly the thing this plot has to show.
     */
    function usageKeyHue(key) {
      const id = String(key || '')
      const split = id.indexOf('::')
      if (split < 0) return usageProviderHue(id)
      const providerKey = id.slice(0, split)
      const modelId = id.slice(split + 2)
      if (providerKey === 'session') return usageProviderHue(modelId || 'unknown model')
      return usageProviderHue(providerKey)
    }

    /** The rail is usually hidden; redraw it when it next has a real box. */
    function requestSessionPlotRedraw() {
      if (typeof requestAnimationFrame !== 'function') return;
      requestAnimationFrame(() => {
        // Only the agent's rail holds this plot. While the router view is on screen it is
        // laid out at zero size, so a draw now would measure the fallback box and the reader
        // would see a plot sized for a width it does not have.
        if (document.body?.dataset?.view !== 'agent') return;
        drawUsagePlot('usage-session-svg', Object.fromEntries(usageSessionByKey), {
          valueOf: (p) => p.tokens,
          yLabel: 'tokens/s',
          fallback: { width: 240, height: 120 },
          pad: { top: 10, right: 8, bottom: 16, left: 30 },
        });
      });
    }

    // Draw both usage plots from the current series state, then every visible row's
    // per-model sparkline. The sparkline pass is last and separately id'd so it can also
    // run on its own from the 'usage' router event (see connectRouterEvents).
    function drawUsagePlots() {
      // Session plot: the conversation the agent rail is showing, from its own transcript.
      // It renders in the agent page's inspector rail, which is often hidden when this runs
      // (the page boots on the router view), so the fallback box and the tighter padding
      // match the rail rather than the wide cards this plot used to live in.
      drawUsagePlot('usage-session-svg', Object.fromEntries(usageSessionByKey), {
        valueOf: (p) => p.tokens,
        yLabel: 'tokens/s',
        fallback: { width: 240, height: 120 },
        pad: { top: 10, right: 8, bottom: 16, left: 30 },
      });
      // Global plot: every sample Hammer has recorded, this run and before it.
      drawUsagePlot('usage-global-svg', Object.fromEntries(usageSeriesByKey), {
        valueOf: (p) => p.tokens,
        yLabel: 'tokens/s',
      });
      drawUsageSparklines();
    }

    // One sparkline per provider::model row currently rendered in the table.
    // Repaints every usage cell currently on screen. Group rows are included: their cell
    // holds a series no row key owns, so it is refreshed through the group members
    // rather than by looking up usageSeriesByKey.
    function drawUsageSparklines() {
      for (const key of usageSeriesByKey.keys()) {
        drawUsageSparkline(`usage-cell-${key}`, key);
      }
      for (const tbody of [document.getElementById('table-body'), document.getElementById('graveyard-body')]) {
        if (!tbody) continue;
        for (const row of tbody.querySelectorAll('tr.model-group-row')) {
          const cell = row.querySelector('td.usage-sparkline-cell');
          if (!cell) continue;
          const groupKey = (row.dataset.rowKey || '').slice(2); // strip the 'g:' prefix
          const group = lastMainGroups.find(g => g.key === groupKey)
            || pendingGraveyardGroups.find(g => g.key === groupKey);
          if (group) drawGroupUsageSparklineInto(cell, group.members);
        }
      }
      drawProviderUsageSparklines();
    }

    // A provider's aggregate series: one sample per second window, summing the tokens every
    // model it served accounted for in that window. A model group merges providers of the same
    // model, where one request has one rate, but several of a provider's models can run at
    // once; the provider's plot is therefore their sum rather than the fastest sample.
    function combinedProviderSeries(providerKey) {
      const merged = new Map()
      for (const [key, pts] of usageSeriesByKey) {
        if (key.split('::', 1)[0] !== providerKey || !Array.isArray(pts)) continue
        for (const p of pts) {
          if (!p || p.t == null) continue
          const bucket = Math.floor(Number(p.t) / 1000)
          const prev = merged.get(bucket)
          if (!prev) {
            merged.set(bucket, { ...p, t: Number(p.t), tokens: Number(p.tokens) || 0 })
          } else {
            prev.tokens += Number(p.tokens) || 0
          }
        }
      }
      return [...merged.values()].sort((a, b) => a.t - b.t)
    }

    function drawProviderUsageSparklines() {
      for (const cell of document.querySelectorAll('td.provider-usage-cell[data-provider-usage]')) {
        drawProviderUsageSparklineInto(cell, cell.dataset.providerUsage)
      }
    }

    function drawProviderUsageSparklineInto(container, providerKey) {
      if (!container) return
      const combined = combinedProviderSeries(providerKey)
      if (combined.length === 0) {
        container.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>'
        return
      }
      drawUsageSparklineSeries(container, combined, providerKey)
    }

    // A model's combined series, keyed provider::model one per member and summed at
    // matching timestamps. A group's rate is the rate of whoever served that request, not
    // the sum of the providers' rates — so the combined sample is the best (fastest)
    // provider among those that answered within the same window. Where no window is that
    // tight it degrades to that one provider's sample, which is why the sparkline reads
    // the same as its rows do.
    function combinedGroupSeries(members) {
      const merged = new Map();
      for (const m of members) {
        const pts = usageSeriesByKey.get(`${m.providerKey}::${m.modelId}`);
        if (!Array.isArray(pts)) continue;
        for (const p of pts) {
          if (!p || p.t == null) continue;
          const bucket = Math.floor(Number(p.t) / 1000);
          const prev = merged.get(bucket);
          if (!prev) {
            merged.set(bucket, { ...p, t: Number(p.t) });
          } else {
            const prevTps = Number.isFinite(prev.tps) ? prev.tps : -Infinity;
            const nextTps = Number.isFinite(p.tps) ? p.tps : -Infinity;
            merged.set(bucket, nextTps > prevTps ? { ...p, t: Number(p.t) } : prev);
          }
        }
      }
      return [...merged.values()].sort((a, b) => a.t - b.t);
    }

    function drawGroupUsageSparkline(cellId, members) {
      const container = document.getElementById(cellId);
      if (container) drawGroupUsageSparklineInto(container, members);
    }

    // Element form, for the same reason drawUsageSparklineInto exists: the group row is
    // assembled before it is attached to the table.
    function drawGroupUsageSparklineInto(container, members) {
      if (!container) return;
      const combined = combinedGroupSeries(members);
      if (combined.length === 0) {
        container.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>';
        return;
      }
      // Reuse the single-series renderer: it takes the series directly, so the combined
      // series does not have to be stuffed into usageSeriesByKey to be plotted.
      drawUsageSparklineSeries(container, combined, members[0].providerKey, modelAccent(members[0]));
    }

    // Per-model sparkline: tiny tokens/s sparkline for one row's series.
    // The element form is the real implementation (a row is drawn before it is attached,
    // so it cannot be looked up by id yet); the id form is what the refresh passes use.
    function drawUsageSparkline(containerId, key) {
      const container = document.getElementById(containerId);
      if (container) drawUsageSparklineInto(container, key);
    }

    function drawUsageSparklineInto(container, key) {
      if (!container) return;
      const pts = usageSeriesByKey.get(key);
      if (!pts || pts.length === 0) {
        container.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>';
        return;
      }
      drawUsageSparklineSeries(container, pts, key.split('::')[0], modelAccentForKey(key));
    }

    function drawUsageSparklineSeries(container, pts, providerKey, accent = null) {
      // Replace, never accumulate: the create/update passes and every 'usage' event each
      // re-enter here for a cell that already holds its sparkline, so without this the row
      // grew a stack of them. One row, one plot.
      container.innerHTML = '';
      const W = 96, H = 28;
      const pad = { top: 2, right: 2, bottom: 6, left: 2 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top - pad.bottom;

      const svg = usageSvgEl('svg', {
        width: String(W),
        height: String(H),
        class: 'usage-sparkline',
        viewBox: `0 0 ${W} ${H}`,
      });
      const samples = pts.filter(p => p && Number.isFinite(Number(p.tokens)) && Number(p.tokens) > 0);
      if (samples.length === 0) {
        container.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>';
        return;
      }
      // The same axis as the full plots, at cell size: idle gaps collapsed, columns cut over
      // it, height = the slice's tokens per second — so this cell's area is its tokens too,
      // and a row that idled for hours between turns still shows those turns. Hue comes from
      // the provider whose samples these are (a group row passes its first member's, which is
      // close enough for a sparkline).
      const compressed = usageCompressedSeries(samples);
      const { bins, binCount, seconds } = usageTokenBins(compressed, 24, () => providerKey);
      const vMax = Math.max(...bins.map((b) => b.tokens / seconds), 0) || 1;
      const binW = plotW / binCount;
      const barW = Math.max(1, binW - Math.min(1.5, binW * 0.2));
      const hue = usageProviderHue(providerKey);
      for (let i = 0; i < binCount; i++) {
        const b = bins[i];
        if (b.tokens <= 0) continue;
        const h = (b.tokens / seconds / vMax) * plotH;
        svg.appendChild(usageSvgEl('rect', {
          x: (pad.left + i * binW + (binW - barW) / 2).toFixed(2),
          y: (pad.top + plotH - h).toFixed(2),
          width: barW.toFixed(2),
          height: Math.max(0.6, h).toFixed(2),
          fill: accent || `hsl(${hue} 70% 55%)`,
          'class': 'usage-bar',
        }));
      }

      container.appendChild(svg);
      // The area is the number now, so the label states the total rather than the last speed
      // (the Tok/s column already carries that).
      const totalTokens = samples.reduce((sum, p) => sum + Number(p.tokens || 0), 0);
      const label = document.createElement('div');
      label.style.cssText = 'font-size:0.68rem; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      label.textContent = `${Math.round(totalTokens).toLocaleString()} tokens`;
      container.appendChild(label);
    }

    // Spring-layout topology: provider nodes (favicon or monogram + ring + name)
    // anchor clusters of model circles with tiny labels. Drag to pan, scroll to
    // zoom, click a provider to highlight its cluster, dblclick to reset.
    // The currently selected/best model pulses blue. Spread fits the card laterally.
    function drawBipartiteTopology(models, bestModel = null) {
      const svg = document.getElementById('bg-topology-svg');
      if (!svg) return;

      // ---- Filter to exactly the primary-table model set ----
      // Mirror the main table: drop noauth rows (no API key), and drop any row
      // that would be struck through (paid / dead / incompatible / micro-context)
      // — those live in the graveyard table, not the primary table.
      const primaryModels = models.filter(m => {
        if (m.status === 'noauth') return false;
        if (isRowStruck(m)) return false;
        return true;
      });
      // Which of the four buckets a model group falls in, from the same verdicts the table
      // paints its dots with (see rowVerdict), so the picture cannot claim a model is up while
      // its row shows a clock. One predicate, read twice: the group filter below keeps only the
      // 'up' bucket, and modelStatusCls() colours whatever survives, so the two cannot
      // disagree about which models the plot is showing or how it is describing them.
      function modelGroupStatus(members) {
        const kinds = members.map(m => rowVerdict(m));
        if (kinds.some(kind => kind === 'up')) return 'up';
        if (kinds.some(kind => BENCHED_VERDICTS.has(kind))) return 'benched';
        const allInert = kinds.length > 0
          && kinds.every(kind => STRUCK_VERDICTS.has(kind) || kind === 'banned' || kind === 'excluded');
        return allInert ? 'disabled' : 'down';
      }

      // Always return a clean display name — never raw modelId with '/' or internal names
      function modelDisplayName(m) {
        const raw = (m.label && m.label.trim())
          ? m.label.trim()
          // Fallback: strip provider prefixes from modelId
          : (m.modelId || '').replace(/^[a-z0-9_-]+\//i, '').replace(/[-_](free|latest|snapshot|preview)$/i, '').trim() || m.modelId || 'Unknown';
        // "Free" is the row's tier, not part of the model's name: the same weights are sold
        // paid under the same label. The label keeps the marker (the table needs it to tell a
        // free row from its paid twin); the printed name does not.
        return raw.replace(/\s*\(free\)\s*$/i, '').replace(/\s+free\s*$/i, '').trim() || raw;
      }

      // ---- Build one node per model group using the exact same grouping as the
      // main table (canonical modelId key, then label-name merge), then keep only the groups
      // something can serve right now. This card counts "Models Online" and draws the network
      // behind that number — the KPI reads groupModels(models.filter(isRowUp)) — so a model that
      // cannot take a request has no business being a node on it. That is true whether the model
      // is broken (down) or merely waiting on a provider window (rate-limited / timed out): the
      // plot is a picture of what is live, and nothing else.
      //
      // The drop is per *group*, not per row: a provider keeps its place while one of its rows is
      // live for a model on the plot, and leaves with its last live row. Within a surviving group
      // only the live rows are kept, so a benched or down sibling is neither a link from the model
      // node nor a node on the provider ring.
      const uniqueModels = groupModels(primaryModels).map(g => ({
        ...g.members[0],
        label: g.label,
        _groupKey: g.key,
        _providers: g.members.map(m => ({ key: providerInstanceKey(m), model: m })),
      }))
        .filter(um => modelGroupStatus(um._providers.map(p => p.model)) === 'up')
        .map(um => ({ ...um, _providers: um._providers.filter(p => isRowUp(p.model)) }));
      const numModels = uniqueModels.length;

      // One node per provider *instance*, over the models that survived. A federated
      // provider's origins are separate servers with separate uptimes, their own set of models,
      // and their own outages, so they get their own nodes: one gateway hub would hide which
      // upstream a model hangs off, which is the whole reason the origins are tracked at all.
      //
      // Derived from the surviving groups rather than from every primary-table row, so a
      // provider whose models are all down drops out with them. Keeping the ring would leave a
      // node with no links — a picture of a server with nothing behind it — which is the same
      // claim the plot just stopped making about those models.
      const plotRows = uniqueModels.flatMap(um => um._providers.map(p => p.model));
      const plotProviders = [...new Set(plotRows.map(m => providerInstanceKey(m)))]
        .sort();
      const numProvs = plotProviders.length;

      // Which models are in use right now. Every conversation routes on its own slope, so several
      // can be answering at once, and the table already lights each of them (isCurrentBestRow).
      // The exported `best` belongs to the set as well: it is what the router answers with when a
      // caller names no conversation, and on a router with no console attached it is the only
      // live pick there is. Pairs, not ids — the same weights served by two origins are two
      // different serving paths, and the ring marks the origin that actually serves them.
      const activePicks = activePickRows
        .filter(pick => pick && pick.modelId)
        .map(pick => ({ modelId: String(pick.modelId), providerKey: pick.providerKey || '' }));
      if (bestModel) {
        activePicks.push({ modelId: bestModel.modelId, providerKey: bestModel.providerKey || '' });
      }
      const isActivePick = (modelId, providerKey = '') => activePicks.some(pick =>
        pick.modelId === modelId
        && (!pick.providerKey || !providerKey || pick.providerKey === providerKey));

      // Model-family → favicon domain (model's own brand, not the provider hosting it).
      // Matched by prefix (raw.includes(prefix)); first matching key wins, so overlapping
      // prefixes are ordered to prefer the more specific brand. Covers every model family
      // defined in sources.js so the plot can resolve a brand icon for each.
      const MODEL_DOMAINS = {
        // --- Chinese open-weight labs ---
        'deepseek': 'deepseek.com', 'deepseek-ai': 'deepseek.com',
        'qwen': 'qwen.ai', 'qwq': 'qwen.ai', 'qvq': 'qwen.ai',
        'glm': 'zhipuai.cn', 'z-ai': 'zhipuai.cn', 'zai': 'zhipuai.cn',
        'moonshot': 'moonshot.ai', 'kimi': 'moonshot.ai',
        'minimax': 'minimax.io', 'minimaxai': 'minimax.io', 'abab': 'minimax.io',
        'step': 'stepfun.com', 'stepfun': 'stepfun.com', 'stepfun-ai': 'stepfun.com',
        // Baidu's ERNIE, and the two labs whose HF org name is all a node ever carries.
        'baidu': 'baidu.com', 'ernie': 'baidu.com',
        'nex-agi': 'nex-agi.com', 'dots-studio': 'dots.studio',
        // iFlytek's Spark: its brand site is the console it sends users to, not the cloud host.
        'sparkdesk': 'xfyun.cn',
        'mimo': 'xiaomi.com', 'xiaomi': 'xiaomi.com',
        'inclusionai': 'inclusioncloud.com', 'ling': 'inclusioncloud.com', 'ring': 'inclusioncloud.com',
        'bytedance': 'bytedance.com', 'bytedance-seed': 'bytedance.com', 'seed': 'bytedance.com', 'dola': 'bytedance.com',
        'hy3': 'hunyuan.cloud.tencent.com', 'hunyuan': 'hunyuan.cloud.tencent.com', 'tencent': 'hunyuan.cloud.tencent.com',
        'cogito': 'deepcogito.com',
        'swe': 'cognition.ai',
        // --- Western labs / providers ---
        'gemini': 'ai.google.dev', 'gemma': 'ai.google.dev', 'google': 'ai.google.dev', 'learnlm': 'ai.google.dev',
        'claude': 'anthropic.com', 'anthropic': 'anthropic.com',
        'llama': 'meta.com', 'meta': 'meta.com',
        // A fine-tune's own leading word still names Llama: `finetuned-llama-3-70b` keeps
        // `llama` out of first position.
        'finetuned-llama': 'meta.com',
        // Meta's named open families — Muse Glimmer and Muse Spark sit beside Llama without it.
        'muse': 'meta.com',
        'nemotron': 'nvidia.com', 'nvidia': 'nvidia.com',
        // Reflection AI's Beam. The alias map at the top of sources.js names it
        // `reflection/beam-*`, and Ollama and Airforce publish the bare id for the same weights.
        'beam': 'reflection.ai', 'reflection': 'reflection.ai',
        // GPTFree's only model is `auto`, which names no brand; its label names one instead
        // ("Auto (GPTFree)"), which is what the parenthesised candidate above is for.
        'gptfree': 'gptfree.com',
        'gpt': 'openai.com', 'openai': 'openai.com',
        // OpenAI's other wire names: the Codex models that do not say `gpt`, the bare o-series
        // ids an aggregator relays, a gateway's own name for a GPT chat model, and OpenAI's
        // `chatgpt-*`/`chat-latest` aliases.
        'codex': 'openai.com', 'o1': 'openai.com', 'o3': 'openai.com', 'o4': 'openai.com',
        'chatgpt': 'openai.com', 'chat-latest': 'openai.com', 'unmoderated-gpt': 'openai.com',
        'mistral': 'mistral.ai', 'mistralai': 'mistral.ai', 'magistral': 'mistral.ai',
        'ministral': 'mistral.ai', 'codestral': 'mistral.ai', 'voxtral': 'mistral.ai',
        'devstral': 'mistral.ai', 'pixtral': 'mistral.ai', 'mixtral': 'mistral.ai',
        // Mistral's own `open-*` aliases for the models it opens.
        'open-mistral-nemo': 'mistral.ai',
        // --- The open-weight labs behind the aggregators' catalogs ---
        'morph': 'morphllm.com', 'relace': 'relace.ai', 'writer': 'writer.com', 'palmyra': 'writer.com',
        'inception': 'inceptionlabs.ai',
        'liquid': 'liquid.ai',
        'sakana': 'sakana.ai', 'fugu': 'sakana.ai',
        'thinkingmachines': 'thinkingmachines.ai', 'inkling': 'thinkingmachines.ai',
        'perplexity': 'perplexity.ai', 'sonar': 'perplexity.ai',
        'nousresearch': 'nousresearch.com', 'nous': 'nousresearch.com', 'hermes': 'nousresearch.com',
        'databricks': 'databricks.com', 'dbrx': 'databricks.com',
        'adept': 'adept.ai', 'fuyu': 'adept.ai',
        'perceptron': 'perceptron.inc',
        'allenai': 'allenai.org', 'olmocr': 'allenai.org',
        'venice': 'venice.ai',
        'prism-ml': 'prismml.com',
        'essentialai': 'essential.ai', 'rnj': 'essential.ai',
        'zyphra': 'zyphra.com', 'zamba': 'zyphra.com',
        'speakleash': 'speakleash.org', 'bielik': 'speakleash.org',
        'swiss-ai': 'swiss-ai.org', 'apertus': 'swiss-ai.org',
        'aisingapore': 'aisingapore.org', 'sea-lion': 'aisingapore.org',
        'bigcode': 'bigcode-project.org', 'starcoder': 'bigcode-project.org',
        '01-ai': '01.ai', 'yi': '01.ai',
        // GitHub's own Copilot-only catalog: its agent, search and compaction models exist
        // nowhere else, so GitHub is their vendor as well as their host.
        'exec-agent': 'github.com', 'copilot-search': 'github.com', 'trajectory-compaction': 'github.com',
        // The gateways' own router rows. Their id *is* the gateway's product, which is the
        // opposite of a third-party model relayed by one — there the vendor is the brand.
        'kilo-auto': 'kilocode.com', 'openrouter': 'openrouter.ai', 'requesty': 'requesty.ai',
        // Agnes AI's ids are its own product (`agnes-2.5-flash`), the same case as the rows
        // above rather than a third-party model relayed by the gateway.
        'agnes': 'agnes-ai.com',
        // G4F's own router row follows the same rule — the row is the gateway's product, and its
        // label says which gateway ("Auto (G4F)"), which is what the parenthesis reader is for.
        'g4f': 'g4f.dev',
        // xAI appears as `x-ai`, `xai-org` and g4f's `xai-z`, all of them its own name.
        'grok': 'x.ai', 'x-ai': 'x.ai', 'xai': 'x.ai',
        'microsoft': 'microsoft.com', 'phi': 'microsoft.com', 'mai': 'microsoft.com', 'wizardlm': 'microsoft.com',
        'command': 'cohere.com', 'north': 'cohere.com', 'cohere': 'cohere.com',
        // Cohere Labs' multilingual family, under every org name its ids carry — HuggingFace's
        // current `CohereLabs/`, the `CohereForAI/` these weights were first published under —
        // and under the bare C4AI/aya ids an aggregator publishes (`c4ai-aya-expanse-32b`).
        'coherelabs': 'cohere.com', 'cohereforai': 'cohere.com', 'c4ai': 'cohere.com',
        'tiny-aya': 'cohere.com', 'aya': 'cohere.com',
        // Cohere's Parse family is its own model and says so only in the id (`parse-v5.0`).
        'parse': 'cohere.com',
        'aria': 'ai21.com', 'jamba': 'ai21.com',
        'amazon': 'aws.amazon.com', 'nova': 'aws.amazon.com', 'titan': 'aws.amazon.com',
        'trinity': 'arcee.ai', 'arcee': 'arcee.ai',
        'laguna': 'poolside.ai', 'poolside': 'poolside.ai',
        'granite': 'ibm.com', 'ibm': 'ibm.com',
        // ALLaM is SDAIA's model, but the family lives with its steward now: the Hugging Face org
        // `ALLaM-AI` is `humain-ai`, and sdaia.gov.sa serves no icon the proxy can fetch.
        'allam': 'humain.ai',
        'stockmark': 'stockmark.co.jp',
        'colosseum': 'igenius.ai', 'igenius': 'igenius.ai',
        'orpheus': 'canopylabs.ai', 'canopylabs': 'canopylabs.ai',
        'compound': 'groq.com',
        'solar': 'upstage.ai', 'upstage': 'upstage.ai',
        'dolphin': 'cognitivecomputations.com',
        'falcon': 'tii.ae', 'olmo': 'allenai.org', 'exaone': 'lgresearch.ai',
      };
      // Token-aware brand lookup. A key only matches when it names the model's
      // LEADING word(s), so "dolphin-mistral" no longer borrows Microsoft's "phi"
      // icon and "novita" no longer borrows Amazon's "nova". A trailing version
      // suffix is allowed ("qwen" matches qwen3, "gemma" matches gemma3), but
      // arbitrary trailing letters are not. The full id is tried first so vendor
      // names still resolve (igenius/colosseum→), then the model part alone
      // (z-ai/glm5 → glm5, @cf/qwen/qwen3.8-27b → qwen3.8-27b).
      //
      // A gateway also names the backend it routed through, in front of the model it
      // routed to (`Airforce:claude-fable-5.1`, `community/user/o3-mini`), so the part
      // after that namespace is offered beside the whole id — the brand is in the model
      // name, never in the gateway's own prefix. And when no name in the id resolves at
      // all, the row's label gets the last word: it is hammer's name for the model.
      const DOMAIN_SPLIT_RE = /[-_./:\s]+/;
      function domainTokens(value) {
        return String(value || '')
          .toLowerCase()
          .replace(/(?::(?:free|optimized|cloud))+$/i, '')
          .split(DOMAIN_SPLIT_RE)
          .filter(Boolean);
      }
      function isDomainKeyPrefix(keyTokens, modelTokens) {
        if (!keyTokens.length || keyTokens.length > modelTokens.length) return false;
        for (let i = 0; i < keyTokens.length; i++) {
          const key = keyTokens[i], token = modelTokens[i];
          if (key === token) continue;
          const suffix = token.startsWith(key) ? token.slice(key.length) : null;
          if (i !== keyTokens.length - 1 || suffix == null || !/^\d[\d.-]*$/.test(suffix)) return false;
        }
        return true;
      }
      // The names one row offers, most authoritative first: the id's own leading word, then the
      // part a gateway namespaced behind its `/` or `:`.
      function domainNameCandidates(name) {
        const value = String(name || '').toLowerCase().replace(/^srv_[a-z0-9]+:/i, '');
        if (!value) return [];
        return [
          domainTokens(value),
          domainTokens(value.split('/').pop()),
          domainTokens(value.split(':').pop()),
          // A label that names its vendor in parentheses — `Auto (GPTFree)` — still names it:
          // the brackets are punctuation, not part of the brand.
          domainTokens((value.match(/\(([^)]+)\)/) || [])[1] || ''),
        ].filter(tokens => tokens.length > 0);
      }
      function domainForNames(candidates) {
        if (!candidates.length) return '';
        for (const [key, domain] of Object.entries(MODEL_DOMAINS)) {
          const keyTokens = String(key).split(DOMAIN_SPLIT_RE).filter(Boolean);
          if (candidates.some(tokens => isDomainKeyPrefix(keyTokens, tokens))) return domain;
        }
        return '';
      }
      // The label is the last word, and only when the id names no brand at all. An anonymous id
      // keeps resolving to '' on purpose: a stealth model's monogram is the honest mark, since
      // there is no brand to draw.
      function getModelDomain(m) {
        return domainForNames(domainNameCandidates(m.modelId))
          || domainForNames(domainNameCandidates(m.label));
      }

      // The table draws the same brand mark on its rows. It renders before this pass on the first
      // snapshot, and hydrates its logos once the plots have run (see modelDomainFor).
      modelDomainFor = getModelDomain;

      // Display identity per node. A federated origin is named by its catalog and marked by
      // its own hostname; a provider keeps the name and icon it always had. One entry per
      // scope, from its first row — every row of a scope names it the same way.
      const providerNodeInfo = new Map();
      for (const m of plotRows) {
        const id = providerInstanceKey(m);
        if (providerNodeInfo.has(id)) continue;
        providerNodeInfo.set(id, {
          name: providerInstanceName(m),
          // What a name shared with another node gets qualified by: the upstream's own label
          // when its catalog gave one, else the identity the router routes by, else the plain
          // fact that nothing named an upstream. Nothing here is invented.
          qualifier: m.originLabel || (m.originId ? String(m.originId) : 'no origin'),
          // The node's own hostname first — a federated origin's catalog name is usually its own
          // host, which is a truer brand mark than the gateway's — and then every site the
          // provider behind it names, so a node whose own host resolves to no icon is still drawn
          // with a mark instead of an empty disc. An origin that names itself `ollama.truenas` is a
          // machine on the relay's LAN, not a site: it is honest about its hostname, has no logo to
          // fetch, and the gateway that relays it does. The label beside the node keeps the two
          // distinguishable.
          domains: faviconHrefs([originFaviconDomain(m), ...(providerFaviconDomainLists.get(m.providerKey) || [])]),
        });
      }
      // A federated provider can hand two of its nodes the same name — its own bucket and the
      // rows it does not attribute to any upstream both read "G4F" — so only a shared name is
      // qualified, by the identity that actually tells the two apart. Distinct names (every
      // ordinary provider, and every catalog-named origin) are left exactly as they were.
      const nodeNameCounts = new Map();
      for (const info of providerNodeInfo.values()) {
        const key = info.name.toLowerCase();
        nodeNameCounts.set(key, (nodeNameCounts.get(key) || 0) + 1);
      }
      for (const info of providerNodeInfo.values()) {
        if ((nodeNameCounts.get(info.name.toLowerCase()) || 0) > 1) info.name = `${info.name} · ${info.qualifier}`;
      }
      const providerNodeName = (pk) => providerNodeInfo.get(pk)?.name || pk;
      // The brand-mark hrefs to try for a node, best first (see providerNodeInfo.domains).
      const providerNodeMarkHrefs = (pk) => providerNodeInfo.get(pk)?.domains || [];

      // Fit the viewBox to the card's actual pixel size. A federated provider multiplies the
      // node count several times over, and node labels are the one thing that has to stay
      // legible when it does, so past a couple of dozen nodes the rings shrink and the labels
      // shorten: neighbours on the ellipse are only a few tens of pixels apart at that size.
      const card = svg.parentElement;
      const W = card ? card.clientWidth : 600;
      const H = card ? card.clientHeight : 140;
      const cx = W / 2, cy = H / 2;
      const crowded = numProvs > 24;
      const provR = crowded
        ? Math.min(5.5, Math.max(4, Math.min(W, H) * 0.032))
        : Math.min(7.5, Math.max(5.5, Math.min(W, H) * 0.05));
      const faviconSz = Math.round(provR * 1.6);
      const clipR = Math.round(faviconSz / 2);
      // The label budget is in characters, so the crowded plot's smaller font (3.4px against
      // 4px, see .topo-provider-label.crowded) buys back the width the shorter text gives up:
      // at 18 characters the labels occupy about what 15 did at full size, and the extra room
      // is what keeps two origins' shortened names from printing identically.
      const providerLabelMax = crowded ? 18 : 22;
      const providerNodeLabel = (pk) => {
        const name = providerNodeName(pk);
        if (name.length <= providerLabelMax) return name;
        // Shorten from the middle rather than the end. The end is where the router's own
        // disambiguation lives ("qwen · 920d", see labelOrigins): cutting the tail would print
        // two different origins as the same node name, which is the one thing a node per origin
        // exists to prevent. Names with no such suffix shorten exactly as they did before.
        const sep = name.lastIndexOf(' · ');
        const tail = sep > 0 ? name.slice(sep) : '';
        const head = providerLabelMax - tail.length - 1;
        if (tail && head >= 4) return `${name.slice(0, head)}…${tail}`;
        return `${name.slice(0, providerLabelMax - 1)}…`;
      };

      // Rebuild whenever the actual model membership changes (not just the
      // count), so the plot stays in lock-step with the primary table as models
      // come and go between the main and graveyard tables in real time.
      const membershipSig = plotRows.map(m => getModelRowKey(m)).sort().join('|');
      const providerSig = plotProviders.join('|');
      // Which links are blue is a function of the *active* models as much as of the membership,
      // so the active pairs belong in the rebuild key: the classes are refreshed every render,
      // but a pick that moves to a pair the plot has not drawn yet needs the plot to redraw — a
      // signature that only watched membership would leave that serving path unmarked.
      const bestSig = activePicks
        .map(pick => `${pick.modelId}@${pick.providerKey}`)
        .sort()
        .join('|');
      // `dec` is in the key because whether the node marks exist is a property of what was drawn
      // (see faviconHrefs): a plot built before the idle pass is a different picture from the same
      // plot built after it, even though every model in it is identical.
      const svgHash = `${membershipSig}:${providerSig}:${bestSig}:${W}:${H}:dec=${decorationsReady ? 1 : 0}`;
      if (svg.dataset.hash !== svgHash) {
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = '';
        // Whatever placeholder the loading shell put here is gone with the markup above; the flag
        // goes with it, so "this element holds a placeholder" stays true of the element rather
        // than of what it used to hold (see setTopologyPlaceholder).
        delete svg.dataset.placeholder;
        svg.dataset.hash = svgHash;
        svg._topoZoom = 1;
        svg._topoPanX = 0;
        svg._topoPanY = 0;
        svg._topoHighlight = null;
        svg._topoDragging = false;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('id', 'topo-layer');
        svg.appendChild(g);

        // --- Build nodes (models first, then providers) ---
        const nodes = [];
        let seed = 0;
        for (let i = 0; i < plotProviders.length; i++) {
          for (let j = 0; j < plotProviders[i].length; j++) seed = ((seed << 5) - seed + plotProviders[i].charCodeAt(j)) | 0;
        }
        function lcg() { seed = (seed * 1664525 + 1013904223) | 0; return (seed >>> 0) / 4294967296; }

        // Provider nodes on a wide ellipse
        const rProvX = Math.min(W * 0.42, 8 + numProvs * 11);
        const rProvY = Math.min(H * 0.32, 6 + numProvs * 6);
        const provNodes = [];
        for (let i = 0; i < numProvs; i++) {
          const angle = (2 * Math.PI * i) / numProvs + (lcg() - 0.5) * 0.25;
          provNodes.push({
            id: `p:${plotProviders[i]}`, type: 'provider',
            providerKey: plotProviders[i],
            // The brand-mark hrefs for this provider node, best first.
            markHrefs: providerNodeMarkHrefs(plotProviders[i]),
            x: cx + rProvX * Math.cos(angle),
            y: cy + rProvY * Math.sin(angle),
            mass: 3.5
          });
        }

        // One node per unique model (models first in array for index lookups).
        // Each group is attached to at least one provider node, because the provider list is
        // derived from these same groups — nothing floats unattached.
        for (let i = 0; i < numModels; i++) {
          const um = uniqueModels[i];
          const connectedKeys = um._providers.map(p => p.key);
          // Anchor on the provider that's up when there is one.
          const bestProv = um._providers.find(p => isRowUp(p.model)) || um._providers[0];
          const anchorProv = provNodes.find(p => p.providerKey === bestProv.key);
          const angle = lcg() * 2 * Math.PI;
          const dist = 5 + lcg() * 14;
          nodes.push({
            id: `m:${um.modelId}`, type: 'model',
            model: um,
            providers: connectedKeys,
            providerKey: bestProv.key,
            umIdx: i,
            x: (anchorProv ? anchorProv.x : cx) + Math.cos(angle) * dist,
            y: (anchorProv ? anchorProv.y : cy) + Math.sin(angle) * dist,
            mass: 1.5
          });
        }
        for (const pn of provNodes) nodes.push(pn);

        // --- Edges: each model connects to EVERY provider that can serve it ---
        // One array, two jobs: these are the springs the layout reads (a model settles beside
        // the providers that can serve it) and the links drawn below are the same pairs. The
        // mesh is the picture of what *could* serve; which single one of them is serving is a
        // class decision made in the refresh below, where the router's pick is known.
        const edges = [];
        for (const node of nodes) {
          if (node.type !== 'model') continue;
          for (const pk of node.providers) {
            const prov = provNodes.find(p => p.providerKey === pk);
            if (prov) edges.push({ from: node, to: prov, providerKey: pk });
          }
        }

        // --- Real-time spring simulation: nodes glide from their seeded start
        // positions and settle under pairwise repulsion, edge springs, a gentle
        // centre pull, and friction. Integrated live each frame in
        // startTopologyAnimation, so the layout visibly "relaxes" into place. ---
        const marginX = provR + 8;
        const marginTop = provR + 6;
        const marginBottom = provR + 18;
        for (const n of nodes) { n.vx = 0; n.vy = 0; }

        // --- Draw edges ---
        // A path per pair, all of them muted-green once the refresh classifies them; the one
        // the router is actually using is painted blue there (see 'selected' below).
        for (const e of edges) {
          const mx = (e.from.x + e.to.x) / 2, my = (e.from.y + e.to.y) / 2;
          const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          let cxOff = 0, cyOff = 0;
          if (dist > 2) {
            const curvature = Math.min(5, dist * 0.20);
            cxOff = (-dy / dist) * curvature;
            cyOff = (dx / dist) * curvature;
          }
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M${e.from.x.toFixed(1)} ${e.from.y.toFixed(1)} Q${(mx + cxOff).toFixed(1)} ${(my + cyOff).toFixed(1)} ${e.to.x.toFixed(1)} ${e.to.y.toFixed(1)}`);
          path.setAttribute('class', 'topo-link');
          path.dataset.from = nodes.indexOf(e.from);
          path.dataset.to = nodes.indexOf(e.to);
          path.dataset.uidx = e.from.umIdx;
          path.dataset.pkey = e.providerKey;
          g.appendChild(path);
        }

        // --- Draw model nodes (circle + model favicon + tiny name label) ---
        for (const node of nodes) {
          if (node.type !== 'model') continue;
          const m = node.model;
          const ni = nodes.indexOf(node);
          const px = node.x.toFixed(1), py = node.y.toFixed(1);
          // 1. Background circle (status colour)
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          el.setAttribute('cx', px); el.setAttribute('cy', py); el.setAttribute('r', 5);
          el.setAttribute('class', 'topo-model');
          el.dataset.midx = ni; el.dataset.uidx = node.umIdx;
          el.dataset.pkeys = node.providers.join('|');
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${modelDisplayName(m)} · ${node.providers.map(p => providerNodeName(p)).join(', ')}`;
          el.appendChild(title);
          g.appendChild(el);
          // 2. Monogram disc + letter — always drawn so every model node shows a
          // branded glyph even when no favicon domain resolves (or the remote
          // request fails). The favicon image below sits on top and, on a
          // successful load, covers the monogram; on error it hides and the
          // monogram remains, exactly like the provider nodes.
          const monogram = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          monogram.setAttribute('cx', px); monogram.setAttribute('cy', py); monogram.setAttribute('r', 4.5);
          monogram.setAttribute('class', 'topo-model-mono');
          monogram.dataset.midx = ni; monogram.dataset.uidx = node.umIdx;
          monogram.dataset.pkeys = node.providers.join('|');
          const monoTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          monoTitle.textContent = modelDisplayName(m);
          monogram.appendChild(monoTitle);
          g.appendChild(monogram);

          const shortName = modelDisplayName(m);
          const glyphText = (shortName.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
          const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          glyph.setAttribute('x', px); glyph.setAttribute('y', py);
          glyph.setAttribute('class', 'topo-model-glyph');
          glyph.dataset.midx = ni; glyph.dataset.uidx = node.umIdx;
          glyph.textContent = glyphText;
          g.appendChild(glyph);

          // 3. Model-specific favicon (the model's own brand icon), overlaid on
          // the monogram. Only attempted when a domain resolved; an error hides
          // the (failed) remote image so the monogram shows through.
          const modelDom = getModelDomain(m);
          if (modelDom) {
            const mcId = `mclip-${ni}`;
            const defs = g.querySelector('defs') || (() => { const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); g.insertBefore(d, g.firstChild); return d; })();
            const cp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
            cp.setAttribute('id', mcId);
            const cc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            cc.setAttribute('cx', px); cc.setAttribute('cy', py); cc.setAttribute('r', 4.5);
            cc.dataset.midx = ni;
            cp.appendChild(cc); defs.appendChild(cp);
            const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            img.setAttribute('x', (node.x - 4).toFixed(1)); img.setAttribute('y', (node.y - 4).toFixed(1));
            img.setAttribute('width', '8'); img.setAttribute('height', '8');
            // A model node's mark is its vendor's, never its provider's: the node stands for the
            // model, and a gateway's logo on it would name the wrong thing. No vendor domain, or
            // a vendor with no icon, leaves the model's monogram showing.
            img.setAttribute('href', modelMarkHrefs(m)[0] || '');
            img.setAttribute('clip-path', `url(#${mcId})`);
            img.setAttribute('class', 'topo-model-img');
            img.dataset.midx = ni; img.dataset.uidx = node.umIdx;
            img.dataset.pkeys = node.providers.join('|');
            // A blocked/blank favicon must not erase the node: hide it so the
            // monogram beneath stays visible. The router answers 404 for a domain it
            // could not fetch an icon for, so a miss lands here rather than drawing a
            // placeholder brand mark.
            img.addEventListener('error', () => { img.style.display = 'none'; });
            const imgTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            imgTitle.textContent = modelDisplayName(m);
            img.appendChild(imgTitle);
            g.appendChild(img);
          }
          // 4. Tiny name label below (use display name)
          const trunc = shortName.length > 12 ? shortName.slice(0, 11) + '…' : shortName;
          if (trunc) {
            const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            lbl.setAttribute('x', px); lbl.setAttribute('y', (node.y + 9).toFixed(1));
            lbl.setAttribute('class', 'topo-model-label');
            lbl.dataset.midx = ni; lbl.dataset.uidx = node.umIdx;
            lbl.dataset.pkeys = node.providers.join('|');
            lbl.textContent = trunc;
            g.appendChild(lbl);
          }
        }

        // --- Draw provider nodes (ring + favicon or monogram + name) ---
        for (const node of provNodes) {
          const pk = node.providerKey, hasDomain = node.markHrefs.length > 0;          // Status ring
          const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          ring.setAttribute('cx', node.x.toFixed(1));
          ring.setAttribute('cy', node.y.toFixed(1));
          ring.setAttribute('r', provR);
          ring.setAttribute('class', 'topo-provider-ring');
          ring.dataset.pkey = pk;
          const ringTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          ringTitle.textContent = providerNodeName(pk);
          ring.appendChild(ringTitle);
          g.appendChild(ring);

          if (hasDomain) {
            const clipId = `topo-clip-${pk}-${numModels}`;
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
            clipPath.setAttribute('id', clipId);
            const clipCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            clipCircle.setAttribute('cx', node.x.toFixed(1));
            clipCircle.setAttribute('cy', node.y.toFixed(1));
            clipCircle.setAttribute('r', clipR);
            // The spring animation moves this provider node; keep its clip
            // geometry attached to the same node or the favicon gets clipped
            // at its old position after the first animation frame.
            clipCircle.dataset.midx = nodes.indexOf(node);
            clipPath.appendChild(clipCircle);
            defs.appendChild(clipPath);
            g.insertBefore(defs, g.firstChild);

            // Keep a visible monogram underneath the remote image. It prevents
            // a blocked favicon request from making the provider node disappear;
            // the real logo remains on top whenever it loads successfully.
            const mono = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            mono.setAttribute('cx', node.x.toFixed(1));
            mono.setAttribute('cy', node.y.toFixed(1));
            mono.setAttribute('r', clipR);
            mono.setAttribute('class', 'topo-provider-mono');
            mono.dataset.pkey = pk;
            const monoTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            monoTitle.textContent = providerNodeName(pk);
            mono.appendChild(monoTitle);
            g.appendChild(mono);

            const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            img.setAttribute('x', (node.x - clipR).toFixed(1));
            img.setAttribute('y', (node.y - clipR).toFixed(1));
            img.setAttribute('width', faviconSz);
            img.setAttribute('height', faviconSz);
            img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            const iconHref = node.markHrefs[0];
            img.setAttribute('href', iconHref);
            img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', iconHref);
            // Every candidate the router offered, walked in order on a failed load: the node's own
            // hostname first, then the sites the provider behind it names. A node whose hostname
            // resolves to no icon (a relay's LAN name, say) is therefore drawn with a real mark,
            // and one whose provider names no site at all still lands on the monogram rather than
            // on a broken image. The walk is finite because every candidate is compared against
            // what is already set, so an image that has exhausted the list hides itself.
            const markHrefs = node.markHrefs;
            let markIdx = 0;
            img.setAttribute('clip-path', `url(#${clipId})`);
            img.setAttribute('class', 'topo-provider-img');
            img.dataset.pkey = pk;
            const imgTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            imgTitle.textContent = providerNodeName(pk);
            img.appendChild(imgTitle);
            img.addEventListener('error', () => {
              let next = '';
              while (++markIdx < markHrefs.length && !next) {
                if (markHrefs[markIdx] !== img.getAttribute('href')) next = markHrefs[markIdx];
              }
              if (next) {
                img.setAttribute('href', next);
                img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', next);
                return;
              }
              // The monogram is already beneath the image, so just hide the
              // failed remote resource instead of inserting another node.
              img.style.display = 'none';
            });
            g.appendChild(img);
          } else {
            const mono = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            mono.setAttribute('cx', node.x.toFixed(1));
            mono.setAttribute('cy', node.y.toFixed(1));
            mono.setAttribute('r', clipR);
            mono.setAttribute('class', 'topo-provider-mono');
            mono.dataset.pkey = pk;
            const mTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            mTitle.textContent = providerNodeName(pk);
            mono.appendChild(mTitle);
            g.appendChild(mono);
          }

          // Provider name label below the ring
          const displayName = providerNodeLabel(pk);
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', node.x.toFixed(1));
          label.setAttribute('y', (node.y + provR + 8).toFixed(1));
          label.setAttribute('class', crowded ? 'topo-provider-label crowded' : 'topo-provider-label');
          label.setAttribute('data-pkey', pk);
          label.dataset.pkey = pk;
          label.textContent = displayName;
          g.appendChild(label);
        }

        // ---- Attach pan/zoom/highlight interactivity ----
        attachTopologyInteractivity(svg, g, W, H, plotProviders, primaryModels, numModels);
        const tz = svg._topoZoom || 1;
        const tpx = svg._topoPanX || 0;
        const tpy = svg._topoPanY || 0;
        g.setAttribute('transform', `translate(${tpx},${tpy}) scale(${tz})`);

        // ---- Kick off spring animation ----
        startTopologyAnimation(svg, g, nodes, edges, provNodes, provR, W, H);

      }

      // ---- Refresh colours, labels, and tooltips each render ----
      const gLayer = svg.querySelector('#topo-layer');
      if (!gLayer) return;
      const modelEls = gLayer.querySelectorAll('.topo-model');
      const links = gLayer.querySelectorAll('.topo-link');
      const rings = gLayer.querySelectorAll('.topo-provider-ring');
      const imgs = gLayer.querySelectorAll('.topo-provider-img');
      const monos = gLayer.querySelectorAll('.topo-provider-mono');

      const providerHealth = {};
      for (const pk of plotProviders) {
        const provModels = primaryModels.filter(m => providerInstanceKey(m) === pk);
        const upCount = provModels.filter(isRowUp).length;
        providerHealth[pk] = { upCount, total: provModels.length };
      }

      // Model status: the same verdict the table colours its dots with, so the picture
      // cannot claim a model is up while its row shows a clock or a red dot.
      function modelStatusCls(um, isBest) {
        // The same bucket the group filter above keeps on, and every survivor's links are the
        // live rows it kept, so this reads 'up' for anything on the plot. The verdict is still
        // asked for rather than assumed: if that filter ever lets a benched or down group
        // through, the colouring says so instead of quietly dressing it as a working model.
        const cls = modelGroupStatus(um._providers.map(p => p.model)) === 'up' ? ' up' : ' down';
        return `${cls}${isBest ? ' best' : ''}`;
      }
      // "Best" is really "in use": every model a conversation is routed to right now, which is
      // more than one whenever more than one conversation is working. The name is kept because
      // every class it drives (`.best`, `.selected`, the ring and the flowing link) is the same
      // accent, and one lit node per live model is exactly what that accent should draw.
      function isModelBest(um) {
        return um._providers.some(p => isActivePick(p.model.modelId, p.model.providerKey));
      }
      // The provider nodes serving a live pick, by instance key: a federated origin gets its own
      // ring, so the ring that lights is the one that actually answers for the model.
      const activeProviderKeys = new Set();
      for (const um of uniqueModels) {
        for (const p of um._providers) {
          if (isActivePick(p.model.modelId, p.model.providerKey)) activeProviderKeys.add(p.key);
        }
      }

      modelEls.forEach(el => {
        const mi = Number(el.dataset.uidx || 0);
        if (mi >= 0 && mi < numModels) {
          const um = uniqueModels[mi];
          if (!um) { el.setAttribute('class', 'topo-model'); return; }
          const isBest = isModelBest(um);
          const cls = `topo-model${modelStatusCls(um, isBest)}${isBest ? ' selected' : ''}`;
          if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
          const title = el.querySelector('title');
          if (title) title.textContent = `${modelDisplayName(um)} · ${um._providers.map(p => providerNodeName(p.key)).join(', ')}`;
        }
      });

      // Refresh model favicon images (and their monogram/glyph fallbacks)
      gLayer.querySelectorAll('.topo-model-img').forEach(el => {
        const mi = Number(el.dataset.uidx || 0);
        if (mi >= 0 && mi < numModels) {
          const um = uniqueModels[mi];
          if (!um) return;
          const isBest = isModelBest(um);
          const cls = `topo-model-img${isBest ? ' best' : ''}`;
          if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
          const title = el.querySelector('title');
          if (title) title.textContent = modelDisplayName(um);
        }
      });
      // Monogram + glyph always reflect the model's current health colour
      gLayer.querySelectorAll('.topo-model-mono, .topo-model-glyph').forEach(el => {
        const mi = Number(el.dataset.uidx || 0);
        if (mi >= 0 && mi < numModels) {
          const um = uniqueModels[mi];
          if (!um) return;
          const isBest = isModelBest(um);
          const cls = `topo-${el.classList.contains('topo-model-mono') ? 'model-mono' : 'model-glyph'}${modelStatusCls(um, isBest)}`;
          if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
        }
      });

      // Refresh model labels (class + text) so they never go stale between rebuilds
      gLayer.querySelectorAll('.topo-model-label').forEach(el => {
        const mi = Number(el.dataset.uidx || 0);
        if (mi >= 0 && mi < numModels) {
          const um = uniqueModels[mi];
          if (!um) return;
          const isBest = isModelBest(um);
          const cls = `topo-model-label${modelStatusCls(um, isBest)}`;
          if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
          const shortName = modelDisplayName(um);
          const trunc = shortName.length > 12 ? shortName.slice(0, 11) + '…' : shortName;
          if (trunc && el.textContent !== trunc) el.textContent = trunc;
        }
      });

      links.forEach(line => {
        const mi = Number(line.dataset.uidx || 0);
        if (mi >= 0 && mi < numModels) {
          const um = uniqueModels[mi];
          if (!um) { line.setAttribute('class', 'topo-link'); return; }
          // Every drawn link comes from a live row (see the group filter above), so there is
          // no benched or down link left for 'warn' or the bare muted stroke to describe.
          //
          // The links that wear the flowing blue are the serving paths: one per model in use, to
          // the provider instance that serves that exact row (the pair the selected ring marks
          // too). Every other drawn link stays the plain maroon mesh — those providers can serve
          // the model, but the router is not using them. Matching the pair rather than the model
          // is what keeps one model's mesh from lighting up with it.
          const isServingPath = um._providers.some(p => p.key === line.dataset.pkey
            && isActivePick(p.model.modelId, p.model.providerKey));
          const cls = `topo-link active${isServingPath ? ' selected' : ''}`;
          if (line.getAttribute('class') !== cls) line.setAttribute('class', cls);
        }
      });

      rings.forEach(ring => {
        const pk = ring.dataset.pkey;
        const h = providerHealth[pk];
        if (!h) return;
        // Green means the provider has at least one live model. Only providers with one are
        // drawn at all (see the group filter above), so this is 'green' by construction — the
        // count is still read rather than hardcoded, so a node that outlived its last live
        // model reads red instead of lying about it.
        // The providers serving a live model also get the selected ring (the accent, matching
        // the model they serve) — one per model in use, not only the exported best.
        const servesBest = activeProviderKeys.has(pk);
        ring.setAttribute('class', `topo-provider-ring${h.upCount > 0 ? ' green' : ' red'}${servesBest ? ' selected' : ''}`);
        const title = ring.querySelector('title');
        if (title) title.textContent = `${providerNodeName(pk)} · ${h.upCount}/${h.total} up`;
      });

      imgs.forEach(img => {
        const pk = img.dataset.pkey;
        const h = providerHealth[pk];
        if (!h) return;
        const title = img.querySelector('title');
        if (title) title.textContent = `${providerNodeName(pk)} · ${h.upCount}/${h.total} up`;
      });

      monos.forEach(mono => {
        const pk = mono.dataset.pkey;
        const h = providerHealth[pk];
        if (!h) return;
        mono.setAttribute('class', `topo-provider-mono${h.upCount === h.total && h.total > 0 ? ' green' : (h.upCount > 0 ? ' amber' : ' red')}`);
        const title = mono.querySelector('title');
        if (title) title.textContent = `${providerNodeName(pk)} · ${h.upCount}/${h.total} up`;
      });

      // Re-apply highlight dimming
      applyTopologyHighlight(svg, gLayer);
    }

    // ---- Interactivity: pan, zoom, click/dblclick ----
    function attachTopologyInteractivity(svg, _g, W, H, plotProviders, primaryModels, numModels) {
      if (svg._topoListenersAttached) return;
      svg._topoListenersAttached = true;

      if (!svg._topoZoom) svg._topoZoom = 1;
      if (!svg._topoPanX) svg._topoPanX = 0;
      if (!svg._topoPanY) svg._topoPanY = 0;

      let dragStart = null, dragPanStart = null, didDrag = false;

      function getG() { return svg.querySelector('#topo-layer'); }

      function getMouse(e) {
        const rect = svg.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }

      function applyTransform() {
        const g = getG(); if (!g) return;
        const z = svg._topoZoom || 1;
        const px = svg._topoPanX || 0;
        const py = svg._topoPanY || 0;
        g.setAttribute('transform', `translate(${px},${py}) scale(${z})`);
      }

      svg.addEventListener('mousedown', (e) => {
        if (e.target.closest('.topo-provider-ring') || e.target.closest('.topo-provider-img') || e.target.closest('.topo-provider-mono')) return;
        dragStart = getMouse(e);
        dragPanStart = { x: svg._topoPanX || 0, y: svg._topoPanY || 0 };
        didDrag = false;
        svg.classList.add('dragging');
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        const m = getMouse(e);
        const dx = m.x - dragStart.x, dy = m.y - dragStart.y;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        didDrag = true;
        svg._topoPanX = dragPanStart.x + dx;
        svg._topoPanY = dragPanStart.y + dy;
        applyTransform();
      });

      window.addEventListener('mouseup', () => {
        dragStart = null;
        svg.classList.remove('dragging');
      });

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const m = getMouse(e);
        const oldZoom = svg._topoZoom || 1;
        const delta = -e.deltaY * 0.002;
        const newZoom = Math.max(0.4, Math.min(4, oldZoom + delta * oldZoom));
        const px = svg._topoPanX || 0, py = svg._topoPanY || 0;
        svg._topoPanX = m.x - (m.x - px) * (newZoom / oldZoom);
        svg._topoPanY = m.y - (m.y - py) * (newZoom / oldZoom);
        svg._topoZoom = newZoom;
        applyTransform();
      }, { passive: false });

      svg.addEventListener('click', (e) => {
        if (didDrag) return;
        const provEl = e.target.closest('.topo-provider-ring') || e.target.closest('.topo-provider-img') || e.target.closest('.topo-provider-mono');
        const modelEl = e.target.closest('.topo-model') || e.target.closest('.topo-model-img') || e.target.closest('.topo-model-label');
        if (provEl) {
          const next = { type: 'provider', key: provEl.dataset.pkey };
          const current = svg._topoHighlight;
          svg._topoHighlight = current && current.type === next.type && current.key === next.key ? null : next;
          applyTopologyHighlight(svg, getG());
        } else if (modelEl) {
          const next = {
            type: 'model',
            index: Number(modelEl.dataset.uidx),
            providers: (modelEl.dataset.pkeys || '').split('|').filter(Boolean),
          };
          const current = svg._topoHighlight;
          svg._topoHighlight = current && current.type === next.type && current.index === next.index ? null : next;
          applyTopologyHighlight(svg, getG());
        } else if (svg._topoHighlight) {
          svg._topoHighlight = null;
          applyTopologyHighlight(svg, getG());
        }
      });

      svg.addEventListener('dblclick', () => {
        svg._topoZoom = 1;
        svg._topoPanX = 0;
        svg._topoPanY = 0;
        svg._topoHighlight = null;
        applyTransform();
        applyTopologyHighlight(svg, getG());
      });
    }

    function applyTopologyHighlight(svg, g) {
      const selection = svg._topoHighlight;
      const allEls = g.querySelectorAll('.topo-model, .topo-model-img, .topo-model-label, .topo-provider-ring, .topo-provider-img, .topo-provider-mono, .topo-link, .topo-provider-label');
      allEls.forEach(el => {
        if (!selection) {
          el.classList.remove('dimmed');
          return;
        }

        const elPk = el.dataset.pkey || el.getAttribute('data-pkey') || '';
        const elModelIndex = el.dataset.uidx == null ? null : Number(el.dataset.uidx);
        const elProviders = (el.dataset.pkeys || '').split('|').filter(Boolean);
        let isTarget = false;

        if (selection.type === 'provider') {
          // Keep the selected provider, every model it serves, and only the
          // links belonging to that provider visible.
          isTarget = elPk === selection.key
            || elProviders.includes(selection.key)
            || (el.classList.contains('topo-link') && el.dataset.pkey === selection.key);
        } else if (selection.type === 'model') {
          // Keep the selected model, every provider node connected to it, and
          // only the selected model's own links. Links also carry data-pkey,
          // so they must not match via the provider rule — otherwise lines
          // from the connected providers to other models would stay lit.
          const isLink = el.classList.contains('topo-link');
          isTarget = elModelIndex === selection.index
            || (!isLink && elPk && selection.providers.includes(elPk))
            || (isLink && Number(el.dataset.uidx) === selection.index);
        }
        el.classList.toggle('dimmed', !isTarget);
      });
    }

    // Where the last layout came to rest, so the next build of the same graph can start there.
    let settledTopologySignature = null;
    let settledTopologyPositions = new Map();
    function recordSettledTopology(signature, nodes) {
      settledTopologySignature = signature;
      settledTopologyPositions = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y }]));
    }

    // ---- Live spring layout: integrates repulsion + edge springs + gravity +
    // friction every frame until the graph settles. Nodes glide from their
    // seeded start positions and relax organically into place. ----
    function startTopologyAnimation(svg, g, nodes, edges, provNodes, provR, W, H) {
      if (svg._topoAnimFrame) cancelAnimationFrame(svg._topoAnimFrame);
      svg._topoAnimDone = false;

      const N = nodes.length;

      // Reuse the settled position of each node when this is the same graph drawn at the same
      // size. The layout is a relaxation, so starting from its own previous solution reaches the
      // same place in a few frames instead of scattering the picture and re-running a simulation
      // whose frames cost tens of milliseconds each — and every refresh rebuilds this graph, so
      // without this the page spends each refresh re-relaxing a picture the user already watched
      // settle. A different node set, or a resized card, is a new picture and is seeded fresh,
      // which is what keeps the relaxation visible where it means something.
      const graphSignature = `${W}x${H}|${nodes.map(n => n.id).join('|')}`;
      if (graphSignature === settledTopologySignature) {
        for (const n of nodes) {
          const settled = settledTopologyPositions.get(n.id);
          if (settled) { n.x = settled.x; n.y = settled.y; }
        }
      }

      // Build element lookup: nodeIndex → { circle, img, label, clipCircle }
      const elMap = new Array(N);
      for (let i = 0; i < N; i++) elMap[i] = {};

      // Model elements
      g.querySelectorAll('.topo-model').forEach(el => {
        const mi = Number(el.dataset.midx);
        if (mi >= 0 && mi < N) elMap[mi].circle = el;
      });
      g.querySelectorAll('.topo-model-img').forEach(el => {
        const mi = Number(el.dataset.midx);
        if (mi >= 0 && mi < N) elMap[mi].img = el;
      });
      g.querySelectorAll('.topo-model-mono').forEach(el => {
        const mi = Number(el.dataset.midx);
        if (mi >= 0 && mi < N) elMap[mi].mono = el;
      });
      g.querySelectorAll('.topo-model-glyph').forEach(el => {
        const mi = Number(el.dataset.midx);
        if (mi >= 0 && mi < N) elMap[mi].glyph = el;
      });
      g.querySelectorAll('.topo-model-label').forEach(el => {
        const mi = Number(el.dataset.midx);
        if (mi >= 0 && mi < N) elMap[mi].label = el;
      });

      // Provider elements
      provNodes.forEach(pn => {
        const ni = nodes.indexOf(pn);
        if (ni < 0) return;
        elMap[ni] = {
          ring: g.querySelector(`.topo-provider-ring[data-pkey="${pn.providerKey}"]`),
          img: g.querySelector(`.topo-provider-img[data-pkey="${pn.providerKey}"]`),
          mono: g.querySelector(`.topo-provider-mono[data-pkey="${pn.providerKey}"]`),
          label: g.querySelector(`.topo-provider-label[data-pkey="${pn.providerKey}"]`),
        };
      });

      // Clip path circles (model favicons)
      const clipCircles = g.querySelectorAll('clipPath circle');

      // Edge path elements (matched by from/to indices)
      const edgeEls = [];
      g.querySelectorAll('.topo-link').forEach(el => {
        edgeEls.push({ el, fi: Number(el.dataset.from), ti: Number(el.dataset.to) });
      });

      // ---- Spring-physics constants ----
      // Anisotropic metric: vertical distances are weighted by the card's
      // aspect ratio, so a wide/short card spreads the graph horizontally
      // instead of piling nodes into vertical stripes.
      const aspect = Math.max(1, W / Math.max(1, H));
      const ideal = Math.sqrt((W * H) / Math.max(6, N));   // Fruchterman–Reingold spacing
      const restLen = ideal * 0.85;                        // spring natural length (weighted px)
      const springK = 0.05;                                // spring stiffness
      const repulsion = ideal * ideal;                     // k²/d² pairwise push
      const repulsionCap = 50;
      const gravity = 0.03;                                // weak pull to centre
      const friction = 0.85;                               // velocity damping per frame
      const maxSpeed = 12;                                 // px/frame speed clamp
      const marginX = provR + 8;
      const marginTop = provR + 6;
      const marginBottom = provR + 18;

      let alpha = 1;          // cooling multiplier — guarantees convergence
      let frame = 0;
      let settleFrames = 0;
      // A frame cap cannot bound the time this spends on the main thread: at a few hundred nodes a
      // frame costs tens of milliseconds, so 240 of them starve the page for minutes rather than
      // the few seconds the cap is meant to promise. Whichever limit is reached first ends the
      // animation, so the budget is expressed in wall time and the frame cap stays as a backstop.
      const MAX_FRAMES = 240;
      const MAX_ANIMATION_MS = 4000; // avoid monopolizing the main thread
      const animationDeadline = performance.now() + MAX_ANIMATION_MS;

      function applyForces() {
        for (const n of nodes) { n.fx = 0; n.fy = 0; }
        // Pairwise repulsion (gradient under the weighted-distance metric)
        for (let a = 0; a < N; a++) {
          const na = nodes[a];
          for (let b = a + 1; b < N; b++) {
            const nb = nodes[b];
            let dx = nb.x - na.x, dy = (nb.y - na.y) * aspect;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.25) {
              // Deterministic jitter for coincident points
              dx = ((a * 31 + b * 17) % 11) - 5 || 0.7;
              dy = (((a * 13 + b * 7) % 7) - 3) || 0.4;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            const f = Math.min(repulsion / d2, repulsionCap) * alpha;
            const ux = dx / d, uy = dy / d;
            na.fx -= ux * f / na.mass; na.fy -= uy * f * aspect / na.mass;
            nb.fx += ux * f / nb.mass; nb.fy += uy * f * aspect / nb.mass;
          }
        }
        // Edge springs
        for (const e of edges) {
          const dx = e.to.x - e.from.x, dy = (e.to.y - e.from.y) * aspect;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const f = springK * (d - restLen) * alpha;
          const fx = (dx / d) * f, fy = (dy / d) * f * aspect;
          e.from.fx += fx / e.from.mass; e.from.fy += fy / e.from.mass;
          e.to.fx -= fx / e.to.mass; e.to.fy -= fy / e.to.mass;
        }
        // Gentle gravity toward the card centre
        for (const n of nodes) {
          n.fx += (W / 2 - n.x) * gravity * alpha / n.mass;
          n.fy += (H / 2 - n.y) * gravity * alpha / n.mass;
        }
      }

      function integrate() {
        let maxV = 0;
        for (const n of nodes) {
          n.vx = (n.vx + n.fx) * friction;
          n.vy = (n.vy + n.fy) * friction;
          const sp = Math.hypot(n.vx, n.vy);
          if (sp > maxSpeed) { n.vx *= maxSpeed / sp; n.vy *= maxSpeed / sp; }
          n.x += n.vx; n.y += n.vy;
          // Soft walls
          if (n.x < marginX) { n.x = marginX; n.vx = 0; }
          else if (n.x > W - marginX) { n.x = W - marginX; n.vx = 0; }
          if (n.y < marginTop) { n.y = marginTop; n.vy = 0; }
          else if (n.y > H - marginBottom) { n.y = H - marginBottom; n.vy = 0; }
          if (sp > maxV) maxV = sp;
        }
        return maxV;
      }

      function tick() {
        if (svg._topoAnimDone || frame >= MAX_FRAMES || performance.now() > animationDeadline) {
          svg._topoAnimDone = true;
          svg.classList.remove('topo-animating');
          recordSettledTopology(graphSignature, nodes);
          updateAllPositions();
          return;
        }
        frame++;
        applyForces();
        const maxV = integrate();
        updateAllPositions();
        // Settled once everything is barely moving for a few consecutive frames
        settleFrames = maxV < 0.06 ? settleFrames + 1 : 0;
        if (settleFrames >= 10) {
          svg._topoAnimDone = true;
          svg.classList.remove('topo-animating');
          recordSettledTopology(graphSignature, nodes);
          return;
        }
        alpha = Math.max(0.02, alpha * 0.988);
        svg._topoAnimFrame = requestAnimationFrame(tick);
      }

      function updateAllPositions() {
        // Update node elements
        for (let i = 0; i < N; i++) {
          const n = nodes[i];
          const px = n.x.toFixed(1), py = n.y.toFixed(1);
          const els = elMap[i];
          if (els.circle) { els.circle.setAttribute('cx', px); els.circle.setAttribute('cy', py); }
          if (els.img) { els.img.setAttribute('x', (n.x - 4).toFixed(1)); els.img.setAttribute('y', (n.y - 4).toFixed(1)); }
          if (els.mono) { els.mono.setAttribute('cx', px); els.mono.setAttribute('cy', py); }
          if (els.glyph) { els.glyph.setAttribute('x', px); els.glyph.setAttribute('y', py); }
          if (els.label) { els.label.setAttribute('x', px); els.label.setAttribute('y', (n.y + 9).toFixed(1)); }
          if (els.ring) { els.ring.setAttribute('cx', px); els.ring.setAttribute('cy', py); }
          if (els.img && els.img.classList.contains('topo-provider-img')) {
            els.img.setAttribute('x', (n.x - provR * 0.8).toFixed(1));
            els.img.setAttribute('y', (n.y - provR * 0.8).toFixed(1));
          }
          if (els.mono) { els.mono.setAttribute('cx', px); els.mono.setAttribute('cy', py); }
          if (els.label && els.label.classList.contains('topo-provider-label')) {
            els.label.setAttribute('y', (n.y + provR + 8).toFixed(1));
          }
        }
        // Update clip path circles via the node index stored at creation time
        // (avoids an O(N²) positional match on every animation frame).
        clipCircles.forEach(cc => {
          const ci = Number(cc.dataset.midx);
          if (ci >= 0 && ci < N) {
            cc.setAttribute('cx', nodes[ci].x.toFixed(1));
            cc.setAttribute('cy', nodes[ci].y.toFixed(1));
          }
        });
        // Update edge paths
        edgeEls.forEach(({ el, fi, ti }) => {
          if (fi < 0 || fi >= N || ti < 0 || ti >= N) return;
          const f = nodes[fi], t2 = nodes[ti];
          const mx = (f.x + t2.x) / 2, my = (f.y + t2.y) / 2;
          const dx = t2.x - f.x, dy = t2.y - f.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          let cxOff = 0, cyOff = 0;
          if (dist > 2) {
            const curvature = Math.min(5, dist * 0.20);
            cxOff = (-dy / dist) * curvature;
            cyOff = (dx / dist) * curvature;
          }
          el.setAttribute('d', `M${f.x.toFixed(1)} ${f.y.toFixed(1)} Q${(mx + cxOff).toFixed(1)} ${(my + cyOff).toFixed(1)} ${t2.x.toFixed(1)} ${t2.y.toFixed(1)}`);
        });
      }

      // Disable the 1.5s CSS transitions while JS drives geometry every frame;
      // they'd otherwise try to interpolate cx/cy/x/y and cause massive jank.
      svg.classList.add('topo-animating');
      svg._topoAnimFrame = requestAnimationFrame(tick);
    }

    function drawCurrentModelAnimation(hasActiveModel) {
      const svg = document.getElementById('bg-current-svg');
      if (!svg) return;
      if (svg.children.length === 0) {
        svg.setAttribute('viewBox', '0 0 240 102');

        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        const pts = [];
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i;
          pts.push(`${120 + 40 * Math.cos(angle)},${50 + 40 * Math.sin(angle)}`);
        }
        poly.setAttribute('points', pts.join(' '));
        poly.setAttribute('class', 'current-core');
        poly.style.transformOrigin = '120px 50px';
        svg.appendChild(poly);

        const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        core.setAttribute('cx', 120);
        core.setAttribute('cy', 50);
        core.setAttribute('r', 16);
        core.setAttribute('class', 'current-pulse');
        svg.appendChild(core);
      }

      const elements = Array.from(svg.children);
      elements.forEach(el => {
        el.style.opacity = hasActiveModel ? '' : '0';
      });
    }

    function pinModel(modelId, providerKey = null, groupKey = null) {
      const revision = ++pinMutationRevision;
      pendingPinMutations += 1;
      const nextScope = modelId ? (providerKey ? 'exact' : 'family') : null;
      setActivePinnedModel(modelId || null, providerKey, null, nextScope, groupKey, true);
      render(true);

      const mutation = pinMutationQueue.catch(() => {}).then(async () => {
        try {
          const res = await fetch('/api/pinned', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              modelId: modelId || null,
              providerKey: modelId ? providerKey : null,
              groupKey: modelId && !providerKey ? groupKey : null,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message || `Pin request failed with status ${res.status}`);

          // Every successful response is a real intermediate server state. Record
          // it even when a newer optimistic click owns the screen: if that newer
          // click fails, this is the correct state to restore.
          confirmedPinnedState = pinnedStateFrom(
            data.pinnedModelId,
            data.pinnedProviderKey,
            data.pinnedRowKeys,
            data.pinnedScope,
            data.pinnedGroupKey,
            data.pinnedAvailable,
          );
          if (revision !== pinMutationRevision) return;
          setActivePinnedModel(
            data.pinnedModelId,
            data.pinnedProviderKey,
            data.pinnedRowKeys,
            data.pinnedScope,
            data.pinnedGroupKey,
            data.pinnedAvailable,
          );
          await fetchData();
          return true;
        } catch (e) {
          if (revision === pinMutationRevision) {
            setActivePinnedModel(
              confirmedPinnedState.modelId,
              confirmedPinnedState.providerKey,
              confirmedPinnedState.rowKeys,
              confirmedPinnedState.scope,
              confirmedPinnedState.groupKey,
              confirmedPinnedState.available,
            );
            render(true);
            updateProxyErrorBanner({ message: e?.message || 'Could not change the selected model.', fallback: false });
          }
          return false;
        }
      }).finally(() => {
        pendingPinMutations = Math.max(0, pendingPinMutations - 1);
      });
      pinMutationQueue = mutation.catch(() => {});
      return mutation;
    }

    function handleSearch() {
      searchTerm = document.getElementById('search-input').value.toLowerCase();
      render(true);
    }

    // The models table is ordered by intelligence, strongest first, and offers no other
    // order. There used to be clickable headers (with arrows cycling asc → desc → default)
    // and a "reset sort" button; both are gone, so the only thing left to reflect in the
    // header is that one fixed fact: the Intelligence column is what the rows are ordered by.
    function updateSortHeaders() {
      const th = document.getElementById('th-intell');
      if (th) th.classList.add('sort-active');
      const arrow = document.getElementById('arrow-intell');
      if (arrow) arrow.textContent = '↓';
    }

    // Ignore leading bracketed tags such as "[次]" when ordering model names. The tag remains
    // visible; it is metadata, not the model name users expect alphabetical sorting to use.
    function sortableModelName(value) {
      return String(value || '').replace(/^(?:\[[^\]]*\]\s*)+/u, '').toLocaleLowerCase();
    }

    // Returns a comparable value for each column (lower = sorts first in asc)
    function colValue(m, col) {
      switch (col) {
        case 'status': return isRowUp(m) ? 0 : 1;
        case 'qos': return m.qos || 0;
        case 'intell': return getBenchmarkSortValue(m.intell);
        case 'rate': return isRateLimitedRow(m) ? 1 : 0;
        case 'health': return m.qos || 0; // fallback just in case
        case 'model': return sortableModelName(m.label || m.modelId);
        case 'ctx': return m.contextTokens || 0;
        default: return 0;
      }
    }

    // Default sort priority and direction when used as a tiebreaker.
    // dir: 1 = ascending (lower value first), -1 = descending (higher value first)
    // Default ordering (used on first paint and after reset): strongest model first.
    // Intelligence (the Artificial Analysis index) is the primary key; status then QoS break
    // ties among models with the same rating. Probe latency used to be a tiebreaker between
    // them, and is gone with the column that showed it: an order that depends on a measurement
    // the table no longer displays is one nobody can account for.
    const DEFAULT_SORT_CHAIN = [
      { col: 'intell', dir: -1 },  // Highest intelligence first
      { col: 'status', dir: 1 },   // up (0) before down (1)
      { col: 'qos', dir: -1 },     // Highest QoS first
      { col: 'model', dir: 1 },    // alphabetical
    ];
    // Primary (default) sort column, shown highlighted in the header when no
    // explicit sort is active, mirroring how the sorted row order actually works.
    const DEFAULT_SORT_COL = 'intell';
    const DEFAULT_SORT_DIR = 'desc';

    function compareByChain(a, b, chain) {
      for (const { col, dir } of chain) {
        const av = colValue(a, col);
        const bv = colValue(b, col);
        // Infinity always sorts last regardless of direction
        if (av === Infinity && bv === Infinity) continue;
        if (av === Infinity) return 1;
        if (bv === Infinity) return -1;
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
        if (cmp !== 0) return dir * cmp;
      }
      return 0;
    }

    // Compares two models by the one order this table has: intelligence descending, then
    // status, QoS and name as tiebreakers (see DEFAULT_SORT_CHAIN).
    function compareModels(a, b) {
      return compareByChain(a, b, DEFAULT_SORT_CHAIN);
    }

    function sortedModels(models) {
      return [...models].sort(compareModels);
    }

    function getModelGroupKey(m) {
      const c = canonicalizeClientModelId(m.modelId);
      return (c.unprefixed || m.modelId || '').toLowerCase();
    }

    // Mirrors the identity helpers in sources.js so dashboard grouping matches
    // the server: provider spelling, routing namespaces and runtime tags are
    // ignored, while model identity (family + version) is preserved.
    function clientResolvedModelId(modelId) {
      const raw = typeof modelId === 'string' ? modelId.trim() : '';
      if (!raw) return '';
      if (MODEL_ID_ALIASES[raw]) return MODEL_ID_ALIASES[raw];
      const lower = raw.toLowerCase();
      if (MODEL_ID_ALIASES[lower]) return MODEL_ID_ALIASES[lower];
      const stripped = raw.replace(/^srv_[a-z0-9]+:/i, '');
      if (stripped !== raw) return clientResolvedModelId(stripped);
      return raw;
    }

    // Both of these are pure functions of the id string, yet grouping calls them
    // hundreds of thousands of times per pass — every pairwise identity comparison
    // re-derives both sides from scratch — while a catalogue only holds a few hundred
    // distinct ids. Memoizing them is what takes a full grouping from seconds to
    // milliseconds. Non-string ids bypass the cache so they can never be conflated
    // with their string equivalents.
    const identityNameCache = new Map();
    const identityKeyCache = new Map();
    const identityTokenCache = new Map();

    function normalizedModelIdentityName(modelId) {
      if (typeof modelId === 'string') {
        const cached = identityNameCache.get(modelId);
        if (cached !== undefined) return cached;
        const value = computeNormalizedModelIdentityName(modelId);
        identityNameCache.set(modelId, value);
        return value;
      }
      return computeNormalizedModelIdentityName(modelId);
    }

    function computeNormalizedModelIdentityName(modelId) {
      let value = clientResolvedModelId(modelId).toLowerCase();
      if (!value) return '';
      value = value.replace(/^models\//, '');
      const segments = value.split('/');
      value = segments[segments.length - 1];
      value = value.replace(/(?::(?:free|optimized|cloud))+$/i, '');
      return value.replace(/[-_:/\\.\s]+/g, ' ').trim();
    }

    function getModelIdentityKey(modelId) {
      if (typeof modelId === 'string') {
        const cached = identityKeyCache.get(modelId);
        if (cached !== undefined) return cached;
        const key = computeModelIdentityKey(modelId);
        identityKeyCache.set(modelId, key);
        return key;
      }
      return computeModelIdentityKey(modelId);
    }

    // The leading family token of an id ('nvidia/nemotron-3-super-120b-a12b' →
    // 'nemotron'). A size-qualified alias can only match when the shorter name is a
    // token-wise prefix of the longer one, so two ids for the same model always agree
    // here (or on their identity key) — which is what lets groupModels skip the
    // pairwise identity test for buckets that cannot possibly match.
    function modelIdentityFirstToken(modelId) {
      const cacheable = typeof modelId === 'string';
      if (cacheable) {
        const cached = identityTokenCache.get(modelId);
        if (cached !== undefined) return cached;
      }
      const token = normalizedModelIdentityName(modelId).split(' ').filter(Boolean)[0] || '';
      if (cacheable) identityTokenCache.set(modelId, token);
      return token;
    }

    function computeModelIdentityKey(modelId) {
      return normalizedModelIdentityName(modelId).replace(/\s+/g, '');
    }

    function isModelSizeToken(token) {
      return /^(?:a\d+b|\d+(?:\.\d+)?x\d+[bemt]|\d+[bemt]|q\d+(?:[_-][a-z0-9]+)*|fp\d+|int\d+|bf16|awq|gptq|gguf)$/i.test(String(token || ''));
    }

    function isSameModelIdentity(a, b) {
      const keyA = getModelIdentityKey(a);
      const keyB = getModelIdentityKey(b);
      if (!keyA || !keyB) return false;
      if (keyA === keyB) return true;
      const nameA = normalizedModelIdentityName(a).split(' ').filter(Boolean);
      const nameB = normalizedModelIdentityName(b).split(' ').filter(Boolean);
      if (!nameA.length || !nameB.length) return false;
      const [shortTokens, longTokens] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA];
      if (shortTokens.length === longTokens.length) return false;
      for (let i = 0; i < shortTokens.length; i++) {
        if (shortTokens[i] !== longTokens[i]) return false;
      }
      if (/^\d+$/.test(shortTokens[shortTokens.length - 1])) return false;
      const extra = longTokens.slice(shortTokens.length);
      // A lone trailing `t` is a route marker on a mirror's bot name ("…-Flash-T"), not a
      // different model — see the same rule in `sources.js`.
      if (extra.length === 1 && extra[0] === 't') return true;
      return extra.every((token, index) => isModelSizeToken(token) || (index === extra.length - 1 && /^\d{1,2}$/.test(token)));
    }

    function isLatestModelName(modelId) {
      return /(?:^|[-_/:\s])latest(?:$|[-_/:\s])/i.test(String(modelId || ''));
    }

    function latestModelFamilyKey(modelId) {
      let value = String(modelId || '').trim().toLowerCase();
      value = value.replace(/^srv_[a-z0-9]+:/i, '').replace(/^models\//, '');
      value = value.replace(/^[^/]+\//, '').replace(/(?::(?:free|optimized|cloud))+$/i, '');
      value = value.replace(/\b(?:latest|current|default)\b/g, ' ');
      value = value.replace(/\b\d+(?:\.\d+)+\b/g, ' ');
      value = value.replace(/\b\d+\b/g, ' ');
      return value.replace(/[-_:/\\.]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function modelVersionTuple(modelId) {
      const matches = String(modelId || '').match(/\d+(?:\.\d+)+|\d+/g) || [];
      return matches.flatMap(part => part.split('.').map(Number)).filter(Number.isFinite);
    }

    function compareModelVersions(a, b) {
      const left = modelVersionTuple(a), right = modelVersionTuple(b);
      const length = Math.max(left.length, right.length);
      for (let i = 0; i < length; i++) {
        const av = left[i] == null ? -1 : left[i], bv = right[i] == null ? -1 : right[i];
        if (av !== bv) return av - bv;
      }
      return left.length - right.length;
    }

    // Strip the provider prefix (before '/') and runtime suffix (after ':') from
    // heading model names so discovered ids like "nvidia/model:free" read cleanly.
    function cleanHeadingModelName(name) {
      if (!name) return name;
      let n = String(name).trim();
      const slash = n.indexOf('/');
      if (slash !== -1) n = n.slice(slash + 1);
      const colon = n.indexOf(':');
      if (colon !== -1) n = n.slice(0, colon);
      return n.trim();
    }

    // Canonical key deciding whether two headings are the same model. Provider
    // prefix and ':...' suffixes are stripped, '-free' dropped, separators folded
    // to spaces and case lowered — so 'nvidia/nemotron-3.5-lightning' and
    // 'nemotron-3.5-lightning-free' (or its human label) merge into one heading.
    function headingMergeKey(name) {
      let n = cleanHeadingModelName(name).toLowerCase();
      n = n.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      n = n.replace(/\s+free$/, '').trim();
      return n;
    }

    // Human-readable labels (spaces / capitals) are preferred for merged headings
    // over raw model ids like "nemotron-3.5-lightning".
    function labelLooksHuman(name) {
      const s = String(name || '');
      return !!s && (/\s/.test(s) || /[A-Z]/.test(s));
    }

    // Grouping is a function of which models exist and how they are named — the model id, its
    // learned backend id and its heading label — and of nothing a test produces. Deriving it is
    // the most expensive step of a render (~0.8s at 1,700 models), and a refresh re-derives the
    // groups, sorts them and repaints every row for a test that changed one row's stats. The
    // shape is therefore cached and re-linked to the current model objects. The signature covers
    // exactly the fields the merge reads, so a changed or renamed model set misses and recomputes.
    //
    // A refresh asks two different questions of this — the whole visible table, and the subset
    // the router considers usable — and a single-slot cache would lose the first answer to the
    // second and re-derive it on the very next refresh. Hence a small keyed cache: a handful of
    // shapes covers the table, the usable subset and whatever the search box is narrowing to.
    const MAX_CACHED_GROUPINGS = 4;
    const cachedGroupings = new Map();

    function modelGroupingSignature(models) {
      let sig = '';
      for (const m of models) {
        sig += (m.modelId || '') + '\u0000' + (m.realModelId || '') + '\u0000' + (m.label || '')
          + '\u0000' + (m.modelGroupId || '') + '\u0000' + (m.modelGroupLabel || '') + '\u0001';
      }
      return sig;
    }

    function groupModels(models) {
      const signature = modelGroupingSignature(models);
      const cached = cachedGroupings.get(signature);
      const byRowKey = () => {
        const map = new Map();
        for (const m of models) map.set(getModelRowKey(m), m);
        return map;
      };
      if (cached) {
        // Re-link the cached partition to the objects the caller just handed us: a refresh
        // replaces every model object, so a cached group must never hold yesterday's stats.
        const lookup = byRowKey();
        // Refresh recency so a repeatedly used shape survives the eviction below.
        cachedGroupings.delete(signature);
        cachedGroupings.set(signature, cached);
        return cached.map(g => ({
          key: g.key,
          label: g.label,
          canonicalId: g.canonicalId,
          members: g.memberKeys.map(k => lookup.get(k)).filter(Boolean),
        }));
      }
      const groups = computeModelGroups(models);
      cachedGroupings.set(signature, groups.map(g => ({
        key: g.key,
        label: g.label,
        canonicalId: g.canonicalId,
        memberKeys: g.members.map(m => getModelRowKey(m)),
      })));
      while (cachedGroupings.size > MAX_CACHED_GROUPINGS) {
        cachedGroupings.delete(cachedGroupings.keys().next().value);
      }
      return groups;
    }

    // The grouping itself. Identical inputs always produce an identical partition, which is what
    // lets the wrapper above hand back a cached shape instead of re-deriving it.
    function computeModelGroups(models) {
      // Current routers include the canonical partition on every row. Trust that
      // contract completely; the historical client-side alias/identity pass below is
      // retained only for an older router and is never allowed to widen a server group.
      if (models.length > 0 && models.every(m => typeof m.modelGroupId === 'string' && m.modelGroupId)) {
        const serverGroups = new Map();
        for (const m of models) {
          let group = serverGroups.get(m.modelGroupId);
          if (!group) {
            group = {
              key: m.modelGroupId,
              label: m.modelGroupLabel || m.label,
              canonicalId: m.modelGroupId,
              members: [],
            };
            serverGroups.set(m.modelGroupId, group);
          }
          group.members.push(m);
        }
        return [...serverGroups.values()];
      }

      const groups = new Map();
      for (const m of models) {
        const key = getModelGroupKey(m);
        let g = groups.get(key);
        if (!g) {
          g = { key, label: m.label, canonicalId: canonicalizeClientModelId(m.modelId).base, members: [] };
          groups.set(key, g);
        }
        g.members.push(m);
      }

      // The same model can be catalogued under different ids across providers
      // (e.g. meta/llama-4-scout-17b-16e-instruct vs meta-llama/llama-4-scout-17b-16e-preview,
      // or a 'model' and a 'model-free' variant). Merge groups that resolve to the
      // same normalized heading name so each model gets exactly one heading row
      // with all of its providers underneath.
      const byLabel = new Map();
      for (const g of groups.values()) {
        const labelKey = headingMergeKey(g.label);
        if (!labelKey) {
          byLabel.set('__id:' + g.key, g);
          continue;
        }
        const existing = byLabel.get(labelKey);
        if (existing) {
          existing.members.push(...g.members);
          // Prefer a human-readable label for the merged heading
          if (labelLooksHuman(g.label) && !labelLooksHuman(existing.label)) {
            existing.label = g.label;
          }
        } else {
          byLabel.set(labelKey, g);
        }
      }
      // Merge groups that are the same model under different provider spellings
      // (qwen/qwen3.8-27b vs qwen-3.8-27b, or a size-qualified alias such as
      // nemotron-3-super vs nvidia/nemotron-3-super-120b-a12b). Matching uses
      // each group's ids, its learned real backend id, and its heading label, so
      // g4f mirrors land under the manufacturer's row.
      let mergedGroups = [...byLabel.values()];
      const identityBuckets = [];
      for (const group of mergedGroups) {
        const ids = [];
        for (const member of group.members) {
          if (member && member.modelId) ids.push(member.modelId);
          if (member && member.realModelId) ids.push(member.realModelId);
        }
        if (group.canonicalId) ids.push(group.canonicalId);
        if (group.label) ids.push(group.label);
        // isSameModelIdentity can only be true when the two ids share an identity key
        // (after normalization) or a leading family token, so buckets that share
        // neither are skipped outright. The full pairwise test still decides the
        // outcome, and the scan order is unchanged, so the merge result is identical.
        const keys = new Set();
        const tokens = new Set();
        for (const id of ids) {
          keys.add(getModelIdentityKey(id));
          tokens.add(modelIdentityFirstToken(id));
        }
        const target = ids.length
          ? identityBuckets.find(bucket => {
              let plausible = false;
              for (const key of keys) if (bucket.keys.has(key)) { plausible = true; break; }
              if (!plausible) for (const token of tokens) if (bucket.tokens.has(token)) { plausible = true; break; }
              if (!plausible) return false;
              return bucket.ids.some(a => ids.some(b => isSameModelIdentity(a, b)));
            })
          : null;
        if (!target) { identityBuckets.push({ group, ids, keys, tokens }); continue; }
        const targetSize = target.group.members.length;
        target.group.members.push(...group.members);
        // The heading keeps the label of whichever group brings the most
        // providers, so a single persona row cannot rename a shared catalogue row.
        if (group.members.length > targetSize) target.group.label = group.label;
        target.ids.push(...ids);
        for (const key of keys) target.keys.add(key);
        for (const token of tokens) target.tokens.add(token);
      }
      mergedGroups = identityBuckets.map(bucket => bucket.group);
      const latestGroups = new Set();
      const concreteByFamily = new Map();
      for (const group of mergedGroups) {
        const modelsWithIds = group.members.filter(member => member && member.modelId);
        if (modelsWithIds.some(member => isLatestModelName(member.modelId) || isLatestModelName(member.label))) {
          latestGroups.add(group);
          continue;
        }
        const family = latestModelFamilyKey(modelsWithIds[0]?.modelId || group.label);
        if (!family) continue;
        const current = concreteByFamily.get(family);
        if (!current || compareModelVersions(modelsWithIds[0].modelId, current.members[0]?.modelId) > 0) {
          concreteByFamily.set(family, group);
        }
      }

      for (const group of latestGroups) {
        const modelsWithIds = group.members.filter(member => member && member.modelId);
        const target = concreteByFamily.get(latestModelFamilyKey(modelsWithIds[0]?.modelId || group.label));
        if (target && target !== group) target.members.push(...group.members);
      }

      return mergedGroups.filter(group => !latestGroups.has(group) || !concreteByFamily.has(latestModelFamilyKey(group.members[0]?.modelId || group.label)) || concreteByFamily.get(latestModelFamilyKey(group.members[0]?.modelId || group.label)) === group);
    }

    // Health tier for ordering provider sub-rows, read off the same verdict the status
    // cell draws: 0 = the green dot, 1 = the clock (benched: rate-limited or timed out),
    // 2 = everything else. Sharing the verdict is what keeps the colours and the order
    // from drifting apart.
    function providerHealthTier(m) {
      const kind = rowVerdict(m);
      if (kind === 'up') return 0;
      return BENCHED_VERDICTS.has(kind) ? 1 : 2;
    }

    // Providers within a model group sorted by: health tier first (green dot
    // above rate-limited/timed-out above down), then Ready, paid last, then faster first.
    function compareProviders(a, b) {
      // Health tier first — same states the status dot/clock displays (see
      // providerHealthTier), so the visual grouping matches the order.
      const tierDelta = providerHealthTier(a) - providerHealthTier(b);
      if (tierDelta !== 0) return tierDelta;
      // Ready (has a successful test result) sorts first — uses the same definition
      // as isLastResponseReady so the sort matches the dashboard status display.
      const aReady = isLastResponseReady(a.lastResponse);
      const bReady = isLastResponseReady(b.lastResponse);
      if (aReady && !bReady) return -1;
      if (!aReady && bReady) return 1;
      // Paid sorts last
      const aPaid = rowVerdict(a) === 'paid';
      const bPaid = rowVerdict(b) === 'paid';
      if (aPaid && !bPaid) return 1;
      if (!aPaid && bPaid) return -1;
      // Faster ping first (Infinity = offline, sorts last)
      const aPing = a.avg === Infinity || a.avg === null ? Infinity : a.avg;
      const bPing = b.avg === Infinity || b.avg === null ? Infinity : b.avg;
      if (aPing === Infinity && bPing === Infinity) return 0;
      if (aPing === Infinity) return 1;
      if (bPing === Infinity) return -1;
      return aPing - bPing;
    }

    // The number a heading prints, in its own units: the catalogue's AA index when the row
    // carries one, otherwise the local score as the percentage getBenchmarkDisplayValue
    // renders. Reading the same fields the cell reads is what keeps the order and the column
    // from disagreeing.
    function benchmarkDisplayNumber(m) {
      if (!m) return 0;
      const aa = Number(m.aa);
      if (Number.isFinite(aa) && aa > 0) return aa;
      return getBenchmarkSortValue(m.intell) * 100;
    }

    // The rating a heading prints is the strongest one any of the model's *listed* providers
    // carries: splitDisplayGroups moves struck rows to the unavailable table before the heading
    // is summarised, and getGroupSummary renders the score of the member with the highest
    // `intell`. Ordering on anything else put the table out of order — by the healthiest
    // provider's value, a 40.9 model sank below a 30 one whenever its leading member was the
    // unrated copy; by every member, a model whose paid rows carry the better rating floated
    // up while its heading still printed the weaker listed one.
    function groupSortIntell(group) {
      let bestIntell = 0;
      let bestMember = null;
      for (const m of group.members) {
        if (isRowStruck(m)) continue;
        if (!bestMember) bestMember = m;
        const value = Number(m.intell) || 0;
        if (value > bestIntell) {
          bestIntell = value;
          bestMember = m;
        }
      }
      return benchmarkDisplayNumber(bestMember);
    }

    function sortedGroups(groups) {
      return groups
        .map(g => ({ ...g, members: [...g.members].sort(compareProviders) }))
        .sort((a, b) => {
          // Intelligence descending, strongest first, on the number the heading shows.
          const intellDelta = groupSortIntell(b) - groupSortIntell(a);
          if (intellDelta !== 0) return intellDelta;
          const cmp = compareModels(a.members[0], b.members[0]);
          if (cmp !== 0) return cmp;
          return sortableModelName(a.label).localeCompare(sortableModelName(b.label));
        });
    }

    // Flattens sorted groups into heading rows followed by their provider rows.
    // A single-provider model needs no redundant provider sub-row: show that
    // provider in the heading and keep the model to one compact row.
    const collapsedModelGroups = new Set();
    let modelGroupsInitialized = false;
    // The heading rows of the last render, so the accordion toggle knows which
    // other multi-provider groups to collapse when one is expanded.
    let lastMainGroups = [];

    function toggleModelGroup(groupKey) {
      if (collapsedModelGroups.has(groupKey)) {
        collapsedModelGroups.delete(groupKey);
        // Accordion: expanding this heading collapses every other multi-provider
        // group, so only one model's providers are visible at a time.
        for (const g of lastMainGroups) {
          if (g.key !== groupKey && g.members.length > 1) collapsedModelGroups.add(g.key);
        }
      } else {
        collapsedModelGroups.add(groupKey);
      }
      render(true);
    }

    function buildExpanded(groups) {
      lastMainGroups = groups;
      if (!modelGroupsInitialized) {
        for (const g of groups) {
          if (g.members.length > 1) collapsedModelGroups.add(g.key);
        }
        modelGroupsInitialized = true;
      }
      const expanded = [];
      for (const g of groups) {
        expanded.push({ type: 'group', key: g.key, label: g.label, canonicalId: g.canonicalId, members: g.members });
        if (g.members.length > 1 && !collapsedModelGroups.has(g.key)) {
          for (const m of g.members) expanded.push({ type: 'row', m });
        }
      }
      return expanded;
    }

    // `opts.onlyUsable` restricts the *measured* columns to providers the router would use
    // right now. The graveyard and every model heading opt out: TTFT, tok/s and context are
    // what the row was last seen doing, not a claim that it can serve this second. Filtering
    // them to usable rows left a heading reading "0/7 providers" with the speed and context it
    // had in fact measured wiped out, so a rate-limited or timed-out provider keeps lending
    // its own numbers to its model's heading. The rating is the capacity claim, and
    // groupRowInnerHTML mutes that separately when nothing is usable.
    function getGroupSummary(g, opts = {}) {
      const members = g.members;
      const usable = members.filter(isRowUsable);
      const measured = opts.onlyUsable === false ? members : usable;
      let bestQos = 0, bestIntell = 0;
      let minTtft = null, maxTps = null, bestCtx = null;
      let bestCtxMember = null;
      let bestIntellMember = members[0];
      let speedMember = null;
      const upCount = members.filter(isRowUp).length;
      for (const m of members) {
        // Intelligence rates the model, not a provider, so it is read from every row:
        // the heading still says what the model is even when none of its providers can
        // currently serve it.
        const i = Number(m.intell) || 0;
        if (i > bestIntell) { bestIntell = i; bestIntellMember = m; }
      }
      for (const m of measured) {
        const q = Number(m.qos) || 0;
        if (q > bestQos) bestQos = q;
        const memberTtft = rowTtft(m);
        const memberTps = rowTps(m);
        if (memberTtft != null && (minTtft === null || memberTtft < minTtft)) {
          minTtft = memberTtft;
          speedMember = m;
        }
        if (memberTps != null && (maxTps === null || memberTps > maxTps)) maxTps = memberTps;
        const ctx = m.contextTokens;
        if (ctx != null && (bestCtx === null || ctx > bestCtx)) { bestCtx = ctx; bestCtxMember = m; }
      }
      // The heading's speed tag reads the member its speed figures came from: the fastest
      // TTFT among the measured rows, so the tag and the tooltip describe the same endpoint.
      if (!speedMember) speedMember = measured.find((m) => rowTps(m) != null) || bestIntellMember;
      return { bestQos, bestIntell, minTtft, maxTps, bestCtx, upCount, usable, bestIntellMember, bestCtxMember, speedMember };
    }

    /** A stealth preview: relayed under a code name, with no lab to draw a mark for. */
    function isStealthModel(m) {
      return /^stealth\//i.test(String((m && m.modelId) || ''));
    }

    /**
     * One model's logo for the table: its own vendor mark — the same favicon the topology draws on
     * the model's node — over the model's initial, so the cell is identifiable while the image
     * loads and stays that way when no vendor domain resolves. The image removes itself on error,
     * which leaves the monogram standing rather than a broken-image glyph in the column. A stealth
     * preview has no vendor at all: its lab is anonymous until it reveals itself, so it gets a
     * crossed-out eye rather than a letter that would read as a brand, and the real mark replaces
     * it here on the day the lab is named.
     */
    function modelLogoHTML(m) {
      const name = String((m && m.label) || (m && m.modelId) || '');
      const domain = modelDomainFor(m);
      const href = domain ? faviconHrefs([domain])[0] : '';
      const title = escapeAttr(domain ? `${name} · ${domain}` : name);
      if (!href && isStealthModel(m)) {
        return `<span class="model-logo model-logo-stealth" title="${escapeAttr(`${name} — stealth preview, the lab is anonymous`)}">`
          + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><path d="M4 20 20 4"/></svg>'
          + '</span>';
      }
      const initial = (name.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
      return `<span class="model-logo" title="${title}">`
        + `<span class="model-logo-mono" aria-hidden="true">${escapeHtml(initial)}</span>`
        + (href
          ? `<img class="model-logo-img" src="${escapeAttr(href)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
          : '')
        + '</span>';
    }

    // ── The table's quota column ─────────────────────────────────────────────────
    //
    // A row is one provider/model endpoint, so its quota can arrive from three places: a
    // published limit, a provider usage report, or the last response's rate-limit headers.
    // They are merged by window so a model with day, week and month caps shows all three,
    // rather than whichever source happened to speak last. Published limits are drawn against
    // tokens hammer recorded itself; observed limits already carry the provider's remaining
    // count. A model-scoped published limit uses that row's tokens, while an account-scoped
    // one uses the provider total (the same denominator the provider card uses).
    const QUOTA_ROW_PERIOD_LABEL = {
      minute: 'MINUTE',
      hour: 'HOUR',
      day: 'DAY',
      week: 'WEEK',
      month: 'MONTH',
      lifetime: 'ONE-OFF',
      rolling: 'ROLLING',
      window: 'WINDOW',
    };
    const QUOTA_ROW_RECORDED_FIELD = {
      tokens: {
        minute: 'tokensLastMinute',
        hour: 'tokensLastHour',
        day: 'tokensToday',
        week: 'tokensThisWeek',
        month: 'tokensThisMonth',
        lifetime: 'tokensLifetime',
      },
      requests: {
        minute: 'requestsLastMinute',
        hour: 'requestsLastHour',
        day: 'requestsToday',
        week: 'requestsThisWeek',
        month: 'requestsThisMonth',
      },
    };
    const QUOTA_ROW_PERIOD_ORDER = { minute: 0, hour: 0.5, day: 1, week: 2, month: 3, lifetime: 4, rolling: 5, window: 6 };
    const QUOTA_ROW_METRIC_ORDER = { requests: 0, tokens: 1, credits: 2 };

    function quotaRowPeriod(value) {
      const text = String(value || '').toLowerCase();
      if (/\bminute\b|per\s*minute|\brpm\b/.test(text)) return 'minute';
      if (/\bday\b|daily|24\s*hour|rolling\s*24/.test(text)) return 'day';
      if (/\bhour\b|hourly|per\s*hour/.test(text)) return 'hour';
      if (/\bweek\b|weekly|7\s*day/.test(text)) return 'week';
      if (/\bmonth\b|monthly|30\s*day/.test(text)) return 'month';
      if (/lifetime|one[- ]?off|one[- ]?time|signup/.test(text)) return 'lifetime';
      if (/rolling/.test(text)) return 'rolling';
      return 'window';
    }

    function quotaRowPeriodLabel(period, rawWindow) {
      if (QUOTA_ROW_PERIOD_LABEL[period]) return QUOTA_ROW_PERIOD_LABEL[period];
      return rawWindow ? String(rawWindow).toUpperCase() : 'WINDOW';
    }

    // A cap a response states is not automatically a throttle. g4f answers with 500 requests and
    // 5M tokens that reopen the next day: an allowance, not a burst, and it belongs in Quota
    // rather than Rate limit. The reset clock the response carried is the only evidence of the
    // window, so the period is read off it — and a cap with no clock is capacity, because
    // nothing about it says it reopens within the hour.
    function quotaRowLimitPeriod(resetAt, now = Date.now()) {
      const at = Number(resetAt);
      if (!Number.isFinite(at) || at <= 0) return 'window';
      const left = at - now;
      if (left <= 5 * 60_000) return 'minute';
      if (left <= 6 * 3_600_000) return 'hour';
      if (left <= 36 * 3_600_000) return 'day';
      if (left <= 10.5 * 86_400_000) return 'week';
      return 'month';
    }

    function nextUtcWeekStart() {
      const date = new Date();
      const weekday = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 8 - weekday);
      date.setUTCHours(0, 0, 0, 0);
      return date.getTime();
    }

    function quotaRowResetAt(period) {
      if (period === 'day') return nextUtcMidnight();
      if (period === 'week') return nextUtcWeekStart();
      if (period === 'month') return quotaWindowReset('month');
      return null;
    }

    // A reset at or behind the clock has nothing to count down to: the caller drops the whole
    // sentence rather than printing "resets in now". Below a minute this counts seconds, which
    // used to round to a useless "resets in 0m".
    function formatQuotaReset(ms) {
      const raw = Number(ms);
      if (!Number.isFinite(raw) || raw <= 0) return '';
      const total = Math.max(1, Math.floor(raw / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m`;
      return `${total}s`;
    }

    function quotaRowPercentText(raw) {
      if (raw == null || !Number.isFinite(raw)) return 'not reported';
      if (raw > 0 && raw < 0.01) return '<0.01';
      if (raw < 10) return raw.toFixed(2);
      if (raw < 100) return raw.toFixed(1);
      return Math.round(raw).toLocaleString();
    }

    // Google publishes no fixed per-model free-tier table; the active limits live in AI
    // Studio for the project behind the key. A row with no observed QuotaFailure can still
    // answer the quota question by pointing at that live view instead of showing a bare dash.
    const GOOGLE_ACTIVE_QUOTA_URL = 'https://aistudio.google.com/rate-limit?timeRange=last-28-days';

    // A window's kind decides which column draws it. Throttle windows are the burst
    // counters (a minute or an hour of capacity, and any x-ratelimit-* counter whatever
    // period it reports); capacity windows are the allowances that spend down — days,
    // weeks, months, credits, and a published free-tier percentage.
    function quotaRowKindFor(period, source, metric) {
      if (source === 'key' || metric === 'credits') return 'quota';
      if (period === 'minute' || period === 'hour') return 'rate-limit';
      return 'quota';
    }

    function quotaRowWindow({ period, metric = 'tokens', rawWindow, used, total, remaining, resetAt, source, scope, detail, stale, unavailable, usedPercent, percentOnly, kind, estimated }) {
      // A credit balance is money, not capacity: OpenRouter's key endpoint counts dollars and
      // its allowance does not reset, so the metric has to survive as its own unit or the cell
      // would print "$4.20 tokens".
      const normalizedMetric = metric === 'requests' ? 'requests' : metric === 'credits' ? 'credits' : 'tokens';
      let totalValue = total == null ? null : Number(total);
      let remainingValue = remaining == null ? null : Number(remaining);
      let usedValue = used == null ? null : Number(used);
      let usedPercentValue = usedPercent == null ? null : Number(usedPercent);
      if (!Number.isFinite(totalValue) || totalValue < 0) totalValue = null;
      if (!Number.isFinite(remainingValue)) remainingValue = null;
      if (!Number.isFinite(usedValue)) usedValue = null;
      if (!Number.isFinite(usedPercentValue) || usedPercentValue < 0) usedPercentValue = null;
      if (usedPercentValue != null) usedPercentValue = Math.min(100, usedPercentValue);
      const isPercentOnly = Boolean(percentOnly) || (totalValue == null && usedPercentValue != null);
      const zeroLimit = totalValue === 0 || Boolean(unavailable);
      if (zeroLimit) {
        usedValue = 0;
        remainingValue = 0;
      }
      if (usedValue == null && totalValue != null && totalValue > 0 && remainingValue != null) usedValue = Math.max(0, totalValue - remainingValue);
      if (remainingValue == null && totalValue != null && totalValue > 0 && usedValue != null) remainingValue = Math.max(0, totalValue - usedValue);
      if (usedPercentValue == null && totalValue != null && totalValue > 0 && usedValue != null) usedPercentValue = Math.max(0, (usedValue / totalValue) * 100);
      // A measurement with no allowance behind it is not a window: there is nothing to
      // draw a percentage against, and the column says ∞ instead of hatching a bar nobody
      // can read. A zero limit is still a limit — the provider saying nothing is available.
      const hasAllowance = (totalValue != null && totalValue > 0) || usedPercentValue != null || unavailable === true;
      if (!hasAllowance) return null;
      const windowSource = source || 'observed';
      return {
        kind: kind || quotaRowKindFor(period, windowSource, normalizedMetric),
        period,
        metric: normalizedMetric,
        rawWindow,
        total: totalValue,
        remaining: remainingValue,
        used: usedValue,
        usedPercent: usedPercentValue,
        percentOnly: isPercentOnly,
        resetAt: Number.isFinite(Number(resetAt)) && Number(resetAt) > 0 ? Number(resetAt) : null,
        source: windowSource,
        scope: scope || null,
        detail: detail || '',
        stale: Boolean(stale),
        unavailable: zeroLimit,
        estimated: Boolean(estimated),
      };
    }

    function quotaRowViewsUncached(m) {
      const windows = [];
      const byWindow = new Map();
      const keyFor = (window) => `${window.metric}:${window.period}:${window.kind}`;
      const add = (window, replace = false) => {
        if (!window) return;
        // A positive window whose stated reset has already passed is history, not a quota the
        // row is currently under: the provider's own countdown says the counter rolled over, so
        // its remaining figure describes a window that no longer exists. Zero-limit windows have
        // no reset and stay: they are the provider saying the model has no free-tier allowance.
        if (window.total != null && window.total > 0
          && window.resetAt != null && window.resetAt <= Date.now()) return;
        const key = keyFor(window);
        const existing = byWindow.get(key);
        if (existing && !replace) return;
        if (existing) {
          const index = windows.indexOf(existing);
          if (index >= 0) windows.splice(index, 1);
        }
        byWindow.set(key, window);
        windows.push(window);
      };
      const known = m?.knownQuota;
      const knownLimits = Array.isArray(known?.limits) ? known.limits : [];
      const scope = known?.limitScope === 'model' ? 'model' : 'account';
      const recorded = scope === 'model'
        ? m?.recordedUsage
        : (m?.providerRecordedUsage || m?.recordedUsage);
      for (const limit of knownLimits) {
        const metric = limit?.metric === 'requests' ? 'requests' : limit?.metric === 'tokens' ? 'tokens' : null;
        if (!metric) continue;
        const total = Number(limit.limit);
        if (!Number.isFinite(total) || total < 0) continue;
        const period = quotaRowPeriod(limit.period);
        const field = QUOTA_ROW_RECORDED_FIELD[metric]?.[period];
        // A published limit draws only against a counter that exists for its window: the
        // trailing hour answers KiloCode's 200 requests/hour pool, and a period hammer does not
        // count keeps its number without a bar instead of vanishing from the column.
        const recordedValue = field ? Number(recorded?.[field]) : NaN;
        const used = field ? (Number.isFinite(recordedValue) ? recordedValue : 0) : null;
        add(quotaRowWindow({
          period,
          metric,
          rawWindow: limit.period,
          used,
          total,
          remaining: used == null ? null : Math.max(0, total - used),
          resetAt: quotaRowResetAt(period),
          source: 'published',
          scope,
          detail: limit.label || 'published limit',
        }));
      }
      const report = m?.providerUsage;
      const reportMetric = report?.metric === 'requests' ? 'requests' : report?.metric === 'tokens' ? 'tokens' : null;
      if (report && reportMetric) {
        add(quotaRowWindow({
          period: quotaRowPeriod(report.window),
          metric: reportMetric,
          rawWindow: report.window,
          used: report.used,
          total: report.limit,
          remaining: report.remaining,
          resetAt: report.resetAt,
          source: 'provider',
          scope: report.scope,
          detail: report.accountLabel || report.model || report.window || 'provider usage',
          stale: report.freshness === 'stale',
        }), true);
      }
      // Capacity (credit balance, free-tier percentage) lives on the quota half; throttle
      // counters (limitRequests/limitTokens) stay on rateLimit. Both feed the quota column,
      // which shows every window the provider named — the split is about ownership, not
      // about hiding either from the user.
      const rateLimit = m?.rateLimit;
      const quotaState = m?.quota;
      const creditSource = quotaState || rateLimit;
      if (creditSource) {
        // A key-level credit balance is the provider's own answer to "how much is left on this
        // account" — OpenRouter reports it from its key endpoint, and every model on the key
        // draws from the same pot. The provider card has always shown it; the model table did
        // not, so a row whose account was nearly spent read "—" while the card one click away
        // showed the balance. It is a one-off allowance rather than a resetting window, so it
        // is drawn against the lifetime counter that never rolls over.
        if (creditSource.creditLimit != null || creditSource.creditRemaining != null) {
          add(quotaRowWindow({
            period: 'lifetime',
            metric: 'credits',
            rawWindow: 'account credit',
            total: creditSource.creditLimit,
            remaining: creditSource.creditRemaining,
            used: creditSource.creditLimit != null && creditSource.creditRemaining != null
              ? Math.max(0, Number(creditSource.creditLimit) - Number(creditSource.creditRemaining))
              : null,
            resetAt: creditSource.creditResetAt,
            source: 'key',
            scope: 'account',
            detail: 'account credit reported by the provider key endpoint',
          }));
        }
        const retryReset = rateLimit?.capturedAt && rateLimit?.retryAfterMs
          ? Number(rateLimit.capturedAt) + Number(rateLimit.retryAfterMs)
          : null;
        // Token Harbor's free tier publishes a percentage of a rolling seven-day allowance,
        // not a token total. Keep it percent-only so the column says "62% used" rather than
        // inventing a denominator the vendor never published.
        if (creditSource.freeUsedPercent != null
          && (creditSource.freeResetAt == null || Number(creditSource.freeResetAt) > Date.now())) {
          add(quotaRowWindow({
            period: 'week',
            metric: 'tokens',
            rawWindow: 'rolling 7-day free allowance',
            usedPercent: creditSource.freeUsedPercent,
            resetAt: creditSource.freeResetAt,
            source: 'headers',
            scope: 'account',
            detail: 'Token Harbor free-tier allowance',
            percentOnly: true,
          }));
        }
      }
      if (rateLimit) {
        const retryReset = rateLimit.capturedAt && rateLimit.retryAfterMs
          ? Number(rateLimit.capturedAt) + Number(rateLimit.retryAfterMs)
          : null;
        if (rateLimit.limitTokens != null || rateLimit.remainingTokens != null) {
          add(quotaRowWindow({
            period: quotaRowLimitPeriod(rateLimit.resetTokensAt || retryReset),
            metric: 'tokens',
            rawWindow: 'last response',
            used: rateLimit.limitTokens != null && rateLimit.remainingTokens != null
              ? Math.max(0, Number(rateLimit.limitTokens) - Number(rateLimit.remainingTokens))
              : null,
            total: rateLimit.limitTokens,
            remaining: rateLimit.remainingTokens,
            resetAt: rateLimit.resetTokensAt || retryReset,
            source: 'headers',
            scope: 'account',
            detail: 'from the last response',
          }));
        }
        if (rateLimit.limitRequests != null || rateLimit.remainingRequests != null) {
          add(quotaRowWindow({
            period: quotaRowLimitPeriod(rateLimit.resetRequestsAt || retryReset),
            metric: 'requests',
            rawWindow: 'last response',
            used: rateLimit.limitRequests != null && rateLimit.remainingRequests != null
              ? Math.max(0, Number(rateLimit.limitRequests) - Number(rateLimit.remainingRequests))
              : null,
            total: rateLimit.limitRequests,
            remaining: rateLimit.remainingRequests,
            resetAt: rateLimit.resetRequestsAt || retryReset,
            source: 'headers',
            scope: 'account',
            detail: 'from the last response',
          }));
        }
      }
      for (const observed of Array.isArray(m?.quotaWindows) ? m.quotaWindows : []) {
        add(quotaRowWindow({
          kind: observed.kind,
          period: quotaRowPeriod(observed.period || observed.rawWindow),
          metric: observed.metric,
          rawWindow: observed.rawWindow,
          used: observed.used,
          total: observed.limit ?? observed.total,
          remaining: observed.remaining,
          resetAt: observed.resetAt,
          source: observed.source || 'quota-failure',
          scope: observed.scope,
          detail: observed.detail,
          stale: observed.stale,
          unavailable: observed.unavailable,
          usedPercent: observed.usedPercent,
          percentOnly: observed.percentOnly,
        }), true);
      }
      // No published cap and no observed window: estimate a ceiling from the traffic
      // Hammer itself has carried, so the column draws an active bar instead of claiming a
      // limit nobody stated or an ∞ nobody proved. The window is labelled EST.
      // A provider that states there is no limit is not estimated against: an inferred
      // ceiling would turn ∞ back into a number the provider explicitly disclaimed.
      const observedUsage = m?.knownQuota?.unlimited === true ? {} : (m?.recordedUsage || {});
      for (const metric of ['requests', 'tokens']) {
        for (const period of ['minute', 'hour', 'day']) {
          const field = QUOTA_ROW_RECORDED_FIELD[metric]?.[period];
          if (!field) continue;
          if (windows.some((window) => window.metric === metric && window.period === period)) continue;
          const seen = Number(observedUsage[field]);
          if (!Number.isFinite(seen) || seen <= 0) continue;
          const ceiling = estimateLimitCeiling(seen);
          add(quotaRowWindow({
            period,
            metric,
            rawWindow: `estimated ${period}`,
            used: seen,
            total: ceiling,
            remaining: Math.max(0, ceiling - seen),
            source: 'estimated',
            scope: 'account',
            detail: 'ceiling estimated from traffic Hammer has carried; no published limit',
            estimated: true,
          }));
        }
      }
      const sorted = windows.sort((a, b) =>
        (QUOTA_ROW_PERIOD_ORDER[a.period] ?? 9) - (QUOTA_ROW_PERIOD_ORDER[b.period] ?? 9)
        || (QUOTA_ROW_METRIC_ORDER[a.metric] ?? 9) - (QUOTA_ROW_METRIC_ORDER[b.metric] ?? 9));
      // A model outside the free tier reports requests/minute, requests/day, tokens/minute and
      // tokens/day as four zero allowances. Four identical "not available" rows say less than
      // one sentence, so collapse an all-zero row; when any real window exists, drop the zeros
      // and keep the numbers that can actually move.
      const available = sorted.filter((window) => !window.unavailable);
      if (available.length > 0) return available;
      if (sorted.length === 0) return [];
      const first = sorted[0];
      return [{
        period: 'window',
        metric: first.metric,
        rawWindow: 'free tier',
        total: 0,
        remaining: 0,
        used: 0,
        usedPercent: null,
        resetAt: null,
        source: first.source,
        scope: first.scope,
        detail: 'Requests and tokens are not included in the free tier.',
        stale: false,
        unavailable: true,
      }];
    }

    function quotaRowWindowHtml(w) {
      const noFreeTier = w.unavailable && !w.percentOnly && w.period === 'window';
      const periodLabel = noFreeTier ? 'FREE TIER' : quotaRowPeriodLabel(w.period, w.rawWindow);
      const unit = w.metric === 'requests' ? 'req' : w.metric === 'credits' ? 'credits' : 'tok';
      const remainingPercent = (w.unavailable && !w.percentOnly) || w.usedPercent == null ? null : 100 - Math.min(100, w.usedPercent);
      const totalText = noFreeTier
        ? 'not included'
        : w.percentOnly
          ? 'allowance not published'
          : w.total != null
            ? `${fmtCompactTokens(w.total)} ${unit} / ${periodLabel.toLowerCase()}`
            : 'limit not reported';
      const remainingText = noFreeTier
        ? ''
        : w.percentOnly
          ? (remainingPercent == null ? 'remaining not reported' : `${quotaRowPercentText(remainingPercent)}% left`)
          : w.unavailable
            ? 'no free-tier allowance'
            : w.remaining != null
              ? `${fmtCompactTokens(w.remaining)} left`
              : 'remaining not reported';
      const resetMs = w.resetAt == null ? null : w.resetAt - Date.now();
      const resetText = noFreeTier || resetMs == null || resetMs <= 0 ? '' : `resets in ${formatQuotaReset(resetMs)}`;
      const percentText = noFreeTier
        ? 'no allowance'
        : w.percentOnly && w.usedPercent != null
          ? `${quotaRowPercentText(w.usedPercent)}% used`
          : w.unavailable
            ? 'not available'
            : w.usedPercent == null ? 'usage not reported' : `${quotaRowPercentText(w.usedPercent)}% used`;
      // A zero allowance is fully spent, not unknown: a bar at 0% beside "not available"
      // reads as capacity nobody has touched, which is the opposite of what it says.
      const zeroAllowance = w.unavailable && !w.percentOnly;
      const barWidth = zeroAllowance ? 100 : w.usedPercent == null ? 0 : Math.min(100, w.usedPercent);
      const tone = zeroAllowance ? 'error' : remainingPercent == null ? 'unknown' : remainingPercent <= 10 ? 'error' : remainingPercent <= 30 ? 'warning' : 'success';
      const titleParts = noFreeTier
        ? ['No free-tier requests or tokens', w.detail, w.scope ? `${w.scope}-scoped` : '']
        : [
          w.percentOnly ? `${percentText} · allowance not published` : (w.unavailable ? `${totalText} · no free-tier allowance` : percentText),
          w.used != null && w.total != null && !w.unavailable ? `${w.used.toLocaleString()} of ${w.total.toLocaleString()} ${unit}` : '',
          w.remaining != null && !w.unavailable ? `${w.remaining.toLocaleString()} ${unit} remaining` : '',
          w.percentOnly && remainingPercent != null ? `${quotaRowPercentText(remainingPercent)}% remaining` : '',
          resetText,
          w.detail,
          w.scope ? `${w.scope}-scoped` : '',
          w.stale ? 'stale' : '',
        ].filter(Boolean);
      const meta = noFreeTier
        ? w.detail
        : [totalText, remainingText, resetText].filter(Boolean).join(' · ');
      return `<div class="quota-row-window${w.stale ? ' is-stale' : ''}${w.unavailable ? ' is-unavailable' : ''}${w.estimated ? ' is-estimated' : ''}" data-quota-period="${escapeAttr(w.period)}" data-quota-metric="${escapeAttr(w.metric || 'tokens')}" data-quota-unavailable="${w.unavailable ? 'true' : 'false'}" data-quota-used-percent="${w.usedPercent == null ? '' : w.usedPercent.toFixed(2)}" title="${escapeAttr(titleParts.join(' · '))}">
        <div class="quota-row-head"><span class="quota-row-pct">${escapeHtml(percentText)}</span></div>
        <div class="quota-row-track${(zeroAllowance || w.usedPercent != null) ? '' : ' quota-row-track-unknown'}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${zeroAllowance ? 100 : w.usedPercent == null ? '' : Math.round(Math.min(100, w.usedPercent))}" aria-label="${escapeAttr(noFreeTier ? 'Free-tier quota' : `${periodLabel} quota`)}" aria-valuetext="${escapeAttr(percentText)}"><div class="quota-row-fill quota-row-fill-${tone}" style="width:${barWidth.toFixed(2)}%"></div></div>
        <div class="quota-row-meta">${escapeHtml(meta)}</div>
      </div>`;
    }

    function quotaRowWindowsHtml(windows, opts = {}) {
      if (windows.length === 0) {
        return `<div class="quota-row-empty" title="${escapeAttr(opts.emptyTitle || 'No quota is reported for this endpoint yet.')}">—</div>`;
      }
      return `<div class="quota-row-windows">${windows.map(quotaRowWindowHtml).join('')}</div>`;
    }

    // ── Account bars ─────────────────────────────────────────────────────────
    //
    // A provider with several credentials spends a separate allowance on each of them. One bar
    // for the row is the pool's total drawn against one key's limit, so with two keys the bar
    // reads as spent while neither account is: 30 recorded requests against a published 20 look
    // like 150% of a key that has carried 15. Every surface that draws a limit bar therefore
    // asks for an account column per credential first, and a single-credential provider keeps
    // the row bar it always had (the API sends `credentials: null` in that case).
    //
    // What each column shows is that account's own evidence: the windows its responses reported
    // (`quota`, kept per credential by the pool), and the traffic it itself carried
    // (`usage`), drawn against the same published allowance the row carries — the allowance a
    // per-key plan grants every key. Nothing is divided by the pool size: sharing one key's
    // limit out across accounts would be arithmetic about a plan nobody published.
    function rowAccounts(m) {
      const accounts = Array.isArray(m?.credentials) ? m.credentials : [];
      if (accounts.length < 2) return null;
      return accounts.map((account, i) => ({
        index: Number.isInteger(account?.index) ? account.index : i,
        label: account?.label ? String(account.label) : `Account ${i + 1}`,
        serving: account?.serving === true,
        exhausted: account?.exhausted === true,
        resetsInMs: Number(account?.resetsInMs) > 0 ? Number(account.resetsInMs) : null,
        usage: account?.usage || {},
        // What this account carried across the provider: an account-scoped published limit is
        // spent by every model on that key, so its bar must not fill from one row's traffic.
        usageAcrossModels: account?.usageAcrossModels || account?.usage || {},
        rateLimit: account?.rateLimit || null,
        quota: account?.quota || null,
      }));
    }

    // The window behind one credential's reported quota. `quotaWindows` is the shape every
    // window renderer already reads, so the account bar goes through the same code path as a
    // row's published and refused windows.
    function accountWindows(account) {
      // What a credential reported is an *allowance*, so it is always a quota window. It used
      // to be stamped with the column's kind, which put the same report in the Rate limit
      // column as a throttle "resets in 3d" bar — a limit on what the account may spend
      // drawn as a limit on how fast it may ask.
      const kind = 'quota'
      const quota = account?.quota;
      if (!quota || typeof quota !== 'object') return [];
      const remaining = quota.remaining == null ? null : Number(quota.remaining);
      const limit = quota.limit == null ? null : Number(quota.limit);
      if (!Number.isFinite(remaining) && !Number.isFinite(limit)) return [];
      const percentOnly = quota.percentOnly === true;
      const resetAt = Number(quota.resetsInMs) > 0 ? Date.now() + Number(quota.resetsInMs) : null;
      return [{
        kind,
        period: 'window',
        metric: 'requests',
        rawWindow: 'last response',
        used:
          Number.isFinite(remaining) && Number.isFinite(limit)
            ? Math.max(0, limit - remaining)
            : null,
        limit: Number.isFinite(limit) ? limit : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt,
        source: 'headers',
        scope: 'account',
        detail: quota.modelId ? `reported for ${quota.modelId}` : 'from the last response',
        percentOnly,
        usedPercent:
          percentOnly && Number.isFinite(remaining) ? Math.max(0, 100 - remaining) : null,
      }];
    }

    /**
     * Whether a recorded-usage bag carries anything at all.
     *
     * The bags are counter objects — `requestsToday`, `tokensLastHour`, … — that the client
     * receives fully populated with zeros, so "this endpoint has never been measured" and "it
     * was measured and carried nothing" arrive in the same shape. Only the values separate
     * them, and a cell that guesses wrong says the opposite of what the row's own plot shows.
     */
    function usageHasSamples(usage) {
      if (!usage || typeof usage !== 'object') return false;
      return Object.values(usage).some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    }

    function accountBarHtml(account, windows, kind, meta) {
      const state = account.exhausted ? 'exhausted' : account.serving ? 'serving' : 'idle';
      const resetIn =
        account.exhausted && account.resetsInMs
          ? ` · resets in ${formatQuotaReset(account.resetsInMs)}`
          : '';
      const stateLabel = account.exhausted ? 'exhausted' : account.serving ? 'serving' : '';
      const title = `${account.label}${stateLabel ? ` · ${stateLabel}` : ''}${resetIn}`;
      const body = windows.length > 0
        ? `<div class="quota-row-windows">${windows.map(quotaRowWindowHtml).join('')}</div>`
        : quotaUnknownHtml(kind, { meta });
      return `<div class="quota-account-bar is-${state}" title="${escapeAttr(title)}">
        <div class="quota-account-head"><span class="quota-account-tag">A${account.index + 1}</span>${stateLabel ? `<span class="quota-account-state">${stateLabel}</span>` : ''}</div>
        ${body}
      </div>`;
    }

    // One column per credential, or null when this provider has a single one. The row's own
    // observed windows (published allowances, refusals, Google buckets) are endpoint-scoped
    // rather than key-scoped, so every account column reads them.
    function accountBarsHtml(m, kind) {
      const accounts = rowAccounts(m);
      if (!accounts) return null;
      const rowWindows = Array.isArray(m?.quotaWindows) ? m.quotaWindows : [];
      // The row's counter and the account's are two different measurements: the plot and the
      // row bar read the first, this column reads the second, and a provider whose traffic is
      // not attributed per key (Google's signed-in accounts are one) leaves the second empty
      // while the first is busy.
      const rowHasUsage =
        usageHasSamples(m?.recordedUsage) || usageHasSamples(m?.providerRecordedUsage);
      const columns = accounts.map((account) => {
        // Only the windows that describe *this* account. A provider that reports per key
        // stamps the key's index on the window it reported; an endpoint-scoped window — a
        // published refusal, a response header — carries none and belongs to every key.
        // Handing every column the whole list drew the other key's bar in this one, and in
        // the Google pools it drew the same bar twice, because both keys had reported one.
        const observed = rowWindows.filter(
          (window) =>
            (kind === 'rate-limit'
              ? window?.kind === 'rate-limit'
              : window?.kind !== 'rate-limit') &&
            (window?.accountIndex == null || Number(window.accountIndex) === account.index),
        );
        const windows = quotaRowViews({
          ...m,
          rateLimit: account.rateLimit,
          quota: account.quota,
          recordedUsage: account.usage,
          providerRecordedUsage: account.usageAcrossModels,
          providerUsage: null,
          providerUsages: [],
          quotaWindows: [...accountWindows(account), ...observed],
        }).filter((window) =>
          kind === 'rate-limit' ? window.kind === 'rate-limit' : window.kind !== 'rate-limit',
        );
        const accountHasUsage =
          usageHasSamples(account.usage) || usageHasSamples(account.usageAcrossModels);
        const meta =
          rowHasUsage && !accountHasUsage ? 'no per-account usage recorded' : undefined;
        return accountBarHtml(account, windows, kind, meta);
      });
      return `<div class="quota-row-accounts" data-quota-accounts="${columns.length}">${columns.join('')}</div>`;
    }

    // A provider whose quota cannot be measured from here still has something true to say: a
    // live view to open, or the plain fact that no usage API exists. A bare dash says neither,
    // and it is exactly what a row with no observed window used to show.
    const QUOTA_PROVIDER_NOTES = {
      googleai: {
        label: 'Google AI',
        href: GOOGLE_ACTIVE_QUOTA_URL,
        meta: 'Per-model limits',
        linkText: 'Open AI Studio',
        fallback:
          'Google publishes free-tier limits per model in AI Studio; this model is not in the current table.',
      },
      inferx: {
        label: 'InferX',
        href: 'https://inferx.net/models',
        meta: 'No usage API',
        linkText: 'Model list',
        fallback:
          'InferX publishes no usage endpoint; a spent tenant answers every id with 429 "tenant … quota exceeded".',
      },
      tokenharbor: {
        label: 'Token Harbor',
        href: 'https://tokenharbor.ai/pricing',
        meta: '7-day free allowance',
        linkText: 'Pricing',
        fallback:
          'Free-tier usage is a percentage of a rolling seven-day allowance; Hammer reads it with a one-token non-streamed check when it is unknown. No token total is published.',
      },
    };

    function quotaProviderNote(m) {
      const note = QUOTA_PROVIDER_NOTES[m?.providerKey];
      if (!note) return null;
      // Token Harbor's note describes the free allowance, so it must not appear on the
      // metered twin rows that bill the wallet instead.
      if (m?.providerKey === 'tokenharbor' && m?.paymentRequired) return null;
      // A numeric published limit is the answer already; the note would only repeat it.
      const known = m?.knownQuota;
      if (Array.isArray(known?.limits) && known.limits.length > 0) return null;
      return { ...note, source: known?.source || note.fallback };
    }

    function quotaProviderNoteHtml(note) {
      const href = safeExternalHref(note.href);
      const link = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(note.linkText || 'Open')}</a>`
        : '';
      return `<div class="quota-row-note" title="${escapeAttr(note.source)}">
        <span class="quota-row-note-label">${escapeHtml(note.label)}</span>
        <span class="quota-row-note-meta">${escapeHtml(note.meta || 'Project limits')}${link ? ` · ${link}` : ''}</span>
      </div>`;
    }

    function quotaRowCellInnerHTML(m, opts = {}) {
      // A pooled provider gets one column per credential before anything else is drawn.
      const accountBars = accountBarsHtml(m, 'quota');
      if (accountBars) return accountBars;
      // The Quota column carries capacity only. A throttle window belongs to the column
      // beside it, even when the provider published it as a nominal allowance.
      const windows = quotaRowViews(m).filter((window) => window.kind !== 'rate-limit');
      if (windows.length === 0) {
        if (m?.knownQuota?.unlimited === true) return quotaUnlimitedHtml('quota');
        // A row with traffic and no published limit is "limit not published" — not "no usage
        // recorded", which contradicted the usage plot in the same row.
        return quotaUnknownHtml('quota', {
          meta: usageHasSamples(m?.recordedUsage) || usageHasSamples(m?.providerRecordedUsage)
            ? 'usage recorded · no limit published'
            : undefined,
        });
      }
      return quotaRowWindowsHtml(windows, opts);
    }

    // A column never answers with a link or a dash. "∞" is the honest reading of "no limit
    // is published or has been observed": nothing can exhaust it, and the router treats the
    // endpoint as unlimited until a response says otherwise.
    // ∞ is reserved for a provider that states there is no limit at all. "We have not
    // observed one" is a different claim, and the cell says that instead of borrowing ∞.
    function quotaUnlimitedHtml(kind) {
      const throttle = kind === 'rate-limit';
      const label = throttle ? 'NO RATE LIMIT' : 'NO QUOTA LIMIT';
      const title = throttle
        ? 'The provider states there is no rate limit for this endpoint — nothing can exhaust it.'
        : 'The provider states there is no usage limit for this endpoint — nothing can exhaust it.';
      return `<div class="quota-row-window quota-row-infinity" data-quota-kind="${kind}" title="${escapeAttr(title)}">
        <div class="quota-row-head"><span class="quota-row-period">${label}</span><span class="quota-row-pct">∞</span></div>
        <div class="quota-row-meta">no usage limit published</div>
      </div>`;
    }

    function quotaUnknownHtml(kind, { meta } = {}) {
      // The last line describes the *counter this cell was given*, not the row's traffic. A
      // pooled provider draws one column per account, and an account whose own counter has no
      // samples says so rather than repeating "no usage recorded yet" beside a plot of the
      // row's traffic — which is what the two surfaces said together on the Google row.
      const line = meta || 'no usage recorded yet';
      return `<div class="quota-row-window quota-row-unknown-limit" data-quota-kind="${kind}" title="No limit is published or has been observed for this endpoint yet. The bar starts filling as Hammer records traffic; a ceiling is estimated once there is usage to learn from.">
        <div class="quota-row-head"><span class="quota-row-pct">limit not published</span></div>
        <div class="quota-row-track quota-row-track-unknown" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="" aria-valuetext="limit not published"><div class="quota-row-fill quota-row-fill-unknown" style="width:0%"></div></div>
        <div class="quota-row-meta">${line}</div>
      </div>`;
    }

    function groupsUnlimited(members) {
      return members.length > 0 && members.every((m) => m?.knownQuota?.unlimited === true);
    }

    // The estimated ceiling for an unmeasured window: the next round tier above the busiest
    // traffic Hammer has carried. It is a bound built from evidence, not a published number,
    // and every surface that draws it labels it EST.
    function estimateLimitCeiling(seen) {
      const target = Math.max(1, Number(seen) * 1.25);
      const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
      for (const step of [1, 2, 5, 10]) {
        const candidate = step * magnitude;
        if (candidate >= target) return Math.round(candidate);
      }
      return Math.round(10 * magnitude);
    }

    // ── Rate-limit cell ──────────────────────────────────────────────────────
    // The throttle half of a row's limit state, drawn with the same bars as the Quota
    // column: the per-window counters from x-ratelimit-* headers, any published minute/hour
    // allowance, and every window a refusal named, plus the bench flag. A row with no
    // throttle data says ∞ rather than a dash, because "no limit" is a fact about routing.
    function rateLimitCellInnerHTML(m) {
      const windows = quotaRowViews(m).filter((window) => window.kind === 'rate-limit');
      const rl = m?.rateLimit;
      const resets = windows
        .map((window) => Number(window.resetAt))
        .filter((at) => Number.isFinite(at) && at > 0);
      const resetAt = resets.length ? Math.max(...resets) : null;
      const resetIn = resetAt == null ? '' : formatQuotaReset(resetAt - Date.now());
      const bench = rl?.wasRateLimited === true
        ? `<div class="rl-cell-line rl-cell-bench">Bench active${resetIn ? ` · resets in ${resetIn}` : ''}</div>`
        : '';
      const accountBars = accountBarsHtml(m, 'rate-limit');
      if (accountBars) return `<div class="rl-cell">${bench}${accountBars}</div>`;
      if (windows.length === 0) {
        const empty = m?.knownQuota?.unlimited === true
          ? quotaUnlimitedHtml('rate-limit')
          : quotaUnknownHtml('rate-limit', {
              meta: usageHasSamples(m?.recordedUsage) || usageHasSamples(m?.providerRecordedUsage)
                ? 'usage recorded · no limit published'
                : undefined,
            });
        return `<div class="rl-cell">${bench}${empty}</div>`;
      }
      return `<div class="rl-cell">${bench}<div class="quota-row-windows">${windows.map((window) => quotaRowWindowHtml(window)).join('')}</div></div>`;
    }

    function rateLimitCell(m) {
      return `<td class="rate-limit-cell">${rateLimitCellInnerHTML(m)}</td>`;
    }

    function rateLimitGroupCell(g) {
      const members = g?.members || [];
      if (members.length === 0) {
        return `<td class="rate-limit-cell">${quotaUnknownHtml('rate-limit')}</td>`;
      }
      if (members.length === 1) return rateLimitCell(members[0]);
      // Throttle capacity is additive across providers the router can fan out to: two
      // endpoints that each allow 20 requests/minute give this model 40. A provider that
      // cannot route right now is not part of that sum. The same grossing rules apply as
      // Quota — identity, window shape and reset clocks decide what sums.
      const capacityMembers = groupCapacityMembers(members);
      const windows = groupLimitViews(capacityMembers, 'rate-limit');
      const benched = capacityMembers.some((m) => m?.rateLimit?.wasRateLimited === true);
      const nextReset = windows
        .map((window) => Number(window.resetAt))
        .filter((at) => Number.isFinite(at) && at > Date.now())
        .sort((a, b) => a - b)[0];
      const resetIn = nextReset == null ? '' : formatQuotaReset(nextReset - Date.now());
      const bench = benched
        ? `<div class="rl-cell-line rl-cell-bench">Bench active${resetIn ? ` · resets in ${resetIn}` : ''}</div>`
        : '';
      if (windows.length === 0) {
        const empty = groupsUnlimited(capacityMembers)
          ? quotaUnlimitedHtml('rate-limit')
          : quotaUnknownHtml('rate-limit');
        return `<td class="rate-limit-cell"><div class="rl-cell">${bench}${empty}</div></td>`;
      }
      return `<td class="rate-limit-cell"><div class="rl-cell">${bench}<div class="quota-row-windows">${windows
        .map((window) => quotaRowWindowHtml(window))
        .join('')}</div></div></td>`;
    }

    // The provider table asks the same question of a whole provider that the model table
    // asks of one row, so it answers with the same windows: the representative row's when
    // the provider has one, the catalog's published limits when it does not, and ∞ when
    // neither exists. A provider cell never renders a note or a link instead of a bar.
    // The provider table's own account view, for a provider whose representative model row is
    // not in the snapshot (disabled, or filtered out): the pool payload carries the same facts
    // the row would have, so the table still answers per account instead of falling back to
    // the provider total.
    function poolAccountRow(provider) {
      const pool = provider?.credentialPool;
      if (!pool || !Array.isArray(pool.accounts) || pool.accounts.length < 2) return null;
      return {
        knownQuota: provider.knownQuota,
        recordedUsage: provider.recordedUsage,
        providerRecordedUsage: provider.recordedUsage,
        credentials: pool.accounts.map((account) => ({
          index: account.index,
          label: account.label,
          serving: account.index === pool.servingIndex,
          exhausted: account.exhausted,
          resetsInMs: account.resetsInMs,
          usage: account.usage || {},
          usageAcrossModels: account.usage || {},
          rateLimit: account.rateLimit,
          quota: account.quota,
        })),
      };
    }

    function providerQuotaCellHtml(model, provider) {
      const accountBars = accountBarsHtml(model || poolAccountRow(provider), 'quota');
      if (accountBars) return accountBars;
      const source = model || {
        knownQuota: provider?.knownQuota,
        recordedUsage: provider?.recordedUsage,
        providerUsage: Array.isArray(provider?.quotaReports) && provider.quotaReports.length > 0
          ? provider.quotaReports[0]
          : null,
        quotaWindows: Array.isArray(provider?.observedQuota)
          ? provider.observedQuota.map((report) => ({
              metric: report?.unit === 'percent' ? 'tokens' : report?.metric,
              period: report?.window || 'day',
              rawWindow: report?.window,
              limit: report?.limit,
              remaining: report?.remaining,
              used: report?.used,
              resetAt: report?.resetAt,
              scope: 'account',
              source: 'provider',
              detail: report?.accountLabel || 'provider usage',
            }))
          : [],
      };
      const windows = quotaRowViews(source).filter((window) => window.kind !== 'rate-limit');
      if (windows.length === 0) {
        const unlimited = model?.knownQuota?.unlimited === true || provider?.knownQuota?.unlimited === true;
        return unlimited ? quotaUnlimitedHtml('quota') : quotaUnknownHtml('quota');
      }
      return `<div class="quota-row-windows">${windows.map((window) => quotaRowWindowHtml(window)).join('')}</div>`;
    }

    function providerRateLimitCellHtml(model, provider) {
      const accountBars = accountBarsHtml(model || poolAccountRow(provider), 'rate-limit');
      if (accountBars) return `<div class="rl-cell">${accountBars}</div>`;
      const windows = model
        ? quotaRowViews(model).filter((window) => window.kind === 'rate-limit')
        : [];
      const rl = model?.rateLimit;
      const resets = windows
        .map((window) => Number(window.resetAt))
        .filter((at) => Number.isFinite(at) && at > 0);
      const resetAt = resets.length ? Math.max(...resets) : null;
      const resetIn = resetAt == null ? '' : formatQuotaReset(resetAt - Date.now());
      const bench = rl?.wasRateLimited === true
        ? `<div class="rl-cell-line rl-cell-bench">Bench active${resetIn ? ` · resets in ${resetIn}` : ''}</div>`
        : '';
      if (windows.length === 0) {
        const empty = model?.knownQuota?.unlimited === true
          ? quotaUnlimitedHtml('rate-limit')
          : quotaUnknownHtml('rate-limit');
        return `${bench}${empty}`;
      }
      return `${bench}<div class="quota-row-windows">${windows.map((window) => quotaRowWindowHtml(window)).join('')}</div>`;
    }

    // Rows under a heading repeat a provider whenever it serves several ids in the same model
    // family (KiloCode lists a dozen), so the heading counts the providers those rows belong to
    // rather than the rows themselves.
    function quotaGroupProviderCount(members) {
      const keys = new Set();
      for (const member of members || []) keys.add(member?.providerKey || '');
      return keys.size;
    }

    // A heading is a claim about capacity the router can use now. A provider that is benched
    // or down cannot lend its windows to that claim: the model can still serve through a
    // usable sibling even while one provider's weekly window is at 100%. When nothing is
    // usable the whole group is shown, so the heading can still explain what is blocking it.
    function groupCapacityMembers(members) {
      const all = members || [];
      const usable = all.filter(isRowUsable);
      return usable.length > 0 ? usable : all;
    }

    // A 100% window is not group-wide exhaustion while another usable provider still has
    // room. The provider rows keep their own exhausted bars; a heading that has any remaining
    // capacity shows only the bars that can still move.
    function quotaWindowExhausted(window) {
      if (window?.unavailable === true) return true;
      if (window?.usedPercent != null) return Number(window.usedPercent) >= 100;
      if (window?.total != null && window?.remaining != null) {
        return Number(window.remaining) <= 0;
      }
      return false;
    }

    function quotaGroupCapacityWindows(windows) {
      const visible = (windows || []).filter((window) => !quotaWindowExhausted(window));
      return visible.length > 0 ? visible : (windows || []);
    }

    // A heading covers every provider under it, and its gross is only as honest as the
    // allowances it adds together. Two numbers belong in the same sum only when they share
    // a metric, a period, a window shape (fixed versus rolling) and an owner:
    //
    //   - an account-scoped limit is ONE allowance however many of the provider's models are
    //     listed (KiloCode's 200/hour pool is the same 200 on every row), and provider
    //     recorded usage is already that account's total, so it must not be counted twice;
    //   - a model-scoped limit is a separate allowance per model, so those do add up;
    //   - two provider instances with the same key are separate endpoints, not one account;
    //   - a rolling 24-hour window and a calendar day both normalise to `day`, but their
    //     counters cover different spans and reset on different clocks, so they stay apart;
    //   - a percentage has no denominator to add, and an estimated ceiling is not an
    //     allowance: those are reported as the tightest reading, clearly labelled.
    //
    // A sum of counters that reset at different moments is valid only until the first of
    // them rolls over, so the gross keeps the earliest reset and says the resets vary
    // instead of implying a single clock they all share.
    const groupTightness = (view) => {
      if (view.usedPercent != null) return Number(view.usedPercent);
      if (view.total != null && Number(view.total) > 0 && view.remaining != null) {
        return 100 - (Number(view.remaining) / Number(view.total)) * 100;
      }
      return -1;
    };

    function groupLimitViews(members, kind) {
      const allowances = new Map();
      const instanceOf = (member) => {
        if (typeof providerInstanceKey === 'function') {
          return providerInstanceKey(member) || member?.providerKey || '';
        }
        return member?.providerKey || '';
      };
      for (const member of members || []) {
        const providerKey = instanceOf(member);
        for (const view of quotaRowViews(member)) {
          if (view.kind !== kind) continue;
          // Anything not explicitly per model belongs to the provider's account: an observed
          // or header window that names no scope is the endpoint's view of a shared limit,
          // and deduplicating it is the safer reading than promising an allowance twice over.
          const perModel = view.scope === 'model';
          const identity = perModel
            ? `model:${providerKey}:${member?.modelId || ''}`
            : `account:${providerKey}`;
          const rolling =
            view.period === 'rolling' || /rolling/i.test(String(view.rawWindow || ''));
          const key = `${view.metric}:${view.period}:${rolling ? 'rolling' : 'fixed'}:${identity}`;
          const known = allowances.get(key);
          if (!known) {
            allowances.set(key, { view, rows: 1, rolling });
            continue;
          }
          known.rows += 1;
          // The same allowance can be seen on two rows — a provider alias, or a model row
          // repeating its account's pool. Keep the tighter reading, and let an authoritative
          // number win over an estimate regardless of which is further along.
          const knownAuthoritative = known.view.estimated !== true;
          const viewAuthoritative = view.estimated !== true;
          if (
            (viewAuthoritative && !knownAuthoritative) ||
            (viewAuthoritative === knownAuthoritative &&
              groupTightness(view) > groupTightness(known.view))
          ) {
            known.view = view;
          }
        }
      }

      const grouped = new Map();
      for (const { view, rows, rolling } of allowances.values()) {
        // One series per metric, period and window shape. Whether a reading is published
        // or estimated decides how it is combined below, not whether it gets a second bar.
        const key = `${view.metric}:${view.period}:${rolling ? 'rolling' : 'fixed'}`;
        const current = grouped.get(key) || { views: [], rows: 0, resets: [], rolling };
        current.views.push(view);
        current.rows += rows;
        if (Number.isFinite(Number(view.resetAt)) && Number(view.resetAt) > 0) {
          current.resets.push(Number(view.resetAt));
        }
        grouped.set(key, current);
      }

      const providers = quotaGroupProviderCount(members);
      const providerWord = (count) => `${count} provider${count === 1 ? '' : 's'}`;
      const sum = (values) => values.reduce((total, value) => total + Number(value), 0);
      const everyView = (views, field) => views.every((view) => view[field] != null);
      const distinctResets = (resets) => {
        const sorted = [...resets].sort((a, b) => a - b);
        return sorted.filter((at, index) => index === 0 || at - sorted[index - 1] > 60_000);
      };

      return [...grouped.values()]
        .map(({ views, rows, resets, rolling }) => {
          const allEstimated = views.every((view) => view.estimated === true);
          const authoritative = views.every((view) => view.estimated !== true);
          const tightestView = views.reduce(
            (best, view) => (groupTightness(view) > groupTightness(best) ? view : best),
            views[0],
          );
          // A sum is only reported when every contributor is an authoritative allowance
          // and has the number. An estimate is not an allowance: mixing it into a sum
          // understates the provider it came from, so the group reports that provider's
          // tightest reading instead of a second bar for the same metric and period.
          const first = authoritative ? views[0] : tightestView;
          const total = authoritative
            ? everyView(views, 'total')
              ? sum(views.map((view) => view.total))
              : null
            : first.total;
          const used = authoritative
            ? everyView(views, 'used')
              ? sum(views.map((view) => view.used))
              : null
            : first.used;
          const remaining = authoritative
            ? everyView(views, 'remaining')
              ? sum(views.map((view) => view.remaining))
              : null
            : first.remaining;
          const fractions = views.map(groupTightness).filter((value) => value >= 0);
          const tightest = fractions.length ? Math.max(...fractions) : null;
          // When the gross can compute its own fraction, that fraction is the truth the
          // displayed total/used/left add up to. A component's percentage describes that
          // component's pool, not the sum, so it may only stand in when no summed fraction
          // exists (a percent-only family). Showing the max beside summed counters was
          // self-contradictory: 28% next to 14 of 250 used.
          let usedPercent;
          if (authoritative) {
            usedPercent =
              total != null && total > 0 && used != null
                ? Math.max(0, (used / total) * 100)
                : tightest;
          } else {
            usedPercent = groupTightness(first) >= 0 ? groupTightness(first) : first.usedPercent;
          }
          const percentOnly = authoritative
            ? views.every((view) => view.percentOnly === true)
            : first.percentOnly === true;
          const estimated = first.estimated === true;
          const mixed = !authoritative;
          const distinct = distinctResets(resets);
          const resetsVary = distinct.length > 1;
          const unavailable = authoritative
            ? views.every((view) => view.unavailable === true)
            : first.unavailable === true;
          const share = rows > views.length ? ` shared by ${rows} rows` : '';
          const estimateBasis = allEstimated
            ? `estimated across ${views.length} ${views.length === 1 ? 'allowance' : 'allowances'}`
            : `tightest across ${views.length} ${views.length === 1 ? 'reading' : 'readings'}`;
          return {
            ...first,
            total,
            used,
            remaining,
            usedPercent: usedPercent == null || !Number.isFinite(usedPercent) ? null : usedPercent,
            percentOnly,
            estimated,
            mixed,
            resetAt: distinct.length ? Math.min(...distinct) : null,
            resetsVary,
            stale: views.some((view) => view.stale === true),
            unavailable,
            contributors: views.length,
            rows,
            rolling,
            scope: null,
            source: 'group',
            detail:
              unavailable && (total == null || total === 0)
                ? `no free-tier allowance across ${providerWord(providers)}`
                : mixed
                  ? estimateBasis +
                    share +
                    ` · ${providerWord(providers)} in this heading`
                  : percentOnly
                    ? `highest use across ${views.length} ${views.length === 1 ? 'allowance' : 'allowances'}` +
                      share +
                      ` · ${providerWord(providers)} in this heading`
                    : `gross across ${views.length} ${views.length === 1 ? 'allowance' : 'allowances'}` +
                      share +
                      ` · ${providerWord(providers)} in this heading` +
                      (resetsVary ? ' · resets vary' : ''),
          };
        })
        .sort(
          (a, b) =>
            (QUOTA_ROW_PERIOD_ORDER[a.period] ?? 9) - (QUOTA_ROW_PERIOD_ORDER[b.period] ?? 9) ||
            (a.rolling === true ? 1 : 0) - (b.rolling === true ? 1 : 0) ||
            (QUOTA_ROW_METRIC_ORDER[a.metric] ?? 9) - (QUOTA_ROW_METRIC_ORDER[b.metric] ?? 9),
        );
    }

    function quotaGroupViews(members) {
      return groupLimitViews(members, 'quota');
    }

    // Both limit cells, every group heading and every provider card read the same row's
    // windows, so the merge runs once per row object instead of once per column per render.
    // A fresh snapshot brings fresh row objects, so the cache cannot go stale.
    const quotaRowViewsCache = new WeakMap();
    function quotaRowViews(m) {
      if (m && typeof m === 'object') {
        const cached = quotaRowViewsCache.get(m);
        if (cached) return cached;
      }
      const views = quotaRowViewsUncached(m);
      if (m && typeof m === 'object') quotaRowViewsCache.set(m, views);
      return views;
    }

    function quotaRowCell(m) {
      return `<td class="quota-cell">${quotaRowCellInnerHTML(m)}</td>`;
    }

    function quotaGroupCell(g) {
      const members = g?.members || [];
      if (members.length === 0) return `<td class="quota-cell">${quotaUnknownHtml('quota')}</td>`;
      if (members.length === 1) {
        return `<td class="quota-cell">${quotaRowCellInnerHTML(members[0])}</td>`;
      }
      const capacityMembers = groupCapacityMembers(members);
      // An exhausted window on a provider that cannot route is not the group's verdict while
      // a usable sibling still has allowance. Keep it on the provider row, not the heading.
      const windows = quotaGroupCapacityWindows(quotaGroupViews(capacityMembers));
      if (windows.length === 0) {
        const empty = groupsUnlimited(capacityMembers) ? quotaUnlimitedHtml('quota') : quotaUnknownHtml('quota');
        return `<td class="quota-cell">${empty}</td>`;
      }
      return `<td class="quota-cell">${quotaRowWindowsHtml(windows, {
        emptyTitle: 'No quota is reported for these providers yet.',
      })}</td>`;
    }

    function groupRowInnerHTML(g) {
      const members = g.members;
      const s = getGroupSummary(g, { onlyUsable: false });
      const first = members[0];
      const isPinned = isFamilyPinnedGroup(members);
      // The heading answers one question — can this model be used at all? — in the same
      // verdict vocabulary as the provider rows underneath it: green as soon as any
      // provider can serve, and otherwise the most recoverable reason among them, so a
      // model whose providers are all waiting on a quota reads as the clock its own rows
      // show rather than as a red 'broken' dot. How many are up stays in the subtitle
      // under the model name, next to the other provider count.
      const groupKind = members.length === 1 ? rowVerdict(first) : bestGroupVerdict(members);
      const groupStatusText = members.length === 1
        ? plainStatusTitle(groupKind)
        : (groupKind === 'up'
          ? (s.upCount === members.length ? 'All providers up' : `${s.upCount}/${members.length} providers up`)
          : `Nothing can serve right now — ${verdictLabel(groupKind).toLowerCase()} (${s.upCount}/${members.length} up)`);
      // Multi-provider groups show only the indicator here: the up/total count sits under
      // the model name, so the two numbers read together instead of competing with it.
      // A provider outage is a provider-level fact, so the heading carries it as well: the rows
      // under it keep their own verdicts, and this is where a user sees that the router is
      // deliberately looking elsewhere. A single-provider heading gets it through
      // statusCellHTML(), which reads the same fields.
      const groupOutageTitle = members
        .map(member => providerOutageTitle(member))
        .filter(Boolean)
        .join(' \u00b7 ');
      const groupStatusHtml = members.length === 1
        ? statusCellHTML(first)
        : `<div style="display: flex; align-items: center; gap: 6px;">${verdictIndicatorHTML(groupKind, groupOutageTitle ? `${groupStatusText} \u00b7 ${groupOutageTitle}` : groupStatusText)}</div>`;
      const emoji = first.status === 'banned' ? '🚫 ' : (first.status === 'excluded' ? '⛔ ' : '');

      return `
          <td class="model-logo-cell">${modelLogoHTML(first)}</td>
          <td>
            <div style="font-weight: 700; font-size: 0.92rem; display:flex; align-items:center; gap:8px;">
              <span title="${escapeHtml(cleanHeadingModelName(g.label))}">${emoji}${escapeHtml(cleanHeadingModelName(g.label))}</span>
              <span class="status-slot">${groupStatusHtml}</span>
              ${members.length > 1 ? `<button type="button" onclick="event.stopPropagation(); toggleModelGroup('${escapeAttr(g.key)}')" title="${collapsedModelGroups.has(g.key) ? 'Expand' : 'Collapse'} providers" style="border:0; background:transparent; color:var(--text-muted); cursor:pointer; padding:0 3px; font-size:0.85rem;">${collapsedModelGroups.has(g.key) ? '▶' : '▼'}</button>` : ''}
              <button type="button" class="pin-row-btn ${isPinned ? 'pinned' : ''}" data-pin-model="${escapeAttr(first.modelId)}" data-pin-group="${escapeAttr(g.key)}" title="${isPinned ? 'Unpin model family' : 'Pin model family'}">📌</button>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${members.length === 1 ? escapeHtml(providerInstanceName(first)) : `${s.upCount}/${members.length} providers`}</div>
          </td>
          <td><div style="font-weight: 600; display:flex; align-items:center; gap:6px;">${(() => {
            const rating = getBenchmarkTableDisplayValue(s.bestIntellMember.intell, s.bestIntellMember.qualitySource, s.bestIntellMember.qualityDetail, s.bestIntellMember.aa, s.bestIntellMember.intelBand);
            // The rating describes the model rather than any one provider, so it stays
            // readable when nothing is available — but beside a "0/N providers" subtitle
            // it must not read as live capacity, so it is muted and labelled for what it
            // is. Every measured cell next to it is blank by then (see getGroupSummary).
            const ratingHtml = s.usable.length === 0
              ? `<span style="opacity:0.55;" title="No provider available — this is the model's rating, not a live measurement">${rating}</span>`
              : rating;
            // The superlative takes the rating's place rather than stacking beside it: one pill
            // per model. It crowns the smartest model that could take a request right now, out
            // of the same usable set the router chooses from, and carries the band and index it
            // displaced in its own tooltip so nothing is lost by dropping the tag.
            if (g.key === smartestGroupKey) {
              return `<span class="onboard-pill speed-tag smartest" title="${escapeAttr(`Smartest of the models that can serve right now${intelBandTitleSuffix(s.bestIntellMember)}`)}">Smartest</span>`;
            }
            return ratingHtml;
          })()}</div></td>
          ${speedTagCell(s.speedMember?.verdict, s.minTtft, s.maxTps, s.speedMember ? rowTtftLabel(s.speedMember) : 'ttft', s.speedMember != null && getModelRowKey(s.speedMember) === fastestRowKey, s.usable.length > 0)}
          <!-- Combined usage of every provider under this heading. The heading row is the
               one row that stays on screen when a group is collapsed, so it is where the
               sparkline is worth putting. Drawn after attach by drawGroupUsageSparkline(),
               since the id does not resolve until then. -->
          <td id="usage-cell-g:${escapeAttr(g.key)}" class="usage-sparkline-cell"></td>
          ${quotaGroupCell(g)}
          ${rateLimitGroupCell(g)}
          <td>
            <div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${s.bestCtxMember && s.bestCtxMember.contextSource === 'observed' ? 'Bounds inferred from real requests' : (s.bestCtxMember && s.bestCtxMember.context ? 'Known context window' : 'Largest context window among providers')}">${s.bestCtxMember && s.bestCtxMember.context ? escapeHtml(s.bestCtxMember.context) : '<span style="font-size:0.75rem;color:var(--text-muted);">—</span>'}</div>
          </td>
          <td>${(() => {
            // Group response: the most recent test across every provider under this
            // heading, judged against the row it came from (see groupLastResponse)
            const lastR = groupLastResponse(g.members);
            const hasAuth = g.members.some(m => m.status !== 'noauth');
            const expired = lastR && lastR.expiresAt != null && Date.now() > Number(lastR.expiresAt);
            // responseCellHTML() treats an expired timeout as absent by itself, so it is
            // given the response whenever one is worth showing and null otherwise — either
            // way it renders the Test button (or the no-auth placeholder). Returning a bare
            // empty cell for the other cases left a heading row — and with it the only row
            // of a single-provider model — with no way to test or re-test it at all.
            const showable = hasAuth && lastR && !expired && (lastR.text != null || lastR.error != null)
              ? lastR
              : null;
            return responseCellHTML(showable, { rowKey: 'g:' + g.key, members: g.members, hasAuth, owner: lastR && lastR._owner ? lastR._owner : null });
          })()}</td>
        `;
    }

    // A multi-provider heading expands or collapses its provider rows. A single-provider
    // heading has nothing to expand, so it takes no click. Pin, chevron and Test buttons
    // stop propagation, so they keep their own jobs.
    function applyGroupRowClick(row, g) {
      if (g.members.length > 1) {
        row.onclick = () => toggleModelGroup(g.key);
      } else {
        // Single-provider heading: nothing to expand, so no click affordance.
        row.style.cursor = 'default';
      }
    }

    // The currently routed model (pin > slope-line pick > intelligence). One
    // predicate drives every highlight in the main table so the group header
    // and the provider sub-row it contains always agree on which one is lit.
    function isCurrentBestRow(m) {
      // Multiple conversations means multiple live models: a row is lit when any conversation's
      // slope picked it, as well as when it is the exported `best` the KPI names.
      if (activePickRows.some((pick) => pick.modelId === m.modelId
        && (!pick.providerKey || pick.providerKey === m.providerKey))) return true;
      return !!currentBestModelId && m.modelId === currentBestModelId
        && (!currentBestProviderKey || m.providerKey === currentBestProviderKey);
    }
    function isCurrentBestGroup(g) {
      return !!currentBestModelId && g.members.some(isCurrentBestRow);
    }

    function createGroupRow(g) {
      const tr = document.createElement('tr');
      tr.className = 'model-group-row';
      tr.dataset.rowType = 'group';
      tr.dataset.rowKey = 'g:' + g.key;
      tr.classList.toggle('row-best', isCurrentBestGroup(g));
      tr.classList.toggle('row-not-up', bestGroupVerdict(g.members) !== 'up');
      tr.innerHTML = groupRowInnerHTML(g);
      applyGroupRowClick(tr, g);
      const pinButton = tr.querySelector('.pin-row-btn');
      const pinned = isFamilyPinnedGroup(g.members);
      bindPinButton(pinButton, { modelId: g.members[0]?.modelId, groupKey: g.key, pinned });
      // Aggregated sparkline. Drawn even though the row is not attached yet — the
      // container is passed by element here (the id inside groupRowInnerHTML cannot
      // resolve until the row is in the document), which is the same reason createRow
      // hands its usage cell straight to the plotter.
      drawGroupUsageSparklineInto(tr.querySelector('.usage-sparkline-cell'), g.members);
      return tr;
    }

    function updateGroupRow(row, g) {
      row.innerHTML = groupRowInnerHTML(g);
      row.classList.toggle('row-best', isCurrentBestGroup(g));
      row.classList.toggle('row-not-up', bestGroupVerdict(g.members) !== 'up');
      // Rebind so the handler closes over the freshly rendered member data.
      applyGroupRowClick(row, g);
      const pinButton = row.querySelector('.pin-row-btn');
      const pinned = isFamilyPinnedGroup(g.members);
      bindPinButton(pinButton, { modelId: g.members[0]?.modelId, groupKey: g.key, pinned });
      drawGroupUsageSparklineInto(row.querySelector('.usage-sparkline-cell'), g.members);
    }

    // `precomputedGroups` is the caller's { mainGroups, graveyardGroups } for the unfiltered
    // snapshot (see loadModelSnapshot). Reusing it is what keeps one grouping pass per snapshot
    // instead of one for the table and another for the readouts. It is ignored while a search is
    // active, where the table legitimately shows a subset the readouts must not describe.
    function render(isUserAction = false, precomputedGroups = null) {
      // While hovering, keep values live but lock row order so rows never
      // reorder or rebuild under the user's cursor.
      const hoverLocked = !isUserAction && isTableHovered;
      const tbody = document.getElementById('table-body');

      // 1. Apply Search
      const filtered = allModels.filter(m =>
        m.label.toLowerCase().includes(searchTerm) ||
        m.providerKey.toLowerCase().includes(searchTerm) ||
        (m.originLabel || '').toLowerCase().includes(searchTerm) ||
        m.modelId.toLowerCase().includes(searchTerm) ||
        (m.realModelId || '').toLowerCase().includes(searchTerm)
      );

      // Models without credentials remain in the unavailable table so their
      // No Auth status is visible instead of silently disappearing.

      let expanded;

      // Live sort is always on: re-sort on every render. While hovering we lock
      // the order (values still refresh in place).
      //
      // The strike-through split is *membership*, not order: a row the verdict says is
      // paid, dead, incompatible or missing auth must leave the main table the moment a
      // test says so, even when that render is triggered while the cursor still rests on
      // the table (the Test button lives inside it). The hover lock below therefore locks
      // only the order of the rows that remain — it used to hold struck rows in place too,
      // and because the old branch read `allGroups` from the other side of the `if` it
      // threw before it could even do that, so a clicked row never moved at all.
      const { mainGroups, graveyardGroups } = (precomputedGroups && !searchTerm)
        ? precomputedGroups
        : splitDisplayGroups(sortedGroups(groupModels(filtered)));

      if (!hoverLocked) {
        expanded = buildExpanded(mainGroups);
      } else {
        // Hover-locked: build the same rows, then keep the last rendered order for the
        // ones already on screen. Rows that only became visible now (a provider that just
        // turned usable) sort to the end rather than jumping the queue under the cursor.
        const orderIndex = new Map(currentRenderedOrder.map((key, i) => [key, i]));
        const orderOf = e => {
          const key = e.type === 'group' ? 'g:' + e.key : getModelRowKey(e.m);
          return orderIndex.has(key) ? orderIndex.get(key) : Infinity;
        };
        expanded = buildExpanded(mainGroups).slice().sort((a, b) => {
          const ai = orderOf(a);
          const bi = orderOf(b);
          if (ai === bi) return 0;
          return ai < bi ? -1 : 1;
        });
      }

      const newOrderKeys = expanded.map(e => e.type === 'group' ? 'g:' + e.key : getModelRowKey(e.m));
      const currentRows = Array.from(tbody.rows);

      // Fast path: same keys in the same order → update cells in place with no DOM churn.
      if (currentRows.length === expanded.length &&
          currentRows.every((row, i) => row.dataset.rowKey === newOrderKeys[i])) {
        for (let i = 0; i < expanded.length; i++) {
          const e = expanded[i];
          const rk = e.type === 'group' ? 'g:' + e.key : getModelRowKey(e.m);
          if (inflightTests.has(rk)) continue; // don't clobber a Test in progress
          if (e.type === 'group') updateGroupRow(currentRows[i], e);
          else updateRowCells(currentRows[i], e.m);
        }
        currentRenderedOrder = newOrderKeys;
        renderGraveyard(graveyardGroups);
        return;
      }

      // Order or length changed: reconcile keyed, reusing surviving row elements so
      // ping animations, hover state and scroll position are preserved.
      reconcileTable(tbody, expanded, newOrderKeys);
      currentRenderedOrder = newOrderKeys;
      renderGraveyard(graveyardGroups);
    }

    // Keyed reconciliation: match existing rows by data-row-key, reuse them in place
    // (updating their cells), create rows for new keys, move only the rows whose
    // position actually changed, and drop rows that no longer exist. Unmoved rows
    // are never detached, so their live values keep updating uninterrupted.
    function reconcileTable(tbody, expanded, newOrderKeys) {
      const existing = new Map();
      for (const row of Array.from(tbody.rows)) existing.set(row.dataset.rowKey, row);

      const removed = new Set(existing.keys());
      let anchor = null; // last row placed in the target order
      for (let i = 0; i < expanded.length; i++) {
        const e = expanded[i];
        const key = newOrderKeys[i];
        let row = existing.get(key);
        if (row) {
          if (!inflightTests.has(key)) {
            if (e.type === 'group') updateGroupRow(row, e);
            else updateRowCells(row, e.m);
          }
          removed.delete(key);
        } else {
          row = e.type === 'group' ? createGroupRow(e) : createRow(e.m);
        }
        if (anchor === null) {
          if (tbody.firstChild !== row) tbody.insertBefore(row, tbody.firstChild);
        } else if (anchor.nextSibling !== row) {
          tbody.insertBefore(row, anchor.nextSibling);
        }
        anchor = row;
      }
      for (const key of removed) {
        const row = existing.get(key);
        if (row && row.parentNode === tbody) row.remove();
      }
    }

    function updateRowCells(row, m) {
      // Mark the currently routed model (pin > slope-line pick > intelligence) so the
      // table always shows the same model the KPI, topology and scatter plot do.
      row.classList.toggle('row-best', isCurrentBestRow(m));

      // Paid / dead rows stay struck through even as other values refresh
      row.classList.toggle('row-struck', isRowStruck(m));
      // Dimming follows the verdict, not the sort: a row goes grey the moment its own status
      // stops reading Up, and comes back the moment a test or live traffic says it is serving.
      row.classList.toggle('row-not-up', !isRowUp(m));

      // Update provider name + pin button (ban status can change)
      const modelCell = row.cells[1];
      const isBannedRow = m.status === 'banned';
      const isExcludedRow = m.status === 'excluded';
      row.style.opacity = isExcludedRow || isBannedRow ? '0.5' : '1';
      const nameSpan = modelCell.querySelector('span');
      if (nameSpan) {
        const rowLabel = providerRowLabel(m);
        nameSpan.textContent = rowLabel;
        nameSpan.title = rowLabel;
      }
      const pinBtn = modelCell.querySelector('.pin-row-btn');
      if (pinBtn) {
        const isPinnedRow = isExactPinnedRow(m);
        pinBtn.className = 'pin-row-btn' + (isPinnedRow ? ' pinned' : '');
        pinBtn.title = isPinnedRow ? 'Unpin exact provider row' : 'Pin exact provider row';
        bindPinButton(pinBtn, { modelId: m.modelId, providerKey: m.providerKey, pinned: isPinnedRow });
      }
      // Refresh the provider subtext: discovery can learn a real model id later,
      // and the subtext is what distinguishes repeated rows of one provider.
      const subtextEl = modelCell.querySelector('.provider-subtext');
      if (subtextEl) {
        const realId = m.realModelId && m.realModelId !== m.modelId ? m.realModelId : '';
        subtextEl.innerHTML = escapeHtml(m.modelId) + (realId ? ` <span style="opacity:0.7;">&#8594; ${escapeHtml(realId)}</span>` : '');
        subtextEl.title = realId ? `${m.modelId} &#8594; ${realId}` : m.modelId;
      }
      // Update context window (known limit or observed bounds) — col 7, after quota (col 5) and
      // the rate-limit column (col 6); the logo column leads the row.
      const ctxCell = row.cells[7];
      ctxCell.innerHTML = m.context
        ? `<div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${m.contextSource === 'observed' ? 'Bounds inferred from real requests' : 'Known context window'}">${escapeHtml(m.context)}</div>`
        : '<div style="font-weight: 600; font-variant-numeric: tabular-nums;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div>';

      // Intelligence lives only in the model header row — it's identical across a
      // model's providers, so provider rows show a placeholder instead.
      const intellCell = row.cells[2];
      intellCell.innerHTML = `<div style="font-weight: 600;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div>`;

      // Usage sparkline (col 4); never clobber an in-flight test.
      const usageCell = row.cells[4];
      if (usageCell) {
        usageCell.className = 'usage-sparkline-cell';
        usageCell.id = `usage-cell-${getModelRowKey(m)}`;
        drawUsageSparklineInto(usageCell, getModelRowKey(m));
      }
      // Quota (col 5) is rebuilt on every refresh: a published window counts down on the
      // clock, and observed rate-limit windows arrive with new traffic.
      const quotaCell = row.cells[5];
      if (quotaCell) quotaCell.innerHTML = quotaRowCellInnerHTML(m);
      // Rate limit (col 6) is rebuilt alongside it: the throttle counters and bench state
      // change with every response, just as the quota windows do.
      const rateLimitCellEl = row.cells[6];
      if (rateLimitCellEl) rateLimitCellEl.innerHTML = rateLimitCellInnerHTML(m);
      // Update the status that trails the model name (it lives in the Model cell, col 1, now
      // that the Status column is gone) and the response cell (col 8, which moved up one);
      // never clobber an in-flight test.
      const statusCell = modelCell.querySelector('.status-slot');
      if (statusCell && !inflightTests.has(getModelRowKey(m))) {
        statusCell.innerHTML = `<div style="display: flex; align-items: center; gap: 6px;">${statusCellHTML(m)}</div>`;
      }
      const responseCell = row.cells[8];
      if (responseCell && !inflightTests.has(getModelRowKey(m))) {
        responseCell.innerHTML = responseCellHTML(m.lastResponse, { rowKey: getModelRowKey(m), providerKey: m.providerKey, modelId: m.modelId, hasAuth: m.status !== 'noauth', status: m.status });
      }

      // Update the Speed tag (col 3): the verdict pill plus the tooltip's ttft/tok/s, rebuilt
      // on every refresh because both the verdict and the measurements move with traffic.
      const speedCell = row.cells[3];
      if (speedCell) speedCell.innerHTML = speedTagInner(m.verdict, rowTtft(m), rowTps(m), rowTtftLabel(m), getModelRowKey(m) === fastestRowKey, isRowUsable(m));
    }

    // Formats a raw token count like the catalog's context strings: "128k", "1.5M", "32000".
    // One decimal only when a single digit leads the lumped figure — "8.1k" but "433k", "1.2M"
    // but "15M" — so the column width stays predictable (see formatTokenCount in lib/utils.js,
    // whose output this mirrors for the same strings).
    function formatTokenCount(n) {
      const value = Number(n);
      if (!Number.isFinite(value) || value <= 0) return null;
      const lump = (scale, suffix) => {
        const units = value / scale;
        const shown = units >= 10 ? Math.round(units) : Math.round(units * 10) / 10;
        return `${shown}${suffix}`;
      };
      if (value >= 1e9) return lump(1e9, 'B');
      if (value >= 1e6) return lump(1e6, 'M');
      if (value >= 1e3) return lump(1e3, 'k');
      return String(Math.round(value));
    }

    // The same compact shape for counts that are always rendered (a zero is "0", never null):
    // the log card's in/out split and any other raw token figure on the page.
    function fmtCompactTokens(n) {
      const value = Number(n);
      if (!Number.isFinite(value) || value < 0) return String(n);
      if (value === 0) return '0';
      if (value >= 1e9) { const u = value / 1e9; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}B`; }
      if (value >= 1e6) { const u = value / 1e6; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}M`; }
      if (value >= 1e3) { const u = value / 1e3; return `${u >= 10 ? Math.round(u) : Math.round(u * 10) / 10}k`; }
      return String(Math.round(value));
    }

    // Convert a milliseconds value to a seconds string (e.g. 8913 -> "8.91s").
    // Returns null for null/undefined/non-finite so callers can render their own placeholder.
    function formatSecondsFromMs(ms) {
      if (ms == null) return null;
      const s = Number(ms) / 1000;
      if (!Number.isFinite(s)) return null;
      return (s >= 10 ? s.toFixed(1) : s.toFixed(2)) + 's';
    }

    function formatTtftCell(ttft, sub) {
      return `<td class="text-right">
        <div style="font-variant-numeric: tabular-nums; text-align:right; line-height:1.3;">
          ${ttft != null ? `<div style="font-size:0.82rem;">${formatSecondsFromMs(ttft)}</div><div style="font-size:0.7rem; color:var(--text-muted);">${sub}</div>` : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>'}
        </div>
      </td>`;
    }

    function formatTpsCell(tps, sub) {
      return `<td class="text-right">
        <div style="font-variant-numeric: tabular-nums; text-align:right; line-height:1.3;">
          ${tps != null ? `<div style="font-size:0.82rem;">${tps}</div><div style="font-size:0.7rem; color:var(--text-muted);">${sub}</div>` : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>'}
        </div>
      </td>`;
    }

    // The Speed column's tag: the same verdict pill the provider setup popup lists, so a model
    // reads the same colour and word in both places. The verdict is the server's own
    // getVerdict() answer carried on the row (`m.verdict`), not a second opinion computed here.
    // The tooltip carries the measurements the TTFT and Tok/s columns used to print.
    function speedTagClass(verdict) {
      const v = String(verdict || '').toLowerCase();
      if (v === 'very fast' || v === 'fast' || v === 'normal') return 'up';
      if (v === 'slow' || v === 'very slow') return 'slow';
      if (v === 'unstable') return 'unstable';
      return 'down';
    }

    function speedTagTitle(ttft, tps, ttftLabel = 'ttft') {
      const parts = [];
      parts.push(`TTFT ${ttft != null ? formatSecondsFromMs(ttft) : '—'}${ttftLabel === 'avg' ? ' avg' : ''}`);
      parts.push(`tok/s ${tps != null ? tps : '—'}`);
      return parts.join(' · ');
    }

    // `active` is whether the row can take a request right now (see isRowUsable). A measured
    // band on a row that cannot serve is history rather than a claim about today, so it is
    // drawn in greyscale: the wording and the measurements stay, the colour stops implying
    // that this is a live choice.
    function speedTagInner(verdict, ttft, tps, ttftLabel = 'ttft', fastest = false, active = true) {
      const label = String(verdict || '').trim();
      const title = active ? speedTagTitle(ttft, tps, ttftLabel) : `${speedTagTitle(ttft, tps, ttftLabel)} · not serving right now`;
      // The superlative outranks the band: the fastest row that could take a request right now
      // says so, whatever its measured tag would have been.
      if (fastest) {
        return `<span class="onboard-pill speed-tag fastest" title="Fastest of the models that can serve right now — ${escapeAttr(title)}">Fastest</span>`;
      }
      // 'Not Active' is not a speed: a row with no measurement at all shows a dash, not a red
      // pill that would read as a verdict on how fast it is.
      if (!label || label === 'Not Active') {
        return `<span class="speed-tag-none" title="${escapeAttr(title)}">—</span>`;
      }
      return `<span class="onboard-pill speed-tag ${speedTagClass(verdict)}${active ? '' : ' inactive'}" title="${escapeAttr(title)}">${escapeHtml(label)}</span>`;
    }

    function speedTagCell(verdict, ttft, tps, ttftLabel = 'ttft', fastest = false, active = true) {
      return `<td class="text-right">${speedTagInner(verdict, ttft, tps, ttftLabel, fastest, active)}</td>`;
    }

    // The test response a model heading should show, plus the row it came from (so the
    // cell can annotate it against that row's verdict rather than the heading's).
    //
    // One rule for the members it is given: the newest response wins, and a clean success
    // is only shown when the row behind it can serve right now — a 'Ready' from a row that
    // is rate-limited, timed out or down is exactly the stale evidence a heading must not
    // advertise. A failure is always passed through (the response cell then decides whether
    // it is the same statement the clock beside it is already making).
    //
    // Returns null when there is nothing honest to show, which leaves the Test button in
    // the cell. The graveyard passes opts.allowStale: a struck row is never usable, and
    // its history is exactly what that row exists to show.
    function groupLastResponse(members, opts = {}) {
      const providers = members || [];
      let latest = null;
      let latestOwner = null;
      let latestUsable = false;
      for (const m of providers) {
        const lr = m.lastResponse;
        if (!lr) continue;
        const clean = lr.error == null && lr.text != null && String(lr.text).trim() !== '';
        if (clean && providers.length > 1 && isRowUsable(m)) {
          // No body text is fabricated for a heading. The cell drops the response line
          // altogether for a group's clean success (see responseCellHTML), so the heading
          // never prints one member's words as the model's answer; the status column beside
          // it carries the verdict and the meta line still reports the test's cost.
          return { ...lr, _groupReady: true, _owner: m };
        }
        if (!latest || (lr.at || 0) > (latest.at || 0)) {
          latest = lr;
          latestOwner = m;
          latestUsable = isRowUsable(m);
        }
      }
      if (!latest) return null;
      if (latest.error == null && !latestUsable && !opts.allowStale) return null;
      return { ...latest, _owner: latestOwner };
    }

    // Removes reasoning content wrapped in <thought>/<thinking> tags from test
    // responses (some models emit their internal reasoning before the real answer).
    function stripThoughtTags(text) {
      if (text == null) return text;
      return String(text).replace(/<(thought|thinking)>[\s\S]*?<\/(thought|thinking)>/gi, '').trim();
    }

    // Builds the Test button that lives right after the provider/model name.
    // opts: { hasAuth, rowKey, providerKey?, modelId?, members? } — members makes the
    // button test the whole group via the router's QoS ranking.
    function testBtnHTML(opts) {
      if (!opts || opts.hasAuth === false) return '';
      const args = (opts && opts.members && opts.members.length > 0)
        ? { rowKey: opts.rowKey, members: opts.members.map(x => ({ providerKey: x.providerKey, modelId: x.modelId })) }
        : { rowKey: opts.rowKey, providerKey: opts.providerKey, modelId: opts.modelId };
      const btnArgs = JSON.stringify(args).replace(/"/g, '&quot;');
      const action = (opts && opts.members && opts.members.length > 1)
        ? 'testModelGroupButton'
        : 'testModelButton';
      return `<button class="test-btn" onclick="event.stopPropagation(); ${action}(this, ${btnArgs})" title="Send 'Please respond with a creative, funny, inspiring 30 words about hammers.' to this model">Test</button>`;
    }

    // Builds the Response cell: the Test button, and the text of a *failed* response. A clean
    // answer is not printed here — it is the status icon's tooltip instead (see
    // statusCellHTML), so a successful row stays one line instead of growing a box of prose
    // under every Test button.
    // opts: { rowKey, providerKey?, modelId?, members?, owner? } — `owner` is the row a
    // shared response came from (a group heading), so the cell can judge that response
    // against the row that produced it instead of against the heading.
    function responseCellHTML(lastResponse, opts) {
      // Models with no API key / auth configured show a placeholder.
      if (opts && opts.hasAuth === false) {
        return '<div class="test-cell"><span class="test-meta" style="color:var(--text-muted);">—</span></div>';
      }
      const btn = testBtnHTML(opts);
      // The retry clock sits beside the button so a click does not look like the only way
      // the row will be tested again; it is empty for anything not on that schedule.
      const retry = autoRetestNote(opts && opts.rowKey);
      if (!lastResponse) return `<div class="test-cell">${btn}${retry}</div>`;
      // Timeout errors carry an expiry; once it passes, treat the result as absent
      // so a stale timeout no longer populates the test result field.
      const expired = lastResponse.expiresAt != null && Date.now() > Number(lastResponse.expiresAt);
      // The row this response belongs to: a group heading passes its owner explicitly
      // (the member the response came from), every other path is looked up by row key, so
      // the initial build, the poll refresh and the post-test paint all judge the same
      // response against the same row.
      const owner = (opts && opts.owner) || ((opts && opts.rowKey) ? allModels.find(mm => getModelRowKey(mm) === opts.rowKey) : null);
      const ownerVerdict = owner ? rowVerdict(owner) : null;
      const ownerUp = ownerVerdict == null ? null : ownerVerdict === 'up';
      // The Status cell already carries the refusal when it shows a clock with a countdown:
      // repeating the provider's 429 body under the Test button adds nothing, and the countdown
      // is the actionable form of the same statement. A clock without a countdown still leaves
      // the body here, because then the error is the only thing that says what is wrong.
      const clockedWithCountdown =
        owner != null && isRateLimitedRow(owner) && getRateLimitResetAt(owner) != null;
      const errText =
        !expired && !clockedWithCountdown && lastResponse.error ? String(lastResponse.error) : '';
      const okText = !errText && !expired && lastResponse.ok !== false && lastResponse.text != null ? String(lastResponse.text) : '';
      const text = stripThoughtTags(errText || okText);
      // A result that outlives the state of the row it came from is history, not a live
      // verdict — a 'Ready' on a row that cannot serve now, or a failure the row has since
      // recovered from. Annotating its age is what keeps a green dot beside red error text
      // (or the reverse) from reading as a contradiction.
      //
      // Two ways to become history: the row's state moved past it, or a probe has succeeded
      // since it spoke. The second needs no waiting period — a failure a later probe already
      // outlived is superseded the moment that probe lands, however recent it is.
      const ageMs = lastResponse.at ? Date.now() - Number(lastResponse.at) : null;
      const disagrees = ownerUp != null
        && ((okText !== '' && !ownerUp) || (errText !== '' && ownerUp));
      const superseded = !!(owner && !testIsNewestEvidence(owner));
      const stale = !expired && disagrees
        && ((ageMs != null && ageMs > 10 * 60_000) || superseded);
      // Show the number of tokens the model actually returned; nothing else. A zero
      // is never that count: it is a provider's zeroed usage block (the server's
      // resolveReportedOutputTokens refuses to record one) or a response persisted
      // before it did, so it stays hidden rather than contradicting the tok/s
      // measured from the same answer.
      const metaBits = [];
      const reportedTokens = Number(lastResponse.tokens);
      if (!expired && Number.isFinite(reportedTokens) && reportedTokens > 0) {
        metaBits.push(`${fmtCompactTokens(reportedTokens)} token${reportedTokens === 1 ? '' : 's'}`);
      }
      // An answer that arrived in one piece measures no first token and no generation rate
      // (the server refuses to charge a whole response's duration to generation — see
      // resolveStreamGenerationMs), so the row keeps whatever its real traffic measured and
      // the only honest number left about this test is how long it took.
      const durationMs = Number(lastResponse.durationMs);
      // A cached answer is excluded: its duration is this connection's delivery of a stored
      // response, so "took 2.6s" would read as a measurement the cell explicitly isn't making.
      if (!expired && !lastResponse.cached && lastResponse.tps == null && Number.isFinite(durationMs) && durationMs > 0) {
        // A local endpoint can answer a non-streamed request in single-digit milliseconds, and
        // the seconds formatter rounds that to "0.00s" — a label that reads as a broken number.
        const shown = durationMs < 10 ? `${Math.round(durationMs)}ms` : formatSecondsFromMs(durationMs);
        metaBits.push(`<span title="No generation rate was measured: this answer did not stream, so only the whole request time is known.">took ${shown}</span>`);
      }
      // A reasoning model that ran out of output budget before reaching the content channel has
      // real output but no visible answer, and the text shown here is that reasoning. Saying so
      // keeps the cell from reading as a reply, and names the cause when the provider said the
      // answer was truncated (finish_reason 'length').
      if (!expired && lastResponse.reasoningOnly) {
        metaBits.push(`<span title="The model spent its whole output budget on reasoning and never reached a visible answer. This is the reasoning text.">reasoning only</span>`);
      } else if (!expired && lastResponse.truncated) {
        metaBits.push(`<span title="The provider stopped because the output budget ran out.">truncated</span>`);
      }
      // The provider answered from its own cache, so this is a stored answer rather than one
      // generated for this click. Saying so keeps a replay from reading as a fresh measurement
      // (no latency or speed was recorded from it — see isCachedReplayResponse).
      if (!expired && lastResponse.cached) {
        metaBits.push(`<span title="The provider served this answer from its own response cache instead of generating it for this test, so no latency or speed was measured. Treat it as proof the model is reachable, not as proof it can serve real requests.">cached</span>`);
      }
      // The router sent a real request to this row and the row refused it. That is the same
      // evidence a Test click would have left, and it is shown the same way — but it was not a
      // click, and saying which it was is the difference between "I tested this" and "this
      // happened while I was working". The router writes this marker (see
      // recordRoutedModelFailure) and never for a Test, so its presence is the whole answer.
      if (!expired && lastResponse.routedFailure) {
        metaBits.push('<span title="Fallback triggered by live traffic, not by a Test click: the router sent this model a real request and it failed, so the error above caused a fallback to the next available model.">live request — fallback</span>');
      }
      if (stale) {
        const when = new Date(Number(lastResponse.at)).toLocaleString();
        const what = errText !== '' ? 'Last failed test' : 'Last successful test';
        metaBits.push(`<span title="${what}: ${escapeAttr(when)}" style="opacity:.8;">${fmtAgo(ageMs)}</span>`);
      }
      const meta = metaBits.length > 0 ? `<div class="test-meta">${metaBits.join(' · ')}</div>` : '';
      const expAttr = lastResponse.expiresAt != null ? ` data-expires-at="${lastResponse.expiresAt}"` : '';
      // A heading row (its response comes from groupLastResponse) shows no response body at
      // all: the status column beside this cell already states the group's verdict, so a
      // synthesized "Ready" there only repeated it, and printing the member's real words
      // would attribute one provider's answer to the whole model.
      // Only a failure keeps its box open. The text of a success is not printed anywhere in this
      // cell; `statusCellHTML` puts it on the verdict indicator's tooltip, where it costs no row
      // height. Failures stay in the open because their text is the reason the row is not
      // serving, and a tooltip nobody thinks to hover would hide it.
      const body = lastResponse._groupReady
        ? ''
        : (errText
          ? `<div class="test-response err"${expAttr} title="${escapeAttr(text)}">${text ? escapeHtml(text) : `HTTP ${lastResponse.status}`}</div>`
          : '');
      return `<div class="test-cell">${btn}${retry}${body}${meta}</div>`;
    }

    function escapeAttr(s) {
      return escapeHtml(s).replace(/"/g, '&quot;');
    }

    // A clean test response only counts as liveness while it is recent. Mirrors the
    // server's readiness window (RECENT_SUCCESS_KEEP_UP_MS in lib/server.js): without
    // the bound, a success from any time ago would keep a row green here while the
    // router has long since stopped trusting it, and every stale row would look like a
    // contradiction for scheduleContradictoryRetests() to chase.
    const READY_FRESHNESS_MS = 60 * 60_000

    // True when the model's most recent test response is a clean 'Ready' (non-expired,
    // successful, non-empty text, no error). The test result is authoritative as long
    // as it stands — it does not expire arbitrarily after 60 minutes into Down.
    function isLastResponseReady(lastResponse) {
      if (!lastResponse) return false;
      if (lastResponse.ok === false) return false;
      if (lastResponse.error) return false;
      if (!lastResponse.text || String(lastResponse.text).trim() === '') return false;
      if (lastResponse.expiresAt != null && Date.now() > Number(lastResponse.expiresAt)) return false;
      return true;
    }

    // The words a successful test produced, for the status icon's tooltip.
    //
    // Empty unless that answer is still the row's verdict: a response the row has outgrown, or
    // one whose window passed, must not be quoted as the answer the row is giving now. Same
    // test the verdict itself uses, so the tooltip cannot contradict the dot it hangs on.
    function readyAnswerText(m) {
      const lr = m && m.lastResponse;
      if (!isLastResponseReady(lr)) return '';
      return stripThoughtTags(String(lr.text || '')).trim();
    }

    // ---- The one row verdict -------------------------------------------------
    // The Status column is the absolute slave of and fully defined by the Test column,
    // with exceptions only when the model is actually being used (live proxy traffic).
    const STRUCK_VERDICTS = new Set(['paid', 'dead', 'incompatible', 'micro', 'noauth']);
    // The balance half of the account refusals, kept in step with INSUFFICIENT_FUNDS_RE in
    // lib/utils.js: a stated shortfall on the account's own balance or funds is money the row
    // needs rather than a quota it waits out. The server marks such a response `paymentRequired`
    // (the primary route to the Paid badge), and this copy is what keeps evidence stored before
    // that rule existed — or a row whose flag was never persisted — from reading as the clock.
    const INSUFFICIENT_FUNDS_RE = /\b(?:insufficient|not enough|no|out of|low|zero|negative|empty)\b[^.\n]{0,24}\b(?:account\s+|wallet\s+|credit\s+)?(?:balance|funds?)\b|\b(?:account\s+|wallet\s+|credit\s+)?(?:balance|funds?)\b[^.\n]{0,24}\b(?:insufficient|empty|zero|negative|too low|depleted|exhausted|out of funds?)\b|\bremaining\b\s*[:=]?\s*(?:[$€£¥＄]|usd\s*)\s*0(?:[.,]0+)?(?![\d.,])\b/i;
    // The other half of the account refusals, kept in step with isRateLimitedErrorText in
    // lib/utils.js: a quota the row waits out. It outranks a bare 402 in the verdicts below,
    // because a provider that labels its rate limit 402 must not earn a Paid badge for it.
    const RATE_LIMIT_RE = /resource_exhausted|freeusagelimiterror|err_free_rate|free model capacity is limited|rate_limit_error|quota exceeded|rate limit exceeded|too many requests|concurrent\s+requests?|in-?flight\s+(?:requests?|limit)|\b(?:reached|exceeded)\s+(?:the|your)\s+limit\b/i;
    // The incompatible half of the same mirror, kept in step with isIncompatibleModelError in
    // lib/utils.js — the rule the server reads the same stored text with. The narrow
    // `image/video only | not support text` pair this replaces missed most of the canonical
    // clauses, so a row the server had already struck as Incompatible kept its place in the main
    // table with an empty Status cell: llm7 refuses every Seedance id with "Model
    // 'seedance-2.0-fast' does not support chat endpoints." (live 2026-09-22), which the router
    // read as incompatible and this file re-read as a generic Down. A decision model served only
    // on /v1/systemone (cloudflare's clef:27b) is the same statement worded differently.
    const INCOMPATIBLE_MODEL_RE = /does not exist or you (?:do not|don't) have access to it|content cannot be a plain string|model does not support text input|only supports (?:the )?interactions api|only supports (?:real[- ]time )?bidirectional streaming(?: via websocket)?|bidiGenerateContent(?: via websocket)?|gemini live api|chat.completions.*(?:is not supported|not available|unsupported)|route not supported|does not support (?:chat|(?:this|that|the) endpoint)|only available on agentic harnesses|calibration|requires terms acceptance|model_terms_required|terms (?:have|has) not been accepted|requires acceptance of the terms|requested model is not supported|model_not_supported|can only be used from within|is a realtime model and cannot be used on the text endpoint|is a audio model and cannot be used on the text endpoint|Transcribe|required properties at '\/' are 'model,\s*state,\s*questions'?|is a decision model|only supports (?:(?:the )?\/v1\/systemone(?: (?:endpoint|api|surface))?)/i;
    // Kept in step with MICRO_CONTEXT_MAX_TOKENS and isUnusablySmallContextError in
    // lib/utils.js. Only a refusal whose *subject* is the model's own window counts: Cloudflare
    // Workers AI answers "… exceeded this model context window limit (3500)". A comparison
    // against one oversized payload ("Current length is 23592 while limit is 8192") or a
    // throughput quota ("Limit 1000, Requested 1413") also names a small number, and treating
    // either as a verdict would strike working rows out of rotation.
    const MICRO_CONTEXT_MAX_TOKENS = 16384;
    const MODEL_CONTEXT_WINDOW_RE = /model(?:'s)?\s+(?:context|ctx)\s+(?:window|length)\s+limit\s*[(:=]\s*([\d,.]+)|model(?:'s)?\s+(?:maximum|max)?\s*(?:context|ctx)\s*(?:window|length)?\s+(?:is|of)\s+([\d,.]+)/i;
    function isUnusablySmallContextError(errText) {
      const m = MODEL_CONTEXT_WINDOW_RE.exec(String(errText || ''));
      if (!m) return false;
      const limit = Number((m[1] || m[2] || '').replace(/,/g, ''));
      return Number.isFinite(limit) && limit > 0 && limit < MICRO_CONTEXT_MAX_TOKENS;
    }
    // Single entry point for both incompatible rules, so neither call site below can drift.
    function isIncompatibleModelText(errText) {
      return isUnusablySmallContextError(errText) || INCOMPATIBLE_MODEL_RE.test(errText);
    }
    // Every state that means "waiting on the provider": the clock is drawn for all of them. An
    // overload belongs here for the same reason a quota does — the provider is refusing for
    // now and the row returns on its own, so nothing is broken and nothing needs fixing.
    const BENCHED_VERDICTS = new Set(['rate-limited', 'overloaded', 'timeout']);
    // The subset of those that a provider card counts as "still mine": a quota or an overload is a
    // window the provider will reopen, so the row is benched rather than spent. A timeout is
    // deliberately outside it — it says nothing about a window, only that one call was slow.
    const QUOTA_WAIT_VERDICTS = new Set(['rate-limited', 'overloaded']);
    // How long a rate limit stands when the provider names no window at all: the same
    // grace the server applies before it clears its own wasRateLimited flag.
    const RATE_LIMIT_UNSTATED_GRACE_MS = 60_000;

    // When this row last answered a probe successfully, in epoch ms (0 when never).
    //
    // The router states this directly now. The row's 50-entry `pings` history used to ride along
    // on every snapshot while this scan was the only thing the dashboard ever read out of it, so
    // the field replaced the array (see the /api/models row payload in lib/server.js). The scan
    // stays as the fallback for a page newer than the router answering it, which still sends
    // `pings` and no field.
    function lastProbeSuccessAt(m) {
      const reported = Number(m?.lastProbeSuccessAt);
      if (Number.isFinite(reported) && reported > 0) return reported;
      const pings = Array.isArray(m?.pings) ? m.pings : [];
      for (let i = pings.length - 1; i >= 0; i--) {
        if (String(pings[i]?.code) === '200') return Number(pings[i].ts) || 0;
      }
      return 0;
    }

    // True while no real proxy request has seen this row work since the test last spoke.
    function testIsNewestEvidence(m) {
      const at = Number(m?.lastResponse?.at);
      if (!Number.isFinite(at) || at <= 0) return true;
      const lastProxied = Number(m?.lastProxiedAt || 0);
      return at >= lastProxied;
    }

    // What the newest response says the row is waiting on, or null when it says nothing and
    // when a later success has superseded it.
    function refusalKind(m) {
      const lr = m && m.lastResponse;
      if (!lr || lr.ok === true || !lr.error) return null;
      if (!testIsNewestEvidence(m)) return null;
      // The refusal's own words outrank a stored flag: a free-capacity refusal that says
      // "add credits" but names `err_free_rate` is a clock, not money, and the old
      // `paymentRequired` flag used to keep it reading as Paid forever.
      const text = String(lr.error);
      if (RATE_LIMIT_RE.test(text)) return 'rate-limited';
      if (lr.paymentRequired === true || lr.dead === true || lr.incompatible === true) return null;
      if (lr.overloaded === true) return 'overloaded';
      if (Number(lr.status) === 429) return 'rate-limited';
      if (Number(lr.status) === 503 || Number(lr.status) >= 500) {
        return /overload|high demand|capacity|too busy|temporarily unavailable|service unavailable|try again later/i.test(text)
          ? 'overloaded'
          : null;
      }
      return null;
    }

    // The server's own statement that no window can reopen this row: money, a tombstone, or a
    // model that does not serve chat. It reads the evidence with the full rule set (see
    // permanentTestVerdict in lib/utils.js) and is the authority the graveyard's reason is drawn
    // from, so it is taken as the verdict it is.
    function permanentStatusOf(m) {
      const status = String(m?.status || '').toLowerCase();
      return status === 'paid' || status === 'dead' || status === 'incompatible' ? status : null;
    }

    // The same statement made by a *test response* — the click that just landed, before the next
    // poll carries the server's verdict, and for rows whose stored evidence predates a clause in
    // the rule. Mirrors permanentTestVerdict in lib/utils.js, like the other copies in this file.
    // Only when the test is the newest evidence: a row that has really served since (see
    // testIsNewestEvidence) is not condemned by an older refusal.
    function permanentTestVerdictOf(m) {
      const lr = m && m.lastResponse;
      if (!lr || !testIsNewestEvidence(m)) return null;
      if (lr.expiresAt != null && Date.now() > Number(lr.expiresAt)) return null;
      // The refusal's words outrank a stored flag: a free-capacity refusal says "add credits"
      // but names `err_free_rate`, which is a clock, not money.
      if (lr.paymentRequired === true && !RATE_LIMIT_RE.test(String(lr.error || ''))) return 'paid';
      if (lr.dead === true) return 'dead';
      if (lr.incompatible === true) return 'incompatible';
      const code = Number(lr.status || 0);
      const errText = String(lr.error || '');
      // The wording outranks the status here for the same reason it does in lib/utils.js: a
      // provider that labels a rate limit 402 must not get a Paid badge for it. "You have
      // reached the limit." is a quota on a clock, and the base rule below is where it lands.
      if (!RATE_LIMIT_RE.test(errText)
        && (code === 402 || /payment required|billing/i.test(errText) || INSUFFICIENT_FUNDS_RE.test(errText))) return 'paid';
      // The access phrasing wins over the generic 'does not exist' tombstone: the provider
      // still lists the model and refuses this org (see isDeadModelError in lib/utils.js).
      const deadText = /model is dead|model_not_found|410 Gone|model does not exist|invalid[ _]model|unknown[ _]model|please check the model you provided|^(?:(?:http\s*)?404[\s:-]*)?not\s*found\.?$/i.test(errText)
        && !isIncompatibleModelText(errText);
      if (code === 410 || deadText) return 'dead';
      if (isIncompatibleModelText(errText)) return 'incompatible';
      return null;
    }

    // True when such a verdict is newer than the bench the row is sitting on, so the clock it
    // draws is a claim nobody can act on. The server's status is taken as given — it decides the
    // ordering itself — while a test response has to beat the bench's own timestamp, because a
    // 429 observed after that response is the newer story and keeps its clock.
    function permanentOutranksBench(m) {
      if (permanentStatusOf(m)) return true;
      if (!permanentTestVerdictOf(m)) return false;
      return (Number(m.lastResponse?.at) || 0) > (Number(m.rateLimit?.capturedAt) || 0);
    }

    // The clock a busy provider earns. Its own window is never stated in a way worth counting
    // down — "spikes in demand are usually temporary" is the whole claim — so the cell shows a
    // bare clock unless the response carried a retry time of its own.
    function isOverloadedRow(m) {
      if (String(m?.status || '').toLowerCase() === 'overloaded') return true;
      if (m?.lastResponse?.overloaded === true && testIsNewestEvidence(m)) return true;
      return refusalKind(m) === 'overloaded';
    }

    function overloadedResetAt(m) {
      const at = Number(m?.lastResponse?.rateLimitResetAt);
      return Number.isFinite(at) && at > 0 && at > Date.now() ? at : null;
    }

    function rowVerdict(m) {
      if (!m) return 'down';
      const status = String(m.status || '').toLowerCase();
      if (status === 'banned' || status === 'excluded') return status;
      if (status === 'noauth' || m.hasAuth === false) return 'noauth';
      if (m.microContext === true) return 'micro';

      // The verdicts the browser cannot reach for itself. A row whose model id names a non-chat
      // family (isBlockedModelName: audio, translation, search, calibration) and one the liveness probe
      // refused as paid, dead or incompatible have no lastResponse for the classification below
      // to read — the server states them in `status`, so the one authority that can see them is
      // trusted, as isOverloadedRow already trusts 'overloaded'. These are properties of the
      // model rather than of traffic, so they sit here with the other model-level states and
      // ahead of the live-usage exceptions, exactly where resolveModelStatus ranks them.
      const permanentStatus = permanentStatusOf(m);
      if (permanentStatus) return permanentStatus;

      // And the same verdict straight off the response, which is what makes a Test click
      // reclassify a row that is *presently* on the clock — the render that follows the click
      // runs before any poll has carried the server's new status. Younger than live traffic, so
      // a row that is actually being served still reads Up.
      const freshPermanent = permanentTestVerdictOf(m);
      if (freshPermanent) return freshPermanent;

      const lr = m.lastResponse;
      const testAt = Number(lr?.at) || 0;
      const lastProxiedAt = Number(m.lastProxiedAt || 0);

      // ── Exceptions: when the model is actually being used (live proxy traffic) ──
      // 1. Live Rate Limit (HTTP 429 / Quota exhausted on live traffic):
      if (isRateLimitedRow(m)) {
        const rateLimitCapturedAt = Number(m.rateLimit?.capturedAt) || 0;
        const testClearedLimit = isLastResponseReady(lr) && testAt > rateLimitCapturedAt;
        if (!testClearedLimit) return 'rate-limited';
      }

      // 2. Live Overload (HTTP 503 / High demand on live traffic):
      if (isOverloadedRow(m)) {
        const overloadAt = Number(m.lastError?.updatedAt) || 0;
        const testClearedOverload = isLastResponseReady(lr) && testAt > overloadAt;
        if (!testClearedOverload) return 'overloaded';
      }

      // 3. Live Success (a real request through the proxy succeeded):
      const liveProxiedNewer = lastProxiedAt > 0 && lastProxiedAt >= testAt;
      if (liveProxiedNewer) return 'up';

      // ── Base Rule: Status is the absolute slave of the Test column ──────────
      if (lr) {
        const expired = lr.expiresAt != null && Date.now() > Number(lr.expiresAt);
        if (!expired) {
          // A clean, successful test response means the model is UP:
          if (isLastResponseReady(lr)) {
            return 'up';
          }

          // A test failure is classified directly by what the test reported:
          if (lr.paymentRequired === true && !RATE_LIMIT_RE.test(String(lr.error || '')))
            return 'paid';
          if (lr.dead === true) return 'dead';
          if (lr.incompatible === true) return 'incompatible';
          if (lr.overloaded === true) return 'overloaded';

          const code = Number(lr.status || 0);
          const errText = String(lr.error || '');

          if (!RATE_LIMIT_RE.test(errText)
            && (code === 402 || /payment required|billing/i.test(errText) || INSUFFICIENT_FUNDS_RE.test(errText))) return 'paid';
          // 'model does not exist' is kept in step with isDeadModelError in lib/utils.js so a
          // row whose stored evidence predates that rule still reads Dead rather than Down.
          // The access phrasing wins over the generic 'does not exist' tombstone: the provider
      // still lists the model and refuses this org (see isDeadModelError in lib/utils.js).
      const deadText = /model is dead|model_not_found|410 Gone|model does not exist|invalid[ _]model|unknown[ _]model|please check the model you provided|^(?:(?:http\s*)?404[\s:-]*)?not\s*found\.?$/i.test(errText)
        && !isIncompatibleModelText(errText);
      if (code === 410 || deadText) return 'dead';
          // Kept in step with isIncompatibleModelError in lib/utils.js, so stored evidence from
          // before a clause existed still classifies the way the server classifies the same text.
          if (isIncompatibleModelText(errText)) return 'incompatible';
          if (code === 429 || RATE_LIMIT_RE.test(errText)) {
            return 'rate-limited';
          }
          if (code === 503 || /overload|high demand|capacity|too busy|temporarily unavailable|service unavailable|try again later/i.test(errText)) {
            return 'overloaded';
          }
          if (code === 401 || code === 403) return 'noauth';
          if (code === 408 || code === 504 || /timed?\s*out/i.test(errText)) return 'timeout';
          return 'down';
        }
      }

      // ── Untested (No test response and no live usage) ────────────────────────
      // Down, not a 'pending' holding state: the Status column is a slave of the response
      // column, so a row nothing has answered for reads as Down until a test or live traffic
      // says otherwise. The few exceptions above are the only ones that can override it, and
      // each is a statement about *actual usage* (a live rate limit, a provider overload, or a
      // proxied success).
      return 'down';
    }

    function isRowUp(m) {
      return rowVerdict(m) === 'up';
    }

    // Stricter than isRowUp: a row can only lend its numbers to a heading when it could
    // actually take a request right now. The router itself decides that, so a row the
    // server reports as not routing-eligible (rate-limited, banned, filtered) never
    // contributes a speed or a context bound to its model's heading.
    function isRowUsable(m) {
      return isRowUp(m) && m.routingEligible !== false;
    }

    // The router's own speed number for a row, with a client-side recomputation for a payload
    // that predates the field: N / (ttft + N / tok-per-s) at the same reference length the
    // server scores (SPEED_REFERENCE_TOKENS = 500). Higher is faster.
    function rowRoutingSpeed(m) {
      const sent = Number(m?.routingSpeed);
      if (Number.isFinite(sent) && sent > 0) return sent;
      const ttft = rowTtft(m);
      const tps = rowTps(m);
      if (ttft == null || !Number.isFinite(ttft) || ttft < 0) return null;
      if (tps == null || !Number.isFinite(tps) || tps <= 0) return null;
      return 500 / (ttft / 1000 + 500 / tps);
    }

    // The router's own intelligence number for a row: AA's index when there is one, else the
    // local score on the same 0-100 scale. Higher is smarter.
    function rowRoutingIntelligence(m) {
      const sent = Number(m?.routingIntell);
      if (Number.isFinite(sent) && sent > 0) return sent;
      const aa = Number(m?.aa);
      if (Number.isFinite(aa) && aa > 0) return aa;
      const intell = Number(m?.intell) * 100;
      return Number.isFinite(intell) && intell > 0 ? intell : null;
    }

    // Picks the two rows the Speed and INT columns badge. Candidates are the rows that could
    // take a request right now — the same set the router would choose from — so 'Fastest' and
    // 'Smartest' always name something the table says is live. Ties break on row order, which
    // is the catalog's own stable order.
    function computeSpeedLeaders(models) {
      let fastest = null;
      let smartest = null;
      for (const m of models || []) {
        if (!m || !isRowUsable(m)) continue;
        const speed = rowRoutingSpeed(m);
        if (speed != null && (fastest == null || speed > fastest.speed)) {
          fastest = { key: getModelRowKey(m), speed };
        }
        const intell = rowRoutingIntelligence(m);
        if (intell != null && (smartest == null || intell > smartest.intell)) {
          smartest = { key: m.modelGroupId || getModelGroupKey(m), intell };
        }
      }
      fastestRowKey = fastest ? fastest.key : null;
      smartestGroupKey = smartest ? smartest.key : null;
    }

    // The verdicts in the order a model heading prefers them when nothing is up: the
    // states that come back on their own first, then the ones the user has to fix.
    const VERDICT_RECOVERABILITY = [
      'up', 'rate-limited', 'overloaded', 'timeout', 'noauth', 'paid', 'incompatible', 'dead', 'micro', 'down', 'banned', 'excluded',
    ];

    // Rank for the heading's pick. An unrecognised state ranks last rather than first:
    // indexOf() returns -1, which would otherwise make a verdict nobody accounted for
    // outrank every real one.
    function verdictRank(kind) {
      const index = VERDICT_RECOVERABILITY.indexOf(kind);
      return index === -1 ? VERDICT_RECOVERABILITY.length : index;
    }

    // The heading's own verdict: green when any provider can serve, and otherwise the
    // most recoverable reason among them, so a model whose providers are all waiting on
    // a quota reads as the clock its provider rows show rather than as a red dot.
    function bestGroupVerdict(members) {
      let best = null;
      for (const m of members || []) {
        const kind = rowVerdict(m);
        if (best === null || verdictRank(kind) < verdictRank(best)) best = kind;
      }
      return best || 'down';
    }

    function verdictLabel(kind) {
      switch (kind) {
        case 'noauth': return 'No Auth';
        case 'rate-limited': return 'Rate limited';
        case 'overloaded': return 'Overloaded';
        case 'incompatible': return 'Incompatible';
        case 'micro': return 'Micro';
        case 'dead': return 'Dead';
        case 'paid': return 'Paid';
        case 'timeout': return 'Timeout';
        case 'up': return 'Up';
        default: return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Down';
      }
    }

    // The dot's colour. Waiting on a provider window is its own colour — a rate-limited
    // or timed-out row is not a failure, and painting it red reads as broken.
    function verdictDotColor(kind) {
      if (kind === 'up') return 'var(--success)';
      if (BENCHED_VERDICTS.has(kind)) return 'var(--warning)';
      if (kind === 'banned' || kind === 'excluded') return 'var(--text-muted)';
      return 'var(--error)';
    }

    // The one indicator: a clock for the states that mean "waiting on the provider's own
    // window", a Z for a model that is merely asleep, a dot for everything else.
    //
    // The clock is a promise as much as a state: a quota or an overload names a moment the
    // provider reopens by itself. A timeout names nothing — the model was too slow just now and
    // may answer the next request — so it gets its own glyph instead of borrowing that promise.
    function verdictIndicatorHTML(kind, title = '') {
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      if (kind === 'timeout') {
        return `<span style="color: var(--warning); font-weight: 700;"${titleAttr}>Z</span>`;
      }
      if (BENCHED_VERDICTS.has(kind)) {
        return `<span style="color: var(--warning);"${titleAttr}>🕑</span>`;
      }
      return `<span style="width: 6px; height: 6px; border-radius: 50%; background: ${verdictDotColor(kind)}; display: inline-block; vertical-align: middle;"${titleAttr}></span>`;
    }

    // A response that actually answered. TTFT and tok/s may only come from one of these:
    // a failed call measures how long the provider took to refuse, and publishing that as
    // the model's speed is how a rate-limited row came to read "0.35s avg" for a request
    // that returned nothing. The server gates its own payload the same way; this keeps
    // the last-response fallback (and payloads from an older server) to that rule.
    function servedResponse(lastResponse) {
      if (!lastResponse || lastResponse.ok === false || lastResponse.error) return null;
      if (lastResponse.text == null || String(lastResponse.text).trim() === '') return null;
      return lastResponse;
    }

    function rowTtft(m) {
      if (m && m.ttft != null) return Number(m.ttft);
      const served = servedResponse(m && m.lastResponse);
      return served && served.ttftMs != null ? Number(served.ttftMs) : null;
    }

    function rowTps(m) {
      if (m && m.tps != null) return Number(m.tps);
      const served = servedResponse(m && m.lastResponse);
      return served && served.tps != null ? Number(served.tps) : null;
    }

    // The row's own mean answered length (else the length of its single measured response),
    // from the same basis the server used for rowTtft/rowTps. It no longer feeds the speed
    // score — that is scored at the fixed SPEED_REFERENCE_TOKENS on both sides — so this is
    // context for the user (the tooltip), not a term in any formula.
    function rowSpeedTokens(m) {
      if (m && m.speedTokens != null) return Number(m.speedTokens);
      const served = servedResponse(m && m.lastResponse);
      return served && served.completionTokens != null ? Number(served.completionTokens) : null;
    }

    // Which kind of sample the TTFT column is showing: a window average, or the single
    // most recent measurement. Calling a lone measurement an average is a claim the data
    // cannot support, so the sublabel follows the source the server reports.
    function rowTtftLabel(m) {
      return m && m.ttftSource === 'average' ? 'avg' : 'ttft';
    }

    // Compact "1h ago" / "2d ago" label for stale test responses.
    function fmtAgo(ms) {
      if (ms < 60_000) return 'just now';
      const m = Math.floor(ms / 60000);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    }

    // A live contradiction between the two kinds of evidence, worth one automatic
    // re-test: a failure the row's own verdict has already moved past — a row the
    // dashboard calls up whose last test said something failed.
    //
    // The other direction needs no chase: a fresh clean 'Ready' *is* the up verdict
    // (see rowVerdict), and the server promotes the same evidence the same way, so a
    // Ready that outranks a stale probe status is agreement rather than disagreement.
    //
    // The signature has to be *stable*: it used to carry the response timestamp, so
    // every re-test produced a new signature and a row that kept failing was re-tested
    // on every poll — a slow way to spend a provider's quota. Volatile numbers in the
    // error text are masked for the same reason, and scheduleContradictoryRetests()
    // holds each row to a cooldown on top of this.
    function contradictoryRetestSignature(m) {
      const response = m?.lastResponse;
      if (!response || !response.error) return null;
      if (rowVerdict(m) !== 'up') return null;
      return `up|error|${String(response.error).replace(/\d+/g, '#').slice(0, 160)}`;
    }

    function scheduleContradictoryRetests() {
      for (const m of allModels) {
        const signature = contradictoryRetestSignature(m);
        const rowKey = getModelRowKey(m);
        if (!signature) {
          automaticRetestSignatures.delete(rowKey);
          continue;
        }
        if (automaticRetestSignatures.get(rowKey) === signature || inflightTests.has(rowKey)) continue;
        // The cooldown is what bounds the chase: without it, a row whose test keeps
        // disagreeing with its probes is re-tested as fast as the poll re-renders.
        if (Date.now() - (automaticRetestAt.get(rowKey) || 0) < AUTOMATIC_RETEST_COOLDOWN_MS) continue;
        automaticRetestSignatures.set(rowKey, signature);
        automaticRetestAt.set(rowKey, Date.now());
        const row = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`);
        const button = row?.querySelector('.test-btn:not([disabled])');
        if (button) testModelButton(button, { rowKey, providerKey: m.providerKey, modelId: m.modelId });
      }
    }

    // The earliest automatic retry waiting among a group's members, or 0. A collapsed group
    // hides its member rows, so the note that belongs to a benched member would be invisible;
    // the heading's Test button tests those same members (testModelGroupButton), so the wait
    // is drawn beside it as well.
    function groupAutoRetestAt(groupKey) {
      const group = (lastMainGroups || []).find(g => g && g.key === groupKey);
      if (!group || !Array.isArray(group.members)) return 0;
      let soonest = 0;
      for (const member of group.members) {
        const at = Number(autoRetestAt.get(getModelRowKey(member))) || 0;
        if (at > 0 && (!soonest || at < soonest)) soonest = at;
      }
      return soonest;
    }

    // The member a group's note speaks for: the one whose slot comes first. A position in the
    // queue is keyed by row, and a collapsed group draws its wait on the heading, so the
    // heading needs the row behind that wait to be able to name its place.
    function groupAutoRetestRow(groupKey) {
      const group = (lastMainGroups || []).find(g => g && g.key === groupKey);
      let soonest = 0;
      let soonestKey = '';
      for (const member of group?.members || []) {
        const key = getModelRowKey(member);
        const at = Number(autoRetestAt.get(key)) || 0;
        if (at > 0 && (!soonest || at < soonest)) { soonest = at; soonestKey = key; }
      }
      return soonestKey;
    }

    // The note beside a row's Test button, or '' when no automatic retry is waiting.
    function autoRetestNote(rowKey) {
      if (!rowKey) return '';
      const isGroup = rowKey.startsWith('g:');
      const at = isGroup
        ? groupAutoRetestAt(rowKey.slice(2))
        : (Number(autoRetestAt.get(rowKey)) || 0);
      if (at <= 0) return '';
      const queueKey = isGroup ? groupAutoRetestRow(rowKey.slice(2)) : rowKey;
      return `<span class="test-retry" title="${escapeAttr(autoRetestTitle(queueKey))}" data-retest-row="${isGroup ? '' : escapeAttr(rowKey)}" data-retest-group="${isGroup ? escapeAttr(rowKey.slice(2)) : ''}" data-retest-at="${at}">${retestWaitLabel(at)}</span>`;
    }

    // The queue in the order its slots will start. The slot times are the order — rows join at
    // the back — so this is what a row's place is read from.
    function autoRetestOrder() {
      return [...autoRetestAt.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    }

    // "48s", "3m 05s", "1h 12m". A wait spelled in seconds alone reads as "testing in 137s" a
    // few rows into the queue, which is a number nobody can turn into a decision.
    function retestWaitText(ms) {
      const total = Math.max(0, Math.ceil(Number(ms) / 1000));
      if (total < 60) return `${total}s`;
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes < 60)
        return seconds ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
      return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    }

    // When this row's turn comes. "retest next" means its slot has arrived and it is the test
    // the scheduler starts as soon as the one in flight finishes — a fact about this row. The
    // wording it replaces claimed the same thing for every row in a twenty-row queue, for the
    // whole twenty minutes it took to walk that queue.
    function retestWaitLabel(at, now = Date.now()) {
      const ms = Number(at) - now;
      if (!(ms > 0)) return autoRetestBusy || testAllRunning ? 'retest next' : 'retest now';
      return `retest in ${retestWaitText(ms)}`;
    }

    // The hover text: the row's place in the queue, and the rule the queue runs on.
    function autoRetestTitle(queueKey) {
      const order = autoRetestOrder();
      const index = queueKey ? order.findIndex(([key]) => key === queueKey) : -1;
      const where =
        index >= 0 ? `${index + 1} of ${order.length} waiting` : `${order.length} waiting`;
      return `Automatic retest — ${where}, one test a minute`;
    }

    // The note ticks once a second, so the wait is visible between renders instead of a
    // countdown that only moves when the table happens to be rebuilt.
    function updateAutoRetestNotes() {
      const now = Date.now();
      // A schedule is made after the snapshot renders (see scheduleAutomaticRetests), so a
      // row's first note has no markup to update. Attach it here instead of waiting for the
      // next full render: the countdown is the whole point, and a row that got one only on
      // the next poll would look unscheduled for that long.
      for (const [rowKey, at] of autoRetestAt) {
        const value = Number(at) || 0;
        if (value <= 0) continue;
        const cell = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"] .test-cell`);
        if (!cell) continue;
        let el = cell.querySelector('.test-retry');
        if (!el) {
          const button = cell.querySelector('.test-btn');
          if (!button) continue;
          el = document.createElement('span');
          el.className = 'test-retry';
          button.insertAdjacentElement('afterend', el);
        }
        el.setAttribute('data-retest-row', rowKey);
        el.removeAttribute('data-retest-group');
        el.setAttribute('data-retest-at', String(value));
        el.title = autoRetestTitle(rowKey);
        el.textContent = retestWaitLabel(value, now);
      }
      // The heading of a group with a waiting member carries the earliest of those waits: its
      // row may be the only Test button on screen while the group is collapsed.
      for (const group of lastMainGroups || []) {
        if (!group || !group.key) continue;
        const at = groupAutoRetestAt(group.key);
        const row = document.querySelector(`[data-row-key="g:${CSS.escape(group.key)}"]`);
        const cell = row?.querySelector('.test-cell');
        if (!cell) continue;
        let el = cell.querySelector('.test-retry');
        if (!at) {
          if (el && el.getAttribute('data-retest-group')) el.remove();
          continue;
        }
        if (!el) {
          const button = cell.querySelector('.test-btn');
          if (!button) continue;
          el = document.createElement('span');
          el.className = 'test-retry';
          button.insertAdjacentElement('afterend', el);
        }
        el.setAttribute('data-retest-group', group.key);
        el.removeAttribute('data-retest-row');
        el.setAttribute('data-retest-at', String(at));
        el.title = autoRetestTitle(groupAutoRetestRow(group.key));
        el.textContent = retestWaitLabel(at, now);
      }
      for (const el of document.querySelectorAll('.test-retry[data-retest-at]')) {
        const rowKey = el.getAttribute('data-retest-row');
        const groupKey = el.getAttribute('data-retest-group');
        if (rowKey && !autoRetestAt.has(rowKey)) { el.remove(); continue; }
        if (groupKey && !groupAutoRetestAt(groupKey)) { el.remove(); continue; }
        const at = Number(el.getAttribute('data-retest-at')) || 0;
        if (!at) { el.remove(); continue; }
        el.title = autoRetestTitle(rowKey || (groupKey ? groupAutoRetestRow(groupKey) : ''));
        el.textContent = retestWaitLabel(at, now);
      }
    }

    // Schedule a retry for every row that is only waiting on its provider.
    //
    // A benched row is by definition not routable right now, and the hull of the plot is built
    // from the rows that still are: requiring a hull entry meant no rate-limited row was ever
    // scheduled, so the clock never appeared. Rows with a plotted position go first — they are
    // the ones the router could pick the moment a test clears them — then rows with no dot yet,
    // which is exactly the state another test can fix.
    //
    // Runs after each refresh, so a row a test just proved healthy leaves the queue and a row
    // that has just fallen onto a rate limit joins it. A row is given a slot when it joins and
    // keeps it until its test starts: a refresh must never push an existing wait later, and it
    // must not let a row that has just joined jump ahead of one that has been waiting.
    function scheduleAutomaticRetests() {
      const now = Date.now();      // Used only to rank the queue: rows with both numbers a dot would need come first, rows
      // with no measurement yet after them. The plot lives in the composer now, so this reads
      // the condition itself instead of borrowing a renderer to answer it.
      const plotted = new Set(
        (allModels || [])
          .filter((m) => {
            if (!m || m.status === 'noauth') return false;
            const aa = Number(m.aa);
            const intell = Number.isFinite(aa) && aa > 0 ? aa : Number(m.intell) * 100;
            const ttft = rowTtft(m);
            const tps = rowTps(m);
            return (
              Number.isFinite(intell) && intell > 0 &&
              ttft != null && Number.isFinite(ttft) && ttft >= 0 &&
              tps != null && Number.isFinite(tps) && tps > 0
            );
          })
          .map((m) => getModelRowKey(m)),
      );
      const seen = new Set();
      const targets = [];
      for (const m of allModels) {
        if (!m || m.hasAuth === false) continue;
        if (!AUTO_RETEST_VERDICTS.has(rowVerdict(m))) continue;
        const key = getModelRowKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ key, rank: plotted.has(key) ? 0 : 1 });
      }
      targets.sort((a, b) => a.rank - b.rank);
      const keys = new Set(targets.map(t => t.key));
      for (const key of [...autoRetestAt.keys()]) {
        if (!keys.has(key)) autoRetestAt.delete(key);
      }
      // A row that has left the table altogether takes its own interval with it.
      const live = new Set(allModels.map(m => getModelRowKey(m)));
      for (const key of [...autoRetestLastAt.keys()]) {
        if (!live.has(key)) autoRetestLastAt.delete(key);
      }
      // Rows already queued keep the slot they were given and new rows join behind the last
      // one, a minute apart. A row retested inside its own interval waits that out first, so a
      // test that came back unchanged cannot bounce to the front and starve the rows behind it.
      const queued = autoRetestOrder();
      const tail = queued.length ? Number(queued[queued.length - 1][1]) || 0 : 0;
      let slotAt = Math.max(
        now,
        lastAutoRetestStartedAt + AUTO_RETEST_GAP_MS,
        tail + AUTO_RETEST_GAP_MS,
      );
      for (const { key } of targets) {
        if (autoRetestAt.has(key)) continue;
        if (now - (autoRetestLastAt.get(key) || 0) < AUTO_RETEST_INTERVAL_MS) continue;
        autoRetestAt.set(key, slotAt);
        slotAt += AUTO_RETEST_GAP_MS;
      }
      runDueAutomaticRetest(now);
    }

    // Start at most one automatic test, and only when nothing else is testing. The next
    // start is held AUTO_RETEST_GAP_MS behind this one, so a bench that all became due at
    // once is spread out instead of aimed at one provider as a burst.
    // A retry for a row whose group is collapsed. `testModelButton` needs the member row's
    // button, and that markup does not exist while the group is folded — which is the usual
    // shape of a duplicate provider. The endpoint is the one the button posts to, so the
    // server records the same attempt; the refresh then reads the verdict it produced.
    async function autoRetestRequest(model) {
      try {
        await fetch('/api/test-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: model.providerKey, modelId: model.modelId }),
          signal: AbortSignal.timeout(TEST_RESPONSE_TIMEOUT_MS),
        });
      } catch {
        // A transport failure is still an attempt: the server records what it saw, if anything,
        // and the next refresh carries that verdict.
      }
      fetchData().catch(() => {});
    }

    function runDueAutomaticRetest(now = Date.now()) {
      if (autoRetestBusy || testAllRunning) return;
      // At least a minute since the previous automatic start, whatever brought us here: the
      // ticker, a fresh snapshot, or the re-arm after the last test finished.
      if (lastAutoRetestStartedAt && now - lastAutoRetestStartedAt < AUTO_RETEST_GAP_MS) return;
      // A row freshly scheduled from a snapshot is queued from now on; nothing else gates it.
      const due = [...autoRetestAt.entries()]
        .filter(([key, at]) => at <= now && !inflightTests.has(key))
        .sort((a, b) => a[1] - b[1])
        .find(([key]) => {
          // The model must still be in the table; a stale key is dropped so it cannot hold
          // the queue. A visible button is used when there is one, but never required: a
          // collapsed group has no member row to click.
          return allModels.some(m => getModelRowKey(m) === key);
        });
      if (!due) return;
      const [rowKey] = due;
      const model = allModels.find(m => getModelRowKey(m) === rowKey);
      if (!model) { autoRetestAt.delete(rowKey); return; }
      const row = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`);
      const button = row?.querySelector('.test-btn:not([disabled])');
      autoRetestBusy = true;
      lastAutoRetestStartedAt = now;
      // The row leaves the queue as its test starts. If it is still waiting afterwards, the
      // next refresh re-queues it behind the rows that have waited longer, and its own interval
      // holds it back until that minute is up. The old code put every started row on its own
      // timer instead, which is why a row could come due while the queue was still busy.
      autoRetestAt.delete(rowKey);
      autoRetestLastAt.set(rowKey, now);
      const work = button
        ? testModelButton(button, { rowKey, providerKey: model.providerKey, modelId: model.modelId })
        : autoRetestRequest(model);
      Promise.resolve(work)
        .catch(() => {})
        .finally(() => {
          autoRetestBusy = false;
          setTimeout(() => runDueAutomaticRetest(), AUTO_RETEST_GAP_MS);
        });
    }

    function updateVisibleMetrics(model, rowKey = getModelRowKey(model)) {
      const row = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`);
      if (!row) return;
      const speedCell = row.cells[3];
      if (speedCell) speedCell.innerHTML = speedTagInner(model.verdict, rowTtft(model), rowTps(model), rowKey.startsWith('g:') ? 'ttft' : rowTtftLabel(model), rowKey === fastestRowKey, isRowUsable(model));
    }

    // Paints a Test outcome into its Response cell, for both the result and the failure path.
    //
    // A group heading owns no single answer: the click tested the best-ranked member, so that
    // member's failure stays on its own row rather than being repeated as the heading's verdict —
    // the cell names the provider that refused and points at the row that holds the detail. The
    // rule lives here rather than in one of the two paths because it has to hold for every
    // outcome: it used to be applied only to a result that arrived as a failure *with* an `ok`
    // field, so a silent answer (which the server now reports as a failure too) went down the
    // other branch and printed "Model returned no text." on the heading.
    function paintTestResult(cell, lastResponse, opts, data) {
      const members = opts && opts.members;
      const groupError = members && members.length > 1 && lastResponse && lastResponse.error
        ? lastResponse.error
        : null;
      if (!groupError) {
        cell.innerHTML = responseCellHTML(lastResponse, opts);
        return;
      }
      const failedRow = allModels.find(mm => mm.providerKey === (data && data.providerKey)
        && mm.modelId === (data && data.modelId));
      const label = failedRow?.label || (data && data.providerKey) || 'a provider';
      cell.innerHTML = `${responseCellHTML(null, opts)}<div class="test-meta" title="${escapeAttr(groupError)}">⚠︎ ${escapeHtml(label)} refused — see its row</div>`;
    }

    // Handles a Test button click: asks the model for a short answer, writes the full
    // response (or error) into the Response cell, then refreshes the table so TTFT /
    // Tok/s / Context pick up the stats recorded from it.
    async function testModelButton(btn, opts) {
      const cell = btn.closest('td');
      const rowKey = opts && opts.rowKey;
      if (testAllRunning && testAllCurrentRowKey !== rowKey) return;
      if (!cell || !rowKey || inflightTests.has(rowKey)) return;
      inflightTests.add(rowKey);
      cell.innerHTML = '<div class="test-cell"><button class="test-btn" disabled>⏳ Testing…</button></div>';
      const tr = cell.closest('tr');
      tr?.classList.add('row-testing');
      const statusCell = tr && tr.cells[1] && tr.cells[1].querySelector('.status-slot');
      if (statusCell) {
        statusCell.innerHTML = '<div style="display: flex; align-items: center; gap: 6px;"><span style="color: var(--text-muted); font-size: 0.75rem;">⏳ Testing…</span></div>';
      }
      let refreshAfterTest = false;
      try {
        const res = await fetch('/api/test-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(TEST_RESPONSE_TIMEOUT_MS),
          body: JSON.stringify(opts.members && opts.members.length > 0
            ? { members: opts.members }
            : { providerKey: opts.providerKey, modelId: opts.modelId }),
        });
        let data;
        try {
          data = await res.json();
        } catch {
          data = { ok: false, error: `HTTP ${res.status}`, status: res.status };
        }
        const lastResponse = {
          text: data.text != null ? data.text : null,
          error: data.error != null ? data.error : null,
          status: data.status != null ? data.status : (data.ok ? 200 : res.status || 0),
          at: Date.now(),
          ttftMs: data.ttftMs != null ? data.ttftMs : null,
          durationMs: data.durationMs != null ? data.durationMs : null,
          tps: data.tps != null ? data.tps : null,
          tokens: data.tokens != null ? data.tokens : null,
          expiresAt: data.expiresAt != null ? data.expiresAt : null,
          paymentRequired: data.paymentRequired === true,
          dead: data.dead === true,
          incompatible: data.incompatible === true,
          overloaded: data.overloaded === true,
          rateLimitResetAt: data.rateLimitResetAt != null ? data.rateLimitResetAt : null,
          reasoningOnly: data.reasoningOnly === true,
          truncated: data.truncated === true,
          cached: data.cached === true,
        };

        const targetProviderKey = data.providerKey || opts.providerKey;
        const targetModelId = data.modelId || opts.modelId;
        const tested = allModels.find(model => model.providerKey === targetProviderKey && model.modelId === targetModelId);
        if (tested) {
          tested.lastResponse = lastResponse;
          if (data.rateLimitResetAt != null) {
            tested.rateLimit = { ...(tested.rateLimit || {}), wasRateLimited: true, resetRequestsAt: data.rateLimitResetAt, capturedAt: Date.now() };
          }
          if (data.ok === true) {
            tested.ttft = data.ttftMs != null ? data.ttftMs : tested.ttft;
            tested.tps = data.tps != null ? data.tps : tested.tps;
            updateVisibleMetrics(tested, rowKey);
          }
        }
        paintTestResult(cell, lastResponse, opts, data);
        if (statusCell && tested) {
          statusCell.innerHTML = `<div style="display: flex; align-items: center; gap: 6px;">${statusCellHTML(tested)}</div>`;
        }
        refreshAfterTest = true;
      } catch (err) {
        const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const message = aborted
          ? `No answer within ${Math.round(TEST_RESPONSE_TIMEOUT_MS / 1000)}s. The router may still be testing this row — its result appears on the next refresh.`
          : (err?.message || 'Network error');
        const errResponse = {
          text: null,
          error: message,
          status: aborted ? 408 : 0,
          at: Date.now(),
          ttftMs: null,
          durationMs: null,
          tps: null,
          tokens: null,
        };
        const tested = allModels.find(model => model.providerKey === opts.providerKey && model.modelId === opts.modelId);
        if (tested) tested.lastResponse = errResponse;
        cell.innerHTML = responseCellHTML(errResponse, opts);
        if (statusCell && tested) {
          statusCell.innerHTML = `<div style="display: flex; align-items: center; gap: 6px;">${statusCellHTML(tested)}</div>`;
        }
      } finally {
        inflightTests.delete(rowKey);
        tr?.classList.remove('row-testing');
        if (refreshAfterTest) scheduleRefresh(); // catch up the stats a completed test recorded
      }
    }

    // State for the sequential Test All operation. The queue is deliberately client-side: the
    // server bulk endpoint knows about catalog rows, not the rows the user can see in the main
    // table, and it cannot highlight the one provider currently being tested.
    let testAllRunning = false;
    let testAllCancelRequested = false;
    let testAllCurrentRowKey = null;
    let testAllQueue = [];
    let testAllCompleted = 0;

    // The same main-table split used by render(). Unavailable rows are deliberately absent.
    function testableMainGroups() {
      const filtered = allModels.filter(m =>
        m.label.toLowerCase().includes(searchTerm) ||
        m.providerKey.toLowerCase().includes(searchTerm) ||
        (m.originLabel || '').toLowerCase().includes(searchTerm) ||
        m.modelId.toLowerCase().includes(searchTerm) ||
        (m.realModelId || '').toLowerCase().includes(searchTerm)
      );
      return splitDisplayGroups(sortedGroups(groupModels(filtered))).mainGroups;
    }

    // Test All follows the visible table order. A multi-provider heading contributes each of its
    // inactive provider rows; a single-provider heading contributes its own one row. Active rows
    // are skipped even when their previous response is stale or empty.
    function buildTestAllQueue() {
      const queue = [];
      const seen = new Set();
      for (const group of testableMainGroups()) {
        for (const model of group.members) {
          if (isRowUp(model)) continue;
          const modelKey = getModelRowKey(model);
          if (seen.has(modelKey)) continue;
          seen.add(modelKey);
          const rowKey = group.members.length === 1 ? `g:${group.key}` : modelKey;
          queue.push({ model, rowKey, modelKey, groupKey: group.key });
        }
      }
      // render() preserves the visible order while the cursor is over the table. Use that order
      // when it is available so "top to bottom" means the order the user is actually looking at.
      const visibleOrder = new Map(currentRenderedOrder.map((key, index) => [key, index]));
      if (visibleOrder.size) {
        queue.sort((a, b) => {
          const aKey = a.rowKey.startsWith('g:') ? a.rowKey : (visibleOrder.has(a.rowKey) ? a.rowKey : `g:${a.groupKey}`);
          const bKey = b.rowKey.startsWith('g:') ? b.rowKey : (visibleOrder.has(b.rowKey) ? b.rowKey : `g:${b.groupKey}`);
          return (visibleOrder.get(aKey) ?? Infinity) - (visibleOrder.get(bKey) ?? Infinity);
        });
      }
      return queue;
    }

    function setTestAllButtonState(text, background = 'var(--success)', onclick = () => testAll()) {
      const btn = document.getElementById('test-all-btn');
      if (!btn) return;
      btn.textContent = text;
      btn.style.background = background;
      btn.onclick = onclick;
      btn.style.display = 'inline-block';
    }

    function clearTestingRow(rowKey) {
      if (rowKey) {
        const row = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`);
        row?.classList.remove('row-testing');
      }
      document.querySelectorAll('tr.row-testing').forEach(row => row.classList.remove('row-testing'));
      testAllCurrentRowKey = null;
    }

    function updateTestAllButtonVisibility() {
      const btn = document.getElementById('test-all-btn');
      if (!btn || testAllRunning) return;
      btn.style.display = buildTestAllQueue().length > 0 ? 'inline-block' : 'none';
    }

    // A model heading's Test button has the same sequential fan-out as Test All, but starts with
    // that heading's inactive main-table providers. Each request is exact-provider, so a healthy
    // sibling is never selected accidentally and the visual order is preserved.
    async function testModelGroupButton(btn, opts) {
      if (testAllRunning || !opts?.members?.length) return;
      const members = opts.members
        .map(member => allModels.find(m => m.providerKey === member.providerKey && m.modelId === member.modelId))
        .filter(m => m && !isRowUp(m) && !isRowStruck(m));
      if (members.length === 0) return;
      const groupKey = opts.rowKey?.startsWith('g:') ? opts.rowKey.slice(2) : null;
      if (groupKey && collapsedModelGroups.has(groupKey)) {
        collapsedModelGroups.delete(groupKey);
        render(true);
      }
      testAllQueue = members.map(model => ({ model, rowKey: getModelRowKey(model), modelKey: getModelRowKey(model), groupKey: opts.rowKey?.startsWith('g:') ? opts.rowKey.slice(2) : null }));
      testAllCompleted = 0;
      testAllRunning = true;
      testAllCancelRequested = false;
      setTestAllButtonState('↻ Testing…', 'var(--success)', () => cancelTestAll());
      try {
        for (const item of testAllQueue) {
          if (testAllCancelRequested) break;
          const current = allModels.find(m => getModelRowKey(m) === (item.modelKey || item.rowKey));
          if (!current || isRowUp(current) || isRowStruck(current)) continue;
          await runTestAllItem(item);
        }
      } finally {
        finishTestAll(testAllCancelRequested ? 'cancelled' : 'done');
      }
    }

    async function runTestAllItem(item) {
      if (item.groupKey && collapsedModelGroups.has(item.groupKey)) {
        collapsedModelGroups.delete(item.groupKey);
        for (const group of lastMainGroups) {
          if (group.key !== item.groupKey && group.members.length > 1) collapsedModelGroups.add(group.key);
        }
        render(true);
      }
      const row = document.querySelector(`[data-row-key="${CSS.escape(item.rowKey)}"]`);
      if (!row) return false;
      testAllCurrentRowKey = item.rowKey;
      row.classList.add('row-testing');
      const button = row.querySelector('.test-btn:not([disabled])');
      if (!button) {
        clearTestingRow(item.rowKey);
        return false;
      }
      await testModelButton(button, {
        rowKey: item.rowKey,
        providerKey: item.model.providerKey,
        modelId: item.model.modelId,
      });
      testAllCompleted++;
      const btn = document.getElementById('test-all-btn');
      if (btn && testAllRunning) {
        btn.textContent = `↻ ${testAllCompleted}/${testAllQueue.length}`;
      }
      clearTestingRow(item.rowKey);
      return true;
    }

    async function testAll() {
      if (testAllRunning) return;
      testAllQueue = buildTestAllQueue();
      if (testAllQueue.length === 0) {
        updateTestAllButtonVisibility();
        return;
      }
      testAllRunning = true;
      testAllCancelRequested = false;
      testAllCompleted = 0;
      setTestAllButtonState('↻ Testing…', 'var(--success)', () => cancelTestAll());
      try {
        for (const item of testAllQueue) {
          if (testAllCancelRequested) break;
          // Revalidate against the current main-table snapshot before every request. This prevents
          // a successful test from moving into the unavailable table and still being picked up later.
          const current = testableMainGroups().flatMap(g => g.members)
            .find(m => getModelRowKey(m) === (item.modelKey || item.rowKey));
          if (!current || isRowUp(current) || isRowStruck(current)) continue;
          await runTestAllItem({ model: current, rowKey: item.rowKey, modelKey: item.modelKey, groupKey: item.groupKey });
        }
      } finally {
        finishTestAll(testAllCancelRequested ? 'cancelled' : 'done');
      }
    }

    function cancelTestAll() {
      if (!testAllRunning) return;
      testAllCancelRequested = true;
      clearTestingRow(testAllCurrentRowKey);
      setTestAllButtonState('↻ Cancelled', 'var(--text-muted)', () => testAll());
    }

    function finishTestAll(status) {
      clearTestingRow(testAllCurrentRowKey);
      testAllRunning = false;
      testAllCancelRequested = false;
      const btn = document.getElementById('test-all-btn');
      if (btn) {
        btn.textContent = status === 'cancelled' ? '↻ Cancelled' : '✓ Done';
        btn.style.background = status === 'cancelled' ? 'var(--text-muted)' : 'var(--success)';
        btn.onclick = () => testAll();
        setTimeout(() => {
          if (!testAllRunning && btn.textContent.includes('Done')) {
            btn.textContent = '↻ Test All';
            btn.style.background = 'var(--success)';
            btn.onclick = () => testAll();
          }
        }, 3000);
      }
      testAllQueue = [];
      testAllCompleted = 0;
      fetchData().catch(() => {});
      updateTestAllButtonVisibility();
    }




    // The provider's own reset header inside a JSON error body, when it names one.
    function rateLimitResetFromBody(errorText) {
      if (!errorText) return null;
      let bodyError = null;
      try {
        const parsed = JSON.parse(errorText);
        bodyError = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
      } catch {
        // The persisted error may be plain text rather than JSON.
      }
      const bodyReset = bodyError?.metadata?.headers?.['X-RateLimit-Reset']
        ?? bodyError?.metadata?.headers?.['x-ratelimit-reset']
        ?? bodyError?.headers?.['X-RateLimit-Reset']
        ?? bodyError?.headers?.['x-ratelimit-reset'];
      const parsedReset = Number(bodyReset);
      if (!Number.isFinite(parsedReset) || parsedReset <= 0) return null;
      return Math.round(parsedReset >= 1e12 ? parsedReset : parsedReset * 1000);
    }

    // The window a *test response* describes, when that response is itself the rate
    // limit statement — a 429 status, or a quota/limit body (Google's
    // RESOURCE_EXHAUSTED, "quota exceeded", Anthropic's FreeUsageLimitError, ...).
    //
    // `until` is when that claim stops being live evidence: the reset the response
    // carries, the "retry in Ns" it states, or — when the provider names no window at
    // all, which many of them refuse to do — the same short grace the server applies
    // before it clears its own flag. Returns null when the response is not a rate-limit
    // statement in the first place.
    function testRateLimitWindow(m) {
      const lr = m && m.lastResponse;
      if (!lr) return null;
      const errorText = String(lr.error || '');
      const statusIs429 = Number(lr.status) === 429;
      const textSaysLimited = RATE_LIMIT_RE.test(errorText);
      if (!statusIs429 && !textSaysLimited) return null;
      const at = Number(lr.at);
      const atMs = Number.isFinite(at) && at > 0 ? at : Date.now();
      const stated = [Number(lr.rateLimitResetAt), rateLimitResetFromBody(errorText)]
        .filter(value => Number.isFinite(value) && value > 0);
      if (stated.length > 0) {
        const resetAt = Math.max(...stated);
        return { until: resetAt, resetAt };
      }
      // Older persisted responses predate rateLimitResetAt but still carry the provider's
      // own retry delay, which names the window just as well. The delay comes in several
      // shapes and they all make the same promise: "retry in 22h2m4.9s", "retry after 58
      // seconds", and Antigravity's "Resets in 161h41m31s" — which states the window without
      // ever saying "retry", and so used to leave a rate-limited row with a bare clock.
      const statedDelay = /(?:retry|resets?|renews?)\s+(?:in|after)\s+([0-9][0-9a-z.\s]*)/i.exec(errorText);
      const delay = statedDelay ? durationFromText(statedDelay[1]) : null;
      if (delay != null) {
        const until = atMs + delay;
        return { until, resetAt: until };
      }
      return { until: atMs + RATE_LIMIT_UNSTATED_GRACE_MS, resetAt: null };
    }

    // Google scopes Antigravity's allowance per model and per account. A quota refusal from
    // one account is not a model-wide exhaustion while another signed-in account still has
    // allowance for that same model; the row carries both accounts' windows.
    function hasAlternativeAntigravityQuota(m) {
      if (String(m?.providerKey || '') !== 'google-antigravity') return false;
      const now = Date.now();
      return (Array.isArray(m.quotaWindows) ? m.quotaWindows : []).some((window) => {
        if (!window || window.unavailable) return false;
        const resetAt = Number(window.resetAt);
        if (Number.isFinite(resetAt) && resetAt > 0 && resetAt <= now) return false;
        const remaining =
          window.percentOnly && window.usedPercent != null
            ? 100 - Number(window.usedPercent)
            : Number(window.remaining);
        return Number.isFinite(remaining) && remaining > 0;
      });
    }

    // Whether a row is benched on a provider window or quota — and until when that is
    // still a live verdict. Two sources say it, and they expire differently:
    //
    //   - the server's own flags (`status: 'rate-limited'`, `isRateLimited`,
    //     `rateLimit.wasRateLimited`, exhausted credits) are cleared by its own ping
    //     cycle, so they are taken as given rather than second-guessed here;
    //   - a test response is the dashboard's evidence, so its window has to be read off
    //     the response (see testRateLimitWindow). Once that window closes, the test
    //     output is history, not a verdict: the row goes back to what its probes say,
    //     exactly as the router does with the same evidence.
    function rateLimitEvidence(m) {
      if (!m) return { limited: false, resetAt: null };
      // A verdict no window can reopen is not a window: while it is the newer statement, the row
      // does not come back when the countdown ends, so there is nothing to count down to and the
      // clock would be a claim nobody can act on. Read before the sources below, because a bench
      // the server has not yet re-derived would otherwise outlive the verdict that replaced it.
      if (permanentOutranksBench(m)) return { limited: false, resetAt: null };
      // A quota refusal from one Antigravity account is not a verdict on the model while
      // another account still has allowance. Keep the row's own down/failure evidence, but
      // do not paint the first account's reset clock across the model.
      if (
        /quota|resource_exhausted/i.test(String(m.lastResponse?.error || '')) &&
        hasAlternativeAntigravityQuota(m)
      ) {
        return { limited: false, resetAt: null };
      }
      const now = Date.now();
      const status = String(m.status || '').toLowerCase();
      // Credit exhaustion is capacity, so it lives on the quota half now; the legacy
      // rateLimit.credit* read is kept for rows persisted before the split.
      const creditExhausted = (Number(m.quota?.creditLimit) > 0
        && m.quota?.creditRemaining != null && Number(m.quota.creditRemaining) <= 0)
        || (Number(m.rateLimit?.creditLimit) > 0
        && m.rateLimit?.creditRemaining != null && Number(m.rateLimit.creditRemaining) <= 0);
      const serverSaysLimited = m.isRateLimited === true
        || status === 'rate-limited'
        || m.rateLimit?.wasRateLimited === true
        || creditExhausted;
      const window = testRateLimitWindow(m);
      const liveWindow = window && window.until > now ? window : null;
      // The window a refusal named is when the provider *might* serve again, not when the row
      // learned something newer. Until a success supersedes it (see refusalKind) the refusal
      // stands, so the cell keeps its clock — bare, with no countdown to a window that has
      // already passed — instead of dropping to 'down' when the timer hits zero.
      const standing = !liveWindow && refusalKind(m) === 'rate-limited';
      if (!serverSaysLimited && !liveWindow && !standing) return { limited: false, resetAt: null };
      // An exhausted capacity window can close later than the short retry header on the
      // same response. Token Harbor's free allowance is the live case: the body says the
      // weekly allowance returns on 17 Nov while the accompanying retry-after is one hour.
      // The row cannot reopen until the allowance does, so the longest exhausted window is
      // the clock that means something.
      const exhaustedQuotaResets = (Array.isArray(m.quotaWindows) ? m.quotaWindows : [])
        .filter((window) => {
          const resetAt = Number(window?.resetAt);
          if (!Number.isFinite(resetAt) || resetAt <= now) return false;
          if (window.usedPercent != null) return Number(window.usedPercent) >= 100;
          return window.limit != null && window.remaining != null && Number(window.remaining) <= 0;
        })
        .map((window) => Number(window.resetAt));
      const stated = [
        m.lastResponse?.rateLimitResetAt,
        rateLimitResetFromBody(String(m.lastResponse?.error || '')),
        m.rateLimit?.resetRequestsAt,
        m.rateLimit?.resetTokensAt,
        m.rateLimit?.creditResetAt,
        m.quota?.creditResetAt,
        ...exhaustedQuotaResets,
      ].map(Number).filter(value => Number.isFinite(value) && value > now);
      const statedReset = stated.length > 0 ? Math.max(...stated) : null;
      // A countdown only when something actually states when the window reopens;
      // otherwise the cell shows the bare clock rather than a clock stuck at 00:00.
      return {
        limited: true,
        resetAt: statedReset != null ? statedReset : (liveWindow ? liveWindow.resetAt : null),
      };
    }

    function isRateLimitedRow(m) {
      return rateLimitEvidence(m).limited;
    }

    // Epoch-ms reset time for the countdown, or null when the row is benched but the
    // provider withheld when the window reopens.
    function getRateLimitResetAt(m) {
      return rateLimitEvidence(m).resetAt;
    }

    // Human-ish label for a quota failure, e.g. "generate quotum: 20" ->
    // "generate content free tier requests (20)". Falls back to 'quota exceeded'.
    function quotaLabel(m) {
      // The QuotaFailure is capacity evidence; it lives on the quota half as `failure`, with
      // the legacy `rateLimit.quota` read kept for rows persisted before the split.
      const q = m?.quota?.failure || m?.rateLimit?.quota;
      if (!q) return null;
      const id = q.quotaId || q.quotaMetric;
      if (id) {
        // "GenerateRequestsPerDayPerProjectPerModel-FreeTier" -> "requests/day quota"
        const cleaned = String(id)
          .replace(/^[^.]+\//, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/-(\w)/g, ' $1')
          .replace(/Per(Project|Model|Organization|User)/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned ? `${cleaned}${q.quotaValue ? ` (${q.quotaValue})` : ''}` : 'quota exceeded';
      }
      return 'quota exceeded';
    }

    // A compact duration ("22h2m4.9s", "58 seconds", "161h41m31s") in milliseconds. The
    // providers all state a wait this way; only the wording in front of it changes.
    function durationFromText(text) {
      const unit = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
      let total = 0;
      let matched = false;
      for (const match of String(text || '').matchAll(unit)) {
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const name = match[2].toLowerCase();
        const factor = name.startsWith('ms') || name.startsWith('millisecond')
          ? 1
          : name.startsWith('d')
            ? 86_400_000
            : name.startsWith('h')
            ? 3_600_000
            : name.startsWith('m')
              ? 60_000
              : 1_000;
        total += amount * factor;
        matched = true;
      }
      return matched ? Math.round(total) : null;
    }

    // mm:ss (or h mm) countdown for a remaining ms duration.
    function formatCountdown(ms) {
      const total = Math.max(0, Math.floor(Number(ms) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // Local clock time for the tooltip, e.g. "3:45 PM".
    function formatClockTime(epochMs) {
      try {
        return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function nextUtcMidnight() {
      const d = new Date();
      d.setUTCHours(24, 0, 0, 0);
      return d.getTime();
    }

    function quotaWindowReset(window) {
      const d = new Date();
      if (window === 'month') {
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime();
      }
      if (window === 'day') return nextUtcMidnight();
      return null;
    }

    // A dot already reads as up (green) or down (red), so those two words are
    // dropped next to it and the dot carries them as a tooltip instead. The other
    // states keep their label because it says something the colour cannot — a wait on
    // the provider, a paywall, a missing credential — while an untested row is simply
    // Down and needs no word beside its red dot.
    function plainStatusLabel(kind) {
      if (kind === 'up' || kind === 'down') return '';
      // The Z stands alone: it is not a clock (no window is being waited on), and the tooltip
      // names the state. Spelling "Timeout" beside it only crowded the column.
      if (kind === 'timeout') return '';
      return kind === 'noauth' ? 'No Auth' : verdictLabel(kind);
    }

    // Title for a bare status dot, so the hidden word is still available on hover.
    function plainStatusTitle(kind) {
      // A timeout is not a window: the provider never said when (or whether) it comes back.
      // Saying so on hover is the difference between "slow right now" and "out of quota",
      // which the clock alone used to blur.
      if (kind === 'timeout') {
        return 'Timed out — the model is slow right now, not out of quota; it can answer again on its own';
      }
      return kind === 'up' ? 'Up' : verdictLabel(kind);
    }

    // The states a status cell spells out rather than leaving to a dot's colour, because
    // they say something the colour cannot. Returns the cell's inner markup, or null for
    // the ordinary up / down / no-auth rows that the dot alone describes.
    function specialStatusHTML(m, kind) {
      if (kind === 'paid') {
        return '<span class="paid-status" title="Payment required — add billing to use this model">💲 Paid</span>';
      }
      if (kind === 'incompatible') {
        // nowrap because the word cannot be broken: the cells that must fit an error string carry
        // an aggressive word-break, and "Incompa/tible" across two lines names no state at all.
        return '<span style="color: var(--text-muted); white-space: nowrap;" title="Model cannot serve text chat (image/video/audio only, or gated to another client)">Incompatible</span>';
      }
      if (kind === 'micro') {
        return `<span style="color: var(--text-muted);" title="${escapeHtml(microContextTitle(m))}">Micro</span>`;
      }
      if (kind === 'dead') {
        return `<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--error); display: inline-block; vertical-align: middle;"></span>
              <span style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase;">Dead</span>`;
      }
      if (kind === 'overloaded') {
        const resetAt = overloadedResetAt(m);
        if (resetAt != null) {
          const title = `Provider overloaded — retrying ${formatClockTime(resetAt)}`;
          return `<span class="rl-countdown" data-reset-at="${resetAt}" data-provider-key="${escapeAttr(m.providerKey || '')}" data-model-id="${escapeAttr(m.modelId || '')}" title="${escapeHtml(title)}">🕑 ${formatCountdown(resetAt - Date.now())}</span>`;
        }
        return `<span style="color: var(--warning);" title="Provider overloaded — temporarily turning requests away; the model comes back on its own">🕑</span>`;
      }
      if (kind === 'rate-limited') {
        const quota = quotaLabel(m);
        const resetAt = getRateLimitResetAt(m);
        if (resetAt != null) {
          const title = `Rate limited — ${quota ? `${quota} — ` : ''}resets ${formatClockTime(resetAt)}`;
          return `<span class="rl-countdown" data-reset-at="${resetAt}" data-provider-key="${escapeAttr(m.providerKey || '')}" data-model-id="${escapeAttr(m.modelId || '')}" title="${escapeHtml(title)}">🕑 ${formatCountdown(resetAt - Date.now())}</span>`;
        }
        const title = `Rate limited${quota ? ` — ${quota}` : ''} — the model returns when the provider's window resets`;
        return `<span style="color: var(--warning);" title="${escapeHtml(title)}">🕑</span>`;
      }
      return null;
    }

    // Why a row is not the one answering, said in the cell that already carries the row's own
    // verdict. Those are two different questions: a provider the outage ledger has benched leaves
    // the model's probe verdict alone — the model may well be fine — while requests go elsewhere
    // until it answers again (see providerBenched / providerOutage in /api/models).
    function providerOutageTitle(m) {
      const outage = m && m.providerOutage;
      if (!m || m.providerBenched !== true || !outage) return '';
      const parts = [`Provider outage - ${Number(outage.consecutive) || 0} failed attempts`];
      const models = Number(outage.distinctModels) || 0;
      if (models > 0) parts.push(`across ${models} model${models === 1 ? '' : 's'}`);
      const until = Number(outage.until);
      if (Number.isFinite(until) && until > 0) parts.push(`retrying ${formatClockTime(until)}`);
      if (outage.reason) parts.push(String(outage.reason));
      return parts.join(' · ');
    }

    // Builds the status cell from the row's one verdict: the special states spelled out,
    // otherwise the indicator plus a label for the kinds whose colour is not the whole
    // story. Every render path calls this, so the cell cannot drift between them.
    function statusCellHTML(m) {
      const kind = rowVerdict(m);
      const special = specialStatusHTML(m, kind);
      const label = plainStatusLabel(kind);
      // A green dot hides the answer that earned it. The Response cell stopped printing
      // successful text (see responseCellHTML), so the tooltip is where the words live now —
      // shown only while the answer is still this row's verdict.
      const answer = kind === 'up' ? readyAnswerText(m) : '';
      const inner = special != null
        ? special
        : `${verdictIndicatorHTML(kind, answer ? `Up — ${answer}` : plainStatusTitle(kind))}${label ? `<span style="font-size: 0.75rem; font-weight: 500; text-transform: capitalize;">${escapeHtml(label)}</span>` : ''}`;
      const outageTitle = providerOutageTitle(m);
      return `
            <div style="display: flex; align-items: center; gap: 6px;"${outageTitle ? ` title="${escapeAttr(outageTitle)}"` : ''}>
              ${inner}
            </div>`;
    }

    // Runs once per second: ticks rate-limit countdowns, restores plain status on
    // rate-limit expiry, and clears timeout errors once their window has passed.
    function updateRateLimitCountdowns() {
      const now = Date.now();
      // One pass over the model table, not one scan per clock: the lookups below used to re-scan
      // every model for every countdown on screen, which is where a page holding dozens of
      // rate-limited rows spent a large share of its per-second budget.
      const byRowKey = new Map();
      for (const m of allModels) byRowKey.set(getModelRowKey(m), m);
      const modelFor = el => byRowKey.get(getModelRowKey(el.dataset.providerKey, el.dataset.modelId)) || null;
      // Clear timeout errors once their expiry has passed, leaving just the Test button
      document.querySelectorAll('.test-response[data-expires-at]').forEach(el => {
        const exp = Number(el.dataset.expiresAt || 0);
        if (exp > 0 && now > exp) {
          const cell = el.closest('.test-cell');
          if (cell) {
            const meta = cell.querySelector('.test-meta');
            if (meta) meta.remove();
            el.remove();
          }
        }
      });
      document.querySelectorAll('.rl-countdown').forEach(el => {
        const resetAt = Number(el.dataset.resetAt || 0);
        const remaining = resetAt - now;
        if (remaining > 0) {
          el.textContent = '🕑 ' + formatCountdown(remaining);
          const model = modelFor(el);
          const kind = model ? rowVerdict(model) : 'rate-limited';
          const prefix = kind === 'overloaded'
            ? 'Provider overloaded — retrying'
            : 'Rate limited — resets';
          el.title = `${prefix} ${formatClockTime(resetAt)}`;
          return;
        }
        // The window closed. Re-render the whole cell through statusCellHTML rather than
        // painting the status word stashed at render time: that stash is the raw status,
        // so every expiring countdown turned a rate-limited row into a bare 'rate-limited'
        // next to a red dot — reading as broken rather than as waiting on a provider
        // window, and disagreeing with the rows whose reset time was already gone. One
        // formatter decides what a status cell says, here as everywhere else.
        const model = modelFor(el);
        // The status lives in the Model cell beside the name, so the slot — not the td — is
        // what gets repainted; a bare td would take the model's name with it.
        const cell = el.closest('.status-slot') || el.closest('td');
        if (cell && model) {
          cell.innerHTML = `<div style="display:flex;align-items:center; gap:6px;">${statusCellHTML(model)}</div>`;
        } else {
          el.remove();
        }
      });
    }
    // rowVerdict is partly time-dependent: a ready response or provider window can expire
    // without any API snapshot changing, so the countdowns are re-read once a second.
    setInterval(updateRateLimitCountdowns, 1000);
    // The retry clock is both a readout and a trigger: a row whose countdown runs out is
    // tested here even if no refresh happens to arrive at that moment.
    setInterval(() => {
      updateAutoRetestNotes();
      runDueAutomaticRetest();
    }, 1000);
    setInterval(updatePoolBarCountdowns, 1000);

    // Why a row is Micro, in the provider's own words. The API only marks a row micro
    // for an exact, evidence-backed provider-stated limit, so this can name the evidence
    // instead of asserting a bare "bounded at ≤16k by provider errors".
    function microContextTitle(m) {
      const parts = [m.context
        ? `Context window bounded at ${m.context} by a limit the provider stated`
        : 'Context window bounded at ≤16k by a limit the provider stated'];
      const at = m.contextEvidence && Number(m.contextEvidence.at);
      if (Number.isFinite(at) && at > 0) parts.push(`observed ${new Date(at).toLocaleString()}`);
      const snippet = m.contextEvidence && typeof m.contextEvidence.text === 'string' ? m.contextEvidence.text.trim() : '';
      if (snippet) parts.push(`from: “${snippet.slice(0, 180)}”`);
      return parts.join(' — ');
    }

    // Rows whose model is paid-walled, dead, incompatible, micro-context-bounded,
    // or missing authentication get every cell struck through in Unavailable. The set
    // comes from the row verdict, so the strike-through and the status indicator name
    // the same cause by construction instead of by two hand-synced condition lists.
    function isRowStruck(m) {
      return STRUCK_VERDICTS.has(rowVerdict(m));
    }

    // The single reason a provider row is unavailable, for the graveyard's Status cell —
    // the same verdict the strike-through is drawn from.
    function unavailableReasonLabel(m) {
      const kind = rowVerdict(m);
      if (STRUCK_VERDICTS.has(kind) || kind === 'banned' || kind === 'excluded') return verdictLabel(kind);
      return 'Unavailable';
    }

    // ---- A provider's model counts ------------------------------------------------------------
    //
    // Two numbers per provider card, both read from the one verdict the table's dots are painted
    // with (rowVerdict), so a card can never advertise a model the row beside it shows as struck.
    //
    //   live  — a row that can serve a request right now
    //   total — live plus the rows waiting on a provider window (a quota or an overload)
    //
    // A dead, paid, incompatible, micro-context or unauthenticated model is in neither count: it
    // is not serving and no amount of waiting changes that, which is exactly why the graveyard
    // holds it and the main table does not. 'timeout' is excluded for the same reason a clock is
    // not drawn for it (see BENCHED_VERDICTS): it names no window that reopens.
    function providerModelCounts(providerKey) {
      const key = String(providerKey || '');
      if (!key) return { live: 0, total: 0 };
      let live = 0;
      let waiting = 0;
      for (const m of allModels) {
        if (!m || m.providerKey !== key) continue;
        const kind = rowVerdict(m);
        if (kind === 'up') live += 1;
        else if (QUOTA_WAIT_VERDICTS.has(kind)) waiting += 1;
      }
      return { live, total: live + waiting };
    }

    // Split display groups into the main table (usable rows only) and the
    // graveyard (paid / dead / incompatible / micro / no-auth rows). A struck row — paid
    // above all — never appears in the main table, even inside a group that also
    // has usable providers; it is moved to the graveyard instead.
    // The graveyard is deliberately NOT grouped by model: collapsing a model's
    // providers into one row would hide which provider is paid, dead or missing
    // auth, so every struck provider becomes its own single-member group and shows
    // its own reason. Each entry gets the member's row key so the rows stay unique.
    function splitDisplayGroups(allGroups) {
      const mainGroups = [];
      const graveyardGroups = [];
      for (const g of allGroups) {
        const usable = g.members.filter(m => !isRowStruck(m));
        const struck = g.members.filter(m => isRowStruck(m));
        if (usable.length > 0) mainGroups.push({ ...g, members: usable });
        for (const m of struck) {
          graveyardGroups.push({ ...g, key: getModelRowKey(m), members: [m] });
        }
      }
      return { mainGroups, graveyardGroups };
    }

    // Renders the graveyard table: one row per unavailable provider (ungrouped, see
    // splitDisplayGroups). Auto-hides the entire <details> panel when there's nothing
    // to show.
    function renderGraveyard(groups) {
      const details = document.getElementById('graveyard-details');
      const tbody = document.getElementById('graveyard-body');
      const summary = document.getElementById('graveyard-summary');

      // The panel starts collapsed and its rows cost more to build than the whole main
      // table, so they are built when it is opened instead (see the toggle listener
      // below). Until then only the always-visible summary count is refreshed.
      pendingGraveyardGroups = groups;

      if (!groups.length) {
        details.style.display = 'none';
        graveyardCurrentOrder = [];
        return;
      }

      details.style.display = '';
      const totalModels = groups.reduce((sum, g) => sum + g.members.length, 0);
      summary.textContent = `Unavailable models (${totalModels})`;
      if (!details.open) return;

      const orderKeys = groups.map(g => 'gv:' + g.key);

      // Fast path: same order, update in place
      const currentRows = Array.from(tbody.rows);
      if (currentRows.length === groups.length &&
          currentRows.every((row, i) => row.dataset.rowKey === orderKeys[i])) {
        for (let i = 0; i < groups.length; i++) {
          setGraveyardRowHtml(currentRows[i], groups[i]);
        }
        graveyardCurrentOrder = orderKeys;
        return;
      }

      // Reconcile: reuse existing rows, drop/insert as needed
      const existing = new Map();
      for (const row of currentRows) existing.set(row.dataset.rowKey, row);
      const removed = new Set(existing.keys());
      let anchor = null;
      for (let i = 0; i < groups.length; i++) {
        const key = orderKeys[i];
        const g = groups[i];
        let row = existing.get(key);
        if (row) {
          setGraveyardRowHtml(row, g);
          removed.delete(key);
        } else {
          row = document.createElement('tr');
          row.className = 'row-struck';
          row.dataset.rowKey = key;
          setGraveyardRowHtml(row, g);
        }
        if (anchor === null) {
          if (tbody.firstChild !== row) tbody.insertBefore(row, tbody.firstChild);
        } else if (anchor.nextSibling !== row) {
          tbody.insertBefore(row, anchor.nextSibling);
        }
        anchor = row;
      }
      for (const key of removed) {
        const row = existing.get(key);
        if (row && row.parentNode === tbody) row.remove();
      }
      graveyardCurrentOrder = orderKeys;
    }

    // Writes one graveyard row. The name cell takes no click handler.
    function setGraveyardRowHtml(row, g) {
      row.innerHTML = graveyardRowHTMLInner(g);
    }

    // Opening the panel builds the rows that renderGraveyard skipped while it was closed.
    document.getElementById('graveyard-details').addEventListener('toggle', (event) => {
      if (event.target.open) renderGraveyard(pendingGraveyardGroups);
    });

    // One unavailable provider row. It keeps its own nine cells — the main table has one more,
    // the logo — and the Status cell names this one provider's reason instead of counting
    // reasons across a model's providers.
    function graveyardRowHTMLInner(g) {
      const members = g.members;
      const first = members[0];
      // Graveyard rows keep their own history: they are struck by definition, so
      // "usable only" would blank every measured cell the panel exists to show.
      const s = getGroupSummary(g, { onlyUsable: false });
      // nowrap on the cell below: the reason is a single word, and the td's own word-break (there
      // for long error strings) split "Incompatible" into "Incompa/tible" across two lines.
      const statusText = unavailableReasonLabel(first);
      const hasAuth = members.some(m => m.status !== 'noauth');

      const lastResponse = groupLastResponse(members, { allowStale: true });

      return `
          <td>
            <div style="font-weight: 700; font-size: 0.92rem; display:flex; align-items:center; gap:8px;">
              <span title="${escapeHtml(cleanHeadingModelName(g.label))}">${escapeHtml(cleanHeadingModelName(g.label))}</span>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(providerInstanceName(first))}</div>
          </td>
          <td><div style="font-weight: 600;">${getBenchmarkTableDisplayValue(s.bestIntellMember.intell, s.bestIntellMember.qualitySource, s.bestIntellMember.qualityDetail, s.bestIntellMember.aa, s.bestIntellMember.intelBand)}</div></td>
          ${formatTtftCell(s.minTtft, 'ttft')}
          ${formatTpsCell(s.maxTps, 'tok/s')}
          <td></td>
          ${quotaRowCell(first)}
          ${rateLimitGroupCell(g)}
          <td>
            <div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${s.bestCtxMember && s.bestCtxMember.contextSource === 'observed' ? 'Bounds inferred from real requests' : (s.bestCtxMember && s.bestCtxMember.context ? 'Known context window' : 'Largest context window among providers')}">${s.bestCtxMember && s.bestCtxMember.context ? escapeHtml(s.bestCtxMember.context) : '<span style="font-size:0.75rem;color:var(--text-muted);">—</span>'}</div>
          </td>
          <td><div style="font-size:0.75rem;font-weight:600;white-space:nowrap;">${escapeHtml(statusText)}</div></td>
          <td>${hasAuth
            ? responseCellHTML(lastResponse, { rowKey: getModelRowKey(first), providerKey: first.providerKey, modelId: first.modelId, hasAuth: true, status: first.status })
            : '<div class="test-cell"></div>'}</td>`;
    }

    function createRow(m) {
      const tr = document.createElement('tr');
      tr.dataset.rowType = 'row';
      tr.dataset.rowKey = getModelRowKey(m);
      tr.style.opacity = m.status === 'excluded' || m.status === 'banned' ? '0.5' : '1';
      tr.classList.toggle('row-struck', isRowStruck(m));
      tr.classList.toggle('row-not-up', !isRowUp(m));

      const isPinnedRow = isExactPinnedRow(m);
      tr.classList.toggle('row-best', isCurrentBestRow(m));
      const rowKey = getModelRowKey(m);
      tr.innerHTML = `
          <!-- The model's mark belongs to the group heading above; a provider row repeats
               neither it nor the model's name. -->
          <td class="model-logo-cell"></td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-weight: 600;" title="${escapeHtml(providerRowLabel(m))}">${escapeHtml(providerRowLabel(m))}</span>
              <span class="status-slot">${statusCellHTML(m)}</span>
              <button type="button" class="pin-row-btn ${isPinnedRow ? 'pinned' : ''}" data-pin-model="${escapeAttr(m.modelId)}" data-pin-provider="${escapeAttr(m.providerKey)}" title="${isPinnedRow ? 'Unpin exact provider row' : 'Pin exact provider row'}">📌</button>
            </div>
            <div class="provider-subtext" title="${escapeHtml(m.modelId)}${m.realModelId && m.realModelId !== m.modelId ? ' &#8594; ' + escapeHtml(m.realModelId) : ''}">${escapeHtml(m.modelId)}${m.realModelId && m.realModelId !== m.modelId ? ` <span style="opacity:0.7;">&#8594; ${escapeHtml(m.realModelId)}</span>` : ''}</div>
          </td>
          <td><div style="font-weight: 600;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div></td>
          ${speedTagCell(m.verdict, rowTtft(m), rowTps(m), rowTtftLabel(m), getModelRowKey(m) === fastestRowKey, isRowUsable(m))}
          <td id="usage-cell-${rowKey}" class="usage-sparkline-cell"></td>
          ${quotaRowCell(m)}
          ${rateLimitCell(m)}
          <td>
            <div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${m.contextSource === 'observed' ? 'Bounds inferred from real requests' : (m.context ? 'Known context window' : 'No context data yet — will fill in as the model is used')}">${m.context ? escapeHtml(m.context) : '<span style="font-size:0.75rem;color:var(--text-muted);">—</span>'}</div>
          </td>
          <td>${responseCellHTML(m.lastResponse, { rowKey: getModelRowKey(m), providerKey: m.providerKey, modelId: m.modelId, hasAuth: m.status !== 'noauth', status: m.status })}</td>
        `;
      bindPinButton(tr.querySelector('.pin-row-btn'), {
        modelId: m.modelId,
        providerKey: m.providerKey,
        pinned: isPinnedRow,
      });
      // The usage cell is filled here rather than by id, because the row is not in the
      // document yet: getElementById cannot see it until reconcileTable attaches it.
      drawUsageSparklineInto(tr.cells[4], rowKey);
      return tr;
    }

    function getQosDisplayValue(qos) {
      const n = Number(qos);
      if (!Number.isFinite(n)) return 0;
      return Math.round(n);
    }

    function getQosColor(qos) {
      const n = Number(qos);
      if (!Number.isFinite(n)) return 'var(--error)';
      if (n >= 45) return '#2563eb';
      if (n >= 40) return '#60a5fa';
      if (n >= 20) return 'var(--warning)';
      return 'var(--error)';
    }

    function getBenchmarkSortValue(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n;
    }

    function getQualitySourceDisplay(source) {
      switch (source) {
        case 'lmarena-overall': return { short: 'Elo*', label: 'LMArena overall Elo, AA-interpolated' };
        case 'lmarena-coding': return { short: 'Code*', label: 'LMArena coding Elo, AA-interpolated' };
        case 'artificial-analysis': return { short: 'AA', label: 'Artificial Analysis Intelligence Index' };
        case 'benchmarklist-aa-index': return { short: 'BL-AA', label: 'Benchmarklist-hosted Artificial Analysis Intelligence Index' };
        case 'design-arena': return { short: 'Arena*', label: 'Design Arena Elo, AA-interpolated' };
        case 'coding-index': return { short: 'Code*', label: "AA coding index, projected onto the intelligence scale" };
        case 'agentic-index': return { short: 'Agent*', label: "AA agentic index, projected onto the intelligence scale" };
        case 'combined-estimate': return { short: 'Est*', label: 'Combined estimate from several benchmarklist measurements' };
        case 'scicode': return { short: 'SciC*', label: 'SciCode benchmark, AA-calibrated' };
        case 'vals_terminal_bench_2_1': return { short: 'TB2.1*', label: 'VALS Terminal-Bench 2.1, AA-calibrated' };
        case 'swe_marathon': return { short: 'SWE-M*', label: 'SWE-Marathon benchmark, AA-calibrated' };
        case 'kernelbench_cuda': return { short: 'KB*', label: 'KernelBench CUDA, AA-calibrated' };
        case 'frontierswe': return { short: 'FSWE*', label: 'FrontierSWE benchmark, AA-calibrated' };
        case 'vals_vibe_code': return { short: 'Vibe*', label: 'VALS Vibe Code, AA-calibrated' };
        case 'vals_swebench': return { short: 'SBV*', label: 'VALS SWE-bench Verified, AA-calibrated' };
        case 'deepswe_1_1': return { short: 'DSWE*', label: 'DeepSWE 1.1, AA-calibrated' };
        case 'vals_lcb': return { short: 'LCB*', label: 'VALS LiveCodeBench, AA-calibrated' };
        case 'vals_code_migration': return { short: 'Mig*', label: 'VALS Code Migration, AA-calibrated' };
        case 'vals_vals_index': return { short: 'VALS*', label: 'VALS Index, AA-calibrated' };
        case 'vals_vals_multimodal_index': return { short: 'VMM*', label: 'VALS Multimodal Index, AA-calibrated' };
        case 'frontiercode': return { short: 'FC*', label: 'FrontierCode benchmark, AA-calibrated' };
        case 'swe_bench_pro': return { short: 'SBP*', label: 'SWE-bench Pro, AA-calibrated' };
        case 'openai_swe_bench_verified': return { short: 'SBV*', label: 'SWE-bench Verified, AA-calibrated' };
        case 'unscored': return { short: '', label: 'No benchmarklist intelligence evidence for this model' };
        default: return { short: 'Estimate*', label: 'Estimated intelligence score' };
      }
    }

    // Every row displays one number: the Artificial Analysis Intelligence Index.
    // Benchmarklist measurements are projected onto the AA index scale and marked as
    // estimates. A model benchmarklist does not cover shows a dash, never a guess.
    // The Intelligence column's tag: the band the printed rating falls in, in the same pill
    // vocabulary as the Speed column's verdict. The band is the server's `intelBand`
    // (intelligenceBandForAa in lib/utils.js), carried on the row, so the table cannot band a
    // number differently from the API that ships it.
    const INTEL_BAND_CLASSES = {
      'genius': 'genius',
      'very smart': 'very-smart',
      'smart': 'smart',
      'normal': 'normal',
      'dumb': 'dumb',
      'very dumb': 'very-dumb',
    };

    function intelTagClass(band) {
      return INTEL_BAND_CLASSES[String(band || '').trim().toLowerCase()] || '';
    }

    // The tag names the band; the index it was banded from rides in the tooltip, the way the
    // Speed column keeps its ttft and tok/s out of the cell. An estimate keeps its asterisk —
    // the number moved out of the cell, not the reason to distrust it.
    function intelTagHTML(band, title, estimated = false) {
      const cls = intelTagClass(band);
      if (!cls) return '';
      const label = String(band).trim();
      return `<span class="onboard-pill intel-tag intel-${cls}" title="${escapeAttr(title)}">${escapeHtml(label)}${estimated ? '<span class="pill-estimate">*</span>' : ''}</span>`;
    }

    // The hover text a rating wears: the band, the index it was banded from, whether that index
    // is an estimate, and the evidence behind it. Shared with the Smartest badge, which stands
    // where the band tag would have been and must still answer "how smart is it?".
    function intelRatingTitle(band, aa, source, detail = '') {
      const sourceDisplay = getQualitySourceDisplay(source);
      // The evidence line usually opens with the source's own name, and the tooltip is now the
      // only place it is read: name it once rather than twice in a row.
      const detailText = String(detail || '').trim();
      const sourceTitle = !detailText
        ? sourceDisplay.label
        : detailText.toLowerCase().startsWith(sourceDisplay.label.toLowerCase())
          ? detailText
          : `${sourceDisplay.label} — ${detailText}`;
      const n = Number(aa);
      const shown =
        Number.isFinite(n) && n > 0 ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : null;
      const estimated = !(
        source === 'artificial-analysis' || source === 'benchmarklist-aa-index'
      );
      const cls = intelTagClass(band);
      if (!shown || !cls) return { title: null, shown, estimated, cls, sourceTitle };
      const parts = [`${String(band).trim()} intelligence`, `AA index ${shown}`];
      if (estimated) parts.push('estimate');
      parts.push(sourceTitle);
      return { title: parts.join(' · '), shown, estimated, cls, sourceTitle };
    }

    // ' · Very Smart intelligence · AA index 51 · …' for a badge that has displaced the band
    // tag, or '' for a model with no band to carry.
    function intelBandTitleSuffix(member) {
      const { title } = intelRatingTitle(
        member?.intelBand,
        member?.aa,
        member?.qualitySource,
        member?.qualityDetail,
      );
      return title ? ` · ${title}` : '';
    }

    // The column prints the band, not the number: the index is in the tag's tooltip, beside the
    // source it came from. A rating with no band keeps the muted dash it had before the bands
    // existed — an unmeasured model is not a dumb one, and a bare number is what this replaced.
    function getBenchmarkDisplayValue(value, source, detail = '', aa = null, band = null) {
      const { title, estimated, sourceTitle } = intelRatingTitle(band, aa, source, detail);
      if (title) return intelTagHTML(band, title, estimated);
      const score = Number(value);
      const local = Number.isFinite(score) && score > 0 ? ` — local score ${Math.round(score * 100)}` : '';
      return `<span style="font-size:0.75rem;color:var(--text-muted);" title="${escapeAttr(`${sourceTitle}${local}`)}">—</span>`;
    }

    function getBenchmarkTableDisplayValue(value, source, detail = '', aa = null, band = null) {
      return getBenchmarkDisplayValue(value, source, detail, aa, band);
    }

    function renderLoggingSettings(logging) {
      const container = document.getElementById('logging-container');
      if (!container) return;
      const logContent = logging.logRequestContent !== false;
      const persistLogs = logging.persistRequestLogs !== false;
      container.innerHTML = `
        <div class="autoupdate-panel">
          <div class="autoupdate-header">
            <div>
              <h3 class="autoupdate-title">Content Capture &amp; Persistence</h3>
              <div class="autoupdate-subtitle">"Capture content" stores full prompts/responses; "Persist to disk" writes them to ~/.hammer-logs.json.</div>
            </div>
            <span class="autoupdate-status-pill ${(logContent && persistLogs) ? 'on' : 'off'}">${(logContent && persistLogs) ? 'Full' : 'Limited'}</span>
          </div>
          <div class="autoupdate-controls">
            <label class="autoupdate-toggle-label">
              <input type="checkbox" id="logging-content" ${logContent ? 'checked' : ''}>
              Capture prompt/response content
            </label>
            <label class="autoupdate-toggle-label">
              <input type="checkbox" id="logging-persist" ${persistLogs ? 'checked' : ''}>
              Persist request logs to disk
            </label>
            <button class="btn" onclick="saveLoggingSettings()">Save Changes</button>
            <span id="logging-save-status" class="autoupdate-save-status"></span>
          </div>
        </div>
      `;
    }

    async function saveLoggingSettings() {
      const logRequestContent = document.getElementById('logging-content').checked;
      const persistRequestLogs = document.getElementById('logging-persist').checked;
      const statusEl = document.getElementById('logging-save-status');
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logRequestContent, persistRequestLogs }),
        });
        if (!res.ok) throw new Error('Failed to save.');
        statusEl.textContent = 'Saved!';
        statusEl.style.color = 'var(--success)';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
      } catch (err) {
        statusEl.textContent = err.message || 'Failed to save.';
        statusEl.style.color = 'var(--error)';
      }
    }

    async function refreshAllProviders() {
      const btn = document.getElementById('refresh-all-btn');
      const statusEl = document.getElementById('refresh-all-status');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = '0.6';
      statusEl.textContent = 'Refreshing all providers...';

      try {
        const res = await fetch('/api/providers/refresh-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Refresh failed.');

        const succeeded = data.providers.filter(p => p.success).length;
        const failed = data.providers.filter(p => !p.success).length;
        const parts = [];
        if (succeeded > 0) parts.push(`${succeeded} succeeded`);
        if (failed > 0) parts.push(`${failed} failed`);
        statusEl.textContent = parts.join(', ') + '.';
        statusEl.style.color = failed > 0 ? 'var(--warning)' : 'var(--success)';

        await fetchData();
        await loadSettings();
      } catch (err) {
        statusEl.textContent = err.message || 'Refresh failed.';
        statusEl.style.color = 'var(--error)';
      } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
        setTimeout(() => { statusEl.textContent = ''; }, 5000);
      }
    }

    function closeProviderSyncModal() {
      const overlay = document.getElementById('provider-sync-overlay');
      const modal = document.getElementById('provider-sync-modal');
      if (overlay) overlay.style.display = 'none';
      if (modal) modal.style.display = 'none';
    }

    function openProviderSyncModal(title, subtitle, bodyHtml) {
      const overlay = document.getElementById('provider-sync-overlay');
      const modal = document.getElementById('provider-sync-modal');
      const titleEl = document.getElementById('provider-sync-title');
      const subtitleEl = document.getElementById('provider-sync-subtitle');
      const bodyEl = document.getElementById('provider-sync-body');
      if (!overlay || !modal || !titleEl || !subtitleEl || !bodyEl) return;
      titleEl.textContent = title;
      subtitleEl.textContent = subtitle || '';
      bodyEl.innerHTML = bodyHtml || '';
      overlay.style.display = 'block';
      modal.style.display = 'block';
    }

    function formatSyncScore(model) {
      if (typeof model?.intell !== 'number' || !Number.isFinite(model.intell)) return 'Unknown';
      const aa = Number(model.aa);
      const shown = Number.isFinite(aa) && aa > 0 ? (Number.isInteger(aa) ? aa : aa.toFixed(1)) : Math.round(model.intell * 100);
      return `${shown} (${getQualitySourceDisplay(model.qualitySource).label})`;
    }

    function formatContextDisplay(value) {
      if (value == null || value === '' || value === '—') return 'N/A';
      const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
      if (!match) return String(value);
      const number = Number(match[1]);
      const tokens = number * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1);
      if (!Number.isFinite(tokens) || tokens <= 0) return 'N/A';
      if (tokens >= 1_000_000) {
        const millions = tokens / 1_000_000;
        return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
      }
      if (tokens >= 1_000) {
        const thousands = tokens / 1_000;
        return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}K`;
      }
      return String(Math.round(tokens));
    }

    // A refresh that returns nothing is not one outcome. Five situations all arrive as an empty
    // list — never probed, a missing URL setting, no credential, upstream failed, upstream listed
    // nothing usable — and the user's next move is different in each. The server names the one it
    // hit (see `modelDiscovery` on /api/config), so the modal says which instead of "no models".
    function discoveryEmptyExplanation(modelDiscovery) {
      if (!modelDiscovery) {
        return 'This provider\'s model list has not been read yet. A provider refresh, or a request that uses one of its models, reads it.';
      }
      if (modelDiscovery.state === 'ok') {
        return `The last check read ${modelDiscovery.modelCount ?? 0} model(s), but none are in the table. Refresh again to reload them.`;
      }
      const lead = {
        'needs-config': 'Cannot read this list: ',
        'needs-key': 'Cannot read this list: ',
        'disabled': 'Not checked: ',
        'empty': 'Nothing servable as chat: ',
        'unavailable': 'No model list to read: ',
        'failed': 'The refresh failed: ',
      }[modelDiscovery.state] || 'Model list unavailable: ';
      return `${lead}${modelDiscovery.note || 'no reason recorded'}`;
    }

    function renderProviderSyncSuccess(providerName, models, modelDiscovery) {
      const count = models.length;
      const items = models
        .slice()
        .sort((a, b) => (a.label || a.modelId || '').localeCompare(b.label || b.modelId || ''))
        .map(model => `<li><b>${escapeHtml(model.label || model.modelId)}</b><br><span style="color:var(--text-muted);">${escapeHtml(model.modelId)} • ${escapeHtml(formatContextDisplay(model.ctx))} • Coding ${escapeHtml(formatSyncScore(model))}</span></li>`)
        .join('');

      openProviderSyncModal(
        `${providerName} Model Sync`,
        `${count} model${count === 1 ? '' : 's'} returned`,
        count > 0
          ? `<ol class="sync-result-list">${items}</ol>`
          : `<div style="font-size:0.84rem; color:var(--text-muted);">${escapeHtml(discoveryEmptyExplanation(modelDiscovery))}</div>`
      );
    }

    /**
     * What a "0 models" card means, in the card itself.
     *
     * Imported providers are discovered on demand, so an unread list is normal and self-healing
     * — but it used to render exactly like "this provider serves nothing", which is why a fleet of
     * imports looked broken. The server's per-provider reason (see `modelDiscovery` on
     * /api/config) turns that into either a wait, a setting to fill in, or a key to add.
     */
    function discoveryStateHtml(p, modelCount) {
      if (modelCount > 0) return '';
      const box = (bg, border, color) => `margin:0 0 10px 0; padding:10px 12px; border-radius:8px; font-size:0.78rem; line-height:1.45; background:${bg}; border:1px solid ${border}; color:${color};`;
      const d = p.modelDiscovery || null;
      if (!d) {
        return `<div style="${box('var(--input-bg-alt)', 'var(--border)', 'var(--text-muted)')}">No models read yet. This provider's list is fetched when something needs it, or when the button above is pressed.</div>`;
      }
      if (d.state === 'ok') {
        return `<div style="${box('var(--status-info-bg)', 'var(--status-info-border)', 'var(--status-info-text)')}">Last check returned ${escapeHtml(String(d.modelCount ?? 0))} model(s), none of which are in the table. Refresh to reload them.</div>`;
      }
      const waiting = d.state === 'needs-config' || d.state === 'needs-key' || d.state === 'disabled';
      const bg = waiting ? 'var(--status-warning-bg)' : 'var(--status-error-bg)';
      const border = waiting ? 'var(--status-warning-border)' : 'var(--status-error-border)';
      const color = waiting ? 'var(--status-warning-text)' : 'var(--status-error-text)';
      const lead = {
        'needs-config': 'Cannot read this provider\'s model list: ',
        'needs-key': 'Cannot read this provider\'s model list: ',
        'disabled': 'Nothing was checked: ',
        'empty': 'This provider listed no servable chat models: ',
        'unavailable': 'No model list to read: ',
        'failed': 'The last model-list refresh failed: ',
      }[d.state] || 'Model list unavailable: ';
      return `<div style="${box(bg, border, color)}">${escapeHtml(lead + (d.note || 'no reason recorded'))}</div>`;
    }

    /**
     * Inputs for a templated endpoint's extra fields — Cloudflare's account id, Vertex's project
     * and region. They are not secrets, but they are embedded in the provider's URL, so without
     * them the provider is wired and unprobeable: its models can never be listed and the card
     * shows an empty table for a reason no other screen explained.
     *
     * A Cloudflare account id is per *account*, and a second key belongs to a second account, so
     * the account id is drawn as a list with one input per entry — the nth input pairs with the
     * nth key in the pool. One account id with several keys is still legitimate (the keys all
     * belong to that one account), so the list is allowed to be shorter than the key pool.
     */
    function credentialFieldsHtml(p) {
      const fields = Array.isArray(p.requiredCredentialFields) ? p.requiredCredentialFields : [];
      if (fields.length === 0) return '';
      const missing = new Set(Array.isArray(p.missingCredentialFields) ? p.missingCredentialFields : []);
      const values = p.credentialFieldValues || {};
      const poolSize = Array.isArray(p.apiKeyPool) ? p.apiKeyPool.length : 0;
      const rows = fields.map(field => {
        const shown = values[field];
        const fromEnv = shown === 'from-environment';
        // A list is only rendered as one when there is a pool to line it up against;
        // otherwise it stays a single input rather than an unexplained set of blanks.
        const isList = Array.isArray(shown) && (shown.length > 1 || poolSize > 1);
        const entries = isList ? shown : [(shown && !fromEnv) ? shown : ''];
        const label = isList && entries.length > 1 ? ' — one per account; the nth pairs with key [n]' : '';
        const inputs = entries.map((entry, i) => {
          const placeholder = fromEnv ? 'set by the environment' : `Enter ${field}...`;
          return `
            <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
              <span style="font-size:0.72rem; color:var(--text-muted); min-width:16px;">[${i}]</span>
              <input type="text" id="cred-field-${escapeHtml(p.key)}-${escapeHtml(field)}-${i}" data-cred-field="${escapeHtml(field)}" data-cred-key="${escapeHtml(p.key)}" value="${escapeHtml(entry || '')}" placeholder="${escapeHtml(placeholder)}" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.78rem; background:var(--input-bg); color:var(--text);" onkeydown="if(event.key==='Enter'){event.preventDefault();saveProviderCredentialFields(${jsStringAttr(p.key)});}" title="Press Enter or click Save">
              <button onclick="saveProviderCredentialFields(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Save</button>
            </div>`;
        }).join('');
        return `
          <div style="margin-top:10px;">
            <div style="font-size:0.74rem; color:var(--text-muted); margin-bottom:2px;"><code>${escapeHtml(field)}</code>${escapeHtml(label)}</div>
            ${inputs}
          </div>`;
      }).join('');
      return `
        <div style="margin-top:12px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
          <div style="font-size:0.8rem; font-weight:700; color:var(--text); margin-bottom:4px;">${missing.size > 0 ? 'Required settings' : 'Settings'}</div>
          <div style="font-size:0.74rem; color:var(--text-muted);">This endpoint embeds ${fields.map(f => `<code>${escapeHtml(f)}</code>`).join(', ')} in its URL, so its models cannot be listed until ${fields.length === 1 ? 'it is' : 'they are'} set.</div>
          ${rows}
        </div>`;
    }

    async function saveProviderCredentialFields(key) {
      // Grouped by field and kept in input order, so a field drawn as a list is sent as a
      // list and the nth entry keeps lining up with the nth key.
      //
      // Scoped by data-cred-key, not by an id prefix: provider keys can be prefixes of one
      // another ("openai" and "openai-compatible" both exist), and every provider card is on
      // the page at once. A prefix match reads the other provider's input — under its real
      // field name, which is exactly what this change began trusting — so one provider's Save
      // would silently overwrite another provider's credential.
      const byField = new Map();
      document.querySelectorAll('input[id^="cred-field-"]').forEach(el => {
        if (el.getAttribute('data-cred-key') !== key) return;
        const field = el.getAttribute('data-cred-field');
        if (!field) return;
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field).push(el.value.trim());
      });
      const credentialFields = {};
      for (const [field, entries] of byField) {
        const filled = entries.filter(v => v);
        // An untouched single input keeps sending a plain string, which is what a config
        // written before this supported lists looks like.
        credentialFields[field] = (entries.length === 1 || filled.length === 1) ? (filled[0] || '') : filled;
      }
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: key, credentialFields })
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        await loadSettings();
        await fetchData();
      } catch (err) {
        console.error('Failed to save provider settings:', err);
        alert(`Could not save provider settings: ${err.message || err}`);
      }
    }

    function renderProviderSyncError(providerName, errorMessage) {
      openProviderSyncModal(
        `${providerName} Model Sync`,
        'Refresh failed',
        `<div style="padding:14px 16px; background:var(--status-error-bg); border:1px solid var(--status-error-border); border-radius:12px; color:var(--status-error-text); font-size:0.84rem; line-height:1.5; white-space:pre-wrap; word-break:break-word;">${escapeHtml(errorMessage || 'Unknown error.')}</div>`
      );
    }

    async function refreshProviderModels(key, providerName) {
      if (!key || providerRefreshInFlight.has(key)) return;
      providerRefreshInFlight.add(key);
      await loadSettings();

      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(key)}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
          throw new Error(data.error || `Failed to refresh ${providerName} models.`);
        }

        await fetchData();
        renderProviderSyncSuccess(providerName, Array.isArray(data.models) ? data.models : [], data.modelDiscovery || null);
      } catch (err) {
        renderProviderSyncError(providerName, err.message || `Failed to refresh ${providerName} models.`);
      } finally {
        providerRefreshInFlight.delete(key);
        await loadSettings();
      }
    }

    // ---- Provider onboarding popup ---------------------------------------------------------
    //
    // A new provider's setup is one arc: fetch its model list, test every model, sort by the
    // verdicts the tests left behind, then hand the survivors to the plots. It runs as a
    // server-side job (see /api/providers/:key/onboard) so the popup can be closed and reopened
    // without losing the run — the client here is only a viewer that polls.
    let onboardJobId = null;
    let onboardProviderKey = null;
    let onboardProviderName = '';
    let onboardPollTimer = null;
    const ONBOARD_POLL_MS = 700;
    const ONBOARD_MAX_POLL_FAILURES = 20;
    const ONBOARD_FINISHED = new Set(['done', 'empty', 'failed', 'cancelled', 'partial']);

    const ONBOARD_STAGE_DEFS = [
      { key: 'discovering', label: 'Fetch models' },
      { key: 'testing', label: 'Test all' },
      { key: 'done', label: 'Sorted' },
    ];

    function openProviderOnboardModal(providerName) {
      const overlay = document.getElementById('provider-onboard-overlay');
      const modal = document.getElementById('provider-onboard-modal');
      const title = document.getElementById('provider-onboard-title');
      const subtitle = document.getElementById('provider-onboard-subtitle');
      if (!overlay || !modal) return;
      if (title) title.textContent = `${providerName || 'Provider'} setup`;
      if (subtitle) subtitle.textContent = 'Fetching models, testing each one, then sorting them by current status.';
      setProviderOnboardFooterAction(false);
      overlay.style.display = 'block';
      modal.style.display = 'block';
    }

    function setProviderOnboardFooterAction(finished) {
      const button = document.getElementById('provider-onboard-cancel');
      if (!button) return;
      button.textContent = finished ? 'Close' : 'Cancel';
      button.setAttribute('aria-label', finished ? 'Close provider setup' : 'Cancel provider setup');
    }

    function closeProviderOnboardModal() {
      const overlay = document.getElementById('provider-onboard-overlay');
      const modal = document.getElementById('provider-onboard-modal');
      if (overlay) overlay.style.display = 'none';
      if (modal) modal.style.display = 'none';
      // Closing is not cancelling: the server job keeps running and can be resumed later (see
      // resumeOnboardingIfRunning). Only the local polling stops.
      if (onboardPollTimer) { clearTimeout(onboardPollTimer); onboardPollTimer = null; }
      onboardPollFailures = 0;
      // Invalidate any in-flight start or poll: without this, an await that resolves after the
      // close would call renderProviderOnboard and reopen the popup the user just dismissed.
      onboardSession += 1;
      onboardJobId = null;
    }

    function onboardStageReached(stage, status) {
      if (ONBOARD_FINISHED.has(status)) return ONBOARD_STAGE_DEFS.length;
      const index = ONBOARD_STAGE_DEFS.findIndex(def => def.key === stage);
      return index === -1 ? 0 : index;
    }

    function onboardStagesHtml(stage, status) {
      const reached = onboardStageReached(stage, status);
      return ONBOARD_STAGE_DEFS.map((def, i) => {
        const state = i < reached ? 'done' : (i === reached ? 'active' : '');
        const mark = i < reached ? '\u2713' : String(i + 1);
        return `<div class="onboard-stage ${state}"><span class="onboard-stage-num">${mark}</span><span>${escapeHtml(def.label)}</span></div>`;
      }).join('<span class="onboard-stage-sep">\u2192</span>');
    }

    // The pill colour is the verdict's own family, so a model reads the same colour here as its
    // status dot in the table.
    function onboardPillClass(verdict) {
      const v = String(verdict || '').toLowerCase();
      if (v === 'very fast' || v === 'fast' || v === 'normal') return 'up';
      if (v === 'slow' || v === 'very slow') return 'slow';
      if (v === 'unstable') return 'unstable';
      return 'down';
    }

    function onboardRate(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return n >= 100 ? n.toFixed(0) : n.toFixed(1);
    }

    function onboardRowsHtml(job) {
      const rows = Array.isArray(job.results) ? job.results : [];
      if (rows.length === 0) return '';
      return rows.map(r => {
        const tested = r.tested === true;
        const meta = [];
        if (r.httpCode != null && r.httpCode !== '') meta.push(`HTTP ${escapeHtml(String(r.httpCode))}`);
        if (r.ttftMs != null) meta.push(`${Math.round(r.ttftMs)}ms TTFT`);
        const rate = onboardRate(r.tps);
        if (rate != null) meta.push(`${rate} tok/s`);
        if (r.ctx) meta.push(escapeHtml(formatContextDisplay(r.ctx)));
        const err = r.error ? `<div class="onboard-row-error">${escapeHtml(String(r.error))}</div>` : '';
        return `
          <div class="onboard-row${tested ? '' : ' pending'}">
            <div class="onboard-row-main">
              <div class="onboard-row-model">${escapeHtml(r.label || r.modelId)}</div>
              <div class="onboard-row-meta">${tested ? (meta.join(' \u00b7 ') || 'Tested') : 'Waiting\u2026'}</div>
              ${err}
            </div>
            <span class="onboard-pill ${tested ? onboardPillClass(r.verdict) : 'wait'}">${tested ? escapeHtml(r.verdict || 'Unknown') : '\u23f3'}</span>
          </div>`;
      }).join('');
    }

    function renderProviderOnboard(job) {
      if (!job) return;
      openProviderOnboardModal(job.providerName || onboardProviderName || 'Provider');
      const stagesEl = document.getElementById('provider-onboard-stages');
      const bodyEl = document.getElementById('provider-onboard-body');
      if (!stagesEl || !bodyEl) return;
      stagesEl.innerHTML = onboardStagesHtml(job.stage, job.status);

      const finished = ONBOARD_FINISHED.has(job.status);
      setProviderOnboardFooterAction(finished);
      const total = job.total || 0;
      const completed = job.completed || 0;
      const progress = job.progress || 0;
      const summary = job.summary || null;
      const readyText = summary ? `${summary.ready} of ${summary.total} ready` : `${completed} of ${total} tested`;

      let headline;
      if (job.status === 'failed') {
        headline = `<div class="onboard-note error">Setup stopped: ${escapeHtml(job.error || 'unknown error')}</div>`;
      } else if (job.status === 'cancelled') {
        headline = `<div class="onboard-note warn">Cancelled \u2014 ${escapeHtml(readyText)}.</div>`;
      } else if (job.status === 'empty') {
        headline = `<div class="onboard-note warn">${escapeHtml(discoveryEmptyExplanation(job.modelDiscovery))}</div>`;
      } else if (finished) {
        headline = `<div class="onboard-note success">${escapeHtml(summary ? `${summary.ready} of ${summary.total} model${summary.total === 1 ? '' : 's'} ready` : 'Setup finished')}.</div>`;
      } else {
        headline = `<div class="onboard-note">Discovering and testing\u2026</div>`;
      }

      const progressHtml = finished ? '' : `<div class="onboard-progress"><div class="onboard-progress-bar" style="width:${Math.max(2, progress)}%"></div></div>`;

      // The footer owns Cancel/Close so it stays reachable while the model list scrolls. The body
      // only carries actions specific to a finished run.
      const actions = [];
      if (finished) {
        const failedCount = Array.isArray(job.errors) ? job.errors.length : 0;
        if (failedCount > 0) actions.push(`<button class="onboard-btn ghost" onclick="retryFailedOnboarding()">Retry failed (${failedCount})</button>`);
      }

      // This body is rebuilt on every 700ms poll. Replacing its children discards the scroll
      // position of both the body and its model list, which yanked the list back to the top
      // while it was still being tested. Save them and restore them after the rebuild, so a
      // list the user has scrolled stays where they left it.
      const previousList = bodyEl.querySelector('.onboard-list');
      const previousListScrollTop = previousList ? previousList.scrollTop : null;
      const previousBodyScrollTop = bodyEl.scrollTop;

      bodyEl.innerHTML = `
        ${headline}
        <div class="onboard-meter"><span>${escapeHtml(readyText)}</span><span>${total ? `${completed}/${total}` : ''}</span></div>
        ${progressHtml}
        <div class="onboard-list">${onboardRowsHtml(job)}</div>
        ${actions.length ? `<div class="onboard-actions">${actions.join('')}</div>` : ''}
      `;

      // Restore after the new nodes exist: assigning to the old list would do nothing, since it
      // is no longer in the document.
      const nextList = bodyEl.querySelector('.onboard-list');
      if (nextList && previousListScrollTop != null) nextList.scrollTop = previousListScrollTop;
      bodyEl.scrollTop = previousBodyScrollTop;
    }

    async function runProviderOnboarding(key, name) {
      if (!key) return;
      // A key save fires this from both Enter and blur, so two starts for the same provider can be
      // in flight before either POST resolves. This guard is synchronous, so the second one is
      // refused instead of launching a duplicate run over the same rows.
      if (onboardStarting && onboardProviderKey === key) return;
      onboardStarting = true;
      onboardProviderKey = key;
      onboardProviderName = name || PROVIDER_NAMES[key] || key;
      const session = ++onboardSession;
      openProviderOnboardModal(onboardProviderName);
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(key)}/onboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (session !== onboardSession) return;   // closed or superseded while the request was out
        if (!res.ok || data.ok === false) throw new Error(data.error || `Failed to start setup for ${onboardProviderName}.`);
        onboardJobId = data.jobId;
        renderProviderOnboard(data.job || { providerKey: key, providerName: onboardProviderName, status: 'queued', stage: 'queued', results: [], total: 0, completed: 0, progress: 0 });
        scheduleOnboardPoll();
      } catch (err) {
        if (session !== onboardSession) return;
        console.error('Failed to start provider onboarding:', err);
        const bodyEl = document.getElementById('provider-onboard-body');
        if (bodyEl) bodyEl.innerHTML = `<div class="onboard-note error">Could not start setup: ${escapeHtml(err.message || String(err))}</div>`;
        setProviderOnboardFooterAction(true);
        onboardJobId = null;
      } finally {
        onboardStarting = false;
      }
    }

    function scheduleOnboardPoll() {
      if (onboardPollTimer) clearTimeout(onboardPollTimer);
      onboardPollTimer = setTimeout(pollOnboardJob, ONBOARD_POLL_MS);
    }

    async function pollOnboardJob() {
      onboardPollTimer = null;
      const jobId = onboardJobId;
      if (!jobId) return;
      const session = onboardSession;
      try {
        const res = await fetch(`/api/providers/onboard-status?jobId=${encodeURIComponent(jobId)}`);
        const data = await res.json().catch(() => ({}));
        // The popup may have been closed, or a new run started, while this request was out. Drop
        // the stale answer instead of rendering it and reopening the modal.
        if (session !== onboardSession || onboardJobId !== jobId) return;
        if (!data.ok || !data.job) {
          // The job is gone (a server restart forgets in-memory jobs). Stop rather than spin.
          onboardJobId = null;
          return;
        }
        onboardPollFailures = 0;
        renderProviderOnboard(data.job);
        if (ONBOARD_FINISHED.has(data.job.status)) {
          onboardJobId = null;
          await finishProviderOnboarding(data.job);
          return;
        }
        scheduleOnboardPoll();
      } catch (err) {
        if (session !== onboardSession || onboardJobId !== jobId) return;
        console.error('Onboarding poll failed:', err);
        // A server that is down (or a proxy that keeps resetting) must not be polled forever.
        onboardPollFailures += 1;
        if (onboardPollFailures > ONBOARD_MAX_POLL_FAILURES) {
          console.error('Provider onboarding: giving up after repeated poll failures.');
          onboardPollFailures = 0;
          onboardJobId = null;
          return;
        }
        scheduleOnboardPoll();
      }
    }

    // Every test recorded its own result on the live row, so one snapshot repaints the table, the
    // numbers and both plots with the models this run just brought online — the "place them into
    // the main plot" step is that repaint, plus a short highlight of the provider's best model so
    // the handoff is visible rather than silent.
    async function finishProviderOnboarding(job) {
      await fetchData();
      await loadSettings();
      emphasizeProviderPlots(job);
    }

    function emphasizeProviderPlots(job) {
      const best = (Array.isArray(job.results) ? job.results : []).find(r => r.tested && r.ok);
      if (!best) return;
      if (onboardHighlightTimer) clearTimeout(onboardHighlightTimer);
      // Hold the emphasis in state (see drawPlots) so the idle repaint fetchData just scheduled —
      // which would otherwise draw the router's pick — keeps the new provider's model highlighted.
      onboardHighlight = { modelId: best.modelId, providerKey: job.providerKey };
      drawPlots(allModels, currentBestModelId, currentBestProviderKey);
      onboardHighlightTimer = setTimeout(() => {
        onboardHighlightTimer = null;
        onboardHighlight = null;
        drawPlots(allModels, currentBestModelId, currentBestProviderKey);
      }, 5000);
    }

    function cancelProviderOnboardingOrClose() {
      if (onboardJobId) {
        cancelProviderOnboarding();
        return;
      }
      closeProviderOnboardModal();
    }

    async function cancelProviderOnboarding() {
      if (!onboardJobId) return;
      try {
        await fetch('/api/providers/onboard-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: onboardJobId }),
        });
      } catch (err) {
        console.error('Failed to cancel onboarding:', err);
      }
      // The next poll observes the cancelled status and finishes.
    }

    async function retryFailedOnboarding() {
      if (!onboardProviderKey) return;
      await runProviderOnboarding(onboardProviderKey, onboardProviderName);
    }

    // A key save or an OAuth connect is the moment "setting up a provider" begins. Fire the
    // setup run for it unless one for the same provider is already on screen.
    function maybeOnboardProvider(key) {
      if (!key) return;
      if (onboardJobId && onboardProviderKey === key) return;
      runProviderOnboarding(key, PROVIDER_NAMES[key] || key).catch(err => console.error('Provider onboarding failed to start:', err));
    }

    function onboardButtonHtml(p) {
      return `<button class="provider-onboard-btn" onclick='runProviderOnboarding(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Fetch this provider's models, test them all, and sort by current status">\u2726 Set up</button>`;
    }

    // Re-attach to a setup run that was left open when the page was reloaded. The job lives on the
    // server, so this is a read of the recent jobs, not a restart of one.
    async function resumeOnboardingIfRunning() {
      try {
        const res = await fetch('/api/providers/onboard-status');
        const data = await res.json().catch(() => ({}));
        if (!data.ok || !Array.isArray(data.jobs)) return;
        const running = data.jobs.find(job => job.status === 'running' || job.status === 'queued');
        if (!running) return;
        onboardJobId = running.id;
        onboardProviderKey = running.providerKey;
        onboardProviderName = running.providerName || running.providerKey;
        renderProviderOnboard(running);
        scheduleOnboardPoll();
      } catch (err) {
        console.error('Could not resume provider onboarding:', err);
      }
    }

    function setConfigTransferStatus(message, tone = '') {
      const statusEl = document.getElementById('config-transfer-status');
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.className = `autoupdate-save-status${tone === 'success' ? ' success' : tone === 'error' ? ' error' : ''}`;
    }

    async function exportConfigTokenToBox() {
      try {
        const res = await fetch('/api/config/export');
        const payload = await res.json();
        if (!res.ok || !payload?.payload) {
          throw new Error(payload?.error || 'Failed to export settings.');
        }
        const box = document.getElementById('config-transfer-payload');
        if (box) box.value = payload.payload;
        setConfigTransferStatus('Config token exported.', 'success');
      } catch (err) {
        setConfigTransferStatus(err.message || 'Failed to export settings.', 'error');
      }
    }

    async function copyConfigTokenFromBox() {
      const box = document.getElementById('config-transfer-payload');
      const value = (box?.value || '').trim();
      if (!value) {
        setConfigTransferStatus('Nothing to copy. Export first or paste a token.', 'error');
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        setConfigTransferStatus('Copied token to clipboard.', 'success');
      } catch {
        setConfigTransferStatus('Clipboard copy failed. Please copy manually.', 'error');
      }
    }

    async function importConfigTokenFromBox() {
      const box = document.getElementById('config-transfer-payload');
      const payload = (box?.value || '').trim();
      if (!payload) {
        setConfigTransferStatus('Paste a config token before importing.', 'error');
        return;
      }

      if (!confirm('Importing will overwrite your current settings (including API keys). Continue?')) {
        return;
      }

      try {
        const res = await fetch('/api/config/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to import settings.');
        }
        setConfigTransferStatus('Config imported successfully.', 'success');
        await loadSettings();
        await fetchData();
      } catch (err) {
        setConfigTransferStatus(err.message || 'Failed to import settings.', 'error');
      }
    }

    // `prefetchedProviders` lets a caller that already holds this payload — the staged boot
    // sequence, or a snapshot that happened to read the roster — skip a second round trip. Every
    // dashboard refresh used to pay for that duplicate request. Callers that have not fetched it
    // pass nothing and the behaviour is exactly as before.
    async function loadSettings(prefetchedProviders = null) {
      // Fetch the critical /api/config endpoint first and render providers
      // independently so the providers panel never stays empty just because a
      // secondary settings endpoint is briefly unavailable.
      let providers = prefetchedProviders || [];
      if (!prefetchedProviders) {
        try {
          const providersRes = await fetch('/api/config');
          if (providersRes.ok) providers = await providersRes.json();
        } catch (e) { console.error('loadSettings: config fetch failed:', e); }
      }

      // Fetch secondary settings; failure is non-fatal.
      let meta = {};
      try {
        const metaRes = await fetch('/api/meta');
        if (metaRes.ok) meta = await metaRes.json();
      } catch (e) { console.error('loadSettings: secondary settings fetch failed:', e); }

      renderLoggingSettings((meta && meta.logging) || {});

      const activeContainer = document.getElementById('active-providers-container');
      const setupContainer = document.getElementById('setup-providers-container');
      if (!activeContainer || !setupContainer) return;

      try {
        // loadSettings rebuilds these two containers on every dashboard refresh, which
        // would silently discard a key the user is still typing
        // (the input node is destroyed before blur/Enter can save it). Capture
        // the current value/focus of every provider control and restore it on
        // the freshly built DOM below.
        const inputState = new Map();
        for (const root of [activeContainer, setupContainer]) {
          root.querySelectorAll('input, textarea, select').forEach(el => {
            if (!el.id) return;
            inputState.set(el.id, {
              value: el.value,
              checked: el.type === 'checkbox' ? el.checked : undefined,
              focused: document.activeElement === el,
              selStart: (el.type === 'text' || el.type === 'password') ? el.selectionStart : null,
              dataset: { ...el.dataset },
            });
          });
        }
        const restoreInputState = () => {
          inputState.forEach((s, id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox' && s.checked !== undefined) {
              el.checked = s.checked;
            } else if (el.type !== 'checkbox') {
              el.value = s.value;
            }
            if (s.dataset) {
              for (const [k, v] of Object.entries(s.dataset)) el.dataset[k] = v;
            }
            if (s.focused) {
              el.focus();
              try { el.setSelectionRange(s.selStart ?? el.value.length, el.value.length); } catch { /* non-text inputs */ }
            }
          });
        };

        activeContainer.innerHTML = '';
        setupContainer.innerHTML = '';
        const endpointContainer = activeContainer;

        const addEndpointSection = document.createElement('tr');
        addEndpointSection.className = 'provider-add-row';
        addEndpointSection.innerHTML = `
          <td colspan="6">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
            <h3 style="margin:0; font-size:1rem;">OpenAI-Compatible endpoints</h3>
            <button onclick="addOpenAICompatibleEndpoint()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.8rem; font-weight:600;">+ Add Endpoint</button>
          </div>
          <div style="font-size:0.78rem; color:var(--text-muted);">Configure one or more upstream OpenAI-compatible endpoints (vLLM, llama.cpp, custom relays, etc.). Each endpoint exposes a single model id.</div>
          </td>
        `;
        endpointContainer.appendChild(addEndpointSection);

        providers.sort((a, b) => {
          if (a.hasKey && !b.hasKey) return -1;
          if (!a.hasKey && b.hasKey) return 1;
          return a.name.localeCompare(b.name);
        }).forEach(p => {
          const now = Date.now();
          // Which group the card belongs in is the router's answer, not a list kept here. This
          // used to be a hardcoded four keys, which is the same fact the server already owns —
          // and it had drifted: hosted Ollama sat in "Active now" while every dispatch refused
          // it NO_KEY, and the keyless imports landed in "Require setup" while working fine.
          //
          // `canServe` is the server's answer to exactly this question. A payload with no
          // `canServe` is a server from before that field existed, which still sends both
          // halves of it — a configured credential, or a declaration that none is needed — so
          // derive it rather than reaching for the deleted list.
          const providerIsActive = p.canServe === true
            || (p.canServe == null && (p.hasKey === true || p.supportsOptionalBearerAuth === true));

          const providerModels = allModels ? allModels.filter(m => m.providerKey === p.key) : [];
          // Count models for this provider from allModels
          const modelCount = providerModels.length;
          // Both cells read the same windows as the model table, from the row that carries
          // the most limit state: the throttle half (rateLimit) fills Rate limit and the
          // capacity half (quota) fills Quota.
          const rlModel = providerModels.find(m => m.rateLimit || m.quota) || providerModels[0] || null;
          const errorModel = providerModels
            .filter(m => {
              if (!m.lastError || m.status === 'up') return false;
              const updatedAtMs = Date.parse(m.lastError.updatedAt || '');
              return !Number.isNaN(updatedAtMs) && (now - updatedAtMs) <= PROVIDER_ERROR_MAX_AGE_MS;
            })
            .sort((a, b) => {
              const aTs = Date.parse(a.lastError.updatedAt || '');
              const bTs = Date.parse(b.lastError.updatedAt || '');
              if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0;
              if (Number.isNaN(aTs)) return 1;
              if (Number.isNaN(bTs)) return -1;
              return bTs - aTs;
            })[0] || null;
          const providerError = errorModel ? errorModel.lastError : null;

          const tokenOptional = p.supportsOptionalBearerAuth === true;
          // Active generic providers already have their credentials represented by the Accounts
          // panel below. Keep the single top-level input for setup, and for active providers that
          // do not have an account list to manage yet.
          const hasApiKeyAccounts = Array.isArray(p.apiKeyPool) && p.apiKeyPool.length > 0;
          const showTopCredentialInput = !providerIsActive || !hasApiKeyAccounts;
          const statusIcon = p.hasKey ? '✅' : (tokenOptional ? 'ℹ️' : '⚠️');
          const statusColor = p.hasKey ? 'var(--status-success-text)' : (tokenOptional ? 'var(--status-info-text)' : 'var(--status-warning-text)');
          const statusBg = p.hasKey ? 'var(--status-success-bg)' : (tokenOptional ? 'var(--status-info-bg)' : 'var(--status-warning-bg)');
          const statusText = p.hasKey
            ? (tokenOptional ? 'API Key configured' : 'Key configured')
            : (tokenOptional ? 'API Key optional' : 'No API key');

          // Both provider columns answer from the same windows as the model table: bars
          // when a limit is known, ∞ when none is. The representative row is whichever of
          // the provider's rows carries the most limit state.
          const providerQuotaHtml = providerQuotaCellHtml(rlModel, p);
          const providerUsageCell = `<td class="provider-usage-cell" data-provider-usage="${escapeAttr(p.key)}"></td>`;
          const rateLimitHtml = providerRateLimitCellHtml(rlModel, p);

          let providerErrorHtml = '';
          if (providerError && providerError.message) {
            const errorUpdated = providerError.updatedAt ? new Date(providerError.updatedAt) : null;
            const errorWhen = errorUpdated && !Number.isNaN(errorUpdated.getTime())
              ? errorUpdated.toLocaleString()
              : 'unknown time';
            providerErrorHtml = `
              <div style="margin-top:12px; padding:10px 12px; background:var(--status-error-bg); border:1px solid var(--status-error-border); border-radius:8px; font-size:0.78rem; color:var(--status-error-text);">
                <div style="font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-size:0.7rem; color:var(--status-error-text);">Latest Provider Error</div>
                <div style="word-break:break-word;"><b>${escapeHtml(errorModel.modelId)}</b>: ${escapeHtml(providerError.message)}</div>
                <div style="margin-top:6px; color:var(--status-error-text);">HTTP ${escapeHtml(providerError.code || '?')} • ${escapeHtml(errorWhen)}</div>
              </div>`;
          }

          const showsBaseUrlFields = p.isOpenAICompatibleInstance || p.key === 'ollama';
          const baseUrlPlaceholder = p.key === 'ollama' ? 'https://ollama.com/v1' : 'https://your-endpoint.example/v1';
          const baseUrlNote = p.isOpenAICompatibleInstance
            ? 'Set the upstream base URL for this endpoint. The model id below is optional — leave blank if discovery returns the models you need.'
            : 'Set the upstream base URL and exact model ID for this provider. If base URL is blank, hammer uses https://ollama.com/v1 and expects an OLLAMA_API_KEY.';
          const openAiCompatibleFieldsHtml = showsBaseUrlFields ? `
            <div class="form-group" style="display:flex; gap:8px; align-items:center; margin-top:8px;">
              <input type="text" id="base-url-${p.key}" value="${escapeHtml(p.baseUrl || '')}" placeholder="${baseUrlPlaceholder}" style="flex:1;" onblur="updateProviderBaseUrl(${jsStringAttr(p.key)})">
            </div>
            <div class="form-group" style="display:flex; gap:8px; align-items:center; margin-top:8px;">
              <input type="text" id="model-id-${p.key}" value="${escapeHtml(p.modelId || '')}" placeholder="upstream-model-id (optional if discovery is on)" style="flex:1;" onblur="updateProviderModelId(${jsStringAttr(p.key)})">
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">${baseUrlNote}</div>
            ${p.isOpenAICompatibleInstance ? `
              <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; cursor:pointer;">
                  <input type="checkbox" id="discover-${p.key}" ${p.discoverModels !== false ? 'checked' : ''} onchange="updateProviderDiscoverModels(${jsStringAttr(p.key)})">
                  Discover models from <code>/v1/models</code>
                </label>
              </div>
              <div style="margin-top:10px; display:flex; justify-content:flex-end;">
                <button onclick="removeOpenAICompatibleEndpoint(${jsStringAttr(p.openAICompatibleInstanceId)}, ${jsStringAttr(p.name)})" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Remove Endpoint</button>
              </div>
            ` : ''}
          ` : '';

          const optionalBearerAuthHtml = (tokenOptional && p.hasKey) ? `
            <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; cursor:pointer;">
                <input type="checkbox" id="bearer-auth-${p.key}" ${p.useBearerAuth !== false ? 'checked' : ''} onchange="updateProviderBearerAuth(${jsStringAttr(p.key)})">
                Attach API Key as Bearer
              </label>
            </div>
          ` : '';

          // One provider is one row of the providers table: identity and actions beside its
          // credential form, with the account-level facts — quota, the last error, the prompt's
          // rate limits — in their own columns instead of stacked boxes inside a card.
          const section = document.createElement('tr');
          const isRefreshing = providerRefreshInFlight.has(p.key);
          section.className = 'provider-row';
          if (p.key === 'kiro') {
            const kiroStatusOk = p.hasKey;
            const kiroStatusBg = kiroStatusOk ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const kiroStatusColor = kiroStatusOk ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            const kiroProviderLabel = p.authProvider === 'github' ? 'GitHub' : 'Google';
            let kiroStatusText = 'No refresh token';
            if (p.authMode === 'builder-id') {
              kiroStatusText = p.authEmail
                ? `AWS Builder ID · ${p.authEmail}`
                : 'AWS Builder ID connected';
            } else if (p.authMode === 'browser-oauth') {
              kiroStatusText = p.authEmail
                ? `Browser OAuth · ${p.authEmail}`
                : `Browser OAuth via ${kiroProviderLabel}`;
            } else if (kiroStatusOk) {
              kiroStatusText = 'Refresh token configured';
            }

            const kiroMessageHtml = kiroUiMessage
              ? `<div id="kiro-ui-message" style="margin-top:12px; padding:10px 12px; border-radius:8px; font-size:0.8rem; border:1px solid ${kiroUiMessage.tone === 'error' ? 'var(--status-error-border)' : kiroUiMessage.tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}; background:${kiroUiMessage.tone === 'error' ? 'var(--status-error-bg)' : kiroUiMessage.tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)'}; color:${kiroUiMessage.tone === 'error' ? 'var(--status-error-text)' : kiroUiMessage.tone === 'success' ? 'var(--status-success-text)' : 'var(--text)'};">${escapeHtml(kiroUiMessage.text)}</div>`
              : '<div id="kiro-ui-message" style="display:none;"></div>';

            const kiroDeviceAuthHtml = kiroDeviceAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">AWS Builder ID authorization in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Approve the request in the opened browser window, or open the verification link below on another device and enter the code.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="kiro-device-verify-url" readonly value="${escapeHtml(kiroDeviceAuthState.verificationUriComplete || kiroDeviceAuthState.verificationUri || '')}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyKiroDeviceVerificationUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                  <div style="padding:8px 12px; border-radius:8px; border:1px dashed var(--border-subtle); background:var(--card); color:var(--text); font-size:0.85rem; font-weight:700; letter-spacing:0.08em;">${escapeHtml(kiroDeviceAuthState.userCode || '')}</div>
                  <button onclick="copyKiroDeviceUserCode()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Copy Code</button>
                  <span style="font-size:0.74rem; color:var(--text-muted);">Polling every ${escapeHtml(String(kiroDeviceAuthState.interval || 5))}s</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button data-verify-url="${escapeHtml(kiroDeviceAuthState.verificationUriComplete || '')}" onclick="openExternalAuthUrl(this.dataset.verifyUrl || '')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
                  <button onclick="cancelKiroDeviceAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            const kiroBrowserAuthHtml = kiroBrowserAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">Browser OAuth (${kiroBrowserAuthState.provider === 'github' ? 'GitHub' : 'Google'})</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">After approval, the browser tab may end on a blank or unsupported page because Kiro redirects to a <code>kiro://</code> URL. Copy that full URL from the browser's address bar and paste it below.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="kiro-auth-url" readonly value="${escapeHtml(kiroBrowserAuthState.authUrl)}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyKiroAuthUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                  <input type="text" id="kiro-callback-url" placeholder="kiro://kiro.kiroAgent/authenticate-success?code=..." style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button onclick="completeKiroBrowserAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Connect Account</button>
                  <button onclick="cancelKiroBrowserAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${kiroStatusBg}; color:${kiroStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${kiroStatusOk ? '✅' : '⚠️'} ${escapeHtml(kiroStatusText)}</span>
                  ${providerTitleHtml(p, 'Set up Kiro')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}


                </div>
                <div class="provider-desc">Connect Kiro with AWS Builder ID device authorization, import a token from the AWS SSO cache, or paste a refresh token manually.</div>
              </td>
              <td class="provider-credential">
              <div style="margin:0 0 12px 0; padding:10px 12px; background:var(--status-info-bg); border:1px solid var(--status-info-border); border-radius:8px; color:var(--status-info-text); font-size:0.78rem; line-height:1.45;">
                Recommended: <b>AWS Builder ID</b>. It opens the AWS verification page and waits for approval, which is the same supported Kiro path OmniRoute uses. This avoids the broken <code>kiro://</code> browser handoff.
              </div>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                <button onclick="startKiroBuilderIdAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Connect with AWS Builder ID</button>
                <button onclick="autoImportKiroToken()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Auto-import from AWS cache</button>
              </div>
              <div class="form-group" style="display:flex; gap:8px; align-items:center;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (Refresh Token Configured)' : 'Paste Kiro refresh token...'}" style="flex:1; background:var(--input-bg); color:var(--text);" onkeydown="if(event.key==='Enter'){event.preventDefault(); saveKiroRefreshToken();}">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide token" aria-label="Show or hide token" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="saveKiroRefreshToken()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Token</button>
              </div>
              <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;">Hammer stores the resulting Kiro refresh token locally in your Hammer config. Auto-import/manual token are still useful if Kiro is already signed in on this machine.</div>
              ${kiroDeviceAuthHtml}
              ${kiroBrowserAuthHtml}
              ${kiroMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          if (p.key === 'github-copilot') {
            const copilotConnected = p.hasKey;
            const copilotStatusBg = copilotConnected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const copilotStatusColor = copilotConnected ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            let copilotStatusText = 'Not signed in';
            if (p.authMode === 'device-flow') {
              copilotStatusText = p.authEmail ? `Signed in · ${p.authEmail}` : 'Signed in with GitHub';
            } else if (p.authMode === 'manual-token') {
              copilotStatusText = p.authEmail ? `Token · ${p.authEmail}` : 'GitHub token configured';
            } else if (copilotConnected) {
              copilotStatusText = 'GitHub token configured';
            }

            const copilotMessageHtml = copilotUiMessage
              ? `<div id="copilot-ui-message" style="margin-top:12px; padding:10px 12px; border-radius:8px; font-size:0.8rem; border:1px solid ${copilotUiMessage.tone === 'error' ? 'var(--status-error-border)' : copilotUiMessage.tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}; background:${copilotUiMessage.tone === 'error' ? 'var(--status-error-bg)' : copilotUiMessage.tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)'}; color:${copilotUiMessage.tone === 'error' ? 'var(--status-error-text)' : copilotUiMessage.tone === 'success' ? 'var(--status-success-text)' : 'var(--text)'};">${escapeHtml(copilotUiMessage.text)}</div>`
              : '<div id="copilot-ui-message" style="display:none;"></div>';

            const copilotDeviceAuthHtml = copilotDeviceAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">GitHub sign-in in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Open the verification page on any device and enter the code. Hammer finishes the connection automatically.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="copilot-device-verify-url" readonly value="${escapeHtml(copilotDeviceAuthState.verificationUriComplete || copilotDeviceAuthState.verificationUri || '')}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyCopilotVerificationUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                  <div style="padding:8px 12px; border-radius:8px; border:1px dashed var(--border-subtle); background:var(--card); color:var(--text); font-size:0.85rem; font-weight:700; letter-spacing:0.08em;">${escapeHtml(copilotDeviceAuthState.userCode || '')}</div>
                  <button onclick="copyCopilotUserCode()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Copy Code</button>
                  <span style="font-size:0.74rem; color:var(--text-muted);">Polling every ${escapeHtml(String(copilotDeviceAuthState.interval || 5))}s</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button data-verify-url="${escapeHtml(copilotDeviceAuthState.verificationUriComplete || copilotDeviceAuthState.verificationUri || '')}" onclick="openExternalAuthUrl(this.dataset.verifyUrl || '')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
                  <button onclick="cancelCopilotDeviceAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            const copilotActionsHtml = copilotConnected
              ? '<button onclick="disconnectCopilot()" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Disconnect</button>'
              : '<button onclick="startCopilotDeviceAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Sign in with GitHub</button>';

            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${copilotStatusBg}; color:${copilotStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${copilotConnected ? '✅' : '⚠️'} ${escapeHtml(copilotStatusText)}</span>
                  ${providerTitleHtml(p, 'Manage GitHub Copilot')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}
                </div>
                <div class="provider-desc">Sign in with the GitHub account that has Copilot. Hammer stores the resulting GitHub token locally and uses it as the Copilot credential — model traffic is billed against that account's Copilot plan, with no per-token cost.</div>
              </td>
              <td class="provider-credential">
              <div style="margin:0 0 12px 0; padding:10px 12px; background:var(--status-info-bg); border:1px solid var(--status-info-border); border-radius:8px; color:var(--status-info-text); font-size:0.78rem; line-height:1.45;">
                <b>Sign in with GitHub</b> opens the GitHub device page and waits for approval, which is the same supported path the Copilot CLI uses. Free plans keep working here; models your plan gates (Claude, Grok, the GPT‑5 coding family) are enabled automatically once a token is configured (sign-in or a pasted token).
              </div>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                ${copilotActionsHtml}
              </div>
              <div class="form-group" style="display:flex; gap:8px; align-items:center;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (GitHub token configured)' : 'Or paste a GitHub token (gho_…)'}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide token" aria-label="Show or hide token" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="updateProviderKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Token</button>
              </div>
              ${copilotDeviceAuthHtml}
              ${copilotMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          if (p.key === 'google-antigravity') {
            const aaAccounts = Array.isArray(p.accounts) ? p.accounts : [];
            const aaSignedIn = aaAccounts.length > 0;
            const aaStatusBg = aaSignedIn ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const aaStatusColor = aaSignedIn ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            const aaStatusText = aaSignedIn
              ? `Signed in · ${aaAccounts.length === 1 ? (aaAccounts[0].email || aaAccounts[0].projectId || 'Google account') : `${aaAccounts.length} accounts`}`
              : 'Not signed in';
            const aaAccountListHtml = aaAccounts.length === 0 ? '' : `
              <div style="margin:0 0 12px 0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--input-bg-alt);">
                ${aaAccounts.map(account => {
                  const identifier = account.email || account.projectId || '';
                  const removeButton = aaAccounts.length > 1
                    ? `<button data-aa-account="${escapeHtml(identifier)}" data-aa-index="${Number.isInteger(account.index) ? account.index : ''}" onclick="removeAntigravityAccount(this.dataset.aaAccount, this.dataset.aaIndex)" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:6px 10px; border-radius:6px; font-size:0.74rem; font-weight:600; white-space:nowrap;">Remove</button>`
                    : '';
                  return `
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-top:1px solid var(--border-subtle);">
                    <div style="min-width:0;">
                      <div style="font-size:0.82rem; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(account.email || account.projectId || 'Google account')}</div>
                      <div style="font-size:0.74rem; color:var(--text-muted);">${escapeHtml([account.projectId, account.planType].filter(Boolean).join(' · ') || 'Antigravity account')}</div>
                    </div>
                    ${removeButton}
                  </div>`;
                }).join('')}
                ${aaAccounts.length > 1 ? '<div style="padding:8px 12px; font-size:0.74rem; color:var(--text-muted); border-top:1px solid var(--border-subtle);">Requests rotate across these accounts, and an account that is out of allowance hands the turn to the next one.</div>' : ''}
              </div>`;
            const aaActions = aaSignedIn
              ? '<button onclick="startAntigravityOAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Add another account</button>'
                + `<button onclick="disconnectAntigravity()" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Disconnect${aaAccounts.length > 1 ? ' all' : ''}</button>`
              : '<button onclick="startAntigravityOAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Sign in with Google</button>';
            const aaFlowHtml = antigravityAuthState ? `
              <div style="margin:0 0 12px 0; padding:12px; border:1px solid var(--status-info-border); background:var(--status-info-bg); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">Antigravity sign-in in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Approve access in the Google tab. Hammer listens on <code>${escapeHtml(antigravityAuthState.redirectUri)}</code> and finishes automatically.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                  <input type="text" id="antigravity-auth-url" readonly value="${escapeHtml(antigravityAuthState.authUrl)}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyAntigravityAuthUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <button onclick="cancelAntigravityOAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
              </div>
            ` : '';
            const aaMessageHtml = antigravityUiMessage ? `
              <div id="antigravity-ui-message" style="margin:0 0 12px 0; padding:10px 12px; border-radius:8px; font-size:0.78rem;">${escapeHtml(antigravityUiMessage.text)}</div>
            ` : '';
            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${aaStatusBg}; color:${aaStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${aaSignedIn ? '✅' : '⚠️'} ${escapeHtml(aaStatusText)}</span>
                  ${providerTitleHtml(p, 'Connect Google Antigravity')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}
                </div>
                <div class="provider-desc">Gemini and Claude models through Google's Cloud Code Assist backend, authenticated by an OAuth sign-in instead of an API key. This is Antigravity's own OAuth client, so Hammer listens on 127.0.0.1:51121 only while the sign-in runs.</div>
              </td>
              <td class="provider-credential">
              ${aaAccountListHtml}
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                ${aaActions}
              </div>
              ${aaFlowHtml}
              ${aaMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          if (p.key === 'googleai') {
            const googleAccounts = Array.isArray(p.accounts) ? p.accounts : [];
            const googleAccountCount = googleAccounts.length;
            const googleSignedIn = googleAccountCount > 0 || p.authMode === 'google-oauth';
            const googleConnected = p.hasKey;
            const googleStatusBg = googleConnected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const googleStatusColor = googleConnected ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            let googleStatusText = 'Not signed in';
            if (googleAccountCount > 1) googleStatusText = `Signed in · ${googleAccountCount} accounts`;
            else if (googleAccountCount === 1) googleStatusText = `Signed in · ${googleAccounts[0].email || googleAccounts[0].projectId || 'Google account'}`;
            else if (googleSignedIn) googleStatusText = p.authEmail ? `Signed in · ${p.authEmail}` : 'Google account connected';
            else if (googleConnected) googleStatusText = 'API key configured · sign in for quota';

            const googleAccountRowsHtml = googleAccounts.map(account => {
              const identifier = account.email || account.projectId || '';
              const label = account.email || account.projectId || 'Google account with no reported email';
              const meta = [account.projectId, account.planType].filter(Boolean).join(' · ');
              const removeButton = googleAccountCount > 1
                ? `<button data-google-account="${escapeHtml(identifier)}" data-google-index="${Number.isInteger(account.index) ? account.index : ''}" onclick="disconnectGoogle(this.dataset.googleAccount, this.dataset.googleIndex)" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:6px 10px; border-radius:6px; font-size:0.74rem; font-weight:600; white-space:nowrap;">Remove</button>`
                : '';
              return `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-top:1px solid var(--border-subtle);">
                  <div style="min-width:0;">
                    <div style="font-size:0.82rem; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(label)}</div>
                    <div style="font-size:0.74rem; color:var(--text-muted);">${escapeHtml(meta || 'Quota project discovered at sign-in')}</div>
                  </div>
                  ${removeButton}
                </div>`;
            }).join('');
            const googleAccountListHtml = googleAccountCount === 0 ? '' : `
              <div style="margin:0 0 12px 0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--input-bg-alt);">
                ${googleAccountRowsHtml}
                ${googleAccountCount > 1 ? '<div style="padding:8px 12px; font-size:0.74rem; color:var(--text-muted); border-top:1px solid var(--border-subtle);">Quota is read from every signed-in account; requests use the first account.</div>' : ''}
              </div>`;

            const googleMessageHtml = googleUiMessage
              ? `<div id="google-ui-message" style="margin-top:12px; padding:10px 12px; border-radius:8px; font-size:0.8rem; border:1px solid ${googleUiMessage.tone === 'error' ? 'var(--status-error-border)' : googleUiMessage.tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}; background:${googleUiMessage.tone === 'error' ? 'var(--status-error-bg)' : googleUiMessage.tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)'}; color:${googleUiMessage.tone === 'error' ? 'var(--status-error-text)' : googleUiMessage.tone === 'success' ? 'var(--status-success-text)' : 'var(--text)'};">${escapeHtml(googleUiMessage.text)}</div>`
              : '<div id="google-ui-message" style="display:none;"></div>';

            const googleFlowHtml = googleAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">Google sign-in in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Approve access in the Google tab. Hammer listens on <code>${escapeHtml(googleAuthState.redirectUri)}</code> and finishes automatically.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                  <input type="text" id="google-auth-url" readonly value="${escapeHtml(googleAuthState.authUrl)}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyGoogleAuthUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <button onclick="cancelGoogleOAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
              </div>
            ` : '';

            const googleActionsHtml = googleSignedIn
              ? '<button onclick="startGoogleOAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Add another account</button>'
                + `<button onclick="disconnectGoogle()" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Disconnect${googleAccountCount > 1 ? ' all' : ''}</button>`
              : '<button onclick="startGoogleOAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Sign in with Google</button>';

            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${googleStatusBg}; color:${googleStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${googleConnected ? '✅' : '⚠️'} ${escapeHtml(googleStatusText)}</span>
                  ${providerTitleHtml(p, 'Connect Google Gemini')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}
                </div>
                <div class="provider-desc">Sign in with the Google account behind Gemini. Hammer uses the resulting OAuth token for Gemini traffic and reads that project's Code Assist quota for the model table. A GOOGLE_API_KEY can still be pasted below as a fallback.</div>
              </td>
              <td class="provider-credential">
              <div style="margin:0 0 12px 0; padding:10px 12px; background:var(--status-info-bg); border:1px solid var(--status-info-border); border-radius:8px; color:var(--status-info-text); font-size:0.78rem; line-height:1.45;">
                Quota is provider-reported as a remaining percentage with a reset time. Google does not publish an absolute request count, so Hammer shows the percentage rather than inventing one.
              </div>
              ${googleAccountListHtml}
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                ${googleActionsHtml}
              </div>
              <div class="form-group" style="display:flex; gap:8px; align-items:center;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (credential configured)' : 'Or paste a GOOGLE_API_KEY fallback...'}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide API key" aria-label="Show or hide API key" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="updateProviderKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Key</button>
              </div>
              ${googleFlowHtml}
              ${googleMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          if (p.key === 'openai-codex') {
            const codexConnected = p.hasKey;
            const codexStatusBg = codexConnected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const codexStatusColor = codexConnected ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            const codexAccounts = Array.isArray(p.accounts) ? p.accounts : [];
            const codexAccountCount = codexAccounts.length;
            let codexStatusText = 'Not signed in';
            if (codexAccountCount > 1) {
              // With a pool, naming one account would misdescribe the credential: every
              // request rotates, so the count is the honest summary.
              codexStatusText = `Signed in · ${codexAccountCount} accounts`;
            } else if (p.authMode === 'device-flow') {
              codexStatusText = p.authEmail ? `Signed in · ${p.authEmail}` : 'Signed in with ChatGPT';
            } else if (p.authMode === 'manual-token') {
              codexStatusText = 'Refresh token configured';
            } else if (codexConnected) {
              codexStatusText = 'ChatGPT account connected';
            }
            if (codexAccountCount <= 1 && codexConnected && codexAccounts[0] && codexAccounts[0].planType) {
              codexStatusText = `${codexStatusText} · ${codexAccounts[0].planType}`;
            }

            // One row per signed-in account. The identifier is the email (or the workspace id),
            // because that is what the sign-out route matches on, and an account that reported
            // neither falls back to its pool position — which the server resolves back to the
            // credential itself, so no account is stuck in the pool forever. Remove only appears
            // once there is more than one account: signing the last one out is Disconnect's job.
            const codexAccountRowsHtml = codexAccounts.map(account => {
              const identifier = account.email || account.accountId || '';
              const label = account.email || account.accountId || 'ChatGPT account with no reported email';
              const meta = [account.planType, account.addedAt ? `added ${new Date(account.addedAt).toLocaleString()}` : null].filter(Boolean).join(' · ');
              // A row with neither an identifier nor a pool position gets no Remove button: the
              // empty request that would send means "sign every account out", and a payload this
              // UI cannot identify is no reason to wipe the pool.
              const removable = Boolean(identifier) || Number.isInteger(account.index)
              const removeButton = codexAccountCount > 1 && removable
                ? `<button data-codex-account="${escapeHtml(identifier)}" data-codex-index="${Number.isInteger(account.index) ? account.index : ''}" onclick="disconnectCodex(this.dataset.codexAccount, this.dataset.codexIndex)" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:6px 10px; border-radius:6px; font-size:0.74rem; font-weight:600; white-space:nowrap;">Remove</button>`
                : '';
              return `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-top:1px solid var(--border-subtle);">
                  <div style="min-width:0;">
                    <div style="font-size:0.82rem; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(label)}</div>
                    <div style="font-size:0.74rem; color:var(--text-muted);">${escapeHtml(meta || 'Signed in with ChatGPT')}</div>
                  </div>
                  ${removeButton}
                </div>`;
            }).join('');
            const codexAccountListHtml = codexAccountCount === 0 ? '' : `
              <div style="margin:0 0 12px 0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--input-bg-alt);">
                ${codexAccountRowsHtml}
                ${codexAccountCount > 1 ? '<div style="padding:8px 12px; font-size:0.74rem; color:var(--text-muted); border-top:1px solid var(--border-subtle);">The first account is used until it is spent, then the next takes over — and one that hits its plan limit is benched so the others keep serving.</div>' : ''}
              </div>`;

            const codexMessageHtml = codexUiMessage
              ? `<div id="codex-ui-message" style="margin-top:12px; padding:10px 12px; border-radius:8px; font-size:0.8rem; border:1px solid ${codexUiMessage.tone === 'error' ? 'var(--status-error-border)' : codexUiMessage.tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}; background:${codexUiMessage.tone === 'error' ? 'var(--status-error-bg)' : codexUiMessage.tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)'}; color:${codexUiMessage.tone === 'error' ? 'var(--status-error-text)' : codexUiMessage.tone === 'success' ? 'var(--status-success-text)' : 'var(--text)'};">${escapeHtml(codexUiMessage.text)}</div>`
              : '<div id="codex-ui-message" style="display:none;"></div>';

            const codexDeviceAuthHtml = codexDeviceAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">ChatGPT sign-in in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Open the verification page on any device and enter the code. Hammer finishes the connection automatically.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="codex-device-verify-url" readonly value="${escapeHtml(codexDeviceAuthState.verificationUri || '')}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyCodexVerificationUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                  <div style="padding:8px 12px; border-radius:8px; border:1px dashed var(--border-subtle); background:var(--card); color:var(--text); font-size:0.85rem; font-weight:700; letter-spacing:0.08em;">${escapeHtml(codexDeviceAuthState.userCode || '')}</div>
                  <button onclick="copyCodexUserCode()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Copy Code</button>
                  <span style="font-size:0.74rem; color:var(--text-muted);">Polling every ${escapeHtml(String(codexDeviceAuthState.interval || 5))}s</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button data-verify-url="${escapeHtml(codexDeviceAuthState.verificationUri || '')}" onclick="openExternalAuthUrl(this.dataset.verifyUrl || '')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
                  <button onclick="cancelCodexDeviceAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            // Signing in is available while signed in: that is how a second ChatGPT account is
            // added, and the flow appends rather than replaces.
            const codexActionsHtml = codexConnected
              ? '<button onclick="startCodexDeviceAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Add another account</button>'
                + `<button onclick="disconnectCodex()" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Disconnect${codexAccountCount > 1 ? ' all' : ''}</button>`
              : '<button onclick="startCodexDeviceAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Sign in with ChatGPT</button>';

            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${codexStatusBg}; color:${codexStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${codexConnected ? '✅' : '⚠️'} ${escapeHtml(codexStatusText)}</span>
                  ${providerTitleHtml(p, 'Manage the ChatGPT plan behind Codex')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}
                </div>
                <div class="provider-desc">Sign in with the ChatGPT account whose plan should back the router. Hammer stores the resulting OAuth refresh token locally and exchanges it for short-lived access tokens — usage counts against that account's ChatGPT plan instead of per-token billing. Sign in again with a different account to add it: the first is spent before the next is used, so one plan's limit is not the ceiling for the whole router.</div>
              </td>
              <td class="provider-credential">
              <div style="margin:0 0 12px 0; padding:10px 12px; background:var(--status-info-bg); border:1px solid var(--status-info-border); border-radius:8px; color:var(--status-info-text); font-size:0.78rem; line-height:1.45;">
                Codex is not an OpenAI-compatible endpoint: traffic is translated to the Responses API, and only the models your plan may serve are listed. Your ChatGPT password is never seen by Hammer — the device flow only ever returns a token.
              </div>
              ${codexAccountListHtml}
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                ${codexActionsHtml}
              </div>
              <div class="form-group" style="display:flex; gap:8px; align-items:center;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (refresh token configured)' : 'Or paste a ChatGPT refresh token'}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide token" aria-label="Show or hide token" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="updateProviderKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Token</button>
              </div>
              ${codexDeviceAuthHtml}
              ${codexMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          if (p.key === 'devin') {
            const devinConnected = p.hasKey;
            const devinStatusBg = devinConnected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
            const devinStatusColor = devinConnected ? 'var(--status-success-text)' : 'var(--status-warning-text)';
            const devinStatusText = devinConnected ? 'Connected' : 'Not connected';
            const devinMessageHtml = devinUiMessage
              ? `<div id="devin-ui-message" style="margin-top:12px; padding:10px 12px; border-radius:8px; font-size:0.8rem; border:1px solid ${devinUiMessage.tone === 'error' ? 'var(--status-error-border)' : devinUiMessage.tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}; background:${devinUiMessage.tone === 'error' ? 'var(--status-error-bg)' : devinUiMessage.tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)'}; color:${devinUiMessage.tone === 'error' ? 'var(--status-error-text)' : devinUiMessage.tone === 'success' ? 'var(--status-success-text)' : 'var(--text)'};">${escapeHtml(devinUiMessage.text)}</div>`
              : '<div id="devin-ui-message" style="display:none;"></div>';

            const devinFlowHtml = devinOAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">Devin sign-in in progress</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Approve the login in the browser tab. Hammer listens on <code>${escapeHtml(devinOAuthState.redirectUri)}</code> and finishes automatically — no code to copy.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="devin-auth-url" readonly value="${escapeHtml(devinOAuthState.authUrl)}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyDevinAuthUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="font-size:0.74rem; color:var(--text-muted); margin-bottom:8px;">If the browser can't reach the local callback (different machine or blocked port), paste the full URL from the browser's address bar below.</div>
                <input type="text" id="devin-callback-url" placeholder="${escapeHtml(devinOAuthState.redirectUri)}?code=...&amp;state=..." style="width:100%; box-sizing:border-box; background:var(--input-bg); color:var(--text); font-size:0.76rem; padding:8px 10px; border:1px solid var(--border); border-radius:6px; margin-bottom:10px;">
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button onclick="completeDevinOAuthManual()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Connect (paste URL)</button>
                  <button onclick="cancelDevinOAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : `
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <button onclick="startDevinOAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.8rem; font-weight:600;">Sign in with Devin</button>
              </div>
            `;

            section.innerHTML = `
              <td class="provider-identity">
                <div class="provider-name-line">
                  <span style="background:${devinStatusBg}; color:${devinStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${devinConnected ? '✅' : '⚠️'} ${escapeHtml(devinStatusText)}</span>
                  ${providerTitleHtml(p, 'Get Devin')}
                  ${providerEnabledToggleHtml(p)}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                  ${onboardButtonHtml(p)}
                </div>
                <div class="provider-desc">Sign in with your Cognition (Devin) account — the same browser flow the Devin CLI uses. Hammer stores the session token locally and uses it for the swe-1.6 / swe-1.5 models.</div>
              </td>
              <td class="provider-credential">
              ${devinFlowHtml}
              <div class="form-group" style="display:flex; gap:8px; align-items:center; margin-top:10px;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (Session token configured)' : 'Or paste a session token (devin-session-token$...)'}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide token" aria-label="Show or hide token" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="updateProviderKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Token</button>
              </div>
              ${devinMessageHtml}
              ${credentialBarHtml(p)}
              </td>
              ${providerUsageCell}
              <td class="provider-quota-cell">${providerQuotaHtml}</td>
              <td class="provider-limits-cell">${rateLimitHtml}</td>
              <td class="provider-error-cell">${providerErrorHtml}</td>
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          section.innerHTML = `
            <td class="provider-identity">
              <div class="provider-name-line">
                <span style="background:${statusBg}; color:${statusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${statusIcon} ${statusText}</span>
                ${providerTitleHtml(p)}
                ${providerEnabledToggleHtml(p)}
                <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                    <polyline points="21 3 21 9 15 9"></polyline>
                  </svg>
                  <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                </button>
                ${onboardButtonHtml(p)}
              </div>
            </td>
            <td class="provider-credential">
            ${discoveryStateHtml(p, modelCount)}
            ${showTopCredentialInput ? `
            <div class="form-group" style="display:flex; gap:8px; align-items:center;">
              <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (' + (tokenOptional ? 'API Key Configured' : 'Key Configured') + ')' : (tokenOptional ? 'Enter API Key (optional)...' : 'Enter API Key...')}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
              <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide API key" aria-label="Show or hide API key" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
            </div>
            ` : ''}
            ${credentialFieldsHtml(p)}
            ${(Array.isArray(p.apiKeyPool) && p.apiKeyPool.length > 0) ? `
            <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="font-size:0.8rem; font-weight:700; color:var(--text);">Accounts (${p.apiKeyPool.length})</span>
                <span style="font-size:0.7rem; color:var(--text-muted);">${p.apiKeyPool.length > 1 ? 'Spent in order, one at a time' : 'Add one more key to fall back to'}</span>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
                ${p.apiKeyPool.map((acct, i) => `
                  <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--input-bg); border:1px solid var(--border-subtle); border-radius:6px; font-size:0.78rem;">
                    <span style="font-weight:700; color:var(--text-muted); min-width:20px;">[${i}]</span>
                    <span style="font-family:monospace; color:var(--text); flex:1;">${escapeHtml(acct.masked)}</span>
                    <span style="font-size:0.7rem; color:var(--text-muted);">${(() => {
                      // The same facts the pool bar draws, in words: how much this key has carried
                      // and where it stands. The span used to be an empty hook nothing filled.
                      const usage = (p.credentialPool && Array.isArray(p.credentialPool.accounts))
                        ? p.credentialPool.accounts.find(entry => entry.index === i)
                        : null;
                      if (!usage) return '';
                      const requests = Number(usage.requests) || 0;
                      const state = usage.exhausted
                        ? `exhausted${usage.resetsInMs ? ` \u00b7 resets in ${formatCountdown(usage.resetsInMs)}` : ''}`
                        : (i === p.credentialPool.servingIndex ? 'serving' : 'waiting its turn');
                      return escapeHtml(requests > 0 ? `${requests} request${requests === 1 ? '' : 's'} \u00b7 ${state}` : state);
                    })()}</span>
                    <button onclick="removeAccountKey(${jsStringAttr(p.key)}, ${i})" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:2px 8px; border-radius:4px; font-size:0.7rem; font-weight:600;">Remove</button>
                  </div>
                `).join('')}
              </div>
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                <input type="password" id="new-key-${p.key}" placeholder="Add new account key..." style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.78rem; background:var(--input-bg); color:var(--text);" onkeydown="if(event.key==='Enter'){event.preventDefault();addAccountKey(${jsStringAttr(p.key)});}" title="Press Enter to add">
                <button onclick="addAccountKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Add Account</button>
              </div>
            </div>
            ` : ''}
            ${optionalBearerAuthHtml}
            ${openAiCompatibleFieldsHtml}
            ${credentialBarHtml(p)}
            </td>
            ${providerUsageCell}
            <td class="provider-quota-cell">${providerQuotaHtml}</td>
            <td class="provider-limits-cell">${rateLimitHtml}</td>
            <td class="provider-error-cell">${providerErrorHtml}</td>
          `;
          (providerIsActive ? activeContainer : setupContainer).appendChild(section);
        });
        restoreInputState();
        drawProviderUsageSparklines();
        // The panel exists now, so a snapshot may refresh it and the staged boot sequence must
        // not build it a second time (see loadModelSnapshot).
        providerPanelState = 'ready';
        perfMark('providers');
        perfReport();
      } catch (err) { console.error(err); }
      // Pending imported-provider discovery is completed during server startup. Explicit
      // provider refreshes and request-triggered discovery remain available for later recovery.
    }

    // Saving a provider key/enable state makes the server refresh that
    // provider's models in the background. Re-pull once shortly after so the
    // newly available rows appear in the table without the user having to
    // refresh the page by hand.
    function scheduleKeySaveRefetch() {
      setTimeout(() => {
        if (!document.hidden) fetchData().catch(() => { });
      }, 1800);
    }

    // The card is re-rendered from the server's answer instead of from the checkbox, so a write
    // that did not land shows the state the router is actually in rather than the one the click
    // asked for.
    async function setProviderEnabled(key, enabled) {
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: key, enabled })
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        await loadSettings();
        await fetchData();
      } catch (err) {
        console.error('Failed to change provider state:', err);
        alert(`Could not ${enabled ? 'enable' : 'disable'} this provider: ${err.message || err}`);
        await loadSettings().catch(() => {});
      }
    }

    async function updateProviderKey(key) {
      const input = document.getElementById(`key-${key}`);
      if (!input) return;
      const val = input.value.trim();
      if (!val) return;
      if (input.dataset.revealedKey === val) {
        input.value = '';
        input.type = 'password';
        delete input.dataset.revealedKey;
        return;
      }
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: key, apiKey: val })
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        input.value = '';
        await loadSettings();
        await fetchData();
        scheduleKeySaveRefetch();
        // Setting up a provider is exactly this moment: a key just landed for it. Open the setup
        // popup so its models are fetched, tested and sorted without a second ask.
        maybeOnboardProvider(key);
      } catch (err) {
        console.error('Failed to save provider key:', err);
        alert(`Could not save provider key: ${err.message || err}`);
      }
    }

    async function getConfiguredProviderKey(providerKey) {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('Failed to load the configured key.');
      const providers = await res.json();
      const provider = providers.find(item => item.key === providerKey);
      const account = provider && Array.isArray(provider.apiKeyPool) ? provider.apiKeyPool[0] : null;
      return account && typeof account.key === 'string' ? account.key : '';
    }

    async function toggleProviderKeyVisibility(providerKey, button) {
      const input = document.getElementById(`key-${providerKey}`);
      if (!input) return;

      if (input.type === 'text') {
        input.type = 'password';
        button.textContent = '👁';
        if (input.dataset.revealedKey === input.value) {
          input.value = '';
          delete input.dataset.revealedKey;
        }
        return;
      }

      try {
        if (!input.value) {
          const configuredKey = await getConfiguredProviderKey(providerKey);
          if (!configuredKey) return;
          input.value = configuredKey;
          input.dataset.revealedKey = configuredKey;
        }
        input.type = 'text';
        button.textContent = '🙈';
      } catch (err) {
        console.error(err);
      }
    }

    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('Clipboard copy failed.');
    }

    async function copyProviderKey(providerKey, button) {
      const originalText = button.textContent;
      try {
        const input = document.getElementById(`key-${providerKey}`);
        const key = input && input.value ? input.value.trim() : await getConfiguredProviderKey(providerKey);
        if (!key) throw new Error('No configured key was found.');
        await copyText(key);
        button.textContent = 'Copied';
      } catch (err) {
        console.error(err);
        button.textContent = 'Failed';
      } finally {
        setTimeout(() => { button.textContent = originalText; }, 1500);
      }
    }

    async function deleteProviderKey(key) {
      if (!confirm(`Delete the configured key for ${PROVIDER_NAMES[key] || key}?`)) return;
      const input = document.getElementById(`key-${key}`);
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: key, apiKey: null })
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        if (input) input.value = '';
        await loadSettings();
        await fetchData();
      } catch (err) {
        console.error('Failed to delete provider key:', err);
        alert(`Could not delete provider key: ${err.message || err}`);
      }
    }

    async function updateProviderBaseUrl(key) {
      const input = document.getElementById(`base-url-${key}`);
      const baseUrl = input ? input.value.trim() : '';
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: key, baseUrl })
      });
      await fetchData();
    }

    async function addOpenAICompatibleEndpoint() {
      const name = prompt('Endpoint name (e.g. "my-vllm")');
      if (!name || !name.trim()) return;
      const baseUrl = prompt('Base URL (e.g. https://your-host/v1)') || '';
      const modelId = prompt('Upstream model id (optional — leave blank to rely on /v1/models discovery)') || '';
      const apiKey = prompt('API key (leave blank if not required)') || '';
      const resp = await fetch('/api/openai-compatible/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), modelId: modelId.trim(), apiKey: apiKey.trim() || null })
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const body = await resp.json(); if (body && body.error) msg = body.error; } catch {}
        alert(`Could not add endpoint: ${msg}`);
        return;
      }
      await loadSettings();
      await fetchData();
    }

    async function updateProviderDiscoverModels(key) {
      const cb = document.getElementById(`discover-${key}`);
      const discoverModels = cb ? !!cb.checked : true;
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: key, discoverModels })
      });
      await fetchData();
    }

    async function removeOpenAICompatibleEndpoint(id, name) {
      if (!confirm(`Remove endpoint "${name}"?`)) return;
      const resp = await fetch(`/api/openai-compatible/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const body = await resp.json(); if (body && body.error) msg = body.error; } catch {}
        alert(`Could not remove endpoint: ${msg}`);
        return;
      }
      await loadSettings();
      await fetchData();
    }

    async function updateProviderModelId(key) {
      const input = document.getElementById(`model-id-${key}`);
      const modelId = input ? input.value.trim() : '';
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: key, modelId })
      });
      await fetchData();
    }

    async function addAccountKey(providerKey) {
      const input = document.getElementById(`new-key-${providerKey}`);
      if (!input) return;
      const val = input.value.trim();
      if (!val) return;
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const providers = await res.json();
        const p = providers.find(pr => pr.key === providerKey);
        if (!p) throw new Error('Provider not found.');
        const existingKeys = Array.isArray(p.apiKeyPool) ? p.apiKeyPool.map(a => a.key).filter(Boolean) : [];
        if (existingKeys.includes(val)) throw new Error('That key is already configured.');
        const saveRes = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey, apiKeys: [...existingKeys, val] })
        });
        if (!saveRes.ok) throw new Error((await saveRes.json().catch(() => ({}))).error || `HTTP ${saveRes.status}`);
        input.value = '';
        await loadSettings();
        await fetchData();
      } catch (err) {
        console.error('Failed to add provider key:', err);
        alert(`Could not add provider key: ${err.message || err}`);
      }
    }

    async function removeAccountKey(providerKey, index) {
      if (!confirm(`Remove account ${Number(index) + 1} for ${PROVIDER_NAMES[providerKey] || providerKey}?`)) return;
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const providers = await res.json();
        const p = providers.find(pr => pr.key === providerKey);
        if (!p || !Array.isArray(p.apiKeyPool)) throw new Error('Provider account list not found.');
        const newPool = p.apiKeyPool.map(a => a.key).filter((_, i) => i !== index);
        const saveRes = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey, apiKeys: newPool })
        });
        if (!saveRes.ok) throw new Error((await saveRes.json().catch(() => ({}))).error || `HTTP ${saveRes.status}`);
        await loadSettings();
        await fetchData();
      } catch (err) {
        console.error('Failed to remove provider key:', err);
        alert(`Could not remove provider key: ${err.message || err}`);
      }
    }

    async function updateProviderBearerAuth(key) {
      const input = document.getElementById(`bearer-auth-${key}`);
      if (!input) return;
      const useBearerAuth = input.checked;
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: key, useBearerAuth })
      });
    }

    function setKiroUiMessage(text, tone = 'info') {
      kiroUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('kiro-ui-message');
      if (!el) return;
      if (!kiroUiMessage) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = kiroUiMessage.text;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
      el.style.marginTop = '12px';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '8px';
      el.style.fontSize = '0.8rem';
    }

    function clearKiroDevicePollTimer() {
      if (kiroDevicePollTimer) {
        clearTimeout(kiroDevicePollTimer);
        kiroDevicePollTimer = null;
      }
    }

    async function copyKiroDeviceVerificationUrl() {
      const input = document.getElementById('kiro-device-verify-url');
      const value = input ? input.value.trim() : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setKiroUiMessage('Copied the AWS Builder ID verification link.', 'success');
      } catch {
        setKiroUiMessage('Clipboard copy failed. Copy the AWS Builder ID verification link manually.', 'error');
      }
    }

    async function copyKiroDeviceUserCode() {
      const value = kiroDeviceAuthState && kiroDeviceAuthState.userCode ? kiroDeviceAuthState.userCode : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setKiroUiMessage('Copied the AWS Builder ID code.', 'success');
      } catch {
        setKiroUiMessage('Clipboard copy failed. Copy the AWS Builder ID code manually.', 'error');
      }
    }

    function cancelKiroDeviceAuth() {
      clearKiroDevicePollTimer();
      kiroDeviceAuthState = null;
      setKiroUiMessage('Cancelled AWS Builder ID authorization.', 'info');
      loadSettings();
    }

    async function pollKiroBuilderIdAuth() {
      if (!kiroDeviceAuthState) return;

      const now = Date.now();
      if (kiroDeviceAuthState.expiresAt && now >= kiroDeviceAuthState.expiresAt) {
        clearKiroDevicePollTimer();
        kiroDeviceAuthState = null;
        setKiroUiMessage('AWS Builder ID authorization expired. Start it again to get a new code.', 'error');
        await loadSettings();
        return;
      }

      try {
        const res = await fetch('/api/oauth/kiro/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flowId: kiroDeviceAuthState.flowId,
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed while polling AWS Builder ID authorization.');
        }

        if (data.success) {
          clearKiroDevicePollTimer();
          kiroDeviceAuthState = null;
          setKiroUiMessage(data.email ? `Connected Kiro via AWS Builder ID as ${data.email}.` : 'Connected Kiro via AWS Builder ID.', 'success');
          await loadSettings();
          await fetchData();
          maybeOnboardProvider('kiro');
          return;
        }

        if (data.pending) {
          const nextInterval = data.error === 'slow_down'
            ? Math.max(5, Number(kiroDeviceAuthState.interval || 5) + 5)
            : Math.max(5, Number(kiroDeviceAuthState.interval || 5));
          kiroDeviceAuthState = { ...kiroDeviceAuthState, interval: nextInterval };
          clearKiroDevicePollTimer();
          kiroDevicePollTimer = setTimeout(() => {
            pollKiroBuilderIdAuth().catch(err => {
              setKiroUiMessage(err.message || 'Failed while polling AWS Builder ID authorization.', 'error');
            });
          }, nextInterval * 1000);
          return;
        }

        clearKiroDevicePollTimer();
        kiroDeviceAuthState = null;
        setKiroUiMessage(data.errorDescription || data.error || 'AWS Builder ID authorization failed.', 'error');
        await loadSettings();
      } catch (err) {
        clearKiroDevicePollTimer();
        kiroDeviceAuthState = null;
        setKiroUiMessage(err.message || 'Failed while polling AWS Builder ID authorization.', 'error');
        await loadSettings();
      }
    }

    async function startKiroBuilderIdAuth() {
      clearKiroDevicePollTimer();
      try {
        setKiroUiMessage('Preparing AWS Builder ID authorization...', 'info');
        const res = await fetch('/api/oauth/kiro/device-code');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start AWS Builder ID authorization.');
        }

        kiroDeviceAuthState = {
          flowId: data.flowId,
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          verificationUriComplete: data.verificationUriComplete,
          interval: Math.max(5, Number(data.interval || 5)),
          expiresAt: Date.now() + (Math.max(60, Number(data.expiresIn || 600)) * 1000),
        };
        kiroBrowserAuthState = null;
        await loadSettings();

        const verifyUrl = data.verificationUriComplete || data.verificationUri;
        const opened = verifyUrl ? await openExternalAuthUrl(verifyUrl) : false;
        setKiroUiMessage(
          opened
            ? 'Opened the AWS Builder ID verification page in your browser. Approve the request there and Hammer will finish the connection automatically.'
            : 'Use Open Verification Page below and approve the request in your browser; Hammer will finish the connection automatically.',
          'info',
        );
        pollKiroBuilderIdAuth().catch(err => {
          setKiroUiMessage(err.message || 'Failed while polling AWS Builder ID authorization.', 'error');
        });
      } catch (err) {
        kiroDeviceAuthState = null;
        setKiroUiMessage(err.message || 'Failed to start AWS Builder ID authorization.', 'error');
      }
    }

    async function startKiroBrowserAuth(provider) {
      const providerLabel = provider === 'github' ? 'GitHub' : 'Google';
      clearKiroDevicePollTimer();
      kiroDeviceAuthState = null;
      try {
        setKiroUiMessage(`Preparing ${providerLabel} browser OAuth. This only works if your machine can open kiro:// links.`, 'info');
        const res = await fetch(`/api/oauth/kiro/social-authorize?provider=${encodeURIComponent(provider)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `Failed to start Kiro ${providerLabel} OAuth.`);
        }

        kiroBrowserAuthState = {
          provider,
          authUrl: data.authUrl,
          flowId: data.flowId,
          state: data.state,
        };
        await loadSettings();
        const opened = await openExternalAuthUrl(data.authUrl);
        setKiroUiMessage(
          opened
            ? `Opened the ${providerLabel} login in your browser. If it reports that kiro:// has no registered handler, this machine cannot complete browser OAuth and you should use AWS cache import or a manual refresh token instead.`
            : `Could not open your browser. Use Copy Link below to open the ${providerLabel} login, then paste the callback URL below.`,
          'info',
        );
      } catch (err) {
        setKiroUiMessage(err.message || `Failed to start Kiro ${providerLabel} OAuth.`, 'error');
      }
    }

    async function copyKiroAuthUrl() {
      const input = document.getElementById('kiro-auth-url');
      const value = input ? input.value.trim() : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setKiroUiMessage('Copied the Kiro auth link to your clipboard.', 'success');
      } catch {
        setKiroUiMessage('Clipboard copy failed. Copy the Kiro auth link manually.', 'error');
      }
    }

    function cancelKiroBrowserAuth() {
      kiroBrowserAuthState = null;
      setKiroUiMessage(null);
      loadSettings();
    }

    async function completeKiroBrowserAuth() {
      if (!kiroBrowserAuthState) return;
      const input = document.getElementById('kiro-callback-url');
      const callbackUrl = input ? input.value.trim() : '';
      if (!callbackUrl) {
        setKiroUiMessage('Paste the full Kiro callback URL first.', 'error');
        return;
      }

      try {
        const url = new URL(callbackUrl);
        const errorParam = url.searchParams.get('error');
        if (errorParam) {
          throw new Error(url.searchParams.get('error_description') || errorParam);
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code) {
          throw new Error('No authorization code found in the callback URL.');
        }
        if (kiroBrowserAuthState.state && state && state !== kiroBrowserAuthState.state) {
          throw new Error('The callback state did not match the login request. Start the flow again.');
        }

        setKiroUiMessage('Exchanging Kiro authorization code...');
        const res = await fetch('/api/oauth/kiro/social-exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: kiroBrowserAuthState.provider,
            code,
            flowId: kiroBrowserAuthState.flowId,
            state,
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to complete Kiro browser OAuth.');
        }

        kiroBrowserAuthState = null;
        setKiroUiMessage(data.email ? `Connected Kiro as ${data.email}.` : 'Connected Kiro successfully.', 'success');
        await loadSettings();
        await fetchData();
        maybeOnboardProvider('kiro');
      } catch (err) {
        setKiroUiMessage(err.message || 'Failed to complete Kiro browser OAuth.', 'error');
      }
    }

    function clearCopilotDevicePollTimer() {
      if (copilotDevicePollTimer) {
        clearTimeout(copilotDevicePollTimer);
        copilotDevicePollTimer = null;
      }
    }

    function setCopilotUiMessage(text, tone = 'info') {
      copilotUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('copilot-ui-message');
      if (!el) return;
      if (!copilotUiMessage) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = copilotUiMessage.text;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
      el.style.marginTop = '12px';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '8px';
      el.style.fontSize = '0.8rem';
    }

    async function copyCopilotVerificationUrl() {
      const input = document.getElementById('copilot-device-verify-url');
      const value = input ? input.value.trim() : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopilotUiMessage('Copied the GitHub verification link.', 'success');
      } catch {
        setCopilotUiMessage('Clipboard copy failed. Copy the GitHub verification link manually.', 'error');
      }
    }

    async function copyCopilotUserCode() {
      const value = copilotDeviceAuthState && copilotDeviceAuthState.userCode ? copilotDeviceAuthState.userCode : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopilotUiMessage('Copied the GitHub device code.', 'success');
      } catch {
        setCopilotUiMessage('Clipboard copy failed. Copy the GitHub device code manually.', 'error');
      }
    }

    function cancelCopilotDeviceAuth() {
      clearCopilotDevicePollTimer();
      copilotDeviceAuthState = null;
      setCopilotUiMessage('Cancelled GitHub sign-in.', 'info');
      loadSettings();
    }

    async function startCopilotDeviceAuth() {
      clearCopilotDevicePollTimer();
      try {
        setCopilotUiMessage('Preparing GitHub device authorization...', 'info');
        const res = await fetch('/api/oauth/github-copilot/device-code');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start GitHub device authorization.');
        }

        copilotDeviceAuthState = {
          flowId: data.flowId,
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          verificationUriComplete: data.verificationUriComplete,
          interval: Math.max(3, Number(data.interval || 5)),
          expiresAt: Date.now() + (Math.max(60, Number(data.expiresIn || 900)) * 1000),
        };
        await loadSettings();

        const verifyUrl = data.verificationUriComplete || data.verificationUri;
        const opened = verifyUrl ? await openExternalAuthUrl(verifyUrl) : false;
        setCopilotUiMessage(
          opened
            ? 'Opened the GitHub verification page in your browser. Enter the code there and Hammer will finish the connection automatically.'
            : 'Use Open Verification Page below, enter the code in your browser, and Hammer will finish the connection automatically.',
          'info',
        );
        pollCopilotDeviceAuth().catch(err => {
          setCopilotUiMessage(err.message || 'Failed while polling GitHub device authorization.', 'error');
        });
      } catch (err) {
        copilotDeviceAuthState = null;
        setCopilotUiMessage(err.message || 'Failed to start GitHub device authorization.', 'error');
      }
    }

    async function pollCopilotDeviceAuth() {
      if (!copilotDeviceAuthState) return;

      const now = Date.now();
      if (copilotDeviceAuthState.expiresAt && now >= copilotDeviceAuthState.expiresAt) {
        clearCopilotDevicePollTimer();
        copilotDeviceAuthState = null;
        setCopilotUiMessage('GitHub device authorization expired. Start it again to get a new code.', 'error');
        await loadSettings();
        return;
      }

      try {
        const res = await fetch('/api/oauth/github-copilot/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flowId: copilotDeviceAuthState.flowId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed while polling GitHub device authorization.');
        }

        if (data.success) {
          clearCopilotDevicePollTimer();
          copilotDeviceAuthState = null;
          setCopilotUiMessage(data.login ? `Connected GitHub Copilot as ${data.login}.` : 'Connected GitHub Copilot.', 'success');
          await loadSettings();
          await fetchData();
          maybeOnboardProvider('github-copilot');
          return;
        }

        if (data.pending) {
          const nextInterval = data.error === 'slow_down'
            ? Math.max(5, Number(copilotDeviceAuthState.interval || 5) + 5)
            : Math.max(3, Number(copilotDeviceAuthState.interval || 5));
          copilotDeviceAuthState = { ...copilotDeviceAuthState, interval: nextInterval };
          clearCopilotDevicePollTimer();
          copilotDevicePollTimer = setTimeout(() => {
            pollCopilotDeviceAuth().catch(err => {
              setCopilotUiMessage(err.message || 'Failed while polling GitHub device authorization.', 'error');
            });
          }, nextInterval * 1000);
          return;
        }

        clearCopilotDevicePollTimer();
        copilotDeviceAuthState = null;
        setCopilotUiMessage(data.errorDescription || data.error || 'GitHub device authorization failed.', 'error');
        await loadSettings();
      } catch (err) {
        clearCopilotDevicePollTimer();
        copilotDeviceAuthState = null;
        setCopilotUiMessage(err.message || 'Failed while polling GitHub device authorization.', 'error');
        await loadSettings();
      }
    }

    async function disconnectCopilot() {
      try {
        const res = await fetch('/api/oauth/github-copilot/disconnect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to disconnect GitHub Copilot.');
        clearCopilotDevicePollTimer();
        copilotDeviceAuthState = null;
        setCopilotUiMessage('Disconnected GitHub Copilot and removed the stored token.', 'success');
        await loadSettings();
        await fetchData();
      } catch (err) {
        setCopilotUiMessage(err.message || 'Failed to disconnect GitHub Copilot.', 'error');
      }
    }

    function clearCodexDevicePollTimer() {
      if (codexDevicePollTimer) {
        clearTimeout(codexDevicePollTimer);
        codexDevicePollTimer = null;
      }
    }

    function setCodexUiMessage(text, tone = 'info') {
      codexUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('codex-ui-message');
      if (!el) return;
      if (!codexUiMessage) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = codexUiMessage.text;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
      el.style.marginTop = '12px';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '8px';
      el.style.fontSize = '0.8rem';
    }

    async function copyCodexVerificationUrl() {
      const input = document.getElementById('codex-device-verify-url');
      const value = input ? input.value.trim() : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCodexUiMessage('Copied the ChatGPT verification link.', 'success');
      } catch {
        setCodexUiMessage('Clipboard copy failed. Copy the ChatGPT verification link manually.', 'error');
      }
    }

    async function copyCodexUserCode() {
      const value = codexDeviceAuthState && codexDeviceAuthState.userCode ? codexDeviceAuthState.userCode : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCodexUiMessage('Copied the ChatGPT device code.', 'success');
      } catch {
        setCodexUiMessage('Clipboard copy failed. Copy the ChatGPT device code manually.', 'error');
      }
    }

    function cancelCodexDeviceAuth() {
      clearCodexDevicePollTimer();
      codexDeviceAuthState = null;
      setCodexUiMessage('Cancelled ChatGPT sign-in.', 'info');
      loadSettings();
    }

    let antigravityAuthState = null;
    let antigravityAuthPollTimer = null;
    let antigravityUiMessage = null;

    function setAntigravityUiMessage(text, tone = 'info') {
      antigravityUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('antigravity-ui-message');
      if (!el) return;
      el.style.display = antigravityUiMessage ? 'block' : 'none';
      el.textContent = antigravityUiMessage ? text : '';
      if (!antigravityUiMessage) return;
      el.dataset.tone = tone;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
    }

    function clearAntigravityAuthPollTimer() {
      if (antigravityAuthPollTimer) {
        clearTimeout(antigravityAuthPollTimer);
        antigravityAuthPollTimer = null;
      }
    }

    async function startAntigravityOAuth() {
      clearAntigravityAuthPollTimer();
      try {
        setAntigravityUiMessage('Preparing Antigravity sign-in…', 'info');
        const res = await fetch('/api/oauth/antigravity/authorize');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not start the Antigravity sign-in.');
        antigravityAuthState = {
          flowId: data.flowId,
          authUrl: data.authUrl,
          redirectUri: data.redirectUri,
          expiresAt: data.expiresAt,
        };
        await loadSettings();
        const opened = await openExternalAuthUrl(data.authUrl);
        if (!opened) {
          setAntigravityUiMessage('Could not open your browser. Copy the consent link below instead.', 'info');
        }
        antigravityAuthPollTimer = setTimeout(pollAntigravityOAuth, 1500);
      } catch (err) {
        setAntigravityUiMessage(err.message || 'Could not start the Antigravity sign-in.', 'error');
        await loadSettings();
      }
    }

    async function pollAntigravityOAuth() {
      antigravityAuthPollTimer = null;
      if (!antigravityAuthState) return;
      if (antigravityAuthState.expiresAt && Date.now() >= antigravityAuthState.expiresAt) {
        antigravityAuthState = null;
        setAntigravityUiMessage('Antigravity sign-in expired. Start it again for a fresh link.', 'error');
        await loadSettings();
        return;
      }
      try {
        const res = await fetch(`/api/oauth/antigravity/status?flowId=${encodeURIComponent(antigravityAuthState.flowId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not check the Antigravity sign-in status.');
        if (data.status === 'success') {
          antigravityAuthState = null;
          setAntigravityUiMessage(
            data.email
              ? `Connected ${data.email}${data.projectId ? ` · project ${data.projectId}` : ''}. The model table will refill from the catalog.`
              : 'Connected Google Antigravity.',
            'success',
          );
          await loadSettings();
          await fetchData();
          return;
        }
        if (data.status === 'error' || data.status === 'missing' || data.status === 'expired') {
          antigravityAuthState = null;
          setAntigravityUiMessage(data.error || 'Antigravity sign-in failed.', 'error');
          await loadSettings();
          return;
        }
        antigravityAuthPollTimer = setTimeout(pollAntigravityOAuth, 2000);
      } catch (err) {
        antigravityAuthState = null;
        setAntigravityUiMessage(err.message || 'Could not check the Antigravity sign-in status.', 'error');
        await loadSettings();
      }
    }

    function cancelAntigravityOAuth() {
      clearAntigravityAuthPollTimer();
      antigravityAuthState = null;
      setAntigravityUiMessage('Cancelled Antigravity sign-in.', 'info');
      loadSettings();
    }

    async function copyAntigravityAuthUrl() {
      const input = document.getElementById('antigravity-auth-url');
      if (!input || !input.value) return;
      try {
        await copyText(input.value);
        setAntigravityUiMessage('Consent link copied.', 'success');
      } catch (err) {
        setAntigravityUiMessage(err.message || 'Could not copy the link.', 'error');
      }
    }

    async function disconnectAntigravity() {
      try {
        const res = await fetch('/api/oauth/antigravity/disconnect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not disconnect Google Antigravity.');
        antigravityAuthState = null;
        setAntigravityUiMessage('Disconnected Google Antigravity.', 'success');
        await loadSettings();
        await fetchData();
      } catch (err) {
        setAntigravityUiMessage(err.message || 'Could not disconnect Google Antigravity.', 'error');
        await loadSettings();
      }
    }

    async function removeAntigravityAccount(account, index) {
      const identifier = typeof account === 'string' ? account.trim() : '';
      const position = Number.parseInt(index, 10);
      const body = identifier
        ? { account: identifier }
        : Number.isInteger(position)
          ? { index: position }
          : {};
      try {
        const res = await fetch('/api/oauth/antigravity/accounts/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not remove the Antigravity account.');
        setAntigravityUiMessage('Removed the Antigravity account.', 'success');
        await loadSettings();
        await fetchData();
      } catch (err) {
        setAntigravityUiMessage(err.message || 'Could not remove the Antigravity account.', 'error');
        await loadSettings();
      }
    }

    function setGoogleUiMessage(text, tone = 'info') {
      googleUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('google-ui-message');
      if (!el) return;
      if (!googleUiMessage) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = text;
      el.dataset.tone = tone;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
    }

    function clearGoogleAuthPollTimer() {
      if (googleAuthPollTimer) {
        clearTimeout(googleAuthPollTimer);
        googleAuthPollTimer = null;
      }
    }

    async function startGoogleOAuth() {
      clearGoogleAuthPollTimer();
      try {
        setGoogleUiMessage('Preparing Google sign-in…', 'info');
        const res = await fetch('/api/oauth/google/authorize');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not start Google sign-in.');
        googleAuthState = {
          flowId: data.flowId,
          authUrl: data.authUrl,
          redirectUri: data.redirectUri,
          expiresAt: data.expiresAt,
        };
        await loadSettings();
        const opened = await openExternalAuthUrl(data.authUrl);
        if (!opened) {
          setGoogleUiMessage('Could not open your browser. Use Copy Link below to open the consent page.', 'info');
        }
        googleAuthPollTimer = setTimeout(pollGoogleOAuth, 1500);
      } catch (err) {
        setGoogleUiMessage(err.message || 'Could not start Google sign-in.', 'error');
        await loadSettings();
      }
    }

    async function pollGoogleOAuth() {
      googleAuthPollTimer = null;
      if (!googleAuthState) return;
      if (googleAuthState.expiresAt && Date.now() >= googleAuthState.expiresAt) {
        googleAuthState = null;
        setGoogleUiMessage('Google sign-in expired. Start it again to get a fresh link.', 'error');
        await loadSettings();
        return;
      }
      try {
        const res = await fetch(`/api/oauth/google/status?flowId=${encodeURIComponent(googleAuthState.flowId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not check the Google sign-in status.');
        if (data.status === 'success') {
          googleAuthState = null;
          setGoogleUiMessage(
            data.email
              ? `Connected ${data.email}${data.projectId ? ` · quota project ${data.projectId}` : ''}. Quota will refresh with the model table.`
              : 'Connected Google. Quota will refresh with the model table.',
            'success',
          );
          await loadSettings();
          await fetchData();
          return;
        }
        if (data.status === 'error') {
          googleAuthState = null;
          setGoogleUiMessage(data.error || 'Google sign-in failed.', 'error');
          await loadSettings();
          return;
        }
        if (data.status === 'missing' || data.status === 'expired') {
          googleAuthState = null;
          setGoogleUiMessage('Google sign-in session was lost. Start it again.', 'error');
          await loadSettings();
          return;
        }
        googleAuthPollTimer = setTimeout(pollGoogleOAuth, 2000);
      } catch (err) {
        googleAuthState = null;
        setGoogleUiMessage(err.message || 'Could not check the Google sign-in status.', 'error');
        await loadSettings();
      }
    }

    function cancelGoogleOAuth() {
      clearGoogleAuthPollTimer();
      googleAuthState = null;
      setGoogleUiMessage('Cancelled Google sign-in.', 'info');
      loadSettings();
    }

    async function copyGoogleAuthUrl() {
      const input = document.getElementById('google-auth-url');
      if (!input || !input.value) return;
      try {
        await copyText(input.value);
        setGoogleUiMessage('Consent link copied.', 'success');
      } catch (err) {
        setGoogleUiMessage(err.message || 'Could not copy the link.', 'error');
      }
    }

    async function disconnectGoogle(account, index) {
      const identifier = typeof account === 'string' ? account.trim() : '';
      const position = Number.parseInt(index, 10);
      const body = identifier
        ? { account: identifier }
        : (Number.isInteger(position) ? { index: position } : {});
      try {
        const res = await fetch('/api/oauth/google/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not disconnect the Google account.');
        googleAuthState = null;
        setGoogleUiMessage('Disconnected Google. The API-key fallback, if any, is active again.', 'success');
        await loadSettings();
        await fetchData();
      } catch (err) {
        setGoogleUiMessage(err.message || 'Could not disconnect the Google account.', 'error');
        await loadSettings();
      }
    }

    async function startCodexDeviceAuth() {
      clearCodexDevicePollTimer();
      try {
        setCodexUiMessage('Preparing ChatGPT device authorization...', 'info');
        const res = await fetch('/api/oauth/openai-codex/device-code');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start ChatGPT device authorization.');
        }

        codexDeviceAuthState = {
          flowId: data.flowId,
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          interval: Math.max(3, Number(data.interval || 5)),
          expiresAt: Date.now() + (Math.max(60, Number(data.expiresIn || 900)) * 1000),
        };
        await loadSettings();

        const opened = data.verificationUri ? await openExternalAuthUrl(data.verificationUri) : false;
        setCodexUiMessage(
          opened
            ? 'Opened the ChatGPT verification page in your browser. Enter the code there and Hammer will finish the connection automatically.'
            : 'Use Open Verification Page below, enter the code in your browser, and Hammer will finish the connection automatically.',
          'info',
        );
        pollCodexDeviceAuth().catch(err => {
          setCodexUiMessage(err.message || 'Failed while polling ChatGPT device authorization.', 'error');
        });
      } catch (err) {
        codexDeviceAuthState = null;
        setCodexUiMessage(err.message || 'Failed to start ChatGPT device authorization.', 'error');
      }
    }

    async function pollCodexDeviceAuth() {
      if (!codexDeviceAuthState) return;

      const now = Date.now();
      if (codexDeviceAuthState.expiresAt && now >= codexDeviceAuthState.expiresAt) {
        clearCodexDevicePollTimer();
        codexDeviceAuthState = null;
        setCodexUiMessage('ChatGPT device authorization expired. Start it again to get a new code.', 'error');
        await loadSettings();
        return;
      }

      try {
        const res = await fetch('/api/oauth/openai-codex/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flowId: codexDeviceAuthState.flowId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed while polling ChatGPT device authorization.');
        }

        if (data.success) {
          clearCodexDevicePollTimer();
          codexDeviceAuthState = null;
          const identity = data.email ? ` as ${data.email}` : '';
          const plan = data.planType ? ` (${data.planType} plan)` : '';
          const accountCount = Number(data.accountCount || 0);
          const pool = accountCount > 1
            ? ` ${accountCount} ChatGPT accounts are now in rotation, and one that hits its plan limit is benched so the others keep serving.`
            : '';
          setCodexUiMessage(`Connected OpenAI Codex${identity}${plan}.${pool}`, 'success');
          await loadSettings();
          await fetchData();
          maybeOnboardProvider('openai-codex');
          return;
        }

        if (data.pending) {
          const nextInterval = Math.max(3, Number(codexDeviceAuthState.interval || 5));
          clearCodexDevicePollTimer();
          codexDevicePollTimer = setTimeout(() => {
            pollCodexDeviceAuth().catch(err => {
              setCodexUiMessage(err.message || 'Failed while polling ChatGPT device authorization.', 'error');
            });
          }, nextInterval * 1000);
          return;
        }

        clearCodexDevicePollTimer();
        codexDeviceAuthState = null;
        setCodexUiMessage(data.error || 'ChatGPT device authorization failed.', 'error');
        await loadSettings();
      } catch (err) {
        clearCodexDevicePollTimer();
        codexDeviceAuthState = null;
        setCodexUiMessage(err.message || 'Failed while polling ChatGPT device authorization.', 'error');
        await loadSettings();
      }
    }

    // Called with no argument it signs every account out — that is what the Disconnect button
    // does. Called with an account's email (or workspace id), or failing that its pool
    // position, it signs out exactly that one: the only way to trim a pool without emptying
    // it. The index arrives from a data attribute as a string, so it is normalized here.
    async function disconnectCodex(account, index) {
      const identifier = typeof account === 'string' ? account.trim() : '';
      const position = Number.parseInt(index, 10);
      const body = identifier ? { account: identifier } : (Number.isInteger(position) ? { index: position } : {});
      try {
        const res = await fetch('/api/oauth/openai-codex/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to disconnect OpenAI Codex.');
        clearCodexDevicePollTimer();
        codexDeviceAuthState = null;
        const signedOutOne = Boolean(identifier) || Number.isInteger(position);
        if (signedOutOne) {
          const remaining = Number(data.remaining || 0);
          setCodexUiMessage(`Signed ${identifier || 'that account'} out.${remaining > 0 ? ` ${remaining} account${remaining === 1 ? '' : 's'} still signed in.` : ''}`, 'success');
        } else {
          setCodexUiMessage('Disconnected OpenAI Codex and removed the stored credentials.', 'success');
        }
        await loadSettings();
        await fetchData();
      } catch (err) {
        setCodexUiMessage(err.message || 'Failed to disconnect OpenAI Codex.', 'error');
      }
    }

    function clearDevinPollTimer() {
      if (devinOAuthPollTimer) {
        clearTimeout(devinOAuthPollTimer);
        devinOAuthPollTimer = null;
      }
    }

    function setDevinUiMessage(text, tone = 'info') {
      devinUiMessage = text ? { text, tone } : null;
      const el = document.getElementById('devin-ui-message');
      if (!el) return;
      if (!devinUiMessage) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = devinUiMessage.text;
      el.style.border = `1px solid ${tone === 'error' ? 'var(--status-error-border)' : tone === 'success' ? 'var(--status-success-border)' : 'var(--border)'}`;
      el.style.background = tone === 'error' ? 'var(--status-error-bg)' : tone === 'success' ? 'var(--status-success-bg)' : 'var(--input-bg-alt)';
      el.style.color = tone === 'error' ? 'var(--status-error-text)' : tone === 'success' ? 'var(--status-success-text)' : 'var(--text)';
      el.style.marginTop = '12px';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '8px';
      el.style.fontSize = '0.8rem';
    }

    async function copyDevinAuthUrl() {
      const input = document.getElementById('devin-auth-url');
      const value = input ? input.value.trim() : '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setDevinUiMessage('Copied the Devin sign-in link to your clipboard.', 'success');
      } catch {
        setDevinUiMessage('Clipboard copy failed. Copy the Devin sign-in link manually.', 'error');
      }
    }

    async function cancelDevinOAuth() {
      clearDevinPollTimer();
      const flowId = devinOAuthState && devinOAuthState.flowId;
      devinOAuthState = null;
      if (flowId) {
        try {
          await fetch('/api/oauth/devin/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flowId })
          });
        } catch { /* best-effort */ }
      }
      setDevinUiMessage(null);
      await loadSettings();
    }

    async function pollDevinOAuth() {
      if (!devinOAuthState) return;

      const now = Date.now();
      if (devinOAuthState.expiresAt && now >= devinOAuthState.expiresAt) {
        clearDevinPollTimer();
        devinOAuthState = null;
        setDevinUiMessage('Devin sign-in expired. Start it again to get a fresh link.', 'error');
        await loadSettings();
        return;
      }

      try {
        const res = await fetch(`/api/oauth/devin/status?flowId=${encodeURIComponent(devinOAuthState.flowId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed while checking the Devin sign-in status.');
        }

        if (data.status === 'success') {
          clearDevinPollTimer();
          devinOAuthState = null;
          setDevinUiMessage('Connected Devin. Its models will appear once the health check finishes.', 'success');
          await loadSettings();
          await fetchData();
          scheduleKeySaveRefetch();
          maybeOnboardProvider('devin');
          return;
        }

        if (data.status === 'error') {
          clearDevinPollTimer();
          devinOAuthState = null;
          setDevinUiMessage(data.error || 'Devin sign-in failed.', 'error');
          await loadSettings();
          return;
        }

        if (data.status === 'expired' || data.status === 'missing') {
          clearDevinPollTimer();
          devinOAuthState = null;
          setDevinUiMessage(data.status === 'expired' ? 'Devin sign-in expired. Start it again.' : 'Devin sign-in session was lost. Start it again.', 'error');
          await loadSettings();
          return;
        }

        clearDevinPollTimer();
        devinOAuthPollTimer = setTimeout(() => {
          pollDevinOAuth().catch(err => {
            setDevinUiMessage(err.message || 'Failed while checking the Devin sign-in status.', 'error');
          });
        }, 2000);
      } catch (err) {
        clearDevinPollTimer();
        devinOAuthState = null;
        setDevinUiMessage(err.message || 'Failed while checking the Devin sign-in status.', 'error');
        await loadSettings();
      }
    }

    async function startDevinOAuth() {
      clearDevinPollTimer();
      if (devinOAuthState) {
        const oldFlowId = devinOAuthState.flowId;
        devinOAuthState = null;
        if (oldFlowId) {
          try {
            await fetch('/api/oauth/devin/cancel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ flowId: oldFlowId })
            });
          } catch { /* best-effort */ }
        }
      }
      try {
        setDevinUiMessage('Preparing the Devin sign-in flow...', 'info');
        const res = await fetch('/api/oauth/devin/authorize');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start the Devin sign-in flow.');
        }

        devinOAuthState = {
          flowId: data.flowId,
          authUrl: data.authUrl,
          redirectUri: data.redirectUri,
          expiresAt: Date.now() + (Math.max(60, Number(data.expiresIn || 300)) * 1000),
        };
        await loadSettings();

        const opened = await openExternalAuthUrl(data.authUrl);
        setDevinUiMessage(
          opened
            ? 'Opened the Devin sign-in page in your browser. Approve the login there and Hammer will finish automatically.'
            : 'Could not open your browser. Use Copy Link below, then paste the callback URL into the field below after approving.',
          'info',
        );
        pollDevinOAuth().catch(err => {
          setDevinUiMessage(err.message || 'Failed while checking the Devin sign-in status.', 'error');
        });
      } catch (err) {
        devinOAuthState = null;
        setDevinUiMessage(err.message || 'Failed to start the Devin sign-in flow.', 'error');
        await loadSettings();
      }
    }

    async function completeDevinOAuthManual() {
      if (!devinOAuthState) return;
      const input = document.getElementById('devin-callback-url');
      const raw = input ? input.value.trim() : '';
      if (!raw) {
        setDevinUiMessage("Paste the full callback URL from the browser's address bar first.", 'error');
        return;
      }

      let code = raw;
      let state = '';
      const parseError = (() => {
        try {
          const url = new URL(raw);
          const errorParam = url.searchParams.get('error');
          if (errorParam) {
            return new Error(url.searchParams.get('error_description') || errorParam);
          }
          const codeParam = url.searchParams.get('code');
          if (!codeParam) {
            return new Error('No authorization code found in the callback URL.');
          }
          code = codeParam;
          state = url.searchParams.get('state') || '';
          return null;
        } catch (err) {
          // Not a URL — treat the pasted value as a bare authorization code.
          return err instanceof TypeError ? null : err;
        }
      })();
      if (parseError) {
        setDevinUiMessage(parseError.message, 'error');
        return;
      }

      try {
        setDevinUiMessage('Exchanging the Devin authorization code...', 'info');
        const res = await fetch('/api/oauth/devin/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flowId: devinOAuthState.flowId,
            code,
            state,
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to complete the Devin sign-in.');
        }

        clearDevinPollTimer();
        devinOAuthState = null;
        setDevinUiMessage('Connected Devin. Its models will appear once the health check finishes.', 'success');
        await loadSettings();
        await fetchData();
        scheduleKeySaveRefetch();
        maybeOnboardProvider('devin');
      } catch (err) {
        setDevinUiMessage(err.message || 'Failed to complete the Devin sign-in.', 'error');
      }
    }

    async function autoImportKiroToken() {
      try {
        setKiroUiMessage('Looking for a Kiro refresh token in ~/.aws/sso/cache...');
        const res = await fetch('/api/oauth/kiro/auto-import');
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.found) {
          throw new Error(data.error || 'No Kiro refresh token found in ~/.aws/sso/cache.');
        }

        clearKiroDevicePollTimer();
        kiroDeviceAuthState = null;
        kiroBrowserAuthState = null;
        setKiroUiMessage('Imported your Kiro refresh token from the AWS cache.', 'success');
        await loadSettings();
        await fetchData();
        maybeOnboardProvider('kiro');
      } catch (err) {
        setKiroUiMessage(err.message || 'Failed to auto-import a Kiro refresh token.', 'error');
      }
    }

    async function saveKiroRefreshToken() {
      const input = document.getElementById('key-kiro');
      const value = input ? input.value.trim() : '';
      if (!value) {
        setKiroUiMessage('Paste a Kiro refresh token before saving.', 'error');
        return;
      }

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: 'kiro', apiKey: value })
        });
        if (!res.ok) {
          throw new Error('Failed to save the Kiro refresh token.');
        }
        if (input) input.value = '';
        clearKiroDevicePollTimer();
        kiroDeviceAuthState = null;
        kiroBrowserAuthState = null;
        setKiroUiMessage('Saved the Kiro refresh token.', 'success');
        await loadSettings();
        await fetchData();
        maybeOnboardProvider('kiro');
      } catch (err) {
        setKiroUiMessage(err.message || 'Failed to save the Kiro refresh token.', 'error');
      }
    }

    function updateLogsPauseButton() {
      const pauseBtn = document.getElementById('logs-pause-toggle');
      if (!pauseBtn) return;
      pauseBtn.textContent = logsAutoRefreshPaused ? 'Resume Live Updates' : 'Pause Live Updates';
      pauseBtn.setAttribute('aria-pressed', logsAutoRefreshPaused ? 'true' : 'false');
    }

    function toggleLogsAutoRefresh() {
      logsAutoRefreshPaused = !logsAutoRefreshPaused;
      updateLogsPauseButton();
      if (!logsAutoRefreshPaused) {
        loadLogs(true);
      }
    }

    async function loadLogs(force = false) {
      if (!force && logsAutoRefreshPaused) return;
      try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        const container = document.getElementById('logs-container');

        if (logs.length === 0) {
          container.innerHTML = '<div style="padding: 32px; text-align: center; color: var(--text-muted); background: var(--card); border: 1px solid var(--border); border-radius: 12px;">No requests have been routed yet.</div>';
          return;
        }

        if (logsViewMode === 'history') {
          renderMessageHistory(logs, container);
          return;
        }

        const expandedCards = new Set();
        document.querySelectorAll('.log-card.expanded').forEach(card => {
          expandedCards.add(card.id);
        });

        container.innerHTML = logs.map(l => {
          const date = new Date(l.timestamp);
          const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const attempts = Array.isArray(l.attempts) ? l.attempts : [];
          const retryCount = typeof l.retryCount === 'number'
            ? l.retryCount
            : Math.max(0, attempts.length - 1);
          const hadFailover = retryCount > 0;
          let statusBadge;
          if (l.status === '200') statusBadge = '<span style="background: var(--status-success-bg); color: var(--status-success-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">200 OK</span>';
          else if (l.status === 'pending') statusBadge = '<span style="background: var(--status-info-bg); color: var(--status-info-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">Pending...</span>';
          else statusBadge = `<span style="background: var(--status-error-bg); color: var(--status-error-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">${escapeHtml(l.status)}</span>`;
          const resolvedModelChip = l.resolvedModel
            ? `<span style="background:var(--status-info-bg); color:var(--status-info-text); padding:2px 8px; border-radius:999px; font-size:0.7rem; font-weight:700;">resolved: ${escapeHtml(l.resolvedModel)}</span>`
            : '';

          const messagesArray = Array.isArray(l.messages) ? l.messages : (typeof l.messages === 'string' ? [{ role: 'raw', content: l.messages }] : []);
          const msgHtml = messagesArray.map(m => {
            const isSystem = m.role === 'system';
            const isUser = m.role === 'user';
            const colorVar = isSystem ? 'var(--warning)' : (isUser ? 'var(--success)' : 'var(--accent)');
            let formattedContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
            // Replace brackets with HTML entities to prevent rendering issues
            formattedContent = (formattedContent || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            return `
              <div style="margin-top: 12px; border-left: 3px solid ${colorVar}; padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: ${colorVar}; margin-bottom: 4px;">${escapeHtml(m.role || 'message')}</div>
                <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); max-height: 200px; overflow-y: auto; background: var(--chat-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--border);">${formattedContent}</div>
              </div>
            `;
          }).join('');

          let responseHtml = '';
          if (l.response) {
            const formattedResp = l.response.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            responseHtml = `
              <div style="margin-top: 12px; border-left: 3px solid var(--accent); padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-bottom: 4px;">ASSISTANT</div>
                <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); max-height: 300px; overflow-y: auto; background: var(--chat-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--border);">${formattedResp}</div>
              </div>
            `;
          }

          let toolCallsHtml = '';
          if (l.tool_calls && l.tool_calls.length > 0) {
            const numTools = l.tool_calls.length;
            const tcStr = JSON.stringify(l.tool_calls, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            toolCallsHtml = `
              <div style="margin-top: 12px; border-left: 3px solid var(--accent); padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-bottom: 4px;">TOOL CALLS (${numTools})</div>
                <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); max-height: 200px; overflow-y: auto; background: var(--chat-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--border);">${tcStr}</div>
              </div>
            `;
          }

          let functionCallHtml = '';
          if (l.function_call) {
            const fcStr = JSON.stringify(l.function_call, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            functionCallHtml = `
              <div style="margin-top: 12px; border-left: 3px solid var(--accent); padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-bottom: 4px;">FUNCTION CALL</div>
                <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); max-height: 200px; overflow-y: auto; background: var(--chat-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--border);">${fcStr}</div>
              </div>
            `;
          }

          let errorHtml = '';
          if (l.error) {
            let formattedErr = typeof l.error === 'string' ? l.error : JSON.stringify(l.error, null, 2);
            formattedErr = formattedErr.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            errorHtml = `
              <div style="margin-top: 12px; border-left: 3px solid var(--error); padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--error); margin-bottom: 4px;">PROXY ERROR</div>
                <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--status-error-text); max-height: 200px; overflow-y: auto; background: var(--status-error-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--status-error-border);">${formattedErr}</div>
              </div>
            `;
          }

          let failoverHtml = '';
          if (attempts.length > 0) {
            const attemptRows = attempts.map((a, idx) => {
              const code = a && a.status ? String(a.status) : 'unknown';
              const isOk = code === '200';
              const isRetryable = !!(a && a.retryable);
              const chipBg = isOk ? 'var(--status-success-bg)' : (isRetryable ? 'var(--status-warning-bg)' : 'var(--status-error-bg)');
              const chipFg = isOk ? 'var(--status-success-text)' : (isRetryable ? 'var(--status-warning-text)' : 'var(--status-error-text)');
              const model = a && a.model ? a.model : '(unknown model)';
              const provider = a && a.provider ? a.provider : '(unknown provider)';
              const duration = a && a.duration != null ? `${a.duration}ms` : 'n/a';
              const err = a && a.error
                ? `<div style="margin-top:4px; color: var(--text-muted); font-size:0.72rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${String(a.error).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
                : '';
              return `
                <div style="padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--chat-bg);">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <div style="font-size:0.78rem; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span style="color:var(--text-muted);">#${idx + 1}</span> ${escapeHtml(provider)}/${escapeHtml(model)}</div>
                    <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                      <span style="font-size:0.7rem; color:var(--text-muted);">${duration}</span>
                      <span style="background:${chipBg}; color:${chipFg}; padding:2px 6px; border-radius:999px; font-size:0.68rem; font-weight:700;">${code}</span>
                    </div>
                  </div>
                  ${err}
                </div>`;
            }).join('');

            failoverHtml = `
              <div style="margin-top: 12px; border-left: 3px solid ${hadFailover ? 'var(--warning)' : 'var(--accent)'}; padding-left: 12px;">
                <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: ${hadFailover ? 'var(--warning)' : 'var(--accent)'}; margin-bottom: 6px;">ROUTING ATTEMPTS ${hadFailover ? `(Failovers: ${retryCount})` : ''}</div>
                <div style="display:flex; flex-direction:column; gap:6px;">${attemptRows}</div>
              </div>
            `;
          }

          const logModelStatus = allModels ? (allModels.find(m => m.modelId === l.model)?.status || 'unknown') : 'unknown';
          const isBanned = logModelStatus === 'banned';
          // Use a stable unique id for toggling
          const cardId = 'log-' + l.timestamp.replace(/[^a-z0-9]/gi, '');
          const isExpanded = expandedCards.has(cardId) ? ' expanded' : '';
          return `
            <div class="log-card${isExpanded}" id="${cardId}">
              <div class="log-card-header" onclick="toggleLogCard('${cardId}')">
                <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
                  <span class="log-chevron">▶</span>
                  <div style="min-width:0;">
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap:wrap;">
                      <span style="font-weight: 600; font-size: 0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(l.model || '(unknown model)')}</span>
                      ${resolvedModelChip}
                      ${statusBadge}
                    </div>
                    <div style="font-size: 0.78rem; color: var(--text-muted); display: flex; gap: 10px; flex-wrap: wrap; margin-top:2px;">
                      <span>${timeStr}</span>
                      <span>•</span>
                      <span>${escapeHtml(l.provider || 'unknown provider')}</span>
                      ${hadFailover ? `<span>•</span><span style="color: var(--warning); font-weight: 600;">🔁 ${retryCount} failover${retryCount > 1 ? 's' : ''}</span>` : ''}
                      ${l.duration ? `<span>•</span><span>${l.duration}ms total</span>` : ''}
                      ${l.ttft != null && l.ttft !== l.duration ? `<span>•</span><span style="color: var(--accent);">⚡ ${formatSecondsFromMs(l.ttft)} TTFT</span>` : ''}
                      ${l.prompt_tokens != null || l.completion_tokens != null ? `<span>•</span><span style="color: var(--text-muted);"><span style="font-weight: 600; color: var(--text);">${fmtCompactTokens(l.prompt_tokens || 0)}</span> in / <span style="font-weight: 600; color: var(--text);">${fmtCompactTokens(l.completion_tokens || 0)}</span> out</span>` : ''}
                    </div>
                  </div>
                </div>
              </div>
              <div class="log-card-body">
                ${msgHtml}
                ${responseHtml}
                ${toolCallsHtml}
                ${functionCallHtml}
                ${failoverHtml}
                ${errorHtml}
                <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border); display:flex; justify-content:flex-end;">
                  <button onclick="event.stopPropagation(); toggleBan('${l.model}', '${logModelStatus}')" style="background: ${isBanned ? 'var(--border-subtle)' : 'var(--status-error-bg)'}; border: 1px solid ${isBanned ? 'var(--border-subtle)' : 'var(--status-error-border)'}; padding: 6px 14px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; color: ${isBanned ? 'var(--status-neutral-text)' : 'var(--status-error-text)'}; cursor: pointer;">${isBanned ? '✓ Unban Model' : '🚫 Ban Model'}</button>
                </div>
              </div>
            </div>
          `;
        }).join('');
      } catch (err) { console.error(err); }
    }

    function setLogsViewMode(mode) {
      logsViewMode = mode === 'history' ? 'history' : 'cards';
      const cardsBtn = document.getElementById('logs-mode-cards');
      const historyBtn = document.getElementById('logs-mode-history');
      if (cardsBtn && historyBtn) {
        cardsBtn.classList.toggle('active', logsViewMode === 'cards');
        historyBtn.classList.toggle('active', logsViewMode === 'history');
        cardsBtn.setAttribute('aria-selected', logsViewMode === 'cards' ? 'true' : 'false');
        historyBtn.setAttribute('aria-selected', logsViewMode === 'history' ? 'true' : 'false');
      }
      loadLogs(true);
    }

    function escapeHtml(value) {
      // Escapes quotes too so the result is safe in both text and attribute contexts.
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Renders a value as a single-quoted JS string literal that is safe to embed inside
    // ANY HTML attribute quote style. Dangerous characters are emitted as \uXXXX escapes,
    // which survive HTML attribute parsing unchanged (no entities, no raw quotes) and are
    // decoded by the JS engine inside the string literal -- so a quote in the data can
    // never terminate the attribute or the string.
    function jsStringAttr(value) {
      const s = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\\u0027')
        .replace(/"/g, '\\u0022')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      return "'" + s + "'";
    }

    // A provider card's title, linked to the page where that provider's credential comes
    // from. The link is the point of the title: a card that reads "No API key" is only
    // useful if the next click is the page that issues one, and the URL is already a
    // provider fact the server sends (`signupUrl`, derived from the provider descriptor).
    //
    // A provider with no credential page keeps the plain heading rather than a link to
    // nowhere. That is not an oversight: it is the signature of an unfinished fact
    // rather than of a missing feature. An imported provider with no
    // URL is a gap in `key-pages.json` waiting for someone to confirm the page, which is why
    // the curator refuses to guess one.
    // Every provider card carries the same switch, whatever its shape: a key field, an account
    // pool, or a device sign-in. Turning one off is a routing decision and nothing else — the key
    // and the accounts stay put, so the card explains that rather than looking like a teardown.
    function providerEnabledToggleHtml(provider) {
      const on = provider.enabled !== false;
      const title = on
        ? 'Stop routing to this provider. Its key, accounts and settings are kept.'
        : 'Route to this provider again.';
      return `<label style="display:flex; align-items:center; gap:6px; font-size:0.78rem; color:var(--text-muted); cursor:pointer; user-select:none;" title="${escapeAttr(title)}">
                  <input type="checkbox" ${on ? 'checked' : ''} onchange="setProviderEnabled(${jsStringAttr(provider.key)}, this.checked)">
                  <span>${on ? 'Enabled' : 'Disabled'}</span>
                </label>`;
    }

    function providerTitleHtml(provider, tooltip = 'Get API key') {
      const name = escapeHtml(provider.name);
      if (!provider.signupUrl) return `<h3 style="margin:0; font-size:1rem;">${name}</h3>`;
      // `noopener` because the target is a third-party page, and `noreferrer` because a
      // provider has no business seeing the local dashboard's URL.
      return `<a class="provider-title-link" href="${escapeHtml(provider.signupUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tooltip)}">${name}</a>`;
    }

    function quotaNumber(value, unit = '') {
      const number = Number(value);
      if (!Number.isFinite(number)) return '?';
      const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number);
      return unit === 'percent' ? `${formatted}%` : formatted;
    }

    function quotaUnitLabel(report) {
      const metric = String(report?.metric || '').toLowerCase();
      if (metric === 'requests' || report?.unit === 'requests') return 'requests';
      if (metric === 'tokens' || report?.unit === 'tokens') return 'tokens';
      if (metric === 'credits' || report?.unit === 'credits') return 'credits';
      if (metric === 'percent' || report?.unit === 'percent') return 'percent';
      return report?.unit || 'quota';
    }

    function quotaWindowLabel(report) {
      const window = report?.window ? String(report.window).trim() : '';
      if (window) return window;
      const scope = report?.scope ? String(report.scope).trim() : '';
      return scope && scope !== 'account' ? scope : 'quota';
    }

    function quotaMetricLabel(report) {
      const metric = String(report?.metric || '').toLowerCase();
      if (metric === 'requests') return 'Requests';
      if (metric === 'tokens') return 'Tokens';
      if (metric === 'credits') return 'Credits';
      if (metric === 'percent') return 'Quota';
      return 'Quota';
    }

    function quotaReportBarHtml(report) {
      const limit = report?.limit == null ? null : Number(report.limit);
      const remaining = report?.remaining == null ? null : Number(report.remaining);
      const used = report?.used == null ? null : Number(report.used);
      const unit = quotaUnitLabel(report);
      const isPercent = unit === 'percent';
      const window = quotaWindowLabel(report);
      const hasCompleteQuota = Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining);
      if (!hasCompleteQuota) {
        // A provider that reports consumption without an allowance is still reporting
        // something. Saying "no original total" while hiding the number it did send was
        // the least useful line on the card.
        const detail = Number.isFinite(used)
          ? `${quotaNumber(used, isPercent ? 'percent' : '')}${isPercent ? '' : ` ${unit}`} used`
          : 'no amount reported';
        const title = `${quotaMetricLabel(report)}: ${detail}; the provider reports no original total, so a percentage cannot be drawn (${window}).`;
        return `<div class="quota-unavailable" title="${escapeHtml(title)}">${escapeHtml(quotaMetricLabel(report))}: ${escapeHtml(detail)} · no original total reported.</div>`;
      }

      const percentage = Math.max(0, Math.min(100, (remaining / limit) * 100));
      const remainingText = quotaNumber(remaining, isPercent ? 'percent' : '');
      // A percentage window is already its own percentage: "87% / 100% remaining" said the
      // same thing twice and read as a fraction of a fraction.
      const amount = isPercent
        ? `${remainingText} remaining`
        : `${remainingText} / ${quotaNumber(limit, '')} ${unit} remaining`;
      const title = `${quotaMetricLabel(report)}: ${amount}; ${percentage.toFixed(1)}% of the original total remains (${window}).`;
      const stale = report?.freshness === 'stale' ? ' · stale' : '';
      const reset = Number.isFinite(Number(report?.resetAt)) && Number(report.resetAt) > Date.now()
        ? `<span data-quota-reset-at="${Number(report.resetAt)}" class="quota-reset"> · resets in ${escapeHtml(formatCountdown(Number(report.resetAt) - Date.now()))}</span>`
        : '';
      const fillColor = percentage <= 10 ? 'var(--error)' : percentage <= 30 ? 'var(--warning)' : 'var(--success)';

      return `
        <div class="quota-report" title="${escapeHtml(title)}">
          <div class="quota-report-heading">
            <span>${escapeHtml(quotaMetricLabel(report))} · ${escapeHtml(window)}</span>
            <strong>${percentage.toFixed(1)}%</strong>
          </div>
          <div class="quota-track" role="progressbar" aria-label="${escapeHtml(title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage.toFixed(1)}" aria-valuetext="${escapeHtml(amount)}">
            <div class="quota-fill" style="width:${percentage.toFixed(3)}%; background:${fillColor};"></div>
          </div>
          <div class="quota-report-meta">${escapeHtml(amount)}${reset}<span class="quota-stale">${escapeHtml(stale)}</span></div>
        </div>`;
    }

    // Only http(s) is ever rendered as a link. A quota source URL can come from an imported
    // provider catalog, so it is untrusted text even though hammer's own descriptors are not.
    function safeExternalHref(value) {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) return null;
      try {
        const parsed = new URL(raw, window.location.origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
      } catch {
        return null;
      }
    }

    // A published record only earns a card when it actually says something. A descriptor can
    // carry an empty `quota: {}` (all fields normalize to null), and rendering that would put
    // a reassuring "Published limits" box on a provider that has published nothing.
    function hasPublishedQuota(known) {
      if (!known || typeof known !== 'object') return false;
      if (Array.isArray(known.limits) && known.limits.some(limit => Number.isFinite(Number(limit?.limit)) && Number(limit.limit) > 0)) return true;
      if (typeof known.source === 'string' && known.source.trim()) return true;
      if (typeof known.sourceUrl === 'string' && known.sourceUrl.trim()) return true;
      if (known.window || known.limitScope) return true;
      return (known.steadyTokensPerMonth != null && Number.isFinite(Number(known.steadyTokensPerMonth)))
        || (known.signupCreditTokens != null && Number.isFinite(Number(known.signupCreditTokens)));
    }

    // Which recorded counter answers a published limit, by the period that limit applies to.
    // Pairing them explicitly is the point: a monthly grant drawn against one day's traffic,
    // or a daily cap drawn against a month's, is a percentage of nothing.
    // [counter, window phrase, empty-window phrase]. The third is spelled out rather than
    // composed from the second: "nothing recorded so far yet" is what a template produces when
    // a lifetime window is treated like a month.
    const RECORDED_BY_PERIOD = {
      tokens: {
        minute: ['tokensLastMinute', 'in the last minute', 'Nothing recorded in the last minute'],
        hour: ['tokensLastHour', 'in the last hour', 'Nothing recorded in the last hour'],
        day: ['tokensToday', 'today', 'Nothing recorded today yet'],
        week: ['tokensThisWeek', 'this week', 'Nothing recorded this week yet'],
        month: ['tokensThisMonth', 'this month', 'Nothing recorded this month yet'],
        lifetime: ['tokensLifetime', 'so far', 'Nothing recorded yet'],
      },
      requests: {
        minute: ['requestsLastMinute', 'in the last minute', 'Nothing recorded in the last minute'],
        hour: ['requestsLastHour', 'in the last hour', 'Nothing recorded in the last hour'],
        day: ['requestsToday', 'today', 'Nothing recorded today yet'],
        week: ['requestsThisWeek', 'this week', 'Nothing recorded this week yet'],
        month: ['requestsThisMonth', 'this month', 'Nothing recorded this month yet'],
        lifetime: [null, 'so far', 'Nothing recorded yet'],
      },
      // Credits have no recorded counterpart: hammer counts tokens and requests, never the
      // provider's money, so a credit cap shows as a number without a bar.
      credits: {
        minute: [null, 'in the last minute', 'Nothing recorded in the last minute'],
        day: [null, 'today', 'Nothing recorded today yet'],
        week: [null, 'this week', 'Nothing recorded this week yet'],
        month: [null, 'this month', 'Nothing recorded this month yet'],
        lifetime: [null, 'so far', 'Nothing recorded yet'],
      },
    };

    const QUOTA_PERIOD_LABEL = { minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month', lifetime: 'one-off' };

    function recordedForLimit(limit, recorded) {
      const spec = RECORDED_BY_PERIOD[limit?.metric]?.[limit?.period];
      if (!spec || !spec[0] || !recorded) return null;
      const value = Number(recorded[spec[0]]);
      if (!Number.isFinite(value)) return null;
      return { value, window: spec[1], empty: spec[2] };
    }

    function publishedLimitHtml(limit, recorded) {
      const total = Number(limit.limit);
      if (!Number.isFinite(total) || total <= 0) return '';
      const unit = limit.metric === 'requests' ? 'requests' : limit.metric === 'credits' ? 'credits' : 'tokens';
      const period = QUOTA_PERIOD_LABEL[limit.period] || limit.period || 'month';
      const measured = recordedForLimit(limit, recorded);
      const label = [limit.label, `${total.toLocaleString()} ${unit} / ${period}`].filter(Boolean).join(' · ');
      if (!measured) {
        return `
          <div class="quota-published-limit">
            <div class="quota-published-limit-meta">${escapeHtml(label)}</div>
          </div>`;
      }
      // Percent *remaining* drives the tone, matching every other bar on the card: the tone
      // answers "how much is left", not "how much was spent", so a nearly-spent grant cannot
      // read as healthy. The width is clamped because a bar cannot overflow its own track, but
      // the number beside it is not: past 100% the recorded spend is the whole fact, and
      // printing "100% used" for an account that has spent its grant four times over would be
      // the same kind of rounding the card exists to avoid.
      const usedPercentRaw = Math.max(0, (measured.value / total) * 100);
      const usedPercent = Math.min(100, usedPercentRaw);
      const remainingPercent = 100 - usedPercent;
      const tone = remainingPercent <= 10 ? 'error' : remainingPercent <= 30 ? 'warning' : 'success';
      const percentText = measured.value <= 0 ? '0' : usedPercentRaw < 0.01 ? '<0.01' : usedPercentRaw.toFixed(usedPercentRaw < 10 ? 2 : 1);
      return `
        <div class="quota-published-limit">
          <div class="quota-published-limit-meta">${escapeHtml(label)}</div>
          <div class="quota-track quota-track-published" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(remainingPercent)}" aria-label="${escapeHtml(`${limit.metric} recorded against the published ${period} limit`)}" title="${escapeHtml(`${measured.value.toLocaleString()} of ${total.toLocaleString()} ${unit} recorded ${measured.window} · ${percentText}% used`)}">
            <div class="quota-fill quota-fill-${tone}" style="width:${usedPercent.toFixed(2)}%"></div>
          </div>
          <div class="quota-published-recorded">${measured.value <= 0 ? escapeHtml(measured.empty) : `${measured.value.toLocaleString()} recorded by hammer ${escapeHtml(measured.window)} · ${percentText}% used`}</div>
        </div>`;
    }

    function publishedQuotaHtml(known, extraClass = '', recorded = null, title = 'Published limits') {
      if (!hasPublishedQuota(known)) return '';
      const meta = [];
      if (known.window || known.limitScope) meta.push([known.window, known.limitScope].filter(Boolean).join(' · '));
      const limits = Array.isArray(known.limits) ? known.limits.filter(limit => limit && Number(limit.limit) > 0) : [];
      const bars = limits.map(limit => publishedLimitHtml(limit, recorded)).join('');
      // The number's own provenance, when it came from somewhere other than the page the
      // citation points at (the vendored roster documents figures hammer's own rows do not).
      if (typeof known.numericSource === 'string' && known.numericSource.trim()) meta.push(known.numericSource.trim());
      const href = safeExternalHref(known.sourceUrl);
      const source = escapeHtml(known.source || 'Published provider limits');
      return `
        <div class="quota-published${extraClass ? ` ${extraClass}` : ''}">
          <div class="quota-published-title">${escapeHtml(title)}</div>
          ${bars}
          <div class="quota-published-source">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${source}</a>` : source}</div>
          ${meta.length > 0 ? `<div class="quota-published-meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
        </div>`;
    }

    function observedQuotaNotesHtml(provider) {
      const notes = Array.isArray(provider?.observedQuotaNotes)
        ? provider.observedQuotaNotes.filter(note => typeof note === 'string' && note.trim()).map(note => note.trim())
        : [];
      const servedToday = Number(provider?.observedRequestsToday);
      if (Number.isFinite(servedToday) && servedToday > 0) {
        notes.push(`${servedToday.toLocaleString()} request${servedToday === 1 ? '' : 's'} served today`);
      }
      if (notes.length === 0) return '';
      return `<ul class="quota-observed-notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`;
    }

    // ── The provider quota bars ──────────────────────────────────────────────────
    //
    // These are the provider's own reported allowances: requests, tokens, credits, or a
    // percentage window. A request count made by Hammer is deliberately not used here;
    // the credential-pool bar below is the separate account-rotation view.
    // The card always answers "what is this provider's quota?", naming where the answer came
    // from. A measured usage API, a limit seen in the last response headers, an amount the
    // card can observe itself, the catalog's published record, and "nothing published" are
    // five different claims, and the box says which one it is making rather than leaving the
    // provider silently unrepresented.
    function quotaBarsHtml(provider, quota = null) {
      let reports = Array.isArray(provider?.quotaReports) ? provider.quotaReports : [];
      let provenance = 'measured';
      let provenanceLabel = 'Provider-reported';
      if (reports.length === 0 && Array.isArray(provider?.observedQuota) && provider.observedQuota.length > 0) {
        reports = provider.observedQuota;
        provenance = 'observed';
        provenanceLabel = 'Observed';
      }
      // A provider may expose numeric limits only in the last response headers. Those
      // limits are still a real provider quota, so use them when the account usage
      // endpoint did not return a snapshot. They are deliberately a fallback, not a
      // second source that can overwrite the account-wide reports. The capacity half
      // (quota) is the source now — credit balance, free-tier percentage — while the
      // throttle half (rateLimit) keeps the per-window request/token counters.
      if (reports.length === 0 && quota) {
        const headerReports = [];
        if (quota.creditLimit != null) headerReports.push({ metric: 'credits', unit: 'credits', limit: quota.creditLimit, remaining: quota.creditRemaining, window: 'provider credit window', resetAt: quota.creditResetAt });
        if (quota.freeUsedPercent != null) headerReports.push({ metric: 'percent', unit: 'percent', limit: 100, remaining: Math.max(0, 100 - Number(quota.freeUsedPercent)), window: 'rolling 7-day free allowance', resetAt: quota.freeResetAt });
        if (headerReports.length > 0) {
          reports = headerReports;
          provenance = 'headers';
          provenanceLabel = 'From the last response';
        }
      }

      const known = hasPublishedQuota(provider?.knownQuota) ? provider.knownQuota : null;
      const knownHasNumericLimits = Boolean(
        known && Array.isArray(known.limits) && known.limits.some(limit => limit && Number(limit.limit) > 0),
      );
      const notes = observedQuotaNotesHtml(provider);
      // The real error, not a generic one: "No credentials configured" and "Usage endpoint
      // unavailable" are different facts about different problems.
      const error = provider?.quotaError
        ? `<div class="quota-error">${escapeHtml(String(provider.quotaError))}${reports.length > 0 ? ' Showing the quota data that is still available.' : ''}</div>`
        : '';

      // An empty report list means two different things, and the difference is time: hammer asked
      // and the provider measures nothing, or hammer asked and the answer has not arrived yet. The
      // router says which (quotaPending — see the usage decoupling in lib/server.js), because the
      // snapshot no longer waits for the refresh. A provider that publishes a limit keeps it either
      // way: that is an answer, not a pending question.
      if (reports.length === 0 && !known && !error && !notes && provider?.quotaPending === true) {
        return `
          <div class="quota-bars-section quota-bars-pending" aria-label="Provider quota" aria-busy="true">
            <div class="quota-bars-heading">Quota <span class="quota-provenance">Checking…</span></div>
            <div class="quota-unavailable">Reading this provider's usage. The numbers appear here as soon as it answers.</div>
          </div>`;
      }

      if (reports.length === 0) {
        if (!known && !error && !notes) {
          return `
            <div class="quota-bars-section quota-bars-empty" aria-label="Provider quota">
              <div class="quota-bars-heading">Quota <span class="quota-provenance">Not reported</span></div>
              <div class="quota-unavailable">This provider publishes no usage or quota endpoint, and hammer has not observed a limit yet.</div>
            </div>`;
        }
        provenance = knownHasNumericLimits ? 'published' : (notes ? 'observed' : known ? 'reference' : 'none');
        provenanceLabel = knownHasNumericLimits ? 'Published limits' : (notes ? 'Observed' : known ? 'Provider note' : 'Not reported');
        return `
          <div class="quota-bars-section quota-bars-${provenance}" aria-label="Provider quota">
            <div class="quota-bars-heading">Quota <span class="quota-provenance">${escapeHtml(provenanceLabel)}</span></div>
            ${known ? publishedQuotaHtml(known, '', provider?.recordedUsage, knownHasNumericLimits ? 'Published limits' : 'Provider note') : ''}
            ${!known && !error && !notes ? '<div class="quota-unavailable">This provider publishes no usage or quota endpoint, and hammer has not observed a limit yet.</div>' : ''}
            ${notes}
            ${error}
          </div>`;
      }

      const byAccount = new Map();
      reports.forEach((report) => {
        const index = Number.isInteger(report?.accountIndex) ? report.accountIndex : null;
        const key = index != null ? `index:${index}` : `label:${report?.accountLabel || report?.account || 'account'}`;
        if (!byAccount.has(key)) byAccount.set(key, { index, label: report?.accountLabel || report?.account || 'Account', reports: [] });
        byAccount.get(key).reports.push(report);
      });

      const pool = provider?.credentialPool;
      const groups = Array.from(byAccount.values()).map((group, position) => {
        const fallback = Number.isInteger(group.index) && Array.isArray(pool?.accounts) ? pool.accounts[group.index] : null;
        const label = group.label || fallback?.label || (group.index != null ? `Account ${group.index + 1}` : 'Account');
        return { ...group, position, label: String(label) };
      }).sort((a, b) => {
        if (a.index != null && b.index != null) return a.index - b.index;
        if (a.index != null) return -1;
        if (b.index != null) return 1;
        return a.position - b.position;
      });

      return `
        <div class="quota-bars-section quota-bars-${provenance}" aria-label="Provider quota">
          <div class="quota-bars-heading">${groups.length > 1 ? 'Account quotas' : 'Quota'} <span class="quota-provenance">${escapeHtml(provenanceLabel)}</span></div>
          <div class="quota-account-grid">
            ${groups.map(group => `
              <div class="quota-account-card">
                <div class="quota-account-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</div>
                <div class="quota-reports">${group.reports.map(quotaReportBarHtml).join('')}</div>
              </div>`).join('')}
          </div>
          ${known ? publishedQuotaHtml(known, 'quota-published-footnote', provider?.recordedUsage, knownHasNumericLimits ? 'Published limits' : 'Provider note') : ''}
          ${notes}
          ${error}
        </div>`;
    }

    // ── The credential pool bar ────────────────────────────────────────────────
    //
    // One segment per credential, in the order the router spends them: the first is used until
    // it is exhausted, then the second, and so on. That order is the reason this is a bar and not
    // a chart — reading left to right is reading the plan. Which segment is *serving* is a
    // separate fact (it is whichever one `servingIndex` names, and it is the accent-filled
    // segment), because once the first credential is spent the traffic has moved rightwards and
    // the spent one keeps its width.
    //
    // Nothing here invents a percentage of an allowance. The server captures the remaining
    // quota a provider reports for the credential that answered, and a bar only draws a
    // percentage when both remaining and limit are known. Google often reports neither for a
    // healthy free-tier key; those accounts say "Quota not reported" instead of substituting
    // traffic share, which is not an allowance.
    //
    // Google scopes quota per model, so the server sends the lowest known model window for an
    // account; the model is named beside the bar. An exhausted account still reports zero
    // because the bench itself is evidence that nothing is left in that account's window.
    function credentialBarHtml(provider) {
      const pool = provider ? provider.credentialPool : null;
      if (!pool || !Array.isArray(pool.accounts) || pool.accounts.length === 0) return '';
      const accounts = pool.accounts;
      const totalRequests = accounts.reduce((sum, account) => sum + (Number(account.requests) || 0), 0);
      const serving = accounts[pool.servingIndex] || null;

      const cards = accounts.map((account, i) => {
        const requests = Number(account.requests) || 0;
        const quota = account.quota && typeof account.quota === 'object' ? account.quota : null;
        const remaining = quota?.remaining == null ? null : Number(quota.remaining);
        const limit = quota?.limit == null ? null : Number(quota.limit);
        const hasLimit = Number.isFinite(limit) && limit > 0;
        const accountExhausted = Boolean(account.exhausted);
        const displayedRemaining = accountExhausted
          ? 0
          : Number.isFinite(remaining) ? remaining : null;
        const limited = !accountExhausted && displayedRemaining != null && displayedRemaining <= 0;
        const isServing = i === pool.servingIndex && !accountExhausted;
        const state = accountExhausted ? 'exhausted' : limited ? 'limited' : isServing ? 'serving' : 'waiting';
        const label = account.label || `Account ${i + 1}`;
        const model = quota?.modelId ? String(quota.modelId).replace(/^models\//, '') : '';
        // A zero quota for one model is not account exhaustion: Google scopes free-tier
        // allowances per model, and the account may still serve its other models.
        const stateLabel = accountExhausted
          ? 'Exhausted'
          : limited
            ? (model ? 'Model limited' : 'Limited')
            : isServing ? 'Serving' : 'Waiting';
        // A percentage window has no unit to count: "98 of 100 left" would read as 98
        // requests. Google reports a remaining fraction per model, not an allowance.
        const percentOnly = Boolean(quota?.percentOnly);
        const quotaText = displayedRemaining != null
          ? (percentOnly
            ? `${Math.round(displayedRemaining * 10) / 10}% left`
            : hasLimit
              ? `${displayedRemaining.toLocaleString()} of ${limit.toLocaleString()} left`
              : `${displayedRemaining.toLocaleString()} left`)
          : hasLimit
            ? `Limit ${limit.toLocaleString()} \u00b7 remaining not reported`
            : 'Quota not reported';
        let percent = null;
        if (displayedRemaining != null) {
          if (hasLimit) {
            percent = Math.max(0, Math.min(100, (displayedRemaining / limit) * 100));
          } else if (displayedRemaining === 0) {
            percent = 0;
          }
        }
        const resetMs = Number(quota?.resetsInMs) || Number(account.resetsInMs);
        const reset = Number.isFinite(resetMs) && resetMs > 0
          ? `<span class="credential-pool-reset" data-pool-reset-at="${Date.now() + resetMs}">resets in ${escapeHtml(formatCountdown(resetMs))}</span>`
          : '';
        const requestText = `${requests.toLocaleString()} request${requests === 1 ? '' : 's'}`;
        const scope = model ? `${model} \u00b7 ` : '';
        const title = `${label} \u2014 ${quotaText}${model ? ` (${model})` : ''} \u00b7 ${requestText}`
          + (accountExhausted ? ' \u00b7 exhausted' : limited ? (model ? ' \u00b7 model at quota' : ' \u00b7 at quota') : isServing ? ' \u00b7 serving' : ' \u00b7 waiting its turn');
        const bar = percent == null
          ? `<div class="quota-track credential-pool-track credential-pool-track-unknown" role="progressbar" aria-label="${escapeHtml(`${label} quota remaining`)}" aria-valuetext="${escapeHtml(`${quotaText}, ${stateLabel.toLowerCase()}`)}"><div class="quota-fill credential-pool-fill credential-pool-fill-unknown"></div></div>`
          : `<div class="quota-track credential-pool-track credential-pool-track-${state}" role="progressbar" aria-label="${escapeHtml(`${label} quota remaining`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}" aria-valuetext="${escapeHtml(`${quotaText}, ${stateLabel.toLowerCase()}`)}"><div class="quota-fill credential-pool-fill credential-pool-fill-${state}" style="width:${percent.toFixed(3)}%;"></div></div>`;
        return `
          <div class="credential-pool-account" data-pool-account="${i}" data-pool-quota-remaining="${displayedRemaining == null ? '' : displayedRemaining}" data-pool-quota-limit="${hasLimit ? limit : ''}" title="${escapeHtml(title)}">
            <div class="credential-pool-account-head">
              <span class="credential-pool-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
              <span class="credential-pool-state credential-pool-state-${state}">${stateLabel}</span>
            </div>
            ${bar}
            <div class="credential-pool-meta">${escapeHtml(`${scope}${quotaText} \u00b7 ${requestText}`)}${reset ? ` \u00b7 ${reset}` : ''}</div>
          </div>`;
      }).join('');

      const exhaustedAccounts = accounts.filter(account => account.exhausted);
      const modelLimitedAccounts = accounts.filter(account => !account.exhausted
        && account.quota && account.quota.remaining != null && Number(account.quota.remaining) === 0);
      const summary = [`${accounts.length} account${accounts.length === 1 ? '' : 's'}`];
      if (totalRequests > 0) summary.push(`${totalRequests.toLocaleString()} request${totalRequests === 1 ? '' : 's'}`);
      if (serving && !serving.exhausted && accounts.length > 1) summary.push(`${serving.label || 'first account'} serving`);
      // "All accounts at quota" is an account-wide claim. A model-scoped zero gets its own
      // sentence, because the account can still answer on models with quota left.
      if (exhaustedAccounts.length > 0) {
        summary.push(exhaustedAccounts.length === accounts.length
          ? 'all accounts at quota'
          : `${exhaustedAccounts.length} at quota`);
      }
      if (modelLimitedAccounts.length > 0) {
        summary.push(modelLimitedAccounts.length === accounts.length
          ? 'a model is at quota on every account'
          : `a model is at quota on ${modelLimitedAccounts.length} account${modelLimitedAccounts.length === 1 ? '' : 's'}`);
      }
      const perModel = accounts.some(account => account.quota && account.quota.modelId);

      return `
        <div class="quota-bars-section credential-pool-section" aria-label="Provider accounts">
          <div class="quota-bars-heading">Accounts <span class="quota-provenance">Quota</span></div>
          <div class="credential-pool-grid${accounts.length === 1 ? ' credential-pool-grid-single' : ''}">${cards}</div>
          <div class="credential-pool-summary">${escapeHtml(summary.join(' \u00b7 '))}</div>
          ${perModel ? '<div class="credential-pool-note">Quota is per model; each account shows its lowest reported model quota. A model at 0 does not mean the account is exhausted.</div>' : ''}
        </div>`;
    }

    // The bars' reset countdowns tick down locally, like the rate-limit ones: the server sends a
    // remaining duration once per render, and this walks it down without asking again.
    function updatePoolBarCountdowns() {
      document.querySelectorAll('[data-pool-reset-at], [data-quota-reset-at]').forEach(element => {
        const at = Number(element.dataset.poolResetAt ?? element.dataset.quotaResetAt);
        if (!Number.isFinite(at)) return;
        const remaining = at - Date.now();
        const isQuota = element.hasAttribute('data-quota-reset-at');
        const prefix = isQuota ? ' · ' : '';
        element.textContent = remaining > 0 ? `${prefix}resets in ${formatCountdown(remaining)}` : `${prefix}window passed`;
      });
    }

    function stableStringify(value) {
      if (value == null || typeof value !== 'object') {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
      }
      const keys = Object.keys(value).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
    }

    function getLocalDayKey(ts) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return 'invalid-day';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function simpleHash(input) {
      let hash = 2166136261;
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    }

    function normalizeMessageForHash(msg) {
      const normalized = {
        role: msg && msg.role ? String(msg.role) : 'unknown',
        name: msg && msg.name ? String(msg.name) : '',
        tool_call_id: msg && msg.tool_call_id ? String(msg.tool_call_id) : '',
        content: msg && msg.content != null ? msg.content : '',
      };
      if (msg && msg.tool_calls != null) normalized.tool_calls = msg.tool_calls;
      if (msg && msg.function_call != null) normalized.function_call = msg.function_call;
      return stableStringify(normalized);
    }

    function formatMessageContent(content) {
      if (typeof content === 'string') return content;
      if (content == null) return '';
      try {
        return JSON.stringify(content, null, 2);
      } catch {
        return String(content);
      }
    }

    function roleColor(role) {
      if (role === 'system') return 'var(--warning)';
      if (role === 'user') return 'var(--success)';
      if (role === 'assistant') return 'var(--accent)';
      if (role === 'tool') return 'var(--accent)';
      return 'var(--text-muted)';
    }

    function renderMessageHistory(logs, container) {
      const deduped = [];
      const seen = new Set();
      let insertSeq = 0;

      const mostRecentFirst = Array.isArray(logs) ? logs : [];
      for (const l of mostRecentFirst) {
        const timestamp = l && l.timestamp ? l.timestamp : null;
        const model = l && l.model ? l.model : '(unknown model)';
        const resolvedModel = l && l.resolvedModel ? l.resolvedModel : null;
        const sourceMessages = Array.isArray(l && l.messages)
          ? [...l.messages].reverse()
          : (typeof (l && l.messages) === 'string' ? [{ role: 'raw', content: l.messages }] : []);

        if (l && l.response) {
          const assistantCandidate = { role: 'assistant', content: l.response };
          const dedupeKey = `${getLocalDayKey(timestamp)}:${simpleHash(normalizeMessageForHash(assistantCandidate))}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            deduped.push({ role: 'assistant', content: l.response, timestamp, model, resolvedModel, tsMs: Date.parse(timestamp || ''), seq: insertSeq++ });
          }
        }

        if (l && l.tool_calls) {
          const toolCallsCandidate = { role: 'assistant', content: l.tool_calls };
          const dedupeKey = `${getLocalDayKey(timestamp)}:${simpleHash(normalizeMessageForHash(toolCallsCandidate))}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            deduped.push({ role: 'assistant', content: l.tool_calls, timestamp, model, resolvedModel, tsMs: Date.parse(timestamp || ''), seq: insertSeq++ });
          }
        }

        if (l && l.function_call) {
          const functionCallCandidate = { role: 'assistant', content: l.function_call };
          const dedupeKey = `${getLocalDayKey(timestamp)}:${simpleHash(normalizeMessageForHash(functionCallCandidate))}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            deduped.push({ role: 'assistant', content: l.function_call, timestamp, model, resolvedModel, tsMs: Date.parse(timestamp || ''), seq: insertSeq++ });
          }
        }

        for (const m of sourceMessages) {
          const role = m && m.role ? String(m.role) : 'unknown';
          const content = m && m.content != null ? m.content : '';
          const candidate = {
            role,
            content,
            name: m && m.name ? m.name : '',
            tool_call_id: m && m.tool_call_id ? m.tool_call_id : '',
            tool_calls: m && m.tool_calls ? m.tool_calls : undefined,
            function_call: m && m.function_call ? m.function_call : undefined,
          };
          const dedupeKey = `${getLocalDayKey(timestamp)}:${simpleHash(normalizeMessageForHash(candidate))}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          deduped.push({ role, content, timestamp, model, resolvedModel, tsMs: Date.parse(timestamp || ''), seq: insertSeq++ });
        }
      }

      deduped.sort((a, b) => {
        const aTs = Number.isNaN(a.tsMs) ? -Infinity : a.tsMs;
        const bTs = Number.isNaN(b.tsMs) ? -Infinity : b.tsMs;
        if (bTs !== aTs) return bTs - aTs;
        return a.seq - b.seq;
      });

      if (deduped.length === 0) {
        container.innerHTML = '<div style="padding: 24px; text-align:center; color:var(--text-muted); background: var(--card); border: 1px solid var(--border); border-radius: 12px;">No messages found in recent request logs.</div>';
        return;
      }

      container.innerHTML = deduped.map(item => {
        const role = item.role || 'unknown';
        const date = new Date(item.timestamp);
        const timeStr = Number.isNaN(date.getTime())
          ? 'Unknown time'
          : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = Number.isNaN(date.getTime())
          ? 'Unknown date'
          : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
        const content = escapeHtml(formatMessageContent(item.content));
        const badgeColor = roleColor(role);

        return `
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span style="font-size: 0.68rem; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${badgeColor};">${escapeHtml(role)}</span>
            </div>
            <div style="font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); background: var(--chat-bg); padding: 9px; border-radius: 7px; border: 1px solid var(--border); max-height: 240px; overflow-y:auto;">${content}</div>
            <div style="margin-top:8px; font-size: 0.74rem; color: var(--text-muted); display:flex; gap:8px; flex-wrap:wrap;">
              <span>${timeStr}</span>
              <span>•</span>
              <span>${dateStr}</span>
              <span>•</span>
              <span>${escapeHtml(item.model || '(unknown model)')}</span>
              ${item.resolvedModel ? `<span>•</span><span style="color:var(--status-info-text);">resolved: ${escapeHtml(item.resolvedModel)}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function toggleLogCard(id) {
      document.getElementById(id)?.classList.toggle('expanded');
    }

    async function toggleBan(modelId, currentStatus) {
      try {
        const isBanning = currentStatus !== 'banned';
        await fetch('/api/models/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, banned: isBanning })
        });

        // Immediately refresh telemetry data and logs
        await fetchData();
        if (typeof loadLogs === 'function') loadLogs(true);
      } catch (e) {
        console.error('Failed to toggle ban status', e);
      }
    }

    updateLogsPauseButton();

    // No polling loop. This dashboard is a snapshot of server state, so it is re-read only
    // when something the user did could have moved that state: the initial page load, a click
    // that mutates something (Test, Refresh, ban, key/config save), or the tab coming back to
    // the foreground. The server's state moves the same way — from evidence rather than from a
    // clock: a manual Test, or traffic the router actually served. A 4s timer used to re-read
    // this snapshot continuously, which had the server build ~400 rows of JSON every four
    // seconds whether or not anything had changed.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fetchData().catch(() => {}); // re-read when the user looks again
    });

    // The one thing that moves server state without the user doing anything: a proxied request
    // that had to fall back to another model. The router pushes it (see /api/events in
    // lib/server.js) because a snapshot this page only re-reads on user actions could never see
    // it — the KPI and both plots would keep naming the model that had just stopped answering.
    // EventSource reconnects on its own, so a router restart only costs the events it missed.
    function connectRouterEvents() {
      if (!window.EventSource) return;
      let source;
      try {
        source = new EventSource('/api/events');
      } catch (e) {
        console.error('Router event stream unavailable:', e);
        return;
      }
      source.onmessage = (event) => {
        let payload = null;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || payload.type === 'hello') return;

        // A provider-usage frame is the router saying the reports it could not produce when this
        // page asked for its snapshot have now landed (see the usage decoupling in lib/server.js).
        // It is handled before the revision bump below on purpose: it changes no row and no
        // selection, so it has no business invalidating a snapshot that is already in flight — and
        // it arrives about a second after boot, which is exactly when the first snapshot is still
        // on the wire. Counting it as a router event would discard that snapshot (see
        // routerEventRevisionAtStart in loadModelSnapshot) and leave the page on its skeleton.
        // The cards' quota boxes are the only thing it moves, so it refreshes that payload alone.
        if (payload.type === 'provider-usage') {
          if (usageFollowUpTimer) {
            clearTimeout(usageFollowUpTimer);
            usageFollowUpTimer = null;
          }
          refreshProviderUsageUi();
          return;
        }
        routerEventRevision++;

        // Paint the event before starting the relatively expensive snapshot request. A fallback
        // is a live routing decision, so every surface that names the current model — the table
        // highlight, KPI, topology, and speed/intelligence plot — must move on the SSE frame.
        if (payload.type === 'selection' && payload.source === 'fallback'
          && payload.modelId && payload.providerKey) {
          routerFallbackSelection = {
            modelId: payload.modelId,
            providerKey: payload.providerKey,
            fromModelId: payload.fromModelId || null,
            fromProviderKey: payload.fromProviderKey || null,
            reason: payload.reason || 'the selected model refused the request',
            at: payload.at || Date.now(),
          };
          currentBestModelId = payload.modelId;
          currentBestProviderKey = payload.providerKey;
          render();
          updateKPIs(allModels, currentBestModelId, currentBestProviderKey);
        } else if (payload.type === 'provider-health' && payload.scopeKey) {
          // Provider bench/recovery is part of the same live routing story. Mark the matching
          // rows immediately; the next snapshot replaces these optimistic fields with the full
          // provider-health object and its exact expiry.
          for (const row of allModels) {
            if (providerInstanceKey(row) !== payload.scopeKey) continue;
            row.providerBenched = payload.benched === true;
            row.routingEligible = !row.providerBenched && row.status === 'up';
            row.providerOutage = payload.benched
              ? { since: payload.since, until: payload.until, reason: payload.reason }
              : null;
          }
          render();
          updateKPIs(allModels, currentBestModelId, currentBestProviderKey);
        } else if (payload.type === 'evidence' && payload.providerKey && payload.modelId) {
          // The failed row's status and response are part of the same visible event. Patch the
          // local snapshot now; the refresh below supplies any fields the event intentionally
          // omits (quota windows, usage counters, and the complete server verdict).
          const row = allModels.find(m => m.providerKey === payload.providerKey && m.modelId === payload.modelId);
          if (row) {
            row.status = payload.status || row.status;
            row.lastError = { code: row.httpCode || '', message: payload.reason || 'The provider refused the request.', updatedAt: payload.at || Date.now() };
            row.lastResponse = {
              ...(row.lastResponse || {}),
              text: null,
              error: payload.reason || 'The provider refused the request.',
              ok: false,
              at: payload.at || Date.now(),
              routedFailure: payload.source || 'upstream',
            };
            row.routingEligible = false;
            render();
            updateKPIs(allModels, currentBestModelId, currentBestProviderKey);
          }
        } else if (payload.type === 'selection' && payload.source === 'restored') {
          routerFallbackSelection = null;
        } else if (payload.type === 'usage' && payload.key) {
          // A real request just landed on `key`. Pull the fresh series and redraw the plots
          // and that row's sparkline without reloading the whole snapshot.
          fetchUsageSeriesDelta().then(() => {
            drawUsagePlots();
          });
        }

        // Reconcile against the server in the background. The immediate paint above is never
        // removed merely because this request was queued; the event revision guard in fetchData
        // protects it from an older in-flight response.
        if (payload.type === 'selection' || payload.type === 'evidence' || payload.type === 'provider-health' || payload.type === 'pin') {
          scheduleRefresh();
        }
      };
      source.onerror = () => {
        // Browsers reconnect a dropped stream themselves; nothing to do but let them. The
        // connection is re-established on the next message, and that message also refreshes.
      };
    }
    connectRouterEvents();
    // A setup run left open when the page was reloaded is still on the server; re-attach to it
    // rather than making the user start over. A no-op when nothing is running.
    resumeOnboardingIfRunning();

    // ── The boot sequence ──────────────────────────────────────────────────────────────
    //
    // Four stages, in the order the page becomes useful, and each one starts as soon as the one
    // before it is on screen rather than as soon as it is finished:
    //
    //   0. the loading shell   — synchronously, before any request is sent (beginLoadingState)
    //   1. the table           — the model snapshot, painted on the frame that parses it
    //   2. the numbers         — text only, immediately after the table
    //   3. decoration, idle    — brand marks, both plots, then the provider grid
    //
    // The provider grid used to be built straight from this line *and* again from inside
    // fetchData, so every page load rendered ~125 cards twice and fetched /api/config and
    // /api/meta twice with them. It is now built exactly once, and last, because it is the
    // heaviest thing on the page and the least urgent: the user came for the table.
    //
    // A failed first snapshot is reported by the loader itself (failLoadingState), which leaves a
    // Retry button rather than a dashboard of zeroes; the panel is then still attempted below, so
    // a table that could not be read does not also cost the user their API-key controls.
    beginLoadingState();
    loadModelSnapshot().catch(() => {});
    // Safety net for the `?perf` report: if a stage never completes (a panel build that threw),
    // whatever was measured is still worth printing.
    if (PERF_ENABLED) setTimeout(perfReport, 15000);

    // ── The session usage plot's published API ─────────────────────────────────────────
    //
    // dashboard.js runs in its own script scope, so harness.js cannot call these by name. The
    // one thing it needs to hand over is a conversation's usage history (see
    // publishSessionUsage): the rail's plot is drawn by this file, but the page that knows
    // which conversation is open is the agent's. Exposing the publisher, and the repaint that
    // goes with it, is the whole contract — everything else stays private.
    // The console's right rail asks the same quota question about the routed model, and its
    // window builder lives in its own script. The estimated ceiling is one rule, not two, so it
    // is handed over rather than copied (see railQuotaWindows in harness.js).
    window.hxEstimateLimitCeiling = estimateLimitCeiling;
    window.publishSessionUsage = publishSessionUsage;
    window.requestSessionPlotRedraw = requestSessionPlotRedraw;
