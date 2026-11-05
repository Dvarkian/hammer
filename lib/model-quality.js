/**
 * @file lib/model-quality.js
 * @description Intelligence scoring with benchmarklist as the production source.
 *
 * ## The scale
 *
 * Production scores come exclusively from benchmarklist benchmark results, projected onto
 * the AA Intelligence Index scale using models rated by AA as calibration anchors. AA
 * ratings and other providers' data are not used as a model's production score.
 *
 * ## Why isotonic and not a straight line
 *
 * The evidence is monotone but not linear: an Elo difference at the top of a leaderboard
 * is worth far fewer index points than the same difference at the bottom. A least-squares
 * line through the anchors therefore distorts both ends, and when the anchors are few it
 * can even come out inverted (higher Elo → lower intelligence), which reorders the whole
 * table backwards. So every calibration here is an isotonic fit (pool-adjacent-violators):
 * a non-decreasing step curve through the anchors, interpolated between them. Being
 * monotone by construction it cannot invert, and measured against held-out anchors it is
 * more accurate than the line it replaces:
 *
 *   evidence        anchors   linear MAE   isotonic MAE
 *   AA coding index      32         7.32           3.75
 *   AA agentic index     31         5.84           4.40
 *   Design Arena Elo     38         7.82           6.99
 *
 * Several benchmarklist measurements for one model are averaged in inverse proportion to
 * each calibration's held-out error. Models without in-range benchmarklist evidence remain
 * unscored rather than receiving a fallback from another provider.
 */

import { canonicalizeModelId, resolveAliasedModelId } from '../sources.js'
import { fetchJsonWithRetry } from './providers/discovery.js'
import {
  fetchBenchmarkListQualityIndex,
  resolveBenchmarkListQuality,
} from './benchmarklist-quality.js'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const LMARENA_BOARD_URLS = {
  coding: 'https://lmarena.ai/leaderboard/text/coding',
  overall: 'https://lmarena.ai/leaderboard',
}
// The live pages are large Next.js shells. LMArena's official dataset exposes the same
// current leaderboards as small, stable JSON and is the normal path; the HTML URLs above
// remain a compatibility fallback for a deployment where the dataset service is blocked.
//
// The text leaderboard is one dataset config (`text`) whose rows are tagged by category,
// and its top-level `coding` and `overall` categories are the two boards this file needs.
// Reading the config directly returns every category interleaved; reading it through the
// filter endpoint returns one board at a time, which is both smaller and unambiguous.
// (`webdev` and `text_style_control`, used earlier, are the web-app and style-control
// boards — neither is the text coding rating, and together they named far fewer models.)
const lmarenaBoardUrl = (category) =>
  'https://datasets-server.huggingface.co/filter?dataset=lmarena-ai%2Fleaderboard-dataset' +
  `&config=text&split=latest&where=${encodeURIComponent(`"category"='${category}'`)}` +
  '&offset=0&length=100'

export const LMARENA_DATASET_URLS = {
  coding: lmarenaBoardUrl('coding'),
  overall: lmarenaBoardUrl('overall'),
}
export const MODEL_QUALITY_CACHE_MS = 24 * 60 * 60_000

// The dataset server caps a page at 100 rows. One page is the top of the board only, which
// is exactly where the big models live; walking a few pages is what puts smaller and older
// models on the scale at all.
const LMARENA_PAGE_SIZE = 100
// Both text boards are ~420 rows today, so five pages reads each one whole. The walk stops
// early on a short page, so a board that shrinks costs fewer requests, not stale rows.
const LMARENA_MAX_PAGES = 5
// A curve through fewer anchors than this is not a calibration, it is a coincidence.
const MIN_CALIBRATION_ANCHORS = 8
// Held-out error assumed for a calibration too small to measure its own (see weightOf).
const DEFAULT_CALIBRATION_MAE = 10

const AA_METRICS = {
  intelligence: 'intelligence_index',
  coding: 'coding_index',
  agentic: 'agentic_index',
}

let cachedQuality = null
let cachedAt = 0
let cachedLMArena = null
let cachedLMArenaAt = 0

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Model ids: matching a provider's spelling to the catalog's.
// ---------------------------------------------------------------------------

// The suffixes a provider adds to name *how* it serves a model rather than which one: the
// quantization it was converted to, the adapter stacked on it, or a latency tier. The
// benchmarks are published for the bare weights, so `-fp8`/`-lora`/`-fp8-fast` have to come
// off before the name can match. Longest first, so `llama-3.3-70b-instruct-fp8-fast` loses both.
const SERVING_SUFFIX_RE =
  /-(?:lora-fast|fp8-fast|fp16-fast|int4-fast|q4-fast|fp8|fp16|bf16|int8|int4|q4|q8|lora|fast|hf|dynamic)$/i

/** @returns {string} the same id with any quantization/adapter/tier suffix removed. */
export function dequantizedModelId(modelId) {
  return String(modelId || '').replace(SERVING_SUFFIX_RE, '')
}

