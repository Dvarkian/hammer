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
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { PiBridge } from '../lib/pi/bridge.js'
import {
  HAMMER_MODEL,
  HAMMER_PROVIDER,
  defaultAgentDirFor,
  hammerModelsConfig,
  prepareHammerAgentDir,
} from '../lib/pi/agent-dir.js'
import { registerPiRoutes } from '../lib/http/routes/pi.js'
import { ensureHarnessDirs, normalizePiSettings, readPiSettings } from '../lib/pi/settings.js'
import {
  MIN_NODE_MAJOR,
  isAppBinary,
  nodeMajor,
  planPiLaunch,
  resolvePiRuntime,
  usableWorkspace,
} from '../lib/pi/runtime.js'
import { normalizeConfigShape } from '../lib/config.js'

const FAKE_PI = fileURLToPath(new URL('./support/fake-pi.mjs', import.meta.url))

/** Polls a predicate; a supervision delay is real elapsed time, not a promise a test can await. */
async function waitFor(predicate, { timeoutMs = 4_000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('timed out waiting for the expected state')
}

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

test('a queued follow-up runs as its own turn once the current one settles', async () => {
  const { bridge } = makeFake()
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '800' }, async () => {
      const firstSettled = nextEvent(bridge, 'agent_settled')
      await bridge.prompt('first turn')

      // Both queues take a message while the first turn runs.
      const steered = await bridge.prompt('steer mid-run')
      const held = await bridge.prompt('follow up', { queueMode: 'followUp' })
      assert.equal(steered.data.disposition, 'queued')
      assert.equal(held.data.disposition, 'queued')

      // Pi's own accounting reaches the status the page renders.
      await waitFor(() => bridge.status().queuedSteering.includes('steer mid-run'))
      await waitFor(() => bridge.status().queuedFollowUp.includes('follow up'))
      assert.equal(bridge.status().pendingMessages, 2)

      // The first turn settles; the held message starts as a turn of its own and then settles.
      await firstSettled
      await waitFor(() => !bridge.status().isStreaming, { timeoutMs: 4_000 })
      await waitFor(() => bridge.status().pendingMessages === 0)
      assert.equal(bridge.status().queuedFollowUp.length, 0)
    })
  } finally {
    bridge.dispose()
  }
})

test('stopping reports the queued messages it dropped', async () => {
  const { bridge } = makeFake()
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '800' }, async () => {
      await bridge.prompt('long turn')
      await bridge.prompt('steer mid-run')
      await bridge.prompt('held for later', { queueMode: 'followUp' })
      await waitFor(() => bridge.status().pendingMessages === 2)

      const record = await bridge.abort()
      assert.deepEqual(record.clearedQueue, {
        steering: ['steer mid-run'],
        followUp: ['held for later'],
      })
      assert.equal(bridge.status().pendingMessages, 0)
    })
  } finally {
    bridge.dispose()
  }
})

test('a queue_update empties when pi consumes what it was holding', async () => {
  // The authority runs one way: whatever pi says the queue holds is what the bridge holds,
  // including the empty list after the agent has taken the messages back out.
  const { bridge } = makeFake({})
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '200' }, async () => {
      await bridge.prompt('turn one')
      await bridge.prompt('held', { queueMode: 'followUp' })
      await waitFor(() => bridge.status().pendingMessages === 1)
      await waitFor(() => bridge.status().pendingMessages === 0, { timeoutMs: 6_000 })
    })
  } finally {
    bridge.dispose()
  }
})

