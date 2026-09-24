/**
 * ── Discovery: reading a provider's model list ─────────────────────────────────────────
 *
 * Every provider publishes its menu of models somewhere, and each one publishes it a little
 * differently: KiloCode flags free rows with `isFree`, Ollama serves `/api/tags` plus a
 * per-model `/api/show`, Empero and the
 * OpenAI-compatible endpoints hand back a plain OpenAI `data` array, and OpenRouter returns
 * everything with only the `:free` variants routable. This module is that difference — the
 * extraction, the labelling and the fetching — for every provider hammer discovers.
 *
 * It lives here rather than in `lib/server.js` for two reasons. It is the region a
 * `score-fetcher` and the request path both reach for, so `lib/score-fetcher.js` used to
 * import these functions *from the 11k-line server*, the wrong direction for a module that
 * only reads catalogs. And none of it depends on server state: the fetches are plain
 * `fetch`, the transforms are pure, and the two rules that decide *when* to discover
 * (`lazyDiscoveryCandidates`, `resolveRequestModels`) take their collaborators as arguments
 * precisely so they can be tested without a server.
 *
 * Two invariants this module keeps, both load-bearing:
 *
 *   - **Nothing here runs at import time.** Importing this module cannot open a socket, so
 *     it is safe to import from the provider registry's side of the app; the fetches only
 *     happen when a caller asks. The `lib/providers/` boot-safety test enumerates the files
 *     it guards, and this one is deliberately *not* on that list for exactly this reason.
 *   - **It never imports `lib/server.js`.** Discovery sits below the server in the import
 *     graph, so importing it would point the dependency the wrong way and close a cycle.
 */

import {
  MODELS,
  canonicalizeModelId,
  getPreferredModelContext,
  getPreferredModelLabel,
  getScore,
  resolveAliasedModelId,
  stripRoutingNamespace,
} from '../../sources.js'
import { getApiKey, getProviderBaseUrl, getProviderModelId } from '../config.js'
// The registry populates itself when its module is imported, so `providerAcceptsMissingKey`
// below reads a filled registry rather than an empty one. `./index.js` (rather than
// `./registry.js`) is what guarantees that, whichever module the process loads first.
import { getProvider } from './index.js'
import { filterModelsByRequested } from '../utils.js'
import {
  EMPERO_PROVIDER_KEY,
  KILOCODE_PROVIDER_KEY,
  OLLAMA_PROVIDER_KEY,
  OPENROUTER_PROVIDER_KEY,
} from '../provider-keys.js'

/**
 * How long one model-list fetch may wait before it is aborted.
 *
 * The same window and the same env var as the router's `PING_TIMEOUT` (`lib/server.js`),
 * which every other probe uses: a provider that is merely slow to cold-start a catalog
 * should not look unreachable to discovery any sooner than it does to a ping. Defined here
 * rather than imported, because discovery sits below `server.js` in the import graph — a
 * test asserts the two constants agree, so the shared value cannot drift.
 */
export const DISCOVERY_TIMEOUT_MS = Number(process.env.HAMMER_PING_TIMEOUT_MS) || 60_000
export const DISCOVERY_MAX_ATTEMPTS = 2
export const DISCOVERY_RETRY_BASE_MS = 250

/**
 * Whether a failed catalog request is worth trying again.
 *
 * Discovery is a best-effort read of a remote menu, so transient transport and server failures
 * should not make a provider look empty on the first blip. Authentication, authorization, and
 * other client errors are different: repeating them only spends time and can create a noisy
 * boot log without changing the answer.
 */
export function isRetryableDiscoveryError(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase()
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return true
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true
  const status = Number(error?.status || error?.response?.status)
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryDelayMs(error, attempt, random = Math.random) {
  const retryAfter = error?.retryAfterMs
  if (Number.isFinite(retryAfter)) return Math.min(2_000, Math.max(0, retryAfter))
  const base = DISCOVERY_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1))
  const jitter = Math.floor(base * 0.25 * random())
  return Math.min(2_000, base + jitter)
}

function parseRetryAfterMs(value) {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value || '')
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

