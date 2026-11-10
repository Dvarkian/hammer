// @ts-check
/**
 * @file console-slope.js
 * @description The intelligence-vs-speed slope of each conversation.
 *
 * Routing used to take one global slope from the dashboard's plot. Now that the control lives in
 * the composer, every console owns its own value, and several conversations can be answering on
 * different models at once. The value here is a **percentage** of the data's slope ceiling (see
 * `selectorSlopeCeiling` in lib/utils.js), so 0% is "the smartest model" and 100% is "the
 * fastest, whatever it costs in intelligence" at any point in time — an absolute slope would
 * mean something different as the catalog's speed range moves.
 *
 * A console key is the name the proxy receives in `X-Hammer-Pi-Console`: the router port for the
 * main console, and `<port>-<id>` for a parallel one (see lib/pi/agent-dir.js and makeBridge).
 *
 * The value belongs to the conversation, not to the process serving it, so it is written through
 * to a small file beside the Pi configuration and restored when that console starts again. A
 * restart used to reset every composer to the exported default, which silently changed the model
 * a conversation would answer on; the file is what makes the choice outlive the router.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SELECTOR_DEFAULT_PERCENT, clampSelectorPercent } from '../utils.js'

/** @type {Map<string, number>} console key -> percent, 0..100 */
const percents = new Map()

/**
 * The choices as they were last written, so a console that is starting again gets its own value
 * back. Kept apart from `percents`: one is "what this process is routing on", the other is "what
 * was chosen before it started", and only the first is allowed to decide a running console.
 * @type {Map<string, number>}
 */
let stored = new Map()
/** Where the choices are remembered. Empty until the app names its directory (see configure). */
let storePath = ''
let storeLoaded = false
/**
 * How many conversations are remembered across restarts. Parallel consoles get a fresh key each
 * time, so the file would otherwise grow for the life of the install; the bound keeps the most
 * recently set ones (insertion order is recency, see remember()).
 */
const STORE_LIMIT = 64

/**
 * The file a directory's slopes are kept in.
 * @param {string} agentRoot where the prepared Pi configuration lives
 * @returns {string} the path, or '' when there is no directory to keep it in
 */
export function consoleSlopeStorePath(agentRoot) {
  const root = String(agentRoot || '').trim()
  return root ? join(root, 'console-slopes.json') : ''
}

/**
 * Tells this module where to remember choices. Called once at startup: an unconfigured module
 * keeps everything in memory and touches no file, which is what tests and a bare router want.
 * @param {string|null|undefined} path
 */
export function configureConsoleSlopeStore(path) {
  storePath = String(path || '').trim()
  stored = new Map()
  storeLoaded = false
}

/**
 * Reads the remembered choices once. A missing, unreadable or malformed file is not an error:
 * it means this install has nothing remembered, so every console starts at the default.
 * @returns {Map<string, number>}
 */
function readStore() {
  if (storeLoaded) return stored
  storeLoaded = true
  if (!storePath) return stored
  try {
    const data = JSON.parse(readFileSync(storePath, 'utf8'))
    const slopes = data && typeof data === 'object' ? data.consoleSlopes : null
    if (!slopes || typeof slopes !== 'object') return stored
    for (const [key, value] of Object.entries(slopes)) {
      const name = String(key || '').trim()
      const percent = clampSelectorPercent(value)
      if (name && percent != null) stored.set(name, percent)
    }
  } catch {
    // No file yet, or one this version cannot read. Either way nothing is remembered.
  }
  return stored
}

/** Writes the remembered choices, atomically enough that a crash cannot leave half a file. */
function writeStore() {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    const body = { consoleSlopes: Object.fromEntries(stored) }
    const tmp = `${storePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, storePath)
  } catch {
    // A choice that cannot be written still routes for as long as this process lives.
  }
}

/**
 * Remembers one console's choice, moving it to the front of the recency order and dropping the
 * oldest when the bound is reached.
 * @param {string} name
 * @param {number} percent
 */
function remember(name, percent) {
  readStore()
  stored.delete(name)
  stored.set(name, percent)
  while (stored.size > STORE_LIMIT) {
    const oldest = stored.keys().next().value
    if (oldest === undefined) break
    stored.delete(oldest)
  }
  writeStore()
}

/**
 * Declares a console at its remembered choice, or at the exported default when it has none.
 * A value this process already holds is never overwritten.
 * @param {string|null|undefined} key
 * @param {number|null} [percent] the default to use when nothing was remembered
 * @returns {number|null} the percent it now holds
 */
export function registerConsoleSlope(key, percent = SELECTOR_DEFAULT_PERCENT) {
  const name = String(key || '').trim()
  if (!name) return null
  if (!percents.has(name)) {
    const fallback = clampSelectorPercent(percent)
    const restored = readStore().get(name)
    percents.set(name, restored ?? (fallback == null ? SELECTOR_DEFAULT_PERCENT : fallback))
  }
  return percents.get(name) ?? null
}

/**
 * The slope one conversation asked for.
 * @param {string|null|undefined} key
 * @param {number} percent a number in 0..100
 * @returns {number|null} what was stored, or null when the key or value is unusable
 */
export function setConsoleSlopePercent(key, percent) {
  const name = String(key || '').trim()
  const value = clampSelectorPercent(percent)
  if (!name || value == null) return null
  percents.set(name, value)
  remember(name, value)
  return value
}

/**
 * @param {string|null|undefined} key
 * @returns {number|null} the stored percent, or null when this key has no conversation
 */
export function consoleSlopePercent(key) {
  const name = String(key || '').trim()
  if (!name) return null
  return percents.has(name) ? (percents.get(name) ?? null) : null
}

/** Every conversation the router is running, so the table can light all of their picks. */
export function listConsoleSlopes() {
  return Array.from(percents, ([consoleKey, percent]) => ({ consoleKey, percent }))
}

/** Forget every conversation and the file it would have written. Tests only. */
export function resetConsoleSlopesForTests() {
  percents.clear()
  stored = new Map()
  storeLoaded = false
  storePath = ''
}
