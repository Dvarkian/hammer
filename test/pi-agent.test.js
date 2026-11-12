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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { PiBridge } from '../lib/pi/bridge.js'
import {
  HAMMER_MODEL,
  HAMMER_PROVIDER,
  compactionSettingsForFile,
  defaultAgentDirFor,
  hammerCompactionSettings,
  hammerModelsConfig,
  PI_COMPACTION_DEFAULTS,
  prepareHammerAgentDir,
} from '../lib/pi/agent-dir.js'
import { registerPiRoutes, shouldCompactBeforePrompt } from '../lib/http/routes/pi.js'
import { consoleSessionFile, resetConsoleSessionsForTests } from '../lib/pi/console-session.js'
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

test('a restarted router reopens the conversation its console was on', async () => {
  // The reported failure: a restart sometimes came back to an empty conversation while the
  // transcript sat on disk, because a console started a brand-new session whenever the keeper
  // no longer owned the previous agent. The file it was on is remembered instead.
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-resume-'))
  const sessions = join(root, 'sessions')
  const state = join(root, 'state')
  mkdirSync(sessions, { recursive: true })
  mkdirSync(state, { recursive: true })
  const sessionFile = join(sessions, '2026-01-01T00-00-00-000Z_sess-resume.jsonl')
  writeFileSync(sessionFile, '')
  const store = join(state, 'console-sessions.json')
  resetConsoleSessionsForTests()

  const ctx = {
    piCommand: process.execPath,
    piArgs: [FAKE_PI],
    piCwd: sessions,
    piSessionsDir: sessions,
    piStateDir: state,
    piBaseUrl: 'http://127.0.0.1:7352/v1',
    piAgentDir: join(root, 'agent'),
    routedSelection: () => null,
  }

  // The first router starts on a fresh conversation and the agent names the file it opened.
  await withEnv({ FAKE_PI_SESSION_FILE: sessionFile }, async () => {
    await withPiApp(ctx, async (base) => {
      const status = await (await fetch(`${base}/api/pi/status`)).json()
      assert.equal(status.sessionFile, sessionFile)
    })
  })
  assert.equal(consoleSessionFile('7352'), sessionFile, 'the console remembers its conversation')
  assert.match(readFileSync(store, 'utf8'), /consoleSessions/)

  // A restart is this module's memory going away while the file it wrote stays behind.
  resetConsoleSessionsForTests()

  // No FAKE_PI_SESSION_FILE this time: the store is the only way the console can know the file,
  // and the fake reports whatever `--session` it was launched with.
  await withPiApp(ctx, async (base) => {
    const status = await (await fetch(`${base}/api/pi/status`)).json()
    assert.equal(status.sessionFile, sessionFile, 'the console reopened its own conversation')
  })
  resetConsoleSessionsForTests()
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
  // Thinking is a disclosure on the spine: a station with its own mark, open while it is being
  // written and folded as soon as the model moves on — prose, a tool call, or the message's end.
  assert.match(harness, /<details class="hx-thinking \$\{complete \? 'settled' : 'running'\}"/)
  assert.match(harness, /function thinkingIcon\(\)/)
  assert.match(harness, /class="hx-thinking-icon"/)
  assert.match(harness, /const open = block\.open \?\? !complete/)
  assert.match(harness, /item\.settled = true/)
  // A settled head states what the thought cost, and the reasoning figure comes from the
  // message's own usage rather than an estimate: "Thought for 10s · 1.5k tokens."
  assert.match(harness, /function thinkingLabel\(block, settled\)/)
  assert.match(
    harness,
    /parts\.push\(`Thought for \$\{Math\.max\(1, Math\.round\(ms \/ 1000\)\)\}s`\)/,
  )
  assert.match(harness, /assignThinkingStats\(item, message\.usage\?\.reasoning\)/)
  // The numbers outlive the page that measured them: the duration and the token figure are
  // remembered by message timestamp and put back when the transcript is rebuilt.
  assert.match(harness, /rememberThoughtStats\(ctx, message, item\.blocks\)/)
  assert.match(harness, /applyRememberedThoughtStats\(ctx, message, blocks\)/)
  // A provider that reports no reasoning count still gets a figure, marked as an estimate.
  assert.match(harness, /block\.tokensEstimated = true/)
  assert.match(harness, /block\.tokensEstimated \? `~\$\{tokens\}` : tokens/)
  assert.match(harness, /k tokens/)

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
  // An edit shows its change as a colour-coded diff built from the call's own oldText/newText,
  // not the tool's "edited" sentence.
  assert.match(harness, /function diffMarkup\(item\)/)
  assert.match(harness, /hx-diff-row \$\{row\.op\}/)
  assert.match(harness, /const isEdit = \/\^edit\$\/i\.test\(String\(item\.name \|\| ''\)\)/)
  // Collapsed by default: an edit never opens itself, even while it runs. Only the reader's
  // own toggle (item.open) expands it.
  assert.match(
    harness,
    // A finished call folds away whatever its verdict; only one still in flight stays open,
    // and a row the reader expanded by hand is theirs. Failures used to force theirs open.
    /const open =\s*body && \(item\.open \|\| item\.status === 'running' \|\| item\.status === 'preparing'\)/,
  )

  // A bash call is shown as RUN in the transcript; the tool's own name stays in the icon table.
  assert.match(harness, /function toolLabel\(name\)/)
  assert.match(harness, /=== 'bash' \? 'run'/)

  // A multi-line command must survive: toolSummary is what the head of the row shows, and it
  // must not flatten the whitespace or cap the length of what the model actually wrote. The
  // rail's accessible label still folds to one line, but that is the label's own choice.
  const summary = harness.slice(
    harness.indexOf('function toolSummary'),
    harness.indexOf('return String(raw)'),
  )
  assert.ok(!summary.includes('replace(/\\s+/g'), 'tool summaries keep newlines')
  assert.ok(!summary.includes('clip('), 'tool summaries are never trimmed')
  // A read with a window shows the range after the filename — start and end lines only, since
  // the line count is implied. A whole-file read keeps its bare path.
  assert.match(summary, /\^read\(\?:_files\)\?\$/)
  assert.match(summary, /\$\{args\.path\}:\$\{offset\}-\$\{offset \+ limit - 1\}/)

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
  // ...but it is not still running. A reopened session has no turn in flight, so the row says
  // interrupted unless this console really is mid-run.
  assert.match(harness, /status: ctx\.running \? 'running' : 'interrupted',\n {8}result: ''/)
})

