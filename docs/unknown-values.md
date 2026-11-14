# Unknown quota, rate-limit and intelligence values

Audit of the packaged build at `http://127.0.0.1:7352` on 2026-11-11. Source: `/api/models` (2106 rows) and `providerQuotaTable()`. Every item has been researched to a conclusion: either a published figure is encoded, or the vendor publishes none and the estimator/unknown bar is the honest state.

## Summary

| Provider           | Rows | No quota value | No published rate limit | Estimated intelligence | Status                                        |
| ------------------ | ---: | -------------: | ----------------------: | ---------------------: | --------------------------------------------- |
| googleai           |   48 |             12 |                      12 |                     32 | resolved — 23 limits, 13 zero, 12 unpublished |
| inferx             |   14 |             14 |                      14 |                      7 | resolved — no public figure                   |
| puter              |    6 |              6 |                       6 |                      3 | resolved — no public figure                   |
| devin              |    2 |              2 |                       2 |                      2 | resolved — no public figure                   |
| gptfree            |    1 |              1 |                       1 |                      1 | ∞ (vendor states unlimited)                   |
| ollama             |   23 |              0 |                      23 |                      2 | quota covered                                 |
| google-antigravity |    5 |              0 |                       5 |                      4 | quota covered                                 |
| kiro               |    2 |              0 |                       2 |                      0 | quota covered                                 |
| agnes              |    5 |              0 |                       0 |                      5 | quota covered                                 |
| groq               |    6 |              0 |                       0 |                      3 | quota covered                                 |
| nvidia             |   69 |              0 |                       0 |                     49 | quota covered                                 |
| bazaarlink         |  119 |              0 |                       0 |                     36 | quota covered                                 |
| tokenharbor        |   82 |              0 |                       0 |                     28 | quota covered                                 |
| mistral            |   46 |              0 |                       0 |                     33 | quota covered                                 |
| kilocode           |   11 |              0 |                       0 |                      7 | quota covered                                 |
| openrouter         |   12 |              0 |                       0 |                      7 | quota covered                                 |
| orcarouter         |  188 |              0 |                       0 |                     82 | quota covered                                 |
| api-airforce       |  673 |              0 |                       0 |                    475 | quota covered                                 |
| llm7               |   61 |              0 |                       0 |                     24 | quota covered                                 |
| requesty           |  733 |              0 |                       0 |                    461 | quota covered                                 |

Rows with no intelligence value at all: **0**. Estimated scores: **1261** rows across 19 providers, always drawn as estimates.

## Quota gaps, one row at a time

### googleai (12) — RESOLVED: model absent from the published table

- [x] Research: AI Studio's rate-limit page (read 2026-11-11) lists 36 of the 48 googleai rows: 23 with positive free-tier limits and 13 published as 0/0/0. The 12 rows below are not in that table at all, so there is no figure to encode; they keep the unknown/estimated bar. No limit is inferred from a neighbouring model.

Encoded per model in `lib/providers/catalog.js`: the 23 positive rows are 3.6 Flash, 3.8 Flash, 3 Flash, 2.5 Flash, 3.5 Flash Lite, 3.1 Flash Lite (both ids), 2.5 Flash Lite, 3.5 Transcribe, both Robotics ER 2 ids, Gemma 4 26B/31B, the three Antigravity ids, 3.5 Transcribe Live, the three 2.5 Flash Native Audio ids, both 3.8 Live ids, and 3.5 Live Translate. The 13 zero rows are 2.5 Pro, both 3.1 Pro ids, Nano Banana Pro, Nano Banana 2.1, Omni 1.1/1.2 Flash, Lyria 3 Clip/Pro, 4 Argon/Carbon, Computer Use, and Deep Research Pro. The table's TTS and embedding rows are also patterned even though discovery did not return those ids in this build.

Tool-level rows on the same page are not model allowances and are deliberately not encoded as model limits: search grounding is 1,500 RPD for Gemini 2, Gemini 2.5 and Default, and 0 for Gemini 3 and newer; map grounding is 0 RPD for every model. Hammer's Quota column describes the model's own RPM/TPM/RPD, so folding a grounding cap into it would understate the model's generation allowance.

