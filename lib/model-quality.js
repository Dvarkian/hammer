import { canonicalizeModelId, getScore, resolveAliasedModelId } from '../sources.js';

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

/**
 * One of Artificial Analysis's benchmark indices for a catalog model.
 *
 * Null-safe on purpose: `Number(null)` is 0 and `0 >= 0` is true, so reading a
 * rating through a bare Number() scored a model whose AA block simply had no
 * value for that metric as an actual 0 — the worst model in the app — and also
 * suppressed the Elo/Design Arena fallback that should have covered it. An
 * absent rating has to stay absent.
 *
 * @param {object} model OpenRouter catalog entry
 * @param {'intelligence_index'|'coding_index'|'agentic_index'} metric
 * @returns {number|null}
 */
export function getArtificialAnalysisIndex(model, metric = 'intelligence_index') {
  const value = model?.benchmarks?.artificial_analysis?.[metric];
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  // Grok 4 Fast family leaderboard names (Artificial Analysis slugs), so live
  // quality data lands on the same rows the g4f spellings resolve to.
  'grok-4-fast': 'grok-4-fast',
  'grok-4-fast-non-reasoning': 'grok-4-fast',
  'grok-4.1-fast': 'grok-4-1-fast-reasoning',
  'grok-4.1-fast-non-reasoning': 'grok-4-1-fast',
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
 * Maps a 0-1 score onto the Artificial Analysis index scale as the observed AA
 * value at that percentile (interpolated between neighbours). Used for models
 * whose intelligence is a metadata or offline estimate rather than a measured AA
 * index, so a single AA scale backs the whole dashboard while those rows still
 * sort against the models that were measured. Monotonic, so every consumer that
 * compares intelligence values preserves the score's ordering. Returns null when
 * no AA value is known.
 */
export function aaForPercentile(score, aaValues) {
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  const sorted = (aaValues || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = ((clamp(value, 0.05, 0.95) - 0.05) / 0.9) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, Math.ceil(idx));
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * (idx - lo));
}

/**
 * The inverse of aaForPercentile: where an AA index sits on the catalog's own
 * measured distribution, as the 0-1 quality score the rest of the app compares.
 *
 * Both directions have to stay inverse, because a row's score and its displayed AA
 * index are two views of one number: the score is what QoS percentile-ranks against
 * the curated reference distribution, what the minSweScore filter thresholds, and
 * what every ordering sorts on. Scoring a measured index as `aa / 100` while an
 * estimate was scored on the percentile curve put the measured half of the catalog
 * below the estimates on that scale — the dashboard sorted a 30-point estimate above
 * a 53-point measurement, and QoS preferred the guess, which is why `best` routed to
 * a model with no benchmark data over the best-measured model in the catalog.
 */