test('a tool whose end never arrived is not left saying running', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

  // `tool_execution_start` and `tool_execution_end` are two records. A stop, a crashed or
  // replaced child, or a bounded replay log that ends on the start can separate them for good,
  // and the row then claims to be running forever. A tool cannot execute once its turn is over,
  // so every place a run stops being live settles the rows still open.
  assert.match(harness, /function settleOpenTools\(ctx = active\(\)\)/)
  assert.match(harness, /item\.status = 'interrupted'/)
  // The turn's own terminal events settle it, and so does a status frame that says idle.
  assert.match(harness, /case 'agent_settled':[\s\S]{0,400}?settleOpenTools\(ctx\)/)
  assert.match(harness, /case 'agent_end':[\s\S]{0,400}?settleOpenTools\(ctx\)/)
  assert.match(harness, /if \(!ctx\.running\) settleOpenTools\(ctx\)/)
  // A reopened session rebuilds from its file, so a call with no result is settled there too.
  assert.match(harness, /status: ctx\.running \? 'running' : 'interrupted'/)
  // The row reads as interrupted, quietly — not as a failure the command might not have caused.
  assert.match(harness, /if \(item\.status === 'interrupted'\) return 'interrupted'/)
  assert.match(css, /\.hx-tool\.interrupted \.hx-tool-icon \{/)
  assert.match(css, /\.hx-tool\.interrupted \.hx-tool-state \{/)
  assert.match(css, /\.hx-diff-row\.add \{[^}]*status-success/)
  assert.match(css, /\.hx-diff-row\.del \{[^}]*status-error/)
  // An expanded running tool pulses the rail below its icon with the same animation, so the
  // spine and the mark move as one piece of work.
  assert.match(
    css,
    /\.hx-row-tool:has\(\.hx-tool\.running\[open\]\)::before \{[^}]*animation: hx-pulse/,
  )
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

  // The compaction budgets are Hammer's answer to "how early should Pi start summarising".
  // They are unset by default: an unset budget lets Pi keep its own default, which is the
  // behaviour that survives a Pi upgrade — a written file would override whatever the new
  // release chose instead.
  assert.equal(defaults.compaction.enabled, true)
  assert.equal(defaults.compaction.reserveTokens, null)
  assert.equal(defaults.compaction.keepRecentTokens, null)

  const budgeted = normalizePiSettings({
    compaction: { reserveTokens: 32768, keepRecentTokens: 40000 },
  })
  assert.equal(budgeted.compaction.reserveTokens, 32768)
  assert.equal(budgeted.compaction.keepRecentTokens, 40000)

  // Bad numbers are dropped rather than written: a budget of 0 tells Pi to compact with no
  // room for its reply, and a float is a syntax error in a config, not a rounding hint.
  for (const bad of [0, -1, 1.5, '1024', NaN, Infinity, null]) {
    const dropped = normalizePiSettings({ compaction: { reserveTokens: bad } })
    assert.equal(dropped.compaction.reserveTokens, null, `${String(bad)} is not a budget`)
  }

  // A compaction block with no budgets is the same as no block: it writes nothing. The
  // `enabled: false` case is the one thing that must survive alone, because a Pi left to its
  // defaults compacts on its own whether or not the user wanted a growing context.
  const off = normalizePiSettings({ compaction: { enabled: false } })
  assert.equal(off.compaction.enabled, false)
  assert.equal(off.compaction.reserveTokens, null)
  assert.equal(hammerCompactionSettings(off.compaction)?.enabled, false)

  // ...and a block that names only budgets does not turn auto-compaction off by
  // accident: the file states `enabled`, and it states true.
  assert.equal(hammerCompactionSettings(budgeted.compaction).enabled, undefined)
  assert.equal(compactionSettingsForFile(budgeted.compaction).enabled, true)
  assert.equal(hammerCompactionSettings(defaults.compaction), null, 'no budgets, no file')

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

    // A pi entry point of its own, with no `node` beside it — the shape a packaged app sees.
    // Pointing `command` at process.execPath instead would look for a sibling `node` next to
    // the running interpreter, which is a different resolver branch (and one that finds a
    // system Node on a developer machine).
    const root = mkdtempSync(join(tmpdir(), 'hammer-pi-electron-'))
    const piEntry = join(root, 'pi')
    writeFileSync(piEntry, '#!/usr/bin/env node\n')
    const plan = planPiLaunch(normalizePiSettings({ command: piEntry }), {
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

test('the compaction budgets are Pi defaults until one is set, and the file follows', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-pi-compaction-'))
  const agentDir = join(root, 'agent')

  // No budgets means no settings file: Pi keeps its own defaults, and whatever those defaults
  // become in a later Pi release is what this install runs. A file written here would freeze
  // them to today's numbers for an install that never asked for anything.
  const plain = prepareHammerAgentDir({ baseUrl: 'http://127.0.0.1:7352/v1', agentDir })
  assert.ok(existsSync(plain.modelsPath), 'models.json is always written')
  assert.equal(existsSync(plain.settingsPath), false)
  assert.equal(hammerCompactionSettings(normalizePiSettings({}).compaction), null)

  // The defaults are the ones Pi itself ships, so a reader can see the number that a
  // compaction will be triggered at without opening Pi's source.
  assert.equal(PI_COMPACTION_DEFAULTS.reserveTokens, 16384)
  assert.equal(PI_COMPACTION_DEFAULTS.keepRecentTokens, 20000)
  assert.ok(PI_COMPACTION_DEFAULTS.reserveTokens > 0)

  // One budget set is enough to write the file; the rest fall back to Pi's own defaults
  // rather than being spelled out twice in two places that will disagree.
  const withOne = prepareHammerAgentDir({
    baseUrl: 'http://127.0.0.1:7352/v1',
    agentDir,
    compaction: { enabled: true, reserveTokens: 24576, keepRecentTokens: null },
  })
  const written = JSON.parse(readFileSync(withOne.settingsPath, 'utf8'))
  assert.equal(written.compaction.reserveTokens, 24576)
  assert.equal(
    written.compaction.keepRecentTokens,
    PI_COMPACTION_DEFAULTS.keepRecentTokens,
    'an unset budget inherits the Pi default rather than inventing one',
  )

  // Turning auto-compaction off is a budget in the same file. It is the one setting that
  // reaches Pi even with no numbers attached, because Pi's default is to compact on its own.
  const disabled = prepareHammerAgentDir({
    baseUrl: 'http://127.0.0.1:7352/v1',
    agentDir,
    compaction: { enabled: false, reserveTokens: null, keepRecentTokens: null },
  })
  const off = JSON.parse(readFileSync(disabled.settingsPath, 'utf8'))
  assert.equal(off.compaction.enabled, false)
  assert.equal(off.compaction.reserveTokens, PI_COMPACTION_DEFAULTS.reserveTokens)

  // Removing the budgets from the config removes the file, leaving Pi's own settings alone.
  // Writing an empty block instead would silently override a file the user wrote by hand.
  const cleared = prepareHammerAgentDir({
    baseUrl: 'http://127.0.0.1:7352/v1',
    agentDir,
    compaction: normalizePiSettings({}).compaction,
  })
  assert.equal(existsSync(cleared.settingsPath), false, 'the file is removed, not blanked')
  assert.ok(existsSync(cleared.modelsPath), 'models.json survives')
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
    this.running = true
  }
  status() {
    return {
      available: this.available,
      running: this.running,
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

test('a prompt compacts before sending when the routed model is at its request cap', async () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), 'hammer-pi-cap-')), 'agent')
  const bridge = new StubBridge()
  bridge.status = () => ({
    ...StubBridge.prototype.status.call(bridge),
    contextUsage: { tokens: 120000, contextWindow: 131072, percent: 91.6 },
    autoCompactionEnabled: true,
  })
  bridge.runCommand = async (type) => {
    bridge.calls.push(['command', type])
    return { data: { tokensBefore: 120000, estimatedTokensAfter: 20000 } }
  }
  await withPiApp(
    {
      piBridge: bridge,
      piCommand: process.execPath,
      piArgs: [FAKE_PI],
      piCwd: tmpdir(),
      piBaseUrl: 'http://127.0.0.1:7352/v1',
      piAgentDir: agentDir,
      routedSelection: () => ({
        modelId: 'orcarouter/free',
        providerKey: 'orcarouter',
        contextTokens: 122000,
      }),
    },
    async (base) => {
      const res = await fetch(`${base}/api/pi/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'keep going' }),
      })
      assert.equal(res.status, 200)
      assert.deepEqual(bridge.calls, [
        ['command', 'compact'],
        ['prompt', 'keep going'],
      ])
    },
  )
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

test('a restored transcript is read from its file before the bridge names it', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hammer-pi-store-'))
  const target = writeSessionFile(
    store,
    'restored.jsonl',
    '66666666-6666-4666-8666-666666666666',
    'restore me',
  )
  const bridge = new StubBridge()
  // The shape of a page that just reconnected: the child has not answered get_state, so the
  // bridge cannot name its file, and no turn is running to make it do so.
  bridge.sessionFile = null
  bridge.running = false
  await withPiApp({ piBridge: bridge, piSessionsDir: store }, async (base) => {
    const data = await (
      await fetch(`${base}/api/pi/messages?session=${encodeURIComponent(target)}`)
    ).json()
    assert.equal(data.success, true)
    assert.equal(data.source, 'session')
    assert.equal(data.messages.length, 2)
    assert.match(data.messages[0].content[0].text, /restore me/)
    assert.deepEqual(bridge.calls, [], 'reading history never starts the agent')
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

// ── Compaction ───────────────────────────────────────────────────────────────────────

test('a compaction is reported in the transcript a user can see', async () => {
  const { bridge } = makeFake()
  try {
    // The records the real agent emits, in the order it emits them: it is happening, why,
    // then it is done and what it cost. A console that only rendered the end would show the
    // boundary with no beginning, and a long silence in between would read as a hung agent.
    const seen = []
    // Status captured at the moment each record lands. The two compaction records arrive
    // back to back, so by the time the awaited command resolves the in-flight state is over.
    const atEvent = {}
    bridge.on('event', (record) => {
      seen.push(record)
      if (record.type === 'compaction_start' || record.type === 'compaction_end')
        atEvent[record.type] = bridge.status()
    })

    const streamed = await bridge.runCommand('compact')

    // A compaction in flight is its own fact, not a turn: the phase is left alone (a
    // threshold compaction happens between turns, an overflow one inside one) and
    // `isCompacting` carries it. Conflating the two would make an idle agent look busy, and
    // a busy one look like it was doing something else.
    assert.equal(atEvent.compaction_start.isCompacting, true)
    assert.equal(atEvent.compaction_start.compactionCount, 1)
    assert.equal(atEvent.compaction_start.compactionReason, 'manual')
    assert.equal(atEvent.compaction_start.phase, 'alive', 'a compaction is not a turn')

    // Both halves of the pair are forwarded, in order, so a console can render the boundary
    // and the two records cannot be confused for one.
    assert.deepEqual(
      seen.filter((r) => String(r.type).startsWith('compaction_')).map((r) => r.type),
      ['compaction_start', 'compaction_end'],
    )
    const last = seen[seen.length - 1]
    assert.equal(last.reason, 'manual')
    assert.equal(last.result.tokensBefore, 118000)
    assert.equal(last.result.estimatedTokensAfter, 34000)

    // The outcome is carried forward as a fact of its own: the failure slot is distinct from
    // the in-flight one, so a compaction that succeeded does not leave an error behind.
    assert.equal(bridge.status().isCompacting, false)
    assert.equal(bridge.status().compactionError, null)
    assert.equal(bridge.status().phase, 'alive', 'a finished compaction is still not a turn')
    assert.equal(bridge.status().compactionCount, 1, 'the count is a total, not a live flag')

    // A manual compaction answers with its result directly, so a caller that wants the
    // figures does not have to sift the event stream for them.
    assert.equal(streamed.data.summary, 'Summary of everything above this point.')
    assert.equal(streamed.data.tokensBefore, 118000)
  } finally {
    bridge.dispose()
  }
})

test('a compaction that fails is reported, and it does not leave the agent stuck', async () => {
  const { bridge, commands } = makeFake()
  try {
    await withEnv({ FAKE_PI_COMPACT_ERROR: 'The model refused to summarise' }, async () => {
      // Pi answers a failed compaction with `success:false` and a message, and the bridge
      // turns that into a rejection rather than an empty result: a caller must not be able to
      // mistake a refusal for a compaction that succeeded and simply reported nothing.
      await assert.rejects(() => bridge.runCommand('compact'), /refused to summarise/)
      // ...and the failure is not recorded as a compaction that began: the count is of
      // compactions that actually happened, or the UI would count refusals too.
      assert.equal(bridge.status().compactionCount, 0)
      assert.equal(bridge.status().isCompacting, false)
      // The agent is left able to work, which is the whole of "does not get stuck": a later
      // compaction is still allowed, because nothing here latches off.
      await assert.doesNotReject(() => bridge.describe())
      // ...and the refusal is on the command log, so a test can see the request was sent.
      assert.match(commands().join('\n'), /compact/)
    })
  } finally {
    bridge.dispose()
  }
})

test('the context window is reported, and a null token count is not a zero', async () => {
  // The fake reads its environment once, at spawn, so each figure needs its own agent: an
  // env set after the child is up is env the child never sees.
  // A session that has never been compacted measures nothing yet. Pi reports null rather
  // than guessing; the bridge must not turn that null into 0, which a context meter would
  // draw as "empty" and a reader would trust. `get_session_stats` is read directly: the
  // sync does not need a turn to have happened, which is the whole point of it.
  await withEnv(
    {
      FAKE_PI_SESSION_STATS: JSON.stringify({
        tokens: { input: 0, output: 0, total: 0 },
        cost: 0,
        contextUsage: { tokens: null, contextWindow: 131072, percent: null },
      }),
    },
    async () => {
      const { bridge } = makeFake()
      try {
        const synced = await bridge.syncUsageFromSession()
        assert.equal(synced.contextUsage.contextWindow, 131072)
        assert.equal(synced.contextUsage.tokens, null, 'null survives the trip')
        // And the status card carries it, which is where the page reads it from.
        assert.equal(bridge.status().contextUsage.tokens, null)
      } finally {
        bridge.dispose()
      }
    },
  )

  // And a measured session reports its real figures, against the real window.
  await withEnv(
    {
      FAKE_PI_SESSION_STATS: JSON.stringify({
        tokens: { input: 100000, output: 9000, total: 109000 },
        cost: 0.12,
        contextUsage: { tokens: 109000, contextWindow: 131072, percent: 83.1 },
      }),
    },
    async () => {
      const { bridge } = makeFake()
      try {
        const measured = await bridge.syncUsageFromSession()
        assert.equal(measured.contextUsage.tokens, 109000)
        assert.equal(measured.contextUsage.percent, 83.1)
        // ...and the figure reaches the status card, which is where the page reads it from.
        const status = bridge.status()
        assert.equal(status.contextUsage.contextWindow, 131072)
        assert.equal(status.contextUsage.tokens, 109000)
      } finally {
        bridge.dispose()
      }
    },
  )
})

test('auto-compaction is read from Pi as three-valued, and a change is echoed back', async () => {
  const { bridge } = makeFake()
  try {
    // Unset means "this Pi does not report it", which is not the same as "off". Both are read
    // as they arrive: a bridge that folded them into one boolean would light a toggle for a
    // Pi that has no auto-compaction to speak of.
    await bridge.describe()
    assert.equal(bridge.status().autoCompactionEnabled, null, 'not reported is not off')

    await bridge.runCommand('set_auto_compaction', { enabled: false })
    assert.equal(bridge.status().autoCompactionEnabled, false)

    await bridge.runCommand('set_auto_compaction', { enabled: true })
    assert.equal(bridge.status().autoCompactionEnabled, true)

    // A fresh `get_state` reads it back from the agent rather than from what was sent, which
    // is the only way to catch a Pi that ignored the command.
    assert.equal(bridge.status().autoCompactionEnabled, true)
  } finally {
    bridge.dispose()
  }
})

test('a prompt is compacted first when the routed model has less room than Pi’s alias', () => {
  // Pi plans against the alias's declared 131k window. OrcaRouter's free tier refuses a
  // single prompt above an unpublished cap, which Hammer learns from `err_free_prompt_cap`.
  // The routed bound has to win before the prompt is sent, or the turn is spent on a refusal
  // that compaction could have avoided.
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 120000,
      piWindow: 131072,
      routedWindow: 122000,
      reserveTokens: 16384,
    }),
    true,
  )
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 100000,
      piWindow: 131072,
      routedWindow: 122000,
      reserveTokens: 16384,
    }),
    false,
  )
  // OrcaRouter's learned 25.6k bound is a prompt cap, not a total context window: 10k is
  // nowhere near the 24.4k trigger, while 25k is.
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 10_000,
      piWindow: 25_639,
      routedWindow: 25_639,
      routedPromptCap: true,
    }),
    false,
  )
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 25_000,
      piWindow: 25_639,
      routedWindow: 25_639,
      routedPromptCap: true,
    }),
    true,
  )
  // A measured context already past Pi's own window is compacted even without a routed bound.
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 135000,
      piWindow: 131072,
      routedWindow: null,
      reserveTokens: 16384,
    }),
    true,
  )
  // An explicit off is the user's decision; an unreported switch is not "off".
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 135000,
      piWindow: 131072,
      autoCompactionEnabled: false,
    }),
    false,
  )
  assert.equal(
    shouldCompactBeforePrompt({
      usedTokens: 135000,
      piWindow: 131072,
      autoCompactionEnabled: null,
    }),
    true,
  )
  // No measurement or no window is not a reason to compact.
  assert.equal(shouldCompactBeforePrompt({ usedTokens: null, piWindow: 131072 }), false)
  assert.equal(shouldCompactBeforePrompt({ usedTokens: 120000 }), false)
})

test('a bridge that is not allowlisted cannot compact', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    let called = 0
    bridge.send = async () => {
      called += 1
      return { data: {} }
    }
    // The allowlist is the harness's, not the caller's: `compact` is on it because it is a
    // control a UI reasonably offers, but the command itself stays gated on the bridge.
    await assert.rejects(() => bridge.runCommand('unknown_thing', { a: 1 }), /not allowed/)
    await bridge.runCommand('compact')
    assert.equal(called, 1)
  } finally {
    bridge.dispose()
  }
})

test('a compaction is not held to the generic command timeout', async () => {
  // A compaction is a model call that writes a summary of the whole conversation, and a long
  // session regularly takes a minute or two. The 20s request/response budget made every honest
  // compaction report "Pi did not answer compact within 20s".
  const bridge = new PiBridge({ autoContinue: false })
  try {
    /** @type {Array<{ command: any, options: any }>} */
    const calls = []
    bridge.send = async (command, options) => {
      calls.push({ command, options })
      return { success: true, data: {} }
    }
    await bridge.runCommand('compact')
    assert.equal(calls[0].options.timeoutMs, 30 * 60_000)
    // Switching auto-compaction back on can compact during the same call.
    await bridge.runCommand('set_auto_compaction', { enabled: true })
    assert.equal(calls[1].options.timeoutMs, 30 * 60_000)
    // Everything else still answers on the short budget: no override is passed, so `send`
    // applies its own 20s default.
    await bridge.runCommand('get_state')
    assert.equal(calls[2].options.timeoutMs, undefined)
  } finally {
    bridge.dispose()
  }
})

test('the harness renders a compaction as a row in the transcript', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

  // Both halves of the event are handled: the start says it is happening, the end says what
  // it cost. Handling only the end would leave a reader with a boundary and no explanation.
  assert.match(harness, /case 'compaction_start'/)
  assert.match(harness, /case 'compaction_end'/)

  // The row is its own kind, not a notice: a compaction is a boundary in the conversation
  // with figures attached, and the markup carries them.
  assert.match(harness, /if \(item\.kind === 'compaction'\) return compactionMarkup\(item\)/)
  assert.match(harness, /function compactionMarkup\(item\)/)
  assert.match(harness, /compactionReasonLabel/)

  // The summary is available — it is the only thing left of the turns above the line — but
  // behind a disclosure, so it is not re-read as the current instruction.
  assert.match(harness, /<details class="hx-compaction-summary">/)

  // The figures and the reason are computed, and the meter knows the three states it can be
  // in: measured, not measurable, and no window at all.
  assert.match(harness, /function compactionFigures\(/)
  assert.match(harness, /function renderContext\(/)
  assert.match(harness, /if \(window_ <= 0\)/)
  assert.match(harness, /context not measured/)

  // The control is reachable the ways a user reaches anything else: the palette and a slash
  // command.
  assert.match(harness, /\{ label: 'Compact the context', hint: '\/compact'/)
  assert.match(harness, /text === '\/compact'/)
  assert.match(harness, /await compactNow\(/)

  for (const selector of ['.hx-compaction', '.hx-compaction-head', '.hx-context-note']) {
    assert.match(css, new RegExp(selector.replace('.', '\\.')))
  }
})

test('the context meter is tallied while a message is being written', () => {
  // Pi reports usage only on `message_end`, so a long answer used to leave the meter frozen
  // until it was over. The streamed text is tallied as it arrives and marked as an estimate;
  // the measured figure replaces it when the message ends.
  const bridge = new PiBridge({ autoContinue: false })
  try {
    /** @type {any[]} */
    const frames = []
    bridge.on('usage', (usage) => frames.push(usage))
    bridge.track({ type: 'agent_start' })
    bridge.track({ type: 'message_start', message: { role: 'assistant', content: [] } })
    bridge.track({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    })
    const live = bridge.status().contextUsage
    assert.equal(live.estimated, true)
    assert.equal(live.tokens, 100, 'four characters per token, on top of the last measurement')
    assert.equal(frames.at(-1).contextUsage.tokens, 100)

    bridge.track({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 900, output: 100, totalTokens: 1000 },
      },
    })
    const measured = bridge.status().contextUsage
    assert.equal(measured.tokens, 1000)
    assert.equal(measured.estimated, false)
  } finally {
    bridge.dispose()
  }
})

test('a turn that fills the routed window between steps compacts mid-turn', () => {
  // The preflight in the prompt route covers a full context at send time. A long turn reaches
  // the same boundary between its own steps, where nobody is there to compact for it.
  const bridge = new PiBridge({
    autoContinue: false,
    routedWindowTokens: () => 20_000,
    compactionReserveTokens: 4_000,
  })
  try {
    /** @type {string[]} */
    const commands = []
    bridge.runCommand = async (type) => {
      commands.push(type)
      return { data: {} }
    }
    bridge.track({ type: 'agent_start' })
    bridge.track({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [],
        usage: { input: 15_000, output: 1_000, totalTokens: 16_000 },
      },
    })
    assert.deepEqual(commands, ['compact'])
    assert.ok(bridge.status().notes.some((note) => /mid-turn/.test(note)))

    // An estimate must never cut a turn short: only a measured message can.
    const estimateOnly = new PiBridge({
      autoContinue: false,
      routedWindowTokens: () => 20_000,
      compactionReserveTokens: 4_000,
    })
    try {
      let asked = 0
      estimateOnly.runCommand = async () => {
        asked += 1
        return { data: {} }
      }
      estimateOnly.track({ type: 'agent_start' })
      estimateOnly.track({ type: 'message_start', message: { role: 'assistant', content: [] } })
      estimateOnly.track({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400_000) },
      })
      assert.equal(asked, 0)
    } finally {
      estimateOnly.dispose()
    }
  } finally {
    bridge.dispose()
  }
})

test('a prompt-cap routed window compacts near its cap, not at Pi’s full reserve', () => {
  const bridge = new PiBridge({
    autoContinue: false,
    routedWindowTokens: () => 25_639,
    routedPromptCap: () => true,
  })
  try {
    /** @type {string[]} */
    const commands = []
    bridge.runCommand = async (type) => {
      commands.push(type)
      return { data: {} }
    }
    bridge.track({ type: 'agent_start' })
    bridge.track({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 10_000, output: 0, totalTokens: 10_000 },
      },
    })
    assert.deepEqual(commands, [], '10k is not near a 25.6k prompt cap')
    assert.equal(bridge.status().compactionReserve, 1_281)
    bridge.track({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 24_500, output: 0, totalTokens: 24_500 },
      },
    })
    assert.deepEqual(commands, ['compact'])
  } finally {
    bridge.dispose()
  }
})

test('mid-turn compaction respects the auto-compaction switch', () => {
  const bridge = new PiBridge({ autoContinue: false, routedWindowTokens: () => 20_000 })
  try {
    let asked = 0
    bridge.runCommand = async () => {
      asked += 1
      return { data: {} }
    }
    bridge.state.autoCompactionEnabled = false
    bridge.track({ type: 'agent_start' })
    bridge.track({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 19_000, output: 1_000, totalTokens: 20_000 },
      },
    })
    assert.equal(asked, 0)
  } finally {
    bridge.dispose()
  }
})

test('the compaction panel is repainted by the status frames the page actually receives', () => {
  // This is the assertion that would have caught the bug. `refreshStatus` repaints the
  // panel, but `refreshStatus` is a poll: an agent that answers a status request only
  // when the page asks for one. Everything a page *sees* between polls comes from
  // `applyStatusFrame`, folding the SSE frames, so a panel that is only painted from a
  // poll is a panel that is stale for as long as the stream is quiet.
  //
  // The threshold compaction is exactly the case that matters: it happens inside a turn
  // nobody asked for, and the "Pi is compacting — …" note and the compaction count are the
  // only things on screen that can explain a turn that has gone quiet. A panel painted
  // from a poll alone shows a hung agent for the whole of that silence.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

  const frame = harness.match(
    /function applyStatusFrame\(ctx, status\) \{[\s\S]*?\n[ ]{2}\}\n\n[ ]{2}\/\*\* Applies one live frame/,
  )
  assert.ok(frame, 'applyStatusFrame exists, so the assertion below tests the real function')
  assert.match(
    frame[0],
    /renderCompactionPanel\(ctx\)/,
    'the panel is repainted from a status frame, not only from a poll',
  )
})

test('the compaction panel belongs to the conversation on screen', () => {
  // The panel is one element shared by every console. A background conversation's status frame
  // used to repaint it, so a running inactive tab could disable the button while the visible
  // conversation was idle — the click went nowhere until that tab was switched to. Switching
  // tabs now repaints the panel for the tab that arrived, and only the active tab's frames may
  // paint it afterwards.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const activate = harness.match(/function activate\(console\) \{[\s\S]*?\n {2}\}\n/)
  assert.ok(activate, 'activate exists, so the assertion below tests the real function')
  assert.match(activate[0], /renderCompactionPanel\(console\)/)
  assert.match(harness, /if \(ctx === active\(\)\) renderCompactionPanel\(ctx\)/)
  assert.match(harness, /if \(console === active\(\)\) renderCompactionPanel\(console\)/)
  // An inactive console with no status of its own must not fall back to the active one's.
  assert.match(
    harness,
    /const status = console\?\.status \|\| \(console === active\(\) \? state\.status : null\) \|\| \{\}/,
  )
})

test('the Compact now button says what it is doing while a compaction runs', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

  // A compaction is an LLM call that runs for many seconds. The hint line is the only
  // feedback `compactNow` gave while it waited — a line of text at the bottom of the
  // composer the user may not be looking at, next to a button that still looked available.
  // A second click therefore started a second compaction on a conversation the first had
  // not finished resetting, and with no in-flight marker the button gave no sign it had been
  // heard at all. Both halves are pinned here: it turns itself off, and it says why.
  const compacting = harness.match(
    /async function compactNow\(instructions = ''\) \{[\s\S]*?\n[ ]{2}\}\n\n[ ]{2}\/\*\*\n[ ]{3}\* Turns Pi's auto-compaction on or off/,
  )
  assert.ok(compacting, 'compactNow exists, so the assertions below test the real function')
  const body = compacting[0]
  assert.match(body, /button\.disabled = true/, 'the button refuses a second click')
  assert.match(body, /'Compacting…'/, 'the label names what is happening')
  assert.match(
    body,
    /finally \{[\s\S]*?restore\(\)/,
    'the label and the disabled state are restored even when the compaction fails',
  )

  // The repaint must respect that in-flight state. `renderCompactionPanel` runs from every
  // status frame, so a frame arriving mid-compaction would otherwise snap the label back to
  // "Compact now" with a compaction still running — which is precisely the feedback gap,
  // reintroduced by the very code that fixes the panel.
  assert.match(
    harness,
    /button\.dataset\.working === 'true' \|\| status\.isCompacting === true/,
    'the repaint keeps the button saying Compacting… while it is',
  )
  assert.match(css, /data-compaction-now\]\[data-working='true'\]/)
})

test('the rail usage plot describes the conversation, not the router process', () => {
  // The plot used to draw /api/usage-series' `session` view, which the server filters to its
  // own process start: a conversation resumed after a restart drew as an empty plot with a
  // title that claimed a history it was not showing. The session file is the authority — it
  // holds every turn the conversation ever had — so harness.js publishes it and the plot
  // draws that. Each half is pinned: the read, the publish, and the moments it happens.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

  // The conversation's history is read from its file, through a route the server answers.
  assert.match(harness, /\$\{API\}\/sessions\/usage\?session=\$\{encodeURIComponent\(file\)\}/)
  assert.match(
    dashboard,
    /window\.publishSessionUsage = publishSessionUsage/,
    'dashboard.js owns the plot, and harness.js is a separate classic script, so the\n' +
      ' publisher has to be exposed on window for the agent page to call it',
  )
  assert.match(
    dashboard,
    /window\.requestSessionPlotRedraw = requestSessionPlotRedraw/,
    'the repaint is exposed with it: the rail is usually hidden when a publish happens',
  )
  // Identical samples are already drawn, and the repaint is a whole SVG rebuild.
  assert.match(
    dashboard,
    /if \(usagePointsSignature\(session, points\) === usageSessionSignature\) return;/,
    'republishing a history the plot already shows must not rebuild it',
  )

  // Only the conversation on screen paints the rail, and a burst of publishes is one read.
  // Reopening Hammer used to read and redraw the plot once per conversation restored beside
  // the one on screen, which is the flitting the page showed on the way in.
  const publish = harness.match(/function publishSessionUsage\(ctx\) \{[\s\S]*?\n[ ]{2}\}\n/)
  assert.ok(publish, 'publishSessionUsage exists, so the assertions below test the real function')
  assert.match(
    publish[0],
    /if \(!ctx \|\| ctx !== active\(\) \|\| usageSettling\) return/,
    'a conversation that is not on screen does not get to paint the rail plot',
  )
  assert.match(publish[0], /clearTimeout\(usagePublishTimer\)/, 'a burst collapses into one read')
  // The three moments the plot must be re-published, and the two it must be released.
  const read = harness.match(/async function readSessionUsage\(ctx\) \{[\s\S]*?\n[ ]{2}\}\n/)
  assert.ok(read, 'the read is its own function, scheduled by publishSessionUsage')
  assert.match(
    read[0],
    /window\.publishSessionUsage\?\.\(null, \[\]\)/,
    'a conversation with no file publishes nothing rather than an empty plot',
  )
  assert.match(
    read[0],
    /if \(ctx\.sessionFile !== file \|\| ctx !== active\(\)\) return/,
    'a console that switched conversations mid-read must not be handed the earlier one',
  )
  // A switch of console, and a reopened transcript, are what the rail describes.
  assert.match(
    harness,
    /void publishSessionUsage\(console\)\n[ ]{2}\}/,
    'switching tabs republishes: the plot is the conversation now on screen',
  )
  assert.match(
    harness,
    /void publishSessionUsage\(ctx\)/,
    'a rebuilt transcript publishes its own history',
  )
  assert.match(
    harness,
    /if \(ctx\.sessionFile === active\(\)\?\.sessionFile\) void publishSessionUsage\(ctx\)/,
    'the live update: a turn that just settled in the file the plot reads',
  )
  // And the release: a reset, a delete, a detached console.
  assert.match(
    harness,
    /The reset clears the transcript, so the plot has no history to describe either\.\n[ ]{6}void publishSessionUsage\(console\)/,
  )

  // The copy names what the plot is: the title said "tokens/s", which is the rate the plot
  // deliberately does not draw (see drawUsagePlot's binned columns).
  assert.match(html, /This conversation — tokens over time/)
  assert.doesNotMatch(html, /This session — tokens\/s/)
  assert.match(html, /No tokens in this conversation yet\./)
})

/**
 * the compaction panel says why a compaction is running, from either cause
 */
test('the compaction panel says why a compaction is running, from either cause', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  // The note is what explains a turn that has gone quiet. "You asked for it" and "the
  // context is nearly full" are different sentences on purpose: one is the user's own
  // button, the other is the agent protecting itself, and a reader cannot tell them apart
  // from a bare spinner.
  assert.match(harness, /compactionReason === 'manual'/)
  assert.match(harness, /compactionReason === 'overflow'/)
  assert.match(harness, /note\.textContent = `Pi is compacting — /)
})

test('a compaction row is drawn for both halves of the event pair', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  // The transcript's compaction row is what the user actually watches. `state: 'running'`
  // is the only thing on screen between the two records, and without the `compaction_start`
  // half of it the end record would have no row to attach its figures to.
  assert.match(harness, /state: 'running'/)
  assert.match(harness, /lastCompaction\(ctx\)/)
  assert.match(
    harness,
    /item\.state = record\.aborted \? 'aborted' : record\.errorMessage \? 'error' : 'done'/,
  )
  // The row's figures and the button's success line must be the same rounded tokens, so a
  // reader who watched the row sees the same numbers the hint then repeats.
  assert.match(harness, /window\.hxCompact = compact/)
})

test('the console renders compaction state from the status the bridge reports', async () => {
  const bridge = new PiBridge({ command: process.execPath, args: [FAKE_PI], cwd: tmpdir() })
  try {
    await bridge.describe()
    const status = bridge.status()
    // Every compaction fact a UI needs is on the status card, so the page never has to
    // guess from an event stream it was not listening to.
    for (const key of [
      'isCompacting',
      'autoCompactionEnabled',
      'compactionReason',
      'compactionError',
      'compactionReserve',
    ]) {
      assert.ok(key in status, `${key} is on the status card`)
    }
    assert.equal(typeof status.compactionCount, 'number')
  } finally {
    bridge.dispose()
  }
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

test('a turn that ended while Hammer was restarting is continued from the replay', async () => {
  // The keeper hands a replacement router the records the agent wrote while no router was
  // attached. They are not tracked — the old router already counted their tokens — but a
  // dropped turn among them still needs its continuation, or a restart silently ends it.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {Array<{ message: string, options: any }>} */
    const prompts = []
    bridge.prompt = async (message, options) => {
      prompts.push({ message, options })
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [] } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'socket hang up' },
      }),
      JSON.stringify({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'socket hang up' }],
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ])

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0].message, /Repeat your last action/)
    assert.equal(prompts[0].options.queueMode, 'followUp')
    assert.equal(bridge.status().usage.totalTokens, 0, 'replay still does not re-count usage')
  } finally {
    bridge.dispose()
  }
})

