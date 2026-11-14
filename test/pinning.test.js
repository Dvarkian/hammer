import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  getPinnedAttemptLimit,
  getPinnedModelCandidate,
  getPinnedModelMatches,
  normalizePinnedSelection,
  toPinnedRowKey,
} from '../lib/server.js'
import { buildModelGroups } from '../lib/utils.js'
import { canonicalizeModelId, MODEL_ID_ALIASES } from '../sources.js'
import { serverSource } from './support/server-source.js'

function row(providerKey, modelId, label, ms = 100) {
  return {
    providerKey,
    modelId,
    label,
    status: 'up',
    pings: [{ ms, code: '200', ts: Date.now() }],
    rateLimit: null,
  }
}

test('a heading pin resolves the complete canonical model family', () => {
  const rows = [
    row('alpha', 'vendor/shared-model', 'Shared Model', 80),
    row('beta', 'shared-model', 'Shared Model', 120),
    row('gamma', 'shared-model:free', 'Shared Model', 160),
    row('other', 'unrelated-model', 'Unrelated Model', 40),
  ]
  const selection = normalizePinnedSelection({
    modelId: 'vendor/shared-model',
    groupKey: 'shared-model',
  })

  assert.deepEqual(selection, {
    modelId: 'vendor/shared-model',
    providerKey: null,
    groupKey: 'shared-model',
    scope: 'family',
  })
  assert.deepEqual(getPinnedModelMatches(rows, selection).map(toPinnedRowKey), [
    'alpha::vendor/shared-model',
    'beta::shared-model',
    'gamma::shared-model:free',
  ])
})

test('server grouping keeps size-distinct model families separate across alias spellings', () => {
  const rows = [
    row('groq', 'openai/gpt-oss-120b', 'GPT OSS 120B'),
    row('ollama', 'gpt-oss:120b', 'GPT OSS 120B'),
    row('groq', 'openai/gpt-oss-20b', 'GPT OSS 20B'),
    row('ollama', 'gpt-oss:20b', 'GPT OSS 20B'),
    row('other', 'gpt-oss-safeguard-20b', 'GPT OSS Safeguard 20B'),
  ]

  const groups = buildModelGroups(rows, canonicalizeModelId)
  assert.deepEqual(
    groups.map((group) => ({ id: group.id, models: group.models.map((model) => model.modelId) })),
    [
      { id: 'gpt-oss-120b', models: ['openai/gpt-oss-120b', 'gpt-oss:120b'] },
      { id: 'gpt-oss-20b', models: ['openai/gpt-oss-20b', 'gpt-oss:20b'] },
      { id: 'gpt-oss-safeguard-20b', models: ['gpt-oss-safeguard-20b'] },
    ],
  )
})

test('a "Thinking" suffix is the same model on a reasoning route, not a second heading', () => {
  // The gateways list the reasoning route as its own id — `caw/glm-5.3-flash-thinking:free`
  // beside `caw/glm-5.3-flash:free`, `kimi-k2-thinking` beside `kimi-k2` — while the model
  // reasons either way. Two headings split one model's providers, allowance and traffic across
  // rows that cannot be compared; a lone trailing `T` (g4f's spelling) is the same marker.
  const rows = [
    row('crowllm', 'caw/glm-5.3-flash:free', 'Glm 5.3 Flash'),
    row('crowllm', 'caw/glm-5.3-flash-thinking:free', 'Glm 5.3 Flash Thinking'),
    row('g4f', 'DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash'),
    row('g4f', 'DeepSeek-V4.1-Flash-T', 'DeepSeek V4.1 Flash T'),
    // A real variant keeps its own heading: the marker is a lone trailing token.
    row('other', 'glm-5.3-flash-thinking-pro', 'Glm 5.3 Flash Thinking Pro'),
  ]

  const groups = buildModelGroups(rows, canonicalizeModelId)
  const groupOf = (modelId) =>
    groups.find((group) => group.models.some((model) => model.modelId === modelId))

  assert.equal(groupOf('caw/glm-5.3-flash-thinking:free'), groupOf('caw/glm-5.3-flash:free'))
  assert.equal(groupOf('DeepSeek-V4.1-Flash-T'), groupOf('DeepSeek-V4.1-Flash'))
  assert.notEqual(groupOf('glm-5.3-flash-thinking-pro'), groupOf('caw/glm-5.3-flash:free'))
  // The heading is the plain name, not the route marker.
  assert.equal(groupOf('caw/glm-5.3-flash-thinking:free').label, 'Glm 5.3 Flash')
})

