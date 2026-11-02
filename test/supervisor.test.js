// @ts-check
/**
 * @file supervisor.test.js
 * @description The keeper, tested for the one thing it exists to do: an agent turn that outlives
 * the router that started it.
 *
 * The guarantee is not "the process stayed alive"; it is that a *new* bridge, with no state
 * carried over, can attach to the agent the old one left running and drive it. So the assertions
 * are made from the second router's side: the session it finds, the records it replays, and the
 * answers it can still get.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PiBridge } from '../lib/pi/bridge.js'
import {
  isLive,
  materializeSupervisor,
  supervisorScriptPath,
  supervisorSocketPath,
} from '../lib/pi/supervisor.js'

const FAKE_PI = fileURLToPath(new URL('./support/fake-pi.mjs', import.meta.url))

/**
 * A bridge whose agent is held by a keeper in this test's own directory.
 * @param {string} root
 * @param {Record<string, string>} [env]
 */
function supervisedBridge(root, env = {}) {
  return new PiBridge({
    command: process.execPath,
    args: [FAKE_PI, '--mode', 'rpc'],
    cwd: root,
    env,
    autoRestart: false,
    supervisor: {
      script: materializeSupervisor(supervisorScriptPath(root)),
      node: process.execPath,
      socket: supervisorSocketPath(root, 'test'),
      // Long enough that a slow test never trips the reaper; teardown is explicit.
      idleMs: 60_000,
    },
  })
}

/** @param {() => boolean | Promise<boolean>} predicate */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Awaited: an async predicate returns a truthy promise, which would pass on the first look.
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for a condition')
}

test('a replacement router drives the agent the old one left running', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-keeper-'))
  const first = supervisedBridge(root, { FAKE_PI_SESSION_ID: 'session-first' })
  t.after(() => {
    first.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  const started = await first.describe()
  assert.equal(started.sessionId, 'session-first')

  // The router goes away the way a restart takes it: released, not disposed.
  first.release()
  assert.equal(first.status().running, false)

  const second = supervisedBridge(root, { FAKE_PI_SESSION_ID: 'session-second' })
  t.after(() => second.dispose())

  // Adopted, so the *first* child answers — if the keeper had let it die, this bridge would
  // have spawned its own agent and reported its own session id.
  const adopted = await second.describe()
  assert.equal(adopted.sessionId, 'session-first')
  assert.equal(second.status().running, true)
  const stats = await second.send({ type: 'get_session_stats' })
  assert.equal(stats.data.tokens.total, 42)
})

test('a replacement router replays what the agent wrote while it was gone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-keeper-'))
  const first = supervisedBridge(root)
  t.after(() => {
    first.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  await first.prompt('what is in this directory')
  await waitFor(() => first.status().phase === 'alive')
  first.release()

  const second = supervisedBridge(root)
  t.after(() => second.dispose())
  await second.start()

  const types = second.history().map((record) => record.type)
  assert.ok(types.includes('agent_start'), 'the start of the turn is replayed')
  assert.ok(types.includes('agent_settled'), 'the end of the turn is replayed')
  // Replayed records are remembered, not re-processed: the turn's tokens were already counted
  // by the router that witnessed them.
  assert.equal(second.status().usage.totalTokens, 0)
})

test('disposing stops the agent instead of leaving it behind', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-keeper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = supervisedBridge(root, { FAKE_PI_SESSION_ID: 'session-first' })
  await first.describe()
  first.dispose()
  await waitFor(async () => !(await isLive(supervisorSocketPath(root, 'test'))))

  // A fresh console after a teardown starts its own agent rather than inheriting a stray one.
  const second = supervisedBridge(root, { FAKE_PI_SESSION_ID: 'session-second' })
  t.after(() => second.dispose())
  const state = await second.describe()
  assert.equal(state.sessionId, 'session-second')
})

test('restarting through the keeper replaces the child and keeps the bridge', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-keeper-'))
  const bridge = supervisedBridge(root)
  t.after(() => {
    bridge.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  await bridge.describe()
  const before = bridge.remote?.child?.pid
  const status = await bridge.restart()
  assert.equal(status.running, true)
  const after = bridge.remote?.child?.pid
  assert.notEqual(after, before, 'the keeper spawned a new child')
  const state = await bridge.describe()
  assert.equal(state.sessionId, 'session-1')
})

test('a launch that cannot start is reported, not retried forever', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-keeper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const bridge = new PiBridge({
    command: join(root, 'no-such-agent'),
    args: [],
    cwd: root,
    autoRestart: false,
    supervisor: {
      script: materializeSupervisor(supervisorScriptPath(root)),
      node: process.execPath,
      socket: supervisorSocketPath(root, 'broken'),
      idleMs: 60_000,
    },
  })
  t.after(() => bridge.dispose())

  await assert.rejects(() => bridge.describe(), /ENOENT|not installed|failed/i)
  assert.equal(bridge.status().running, false)
})