test('a replay that already prompted after its settle is not continued again', async () => {
  // The old router may have sent the continuation before it died. That prompt puts a user
  // message and a new agent_start after the settle, which is what marks the turn as handled.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'connection reset' }],
      }),
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [] } }),
      JSON.stringify({ type: 'agent_start' }),
    ])

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('a continuation the dead router already queued is not sent twice', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'connection reset' }],
      }),
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({
        type: 'queue_update',
        steering: [],
        followUp: ['Repeat your last action. Do not summarise; continue it.'],
      }),
    ])

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prompts, 0, 'the old router got its continuation in before it died')
  } finally {
    bridge.dispose()
  }
})

test('the console adopts a running agent as soon as its routes are registered', () => {
  // Waiting for a status request meant a restarted router heard nothing from a live agent, so
  // a turn that settled in the gap was never continued.
  const source = readFileSync(new URL('../lib/http/routes/pi.js', import.meta.url), 'utf8')
  assert.match(source, /typeof main\.bridge\.adoptKeeper === 'function'/)
  assert.match(source, /void main\.bridge\.adoptKeeper\(\)/)
})

test('a model change names the provider that served each end', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
  // Pi is configured with Hammer, so every message it writes says `provider: "hammer"`: the
  // router, not the host. A change line that printed it told the reader nothing.
  assert.match(harness, /function isRouterProviderValue\(value\)/)
  assert.match(harness, /!isRouterProviderValue\(value\) && !isRouterAlias\(value\)/)
  assert.match(harness, /const key = name \? providerKeyByModel\.get\(name\) : ''/)
  assert.match(harness, /providerNameByKey\.set\(routed\.providerKey, providerName\)/)
  // The model station's text starts on the tool row's text edge: 8px inside the row's 12px.
  assert.match(css, /\.hx-model-head \{[^}]*padding-left: 8px/)
})

