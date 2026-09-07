import { canonicalizeModelId, resolveAliasedModelId } from '../sources.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const LMARENA_BOARD_URLS = {
  coding: 'https://lmarena.ai/leaderboard/text/coding',
  overall: 'https://lmarena.ai/leaderboard',
};
export const MODEL_QUALITY_CACHE_MS = 24 * 60 * 60_000;

let cachedQuality = null;
let cachedAt = 0;
let cachedLMArena = null;
let cachedLMArenaAt = 0;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function qualityLookupKeys(modelId) {
  const resolved = resolveAliasedModelId(String(modelId || '').trim().toLowerCase());
  if (!resolved) return [];
  const { base, unprefixed } = canonicalizeModelId(resolved);
  const normalizedBase = base.replace(/^~/, '').replace(/-free$/i, '');
  const normalizedLeaf = unprefixed.replace(/-free$/i, '');
  return [...new Set([
    normalizedBase,
    normalizedLeaf,
    normalizedBase.replace(/:/g, '-'),
    normalizedLeaf.replace(/:/g, '-'),
  ].filter(Boolean))];
}

export function getArtificialAnalysisCodingIndex(model) {
  const value = Number(model?.benchmarks?.artificial_analysis?.coding_index);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getDesignArenaCodeElo(model) {
  const rows = model?.benchmarks?.design_arena;
  if (!Array.isArray(rows)) return null;
  const match = rows.find(row => row?.arena === 'models' && row?.category === 'codecategories');
  const value = Number(match?.elo);
  return Number.isFinite(value) ? value : null;
}

export function fitLinearRegression(points) {
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length < 2) return null;
  const meanX = valid.reduce((sum, [x]) => sum + x, 0) / valid.length;
  const meanY = valid.reduce((sum, [, y]) => sum + y, 0) / valid.length;
  const denominator = valid.reduce((sum, [x]) => sum + ((x - meanX) ** 2), 0);
  if (denominator === 0) return null;
  const slope = valid.reduce((sum, [x, y]) => sum + ((x - meanX) * (y - meanY)), 0) / denominator;
  return { slope, intercept: meanY - (slope * meanX), sampleSize: valid.length };
}

// ---------------------------------------------------------------------------
// LMArena (Chatbot Arena) text leaderboard: the primary Elo source.
// ---------------------------------------------------------------------------

// Curated overrides for model ids that cannot be matched by token similarity
// (different naming conventions between OpenRouter ids and LMArena names).
// Keys are canonical ids (vendor prefix, no :suffix); values are exact
// LMArena display names as they appear on the leaderboard.
export const LMARENA_NAME_ALIASES = {
  'thinkingmachines/inkling': 'inkling',
  'thinkingmachines/inkling-small': 'Inkling Small',
  'nvidia/nemotron-3.5-lightning': 'nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4',
  'nvidia/nemotron-3-ultra-550b-a55b': 'nvidia-nemotron-3-ultra-550b-a55b-nvfp4',
  'nvidia/nemotron-3-super-120b-a12b': 'nvidia-nemotron-3-super-120b-a12b',
  'z-ai/glm-5.2': 'glm-5.2-max',
  'z-ai/glm-5.3': 'glm-5.3-max',
  'z-ai/glm5': 'glm-5',
  'z-ai/glm4.7': 'glm-4.7',
  'tencent/hy3': 'hy3',
  'deepseek/deepseek-r1-0528': 'deepseek-r1-0528',
  'deepseek-r1-distill-llama-70b': 'deepseek-r1-distill-llama-70b',
  'qwen/qwen3.5-397b-a17b': 'qwen3.5-397b-a17b',
  // :675b suffix is stripped by aliasMatchKey, so key by the base id.
  'mistral-large-3': 'mistral-large-3',
  'mistral-large-3-675b-instruct-2512': 'mistral-large-3',
  'mistralai/mistral-large-3-675b-instruct-2512': 'mistral-large-3',
  'mistralai/mistral-small-3.2-24b-instruct-2506': 'mistral-small-2506',
  'mistral-small-3.2-24b-instruct-2506': 'mistral-small-2506',
};

