/**
 * ── The provider catalog: one object per provider ──────────────────────────────────────
 *
 * This file is the single home for every fact about a provider that is not its model
 * list. Those facts previously lived in five places and had to be kept in sync by hand:
 *
 *   - `sources.js`               -> `PROVIDER_QUOTAS` (kept there: sources.js is already
 *                                   import-light, so it is imported and attached to each
 *                                   descriptor below rather than transcribed a second time)
 *   - `lib/config.js`            -> env vars, base-URL env vars, model-id env vars,
 *                                   the OAuth provider set, legacy secret fields
 *   - `lib/providerLinks.js`     -> `API_KEY_SIGNUP_URLS`
 *   - `lib/request-sanitize.js`  -> `SEEDED_FIELD_STRIPS`
 *   - `lib/server.js`            -> `OPTIONAL_BEARER_AUTH_PROVIDERS` and the 109
 *                                   `providerKey ===` branches that did the work
 *
 * The consumers now derive their tables from these descriptors (see the rewire in
 * `config.js`, `providerLinks.js` and `request-sanitize.js`), so each table keeps its
 * original exported shape and callers are unchanged — there is just one source.
 *
 * Model rows deliberately stay in `sources.js` for now: they are a 300-line table that a
 * mechanical move would only transcribe, and relocating them without a behavior-parity
 * harness would be churn. A descriptor points at them with `modelsSource: 'sources'`.
 *
 * This module imports only the quota table, which is itself data. Nothing here imports
 * the registry, so there is no cycle: `sources.js` and `lib/config.js` can both read it.
 */

import { PROVIDER_QUOTAS } from '../../sources.js'

export { PROVIDER_QUOTAS }

/**
 * Every provider hammer ships with, keyed by provider key.
 *
 * `chatUrl` and the model rows live in `sources.js`; the fields here are the ones that
 * used to be scattered. Keeping both halves in one descriptor object is the goal — the
 * split across two files is a staging step, not the design.
 */
