/**
 * @file lib/benchmarklist-quality.js
 * @description Intelligence scoring from benchmarklist.com evidence.
 *
 * benchmarklist.com publishes a documented public API with 2600+ benchmarks and 24,600+
 * models. Each benchmark exposes a `/api/v1/results/{id}.json` endpoint that returns
 * timestamped snapshots with provenance (source_url, source_type, self_reported flag,
 * aliases). Multiple snapshots per benchmark let us pick the one with the most
 * AA-rated overlap.
 *
 * We fit the same isotonic (pool-adjacent-violators) calibrations used by
 * lib/model-quality.js, projecting each benchmark's scores onto the AA Intelligence
 * Index (0–100) scale. Predictions combine in inverse-error proportion. A model with
 * no evidence on any selected benchmark stays unscored.
 */

import { fetchJsonWithRetry } from './providers/discovery.js'
import { aggregatorBareModelId, qualityLookupKeys } from './model-quality.js'
import { resolveAliasedModelId } from '../sources.js'
import { fetch } from 'undici'

export const BENCHMARKLIST_API_BASE = 'https://benchmarklist.com/api/v1'

// Coding/agentic benchmarks on benchmarklist with strong AA overlap (tested 2026-11).
// Each entry: { benchmarkId, label, minAnchors }
// minAnchors is the AA calibration threshold; benchmarks below it are skipped.
export const BENCHMARKLIST_CALIBRATION_BENCHMARKS = [
  { id: 'scicode', label: 'SciCode', minAnchors: 8 },
  { id: 'vals_terminal_bench_2_1', label: 'Terminal-Bench 2.1 (vals)', minAnchors: 8 },
  { id: 'swe_marathon', label: 'SWE-Marathon', minAnchors: 8 },
  { id: 'kernelbench_cuda', label: 'KernelBench CUDA', minAnchors: 8 },
  { id: 'frontierswe', label: 'FrontierSWE', minAnchors: 8 },
  { id: 'vals_vibe_code', label: 'Vibe Code (vals)', minAnchors: 8 },
  { id: 'vals_swebench', label: 'SWE-bench Verified (vals)', minAnchors: 8 },
  { id: 'deepswe_1_1', label: 'DeepSWE 1.1', minAnchors: 8 },
  { id: 'vals_lcb', label: 'LiveCodeBench (vals)', minAnchors: 8 },
  { id: 'vals_code_migration', label: 'Code Migration (vals)', minAnchors: 8 },
  { id: 'vals_vals_index', label: 'VALS Index', minAnchors: 8 },
  { id: 'vals_vals_multimodal_index', label: 'VALS Multimodal Index', minAnchors: 8 },
  { id: 'frontiercode', label: 'FrontierCode', minAnchors: 8 },
  { id: 'swe_bench_pro', label: 'SWE-bench Pro', minAnchors: 8 },
  { id: 'openai_swe_bench_verified', label: 'SWE-bench Verified', minAnchors: 8 },
]

// We only need the latest snapshot with the most AA anchors, so walk until exhausted.

// Vendor-published benchmark scores for models benchmarklist does not measure.
// These are the vendor's own claims, not independent results: they are injected into
// the calibration lookups so the same isotonic projection can place them on the AA
// scale, and every contribution they produce is flagged `selfReported` in the detail.
// Keys are bare model ids (no vendor prefix); values map benchmarklist benchmark ids
// to the vendor's reported score in that benchmark's native unit (fraction here).
export const VENDOR_SELF_REPORTED_SCORES = {
  'agnes-2.5-flash': {
    // Agnes AI launch post, 2026-07-12 (via we0.ai review 2026-07-15). Company-reported.
    vals_terminal_bench_2_1: 0.623,
    vals_swebench: 0.756,
    openai_swe_bench_verified: 0.756,
    swe_bench_pro: 0.504,
  },
  // Cognition's SWE-2 Flash launch table, 2026-11-04. Every figure is Cognition's own
  // evaluation, not an independent BenchmarkList run, so each contribution is flagged
  // `selfReported` and the row reports itself as an estimate.
  //
  // Flash is a different model from the 2.8T flagship SWE-2, and BenchmarkList does not measure
  // it, so without this table the row has no evidence at all and shows a dash. The saturated
  // boards are listed because the vendor published them, but anchorResolution discounts a
  // benchmark whose anchors crowd its ceiling, so the placement follows DeepSWE and FrontierCode
  // (60.1 and 24.0), where the model is genuinely mid-pack — not the 89–90% it reaches on the
  // older, near-ceiling task sets.
  'swe-2-flash-medium': {
    vals_terminal_bench_2_1: 0.892, // Terminal-Bench 2.1
    swe_bench_pro: 0.899, // SWE-Bench Pro v2 Hard
    deepswe_1_1: 0.601, // DeepSWE 1.1
    frontiercode: 0.24, // FrontierCode 2.0
  },
}

// A curve through fewer anchors than this is not a calibration, it is a coincidence.
const MIN_CALIBRATION_ANCHORS = 8
// Held-out error assumed for a calibration too small to measure its own.
const DEFAULT_CALIBRATION_MAE = 10

let cachedQuality = null
let cachedAt = 0
let cachedModelIds = new Set()
const CACHE_MS = 24 * 60 * 60 * 1000

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function scoreUnit(result) {
  const metric = Object.values(result?.metrics || {}).find((entry) => entry?.unit)
  const unit = String(metric?.unit || '')
    .trim()
    .toLowerCase()
  if (unit === '%' || unit === 'percent' || unit === 'percentage' || unit === 'fraction')
    return 'proportion'
  return unit || null
}

function normalizedScore(result) {
  const score = finiteOrNull(result?.score)
  if (score == null) return null
  const metric = Object.values(result?.metrics || {}).find((entry) => entry?.unit)
  const unit = String(metric?.unit || '')
    .trim()
    .toLowerCase()
  if (unit === '%' || unit === 'percent' || unit === 'percentage') return score / 100
  return score
}