- [x] `models/gemini-flash-latest`
- [x] `models/gemini-flash-lite-latest`
- [x] `models/gemini-pro-latest`
- [x] `models/gemini-3.5-flash`
- [x] `models/gemini-3.7-flash`
- [x] `models/gemini-omni-flash-preview`
- [x] `models/lyria-3.5`
- [x] `models/deep-research-max-preview-04-2026`
- [x] `models/deep-research-preview-04-2026`
- [x] `models/aqa`
- [x] `models/gemini-3.1-flash-live-preview`
- [x] `models/lyria-realtime-exp`

### inferx (14) — RESOLVED: vendor publishes no figure

- [x] Research: Public docs intentionally withhold rate-limit tiers ("remain withheld until verified against the production API"). Rechecked 2026-11-11; only response headers and 429 errors expose quota.

- [x] `Agents-A1`
- [x] `Devstral-2-123B-Instruct-2512-int4-AutoRound`
- [x] `Qwen3-Coder-Next-FP8`
- [x] `Qwen3.6-35B-A3B-FP8`
- [x] `Qwen3.8-27B-FP8`
- [x] `gemma-4-31B-it-fp8`
- [x] `gpt-oss-20b`
- [x] `deepseek-v4-flash-0731`
- [x] `deepseek-v4.1-flash`
- [x] `deepseek-v4.1-flash-1017`
- [x] `deepseek-v4.1-flash-1017-basic`
- [x] `glm-5.3`
- [x] `glm-5.3-flash`
- [x] `qwen3.8-max`

### puter (6) — RESOLVED: vendor publishes no figure

- [x] Research: Every account gets a monthly allowance but its size is plan-specific and shown only in the dashboard. Rechecked 2026-11-11; no universal figure exists to encode.

- [x] `deepseek-v4.1-flash`
- [x] `deepseek-v4-pro`
- [x] `deepseek-v4-pro-0813`
- [x] `deepseek-v4-flash-0731`
- [x] `deepseek-v4-flash-ga-260731`
- [x] `deepseek-flash`

### devin (2) — RESOLVED: vendor publishes no figure

- [x] Research: Free plan is a "light quota" with daily and weekly resets; Cognition publishes no size for any plan. Rechecked 2026-11-11.

- [x] `swe-2-flash-medium`
- [x] `swe-1-6-slow`

### gptfree (1) — RESOLVED: ∞ (no limit exists)

- [x] Research: Vendor states there is no usage limit, so ∞ is correct and no estimator may invent a ceiling.

- [x] `auto`

## Providers with no model rows in this build (figures encoded, nothing to draw yet)

- [x] **codestral** — requests 60/minute
- [x] **moonmath** — requests 2000/day
- [x] **g4f** — requests 5/minute
- [x] **cloudflare-ai** — tokens 30000000/month, requests 300/minute
- [x] **bluesminds** — tokens 7000000/month, requests 20/minute, requests 300/day, credits 500/lifetime
- [x] **sambanova** — tokens 6000000/month, requests 20/minute, requests 20/day, tokens 200000/day
- [x] **cohere** — tokens 800000/month, requests 20/minute, requests 1000/month
- [x] **morph** — tokens 400000/month, requests 200/month, credits 250000/month
- [x] **glm-cn** — tokens 20000000/lifetime, requests 5/minute
- [x] **baidu** — requests 60/minute, tokens 150000/minute
- [x] **siliconflow** — requests 1000/minute, tokens 50000/minute
- [x] **qoder** — tokens 1000000/lifetime, credits 300/lifetime
- [x] **friendliai** — requests 5000/minute, tokens 50000/minute
- [x] **iflytek** — requests 120/minute
- [x] **sparkdesk** — requests 120/minute
- [x] **huggingchat** — tokens 500000/month

## Rate-limit gaps (no published per-minute/hour limit; headers or estimator may still fill the bar)

