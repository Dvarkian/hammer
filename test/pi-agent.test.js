// @ts-check
/**
 * The Pi console: the bridge that speaks Pi's JSONL RPC mode, and the routes that serve it.
 *
 * Both are exercised without Pi, a model or a network call: the bridge is driven against
 * `test/support/fake-pi.mjs`, and the routes are mounted on a bare Express app with a stub
 * bridge, the same way the other extracted route groups are tested.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { PiBridge } from '../lib/pi/bridge.js'
import { registerPiRoutes } from '../lib/http/routes/pi.js'

const FAKE_PI = fileURLToPath(new URL('./support/fake-pi.mjs', import.meta.url))

/** A bridge wired to the fake, with the command log a test can read back. */
function makeFake(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pi-'))
  const logPath = join(dir, 'commands.log')
  writeFileSync(logPath, '')
  // The child inherits this at spawn, which is the only moment its environment is read.
  process.env.FAKE_PI_LOG = logPath
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: dir, ...options })
  return {
    bridge,
    commands: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
  }
}

/** Sets environment for the child the bridge is about to spawn, then restores it. */
async function withEnv(vars, run) {
  /** @type {Record<string, string | undefined>} */
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Resolves on the next record of this type. */
function nextEvent(bridge, type) {
  return new Promise((resolve) =>
    bridge.on('event', (record) => record.type === type && resolve(record)),
  )
}

test('the bridge reads the session state it reports', async () => {
  const { bridge } = makeFake()
  try {
    const data = await bridge.describe()
    assert.equal(data.model.id, 'fake-model')
    const status = bridge.status()
    assert.equal(status.available, true)
    assert.equal(status.model.provider, 'fake')
    assert.equal(status.sessionId, 'session-1')
    assert.equal(status.isStreaming, false)
  } finally {
    bridge.dispose()
  }
})

test('a streamed answer is reassembled when its record is split and carries U+2028', async () => {
  const { bridge } = makeFake()
  try {
    /** @type {any[]} */
    const events = []
    bridge.on('event', (record) => events.push(record))
    const settled = nextEvent(bridge, 'agent_settled')

    const response = await bridge.prompt('say hi')
    assert.equal(response.data.disposition, 'started')
    await settled

    const deltas = events
      .filter((record) => record.type === 'message_update')
      .map((record) => record.assistantMessageEvent.delta)
      .join('')
    assert.equal(deltas, 'Hello\u2028wörld', 'both halves of the split record belong to the answer')

    const text = events
      .filter((record) => record.type === 'message_end' && record.message.role === 'assistant')
      .map((record) => record.message.content[0].text)
      .join('')
    assert.equal(text, 'Hello\u2028wörld')
    assert.equal(bridge.status().isStreaming, false, 'settling ends the run')
  } finally {
    bridge.dispose()
  }
})

test('a prompt sent during a run is steered, which is what Pi requires', async () => {
  // The decision, not the transport: a child would only be a slower way to say `state.isStreaming`.
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    /** @type {any[]} */
    const sent = []
    bridge.send = async (command) => {
      sent.push(command)
      return { data: { disposition: command.streamingBehavior ? 'queued' : 'started' } }
    }
    bridge.state.isStreaming = true

    const record = await bridge.prompt('  steer this  ')
    assert.deepEqual(sent, [{ type: 'prompt', message: 'steer this', streamingBehavior: 'steer' }])
    assert.equal(record.data.disposition, 'queued')
    assert.equal(bridge.state.isStreaming, true, 'a queued steer keeps the run going')
  } finally {
    bridge.dispose()
  }
})

test('a prompt refused for streaming is retried as a steer rather than surfaced', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    /** @type {any[]} */
    const sent = []
    bridge.send = async (command) => {
      sent.push(command)
      if (!command.streamingBehavior) {
        // What a missed `agent_start` — a second tab, a dropped frame — leaves behind: the
        // bridge thinks the agent is idle, and Pi is the one that knows better.
        throw new Error('The agent is already streaming; specify streamingBehavior.')
      }
      return { data: { disposition: 'queued' } }
    }
    bridge.state.isStreaming = false

    const record = await bridge.prompt('second')
    assert.deepEqual(
      sent.map((command) => command.streamingBehavior ?? null),
      [null, 'steer'],
    )
    assert.equal(record.data.disposition, 'queued')
  } finally {
    bridge.dispose()
  }
})