// Tokens that carry no identifying information in model ids / leaderboard names.
// NOTE: size words (small/medium/large/flash/pro/...) are intentionally kept —
// they distinguish models (mistral-large-3 vs mistral-medium-3).
const LMARENA_STOP_TOKENS = new Set([
  'free', 'latest', 'instruct', 'it', 'chat', 'preview', 'thinking', 'high',
  'max', 'raw', 'nvfp4', 'bf16', 'fp8', 'fp16', 'turbo', 'omni', 'exp', 'v1',
  'versatile', 'instant', 'base', 'reasoning', 'exp',
]);

function lmArenaTokens(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/^[^/:]+\//, '') // vendor/ prefix
    .replace(/:(?!\d+b$)[^:]*$/, '') // :suffix except size-style (:120b)
    .replace(/-free$/i, '')
    .replace(/-(?:latest|instruct|it|chat|preview|thinking|high|max|raw|nvfp4|bf16|fp8|fp16|turbo|versatile|instant|base|reasoning|exp)$/g, '')
    .replace(/-(?:\d{6,8}|\d{2,4})$/g, ''); // trailing dates / serials (20250929, 2506, 0731)
  return cleaned
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter(t => !/^\d{6,8}$/.test(t))  // standalone dates
    .filter(t => !LMARENA_STOP_TOKENS.has(t));
}

// Pure-digit tokens that are real version components (size tokens like 30b,
// a3b or 397b are kept in the token list for specificity but are NOT versions).
function versionTokens(tokens) {
  return tokens.filter(t => /^\d+$/.test(t) && !/^\d{6,8}$/.test(t));
}

/**
 * Tokenized match between a model id and an LMArena display name.
 * Requires every model token (sizes included) to appear in the leaderboard
 * name, and version numbers to agree exactly. Returns a score in [0, 1]
 * (1 = perfect match). 0 means no match.
 */
export function lmArenaMatchScore(modelId, displayName) {
  const a = lmArenaTokens(modelId);
  const b = lmArenaTokens(displayName);
  if (!a.length || !b.length) return 0;
  // Every model token must be present on the board side (subset match).
  if (!a.every(t => b.includes(t))) return 0;
  // Version numbers must agree exactly (e.g. gemini-3 vs gemini-3.7 mismatch).
  const modelVersions = versionTokens(a).sort().join('.');
  const boardVersions = versionTokens(b).sort().join('.');
  if (modelVersions && modelVersions !== boardVersions) return 0;
  return a.length / Math.max(a.length, b.length);
}

function aliasMatchKey(modelId) {
  return String(modelId || '')
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/-free$/i, '');
}

/**
 * Finds the best LMArena board entry for a model id.
 * Returns { displayName, elo, votes, board } or null.
 *
 * When a model has entries on both boards the best name-match wins, and a tie
 * prefers the CODING board: it is the complete leaderboard for the capability
 * this product ranks, whereas the overall page payload only carries the top of
 * that board. Percentile-scoring a model against a truncated overall board
 * floors models near its cutoff (e.g. gpt-oss-120b lands exactly at the bottom
 * of the served top-200 even though it outranks gpt-oss-20b on the coding
 * board), so the coding rating is the reliable cross-model measurement.
 */
export function findLMArenaEntry(modelId, boards) {
  if (!boards || (!boards.coding?.length && !boards.overall?.length)) return null;
  const alias = LMARENA_NAME_ALIASES[aliasMatchKey(modelId)];
  const candidates = (board) => (boards[board] || []).map(e => ({ ...e, board }));
  const bestOn = (board) => {
    let best = null;
    for (const e of candidates(board)) {
      const isAlias = alias && String(e.displayName).toLowerCase() === String(alias).toLowerCase();
      const score = isAlias ? 1 : lmArenaMatchScore(modelId, e.displayName);
      if (score > 0 && (!best || score > best.score || (score === best.score && e.votes > best.votes))) {
        best = { ...e, score };
      }
    }
    return best;
  };
  const coding = bestOn('coding');
  const overall = bestOn('overall');
  if (!coding) return overall;
  if (!overall) return coding;
  // Best name-match wins; ties prefer the coding rating (see doc comment).
  if (coding.score > overall.score) return coding;
  if (overall.score > coding.score) return overall;
  return coding;
}

/**
 * Maps an Elo rating onto the 0-1 score scale as its percentile within the
 * board. Monotonic with the raw Elo, so all consumers that compare intell
 * values (sorting, QoS, minSweScore) preserve the raw Elo ordering. The raw
 * Elo rating itself is what the dashboard displays for these sources.
 */
