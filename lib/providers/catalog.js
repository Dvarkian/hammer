/**
 * ── The provider catalog: one object per provider ──────────────────────────────────────
 *
 * This file is the single home for every fact about a provider that is not its model
 * list. Those facts previously lived in five places and had to be kept in sync by hand:
 *
 *   - `sources.js`               -> `PROVIDER_QUOTAS` (now defined here instead: a quota is
 *                                   a fact about a provider, which is this file's subject,
 *                                   and holding it here is what lets the registry *derive*
 *                                   the table from the descriptors)
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
 * This module imports nothing from `sources.js` any more, and nothing here imports the
 * registry, so there is no cycle: `sources.js`, `lib/config.js` and `lib/server.js` can all
 * read it.
 */

/**
 * Known free-tier quotas per provider. These are published limits that
 * don't always appear in x-ratelimit-* response headers, but are useful
 * for the dashboard Quota column to know how much headroom remains.
 *
 * Numeric fields are reserved for authoritative provider-reported values. Do
 * not add tier/free-plan estimates here: account, project, model, and billing
 * limits vary too widely to safely display as usage limits.
 *
 * Moved here from `sources.js`, where it was the last table the registry described itself
 * as replacing while still reading it from the other side. It is attached to each
 * descriptor below, so `providerQuotaTable()` derives the table from the descriptors
 * instead of the reverse.
 */
