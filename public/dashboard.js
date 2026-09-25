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
      'kpi-active', 'kpi-providers', 'kpi-best', 'speed-intell-count',
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
    // null = default multi-sort; otherwise { col: string, dir: 'asc'|'desc' }
    let sortState = null;
    let currentRenderedOrder = [];
    let graveyardCurrentOrder = [];
    // Unavailable rows are only built while the graveyard panel is open; this holds the
    // latest groups so opening it can build them on demand.
    let pendingGraveyardGroups = [];
    // Row keys with a 'Test' request currently in flight (guards the Response cell
    // against being clobbered by live polling re-renders while the test runs).
    let inflightTests = new Set();
    // Contradictory status/result pairs that have already received an automatic
    // re-test. The signature changes when the server reports a new result/state.
    let automaticRetestSignatures = new Map();
    // Automatic re-tests are trivial to schedule and expensive to run, so a row is held
    // to this cooldown however its signature changes: a model that keeps answering a
    // test with the same class of failure must not be re-tested every poll.
    const AUTOMATIC_RETEST_COOLDOWN_MS = 10 * 60_000;
    let automaticRetestAt = new Map();
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

    // Slope-line selector (Intelligence-vs-Speed plot → smartest routing).
    // Mirrors the server-side selectModelBySlope() pick so the plot is a live
    // preview of what the router will select when no model is manually pinned.
    let selectorState = { slope: null, minSpeed: null, minIntell: null };
    let selectorSaveTimer = null;
    let currentBestModelId = null;  // routed 'best' row from /api/models (pin > slope > intelligence)
    let currentBestProviderKey = null;
    // The model the router moved to mid-request, because the model it had selected refused the
    // request. A fallback never changes the next request's pin > slope > intelligence rule, but
    // it is temporarily shown as the serving model everywhere in the UI until the next snapshot
    // confirms the router's current state.
    let routerFallbackSelection = null;
    // Incremented for every event delivered by the router. A snapshot that was already in flight
    // when an event arrived must not roll the UI back to the selection it read before the event.
    let routerEventRevision = 0;
    let proxyErrorState = null;
    let scatterDrag = null;       // active threshold-line drag
    let scatterScales = null;     // plot extents, refreshed by every draw
    let selectorSlopeMax = 0;         // data-derived slider scale: slope of the 100% line (pure angle mapping)
    let selectorGuaranteeSlope = 0;   // fastest-row guarantee slope, applied only at 100%
    let isTableHovered = false;
    let logsViewMode = 'history';
    let logsAutoRefreshPaused = false;
    const PROVIDER_ERROR_MAX_AGE_MS = 120 * 60_000;
    let providerRefreshInFlight = new Set();
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
    let chatMessages = [];
    let chatInFlight = false;
    let chatSelectedModel = 'best';
    const CHAT_STORAGE_KEY = 'hammer-chat-v1';
    const CHAT_MODEL_STORAGE_KEY = 'hammer-chat-model-v1';
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
      'scaleway': 'Scaleway', 'kilocode': 'KiloCode',
      'empero': 'Empero Free', 'ollama': 'Ollama', 'kiro': 'Kiro', 'g4f': 'G4F',
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
      document.getElementById('chat-view').style.display = tab === 'chat' ? 'block' : 'none';
      document.getElementById('logs-view').style.display = tab === 'logs' ? 'block' : 'none';
      document.getElementById('settings-view').style.display = tab === 'settings' ? 'block' : 'none';

      if (tab === 'settings') {
        loadSettings();
      } else if (tab === 'logs') {
        loadLogs(true);
      } else if (tab === 'chat') {
        renderChatTranscript();
        scrollChatToBottom();
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
        // A fallback is an event, not a fourth selection rule. Keep its explanation only when
        // the model it named is still the server's current pin/slope/ranking pick; after a
        // slope or pin change, the old fallback must not relabel the new current model.
        const fallback = data.selection && data.selection.fallback;
        routerFallbackSelection = fallback
          && fallback.modelId === data.selection.modelId
          && (!fallback.providerKey || fallback.providerKey === data.selection.providerKey)
          ? { modelId: data.selection.modelId, providerKey: data.selection.providerKey, ...fallback }
          : null;
        updateChatModelOptions(allModels);

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

    function calculateBestModel(models) {
      // Same verdict as the dots and the KPIs: the highlighted model is one that can
      // actually take a request, not one whose last test hit a quota wall.
      const candidates = models.filter(m => isRowUp(m) && m.avg !== Infinity);
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

      const kpiActive = document.getElementById('kpi-active');
      const kpiProviders = document.getElementById('kpi-providers');
      if (kpiActive) kpiActive.textContent = onlineModelCount;
      if (kpiProviders) kpiProviders.textContent = onlineProviders.size;

      const bestModel = bestModelId
        ? models.find(m => m.modelId === bestModelId && (!bestProviderKey || m.providerKey === bestProviderKey))
        : null;
      setKpiBest(bestModel ? kpiBestText(bestModel) : 'None Online');
    }

    // Both plots, from one snapshot. Deferred to idle by the boot sequence and immediate for every
    // caller that is painting a live event — a fallback must move the pictures on the SSE frame.
    function drawPlots(models, bestModelId, bestProviderKey = null) {
      const bestModel = bestModelId
        ? models.find(m => m.modelId === bestModelId && (!bestProviderKey || m.providerKey === bestProviderKey))
        : null;
      drawBipartiteTopology(models, bestModel);
      drawSpeedIntellScatter(models);
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

    // The KPI 'Current' readout names the model and the provider offering it,
    // so identical model names from different providers stay distinguishable.
    // Hoisted as a function declaration because updateKPIs (textually earlier)
    // calls it from the poll callback.
    function kpiBestText(model) {
      const name = scatterShortName(model);
      const provider = providerInstanceName(model);
      return provider ? `${name} · ${provider}` : name;
    }

    // The 'Current' readout is a statement about routing, and its tooltip is the explanation of
    // that statement. They are written together here because the explanation is only ever
    // produced by the router-fallback branch of the scatter draw: a writer that set the name
    // alone left the page hovering a model with the story of a *different* one — text reading
    // the slope pick while the tooltip went on explaining a fallback the server had already
    // withdrawn. Naming one model and explaining another is worse than either, so every writer
    // goes through this.
    function setKpiBest(text, title = '') {
      const el = document.getElementById('kpi-best');
      if (!el) return;
      el.textContent = text;
      el.title = title;
    }

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

    // One row per measurable model/provider combination, using the same
    // numbers behind the main table's Intelligence / TTFT / Tok-s columns.
    // Returns those rows plus how many primary-table rows had no speed to plot,
    // so the card can report an omission instead of quietly drawing fewer dots
    // than the table has rows.
    function buildScatterRows(models) {
      const rows = [];
      let tableRowsWithoutSpeed = 0;
      for (const m of models || []) {
        if (!m || m.status === 'noauth') continue;
        // Same number the Intelligence column shows (the AA index): AA's own rating
        // when the row has one, otherwise the raw score mapped onto that same scale.
        const aaNum = Number(m.aa);
        const intellNum = (Number.isFinite(aaNum) && aaNum > 0) ? aaNum : Number(m.intell) * 100;
        const ttft = rowTtft(m);
        const tps = rowTps(m);
        // The row's own mean answered length. It is no longer what the score divides by
        // (that is the fixed reference above) — it rides along for the tooltip, so the user
        // can still see how much output the row's own numbers were measured over.
        const answeredTokens = rowSpeedTokens(m);
        // A dot needs both axes: an honest position needs a rating and a speed. The rate and
        // the prefill latency are the measurements; the answer length is the reference.
        const plottable = Number.isFinite(intellNum) && intellNum > 0
          && ttft != null && Number.isFinite(ttft) && ttft >= 0
          && tps != null && Number.isFinite(tps) && tps > 0;
        if (!plottable) {
          // Count only rows the main table shows, so the number matches what the user
          // can count for themselves (graveyard rows are not omissions from the table).
          if (!isRowStruck(m)) tableRowsWithoutSpeed += 1;
          continue;
        }
        rows.push({
          m,
          intell: intellNum,
          ttft,
          tps,
          tokens: answeredTokens,
          // S = R / (TTFT + R/TPS), in tokens per second, with R = SPEED_REFERENCE_TOKENS —
          // the same expression lib/utils.js computeRowSpeed() gives the router, so the line
          // the slider draws is the line the router lowers onto the plot.
          speed: SPEED_REFERENCE_TOKENS / (ttft / 1000 + SPEED_REFERENCE_TOKENS / tps),
        });
      }
      rows.sort((a, b) => a.intell - b.intell);
      return { rows, tableRowsWithoutSpeed };
    }

    // How far past the rest of the field a dot may sit before the axis stops calling
    // that speed a scale. A row at twice the speed of everything else would flatten every
    // other dot into the left margin, so the axis ends where the field ends and the row is
    // drawn at the edge with an arrow. Dimensionless: it describes the spread, not a speed.
    const SCATTER_OUTLIER_FACTOR = 2;

    // The axis maximum the field supports, plus how many rows sit past it. Walking the
    // speeds downwards, the first row that more than doubles the next one marks the end
    // of the field; everything above it is off-scale (and keeps its real speed for the
    // tooltip, the selection and the router — only its position is capped). A cut only
    // counts while the rows above the gap stay a strict minority: a 2x ratio between two
    // small speeds is ordinary jitter at the slow end of the field — and a lone slow row
    // leaves the same signature — so without this guard the walk cut deep into the list,
    // capped the axis at whichever small speed tripped the factor, and flagged nearly
    // every dot as off-scale. Once the rows above a gap outnumber the rows the cut
    // would keep on the axis, they are the field, not its outliers.
    function scatterAxisLimit(speeds) {
      const sorted = speeds.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1] > sorted[i] * SCATTER_OUTLIER_FACTOR) {
          // Off-scale rows must stay the exception, never more than the field the axis
          // keeps. Deeper gaps only stack more rows above them, so the walk can stop.
          if (i >= sorted.length - i) break;
          return { limit: sorted[i], offScale: i };
        }
      }
      return { limit: sorted[0] ?? 0, offScale: 0 };
    }

    // Plot geometry from the current rows: padded plot rect, data extents with
    // a little headroom, and the x/y mappers (the drag handlers reuse the same
    // scales through the global scatterScales).
    function computeScatterScales(rows, W, H) {
      const pad = { top: 44, right: 18, bottom: 46, left: 62 };
      const plotW = Math.max(40, W - pad.left - pad.right);
      const plotH = Math.max(40, H - pad.top - pad.bottom);

      const xs = rows.map(r => r.speed);
      const ys = rows.map(r => r.intell);
      let xMin = Math.min(...xs), xMax = Math.max(...xs);
      let yMin = Math.min(...ys), yMax = Math.max(...ys);
      if (xMax === xMin) { const p = (Math.abs(xMax) * 0.2) || 0.001; xMin -= p; xMax += p; }
      const { limit, offScale } = scatterAxisLimit(xs);
      if (offScale > 0) xMax = Math.min(xMax, limit);
      const xPad = (xMax - xMin) * 0.08 || (xMax * 0.05) || 1;
      xMin = Math.max(0, xMin - xPad);
      xMax += xPad;
      const ySpan0 = (yMax - yMin) || (Math.abs(yMax) * 0.05) || 10;
      yMin = Math.max(0, yMin - ySpan0 * 0.08);
      // An Artificial Analysis index cannot exceed 100, so the axis never needs to.
      yMax = Math.min(100, yMax + ySpan0 * 0.08);
      const ySpan = Math.max(1e-9, yMax - yMin);
      const xSpan = Math.max(1e-9, xMax - xMin);

      // Every x position goes through this mapper, so clamping here keeps dots, labels,
      // the threshold lines and the slope line inside the plot in one place: a row past
      // the axis limit rests on the right edge instead of stretching the scale.
      const xOf = s => pad.left + ((Math.min(Number(s), xMax) - xMin) / xSpan) * plotW;
      const yOf = i => pad.top + (1 - (i - yMin) / ySpan) * plotH;
      return { pad, plotW, plotH, H, xMin, xMax, yMin, yMax, xSpan, ySpan, xOf, yOf, offScale };
    }

    function drawScatterGrid(svg, scales) {
      const { pad, plotW, plotH, H, xMin, xMax, yMin, yMax, ySpan, xSpan, xOf, offScale } = scales;
      const muted = cssVarValue('--text-muted') || '#999';
      const g = svgEl('g', {});
      for (let i = 0; i <= 4; i++) {
        const gx = pad.left + (i / 4) * plotW;
        g.appendChild(svgEl('line', { x1: gx, y1: pad.top, x2: gx, y2: pad.top + plotH, stroke: muted, 'stroke-opacity': 0.16, 'stroke-width': 1 }));
        const tv = xMin + (i / 4) * xSpan;
        const txt = svgEl('text', { x: gx, y: pad.top + plotH + 15, fill: muted, 'font-size': '9px', 'text-anchor': 'middle' });
        const label = fmtScatterSpeed(tv);
        // The rightmost tick is where the axis stops, not where the field ends.
        txt.textContent = (offScale > 0 && i === 4) ? `${label} ➤` : label;
        g.appendChild(txt);
      }
      for (let i = 0; i <= 4; i++) {
        const gy = pad.top + (i / 4) * plotH;
        g.appendChild(svgEl('line', { x1: pad.left, y1: gy, x2: pad.left + plotW, y2: gy, stroke: muted, 'stroke-opacity': 0.16, 'stroke-width': 1 }));
        const iv = yMax - (i / 4) * ySpan;
        const txt = svgEl('text', { x: pad.left - 7, y: gy + 3, fill: muted, 'font-size': '9px', 'text-anchor': 'end' });
        txt.textContent = fmtScatterIntell(iv);
        g.appendChild(txt);
      }
      // Plot frame: gives the field a definite edge so the two axis captions can
      // stay tiny (the composite-speed formula lives in the SVG tooltip instead
      // of a caption line, which was the single cluttering sentence on the plot).
      g.appendChild(svgEl('rect', {
        x: pad.left, y: pad.top, width: plotW, height: plotH,
        fill: 'none', stroke: muted, 'stroke-opacity': 0.22, 'stroke-width': 1,
      }));
      const capX = svgEl('text', { x: pad.left + plotW, y: H - 10, fill: muted, 'font-size': '9px', 'text-anchor': 'end' });
      capX.textContent = 'faster →';
      g.appendChild(capX);
      const capY = svgEl('text', { x: 12, y: pad.top + plotH / 2, fill: muted, 'font-size': '9px', 'text-anchor': 'middle', transform: `rotate(-90 12 ${pad.top + plotH / 2})` });
      capY.textContent = 'AA index';
      g.appendChild(capY);
      svg.appendChild(g);
      const info = svgEl('title', {});
      info.textContent = 'Each dot is one model/provider combination.\n' +
        `x = speed = ${SPEED_REFERENCE_TOKENS} tokens / (TTFT + ${SPEED_REFERENCE_TOKENS} / tok/s) — every row scored at the same answer length, faster to the right\n` +
        'a dot marked ➤ is faster than the axis shows: its position is capped, its speed is not\n' +
        'y = Artificial Analysis Intelligence Index — smarter upward\n' +
        'Drag the edge lines to set minimums. Hover a dot for its numbers.';
      svg.appendChild(info);
    }

    function drawScatterPoints(svg, rows, scales) {
      const ring = cssVarValue('--card') || '#fff';
      const rSize = scatterDotSize(rows);
      // An inactive row keeps its position but gives up its bulk: a full stop marks where the
      // model measured without competing with the rows the router will actually use. A literal
      // rather than a fraction of `rSize`, because what makes it read as punctuation is its
      // absolute size — and a crowded field shrinks `rSize` to 3, which a fraction would have
      // dragged down with it.
      const inactiveR = 1.5;
      const plotRight = scales.pad.left + scales.plotW - 4;
      const axisLimit = scales.xMax;
      // Every row is a single filled point, whatever its verdict: a routable model is a
      // provider-hued dot and an exhausted, benched, or otherwise inactive model is a far
      // smaller mark in the verdict's colour. Full size follows the router's authoritative
      // `routingEligible` flag, not merely the row's last successful test: a healthy model whose
      // provider has been benched still reads `up` locally but must not be advertised as active.
      const verdictColorFor = (r) => {
        const kind = rowVerdict(r.m);
        if (kind === 'up') return ring;
        if (BENCHED_VERDICTS.has(kind)) return cssVarValue('--warning') || '#d29922';
        if (STRUCK_VERDICTS.has(kind) || kind === 'banned' || kind === 'excluded') return cssVarValue('--text-muted') || '#8b949e';
        return cssVarValue('--error') || '#e5484d';
      };
      for (const r of rows) {
        const hue = scatterProviderHue(r.m.providerKey);
        const routable = isRoutableRow(r);
        const verdictColor = verdictColorFor(r);
        const cx = scales.xOf(r.speed);
        const cy = scales.yOf(r.intell);
        const c = svgEl('circle', routable ? {
          cx, cy, r: rSize,
          fill: `hsl(${hue} 72% 55%)`, 'fill-opacity': 0.9,
          stroke: verdictColor, 'stroke-width': 1,
        } : {
          // A point, not an outline: a dashed ring has no centre, so an exhausted row read as a
          // hole in the plot rather than as a model that was measured. The opacity is higher
          // than a live dot's halo would suggest because the mark is this small — at a pixel and
          // a half across, anything faint enough to match a 9px dot's weight would simply vanish.
          cx, cy, r: inactiveR,
          fill: verdictColor, 'fill-opacity': 0.75,
        });
        const title = svgEl('title', {});
        const offAxis = r.speed > axisLimit;
        title.textContent = `${r.m.providerKey} · ${r.m.label || r.m.modelId}${r.m.personaModelId ? ` (catalog: ${r.m.personaModelId})` : ''}\n` +
          `intelligence ${fmtScatterIntell(r.intell)} · TTFT ${r.ttft} ms · ${r.tps} tok/s · ` +
          `speed ${fmtScatterSpeed(r.speed)} tok/s at a ${SPEED_REFERENCE_TOKENS}-token answer` +
          (r.tokens != null ? ` (this row's own mean answer: ${r.tokens} tokens)` : '') +
          (offAxis ? `\nfaster than this axis shows — drawn at the edge ${'➤'}` : '');
        c.appendChild(title);
        svg.appendChild(c);
        if (offAxis) {
          // The arrow is the row's real position: "somewhere to the right of here".
          const arrow = svgEl('text', {
            x: Math.min(cx + rSize + 1, plotRight), y: cy + 3,
            'font-size': '9px', fill: verdictColor, 'paint-order': 'stroke', stroke: ring, 'stroke-width': '2.5',
          });
          arrow.textContent = '➤';
          svg.appendChild(arrow);
        }
      }
    }

    // Visible labels: the model's short display name beside a dot, with a
    // card-colored halo so grid lines never cut through the text. Labeling every
    // dot turned the plot into a wall of text, so labels are placed greedily by
    // importance — the routed pick first, then the fastest / smartest rows, then
    // the highest-scoring remainder — and any label that would collide with an
    // already-placed label or overlap another dot is dropped (the count of
    // dropped labels is reported once, under the plot). Hovering still reveals
    // every dot's numbers. When the same model is offered by several providers
    // the provider is appended so every model/provider combination stays
    // identifiable.
    function drawScatterLabels(svg, rows, scales, selection) {
      const rSize = scatterDotSize(rows);
      // Real upstream names (the ones relays report for a persona entry) run
      // longer than catalog labels, so the budget is sized for them — the
      // collision test below, not this cap, is what keeps the plot readable.
      const maxLabelChars = 22;
      const plotRight = scales.pad.left + scales.plotW - 4;
      const labelFill = cssVarValue('--text') || '#444';
      const labelHalo = cssVarValue('--card') || '#fff';
      const accentColor = cssVarValue('--accent') || '#3b82f6';
      const pickRow = selection && selection.shownSelRow ? selection.shownSelRow : null;
      const maxLabels = rows.length > 60 ? 9 : (rows.length > 30 ? 12 : 16);

      const nameCounts = {};
      for (const r of rows) {
        const n = scatterShortName(r.m);
        nameCounts[n] = (nameCounts[n] || 0) + 1;
      }
      const labelFor = (r) => {
        const name = scatterShortName(r.m);
        // The model name is the label. The provider suffix exists only to
        // disambiguate a name offered by several providers, so it must never
        // starve the name it qualifies: append it when the pair fits the budget,
        // otherwise keep the full name and drop the suffix (the dot's hue already
        // carries the provider, and the tooltip names both).
        const shortName = name.length > maxLabelChars ? name.slice(0, maxLabelChars - 1) + '…' : name;
        const suffix = nameCounts[name] > 1 ? ` · ${r.m.providerKey}` : '';
        if (suffix && shortName.length + suffix.length <= maxLabelChars) return shortName + suffix;
        return shortName;
      };

      const maxIntell = Math.max(...rows.map(r => r.intell));
      const maxSpeed = Math.max(...rows.map(r => r.speed));
      const priority = (r) => {
        let p = 0;
        if (pickRow && r === pickRow) p += 1000;
        if (r.intell >= maxIntell) p += 200;
        if (r.speed >= maxSpeed) p += 200;
        if (!isRoutableRow(r)) p -= 400;
        // Remaining rows: higher intelligence than speed, so the top of the
        // field — where routing decisions actually happen — is labeled first.
        return p + ((r.intell - scales.yMin) / scales.ySpan) * 100;
      };
      const ordered = rows.slice().sort((a, b) => priority(b) - priority(a));
      // The routed pick is not a candidate like the others: it is placed first,
      // always, and only its own collision test is relaxed below.
      const candidates = pickRow ? [pickRow, ...ordered.filter(r => r !== pickRow)] : ordered;

      // Obstacles: every plotted dot except the one a label belongs to, plus each
      // placed label. A tiny inflation keeps labels from touching either.
      const dots = rows.map(r => ({
        r,
        x0: scales.xOf(r.speed) - rSize - 2, x1: scales.xOf(r.speed) + rSize + 2,
        y0: scales.yOf(r.intell) - rSize - 2, y1: scales.yOf(r.intell) + rSize + 2,
      }));
      const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const placed = [];
      let dropped = 0;
      // The "+N more" note is drawn in the bottom-right corner whenever labels had
      // to be dropped. When the rows outnumber the label budget a drop (and so the
      // note) is certain, so its room is reserved up front and no label can land
      // on top of it.
      const reserved = [];
      if (rows.length > maxLabels) {
        const worst = `+${rows.length} more — hover to identify`;
        const noteY = scales.pad.top + scales.plotH - 4;
        reserved.push({ x0: plotRight - worst.length * 4.4 - 2, x1: plotRight, y0: noteY - 8, y1: noteY + 3 });
      }

      const appendLabel = (r, rect, isPick) => {
        const t = svgEl('text', {
          x: rect.right ? rect.x0 : rect.x1,
          y: scales.yOf(r.intell) + 3,
          'font-size': isPick ? '9px' : '8.5px',
          'font-weight': isPick ? 600 : 400,
          fill: isPick ? accentColor : labelFill,
          stroke: labelHalo,
          'stroke-width': '2.5',
          'stroke-linejoin': 'round',
          'paint-order': 'stroke',
          'text-anchor': rect.right ? 'start' : 'end',
        });
        t.textContent = labelFor(r);
        svg.appendChild(t);
        placed.push(rect);
      };

      for (const r of candidates) {
        const isPick = pickRow && r === pickRow;
        if (!isPick && placed.length >= maxLabels) { dropped++; continue; }
        const label = labelFor(r);
        const w = label.length * 4.4 + 2;
        const dx = scales.xOf(r.speed);
        const dy = scales.yOf(r.intell);
        const rectFor = (right) => ({
          x0: right ? dx + rSize + 5 : dx - rSize - 5 - w,
          x1: right ? dx + rSize + 5 + w : dx - rSize - 5,
          y0: dy - 5, y1: dy + 5, right,
        });
        const fits = (rect) => rect.x0 >= scales.pad.left + 2 && rect.x1 <= plotRight
          && !placed.some(p => overlaps(p, rect))
          && !reserved.some(p => overlaps(p, rect))
          && !dots.some(d => d.r !== r && overlaps(d, rect));
        let rect = fits(rectFor(true)) ? rectFor(true) : (fits(rectFor(false)) ? rectFor(false) : null);
        if (!rect && isPick) {
          // The routed pick keeps its label even in a crowded or very small plot:
          // fall back to the roomier side and clamp the text inside the frame.
          rect = rectFor(rectFor(true).x1 <= plotRight);
          if (rect.x1 > plotRight) rect = { ...rect, x0: plotRight - w, x1: plotRight };
          if (rect.x0 < scales.pad.left + 2) rect = { ...rect, x0: scales.pad.left + 2, x1: scales.pad.left + 2 + w };
        }
        if (!rect) { dropped++; continue; }
        appendLabel(r, rect, isPick);
      }

      if (dropped > 0) {
        const muted = cssVarValue('--text-muted') || '#999';
        const more = svgEl('text', {
          x: plotRight, y: scales.pad.top + scales.plotH - 4,
          'font-size': '8.5px', fill: muted, 'text-anchor': 'end',
          stroke: labelHalo, 'stroke-width': '2.5', 'stroke-linejoin': 'round',
          'paint-order': 'stroke',
        });
        more.textContent = `+${dropped} more — hover to identify`;
        svg.appendChild(more);
      }
    }

    // ---- Slope-line selector overlay ----
    // Two draggable threshold lines (minimum intelligence / minimum speed) and
    // a slope-controlled line lowered onto the plot: the first eligible model
    // it touches is the pick. The pick mirrors selectModelBySlope() in
    // lib/utils.js; a manual pin (highlighted instead when active) outranks it.
    // The slider spans the full rotation of the line: 0% is horizontal and 100%
    // is vertical. The line's visual angle (not its numeric slope) advances
    // evenly, so dragging the slider rotates the line smoothly the whole way.
    // SLOPE_SLIDER_ANGLE_MAX is the angle at 100% (the line is drawn truly
    // vertical there and the pick is the fastest eligible row).
    const SLOPE_SLIDER_ANGLE_MAX = (85 * Math.PI) / 180;
    const SLOPE_SLIDER_ANGLE_TAN = Math.tan(SLOPE_SLIDER_ANGLE_MAX);
    // Data slope for a line at visual angle θ: tan(θ)·(ySpan/xSpan)·(plotW/plotH)
    // (converts plot-pixel geometry to intelligence-per-speed units). The max is
    // also floored by 2·ySpan/minSpeedGap so the 100% slope provably picks the
    // fastest eligible row — matching pickFastestRow / the vertical-line display
    // and, crucially, the server's selectModelBySlope() argmax, so the router
    // routes to exactly the model the dashboard shows as selected.
    //
    // The two are deliberately kept separate: selectorSlopeMax is the pure
    // angle mapping (equal slider steps = equal rotation, so mid-range drags
    // stay smooth), while the guarantee slope is only applied AT the 100% end
    // (see onSlopeSliderInput). Folding the guarantee into the max would push
    // the line vertical within the first third of the slider whenever two rows
    // have near-identical speeds.
    function computeSelectorSlopeMax(scales) {
      const { xSpan, ySpan, plotW, plotH } = scales;
      if (!(xSpan > 0) || !(plotW > 0) || !(plotH > 0)) return 0;
      return SLOPE_SLIDER_ANGLE_TAN * (ySpan / xSpan) * (plotW / plotH);
    }

    // Slope that makes the argmax pick (intelligence + slope·speed) the fastest
    // eligible row regardless of intelligence gaps: with slope ≥ 2·ySpan/minSpeedGap,
    // any speed difference ≥ the smallest gap outweighs any intelligence
    // difference (≤ ySpan), so the fastest row always wins at 100% — matching
    // pickFastestRow and the server's selectModelBySlope() argmax.
    function computeSelectorGuaranteeSlope(scales, rows) {
      const { xSpan, ySpan } = scales;
      if (!(xSpan > 0) || !(ySpan > 0)) return 0;
      let minSpeedGap = Infinity;
      const eligibleSpeeds = (rows || [])
        .filter(r => isRoutableRow(r))
        .map(r => Number(r.speed))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
      for (let i = 1; i < eligibleSpeeds.length; i++) {
        const gap = eligibleSpeeds[i] - eligibleSpeeds[i - 1];
        if (gap > 0 && gap < minSpeedGap) minSpeedGap = gap;
      }
      if (!Number.isFinite(minSpeedGap) || minSpeedGap <= 0) return 0;
      return 2 * ySpan / minSpeedGap;
    }

    // One definition of "what the plot shows as selected", shared by the label
    // pass and the overlay so the highlighted dot, its label, the Selected
    // readout, and the drawn line can never disagree. Mirrors the router's
    // precedence: manual pin > slope-line pick (only when a slope is set) > the
    // server-reported intelligence best. Rows the router will not use are never picked, so
    // pickSlopeModel/pickFastestRow apply the same eligibility the server does.
    function getSelection(rows) {
      const pinned = !!activePinnedModelId;
      // A canonical pin can resolve to a sibling row whose model id differs from the id the
      // user clicked. Compare the server's resolved current row, not the display id, or the
      // dashboard would let the local slope pick displace a pin the server is honoring.
      const currentBestRowKey = currentBestModelId
        ? getModelRowKey(currentBestProviderKey, currentBestModelId)
        : '';
      const pinIsCurrent = pinned && activePinnedRowKeys.includes(currentBestRowKey);
      const pinnedSelRow = pinIsCurrent
        ? rows.find(r => getModelRowKey(r.m) === currentBestRowKey)
        : null;
      const pinnedModel = (pinned && !pinnedSelRow)
        ? (allModels.find(x => pinIsCurrent
          ? getModelRowKey(x) === currentBestRowKey
          : x.modelId === activePinnedModelId && (!activePinnedProviderKey || x.providerKey === activePinnedProviderKey)) || null)
        : null;
      const slopeNum = Number(selectorState.slope);
      const slopeActive = selectorState.slope != null && Number.isFinite(slopeNum);
      // A vertical line means "the fastest row", which is only what a positive slope
      // asks for. Slope 0 is the flat line whose argmax is the smartest row at any
      // scale — and selectorSlopeMax is legitimately 0 (no speed or intelligence
      // spread yet, or before the first draw), which would otherwise make slope 0 look
      // like "max slope" and highlight the fastest row while the router, which treats
      // slope 0 as the argmax, routes to the smartest one.
      const atMaxSlope = slopeActive && slopeNum > 0 && slopeNum >= selectorSlopeMax;
      const slopePick = slopeActive && !pinIsCurrent ? (atMaxSlope ? pickFastestRow(rows) : pickSlopeModel(rows)) : null;
      // `currentBest` is the server's ordinary pin > slope > ranking result. A pin that has no
      // usable row is metadata, not a selection, so it must not hide the slope pick (or the
      // ranking fallback) that the router will actually use.
      const fallbackRow = (!slopePick && !slopeActive && currentBestModelId)
        ? rows.find(r => r.m.modelId === currentBestModelId && (!currentBestProviderKey || r.m.providerKey === currentBestProviderKey))
        : null;
      const fallbackModel = (!slopePick && !slopeActive && !fallbackRow && currentBestModelId)
        ? (allModels.find(x => x.modelId === currentBestModelId && (!currentBestProviderKey || x.providerKey === currentBestProviderKey)) || null)
        : null;
      // The router's own move, from the last snapshot. It is shown only when the fallback
      // model is still the current model; the current selection itself remains pin > slope >
      // ranking, never fallback-first.
      const routedFallbackRow = routerFallbackSelection
        ? (rows.find(r => r.m.modelId === routerFallbackSelection.modelId && (!routerFallbackSelection.providerKey || r.m.providerKey === routerFallbackSelection.providerKey)) || null)
        : null;
      const routedFallbackModel = (routerFallbackSelection && !routedFallbackRow)
        ? (allModels.find(x => x.modelId === routerFallbackSelection.modelId && (!routerFallbackSelection.providerKey || x.providerKey === routerFallbackSelection.providerKey)) || null)
        : null;
      return {
        pinned, pinnedSelRow, pinnedModel, slopeNum, slopeActive, atMaxSlope, slopePick,
        fallbackRow, fallbackModel,
        routedFallbackRow, routedFallbackModel,
        // A live fallback is the model answering this request right now, so it gets the
        // selection ring/label while the ordinary slope or ranking pick remains the line's
        // underlying rule. This is display state only; the next server snapshot re-evaluates it.
        shownSelRow: routedFallbackRow || pinnedSelRow || slopePick || fallbackRow,
        labelRow: routedFallbackModel || routedFallbackRow || pinnedSelRow || (pinIsCurrent ? pinnedModel : null) || slopePick || fallbackRow || fallbackModel || pinnedModel,
      };
    }

    function drawSelectorOverlay(svg, rows, scales, selection) {
      const { pad, plotW, plotH, xMin, xMax, yMin, yMax, ySpan, xSpan, xOf, yOf } = scales;
      const muted = cssVarValue('--text-muted') || '#999';
      const labelHalo = cssVarValue('--card') || '#fff';
      const accentColor = cssVarValue('--accent') || '#3b82f6';
      const rSize = scatterDotSize(rows);
      // The slope-line selector is always active: it drives smartest routing
      // whenever a slope is configured, so the line is always drawn in the
      // accent color and the pick is always what the router will select.
      const selLineColor = accentColor;

      const selClip = svgEl('clipPath', { id: 'sel-plot-clip' });
      selClip.appendChild(svgEl('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH }));
      svg.appendChild(selClip);

      const { pinned, slopeNum, slopeActive, atMaxSlope, slopePick, shownSelRow, labelRow, routedFallbackRow, routedFallbackModel } = selection;
      // The ring around the current model: the accent for a model the selector chose, a warning
      // hue for one the router had to move to — the difference between "the line touches this"
      // and "this is what is answering because something else stopped".
      const selectedRingColor = routedFallbackRow ? (cssVarValue('--warning') || '#d97706') : accentColor;

      // Minimum intelligence: horizontal dashed line, drag up/down. Unset, it
      // rests on the floor as a faint affordance and carries no value label —
      // the '—' label was pure clutter on every plot that never set a minimum.
      const miSet = selectorState.minIntell != null;
      const miVal = miSet ? Math.min(Math.max(selectorState.minIntell, yMin), yMax) : yMin;
      const miY = yOf(miVal);
      svg.appendChild(svgEl('line', {
        x1: pad.left, y1: miY, x2: pad.left + plotW, y2: miY,
        stroke: selLineColor, 'stroke-width': 1, 'stroke-dasharray': '5 4',
        'stroke-opacity': miSet ? 0.9 : 0.28,
      }));
      svg.appendChild(svgEl('line', {
        x1: pad.left, y1: miY, x2: pad.left + plotW, y2: miY,
        stroke: 'transparent', 'stroke-width': 14, 'data-sel-drag': 'minIntell', 'pointer-events': 'stroke',
      }));
      if (miSet) {
        const miTxt = svgEl('text', {
          x: pad.left + plotW - 4, y: Math.min(Math.max(miY - 4, pad.top + 22), pad.top + plotH - 2),
          'font-size': '9px', fill: selLineColor, 'text-anchor': 'end',
          'paint-order': 'stroke', stroke: labelHalo, 'stroke-width': 2.5,
        });
        miTxt.textContent = `min ${fmtScatterIntell(miVal)}`;
        svg.appendChild(miTxt);
      }

      // Minimum speed: vertical dashed line, drag left/right (same unset styling).
      const msSet = selectorState.minSpeed != null;
      const msVal = msSet ? Math.min(Math.max(selectorState.minSpeed, xMin), xMax) : xMin;
      const msX = xOf(msVal);
      svg.appendChild(svgEl('line', {
        x1: msX, y1: pad.top, x2: msX, y2: pad.top + plotH,
        stroke: selLineColor, 'stroke-width': 1, 'stroke-dasharray': '5 4',
        'stroke-opacity': msSet ? 0.9 : 0.28,
      }));
      svg.appendChild(svgEl('line', {
        x1: msX, y1: pad.top, x2: msX, y2: pad.top + plotH,
        stroke: 'transparent', 'stroke-width': 14, 'data-sel-drag': 'minSpeed', 'pointer-events': 'stroke',
      }));
      if (msSet) {
        const msTxt = svgEl('text', {
          x: Math.min(Math.max(msX + 4, pad.left + 2), pad.left + plotW - 56), y: pad.top + plotH - 6,
          'font-size': '9px', fill: selLineColor,
          'paint-order': 'stroke', stroke: labelHalo, 'stroke-width': 2.5,
        });
        msTxt.textContent = `min ${fmtScatterSpeed(msVal)}`;
        svg.appendChild(msTxt);
      }

      // The sloped line, lowered onto the plot: rests on the first model it
      // touches (nothing qualifies → it rests on the plot floor at bottom-left).
      // At maximum slope the line is fully vertical through the pick, which is
      // the fastest eligible row at that slope.
      if (Number.isFinite(slopeNum)) {
        if (shownSelRow && atMaxSlope) {
          svg.appendChild(svgEl('line', {
            x1: xOf(shownSelRow.speed), y1: pad.top,
            x2: xOf(shownSelRow.speed), y2: pad.top + plotH,
            stroke: accentColor,
            'stroke-width': 1.6,
            'stroke-opacity': 0.95,
            'clip-path': 'url(#sel-plot-clip)',
          }));
        } else {
          const intercept = shownSelRow
            ? (shownSelRow.intell + slopeNum * shownSelRow.speed)
            : (yMin + slopeNum * xMin);
          const intellAt = (s) => intercept - slopeNum * s;
          svg.appendChild(svgEl('line', {
            x1: xOf(xMin), y1: yOf(intellAt(xMin)),
            x2: xOf(xMax), y2: yOf(intellAt(xMax)),
            stroke: accentColor,
            'stroke-width': 1.6,
            'stroke-opacity': 0.95,
            'clip-path': 'url(#sel-plot-clip)',
          }));
        }
      }

      // Highlight the winning dot: a manual pin first, else the slope pick, else
      // the routed intelligence best. The same name also drives the KPI 'Current' readout
      // (and vice versa on the next poll), so Current is always the same model —
      // even mid-drag and when the selector falls back.
      if (slopeActive && !slopePick) {
        // A slope is set but nothing clears the minimums: routing falls back to
        // the intelligence best, so name that model instead of pretending the line
        // touches a dot.
        const fbModel = currentBestModelId
          ? allModels.find(x => x.modelId === currentBestModelId && (!currentBestProviderKey || x.providerKey === currentBestProviderKey))
          : null;
        const fbText = fbModel ? kpiBestText(fbModel) : null;
        // Not a fallback claim, so no explanation: this is the ordinary rules speaking, and the
        // title is cleared rather than inherited from whatever drew last.
        if (fbText) setKpiBest(fbText);
      } else if (labelRow) {
        // labelRow is either a scatter row (has .m) or a bare model object when
        // the pinned/best model has no speed data to plot.
        const kpiText = kpiBestText(labelRow.m || labelRow);
        if (shownSelRow) {
          svg.appendChild(svgEl('circle', {
            cx: xOf(shownSelRow.speed), cy: yOf(shownSelRow.intell), r: rSize + 4, fill: 'none',
            stroke: selectedRingColor, 'stroke-width': 2,
          }));
        }
        // The fallback explanation is a property of the current selection only. The server now
        // returns the ordinary pin/slope/ranking pick as `currentBest`; a prior fallback whose
        // model is no longer that pick must not add a warning ring or change the KPI.
        if (kpiText) {
          const fellBack = (routedFallbackRow || routedFallbackModel) && routerFallbackSelection;
          setKpiBest(
            fellBack ? `${kpiText} ↯ fallback` : kpiText,
            fellBack
              ? `Router fallback: ${kpiText} replaced ${routerFallbackSelection.fromProviderKey ? `${routerFallbackSelection.fromProviderKey}/` : ''}${routerFallbackSelection.fromModelId || 'the selected model'}, which refused the request${routerFallbackSelection.reason ? `: ${routerFallbackSelection.reason}` : '.'}`
              : '',
          );
        }
      }
    }

    function drawSpeedIntellScatter(models) {
      const svg = document.getElementById('speed-intell-svg');
      if (!svg) return;
      // The plot SVG now fills only the space between the title and the control
      // strips (see .scatter-card), so measure the SVG itself, not the card.
      const W = svg.clientWidth || 600;
      const H = svg.clientHeight || 340;

      const { rows, tableRowsWithoutSpeed } = buildScatterRows(models);

      const countEl = document.getElementById('speed-intell-count');
      if (countEl) {
        const combos = `${rows.length} combo${rows.length === 1 ? '' : 's'}`;
        // Off-axis rows are still counted as combos — they are plotted, at the edge, with
        // an arrow. Naming them here is what tells the reader the axis is a truncated one.
        const { offScale } = scatterAxisLimit(rows.map(r => r.speed));
        const extras = [
          tableRowsWithoutSpeed > 0 ? `${tableRowsWithoutSpeed} without speed data` : '',
          offScale > 0 ? `${offScale} past the axis ➤` : '',
        ].filter(Boolean).join(' · ');
        countEl.textContent = rows.length > 0
          ? (extras ? `${combos} · ${extras}` : combos)
          : 'no speed data yet';
      }

      // Selector state is part of the redraw key so threshold drags and slope
      // changes re-render immediately even when the model data is unchanged.
      // The routed best and pin are part of the redraw key too: when the server
      // reports a new best (pin toggled, slope save landed) the selection label
      // and KPI must re-render even though the rows and slider state didn't move.
      // Verdict and routing eligibility are row state even when every plotted number is
      // unchanged. Omitting them let a live failure or provider bench leave the old full-size
      // mark and selection ring in the SVG until some unrelated metric happened to change.
      const selHash = `${selectorState.slope ?? 'n'},${selectorState.minSpeed ?? 'n'},${selectorState.minIntell ?? 'n'},best=${currentBestModelId ?? 'n'}/${currentBestProviderKey ?? 'n'},pin=${activePinnedModelId ?? 'n'}/${activePinnedProviderKey ?? 'n'},fb=${routerFallbackSelection ? `${routerFallbackSelection.modelId}/${routerFallbackSelection.providerKey}` : 'n'}`;
      const hash = rows.map(r => {
        const routing = typeof r.m.routingEligible === 'boolean' ? r.m.routingEligible : 'legacy';
        return `${r.m.providerKey}|${r.m.modelId}|${r.intell}|${r.ttft}|${r.tps}|v=${rowVerdict(r.m)}|route=${routing}`;
      }).sort().join('~') + ':' + W + 'x' + H + ':sel=' + selHash;
      if (svg.dataset.hash === hash) return;
      svg.dataset.hash = hash;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = '';

      if (rows.length === 0) {
        selectorSlopeMax = 0;
        selectorGuaranteeSlope = 0;
        syncSelectorControls();
        const muted = cssVarValue('--text-muted') || '#999';
        const t = svgEl('text', { x: 14, y: 46, fill: muted, 'font-size': '12px' });
        t.textContent = 'No measurements yet — TTFT and tok/s are recorded from real requests and model tests.';
        svg.appendChild(t);
        return;
      }

      const scales = computeScatterScales(rows, W, H);
      scatterScales = scales;
      // Derived once, before anything is drawn: the overlay, the labels, the
      // 'Current' KPI, and the router all key off the same numbers.
      selectorSlopeMax = computeSelectorSlopeMax(scales);
      selectorGuaranteeSlope = computeSelectorGuaranteeSlope(scales, rows);
      const selection = getSelection(rows);
      drawScatterGrid(svg, scales);
      drawScatterPoints(svg, rows, scales);
      drawScatterLabels(svg, rows, scales, selection);
      drawSelectorOverlay(svg, rows, scales, selection);
      syncSelectorControls();
    }

    // ---- Slope-line selector helpers (Intelligence-vs-Speed plot) ----
    // Client-side mirror of selectModelBySlope() in lib/utils.js for immediate
    // feedback: eligible rows are 'up', not rate-limited, and above both
    // minimums; the pick maximizes intelligence + slope * speed, which is
    // exactly the first dot a rightward-descending line of the given slope
    // touches when lowered from above.
    // Rows the router would consider. The server marks each row with
    // routingEligible (its own status/rate-limit check), so the plot prefers that
    // flag and only falls back to a local check for payloads from older servers.
    // Using one flag keeps "what the plot selects" and "what the router routes"
    // identical by construction instead of by two hand-synced conditions.
    function isRoutableRow(r) {
      const m = r && r.m;
      if (!m) return false;
      if (typeof m.routingEligible === 'boolean') return m.routingEligible;
      // Older payloads carry no flag: fall back to the dashboard's own verdict, which is
      // the same set of conditions the server applies.
      return isRowUp(m);
    }

    function pickSlopeModel(rows) {
      const slope = Number(selectorState.slope);
      if (!Number.isFinite(slope)) return null;
      let best = null;
      let bestVal = -Infinity;
      for (const r of rows || []) {
        // Same eligibility as the server's selectModelBySlope(): status 'up' and
        // not HTTP-429 rate-limited. Credit exhaustion alone does NOT exclude a
        // row (the router only trusts the proxy's 429 signal), so the plot always
        // selects exactly what routing will pick.
        if (!isRoutableRow(r)) continue;
        if (selectorState.minSpeed != null && r.speed < selectorState.minSpeed) continue;
        if (selectorState.minIntell != null && r.intell < selectorState.minIntell) continue;
        const val = r.intell + slope * r.speed;
        if (val > bestVal) { best = r; bestVal = val; }
      }
      return best;
    }

    // The row a fully vertical line touches: the fastest eligible row above the
    // minimums (ties broken by intelligence) — the limit of the slope pick as
    // the slope goes to infinity.
    function pickFastestRow(rows) {
      let best = null;
      let bestSpeed = -Infinity;
      let bestIntell = -Infinity;
      for (const r of rows || []) {
        // Same eligibility as the server's selectModelBySlope() (see pickSlopeModel).
        if (!isRoutableRow(r)) continue;
        if (selectorState.minSpeed != null && r.speed < selectorState.minSpeed) continue;
        if (selectorState.minIntell != null && r.intell < selectorState.minIntell) continue;
        if (r.speed > bestSpeed || (r.speed === bestSpeed && r.intell > bestIntell)) {
          best = r;
          bestSpeed = r.speed;
          bestIntell = r.intell;
        }
      }
      return best;
    }

    function svgLocalPoint(svg, clientX, clientY) {
      try {
        const ctm = svg.getScreenCTM && svg.getScreenCTM();
        if (!ctm) return null;
        const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
      } catch { return null; }
    }

    function syncSelectorControls() {
      const slider = document.getElementById('sel-slope-slider');
      const valEl = document.getElementById('sel-slope-value');
      const slopeValue = selectorState.slope != null && Number.isFinite(Number(selectorState.slope))
        ? Number(selectorState.slope)
        : null;
      const scaled = slopeValue != null && selectorSlopeMax > 0;
      const frac = scaled
        ? Math.min(1, Math.atan(slopeValue * SLOPE_SLIDER_ANGLE_TAN / selectorSlopeMax) / SLOPE_SLIDER_ANGLE_MAX)
        : 0;
      if (slider) slider.value = String(Math.round(frac * 1000));
      if (valEl) {
        // Slope 0 is a real setting — the flat line that picks the smartest row — so it
        // reads as '0%'. Only a missing slope, or a positive one the plot has no scale
        // to position yet, shows as unset.
        valEl.textContent = slopeValue == null
          ? '—'
          : (slopeValue === 0 ? '0%' : (scaled ? `${Math.round(frac * 100)}%` : '—'));
      }
    }

    function onSlopeSliderInput() {
      const slider = document.getElementById('sel-slope-slider');
      if (!slider) return;
      const v = Number(slider.value) / 1000;
      // Map the slider position to the slope that draws the line at angle v·max:
      // slope = tan(v·θmax)·(selectorSlopeMax/tan(θmax)) — equal slider steps are
      // equal rotations, so the line sweeps smoothly from horizontal to vertical.
      // At 100% pin the slope to at least selectorSlopeMax (plus the guarantee
      // slope when it is larger, i.e. when two rows have near-identical speeds)
      // so the vertical-line branch and its fastest-model pick are exact, and the
      // router selects the same fastest row the plot highlights.
      // 0% is the scale-free end: slope 0 is meaningful to the router (the flat line
      // picks the highest-intelligence eligible row), so the leftmost position stores 0.
      // Clearing it to null instead made the router fall back to the Elo ranking, so the
      // one pick the slider promises at 0% was the one position that could not express
      // it. Above 0% a position still needs a plot scale to become a data slope.
      if (!(v > 0)) {
        selectorState.slope = 0;
      } else if (selectorSlopeMax > 0) {
        selectorState.slope = v >= 1
          ? Math.max(selectorSlopeMax, selectorGuaranteeSlope)
          : selectorSlopeMax * Math.tan(v * SLOPE_SLIDER_ANGLE_MAX) / SLOPE_SLIDER_ANGLE_TAN;
      } else {
        selectorState.slope = null;
      }
      scheduleSelectorSave();
      requestScatterRedraw();
    }

    function scheduleSelectorSave() {
      if (selectorSaveTimer) clearTimeout(selectorSaveTimer);
      selectorSaveTimer = setTimeout(async () => {
        selectorSaveTimer = null;
        try {
          const res = await fetch('/api/selector', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slope: selectorState.slope,
              minSpeed: selectorState.minSpeed,
              minIntell: selectorState.minIntell,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Selector update failed (HTTP ${res.status}).`);
          }
        } catch (err) {
          updateProxyErrorBanner({ message: err?.message || 'Selector update failed.', fallback: false });
        }
      }, 300);
    }

    // null / undefined / '' mean "not set". Number(null) is 0, so a plain
    // finite-number test would read an inert selector as slope 0 and make the
    // plot claim a selection the router is not making.
    function toSelectorOption(value) {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }

    async function loadSelectorState() {
      try {
        const res = await fetch('/api/selector');
        if (!res.ok) return;
        const sel = await res.json();
        selectorState = {
          slope: toSelectorOption(sel.slope),
          minSpeed: toSelectorOption(sel.minSpeed),
          minIntell: toSelectorOption(sel.minIntell),
        };
        syncSelectorControls();
        requestScatterRedraw();
      } catch { /* defaults until the next save */ }
    }

    let scatterRedrawQueued = false;
    function requestScatterRedraw() {
      if (scatterRedrawQueued) return;
      scatterRedrawQueued = true;
      requestAnimationFrame(() => {
        scatterRedrawQueued = false;
        drawSpeedIntellScatter(allModels);
      });
    }

    function initScatterControls() {
      const svg = document.getElementById('speed-intell-svg');
      if (!svg) return;
      svg.addEventListener('pointerdown', (e) => {
        const hit = e.target && e.target.closest && e.target.closest('[data-sel-drag]');
        if (!hit) return;
        scatterDrag = { type: hit.getAttribute('data-sel-drag') };
        try { svg.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (!scatterDrag) return;
        const pt = svgLocalPoint(svg, e.clientX, e.clientY);
        const s = scatterScales;
        if (!pt || !s) return;
        if (scatterDrag.type === 'minIntell') {
          const frac = 1 - (pt.y - s.pad.top) / s.plotH;
          selectorState.minIntell = Math.min(s.yMax, Math.max(s.yMin, s.yMin + frac * s.ySpan));
        } else if (scatterDrag.type === 'minSpeed') {
          const frac = (pt.x - s.pad.left) / s.plotW;
          selectorState.minSpeed = Math.min(s.xMax, Math.max(s.xMin, s.xMin + frac * s.xSpan));
        } else {
          return;
        }
        scheduleSelectorSave();
        requestScatterRedraw();
      });
      const endDrag = () => { scatterDrag = null; };
      svg.addEventListener('pointerup', endDrag);
      svg.addEventListener('pointercancel', endDrag);

      const slider = document.getElementById('sel-slope-slider');
      if (slider) slider.addEventListener('input', onSlopeSliderInput);

      // Redraw when the SVG's own box changes (window resize, the grid stretching
      // this card to match the topology card, fonts settling): the viewBox is set
      // from the measured box, so a stale viewBox letterboxes the plot inside the
      // card until the next poll. The hash guard makes this a no-op when the box
      // didn't actually change, so the plot always fills the space it's given.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => requestScatterRedraw());
        ro.observe(svg);
      }

      loadSelectorState();
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
        if (m.label && m.label.trim()) return m.label.trim();
        // Fallback: strip provider prefixes from modelId
        return (m.modelId || '').replace(/^[a-z0-9_-]+\//i, '').replace(/[-_](free|latest|snapshot|preview)$/i, '').trim() || m.modelId || 'Unknown';
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
        // Baidu's ERNIE, Doubao's own ids on a gateway, Meituan's LongCat, and the two labs
        // whose HF org name is all a node ever carries.
        'baidu': 'baidu.com', 'ernie': 'baidu.com',
        'doubao': 'doubao.com',
        'longcat': 'longcat.chat', 'meituan': 'longcat.chat',
        'nex-agi': 'nex-agi.com', 'dots-studio': 'dots.studio',
        // SenseTime's SenseNova and iFlytek's Spark: `sensenova.cn` serves no icon, the
        // company's own site does, and Spark's brand site is the console it sends users to.
        'sensenova': 'sensetime.com',
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
        // Meta's named open families — Muse Glimmer and Muse Spark sit beside Llama without it.
        'muse': 'meta.com',
        'nemotron': 'nvidia.com', 'nvidia': 'nvidia.com',
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
        'kilo-auto': 'kilocode.com', 'openrouter': 'openrouter.ai',
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
        'granite': 'ibm.com', 'ibm': 'ibm.com', 'allam': 'sdaia.gov.sa',
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
      // Which link is blue is a function of the *active* model as much as of the membership, so
      // the active pair belongs in the rebuild key: the classes are refreshed every render, but
      // a pick that moves to a pair the plot has not drawn yet needs the plot to redraw — a
      // signature that only watched membership would leave the serving path unmarked.
      const bestSig = bestModel ? getModelRowKey(bestModel) : '';
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
            img.setAttribute('href', faviconHrefs([modelDom])[0] || '');
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
      function isModelBest(um) {
        const bestKey = bestModel ? providerInstanceKey(bestModel) : '';
        return bestModel && um._providers.some(p => p.model.modelId === bestModel.modelId && p.key === bestKey);
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
          // Exactly one link wears the flowing blue: the serving path — the active model to the
          // provider instance that serves that exact row, the same pair the blue ring marks.
          // The best model's *other* providers stay green: they can serve it, but the router is
          // not using them, and matching on the model alone is what painted several paths blue
          // at once (isModelBest is true for the whole best group, not for one of its links).
          const servingProviderKey = bestModel ? providerInstanceKey(bestModel) : '';
          const isServingPath = Boolean(bestModel) && isModelBest(um) && line.dataset.pkey === servingProviderKey;
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
        // The provider serving the selected (best) model also gets the blue ring.
        const servesBest = Boolean(bestModel) && providerInstanceKey(bestModel) === pk;
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

    function setSort(col) {
      if (sortState && sortState.col === col) {
        if (sortState.dir === 'asc') {
          sortState = { col, dir: 'desc' };
        } else {
          // third click resets to default
          sortState = null;
        }
      } else {
        sortState = { col, dir: 'asc' };
      }
      updateSortHeaders();
      render(true);
    }

    function resetSort() {
      sortState = null;
      updateSortHeaders();
      render(true);
    }

    function updateSortHeaders() {
      const cols = ['model', 'ctx', 'intell', 'status'];
      const resetBtn = document.getElementById('sort-reset-btn');
      cols.forEach(col => {
        const th = document.getElementById(`th-${col}`);
        const arrow = document.getElementById(`arrow-${col}`);
        th.classList.remove('sort-active');
        if (sortState && sortState.col === col) {
          th.classList.add('sort-active');
          arrow.textContent = sortState.dir === 'asc' ? '↑' : '↓';
        } else if (!sortState && col === DEFAULT_SORT_COL) {
          // No explicit sort: the table falls back to the default chain, whose
          // primary key is intelligence — surface that in the header instead of
          // showing the column as unsorted.
          th.classList.add('sort-active');
          arrow.textContent = DEFAULT_SORT_DIR === 'asc' ? '↑' : '↓';
        } else {
          arrow.textContent = '↕';
        }
      });
      if (resetBtn) resetBtn.style.display = sortState ? 'inline-block' : 'none';
    }

    // Returns a comparable value for each column (lower = sorts first in asc)
    function colValue(m, col) {
      switch (col) {
        case 'status': return isRowUp(m) ? 0 : 1;
        case 'qos': return m.qos || 0;
        case 'intell': return getBenchmarkSortValue(m.intell);
        case 'rate': return isRateLimitedRow(m) ? 1 : 0;
        case 'health': return m.qos || 0; // fallback just in case
        case 'model': return (m.label || '').toLowerCase();
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

    // Compares two models using the current sortState (or the default chain when unset)
    function compareModels(a, b) {
      if (!sortState) {
        return compareByChain(a, b, DEFAULT_SORT_CHAIN);
      }

      const { col, dir } = sortState;
      const sign = dir === 'asc' ? 1 : -1;

      // Build chain: primary column first, then the remaining default columns as tiebreakers
      const tiebreakers = DEFAULT_SORT_CHAIN.filter(c => c.col !== col);

      const av = colValue(a, col);
      const bv = colValue(b, col);
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
      if (cmp !== 0) return sign * cmp;
      return compareByChain(a, b, tiebreakers);
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

    function sortedGroups(groups) {
      return groups
        .map(g => ({ ...g, members: [...g.members].sort(compareProviders) }))
        .sort((a, b) => {
          const cmp = compareModels(a.members[0], b.members[0]);
          if (cmp !== 0) return cmp;
          return (a.label || '').localeCompare(b.label || '');
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

    // `opts.onlyUsable` (the default) restricts the *measured* columns to providers the
    // router would actually use right now. A model heading must not advertise the speed,
    // context or 'Ready' result of a provider that is rate-limited or timed out: that is
    // how a heading could read "0/7 providers" while still showing 0.35s / 24.1 tok/s /
    // Ready from rows that cannot answer. The graveyard opts out — there the row's own
    // history is the point, and a struck row is never "usable" in the first place.
    function getGroupSummary(g, opts = {}) {
      const members = g.members;
      const usable = members.filter(isRowUsable);
      const measured = opts.onlyUsable === false ? members : usable;
      let bestQos = 0, bestIntell = 0;
      let minTtft = null, maxTps = null, bestCtx = null;
      let bestCtxMember = null;
      let bestIntellMember = members[0];
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
        if (memberTtft != null && (minTtft === null || memberTtft < minTtft)) minTtft = memberTtft;
        if (memberTps != null && (maxTps === null || memberTps > maxTps)) maxTps = memberTps;
        const ctx = m.contextTokens;
        if (ctx != null && (bestCtx === null || ctx > bestCtx)) { bestCtx = ctx; bestCtxMember = m; }
      }
      return { bestQos, bestIntell, minTtft, maxTps, bestCtx, upCount, usable, bestIntellMember, bestCtxMember };
    }

    function groupRowInnerHTML(g) {
      const members = g.members;
      const s = getGroupSummary(g);
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
          <td>
            <div style="font-weight: 700; font-size: 0.92rem; display:flex; align-items:center; gap:8px;">
              <span title="${escapeHtml(cleanHeadingModelName(g.label))}">${emoji}${escapeHtml(cleanHeadingModelName(g.label))}</span>
              ${members.length > 1 ? `<button type="button" onclick="event.stopPropagation(); toggleModelGroup('${escapeAttr(g.key)}')" title="${collapsedModelGroups.has(g.key) ? 'Expand' : 'Collapse'} providers" style="border:0; background:transparent; color:var(--text-muted); cursor:pointer; padding:0 3px; font-size:0.85rem;">${collapsedModelGroups.has(g.key) ? '▶' : '▼'}</button>` : ''}
              <button type="button" class="pin-row-btn ${isPinned ? 'pinned' : ''}" data-pin-model="${escapeAttr(first.modelId)}" data-pin-group="${escapeAttr(g.key)}" title="${isPinned ? 'Unpin model family' : 'Pin model family'}">📌</button>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${members.length === 1 ? escapeHtml(providerInstanceName(first)) : `${escapeHtml(g.canonicalId)} • ${s.upCount}/${members.length} providers`}</div>
          </td>
          <td><div style="font-weight: 600;">${(() => {
            const rating = getBenchmarkTableDisplayValue(s.bestIntellMember.intell, s.bestIntellMember.qualitySource, s.bestIntellMember.qualityDetail, s.bestIntellMember.aa);
            // The rating describes the model rather than any one provider, so it stays
            // readable when nothing is available — but beside a "0/N providers" subtitle
            // it must not read as live capacity, so it is muted and labelled for what it
            // is. Every measured cell next to it is blank by then (see getGroupSummary).
            return s.usable.length === 0
              ? `<span style="opacity:0.55;" title="No provider available — this is the model's rating, not a live measurement">${rating}</span>`
              : rating;
          })()}</div></td>
          ${formatTtftCell(s.minTtft, 'ttft')}
          ${formatTpsCell(s.maxTps, 'tok/s')}
          <td>
            <div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${s.bestCtxMember && s.bestCtxMember.contextSource === 'observed' ? 'Bounds inferred from real requests' : (s.bestCtxMember && s.bestCtxMember.context ? 'Known context window' : 'Largest context window among providers')}">${s.bestCtxMember && s.bestCtxMember.context ? escapeHtml(s.bestCtxMember.context) : '<span style="font-size:0.75rem;color:var(--text-muted);">—</span>'}</div>
          </td>
          <td>${groupStatusHtml}</td>
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
      tr.innerHTML = groupRowInnerHTML(g);
      applyGroupRowClick(tr, g);
      const pinButton = tr.querySelector('.pin-row-btn');
      const pinned = isFamilyPinnedGroup(g.members);
      bindPinButton(pinButton, { modelId: g.members[0]?.modelId, groupKey: g.key, pinned });
      return tr;
    }

    function updateGroupRow(row, g) {
      row.innerHTML = groupRowInnerHTML(g);
      row.classList.toggle('row-best', isCurrentBestGroup(g));
      // Rebind so the handler closes over the freshly rendered member data.
      applyGroupRowClick(row, g);
      const pinButton = row.querySelector('.pin-row-btn');
      const pinned = isFamilyPinnedGroup(g.members);
      bindPinButton(pinButton, { modelId: g.members[0]?.modelId, groupKey: g.key, pinned });
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
      let filtered = allModels.filter(m =>
        m.label.toLowerCase().includes(searchTerm) ||
        m.providerKey.toLowerCase().includes(searchTerm) ||
        (m.originLabel || '').toLowerCase().includes(searchTerm) ||
        m.modelId.toLowerCase().includes(searchTerm) ||
        (m.realModelId || '').toLowerCase().includes(searchTerm)
      );

      // Models without credentials remain in the unavailable table so their
      // No Auth status is visible instead of silently disappearing.

      let expanded;
      let graveyardGroups = [];

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
      const { mainGroups, graveyardGroups: grave } = (precomputedGroups && !searchTerm)
        ? precomputedGroups
        : splitDisplayGroups(sortedGroups(groupModels(filtered)));
      graveyardGroups = grave;

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

      // Update provider name + pin button (ban status can change)
      const modelCell = row.cells[0];
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
      // Update context window (known limit or observed bounds)
      const ctxCell = row.cells[4];
      ctxCell.innerHTML = m.context
        ? `<div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${m.contextSource === 'observed' ? 'Bounds inferred from real requests' : 'Known context window'}">${escapeHtml(m.context)}</div>`
        : '<div style="font-weight: 600; font-variant-numeric: tabular-nums;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div>';

      // Intelligence lives only in the model header row — it's identical across a
      // model's providers, so provider rows show a placeholder instead.
      const intellCell = row.cells[1];
      intellCell.innerHTML = `<div style="font-weight: 600;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div>`;

      // Update status cell (col 5) and response cell (col 6); never clobber an in-flight test
      const statusCell = row.cells[5];
      if (statusCell && !inflightTests.has(getModelRowKey(m))) {
        statusCell.innerHTML = `<div style="display: flex; align-items: center; gap: 6px;">${statusCellHTML(m)}</div>`;
      }
      const responseCell = row.cells[6];
      if (responseCell && !inflightTests.has(getModelRowKey(m))) {
        responseCell.innerHTML = responseCellHTML(m.lastResponse, { rowKey: getModelRowKey(m), providerKey: m.providerKey, modelId: m.modelId, hasAuth: m.status !== 'noauth', status: m.status });
      }

      // Update TTFT and tokens/sec (real usage stats)
      const displayTtft = rowTtft(m);
      const displayTps = rowTps(m);
      const ttftCell = row.cells[2];
      ttftCell.innerHTML = displayTtft != null
        ? `<div style="font-size:0.82rem;">${formatSecondsFromMs(displayTtft)}</div><div style="font-size:0.7rem; color:var(--text-muted);">${rowTtftLabel(m)}</div>`
        : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>';
      const tpsCell = row.cells[3];
      tpsCell.innerHTML = displayTps != null
        ? `<div style="font-size:0.82rem;">${displayTps}</div><div style="font-size:0.7rem; color:var(--text-muted);">tok/s</div>`
        : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>';
    }

    // Formats a raw token count like the catalog's context strings: "128k", "1.5M", "32000".
    function formatTokenCount(n) {
      const value = Number(n);
      if (!Number.isFinite(value) || value <= 0) return null;
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
      if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
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

    // Builds the Response cell: the Test button plus the latest response text.
    // opts: { rowKey, providerKey?, modelId?, members?, owner? } — `owner` is the row a
    // shared response came from (a group heading), so the cell can judge that response
    // against the row that produced it instead of against the heading.
    function responseCellHTML(lastResponse, opts) {
      // Models with no API key / auth configured show a placeholder.
      if (opts && opts.hasAuth === false) {
        return '<div class="test-cell"><span class="test-meta" style="color:var(--text-muted);">—</span></div>';
      }
      const btn = testBtnHTML(opts);
      if (!lastResponse) return `<div class="test-cell">${btn}</div>`;
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
      // Live fallback errors must be visible in the Response column the moment they happen:
      // the router writes them as this row's own test-like failure (see recordRoutedModelFailure)
      // and the Response cell shows that error plus the "live request \u2014 fallback" marker below,
      // even when the row's Status cell is already showing a rate-limit clock for the same window.
      const clocked = owner ? isRateLimitedRow(owner) && testRateLimitWindow(owner) != null : false;
      void clocked; // kept for the Status-cell clock logic above; errText no longer gates on it so fallbacks stay visible during the window
      const errText = !expired && lastResponse.error ? String(lastResponse.error) : '';
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
        metaBits.push(`${reportedTokens} token${reportedTokens === 1 ? '' : 's'}`);
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
      const body = lastResponse._groupReady
        ? ''
        : (text
          ? `<div class="test-response ${errText ? 'err' : 'ok'}"${expAttr} title="${escapeAttr(text)}">${escapeHtml(text)}</div>`
          : (errText ? `<div class="test-response err"${expAttr}>HTTP ${lastResponse.status}</div>` : ''));
      return `<div class="test-cell">${btn}${body}${meta}</div>`;
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

    // ---- The one row verdict -------------------------------------------------
    // The Status column is the absolute slave of and fully defined by the Test column,
    // with exceptions only when the model is actually being used (live proxy traffic).
    const STRUCK_VERDICTS = new Set(['paid', 'dead', 'incompatible', 'micro', 'noauth']);
    // The balance half of the account refusals, kept in step with INSUFFICIENT_FUNDS_RE in
    // lib/utils.js: a stated shortfall on the account's own balance or funds is money the row
    // needs rather than a quota it waits out. The server marks such a response `paymentRequired`
    // (the primary route to the Paid badge), and this copy is what keeps evidence stored before
    // that rule existed — or a row whose flag was never persisted — from reading as the clock.
    const INSUFFICIENT_FUNDS_RE = /\b(?:insufficient|not enough|no|out of|low|zero|negative|empty)\b[^.\n]{0,24}\b(?:account\s+|wallet\s+|credit\s+)?(?:balance|funds?)\b|\b(?:account\s+|wallet\s+|credit\s+)?(?:balance|funds?)\b[^.\n]{0,24}\b(?:insufficient|empty|zero|negative|too low|depleted|exhausted|out of funds?)\b/i;
    // The incompatible half of the same mirror, kept in step with isIncompatibleModelError in
    // lib/utils.js — the rule the server reads the same stored text with. The narrow
    // `image/video only | not support text` pair this replaces missed most of the canonical
    // clauses, so a row the server had already struck as Incompatible kept its place in the main
    // table with an empty Status cell: llm7 refuses every Seedance id with "Model
    // 'seedance-2.0-fast' does not support chat endpoints." (live 2026-09-22), which the router
    // read as incompatible and this file re-read as a generic Down.
    const INCOMPATIBLE_MODEL_RE = /content cannot be a plain string|model does not support text input|only supports (?:the )?interactions api|only supports (?:real[- ]time )?bidirectional streaming(?: via websocket)?|bidiGenerateContent(?: via websocket)?|gemini live api|chat.completions.*(?:is not supported|not available|unsupported)|route not supported|does not support chat|only available on agentic harnesses|calibration|requires terms acceptance|model_terms_required|terms (?:have|has) not been accepted|requires acceptance of the terms|requested model is not supported|model_not_supported|can only be used from within/i;
    // Every state that means "waiting on the provider": the clock is drawn for all of them. An
    // overload belongs here for the same reason a quota does — the provider is refusing for
    // now and the row returns on its own, so nothing is broken and nothing needs fixing.
    const BENCHED_VERDICTS = new Set(['rate-limited', 'overloaded', 'timeout']);
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
      if (lr.paymentRequired === true || lr.dead === true || lr.incompatible === true) return null;
      if (lr.overloaded === true) return 'overloaded';
      const text = String(lr.error);
      if (Number(lr.status) === 429 || /resource_exhausted|freeusagelimiterror|quota exceeded|rate limit exceeded|too many requests/i.test(text)) return 'rate-limited';
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
      if (lr.paymentRequired === true) return 'paid';
      if (lr.dead === true) return 'dead';
      if (lr.incompatible === true) return 'incompatible';
      const code = Number(lr.status || 0);
      const errText = String(lr.error || '');
      if (code === 402 || /payment required|billing/i.test(errText) || INSUFFICIENT_FUNDS_RE.test(errText)) return 'paid';
      if (code === 410 || /model is dead|model_not_found|410 Gone|model does not exist/i.test(errText)) return 'dead';
      if (INCOMPATIBLE_MODEL_RE.test(errText)) return 'incompatible';
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
          if (lr.paymentRequired === true) return 'paid';
          if (lr.dead === true) return 'dead';
          if (lr.incompatible === true) return 'incompatible';
          if (lr.overloaded === true) return 'overloaded';

          const code = Number(lr.status || 0);
          const errText = String(lr.error || '');

          if (code === 402 || /payment required|billing/i.test(errText) || INSUFFICIENT_FUNDS_RE.test(errText)) return 'paid';
          // 'model does not exist' is kept in step with isDeadModelError in lib/utils.js so a
          // row whose stored evidence predates that rule still reads Dead rather than Down.
          if (code === 410 || /model is dead|model_not_found|410 Gone|model does not exist/i.test(errText)) return 'dead';
          // Kept in step with isIncompatibleModelError in lib/utils.js, so stored evidence from
          // before a clause existed still classifies the way the server classifies the same text.
          if (INCOMPATIBLE_MODEL_RE.test(errText)) return 'incompatible';
          if (code === 429 || /resource_exhausted|freeusagelimiterror|quota exceeded|rate limit exceeded|too many requests/i.test(errText)) {
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

    // The one indicator: a clock for the states that mean "waiting on the provider", a
    // dot for everything else.
    function verdictIndicatorHTML(kind, title = '') {
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
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

    function updateVisibleMetrics(model, rowKey = getModelRowKey(model)) {
      const row = document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`);
      if (!row) return;
      const ttftCell = row.cells[2];
      const tpsCell = row.cells[3];
      const visibleTtft = rowTtft(model);
      const visibleTps = rowTps(model);
      if (ttftCell) ttftCell.innerHTML = visibleTtft != null
        ? `<div style="font-size:0.82rem;">${formatSecondsFromMs(visibleTtft)}</div><div style="font-size:0.7rem; color:var(--text-muted);">${rowKey.startsWith('g:') ? 'ttft' : rowTtftLabel(model)}</div>`
        : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>';
      if (tpsCell) tpsCell.innerHTML = visibleTps != null
        ? `<div style="font-size:0.82rem;">${visibleTps}</div><div style="font-size:0.7rem; color:var(--text-muted);">tok/s</div>`
        : '<span style="font-size: 0.75rem; color: var(--text-muted);">—</span>';
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
      const statusCell = tr && tr.cells[5];
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
      const textSaysLimited = /resource_exhausted|freeusagelimiterror|quota exceeded|rate limit exceeded|too many requests/i.test(errorText);
      if (!statusIs429 && !textSaysLimited) return null;
      const at = Number(lr.at);
      const atMs = Number.isFinite(at) && at > 0 ? at : Date.now();
      const stated = [Number(lr.rateLimitResetAt), rateLimitResetFromBody(errorText)]
        .filter(value => Number.isFinite(value) && value > 0);
      if (stated.length > 0) {
        const resetAt = Math.max(...stated);
        return { until: resetAt, resetAt };
      }
      // Older persisted responses predate rateLimitResetAt but still carry the
      // provider's own retry delay, which names the window just as well.
      const retry = errorText.match(/(?:please\s+)?retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i);
      if (retry) {
        const until = atMs + Number(retry[1]) * 1000;
        return { until, resetAt: until };
      }
      return { until: atMs + RATE_LIMIT_UNSTATED_GRACE_MS, resetAt: null };
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
      const now = Date.now();
      const status = String(m.status || '').toLowerCase();
      const creditExhausted = Number(m.rateLimit?.creditLimit) > 0
        && m.rateLimit?.creditRemaining != null && Number(m.rateLimit.creditRemaining) <= 0;
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
      const stated = [
        m.lastResponse?.rateLimitResetAt,
        rateLimitResetFromBody(String(m.lastResponse?.error || '')),
        m.rateLimit?.resetRequestsAt,
        m.rateLimit?.resetTokensAt,
        m.rateLimit?.creditResetAt,
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
      const q = m && m.rateLimit && m.rateLimit.quota;
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
      // A timeout is drawn with the same clock as the other waiting states, and the clock
      // already says "waiting on the provider" by itself — so the word is dropped beside it
      // for the same reason up/down are, and survives as the icon's tooltip instead
      // (plainStatusTitle still answers "Timeout" on hover).
      if (kind === 'timeout') return '';
      return kind === 'noauth' ? 'No Auth' : verdictLabel(kind);
    }

    // Title for a bare status dot, so the hidden word is still available on hover.
    function plainStatusTitle(kind) {
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
      const inner = special != null
        ? special
        : `${verdictIndicatorHTML(kind, plainStatusTitle(kind))}${label ? `<span style="font-size: 0.75rem; font-weight: 500; text-transform: capitalize;">${escapeHtml(label)}</span>` : ''}`;
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
        const cell = el.closest('td');
        if (cell && model) {
          cell.innerHTML = `<div style="display:flex;align-items:center; gap:6px;">${statusCellHTML(model)}</div>`;
        } else {
          el.remove();
        }
      });
    }
    // rowVerdict is partly time-dependent: a ready response or provider window can
    // expire without any API snapshot changing. Re-evaluate the scatter once per
    // second so its redraw guard catches that transition; the guard still leaves the
    // existing SVG untouched unless a verdict or eligibility state actually changed.
    drawSpeedIntellScatter(allModels);
    setInterval(updateRateLimitCountdowns, 1000);
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

    // One unavailable provider row. Like the main model row it keeps the same eight
    // cells so the two tables stay comparable, but the Status cell names this one
    // provider's reason instead of counting reasons across a model's providers.
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
          <td><div style="font-weight: 600;">${getBenchmarkTableDisplayValue(s.bestIntellMember.intell, s.bestIntellMember.qualitySource, s.bestIntellMember.qualityDetail, s.bestIntellMember.aa)}</div></td>
          ${formatTtftCell(s.minTtft, 'ttft')}
          ${formatTpsCell(s.maxTps, 'tok/s')}
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

      const isPinnedRow = isExactPinnedRow(m);
      tr.classList.toggle('row-best', isCurrentBestRow(m));
      tr.innerHTML = `
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-weight: 600;" title="${escapeHtml(providerRowLabel(m))}">${escapeHtml(providerRowLabel(m))}</span>
              <button type="button" class="pin-row-btn ${isPinnedRow ? 'pinned' : ''}" data-pin-model="${escapeAttr(m.modelId)}" data-pin-provider="${escapeAttr(m.providerKey)}" title="${isPinnedRow ? 'Unpin exact provider row' : 'Pin exact provider row'}">📌</button>
            </div>
            <div class="provider-subtext" title="${escapeHtml(m.modelId)}${m.realModelId && m.realModelId !== m.modelId ? ' &#8594; ' + escapeHtml(m.realModelId) : ''}">${escapeHtml(m.modelId)}${m.realModelId && m.realModelId !== m.modelId ? ` <span style="opacity:0.7;">&#8594; ${escapeHtml(m.realModelId)}</span>` : ''}</div>
          </td>
          <td><div style="font-weight: 600;"><span style="font-size:0.75rem;color:var(--text-muted);">—</span></div></td>
          ${formatTtftCell(rowTtft(m), rowTtftLabel(m))}
          ${formatTpsCell(rowTps(m), 'tok/s')}
          <td>
            <div style="font-weight: 600; font-variant-numeric: tabular-nums;" title="${m.contextSource === 'observed' ? 'Bounds inferred from real requests' : (m.context ? 'Known context window' : 'No context data yet — will fill in as the model is used')}">${m.context ? escapeHtml(m.context) : '<span style="font-size:0.75rem;color:var(--text-muted);">—</span>'}</div>
          </td>
          <td><div style="display: flex; align-items: center; gap: 6px;">${statusCellHTML(m)}</div></td>
          <td>${responseCellHTML(m.lastResponse, { rowKey: getModelRowKey(m), providerKey: m.providerKey, modelId: m.modelId, hasAuth: m.status !== 'noauth', status: m.status })}</td>
        `;
      bindPinButton(tr.querySelector('.pin-row-btn'), {
        modelId: m.modelId,
        providerKey: m.providerKey,
        pinned: isPinnedRow,
      });
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
      if (n >= 45) return '#16a34a';
      if (n >= 40) return '#4ade80';
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
        case 'design-arena': return { short: 'Arena*', label: 'Design Arena Elo, AA-interpolated' };
        case 'metadata': return { short: 'Meta*', label: 'Metadata estimate' };
        case 'local-fallback': return { short: 'Offline*', label: 'Offline fallback' };
        case 'family-estimate': return { short: 'Family*', label: 'Same-family estimate' };
        case 'default-fallback': return { short: 'Floor*', label: 'Conservative AA floor' };
        default: return { short: 'Estimate*', label: 'Estimated intelligence score' };
      }
    }

    // Every row displays one number: the Artificial Analysis Intelligence Index.
    // AA's own rating is shown plain; a value interpolated from an Elo (or calibrated
    // from a metadata/offline/family score) is an estimate and gets an asterisk. Even
    // the unresolved fallback is an explicit AA-scale value (0.1), never a blank.
    function getBenchmarkDisplayValue(value, source, detail = '', aa = null) {
      const sourceDisplay = getQualitySourceDisplay(source);
      const title = escapeHtml(`${sourceDisplay.label}${detail ? ` — ${detail}` : ''}`);
      const n = Number(aa);
      if (Number.isFinite(n) && n > 0) {
        const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
        const marker = source === 'artificial-analysis' ? '' : '<span class="pill-estimate">*</span>';
        return `<span title="${title}">${shown}${marker}</span>`;
      }
      // Degraded/offline mode: no AA value at all, show the local score.
      const score = Number(value);
      if (!Number.isFinite(score) || score <= 0) return '—';
      return `<span title="${title}">${Math.round(score * 100)}<span class="pill-estimate">${sourceDisplay.short}</span></span>`;
    }

    function getBenchmarkTableDisplayValue(value, source, detail = '', aa = null) {
      return getBenchmarkDisplayValue(value, source, detail, aa);
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
        const millions = Math.round(tokens / 100_000) / 10;
        return `${millions}M`;
      }
      if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
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
     */
    function credentialFieldsHtml(p) {
      const fields = Array.isArray(p.requiredCredentialFields) ? p.requiredCredentialFields : [];
      if (fields.length === 0) return '';
      const missing = new Set(Array.isArray(p.missingCredentialFields) ? p.missingCredentialFields : []);
      const values = p.credentialFieldValues || {};
      const rows = fields.map(field => {
        const shown = values[field];
        const fromEnv = shown === 'from-environment';
        const value = (shown && !fromEnv) ? shown : '';
        const placeholder = fromEnv ? 'set by the environment' : `Enter ${field}...`;
        return `
          <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
            <input type="text" id="cred-field-${escapeHtml(p.key)}-${escapeHtml(field)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.78rem; background:var(--input-bg); color:var(--text);" onkeydown="if(event.key==='Enter'){event.preventDefault();saveProviderCredentialFields(${jsStringAttr(p.key)});}" title="Press Enter or click Save">
            <button onclick="saveProviderCredentialFields(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Save</button>
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
      const prefix = `cred-field-${key}-`;
      const credentialFields = {};
      document.querySelectorAll('input[id^="cred-field-"]').forEach(el => {
        if (!el.id.startsWith(prefix)) return;
        credentialFields[el.id.slice(prefix.length)] = el.value.trim();
      });
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

        const addEndpointSection = document.createElement('div');
        addEndpointSection.className = 'provider-section autoupdate-panel';
        addEndpointSection.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
            <h3 style="margin:0; font-size:1rem;">OpenAI-Compatible endpoints</h3>
            <button onclick="addOpenAICompatibleEndpoint()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:6px 12px; border-radius:6px; font-size:0.8rem; font-weight:600;">+ Add Endpoint</button>
          </div>
          <div style="font-size:0.78rem; color:var(--text-muted);">Configure one or more upstream OpenAI-compatible endpoints (vLLM, llama.cpp, custom relays, etc.). Each endpoint exposes a single model id.</div>
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
          // Get rate limit info from a model with this provider that has rateLimit data
          const rlModel = providerModels.find(m => m.rateLimit) || null;
          const rl = rlModel?.rateLimit;
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

          // The provider's complete quota snapshot is account-scoped, unlike a single
          // model's response headers. Draw it beside the credential-rotation bar below.
          const providerQuotaHtml = quotaBarsHtml(p, rl);
          let rateLimitHtml = '';
          if (rl) {
            const fmtNum = n => n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
            const fmtTime = ts => {
              if (!ts) return null;
              const d = new Date(ts);
              return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
            };
            const creditLine = rl.creditLimit != null
              ? `<span>Credits: <b>${fmtNum(rl.creditRemaining ?? '?')}</b> / ${fmtNum(rl.creditLimit)} remaining</span>`
              : '';
            const creditResetLine = rl.creditResetAt ? `<span>Credit reset: <b>${fmtTime(rl.creditResetAt) ?? 'unknown'}</b></span>` : '';
            rateLimitHtml = `
              <div style="margin-top:12px; padding:10px 12px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:8px; font-size:0.78rem;">
                <div style="font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-size:0.7rem;">Rate Limits (last prompt)</div>
                <div style="display:flex; gap:16px; flex-wrap:wrap;">
                  ${rl.limitRequests != null ? `<span>Requests: <b>${fmtNum(rl.remainingRequests ?? '?')}</b> / ${fmtNum(rl.limitRequests)} remaining</span>` : ''}
                  ${rl.limitTokens != null ? `<span>Tokens: <b>${fmtNum(rl.remainingTokens ?? '?')}</b> / ${fmtNum(rl.limitTokens)} remaining</span>` : ''}
                  ${creditLine}
                  ${creditResetLine}
                </div>
              </div>`;
          }

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

          const section = document.createElement('div');
          const isRefreshing = providerRefreshInFlight.has(p.key);
          section.className = 'provider-section autoupdate-panel';
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
                  <button data-verify-url="${escapeHtml(kiroDeviceAuthState.verificationUriComplete || '')}" onclick="window.open(this.dataset.verifyUrl || '', 'kiro_builder_id_verify')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
                  <button onclick="cancelKiroDeviceAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            const kiroBrowserAuthHtml = kiroBrowserAuthState ? `
              <div style="margin-top:14px; padding:12px 14px; background:var(--input-bg-alt); border:1px solid var(--border); border-radius:10px;">
                <div style="font-size:0.82rem; font-weight:700; color:var(--text); margin-bottom:6px;">Browser OAuth (${kiroBrowserAuthState.provider === 'github' ? 'GitHub' : 'Google'})</div>
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">After approval, the popup may end on a blank or unsupported page because Kiro redirects to a <code>kiro://</code> URL. Copy that full URL from the address bar and paste it below.</div>
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
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span style="background:${kiroStatusBg}; color:${kiroStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${kiroStatusOk ? '✅' : '⚠️'} ${escapeHtml(kiroStatusText)}</span>
                  ${providerTitleHtml(p, 'Set up Kiro')}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>


                </div>
              </div>
              <div style="font-size:0.82rem; color:var(--text-muted); margin:0 0 12px 0;">Connect Kiro with AWS Builder ID device authorization, import a token from the AWS SSO cache, or paste a refresh token manually.</div>
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
              ${providerQuotaHtml}
              ${credentialBarHtml(p)}
              ${providerErrorHtml}
              ${rateLimitHtml}
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
                  <button data-verify-url="${escapeHtml(copilotDeviceAuthState.verificationUriComplete || copilotDeviceAuthState.verificationUri || '')}" onclick="window.open(this.dataset.verifyUrl || '', 'copilot_device_verify')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
                  <button onclick="cancelCopilotDeviceAuth()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Cancel</button>
                </div>
              </div>
            ` : '';

            const copilotActionsHtml = copilotConnected
              ? '<button onclick="disconnectCopilot()" style="border:1px solid var(--status-error-border); background:var(--status-error-bg); color:var(--status-error-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Disconnect</button>'
              : '<button onclick="startCopilotDeviceAuth()" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;">Sign in with GitHub</button>';

            section.innerHTML = `
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span style="background:${copilotStatusBg}; color:${copilotStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${copilotConnected ? '✅' : '⚠️'} ${escapeHtml(copilotStatusText)}</span>
                  ${providerTitleHtml(p, 'Manage GitHub Copilot')}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                </div>
              </div>
              <div style="font-size:0.82rem; color:var(--text-muted); margin:0 0 12px 0;">Sign in with the GitHub account that has Copilot. Hammer stores the resulting GitHub token locally and uses it as the Copilot credential — model traffic is billed against that account's Copilot plan, with no per-token cost.</div>
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
              ${providerQuotaHtml}
              ${credentialBarHtml(p)}
              ${providerErrorHtml}
              ${rateLimitHtml}
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
                  <button data-verify-url="${escapeHtml(codexDeviceAuthState.verificationUri || '')}" onclick="window.open(this.dataset.verifyUrl || '', 'codex_device_verify')" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600;">Open Verification Page</button>
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
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span style="background:${codexStatusBg}; color:${codexStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${codexConnected ? '✅' : '⚠️'} ${escapeHtml(codexStatusText)}</span>
                  ${providerTitleHtml(p, 'Manage the ChatGPT plan behind Codex')}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                </div>
              </div>
              <div style="font-size:0.82rem; color:var(--text-muted); margin:0 0 12px 0;">Sign in with the ChatGPT account whose plan should back the router. Hammer stores the resulting OAuth refresh token locally and exchanges it for short-lived access tokens — usage counts against that account's ChatGPT plan instead of per-token billing. Sign in again with a different account to add it: the first is spent before the next is used, so one plan's limit is not the ceiling for the whole router.</div>
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
              ${providerQuotaHtml}
              ${credentialBarHtml(p)}
              ${providerErrorHtml}
              ${rateLimitHtml}
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
                <div style="font-size:0.76rem; color:var(--text-muted); margin-bottom:10px;">Approve the login in the popup. Hammer listens on <code>${escapeHtml(devinOAuthState.redirectUri)}</code> and finishes automatically — no code to copy.</div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                  <input type="text" id="devin-auth-url" readonly value="${escapeHtml(devinOAuthState.authUrl)}" style="flex:1; background:var(--input-bg); color:var(--text); font-size:0.76rem;">
                  <button onclick="copyDevinAuthUrl()" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.78rem; font-weight:600; white-space:nowrap;">Copy Link</button>
                </div>
                <div style="font-size:0.74rem; color:var(--text-muted); margin-bottom:8px;">If the popup can't reach the local callback (different machine or blocked port), paste the full URL from the popup's address bar below.</div>
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
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span style="background:${devinStatusBg}; color:${devinStatusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${devinConnected ? '✅' : '⚠️'} ${escapeHtml(devinStatusText)}</span>
                  ${providerTitleHtml(p, 'Get Devin')}
                  <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                      <polyline points="21 3 21 9 15 9"></polyline>
                    </svg>
                    <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                  </button>
                </div>
              </div>
              <div style="font-size:0.82rem; color:var(--text-muted); margin:0 0 12px 0;">Sign in with your Cognition (Devin) account — the same browser flow the Devin CLI uses. Hammer stores the session token locally and uses it for the swe-1.6 / swe-1.5 models.</div>
              ${devinFlowHtml}
              <div class="form-group" style="display:flex; gap:8px; align-items:center; margin-top:10px;">
                <input type="password" id="key-${p.key}" placeholder="${p.hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (Session token configured)' : 'Or paste a session token (devin-session-token$...)'}" style="flex:1; background:var(--input-bg); color:var(--text);" onblur="updateProviderKey(${jsStringAttr(p.key)})" onkeydown="if(event.key==='Enter'){event.preventDefault();updateProviderKey(${jsStringAttr(p.key)});}" title="Press Enter or click away to save">
                <button onclick="toggleProviderKeyVisibility(${jsStringAttr(p.key)}, this)" title="Show or hide token" aria-label="Show or hide token" style="border:1px solid var(--border); background:var(--input-bg); color:var(--text); cursor:pointer; padding:8px 10px; border-radius:6px; font-size:0.85rem; white-space:nowrap;">👁</button>
                <button onclick="updateProviderKey(${jsStringAttr(p.key)})" style="border:1px solid var(--status-success-border); background:var(--status-success-bg); color:var(--status-success-text); cursor:pointer; padding:8px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;">Save Token</button>
              </div>
              ${devinMessageHtml}
              ${providerQuotaHtml}
              ${credentialBarHtml(p)}
              ${providerErrorHtml}
              ${rateLimitHtml}
            `;
            (providerIsActive ? activeContainer : setupContainer).appendChild(section);
            return;
          }
          section.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="background:${statusBg}; color:${statusColor}; border-radius:999px; padding:2px 10px; font-size:0.75rem; font-weight:600;">${statusIcon} ${statusText}</span>
                ${providerTitleHtml(p)}
                <button class="provider-model-refresh-btn ${isRefreshing ? 'is-loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick='refreshProviderModels(${jsStringAttr(p.key)}, ${jsStringAttr(p.name)})' title="Refresh provider models">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                    <polyline points="21 3 21 9 15 9"></polyline>
                  </svg>
                  <span>${isRefreshing ? 'Refreshing…' : `${modelCount} model${modelCount !== 1 ? 's' : ''}`}</span>
                </button>
              </div>
            </div>
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
            ${providerQuotaHtml}
            ${credentialBarHtml(p)}
            ${providerErrorHtml}
            ${rateLimitHtml}
          `;
          (providerIsActive ? activeContainer : setupContainer).appendChild(section);
        });
        restoreInputState();
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
        if (verifyUrl) {
          window.open(verifyUrl, 'kiro_builder_id_verify');
        }
        setKiroUiMessage('Opened the AWS Builder ID verification page. Approve the request there and Hammer will finish the connection automatically.', 'info');
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
      const popup = window.open('', 'kiro_social_auth');
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
        setKiroUiMessage(`Opened the ${providerLabel} login. If the popup reports that kiro:// has no registered handler, this machine cannot complete browser OAuth and you should use AWS cache import or a manual refresh token instead.`, 'info');
        if (popup) {
          popup.location = data.authUrl;
        } else {
          window.open(data.authUrl, 'kiro_social_auth');
          setKiroUiMessage(`Popup blocked. Open the copied ${providerLabel} auth link manually, then paste the callback URL below.`, 'info');
        }
      } catch (err) {
        if (popup && !popup.closed) popup.close();
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
        if (verifyUrl) {
          window.open(verifyUrl, 'copilot_device_verify');
        }
        setCopilotUiMessage('Opened the GitHub verification page. Enter the code there and Hammer will finish the connection automatically.', 'info');
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

        if (data.verificationUri) {
          window.open(data.verificationUri, 'codex_device_verify');
        }
        setCodexUiMessage('Opened the ChatGPT verification page. Enter the code there and Hammer will finish the connection automatically.', 'info');
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

        const popup = window.open(data.authUrl, 'devin_oauth');
        if (!popup) {
          setDevinUiMessage('Popup blocked. Open the copied sign-in link manually, then paste the callback URL into the field below after approving.', 'info');
        } else {
          setDevinUiMessage('Opened the Devin sign-in page. Approve the login there and Hammer will finish automatically.', 'info');
        }
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
        setDevinUiMessage('Paste the full callback URL from the popup address bar first.', 'error');
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
      } catch (err) {
        setKiroUiMessage(err.message || 'Failed to save the Kiro refresh token.', 'error');
      }
    }

    function loadChatState() {
      try {
        const rawMessages = sessionStorage.getItem(CHAT_STORAGE_KEY);
        const parsedMessages = rawMessages ? JSON.parse(rawMessages) : [];
        chatMessages = Array.isArray(parsedMessages)
          ? parsedMessages
            .filter(m => m && typeof m.role === 'string' && m.content != null)
            .map(m => ({
              role: String(m.role),
              content: typeof m.content === 'string' ? m.content : formatMessageContent(m.content),
              ts: typeof m.ts === 'string' ? m.ts : new Date().toISOString(),
              model: typeof m.model === 'string' && m.model.trim() ? m.model.trim() : null
            }))
          : [];

        const rawModel = sessionStorage.getItem(CHAT_MODEL_STORAGE_KEY);
        chatSelectedModel = rawModel && typeof rawModel === 'string' ? rawModel : 'best';
      } catch {
        chatMessages = [];
        chatSelectedModel = 'best';
      }
    }

    function saveChatState() {
      try {
        sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages));
        sessionStorage.setItem(CHAT_MODEL_STORAGE_KEY, chatSelectedModel || 'best');
      } catch {
        // Ignore storage failures and keep chat in-memory.
      }
    }

    function updateChatModelOptions(models = []) {
      const select = document.getElementById('chat-model-select');
      if (!select) return;

      const previousSelection = chatSelectedModel || select.value || 'best';
      const options = [
        { value: 'best', label: 'Best' },
        ...models
          .filter(m => m && m.modelId)
          .sort((a, b) => (a.label || a.modelId).localeCompare(b.label || b.modelId))
          .map(m => ({
            value: m.modelId,
            label: `${m.label || m.modelId} · ${providerInstanceName(m)}`
          }))
      ];

      const deduped = [];
      const seen = new Set();
      for (const opt of options) {
        if (seen.has(opt.value)) continue;
        seen.add(opt.value);
        deduped.push(opt);
      }

      select.innerHTML = deduped
        .map(opt => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
        .join('');

      const hasPrevious = deduped.some(opt => opt.value === previousSelection);
      chatSelectedModel = hasPrevious ? previousSelection : 'best';
      select.value = chatSelectedModel;
      saveChatState();
    }

    function onChatModelChange() {
      const select = document.getElementById('chat-model-select');
      chatSelectedModel = (select && select.value) ? select.value : 'best';
      saveChatState();
      setChatStatus(`Using model: ${chatSelectedModel}`, 'muted');
    }

    function setChatStatus(message, tone = 'muted') {
      const statusEl = document.getElementById('chat-status');
      if (!statusEl) return;
      statusEl.className = `chat-status${tone === 'error' ? ' error' : tone === 'success' ? ' success' : ''}`;
      statusEl.textContent = message || '';
    }

    function scrollChatToBottom() {
      const transcript = document.getElementById('chat-transcript');
      if (!transcript) return;
      transcript.scrollTop = transcript.scrollHeight;
    }

    function renderChatTranscript() {
      const transcript = document.getElementById('chat-transcript');
      if (!transcript) return;

      if (!chatMessages.length) {
        transcript.innerHTML = `
          <div class="chat-empty">
            Start a conversation. Press Enter to send and Shift+Enter for a newline.
          </div>
        `;
        return;
      }

      transcript.innerHTML = chatMessages.map(msg => {
        const role = msg && msg.role ? String(msg.role) : 'assistant';
        const roleClass = role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant';
        const content = escapeHtml(formatMessageContent(msg && msg.content != null ? msg.content : ''));
        const ts = msg && msg.ts ? new Date(msg.ts) : null;
        const tsLabel = ts && !Number.isNaN(ts.getTime())
          ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        const modelLabel = msg && typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : '';
        const headerBits = [role];
        if (tsLabel) headerBits.push(tsLabel);
        if (role === 'assistant' && modelLabel) headerBits.push(modelLabel);

        return `
          <div class="chat-msg ${roleClass}">
            <div class="chat-msg-role">${headerBits.map(part => escapeHtml(part)).join(' • ')}</div>
            <div class="chat-msg-content">${content}</div>
          </div>
        `;
      }).join('');

      scrollChatToBottom();
    }

    function setChatInFlight(inFlight) {
      chatInFlight = !!inFlight;

      const sendBtn = document.getElementById('chat-send-btn');
      const clearBtn = document.getElementById('chat-clear-btn');
      const input = document.getElementById('chat-input');
      const modelSelect = document.getElementById('chat-model-select');
      const typing = document.getElementById('chat-typing-indicator');

      if (sendBtn) {
        sendBtn.disabled = chatInFlight;
        sendBtn.textContent = chatInFlight ? 'Sending...' : 'Send';
      }
      if (clearBtn) clearBtn.disabled = chatInFlight;
      if (input) input.disabled = chatInFlight;
      if (modelSelect) modelSelect.disabled = chatInFlight;
      if (typing) typing.style.display = chatInFlight ? 'flex' : 'none';
    }

    function handleChatInputKeydown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
    }

    function clearChat() {
      if (chatInFlight) return;
      chatMessages = [];
      saveChatState();
      setChatStatus('Chat cleared. Starting fresh.', 'success');
      renderChatTranscript();
      const input = document.getElementById('chat-input');
      if (input) input.focus();
    }

    function buildChatRequestMessages() {
      return chatMessages
        .filter(m => m && typeof m.role === 'string' && m.content != null)
        .map(m => ({
          role: String(m.role),
          content: typeof m.content === 'string' ? m.content : formatMessageContent(m.content)
        }));
    }

    function getAssistantTextFromResponse(data) {
      const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
      const message = choice && choice.message ? choice.message : null;
      if (!message) return '';

      if (typeof message.content === 'string' && message.content.trim() !== '') {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        const joined = message.content.map(part => {
          if (typeof part === 'string') return part;
          if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
          return '';
        }).filter(Boolean).join('\n');
        if (joined.trim() !== '') return joined;
      }

      if (message.tool_calls) {
        return JSON.stringify(message.tool_calls, null, 2);
      }
      if (message.function_call) {
        return JSON.stringify(message.function_call, null, 2);
      }

      return '';
    }

    async function sendChatMessage() {
      if (chatInFlight) return;
      const input = document.getElementById('chat-input');
      if (!input) return;

      const content = input.value.replace(/\r\n/g, '\n').trim();
      if (!content) {
        setChatStatus('Type a message before sending.', 'error');
        return;
      }

      const userMessage = { role: 'user', content, ts: new Date().toISOString() };
      chatMessages.push(userMessage);
      saveChatState();
      renderChatTranscript();
      input.value = '';
      setChatStatus('');
      setChatInFlight(true);

      try {
        const requestBody = {
          model: chatSelectedModel || 'best',
          messages: buildChatRequestMessages()
        };

        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errorMessage = data?.error?.message || data?.error || data?.message || `Chat request failed (${res.status}).`;
          throw new Error(errorMessage);
        }

        const assistantText = getAssistantTextFromResponse(data);
        if (!assistantText) {
          throw new Error('The provider returned an empty assistant response.');
        }

        const responseModel = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : null;
        chatMessages.push({ role: 'assistant', content: assistantText, ts: new Date().toISOString(), model: responseModel });
        saveChatState();
        renderChatTranscript();
        setChatStatus('Response received.', 'success');
      } catch (err) {
        setChatStatus(err?.message || 'Failed to send message.', 'error');
      } finally {
        setChatInFlight(false);
        if (input) input.focus();
      }
    }

    function initializeChat() {
      loadChatState();
      updateChatModelOptions(allModels);
      renderChatTranscript();
      setChatInFlight(false);
      setChatStatus('');
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
          let statusBadge = '';
          if (l.status === '200') statusBadge = '<span style="background: var(--status-success-bg); color: var(--status-success-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">200 OK</span>';
          else if (l.status === 'pending') statusBadge = '<span style="background: var(--status-info-bg); color: var(--status-info-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">Pending...</span>';
          else statusBadge = `<span style="background: var(--status-error-bg); color: var(--status-error-text); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;">${escapeHtml(l.status)}</span>`;
          const resolvedModelChip = l.resolvedModel
            ? `<span style="background:var(--status-info-bg); color:var(--status-info-text); padding:2px 8px; border-radius:999px; font-size:0.7rem; font-weight:700;">resolved: ${escapeHtml(l.resolvedModel)}</span>`
            : '';

          let messagesArray = Array.isArray(l.messages) ? l.messages : (typeof l.messages === 'string' ? [{ role: 'raw', content: l.messages }] : []);
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
            let formattedResp = l.response.replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
                      ${l.prompt_tokens != null || l.completion_tokens != null ? `<span>•</span><span style="color: var(--text-muted);"><span style="font-weight: 600; color: var(--text);">${l.prompt_tokens || 0}</span> in / <span style="font-weight: 600; color: var(--text);">${l.completion_tokens || 0}</span> out</span>` : ''}
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
        day: ['tokensToday', 'today', 'Nothing recorded today yet'],
        week: ['tokensThisWeek', 'this week', 'Nothing recorded this week yet'],
        month: ['tokensThisMonth', 'this month', 'Nothing recorded this month yet'],
        lifetime: ['tokensLifetime', 'so far', 'Nothing recorded yet'],
      },
      requests: {
        day: ['requestsToday', 'today', 'Nothing recorded today yet'],
        week: ['requestsThisWeek', 'this week', 'Nothing recorded this week yet'],
        month: ['requestsThisMonth', 'this month', 'Nothing recorded this month yet'],
        lifetime: [null, 'so far', 'Nothing recorded yet'],
      },
      // Credits have no recorded counterpart: hammer counts tokens and requests, never the
      // provider's money, so a credit cap shows as a number without a bar.
      credits: {
        day: [null, 'today', 'Nothing recorded today yet'],
        week: [null, 'this week', 'Nothing recorded this week yet'],
        month: [null, 'this month', 'Nothing recorded this month yet'],
        lifetime: [null, 'so far', 'Nothing recorded yet'],
      },
    };

    const QUOTA_PERIOD_LABEL = { day: 'day', week: 'week', month: 'month', lifetime: 'one-off' };

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

    function publishedQuotaHtml(known, extraClass = '', recorded = null) {
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
          <div class="quota-published-title">Published limits</div>
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
    function quotaBarsHtml(provider, rateLimit = null) {
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
      // second source that can overwrite the account-wide reports.
      if (reports.length === 0 && rateLimit) {
        const headerReports = [];
        if (rateLimit.limitRequests != null) headerReports.push({ metric: 'requests', unit: 'requests', limit: rateLimit.limitRequests, remaining: rateLimit.remainingRequests, window: 'provider rate-limit window' });
        if (rateLimit.limitTokens != null) headerReports.push({ metric: 'tokens', unit: 'tokens', limit: rateLimit.limitTokens, remaining: rateLimit.remainingTokens, window: 'provider rate-limit window' });
        if (rateLimit.creditLimit != null) headerReports.push({ metric: 'credits', unit: 'credits', limit: rateLimit.creditLimit, remaining: rateLimit.creditRemaining, window: 'provider credit window', resetAt: rateLimit.creditResetAt });
        if (headerReports.length > 0) {
          reports = headerReports;
          provenance = 'headers';
          provenanceLabel = 'From the last response';
        }
      }

      const known = hasPublishedQuota(provider?.knownQuota) ? provider.knownQuota : null;
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
        provenance = known ? 'published' : (notes ? 'observed' : 'none');
        provenanceLabel = known ? 'Published limits' : (notes ? 'Observed' : 'Not reported');
        return `
          <div class="quota-bars-section quota-bars-${provenance}" aria-label="Provider quota">
            <div class="quota-bars-heading">Quota <span class="quota-provenance">${escapeHtml(provenanceLabel)}</span></div>
            ${known ? publishedQuotaHtml(known, '', provider?.recordedUsage) : ''}
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
          ${known ? publishedQuotaHtml(known, 'quota-published-footnote', provider?.recordedUsage) : ''}
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
    // Nothing here invents a percentage of an allowance. The server knows how many requests a
    // credential has served and whether it is currently exhausted; it does not know how much of
    // a provider's free tier remains, and a bar that guessed at that would be a lie that looks
    // like data. So the fill is the *share of this provider's traffic* each credential has
    // carried, and exhaustion is stated outright, with the reset counted down when the provider
    // said when it lifts.
    //
    // A provider with a single credential gets a single bar, because "is there anything left in
    // this account?" is the same question whether the pool holds one or five.
    function credentialBarHtml(provider) {
      const pool = provider ? provider.credentialPool : null;
      if (!pool || !Array.isArray(pool.accounts) || pool.accounts.length === 0) return '';
      const accounts = pool.accounts;
      const totalRequests = accounts.reduce((sum, account) => sum + (Number(account.requests) || 0), 0);
      const serving = accounts[pool.servingIndex] || null;

      const segments = accounts.map((account, i) => {
        const requests = Number(account.requests) || 0;
        // Equal widths before anything has been served: with no traffic yet the pool is a plan,
        // not a measurement, and drawing one credential as "100%" would assert otherwise.
        const share = totalRequests > 0 ? (requests / totalRequests) * 100 : 100 / accounts.length;
        const isServing = i === pool.servingIndex && !account.exhausted;
        const label = account.label || `Account ${i + 1}`;
        const title = `${label} \u2014 ${requests} request${requests === 1 ? '' : 's'}`
          + (account.exhausted ? ' \u00b7 exhausted' : isServing ? ' \u00b7 serving' : ' \u00b7 waiting its turn');
        const fill = account.exhausted
          ? 'var(--status-error-bg)'
          : isServing ? 'var(--accent)' : 'var(--border)';
        // The exhausted segment is hatched rather than merely red, so it reads as spent at a
        // glance without relying on colour alone.
        const hatch = account.exhausted
          ? 'background-image:repeating-linear-gradient(45deg, transparent, transparent 3px, var(--status-error-border) 3px, var(--status-error-border) 6px);'
          : '';
        return `<div title="${escapeHtml(title)}" data-pool-segment="${i}" style="width:${share.toFixed(3)}%; height:100%; background:${fill}; ${hatch}${i > 0 ? ' border-left:1px solid var(--border);' : ''}"></div>`;
      }).join('');

      const spent = accounts.filter(account => account.exhausted);
      const soonestResetMs = spent.reduce((soonest, account) => {
        const ms = Number(account.resetsInMs);
        if (!Number.isFinite(ms) || ms <= 0) return soonest;
        return soonest === null || ms < soonest ? ms : soonest;
      }, null);

      const summary = [`${accounts.length} account${accounts.length === 1 ? '' : 's'}`];
      if (totalRequests > 0) summary.push(`${totalRequests.toLocaleString()} request${totalRequests === 1 ? '' : 's'}`);
      if (serving && !serving.exhausted && accounts.length > 1) summary.push(`${serving.label || 'first account'} serving`);
      if (spent.length > 0) {
        summary.push(spent.length === accounts.length
          ? 'all accounts exhausted'
          : `${spent.length} exhausted`);
      }

      const resetHtml = soonestResetMs === null
        ? ''
        : `<span data-pool-reset-at="${Date.now() + soonestResetMs}" style="margin-left:6px;">resets in ${escapeHtml(formatCountdown(soonestResetMs))}</span>`;

      return `
        <div style="margin-top:12px;">
          <div style="display:flex; height:8px; border-radius:999px; overflow:hidden; border:1px solid var(--border); background:var(--input-bg);">
            ${segments}
          </div>
          <div style="margin-top:6px; font-size:0.72rem; color:var(--text-muted);">${escapeHtml(summary.join(' \u00b7 '))}${resetHtml}</div>
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

    initializeChat();
    updateLogsPauseButton();
    initScatterControls();

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
      let source = null;
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
