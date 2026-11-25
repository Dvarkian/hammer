import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OAUTH_CLIENTS_PATH, requireOAuthClient, resolveOAuthClient } from '../lib/oauth-clients.js'

function clientsFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-oauth-clients-'))
  const path = join(dir, 'oauth-clients.json')
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return path
}

test('the environment supplies a client before any file does', () => {
  const path = clientsFile({
    google: { clientId: 'file-id', clientSecret: 'file-secret' },
  })
  const client = resolveOAuthClient('google', {
    path,
    env: { GOOGLE_OAUTH_CLIENT_ID: 'env-id', GOOGLE_OAUTH_CLIENT_SECRET: 'env-secret' },
  })
  assert.deepEqual(client, { clientId: 'env-id', clientSecret: 'env-secret' })
})

test('the user file supplies a client when the environment is silent', () => {
  const path = clientsFile({
    antigravity: { clientId: 'file-id', clientSecret: 'file-secret' },
  })
  assert.deepEqual(resolveOAuthClient('antigravity', { path, env: {} }), {
    clientId: 'file-id',
    clientSecret: 'file-secret',
  })
})

test('a half-configured client is not a client', () => {
  const path = clientsFile({ google: { clientId: 'only-an-id' } })
  assert.equal(resolveOAuthClient('google', { path, env: {} }), null)
  assert.equal(
    resolveOAuthClient('google', { path: '', env: { GOOGLE_OAUTH_CLIENT_SECRET: 'only' } }),
    null,
  )
})

test('a missing or broken file reads as unconfigured, not as a crash', () => {
  assert.equal(resolveOAuthClient('google', { path: '/nope/oauth-clients.json', env: {} }), null)
  const path = clientsFile('{not json')
  assert.equal(resolveOAuthClient('antigravity', { path, env: {} }), null)
})

test('the error names both sources and the file the user can create', () => {
  assert.throws(
    () => requireOAuthClient('google', { path: '/tmp/nowhere.json', env: {} }),
    (error) => {
      assert.match(error.message, /GOOGLE_OAUTH_CLIENT_ID/)
      assert.match(error.message, /GOOGLE_OAUTH_CLIENT_SECRET/)
      assert.match(error.message, /\/tmp\/nowhere\.json/)
      return true
    },
  )
  // The default path is the user's own state, never the checkout.
  assert.match(OAUTH_CLIENTS_PATH, /\.hammer[/\\]oauth-clients\.json$/)
})

test('a configured pair is returned whole', () => {
  const path = clientsFile({ antigravity: { clientId: 'id', clientSecret: 'secret' } })
  assert.deepEqual(requireOAuthClient('antigravity', { path, env: {} }), {
    clientId: 'id',
    clientSecret: 'secret',
  })
})