test('server grouping applies the shared alias catalog across model families', () => {
  const families = [
    ['gpt-oss:20b', 'openai/gpt-oss-20b'],
    ['gpt-oss:120b', 'openai/gpt-oss-120b'],
    ['glm-4.7', 'z-ai/glm4.7'],
    ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
    ['qwen3:32b', 'qwen/qwen3-32b'],
    ['xai-z/grok-4-fast', 'grok-4-fast'],
  ]
  for (const [alias, canonical] of families) {
    assert.equal(MODEL_ID_ALIASES[alias], canonical, `${alias} must remain in the shared catalog`)
    const groups = buildModelGroups(
      [
        row('alias-provider', alias, 'Alias row'),
        row('canonical-provider', canonical, 'Canonical row'),
      ],
      canonicalizeModelId,
    )
    assert.equal(groups.length, 1, `${alias} and ${canonical} must share one group`)
  }
})

test('a relay alias groups under the model it actually resolved to', () => {
  const rows = [
    row('kilocode', 'kilo-auto/free', 'kilo-auto/free'),
    row('kilocode', 'openrouter/free', 'openrouter/free'),
    row('kilocode', 'nvidia/nemotron-3.5-super-vl:free', 'Nemotron 3.5 Super Vl 120b A12b'),
    row('kilocode', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra'),
  ]
  // The resolution the router captured from live responses, not a hardcoded alias.
  rows[0].realModelId = 'nvidia/nemotron-3.5-super-vl:free'
  rows[0].realModelLabel = 'Nemotron 3.5 Super Vl'
  rows[1].realModelId = 'nvidia/nemotron-3-ultra-550b-a55b:free'
  rows[1].realModelLabel = 'Nemotron 3 Ultra'

  const groups = buildModelGroups(rows, canonicalizeModelId)
  const groupOf = (modelId) =>
    groups.find((group) => group.models.some((model) => model.modelId === modelId))

  assert.equal(groups.length, 2)
  assert.equal(groupOf('kilo-auto/free'), groupOf('nvidia/nemotron-3.5-super-vl:free'))
  assert.equal(groupOf('openrouter/free'), groupOf('nvidia/nemotron-3-ultra-550b-a55b:free'))
  assert.notEqual(groupOf('kilo-auto/free'), groupOf('openrouter/free'))
  assert.match(groupOf('kilo-auto/free').label, /^Nemotron 3\.5 Super Vl/)
  assert.doesNotMatch(groupOf('kilo-auto/free').label, /[/:_]/)
  assert.equal(groupOf('openrouter/free').label, 'Nemotron 3 Ultra')
})

test('a relay alias joins a group that also learned another upstream spelling', () => {
  const rows = [
    row('kilocode', 'kilo-auto/free', 'kilo-auto/free'),
    row('kilocode', 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3.5-super-vl:free'),
    row('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'Nemotron 3.5 Super Vl 120b A12b'),
  ]
  rows[0].realModelId = 'nvidia/nemotron-3.5-super-vl:free'
  rows[0].realModelLabel = 'Nemotron 3.5 Super Vl'
  rows[2].realModelId = 'private/nvidia/nemotron-3.5-super-120b-a12b'
  rows[2].realModelLabel = 'Nemotron 3.5 Super 120b A12b'

  const groups = buildModelGroups(rows, canonicalizeModelId)
  const groupOf = (modelId) =>
    groups.find((group) => group.models.some((model) => model.modelId === modelId))

  assert.equal(groups.length, 1)
  assert.equal(groupOf('kilo-auto/free'), groupOf('nvidia/nemotron-3.5-super-vl:free'))
  assert.equal(groupOf('kilo-auto/free'), groupOf('nvidia/nemotron-3.5-super-vl-120b-a12b'))
  assert.match(groupOf('kilo-auto/free').label, /^Nemotron 3\.5 Super Vl/)
  assert.doesNotMatch(groupOf('kilo-auto/free').label, /[/:_]/)
})

test('a relay alias follows a changed upstream resolution', () => {
  const rows = [
    row('kilocode', 'kilo-auto/free', 'kilo-auto/free'),
    row('kilocode', 'nvidia/nemotron-3.5-super-vl:free', 'Nemotron 3.5 Super Vl 120b A12b'),
    row('kilocode', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra'),
  ]
  rows[0].realModelId = 'nvidia/nemotron-3-ultra-550b-a55b:free'
  rows[0].realModelLabel = 'Nemotron 3 Ultra'

  const groups = buildModelGroups(rows, canonicalizeModelId)
  const groupOf = (modelId) =>
    groups.find((group) => group.models.some((model) => model.modelId === modelId))

  assert.equal(groupOf('kilo-auto/free'), groupOf('nvidia/nemotron-3-ultra-550b-a55b:free'))
  assert.notEqual(groupOf('kilo-auto/free'), groupOf('nvidia/nemotron-3.5-super-vl:free'))
  assert.equal(groupOf('kilo-auto/free').label, 'Nemotron 3 Ultra')
})

test('ollama beam joins the measured Beam family in one group', () => {
  // Ollama publishes the same weights under its bare model name while KiloCode calls it
  // `reflection/beam-free`; both alias to the measured `reflection/beam-1.0-501b-a23b`.
  assert.equal(MODEL_ID_ALIASES.beam, 'reflection/beam-1.0-501b-a23b')
  assert.equal(MODEL_ID_ALIASES['beam:latest'], 'reflection/beam-1.0-501b-a23b')

  const groups = buildModelGroups(
    [
      row('kilocode', 'reflection/beam-free', 'reflection/beam-free'),
      row('ollama', 'beam', 'Beam'),
    ],
    canonicalizeModelId,
  )
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].models.map((model) => model.modelId).sort(), [
    'beam',
    'reflection/beam-free',
  ])
})

test('the dashboard consumes server model groups instead of rebuilding model identity', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const server = serverSource

  assert.match(server, /modelGroupId: modelGroupByRowKey/)
  assert.match(server, /modelGroupLabel: modelGroupByRowKey/)
  assert.match(dashboard, /m\.modelGroupId/)
  assert.match(dashboard, /m\.modelGroupLabel/)
})

test('a relay alias that resolved to a model is grouped under that model', () => {
  const rows = [
    {
      providerKey: 'bazaarlink',
      modelId: 'auto:free',
      label: 'Auto Router',
      realModelId: 'deepseek/deepseek-v4-flash-0731free',
    },
    { providerKey: 'gptfree', modelId: 'auto', label: 'Auto (GPTFree)' },
    {
      providerKey: 'bazaarlink',
      modelId: 'deepseek/deepseek-v4-flash-0731free:free',
      label: 'DeepSeek V4 Flash 0731',
    },
  ]
  const groups = buildModelGroups(rows, canonicalizeModelId)
  const served = groups.find((group) => group.models.some((model) => model.modelId === 'auto:free'))
  assert.ok(served, 'the resolving row keeps a heading')
  assert.ok(
    served.models.some((model) => model.modelId === 'deepseek/deepseek-v4-flash-0731free:free'),
    'it sits with the model that served it',
  )
  assert.equal(
    served.models.some((model) => model.modelId === 'auto'),
    false,
    'the router heading keeps only rows that never resolved',
  )
  assert.match(served.label, /DeepSeek/i)

  // An alias whose backend has no group of its own stays under the router heading.
  const lone = buildModelGroups(
    [
      {
        providerKey: 'bazaarlink',
        modelId: 'auto:free',
        label: 'Auto Router',
        realModelId: 'stealth/secret-model',
      },
      { providerKey: 'gptfree', modelId: 'auto', label: 'Auto (GPTFree)' },
    ],
    canonicalizeModelId,
  )
  assert.ok(lone.some((group) => group.models.some((model) => model.modelId === 'auto:free')))
})

test('a family pin includes provider-qualified rows that share one raw model id', () => {
  const rows = [
    row('openai-compatible:first', 'same-id', 'Same ID', 80),
    row('openai-compatible:second', 'same-id', 'Same ID', 90),
  ]
  const groups = buildModelGroups(rows, canonicalizeModelId)
  assert.equal(groups.length, 2, 'exact provider addressing stays separate')

  const family = getPinnedModelMatches(rows, { modelId: 'same-id', groupKey: 'same-id' })
  assert.deepEqual(family.map(toPinnedRowKey), [
    'openai-compatible:first::same-id',
    'openai-compatible:second::same-id',
  ])
  assert.deepEqual(
    getPinnedModelMatches(rows, {
      modelId: 'same-id',
      providerKey: 'openai-compatible:second',
    }).map(toPinnedRowKey),
    ['openai-compatible:second::same-id'],
  )
})

test('pin normalization rejects malformed field types instead of widening or clearing', () => {
  assert.throws(() => normalizePinnedSelection({ modelId: 123 }), /modelId must be a string/)
  assert.throws(
    () => normalizePinnedSelection({ modelId: 'shared-model', providerKey: { bad: true } }),
    /providerKey must be a string/,
  )
  assert.throws(
    () => normalizePinnedSelection({ modelId: 'shared-model', groupKey: ['bad'] }),
    /groupKey must be a string/,
  )
})

test('an exact pin requires and resolves exactly one provider/model row', () => {
  const rows = [
    row('alpha', 'shared-model', 'Shared Model', 80),
    row('beta', 'shared-model', 'Shared Model', 90),
    row('gamma', 'shared-model', 'Shared Model', 100),
  ]

  assert.deepEqual(getPinnedModelMatches(rows, { modelId: 'shared-model', scope: 'exact' }), [])
  assert.deepEqual(
    getPinnedModelMatches(rows, { modelId: 'shared-model', providerKey: 'beta' }).map(
      toPinnedRowKey,
    ),
    ['beta::shared-model'],
  )
  assert.throws(
    () =>
      normalizePinnedSelection({
        modelId: 'shared-model',
        providerKey: 'beta',
        groupKey: 'shared-model',
      }),
    /cannot name both/,
  )
})

test('a family retry advances by provider/model key instead of excluding the shared model id', () => {
  const rows = [
    row('alpha', 'shared-model', 'Shared Model', 70),
    row('beta', 'shared-model', 'Shared Model', 90),
    row('gamma', 'shared-model', 'Shared Model', 110),
  ]
  const selection = { modelId: 'shared-model', groupKey: 'shared-model', scope: 'family' }
  const attempted = ['alpha/shared-model']

  const candidate = getPinnedModelCandidate(rows, selection, attempted)
  assert.equal(candidate?.providerKey, 'beta')
  assert.deepEqual(
    getPinnedModelMatches(rows, selection)
      .filter(
        (candidateRow) =>
          !attempted.includes(`${candidateRow.providerKey}/${candidateRow.modelId}`),
      )
      .map(toPinnedRowKey),
    ['beta::shared-model', 'gamma::shared-model'],
  )
})

test('family pins receive an attempt budget covering every provider row', () => {
  const family = { modelId: 'shared-model', groupKey: 'shared-model', scope: 'family' }
  const exact = { modelId: 'shared-model', providerKey: 'alpha', scope: 'exact' }

  assert.equal(getPinnedAttemptLimit(family, new Array(8)), 7)
  assert.equal(getPinnedAttemptLimit(family, new Array(3)), 5)
  assert.equal(getPinnedAttemptLimit(exact, new Array(1)), 5)
  assert.equal(getPinnedAttemptLimit(null, []), 5)
})

test('an unavailable family or exact target resolves to no rows', () => {
  const rows = [row('alpha', 'shared-model', 'Shared Model')]
  assert.deepEqual(getPinnedModelMatches(rows, { modelId: 'missing', groupKey: 'missing' }), [])
  assert.deepEqual(
    getPinnedModelMatches(rows, { modelId: 'shared-model', providerKey: 'missing' }),
    [],
  )
})

test('the dashboard derives pin scope from heading versus provider-row controls', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(dashboard, /data-pin-group=/)
  assert.match(dashboard, /data-pin-provider=/)
  assert.doesNotMatch(dashboard, /name="pinning-mode"/)
  assert.match(dashboard, /pinMutationQueue/)
  assert.match(dashboard, /confirmedPinnedState/)
  assert.match(dashboard, /function isExactPinnedRow/)
  assert.match(dashboard, /function isFamilyPinnedGroup/)
  assert.match(
    dashboard,
    /members\.some\(model => activePinnedRowKeys\.includes\(getModelRowKey\(model\)\)\)/,
  )
  assert.doesNotMatch(dashboard, /console\.error\('Failed to pin model'/)
  assert.doesNotMatch(dashboard, /server session and reset when Hammer restarts/i)
  assert.doesNotMatch(index, /exact, no-fallback pin/i)
})

test('Test All is a sequential main-table flow and excludes unavailable rows', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8')

  assert.match(index, /id="test-all-btn" onclick="testAll\(\)"/)
  assert.match(index, /Test All/)
  assert.doesNotMatch(index, /Rerun Tests/)
  assert.match(dashboard, /function testableMainGroups\(\)/)
  assert.match(
    dashboard,
    /splitDisplayGroups\(sortedGroups\(groupModels\(filtered\)\)\)\.mainGroups/,
  )
  assert.match(dashboard, /function buildTestAllQueue\(\)/)
  assert.match(dashboard, /if \(isRowUp\(model\)\) continue/)
  assert.match(dashboard, /async function testAll\(\)/)
  assert.match(dashboard, /await runTestAllItem\(/)
  assert.match(dashboard, /async function testModelGroupButton\(/)
  assert.match(dashboard, /testModelGroupButton/)
  assert.match(dashboard, /members = opts\.members[\s\S]{0,500}isRowUp\(m\)/)
  assert.match(dashboard, /row\.classList\.add\('row-testing'\)/)
  assert.match(dashboard, /row\?\.classList\.remove\('row-testing'\)/)
  assert.match(css, /tr\.row-testing td/)
  assert.match(css, /var\(--warning\)/)
  assert.doesNotMatch(dashboard, /\/api\/restest-models/)
  assert.doesNotMatch(dashboard, /rerunTests|restestJobId|updateRerunButtonVisibility/)
})

test('a live fallback is painted across the dashboard before the next snapshot', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  assert.match(dashboard, /payload\.type === 'selection' && payload\.source === 'fallback'/)
  assert.match(dashboard, /currentBestModelId = payload\.modelId/)
  assert.match(dashboard, /currentBestProviderKey = payload\.providerKey/)
  assert.match(
    dashboard,
    /render\(\);\s*updateKPIs\(allModels, currentBestModelId, currentBestProviderKey\);/,
  )
  assert.match(dashboard, /payload\.type === 'evidence'/)
  assert.match(dashboard, /routerEventRevisionAtStart !== routerEventRevision/)
  assert.match(dashboard, /function updateKPIs\(models, bestModelId, bestProviderKey = null\)/)
  // The routed pair reaches the picture through drawPlots' own lookup. The "Current" readout that
  // used to read it as well is gone, so the assertion follows the pair into the plot instead.
  assert.match(dashboard, /m\.providerKey === effectiveKey/)
})

test('the slope plot lives in the composer popup, not on the router page', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  // Removing the card is the point: the plot, its dots and its minimums are the composer's
  // now, and a second copy on the router page would be a second thing to keep in step.
  assert.doesNotMatch(html, /speed-intell-svg|speed-intell-count/)
  assert.doesNotMatch(dashboard, /drawSpeedIntellScatter|drawScatterPoints|drawSelectorOverlay/)
  const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(harness, /function slopePlotMarkup\(percent\)/)
  assert.match(harness, /const SLOPE_PLOT_REFERENCE_TOKENS = 500/)
})