export function scoreForAa(aa, aaValues) {
  const value = Number(aa);
  if (!Number.isFinite(value)) return null;
  const sorted = (aaValues || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  // No measured distribution to place the value on: fall back to the raw 0-100
  // reading, which is the same scale, so a caller still gets a usable quality score.
  if (!sorted.length) return clamp(value / 100, 0, 1);
  if (sorted.length === 1) return 0.5;
  let idx = sorted.length - 1;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (value <= hi) {
      idx = lo === hi ? i : i + ((value - lo) / (hi - lo));
      break;
    }
  }
  return clamp(0.05 + ((idx / (sorted.length - 1)) * 0.9), 0.05, 0.95);
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

  const regression = fitEloToAA(models.flatMap(model => {
    const elo = getDesignArenaCodeElo(model);
    const aa = getArtificialAnalysisIndex(model);
    return elo == null || aa == null ? [] : [[elo, aa]];
  }));
  // Every AA rating the catalog knows, so a heuristic or offline score can be
  // placed on the same scale as the models AA actually measured.
  const aaValues = models.map(model => getArtificialAnalysisIndex(model)).filter(value => value != null);
  // How a curated 0-1 score actually reads on the AA scale, for the rows whose only
  // intelligence is a fallback score (see fitAAFromScoreRegression).
  const scoreRegression = fitAAFromScoreRegression(models);
  const index = new Map();

  for (const model of models) {
    const keys = modelKeys(model);
    if (keys.length === 0) continue;
    const aa = getArtificialAnalysisIndex(model);
    const elo = getDesignArenaCodeElo(model);
    const rank = keys.map(key => popularityRanks.get(key)).find(value => value != null) ?? null;
    let entry = null;
    if (aa != null) {
      entry = { score: scoreForAa(aa, aaValues), source: 'artificial-analysis', isEstimated: false, aa, detail: `AA intelligence index ${aa}` };
    } else if (elo != null) {
      // No AA rating: interpolate one from this model's Design Arena Elo.
      const predicted = predictAAFromElo(elo, regression);
      if (predicted != null) {
        entry = {
          score: scoreForAa(predicted, aaValues),
          source: 'design-arena',
          isEstimated: true,
          aa: predicted,
          detail: `Design Arena code Elo ${elo}; AA interpolated (n=${regression.sampleSize})`,
        };
      }
    }
    if (!entry) {
      const score = metadataQuality(model, rank, popular.length || models.length, nowMs);
      const aa = aaForEstimatedScore(score, scoreRegression, aaValues);
      const basis = rank == null ? 'capability/recency/context heuristic' : `popularity rank ${rank}/${popular.length}`;
      entry = {
        score: scoreForEstimatedAa(aa, score, aaValues),
        source: 'metadata',
        isEstimated: true,
        aa,
        detail: `${basis}${aa == null ? '' : scoreRegression ? `; AA calibrated (n=${scoreRegression.sampleSize})` : '; AA by percentile'}`,
      };
    }
    entry = { ...entry, modelId: model.id };
    for (const key of keys) {
      const current = index.get(key);
      const priority = { 'artificial-analysis': 3, 'design-arena': 2, metadata: 1 };
      if (!current || priority[entry.source] > priority[current.source]) index.set(key, entry);
    }
  }
  return { index, regression, aaValues, aaFromScoreRegression: scoreRegression, catalogSize: models.length };
}

/**
 * Linear fit of the Artificial Analysis index against an Elo rating, carrying the
 * observed AA range of the anchor points so a prediction can be clamped to what
 * was actually measured (an Elo outside the fitted band must not invent an index
 * AA never recorded).
 */
function fitEloToAA(points) {
  const valid = (points || []).filter(([elo, aa]) => Number.isFinite(elo) && Number.isFinite(aa));
  const regression = fitLinearRegression(valid);
  if (!regression) return null;
  const aas = valid.map(([, aa]) => aa);
  return { ...regression, aaMin: Math.min(...aas), aaMax: Math.max(...aas) };
}

/**
 * The AA Intelligence Index predicted from an Elo rating, using the regression
 * fitted over the models that carry both (see fitAAFromEloRegression). This is how
 * a model with an Elo rating but no AA score is placed on the AA scale instead of
 * being ranked on Elo. Returns null when there is no usable regression.
 */
export function predictAAFromElo(elo, regression) {
  return predictFromRegression(elo, regression);
}

/**
 * The AA Intelligence Index predicted from a curated 0-1 quality score (scores.js,
 * or the metadata heuristic that shares its scale), using the regression fitted over
 * the models that carry both (see fitAAFromScoreRegression).
 *
 * Placing a fallback score by percentile instead assumed the score was already a
 * position in the AA distribution. It is not: on the 30 live models that carry both,
 * the percentile reading scores r² = -1.2 against AA's own rating — worse than
 * predicting the mean — with a 14-point mean error, while this fit scores r² = 0.37
 * at 7.5 points. That is what put devstral-2-123b (no benchmark data) at 38 above
 * kimi-k2.5, and the same Qwen3 235B at 36 in one row and 26 in another.
 * Returns null when there is no usable regression.
 */
export function predictAAFromScore(score, regression) {
  return predictFromRegression(score, regression);
}