/**
 * Fetch and parse JSON with a bounded retry budget.
 *
 * Every attempt gets its own timeout so a stalled DNS/socket cannot consume the next attempt's
 * budget. The helper is deliberately generic and injectable for tests; production callers use
 * Node's global fetch and the normal timer. A 2-attempt default keeps a slow provider from
 * multiplying the boot wait by an unbounded amount while still covering the common one-off
 * connection reset.
 */
export async function fetchJsonWithRetry(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    fetchImpl = globalThis.fetch,
    maxAttempts = DISCOVERY_MAX_ATTEMPTS,
    timeoutMs = DISCOVERY_TIMEOUT_MS,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
    random = Math.random,
    ...fetchOptions
  } = options
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetchImpl(url, { ...fetchOptions, method, headers, body, signal: controller.signal })
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        error.status = response.status
        error.retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'))
        if (!isRetryableDiscoveryError(error) || attempt >= maxAttempts) throw error
        lastError = error
        try { await response.body?.cancel() } catch { /* nothing to release */ }
      } else {
        return await response.json()
      }
    } catch (error) {
      const normalized = timedOut
        ? Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT', cause: error })
        : error
      if (!isRetryableDiscoveryError(normalized) || attempt >= maxAttempts) throw normalized
      lastError = normalized
    } finally {
      clearTimeout(timeoutId)
    }
    await sleep(retryDelayMs(lastError, attempt, random))
  }

  throw lastError || new Error('Discovery request failed.')
}

/** KiloCode's gateway model list. */
const KILOCODE_MODELS_URL = 'https://api.kilo.ai/api/gateway/models'
/** Empero's OpenAI-compatible model list. */
const EMPERO_MODELS_URL = 'https://free.empero.org/v1/models'
/** OpenRouter's catalog, filtered to `:free` rows by `toOpenRouterModelMeta`. */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/**
 * 📖 True when a provider answers without a credential, so a request to it must not be
 * 📖 refused for having no API key.
 *
 * This used to be a hardcoded set (kilocode, opencode, empero, gptfree — the
 * second since removed as a provider). That
 * worked for the providers hammer shipped, and broke silently for every provider it
 * imported: an imported provider whose descriptor says `auth.optional` was discovered,
 * listed in /v1/models, and then refused at dispatch with NO_KEY — reachable on paper and
 * unreachable in practice. It now reads the provider registry, which is the single owner of
 * the fact, so hammer's five keep working and an import inherits the behaviour from its own
 * descriptor.
 */
function providerAcceptsMissingKey(providerKey) {
  const auth = getProvider(providerKey)?.auth;
  return auth?.optional === true || auth?.kind === 'none';
}

export function isProviderBearerAuthEnabled(config, providerKey) {
  if (!providerAcceptsMissingKey(providerKey)) return true;
  const providerConfig = config?.providers?.[providerKey];
  if (!providerConfig || providerConfig.useBearerAuth == null) return true;
  return providerConfig.useBearerAuth !== false;
}