// A token that names how much of a model there is (30b, 120b, 1t) or how much of it runs
// per token (a3b, a12b, e4b) — never which model it is. Only ever stripped from the END of
// an id, so `gemma-3-4b-it` keeps every token it has and only a spelling that trails its
// size can be related to a shorter one.
const SIZE_OR_PARAM_TOKEN_RE = /^(?:\d+(?:\.\d+)?[bt]|[a-z]\d*b)$/

/**
 * The shorter spellings a parameterised id could be published under, longest first.
 *
 * `nvidia/nemotron-3.5-lightning-30b-a3b` yields `…-30b` and `nvidia/nemotron-3.5-lightning`:
 * providers serve a vendor's id with its size and active-parameter counts appended, while
 * the catalog publishes the bare one. Returns [] when the id does not trail its size, so
 * nothing else can ever be related to something shorter.
 */
export function parameterlessModelIds(modelId) {
  const raw = String(modelId || '')
    .trim()
    .toLowerCase()
  if (!raw) return []
  const segments = raw.split('/')
  const vendor = segments.length > 1 ? segments[0] : ''
  const tokens = segments[segments.length - 1].split('-').filter(Boolean)
  const spellings = []
  for (let end = tokens.length - 1; end > 0; end -= 1) {
    if (!SIZE_OR_PARAM_TOKEN_RE.test(tokens[end])) break
    const shorter = tokens.slice(0, end).join('-')
    spellings.push(vendor ? `${vendor}/${shorter}` : shorter)
  }
  return spellings
}

/**
 * Every id spelling a row may be listed under in the catalog: the exact id, the
 * namespace-stripped and bare-leaf forms, the colon-to-dash form, and the same names with
 * a serving suffix removed. Ordered, so an exact match is always found first.
 */
export function qualityLookupKeys(modelId) {
  const resolved = resolveAliasedModelId(
    String(modelId || '')
      .trim()
      .toLowerCase(),
  )
  if (!resolved) return []
  const { base, unprefixed, unscoped } = canonicalizeModelId(resolved)
  // Provider catalogs spell ids with spaces (`GPT OSS 20B`) or underscores where the
  // benchmark catalog uses dashes (`openai/gpt-oss-20b`). Without this the row matched
  // nothing at all and was left unscored even though the catalog had measured it.
  const strip = (value) =>
    value
      .replace(/^~/, '')
      .replace(/-free$/i, '')
      .replace(/[\s_]+/g, '-')
  const keys = []
  for (const raw of [base, unscoped, unprefixed]) {
    if (!raw) continue
    const normalized = strip(raw)
    keys.push(normalized, normalized.replace(/:/g, '-'), dequantizedModelId(normalized))
  }
  return [...new Set(keys.filter(Boolean))]
}

// ---------------------------------------------------------------------------
// Reading the fetched catalog.
// ---------------------------------------------------------------------------

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * One of AA's benchmark indices for a catalog model. Null-safe on purpose: `Number(null)`
 * is 0, so reading an absent rating through a bare Number() would score it as the worst
 * model in the app instead of leaving it absent.
 *
 * @param {object} model OpenRouter catalog entry
 * @param {'intelligence'|'coding'|'agentic'} metric
 * @returns {number|null}
 */
export function getArtificialAnalysisIndex(model, metric = 'intelligence') {
  const field = AA_METRICS[metric] || AA_METRICS.intelligence
  return finiteOrNull(model?.benchmarks?.artificial_analysis?.[field])
}

export function getDesignArenaCodeElo(model) {
  const rows = model?.benchmarks?.design_arena
  if (!Array.isArray(rows)) return null
  const match = rows.find((row) => row?.arena === 'models' && row?.category === 'codecategories')
  return finiteOrNull(match?.elo)
}

export function fitLinearRegression(points) {
  const valid = (points || []).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (valid.length < 2) return null
  const meanX = valid.reduce((sum, [x]) => sum + x, 0) / valid.length
  const meanY = valid.reduce((sum, [, y]) => sum + y, 0) / valid.length
  const denominator = valid.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0)
  if (denominator === 0) return null
  const slope = valid.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / denominator
  return { slope, intercept: meanY - slope * meanX, sampleSize: valid.length }
}

// ---------------------------------------------------------------------------
// The calibrations.
// ---------------------------------------------------------------------------

/**
 * Isotonic regression (pool adjacent violators) of y on x.
 *
 * The anchors are sorted by x and then merged, left to right, whenever the running mean
 * would decrease; each surviving block contributes one knot at the mean of its x values.
 * The result is a non-decreasing curve through the evidence, which is the property that
 * matters here: an intelligence index must not fall as the underlying measurement rises,
 * whatever noise the anchors carry. Returns null when there are too few anchors to call it
 * a calibration, or when the anchors show no relationship at all.
 *
 * @param {Array<[number, number]>} points [measurement, AA intelligence]
 * @returns {{xs: number[], ys: number[], n: number}|null}
 */