test('a turn whose tool call never arrived is continued for any model', async () => {
  // Why a session can stop after one sentence: the provider says `finish_reason: tool_calls`, the
  // call's payload is lost on the way, so Pi settles a `toolUse` turn with nothing to run. This
  // used to be continued only for Beam, which left every other model dead until someone typed
  // Continue.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    const prompts = []
    bridge.prompt = async (text, options) => {
      prompts.push({ text, options })
      return { data: {} }
    }
    bridge.send = async () => ({ data: {} })
    bridge.syncUsageFromSession = async () => {}

    const assistant = {
      role: 'assistant',
      stopReason: 'toolUse',
      responseModel: 'puter/deepseek-v4.1-flash',
      content: [{ type: 'thinking', text: 'I should run it.' }],
    }
    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_end', message: assistant }),
      JSON.stringify({ type: 'agent_end', messages: [assistant] }),
      JSON.stringify({ type: 'agent_settled' }),
    ])

    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(prompts.length, 1, 'the dropped call is asked for again')
    assert.equal(prompts[0].options?.queueMode, 'followUp')
  } finally {
    bridge.dispose()
  }
})

test('the dropped-call continuation stops after three attempts and says why', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.send = async () => ({ data: {} })
    bridge.syncUsageFromSession = async () => {}

    for (let index = 0; index < 6; index += 1) {
      const assistant = { role: 'assistant', stopReason: 'toolUse', content: [] }
      bridge.track({ type: 'agent_start' })
      bridge.track({ type: 'agent_end', messages: [assistant] })
      bridge.track({ type: 'agent_settled' })
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.equal(prompts, 3, 'a provider that keeps dropping calls is not looped on forever')
    assert.ok(
      bridge.notes.some((note) => /tool call never arrived/.test(note)),
      'the stop explains itself',
    )
  } finally {
    bridge.dispose()
  }
})