function isLocalOllamaBaseUrl(config) {
  const rawBaseUrl = getProviderBaseUrl(config, OLLAMA_PROVIDER_KEY);
  if (!rawBaseUrl) return false;

  let urlText = rawBaseUrl.trim();
  if (!urlText) return false;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = `http://${urlText}`;
  }

  try {
    const parsed = new URL(urlText);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function isProviderAuthOptional(config, providerKey) {
  if (providerKey === OLLAMA_PROVIDER_KEY && isLocalOllamaBaseUrl(config)) return true;
  return providerAcceptsMissingKey(providerKey);
}

export function providerWantsBearerAuth(config, providerKey) {
  return isProviderBearerAuthEnabled(config, providerKey);
}

/**
 * 📖 True when a provider's model list must not be read, because the provider needs a
 * 📖 credential and none is configured.
 *
 * A catalog endpoint can be public while the chat endpoint behind it is not, and reading the
 * list is what turns that into apparent capability. Ollama Cloud is the case that made this a
 * rule: `GET https://ollama.com/api/tags` answers 200 to an anonymous caller with its whole
 * hosted roster, so discovery imported 20 rows for a provider whose chat path is key-gated —
 * and every one of them was refused at dispatch with NO_KEY. The rows then read as models
 * hammer can route, which is exactly the "reachable on paper, unreachable in practice"
 * failure the imports were fixed for. Listing nothing is the honest outcome: the provider
 * cannot answer without a key, and a key is the one thing that changes that.
 *
 * The test is deliberately the *same* one dispatch applies (see
 * {@link isProviderAuthOptional}), because the bug is only ever the two disagreeing — a
 * provider that is keyless at dispatch but credential-gated at discovery, or the reverse,
 * gives rows that contradict the router.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function providerDiscoveryNeedsCredential(config, providerKey) {
  return !getApiKey(config, providerKey) && !isProviderAuthOptional(config, providerKey);
}

export function shouldRetryOptionalProviderWithBearer(config, providerKey, auth, code, errorMessage) {
  if (code !== '401') return false;
  if (!isProviderAuthOptional(config, providerKey)) return false;
  if (auth?.token) return false;

  const apiKey = getApiKey(config, providerKey);
  if (!apiKey) return false;

  const message = String(errorMessage || '').toLowerCase();
  if (!message) return true;

  return message.includes('missing api key')
    || message.includes('unauthorized')
    || message.includes('auth');
}

export function normalizeOpenAICompatibleProviderUrl(resourceUrl) {
  return buildOpenAICompatibleResourceUrl(resourceUrl, '/chat/completions');
}

export function buildOpenAICompatibleModelsListUrl(resourceUrl) {
  return buildOpenAICompatibleResourceUrl(resourceUrl, '/models');
}

function buildOpenAICompatibleResourceUrl(resourceUrl, suffix) {
  if (!resourceUrl || typeof resourceUrl !== 'string') return null;
  const trimmed = resourceUrl.trim();
  if (!trimmed) return null;

  let urlText = trimmed;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = 'https://' + urlText;
  }

  try {
    const parsed = new URL(urlText);
    let pathname = (parsed.pathname || '/').replace(/\/+$/, '');

    // 📖 If the configured URL already names a specific OpenAI v1 verb,
    // 📖 strip it so `suffix` lands at the v1 root.
    if (pathname.endsWith('/chat/completions')) {
      pathname = pathname.slice(0, -'/chat/completions'.length);
    } else if (pathname.endsWith('/models')) {
      pathname = pathname.slice(0, -'/models'.length);
    }

    // Some OpenAI-compatible APIs, notably Gemini, use an `/openai` root
    // instead of `/v1`. In either case, append the requested resource directly.
    if (pathname.endsWith('/v1') || pathname.endsWith('/openai')) {
      parsed.pathname = pathname + suffix;
      return parsed.toString();
    }

    parsed.pathname = (pathname === '' ? '' : pathname) + '/v1' + suffix;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getDefaultProviderBaseUrl(providerKey) {
  if (providerKey === OLLAMA_PROVIDER_KEY) return 'https://ollama.com/v1';
  return null;
}

/**
 * The URL a provider's model list is read from.
 *
 * A configured base URL redirects the provider's *traffic*, so discovery follows it too
 * (see refreshDiscoverableProviderModels). Absent an override, a provider's own declared
 * `modelsUrl` is honored, because some providers publish their list somewhere other than
 * the sibling of their chat path: Fireworks filters to serverless models, and Ollama Cloud
 * serves its native /api/tags. Re-deriving the sibling URL for those returns rows that then
 * 404 at chat time, which would mark a healthy provider dead.
 *
 * @param {{ url?: string, modelsUrl?: string|null }|null} source
 * @param {string|null} [baseUrlOverride]
 * @returns {string|null}
 */
export function resolveDiscoveryModelsUrl(source, baseUrlOverride = null) {
  if (!source) return null;
  const base = baseUrlOverride || source.url;
  if (!base) return null;
  const chatUrl = String(base).replace(/\/chat\/completions$/, '');
  // A configured override is the source of truth for where this provider answers, declared
  // list or not: a user who points a provider at their own server wants it read from there.
  if (baseUrlOverride) return buildOpenAICompatibleModelsListUrl(chatUrl);
  return source.modelsUrl || buildOpenAICompatibleModelsListUrl(chatUrl);
}

/**
 * Which unresolved imported providers a request should probe (see
 * `discoverLazyImportsForRequest`). Pure so the rule can be tested without standing up a
 * server, and so the request path and any future caller cannot disagree about it.
 *
 * @param {Record<string, object>} availableSources
 * @param {Set<string>} providersWithRows  providers already in the routing table
 * @param {object} config
 * @param {{ isAuthOptional: (config: object, key: string) => boolean, hasApiKey: (config: object, key: string) => any }} helpers
 * @returns {string[]}
 */
export function lazyDiscoveryCandidates(availableSources, providersWithRows, config, helpers = {}) {
  const isAuthOptional = helpers.isAuthOptional || (() => false);
  const hasApiKey = helpers.hasApiKey || (() => null);
  return Object.keys(availableSources).filter(key => {
    const source = availableSources[key];
    // Only the lazy imports; hammer's own providers participate in the boot wave already.
    if (!source?.lazyDiscovery || !source.discoverable) return false;
    // Rows exist: nothing to discover, and re-probing would be the background traffic the
    // lazy flag exists to avoid.
    if (providersWithRows.has(key)) return false;
    // Only a provider that could answer is worth probing: keyless, or holding a key.
    return isAuthOptional(config, key) === true || Boolean(hasApiKey(config, key));
  });
}

/**
 * 📖 The models a request may route to, after giving unresolved imports a chance.
 *
 * A concrete model the table does not know yet may be served by an imported provider whose
 * rows have never been fetched, so the first miss triggers on-demand discovery and the table
 * is re-read before the caller's not-found handling runs. `best`/auto requests are
 * deliberately not a trigger: they already have hammer's whole catalog to choose from, and
 * sweeping imports from them would be the boot wave by another name.
 *
 * The rule lives here, exported, so a test can drive the exact decision the request handler
 * makes without standing up the HTTP server, and so the handler and the test cannot drift.
 * `getResults` is a getter rather than an array because discovery may *replace* the table.
 *
 * @param {{
 *   getResults: () => object[],
 *   requestModel: string|undefined,
 *   canonicalize: Function,
 *   isSmartestRequest: boolean,
 *   discover?: ((model: string) => Promise<unknown>)|null,
 * }} options
 * @returns {Promise<object[]>}
 */
export async function resolveRequestModels({
  getResults,
  requestModel,
  canonicalize,
  isSmartestRequest,
  discover = null,
}) {
  let requested = filterModelsByRequested(getResults(), requestModel, canonicalize);
  if (requestModel && !isSmartestRequest && requested.length === 0 && typeof discover === 'function') {
    await discover(requestModel);
    requested = filterModelsByRequested(getResults(), requestModel, canonicalize);
  }
  return requested;
}

export function formatGenericProviderModelLabel(modelId) {
  if (!modelId) return 'Custom Model';
  // A g4f namespace ("srv_ab12:") is routing info, not part of the model's name.
  const leaf = stripRoutingNamespace(modelId).split('/').pop() || modelId;
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function buildConfigurableProviderModelMeta(config, providerKey, defaultBaseUrl = null) {
  const modelId = getProviderModelId(config, providerKey);
  const configuredBaseUrl = getProviderBaseUrl(config, providerKey);
  const baseUrl = normalizeOpenAICompatibleProviderUrl(configuredBaseUrl || defaultBaseUrl);
  if (!modelId || !baseUrl) return null;

  const { base, unprefixed } = canonicalizeModelId(modelId);
  const known = findKnownModelMeta([base, unprefixed], providerKey);
  const knownScore = normalizeIntelligenceScore(getScore(modelId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  return {
    modelId,
    label: known?.label || formatGenericProviderModelLabel(modelId),
    intell: knownScore ?? known?.intell ?? null,
    isEstimatedScore: !hasScore,
    ctx: known?.providerKey === providerKey ? known.ctx : null,
    ctxSource: known?.providerKey === providerKey ? known.ctxSource : null,
    ctxSourceUrl: known?.providerKey === providerKey ? known.ctxSourceUrl : null,
    providerKey,
    providerUrl: baseUrl,
  };
}

export function buildOpenAICompatibleModelMeta(config, instanceKey) {
  return buildConfigurableProviderModelMeta(config, instanceKey);
}

export function buildOllamaModelMeta(config) {
  return buildConfigurableProviderModelMeta(config, OLLAMA_PROVIDER_KEY, 'https://ollama.com/v1');
}

function getKnownModelMetaMap() {
  const map = new Map();
  for (const [modelId, label, intell, ctx, providerKey, ctxSource, ctxSourceUrl] of MODELS) {
    const meta = { label, intell, ctx, providerKey, ctxSource, ctxSourceUrl };
    map.set(`${providerKey}:${modelId}`, meta);
    if (!map.has(modelId)) map.set(modelId, meta);
  }
  return map;
}

const knownModelMetaMap = getKnownModelMetaMap();

export function findKnownModelMeta(ids, providerKey = null) {
  const values = ids.filter(Boolean);
  if (providerKey) {
    for (const id of values) {
      const match = knownModelMetaMap.get(`${providerKey}:${id}`);
      if (match) return match;
    }
  }
  for (const id of values) {
    const match = knownModelMetaMap.get(id);
    if (match) return match;
  }
  return null;
}

function extractKiloCodeModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') {
    if (Array.isArray(payload.data.models)) return payload.data.models;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  return [];
}

function parseKiloCodeContext(rawCtx) {
  if (rawCtx == null) return null;
  if (typeof rawCtx === 'number' && Number.isFinite(rawCtx) && rawCtx > 0) {
    if (rawCtx % 1_000_000 === 0) return `${rawCtx / 1_000_000}M`;
    if (rawCtx % 1000 === 0) return `${rawCtx / 1000}k`;
    return String(Math.round(rawCtx));
  }
  if (typeof rawCtx === 'string' && rawCtx.trim()) return rawCtx.trim();
  return null;
}

export function resolveModelContext(rawCtx, known = null) {
  const reported = parseKiloCodeContext(rawCtx);
  if (reported) return { ctx: reported, ctxSource: 'provider-reported', ctxSourceUrl: null };
  if (known?.ctx) return { ctx: known.ctx, ctxSource: known.ctxSource || 'curated', ctxSourceUrl: known.ctxSourceUrl || null };
  return { ctx: null, ctxSource: null, ctxSourceUrl: null };
}

export function getReportedContext(record) {
  if (!record || typeof record !== 'object') return null;
  return record.context_length
    ?? record.contextLength
    ?? record.ctx
    ?? record.top_provider?.context_length
    ?? record.limits?.max_context_length
    ?? null;
}

export function normalizeIntelligenceScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function extractSWEPercentFromDescription(description) {
  if (typeof description !== 'string' || !description.trim()) return null;
  const match = description.match(/(\d+(?:\.\d+)?)%\s+on\s+SWE-?Bench(?:\s+Verified)?/i);
  if (!match) return null;
  return Number(match[1]);
}

export function isChatCompatibleDiscoveredModel(record, modelId) {
  // A record may declare what it is *for*, and Cloudflare's model search does
  // (`task: { name: "Text Embeddings" }`). It is read as one more name to screen, because a
  // Cloudflare id carries no hint at all: `@cf/baai/bge-large-en-v1.5` is an embedding model
  // whose id looks exactly like a chat one, so without the task it would be imported as a
  // chat row and then 404 at chat time.
  const task = typeof record?.task === 'string'
    ? record.task
    : (typeof record?.task?.name === 'string' ? record.task.name : null);
  const metadata = typeof record === 'object' && record
    ? [record.type, record.object, record.capability, record.name, task].filter(Boolean).join(' ')
    : '';
  const description = `${modelId} ${metadata}`.toLowerCase();
  return !/(?:embed(?:ding)?|rerank|moderation|guard|safety|classifier|whisper|speech|text-to-speech|\btts\b|image|veo|video)/.test(description);
}

export function toKiloCodeModelMeta(record) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.id || record?.model || record?.name || '').trim();
  // The provider flags free models authoritatively via record.isFree; the ':free'
  // id suffix is kept as a fallback for records that omit the field.
  const isFree = (typeof record === 'object' && record && record.isFree === true) || modelId.endsWith(':free');
  if (!modelId || !isFree) return null;
  if (!isChatCompatibleDiscoveredModel(record, modelId)) return null;

  const known = findKnownModelMeta([modelId, modelId.replace(/:free$/, '')], KILOCODE_PROVIDER_KEY);
  let label = (typeof record === 'object' && record && typeof record.display_name === 'string' && record.display_name.trim())
    ? record.display_name.trim()
    : getPreferredModelLabel(modelId, known?.label || modelId);
  label = getPreferredModelLabel(modelId, label);
  const intellRaw = typeof record === 'object' && record
    ? (record.intell ?? record.swe ?? record.score ?? record.swe_score)
    : null;
  const swePercent = typeof record === 'object' && record
    ? extractSWEPercentFromDescription(record.description)
    : null;
  const normalizedIntell = normalizeIntelligenceScore(intellRaw);
  const normalizedSWE = normalizeIntelligenceScore(swePercent);
  const knownScore = normalizeIntelligenceScore(getScore(modelId));

  const hasScore = (normalizedIntell != null && normalizedIntell > 0)
    || (normalizedSWE != null && normalizedSWE > 0)
    || (knownScore != null && knownScore > 0)
    || (known != null && known.intell != null && known.intell > 0);
  const intell = normalizedIntell ?? normalizedSWE ?? knownScore ?? known?.intell ?? null;
  const isEstimatedScore = !hasScore;

  const ctxRaw = getReportedContext(record);
  const { ctx, ctxSource, ctxSourceUrl } = resolveModelContext(ctxRaw, known?.providerKey === KILOCODE_PROVIDER_KEY ? known : null);

  return { modelId, label, intell, isEstimatedScore, ctx, ctxSource, ctxSourceUrl, providerKey: KILOCODE_PROVIDER_KEY };
}

export async function fetchKiloCodeFreeModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, KILOCODE_PROVIDER_KEY);
  if (token && providerWantsBearerAuth(config, KILOCODE_PROVIDER_KEY)) {
    headers.Authorization = `Bearer ${token}`;
  }

  const payload = await fetchJsonWithRetry(KILOCODE_MODELS_URL, {
    method: 'GET',
    headers,
  });
  const records = extractKiloCodeModelRecords(payload);
  const seen = new Set();
  const models = [];

  for (const record of records) {
    const model = toKiloCodeModelMeta(record);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }

  return models;
}

