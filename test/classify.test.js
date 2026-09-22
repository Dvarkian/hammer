/**
 * Error-classification tests for the "model is gone" rule.
 *
 * The dead verdict decides whether a row keeps its own Status or is struck into the graveyard,
 * so a provider phrase that belongs in this rule but is missing from it leaves a row reading
 * as a generic Down — and a Down row is retried forever instead of being set aside. These pin
 * the phrases that have been observed live, plus the transient failures that must NOT be read
 * as a catalog death.
 *
 * Kept in step with the client-side copy of this rule in `public/dashboard.js` (`rowVerdict`),
 * which has to classify rows whose stored evidence predates a change here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isDeadModelError } from '../lib/utils.js'

test('a listed model the upstream no longer serves is dead', () => {
  // SiliconFlow, verified live 2026-09-22 on Wan2.2 T2v: the id stays in /v1/models while
  // the backend refuses every call, so it is a statement about the catalog.
  assert.equal(isDeadModelError('Model does not exist. Please check it carefully.', 400), true)
})

test('410 Gone is dead whatever status spelling it arrives as', () => {
  assert.equal(isDeadModelError('', 410), true)
  assert.equal(isDeadModelError('', '410'), true)
})

test('a model retired by the provider is dead', () => {
  assert.equal(isDeadModelError('This model has reached its end of life.', 404), true)
  assert.equal(isDeadModelError('The model is archived and unavailable.', 400), true)
})

test('a transient failure is never read as a catalog death', () => {
  // The waiting states: they resolve on their own, so the row must keep its own Status.
  assert.equal(isDeadModelError('Request timed out after 60s.', 0), false)
  assert.equal(isDeadModelError('High demand, try again later.', 503), false)
  assert.equal(isDeadModelError('Too many requests.', 429), false)
  assert.equal(isDeadModelError('Resource exhausted.', 429), false)
})

test('a missing credential is not a catalog death', () => {
  assert.equal(isDeadModelError('Invalid API key provided.', 401), false)
})