function predictFromRegression(value, regression) {
  const input = Number(value);
  if (!Number.isFinite(input)) return null;
  if (!regression || !(regression.sampleSize >= 2)) return null;
  if (!Number.isFinite(regression.slope) || !Number.isFinite(regression.intercept)) return null;
  const predicted = regression.intercept + (regression.slope * input);
  if (!Number.isFinite(predicted)) return null;
  const min = Number.isFinite(regression.aaMin) ? regression.aaMin : predicted;
  const max = Number.isFinite(regression.aaMax) ? regression.aaMax : predicted;
  return clamp(predicted, Math.min(min, max), Math.max(min, max));
}

/**
 * Restates a slope-line selector written on the old Elo scale in Artificial
 * Analysis index units, using the same AA-from-Elo regression an Elo-only model is
 * scored with.
 *
 * The selector picks whichever row first touches `intelligence + slope × speed`, so
 * restating the intelligence term by the factor it was measured on restates the
 * slope with it and leaves the chosen model unchanged. The floor uses the raw line
 * rather than predictAAFromElo: that function clamps to the AA band the anchors
 * recorded, which would saturate a floor at the top of the catalog and exclude every
 * model instead of translating it.
 *
 * Returns null when there is nothing configured to convert, or no regression to
 * convert with (so an unknown regression retries rather than converting blindly).
 *
 * @param {{slope?: number|null, minSpeed?: number|null, minIntell?: number|null}} selector
 * @param {{slope: number, intercept: number}|null} regression
 */
export function convertSelectorToAaScale(selector, regression) {
  const slope = Number(selector?.slope);
  const minIntell = Number(selector?.minIntell);
  const hasSlope = selector?.slope != null && Number.isFinite(slope);
  const hasFloor = selector?.minIntell != null && Number.isFinite(minIntell);
  if (!hasSlope && !hasFloor) return null;
  if (!regression || !Number.isFinite(regression.slope) || !Number.isFinite(regression.intercept)) return null;
  return {
    slope: hasSlope ? Number((slope * regression.slope).toFixed(2)) : null,
    minSpeed: selector?.minSpeed ?? null,
    minIntell: hasFloor
      ? Number(clamp(regression.intercept + (regression.slope * minIntell), 0, 100).toFixed(1))
      : null,
    intellScale: 'aa',
  };
}

/**
 * Fits AA Intelligence Index against LMArena Elo, using as anchor points every
 * catalog model that has both an AA rating and a matching leaderboard entry.
 * These are the "known cases" an Elo-only model is interpolated from. Returns the
 * regression plus the observed AA range, or null when fewer than two anchors exist.
 */
export function fitAAFromEloRegression(catalog, boards) {
  const models = Array.isArray(catalog) ? catalog : [];
  const points = [];
  for (const model of models) {
    const aa = getArtificialAnalysisIndex(model);
    if (aa == null) continue;
    const match = findLMArenaEntry(model?.id, boards);
    if (match) points.push([Number(match.elo), aa]);
  }
  return fitEloToAA(points);
}

/**
 * The curated 0-1 quality score a catalog entry carries, looked up the same way the
 * rest of the app looks it up: the catalog id first, then its canonical slug and the
 * slug it aliases. Returns null when scores.js has nothing for the model.
 */
export function localScoreForModel(model) {
  for (const id of [model?.id, model?.canonical_slug, model?.alias_target?.slug]) {
    if (!id) continue;
    const score = getScore(id);
    if (score != null && Number.isFinite(Number(score))) return Number(score);
  }
  return null;
}

/**
 * Fits AA Intelligence Index against the curated 0-1 quality score, using as anchors
 * every catalog model that carries both. A fallback-only model is then calibrated
 * from that fit, so its displayed index is read off the relationship the measured
 * models actually show rather than assumed from a percentile it was never on.
 * Returns the regression plus the observed AA range, or null when fewer than two
 * anchors exist.
 */
export function fitAAFromScoreRegression(catalog) {
  const models = Array.isArray(catalog) ? catalog : [];
  const points = [];
  for (const model of models) {
    const aa = getArtificialAnalysisIndex(model);
    if (aa == null) continue;
    const score = localScoreForModel(model);
    if (score == null) continue;
    points.push([score, aa]);
  }
  return fitEloToAA(points);
}