test('a replay that ends mid-turn arms nothing', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: [] },
      }),
    ])

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('a length cut that ended while Hammer was restarting is continued from the replay', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {string[]} */
    const prompts = []
    bridge.prompt = async (message) => {
      prompts.push(message)
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    bridge.replayRecords([
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'length',
            content: [{ type: 'text', text: 'half a thought' }],
          },
        ],
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ])

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0], /output limit/)
  } finally {
    bridge.dispose()
  }
})

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

test('the continuation backoff doubles exponentially and is capped like OpenCode', () => {
  // OpenCode's session retry schedule: 2s base, exponential 2^n, capped at 10s.
  // Hammer matches: AUTO_CONTINUE_BASE_MS = 2000, exponential, AUTO_CONTINUE_MAX_DELAY_MS = 10000.
  const base = 2000
  const cap = 10_000
  const expected = [1, 2, 3, 4, 5].map((attempt) => Math.min(cap, base * 2 ** (attempt - 1)))
  assert.deepEqual(expected, [2000, 4000, 8000, 10_000, 10_000], 'reference schedule')

  const seen = []
  const bridge = new PiBridge({ autoContinueBaseMs: base, autoContinueLimit: 5 })
  try {
    bridge.prompt = async () => ({ data: {} })
    bridge.syncUsageFromSession = async () => {}

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      endFailedTurn(bridge, 'socket hang up')
      // Read the delay from the timer Node scheduled.
      const delay = bridge.continueTimer?._idleTimeout
      seen.push(delay)
      // Cancel the timer so it does not fire during the test.
      clearTimeout(bridge.continueTimer)
      bridge.continueTimer = null
    }
    assert.deepEqual(seen, expected, 'Hammer backoff matches OpenCode exactly')
  } finally {
    bridge.dispose()
  }
})