test('stopping clears the queue, cancels a retry, then aborts the run', async () => {
  const { bridge, commands } = makeFake()
  try {
    await bridge.abort()
    // The stop sequence is the part that matters, and Pi documents it in this order; the
    // `agent_settled` the fake emits on abort triggers a stats sync that may follow.
    const log = commands()
    const i = log.indexOf('clear_queue')
    assert.notEqual(i, -1, 'the queue is cleared first')
    assert.deepEqual(log.slice(i, i + 3), ['clear_queue', 'abort_retry', 'abort'])
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

// ── Session persistence: switch, restart-to, and the store ────────────────────────────────

test('an idle agent switches sessions over RPC and reports where it landed', async () => {
  await withEnv(
    { FAKE_PI_SESSION_FILE: '/store/other.jsonl', FAKE_PI_SESSION_ID: 'session-switched' },
    async () => {
      const { bridge } = makeFake()
      try {
        const settled = nextEvent(bridge, 'agent_settled')
        await bridge.prompt('hi')
        await settled
        assert.ok(bridge.history().length > 0)

        await bridge.switchSession('/store/other.jsonl')
        assert.equal(bridge.state.sessionFile, '/store/other.jsonl')
        assert.equal(bridge.state.sessionId, 'session-switched')
        assert.equal(bridge.history().length, 0, 'the replay log is a different conversation now')
      } finally {
        bridge.dispose()
      }
    },
  )
})

test('a busy agent refuses an in-place switch, and a cancelled one changes nothing', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    bridge.state.isStreaming = true
    await assert.rejects(() => bridge.switchSession('/store/other.jsonl'), /busy/)

    bridge.state.isStreaming = false
    await withEnv({ FAKE_PI_CANCEL_SWITCH: '1' }, async () => {
      const record = await bridge.switchSession('/store/other.jsonl')
      assert.equal(record.data.cancelled, true)
    })
  } finally {
    bridge.dispose()
  }
})

test('a restart to a session re-spawns the child with --session and keeps it across a crash', async () => {
  const { bridge, commands } = makeFake({ autoRestart: true, restartBaseMs: 5 })
  try {
    await bridge.start()
    const first = bridge.child
    await bridge.restartTo('/store/other.jsonl')
    assert.notEqual(bridge.child, first)
    assert.equal(bridge.state.sessionFile, '/store/other.jsonl')
    assert.deepEqual(bridge.args.slice(-2), ['--session', '/store/other.jsonl'])
    // The proof is on disk: the replacement child was launched with the session flag.
    await waitFor(() => commands().some((line) => line.includes('"--session"')))

    // A crash-restart must come back on the same session: the conversation is on disk.
    const exited = new Promise((resolve) => bridge.once('exit', resolve))
    bridge.child?.kill('SIGTERM')
    await exited
    await waitFor(() => Boolean(bridge.child) && bridge.phase === 'alive')
    assert.deepEqual(bridge.args.slice(-2), ['--session', '/store/other.jsonl'])
  } finally {
    bridge.dispose()
  }
})

test('the command allowlist admits the session controls and nothing broader', async () => {
  const { bridge } = makeFake()
  try {
    await assert.doesNotReject(() => bridge.runCommand('get_messages'))
    await assert.doesNotReject(() =>
      bridge.runCommand('switch_session', { sessionPath: '/store/other.jsonl' }),
    )
    await assert.rejects(() => bridge.runCommand('export_html'), /not allowed/)
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

test('a child that dies on its own is respawned, and its crash budget resets after a turn', async () => {
  const { bridge } = makeFake({ autoRestart: true, restartBaseMs: 5 })
  try {
    await bridge.start()
    const first = bridge.child
    assert.ok(first, 'the fake agent is running')

    const exited = new Promise((resolve) => bridge.once('exit', resolve))
    bridge.restarts = 3
    first.kill('SIGTERM')
    await exited
    assert.equal(bridge.phase, 'dead', 'a crash is visible before the respawn')

    await waitFor(() => Boolean(bridge.child) && bridge.child !== first)
    await waitFor(() => bridge.phase === 'alive')
    assert.ok(bridge.restarts >= 1, 'the restart was counted')

    // One completed turn proves the agent works, so a long session does not march toward the
    // restart limit with a healthy process.
    const settled = nextEvent(bridge, 'agent_settled')
    await bridge.prompt('hello')
    await settled
    assert.equal(bridge.restarts, 0)
  } finally {
    bridge.dispose()
  }
})

test('a manual restart replaces the child without supervising the old one', async () => {
  const { bridge } = makeFake({ autoRestart: true, restartBaseMs: 5 })
  try {
    await bridge.start()
    const first = bridge.child
    const status = await bridge.restart()
    assert.equal(status.available, true)
    assert.notEqual(bridge.child, first, 'the replacement is a new process')
    assert.equal(bridge.restartTimer, null, "the old child's exit did not schedule another")

    const settled = nextEvent(bridge, 'agent_settled')
    const record = await bridge.prompt('still here?')
    assert.equal(record.data.disposition, 'started')
    await settled
  } finally {
    bridge.dispose()
  }
})

test('a stopped bridge leaves nothing to restart', async () => {
  const { bridge } = makeFake({ autoRestart: true, restartBaseMs: 5 })
  bridge.dispose()
  assert.equal(bridge.restartTimer, null)
  assert.equal(bridge.child, null)
  await assert.rejects(() => bridge.start(), /disposed/)
})

test('the transcript keeps thinking, text and tool calls in the order the model made them', () => {
  // The page is a classic script, so this guards the shape of the fold rather than running it:
  // each assertion names a fact a broken transcript port would lose. The harness owns the fold
  // now that the router's Pi tab is gone.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

  // Thinking is content, not a placeholder: the harness shows what the model actually thought.
  // The trailing console is the conversation the record belongs to — a page can hold several.
  assert.match(harness, /appendDelta\('thinking', update\.contentIndex, update\.delta, ctx\)/)
  assert.match(harness, /class="hx-thinking-text"/)

  // Blocks are keyed by contentIndex and sorted, because Pi restarts that index for every
  // assistant message and grows it in production order.
  assert.match(harness, /function appendDelta\(kind, contentIndex, delta, ctx = active\(\)\)/)
  assert.match(harness, /item\.blocks\.sort\(\(a, b\) => a\.index - b\.index\)/)

  // A tool is announced when the model calls it, so its box sits where the call was made.
  assert.match(harness, /update\.type === 'toolcall_start'/)
  assert.match(harness, /function ensureTool\(id, name, ctx = active\(\)\)/)

  // Live output: a long command is legible while it runs, not only once it finishes. Nothing
  // is trimmed from it — a clipped result is a result that lies about what ran.
  assert.match(harness, /case 'tool_execution_update'/)
  assert.match(harness, /item\.partial = resultText\(record\.partialResult\)/)

  // A provider that answers without deltas still contributes its thinking and text parts.
  assert.match(harness, /function contentParts\(content\)/)
  assert.match(harness, /item\.blocks = contentParts\(message\.content\)/)

  // Runaway prose is clipped from the front, where the tail is what a reader needs. Tool
  // calls are not: a command, an argument blob or a result that was cut changed what it says.
  assert.match(harness, /const MAX_TEXT = 120000/)
  assert.doesNotMatch(harness, /MAX_TOOL/)
  // A multi-line command must survive: toolSummary is what the head of the row shows, and it
  // must not flatten the whitespace or cap the length of what the model actually wrote. The
  // rail's accessible label still folds to one line, but that is the label's own choice.
  const summary = harness.slice(
    harness.indexOf('function toolSummary'),
    harness.indexOf('return String(raw)'),
  )
  assert.ok(!summary.includes('replace(/\\s+/g'), 'tool summaries keep newlines')
  assert.ok(!summary.includes('clip('), 'tool summaries are never trimmed')

  // Sessions persist on the server; the rail lists them and opens one in a console of its own,
  // rebuilding the transcript from the session's own messages for a run this page never saw.
  assert.match(harness, /const API = '\/api\/pi'/)
  assert.match(harness, /function loadSessions\(\)/)
  assert.match(harness, /function openConversation\(file\)/)
  assert.match(harness, /function loadMessages\(ctx = active\(\)\)/)

  // A resumed tool row needs the command from the assistant message that called it; the result
  // message only carries output, so restoring rows from results alone lost every command line.
  assert.match(harness, /part\.type !== 'toolCall'/)
  assert.match(harness, /const call = calls\.get\(key\)/)
  assert.match(harness, /args: call\?\.args \|\| null/)

  // A call that never returned — closed mid-command — keeps its row instead of vanishing.
  assert.match(harness, /for \(const \[key, call\] of calls\)/)
  assert.match(harness, /status: 'running',\n {8}result: ''/)
})

test('the stop button exists only while the agent is running', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

  // The button ships hidden and JS drives it off the console's running state.
  assert.match(html, /id="hx-stop"[^>]*hidden/)
  assert.match(harness, /stop\.hidden = !state\.running/)

  // `.hx-btn.hx-icon` sets `display: inline-flex`, which beats the UA `[hidden]` default and
  // would hold a dead square next to Send while the agent is idle.
  assert.match(css, /\.hx-btn\.hx-icon\[hidden\] \{\s*display: none;/)
})

test('the transcript renders Markdown: headings, tables, lists and code', () => {
  // The same fold-guard style: the renderer is line grammar the port must keep. Every rule
  // here names a construct a model answers with and a plain <br> wall would flatten.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

  // Escaping happens in renderInline, on each leaf, before any tag is written.
  assert.match(harness, /function renderInline\(raw\)/)
  assert.match(harness, /<code class="hx-inline-code">\$1<\/code>/)
  assert.ok(harness.includes('(https?:\\/\\/[^)\\s]+)'), 'links only match http(s) URLs')

  // Fenced code keeps its language tag out of the body: the fence's info string is the
  // first line, and the code starts after the newline that ends it.
  assert.match(harness, /const nl = chunk\.indexOf\('\\n'\)/)
  assert.match(harness, /const body = nl >= 0 \? chunk\.slice\(nl \+ 1\) : ''/)

  // The stylesheet owns how the rendered constructs look.
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  for (const rule of ['.hx-h1', '.hx-table', '.hx-list', '.hx-quote', '.hx-hr', '.hx-link']) {
    assert.match(css, new RegExp(rule.replace('.', '\\.')))
  }
})

test('the console configures Pi with the router as its only provider', () => {
  const config = hammerModelsConfig('http://127.0.0.1:7352/v1')
  const provider = config.providers[HAMMER_PROVIDER]
  assert.equal(provider.baseUrl, 'http://127.0.0.1:7352/v1')
  assert.equal(provider.api, 'openai-completions')
  // The model is Hammer's alias, not a named model: a named one would pin the agent to it and
  // take it off the router's selection the moment that selection changed.
  assert.deepEqual(
    provider.models.map((model) => model.id),
    [HAMMER_MODEL],
  )
  // Pi only emits thinking blocks when the model advertises reasoning, and only sends a level
  // when the endpoint can express one; without both, `pi.thinking` is silently ignored.
  assert.equal(provider.models[0].reasoning, true)
  assert.equal(provider.compat.supportsReasoningEffort, true)
  assert.ok(provider.models[0].contextWindow > 0, 'Pi plans compaction against a window')
  assert.ok(provider.models[0].maxTokens > 0, 'and asks for an output budget')
})

test('the Pi settings block is optional, and the environment wins over the file', () => {
  const defaults = normalizePiSettings({})
  assert.equal(defaults.command, 'auto')
  assert.equal(defaults.node, 'auto')
  assert.equal(defaults.provider, null)
  assert.equal(defaults.model, null)
  assert.deepEqual(defaults.extraArgs, [])
  assert.ok(defaults.workspace.endsWith('Hammer'), 'the agent works in this install by default')
  assert.match(defaults.sessions, /session/)

  const configured = normalizePiSettings({
    command: '/opt/pi/bin/pi',
    node: '/opt/node22/bin/node',
    provider: 'google',
    model: 'gemini',
    thinking: 'low',
    extraArgs: ['--no-extensions', 42],
    workspace: '/tmp/work',
    sessions: 'sess',
  })
  assert.equal(configured.command, '/opt/pi/bin/pi')
  assert.equal(configured.node, '/opt/node22/bin/node')
  assert.equal(configured.thinking, 'low')
  assert.deepEqual(
    configured.extraArgs,
    ['--no-extensions'],
    'a non-string is dropped, not passed to a child',
  )
  assert.equal(configured.workspace, '/tmp/work')

  // A test or a container has to be able to point the console somewhere without rewriting
  // the user's config, so the environment is the outer layer.
  const env = normalizePiSettings(
    { command: '/opt/pi/bin/pi', workspace: '/tmp/work' },
    { HAMMER_PI_COMMAND: '/env/pi', HAMMER_PI_WORKSPACE: '/tmp/env-work' },
  )
  assert.equal(env.command, '/env/pi')
  assert.equal(env.workspace, '/tmp/env-work')

  // The `pi` block has to survive config normalization, or it is silently lost on every save.
  const normalized = normalizeConfigShape({ pi: { provider: 'google', model: 'gemini' } })
  assert.deepEqual(normalized.pi, { provider: 'google', model: 'gemini' })
  assert.equal(readPiSettings({ pi: { model: 'gemini' } }).model, 'gemini')
})

test('a workspace that is a file is never a cwd, because spawn fails with ENOTDIR', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-cwd-'))
  const archive = join(root, 'app.asar')
  writeFileSync(archive, '')

  // This is the packaged app's shape: the install root is the asar archive itself. A file cannot be
  // a working directory, and the failure blames the command, which looks like a broken interpreter.
  const notes = []
  assert.equal(usableWorkspace(archive, notes), homedir())
  assert.match(notes[0], /is not a directory/)
  assert.equal(usableWorkspace(root), root, 'a real directory is passed through untouched')
  assert.equal(usableWorkspace(join(root, 'missing')), homedir(), 'so is a missing one')
})

test('the harness directories are created, and a config alone never makes a workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-dirs-'))
  const created = ensureHarnessDirs({
    sessions: join(root, 'sessions'),
    agentRoot: join(root, 'agent'),
  })
  assert.ok(readdirSync(created.sessions))
  assert.ok(readdirSync(created.agentRoot))
})