export function fitMonotone(points) {
  const valid = (points || [])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0])
  if (valid.length < MIN_CALIBRATION_ANCHORS) return null
  const stacked = []
  for (const [x, y] of valid) {
    stacked.push({ sumX: x, sumY: y, n: 1, mean: y })
    while (
      stacked.length > 1 &&
      stacked[stacked.length - 2].mean > stacked[stacked.length - 1].mean
    ) {
      const upper = stacked.pop()
      const lower = stacked.pop()
      const sumY = lower.sumY + upper.sumY
      const n = lower.n + upper.n
      stacked.push({ sumX: lower.sumX + upper.sumX, sumY, n, mean: sumY / n })
    }
  }
  const xs = stacked.map((block) => block.sumX / block.n)
  const ys = stacked.map((block) => block.mean)
  if (!(Math.max(...ys) - Math.min(...ys) > 0)) return null
  return { xs, ys, n: valid.length }
}

/**
 * The AA intelligence a measurement reads as, by linear interpolation between the fitted
 * knots, and only there.
 *
 * Outside the anchors there is no prediction. Holding the curve flat past its ends used to
 * look harmless, but on a real board it is not: LMArena's 2026 leaderboard sits far above
 * every 2024-era model, so gemma-2b, mixtral-8x22b and nemotron-4-340b all landed on the
 * same bottom knot and were served an identical 4.3. A tie at the floor is a made-up
 * number, and it is the failure this file exists to avoid, so an out-of-range measurement
 * yields nothing at all and the row stays `unscored`.
 */
export function predictMonotone(value, calibration) {
  // An absent measurement is absent, not zero: `Number(null)` is 0, which would read as
  // the lowest value on the curve and hand every partially-covered model a floor-level
  // "estimate" — measured at MAE 17 that way, against 3.75 with the guard.
  if (value == null || value === '') return null
  const x = Number(value)
  if (!Number.isFinite(x) || !calibration?.xs?.length) return null
  const { xs, ys } = calibration
  const n = xs.length
  if (n === 1) return clamp(ys[0], 0, 100)
  // Past the outermost knots there is no prediction. Both alternatives were measured on the
  // catalog's own rated models and both are worse than saying nothing: holding the curve
  // flat gave gemma-3-12b and three 2024-era models one identical 4.3, and continuing the
  // local slope gave gemma-3-12b a 2.2 while raising held-out MAE from 4.26 to 5.10. An
  // out-of-range measurement is one we cannot place, so the row stays `unscored`.
  if (x < xs[0] || x > xs[n - 1]) return null
  if (x === xs[0]) return clamp(ys[0], 0, 100)
  if (x === xs[n - 1]) return clamp(ys[n - 1], 0, 100)
  let low = 0
  let high = xs.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (xs[mid] <= x) low = mid
    else high = mid
  }
  const span = xs[high] - xs[low]
  const weight = span === 0 ? 0 : (x - xs[low]) / span
  return clamp(ys[low] + (ys[high] - ys[low]) * weight, 0, 100)
}

/**
 * How far this calibration misses held-out anchors, measured by refitting without each
 * anchor in turn. Used only to weight one prediction against another, so a calibration
 * that cannot be measured keeps a conservative default instead of an opinion.
 */
function heldOutError(points) {
  if (points.length < MIN_CALIBRATION_ANCHORS + 2) return null
  const errors = []
  for (let i = 0; i < points.length; i += 1) {
    const fit = fitMonotone(points.filter((_, index) => index !== i))
    const predicted = predictMonotone(points[i][0], fit)
    if (predicted != null) errors.push(Math.abs(predicted - points[i][1]))
  }
  if (!errors.length) return null
  return errors.reduce((sum, error) => sum + error, 0) / errors.length
}

/**
 * A fitted evidence source, ready to predict with.
 *
 * `weight` is inverse squared held-out error: a source that misses by four index points
 * contributes four times as much as one that misses by eight (see combinePredictions).
 */
function makeCalibration(source, points) {
  const fit = fitMonotone(points)
  if (!fit) return null
  const mae = heldOutError(points)
  const weight = 1 / ((mae ?? DEFAULT_CALIBRATION_MAE) + 1) ** 2
  return { ...fit, source, mae, weight }
} /**
 * The intelligence a row's predictions agree on.
 *
 * A weighted mean in inverse-error proportion. Every input is a calibration whose error
 * has been measured on held-out rated models, so the mean is weighted by how much each
 * one has earned — and measured against taking the single most accurate source per row,
 * the blend is better (5.46 held-out MAE against 6.00 over the same 52 rows). The source
 * reported for the row's badge is the strongest contributor, unless more than one was
 * used, in which case the row is a combined estimate.
 *
 * @param {Array<{value: number, weight: number, source: string}>} predictions
 */