test('a refusal that is not about streaming keeps its own error', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    let attempts = 0
    bridge.send = async () => {
      attempts += 1
      throw new Error('Model not found: invalid/model')
    }
    await assert.rejects(() => bridge.prompt('hello'), /Model not found: invalid\/model/)
    assert.equal(attempts, 1, 'an unrelated refusal is not retried as a steer')
  } finally {
    bridge.dispose()
  }
})

test('stopping clears the queue, cancels a retry, then aborts the run', async () => {
  const { bridge, commands } = makeFake()
  try {
    await bridge.abort()
    assert.deepEqual(commands(), ['clear_queue', 'abort_retry', 'abort'])
    assert.equal(bridge.state.isStreaming, false)
  } finally {
    bridge.dispose()
  }
})

test('a new session clears the transcript a page would replay', async () => {
  const { bridge } = makeFake()
  try {
    const settled = nextEvent(bridge, 'agent_settled')
    await bridge.prompt('hi')
    await settled
    assert.ok(bridge.history().length > 0)

    const record = await bridge.reset()
    assert.equal(record.data.cancelled, false)
    assert.equal(bridge.history().length, 0)
    assert.equal(bridge.state.sessionId, null)
  } finally {
    bridge.dispose()
  }
})

test('a cancelled new session keeps the transcript', async () => {
  await withEnv({ FAKE_PI_CANCEL_RESET: '1' }, async () => {
    const { bridge } = makeFake()
    try {
      const settled = nextEvent(bridge, 'agent_settled')
      await bridge.prompt('hi')
      await settled
      const before = bridge.history().length

      const record = await bridge.reset()
      assert.equal(record.data.cancelled, true)
      assert.equal(bridge.history().length, before, 'nothing was discarded, so nothing is lost')
    } finally {
      bridge.dispose()
    }
  })
})

test('a missing pi is reported as an install problem, and the failure is not cached', async () => {
  const bridge = new PiBridge({ command: 'definitely-not-pi-anywhere', cwd: tmpdir() })
  try {
    await assert.rejects(() => bridge.start(), /not installed or not on PATH/)
    assert.equal(bridge.status().available, false)
    assert.match(String(bridge.status().error), /not installed or not on PATH/)
    // A second attempt must spawn again: a user who installs Pi and retries has to get a child.
    await assert.rejects(() => bridge.start(), /not installed or not on PATH/)
  } finally {
    bridge.dispose()
  }
})

test('a crashed agent rejects the commands that were waiting on it', async () => {
  await withEnv({ FAKE_PI_EXIT_ON: 'get_state' }, async () => {
    const { bridge } = makeFake()
    try {
      const exited = new Promise((resolve) => bridge.once('exit', resolve))
      await assert.rejects(() => bridge.describe(), /exited with code 4/)
      const info = await exited
      assert.equal(info.code, 4)
    } finally {
      bridge.dispose()
    }
  })
})

test('the replay log is bounded in length and in characters', () => {
  const bridge = new PiBridge({
    command: process.execPath,
    args: [FAKE_PI],
    cwd: tmpdir(),
    logLimit: 5,
  })
  try {
    for (let i = 0; i < 20; i += 1) {
      bridge.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: String(i) },
      })
    }
    assert.equal(bridge.history().length, 5, 'the count cap holds')
    assert.equal(bridge.history().at(-1).assistantMessageEvent.delta, '19')

    // `agent_end` carries the whole conversation; one of those must not be kept forever.
    bridge.handle({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'x'.repeat(600_000) }],
    })
    assert.equal(bridge.history().length, 1, 'an oversized record pushes the older ones out')
  } finally {
    bridge.dispose()
  }
})

// ── The routes ───────────────────────────────────────────────────────────────────────────

