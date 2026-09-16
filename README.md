# 🚀 hammer

[![npm version](https://img.shields.io/npm/v/hammer?color=green&style=flat-square)](https://npmjs.com/package/hammer)
[![GitHub stars](https://img.shields.io/github/stars/Dvarkian/hammer?style=flat-square)](https://github.com/Dvarkian/hammer/stargazers)
[![Join Discord](https://img.shields.io/badge/Join_Discord-5865F2?style=flat-square&logo=discord)](https://discord.gg/AqX6Sawq5w)

[**Join our Discord**](https://discord.gg/AqX6Sawq5w) for discussions, feature requests, and community support.

<div align="center">
  <img src="docs/assets/dashboard.png" alt="Hammer Dashboard" width="100%">
  <br/>
  <p><i>The smartest, fastest, and completely free local router for your AI coding needs.</i></p>
</div>

---

### 🔥 100% Free • Auto-Routing • 80+ Models • 12+ Providers • OpenAI-Compatible

**hammer** is an OpenAI-compatible local router that benchmarks free coding models across top providers and automatically forwards your requests to the best available model. 

### ✨ Why use hammer?

- 💸 **Completely Free:** Stop paying for API usage. We seamlessly provide access to robust free models.
- 🧠 **State-of-the-Art (SOTA) Models:** Out-of-the-box availability for top-tier models including **Kimi K2.5, Minimax M2.5, GLM 5, Deepseek V3.2**, and more.
- 🏢 **Reliable Providers:** We route requests securely through trusted, high-performance platforms like **NVIDIA, Groq, OpenRouter, OpenCode Zen, Ollama, Kiro, Google, GitHub Copilot, and OpenAI Codex**.
- ⚡ **Lightning Fast:** The built-in benchmark continually evaluates metrics to pick the fastest and most capable LLM for your request.
- 🔄 **OpenAI-Compatible:** A perfect drop-in replacement that works seamlessly with your existing tools, scripts, and workflows.

## 🚀 Run from source

```bash
node bin/hammer.js

# Start it
hammer
```

Once started, hammer is accessible at `http://localhost:7352/`.

Router endpoint:

- Base URL: `http://127.0.0.1:7352/v1`
- API key: any string
- Model: `best` (router picks actual backend)

## 🔌 Installing Integrations

Use `hammer onboard` to save provider keys and auto-configure integrations for OpenClaw or OpenCode.

```bash
hammer onboard
```

If you prefer manual setup, use the examples below.

## OpenCode Integration

`hammer onboard` can auto-configure OpenCode.

If you want manual setup, put this in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "hammer",
      "options": {
        "baseURL": "http://127.0.0.1:7352/v1",
        "apiKey": "dummy-key"
      },
      "models": {
        "best": {
          "name": "Best"
        }
      }
    }
  },
  "model": "router/best"
}
```

## OpenClaw Integration

`hammer onboard` can auto-configure OpenClaw.

If you want manual setup, merge this into `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "hammer": {
        "baseUrl": "http://127.0.0.1:7352/v1",
        "api": "openai-completions",
        "apiKey": "no-key",
        "models": [
          { "id": "best", "name": "Best" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "hammer/best"
      },
      "models": {
        "hammer/best": {}
      }
    }
  }
}
```

## CLI

```bash
hammer [--port <number>] [--host <address>] [--log] [--verbose] [--ban <model1,model2>]
hammer onboard [--port <number>]
hammer install --autostart
hammer start --autostart
hammer uninstall --autostart
hammer status --autostart
hammer update
hammer autoupdate [--enable|--disable|--status] [--interval <hours>]
hammer autostart [--install|--start|--uninstall|--status]
hammer config export
hammer config import <token>
```

Request terminal logging is disabled by default. Use `--log` to enable it. Startup waits for model discovery and probes before binding the web UI; use `--verbose` (or `HAMMER_DEBUG_STARTUP=1`) for detailed diagnostics.

## Security

By default hammer binds to **loopback only** (`127.0.0.1`), so the dashboard and the `/v1` proxy are reachable only from the machine running it. The dashboard API and proxy also reject cross-origin browser requests (protecting against malicious websites fetching `http://localhost:7352`) and unexpected `Host` headers (DNS-rebinding protection).

To expose the router on your LAN, opt in explicitly:

```bash
hammer --host 0.0.0.0
# or
HAMMER_HOST=0.0.0.0 hammer
```

LAN mode prints an **access token** at startup. The dashboard prompts for it once (stored in your browser); non-browser clients (curl, OpenCode on another machine) must send it as `Authorization: Bearer <token>`. Loopback clients never need the token.

### Request logging

Request bodies and streamed responses are captured in-memory and persisted to `~/.hammer-logs.json` by default, because they may contain sensitive prompts. You can limit this from **Settings → Request Logging** in the Web UI, or via env vars:

```bash
HAMMER_LOG_CONTENT=0      # store roles only, never prompt/response bodies
HAMMER_PERSIST_LOGS=0     # keep logs in memory only, never write to disk
```

`hammer install --autostart` also triggers an immediate start attempt so you do not need a separate command after install.

During `hammer onboard`, you will also be prompted to enable auto-start on login.

`hammer update` upgrades the global npm package and, when autostart is configured, stops the background service first and starts it again after the update.

Auto-update is enabled by default. While the router is running, hammer checks npm periodically (default: every 24 hours) and applies updates automatically.

Use `hammer autoupdate --status` to inspect state, `hammer autoupdate --disable` to turn it off, and `hammer autoupdate --enable --interval 12` to re-enable with a custom interval.

Use `hammer config export` to print a transferable config token (base64url-encoded JSON), and `hammer config import <token>` to load it on another machine.
You can also import by stdin:

```bash
hammer config export | hammer config import
```

## Endpoints

### `/v1/chat/completions`

`POST /v1/chat/completions` is an OpenAI-compatible chat completions endpoint.

- Use `model: "best"` to route to the highest-intelligence working model
- Use a grouped model ID such as `minimax-m2.5`, `kimi-k2.5`, or `glm4.7` to route within that model group
- For grouped IDs, hammer selects the provider with the best current QoS for that group
- Append `+min_ctx:<size>` to `best` to additionally require a minimum context window, e.g. `best+min_ctx:128k`. `<size>` accepts a raw token count or a `k`/`m` suffix. Models whose context window can't be determined, or is smaller than the requirement, are excluded. See [Minimum context window](#minimum-context-window-min_ctx).
- In the Web UI, pinned models can now use either `Canonical Group` mode (default, pins the same model across providers) or `Exact Provider Row` mode from `Settings`
- Streaming and non-streaming requests are both supported

### `/v1/models`

`GET /v1/models` returns the models exposed by the router.

- Model IDs are grouped slugs such as `minimax-m2.5`, `kimi-k2.5`, and `glm4.7`
- Each grouped ID can represent the same model across multiple providers
- When you select one of these IDs in `/v1/chat/completions`, hammer routes the request to the provider with the best current QoS for that model group
- `best` is also exposed and routes to the highest-intelligence working model

Example:

```json
{
  "object": "list",
  "data": [
    { "id": "best", "object": "model", "owned_by": "router" },
    { "id": "minimax-m2.5", "object": "model", "owned_by":"Hammer" },
    { "id": "kimi-k2.5", "object": "model", "owned_by":"Hammer" },
    { "id": "glm4.7", "object": "model", "owned_by":"Hammer" }
  ]
}
```

### Minimum context window (`min_ctx`)

Naming a model doesn't guarantee it can fit your prompt — the same model group can span providers with very different context windows. Append `+min_ctx:<size>` to `best` to filter those out before the normal ranking runs:

- `best+min_ctx:1m` — highest-intelligence working model with at least 1,000,000 tokens of context
- `best+min_ctx:32000` — same, with a minimum of 32,000 tokens

`<size>` accepts a plain token count (`32000`) or a `k`/`m` suffix (`32k`, `1m`). Models with no known context window, or a smaller one than requested, are excluded from consideration. An unparseable or unrecognized modifier is ignored, falling back to the unmodified `best` behavior rather than erroring.

Hammer uses context data reported by the selected provider when it is available. Otherwise, it uses a provider-specific curated value from `sources.js`. It does not copy a context size between providers. It also keeps the context unknown when neither source has a value. For Ollama, the allocated or configured context is usable for this filter. The model maximum alone is not sufficient.

### Learned context bounds

Besides the two sources above, hammer learns bounds from real requests: a successful request raises a lower bound, and a rejection that is genuinely about context lowers an upper bound. Only a provider-stated ceiling may become an *exact* bound, and only an exact bound may override the catalog or mark a row `Micro` in the dashboard. Throughput quotas ("…on output tokens per minute (OTPM): Limit 1000, Requested 1413") and output-token caps ("`max_tokens` must be less than or equal to `8192`") are refused: they describe this request's budget, not the model's window. A bound inferred from the size of a failed prompt is shown as a range (`>22, <1649`) and never benches a row.

Every bound keeps the error body it was read from, and is re-checked against the current rules on startup, so a parser fix withdraws the numbers an older build wrote. To withdraw one by hand, use **🧹 Clear learned context** in a model's drawer, `hammer context reset [--provider <key>] [--model <id>]`, or `POST /api/context-bounds/reset` with `{providerKey, modelId}`.

### Learned output caps

An output-token cap is refused as a context window, but it is not ignored: it is a fact about the model that the router needs to serve it at all. Groq answers "`max_tokens` must be less than or equal to `16384`, the maximum value for `max_tokens` is less than the `context_window` for this model" to every request above that ceiling, so the cap is learned per provider/model row and the **same** model is asked again with a legal budget instead of failing over — the row then serves instead of quietly handing every turn to another provider. The cap is stored with its error body, re-checked against the current rules on startup exactly like a context bound, and only ever applied downwards: a request already inside the ceiling is sent untouched, a model with no stated cap keeps the caller's full budget, and automated tests learn the ceiling too so a row tested before it is proxied starts out legal.

### Routing selection

The `best` selector considers only provider/model rows currently marked `up` and orders them by the **Artificial Analysis Intelligence Index** — AA's own rating, or the one derived where AA has no rating for a model: interpolated from its Elo (LMArena, or Design Arena for catalog entries), or, when there is no Elo either, calibrated from the curated offline score against the models that carry both. Every derived index is marked `*` in the dashboard. Rows with none of those fall back to the local intelligence score. Quota and rate-limit failures advance to the next highest model.

Grouped-ID routing retains its normal QoS behavior. For those routes, the QoS score blends model quality, uptime, and recently observed latency. The latency target defaults to 3000ms and can be tuned per deployment via the `qosLatencyTargetMs` key in `~/.hammer.json`.

## Config

- Router config file: `~/.hammer.json`
- API key env overrides:
  - `NVIDIA_API_KEY`
  - `GROQ_API_KEY`
  - `CEREBRAS_API_KEY`
  - `SAMBANOVA_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENCODE_API_KEY`
- `OLLAMA_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
  - `CODESTRAL_API_KEY`
  - `HYPERBOLIC_API_KEY`
  - `SCALEWAY_API_KEY`
  - `KIRO_REFRESH_TOKEN`
  - `KIRO_OAUTH_CLIENT_ID` (optional, for AWS Builder/IDC refresh flow)
  - `KIRO_OAUTH_CLIENT_SECRET` (optional, for AWS Builder/IDC refresh flow)
  - `GOOGLE_API_KEY`
  - `GITHUB_COPILOT_TOKEN` (GitHub OAuth token from the Copilot device flow; the dashboard sign-in normally writes this for you)
  - `OPENAI_CODEX_REFRESH_TOKEN` (ChatGPT OAuth refresh token; the dashboard sign-in normally writes this for you)
  - `G4F_API_KEY` (optional — the g4f relays are keyless)
  - `G4F_BASE_URL` (optional — point the hosted g4f pool at a self-hosted server)

Kiro OAuth notes:
- Base endpoint is preconfigured to `https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
- Current Kiro model IDs include `claude-sonnet-4.5` and `claude-haiku-4.5`
- Authentication uses OAuth access tokens refreshed from:
  - `KIRO_REFRESH_TOKEN`, or
  - `~/.aws/sso/cache` (auto-detected refresh token), following OmniRoute’s approach.

For hosted Ollama, set `OLLAMA_API_KEY` and optionally override `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.
If you leave the Ollama base URL blank in the UI, hammer defaults to `https://ollama.com/v1`.
With a valid Ollama API key, hammer will discover available Ollama models automatically.
If you point Ollama at a local host such as `http://127.0.0.1:11434`, hammer will also auto-discover models and does not require an API key.

### gpt4free (g4f)

hammer can route through [gpt4free](https://g4f.dev)'s gateway at `https://g4f.space/v1`, which fronts many models. g4f gates anonymous traffic behind proof-of-work credits, so it **requires a free account key**:

1. Get one at [g4f.dev/members.html](https://g4f.dev/members.html).
2. Set `G4F_API_KEY=<key>`, or add `"g4f": "<key>"` to `apiKeys` in `~/.hammer.json`.

Until a key is set, the provider appears under **Require setup** in the dashboard.

- Models are discovered automatically from `https://g4f.space/v1/models` (non-chat models such as whisper/TTS/image are filtered out); a curated fallback catalog is used before the first successful discovery.
- Without a key every g4f request answers HTTP `402` with `insufficient_credits`.
- To point hammer at a self-hosted g4f server instead, set `G4F_BASE_URL` (e.g. `http://localhost:1337/v1`) or a `baseUrl` on the `g4f` provider in `~/.hammer.json`.

### GitHub Copilot

GitHub Copilot is available as a provider, so a Copilot (including free) plan can back the router instead of an API key. Copilot has no static API keys — it authenticates with a GitHub OAuth token obtained from the device flow:

1. Open the Web UI, go to **Settings → GitHub Copilot**, and click **Sign in with GitHub**.
2. Approve the code on `github.com/login/device`.
3. Hammer stores the resulting GitHub token in `~/.hammer.json` and routes Copilot's models (discovered from the account's own `/models` list) through `https://api.githubcopilot.com`.

Details that matter:

- The device flow uses a minimal `read:user` consent. The token is long-lived, so there is no periodic refresh.
- Prefer a headless setup? Set `GITHUB_COPILOT_TOKEN`, or paste a GitHub token into the provider's key field — both are used exactly like a signed-in token.
- Business/Enterprise plans answer on their own API host; Hammer discovers and remembers it at sign-in. GitHub Enterprise Server accounts can point the provider at their instance with a `baseUrl` on `providers["github-copilot"]`.
- Usage is billed against the account's Copilot plan rather than per token. The dashboard's Quota column reads the plan's remaining premium requests.
- Hammer sends `X-Initiator: agent` for automated agent turns (a trailing tool/assistant turn) and `X-Initiator: user` for user-driven chat, the same distinction the Copilot CLI makes; only user-initiated turns draw down premium requests.
- Chat requests default to the `copilot-chat` client identity because some Business organizations gate the CLI surface, and are retried once as the `copilot-developer-cli` identity when a plan denies chat instead.
- Models a plan gates behind a policy (Claude, Grok, the GPT-5 coding family) are enabled automatically whenever a token is configured — sign-in, `GITHUB_COPILOT_TOKEN`, or a pasted token.

### OpenAI Codex

OpenAI Codex lets a ChatGPT plan back the router instead of an API key. It is the one provider that is *not* OpenAI-compatible: calls go to the Responses API on the ChatGPT backend, authenticated with a short-lived ChatGPT access token plus the workspace id header, and always stream SSE. Hammer translates both directions, so clients keep speaking `/v1/chat/completions`.

1. Open the Web UI, go to **Settings → OpenAI Codex**, and click **Sign in with ChatGPT**.
2. Approve the code on `auth.openai.com/codex/device`.
3. Hammer stores the resulting OAuth refresh token in `~/.hammer.json`, exchanges it for access tokens on demand, and lists the models the account's own `/codex/models` reports.

Details that matter:

- Only the refresh token is stored; access tokens are minted per request and cached until shortly before they expire. Hammer never sees the account password.
- Prefer a headless setup? Set `OPENAI_CODEX_REFRESH_TOKEN`, or paste a refresh token into the provider's key field. Multiple refresh tokens are supported as an account pool.
- Requests are translated: system/developer turns become `instructions`, tool calls and tool results become the Responses `function_call` / `function_call_output` items, and sampling controls (`temperature`, `top_p`, `max_tokens`, …) are dropped because the backend rejects them. Streaming clients get chat.completion chunks; non-streaming clients get one assembled body.
- The model list is account-scoped, so rows a plan may not serve are hidden rather than offered and then refused. Before sign-in, a small curated list keeps the provider visible.
- Usage counts against the ChatGPT plan's rolling windows rather than token billing. The dashboard's Quota column reads the account usage endpoint.
- A per-account `baseUrl` on `providers["openai-codex"]` points the provider at another backend root (or a full `/codex/responses` URL) when needed.

### OpenAI-Compatible endpoints

hammer supports configuring multiple OpenAI-compatible upstream endpoints (vLLM, llama.cpp, custom relays, etc.). Each endpoint exposes a single model id and is routed independently.

- In the Web UI, click `+ Add Endpoint` under the **OpenAI-Compatible endpoints** group, supply a name, base URL, model id, and optional API key. Each endpoint then gets its own provider row with status, ping, and rate-limit information.
- hammer automatically probes `/v1/models` on each endpoint and exposes every returned model as a routable row. The manually configured model id (if any) is merged in as a fallback. Discovery is on by default and can be toggled per-endpoint with the **"Discover models from `/v1/models`"** checkbox.
- Endpoints are stored in `~/.hammer.json` under composite keys like `openai-compatible:my-vllm`:
  ```jsonc
  {
    "apiKeys": {
      "openai-compatible:my-vllm": "sk-…",
      "openai-compatible:groq-clone": "sk-…"
    },
    "providers": {
      "openai-compatible:my-vllm":    { "enabled": true, "name": "Local vLLM", "baseUrl": "http://localhost:8000/v1", "modelId": "qwen-coder" },
      "openai-compatible:groq-clone": { "enabled": true, "name": "Groq Clone", "baseUrl": "https://example/v1",        "modelId": "llama-3.3-70b" }
    }
  }
  ```
- Legacy single-endpoint configs (a bare `openai-compatible` entry without an instance suffix) are migrated automatically to `openai-compatible:default` on first run.
- The legacy env vars `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_MODEL` continue to work and apply to the `:default` instance.
- Endpoints can also be managed via the API: `POST /api/openai-compatible/endpoints` (body: `{name, baseUrl, modelId, apiKey?}`) and `DELETE /api/openai-compatible/endpoints/<id>`.

### Config migration (CLI + Web UI)

- In the Web UI, open `Settings` -> `Configuration Transfer` to export/copy/import a token.
- The token includes your full config (including API keys, provider toggles, pinning mode, bans, filter rules, and auto-update settings).
- Treat tokens as secrets. Anyone with the token can import your keys/settings.
- Alternative: copy the config file directly from `~/.hammer.json` to the other machine at the same path (`~/.hammer.json`).

## Troubleshooting

---

⭐️ If you find hammer useful, please consider [starring the repo](https://github.com/Dvarkian/hammer)!