test('the request path resolves a pin after discovery and retains the final family failure', () => {
  const server = serverSource
  const discovery = server.indexOf('const requestedModels = await resolveRequestModels({')
  // The pin is resolved against the row set the awaited discovery just produced.
  // `results` reaches the handler through the route context, so the argument is
  // `ctx.results` now; the ordering this asserts is unchanged.
  const pinnedMatches = server.indexOf(
    'const requestPinnedMatches = getPinnedModelMatches(ctx.results, requestPinnedSelection)',
    discovery,
  )
  assert.ok(
    discovery >= 0 && pinnedMatches > discovery,
    'pin matches must be resolved after awaited discovery',
  )
  assert.match(server, /retainFailedPinnedResponse\(response, attemptMeta\.duration\)/)
  assert.match(server, /response\.clone\(\)\.text\(\)/)
  assert.match(server, /fallback: !isPinnedModel\(best\)/)
})

test('a build stamp on a model id groups under the family it snapshots', () => {
  // BazaarLink, OrcaRouter, TokenHarbor, Requesty and ollama all list the October build of this
  // model beside its plain id ("DeepSeek V4.1 Flash 1017" / "deepseek-v4.1-flash-1017"), so the
  // dashboard showed the same weights twice under two headings. A stamp is a snapshot of the
  // family, not a sibling — unlike `-1017-fast`, which names a different serving mode.
  const rows = [
    row('puter', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
    row('orcarouter', 'deepseek/deepseek-v4.1-flash', 'DeepSeek: DeepSeek V4.1 Flash'),
    row('orcarouter', 'deepseek/deepseek-v4.1-flash-1017', 'DeepSeek: DeepSeek V4.1 Flash 1017'),
    row('tokenharbor', 'deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017'),
    row('ollama', 'deepseek-v4.1-flash:1017', 'Deepseek V4.1 Flash:1017'),
    row('tokenharbor', 'deepseek-v4.1-flash-1017-fast', 'Deepseek V4.1 Flash 1017 Fast'),
  ]
  const groups = buildModelGroups(rows, canonicalizeModelId)
  const groupOf = (modelId) =>
    groups.find((group) => group.models.some((model) => model.modelId === modelId))
  assert.equal(groupOf('deepseek/deepseek-v4.1-flash-1017'), groupOf('deepseek-v4.1-flash'))
  assert.equal(groupOf('deepseek-v4.1-flash:1017'), groupOf('deepseek-v4.1-flash'))
  assert.notEqual(groupOf('deepseek-v4.1-flash-1017-fast'), groupOf('deepseek-v4.1-flash'))
  // The heading is the family, not the snapshot that happened to bring more providers.
  assert.equal(groupOf('deepseek-v4.1-flash').label, 'DeepSeek V4.1 Flash')
})

test("a mirror's route suffix groups under the model it serves", () => {
  // g4f's Poe mirror lists "DeepSeek-V4.1-Flash-T" beside the plain id every other provider
  // carries. The bot name describes how the mirror reaches those weights, not different
  // weights, so the dashboard showed one model twice — once with 8 providers and once with 2.
  const rows = [
    row('puter', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
    row('nvidia', 'deepseek-ai/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
    row('g4f', 'srv_mtsj8uzo97d3c0d49960:poe/DeepSeek-V4.1-Flash-T', 'DeepSeek V4.1 Flash T'),
    row('g4f', 'srv_mv57e8714aedb1a00bf8:poe/DeepSeek-V4.1-Flash-T', 'DeepSeek V4.1 Flash T'),
  ]
  const groups = buildModelGroups(rows, canonicalizeModelId)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, 'DeepSeek V4.1 Flash')
  assert.equal(groups[0].models.length, 4)
})