test('the launch plan routes through Hammer unless a model or a brain was named', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-launch-'))
  const settings = normalizePiSettings({}) // the shipped defaults
  const agentRoot = join(root, 'agent')

  const routed = planPiLaunch(
    { ...settings, agentRoot, command: process.execPath, node: process.execPath },
    { baseUrl: 'http://127.0.0.1:7352/v1' },
  )
  assert.equal(routed.routed, true)
  assert.equal(routed.error, null)
  assert.deepEqual(routed.args.slice(-4), ['--provider', HAMMER_PROVIDER, '--model', HAMMER_MODEL])
  assert.match(routed.env.PI_CODING_AGENT_DIR, /7352$/, 'one agent directory per router port')

  // Naming a model is a deliberate step off the router's selection.
  const named = planPiLaunch(
    {
      ...settings,
      agentRoot,
      command: process.execPath,
      node: process.execPath,
      provider: 'google',
      model: 'g',
    },
    { baseUrl: 'http://127.0.0.1:7352/v1' },
  )
  assert.equal(named.routed, false)
  assert.deepEqual(named.args.slice(-4), ['--provider', 'google', '--model', 'g'])
  assert.deepEqual(named.env, {})

  // A replacement brain speaks the protocol itself; pi and its flags do not apply to it.
  const brain = planPiLaunch({
    ...settings,
    agentRoot,
    brain: { command: '/usr/bin/other-agent', args: ['--rpc'] },
  })
  assert.equal(brain.command, '/usr/bin/other-agent')
  assert.deepEqual(brain.args, ['--rpc'])
  assert.equal(brain.routed, false)
})

