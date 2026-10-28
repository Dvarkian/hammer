# Architecture

Hammer is being dismantled in place: behaviour stays, structure moves outward
from one 7,500-line function. This file records the arrangement that exists
today so the next cut extends it instead of inventing a second one.

## The rule

**Functional core, imperative shell.** Pure functions own decisions; handlers
parse a request, call something, and serialise the answer. No handler reaches
across the app for state it could be handed.

## Layering, as it stands

```
bin/hammer.js          CLI entry (still one file)
lib/server.js          composition root: runServer wires discovery, config,
                       the express app, and the remaining 38 routes
lib/http/routes/       one module per resource; thin handlers only
lib/providers/         descriptors, catalog, discovery, resolution
lib/config.js          config read/write (single writer for the file)
sources.js, scores.js  model data (to move under lib/data/)
public/                dashboard, classic script, no build step
```

## The route contract

Every extracted route group is a `register*Routes(app, deps)` function with
JSDoc types on `deps`. Two rules make the modules safe to mount alone:

1. **A route module never imports `server.js`.** Anything it needs from the
   router — an engine, a cache-clear callback, the ping trigger — arrives in
   `deps`. This keeps the dependency direction one-way and avoids an import
   cycle.
2. **State moves with its only owner.** A store used solely by one group lives
   in that group's module, not as a module-level global in `server.js`. The
   device-flow maps for Copilot, Codex and Kiro moved this way; Kiro's social
   flow map stayed behind because `server.js` still owns that engine.

## Extracted so far

| Module                         | Routes | Owns                                 |
| ------------------------------ | ------ | ------------------------------------ |
| `http/routes/oauth-copilot.js` | 3      | Copilot device-flow store            |
| `http/routes/oauth-codex.js`   | 3      | Codex device-flow store              |
| `http/routes/oauth-kiro.js`    | 5      | Kiro Builder ID device-flow store    |
| `http/routes/oauth-devin.js`   | 4      | the session-token persister callback |

All 15 OAuth routes are out of `runServer`; each group has tests in
`test/oauth-routes.test.js` that mount it on a bare Express app with stub
dependencies — no listener on 7352, no config file, no network.

## Still in `runServer`

The `/v1` proxy and its request pipeline, `/api/models`, config import/export,
provider refresh/onboard, the retest job, and the lifecycle routes (restart,
usage, account status). The pipeline is the next seam worth cutting: it is the
hot path and the reason `runServer` exists at all.

## Follow-on work this record anticipates

- `lib/core/` for selection, ranking and classification, with `fetch`/`clock`/
  `fs` injected, replacing the remaining module-level mutable bindings with one
  `Runtime` object created at the composition root.
- `lib/utils.js` (141 unrelated functions) split by domain.
- Dashboard as ES modules, which also removes the inline `onclick` handlers
  behind the `no-unused-vars` exception in `eslint.config.js`.