export function combinePredictions(predictions) {
  const valid = (predictions || []).filter(
    (prediction) =>
      Number.isFinite(prediction?.value) &&
      Number.isFinite(prediction?.weight) &&
      prediction.weight > 0,
  )
  if (!valid.length) return null
  const total = valid.reduce((sum, prediction) => sum + prediction.weight, 0)
  const value =
    valid.reduce((sum, prediction) => sum + prediction.value * prediction.weight, 0) / total
  const strongest = valid.reduce((best, prediction) =>
    prediction.weight > best.weight ? prediction : best,
  )
  return {
    value: clamp(value, 0, 100),
    source: valid.length > 1 ? 'combined-estimate' : strongest.source,
    contributions: valid,
  }
}

// ---------------------------------------------------------------------------
// LMArena: the text leaderboards, used as Elo evidence.
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
}

// Tokens that carry no identifying information in model ids / leaderboard names.
// NOTE: size words (small/medium/large/flash/pro/...) are intentionally kept —
// they distinguish models (mistral-large-3 vs mistral-medium-3).
const LMARENA_STOP_TOKENS = new Set([
  'free',
  'latest',
  'instruct',
  'it',
  'chat',
  'preview',
  'thinking',
  'high',
  'max',
  'raw',
  'nvfp4',
  'bf16',
  'fp8',
  'fp16',
  'turbo',
  'omni',
  'exp',
  'v1',
  'versatile',
  'instant',
  'base',
  'reasoning',
])

function lmArenaTokens(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/^[^/:]+\//, '') // vendor/ prefix
    .replace(/:(?!\d+b$)[^:]*$/, '') // :suffix except size-style (:120b)
    .replace(/-free$/i, '')
    .replace(
      /-(?:latest|instruct|it|chat|preview|thinking|high|max|raw|nvfp4|bf16|fp8|fp16|turbo|versatile|instant|base|reasoning|exp)$/g,
      '',
    )
    .replace(/-(\d{6,8}|\d{2,4})$/g, '') // trailing dates / serials (20250929, 2506, 0731)
  return cleaned
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !/^\d{6,8}$/.test(token)) // standalone dates
    .filter((token) => !LMARENA_STOP_TOKENS.has(token))
}

// Pure-digit tokens that are real version components (size tokens like 30b,
// a3b or 397b are kept in the token list for specificity but are NOT versions).
function versionTokens(tokens) {
  return tokens.filter((token) => /^\d+$/.test(token) && !/^\d{6,8}$/.test(token))
}

/**
 * Tokenized match between a model id and an LMArena display name.
 * Requires every model token (sizes included) to appear in the leaderboard
 * name, and version numbers to agree exactly. Returns a score in [0, 1]
 * (1 = perfect match). 0 means no match.
 */
export function lmArenaMatchScore(modelId, displayName) {
  const a = lmArenaTokens(modelId)
  const b = lmArenaTokens(displayName)
  if (!a.length || !b.length) return 0
  // Every model token must be present on the board side (subset match).
  if (!a.every((token) => b.includes(token))) return 0
  // Version numbers must agree exactly (e.g. gemini-3 vs gemini-3.7 mismatch).
  const modelVersions = versionTokens(a).sort().join('.')
  const boardVersions = versionTokens(b).sort().join('.')
  if (modelVersions && modelVersions !== boardVersions) return 0
  return a.length / Math.max(a.length, b.length)
}

function aliasMatchKey(modelId) {
  return String(modelId || '')
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/-free$/i, '')
}

/**
 * Finds the best LMArena board entry for a model id.
 * Returns { displayName, elo, votes, board, score } or null.
 *
 * When a model has entries on both boards the best name-match wins, and a tie
 * prefers the CODING board: it is the complete leaderboard for the capability
 * this product ranks, whereas the overall page payload only carries the top of
 * that board.
 */
export function findLMArenaEntry(modelId, boards) {
  if (!boards || (!boards.coding?.length && !boards.overall?.length)) return null
  const alias = LMARENA_NAME_ALIASES[aliasMatchKey(modelId)]
  const candidates = (board) => (boards[board] || []).map((entry) => ({ ...entry, board }))
  const bestOn = (board) => {
    let best = null
    for (const entry of candidates(board)) {
      const isAlias =
        alias && String(entry.displayName).toLowerCase() === String(alias).toLowerCase()
      const score = isAlias ? 1 : lmArenaMatchScore(modelId, entry.displayName)
      if (
        score > 0 &&
        (!best || score > best.score || (score === best.score && entry.votes > best.votes))
      ) {
        best = { ...entry, score }
      }
    }
    return best
  }
  const coding = bestOn('coding')
  const overall = bestOn('overall')
  if (!coding) return overall
  if (!overall) return coding
  // Best name-match wins; ties prefer the coding rating (see doc comment).
  if (coding.score > overall.score) return coding
  if (overall.score > coding.score) return overall
  return coding
}

/**
 * Scans a Next.js RSC payload string for the leaderboard "entries" array and
 * returns it as an array of { displayName, elo, votes }. Returns [] on failure.
 */
