import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getPinnedAttemptLimit,
  getPinnedModelCandidate,
  getPinnedModelMatches,
  normalizePinnedSelection,
  toPinnedRowKey,
} from '../lib/server.js';
import { buildModelGroups } from '../lib/utils.js';
import { canonicalizeModelId, MODEL_ID_ALIASES } from '../sources.js';

function row(providerKey, modelId, label, ms = 100) {
  return {
    providerKey,
    modelId,
    label,
    status: 'up',
    pings: [{ ms, code: '200', ts: Date.now() }],
    rateLimit: null,
  };
}

test('a heading pin resolves the complete canonical model family', () => {
  const rows = [
    row('alpha', 'vendor/shared-model', 'Shared Model', 80),
    row('beta', 'shared-model', 'Shared Model', 120),
    row('gamma', 'shared-model:free', 'Shared Model', 160),
    row('other', 'unrelated-model', 'Unrelated Model', 40),
  ];
  const selection = normalizePinnedSelection({ modelId: 'vendor/shared-model', groupKey: 'shared-model' });

  assert.deepEqual(selection, {
    modelId: 'vendor/shared-model',
    providerKey: null,
    groupKey: 'shared-model',
    scope: 'family',
  });
  assert.deepEqual(
    getPinnedModelMatches(rows, selection).map(toPinnedRowKey),
    ['alpha::vendor/shared-model', 'beta::shared-model', 'gamma::shared-model:free'],
  );
});

test('server grouping keeps size-distinct model families separate across alias spellings', () => {
  const rows = [
    row('groq', 'openai/gpt-oss-120b', 'GPT OSS 120B'),
    row('ollama', 'gpt-oss:120b', 'GPT OSS 120B'),
    row('groq', 'openai/gpt-oss-20b', 'GPT OSS 20B'),
    row('ollama', 'gpt-oss:20b', 'GPT OSS 20B'),
    row('other', 'gpt-oss-safeguard-20b', 'GPT OSS Safeguard 20B'),
  ];

  const groups = buildModelGroups(rows, canonicalizeModelId);
  assert.deepEqual(
    groups.map(group => ({ id: group.id, models: group.models.map(model => model.modelId) })),
    [
      { id: 'gpt-oss-120b', models: ['openai/gpt-oss-120b', 'gpt-oss:120b'] },
      { id: 'gpt-oss-20b', models: ['openai/gpt-oss-20b', 'gpt-oss:20b'] },
      { id: 'gpt-oss-safeguard-20b', models: ['gpt-oss-safeguard-20b'] },
    ],
  );
});

test('server grouping applies the shared alias catalog across model families', () => {
  const families = [
    ['gpt-oss:20b', 'openai/gpt-oss-20b'],
    ['gpt-oss:120b', 'openai/gpt-oss-120b'],
    ['glm-4.7', 'z-ai/glm4.7'],
    ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
    ['qwen3:32b', 'qwen/qwen3-32b'],
    ['xai-z/grok-4-fast', 'grok-4-fast'],
  ];
  for (const [alias, canonical] of families) {
    assert.equal(MODEL_ID_ALIASES[alias], canonical, `${alias} must remain in the shared catalog`);
    const groups = buildModelGroups([
      row('alias-provider', alias, 'Alias row'),
      row('canonical-provider', canonical, 'Canonical row'),
    ], canonicalizeModelId);
    assert.equal(groups.length, 1, `${alias} and ${canonical} must share one group`);
  }
});

test('the dashboard consumes server model groups instead of rebuilding model identity', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');

  assert.match(server, /modelGroupId: modelGroupByRowKey/);
  assert.match(server, /modelGroupLabel: modelGroupByRowKey/);
  assert.match(dashboard, /m\.modelGroupId/);
  assert.match(dashboard, /m\.modelGroupLabel/);
});

test('a family pin includes provider-qualified rows that share one raw model id', () => {
  const rows = [
    row('openai-compatible:first', 'same-id', 'Same ID', 80),
    row('openai-compatible:second', 'same-id', 'Same ID', 90),
  ];
  const groups = buildModelGroups(rows, canonicalizeModelId);
  assert.equal(groups.length, 2, 'exact provider addressing stays separate');

  const family = getPinnedModelMatches(rows, { modelId: 'same-id', groupKey: 'same-id' });
  assert.deepEqual(family.map(toPinnedRowKey), [
    'openai-compatible:first::same-id',
    'openai-compatible:second::same-id',
  ]);
  assert.deepEqual(
    getPinnedModelMatches(rows, { modelId: 'same-id', providerKey: 'openai-compatible:second' }).map(toPinnedRowKey),
    ['openai-compatible:second::same-id'],
  );
});