export function extractOpenRouterModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function extractOllamaModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function extractEmperoModelRecords(payload) {
  return extractOpenAICompatibleModelRecords(payload);
}

export function toEmperoModelMeta(record) {
  const model = toOpenAICompatibleDiscoveredModelMeta(record, EMPERO_PROVIDER_KEY, 'https://free.empero.org/v1/chat/completions');
  if (!model) return null;
  return { ...model, providerKey: EMPERO_PROVIDER_KEY };
}

export async function fetchEmperoModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, EMPERO_PROVIDER_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = await fetchJsonWithRetry(EMPERO_MODELS_URL, { method: 'GET', headers });
  const records = extractEmperoModelRecords(payload);
  const seen = new Set();
  return records.flatMap(record => {
    const model = toEmperoModelMeta(record);
    if (!model || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [model];
  });
}

/**
 * The upstream origin a federated catalog's entry says it came from, when it says so.
 *
 * A gateway can front many servers at once — g4f.space federates dozens, and each row says
 * which one serves it (`server: "srv_ab12"`, `owned_by: "nvidia.com"`). One model reached
 * through two of those servers is two providers, with their own uptimes, latencies, tests
 * and outages; merging them hides which upstream is sick behind a single row that neither
 * describes. So the origin travels with the row, and the table and network plot read it.
 *
 * Gated on `server` alone: a catalog that does not federate (every other provider today)
 * never sets it, and `owned_by` — which OpenAI's own /v1/models does set, to "system" — is
 * read only as the origin's *name*, never as evidence of one. Returns an empty object when
 * there is no origin, so callers can spread it without branching.
 */
