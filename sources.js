/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 */

import { scores } from './scores.js'
import { lazyProviderSourceEntries } from './lib/providers/resolutions.js'

export const MODEL_ID_ALIASES = {
  'cogito-2.1:671b': 'cogito-2.1:671b',
  'deepseek-v3.1:671b': 'deepseek-ai/deepseek-v3.1',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'devstral-2:123b': 'devstral-2-123b-instruct-2512',
  'mimo-v2-omni-free': 'xiaomi/mimo-v2-omni:free',
  'devstral-small-2': 'devstral-small-2-24b',
  'devstral-small-2:24b': 'devstral-small-2-24b',
  'devstral-small-2:24b-instruct-2512-q4_k_m': 'devstral-small-2-24b',
  'gemma4:26b': 'google/gemma-4-26b-a4b-it',
  'gemma4:31b': 'google/gemma-4-31b-it',
  'gemma3:4b': 'gemma-3-4b-it',
  'gemma3:12b': 'gemma-3-12b-it',
  'gemma3:27b': 'gemma-3-27b-it',
  'glm-4.7': 'z-ai/glm4.7',
  'zai-glm-4.7': 'z-ai/glm4.7',
  'glm-4.6': 'glm-4.6',
  'glm-5': 'z-ai/glm5',
  'glm-5.2': 'z-ai/glm-5.2',
  'glm-5.3': 'z-ai/glm-5.3',
  // Provider gateways commonly normalize Claude's dotted version to hyphens
  // (e.g. anthropic/claude-sonnet-4-5). Keep those wire ids mapped to the
  // curated 4.5 benchmark entries rather than treating them as unknown models.
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'anthropic/claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'anthropic/claude-haiku-4-5': 'claude-haiku-4.5',
  // g4f backends serve the GLM 5.3 Flash family under their own repo spelling;
  // it is the same model the empero/nvidia catalogs list as glm-5.3-flash.
  'zai-z/zai-org-glm-5-3-flash': 'glm-5.3-flash',
  'zai-org/glm-5.3-flash': 'glm-5.3-flash',
  // The Grok 4 Fast family reaches Hammer through g4f under backend-specific
  // repo spellings (xai-z/..., tb/...) and with hyphenated version numbers.
  // Everything below maps onto the curated grok-4-fast / grok-4.1-fast entries.
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
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
  'kimi-k2-thinking': 'moonshotai/kimi-k2-thinking',
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k2.7-code': 'moonshotai/kimi-k2.7-code',
  'kimi-k2:1t': 'moonshotai/kimi-k2-instruct',
  'deepseek-v4-flash-free': 'deepseek-v4-flash',
  'deepseek-v4-flash:0731': 'deepseek/deepseek-v4-flash-0731',
  'inclusionai/ling-3.0-flash:free': 'inclusionai/ling-3.0-flash',
  'kimi-k3': 'moonshotai/kimi-k3',
  'laguna-s-2.1-free': 'poolside/laguna-s-2.1',
  'ling-3.0-flash-free': 'inclusionai/ling-3.0-flash',
  // OpenCode Zen's fin variant of the same InclusionAI model.
  'ling-3.0-flash-fin-free': 'inclusionai/ling-3.0-flash',
  'poolside/laguna-s-2.1:free': 'poolside/laguna-s-2.1',
  'hy3-free': 'tencent/hy3',
  'inclusionai/ring-2.6-1t:free': 'inclusionai/ring-2.6-1t',
  'inclusionai/ling-2.6-flash:free': 'inclusionai/ling-2.6-flash',
  'ling-2.6-flash-free': 'inclusionai/ling-2.6-flash',
  'ring-2.6-1t-free': 'inclusionai/ring-2.6-1t',
  'mimo-v2-flash-free': 'mimo-v2-flash-free',
  'mimo-v2-pro-free': 'xiaomi/mimo-v2-pro',
  'mimo-v2.5-free': 'xiaomi/mimo-v2.5',
  'qwen3:4b': 'qwen/qwen3-4b',
  'qwen3:32b': 'qwen/qwen3-32b',
  'gpt-oss:120b': 'openai/gpt-oss-120b',
  'gpt-oss:20b': 'openai/gpt-oss-20b',
  'minimax-m2': 'minimaxai/minimax-m2',
  'minimax-m2.1': 'minimaxai/minimax-m2.1',
  'minimax-m2.5': 'minimax/minimax-m2.5',
  'minimax-m2.5-free': 'minimax/minimax-m2.5',
  'minimax-m2.7:cloud': 'minimax-m2.7',
  'minimax-m2.7': 'minimax-m2.7',
  'minimax-m3': 'minimaxai/minimax-m3',
  'ministral-3:3b': 'ministral-3:3b',
  'ministral-3:8b': 'ministral-3:8b',
  'ministral-3:14b': 'mistralai/ministral-14b-instruct-2512',
  'mistral-large-3:675b': 'mistralai/mistral-large-3-675b-instruct-2512',
  'nemotron-3-nano:30b': 'nvidia/nemotron-3-nano-30b-a3b',
  'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3-super-free': 'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3-ultra-free': 'nvidia/nemotron-3-ultra-550b-a55b',
  'nemotron-3-ultra': 'nvidia/nemotron-3-ultra-550b-a55b',
  'nemotron-3.5-lightning-free': 'nvidia/nemotron-3.5-lightning',
  'north-mini-code-free': 'cohere/north-mini-code',
  'qwen3.6-plus-free': 'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.6-plus-preview:free': 'qwen/qwen3.5-397b-a17b',
  'qwen3-vl:235b': 'qwen/qwen3-vl-235b-a22b',
  'qwen3-vl:235b-instruct': 'qwen/qwen3-vl-235b-a22b',
  'qwen3-coder-next': 'qwen3-coder-next',
  'qwen3-coder:480b': 'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen3-next:80b': 'qwen/qwen3-next-80b-a3b-instruct',
  'qwen3.5:397b': 'qwen/qwen3.5-397b-a17b',
  'rnj-1:8b': 'rnj-1:8b',
  // GitHub Copilot advertises a hyphenated spelling for a few families whose
  // scored/curated entries use the dotted version.
  'grok-4-5': 'grok-4.5',
  'claude-sonnet-5-0': 'claude-sonnet-5',
  'stepfun/step-3.7-flash:free': 'stepfun-ai/step-3.7-flash',
  'trinity-large-preview-free': 'arcee-ai/trinity-large-preview',
}

