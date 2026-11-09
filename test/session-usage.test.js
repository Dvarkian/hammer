import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { registerPiRoutes } from '../lib/http/routes/pi.js'
import { readSessionUsage } from '../lib/pi/sessions.js'

/**
 * The session usage plot's data: one session file in, one point per measured turn out.
 *
 * The plot used to draw the router's own slice of time, which is why a conversation that
 * outlived a restart drew as empty while its transcript on disk said otherwise. These tests
 * pin the file as the authority: every turn the conversation ever had, each stamped with its
 * own time, and nothing invented for the timestamps the file does not carry.
 */

/** A session file's assistant turn, in the shape pi writes it. */
function turn(overrides = {}) {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'hammer',
      model: 'best',
      api: 'openai-completions',
      responseModel: 'deepseek-ai/deepseek-v4.1-flash',
      responseId: 'resp-1',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input: 1500,
        output: 240,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1740,
        cost: { total: 0.0021 },
      },
      timestamp: 1_794_186_198_969,
      ...overrides,
    },
  }
}

/** Writes a JSONL the way pi does, and hands back its path. */
function writeSession(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-session-usage-'))
  const file = join(dir, '2026-11-08T12-30-46-353Z_01a1bb23-0000-0000-0000-000000000000.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

/** Tears down the store a session file was written into. */
function dropSession(file) {
  rmSync(join(file, '..'), { recursive: true, force: true })
}

test('every measured turn is a point, oldest first', () => {
  const file = writeSession([
    { type: 'session_info', sessionId: 's1' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    turn(),
    {
      type: 'message',
      message: { role: 'assistant', ...turn().message, timestamp: 1_794_186_298_969 },
    },
    { type: 'toolResult', toolCallId: 'c1', content: 'ok' },
  ])
  try {
    const samples = readSessionUsage(file)
    assert.equal(samples.length, 2, 'the user message and the tool result bill nothing')
    assert.deepEqual(
      samples.map((s) => s.t),
      [1_794_186_198_969, 1_794_186_298_969],
      'the file is append-ordered, and the plot is monotone by construction',
    )
    assert.equal(samples[0].tokens, 1740)
    assert.equal(samples[0].key, 'hammer::best')
    assert.equal(samples[0].responseModel, 'deepseek-ai/deepseek-v4.1-flash')
    // The parts are kept beside the total: a plot is the tokens, and the breakdown is what
    // says which part grew (a cache-heavy turn billed little new work).
    assert.equal(samples[0].input, 1500)
    assert.equal(samples[0].output, 240)
    assert.equal(samples[0].cacheRead, 0)
    assert.equal(samples[0].cacheWrite, 0)
  } finally {
    dropSession(file)
  }
})

test('a turn that billed nothing draws as no point, not as a zero', () => {
  const file = writeSession([
    turn(),
    // An aborted run or a refusal carries a zeroed usage object.
    turn({
      timestamp: 1_794_186_298_969,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
    }),
  ])
  try {
    const samples = readSessionUsage(file)
    assert.equal(samples.length, 1, 'a zero-column would read as a turn that cost something')
    assert.equal(samples[0].t, 1_794_186_198_969)
  } finally {
    dropSession(file)
  }
})

test('a turn with no timestamp is not a point on any axis', () => {
  const file = writeSession([turn({ timestamp: undefined })])
  try {
    assert.deepEqual(readSessionUsage(file), [])
  } finally {
    dropSession(file)
  }
})

test('a line that will not parse costs one turn, not the conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-session-usage-bad-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(
    file,
    [`${JSON.stringify(turn())}\n`, `{"type":"message","message":{"role":"assistant`, `\n`].join(
      '',
    ),
    'utf8',
  )
  try {
    assert.equal(readSessionUsage(file).length, 1)
  } finally {
    dropSession(file)
  }
})

test('a totalTokens the file omits is the sum of its parts', () => {
  const file = writeSession([
    turn({
      usage: {
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 20,
        cost: { total: 0.001 },
      },
    }),
  ])
  try {
    const samples = readSessionUsage(file)
    assert.equal(samples[0].tokens, 135)
  } finally {
    dropSession(file)
  }
})

test('a file that is not there has no history to read', () => {
  assert.deepEqual(readSessionUsage(join(tmpdir(), 'hammer-missing-session.jsonl')), [])
})

/** Mounts the routes against a bridge nobody has to talk to. */
async function withPiApp(run) {
  const bridge = {
    status: () => ({ available: true, sessionFile: null, phase: 'idle' }),
    history: () => [],
    on() {},
    async start() {},
    async prompt() {},
    async abort() {},
    async restart() {},
    async restartTo() {},
    async switchSession() {},
    async runCommand() {},
    async describe() {},
    dispose() {},
    addNote() {},
    emit() {},
  }
  const app = express()
  app.use(express.json())
  registerPiRoutes(app, { piBridge: bridge, piSessionsDir: tmpdir() })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the usage route answers with the whole conversation, shaped for the plot', async () => {
  const file = writeSession([turn(), turn({ timestamp: 1_794_186_298_969 })])
  try {
    await withPiApp(async (base) => {
      const res = await fetch(`${base}/api/pi/sessions/usage?session=${encodeURIComponent(file)}`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.session, file)
      assert.equal(body.points.length, 2)
      const [first] = body.points
      // The shape /api/usage-series hands the plot, so the plot cannot tell them apart:
      // `t` and `tokens` are the figures it reads.
      assert.equal(first.t, 1_794_186_198_969)
      assert.equal(first.tokens, 1740)
      // A rate cannot be recovered from a message's token counts — the file records no
      // elapsed time — so it is null rather than invented, and the area carries the tokens.
      assert.equal(first.ttft, null)
      assert.equal(first.tps, null)
      assert.equal(first.responseModel, 'deepseek-ai/deepseek-v4.1-flash')
    })
  } finally {
    dropSession(file)
  }
})

