#!/usr/bin/env node
/**
 * ── Resolve OmniRoute roster entries into routing configuration ────────────────────────
 *
 * The vendored roster knows *that* a provider offers free access and what its terms say.
 * It does not know where to send a request. That lives in OmniRoute's provider registry —
 * ~200 hand-written TypeScript entries under `open-sse/config/providers/registry/<slug>/`.
 *
 * This tool reads those entries and emits `lib/providers/omniroute-resolved.json`, which
 * the loader merges over the roster. For each provider it decides one of three outcomes,
 * and records *why*:
 *
 *   `active`  — rides Hammer's existing generic OpenAI-compatible path. Reaching that bar
 *               takes four things: a chat-completions endpoint (declared, substituted from
 *               an override's OpenAI layer, taken from the provider's own declared OpenAI
 *               `alternateFormat`, or built from a URL template), an OpenAI-compatible wire
 *               format, a credential Hammer can send (a static key, an optional one, or
 *               none at all), and a request whose only differences are *data*. That last
 *               condition is what `EXECUTOR_PROFILES` exists for: a named executor is not a
 *               blocker when its differences are a header, a request default, an auth
 *               prefix, a URL suffix or a content shape, because those become fields on the
 *               descriptor that `lib/providers/adapters.js` reads. Discovery stays lazy, so
 *               the model list still comes from `/v1/models` on first use, not from here.
 *   `refused` — withheld by decision, for one of two reasons. Either the terms flag (from
 *               OmniRoute's own `FREE_TIER_TOS`, cross-checked against our vendored row) is
 *               `avoid` **and** `--exclude-avoid` was passed, or the row is in
 *               `NOT_FREE_KEYS` because its free-access premise does not hold. No endpoint
 *               is written at all, so the provider cannot route even by accident.
 *   `staged`  — genuinely not reachable over HTTP: a wire protocol with no declarative
 *               equivalent (a session cookie jar, GraphQL, an OAuth device flow, a second
 *               protocol) or a credential only the user can capture. `BESPOKE_EXECUTORS` names
 *               each protocol rather than saying "needs an adapter", so the next pass knows what
 *               it is taking on, and `DECLINED_EXECUTORS` records the one protocol that is
 *               deliberately not going to be built.
 *
 * Deliberately no network access happens at import time anywhere in `lib/` — this script
 * is the only place that talks to GitHub, and it runs when a human invokes it.
 *
 * Usage:
 *   node tools/resolve-omniroute-endpoints.mjs
 *   node tools/resolve-omniroute-endpoints.mjs --check   # report only
 *   node tools/resolve-omniroute-endpoints.mjs --provider mistral,together
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'diegosouzapw/OmniRoute'
const REF = 'main'
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}`
const INDEX_PATH = 'open-sse/config/providers/index.ts'
const REGISTRY_PREFIX = 'open-sse/config/providers/'
const RESOLVED_PATH = new URL('../lib/providers/omniroute-resolved.json', import.meta.url)
const CACHE_DIR = new URL('./.cache/omniroute/', import.meta.url)

/** Formats that can be proxied by hammer's generic OpenAI-compatible path. */
const GENERIC_OPENAI_FORMATS = new Set(['openai'])


/**
 * Roster keys whose registry directory is not the same as the key. Kept explicit rather
 * than guessed, so a mismatch is visible instead of silently resolving to nothing.
 */
const SLUG_OVERRIDES = {
  'glm-cn': 'glm/cn',
  'opencode-zen': 'opencode/zen',
  'kimi-coding': 'kimi/coding',
  'qwen-web': 'qwen/web',
}

/**
 * A `buildOpenAiCompatibleRegistryEntry` call means the entry inherits `format: "openai"`,
 * `authType: "apikey"` and `authHeader: "bearer"` from OmniRoute's own helper. That is a
 * statement by the upstream catalogue rather than an inference of ours, which is why it
 * counts as an explicit format.
 */
const OPENAI_HELPER_MARKER = 'buildOpenAiCompatibleRegistryEntry'

/**
 * Only a plain chat-completions endpoint can be reached without knowing how the provider
 * wants its request shaped. A `/chat/completions` suffix is the observable consequence of
 * the OpenAI wire format, so it is checked directly: `cloudflare-ai` advertises
 * `format: "openai"` but its base URL is an account root served by a custom executor.
 */
const CHAT_COMPLETIONS_SUFFIX = /\/chat\/completions\/?$/

/**
 * Providers whose upstream entry targets a non-OpenAI wire format, but which publish an
 * OpenAI-compatible endpoint anyway. Using it needs no translator, which is the whole
 * point: the alternative is writing and maintaining a format adapter for no gain.
 *
 * Each entry records why it is safe to substitute the endpoint.
 */
const OPENAI_COMPATIBLE_OVERRIDES = {
  gemini: {
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    why: "Google publishes an OpenAI-compatible layer at /v1beta/openai; hammer's own googleai provider already calls a sibling of this URL, so the shape is proven in-tree.",
  },
  deepseek: {
    chatUrl: 'https://api.deepseek.com/v1/chat/completions',
    why: "OmniRoute's entry targets the Responses API, but DeepSeek's documented OpenAI-compatible chat-completions endpoint is available and needs no translator.",
  },
}

