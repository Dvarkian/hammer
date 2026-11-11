// @ts-check
/**
 * @file console-session.js
 * @description The conversation each console was last on.
 *
 * Pi owns the transcript — every session is a JSONL file in the store — but the **console** is
 * what decides which of those files it is on. A console used to start a brand-new session every
 * time the router did, unless the keeper still had the previous agent alive and the new router
 * adopted it. So a restart that also lost the agent (a reboot, a crash, the keeper's idle window
 * expiring) put the console on an empty conversation, and the transcript the user was reading
 * looked lost: it was on disk the whole time, in a session nobody had opened.
 *
 * Remembering the file per console key is what closes that gap: the next router passes it as
 * `--session` and the conversation comes back as the same conversation, not a new one that
 * happens to sit beside it. A console key is the same name lib/pi/console-slope.js uses (the
 * router port, and `<port>-<id>` for a parallel console), so a restart restores the console the
 * page reopens, and a value chosen for one console can never be handed to another.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** @type {Map<string, string>} console key -> absolute session file */
const sessions = new Map()

/**
 * What was remembered before this process started. Kept apart from `sessions` so a console that
 * has already attached to a file is never re-pointed by something on disk.
 * @type {Map<string, string>}
 */
let stored = new Map()
/** Empty until the app names its directory (see configure). */
let storePath = ''
let storeLoaded = false
/**
 * How many consoles are remembered. A parallel console gets a fresh key each time, so an
 * unbounded file would grow for the life of the install; insertion order is recency.
 */
const STORE_LIMIT = 64

/**
 * The file a directory's remembered sessions are kept in.
 * @param {string} agentRoot where the prepared Pi configuration lives
 * @returns {string} the path, or '' when there is no directory to keep it in
 */
export function consoleSessionStorePath(agentRoot) {
  const root = String(agentRoot || '').trim()
  return root ? join(root, 'console-sessions.json') : ''
}

/**
 * Tells this module where to remember which file each console is on. An unconfigured module
 * keeps everything in memory and touches no file, which is what a mounted test console wants.
 * @param {string|null|undefined} path
 */
export function configureConsoleSessionStore(path) {
  storePath = String(path || '').trim()
  stored = new Map()
  storeLoaded = false
}

/**
 * Reads the remembered files once. A missing, unreadable or malformed file means nothing is
 * remembered, which is a fresh install rather than an error.
 * @returns {Map<string, string>}
 */
function readStore() {
  if (storeLoaded) return stored
  storeLoaded = true
  if (!storePath) return stored
  try {
    const data = JSON.parse(readFileSync(storePath, 'utf8'))
    const files = data && typeof data === 'object' ? data.consoleSessions : null
    if (!files || typeof files !== 'object') return stored
    for (const [key, value] of Object.entries(files)) {
      const name = String(key || '').trim()
      const file = typeof value === 'string' ? value.trim() : ''
      if (name && file) stored.set(name, file)
    }
  } catch {
    // No file yet, or one this version cannot read. Either way nothing is remembered.
  }
  return stored
}

/** Writes the remembered files, atomically enough that a crash cannot leave half a file. */
function writeStore() {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    const body = { consoleSessions: Object.fromEntries(stored) }
    const tmp = `${storePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, storePath)
  } catch {
    // A file that cannot be written still routes for as long as this process lives.
  }
}

/**
 * Remembers the conversation one console is on. Called whenever a bridge reports a session, so
 * a switch, a resume and a fresh start all leave the next process pointing at the right file.
 * @param {string|null|undefined} key
 * @param {string|null|undefined} file
 * @returns {boolean} whether anything was remembered
 */
export function rememberConsoleSession(key, file) {
  const name = String(key || '').trim()
  const value = String(file || '').trim()
  if (!name || !value) return false
  sessions.set(name, value)
  readStore()
  const known = stored.get(name)
  if (known === value) return true
  stored.delete(name)
  stored.set(name, value)
  while (stored.size > STORE_LIMIT) {
    const oldest = stored.keys().next().value
    if (oldest === undefined) break
    stored.delete(oldest)
  }
  writeStore()
  return true
}

/**
 * The conversation a console is on: what it has attached to in this process, or else what was
 * remembered before this process started.
 * @param {string|null|undefined} key
 * @returns {string|null}
 */
export function consoleSessionFile(key) {
  const name = String(key || '').trim()
  if (!name) return null
  const live = sessions.get(name)
  if (live) return live
  return readStore().get(name) ?? null
}

/**
 * Forgets a console's conversation. Deleting the session it was on is the case that matters: a
 * remembered path that no longer exists is refused at startup anyway, but the entry would keep
 * a stale name around for the next install.
 * @param {string|null|undefined} key
 */
export function forgetConsoleSession(key) {
  const name = String(key || '').trim()
  if (!name) return
  sessions.delete(name)
  readStore()
  if (stored.delete(name)) writeStore()
}

/** Forget everything, and the file it would have written. Tests only. */
export function resetConsoleSessionsForTests() {
  sessions.clear()
  stored = new Map()
  storeLoaded = false
  storePath = ''
}