export function resolveDiscoveredOrigin(record, modelId) {
  const server = typeof record === 'object' && record ? String(record.server ?? '').trim() : '';
  if (!server) return {};
  // The routing namespace the id carries is what actually goes upstream to select the
  // backend, so it names the origin when present (see stripRoutingNamespace); an id with
  // none — the gateway's own pool, and its `core` bucket, which tags rows its own way —
  // takes the record's own `server` field.
  const rawId = String(modelId || '');
  const usesRoutingNamespace = stripRoutingNamespace(rawId) !== rawId;
  const originId = usesRoutingNamespace ? rawId.slice(0, rawId.indexOf(':')) : server;
  const ownedBy = typeof record === 'object' && record ? String(record.owned_by ?? '').trim() : '';
  return { originId, originLabel: ownedBy || null };
}

export function extractOpenAICompatibleModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  // Cloudflare's model search wraps its list in the platform's standard envelope
  // (`{ success, errors, messages, result }`) rather than OpenAI's `data`, and its records
  // name the model in `name` — which the row builder already reads.
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

export function toOpenAICompatibleDiscoveredModelMeta(record, instanceKey, providerUrl = null) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId) return null;
  if (!isChatCompatibleDiscoveredModel(record, modelId)) return null;

  const scoreLookupId = resolveAliasedModelId(modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = findKnownModelMeta([scoreLookupId, base, unprefixed, modelId], instanceKey);
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  const recordLabel = (record && typeof record === 'object' && typeof record.name === 'string' && record.name.trim())
    ? record.name.trim()
    : null;
  const label = getPreferredModelLabel(scoreLookupId, recordLabel || known?.label || formatGenericProviderModelLabel(modelId));

  const ctxRaw = getReportedContext(record);
  const { ctx, ctxSource, ctxSourceUrl } = resolveModelContext(ctxRaw, known?.providerKey === instanceKey ? known : null);

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? null,
    isEstimatedScore: !hasScore,
    ctx,
    ctxSource,
    ctxSourceUrl,
    providerKey: instanceKey,
    providerUrl: providerUrl || undefined,
    ...resolveDiscoveredOrigin(record, modelId),
  };
}

