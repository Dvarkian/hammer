import express from 'express';
import { createServer as createHttpServer } from 'http';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { MODELS, sources, canonicalizeModelId, getPreferredModelLabel, getScore, resolveAliasedModelId, stripRoutingNamespace } from '../sources.js';
import { API_KEY_SIGNUP_URLS } from './providerLinks.js';
import { getProvider, legacyAccountSecretFieldTable, providerQuotaTable, registerProviderHooks } from './providers/index.js';
import { getAutostartStatus } from './autostart.js';
import {
  applyRequestShaping,
  credentialFieldValues,
  missingCredentialFields,
  requiredCredentialFields,
  resolveShapedChatUrl,
  shapedHeaders,
  shapedModelNeedsKey,
  shapedTimeoutMs,
  shapingReadiness,
  substituteCredentialFields,
} from './providers/adapters.js';
import {
  EMPERO_PROVIDER_KEY,
  FREEMODELS_PROVIDER_KEY,
  KILOCODE_PROVIDER_KEY,
  OLLAMA_PROVIDER_KEY,
  OPENROUTER_PROVIDER_KEY,
} from './provider-keys.js';
import {
  buildOllamaModelMeta,
  buildOpenAICompatibleModelMeta,
  extractOpenAICompatibleModelRecords,
  fetchEmperoModels,
  fetchKiloCodeFreeModels,
  fetchOllamaModels,
  fetchOpenAICompatibleDiscoveredModels,
  fetchOpenRouterFreeModels,
  findKnownModelMeta,
  formatGenericProviderModelLabel,
  getDefaultProviderBaseUrl,
  getReportedContext,
  isChatCompatibleDiscoveredModel,
  isOpenAICompatibleDiscoveryEnabled,
  isProviderAuthOptional,
  isProviderBearerAuthEnabled,
  lazyDiscoveryCandidates,
  normalizeIntelligenceScore,
  normalizeOpenAICompatibleProviderUrl,
  providerDiscoveryNeedsCredential,
  providerWantsBearerAuth,
  resolveDiscoveredOrigin,
  resolveDiscoveryModelsUrl,
  resolveModelContext,
  resolveRequestModels,
  shouldRetryOptionalProviderWithBearer,
  toOpenAICompatibleDiscoveredModelMeta,
} from './providers/discovery.js';
import { getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, hasMultipleKeys, isProviderEnabled, loadConfig, saveConfig, exportConfigToken, importConfigToken, isOpenAICompatibleInstanceKey, getBaseProviderKey, listOpenAICompatibleEndpoints, upsertOpenAICompatibleEndpoint, removeOpenAICompatibleEndpoint, buildOpenAICompatibleInstanceKey, getOpenAICompatibleInstanceId, getProviderAccounts, getProviderAccountSecrets, getLegacyProviderAccountSecret, addOrUpdateProviderAccount, removeProviderAccount, setProviderAccounts } from './config.js';
import { accumulateContextObservation, accumulateOutputCapObservation, accumulateUsageSample, applyRateLimitCapture, benchCredential, buildModelGroups, checkApiRequestAllowed, computeFailedRefreshRetryAt, computeQoSMap, computeUsageAverages, DEFAULT_QOS_LATENCY_TARGET_MS, estimateMessageTokens, extractErrorMessage, extractQuotaFailure, extractRateLimitResetMs, findBestModel, findUpstreamSseError, getAvg, getUptime, getVerdict, hasUsableChatCompletionBody, isAccountBudgetRefusalText, isAuthoritativeProbeFailure, isBlockedModelName, isCachedReplayResponse, isCredentialSpent, isDeadModelError, isDiscoverableProbeAuthRefusal, isIncompatibleModelError, isLastResponseReady, isLoopbackHostname, isLoopbackRemoteAddress, isModelEligibleForRouting, isOverLengthErrorText, isContextOverflowErrorText, isPaymentRequiredError, isProviderOverloadedError, isQuotaExhaustionError, isRateLimitedErrorText, isRetryableProxyStatus, resolveCompletionTokens, resolveModelStatus, resolveReportedOutputTokens, roundMeasuredRate, parseAllowedModelNamesFromRefusal, isKnownChatModelName, mergeRateLimits, reconcileRateLimitState, parseContextLimitFromError, parseMaxTokensCapFromError, parseRateLimitResetValue, parseRetryDelayMs, pruneDiscoverableRows, rankModelsForRouting, rankModelsForSmartest, getRoutingModelKey, parseOpenRouterKeyRateLimit, filterModelsByRequested, selectNextApiKeyFromPool, shouldKeepUpAfterFailedProbe, selectModelBySlope, selectorSlopeOf, computeRowSpeed, computeRowIntelligence, deriveContextState, normalizeContextEvidence, revalidateContextBound, revalidateOutputCap, clearContextBound, parseUsageStatKey, requestedOutputBudget, withOutputBudgetCap, backfillCompletionSamples, resolveStreamGenerationMs, revalidateMeasuredRate, withdrawLegacyRateSamples, isRateLimitBenchExpired, restoreRateLimitState, RATE_LIMIT_UNSTATED_GRACE_MS, createProviderHealth, noteProviderTransportFailure, noteProviderSuccess, providerBenchState, isProviderBenched, preferHealthyProviders, providerScopeKey } from './utils.js';
import { getPreferredLanIpv4Address } from './network.js';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { MODEL_QUALITY_CACHE_MS, convertSelectorToAaScale, fetchOpenRouterQualityIndex, resolveModelQuality } from './model-quality.js';
import { normalizeProviderUsageReport, selectProviderUsageReport, serializeProviderUsage } from './provider-usage.js';
import { resolveTestVerdict, summarizeTestAnswer } from './test-verdict.js';
import { formatStartupProviderResult, shouldEmitKiroOAuthWarning } from './startup.js';
import { createLearnedStrips, describeRejection, isHealableFieldRejection, parseRejectedFields, recordLearnedStrips, sanitizeProviderPayload } from './request-sanitize.js';
import { createResidueStreamFilter, scrubChatCompletionBody } from './tool-call-residue.js';
import {
  CODEX_DEFAULT_BASE_URL, CODEX_RESPONSES_PATH, CODEX_MODELS_PATHS, CODEX_CLIENT_VERSION,
  CODEX_CLIENT_ID, CODEX_TOKEN_URL, CODEX_DEVICE_USERCODE_URL, CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFY_URL, CODEX_DEVICE_REDIRECT_URI, CODEX_SCOPE, CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  buildCodexRequestPayload, transformCodexResponse, extractCodexAccountIdentity,
  extractCodexModelRecords,
} from './openai-codex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { stdout: STARTUP_STDOUT } = process
const STARTUP_IS_TTY = Boolean(STARTUP_STDOUT?.isTTY)
let lastKiroOAuthWarning = { key: null, at: 0 }
let kiroOAuthWarningCollector = null

function emitKiroOAuthWarning(status, details = '') {
  const now = Date.now()
  const key = `${status}:${String(details || '').slice(0, 200)}`
  if (!shouldEmitKiroOAuthWarning(status, details, now, lastKiroOAuthWarning)) return
  lastKiroOAuthWarning = { key, at: now }
  const message = `[Kiro OAuth] token refresh failed (${status})${details ? `: ${String(details).slice(0, 200)}` : ''}`
  if (kiroOAuthWarningCollector) kiroOAuthWarningCollector.push(message)
  else console.warn(message)
}

let startupLiveLine = false
let startupProgressText = ''

function startupProgress(message) {
  if (STARTUP_IS_TTY) {
    startupProgressText = message
    process.stdout.write(`\r\x1b[2K  ⠸ ${message}`)
    startupLiveLine = true
    return
  }
  console.log(chalk.dim(`  ${message}`))
}

function finishStartupProgress(message) {
  if (STARTUP_IS_TTY) process.stdout.write(`\r\x1b[2K  ${message}\n`)
  else console.log(`  ${message}`)
  startupLiveLine = false
}

// A log printed while a `\r`-rewritten progress line is live would otherwise collide with it:
// console.log appends onto the spinner's characters, leaving the next line stamped with a
// stale "⠸ Probing …" prefix (and the spinner redrawn mid-line). So a startup-phase log goes
// through here: erase the live line, print the real one, redraw the spinner after it. Outside
// startup (or on a non-TTY, where startupProgress never opens a live line) this is console.log.
function startupLogLine(...args) {
  if (!STARTUP_IS_TTY || !startupLiveLine) {
    console.log(...args)
    return
  }
  process.stdout.write(`\r\x1b[2K`)
  console.log(...args)
  startupProgress(startupProgressText)
}

let APP_VERSION = 'unknown';
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  APP_VERSION = pkg.version || 'unknown';
} catch {
  APP_VERSION = 'unknown';
}

// ── How the timeout windows fit together ─────────────────────────────────────────────
// "Timeout" means several different things in this file, and they are deliberately not one
// budget, because they measure different events. This is the single place that says which is
// which, so a change to one does not have to be reverse-engineered from four call sites.
//
//   PING_TIMEOUT (60s, HAMMER_PING_TIMEOUT_MS)
//     How long one probe waits for an answer. Passive: running out produces the 'timeout'
//     verdict plus one tick on the provider outage ledger (see utils.js), and never delays a
//     client request.
//   UPSTREAM_HEADERS_TIMEOUT_MS (60s, HAMMER_UPSTREAM_TIMEOUT_MS)
//     How long a *proxied* request waits for response headers before the attempt is aborted so
//     the retry loop can fail over. The only window a client actually waits on.
//   UPSTREAM_IDLE_TIMEOUT_MS (120s, HAMMER_UPSTREAM_IDLE_MS)
//     How long an already-accepted stream may stall mid-body before it is ended.
//   TEST_TIMEOUT_MS (60s, manual-test endpoint)
//     How long one manual Test waits. A timeout there is persisted as an error plus an
//     `expiresAt` window so the dashboard can clear the stale result; no server-side
//     eligibility check reads `expiresAt` — it is display metadata for that one response.
//   RECENT_SUCCESS_KEEP_UP_MS / RECENT_SUCCESS_KEEP_UP_TIMEOUT_MS (1h / 6h)
//     Not budgets but *grace*: how long a recent real success keeps a row 'up' across a failed
//     probe, so a cold start or a blip is not reported as an outage. They only apply to
//     verdicts that make no claim about the model itself — see the classification in pingModel.
// ──────────────────────────────────────────────────────────────────────────────────────
// Ping probe timeout. 60s (rather than a tight 15s/30s) so slow-but-alive
// endpoints — e.g. local Ollama cold-starting a model, or a provider whose first
// token takes ~30s — don't produce false 'timeout'/'down' verdicts. Matches the
// upstream headers timeout so a ping only gives up when a real request would too.
// Overridable via env for deployments that need longer windows.
export const PING_TIMEOUT = Number(process.env.HAMMER_PING_TIMEOUT_MS) || 60_000;
// A failed ping against a model that served a real request within this window is
// treated as a transient blip / cold start rather than as an outage — the model stays
// 'up' and the failed probe isn't recorded (which would drag down its uptime %).
// Only a verdict that says nothing about the model qualifies: a timeout, a transport error,
// or a 5xx. A provider refusal (401/402/429, dead, incompatible) is a statement about the
// credential, the plan or the model, and classifies immediately.
const RECENT_SUCCESS_KEEP_UP_MS = 60 * 60_000;
// A *timeout* probe (code '000') is non-authoritative: it only means "no answer
// within the probe budget", which a slow-but-alive endpoint can produce while
// real requests and manual tests succeed. Within this longer window, liveness
// evidence keeps such rows 'up' instead of condemning them as 'timeout'. This is the grace
// the outage ledger exists to backstop: a provider that answers nothing to *every* row is
// benched there even while its rows stay 'up' here.
const RECENT_SUCCESS_KEEP_UP_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_PROACTIVE_RETRIES = 5;
// Bounds for proxied upstream requests. The headers timeout aborts a fetch that never
// gets a response; the idle timeout ends a stream that stalls mid-body. Overridable via
// env for deployments that need longer windows.
const UPSTREAM_HEADERS_TIMEOUT_MS = Number(process.env.HAMMER_UPSTREAM_TIMEOUT_MS) || 60_000;
const UPSTREAM_IDLE_TIMEOUT_MS = Number(process.env.HAMMER_UPSTREAM_IDLE_MS) || 120_000;
// How long a credential stays benched after a 429 when the provider stated no reset window of
// its own. Declared at
// module scope because getAccountStatus() (module-level) reads it for the CLI/dashboard.
const KEY_POOL_COOLDOWN_MS = 60_000
const KILOCODE_MODELS_REFRESH_MS = 30 * 60_000;

const EMPERO_MODELS_REFRESH_MS = 60 * 60_000;
const FREEMODELS_URL = 'https://freemodels-chat.freemodels.workers.dev';
// gpt4free (g4f.space) is a single hosted gateway provider. It needs a free
// account key from https://g4f.dev/members.html because anonymous traffic is
// credit-gated, so its descriptor is deliberately not marked optional.
const G4F_PROVIDER_KEY = 'g4f';
// gptfree.com is a consumer chat site, not a platform: no published API, no keys, no
// /v1 surface. Its own web app signs in anonymously against the project's Firebase
// instance and posts {message, images, history} to one Cloud Function, so that is
// exactly the exchange this provider reproduces — see resolveGptFreeAccessToken,
// buildGptFreeRequestPayload and transformGptFreeResponse below.
//
// The Firebase web API key is public by design (it identifies the project, it does
// not authorize anything — it ships in the site's own JS bundle). The credential is
// the anonymous ID token minted with it, and that one is short-lived.
//
// Worth being clear about what this is: an internal endpoint read out of a public
// bundle, offered by a site that supports itself with ads and promises nothing to
// automated callers. It can gain App Check, lose anonymous sign-in, or change shape
// without notice, and hammer has no say in any of that.
const GPTFREE_PROVIDER_KEY = 'gptfree';
const GPTFREE_STREAM_URL = 'https://us-central1-gptfree-2.cloudfunctions.net/agent_stream';
const GPTFREE_FIREBASE_API_KEY = 'AIzaSyBdU-Np8RSh1tPSsPOWg3qIm6PnVK5PQb4';
const GPTFREE_SIGNUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp';
const GPTFREE_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
// Firebase ID tokens live an hour. Refresh this far ahead of expiry so a request can
// never be handed a token that dies mid-flight.
const GPTFREE_TOKEN_SKEW_MS = 5 * 60_000;
const DEVIN_PROVIDER_KEY = 'devin';
const DEVIN_API_URL = 'https://server.codeium.com';
const DEVIN_CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const DEVIN_CHAT_URL = `${DEVIN_API_URL}${DEVIN_CHAT_PATH}`;
const DEVIN_AUTH_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const DEVIN_CONFIGS_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
const DEVIN_AUTH_URL = `${DEVIN_API_URL}${DEVIN_AUTH_PATH}`;
const DEVIN_SESSION_TOKEN_PREFIX = 'devin-session-token$';
const DEVIN_OAUTH_AUTHORIZE_URL = 'https://app.devin.ai/auth/cli/continue';
const DEVIN_OAUTH_TOKEN_URL = 'https://api.devin.ai/auth/cli/token';
const DEVIN_OAUTH_CALLBACK_HOST = '127.0.0.1';
const DEVIN_OAUTH_CALLBACK_PORT = 59653;
const DEVIN_OAUTH_CALLBACK_PORT_TRIES = 6; // 59653..59658, same port-fallback idea as omp
const DEVIN_OAUTH_CALLBACK_PATH = '/callback';
const DEVIN_OAUTH_FLOW_TTL_MS = 5 * 60_000; // omp waits 5 minutes for the callback
const DEVIN_MODELS = [
  ['swe-1.6-slow', 'Devin SWE 1.6 Slow', '200k'],
];
// Devin model entitlements vary per account (free accounts typically only get
// swe-1-6-slow), so the static DEVIN_MODELS list is only a fallback: the live
// list comes from GetCliModelConfigs with the account's own session token.
const DEVIN_MODELS_REFRESH_MS = 30 * 60_000;
const DEVIN_DEFAULT_STOP_PATTERNS = ['<|user|>', '<|bot|>', '<|context_request|>', '<|endoftext|>', '<|end_of_turn|>'];
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
// Hard upper bound on a single Connect frame payload; the 4-byte length prefix is
// otherwise attacker-controlled (up to 2^32-1), so a corrupt length must fail fast
// instead of buffering gigabytes.
const DEVIN_MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
// The current Codeium/Cascade gateway serves the Devin SWE model surface only to the
// released Devin CLI identity ("devin-cli" / "chisel"); the older Windsurf identity is
// rejected with invalid_argument. Versions mirror @oh-my-pi/pi-catalog's devinCliMetadata.
const DEVIN_CLI_IDE_VERSION = '3000.6.2';
const DEVIN_OS = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');

// Maps hammer's dot-style model ids to the Devin gateway's hyphenated wire uids
// (swe-1.6 -> swe-1-6), which is what GetCliModelConfigs returns for Devin SWE.
function devinChatModelUid(modelId) {
  const id = String(modelId || '');
  return /^swe-1\.\d+/.test(id) ? id.replace(/\./g, '-') : id;
}

const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible';
const OPENAI_COMPATIBLE_MODELS_REFRESH_MS = 30 * 60_000;
const OLLAMA_MODELS_REFRESH_MS = 60 * 60_000;
const KIRO_PROVIDER_KEY = 'kiro';
const GOOGLEAI_PROVIDER_KEY = 'googleai';
const PROVIDER_USAGE_CACHE_MS = 5 * 60_000;
// Gemini thinking models require thought_signature in function call parts on follow-up
// requests. Cache signatures keyed by tool_call_id so we can re-inject them.
const THOUGHT_SIGNATURE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OPENROUTER_MODELS_REFRESH_MS = 60 * 60_000;
const DISCOVERABLE_PROVIDER_MODELS_REFRESH_MS = 30 * 60_000;
// How many lazy imported providers a single request may probe at once (see
// discoverLazyImportsForRequest). Small enough that an unknown model id cannot open a
// socket per provider, large enough that the keyless imports resolve together.
const LAZY_DISCOVERY_CONCURRENCY = 4;
// A failed discovery/model-sync attempt shouldn't be locked out for the full success TTL --
// that turns one transient network blip into up to an hour of an empty/stale model list with
// no automatic recovery. Retry again after this much shorter backoff instead.
const FAILED_DISCOVERY_RETRY_MS = 2 * 60_000;
// A failed sync or discovery retries on FAILED_DISCOVERY_RETRY_MS, and every retry used
// to print the same skip line — a provider that stays down for an hour wrote thirty of
// them and buried everything else. Repeat a skip note only this often instead: the line
// is printed while it is news, and again when the reason changes or after this reminder.
const SKIP_LOG_REMINDER_MS = 30 * 60_000;
const DEVIN_SESSION_AUTH_PROVIDERS = new Set([DEVIN_PROVIDER_KEY]);
// Kiro expects AWS SDK-style user-agent headers (mirrors OmniRoute's Kiro header profile).
const KIRO_SDK_USER_AGENT = 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0';
const KIRO_AMZ_USER_AGENT = 'aws-sdk-js/3.0.0 kiro-ide/1.0.0';
const KIRO_STREAM_ACCEPT = 'application/vnd.amazon.eventstream';
const KIRO_STREAMING_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
const KIRO_AUTH_SERVICE_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const KIRO_SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const KIRO_SOCIAL_TOKEN_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token';
const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';
const KIRO_OIDC_REGISTER_URL = 'https://oidc.us-east-1.amazonaws.com/client/register';
const KIRO_OIDC_DEVICE_AUTH_URL = 'https://oidc.us-east-1.amazonaws.com/device_authorization';
const KIRO_OIDC_TOKEN_URL = 'https://oidc.us-east-1.amazonaws.com/token';
const KIRO_BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
const KIRO_OIDC_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6';
const KIRO_OIDC_SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'];
const KIRO_OIDC_GRANT_TYPES = ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'];
const KIRO_REFRESH_TOKEN_PREFIX = 'aorAAAAAG';
const KIRO_TOKEN_EXPIRY_SKEW_MS = 60_000;
const KIRO_DEFAULT_TOKEN_EXPIRY_MS = 50 * 60_000;
const KIRO_BROWSER_AUTH_PROVIDERS = new Set(['google', 'github']);
const KIRO_MAX_CONTEXT_TOKENS = 200_000; // Kiro/Claude model max context window for usage estimation

// GitHub Copilot: OpenAI-compatible chat at the plan's Copilot API host, but with
// no API keys. It authenticates with a GitHub OAuth token from the device flow and
// bills against the account's premium-request quota, so the client identity on each
// request decides what is free. Identity headers, the plan-specific endpoint probe,
// and the model-policy enable step all mirror oh-my-pi's github-copilot provider.
const GITHUB_COPILOT_PROVIDER_KEY = 'github-copilot';
const COPILOT_DEFAULT_API_BASE = 'https://api.githubcopilot.com';
const COPILOT_CHAT_PATH = '/chat/completions';
const COPILOT_GITHUB_API_BASE = 'https://api.github.com';
const COPILOT_CLI_VERSION = '1.0.82';
const COPILOT_CLI_USER_AGENT = `copilot/${COPILOT_CLI_VERSION}`;
const COPILOT_CLI_INTEGRATION_ID = 'copilot-developer-cli';
// Chat defaults to the chat-surface identity: Business orgs commonly gate the
// CLI/agentic surface off while allowing chat, and a one-shot retry as the CLI
// identity covers the orgs that do the opposite.
const COPILOT_CHAT_INTEGRATION_ID = 'copilot-chat';
const COPILOT_API_VERSION = '2026-08-01';
const COPILOT_MODELS_REFRESH_MS = 60 * 60_000;
// The device flow uses the minimal-grant OpenCode OAuth app on github.com so the
// consent page only asks for read:user (the Copilot CLI app's historic grant is
// repo/gist/codespace, which enterprise orgs often block outright).
const COPILOT_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const COPILOT_OAUTH_SCOPE = 'read:user';
const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const COPILOT_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_OAUTH_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'copilot-developer-action/0.0.1',
};
// Some Copilot models (Claude, Grok, the GPT-5 coding family) stay unusable until
// the account accepts their model policy; sign-in switches the gated ones on.
const COPILOT_POLICY_MODEL_PREFIXES = ['claude', 'grok', 'gpt-5', 'o3', 'o4'];

// OpenAI Codex: the ChatGPT subscription surface. Also keyless — it authenticates
// with a ChatGPT OAuth access token plus the workspace id header — but unlike
// Copilot it is not chat-completions: every call speaks the Responses API and
// streams SSE, so requests and responses are translated (see lib/openai-codex.js).
// The sign-in mirrors oh-my-pi's openai-codex provider: a device flow, then a
// refresh-token exchange for the short-lived access tokens.
const OPENAI_CODEX_PROVIDER_KEY = 'openai-codex';
const CODEX_MODELS_REFRESH_MS = 60 * 60_000;
// Access tokens last hours, not minutes, but every request sends one, so the
// exchange is cached per refresh token and refreshed this far ahead of expiry.
const CODEX_ACCESS_TOKEN_SKEW_MS = 5 * 60_000;
const CODEX_DEFAULT_ACCESS_TOKEN_TTL_MS = 55 * 60_000;
const CODEX_OAUTH_TIMEOUT_MS = 15_000;
// Device-flow polling: the backend answers 403/404 until the user approves.
const CODEX_DEVICE_POLL_INTERVAL_MS = 5_000;
const CODEX_DEVICE_FLOW_EXPIRY_MS = 15 * 60_000;

// No per-model hardcoding here: guard/safety/embedding models are filtered out
// generically by isChatCompatibleDiscoveredModel (id + type/object/capability/
// name), which live catalogs confirm catches the known guard models without
// dropping any real free chat model.


let _keyPoolState = null;
export function _setKeyPoolState(state) { _keyPoolState = state; }
let _kiroOAuthCache = null;
let _kiroRefreshTokenDiscoveryCache = { token: null, checkedAt: 0 };
// Server-side store for in-progress device auth flows (clientSecret never leaves the server)
const _kiroDeviceFlows = new Map();
const _kiroSocialFlows = new Map();
// GitHub Copilot device flows (the GitHub token stays server-side; the browser only
// ever sees an opaque flowId) plus the plan-specific API host learned per token.
const _copilotDeviceFlows = new Map();
let _copilotApiEndpointCache = { token: null, apiEndpoint: null, checkedAt: 0 };
// OpenAI Codex device flows (the OAuth tokens stay server-side) plus a per-refresh-
// token access-token cache: one entry per signed-in account, so rotating accounts
// reuses each account's live access token instead of re-exchanging every request.
const _codexDeviceFlows = new Map();
const _codexAccessTokenCache = new Map(); // refreshToken -> { accessToken, accountId, email, planType, residency, expiresAt }
// Round-robin cursor over the signed-in Codex account pool, used only when no server owns
// the pool state (the CLI, tests). A running server rotates through `_keyPoolState` instead,
// which is what lets a rate-limited account be skipped rather than reused.
let _codexAccountRotation = 0;

/** 📖 A credential as the dashboard may see it: never the value itself. */
function maskCredential(secret) {
  const value = String(secret || '')
  if (value.length > 8) return `${value.slice(0, 4)}...${value.slice(-4)}`
  return value ? `${value.slice(0, 2)}***` : ''
}

/**
 * 📖 How long the provider said to wait before using this credential again.
 *
 * `retry-after` is the standard answer and comes either as a number of seconds or as an HTTP
 * date; both are read, because a provider that answers with a date is not refusing to answer.
 * Returning `null` is meaningful: it means the provider stated nothing, and the local fallback
 * window is what the credential gets benched for.
 *
 * @param {Response} response the refusing response
 * @returns {number|null} milliseconds, or null when nothing was stated
 */
export function credentialResetHintMs(response) {
  const raw = response?.headers?.get?.('retry-after')
  if (!raw) return null
  const stated = parseRetryDelayMs(raw)
  if (stated) return stated
  const at = Date.parse(String(raw))
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return null
}

/**
 * 📖 One provider's credential pool as the dashboard needs it: how many credentials there are,
 *    which one is serving, and how the others are doing — with no credential value in sight.
 *
 * The exhaustion window is converted to a countdown here rather than sent as a timestamp,
 * because the browser's clock is not the server's and a countdown is the same fact on any clock.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {{ policy: string, count: number, servingIndex: number, accounts: Array<object> }|null}
 */
export function describeCredentialPool(config, providerKey) {
  const pool = rotatableCredentialPool(config, providerKey)
  if (pool.length === 0) return null
  // Read-only: a card must not conjure pool state into existence, or the accounts view would
  // list every provider that was ever rendered.
  const entry = _keyPoolState && typeof _keyPoolState.get === 'function' ? _keyPoolState.get(providerKey) : null
  const identities = getProviderAccounts(config, providerKey)
  const now = Date.now()
  return {
    // Named so the dashboard never has to guess what the bars mean, and so a second policy can
    // be added later without silently relabelling every existing bar.
    policy: 'exhaust',
    count: pool.length,
    servingIndex: entry ? Math.min(Math.max(entry.currentIdx, 0), pool.length - 1) : 0,
    accounts: pool.map((secret, idx) => {
      const state = entry ? entry.accounts.get(idx) : null
      const exhausted = isCredentialSpent(state, now, KEY_POOL_COOLDOWN_MS)
      const statedUntil = Number(state?.exhaustedUntil) || 0
      return {
        index: idx,
        label: identities[idx]?.email || identities[idx]?.accountId || maskCredential(secret),
        requests: state ? state.requests : 0,
        exhausted,
        resetsInMs: exhausted && statedUntil > now ? statedUntil - now : null,
      }
    }),
  }
}

/**
 * 📖 Every credential a provider can fail over to: its API keys when it has them, otherwise
 *    the signed-in accounts of its OAuth pool (the pool's `secret` — for Codex a refresh
 *    token, not the access token that gets sent).
 *
 * Returns the single credential of a provider that has only one way in, which callers treat
 * as "nothing to rotate" — one credential has nowhere to fail over to.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function rotatableCredentialPool(config, providerKey) {
  const keys = getApiKeyPool(config, providerKey)
  if (keys.length > 0) return keys
  return getProviderAccountSecrets(config, providerKey)
}

/**
 * 📖 Which signed-in ChatGPT account serves this request.
 *
 * The pool is ordered and spent the same way an API-key pool is: the first account serves until
 * it is exhausted, then the next takes over. When a server is running it also shares that pool's
 * benching state, so a 429 benches the account that hit the limit and the following requests go
 * to another sign-in rather than back to the same one. That failover is the reason a second
 * ChatGPT account is worth adding at all: a plan's usage window is per account, so two accounts
 * mean two windows instead of one shared allowance.
 *
 * With no server running there is no bench state to consult and the selection degrades to the
 * plain rotation it has always been.
 *
 * @param {object} config
 * @param {number} [now]
 * @param {Map|null} [state] the key-pool state `runServer` owns; injected by tests
 * @returns {string|null}
 */
export function selectCodexRefreshToken(config, now = Date.now(), state = _keyPoolState) {
  const pool = getProviderAccountSecrets(config, OPENAI_CODEX_PROVIDER_KEY)
  // No pool at all: the credential can only be the env var, which is a single account. The
  // `|| null` matters because the normalizer answers an absent value with an empty string, and
  // "no account" has to be one value for every caller to test against.
  if (pool.length === 0) return normalizeSecretValue(process.env.OPENAI_CODEX_REFRESH_TOKEN) || null
  if (pool.length === 1) return pool[0]
  const entry = state && typeof state.get === 'function' ? state.get(OPENAI_CODEX_PROVIDER_KEY) : null
  if (!entry) return pool[_codexAccountRotation++ % pool.length]
  // A `null` return means every account is inside its bench window. Falling back to the head
  // of the pool is deliberate: the window is an estimate, and with a full pool a retry that
  // might succeed beats refusing the request outright.
  return selectNextApiKeyFromPool(pool, entry, 0, now, KEY_POOL_COOLDOWN_MS) || pool[0]
}

const KIRO_DISCOVERY_CACHE_MS = 30_000;
const KIRO_SOCIAL_FLOW_EXPIRY_MS = 10 * 60_000;
const KIRO_CONVERSATION_NAMESPACE = '34f7193f-561d-4050-bc84-9547d953d6bf';
const KIRO_CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  KIRO_CRC32_TABLE[i] = c >>> 0;
}

export function getAccountStatus(config) {
  const providers = {}
  if (!_keyPoolState) return { providers }

  for (const [providerKey, entry] of _keyPoolState) {
    // Every rotatable credential, not just API keys: a signed-in account pool (Codex) is the
    // same kind of thing to this view — several credentials with one serving at a time.
    const pool = rotatableCredentialPool(config, providerKey)
    if (pool.length === 0) continue
    const now = Date.now()
    const identities = getProviderAccounts(config, providerKey)
    const accounts = pool.map((secret, idx) => {
      const acct = entry.accounts.get(idx)
      const exhausted = isCredentialSpent(acct, now, KEY_POOL_COOLDOWN_MS)
      const statedUntil = Number(acct?.exhaustedUntil) || 0
      return {
        index: idx,
        masked: maskCredential(secret),
        // An account pool knows a human-readable identity; a key pool only knows the value,
        // so the table shows the email when there is one and the masked credential otherwise.
        label: identities[idx]?.email || identities[idx]?.accountId || null,
        requests: acct ? acct.requests : 0,
        rateLimited: exhausted,
        resetsInMs: exhausted && statedUntil > now ? statedUntil - now : null,
      }
    })

    providers[providerKey] = {
      keyCount: pool.length,
      // The credential serving right now — the policy spends one before touching the next, so
      // there is no "next" to report.
      currentIdx: Math.min(Math.max(entry.currentIdx, 0), pool.length - 1),
      policy: 'exhaust',
      accounts,
    }
  }
  return { providers }
}

export function toPinnedRowKey(result) {
  return `${result?.providerKey || ''}::${result?.modelId || ''}`;
}

export function getPinnedModelMatches(results, pinnedModelId, pinningMode = 'canonical', pinnedProviderKey = null) {
  if (!pinnedModelId) return [];
  if (pinningMode === 'exact') {
    return results.filter(r => r.modelId === pinnedModelId && (pinnedProviderKey ? r.providerKey === pinnedProviderKey : true));
  }

  const groups = buildModelGroups(results, canonicalizeModelId);
  const matchedGroup = groups.find(group => group.models.some(model => model.modelId === pinnedModelId && (pinnedProviderKey ? model.providerKey === pinnedProviderKey : true)));
  return matchedGroup ? matchedGroup.models : results.filter(r => r.modelId === pinnedModelId);
}

export function getPinnedModelCandidate(results, pinnedModelId, pinningMode = 'canonical', attemptedModelKeys = [], pinnedProviderKey = null, qosOptions = {}) {
  const attempted = new Set(attemptedModelKeys);
  const matches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey)
    .filter(r => r.status !== 'banned' && r.status !== 'disabled' && !attempted.has(getRoutingModelKey(r)) && !attempted.has(r.modelId));
  const ranked = rankModelsForRouting(matches, Array.from(attempted), qosOptions);
  return ranked[0] || null;
}

// Parse NVIDIA/OpenAI duration strings like "1m30s", "12ms", "45s" into milliseconds
function parseDurationMs(str) {
  if (!str) return null;
  // Numeric values may be epoch seconds/milliseconds or relative seconds.
  const reset = parseRateLimitResetValue(str);
  if (reset != null) return Math.max(0, reset - Date.now());
  let ms = 0;
  const match = String(str).match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i);
  if (match) {
    if (match[1]) ms += parseFloat(match[1]) * 3600000;
    if (match[2]) ms += parseFloat(match[2]) * 60000;
    if (match[3]) ms += parseFloat(match[3]) * 1000;
    if (match[4]) ms += parseFloat(match[4]);
  }
  return ms || null;
}

function parseErrorBodyText(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const trimmed = rawText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return extractErrorMessage(parsed) || trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

function getNetworkErrorMessage(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  const direct = typeof err.message === 'string' ? err.message.trim() : '';
  const cause = err && typeof err === 'object' ? err.cause : null;
  const causeMessage = cause && typeof cause.message === 'string' ? cause.message.trim() : '';
  const causeCode = cause && typeof cause.code === 'string' ? cause.code.trim() : '';

  if (causeCode && causeMessage) return `${direct || 'Network error'} (${causeCode}: ${causeMessage})`;
  if (causeCode) return `${direct || 'Network error'} (${causeCode})`;
  if (causeMessage) return `${direct || 'Network error'} (${causeMessage})`;
  return direct || null;
}

function describeSyncError(err) {
  return getNetworkErrorMessage(err) || err?.message || 'unknown error';
}

function captureResolvedModel(logEntry, payload) {
  if (!logEntry || !payload || typeof payload !== 'object') return;
  if (typeof payload.model === 'string' && payload.model.trim()) {
    logEntry.resolvedModel = payload.model.trim();
  }
}

/** A `<prefix>_<uuid>` session id. Devin's request metadata is the only user. */
function makeProviderSessionId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

// True when the user brought their own FreeModels key (config or env). FreeModels
// routes keyless browser traffic, so an Authorization header shifts it onto
// Cloudflare's bot path and breaks requests — which is why the header is only sent
// for a user-supplied key. One owner for that decision, so the proxy, the manual
// test, and the background probe cannot disagree about what they send upstream.
function isExplicitFreemodelsKey(config, providerKey) {
  return providerKey === FREEMODELS_PROVIDER_KEY && getApiKeyPool(config, providerKey).length > 0;
}

/**
 * The credential-field writes a provider is allowed to receive, as `{ field: value | null }`
 * where `null` means "remove it".
 *
 * Restricted to the fields the provider's own descriptor declares, so a dashboard input
 * cannot become a way to write arbitrary keys into a provider's config entry. `from-environment`
 * is the dashboard echoing back a value the environment supplied: writing it into the config
 * would freeze an env var in place, so it removes the field and lets the environment keep
 * deciding — which also makes clearing a field mean the same thing in both directions.
 *
 * Pure, so the rule can be tested without a server.
 *
 * @param {string} providerKey
 * @param {object} incoming
 * @returns {Record<string, string|null>}
 */
export function credentialFieldWrites(providerKey, incoming) {
  const writes = {};
  if (!incoming || typeof incoming !== 'object') return writes;
  for (const field of requiredCredentialFields(providerKey)) {
    if (!(field in incoming)) continue;
    const value = normalizeSecretValue(incoming[field]);
    writes[field] = (!value || value === 'from-environment') ? null : value;
  }
  return writes;
}

export function buildProviderRequestHeaders(providerKey, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // FreeModels routes real keyless browser traffic, so a machine Authorization
  // header shifts it onto Cloudflare's bot path and breaks requests. Only send
  // credentials when the user explicitly configured a key for the provider.
  //
  // The header name and scheme come from the provider's descriptor, so a provider that
  // wants its key somewhere other than `Authorization: Bearer <key>` is a data change
  // rather than a new branch here. Every provider hammer shipped uses the defaults, so
  // this is behaviour-preserving for all of them.
  if (options.apiKey
    && !(providerKey === FREEMODELS_PROVIDER_KEY && !options.isExplicitFreemodelsKey)) {
    const authShape = getProvider(providerKey)?.auth;
    const headerName = authShape?.headerName || 'Authorization';
    const scheme = authShape?.scheme === undefined ? 'Bearer' : authShape.scheme;
    headers[headerName] = scheme ? `${scheme} ${options.apiKey}` : String(options.apiKey);
  }

  // Headers the provider requires regardless of the request (a vendor user-agent is the
  // common case). Applied after the credential so a descriptor cannot accidentally clobber
  // the auth header by declaring a static `Authorization`.
  if (options.skipShaping !== true) {
    for (const [name, value] of Object.entries(shapedHeaders(providerKey))) {
      if (name.toLowerCase() !== 'authorization') headers[name] = value;
    }
  }

  if (providerKey === DEVIN_PROVIDER_KEY) {
    // Devin authenticates via the protobuf metadata, never a bearer header (mirrors
    // the released Devin CLI / @oh-my-pi client).
    delete headers.Authorization;
    headers['Content-Type'] = 'application/connect+proto';
    headers.Accept = 'application/connect+proto';
    headers['Connect-Protocol-Version'] = '1';
    headers['Connect-Content-Encoding'] = 'gzip';
    headers['Connect-Accept-Encoding'] = 'gzip';
    headers['Accept-Encoding'] = 'identity';
    headers['User-Agent'] = 'connect-go/1.18.1 (go1.26.3)';
  } else if (providerKey === KIRO_PROVIDER_KEY) {
    headers.Accept = KIRO_STREAM_ACCEPT;
    headers['X-Amz-Target'] = KIRO_STREAMING_TARGET;
    headers['User-Agent'] = KIRO_SDK_USER_AGENT;
    headers['X-Amz-User-Agent'] = KIRO_AMZ_USER_AGENT;
    headers['Amz-Sdk-Request'] = 'attempt=1; max=3';
    headers['Amz-Sdk-Invocation-Id'] = randomUUID();
    headers['x-amzn-bedrock-cache-control'] = 'enable';
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  } else if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) {
    // The bearer (set above from options.apiKey) plus Copilot's client identity.
    // Chat defaults to the chat-surface integration id because Business orgs
    // commonly block the CLI/agentic surface; the router retries once as the CLI
    // identity when a plan denies chat instead. X-Initiator separates user-driven
    // chat (which spends premium requests) from automated agent traffic.
    const messages = Array.isArray(options.messages) ? options.messages : null;
    Object.assign(headers, buildCopilotIdentityHeaders({
      initiator: messages ? inferCopilotInitiator(messages) : 'agent',
      integrationId: options.copilotIntegrationId || COPILOT_CHAT_INTEGRATION_ID,
    }));
    if (messages && copilotMessagesHaveImages(messages)) headers['Copilot-Vision-Request'] = 'true';
  } else if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
    // Codex's bearer is a short-lived ChatGPT access token and the workspace id
    // header selects which subscription allowance pays for the request, so the
    // generic Authorization header is replaced by the full Codex identity. Without
    // a token the request stays anonymous rather than sending a literal "Bearer
    // null", which would read as a malformed credential instead of a missing one.
    delete headers.Authorization;
    if (options.apiKey) {
      Object.assign(headers, buildCodexIdentityHeaders(
        options.apiKey,
        options.codexAccountId || null,
        options.codexResidency || null,
      ));
    }
  }

  return headers;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = KIRO_CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicUuidFromSeed(seed) {
  const hex = createHash('sha1').update(String(seed || randomUUID())).digest('hex').slice(0, 32);
  const chars = hex.padEnd(32, '0').split('');
  chars[12] = '5';
  chars[16] = 'a';
  const normalized = chars.join('');
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}

function getOpenAIMessageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseKiroToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeKiroToolSpecs(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => {
    const name = tool?.function?.name || tool?.name || 'tool';
    const description = tool?.function?.description || tool?.description || `Tool: ${name}`;
    return {
      toolSpecification: {
        name,
        description: description.trim() || `Tool: ${name}`,
        inputSchema: {
          json: tool?.function?.parameters || tool?.parameters || tool?.input_schema || {},
        },
      },
    };
  });
}

/**
 * Convert OpenAI messages into Kiro history + currentMessage.
 *
 * Rules (mirrors OmniRoute openai-to-kiro translator):
 *   - system messages become standalone user-role history entries (not merged with subsequent turns)
 *   - tool role is normalized to user; consecutive user messages are merged into a single turn
 *   - tool-role messages add only to pendingToolResults (never to pendingUserContent)
 *   - tool_result blocks inside array content also add only to pendingToolResults
 *   - assistant messages with tool_calls flush and attach toolUses, then reset currentRole so
 *     the next message always starts a new turn
 *   - tools spec goes on the first history entry (seed for AWS cache) and on currentMessage;
 *     it is removed from history entries during clean-up
 */
function convertKiroMessages(messages, tools, modelId) {
  const history = [];
  let currentMessage = null;

  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let currentRole = null;

  const flushPending = () => {
    if (currentRole === 'user') {
      const content = pendingUserContent.join('\n\n').trim() || 'continue';
      const userMsg = { userInputMessage: { content, modelId: '' } };

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = { toolResults: [...pendingToolResults] };
      }

      if (tools && tools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = tools;
      }

      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
    } else if (currentRole === 'assistant') {
      const content = pendingAssistantContent.join('\n\n').trim() || '...';
      history.push({ assistantResponseMessage: { content } });
      pendingAssistantContent = [];
    }
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const originalRole = msg.role;

    // System messages: flush any pending turns, add as a standalone history user entry,
    // then reset so the next message starts a fresh turn (not merged with this one).
    if (originalRole === 'system') {
      if (currentRole !== null) flushPending();
      currentRole = null;

      const textContent = typeof msg.content === 'string'
        ? msg.content
        : getOpenAIMessageText(msg.content);
      if (textContent) {
        const sysMsg = { userInputMessage: { content: textContent, modelId: '' } };
        if (tools && tools.length > 0 && history.length === 0) {
          sysMsg.userInputMessage.userInputMessageContext = { tools };
        }
        history.push(sysMsg);
      }
      continue;
    }

    let role = originalRole;
    if (role === 'tool') role = 'user';

    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === 'user') {
      if (originalRole === 'tool') {
        // Tool result: goes only into toolResults, not into user text
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : getOpenAIMessageText(msg.content);
        pendingToolResults.push({
          toolUseId: msg.tool_call_id || randomUUID(),
          status: 'success',
          content: [{ text: toolContent || 'Tool completed successfully.' }],
        });
      } else {
        // User message: extract text and any tool_result blocks
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
            .map(c => c.text || '');
          textContent = textParts.join('\n');

          // Anthropic-style tool_result blocks
          const toolResultBlocks = msg.content.filter(c => c && c.type === 'tool_result');
          for (const block of toolResultBlocks) {
            const text = Array.isArray(block.content)
              ? block.content.map(c => c?.text || '').filter(Boolean).join('\n')
              : typeof block.content === 'string'
                ? block.content
                : '';
            pendingToolResults.push({
              toolUseId: block.tool_use_id || randomUUID(),
              status: 'success',
              content: [{ text }],
            });
          }
        }

        if (textContent) pendingUserContent.push(textContent);
      }
    } else if (role === 'assistant') {
      let textContent = '';
      let toolUses = [];

      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c && c.type === 'text');
        textContent = textBlocks.map(b => b.text || '').join('\n').trim();

        // Anthropic-style tool_use blocks
        const toolUseBlocks = msg.content.filter(c => c && c.type === 'tool_use');
        if (toolUseBlocks.length > 0) {
          toolUses = toolUseBlocks.map(tc => ({
            toolUseId: tc.id || randomUUID(),
            name: tc.name || 'tool',
            input: parseKiroToolInput(tc.input),
          }));
        }
      } else if (typeof msg.content === 'string') {
        textContent = msg.content.trim();
      }

      // OpenAI-style tool_calls array takes precedence
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls.map(tc => ({
          toolUseId: tc.id || randomUUID(),
          name: tc.function?.name || tc.name || 'tool',
          input: parseKiroToolInput(tc.function?.arguments),
        }));
      }

      if (textContent) pendingAssistantContent.push(textContent);

      if (toolUses.length > 0) {
        // Flush accumulated assistant text → creates assistantResponseMessage
        flushPending();
        // Attach toolUses to the just-created assistant message
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses;
        }
        // Reset so the next message always opens a fresh turn
        currentRole = null;
      }
    }
  }

  if (currentRole !== null) flushPending();

  // Pop last user message as currentMessage
  if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentMessage = history.pop();
  } else {
    currentMessage = { userInputMessage: { content: 'continue', modelId: '' } };
  }

  // Propagate tools to currentMessage (tools live only on currentMessage in the final payload)
  if (Array.isArray(tools) && tools.length > 0) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools;
  } else {
    const firstHistoryItem = history[0];
    if (
      firstHistoryItem?.userInputMessage?.userInputMessageContext?.tools &&
      !currentMessage?.userInputMessage?.userInputMessageContext?.tools
    ) {
      if (!currentMessage.userInputMessage.userInputMessageContext) {
        currentMessage.userInputMessage.userInputMessageContext = {};
      }
      currentMessage.userInputMessage.userInputMessageContext.tools =
        firstHistoryItem.userInputMessage.userInputMessageContext.tools;
    }
  }

  // Clean up history: remove tools from history entries, set modelId
  for (const item of history) {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (
      item.userInputMessage?.userInputMessageContext &&
      Object.keys(item.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = modelId;
    }
  }

  return { history, currentMessage };
}

export function buildKiroRequestPayload(body, modelId, options = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = normalizeKiroToolSpecs(body?.tools);
  const profileArn = options?.profileArn || null;

  const { history, currentMessage } = convertKiroMessages(messages, tools, modelId);

  const timestamp = new Date().toISOString();
  const rawContent = currentMessage?.userInputMessage?.content || 'continue';
  currentMessage.userInputMessage = {
    ...currentMessage.userInputMessage,
    content: `[Context: Current time is ${timestamp}]\n\n${rawContent}`,
    modelId,
    origin: 'AI_EDITOR',
  };

  // Deterministic conversationId: based on first history message (or currentMessage if no history)
  const firstContent = history.length > 0 && history[0].userInputMessage?.content
    ? history[0].userInputMessage.content
    : rawContent;
  const conversationId = deterministicUuidFromSeed(`${KIRO_CONVERSATION_NAMESPACE}:${firstContent.slice(0, 4000)}`);

  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage,
      history,
    },
  };

  if (profileArn) payload.profileArn = profileArn;

  const inferenceConfig = {};
  const maxTokens = body?.max_tokens ?? body?.max_completion_tokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) inferenceConfig.maxTokens = maxTokens;
  if (typeof body?.temperature === 'number') inferenceConfig.temperature = body.temperature;
  if (typeof body?.top_p === 'number') inferenceConfig.topP = body.top_p;
  if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;

  return payload;
}

function encodeVarint(value) {
  const bytes = [];
  let n = typeof value === 'bigint' ? value : BigInt(Math.max(0, Number(value) || 0));
  while (n > 127n) { bytes.push(Number((n & 127n) | 128n)); n >>= 7n; }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeProtoString(field, value) {
  const data = Buffer.from(String(value ?? ''), 'utf8');
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(data.length), data]);
}

function encodeProtoMessage(field, parts) {
  const data = Array.isArray(parts) ? Buffer.concat(parts) : parts;
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(data.length), data]);
}

function gzipConnectMessage(payload) {
  const compressed = requireGzip(payload);
  return Buffer.concat([Buffer.from([CONNECT_COMPRESSED_FLAG]), encodeUint32(compressed.length), compressed]);
}

function requireGzip(payload) {
  // Lazy require is unavailable in ESM; use the synchronous zlib import shim below.
  return gzipSync(payload);
}

function encodeUint32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function encodeProtoVarint(field, value) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function encodeProtoDouble(field, value) {
  const out = Buffer.alloc(8);
  out.writeDoubleLE(Number(value) || 0, 0);
  return Buffer.concat([encodeVarint((field << 3) | 1), out]);
}

function encodeProtoBool(field, value) {
  return value ? encodeProtoVarint(field, 1) : Buffer.alloc(0);
}

// Generic protobuf field walker for the messages hammer decodes from Devin.
function decodeProtoFields(buffer) {
  const out = [];
  let offset = 0;
  while (offset < buffer.length) {
    let tag = 0;
    let shift = 0;
    let byte;
    do {
      byte = buffer[offset];
      offset += 1;
      tag |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0 && offset < buffer.length);
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      let value = 0;
      shift = 0;
      do {
        byte = buffer[offset];
        offset += 1;
        value += (byte & 0x7f) * (2 ** shift);
        shift += 7;
      } while ((byte & 0x80) !== 0 && offset < buffer.length);
      out.push({ field, wireType, value });
    } else if (wireType === 2) {
      let length = 0;
      shift = 0;
      do {
        byte = buffer[offset];
        offset += 1;
        length += (byte & 0x7f) * (2 ** shift);
        shift += 7;
      } while ((byte & 0x80) !== 0 && offset < buffer.length);
      out.push({ field, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === 1 || wireType === 5) {
      const width = wireType === 1 ? 8 : 4;
      out.push({ field, wireType, value: buffer.subarray(offset, offset + width) });
      offset += width;
    } else {
      break;
    }
  }
  return out;
}

function getProtoString(fields, field) {
  for (const entry of fields) {
    if (entry.field === field && entry.wireType === 2) return Buffer.from(entry.value).toString('utf8');
  }
  return '';
}

function getProtoVarint(fields, field) {
  for (const entry of fields) {
    if (entry.field === field && entry.wireType === 0) return Number(entry.value) || 0;
  }
  return 0;
}

// exa.codeium_common_pb.Metadata field numbers used by the current gateway:
// 1 ideName, 2 extensionVersion, 3 apiKey, 4 locale, 5 os, 7 ideVersion,
// 10 sessionId, 12 extensionName, 21 userJwt, 28 ideType.
function encodeDevinMetadata(options = {}) {
  const parts = [
    encodeProtoString(1, 'devin-cli'),
    encodeProtoString(2, DEVIN_CLI_IDE_VERSION),
    encodeProtoString(3, normalizeDevinToken(options.apiKey)),
    encodeProtoString(4, 'en'),
    encodeProtoString(5, DEVIN_OS),
    encodeProtoString(7, DEVIN_CLI_IDE_VERSION),
    encodeProtoString(12, 'chisel'),
    encodeProtoString(28, 'chisel'),
  ];
  if (options.sessionId) parts.push(encodeProtoString(10, options.sessionId));
  if (options.userJwt) parts.push(encodeProtoString(21, options.userJwt));
  return Buffer.concat(parts);
}

// exa.chat_pb.ChatToolCall: 1 id, 2 name, 3 argumentsJson.
function encodeDevinToolCall(toolCall = {}) {
  const parts = [];
  if (toolCall.id) parts.push(encodeProtoString(1, toolCall.id));
  if (toolCall.name) parts.push(encodeProtoString(2, toolCall.name));
  if (typeof toolCall.arguments === 'string' && toolCall.arguments) parts.push(encodeProtoString(3, toolCall.arguments));
  return Buffer.concat(parts);
}

// exa.chat_pb.ChatToolDefinition: 1 name, 2 description, 3 jsonSchemaString.
function encodeDevinToolDefinition(tool) {
  const fn = tool?.function || tool || {};
  const parts = [];
  if (fn.name) parts.push(encodeProtoString(1, fn.name));
  if (fn.description) parts.push(encodeProtoString(2, fn.description));
  let schema = fn.parameters;
  if (schema && typeof schema !== 'string') {
    try { schema = JSON.stringify(schema); } catch { schema = '{}'; }
  }
  parts.push(encodeProtoString(3, String(schema || '{}')));
  return Buffer.concat(parts);
}

// exa.chat_pb.ChatMessagePrompt: 1 messageId, 2 source (USER=1, SYSTEM=2,
// TOOL=4), 3 prompt, 6 toolCalls (repeated), 7 toolCallId, 9 toolResultIsError.
function encodeDevinChatMessagePrompt(message, cascadeId, index) {
  const role = message?.role || 'user';
  const messageId = deterministicUuidFromSeed(`${cascadeId}\0${index}\0${role}\0${message?.tool_call_id || ''}`);
  const parts = [
    encodeProtoString(1, messageId),
    encodeProtoVarint(2, role === 'assistant' ? 2 : (role === 'tool' ? 4 : 1)),
    encodeProtoString(3, getOpenAIMessageText(message.content)),
  ];
  if (role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const fn = toolCall?.function || {};
      parts.push(encodeProtoMessage(6, encodeDevinToolCall({
        id: toolCall?.id || '',
        name: fn.name || '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      })));
    }
  }
  if (role === 'tool') {
    if (message.tool_call_id) parts.push(encodeProtoString(7, message.tool_call_id));
    parts.push(encodeProtoBool(9, message.is_error === true));
  }
  return Buffer.concat(parts);
}

// exa.codeium_common_pb.CompletionConfiguration: 1 numCompletions, 2 maxTokens,
// 3 maxNewlines, 5 temperature, 6 firstTemperature, 7 topK, 8 topP,
// 9 stopPatterns (repeated), 11 fimEotProbThreshold.
function encodeDevinCompletionConfiguration(body = {}) {
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.4;
  const maxTokens = Math.floor(Number(body.max_tokens ?? body.max_completion_tokens) || 64000);
  const parts = [
    encodeProtoVarint(1, 1),
    encodeProtoVarint(2, Math.max(1, maxTokens)),
    encodeProtoVarint(3, 200),
    encodeProtoDouble(5, temperature),
    encodeProtoDouble(6, temperature),
    encodeProtoVarint(7, 50),
    encodeProtoDouble(8, 1),
    ...DEVIN_DEFAULT_STOP_PATTERNS.map(stop => encodeProtoString(9, stop)),
    encodeProtoDouble(11, 1),
  ];
  return Buffer.concat(parts);
}

// exa.api_server_pb.GetChatMessageRequest — canonical wire layout, mirroring the
// released Devin CLI (and @oh-my-pi). Field 2 carries the flattened system prompt
// and field 3 the per-turn ChatMessagePrompt history; tools ride in field 10.
function buildDevinConnectRequest(body, modelId, options = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const cascadeId = options.conversationId || options.sessionId || deterministicUuidFromSeed(JSON.stringify(messages).slice(0, 4000));
  const system = messages.filter(m => m?.role === 'system').map(m => getOpenAIMessageText(m.content)).filter(Boolean).join('\n\n');
  const requestParts = [
    encodeProtoMessage(1, encodeDevinMetadata({ apiKey: options.apiKey, userJwt: options.userJwt, sessionId: options.sessionId })),
    encodeProtoString(2, system),
    encodeProtoVarint(7, 5), // requestType = CASCADE
    encodeProtoMessage(8, encodeDevinCompletionConfiguration(body)),
    encodeProtoVarint(11, 1), // disableParallelToolCalls
    encodeProtoMessage(12, encodeProtoString(1, 'auto')), // toolChoice { optionName: 'auto' }
    encodeProtoMessage(13, encodeProtoVarint(1, 1)), // systemPromptCacheOptions { type: EPHEMERAL }
    encodeProtoString(16, cascadeId),
    encodeProtoVarint(20, 1), // plannerMode = DEFAULT
    encodeProtoString(21, devinChatModelUid(modelId || body?.model)),
    encodeProtoString(22, randomUUID()), // executionId
  ];
  let promptIndex = 0;
  for (const message of messages) {
    if (!message || message?.role === 'system') continue;
    requestParts.push(encodeProtoMessage(3, encodeDevinChatMessagePrompt(message, cascadeId, promptIndex++)));
  }
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) requestParts.push(encodeProtoMessage(10, encodeDevinToolDefinition(tool)));
  }
  return gzipConnectMessage(Buffer.concat(requestParts));
}

function normalizeDevinToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) return '';
  return token.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? token : `${DEVIN_SESSION_TOKEN_PREFIX}${token}`;
}

function buildFreeModelsRequestPayload(body, modelId) {
  // FreeModels uses a custom request format:
  // - 'modelId' instead of 'model'
  // - 'thinking' and 'deepSearch' flags
  // Transform from OpenAI format to FreeModels format
  const payload = {
    modelId: modelId || body?.model,
    messages: body?.messages || [],
    // The backend currently fails non-streaming requests with a Worker
    // subrequest-limit error. Always use its working SSE path and aggregate
    // it back to JSON when the caller requested a non-streaming response.
    stream: true,
    thinking: body?.thinking === true,
    deepSearch: body?.deepSearch === true
  };

  // Copy over temperature and other optional parameters if present
  if (body?.temperature !== undefined) {
    payload.temperature = body.temperature;
  }
  if (body?.top_p !== undefined) {
    payload.top_p = body.top_p;
  }
  if (body?.max_tokens !== undefined) {
    payload.max_tokens = body.max_tokens;
  }

  return payload;
}

// gptfree's wire format: one current message plus the turns before it. There is no model
// parameter and no system slot, so a system prompt is folded into the user turn it
// introduces rather than dropped — discarding it would quietly change what the model is
// asked to do, which is worse than the coupling.
function gptFreeTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('')
    .trim();
}

// Attachments travel beside the turn, in the two shapes their client sends: an image URL
// (or data URI) and an Anthropic-style base64 source. Text parts are handled above.
function gptFreeImagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    const type = String(part.type || '');
    const url = part.image_url?.url ?? part.image_url;
    if (typeof url === 'string' && url.trim() && type.includes('image')) return [url.trim()];
    if (typeof part.source?.data === 'string' && part.source.data) {
      return [`data:${part.source.media_type || 'image/png'};base64,${part.source.data}`];
    }
    return [];
  });
}

// Their protocol separates the question from the transcript, so the last user turn is lifted
// out as `message` and everything else keeps its order in `history`. Ordering is built first
// and lifted after, rather than by flushing each turn as its successor arrives: that shape
// put an assistant reply ahead of the user turn it answered, which is a reordered
// conversation, not a shortened one.
export function buildGptFreeRequestPayload(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const turns = [];
  const systemText = [];
  let lastUserIndex = -1;

  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const role = String(entry.role || 'user').toLowerCase();
    const text = gptFreeTextOf(entry.content);

    if (role === 'system' || role === 'developer') {
      if (text.trim()) systemText.push(text.trim());
      continue;
    }

    if (role === 'tool' || role === 'function') {
      if (text.trim()) {
        turns.push({ type: 'tool_result', content: text, tool_name: entry.name || entry.tool_call_id || 'tool' });
      }
      continue;
    }

    if (role === 'assistant') {
      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (const call of calls) {
        const name = call?.function?.name || 'tool';
        turns.push({
          type: 'tool_execution',
          content: `Used ${name} tool`,
          tool_name: name,
          tool_input: call?.function?.arguments ?? null,
        });
      }
      // A turn that only asked for a tool has nothing to say as an agent turn; the
      // tool_execution entry above carries it.
      if (text.trim() || calls.length === 0) turns.push({ type: 'agent', content: text });
      continue;
    }

    const images = gptFreeImagesOf(entry.content);
    turns.push({ type: 'user', content: text, ...(images.length ? { images } : {}) });
    lastUserIndex = turns.length - 1;
  }

  const current = lastUserIndex >= 0 ? turns[lastUserIndex] : { type: 'user', content: '' };
  const history = turns.filter((_, index) => index !== lastUserIndex);
  const message = current.content || '';

  return {
    message: systemText.length > 0 ? `${systemText.join('\n\n')}\n\n${message}` : message,
    images: current.images || [],
    history,
  };
}

// Where a relay reports the model that actually served the request. OpenAI puts
// it on the chunk itself, but relays vary: some hang it off the choice, or inside
// the delta/message object, and FreeModels-style payloads use `modelId`. Reading
// all of them keeps the captured name correct without hardcoding any backend.
function upstreamModelIdOfPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const direct = [payload.model, payload.modelId].find(value => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice || typeof choice !== 'object') return null;
  for (const node of [choice.delta, choice.message, choice]) {
    if (node && typeof node === 'object' && typeof node.model === 'string' && node.model.trim()) {
      return node.model.trim();
    }
  }
  return null;
}

// Best-effort extraction of the *upstream* model id a provider reports in its
// response frames. Catalog ids (what we asked for) and the backend that actually
// answers can differ — FreeModels persona entries are the live example. Works on
// a JSON completion body or a raw SSE transcript; returns null when absent.
function extractUpstreamModelId(text) {
  if (text == null) return null;
  const raw = typeof text === 'string' ? text : String(text);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { candidates.push(JSON.parse(trimmed)); } catch { /* fall through to SSE */ }
  }
  for (const line of raw.split(/\r?\n/)) {
    const lineText = line.trim();
    if (!lineText.startsWith('data:')) continue;
    const frame = lineText.slice(5).trim();
    if (!frame || frame === '[DONE]') continue;
    try { candidates.push(JSON.parse(frame)); } catch { /* skip */ }
  }
  for (const payload of candidates) {
    const modelId = upstreamModelIdOfPayload(payload);
    if (modelId) return modelId;
  }
  return null;
}

// The id a row's intelligence is scored on, and the curated 0-1 score to use when
// no benchmark covers it. A persona relay (FreeModels) serves catalog rows from a
// backend other than the name it advertises, so the learned backend id is scored
// first; when neither the catalog nor scores.js knows that backend, the persona's
// own curated score still applies — a known persona must never demote to unknown
// just because its relay rotated to a backend no benchmark data covers.
// Returns { lookupId, localScore }.
export function resolveQualityLookup(modelId, resolvedModelId) {
  // Compare identity, not the g4f routing namespace: a relay that merely echoes
  // "srv_ab12:model" (or reports its own namespaced id) has revealed nothing new.
  const bareModelId = stripRoutingNamespace(modelId);
  const backendId = stripRoutingNamespace(typeof resolvedModelId === 'string' ? resolvedModelId.trim() : '');
  if (!backendId || backendId === bareModelId) {
    return { lookupId: modelId, localScore: getScore(modelId) };
  }
  return { lookupId: backendId, localScore: getScore(backendId) ?? getScore(modelId) };
}

// A 200-status SSE stream carrying only an error frame is turned into this
// synthetic 503 so the generic retry logic (isRetryableProxyStatus) can fail
// over to the next candidate model without FreeModels-specific knowledge.
// One shape for an error that arrived inside an HTTP 200: a 503 whose body is a flat error
// envelope carrying the provider's own words. Shared by the FreeModels transform, the generic
// streamed-upstream-error peek and the proxy's non-streamed body check, so every consumer
// reaches the same verdict through findUpstreamSseError and the proxy's retry loop can fail
// over instead of piping a silent 200 to the client.
//
// The message goes through extractErrorMessage rather than reading `.message` directly: a relay
// that nests the real text in `error.errors[]` (g4f) would otherwise be flattened to the generic
// fallback, which is how "rate limiting: inference request per min rate reached" became "Model
// returned no text" on the dashboard.
function syntheticUpstreamErrorResponse(upstreamError) {
  const body = {
    error: {
      message: extractErrorMessage(upstreamError) || 'Upstream reported an error.',
      type: (upstreamError && upstreamError.type) || 'upstream_error',
      code: (upstreamError && upstreamError.code) || 503,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function transformFreeModelsResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;

  // FreeModels' working path is SSE even for callers that asked for JSON. When
  // its backend is overloaded it opens the stream with HTTP 200 and then emits
  // `data: {"error":{"message":"Service temporarily overloaded",...}}` — a
  // garbage success that must never reach the client. Peek at the first frame:
  // an error converts to a synthetic 503 (whose body is the error envelope, so
  // every consumer reads the same transient verdict through findUpstreamSseError)
  // so the proxy retry loop can transparently fail over to the next candidate
  // model, a normal frame means the stream is real and is returned untouched
  // (streaming) or aggregated below (JSON).
  if (stream) {
    const reader = response.body?.getReader();
    if (!reader) return response;
    const decoder = new TextDecoder();
    let buffered = '';
    while (!buffered.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > 8192) break; // malformed huge frame: let the pipeline handle it
    }

    const firstLine = buffered.split(/\r?\n/, 1)[0];
    if (firstLine.startsWith('data:')) {
      const frame = firstLine.slice(5).trim();
      if (frame && frame !== '[DONE]') {
        // Through the shared envelope rule rather than a bare `chunk.error` check, so a relay
        // that nests the message (g4f's `error.errors[]`) is read here too (see
        // findUpstreamSseError). It parses the frame itself and returns null for a non-error one.
        const upstreamError = findUpstreamSseError(frame);
        if (upstreamError) {
          try { await reader.cancel(); } catch { /* already closed */ }
          return syntheticUpstreamErrorResponse(upstreamError);
        }
      }
    }
    // Reconstruct a stream that starts with the peeked bytes so no data is lost.
    const rest = new ReadableStream({
      start(controller) {
        if (buffered) controller.enqueue(new TextEncoder().encode(buffered));
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(rest, { status: response.status, headers: response.headers });
  }

  const raw = await response.text();
  const upstreamError = findUpstreamSseError(raw);
  if (upstreamError) {
    return syntheticUpstreamErrorResponse(upstreamError);
  }

  let id = `chatcmpl-${randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let responseModel = modelId;
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    const chunkModel = upstreamModelIdOfPayload(chunk);
    if (chunkModel) responseModel = chunkModel;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  return new Response(JSON.stringify({
    id,
    object: 'chat.completion',
    created,
    model: responseModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  }), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Reads gptfree's event stream. It is SSE with *named* events rather than OpenAI's bare
 * `data:` frames, and the names matter: `keepalive` frames carry an empty object, `step_start`
 * and `step_complete` describe tool work their server-side agent did on the user's behalf, and
 * `error` frames report failures inside an HTTP 200 — the same garbage-success shape
 * transformStreamingUpstreamErrorResponse exists to catch on other relays.
 */
async function* readGptFreeEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let eventName = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim()) {
        eventName = '';
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let payload = null;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      yield { event: eventName, payload };
    }
  }
}

/**
 * gptfree's SSE -> OpenAI chat.completion(.chunk) frames.
 *
 * Three things about their stream shape this translation, and each is a choice rather
 * than an accident:
 *
 * - Answer text arrives twice: as a run of `message` deltas (their own live preview) and
 *   once more in the terminal `response` frame, which is the text their client actually
 *   keeps. Aggregating for a non-streaming caller therefore prefers `response` — the
 *   authoritative copy — while a streaming caller gets the deltas as they arrive (so
 *   hammer's time-to-first-token is the real one) with only the remaining tail appended if
 *   the two agree on a prefix. A raw pass-through would emit the answer twice.
 * - `step_start`/`step_complete` frames carry a `message` field that is not the answer; they
 *   are dropped. Their `tool_name`/`tool_input` describe work their backend did, not a tool
 *   call the client can see, so no tool_calls frame is synthesized for them — inventing one
 *   would tell the client to run a tool that has already run.
 * - No usage numbers exist anywhere in their protocol, so `usage` is omitted and hammer's
 *   own token estimate covers the row (same as any relay that reports nothing).
 */
export async function transformGptFreeResponse(response, modelId, stream = false) {
  if (!response?.ok || !response.body) return response;

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const responseModel = modelId || 'auto';

  if (!stream) {
    let content = '';
    let streamedSoFar = '';
    let upstreamError = null;
    for await (const { payload } of readGptFreeEvents(response.body)) {
      if (payload.error) {
        upstreamError = extractErrorMessage(payload.error) || 'gptfree reported an error.';
        break;
      }
      if (payload.step_id) continue;
      if (typeof payload.response === 'string' && payload.response.trim()) {
        content = payload.response;
        break;
      }
      if (typeof payload.message === 'string' && payload.message) streamedSoFar += payload.message;
    }
    if (upstreamError) return syntheticUpstreamErrorResponse(upstreamError);
    // A stream that ended without its terminal frame still produced the deltas; losing
    // them would turn a truncated answer into "returned no text".
    if (!content) content = streamedSoFar;

    return new Response(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: responseModel,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const chunk = (delta) => `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: responseModel,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
  const finalFrame = `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: responseModel,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;

  let emitted = '';
  const body = new ReadableStream({
    async start(controller) {
      // The role-only opening frame is what OpenAI clients expect before any content, so a
      // consumer that keys off `delta.role` still sees an assistant turn.
      controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: '' })));
      try {
        for await (const { payload } of readGptFreeEvents(response.body)) {
          if (payload.error) {
            const message = extractErrorMessage(payload.error) || 'gptfree reported an error.';
            // Mid-stream there is no status code left to change, and ending the body
            // without a finish_reason is the same signal a dropped socket gives — plus an
            // error frame, which hammer's own transcript reader understands.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`));
            controller.close();
            return;
          }
          if (payload.step_id) continue;
          if (typeof payload.response === 'string' && payload.response.trim()) {
            const tail = payload.response.startsWith(emitted) ? payload.response.slice(emitted.length) : '';
            if (tail) controller.enqueue(encoder.encode(chunk({ content: tail })));
            break;
          }
          if (typeof payload.message === 'string' && payload.message) {
            emitted += payload.message;
            controller.enqueue(encoder.encode(chunk({ content: payload.message })));
          }
        }
        controller.enqueue(encoder.encode(finalFrame));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        // The reader failed (or the client went away). Whatever was delivered stays
        // delivered; close quietly rather than appending a fabricated finish.
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      return response.body.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

// A provider may open an SSE stream with an error frame despite returning 200.
// Peek only the first frame so the retry loop can switch models before exposing
// the failure to the client, while preserving the stream for normal responses.
export async function transformStreamingUpstreamErrorResponse(response) {
  if (!response?.ok || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  while (!buffered.includes('\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    if (buffered.length > 8192) break;
  }
  const firstLine = buffered.split(/\r?\n/, 1)[0];
  if (firstLine.startsWith('data:')) {
    const frame = firstLine.slice(5).trim();
    if (frame && frame !== '[DONE]') {
      // findUpstreamSseError is the one rule for "this frame is an error envelope": a plain
      // `error.message` envelope and a relay's nested `error.errors[]` have to be recognized
      // identically, or this peek hands a rate limit on as a normal stream. It parses the frame
      // itself and returns null for a malformed or ordinary one.
      const upstreamError = findUpstreamSseError(frame);
      if (upstreamError) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return syntheticUpstreamErrorResponse(upstreamError);
      }
    }
  }
  const rest = new ReadableStream({
    start(controller) {
      if (buffered) controller.enqueue(new TextEncoder().encode(buffered));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(rest, { status: response.status, headers: response.headers });
}

// Serialize provider request bodies. Devin (and Kiro-style protobuf builders) return a
// Buffer that must be sent raw; JSON.stringify on a Buffer would mangle it into
// {"type":"Buffer","data":[...]} and produce garbage responses.
function serializeProviderRequestBody(body) {
  return Buffer.isBuffer(body) ? body : JSON.stringify(body);
}

// exa.auth_pb.GetUserJwtResponse — unary responses may arrive as plain protobuf or gzipped.
function decodeDevinAuthResponse(buffer) {
  let raw = buffer;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try { raw = gunzipSync(raw); } catch { return null; }
  }
  const fields = decodeProtoFields(raw);
  const userJwt = getProtoString(fields, 1);
  if (!userJwt) return null;
  return { userJwt, customApiServerUrl: getProtoString(fields, 2) };
}

// exa.api_server_pb.GetCliModelConfigsResponse: field 1 = repeated ClientModelConfig.
// ClientModelConfig: 1 label, 4 disabled, 18 maxTokens, 22 modelUid.
export function decodeDevinModelConfigsPayload(buffer) {
  const out = [];
  for (const entry of decodeProtoFields(buffer)) {
    if (entry.field !== 1 || entry.wireType !== 2) continue;
    const cf = decodeProtoFields(entry.value);
    const uid = getProtoString(cf, 22);
    if (!uid) continue;
    out.push({
      uid,
      label: getProtoString(cf, 1),
      disabled: getProtoVarint(cf, 4) === 1,
      maxTokens: getProtoVarint(cf, 18),
    });
  }
  return out;
}

// exa.api_server_pb.GetChatMessageResponse: 1 messageId, 3 deltaText, 5 stopReason,
// 6 deltaToolCalls (repeated ChatToolCall), 7 usage, 9 deltaThinking, 10 deltaSignature.
export function decodeDevinChatResponsePayload(buffer) {
  const fields = decodeProtoFields(buffer);
  const result = { messageId: '', deltaText: '', deltaThinking: '', stopReason: 0, deltaToolCalls: [], usage: null };
  result.messageId = getProtoString(fields, 1);
  result.deltaText = getProtoString(fields, 3);
  result.stopReason = getProtoVarint(fields, 5);
  result.deltaThinking = getProtoString(fields, 9);
  for (const entry of fields) {
    if (entry.field === 6 && entry.wireType === 2) {
      const toolCallFields = decodeProtoFields(entry.value);
      result.deltaToolCalls.push({
        id: getProtoString(toolCallFields, 1),
        name: getProtoString(toolCallFields, 2),
        argumentsJson: getProtoString(toolCallFields, 3),
      });
    } else if (entry.field === 7 && entry.wireType === 2) {
      const usageFields = decodeProtoFields(entry.value);
      result.usage = {
        inputTokens: getProtoVarint(usageFields, 1),
        outputTokens: getProtoVarint(usageFields, 2),
        cacheReadTokens: getProtoVarint(usageFields, 3),
        cacheWriteTokens: getProtoVarint(usageFields, 4),
      };
    }
  }
  return result;
}

// Connect protocol framing: 1 flag byte + 4-byte big-endian length + payload.
// Returns complete frames plus any trailing partial bytes (kept for the next chunk).
export function parseConnectFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (length > DEVIN_MAX_CONNECT_FRAME_PAYLOAD) break;
    if (offset + 5 + length > buffer.length) break;
    frames.push({ flags, payload: buffer.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function parseConnectTrailerError(text) {
  if (!text) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  const error = parsed?.error;
  if (!error || typeof error !== 'object') return null;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (!code && !message) return null;
  let formatted = `Devin stream error${code ? ` ${code}` : ''}: ${message}`;
  // The gateway masks model-entitlement rejections as an opaque "internal error";
  // the actionable fix is switching to a model the account can actually use.
  if ((code === 'permission_denied' || code === 'invalid_argument') && /internal error/i.test(message)) {
    formatted += ' — the account may not be entitled to this model; run the Devin model refresh and pick an enabled model (see the Devin provider card).';
  }
  return { code, message, formatted };
}

const devinUserJwtCache = new Map(); // normalized token -> { userJwt, customApiServerUrl, expiresAt }
const _devinOAuthFlows = new Map(); // flowId -> active Devin browser-OAuth flow
const DEVIN_USER_JWT_CACHE_MS = 5 * 60_000;

// Session token -> user JWT prelude, mirroring the released Devin CLI: the same
// canonical client metadata sent as a unary application/proto GetUserJwt request.
// The returned JWT (plus any account-specific api server URL) authorizes the chat call.
export async function fetchDevinUserJwt(apiKey, options = {}) {
  const token = normalizeDevinToken(apiKey);
  if (!token) throw new Error('Devin auth requires a Devin session token (devin-session-token$<jwt>).');
  const cached = devinUserJwtCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { userJwt: cached.userJwt, customApiServerUrl: cached.customApiServerUrl };
  }
  const authBody = encodeProtoMessage(1, encodeDevinMetadata({ apiKey: token }));
  const response = await fetch(`${DEVIN_API_URL}${DEVIN_AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
      Accept: '*/*',
      'User-Agent': 'connect-go/1.18.1 (go1.26.3)',
    },
    body: authBody,
    signal: options.signal,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    let message = buffer.toString('utf8').trim();
    try {
      const parsed = JSON.parse(message);
      message = parsed?.message || message;
    } catch { /* body was plain text */ }
    throw new Error(`Devin auth failed (HTTP ${response.status}): ${message}`);
  }
  const auth = decodeDevinAuthResponse(buffer);
  if (!auth) throw new Error('Devin auth failed: GetUserJwt returned an unreadable response.');
  devinUserJwtCache.set(token, {
    userJwt: auth.userJwt,
    customApiServerUrl: auth.customApiServerUrl,
    expiresAt: Date.now() + DEVIN_USER_JWT_CACHE_MS,
  });
  return { userJwt: auth.userJwt, customApiServerUrl: auth.customApiServerUrl };
}

// Live model discovery: GetCliModelConfigs with the account's session token
// returns the model surface the account is actually entitled to (per-account
// entitlements vary; e.g. Devin Free only enables swe-1-6-slow). Requests for
// uids outside this list are rejected by the gateway with permission_denied.
export async function fetchDevinModelConfigs(apiKey, options = {}) {
  const token = normalizeDevinToken(apiKey);
  if (!token) throw new Error('Devin model discovery requires a Devin session token.');
  const response = await fetch(`${DEVIN_API_URL}${DEVIN_CONFIGS_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
      Accept: '*/*',
      'User-Agent': 'connect-go/1.18.1 (go1.26.3)',
    },
    body: encodeProtoMessage(1, [encodeDevinMetadata({ apiKey: token })]),
    signal: options.signal,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    let message = buffer.toString('utf8').trim();
    try {
      const parsed = JSON.parse(message);
      message = parsed?.message || message;
    } catch { /* body was plain text */ }
    throw new Error(`Devin model discovery failed (HTTP ${response.status}): ${message}`);
  }
  const raw = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
    ? gunzipSync(buffer)
    : buffer;
  return decodeDevinModelConfigsPayload(raw);
}

export function buildProviderRequestBody(providerKey, body, modelId, options = {}) {
  if (providerKey === KIRO_PROVIDER_KEY) {
    return buildKiroRequestPayload(body, modelId || body?.model, options);
  }
  if (providerKey === DEVIN_PROVIDER_KEY) {
    return buildDevinConnectRequest(body, modelId || body?.model, options);
  }
  if (providerKey === FREEMODELS_PROVIDER_KEY) {
    return buildFreeModelsRequestPayload(body, modelId || body?.model);
  }
  if (providerKey === GPTFREE_PROVIDER_KEY) {
    // Not OpenAI-shaped and not model-selectable: one message, the turns before it, and
    // whatever images were attached. See buildGptFreeRequestPayload.
    return buildGptFreeRequestPayload(body);
  }
  if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
    // Codex speaks the Responses API, which is not a superset of chat.completions:
    // system turns, tool calls and sampling controls all have to be re-shaped.
    return buildCodexRequestPayload(body, modelId || body?.model, options);
  }
  // Everything above reaches for a provider-specific payload builder because its wire format
  // differs. The rest of the catalog differs only in *fields*, and those are declared on the
  // descriptor — so one call covers a model-id prefix, frozen request defaults, a content
  // shape the provider refuses, and a conditional flag. A provider with no shaping block (all
  // of hammer's own, and most of the import) returns the body untouched.
  return applyRequestShaping(providerKey, body, modelId || body?.model).body;
}

export function parseKiroEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);

    if (totalLength < 16 || totalLength !== data.length) return null;

    const preludeCrc = view.getUint32(8, false);
    if (preludeCrc !== crc32(data.slice(0, 8))) return null;

    const messageCrc = view.getUint32(data.length - 4, false);
    if (messageCrc !== crc32(data.slice(0, data.length - 4))) return null;

    const headers = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLength = data[offset];
      offset += 1;
      const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
      offset += nameLength;

      const headerType = data[offset];
      offset += 1;
      if (headerType !== 7) return null;

      const valueLength = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      const value = new TextDecoder().decode(data.slice(offset, offset + valueLength));
      offset += valueLength;
      headers[name] = value;
    }

    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4;
    const payloadText = new TextDecoder().decode(data.slice(payloadStart, payloadEnd)).trim();

    return {
      headers,
      payload: payloadText ? JSON.parse(payloadText) : null,
    };
  } catch {
    return null;
  }
}

function getKiroToolCallArgumentString(input) {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  // Kiro streams tool input as partial JSON fragments via input.raw.
  // Emit the raw string directly so callers can concatenate fragments.
  if (typeof input.raw === 'string') return input.raw;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function getKiroFrameError(frame) {
  if (!frame) return null;
  const headers = frame.headers || {};
  const eventType = headers[':event-type'] || '';
  const messageType = headers[':message-type'] || '';
  const exceptionType = headers[':exception-type'] || headers[':error-code'] || '';
  const payload = frame.payload;
  const isErrorFrame =
    messageType === 'exception'
    || /(?:exception|error)$/i.test(eventType)
    || Boolean(exceptionType);

  if (!isErrorFrame) return null;

  const message = normalizeSecretValue(
    payload?.message
    || payload?.Message
    || payload?.error
    || payload?.errorMessage
    || payload?.error_description
  ) || 'Kiro provider returned an EventStream error.';

  return {
    message,
    code: normalizeSecretValue(exceptionType || eventType || messageType) || 'KiroEventStreamError',
  };
}

function createKiroErrorResponse(error, status = 502) {
  return new Response(JSON.stringify({
    error: {
      message: error?.message || 'Kiro provider returned an EventStream error.',
      type: 'kiro_error',
      code: error?.code || 'KiroEventStreamError',
    },
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function transformKiroResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;

  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    let finishSent = false;
    let toolCallIndex = 0;
    const seenToolIds = new Map();
    let usage = null;
    let totalContentLength = 0;
    let contextUsagePercentage = 0;

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const nextBuffer = new Uint8Array(buffer.length + chunk.length);
        nextBuffer.set(buffer);
        nextBuffer.set(chunk, buffer.length);
        buffer = nextBuffer;

        while (buffer.length >= 16) {
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLength = view.getUint32(0, false);
          if (totalLength < 16 || buffer.length < totalLength) break;

          const frameBytes = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);
          const frame = parseKiroEventFrame(frameBytes);
          if (!frame) continue;

          const eventType = frame.headers[':event-type'] || '';
          const payload = frame.payload;
          const error = getKiroFrameError(frame);
          if (error && !finishSent) {
            finishSent = true;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { ...error, type: 'kiro_error' } })}\n\n`));
            continue;
          }

          if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && typeof payload?.content === 'string' && payload.content) {
            totalContentLength += payload.content.length;
            const chunkPayload = {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [{
                index: 0,
                delta: chunkIndex === 0 ? { role: 'assistant', content: payload.content } : { content: payload.content },
                finish_reason: null,
              }],
            };
            chunkIndex += 1;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunkPayload)}\n\n`));
            continue;
          }

          if (eventType === 'toolUseEvent' && payload) {
            const toolEvents = Array.isArray(payload) ? payload : [payload];
            for (const toolEvent of toolEvents) {
              const toolId = toolEvent?.toolUseId || randomUUID();
              let index = seenToolIds.get(toolId);
              if (index == null) {
                index = toolCallIndex++;
                seenToolIds.set(toolId, index);
                const startChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: 'assistant' } : {}),
                      tool_calls: [{
                        index,
                        id: toolId,
                        type: 'function',
                        function: {
                          name: toolEvent?.name || 'tool',
                          arguments: '',
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                chunkIndex += 1;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              }

              const args = getKiroToolCallArgumentString(toolEvent?.input);
              if (args) {
                const argsChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index,
                        function: { arguments: args },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                chunkIndex += 1;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
            continue;
          }

          if (eventType === 'metricsEvent') {
            const metrics = payload?.metricsEvent && typeof payload.metricsEvent === 'object'
              ? payload.metricsEvent
              : payload;
            if (metrics && typeof metrics === 'object') {
              const promptTokens = Number(metrics.inputTokens || 0);
              const completionTokens = Number(metrics.outputTokens || 0);
              usage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              };
            }
            continue;
          }

          if (eventType === 'contextUsageEvent' && !usage) {
            const pct = typeof payload?.contextUsagePercentage === 'number'
              ? payload.contextUsagePercentage
              : 0;
            if (pct > 0) contextUsagePercentage = pct;
            continue;
          }

          if (eventType === 'messageStopEvent' && !finishSent) {
            // Fallback: estimate usage from contextUsageEvent if metricsEvent was absent
            if (!usage && (totalContentLength > 0 || contextUsagePercentage > 0)) {
              const estOutput = totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0;
              const estInput = contextUsagePercentage > 0 ? Math.floor((contextUsagePercentage * KIRO_MAX_CONTEXT_TOKENS) / 100) : 0;
              if (estInput > 0 || estOutput > 0) {
                usage = { prompt_tokens: estInput, completion_tokens: estOutput, total_tokens: estInput + estOutput };
              }
            }
            finishSent = true;
            const stopChunk = {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: seenToolIds.size > 0 ? 'tool_calls' : 'stop',
              }],
              ...(usage ? { usage } : {}),
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
          }
        }
      },
      flush(controller) {
        if (!finishSent) {
          const stopChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
            ...(usage ? { usage } : {}),
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
    });

    return new Response(response.body.pipeThrough(transformStream), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let offset = 0;
  let content = '';
  let usage = null;
  let finishReason = 'stop';
  const toolCallsMap = new Map(); // toolId → { id, name, args }
  let totalContentLength = 0;
  let contextUsagePercentage = 0;

  while (offset + 16 <= bytes.length) {
    const frameLength = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset).getUint32(0, false);
    if (frameLength < 16 || offset + frameLength > bytes.length) break;

    const frame = parseKiroEventFrame(bytes.slice(offset, offset + frameLength));
    offset += frameLength;
    if (!frame) continue;

    const eventType = frame.headers[':event-type'] || '';
    const payload = frame.payload;
    const error = getKiroFrameError(frame);
    if (error) return createKiroErrorResponse(error);

    if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && typeof payload?.content === 'string') {
      totalContentLength += payload.content.length;
      content += payload.content;
      continue;
    }

    if (eventType === 'toolUseEvent' && payload) {
      const toolEvents = Array.isArray(payload) ? payload : [payload];
      for (const toolEvent of toolEvents) {
        const toolId = toolEvent?.toolUseId || randomUUID();
        if (!toolCallsMap.has(toolId)) {
          toolCallsMap.set(toolId, { id: toolId, name: toolEvent?.name || 'tool', args: '' });
        }
        const entry = toolCallsMap.get(toolId);
        if (toolEvent?.name) entry.name = toolEvent.name;
        const fragment = getKiroToolCallArgumentString(toolEvent?.input);
        if (fragment) entry.args += fragment;
      }
      continue;
    }

    if (eventType === 'metricsEvent') {
      const metrics = payload?.metricsEvent && typeof payload.metricsEvent === 'object'
        ? payload.metricsEvent
        : payload;
      if (metrics && typeof metrics === 'object') {
        const promptTokens = Number(metrics.inputTokens || 0);
        const completionTokens = Number(metrics.outputTokens || 0);
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
      }
      continue;
    }

    if (eventType === 'contextUsageEvent' && !usage) {
      const pct = typeof payload?.contextUsagePercentage === 'number'
        ? payload.contextUsagePercentage
        : 0;
      if (pct > 0) contextUsagePercentage = pct;
      continue;
    }

    if (eventType === 'messageStopEvent') {
      if (toolCallsMap.size > 0) finishReason = 'tool_calls';
    }
  }

  const toolCalls = [...toolCallsMap.values()].map(entry => ({
    id: entry.id,
    type: 'function',
    function: { name: entry.name, arguments: entry.args },
  }));

  // Fallback: estimate usage from contextUsageEvent if metricsEvent was absent
  if (!usage && (totalContentLength > 0 || contextUsagePercentage > 0)) {
    const estOutput = totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0;
    const estInput = contextUsagePercentage > 0 ? Math.floor((contextUsagePercentage * KIRO_MAX_CONTEXT_TOKENS) / 100) : 0;
    if (estInput > 0 || estOutput > 0) {
      usage = { prompt_tokens: estInput, completion_tokens: estOutput, total_tokens: estInput + estOutput };
    }
  }

  const openAiPayload = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
    }],
    ...(usage ? { usage } : {}),
  };

  return new Response(JSON.stringify(openAiPayload), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// Devin/Cascade returns Connect-framed (optionally gzip) protobuf deltas instead of
// OpenAI SSE. Decode the frames and re-emit an OpenAI-format stream (or aggregated
// JSON for non-streaming) so clients never see the raw binary that used to show up
// as mojibake. Trailer errors (JSON end-of-stream frames) surface as readable errors.
export async function transformDevinResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;

  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const usageToOpenAI = (usage) => usage ? {
    prompt_tokens: (usage.inputTokens || 0) + (usage.cacheReadTokens || 0),
    completion_tokens: usage.outputTokens || 0,
    total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0),
  } : null;

  if (stream) {
    let pending = Buffer.alloc(0);
    let chunkIndex = 0;
    let finishSent = false;
    let usage = null;
    let stopReason = 0;
    const toolEntries = new Map(); // id -> { id, index, name, accumulated }

    const send = (controller, object) => {
      if (finishSent) return;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(object)}\n\n`));
    };
    const sendError = (controller, message) => {
      if (finishSent) return;
      finishSent = true;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch { /* client gone */ }
    };

    const handleFrame = (controller, frame) => {
      if (finishSent) return;
      let raw = frame.payload;
      if (frame.flags & CONNECT_COMPRESSED_FLAG) {
        try { raw = gunzipSync(frame.payload); } catch { return; }
      }
      if (frame.flags & CONNECT_END_STREAM_FLAG) {
        const trailerError = parseConnectTrailerError(raw.toString('utf8').trim());
        if (trailerError) sendError(controller, trailerError.formatted);
        return;
      }
      let msg;
      try { msg = decodeDevinChatResponsePayload(raw); } catch { return; }
      // Reasoning (deltaThinking) is not part of the OpenAI text stream.
      for (const toolCall of msg.deltaToolCalls || []) {
        let entry = toolCall.id ? toolEntries.get(toolCall.id) : null;
        if (!entry) {
          const id = toolCall.id || randomUUID();
          entry = { id, name: toolCall.name || 'tool', accumulated: '', index: toolEntries.size };
          toolEntries.set(id, entry);
          send(controller, {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(chunkIndex === 0 ? { role: 'assistant' } : {}),
                tool_calls: [{
                  index: entry.index,
                  id,
                  type: 'function',
                  function: { name: entry.name, arguments: '' },
                }],
              },
              finish_reason: null,
            }],
          });
          chunkIndex += 1;
        }
        if (toolCall.name) entry.name = toolCall.name;
        if (toolCall.argumentsJson) {
          // Backend streams argumentsJson as cumulative text in some shapes and as
          // deltas in others; emit only the newly arrived slice either way.
          const accumulated = toolCall.argumentsJson.startsWith(entry.accumulated)
            ? toolCall.argumentsJson
            : entry.accumulated + toolCall.argumentsJson;
          const delta = accumulated.slice(entry.accumulated.length);
          entry.accumulated = accumulated;
          if (delta) {
            send(controller, {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: entry.index, function: { arguments: delta } }] },
                finish_reason: null,
              }],
            });
            chunkIndex += 1;
          }
        }
      }
      if (msg.deltaText) {
        send(controller, {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: chunkIndex === 0 ? { role: 'assistant', content: msg.deltaText } : { content: msg.deltaText },
            finish_reason: null,
          }],
        });
        chunkIndex += 1;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      const openAiUsage = usageToOpenAI(msg.usage);
      if (openAiUsage) usage = openAiUsage;
    };

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const bytes = Buffer.from(chunk);
        pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
        for (;;) {
          if (pending.length < 5) break;
          const length = pending.readUInt32BE(1);
          if (length > DEVIN_MAX_CONNECT_FRAME_PAYLOAD) {
            sendError(controller, `Devin Connect frame length ${length} exceeds the ${DEVIN_MAX_CONNECT_FRAME_PAYLOAD}-byte cap.`);
            break;
          }
          if (pending.length < 5 + length) break;
          const frame = { flags: pending[0], payload: pending.subarray(5, 5 + length) };
          pending = pending.subarray(5 + length);
          handleFrame(controller, frame);
          if (finishSent) break;
        }
      },
      flush(controller) {
        if (!finishSent) {
          const finishReason = toolEntries.size > 0 ? 'tool_calls' : (stopReason === 3 ? 'length' : 'stop');
          send(controller, {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      },
    });

    return new Response(response.body.pipeThrough(transformStream), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-streaming: buffer the whole body, decode every frame, emit one completion.
  const bytes = Buffer.from(await response.arrayBuffer());
  const { frames } = parseConnectFrames(bytes);
  let content = '';
  let usage = null;
  let stopReason = 0;
  let trailerError = null;
  const toolCallsMap = new Map(); // id -> { id, name, arguments }
  for (const frame of frames) {
    let raw = frame.payload;
    if (frame.flags & CONNECT_COMPRESSED_FLAG) {
      try { raw = gunzipSync(frame.payload); } catch { continue; }
    }
    if (frame.flags & CONNECT_END_STREAM_FLAG) {
      const error = parseConnectTrailerError(raw.toString('utf8').trim());
      if (error && !trailerError) trailerError = error;
      continue;
    }
    let msg;
    try { msg = decodeDevinChatResponsePayload(raw); } catch { continue; }
    content += msg.deltaText;
    if (msg.stopReason) stopReason = msg.stopReason;
    const openAiUsage = usageToOpenAI(msg.usage);
    if (openAiUsage) usage = openAiUsage;
    for (const toolCall of msg.deltaToolCalls || []) {
      const id = toolCall.id || randomUUID();
      let entry = toolCallsMap.get(id);
      if (!entry) {
        entry = { id, name: toolCall.name || 'tool', arguments: '' };
        toolCallsMap.set(id, entry);
      }
      if (toolCall.name) entry.name = toolCall.name;
      if (toolCall.argumentsJson) {
        entry.arguments = toolCall.argumentsJson.startsWith(entry.arguments)
          ? toolCall.argumentsJson
          : entry.arguments + toolCall.argumentsJson;
      }
    }
  }
  if (trailerError && !content && toolCallsMap.size === 0) {
    return new Response(JSON.stringify({
      error: { message: trailerError.formatted, code: trailerError.code, type: 'devin_error' },
    }), {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const toolCalls = [...toolCallsMap.values()].map(entry => ({
    id: entry.id,
    type: 'function',
    function: { name: entry.name, arguments: entry.arguments },
  }));
  const openAiPayload = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : (stopReason === 3 ? 'length' : 'stop'),
    }],
    ...(usage ? { usage } : {}),
  };
  return new Response(JSON.stringify(openAiPayload), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Devin browser OAuth — mirrors the @oh-my-pi/pi-coding-agent (omp) "devin"
// provider login and the official Devin CLI: PKCE S256 with a loopback callback
// at http://127.0.0.1:59653/callback, then a POST to https://api.devin.ai/
// auth/cli/token with { code, code_verifier } returning { token } (a JWT that
// hammer stores as the devin-session-token$<jwt> credential).
// ---------------------------------------------------------------------------

function buildDevinOAuthRedirectUri(port) {
  return `http://${DEVIN_OAUTH_CALLBACK_HOST}:${port}${DEVIN_OAUTH_CALLBACK_PATH}`;
}

function generateDevinPkce() {
  const codeVerifier = toBase64Url(randomBytes(32));
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

// Same query shape omp sends (standard OAuth params + prompt=select_account,
// no client_id — Devin treats the PKCE challenge as the client credential).
export function buildDevinOAuthLoginUrl({ codeChallenge, state, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (state) params.set('state', state);
  return `${DEVIN_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeDevinOAuthCode(code, codeVerifier, options = {}) {
  const normalizedCode = typeof code === 'string' ? code.trim() : '';
  const normalizedVerifier = typeof codeVerifier === 'string' ? codeVerifier.trim() : '';
  if (!normalizedCode || !normalizedVerifier) {
    throw new Error('Devin OAuth token exchange requires both code and code_verifier.');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(DEVIN_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ code: normalizedCode, code_verifier: normalizedVerifier }),
    signal: options.signal,
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = normalizeSecretValue(payload?.error_description || payload?.error || payload?.message || raw);
    throw new Error(detail || `Devin OAuth token exchange failed (HTTP ${response.status}).`);
  }
  const token = normalizeSecretValue(payload?.token || payload?.access_token);
  if (!token) throw new Error('Devin OAuth token exchange returned no session token.');
  return { token };
}

function closeDevinCallbackServer(flow) {
  if (flow?.expiryTimer) {
    clearTimeout(flow.expiryTimer);
    flow.expiryTimer = null;
  }
  if (flow?.cleanupTimer) {
    clearTimeout(flow.cleanupTimer);
    flow.cleanupTimer = null;
  }
  if (flow?.server) {
    try { flow.server.close(); } catch { /* already closed */ }
    flow.server = null;
  }
}

function scheduleDevinOAuthCleanup(flow, delayMs = 45_000) {
  if (!flow || _devinOAuthFlows.get(flow.flowId) !== flow) return;
  const cleanupTimer = setTimeout(() => {
    if (_devinOAuthFlows.get(flow.flowId) === flow) {
      closeDevinCallbackServer(flow);
      _devinOAuthFlows.delete(flow.flowId);
    }
  }, delayMs);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  flow.cleanupTimer = cleanupTimer;
}

function handleDevinCallbackRequest(req, res, flow, onToken) {
  const parsed = new URL(req.url, `http://${DEVIN_OAUTH_CALLBACK_HOST}`);
  const code = normalizeSecretValue(parsed.searchParams.get('code'));
  const state = normalizeSecretValue(parsed.searchParams.get('state'));
  const respond = (status, contentType, body) => {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  };

  if (!code) {
    return respond(400, 'text/plain; charset=utf-8', 'Missing authorization code. Close this window and try again.');
  }
  if (state && state !== flow.state) {
    flow.status = 'error';
    flow.error = 'Devin OAuth callback state did not match the login request.';
    return respond(400, 'text/plain; charset=utf-8', 'State mismatch. Close this window and start the Devin sign-in again.');
  }

  (async () => {
    try {
      const { token } = await exchangeDevinOAuthCode(code, flow.codeVerifier);
      if (typeof onToken === 'function') await onToken(token);
      flow.status = 'success';
      respond(200, 'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><title>Devin connected</title>'
        + '<body style="font-family:system-ui;padding:2rem;text-align:center">'
        + '<h2>✅ Devin connected</h2><p>You can close this window and return to the Hammer dashboard.</p></body>');
      // Keep the flow observable until the dashboard reads the success via
      // /api/oauth/devin/status (a successful read deletes it); a short cleanup
      // timer removes it if the dashboard never polls.
      closeDevinCallbackServer(flow);
      scheduleDevinOAuthCleanup(flow);
    } catch (err) {
      flow.status = 'error';
      flow.error = err?.message || 'Devin OAuth token exchange failed.';
      respond(502, 'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><title>Devin sign-in failed</title>'
        + '<body style="font-family:system-ui;padding:2rem;text-align:center">'
        + `<h2>Devin sign-in failed</h2><p style="color:#b91c1c">${String(flow.error).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`
        + '<p>Close this window and try again from the Hammer dashboard.</p></body>');
      // Keep the error readable by the dashboard poll, then clean up.
      closeDevinCallbackServer(flow);
      scheduleDevinOAuthCleanup(flow);
    }
  })();
}

async function bindDevinCallbackListener(flow, onToken) {
  for (let attempt = 0; attempt < DEVIN_OAUTH_CALLBACK_PORT_TRIES; attempt++) {
    const port = DEVIN_OAUTH_CALLBACK_PORT + attempt;
    // Probe whether the port is free (listen errors are async, so test first).
    const free = await new Promise(resolve => {
      const probe = createHttpServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, DEVIN_OAUTH_CALLBACK_HOST);
    });
    if (!free) continue;

    const server = createHttpServer((req, res) => {
      handleDevinCallbackRequest(req, res, flow, onToken);
    });
    server.unref();
    flow.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, DEVIN_OAUTH_CALLBACK_HOST, resolve);
      });
      flow.redirectUri = buildDevinOAuthRedirectUri(port);
      return { redirectUri: flow.redirectUri, autoCallback: true };
    } catch {
      flow.server = null;
      try { server.close(); } catch { /* not listening */ }
    }
  }
  // No loopback port available — the flow still works via copy/paste of the
  // callback URL (same manual fallback omp offers with pasteCode).
  return { redirectUri: buildDevinOAuthRedirectUri(DEVIN_OAUTH_CALLBACK_PORT), autoCallback: false };
}

function pruneDevinOAuthFlows(now = Date.now()) {
  for (const [flowId, flow] of Array.from(_devinOAuthFlows)) {
    if (!flow || flow.expiresAt <= now) {
      closeDevinCallbackServer(flow);
      _devinOAuthFlows.delete(flowId);
    }
  }
}

export async function startDevinOAuthFlow(options = {}) {
  pruneDevinOAuthFlows();
  // Keep a single active Devin flow at a time (the dashboard UI is single-slot).
  for (const [flowId, flow] of Array.from(_devinOAuthFlows)) {
    if (flow?.status === 'pending') {
      closeDevinCallbackServer(flow);
      _devinOAuthFlows.delete(flowId);
    }
  }

  const { codeVerifier, codeChallenge } = generateDevinPkce();
  const state = randomUUID();
  const flowId = randomUUID();
  const expiresAt = Date.now() + DEVIN_OAUTH_FLOW_TTL_MS;
  const flow = {
    flowId,
    codeVerifier,
    state,
    expiresAt,
    status: 'pending',
    redirectUri: null,
    server: null,
    expiryTimer: null,
    cleanupTimer: null,
  };
  _devinOAuthFlows.set(flowId, flow);
  const expiryTimer = setTimeout(() => {
    if (_devinOAuthFlows.get(flowId) === flow) {
      closeDevinCallbackServer(flow);
      _devinOAuthFlows.delete(flowId);
    }
  }, DEVIN_OAUTH_FLOW_TTL_MS);
  if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
  flow.expiryTimer = expiryTimer;

  const { redirectUri, autoCallback } = await bindDevinCallbackListener(flow, options.onToken);
  flow.redirectUri = redirectUri;
  const authUrl = buildDevinOAuthLoginUrl({ codeChallenge, state, redirectUri });
  return {
    flowId,
    authUrl,
    redirectUri,
    state,
    autoCallback,
    expiresIn: Math.floor(DEVIN_OAUTH_FLOW_TTL_MS / 1000),
  };
}

export function getDevinOAuthFlowStatus(flowId) {
  const flow = _devinOAuthFlows.get(flowId);
  if (!flow) return { status: 'missing' };
  if (flow.expiresAt <= Date.now()) {
    closeDevinCallbackServer(flow);
    _devinOAuthFlows.delete(flowId);
    return { status: 'expired' };
  }
  if (flow.status === 'success') {
    closeDevinCallbackServer(flow);
    _devinOAuthFlows.delete(flowId);
    return { status: 'success' };
  }
  if (flow.status === 'error') {
    const error = flow.error || 'Devin sign-in failed.';
    closeDevinCallbackServer(flow);
    _devinOAuthFlows.delete(flowId);
    return { status: 'error', error };
  }
  return { status: 'pending', expiresIn: Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1000)) };
}

export async function exchangeDevinOAuthFlow(flowId, code, state = null, options = {}) {
  const flow = _devinOAuthFlows.get(flowId);
  if (!flow) throw new Error('Unknown or expired Devin OAuth flow. Start a new sign-in.');
  if (flow.expiresAt <= Date.now()) {
    closeDevinCallbackServer(flow);
    _devinOAuthFlows.delete(flowId);
    throw new Error('Devin OAuth flow expired. Start a new sign-in.');
  }
  const normalizedState = normalizeSecretValue(state);
  if (normalizedState && normalizedState !== flow.state) {
    throw new Error('Devin OAuth callback state did not match the login request.');
  }
  const { token } = await exchangeDevinOAuthCode(code, flow.codeVerifier, options);
  if (typeof options.onToken === 'function') await options.onToken(token);
  closeDevinCallbackServer(flow);
  _devinOAuthFlows.delete(flowId);
  return { token };
}

export function cancelDevinOAuthFlow(flowId) {
  const flow = _devinOAuthFlows.get(flowId);
  if (!flow) return false;
  closeDevinCallbackServer(flow);
  _devinOAuthFlows.delete(flowId);
  return true;
}

// The cheapest possible liveness question. A single token is enough for a plain chat
// model, but not for a reasoning one: gpt-oss (Groq, NIM) spends that one token before
// emitting any visible text, so the probe sees an empty completion on a healthy model.
const PROBE_MAX_TOKENS = 1
// Second attempt, used only when the first answered 200 with nothing usable. Enough
// headroom for a reasoning model to reach the text channel.
const PROBE_RETRY_MAX_TOKENS = 256

// The question a Test asks. It names a length and a tone; the rest is open, so the answer
// frames a generation rate without inviting a model to waffle.
const TEST_PROMPT = 'Please respond with a creative, funny, inspiring 30 words about hammers.'

// The vocabulary a test's marker is drawn from — two ordinary pairs, 32 x 32 x 32 x 32 ways.
// The words carry no meaning; their only job is to make the request one the provider has not
// answered before.
const TEST_MARKER_ADJECTIVES = [
  'amber', 'brisk', 'clever', 'copper', 'cosy', 'crimson', 'dusty', 'eager', 'frosted', 'gentle',
  'golden', 'hidden', 'humble', 'idle', 'jolly', 'lively', 'lofty', 'mellow', 'nimble', 'placid',
  'quiet', 'rustic', 'silver', 'steady', 'sturdy', 'sunny', 'tidy', 'velvet', 'woven', 'wistful',
  'witty', 'zealous',
]
const TEST_MARKER_NOUNS = [
  'anchor', 'anvil', 'basket', 'bench', 'candle', 'chisel', 'compass', 'dial', 'engine', 'fountain',
  'garden', 'harbour', 'kettle', 'ladder', 'lantern', 'meadow', 'mirror', 'orchard', 'parcel', 'quilt',
  'ribbon', 'saddle', 'sawdust', 'scaffold', 'spoon', 'telescope', 'umbrella', 'vineyard', 'wagon',
  'whistle', 'windmill', 'workshop',
]

/**
 * 📖 The prompt a Test click sends: one fixed question, plus a marker no earlier test asked.
 *
 * A test has to ask something the provider has not answered before, or a provider that caches
 * completions answers it from cache forever — Pollinations returns `x-cache: HIT` with a
 * year-long immutable `cache-control` and serves a hit *without debiting the account*, so a Test
 * kept passing on a key whose every real request was refused for lack of credit, recording the
 * original generation's ttft/tok-s as this row's own measurement.
 *
 * The marker used to be `(test id: <8 hex>)`, and g4f's route to Pollinations refused it:
 * HTTP 400 `Something was wrong with the input data` — for the parenthesised marker **whatever
 * the rest of the sentence was** (`Say hello. (test id: ab12cd34)` was refused at 30
 * characters), while the same 92-character question with the marker removed answered, and
 * `(test id: ab12cd34)` with its parentheses dropped answered too. So the two-word pairs above
 * are deliberate: the marker is prose, in the same sentence voice as the question, with no
 * parentheses, no colon, no hash and none of the words — `test`, `id`, `session`, `key`, `token`
 * — that an input filter reads as metadata. Nothing is appended after the question but a second
 * plain sentence starting `Mention`.
 *
 * Two pairs rather than one because the marker has to be *unlikely*, not merely different: a
 * single pair would collide within a hundred-model retest almost every time, and each collision
 * is a cached answer recorded as that row's measurement. Two parameters get the space to ~1M.
 *
 * Only the text can do this job. Verified live against the same route: `seed`, `temperature` and
 * `user` are all normalised out of g4f's cache key — five bodies differing only in those fields
 * came back with an identical `x-cache-key` and a stale `x-cache-date` — while two different
 * marker words produced two different keys and two fresh generations.
 *
 * @param {function} [random] injectable for tests; `Math.random` by default
 * @returns {string}
 */
export function buildModelTestPrompt(random = Math.random) {
  const pick = list => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const pair = () => [pick(TEST_MARKER_ADJECTIVES), pick(TEST_MARKER_NOUNS)]
  const phrase = ([adjective, noun]) => `${articleOf(adjective)} ${adjective} ${noun}`
  const first = pair()
  let second = pair()
  // Never the same pair twice — a marker reading "a copper kettle and a copper kettle" asks for
  // one thing. An invariant rather than a retry, so it holds for any draw, a constant `random`
  // included.
  if (second[0] === first[0] && second[1] === first[1]) {
    const shifted = (TEST_MARKER_ADJECTIVES.indexOf(first[0]) + 1) % TEST_MARKER_ADJECTIVES.length
    second = [TEST_MARKER_ADJECTIVES[shifted], second[1]]
  }
  return `${TEST_PROMPT} Mention ${phrase(first)} and ${phrase(second)}.`
}

/** 📖 'a' or 'an', so a marker drawn from an open vocabulary still reads as English. */
function articleOf(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

/**
 * Classifies a probe response body: 'ok' when it carries a real completion, 'empty'
 * when the transport said success but there is nothing usable to read, and
 * 'upstream-error' when the body is a provider error envelope (a relay folding a
 * backend fault into a 200).
 */
function classifyProbeResponseBody(text) {
  if (findUpstreamSseError(text)) return 'upstream-error'
  // A gateway can refuse a probe for an account reason inside a body that otherwise reads as a
  // completion (see isAccountBudgetRefusalText). Structural checks call that body an answer, so
  // it has to be named here — otherwise the refusal itself is what marks the row 'up'. Matched
  // against the *answer* the body carries rather than the raw body: a refusal can be streamed,
  // split across frames and JSON-escaped, and the raw transcript then holds neither half of it.
  if (isAccountBudgetRefusalText(summarizeTestAnswer(text).text)) return 'budget-refusal'
  return hasUsableChatCompletionBody(text) ? 'ok' : 'empty'
}

async function ping(apiKey, modelId, url, providerKey = null, options = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT)
  const t0 = performance.now()
  try {
    // The probe must carry exactly what a proxied request would: same credential
    // decision (isExplicitFreemodelsKey), so a provider that rejects keyless probes
    // isn't marked down while chat against the same row works.
    const headers = buildProviderRequestHeaders(providerKey, {
      apiKey,
      isExplicitFreemodelsKey: options.isExplicitFreemodelsKey === true,
      codexAccountId: options.codexAccountId || null,
      codexResidency: options.codexResidency || null,
    })
    // One probe attempt with a chosen response budget, so the first (cheap) try and the
    // headroom retry below are built, credentialed, and translated identically.
    const probeOnce = async (maxTokens) => {
      const payload = buildProviderRequestBody(providerKey, {
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: maxTokens,
      }, modelId)
      let res = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers,
        body: serializeProviderRequestBody(payload),
      })
      // Business orgs gate Copilot by client surface, so a chat-identity probe can be
      // denied where the CLI identity is allowed. Retry once as the CLI, otherwise a
      // policy decision would read as a broken model and bench a healthy row.
      if (providerKey === GITHUB_COPILOT_PROVIDER_KEY && (res.status === 403 || res.status === 400)) {
        const denialBody = await res.clone().text().catch(() => '')
        if (isCopilotIdentityDenied(res.status, denialBody)) {
          res = await fetch(url, {
            method: 'POST', signal: ctrl.signal,
            headers: { ...headers, 'Copilot-Integration-Id': COPILOT_CLI_INTEGRATION_ID },
            body: serializeProviderRequestBody(payload),
          })
        }
      }
      // Codex only ever streams the Responses wire, so translate before the probe
      // reads the body: otherwise a healthy model would look like an empty success.
      if (providerKey === OPENAI_CODEX_PROVIDER_KEY && res.ok) {
        res = await transformCodexResponse(res, modelId, false)
      }
      // gptfree speaks its own named-event SSE, whose answer frames no OpenAI-shaped
      // reader can see — untranslated, every working probe would read as "no usable
      // text" and bench a healthy row.
      if (providerKey === GPTFREE_PROVIDER_KEY && res.ok) {
        res = await transformGptFreeResponse(res, modelId, false)
      }
      return res
    }
    let resp = await probeOnce(PROBE_MAX_TOKENS)
    let msAtHeaders = Math.round(performance.now() - t0);
    let errorMessage = null;
    let raw = null;
    let noUsableText = false;
    let upstreamModel = null;
    // Set when the response's body carried an upstream error envelope rather than a
    // completion. Some relays (FreeModels) report a backend overload as an error
    // frame inside an HTTP 200 stream. That is a transient provider fault, not a
    // property of the model, so it is reported as a failed probe — the caller's
    // hysteresis then keeps a recently-good model up — and never as 'incompatible',
    // which would permanently condemn a model that is fine between overloads.
    let transientUpstreamError = null;
    // Set when the body was the gateway's own account refusal — an exhausted key budget, an
    // empty credit balance — rather than a completion (see isAccountBudgetRefusalText). The
    // transport said 200, so the refusal is what the probe would otherwise score as an answer.
    let budgetRefusedNotice = null;
    if (!resp.ok) {
      try {
        raw = await resp.text();
        errorMessage = parseErrorBodyText(raw);
      } catch {
        errorMessage = null;
      }
    } else {
      // A 200 only proves the model is alive if it actually carries a completion.
      // Providers that answer success with an empty body / empty choices would
      // otherwise be recorded as a healthy, fast probe that never serves a request.
      try {
        raw = await resp.text();
        let bodyState = classifyProbeResponseBody(raw);
        if (bodyState === 'empty') {
          // One retry with real headroom before any verdict. The empty answer is
          // evidence about the probe's 1-token budget, not about the model: a row that
          // served real traffic (and passed this very probe) later came back empty for
          // weeks and was struck out as Incompatible over it.
          const retryResp = await probeOnce(PROBE_RETRY_MAX_TOKENS)
          raw = await retryResp.text().catch(() => '')
          resp = retryResp
          // The scored latency belongs to the attempt whose body we judge.
          msAtHeaders = Math.round(performance.now() - t0)
          bodyState = resp.ok ? classifyProbeResponseBody(raw) : 'http-error'
        }
        if (bodyState === 'upstream-error') {
          transientUpstreamError = findUpstreamSseError(raw);
          errorMessage = typeof transientUpstreamError?.message === 'string' && transientUpstreamError.message
            ? transientUpstreamError.message
            : 'Upstream reported an error.';
        } else if (bodyState === 'budget-refusal') {
          // The provider is refusing this credential, not answering: the notice's own words are
          // the error, read out of the body in whichever shape it came (summarizeTestAnswer
          // handles both a JSON completion and a transcript). A probe must never be what promotes
          // a refused key to 'up'.
          const notice = summarizeTestAnswer(raw).text.trim()
          budgetRefusedNotice = notice || 'Provider refused the request: this account is out of budget.'
          errorMessage = budgetRefusedNotice
        } else if (bodyState === 'empty') {
          noUsableText = true;
          errorMessage = 'Model returned no usable text.';
        } else if (bodyState === 'http-error') {
          // The headroom retry answered with a real status (429, 5xx, …). Read that
          // response's own error instead of reporting the empty 200 it replaced.
          errorMessage = parseErrorBodyText(raw)
        } else {
          // Capture the upstream model id the provider reports so the dashboard can
          // show the real backend behind a catalog entry.
          upstreamModel = extractUpstreamModelId(raw);
        }
      } catch {
        // Body unreadable after headers: keep treating the transport success as a
        // probe success rather than condemning a model over a logging hiccup.
      }
    }
    // Capture rate headers for display purposes.
    // Handles standard names (Groq, Cerebras), NIM reversed variants, and retry-after.
    const rateLimit = {};
    const rl = resp.headers;
    const LR = rl.get('x-ratelimit-limit-requests') || rl.get('x-ratelimit-requests-limit');
    if (LR) { const n = Number(LR); if (Number.isFinite(n) && n >= 0) rateLimit.limitRequests = n; }
    const RR = rl.get('x-ratelimit-remaining-requests') || rl.get('x-ratelimit-requests-remaining');
    if (RR) { const n = Number(RR); if (Number.isFinite(n) && n >= 0) rateLimit.remainingRequests = n; }
    const LT = rl.get('x-ratelimit-limit-tokens') || rl.get('x-ratelimit-tokens-limit');
    if (LT) { const n = Number(LT); if (Number.isFinite(n) && n >= 0) rateLimit.limitTokens = n; }
    const RT = rl.get('x-ratelimit-remaining-tokens') || rl.get('x-ratelimit-tokens-remaining');
    if (RT) { const n = Number(RT); if (Number.isFinite(n) && n >= 0) rateLimit.remainingTokens = n; }

    const resetReq = rl.get('x-ratelimit-reset-requests') || rl.get('x-ratelimit-requests-reset');
    const resetTok = rl.get('x-ratelimit-reset-tokens') || rl.get('x-ratelimit-tokens-reset');
    if (resetReq) { const ms = parseDurationMs(resetReq); if (ms != null) rateLimit.resetRequestsAt = Date.now() + ms; }
    if (resetTok) { const ms = parseDurationMs(resetTok); if (ms != null) rateLimit.resetTokensAt = Date.now() + ms; }

    const retryAfter = rl.get('retry-after');
    if (retryAfter) {
      const raMs = parseDurationMs(retryAfter);
      if (raMs != null) {
        if (!rateLimit.resetRequestsAt) rateLimit.resetRequestsAt = Date.now() + raMs;
        rateLimit.retryAfterMs = raMs;
      }
    }

    // Quota-style rejections (Google/Gemini RESOURCE_EXHAUSTED, etc.) carry
    // their reset as details[].RetryInfo.retryDelay rather than headers — parse
    // the body so the countdown/backoff matches the provider's stated delay.
    // Also treat quota-exhaustion bodies on non-429 statuses as rate-limited:
    // some relays pass the provider's quota body through with a different HTTP
    // status, and the body's rpc code/status is the ground truth.
    const quotaLimited = raw != null && !resp.ok && isQuotaExhaustionError(raw, resp.status);
    if (quotaLimited) {
      const bodyReset = extractRateLimitResetMs(raw, (name) => rl.get(name));
      if (bodyReset != null) rateLimit.resetRequestsAt = bodyReset;
      const quota = extractQuotaFailure(raw);
      if (quota.quotaId || quota.quotaValue || quota.code) rateLimit.quota = quota;
    }
    if (quotaLimited) {
      rateLimit.wasRateLimited = true;
      rateLimit.capturedAt = Date.now();
    }

    return {
      // An error frame inside a 200 is reported as the 503 it means, so the probe
      // outcome matches what the proxy would have done with the same response. The same rule
      // covers a 200 body that is really an account refusal: reported as the 429 it means, which
      // also keeps it out of the uptime average (getUptime counts 200s) and puts the row on the
      // clock instead of 'up'.
      //
      // A rate limit that arrived as an error frame is still a rate limit, so it takes the 429 it
      // means rather than the generic 503: g4f's pool answers "rate limiting: inference request
      // per min rate reached" inside a 200, and reading that as an outage would put the row on the
      // wrong clock while the manual test was putting it on the right one.
      code: transientUpstreamError
        ? (isRateLimitedErrorText(errorMessage) ? '429' : '503')
        : (budgetRefusedNotice ? '429' : String(resp.status)),
      ms: msAtHeaders,
      rateLimit: Object.keys(rateLimit).length > 0 ? rateLimit : null,
      errorMessage,
      noUsableText,
      upstreamModel,
    }
  } catch (err) {
    const isTimeout = err.name === 'AbortError'
    const message = getNetworkErrorMessage(err)
    return {
      code: isTimeout ? '000' : 'ERR',
      ms: isTimeout ? 'TIMEOUT' : Math.round(performance.now() - t0),
      errorMessage: isTimeout ? 'Request timed out while pinging provider.' : message,
    }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeSecretValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateKiroPkce() {
  const codeVerifier = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return {
    codeVerifier,
    codeChallenge,
    state: randomUUID(),
  };
}

export function buildKiroSocialLoginUrl(provider, codeChallenge, state) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!KIRO_BROWSER_AUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error('Unsupported Kiro browser auth provider.');
  }

  const idp = normalizedProvider === 'google' ? 'Google' : 'Github';
  const params = new URLSearchParams({
    idp,
    redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });

  return `${KIRO_AUTH_SERVICE_URL}/login?${params.toString()}`;
}

function pruneKiroSocialFlows(now = Date.now()) {
  for (const [flowId, flow] of Array.from(_kiroSocialFlows)) {
    if (!flow || flow.expiresAt <= now) _kiroSocialFlows.delete(flowId);
  }
}

export function startKiroSocialAuthFlow(provider) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!KIRO_BROWSER_AUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error('Unsupported Kiro browser auth provider.');
  }

  pruneKiroSocialFlows();
  const { codeVerifier, codeChallenge, state } = generateKiroPkce();
  const flowId = randomUUID();
  const expiresAt = Date.now() + KIRO_SOCIAL_FLOW_EXPIRY_MS;
  _kiroSocialFlows.set(flowId, {
    provider: normalizedProvider,
    codeVerifier,
    state,
    expiresAt,
  });

  return {
    flowId,
    provider: normalizedProvider,
    authUrl: buildKiroSocialLoginUrl(normalizedProvider, codeChallenge, state),
    state,
    expiresIn: Math.floor(KIRO_SOCIAL_FLOW_EXPIRY_MS / 1000),
  };
}

export function extractKiroEmailFromAccessToken(accessToken) {
  const raw = normalizeSecretValue(accessToken);
  if (!raw) return null;

  try {
    const parts = raw.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );

    return normalizeSecretValue(payload?.email || payload?.username || payload?.['cognito:username']) || null;
  } catch {
    return null;
  }
}

export async function exchangeKiroSocialCode(code, codeVerifier) {
  const response = await fetch(KIRO_SOCIAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
    }),
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const detail = normalizeSecretValue(payload?.error || payload?.message || raw);
    throw new Error(detail || `Kiro token exchange failed (${response.status}).`);
  }

  const accessToken = normalizeSecretValue(payload?.accessToken || payload?.access_token);
  const refreshToken = normalizeSecretValue(payload?.refreshToken || payload?.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error('Kiro token exchange did not return both access and refresh tokens.');
  }

  return {
    accessToken,
    refreshToken,
    profileArn: normalizeSecretValue(payload?.profileArn || payload?.profile_arn) || null,
    expiresIn: Number(payload?.expiresIn || payload?.expires_in) || 3600,
  };
}

export async function exchangeKiroSocialAuthFlow(flowId, code, state = null) {
  const normalizedFlowId = normalizeSecretValue(flowId);
  const normalizedCode = normalizeSecretValue(code);
  const normalizedState = normalizeSecretValue(state);
  if (!normalizedFlowId || !normalizedCode) {
    throw new Error('flowId and code are required.');
  }

  pruneKiroSocialFlows();
  const flow = _kiroSocialFlows.get(normalizedFlowId);
  if (!flow) {
    throw new Error('Unknown or expired Kiro browser OAuth flow. Start a new browser OAuth flow.');
  }
  if (flow.expiresAt <= Date.now()) {
    _kiroSocialFlows.delete(normalizedFlowId);
    throw new Error('Unknown or expired Kiro browser OAuth flow. Start a new browser OAuth flow.');
  }
  if (normalizedState && normalizedState !== flow.state) {
    throw new Error('Kiro browser OAuth state did not match the active flow.');
  }

  const tokens = await exchangeKiroSocialCode(normalizedCode, flow.codeVerifier);
  _kiroSocialFlows.delete(normalizedFlowId);
  return tokens;
}

export async function startKiroBuilderIdDeviceAuth() {
  const registerResponse = await fetch(KIRO_OIDC_REGISTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientName: 'kiro-oauth-client',
      clientType: 'public',
      scopes: KIRO_OIDC_SCOPES,
      grantTypes: KIRO_OIDC_GRANT_TYPES,
      issuerUrl: KIRO_OIDC_ISSUER_URL,
    }),
  });

  const registerRaw = await registerResponse.text();
  let registerPayload = {};
  try {
    registerPayload = registerRaw ? JSON.parse(registerRaw) : {};
  } catch {
    registerPayload = {};
  }
  if (!registerResponse.ok) {
    const detail = normalizeSecretValue(registerPayload?.error || registerPayload?.message || registerRaw);
    throw new Error(detail || `Kiro client registration failed (${registerResponse.status}).`);
  }

  const clientId = normalizeSecretValue(registerPayload?.clientId || registerPayload?.client_id);
  const clientSecret = normalizeSecretValue(registerPayload?.clientSecret || registerPayload?.client_secret);
  if (!clientId || !clientSecret) {
    throw new Error('Kiro client registration did not return a client ID and secret.');
  }

  const deviceResponse = await fetch(KIRO_OIDC_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: KIRO_BUILDER_ID_START_URL,
    }),
  });

  const deviceRaw = await deviceResponse.text();
  let devicePayload = {};
  try {
    devicePayload = deviceRaw ? JSON.parse(deviceRaw) : {};
  } catch {
    devicePayload = {};
  }
  if (!deviceResponse.ok) {
    const detail = normalizeSecretValue(devicePayload?.error || devicePayload?.message || deviceRaw);
    throw new Error(detail || `Kiro device authorization failed (${deviceResponse.status}).`);
  }

  return {
    clientId,
    clientSecret,
    deviceCode: normalizeSecretValue(devicePayload?.deviceCode || devicePayload?.device_code),
    userCode: normalizeSecretValue(devicePayload?.userCode || devicePayload?.user_code),
    verificationUri: normalizeSecretValue(devicePayload?.verificationUri || devicePayload?.verification_uri),
    verificationUriComplete: normalizeSecretValue(devicePayload?.verificationUriComplete || devicePayload?.verification_uri_complete),
    expiresIn: Number(devicePayload?.expiresIn || devicePayload?.expires_in) || 600,
    interval: Number(devicePayload?.interval) || 5,
  };
}

export async function pollKiroBuilderIdToken(deviceCode, clientId, clientSecret) {
  const response = await fetch(KIRO_OIDC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      deviceCode,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const accessToken = normalizeSecretValue(payload?.accessToken || payload?.access_token);
  if (accessToken) {
    const refreshToken = normalizeSecretValue(payload?.refreshToken || payload?.refresh_token);
    if (!refreshToken) {
      return {
        success: false,
        pending: false,
        error: 'missing_refresh_token',
        errorDescription: 'Kiro device authorization completed without returning a refresh token.',
      };
    }
    return {
      success: true,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: Number(payload?.expiresIn || payload?.expires_in) || 3600,
        clientId,
        clientSecret,
      },
    };
  }

  return {
    success: false,
    pending: payload?.error === 'authorization_pending' || payload?.error === 'slow_down',
    error: normalizeSecretValue(payload?.error) || `Kiro device polling failed (${response.status}).`,
    errorDescription: normalizeSecretValue(payload?.error_description || payload?.message || raw) || null,
  };
}

function extractKiroRefreshTokenFromAwsCache() {
  const cacheDir = join(homedir(), '.aws', 'sso', 'cache');
  if (!existsSync(cacheDir)) return null;

  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
        const refreshToken = normalizeSecretValue(payload?.refreshToken);
        if (refreshToken.startsWith(KIRO_REFRESH_TOKEN_PREFIX)) return refreshToken;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getKiroOAuthClientConfig(config) {
  const providerCfg = config?.providers?.[KIRO_PROVIDER_KEY] || {};
  const clientId = normalizeSecretValue(process.env.KIRO_OAUTH_CLIENT_ID || providerCfg.clientId);
  const clientSecret = normalizeSecretValue(process.env.KIRO_OAUTH_CLIENT_SECRET || providerCfg.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getKiroRefreshToken(config) {
  const envToken = normalizeSecretValue(process.env.KIRO_REFRESH_TOKEN);
  if (envToken) return envToken;

  const cfgToken = normalizeSecretValue(config?.providers?.[KIRO_PROVIDER_KEY]?.refreshToken);
  if (cfgToken) return cfgToken;

  const now = Date.now();
  if ((now - _kiroRefreshTokenDiscoveryCache.checkedAt) < KIRO_DISCOVERY_CACHE_MS) {
    return _kiroRefreshTokenDiscoveryCache.token;
  }

  const discovered = extractKiroRefreshTokenFromAwsCache();
  _kiroRefreshTokenDiscoveryCache = {
    token: discovered,
    checkedAt: now,
  };

  return discovered;
}

function ensureProviderConfig(config, providerKey) {
  if (!config.providers) config.providers = {};
  if (!config.providers[providerKey]) config.providers[providerKey] = {};
  return config.providers[providerKey];
}

export function clearKiroTokenCaches() {
  _kiroOAuthCache = null;
  _kiroRefreshTokenDiscoveryCache = { token: null, checkedAt: 0 };
}

function clearKiroAuthMetadata(providerConfig) {
  if (!providerConfig || typeof providerConfig !== 'object') return;
  delete providerConfig.authMode;
  delete providerConfig.authProvider;
  delete providerConfig.authEmail;
  delete providerConfig.profileArn;
  delete providerConfig.clientId;
  delete providerConfig.clientSecret;
}

export function hasKiroAuthConfigured(config) {
  const apiKey = getApiKey(config, KIRO_PROVIDER_KEY);
  if (apiKey) return true;
  return !!getKiroRefreshToken(config);
}

export async function resolveKiroOAuthAccessToken(config) {
  const refreshToken = getKiroRefreshToken(config);
  if (!refreshToken) return null;

  const client = getKiroOAuthClientConfig(config);

  // Cache hit: match on either the original source token or the latest rotated token
  if (
    _kiroOAuthCache
    && (_kiroOAuthCache.sourceRefreshToken === refreshToken || _kiroOAuthCache.latestRefreshToken === refreshToken)
    && _kiroOAuthCache.clientId === (client?.clientId || null)
    && _kiroOAuthCache.expiresAt > (Date.now() + KIRO_TOKEN_EXPIRY_SKEW_MS)
    && _kiroOAuthCache.accessToken
  ) {
    return _kiroOAuthCache.accessToken;
  }

  // If the cache's source token matches the incoming token, use the latest rotated token for the actual request
  const effectiveRefreshToken = (
    _kiroOAuthCache?.sourceRefreshToken === refreshToken && _kiroOAuthCache?.latestRefreshToken
  ) ? _kiroOAuthCache.latestRefreshToken : refreshToken;

  const requestBody = client
    ? {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: effectiveRefreshToken,
      grantType: 'refresh_token',
    }
    : { refreshToken: effectiveRefreshToken };
  const tokenUrl = client ? KIRO_OIDC_TOKEN_URL : KIRO_SOCIAL_REFRESH_URL;

  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    if (!resp.ok) {
      let details = '';
      try {
        details = await resp.text();
      } catch {
        details = '';
      }
      emitKiroOAuthWarning(resp.status, details)
      return null;
    }
    const payload = await resp.json();
    const accessToken = normalizeSecretValue(payload?.accessToken);
    if (!accessToken) return null;

    const expiresIn = Number(payload?.expiresIn);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + (expiresIn * 1000)
      : Date.now() + KIRO_DEFAULT_TOKEN_EXPIRY_MS;
    const nextRefreshToken = normalizeSecretValue(payload?.refreshToken) || effectiveRefreshToken;

    _kiroOAuthCache = {
      sourceRefreshToken: refreshToken,
      latestRefreshToken: nextRefreshToken,
      accessToken,
      expiresAt,
      clientId: client?.clientId || null,
    };

    // Persist rotated refresh token back to config when it changes (skip if token came from env)
    const envRefreshToken = normalizeSecretValue(process.env.KIRO_REFRESH_TOKEN);
    if (nextRefreshToken !== refreshToken && refreshToken !== envRefreshToken && config?.providers?.[KIRO_PROVIDER_KEY]) {
      config.providers[KIRO_PROVIDER_KEY].refreshToken = nextRefreshToken;
      try {
        saveConfig(config);
      } catch {
        // non-fatal: rotation is tracked in cache even if persist fails
      }
    }

    return accessToken;
  } catch {
    return null;
  }
}

async function fetchOpenRouterRateLimit(apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!resp.ok) return null;

    const payload = await resp.json();
    return parseOpenRouterKeyRateLimit(payload);
  } catch {
    return null;
  }
}

async function fetchProviderUsageReport(config, providerKey) {
    const providerConfig = config?.providers?.[providerKey] || {};
    const usageUrl = providerConfig.usageUrl || (providerKey === OPENROUTER_PROVIDER_KEY ? 'https://openrouter.ai/api/v1/key' : null);
    const fetchedAt = Date.now();
    // Copilot's quota lives on the GitHub REST API rather than a per-provider
    // usage URL, so it owns a dedicated fetcher.
    if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) return await fetchCopilotUsageReport(config, fetchedAt);
    // Codex reports its remaining allowance as percent-used windows on the account
    // usage endpoint, which is likewise not a per-provider usage URL.
    if (providerKey === OPENAI_CODEX_PROVIDER_KEY) return await fetchCodexUsageReport(config, fetchedAt);
    if (!usageUrl) return { reports: [], error: null, fetchedAt };
    const configuredKeys = getApiKeyPool(config, providerKey);
    const auth = configuredKeys.length > 0 ? null : await resolveProviderAuthToken(config, providerKey);
    const credentials = configuredKeys.length > 0 ? configuredKeys : (auth?.token ? [auth.token] : [null]);
    if (credentials[0] == null) return { reports: [], error: 'No credentials configured.', fetchedAt };
    const reports = [];
    let failedAccounts = 0;
    for (let index = 0; index < credentials.length; index++) {
      const token = credentials[index];
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        const response = await fetch(usageUrl, { headers });
        if (!response.ok) { failedAccounts++; continue; }
        const payload = await response.json();
        const source = providerConfig.usageUrl ? 'provider-usage-endpoint' : 'openrouter-key-endpoint';
        const options = {
          source,
          account: credentials.length > 1 ? `API key ${index + 1}` : null,
          fetchedAt,
          freshness: 'fresh',
        };
        if (providerKey === OPENROUTER_PROVIDER_KEY) {
          const data = payload?.data || payload || {};
          reports.push(...normalizeProviderUsageReport(providerKey, {
            ...data,
            used: data.usage ?? data.creditsUsed,
            limit: data.limit ?? data.creditLimit,
            remaining: data.limit != null && data.usage != null ? Number(data.limit) - Number(data.usage) : data.creditRemaining,
            unit: 'credits',
            metric: 'credits',
            scope: 'account/key',
          }, options));
        } else {
          reports.push(...normalizeProviderUsageReport(providerKey, payload, options));
        }
      } catch {
        failedAccounts++;
      }
    }
    return {
      reports,
      fetchedAt,
      error: failedAccounts === credentials.length ? 'Usage endpoint unavailable.' : (failedAccounts > 0 ? `${failedAccounts} account(s) unavailable.` : null),
    };
}

/**
 * 📖 Copilot request identity: every Copilot API call carries these headers, and the
 *    integration id decides which client surface GitHub bills the request against.
 *    `initiator` separates user-driven chat (draws down premium requests) from
 *    automated/agent traffic (does not), matching the Copilot CLI's own semantics.
 */
export function buildCopilotIdentityHeaders({ initiator = 'user', integrationId = COPILOT_CHAT_INTEGRATION_ID } = {}) {
  const normalizedInitiator = initiator === 'agent' ? 'agent' : 'user';
  return {
    'User-Agent': COPILOT_CLI_USER_AGENT,
    'Editor-Version': COPILOT_CLI_USER_AGENT,
    'Copilot-Integration-Id': integrationId,
    'Copilot-Harness-Id': 'copilot-sdk',
    'Openai-Intent': 'conversation-agent',
    'X-Initiator': normalizedInitiator,
    'X-Interaction-Type': `conversation-${normalizedInitiator}`,
  };
}

/**
 * 📖 Infer whether a chat request is user- or agent-initiated, the same way the
 *    Copilot CLI does: only a trailing user message counts as user-initiated, and a
 *    tool result (openai `tool` role or an Anthropic-style tool_result block) is agent.
 */
export function inferCopilotInitiator(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || typeof last !== 'object') return 'agent';
  const role = typeof last.role === 'string' ? last.role.trim().toLowerCase() : '';
  if (role !== 'user') return 'agent';
  const content = last.content;
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1];
    if (lastBlock && typeof lastBlock === 'object' && lastBlock.type === 'tool_result') return 'agent';
  }
  return 'user';
}

function copilotMessagesHaveImages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'image') return true;
    }
  }
  return false;
}

/**
 * 📖 True when a Copilot response is a client-identity denial rather than a real
 *    model fault: HTTP 403, or HTTP 400 carrying error.code "model_not_supported"
 *    (the shape api.business.githubcopilot.com returns for a blocked surface).
 */
export function isCopilotIdentityDenied(status, bodyText) {
  if (status === 403) return true;
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(String(bodyText || ''));
    return parsed?.error?.code === 'model_not_supported';
  } catch {
    return false;
  }
}

/** 📖 The GitHub OAuth token backing this provider (env override, then config pool). */
export function getCopilotConfiguredToken(config) {
  return normalizeSecretValue(getApiKey(config, GITHUB_COPILOT_PROVIDER_KEY))
    || normalizeSecretValue(config?.providers?.[GITHUB_COPILOT_PROVIDER_KEY]?.oauthToken);
}

export function hasGitHubCopilotAuthConfigured(config) {
  return !!getCopilotConfiguredToken(config);
}

/** 📖 Accept a base URL or a full chat URL and always produce the chat endpoint. */
export function buildCopilotChatUrl(baseUrl) {
  const trimmed = normalizeSecretValue(baseUrl);
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  const withoutSlash = trimmed.replace(/\/+$/, '');
  return withoutSlash.endsWith(COPILOT_CHAT_PATH) ? withoutSlash : `${withoutSlash}${COPILOT_CHAT_PATH}`;
}

/**
 * 📖 Probe the plan-specific Copilot API host for a token (business/enterprise
 *    plans answer on their own subdomain). Best effort: personal accounts keep
 *    the canonical host, so a failure is not an error.
 */
export async function fetchCopilotApiEndpoint(token, options = {}) {
  try {
    const response = await fetch(`${COPILOT_GITHUB_API_BASE}/copilot_internal/user`, {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`,
        'User-Agent': COPILOT_CLI_USER_AGENT,
      },
      signal: options.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const endpoint = data && typeof data === 'object' ? data.endpoints?.api : null;
    if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint)) return null;
    return buildCopilotChatUrl(endpoint) ? endpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') : null;
  } catch {
    return null;
  }
}

/** 📖 The GitHub login behind a token, used purely for display in the dashboard. */
export async function fetchGitHubLogin(token, options = {}) {
  try {
    const response = await fetch(`${COPILOT_GITHUB_API_BASE}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': COPILOT_CLI_USER_AGENT,
      },
      signal: options.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return normalizeSecretValue(data?.login) || null;
  } catch {
    return null;
  }
}

/**
 * 📖 Resolve the Copilot API base for the configured account, probing and caching
 *    the plan-specific host once per token.
 */
export async function resolveCopilotApiBaseUrl(config) {
  const configured = normalizeSecretValue(config?.providers?.[GITHUB_COPILOT_PROVIDER_KEY]?.apiEndpoint);
  if (configured) return configured;
  const token = getCopilotConfiguredToken(config);
  if (!token) return COPILOT_DEFAULT_API_BASE;
  const now = Date.now();
  if (_copilotApiEndpointCache.token === token && (now - _copilotApiEndpointCache.checkedAt) < 30 * 60_000) {
    return _copilotApiEndpointCache.apiEndpoint || COPILOT_DEFAULT_API_BASE;
  }
  const discovered = await fetchCopilotApiEndpoint(token, { signal: AbortSignal.timeout(10_000) });
  _copilotApiEndpointCache = { token, apiEndpoint: discovered, checkedAt: now };
  if (discovered && discovered !== COPILOT_DEFAULT_API_BASE) return discovered;
  return COPILOT_DEFAULT_API_BASE;
}

function clearCopilotAuthCaches() {
  _copilotApiEndpointCache = { token: null, apiEndpoint: null, checkedAt: 0 };
}

/** 📖 Start a GitHub device authorization (the user approves it on github.com/login/device). */
export async function startGitHubCopilotDeviceAuth() {
  const response = await fetch(COPILOT_DEVICE_CODE_URL, {
    method: 'POST',
    headers: COPILOT_OAUTH_HEADERS,
    body: new URLSearchParams({ client_id: COPILOT_OAUTH_CLIENT_ID, scope: COPILOT_OAUTH_SCOPE }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub device authorization failed (HTTP ${response.status}).`);
  const data = await response.json().catch(() => null);
  const deviceCode = normalizeSecretValue(data?.device_code);
  const userCode = normalizeSecretValue(data?.user_code);
  if (!deviceCode || !userCode) throw new Error('GitHub returned an invalid device authorization response.');
  const interval = Number(data?.interval);
  const expiresIn = Number(data?.expires_in);
  return {
    deviceCode,
    userCode,
    verificationUri: normalizeSecretValue(data?.verification_uri) || 'https://github.com/login/device',
    verificationUriComplete: normalizeSecretValue(data?.verification_uri_complete) || null,
    interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 5,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 900,
  };
}

/** 📖 Poll a device authorization for its GitHub access token (one round per call). */
export async function pollGitHubCopilotDeviceToken(deviceCode) {
  const response = await fetch(COPILOT_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: COPILOT_OAUTH_HEADERS,
    body: new URLSearchParams({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  const accessToken = normalizeSecretValue(data?.access_token);
  if (accessToken) return { success: true, accessToken };
  const error = normalizeSecretValue(data?.error) || `HTTP ${response.status}`;
  const errorDescription = normalizeSecretValue(data?.error_description) || null;
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { success: false, pending: true, error, errorDescription };
  }
  return { success: false, pending: false, error, errorDescription };
}

function isCopilotPolicyModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return COPILOT_POLICY_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}

/**
 * 📖 Accept a model's policy so the plan will serve it. Some models (Claude, Grok,
 *    the GPT-5 coding family) reject every request until this has been done once.
 */
export async function enableGitHubCopilotModel(token, modelId, apiBaseUrl) {
  try {
    const base = String(apiBaseUrl || COPILOT_DEFAULT_API_BASE).replace(/\/+$/, '');
    const response = await fetch(`${base}/models/${encodeURIComponent(modelId)}/policy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...buildCopilotIdentityHeaders(),
        'Openai-Intent': 'chat-policy',
        'X-Interaction-Type': 'chat-policy',
      },
      body: JSON.stringify({ state: 'enabled' }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function enableGitHubCopilotModels(token, modelIds, apiBaseUrl) {
  const ids = [...new Set((modelIds || []).filter(id => typeof id === 'string' && id.trim()))].filter(isCopilotPolicyModel);
  const BATCH_SIZE = 5;
  let enabled = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const results = await Promise.all(ids.slice(i, i + BATCH_SIZE).map(id => enableGitHubCopilotModel(token, id, apiBaseUrl)));
    enabled += results.filter(Boolean).length;
  }
  return enabled;
}

/**
 * 📖 Map one Copilot /models record onto a router row. Copilot reports its own
 *    context limits under capabilities.limits and marks non-chat rows by type.
 */
export function toGitHubCopilotModelMeta(record, apiBaseUrl = COPILOT_DEFAULT_API_BASE) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId) return null;
  if (!isChatCompatibleDiscoveredModel(record, modelId)) return null;
  const capabilities = record && typeof record === 'object' && record.capabilities && typeof record.capabilities === 'object'
    ? record.capabilities
    : null;
  const capabilityType = normalizeSecretValue(capabilities?.type);
  if (capabilityType && capabilityType.toLowerCase() !== 'chat') return null;

  const scoreLookupId = resolveAliasedModelId(modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = findKnownModelMeta([scoreLookupId, base, unprefixed, modelId], GITHUB_COPILOT_PROVIDER_KEY);
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  const recordLabel = (record && typeof record === 'object' && typeof record.name === 'string' && record.name.trim())
    ? record.name.trim()
    : null;
  const label = getPreferredModelLabel(scoreLookupId, recordLabel || known?.label || formatGenericProviderModelLabel(modelId));

  const rawCtx = record && typeof record === 'object'
    ? (capabilities?.limits?.max_context_window_tokens
      ?? capabilities?.limits?.max_context_length_tokens
      ?? getReportedContext(record))
    : null;
  const { ctx, ctxSource, ctxSourceUrl } = resolveModelContext(rawCtx, known?.providerKey === GITHUB_COPILOT_PROVIDER_KEY ? known : null);

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? null,
    isEstimatedScore: !hasScore,
    ctx,
    ctxSource,
    ctxSourceUrl,
    providerKey: GITHUB_COPILOT_PROVIDER_KEY,
    providerUrl: buildCopilotChatUrl(apiBaseUrl),
  };
}

/** 📖 Discover the models a Copilot account can route to (chat rows only). */
export async function fetchGitHubCopilotModels(token, apiBaseUrl = COPILOT_DEFAULT_API_BASE, options = {}) {
  const base = String(apiBaseUrl || COPILOT_DEFAULT_API_BASE).replace(/\/+$/, '');
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    // Discovery keeps the CLI identity: it unlocks enterprise/experimental rows and
    // listing is not policy-gated the way chat completions are.
    ...buildCopilotIdentityHeaders({ integrationId: COPILOT_CLI_INTEGRATION_ID }),
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
  };
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(`${base}/models`, { method: 'GET', headers, signal: options.signal || ctrl.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    const records = extractOpenAICompatibleModelRecords(payload);
    const seen = new Set();
    const models = [];
    for (const record of records) {
      const model = toGitHubCopilotModelMeta(record, base);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }
    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 📖 Copilot's usage endpoint reports plan-based quota snapshots. Only the capped
 *    buckets become reports: an unlimited bucket has no used/limit to display.
 */
async function fetchCopilotUsageReport(config, fetchedAt) {
  const token = getCopilotConfiguredToken(config);
  if (!token) return { reports: [], error: null, fetchedAt };
  try {
    const response = await fetch(`${COPILOT_GITHUB_API_BASE}/copilot_internal/user`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': COPILOT_CLI_USER_AGENT,
      },
      signal: AbortSignal.timeout(PING_TIMEOUT),
    });
    if (!response.ok) return { reports: [], error: 'Usage endpoint unavailable.', fetchedAt };
    const data = await response.json().catch(() => null);
    const snapshots = data && typeof data === 'object' ? data.quota_snapshots : null;
    if (!snapshots || typeof snapshots !== 'object') return { reports: [], error: null, fetchedAt };
    const plan = normalizeSecretValue(data?.copilot_plan) || null;
    const resetAt = normalizeSecretValue(data?.quota_reset_date) || null;
    const reports = [];
    const buckets = [
      ['premium_interactions', 'premium requests'],
      ['chat', 'chat requests'],
      ['completions', 'completions'],
    ];
    for (const [key, label] of buckets) {
      const snapshot = snapshots[key];
      if (!snapshot || typeof snapshot !== 'object' || snapshot.unlimited === true) continue;
      const entitlement = Number(snapshot.entitlement);
      const remaining = Number(snapshot.remaining);
      if (!Number.isFinite(entitlement) || !Number.isFinite(remaining)) continue;
      reports.push(...normalizeProviderUsageReport(GITHUB_COPILOT_PROVIDER_KEY, {
        metric: 'requests',
        unit: 'requests',
        scope: label,
        account: plan,
        window: 'month',
        resetAt,
        limit: entitlement,
        remaining,
        used: Math.max(0, entitlement - remaining),
      }, { source: 'copilot-quota-endpoint', fetchedAt, freshness: 'fresh' }));
    }
    return { reports, error: null, fetchedAt };
  } catch (err) {
    return { reports: [], error: describeSyncError(err), fetchedAt };
  }
}

/**
 * 📖 OpenAI Codex request identity: the ChatGPT access token plus the workspace
 *    the subscription belongs to. `chatgpt-account-id` selects which workspace's
 *    allowance the request bills against, so it must match the token.
 */
export function buildCodexIdentityHeaders(accessToken, accountId = null, residency = null) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': CODEX_USER_AGENT,
    originator: CODEX_ORIGINATOR,
    'OpenAI-Beta': 'responses=experimental',
    version: CODEX_CLIENT_VERSION,
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  if (residency) headers['x-openai-internal-codex-residency'] = residency;
  return headers;
}

/** 📖 Accept a base URL or a full responses URL and always produce the responses endpoint. */
export function buildCodexResponsesUrl(baseUrl) {
  const trimmed = normalizeSecretValue(baseUrl);
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  const withoutSlash = trimmed.replace(/\/+$/, '');
  if (withoutSlash.endsWith(CODEX_RESPONSES_PATH)) return withoutSlash;
  if (/\/(responses)$/i.test(withoutSlash)) return withoutSlash;
  return `${withoutSlash}${CODEX_RESPONSES_PATH}`;
}

function clearCodexAuthCaches() {
  _codexAccessTokenCache.clear();
}

/**
 * 📖 OpenAI rotates the refresh token on every exchange, so the replacement has to be
 *    persisted or the stored account goes stale after its first refresh and every
 *    later request fails to authenticate. A token that was supplied by config field
 *    or env var is promoted into the account pool here, which is also how a
 *    hand-configured credential survives rotation.
 */
function persistRotatedCodexRefreshToken(previousSecret, resolved) {
  try {
    const currentConfig = loadConfig();
    const existing = getProviderAccounts(currentConfig, OPENAI_CODEX_PROVIDER_KEY)
      .find(account => account.secret === previousSecret) || null;
    addOrUpdateProviderAccount(currentConfig, OPENAI_CODEX_PROVIDER_KEY, {
      secret: resolved.rotatedRefreshToken,
      email: existing?.email || resolved.email,
      accountId: existing?.accountId || resolved.accountId,
      planType: existing?.planType || resolved.planType,
    });
    // Drop the superseded secret so repeated rotations cannot grow the pool.
    removeProviderAccount(currentConfig, OPENAI_CODEX_PROVIDER_KEY, previousSecret);
    const providerConfig = currentConfig.providers[OPENAI_CODEX_PROVIDER_KEY];
    // A legacy single-credential field holding the superseded secret is dead too:
    // leaving it behind would resurrect a token OpenAI has already invalidated.
    if (providerConfig && providerConfig.refreshToken === previousSecret) {
      delete providerConfig.refreshToken;
    }
    saveConfig(currentConfig);
  } catch {
    // A config write failure must not fail the request that triggered the rotation:
    // the live access token in the cache still serves this request.
  }
}

/**
 * 📖 Sign one account out of a provider's pool, or every account when no identifier is given.
 *
 * The distinction only exists once a provider has more than one sign-in, and it is the whole
 * reason this is not simply a pool wipe: retiring one plan, or undoing a sign-in that used the
 * wrong email, must not take the other accounts down with it.
 *
 * The pool is the source of truth, so removing a member leaves the rest untouched, and the
 * provider's legacy single-credential field is only cleared when the pool has emptied — a
 * leftover legacy field would resurrect the credential the user just signed out of. An
 * identifier that matches nothing removes nothing: a typo must not round down to "signed out
 * everything else".
 *
 * @param {object} config mutated in place
 * @param {string} providerKey
 * @param {string|null} [identifier] an account's email, account id or secret
 * @returns {{ removed: number, remaining: number }}
 */
export function applyProviderSignOut(config, providerKey, identifier = null) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    return { removed: 0, remaining: 0 }
  }
  const before = getProviderAccounts(config, providerKey)
  const wanted = normalizeSecretValue(identifier)
  if (wanted) {
    if (!removeProviderAccount(config, providerKey, wanted)) {
      return { removed: 0, remaining: before.length }
    }
  } else {
    setProviderAccounts(config, providerKey, [])
  }
  const after = getProviderAccounts(config, providerKey)
  if (after.length === 0) {
    const legacyField = legacyAccountSecretFieldTable()[providerKey]
    if (legacyField) delete providerConfig[legacyField]
    delete providerConfig.authMode
    delete providerConfig.authEmail
  } else if (after[0].email) {
    // The single-account display field follows the pool, so it can never name the account
    // that just left.
    providerConfig.authEmail = after[0].email
  } else {
    delete providerConfig.authEmail
  }
  return { removed: before.length - after.length, remaining: after.length }
}

/** 📖 Whether any Codex credential is available (account pool, legacy field, or env). */
export function hasOpenAICodexAuthConfigured(config) {
  if (getProviderAccounts(config, OPENAI_CODEX_PROVIDER_KEY).length > 0) return true;
  if (getLegacyProviderAccountSecret(config, OPENAI_CODEX_PROVIDER_KEY)) return true;
  return Boolean(normalizeSecretValue(process.env.OPENAI_CODEX_REFRESH_TOKEN));
}

/** 📖 Start a ChatGPT device authorization (the user approves it on auth.openai.com/codex/device). */
export async function startOpenAICodexDeviceAuth() {
  const response = await fetch(CODEX_DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(CODEX_OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI device authorization failed (HTTP ${response.status}).`);
  const data = await response.json().catch(() => null);
  const deviceAuthId = normalizeSecretValue(data?.device_auth_id);
  const userCode = normalizeSecretValue(data?.user_code);
  if (!deviceAuthId || !userCode) throw new Error('OpenAI returned an invalid device authorization response.');
  const intervalSeconds = Number(data?.interval);
  return {
    deviceAuthId,
    userCode,
    verificationUri: CODEX_DEVICE_VERIFY_URL,
    interval: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? Math.floor(intervalSeconds) : CODEX_DEVICE_POLL_INTERVAL_MS / 1000,
  };
}

/**
 * 📖 Poll a ChatGPT device authorization (one round per call). The backend answers
 *    403/404 while the user has not approved yet, then hands back an authorization
 *    code and the PKCE verifier the device flow generated server-side.
 */
export async function pollOpenAICodexDeviceToken(deviceAuthId, userCode) {
  const response = await fetch(CODEX_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(CODEX_OAUTH_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 404) return { pending: true };
  if (!response.ok) return { pending: false, error: `HTTP ${response.status}` };
  const data = await response.json().catch(() => null);
  const authorizationCode = normalizeSecretValue(data?.authorization_code);
  const codeVerifier = normalizeSecretValue(data?.code_verifier);
  if (!authorizationCode || !codeVerifier) return { pending: false, error: 'Device authorization response was missing the authorization code.' };
  return { pending: false, authorizationCode, codeVerifier };
}

/** 📖 Exchange an authorization code for OAuth tokens (the login leg of the device flow). */
export async function exchangeOpenAICodexAuthorizationCode(authorizationCode, codeVerifier) {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(CODEX_OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed (HTTP ${response.status}).`);
  const data = await response.json().catch(() => null);
  const accessToken = normalizeSecretValue(data?.access_token);
  const refreshToken = normalizeSecretValue(data?.refresh_token);
  if (!accessToken || !refreshToken) throw new Error('OpenAI token exchange returned no refresh token.');
  return { accessToken, refreshToken, idToken: normalizeSecretValue(data?.id_token) || null, expiresIn: Number(data?.expires_in) || null };
}

/** 📖 Trade a refresh token for a fresh access token (OpenAI rotates the refresh token too). */
export async function refreshOpenAICodexAccessToken(refreshToken) {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: CODEX_SCOPE,
    }),
    signal: AbortSignal.timeout(CODEX_OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI token refresh failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const data = await response.json().catch(() => null);
  const accessToken = normalizeSecretValue(data?.access_token);
  if (!accessToken) throw new Error('OpenAI token refresh returned no access token.');
  return {
    accessToken,
    refreshToken: normalizeSecretValue(data?.refresh_token) || null,
    idToken: normalizeSecretValue(data?.id_token) || null,
    expiresIn: Number(data?.expires_in) || null,
  };
}

/**
 * 📖 Resolve a live access token for one signed-in ChatGPT account, caching it per
 *    refresh token. Reports a rotated refresh token so the caller can persist it.
 */
export async function resolveOpenAICodexAccessToken(refreshToken) {
  const cached = _codexAccessTokenCache.get(refreshToken);
  if (cached && (cached.expiresAt - CODEX_ACCESS_TOKEN_SKEW_MS) > Date.now()) {
    return { ...cached, rotatedRefreshToken: null };
  }
  const refreshed = await refreshOpenAICodexAccessToken(refreshToken);
  const identity = extractCodexAccountIdentity(refreshed.accessToken, refreshed.idToken);
  const entry = {
    accessToken: refreshed.accessToken,
    accountId: identity.accountId,
    email: identity.email,
    planType: identity.planType,
    residency: identity.residency,
    expiresAt: Date.now() + (refreshed.expiresIn ? refreshed.expiresIn * 1000 : CODEX_DEFAULT_ACCESS_TOKEN_TTL_MS),
  };
  _codexAccessTokenCache.set(refreshToken, entry);
  const rotated = refreshed.refreshToken && refreshed.refreshToken !== refreshToken ? refreshed.refreshToken : null;
  // OpenAI rotates refresh tokens. Keep the new one mapped to the same live entry
  // so a request that still holds the old token is not forced into a second exchange.
  if (rotated) _codexAccessTokenCache.set(rotated, entry);
  // Persist the replacement here, at the one point every caller goes through: a
  // rotation discovered during model discovery or a usage read would otherwise be
  // lost, and the superseded secret stored in config would stop authenticating.
  if (rotated) persistRotatedCodexRefreshToken(refreshToken, { ...entry, rotatedRefreshToken: rotated });
  return { ...entry, rotatedRefreshToken: rotated };
}

/** 📖 Discover the models a ChatGPT account can route to (chat rows only). */
export async function fetchOpenAICodexModels(accessToken, accountId = null, baseUrl = null, options = {}) {
  const base = normalizeSecretValue(baseUrl) || CODEX_DEFAULT_BASE_URL;
  const headers = { ...buildCodexIdentityHeaders(accessToken, accountId), Accept: 'application/json' };
  let lastError = null;
  for (const path of CODEX_MODELS_PATHS) {
    const url = `${String(base).replace(/\/+$/, '')}${path}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: options.signal || AbortSignal.timeout(PING_TIMEOUT) });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const payload = await response.json().catch(() => null);
      const records = extractCodexModelRecords(payload);
      if (records.length === 0) { lastError = new Error('Model list was empty.'); continue; }
      return records;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Codex model discovery failed.');
}

/**
 * 📖 Map one Codex model record onto a router row. Codex reports its own context
 *    ceiling, and hides rows it will not serve to this account behind `visibility`.
 */
export function toOpenAICodexModelMeta(record, baseUrl = CODEX_DEFAULT_BASE_URL) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.slug || record?.id || record?.model || '').trim();
  if (!modelId) return null;
  const visibility = typeof record === 'object' && record ? normalizeSecretValue(record.visibility) : null;
  if (visibility && !['list', 'public', 'default'].includes(visibility.toLowerCase())) return null;
  if (!isChatCompatibleDiscoveredModel(record, modelId)) return null;

  const scoreLookupId = resolveAliasedModelId(modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = findKnownModelMeta([scoreLookupId, base, unprefixed, modelId], OPENAI_CODEX_PROVIDER_KEY);
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);
  const recordLabel = typeof record === 'object' && record && typeof record.display_name === 'string' && record.display_name.trim()
    ? record.display_name.trim()
    : null;
  const label = getPreferredModelLabel(scoreLookupId, recordLabel || known?.label || formatGenericProviderModelLabel(modelId));

  const rawCtx = typeof record === 'object' && record
    ? (record.max_context_window ?? record.context_window ?? record.max_context_length ?? null)
    : null;
  const { ctx, ctxSource, ctxSourceUrl } = resolveModelContext(rawCtx, known?.providerKey === OPENAI_CODEX_PROVIDER_KEY ? known : null);

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? null,
    isEstimatedScore: !hasScore,
    ctx,
    ctxSource,
    ctxSourceUrl,
    providerKey: OPENAI_CODEX_PROVIDER_KEY,
    providerUrl: buildCodexResponsesUrl(baseUrl),
  };
}

/**
 * 📖 A ChatGPT subscription exposes its remaining allowance on `/wham/usage` as
 *    percent-used windows, which is the only place Codex's quota is readable
 *    before a request is made.
 */
async function fetchCodexUsageReport(config, fetchedAt) {
  const accounts = getProviderAccounts(config, OPENAI_CODEX_PROVIDER_KEY);
  const legacy = getLegacyProviderAccountSecret(config, OPENAI_CODEX_PROVIDER_KEY);
  const envToken = normalizeSecretValue(process.env.OPENAI_CODEX_REFRESH_TOKEN);
  const refreshToken = accounts[0]?.secret || legacy || envToken;
  if (!refreshToken) return { reports: [], error: null, fetchedAt };
  try {
    const resolved = await resolveOpenAICodexAccessToken(refreshToken);
    const base = normalizeSecretValue(getProviderBaseUrl(config, OPENAI_CODEX_PROVIDER_KEY)) || CODEX_DEFAULT_BASE_URL;
    const response = await fetch(`${String(base).replace(/\/+$/, '')}/wham/usage`, {
      headers: { ...buildCodexIdentityHeaders(resolved.accessToken, resolved.accountId, resolved.residency), Accept: 'application/json' },
      signal: AbortSignal.timeout(PING_TIMEOUT),
    });
    if (!response.ok) return { reports: [], error: 'Usage endpoint unavailable.', fetchedAt };
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return { reports: [], error: null, fetchedAt };
    const plan = normalizeSecretValue(data.plan_type) || accounts[0]?.planType || null;
    const account = accounts[0]?.email || resolved.email || null;
    const reports = [];
    const windows = [
      ['primary', data.rate_limit?.primary_window, 'primary window'],
      ['secondary', data.rate_limit?.secondary_window, 'secondary window'],
    ];
    for (const [key, window, label] of windows) {
      if (!window || typeof window !== 'object') continue;
      const usedPercent = Number(window.used_percent);
      if (!Number.isFinite(usedPercent)) continue;
      const used = Math.min(Math.max(usedPercent, 0), 100);
      const resetAfter = Number(window.reset_after_seconds);
      const resetAt = Number.isFinite(resetAfter) ? new Date(fetchedAt + resetAfter * 1000).toISOString() : null;
      reports.push(...normalizeProviderUsageReport(OPENAI_CODEX_PROVIDER_KEY, {
        metric: 'percent',
        unit: 'percent',
        scope: `${label} (${key})`,
        account,
        window: 'rolling',
        resetAt,
        limit: 100,
        used,
        remaining: Math.max(0, 100 - used),
      }, { source: 'codex-usage-endpoint', fetchedAt, freshness: 'fresh' }));
    }
    return { reports, error: null, fetchedAt, plan };
  } catch (err) {
    return { reports: [], error: describeSyncError(err), fetchedAt };
  }
}

// One anonymous gptfree identity per process, reused for the whole run. Signing up per
// request would mint a new account per probe, which is neither what the site does nor
// something it would tolerate; the refresh token is the durable half, and the ID token
// is re-minted from it without a new sign-up.
let _gptfreeAuth = { idToken: null, refreshToken: null, expiresAt: 0, inFlight: null };

function gptFreeTokenExpired(entry, now = Date.now()) {
  return !entry?.idToken || !entry?.expiresAt || entry.expiresAt - GPTFREE_TOKEN_SKEW_MS <= now;
}

function gptFreeTokenEntry(idToken, refreshToken, expiresIn) {
  const seconds = Number(expiresIn);
  return {
    idToken,
    refreshToken: refreshToken || null,
    // The server states the lifetime; the fallback is only for a response that omitted
    // it, and is short enough that a wrong guess costs one extra refresh, not a 401.
    expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 55 * 60_000),
  };
}

async function mintGptFreeAnonymousToken() {
  const response = await fetch(`${GPTFREE_SIGNUP_URL}?key=${GPTFREE_FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
    signal: AbortSignal.timeout(PING_TIMEOUT),
  });
  const data = await response.json().catch(() => null);
  const idToken = normalizeSecretValue(data?.idToken);
  if (!response.ok || !idToken) {
    throw new Error(`gptfree anonymous sign-in failed (HTTP ${response.status})`);
  }
  return gptFreeTokenEntry(idToken, normalizeSecretValue(data?.refreshToken), data?.expiresIn);
}

async function refreshGptFreeAnonymousToken(refreshToken) {
  const response = await fetch(`${GPTFREE_REFRESH_URL}?key=${GPTFREE_FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(PING_TIMEOUT),
  });
  const data = await response.json().catch(() => null);
  // The refresh endpoint spells the same token `id_token`; `access_token` is accepted as
  // a fallback only because both are Firebase-issued tokens for the same anonymous user.
  const idToken = normalizeSecretValue(data?.id_token || data?.access_token);
  if (!response.ok || !idToken) {
    throw new Error(`gptfree token refresh failed (HTTP ${response.status})`);
  }
  return gptFreeTokenEntry(idToken, normalizeSecretValue(data?.refresh_token) || refreshToken, data?.expires_in);
}

/**
 * The bearer every gptfree request carries: an anonymous Firebase ID token, minted on
 * first use and re-minted from its refresh token afterwards. Concurrent callers share one
 * in-flight exchange, so a burst of probes signs in once rather than once each.
 */
export async function resolveGptFreeAccessToken(force = false) {
  if (!force && !gptFreeTokenExpired(_gptfreeAuth)) return _gptfreeAuth.idToken;
  if (_gptfreeAuth.inFlight) return _gptfreeAuth.inFlight;

  const pending = (async () => {
    const previousRefreshToken = _gptfreeAuth.refreshToken;
    try {
      const next = previousRefreshToken
        ? await refreshGptFreeAnonymousToken(previousRefreshToken)
        : await mintGptFreeAnonymousToken();
      _gptfreeAuth = { ...next, inFlight: null };
      return next.idToken;
    } catch (err) {
      if (previousRefreshToken) {
        // A refresh can fail because the identity itself is gone (a wiped project, an
        // anonymous user Firebase has since retired). One fresh sign-in is the recovery;
        // if that fails too, the original error is the honest one to report.
        try {
          const next = await mintGptFreeAnonymousToken();
          _gptfreeAuth = { ...next, inFlight: null };
          return next.idToken;
        } catch { /* fall through to the original failure */ }
      }
      _gptfreeAuth = { ..._gptfreeAuth, inFlight: null };
      throw err;
    }
  })();

  _gptfreeAuth = { ..._gptfreeAuth, inFlight: pending };
  return pending;
}

async function resolveProviderAuthToken(config, providerKey, options = {}) {
  if (providerKey === GPTFREE_PROVIDER_KEY) {
    // No user credential exists to read: the bearer is minted on demand and cached.
    // `useBearerAuth` deliberately does not gate this — the toggle governs whether a
    // *user's own* key is attached, and here the token is the only way in.
    try {
      const token = await resolveGptFreeAccessToken();
      return { token, authSource: 'anonymous-firebase', providerUrlOverride: null, account: null };
    } catch (err) {
      return { token: null, authSource: null, providerUrlOverride: null, account: null, error: describeSyncError(err) };
    }
  }
  if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
    // Codex's credential is a refresh token, not a bearer: the access token is
    // exchanged on demand. The account pool is the multi-account source — with more
    // than one signed-in account the first is spent before the next is touched, because a
    // ChatGPT plan's windows are per account — while the legacy field and env var keep a
    // single-account config working unchanged.
    const refreshToken = selectCodexRefreshToken(config);
    if (!refreshToken) return { token: null, authSource: null, providerUrlOverride: null, account: null };
    try {
      const resolved = await resolveOpenAICodexAccessToken(refreshToken);
      return {
        token: resolved.accessToken,
        authSource: 'chatgpt-oauth',
        providerUrlOverride: null,
        account: { secret: refreshToken, accountId: resolved.accountId, email: resolved.email, planType: resolved.planType, residency: resolved.residency },
      };
    } catch (err) {
      return { token: null, authSource: null, providerUrlOverride: null, account: null, error: describeSyncError(err) };
    }
  }
  if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) {
    // The GitHub OAuth token is itself the bearer credential (GitHub issues these
    // long-lived, so unlike Kiro there is no refresh exchange to perform).
    const token = getCopilotConfiguredToken(config);
    if (token) return { token, authSource: 'github-oauth', providerUrlOverride: null };
    return { token: null, authSource: null, providerUrlOverride: null };
  }
  if (providerKey === KIRO_PROVIDER_KEY) {
    const oauthToken = await resolveKiroOAuthAccessToken(config);
    if (oauthToken) return { token: oauthToken, authSource: 'oauth-refresh-token', providerUrlOverride: null };
  }

  const apiKey = getApiKey(config, providerKey);
  if (providerKey === DEVIN_PROVIDER_KEY) {
    const configured = config?.providers?.[DEVIN_PROVIDER_KEY]?.sessionToken;
    const token = normalizeSecretValue(configured || apiKey || process.env.DEVIN_SESSION_TOKEN);
    // No URL override: the provider row's source URL already points at
    // /exa.api_server_pb.ApiServerService/GetChatMessage (posting to the bare
    // server root used to garble Devin responses).
    if (token) return { token, authSource: 'session-token', providerUrlOverride: null };
  }
  if (apiKey && providerWantsBearerAuth(config, providerKey)) {
    return { token: apiKey, authSource: 'api-key', providerUrlOverride: null };
  }

  return { token: null, authSource: null, providerUrlOverride: null };
}

/**
 * 📖 Can this provider answer a request at all?
 *
 * The question the model table never asked, and the reason one bug kept arriving from
 * different directions: whether a row existed was decided by "does this provider have a
 * catalog", never by "can it authenticate". A public catalog endpoint is not a credential —
 * `GET https://ollama.com/api/tags` answers 200 to anyone, Kilo's gateway lists 391 models of
 * which only the `isFree` ones are reachable without a key, and GitHub Copilot's curated rows
 * were merged back in by name whenever no token was configured. Each produced rows that every
 * dispatch refuses with NO_KEY: capability in the table, an auth error on the first request.
 *
 * This answers the credential half of the dispatch gate synchronously, reading the same
 * places `resolveProviderAuthToken` reads, so a row cannot outlive the router's ability to
 * use it. Deliberately not latched — every call re-reads the config, so signing in or pasting
 * a key brings the rows back on the next refresh, with no restart.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function providerCanServe(config, providerKey) {
  // Keyless by declaration, or a local Ollama, which is keyless by where it points. This is
  // the very test dispatch applies, so listing and routing cannot disagree about it.
  if (isProviderAuthOptional(config, providerKey)) return true
  // A configured key, the environment included: getApiKeyPool reads env vars first.
  if (getApiKeyPool(config, providerKey).length > 0) return true
  // Sign-in providers keep their credential somewhere other than `apiKeys`, and each already
  // has a helper that owns the fact. Using those keeps this answer identical to the one the
  // provider cards show, instead of a second opinion that can drift.
  if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) return hasGitHubCopilotAuthConfigured(config)
  if (providerKey === OPENAI_CODEX_PROVIDER_KEY) return hasOpenAICodexAuthConfigured(config)
  if (providerKey === KIRO_PROVIDER_KEY) return hasKiroAuthConfigured(config)
  if (providerKey === DEVIN_PROVIDER_KEY) {
    const sessionToken = config?.providers?.[DEVIN_PROVIDER_KEY]?.sessionToken
    return Boolean(normalizeSecretValue(sessionToken || process.env.DEVIN_SESSION_TOKEN))
  }
  // gptfree has nothing to configure: its bearer is minted anonymously on demand, and the
  // mint reports its own failure. Gating it would hide a provider whose only requirement is
  // to be asked.
  if (providerKey === GPTFREE_PROVIDER_KEY) return true
  return false
}

function resolveProviderUrl(config, providerKey, authProviderUrlOverride = null, resultProviderUrl = null) {
  if (authProviderUrlOverride) return authProviderUrlOverride;
  if (isOpenAICompatibleInstanceKey(providerKey) || providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) {
    return normalizeOpenAICompatibleProviderUrl(resultProviderUrl || getProviderBaseUrl(config, providerKey) || getDefaultProviderBaseUrl(providerKey));
  }
  // A configured baseUrl override wins over the catalog default, and lets a
  // user point g4f at a self-hosted g4f server.
  if (providerKey === FREEMODELS_PROVIDER_KEY) {
    return getProviderBaseUrl(config, providerKey) || FREEMODELS_URL;
  }
  if (providerKey === G4F_PROVIDER_KEY) {
    return getProviderBaseUrl(config, providerKey) || sources[providerKey]?.url || sources.nvidia.url;
  }
  if (providerKey === GPTFREE_PROVIDER_KEY) {
    // A configured baseUrl lets a user route through their own shim instead of the
    // site's Cloud Function (which is one more reason this row is worth having: the
    // unofficial part can be moved out of hammer without touching hammer).
    return getProviderBaseUrl(config, providerKey) || sources[providerKey]?.url || GPTFREE_STREAM_URL;
  }
  if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
    // A configured baseUrl may be the backend root or a full responses URL; either
    // way the client only ever talks to /codex/responses.
    return buildCodexResponsesUrl(getProviderBaseUrl(config, providerKey))
      || sources[providerKey]?.url
      || `${CODEX_DEFAULT_BASE_URL}${CODEX_RESPONSES_PATH}`;
  }
  // A user-supplied base URL wins, then the plan-specific host learned at sign-in
  // (business/enterprise plans answer on their own subdomain), then the catalog URL.
  if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) {
    return buildCopilotChatUrl(getProviderBaseUrl(config, providerKey))
      || buildCopilotChatUrl(config?.providers?.[GITHUB_COPILOT_PROVIDER_KEY]?.apiEndpoint)
      || sources[providerKey]?.url
      || `${COPILOT_DEFAULT_API_BASE}${COPILOT_CHAT_PATH}`;
  }
  // The catalog URL is the last resort, and it may be a template: Cloudflare's endpoint
  // embeds an account id and Vertex's embeds a project and region, neither of which belongs
  // in a key. Substitution happens here because this function is the single owner of "what
  // URL does this provider answer at" — a second place would be a second answer.
  return resolveShapedChatUrl(config, providerKey, sources[providerKey]?.url || sources.nvidia.url).url;
}

// The frames that carry an *answer*, as opposed to the role-only opening frame of a stream.
// Shared by the proxy's stream capture (which measures real usage) and the model test, which
// streams too, so both are timing the same thing: the window the answer's own frames spanned.
const OUTPUT_FRAME_RE = /"(?:content|reasoning_content)":"(?:[^"\\]|\\.)+"|"tool_calls"|"function_call"/;
// Bound on the transcript a streamed test keeps in memory. A test asks for a short answer, so
// this only ever bites on a relay that streams something other than an answer.
const MAX_STREAM_TRANSCRIPT_CHARS = 4 * 1024 * 1024;

/**
 * Reads a streamed OpenAI-style chat response into the facts a speed measurement needs: the
 * raw transcript, when the first byte arrived, and when the answer's own frames arrived (both
 * frame times stay 0 when no output-bearing frame was seen at all).
 *
 * Reading the body is what makes a real time-to-first-token possible. A non-streamed response
 * only ever offers its total duration — prefill, queueing and delivery in one number — which
 * is the number the test used to report as both its TTFT and its tok/s.
 *
 * The transcript is parsed afterwards, whole (see summarizeTestAnswer), rather than chunk by
 * chunk: a `data:` frame can be split across two chunks, and a half-frame parsed for content
 * would silently truncate the answer. The frame *times* are taken per chunk, exactly as the
 * proxy's captureStream takes them, because that is all a window needs.
 */
async function readStreamedAnswer(response, startedAt) {
  const facts = { transcript: '', ttftMs: null, firstOutputAt: 0, lastOutputAt: 0 };
  if (!response?.body) return facts;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    if (facts.ttftMs == null) facts.ttftMs = Math.round(performance.now() - startedAt);
    const piece = decoder.decode(chunk, { stream: true });
    if (facts.transcript.length < MAX_STREAM_TRANSCRIPT_CHARS) facts.transcript += piece;
    if (OUTPUT_FRAME_RE.test(piece)) {
      const at = performance.now();
      if (!facts.firstOutputAt) facts.firstOutputAt = at;
      facts.lastOutputAt = at;
    }
  }
  return facts;
}

/**
 * 📖 How a restart brings the router back, given the autostart service's view of itself.
 *
 * The two answers are not interchangeable, which is the whole reason this is a decision rather
 * than a flag. An autostart service is generated with `Restart=always` / `KeepAlive` (see
 * `lib/autostart.js`), so for a process the service owns, *exiting is the restart* — and
 * spawning a replacement as well would race the supervisor into two routers sharing one port.
 * A process nobody supervises has to replace itself, because nothing else will.
 *
 * The two platforms report differently: systemd says `active`, launchd says `loaded`. Windows
 * autostart is a Startup folder script that runs once at login and restarts nothing, so a
 * Windows process is never treated as supervised here — exiting there would simply be the end
 * of the router.
 *
 * @param {object|null} status  `getAutostartStatus()`'s result
 * @returns {'supervised'|'exec'}
 */
export function restartMode(status) {
  const supervised = status?.supported === true && (status.active === true || status.loaded === true);
  return supervised ? 'supervised' : 'exec';
}

export async function runServer(config, port, enableLog = true, bannedModels = [], hostOverride = null, verbose = false) {
  const startupStartedAt = Date.now()
  let startupLoading = true
  const startupWarnings = []
  kiroOAuthWarningCollector = startupWarnings
  const startupLog = (...args) => {
    if (!startupLoading || verbose) startupLogLine(...args)
  }
  const startupVerboseLog = (...args) => {
    if (verbose) startupLogLine(...args)
  }
  // Skipped model syncs and discoveries retry every couple of minutes, so one provider
  // that keeps failing would repeat its line on every cycle. Pass those through here to
  // report a skip while it is news (see SKIP_LOG_REMINDER_MS). Keyed by the line itself,
  // because a provider can report the same outage through both a sync and a discovery
  // path, and because a changed reason (HTTP 503 to a timeout) is worth printing at once.
  const lastSkipLogAt = new Map()
  const skipLog = (message) => {
    const now = Date.now()
    const previous = lastSkipLogAt.get(message)
    if (previous && now - Number(previous.at || 0) < SKIP_LOG_REMINDER_MS) return
    lastSkipLogAt.set(message, { at: now })
    // Bound the map: a failure whose text keeps changing must not grow it forever.
    if (lastSkipLogAt.size > 64) {
      for (const [text, entry] of lastSkipLogAt) {
        if (now - Number(entry.at || 0) >= SKIP_LOG_REMINDER_MS) lastSkipLogAt.delete(text)
      }
    }
    startupLog(chalk.dim(`  ${message}`))
  }

  console.log(chalk.cyan(`  ⏳ Loading Hammer v${APP_VERSION} on port ${port}...`))

  const listenHost = (hostOverride && String(hostOverride).trim()) || config?.host || '127.0.0.1';
  const lanMode = !isLoopbackHostname(listenHost);

  // When exposing over the network, non-loopback clients must present an access token.
  // Generate one on first run so the dashboard can be locked down without manual setup.
  let accessToken = (config && typeof config.accessToken === 'string' && config.accessToken.trim()) ? config.accessToken.trim() : null;
  if (lanMode && !accessToken) {
    accessToken = randomBytes(24).toString('base64url');
    const tokenConfig = loadConfig();
    tokenConfig.accessToken = accessToken;
    saveConfig(tokenConfig);
  }

  // 📖 pinnedModelId: when set, ALL proxy requests are locked to this model (in-memory, resets on restart)
  let pinnedModelId = null;
  let pinnedProviderKey = null;
  let lastProxyError = null;

  // Multi-account pool state, one entry per provider: which credential is serving, how many
  // requests each has carried, and until when each is exhausted.
  const keyPoolState = new Map() // providerKey → { currentIdx, accounts: Map<idx, { requests, rateLimitedAt, exhaustedUntil }> }
  _setKeyPoolState(keyPoolState)

  function getKeyPoolEntry(providerKey) {
    if (!keyPoolState.has(providerKey)) {
      keyPoolState.set(providerKey, { currentIdx: 0, accounts: new Map() })
    }
    return keyPoolState.get(providerKey)
  }

  function getNextApiKey(config, providerKey) {
    const pool = getApiKeyPool(config, providerKey)
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0]

    const entry = getKeyPoolEntry(providerKey)
    const now = Date.now()
    return selectNextApiKeyFromPool(pool, entry, 0, now, KEY_POOL_COOLDOWN_MS)
  }

  // 📖 Benches one credential of a provider until the pool's cooldown expires. Both kinds of
  // 📖 pool come through here: static API keys, and the signed-in accounts of a provider whose
  // 📖 credential is not a bearer at all (Codex benches the account's refresh-token secret,
  // 📖 while the access token that secret minted is what was actually sent upstream).
  function markRateLimited(providerKey, credential, resetMs = null) {
    const pool = rotatableCredentialPool(loadConfig(), providerKey)
    const idx = pool.indexOf(credential)
    if (idx === -1) return
    // Recorded even for a provider with a single credential: the exhaustion is what the card's
    // usage bar shows, and "my one key is spent until tomorrow" is exactly the state a user
    // needs to see. Rotation is a separate question from whether the state is worth keeping.
    benchCredential(getKeyPoolEntry(providerKey), idx, Date.now(), resetMs, KEY_POOL_COOLDOWN_MS)
  }

  // 📖 A credential the provider itself refused — a key it does not recognise, or a sign-in
  // 📖 whose plan no longer covers the model. The pool exists to fail over, and the refusal is
  // 📖 about *this* credential, so it is benched for the local window like a spent one.
  // 📖
  // 📖 This matters more under `exhaust` than it ever did under round-robin: the selector scans
  // 📖 from the first credential every time and skips only what is spent, so a rejected
  // 📖 credential that is never benched is handed out for every request forever — a dead key at
  // 📖 the head of the pool would hide a working one behind it. Round-robin at least staggered
  // 📖 the two, which is why the bench is the fix rather than a cursor reset.
  // 📖
  // 📖 Deliberately not applied to a one-credential pool: there is nothing to fail over to, and
  // 📖 benching it would only relabel the card's bar as "exhausted", which would be false — an
  // 📖 unrecognised key is not a limit that lifts in a minute. A 429 keeps its own rule and
  // 📖 benches even a lone credential, because running out of a quota is a fact about that
  // 📖 credential's window and showing it is the point.
  function markCredentialRejected(providerKey, credential) {
    if (!credential) return
    if (rotatableCredentialPool(loadConfig(), providerKey).length < 2) return
    markRateLimited(providerKey, credential, null)
  }

  // Gemini thinking-model thought_signature cache: Google's thinking models (2.5 Flash/Pro)
  // require a thought_signature field in function call parts when tools are used. This field
  // is Gemini-specific and doesn't exist in the OpenAI spec, so clients strip it. We capture
  // it from Gemini responses and re-inject it on follow-up requests.
  const thoughtSignatureCache = new Map(); // tool_call_id → { signature, expiresAt }
  const THOUGHT_SIGNATURE_CACHE_PATH = join(homedir(), '.hammer-thought-signatures.json');

  // Persist signatures across restarts so tool chains survive a router bounce.
  try {
    if (existsSync(THOUGHT_SIGNATURE_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(THOUGHT_SIGNATURE_CACHE_PATH, 'utf8'));
      const now = Date.now();
      for (const [id, entry] of Object.entries(raw || {})) {
        if (entry && entry.signature && entry.expiresAt > now) {
          thoughtSignatureCache.set(id, { signature: entry.signature, expiresAt: entry.expiresAt });
        }
      }
    }
  } catch {
    /* start with an empty cache */
  }

  function persistThoughtSignatures() {
    try {
      const out = {};
      for (const [id, entry] of thoughtSignatureCache) out[id] = entry;
      writeFileSync(THOUGHT_SIGNATURE_CACHE_PATH, JSON.stringify(out), { mode: 0o600 });
    } catch {
      /* silently fail */
    }
  }

  function captureThoughtSignatures(toolCalls, providerKey) {
    if (providerKey !== GOOGLEAI_PROVIDER_KEY || !Array.isArray(toolCalls)) return;
    const now = Date.now();
    let added = false;
    for (const tc of toolCalls) {
      const id = tc?.id;
      // Gemini OpenAI-compat responses nest thought_signature under
      // extra_content.google. Tolerate a top-level thought_signature too.
      const sig = tc?.extra_content?.google?.thought_signature || tc?.thought_signature;
      if (id && sig) {
        thoughtSignatureCache.set(id, { signature: sig, expiresAt: now + THOUGHT_SIGNATURE_CACHE_TTL_MS });
        added = true;
      }
    }
    // Evict expired entries opportunistically
    if (thoughtSignatureCache.size > 200) {
      for (const [key, entry] of thoughtSignatureCache) {
        if (entry.expiresAt <= now) thoughtSignatureCache.delete(key);
      }
    }
    if (added) persistThoughtSignatures();
  }

  /**
   * Google's thinking models require a thought_signature on every Gemini-generated
   * function call part when the request continues a tool turn (i.e. ends with a
   * tool result). If we can't supply one, Google rejects the request with a 400.
   * Foreign tool calls (UUIDs / client ids from other providers) are not validated.
   */
  function isGoogleAiRequestCompatible(body) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return true;
    const last = messages[messages.length - 1];
    if (last?.role !== 'tool') return true; // no tool-turn continuation -> no validation
    for (const msg of messages) {
      if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
      for (const tc of msg.tool_calls) {
        if (!tc?.id || typeof tc.id !== 'string') continue;
        if (tc.extra_content?.google?.thought_signature || tc.thought_signature) continue;
        // Gemini generates call_-prefixed ids; other providers use UUIDs or client
        // ids that Google does not validate.
        if (tc.id.startsWith('call_') && !thoughtSignatureCache.has(tc.id)) {
          return false;
        }
      }
    }
    return true;
  }

  function injectThoughtSignatures(body, providerKey) {
    if (providerKey !== GOOGLEAI_PROVIDER_KEY || !body?.messages) return body;
    let modified = false;
    const messages = body.messages.map(msg => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) return msg;
      let msgModified = false;
      const toolCalls = msg.tool_calls.map(tc => {
        const cached = tc.id ? thoughtSignatureCache.get(tc.id) : null;
        if (!cached || tc.extra_content?.google?.thought_signature || tc.thought_signature) return tc;
        msgModified = true;
        return {
          ...tc,
          extra_content: {
            ...(tc.extra_content || {}),
            google: {
              ...(tc.extra_content?.google || {}),
              thought_signature: cached.signature,
            },
          },
        };
      });
      if (msgModified) modified = true;
      return msgModified ? { ...msg, tool_calls: toolCalls } : msg;
    });
    return modified ? { ...body, messages } : body;
  }

  // Everything a provider must not see, in one place.
  //
  // `learnedFieldStrips` is server-lifetime memory of what each upstream has refused.
  // A provider that rejects a field once gets that field removed from every later
  // request, so the healing round trip is paid at most once per provider instead of on
  // every turn of a conversation that keeps replaying the same residue.
  //
  // This supersedes the two hand-written strippers (reasoning_details, thinking
  // blocks): those covered exactly what one previous backend happened to emit, while
  // this covers every reasoning field plus whatever a given upstream turns out to
  // refuse — Groq's rejection of `reasoning_content` being the case that proved it.
  const learnedFieldStrips = createLearnedStrips();

  // The single outbound sanitizer, shared by every attempt path so the initial request
  // and the fallback-key retry can never drift apart. Thought signatures go back in
  // first: they are tool wiring Google requires, not residue to drop.
  function sanitizeOutboundPayload(body, providerKey) {
    const withSignatures = injectThoughtSignatures(body, providerKey);
    return sanitizeProviderPayload(withSignatures, providerKey, learnedFieldStrips);
  }

  const currentConfigLoader = loadConfig();
  if (currentConfigLoader.bannedModels && currentConfigLoader.bannedModels.length > 0) {
    bannedModels = [...new Set([...bannedModels, ...currentConfigLoader.bannedModels])];
  }

  if (bannedModels.length > 0) {
    console.log(chalk.yellow(`  🚫 Banned models: ${bannedModels.join(', ')}`));
  }
  if (!enableLog) {
    startupLogLine(chalk.dim(`  📝 Request terminal logging disabled`));
  }


  const toResultRow = ([modelId, label, intell, ctx, providerKey, ctxSource = null, ctxSourceUrl = null], index, isEstimatedScoreOverride = null, origin = null) => {
    const hasScore = intell != null;
    return {
      idx: index + 1,
      modelId,
      label: getPreferredModelLabel(modelId, label),
      intell: hasScore ? intell : null,
      isEstimatedScore: isEstimatedScoreOverride ?? !hasScore,
      qualitySource: hasScore ? 'local-fallback' : 'default-fallback',
      qualityDetail: hasScore ? 'scores.js offline fallback' : 'no catalog or local score',
      ctx,
      ctxSource,
      ctxSourceUrl,
      providerKey,
      // The upstream origin this row was discovered behind, when its catalog names one
      // (see resolveDiscoveredOrigin). Null for every provider that does not federate,
      // which is every one of them but g4f today.
      originId: origin?.originId || null,
      originLabel: origin?.originLabel || null,
      // Name-based rule: a model whose id names something other than a general chat model
      // (see isBlockedModelName, which owns the list) is pinned incompatible from birth so it
      // never appears up or routable, whatever its probes return.
      // A row nothing has answered for is Down, not 'pending': the Status column is a slave
      // of the response column, so an untested row reads as Down until a test or live traffic
      // fills that column in. The startup restore and /api/models then re-derive it from the
      // persisted last response, so a restart never renders a ready row as Down.
      status: isBlockedModelName(modelId) ? 'incompatible' : 'down',
      pings: [],
      httpCode: null,
      hidden: false,
      lastModelResponseAt: 0,
      lastPingAt: 0,
    };
  };

  // The origin a discovered meta carries, in the form toResultRow takes. Null rather than
  // an empty object so a row created from a meta without one is indistinguishable from a
  // row of a provider that never had the concept.
  const originOfMeta = (meta) => (meta && meta.originId ? { originId: meta.originId, originLabel: meta.originLabel || null } : null);

  // Origin labels learned per provider (originId → the name its catalog gives it), kept so a
  // roster row learned later from a backend's own refusal can label itself the same way.
  const discoverableOriginLabels = new Map();

  /**
   * Names every origin a federated catalog reports, resolving labels that collide. Two of
   * g4f's upstream servers both call themselves "qwen", and the label is what the table row
   * and the network plot's node are read by, so a collision gets the server id's tail to
   * tell them apart — grown until the tails actually differ, because a fixed four characters
   * can collide too (`srv_a000000000` and `srv_b000000000` share one), which would print two
   * nodes with the same name. Identity is untouched either way: it stays the full server id.
   * Returns the same metas, so a caller can use the result in place of its argument.
   */
  const labelOrigins = (providerKey, models) => {
    const idsByLabel = new Map();
    for (const model of models) {
      if (!model?.originId || !model.originLabel) continue;
      const key = model.originLabel.toLowerCase();
      if (!idsByLabel.has(key)) idsByLabel.set(key, new Set());
      idsByLabel.get(key).add(model.originId);
    }
    const suffixById = new Map();
    for (const ids of idsByLabel.values()) {
      if (ids.size <= 1) continue;
      const list = [...ids];
      let length = 4;
      while (length < 40 && new Set(list.map(id => String(id).slice(-length))).size < list.length) length += 1;
      for (const id of list) suffixById.set(id, String(id).slice(-length));
    }
    const labels = new Map();
    for (const model of models) {
      if (!model?.originId) continue;
      const suffix = suffixById.get(model.originId);
      const disambiguated = suffix ? `${model.originLabel} · ${suffix}` : (model.originLabel || null);
      labels.set(model.originId, disambiguated);
      model.originLabel = disambiguated;
    }
    discoverableOriginLabels.set(providerKey, labels);
    return models;
  };

  /**
   * How a benched scope reads in a log line — "G4F · nvidia.com" for one of a gateway's
   * origins, the plain provider key otherwise. Same words the dashboard's row uses, so an
   * origin's outage can be matched between the two.
   */
  const describeProviderScope = (scopeKey) => {
    const key = String(scopeKey || '');
    const sep = key.indexOf(':');
    if (sep <= 0) return key;
    const label = discoverableOriginLabels.get(key.slice(0, sep))?.get(key.slice(sep + 1));
    if (!label) return key;
    return `${sources[key.slice(0, sep)]?.name || key.slice(0, sep)} · ${label}`;
  };

  // A provider that cannot authenticate contributes no rows at all (see providerCanServe).
  // This filters the *declared* catalogs too, not only the discovered ones: twelve GitHub
  // Copilot rows, five Codex rows and two Kiro rows used to be seeded here out of `sources.js`
  // whether or not anything was configured, and every one of them answered NO_KEY. MODELS rows
  // are positional — [modelId, label, intell, ctx, providerKey, ...] — so index 4 is the key.
  const bootConfig = loadConfig();
  let results = MODELS
    .filter(row => providerCanServe(bootConfig, row[4]))
    .map((row, i) => toResultRow(row, i));
  let qualityData = null;
  let lastQualityRefreshAt = 0;
  let lastKiloCodeModelRefreshAt = 0;
  let lastOllamaModelRefreshAt = 0;
  let lastOpenRouterModelRefreshAt = 0;
  let lastEmperoModelRefreshAt = 0;
  let lastDevinModelRefreshAt = 0;
  let lastCopilotModelRefreshAt = 0;
  let lastCodexModelRefreshAt = 0;
  const lastOpenAICompatibleDiscoveryAt = new Map();
  const lastDiscoverableProviderDiscoveryAt = new Map();
  const staticProviderModelIds = new Map(
    Object.entries(sources).map(([providerKey, source]) => [providerKey, new Set(source.models.map(([modelId]) => modelId))])
  );
  const discoveredProviderModelIds = new Map();

  const reindexResults = () => {
    for (let i = 0; i < results.length; i += 1) {
      results[i].idx = i + 1;
    }
  };

  const applyQualityScores = () => {
    for (const result of results) {
      // Score the row by the backend that actually answers it (see
      // resolveQualityLookup): a persona relay's intelligence is its backend's.
      const usageEntry = usageStats.get(`${result.providerKey}::${result.modelId}`);
      const { lookupId, localScore } = resolveQualityLookup(result.modelId, usageEntry?.resolvedModelId);
      const quality = resolveModelQuality(qualityData, lookupId, localScore);
      // The row's 0-1 quality position, which is what QoS percentile-ranks against the
      // curated reference distribution, what minSweScore thresholds, and what every
      // ordering sorts on. It is the same number as the `aa` index below, read back
      // through the measured distribution (see scoreForAa), so the table cannot sort
      // a 30-point estimate above a 50-point measurement.
      result.intell = quality.score;
      result.isEstimatedScore = quality.isEstimated;
      result.qualitySource = quality.source;
      result.qualityDetail = quality.detail;
      // The Artificial Analysis Intelligence Index this row is ranked on: AA's own
      // rating, or the one interpolated from an Elo where AA has none. One decimal,
      // matching AA's own precision.
      result.aa = Number.isFinite(quality.aa) ? Number(quality.aa.toFixed(1)) : null;
    }
  };

  // The selector's slope and intelligence floor live in the units of the dashboard's
  // intelligence axis, which used to be LMArena Elo and is now the Artificial Analysis
  // Intelligence Index. A config written before the change therefore holds numbers
  // that cannot be read on the new axis at all — an Elo floor of ~1400 excludes every
  // model scored out of 100, and the slope is off by the same factor. Convert them
  // once, using the same AA-from-Elo mapping an Elo-only model is scored with, and
  // record the scale so it never happens again. Nothing is converted while the
  // regression is unknown; the next call retries.
  const effectiveSelectorSettings = (config = loadConfig()) => {
    const sel = config.selector || {};
    const current = { slope: sel.slope ?? null, minSpeed: sel.minSpeed ?? null, minIntell: sel.minIntell ?? null };
    if (sel.intellScale === 'aa') return current;
    const converted = convertSelectorToAaScale(sel, qualityData?.aaFromEloRegression);
    if (!converted) return current;
    saveConfig({ ...config, selector: { ...sel, ...converted } });
    console.log(chalk.dim('  📐 Selector settings converted from the Elo scale to the Artificial Analysis scale'));
    return { slope: converted.slope ?? null, minSpeed: converted.minSpeed ?? null, minIntell: converted.minIntell ?? null };
  };

  const refreshQualityScores = async (force = false) => {
    if (!force && qualityData && (Date.now() - lastQualityRefreshAt) < MODEL_QUALITY_CACHE_MS) return qualityData;
    qualityData = await fetchOpenRouterQualityIndex({ force });
    lastQualityRefreshAt = Date.now();
    applyQualityScores();
    return qualityData;
  };

  const mergeDynamicProviderModels = (providerKey, models) => {
    const byModelId = new Map(
      results
        .filter(r => r.providerKey === providerKey)
        .map(r => [r.modelId, r])
    );

    results = results.filter(r => r.providerKey !== providerKey);

    // Nothing to merge for a provider that cannot authenticate: every row would be one that
    // dispatch refuses with NO_KEY, which is capability on paper. The rows just removed stay
    // removed — that is also how signing *out* takes effect, since the refresh that follows
    // merges its catalog and lands here. The reason is recorded so a refresh returning nothing
    // explains itself instead of looking like a provider whose list came back empty.
    if (!providerCanServe(loadConfig(), providerKey)) {
      noteDiscoveryOutcome(providerKey, 'needs-key',
        'no credential configured, so its models are not listed — add one in this provider\'s settings');
      reindexResults();
      return;
    }

    for (const model of models) {
      const existing = byModelId.get(model.modelId);
      if (existing) {
        existing.label = getPreferredModelLabel(model.modelId, model.label);
        existing.intell = model.intell;
        existing.isEstimatedScore = model.isEstimatedScore;
        existing.ctx = model.ctx;
        existing.ctxSource = model.ctxSource;
        existing.ctxSourceUrl = model.ctxSourceUrl;
        // Discovery is authoritative for a catalog row, its origin included: a model that
        // moved upstream is a different row (its id carries the other namespace), and a
        // gateway that stopped federating loses the origin rather than keeping a stale one
        // that would draw the row under an upstream no longer serving it.
        existing.originId = model.originId || null;
        existing.originLabel = model.originLabel || null;
        results.push(existing);
      } else {
        results.push(toResultRow([
          model.modelId,
          model.label,
          model.intell,
          model.ctx,
          providerKey,
          model.ctxSource,
          model.ctxSourceUrl,
        ], results.length, model.isEstimatedScore, originOfMeta(model)));
      }
    }

    reindexResults();
    // This merge replaces the provider's rows wholesale, so anything learned from the
    // backend itself has to be restored around it.
    reapplyLearnedServerRoster(providerKey);
    applyQualityScores();
  };

  // Keep the curated catalog intact when a provider's discovery endpoint is
  // incomplete, while replacing only rows that a previous discovery added.
  const mergeDiscoverableProviderModels = (providerKey, models) => {
    const staticIds = staticProviderModelIds.get(providerKey) || new Set();
    const providerRows = results.filter(result => result.providerKey === providerKey);
    const existingById = new Map(providerRows.map(result => [result.modelId, result]));
    const retainedRows = pruneDiscoverableRows(
      providerRows,
      staticIds,
      models,
      sources[providerKey]?.keepStaticOnDiscovery === true
    );
    const pruned = providerRows.filter(row => !retainedRows.includes(row));
    if (pruned.length > 0) {
      // Report the count only: the per-model list is dozens of ids on a large
      // catalog and buries the rest of the startup output.
      startupLog(chalk.dim(`  [${sources[providerKey]?.name || providerKey}] Pruned ${pruned.length} model(s) no longer in /v1/models`));
    }
    const retainedById = new Map(retainedRows.map(result => [result.modelId, result]));

    const updateRow = (row, model) => {
      row.label = getPreferredModelLabel(model.modelId, model.label);
      row.intell = model.intell;
      row.isEstimatedScore = model.isEstimatedScore;
      row.ctx = model.ctx;
      row.ctxSource = model.ctxSource;
      row.ctxSourceUrl = model.ctxSourceUrl;
      row.providerUrl = model.providerUrl || row.providerUrl;
      // Same rule as mergeDynamicProviderModels: the live catalog decides where a row's
      // requests go, so it decides which upstream the row is shown as.
      row.originId = model.originId || null;
      row.originLabel = model.originLabel || null;
      return row;
    };

    for (const model of models) {
      const existing = retainedById.get(model.modelId) || existingById.get(model.modelId);
      if (existing) {
        const updated = updateRow(existing, model);
        if (!retainedById.has(model.modelId)) retainedRows.push(updated);
      } else {
        retainedRows.push(toResultRow([
          model.modelId,
          model.label,
          model.intell,
          model.ctx,
          providerKey,
          model.ctxSource,
          model.ctxSourceUrl,
        ], results.length, model.isEstimatedScore, originOfMeta(model)));
      }
    }

    results = results.filter(result => result.providerKey !== providerKey);
    results.push(...retainedRows);
    discoveredProviderModelIds.set(providerKey, new Set(models.map(model => model.modelId).filter(modelId => !staticIds.has(modelId))));
    reindexResults();
    // Discovery mirrors the gateway catalog exactly, which cannot know about a model a
    // backend later said it serves, so restore what was learned from the backend.
    reapplyLearnedServerRoster(providerKey);
    applyQualityScores();
  };

  // Rows learned from a backend's own refusal rather than from discovery, keyed by
  // provider. Discovery mirrors the gateway catalog exactly, so these would be pruned
  // on the next refresh; keeping the metas lets them be re-added unchanged.
  const learnedServerModels = new Map();

  const addProviderModelRows = (providerKey, metas) => {
    // The same gate as every other row source. A learned roster names real models, but a name
    // is not a credential: without one these rows would be listed and refuse to answer.
    if (!providerCanServe(loadConfig(), providerKey)) return [];
    const present = new Set(results.filter(result => result.providerKey === providerKey).map(result => result.modelId));
    const added = [];
    for (const meta of metas) {
      if (!meta || present.has(meta.modelId)) continue;
      present.add(meta.modelId);
      results.push(toResultRow([
        meta.modelId,
        meta.label,
        meta.intell,
        meta.ctx,
        providerKey,
        meta.ctxSource,
        meta.ctxSourceUrl,
      ], results.length, meta.isEstimatedScore, originOfMeta(meta)));
      added.push(meta.modelId);
    }
    if (added.length > 0) {
      reindexResults();
      applyQualityScores();
    }
    return added;
  };

  // A gateway can refuse a model for one backend while naming the roster that backend
  // does have ("Model 'x' is not allowed on this server. Allowed: ..."). The gateway's
  // own catalog is chat-only and goes stale per server, and it exposes no per-server
  // models endpoint, so that refusal is the only authoritative roster we can observe.
  // Learn the chat models from it, so a backend that offers something the catalog omits
  // becomes usable instead of staying invisible behind an error.
  const learnServerRoster = (result, errorText) => {
    if (!result) return;
    const allowed = parseAllowedModelNamesFromRefusal(errorText);
    if (allowed.length === 0) return;

    const providerKey = result.providerKey;
    const catalogIds = results.filter(row => row.providerKey === providerKey).map(row => row.modelId);
    // A per-server entry keeps the backend's namespace, so the learned row is
    // requested from the backend that said it has it.
    const requestedId = String(result.modelId || '');
    const colon = requestedId.indexOf(':');
    const namespace = colon > 0 ? requestedId.slice(0, colon + 1) : '';
    const known = learnedServerModels.get(providerKey) || new Map();
    // A roster learned from this backend's own refusal belongs to that backend, so the row
    // carries the same origin as the rest of its models and lands on the same dashboard
    // node, instead of reading as a second, unlabelled bucket of the gateway.
    const originId = namespace ? namespace.slice(0, -1) : null;
    const originLabel = originId ? (discoverableOriginLabels.get(providerKey)?.get(originId) || null) : null;

    for (const name of allowed) {
      const modelId = `${namespace}${name}`;
      if (catalogIds.includes(modelId) || known.has(modelId)) continue;
      // Names the gateway's chat catalog does not carry are the speech/image models a
      // backend also runs; surfacing those as chat rows would offer models that cannot
      // answer. The meta builder applies the chat-compatibility filter too.
      if (!isKnownChatModelName(name, catalogIds)) continue;
      const meta = toOpenAICompatibleDiscoveredModelMeta({ id: name, model: name }, providerKey, result.providerUrl);
      if (!meta) continue;
      known.set(modelId, originId ? { ...meta, modelId, originId, originLabel } : { ...meta, modelId });
    }

    if (known.size === 0) return;
    learnedServerModels.set(providerKey, known);
    const added = addProviderModelRows(providerKey, [...known.values()]);
    if (added.length > 0) {
      startupVerboseLog(chalk.dim(`  [${sources[providerKey]?.name || providerKey}] Server ${namespace || providerKey} also serves: ${added.join(', ')}`));
    }
  };

  const reapplyLearnedServerRoster = (providerKey) => {
    const learned = learnedServerModels.get(providerKey);
    if (!learned || learned.size === 0) return;
    addProviderModelRows(providerKey, [...learned.values()]);
  };

  const refreshKiloCodeModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastKiloCodeModelRefreshAt) < KILOCODE_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, KILOCODE_PROVIDER_KEY)) {
        mergeDynamicProviderModels(KILOCODE_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchKiloCodeFreeModels(currentConfig);
      mergeDynamicProviderModels(KILOCODE_PROVIDER_KEY, models);
      lastKiloCodeModelRefreshAt = Date.now();
      return models;
    } catch (err) {
      skipLog(`[KiloCode] Model sync skipped: ${describeSyncError(err)}`);
      lastKiloCodeModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), KILOCODE_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      throw err;
    }
  };

  // Curated fallback rows, always visible so the provider is usable before the
  // first successful discovery (and when no session token is configured).
  const devinFallbackModelRows = () => DEVIN_MODELS.map(([modelId, label, ctx]) => ({
    modelId,
    label,
    intell: null,
    isEstimatedScore: true,
    ctx,
    ctxSource: 'curated',
    ctxSourceUrl: 'https://devin.ai/',
    providerKey: DEVIN_PROVIDER_KEY,
  }));

  const refreshDevinModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastDevinModelRefreshAt) < DEVIN_MODELS_REFRESH_MS) {
      return results.filter(r => r.providerKey === DEVIN_PROVIDER_KEY).map(r => ({ modelId: r.modelId, label: r.label }));
    }
    const fallbackRows = devinFallbackModelRows();
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, DEVIN_PROVIDER_KEY)) {
        mergeDynamicProviderModels(DEVIN_PROVIDER_KEY, []);
        return [];
      }
      const token = (await resolveProviderAuthToken(currentConfig, DEVIN_PROVIDER_KEY)).token;
      if (!token) {
        // No session token yet. The curated rows used to be merged in here so the provider
        // looked usable before anyone signed in, which is what put unroutable rows in the
        // table with an auth error on each one. A row hammer cannot dispatch is not a preview
        // of the provider: the merge still removes whatever this account left behind, and the
        // credential gate inside it refuses to add more.
        mergeDynamicProviderModels(DEVIN_PROVIDER_KEY, []);
        lastDevinModelRefreshAt = now;
        return [];
      }
      const configs = await fetchDevinModelConfigs(token, { signal: AbortSignal.timeout(UPSTREAM_HEADERS_TIMEOUT_MS) });
      const enabled = configs.filter(c => !c.disabled);
      if (enabled.length === 0) throw new Error('gateway returned no enabled models for this account');
      const seenUids = new Set();
      const discoveredRows = enabled.map(c => {
        seenUids.add(c.uid);
        return {
          modelId: c.uid,
          label: (c.label || c.uid).replace(/\s*\bMax\b\s*$/i, '').trim() || c.uid,
          intell: null,
          isEstimatedScore: true,
          ctx: c.maxTokens > 0 ? `${Math.round(c.maxTokens / 1000)}k` : '128k',
          ctxSource: 'discovered',
          ctxSourceUrl: 'https://devin.ai/',
          providerKey: DEVIN_PROVIDER_KEY,
        };
      });
      // Keep curated rows the gateway didn't mention at all so clients
      // configured against them keep resolving. Models the gateway *does*
      // report (even as disabled=1) are deliberately dropped: the account
      // has no auth/entitlement for them, so listing them only produces
      // permission_denied errors.
      const merged = [...discoveredRows, ...fallbackRows.filter(m => !seenUids.has(devinChatModelUid(m.modelId)))];
      mergeDynamicProviderModels(DEVIN_PROVIDER_KEY, merged);
      lastDevinModelRefreshAt = Date.now();
      return merged;
    } catch (err) {
      // Discovery must never blank the provider: fall back to curated rows.
      mergeDynamicProviderModels(DEVIN_PROVIDER_KEY, fallbackRows);
      skipLog(`[Devin] Model sync skipped: ${describeSyncError(err)}`);
      lastDevinModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), DEVIN_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      return fallbackRows;
    }
  };

  const refreshEmperoModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastEmperoModelRefreshAt) < EMPERO_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, EMPERO_PROVIDER_KEY)) {
        mergeDynamicProviderModels(EMPERO_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchEmperoModels(currentConfig);
      mergeDynamicProviderModels(EMPERO_PROVIDER_KEY, models);
      lastEmperoModelRefreshAt = Date.now();
      return models;
    } catch (err) {
      skipLog(`[Empero Free] Model sync skipped: ${describeSyncError(err)}`);
      lastEmperoModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), EMPERO_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      throw err;
    }
  };

  const refreshOpenRouterModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastOpenRouterModelRefreshAt) < OPENROUTER_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, OPENROUTER_PROVIDER_KEY)) {
        mergeDynamicProviderModels(OPENROUTER_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchOpenRouterFreeModels(currentConfig);
      mergeDynamicProviderModels(OPENROUTER_PROVIDER_KEY, models);
      lastOpenRouterModelRefreshAt = Date.now();
      return models;
    } catch (err) {
      skipLog(`[OpenRouter] Model sync skipped: ${describeSyncError(err)}`);
      lastOpenRouterModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), OPENROUTER_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      throw err;
    }
  };

  const refreshOpenAICompatibleModels = async (onlyInstanceKey = null, force = false) => {
    const currentConfig = loadConfig();
    const endpoints = listOpenAICompatibleEndpoints(currentConfig);
    const instanceKeys = new Set(endpoints.map(e => e.instanceKey));

    // Drop result rows for instances that no longer exist.
    const orphaned = new Set(
      results
        .filter(r => isOpenAICompatibleInstanceKey(r.providerKey) && !instanceKeys.has(r.providerKey))
        .map(r => r.providerKey)
    );
    for (const ok of orphaned) {
      mergeDynamicProviderModels(ok, []);
      lastOpenAICompatibleDiscoveryAt.delete(ok);
    }

    const refreshed = [];
    const now = Date.now();
    for (const ep of endpoints) {
      if (onlyInstanceKey && ep.instanceKey !== onlyInstanceKey) continue;
      if (!ep.enabled) {
        mergeDynamicProviderModels(ep.instanceKey, []);
        continue;
      }

      const fallbackModel = buildOpenAICompatibleModelMeta(currentConfig, ep.instanceKey);
      const discoveryEnabled = isOpenAICompatibleDiscoveryEnabled(currentConfig, ep.instanceKey);
      const lastDiscoveredAt = lastOpenAICompatibleDiscoveryAt.get(ep.instanceKey) || 0;
      const ttlExpired = (now - lastDiscoveredAt) >= OPENAI_COMPATIBLE_MODELS_REFRESH_MS;
      const shouldDiscover = discoveryEnabled && (force || ttlExpired);

      let discovered = [];
      if (shouldDiscover) {
        try {
          discovered = await fetchOpenAICompatibleDiscoveredModels(currentConfig, ep.instanceKey);
          lastOpenAICompatibleDiscoveryAt.set(ep.instanceKey, Date.now());
        } catch (err) {
          skipLog(`[OpenAI-Compatible:${ep.id}] Model discovery skipped: ${describeSyncError(err)}`);
        }
      } else if (discoveryEnabled) {
        // 📖 Within the TTL window: keep the previously-discovered rows visible
        // 📖 instead of dropping them when this refresh path was just a ping cycle.
        discovered = results
          .filter(r => r.providerKey === ep.instanceKey)
          .map(r => ({
            modelId: r.modelId,
            label: r.label,
            intell: r.intell,
            isEstimatedScore: r.isEstimatedScore,
            ctx: r.ctx,
            ctxSource: r.ctxSource,
            ctxSourceUrl: r.ctxSourceUrl,
            providerKey: ep.instanceKey,
            providerUrl: r.providerUrl,
          }));
      }

      // Merge fallback (manually-configured modelId) with discovered list, de-duped.
      const merged = fallbackModel
        ? [fallbackModel, ...discovered.filter(m => m.modelId !== fallbackModel.modelId)]
        : discovered;
      mergeDynamicProviderModels(ep.instanceKey, merged);
      refreshed.push(...merged);
    }
    return refreshed;
  };

  const refreshOllamaModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastOllamaModelRefreshAt) < OLLAMA_MODELS_REFRESH_MS) return;

    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, OLLAMA_PROVIDER_KEY)) {
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, []);
      lastOllamaModelRefreshAt = Date.now();
      return [];
    }

    // Ollama's catalog is public where its chat path is not. `GET /api/tags` on the hosted
    // default answers 200 to an anonymous caller with the whole Ollama Cloud roster, so
    // reading it imports rows whose every dispatch is refused as NO_KEY — capability on paper
    // only. The gate is the same decision dispatch makes (see
    // `providerDiscoveryNeedsCredential`), so the two cannot disagree about whether this
    // provider is usable: with no key the list is not read at all, and it starts being read
    // again the moment a key is configured or the base URL points at a local Ollama, which
    // needs none. Evaluated on every call rather than latched, so adding a key takes effect on
    // the next refresh without a restart.
    if (providerDiscoveryNeedsCredential(currentConfig, OLLAMA_PROVIDER_KEY)) {
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, []);
      noteDiscoveryOutcome(OLLAMA_PROVIDER_KEY, 'needs-key',
        'no OLLAMA_API_KEY configured, and a blank base URL means hosted Ollama — whose chat endpoint needs a key, so reading its list would only add rows that cannot answer');
      lastOllamaModelRefreshAt = Date.now();
      return [];
    }

    try {
      const discovered = await fetchOllamaModels(currentConfig);
      const fallbackModel = buildOllamaModelMeta(currentConfig);
      const models = fallbackModel
        ? [fallbackModel, ...discovered.filter(m => m.modelId !== fallbackModel.modelId)]
        : discovered;
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, models);
      lastOllamaModelRefreshAt = Date.now();
      return models;
    } catch (err) {
      const fallbackModel = buildOllamaModelMeta(currentConfig);
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, fallbackModel ? [fallbackModel] : []);
      skipLog(`[Ollama] Model sync skipped: ${describeSyncError(err)}`);
      lastOllamaModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), OLLAMA_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      throw err;
    }
  };

  // Discoverable providers whose /v1/models probe refused because no credential was
  // configured. The answer can't change until a key exists, so asking again every
  // refresh cycle only buys a repeated 401 in the log. Deliberately reactive rather
  // than a "no key configured" pre-check: some catalogs are meant to be keyless (the
  // g4f relays only raise per-day limits when a key is present), so the probe itself
  // decides — a provider that answers never lands here.
  const discoveryAuthRequired = new Set();

  // Why a provider's model list is empty, which a bare "0 models" cannot say. Five different
  // situations all render as zero rows — never probed yet, missing a credential field the URL
  // template needs, refused because no key was configured, upstream failed, or upstream really
  // listed nothing usable — and the difference decides whether the user's move is to wait, to
  // fill in a setting, to add a key, or to do nothing. `state` is the machine-readable half;
  // `note` is the sentence the dashboard shows verbatim, the provider's own words where it
  // gave any.
  const modelDiscoveryOutcomes = new Map();
  const noteDiscoveryOutcome = (providerKey, state, note = null, extra = {}) => {
    modelDiscoveryOutcomes.set(providerKey, {
      state,
      note,
      checkedAt: new Date().toISOString(),
      ...extra,
    });
  };

  const refreshDiscoverableProviderModels = async (providerKey, force = false) => {
    const source = sources[providerKey];
    if (!source || !source.discoverable) return [];

    const now = Date.now();
    const lastAt = lastDiscoverableProviderDiscoveryAt.get(providerKey) || 0;
    if (!force && (now - lastAt) < DISCOVERABLE_PROVIDER_MODELS_REFRESH_MS) return [];

    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, providerKey)) {
      noteDiscoveryOutcome(providerKey, 'disabled', 'provider is disabled in the config');
      lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
      return [];
    }

    const apiKey = getApiKey(currentConfig, providerKey);
    if (apiKey) {
      // A key showed up (config or env) — whatever we concluded before is stale.
      discoveryAuthRequired.delete(providerKey);
    } else if (discoveryAuthRequired.has(providerKey) && !force) {
      // Known to need a credential we don't have. An explicit refresh still re-probes,
      // so a key added outside the config file is picked up without a restart.
      noteDiscoveryOutcome(providerKey, 'needs-key',
        `no credential configured, and ${source.name} refuses its list without one`);
      lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
      return [];
    }

    // The URL the model list is read from. A configured base URL — G4F_BASE_URL, or a
    // `baseUrl` on the provider — redirects the provider's *traffic*, and discovery has to
    // follow it for the same reason: reading the default catalog while the rows are served
    // from somewhere else would label them with the origins of a server that never answers
    // them. Otherwise a provider's own declared `modelsUrl` wins over the sibling of its
    // chat path, because some publish their list somewhere else entirely.
    const baseUrlOverride = getProviderBaseUrl(currentConfig, providerKey);
    // A provider's endpoint can be a template that embeds credential fields — Cloudflare's
    // account id, Vertex's project and region — so discovery resolves it the same way a chat
    // request does. Without this the probe fetches a literal `.../accounts/{accountId}/...`,
    // which makes a provider that is merely unconfigured look permanently empty instead. A
    // configured base URL is the operator's own answer and wins, exactly as it does for
    // traffic, so the template is only consulted when there is none.
    const shapedChat = baseUrlOverride
      ? { url: baseUrlOverride, missing: [] }
      : resolveShapedChatUrl(currentConfig, providerKey, source.url);
    if (shapedChat.missing.length > 0) {
      // Wired but unconfigured: a chat request cannot succeed yet either, and re-probing a
      // gap only configuration can close is exactly the repeated noise these caches exist to
      // avoid. The reason logged is the same one the dashboard shows for the provider.
      const readiness = shapingReadiness(currentConfig, providerKey)
        || `needs ${shapedChat.missing.join(' and ')} before its list URL exists`;
      noteDiscoveryOutcome(providerKey, 'needs-config', readiness, { missingFields: shapedChat.missing });
      skipLog(`[${source.name}] Model discovery skipped: ${readiness}`);
      lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
      return [];
    }
    // A declared model list can be a template too — Cloudflare serves its list per account —
    // so it takes the same substitution. A configured base URL still wins over both, because
    // it is the source of truth for where this provider answers.
    const declaredModelsUrl = baseUrlOverride
      ? null
      : substituteCredentialFields(currentConfig, providerKey, source.modelsUrl).url;
    const chatUrl = shapedChat.url.replace(/\/chat\/completions$/, '');
    const modelsUrl = resolveDiscoveryModelsUrl({ url: chatUrl, modelsUrl: declaredModelsUrl }, baseUrlOverride);
    if (!modelsUrl) {
      noteDiscoveryOutcome(providerKey, 'unavailable',
        'no model-list URL: the provider publishes none and none can be derived from its chat URL');
      lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
      return [];
    }

    let httpStatus = null;
    try {
      const headers = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
      let models;
      try {
        const response = await fetch(modelsUrl, { method: 'GET', headers, signal: ctrl.signal });
        httpStatus = response.status;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const records = extractOpenAICompatibleModelRecords(payload);
        const seen = new Set();
        models = [];
        for (const record of records) {
          const model = toOpenAICompatibleDiscoveredModelMeta(record, providerKey, chatUrl);
          if (!model || seen.has(model.modelId)) continue;
          seen.add(model.modelId);
          models.push(model);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (models.length === 0) {
        noteDiscoveryOutcome(providerKey, 'empty',
          `${source.name} answered its model list, but nothing in it is servable as chat`);
        skipLog(`[${source.name}] No models discovered via /v1/models, keeping hardcoded list`);
        lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
        return [];
      }

      // Name the origins before anything reads them: the rows below, the dashboard that
      // groups them, and any roster row learned later all read the same label.
      mergeDiscoverableProviderModels(providerKey, labelOrigins(providerKey, models));
      noteDiscoveryOutcome(providerKey, 'ok', null, { modelCount: models.length });
      startupLog(chalk.green(`  ✓ [${source.name}] Discovered ${models.length} models via /v1/models`));
      lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
      return models;
    } catch (err) {
      // Refused with no credential sent: this provider gates its catalog behind auth
      // that isn't set up. Say so once, then stop probing until a key appears.
      if (isDiscoverableProbeAuthRefusal({ apiKey, httpStatus })) {
        discoveryAuthRequired.add(providerKey);
        noteDiscoveryOutcome(providerKey, 'needs-key',
          `no API key configured, and ${source.name} refuses its list without one (HTTP ${httpStatus})`);
        skipLog(`[${source.name}] Model discovery skipped: no API key configured (HTTP ${httpStatus}), using hardcoded list`);
        lastDiscoverableProviderDiscoveryAt.set(providerKey, Date.now());
        return [];
      }
      noteDiscoveryOutcome(providerKey, 'failed', describeSyncError(err));
      skipLog(`[${source.name}] Model discovery skipped: ${describeSyncError(err)}, using hardcoded list`);
      lastDiscoverableProviderDiscoveryAt.set(providerKey, computeFailedRefreshRetryAt(Date.now(), DISCOVERABLE_PROVIDER_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS));
      return [];
    }
  };

  /**
   * 📖 Lazy discovery, driven by the request that needs it.
   *
   * Imported providers carry `lazyDiscovery: true` so the boot wave never probes them. That
   * flag only removes network work; it does not make them reachable on its own, so this is
   * the other half of the decision: the first request that targets an unresolved provider
   * pays for its model list, and every later request reads the cached rows.
   *
   * Only providers that could actually answer are probed — keyless ones, or ones the user
   * has configured a key for. A provider that needs a credential it does not have cannot
   * serve the request anyway, so probing it would spend somebody else's quota to learn
   * nothing; it stays reachable through the explicit provider refresh. With an empty config
   * this is the one keyless import (uncloseai), not the whole catalog, so an unknown model id
   * cannot fan out into a fifty-request sweep.
   *
   * @param {string} requestedModel
   * @returns {Promise<number>} how many providers answered with a non-empty model list
   */
  const discoverLazyImportsForRequest = async (requestedModel) => {
    const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    if (!requested) return 0;
    const currentConfig = loadConfig();
    const providersWithRows = new Set(results.map(result => result.providerKey));
    const candidates = lazyDiscoveryCandidates(sources, providersWithRows, currentConfig, {
      isAuthOptional: isProviderAuthOptional,
      hasApiKey: getApiKey,
    });
    if (candidates.length === 0) return 0;

    console.log(chalk.dim(`  [Router] ⤓ Discovering ${candidates.length} unresolved imported provider(s) on demand for "${requested}"`));
    let discovered = 0;
    for (let i = 0; i < candidates.length; i += LAZY_DISCOVERY_CONCURRENCY) {
      const batch = candidates.slice(i, i + LAZY_DISCOVERY_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(key => refreshDiscoverableProviderModels(key, false)));
      discovered += settled.filter(result => result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0).length;
    }
    return discovered;
  };

  // GitHub Copilot's catalog comes from the Copilot API host with its own
  // identity headers, so it cannot ride the generic /v1/models discovery path.
  const refreshCopilotModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastCopilotModelRefreshAt) < COPILOT_MODELS_REFRESH_MS) return [];
    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, GITHUB_COPILOT_PROVIDER_KEY)) {
      mergeDynamicProviderModels(GITHUB_COPILOT_PROVIDER_KEY, []);
      lastCopilotModelRefreshAt = Date.now();
      return [];
    }
    const token = getCopilotConfiguredToken(currentConfig);
    if (!token) {
      // Not signed in yet — or signed out. The curated fallback rows used to be merged back
      // here so the provider was visible before the first sign-in, and that is exactly how
      // twelve unroutable GitHub Copilot rows came to sit in the table answering NO_KEY. They
      // are dropped instead. The merge is still what clears the account-specific rows a
      // previous token left behind, and the credential gate keeps it from adding any.
      mergeDynamicProviderModels(GITHUB_COPILOT_PROVIDER_KEY, []);
      lastCopilotModelRefreshAt = Date.now();
      return [];
    }
    try {
      const apiBaseUrl = await resolveCopilotApiBaseUrl(currentConfig);
      // Remember a plan-specific host so URL resolution stays synchronous.
      if (apiBaseUrl !== COPILOT_DEFAULT_API_BASE) {
        const providerConfig = ensureProviderConfig(currentConfig, GITHUB_COPILOT_PROVIDER_KEY);
        if (providerConfig.apiEndpoint !== apiBaseUrl) {
          providerConfig.apiEndpoint = apiBaseUrl;
          saveConfig(currentConfig);
        }
      }
      const models = await fetchGitHubCopilotModels(token, apiBaseUrl);
      if (models.length === 0) throw new Error('No chat models returned.');
      // Some plans gate Claude/Grok/GPT-5 rows until their model policy has been
      // accepted once. Doing it here rather than only at sign-in means a token
      // supplied by env var or pasted into config also ends up fully usable.
      const policiesEnabled = await enableGitHubCopilotModels(token, models.map(model => model.modelId), apiBaseUrl).catch(() => 0);
      mergeDynamicProviderModels(GITHUB_COPILOT_PROVIDER_KEY, models);
      lastCopilotModelRefreshAt = Date.now();
      startupLog(chalk.green(`  ✓ [GitHub Copilot] Discovered ${models.length} models via /models${policiesEnabled > 0 ? ` (accepted ${policiesEnabled} model policies)` : ''}`));
      return models;
    } catch (err) {
      skipLog(`[GitHub Copilot] Model sync skipped: ${describeSyncError(err)}, keeping fallback list`);
      lastCopilotModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), COPILOT_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      return [];
    }
  };

  // The Codex catalog is account-scoped (it reflects what the signed-in plan may
  // serve), so it comes from the account-authenticated backend rather than from the
  // generic /v1/models path. Rows the plan hides are dropped by the mapper.
  const refreshCodexModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastCodexModelRefreshAt) < CODEX_MODELS_REFRESH_MS) return [];
    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, OPENAI_CODEX_PROVIDER_KEY)) {
      mergeDynamicProviderModels(OPENAI_CODEX_PROVIDER_KEY, []);
      lastCodexModelRefreshAt = Date.now();
      return [];
    }
    if (!hasOpenAICodexAuthConfigured(currentConfig)) {
      // Not signed in yet — or signed out. The curated rows used to be merged back here; they
      // are unroutable without a token, so they are dropped instead, and the merge is still
      // what clears the rows a previous account left behind.
      mergeDynamicProviderModels(OPENAI_CODEX_PROVIDER_KEY, []);
      lastCodexModelRefreshAt = Date.now();
      return [];
    }
    try {
      const refreshToken = getProviderAccountSecrets(currentConfig, OPENAI_CODEX_PROVIDER_KEY)[0]
        || normalizeSecretValue(process.env.OPENAI_CODEX_REFRESH_TOKEN);
      const resolved = await resolveOpenAICodexAccessToken(refreshToken);
      const baseUrl = normalizeSecretValue(getProviderBaseUrl(currentConfig, OPENAI_CODEX_PROVIDER_KEY)) || CODEX_DEFAULT_BASE_URL;
      const records = await fetchOpenAICodexModels(resolved.accessToken, resolved.accountId, baseUrl, { signal: AbortSignal.timeout(UPSTREAM_HEADERS_TIMEOUT_MS) });
      const seen = new Set();
      const models = [];
      for (const record of records) {
        const model = toOpenAICodexModelMeta(record, baseUrl);
        if (!model || seen.has(model.modelId)) continue;
        seen.add(model.modelId);
        models.push(model);
      }
      if (models.length === 0) throw new Error('The account reported no usable chat models.');
      mergeDynamicProviderModels(OPENAI_CODEX_PROVIDER_KEY, models);
      lastCodexModelRefreshAt = Date.now();
      startupLog(chalk.green(`  ✓ [OpenAI Codex] Discovered ${models.length} models for ${resolved.email || resolved.planType || 'the signed-in account'}`));
      return models;
    } catch (err) {
      // Discovery must never blank the provider, and it must not *replace* an account's
      // real rows with the curated ones either: a signed-in plan may not be allowed to
      // serve them, so swapping them in would offer models that then fail their probe.
      // Keep whatever is loaded and retry sooner.
      skipLog(`[OpenAI Codex] Model sync skipped: ${describeSyncError(err)}, keeping the current list`);
      lastCodexModelRefreshAt = computeFailedRefreshRetryAt(Date.now(), CODEX_MODELS_REFRESH_MS, FAILED_DISCOVERY_RETRY_MS);
      return [];
    }
  };

  const refreshProviderModelsForApi = async (providerKey) => {
    const baseKey = getBaseProviderKey(providerKey);
    if (!providerKey || !sources[baseKey]) {
      throw new Error('Unknown provider.');
    }

    if (providerKey === KILOCODE_PROVIDER_KEY) return await refreshKiloCodeModels(true);
    if (providerKey === EMPERO_PROVIDER_KEY) return await refreshEmperoModels(true);
    if (providerKey === DEVIN_PROVIDER_KEY) return await refreshDevinModels(true);
    if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) return await refreshCopilotModels(true);
    if (providerKey === OPENAI_CODEX_PROVIDER_KEY) return await refreshCodexModels(true);
    if (providerKey === OPENROUTER_PROVIDER_KEY) return await refreshOpenRouterModels(true);
    if (isOpenAICompatibleInstanceKey(providerKey)) return await refreshOpenAICompatibleModels(providerKey, true);
    if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) return await refreshOpenAICompatibleModels(null, true);
    if (providerKey === OLLAMA_PROVIDER_KEY) return await refreshOllamaModels(true);
    if (sources[providerKey]?.discoverable) return await refreshDiscoverableProviderModels(providerKey, true);

    return results
      .filter(r => r.providerKey === providerKey)
      .map(r => ({
        modelId: r.modelId,
        label: r.label,
        intell: r.intell,
        isEstimatedScore: r.isEstimatedScore,
        ctx: r.ctx,
        ctxSource: r.ctxSource,
        ctxSourceUrl: r.ctxSourceUrl,
        providerKey: r.providerKey,
      }));
  };

  const pingModel = async (r) => {
    // Refresh config every ping cycle just in case
    const currentConfig = loadConfig();

    if (bannedModels.some(b => b === r.modelId || b === `${r.providerKey}/${r.modelId}`)) {
      r.status = 'banned';
      return;
    }

    // Name-based incompatibility runs before any probe: a model outside the chat families (see
    // isBlockedModelName) is shown Incompatible and skipped rather than benchmarked as a
    // healthy chat model — it can answer a probe successfully and still not be a chat model.
    if (isBlockedModelName(r.modelId)) {
      r.status = 'incompatible';
      r.httpCode = null;
      r.lastError = null;
      return;
    }

    const minSweScore = currentConfig.minSweScore;
    const excludedProviders = currentConfig.excludedProviders || [];

    if (excludedProviders.includes(r.providerKey)) {
      r.status = 'excluded';
      return;
    }

    if (typeof minSweScore === 'number' && typeof r.intell === 'number' && r.intell < minSweScore) {
      r.status = 'excluded';
      return;
    }

    const auth = await resolveProviderAuthToken(currentConfig, r.providerKey);
    // Same credential the proxy path sends (the pool's next key wins over the
    // resolved token), so the probe and chat present identical credentials and
    // cannot disagree about whether a provider rejects keyless traffic.
    const providerApiKey = getNextApiKey(currentConfig, r.providerKey) || auth.token;
    const providerUrl = resolveProviderUrl(currentConfig, r.providerKey, auth.providerUrlOverride, r.providerUrl);

    // No API key / auth configured for this provider: mark as 'noauth' instead of
    // pinging (which would otherwise fail and show the model as 'down').
    if (!providerApiKey && !isProviderAuthOptional(currentConfig, r.providerKey)) {
      const now = Date.now();
      r.status = 'noauth';
      r.httpCode = '401';
      r.lastError = { code: '401', message: 'No API key configured.', updatedAt: now };
      return;
    }

    const pingOptions = {
      isExplicitFreemodelsKey: isExplicitFreemodelsKey(currentConfig, r.providerKey),
      // Codex's identity is per-account (workspace id + residency), and the probe has
      // to present the same one the proxy would or it is rejected as unauthorized.
      codexAccountId: auth.account?.accountId || null,
      codexResidency: auth.account?.residency || null,
    };
    let pingResult = await ping(providerApiKey, r.modelId, providerUrl, r.providerKey, pingOptions);
    if (shouldRetryOptionalProviderWithBearer(currentConfig, r.providerKey, auth, pingResult.code, pingResult.errorMessage)) {
      pingResult = await ping(getApiKey(currentConfig, r.providerKey), r.modelId, providerUrl, r.providerKey, pingOptions);
    }
    if (pingResult.upstreamModel) rememberUpstreamModelId(r, pingResult.upstreamModel);

    const { code, ms, rateLimit, errorMessage, noUsableText } = pingResult;
    const now = Date.now();
    r.lastPingAt = now;

    // Tell the provider ledger about a transport failure *before* any verdict logic gets to
    // soften it. The keep-up window below may legitimately keep this row 'up', but "nothing
    // answered" is a fact about the provider that no per-row grace should be able to hide —
    // it is what lets a fleet-wide outage be seen and routed around (see pingModel's caller
    // and preferHealthyProviders).
    if (code === '000' || code === 'ERR') {
      noteProviderUnreachable(
        providerScopeKey(r),
        code === '000'
          ? `probe timed out after ${Math.round(PING_TIMEOUT / 1000)}s`
          : (errorMessage || 'probe could not reach the provider'),
        `${r.providerKey}/${r.modelId}`,
      );
    }

    // A 200 whose body carried no completion is a failed probe, not a verdict about the
    // model. ping() already retried once with real headroom, and what is left is the
    // same shape of evidence as a cold start: the probe asked, the row did not answer in
    // text. So it goes through the same hysteresis, and it never becomes 'incompatible'
    // — that verdict strikes the row out of the table, and it outlived a Groq row that
    // had served a real request four days earlier.
    if (noUsableText) {
      const keepUpEmptyResponse = shouldKeepUpAfterFailedProbe({
        status: r.status,
        code: 'EMPTY',
        lastServedAt: getLastServedAt(r),
        now,
        keepUpMs: RECENT_SUCCESS_KEEP_UP_MS,
        timeoutGraceMs: RECENT_SUCCESS_KEEP_UP_TIMEOUT_MS,
      });
      if (keepUpEmptyResponse) {
        return;
      }
      // Down, not Incompatible: 'down' says this probe got nothing usable out of the
      // row, which the next cycle re-checks, while 'incompatible' says the model can
      // never chat — a claim a one-token probe cannot support. No latency/uptime sample
      // is recorded, so a silent row can't inflate QoS either.
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Model returned no usable text.',
        updatedAt: now,
      };
      return;
    }

    // Hysteresis: a failed probe against a model that served a real request recently
    // (including persisted success from before a restart) is most likely a cold
    // start / transient blip, not an outage. Keep it 'up' and don't record the
    // failed probe (which would drag down its uptime % and latency). A *timeout*
    // is non-authoritative and is ignored within a longer liveness window, so a
    // slow-but-alive endpoint (e.g. one that answers tests instantly but wakes
    // slower than the probe budget) isn't condemned to 'timeout'.
    // A verdict of 'dead' is a statement about the catalog, not about one request:
    // the provider says it has no backend serving this model. The hysteresis exists
    // to absorb a cold start / transient blip, which a definitive "no server" 404 is
    // not — and the branches below already refuse to soften a dead verdict into
    // 'down' or 'noauth'. So a recent success must not outlive it either, or a
    // rotating gateway could keep a model the provider cannot serve in rotation.
    const deadVerdict = isDeadModelError(errorMessage, code);
    // Which verdicts the grace window is allowed to absorb. It exists for a cold start or a
    // transport blip, so only a verdict that says nothing about the model qualifies: a timeout,
    // an unreachable endpoint, or a 5xx. Everything below is a statement about the credential,
    // the plan, the catalog or the model, and believing it a minute sooner is the whole value
    // of probing. They used to be swallowed by the same early return, which is how a row
    // throttled by the provider kept its 'up' verdict (and never recorded wasRateLimited) while
    // the router kept feeding traffic into a 429 for up to an hour — the manual-test path has
    // always benched it on the spot, so the probe and the test disagreed about one provider.
    // The rule itself lives in isAuthoritativeProbeFailure, where it can be tested: it has to
    // name every failure that is a statement about the credential, the plan, the catalog or the
    // model, and an account-budget refusal is one of them — named on its own words rather than
    // left to the 429 this path reports it as (see budgetRefusedNotice in ping()), so a change to
    // that status cannot quietly hand a spent key back to the grace window below.
    const authoritativeVerdict = isAuthoritativeProbeFailure({ code, errorMessage, deadVerdict });
    const keepUp = !authoritativeVerdict && shouldKeepUpAfterFailedProbe({
      status: r.status,
      code,
      lastServedAt: getLastServedAt(r),
      now,
      keepUpMs: RECENT_SUCCESS_KEEP_UP_MS,
      timeoutGraceMs: RECENT_SUCCESS_KEEP_UP_TIMEOUT_MS,
    });
    if (code !== '200' && keepUp) {
      // An 'up' row with recent liveness keeps that verdict rather than being condemned by
      // one slow or failed probe (see shouldKeepUpAfterFailedProbe: only 'up' qualifies).
      return;
    }

    r.pings.push({ ms, code, ts: now });
    if (r.pings.length > 50) r.pings.shift(); // keep history bounded
    // Merge ping-gathered rate-limit headers into existing rateLimit — a 200
    // response can carry x-ratelimit-* headers just like a 429. Proxy-sourced
    // data (capturedAt) wins for wasRateLimited / quota, but numeric usage
    // counters should always reflect the freshest header values.
    // Also persist so quota data survives restarts.
    if (rateLimit || r.rateLimit) {
      r.rateLimit = reconcileRateLimitState(r.rateLimit, rateLimit, code, now);
      // Then withdraw a bench whose window has closed — this is the one rule for that
      // decision (see isRateLimitBenchExpired): the reset times the provider stated, or the
      // short grace after a capture that named none. It used to be spelled out inline here
      // and, differently, at startup, which is how the same live bench survived a restart and
      // expired at the next probe.
      if (r.rateLimit && isRateLimitBenchExpired(r.rateLimit, now)) {
        r.rateLimit = restoreRateLimitState(r.rateLimit, now);
      }
      const uk = `${r.providerKey}::${r.modelId}`;
      const prev = usageStats.get(uk) || {};
      if (r.rateLimit) usageStats.set(uk, { ...prev, rateLimit: r.rateLimit });
      else if (prev.rateLimit) {
        const next = { ...prev };
        delete next.rateLimit;
        usageStats.set(uk, next);
      }
      // Persist quota learned by the probe so it survives a restart (see scheduleUsageSave).
      scheduleUsageSave();
    }

    if (code === '200') {
      // An answer from any one of a provider's rows is the strongest evidence that the
      // provider is serving again, so it clears the outage bench immediately.
      noteProviderReachable(providerScopeKey(r));
      r.status = 'up';
      r.httpCode = null;
      r.lastError = null;
    }
    else if (code === '000') {
      r.status = 'timeout';
      r.lastError = {
        code,
        message: 'Request timed out while pinging provider.',
        updatedAt: now,
      };
    }
    else if (code === 'ERR' && !isDeadModelError(errorMessage, code)) {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Network error while contacting provider.',
        updatedAt: now,
      };
    }
    else if (code === '401' && !isDeadModelError(errorMessage, code)) {
      r.status = 'noauth';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Unauthorized. Check API key.',
        updatedAt: now,
      };
    }
    else if (code === '410' || isDeadModelError(errorMessage, code)) {
      r.status = 'dead';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Model is dead (HTTP 410 Gone).',
        updatedAt: now,
      };
      learnServerRoster(r, errorMessage);
    }
    else if (isIncompatibleModelError(errorMessage, code)) {
      r.status = 'incompatible';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Model does not support text chat (image/video only).',
        updatedAt: now,
      };
    }
    // Payment required (HTTP 402 / billing-wall text from the live provider):
    // surface the same 'paid' status the manual-test path records, so probes
    // classify a paywalled model correctly instead of as a generic 'down'.
    else if (isPaymentRequiredError(errorMessage, code)) {
      r.status = 'paid';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Payment required to use this model.',
        updatedAt: now,
      };
    }
    // Rate limit / quota exhaustion (429 or the text-only form some gateways
    // return): clock status, not Down. The model is healthy and returns when
    // the provider's window resets, so record the same wasRateLimited flag the
    // manual-test path uses to render the countdown (and to bench routing).
    // An exhausted account budget is the same clock as a rate limit — the provider will not serve
    // until the key's window resets — and it reaches this branch as a 429 today: ping() re-labels a
    // 200 body carrying the notice (see budgetRefusedNotice). Naming it here as well is what the
    // manual test and the proxy already do, so all three agree about the notice on its own terms
    // rather than through a status one of them synthesized: the row goes on the clock with a
    // countdown and `wasRateLimited`, never the generic 'down' below.
    else if (isRateLimitedErrorText(errorMessage) || isQuotaExhaustionError(errorMessage, code) || isAccountBudgetRefusalText(errorMessage)) {
      r.status = 'rate-limited';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Rate limit exceeded.',
        updatedAt: now,
      };
      if (!r.rateLimit || r.rateLimit.wasRateLimited !== true) {
        r.rateLimit = reconcileRateLimitState(r.rateLimit, { wasRateLimited: true, capturedAt: now }, code, now);
      }
    }
    // Provider overload (503, or a 5xx that says it is busy): the same clock as a rate limit,
    // because the probe must not condemn a row the provider is only briefly refusing. Reading
    // it as Down here is what turned one busy minute into a red dot until the next probe.
    else if (isProviderOverloadedError(errorMessage, code)) {
      r.status = 'overloaded';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Provider is temporarily overloaded.',
        updatedAt: now,
      };
    }
    else {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || `HTTP ${code}`,
        updatedAt: now,
      };
    }

    // Fetch OpenRouter key-level rate limit (credits) during ping cycles.
    // This is a read-only GET that doesn't consume any rate-limit slots. Credits are
    // per-API-key and shared by every OpenRouter model, but the merge must not clobber
    // each model's own per-model 429/header data -- applyRateLimitCapture only
    // propagates the key-level credit fields provider-wide.
    if (r.providerKey === 'openrouter') {
      const keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
      if (keyRateLimit) {
        applyRateLimitCapture(r, results, null, keyRateLimit);
      }
    }
  };

  const triggerImmediateProviderPing = async (scopeKey) => {
    if (!scopeKey) return;
    // A scope key names one origin of a federated provider. Re-reading that gateway's whole
    // catalog would cost the gateway a request and could not answer the question asked — its
    // catalog says what exists, not whether *this* upstream is answering again — so an origin
    // scope skips the model refresh and re-probes only its own rows, which is exactly the
    // evidence that clears its bench. An OpenAI-compatible instance key also contains a
    // colon but is a provider in its own right, so it keeps the full refresh.
    if (/^[^:]+:/.test(scopeKey) && !isOpenAICompatibleInstanceKey(scopeKey)) {
      const originRows = results.filter(r => providerScopeKey(r) === scopeKey);
      if (originRows.length === 0) return;
      void Promise.allSettled(originRows.map(r => pingModel(r)));
      return;
    }
    const providerKey = scopeKey;
    if (providerKey === KILOCODE_PROVIDER_KEY) {
      await refreshKiloCodeModels(true);
    }
    if (providerKey === EMPERO_PROVIDER_KEY) {
      await refreshEmperoModels(true);
    }
    if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) {
      await refreshCopilotModels(true);
    }
    if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
      await refreshCodexModels(true);
    }
    if (providerKey === OPENROUTER_PROVIDER_KEY) {
      await refreshOpenRouterModels(true);
    }
    if (isOpenAICompatibleInstanceKey(providerKey)) {
      await refreshOpenAICompatibleModels(providerKey, true);
    } else if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) {
      await refreshOpenAICompatibleModels(null, true);
    }
    if (providerKey === OLLAMA_PROVIDER_KEY) {
      await refreshOllamaModels(true);
    }
    if (sources[providerKey]?.discoverable) {
      await refreshDiscoverableProviderModels(providerKey, true);
    }
    const providerModels = results.filter(r => r.providerKey === providerKey);
    if (providerModels.length === 0) return;
    void Promise.allSettled(providerModels.map(r => pingModel(r)));
  };

  // ── The ledger's two reporters ───────────────────────────────────────────────────────
  // Function declarations on purpose: the probe is defined above this point and the proxy below
  // it, and both report into the same ledger without caring which was written first. A provider
  // is benched once (one log line); every further failure of the same outage only refreshes the
  // reminder line (see skipLog).
  //
  // Both take the failing row's *scope* key (see providerScopeKey), which is the provider for
  // every ordinary row and the upstream origin of a federated one. A gateway that runs three
  // dozen upstreams answers as one endpoint, so benching it would take the healthy ones down
  // with the sick one, and a single origin's 200 must not clear another origin's outage.
  function noteProviderUnreachable(scopeKey, detail, modelKey = null, { reprobe = false } = {}) {
    const result = noteProviderTransportFailure(providerHealth, scopeKey, { reason: detail, modelKey });
    if (!result) return null;
    const { entry, benched, newlyBenched } = result;
    if (newlyBenched) {
      // startupLogLine, not console.log: the probe owns a \r-rewritten progress line, and a
      // plain log would append onto it — every ledger line stamped with a stale "⠸ Probing…"
      // prefix. During startup the line itself is held back (the post-probe summary names what
      // is still benched); this path still runs so the ledger stays accurate either way.
      if (!startupLoading) startupLogLine(chalk.yellow(`  [Router] 📡 ${describeProviderScope(scopeKey)} benched for ${Math.round(entry.cooldownMs / 1000)}s — ${entry.consecutive} failed attempts across ${entry.distinctModels} model${entry.distinctModels === 1 ? '' : 's'} (${detail}).`));
      // A *proxied* failure is how the router learns by spending a client's request, so ask the
      // provider's rows directly instead of waiting for the next cycle. The probe path never asks
      // for this: it is the probe, and re-probing on a probe failure is a loop.
      // Caught, not bare: the refresh steps inside a provider ping do throw on a failed sync, and
      // an unhandled rejection terminates the process. This path runs *because* a provider is
      // failing, so it is the one place where that throw is likely rather than theoretical.
      if (reprobe) triggerImmediateProviderPing(scopeKey).catch(() => {});
    } else if (benched) {
      // Deliberately a *stable* line. skipLog dedupes by the message itself, so putting the
      // streak count or the remaining cooldown in here made every failure of the same outage its
      // own "new" message: one line per failing model per cycle (a fleet-wide outage produced
      // dozens of them, which is exactly the noise the ledger exists to remove) and an entry in
      // the reminder map per line, none of which the pruner ever matched.
      skipLog(`[${describeProviderScope(scopeKey)}] still unreachable — staying benched until it answers again`);
    }
    return result;
  }

  function noteProviderReachable(scopeKey) {
    const recovered = noteProviderSuccess(providerHealth, scopeKey);
    if (recovered) {
      // Recovery during startup is held back as well: benched-then-recovered pairs inside the
      // probe are churn, and the post-probe summary only names providers still benched.
      if (!startupLoading) startupLogLine(chalk.green(`  [Router] ✅ ${describeProviderScope(scopeKey)} answering again — back in rotation.`));
    }
    return recovered;
  }

  // Per-model-per-provider usage stats (ttft, tokens/sec) accumulated when a model
  // is actually used, persisted across sessions so the dashboard keeps its history.
  // Loaded before the rows are given their persisted liveness evidence (lastServedAt,
  // lastResponse timestamps) so getLastServedAt reads it, and before the first quality
  // refresh: applyQualityScores also reads each row's learned resolvedModelId from here, so
  // the map has to exist before any provider-model merge that re-scores rows.
  // Provider-level outage ledger, shared by the proxy and the manual test: both paths report
  // transport failures into one ledger so one bench decision comes out of it (see
  // createProviderHealth in utils.js). In-memory on purpose — only evidence this process
  // observed (a served request, a clicked Test) writes into it, and nothing does at startup,
  // so a restart begins with every provider unbenched and a provider that recovered while the
  // process was down is not punished for a bench nobody can still verify.
  const providerHealth = createProviderHealth();

  const USAGE_PATH = join(homedir(), '.hammer-usage.json');
  let usageStats = new Map();
  const providerUsageReports = new Map();
  const providerUsageFetchedAt = new Map();
  const providerUsageErrors = new Map();
  if (existsSync(USAGE_PATH)) {
    try {
      const raw = readFileSync(USAGE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        usageStats = new Map(Object.entries(parsed));
      }
      // Re-read every stored context bound against the current rules before anything
      // can act on it. A bound is a persistent conclusion about a model, so a parser
      // revision that stops accepting a body (a quota, an output budget) has to be able
      // to withdraw the numbers its predecessor wrote — otherwise the fix only applies
      // to future errors while the dashboard keeps showing the old wrong ceiling, which
      // is exactly how the Groq compound rows stayed "≤8k / Micro" for nine days.
      let revalidatedBounds = 0;
      let revalidatedCaps = 0;
      let backfilledSamples = 0;
      let withdrawnRates = 0;
      let revalidatedRates = 0;
      for (const [key, entry] of usageStats) {
        if (!entry || typeof entry !== 'object') continue;
        const withBound = revalidateContextBound(entry);
        // A learned output cap gets the same treatment: it is a number that trims every
        // request to a model, so one misread body must not be able to shorten that
        // model's answers forever. Evidence that no longer parses to the stored cap
        // withdraws it, and the next rejection re-learns it.
        const withCap = revalidateOutputCap(withBound);
        // The answered-sample counter is newer than the rest of the entry. No score divides
        // by it any more (the speed metric is taken at a fixed reference length), but it is
        // what the dashboard prints as the row's own answered length, so a historical row
        // without it would have nothing to show beside its score.
        const withSamples = backfillCompletionSamples(withCap);
        // Rate figures a previous build measured without streaming, where a whole response
        // duration stood in as the TTFT (see RATE_SAMPLE_VERSION). That is a different quantity
        // from a measured first-token latency, so the sums are withdrawn rather than averaged
        // with the measurements that follow — the token-weighted rate sums stay, because the
        // answer that produced them was a couple of tokens against thousands of real ones.
        const withRates = withdrawLegacyRateSamples(withSamples);
        // A stored average past what any model can emit is a measurement the router must
        // not route on: it makes the row the fastest dot on the plot and the pick for
        // every request. The samples that produced it are dropped so the row re-learns
        // its rate (see revalidateMeasuredRate).
        const next = revalidateMeasuredRate(withRates);
        if (next === entry) continue;
        if (withBound !== entry) revalidatedBounds += 1;
        if (withCap !== withBound) revalidatedCaps += 1;
        if (withSamples !== withCap) backfilledSamples += 1;
        if (withRates !== withSamples) withdrawnRates += 1;
        if (next !== withRates) revalidatedRates += 1;
        usageStats.set(key, next);
      }
      if (revalidatedBounds > 0) {
        startupLog(chalk.dim(`  📐 Re-checked ${revalidatedBounds} learned context bound${revalidatedBounds === 1 ? '' : 's'} against the current rules`));
      }
      if (revalidatedCaps > 0) {
        startupLog(chalk.dim(`  📏 Re-checked ${revalidatedCaps} learned output cap${revalidatedCaps === 1 ? '' : 's'} against the current rules`));
      }
      if (backfilledSamples > 0) {
        startupLog(chalk.dim(`  📏 Estimated the answered-response length for ${backfilledSamples} usage row${backfilledSamples === 1 ? '' : 's'}`));
      }
      if (withdrawnRates > 0) {
        // console.log, not startupLog: startupLog only prints once the startup flag clears,
        // which happens long after this block, so a notice of a *dropped measurement history*
        // must not be one of the lines that never reach the terminal.
        console.log(chalk.dim(`  📉 Withdrew pre-streaming latency samples for ${withdrawnRates} row${withdrawnRates === 1 ? '' : 's'}`));
      }
      if (revalidatedRates > 0) {
        startupLog(chalk.dim(`  📉 Discarded implausible rate samples for ${revalidatedRates} row${revalidatedRates === 1 ? '' : 's'}`));
      }
      if (revalidatedBounds > 0 || revalidatedCaps > 0 || backfilledSamples > 0 || withdrawnRates > 0 || revalidatedRates > 0) saveUsageStats();
      startupLogLine(chalk.dim(`  📊 Loaded ${usageStats.size} usage stat entr${usageStats.size === 1 ? 'y' : 'ies'}`));
    } catch {
      usageStats = new Map();
    }
  }

  // Written through a temp file and renamed into place, because this file is the only copy of
  // every learned context bound, output cap and last test response, and the loader starts from
  // an empty map when it cannot parse what it finds (see the read above). A truncating write
  // that is interrupted — a crash, a full disk, an antivirus holding the handle — would
  // therefore silently discard all of it. A rename is atomic, so a reader sees either the old
  // file or the new one, never half of one.
  function saveUsageStats() {
    // The temp name is per-process: a second instance (a second port, or one started with
    // HAMMER_SKIP_INSTANCE_STOP) shares this file, and a shared temp path would let one process
    // rename the other's half-written bytes into place — the corruption this scheme exists to
    // prevent. Distinct names mean the last rename still wins, but a complete file always does.
    const tmpPath = `${USAGE_PATH}.${process.pid}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(usageStats), null, 2), { mode: 0o600 });
      renameSync(tmpPath, USAGE_PATH);
    } catch {
      // Leave the previous file in place rather than a half-written one.
      try { unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    }
  }

  // Probe cycles read quota straight off response headers, and they run every minute for every
  // row — a synchronous write of the whole file per header would be a write per row per minute.
  // Coalesce them the way request logs are coalesced (see scheduleLogSave) so nothing the probe
  // learned is lost across a restart without paying that on the hot path.
  let usageSaveTimer = null;
  function scheduleUsageSave(delayMs = 2000) {
    if (usageSaveTimer) clearTimeout(usageSaveTimer);
    usageSaveTimer = setTimeout(() => { usageSaveTimer = null; saveUsageStats(); }, delayMs);
  }

  const startupDiscoveryTasks = [
    ['Model quality', null, async () => {
      try {
        return await refreshQualityScores()
      } catch (err) {
        throw new Error(`OpenRouter catalog skipped: ${describeSyncError(err)}`)
      }
    }],
    ['KiloCode', KILOCODE_PROVIDER_KEY, () => refreshKiloCodeModels(true)],
    ['Empero Free', EMPERO_PROVIDER_KEY, () => refreshEmperoModels(true)],
    ['Devin', DEVIN_PROVIDER_KEY, () => refreshDevinModels()],
    ['GitHub Copilot', GITHUB_COPILOT_PROVIDER_KEY, () => refreshCopilotModels(true)],
    ['OpenAI Codex', OPENAI_CODEX_PROVIDER_KEY, () => refreshCodexModels(true)],
    ['OpenRouter', OPENROUTER_PROVIDER_KEY, () => refreshOpenRouterModels(true)],
    ['OpenAI-Compatible', OPENAI_COMPATIBLE_PROVIDER_KEY, async () => {
      // Nothing to discover without a configured endpoint: say so on the startup line
      // instead of a pointless refresh followed by a meaningless "0 models" success.
      if (listOpenAICompatibleEndpoints(loadConfig()).length === 0) return { note: 'no endpoints configured' }
      return await refreshOpenAICompatibleModels(null, true)
    }],
    ['Ollama', OLLAMA_PROVIDER_KEY, async () => (
      // Same reason the OpenAI-Compatible row above returns a note: a task that is
      // deliberately skipped should say so on the startup line, or it renders like a provider
      // that answered with nothing.
      providerDiscoveryNeedsCredential(loadConfig(), OLLAMA_PROVIDER_KEY)
        ? { note: 'no OLLAMA_API_KEY configured; hosted Ollama needs one' }
        : refreshOllamaModels(true)
    )],
    ...Object.entries(sources)
      // `lazyDiscovery` providers (imported from OmniRoute's free tier) are excluded on
      // purpose. They are real, routable endpoints, but probing every imported provider
      // here would turn the boot sequence into a wave of network calls for providers the
      // user may never touch — the background traffic this codebase deliberately removed.
      // They are discovered on demand instead: a provider refresh, or the first request
      // that targets one of their models (see discoverLazyImportsForRequest).
      .filter(([key, source]) => source.discoverable && !source.lazyDiscovery && !new Set([
        KILOCODE_PROVIDER_KEY,
        EMPERO_PROVIDER_KEY,
        DEVIN_PROVIDER_KEY,
        OPENROUTER_PROVIDER_KEY,
        OPENAI_COMPATIBLE_PROVIDER_KEY,
        OLLAMA_PROVIDER_KEY,
      ]).has(key))
      .map(([key, source]) => [source.name || key, key, () => refreshDiscoverableProviderModels(key, true)]),
  ]

  const discoveryStartedAt = Date.now()
  startupProgress(`Discovering models across ${startupDiscoveryTasks.length} providers...`)
  // Results are collected, not printed as each task settles: a parallel discovery would list
  // providers in completion order — different on every run — so the block is rendered once,
  // after the dust settles, in task order.
  const discoverySettled = await Promise.allSettled(startupDiscoveryTasks.map(async ([name, providerKey, task]) => {
    try {
      const value = await task()
      // A task that returned a note (e.g. OpenAI-Compatible with no endpoints) has
      // nothing to count, so skip the row tally and let the note speak for itself.
      const count = providerKey && !value?.note
        ? results.filter(result => result.providerKey === providerKey || result.providerKey.startsWith(`${providerKey}:`)).length
        : null
      return { name, providerKey, value, ok: true, line: formatStartupProviderResult(name, { count, note: value?.note }) }
    } catch (err) {
      const message = describeSyncError(err)
      // No startupWarnings push here: the ✗ line in the discovery block already carries this
      // exact message, and the listen-time ⚠ flush would only repeat it.
      return { name, providerKey, value: null, ok: false, error: message, line: formatStartupProviderResult(name, { ok: false, error: message }) }
    }
  }))
  const discoveryResults = discoverySettled.map((settled, index) => {
    if (settled.status === 'fulfilled') return settled.value
    const [name, providerKey] = startupDiscoveryTasks[index]
    const message = describeSyncError(settled.reason)
    return { name, providerKey, value: null, ok: false, error: message, line: formatStartupProviderResult(name, { ok: false, error: message }) }
  })
  for (const result of discoveryResults) startupLogLine(chalk.dim(`  ${result.line}`))
  startupLogLine(chalk.dim(`  Discovery completed in ${((Date.now() - discoveryStartedAt) / 1000).toFixed(1)}s`))
  // Stores the upstream (real) model id a provider reported for a catalog entry so
  // the dashboard can show what actually served the request and score the row by
  // it (see applyQualityScores). FreeModels entries are personas over a rotating
  // backend, so the real name changes without notice — capturing it at response
  // time keeps labels fresh with no hardcoded tables. Persisted alongside usage
  // stats so the last known name survives restarts.
  function rememberUpstreamModelId(result, upstreamModelId) {
    if (!result || typeof upstreamModelId !== 'string') return;
    const trimmed = upstreamModelId.trim();
    if (!trimmed) return;
    // The g4f namespace selects a backend, not a model identity, and alias-
    // equivalent spellings (zai-z/zai-org-glm-5-3-flash vs glm-5.3-flash) are the
    // same model. Only a genuinely different model overwrites the row's learned
    // name, or it would clobber the label the dashboard groups providers under.
    if (resolveAliasedModelId(stripRoutingNamespace(trimmed)) === resolveAliasedModelId(stripRoutingNamespace(result.modelId))) return;
    const key = `${result.providerKey}::${result.modelId}`;
    const prev = usageStats.get(key);
    if (prev?.resolvedModelId === trimmed) return;
    usageStats.set(key, { ...(prev || {}), resolvedModelId: trimmed });
    saveUsageStats();
    // The row's intelligence follows the backend that actually serves it, so a
    // newly learned (or rotated) upstream id re-scores the row immediately — the
    // table, the scatter plot, and the router all read the row.
    if (results.some(row => row.providerKey === result.providerKey && row.modelId === result.modelId)) {
      applyQualityScores();
    }
  }

  async function refreshProviderUsageReports(force = false) {
    const currentConfig = loadConfig();
    const now = Date.now();
    const providerKeys = Object.keys(sources);
    await Promise.all(providerKeys.map(async providerKey => {
      if (!force && now - (providerUsageFetchedAt.get(providerKey) || 0) < PROVIDER_USAGE_CACHE_MS) return;
      const result = await fetchProviderUsageReport(currentConfig, providerKey);
      providerUsageFetchedAt.set(providerKey, result.fetchedAt || Date.now());
      providerUsageErrors.set(providerKey, result.error || null);
      // A successful empty response is authoritative and replaces the old cache.
      // Failed refreshes retain the last report but mark it stale in /api/models.
      if (!(result.error && (result.reports || []).length === 0 && providerUsageReports.has(providerKey))) {
        providerUsageReports.set(providerKey, result.reports || []);
      }
    }));
  }

  // No probe wave runs here on purpose. Model health, latency and quota state are learned
  // only from evidence this process actually produced: a Test the user clicked (the manual-test
  // endpoint) or traffic the router really served (see noteProviderReachable /
  // noteProviderUnreachable and the usage samples the proxy accumulates). An unattended startup
  // probe spent ~400 upstream requests before the server accepted one, against providers that
  // mostly see the user's traffic in short bursts, and the numbers it produced described that
  // burst rather than the service. A fresh start therefore renders rows as Down until they are
  // tested or used, and provider usage reports are fetched on demand by /api/usage.

  // The provider's own "retry in 30s" names a rate-limit window just as well as a reset time.
  const RETRY_IN_TEXT = /(?:please\s+)?retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i;

  // The window a persisted *manual test* is still describing when the process stopped. A test
  // that hit a provider rate limit benches its row at the time (the test path sets the same flag
  // a proxied 429 does) and persists the response, so the restart has to read that evidence back:
  // otherwise the dashboard renders a live countdown from the response it still holds while the
  // server has forgotten the bench and keeps aiming requests at the row. This mirrors how the
  // dashboard reads the same record.
  function persistedTestRateLimitWindow(lastResponse, now) {
    if (!lastResponse) return { limited: false, resetAt: null };
    const status = Number(lastResponse.status);
    const errorText = String(lastResponse.error || '');
    if (status !== 429 && !isRateLimitedErrorText(errorText) && !isQuotaExhaustionError(errorText, status)) {
      return { limited: false, resetAt: null };
    }
    const stated = [Number(lastResponse.rateLimitResetAt), extractRateLimitResetMs(errorText, null)]
      .filter(value => Number.isFinite(value) && value > now);
    if (stated.length > 0) return { limited: true, resetAt: Math.max(...stated) };
    const at = Number(lastResponse.at);
    const atMs = Number.isFinite(at) && at > 0 ? at : now;
    // The provider's own "retry in Ns" names the window just as well.
    const retry = errorText.match(RETRY_IN_TEXT)
    if (retry) {
      const until = atMs + Number(retry[1]) * 1000;
      if (until > now) return { limited: true, resetAt: until };
    }
    // The provider named no window at all: the same short grace the server applies to its own
    // flag before re-admitting a row it benched itself.
    return { limited: atMs + RATE_LIMIT_UNSTATED_GRACE_MS > now, resetAt: null };
  }

  // Restore persisted rateLimit data from usage stats into results. *Live* evidence wins: a probe
  // that answered this row since the process started is a fresher statement about it than a file
  // written last session, so a bench the file still carries for such a row is superseded — the
  // row just served (see restoreRateLimitState's `superseded`).
  //
  // "The probe spoke for this row" is read from r.pings, not from the row already having a
  // rateLimit: pings are rebuilt empty on every start and are never persisted, so a 200 in them is
  // this session's own probe, while the other two things that put data on a row's rateLimit are no
  // statement about it at all — the keep-up grace revives a row from a persisted lastServedAt
  // without any probe answering (and records no ping), and the key-level credit facts
  // applyRateLimitCapture spreads to every OpenRouter row are a report about the account, not about
  // one model's window. Reading those as "spoken for" is what used to drop a live OpenRouter bench
  // on restart, which is the bug this loop exists to fix.
  //
  // What is left is the rows nothing has spoken for — offline or benched models — and they keep
  // the bench they had, for exactly as long as its window still covers.
  for (const r of results) {
    const uk = `${r.providerKey}::${r.modelId}`;
    const entry = usageStats.get(uk);
    const pingsSpokeForRow = (r.pings || []).some(ping => String(ping?.code) === '200');
    if (entry) {
      const now = Date.now();
      const restored = restoreRateLimitState(entry.rateLimit, now, { superseded: pingsSpokeForRow });
      let bench = restored;
      // The persisted *test* verdict is last session's evidence too, so a probe that answered since
      // boot supersedes it on the same grounds; and when either source already carries the flag the
      // window is already in force and adding the test's reset time would only lengthen it.
      const testWindow = persistedTestRateLimitWindow(entry.lastResponse, now);
      if (!pingsSpokeForRow && testWindow.limited && !(restored && restored.wasRateLimited === true)) {
        bench = mergeRateLimits(restored, {
          wasRateLimited: true,
          capturedAt: now,
          ...(testWindow.resetAt != null ? { resetRequestsAt: testWindow.resetAt } : {}),
        });
      }
      // The row's own fields are newer than the file's (the second argument wins in
      // mergeRateLimits), so a probe that answered 429 in this session is never overwritten by last
      // session's verdict, while account-level credits survive a superseded or expired bench.
      r.rateLimit = mergeRateLimits(bench, r.rateLimit);
      // Keep the file in step with that conclusion, so a bench whose window has closed — or which
      // this session's probes have superseded — is not re-examined, and re-expired, on every future
      // start.
      if (entry.rateLimit?.wasRateLimited === true && r.rateLimit?.wasRateLimited !== true) {
        usageStats.set(uk, { ...entry, rateLimit: r.rateLimit });
      }
    }
    // Persisted speed data must be on the rows before the first pick is served.
    applyUsageDerivedMetrics(r);
  }
  saveUsageStats();

  const app = express();
  const jsonBodyLimit = process.env.HAMMER_JSON_LIMIT || '10mb';

  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json({ limit: jsonBodyLimit }));

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hammer-Token');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Security gate for the dashboard API and the OpenAI-compatible proxy. Blocks
  // cross-origin/drive-by requests (a malicious website fetching localhost:7352),
  // DNS-rebinding Host tricks, and -- when the server is exposed on the LAN --
  // unauthenticated clients. Loopback clients (local tooling, the local dashboard)
  // are unaffected.
  const apiGuard = (req, res, next) => {
    const denied = checkApiRequestAllowed({
      origin: req.headers.origin || null,
      host: req.headers.host || null,
      lanMode,
    });
    if (denied) {
      return res.status(403).json({ error: denied });
    }

    if (lanMode && accessToken && !isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
        || String(req.headers['x-hammer-token'] || '').trim();
      if (!provided || provided !== accessToken) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="hammer"');
        return res.status(401).json({ error: 'Unauthorized: valid access token required.' });
      }
    }

    next();
  };
  app.use('/api', apiGuard);
  app.use('/v1', apiGuard);

  /**
   * ── Restarting the router ─────────────────────────────────────────────────────────────
   *
   * Two things make this more than `process.exit()`. The provider registry, the catalog-derived
   * `sources`/`MODELS` tables and this function's own `results` are each built once per process,
   * so a change to `lib/` or to the vendored OmniRoute catalog only takes effect across a
   * process boundary — reloading the dashboard page cannot pick either up, which is exactly how
   * a declined provider kept appearing on a dashboard whose API was built before the change.
   *
   * And how the replacement comes back depends on who owns the process: see `restartMode`.
   *
   * Order matters here. The response is sent first, the listener is released before the
   * replacement binds it, and the old process only exits once the replacement has actually
   * spawned — all three because the failure mode is "no router at all": the replacement's own
   * EADDRINUSE handler exits the process, so a port still held would kill it on arrival, and a
   * spawn that never happened would leave nothing running for the operator to talk to.
   */
  app.post('/api/restart', (req, res) => {
    const mode = restartMode(getAutostartStatus());

    // Everything that only lives in memory goes to disk before the process does. Best-effort:
    // a failed flush must not cost the operator their restart.
    try { saveUsageStats(); } catch { /* best effort */ }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;

      if (mode === 'supervised') {
        console.log(chalk.dim('  ↻ Restart requested from the dashboard — exiting for the autostart service.'));
        process.exit(0);
      }

      // Nobody owns this process, so it has to replace itself. The same argv keeps the port,
      // host and flags this instance was started with.
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        // The CLI stops every other hammer instance — and any autostart supervisor — on its way
        // up. Neither is wanted for a restart: this process is already leaving, and the
        // supervisor is not ours to tear down.
        env: { ...process.env, HAMMER_SKIP_INSTANCE_STOP: '1' },
      });
      child.on('error', err => {
        // A stale router beats no router: the operator can still restart by hand.
        console.error(chalk.red(`  ✖ Restart failed: ${err?.message || err}`));
        console.error(chalk.dim('    The old process is still running. Restart hammer manually to pick up changes.'));
      });
      child.on('spawn', () => {
        console.log(chalk.dim('  ↻ Restart requested from the dashboard — replacement started.'));
        process.exit(0);
      });
    };

    // Attached before the response is sent: `finish` fires once the last chunk is flushed, and
    // registering after `json()` would be a race this handler cannot afford to lose. The short
    // delay is what lets the 202 reach the browser before anything is torn down; releasing the
    // listener next is what lets the replacement bind the port. A connection that lingers (an
    // open log stream) must not be able to stall the hand-off, so `finish` is also reachable on
    // a timer of its own.
    res.on('finish', () => {
      setTimeout(() => {
        try { httpServer.closeIdleConnections?.(); } catch { /* older Node */ }
        httpServer.close(finish);
        setTimeout(() => { try { httpServer.closeAllConnections?.(); } catch { /* older Node */ } }, 150);
        setTimeout(finish, 750);
      }, 150);
    });

    res.status(202).json({
      ok: true,
      restarting: true,
      mode,
      message: mode === 'supervised'
        ? 'Exiting so the autostart service can bring the router back up.'
        : 'Starting a replacement with the same command line, then exiting.',
    });
  });

  // API for Web UI
  app.get('/api/oauth/kiro/auto-import', (req, res) => {
    try {
      const refreshToken = extractKiroRefreshTokenFromAwsCache();
      if (!refreshToken) {
        return res.json({
          found: false,
          error: 'Kiro refresh token not found in ~/.aws/sso/cache. Sign in to Kiro first or paste a token manually.',
        });
      }

      // Save the token directly — never return it in the response body
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      clearKiroAuthMetadata(providerConfig);
      providerConfig.refreshToken = refreshToken;
      providerConfig.authMode = 'aws-cache';
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({ found: true });
    } catch (err) {
      return res.status(500).json({
        found: false,
        error: err?.message || 'Failed to inspect the AWS SSO cache.',
      });
    }
  });

  app.get('/api/oauth/kiro/device-code', async (req, res) => {
    try {
      const deviceAuth = await startKiroBuilderIdDeviceAuth();
      const flowId = randomUUID();
      const expiresAt = Date.now() + (Math.max(60, Number(deviceAuth.expiresIn || 600)) * 1000);

      // Store secrets server-side; the client only receives an opaque flowId
      _kiroDeviceFlows.set(flowId, {
        clientId: deviceAuth.clientId,
        clientSecret: deviceAuth.clientSecret,
        deviceCode: deviceAuth.deviceCode,
        expiresAt,
      });

      // Prune stale entries to avoid unbounded growth
      const now = Date.now();
      for (const [id, flow] of Array.from(_kiroDeviceFlows)) {
        if (flow.expiresAt <= now) _kiroDeviceFlows.delete(id);
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        verificationUriComplete: deviceAuth.verificationUriComplete,
        expiresIn: deviceAuth.expiresIn,
        interval: deviceAuth.interval,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to start Kiro device authorization.' });
    }
  });

  app.post('/api/oauth/kiro/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' });
      }

      const flow = _kiroDeviceFlows.get(flowId);
      if (!flow) {
        return res.status(400).json({ error: 'Unknown or expired flow. Start a new device authorization.' });
      }
      if (flow.expiresAt <= Date.now()) {
        _kiroDeviceFlows.delete(flowId);
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' });
      }

      const { deviceCode, clientId, clientSecret } = flow;
      const pollResult = await pollKiroBuilderIdToken(deviceCode, clientId, clientSecret);
      if (!pollResult.success) {
        return res.json({
          success: false,
          pending: pollResult.pending === true,
          error: pollResult.error,
          errorDescription: pollResult.errorDescription,
        });
      }

      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      providerConfig.refreshToken = pollResult.tokens.refreshToken;
      providerConfig.clientId = pollResult.tokens.clientId;
      providerConfig.clientSecret = pollResult.tokens.clientSecret;
      providerConfig.authMode = 'builder-id';
      providerConfig.authProvider = 'aws-builder-id';
      delete providerConfig.profileArn;
      const email = extractKiroEmailFromAccessToken(pollResult.tokens.accessToken);
      if (email) providerConfig.authEmail = email;
      else delete providerConfig.authEmail;
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      _kiroDeviceFlows.delete(flowId);
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({
        success: true,
        email,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed while polling Kiro device authorization.' });
    }
  });

  app.get('/api/oauth/kiro/social-authorize', (req, res) => {
    try {
      const provider = normalizeSecretValue(req.query?.provider).toLowerCase();
      if (!KIRO_BROWSER_AUTH_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." });
      }

      return res.json(startKiroSocialAuthFlow(provider));
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to initialize Kiro browser OAuth.' });
    }
  });

  app.post('/api/oauth/kiro/social-exchange', async (req, res) => {
    try {
      const provider = normalizeSecretValue(req.body?.provider).toLowerCase();
      const code = normalizeSecretValue(req.body?.code);
      const flowId = normalizeSecretValue(req.body?.flowId);
      const state = normalizeSecretValue(req.body?.state);

      if (!KIRO_BROWSER_AUTH_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." });
      }
      if (!code || !flowId) {
        return res.status(400).json({ error: 'code and flowId are required.' });
      }

      const tokens = await exchangeKiroSocialAuthFlow(flowId, code, state);
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      clearKiroAuthMetadata(providerConfig);
      providerConfig.refreshToken = tokens.refreshToken;
      providerConfig.authMode = 'browser-oauth';
      providerConfig.authProvider = provider;
      if (tokens.profileArn) providerConfig.profileArn = tokens.profileArn;
      else delete providerConfig.profileArn;
      const email = extractKiroEmailFromAccessToken(tokens.accessToken);
      if (email) providerConfig.authEmail = email;
      else delete providerConfig.authEmail;
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({
        success: true,
        email,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to complete Kiro browser OAuth.' });
    }
  });

  // Save a freshly minted Devin session token into the local config so the
  // Connect wire client picks it up, then nudge the provider ping loop.
  const persistDevinOAuthSessionToken = (token) => {
    const currentConfig = loadConfig();
    const stored = normalizeDevinToken(token);
    currentConfig.apiKeys[DEVIN_PROVIDER_KEY] = stored;
    if (currentConfig.providers?.[DEVIN_PROVIDER_KEY]?.sessionToken) {
      delete currentConfig.providers[DEVIN_PROVIDER_KEY].sessionToken;
    }
    saveConfig(currentConfig);
    devinUserJwtCache.clear();
    void triggerImmediateProviderPing(DEVIN_PROVIDER_KEY);
  };

  app.get('/api/oauth/devin/authorize', async (req, res) => {
    try {
      const started = await startDevinOAuthFlow({ onToken: persistDevinOAuthSessionToken });
      return res.json(started);
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to start Devin OAuth.' });
    }
  });

  app.get('/api/oauth/devin/status', (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.query?.flowId);
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' });
      }
      return res.json(getDevinOAuthFlowStatus(flowId));
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to read Devin OAuth status.' });
    }
  });

  app.post('/api/oauth/devin/exchange', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      const code = normalizeSecretValue(req.body?.code);
      const state = normalizeSecretValue(req.body?.state);
      if (!flowId || !code) {
        return res.status(400).json({ error: 'flowId and code are required.' });
      }
      await exchangeDevinOAuthFlow(flowId, code, state, { onToken: persistDevinOAuthSessionToken });
      return res.json({ success: true });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to complete Devin OAuth.' });
    }
  });

  app.post('/api/oauth/devin/cancel', (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' });
      }
      const cancelled = cancelDevinOAuthFlow(flowId);
      return res.json({ success: cancelled });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to cancel Devin OAuth.' });
    }
  });

  // ── GitHub Copilot sign-in (OAuth device flow) ─────────────────────────────
  // GitHub's device flow needs no client secret: the server shows a user code, the
  // user approves it on github.com/login/device, and the resulting GitHub token is
  // stored as the provider credential and used as the Copilot bearer.
  app.get('/api/oauth/github-copilot/device-code', async (req, res) => {
    try {
      const deviceAuth = await startGitHubCopilotDeviceAuth();
      const flowId = randomUUID();
      const expiresAt = Date.now() + (Math.max(60, Number(deviceAuth.expiresIn || 900)) * 1000);

      // The device code never leaves the server; the client only gets a flowId.
      _copilotDeviceFlows.set(flowId, { deviceCode: deviceAuth.deviceCode, expiresAt });
      const now = Date.now();
      for (const [id, flow] of Array.from(_copilotDeviceFlows)) {
        if (flow.expiresAt <= now) _copilotDeviceFlows.delete(id);
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        verificationUriComplete: deviceAuth.verificationUriComplete,
        expiresIn: deviceAuth.expiresIn,
        interval: deviceAuth.interval,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to start GitHub Copilot device authorization.' });
    }
  });

  app.post('/api/oauth/github-copilot/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      if (!flowId) return res.status(400).json({ error: 'flowId is required.' });

      const flow = _copilotDeviceFlows.get(flowId);
      if (!flow) return res.status(400).json({ error: 'Unknown or expired flow. Start a new device authorization.' });
      if (flow.expiresAt <= Date.now()) {
        _copilotDeviceFlows.delete(flowId);
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' });
      }

      const pollResult = await pollGitHubCopilotDeviceToken(flow.deviceCode);
      if (!pollResult.success) {
        if (!pollResult.pending) _copilotDeviceFlows.delete(flowId);
        return res.json({
          success: false,
          pending: pollResult.pending === true,
          error: pollResult.error,
          errorDescription: pollResult.errorDescription,
        });
      }

      const githubToken = pollResult.accessToken;
      const login = await fetchGitHubLogin(githubToken, { signal: AbortSignal.timeout(10_000) });
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, GITHUB_COPILOT_PROVIDER_KEY);
      currentConfig.apiKeys[GITHUB_COPILOT_PROVIDER_KEY] = githubToken;
      providerConfig.authMode = 'device-flow';
      if (login) providerConfig.authEmail = login;
      else delete providerConfig.authEmail;
      // Re-probe the plan host on the next discovery pass, which also accepts the
      // account's gated model policies (both live in refreshCopilotModels).
      delete providerConfig.apiEndpoint;
      saveConfig(currentConfig);
      clearCopilotAuthCaches();
      _copilotDeviceFlows.delete(flowId);

      // The ping helper refreshes the Copilot catalog first (learning the plan host and
      // accepting gated policies) before probing, so one call covers both.
      void triggerImmediateProviderPing(GITHUB_COPILOT_PROVIDER_KEY);

      return res.json({ success: true, login: providerConfig.authEmail || null });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed while polling GitHub Copilot device authorization.' });
    }
  });

  app.post('/api/oauth/github-copilot/disconnect', (req, res) => {
    try {
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, GITHUB_COPILOT_PROVIDER_KEY);
      delete currentConfig.apiKeys[GITHUB_COPILOT_PROVIDER_KEY];
      delete providerConfig.oauthToken;
      delete providerConfig.authMode;
      delete providerConfig.authEmail;
      delete providerConfig.apiEndpoint;
      saveConfig(currentConfig);
      clearCopilotAuthCaches();
      void triggerImmediateProviderPing(GITHUB_COPILOT_PROVIDER_KEY);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to disconnect GitHub Copilot.' });
    }
  });

  // ── OpenAI Codex sign-in (ChatGPT OAuth device flow) ───────────────────────
  // ChatGPT's device flow has two legs: the device authorization hands back a
  // user code the user approves on auth.openai.com/codex/device, then the
  // authorization code is exchanged (with the PKCE verifier the backend generated)
  // for the OAuth tokens. Only the long-lived refresh token is stored; access
  // tokens are exchanged on demand.
  app.get('/api/oauth/openai-codex/device-code', async (req, res) => {
    try {
      const deviceAuth = await startOpenAICodexDeviceAuth();
      const flowId = randomUUID();
      const expiresIn = Math.max(60, Math.floor(CODEX_DEVICE_FLOW_EXPIRY_MS / 1000));

      // The device code never leaves the server; the client only gets a flowId.
      _codexDeviceFlows.set(flowId, {
        deviceAuthId: deviceAuth.deviceAuthId,
        userCode: deviceAuth.userCode,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      const now = Date.now();
      for (const [id, flow] of Array.from(_codexDeviceFlows)) {
        if (flow.expiresAt <= now) _codexDeviceFlows.delete(id);
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        expiresIn,
        interval: deviceAuth.interval,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to start OpenAI Codex device authorization.' });
    }
  });

  app.post('/api/oauth/openai-codex/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      if (!flowId) return res.status(400).json({ error: 'flowId is required.' });

      const flow = _codexDeviceFlows.get(flowId);
      if (!flow) return res.status(400).json({ error: 'Unknown or expired flow. Start a new device authorization.' });
      if (flow.expiresAt <= Date.now()) {
        _codexDeviceFlows.delete(flowId);
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' });
      }

      const pollResult = await pollOpenAICodexDeviceToken(flow.deviceAuthId, flow.userCode);
      if (pollResult.pending) return res.json({ success: false, pending: true });
      if (!pollResult.authorizationCode) {
        _codexDeviceFlows.delete(flowId);
        return res.json({ success: false, pending: false, error: pollResult.error || 'Device authorization failed.' });
      }

      const tokens = await exchangeOpenAICodexAuthorizationCode(pollResult.authorizationCode, pollResult.codeVerifier);
      const identity = extractCodexAccountIdentity(tokens.accessToken, tokens.idToken);
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, OPENAI_CODEX_PROVIDER_KEY);
      // The refresh token is the credential; the pool keeps one entry per signed-in
      // account, so re-signing in the same account refreshes it in place while a
      // different ChatGPT account is appended as an additional one to rotate across.
      addOrUpdateProviderAccount(currentConfig, OPENAI_CODEX_PROVIDER_KEY, {
        secret: tokens.refreshToken,
        email: identity.email,
        accountId: identity.accountId,
        planType: identity.planType,
      });
      delete providerConfig.refreshToken;
      providerConfig.authMode = 'device-flow';
      if (identity.email) providerConfig.authEmail = identity.email;
      else delete providerConfig.authEmail;
      // One account is the legacy shape; more than one is a pool, and the single-value
      // display fields must not claim to describe it.
      const codexAccountCount = getProviderAccounts(currentConfig, OPENAI_CODEX_PROVIDER_KEY).length;
      if (codexAccountCount > 1) delete providerConfig.authEmail;
      saveConfig(currentConfig);
      clearCodexAuthCaches();
      _codexDeviceFlows.delete(flowId);

      // The ping helper refreshes the Codex catalog first (which is account-scoped),
      // so one call both discovers the plan's models and probes them.
      void triggerImmediateProviderPing(OPENAI_CODEX_PROVIDER_KEY);

      return res.json({
        success: true,
        email: identity.email || null,
        planType: identity.planType || null,
        accountCount: codexAccountCount,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed while polling OpenAI Codex device authorization.' });
    }
  });

  // With no body this signs every account out, which is what it has always done. With
  // `account` (an email or workspace id) or `index` (the pool position the dashboard was
  // given) it signs out exactly that one, so a pool of several ChatGPT accounts can be
  // trimmed instead of only emptied. The index form is what makes an account that reported
  // no email removable at all — it has no other identifier to send.
  app.post('/api/oauth/openai-codex/disconnect', (req, res) => {
    try {
      const account = normalizeSecretValue(req.body?.account);
      const hasIndex = Number.isInteger(req.body?.index);
      const currentConfig = loadConfig();
      let target = account;
      if (!target && hasIndex) {
        const accounts = getProviderAccounts(currentConfig, OPENAI_CODEX_PROVIDER_KEY);
        const selected = accounts[req.body.index];
        target = selected ? (selected.email || selected.accountId || selected.secret) : null;
      }
      // A single-account sign-out that resolved to nothing is an error, never a silent
      // fall-through into signing the whole pool out.
      if ((account || hasIndex) && !target) {
        return res.status(404).json({ error: 'No signed-in account matches that email, account id or position.' });
      }
      const result = applyProviderSignOut(currentConfig, OPENAI_CODEX_PROVIDER_KEY, target);
      if (target && result.removed === 0) {
        return res.status(404).json({ error: 'No signed-in account matches that email, account id or position.' });
      }
      saveConfig(currentConfig);
      clearCodexAuthCaches();
      void triggerImmediateProviderPing(OPENAI_CODEX_PROVIDER_KEY);
      return res.json({ success: true, removed: result.removed, remaining: result.remaining });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to disconnect OpenAI Codex.' });
    }
  });

  // Version and logging flags only. This used to consult the npm registry and report
  // `updateAvailable` on every dashboard load; hammer now scans npm only when asked
  // (`hammer update`), so the page load stays a local read.
  app.get('/api/meta', (req, res) => {
    const metaConfig = loadConfig();
    res.json({
      version: APP_VERSION,
      logging: {
        logRequestContent: metaConfig.logRequestContent !== false,
        persistRequestLogs: metaConfig.persistRequestLogs !== false,
      },
    });
  });

  app.get('/api/models', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const qosOptions = { latencyTargetMs: currentConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS };
    const qosMap = computeQoSMap(results, [], qosOptions);
    const today = new Date().toISOString().slice(0, 10);
    const providerDailyCounts = new Map();
    for (const [key, entry] of usageStats) {
      if (entry?.dailyDate !== today) continue;
      const providerKey = key.split('::', 1)[0];
      providerDailyCounts.set(providerKey, (providerDailyCounts.get(providerKey) || 0) + (Number(entry.dailyProxyCount) || 0));
    }
    // One read of the derived table per request, rather than per row: the quota a provider
    // publishes is now attached to its descriptor (see lib/providers/catalog.js), so the
    // table is built from the registry instead of read from a hand-maintained copy.
    const quotaTable = providerQuotaTable();
    const formatted = results.map(r => {
      applyUsageDerivedMetrics(r);
      const lastPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null;
      const now = Date.now();
      const rateLimit = r.rateLimit || null;
      // The provider-level outage bench for this row, if any (see the ledger in utils.js).
      const outage = providerBenchState(providerHealth, providerScopeKey(r), now);
      let isRateLimited = false;
      if (rateLimit) {
        if (rateLimit.wasRateLimited === true) {
          isRateLimited = true;
        }
        if (rateLimit.creditLimit > 0 && rateLimit.creditRemaining != null && rateLimit.creditRemaining <= 0) {
          isRateLimited = true;
        }
        if (rateLimit.resetRequestsAt && rateLimit.resetRequestsAt <= now) {
          // informative only; status is refreshed by ping cycle
        }
      }

      // Real usage stats captured when this model was actually proxied
      const usageEntry = usageStats.get(`${r.providerKey}::${r.modelId}`);
      const providerReports = providerUsageReports.get(r.providerKey) || [];
      const usageFetchedAt = providerUsageFetchedAt.get(r.providerKey) || null;
      const usageError = providerUsageErrors.get(r.providerKey) || null;
      const providerUsages = providerReports
        .filter(report => !report.model || report.model === r.modelId)
        .map(report => serializeProviderUsage([{
          ...report,
          fetchedAt: report.fetchedAt || usageFetchedAt,
          freshness: usageError ? 'stale' : (report.freshness || 'fresh'),
          error: usageError,
        }])[0])
        .filter(Boolean);
      const providerUsage = selectProviderUsageReport(providerReports, { providerKey: r.providerKey, model: r.modelId })
        || selectProviderUsageReport(providerReports, { providerKey: r.providerKey });
      const usageAverages = computeUsageAverages(usageEntry);
      // The speed numbers come off the row (see applyUsageDerivedMetrics) so the
      // payload, the KPI, and the router share one definition of a row's speed.
      const displayTtft = r.ttft;
      const displayTps = r.tps;
      // Context window: one derivation feeds the column, the min_ctx filter, and the
      // Micro flag, so a row can never display a window and be struck out over that same
      // window at once (see deriveContextState).
      const ctxInfo = deriveContextState(r.ctx, usageEntry);
      const contextBoundMax = Number(usageEntry?.contextMax);
      const contextBoundMin = Number(usageEntry?.contextMin);
      const hasContextBoundMax = usageEntry?.contextMax != null && Number.isFinite(contextBoundMax) && contextBoundMax > 0;
      const hasContextBoundMin = usageEntry?.contextMin != null && Number.isFinite(contextBoundMin) && contextBoundMin > 0;

      const out = {
        ...r,
        avg: getAvg(r),
        uptime: getUptime(r),
        verdict: getVerdict(r),
        qos: isRateLimited ? 0 : (qosMap.get(r) || 0),
        isRateLimited,
        lastPing: lastPing ? lastPing.ms : null,
        rateLimit,
        lastServedAt: getLastServedAt(r),
        lastProxiedAt: usageEntry?.lastServedAt || 0,
        dailyProxyCount: usageEntry?.dailyProxyCount || 0,
        providerDailyProxyCount: providerDailyCounts.get(r.providerKey) || 0,
        knownQuota: quotaTable[r.providerKey] || null,
        providerUsage: providerUsage ? serializeProviderUsage([{
          ...providerUsage,
          fetchedAt: providerUsage.fetchedAt || usageFetchedAt,
          freshness: usageError ? 'stale' : (providerUsage.freshness || 'fresh'),
          error: usageError,
        }])[0] : null,
        providerUsages,
        providerUsageFetchedAt: usageFetchedAt,
        providerUsageError: usageError,
        providerUsageFreshness: usageError ? 'stale' : (providerReports.length > 0 ? 'fresh' : 'unavailable'),
        ttft: displayTtft,
        tps: displayTps,
        usageRequests: usageAverages.requests,
        context: ctxInfo.display,
        contextTokens: ctxInfo.tokens,
        contextSource: ctxInfo.source,
        microContext: ctxInfo.micro,
        // Whether the bound behind `context` is an exact, evidence-backed provider
        // statement (the only kind the dashboard may treat as a verdict).
        contextExact: ctxInfo.exact,
        // The error body a learned bound was read from, so a client can say why a row
        // is bounded where it is instead of asserting a number with no provenance.
        contextEvidence: normalizeContextEvidence(usageEntry?.contextEvidence),
        // The learned bound itself (which `context` only shows when it is exact and the
        // provider states nothing), so a client can inspect or withdraw it.
        contextBound: hasContextBoundMax || hasContextBoundMin
          ? {
            min: hasContextBoundMin ? contextBoundMin : null,
            max: hasContextBoundMax ? contextBoundMax : null,
            exact: ctxInfo.exact,
            updatedAt: Number.isFinite(Number(usageEntry?.contextUpdatedAt)) ? Number(usageEntry.contextUpdatedAt) : null,
          }
          : null,
        lastResponse: r.lastResponse,
        // Whether the router would actually consider this row. The display status
        // below can be promoted to 'up' by a clean lastResponse, so the dashboard
        // must not infer routing eligibility from it.
        routingEligible: r.status === 'up' && isModelEligibleForRouting(r) && outage == null,
        // A provider the outage ledger has benched is only ever a *fallback* — the router
        // prefers any other provider while one can serve, and uses this row when nothing can
        // (see preferHealthyProviders). Reporting it lets the dashboard say why a row that its
        // own probe still calls 'up' is not the one answering requests.
        providerBenched: outage != null,
        providerOutage: outage
          ? {
            since: outage.since,
            until: outage.benchedUntil,
            consecutive: outage.consecutive,
            distinctModels: outage.distinctModels,
            reason: outage.reason,
          }
          : null,
        pings: r.pings  // full history (up to 50 entries), available to API clients
      };
      // The real backend behind a catalog entry. FreeModels personas report a
      // rotating upstream id in every response; when it is known and is genuinely
      // another model, the dashboard shows it as the primary name. "Genuinely
      // another" ignores the g4f routing namespace and alias-equivalent spellings:
      // a relay echoing its own id (zai-z/zai-org-glm-5-3-flash for a glm-5.3-flash
      // row) must not overwrite the row's human label and split it out of the
      // shared dashboard heading all its providers group under.
      const resolvedModelId = typeof usageEntry?.resolvedModelId === 'string' ? usageEntry.resolvedModelId : null;
      if (resolvedModelId
        && resolveAliasedModelId(stripRoutingNamespace(resolvedModelId)) !== resolveAliasedModelId(stripRoutingNamespace(r.modelId))) {
        out.realModelId = resolvedModelId;
        out.realModelLabel = getPreferredModelLabel(resolvedModelId) || formatGenericProviderModelLabel(resolvedModelId);
      }
      // The status is the row's own (applyUsageDerivedMetrics owns the single
      // readiness promotion, including its freshness bound) — the payload must not
      // re-derive it, or the dashboard and the router can disagree about "up".
      return out;
    });
    // The picks below say which model the router would use, so they have to respect the same
    // provider bench the router does — otherwise the dashboard would name a benched model as
    // "Current Model" while real requests go elsewhere. preferHealthyProviders falls back to the
    // full list when every provider is benched, exactly as the router does.
    const smartestBest = preferHealthyProviders(rankModelsForSmartest(results), providerHealth)[0] || null;
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    const pinnedResult = getPinnedModelCandidate(results, pinnedModelId, pinningMode, [], pinnedProviderKey, qosOptions);
    const pinnedModelIds = pinnedMatches.map(r => r.modelId);
    const pinnedRowKeys = pinnedMatches.map(toPinnedRowKey);
    // Mirror pickNextModel precedence so the dashboard KPI matches real routing:
    // manual pin > slope-line pick > Elo ranking.
    const modelsConfig = loadConfig();
    let slopePick = null;
    const selCfg = effectiveSelectorSettings(modelsConfig);
    const selSlope = selectorSlopeOf(selCfg);
    if (selSlope != null) {
      const selPick = selectModelBySlope(preferHealthyProviders(results, providerHealth), {
        slope: selSlope,
        minSpeed: selCfg.minSpeed,
        minIntell: selCfg.minIntell,
      });
      slopePick = selPick ? selPick.model : null;
    }
    const effectiveBest = pinnedResult || slopePick || smartestBest;
    res.json({
      models: formatted,
      proxyError: lastProxyError && Date.now() - lastProxyError.at < 10 * 60_000 ? lastProxyError : null,
      best: effectiveBest ? effectiveBest.modelId : null,
      bestProviderKey: effectiveBest ? effectiveBest.providerKey : null,
      pinnedModelId,
      pinnedProviderKey,
      pinnedModelIds,
      pinnedRowKeys,
      pinningMode,
      selector: {
        // The selector has no enable toggle: it is active whenever a slope is set,
        // which is exactly when the router's pick above can produce a model.
        enabled: selSlope != null,
        slope: selSlope,
        minSpeed: selCfg ? selCfg.minSpeed : null,
        minIntell: selCfg ? selCfg.minIntell : null,
        pickedModelId: slopePick ? slopePick.modelId : null,
        fallbackActive: !pinnedResult && !slopePick && !!smartestBest,
      },
    });
  });

  const buildProviderConfigEntry = (currentConfig, key, displayName) => {
    const baseKey = getBaseProviderKey(key);
    const pool = getApiKeyPool(currentConfig, key)
    const hasMultiple = pool.length > 1
    const providerConfig = currentConfig.providers?.[key] || {}
    const hasKiroOAuth = key === KIRO_PROVIDER_KEY ? hasKiroAuthConfigured(currentConfig) : false
    const hasCopilotAuth = key === GITHUB_COPILOT_PROVIDER_KEY ? hasGitHubCopilotAuthConfigured(currentConfig) : false
    const hasCodexAuth = key === OPENAI_CODEX_PROVIDER_KEY ? hasOpenAICodexAuthConfigured(currentConfig) : false
    const isOaiInstance = isOpenAICompatibleInstanceKey(key);
    const supportsBaseUrlAndModelId = isOaiInstance || baseKey === OLLAMA_PROVIDER_KEY;
    const sourceName = sources[baseKey]?.name || key;
    return {
      key,
      name: displayName || sourceName,
      enabled: isProviderEnabled(currentConfig, key),
      hasKey: pool.length > 0 || hasKiroOAuth || hasCopilotAuth || hasCodexAuth,
      // Whether the router can actually use this provider, so the dashboard can group its card
      // without keeping its own list of which providers need a key. That list was the same fact
      // a fourth time, and it had already drifted: it called hosted Ollama active while the
      // router refused it NO_KEY, and filed the genuinely keyless imports under "require setup".
      canServe: providerCanServe(currentConfig, key),
      signupUrl: API_KEY_SIGNUP_URLS[baseKey] || null,
      supportsOptionalBearerAuth: isProviderAuthOptional(currentConfig, key),
      useBearerAuth: isProviderAuthOptional(currentConfig, key) ? isProviderBearerAuthEnabled(currentConfig, key) : null,
      baseUrl: supportsBaseUrlAndModelId ? (getProviderBaseUrl(currentConfig, key) || '') : null,
      modelId: supportsBaseUrlAndModelId ? (getProviderModelId(currentConfig, key) || '') : null,
      isOpenAICompatibleInstance: isOaiInstance,
      openAICompatibleInstanceId: isOaiInstance ? getOpenAICompatibleInstanceId(key) : null,
      discoverModels: isOaiInstance ? (providerConfig.discoverModels !== false) : null,
      hasMultipleKeys: hasMultiple,
      authMode: (key === KIRO_PROVIDER_KEY || key === GITHUB_COPILOT_PROVIDER_KEY || key === OPENAI_CODEX_PROVIDER_KEY) ? (normalizeSecretValue(providerConfig.authMode) || null) : null,
      authProvider: key === KIRO_PROVIDER_KEY ? (normalizeSecretValue(providerConfig.authProvider) || null) : null,
      authEmail: (key === KIRO_PROVIDER_KEY || key === GITHUB_COPILOT_PROVIDER_KEY || key === OPENAI_CODEX_PROVIDER_KEY) ? (normalizeSecretValue(providerConfig.authEmail) || null) : null,
      // Signed-in accounts for a pool-based OAuth provider (Codex today): the
      // dashboard lists them, so it never exposes a raw credential.
      accounts: key === OPENAI_CODEX_PROVIDER_KEY
        ? getProviderAccounts(currentConfig, key).map((account, i) => ({
          // `index` is the pool position, and it is what the dashboard signs an account out
          // by when the account reported no email: a masked token is not an identifier, and
          // the frontend must never be handed a real one to pass back.
          index: i,
          email: account.email,
          planType: account.planType,
          masked: account.secret.length > 8 ? `${account.secret.slice(0, 4)}...${account.secret.slice(-4)}` : '****',
          addedAt: account.addedAt,
        }))
        : null,
      apiKeyPool: pool.map((k, i) => {
        const masked = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : `${k.slice(0, 2)}***`
        return { index: i, masked, key: k }
      }),
      // What the card's usage bar draws. Sent for every provider that has at least one
      // credential — one credential is a one-segment bar, which is the same question ("is
      // there anything left in this account?") asked of a pool of one.
      credentialPool: describeCredentialPool(currentConfig, key),
      // Fields a templated endpoint needs beyond the API key — Cloudflare's account id,
      // Vertex's project and region. Sent so the card can offer an input for each instead of
      // leaving the operator to discover an env var name: without the value the provider is
      // wired but can never be probed, and its card would read "0 models" with no explanation.
      requiredCredentialFields: requiredCredentialFields(baseKey),
      missingCredentialFields: missingCredentialFields(currentConfig, key),
      // Only what the config itself holds, so the inputs can prefill. Values that came from the
      // environment are deliberately not echoed back — the dashboard never needs to see them,
      // and an unchanged input must not look like something it wrote.
      credentialFieldValues: Object.fromEntries(
        requiredCredentialFields(baseKey).map(field => {
          const configured = currentConfig.providers?.[key]?.[field];
          const fromEnv = !(typeof configured === 'string' && configured.trim())
            && Boolean(credentialFieldValues(currentConfig, key)[field]);
          return [field, typeof configured === 'string' && configured.trim() ? configured.trim() : (fromEnv ? 'from-environment' : null)];
        }),
      ),
      // Why this provider has no model rows, when it has none: 'ok' (it has rows), 'needs-key',
      // 'needs-config', 'failed', 'empty', 'unavailable', 'disabled', or absent (never probed).
      modelDiscovery: modelDiscoveryOutcomes.get(key) || null,
    }
  };

  app.get('/api/config', (req, res) => {
    const currentConfig = loadConfig();
    const providers = [];
    for (const key of Object.keys(sources)) {
      // The bare 'openai-compatible' source is a template; its instances are emitted separately.
      if (key === OPENAI_COMPATIBLE_PROVIDER_KEY) continue;
      providers.push(buildProviderConfigEntry(currentConfig, key));
    }
    for (const ep of listOpenAICompatibleEndpoints(currentConfig)) {
      providers.push(buildProviderConfigEntry(currentConfig, ep.instanceKey, ep.name));
    }
    res.json(providers);
  });

  app.post('/api/openai-compatible/endpoints', (req, res) => {
    const { id, name, baseUrl, modelId, apiKey, enabled, discoverModels } = req.body || {};
    if (!name && !id) return res.status(400).json({ error: 'name or id is required.' });

    const currentConfig = loadConfig();
    const desiredKey = buildOpenAICompatibleInstanceKey(id || name);
    if (!desiredKey) return res.status(400).json({ error: 'Could not derive a valid instance id from the supplied name.' });
    if (currentConfig.providers?.[desiredKey]) {
      return res.status(409).json({ error: `Endpoint with id "${getOpenAICompatibleInstanceId(desiredKey)}" already exists.` });
    }

    upsertOpenAICompatibleEndpoint(currentConfig, {
      instanceKey: desiredKey,
      name: name || getOpenAICompatibleInstanceId(desiredKey),
      baseUrl: baseUrl || '',
      modelId: modelId || '',
      apiKey: apiKey === undefined ? undefined : apiKey,
      enabled: enabled !== false,
      discoverModels: discoverModels === undefined ? undefined : (discoverModels !== false),
    });
    saveConfig(currentConfig);

    void triggerImmediateProviderPing(desiredKey);

    return res.json({ success: true, instanceKey: desiredKey, id: getOpenAICompatibleInstanceId(desiredKey) });
  });

  app.delete('/api/openai-compatible/endpoints/:id', (req, res) => {
    const id = req.params.id;
    const instanceKey = buildOpenAICompatibleInstanceKey(id);
    if (!instanceKey) return res.status(400).json({ error: 'Invalid id.' });

    const currentConfig = loadConfig();
    const removed = removeOpenAICompatibleEndpoint(currentConfig, instanceKey);
    if (!removed) return res.status(404).json({ error: 'Endpoint not found.' });
    saveConfig(currentConfig);

    // Drop result rows for the removed instance so it disappears from the dashboard.
    void refreshOpenAICompatibleModels();

    return res.json({ success: true });
  });

  app.post('/api/providers/:providerKey/refresh', async (req, res) => {
    const { providerKey } = req.params;
    const baseKey = getBaseProviderKey(providerKey);
    if (!sources[baseKey]) {
      return res.status(404).json({ error: 'Unknown provider.' });
    }
    const providerName = sources[baseKey].name;

    try {
      const models = await refreshProviderModelsForApi(providerKey);
      const providerModels = results.filter(r => r.providerKey === providerKey);
      void Promise.allSettled(providerModels.map(r => pingModel(r)));
      return res.json({
        success: true,
        providerKey,
        providerName,
        // An empty list is not automatically a success story. `state`/`note` say which kind of
        // empty it is, so the card can show "needs accountId" rather than "0 models".
        modelDiscovery: modelDiscoveryOutcomes.get(providerKey) || null,
        models: models.map(model => {
          const ranked = providerModels.find(row => row.modelId === model.modelId) || model;
          return {
            modelId: ranked.modelId,
            label: ranked.label,
            ctx: ranked.ctx,
            ctxSource: ranked.ctxSource,
            ctxSourceUrl: ranked.ctxSourceUrl,
            intell: ranked.intell,
            isEstimatedScore: ranked.isEstimatedScore === true,
            qualitySource: ranked.qualitySource,
            qualityDetail: ranked.qualityDetail,
          };
        }),
      });
    } catch (err) {
      return res.status(502).json({
        success: false,
        providerKey,
        providerName,
        error: describeSyncError(err),
      });
    }
  });

  app.post('/api/providers/refresh-all', async (req, res) => {
    const currentConfig = loadConfig();
    const sourceKeys = Object.keys(sources)
      .filter(key => key !== OPENAI_COMPATIBLE_PROVIDER_KEY)
      .filter(key => isProviderEnabled(currentConfig, key));
    const instanceKeys = listOpenAICompatibleEndpoints(currentConfig)
      .filter(ep => ep.enabled)
      .map(ep => ep.instanceKey);
    const providerKeys = [...sourceKeys, ...instanceKeys];
    const results_arr = [];

    for (const providerKey of providerKeys) {
      const providerName = sources[getBaseProviderKey(providerKey)]?.name || providerKey;
      try {
        const models = await refreshProviderModelsForApi(providerKey);
        results_arr.push({
          success: true,
          providerKey,
          providerName,
          modelCount: models.length,
        });
      } catch (err) {
        results_arr.push({
          success: false,
          providerKey,
          providerName,
          error: describeSyncError(err),
        });
      }
    }

    // Ping all models after refreshing
    void Promise.allSettled(results.map(r => pingModel(r)));

    return res.json({
      success: true,
      providers: results_arr,
    });
  });

  /**
   * The providers view's own discovery sweep.
   *
   * Imported providers are discovered on demand — never at boot, which is deliberate: a wave of
   * probes for providers the user may never touch is the background traffic this codebase
   * removed. But "on demand" only had two triggers, a request naming one of their models or a
   * per-provider refresh, so a fleet of imports sat at "0 models" with nothing saying why. Opening
   * the providers view *is* demand, so this is the third trigger: the candidates the request path
   * would probe anyway (`lazyDiscoveryCandidates` — enabled, answerable, still row-less), swept
   * with the same concurrency limit and the same cache, and reported with the reason for each empty
   * result.
   */
  app.post('/api/providers/discover-pending', async (req, res) => {
    const currentConfig = loadConfig();
    const providersWithRows = new Set(results.map(result => result.providerKey));
    const candidates = lazyDiscoveryCandidates(sources, providersWithRows, currentConfig, {
      isAuthOptional: isProviderAuthOptional,
      hasApiKey: getApiKey,
    });

    const providers = [];
    for (let i = 0; i < candidates.length; i += LAZY_DISCOVERY_CONCURRENCY) {
      const batch = candidates.slice(i, i + LAZY_DISCOVERY_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(key => refreshDiscoverableProviderModels(key, false)));
      batch.forEach((key, index) => {
        const models = settled[index].status === 'fulfilled' && Array.isArray(settled[index].value)
          ? settled[index].value
          : [];
        providers.push({
          providerKey: key,
          providerName: sources[key]?.name || key,
          modelCount: models.length,
          // Absent when the provider was skipped inside its own cache window, which is not a
          // result worth reporting a second time.
          modelDiscovery: modelDiscoveryOutcomes.get(key) || null,
        });
      });
    }

    return res.json({ success: true, candidates: candidates.length, providers });
  });

  app.get('/api/pinning', (req, res) => {
    const currentConfig = loadConfig();
    res.json({ pinningMode: getPinningMode(currentConfig) });
  });

  app.get('/api/config/export', (req, res) => {
    const currentConfig = loadConfig();
    res.json({ payload: exportConfigToken(currentConfig) });
  });

  app.post('/api/config/import', (req, res) => {
    const { payload } = req.body || {};
    if (typeof payload !== 'string' || !payload.trim()) {
      return res.status(400).json({ error: 'payload must be a non-empty string.' });
    }

    let importedConfig;
    try {
      importedConfig = importConfigToken(payload);
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid config payload.' });
    }

    saveConfig(importedConfig);
    bannedModels = Array.isArray(importedConfig.bannedModels) ? [...new Set(importedConfig.bannedModels)] : [];

    const providerKeys = Object.keys(sources);
    void Promise.allSettled(providerKeys.map(key => triggerImmediateProviderPing(key)));

    return res.json({
      success: true,
      importedProviders: Object.keys(importedConfig.providers || {}).length,
      importedApiKeys: Object.keys(importedConfig.apiKeys || {}).length,
    });
  });

  app.get('/api/account-status', (req, res) => {
    const currentConfig = loadConfig()
    res.json(getAccountStatus(currentConfig))
  })

  app.get('/api/usage', async (req, res) => {
    await refreshProviderUsageReports();
    const reports = [];
    for (const [providerKey, providerReports] of providerUsageReports) {
      const fetchedAt = providerUsageFetchedAt.get(providerKey) || null;
      const error = providerUsageErrors.get(providerKey) || null;
      reports.push(...(providerReports || []).map(report => ({
        ...report,
        fetchedAt: report.fetchedAt || fetchedAt,
        freshness: error ? 'stale' : (report.freshness || 'fresh'),
        error,
      })));
    }
    res.json({ reports: serializeProviderUsage(reports) });
  });

  app.post('/api/config', (req, res) => {
    const { providerKey, apiKey, useBearerAuth, baseUrl, modelId, pinningMode, apiKeys, discoverModels, logRequestContent, persistRequestLogs, credentialFields } = req.body;
    const currentConfig = loadConfig();
    let didUpdateKiroAuth = false;

    if (apiKey !== undefined) {
      if (providerKey === KIRO_PROVIDER_KEY) {
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const value = normalizeSecretValue(apiKey);
        if (!value) {
          delete providerConfig.refreshToken;
          clearKiroAuthMetadata(providerConfig);
        } else {
          clearKiroAuthMetadata(providerConfig);
          providerConfig.refreshToken = value;
          providerConfig.authMode = 'manual-token';
        }
        delete currentConfig.apiKeys[providerKey];
        clearKiroTokenCaches();
        didUpdateKiroAuth = true;
      } else if (providerKey === GITHUB_COPILOT_PROVIDER_KEY) {
        // A pasted value is a GitHub OAuth token (the device-flow sign-in is the
        // normal path). It behaves exactly like a signed-in token, so it lives in
        // apiKeys and inherits pooling, masking, and config export.
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const value = normalizeSecretValue(apiKey);
        delete providerConfig.oauthToken;
        delete providerConfig.apiEndpoint;
        if (!value) {
          delete currentConfig.apiKeys[providerKey];
          delete providerConfig.authMode;
          delete providerConfig.authEmail;
        } else {
          currentConfig.apiKeys[providerKey] = value;
          providerConfig.authMode = 'manual-token';
        }
        clearCopilotAuthCaches();
      } else if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
        // A pasted value is a ChatGPT OAuth refresh token (the device-flow sign-in is
        // the normal path). It belongs in the account pool, never in apiKeys — Codex's
        // bearer is a short-lived access token that only the refresh exchange mints.
        //
        // It is *added* to the pool rather than replacing it: this field used to hold the
        // only credential, but with several accounts signed in, replacing would delete the
        // others as a side effect of adding one. `addOrUpdateProviderAccount` keeps that
        // safe — the same account matched by email or secret is refreshed in place, so
        // repeating a paste cannot grow the pool. Clearing is the empty value's job.
        // The legacy single-credential field is dropped either way, so exactly one store
        // is authoritative, and saving a value means the accounts array is that store.
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const value = normalizeSecretValue(apiKey);
        if (!value) {
          setProviderAccounts(currentConfig, providerKey, []);
          delete providerConfig.refreshToken;
          delete providerConfig.authMode;
          delete providerConfig.authEmail;
        } else {
          addOrUpdateProviderAccount(currentConfig, providerKey, { secret: value });
          delete providerConfig.refreshToken;
          providerConfig.authMode = 'manual-token';
          // A pasted token carries no identity of its own, so the single-value display field
          // is only meaningful again when the pool holds exactly one identified account.
          const remaining = getProviderAccounts(currentConfig, providerKey);
          if (remaining.length === 1 && remaining[0].email) providerConfig.authEmail = remaining[0].email;
          else delete providerConfig.authEmail;
        }
        delete currentConfig.apiKeys[providerKey];
        clearCodexAuthCaches();
      } else {
        if (apiKey === null || apiKey === '') {
          delete currentConfig.apiKeys[providerKey];
        } else {
          currentConfig.apiKeys[providerKey] = String(apiKey).trim();
        }
      }
    }

    if (apiKeys !== undefined && Array.isArray(apiKeys)) {
      if (providerKey === KIRO_PROVIDER_KEY) {
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const validTokens = apiKeys.filter(k => typeof k === 'string' && k.trim())
        if (validTokens.length === 0) {
          delete providerConfig.refreshToken;
          clearKiroAuthMetadata(providerConfig);
        } else {
          clearKiroAuthMetadata(providerConfig);
          providerConfig.refreshToken = validTokens[0].trim();
          providerConfig.authMode = 'manual-token';
        }
        delete currentConfig.apiKeys[providerKey];
        clearKiroTokenCaches();
        didUpdateKiroAuth = true;
      } else if (providerKey === OPENAI_CODEX_PROVIDER_KEY) {
        // A bulk write for Codex is a list of ChatGPT refresh tokens, i.e. the
        // account pool itself (metadata is re-learned from each token).
        const validTokens = apiKeys.filter(k => typeof k === 'string' && k.trim())
        setProviderAccounts(currentConfig, providerKey, validTokens.map(secret => ({ secret: secret.trim() })))
        delete currentConfig.apiKeys[providerKey];
        clearCodexAuthCaches();
      } else {
        const validKeys = apiKeys.filter(k => typeof k === 'string' && k.trim())
        if (validKeys.length === 0) {
          delete currentConfig.apiKeys[providerKey];
        } else if (validKeys.length === 1) {
          currentConfig.apiKeys[providerKey] = validKeys[0].trim()
        } else {
          currentConfig.apiKeys[providerKey] = validKeys.map(k => k.trim())
        }
      }
    }

    if (useBearerAuth !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      currentConfig.providers[providerKey].useBearerAuth = useBearerAuth !== false;
    }

    if (baseUrl !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (baseUrl === null || baseUrl === '') delete currentConfig.providers[providerKey].baseUrl;
      else currentConfig.providers[providerKey].baseUrl = String(baseUrl).trim();
    }

    if (modelId !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (modelId === null || modelId === '') delete currentConfig.providers[providerKey].modelId;
      else currentConfig.providers[providerKey].modelId = String(modelId).trim();
    }

    // The fields a templated endpoint needs beyond the key — Cloudflare's account id,
    // Vertex's project and region. They are not secrets, but they are the difference between a
    // provider that can be probed and one that cannot, and until now the only way in was an env
    // var or hand-editing the config. Only fields the provider's own descriptor declares are
    // accepted, so this cannot become a way to write arbitrary keys into a provider's config.
    if (credentialFields !== undefined && credentialFields && typeof credentialFields === 'object') {
      const writes = credentialFieldWrites(getBaseProviderKey(providerKey), credentialFields)
      if (Object.keys(writes).length > 0) {
        if (!currentConfig.providers) currentConfig.providers = {};
        if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
        for (const [field, value] of Object.entries(writes)) {
          if (value === null) delete currentConfig.providers[providerKey][field];
          else currentConfig.providers[providerKey][field] = value;
        }
        if (Object.keys(currentConfig.providers[providerKey]).length === 0) delete currentConfig.providers[providerKey];
      }
    }

    if (discoverModels !== undefined && isOpenAICompatibleInstanceKey(providerKey)) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (discoverModels === false) currentConfig.providers[providerKey].discoverModels = false;
      else delete currentConfig.providers[providerKey].discoverModels;
    }

    if (pinningMode !== undefined) {
      currentConfig.pinningMode = pinningMode === 'exact' ? 'exact' : 'canonical';
    }

    if (logRequestContent !== undefined) {
      currentConfig.logRequestContent = logRequestContent !== false;
    }
    if (persistRequestLogs !== undefined) {
      currentConfig.persistRequestLogs = persistRequestLogs !== false;
    }

    saveConfig(currentConfig);

    // Giving a provider its credentials must surface its models immediately: run
    // discovery + pings for that provider right away instead of waiting for the
    // next periodic ping wave. There is no enable/disable write any more — every
    // provider is always enabled — so this chain is credential-driven only.
    const providerHasKeyAfterSave = providerKey !== KIRO_PROVIDER_KEY && getApiKeyPool(currentConfig, providerKey).length > 0;
    const keyFieldsWereWritten = apiKey !== undefined || (Array.isArray(apiKeys) && apiKeys.some(k => typeof k === 'string' && k.trim()));
    if (providerKey === KIRO_PROVIDER_KEY && didUpdateKiroAuth) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === GITHUB_COPILOT_PROVIDER_KEY && keyFieldsWereWritten) {
      // A pasted GitHub token behaves like a device-flow sign-in, and clearing it is a
      // sign-out. Refresh either way (the ping helper refreshes Copilot first, which
      // reverts to the curated fallback once no token remains).
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENAI_CODEX_PROVIDER_KEY && keyFieldsWereWritten) {
      // Same for a pasted refresh token: discovering the account's models (or
      // reverting to the curated fallback after a sign-out) is a refresh away.
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === EMPERO_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if (isProviderAuthOptional(currentConfig, providerKey) && (apiKey !== undefined || useBearerAuth !== undefined)) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENROUTER_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if ((isOpenAICompatibleInstanceKey(providerKey) || providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) && (apiKey !== undefined || baseUrl !== undefined || modelId !== undefined || discoverModels !== undefined)) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerHasKeyAfterSave && keyFieldsWereWritten) {
      // Generic keyed providers (Groq, Google AI, Codestral, ...): a key write means the
      // provider may now serve models, so refresh them.
      void triggerImmediateProviderPing(providerKey);
    } else if (credentialFields !== undefined) {
      // A templated endpoint just gained (or lost) the field its URL embeds, which is exactly
      // what decides whether its model list can be read at all: re-probe it either way, so the
      // card moves from "needs accountId" to a real count without a second click.
      void triggerImmediateProviderPing(providerKey);
    }

    res.json({ success: true });
  });

  app.get('/api/filter-rules', (req, res) => {
    const currentConfig = loadConfig();
    res.json({
      minSweScore: currentConfig.minSweScore,
      excludedProviders: currentConfig.excludedProviders || [],
      qosLatencyTargetMs: currentConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS,
    });
  });

  app.post('/api/filter-rules', (req, res) => {
    const { minSweScore, excludedProviders, qosLatencyTargetMs } = req.body;
    const currentConfig = loadConfig();

    if (minSweScore !== undefined) {
      if (minSweScore === null || minSweScore === '') {
        currentConfig.minSweScore = null;
      } else {
        const parsed = Number(minSweScore);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          currentConfig.minSweScore = parsed;
        } else {
          return res.status(400).json({ error: 'minSweScore must be a number between 0 and 1, or null.' });
        }
      }
    }

    if (excludedProviders !== undefined) {
      if (Array.isArray(excludedProviders)) {
        currentConfig.excludedProviders = excludedProviders.filter(p => typeof p === 'string');
      } else {
        return res.status(400).json({ error: 'excludedProviders must be an array of provider keys.' });
      }
    }

    if (qosLatencyTargetMs !== undefined) {
      if (qosLatencyTargetMs === null || qosLatencyTargetMs === '') {
        currentConfig.qosLatencyTargetMs = null;
      } else {
        const parsed = Number(qosLatencyTargetMs);
        if (Number.isFinite(parsed) && parsed > 0) {
          currentConfig.qosLatencyTargetMs = parsed;
        } else {
          return res.status(400).json({ error: 'qosLatencyTargetMs must be a positive number of milliseconds, or null.' });
        }
      }
    }

    saveConfig(currentConfig);

    res.json({
      success: true,
      minSweScore: currentConfig.minSweScore,
      excludedProviders: currentConfig.excludedProviders || [],
      qosLatencyTargetMs: currentConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS,
    });
  });

  app.post('/api/models/ban', (req, res) => {
    const { modelId, banned } = req.body;
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    const currentConfig = loadConfig();
    let currentBans = currentConfig.bannedModels || [];

    if (banned) {
      if (!currentBans.includes(modelId)) currentBans.push(modelId);
      if (!bannedModels.includes(modelId)) bannedModels.push(modelId);
    } else {
      currentBans = currentBans.filter(m => m !== modelId);
      bannedModels = bannedModels.filter(m => m !== modelId);
    }

    currentConfig.bannedModels = currentBans;
    saveConfig(currentConfig);

    // Apply status change immediately to every row that matches the id (the same model
    // can exist under multiple providers with a duplicate modelId).
    const matches = results.filter(r => r.modelId === modelId || getRoutingModelKey(r) === modelId);
    for (const model of matches) {
      if (banned) {
        model.status = 'banned';
      } else {
        model.status = 'down'; // Let the next test/probe figure it out
        model.pings = [];
      }
    }

    // If the banned model was pinned, clear the pin
    if (banned && pinnedModelId === modelId) {
      pinnedModelId = null;
      pinnedProviderKey = null;
    }

    res.json({ success: true, bannedModels: currentBans });
  });

  app.post('/api/models/ping', async (req, res) => {
    const { modelId, providerKey } = req.body || {};
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    // `providerKey` names the row the caller is looking at. Without it the first row carrying
    // that model id wins — which, for a model served by several providers (or one whose id is an
    // alias of another row's), is not necessarily the one the caller meant.
    //
    // A caller that names a row gets that row or a 404, never a substitute: falling back to the
    // first row with that id would answer about a *different* provider than the one named, which
    // is the mistake this parameter exists to prevent. Callers that send no providerKey (anything
    // older than this parameter) keep the id-only behaviour.
    const model = providerKey
      ? results.find(r => r.providerKey === providerKey && r.modelId === modelId) || null
      : results.find(r => r.modelId === modelId);
    if (!model) return res.status(404).json({ error: 'Model not found' });

    try {
      await pingModel(model);
      res.json({
        success: true,
        model: {
          modelId: model.modelId,
          providerKey: model.providerKey,
          status: model.status,
          avg: getAvg(model),
          uptime: getUptime(model),
          verdict: getVerdict(model),
          lastPing: model.pings.length > 0 ? model.pings[model.pings.length - 1].ms : null,
          pings: model.pings,
          httpCode: model.httpCode,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to ping model' });
    }
  });

  const LOGS_PATH = join(homedir(), '.hammer-logs.json');
  // Keep disk + in-memory windows consistent (requestLogs is capped at 50 in the handler).
  const MAX_DISK_LOGS = 50;

  // Load persisted logs from disk on startup
  let requestLogs = [];
  if (existsSync(LOGS_PATH)) {
    try {
      const raw = readFileSync(LOGS_PATH, 'utf8');
      requestLogs = JSON.parse(raw);
      if (!Array.isArray(requestLogs)) requestLogs = [];
      console.log(chalk.dim(`  📋 Loaded ${requestLogs.length} persisted log entries`));
    } catch {
      requestLogs = [];
    }
  }

  function saveLogs() {
    try {
      const toSave = requestLogs.slice(0, MAX_DISK_LOGS);
      writeFileSync(LOGS_PATH, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch { /* silently fail */ }
  }

  // Debounce disk writes so a burst of requests doesn't do a synchronous write per
  // request on the hot path; the trailing write captures the latest state.
  let logSaveTimer = null;
  function scheduleLogSave() {
    clearTimeout(logSaveTimer);
    logSaveTimer = setTimeout(() => saveLogs(), 2000);
  }

  // Number(null) is 0, which used to pass the finite/non-negative checks in
  // applyUsageDerivedMetrics and stamp a row with a fabricated measurement — "0 tok/s"
  // (and a 0 ms TTFT) in the table as if it had been observed, while the speed plot
  // read the zero as proof of zero throughput and dropped the row from the scatter. A
  // value that was never measured has to stay absent, so the row reads "—" instead.
  function measuredNumberOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Projects the usage-derived speed numbers onto the result row itself. The
  // dashboard has always received them through /api/models, but the rows the
  // selector evaluates are the internal ones, which never carried ttft/tps — so
  // computeRowSpeed() returned null for every row and the slope-line pick silently
  // resolved to nothing, leaving 'smartest' routes on the Elo ranking forever.
  // One definition, used by the payload, the KPI, and the router, so all three can
  // never disagree about which model the line touches.
  function applyUsageDerivedMetrics(result) {
    if (!result) return result;
    const entry = usageStats.get(`${result.providerKey}::${result.modelId}`);
    const averages = computeUsageAverages(entry);
    // A response written by an older server may predate the numeric counters; the
    // last test response is then authoritative for TTFT / tok-per-second — but only
    // when it actually answered. A failed call measures how long the provider took to
    // refuse, so a 429 or a timeout must never become the row's speed: that is how a
    // rate-limited row came to advertise "0.35s avg" for a request that returned
    // nothing. Same rule the retry path applies when it decides whether a 2xx was a
    // real response before counting it as a healthy sample.
    const lastResponse = entry?.lastResponse || null;
    const served = lastResponse
      && lastResponse.ok !== false
      && !lastResponse.error
      && typeof lastResponse.text === 'string'
      && lastResponse.text.trim() !== ''
      ? lastResponse
      : null;
    const lastTtft = measuredNumberOrNull(served?.ttftMs);
    const lastTps = measuredNumberOrNull(served?.tps);
    result.ttft = averages.ttft ?? (lastTtft != null && lastTtft >= 0 ? lastTtft : null);
    result.tps = averages.tps ?? (lastTps != null && lastTps >= 0 ? lastTps : null);
    // Which kind of sample each number is, so the dashboard can label a lone most-recent
    // measurement as one instead of calling it an average it never computed.
    result.ttftSource = result.ttft == null ? null : (averages.ttft != null ? 'average' : 'last');
    result.tpsSource = result.tps == null ? null : (averages.tps != null ? 'average' : 'last');
    // The mean length of the responses that produced output, or the single measured
    // response when there are no averages yet. Nothing computes a speed from it any more —
    // the score is taken at a fixed reference length (see SPEED_REFERENCE_TOKENS) so two
    // rows measured over different answers are comparable — but the dashboard shows it
    // beside that score, so the sample the numbers came from is still visible.
    const lastTokens = measuredNumberOrNull(served?.completionTokens);
    result.speedTokens = averages.tokens ?? (lastTokens != null && lastTokens > 0 ? lastTokens : null);
    result.lastResponse = lastResponse;
    result.lastProxiedAt = typeof entry?.lastServedAt === 'number' ? entry.lastServedAt : 0;
    // Status is the slave of the test column, with live proxy usage exceptions
    result.status = resolveModelStatus(result);
    if (result.status === 'up') {
      result.httpCode = null;
      result.lastError = null;
    }
    return result;
  }

  // `countProxyRequest` is false for a manual Test: the sample is real usage, but it did not
  // pass through the /v1 proxy, and dailyProxyCount is the counter the dashboard reads as
  // proxied traffic (see /api/models) — a button click is not a request the router served.
  //
  // `deferSave` lets a caller that records several things in one operation (the test path:
  // a usage sample, then a rate-limit capture, then the response record) pay for one atomic
  // write instead of one per step.
  function recordUsage(result, sample, { countProxyRequest = true, deferSave = false } = {}) {
    if (!result) return;
    const key = `${result.providerKey}::${result.modelId}`;
    usageStats.set(key, accumulateUsageSample(usageStats.get(key), sample));

    if (countProxyRequest) {
      // -- Daily proxy request counter (increment every request, reset at midnight UTC) --
      const entry = usageStats.get(key);
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      if (!entry.dailyDate || entry.dailyDate !== today) {
        entry.dailyDate = today;
        entry.dailyProxyCount = 1;
      } else {
        entry.dailyProxyCount = (entry.dailyProxyCount || 0) + 1;
      }
    }

    applyUsageDerivedMetrics(result);
    if (!deferSave) saveUsageStats();
  }

  // Effective "when did this model+provider last serve a successful request".
  // Combines in-memory traffic (proxy/test successes) with evidence persisted
  // across restarts: the lastServedAt of proxied responses and the timestamp of
  // the last successful manual Test. Ping verdicts use this so a restarted
  // session doesn't contradict a test the user just saw succeed.
  function getLastServedAt(result) {
    const usageEntry = usageStats.get(`${result.providerKey}::${result.modelId}`);
    let servedAt = result.lastModelResponseAt || 0;
    if (usageEntry) {
      if (typeof usageEntry.lastServedAt === 'number' && usageEntry.lastServedAt > servedAt) {
        servedAt = usageEntry.lastServedAt;
      }
      // A test counts as liveness only under the same rules the ready-check uses: a clean,
      // non-expired success. Reading it as "any record without an error" let a response that never
      // carried usable text — or one whose window had already expired — keep extending the keep-up
      // window above, and that window decides whether a failing probe may be ignored.
      const lastTest = usageEntry.lastResponse;
      if (isLastResponseReady(lastTest) && typeof lastTest.at === 'number' && lastTest.at > servedAt) {
        servedAt = lastTest.at;
      }
    }
    return servedAt;
  }

  // Persists the last manual 'Test' response for a model/provider so the dashboard's
  // Response column survives reloads/restarts. Kept separate from the numeric usage
  // stats (accumulateUsageSample spreads prev, so this field rides along untouched).
  function recordTestResponse(result, info, { deferSave = false } = {}) {
    if (!result) return;
    const key = `${result.providerKey}::${result.modelId}`;
    const prev = usageStats.get(key) || {};
    usageStats.set(key, { ...prev, lastResponse: info });
    applyUsageDerivedMetrics(result);
    if (!deferSave) saveUsageStats();
  }

  // Records an observed context-window bound from a failed request. Only acts when
  // the failure is evidence about the *context window*: a provider-stated maximum
  // (exact upper bound), or a body that genuinely says the prompt itself was too
  // large (the prompt size we sent is then a soft ceiling).
  //
  // Throughput quotas and output-token caps are refused here by construction. Groq
  // answers "Request too large … on output tokens per minute (OTPM): Limit 1000,
  // Requested 1413" — an output budget and a per-minute quota — and the old gate
  // (isOverLengthErrorText) accepted it, so the prompt size or the quota number became
  // the model's context window and struck the row out of the table for good.
  function recordContextObservation(result, errorText, messages) {
    if (!result || !errorText) return;
    const text = String(errorText);
    const limit = parseContextLimitFromError(text);
    let observation = null;
    if (limit != null) {
      observation = { maxTokens: limit, exact: true, evidence: text };
    } else if (isContextOverflowErrorText(text)) {
      observation = { maxTokens: estimateMessageTokens(messages), exact: false, evidence: text };
    }
    if (!observation) return;
    const key = `${result.providerKey}::${result.modelId}`;
    usageStats.set(key, accumulateContextObservation(usageStats.get(key), observation));
    saveUsageStats();
  }

  // The output ceiling a provider has already stated for this row, or null.
  function outputCapFor(result) {
    const cap = Number(usageStats.get(`${result.providerKey}::${result.modelId}`)?.maxOutputTokens);
    return Number.isFinite(cap) && cap > 0 ? cap : null;
  }

  // Remembers a provider's own "`max_tokens` must be less than or equal to `N`" for
  // this row, so the next request to it is legal on the first try instead of spending
  // another round trip on a rejection the router has already read.
  function rememberOutputCap(result, cap, evidence) {
    const key = `${result.providerKey}::${result.modelId}`;
    const prev = usageStats.get(key);
    const next = accumulateOutputCapObservation(prev, { cap, evidence });
    if (next === prev) return false;
    usageStats.set(key, next);
    saveUsageStats();
    return true;
  }

  // Flattens a parsed log error (string, {error:{message}}, {message}, or JSON) to text.
  function extractErrorText(err) {
    if (!err) return '';
    let payload = err;
    if (typeof err === 'string') {
      const trimmed = err.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { payload = JSON.parse(trimmed); } catch {}
      }
    }
    const msg = extractErrorMessage(payload);
    if (msg) return msg;
    return typeof err === 'string' ? err : JSON.stringify(err);
  }

  app.get('/api/logs', (req, res) => {
    res.json(requestLogs);
  });

  // GET current pinned model
  app.get('/api/pinned', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    res.json({
      pinnedModelId,
      pinnedProviderKey,
      pinnedModelIds: pinnedMatches.map(r => r.modelId),
      pinnedRowKeys: pinnedMatches.map(toPinnedRowKey),
      pinningMode,
    });
  });

  // POST to set or clear the pinned model
  app.post('/api/pinned', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const { modelId, providerKey } = req.body;
    // modelId = null/undefined clears the pin (auto mode)
    pinnedModelId = modelId || null;
    pinnedProviderKey = modelId ? (providerKey || null) : null;
    console.log(chalk.cyan(`  [Router] 📌 Pinned model set to: ${pinnedModelId || '(auto)'}`));
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    res.json({
      success: true,
      pinnedModelId,
      pinnedProviderKey,
      pinnedModelIds: pinnedMatches.map(r => r.modelId),
      pinnedRowKeys: pinnedMatches.map(toPinnedRowKey),
      pinningMode,
    });
  });

  // POST /api/context-bounds/reset — drop learned context bounds so the row falls back
  // to catalog/provider-reported data. A learned bound is a conclusion drawn from one
  // error body; when that body turns out to have been misread (a quota, an output-cap
  // message), or the provider's real limit changed, the only way out used to be editing
  // ~/.hammer-usage.json by hand. Scope it with { providerKey, modelId }: modelId alone
  // clears that row, providerKey alone clears the provider's rows, neither clears all.
  app.post('/api/context-bounds/reset', (req, res) => {
    const providerKey = typeof req.body?.providerKey === 'string' ? req.body.providerKey.trim() : '';
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    const cleared = [];
    for (const [key, entry] of usageStats) {
      const next = clearContextBound(entry);
      if (next === entry) continue;
      const row = parseUsageStatKey(key);
      if (providerKey && row.providerKey !== providerKey) continue;
      if (modelId && row.modelId !== modelId) continue;
      usageStats.set(key, next);
      cleared.push(key);
    }
    if (cleared.length > 0) saveUsageStats();
    console.log(chalk.cyan(`  [Router] 🧹 Cleared learned context bound${cleared.length === 1 ? '' : 's'} for ${cleared.length} row${cleared.length === 1 ? '' : 's'}${providerKey ? ` (provider ${providerKey})` : ''}.`));
    res.json({ success: true, cleared });
  });

  // GET the slope-line selector settings (dashboard Intelligence-vs-Speed plot)
  app.get('/api/selector', (req, res) => {
    // The effective values, not the raw config: a pre-AA config is converted on the
    // way out, so the dashboard's sliders show the scale the router actually uses.
    const sel = effectiveSelectorSettings();
    res.json({
      enabled: true, // always active — there is no enable toggle anymore
      slope: sel.slope,
      minSpeed: sel.minSpeed,
      minIntell: sel.minIntell,
    });
  });

  // POST to update the slope-line selector settings. Numbers must be non-negative;
  // null or an empty string clears a value (slope null keeps the selector inert).
  // The selector is always active, so `enabled` is deliberately not accepted.
  app.post('/api/selector', (req, res) => {
    const { slope, minSpeed, minIntell } = req.body || {};
    const currentConfig = loadConfig();
    if (!currentConfig.selector || typeof currentConfig.selector !== 'object' || Array.isArray(currentConfig.selector)) {
      currentConfig.selector = { enabled: true, slope: null, minSpeed: null, minIntell: null };
    }
    const sel = currentConfig.selector;

    let bad = null;
    const trySet = (key, value) => {
      if (bad || value === undefined) return;
      if (value === null || value === '') { sel[key] = null; return; }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) { bad = key; return; }
      sel[key] = n;
    };
    trySet('slope', slope);
    trySet('minSpeed', minSpeed);
    trySet('minIntell', minIntell);
    if (bad) return res.status(400).json({ error: `${bad} must be a non-negative number or null.` });

    sel.enabled = true;
    saveConfig(currentConfig);
    // No console note here: the dashboard posts this while the slope slider is dragged
    // (debounced at 300ms), so one drag wrote a line per save.
    res.json({ success: true, selector: { enabled: true, slope: sel.slope, minSpeed: sel.minSpeed, minIntell: sel.minIntell } });
  });

  // Sends a short-answer request to a specific provider+model (or the best-ranked
  // member of a group, using the same QoS ranking the router uses) and returns the raw
  // response text (errors included). The request is a real proxied completion, so it
  // also records usage stats (TTFT, tok/s, context bounds) for the model/provider.
  // The question a Test asks is module-level (see buildModelTestPrompt), and so is the marker
  // that makes it unique per click. The question is unchanged from click to click, which is what
  // keeps two clicks — and two rows — comparable; only the marker moves.
  // The output budget a test may spend. An open-ended quip invites more than it asks for; this
  // covers a model that runs with it and stops a chatty one from spending the old generous 16384
  // budget on every model of a retest.
  const TEST_MAX_TOKENS = 64;
  // A reasoning model spends tokens before it emits a single visible character, so a 30-word ask
  // can come back cut off with nothing to show for it (see the headroom retry below). This is the
  // budget that retry uses — the probe's PROBE_RETRY_MAX_TOKENS was chosen for the same reason,
  // and this size keeps a catalog-wide retest affordable while leaving room for a real answer.
  const TEST_REASONING_RETRY_MAX_TOKENS = 512;
  // How many attempts one test may spend. The first is the request itself; the others answer two
  // refusals worth re-asking rather than believing: a provider-stated max_tokens cap, and an
  // output budget this model spent entirely on reasoning.
  const MAX_TEST_ATTEMPTS = 3;
  // Hard cap on how long *one attempt* of a test request may take. A timeout error is persisted
  // with an expiry so the dashboard auto-clears it once the same window elapses.
  const TEST_TIMEOUT_MS = 60_000;
  // How long anything that *calls* this endpoint has to wait for it. One test may legitimately
  // spend all MAX_TEST_ATTEMPTS attempts, each with its own TEST_TIMEOUT_MS budget, so a caller
  // that gives up sooner reports a failure for a test still running — and reports nothing about
  // the answer that lands a moment later. The bulk-retest job and the dashboard's Test button
  // both use this figure.
  const TEST_CALLER_BUDGET_MS = MAX_TEST_ATTEMPTS * TEST_TIMEOUT_MS + 30_000;
  app.post('/api/test-model', async (req, res) => {
    try {
      const { providerKey, modelId, members } = req.body || {};
      const candidateKey = (provider, id) => `${provider || ''}::${id || ''}`;
      const modelIdMatches = (requestedId, resultId) => {
        const requested = String(requestedId || '').trim();
        const actual = String(resultId || '').trim();
        if (!requested || !actual) return false;
        if (requested === actual) return true;
        if (resolveAliasedModelId(requested) === resolveAliasedModelId(actual)) return true;
        const requestedCanonical = canonicalizeModelId(requested);
        const actualCanonical = canonicalizeModelId(actual);
        return requestedCanonical.base === actualCanonical.base
          || requestedCanonical.unprefixed === actualCanonical.unprefixed;
      };
      const findCandidate = (provider, id) => {
        if (!provider || !id) return null;
        return results.find(result => result.providerKey === provider && result.modelId === id)
          || results.find(result => result.providerKey === provider && modelIdMatches(id, result.modelId));
      };

      let candidates = [];
      if (providerKey && modelId) {
        const candidate = findCandidate(providerKey, modelId);
        if (candidate) candidates = [candidate];
      } else if (Array.isArray(members) && members.length > 0) {
        const resolved = members
          .map(member => findCandidate(member?.providerKey, member?.modelId))
          .filter(Boolean);
        const seen = new Set();
        candidates = resolved.filter(candidate => {
          const key = candidateKey(candidate.providerKey, candidate.modelId);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (candidates.length === 0) {
        const requested = providerKey && modelId
          ? `${providerKey}/${modelId}`
          : 'the selected model group';
        return res.status(404).json({ ok: false, error: `Model not found in the active catalog: ${requested}.` });
      }

      // Pick the best candidate with the same QoS ranking the router uses for a selected group.
      const currentConfig = loadConfig();
      const qosOptions = { latencyTargetMs: currentConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS };
      const ranked = rankModelsForRouting(candidates, [], qosOptions);
      const best = ranked[0] || candidates[0];

      // Persists any test outcome (success or error) so it survives reloads, then
      // responds to the client. `expiresAt` (set on timeout errors) lets the
      // dashboard clear the result once the timeout window has passed.
      const finishTest = (info) => {
        recordTestResponse(best, {
          text: info.text ?? null,
          error: info.error ?? null,
          status: info.status ?? 0,
          ok: info.ok === true,
          at: Date.now(),
          ttftMs: info.ttftMs ?? null,
          // The whole response time, so a response that measured no rate (it did not stream to
          // us) can say how long it took instead of leaving the dashboard silent about it.
          durationMs: info.durationMs ?? null,
          tps: info.tps ?? null,
          tokens: info.tokens ?? null,
          completionTokens: info.completionTokens ?? null,
          rateLimitResetAt: info.rateLimitResetAt ?? null,
          expiresAt: info.expiresAt ?? null,
          paymentRequired: info.paymentRequired === true,
          dead: info.dead === true,
          incompatible: info.incompatible === true,
          overloaded: info.overloaded === true,
        }, { deferSave: true });
        // An early exit still writes the record it just made — once, atomically.
        saveUsageStats();
        res.json({
          ok: info.ok === true,
          providerKey: best.providerKey,
          modelId: best.modelId,
          status: info.status ?? 0,
          text: info.text ?? null,
          error: info.error ?? null,
          ttftMs: info.ttftMs ?? null,
          durationMs: info.durationMs ?? null,
          tps: info.tps ?? null,
          tokens: info.tokens ?? null,
          rateLimitResetAt: info.rateLimitResetAt ?? null,
          expiresAt: info.expiresAt ?? null,
          paymentRequired: info.paymentRequired === true,
          dead: info.dead === true,
          incompatible: info.incompatible === true,
          overloaded: info.overloaded === true,
        });
      };

      const rotKey = getNextApiKey(currentConfig, best.providerKey);
      let providerAuth = rotKey
        ? { token: rotKey, authSource: 'api-key', providerUrlOverride: null }
        : await resolveProviderAuthToken(currentConfig, best.providerKey);
      let providerUrl = resolveProviderUrl(currentConfig, best.providerKey, providerAuth.providerUrlOverride, best.providerUrl);

      if (!providerAuth.token && !isProviderAuthOptional(currentConfig, best.providerKey)) {
        return finishTest({ ok: false, error: `No API key configured for provider ${best.providerKey}.`, status: 0 });
      }

      let payload = {
        model: best.modelId,
        messages: [{ role: 'user', content: buildModelTestPrompt() }],
        // Streaming, so a test measures what real usage measures: a real time-to-first-token
        // and the generation window the answer's own frames span. Both come from the same rules
        // the proxy applies to live traffic (see readStreamedAnswer), which is what makes the
        // test's tok/s comparable to the row's instead of a wall-clock rate.
        stream: true,
        // A model whose ceiling the provider already stated gets a legal budget up
        // front, so a manual test never spends its first attempt on a rejection the
        // router has already read (the retry below still covers a first-time cap).
        max_tokens: Math.min(TEST_MAX_TOKENS, outputCapFor(best) ?? TEST_MAX_TOKENS),
      };

      if (!providerUrl) {
        return finishTest({ ok: false, error: `No provider URL configured for provider ${best.providerKey}.`, status: 0 });
      }

      const codexOptions = best.providerKey === OPENAI_CODEX_PROVIDER_KEY
        ? { codexAccountId: providerAuth.account?.accountId || null, codexResidency: providerAuth.account?.residency || null }
        : {};
      const headers = buildProviderRequestHeaders(best.providerKey, {
        apiKey: providerAuth.token,
        isExplicitFreemodelsKey: isExplicitFreemodelsKey(currentConfig, best.providerKey),
        messages: payload?.messages,
        ...codexOptions,
      });
      const kiroOptions = best.providerKey === KIRO_PROVIDER_KEY
        ? { profileArn: currentConfig?.providers?.kiro?.profileArn || null }
        : {};
      let devinOptions = {};
      if (best.providerKey === DEVIN_PROVIDER_KEY) {
        const storedUserJwt = currentConfig?.providers?.[DEVIN_PROVIDER_KEY]?.userJwt || null;
        try {
          const devinAuth = await fetchDevinUserJwt(providerAuth.token, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
          devinOptions = {
            apiKey: providerAuth.token,
            sessionId: makeProviderSessionId('ses'),
            userJwt: devinAuth.userJwt || storedUserJwt,
          };
          if (devinAuth.customApiServerUrl) {
            providerUrl = `${String(devinAuth.customApiServerUrl).replace(/\/+$/, '')}${DEVIN_CHAT_PATH}`;
          }
        } catch (err) {
          return finishTest({ ok: false, error: err?.message || 'Devin auth failed.', status: 0 });
        }
      }
      let providerPayload = buildProviderRequestBody(best.providerKey, payload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions });

      const t0 = performance.now();
      let response = null;
      let text = '';
      // The answer's frame times for the attempt that succeeded (see readStreamedAnswer).
      let streamFacts = null;
      // Set when the provider answered from its own response cache rather than serving this
      // click (see isCachedReplayResponse). A replayed answer is evidence the model is
      // reachable and nothing more — it was not generated now, and the usage it reports is the
      // original generation's — so it is kept out of every measurement this path records.
      let cacheReplay = false;
      // The answer a successful attempt produced, kept so the headroom retry can read its finish
      // reason without parsing the transcript twice. Cleared with streamFacts on a failed attempt,
      // or a retry would judge itself against the answer it is replacing.
      let streamedAnswer = null;
      let attemptT0 = t0;
      // Time to the provider's response *headers* on the attempt that ends up being judged, in
      // the same terms every other writer uses for this row: the proxy records
      // attemptMeta.duration as soon as fetch() resolves, and so does the probe. This path used
      // to push the whole request duration instead, which put a 30-word answer's generation time
      // into the very series getAvg() averages and latencyScore() scores QoS from — so one Test
      // click moved the row's displayed latency, and its routing rank, by a value no other
      // sample in that series contains.
      let headersMs = null;
      // Some providers cap max_tokens below the test's own budget and reject the
      // request outright ("max_tokens must be less than or equal to 8192...").
      // Retry once with the stated cap so the test can still run; the failed
      // attempt already records the cap as a context bound for this model.
      for (let attempt = 0; attempt < MAX_TEST_ATTEMPTS && !response; attempt++) {
        attemptT0 = performance.now();
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: serializeProviderRequestBody(providerPayload),
            signal: ctrl.signal,
          });
          headersMs = Math.round(performance.now() - attemptT0);
          // Read the provider's own cache verdict before anything replaces the response object:
          // the Kiro, Devin, Codex, FreeModels and gptfree translators each build a new Response
          // and carry no headers over.
          cacheReplay = isCachedReplayResponse(response.headers);
          // The transforms take the same stream flag the proxy passes them, so a provider
          // whose response has to be converted (Kiro, Devin, Codex, FreeModels) converts it
          // into the same frames this path then reads and times.
          if (best.providerKey === KIRO_PROVIDER_KEY && response.ok) {
            response = await transformKiroResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === DEVIN_PROVIDER_KEY && response.ok) {
            response = await transformDevinResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === OPENAI_CODEX_PROVIDER_KEY && response.ok) {
            response = await transformCodexResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === FREEMODELS_PROVIDER_KEY && response.ok) {
            response = await transformFreeModelsResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === GPTFREE_PROVIDER_KEY && response.ok) {
            // gptfree answers only in its own named-event SSE, so the test reads the
            // translated frames like every other provider's, and its mid-stream error
            // frames become the failure this path already knows how to report.
            response = await transformGptFreeResponse(response, best.modelId, Boolean(payload.stream));
          } else if (payload.stream && response.ok) {
            // The same generic guard the proxy applies to every other provider (see its own
            // The same generic guard the proxy applies to every other provider (see its own
            // `payload.stream` branch): a relay that opens a 200 stream with an error frame — as
            // g4f does when its pool is rate limiting — becomes the synthetic 503 the error
            // handling below already understands. Without it a rate limit arrived as a "success"
            // with no text, and the row was struck out as a model that cannot chat.
            response = await transformStreamingUpstreamErrorResponse(response);
          }
          // A successful test is consumed as the stream it asked for, so the answer's own frames
          // can be timed; an error response is a plain body either way, and the max_tokens retry
          // below has to inspect that body as text.
          if (response.ok) {
            streamFacts = await readStreamedAnswer(response, attemptT0);
            text = streamFacts.transcript;
            streamedAnswer = summarizeTestAnswer(text);
            const upstreamModel = extractUpstreamModelId(text);
            if (upstreamModel) rememberUpstreamModelId(best, upstreamModel);
          } else {
            streamFacts = null;
            streamedAnswer = null;
            text = await response.text();
          }
        } catch (err) {
          const msg = err?.message || 'Network error';
          const isTimeout = err?.name === 'AbortError' || /timeout|timed out|etimedout/i.test(`${msg} ${err?.cause?.code || ''}`);
          // A manual test that never reached the provider is the same evidence a failed probe is,
          // so it counts towards the same outage bench.
          noteProviderUnreachable(
            providerScopeKey(best),
            isTimeout ? `manual test timed out after ${TEST_TIMEOUT_MS / 1000}s` : msg,
            `${best.providerKey}/${best.modelId}`,
            { reprobe: true },
          );
          return finishTest({
            ok: false,
            error: isTimeout ? `Request timed out after ${TEST_TIMEOUT_MS / 1000}s.` : msg,
            status: 0,
            expiresAt: null,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        if (response.ok) {
          // A reasoning model can spend the entire output budget before emitting one visible
          // character: g4f's deepseek-v4-pro-0813 answered with 64/64 tokens of reasoning_content,
          // finish_reason 'length', and nothing else, which this path used to report as a model
          // that cannot chat. The provider is saying the answer was cut off — a statement about
          // the budget this test chose, not about the model — so it earns the same headroom retry
          // the probe gives an empty 1-token answer (see PROBE_MAX_TOKENS/
          // PROBE_RETRY_MAX_TOKENS), once, and only while a bigger budget could change the outcome.
          const spentBudgetOnReasoning = streamedAnswer
            && streamedAnswer.finishReason === 'length'
            && !streamedAnswer.text.trim()
            && streamedAnswer.outputText.trim().length > 0;
          // A stated output ceiling still outranks this budget, exactly as it does for the
          // first attempt.
          const retryCap = Math.min(TEST_REASONING_RETRY_MAX_TOKENS, outputCapFor(best) ?? TEST_REASONING_RETRY_MAX_TOKENS);
          // Only ask again while an attempt is left to spend. Asking on the last one left
          // `response` null for the code below to dereference; the answer that asked for more
          // headroom is still this row's answer, so it is judged here instead (reasoning-only,
          // truncated) rather than discarded.
          if (spentBudgetOnReasoning && payload.max_tokens < retryCap && attempt + 1 < MAX_TEST_ATTEMPTS) {
            payload = { ...payload, max_tokens: retryCap };
            providerPayload = buildProviderRequestBody(best.providerKey, payload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions });
            response = null;
            continue;
          }
          break;
        }
        const cap = parseMaxTokensCapFromError(extractErrorText(text));
        if (cap != null && payload.max_tokens > cap) {
          // Retry with the provider's stated output cap. Whether this body also says
          // something about the model's context is recordContextObservation's call, not
          // this branch's: a pure output budget (Groq's "`max_tokens` must be less than
          // or equal to `8192`", with its "…is less than the `context_window`…" tail) is
          // refused there, while a vLLM "max_model_len=max_total_tokens=N" body still
          // records the real total-context cap. Both used to land here as a context
          // window, which is what taught the Groq compound rows a false 8k ceiling.
          recordContextObservation(best, extractErrorText(text), payload.messages);
          // A ceiling stated to a test is the same fact the proxy needs, so record it
          // here too: a model tested before it is proxied then starts out legal.
          rememberOutputCap(best, cap, extractErrorText(text));
          // The cap is learned either way; only the re-ask needs an attempt to spend. On the
          // last one the provider's own refusal stands as the verdict, which is honest about
          // what this test got.
          if (attempt + 1 < MAX_TEST_ATTEMPTS) {
            payload = { ...payload, max_tokens: cap };
            // Every option the provider's payload was built with, not just Kiro's: a Devin or
            // Codex retry has to carry the same protobuf metadata as the attempt it replaces.
            providerPayload = buildProviderRequestBody(best.providerKey, payload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions });
            response = null; // retry with the smaller max_tokens
          }
        }
      }
      // Unreachable by construction now that both re-asks are gated on a remaining attempt, but
      // a null response must never be dereferenced into a 500 that hides the provider's words.
      if (!response) {
        return finishTest({
          ok: false,
          error: extractErrorText(text) || `The test could not complete in ${MAX_TEST_ATTEMPTS} attempts.`,
          status: 0,
        });
      }
      const durationMs = Math.round(performance.now() - t0);
      // ttftMs is left for the measuring paths to fill: the whole request duration is not a
      // time-to-first-token, and claiming it was is what made a test's TTFT column read several
      // times the row's real prefill latency.
      const body = { providerKey: best.providerKey, modelId: best.modelId, status: response.status, ttftMs: null, durationMs, tps: null, text: null, error: null };

      // Read the answer before the verdict rather than after it, because the body decides the
      // verdict: a refusal can arrive *as* the answer, and an error envelope can arrive inside a
      // success status. That reading, the account-refusal rule and the answer text itself all live
      // in resolveTestVerdict (lib/test-verdict.js) — one rule for this path, the probe and the
      // proxy, and one that can be tested against captured bodies instead of only in production.
      const verdict = resolveTestVerdict({ ok: response.ok, transcript: text });
      const { answer, upstreamError, accountRefusal, usableSuccess, reasoningOnly, truncated, empty } = verdict;
      // One verdict for the record, the response and the rate-limit state below. A test that
      // emitted nothing is a failed test everywhere it is read: the record and the response used
      // to disagree (the record said `ok: false`, the response said `ok: true`), and every
      // consumer that trusted the response believed a silent row had passed — the bulk-retest job
      // is the one that did, counting a row as failed only on `!testData.ok`, so a pass over
      // silent rows reported "Done" with an empty error list while nothing had become ready.
      const testPassed = usableSuccess && !empty;
      if (upstreamError) {
        body.error = (typeof upstreamError.message === 'string' && upstreamError.message)
          || 'Upstream reported an error.';
      }

      // Capture x-ratelimit-* headers on EVERY response so the Quota column
      // has usage data immediately, even before any proxy request. This runs
      // for both 200 and error responses — Groq, NIM, and others populate
      // these headers on success too, not just 429s. Persisted so quota data
      // survives restarts.
      //
      // A 200 clears a rate-limit bench inside reconcileRateLimitState, on the grounds that a
      // successful response proves the window has reopened. That is only true when the body was
      // really an answer: an error envelope folded into a 200, a silent 200, or the gateway's own
      // "the API key … has reached its budget" notice is the same rate limit wearing a success
      // status — and telling the reconciler it was a 200 is how a Test click on a benched row
      // lifted that bench while the dashboard went on showing the clock. `null` is "no verdict
      // about the window": the headers' own quota numbers still merge below, and the bench is
      // left exactly as it was. The refusal branch further down re-asserts it, as the 429 it
      // means, when the body said so.
      const reconcileStatus = testPassed || Number(response.status) !== 200 ? response.status : null;
      const headerRl = readRateLimitHeaders(response.headers);
      if (Object.keys(headerRl).length > 0 || best.rateLimit) {
        best.rateLimit = reconcileRateLimitState(best.rateLimit, headerRl, reconcileStatus);
        const uk = `${best.providerKey}::${best.modelId}`;
        const prev = usageStats.get(uk) || {};
        if (best.rateLimit) usageStats.set(uk, { ...prev, rateLimit: best.rateLimit });
        else {
          const next = { ...prev };
          delete next.rateLimit;
          usageStats.set(uk, next);
        }
        scheduleUsageSave();
      }

      if (usableSuccess && empty) {
        // A 200 that emitted nothing in any channel this reader collects is a failed test, not a
        // healthy sample: no latency or speed sample is recorded, exactly as the probe treats an
        // empty 200 (see the noUsableText branch of pingModel, which also refuses to call it
        // 'incompatible' — that verdict strikes the row out of the table, and it outlived a Groq
        // row that had served a real request four days earlier). 'down' is re-checked by the next
        // probe, so one silent response cannot condemn a model.
        body.text = null;
        body.error = 'Model returned no text.';
        body.noUsableText = true;
        best.status = 'down';
        best.httpCode = String(response.status);
        best.lastError = { code: String(response.status), message: body.error, updatedAt: Date.now() };
      } else if (usableSuccess) {
        // Direct evidence the model is reachable: mirror the proxy path's marking so
        // a successful test immediately corrects a stale ping-derived 'down' status.
        noteProviderReachable(providerScopeKey(best));
        const okNow = Date.now();
        best.lastModelResponseAt = okNow;
        // The headers-phase time, not the whole request (see headersMs): this array is the one
        // getAvg() averages into the Ping column and latencyScore() turns into the QoS latency
        // term, and every other writer into it — the proxy and the probe alike — records how
        // long the provider took to *answer*, not how long the answer took to arrive.
        best.pings.push({ ms: headersMs ?? durationMs, code: '200', ts: okNow });
        if (best.pings.length > 50) best.pings.shift();
        // The name rule outranks a fresh 200: a row outside the chat families stays
        // incompatible even when a test squeezes a completion out of it.
        if (!isBlockedModelName(best.modelId)) best.status = 'up';
        best.httpCode = null;
        best.lastError = null;
        // Chosen by resolveTestVerdict: visible content when there is any, otherwise the output
        // the model did produce — streamed reasoning or tool-call arguments — and only failing
        // that the raw body of a response this reader could not decode. A response that emitted
        // nothing at all yields null, which is what the `empty` branch above reports; a
        // reasoning-only answer used to be judged empty here and thrown away along with the
        // generation it really did (see the headroom retry for why it is truncated).
        body.text = verdict.text;
        if (reasoningOnly) body.reasoningOnly = true;
        if (truncated) body.truncated = true;

        // A test is the one measurement a user explicitly asked for, so a provider that
        // reports no usage still has to yield a speed here (see resolveCompletionTokens) —
        // otherwise the row shows tok/s 0 and drops out of the speed axis and the slope selector
        // despite having answered. Streamed reasoning is generated output like any other, so it
        // counts, exactly as it does on the proxy paths.
        const reportedCompletionTokens = answer.reportedCompletionTokens;
        const totalTokens = answer.reportedTotalTokens;
        // A replayed answer's usage block belongs to the generation it was stored from (the
        // Pollinations cache hit reported 1485 completion tokens for a thirty-word answer), and
        // its frame times are this connection's delivery, not that response's generation. So a
        // cache hit measures nothing: it is reported as cached, the answer is still shown, and
        // no number from it reaches the row's series or labels.
        const completionTokens = cacheReplay ? null : resolveCompletionTokens(reportedCompletionTokens, answer.outputText);
        // The length this response was measured at, kept beside the rate derived from it so the
        // dashboard can print it next to the score the row is given for it.
        body.completionTokens = completionTokens ?? null;
        // Number of tokens the provider actually reported (shown under the result); an estimate
        // is never presented as a reported count. A provider that zeroes its usage block (g4f's
        // hosted pool answers 200 with {0,0,0} while returning text) reported nothing, so the
        // label stays absent instead of printing "0 tokens" beside a rate measured from the same
        // response.
        body.tokens = cacheReplay ? null : resolveReportedOutputTokens(reportedCompletionTokens, totalTokens);
        // A successful request proves the context window fits prompt + completion tokens — but
        // only when the request was actually served: a replay's prompt/completion counts describe
        // the request that produced the stored answer, not the one just sent.
        const testContextTokens = (!cacheReplay && answer.reportedPromptTokens != null && reportedCompletionTokens != null)
          ? Number(answer.reportedPromptTokens) + Number(reportedCompletionTokens)
          : null;
        if (cacheReplay) {
          // Reachable, and nothing more: the provider has this model's answer on file, which is
          // why the row still passes — but the click did not exercise the model, so this is not
          // a latency sample, not a rate, and not proof the account can serve real traffic.
          body.cached = true;
        } else if (answer.streamed && completionTokens != null) {
          // The generation window the answer's frames spanned, in the same terms the proxy
          // measures live traffic. resolveStreamGenerationMs refuses a window that is really
          // just delivery time (a provider that banks the whole answer and releases it at once),
          // so a rate is recorded only where a rate was actually observed.
          const genMs = resolveStreamGenerationMs(
            Math.round(performance.now() - attemptT0),
            streamFacts.firstOutputAt ? streamFacts.lastOutputAt - streamFacts.firstOutputAt : 0,
          );
          body.ttftMs = streamFacts.ttftMs ?? durationMs;
          // Shared rounding: a slow-but-measured rate must never be written into the response
          // record as 0, or the row shows "0 tok/s" and drops off the speed axis as if nothing
          // had been measured (see roundMeasuredRate).
          body.tps = roundMeasuredRate(completionTokens / (genMs / 1000));
          // Record real usage stats (TTFT, tok/s, context lower bound) from this response. Not a
          // proxy request (see countProxyRequest), and written once at the end of the click.
          recordUsage(best, {
            ttft: body.ttftMs,
            completionTokens,
            genMs,
            contextTokens: testContextTokens,
          }, { countProxyRequest: false, deferSave: true });
        } else {
          // The provider answered without streaming to us, so there is no first token and no
          // generation window to divide by: a total duration is not a generation rate and is not
          // written into the row's TTFT or rate averages as if it were one. The request and its
          // context evidence are still recorded; the row keeps whatever its real traffic measured.
          recordUsage(best, {
            ttft: null,
            completionTokens: null,
            contextTokens: testContextTokens,
          }, { countProxyRequest: false, deferSave: true });
        }
      } else {
        // A refusal that arrived as the answer has no error field to extract: its own words are
        // the message, and they are what the row's Last Error should read (a raw streamed
        // transcript would print the frames).
        const errText = accountRefusal || extractErrorText(text) || `HTTP ${response.status}`;
        body.error = errText;
        recordContextObservation(best, errText, payload.messages);
        if (response.status === 401 || response.status === 403) {
          best.status = 'noauth';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        } else if (response.status === 408 || response.status === 504) {
          best.status = 'timeout';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        } else if (response.status === 429) {
          // Clock status, not Down: the model is healthy and comes back on its
          // own when the provider's window resets. The dashboard renders this
          // as 🕑 with a countdown (see getRateLimitResetAt).
          best.status = 'rate-limited';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        } else if (response.status >= 500) {
          // A provider that is merely busy is waiting, not broken: the same clock a rate limit
          // gets, so the row reads "come back later" instead of Down. `overloaded` travels on
          // the response record, so a row rebuilt by the next refresh (whose status starts at
          // 'down' while its last response is restored) still shows the clock.
          const overloaded = isProviderOverloadedError(errText, response.status);
          best.status = overloaded ? 'overloaded' : 'down';
          body.overloaded = overloaded;
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        }

        // Some gateways wrap a provider rate limit in a non-429 status with the
        // signal only in the body (e.g. Anthropic-style {"error":{"type":
        // "FreeUsageLimitError","message":"... Rate limit exceeded. Please try
        // again later."}} on HTTP 400). Treat those like a 429 so the model is
        // benched and shown as rate limited instead of staying 'up'. Quota
        // exhaustion bodies count too — Google/Gemini embeds the rpc code 429 /
        // RESOURCE_EXHAUSTED in the body even when a relay's transport status
        // differs, so a quota body on e.g. HTTP 400/500 is still a rate limit.
        const rateLimitedByText = response.status !== 429 && (
          isRateLimitedErrorText(errText) || isQuotaExhaustionError(text, response.status)
          // An exhausted account budget is the same clock: the provider will not serve until
          // its window (or the key's) resets. So the row waits it out with a countdown instead
          // of keeping the 'up' verdict the refusal's own 200 would have left it with.
          || isAccountBudgetRefusalText(errText)
        );
        if (rateLimitedByText) {
          // Text-only rate limit (no 429): same clock status as a real 429 —
          // throttled, not broken.
          best.status = 'rate-limited';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        }

        // Payment required: surface a dollar + 'Paid' status in the dashboard. It
        // persists via lastResponse (like rate-limit / timeout state) and is cleared
        // by any later test that doesn't hit a payment wall.
        if (isPaymentRequiredError(errText, response.status)) {
          body.paymentRequired = true;
          best.status = 'paid';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        }

        // Model is gone (410 Gone / end-of-life message): surface a persistent
        // 'Dead' status instead of a generic 'Down'.
        if (isDeadModelError(errText, response.status)) {
          body.dead = true;
          best.status = 'dead';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
          // A refusal that names the backend's own roster is also the moment we can
          // learn models the gateway catalog does not list.
          learnServerRoster(best, errText);
        }

        // Model can't accept text chat (image/video only): surface as
        // 'Incompatible' so it moves to the unavailable list.
        if (isIncompatibleModelError(errText, response.status)) {
          body.incompatible = true;
          best.status = 'incompatible';
          best.httpCode = String(response.status);
          best.lastError = { code: String(response.status), message: errText, updatedAt: Date.now() };
        }

        // Rate limit: surface a clock + countdown in the dashboard's status column
        // and back this provider off in routing, mirroring how the proxy path marks 429s.
        // Merge (don't replace) so prior x-ratelimit headers aren't lost.
        if (response.status === 429 || rateLimitedByText) {
          const resetAt = extractRateLimitResetMs(text, (name) => response.headers.get(name));
          const quota = extractQuotaFailure(text);
          if (resetAt != null) body.rateLimitResetAt = resetAt;
          const rl = reconcileRateLimitState(best.rateLimit, {
            wasRateLimited: true,
            ...(resetAt != null ? { resetRequestsAt: resetAt } : {}),
            capturedAt: Date.now(),
            ...(quota.quotaId || quota.quotaValue || quota.code ? { quota } : {}),
            // A refusal that arrived on a success status is the 429 it means — the probe reports
            // this same case as 429 (ping() maps a 200 asking for budget to the 429 it means) and
            // so does the proxy's markModelBudgetRefused. Passing the literal 200 here would
            // delete, in the very call that sets it, the flag that benches this row in routing.
          }, Number(response.status) === 200 ? 429 : response.status);
          // A manual test 429 belongs to this model. Only OpenRouter key credits
          // are shared across sibling models.
          const keyRateLimit = best.providerKey === OPENROUTER_PROVIDER_KEY
            ? await fetchOpenRouterRateLimit(providerAuth.token)
            : null;
          applyRateLimitCapture(best, results, rl, keyRateLimit);
          // Persist so quota + cooldown survives restarts, even when the provider
          // omits reset and quota metadata.
          const uk = `${best.providerKey}::${best.modelId}`;
          const prev = usageStats.get(uk) || {};
          usageStats.set(uk, { ...prev, rateLimit: best.rateLimit });
          scheduleUsageSave();
        }
      }

      // Persist the response so the column survives reloads; rateLimitResetAt and
      // expiresAt are always included (null otherwise) so a later test clears any
      // previously persisted countdown or timeout window; paymentRequired and dead
      // are cleared by any test that doesn't hit a payment wall / dead model.
      recordTestResponse(best, {
        text: body.text,
        error: body.error,
        status: response.status,
        // A response that emitted nothing is not a successful test in the record either: the
        // dashboard reads `ok === false` (or the error) as "not Ready" so a silent row cannot
        // keep a Ready badge it did not earn (see isLastResponseReady).
        ok: testPassed,
        at: Date.now(),
        ttftMs: body.ttftMs,
        // Kept for the same reason the error record keeps it: a test that measured no rate
        // still has a duration worth showing (see the streamed/non-streamed split above).
        durationMs: body.durationMs ?? null,
        tps: body.tps,
        tokens: body.tokens ?? null,
        completionTokens: body.completionTokens ?? null,
        rateLimitResetAt: body.rateLimitResetAt ?? null,
        expiresAt: null,
        paymentRequired: body.paymentRequired === true,
        dead: body.dead === true,
        incompatible: body.incompatible === true,
        overloaded: body.overloaded === true,
        // Kept so the dashboard can say that the answer it is showing came out of the reasoning
        // channel (or was cut off), rather than presenting it as the model's reply.
        reasoningOnly: body.reasoningOnly === true,
        truncated: body.truncated === true,
        // The provider replayed a stored answer instead of serving this click, so the row passed
        // without the model being exercised (see the cache gate above).
        cached: body.cached === true,
      }, { deferSave: true });

      // Everything this click recorded — the usage sample, the learned-cap observation, the
      // rate-limit capture and the response record — lands in one atomic write instead of one per
      // step. (A coalesced write armed above may repeat the same content two seconds later, which
      // costs a write and changes nothing.)
      saveUsageStats();

      res.json({ ok: testPassed, ...body });
    } catch (err) {
      console.error(chalk.red(`  [Router] Test-model error: ${err?.message}`));
      res.status(500).json({ ok: false, error: err?.message || 'Test failed' });
    }
  });

  // Internal self-request origin for bulk retests. Uses the port the router is
  // actually listening on (process.env.PORT is unrelated to it and usually unset,
  // which sent every retest row to a dead port) and a host that is guaranteed to
  // be in the listen set.
  const selfOriginHost = isLoopbackHostname(listenHost) ? '127.0.0.1' : listenHost;
  const selfOrigin = `http://${selfOriginHost.includes(':') ? `[${selfOriginHost}]` : selfOriginHost}:${port}`;

  // Bulk retest state: tracks in-flight 'retest all non-ready' jobs.
  const RESTEST_STATE_PATH = join(homedir(), '.hammer-restest.json');
  // How many finished jobs the state file keeps. It used to keep every job ever run.
  const RESTEST_JOB_KEEP = 25;

  // A job survives a restart; the *work* does not, because the loop that drives it lives in this
  // process. A job restored as 'running' was therefore a lie that only grew: the dashboard tab
  // holding its id polls a job that can never advance (a restart under an open tab left the Rerun
  // button spinning for good), and GET /api/restest-status kept reporting it as running. A job
  // that had not finished when the process stopped is now marked interrupted, keeping its counts
  // and errors so the history is still there — only the claim that it is still working is gone.
  function reconcileRestestJobsOnLoad(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const interruptedAt = Date.now();
    let changed = false;
    const reconciled = list
      .map(job => {
        if (!job || typeof job !== 'object') return null;
        if (job.status !== 'running' && job.status !== 'queued') return job;
        changed = true;
        return {
          ...job,
          status: 'interrupted',
          interruptedAt,
          doneAt: Number(job.doneAt) || interruptedAt,
          note: `Interrupted by a server restart after ${Number(job.completed) || 0} of ${Number(job.total) || 0} models.`,
        };
      })
      .filter(Boolean);
    return { jobs: reconciled.slice(-RESTEST_JOB_KEEP), changed };
  }

  let restestJobs = [];
  let restestJobsRewritten = false;
  if (existsSync(RESTEST_STATE_PATH)) {
    try {
      const loaded = reconcileRestestJobsOnLoad(JSON.parse(readFileSync(RESTEST_STATE_PATH, 'utf8'))?.jobs);
      restestJobs = loaded.jobs;
      restestJobsRewritten = loaded.changed;
    } catch {
      // Corrupted state file; start fresh.
    }
  }

  // Persists restest job state to disk so it survives server restarts.
  function saveRestestState() {
    try {
      writeFileSync(RESTEST_STATE_PATH, JSON.stringify({ jobs: restestJobs.slice(-RESTEST_JOB_KEEP) }, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(chalk.red(`  [Restest] Failed to persist restest state: ${err?.message}`));
    }
  }

  // Write the reconciliation back at once, so the file stops claiming a job is still running.
  if (restestJobsRewritten) saveRestestState();

  // Bulk-retests every model whose last test response is NOT a clean 'Ready'.
  // Creates a job, fans out one test request per model (sequentially, so we don't
  // blast all providers at once), and updates the job progress as each completes.
  async function restestAllNonReady(jobId) {
    const job = restestJobs.find(j => j.id === jobId);
    if (!job) return;
    job.status = 'running';
    saveRestestState();

    // Collect all rows that need retesting: individual models without a Ready response
    const rowsToTest = [];
    for (const r of results) {
      const usageEntry = usageStats.get(`${r.providerKey}::${r.modelId}`);
      const lastResponse = usageEntry?.lastResponse || null;
      if (!isLastResponseReady(lastResponse)) {
        rowsToTest.push({ providerKey: r.providerKey, modelId: r.modelId });
      }
    }

    // Also include group rows: if no member has a Ready response, test the best member
    // using the same group resolution logic as the single test endpoint.
    const groupRows = [];  // group rows from the UI (members arrays)
    // We'll handle groups via the UI-side fan-out instead, since the server doesn't
    // have the UI's group structure. Individual models are handled above.

    job.total = rowsToTest.length;
    job.completed = 0;
    job.errors = [];
    saveRestestState();

    for (const row of rowsToTest) {
      if (job.status === 'cancelled') break;
      try {
        // Re-use the test-model endpoint logic by making an internal call
        const testBody = { providerKey: row.providerKey, modelId: row.modelId };
        const testRes = await fetch(`${selfOrigin}/api/test-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testBody),
          // The caller's budget, not one attempt's: this used to abort at TEST_TIMEOUT_MS while
          // the row it was testing could still be on its second or third attempt, so exactly the
          // rows that needed a retry were recorded as job errors and the row's real result
          // arrived after the job had already called it a failure.
          signal: AbortSignal.timeout(TEST_CALLER_BUDGET_MS),
        });
        const testData = await testRes.json();
        job.completed++;
        if (!testData.ok) {
          job.errors.push({ providerKey: row.providerKey, modelId: row.modelId, error: testData.error || `HTTP ${testRes.status}` });
        }
      } catch (err) {
        job.completed++;
        job.errors.push({ providerKey: row.providerKey, modelId: row.modelId, error: err?.message || 'Request failed' });
      }
      job.progress = Math.round((job.completed / job.total) * 100);
      saveRestestState();
    }

    job.status = job.status === 'cancelled' ? 'cancelled' : (job.errors.length > 0 && job.completed < job.total ? 'partial' : 'done');
    job.doneAt = Date.now();
    saveRestestState();
  }

  // POST /api/restest-models — start a bulk retest of all non-ready models
  app.post('/api/restest-models', (req, res) => {
    const jobId = randomUUID();
    const job = {
      id: jobId,
      status: 'queued',
      created: Date.now(),
      total: 0,
      completed: 0,
      progress: 0,
      errors: [],
      doneAt: null,
    };
    restestJobs.push(job);
    saveRestestState();

    // Fire and forget — the job runs in the background
    restestAllNonReady(jobId).catch(err => {
      console.error(chalk.red(`  [Restest] Job ${jobId} failed: ${err?.message}`));
      job.status = 'failed';
      job.doneAt = Date.now();
      saveRestestState();
    });

    res.json({ ok: true, jobId });
  });

  // GET /api/restest-status — poll the status of a restest job
  app.get('/api/restest-status', (req, res) => {
    const { jobId } = req.query || {};
    if (!jobId) {
      return res.json({ jobs: restestJobs.slice(-10) });  // return last 10 jobs
    }
    const job = restestJobs.find(j => j.id === jobId);
    if (!job) return res.json({ ok: false, error: 'Job not found' });
    res.json({ ok: true, job });
  });

  // POST /api/restest-cancel — cancel a running restest job
  app.post('/api/restest-cancel', (req, res) => {
    const { jobId } = req.body || {};
    if (!jobId) return res.json({ ok: false, error: 'jobId required' });
    const job = restestJobs.find(j => j.id === jobId);
    if (!job) return res.json({ ok: false, error: 'Job not found' });
    if (job.status === 'running') {
      job.status = 'cancelled';
      saveRestestState();
    }
    res.json({ ok: true });
  });

  // Proxy endpoint
  app.get('/v1/models', (req, res) => {
    const groups = buildModelGroups(results, canonicalizeModelId)
    const data = [
      {
        id: 'best',
        name: 'Best',
        object: "model",
        created: Date.now(),
        owned_by: 'router'
      },
      ...groups.map(group => ({
        id: group.id,
        name: group.label,
        object: "model",
        created: Date.now(),
        owned_by: 'Hammer'
      }))
    ]

    res.json({
      object: "list",
      data
    });
  });

  // Extracts rate-limit / quota header fields from a Fetch API Headers object.
  // Returns a plain object with only the fields the provider actually returned.
  // Safe to call on any response (200 / 429 / etc.) — just captures what's there.
  //
  // Handles the standard OpenAI-compatible names (Groq, Cerebras, etc.) plus
  // common variants: NIM reversed order, case variants, and bare `ratelimit-*`.
  // Also captures `retry-after` as a de-facto quota signal on 429s.
  function readRateLimitHeaders(headers) {
    const rl = {};

    // --- Request limits (multiple naming conventions) ---
    const LR = headers.get('x-ratelimit-limit-requests')
      || headers.get('x-ratelimit-requests-limit');  // NIM reversed
    if (LR) { const n = Number(LR); if (Number.isFinite(n) && n >= 0) rl.limitRequests = n; }

    const RR = headers.get('x-ratelimit-remaining-requests')
      || headers.get('x-ratelimit-requests-remaining');  // NIM reversed
    if (RR) { const n = Number(RR); if (Number.isFinite(n) && n >= 0) rl.remainingRequests = n; }

    // --- Token limits (multiple naming conventions) ---
    const LT = headers.get('x-ratelimit-limit-tokens')
      || headers.get('x-ratelimit-tokens-limit');  // NIM reversed
    if (LT) { const n = Number(LT); if (Number.isFinite(n) && n >= 0) rl.limitTokens = n; }

    const RT = headers.get('x-ratelimit-remaining-tokens')
      || headers.get('x-ratelimit-tokens-remaining');  // NIM reversed
    if (RT) { const n = Number(RT); if (Number.isFinite(n) && n >= 0) rl.remainingTokens = n; }

    // --- Reset windows ---
    const resetReq = headers.get('x-ratelimit-reset-requests')
      || headers.get('x-ratelimit-requests-reset');
    const resetTok = headers.get('x-ratelimit-reset-tokens')
      || headers.get('x-ratelimit-tokens-reset');
    if (resetReq) { const ms = parseDurationMs(resetReq); if (ms != null) rl.resetRequestsAt = Date.now() + ms; }
    if (resetTok) { const ms = parseDurationMs(resetTok); if (ms != null) rl.resetTokensAt = Date.now() + ms; }

    // --- retry-after: de-facto quota signal on 429 responses ---
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const raMs = parseDurationMs(retryAfter);
      if (raMs != null) {
        // Use as resetRequestsAt if no explicit reset header exists
        if (!rl.resetRequestsAt) rl.resetRequestsAt = Date.now() + raMs;
        rl.retryAfterMs = raMs;
      }
    }

    return rl;
  }

  const captureProxyRateLimit = async (model, response, providerApiKey) => {
    // Merge new header data on top of any existing rateLimit — a 200 with headers
    // should update the quota display without nuking a prior 429's wasRateLimited.
    const rateLimit = reconcileRateLimitState(
      model.rateLimit,
      readRateLimitHeaders(response.headers),
      response.status,
    ) || {};

    // Quota / Gemini-style rejections don't populate x-ratelimit-* headers: read
    // the body's RetryInfo.retryDelay (via a clone so streaming still works) and
    // capture quota metadata for the dashboard. Best-effort, never blocks. Also
    // flag quota-exhaustion bodies that arrive on non-429 statuses — the body's
    // rpc code/status (e.g. Google's RESOURCE_EXHAUSTED) is the ground truth
    // when a relay rewrites the transport status.
    let quotaLimited = response.status === 429;
    // Returned to the caller so a refusal can bench the credential for as long as the provider
    // said. Gemini puts its window in the body rather than a header ("Please retry in 12.6s"),
    // so a header-only reading would bench that provider for the local default forever.
    let statedResetAt = null;
    if (!response.ok) {
      try {
        const clone = response.clone();
        const raw = await clone.text();
        const quota = extractQuotaFailure(raw);
        if (quota.quotaId || quota.quotaValue || quota.code) quotaLimited = true;
        if (isQuotaExhaustionError(raw, response.status)) quotaLimited = true;
        if (quotaLimited) {
          const resetAt = extractRateLimitResetMs(raw, (name) => response.headers.get(name));
          if (resetAt != null) rateLimit.resetRequestsAt = resetAt;
          statedResetAt = resetAt;
          if (quota.quotaId || quota.quotaValue || quota.code) rateLimit.quota = quota;
        }
      } catch {
        /* body already consumed or unreadable — headers only */
      }
    }

    if (quotaLimited) {
      rateLimit.wasRateLimited = true;
      rateLimit.capturedAt = Date.now();
    }

    // Per-model scoping: the 429 flag and x-ratelimit-* headers belong only to the model
    // that produced this response -- most providers (OpenRouter included) throttle per
    // model, so marking every same-provider model rate-limited would bench the whole
    // provider off one bad model's 429. OpenRouter key credits (per API key) are the only
    // data legitimately shared provider-wide; applyRateLimitCapture handles that split.
    let keyRateLimit = null;
    if (model.providerKey === 'openrouter') {
      keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
    }
    const capturedPayload = Object.keys(rateLimit).length > 0 ? rateLimit : null;
    // A successful response with no fresh quota headers clears obsolete model-level
    // cooldown state; OpenRouter key credits may be reattached below.
    model.rateLimit = capturedPayload;
    applyRateLimitCapture(model, results, capturedPayload, keyRateLimit);
    // Persist quota data so it survives restarts
    const uk = `${model.providerKey}::${model.modelId}`;
    const prev = usageStats.get(uk) || {};
    if (model.rateLimit) usageStats.set(uk, { ...prev, rateLimit: model.rateLimit });
    else {
      const next = { ...prev };
      delete next.rateLimit;
      usageStats.set(uk, next);
    }
    saveUsageStats();
    return { resetAt: statedResetAt };
  };

  // ─── Anthropic Messages API compatibility (/v1/messages) ────────────────
  // Lets Anthropic-protocol clients (Claude Code via ANTHROPIC_BASE_URL) use
  // the router directly. Requests are translated to OpenAI chat completions
  // and served through an internal self-request to /v1/chat/completions so
  // routing/benchmark logic lives in exactly one place. Streaming is passed
  // through chunk-by-chunk.

  const anthropicBlockText = (content) => {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  };

  const anthropicToOpenAIBody = (body) => {
    const msgs = [];
    const system = anthropicBlockText(body.system);
    if (system) msgs.push({ role: 'system', content: system });
    for (const m of body.messages || []) {
      const role = m.role;
      const content = m.content;
      if (typeof content === 'string') {
        msgs.push({ role, content });
        continue;
      }
      const texts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const b of content || []) {
        if (b.type === 'text') texts.push(b.text || '');
        else if (b.type === 'tool_use') toolCalls.push({
          id: b.id || `call_${Math.random().toString(36).slice(2, 12)}`,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
        else if (b.type === 'tool_result') toolResults.push([b.tool_use_id, anthropicBlockText(b.content)]);
        // thinking blocks are intentionally dropped on the way in
      }
      if (role === 'assistant') {
        const out = { role, content: texts.join('\n') || null };
        if (toolCalls.length) out.tool_calls = toolCalls;
        msgs.push(out);
      } else {
        for (const [toolCallId, result] of toolResults) {
          msgs.push({ role: 'tool', tool_call_id: toolCallId, content: result });
        }
        if (texts.length) msgs.push({ role, content: texts.join('\n') });
        if (!toolResults.length && !texts.length) msgs.push({ role, content: '' });
      }
    }
    const out = {
      model: 'best',
      messages: msgs,
      max_tokens: Math.min(Number(body.max_tokens || 4096), 32768),
      stream: true,
    };
    if (Array.isArray(body.tools) && body.tools.length) {
      out.tools = body.tools.filter(t => t && t.name).map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } },
      }));
    }
    if (body.temperature != null) out.temperature = body.temperature;
    return out;
  };

  const ANTHROPIC_STOP_REASONS = {
    stop: 'end_turn', length: 'max_tokens',
    tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn',
  };

  // Stateful OpenAI-SSE → Anthropic-SSE converter; emits events as chunks arrive.
  class AnthropicRelayStream {
    constructor(model) {
      this.model = model;
      this.msgId = `msg_${Math.random().toString(36).slice(2, 14)}`;
      this.buf = '';
      this.started = false;
      this.finished = false;
      this.openBlock = null;   // null | 'thinking' | 'text' | number (tool idx)
      this.blockIndex = 0;
      this.tools = new Map();  // openai index -> {id,name,args,open}
      this.text = '';
      this.reasoning = '';
      this.finishReason = null;
      this.outTokens = 0;
    }
    event(name, obj) { return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`; }
    messageStart() {
      return this.event('message_start', { type: 'message_start', message: {
        id: this.msgId, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    closeOpenBlock() {
      if (this.openBlock === null) return '';
      let out = '';
      if (this.openBlock === 'thinking') {
        out += this.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'signature_delta', signature: 'hammer' } });
      }
      out += this.event('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
      this.blockIndex += 1;
      this.openBlock = null;
      return out;
    }
    openToolBlock(idx) {
      const slot = this.tools.get(idx);
      slot.open = true;
      this.openBlock = idx;
      return this.event('content_block_start', { type: 'content_block_start', index: this.blockIndex,
        content_block: { type: 'tool_use', id: slot.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: slot.name, input: {} } });
    }
    handleChunk(chunk) {
      let out = '';
      const choices = chunk.choices || [];
      if (!choices.length) return out;
      const choice = choices[0];
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        this.reasoning += reasoning;
        if (this.openBlock !== 'thinking') {
          out += this.closeOpenBlock();
          out += this.event('content_block_start', { type: 'content_block_start', index: this.blockIndex,
            content_block: { type: 'thinking', thinking: '' } });
          this.openBlock = 'thinking';
        }
        out += this.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'thinking_delta', thinking: reasoning } });
      }
      if (typeof delta.content === 'string' && delta.content) {
        this.text += delta.content;
        if (this.openBlock !== 'text') {
          out += this.closeOpenBlock();
          out += this.event('content_block_start', { type: 'content_block_start', index: this.blockIndex,
            content_block: { type: 'text', text: '' } });
          this.openBlock = 'text';
        }
        out += this.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!this.tools.has(idx)) this.tools.set(idx, { id: null, name: '', args: '', open: false });
        const slot = this.tools.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        const frag = tc.function?.arguments || '';
        if (frag && !slot.open) {
          // Defer start until arguments flow so streamed names arrive whole.
          out += this.closeOpenBlock();
          out += this.openToolBlock(idx);
        }
        if (frag && slot.open) {
          out += this.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: frag } });
        }
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      return out;
    }
    finish() {
      if (this.finished) return '';
      this.finished = true;
      let out = '';
      // Zero-arg tool calls never receive an arguments fragment; flush them.
      for (const idx of [...this.tools.keys()].sort()) {
        const slot = this.tools.get(idx);
        if (!slot.open && (slot.name || slot.id)) {
          out += this.closeOpenBlock();
          out += this.openToolBlock(idx);
          out += this.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: '{}' } });
        }
      }
      out += this.closeOpenBlock();
      out += this.event('message_delta', { type: 'message_delta',
        delta: { stop_reason: ANTHROPIC_STOP_REASONS[this.finishReason] || 'end_turn', stop_sequence: null },
        usage: { output_tokens: this.outTokens } });
      out += this.event('message_stop', { type: 'message_stop' });
      return out;
    }
    feed(text) {
      this.buf += text;
      let out = '';
      while (this.buf.includes('\n')) {
        const nl = this.buf.indexOf('\n');
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return out + this.finish();
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (!this.started) { this.started = true; out += this.messageStart(); }
        out += this.handleChunk(parsed);
        const usage = parsed.usage;
        if (usage) this.outTokens = usage.completion_tokens ?? this.outTokens;
        const choices = parsed.choices || [];
        if (choices.length && choices[0].finish_reason) out += this.finish();
      }
      return out;
    }
    toMessage() {
      // Aggregate final Anthropic message (for non-streaming clients).
      const content = [];
      if (this.reasoning.trim()) content.push({ type: 'thinking', thinking: this.reasoning, signature: 'hammer' });
      if (this.text) content.push({ type: 'text', text: this.text });
      for (const [, slot] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
        let input = {};
        try { input = JSON.parse(slot.args || '{}'); } catch { }
        content.push({ type: 'tool_use', id: slot.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: slot.name, input });
      }
      return { id: this.msgId, type: 'message', role: 'assistant', model: this.model,
        content: content.length ? content : [{ type: 'text', text: '' }],
        stop_reason: ANTHROPIC_STOP_REASONS[this.finishReason] || 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: this.outTokens } };
    }
  }

  app.post('/v1/messages/count_tokens', (req, res) => {
    const body = req.body || {};
    let chars = typeof body.system === 'string'
      ? body.system.length
      : (body.system ? JSON.stringify(body.system).length : 0);
    for (const m of body.messages || []) {
      chars += typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content || '').length;
    }
    res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
  });

  app.post('/v1/messages', async (req, res) => {
    const body = req.body || {};
    const openaiBody = anthropicToOpenAIBody(body);
    // Honor the caller's model when it names a model the router actually carries;
    // Anthropic-protocol clients also send ids we don't have (e.g.
    // "claude-sonnet-4-5"), which fall back to normal best-model routing instead
    // of 404ing the way a bare pass-through would.
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (requestedModel && requestedModel !== 'best' && requestedModel !== 'smartest'
      && filterModelsByRequested(results, requestedModel, canonicalizeModelId).length > 0) {
      openaiBody.model = requestedModel;
    }
    const wantsStream = Boolean(body.stream);
    const relay = new AnthropicRelayStream(body.model || 'unknown');
    if (wantsStream) {
      // Flush headers up front so the client's stream opens immediately;
      // failures surface as in-band error events instead of dead connections.
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
    }
    let upstreamTimer = null;
    let idleTimer = null;
    const clearTimers = () => {
      if (upstreamTimer) { clearTimeout(upstreamTimer); upstreamTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    };
    try {
      // Bound the internal hop: a router that never answers must not hang the client
      // forever. The headers timer is cleared once headers arrive; an idle watchdog
      // then covers a body that stalls mid-stream.
      const upstreamController = new AbortController();
      upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
      const upstream = await fetch(`${req.protocol}://${req.get('host')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-anthropic-compat' },
        body: JSON.stringify(openaiBody),
        signal: upstreamController.signal,
      });
      if (upstreamTimer) { clearTimeout(upstreamTimer); upstreamTimer = null; }
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        const message = errText || JSON.stringify({ error: { message: 'Router upstream failed' } });
        if (wantsStream) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
          res.end();
        } else {
          res.status(upstream.status || 502).type('json').send(message);
        }
        return;
      }
      // Anthropic-protocol clients get the same disclosure as /v1/chat/completions:
      // mirror the internal hop's headers when the response can still carry them, and
      // for a streaming caller (whose headers were flushed up front) report the served
      // model in message_start instead — otherwise a substituted model is invisible.
      const servedModel = upstream.headers.get('x-hammer-model');
      const servedProvider = upstream.headers.get('x-hammer-provider');
      const servedSubstituted = upstream.headers.get('x-hammer-substituted');
      if (!wantsStream) {
        if (servedModel) res.setHeader('X-Hammer-Model', servedModel);
        if (servedProvider) res.setHeader('X-Hammer-Provider', servedProvider);
        if (servedSubstituted) res.setHeader('X-Hammer-Substituted', servedSubstituted);
      } else if (servedModel) {
        relay.model = servedModel;
      }

      const decoder = new TextDecoder();
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try { upstreamController.abort(); } catch { }
        }, UPSTREAM_IDLE_TIMEOUT_MS);
      };
      try {
        for await (const chunk of upstream.body) {
          armIdleWatchdog();
          const piece = decoder.decode(chunk, { stream: true });
          if (wantsStream) {
            res.write(relay.feed(piece));
          } else {
            relay.feed(piece);
          }
        }
      } finally {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }
      if (wantsStream) {
        res.write(relay.finish());
        res.end();
      } else {
        relay.feed('\ndata: [DONE]\n\n');
        res.json(relay.toMessage());
      }
    } catch (err) {
      clearTimers();
      const message = err?.name === 'AbortError'
        ? 'Router upstream timed out.'
        : (err?.message || 'Anthropic compat failure');
      if (wantsStream) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
          res.end();
        } catch { }
      } else if (!res.headersSent) {
        res.status(502).json({ error: { type: 'api_error', message } });
      } else {
        try { res.end(); } catch { }
      }
    }
  });

  app.post('/v1/chat/completions', async (req, res) => {
    let logEntry = null;
    // Request-logging policy: logRequestContent=false stores roles but not prompt/response
    // bodies; persistRequestLogs=false keeps logs in memory only (never touches disk).
    const logPolicyConfig = loadConfig();
    const logContent = logPolicyConfig.logRequestContent !== false;
    const persistLogs = logPolicyConfig.persistRequestLogs !== false;
    try {
      const payload = req.body;
      const attemptedModelKeys = new Set();
      // Providers this request has already spent an attempt on, so the retry loop can prefer a
      // different provider rather than re-picking the same dead fleet (see pickNextModel).
      const attemptedProviderKeys = new Set();
      const attempts = [];
      const isSmartestRequest = payload.model === 'best'
        || payload.model === 'smartest'
        || String(payload.model || '').startsWith('best+')
        || String(payload.model || '').startsWith('smartest+');

      // 📖 A concrete model the table does not know yet may be served by an imported provider
      // whose rows have never been fetched (see resolveRequestModels): on-demand discovery
      // then makes the import routable before the 404 below, rather than only after a manual
      // refresh.
      const requestedModels = await resolveRequestModels({
        getResults: () => results,
        requestModel: payload.model,
        canonicalize: canonicalizeModelId,
        isSmartestRequest,
        discover: discoverLazyImportsForRequest,
      });
      // Speed/intelligence for every candidate, so the slope pick below evaluates
      // exactly the numbers the dashboard plotted.
      for (const r of requestedModels) applyUsageDerivedMetrics(r);
      // The retry loop rewrites payload.model to whichever model is being attempted,
      // so remember what the caller asked for before that happens.
      const requestedModelId = typeof payload.model === 'string' ? payload.model.trim() : '';
      // Selection is snapshotted per request. Dashboard changes affect the next
      // turn, never a retry already belonging to the current harness turn.
      const requestPinnedModelId = pinnedModelId;
      const requestPinnedProviderKey = pinnedProviderKey;
      const requestPinningMode = getPinningMode(loadConfig());
      const requestSelector = effectiveSelectorSettings(loadConfig());
      if (payload.model && !isSmartestRequest && requestedModels.length === 0) {
        return res.status(404).json({ error: { message: `Requested model not found: ${payload.model}` } });
      }

      // Google AI thinking models 400 on tool-turn continuations whose Gemini
      // function calls lack a thought_signature we can supply; route around it.
      const incompatibleProviderKeys = new Set();
      if (!isGoogleAiRequestCompatible(payload)) {
        incompatibleProviderKeys.add(GOOGLEAI_PROVIDER_KEY);
      }

      // A concrete model id normally pins the candidate pool to that model, so an
      // explicit request never silently lands on a different model. A retryable
      // upstream fault is the exception: when every row of the requested model has
      // been attempted (or the relay answers 200 with an error frame), the pool
      // widens to the whole model list so the client gets a real answer instead of
      // the relay's error. Widening happens only after a retryable failure, never
      // for a manual pin, and only when the pinned pool has nothing left to try —
      // a model offered by several providers still fails over within itself first.
      let retryableFailureSeen = false;
      let candidatePoolWidened = false;
      const pickPool = () => (candidatePoolWidened ? results : requestedModels);

      const pickNextModel = () => {
        const pickerConfig = loadConfig();
        const qosOptions = { latencyTargetMs: pickerConfig.qosLatencyTargetMs ?? DEFAULT_QOS_LATENCY_TARGET_MS };
        const pool = pickPool();

        let candidate = null;
        if (requestPinnedModelId) {
          candidate = getPinnedModelCandidate(results, requestPinnedModelId, requestPinningMode, Array.from(attemptedModelKeys), requestPinnedProviderKey, qosOptions);
        }
        if (!candidate && isSmartestRequest) {
          // Slope-line selector (dashboard Intelligence-vs-Speed plot): the first row
          // a line of the configured slope touches wins, provided it clears the
          // configured minimums. A manual pin always outranks this, and any failure
          // (nothing qualifies) falls back to the intelligence ranking below.
          // Already-attempted models are excluded so a failed pick falls through
          // instead of being retried until the attempt budget runs out.
          const sel = requestSelector;
          const selSlope = selectorSlopeOf(sel);
          if (selSlope != null) {
            const pick = selectModelBySlope(pool, {
              slope: selSlope,
              minSpeed: sel.minSpeed,
              minIntell: sel.minIntell,
              excludeModelIds: Array.from(attemptedModelKeys),
            });
            candidate = pick ? pick.model : null;
          }
        }
        const rankTop = () => {
          const ranked = isSmartestRequest
            ? rankModelsForSmartest(pool, Array.from(attemptedModelKeys))
            : rankModelsForRouting(pool, Array.from(attemptedModelKeys), qosOptions);
          return ranked[0] || null;
        };
        if (!candidate) candidate = rankTop();

        // Route around providers incompatible with this request. When pinned, keep
        // the pinned candidate so the failure stays visible instead of silently
        // switching models.
        while (candidate && incompatibleProviderKeys.has(candidate.providerKey)) {
          attemptedModelKeys.add(getRoutingModelKey(candidate));
          if (requestPinnedModelId) break;
          candidate = rankTop();
        }

        // Then step aside for providers the outage ledger has benched, and for a provider this
        // request has already spent an attempt on. One attempt per provider while another can
        // serve is what keeps a fleet-wide outage from eating the whole retry budget: six
        // attempts at a 60s headers timeout each is six minutes a client waits before a 503.
        // Both are preferences rather than exclusions — a benched or already-tried provider's
        // top row is still used when nothing else is left, so a request is never made worse than
        // it would have been without the ledger. A pin is never second-guessed.
        if (!requestPinnedModelId) {
          const steppedAside = [];
          while (candidate && (
            isProviderBenched(providerHealth, providerScopeKey(candidate))
            || attemptedProviderKeys.has(candidate.providerKey)
          )) {
            steppedAside.push(candidate);
            attemptedModelKeys.add(getRoutingModelKey(candidate));
            candidate = rankTop();
          }
          if (!candidate && steppedAside.length > 0) {
            // Everything left belongs to a benched or already-tried provider: take the one whose
            // cooldown ends soonest — or, when nothing is benched, the highest-ranked — rather
            // than handing the caller a 503 while a provider may already be answering again.
            candidate = steppedAside.reduce((best, row) => {
              const bestUntil = providerBenchState(providerHealth, providerScopeKey(best))?.benchedUntil || 0;
              const rowUntil = providerBenchState(providerHealth, providerScopeKey(row))?.benchedUntil || 0;
              return rowUntil < bestUntil ? row : best;
            }, steppedAside[0]);
          }
        }

        // Nothing left in a pinned pool, and the last failure was a retryable
        // upstream fault: widen once and re-pick from every model. A pinned model
        // (the user's explicit pin) never widens.
        if (!candidate && !requestPinnedModelId && !candidatePoolWidened && retryableFailureSeen && pool !== results) {
          candidatePoolWidened = true;
          return pickNextModel();
        }
        return candidate;
      };

      logEntry = {
        timestamp: new Date().toISOString(),
        model: '(pending)',
        provider: '(pending)',
        // When content capture is disabled, store only roles so the conversation shape is
        // still debuggable without persisting prompt bodies.
        messages: logContent ? (payload.messages || []) : (payload.messages || []).map(m => ({ role: m?.role })),
        duration: null,
        ttft: null,
        status: 'pending',
        response: null,
        prompt_tokens: null,
        completion_tokens: null,
        tool_calls: null,
        function_call: null,
        attempts,
        retryCount: 0,
      };

      requestLogs.unshift(logEntry);
      if (requestLogs.length > 50) requestLogs.length = 50;

      if (enableLog) {
        // Terminal payload logging is opt-in (--log) and never persisted, so it always
        // shows full content regardless of the disk-capture policy.
        console.log(chalk.dim('  ┌─────────────────── REQUEST PAYLOAD ───────────────────'));
        for (const msg of payload.messages || []) {
          const roleStr = (msg?.role || '?').toUpperCase().padEnd(9);
          const color = msg?.role === 'system' ? chalk.magenta : (msg?.role === 'user' ? chalk.blue : chalk.green);
          let content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg.content);

          if (content && content.length > 500) {
            content = content.substring(0, 500) + chalk.italic(' ...[truncated]');
          }
          console.log(color(`  │ [${roleStr}] ${String(content || '').replace(/\n/g, '\n  │           ')}`));
        }
        console.log(chalk.dim('  └───────────────────────────────────────────────────────\n'));
      }

      let selectedModel = null;
      let selectedResponse = null;
      let selectedT0 = 0;
      // Abort controller for the winning attempt, kept alive so the response-body phase
      // (non-streaming text() and streaming idle watchdog) can still cancel it.
      let selectedUpstreamController = null;
      // Headers-phase duration of the winning attempt, recorded as its latency sample
      // once the body confirms the response is real.
      let selectedProbeMs = 0;

      // A 2xx only becomes a healthy sample once the body proves it carries a real
      // completion. Providers that answer 200 with an empty body / empty choices
      // would otherwise be marked 'up' with a bogus latency sample that inflates QoS.
      const promoteSuccessfulModel = (model, probeMs) => {
        if (!model) return;
        // A response the client is about to receive is the strongest evidence a provider is
        // healthy, so it lifts an outage bench immediately.
        noteProviderReachable(providerScopeKey(model));
        const now = Date.now();
        model.lastModelResponseAt = now;
        // Persist liveness alongside the usage stats (saved by the recordUsage that
        // follows) so a restart doesn't forget this success.
        const livenessKey = `${model.providerKey}::${model.modelId}`;
        usageStats.set(livenessKey, { ...(usageStats.get(livenessKey) || {}), lastServedAt: now });
        model.pings.push({ ms: probeMs, code: '200', ts: now });
        if (model.pings.length > 50) model.pings.shift();
        // Same name-rule guard as the manual Test path above.
        if (!isBlockedModelName(model.modelId)) model.status = 'up';
        model.httpCode = null;
        model.lastError = null;
      };

      // The mirror image: a 200 with no completion text is evidence the model cannot
      // serve this request, so surface it as incompatible instead of counting an empty
      // answer as a healthy, fast response.
      const markModelIncompatible = (model, message) => {
        if (!model) return;
        model.status = 'incompatible';
        model.httpCode = '200';
        model.lastError = {
          code: '200',
          message: message || 'Model returned no usable text.',
          updatedAt: Date.now(),
        };
      };

      // A gateway can refuse a request for an account reason inside an HTTP 200 whose body
      // otherwise reads as a completion — the key's budget, a spent credit balance (see
      // isAccountBudgetRefusalText). That is neither an answer to promote the row with nor a
      // verdict about the *model*, which is what markModelIncompatible would say: the model is
      // fine, the credential is out. So the row goes on the clock the same way a text-only rate
      // limit puts it there — and records no latency or speed sample, so a refusal's own words
      // never enter the averages the router routes on.
      const markModelBudgetRefused = (model, message) => {
        if (!model) return;
        const now = Date.now();
        model.status = 'rate-limited';
        model.httpCode = '429';
        model.lastError = {
          code: '429',
          message: (message || 'Provider refused the request: this account is out of budget.').slice(0, 500),
          updatedAt: now,
        };
        model.rateLimit = reconcileRateLimitState(
          model.rateLimit,
          { wasRateLimited: true, capturedAt: now },
          429,
          now,
        );
      };

      // A rejected request is real evidence about a row, so it belongs in the ping
      // history and the dashboard's Last Error — but it is not an availability verdict.
      // This model is up; one request's shape was wrong. Status is deliberately left
      // alone, so the sanitized form of the next request can still route here. Non-200
      // pings never enter the latency average, so the sample cannot flatter the row.
      const recordProxyRejection = (model, status, message, ms) => {
        if (!model) return;
        const now = Date.now();
        model.pings.push({ ms: Number.isFinite(ms) ? ms : 0, code: String(status), ts: now });
        if (model.pings.length > 50) model.pings.shift();
        model.httpCode = String(status);
        model.lastError = {
          code: String(status),
          message: (message || `Upstream rejected the request with HTTP ${status}.`).slice(0, 500),
          updatedAt: now,
        };
      };

      // Fields the outbound sanitizer removed for this request, disclosed to the
      // caller on the response so a rewritten payload is never invisible.
      const requestStrippedFields = new Set();

      // Set when the pre-flight body check already resolved the next candidate, so
      // the retry iteration doesn't re-rank (and re-mark) the same models.
      let pendingCandidate = null;

      for (let retry = 0; retry <= MAX_PROACTIVE_RETRIES; retry++) {
        const best = pendingCandidate || pickNextModel();
        pendingCandidate = null;
        if (!best) break;

        attemptedModelKeys.add(getRoutingModelKey(best));
        attemptedProviderKeys.add(best.providerKey);
        payload.model = best.modelId;

        const currentConfig = loadConfig();
        // Multi-account pool: the credential the pool says is serving, if any is configured
        const rotKey = getNextApiKey(currentConfig, best.providerKey)
        let providerAuth = rotKey
          ? { token: rotKey, authSource: 'api-key', providerUrlOverride: null }
          : await resolveProviderAuthToken(currentConfig, best.providerKey);
        let providerUrl = resolveProviderUrl(currentConfig, best.providerKey, providerAuth.providerUrlOverride, best.providerUrl);

        const attemptMeta = {
          index: retry + 1,
          model: best.modelId,
          provider: best.providerKey,
          status: 'pending',
          duration: null,
          retryable: false,
        };

        if (!providerAuth.token && !isProviderAuthOptional(currentConfig, best.providerKey)) {
          attemptMeta.status = 'NO_KEY';
          attemptMeta.error = `No API key configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        // A provider's keyless tier can be a subset of its catalog (Pollinations answers
        // anonymously for its free ids and 401s on the premium ones). Refusing here turns
        // that into a statement about the model instead of a 401 attributed to the whole
        // provider, which would mark a perfectly healthy keyless row as down.
        if (!providerAuth.token && shapedModelNeedsKey(best.providerKey, best.modelId)) {
          attemptMeta.status = 'NO_KEY';
          attemptMeta.error = `${best.providerKey}/${best.modelId} needs a key; this provider's keyless tier covers other models.`;
          attempts.push(attemptMeta);
          continue;
        }

        if (!providerUrl) {
          attemptMeta.status = 'NO_URL';
          attemptMeta.error = `No provider URL configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        console.log(chalk.dim(`  [Router] ➡️ Proxying request (attempt ${retry + 1}/${MAX_PROACTIVE_RETRIES + 1}) to ${best.providerKey}/${best.modelId} (${best.status === 'up' && best.pings.length > 0 ? best.pings[best.pings.length - 1].ms + 'ms' : 'fallback'})`));

        // Codex's workspace identity rides the headers and can only come from the
        // resolved account, so it is threaded through both the headers and the body.
        const codexOptions = best.providerKey === OPENAI_CODEX_PROVIDER_KEY
          ? { codexAccountId: providerAuth.account?.accountId || null, codexResidency: providerAuth.account?.residency || null }
          : {};
        let headers = buildProviderRequestHeaders(best.providerKey, {
          apiKey: providerAuth.token,
          isExplicitFreemodelsKey: isExplicitFreemodelsKey(currentConfig, best.providerKey),
          // Copilot reads X-Initiator from the conversation: a trailing user turn is
          // user-initiated, an agent/tool turn is not.
          messages: payload?.messages,
          ...codexOptions,
        });
        const kiroOptions = best.providerKey === KIRO_PROVIDER_KEY
          ? { profileArn: currentConfig?.providers?.kiro?.profileArn || null }
          : {};
        let devinOptions = {};
        if (best.providerKey === DEVIN_PROVIDER_KEY) {
          // The gateway expects a short-lived user JWT from the GetUserJwt prelude plus
          // the released Devin CLI metadata (mirrors the Devin CLI / @oh-my-pi client).
          const storedUserJwt = currentConfig?.providers?.[DEVIN_PROVIDER_KEY]?.userJwt || null;
          try {
            const devinAuth = await fetchDevinUserJwt(providerAuth.token, { signal: AbortSignal.timeout(UPSTREAM_HEADERS_TIMEOUT_MS) });
            devinOptions = {
              apiKey: providerAuth.token,
              sessionId: makeProviderSessionId('ses'),
              userJwt: devinAuth.userJwt || storedUserJwt,
            };
            if (devinAuth.customApiServerUrl) {
              providerUrl = `${String(devinAuth.customApiServerUrl).replace(/\/+$/, '')}${DEVIN_CHAT_PATH}`;
            }
          } catch (err) {
            // Surface readable Devin auth errors instead of retrying into raw binary frames.
            throw new Error(err?.message || 'Devin auth failed.');
          }
        }
        // An output budget belongs to the model, not to the caller: the clamp is applied
        // to a copy of the client body for this attempt only, so failing over to a model
        // with a larger ceiling still gets the budget that was actually asked for.
        const outputCap = outputCapFor(best);
        const attemptPayload = outputCap != null ? withOutputBudgetCap(payload, outputCap).body : payload;
        let { body: providerPayload, stripped: strippedFields } = sanitizeOutboundPayload(
          buildProviderRequestBody(best.providerKey, attemptPayload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions }),
          best.providerKey,
        );
        for (const field of strippedFields) requestStrippedFields.add(field);

        // The clock restarts after a healing round trip, so a latency sample always
        // belongs to the request that actually answered.
        let t0 = performance.now();
        let response;
        // Bound the connect/headers phase: a provider that never responds (no headers,
        // no stream) aborts after UPSTREAM_HEADERS_TIMEOUT_MS instead of hanging forever.
        const upstreamController = new AbortController();
        selectedUpstreamController = upstreamController;
        // A provider may declare a longer upstream budget than hammer's default (GLM's
        // coding plan is documented at fifty minutes). It is honoured, but capped: this
        // timer guards the connect-and-headers phase, and letting one wedged connection
        // hold a request slot for an hour would be worse than aborting it.
        const upstreamHeadersTimeoutMs = Math.min(
          shapedTimeoutMs(best.providerKey) || UPSTREAM_HEADERS_TIMEOUT_MS,
          10 * 60 * 1000,
        );
        const armUpstreamTimer = () => setTimeout(() => upstreamController.abort(), upstreamHeadersTimeoutMs);
        let upstreamTimer = armUpstreamTimer();
        const clearUpstreamTimer = () => { clearTimeout(upstreamTimer); upstreamTimer = null; };
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: serializeProviderRequestBody(providerPayload),
            signal: upstreamController.signal,
          });
          clearUpstreamTimer();

          // Copilot: a chat-surface identity denial (HTTP 403, or 400
          // model_not_supported on business hosts) means the org gates that surface,
          // not that the model is broken. Retry once as the CLI identity that the
          // Copilot CLI itself uses before treating the attempt as a failure.
          if (best.providerKey === GITHUB_COPILOT_PROVIDER_KEY && (response.status === 403 || response.status === 400)) {
            const denialBody = await response.clone().text().catch(() => '');
            if (isCopilotIdentityDenied(response.status, denialBody)) {
              console.log(chalk.yellow('  [Router] 🔁 GitHub Copilot chat identity denied; retrying as the Copilot CLI identity.'));
              upstreamTimer = armUpstreamTimer();
              response = await fetch(providerUrl, {
                method: 'POST',
                headers: buildProviderRequestHeaders(best.providerKey, {
                  apiKey: providerAuth.token,
                  copilotIntegrationId: COPILOT_CLI_INTEGRATION_ID,
                  messages: payload?.messages,
                  isExplicitFreemodelsKey: isExplicitFreemodelsKey(currentConfig, best.providerKey),
                }),
                body: serializeProviderRequestBody(providerPayload),
                signal: upstreamController.signal,
              });
              clearUpstreamTimer();
            }
          }

          if (shouldRetryOptionalProviderWithBearer(currentConfig, best.providerKey, providerAuth, String(response.status), null)) {
            const fallbackToken = getNextApiKey(currentConfig, best.providerKey);
            if (fallbackToken) {
              providerAuth = { token: fallbackToken, authSource: 'api-key', providerUrlOverride: providerAuth.providerUrlOverride };
              headers = buildProviderRequestHeaders(best.providerKey, {
                apiKey: fallbackToken,
                isExplicitFreemodelsKey: isExplicitFreemodelsKey(currentConfig, best.providerKey),
                ...codexOptions,
              });
              ({ body: providerPayload, stripped: strippedFields } = sanitizeOutboundPayload(
                buildProviderRequestBody(best.providerKey, attemptPayload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions }),
                best.providerKey,
              ));
              for (const field of strippedFields) requestStrippedFields.add(field);
              upstreamTimer = armUpstreamTimer();
              response = await fetch(providerUrl, {
                method: 'POST',
                headers,
                body: serializeProviderRequestBody(providerPayload),
                signal: upstreamController.signal,
              });
              clearUpstreamTimer();
            }
          }
        } catch (err) {
          clearUpstreamTimer();
          attemptMeta.duration = Math.round(performance.now() - t0);
          attemptMeta.status = 'ERR';
          attemptMeta.error = err?.message || 'Unknown network error';
          attemptMeta.retryable = true;
          attempts.push(attemptMeta);
          // Nothing reached the provider at all — the one failure mode that used to leave no trace
          // anywhere, which is how a fleet-wide timeout stayed invisible while the dashboard read
          // Up. Report it, and on the first bench of an outage ask the provider's rows directly so
          // a provider that is already answering again is noticed in seconds, not at the next
          // probe cycle.
          noteProviderUnreachable(
            providerScopeKey(best),
            err?.message || 'request could not reach the provider',
            `${best.providerKey}/${best.modelId}`,
            { reprobe: true },
          );
          if (retry === MAX_PROACTIVE_RETRIES) {
            throw err;
          }
          retryableFailureSeen = true;
          continue;
        }

        // A provider that refuses the *shape* of a replayed turn — a field the client
        // sent and the router dutifully forwarded — is a solvable problem, not a dead
        // end. Drop exactly the fields the provider named and ask the same model again:
        // the answer then still comes from the model the router picked, so a
        // mid-conversation turn never silently changes identity. The rejection is
        // remembered, so this costs one round trip per provider, not one per turn.
        //
        // The same round trip corrects an output budget the model cannot accept. Groq
        // answers "`max_tokens` must be less than or equal to `16384`" to every request
        // above that ceiling, which is a fact about the model rather than about this
        // prompt — without the correction the row looked healthy in the dashboard while
        // every turn aimed at it failed over to another model. Both corrections ride one
        // retry because a rejection may name either one, and re-asking per complaint
        // would spend two round trips on a model the loop might never come back to.
        let schemaRejection = null;
        let schemaRejectionText = '';
        let cappedFrom = null;
        if (!response.ok && response.status === 400) {
          schemaRejectionText = await response.clone().text().catch(() => '');
          const parsed = parseRejectedFields(schemaRejectionText);
          if (isHealableFieldRejection(parsed)) schemaRejection = parsed;
          const statedCap = parseMaxTokensCapFromError(schemaRejectionText);
          const capped = statedCap != null ? withOutputBudgetCap(attemptPayload, statedCap) : null;
          const clampApplies = Boolean(capped && capped.applied);
          // Recorded before the retry, so a model the router can already serve is not
          // left looking unrepairable if the retry itself fails.
          if (clampApplies) {
            cappedFrom = statedCap;
            rememberOutputCap(best, statedCap, schemaRejectionText);
          }
          if (schemaRejection || clampApplies) {
            if (schemaRejection) recordLearnedStrips(learnedFieldStrips, best.providerKey, schemaRejection);
            // Rebuilt from the client body rather than patched: the clamp lives on the
            // request, the field strip lives in the learned store, and both provider
            // translations (Kiro's protobuf, Codex's Responses shape) then agree with
            // the record of what was actually sent.
            const healed = sanitizeOutboundPayload(
              buildProviderRequestBody(best.providerKey, clampApplies ? capped.body : attemptPayload, best.modelId, { ...kiroOptions, ...devinOptions, ...codexOptions }),
              best.providerKey,
            );
            if (healed.stripped.length > 0 || clampApplies) {
              for (const field of healed.stripped) requestStrippedFields.add(field);
              const what = [
                healed.stripped.length > 0 ? `rejected ${healed.stripped.join(', ')}` : '',
                clampApplies
                  ? `caps max_tokens at ${statedCap}${requestedOutputBudget(attemptPayload) != null ? ` (asked for ${requestedOutputBudget(attemptPayload)})` : ''}`
                  : '',
              ].filter(Boolean).join(' and ');
              console.log(chalk.yellow(`  [Router] 🩹 ${best.providerKey}/${best.modelId} ${what}; retrying the same model with the corrected request.`));
              upstreamTimer = armUpstreamTimer();
              try {
                response = await fetch(providerUrl, {
                  method: 'POST',
                  headers,
                  body: serializeProviderRequestBody(healed.body),
                  signal: upstreamController.signal,
                });
                clearUpstreamTimer();
                attemptMeta.healedFrom = clampApplies
                  ? [...healed.stripped, `max_tokens<=${statedCap}`]
                  : healed.stripped;
                t0 = performance.now();
                // A correction the provider still refuses is reported from *its* words,
                // not from the complaint that prompted the retry.
                if (!response.ok && response.status === 400) {
                  const retryText = await response.clone().text().catch(() => '');
                  if (retryText) schemaRejectionText = retryText;
                }
              } catch {
                // The healed retry never reached the provider: keep the original
                // rejection so the failure is reported as what it actually was.
                clearUpstreamTimer();
              }
            }
          }
        }

        attemptMeta.duration = Math.round(performance.now() - t0);
        attemptMeta.status = String(response.status);
        attemptMeta.retryable = isRetryableProxyStatus(response.status);
        // A shape or budget rejection that healing could not resolve is evidence about
        // this payload, not about the model, so the loop fails over instead of handing
        // the caller a 400 that reads like a misconfiguration. A pinned model keeps its
        // error visible: a pin outranks substitution everywhere else too.
        if ((schemaRejection || cappedFrom != null) && !response.ok) {
          attemptMeta.error = schemaRejectionText.slice(0, 500);
          attemptMeta.rejection = schemaRejection ? describeRejection(schemaRejection) : `max_tokens > ${cappedFrom}`;
          if (!requestPinnedModelId) attemptMeta.retryable = true;
        }
        if (isSmartestRequest && !attemptMeta.retryable && response.status >= 400) {
          try {
            const bodyText = await response.clone().text();
            if (isQuotaExhaustionError(bodyText, response.status)) {
              attemptMeta.retryable = true;
              attemptMeta.error = bodyText;
            } else if (isOverLengthErrorText(bodyText)) {
              // The prompt overflows (or exceeds a max_tokens cap on) this model, but
              // a smaller sibling can often still serve it. Fall through only when
              // another candidate actually exists — otherwise keep this model's
              // explanatory 400 instead of replacing it with a generic 503.
              const alternative = retry < MAX_PROACTIVE_RETRIES ? pickNextModel() : null;
              attemptMeta.error = bodyText;
              if (alternative) {
                pendingCandidate = alternative;
                attemptMeta.retryable = true;
              }
            }
          } catch {
            // Keep the normal status-based retry decision when the body cannot be cloned.
          }
        }
        attempts.push(attemptMeta);

        // On 429: bench the credential this attempt used so the next retry picks a different
        // one. For a sign-in provider the thing to bench is the account secret the resolver
        // selected, not `token` — that is a short-lived access token freshly minted per
        // request, so it names no account and has nothing to fail over to.
        // The refusal is read once, here, and the credential is benched for as long as the
        // provider said — the window it states in the body when it states one (Gemini's
        // "Please retry in Ns", OpenRouter's reset header), else its `retry-after`, else the
        // local default. Benching happens after the capture because the body is the only place
        // some providers put the number, and capture is what reads it.
        const capture = await captureProxyRateLimit(best, response, providerAuth.token);
        if (response.status === 429) {
          const credential = providerAuth.account?.secret || providerAuth.token
          if (credential) {
            const stated = Number(capture?.resetAt)
            markRateLimited(
              best.providerKey,
              credential,
              Number.isFinite(stated) && stated > 0 ? Math.max(0, stated - Date.now()) : credentialResetHintMs(response),
            )
          }
        }

        // A credential the provider refused outright. `401` is not retryable within a request
        // (see `isRetryableProxyStatus`), so without a bench the pool would keep handing out
        // the rejected credential on every later request and never reach the one behind it.
        if (response.status === 401 && providerAuth.token) {
          markCredentialRejected(best.providerKey, providerAuth.account?.secret || providerAuth.token)
        }

        if (response.ok) {
          if (best.providerKey === KIRO_PROVIDER_KEY) {
            response = await transformKiroResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === DEVIN_PROVIDER_KEY) {
            // Decode Connect frames (gzip + protobuf) into an OpenAI-format response so
            // clients never receive the raw binary stream that appeared as mojibake.
            response = await transformDevinResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === OPENAI_CODEX_PROVIDER_KEY) {
            // Codex answers only in Responses SSE, so every client gets the stream
            // translated into chat.completion chunks (or one body when it asked for
            // JSON) before the response is validated and piped below.
            response = await transformCodexResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === FREEMODELS_PROVIDER_KEY) {
            // FreeModels answers HTTP 200 with an SSE error frame when its backend is
            // overloaded. transformFreeModelsResponse converts that to a synthetic 503
            // (non-streaming) or arms a stream guard that fails fast (streaming), so
            // the retry below can fall through to another model instead of piping the
            // garbage 200 to the client.
            response = await transformFreeModelsResponse(response, best.modelId, Boolean(payload.stream));
          } else if (best.providerKey === GPTFREE_PROVIDER_KEY) {
            // gptfree's own named-event SSE is translated here — answer frames forwarded,
            // agent step frames dropped, an error frame turned into the synthetic 503 the
            // retry loop can fail over on (see transformGptFreeResponse).
            response = await transformGptFreeResponse(response, best.modelId, Boolean(payload.stream));
          } else if (payload.stream && response.ok) {
            response = await transformStreamingUpstreamErrorResponse(response);
          }
          if (response.ok && !payload.stream) {
            const bodyPreview = await response.clone().text().catch(() => '');
            const upstreamError = findUpstreamSseError(bodyPreview);
            if (upstreamError) {
              attemptMeta.status = 'UPSTREAM_ERROR';
              attemptMeta.retryable = true;
              attemptMeta.error = upstreamError.message || 'Upstream reported an error.';
              response = syntheticUpstreamErrorResponse(upstreamError);
              lastProxyError = {
                at: Date.now(),
                message: attemptMeta.error,
                model: best.modelId,
                provider: best.providerKey,
                fallback: retry < MAX_PROACTIVE_RETRIES,
              };
              if (retry < MAX_PROACTIVE_RETRIES) {
                retryableFailureSeen = true;
                continue;
              }
            }
          }
          if (response.status >= 400) {
            attemptMeta.status = String(response.status);
            attemptMeta.retryable = isRetryableProxyStatus(response.status);
            if (attemptMeta.retryable && retry < MAX_PROACTIVE_RETRIES) {
              attemptMeta.error = await response.text().catch(() => '');
              console.log(chalk.yellow(`  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`));
              retryableFailureSeen = true;
              continue;
            }
          }
          // Health is promoted only once the response body is validated below —
          // a 200 with an empty payload must not be recorded as an up/latency sample.
          selectedModel = best;
          selectedResponse = response;
          selectedT0 = t0;
          selectedProbeMs = attemptMeta.duration;
          break;
        }

        if (attemptMeta.retryable && retry < MAX_PROACTIVE_RETRIES) {
          let retryBody = '';
          try {
            retryBody = await response.text();
            attemptMeta.error = retryBody;
          } catch {
            attemptMeta.error = '<Could not read retry response body>';
          }
          recordContextObservation(best, retryBody, payload.messages);
          console.log(chalk.yellow(`  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`));
          retryableFailureSeen = true;
          lastProxyError = {
            at: Date.now(),
            message: attemptMeta.error || `Upstream request failed with HTTP ${response.status}.`,
            model: best.modelId,
            provider: best.providerKey,
            fallback: true,
          };
          continue;
        }

        // About to hand this response to the caller: record it against the row so the
        // dashboard, QoS and the request log agree with what the client actually saw.
        // Previously a relayed 4xx left the row with a clean record, which is how one
        // strict provider kept being chosen and kept refusing the same payload.
        if (!response.ok) {
          recordProxyRejection(best, response.status, attemptMeta.error, attemptMeta.duration);
          lastProxyError = {
            at: Date.now(),
            message: attemptMeta.error || `Upstream request failed with HTTP ${response.status}.`,
            model: best.modelId,
            provider: best.providerKey,
            fallback: false,
          };
        }

        selectedModel = best;
        selectedResponse = response;
        selectedT0 = t0;
        break;
      }

      if (!selectedResponse || !selectedModel) {
        logEntry.status = '503';
        logEntry.error = { message: 'No models currently available for this request.', attempts };
        logEntry.retryCount = Math.max(0, attempts.length - 1);
        if (persistLogs) scheduleLogSave();
        lastProxyError = {
          at: Date.now(),
          message: 'No models currently available for this request.',
          fallback: false,
        };
        return res.status(503).json({ error: { message: 'No models currently available for this request.' }, attempts });
      }

      logEntry.model = selectedModel.modelId;
      logEntry.provider = selectedModel.providerKey;
      logEntry.duration = Math.round(performance.now() - selectedT0);
      logEntry.status = String(selectedResponse.status);
      logEntry.retryCount = Math.max(0, attempts.length - 1);
      if (requestStrippedFields.size > 0) logEntry.sanitized = [...requestStrippedFields];
      if (attempts.length > 1) {
        lastProxyError = {
          at: Date.now(),
          message: `Fallback selected ${selectedModel.providerKey}/${selectedModel.modelId} after an upstream failure.`,
          model: selectedModel.modelId,
          provider: selectedModel.providerKey,
          fallback: true,
        };
      } else if (selectedResponse.ok) {
        lastProxyError = null;
      }

      res.status(selectedResponse.status);

      for (const [key, value] of selectedResponse.headers.entries()) {
        if (['content-type', 'transfer-encoding', 'cache-control', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      // Which model actually answered. A retryable upstream failure can land the
      // request on a different model than the caller named, so a client must be able
      // to detect the substitution instead of trusting the request it sent. A
      // best/smartest request names no model, so it is never "substituted".
      const requestedCanonical = (!isSmartestRequest && requestedModelId)
        ? canonicalizeModelId(requestedModelId)
        : null;
      const servedCanonical = canonicalizeModelId(String(selectedModel.modelId));
      const sameModel = requestedCanonical
        && (requestedCanonical.base === servedCanonical.base
          || requestedCanonical.unprefixed === servedCanonical.unprefixed);
      res.setHeader('X-Hammer-Model', selectedModel.modelId);
      res.setHeader('X-Hammer-Provider', selectedModel.providerKey);
      // best/smartest names no model, so it can never be "substituted".
      res.setHeader('X-Hammer-Substituted', requestedCanonical && !sameModel ? '1' : '0');
      // Disclose a rewritten payload the same way a substituted model is disclosed: a
      // client that sent a field the router removed has to be able to see that.
      if (requestStrippedFields.size > 0) {
        res.setHeader('X-Hammer-Sanitized', [...requestStrippedFields].join(','));
      }
      // And when an upstream 4xx is being relayed, name the reason in a header, so a
      // client banner does not read a provider-schema refusal as a configuration fault.
      if (!selectedResponse.ok && lastProxyError?.message) {
        res.setHeader(
          'X-Hammer-Hint',
          String(lastProxyError.message).replace(/[^\x20-\x7E]+/g, ' ').trim().slice(0, 300),
        );
      }

      if (selectedResponse.body) {
        const { Readable, Transform } = await import('stream');

        let responseBodyText = '';
        let ttftCaptured = false;
        // The window the *answer* frames spanned, which is the generation time when the
        // provider streams as it generates and nothing but delivery time when it banks
        // the whole answer (see resolveStreamGenerationMs). A frame counts as output
        // when it carries content, reasoning or tool-call payload — the role-only
        // opening frame of a stream is not an answer (see OUTPUT_FRAME_RE).
        let firstOutputAt = 0;
        let lastOutputAt = 0;
        let streamEnded = false;
        const MAX_LOG_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit for logging
        // The account refusal a proxy body carries, as its own words, or '' when it carries none
        // (see isAccountBudgetRefusalText). Bounded to a notice's size so a real answer's body is
        // never read a second time on the hot path: the predicate only ever matches a notice.
        const MAX_REFUSAL_SCAN_BODY_SIZE = 64 * 1024;
        const accountRefusalIn = (body) => {
          if (body.length > MAX_REFUSAL_SCAN_BODY_SIZE) return '';
          const answerText = summarizeTestAnswer(body).text.trim();
          return isAccountBudgetRefusalText(answerText) ? answerText : '';
        };

        // Idle watchdog: if the provider stops sending data mid-stream, abort the
        // upstream fetch and end the client response instead of hanging forever.
        let idleTimer = null;
        const armIdleWatchdog = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            try { selectedUpstreamController?.abort(); } catch { }
            finalizeStream('Upstream stream stalled (idle timeout).');
          }, UPSTREAM_IDLE_TIMEOUT_MS);
        };
        const clearIdleWatchdog = () => { clearTimeout(idleTimer); idleTimer = null; };

        // Ends the client response and finalizes the log entry after an upstream stream
        // error or idle timeout. For SSE clients, emit a well-formed error event so the
        // caller sees a failure instead of a silent truncation.
        const finalizeStream = (message) => {
          if (streamEnded) return;
          streamEnded = true;
          clearIdleWatchdog();
          logEntry.status = 'err';
          logEntry.error = message;
          if (persistLogs) scheduleLogSave();
          try {
            if (payload.stream && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: { message }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`);
              res.end();
            } else if (!res.writableEnded) {
              res.destroy(new Error(message));
            }
          } catch { /* client already gone */ }
        };

        const captureStream = new Transform({
          transform(chunk, encoding, callback) {
            armIdleWatchdog();
            if (!ttftCaptured) {
              ttftCaptured = true;
              logEntry.ttft = Math.round(performance.now() - selectedT0);
            }
            if (OUTPUT_FRAME_RE.test(chunk.toString())) {
              const at = performance.now();
              if (!firstOutputAt) firstOutputAt = at;
              lastOutputAt = at;
            }
            // Only accumulate up to limit to prevent OOM
            if (responseBodyText.length < MAX_LOG_BODY_SIZE) {
              responseBodyText += chunk.toString();
            }
            callback(null, chunk);
          },
          flush(callback) {
            clearIdleWatchdog();
            streamEnded = true;
            try {
              const wasTruncated = responseBodyText.length >= MAX_LOG_BODY_SIZE;

              if (selectedResponse.status >= 400) {
                try {
                  const errorData = JSON.parse(responseBodyText);
                  logEntry.error = errorData;
                } catch {
                  logEntry.error = responseBodyText + (wasTruncated ? '... (truncated)' : '');
                }
                recordContextObservation(selectedModel, extractErrorText(logEntry.error), payload.messages);
              } else if (accountRefusalIn(responseBodyText)) {
                // A gateway can refuse a request for an account reason inside a 200 whose body
                // otherwise reads as a completion — the key's own budget, a spent credit balance
                // (see markModelBudgetRefused). Named before the shape checks below, because such
                // a body is a valid completion to every one of them. One rule for both client
                // shapes: this branch is reached whether the client asked for a stream or not.
                markModelBudgetRefused(selectedModel, accountRefusalIn(responseBodyText));
              } else if (payload.stream) {
                const lines = responseBodyText.split('\n');
                let fullContent = '';
                // Everything the model emitted, for the generation-speed estimate below:
                // streamed reasoning and tool-call arguments are output tokens too, and
                // relays that report no usage (FreeModels) stream reasoning the most.
                let outputText = '';
                let toolCalls = [];
                let functionCall = null;
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(trimmed.slice(6));
                      captureResolvedModel(logEntry, data);
                      const frameModel = upstreamModelIdOfPayload(data);
                      if (frameModel) rememberUpstreamModelId(selectedModel, frameModel);
                      if (data.choices && data.choices[0] && data.choices[0].delta) {
                        const delta = data.choices[0].delta;
                        if (delta.content) { fullContent += delta.content; outputText += delta.content; }
                        if (typeof delta.reasoning_content === 'string') outputText += delta.reasoning_content;
                        if (delta.tool_calls) {
                          for (const tc of delta.tool_calls) {
                            // Gemini's OpenAI-compat streaming omits the `index` field that OpenAI
                            // includes on each tool_call chunk, so resolve the target slot: explicit
                            // index, else match by id, else append.
                            let idx = tc.index;
                            if (idx == null) {
                              idx = tc.id != null ? toolCalls.findIndex(t => t && t.id === tc.id) : -1;
                              if (idx === -1) idx = toolCalls.length;
                            }
                            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
                            if (tc.id) toolCalls[idx].id = tc.id;
                            if (tc.type) toolCalls[idx].type = tc.type;
                            if (tc.function) {
                              if (tc.function.name) toolCalls[idx].function.name += tc.function.name;
                              if (tc.function.arguments) { toolCalls[idx].function.arguments += tc.function.arguments; outputText += tc.function.arguments; }
                            }
                            // Gemini thinking models attach thought_signature to function call parts
                            // (nested under extra_content.google in the OpenAI-compat response)
                            if (tc.extra_content) toolCalls[idx].extra_content = tc.extra_content;
                            if (tc.thought_signature) toolCalls[idx].thought_signature = tc.thought_signature;
                          }
                        }
                        if (delta.function_call) {
                          if (!functionCall) functionCall = { name: '', arguments: '' };
                          if (delta.function_call.name) functionCall.name += delta.function_call.name;
                          if (delta.function_call.arguments) { functionCall.arguments += delta.function_call.arguments; outputText += delta.function_call.arguments; }
                        }
                      }
                      if (data.usage) {
                        if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                        if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                      }
                    } catch (e) { }
                  }
                }
                if (logContent && fullContent) logEntry.response = fullContent;
                if (toolCalls.length > 0) {
                  if (logContent) {
                    logEntry.tool_calls = toolCalls.filter(Boolean).map(tc => {
                      if (tc.function && tc.function.arguments) {
                        try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                      }
                      return tc;
                    });
                  }
                  // Cache thought_signatures from Google AI thinking-model responses
                  // (functional requirement, independent of the content-capture policy)
                  captureThoughtSignatures(toolCalls, selectedModel?.providerKey);
                }
                if (logContent && functionCall) {
                  if (functionCall.arguments) {
                    try { functionCall.arguments = JSON.parse(functionCall.arguments); } catch (e) { }
                  }
                  logEntry.function_call = functionCall;
                }
                // An empty or never-populated stream is not a healthy response even
                // though the transport said 200 — mark it incompatible instead of
                // promoting the model and recording a bogus sample.
                if (hasUsableChatCompletionBody(responseBodyText)) {
                  promoteSuccessfulModel(selectedModel, selectedProbeMs);
                  // Record real usage stats for this model/provider (streaming). The
                  // generation time comes from the answer's own frame window, not from
                  // "everything after the first byte": for a provider that releases the
                  // answer in one burst that remainder is delivery time, and dividing
                  // tokens by it is how a row came to claim ~6000 tok/s.
                  recordUsage(selectedModel, {
                    ttft: logEntry.ttft,
                    completionTokens: resolveCompletionTokens(logEntry.completion_tokens, outputText),
                    genMs: resolveStreamGenerationMs(
                      Math.round(performance.now() - selectedT0),
                      firstOutputAt ? lastOutputAt - firstOutputAt : 0,
                    ),
                    contextTokens: (logEntry.prompt_tokens != null && logEntry.completion_tokens != null)
                      ? logEntry.prompt_tokens + logEntry.completion_tokens
                      : null,
                  });
                } else {
                  markModelIncompatible(selectedModel);
                }
              } else if (!hasUsableChatCompletionBody(responseBodyText)) {
                // 2xx whose body carries no completion (empty choices, blank message,
                // or a non-JSON error page): never count it as a healthy sample.
                markModelIncompatible(selectedModel);
              } else {
                const data = JSON.parse(responseBodyText);
                captureResolvedModel(logEntry, data);
                const bodyModel = upstreamModelIdOfPayload(data);
                if (bodyModel) rememberUpstreamModelId(selectedModel, bodyModel);
                // Everything the model returned, for the token estimate when the
                // provider's usage block is missing (see resolveCompletionTokens).
                let outputText = '';
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  const msg = data.choices[0].message;
                  if (typeof msg.content === 'string') outputText += msg.content;
                  if (typeof msg.reasoning_content === 'string') outputText += msg.reasoning_content;
                  else if (typeof msg.reasoning === 'string') outputText += msg.reasoning;
                  if (Array.isArray(msg.tool_calls)) {
                    for (const tc of msg.tool_calls) {
                      if (typeof tc?.function?.arguments === 'string') outputText += tc.function.arguments;
                    }
                  }
                  if (typeof msg.function_call?.arguments === 'string') outputText += msg.function_call.arguments;
                  if (logContent && msg.content) logEntry.response = msg.content;
                  if (msg.tool_calls) {
                    if (logContent) {
                      logEntry.tool_calls = msg.tool_calls.map(tc => {
                        if (tc.function && typeof tc.function.arguments === 'string') {
                          try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                        }
                        return tc;
                      });
                    }
                    captureThoughtSignatures(msg.tool_calls, selectedModel?.providerKey);
                  }
                  if (logContent && msg.function_call) {
                    logEntry.function_call = { ...msg.function_call };
                    if (typeof logEntry.function_call.arguments === 'string') {
                      try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                    }
                  }
                }
                if (data.usage) {
                  if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                  if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                }
                // Body validated above: promote before recording the sample.
                promoteSuccessfulModel(selectedModel, selectedProbeMs);
                // Record real usage stats for this model/provider (non-streaming)
                recordUsage(selectedModel, {
                  ttft: logEntry.duration,
                  completionTokens: resolveCompletionTokens(logEntry.completion_tokens, outputText),
                  genMs: Math.max(1, Math.round(performance.now() - selectedT0)),
                  contextTokens: (logEntry.prompt_tokens != null && logEntry.completion_tokens != null)
                    ? logEntry.prompt_tokens + logEntry.completion_tokens
                    : null,
                });
              }
            } catch (e) {
              if (logContent) logEntry.response = "<Could not parse response payload>";
            }
            if (persistLogs) scheduleLogSave();
            callback();
          }
        });

        const nodeBody = Readable.fromWeb(selectedResponse.body);
        nodeBody.on('error', err => {
          if (err?.name === 'AbortError') {
            finalizeStream('Upstream request timed out.');
          }
          // Otherwise the upstream failed: the captureStream error handler below
          // covers the 'stream not found' case, and the client sees the upstream
          // error body as SSE frames when the provider emits them. Do not double-
          // finalize and close the client before any relayed frames arrive.
        });
        captureStream.on('error', err => finalizeStream(err?.message || 'Upstream stream error.'));
        // Client disconnected before the stream finished: cancel the upstream fetch so
        // its connection is released instead of leaking until the provider ends.
        res.on('close', () => {
          if (!res.writableEnded && !streamEnded) {
            try { selectedUpstreamController?.abort(); } catch { }
          }
        });
        armIdleWatchdog();
        const pipeWithErrorHandling = (src, dest) => {
          // Only genuine pipe failures finalize here. A normal src 'end' must NOT:
          // captureStream's flush() runs afterwards and owns the healthy-completion
          // path — finalizing on 'end' tears down the client mid-response.
          const finished = () => { if (!streamEnded) finalizeStream('⚠️ No response from agent'); };
          src.on('error', finished);
          dest.on('error', finished);
          return src.pipe(dest);
        };
        // A provider that leaks its tool-call envelope leaves DeepSeek's special-token markup in
        // `content`, which a client renders as the assistant's message and then replays forever
        // (see lib/tool-call-residue.js). The guard sits *after* captureStream on purpose: the log
        // and the verdicts keep the provider's raw bytes, because a leak is evidence about the
        // provider and this capture is the only place it can be observed. Scrubbing before it would
        // delete the only proof that a provider does this.
        const residueFilter = createResidueStreamFilter();
        const residueDecoder = new TextDecoder();
        const residueGuard = new Transform({
          transform(chunk, encoding, callback) {
            // Decode rather than chunk.toString(): a chunk can split a multi-byte character in two,
            // which toString replaces with U+FFFD (the same reason readStreamedAnswer decodes).
            const out = residueFilter.push(residueDecoder.decode(chunk, { stream: true }));
            if (out) callback(null, out);
            else callback();
          },
          flush(callback) {
            // Release both what the decoder held for an incomplete character and the filter's
            // withheld tag prefix, so a stream that ends mid-tag loses nothing.
            const tail = residueFilter.push(residueDecoder.decode()) + residueFilter.flush();
            if (tail) this.push(tail);
            callback();
          },
        });
        pipeWithErrorHandling(nodeBody, captureStream).pipe(residueGuard).pipe(res);
      } else {
        // Bound the body read for non-streaming responses: a provider that stalls
        // mid-body aborts instead of hanging the client.
        let text;
        if (selectedUpstreamController) {
          const bodyTimer = setTimeout(() => { try { selectedUpstreamController.abort(); } catch { } }, UPSTREAM_HEADERS_TIMEOUT_MS);
          try {
            text = await selectedResponse.text();
          } finally {
            clearTimeout(bodyTimer);
          }
        } else {
          text = await selectedResponse.text();
        }
        const measuredTtft = Number(selectedResponse.headers.get('x-hammer-ttft-ms'));
        const measuredGeneration = Number(selectedResponse.headers.get('x-hammer-generation-ms'));
        const measuredTokens = Number(selectedResponse.headers.get('x-hammer-completion-tokens'));
        logEntry.ttft = Number.isFinite(measuredTtft) && measuredTtft >= 0 ? Math.round(measuredTtft) : logEntry.duration;
        if (Number.isFinite(measuredTokens) && measuredTokens > 0) logEntry.completion_tokens = Math.round(measuredTokens);
        if (selectedResponse.status >= 400) {
          try {
            logEntry.error = JSON.parse(text);
          } catch {
            logEntry.error = text;
          }
          recordContextObservation(selectedModel, extractErrorText(logEntry.error), payload.messages);
        } else {
          try {
            const data = JSON.parse(text);
            captureResolvedModel(logEntry, data);
            const textModel = upstreamModelIdOfPayload(data);
            if (textModel) rememberUpstreamModelId(selectedModel, textModel);
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const msg = data.choices[0].message;
              if (logContent && msg.content) logEntry.response = msg.content;
              if (msg.tool_calls) {
                if (logContent) {
                  logEntry.tool_calls = msg.tool_calls.map(tc => {
                    if (tc.function && typeof tc.function.arguments === 'string') {
                      try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                    }
                    return tc;
                  });
                }
                captureThoughtSignatures(msg.tool_calls, selectedModel?.providerKey);
              }
              if (logContent && msg.function_call) {
                logEntry.function_call = { ...msg.function_call };
                if (typeof logEntry.function_call.arguments === 'string') {
                  try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                }
              }
            }
            if (data.usage) {
              if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
              if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
            }
          } catch (e) { }
        }
        if (selectedResponse.status < 400) {
          if (hasUsableChatCompletionBody(text)) {
            promoteSuccessfulModel(selectedModel, selectedProbeMs);
            recordUsage(selectedModel, {
              ttft: logEntry.ttft,
              completionTokens: logEntry.completion_tokens,
              genMs: Number.isFinite(measuredGeneration) && measuredGeneration > 0
                ? Math.round(measuredGeneration)
                : Math.max(1, Math.round(performance.now() - selectedT0)),
              contextTokens: (logEntry.prompt_tokens != null && logEntry.completion_tokens != null)
                ? logEntry.prompt_tokens + logEntry.completion_tokens
                : null,
            });
          } else {
            markModelIncompatible(selectedModel);
          }
        }
        // The one place a non-streamed body reaches a client, so one strip covers every provider.
        // The header copy above forwards content-type, transfer-encoding, cache-control and
        // connection only — never content-length — so a body that changes length is safe to write.
        res.end(scrubChatCompletionBody(text));
        if (persistLogs) scheduleLogSave();
      }
    } catch (e) {
      if (logEntry) {
        logEntry.status = 'err';
        logEntry.error = e.message;
      }
      console.error(chalk.red(`  [Router] Error processing request: ${e.message}`));
      if (logEntry && persistLogs) scheduleLogSave();
      // Upstream/network failures after retries are server-side problems, not client
      // errors -- report them as 502 so clients can retry instead of misdiagnosing
      // their own request as malformed.
      res.status(502).json({ error: { message: e.message } });
    }
  });

  const httpServer = app.listen(port, listenHost, () => {
    const lanIp = getPreferredLanIpv4Address();
    startupLoading = false
    kiroOAuthWarningCollector = null
    const elapsed = ((Date.now() - startupStartedAt) / 1000).toFixed(1)
    const reachable = results.filter(result => result.status === 'up').length
    const providerCount = new Set(results.map(result => result.providerKey)).size
    console.log();
    console.log(chalk.green(`  ✅ Hammer ready in ${elapsed}s — ${results.length} models · ${providerCount} providers · ${reachable} reachable`));
    console.log(chalk.green(`  ✅ Web UI active at ${chalk.bold(`http://localhost:${port}`)}`));
    if (lanMode) {
      if (lanIp) {
        console.log(chalk.green(`  ✅ LAN mode: visit ${chalk.bold(`http://${lanIp}:${port}`)} from other computers.`));
      }
      console.log(chalk.yellow(`  🔑 Access token (required from non-local clients): ${chalk.bold(accessToken)}`));
      console.log(chalk.dim(`  - Dashboard prompts for it once; proxy clients must send it as 'Authorization: Bearer <token>'.`));
    }
    console.log(chalk.green(`  ✅ Router proxy active at ${chalk.bold(`http://localhost:${port}/v1`)}`));
    console.log(chalk.dim(`  Usage in OpenCode/Cursor:`));
    console.log(chalk.dim(`  - Provider Base URL: http://localhost:${port}/v1`));
    console.log(chalk.dim(`  - API Key: (anything, ignored)`));
    console.log(chalk.dim(`  - Model: (anything, ignored)`));
    for (const warning of [...new Set(startupWarnings)]) console.log(chalk.yellow(`  ⚠ ${warning}`));
    console.log();
  });
  httpServer.on('error', err => {
    if (err?.code === 'EADDRINUSE') {
      console.error(chalk.red(`  ✖ Port ${port} is already in use. Hammer stopped stale instances before loading; pass --port <number> or free the port.`))
    } else {
      console.error(chalk.red(`  ✖ Hammer could not start: ${err?.message || err}`))
    }
    process.exit(1)
  });

}

/**
 * 📖 Provider behavior hooks
 *
 * The request path still owns these implementations — moving each into its own
 * descriptor is the next stage of this refactor — but they are registered against their
 * provider keys here so that a provider's descriptor and its behavior share one address
 * instead of living in two unrelated places. `registerProviderHooks` is handed the
 * functions rather than importing them, which is what keeps this module free to import
 * the registry (and the registry free of any dependency on this module) without a cycle.
 *
 * Header construction is deliberately absent: `buildProviderRequestHeaders` is one
 * function dispatching across every provider, so there are no per-provider header
 * builders to register yet. Splitting it is part of the same migration.
 */
registerProviderHooks(KIRO_PROVIDER_KEY, { buildBody: buildKiroRequestPayload });
registerProviderHooks(DEVIN_PROVIDER_KEY, { buildBody: buildDevinConnectRequest });
registerProviderHooks(FREEMODELS_PROVIDER_KEY, { buildBody: buildFreeModelsRequestPayload });
registerProviderHooks(GPTFREE_PROVIDER_KEY, {
  buildBody: buildGptFreeRequestPayload,
  transformResponse: transformGptFreeResponse,
});
registerProviderHooks(OPENAI_CODEX_PROVIDER_KEY, { buildBody: buildCodexRequestPayload });