/**
 * The evidence standard for calling a provider keyless, recorded because it was got wrong
 * once and the mistake is instructive.
 *
 * A public `/v1/models` is NOT evidence. `llm7` serves its model list with no credential,
 * which looked like proof, so it was briefly recorded here as keyless. It is not: a chat
 * completion without a key returns `missing_api_key`, and with a placeholder bearer returns
 * `invalid_api_key`. Discovery had only ever exercised the listing endpoint.
 *
 * So the bar is a **completion** returned with no credential — which is what makes
 * `uncloseai` legitimately keyless (verified 2026-09-22: a real `chat.completion` with no
 * header at all). Where the upstream declaration says `authType: "optional"`, that
 * declaration is accepted as-is, because it is the provider's own statement about itself.
 *
 * No overrides are currently needed; this comment is where the next one should record its
 * evidence, in this shape: `<completion|declared> — <date> — <what was actually observed>`.
 */
const KEYLESS_OVERRIDES = {}

/**
 * The mirror of {@link KEYLESS_OVERRIDES}: a declaration of keylessness that observation has
 * since contradicted.
 *
 * A provider's `authType` is its own statement about itself, which is normally the best
 * evidence available — but it goes stale silently, and the failure mode is expensive. Marking
 * a provider keyless when it now demands a key means every request is dispatched with no
 * credential, the 401 is attributed to the *provider's* health, and a healthy row is reported
 * down while the router keeps choosing it.
 *
 * `pollinations` carried `authType: "optional"` with a note dated 2026-07-20 saying a
 * completion succeeds with no credential. It does not any more. The declaration is recorded as
 * overridden rather than deleted, so the divergence stays visible and reversible: if the
 * keyless tier returns, removing the entry restores it.
 *
 * Evidence format: `<completion|declared> — <date> — <what was actually observed>`.
 */
const REQUIRES_KEY_EVIDENCE = {
  pollinations:
    'completion — 2026-09-22 — POST /v1/chat/completions with no credential returned HTTP 401 '
    + '{"success":false,"error":{"code":"UNAUTHORIZED","message":"A valid API key is required"}}, so the '
    + 'registry\'s `authType: "optional"` and its 2026-07-20 note are both stale',
}

/**
 * Executors that are `DefaultExecutor` plus data rather than bespoke transports.
 *
 * `executor: "default"` is the plain OpenAI-compatible path, but several providers point at
 * a small subclass whose only differences are expressible as data: frozen request defaults,
 * a non-bearer auth prefix, a static header, a URL suffix, or a different base URL.
 * "Different executor string" therefore does not by itself mean "needs an adapter" — this
 * table is the list of cases where the difference is data, and everything not in it is
 * treated as bespoke.
 *
 * Each entry cites where its values come from so a future reader can re-verify rather than
 * trust. The values are not invented: they are read out of OmniRoute's own modules, which
 * live under `open-sse/` in the repository cited at the top of this file.
 */
const EXECUTOR_PROFILES = {
  /**
   * GlmExecutor extends DefaultExecutor: same headers, same bearer, plus the frozen request
   * defaults from `open-sse/config/glmProvider.ts` and that module's 50-minute timeout
   * (Z.AI's Coding Plan FAQ documents `API_TIMEOUT_MS=3000000`).
   */
  glm: {
    requestDefaults: { max_tokens: 16384 },
    timeoutMs: 3000000,
  },
  /**
   * Pollinations answers anonymously and only 401s on its premium ids, which the executor
   * pre-empts with an explanatory error rather than dispatching (see its PREMIUM_MODELS).
   * `jsonMode` is added by the executor only when the caller asked for JSON: Pollinations
   * reads `jsonMode` as "must return JSON" and 400s any request whose messages don't
   * mention it.
   */
  pollinations: {
    jsonMode: true,
    premiumModels: ['claude', 'claude-fast', 'claude-large', 'gemini', 'gemini-fast', 'midijourney', 'midijourney-large'],
  },
  /**
   * CloudflareAIExecutor's only imperative work is building the account-scoped URL and
   * flattening OpenAI content-part arrays, which Workers AI rejects with HTTP 400. Both
   * are expressible: a URL template plus a required `accountId` credential field.
   *
   * The account id cannot be invented — Cloudflare's own docs point at the right-hand
   * sidebar of dash.cloudflare.com — so the provider stays inert until one is supplied.
   */
  'cloudflare-ai': {
    chatUrlTemplate: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions',
    /**
     * The model list is deliberately NOT the sibling of the chat path, because Workers AI has
     * no `GET /ai/v1/models`: its OpenAI-compatible layer serves only `/chat/completions`,
     * `/embeddings` and (GPT-OSS) `/responses`, so a derived `.../ai/v1/models` answers 404
     * and the provider would show an empty roster forever. The list lives on the platform's
     * Model Search endpoint instead, which is account-scoped like the chat path (verified
     * against Cloudflare's API reference, 2026-09-22).
     *
     * Two query parameters do the filtering that hammer would otherwise have to do in code:
     * `task=Text Generation` keeps the chat models and drops embeddings, image, ASR and
     * translation rows that carry no marker in their id, and `per_page=100` asks for the whole
     * roster in one page rather than the default twenty. The response is the platform's
     * `{ result: [...] }` envelope rather than OpenAI's `data`, which
     * `extractOpenAICompatibleModelRecords` understands. `format=openrouter` is available but
     * deliberately unused: it renames model ids, and the id is what goes in the request body.
     */
    modelsUrl:
      'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search?task=Text%20Generation&per_page=100',
    flattenTextContent: true,
    credentialFields: ['accountId'],
  },
  /**
   * QoderExecutor adds a single static header (`getQoderDefaultHeaders()` → the Qoder CLI
   * user agent) and resolves nothing else. Its `oauth` block names client-credentials env
   * vars rather than a static key, so the credential is an OAuth token.
   */
  qoder: {
    headers: { 'User-Agent': 'Qoder-Cli' },
    // A client-credentials mint rather than a static key: the entry's `oauth` block names
    // `QODER_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` and a token URL, both supplied by env, so
    // this is the same credential lifecycle class as hammer's own token-minting providers.
    credentialKind: 'token-mint',
  },
  /**
   * VertexExecutor's `urlBuilder` reads a project and region from provider-specific data.
   * Google publishes an OpenAI-compatible surface for the same models, so the template
   * below reaches it without a generateContent translator — at the cost of needing two
   * more credential fields than a plain bearer.
   */
  vertex: {
    chatUrlTemplate:
      'https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/endpoints/openapi/chat/completions',
    credentialFields: ['project', 'region'],
  },
}