export const MODEL_LABEL_OVERRIDES = {
  'deepseek-v3.1:671b': 'DeepSeek V3.1',
  'deepseek-v3.2': 'DeepSeek V3.2',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'devstral-2:123b': 'Devstral 2 123B',
  'devstral-small-2': 'Devstral Small 2 24B',
  'devstral-small-2:24b': 'Devstral Small 2 24B',
  'devstral-small-2-24b': 'Devstral Small 2 24B',
  'arcee-ai/trinity-large-thinking': 'Trinity Large Thinking',
  'arcee-ai/trinity-large-thinking:free': 'Trinity Large Thinking',
  'bytedance-seed/dola-seed-2.0-pro': 'Dola Seed 2.0 Pro',
  'bytedance-seed/dola-seed-2.0-pro:free': 'Dola Seed 2.0 Pro',
  'gemma4:26b': 'Gemma 4 26B A4B',
  'gemma4:31b': 'Gemma 4 31B',
  'google/gemma-4-26b-a4b-it': 'Gemma 4 26B A4B',
  'google/gemma-4-31b-it': 'Gemma 4 31B',
  'gemma3:4b': 'Gemma 3 4B',
  'gemma3:12b': 'Gemma 3 12B',
  'gemma3:27b': 'Gemma 3 27B',
  'glm-4.6': 'GLM 4.6',
  'glm-4.7': 'GLM 4.7',
  'glm-5': 'GLM 5',
  'glm-5.1': 'GLM 5.1',
  'glm-5.2': 'GLM 5.2',
  'z-ai/glm-5.3': 'GLM 5.3',
  'glm-5.3-flash': 'GLM 5.3 Flash',
  'gpt-4.1': 'GPT 4.1',
  'gpt-5.1-codex': 'GPT 5.1 Codex',
  'gpt-5.1-codex-max': 'GPT 5.1 Codex Max',
  'gpt-5.1-codex-mini': 'GPT 5.1 Codex Mini',
  'gpt-5.5': 'GPT 5.5',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'grok-4.5': 'Grok 4.5',
  'grok-code-fast-1': 'Grok Code Fast',
  'hy3-free': 'Hy3',
  'kimi-k2': 'Kimi K2',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k3': 'Kimi K3',
  'moonshotai/kimi-k3': 'Kimi K3',
  'moonshotai/kimi-k2.6': 'Kimi K2.6',
  'kimi-k2:1t': 'Kimi K2 Instruct',
  'inclusionai/ling-2.6-flash': 'Ling 2.6 Flash',
  'inclusionai/ling-2.6-flash:free': 'Ling 2.6 Flash',
  'ling-2.6-flash-free': 'Ling 2.6 Flash',
  'inclusionai/ling-3.0-flash': 'Ling 3.0 Flash',
  'ling-3.0-flash-free': 'Ling 3.0 Flash',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'poolside/laguna-s-2.1': 'Laguna S 2.1',
  'laguna-s-2.1-free': 'Laguna S 2.1',
  'mimo-v2-flash-free': 'MiMo V2 Flash',
  'mimo-v2-pro-free': 'MiMo V2 Omni Pro',
  'mimo-v2-omni-free': 'MiMo V2 Omni',
  'mimo-v2.5-free': 'MiMo V2.5',
  'minimax-m2.5-free': 'MiniMax M2.5',
  'minimax-m3': 'MiniMax M3',
  'ministral-3:3b': 'Ministral 3 3B',
  'ministral-3:8b': 'Ministral 3 8B',
  'ministral-3:14b': 'Ministral 14B',
  'mistral-large-3:675b': 'Mistral Large 675B',
  'nemotron-3-nano:30b': 'Nemotron Nano 30B',
  'nemotron-3-super': 'Nemotron 3 Super',
  'nemotron-3-super-free': 'Nemotron 3 Super',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3-ultra': 'Nemotron 3 Ultra',
  'north-mini-code-free': 'North Mini Code',
  'qwen3.6-plus-free': 'Qwen3.6 Plus',
  'qwen/qwen3.6-plus-preview:free': 'Qwen3.6 Plus Preview',
  'qwen3-vl:235b': 'Qwen3 VL 235B',
  'qwen3-vl:235b-instruct': 'Qwen3 VL 235B',
  'qwen3-coder-next': 'Qwen3 Coder Next',
  'qwen3-coder:480b': 'Qwen3 Coder 480B',
  'qwen3-next:80b': 'Qwen3 Next 80B',
  'qwen3.5:397b': 'Qwen3.5 400B',
  'rnj-1:8b': 'RNJ-1 8B',
  'stepfun/step-3.7-flash:free': 'Step 3.7 Flash',
  'trinity-large-preview-free': 'Trinity Large Preview',
  'xiaomi/mimo-v2-omni:free': 'MiMo V2 Omni',
  'xiaomi/mimo-v2-pro:free': 'MiMo V2 Omni Pro',
  'x-ai/grok-code-fast-1:optimized:free': 'Grok Code Fast',
}