export function normalizeLMArenaElo(elo, _regression = null, boardEntries) {
  const value = Number(elo);
  if (!Number.isFinite(value)) return null;
  const sorted = (boardEntries || []).map(e => Number(e.elo)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return clamp(value / 1600, 0.02, 0.98);
  let rank = 0;
  for (const v of sorted) if (v <= value) rank += 1;
  const pct = sorted.length > 1 ? (rank - 1) / (sorted.length - 1) : 0.5;
  return 0.05 + (pct * 0.9);
}

/**
 * Inverse of normalizeLMArenaElo: maps a 0-1 score onto the Elo scale as the
 * board rating at that percentile (interpolated between neighbors). This keeps
 * every displayed intelligence value on a single Elo-like scale, even for
 * models whose score is a metadata/offline estimate rather than a real
 * leaderboard rating. Returns null when the board is empty.
 */
export function eloForPercentile(score, boardEntries) {
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  const sorted = (boardEntries || []).map(e => Number(e.elo)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = ((clamp(value, 0.05, 0.95) - 0.05) / 0.9) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, Math.ceil(idx));
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * (idx - lo));
}

/**
 * Scans a Next.js RSC payload string for the leaderboard "entries" array and
 * returns it as an array of { displayName, elo, votes }. Returns [] on failure.
 */
export function extractLMArenaEntries(rscText) {
  const text = String(rscText || '');
  const marker = '"entries":[';
  const idx = text.indexOf(marker);
  if (idx === -1) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let i = idx + marker.length - 1; // start at the '['
  const start = i;
  while (i < text.length && depth >= 0) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    i += 1;
  }
  if (depth !== 0) return [];
  let array;
  try {
    array = JSON.parse(text.slice(start, i));
  } catch {
    return [];
  }
  if (!Array.isArray(array)) return [];
  return array
    .filter(e => e && typeof e.modelDisplayName === 'string' && Number.isFinite(Number(e.rating)))
    .map(e => ({ displayName: e.modelDisplayName, elo: Number(e.rating), votes: Number(e.votes) || 0 }));
}

async function fetchLMArenaBoard(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'text/html' }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`LMArena leaderboard returned HTTP ${response.status}`);
  const html = await response.text();
  // The page is a Next.js shell: the leaderboard data lives in the RSC payloads.
  const pushes = [...String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)];
  let best = [];
  for (const match of pushes) {
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const entries = extractLMArenaEntries(payload);
    if (entries.length > best.length) best = entries;
  }
  if (!best.length) throw new Error('No LMArena leaderboard entries found in page');
  return best;
}

/**
 * Fetches both LMArena text leaderboards (coding + overall), cached 24h.
 * Fails soft: an unreachable/format-changed board yields [] and never breaks
 * the catalog-based scoring path.
 */
export async function fetchLMArenaBoards({ fetchImpl = fetch, nowMs = Date.now(), force = false } = {}) {
  if (!force && cachedLMArena && (nowMs - cachedLMArenaAt) < MODEL_QUALITY_CACHE_MS) return cachedLMArena;
  const [coding, overall] = await Promise.all([
    fetchLMArenaBoard(fetchImpl, LMARENA_BOARD_URLS.coding).catch(err => {
      console.warn('LMArena coding board unavailable:', err?.message || err);
      return [];
    }),
    fetchLMArenaBoard(fetchImpl, LMARENA_BOARD_URLS.overall).catch(err => {
      console.warn('LMArena overall board unavailable:', err?.message || err);
      return [];
    }),
  ]);
  const result = { coding, overall, at: nowMs };
  // Only cache when we actually got data, so a transient failure retries next time.
  if (coding.length || overall.length) {
    cachedLMArena = result;
    cachedLMArenaAt = nowMs;
  }
  return result;
}