- [x] **googleai** — 12 of 48 rows. Not listed in AI Studio's per-model table; the other 36 carry exact published RPM (including 13 at 0).
- [x] **inferx** — 14 of 14 rows. Researched; no published RPM exists, so the header/estimator path is the only source.
- [x] **puter** — 6 of 6 rows. Researched; no published RPM exists, so the header/estimator path is the only source.
- [x] **devin** — 2 of 2 rows. Researched; no published RPM exists, so the header/estimator path is the only source.
- [x] **gptfree** — 1 of 1 rows. Researched; no published RPM exists, so the header/estimator path is the only source.
- [x] **ollama** — 23 of 23 rows. Local limits are hardware-bound; the hosted allowance is a monthly token grant, not an RPM.
- [x] **google-antigravity** — 5 of 5 rows. Weekly quota refreshed weekly; no request or task counts are published.
- [x] **kiro** — 2 of 2 rows. Plan allowance is 50 credits/month; there is no published request rate.

## Estimated intelligence values

No row is missing an intelligence value. These rows carry an estimated score rather than a benchmark-sourced one; they are drawn as estimates and are not claims of a measured rating. Checked because the value is present and labelled — not an open gap.

- [x] **googleai** — 32 of 48 rows estimated.
- [x] **inferx** — 7 of 14 rows estimated.
- [x] **puter** — 3 of 6 rows estimated.
- [x] **devin** — 2 of 2 rows estimated.
- [x] **gptfree** — 1 of 1 rows estimated.
- [x] **ollama** — 2 of 23 rows estimated.
- [x] **google-antigravity** — 4 of 5 rows estimated.
- [x] **agnes** — 5 of 5 rows estimated.
- [x] **groq** — 3 of 6 rows estimated.
- [x] **nvidia** — 49 of 69 rows estimated.
- [x] **bazaarlink** — 36 of 119 rows estimated.
- [x] **tokenharbor** — 28 of 82 rows estimated.
- [x] **mistral** — 33 of 46 rows estimated.
- [x] **kilocode** — 7 of 11 rows estimated.
- [x] **openrouter** — 7 of 12 rows estimated.
- [x] **orcarouter** — 82 of 188 rows estimated.
- [x] **api-airforce** — 475 of 673 rows estimated.
- [x] **llm7** — 24 of 61 rows estimated.
- [x] **requesty** — 461 of 733 rows estimated.

## Provider records with no numeric limit

- [x] **agy** — source recorded, no published numeric limit.
- [x] **devin** — Free plan is a "light quota" with daily and weekly resets; Cognition publishes no size for any plan. Rechecked 2026-11-11..
- [x] **duckduckgo-web** — source recorded, no published numeric limit.
- [x] **github-copilot** — source recorded, no published numeric limit.
- [x] **google-antigravity** — source recorded, no published numeric limit.
- [x] **googleai** — Provider-wide record intentionally has no numeric limit; the free tier is published per model and encoded in `MODEL_QUOTAS.googleai` (23 positive, 13 zero, 12 absent). Rechecked 2026-11-11.
- [x] **gptfree** — vendor states unlimited (∞ is correct).
- [x] **inferx** — Public docs intentionally withhold rate-limit tiers ("remain withheld until verified against the production API"). Rechecked 2026-11-11; only response headers and 429 errors expose quota..
- [x] **muse-spark-web** — source recorded, no published numeric limit.
- [x] **openai-codex** — source recorded, no published numeric limit.
- [x] **openai-compatible** — source recorded, no published numeric limit.
- [x] **puter** — Every account gets a monthly allowance but its size is plan-specific and shown only in the dashboard. Rechecked 2026-11-11; no universal figure exists to encode..
- [x] **qwen-web** — source recorded, no published numeric limit.
- [x] **t3-web** — source recorded, no published numeric limit.

## Research log

Encoded with source URLs in `lib/providers/catalog.js`: Baidu Qianfan, BluesMinds, Cloudflare Workers AI, Cohere, FriendliAI, Zhipu/GLM-CN, iFlytek, SparkDesk, Mistral, Codestral, Morph, Qoder, SambaNova, SiliconFlow, Kiro, MoonMath, G4F.

Confirmed unpublished after checking the vendor's own pages on 2026-11-11: InferX, Puter, Devin. Google AI Studio's per-model free-tier table was read the same day and encoded in `MODEL_QUOTAS.googleai`: 23 positive limits, 13 explicit zeros, and 12 model ids absent from the table. Google Antigravity publishes a weekly quota with no counts. GPTFree is a true ∞.

No unresolved checkbox remains. The four "no public figure" providers keep the unknown bar until traffic exists; the estimator then supplies a ceiling labelled EST.