test('a pi that cannot run is reported with the reason, not launched blindly', () => {
  const settings = normalizePiSettings({ command: '/nonexistent/pi', node: process.execPath })
  const runtime = resolvePiRuntime(settings)
  assert.equal(runtime.entrypoint, null)
  assert.match(runtime.notes.join(' '), /could not be resolved/)

  const plan = planPiLaunch(settings)
  assert.equal(plan.command, null)
  assert.match(String(plan.error), /Could not find a runnable pi/)
})

test('with no system Node, a packaged app runs pi on the Node inside Electron', () => {
  // Stand in for the desktop build: process.execPath is Hammer's Electron binary, not a plain
  // node. Overridden only inside this synchronous test, and always restored.
  Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true })
  try {
    assert.equal(isAppBinary(process.execPath), true)
    // Probed as Node it reports a version instead of relaunching the app into a deadlock.
    assert.ok(nodeMajor(process.execPath) >= MIN_NODE_MAJOR)

    const root = mkdtempSync(join(tmpdir(), 'hammer-pi-electron-'))
    const plan = planPiLaunch(normalizePiSettings({ command: process.execPath }), {
      baseUrl: 'http://127.0.0.1:7352/v1',
      agentDir: join(root, 'agent'),
    })
    assert.equal(plan.error, null)
    assert.equal(plan.node, process.execPath)
    assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1', 'the child is told to behave as Node')
    assert.equal(
      plan.env.PI_CODING_AGENT_DIR,
      join(root, 'agent'),
      'the routing env survives the flag',
    )
    assert.match(plan.notes.join(' '), /Node inside Hammer/)
  } finally {
    delete process.versions.electron
  }
})

test('preparing the agent directory writes the configuration and keeps instances apart', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-dir-'))
  const agentDir = join(root, 'agent')
  const prepared = prepareHammerAgentDir({ baseUrl: 'http://127.0.0.1:7352/v1', agentDir })

  assert.deepEqual(prepared.args, ['--provider', HAMMER_PROVIDER, '--model', HAMMER_MODEL])
  assert.deepEqual(prepared.env, { PI_CODING_AGENT_DIR: agentDir })
  const written = JSON.parse(readFileSync(prepared.modelsPath, 'utf8'))
  assert.equal(written.providers.hammer.baseUrl, 'http://127.0.0.1:7352/v1')

  // A restart rewrites nothing when the endpoint has not moved.
  const again = prepareHammerAgentDir({ baseUrl: 'http://127.0.0.1:7352/v1', agentDir })
  assert.equal(readFileSync(again.modelsPath, 'utf8'), readFileSync(prepared.modelsPath, 'utf8'))

  // Two routers must not share one file, or the second start repoints the first instance's Pi.
  assert.notEqual(
    defaultAgentDirFor('http://127.0.0.1:7352/v1'),
    defaultAgentDirFor('http://127.0.0.1:7353/v1'),
  )
  assert.match(defaultAgentDirFor('http://127.0.0.1:7352/v1'), /7352$/)
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
    this.sessionFile = null
    this.streaming = false
  }
  status() {
    return {
      available: this.available,
      running: true,
      command: 'pi',
      cwd: '/project',
      model: { id: 'stub-model', provider: 'stub' },
      thinkingLevel: 'off',
      isStreaming: this.streaming,
      sessionId: 's1',
      sessionFile: this.sessionFile,
      error: null,
      stderr: '',
      events: 1,
    }
  }
  history() {
    return [{ type: 'agent_start' }]
  }
  addNote() {}
  async describe() {
    if (!this.available) throw new Error('`pi` is not installed or not on PATH.')
    return { model: { id: 'stub-model', provider: 'stub' }, sessionId: 's1' }
  }
  async switchSession(sessionPath) {
    if (this.streaming) throw new Error('Pi is busy; it cannot switch sessions right now.')
    this.calls.push(['switchSession', sessionPath])
    this.sessionFile = sessionPath
    return { data: { cancelled: this.cancelled } }
  }
  async restartTo(sessionPath) {
    this.calls.push(['restartTo', sessionPath])
    this.sessionFile = sessionPath
    return this.status()
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
  async restart() {
    this.calls.push(['restart'])
    return this.status()
  }
  async runCommand(type) {
    if (!new Set(['get_state', 'set_model', 'get_messages']).has(type))
      throw new Error(`Command not allowed: ${type}`)
    this.calls.push(['command', type])
    if (type === 'get_messages')
      return {
        data: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi again' }] }] },
      }
    return { data: { type } }
  }
  dispose() {}
}