/**
 * Executors whose request and response are framed by provider-specific code with no
 * declarative equivalent: a session cookie jar, GraphQL, an OAuth device flow, or a non-SSE
 * line protocol. They stay staged, and the reason names the protocol rather than saying
 * "needs an adapter", so the next pass knows what it is signing up for.
 */
const BESPOKE_EXECUTORS = {
  huggingchat: 'HuggingChat signs in through HuggingFace OAuth (an unauthenticated GET answers 302 to '
    + '/oauth/authorize, verified 2026-09-22) and then needs a session cookie plus a create-conversation '
    + 'round trip before any message is sent',
  'muse-spark-web': 'Muse Spark is a cookie-authenticated GraphQL endpoint, not a chat-completions API',
  'qwen-web': 'Qwen Chat issues no API key — the bearer its registry entry names is a logged-in browser '
    + 'session token, and the chat endpoint sits behind an Aliyun WAF interstitial (a bodyless POST returns '
    + 'the WAF challenge page rather than an auth error, verified 2026-09-22)',
  't3-web': 't3.chat authenticates with a session cookie and streams its own frame shape',
  antigravity: "Antigravity needs an OAuth device flow and a bespoke request frame (upstream's executor is ~2,000 lines)",
}

/**
 * Rows whose free-access premise does not hold, so this instance declines them outright.
 *
 * The roster's job is to say *which* providers offer free access, and that claim is
 * upstream's rather than ours — occasionally a stale one. A row can be perfectly resolvable,
 * with a clean OpenAI-compatible endpoint and a bearer key, and still not belong here,
 * because that endpoint is only reachable on a prepaid account. Such a row is `refused`
 * rather than `staged`: `staged` records work that is pending, and this is a decision that is
 * finished. Refusing is also what makes the correction survive a re-sync — the row stays in
 * the vendored roster where its provenance lives, and the reason travels with it instead of
 * the provider being quietly deleted from a mirror of somebody else's document.
 */
