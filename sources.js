/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 */

import { lazyProviderSourceEntries } from './lib/providers/resolutions.js'

export const MODEL_ID_ALIASES = {
  // Api.Airforce exposes this as `unmoderated-gpt`, but its live catalog identifies
  // the backend as `openai/koreai-gpt35-turbo`. The public Airforce model page
  // does not publish a separate intelligence score, so score the named GPT-3.5
  // Turbo family rather than leaving this at the generic floor.
  'unmoderated-gpt': 'openai/gpt-3.5-turbo',
  'cogito-2.1:671b': 'cogito-2.1:671b',
  'deepseek-v3.1:671b': 'deepseek-ai/deepseek-v3.1',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'devstral-2:123b': 'devstral-2-123b-instruct-2512',
  // KiloCode's free tier advertises Reflection's free Beam endpoint (`reflection/beam-free`)
  // while the benchmark catalog measures the paid OpenRouter twin
  // (`reflection/beam-1.0-501b-a23b`, AA 17.7). Same weights, so the free row is scored from
  // that measurement instead of sitting unscored and off the plot.
  'reflection/beam-free': 'reflection/beam-1.0-501b-a23b',
  // Ollama publishes the same Beam under its bare model name. Alias it to the measured twin
  // so it joins KiloCode's row in the model list and inherits the same AA score; the tag form
  // is what a locally pulled copy reports.
  beam: 'reflection/beam-1.0-501b-a23b',
  'beam:latest': 'reflection/beam-1.0-501b-a23b',
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
  // map those wire ids onto the curated glm-5.3-flash label.
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
  // A different host's fin variant of the same InclusionAI model.
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
  // OrcaRouter's free ids carry the vendor's own names (`Z.ai: GLM 5.3 Flash (Free)`); the
  // `(free)` marker is kept so a free row is distinguishable from its paid twin at a glance.
  'deepseek/deepseek-v4-flash-free': 'DeepSeek V4 Flash (free)',
  'deepseek/deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash (free)',
  'orca/orcaverify-text1.0-free': 'OrcaVerify Text 1.0 (free)',
  'tencent/hy3-free': 'Tencent Hy3 (free)',
  'tencent/hy4-preview-free': 'Tencent Hy4 Preview (free)',
  'z-ai/glm-5.3-flash-free': 'GLM 5.3 Flash (free)',
  'orcarouter/free': 'OrcaRouter Free (auto)',
  // Token Harbor's free ids are wire-only and end in `:free`, which the generic formatter
  // renders as `Deepseek V4 Flash:Free`. Keep the vendor's name and the lowercase marker the
  // other free tiers use, so a free row reads as free beside its paid twin.
  'deepseek-v4.1-flash:free': 'DeepSeek V4.1 Flash (free)',
  'deepseek-v4-flash:free': 'DeepSeek V4 Flash (free)',
  'mimo-v2.6-flash:free': 'MiMo V2.6 Flash (free)',
  'mimo-v2.5:free': 'MiMo V2.5 (free)',
  // InferX publishes no labels, only wire ids, so its catalogue would otherwise render with
  // title-cased spellings (`Gpt Oss 20b`, `Gemma 4 31B It Fp8`).
  'deepseek-v4.1-flash-1017-basic': 'DeepSeek V4.1 Flash 1017 Basic',
  'deepseek-v4.1-flash-1017': 'DeepSeek V4.1 Flash 1017',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'gpt-oss-20b': 'GPT OSS 20B',
  'gemma-4-31B-it-fp8': 'Gemma 4 31B',
  'Qwen3.8-27B-FP8': 'Qwen3.8 27B',
  'Qwen3.6-35B-A3B-FP8': 'Qwen3.6 35B A3B',
  'Qwen3-Coder-Next-FP8': 'Qwen3 Coder Next',
  'qwen3.8-max': 'Qwen3.8 Max',
  'glm-5.3': 'GLM 5.3',
  'Agents-A1': 'Agents A1',
  'Devstral-2-123B-Instruct-2512-int4-AutoRound': 'Devstral 2 123B (AutoRound)',
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
  // OrcaRouter publishes no context length on its ids; the model detail for the free DeepSeek
  // V4 Flash states 1M.
  'deepseek/deepseek-v4-flash-free': '1M',
  // InferX's /v1/models publishes no context length; its catalogue page states 262,144 for the
  // one endpoint it serves at $0.
  'deepseek-v4.1-flash-1017-basic': '262k',
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

  // ── Hosts that publish a lower window than the model's maker ───────────────────────────
  // The map below states what each model's *maker* publishes. A host is free to serve less,
  // and several do: these are the ids where the host's own docs state a smaller number, so
  // the vendor figure would overstate what that route accepts.
  'fireworks/nemotron-3-ultra-nvfp4': '262k',
  'deepinfra/NVIDIA-Nemotron-3-Ultra-550B-A55B': '262k',
  'deepinfra/Qwen/Qwen3.8-27B': '262k',
  // Azure/Foundry caps Grok where xAI serves 256k and 1M, and caps Opus 4.8 where Anthropic
  // serves 1M.
  'azure/grok-4': '128k',
  'azure/grok-4.3': '200k',
  'azure/claude-opus-4-8': '200k',
  'azure/claude-opus-4.8': '200k',
  // Together launched Llama 4 Scout below the 10M its maker documents.
  'together/meta/llama-4-scout-17b-16e-instruct': '327k',
}