function metadataQuality(model, popularityRank, catalogSize, nowMs) {
  const popularity = popularityRank == null || catalogSize < 2
    ? 0.5
    : 1 - ((popularityRank - 1) / (catalogSize - 1));
  const createdMs = Number(model?.created) * 1000;
  const ageDays = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 86_400_000) : 365;
  const recency = clamp(1 - (ageDays / 730));
  const parameters = new Set(Array.isArray(model?.supported_parameters) ? model.supported_parameters : []);
  const features = [
    parameters.has('reasoning') || parameters.has('include_reasoning'),
    parameters.has('tools') || parameters.has('tool_choice'),
    parameters.has('structured_outputs') || parameters.has('response_format'),
  ].filter(Boolean).length / 3;
  const context = Number(model?.context_length);
  const contextScore = Number.isFinite(context) && context > 0
    ? clamp(Math.log2(context / 32768) / 5)
    : 0;
  return clamp(0.35 + (0.15 * popularity) + (0.05 * recency) + (0.05 * features) + (0.05 * contextScore));
}

function modelKeys(model) {
  const ids = [model?.id, model?.canonical_slug, model?.alias_target?.slug];
  return [...new Set(ids.flatMap(qualityLookupKeys))];
}

export function buildOpenRouterQualityIndex(catalog, popularityCatalog = catalog, nowMs = Date.now()) {
  const models = Array.isArray(catalog) ? catalog : [];
  const popular = Array.isArray(popularityCatalog) ? popularityCatalog : [];
  const popularityRanks = new Map();
  popular.forEach((model, index) => {
    for (const key of modelKeys(model)) {
      if (!popularityRanks.has(key)) popularityRanks.set(key, index + 1);
    }
  });

  const regression = fitLinearRegression(models.flatMap(model => {
    const elo = getDesignArenaCodeElo(model);
    const coding = getArtificialAnalysisCodingIndex(model);
    return elo == null || coding == null ? [] : [[elo, coding]];
  }));
  const index = new Map();

  for (const model of models) {
    const keys = modelKeys(model);
    if (keys.length === 0) continue;
    const coding = getArtificialAnalysisCodingIndex(model);
    const elo = getDesignArenaCodeElo(model);
    const rank = keys.map(key => popularityRanks.get(key)).find(value => value != null) ?? null;
    let entry;
    if (coding != null) {
      entry = { score: clamp(coding / 100), source: 'artificial-analysis', isEstimated: false, detail: `coding index ${coding}` };
    } else if (elo != null && regression) {
      const predicted = clamp(regression.intercept + (regression.slope * elo), 20, 90);
      entry = {
        score: predicted / 100,
        source: 'design-arena',
        isEstimated: true,
        // Raw Design Arena Elo: an actual leaderboard rating, shown as-is.
        elo,
        detail: `code Elo ${elo}; regression n=${regression.sampleSize}`,
      };
    } else {
      entry = {
        score: metadataQuality(model, rank, popular.length || models.length, nowMs),
        source: 'metadata',
        isEstimated: true,
        detail: rank == null ? 'capability/recency/context heuristic' : `popularity rank ${rank}/${popular.length}`,
      };
    }
    entry = { ...entry, modelId: model.id };
    for (const key of keys) {
      const current = index.get(key);
      const priority = { 'artificial-analysis': 3, 'design-arena': 2, metadata: 1 };
      if (!current || priority[entry.source] > priority[current.source]) index.set(key, entry);
    }
  }
  return { index, regression, catalogSize: models.length };
}

/**
 * Fits a linear regression mapping Artificial Analysis coding indexes onto the
 * LMArena Elo scale, using as anchor points every catalog model that has both
 * an AA coding index and a matching LMArena leaderboard entry. Returns the
 * regression plus the observed Elo range (used to clamp predictions) or null
 * when fewer than two anchor points exist.
 */
export function fitAAEloRegression(catalog, boards) {
  const models = Array.isArray(catalog) ? catalog : [];
  const points = [];
  for (const model of models) {
    const coding = getArtificialAnalysisCodingIndex(model);
    if (coding == null) continue;
    const match = findLMArenaEntry(model?.id, boards);
    if (match) points.push([coding, Number(match.elo)]);
  }
  const regression = fitLinearRegression(points);
  if (!regression) return null;
  const elos = points.map(([, elo]) => elo);
  return { ...regression, eloMin: Math.min(...elos), eloMax: Math.max(...elos) };
}

/**
 * Attaches an Elo-scale display value to an index/fallback entry.
 * - Design Arena: its raw leaderboard Elo.
 * - Artificial Analysis: the AA index mapped via the AA->Elo anchor regression
 *   (see fitAAEloRegression); falls back to the board percentile scale.
 * - Any remaining estimate (metadata, offline scores): the board Elo at that
 *   score's percentile, so all displayed values stay on one scale.
 * All non-LMArena mappings are flagged eloEstimated so the UI can mark them.
 */