const NOT_FREE_KEYS = {
  cerebras: 'not free: the roster claims recurring access (30,000,000 tokens/month) — the strongest access '
    + 'classification it has — but Cerebras publishes no free tier at all. Its own FAQ answers "Is there a '
    + 'permanently free tier?" with a flat "No": the only free usage is a $5 credit that expires 30 days after '
    + 'signup, API access stays inactive until a payment method is on the account, and a key without one is '
    + 'answered 402 `payment_required`. Verified live 2026-09-22: both models the key can list return that 402 '
    + 'with `x-should-retry: false` and no rate-limit headers whatsoever. Declined at the operator\'s '
    + 'instruction, 2026-09-22.',
  deepinfra: 'not free: the row\'s only grant is a one-time 1,000,000-token signup credit — its own '
    + '`access` classification is "signup-credit", never the recurring one — and DeepInfra\'s API is '
    + 'pay-as-you-go against prepaid credit, so nothing here recurs. Declined at the operator\'s '
    + 'instruction, 2026-09-22.',
  deepseek: 'not free: the row\'s only grant is a one-time 5,000,000-token signup credit — its own '
    + '`access` classification is "signup-credit", never the recurring one — and DeepSeek\'s platform '
    + 'is prepaid, so nothing here recurs. Declined at the operator\'s instruction, 2026-09-22.',
  'freemodel-dev': 'not free: the row\'s grant is `keyless`, and there is no keyless access. Verified live '
    + '2026-09-22: POST https://api.freemodel.dev/v1/chat/completions with no credential at all returns '
    + 'HTTP 403 {"error":"Unauthorized: No valid credentials provided"}, and the same request with a '
    + 'placeholder bearer returns HTTP 401 {"error":"Unauthorized - Invalid token"} — so every request '
    + 'needs a key on a registered account, and the only free value that account carries is a one-time '
    + 'signup credit rather than a recurring allowance, which is why nothing here recurs. Its '
    + '`/v1/models` does answer with no credential (gpt-5.6-luna / -sol / -terra), and that is exactly '
    + 'the listing KEYLESS_OVERRIDES documents as *not* evidence of keylessness (see the llm7 case); it '
    + 'is the only part of the roster row that was ever checked, which is how a key-gated provider came '
    + 'to be recorded as keyless. The declared models disagree with the live list as well (the roster '
    + 'names gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex, the endpoint serves none of them), so the row is '
    + 'stale on both counts. Declined at the operator\'s instruction, 2026-09-22.',
  opencode: 'not free: the grant is `keyless` access to Zen\'s free-tier ids, and Zen refuses its free '
    + 'tier to every client but its own — HTTP 403 `FreeTierError`, "OpenCode\'s free tier can only be used '
    + 'from within OpenCode". Verified live 2026-09-22 by capturing the official client\'s own request (its '
    + 'configured base URL redirected to a local logger, so the real headers were read rather than guessed) '
    + 'and replaying that request byte-for-byte: the captured `Authorization: Bearer sk-…`, '
    + '`User-Agent: opencode/1.18.25 …` and the `x-opencode-client/project/request/session` headers are '
    + 'refused with that 403, while the same credential in the official client streams a completion. The '
    + 'gate is therefore outside the request — the client\'s transport fingerprint — so nothing this '
    + 'router can send clears it. The row\'s own `tos` flag is `avoid` for the same reason: "Terms '
    + 'restrict use to your own internal use and not on behalf of a third party." Declined at the '
    + 'operator\'s instruction, 2026-09-22.',
  'opencode-zen': 'not free: `permanent` describes a grant that only exists inside OpenCode\'s own '
    + 'client. This is the same Zen endpoint and the same free-tier ids as the `opencode` row, served by '
    + 'one executor, and Zen answers every one of them with HTTP 403 `FreeTierError`, "OpenCode\'s free tier '
    + 'can only be used from within OpenCode". Verified live 2026-09-22: the client\'s own captured '
    + 'request, replayed byte-for-byte with its credential, is refused while the client itself streams a '
    + 'completion, so the gate is outside the request and cannot be emulated from a third-party harness. '
    + 'Zen leaves its model list ungated, which is the only reason these rows appear at all. Declined at '
    + 'the operator\'s instruction, 2026-09-22.',
}

/**
 * Executors whose "protocol" is a client attestation to defeat rather than a format to
 * translate, and which this instance declines to build.
 *
 * Kept apart from `BESPOKE_EXECUTORS` because these are not pending work: the reason below is
 * the decision, and it is used as written rather than composed into "...so it needs a wire
 * adapter". Duck.ai's `x-vqd-hash-1` is the one case — an anti-abuse challenge whose own
 * internals name it "DuckDuckGo Fraud & Abuse", which reads `navigator.webdriver` and the DOM
 * and expects a forged browser fingerprint back. Answering it is impersonation, not a wire
 * adapter, so the row is recorded as declined instead of as a task nobody has got to yet.
 *
 * The activation stays `staged` rather than `refused`, because this instance keeps terms
 * advisory at the operator's request (see `termsRefusal`) and declining a protocol is not the
 * same decision as declining a provider. `NOT_FREE_KEYS` is where the latter lives.
 */
const DECLINED_EXECUTORS = {
  'duckduckgo-web': 'Duck.ai answers `duckchat/v1/chat` only to a client that passes its anti-automation '
    + 'attestation. `x-vqd-hash-1` carries an obfuscated async function (verified live 2026-09-22) that reads '
    + '`navigator.webdriver` and `navigator.userAgent`, builds DOM nodes (`document.createElement`, an '
    + "iframe's `srcdoc`/`contentWindow`) and enumerates `Object.keys(window)` against `window.top`, and "
    + 'expects back hashes plus a `meta` naming duck.ai in a forged Error stack — so answering it means '
    + 'impersonating a real browser to pass an anti-abuse check. Declined rather than pending: there is no '
    + 'legitimate client that talks to this endpoint',
}

/**
 * The first OpenAI-format alternative a provider declares, if any.
 *
 * Several entries are primarily written for another protocol (Anthropic's /v1/messages,
 * Gemini's generateContent) but declare an `alternateFormats` entry for OpenAI clients. That
 * declaration is the provider saying "this URL speaks OpenAI", which is exactly what the
 * generic path needs — no translator, and no guessing at a second hostname.
 */
function pickOpenAiAlternate(entry) {
  const alternates = Array.isArray(entry.alternateFormats) ? entry.alternateFormats : []
  return alternates.find(a => a.format === 'openai' && CHAT_COMPLETIONS_SUFFIX.test(a.baseUrl || '')) || null
}

/**
 * How a provider wants its credential presented.
 *
 * `authHeader` in the upstream registry is a scheme marker rather than a literal header
 * name: `bearer` means the OpenAI convention, and `Authorization` means the bare key with
 * no scheme prefix. Anything else (notably `cookie`) needs session machinery hammer does
 * not have, and is staged rather than guessed at.
 */
