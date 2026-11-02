// @ts-check
/**
 * Switching a provider off.
 *
 * The flag lives on the provider's own config (`providers[key].enabled`) and is only ever
 * written as `false`, so these tests pin both halves of that contract: an absent flag means the
 * provider is on, and an explicit `false` is what takes it out of routing. The row status half
 * matters just as much — a provider is disabled for the router because its rows carry
 * `disabled`, which is the status the selection helpers already refuse.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isProviderEnabled } from '../lib/config.js'
import { isModelEligibleForRouting, resolveModelStatus } from '../lib/utils.js'

test('a provider is on unless its own config says otherwise', () => {
  assert.equal(isProviderEnabled({}, 'groq'), true, 'no provider config at all means on')
  assert.equal(isProviderEnabled({ providers: {} }, 'groq'), true)
  assert.equal(isProviderEnabled({ providers: { groq: {} } }, 'groq'), true, 'no flag means on')
  assert.equal(isProviderEnabled({ providers: { groq: { enabled: true } } }, 'groq'), true)
  assert.equal(isProviderEnabled({ providers: { groq: { enabled: false } } }, 'groq'), false)

  // Instances are providers in their own right, so the same switch reaches them.
  const instance = 'openai-compatible:default'
  assert.equal(
    isProviderEnabled({ providers: { [instance]: { enabled: false } } }, instance),
    false,
  )

  // The flag is a routing decision, not a teardown: the credential stays where it is.
  const disabledWithKey = { apiKeys: { groq: 'gsk_x' }, providers: { groq: { enabled: false } } }
  assert.equal(isProviderEnabled(disabledWithKey, 'groq'), false)
  assert.equal(disabledWithKey.apiKeys.groq, 'gsk_x')

  // One provider's switch cannot reach another's.
  assert.equal(isProviderEnabled({ providers: { groq: { enabled: false } } }, 'cerebras'), true)
})

test('a disabled row is unroutable and says so, whatever its probe history', () => {
  const row = { status: 'disabled', providerKey: 'groq', modelId: 'llama-3.3-70b' }
  assert.equal(isModelEligibleForRouting(row), false)
  // A row that served traffic before the switch keeps that history; the switch outranks it, so
  // the table cannot advertise a provider the router is refusing.
  assert.equal(resolveModelStatus({ ...row, lastResponse: { at: Date.now() } }), 'disabled')

  // The control: the same row switched back on is eligible again, and it is the probe that decides
  // what it reads as — the switch only ever removes the row from selection.
  assert.equal(isModelEligibleForRouting({ status: 'up', providerKey: 'groq', modelId: 'x' }), true)
})