export async function fetchOpenAICompatibleDiscoveredModels(config, instanceKey) {
  const baseUrl = getProviderBaseUrl(config, instanceKey);
  if (!baseUrl) return [];
  const modelsUrl = buildOpenAICompatibleModelsListUrl(baseUrl);
  if (!modelsUrl) return [];

  const headers = { Accept: 'application/json' };
  const apiKey = getApiKey(config, instanceKey);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const payload = await fetchJsonWithRetry(modelsUrl, { method: 'GET', headers });
  const records = extractOpenAICompatibleModelRecords(payload);
  const seen = new Set();
  const models = [];
  const chatUrl = normalizeOpenAICompatibleProviderUrl(baseUrl);
  for (const record of records) {
    const model = toOpenAICompatibleDiscoveredModelMeta(record, instanceKey, chatUrl);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }
  return models;
}

export function isOpenAICompatibleDiscoveryEnabled(config, instanceKey) {
  const providerConfig = config?.providers?.[instanceKey];
  if (!providerConfig) return true;
  return providerConfig.discoverModels !== false;
}

export function toOllamaModelMeta(record) {
  const modelId = String(record?.model || record?.name || record?.id || '').trim();
  if (!modelId) return null;

  const remoteModelId = String(record?.remote_model || '').trim();
  const scoreLookupId = resolveAliasedModelId(remoteModelId || modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = findKnownModelMeta([scoreLookupId, base, unprefixed, modelId], OLLAMA_PROVIDER_KEY);
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  const recordName = typeof record?.name === 'string' ? record.name.trim() : '';
  let label = (recordName && recordName !== modelId)
    ? recordName
    : (known?.label || formatGenericProviderModelLabel(modelId));
  label = getPreferredModelLabel(scoreLookupId, label);

  const runningCtx = parseKiloCodeContext(record?._running?.context_length);
  const configuredMatch = typeof record?._show?.parameters === 'string'
    ? record._show.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/i)
    : null;
  const configuredCtx = parseKiloCodeContext(configuredMatch?.[1]);
  const modelInfo = record?._show?.model_info;
  const maximumRaw = modelInfo && typeof modelInfo === 'object'
    ? Object.entries(modelInfo).find(([key]) => key.endsWith('.context_length'))?.[1]
    : null;
  const maximumCtx = parseKiloCodeContext(maximumRaw);
  const ctx = runningCtx || configuredCtx || maximumCtx || null;
  const ctxSource = runningCtx
    ? 'runtime-allocated'
    : configuredCtx
      ? 'provider-reported'
      : maximumCtx
        ? 'model-maximum'
        : null;

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? null,
    isEstimatedScore: !hasScore,
    ctx,
    ctxSource,
    ctxSourceUrl: ctx ? 'https://docs.ollama.com/api/show' : null,
    providerKey: OLLAMA_PROVIDER_KEY,
  };
}