/**
 * The optional refusal path, kept explicitly available so the stricter posture is one flag
 * away rather than reimplemented from memory.
 *
 * @returns {{ activation: 'refused', reason: string, resolution: null }|null}
 */
export function termsRefusal({ tos, note }, excludeAvoid) {
  if (tos !== 'avoid' || !excludeAvoid) return null
  return { activation: 'refused', reason: `terms flag "avoid"${note ? `: ${note}` : ''}`, resolution: null }
}

function credentialShapeFor(authHeader) {
  if (authHeader === null || authHeader === undefined || authHeader === 'bearer') {
    return { headerName: 'Authorization', scheme: 'Bearer' }
  }
  // The provider declares it has no credential concept at all (`authHeader: "none"` on
  // Duck.ai). No header is sent, which is a different thing from a header sent empty.
  if (authHeader === 'none') return { headerName: null, scheme: null }
  // A bare credential in the standard header: `Authorization: <key>` with no scheme.
  if (authHeader === 'Authorization') return { headerName: 'Authorization', scheme: null }
  // `cookie` is the real boundary. Session-based providers need the cookie jar, the
  // sign-in flow and the session-refresh machinery hammer only has for gptfree; that is a
  // separate integration, not a header.
  if (authHeader === 'cookie') return null
  // Anything else is a provider-specific header NAME carrying the bare credential —
  // Google's OpenAI-compatible layer takes `x-goog-api-key`, for instance. The descriptor
  // records the header and the request path sends it, which is the entire adapter.
  if (/^[a-z0-9-]+$/i.test(authHeader)) return { headerName: authHeader, scheme: null }
  return null
}

async function fetchText(path, { cache = true } = {}) {
  const cacheFile = new URL(path.replace(/[\\/]/g, '__'), CACHE_DIR)
  if (cache && existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8')
  const response = await fetch(`${RAW}/${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`)
  const text = await response.text()
  if (cache) {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cacheFile, text)
  }
  return text
}

/**
 * Parses one registry entry's TypeScript literal.
 *
 * The entries are machine-generated in a consistent style (`key: "value"` at the top
 * level, models as `{ id, name }` objects), so a targeted scan is more robust here than
 * pulling in a TypeScript parser — and it cannot silently succeed on a shape it does not
 * understand, because a missing field reads as `null`.
 *
 * @param {string} source
 * @returns {object}
 */
