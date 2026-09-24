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
import { canonicalizeModelId } from '../sources.js';

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
  assert.match(dashboard, /server session and reset when Hammer restarts/i);
  assert.match(index, /exact, no-fallback pin/i);
});

test('the request path resolves a pin after discovery and retains the final family failure', () => {
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');
  const discovery = server.indexOf('const requestedModels = await resolveRequestModels({');
  const pinnedMatches = server.indexOf('const requestPinnedMatches = getPinnedModelMatches(results, requestPinnedSelection);', discovery);
  assert.ok(discovery >= 0 && pinnedMatches > discovery, 'pin matches must be resolved after awaited discovery');
  assert.match(server, /retainFailedPinnedResponse\(response, attemptMeta\.duration\)/);
  assert.match(server, /response\.clone\(\)\.text\(\)/);
  assert.match(server, /fallback: !isPinnedModel\(best\)/);
});