export const MODEL_CONTEXT_OVERRIDES = {
  'cohere/north-mini-code': '256k',
  'hy3-free': '262k',
  'kimi-k2.7-code': '262k',
  'inclusionai/ling-2.6-flash': '262k',
  'kimi-k2.6': '262k',
  'ling-2.6-flash-free': '262k',
  'moonshotai/kimi-k2.6': '262k',
  'mimo-v2.5-free': '1M',
  'minimax-m3': '1M',
  'nemotron-3-ultra': '1M',
  'nemotron-3-ultra-free': '1M',
  'north-mini-code-free': '256k',
  'tencent/hy3': '262k',
}

/**
 * The per-server routing namespace g4f discovery prefixes catalog ids with
 * ("srv_ab12:vendor/model"). It selects which backend serves the row but carries
 * no model identity, so alias resolution, scores, labels, and dashboard grouping
 * all see through it. The full id is still what goes upstream when routing.
 */
export function stripRoutingNamespace(modelId) {
  return String(modelId || '').replace(/^srv_[a-z0-9]+:/i, '')
}

/**
 * Returns whether a model name is a provider alias for its current/latest
 * iteration. This matches a delimited token, so names such as "latestcoder"
 * are not accidentally treated as aliases.
 */
export function isLatestModelName(modelId) {
  return /(?:^|[-_:/\s])latest(?:$|[-_:/\s])/i.test(String(modelId || ''))
}

/**
 * Produces a version-independent family key for matching a `*-latest` model to
 * a concrete version. Provider namespaces, runtime suffixes, version numbers,
 * and the latest marker are ignored; the remaining words identify the family.
 *
 * Examples:
 *   gemini-flash-latest -> gemini flash
 *   gemini-3.8-flash    -> gemini flash
 *   claude-3-7-sonnet-latest -> claude sonnet
 */