/**
 * The context window each model's maker publishes, keyed by bare model id.
 *
 * A provider's `/v1/models` usually states this itself, and a reported number always wins
 * (see resolveModelContext). This table is for the catalogues that omit it — requesty's whole
 * listing, NIM's older ids, every id an aggregator resells without metadata — so the Context
 * column can state the published window instead of leaving a dash where a real number exists.
 *
 * Sourced from the makers' own model pages in November 2026: developers.openai.com, ai.google.dev,
 * platform.claude.com, api-docs.deepseek.com, platform.moonshot.ai, docs.z.ai, help.aliyun.com,
 * platform.minimaxi.com, mimo.mi.com, docs.mistral.ai, build.nvidia.com, docs.x.ai, llama.com.
 * Where a maker states a range ("up to 1M") the top of it is used, and where a maker's page
 * contradicts itself the specification table wins over the marketing line.
 *
 * These are the model's window, not a promise about any one route: MODEL_CONTEXT_OVERRIDES
 * carries the ids where a host documents something smaller, and is consulted first.
 */
export const MODEL_CONTEXT_BY_NAME = {
  // OpenAI
  'gpt-5': '400k',
  'gpt-5-mini': '400k',
  'gpt-5-nano': '400k',
  'gpt-5.1': '400k',
  'gpt-5.4': '1.05M',
  'gpt-5.4-mini': '400k',
  'gpt-5.4-nano': '400k',
  'gpt-5.5': '1.05M',
  'gpt-5.5-pro': '1.05M',
  'gpt-5.6-luna': '1.05M',
  'gpt-5.6-sol': '1.05M',
  'gpt-5.6-terra': '1.05M',
  'gpt-6-luna': '1.05M',
  'gpt-6-astra': '1.05M',
  'gpt-6.1-terra': '1.05M',
  'gpt-6.1-sol': '1.05M',
  'gpt-4.1': '1M',
  'gpt-4.1-nano': '1M',
  'gpt-6-sol': '1.05M',
  // The chat-latest snapshots predate the 400k/1M windows and stayed at 128k.
  'gpt-5-chat-latest': '128k',
  'gpt-5.1-chat-latest': '128k',
  'gpt-5.2-chat-latest': '128k',
  'gpt-3.5-turbo': '16k',
  'gpt-4': '8k',
  o1: '200k',
  'o4-mini': '200k',
  'gpt-oss-20b': '131k',
  'gpt-oss-120b': '131k',

  // Google
  'gemini-2.5-flash': '1M',
  'gemini-2.5-flash-lite': '1M',
  'gemini-2.5-pro': '1M',
  'gemini-3-flash-preview': '1M',
  'gemini-3.1-flash-lite': '1M',
  'gemini-3.1-pro-preview': '1M',
  'gemini-3.5-flash': '1M',
  'gemini-3.5-flash-lite': '1M',
  'gemini-3.6-flash': '1M',
  'gemini-3.7-flash': '1M',
  'gemini-3.8-flash': '1M',
  'gemini-4-hydrogen': '1M',
  'gemini-4-argon': '1M',
  'gemini-4-carbon': '1M',
  'gemma-4-31b-it': '256k',
  'gemma-4-26b-a4b-it': '262k',
  // The `latest` aliases hot-swap, and every 3.x target they have pointed at is 1M.
  'gemini-pro-latest': '1M',
  'gemini-flash-latest': '1M',
  'gemini-flash-lite-latest': '1M',

  // Anthropic — 1M is the default now, no beta header; Batch API is a separate 300k product
  'claude-opus-5': '1M',
  'claude-opus-5-5': '1M',
  'claude-opus-4-6': '1M',
  'claude-opus-4-7': '1M',
  'claude-opus-4-8': '1M',
  'claude-sonnet-5': '1M',
  'claude-sonnet-5-5': '1M',
  'claude-sonnet-4-6': '1M',
  'claude-fable-5': '1M',
  'claude-fable-5-1': '1M',
  'claude-fable-5.1': '1M',
  'claude-fable-5-2': '1M',
  'claude-fable-5.2': '1M',
  // Haiku 5.5 is on the 1M window; the earlier 4.5 generation (and Opus/Sonnet 4.5) are not.
  'claude-haiku-5-5': '1M',
  'claude-haiku-4-5': '200k',
  'claude-opus-4-5': '200k',
  'claude-sonnet-4-5': '200k',

  // DeepSeek — the -0424/-0731/-0813/-1017 strings are versions, all on the 1M window
  'deepseek-flash': '1M',
  'deepseek-v4-flash': '1M',
  'deepseek-v4-flash-0424': '1M',
  'deepseek-v4-flash-0731': '1M',
  'deepseek-v4-pro': '1M',
  'deepseek-v4-pro-0424': '1M',
  'deepseek-v4-pro-0813': '1M',
  'deepseek-v4.1-flash': '1M',
  'deepseek-v4.1-flash-1017': '1M',

  // Moonshot Kimi — K3 series 1M, K2 series 256k
  'kimi-k3': '1M',
  'kimi-k3.1-pro': '1M',
  'kimi-k3.1-pro-highspeed': '1M',
  'kimi-k2.6': '262k',
  'kimi-k2.7-code': '262k',

  // Z.ai GLM
  'glm-5.1': '200k',
  'glm-5.2': '1M',
  'glm-5.3': '1M',
  'glm-5.3-flash': '1M',
  // Flash and FlashX share one card.
  'glm-5.3-flashx': '1M',

  // Alibaba Qwen
  'qwen3.8-max': '1M',
  'qwen3.8-27b': '1M',
  'qwen3.7-max': '1M',
  'qwen3.7-flash': '1M',
  'qwen3.6-flash': '1M',
  'qwen3.8-flash': '1M',
  'qwen3.8-2.4t-a95b': '1M',
  'qwen3.6-27b': '262k',
  'qwen3.5-27b': '262k',
  'qwen3-coder-next': '262k',
  'qwen3-vl-235b-a22b-instruct': '131k',

  // MiniMax and Xiaomi MiMo
  'minimax-m3': '1M',
  'minimax-m3.1-flash': '1M',
  'minimax-m2.7': '205k',
  'mimo-v2.6-pro': '1M',
  'mimo-v2.6-flash': '1M',
  'mimo-v2.6-pro-ultraspeed': '1M',
  'mimo-v2.5-pro': '1M',

  // Mistral
  'mistral-large-4': '1M',
  'mistral-large-4-1t-a52b': '1M',
  'mistral-large': '1M',
  // Mistral states "256k" on every one of these cards; the -latest aliases resolve to them.
  'mistral-medium-3-5': '256k',
  'mistral-medium-3.5': '256k',
  'mistral-medium': '256k',
  'mistral-medium-latest': '256k',
  'mistral-small-2603': '256k',
  'mistral-small-latest': '256k',
  'ministral-3b-2512': '256k',
  'ministral-8b-2512': '256k',
  'ministral-14b-2512': '256k',
  'ministral-3b-latest': '256k',
  'ministral-8b-latest': '256k',
  'ministral-14b-latest': '256k',
  'codestral-latest': '131k',
  'codestral-2508': '131k',
  'devstral-2-123b': '262k',
  'devstral-2-123b-instruct': '262k',
  'devstral-2-123b-instruct-2512': '262k',
  'voxtral-small-2507': '32k',

  // NVIDIA Nemotron — the specification table, where a page claims "up to 1M" and specs 262k
  'nemotron-3-ultra-550b-a55b': '1M',
  'nemotron-3-nano-omni-30b-a3b-reasoning': '262k',
  'nemotron-3.5-lightning-30b-a3b': '1M',
  'nemotron-3.5-super-vl': '262k',
  'nemotron-3.5-super-vl-120b-a12b': '262k',
  'nemotron-3-nano-30b-a3b': '262k',
  'nemotron-nano-3-30b-a3b': '262k',

  // xAI and Meta
  'grok-4': '256k',
  'grok-4-0709': '256k',
  'grok-4.3': '1M',
  'grok-4.5': '500k',
  'grok-4.6': '500k',
  'grok-4.7': '500k',
  'grok-code-fast-1': '256k',
  'llama-4-scout': '10M',
  'llama-4-scout-17b-16e-instruct': '10M',
  'llama-4-maverick': '1M',
  'llama-4-maverick-17b-128e-instruct': '1M',
  'llama-3.3-70b': '131k',
  'llama-3.3-70b-instruct': '131k',

  // ByteDance, StepFun and Tencent
  'seed-2.0-mini': '256k',
  'doubao-seed-2-0-mini-260428': '256k',
  'step-5-preview': '1M',
  hy3: '256k',
  hy4: '1M',
  'hy4-preview': '1M',
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
  let value = stripRoutingNamespace(
    String(modelId || '')
      .trim()
      .toLowerCase(),
  )
  if (!value) return ''
  value = value.replace(/^models\//, '')
  value = value.replace(/^[^/]+\//, '')
  value = value.replace(/(?::(?:free|optimized|cloud))+$/i, '')
  value = value.replace(/\b(?:latest|current|default)\b/g, ' ')
  value = value.replace(/\b\d+(?:\.\d+)+\b/g, ' ')
  value = value.replace(/\b\d+\b/g, ' ')
  return value
    .replace(/[-_:/.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Returns numeric version components used to select the newest concrete family member. */
export function getModelVersionTuple(modelId) {
  const value = stripRoutingNamespace(String(modelId || '').toLowerCase())
  const matches = value.match(/\d+(?:\.\d+)+|\d+/g) || []
  return matches.flatMap((part) => part.split('.').map(Number)).filter(Number.isFinite)
}

/**
 * Normalized model name used for identity comparisons: routing namespaces
 * ("srv_ab12:"), vendor prefixes ("qwen/"), runtime tags (":free") and every
 * separator spelling are folded away, so one model advertised under several id
 * spellings compares equal. Version digits are preserved (3.5 != 3.8).
 */
/**
 * Normalized names are recomputed for both sides of every pairwise identity comparison, and a
 * single grouping pass makes hundreds of thousands of them over the same few hundred ids. The
 * name is a pure function of its argument, so one bounded cache serves every caller. Cleared
 * wholesale when it fills: the ids come from provider catalogs, so the working set is small
 * and a few thousand entries cover it without holding a catalog's whole history forever.
 */
const identityNameCache = new Map()
/** Folded keys (the name with its spaces removed) are what comparisons actually consult. */
const identityKeyCache = new Map()
const IDENTITY_NAME_CACHE_LIMIT = 4096

function normalizedModelIdentityName(modelId) {
  const cacheable = typeof modelId === 'string'
  if (cacheable) {
    const cached = identityNameCache.get(modelId)
    if (cached !== undefined) return cached
  }
  let value = stripRoutingNamespace(resolveAliasedModelId(modelId)).toLowerCase()
  if (!value) {
    if (cacheable) cacheIdentityName(modelId, '')
    return ''
  }
  value = value.replace(/^models\//, '')
  const segments = value.split('/')
  value = segments[segments.length - 1]
  value = value.replace(/(?::(?:free|optimized|cloud))+$/i, '')
  const normalized = value.replace(/[-_:./\s]+/g, ' ').trim()
  if (cacheable) cacheIdentityName(modelId, normalized)
  return normalized
}

function cacheIdentityName(modelId, normalized) {
  if (identityNameCache.size >= IDENTITY_NAME_CACHE_LIMIT) identityNameCache.clear()
  identityNameCache.set(modelId, normalized)
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
  const cacheable = typeof modelId === 'string'
  if (cacheable) {
    const cached = identityKeyCache.get(modelId)
    if (cached !== undefined) return cached
  }
  const key = normalizedModelIdentityName(modelId).replace(/\s+/g, '')
  if (cacheable) {
    if (identityKeyCache.size >= IDENTITY_NAME_CACHE_LIMIT) identityKeyCache.clear()
    identityKeyCache.set(modelId, key)
  }
  return key
}

/**
 * The leading family token of an id ("nvidia/nemotron-3-super-120b-a12b" → "nemotron").
 *
 * A size-qualified alias can only match when the shorter name is a token-wise prefix of the
 * longer one, so two ids that compare equal always agree here (or on their identity key).
 * Grouping reads it as a necessary condition, which is what keeps the pairwise identity test
 * off the buckets that could never match.
 */
export function getModelIdentityFirstToken(modelId) {
  const name = normalizedModelIdentityName(modelId)
  if (!name) return ''
  return name.split(' ').filter(Boolean)[0] || ''
}

/**
 * True for tokens that only describe a model's size or quantization ("120b",
 * "a12b", "30b", "8x22b", "q4_k_m", "gguf") — never for meaningful variants
 * such as "lite", "omni", "instruct" or "reasoning".
 */
export function isModelSizeToken(token) {
  return /^(?:a\d+b|\d+(?:\.\d+)?x\d+[bemt]|\d+[bemt]|q\d+(?:[_-][a-z0-9]+)*|fp\d+|int\d+|bf16|awq|gptq|gguf)$/i.test(
    String(token || ''),
  )
}

/**
 * Whether two model ids name the same model: an exact identity-key match or a
 * size-qualified alias of it. This is what merges "nemotron-3-super" with
 * "nvidia/nemotron-3-super-120b-a12b" and g4f's "...-30b" variants, while
 * keeping genuinely different siblings apart — two sizes of one instruct
 * family, "flash" vs "flash-lite", or "nano" vs "nano-omni".
 */
export function isSameModelIdentity(a, b) {
  // One normalization per side: the key is the name with its spaces folded away, so deriving
  // both from the same normalized string costs one pass instead of two.
  const normalizedA = normalizedModelIdentityName(a)
  const normalizedB = normalizedModelIdentityName(b)
  const keyA = normalizedA.replace(/\s+/g, '')
  const keyB = normalizedB.replace(/\s+/g, '')
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  const nameA = normalizedA.split(' ').filter(Boolean)
  const nameB = normalizedB.split(' ').filter(Boolean)
  if (!nameA.length || !nameB.length) return false
  const [shortTokens, longTokens] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA]
  if (shortTokens.length === longTokens.length) return false
  for (let i = 0; i < shortTokens.length; i++) {
    if (shortTokens[i] !== longTokens[i]) return false
  }
  // A bare number only ever trails a g4f duplicate marker ("...-30b - 1"), and
  // must not be read as a version — so it is ignorable only after a named token.
  if (/^\d+$/.test(shortTokens[shortTokens.length - 1])) return false
  // A short number on the end is a snapshot, not a sibling: g4f's duplicate marker ("- 1")
  // and a provider's build stamp ("deepseek-v4.1-flash-1017", the October build the plain
  // `deepseek-v4.1-flash` id also serves) both name the same weights. Four digits is the
  // widest stamp `m-d`/`mmdd`/`md` spellings produce; a longer run is a date ("20241022") and
  // stays a distinct snapshot, and a token after the stamp is a real variant, so
  // "…-1017-fast" keeps its own group.
  const extra = longTokens.slice(shortTokens.length)
  // g4f's Poe mirror publishes DeepSeek V4.1 Flash as "DeepSeek-V4.1-Flash-T" beside the plain
  // id every other provider serves, and `-T` names the route the bot takes to those weights,
  // not different weights — the same rows already carry the same catalogue score. A lone
  // trailing `t` is therefore a route marker; anything longer ("…-T-Pro") is a real variant
  // and keeps its own group.
  //
  // `thinking` is the same marker spelled out. CrowLLM lists `caw/glm-5.3-flash-thinking:free`
  // beside `caw/glm-5.3-flash:free`, Moonshot publishes `kimi-k2-thinking` beside `kimi-k2`, and
  // the model reasons either way — the suffix names the route a gateway takes to the weights,
  // not a second model. Two headings for one model split its providers, its allowance and its
  // traffic across rows that cannot be compared.
  if (extra.length === 1 && (extra[0] === 't' || extra[0] === 'thinking')) return true
  return extra.every(
    (token, index) =>
      isModelSizeToken(token) || (index === extra.length - 1 && /^\d{1,4}$/.test(token)),
  )
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
  const base = resolved.replace(/(?::(?:free|optimized|cloud))+$/i, '')
  // 2. Remove provider prefix like google/
  const unprefixed = base.includes('/') ? base.split('/').pop() : base
  // 3. `unscoped` is `base` without a leading `@namespace/`, which is how Cloudflare
  //    spells its catalog (`@cf/meta/llama-3.1-8b-instruct-fp8` for the model every other
  //    catalog publishes as `meta/llama-3.1-8b-instruct`). Nothing else in the registry
  //    uses an `@` namespace or more than one path segment, so this can only ever add a
  //    spelling of a model that is already here — `base` and `unprefixed` keep their exact
  //    previous values, which is what routing, grouping and alias collection read.
  const unscoped = base.replace(/^@[^/]+\//, '')
  return { base, unprefixed, unscoped }
}

export function getPreferredModelLabel(modelId, fallback = null) {
  const resolved = resolveAliasedModelId(modelId)
  const override = MODEL_LABEL_OVERRIDES[modelId] || MODEL_LABEL_OVERRIDES[resolved]
  if (override) return override
  const cleanedFallback = cleanModelDisplayLabel(fallback)
  return cleanedFallback || fallback
}

// Every spelling of a model id that MODEL_CONTEXT_BY_NAME is keyed by: the id as published,
// the id after the runtime/provider prefixes come off (`vertex/`, `models/`, `srv_…:`), and
// without a region suffix (`gemini-4-hydrogen@eu` is the same model in another region).
function contextLookupNames(modelId) {
  const names = []
  const add = (name) => {
    if (name && !names.includes(name)) names.push(name)
  }
  const push = (value) => {
    const name = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/@[a-z0-9_-]+$/i, '')
      .replace(/^srv_[a-z0-9]+:/i, '')
      .replace(/^models\//i, '')
    add(name)
    // A serving tier (`gpt-6.1-terra:flex`) and a dated snapshot (`-2026-03-17`, `-20260317`,
    // `-0613`) are the same model on the same window as the id they hang off: the maker
    // publishes one figure for it, and a snapshot never widens it.
    add(name.replace(/:(flex|priority)$/i, ''))
    add(name.replace(/-\d{4}-\d{2}-\d{2}$/, ''))
    add(name.replace(/-\d{8}$/, '').replace(/-\d{4}$/, ''))
    // A hosted checkpoint's quantisation tag (`-FP8`, `-int4-AutoRound`) is the same weights on
    // the same window.
    add(name.replace(/-(fp8|fp4|bf16)$/i, ''))
    add(name.replace(/-int[48](?:-[a-z]+)?$/i, ''))
  }
  push(modelId)
  push(resolveAliasedModelId(modelId))
  const { base, unprefixed } = canonicalizeModelId(modelId)
  push(base)
  push(unprefixed)
  return names
}

export function getPreferredModelContext(modelId, fallback = null) {
  const resolved = resolveAliasedModelId(modelId)
  // An exact id first: a host's documented cap beats the maker's window for the same model.
  const override = MODEL_CONTEXT_OVERRIDES[modelId] || MODEL_CONTEXT_OVERRIDES[resolved]
  if (override) return override
  for (const name of contextLookupNames(modelId)) {
    if (MODEL_CONTEXT_BY_NAME[name]) return MODEL_CONTEXT_BY_NAME[name]
  }
  return fallback
}

export const sources = {
  // ── Imported providers (OmniRoute free tier) ────────────────────────────────
  // Rows whose endpoint, wire format and credential shape were all resolved to plain
  // OpenAI-compatible + bearer, so they need nothing provider-specific and can ride the
  // generic path with no per-provider code. Distinct from the hand-configured providers
  // below in two ways that matter:
  //
  //   • They carry `lazyDiscovery: true`, which keeps them out of the eager provider
  //     treatment. Eligible unresolved imports are still discovered in the awaited startup
  //     phase; the flag only preserves the smaller request-triggered recovery path.
  //   • They carry no model rows. A list invented here would be stale the moment the
  //     provider rotated its roster; discovery supplies what is actually served.
  //
  // Spread FIRST so hammer's own providers below win any key collision (nvidia, groq,
  // openrouter, kiro). See lib/providers/resolutions.js for
  // which imports are active and why the rest are not.
  ...lazyProviderSourceEntries(),
  nvidia: {
    name: 'NIM',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    contextUrl: 'https://build.nvidia.com/models',
    discoverable: true,
    models: [
      ['z-ai/glm-5.2', 'GLM 5.2', '200k'],
      ['moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code', '262k'],
      ['minimaxai/minimax-m3', 'MiniMax M3', '1M'],
      ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', '1M'],
      ['stepfun-ai/step-3.7-flash', 'Step 3.7 Flash', '262k'],
      ['deepseek-ai/deepseek-v3.2', 'DeepSeek V3.2', '128k'],
      ['moonshotai/kimi-k2.5', 'Kimi K2.5', '128k'],
      ['z-ai/glm5', 'GLM 5', '128k'],
      ['z-ai/glm4.7', 'GLM 4.7', '200k'],
      ['moonshotai/kimi-k2-thinking', 'Kimi K2 Thinking', '256k'],
      ['minimaxai/minimax-m2.1', 'MiniMax M2.1', '200k'],
      ['stepfun-ai/step-3.5-flash', 'Step 3.5 Flash', '256k'],
      ['qwen/qwen3-coder-480b-a35b-instruct', 'Qwen3 Coder 480B', '256k'],
      ['qwen/qwen3-235b-a22b', 'Qwen3 235B', '128k'],
      ['mistralai/devstral-2-123b-instruct-2512', 'Devstral 2 123B', '256k'],
      ['deepseek-ai/deepseek-v3.1-terminus', 'DeepSeek V3.1 Terminus', '128k'],
      ['moonshotai/kimi-k2-instruct', 'Kimi K2 Instruct', '128k'],
      ['minimaxai/minimax-m2', 'MiniMax M2', '128k'],
      ['qwen/qwen3-next-80b-a3b-thinking', 'Qwen3 80B Thinking', '128k'],
      ['qwen/qwen3-next-80b-a3b-instruct', 'Qwen3 80B Instruct', '128k'],
      ['qwen/qwen3.5-397b-a17b', 'Qwen3.5 400B', '128k'],
      ['openai/gpt-oss-120b', 'GPT OSS 120B', '128k'],
      ['meta/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', '1M'],
      ['deepseek-ai/deepseek-v3.1', 'DeepSeek V3.1', '128k'],
      ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Nemotron Ultra 253B', '128k'],
      ['mistralai/mistral-large-3-675b-instruct-2512', 'Mistral Large 675B', '256k'],
      ['qwen/qwq-32b', 'QwQ 32B', '131k'],
      ['igenius/colosseum_355b_instruct_16k', 'Colosseum 355B', '16k'],
      ['mistralai/mistral-medium-3-instruct', 'Mistral Medium 3', '128k'],
      ['mistralai/magistral-small-2506', 'Magistral Small', '32k'],
      ['nvidia/llama-3.3-nemotron-super-49b-v1.5', 'Nemotron Super 49B', '128k'],
      ['meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', '10M'],
      ['nvidia/nemotron-3-nano-30b-a3b', 'Nemotron Nano 30B', '128k'],
      ['deepseek-ai/deepseek-r1-distill-qwen-32b', 'R1 Distill 32B', '128k'],
      ['openai/gpt-oss-20b', 'GPT OSS 20B', '128k'],
      ['qwen/qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B', '32k'],
      ['meta/llama-3.1-405b-instruct', 'Llama 3.1 405B', '128k'],
      ['meta/llama-3.3-70b-instruct', 'Llama 3.3 70B', '128k'],
      ['deepseek-ai/deepseek-r1-distill-qwen-14b', 'R1 Distill 14B', '64k'],
      ['bytedance/seed-oss-36b-instruct', 'Seed OSS 36B', '32k'],
      ['stockmark/stockmark-2-100b-instruct', 'Stockmark 100B', '32k'],
      ['mistralai/mixtral-8x22b-instruct-v0.1', 'Mixtral 8x22B', '64k'],
      ['mistralai/ministral-14b-instruct-2512', 'Ministral 14B', '32k'],
      ['ibm/granite-34b-code-instruct', 'Granite 34B Code', '32k'],
      ['deepseek-ai/deepseek-r1-distill-llama-8b', 'R1 Distill 8B', '32k'],
      ['deepseek-ai/deepseek-r1-distill-qwen-7b', 'R1 Distill 7B', '32k'],
      ['google/gemma-2-9b-it', 'Gemma 2 9B', '8k'],
      ['microsoft/phi-3.5-mini-instruct', 'Phi 3.5 Mini', '128k'],
      ['microsoft/phi-4-mini-instruct', 'Phi 4 Mini', '128k'],
    ],
  },
  groq: {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    contextUrl: 'https://console.groq.com/docs/models',
    discoverable: true,
    models: [
      ['llama-3.3-70b-versatile', 'Llama 3.3 70B', '128k'],
      ['meta-llama/llama-4-scout-17b-16e-preview', 'Llama 4 Scout', '128k'],
      ['meta-llama/llama-4-maverick-17b-128e-preview', 'Llama 4 Maverick', '128k'],
      ['deepseek-r1-distill-llama-70b', 'R1 Distill 70B', '128k'],
      ['qwen-qwq-32b', 'QwQ 32B', '131k'],
      ['moonshotai/kimi-k2-instruct', 'Kimi K2 Instruct', '131k'],
      ['llama-3.1-8b-instant', 'Llama 3.1 8B', '128k'],
      ['openai/gpt-oss-120b', 'GPT OSS 120B', '128k'],
      ['openai/gpt-oss-20b', 'GPT OSS 20B', '128k'],
      ['qwen/qwen3-32b', 'Qwen3 32B', '131k'],
    ],
  },
  'openai-compatible': {
    name: 'OpenAI-Compatible',
    url: '',
    models: [],
  },
  devin: {
    name: 'Devin SWE',
    url: 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage',
    contextUrl: 'https://devin.ai/',
    models: [
      ['swe-1.6', 'Devin SWE 1.6', '128k', 'curated', 'https://devin.ai/'],
      ['swe-1.5', 'Devin SWE 1.5', '128k', 'curated', 'https://devin.ai/'],
    ],
  },
  ollama: {
    name: 'Ollama',
    url: '',
    models: [],
  },
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    contextUrl: 'https://openrouter.ai/api/v1/models',
    models: [
      ['qwen/qwen3-coder:free', 'Qwen3 Coder', '256k'],
      ['xiaomi/mimo-v2-pro:free', 'MiMo V2 Omni Pro', '1M'],
      ['xiaomi/mimo-v2-omni:free', 'MiMo V2 Omni', '1M'],
      ['stepfun/step-3.5-flash:free', 'Step 3.5 Flash', '256k'],
      ['deepseek/deepseek-r1-0528:free', 'DeepSeek R1 0528', '128k'],
      ['qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3 80B Instruct', '128k'],
      ['openai/gpt-oss-120b:free', 'GPT OSS 120B', '128k'],
      ['openai/gpt-oss-20b:free', 'GPT OSS 20B', '131072'],
      ['nvidia/nemotron-3-nano-30b-a3b:free', 'Nemotron Nano 30B', '256k'],
      ['meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B', '128k'],
      ['minimax/minimax-m2.5:free', 'MiniMax M2.5', '128k'],
      ['corethink:free', 'CoreThink', '128k'],
      ['giga-potato-thinking:free', 'Giga Potato Thinking', '128k'],
    ],
  },
  codestral: {
    name: 'Codestral',
    // No public /v1/models endpoint exists on codestral.mistral.ai (verified: 404
    // / no route); the list below is the complete static catalog. Kept manual.
    url: 'https://codestral.mistral.ai/v1/chat/completions',
    contextUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    models: [['codestral-latest', 'Codestral', '256k']],
  },
  kilocode: {
    name: 'KiloCode',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    contextUrl: 'https://api.kilo.ai/api/gateway/models',
    models: [['arcee-ai/trinity-large-preview', 'Trinity Large', '128k']],
  },
  kiro: {
    name: 'Kiro',
    // Proprietary EventStream API (no /v1/models surface) — the catalog below is
    // the complete static list. Kept manual.
    url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
    contextUrl: 'https://kiro.dev/docs/cli/reference/models/',
    models: [
      ['claude-sonnet-4.5', 'Claude Sonnet 4.5', '200k'],
      ['claude-haiku-4.5', 'Claude Haiku 4.5', '200k'],
    ],
  },
  googleai: {
    name: 'Google AI',
    // Google's OpenAI-compatible layer on the Gemini Developer API. Its roster is read from
    // the credential's own model list and nothing is declared here on purpose: a curated
    // fallback showed three Gemma rows beside an account that could not list anything, which
    // read as a working provider serving three models instead of a credential that was being
    // refused. An empty roster is the honest answer until discovery succeeds.
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    contextUrl: 'https://ai.google.dev/gemini-api/docs/models',
    discoverable: true,
    models: [],
  },
  // --- Google Antigravity -----------------------------------------------------
  // Gemini through Cloud Code Assist, authenticated by an OAuth sign-in instead of an API key.
  // This is a different product surface from `googleai`: the backend wraps each request as
  // `{project, model, request}` on `daily-cloudcode-pa`, and its roster is the Antigravity wire
  // ids rather than the Generative Language list. `fetchAvailableModels` refuses an entitled
  // account with 403, so the catalog below is curated (mirrors oh-my-pi's `google-antigravity`)
  // and is only seeded once an account exists. lib/google-antigravity.js serves the wire.
  'google-antigravity': {
    name: 'Google Antigravity',
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
    contextUrl: 'https://antigravity.google',
    // Only ids that answered on this backend (probed 2026-11-09). The retired 3.5 ids return a
    // 200 whose body is "no longer available, switch to Gemini 3.7 Flash" — listing one would
    // present that notice as a model answer — and the 3.6/3.7/3.1-pro ids 404 for the project.
    models: [
      // The `-low` tier answered with empty content at a small output budget and could not be
      // re-probed before the app went down, so it is not offered rather than offered broken.
      ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
    ],
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
  'github-copilot': {
    name: 'GitHub Copilot',
    url: 'https://api.githubcopilot.com/chat/completions',
    contextUrl:
      'https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements',
    models: [
      ['gpt-5.5', 'GPT 5.5', '400k'],
      ['gpt-5.1-codex', 'GPT 5.1 Codex', '400k'],
      ['gpt-5.1-codex-max', 'GPT 5.1 Codex Max', '400k'],
      ['gpt-5.1-codex-mini', 'GPT 5.1 Codex Mini', '400k'],
      ['gpt-4.1', 'GPT 4.1', '128k'],
      ['claude-sonnet-5', 'Claude Sonnet 5', '200k'],
      ['claude-sonnet-4.5', 'Claude Sonnet 4.5', '200k'],
      ['claude-haiku-4.5', 'Claude Haiku 4.5', '200k'],
      ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro', '1M'],
      ['gemini-3-flash-preview', 'Gemini 3 Flash', '1M'],
      ['grok-4.5', 'Grok 4.5', '256k'],
      ['grok-code-fast-1', 'Grok Code Fast', '256k'],
    ],
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
  'openai-codex': {
    name: 'OpenAI Codex',
    url: 'https://chatgpt.com/backend-api/codex/responses',
    contextUrl: 'https://developers.openai.com/codex/',
    models: [
      ['gpt-5.1-codex', 'GPT 5.1 Codex', '400k'],
      ['gpt-5.1-codex-max', 'GPT 5.1 Codex Max', '400k'],
      ['gpt-5.1-codex-mini', 'GPT 5.1 Codex Mini', '400k'],
      ['gpt-5-codex', 'GPT 5 Codex', '400k'],
      ['codex-mini-latest', 'Codex Mini', '192k'],
    ],
  },
  // --- OrcaRouter -------------------------------------------------------------
  // The free tier is the id suffix (`-free`), with `orcarouter/free` as the difficulty-routing
  // alias; discovery supplies the full catalogue and marks the metered rows Paid. No context
  // length is published for these ids.
  orcarouter: {
    name: 'OrcaRouter',
    url: 'https://api.orcarouter.ai/v1/chat/completions',
    contextUrl: 'https://api.orcarouter.ai/v1/models',
    discoverable: true,
    models: [],
  },
  // --- InferX ----------------------------------------------------------------
  // OpenAI-compatible gateway. Its list is discovered rather than curated, and because the
  // list publishes no pricing, rows are classified by probes and errors rather than marked
  // Paid from a curated allowlist. `api.inferx.com` from the vendor's developers page does
  // not resolve; `model.inferx.net` is the live host.
  inferx: {
    name: 'InferX',
    url: 'https://model.inferx.net/endpoints/v1/chat/completions',
    contextUrl: 'https://model.inferx.net/endpoints/v1/models',
    discoverable: true,
    models: [],
  },
  // --- CrowLLM ---------------------------------------------------------------
  // One OpenAI-compatible gateway in front of every major vendor at `crowllm.com/v1`. Its
  // catalogue is discovered rather than curated: /v1/models answers anonymously and narrows
  // to the ids the key can reach once one is sent. The zero-priced shelf is the `:free` id
  // suffix — 74 of the 76 ids a free key lists — and every other id bills the wallet.
  crowllm: {
    name: 'CrowLLM',
    url: 'https://crowllm.com/v1/chat/completions',
    contextUrl: 'https://crowllm.com/v1/models',
    discoverable: true,
    models: [],
  },
  // --- Token Harbor ----------------------------------------------------------
  // One OpenAI-compatible gateway over ~80 frontier models. Its list is discovered rather
  // than curated, and it prices every row itself, so free-ness is decided by the `:free` id
  // suffix (see markTokenHarborPaidModels) rather than by an entry in this table.
  tokenharbor: {
    name: 'Token Harbor',
    url: 'https://tokenharbor.ai/v1/chat/completions',
    contextUrl: 'https://tokenharbor.ai/v1/models',
    discoverable: true,
    models: [],
  },
  // --- Puter ----------------------------------------------------------------
  // Puter's AI surface is a driver RPC, not an OpenAI endpoint, so the roster is curated
  // rather than discovered: its catalogue at /puterai/chat/models/details is not an OpenAI
  // /models shape. These are the DeepSeek rows its own tutorial documents; the context
  // lengths are what that catalogue publishes for them. Not marked `discoverable` for the
  // same reason gptfree is not — there is no OpenAI-shaped list to read.
  puter: {
    name: 'Puter',
    url: 'https://api.puter.com/drivers/call',
    contextUrl: 'https://docs.puter.com/AI/chat/',
    models: [
      ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '1M'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro', '1M'],
      ['deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', '1M'],
      ['deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', '1M'],
      ['deepseek-v4-flash-ga-260731', 'DeepSeek V4 Flash', '1M'],
      ['deepseek-flash', 'DeepSeek Flash', '1M'],
    ],
  },
  // --- gpt4free (g4f) --------------------------------------------------------
  // One provider for the whole gpt4free service. g4f.space/v1 is the hosted
  // gateway (many models, discovered from /models). Anonymous traffic is gated
  // behind baked proof-of-work credits, so hammer requires the free account key
  // from https://g4f.dev/members.html — set it once as `apiKeys.g4f` or
  // `G4F_API_KEY` and it covers the whole gateway.
  // Docs: https://g4f.dev/docs/ready_to_use.html
  g4f: {
    name: 'G4F',
    url: 'https://g4f.space/v1/chat/completions',
    contextUrl: 'https://g4f.dev/members.html',
    discoverable: true,
    models: [['auto', 'Auto (G4F)', '128k']],
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
  // --- MoonMath (Zro) ---------------------------------------------------------
  // MoonMath's private inference gateway (`zro.moonmath.ai/v1`) speaks the OpenAI
  // chat-completions API. Its Free plan includes daily usage on GLM-5.3 Flash and
  // DeepSeek V4.1 Flash; everything else needs Pro or a usage pack, so the roster is
  // discovered and rows are classified by what this key is actually allowed to call
  // rather than by a hardcoded price list.
  moonmath: {
    name: 'MoonMath',
    url: 'https://zro.moonmath.ai/v1/chat/completions',
    contextUrl: 'https://zro.moonmath.ai/v1/models',
    discoverable: true,
    models: [],
  },
  // --- Requesty ---------------------------------------------------------------
  // An OpenAI-compatible router in front of 600+ models (`router.requesty.ai/v1`). Its
  // roster is discovered from its own /v1/models list, which is the only place its aliases
  // and routing policies are published; nothing is curated here.
  requesty: {
    name: 'Requesty',
    url: 'https://router.requesty.ai/v1/chat/completions',
    contextUrl: 'https://router.requesty.ai/v1/models',
    discoverable: true,
    models: [],
  },
  // --- Agnes AI --------------------------------------------------------------
  // OpenAI-compatible chat at `apihub.agnes-ai.com/v1`, keyed `sk-`. Its `/v1/models` list
  // mixes text, image and video ids in one namespace (`agnes-image-*`, `agnes-video-*`), and
  // a media id refuses a chat completion with 400 — so the roster is curated to the text
  // models rather than discovered, or the table would offer rows that can never answer. No
  // context length is published per id, so none is claimed here.
  agnes: {
    name: 'Agnes AI',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    contextUrl: 'https://wiki.agnes-ai.com/en/docs/quickstart',
    models: [
      ['agnes-2.5-flash', 'Agnes 2.5 Flash'],
      ['agnes-3.0-flash', 'Agnes 3.0 Flash'],
      ['agnes-2.5-pro', 'Agnes 2.5 Pro'],
      ['agnes-2.5-pro-beta', 'Agnes 2.5 Pro Beta'],
      ['agnes-2.5-pro-alpha', 'Agnes 2.5 Pro Alpha'],
    ],
  },
  // Deliberately NOT `discoverable` — there is no model list to discover from.
  gptfree: {
    name: 'GPTFree',
    url: 'https://us-central1-gptfree-2.cloudfunctions.net/agent_stream',
    contextUrl: 'https://gptfree.com/',
    models: [['auto', 'Auto (GPTFree)']],
  },
}

function buildModels() {
  const result = []
  for (const [providerKey, provider] of Object.entries(sources)) {
    for (const m of provider.models) {
      const [modelId, label, ctx] = m
      result.push([
        modelId,
        label,
        // Intelligence is never bundled with the catalog: it is fetched at runtime by
        // lib/model-quality.js, so this column stays empty until that data arrives.
        null,
        ctx,
        providerKey,
        ctx ? 'curated' : null,
        ctx ? provider.contextUrl || null : null,
      ])
    }
  }
  return result
}

export const MODELS = buildModels()
