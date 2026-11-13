// @ts-check
/**
 * @file queue-store.js
 * @description What the agent was still holding, written down for the next router.
 *
 * A queued message lives only inside the agent process. Pi reports the queue as plain text in a
 * `queue_update` event and never writes it into the session file, so a router that restarts has no
 * way to ask for it again: the events it missed are gone. A message the user had already sent then
 * waits nowhere at all, which reads as "my message vanished".
 *
 * This is the small file that closes that gap. Every `queue_update` overwrites it, so it is never a
 * second source of truth — Pi still decides what the queue holds. It only answers the one question
 * nothing can ask once the events are lost: what had not been delivered yet.
 *
 * Records are keyed by **session**, not by console: a queue belongs to a conversation, so a
 * parallel console or a page reopened on another port finds the same messages waiting. The file
 * lives beside the prepared Pi configuration (`~/.hammer/pi/agent`), next to the slope and
 * last-session stores, and holds no credentials — only message text the user wrote themselves.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** @typedef {{ steering: string[], followUp: string[] }} QueueSnapshot */

/** What this process knows: the last queue Pi reported for each session. @type {Map<string, QueueSnapshot>} */
const queues = new Map()

/**
 * What was on disk before this process started. Kept apart from `queues` so a session whose queue
 * this process has already seen is never re-pointed by a stale file.
 * @type {Map<string, QueueSnapshot>}
 */
let stored = new Map()
/** Empty until the app names its directory (see configureQueueStore). */
let storePath = ''
let storeLoaded = false
/**
 * How many sessions are remembered across restarts. Parallel consoles and deleted sessions add keys,
 * so an unbounded file would grow for the life of the install; insertion order is recency.
 */
const STORE_LIMIT = 32

/**
 * The file a directory's queued messages are kept in.
 * @param {string} agentRoot where the prepared Pi configuration lives
 * @returns {string} the path, or '' when there is no directory to keep it in
 */
export function queueStorePath(agentRoot) {
  const root = String(agentRoot || '').trim()
  return root ? join(root, 'queued-messages.json') : ''
}

/**
 * Tells this module where to keep the queue across restarts. An unconfigured module keeps what it
 * is told in memory and touches no file, which is what a mounted test console wants.
 * @param {string|null|undefined} path
 */
export function configureQueueStore(path) {
  storePath = String(path || '').trim()
  stored = new Map()
  storeLoaded = false
  queues.clear()
}

/** @param {any} list */
function normalize(list) {
  if (!Array.isArray(list)) return []
  return list.map((text) => String(text ?? '')).filter((text) => text.trim().length > 0)
}

/**
 * Reads the file once. A missing, unreadable or malformed file means nothing was remembered, which
 * is a fresh install rather than an error.
 * @returns {Map<string, QueueSnapshot>}
 */
function readStore() {
  if (storeLoaded) return stored
  storeLoaded = true
  if (!storePath) return stored
  try {
    const data = JSON.parse(readFileSync(storePath, 'utf8'))
    const records = data && typeof data === 'object' ? data.queues : null
    if (!records || typeof records !== 'object') return stored
    for (const [key, value] of Object.entries(records)) {
      const name = String(key || '').trim()
      if (!name || !value || typeof value !== 'object') continue
      const queue = {
        steering: normalize(/** @type {any} */ (value).steering),
        followUp: normalize(/** @type {any} */ (value).followUp),
      }
      if (queue.steering.length || queue.followUp.length) stored.set(name, queue)
    }
  } catch {
    // No file yet, or one this version cannot read. Either way nothing is remembered.
  }
  return stored
}

/** Writes the records, atomically enough that a crash cannot leave half a file. */
function writeStore() {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    const body = { queues: Object.fromEntries(stored) }
    const tmp = `${storePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, storePath)
  } catch {
    // A file that cannot be written still holds the messages for as long as this process lives.
  }
}

/**
 * Records what one session's agent is holding. An empty queue deletes the record: the messages were
 * delivered or dropped, and remembering them would make the next start say them twice.
 * @param {string|null|undefined} key the session file (or id) the queue belongs to
 * @param {{ steering?: string[], followUp?: string[] }} queue
 * @returns {boolean} whether anything was recorded
 */
export function rememberQueue(key, queue) {
  const name = String(key || '').trim()
  if (!name) return false
  const next = { steering: normalize(queue?.steering), followUp: normalize(queue?.followUp) }
  readStore()
  if (!next.steering.length && !next.followUp.length) {
    queues.delete(name)
    if (stored.delete(name)) writeStore()
    return true
  }
  queues.set(name, next)
  stored.delete(name)
  stored.set(name, next)
  while (stored.size > STORE_LIMIT) {
    const oldest = stored.keys().next().value
    if (oldest === undefined) break
    stored.delete(oldest)
  }
  writeStore()
  return true
}

/**
 * What this process last saw waiting for a session, or what was on disk before it started.
 * @param {string|null|undefined} key
 * @returns {QueueSnapshot|null}
 */
export function rememberedQueue(key) {
  const name = String(key || '').trim()
  if (!name) return null
  const live = queues.get(name)
  if (live) return { steering: live.steering.slice(), followUp: live.followUp.slice() }
  readStore()
  const found = stored.get(name)
  return found ? { steering: found.steering.slice(), followUp: found.followUp.slice() } : null
}

/**
 * Drops one session's record — a queue that was delivered while nothing watched, or a session that
 * no longer exists.
 * @param {string|null|undefined} key
 * @returns {boolean} whether a record was removed
 */
export function forgetQueue(key) {
  const name = String(key || '').trim()
  if (!name) return false
  readStore()
  const had = queues.delete(name)
  const forgot = stored.delete(name)
  if (forgot) writeStore()
  return had || forgot
}