export const PROVIDER_DESCRIPTORS = {
  nvidia: {
    label: 'NIM',
    chatUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    contextUrl: 'https://build.nvidia.com/models',
    signupUrl: 'https://build.nvidia.com/',
    discoverable: true,
    auth: { envVar: 'NVIDIA_API_KEY' },
    classify: {
      // NVIDIA NIM answers "Function '...' Not found for account ..." (404) for a
      // model withdrawn from the account. Permanent: no retry can restore it.
      dead: [/not found for account/i],
    },
  },
  groq: {
    label: 'Groq',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
    contextUrl: 'https://console.groq.com/docs/models',
    signupUrl: 'https://console.groq.com/',
    discoverable: true,
    auth: { envVar: 'GROQ_API_KEY' },
    sanitize: { strips: ['reasoning_content'], rejectsUnknownFields: true },
    classify: {
      // Groq's model_terms_required: unusable until an admin accepts the licence.
      incompatible: [/requires terms acceptance|model_terms_required|terms (?:have|has) not been accepted/i],
    },
  },
  cerebras: {
    label: 'Cerebras',
    chatUrl: 'https://api.cerebras.ai/v1/chat/completions',
    contextUrl: 'https://api.cerebras.ai/public/v1/models?format=openrouter',
    signupUrl: 'https://cloud.cerebras.ai/',
    discoverable: true,
    // Cerebras' /v1/models only reports a subset of what the free tier actually serves
    // (confirmed live: 2 models via the public list), so keep the curated rows even when
    // discovery returns a healthy list. Most providers leave this unset, making discovery
    // authoritative and pruning retired models.
    keepStaticOnDiscovery: true,
    auth: { envVar: 'CEREBRAS_API_KEY' },
  },
  opencode: {
    label: 'OpenCode Zen',
    chatUrl: 'https://opencode.ai/zen/v1/chat/completions',
    signupUrl: 'https://opencode.ai/auth',
    // Optional bearer: the free models answer without a key, and a key only raises limits.
    auth: { envVar: 'OPENCODE_API_KEY', optional: true },
    classify: {
      // A cataloged free model whose upstream was withdrawn (HTTP 400, "Model is
      // unavailable."). Verified live 2026-09-16: the id stays listed in /v1/models
      // while the backend no longer serves it.
      dead: [/model is unavailable/i],
    },
  },
  empero: {
    label: 'Empero Free',
    chatUrl: 'https://free.empero.org/v1/chat/completions',
    contextUrl: 'https://free.empero.org/',
    signupUrl: 'https://free.empero.org/',
    discoverable: true,
    auth: { envVar: 'EMPERO_API_KEY', optional: true },
  },
  'openai-compatible': {
    label: 'OpenAI-Compatible',
    // Endpoint-less by design: every instance carries its own URL in config.
    chatUrl: null,
    instanceBased: true,
    signupUrl: 'https://platform.openai.com/docs/api-reference/chat',
    auth: {
      envVar: 'OPENAI_COMPATIBLE_API_KEY',
      baseUrlEnvVar: 'OPENAI_COMPATIBLE_BASE_URL',
      modelIdEnvVar: 'OPENAI_COMPATIBLE_MODEL',
    },
  },
  devin: {
    label: 'Devin SWE',
    chatUrl: 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage',
    contextUrl: 'https://devin.ai/',
    signupUrl: 'https://app.devin.ai/',
    auth: { kind: 'oauth', envVar: 'DEVIN_API_KEY', legacySecretField: 'sessionToken' },
  },
  ollama: {
    label: 'Ollama',
    chatUrl: null,
    instanceBased: true,
    signupUrl: 'https://docs.ollama.com/cloud',
    // Deliberately NOT `optional: true`: hosted Ollama (the default base URL is
    // https://ollama.com/v1) requires a key, and only a *local* base URL is keyless.
    // That condition is dynamic — it depends on the configured base URL — so it cannot
    // live in this static descriptor. `isProviderAuthOptional` in lib/server.js owns it,
    // and marking this optional here would silently dispatch keyless requests at hosted
    // Ollama instead of refusing them as NO_KEY.
    auth: {
      envVar: 'OLLAMA_API_KEY',
      baseUrlEnvVar: 'OLLAMA_BASE_URL',
      modelIdEnvVar: 'OLLAMA_MODEL',
    },
  },
  openrouter: {
    label: 'OpenRouter',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    contextUrl: 'https://openrouter.ai/api/v1/models',
    signupUrl: 'https://openrouter.ai/settings/keys',
    discoverable: true,
    auth: { envVar: 'OPENROUTER_API_KEY' },
  },
  codestral: {
    label: 'Codestral',
    // No public /v1/models endpoint exists on codestral.mistral.ai (verified: 404
    // / no route); the static catalog in sources.js is complete. Kept manual.
    chatUrl: 'https://codestral.mistral.ai/v1/chat/completions',
    contextUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    signupUrl: 'https://codestral.mistral.ai/',
    auth: { envVar: 'CODESTRAL_API_KEY' },
  },
  scaleway: {
    label: 'Scaleway',
    chatUrl: 'https://api.scaleway.ai/v1/chat/completions',
    contextUrl: 'https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/',
    signupUrl: 'https://console.scaleway.com/iam/api-keys',
    discoverable: true,
    auth: { envVar: 'SCALEWAY_API_KEY' },
  },
  kilocode: {
    label: 'KiloCode',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    contextUrl: 'https://api.kilo.ai/api/gateway/models',
    signupUrl: 'https://kilo.ai/',
    auth: { envVar: 'KILOCODE_API_KEY', optional: true },
  },
  kiro: {
    label: 'Kiro',
    // Proprietary EventStream API (no /v1/models surface) — the catalog in sources.js
    // is the complete static list. Kept manual.
    chatUrl: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
    contextUrl: 'https://kiro.dev/docs/cli/reference/models/',
    signupUrl: 'https://kiro.dev/',
    auth: { kind: 'oauth', legacySecretField: 'refreshToken' },
  },
  googleai: {
    label: 'Google AI',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    contextUrl: 'https://ai.google.dev/gemma/docs/core/model_card_3',
    signupUrl: 'https://aistudio.google.com/apikey',
    discoverable: true,
    auth: { envVar: 'GOOGLE_API_KEY' },
    classify: {
      // Google AI: model exists but isn't compatible with generateContent (404).
      dead: [/not found for api version/i],
    },
  },
  // --- GitHub Copilot ---------------------------------------------------------
  // Copilot is OpenAI-compatible on the wire (api.githubcopilot.com/chat/completions)
  // but has no API keys: it authenticates with a GitHub OAuth token obtained from the
  // device flow, carried as a bearer plus Copilot client-identity headers, and charges
  // against the account's plan-based premium-request quota. The catalog in sources.js is
  // only the pre-sign-in fallback; once a token is configured the live /models endpoint
  // replaces it. Deliberately NOT `discoverable`: that path assumes an OpenAI-style
  // /v1/models probe, while Copilot serves /models at the host root behind its own
  // client-identity headers. lib/server.js refreshes it through the Copilot path.
  'github-copilot': {
    label: 'GitHub Copilot',
    chatUrl: 'https://api.githubcopilot.com/chat/completions',
    contextUrl: 'https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements',
    // Sign-in is an OAuth device flow (no dashboard key); this link is where a user
    // checks the plan that backs their free usage. Deliberately kind `bearer` rather
    // than `oauth`: Copilot's token is a device-flow credential carried as a plain
    // bearer, and it has no account pool — config.js derives OAUTH_ACCOUNT_PROVIDERS
    // from this field, and Copilot is not part of that rotation.
    signupUrl: 'https://github.com/settings/copilot',
    auth: { envVar: 'GITHUB_COPILOT_TOKEN' },
  },
  // --- OpenAI Codex -----------------------------------------------------------
  // The ChatGPT subscription surface. It is *not* OpenAI-compatible: calls go to the
  // Responses API (/codex/responses), authenticate with a short-lived ChatGPT OAuth
  // access token plus a `chatgpt-account-id` workspace header, and always stream SSE.
  // lib/openai-codex.js owns the translation; lib/server.js exchanges the stored refresh
  // token for an access token on demand. Deliberately NOT `discoverable`: Codex serves
  // its own model list from the account-authenticated backend.
  'openai-codex': {
    label: 'OpenAI Codex',
    chatUrl: 'https://chatgpt.com/backend-api/codex/responses',
    contextUrl: 'https://developers.openai.com/codex/',
    signupUrl: 'https://chatgpt.com/codex',
    auth: {
      kind: 'oauth',
      // Deliberately no envVar: the credential is a ChatGPT OAuth *refresh* token, which
      // is exchanged for a short-lived access token rather than sent as a bearer.
      legacySecretField: 'refreshToken',
      refreshTokenEnvVar: 'OPENAI_CODEX_REFRESH_TOKEN',
    },
  },
  freemodels: {
    label: 'FreeModels',
    chatUrl: 'https://freemodels-chat.freemodels.workers.dev',
    contextUrl: 'https://freemodels.pro',
    // No signupUrl: FreeModels routes real keyless browser traffic and has no dashboard
    // key to obtain. It was the one provider missing from the old signup table, which is
    // exactly the kind of gap a per-provider record makes visible.
    auth: { optional: true },
  },
  // --- gpt4free (g4f) ---------------------------------------------------------
  // One provider for the whole gpt4free service. g4f.space/v1 is the hosted gateway
  // (many models, discovered from /models). Anonymous traffic is gated behind baked
  // proof-of-work credits, so hammer requires the free account key from
  // https://g4f.dev/members.html — set it once and it covers the whole gateway.
  g4f: {
    label: 'G4F',
    chatUrl: 'https://g4f.space/v1/chat/completions',
    contextUrl: 'https://g4f.dev/members.html',
    signupUrl: 'https://g4f.dev/members.html',
    discoverable: true,
    auth: { envVar: 'G4F_API_KEY', baseUrlEnvVar: 'G4F_BASE_URL' },
    classify: {
      // Relay gateways advertise a model that no backend server actually serves —
      // "No server found that supports model 'X'" (404). A permanent catalog failure,
      // not a transient provider outage.
      dead: [/no (?:server|provider|backend) (?:was )?found (?:that )?(?:supports?|for) (?:the )?model/i],
    },
  },
  // --- gptfree.com ------------------------------------------------------------
  // A consumer chat site, not a platform: no published API, no keys, no /v1 surface.
  // Its web app signs in anonymously against the project's own Firebase instance and
  // posts one message to a single Cloud Function, which is what hammer does too. The
  // credential is a minted anonymous ID token, hence auth.kind `token-mint`.
  // Its model row is an auto route rather than a model, so it is never a model in the
  // routing decisions. Deliberately NOT `discoverable` — there is no list to discover.
  gptfree: {
    label: 'GPTFree',
    chatUrl: 'https://us-central1-gptfree-2.cloudfunctions.net/agent_stream',
    contextUrl: 'https://gptfree.com/',
    // There is no key to obtain: the backend is reached by signing in anonymously from
    // the site itself, which hammer does on your behalf. This link is the site, not a
    // credential page.
    signupUrl: 'https://gptfree.com/',
    auth: { kind: 'token-mint', optional: true },
    // Not on OmniRoute's caution list, and not something to assert either way: the site
    // publishes no API terms, so no review is possible. `unknown` is the honest flag.
    tos: 'unknown',
    notes: 'Consumer chat site with no public API; reached by minting an anonymous token. No published terms covering programmatic use.',
  },
}

/** Attach the published quota record to each descriptor that has one. */
for (const [key, descriptor] of Object.entries(PROVIDER_DESCRIPTORS)) {
  if (PROVIDER_QUOTAS[key]) descriptor.quota = PROVIDER_QUOTAS[key]
}