export const PROVIDER_QUOTAS = {
  nvidia: {
    source:
      'Free endpoints run to 40 requests/minute per account; NVIDIA lists the active limit in the console and no per-token billing applies',
    sourceUrl: 'https://build.nvidia.com/faqs',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 40, period: 'minute', label: 'free endpoints' }],
  },
  groq: {
    source:
      'Free tier is 30 requests/minute and 1,000 requests/day per organization (per-model token limits also apply)',
    sourceUrl: 'https://console.groq.com/docs/rate-limits',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 30, period: 'minute', label: 'free tier' },
      { metric: 'requests', limit: 1_000, period: 'day', label: 'free tier' },
    ],
  },
  googleai: {
    // Google publishes the free tier per model, not per project: AI Studio's rate-limit page
    // lists each model's RPM, input TPM and RPD. Provider-wide fields stay empty; the model
    // records below carry the figures, so no row borrows another model's allowance.
    source:
      'Free-tier limits are published per model in AI Studio (RPM, input TPM and RPD); the figures below are limits, never a usage reading',
    sourceUrl: 'https://aistudio.google.com/rate-limit',
  },
  openrouter: {
    source:
      'Free models are limited to 20 requests/minute and 50 requests/day; paid usage draws on account credits',
    sourceUrl: 'https://openrouter.ai/docs/api-reference/limits',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 20, period: 'minute', label: 'free models' },
      { metric: 'requests', limit: 50, period: 'day', label: 'free models' },
    ],
  },
  codestral: {
    // Codestral now rides the same Mistral free mode as the rest of the catalogue: the exact
    // numbers are console-only, and the community probe's 1 RPS is what the row can stand on.
    source:
      'Codestral usage follows Mistral free mode: per-model requests/second, tokens/minute and tokens/month are shown in the Admin panel, and free-tier probes report 1 request/second',
    sourceUrl: 'https://docs.mistral.ai/admin/billing-usage/usage-limits',
    window: 'minute',
    limitScope: 'account',
    numericSource: 'community header probe 2026-02-23',
    limits: [
      { metric: 'requests', limit: 60, period: 'minute', label: 'free mode (reported 1 RPS)' },
    ],
  },
  kiro: {
    source:
      'Kiro Free includes 50 credits/month with access to open-weight models and Claude Sonnet; paid plans start at 1,000 credits/month',
    sourceUrl: 'https://kiro.dev/pricing/',
    window: 'month',
    limitScope: 'account',
    limits: [{ metric: 'credits', limit: 50, period: 'month', label: 'Kiro Free' }],
  },
  kilocode: {
    source:
      'KiloCode serves its `kilo-auto/free` pool keyless at 200 requests/hour per IP; the $0 plan carries no hosted credit and paid plans are account-managed',
    sourceUrl: 'https://kilocode.ai/pricing',
    window: 'hour',
    limitScope: 'account',
    limits: [
      {
        metric: 'requests',
        limit: 200,
        period: 'hour',
        label: 'kilo-auto/free pool, per IP',
      },
    ],
  },
  'github-copilot': {
    window: 'month',
    limitScope: 'account',
    source:
      'GitHub Copilot premium-request quota is plan-managed and resets monthly; the dashboard reads it from the account quota endpoint',
    sourceUrl:
      'https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements',
  },
  'openai-codex': {
    window: 'rolling',
    limitScope: 'account',
    source:
      'ChatGPT plan limits are subscription-managed rolling windows; the dashboard reads the remaining primary/secondary windows from the account usage endpoint',
    sourceUrl: 'https://developers.openai.com/codex/',
  },
  g4f: {
    source:
      'Anonymous g4f.space calls are limited to 5 requests/minute; a free account key raises the limit, and anonymous traffic otherwise needs baked proof-of-work credits',
    sourceUrl: 'https://g4f.dev/members.html',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 5, period: 'minute', label: 'anonymous' }],
  },
  gptfree: {
    // The one provider whose own page states there is no usage limit. This is the only
    // kind of record allowed to draw ∞: no allowance exists to exhaust, so no estimator
    // may invent one.
    unlimited: true,
    source: 'No usage limit: gptfree advertises unlimited anonymous chat',
    sourceUrl: 'https://gptfree.com/',
  },
  devin: {
    source: 'Devin account and plan limits are provider-managed',
    sourceUrl: 'https://devin.ai/pricing/',
  },
  ollama: {
    source:
      'Ollama local limits are hardware/configuration based; cloud limits are account-managed',
    sourceUrl: 'https://docs.ollama.com/api/usage',
    // The hosted plan's monthly grant used to reach this descriptor through the vendored
    // roster's `ollama-cloud` row, which was retired on 2026-11-08 as a duplicate of this
    // provider. The figure and its attribution move here with it so the card keeps publishing
    // the number, and `appliesToHosts` stays because this key also serves a local server whose
    // limits are hardware-bound: the hosted grant must not be read against local traffic.
    steadyTokensPerMonth: 20_000_000,
    numericSource: 'OmniRoute free-tier roster',
    appliesToHosts: ['ollama.com'],
  },
  orcarouter: {
    source:
      'Free ids are the `-free` suffix plus the `orcarouter/free` router: 10 RPM and 50 requests/day (5/50 orcaverify, 50/250 hy4-preview), lifting to 20 RPM / 800 per day after $20 lifetime spend; every other id bills at provider rates',
    sourceUrl: 'https://www.orcarouter.ai/offers',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 10, period: 'minute', label: 'free ids' },
      { metric: 'requests', limit: 50, period: 'day', label: 'free ids' },
    ],
  },
  requesty: {
    source:
      'Free-model usage is capped per organization at 20 requests/minute and 200 requests/day; paying organizations get 60/minute and 1,000/day',
    sourceUrl: 'https://docs.requesty.ai/features/free-models',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 20, period: 'minute', label: 'free models' },
      { metric: 'requests', limit: 200, period: 'day', label: 'free models' },
    ],
  },
  agnes: {
    source:
      'Free/default keys run on a 30 requests/minute pool; plan quotas add 5-hour and weekly request caps',
    sourceUrl: 'https://wiki.agnes-ai.com/en/docs/tokenplan',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 30, period: 'minute', label: 'free/default key' }],
  },
  'api-airforce': {
    source: 'Free plan is 1 request/minute and 1,000 requests/day per key',
    sourceUrl: 'https://api.airforce/docs/quickstart',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 1, period: 'minute', label: 'free plan' },
      { metric: 'requests', limit: 1_000, period: 'day', label: 'free plan' },
    ],
  },
  llm7: {
    source:
      'Free tier is 1 request/second, 60/minute and 250/hour, with a 100,000-token rolling 24-hour cap',
    sourceUrl: 'https://docs.llm7.io/limits',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 60, period: 'minute', label: 'free tier' },
      { metric: 'requests', limit: 250, period: 'hour', label: 'free tier' },
    ],
  },
  bazaarlink: {
    source:
      'Free access runs at 10 requests/minute with 2 concurrent requests and 60 weighted units/day',
    sourceUrl: 'https://bazaarlink.ai/',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 10, period: 'minute', label: 'free access' }],
  },
  inferx: {
    source:
      'One $0 promotional endpoint (`deepseek-v4.1-flash-1017-basic`) on a per-token gateway; every other model is metered, no usage API is published, and a spent tenant answers every id with 429 "tenant … quota exceeded"',
    sourceUrl: 'https://inferx.net/models',
  },
  puter: {
    // The account meter publishes a monthly credit allowance, but it is per plan and this
    // record deliberately states no figure: hammer read 1,000 credits on one free account,
    // which is not every account's number. The window is the true part.
    window: 'month',
    limitScope: 'account',
    source:
      'Usage is charged at real provider cost against a monthly account allowance; free accounts get a monthly grant, paid plans more, and purchased credits are spent after it',
    sourceUrl: 'https://docs.puter.com/rate-limits-and-quotas/',
  },
  tokenharbor: {
    // The gateway states request quotas per account, with a separate (higher) allowance per
    // source IP. The record is account-scoped, so the account figures are the bars and the IP
    // figures travel in their labels: the schema keeps one limit per metric+period, and two
    // `requests`/`minute` entries would collapse into one.
    window: 'rolling',
    limitScope: 'account',
    limits: [
      {
        metric: 'requests',
        limit: 60,
        period: 'minute',
        label: 'per account (100/min per IP)',
      },
      {
        metric: 'requests',
        limit: 1_800,
        period: 'hour',
        label: 'per account (3,000/hour per IP)',
      },
    ],
    source:
      'Request quotas are 60/min and 1,800/hour per account (100/min and 3,000/hour per IP); free `:free` routes also draw on a rolling seven-day list-price allowance reported in x-th-free-used-pct and reset in x-th-free-resets, while every other id bills the wallet',
    sourceUrl: 'https://tokenharbor.ai/pricing',
  },
  moonmath: {
    // Free-plan size is not published; the recurring daily request ceiling was measured by
    // third-party probes and is labelled as such. The pre-top-up throttle is 1 request/minute.
    window: 'day',
    limitScope: 'account',
    source:
      'Free plan includes daily usage on GLM-5.3 Flash and DeepSeek V4.1 Flash; a third-party probe measured 2,000 successful requests/day and a 1 request/minute throttle before the first top-up',
    sourceUrl: 'https://zro.moonmath.ai/docs/plans',
    numericSource: 'community probe list, 2026-11-03',
    limits: [{ metric: 'requests', limit: 2_000, period: 'day', label: 'free plan (reported)' }],
  },
  baidu: {
    // Qianfan publishes a default flow control per model; ERNIE 5.x is the slowest tier and
    // ERNIE 4.5 Turbo the fastest, so the conservative published figure is the former. The
    // new-user grant is per model (17 models x 1M tokens, 3 months, online inference only).
    source:
      'Qianfan default flow control is per model: ERNIE 5.x 60 RPM / 150,000 TPM, ERNIE 4.5 Turbo 5,000 RPM / 400,000 TPM. New users get 1,000,000 tokens on each of 17 preset models, valid 3 months, online inference only.',
    sourceUrl: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
    window: 'minute',
    limitScope: 'account',
    numericSource: 'Qianfan model list (read 2026-11-10); new-user quota doc',
    limits: [
      { metric: 'requests', limit: 60, period: 'minute', label: 'ERNIE 5.x default flow control' },
      {
        metric: 'tokens',
        limit: 150_000,
        period: 'minute',
        label: 'ERNIE 5.x default flow control',
      },
    ],
  },
  bluesminds: {
    source:
      'Free plan is 20 RPM, 300 requests/day and 500 pi credits on signup; paid plans raise RPM but not the daily cap',
    sourceUrl: 'https://doc.bluesminds.com/',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 20, period: 'minute', label: 'free plan' },
      { metric: 'requests', limit: 300, period: 'day', label: 'free plan' },
      { metric: 'credits', limit: 500, period: 'lifetime', label: 'pi credits on signup' },
    ],
  },
  'cloudflare-ai': {
    // Workers AI caps text generation at 300 RPM and the free plan at 10,000 Neurons/day;
    // neurons are compute units, not tokens, so only the request ceiling is encoded here.
    source:
      'Text generation is capped at 300 requests/minute per account; the Workers Free plan includes 10,000 Neurons/day (resets 00:00 UTC), and some frontier models require Workers Paid',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/platform/limits',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 300, period: 'minute', label: 'text generation' }],
  },
  cohere: {
    source:
      'Trial keys are limited to 20 chat requests/minute and 1,000 API calls/month (30-day rolling window); production keys are 500 RPM',
    sourceUrl: 'https://docs.cohere.com/docs/rate-limits',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 20, period: 'minute', label: 'trial key, chat' },
      { metric: 'requests', limit: 1_000, period: 'month', label: 'trial key, all endpoints' },
    ],
  },
  'glm-cn': {
    // Zhipu limits API usage by concurrent requests, not RPM: the free tier is 5 in flight.
    // The same number is the free-tier RPM note third-party trackers publish.
    source:
      'API usage is limited by concurrency: the free tier allows 5 concurrent requests per model (GLM-4-Flash and the Flash line are free to call; rate table also lists 5 RPM for free accounts)',
    sourceUrl: 'https://bigmodel.cn/dev/howuse/rate-limits',
    window: 'minute',
    limitScope: 'account',
    numericSource: 'BigModel rate-limiting guide (concurrency table)',
    limits: [
      { metric: 'requests', limit: 5, period: 'minute', label: 'free concurrency (5 in flight)' },
    ],
  },
  'google-antigravity': {
    // Google publishes that a quota exists and that it refreshes weekly for free users,
    // but no request, prompt or task count: the usage panel is the only authority.
    window: 'week',
    limitScope: 'account',
    source:
      'Free and Plus users receive a meaningful weekly quota for Gemini models, refreshed weekly, with a weekly rate limit; Google publishes no request or task counts and the usage panel is authoritative',
    sourceUrl: 'https://antigravity.google/docs/plans',
  },
  iflytek: {
    // Spark Lite is permanently free with no token cap; the published ceiling is 2 QPS.
    source:
      'Spark Lite is permanently free with no token cap and a 2 QPS (120 requests/minute) limit per App ID; Pro/Max/4.0 Ultra are paid and trial token packs are one-off',
    sourceUrl: 'https://www.xfyun.cn/doc/spark/Web.html',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 120, period: 'minute', label: 'Spark Lite, 2 QPS' }],
  },
  mistral: {
    // Mistral does not publish exact free-mode numbers: the Admin panel shows per-model RPS,
    // tokens/minute and tokens/month. Community header probes on the free tier measured
    // 1 req/s and 500k tokens/minute, so those are labelled as reported, not published.
    source:
      'Free mode enforces requests/second, tokens/minute and tokens/month per model; exact figures are shown in the Admin panel, and free-tier probes report 1 request/second and 500,000 tokens/minute',
    sourceUrl: 'https://docs.mistral.ai/admin/billing-usage/usage-limits',
    window: 'minute',
    limitScope: 'account',
    numericSource: 'Mistral Admin limits page; community header probe 2026-02-23',
    limits: [
      { metric: 'requests', limit: 60, period: 'minute', label: 'free mode (reported 1 RPS)' },
      { metric: 'tokens', limit: 500_000, period: 'minute', label: 'free mode (reported)' },
    ],
  },
  morph: {
    source:
      'Free tier is 200 requests/month and 250K credits; each Fast Apply, WarpGrep or Compact call counts as one request, and per-token or plan-credit pricing applies past the cap',
    sourceUrl: 'https://www.morphllm.com/pricing',
    window: 'month',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 200, period: 'month', label: 'free tier' },
      { metric: 'credits', limit: 250_000, period: 'month', label: 'free tier' },
    ],
  },
  'nous-research': {
    source:
      'The Free plan is limited to free models at 50 requests/minute and 500,000 tokens/minute; paid tiers raise RPM (Plus 400, Super 800, Ultra 1,600)',
    sourceUrl: 'https://portal.nousresearch.com/api-docs',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 50, period: 'minute', label: 'free plan' },
      { metric: 'tokens', limit: 500_000, period: 'minute', label: 'free plan' },
    ],
  },
  qoder: {
    // The free plan itself has no published number; the 300 credits belong to the one-time
    // 14-day Pro trial, so they are recorded as a lifetime grant, not a monthly allowance.
    source:
      'Free plan serves basic models subject to daily and monthly limits; new users get a 14-day Pro trial with 300 credits, and paid plans start at 1,000 credits/month',
    sourceUrl: 'https://docs.qoder.com/account/pricing',
    window: 'lifetime',
    limitScope: 'account',
    limits: [{ metric: 'credits', limit: 300, period: 'lifetime', label: '14-day Pro trial' }],
  },
  reka: {
    source:
      'Each API key allows 60 requests/minute (burst 30) across all models; free accounts also receive $10 in credits refreshed monthly',
    sourceUrl: 'https://docs.reka.ai/research/errors',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 60, period: 'minute', label: 'per API key' }],
  },
  sambanova: {
    source:
      'Free Tier (no payment method linked) is 20 requests/minute, 20 requests/day and 200,000 tokens/day, applied per model; linking a card moves the account to Developer Tier',
    sourceUrl: 'https://docs.sambanova.ai/docs/en/models/rate-limits',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 20, period: 'minute', label: 'free tier, per model' },
      { metric: 'requests', limit: 20, period: 'day', label: 'free tier, per model' },
      { metric: 'tokens', limit: 200_000, period: 'day', label: 'free tier, per model' },
    ],
  },
  siliconflow: {
    source:
      'Free models have fixed, per-account limits (not per key): chat models run 1,000 RPM and 50,000 TPM, and spending on paid models does not raise them',
    sourceUrl: 'https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation',
    window: 'minute',
    limitScope: 'account',
    limits: [
      { metric: 'requests', limit: 1_000, period: 'minute', label: 'free models' },
      { metric: 'tokens', limit: 50_000, period: 'minute', label: 'free models' },
    ],
  },
  sparkdesk: {
    // Same Spark Lite entitlement as `iflytek`; the two keys serve different endpoints.
    source:
      'Spark Lite is permanently free with no token cap and a 2 QPS (120 requests/minute) limit per App ID; the free tier is for personal, non-commercial use',
    sourceUrl: 'https://www.xfyun.cn/doc/spark/Web.html',
    window: 'minute',
    limitScope: 'account',
    limits: [{ metric: 'requests', limit: 120, period: 'minute', label: 'Spark Lite, 2 QPS' }],
  },
  'openai-compatible': {
    source: 'Upstream-specific limits; hammer reports only headers and provider errors',
  },
}