test('the usage route refuses a session it cannot find', async () => {
  await withPiApp(async (base) => {
    const missing = await fetch(
      `${base}/api/pi/sessions/usage?session=${encodeURIComponent(join(tmpdir(), 'nope.jsonl'))}`,
    )
    assert.equal(missing.status, 400)
    assert.match(await missing.text(), /session/i)

    // Nothing at all is the same answer: the plot would draw the router's view instead.
    const none = await fetch(`${base}/api/pi/sessions/usage`)
    assert.equal(none.status, 400)
  })
})

test('the usage route trims to a point in time, and caps the point count', async () => {
  const file = writeSession([
    turn({ timestamp: 1000 }),
    turn({ timestamp: 2000 }),
    turn({ timestamp: 3000 }),
  ])
  try {
    await withPiApp(async (base) => {
      const since = await fetch(
        `${base}/api/pi/sessions/usage?session=${encodeURIComponent(file)}&since=2000`,
      )
      assert.deepEqual(
        (await since.json()).points.map((p) => p.t),
        [2000, 3000],
      )

      const limited = await fetch(
        `${base}/api/pi/sessions/usage?session=${encodeURIComponent(file)}&limit=2`,
      )
      assert.deepEqual(
        (await limited.json()).points.map((p) => p.t),
        [2000, 3000],
      )
    })
  } finally {
    dropSession(file)
  }
})
test('the rail plot colours each slice by the model that answered it', () => {
  // Every message in a session carries the same hammer::best alias, so one series for the whole
  // conversation painted a session that switched models in a single colour. The file also names
  // the model that answered each turn, and that is what the plot splits and colours by.
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')
  assert.match(dashboard, /const key = `session::\$\{model\}`/)
  assert.match(dashboard, /String\(p\?\.responseModel \|\| ''\)\.trim\(\)/)
  assert.match(dashboard, /usageSessionByKey\.set\(key, series\)/)
  assert.doesNotMatch(dashboard, /usageSessionByKey\.set\('hammer::best', shaped\)/)
  // A session key has no provider row, so its hue comes from the model and its mark from the
  // model's name.
  assert.match(dashboard, /function usageKeyHue\(key\)/)
  assert.match(dashboard, /if \(providerKey === 'session'\) return usageProviderHue\(modelId/)
  assert.match(dashboard, /function sessionModelRow\(name\)/)
  assert.match(
    dashboard,
    /return modelAccent\(sessionModelRow\(modelId\) \|\| \{ providerKey: 'session', modelId \}\)/,
  )
  // The key to the colours only appears when there is more than one model to tell apart.
  assert.match(dashboard, /function renderSessionUsageLegend\(\)/)
  assert.match(dashboard, /if \(keys\.length <= 1\) \{/)
  assert.match(html, /id="usage-session-legend"/)
  assert.match(css, /\.usage-session-legend-swatch \{/)
})

test('the rail legend lists models with samples, not the whole catalog', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')
  // /api/usage-series publishes a key for every model it knows, with an empty array when the
  // current session has no samples for it. Rendering those keys made a fresh page list the
  // catalog, then collapse to the real session once its history arrived.
  assert.match(
    dashboard,
    /if \(Array\.isArray\(pts\) && pts\.length > 0\) usageSessionByKey\.set\(key, pts\);/,
  )
  assert.match(
    dashboard,
    /\.filter\(\(\[, series\]\) => Array\.isArray\(series\) && series\.length > 0\)/,
  )
  // A busy session still gets a bounded key: the newest models, then a summary of the rest.
  assert.match(dashboard, /const SESSION_USAGE_LEGEND_LIMIT = 8/)
  assert.match(dashboard, /const visible = keys\.slice\(-SESSION_USAGE_LEGEND_LIMIT\)/)
  assert.match(dashboard, /usage-session-legend-more/)
  assert.match(css, /\.usage-session-legend-more \{/)
})