/** Mounts the routes with the given seed and hands the test the base URL. */
async function withPiApp(ctx, run) {
  const app = express()
  app.use(express.json())
  const bridge = registerPiRoutes(app, ctx)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  try {
    return await run(`http://127.0.0.1:${address.port}`, bridge)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    bridge.dispose()
  }
}

test('the status route describes the agent, including why it is unavailable', async () => {
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge }, async (base) => {
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
  await withPiApp({ piBridge: bridge }, async (base) => {
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
  await withPiApp({ piBridge: bridge }, async (base) => {
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
  await withPiApp({ piBridge: bridge }, async (base) => {
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

    bridge.emit('status', { phase: 'busy', tokens: 12, cost: 0.5 })
    const statusFrame = await frame()
    assert.equal(statusFrame.type, 'status')
    assert.deepEqual(statusFrame.status, {
      phase: 'busy',
      tokens: 12,
      cost: 0.5,
      routedModel: null,
    })

    bridge.emit('usage', { tokens: 34, cost: 0.75 })
    assert.deepEqual(await frame(), { type: 'usage', tokens: 34, cost: 0.75 })

    bridge.emit('log', { level: 'stderr', text: 'warning: no network' })
    assert.deepEqual(await frame(), {
      type: 'log',
      level: 'stderr',
      text: 'warning: no network',
    })

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

test('one page stream carries every console and names the one each frame belongs to', async () => {
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge }, async (base) => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/pi/consoles/events`, { signal: controller.signal })
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
    assert.deepEqual(
      hello.consoles.map((entry) => entry.id),
      ['main'],
      'the main console opens on the same stream as the parallel ones',
    )
    assert.equal(hello.consoles[0].status.model.id, 'stub-model')

    bridge.emit('event', { type: 'agent_start' })
    assert.deepEqual(await frame(), {
      consoleId: 'main',
      type: 'event',
      record: { type: 'agent_start' },
    })

    controller.abort()
  })
})

test('restart and the allowlisted command passthrough reach the agent and report failures', async () => {
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge }, async (base) => {
    const restarted = await fetch(`${base}/api/pi/restart`, { method: 'POST' })
    assert.equal(restarted.status, 200)
    assert.equal((await restarted.json()).status.model.id, 'stub-model')

    const blocked = await fetch(`${base}/api/pi/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'rm -rf /' }),
    })
    assert.equal(blocked.status, 400, "a command outside the allowlist is the caller's mistake")
    assert.match((await blocked.json()).error, /not allowed/)
    assert.deepEqual(bridge.calls, [['restart']])
  })
})

test("a configuration that cannot be written refuses the agent rather than using Pi's own model", async () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-bad-'))
  const occupied = join(root, 'not-a-directory')
  writeFileSync(occupied, 'x')
  await withPiApp(
    {
      piCommand: process.execPath,
      piArgs: [FAKE_PI],
      piCwd: tmpdir(),
      piBaseUrl: 'http://127.0.0.1:7352/v1',
      piAgentDir: join(occupied, 'agent'),
    },
    async (base) => {
      const status = await (await fetch(`${base}/api/pi/status`)).json()
      assert.match(status.error, /Could not write the Pi configuration/)
      assert.equal(status.routed, false)

      const res = await fetch(`${base}/api/pi/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })
      assert.equal(res.status, 503)
      assert.match((await res.json()).error, /Could not write the Pi configuration/)
    },
  )
})

test('the console runs Pi on the router-directed configuration when it is given the base', async () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), 'hammer-pi-agent-')), 'agent')
  await withPiApp(
    {
      piCommand: process.execPath,
      piArgs: [FAKE_PI],
      piCwd: tmpdir(),
      piBaseUrl: 'http://127.0.0.1:7352/v1',
      piAgentDir: agentDir,
    },
    async (base) => {
      const body = await (await fetch(`${base}/api/pi/status`)).json()
      assert.equal(
        body.session.agentDir,
        agentDir,
        'the child inherited the Hammer-owned config directory',
      )
      const written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
      assert.equal(written.providers.hammer.baseUrl, 'http://127.0.0.1:7352/v1')
    },
  )
})

// ── The session store: listing, resuming, and parallel consoles ───────────────────────────

/** Writes one valid session file and returns its path. */
function writeSessionFile(dir, name, id, userText) {
  const file = join(dir, name)
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-02-01T10:00:00.000Z',
      cwd: '/proj',
    }),
    JSON.stringify({ type: 'session_info', id, name: null }),
    JSON.stringify({
      type: 'message',
      id: `${id}-m1`,
      parentId: null,
      timestamp: '2026-02-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    }),
    JSON.stringify({
      type: 'message',
      id: `${id}-m2`,
      parentId: `${id}-m1`,
      timestamp: '2026-02-01T10:00:02.000Z',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    }),
  ]
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

test('the store lists saved sessions with summaries and the current file', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  const current = writeSessionFile(
    store,
    'a.jsonl',
    '11111111-1111-4111-8111-111111111111',
    'first conversation',
  )
  writeSessionFile(store, 'b.jsonl', '22222222-2222-4222-8222-222222222222', 'second conversation')
  const bridge = new StubBridge()
  bridge.sessionFile = current
  await withPiApp({ piBridge: bridge, piSessionsDir: store }, async (base) => {
    const data = await (await fetch(`${base}/api/pi/sessions`)).json()
    assert.equal(data.current, current)
    assert.equal(data.sessions.length, 2)
    const names = data.sessions.map((s) => s.fileName).sort()
    assert.deepEqual(names, ['a.jsonl', 'b.jsonl'])
    const a = data.sessions.find((s) => s.fileName === 'a.jsonl')
    assert.equal(a.sessionId, '11111111-1111-4111-8111-111111111111')
    assert.equal(a.userMessages, 1)
    assert.equal(a.assistantMessages, 1)
    assert.match(a.preview, /first conversation/)
    assert.ok(a.label, 'every row carries a human label')
  })
})

test('a session can be resumed in place and the transcript read back', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  const target = writeSessionFile(
    store,
    'target.jsonl',
    '33333333-3333-4333-8333-333333333333',
    'resume me',
  )
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge, piSessionsDir: store }, async (base) => {
    const opened = await fetch(`${base}/api/pi/sessions/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: '33333333' }),
    })
    assert.deepEqual(await opened.json(), { success: true, mode: 'switched', sessionFile: target })
    assert.deepEqual(bridge.calls[0], ['switchSession', target])

    const messages = await (await fetch(`${base}/api/pi/messages`)).json()
    assert.equal(messages.success, true)
    assert.equal(messages.messages[0].role, 'user')
  })
})