export function getLatestModelFamilyKey(modelId) {
  let value = stripRoutingNamespace(String(modelId || '').trim().toLowerCase())
  if (!value) return ''
  value = value.replace(/^models\//, '')
  value = value.replace(/^[^/]+\//, '')
  value = value.replace(/(?::(?:free|optimized|cloud))+$/i, '')
  value = value.replace(/\b(?:latest|current|default)\b/g, ' ')
  value = value.replace(/\b\d+(?:\.\d+)+\b/g, ' ')
  value = value.replace(/\b\d+\b/g, ' ')
  return value.replace(/[-_:\/.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Returns numeric version components used to select the newest concrete family member. */
export function getModelVersionTuple(modelId) {
  const value = stripRoutingNamespace(String(modelId || '').toLowerCase())
  const matches = value.match(/\d+(?:\.\d+)+|\d+/g) || []
  return matches.flatMap(part => part.split('.').map(Number)).filter(Number.isFinite)
}

/**
 * Normalized model name used for identity comparisons: routing namespaces
 * ("srv_ab12:"), vendor prefixes ("qwen/"), runtime tags (":free") and every
 * separator spelling are folded away, so one model advertised under several id
 * spellings compares equal. Version digits are preserved (3.5 != 3.8).
 */
function normalizedModelIdentityName(modelId) {
  let value = stripRoutingNamespace(resolveAliasedModelId(modelId)).toLowerCase()
  if (!value) return ''
  value = value.replace(/^models\//, '')
  const segments = value.split('/')
  value = segments[segments.length - 1]
  value = value.replace(/(?::(?:free|optimized|cloud))+$/i, '')
  return value.replace(/[-_:./\s]+/g, ' ').trim()
}

/**
 * Separator-insensitive identity key for grouping dashboard/API rows: the same
 * model reached through different provider spellings collapses to one key.
 *
 * Examples:
 *   qwen/qwen3.8-27b              -> qwen3827b
 *   qwen-3.8-27b                  -> qwen3827b
 *   srv_ab12:@cf/qwen/qwen3.8-27b -> qwen3827b
 *   qwen/qwen3.6-27b              -> qwen3627b  (a different model)
 */
export function getModelIdentityKey(modelId) {
  return normalizedModelIdentityName(modelId).replace(/\s+/g, '')
}

/**
 * True for tokens that only describe a model's size or quantization ("120b",
 * "a12b", "30b", "8x22b", "q4_k_m", "gguf") — never for meaningful variants
 * such as "lite", "omni", "instruct" or "reasoning".
 */
export function isModelSizeToken(token) {
  return /^(?:a\d+b|\d+(?:\.\d+)?x\d+[bemt]|\d+[bemt]|q\d+(?:[_-][a-z0-9]+)*|fp\d+|int\d+|bf16|awq|gptq|gguf)$/i.test(String(token || ''))
}

/**
 * Whether two model ids name the same model: an exact identity-key match or a
 * size-qualified alias of it. This is what merges "nemotron-3-super" with
 * "nvidia/nemotron-3-super-120b-a12b" and g4f's "...-30b" variants, while
 * keeping genuinely different siblings apart — two sizes of one instruct
 * family, "flash" vs "flash-lite", or "nano" vs "nano-omni".
 */
export function isSameModelIdentity(a, b) {
  const keyA = getModelIdentityKey(a)
  const keyB = getModelIdentityKey(b)
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  const nameA = normalizedModelIdentityName(a).split(' ').filter(Boolean)
  const nameB = normalizedModelIdentityName(b).split(' ').filter(Boolean)
  if (!nameA.length || !nameB.length) return false
  const [shortTokens, longTokens] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA]
  if (shortTokens.length === longTokens.length) return false
  for (let i = 0; i < shortTokens.length; i++) {
    if (shortTokens[i] !== longTokens[i]) return false
  }
  // A bare number only ever trails a g4f duplicate marker ("...-30b - 1"), and
  // must not be read as a version — so it is ignorable only after a named token.
  if (/^\d+$/.test(shortTokens[shortTokens.length - 1])) return false
  const extra = longTokens.slice(shortTokens.length)
  return extra.every((token, index) => isModelSizeToken(token) || (index === extra.length - 1 && /^\d{1,2}$/.test(token)))
}

export function resolveAliasedModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : ''
  if (!raw) return ''
  if (MODEL_ID_ALIASES[raw]) return MODEL_ID_ALIASES[raw]
  const lower = raw.toLowerCase()
  if (MODEL_ID_ALIASES[lower]) return MODEL_ID_ALIASES[lower]
  // A namespaced id resolves to its model part, which may itself be aliased.
  const stripped = stripRoutingNamespace(raw)
  if (stripped !== raw) return resolveAliasedModelId(stripped)
  return raw
}

export function cleanModelDisplayLabel(label) {
  if (typeof label !== 'string') return ''
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+\(free\)\s*$/i, '')
    .replace(/\s+free\s*$/i, '')
    .trim()
}

export function canonicalizeModelId(modelId) {
  const resolved = resolveAliasedModelId(modelId)
  // 1. Remove known runtime suffixes like :free, :optimized:free, or :cloud
  const base = resolved.replace(/(?::(?:free|optimized|cloud))+$/i, '');
  // 2. Remove provider prefix like google/
  const unprefixed = base.includes('/') ? base.split('/').pop() : base;
  return { base, unprefixed };
}

export function getPreferredModelLabel(modelId, fallback = null) {
  const resolved = resolveAliasedModelId(modelId)
  const override = MODEL_LABEL_OVERRIDES[modelId] || MODEL_LABEL_OVERRIDES[resolved]
  if (override) return override
  const cleanedFallback = cleanModelDisplayLabel(fallback)
  return cleanedFallback || fallback
}

export function getPreferredModelContext(modelId, fallback = null) {
  const resolved = resolveAliasedModelId(modelId)
  return MODEL_CONTEXT_OVERRIDES[modelId] || MODEL_CONTEXT_OVERRIDES[resolved] || fallback
}

export function getScore(modelId) {
  const { base, unprefixed } = canonicalizeModelId(modelId);
  // Try exact match first (e.g. google/gemma-3-4b-it), then fallback to unprefixed (e.g. gemma-3-4b-it)
  return scores[base] ?? scores[unprefixed] ?? null;
}

export const sources = {
  // ── Imported providers (OmniRoute free tier) ────────────────────────────────
  // Rows whose endpoint, wire format and credential shape were all resolved to plain
  // OpenAI-compatible + bearer, so they need nothing provider-specific and can ride the
  // generic path with no per-provider code. Distinct from the hand-configured providers
  // below in two ways that matter:
  //
  //   • They carry `lazyDiscovery: true`. The startup probe wave in lib/server.js skips
  //     that flag, so importing ~40 providers does not become ~40 network probes on every
  //     boot — which would undo the deliberate removal of background polling. They are
  //     discovered when something asks for them (a provider refresh, or a request that
  //     needs their model list).
  //   • They carry no model rows. A list invented here would be stale the moment the
  //     provider rotated its roster; discovery supplies what is actually served.
  //
  // Spread FIRST so hammer's own providers below win any key collision (nvidia, groq,
  // openrouter, scaleway, kiro, opencode). See lib/providers/resolutions.js for
  // which imports are active and why the rest are not.
  ...lazyProviderSourceEntries(),
  "nvidia": {
    "name": "NIM",
    "url": "https://integrate.api.nvidia.com/v1/chat/completions",
    "contextUrl": "https://build.nvidia.com/models",
    "discoverable": true,
    "models": [
      ["z-ai/glm-5.2", "GLM 5.2", "200k"],
      ["moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", "262k"],
      ["minimaxai/minimax-m3", "MiniMax M3", "1M"],
      ["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", "1M"],
      ["stepfun-ai/step-3.7-flash", "Step 3.7 Flash", "262k"],
      ["deepseek-ai/deepseek-v3.2", "DeepSeek V3.2", "128k"],
      ["moonshotai/kimi-k2.5", "Kimi K2.5", "128k"],
      ["z-ai/glm5", "GLM 5", "128k"],
      ["z-ai/glm4.7", "GLM 4.7", "200k"],
      ["moonshotai/kimi-k2-thinking", "Kimi K2 Thinking", "256k"],
      ["minimaxai/minimax-m2.1", "MiniMax M2.1", "200k"],
      ["stepfun-ai/step-3.5-flash", "Step 3.5 Flash", "256k"],
      ["qwen/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", "256k"],
      ["qwen/qwen3-235b-a22b", "Qwen3 235B", "128k"],
      ["mistralai/devstral-2-123b-instruct-2512", "Devstral 2 123B", "256k"],
      ["deepseek-ai/deepseek-v3.1-terminus", "DeepSeek V3.1 Terminus", "128k"],
      ["moonshotai/kimi-k2-instruct", "Kimi K2 Instruct", "128k"],
      ["minimaxai/minimax-m2", "MiniMax M2", "128k"],
      ["qwen/qwen3-next-80b-a3b-thinking", "Qwen3 80B Thinking", "128k"],
      ["qwen/qwen3-next-80b-a3b-instruct", "Qwen3 80B Instruct", "128k"],
      ["qwen/qwen3.5-397b-a17b", "Qwen3.5 400B", "128k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["meta/llama-4-maverick-17b-128e-instruct", "Llama 4 Maverick", "1M"],
      ["deepseek-ai/deepseek-v3.1", "DeepSeek V3.1", "128k"],
      ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", "128k"],
      ["mistralai/mistral-large-3-675b-instruct-2512", "Mistral Large 675B", "256k"],
      ["qwen/qwq-32b", "QwQ 32B", "131k"],
      ["igenius/colosseum_355b_instruct_16k", "Colosseum 355B", "16k"],
      ["mistralai/mistral-medium-3-instruct", "Mistral Medium 3", "128k"],
      ["mistralai/magistral-small-2506", "Magistral Small", "32k"],
      ["nvidia/llama-3.3-nemotron-super-49b-v1.5", "Nemotron Super 49B", "128k"],
      ["meta/llama-4-scout-17b-16e-instruct", "Llama 4 Scout", "10M"],
      ["nvidia/nemotron-3-nano-30b-a3b", "Nemotron Nano 30B", "128k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-32b", "R1 Distill 32B", "128k"],
      ["openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["qwen/qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B", "32k"],
      ["meta/llama-3.1-405b-instruct", "Llama 3.1 405B", "128k"],
      ["meta/llama-3.3-70b-instruct", "Llama 3.3 70B", "128k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-14b", "R1 Distill 14B", "64k"],
      ["bytedance/seed-oss-36b-instruct", "Seed OSS 36B", "32k"],
      ["stockmark/stockmark-2-100b-instruct", "Stockmark 100B", "32k"],
      ["mistralai/mixtral-8x22b-instruct-v0.1", "Mixtral 8x22B", "64k"],
      ["mistralai/ministral-14b-instruct-2512", "Ministral 14B", "32k"],
      ["ibm/granite-34b-code-instruct", "Granite 34B Code", "32k"],
      ["deepseek-ai/deepseek-r1-distill-llama-8b", "R1 Distill 8B", "32k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-7b", "R1 Distill 7B", "32k"],
      ["google/gemma-2-9b-it", "Gemma 2 9B", "8k"],
      ["microsoft/phi-3.5-mini-instruct", "Phi 3.5 Mini", "128k"],
      ["microsoft/phi-4-mini-instruct", "Phi 4 Mini", "128k"]
    ]
  },
  "groq": {
    "name": "Groq",
    "url": "https://api.groq.com/openai/v1/chat/completions",
    "contextUrl": "https://console.groq.com/docs/models",
    "discoverable": true,
    "models": [
      ["llama-3.3-70b-versatile", "Llama 3.3 70B", "128k"],
      ["meta-llama/llama-4-scout-17b-16e-preview", "Llama 4 Scout", "128k"],
      ["meta-llama/llama-4-maverick-17b-128e-preview", "Llama 4 Maverick", "128k"],
      ["deepseek-r1-distill-llama-70b", "R1 Distill 70B", "128k"],
      ["qwen-qwq-32b", "QwQ 32B", "131k"],
      ["moonshotai/kimi-k2-instruct", "Kimi K2 Instruct", "131k"],
      ["llama-3.1-8b-instant", "Llama 3.1 8B", "128k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["qwen/qwen3-32b", "Qwen3 32B", "131k"]
    ]
  },
  "opencode": {
    "name": "OpenCode Zen",
    "url": "https://opencode.ai/zen/v1/chat/completions",
    "models": []
  },
  "empero": {
    "name": "Empero Free",
    "url": "https://free.empero.org/v1/chat/completions",
    "contextUrl": "https://free.empero.org/",
    "discoverable": true,
    "models": [
      ["glm-5.3-flash", "GLM 5.3 Flash", "128k"],
      ["qwen3.8-flash", "Qwen3.8 Flash", "128k"]
    ]
  },
  "openai-compatible": {
    "name": "OpenAI-Compatible",
    "url": "",
    "models": []
  },
  "devin": {
    "name": "Devin SWE",
    "url": "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
    "contextUrl": "https://devin.ai/",
    "models": [
      ["swe-1.6", "Devin SWE 1.6", "128k", "curated", "https://devin.ai/"],
      ["swe-1.5", "Devin SWE 1.5", "128k", "curated", "https://devin.ai/"]
    ]
  },
  "ollama": {
    "name": "Ollama",
    "url": "",
    "models": []
  },
  "openrouter": {
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "contextUrl": "https://openrouter.ai/api/v1/models",
    "models": [
      ["qwen/qwen3-coder:free", "Qwen3 Coder", "256k"],
      ["xiaomi/mimo-v2-pro:free", "MiMo V2 Omni Pro", "1M"],
      ["xiaomi/mimo-v2-omni:free", "MiMo V2 Omni", "1M"],
      ["stepfun/step-3.5-flash:free", "Step 3.5 Flash", "256k"],
      ["deepseek/deepseek-r1-0528:free", "DeepSeek R1 0528", "128k"],
      ["qwen/qwen3-next-80b-a3b-instruct:free", "Qwen3 80B Instruct", "128k"],
      ["openai/gpt-oss-120b:free", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b:free", "GPT OSS 20B", "131072"],
      ["nvidia/nemotron-3-nano-30b-a3b:free", "Nemotron Nano 30B", "256k"],
      ["meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B", "128k"],
      ["minimax/minimax-m2.5:free", "MiniMax M2.5", "128k"],
      ["corethink:free", "CoreThink", "128k"],
      ["giga-potato-thinking:free", "Giga Potato Thinking", "128k"]
    ]
  },
  "codestral": {
    "name": "Codestral",
    // No public /v1/models endpoint exists on codestral.mistral.ai (verified: 404
    // / no route); the list below is the complete static catalog. Kept manual.
    "url": "https://codestral.mistral.ai/v1/chat/completions",
    "contextUrl": "https://docs.mistral.ai/getting-started/models/models_overview/",
    "models": [
      ["codestral-latest", "Codestral", "256k"]
    ]
  },
  "scaleway": {
    "name": "Scaleway",
    "url": "https://api.scaleway.ai/v1/chat/completions",
    "contextUrl": "https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/",
    "discoverable": true,
    "models": [
      ["devstral-2-123b-instruct-2512", "Devstral 2 123B", "200k"],
      ["qwen3-235b-a22b-instruct-2507", "Qwen3 235B", "250k"],
      ["gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["qwen3-coder-30b-a3b-instruct", "Qwen3 Coder 30B", "128k"],
      ["llama-3.3-70b-instruct", "Llama 3.3 70B", "100k"],
      ["deepseek-r1-distill-llama-70b", "R1 Distill 70B", "16k"],
      ["mistral-small-3.2-24b-instruct-2506", "Mistral Small 3.2", "128k"]
    ]
  },
  "kilocode": {
    "name": "KiloCode",
    "url": "https://api.kilo.ai/api/gateway/chat/completions",
    "contextUrl": "https://api.kilo.ai/api/gateway/models",
    "models": [
      ["arcee-ai/trinity-large-preview", "Trinity Large", "128k"]
    ]
  },
  "kiro": {
    "name": "Kiro",
    // Proprietary EventStream API (no /v1/models surface) — the catalog below is
    // the complete static list. Kept manual.
    "url": "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    "contextUrl": "https://kiro.dev/docs/cli/reference/models/",
    "models": [
      ["claude-sonnet-4.5", "Claude Sonnet 4.5", "200k"],
      ["claude-haiku-4.5", "Claude Haiku 4.5", "200k"]
    ]
  },
  "googleai": {
    "name": "Google AI",
    "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "contextUrl": "https://ai.google.dev/gemma/docs/core/model_card_3",
    "discoverable": true,
    "models": [
      ["gemma-3-27b-it", "Gemma 3 27B", "128k"],
      ["gemma-3-12b-it", "Gemma 3 12B", "128k"],
      ["gemma-3-4b-it", "Gemma 3 4B", "128k"]
    ]
  },
  // --- GitHub Copilot ---------------------------------------------------------
  // Copilot is OpenAI-compatible on the wire (api.githubcopilot.com/chat/completions)
  // but has no API keys: it authenticates with a GitHub OAuth token obtained from
  // the device flow, carried as a bearer plus Copilot client-identity headers, and
  // it charges against the account's plan-based premium-request quota. The catalog
  // below is only the pre-sign-in fallback; once a token is configured the live
  // /models endpoint replaces it and reports real context limits.
  // Identity + endpoint behavior mirrors oh-my-pi's github-copilot provider.
  // Deliberately NOT flagged `discoverable`: that path assumes an OpenAI-style
  // /v1/models probe, while Copilot serves /models at the host root behind its
  // own client-identity headers. lib/server.js refreshes it through the
  // Copilot-specific path instead.
  "github-copilot": {
    "name": "GitHub Copilot",
    "url": "https://api.githubcopilot.com/chat/completions",
    "contextUrl": "https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements",
    "models": [
      ["gpt-5.5", "GPT 5.5", "400k"],
      ["gpt-5.1-codex", "GPT 5.1 Codex", "400k"],
      ["gpt-5.1-codex-max", "GPT 5.1 Codex Max", "400k"],
      ["gpt-5.1-codex-mini", "GPT 5.1 Codex Mini", "400k"],
      ["gpt-4.1", "GPT 4.1", "128k"],
      ["claude-sonnet-5", "Claude Sonnet 5", "200k"],
      ["claude-sonnet-4.5", "Claude Sonnet 4.5", "200k"],
      ["claude-haiku-4.5", "Claude Haiku 4.5", "200k"],
      ["gemini-3.1-pro-preview", "Gemini 3.1 Pro", "1M"],
      ["gemini-3-flash-preview", "Gemini 3 Flash", "1M"],
      ["grok-4.5", "Grok 4.5", "256k"],
      ["grok-code-fast-1", "Grok Code Fast", "256k"]
    ]
  },
  // --- OpenAI Codex --------------------------------------------------------
  // The ChatGPT subscription surface. It is *not* OpenAI-compatible: calls go to
  // the Responses API (/codex/responses), authenticate with a short-lived ChatGPT
  // OAuth access token plus a `chatgpt-account-id` workspace header, and always
  // stream SSE. lib/openai-codex.js owns the translation in both directions and
  // lib/server.js exchanges the stored refresh token for an access token on demand.
  // The catalog below is only the pre-sign-in fallback; once an account is signed
  // in the account's own /codex/models list replaces it. Deliberately NOT flagged
  // `discoverable`: that path assumes an OpenAI-style /v1/models probe, while Codex
  // serves its own model list from the account-authenticated backend.
  "openai-codex": {
    "name": "OpenAI Codex",
    "url": "https://chatgpt.com/backend-api/codex/responses",
    "contextUrl": "https://developers.openai.com/codex/",
    "models": [
      ["gpt-5.1-codex", "GPT 5.1 Codex", "400k"],
      ["gpt-5.1-codex-max", "GPT 5.1 Codex Max", "400k"],
      ["gpt-5.1-codex-mini", "GPT 5.1 Codex Mini", "400k"],
      ["gpt-5-codex", "GPT 5 Codex", "400k"],
      ["codex-mini-latest", "Codex Mini", "192k"]
    ]
  },
  "freemodels": {
    "name": "FreeModels",
    "url": "https://freemodels-chat.freemodels.workers.dev",
    "contextUrl": "https://freemodels.pro",
    "models": [
      ["claude-sonnet-5", "Claude Sonnet 5", "200k"],
      ["claude-fable-5", "Claude Fable 5", "200k"],
      ["claude-fable-5.1", "Claude Fable 5.1", "200k"],
      ["sol", "GPT 5.6 Sol", "128k"],
      ["terra", "GPT 5.6 Terra", "128k"],
      ["glm-5.2", "GLM 5.2", "200k"],
      ["kimi-k3", "Kimi K3", "256k"]
    ]
  },
  // --- gpt4free (g4f) --------------------------------------------------------
  // One provider for the whole gpt4free service. g4f.space/v1 is the hosted
  // gateway (many models, discovered from /models). Anonymous traffic is gated
  // behind baked proof-of-work credits, so hammer requires the free account key
  // from https://g4f.dev/members.html — set it once as `apiKeys.g4f` or
  // `G4F_API_KEY` and it covers the whole gateway.
  // Docs: https://g4f.dev/docs/ready_to_use.html
  "g4f": {
    "name": "G4F",
    "url": "https://g4f.space/v1/chat/completions",
    "contextUrl": "https://g4f.dev/members.html",
    "discoverable": true,
    "models": [
      ["auto", "Auto (G4F)", "128k"]
    ]
  },
  // --- gptfree.com -----------------------------------------------------------
  // A consumer chat site, not a platform: no published API, no keys, no /v1
  // surface. Its web app signs in anonymously against the project's own Firebase
  // instance and posts one message to a single Cloud Function, which is what
  // hammer does too (see the token mint and the request/response conversion in
  // lib/server.js). Two facts about that exchange are baked into the catalog
  // below rather than papered over.
  //
  // There is no model parameter: the endpoint takes {message, images, history}
  // and picks the backend itself, so this provider can only ever be one row, and
  // that row names what it is — an auto route, not a model. Its context window is
  // therefore unknown and is left unstated: a number here would rank it in the
  // min_ctx filter on no evidence at all.
  //
  // Deliberately NOT `discoverable` — there is no model list to discover from.
  "gptfree": {
    "name": "GPTFree",
    "url": "https://us-central1-gptfree-2.cloudfunctions.net/agent_stream",
    "contextUrl": "https://gptfree.com/",
    "models": [
      ["auto", "Auto (GPTFree)"]
    ]
  }
}

function buildModels() {
  const result = []
  for (const [providerKey, provider] of Object.entries(sources)) {
    for (const m of provider.models) {
      const [modelId, label, ctx] = m
      const intell = getScore(modelId)
      result.push([modelId, label, intell, ctx, providerKey, ctx ? 'curated' : null, ctx ? provider.contextUrl || null : null])
    }
  }
  return result
}

export const MODELS = buildModels()