export function extractLMArenaEntries(rscText) {
  const text = String(rscText || '')
  const marker = '"entries":['
  const idx = text.indexOf(marker)
  if (idx === -1) return []
  let depth = 0
  let inString = false
  let escaped = false
  let i = idx + marker.length - 1 // start at the '['
  const start = i
  while (i < text.length && depth >= 0) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      depth += 1
    } else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
    i += 1
  }
  if (depth !== 0) return []
  let array
  try {
    array = JSON.parse(text.slice(start, i))
  } catch {
    return []
  }
  if (!Array.isArray(array)) return []
  return array
    .filter(
      (entry) =>
        entry &&
        typeof entry.modelDisplayName === 'string' &&
        Number.isFinite(Number(entry.rating)),
    )
    .map((entry) => ({
      displayName: entry.modelDisplayName,
      elo: Number(entry.rating),
      votes: Number(entry.votes) || 0,
    }))
}

function datasetPageUrl(base, offset) {
  return String(base)
    .replace(/offset=\d+/, `offset=${offset}`)
    .replace(/length=\d+/, `length=${LMARENA_PAGE_SIZE}`)
}

async function fetchLMArenaHtmlBoard(fetchImpl, url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'hammer/1.24 (+https://github.com/hammer-app/hammer)',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`LMArena leaderboard returned HTTP ${response.status}`)
  const html = await response.text()
  // The page is a Next.js shell: the leaderboard data lives in the RSC payloads.
  const pushes = [...String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
  let best = []
  for (const match of pushes) {
    let payload
    try {
      payload = JSON.parse(match[1])
    } catch {
      continue
    }
    const entries = extractLMArenaEntries(payload)
    if (entries.length > best.length) best = entries
  }
  if (!best.length) throw new Error('No LMArena leaderboard entries found in page')
  return best
}

async function fetchLMArenaDatasetBoard(fetchImpl, baseUrl) {
  const entries = []
  const seen = new Set()
  for (let page = 0; page < LMARENA_MAX_PAGES; page += 1) {
    // A 100-row window of the filtered board is a few hundred KB and the dataset server
    // regularly takes 10–20s to assemble it, so a 10s budget read as "board unavailable"
    // and silently dropped LMArena out of every score on a slow day.
    const payload = await fetchJsonWithRetry(datasetPageUrl(baseUrl, page * LMARENA_PAGE_SIZE), {
      fetchImpl,
      headers: { Accept: 'application/json' },
      timeoutMs: 30_000,
    })
    const rows = Array.isArray(payload?.rows) ? payload.rows : []
    for (const item of rows) {
      const row = item?.row
      if (!row || typeof row.model_name !== 'string') continue
      const elo = Number(row.rating)
      if (!Number.isFinite(elo)) continue
      const displayName = row.model_name
      if (seen.has(displayName)) continue
      seen.add(displayName)
      entries.push({ displayName, elo, votes: Number(row.vote_count) || 0 })
    }
    if (rows.length < LMARENA_PAGE_SIZE) break
  }
  if (!entries.length) throw new Error('LMArena dataset returned no usable leaderboard rows')
  return entries
}

async function fetchLMArenaBoard(fetchImpl, { datasetUrl, htmlUrl }) {
  try {
    return await fetchLMArenaDatasetBoard(fetchImpl, datasetUrl)
  } catch (datasetError) {
    try {
      return await fetchLMArenaHtmlBoard(fetchImpl, htmlUrl)
    } catch (htmlError) {
      const datasetMessage = datasetError?.message || datasetError
      const htmlMessage = htmlError?.message || htmlError
      throw new Error(`LMArena dataset: ${datasetMessage}; page: ${htmlMessage}`, {
        cause: htmlError,
      })
    }
  }
}

/**
 * Fetches both LMArena text leaderboards (coding + overall), cached 24h.
 * Fails soft: an unreachable board yields [] and never breaks catalog scoring.
 */
export async function fetchLMArenaBoards({
  fetchImpl = fetch,
  nowMs = Date.now(),
  force = false,
} = {}) {
  if (!force && cachedLMArena && nowMs - cachedLMArenaAt < MODEL_QUALITY_CACHE_MS)
    return cachedLMArena
  const [coding, overall] = await Promise.all([
    fetchLMArenaBoard(fetchImpl, {
      datasetUrl: LMARENA_DATASET_URLS.coding,
      htmlUrl: LMARENA_BOARD_URLS.coding,
    }).catch((err) => {
      console.warn('LMArena coding board unavailable:', err?.message || err)
      return []
    }),
    fetchLMArenaBoard(fetchImpl, {
      datasetUrl: LMARENA_DATASET_URLS.overall,
      htmlUrl: LMARENA_BOARD_URLS.overall,
    }).catch((err) => {
      console.warn('LMArena overall board unavailable:', err?.message || err)
      return []
    }),
  ])
  const result = { coding, overall, at: nowMs }
  // Only cache when we actually got data, so a transient failure retries next time.
  if (coding.length || overall.length) {
    cachedLMArena = result
    cachedLMArenaAt = nowMs
  }
  return result
}