/**
 * One `agent_end` for a run that finished on prose, the way Pi reports it: a user message, an
 * optional tool turn, then the assistant message that ended the run.
 */
function endProseTurn(
  bridge,
  {
    routedModel = 'reflection/beam-free',
    responseModel,
    text,
    priorTool = true,
    stopReason = 'stop',
  } = {},
) {
  // What the router reports `best` resolved to; Pi itself records only `best` on a message.
  bridge.routedModel = () => routedModel
  /** @type {any[]} */
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Fix the queue.' }] }]
  if (priorTool) {
    messages.push({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
    })
    messages.push({ role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] })
  }
  messages.push({ role: 'assistant', stopReason, responseModel, content: [{ type: 'text', text }] })
  bridge.track({ type: 'agent_end', messages })
  bridge.track({ type: 'agent_settled' })
}

test('a Beam turn that stops on an announcement is continued', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {Array<{ message: string, options: any }>} */
    const prompts = []
    bridge.prompt = async (message, options) => {
      prompts.push({ message, options })
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, { text: 'Let me look at the queue handling code more carefully.' })

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0].message, /make that tool call now/)
    assert.equal(prompts[0].options.queueMode, 'followUp')
    assert.match(bridge.status().notes.join('\n'), /stopped after prose \(1\)/)
  } finally {
    bridge.dispose()
  }
})

