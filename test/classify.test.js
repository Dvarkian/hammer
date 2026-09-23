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

import { extractErrorMessage, isDeadModelError, summarizeErrorDetails } from '../lib/utils.js'

test('an error envelope is flattened to its message, wherever the message is nested', () => {
  // The shapes observed live, each of which had to be read or a provider's own words were lost.
  assert.equal(
    extractErrorMessage({ message: 'A valid API key is required' }),
    'A valid API key is required',
  )
  assert.equal(extractErrorMessage({ error: 'Service temporarily overloaded' }), 'Service temporarily overloaded')
  assert.equal(
    extractErrorMessage({ error: { errors: [{ message: 'AiError: rate limiting: inference request per min rate reached' }], success: false } }),
    'AiError: rate limiting: inference request per min rate reached',
  )
  assert.equal(extractErrorMessage({ status: 'Down for maintenance' }), 'Down for maintenance')
  assert.equal(extractErrorMessage(''), null)
})

test('an error that tells you to check the details carries them', () => {
  // Pollinations' validation envelope, captured live 2026-09-23. The message alone is an
  // instruction with nothing to follow: "Something was wrong with the input data, check the
  // details for more info." The details beside it name the field that failed, and that field is
  // the difference between a diagnosable refusal and a Support ticket.
  const validationFailure = {
    success: false,
    error: {
      message: 'Something was wrong with the input data, check the details for more info.',
      code: 'BAD_REQUEST',
      timestamp: '2026-09-23T01:44:12.898Z',
      details: {
        name: 'ValidationError',
        formErrors: [],
        fieldErrors: { messages: ['Invalid input: expected array, received undefined'] },
      },
    },
    status: 400,
  }
  assert.equal(
    extractErrorMessage(validationFailure.error),
    'Something was wrong with the input data, check the details for more info. (messages: Invalid input: expected array, received undefined)',
  )

  // A validator can report several fields, and a form-level error with no field at all.
  assert.equal(
    summarizeErrorDetails({ fieldErrors: { model: ['Required'], temperature: ['Too high'] } }),
    'model: Required; temperature: Too high',
  )
  assert.equal(summarizeErrorDetails({ formErrors: ['Body must be an object'] }), 'Body must be an object')
  assert.equal(summarizeErrorDetails('no such model'), 'no such model')
  assert.equal(summarizeErrorDetails(undefined), null)
  assert.equal(summarizeErrorDetails({}), null)
})

test('a message with no details beside it is passed through untouched', () => {
  // The same Pollinations message arrives with no `details` at all on the g4f route that relayed
  // it (captured live 2026-09-23), which is who the instruction is useless to. Nothing is
  // invented and no empty parentheses are appended — an absent detail is the provider's to fix.
  const relayed = {
    message: 'Something was wrong with the input data, check the details for more info.',
    code: 'BAD_REQUEST',
    timestamp: '2026-09-23T01:27:45.608Z',
  }
  assert.equal(
    extractErrorMessage(relayed),
    'Something was wrong with the input data, check the details for more info.',
  )
  // And a details object with nothing readable in it adds nothing either.
  assert.equal(extractErrorMessage({ message: 'Refused', details: { name: 'ValidationError' } }), 'Refused')
})

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