test('pin normalization rejects malformed field types instead of widening or clearing', () => {
  assert.throws(() => normalizePinnedSelection({ modelId: 123 }), /modelId must be a string/);
  assert.throws(
    () => normalizePinnedSelection({ modelId: 'shared-model', providerKey: { bad: true } }),
    /providerKey must be a string/,
  );
  assert.throws(
    () => normalizePinnedSelection({ modelId: 'shared-model', groupKey: ['bad'] }),
    /groupKey must be a string/,
  );
});

test('an exact pin requires and resolves exactly one provider/model row', () => {
  const rows = [
    row('alpha', 'shared-model', 'Shared Model', 80),
    row('beta', 'shared-model', 'Shared Model', 90),
    row('gamma', 'shared-model', 'Shared Model', 100),
  ];

  assert.deepEqual(getPinnedModelMatches(rows, { modelId: 'shared-model', scope: 'exact' }), []);
  assert.deepEqual(
    getPinnedModelMatches(rows, { modelId: 'shared-model', providerKey: 'beta' }).map(toPinnedRowKey),
    ['beta::shared-model'],
  );
  assert.throws(
    () => normalizePinnedSelection({ modelId: 'shared-model', providerKey: 'beta', groupKey: 'shared-model' }),
    /cannot name both/,
  );
});

test('a family retry advances by provider/model key instead of excluding the shared model id', () => {
  const rows = [
    row('alpha', 'shared-model', 'Shared Model', 70),
    row('beta', 'shared-model', 'Shared Model', 90),
    row('gamma', 'shared-model', 'Shared Model', 110),
  ];
  const selection = { modelId: 'shared-model', groupKey: 'shared-model', scope: 'family' };
  const attempted = ['alpha/shared-model'];

  const candidate = getPinnedModelCandidate(rows, selection, attempted);
  assert.equal(candidate?.providerKey, 'beta');
  assert.deepEqual(
    getPinnedModelMatches(rows, selection)
      .filter(candidateRow => !attempted.includes(`${candidateRow.providerKey}/${candidateRow.modelId}`))
      .map(toPinnedRowKey),
    ['beta::shared-model', 'gamma::shared-model'],
  );
});

test('family pins receive an attempt budget covering every provider row', () => {
  const family = { modelId: 'shared-model', groupKey: 'shared-model', scope: 'family' };
  const exact = { modelId: 'shared-model', providerKey: 'alpha', scope: 'exact' };

  assert.equal(getPinnedAttemptLimit(family, new Array(8)), 7);
  assert.equal(getPinnedAttemptLimit(family, new Array(3)), 5);
  assert.equal(getPinnedAttemptLimit(exact, new Array(1)), 5);
  assert.equal(getPinnedAttemptLimit(null, []), 5);
});

test('an unavailable family or exact target resolves to no rows', () => {
  const rows = [row('alpha', 'shared-model', 'Shared Model')];
  assert.deepEqual(getPinnedModelMatches(rows, { modelId: 'missing', groupKey: 'missing' }), []);
  assert.deepEqual(getPinnedModelMatches(rows, { modelId: 'shared-model', providerKey: 'missing' }), []);
});

test('the dashboard derives pin scope from heading versus provider-row controls', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(dashboard, /data-pin-group=/);
  assert.match(dashboard, /data-pin-provider=/);
  assert.doesNotMatch(dashboard, /name="pinning-mode"/);
  assert.match(dashboard, /pinMutationQueue/);
  assert.match(dashboard, /confirmedPinnedState/);
  assert.match(dashboard, /function isExactPinnedRow/);
  assert.match(dashboard, /function isFamilyPinnedGroup/);
  assert.match(dashboard, /members\.some\(model => activePinnedRowKeys\.includes\(getModelRowKey\(model\)\)\)/);
  assert.doesNotMatch(dashboard, /console\.error\('Failed to pin model'/);
  assert.doesNotMatch(dashboard, /server session and reset when Hammer restarts/i);
  assert.doesNotMatch(index, /exact, no-fallback pin/i);
});

