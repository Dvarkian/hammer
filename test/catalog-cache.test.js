/**
 * The provider model cache (lib/providers/catalog-cache.js), exercised through the one caller
 * that matters: `fetchJsonWithRetry`, which every catalog read goes through. The point of the
 * file is what it must never do — spend a request on a catalog it already holds, or keep
 * serving one the provider has changed — so that is what is asserted here.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  catalogCacheKey,
  catalogConditionalHeaders,
  isCatalogCacheFresh,
  readCatalogCacheEntry,
  resetCatalogCache,
  saveCatalogCache,
  writeCatalogCacheEntry,
} from '../lib/providers/catalog-cache.js'
import { fetchJsonWithRetry } from '../lib/providers/discovery.js'

const cacheDir = mkdtempSync(join(tmpdir(), 'hammer-model-cache-'))
process.env.HAMMER_MODEL_CACHE_PATH = join(cacheDir, 'cache.json')

const CATALOG_URL = 'https://catalog.test/v1/models'

function okResponse(payload, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => payload,
  }
}

function notModifiedResponse() {
  return { ok: false, status: 304, headers: { get: () => null } }
}

test('a catalog inside the freshness window costs no request at all', async () => {
  resetCatalogCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return okResponse({ data: [{ id: 'first-model' }] }, { etag: '"v1"' })
  }

  const first = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })
  const second = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })

  assert.deepEqual(second, first)
  assert.equal(calls, 1, 'the second read must be answered from the cache')
})

test('a stale catalog revalidates with its validator and a 304 reuses the body', async () => {
  resetCatalogCache()
  const sent = []
  const fetchImpl = async (url, options) => {
    sent.push(options.headers)
    if (sent.length === 1) return okResponse({ data: [{ id: 'first-model' }] }, { etag: '"v1"' })
    return notModifiedResponse()
  }

  await fetchJsonWithRetry(CATALOG_URL, { fetchImpl, cache: 'prefer', cacheMaxAgeMs: 0 })
  const revalidated = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    cache: 'prefer',
    cacheMaxAgeMs: 0,
  })

  assert.equal(sent.length, 2)
  assert.equal(sent[1]['If-None-Match'], '"v1"', 'the stored ETag has to go back out')
  assert.deepEqual(revalidated, { data: [{ id: 'first-model' }] })
  // The 304 is a fresh answer, so the entry starts a new window rather than staying stale.
  const entry = readCatalogCacheEntry(catalogCacheKey(CATALOG_URL))
  assert.equal(isCatalogCacheFresh(entry, { maxAgeMs: 60_000 }), true)
})

test('a catalog the provider has changed replaces the stored one', async () => {
  resetCatalogCache()
  let payload = { data: [{ id: 'old-model' }] }
  const fetchImpl = async () => okResponse(payload, { etag: '"v1"' })

  await fetchJsonWithRetry(CATALOG_URL, { fetchImpl, cache: 'prefer', cacheMaxAgeMs: 0 })
  payload = { data: [{ id: 'new-model' }] }
  const changed = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    cache: 'prefer',
    cacheMaxAgeMs: 0,
  })
  const fromCache = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })

  assert.deepEqual(changed, { data: [{ id: 'new-model' }] })
  assert.deepEqual(fromCache, { data: [{ id: 'new-model' }] })
})

test('a catalog is scoped to the credential that produced it, and the file keeps no key', async () => {
  resetCatalogCache()
  const scoped = []
  const fetchImpl = async (url, options) => {
    scoped.push(options.headers.Authorization)
    // The catalog a fake account sees names the account, which is enough to prove the two
    // reads were not served the same body.
    return okResponse({ data: [{ id: scoped.length === 1 ? 'model-a' : 'model-b' }] })
  }

  await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    headers: { Authorization: 'Bearer first-account' },
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })
  await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl,
    headers: { Authorization: 'Bearer second-account' },
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })

  // A second account's catalog is a different catalog, not a cache hit.
  assert.deepEqual(scoped, ['Bearer first-account', 'Bearer second-account'])

  saveCatalogCache()
  const written = readFileSync(process.env.HAMMER_MODEL_CACHE_PATH, 'utf8')
  assert.equal(
    written.includes('first-account'),
    false,
    'the cache file must never contain a credential',
  )
  assert.equal(
    catalogCacheKey(CATALOG_URL, 'GET', { Authorization: 'Bearer first-account' }).includes(
      'first-account',
    ),
    false,
  )
})

test('a refresh someone asked for is never answered from the cache', async () => {
  resetCatalogCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return okResponse({ data: [{ id: 'first-model' }] })
  }

  await fetchJsonWithRetry(CATALOG_URL, { fetchImpl, cache: 'prefer', cacheMaxAgeMs: 60_000 })
  await fetchJsonWithRetry(CATALOG_URL, { fetchImpl, cache: 'revalidate', cacheMaxAgeMs: 60_000 })

  assert.equal(calls, 2)
})

test('a catalog survives a restart, and a corrupt file is just an empty cache', async () => {
  resetCatalogCache()
  const fetchImpl = async () => okResponse({ data: [{ id: 'kept-model' }] }, { etag: '"v1"' })
  await fetchJsonWithRetry(CATALOG_URL, { fetchImpl, cache: 'prefer', cacheMaxAgeMs: 60_000 })
  saveCatalogCache()

  // A restart is the in-memory map going away while the file stays.
  resetCatalogCache({ keepFile: true })
  let calls = 0
  const afterRestart = await fetchJsonWithRetry(CATALOG_URL, {
    fetchImpl: async () => {
      calls += 1
      return okResponse({ data: [] })
    },
    cache: 'prefer',
    cacheMaxAgeMs: 60_000,
  })
  assert.deepEqual(afterRestart, { data: [{ id: 'kept-model' }] })
  assert.equal(calls, 0)

  writeFileSync(process.env.HAMMER_MODEL_CACHE_PATH, '{ not json at all')
  resetCatalogCache({ keepFile: true })
  assert.equal(readCatalogCacheEntry(catalogCacheKey(CATALOG_URL)), null)
})

test('conditional headers are only sent when the provider published a validator', () => {
  assert.deepEqual(catalogConditionalHeaders({ etag: '"v1"', lastModified: null }), {
    'If-None-Match': '"v1"',
  })
  assert.deepEqual(catalogConditionalHeaders({ etag: null, lastModified: 'Tue, 10 Nov 2026' }), {
    'If-Modified-Since': 'Tue, 10 Nov 2026',
  })
  assert.deepEqual(catalogConditionalHeaders(null), {})
})

test('an entry with no usable timestamp is never fresh and never stored', () => {
  assert.equal(isCatalogCacheFresh(null), false)
  assert.equal(isCatalogCacheFresh({ fetchedAt: Number.NaN }), false)

  resetCatalogCache()
  writeCatalogCacheEntry('GET https://catalog.test/v1/models 0000000000000000', {
    payload: { data: [] },
    fetchedAt: Number.NaN,
  })
  const entry = readCatalogCacheEntry('GET https://catalog.test/v1/models 0000000000000000')
  assert.ok(Number.isFinite(entry.fetchedAt), 'a missing timestamp is filled in, not stored as NaN')
})
