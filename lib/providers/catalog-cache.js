/**
 * @file lib/providers/catalog-cache.js
 * @description The provider model catalogs hammer has already read, kept between reads and
 * between runs.
 *
 * Startup discovery reads a dozen or more catalogs (see `startupDiscoveryTasks` in
 * `lib/server.js`), and most of them answer with the same list they answered with ten minutes
 * ago: a model roster is a catalog, not a stream. Asking every provider again on every launch
 * is what made the startup wave wait on the network for data the previous run had already
 * downloaded and parsed.
 *
 * This module is where that data waits, and it is deliberately *only* a cache:
 *
 *   - **It never replaces discovery.** An entry is served for a short window
 *     (`CATALOG_CACHE_FRESH_MS`, 30 minutes by default — the shortest provider refresh interval
 *     in `lib/server.js`) and after that the provider is asked again. Nothing in `sources.js`
 *     is rewritten from it and no model list is hardcoded here.
 *   - **"Unchanged" is the provider's answer, not ours.** Once the window has passed, the
 *     stored `ETag`/`Last-Modified` go back out as conditional headers, so a catalog that has
 *     not moved costs a `304` and no body. Only a real change replaces what is stored.
 *   - **It is disposable.** The file is `~/.hammer-model-cache.json`: not config, not user
 *     state, and deleting it costs one fetch per provider. A corrupt or unreadable file is
 *     read as an empty cache rather than reported as an error, because that is all it ever
 *     was. `HAMMER_MODEL_CACHE_MS` tunes the window and `HAMMER_MODEL_CACHE_PATH` moves the
 *     file (tests use both).
 *   - **A credential is an identity, never a secret.** Half the catalogs are account-scoped —
 *     a Copilot plan's rows, Workers AI's per-account list — so the key has to include the
 *     credential that scoped the answer. It includes a *digest* of the request headers: the
 *     file holds no API key, two accounts never share an entry, and rotating a key misses the
 *     entry, which is the right answer for a different account.
 *   - **Nothing happens at import time.** Loading is lazy and saving is debounced, so
 *     importing this module — or `./discovery.js`, which does — opens no file and starts no
 *     timer until a caller actually reads a catalog.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * How long a stored catalog is served without asking the provider anything.
 *
 * Matched to the shortest provider refresh interval (30 minutes, see
 * `DISCOVERABLE_PROVIDER_MODELS_REFRESH_MS`), so an entry never outlives the freshness the
 * router already assumed between two refreshes in one run.
 */
export const CATALOG_CACHE_FRESH_MS = Number(process.env.HAMMER_MODEL_CACHE_MS) || 30 * 60_000

/**
 * The entry shape. Bumping it retires an older file instead of misreading it — a cache from a
 * previous build is not evidence about this one.
 */
const CATALOG_CACHE_VERSION = 1

/** A cache, not a store: past this many catalogs the least recently fetched go. */
const CATALOG_CACHE_MAX_ENTRIES = 96

/** A catalog this large is not worth the write; it is also the only way the file can grow. */
const CATALOG_CACHE_MAX_BODY_BYTES = 8 * 1024 * 1024

/** One discovery wave writes a dozen entries; coalescing them keeps that off the boot path. */
const CATALOG_CACHE_SAVE_DELAY_MS = 250

/**
 * Headers that describe *how* to ask rather than *who* is asking. They are excluded from the
 * key so a conditional revalidation or a different `Accept` still finds the same entry.
 */
const NON_SCOPING_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'user-agent',
  'if-none-match',
  'if-modified-since',
])

/** @returns {string} the file the cache lives in. */
export function catalogCachePath() {
  return process.env.HAMMER_MODEL_CACHE_PATH || join(homedir(), '.hammer-model-cache.json')
}

/**
 * The identity of one catalog read: the URL, the method, and a digest of the headers that
 * scope the answer (the credential above all).
 *
 * The digest is what keeps the file free of secrets: a key in the cache would outlive its
 * removal from `~/.hammer.json`, and the only question this file has to answer is whether two
 * reads would be answered the same way.
 *
 * @param {string} url
 * @param {string} [method]
 * @param {Record<string, unknown>} [headers]
 * @returns {string}
 */
export function catalogCacheKey(url, method = 'GET', headers = {}) {
  const scoping = Object.entries(headers || {})
    .map(([name, value]) => [String(name).trim().toLowerCase(), String(value ?? '')])
    .filter(([name]) => !NON_SCOPING_HEADERS.has(name))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const digest = createHash('sha256').update(JSON.stringify(scoping)).digest('hex').slice(0, 16)
  return `${String(method).toUpperCase()} ${url} ${digest}`
}

/** @type {Map<string, {payload: unknown, etag: string|null, lastModified: string|null, fetchedAt: number}> | null} */
let entries = null
let saveTimer = null