// Google publishes the free tier per model, not per project: one provider record cannot
// describe it without drawing Gemini 2.5 Pro's 0 RPD against Flash's 20. The table below is
// the AI Studio free-tier page read on 2026-11-11; every figure is a limit, never a usage
// reading. Matching is on the model id after its `models/` namespace.
const googleFreeLimits = (rpm, tpm, rpd) => [
  { metric: 'requests', limit: rpm, period: 'minute', label: 'free tier' },
  { metric: 'tokens', limit: tpm, period: 'minute', label: 'free tier' },
  { metric: 'requests', limit: rpd, period: 'day', label: 'free tier' },
]

const googleLiveTokens = (tpm) => [
  { metric: 'tokens', limit: tpm, period: 'minute', label: 'free tier, live' },
]

/** Per-model published limits, for providers whose allowance depends on the model id. */
export const MODEL_QUOTAS = {
  googleai: [
    // Positive free-tier allowances, exactly as AI Studio lists them per model. A model id
    // that is not in this table is deliberately left unknown rather than given a neighbour's
    // figure: Google omitted it from this project's table, so no limit is published.
    {
      match:
        /(?:^|\/)(gemini-3\.6-flash|gemini-3\.8-flash|gemini-3-flash(?:-preview)?|gemini-2\.5-flash)$/,
      limits: googleFreeLimits(5, 250_000, 20),
    },
    {
      match: /(?:^|\/)(gemini-3\.5-flash-lite|gemini-3\.1-flash-lite(?:-preview)?)$/,
      limits: googleFreeLimits(15, 250_000, 500),
    },
    {
      match: /(?:^|\/)gemini-2\.5-flash-lite$/,
      limits: googleFreeLimits(10, 250_000, 20),
    },
    {
      match: /(?:^|\/)gemini-3\.5-transcribe$/,
      limits: googleFreeLimits(3, 10_000, 25),
    },
    {
      match: /(?:^|\/)gemini-robotics-er-2(?:-streaming)?-preview$/,
      limits: googleFreeLimits(5, 250_000, 20),
    },
    {
      match: /(?:^|\/)gemma-4-(?:26b-a4b|31b)-it$/,
      limits: googleFreeLimits(30, 16_000, 14_400),
    },
    {
      match: /(?:^|\/)antigravity-preview-/,
      limits: googleFreeLimits(60, 100_000, 100),
    },
    {
      // Real TTS ids include `gemini-2.5-flash-preview-tts`; accept either side of the
      // preview marker so a renamed preview still reads the same published allowance.
      match:
        /(?:^|\/)(?:gemini-2\.5|gemini-3\.1|gemini-3\.8)-flash(?:-lite)?-(?:preview-)?tts(?:-preview)?$/,
      limits: googleFreeLimits(3, 10_000, 10),
    },
    {
      match: /(?:^|\/)gemini-embedding-\d+$/,
      limits: googleFreeLimits(100, 30_000, 1_000),
    },
    // Live API rows publish no request ceiling (AI Studio prints "Unlimited"), so only the
    // token/minute figure is encodable; a request bar would be invented.
    {
      match: /(?:^|\/)gemini-2\.5-flash-native-audio-/,
      limits: googleLiveTokens(1_000_000),
    },
    {
      match: /(?:^|\/)gemini-3-flash-live$/,
      limits: googleLiveTokens(65_000),
    },
    {
      match: /(?:^|\/)(?:gemini-3\.5-live-translate|gemini-3\.5-transcribe-live)(?:-preview)?$/,
      limits: googleLiveTokens(20_000),
    },
    {
      match: /(?:^|\/)gemini-3\.8-live(?:-extended-thinking)?$/,
      limits: googleLiveTokens(65_000),
    },
    // AI Studio lists these with a published 0 RPM / 0 TPM / 0 RPD: the model exists, but the
    // free tier grants it no allowance. Encoding the zero is the honest reading; omitting the
    // row would draw "limit not published", which is a different claim.
    {
      match: /(?:^|\/)gemini-(?:2\.5-pro|3\.1-pro(?:-preview)?(?:-customtools)?)$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)gemini-2\.5-pro(?:-preview)?-tts$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)deep-research-pro-preview(?:-\d{2}-\d{4})?$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)gemini-2\.5-computer-use-preview(?:-\d{2}-\d{4})?$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)nano-banana-pro(?:-preview)?$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)gemini-nano-banana-2\.1$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)gemini-omni-1\.[12]-flash$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)lyria-3-(?:clip|pro)(?:-preview)?$/,
      limits: googleFreeLimits(0, 0, 0),
    },
    {
      match: /(?:^|\/)gemini-4-(?:argon|carbon)$/,
      limits: googleFreeLimits(0, 0, 0),
    },
  ],
}