/**
 * The AA index an estimated 0-1 quality score reads as: the calibrated prediction
 * where the catalog supports one, otherwise the percentile placement (still the best
 * reading available of a score whose scale nothing here observes).
 */
function aaForEstimatedScore(score, regression, aaValues) {
  const predicted = predictAAFromScore(score, regression);
  return predicted != null ? predicted : aaForPercentile(score, aaValues);
}

/**
 * The 0-1 score that pairs with an estimated AA index, so a row's score and its
 * displayed index cannot disagree (see scoreForAa).
 */
function scoreForEstimatedAa(aa, rawScore, aaValues) {
  if (aa == null) return rawScore;
  return scoreForAa(aa, aaValues) ?? rawScore;
}

function withAaFlags(entry, modelId) {
  return {
    ...entry,
    aa: Number.isFinite(entry.aa) ? entry.aa : null,
    aaEstimated: entry.isEstimated === true,
    modelId,
  };
}

/**
 * Resolves the intelligence score for a model.
 *
 * The Artificial Analysis Intelligence Index is the metric Hammer ranks, routes
 * and displays on. A model AA actually measured uses that rating. Where AA has no
 * rating but an Elo exists (LMArena's leaderboard, or Design Arena's), the AA index
 * is interpolated from that Elo with the regression fitted over the models carrying
 * both, and flagged as an estimate. A metadata or offline estimate is calibrated
 * onto that same scale with the regression fitted over the models carrying both an AA
 * rating and a curated score (see predictAAFromScore), so every row shows one
 * comparable number.
 *
 * `aa` is that displayed number and `score` is the same number read back as a 0-1
 * quality position (see scoreForAa), so the two can never disagree about which row
 * is smarter. An estimate the catalog cannot calibrate keeps its own 0-1 score and
 * takes its `aa` from it by percentile, which is that same curve read in the other
 * direction.
 */
export function resolveModelQuality(qualityData, modelId, localScore = null) {
  const indexEntry = qualityLookupKeys(modelId)
    .map(key => qualityData?.index?.get(key))
    .find(Boolean) || null;
  // A measured AA rating beats anything interpolated from an Elo.
  if (indexEntry && indexEntry.source === 'artificial-analysis') {
    return withAaFlags(indexEntry, modelId);
  }
  const lmarenaBoards = qualityData?.lmArenaBoards;
  if (lmarenaBoards) {
    const match = findLMArenaEntry(modelId, lmarenaBoards);
    if (match) {
      const regression = qualityData?.aaFromEloRegression;
      const aa = predictAAFromElo(match.elo, regression);
      if (aa != null) {
        const label = match.board === 'overall' ? 'overall' : 'coding';
        return {
          score: scoreForAa(aa, qualityData?.aaValues),
          aa,
          aaEstimated: true,
          source: match.board === 'overall' ? 'lmarena-overall' : 'lmarena-coding',
          isEstimated: true,
          detail: `LMArena ${label} Elo ${Math.round(match.elo)} (${match.votes} votes); AA interpolated (n=${regression.sampleSize})`,
          modelId,
        };
      }
    }
  }
  if (indexEntry) return withAaFlags(indexEntry, modelId);
  const normalized = Number(localScore);
  if (Number.isFinite(normalized) && normalized > 0) {
    const raw = normalized > 1 ? normalized / 100 : normalized;
    const regression = qualityData?.aaFromScoreRegression;
    const aa = aaForEstimatedScore(raw, regression, qualityData?.aaValues);
    return {
      score: scoreForEstimatedAa(aa, raw, qualityData?.aaValues),
      aa,
      aaEstimated: true,
      source: 'local-fallback',
      isEstimated: true,
      detail: `scores.js offline fallback${aa == null ? '' : regression ? `; AA calibrated (n=${regression.sampleSize})` : '; AA by percentile'}`,
      modelId,
    };
  }
  return { score: null, aa: null, aaEstimated: true, source: 'default-fallback', isEstimated: true, detail: 'no catalog or local score', modelId };
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
  cachedQuality.aaFromEloRegression = fitAAFromEloRegression(catalog, lmarena);
  cachedAt = nowMs;
  return cachedQuality;
}
