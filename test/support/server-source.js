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
 * The module list is discovered rather than hand-maintained. A hard-coded list
 * would let a future extraction leave a handler outside this view, and every
 * guard aimed at it would then pass by looking at nothing.
 */

import { readdirSync, readFileSync } from 'node:fs'

const ROUTES = new URL('../../lib/http/routes/', import.meta.url)
const COMPOSER = new URL('../../lib/server.js', import.meta.url)

// Sorted so `indexOf` comparisons between two locations stay deterministic.
const routeModules = readdirSync(ROUTES)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => readFileSync(new URL(name, ROUTES), 'utf8'))

export const serverSource = [readFileSync(COMPOSER, 'utf8'), ...routeModules].join('\n')