// ---------------------------------------------------------------------------
// Building the index.
// ---------------------------------------------------------------------------

/**
 * Maps an AA index onto the routing/QoS 0–1 scale as the position it occupies among the
 * intelligence values the catalog actually measured. Two rows compared through this number
 * are compared on the same curve as the numbers the dashboard prints.
 */
export function scoreForAa(aa, aaValues) {
  const value = Number(aa)
  if (!Number.isFinite(value)) return null
  const sorted = (aaValues || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (!sorted.length) return clamp(value / 100, 0, 1)
  if (sorted.length === 1) return 0.5
  let idx = sorted.length - 1
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lo = sorted[i]
    const hi = sorted[i + 1]
    if (value <= hi) {
      idx = lo === hi ? i : i + (value - lo) / (hi - lo)
      break
    }
  }
  return clamp(0.05 + (idx / (sorted.length - 1)) * 0.9, 0.05, 0.95)
}

function modelKeys(model) {
  const ids = [model?.id, model?.canonical_slug, model?.alias_target?.slug]
  return [...new Set(ids.flatMap(qualityLookupKeys))]
}

/**
 * Builds the catalog side of the index: the measured ratings, the raw measurements each
 * model carries, and the calibrations that turn those measurements into intelligence.
 *
 * Entries are either `{ kind: 'measured', aa }` — AA rated this model — or
 * `{ kind: 'evidence', raw }`, carrying the measurements that need a calibration. The
 * decision is made at lookup time, so a model that has both is always read as measured.
 *
 * @param {Array<object>} catalog OpenRouter catalog entries
 */
export function buildOpenRouterQualityIndex(catalog) {
  const models = Array.isArray(catalog) ? catalog : []
  const measuredPairs = { coding: [], agentic: [], designArena: [] }
  const aaValues = []
  const index = new Map()

  for (const model of models) {
    const aa = getArtificialAnalysisIndex(model)
    const coding = getArtificialAnalysisIndex(model, 'coding')
    const agentic = getArtificialAnalysisIndex(model, 'agentic')
    const designArena = getDesignArenaCodeElo(model)
    if (aa != null) {
      aaValues.push(aa)
      if (coding != null) measuredPairs.coding.push([coding, aa])
      if (agentic != null) measuredPairs.agentic.push([agentic, aa])
      if (designArena != null) measuredPairs.designArena.push([designArena, aa])
    }
    const keys = modelKeys(model)
    if (!keys.length) continue
    const entry =
      aa != null
        ? { kind: 'measured', aa, modelId: model.id }
        : { kind: 'evidence', raw: { coding, agentic, designArena }, modelId: model.id }
    if (entry.kind === 'evidence' && !Object.values(entry.raw).some((value) => value != null))
      continue
    for (const key of keys) {
      const current = index.get(key)
      if (!current || (current.kind === 'evidence' && entry.kind === 'measured'))
        index.set(key, entry)
    }
  }

  const calibrations = {
    coding: makeCalibration('coding-index', measuredPairs.coding),
    agentic: makeCalibration('agentic-index', measuredPairs.agentic),
    designArena: makeCalibration('design-arena', measuredPairs.designArena),
  }

  return {
    index,
    aaValues,
    calibrations,
    models,
    lmArenaBoards: { coding: [], overall: [] },
    aaFromEloRegression: null,
    regression: null,
    catalogSize: models.length,
    benchmarklist: null,
  }
}

/**
 * Adds the LMArena leaderboards to a built index: fits a calibration per board over the
 * catalog models AA measured, and keeps the boards for lookups. Called by the fetcher (and
 * by tests) rather than by buildOpenRouterQualityIndex, so a build never silently depends
 * on network data.
 */
export function attachLMArenaBoards(quality, boards) {
  const safeBoards = { coding: boards?.coding || [], overall: boards?.overall || [] }
  quality.lmArenaBoards = safeBoards
  const pairs = { coding: [], overall: [] }
  for (const model of quality.models || []) {
    const aa = getArtificialAnalysisIndex(model)
    if (aa == null) continue
    const match = findLMArenaEntry(model.id, safeBoards)
    if (!match) continue
    pairs[match.board === 'overall' ? 'overall' : 'coding'].push([match.elo, aa])
  }
  quality.calibrations.lmarenaCoding = makeCalibration('lmarena-coding', pairs.coding)
  quality.calibrations.lmarenaOverall = makeCalibration('lmarena-overall', pairs.overall)
  // The slope-line selector was written on an Elo scale and still needs a linear reading
  // of the same relationship to be migrated (see convertSelectorToAaScale).
  const regressionPoints =
    pairs.coding.length >= pairs.overall.length ? pairs.coding : pairs.overall
  quality.aaFromEloRegression = fitLinearRegression(regressionPoints)
  quality.regression = quality.aaFromEloRegression
  return quality
}