test('a leaked Beam tool-call template also continues the turn', async () => {
  // The same failure without an announcement: Beam's native chat template is what the gateway
  // left in the content instead of a tool call.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, { text: '<|rf|parameter name="command">pwd</|rf|parameter>' })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

test('a Beam turn that stops with no visible text is continued', async () => {
  // Observed live: after a tool call Beam ends the run with an empty assistant message, which
  // has no announcement to match. An empty message is never a finished answer, so it continues
  // even though this run had not used a tool yet.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {string[]} */
    const prompts = []
    bridge.prompt = async (message) => {
      prompts.push(message)
      return { data: {} }
    }

    endProseTurn(bridge, { text: '', priorTool: false })

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0], /no visible text and no tool call/)
    assert.match(bridge.status().notes.join('\n'), /stopped with no text \(1\)/)
  } finally {
    bridge.dispose()
  }
})

test('an empty turn is continued when agent_end carries no messages', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}
    bridge.routedModel = () => 'reflection/beam-free'

    bridge.track({ type: 'agent_start' })
    bridge.track({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'Fix the queue.' }] },
    })
    bridge.track({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [] },
    })
    // An older Pi record (and the console's stub) can report the run without its messages;
    // the empty assistant message was already delivered above and must still be nudged.
    bridge.track({ type: 'agent_end', messages: [] })
    bridge.track({ type: 'agent_settled' })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