export function parseRegistryEntry(source) {
  const text = String(source || '')
  const stringField = name => {
    const match = text.match(new RegExp(`^\\s*${name}:\\s*"([^"]*)"`, 'm'))
    return match ? match[1] : null
  }
  const numberField = name => {
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(\\d[\\d_]*)`, 'm'))
    return match ? Number(match[1].replace(/_/g, '')) : null
  }
  /**
   * `headers: { "Name": "value" }` / `extraHeaders: {...}` — a flat literal of string
   * pairs. Only literal values are read: a call expression ("getSomethingHeaders()") is
   * deliberately skipped rather than guessed at, and the caller sees no header instead of
   * a fabricated one.
   */
  const headerObject = name => {
    const block = text.match(new RegExp(`${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`))
    if (!block) return null
    const out = {}
    for (const pair of block[1].matchAll(/["']?([A-Za-z0-9-]+)["']?:\s*"([^"]*)"/g)) {
      out[pair[1]] = pair[2]
    }
    return Object.keys(out).length > 0 ? out : null
  }

  // `baseUrls` is the multi-region form: an object rather than a string.
  let baseUrl = stringField('baseUrl')
  if (!baseUrl) {
    const block = text.match(/baseUrls:\s*\{([\s\S]*?)\n\s*\}/)
    if (block) {
      const first = block[1].match(/"?(https:\/\/[^"\s]+)"?/)
      if (first) baseUrl = first[1]
    }
  }

  const models = []
  const modelsBlock = text.match(/models:\s*\[([\s\S]*?)\n\s*\],/)
  if (modelsBlock) {
    for (const group of modelsBlock[1].split(/\},\s*\{/)) {
      const id = group.match(/id:\s*"([^"]+)"/)
      if (!id) continue
      const name = group.match(/name:\s*"([^"]+)"/)
      const contextLength = group.match(/contextLength:\s*(\d+)/)
      models.push({
        id: id[1],
        label: name ? name[1] : null,
        contextLength: contextLength ? Number(contextLength[1]) : null,
      })
    }
  }

  /**
   * `alternateFormats: [{ format, baseUrl, authHeader, headers, label }]` — parsed as whole
   * object literals because the fields only mean anything together: swapping protocol swaps
   * URL, auth header and extras at once.
   */
  const alternateFormats = []
  const alternatesBlock = text.match(/alternateFormats:\s*\[([\s\S]*?)\n\s*\],/)
  if (alternatesBlock) {
    for (const group of alternatesBlock[1].split(/\{\s*\n\s*format:/).slice(1)) {
      const block = group.slice(0, group.indexOf('label:'))
      alternateFormats.push({
        format: (block.match(/^\s*"([^"]+)"/) || [])[1] || null,
        baseUrl: (block.match(/baseUrl:\s*"([^"]+)"/) || [])[1] || null,
        authHeader: (block.match(/authHeader:\s*"([^"]+)"/) || [])[1] || null,
      })
    }
  }

  return {
    id: stringField('id'),
    alias: stringField('alias'),
    format: stringField('format'),
    executor: stringField('executor'),
    usesOpenAiCompatibleHelper: text.includes(OPENAI_HELPER_MARKER),
    baseUrl,
    modelsUrl: stringField('modelsUrl'),
    authType: stringField('authType'),
    authHeader: stringField('authHeader'),
    authPrefix: stringField('authPrefix'),
    modelIdPrefix: stringField('modelIdPrefix'),
    chatPath: stringField('chatPath'),
    urlSuffix: stringField('urlSuffix'),
    anonymousApiKey: stringField('anonymousApiKey'),
    timeoutMs: numberField('timeoutMs'),
    defaultContextLength: numberField('defaultContextLength'),
    forceStream: /\bforceStream:\s*true\b/.test(text),
    requiresPlainStringContent: /\brequiresPlainStringContent:\s*true\b/.test(text),
    alternateFormats,
    models,
  }
}

/** Extracts every `./registry/<slug>/index.ts` path the registry assembles. */
export function parseRegistryIndex(source) {
  const slugs = new Set()
  const pattern = /from\s+"\.\/registry\/([^"]+)\/index\.ts"/g
  let match
  while ((match = pattern.exec(String(source || '')))) slugs.add(match[1])
  return [...slugs]
}

/**
 * Turns a roster entry plus a parsed registry entry into a resolution.
 *
 * @returns {{ activation: 'active'|'refused'|'staged', reason: string|null, resolution: object|null }}
 */
export function decideResolution({ key, access, tos, note, entry }) {
  // First, before even the missing-entry branch: whether a provider is free has nothing to
  // do with how clean its endpoint is, so a fetch failure upstream must not be able to
  // downgrade this refusal into a different reason. The reason here is the decision.
  const notFree = NOT_FREE_KEYS[key]
  if (notFree) return { activation: 'refused', reason: notFree, resolution: null }

  // Terms are recorded but no longer gate activation. OmniRoute treats its own ToS flag as
  // advisory — by their design it "is not a routing gate" and flagged providers stay in
  // routing — and the operator of this instance has confirmed they accept that posture for
  // personal use. Refusing by default would have withheld twelve providers that upstream
  // routes to. The flag still travels on every descriptor, so nothing is hidden; pass
  // --exclude-avoid to restore the stricter behaviour.
  if (!entry) {
    return {
      activation: 'staged',
      reason: key === 'arcee-ai'
        // The roster's note says the free grant arrives through OpenRouter's ":free" layer, but that
        // layer does not currently serve an Arcee row either: OpenRouter lists exactly one Arcee id
        // (`arcee-ai/trinity-large-thinking`) and it is not a `:free` variant, while Arcee's own host
        // is key-only (`GET https://api.arcee.ai/v1/models` -> 401). Checked live 2026-09-22, so the
        // row records that there is nothing free to point at rather than a duplicate of another row.
        ? 'no free endpoint on either side: Arcee\'s own API is key-only (GET https://api.arcee.ai/v1/models '
          + '-> 401) and OpenRouter currently lists no ":free" Arcee variant, verified 2026-09-22'
        : 'no matching entry in OmniRoute\'s provider registry',
      resolution: null,
    }
  }

  // Checked before the bespoke-executor branch: a declined protocol gets its own reason rather
  // than one composed with "so it needs a wire adapter", which would read as pending work.
  const declined = DECLINED_EXECUTORS[entry.executor]
  if (declined) return { activation: 'staged', reason: declined, resolution: null }

  // Profiles are keyed by *executor*, not by roster row: rows that share an executor share
  // its differences, so one profile serves them all.
  const profile = EXECUTOR_PROFILES[entry.executor] || EXECUTOR_PROFILES[key] || null
  // An override replaces a wire format we would otherwise have to translate; a provider's
  // own declared OpenAI alternative does the same, but from the provider rather than from us.
  const override = OPENAI_COMPATIBLE_OVERRIDES[key] || null
  const alternate = pickOpenAiAlternate(entry)

  // A named executor is checked before the base URL, because "its executor is bespoke" is the
  // more useful reason when both apply — a spread constant (`baseUrls: [...SOMEWHERE]`) reads
  // as "no base URL" to a text scan, which would mislabel a bespoke provider as a missing one.
  const bespoke = BESPOKE_EXECUTORS[entry.executor]
  if (entry.executor && entry.executor !== 'default' && !profile && !alternate) {
    return {
      activation: 'staged',
      reason: bespoke
        ? `${bespoke}, so it needs a wire adapter`
        : `executor "${entry.executor}" frames its own request and response with no declarative equivalent`,
      resolution: null,
    }
  }

  if (!entry.baseUrl && !alternate && !profile?.chatUrlTemplate) {
    return { activation: 'staged', reason: 'no base URL published for this provider upstream', resolution: null }
  }

  // Format: a URL template, an override, an OpenAI alternate, an explicit declaration, or
  // OmniRoute's own OpenAI-compatible builder.
  const openAiCompatible = Boolean(profile?.chatUrlTemplate)
    || Boolean(override)
    || Boolean(alternate)
    || GENERIC_OPENAI_FORMATS.has(entry.format)
    || entry.usesOpenAiCompatibleHelper
  if (!openAiCompatible) {
    const described = entry.format ? `wire format "${entry.format}"` : 'wire format'
    return {
      activation: 'staged',
      reason: `${described} is not OpenAI-compatible, so it needs a translator`,
      resolution: null,
    }
  }

  // The endpoint must actually be a chat-completions endpoint, not merely declared openai.
  let chatUrl = profile?.chatUrlTemplate || override?.chatUrl || alternate?.baseUrl || entry.baseUrl
  if (!CHAT_COMPLETIONS_SUFFIX.test(chatUrl) && profile?.chatUrlSuffix) {
    chatUrl = `${String(chatUrl).replace(/\/+$/, '')}${profile.chatUrlSuffix}`
  }
  if (!CHAT_COMPLETIONS_SUFFIX.test(chatUrl)) {
    return {
      activation: 'staged',
      reason: `base URL "${chatUrl}" is not a chat-completions endpoint`,
      resolution: null,
    }
  }

  // `optional` and `none` both mean the provider answers without a credential — `optional`
  // because a key is accepted and lifts limits, `none` because there is no credential
  // concept at all. Anything else names an account sign-in flow, which is a different
  // integration from a key on a header.
  const authType = entry.authType ?? 'apikey'
  if (authType !== 'apikey' && authType !== 'optional' && authType !== 'none') {
    return {
      activation: 'staged',
      reason: `authType "${authType}" needs an account sign-in flow, not a static key`,
      resolution: null,
    }
  }

  // An alternate format can swap the auth header along with the URL, so it wins when present.
  const authHeader = alternate?.authHeader ?? entry.authHeader ?? null
  const credentialShape = credentialShapeFor(authHeader)
  if (!credentialShape) {
    return {
      activation: 'staged',
      reason: `authHeader "${authHeader}" needs session or cookie machinery hammer does not have`,
      resolution: null,
    }
  }

  // `optional`/`none` is the provider's own declaration that no key is required. An
  // override can add to that, but only with completion-level evidence (KEYLESS_OVERRIDES).
  const keyless = (authType === 'optional' || authType === 'none' || Boolean(KEYLESS_OVERRIDES[key]))
    && !REQUIRES_KEY_EVIDENCE[key]

  // A declared prefix (`authPrefix: "Bearer"`) is the provider telling us the scheme; absent
  // one, the OpenAI convention applies to `Authorization` and a bare value to everything else.
  const scheme = entry.authPrefix || credentialShape.scheme

  // Anything a provider needs beyond a key it must say so, or the first request fails with a
  // URL that has a literal `{accountId}` in it. Naming the fields here is what turns that
  // into a configuration prompt instead of a mystery 404.
  const credentialFields = [
    ...(profile?.credentialFields || []),
  ]

  /**
   * Request shaping: every difference between this provider and a bare OpenAI endpoint that
   * can be expressed as data. The runtime reads these by name (see `lib/providers/adapters.js`),
   * so a provider that needs one of them needs no code.
   */
  const shaping = {
    ...(entry.headers || profile?.headers
      ? { headers: { ...(entry.headers || {}), ...(profile?.headers || {}) } }
      : {}),
    ...(entry.requestDefaults || profile?.requestDefaults
      ? { requestDefaults: { ...(entry.requestDefaults || {}), ...(profile?.requestDefaults || {}) } }
      : {}),
    ...(profile?.jsonMode ? { jsonMode: true } : {}),
    ...(profile?.premiumModels ? { premiumModels: profile.premiumModels } : {}),
    ...(profile?.flattenTextContent || entry.requiresPlainStringContent ? { flattenTextContent: true } : {}),
    ...(entry.modelIdPrefix ? { modelIdPrefix: entry.modelIdPrefix } : {}),
    ...(profile?.chatUrlTemplate ? { urlTemplate: true } : {}),
    ...(credentialFields.length > 0 ? { credentialFields } : {}),
    ...(profile?.timeoutMs || entry.timeoutMs ? { timeoutMs: profile?.timeoutMs || entry.timeoutMs } : {}),
  }

  return {
    activation: 'active',
    reason: null,
    resolution: {
      chatUrl,
      // A profile's own list URL wins over the entry's, for the providers whose catalog is
      // served somewhere other than the sibling of their chat path (Cloudflare).
      modelsUrl: profile?.modelsUrl || entry.modelsUrl || null,
      auth: {
        kind: keyless ? 'none' : (profile?.credentialKind || 'bearer'),
        // No key needed, and a key is accepted when present.
        ...(keyless ? { optional: true } : {}),
        ...credentialShape,
        scheme,
      },
      ...(Object.keys(shaping).length > 0 ? { shaping } : {}),
      provenance: {
        ...(override ? { endpointOverride: override.why } : {}),
        ...(alternate ? { alternateFormatUsed: alternate.label || alternate.format } : {}),
        ...(KEYLESS_OVERRIDES[key] ? { keylessEvidence: KEYLESS_OVERRIDES[key] } : {}),
        ...(REQUIRES_KEY_EVIDENCE[key] ? { requiresKeyEvidence: REQUIRES_KEY_EVIDENCE[key] } : {}),
        ...(entry.executor !== 'default' && profile ? { executor: entry.executor } : {}),
        // Recorded as provenance, not used for routing: discovery supplies the live list.
        modelCount: entry.models.length,
        declaredModels: entry.models.slice(0, 40).map(m => m.id),
      },
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const excludeAvoid = args.includes('--exclude-avoid')
  const onlyIndex = args.indexOf('--provider')
  const only = onlyIndex === -1 ? null : new Set((args[onlyIndex + 1] || '').split(',').map(s => s.trim()))

  const catalog = JSON.parse(readFileSync(new URL('../lib/providers/omniroute-catalog.json', import.meta.url), 'utf8'))
  const roster = (catalog.providers || []).filter(p => !only || only.has(p.key))

  console.log(`fetching ${INDEX_PATH} …`)
  const indexSource = await fetchText(INDEX_PATH)
  const slugs = parseRegistryIndex(indexSource)
  console.log(`registry assembles ${slugs.length} provider entries`)

  const slugByKey = new Map(slugs.map(slug => [slug, slug]))
  const resolutions = {}
  const report = { active: [], refused: [], staged: [] }
  let fetched = 0

  for (const row of roster) {
    const slug = SLUG_OVERRIDES[row.key] || slugByKey.get(row.key) || null

    // Terms are advisory by default (see decideResolution); --exclude-avoid restores the
    // stricter posture without needing the rule to live in two places.
    const refusal = termsRefusal(row, excludeAvoid)
    if (refusal) {
      resolutions[row.key] = { activation: refusal.activation, reason: refusal.reason }
      report.refused.push(row.key)
      console.log(`  ⊘ ${row.key.padEnd(20)} refused — ${refusal.reason}`)
      continue
    }

    let entry = null
    if (slug) {
      try {
        const source = await fetchText(`${REGISTRY_PREFIX}registry/${slug}/index.ts`)
        fetched += 1
        entry = parseRegistryEntry(source)
      } catch (error) {
        entry = null
        report.staged.push(`${row.key} (fetch failed: ${error.message})`)
      }
    }

    const { activation, reason, resolution } = decideResolution({
      key: row.key,
      access: row.access,
      tos: row.tos,
      note: row.note,
      entry,
    })

    if (activation === 'active') {
      resolutions[row.key] = { activation, ...resolution }
      report.active.push(row.key)
      console.log(`  ✔ ${row.key.padEnd(20)} active — ${resolution.chatUrl}`)
    } else {
      resolutions[row.key] = { activation, reason }
      // A refusal is its own bucket: it used to be reachable only from the terms branch
      // above, so this branch assumed anything non-active was staged and would have
      // reported a declined provider as pending work.
      if (activation === 'refused') {
        report.refused.push(row.key)
        console.log(`  ⊘ ${row.key.padEnd(20)} refused — ${reason}`)
      } else {
        report.staged.push(row.key)
        console.log(`  · ${row.key.padEnd(20)} staged — ${reason}`)
      }
    }
  }

  const output = {
    _source: {
      project: 'OmniRoute',
      license: 'MIT',
      repo: `https://github.com/${REPO}`,
      ref: REF,
      input: INDEX_PATH,
      registryPrefix: REGISTRY_PREFIX,
      generatedAt: new Date().toISOString(),
      attribution:
        'Per-provider endpoints, wire formats and auth shapes extracted from OmniRoute\'s provider registry (MIT). Only entries that ride a generic OpenAI-compatible + bearer path are activated; everything else is recorded as staged with its reason rather than guessed at.',
      activationRule:
        'active = an OpenAI-compatible wire format AND a credential hammer can send (static, optional, or none) AND a chat-completions endpoint. An executor only blocks a provider when nothing about it is declarative — a profile, a URL template, or the provider\'s own declared OpenAI alternate format all count. Model lists are NOT resolved here: discovery is lazy, so /v1/models supplies them on first use.',
      tosPolicy:
        excludeAvoid
          ? 'exclude-avoid: providers whose upstream terms flag is "avoid" are refused and given no endpoint.'
          : 'Terms flags are advisory, matching OmniRoute, which does not gate routing on them. The flag travels on every descriptor so it stays visible; pass --exclude-avoid to withhold flagged providers instead.',
    },
    summary: {
      active: report.active.length,
      refused: report.refused.length,
      staged: report.staged.length,
      registryEntriesRead: fetched,
    },
    providers: resolutions,
  }

  console.log(`\nactive ${report.active.length} · refused ${report.refused.length} · staged ${report.staged.length}`)

  if (checkOnly) {
    console.log('--check: nothing written')
    return
  }

  mkdirSync(dirname(RESOLVED_PATH.pathname), { recursive: true })
  writeFileSync(RESOLVED_PATH, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`✔ wrote ${RESOLVED_PATH.pathname}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`✖ ${error.message}`)
    process.exit(1)
  })
}