test('a streaming console resumes by restarting; a busy switch is refused in place', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  const target = writeSessionFile(
    store,
    'busy.jsonl',
    '44444444-4444-4444-8444-444444444444',
    'busy one',
  )
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge, piSessionsDir: store }, async (base) => {
    bridge.streaming = true
    const opened = await fetch(`${base}/api/pi/sessions/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: target }),
    })
    assert.equal((await opened.json()).mode, 'restarted')
    assert.deepEqual(bridge.calls[0], ['restartTo', target])
  })
})

test('sessions/open validates its input: unknown sessions and escapes are refused', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  writeSessionFile(store, 'known.jsonl', '55555555-5555-4555-8555-555555555555', 'known')
  const bridge = new StubBridge()
  await withPiApp({ piBridge: bridge, piSessionsDir: store }, async (base) => {
    const open = (body) =>
      fetch(`${base}/api/pi/sessions/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const empty = await open({ session: '   ' })
    assert.equal(empty.status, 400)

    const unknown = await open({ session: '99999999' })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /No session/)

    const escape = await open({ session: '../../etc/passwd' })
    assert.equal(escape.status, 400)
    assert.match((await escape.json()).error, /session store/)

    assert.equal(bridge.calls.length, 0, 'nothing reached the agent')
  })
})

test('a parallel console is a second bridge with its own routes, and can be closed', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  const target = writeSessionFile(
    store,
    'parallel.jsonl',
    '66666666-6666-4666-8666-666666666666',
    'parallel',
  )
  await withPiApp(
    {
      piCommand: process.execPath,
      piArgs: [FAKE_PI],
      piCwd: tmpdir(),
      piSessionsDir: store,
    },
    async (base) => {
      const created = await fetch(`${base}/api/pi/instances`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: '66666666' }),
      })
      const body = await created.json()
      assert.equal(body.success, true)
      assert.match(body.id, /^[a-z0-9-]+$/)
      assert.equal(body.instance.sessionFile, target)

      const status = await (
        await fetch(`${base}/api/pi/instances/${body.id}/console/status`)
      ).json()
      assert.equal(status.available, true)

      const closed = await fetch(`${base}/api/pi/instances/${body.id}/close`, { method: 'POST' })
      assert.equal((await closed.json()).success, true)
      const gone = await fetch(`${base}/api/pi/instances/${body.id}/console/status`)
      assert.equal(gone.status, 404)
    },
  )
})