/** A bridge stand-in: the routes only need these methods, and a real EventEmitter. */
class StubBridge extends EventEmitter {
  constructor() {
    super()
    this.available = true
    /** @type {Array<[string, string?]>} */
    this.calls = []
    this.cancelled = false
  }
  status() {
    return {
      available: this.available,
      running: true,
      command: 'pi',
      cwd: '/project',
      model: { id: 'stub-model', provider: 'stub' },
      thinkingLevel: 'off',
      isStreaming: false,
      sessionId: 's1',
      error: null,
      stderr: '',
      events: 1,
    }
  }
  history() {
    return [{ type: 'agent_start' }]
  }
  async describe() {
    if (!this.available) throw new Error('`pi` is not installed or not on PATH.')
    return { model: { id: 'stub-model', provider: 'stub' }, sessionId: 's1' }
  }
  async prompt(message) {
    this.calls.push(['prompt', message])
    return { data: { disposition: 'started' } }
  }
  async abort() {
    this.calls.push(['abort'])
    return {}
  }
  async reset() {
    this.calls.push(['reset'])
    return { data: { cancelled: this.cancelled } }
  }
  dispose() {}
}

async function withPiApp(bridge, run) {
  const app = express()
  app.use(express.json())
  registerPiRoutes(app, { piBridge: bridge })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the status route describes the agent, including why it is unavailable', async () => {
  const bridge = new StubBridge()
  await withPiApp(bridge, async (base) => {
    const ok = await (await fetch(`${base}/api/pi/status`)).json()
    assert.equal(ok.available, true)
    assert.equal(ok.model.id, 'stub-model')
    assert.equal(ok.session.model.id, 'stub-model')
    assert.equal(ok.session.sessionId, 's1')

    bridge.available = false
    const down = await (await fetch(`${base}/api/pi/status`)).json()
    assert.equal(down.available, false)
    assert.match(down.error, /not installed/)
  })
})

test('a prompt is validated and then handed to the agent trimmed', async () => {
  const bridge = new StubBridge()
  await withPiApp(bridge, async (base) => {
    const empty = await fetch(`${base}/api/pi/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })
    assert.equal(empty.status, 400)
    assert.deepEqual(await empty.json(), { error: 'A message is required.' })

    const huge = await fetch(`${base}/api/pi/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(20_001) }),
    })
    assert.equal(huge.status, 413)
    assert.equal(bridge.calls.length, 0, 'a refused prompt never reaches the agent')

    const ok = await fetch(`${base}/api/pi/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '  fix the tests  ' }),
    })
    assert.deepEqual(await ok.json(), { success: true, disposition: 'started' })
    assert.deepEqual(bridge.calls, [['prompt', 'fix the tests']])
  })
})

test('stop and new-session reach the agent and report a cancellation', async () => {
  const bridge = new StubBridge()
  await withPiApp(bridge, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/pi/abort`, { method: 'POST' })).json(), {
      success: true,
    })

    bridge.cancelled = true
    assert.deepEqual(await (await fetch(`${base}/api/pi/reset`, { method: 'POST' })).json(), {
      success: true,
      cancelled: true,
    })
    assert.deepEqual(bridge.calls, [['abort'], ['reset']])
  })
})

test('the event stream opens with the transcript the agent already produced', async () => {
  const bridge = new StubBridge()
  await withPiApp(bridge, async (base) => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/pi/events`, { signal: controller.signal })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body.getReader())
    const decoder = new TextDecoder()
    let buffer = ''

    /** Reads until one complete SSE frame is available. */
    const frame = async () => {
      for (;;) {
        const split = buffer.indexOf('\n\n')
        if (split >= 0) {
          const raw = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          return JSON.parse(raw.replace(/^data: /, ''))
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('the stream ended before a frame arrived')
        buffer += decoder.decode(value, { stream: true })
      }
    }

    const hello = await frame()
    assert.equal(hello.type, 'hello')
    assert.equal(hello.status.model.id, 'stub-model')
    assert.deepEqual(
      hello.log,
      [{ type: 'agent_start' }],
      'a page opened mid-run replays what it missed',
    )

    bridge.emit('event', { type: 'agent_start' })
    const live = await frame()
    assert.deepEqual(live, { type: 'event', record: { type: 'agent_start' } })

    bridge.emit('exit', { code: 1, signal: null, message: 'Pi exited with code 1.' })
    assert.deepEqual(await frame(), {
      type: 'exit',
      code: 1,
      signal: null,
      message: 'Pi exited with code 1.',
    })

    controller.abort()
  })
})
