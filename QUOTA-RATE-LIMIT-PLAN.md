# Quota vs Rate Limit — Implementation Plan

## Goal

Completely distinguish **quotas** (depleting capacity/allowance) from **rate limits**
(burst throttling) throughout Hammer: backend schema, modules, and UI.

## Grounding (Free-LLM)

- **Rate limit** = per-minute/per-second burst throttling (RPM/TPM/RPD headers).
- **Quota** = depleting capacity/allowance (daily/monthly token budgets, credit
  balances, free-tier allowances).

## The core problem

`model.rateLimit` is a single bag holding BOTH:

- throttle fields: `wasRateLimited`, `retryAfterMs`, `resetRequestsAt`,
  `resetTokensAt`, `limitRequests`, `remainingRequests`, `limitTokens`,
  `remainingTokens`
- quota fields: `creditLimit`, `creditRemaining`, `creditResetAt`,
  `freeUsedPercent`, `freeResetAt`, `freeCapturedAt`, extracted `quota`
  (QuotaFailure), plus already-separate `quotaWindows`.

## Design

New module `lib/limits.js` owning the two vocabularies:

- `splitRateLimitCapture(captured)` → `{ rateLimit, quota }` (also serves as
  legacy migration-on-read for `~/.hammer-usage.json` entries).
- `mergeRateLimitCapture(...)` — reconciliation aware of both halves.
- `isRateLimitWindow(window)` / `kind` classification by period.
- Named predicates for call sites.

Persisted schema split:

- `model.rateLimit` (throttle): `wasRateLimited`, `capturedAt`, `retryAfterMs`,
  `resetRequestsAt`, `resetTokensAt`, `limitRequests`, `remainingRequests`,
  `limitTokens`, `remainingTokens`.
- `model.quota` (capacity): `creditLimit`, `creditRemaining`, `creditResetAt`,
  `freeUsedPercent`, `freeResetAt`, `freeCapturedAt`, extracted `quota`.
- Reset times stay in the throttle half as the single source of truth for "when
  does the current wait end"; `extractQuotaWindows` continues reading
  `evidence.rateLimit.resetRequestsAt` for the derived quota-window reset.
- Legacy combined `rateLimit` payloads are split on read and persisted split.

Period classification: minute/hour windows = **rate limit**;
day/week/month/lifetime/rolling = **quota**.

`extractQuotaWindows` gains a `window.kind = 'rate-limit' | 'quota'` tag.

## UI split

- **Quota column** keeps: published day/week/month/lifetime limits
  (`knownQuota`), provider usage reports, credits, rolling 7-day free
  allowance, refusal-derived quota windows + Google buckets, zero-free-tier
  statements.
- **Rate-limit column** (fills the empty `rate-limit-cell`): live throttle
  state — per-minute request/token counters with remaining + reset countdown,
  current bench countdown, published minute/hour limits.
- Provider card: `provider-limits-cell` = rate-limit data;
  `provider-quota-cell` = quota data only — remove `quotaBarsHtml`'s fallback
  to `rateLimit` header data.
- Harness rail mirrors the same split once `splitRateLimitCapture` exists.

## Behavior preserved

- Routing eligibility still gates on the throttle bench (`wasRateLimited`).
- Credit-exhaustion handling in the verdict path stays as-is.
- Verdict vocabulary (`'rate-limited'` vs a possible `'at quota'`) is the
  riskiest change — decide after reading `QUOTA_WAIT_VERDICTS`.

## Files to modify

- `lib/limits.js` (new)
- `lib/utils.js` — `reconcileRateLimitState`, `restoreRateLimitState`,
  `mergeRateLimits`, `pickKeyLevelRateLimit`, `isRateLimitBenchExpired`,
  header-capture builder, `isModelEligibleForRouting`, verdict layer
