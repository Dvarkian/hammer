/**
 * ── The restart decision ───────────────────────────────────────────────────────────────
 *
 * `restartMode` is the single branch behind the dashboard's Restart button, and it is wrong in
 * both directions expensively. Treat a supervised process as self-managed and it spawns a second
 * router that fights the service for the port; treat a self-managed process as supervised and it
 * exits with nobody to bring it back, which is the worst outcome available to a button whose
 * entire job is to end in a running router.
 *
 * The platforms also report the same situation under different field names — systemd says
 * `active`, launchd says `loaded` — so the table is pinned here rather than rediscovered by
 * clicking the button on a machine someone then has to fix by hand.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { restartMode } from '../lib/server.js'

test('a process the autostart service owns exits so the service can restart it', () => {
  // systemd's view of a running unit.
  assert.equal(
    restartMode({ ok: true, supported: true, configured: true, enabled: true, active: true }),
    'supervised',
  )
  // launchd's view of the same situation, under its own field name.
  assert.equal(restartMode({ supported: true, configured: true, loaded: true }), 'supervised')
})

test('a process nobody supervises replaces itself', () => {
  assert.equal(restartMode({ supported: true, configured: false, active: false }), 'exec')
  // Configured but not running. This is the case that makes `configured` the wrong test: the CLI
  // stops the autostart supervisor whenever a foreground instance takes over, so a unit file on
  // disk is no evidence that anything would restart this process.
  assert.equal(
    restartMode({ supported: true, configured: true, enabled: true, active: false }),
    'exec',
  )
  assert.equal(restartMode({ supported: true, configured: true, loaded: false }), 'exec')
})

test('a platform whose autostart restarts nothing is never treated as supervised', () => {
  // Windows autostart is a Startup folder script that runs once at login: exiting there ends the
  // router instead of restarting it.
  assert.equal(restartMode({ ok: true, supported: true, configured: true }), 'exec')
  assert.equal(restartMode({ ok: false, supported: false, message: 'not supported' }), 'exec')
  assert.equal(restartMode(null), 'exec')
  assert.equal(restartMode(undefined), 'exec')
})