test('parallel consoles are not artificially capped, and a fresh scratch console opens without a session', async () => {
  await withPiApp(
    {
      piCommand: process.execPath,
      piArgs: [FAKE_PI],
      piCwd: tmpdir(),
    },
    async (base) => {
      const scratch = await fetch(`${base}/api/pi/instances`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await scratch.json()
      assert.equal(body.success, true)
      assert.equal(body.instance.sessionFile, null)

      // Opening conversations must not hit a ceiling. The page cannot free a console it does
      // not know about, so a bounded pool used to refuse the next tab with 429 and leave the
      // button looking dead. Every request here has to succeed.
      const ids = [body.id]
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/api/pi/instances`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        assert.equal(res.status, 200)
        ids.push((await res.json()).id)
      }
      // Every console created here owns a child process; leaving any of them running keeps
      // this test's event loop (and the fake agents) alive after the assertions.
      for (const id of ids) {
        await fetch(`${base}/api/pi/instances/${id}/close`, { method: 'POST' })
      }
    },
  )
})

test('a queued follow-up runs as its own turn once the current one settles', async () => {
  const { bridge } = makeFake()
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '800' }, async () => {
      const firstSettled = nextEvent(bridge, 'agent_settled')
      await bridge.prompt('first turn')

      // Both queues take a message while the first turn runs.
      const steered = await bridge.prompt('steer mid-run')
      const held = await bridge.prompt('follow up', { queueMode: 'followUp' })
      assert.equal(steered.data.disposition, 'queued')
      assert.equal(held.data.disposition, 'queued')

      // Pi's own accounting reaches the status the page renders.
      await waitFor(() => bridge.status().queuedSteering.includes('steer mid-run'))
      await waitFor(() => bridge.status().queuedFollowUp.includes('follow up'))
      assert.equal(bridge.status().pendingMessages, 2)

      // The first turn settles; the held message starts as a turn of its own and then settles.
      await firstSettled
      await waitFor(() => !bridge.status().isStreaming, { timeoutMs: 4_000 })
      await waitFor(() => bridge.status().pendingMessages === 0)
      assert.equal(bridge.status().queuedFollowUp.length, 0)
    })
  } finally {
    bridge.dispose()
  }
})

test('stopping reports the queued messages it dropped', async () => {
  const { bridge } = makeFake()
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '800' }, async () => {
      await bridge.prompt('long turn')
      await bridge.prompt('steer mid-run')
      await bridge.prompt('held for later', { queueMode: 'followUp' })
      await waitFor(() => bridge.status().pendingMessages === 2)

      const record = await bridge.abort()
      assert.deepEqual(record.clearedQueue, {
        steering: ['steer mid-run'],
        followUp: ['held for later'],
      })
      assert.equal(bridge.status().pendingMessages, 0)
    })
  } finally {
    bridge.dispose()
  }
})

test('a queue_update empties when pi consumes what it was holding', async () => {
  // The authority runs one way: whatever pi says the queue holds is what the bridge holds,
  // including the empty list after the agent has taken the messages back out.
  const { bridge } = makeFake({})
  try {
    await withEnv({ FAKE_PI_SETTLE_DELAY_MS: '200' }, async () => {
      await bridge.prompt('turn one')
      await bridge.prompt('held', { queueMode: 'followUp' })
      await waitFor(() => bridge.status().pendingMessages === 1)
      await waitFor(() => bridge.status().pendingMessages === 0, { timeoutMs: 6_000 })
    })
  } finally {
    bridge.dispose()
  }
})

test('a send can never leave the composer stuck on Sending…', () => {
  // Two ways this used to wedge: the prompt had no deadline, so a socket the OS held open kept
  // `sending` true for the life of the page; and the flag and the hint were page-wide, so one
  // conversation's slow send disabled every other composer and left its hint over them.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

  assert.match(harness, /const PROMPT_TIMEOUT_MS = 35_000/)
  assert.match(harness, /setTimeout\(\(\) => control\.abort\(\), PROMPT_TIMEOUT_MS\)/)
  assert.match(harness, /signal: control\.signal/)
  assert.match(harness, /clearTimeout\(timer\)/)

  // The flag is per conversation; the hint names the one it belongs to.
  assert.match(harness, /console\.sending = true/)
  assert.match(harness, /console\.sending = false/)
  assert.match(harness, /setHint\([^)]*, console\)/)
})

test('the transcript renders Markdown: headings, tables, lists and code', () => {
  // The same fold-guard style: the renderer is line grammar the port must keep. Every rule
  // here names a construct a model answers with and a plain <br> wall would flatten.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

  // Escaping happens in renderInline, on each leaf, before any tag is written.
  assert.match(harness, /function renderInline\(raw\)/)
  assert.match(harness, /<code class="hx-inline-code">\$1<\/code>/)
  assert.ok(harness.includes('(https?:\\/\\/[^)\\s]+)'), 'links only match http(s) URLs')

  // Fenced code keeps its language tag out of the body: the fence's info string is the
  // first line, and the code starts after the newline that ends it.
  assert.match(harness, /const nl = chunk\.indexOf\('\\n'\)/)
  assert.match(harness, /const body = nl >= 0 \? chunk\.slice\(nl \+ 1\) : ''/)

  // The stylesheet owns how the rendered constructs look.
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  for (const rule of ['.hx-h1', '.hx-table', '.hx-list', '.hx-quote', '.hx-hr', '.hx-link']) {
    assert.match(css, new RegExp(rule.replace('.', '\\.')))
  }
})

test('images attach to a prompt via the paperclip or a drop on the composer', () => {
  // Two ways in, one staged strip: the paperclip opens the file input, and a file dragged
  // anywhere on the composer lands in the same place. The send path is the only thing that
  // clears the strip, and it puts the images back if the send fails.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

  assert.match(html, /id="hx-attach"/)
  assert.match(html, /id="hx-file"[^>]*accept="image\/png,image\/jpeg,image\/gif,image\/webp"/)
  assert.match(html, /id="hx-attachments"/)
  assert.match(harness, /function addAttachments\(files\)/)
  assert.match(harness, /function renderAttachments\(\)/)
  assert.match(harness, /function wireComposerDrop\(\)/)
  assert.match(harness, /\$\('hx-attach'\)\?\.addEventListener\('click'/)
  assert.match(harness, /images: images\.length \? images : undefined/)
  assert.match(css, /\.hx-attachment/)
  assert.match(css, /\.hx-composer\.hx-dropping/)
})

test('a session renamed before can be renamed again, chaining to the newest leaf', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-sessions-'))
  const target = join(store, 'bbbbbbbb.jsonl')
  writeFileSync(
    target,
    `${JSON.stringify({ type: 'session', id: 'bbbbbbbb', cwd: store, timestamp: '2026-02-01T10:00:00.000Z' })}\n`,
  )
  appendFileSync(
    target,
    `${JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-02-01T10:01:00.000Z' })}\n`,
  )
  appendFileSync(
    target,
    `${JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-02-01T10:02:00.000Z' })}\n`,
  )
  appendFileSync(
    target,
    `${JSON.stringify({ type: 'session_info', id: 'pre-name', parentId: null, timestamp: '2026-02-01T10:05:00.000Z', name: 'First name' })}\n`,
  )
  await withPiApp({ piSessionsDir: store }, async (base) => {
    const renamed = await fetch(`${base}/api/pi/sessions/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'bbbbbbbb', name: 'Second name' }),
    })
    const data = await renamed.json()
    assert.equal(data.success, true)
    assert.equal(data.label, 'Second name')
    const last = readFileSync(target, 'utf8').trimEnd().split('\n').pop()
    assert.equal(JSON.parse(last).name, 'Second name')
    assert.equal(JSON.parse(last).parentId, 'pre-name', 'the entry chains to the renamed leaf')
  })
})

test('images are attached to a prompt and sent to Pi', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    const sent = []
    bridge.send = async (command) => {
      sent.push(command)
      return { data: { disposition: 'queued' } }
    }
    bridge.state.isStreaming = true

    const imgData =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AApEBGZxU5iQAAAABJRU5ErkJggg=='
    const images = [
      { type: 'image', data: imgData, mimeType: 'image/png' },
      { type: 'image', data: imgData, mimeType: 'image/png' },
    ]

    const record = await bridge.prompt('Look at this', { images })
    assert.deepEqual(sent, [
      {
        type: 'prompt',
        message: 'Look at this',
        streamingBehavior: 'steer',
        images: [
          { type: 'image', data: imgData, mimeType: 'image/png' },
          { type: 'image', data: imgData, mimeType: 'image/png' },
        ],
      },
    ])
    assert.equal(record.data.disposition, 'queued')
    assert.equal(bridge.state.isStreaming, true)
  } finally {
    bridge.dispose()
  }
})

test('an image attach that is not valid base64 is refused, not sent', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    let called = 0
    bridge.send = async () => {
      called += 1
      return { data: { disposition: 'started' } }
    }
    await assert.rejects(
      () => bridge.prompt('look', { images: [{ data: 'not base64!!!', mimeType: 'image/png' }] }),
      /base64/,
    )
    assert.equal(called, 0, 'nothing reaches Pi when an attachment is malformed')
  } finally {
    bridge.dispose()
  }
})

/** Drives one failed turn through the bridge's event tracker, the way Pi reports it. */
function endFailedTurn(bridge, errorMessage) {
  bridge.track({
    type: 'agent_end',
    willRetry: false,
    // The real child reports the whole run; the failing assistant message is the last one.
    messages: [
      { role: 'user', content: [] },
      { role: 'assistant', stopReason: 'error', errorMessage },
    ],
  })
  bridge.track({ type: 'agent_settled' })
}

test('a dropped turn is continued once Pi has settled', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1, autoContinueLimit: 3 })
  try {
    /** @type {Array<{ message: string, options: any }>} */
    const prompts = []
    bridge.prompt = async (message, options) => {
      prompts.push({ message, options })
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endFailedTurn(bridge, 'socket hang up')

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0].message, /Repeat your last action/)
    assert.equal(prompts[0].options.queueMode, 'followUp')
    assert.match(bridge.status().notes.join('\n'), /Retrying after a transport failure/)
  } finally {
    bridge.dispose()
  }
})

test('the continuation budget spans failed turns and stops at the limit', async () => {
  // Settling is not completion: resetting here would make the advertised budget of three
  // spendable forever, which is the endless retry the limit exists to prevent.
  const bridge = new PiBridge({ autoContinueBaseMs: 1, autoContinueLimit: 3 })
  try {
    const prompts = []
    bridge.prompt = async (...args) => {
      prompts.push(args)
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    for (let failure = 1; failure <= 4; failure += 1) {
      endFailedTurn(bridge, 'connection reset')
      if (failure <= 3) {
        await waitFor(() => prompts.length === failure)
      } else {
        await waitFor(() =>
          bridge.status().notes.some((note) => note.startsWith('Stopped retrying after 3')),
        )
      }
    }

    assert.equal(prompts.length, 3)
  } finally {
    bridge.dispose()
  }
})

test('a completed turn restores the continuation budget', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1, autoContinueLimit: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endFailedTurn(bridge, 'connection reset')
    await waitFor(() => prompts === 1)

    // A healthy turn in between is what hands the budget back; a run shortened by an
    // earlier failure would stop after the second one.
    bridge.track({
      type: 'agent_end',
      willRetry: false,
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    })
    bridge.track({ type: 'agent_settled' })
    endFailedTurn(bridge, 'connection reset')

    await waitFor(() => prompts === 2)
  } finally {
    bridge.dispose()
  }
})

test('a turn Pi will retry, or a verdict, is not continued', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.track({
      type: 'agent_end',
      willRetry: true,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'socket hang up' }],
    })
    bridge.track({ type: 'agent_settled' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    bridge.track({
      type: 'agent_end',
      willRetry: false,
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'insufficient_quota: You exceeded your current quota.',
        },
      ],
    })
    bridge.track({ type: 'agent_settled' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('stopping during the backoff cancels the continuation', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 50 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.send = async () => ({ data: {} })
    bridge.syncUsageFromSession = async () => {}

    endFailedTurn(bridge, 'connection reset')
    assert.notEqual(bridge.continueTimer, null, 'the continuation is waiting out its backoff')

    await bridge.abort()
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(prompts, 0, 'a deliberate Stop is not followed by the queued continuation')
  } finally {
    bridge.dispose()
  }
})