- `lib/server.js` — all `rateLimit` writers/readers (~93 sites)
- `lib/http/routes/models.js` — row payload
- `lib/http/routes/proxy.js` — 429 path, Token Harbor block
- `lib/http/routes/providers.js` — quotaPending
- `lib/quota-windows.js` — `kind` tag
- `public/dashboard.js` — `rate-limit-cell`, `quotaBarsHtml`, `rateLimitEvidence`,
  `quotaRowViews`, provider card cells
- `public/harness.js` — rail quota/rate-limit views
- `public/index.html` — header tooltips
- `public/dashboard.css` — cell styles
- Tests: `test/quota-ui.test.js`, `test/providers.test.js`,
  `test/quota-windows.test.js`, `test/classify.test.js`, `test/pinning.test.js`

## Status

- [x] Reconnaissance complete (all files read to EOF)
- [x] Baseline tests green (228 pass)
- [x] Implement `lib/limits.js` — DONE. Owns `RATE_LIMIT_FIELDS`, `QUOTA_FIELDS`,
      `KEY_LEVEL_QUOTA_FIELDS`, `RATE_LIMIT_UNSTATED_GRACE_MS`, `splitRateLimitCapture`,
      `asLimitState`, `mergeLimitState`, `reconcileLimitState`, `restoreLimitState`,
      `isRateLimitBenchExpired`, `pickKeyLevelQuota`, `windowKindForPeriod`,
      `isRateLimitWindow`/`isQuotaWindow`, `quotaFailureOf`, `isRowWaitingOnThrottle`,
      `isRowOutOfCapacity`. QuotaFailure stored as `model.quota.failure` (NOT `quota.quota`).
- [x] `lib/utils.js` — DONE. `reconcileRateLimitState`/`restoreRateLimitState`/
      `mergeRateLimits`/`pickKeyLevelRateLimit`/`isRateLimitBenchExpired` now delegate to
      limits.js and keep legacy single-bag signatures; `applyRateLimitCapture` splits into
      `model.rateLimit` + `model.quota`; verdict layer reads `quotaFailureOf`/`isRowOutOfCapacity`.
- [x] `lib/quota-windows.js` — DONE. `extractQuotaWindows` reads both halves via
      `asLimitState`, windows carry `kind` ('rate-limit'|'quota') from `windowKindForPeriod`.
- [ ] `lib/server.js` — all `rateLimit` writers/readers (~93 sites). IN PROGRESS.
- [ ] `lib/http/routes/models.js` — emit `quota` alongside `rateLimit`; `isRateLimited` reads both.
- [ ] `lib/http/routes/proxy.js` — 429 path, Token Harbor block.
- [ ] `lib/http/routes/providers.js` — quotaPending.
- [ ] `public/dashboard.js` — `rate-limit-cell`, `quotaBarsHtml`, `rateLimitEvidence`,
      `quotaRowViews`, provider card cells.
- [ ] `public/harness.js` — rail quota/rate-limit views.
- [ ] `public/index.html` — header tooltips.
- [ ] `public/dashboard.css` — cell styles.
- [ ] Tests: `test/quota-ui.test.js`, `test/providers.test.js`,
      `test/quota-windows.test.js`, `test/classify.test.js`, `test/pinning.test.js`.

## Key design decisions (refined during implementation)

- QuotaFailure lives at `model.quota.failure` (not `quota.quota`) to avoid the confusing
  `quota.quota` and the pair-detection ambiguity. `quotaFailureOf(row)` is the single reader.
- `asLimitState` accepts a model row, a `{rateLimit,quota}` pair, a legacy combined bag, or a
  bare capture — all normalize to `{rateLimit, quota}`.
- `reconcileRateLimitState`/`restoreRateLimitState`/`mergeRateLimits`/`pickKeyLevelRateLimit`
  keep their legacy single-bag signatures (return merged bag or null) so existing callers and
  the ~93 server.js sites keep working during the transition; new code uses the pair API.
- classify.test.js passes with the legacy fixture shape (row.rateLimit.quota) because
  `quotaFailureOf` reads through `asLimitState`.
