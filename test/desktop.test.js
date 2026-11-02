import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import {
  DEFAULT_DESKTOP_PORT,
  dashboardUrl,
  isPortInUse,
  parseDesktopArgs,
  probeRouter,
  waitForDashboard,
} from '../desktop/runtime.js'

const okFetch = (body) => async () => ({ ok: true, json: async () => body })

test('the desktop app defaults to the port existing tool configs already point at', () => {
  const args = parseDesktopArgs(['/path/to/electron', '.'])

  // 7352 is not a preference: OpenCode and OpenClaw configs that users already installed name it,
  // so a different default would silently break every setup `hammer onboard` wrote.
  assert.equal(DEFAULT_DESKTOP_PORT, 7352)
  assert.equal(args.port, 7352)
  assert.equal(args.verbose, false)
  assert.deepEqual(args.bannedModels, [])
})

test('--port reads both forms, and a value the shell cannot use leaves the default', () => {
  assert.equal(parseDesktopArgs(['electron', '.', '--port', '7400']).port, 7400)
  assert.equal(parseDesktopArgs(['electron', '.', '--port=7401']).port, 7401)
  assert.equal(parseDesktopArgs(['electron', '.', '--port=7401', '-v']).verbose, true)

  // A typo must not be a launch failure: the default port is still a working app.
  assert.equal(parseDesktopArgs(['electron', '.', '--port', 'seventy']).port, 7352)
  assert.equal(parseDesktopArgs(['electron', '.', '--port', '70000']).port, 7352)
  assert.equal(parseDesktopArgs(['electron', '.', '--port']).port, 7352)
})

test('HAMMER_PORT is a fallback, not an override', () => {
  assert.equal(parseDesktopArgs(['electron'], { HAMMER_PORT: '7600' }).port, 7600)
  assert.equal(parseDesktopArgs(['electron', '--port', '7500'], { HAMMER_PORT: '7600' }).port, 7500)
  assert.equal(parseDesktopArgs(['electron'], { HAMMER_PORT: 'nope' }).port, 7352)
})

test('--ban keeps the CLI comma syntax and drops empty entries', () => {
  assert.deepEqual(parseDesktopArgs(['electron', '--ban', 'a,b ,,c']).bannedModels, ['a', 'b', 'c'])
})

test('the window and the router share one loopback origin', () => {
  // The dashboard's own URLs are relative, so this trailing slash is what makes `/api/models`
  // resolve against the router rather than against the splash file.
  assert.equal(dashboardUrl(7352), 'http://127.0.0.1:7352/')
})

test('a foreign service on the port is not mistaken for Hammer', async () => {
  assert.equal(
    await probeRouter('http://127.0.0.1:7352/', { fetchImpl: okFetch({ hello: 'world' }) }),
    null,
  )
  assert.equal(
    await probeRouter('http://127.0.0.1:7352/', { fetchImpl: okFetch({ version: 42 }) }),
    null,
  )
  assert.equal(
    await probeRouter('http://127.0.0.1:7352/', {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    }),
    null,
  )

  const meta = await probeRouter('http://127.0.0.1:7352/', {
    fetchImpl: okFetch({ version: '1.24.0', logging: {} }),
  })
  assert.equal(meta.version, '1.24.0')
})

test('startup polling keeps trying until the router answers discovery', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    // What the window sees while runServer() is still discovering providers: nothing listening.
    if (calls < 3) throw new Error('connect ECONNREFUSED')
    return { ok: true, json: async () => ({ version: '1.24.0' }) }
  }
  const polls = []

  const meta = await waitForDashboard('http://127.0.0.1:7352/', {
    fetchImpl,
    intervalMs: 1,
    timeoutMs: 2000,
    onPoll: (info) => polls.push(info.attempt),
  })

  assert.equal(meta.version, '1.24.0')
  assert.equal(calls, 3)
  assert.deepEqual(
    polls,
    [1, 2],
    'every failed attempt is reported so the splash can show progress',
  )
})

test('a port that answers with something else ends in a diagnosable error, not a hang', async () => {
  await assert.rejects(
    waitForDashboard('http://127.0.0.1:7352/', {
      fetchImpl: okFetch({ service: 'not hammer' }),
      intervalMs: 2,
      timeoutMs: 30,
    }),
    /did not answer on http:\/\/127\.0\.0\.1:7352\//,
  )
})

test('the port check separates "already listening" from "free"', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    // True means "ask before starting", which is what turns runServer's EADDRINUSE exit into a
    // dialog that names the offending port.
    assert.equal(await isPortInUse(port), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  assert.equal(await isPortInUse(port), false)
})