/**
 * The published allowance for one model row, when the vendor's limit is per model.
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @returns {object|null} a quota record with `limitScope: 'model'`, or null
 */
export function modelQuotaFor(providerKey, modelId) {
  const rules = MODEL_QUOTAS[providerKey]
  if (!rules) return null
  const rule = rules.find((candidate) => candidate.match.test(String(modelId || '')))
  if (!rule) return null
  const base = PROVIDER_QUOTAS[providerKey] || {}
  return {
    source: base.source,
    sourceUrl: base.sourceUrl,
    numericSource: 'Google AI Studio free-tier limits (read 2026-11-11)',
    window: 'minute',
    limitScope: 'model',
    limits: rule.limits,
  }
}

export const PROVIDER_USAGE_URLS = {}

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
    // The label is the product; a console naming which provider answered wants the brand.
    brand: 'NVIDIA',
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
      incompatible: [
        /requires terms acceptance|model_terms_required|terms (?:have|has) not been accepted/i,
      ],
    },
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
    // live in this static descriptor. `isProviderAuthOptional` in
    // lib/providers/discovery.js owns it,
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
    contextUrl: 'https://ai.google.dev/gemini-api/docs/models',
    signupUrl: 'https://aistudio.google.com/apikey',
    discoverable: true,
    // The primary credential is a Google account sign-in: its access token is accepted by
    // this same OpenAI-compatible endpoint with `x-goog-user-project`, and it is the only
    // credential that can read the project's Code Assist quota. GOOGLE_API_KEY remains
    // supported as a fallback for configs that never sign in.
    auth: {
      kind: 'oauth',
      envVar: 'GOOGLE_API_KEY',
      legacySecretField: 'refreshToken',
      refreshTokenEnvVar: 'GOOGLE_REFRESH_TOKEN',
    },
    classify: {
      // Google AI: model exists but isn't compatible with generateContent (404).
      dead: [/not found for api version/i],
    },
  },
  // --- Google Antigravity -----------------------------------------------------
  // Gemini and Claude through Google's Cloud Code Assist backend, which is the one Google
  // surface that accepts a sign-in instead of an API key (the Generative Language API does
  // not, and Gemini CLI's client is refused outright). `auth.kind: 'oauth'` is what puts this
  // key in the account-pool table, so `getProviderAccounts` can see the sign-in — without it a
  // completed login was invisible and the card kept saying "0 models". `legacySecretField` is
  // required by the schema for every oauth provider and names the pre-pool single credential
  // (an Antigravity refresh token). Deliberately NOT `discoverable`: `fetchAvailableModels`
  // answers 403 even for an entitled account, so the roster is curated in `sources.js` and the
  // wire is served by the loopback shim in `lib/google-antigravity.js`.
  'google-antigravity': {
    label: 'Google Antigravity',
    chatUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
    contextUrl: 'https://antigravity.google',
    signupUrl: 'https://antigravity.google',
    access: 'oauth',
    auth: { kind: 'oauth', legacySecretField: 'refreshToken' },
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
    contextUrl:
      'https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements',
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
  // --- OrcaRouter --------------------------------------------------------------
  // A zero-markup gateway over ~40 upstream providers, keyed `sk-orca-`. Its free tier is the
  // model id: anything ending in `-free`, plus the `orcarouter/free` router that picks one of
  // them per request by difficulty, is served at $0 under request-rate limits; every other id
  // bills at the provider's own rate, which is why the account's wallet has to hold credit for
  // them. The free half is gated on the workspace owner having linked a GitHub account with
  // some history — a fresh one is refused — so a key can be valid and still reach nothing free.
  orcarouter: {
    label: 'OrcaRouter',
    chatUrl: 'https://api.orcarouter.ai/v1/chat/completions',
    contextUrl: 'https://api.orcarouter.ai/v1/models',
    signupUrl: 'https://www.orcarouter.ai/console',
    discoverable: true,
    // Recurring, rate-limited, no payment required: the $0 ids do not consume a balance and
    // the allowance is a request rate rather than a credit that runs out.
    access: 'permanent',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'ORCAROUTER_API_KEY' },
    notes:
      'Only `-free` ids and `orcarouter/free` are free; the other ~209 ids bill at provider rates. Free access needs a GitHub-linked account with history.',
  },
  // --- InferX ----------------------------------------------------------------
  // An OpenAI-compatible gateway whose catalogue is discovered from its own list. That list
  // carries no pricing block, so rows are classified from their probes and responses like any
  // other provider; hammer does not pre-label a curated set of InferX ids as Paid.
  //
  // The endpoint is `model.inferx.net`, not the `api.inferx.com` host on its developers page:
  // that name does not resolve (checked 2026-11-10), while the tenant endpoint answers the
  // catalogue and chat with a plain bearer key.
  inferx: {
    label: 'InferX',
    chatUrl: 'https://model.inferx.net/endpoints/v1/chat/completions',
    contextUrl: 'https://model.inferx.net/endpoints/v1/models',
    signupUrl: 'https://model.inferx.net/login',
    discoverable: true,
    // Not `permanent`: the $0 endpoint is a 100%-off listing the vendor can reprice, and the
    // rest of the catalogue is paid. `unknown` records that no recurring free grant exists
    // without claiming the promo never ends.
    access: 'unknown',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'INFERX_API_KEY' },
    notes:
      'OpenAI-compatible gateway at model.inferx.net/endpoints/v1; its model list publishes no pricing, so rows are classified by probes and errors rather than pre-labeled Paid.',
  },
  // --- Token Harbor -------------------------------------------------------------
  // A pay-as-you-go gateway (`tokenharbor.ai/v1`) whose free tier is the model id: anything
  // ending in `:free` draws on a rolling seven-day list-price allowance and is never billed,
  // and the gateway reports that allowance itself in `x-th-free-used-pct` (reset in
  // `x-th-free-resets`). Every other id bills the wallet, so an unfunded account answers 402
  // to the paid twin of a free model — which is why the metered half is marked Paid and never
  // probed.
  tokenharbor: {
    label: 'Token Harbor',
    chatUrl: 'https://tokenharbor.ai/v1/chat/completions',
    contextUrl: 'https://tokenharbor.ai/v1/models',
    signupUrl: 'https://tokenharbor.ai/dashboard/api-keys',
    discoverable: true,
    // Recurring, no card: the $0 routes are a rolling allowance rather than a sign-up credit,
    // and they stay $0 after it is spent (the request is refused, not billed).
    access: 'permanent',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'TOKENHARBOR_API_KEY' },
    notes:
      'Only `:free` ids are served at $0 under a rolling seven-day allowance; every other id bills the wallet. Requests are capped at 60/min and 1,800/hour per account (100/min and 3,000/hour per IP).',
  },
  // --- MoonMath (Zro) ---------------------------------------------------------
  // MoonMath's gateway is branded Zro: OpenAI-compatible chat at `zro.moonmath.ai/v1`, with
  // a Messages API on the same host. The Free plan includes daily usage on GLM-5.3 Flash and
  // DeepSeek V4.1 Flash and resets daily; other models need Pro or a usage pack, so rows are
  // classified by probes and refusals instead of being pre-labeled from a price list.
  moonmath: {
    label: 'MoonMath',
    chatUrl: 'https://zro.moonmath.ai/v1/chat/completions',
    contextUrl: 'https://zro.moonmath.ai/v1/models',
    signupUrl: 'https://zro.moonmath.ai/api-keys',
    discoverable: true,
    // Recurring, no card: the free flash allowance resets every day.
    access: 'permanent',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'MOONMATH_API_KEY' },
    notes:
      'OpenAI-compatible Zro gateway; the Free plan covers daily usage on GLM-5.3 Flash and DeepSeek V4.1 Flash, while other models need Pro or a usage pack.',
  },
  // --- Requesty ---------------------------------------------------------------
  // OpenAI-compatible router over 600+ models at `router.requesty.ai/v1`; free models need
  // no card, and pay-as-you-go adds 5% to provider rates (0% on a user's own provider keys).
  // The roster is discovered: its /v1/models includes account aliases and routing policies
  // that no static list could know.
  requesty: {
    label: 'Requesty',
    chatUrl: 'https://router.requesty.ai/v1/chat/completions',
    contextUrl: 'https://router.requesty.ai/v1/models',
    signupUrl: 'https://app.requesty.ai/api-keys',
    discoverable: true,
    // A free tier of free-id models exists, but the rest of the catalogue bills the wallet.
    access: 'unknown',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'REQUESTY_API_KEY' },
    notes:
      'OpenAI-compatible router over 600+ models; free models need no card, while pay-as-you-go adds 5% on routed traffic (0% on your own provider keys).',
  },
  // --- Agnes AI ----------------------------------------------------------------
  // OpenAI-compatible chat at `apihub.agnes-ai.com/v1`, keyed `sk-`. The catalogue is not
  // chat-only: image and video ids share the same `/v1/models` namespace and refuse a chat
  // request with 400, so the roster is curated in `sources.js` and discovery is off. Free
  // keys and Token Plan keys draw on separate limit pools, and the paid text models answer
  // 403 "Insufficient user quota" on an unfunded wallet — a payment wall, not a bad key.
  agnes: {
    label: 'Agnes AI',
    chatUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
    contextUrl: 'https://wiki.agnes-ai.com/en/docs/quickstart',
    signupUrl: 'https://platform.agnes-ai.com/',
    discoverable: false,
    // A free key exists but publishes no numbers this catalog can quote; the paid half is
    // wallet-billed.
    access: 'unknown',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    auth: { envVar: 'AGNES_API_KEY' },
    notes:
      'OpenAI-compatible gateway; the text models stream and call tools, while image and video ids share the same model namespace and cannot answer a chat completion.',
  },
  // --- Puter ------------------------------------------------------------------
  // Puter's free path is the `puter.ai` driver RPC (`POST /drivers/call`), not an OpenAI
  // endpoint: `/puterai/openai/v1/*` requires a paid plan and a free account answers 402
  // subscription_required (checked 2026-11-10). Auth is a dashboard token, and the call is
  // billed at real provider cost against that account's monthly allowance — user-pays, so
  // the developer pays nothing but the free tier is the allowance, not unlimited usage. The
  // roster is curated in `sources.js` because the catalogue lives at
  // `/puterai/chat/models/details`, which is not an OpenAI `/models` shape.
  puter: {
    label: 'Puter',
    chatUrl: 'https://api.puter.com/drivers/call',
    contextUrl: 'https://docs.puter.com/AI/chat/',
    signupUrl: 'https://puter.com/dashboard#account',
    auth: { envVar: 'PUTER_AUTH_TOKEN' },
    // A monthly allowance on the account, not a per-model free label.
    access: 'recurring',
    // No terms review has been recorded for programmatic use of this gateway.
    tos: 'unknown',
    notes:
      'User-pays: every call is billed at real provider cost against the account monthly allowance; the OpenAI-compatible endpoints need a paid plan, so hammer uses the driver RPC.',
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
      dead: [
        /no (?:server|provider|backend) (?:was )?found (?:that )?(?:supports?|for) (?:the )?model/i,
      ],
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
    notes:
      'Consumer chat site with no public API; reached by minting an anonymous token. No published terms covering programmatic use.',
  },
}

/** Attach the published quota record to each descriptor that has one. */
for (const [key, descriptor] of Object.entries(PROVIDER_DESCRIPTORS)) {
  if (PROVIDER_QUOTAS[key]) descriptor.quota = PROVIDER_QUOTAS[key]
}
