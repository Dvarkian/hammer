// @ts-check
/**
 * @file server-source.js
 * @description The composer plus every extracted route module, as one string.
 *
 * Several tests assert on the *source text* of the request path — that the
 * snapshot route does not await the usage fan-out, that the chat handler
 * resolves models through `resolveRequestModels`, that a row spreads its
 * internal shape and then drops `pings`. Those assertions are about behaviour
 * that used to live in one file and now lives in modules, so they read the same
 * text they always did rather than being rewritten: the guarantee is unchanged,
 * only its address moved.
 *
 * When a module is added under lib/http/routes/, add it here — a test that
 * silently stopped finding a handler would otherwise pass by looking at
 * nothing.
 */

import { readFileSync } from 'node:fs'

const MODULES = [
  '../../lib/server.js',
  '../../lib/http/routes/models.js',
  '../../lib/http/routes/providers.js',
  '../../lib/http/routes/proxy.js',
  '../../lib/http/routes/oauth-copilot.js',
  '../../lib/http/routes/oauth-codex.js',
  '../../lib/http/routes/oauth-kiro.js',
  '../../lib/http/routes/oauth-devin.js',
]

export const serverSource = MODULES.map((path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8'),
).join('\n')