function loadEntries() {
  if (entries) return entries
  entries = new Map()
  try {
    const path = catalogCachePath()
    if (!existsSync(path)) return entries
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || parsed.version !== CATALOG_CACHE_VERSION) return entries
    if (!parsed.entries || typeof parsed.entries !== 'object') return entries
    for (const [key, entry] of Object.entries(parsed.entries)) {
      // A truncated or hand-edited entry is skipped, not trusted: the provider is always
      // still available to answer, so there is nothing to salvage.
      if (!entry || typeof entry !== 'object') continue
      if (!('payload' in entry) || !Number.isFinite(Number(entry.fetchedAt))) continue
      entries.set(key, entry)
    }
  } catch {
    // An unreadable cache is an empty cache. Discovery is the source of truth either way.
    entries = new Map()
  }
  return entries
}

/**
 * @param {string} key
 * @returns {{payload: unknown, etag: string|null, lastModified: string|null, fetchedAt: number}|null}
 */
export function readCatalogCacheEntry(key) {
  return loadEntries().get(key) || null
}

/**
 * Whether an entry is young enough to answer without a request at all.
 *
 * @param {{fetchedAt: number}|null} entry
 * @param {{maxAgeMs?: number, now?: number}} [options]
 */
export function isCatalogCacheFresh(
  entry,
  { maxAgeMs = CATALOG_CACHE_FRESH_MS, now = Date.now() } = {},
) {
  if (!entry) return false
  const fetchedAt = Number(entry.fetchedAt)
  if (!Number.isFinite(fetchedAt)) return false
  return now - fetchedAt < maxAgeMs
}

/**
 * The headers that ask "has this changed since you last told me?".
 *
 * Empty when the provider published no validator, which turns the stale read into an ordinary
 * fetch: revalidation is an optimization, never a requirement.
 *
 * @param {{etag?: string|null, lastModified?: string|null}|null} entry
 * @returns {Record<string, string>}
 */
export function catalogConditionalHeaders(entry) {
  const headers = {}
  if (entry?.etag) headers['If-None-Match'] = entry.etag
  if (entry?.lastModified) headers['If-Modified-Since'] = entry.lastModified
  return headers
}

/**
 * Stores one catalog read and schedules the write.
 *
 * @param {string} key
 * @param {{payload: unknown, etag?: string|null, lastModified?: string|null, fetchedAt?: number}} entry
 */
export function writeCatalogCacheEntry(key, entry) {
  const store = loadEntries()
  const sized = entry || {}
  if (catalogBodyBytes(sized.payload) > CATALOG_CACHE_MAX_BODY_BYTES) return
  store.set(key, {
    payload: sized.payload,
    etag: sized.etag || null,
    lastModified: sized.lastModified || null,
    fetchedAt: Number.isFinite(Number(sized.fetchedAt)) ? Number(sized.fetchedAt) : Date.now(),
  })
  while (store.size > CATALOG_CACHE_MAX_ENTRIES) {
    let oldestKey = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [entryKey, value] of store) {
      const at = Number(value?.fetchedAt) || 0
      if (at < oldestAt) {
        oldestAt = at
        oldestKey = entryKey
      }
    }
    if (!oldestKey) break
    store.delete(oldestKey)
  }
  scheduleSave()
}

/**
 * How big a catalog would be on disk.
 *
 * A payload JSON cannot serialise cannot be written either, so it is measured as unbounded
 * rather than stored and lost on the next save.
 */
function catalogBodyBytes(payload) {
  try {
    return JSON.stringify(payload)?.length || 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveCatalogCache()
  }, CATALOG_CACHE_SAVE_DELAY_MS)
  // An unref'd timer cannot hold the process open. A launch that exits before it fires loses
  // a cache write, which is exactly the cost this file is designed to accept.
  saveTimer.unref?.()
}

/**
 * Writes the cache through a temp file and a rename, the same way the usage file is written
 * (`saveUsageStats` in `lib/server.js`): a reader sees the previous file or the new one, never
 * half of one, and a crash mid-write costs the cache rather than corrupting it.
 */
export function saveCatalogCache() {
  if (!entries) return
  const path = catalogCachePath()
  const tmpPath = `${path}.${process.pid}.tmp`
  try {
    const payload = {
      version: CATALOG_CACHE_VERSION,
      savedAt: new Date().toISOString(),
      entries: Object.fromEntries(entries),
    }
    writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 })
    renameSync(tmpPath, path)
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* nothing to clean up */
    }
  }
}

/**
 * Forgets every entry.
 *
 * The cache's whole contract is that it is disposable, and this is that contract made
 * callable: a test needs a clean slate, and so would a future `--no-model-cache` flag. The
 * in-memory map is dropped rather than emptied so the next read reloads from disk — which is
 * what makes `keepFile` a way to simulate a restart.
 *
 * @param {{keepFile?: boolean}} [options]
 */
export function resetCatalogCache({ keepFile = false } = {}) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  entries = null
  if (keepFile) return
  try {
    unlinkSync(catalogCachePath())
  } catch {
    /* there was no file, which is the same thing */
  }
}
