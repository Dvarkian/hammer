import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PiBridge } from '../lib/pi/bridge.js'
import { fitModelsToPrompt, isSummarizationRequest } from '../lib/utils.js'
import {
  PI_COMPACTION_DEFAULTS,
  declaredOutputBudget,
  hammerModelsConfig,
  summarizationOutputBudget,
} from '../lib/pi/agent-dir.js'
import {
  piBridgeForConsole,
  registerPiBridgeConsole,
  resetPiCompactionStreamsForTests,
} from '../lib/pi/compaction-stream.js'

const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
const harnessCss = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')
const proxy = readFileSync(new URL('../lib/http/routes/proxy.js', import.meta.url), 'utf8')

test('the summary text pi writes is forwarded only while a compaction runs', () => {
  // Pi emits compaction_start and compaction_end and nothing between them, so the transcript
  // learns the summary from the completion the router relays. The guard is what keeps an
  // ordinary turn from being filed as a summary.
  const bridge = new PiBridge({ autoContinue: false })
  try {
    /** @type {any[]} */
    const events = []
    bridge.on('event', (record) => events.push(record))

    bridge.noteCompactionText('not a summary yet')
    bridge.track({ type: 'compaction_start', reason: 'manual' })
    bridge.noteCompactionText('## Goal\n')
    bridge.noteCompactionText('Finish the spine art.')
    bridge.track({ type: 'compaction_end', reason: 'manual', result: {}, aborted: false })
    bridge.noteCompactionText('not a summary any more')

    assert.deepEqual(
      events.filter((record) => record.type === 'compaction_delta').map((record) => record.delta),
      ['## Goal\n', 'Finish the spine art.'],
    )
    // The replay log carries them too, so a page opened mid-compaction still shows the text.
    assert.equal(bridge.history().filter((record) => record.type === 'compaction_delta').length, 2)
  } finally {
    bridge.dispose()
  }
})

test('a console is reachable by the key its model configuration sends', () => {
  resetPiCompactionStreamsForTests()
  try {
    const config = hammerModelsConfig('http://127.0.0.1:7352/v1')
    const model = config.providers.hammer.models[0]
    // On the model, not the provider: Pi only carries model-level headers into a summary call.
    assert.equal(model.headers['X-Hammer-Pi-Console'], '7352')

    const bridge = { noteCompactionText() {} }
    assert.equal(registerPiBridgeConsole('7352', bridge), bridge)
    assert.equal(piBridgeForConsole('7352'), bridge)
    assert.equal(piBridgeForConsole('9999'), null)
    assert.equal(piBridgeForConsole(''), null)
  } finally {
    resetPiCompactionStreamsForTests()
  }
})

