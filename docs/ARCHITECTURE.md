# Architecture

Hammer is being dismantled in place: behaviour stays, structure moves outward
from what was one 12,790-line file. This records the arrangement that exists
today — including the parts of it that are transitional — so the next cut
extends it instead of inventing a second one.

## The rule

**Functional core, imperative shell.** Pure functions own decisions; handlers
parse a request, call something, and serialise the answer. No handler reaches
across the app for state it could be handed.

## Layering, as it stands

```
desktop/               Electron shell: one window, and the router started in-process
                       from lib/server.js (see “The desktop shell” below)
bin/hammer.js          CLI entry (still one file)
lib/server.js          composition root: runServer wires discovery, config,
                       the express app, and the remaining 27 routes
lib/http/routes/       one module per resource; thin handlers only
lib/http/context.js    the context contract shared by composer and modules
lib/pi/                the Pi coding agent: settings, runtime resolution, child
                       process, JSONL RPC, replay log, supervision
lib/providers/         descriptors, catalog, discovery, resolution
lib/config.js          config read/write (single writer for the file)
sources.js  model data (to move under lib/data/)
public/                dashboard, classic script, no build step
```

## The desktop shell

`desktop/` is an outer layer, not a second application. `desktop/main.js` imports the same
`runServer` the CLI does, starts it on loopback in the Electron main process, and points one
window at `http://127.0.0.1:<port>/` — so the dashboard in the app and the dashboard in a browser
are the same files, and `/v1` keeps answering for coding tools while the window is open. The shell
owns only what a window needs: the splash shown during discovery, the tray, the menu, and a
size-capped log at `~/.hammer-desktop.log` (a packaged app has no terminal). Decisions that do not
need Electron — argument parsing, the readiness probe, the port check — live in
`desktop/runtime.js` and are tested without a display.

`runServer` is **5,283 lines** and registers **27** routes; on `master` it was
7,080 and 38, and at the start of the refactor 7,485 and 58. `lib/server.js` is
10,611 lines, down from 12,790. Extracted modules hold 31 routes between them.

## The route contract

Every extracted route group is a `register*Routes(app, ctx)` function. Two
rules make the modules safe to mount alone:

1. **A route module never imports `server.js`.** Anything it needs from the
   router — an engine, a cache-clear callback, the ping trigger — arrives in
   `ctx`. This keeps the dependency direction one-way and avoids an import
   cycle.
2. **State moves with its only owner.** A store used solely by one group lives
   in that group's module, not as a module-level global in `server.js`. The
   device-flow maps for Copilot, Codex and Kiro moved this way; Kiro's social
   flow map stayed behind because `server.js` still owns that engine.

## The context (`ctx`), and why it is shaped this way

`ctx` is built once, inside `runServer`, next to the bindings it exposes, and
handed to every `register*Routes`. It has two kinds of field:

| Kind                     | Example                                                     | Because                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable reference         | `rankModelsForRouting`, `providerHealth`, `scheduleLogSave` | Function identity and Map identity never change, so a module may destructure them at registration time.                                                                                                                |
| Mutable state, accessors | `ctx.results`, `ctx.usageStats`, `ctx.pinnedSelection`      | These are still `let` bindings in the composer, which reassigns them. A destructured copy would go stale and the dashboard would render a model table the router had already replaced. Read and write them as `ctx.x`. |

The accessor pairs are a **transitional** shape, not the destination. They exist
only because the state is owned by `let` bindings. Once state moves into a
`Runtime` object the composer mutates instead of reassigning, the getters and
setters disappear and every module can hold `runtime.state` safely.

`ctx` is typed `Record<string, any>`, so `tsc` cannot catch a misspelt
dependency: it becomes a runtime `TypeError` on the first request. That is a
known cost of the current seam, paid because a 60-field typedef would document a
bag rather than shrink it. `readConfig()` / `readProvider()` are one-line
widening reads in the two modules that touch config keys the shared JSDoc does
not enumerate; the real fix is to describe those keys, then delete the casts.

## Extracted so far