test('Test All is a sequential main-table flow and excludes unavailable rows', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8');

  assert.match(index, /id="test-all-btn" onclick="testAll\(\)"/);
  assert.match(index, /Test All/);
  assert.doesNotMatch(index, /Rerun Tests/);
  assert.match(dashboard, /function testableMainGroups\(\)/);
  assert.match(dashboard, /splitDisplayGroups\(sortedGroups\(groupModels\(filtered\)\)\)\.mainGroups/);
  assert.match(dashboard, /function buildTestAllQueue\(\)/);
  assert.match(dashboard, /if \(isRowUp\(model\)\) continue/);
  assert.match(dashboard, /async function testAll\(\)/);
  assert.match(dashboard, /await runTestAllItem\(/);
  assert.match(dashboard, /async function testModelGroupButton\(/);
  assert.match(dashboard, /testModelGroupButton/);
  assert.match(dashboard, /members = opts\.members[\s\S]{0,500}isRowUp\(m\)/);
  assert.match(dashboard, /row\.classList\.add\('row-testing'\)/);
  assert.match(dashboard, /row\?\.classList\.remove\('row-testing'\)/);
  assert.match(css, /tr\.row-testing td/);
  assert.match(css, /var\(--warning\)/);
  assert.doesNotMatch(dashboard, /\/api\/restest-models/);
  assert.doesNotMatch(dashboard, /rerunTests|restestJobId|updateRerunButtonVisibility/);
});

test('a live fallback is painted across the dashboard before the next snapshot', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  assert.match(dashboard, /payload\.type === 'selection' && payload\.source === 'fallback'/)
  assert.match(dashboard, /currentBestModelId = payload\.modelId/)
  assert.match(dashboard, /currentBestProviderKey = payload\.providerKey/)
  assert.match(dashboard, /render\(\);\s*updateKPIs\(allModels, currentBestModelId, currentBestProviderKey\);/)
  assert.match(dashboard, /payload\.type === 'evidence'/)
  assert.match(dashboard, /routerEventRevisionAtStart !== routerEventRevision/)
  assert.match(dashboard, /function updateKPIs\(models, bestModelId, bestProviderKey = null\)/)
  assert.match(dashboard, /m\.providerKey === bestProviderKey/)
})

test('the scatter renders a full-size dot only for a currently routable row', () => {
  const dashboard = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8')
  const pointsStart = dashboard.indexOf('function drawScatterPoints(')
  const pointsEnd = dashboard.indexOf('function drawScatterLabels(', pointsStart)
  assert.ok(pointsStart >= 0 && pointsEnd > pointsStart, 'the scatter point renderer must exist')

  const points = dashboard.slice(pointsStart, pointsEnd)
  assert.match(points, /const routable = isRoutableRow\(r\)/)
  assert.match(points, /svgEl\('circle', routable \? \{/)
  assert.doesNotMatch(points, /const up = isRowUp\(r\.m\)/)
  assert.match(dashboard, /if \(!isRoutableRow\(r\)\) p -= 400/)

  // A live failure or provider bench often changes no speed or intelligence number.
  // The redraw guard must therefore include both the displayed verdict and the server's
  // routing decision, or the prior full-size SVG survives the health transition.
  assert.match(dashboard, /\|v=\$\{rowVerdict\(r\.m\)\}\|route=\$\{routing\}/)
  assert.match(dashboard, /const routing = typeof r\.m\.routingEligible === 'boolean' \? r\.m\.routingEligible : 'legacy'/)

  // Verdict windows can expire on their own, without a fetch. The existing one-second
  // status ticker re-evaluates the guarded draw so that transition is rendered promptly.
  const tickerStart = dashboard.indexOf('function updateRateLimitCountdowns()')
  const tickerEnd = dashboard.indexOf('setInterval(updateRateLimitCountdowns', tickerStart)
  assert.ok(tickerStart >= 0 && tickerEnd > tickerStart, 'the status ticker must exist')
  assert.match(dashboard.slice(tickerStart, tickerEnd), /drawSpeedIntellScatter\(allModels\)/)
})

test('the request path resolves a pin after discovery and retains the final family failure', () => {
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');
  const discovery = server.indexOf('const requestedModels = await resolveRequestModels({');
  const pinnedMatches = server.indexOf('const requestPinnedMatches = getPinnedModelMatches(results, requestPinnedSelection);', discovery);
  assert.ok(discovery >= 0 && pinnedMatches > discovery, 'pin matches must be resolved after awaited discovery');
  assert.match(server, /retainFailedPinnedResponse\(response, attemptMeta\.duration\)/);
  assert.match(server, /response\.clone\(\)\.text\(\)/);
  assert.match(server, /fallback: !isPinnedModel\(best\)/);
});