/**
 * Attach the benchmarklist quality index to a built quality index.
 * Called by the fetcher (and by tests) rather than by buildOpenRouterQualityIndex,
 * so a build never silently depends on network data.
 */
export async function attachBenchmarkList(
  quality,
  { fetchImpl = fetch, force = false, modelIds = [] } = {},
) {
  try {
    quality.benchmarklist = await fetchBenchmarkListQualityIndex(quality.models, {
      fetchImpl,
      force,
      modelIds,
    })
  } catch (err) {
    console.warn('[benchmarklist] quality index unavailable:', err?.message || err)
    quality.benchmarklist = null
  }
  return quality
}

// ---------------------------------------------------------------------------
// Resolving a row.
// ---------------------------------------------------------------------------

function findEntry(qualityData, modelId) {
  const index = qualityData?.index
  if (!index) return null
  const own = qualityLookupKeys(modelId)
    .map((key) => index.get(key))
    .filter(Boolean)
  const measured = own.find((entry) => entry.kind === 'measured')
  if (measured) return measured
  if (own.length) return own[0]
  const siblings = parameterlessModelIds(modelId)
    .map((key) => index.get(key))
    .filter(Boolean)
  return siblings.find((entry) => entry.kind === 'measured') || siblings[0] || null
}

function rowResult({ aa, source, detail, modelId, qualityData, estimated }) {
  return {
    score: scoreForAa(aa, qualityData?.aaValues) ?? 0,
    aa,
    aaEstimated: estimated,
    source,
    isEstimated: estimated,
    detail,
    modelId,
  }
}

/**
 * Every prediction the fetched evidence supports for a row, each tagged with the source it
 * came from and the weight that source has earned (see makeCalibration).
 */
function gatherPredictions(qualityData, modelId, entry) {
  const predictions = []
  const calibrations = qualityData?.calibrations || {}
  const raw = entry?.kind === 'evidence' ? entry.raw : null
  const sources = [
    ['coding', 'coding-index'],
    ['agentic', 'agentic-index'],
    ['designArena', 'design-arena'],
  ]
  for (const [key, label] of sources) {
    const value = predictMonotone(raw?.[key], calibrations[key])
    if (value != null) predictions.push({ value, weight: calibrations[key].weight, source: label })
  }
  const boards = qualityData?.lmArenaBoards
  if (boards) {
    const match = findLMArenaEntry(modelId, boards)
    if (match) {
      const calibration =
        match.board === 'overall' ? calibrations.lmarenaOverall : calibrations.lmarenaCoding
      const value = predictMonotone(match.elo, calibration)
      if (value != null) {
        // A weaker name match is weaker evidence about *this* model, so it speaks quieter.
        predictions.push({
          value,
          weight: calibration.weight * clamp(match.score ?? 1, 0.1, 1),
          source: match.board === 'overall' ? 'lmarena-overall' : 'lmarena-coding',
        })
      }
    }
  }
  // benchmarklist evidence
  const bl = qualityData?.benchmarklist
  if (bl?.calibrations) {
    const blResult = resolveBenchmarkListQuality(bl, modelId)
    if (blResult?.contributions) {
      for (const contrib of blResult.contributions) {
        predictions.push({
          value: contrib.value,
          weight: contrib.weight,
          source: contrib.source,
        })
      }
    }
  }
  return predictions
}

function describeContributions(contributions) {
  return contributions
    .map((contribution) => `${contribution.source}→${contribution.value.toFixed(1)}`)
    .join(', ')
}

/**
 * Resolves the intelligence of a row from fetched evidence.
 *
 * Legacy direct-call order (production fetches use benchmarklist exclusively):
 *   1. AA's measured intelligence index, if the catalog rates this model.
 *   2. Predictions from the measurements the catalog carries (AA coding/agentic indices,
 *      Design Arena Elo) and from LMArena's boards, combined in inverse-error proportion.
 *   3. Nothing — the row is `unscored`, with no number rather than an invented one.
 *
 * @param {object} qualityData result of buildOpenRouterQualityIndex (+ fetched providers)
 * @param {string} modelId the row's id
 */