| Module                         | Routes | Also owns                                                                                             |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| `http/routes/oauth-copilot.js` | 3      | Copilot device-flow store                                                                             |
| `http/routes/oauth-codex.js`   | 3      | Codex device-flow store                                                                               |
| `http/routes/oauth-kiro.js`    | 5      | Kiro Builder ID device-flow store                                                                     |
| `http/routes/oauth-devin.js`   | 4      | the session-token persister callback                                                                  |
| `http/routes/proxy.js`         | 4      | `/v1/chat/completions` (streaming and not), `/v1/models`, `/v1/messages`, `/v1/messages/count_tokens` |
| `http/routes/models.js`        | 1      | `/api/models` — the table, QoS map, selector pick                                                     |
| `http/routes/providers.js`     | 6      | `/api/config`, endpoint CRUD, refresh/discovery                                                       |
| `http/routes/pi.js`            | 7      | the Pi console: status, SSE event stream, prompt, stop, new session, restart, allowlisted RPC command |

Every group has tests that mount it on a bare Express app with stub
dependencies — no listener on 7352, no config file, no network
(`test/http-routes.test.js`, `test/oauth-routes.test.js`, `test/pi-agent.test.js`). The streaming path is
additionally covered end to end against a fake upstream: a real server boots
from a clean `HOME`, registers an endpoint, restarts, discovers the model, and
serves a non-streamed and a streamed completion plus a 404 for an unknown model.

## The Pi console, and why it is shaped differently

`lib/http/routes/pi.js` is the only group that owns an operating-system
process, so it is also the only one that takes nothing but its own address. The
direction is one way:

```
browser tab ──SSE──▶ /api/pi/events ──▶ PiBridge ──stdin JSONL──▶ pi --mode rpc
            ◀──SSE─── event records  ◀──  (child)  ◀──stdout JSONL──
            ──POST──▶ prompt / abort / reset ──▶ commands ──▶
```

Three decisions follow from that, and each one is a defect if undone:

1. **The child is the conversation.** The page holds a projection of the event
   log and nothing else; no transcript is stored in the browser. A reload
   re-subscribes and the bridge replays its bounded log, so a run in progress
   survives a refresh. The log is capped by count and by characters, because
   `agent_end` carries the whole conversation.
2. **The bridge, not the UI, owns protocol policy.** Steer when a run is active
   (and retry as a steer when Pi disagrees with tracked state), `clear_queue`
   then `abort_retry` then `abort` for Stop, `cancelled` honoured for a new
   session. The page cannot know these rules and must not re-derive them.
3. **Nothing starts the agent until the tab is opened.** A status request is
   the only thing that spawns it, and the dashboard makes none until the Pi tab
   is selected — a router nobody is watching the console on pays for no child.
4. **The agent's model is the router's.** The child runs on a Pi agent
   directory Hammer owns (`~/.hammer/pi/agent/<port>`, written by
   `lib/pi/agent-dir.js`) whose only provider is this router's `/v1` and whose
   only model is `best`. Every LLM call the agent makes is therefore routed by
   Hammer at the moment it is made: a pin, a slope change or a fallback moves
   the agent's model with it. Naming a concrete model there would snapshot the
   selection and, one dashboard change later, be the old model.

   That directory is also why the console ignores the user's own Pi providers
   and extensions: this instance is Hammer's, `~/.pi/agent` is never read or
   written, and deleting the directory resets the console to a plain Pi.

### The harness around it

Three modules sit between the routes and the child, each with one job, so the
route module never contains a launch decision:

| Module           | Owns                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi/settings.js` | the optional `pi` block in `~/.hammer.json` (command, node, provider, model, thinking, extraArgs, brain, workspace, sessions), normalised once, with environment overrides for the launch and path fields |
| `pi/runtime.js`  | finding a Pi that will actually run, and turning settings into one spawn: command, args, cwd, env                                                                                                         |
| `pi/bridge.js`   | the process, the protocol, the phase, usage accounting, the replay log, restart policy                                                                                                                    |

The runtime resolver exists for one failure: the `pi` on PATH is a shim whose
shebang resolves to whatever `node` is first, and Pi needs Node ≥ 22. A
resolver that skips the shim and finds an interpreter beside it turns "the
agent is broken" into a note on the status card. `pi.node` / `pi.command` pin it
in `~/.hammer.json`; `HAMMER_PI_COMMAND`, `HAMMER_PI_NODE`,
`HAMMER_PI_WORKSPACE`, `HAMMER_PI_SESSIONS`, `HAMMER_PI_BRAIN` and
`HAMMER_PI_AGENT_DIR` do the same from outside, for a container or a test.

Supervision is deliberately conservative, because a restart loop is worse than
a dead agent: a child that exits on its own is respawned with exponential
backoff, at most six consecutive times, and the budget resets after a completed
turn (proof the install works). The old child is detached before a deliberate
restart or disposal, so its exit is not mistaken for a crash — the replacement
already owns the phase. Phases are `idle`, `starting`, `alive`, `busy`, `dead`,
`stopped` and `error`, and the page draws its pill straight from them rather
than inferring liveness from event traffic.

Usage is counted from `message_end` (not `turn_end`, which repeats the same
message), and broadcast as its own frame; the page therefore shows tokens and
cost without polling. A plan that cannot produce a configuration — a provider
that cannot be written, a Pi with no usable Node — sets `launchError`, and the
agent is refused (503 on prompt) rather than silently started on Pi's own model.

### The transcript, as the page builds it

The console renders what the agent does, not just what it says, and it takes
the event vocabulary whole from the harness rather than inventing a summary:

- **One assistant message is several blocks.** Pi restarts `contentIndex` at 0
  for every assistant message and grows it in production order, so the page
  keeps blocks keyed by that index and sorts them. Thinking, answer text and a
  repeated thinking block stay in the order the model made them instead of
  being merged into one paragraph — collapsing thinking to a placeholder is
  what made the first port look incomplete.
- **A tool is announced when it is called.** `toolcall_start`/`toolcall_end`
  create the box (with its arguments) where the call was made;
  `tool_execution_start/update/end` then fill the same box with live output and
  a verdict, so a long `bash` call is legible while it runs.
- **Notices are first class.** Compaction, provider retries, extension errors
  and a `message_end` that carries a failure each become a line, because silence
  during a 30-second retry reads as a hung agent.
- **Output is clipped, not trusted.** Text is capped at 120k characters and tool
  output at 24k, cut from the front: the tail is what a reader needs, and
  `agent_end` carries the whole conversation.

Thinking only appears when there is something to show it: the router's `best`
model is configured with `reasoning: true` and `compat.supportsReasoningEffort`,
so `pi.thinking` (or the allowlisted `set_thinking_level` command) produces real
`thinking_delta` records instead of a level Pi would silently clamp to off. The
start-up level is still `off`, so no model spends reasoning tokens until asked.

The bridge is driven in tests by `test/support/fake-pi.mjs`, which speaks the
same protocol and can be told to crash on a command or refuse a new session.

## Structural debt this record names

1. **The hot path is one 1,606-line handler.** Moving it out of `runServer`
   made the composer smaller but did not decompose it: `registerProxyRoutes`
   holds resolve → attempt loop → dispatch → stream/respond inline. Relocation
   is not decomposition, and this is the clearest remaining example. The next
   shape is stages: resolve the requested model set, run the attempt loop
   (pick, dispatch, classify), then respond. Each stage becomes testable without
   an HTTP request, and the per-provider branches (Kiro, Devin, Codex, GPTFree,
   Copilot) collapse into the adapter interface instead of sitting in the middle
   of the loop.
2. **`ctx` is a 60-field dependency bag.** `proxy.js` destructures 60 names,
   `models.js` 12, `providers.js` 11. Any module can reach anything. The
   contraction is state ownership: a `Runtime` whose state is mutated in place
   (deleting the accessors), then per-concern bundles — routing, providers,
   telemetry — so a module asks for three collaborators rather than sixty.
3. **Tests read source text.** There are **147** `assert.match(… server …)`
   style assertions. They are the reason `lib/server.js` is exempt from
   Prettier: formatting it would break the suite. They broke three times during
   this migration on semicolons alone. Each area should be converted to a
   behavioural test against the mounting harness — the guarantee is usually
   cheaper to assert on a response than on a line of code — and only then should
   `server.js` be formatted and the exception in `eslint.config.js` removed.
4. **`lib/utils.js` is a 106-export grab-bag over 3,952 lines**, and
   `public/dashboard.js` is still one 9,457-line classic script with no module
   boundary.

## Follow-on work this record anticipates

- `lib/core/` for selection, ranking and classification, with `fetch`/`clock`/
  `fs` injected, replacing the remaining module-level mutable bindings with one
  `Runtime` object created at the composition root.
- `lib/utils.js` split by domain.
- Dashboard as ES modules, which also removes the inline `onclick` handlers
  behind the `no-unused-vars` exception in `eslint.config.js`.