test('a Beam response is continued after the router has already picked another model', async () => {
  // Observed live: the empty assistant message says responseModel "beam", while the router's
  // selection at agent_end is already the next request's row. The answer is what counts.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, {
      routedModel: 'poolside/laguna-xs-2.1',
      responseModel: 'beam',
      text: '',
      priorTool: false,
    })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

/**
 * One `agent_end` for a run the provider cut off at the output budget, the way a reasoning
 * model does it: the whole budget goes on thinking and the turn ends with nothing visible.
 */
function endLengthTurn(
  bridge,
  { routedModel = 'kilocode/nvidia/nemotron-3.5-super-vl:free', text = '', toolCall = false } = {},
) {
  bridge.routedModel = () => routedModel
  /** @type {any[]} */
  const content = [{ type: 'thinking', thinking: 'Weighing where the spine should attach.' }]
  if (text) content.push({ type: 'text', text })
  if (toolCall) {
    content.push({ type: 'toolCall', id: 't9', name: 'bash', arguments: { command: 'ls' } })
  }
  bridge.track({
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Finish the spine art.' }] },
      { role: 'assistant', stopReason: 'length', content },
    ],
  })
  bridge.track({ type: 'agent_settled' })
}

test('a turn cut off by the output limit is continued, whatever the model', async () => {
  // Observed live: nemotron and stepfun spent all 8192 output tokens thinking, so the turn
  // ended with no text and no tool call and the console went idle until "Continue" was typed.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {string[]} */
    const prompts = []
    bridge.prompt = async (message) => {
      prompts.push(message)
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endLengthTurn(bridge)

    await waitFor(() => prompts.length === 1)
    assert.match(prompts[0], /cut off by the output limit/)
    assert.match(bridge.status().notes.join('\n'), /output limit cut off \(1\)/)
  } finally {
    bridge.dispose()
  }
})

test('a length cut that produced prose is continued too', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endLengthTurn(bridge, { text: 'The spine should run between the icon rows so that' })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

test('a length cut that already made its tool call is left to the tool loop', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endLengthTurn(bridge, { toolCall: true })

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('length continuations are not capped at any fixed number', async () => {
  // A length cut is the provider's doing, not the model declaring it is done, so there is no
  // count at which the turn has become an answer. The chain continues until the work is
  // finished or someone presses Stop; the auto-continue limit must not shorten it.
  const bridge = new PiBridge({ autoContinueBaseMs: 1, autoContinueLimit: 3 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      endLengthTurn(bridge)
      await waitFor(() => prompts === attempt)
    }

    assert.equal(prompts, 6)
    const notes = bridge.status().notes.join('\n')
    assert.match(notes, /output limit cut off \(6\)/)
    assert.doesNotMatch(notes, /Stopped continuing/)
  } finally {
    bridge.dispose()
  }
})

test('a toolUse stop with no tool call is treated as an empty turn', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, { text: '', priorTool: false, stopReason: 'toolUse' })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

test('a Beam alias that resolves to another id is still continued', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, {
      routedModel: 'kilo-auto/free reflection/beam-1.0-501b-a23b',
      text: 'Let me look at the queue handling code more carefully.',
    })

    await waitFor(() => prompts === 1)
  } finally {
    bridge.dispose()
  }
})

test('another model finishing on the same prose is not continued', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, {
      routedModel: 'openai/gpt-5',
      text: 'Let me look at the queue handling code more carefully.',
    })
    await new Promise((resolve) => setTimeout(resolve, 40))

    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('a Beam final answer is not continued', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, {
      text: 'The queue now waits for the previous message to finish. No further change is needed.',
    })
    await new Promise((resolve) => setTimeout(resolve, 40))

    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('a Beam announcement before any tool call is not continued', async () => {
  // A plain answer may open with "Let me explain". Only a run that already used a tool can be
  // mid-task, so the first assistant message is never nudged.
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    let prompts = 0
    bridge.prompt = async () => {
      prompts += 1
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    endProseTurn(bridge, { priorTool: false, text: 'Let me explain how the queue works.' })
    await new Promise((resolve) => setTimeout(resolve, 40))

    assert.equal(prompts, 0)
  } finally {
    bridge.dispose()
  }
})

test('prose continuations have no cap', async () => {
  const bridge = new PiBridge({ autoContinueBaseMs: 1 })
  try {
    /** @type {string[]} */
    const prompts = []
    bridge.prompt = async (message) => {
      prompts.push(message)
      return { data: {} }
    }
    bridge.syncUsageFromSession = async () => {}

    // More turns than the old five-continuation ceiling, each ending the same way.
    for (let turn = 1; turn <= 7; turn += 1) {
      endProseTurn(bridge, { text: 'Let me read the next section.' })
      await waitFor(() => prompts.length === turn)
    }

    assert.equal(prompts.length, 7)
    assert.equal(bridge.proseContinuesUsed, 7)
    assert.ok(
      !bridge.status().notes.some((note) => note.startsWith('Stopped continuing a turn')),
      'no budget note is written',
    )
  } finally {
    bridge.dispose()
  }
})

test('a streaming assistant row is mounted on its first token, not at the end of the turn', () => {
  // `message_start` pushes the assistant row empty, and the sync that follows skips it: a row
  // with no visible text is not a message, and a restored log must not be full of pending "…".
  // The cursor used to advance past it anyway, so the row the turn was about to stream into was
  // never created and every delta painted into nothing — the whole answer appeared at once when
  // `message_end` rebuilt the transcript. Tool rows, which mount as soon as they exist, streamed
  // beside it, which is why only some turns looked like they were streaming.
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.doesNotMatch(harness, /for \(let i = state\.mounted; i < state\.items\.length/)
  assert.match(harness, /if \(item\.node && item\.node\.isConnected\) continue/)
  assert.match(
    harness,
    /item\.kind === 'assistant' &&\s*!\(item\.blocks \|\| \[\]\)\.some\(\(block\) => String\(block\.text \|\| ''\)\.trim\(\)\)/,
    'the skip stays: an assistant row with no visible text still does not render',
  )
})

test('a finished call or thought folds while the turn is still running', () => {
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  // A thought is complete when the model moves on to prose, a tool call or the end of the
  // message — not only when the turn settles. Folding at message_end left every finished
  // thought open above the answer it produced.
  assert.match(harness, /const complete = settled \|\| block\.finished === true/)
  assert.match(harness, /const open = block\.open \?\? !complete/)
  assert.match(harness, /function finishBlocks\(item\)/)
  assert.match(
    harness,
    /finishBlocks\(item\)\n\s+block = \{ kind, index: contentIndex, text: '' \}/,
  )
  assert.match(harness, /finishBlocks\(lastAssistant\(ctx\)\)/)
  // A reader's open state is recorded from the click, never from the toggle the page itself
  // causes by painting a running row open — that is what left finished edits and thoughts open
  // for the rest of the turn, collapsing only after a restart.
  assert.doesNotMatch(harness, /addEventListener\(\s*'toggle'/)
  assert.match(harness, /summary\.hx-tool-head, summary\.hx-thinking-head'\)/)
})