function normalizedModelIdentity(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[/:]/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function benchmarklistIdentityAliases(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
  if (/(?:^|\/)allam-2-7b$/.test(raw)) return ['olmo-2-7b']
  // Groq sells Llama 3.1 8B Instruct as "Instant" (`llama-3.1-8b-instant`, see sources.js), so
  // a relay that lists only `llama-instant` is serving those weights.
  if (/(?:^|\/)llama-instant$/.test(raw)) return ['llama-3.1-8b-instruct']
  if (/(?:^|\/)nemotron-3\.5-bolt-e4b$/.test(raw)) {
    return ['nvidia-nemotron-3.5-bolt-74b-a9b']
  }
  // Mistral's `-latest` and size-qualified spellings name a generation the index rates under
  // the generation's own id, so they are stand-ins rather than direct spellings of it.
  if (/(?:^|\/)mistral-large-latest$/.test(raw)) return ['mistral-large-4']
  if (/(?:^|\/)mistral-large-4-1t-a52b$/.test(raw)) return ['mistral-large-4']
  if (/(?:^|\/)mistral-large-2-instruct$/.test(raw)) return ['mistral-large-2411']
  return []
}

// Dated API snapshots that benchmarklist rates under the generation's name. Kept apart from
// `benchmarklistIdentityAliases` because these are the same weights, not a stand-in model.
const BENCHMARKLIST_SNAPSHOT_ALIASES = [
  // Cohere ships North Mini Code as `north-mini-code-1.0`; benchmarklist rates the same
  // output under the generation's id, and AA's index has it (9.9).
  [/^(?:[a-z0-9]+-)?north-mini-code-1\.0$/, () => 'north-mini-code'],
  [
    /^(?:[a-z0-9]+-)?ministral-(3|8|14)b(?:-(?:2512|latest|instruct-2512))?$/,
    (match) => `ministral-3-${match[1]}b`,
  ],
  // Mistral publishes Large 3 as `…-2512` and spells Large 4 as `4` or `4.0`; the generation
  // digit is the identity, the snapshot/major-version footer is not.
  [
    /^(?:[a-z0-9]+-)?mistral-large-(4|3)(?:[.:-](?:\d+t(?:-a\d+b)?|\d+b|\d+))?$/,
    (match) => (match[1] === '4' ? 'mistral-large-4' : 'mistral-large-2512'),
  ],
]

function benchmarklistSnapshotAliases(value) {
  // `mistral-large-3:675b` carries the size behind a colon, which is a separator like any other.
  const slug = normalizedModelIdentity(value).replace(/:/g, '-')
  for (const [pattern, to] of BENCHMARKLIST_SNAPSHOT_ALIASES) {
    const match = slug.match(pattern)
    if (match) return to(match)
  }
  return null
}

function benchmarklistProxyLabel(value) {
  const alias = benchmarklistIdentityAliases(value)[0]
  if (alias === 'olmo-2-7b') return 'OLMo 2 7B'
  if (alias === 'llama-3.1-8b-instruct') return 'Llama 3.1 8B Instruct'
  if (alias === 'nvidia-nemotron-3.5-bolt-74b-a9b') return 'Nemotron 3.5 Bolt 74B-A9B'
  if (alias === 'mistral-large-4') return 'Mistral Large 4'
  if (alias === 'mistral-large-2411') return 'Mistral Large 2'
  return null
}

export function exactModelIdentityKeys(value, includeAliases = true) {
  // A relay wraps a model in the name of the route serving it (`srv_<id>:poe/…`); the wrapper
  // is not part of the identity, so the name underneath it is keyed too. Additive on purpose:
  // a provider's own spelling (`@cf/meta/…`) stays a key for the rows that carry it.
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  const bare = aggregatorBareModelId(raw)
  // The index is keyed from the *requested* ids, and a requested id may be a provider's own
  // spelling of a catalog model (`reflection/beam-free`). Resolve the alias here too, so the
  // measured row for the catalog spelling is indexed under the provider's id and the direct
  // AA entry outranks a cross-benchmark estimate.
  const resolved = resolveAliasedModelId(raw) || raw
  const values = new Set([
    raw,
    bare,
    resolved,
    ...(includeAliases ? benchmarklistIdentityAliases(raw) : []),
  ])
  // A free twin is the same weights on a different billing plan (`…-550b-a55b:free`,
  // `nemotron-3.5-lightning-free`). The marker is not part of the model's identity, so strip
  // it here or the rated row is never reached and the twin shows a dash.
  // Some providers glue the marker to the snapshot (`…-0731free`), so a digit may sit where
  // the delimiter would be.
  const freeTwin = raw.replace(/(?:(?::|-|\/)free|(?<=\d)free)+$/, '')
  if (freeTwin && freeTwin !== raw) values.add(freeTwin)
  if (raw.includes('/')) values.add(raw.slice(raw.lastIndexOf('/') + 1))
  const slug = normalizedModelIdentity(raw).split('-')
  if (slug.length > 2 && slug[0] === slug[1]) values.add(slug.slice(1).join('-'))
  const stepfunVariant = raw.match(/^stepfun-ai[/:](.+)$/)
  if (stepfunVariant) values.add(`stepfun-${stepfunVariant[1]}`)
  const devinVariant = raw.match(/^(?:devin[/:])?swe-(\d+)[.-](\d+)-slow$/)
  if (devinVariant) values.add(`cognition-swe-${devinVariant[1]}.${devinVariant[2]}`)
  // SWE-2's effort tiers are one set of weights (2.8T-A104B, post-trained from Kimi K3), so
  // `medium`/`high`/`max` are the same model and share its rows. SWE-2 *Flash* is a different,
  // smaller model (276B-A12B on Thinking Machines' Inkling-Small) with its own published
  // numbers, so it must keep its own identity: folding it in with the flagship scored the cheap
  // tier on the flagship's DeepSWE and Terminal-Bench rows and made it look like the flagship.
  if (/^(?:devin[/:])?swe-2-(?:medium|high|max)$/.test(raw)) {
    values.add('cognition-swe-2')
  }
  if (/^(?:devin[/:])?swe-2-flash-(?:medium|high|max)$/.test(raw)) {
    values.add('cognition-swe-2-flash')
  }
  // One model, three spellings: benchmarklist publishes a vendor-prefixed slug
  // (`google-gemini-3.8-flash`), Google's own catalog a namespaced id
  // (`models/gemini-3.8-flash`), and most providers the bare name (`gemini-3.8-flash`).
  // Both sides of the index match are built here, so the stripped identity has to be offered
  // on each side or the spellings never meet — which is how a Gemini row stayed unscored
  // while a relay's bare spelling of the same weights was scored.
  for (const item of [...values]) {
    const tokens = normalizedModelIdentity(item).split('-').filter(Boolean)
    let start = 0
    if (tokens.length > 1 && BENCHMARKLIST_NAMESPACE_PREFIXES.has(tokens[start])) start += 1
    if (tokens.length > start + 1 && BENCHMARKLIST_VENDOR_PREFIXES.has(tokens[start])) start += 1
    // benchmarklist repeats the family after the vendor for Llama (`meta-llama-llama-3.1-8b-instruct`),
    // so the token that follows the vendor is the same one again. Drop it, or the catalog's
    // `llama-3.1-8b-instruct` never meets the rating for those weights.
    while (tokens.length > start + 2 && tokens[start] === tokens[start + 1]) start += 1
    if (start > 0) values.add(tokens.slice(start).join('-'))
  }
  // A dated API snapshot and the benchmark generation are the same weights: Mistral serves
  // Ministral 3 as `ministral-14b-2512` / `ministral-14b-latest` (sources.js already equates
  // `ministral-3:14b` with that snapshot) while benchmarklist rates `ministral-3-14b`. That is
  // a spelling difference, not a stand-in model, so it joins the direct identity and carries
  // no proxy marker.
  for (const item of [...values]) {
    const snapshot = benchmarklistSnapshotAliases(item)
    if (snapshot) values.add(snapshot)
  }
  const keys = new Set()
  for (const item of values) {
    const normalized = normalizedModelIdentity(item)
    if (!normalized) continue
    keys.add(normalized)
    keys.add(normalized.replace(/\./g, '-'))
    keys.add(normalized.replace(/-/g, '.'))
  }
  return keys
}

async function fetchModelIndexScores(modelIds, snapshots) {
  const scores = new Map()
  const requested = [...new Set((modelIds || []).map(String).filter(Boolean))]
  if (!requested.length) return { scores, modelIds: new Set() }

  const keysByModel = new Map(
    requested.map((modelId) => [modelId, exactModelIdentityKeys(modelId)]),
  )
  const directKeysByModel = new Map(
    requested.map((modelId) => [modelId, exactModelIdentityKeys(modelId, false)]),
  )
  // A key that spells another catalog model's own id must not be taken over by an alias of a
  // different row: `mistral-large-latest` resolves to `mistral-large-4`, and the real Large 4
  // row has to keep its direct, unproxied entry under that key.
  const directKeyOwners = new Map()
  for (const [modelId, keys] of directKeysByModel) {
    for (const key of keys) {
      if (!directKeyOwners.has(key)) directKeyOwners.set(key, new Set())
      directKeyOwners.get(key).add(modelId)
    }
  }
  const latestByModel = new Map()
  for (const snapshot of snapshots) {
    for (const result of snapshot.results || []) {
      const score = finiteOrNull(result?.score)
      if (score == null || score > 100) continue
      const sampledAt = result.sampled_at || snapshot.sampled_at || null
      const sampleTime = Date.parse(sampledAt || '') || 0
      const rowKeys = exactModelIdentityKeys(result?.model_id)
      for (const [modelId, modelKeys] of keysByModel) {
        const matchedKeys = [...modelKeys].filter((key) => rowKeys.has(key))
        if (!matchedKeys.length) continue
        const isProxy = ![...directKeysByModel.get(modelId)].some((key) => rowKeys.has(key))
        const previous = latestByModel.get(modelId)
        if (
          !previous ||
          sampleTime > previous.sampleTime ||
          (sampleTime === previous.sampleTime && score > previous.aa)
        ) {
          latestByModel.set(modelId, {
            aa: score,
            name: result.display_name || result.model_id,
            sampledAt,
            sampleTime,
            isProxy,
          })
        }
      }
    }
  }
  for (const [modelId, entry] of latestByModel) {
    for (const key of keysByModel.get(modelId)) {
      const owners = directKeyOwners.get(key)
      if (owners && !owners.has(modelId)) continue
      scores.set(key, entry)
    }
  }
  return { scores, modelIds: new Set(requested.map(normalizedModelIdentity)) }
}

/**
 * Normalize a benchmarklist `model_id` / `display_name` slug into the same key space
 * the catalog uses, falling back to the leaf forms behind a vendor prefix.
 *
 * benchmarklist publishes vendor-prefixed kebab slugs (`anthropic-claude-opus-5`) and the
 * OpenRouter catalog publishes namespaced ones (`anthropic/claude-opus-5`), so a row can
 * only be matched through the bare model name. Version dots are also spelled either way
 * (`swe-1.6` and `swe-1-6`), so both are offered.
 */
/**
 * The digits a slug carries (`swe-1.6` -> 16, `gpt-5.6-terra` -> 56), or null when it
 * carries none.
 */
function slugDigits(slug) {
  const digits = String(slug || '').match(/\d/g)
  return digits ? digits.join('') : null
}

// Namespaces a provider puts in front of a model id that are not part of its identity:
// Google publishes `models/gemini-3.8-flash`, and the model is `gemini-3.8-flash`.
const BENCHMARKLIST_NAMESPACE_PREFIXES = new Set(['models', 'model'])

const BENCHMARKLIST_VENDOR_PREFIXES = new Set([
  'alibaba',
  'allenai',
  'amazon',
  'anthropic',
  'baidu',
  'bytedance',
  'cohere',
  'cognition',
  'databricks',
  'deepinfra',
  'deepseek',
  'fireworks',
  'google',
  'groq',
  'ibm',
  'inclusionai',
  'meta',
  'microsoft',
  'minimax',
  'mistral',
  'mistralai',
  'moonshotai',
  'nvidia',
  'openai',
  'perplexity',
  'poolside',
  'qwen',
  'reflection',
  'reka',
  'stepfun',
  'tencent',
  'tiiuae',
  'upstage',
  'writer',
  'xai',
  'zhipu',
])

/**
 * A model's identity as a bag of words and numbers, order-free.
 *
 * Relays re-spell models as readily as they re-wrap them: benchmarklist publishes
 * `qwen2.5-coder-instruct-32b` where the relay says `qwen2.5-coder-32b-instruct`, and
 * `qwen3-8-27b` where the dashboard says `qwen-3.8-27b`. The words and the numbers are the
 * same set in a different order, and a dot between digits is the same version. Sorting the
 * runs makes those spellings one key while a different size or version still differs (32b
 * stays 32b; 3.8 stays 3,8), which is what keeps this from merging two real models.
 */
function modelSignature(value) {
  return normalizedModelIdentity(aggregatorBareModelId(value))
    .split('-')
    .flatMap((token) => token.match(/[a-z]+|\d+/g) || [])
    .sort()
    .join('-')
}

// The words that say how a model is *asked* rather than which model it is: an instruction
// tune, a reasoning mode, a preview snapshot. Size and variant words are deliberately absent
// — `lite`, `mini`, `flash`, `plus` and `fast` all name a different model with its own
// benchmarks (SWE-2 Flash is not SWE-2), and matching one of those would be scoring a
// different model rather than a re-spelling of this one.
const TIER_TOKENS = new Set([
  'exp',
  'experimental',
  'preview',
  'thinking',
  'reasoning',
  'non',
  'instruct',
  'it',
  'chat',
  'base',
  // Effort and serving-speed markers, which say how a request is asked rather than which model
  // answers it. `xhigh` is an effort level and `ultraspeed` a throughput tier; neither changes
  // the weights behind the name.
  'xhigh',
  'highspeed',
  'ultraspeed',
  'minimal',
])

function tierlessSignature(value) {
  return modelSignature(value)
    .split('-')
    .filter((token) => token && !TIER_TOKENS.has(token))
    .join('-')
}

// One signature index per look-up map, built on first use and never rebuilt: the maps live for
// as long as the fetched quality index does, which is a day. Two views of the same keys — the
// words in any order, and the same without a serving tier — because a re-spelling and a tier
// variant are different claims about the row.
const SIGNATURE_INDEXES = new WeakMap()

function signatureIndexFor(map) {
  const cached = SIGNATURE_INDEXES.get(map)
  if (cached) return cached
  const byFull = new Map()
  const byTierless = new Map()
  const add = (index, signature, key) => {
    if (!signature) return
    const bucket = index.get(signature)
    if (bucket) {
      if (!bucket.includes(key)) bucket.push(key)
    } else {
      index.set(signature, [key])
    }
  }
  for (const key of map.keys()) {
    add(byFull, modelSignature(key), key)
    add(byTierless, tierlessSignature(key), key)
  }
  const index = { byFull, byTierless }
  SIGNATURE_INDEXES.set(map, index)
  return index
}

/**
 * The catalog key that names a row's model under a different word order or serving tier, or
 * null when nothing in this map is close enough to stand in for it.
 *
 * Exact spellings are tried by the caller first; this only runs when none of them is present.
 * A bucket that holds several keys is fine — they are the same weights spelled with and
 * without a vendor prefix (`gemma-4-31b`, `google-gemma-4-31b-it`) — so the shortest, barest
 * spelling is taken. `tiered` says the match needed a serving word dropped, which is a weaker
 * claim than a re-spelling and is reported as a proxy in the estimate's detail.
 *
 * @returns {{ key: string, tiered: boolean } | null}
 */
function fuzzyMatchKey(modelId, map) {
  const index = signatureIndexFor(map)
  const shortest = (bucket) => bucket.reduce((best, key) => (key.length < best.length ? key : best))
  const respelled = index.byFull.get(modelSignature(modelId))
  if (respelled?.length) return { key: shortest(respelled), tiered: false }
  const variant = index.byTierless.get(tierlessSignature(modelId))
  if (variant?.length) return { key: shortest(variant), tiered: true }
  return null
}

// The words that say *which size or variant of the line* a row is: `glm-4.6v-flash` beside
// `glm-4.6v`, `qwen3-coder-plus` beside `qwen3-coder`. They are not serving tiers (dropping one
// is not the same weights asked differently) and they are not re-spellings, so they are the one
// thing fuzzyMatchKey refuses to ignore. They are, however, the boundary of a *line*, and a
// free host offering the Flash of a model whose full-size sibling is rated is a case worth
// answering — as a family estimate that names the donor, never as this model's own score.
const FAMILY_TOKENS = new Set([
  'flash',
  'flashx',
  'plus',
  'turbo',
  'lite',
  'mini',
  'nano',
  'air',
  'ultra',
  'pro',
  'max',
  'tiny',
  'small',
  'medium',
  'next',
])

const isNumericToken = (token) => /^\d+$/.test(token)

/** The digits of a model id in the order they are written (`ling-3.2` → `['3','2']`). */
function orderedNumbers(value) {
  return normalizedModelIdentity(aggregatorBareModelId(value)).match(/\d+/g) || []
}

/**
 * The last word that names the model itself, read in the order it is written (`z-ai/glm-4.6v`
 * names a `v`, not a `z`), with size, serving and relay words removed.
 */
function mineNameWord(value) {
  const words = (
    normalizedModelIdentity(aggregatorBareModelId(value)).match(/[a-z]+|\d+/g) || []
  ).filter(
    (token) => !isNumericToken(token) && !TIER_TOKENS.has(token) && !FAMILY_TOKENS.has(token),
  )
  return words[words.length - 1] || null
}

/** The tokens that place a model in a line, with its size and variant words removed. */
function familyTokens(value) {
  return new Set(
    tierlessSignature(value)
      .split('-')
      .filter((token) => token && !FAMILY_TOKENS.has(token)),
  )
}

// Indexed by word token rather than by whole signature: a donor can carry extra words the row
// does not (`llama-3.2-instruct-3b` for `llama3.2`), so the lookup has to be a subset search.
// Each key appears under each of its word tokens, which keeps the candidate set small.
const FAMILY_INDEXES = new WeakMap()

function familyIndexFor(map) {
  const cached = FAMILY_INDEXES.get(map)
  if (cached) return cached
  const byWord = new Map()
  for (const key of map.keys()) {
    for (const token of familyTokens(key)) {
      if (isNumericToken(token)) continue
      const bucket = byWord.get(token)
      if (bucket) {
        if (!bucket.includes(key)) bucket.push(key)
      } else {
        byWord.set(token, [key])
      }
    }
  }
  FAMILY_INDEXES.set(map, byWord)
  return byWord
}

/**
 * The rated row one step out from this model in the same line, or null when the catalog holds
 * nothing in the line.
 *
 * A donor has to agree on every number the row names (so `ling-3.2-flash` never takes
 * `ling-3.0-flash`, a different release) and on at least two tokens, and the row may carry at
 * most one word the donor does not have — one, because a relay's own label is one word
 * (`gemini-claude-opus-4-6-thinking`) and two would be a different model altogether. The
 * closest donor wins: fewest surplus words on the row, then most tokens in common, then the
 * donor with the least of its own extra words, then the shortest key.
 *
 * @returns {string|null}
 */
function familyMatchKey(modelId, map) {
  const mine = familyTokens(modelId)
  if (mine.size < 2) return null
  const mineSizes = new Set(
    [...tierlessSignature(modelId).split('-')].filter((t) => FAMILY_TOKENS.has(t)),
  )
  const byWord = familyIndexFor(map)
  const candidates = new Set()
  for (const token of mine) {
    if (isNumericToken(token)) continue
    for (const key of byWord.get(token) || []) candidates.add(key)
  }
  const mineVersions = orderedNumbers(modelId)
  let best = null
  for (const key of candidates) {
    const donor = familyTokens(key)
    if ([...mine].some((token) => isNumericToken(token) && !donor.has(token))) continue
    // The numbers have to open the donor's own: `gpt-6-luna` may hear from `gpt-6-luna-…` but
    // not from `gpt-5.6-luna`, whose `6` is a point release of the fifth generation.
    const donorVersions = orderedNumbers(key)
    if (donorVersions.slice(0, mineVersions.length).join('-') !== mineVersions.join('-')) continue
    // A donor that names a *different* size is a different model (`deepseek-coder-v2` must not
    // hear from `deepseek-coder-v2-lite`); a donor that names no size at all is the line's
    // flagship row, and a Flash or a Plus of that line may hear from it.
    const donorSizes = [...tierlessSignature(key).split('-')].filter((t) => FAMILY_TOKENS.has(t))
    if (donorSizes.some((token) => !mineSizes.has(token))) continue
    const shared = [...mine].filter((token) => donor.has(token))
    // Three shared tokens and one of them a word: two tokens and a bare `v3` is how a video
    // model (a `kling-v3`) ended up holding a language model's score, because `v` and `3` are
    // all the two names had in common.
    if (shared.length < 3) continue
    if (!shared.some((token) => !isNumericToken(token) && token.length >= 3)) continue
    // The row's own name has to be the donor's too: `gpt-5.6-luna` and `gpt-5.6-sol` share a
    // generation number and nothing that says they are the same model.
    const nameWord = mineNameWord(modelId)
    if (nameWord && !donor.has(nameWord)) continue
    const rank = [
      mine.size - shared.length,
      shared.length * -1,
      donor.size - shared.length,
      key.length,
    ]
    if (best && compareRanks(rank, best.rank) >= 0) continue
    best = { key, rank }
  }
  return best?.key ?? null
}

function compareRanks(a, b) {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * The rated row from the same release line one point version back, or null. `ling-3.2-flash`
 * has no rated row, and `ling-3.0-flash` is the closest thing anyone has measured — a previous
 * release of the same line, which is a weaker statement than familyMatchKey's sibling and far
 * weaker than a match, so it is a last resort and the donor is named in the detail.
 *
 * The line has to agree word for word (`ling` against `ling`) and the *first* number has to
 * agree too (3.2 and 3.0 are one line; 4.6 against 5.3 is not), so a newer generation is never
 * given an older one's number.
 *
 * @returns {string|null}
 */
function nearestReleaseKey(modelId, map) {
  const mineWords = [...familyTokens(modelId)].filter((token) => !isNumericToken(token))
  // Numbers as they are written, not as the signature sorts them: `ling-3.2` against
  // `ling-2.6` share the number 2 and share nothing else, and only the leading position says
  // which generation a row belongs to.
  const mineVersions = orderedNumbers(modelId)
  // The size word is what the family comparison threw away, and here it is the most useful
  // thing on the row: a 3.1 *Flash* should hear from 3.0 Flash, not from 3.0 Tiny.
  const mineSizes = new Set(
    [...tierlessSignature(modelId).split('-')].filter((t) => FAMILY_TOKENS.has(t)),
  )
  if (!mineWords.length || !mineVersions.length) return null
  const byWord = familyIndexFor(map)
  const candidates = new Set()
  for (const token of mineWords) for (const key of byWord.get(token) || []) candidates.add(key)
  let best = null
  for (const key of candidates) {
    const donorWords = [...familyTokens(key)].filter((token) => !isNumericToken(token))
    // One word either way is the vendor prefix (`inclusionai-ling-3.0-flash` beside
    // `ling-3.0-flash`); the line's own name is the word they must share.
    const sharedWords = mineWords.filter((token) => donorWords.includes(token))
    if (!sharedWords.some((token) => token.length >= 3)) continue
    // The line's own name is the row's last word (`gpt-6.1-terra` is a terra, not an astra),
    // and a donor that calls itself something else is another model, not another release.
    if (!sharedWords.includes(mineWords[mineWords.length - 1])) continue
    if (mineWords.length - sharedWords.length > 1) continue
    if (donorWords.length - sharedWords.length > 1) continue
    const donorVersions = orderedNumbers(key)
    if (donorVersions[0] !== mineVersions[0]) continue
    // A donor naming a size the row does not is a smaller or larger model: `deepseek-coder-v2`
    // must not be scored from `deepseek-coder-v2-lite` one release over.
    const donorSizes = new Set(
      [...tierlessSignature(key).split('-')].filter((token) => FAMILY_TOKENS.has(token)),
    )
    if ([...donorSizes].some((token) => !mineSizes.has(token))) continue
    const sizeMismatch =
      [...mineSizes].filter((token) => !donorSizes.has(token)).length +
      [...donorSizes].filter((token) => !mineSizes.has(token)).length
    const distance = mineVersions.reduce(
      (sum, token, index) => sum + Math.abs(Number(token) - Number(donorVersions[index] ?? token)),
      0,
    )
    const rank = [sizeMismatch, distance, key.length]
    if (best && compareRanks(rank, best.rank) >= 0) continue
    best = { key, rank }
  }
  return best?.key ?? null
}

export function benchmarklistLookupKeys(raw) {
  const keys = []
  // Only the id's own spellings are offered. `qualityLookupKeys` also returns the
  // fast/fp8-stripped form of a model, and on this catalog that would be a *different*
  // model: `swe-1-6-fast` (Devin's fast tier) and `swe-1.6` (the slow one) share every
  // token once the tier is stripped, so a row for one would answer for the other.
  // We collect spellings from the raw id and also from `qualityLookupKeys`, but then we
  // filter out any spelling that lost a serving suffix the raw id had (i.e., the raw id
  // keeps 'fast' or 'fp8' but the derived one does not).
  const rawSpelling = String(raw || '').toLowerCase()
  const bareSpelling = aggregatorBareModelId(rawSpelling)
  const rawDigits = slugDigits(rawSpelling)
  const spellings = new Set([rawSpelling])
  // The name under a relay's wrapper is the model; the provider's own spelling stays a key for
  // rows that use it directly.
  if (bareSpelling && bareSpelling !== rawSpelling) spellings.add(bareSpelling)
  const explicitAliases = new Set(benchmarklistIdentityAliases(rawSpelling))
  // A free twin serves the same weights as the model it mirrors, so the id underneath has to
  // stay a key rather than be rejected as a stripped serving suffix.
  const freeBase = rawSpelling.replace(/(?:(?::|-|\/)free|(?<=\d)free)+$/, '')
  if (freeBase && freeBase !== rawSpelling) {
    spellings.add(freeBase)
    explicitAliases.add(freeBase)
  }
  // A reasoning-effort setting names how hard the same weights are asked to think, not which
  // model they are: `gpt-oss-120b-medium` is rated as `gpt-oss-120b`. It is added as an
  // explicit alias because the digit guard below would otherwise reject it as a model whose
  // tier had been stripped.
  const effortBase = rawSpelling.replace(
    /-(?:non-reasoning|xhigh|high|medium|low|minimal|thinking|reasoning)$/,
    '',
  )
  if (effortBase && effortBase !== rawSpelling) {
    spellings.add(effortBase)
    explicitAliases.add(effortBase)
  }
  for (const alias of explicitAliases) spellings.add(alias)
  // Devin's catalog exposes effort/latency variants while BenchmarkList records the
  // underlying Cognition model. These are the documented SWE model configurations, not
  // generic serving suffixes: retain the model version while mapping to its base identity.
  const devinVariant = rawSpelling.match(/^(?:devin[/:])?swe-(\d+)[.-](\d+)-slow$/)
  if (devinVariant) {
    const alias = `cognition-swe-${devinVariant[1]}.${devinVariant[2]}`
    spellings.add(alias)
    explicitAliases.add(alias)
  }
  // Effort tiers of the flagship share its rows; the Flash tier is a separate model and does
  // not (see exactModelIdentityKeys). Without rows of its own it stays unscored, which is the
  // honest answer — borrowing the flagship's ratings is the invented fallback this file avoids.
  if (/^(?:devin[/:])?swe-2-(?:medium|high|max)$/.test(rawSpelling)) {
    spellings.add('cognition-swe-2')
    explicitAliases.add('cognition-swe-2')
  }
  if (/^(?:devin[/:])?swe-2-flash-(?:medium|high|max)$/.test(rawSpelling)) {
    spellings.add('cognition-swe-2-flash')
    explicitAliases.add('cognition-swe-2-flash')
  }
  const stepfunVariant = rawSpelling.match(/^stepfun-ai[/:](.+)$/)
  if (stepfunVariant) {
    const alias = `stepfun-${stepfunVariant[1]}`
    spellings.add(alias)
    explicitAliases.add(alias)
  }
  for (const key of qualityLookupKeys(raw)) spellings.add(key)
  for (const spelling of spellings) {
    // Drop spellings that are a fast/fp8/lora-stripped version of the raw id.
    // If the raw keeps the tier and the candidate drops it, it is a different model.
    const derivedDigits = slugDigits(spelling)
    if (
      rawDigits &&
      derivedDigits === rawDigits &&
      !spelling.includes(rawSpelling) &&
      spelling !== rawSpelling &&
      !explicitAliases.has(spelling)
    ) {
      // The candidate has the same digits but is missing the tier — reject.
      continue
    }
    for (const value of [spelling, spelling.replace(/\./g, '-'), spelling.replace(/-/g, '.')]) {
      const tokens = String(value || '')
        .split(/[\s:/_-]+/)
        .filter(Boolean)
      if (!tokens.length) continue
      // `models/gemini-3.8-flash` names a namespace, not a model family: drop it so the
      // benchmark catalog's `google-gemini-3.8-flash` leaf is reachable from the row id.
      if (tokens.length > 1 && BENCHMARKLIST_NAMESPACE_PREFIXES.has(tokens[0])) tokens.shift()
      const full = tokens.join('-')
      // Only remove a known vendor prefix; dropping the first token of a model slug
      // can make unrelated size variants collide (for example `allam-2-7b` -> `2-7b`).
      const leafs = [full]
      if (tokens.length > 1 && BENCHMARKLIST_VENDOR_PREFIXES.has(tokens[0])) {
        leafs.push(tokens.slice(1).join('-'))
      }
      for (const leaf of leafs) {
        // Keep model digits and a family name so unrelated size variants cannot collide.
        if (slugDigits(leaf) !== slugDigits(full)) continue
        if (!/[a-z]/.test(leaf)) continue
        keys.push(leaf)
      }
    }
  }
  return [...new Set(keys.filter((key) => key.length > 1))]
}

/**
 * Fetch all snapshots for a benchmark, following pagination cursors.
 */
async function fetchAllSnapshots(fetchImpl, benchmarkId, cache = null) {
  const url = `${BENCHMARKLIST_API_BASE}/results/${encodeURIComponent(benchmarkId)}.json`
  let cursor = null
  const snapshots = []
  for (;;) {
    const pageUrl = cursor ? `${url}?cursor=${encodeURIComponent(cursor)}` : url
    // `cache` is the model cache's mode for this read (see lib/providers/catalog-cache.js), and
    // `null` — the default — keeps this a plain fetch for callers that never asked for it. Its
    // window is the index's own day (`CACHE_MS`): a benchmark snapshot is older than that by
    // construction, so re-downloading it on every launch buys nothing.
    const payload = await fetchJsonWithRetry(pageUrl, {
      fetchImpl,
      timeoutMs: 30000,
      cache,
      cacheMaxAgeMs: CACHE_MS,
    })
    const snaps = Array.isArray(payload?.snapshots) ? payload.snapshots : []
    snapshots.push(...snaps)
    cursor = payload?.next_cursor || null
    if (!cursor || snaps.length === 0) break
  }
  return snapshots
}

/**
 * For a benchmark's snapshots, find the one with the most AA-rated anchors.
 * Returns { points: [[score, aa]], snapshotMeta, rows: Map<key, score> } or null.
 */
function bestSnapshot(snapshots, aaByKey) {
  let best = null
  for (const snap of snapshots) {
    const rows = new Map()
    const pointsByModel = new Map()
    for (const r of snap.results || []) {
      const score = normalizedScore(r)
      if (score == null) continue
      const modelKeys = benchmarklistLookupKeys(r?.model_id)
      for (const key of modelKeys) {
        if (!rows.has(key)) rows.set(key, score)
      }
      const nameKeys = benchmarklistLookupKeys(r?.display_name)
      for (const key of nameKeys) {
        if (!rows.has(key)) rows.set(key, score)
      }
      const anchor = [...modelKeys, ...nameKeys]
        .map((key) => aaByKey.get(key))
        .find((aa) => aa != null)
      if (anchor != null) {
        const modelKey = normalizedModelIdentity(r?.model_id || r?.display_name)
        if (modelKey && !pointsByModel.has(modelKey)) pointsByModel.set(modelKey, [score, anchor])
      }
    }
    const points = [...pointsByModel.values()]
    if (points.length >= MIN_CALIBRATION_ANCHORS && (!best || points.length > best.points.length)) {
      best = { points, snapshotMeta: snap, rows }
    }
  }
  return best
}

/**
 * Build a lookup table from all snapshots: model key -> score.
 * Used at resolution time to find a model's score on a benchmark.
 */
function buildScoreLookup(snapshots) {
  const lookup = new Map()
  for (const snap of snapshots) {
    for (const r of snap.results || []) {
      const score = normalizedScore(r)
      if (score == null) continue
      for (const key of benchmarklistLookupKeys(r?.model_id)) {
        if (!lookup.has(key)) lookup.set(key, score)
      }
      for (const key of benchmarklistLookupKeys(r?.display_name)) {
        if (!lookup.has(key)) lookup.set(key, score)
      }
    }
  }
  return lookup
}

/**
 * Isotonic regression (pool adjacent violators) of y on x.
 * Identical to fitMonotone in model-quality.js, kept here to avoid a circular dep.
 */
function fitMonotone(points) {
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
 * Predict y from a fitted isotonic curve; null if out of range.
 */
function predictMonotone(value, calibration) {
  if (value == null || value === '') return null
  const x = Number(value)
  if (!Number.isFinite(x) || !calibration?.xs?.length) return null
  const { xs, ys } = calibration
  const n = xs.length
  if (n === 1) return clamp(ys[0])
  if (x < xs[0] || x > xs[n - 1]) return null
  if (x === xs[0]) return clamp(ys[0])
  if (x === xs[n - 1]) return clamp(ys[n - 1])
  let low = 0
  let high = n - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (xs[mid] <= x) low = mid
    else high = mid
  }
  const span = xs[high] - xs[low]
  const weight = span === 0 ? 0 : (x - xs[low]) / span
  return clamp(ys[low] + (ys[high] - ys[low]) * weight)
}

/**
 * Held-out MAE (leave-one-out). Used to weight predictions.
 */
function heldOutError(points) {
  if (points.length < MIN_CALIBRATION_ANCHORS + 2) return null
  const errors = []
  for (let i = 0; i < points.length; i++) {
    const fit = fitMonotone(points.filter((_, j) => j !== i))
    const predicted = predictMonotone(points[i][0], fit)
    if (predicted != null) errors.push(Math.abs(predicted - points[i][1]))
  }
  if (!errors.length) return null
  return errors.reduce((a, b) => a + b, 0) / errors.length
}

// The share of its own scale a benchmark has to spread its anchors over before its evidence
// counts at full strength. Half the scale is a board with genuine range at both ends.
const RESOLUTION_HEADROOM = 0.5

/** Nearest-rank percentile over an already sorted array, so no value is invented between rows. */
function percentileOf(sorted, p) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

/**
 * How much of its own scale a benchmark actually used.
 *
 * Weight here is inverse held-out error, and a *saturated* benchmark is predictable: when
 * every strong model sits against the ceiling, the isotonic fit goes flat, held-out MAE
 * collapses, and `1/(mae+1)^2` hands that benchmark the largest weight in the blend — exactly
 * where it has the least to say about which model is better. A board whose anchors are
 * crammed into 88–95% cannot rank the models this app chooses between; a board spanning
 * 20–90% can. The two carry identical held-out error, so error alone cannot tell them apart.
 *
 * Returns 1 for a board with at least RESOLUTION_HEADROOM of range, falling towards 0 as its
 * anchors pile up against one end.
 */
export function anchorResolution(points) {
  const scores = (points || [])
    .map((point) => Number(point?.[0]))
    .filter((score) => Number.isFinite(score))
    .sort((a, b) => a - b)
  if (scores.length < MIN_CALIBRATION_ANCHORS) return 0
  const high = percentileOf(scores, 0.9)
  const low = percentileOf(scores, 0.1)
  if (!(high > 0)) return 0
  const headroom = clamp((high - low) / high, 0, 1)
  return clamp(headroom / RESOLUTION_HEADROOM, 0, 1)
}

function makeCalibration(source, points) {
  const fit = fitMonotone(points)
  if (!fit) return null
  const mae = heldOutError(points)
  const resolution = anchorResolution(points)
  const weight = (1 / ((mae ?? DEFAULT_CALIBRATION_MAE) + 1) ** 2) * resolution
  return { ...fit, source, mae, resolution, weight }
}

/**
 * Build the benchmarklist quality index from the OpenRouter catalog (for AA anchors).
 */
export async function buildBenchmarkListQualityIndex(
  catalog,
  { fetchImpl = fetch, modelIds = [], cache = null } = {},
) {
  let indexSnapshots = []
  try {
    indexSnapshots = await fetchAllSnapshots(
      fetchImpl,
      'artificial_analysis_intelligence_index',
      cache,
    )
  } catch (err) {
    console.warn('[benchmarklist] intelligence index feed unavailable:', err?.message || err)
  }

  // Build AA lookup from catalog
  const aaByKey = new Map()
  for (const model of catalog || []) {
    const aa = model?.benchmarks?.artificial_analysis?.intelligence_index
    if (aa == null) continue
    for (const key of qualityLookupKeys(model.id)) {
      if (!aaByKey.has(key)) aaByKey.set(key, aa)
    }
  }
  const indexAnchors = new Map()
  for (const snapshot of indexSnapshots) {
    for (const result of snapshot.results || []) {
      const score = finiteOrNull(result?.score)
      if (score == null || score > 100) continue
      const sampledAt = result.sampled_at || snapshot.sampled_at || null
      const sampleTime = Date.parse(sampledAt || '') || 0
      for (const key of exactModelIdentityKeys(result?.model_id)) {
        const previous = indexAnchors.get(key)
        if (
          !previous ||
          sampleTime > previous.sampleTime ||
          (sampleTime === previous.sampleTime && score > previous.aa)
        ) {
          indexAnchors.set(key, { aa: score, sampleTime })
        }
      }
    }
  }
  for (const [key, entry] of indexAnchors) {
    if (!aaByKey.has(key)) aaByKey.set(key, entry.aa)
  }

  const calibrations = {}
  const benchmarks = []
  // scoreLookups[benchId] = { calibration: Map<key, score>, snapshots: Map<snapshotKey, Map<key, score>> }
  // where snapshotKey = `${sampled_at}|${source_key}`
  const scoreLookups = {}

  const benchmarkIndexes = await Promise.all(
    BENCHMARKLIST_CALIBRATION_BENCHMARKS.map(async (spec) => {
      try {
        const snapshots = await fetchAllSnapshots(fetchImpl, spec.id, cache)
        const best = bestSnapshot(snapshots, aaByKey)
        if (!best) {
          console.warn(
            `[benchmarklist] ${spec.id}: no snapshot with ${MIN_CALIBRATION_ANCHORS}+ AA anchors`,
          )
          return null
        }
        const cal = makeCalibration(spec.id, best.points)
        if (!cal) {
          console.warn(`[benchmarklist] ${spec.id}: calibration fit failed`)
          return null
        }
        const calibrationLookup = buildScoreLookup([best.snapshotMeta])
        const snapshotLookups = new Map(
          snapshots.map((snap) => [
            `${snap.sampled_at}|${snap.source_key}`,
            {
              sourceKey: snap.source_key,
              unit:
                new Set((snap.results || []).map(scoreUnit).filter(Boolean)).size === 1
                  ? scoreUnit((snap.results || []).find((row) => scoreUnit(row)))
                  : null,
              scores: buildScoreLookup([snap]),
            },
          ]),
        )
        return {
          spec,
          cal,
          best,
          scoreLookup: {
            calibration: calibrationLookup,
            snapshots: snapshotLookups,
            calibrationSnapshotKey: `${best.snapshotMeta?.sampled_at}|${best.snapshotMeta?.source_key}`,
          },
        }
      } catch (err) {
        console.warn(`[benchmarklist] ${spec.id} fetch failed:`, err?.message || err)
        return null
      }
    }),
  )

  for (const result of benchmarkIndexes) {
    if (!result) continue
    const { spec, cal, best, scoreLookup } = result
    calibrations[spec.id] = cal
    benchmarks.push({
      id: spec.id,
      label: spec.label,
      anchors: best.points.length,
      snapshotAt: best.snapshotMeta?.sampled_at,
      rows: best.rows.size,
    })
    scoreLookups[spec.id] = scoreLookup
    console.log(
      `[benchmarklist] ${spec.id}: ${best.points.length} anchors, ${best.rows.size} rows, MAE=${cal.mae?.toFixed(2) ?? 'n/a'}, resolution=${cal.resolution.toFixed(2)}`,
    )
  }

  // Inject vendor self-reported scores into the calibration lookups. These are not
  // benchmarklist measurements; they are the vendor's own published claims, placed on
  // the same scale by the same isotonic calibration. A `selfReported` set per benchmark
  // lets the resolver flag them honestly in the detail string.
  const selfReported = {}
  for (const [modelId, scores] of Object.entries(VENDOR_SELF_REPORTED_SCORES)) {
    // The table is keyed by bare model id; `benchmarklistLookupKeys` already yields every
    // spelling the resolver will try (`agnes-2.5-flash`, `agnes-2-5-flash`, `agnes.2.5.flash`).
    const keys = benchmarklistLookupKeys(modelId)
    for (const [benchId, score] of Object.entries(scores)) {
      const lookup = scoreLookups[benchId]
      if (!lookup?.calibration) continue
      for (const key of keys) {
        if (!lookup.calibration.has(key)) lookup.calibration.set(key, score)
      }
      selfReported[benchId] = selfReported[benchId] || new Set()
      for (const key of keys) selfReported[benchId].add(key)
    }
  }

  let modelIndex = new Map()
  let indexedModelIds = new Set()
  try {
    const indexed = await fetchModelIndexScores(modelIds, indexSnapshots)
    modelIndex = indexed.scores
    indexedModelIds = indexed.modelIds
  } catch (err) {
    console.warn('[benchmarklist] model index unavailable:', err?.message || err)
  }

  return {
    calibrations,
    benchmarks,
    scoreLookups,
    selfReported,
    modelIndex,
    indexedModelIds,
    catalogSize: (catalog || []).length,
    builtAt: Date.now(),
  }
}

/**
 * Resolve a model's intelligence from benchmarklist evidence.
 * Returns { aa, source, detail, isEstimated, contributions } or null if no evidence.
 */
export function resolveBenchmarkListQuality(qualityData, modelId) {
  // A provider can spell a model differently from the benchmark catalog while serving the same
  // weights (`reflection/beam-free` is `reflection/beam-1.0-501b-a23b`), and this function is
  // handed the row id. Resolve the alias first, or the measured twin's index entry is never
  // found and the row stays unscored.
  const resolvedId = resolveAliasedModelId(modelId) || modelId
  const directIndex = qualityData?.modelIndex
  if (directIndex) {
    // The row's own spelling can carry a detail the catalog alias drops — `mistral-large-3:675b`
    // resolves to `…-675b-instruct-2512` — so both spellings offer keys to the index.
    const directKeys = new Set([
      ...exactModelIdentityKeys(resolvedId, false),
      ...exactModelIdentityKeys(modelId, false),
    ])
    const proxyLabel = benchmarklistProxyLabel(modelId)
    for (const key of new Set([
      ...exactModelIdentityKeys(resolvedId),
      ...exactModelIdentityKeys(modelId),
    ])) {
      const entry = directIndex.get(key)
      if (!entry) continue
      const isProxy = entry.isProxy || !directKeys.has(key)
      return {
        aa: entry.aa,
        source: 'benchmarklist-aa-index',
        detail: `Benchmarklist-hosted Artificial Analysis Intelligence Index${entry.sampledAt ? ` (${entry.sampledAt})` : ''}${isProxy && proxyLabel ? ` (proxy model: ${proxyLabel})` : ''}`,
        isEstimated: isProxy,
        contributions: [],
      }
    }
  }
  if (!qualityData?.calibrations || !qualityData?.scoreLookups) return null
  const predictions = []

  for (const [benchId, cal] of Object.entries(qualityData.calibrations)) {
    const lookupBundle = qualityData.scoreLookups[benchId]
    if (!lookupBundle) continue

    // Backward-compat: support both old (Map) and new ({calibration, snapshots, calibrationSnapshotKey}) structures
    const isNewStructure = lookupBundle.calibration != null || lookupBundle.snapshots != null
    const calibrationLookup = isNewStructure ? lookupBundle.calibration : lookupBundle
    const snapshots = isNewStructure ? lookupBundle.snapshots : null
    const calibrationSnapshotKey = isNewStructure ? lookupBundle.calibrationSnapshotKey : null

    let score = null
    let rawScore = null
    let foundInCalibration = false
    let selfReportedScore = false
    let fuzzyKey = null
    for (const key of benchmarklistLookupKeys(modelId)) {
      if (calibrationLookup.has(key)) {
        rawScore = calibrationLookup.get(key)
        score = rawScore
        foundInCalibration = true
        selfReportedScore = qualityData.selfReported?.[benchId]?.has(key) || false
        break
      }
    }
    // No exact spelling on this benchmark: the row may still be the model under a different
    // word order or serving tier (see fuzzyMatchKey). Borrowed evidence is weaker evidence,
    // so the key it came from is carried into the detail rather than hidden.
    if (!foundInCalibration) {
      const candidate = fuzzyMatchKey(modelId, calibrationLookup)
      if (candidate && calibrationLookup.has(candidate.key)) {
        rawScore = calibrationLookup.get(candidate.key)
        score = rawScore
        foundInCalibration = true
        fuzzyKey = candidate.tiered ? `~${candidate.key}` : candidate.key
        selfReportedScore = qualityData.selfReported?.[benchId]?.has(candidate.key) || false
      }
    }
    // Still nothing: the line itself may be rated. `glm-4.6v-flash` is not `glm-4.6v`, so the
    // value is this row's estimate of a different model rather than a spelling it shares —
    // carried into the detail by name (see familyMatchKey) so it can never pass for measured.
    if (!foundInCalibration) {
      const sibling =
        familyMatchKey(modelId, calibrationLookup) ?? nearestReleaseKey(modelId, calibrationLookup)
      if (sibling && calibrationLookup.has(sibling)) {
        rawScore = calibrationLookup.get(sibling)
        score = rawScore
        foundInCalibration = true
        fuzzyKey = `^${sibling}`
        selfReportedScore = qualityData.selfReported?.[benchId]?.has(sibling) || false
      }
    }

    // If not in calibration snapshot, try cross-snapshot normalization
    if (!foundInCalibration && snapshots) {
      const calSnap = calibrationSnapshotKey ? snapshots.get(calibrationSnapshotKey) : null
      const calLookup = calSnap?.scores

      // Only normalize snapshots published by the same source. Different publishers may
      // report the same benchmark on unrelated scales (fractions, percentages, raw counts).
      for (const [snapKey, snapBundle] of snapshots) {
        if (
          snapKey === calibrationSnapshotKey ||
          !calSnap ||
          (snapBundle.sourceKey !== calSnap.sourceKey &&
            !(calSnap.unit && snapBundle.unit === calSnap.unit))
        )
          continue
        const snapLookup = snapBundle.scores
        let snapScore = null
        for (const key of benchmarklistLookupKeys(modelId)) {
          if (snapLookup.has(key)) {
            snapScore = snapLookup.get(key)
            break
          }
        }
        if (snapScore == null) continue

        // Find shared models between this snapshot and calibration snapshot
        const shared = []
        for (const [key, v] of snapLookup) {
          if (calLookup?.has(key)) {
            shared.push([key, v, calLookup.get(key)])
          }
        }
        if (snapBundle.sourceKey !== calSnap.sourceKey) {
          if (snapScore != null) {
            score = snapScore
            rawScore = snapScore
            break
          }
          continue
        }
        if (shared.length < 8) continue

        // Linear fit: calScore = a * snapScore + b
        const n = shared.length
        let sx = 0,
          sy = 0,
          sxy = 0,
          sxx = 0
        for (const [, dv, rv] of shared) {
          sx += dv
          sy += rv
          sxy += dv * rv
          sxx += dv * dv
        }
        const denominator = n * sxx - sx * sx
        if (denominator === 0) continue
        const a = (n * sxy - sx * sy) / denominator
        const b = (sy - a * sx) / n

        // Normalize
        score = a * snapScore + b
        rawScore = snapScore
        break
      }
    }

    if (score != null) {
      const predicted = predictMonotone(score, cal)
      if (predicted != null) {
        predictions.push({
          value: predicted,
          weight: cal.weight,
          source: benchId,
          rawScore: rawScore,
          benchmark: cal.source,
          selfReported: selfReportedScore,
          mae: cal.mae,
          proxyKey: fuzzyKey,
        })
      }
    }
  }
  // A benchmark with no resolution left (every anchor against its ceiling) is weighted to
  // zero by makeCalibration and must not be divided through — its vote can no longer move the
  // number, and it is dropped rather than allowed to flatten the blend.
  const usable = predictions.filter((p) => p.weight > 0)
  if (!usable.length) return null

  // A vendor's own launch table is not an independent measurement. Keep it for coverage, but
  // report a lower-confidence estimate rather than the raw claim: a self-reported coordinate
  // gets one calibration MAE of pessimism. Without this, a vendor's optimistic coding numbers
  // could place a smaller model above an independently measured one (SWE-2 Flash's raw 41.4
  // against DeepSeek V4.1 Flash's measured 39.5).
  const scored = usable.map((p) => {
    if (!p.selfReported) return p
    const mae = Number.isFinite(p.mae) ? p.mae : DEFAULT_CALIBRATION_MAE
    return { ...p, value: Math.max(0, p.value - mae), rawValue: p.value, mae }
  })

  // Combine in inverse-error proportion (same as model-quality.js combinePredictions)
  const total = scored.reduce((sum, p) => sum + p.weight, 0)
  const value = scored.reduce((sum, p) => sum + p.value * p.weight, 0) / total
  const strongest = scored.reduce((best, p) => (p.weight > best.weight ? p : best))

  const proxyLabel = benchmarklistProxyLabel(modelId)
  const matchedKeys = [...new Set(scored.map((p) => p.proxyKey).filter(Boolean))]
  // `~key` marks a match that needed a serving tier dropped (a different offering of the same
  // weights), `^key` a donor from the same line (a different model), a bare key a plain
  // re-spelling of the name.
  const matchedNote = matchedKeys.length
    ? ` (matched catalog spelling: ${matchedKeys
        .slice(0, 2)
        .map((key) =>
          key.startsWith('~')
            ? `${key.slice(1)} — different serving tier`
            : key.startsWith('^')
              ? `${key.slice(1)} — family estimate, a different model`
              : key,
        )
        .join(', ')})`
    : ''
  const allSelfReported = scored.every((p) => p.selfReported)
  const someSelfReported = scored.some((p) => p.selfReported)
  const selfReportedNote = allSelfReported
    ? ' (vendor self-reported; lower-confidence estimate)'
    : someSelfReported
      ? ' (includes vendor self-reported; lower-confidence for those)'
      : ''
  return {
    aa: Math.round(value * 10) / 10,
    source: scored.length > 1 ? 'combined-estimate' : strongest.source,
    detail: `estimated from ${scored.map((p) => p.source).join(' + ')} (${scored.map((p) => `${p.source}→${p.value.toFixed(1)}`).join(', ')})${selfReportedNote}${matchedNote}${proxyLabel ? ` (proxy model: ${proxyLabel})` : ''}`,
    isEstimated: true,
    contributions: scored,
  }
}

/**
 * Fetch and build the index, cached for a day.
 */
export async function fetchBenchmarkListQualityIndex(
  catalog,
  { fetchImpl, force = false, modelIds = [], cache = null } = {},
) {
  const requestedIds = new Set((modelIds || []).map(normalizedModelIdentity).filter(Boolean))
  const needsAdditionalModels = [...requestedIds].some((id) => !cachedModelIds.has(id))
  if (!force && cachedQuality && Date.now() - cachedAt < CACHE_MS && !needsAdditionalModels)
    return cachedQuality

  const quality = await buildBenchmarkListQualityIndex(catalog, { fetchImpl, modelIds, cache })
  if (Object.keys(quality.calibrations).length) {
    cachedQuality = quality
    cachedAt = Date.now()
    cachedModelIds = new Set(
      [...quality.indexedModelIds].map(normalizedModelIdentity).filter(Boolean),
    )
  }
  return quality
}