test('the transcript renders the summary while it streams', () => {
  assert.match(harness, /case 'compaction_delta':/)
  assert.match(harness, /item\.stream = clip\(\(item\.stream \|\| ''\) \+ delta, MAX_TEXT\)/)
  assert.match(harness, /data-compaction-stream/)
  assert.match(harness, /class="hx-compaction-stream"/)
  assert.match(harnessCss, /\.hx-compaction-stream \{/)
  // The preview is replaced by the finished summary, not left behind under it.
  assert.match(harness, /item\.stream = ''/)
})

test('the summary follows its own stream and is set as prose', () => {
  // The repaint replaces the stream's markup on every token; without restoring the scroll the
  // box snapped back to the top each time, so the newest line was never where the reader was.
  assert.match(harness, /const follow = !previous \|\| previous\.scrollHeight/)
  assert.match(harness, /stream\.scrollTop = follow \? stream\.scrollHeight/)
  // Prose, not a <pre>: a summary is read, not copied, so it keeps the transcript's face.
  assert.doesNotMatch(harness, /<pre class="hx-compaction/)
  assert.doesNotMatch(harnessCss, /\.hx-compaction-summary > pre/)
  // The row's own face is the mono one its head uses; the summary must not inherit it, or the
  // "prose" above still looks like shell output. Neither content block sets a family, so both
  // take the page's face, and neither keeps the pre-formatted whitespace of plain text.
  assert.doesNotMatch(harnessCss, /\.hx-compaction \{[^}]*font-family: var\(--hx-mono\)/)
  assert.doesNotMatch(
    harnessCss,
    /\.hx-compaction-summary \.hx-compaction-kept \{[^}]*white-space: pre-wrap;/,
  )
  assert.doesNotMatch(harnessCss, /\.hx-compaction-stream \{[^}]*white-space: pre-wrap;/)
  assert.match(harnessCss, /\.hx-compaction-stream \{[^}]*font-size: 0\.8rem;/)
  assert.match(
    harnessCss,
    /\.hx-compaction-summary \.hx-compaction-kept \{[^}]*font-size: 0\.8rem;/,
  )
  // Markdown, not escaped text: a summary arrives with headings and bullets, which the answer
  // renderer already knows how to set — and it escapes each leaf exactly once before any tag.
  assert.match(harness, /class="hx-compaction-kept">\$\{renderText\(/)
  assert.match(harness, /data-compaction-stream>\$\{renderText\(/)
  assert.doesNotMatch(harness, /hx-compaction-kept">\$\{escapeHtml\(/)
  assert.doesNotMatch(harness, /data-compaction-stream>\$\{escapeHtml\(/)
})

test('a compaction is a station on the spine, not a card beside it', () => {
  // A capacitor: two plates across the spine, each joined to the row's edge above and below.
  assert.match(harness, /function compactionIcon\(\)/)
  assert.match(harness, /M12 0v9M4 9h16M4 15h16M12 15v9/)
  assert.match(harness, /<span class="hx-compaction-icon" aria-hidden="true">/)

  // The row carries the same spine and the same 24px station box the tool rows use, so the
  // mark sits on the line instead of beside it.
  assert.match(harnessCss, /\.hx-row-compaction::before \{[^}]*top: 22px;/)
  assert.match(harnessCss, /\.hx-row-compaction::before \{[^}]*width: 2px;/)
  assert.match(harnessCss, /\.hx-compaction-icon \{[^}]*left: -23px;/)
  assert.match(harnessCss, /\.hx-compaction-icon \{[^}]*height: 24px;/)
  // No card: the border and the ground that made it read as a separate kind of thing are gone.
  assert.doesNotMatch(harnessCss, /\.hx-compaction \{[^}]*border: 1px solid/)
  assert.doesNotMatch(harnessCss, /\.hx-compaction \{[^}]*background: var\(--surface-alt\)/)
})

test('the alias never caps the summarization budget Pi plans', () => {
  // Pi asks for min(0.8 * reserveTokens, model.maxTokens) and fails a compaction outright when
  // the response stops on `length`. A declared cap below that formula silently truncates every
  // summary of a large session, so the declaration must sit above it.
  const model = hammerModelsConfig('http://127.0.0.1:7352/v1').providers.hammer.models[0]
  const budget = Math.floor(0.8 * PI_COMPACTION_DEFAULTS.reserveTokens)
  assert.ok(
    model.maxTokens > budget,
    `maxTokens ${model.maxTokens} must exceed Pi's summarization budget ${budget}`,
  )
  // A reserve the user raised must raise the declaration too, or the setting buys nothing.
  const generous = hammerModelsConfig('http://127.0.0.1:7352/v1', { reserveTokens: 65536 })
    .providers.hammer.models[0]
  assert.ok(generous.maxTokens > summarizationOutputBudget(65536))
  assert.equal(generous.maxTokens, declaredOutputBudget(65536))
})

test('a summarization is recognized where Pi actually puts its instruction', () => {
  // The shape Hammer really received: conversation, then the instruction, then the format
  // template. A detector that only read the tail saw none of these and left every summary
  // unrouted — 752k-character prompts went to 218k-token models and came back as one token.
  const payload = [
    { role: 'system', content: 'You are a coding agent.' },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<conversation>\n[Assistant]: working on it\n</conversation>\n\nThe messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\n## Goal\n- [What we are working on]\n\n## Critical Context\n- [Preserve important context]',
        },
      ],
    },
  ]
  assert.equal(isSummarizationRequest(payload), true)
  // The summarization system prompt is a signal on its own.
  assert.equal(
    isSummarizationRequest([
      { role: 'system', content: 'You are a context summarization assistant. Your task…' },
      { role: 'user', content: 'anything' },
    ]),
    true,
  )
  // An ordinary turn is not a summary.
  assert.equal(isSummarizationRequest([{ role: 'user', content: 'fix the build' }]), false)
  assert.equal(isSummarizationRequest([]), false)
})

test('a summary replayed in the history does not make every later turn a summary', () => {
  // A session that compacted once carries the old instruction quoted in its history. Reading
  // that as a live instruction routed every later turn as a summary — narrowed to the rows that
  // can hold the whole prompt — so a turn whose console showed one model could be served, and
  // refused with that row's 402, by another model entirely.
  const replayed = [
    { role: 'system', content: 'You are an expert coding assistant operating inside pi.' },
    {
      role: 'user',
      content:
        'The conversation history before this point was compacted into the following summary:\n' +
        '<summary>\nYou are a context summarization assistant.\n' +
        'The messages above are a conversation to summarize.\n</summary>',
    },
    { role: 'assistant', content: 'Now let me look at the rate-limit cell rendering.' },
    { role: 'tool', content: 'function rateLimitEvidence(m) { … }' },
    { role: 'user', content: 'Fix this: the error came from another model.' },
  ]
  assert.equal(isSummarizationRequest(replayed), false)
  // The instruction is still found where Pi puts it: in the last message, or as the system prompt.
  assert.equal(
    isSummarizationRequest([
      ...replayed.slice(0, 4),
      { role: 'user', content: 'The messages above are a conversation to summarize.' },
    ]),
    true,
  )
})

test('a payment wall benches the row and moves a router-chosen request on', () => {
  // A 402 is a verdict about the account, not a wait: the row takes the Paid verdict a manual
  // Test gives it, and a request the router chose tries another candidate instead of ending the
  // turn with an error from a model the console never showed (see markModelBudgetRefused).
  assert.match(proxy, /if \(isPaymentRequiredError\(bodyText, response\.status\)\) \{/)
  assert.match(proxy, /markModelBudgetRefused\(best, bodyText\)/)
  assert.match(
    proxy,
    /if \(isPaymentRequiredError\(bodyText, response\.status\)\) \{[\s\S]*?pendingCandidate = alternative[\s\S]*?attemptMeta\.retryable = true/,
  )
})

test('a model change is a station on the spine that names both ends', () => {
  // The glyph is two lines diverging, and it must join the spine at the row's edges the way a
  // tool glyph does: (12,0) at the top, (12,24) at the foot. The top stroke leaves to the
  // right, the bottom stroke arrives from the left.
  assert.match(harness, /function modelIcon\(\)/)
  assert.match(harness, /M12 0v4c0 3 3 4 8 4M4 16c5 0 8 1 8 4v4/)
  assert.match(harness, /<span class="hx-model-icon" aria-hidden="true">/)

  // The row carries the same spine and 24px station box as a tool row, so the mark is on the
  // line rather than beside it.
  assert.match(harnessCss, /\.hx-row-model::before \{[^}]*top: 22px;/)
  assert.match(harnessCss, /\.hx-row-model::before \{[^}]*width: 2px;/)
  assert.match(harnessCss, /\.hx-model-icon \{[^}]*left: -23px;/)
  assert.match(harnessCss, /\.hx-model-icon \{[^}]*height: 24px;/)

  // A change is its own row, not a plain notice, and it records where it came from.
  assert.match(harness, /if \(item\.kind === 'model'\) return modelMarkup\(item\)/)
  assert.match(harness, /kind: 'model',\s+from: previous,\s+to: model,/)
  // The station belongs to the transcript, not to a variable only the live stream fills: the row
  // records which model answered, so a restart can rebuild the same marks from the session's
  // messages instead of losing every change it did not watch happen.
  // The base is the previous message whether or not it left a row: a tool-call-only
  // message leaves none, and the row-based comparison redrew the same line every turn.
  assert.match(
    harness,
    /const previous = ctx\.lastAnswer\?\.model \|\| previousRow\?\.model \|\| null/,
  )
  assert.match(harness, /item\.kind === 'assistant' && item\.model/)
  assert.match(harness, /let previousModel = null/)
  assert.match(
    harness,
    /if \(model && previousModel && !sameAnswerIdentity\(ctx, previousModel, model\)\) \{/,
  )
  assert.match(harness, /kind: 'assistant', blocks: \[\], settled: false, model/)
  assert.match(harness, /changed from \$\{escapeHtml\(from\)\} to \$\{escapeHtml\(to\)\}/)
})

test('a model change names the provider at both ends', () => {
  // "Changed from gpt-5 to claude-sonnet-4.5" makes the reader ask who served each. The
  // provider is captured when the answer is recorded, so a route change cannot rewrite it.
  assert.match(harness, /function messageProviderName\(message, ctx\)/)
  assert.match(harness, /function modelWithProvider\(name, provider\)/)
  assert.match(harness, /const from = modelWithProvider\(item\.from, item\.fromProvider\)/)
  assert.match(harness, /const to = modelWithProvider\(item\.to, item\.toProvider\)/)
  assert.match(harness, /fromProvider: previousProvider,/)
  assert.match(harness, /kind: 'assistant', blocks: \[\], settled: false, model, provider/)
  // History rebuilds the same stations from the session, so it records the provider too.
  assert.match(harness, /fromProvider: previousProvider/)
  assert.match(harness, /kind: 'assistant', blocks, settled: true, model, provider/)
  // A provider already inside the model name is not repeated.
  assert.match(harness, /if \(!provider \|\| label\.toLowerCase\(\)\.includes/)
})

test('the router alias never becomes a transcript model name', () => {
  // Pi records Hammer's routing alias (`best`) on the request. The provider's
  // `responseModel` is the model that answered; when that is absent the live route resolves
  // the alias, and history leaves it unset rather than inventing today's pick for an old turn.
  assert.match(harness, /function isRouterAlias\(/)
  assert.match(harness, /function messageModelName\(/)
  assert.match(harness, /const model = messageModelName\(message, ctx\)/)
  assert.match(harness, /messageModelName\(message, ctx, \{ resolveAlias: false \}\)/)
  assert.match(harness, /if \(model\) noteAnsweredModel\(ctx, model\)/)
  assert.doesNotMatch(harness, /const model = message\.responseModel \|\| message\.model \|\| null/)
})

test('the composer follows the answered model, not only a status frame', () => {
  // A fallback can change the model that answers without a status frame carrying the new
  // routedModel. The assistant message is the evidence, so it updates the strip directly.
  assert.match(harness, /answeredModel: null/)
  assert.match(harness, /function noteAnsweredModel/)
  assert.match(harness, /ctx\.answeredModel = model/)
  assert.match(harness, /if \(ctx === active\(\)\) paintModelLabel\(ctx, ctx\.status\?\.model\)/)
  assert.match(harness, /function paintModelLabel/)
  assert.match(
    harness,
    /const shared = answered && routedNames\.includes\(answered\) \? routed : null/,
  )
  assert.match(harness, /viaEl\.hidden = Boolean\(answered \|\| routed\)/)
  assert.match(
    harness,
    /if \(ctx\.routedModelKey && key !== ctx\.routedModelKey\) ctx\.answeredModel = null/,
  )
})

test('a summarization is routed only to a model that can hold it', () => {
  // The observed failure: a 213,516-token summary prompt sent to a model with a 126,798-token
  // window, which answers `length` with no text, and Pi reports that as its own output cap.
  const rows = [
    { modelId: 'too-small', contextTokens: 126798 },
    { modelId: 'short-by-a-bit', contextTokens: 262000 },
    { modelId: 'holds-it', contextTokens: 1000000 },
    { modelId: 'unknown-window', contextTokens: null },
  ]
  assert.deepEqual(
    fitModelsToPrompt(rows, 213516, 13107).map((row) => row.modelId),
    ['holds-it'],
  )
  // Nothing can hold it: the pool is left alone rather than emptied. The request is too large
  // then, and hiding that from the caller only moves the failure somewhere less legible.
  assert.equal(fitModelsToPrompt([rows[0]], 213516, 13107).length, 1)
  // A request with no size to measure is not narrowed at all.
  assert.equal(fitModelsToPrompt(rows, 0).length, rows.length)

  assert.match(proxy, /const summarization = isSummarizationRequest\(payload\.messages\)/)
  assert.match(proxy, /fitModelsToPrompt\(\s*pickPool\(\),/)
})

test('the proxy taps the stream and names the console it belongs to', () => {
  assert.match(proxy, /piBridgeForConsole\(compactionConsole\)/)
  assert.match(proxy, /createCompactionTap\(compactionBridge\)/)
  assert.match(proxy, /bridge\.noteCompactionText\(delta\.content\)/)
})

test('a prose-less message still counts as the previous model', () => {
  // Every message in a tool-heavy run can be tool-call-only, and `message_end` drops those
  // rows on purpose. Comparing against surviving rows alone therefore kept finding the one
  // old row that had prose and redrew the same "changed from" line on every turn while the
  // agent answered on one model throughout. The base is the previous message, not the
  // previous row; history hands the live stream the same base after a rebuild.
  assert.match(
    harness,
    /const previous = ctx\.lastAnswer\?\.model \|\| previousRow\?\.model \|\| null/,
  )
  assert.match(harness, /const previousProvider = ctx\.lastAnswer\?\.model/)
  assert.match(harness, /if \(model\) ctx\.lastAnswer = \{ model, provider \}/)
  assert.match(harness, /ctx\.lastAnswer = previousModel/)
  assert.match(
    harness,
    /ctx\.lastAnswer = \{ model: reported, provider: messageProviderName\(message, ctx\) \}/,
  )
})