function getOllamaApiUrl(config, pathname = '/api/tags') {
  const configuredBaseUrl = getProviderBaseUrl(config, OLLAMA_PROVIDER_KEY) || getDefaultProviderBaseUrl(OLLAMA_PROVIDER_KEY);
  let urlText = configuredBaseUrl.trim();
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = `https://${urlText}`;
  }

  try {
    const parsed = new URL(urlText);
    parsed.pathname = pathname;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return `https://ollama.com${pathname}`;
  }
}

export async function fetchOllamaModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, OLLAMA_PROVIDER_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;

  // The roster is the required result. Running-model and per-model metadata are useful
  // enrichment, but a local Ollama that is slow or briefly unavailable for those endpoints
  // must not make the whole catalog discovery fail.
  const payload = await fetchJsonWithRetry(getOllamaApiUrl(config), { method: 'GET', headers });
  const records = extractOllamaModelRecords(payload);
  let runningById = new Map();
  try {
    const runningPayload = await fetchJsonWithRetry(getOllamaApiUrl(config, '/api/ps'), { method: 'GET', headers });
    const runningRecords = extractOllamaModelRecords(runningPayload);
    runningById = new Map(runningRecords.map(item => [String(item.model || item.name || ''), item]));
  } catch {}

  const enrichedRecords = [];
  const enrichmentConcurrency = 4;
  for (let i = 0; i < records.length; i += enrichmentConcurrency) {
    const batch = records.slice(i, i + enrichmentConcurrency);
    const enriched = await Promise.all(batch.map(async record => {
      const modelId = String(record?.model || record?.name || record?.id || '').trim();
      let show = null;
      try {
        show = await fetchJsonWithRetry(getOllamaApiUrl(config, '/api/show'), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        });
      } catch {}
      return { ...record, _show: show, _running: runningById.get(modelId) || null };
    }));
    enrichedRecords.push(...enriched);
  }

  const seen = new Set();
  const models = [];
  for (const record of enrichedRecords) {
    const model = toOllamaModelMeta(record);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }
  return models;
}