export function resolveModelQuality(qualityData, modelId) {
  if (qualityData?.benchmarklistOnly) {
    const benchmarklistResult = resolveBenchmarkListQuality(qualityData.benchmarklist, modelId)
    if (!benchmarklistResult) {
      return {
        score: 0,
        aa: null,
        aaEstimated: false,
        source: 'unscored',
        isEstimated: true,
        detail: 'no benchmarklist intelligence evidence for this model',
        modelId,
      }
    }
    return rowResult({
      aa: benchmarklistResult.aa,
      source: benchmarklistResult.source,
      detail: benchmarklistResult.detail,
      modelId,
      qualityData,
      estimated: benchmarklistResult.isEstimated !== false,
    })
  }

  const entry = findEntry(qualityData, modelId)
  if (entry?.kind === 'measured') {
    const sameId =
      entry.modelId && entry.modelId !== modelId ? ` (catalog spelling ${entry.modelId})` : ''
    return rowResult({
      aa: entry.aa,
      source: 'artificial-analysis',
      detail: `AA intelligence index ${entry.aa}${sameId}`,
      modelId,
      qualityData,
      estimated: false,
    })
  }
  const predictions = gatherPredictions(qualityData, modelId, entry)
  const combined = combinePredictions(predictions)
  if (!combined) {
    return {
      score: 0,
      aa: null,
      aaEstimated: false,
      source: 'unscored',
      isEstimated: true,
      detail: 'no fetched intelligence evidence for this model',
      modelId,
    }
  }
  const sources = [...new Set(combined.contributions.map((prediction) => prediction.source))]
  const accuracy = combined.contributions
    .map((prediction) => {
      let cal
      if (qualityData?.benchmarklist?.calibrations?.[prediction.source]) {
        cal = qualityData.benchmarklist.calibrations[prediction.source]
      } else {
        cal =
          qualityData?.calibrations?.[
            prediction.source === 'coding-index'
              ? 'coding'
              : prediction.source === 'agentic-index'
                ? 'agentic'
                : prediction.source === 'design-arena'
                  ? 'designArena'
                  : prediction.source === 'lmarena-coding'
                    ? 'lmarenaCoding'
                    : prediction.source === 'lmarena-overall'
                      ? 'lmarenaOverall'
                      : prediction.source
          ]
      }
      return `${prediction.source} mae ${(cal?.mae ?? DEFAULT_CALIBRATION_MAE).toFixed(1)}`
    })
    .join(', ')
  return rowResult({
    aa: Number(combined.value.toFixed(1)),
    source: combined.source,
    detail: `estimated from ${sources.join(' + ')} (${describeContributions(combined.contributions)}; ${accuracy})`,

    modelId,
    qualityData,
    estimated: true,
  })
}

export function resolveModelQualityWithFallback(qualityData, modelId, fallbackModelId) {
  // Prefer known backend evidence, but retain an exact advertised-model score for opaque IDs.
  const quality = resolveModelQuality(qualityData, modelId)
  if (quality.source !== 'unscored' || !fallbackModelId || fallbackModelId === modelId) {
    return quality
  }
  const fallback = resolveModelQuality(qualityData, fallbackModelId)
  return fallback.source === 'unscored' ? quality : { ...fallback, modelId }
}

/**
 * Restates a slope-line selector written on the old Elo scale in Artificial Analysis index
 * units. The selector picks whichever row first touches `intelligence + slope × speed`, so
 * restating the intelligence term by the factor it was measured on restates the slope with
 * it and leaves the chosen model unchanged.
 *
 * Returns null when there is nothing configured to convert, or no anchor evidence to
 * convert with (so a later refresh retries rather than converting on a guess).
 *
 * @param {{slope?: number|null, minSpeed?: number|null, minIntell?: number|null}} selector
 * @param {{slope: number, intercept: number}|null} regression
 */
export function convertSelectorToAaScale(selector, regression) {
  const slope = Number(selector?.slope)
  const minIntell = Number(selector?.minIntell)
  const hasSlope = selector?.slope != null && Number.isFinite(slope)
  const hasFloor = selector?.minIntell != null && Number.isFinite(minIntell)
  if (!hasSlope && !hasFloor) return null
  if (!regression || !Number.isFinite(regression.slope) || !Number.isFinite(regression.intercept))
    return null
  return {
    slope: hasSlope ? Number((slope * regression.slope).toFixed(2)) : null,
    minSpeed: selector?.minSpeed ?? null,
    minIntell: hasFloor
      ? Number(clamp(regression.intercept + regression.slope * minIntell, 0, 100).toFixed(1))
      : null,
    intellScale: 'aa',
  }
}

// ---------------------------------------------------------------------------
// Fetching.
// ---------------------------------------------------------------------------

async function fetchCatalog(fetchImpl, url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload?.data))
    throw new Error('OpenRouter model catalog returned an invalid payload')
  return payload.data
}

/**
 * Fetches the catalog, fits the calibrations, and attaches the leaderboards. Cached for a
 * day; `force` refreshes immediately. A failed leaderboard fetch degrades to the catalog's
 * own evidence rather than failing the whole refresh.
 */
export async function fetchOpenRouterQualityIndex({
  fetchImpl = fetch,
  nowMs = Date.now(),
  force = false,
  modelIds = [],
} = {}) {
  if (!force && cachedQuality && nowMs - cachedAt < MODEL_QUALITY_CACHE_MS) {
    await attachBenchmarkList(cachedQuality, { fetchImpl, modelIds })
    return cachedQuality
  }
  const catalog = await fetchCatalog(fetchImpl, OPENROUTER_MODELS_URL)
  const quality = buildOpenRouterQualityIndex(catalog)
  quality.benchmarklistOnly = true
  await attachBenchmarkList(quality, { fetchImpl, force, modelIds })
  cachedQuality = quality
  cachedAt = nowMs
  return quality
}
