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
bin/hammer.js          CLI entry (still one file)
lib/server.js          composition root: runServer wires discovery, config,
                       the express app, and the remaining 27 routes
lib/http/routes/       one module per resource; thin handlers only
lib/http/context.js    the context contract shared by composer and modules
lib/pi/                the Pi coding agent: child process, JSONL RPC, replay log
lib/providers/         descriptors, catalog, discovery, resolution
lib/config.js          config read/write (single writer for the file)
sources.js, scores.js  model data (to move under lib/data/)
public/                dashboard, classic script, no build step
```

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
| `http/routes/pi.js`            | 5      | the Pi console: status, SSE event stream, prompt, stop, new session                                   |

Every group has tests that mount it on a bare Express app with stub
dependencies — no listener on 7352, no config file, no network
(`test/http-routes.test.js`, `test/oauth-routes.test.js`, `test/pi-agent.test.js`). The streaming path is
additionally covered end to end against a fake upstream: a real server boots
from a clean `HOME`, registers an endpoint, restarts, discovers the model, and
serves a non-streamed and a streamed completion plus a 404 for an unknown model.

## The Pi console, and why it is shaped differently

`lib/http/routes/pi.js` is the only group that owns an operating-system
process, so it is also the only one that takes no router state. The direction is
one way:

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
