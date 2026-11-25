# Subagents in Hammer — research and design plan

Status: research and design only. No implementation has started.
Date: 2026-11-14.
Scope: a first generation of subagents for the Pi console: delegation, model choice,
permissions, fallback, reporting, steering, point-to-point transcript reads and messaging,
plus UI. Parallel agent teams, shared task boards, broadcast/mailbox, a dedicated advisor
runtime and its severity layer are explicitly future work.

The short version: **do not adopt `pi-subagents`; build a small Hammer-owned subagent
runtime and a thin Pi extension that calls it.** That is the only shape that lets the
parent choose from Hammer's own model catalogue, lets the router own fallback, keeps tool
grants and model policy server-side, and reuses the console/SSE machinery already in the
harness for the UI.

---

## 1. Research: how other harnesses implement subagents

### 1.1 Claude Code

A subagent is a markdown file with YAML frontmatter plus a system-prompt body. Required
fields are `name` and `description`; optional fields include `tools`, `disallowedTools`,
`model`, `permissionMode`, `maxTurns`, `background`, `memory`, `skills`, `mcpServers`,
`hooks`, `isolation` and `effort`. The `description` is what the main model matches
against when deciding whether to delegate. Definitions can live in managed settings,
`.claude/agents/`, `~/.claude/agents/`, a plugin, or be passed with `--agents`
([docs](https://code.claude.com/docs/en/sub-agents)).

The parent invokes a subagent through the `Agent` tool (formerly `Task`). The model can
pass a per-invocation model alias, a `name`, `run_in_background`, and a prompt. Model
resolution order is:

1. the per-invocation model parameter (an alias, not a full ID),
2. the definition's `model` field (including `inherit`),
3. `CLAUDE_CODE_SUBAGENT_MODEL`,
4. the parent conversation's model.

The parent sees **only the final result**, not the child's tool calls or intermediate
output. Foreground subagents block the conversation and route permission prompts to the
user. Background subagents run concurrently, get a smaller built-in tool set, and surface
permission prompts in the main session naming the asking subagent. Background subagents
are the default for main-conversation spawns
([tool reference](https://code.claude.com/docs/en/tools-reference)).

Other details worth knowing:

- **Resume:** every invocation creates an agent ID. `SendMessage` to that ID or name
  resumes it with full history. A `name` makes a subagent addressable, and `SendMessage`
  is also the mechanism for mid-flight course corrections. Sibling named agents receive a
  roster that makes them valid `to` values.
- **Depth:** a subagent can spawn its own only if `Agent` is in its `tools`, and a depth
  limit applies. Nested agents inherit the spawning subagent's model by default.
- **Failures:** if a rate limit or server error cuts off a foreground subagent that
  already produced text, the parent gets the partial output plus a note that the
  subagent did not finish. A subagent that produced nothing fails with an API error.
  Fallback model chains can move a subagent to another model mid-run, and the report
  opens with a warning naming the switch.
- **Teams:** with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, named agents become
  teammates. They share a task list (`pending` / `in progress` / `completed`, with
  dependencies and self-claim) and a file-based mailbox under
  `~/.claude/teams/{team}/inboxes/`. The lead is fixed, teammates cannot spawn
  teammates, and the docs list real limitations around resumption, task-status lag and
  shutdown ([agent teams](https://code.claude.com/docs/en/agent-teams)).

### 1.2 opencode

An opencode agent is a system prompt + permission rules + optional model and sampling
settings. `mode` is `primary`, `subagent`, or `all`; a custom agent defaults to `primary`
in v2, so a subagent file must say `mode: subagent`. Model is per agent; a child inherits
the parent's model only when the agent does not name one
([agents](https://opencode.ai/docs/agents), [v2 agents](https://opencode.ai/v2/docs/agents.md)).

The `task` tool input is `description`, `prompt`, `subagent_type`, optional `task_id`
(resume the same child session), and optional `background`. Results come back wrapped in
XML:

```xml
<task id="ses_..." state="completed">
  <task_result>…</task_result>
</task>
```

Important mechanics from the source
([task.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts)):

- Depth defaults to **1**; a child cannot spawn unless its permission rules explicitly
  allow `task`.
- Child permissions are derived from the parent by carrying **denies and external
  directory rules**, not the parent's allows. The child otherwise uses its own configured
  permissions. A child with no `todowrite` or `task` grant gets those denied by default.
- Background completion is injected into the parent as a **synthetic user message**
  containing the `<task>` wrapper. The model is told not to poll or duplicate the work.
- Foreground cancellation aborts the child session.
- The tool description teaches the parent when to delegate: complex multi-step tasks
  only, not a single read/grep; launch independent agents concurrently; do not duplicate
  delegated work; write a detailed brief and state exactly what to return
  ([task.txt](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/task.txt)).

### 1.3 Pi and its extension ecosystem

Pi has **no built-in subagents**. It has an extension API powerful enough to build them:
`pi.registerTool()` with `execute(toolCallId, params, signal, onUpdate, ctx)`, event
interception (`tool_call`, `tool_execution_*`, `session_*`), custom commands, and
per-agent settings ([extensions](https://pi.dev/docs/latest/extensions)).

An extension is a TypeScript module that runs inside the Pi process. It can register
tools, intercept and block tool calls, inject context, subscribe to lifecycle events, and
render custom UI in the TUI. It is discovered from `<agent-dir>/extensions/` (the
`~/.pi/agent` directory is relocated by `PI_CODING_AGENT_DIR`), project `.pi/extensions/`,
or a `settings.json` `extensions` array. Pi's CLI also provides `--tools` / `--exclude-tools`
and `--no-tools`, and `settings.json` has `defaultTools`
([CLI](https://pi.dev/docs/latest/cli), [settings](https://pi.dev/docs/latest/settings),
[configuration](https://pi.dev/docs/latest/configuration)).

The shipped example (`examples/extensions/subagent`) spawns a **separate `pi` process per
child**, with markdown agent definitions (`name`, `description`, `tools`, `model`) and
three modes: single, parallel (max 8, 4 concurrent), and chain with a `{previous}`
placeholder. It streams child progress, caps model-visible output at 50 KB per task,
reports per-task usage, and propagates Ctrl+C
([README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)).

`pi-subagents` (nicobailon) is the mature ecosystem package. It is worth studying even
though Hammer should not adopt it:

- Async by default. Foreground children run as sessions inside the parent Pi process;
  background children run in a detached runner process.
- One `subagent` tool with actions for `status`, `steer`, `resume`, `stop`, `interrupt`,
  `list`, `models`, `create`/`update`/`delete`, and workflow operations.
- Status supports transcript views, fleet views and nested run ids; steering supports
  `steer` / `follow_up` / `auto` and reports delivery receipts.
- Worktree isolation, artifacts, acceptance gates, per-agent memory, a FleetView and an
  inspector.
- A configurable spawn budget (default 64 per run tree), concurrency limits and a
  recursion guard.
- It ships built-in roles (`scout`, `planner`, `reviewer`, `worker`, `oracle`, `advisor`,
  …) and a model registry that is Pi's own.

See the [README](https://github.com/nicobailon/pi-subagents) and
[tool reference](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/tool-reference.md).

Why it is the wrong centre of gravity for Hammer:

- **Model registry mismatch.** Hammer's console deliberately exposes one alias, `best`.
  Letting the parent pick any Hammer model through `pi-subagents` would require declaring
  every model as a Pi model, and the router's fallback policy would sit outside the
  package.
- **Its runner and UI live outside Hammer's architecture.** Background children would not
  go through the keeper that lets a router restart survive, and the web harness would see
  an opaque tool result rather than a child transcript.
- **Built-in roles** are exactly what Hammer wants to avoid. The parent should define the
  name, prompt and instruction.
- The 10 MB package and its config surface are more than a first implementation needs.

Worth copying from it: the action vocabulary, a bounded `status` with transcript tail,
`steer`/`resume` semantics, the “running in background — do not poll” receipt, per-child
agent directories, and the idea of artifacts for long outputs.

### 1.4 oh-my-pi's advisor

The advisor is a **separate reviewer model attached to a session**, not a subagent that
owns work. It receives only the **new transcript delta** since its last update (including
reasoning, tool intent and results), can investigate with its own read-only tools
(`read`, `grep`, `glob`), and injects notes through one `advise` tool with severities:

- `nit` — a non-interrupting aside, delivered at the next turn boundary.
- `concern` — delivered when the primary yields; wakes it if it stopped mid-work.
- `blocker` — can interrupt work in progress and can wake a finished turn.

It never approves actions or mutates the primary session, and it runs in an isolated tool
session. The built-in prompt tells the advisor to stay quiet
([docs](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md)).

This is a useful future pattern, but it is a specialist runtime: delta rendering, delivery
gates, cooldowns and an isolated tool session. It should not be hardcoded into the first
subagent implementation, and it is not a reason to add a fixed “advisor” role.

### 1.5 Cross-cutting patterns

| Dimension   | Claude Code                          | opencode                                 | pi-subagents             | Hammer proposal                                      |
| ----------- | ------------------------------------ | ---------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Interface   | `Agent` tool                         | `task` tool                              | `subagent` action tool   | `subagent` action tool                               |
| Context     | fresh; optional fork                 | fresh child session; resume by `task_id` | fresh or fork            | fresh; a message restarts it on its session          |
| Model       | per-call > definition > env > parent | agent's model, else parent's             | agent/call, Pi registry  | Hammer catalogue key or tier; no `inherit`           |
| Permissions | allow/deny lists; prompts bubble     | per-agent rules; inherits denies         | per-agent tools; depth   | tools + transcript/message grants, clamped to parent |
| Result      | final summary only                   | XML `<task_result>`                      | streamed + artifacts     | final report + usage + fallback trace                |
| Background  | default; notification                | opt-in; synthetic message                | default async            | opt-in; foreground with wait-then-background         |
| Control     | `SendMessage`, `TaskStop`            | abort, `task_id` resume                  | status/steer/resume/stop | status/wait/transcript/send/stop/delete              |
| UI          | agent panel, `/tasks`                | TUI session switch                       | FleetView/inspector      | sidebar tree + child console view                    |

The common shape: **a tool call is the entire interface; the parent writes a brief, not a
transcript; the child gets its own context; the result is a summary; control is a small
set of verbs.**

### 1.6 What to copy, and what not to

Copy:

- Fresh context per child; the default parent view is the final report.
- A tool result with structured metadata (state, model, usage, fallback).
- Background receipts that explicitly say “do not poll”.
- A cheap status plus a separate, bounded transcript action.
- Steer/queue, with a message to a finished child restarting it.
- Tool allowlists per child, with depth and concurrency caps.
- A UI list of running agents and a way to open one.

Do not copy:

- A fixed library of roles.
- A model registry separate from Hammer's.
- An external runner outside the keeper/bridge supervision.
- A TUI-only inspector.
- Silent model degradation.

---

## 2. Hammer's existing foundations

This is unusually good leverage; the subagent feature should be an extension of these
parts, not a parallel system.

### 2.1 The Pi console and bridge

`lib/pi/bridge.js` owns a Pi child over JSONL RPC: command correlation, phase, usage
accounting, a bounded replay log, restart policy, mid-turn compaction, auto-continue after
transport failures, and queued-message persistence. `lib/pi/supervisor.js` runs a detached
keeper that owns the child's pipes, so the router can restart, be repackaged and be
relaunched while a turn is running. The replacement router attaches to the keeper's socket
and adopts the same process.

`lib/http/routes/pi.js` adapts one bridge to one console: status, SSE, prompt, stop, new
session, restart, compaction, queue edits, session switching. A conversation outlives the
process because Pi writes JSONL sessions, and the route module can resume one.

### 2.2 Parallel consoles and one SSE stream

`/api/pi/instances` already opens a second child beside the main console, on its own
session file, with its own bridge and subscribers. Each instance has a console key
(`${port}-${id}`) used for slope state and status. The page-wide stream
`/api/pi/consoles/events` carries every console over one connection; the harness keeps a
`console` object per id and switches the transcript/composer between them. A subagent is
structurally another console with a parent, which is why the UI can be nearly free. Each
parent bridge is registered with the manager under its console key and its environment
carries a parent token naming that key, so a spawn records the conversation that actually
asked for the child instead of inheriting the main conversation. The rail groups root
children by `parent.sessionFile`; when a console is still on its first turn and has no file
yet, the manager backfills that field from the console's first status report rather than
guessing from whichever row is open.

### 2.3 A private Pi agent directory and the `best` alias

`lib/pi/agent-dir.js` writes a private agent directory whose only provider is this
router's `/v1` and whose only model is `best`. Every LLM call the agent makes is routed by
Hammer at the moment it is made: a pin, a slope change, a fallback or a provider bench
moves the agent's model with it. The model carries an `X-Hammer-Pi-Console` header naming
the console, which the proxy already reads for slope selection
(`lib/http/routes/proxy.js`).

This is the key mechanism for subagents: give each child its own agent directory with a
unique header (`sub-<id>`), and the router can resolve that child's model pool on every
request without restarting the child.

### 2.4 The model plane and selection machinery

The router already knows, per row:

- `aa` — Artificial Analysis Intelligence Index (0–100), with `intell` as the local
  fallback and `isEstimatedScore`/`qualitySource`;
- `intelBand` — the band tag for `aa` (`Genius` … `Very Dumb`), computed server-side by
  `intelligenceBandForAa` so the catalogue and the dashboard cannot disagree;
- composite speed via `computeRowSpeed` — `500 / (ttft/1000 + 500/tps)`, so it reflects
  both latency and throughput;
- `verdict` — the dashboard's effective-speed band (`Very Fast` … `Very Slow`), computed
  from TTFT and throughput together when both are measured, and from latency alone only
  when no rate is available; the tooltip prints the composite rate beside both figures;
- `knownQuota`, `quotaWindows`, `rateLimit`, `providerUsage`, `recordedUsage`,
  `isRateLimited`;
- `toolSupport`, `contextTokens`, `status`, `routingEligible`, `providerBenched`,
  `providerOutage`, `qos` and `uptime`.

`buildModelGroups` groups rows into model families with ids, labels, aliases and member
rows. `selectModelBySlope` is the geometric model picker on the intelligence/speed plane;
`isFallbackSelectionActive` and the proxy's attempt loop already record and display
fallbacks.

On this install at the time of research: **1,624 rows, 176 up and routing-eligible, 100
model groups**. Using composite speed, the non-dominated frontier is only **six groups**:

| Model               |   AA | intelligence tag | composite speed | speed tag |  TTFT |
| ------------------- | ---: | ---------------- | --------------: | --------- | ----: |
| Gemini 4 Hydrogen   | 51.0 | Very Smart       |           5 u/s | Very Slow |  7.1s |
| Ling 3.1 Flash      | 41.1 | Smart            |          37 u/s | Normal    |  5.9s |
| SWE-2 Flash Medium  | 37.9 | Smart            |          68 u/s | Fast      |  3.2s |
| Auto                | 34.3 | Smart            |         101 u/s | Very Fast |  1.1s |
| GLM 5.3 Flash       | 27.8 | Average          |         143 u/s | Very Fast |  1.1s |
| North Mini Code 1.0 |  9.9 | Very Dumb        |         203 u/s | Very Fast | 0.53s |

That table is the argument for a curated frontier: 100 groups is too much to paste into
every spawn decision, but six to ten lines is exactly the trade-off the parent needs.
The dashboard's **Speed tag now bands the same composite rate** — TTFT and throughput
weighed together over a 500-token answer — and its tooltip prints the effective tok/s beside
TTFT and generation tok/s. The catalogue must carry both band tags, not just the numbers:
`Very Smart` / `Smart` / … for intelligence and `Very Fast` / … for speed, each with the
composite rate and TTFT behind it. The speed cutoffs are **100 / 50 / 25 / 10 effective
tok/s**; intelligence uses the existing **55 / 45 / 33.9 / 20 / 12 AA** bands. Route
counts are deliberately absent: route allowances differ by orders of magnitude, so how
many routes a group has says nothing about whether it will still answer; the usage band is
the capacity signal.

### 2.5 The harness UI

`public/harness.js` keeps a `consoles` map, one per conversation, and `activate()` points
the transcript/composer at one of them. `renderSessions()` builds the Sessions rail from
the server's session list plus any open console. Subagent snapshots carry a revision, and
the SSE stream sends one with its opening `hello`, so a reconnect cannot overwrite a
newer spawn with a slower list response or miss children created while the page was away. The transcript renders Pi events
including tool calls, thinking, notices and usage. `public/index.html` has the sidebar,
composer (with steer/follow-up buttons), details rail and the agent/router view switch.
Both `dashboard.css` and `harness.css` are loaded, so the dashboard's tag styles are
available to the agent view.

### 2.6 Gaps

There is no server-side usage-band summary (the five-band logic lives in
`public/dashboard.js`), no nearest-model selector, no per-child agent directory or tool
allowlist, no subagent registry, no `subagent` tool, and no UI grouping for child
conversations. Those are the pieces to build.

---

## 3. Design

### 3.1 Architecture

```
parent Pi child
  │  tool call: subagent({ action, ... })
  ▼
Hammer Pi extension (thin HTTP client, per-console token)
  │  POST /api/subagents
  ▼
Router
  ├─ SubagentRegistry: records, limits, model policy, budgets
  ├─ per-child agent dir: models.json header `sub-<id>`, tools, append-system prompt
  ├─ PiBridge child + keeper + session file
  └─ console stream ──► harness (sidebar row, child transcript, tool card)
        │
        └─ proxy: header `sub-<id>` → ordered model pool → existing attempt/fallback loop
```

A subagent is **a real Pi child**, not an in-process pseudo-agent. That buys context
isolation, crash containment, independent tools and model, and reuses the bridge, keeper,
session store and console stream. The cost is process startup and memory; at four
concurrent children that is acceptable. If startup latency hurts later, foreground
children can move in-process like `pi-subagents`, without changing the API.

The extension is the only clean way to add a tool without forking Pi. It must be
**materialised out of the asar** into the agent directory, the same way the supervisor
script already is — a packaged Pi cannot read a `.ts` inside `app.asar`.

### 3.2 Alternatives considered

| Option                                                     | Verdict                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Hammer runtime + thin Pi extension** (chosen)         | Full control of model pool, fallback, permissions, UI, persistence and supervision; reuses bridges/keepers/consoles. More server code and a materialised extension.                                    |
| **B. Adopt `pi-subagents`**                                | Mature async/steer/resume/worktree, but its model registry is Pi's, its runner and FleetView sit outside Hammer, its built-in roles conflict with “no hardcoded roles”, and the web UI would be blind. |
| **C. Use parallel Hammer consoles as subagents, no tool**  | Nearly free UI and streams, but the parent cannot invoke or coordinate them. That is parallel chat, not delegation.                                                                                    |
| **D. Let the parent call an HTTP endpoint through `bash`** | No extension file, but the model must write curl commands, gets no structured progress, and the whole thing is unsecurable. Rejected.                                                                  |
| **E. Fork or patch Pi core**                               | Too heavy for the benefit; the extension API is sufficient.                                                                                                                                            |

### 3.3 Lifecycle

**Spawn.** The parent calls `subagent` with a name, brief, model, tools and optional
background. The router validates depth, concurrency, grants and budget, creates the
child agent directory, starts the bridge through a keeper, sends the brief, and returns a
receipt.

**Foreground (default).** The tool waits for completion, polling `GET
/api/subagents/:id` once a second and streaming a compact progress card through
`onUpdate`. If the child outlives `wait_ms` (default 10 minutes), the tool **promotes it
to background** and returns a running receipt, so the parent is never stuck. This is the
equivalent of Claude's Ctrl+B without requiring the user to press it.

**Background.** Returns immediately with “working in the background; do not poll”. On
completion the router injects a `<subagent-result>` message into the parent: a follow-up
if the parent is busy, a new turn if it is idle, and a persisted pending notice if the
parent process is gone. `notify` can be `auto`, `queue`, or `silent`; the UI always shows
a card.

**Status.** One cheap call returning phase, elapsed, current tool with its own elapsed,
`quietMs`, tokens/context, queue length, requested vs selected model **keys** and fallback
history; the UI resolves labels for display. It never carries transcript or report text.
This is how the parent checks a possibly-stalled child without waiting on it.

**Transcript.** `transcript` returns a bounded tail (default 8k chars). The parent can call
it for any descendant; a child with the `transcripts` grant can call it for any same-root
agent, including its parent, siblings and their branches. The target is resolved from the
registry and checked against the caller's root. The same authority gate covers a child's
final report. `status` stays cheap and carries no text.

**Wait.** `wait_ms` blocks until terminal or timeout, then returns running status.

**Send.** To a live child: `steer` injects now, `queue` waits for the next turn boundary.
There is no second queued-mode spelling. A parent sending to a finished child restarts it
on its session and delivers only that message; the stored task is not replayed first. One
verb, with an optional `mode`. The same action is how a permissioned child messages its
parent, a sibling or another same-root agent. The root chooser is addressable as `parent`;
otherwise targets are ids, with names unique per root. A message addressed to `parent` is
always delivered as a steer, even when the caller asks for `queue`: it must reach a running
parent turn rather than wait behind it. A message to a target that finishes before delivery
fails with `delivery_failed`; it never resumes it.

**Stop.** Abort the child, mark stopped, return partial output.

**Delete.** Stop a live child, remove its registry record and emit the updated tree. The
child's private agent directory and its files under `sessions/subagents` are removed;
nothing outside those two owned locations is touched. Sending a message to a finished
child is the resume path, so there is no separate public resume action.

### 3.4 Identity, persistence and restart

Suggested record shape (persisted as `subagents.json`, atomic and bounded, like
`lib/pi/queue-store.js`):

```json
{
  "id": "sa_3f9c2a10",
  "name": "schema-audit",
  "rootId": "<parent session file>",
  "parentId": null,
  "taskId": null,
  "parent": {
    "consoleKey": "7352",
    "sessionFile": "…jsonl",
    "toolCallId": "call_…"
  },
  "task": "…the brief…",
  "instructions": "…optional role instructions…",
  "tools": ["read", "grep", "find", "ls"],
  "depth": 1,
  "model": {
    "requested": "ling-3.1-flash",
    "groupId": "ling-3.1-flash",
    "rowKey": "requesty::novita/ling-3.1-flash",
    "pool": ["requesty::…", "…"],
    "fallbacks": []
  },
  "limits": { "maxTurns": 40, "timeoutMs": 1200000, "tokenBudget": 300000 },
  "notify": "auto",
  "phase": "busy",
  "status": "running",
  "createdAt": 0,
  "startedAt": 0,
  "endedAt": null,
  "runs": [
    {
      "number": 1,
      "sessionFile": "…jsonl",
      "consoleKey": "sub-3f9c2a10",
      "keeperSocket": "…"
    }
  ],
  "usage": { "turns": 0, "inputTokens": 0, "outputTokens": 0, "cost": null },
  "last": { "eventAt": 0, "tool": "bash", "toolStartedAt": 0 },
  "result": { "text": null, "reportPath": null, "truncated": false, "error": null }
}
```

`parentId` is null when the chooser is a root console and the spawning subagent's id
otherwise; it is the ancestry edge used for parent authority. `taskId` is reserved for the
future board and is unused in v1. Child sessions live in
`~/.hammer/pi/sessions/subagents/` so they never pollute the user's Sessions list
(`listSessions` is non-recursive). The registry is per router port,
beside the prepared Pi configuration. On startup, running children are reattached through
their keeper sockets; unreachable ones are marked failed with their partial report
preserved. Finished records stay addressable for resume and for the UI, bounded so the
file cannot grow forever.

### 3.5 The model catalogue the parent sees

Group level, not row level. A group has one intelligence figure and one aggregate usage
picture. The catalogue does not print how many routes sit behind the group: route
allowances differ too widely for a count to be a capacity signal.

Only groups with at least one route that can take a request now are listed; this is a
choosing surface, not an inventory. The default response shows the **frontier in detail
first**, then a compact index of every other active group, so the parent is not limited to
the six to ten frontier lines. `view: "all"` replaces the compact index with full detail
and pages through the complete active set. `query` and every filter search the whole active
set, not just the frontier; when one is supplied, the response is the matching groups in
detail, paginated, rather than the frontier/rest split.

Fields per line:

- `key` — stable group id and the **only identifier the parent needs**; it is the spawn
  parameter and the key the record stores;
- `intelligence` — the AA index **and its band tag** (`Genius` / `Very Smart` / `Smart` /
  `Average` / `Dumb` / `Very Dumb`); the tag is what the parent chooses by, the number is
  what fallback distances use;
- `speed` — the **band tag** (`Very Fast` / `Fast` / `Normal` / `Slow` / `Very Slow`), the
  composite effective tok/s at the 500-token reference, and `ttft`, so a fast generator
  with a slow start is visible rather than hidden;
- `usage` — `unlimited` / `ample` / `limited` / `scarce` / `exhausted` / `unknown`, with a
  one-line reason (`500 req/day · 361 left`, `20 req/min`, `no published limit`); the
  band is aggregate across the group's routes, not a promise for any one of them. A group
  whose every route is down, benched or exhausted is omitted; `exhausted` in the catalogue
  therefore means the aggregate is drained but at least one route is still eligible (for
  example, a route with no published cap);
- `context` — tokens;
- `tools` — native/emulated;
- `status` — up / benched / rate-limited;
- `in_use` — live children already on this group across the router; shown only when
  nonzero, a soft fan-out hint rather than a filter. The parent's own route is accounted
  for at selection time, not in this count.

A compact index line carries only `key`, intelligence tag, speed tag, usage, context and
`in_use`; the AA number, composite rate, TTFT, tools and status are in the detailed view.
The label is deliberately not in the catalogue: the key is unique and sufficient for
choosing and spawning, and the router can resolve the label from the key whenever a console
header or UI card needs one. The tables in this document name models for human
readability; the tool output itself, including the parent-facing result, sends keys only.

Example output:

```
SUBAGENT MODELS — frontier (AA 0-100; speed = effective tok/s at 500 tokens; ttft = time to first token)
key                    intel          speed                          usage     ctx  in_use
gemini-4-hydrogen      Very Smart 51.0  Very Slow    5 u/s   7.1s  ample     1M   1
ling-3.1-flash         Smart      41.1  Normal      37 u/s   5.9s  scarce    1M   —
swe-2-flash-medium     Smart      37.9  Fast        68 u/s   3.2s  limited   262k —
auto                   Smart      34.3  Very Fast  101 u/s   1.1s  ample     128k —
glm-5.3-flash          Average    27.8  Very Fast  143 u/s   1.1s  ample     1M   —
north-mini-code-1.0    Very Dumb   9.9  Very Fast  203 u/s   0.53s  ample     44k  —

ALSO ACTIVE — 94 more groups (compact; models({"view":"all"}) for detail)
key                    intel          speed       usage     ctx  in_use
deepseek-v4-flash      Smart      34.3  Very Fast  ample     128k —
qwen3.8-max            Very Smart 46.0  Slow       scarce    262k 1
… one compact line for every remaining active group …
```

The example truncates the compact section; the real default output carries one line for
every remaining active group. On the research install that is about 100 short lines, so
measure the payload before shipping rather than assuming it is small. If it exceeds the
console's tool-output budget, paginate the compact index with a footer naming the total
and the next `offset`; never silently drop an active group. The detailed frontier stays
around 300 tokens, and `view: "all"` pages at 25 detailed lines with `limit`/`offset` for
the full set. `view` defaults to `"default"` (frontier detail plus compact rest);
`"all"` switches to full detail pages.

The tool description should give the **rubric**, not a role table:

> Pick by the **intelligence tag** for judgement: Very Smart/Smart for design, review,
> debugging and anything ambiguous; Average for routine multi-file work; Dumb/Very Dumb
> only for mechanical, fully specified steps. Pick by the **speed tag** for volume: Very
> Fast/Fast when a turn must come back quickly, Normal for routine work, Slow/Very Slow
> only for background or short outputs; a high composite rate with a long TTFT is still
> slow to start. Pick by `usage` for longevity: prefer ample for long jobs; scarce or
> exhausted is a fallback risk. Before a fan-out, give each child a group with no `in_use`
> children. Separate groups avoid sharing one model's rate limit; do not put several
> children on the same group just because it is convenient. If no unused candidate clears
> the same floor, the router may still share one and says so. Check context against the
> files the child must read.

That satisfies “shown a list of all active models, with intelligence, speed and usage
tags”: the frontier is the suggested default, but every active group is visible in the same
response. `query`, `min_intelligence`, `min_speed`, `min_context`, `usage`,
`include_unrated`, `limit` and `offset` search or page the whole active set.

The usage band must be computed **server-side** and shared with the dashboard. Today the
five-band logic lives in `public/dashboard.js`; porting a second version into the tool
would inevitably diverge. Extract it to a pure module and have both call it. Because the
band is aggregate across the group's routes, it is a capacity summary rather than a
guarantee for any one route; the pool still re-checks each route before every request.

### 3.6 Model choice and fallback

Spawn accepts:

- a catalogue `key` (the normal case);
- a tier `fast` / `balanced` / `smart` (slope 85 / 40 / 0 over the current frontier,
  respecting usage and preferring a group with no in-use child), for cases where the exact
  key disappears between listing and spawning.

`inherit` is deliberately absent. Copying the parent's current route is the easiest way to
land several children on the same model/provider limit. Choose a key, or let a tier resolve
one; before a fan-out, prefer a group with no in-use children and avoid deliberately
sharing one group across children. This is a preference, not a
rule: an explicit key is always honored, with a collision warning in the receipt when the
group already has a live child, and a tier may reuse a busy group when no unused candidate
clears the same intelligence/speed/usage floor.

At spawn, resolve the key to an **ordered pool**:

1. the best route for that group (native tools, up, best usage/QoS);
2. the other routes for the same model group;
3. the nearest models on the intelligence/speed plane;
4. optionally one “strict” candidate with same-or-better intelligence.

The proxy already re-picks and records fallbacks per attempt; the subagent pool simply
feeds that loop instead of the slope selection. Every request re-filters the pool for
`status === 'up'`, eligibility and unexhausted quota. Route choice also prefers a route no
live child is using, so two children do not converge on one provider's limit when an
equivalent route is free; if every suitable route is already busy, it shares rather than
failing. The parent's own current route also counts as occupied when the router can
identify it, so a child does not land on the parent's provider merely because no sibling is
there. This remains a preference; an explicit key or provider still wins. No child restart
is needed when a model dies; the next request lands on the next pool member.

“Closest on the plot” should be a normalized distance, not raw units:

```
d = sqrt( ((AA₂ − AA₁)/10)² + (log₂(speed₂/speed₁)/1.5)² )
```

Prefer the same `modelGroupId` first, then the same intelligence band, then the smallest
distance. The band tags are the parent's selection vocabulary; the pool keeps using the
raw AA and composite-speed numbers for distance and floors, so a tag boundary cannot hide
a large numeric gap. A `fallback` policy controls the floor:

- `nearest` (default): allow one band down, never below `AA₁ − 10` or `speed₁ × 0.4`
  unless nothing else exists;
- `strict`: same-or-better intelligence only; prefer slower over dumber;
- `none`: fail rather than degrade.

When a fallback answers, the parent-facing result carries keys (`chosen=ling-3.1-flash`,
`ran=swe-2-flash-medium`, `reason=requesty down`); the UI renders the labels. The parent
must not silently receive a dumber answer. On this data, Ling 3.1 Flash (Smart / Normal, 41.1 / 37) falls to SWE-2 Flash
Medium (Smart / Fast, 37.9 / 68) under `nearest`, not to Gemini 4 Hydrogen (Very Smart /
Very Slow, 51.0 / 5) — the right default for most tasks, while `strict` would choose the
smarter, slower model.

### 3.7 Permissions and budgets

Tool grants at spawn, enforced at the router boundary, not by the child prompt:

| Grant               | Adds                                                      |
| ------------------- | --------------------------------------------------------- |
| read-only (default) | `read`, `grep`, `find`, `ls`                              |
| write               | + `edit`, `write`                                         |
| shell               | + `bash`                                                  |
| transcripts         | read same-root transcript/report; minimal `list`/`status` |
| message             | send, queue or steer any same-root agent                  |
| spawn               | create children, when `maxDepth` allows it                |

The `subagent` tool is present when at least one of `transcripts`, `message` or `spawn` is
granted; each action is gated separately. `status`/`list` are available to any parent over
its own descendants, and to a child with `transcripts` or `message` for same-root targets.
Those are **minimal** views: ids, names, parentage, phase, model key, usage and queue
length, never transcript or report text. `wait`, `stop` and `resume` are parent-only
control actions; `wait` returns the same minimal status unless the caller has
transcript/report authority. A child with only `message` cannot use them on a sibling.

Rules:

- The child's **Pi tool set** is clamped to the parent's own active tool set; asking for a
  tool the parent does not have is an error naming it, not a silent grant. Grants such as
  `transcripts` and `message` are router capabilities, not Pi tools: they are inherited
  only from the parent's explicit grant, except that every parent holds both over its
  descendants. This is stricter than opencode, whose child uses its own permission set; it
  prevents privilege escalation through delegation.
- `transcripts` is scoped to the same root: the child may read any same-root transcript
  or final report (in v1, the chooser and the other direct children). At the router boundary it cannot
  read a different root or the user's other sessions. This is a router policy, not an OS boundary; a child
  with `bash` can bypass it by reading session files (see 3.13). Reads return a bounded tail (default 8k chars), not
  the whole session, and are capped at 10 per child per 10 minutes.
- `message` is scoped to the same root: `steer` a live target, `queue` at its next turn
  boundary. The root chooser is addressable as `parent`; all
  other targets are ids. A finished target is not addressable through a child's
  `message`; a queued message whose target finishes before delivery returns
  `delivery_failed`, and a parent's `send` starts another run with only that message. It cannot message the user directly, approve a
  permission prompt, change tools or budget, or ask for a grant. Messages are attributed,
  capped at 8k chars and limited to 10 per child per 10 minutes. A parent that is blocked
  inside a `subagent` tool call accepts only `queue`, at its next turn boundary; `steer`
  is deferred while a tool call is open.
- Every parent has both powers over its own descendants without a grant. The chooser is not
  a subagent record: descendants address it as `parent`. Transcript reads count against the
  reader's context budget. Model-facing list and target lookup are scoped to the caller's
  conversation: a child's own spawn belongs to that child's run session, not to whatever
  session the root console happens to be viewing. Stopping or deleting a parent cascades to
  its running descendants so they are not left orphaned; deleting also removes their records,
  sessions and private agent directories.
- `spawn` requires depth < `maxDepth`. The default limit is **depth 2**: the root chooser
  can spawn, a depth-1 child can spawn its own child when it was given the `spawn`
  capability in `tools`, and a depth-2 child is terminal. The capability must be granted
  explicitly; it also adds the `subagent` tool. The child's token carries its requester id,
  `rootId`, `parentId`, depth and grants; routes derive the principal from the token and
  never trust a client-supplied parent or root. It never receives the parent's token.
  Background reports go to the immediate parent subagent while it is live, then fall back
  to the root conversation notice queue.
- `cwd` defaults to the parent workspace and must resolve inside it. Worktree isolation
  is a later option, not v1.
- Budgets are permissions too: wall clock 20 minutes (max 60), 40 turns, 300k tokens per
  child. A token budget is enforced from measured usage at every message and from the
  streamed output estimate, not only by a five-second poll; the child is stopped mid-turn if
  it crosses the ceiling. A steer at 80% says “wrap up”.
- There is no live-child concurrency cap: a parent may fan out as far as the supervised
  processes and its hourly spawn budget allow. The remaining cap is 32 spawns per hour,
  plus depth 2.
- **There is no OS sandbox.** A child with `bash` can read anything the user can,
  including other sessions, process environments and loopback routes. These grants are
  context and blast-radius limits, not a security boundary; do not give `bash` to a child
  that must be unable to reach sibling or parent context. If true isolation is required,
  use a separate OS user/container and restrict localhost, not a later worktree. Say so in
  the UI.

No approval prompts in v1. Hammer has no permission UI today, and adding one is a
separate feature; the allowlist plus the parent's judgement is the mechanism. If approvals
arrive later, the child's `tool_call` events can surface as prompts naming the subagent,
exactly as Claude does.

### 3.8 Reporting back

The parent gets a compact XML-ish result, not the transcript:

```xml
<subagent id="sa_3f9c" name="schema-audit" state="completed"
          model="ling-3.1-flash" fallback="none" turns="14" tokens="38,204" elapsed="2m 11s">
<result>…the child's final assistant message, capped at 16k chars…</result>
</subagent>
```

The parent gets **keys**, not labels, in every parent-facing tool payload. The UI resolves
`model`, `fallback` and provider keys to display names. If the report exceeds the cap,
write the full text to `~/.hammer/pi/subagents/<id>/report.md` and include the path.
Background receipts say `state="running"` and “do not poll”. Failures include the error,
the last partial output, the model/fallback key trace, and `state="failed"`.

The UI shows much more than the parent: live tool calls, thinking, errors and usage come
from the child's console stream.

### 3.9 Notifications

- `notify: "auto"` (default for background): if the parent is idle, start a turn with the
  `<subagent-result>` message; if busy, queue it as a follow-up; if the parent process is
  gone, persist it and deliver on the next start.
- `notify: "queue"`: always wait for the next turn boundary.
- `notify: "silent"`: store the result and show a UI card, but do not wake the parent.

`auto` is the only default. A long job that should not wake the parent must ask for
`queue` explicitly; there is no duration-based default. The notification is a synthetic
user message to Pi, but the harness recognises the `<subagent-result>` wrapper and renders
it as a notification card rather than a message the user typed. This mirrors opencode's
background injection and Claude's completion notification, with an explicit way to avoid
burning a turn.

Peer messages use the same delivery machinery with an `<agent-message>` wrapper. They are
accepted from a child holding the `message` grant, or from a parent exercising its inherent
authority, and always name their sender. `steer` injects into a live turn; `queue` waits
for the next turn boundary. A message addressed to the parent is always a steer, including
while the parent is inside a `subagent` tool call; only messages to other targets use the
requested mode.
Message-triggered turns count against the recipient's budget, and a root-level cap stops
ping-pong; the 10-per-10-minute limit alone is not enough. A message to a finished target
is rejected for a child; a parent's `send` restarts it with only that message. The
`<agent-message>` wrapper is
presentation metadata, not an authorization boundary: Pi sees a user-shaped message, so
the parent charter must treat peer text as untrusted instructions. It cannot approve,
change grants or budgets, or be treated as user approval.

### 3.10 Steering, status and stalls

Yes to steering, with four channels:

- **Parent:** `send` (steer or queue; a finished child restarts on the message) and `transcript`.
  Targets are ids, or `parent` for the chooser. Useful for a course correction or missing
  information.
- **Permissioned child:** with `message`, send/queue/steer any same-root agent; with
  `transcripts`, read its bounded transcript. Messages arrive as attributed
  `<agent-message>` cards, never as user text.
- **User:** open the child's console view and type; the composer already has steer and
  queue semantics.
- **Future observer:** a read-only agent subscribed to another child's deltas (the
  advisor pattern), not v1.

Guardrails: messages from any agent are never approval for a permission prompt; a child's
tools and budget cannot be changed by a message; every message is attributed to its sender
and scoped to the same root; parent and child messages are capped and rate-limited. A
parent that is inside a `subagent` tool call accepts only queued messages, at its next turn
boundary. The tool description should say “use `send` only for corrections or missing
facts; do not chatter”.

Stall diagnosis is `status`, not a guess: `phase`, `quietMs`, `currentTool` +
`startedAt`, `queue length`. The parent can call `transcript` if it needs the text tail. UI
shows a “quiet 2m” badge. A child with an open `bash` call for 10 minutes is a long tool,
not a stall. An optional `idle_timeout_ms` can auto-stop, default off. A watchdog
(pi-subagents/oh-my-pi style) is a later feature; the status fields are enough for v1.

### 3.11 UI

The harness already has the right surfaces; do not add a new page.

- **Sidebar “Subagents” section** above Sessions, scoped to the active conversation. A
  small tree: parent at the root, children indented. Each row: phase dot/spinner, name,
  intelligence and speed band chips, elapsed, tokens, “quiet” badge. Hover actions: open,
  stop.
- **Child view** reuses the transcript/composer. The strip shows `subagent · <name> ·
<model> · <tools>` with a “back to parent” link. The details rail shows the brief,
  requested vs selected model, fallback trace, tool chips, budget, session file, parent
  link, and stop/steer buttons.
- **Parent transcript card** for the `subagent` tool call: collapsed shows name, model
  chip, status, last activity; expanded shows the brief, live tail, tool allowlist, and
  final report. An “Open subagent” button. This is a custom case in the existing tool-card
  renderer. Its model chip resolves the stored key to a label and carries the intelligence
  and speed bands.
- **Background completion** renders as a notification card, not a raw user message. The
  message is still injected into Pi's transcript, but the UI recognises the
  `<subagent-result>` wrapper.
- **Agent messages** render as `<agent-message>` cards in the recipient's transcript, with
  sender and mode; they never use the user-message styling.
- **Model choice visibility:** the spawn card resolves the chosen key to a label and shows
  its intelligence band, speed band, composite rate/TTFT and usage tag, so a poor choice is
  visible. If the group already has in-use children, the card shows a rate-limit warning; it
  does not block the spawn. A user override at spawn is not needed in v1; stop/delete on
  another model can come later. A child with `bash` also shows a “policy only, not a
  sandbox” note; do not imply file or network isolation.
- **Future task board:** a “Tasks” tab in the Subagents panel, cards with
  pending/active/done and dependencies. Do not reserve space now, but give records a
  nullable `taskId` and `rootId` so the board is a projection of the same registry rather
  than a second store.
- **Mobile:** the sidebars already become drawers; the child view uses the same layout.

Because subagent consoles reuse the page-wide SSE stream, opening a child is just
`activate(console)` — no new connection, no polling.

### 3.12 Roles, advisor and teams

**No hardcoded roles.** The tool has no `agent_type` enum. `name` is a free label (slug),
`task` is the brief, and optional `instructions` is how the parent defines the role. The
child's system prompt is a generic subagent charter plus those instructions; the code
contains no reviewer/scout/worker personas. Documentation can show examples, but they
must not become a library of built-ins.

**Advisor** is a pattern we can add without a role: a read-only child whose brief is
“review this plan/diff”, plus `transcript` and `send` to read and inject advice. If it
proves valuable, add a generic `observe` grant (subscribe to another child's event
deltas) and an `advise` tool with severities, following oh-my-pi's
`nit`/`concern`/`blocker` delivery rules. The new `transcripts` and `message` grants make
the point-to-point version possible in v1; a dedicated advisor runtime and its severity
layer remain later.

**Parallel teams** are future work. The registry's `parentId`, `rootId`, `name` (unique per
root), nullable `taskId`, and per-child console stream are enough to add a shared task
board and a mailbox later. The permissioned `transcripts`/`message` channel is the only
peer path v1 includes: point-to-point, same-root, with no broadcast, shared task board or
mailbox. The tree remains the authority structure.

### 3.13 Security

- **Token auth between the extension and the router.** Every call carries a random token
  whose claims identify the requester (root console key or subagent id), `rootId`,
  `parentId`, depth and grants. Routes derive the principal from the token; they never
  accept a sender, parent or root from the query or body. The token never grants more than
  the requester's own rights.
- **Loopback is transport, not authorization.** Transcript, message, status and control
  routes require the same principal check even when called from localhost; a child with
  `bash` must not be able to bypass a grant by curling the UI API. If the browser needs
  those routes, it uses a scoped UI token/session, not bare loopback.
- **Never pass the parent's token to a child.** Build the child environment explicitly;
  only its own token, its own agent dir, and the workspace.
- **Tool clamp** at the router, never just the prompt.
- **cwd clamp** to the parent workspace.
- **No sandbox:** `bash` can run anything. The allowlist limits accidental damage, not a
  malicious model.
- **Transcript grants expose context.** A child with `transcripts` can read a same-root
  agent's messages and tool results, including any secrets they contain. The grant is
  explicit, same-root only, and read-bounded; do not enable it for a child that only needs
  to work. At the router layer it is scoped; the no-sandbox caveat still applies.
- **Message attribution and scope.** The router derives the sender from the token and
  rejects cross-root targets; messages cannot approve a permission prompt, change grants or
  budgets, or be treated as user approval. That keeps `message` a communication grant, not
  a privilege path at the router. A child with `bash` can still bypass the router entirely.
- **Prompt injection:** a child's task text may tell it to spawn more agents or read
  secrets. Depth, tool grants, budgets and the absence of an approval channel are the
  limits. State that subagents are a context/permission boundary, not a security boundary.
- **Audit:** record model, fallbacks, tools, usage, limits, transcript reads and message
  sends/attempts (sender, target, mode, bytes, result) plus rate-limit rejections; surface
  them in the UI and result metadata. Do not store transcript contents in the audit log.

### 3.14 Concurrency and resources

- There is deliberately no live-child cap; 32 spawns per hour and depth 2 remain.
- Each child is a Pi process plus a keeper process, so a fan-out costs roughly two processes
  per live child. The keeper is what makes a router restart survivable, so it is worth the
  overhead. If it becomes a problem, a single fleet keeper can replace one-per-child later.
- Quotas are shared across a group's routes, and the parent's own route counts as
  occupied where known. Many children on one scarce model will thrash; the catalogue's
  usage tag and the fallback pool are the mitigation. The usage band is aggregate, so the
  pool still re-checks each route before every request.
- A root budget (e.g. 1M tokens) can cap the total cost of a fan-out; per-child budgets
  stop one runaway child first, and message-triggered turns count against the recipient.
- A root-level peer-message/turn cap stops two children from keeping each other awake.
- Two children editing the same file have no lock in v1. Briefs should partition work;
  worktree isolation is the later fix.

---

## 4. Interface sketch

### 4.1 Tool schema

One tool with actions keeps the tool list small and matches the proven `pi-subagents`
shape:

```ts
subagent({
  action: "models" | "spawn" | "status" | "list" | "transcript" | "wait" | "send" | "stop" | "resume",
  // models
  view?: "default" | "all", // default = frontier detail + compact rest; all = detail pages
  query?: string, min_intelligence?: number,
  min_speed?: number, min_context?: number, usage?: string,
  include_unrated?: boolean, limit?: number, offset?: number, // detail or compact page, default 25
  // spawn (the four model filters are accepted here too)
  name?: string, task?: string, instructions?: string,
  min_intelligence?: number, min_speed?: number, min_context?: number, usage?: string,
  model?: string,            // catalogue key or "fast"|"balanced"|"smart"; no "inherit"
  provider?: string,         // optional exact provider
  tools?: string[],          // read, grep, find, ls, edit, write, bash, webfetch, web_search, web_fetch, transcripts, message, spawn
  background?: boolean, notify?: "auto" | "queue" | "silent", // auto = background default
  thinking?: "off" | "low" | "medium" | "high",
  max_turns?: number, timeout_ms?: number, token_budget?: number, // clamped to limits
  // control
  id?: string,               // target id, or "parent" for the chooser
  message?: string, mode?: "steer" | "queue",
  wait_ms?: number, transcript_limit?: number, // chars, default 8000
})
```

`min_intelligence` and `min_speed` accept a 1-based tag floor for small integers:
intelligence 1–6 is Very Dumb through Genius, speed 1–5 is Very Slow through Very Fast.
Larger values are the raw AA score and effective tok/s. `usage` accepts `any`, `usable`,
`ample`, or one of the concrete bands; an unknown word is rejected rather than silently
matching nothing. The same filters can be passed to `spawn` to constrain its tier choice.

`web_search` and `web_fetch` are keyless Pi extensions materialized with the child agent. They
are not in the default child tool set; pass them explicitly when a child needs current external
facts or a known URL. The parent console loads the same extension, so it can research before
delegating and can inspect the URLs a child returns.

Alternative considered: split `subagent_models` from `subagent`. A separate catalogue tool
is more discoverable, but two tools cost prompt space and the action form is what the
ecosystem uses. Start with one tool; split later only if model selection proves hard for
the parent.

### 4.2 HTTP routes

Every route that reads a transcript, sends a message, reports status or controls a child
requires the caller's principal token and a same-root target check. Loopback is transport,
not authorization; the browser uses a scoped UI token/session for the same routes. There is
no loopback-only cross-agent route.

Model-facing reads are also scoped to the conversation that spawned the child
(`record.parent.sessionFile`). The root stays per console so the UI can show each
conversation's historical branch, but a new session on that console cannot list, name-match
or read a previous session's children. The UI token is the one console-wide principal.

```text
POST /api/subagents                 spawn
GET  /api/subagents                 list, caller-scoped
GET  /api/subagents/:id             status; report only with ancestor/transcripts authority
GET  /api/subagents/:id/transcript  bounded transcript tail
POST /api/subagents/:id/send        steer or queue
POST /api/subagents/:id/stop
DELETE /api/subagents/:id           delete record and owned files
GET  /api/subagents/models          catalogue (also used by the UI preview)
GET  /api/subagents/events          lifecycle SSE (caller-scoped, or fold into consoles)
```

### 4.3 Extension shape

`lib/pi/extensions/subagent.ts`, materialised into `<agentDir>/extensions/`, with
`HAMMER_SUBAGENT_API` and a per-console `HAMMER_SUBAGENT_TOKEN` in the environment. It
uses `pi.registerTool`, `onUpdate` for progress, and plain `fetch`; no dependencies.

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: '…spawn and control a child agent…',
    parameters: Type.Object({/* see schema above */}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // POST /api/subagents, then poll status and call onUpdate with a compact tail.
      // Return { content: [{ type: 'text', text: report }], details: { id, state, model, usage } }.
    },
  })
}
```

The extension is deliberately a thin client: orchestration, model policy, permissions
and persistence live in the router, not in a TypeScript file inside a child process. Every
request carries the token; the router derives the sender and checks the target. The
model-supplied `id` is a target, never a sender or root claim.

### 4.4 Integration points in existing code

- `lib/pi/agent-dir.js` — `hammerModelsConfig` needs a `consoleKey` override so a child
  can send `X-Hammer-Pi-Console: sub-<id>`. Each child gets its own agent dir.
- `lib/pi/runtime.js` — `planPiLaunch` needs a subagent variant with a per-child agent
  dir, `--tools`, `--session-dir`, and an `APPEND_SYSTEM.md`.
- `lib/pi/bridge.js` and `lib/http/routes/pi.js` — reusable as-is; add a subagent map and
  include its consoles in the page-wide stream.
- `lib/http/routes/proxy.js` — already reads the console header for slope; add “if this
  key is a subagent, use its ordered pool” before slope resolution, and attribute usage
  to the subagent.
- `lib/utils.js` — `buildModelGroups`, `computeRowSpeed`, `computeRowIntelligence`,
  `isModelEligibleForRouting` give the catalogue; add a pure `nearestModel`.
- `public/dashboard.js` / a new shared module — extract the five-band usage logic so the
  tool and the dashboard agree.
- `public/harness.js` — `createConsole`, `consoleApi`, `activate`, `renderSessions` and
  the generic tool card are the seams for child rows, the child view and the subagent
  card.
- A new subagent route module — owns principal/target checks and the minimal status/list
  shapes; do not reuse loopback-only handlers for transcript, send or control.
- `test/support/fake-pi.mjs` — add scripted child behaviours for tests.

---

## 5. Risks and edge cases

- **Pi extension loading in RPC mode** is the first thing to verify. If Pi does not load a
  custom extension there, the whole tool approach needs a different delivery mechanism;
  test it before building UI.
- **Packaged app:** extension files must be copied out of the asar; keep the
  materialisation step and its test.
- **Model group vs route:** catalogue keys are groups; a group can have alias rows with
  different real model ids. Resolve the actual row server-side and report it.
- **Usage-band drift:** compute it once, server-side; do not let the dashboard and the tool
  disagree.
- **Two children editing the same file:** no locks in v1. Briefs should partition work;
  worktree isolation is the later fix.
- **Quota contention:** children share the group's route quotas; the soft spread and the
  pool/fallback reduce collisions, but four children on one scarce model will still thrash.
  An explicit key is honored with a warning rather than rejected, so this is not a hard
  scheduler.
- **Aggregate usage hides route exhaustion:** the usage tag is group-level; one route can
  be spent while another carries the group. The pool re-filters each route before every
  request; do not infer capacity from a route count.
- **Runaway spawns:** depth 2, live-child cap, total cap, token/time budgets, per-token
  scope. A child with `bash` can still bypass tool limits by running another agent; that is
  the no-sandbox caveat.
- **Permission bypass through `bash`:** a child with `bash` can read session files, process
  environments and loopback routes. Router grants are policy and context isolation, not an
  OS boundary; do not grant `bash` where transcript/message isolation matters. Loopback
  routes still require the principal token; loopback alone is not access.
- **Peer-message loop:** two children can queue or follow up on each other and burn turns.
  The rate limit slows this; a root-level message-triggered turn cap and the recipient's
  budget must stop it.
- **Parent restart:** keeper adoption and registry persistence are required; otherwise a
  router update kills running children. Implement and test reattachment in Phase 2, not
  only during final hardening.
- **Catalogue size:** the default exhaustive index is about 100 short lines on this
  install. Measure it; if it exceeds the tool-output budget, paginate the compact remainder
  rather than dropping groups.
- **Notification noise:** waking an idle parent for every background completion can burn
  turns. `auto` is the default; a long job that should not wake the parent must set
  `notify: "queue"` explicitly. There is no duration heuristic.
- **Sessions list pollution:** child sessions in a subdirectory; never show them as user
  conversations.
- **Model disappearance between listing and spawn:** validate the key and return the
  closest keys; do not silently substitute. Mid-run disappearance is handled by the pool.
- **Named parent model:** if the user names `pi.provider`/`pi.model`, the console is not
  routed through Hammer; subagents should be unavailable with a clear note, not silently
  routed elsewhere.
- **Compaction:** child context is its own; the router's per-console window and compaction
  rules need to apply to the child's console key, not the parent's.
- **Tool result size:** cap the report and keep the full text on disk; a child that
  dumps a 200k-character transcript must not blow up the parent's context.

---

## 6. Implementation plan

### Phase 0 — the spike

Before UI or state machinery, confirm:

1. Pi loads `<agentDir>/extensions/subagent.ts` in `--mode rpc`.
2. `--tools read,grep` actually restricts the child.
3. A per-child `models.json` header reaches the proxy on chat and compaction requests.
4. A bridge can adopt a child keeper with key `sub-<id>`.

If any fails, stop and adjust the architecture before building on it.

### Phase 1 — catalogue and policy (pure, testable)

- Shared usage-band module.
- Group catalogue with detailed frontier, compact all-active index, filters and pagination;
  measure the default payload and define compact overflow.
- `nearestModel` fallback selector and policy floors.
- Tool-clamp and budget validators, including `transcripts`/`message` scoping, target
  authorization, parent handle and minimal list/status shapes.
- Key-only parent result contract.
- Tests against synthetic rows and the live shape.

### Phase 2 — runtime

- Registry and persistence, including `parentId`/`rootId` and reattachment of live children.
- Per-child agent directory and launch plan.
- Bridge/keeper wiring and console registration.
- Principal token issuance and route authorization, including loopback requests.
- Spawn/status/stop, foreground tool, materialised extension, minimal list/status.
- `fake-pi` tests for start, complete, fail, stop, restart adoption.

### Phase 3 — control

- Background promotion and notifications.
- `send` / `wait` / `resume`, queue mode, and `transcript`.
- Fallback pool through the proxy and fallback trace.
- Budget wrap-up.
- Transcript tail, message attribution, delivery gates, peer-loop caps, audit and
  peer-message cards.

### Phase 4 — UI

- Sidebar Subagents tree.
- Child console view.
- Parent tool card, notification card and agent-message card.
- Model/fallback chips, with keys resolved to labels only here.
- Stop/steer/transcript controls and the policy-only note for `bash` children.
- Source-text tests in the project's existing style, plus a manual pass.

### Phase 5 — hardening

- Orphan cleanup and fleet-keeper evaluation.
- Concurrency caps and per-child session cleanup.
- Documentation.
- End-to-end with two real children.

Deferred deliberately: worktree isolation, team broadcast/shared mailbox, task board,
observer/advisor severity layer, nested depth greater than 2, in-process children for
startup latency, user-facing model override at spawn.

---

## 7. Test plan

- **Catalogue:** grouping, detailed frontier plus a compact index covering every active
  group, both band tags, usage bands, the `in_use` hint, filters over the whole active set,
  stable keys, no labels in the tool payload, label resolution by key, the default payload
  size and compact overflow, and `view: "default"`/`"all"` pagination.
- **Model spread:** a tier prefers an unused group; the parent route counts as occupied
  where known; an explicit key collision warns but does not fail; an all-busy fan-out
  shares instead of refusing.
- **Fallback:** same-group route preference, nearest distance, strict floor, all-down
  failure, no silent downgrade. The band tags are display-only; the numeric floors decide.
- **Permissions:** requested tool not in parent set; `spawn` at depth limit; cwd escape;
  child token cannot grant more; `transcripts`/`message` denied by default, allowed in the
  same root, and refused across roots; the parent always has both over descendants; a
  minimal status/list never contains transcript or report text; report and transcript
  reads require ancestor authority or the `transcripts` grant; the `parent` handle resolves
  only to the chooser; `wait`/`stop`/`delete` are parent-only and `wait` never returns
  report text to a `message`-only child.
- **Principal and routes:** forged sender/root/target is rejected; a loopback request
  without the token cannot read or send; token claims match the registry.
- **Transcript and messaging:** bounded transcript reads; steer/queue modes for ordinary
  targets; a parent-bound message is always steered, including inside a `subagent` tool
  call; a child's message to a finished
  target fails with `delivery_failed`, while a parent's `send` restarts it with the message;
  peer-loop turn caps and recipient budgets; attribution; no approval or grant escalation;
  message and read rate limits.
- **Reporting:** the parent-facing result contains keys only; labels are resolved only in
  the UI.
- **Lifecycle:** spawn → status → complete; stop; resume from a session file; wait timeout;
  background promotion; parent restart adoption is exercised in Phase 2; orphan cleanup.
- **Notifications:** busy parent queues; idle parent wakes; silent stores; parent absent
  delivers on next start; the default is `auto`; a long job must set `queue` explicitly.
- **Budgets:** 80% steer, 100% abort, partial report; message-triggered turns count.
- **Audit:** transcript reads, message sends/attempts, rate-limit rejections and result
  metadata are recorded without transcript contents.
- **UI:** sidebar tree, live child, tool card, notification card, model/fallback chips, and
  the policy-only note for `bash` children (source-text and manual).
- **Packaging:** the extension exists inside the asar and is materialised beside the
  supervisor script at runtime.

---

## 8. Decisions to confirm

These are the defaults this plan assumes:

1. **Foreground by default**, with promotion to background after `wait_ms`; background
   only when explicitly requested. (Claude defaults background; a parent that usually
   needs the answer is better served by foreground.)
2. **Read-only tool default** (`read`, `grep`, `find`, `ls`), with explicit grants for
   `edit`/`write`/`bash`. Safer, but every editing delegation must say so.
3. **Model required at spawn** — catalogue key or a tier. No silent default and no
   `inherit`; the choice is the feature.
4. **Depth 2** (one nested level) and **4 live / 8 total** per root. The `spawn` grant is
   explicit and may be passed to a depth-1 child; depth-2 children are terminal.
5. **`notify: "auto"`** for background results (wake if idle, queue if busy), with
   `silent` available. A long job that should not wake the parent sets `queue` explicitly;
   there is no duration-based default.
6. **No agent library** — names and instructions only; reusable definitions, if wanted
   later, are user-created templates, not built-ins.
7. **No route count in the catalogue.** Route allowances differ by orders of magnitude, so
   a count is not a capacity signal; the usage tag is shown instead, and the pool re-checks
   routes per request.
8. **Both axes show their band tag.** Intelligence prints its band beside AA; speed prints
   its band beside composite tok/s and TTFT. The numbers stay available for distance and
   floors.
9. **Keys only in every parent-facing tool payload.** The choosing model sees group keys,
   model keys and fallback keys, never display labels; labels are resolved server-side only
   for consoles and UI cards.
10. **Soft model spread, not a scheduler.** Prefer a group/route with no in-use child; the
    parent's current route counts as occupied when known. Explicit keys are honored with a
    collision warning, and tiers reuse a busy group when no unused candidate clears the
    floor.
11. **Transcript and message are explicit grants, off by default.** Same-root only, with a
    parent handle (`parent`), bounded reads and attributed messages; every parent has both
    powers over its own descendants. The token carries the requester, root, parent, depth
    and grants; the sender and root are never taken from the model's request body, and the
    model-supplied target is resolved and authorized against the registry.
12. **The catalogue is exhaustive, not frontier-only.** The default response shows the
    frontier in detail, then a compact line for every other active group; `view: "all"`
    pages the full detail. Measure the default payload; paginate the compact remainder if
    it exceeds the tool-output budget rather than dropping groups.
13. **Loopback is not authorization.** Every transcript, message, status and control route
    checks the principal token and same-root target, including calls from the local UI.
14. **These grants are policy, not OS security.** A child with `bash` can read session
    files and call localhost; use a separate OS user/container if true isolation is needed.
    A worktree does not provide it.

If those look right, the next step is the spike plus phase 1; the pure catalogue/fallback
layer should land first so model selection can be tested against real data before any
process plumbing.

---

## Sources

- [Claude Code — Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code — Agent tool behavior / tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Code — Agent teams](https://code.claude.com/docs/en/agent-teams)
- [opencode — Agents](https://opencode.ai/docs/agents)
- [opencode — v2 agents](https://opencode.ai/v2/docs/agents.md)
- [opencode — task tool source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts)
- [opencode — task tool description](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/task.txt)
- [Pi — Extensions](https://pi.dev/docs/latest/extensions)
- [Pi — CLI](https://pi.dev/docs/latest/cli)
- [Pi — Settings](https://pi.dev/docs/latest/settings)
- [Pi — Configuration](https://pi.dev/docs/latest/configuration)
- [Pi — Subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)
- [pi-subagents](https://github.com/nicobailon/pi-subagents)
- [pi-subagents — tool reference](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/tool-reference.md)
- [oh-my-pi — Advisor, WATCHDOG.md and WATCHDOG.yml](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md)
