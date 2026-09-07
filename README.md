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
- 🏢 **Reliable Providers:** We route requests securely through trusted, high-performance platforms like **NVIDIA, Groq, OpenRouter, OpenCode Zen, Ollama, Kiro, and Google**.
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
- Model: `smartest` (router picks actual backend)

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
        "smartest": {
          "name": "Smartest"
        }
      }
    }
  },
  "model": "router/smartest"
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
          { "id": "smartest", "name": "Smartest" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "hammer/smartest"
      },
      "models": {
        "hammer/smartest": {}
      }
    }
  }
}
```

## CLI

```bash
hammer [--port <number>] [--host <address>] [--log] [--ban <model1,model2>]
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

Request terminal logging is disabled by default. Use `--log` to enable it.

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

- Use `model: "smartest"` to route to the highest-Elo working model
- Use a grouped model ID such as `minimax-m2.5`, `kimi-k2.5`, or `glm4.7` to route within that model group
- For grouped IDs, hammer selects the provider with the best current QoS for that group
- Use `model: "tag:<name>"` (e.g. `tag:coding`) to route to the best currently available model carrying that tag — either a curated capability tag or a custom tag you've assigned in the Web UI (see [Model tags](#model-tags)). This is useful because the free models behind hammer come and go as availability changes — routing by tag survives a given model disappearing, where routing by a specific model/group ID does not.
- Append `+min_ctx:<size>` to `tag:<name>` or `smartest` to additionally require a minimum context window, e.g. `tag:general+min_ctx:32000` or `smartest+min_ctx:128k`. `<size>` accepts a raw token count or a `k`/`m` suffix. Models whose context window can't be determined, or is smaller than the requirement, are excluded. See [Model tags](#model-tags).
- In the Web UI, pinned models can now use either `Canonical Group` mode (default, pins the same model across providers) or `Exact Provider Row` mode from `Settings`
- Streaming and non-streaming requests are both supported

### `/v1/models`

`GET /v1/models` returns the models exposed by the router.

- Model IDs are grouped slugs such as `minimax-m2.5`, `kimi-k2.5`, and `glm4.7`
- Each grouped ID can represent the same model across multiple providers
- When you select one of these IDs in `/v1/chat/completions`, hammer routes the request to the provider with the best current QoS for that model group
- `smartest` is also exposed and routes to the highest-Elo working model
- Each entry includes a `tags` array combining curated capability tags with any user-defined tags (see [Model tags](#model-tags))

Example:

```json
{
  "object": "list",
  "data": [
    { "id": "smartest", "object": "model", "owned_by": "router" },
    { "id": "minimax-m2.5", "object": "model", "owned_by":"Hammer", "tags": ["agentic", "general", "coding"] },
    { "id": "kimi-k2.5", "object": "model", "owned_by":"Hammer", "tags": ["agentic", "coding", "general"] },
    { "id": "glm4.7", "object": "model", "owned_by":"Hammer", "tags": ["agentic", "coding", "general"] }
  ]
}
```

### Model tags

Every model carries one or more capability tags, combined from two sources:

- **Curated tags** come from a fixed vocabulary — `coding`, `reasoning`, `general`, `fast`, `agentic` — maintained by project maintainers in `tags.js`.
- **Custom tags** are freeform labels you assign yourself. In the Web UI, open a model row and edit **Custom Routing Tags**. Assignments are keyed to the canonical model, shared across its providers, and stored in `~/.hammer.json`.

Use `model: "tag:<name>"` in `/v1/chat/completions` to route to the best currently available model carrying that tag — curated or custom — instead of naming a specific model. For example, assign `coding` to a few models in the UI, then request `model: "tag:coding"`; normal QoS ranking, availability filtering, and retry behavior choose the best currently eligible tagged model.

#### Minimum context window (`min_ctx`)

Tag membership alone doesn't guarantee a model can fit your prompt — a tag can span models with very different context windows. Append `+min_ctx:<size>` to filter those out before the tag route's normal QoS ranking runs:

- `tag:general+min_ctx:32000` — best available `general`-tagged model with at least 32,000 tokens of context
- `tag:coding+min_ctx:128k` — same, for `coding`, using the `k` shorthand
- `smartest+min_ctx:1m` — highest-Elo working model with at least 1,000,000 tokens of context, no tag restriction

`<size>` accepts a plain token count (`32000`) or a `k`/`m` suffix (`32k`, `1m`). Models with no known context window, or a smaller one than requested, are excluded from consideration. An unparseable or unrecognized modifier is ignored, falling back to the unmodified `tag:<name>` or `smartest` behavior rather than erroring.

Hammer uses context data reported by the selected provider when it is available. Otherwise, it uses a provider-specific curated value from `sources.js`. It does not copy a context size between providers. It also keeps the context unknown when neither source has a value. For Ollama, the allocated or configured context is usable for this filter. The model maximum alone is not sufficient.

### Routing selection

The `smartest` selector considers only provider/model rows currently marked `up`, orders them by verified Elo, and falls back to the local intelligence score when no Elo is available. Quota and rate-limit failures advance to the next highest-Elo working model.

Grouped-ID and `tag:<name>` routing retain their normal QoS behavior. For those routes, the QoS score blends model quality, uptime, and recently observed latency. The latency target is configurable in the Web UI under **Settings → QoS Latency Target (ms)** (default: 3000ms).

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