function toEloScale(entry, qualityData, boards) {
  const result = { ...entry };
  const boardList = boards?.overall?.length ? boards.overall : (boards?.coding || []);
  if (entry.source === 'design-arena' && Number.isFinite(entry.elo)) {
    result.elo = entry.elo;
    result.eloEstimated = true;
    return result;
  }
  if (entry.source === 'artificial-analysis') {
    const regression = qualityData?.aaEloRegression;
    if (regression && regression.sampleSize >= 2
        && Number.isFinite(regression.slope) && Number.isFinite(regression.intercept)
        && Number.isFinite(regression.eloMin) && Number.isFinite(regression.eloMax)) {
      const predicted = regression.intercept + (regression.slope * (Number(entry.score) * 100));
      if (Number.isFinite(predicted)) {
        result.elo = clamp(predicted, regression.eloMin, regression.eloMax);
        result.eloEstimated = true;
        return result;
      }
    }
  }
  const mapped = eloForPercentile(entry.score, boardList);
  if (mapped != null) {
    result.elo = mapped;
    result.eloEstimated = true;
  }
  return result;
}

export function resolveModelQuality(qualityData, modelId, localScore = null) {
  // LMArena Elo is the primary source: preference-vote measurements over the
  // heuristic index whenever a match exists.
  const lmarenaBoards = qualityData?.lmArenaBoards;
  if (lmarenaBoards) {
    const match = findLMArenaEntry(modelId, lmarenaBoards);
    if (match) {
      const boardEntries = lmarenaBoards[match.board] || [];
      const label = match.board === 'overall' ? 'overall' : 'coding';
      // Raw Elo is the source of truth for display. The 0-1 score (percentile
      // within the board) is monotonic with Elo, so sorting, QoS and the
      // minSweScore filter all preserve the raw Elo ordering.
      const score = normalizeLMArenaElo(match.elo, null, boardEntries);
      if (score != null) {
        return {
          score,
          elo: match.elo,
          source: match.board === 'overall' ? 'lmarena-overall' : 'lmarena-coding',
          isEstimated: false,
          detail: `LMArena ${label} Elo ${Math.round(match.elo)} (${match.votes} votes)`,
          modelId,
        };
      }
    }
  }
  for (const key of qualityLookupKeys(modelId)) {
    const match = qualityData?.index?.get(key);
    if (match) return toEloScale(match, qualityData, lmarenaBoards);
  }
  const normalized = Number(localScore);
  if (Number.isFinite(normalized) && normalized > 0) {
    const result = { score: normalized > 1 ? normalized / 100 : normalized, source: 'local-fallback', isEstimated: true, detail: 'scores.js offline fallback' };
    const mapped = eloForPercentile(result.score, lmarenaBoards?.overall?.length ? lmarenaBoards.overall : (lmarenaBoards?.coding || []));
    if (mapped != null) {
      result.elo = mapped;
      result.eloEstimated = true;
    }
    return result;
  }
  return { score: null, source: 'default-fallback', isEstimated: true, detail: 'no catalog or local score' };
}

async function fetchCatalog(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error('OpenRouter model catalog returned an invalid payload');
  return payload.data;
}

export async function fetchOpenRouterQualityIndex({ fetchImpl = fetch, nowMs = Date.now(), force = false } = {}) {
  if (!force && cachedQuality && (nowMs - cachedAt) < MODEL_QUALITY_CACHE_MS) return cachedQuality;
  const [catalog, popularity] = await Promise.all([
    fetchCatalog(fetchImpl, OPENROUTER_MODELS_URL),
    fetchCatalog(fetchImpl, `${OPENROUTER_MODELS_URL}?sort=most-popular`),
  ]);
  const lmarena = await fetchLMArenaBoards({ fetchImpl, nowMs, force });
  cachedQuality = buildOpenRouterQualityIndex(catalog, popularity, nowMs);
  cachedQuality.lmArenaBoards = lmarena;
  cachedQuality.aaEloRegression = fitAAEloRegression(catalog, lmarena);
  cachedAt = nowMs;
  return cachedQuality;
}