export function toOpenRouterModelMeta(record) {
  const modelId = String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId || !modelId.endsWith(':free')) return null;
  if (!isChatCompatibleDiscoveredModel(record, modelId)) return null;

  const { base, unprefixed } = canonicalizeModelId(modelId);
  const known = findKnownModelMeta([base, unprefixed], OPENROUTER_PROVIDER_KEY);
  let label = (record && typeof record.name === 'string' && record.name.trim())
    ? record.name.trim()
    : (known?.label || modelId);

  // Clean label: "Google: Gemma 2B (free)" -> "Gemma 2B"
  if (label.includes(':')) {
    const parts = label.split(':');
    // If it looks like "Lab: Model", take the last part
    if (parts.length > 1) {
      label = parts[parts.length - 1].trim();
    }
  }
  // Remove "(free)" or "free" suffix case-insensitively
  label = label.replace(/\s*\(?free\)?\s*$/i, '').trim();

  if (!label) {
    label = known?.label || modelId;
  }

  label = getPreferredModelLabel(modelId, label);

  // OpenRouter doesn't provide a direct intelligence score, but we can use scores.js
  // before falling back to known meta/default.
  const knownScore = normalizeIntelligenceScore(getScore(modelId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);
  const intell = knownScore ?? known?.intell ?? null;
  const isEstimatedScore = !hasScore;

  const ctxRaw = getReportedContext(record);
  const { ctx, ctxSource, ctxSourceUrl } = resolveModelContext(ctxRaw, known?.providerKey === OPENROUTER_PROVIDER_KEY ? known : null);

  return { modelId, label, intell, isEstimatedScore, ctx, ctxSource, ctxSourceUrl, providerKey: OPENROUTER_PROVIDER_KEY };
}

export async function fetchOpenRouterFreeModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, OPENROUTER_PROVIDER_KEY);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const payload = await fetchJsonWithRetry(OPENROUTER_MODELS_URL, { method: 'GET', headers });
  const records = extractOpenRouterModelRecords(payload);
  const seen = new Set();
  const models = [];

  for (const record of records) {
    const model = toOpenRouterModelMeta(record);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }

  return models;
}
