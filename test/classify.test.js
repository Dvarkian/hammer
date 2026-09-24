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

import {
  accumulateOutputCapObservation,
  deriveContextState,
  extractErrorMessage,
  isBlockedModelName,
  isContextOverflowErrorText,
  isDeadModelError,
  isIncompatibleModelError,
  isModelEligibleForRouting,
  isFallbackSelectionActive,
  isOutputCapOnlyErrorText,
  isPaymentRequiredError,
  isRequestTooLargeErrorText,
  parseContextLimitFromError,
  parseMaxTokensCapFromError,
  permanentTestVerdict,
  resolveModelStatus,
  resolveContextUpperBound,
  resolveOutputBudgetCap,
  resolveRefusalVerdict,
  resolveSelectionSource,
  selectModelBySlope,
  revalidateOutputCap,
  summarizeErrorDetails,
  withOutputBudgetCap,
} from '../lib/utils.js'

test('a model whose id names a non-chat family is incompatible by name', () => {
  // The rule reads the id because that is all a row has before it has been asked anything, and
  // because these models can answer a liveness probe perfectly well.
  for (const id of [
    'nvidia/riva-translate-4b-instruct',
    'nvidia/riva-translate-4b-instruct-v1.1',
    'nvidia/riva-translate-4b-instruct-v2',
    'models/gemini-3.5-live-translate-preview',
    'some/translation-model',
    'vendor/translator-8b',
    'vendor/calibration-suite',
    'vendor/saudi-chat',
    'vendor/whisper-audio-large',
    'vendor/search-preview',
    'github/copilot-search-c',
    'openai/gpt-4-search-preview',
  ]) {
    assert.equal(isBlockedModelName(id), true, `${id} names a non-chat family`)
  }
  // Negative controls: the families are substrings, not vibes, so ordinary chat ids stay
  // routable — including ones that merely look similar.
  for (const id of [
    'gpt-5.6-sol',
    'claude-sonnet-4.5',
    'moonshotai/kimi-k2.7-code',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'qwen/qwen3.8-27b',
    '',
    null,
  ]) {
    assert.equal(isBlockedModelName(id), false, `${id} is a chat model`)
  }
})

test('the name rule outranks a successful probe, in every place that reads it', () => {
  // NVIDIA's riva-translate-4b-instruct-v2 answered a probe with a healthy 200 and sat in the
  // table reading Up and routable, while every request sent to it was a translation rather than
  // the chat that was asked for. A test that squeezes a completion out of such a row must not
  // promote it, so the three consumers are pinned together.
  const now = Date.now()
  const row = {
    modelId: 'nvidia/riva-translate-4b-instruct-v2',
    providerKey: 'nvidia',
    status: 'up',
    lastResponse: { ok: true, text: 'Hallo Welt', status: 200, at: now, error: null },
  }
  assert.equal(resolveModelStatus(row, now), 'incompatible')
  assert.equal(isModelEligibleForRouting(row), false)

  // The negative control: the same row without the name would be Up and routable, so this is the
  // name rule doing the work rather than the row being unsuited for another reason.
  const chatRow = { ...row, modelId: 'nvidia/nemotron-3-ultra-550b-a55b' }
  assert.equal(resolveModelStatus(chatRow, now), 'up')
  assert.equal(isModelEligibleForRouting(chatRow), true)

  const searchRow = { ...row, modelId: 'github/copilot-search-c' }
  assert.equal(resolveModelStatus(searchRow, now), 'incompatible')
  assert.equal(isModelEligibleForRouting(searchRow), false)
})

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
  // A provider validation envelope, captured live 2026-09-23. The message alone is an
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
  // The same message can arrive with no `details` at all on a relayed route (captured live
  // 2026-09-23), which is who the instruction is useless to. Nothing is
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

test('a provider that says the row does not serve chat is incompatible', () => {
  // llm7 keeps listing its image/video ids (Seedance and friends) among the chat models it
  // serves, and answers every one of them with HTTP 400: "Model 'seedance-2.0-fast' does not
  // support chat endpoints." (live 2026-09-22). That is the provider's own statement about what
  // the row *is*, not a report that something went wrong this once, so it belongs beside the
  // image/video-only and terms-acceptance refusals instead of on a red Down dot that reads as
  // broken and invites a retry which cannot succeed.
  const now = Date.now()
  const row = {
    modelId: 'seedance-2.0-fast',
    providerKey: 'llm7',
    status: 'up',
    lastResponse: {
      ok: false,
      text: null,
      status: 400,
      error: "Model 'seedance-2.0-fast' does not support chat endpoints.",
      at: now,
    },
  }
  assert.equal(resolveModelStatus(row, now), 'incompatible')
  assert.equal(isIncompatibleModelError("Model 'seedance-2.0-fast' does not support chat endpoints.", 400), true)
  // The status does not decide it: the same words on a 200 are the same statement.
  assert.equal(resolveModelStatus({ ...row, lastResponse: { ...row.lastResponse, status: 200 } }, now), 'incompatible')

  // Negative controls: a request refused for its own content is still just Down — the phrase has
  // to name chat rather than merely contain the word support — and a transient failure keeps its
  // own verdict rather than borrowing this one.
  assert.equal(
    resolveModelStatus({ ...row, lastResponse: { ...row.lastResponse, error: 'Model does not support the temperature parameter.' } }, now),
    'down',
  )
  assert.equal(
    isIncompatibleModelError('Model does not support the temperature parameter.'),
    false,
  )
  assert.equal(
    resolveModelStatus({ ...row, lastResponse: { ...row.lastResponse, status: 504, error: 'Request timed out after 60s.' } }, now),
    'timeout',
  )
})

test('a verdict no window can reopen retires the clock it was sitting on', () => {
  // api-airforce answers every paid model with HTTP 402 and "Model 'pixverse-modify' requires an
  // active subscription or a positive Pay-As-You-Go balance …" (live 2026-09-23). Rows it had
  // benched earlier kept their clock straight through that Test: a bench was only ever retired by
  // a *successful* response, and a payment wall is not one, so the row advertised a countdown to
  // a window that would reopen nothing — over the one thing that would fix it. The same held for
  // a tombstone and for a model that does not serve chat.
  const now = Date.now()
  const paymentWall = "Model 'pixverse-modify' requires an active subscription or a positive Pay-As-You-Go balance. Subscribe or top up at https://api.airforce/dashboard, or pick a free model from https://api.airforce/models."
  const bench = { wasRateLimited: true, capturedAt: now - 5 * 60_000, resetRequestsAt: now + 60 * 60_000 }
  const benched = {
    modelId: 'pixverse-modify',
    providerKey: 'api-airforce',
    status: 'rate-limited',
    rateLimit: bench,
    lastResponse: { ok: false, text: null, status: 402, error: paymentWall, at: now, paymentRequired: true },
  }
  assert.equal(permanentTestVerdict(benched.lastResponse), 'paid')
  assert.equal(permanentTestVerdict({ error: 'Request timed out after 60s.', status: 504 }), null)
  assert.equal(resolveModelStatus(benched, now), 'paid')

  // The same response with nowhere to put the flag: the words alone are the verdict.
  const textOnly = { ...benched, lastResponse: { ...benched.lastResponse, paymentRequired: undefined } }
  assert.equal(resolveModelStatus(textOnly, now), 'paid')

  // Ordering is what keeps this honest. A bench captured *after* the response is the newer
  // observation and keeps its clock, and a live success newer than both still wins outright.
  assert.equal(resolveModelStatus({ ...benched, rateLimit: { ...bench, capturedAt: now + 1000 } }, now), 'rate-limited')
  assert.equal(resolveModelStatus({ ...benched, lastProxiedAt: now + 1000 }, now), 'up')

  // The other waiting states give way on the same terms: a tombstone and a non-chat refusal.
  const tombstone = {
    modelId: 'wan2.2-t2v',
    providerKey: 'siliconflow',
    status: 'dead',
    rateLimit: bench,
    lastResponse: { ok: false, text: null, status: 400, error: 'Model does not exist. Please check it carefully.', at: now },
  }
  assert.equal(resolveModelStatus(tombstone, now), 'dead')
  assert.equal(resolveModelStatus({ ...tombstone, modelId: 'seedance-2.0-fast', status: 'up', lastResponse: { ...tombstone.lastResponse, error: "Model 'seedance-2.0-fast' does not support chat endpoints." } }, now), 'incompatible')
  const overloaded = { ...tombstone, status: 'overloaded', lastError: { updatedAt: now - 1000 } }
  assert.equal(resolveModelStatus(overloaded, now), 'dead')
  // ... but not when the overload is the newer statement.
  assert.equal(resolveModelStatus({ ...overloaded, lastError: { updatedAt: now + 1000 } }, now), 'overloaded')
})

test('a permanent verdict a probe recorded is honored even with no test response', () => {
  // pingModel and the proxy's markModelBudgetRefused record what they saw on the row's `status`,
  // with the message on `lastError` — neither writes a lastResponse. Reading only the test-based
  // rules above is why a model a ping found behind a paywall, or one the proxy marked 402, came
  // back as a generic Down that no refresh corrected.
  const now = Date.now()
  const probed = {
    modelId: 'qwen-coder-plus',
    providerKey: 'api-airforce',
    status: 'paid',
    lastError: { code: '402', message: "Model 'qwen-coder-plus' requires an active subscription or a positive Pay-As-You-Go balance.", updatedAt: now },
  }
  assert.equal(resolveModelStatus(probed, now), 'paid')
  assert.equal(resolveModelStatus({ ...probed, status: 'dead' }, now), 'dead')
  assert.equal(resolveModelStatus({ ...probed, status: 'incompatible' }, now), 'incompatible')
  // A passing Test supersedes it, which is the same thing that clears the flag on the row itself.
  assert.equal(resolveModelStatus({ ...probed, lastResponse: { ok: true, text: 'Hello', status: 200, at: now + 1000 } }, now), 'up')
  // And a state the probe did not report is still not invented from lastError alone.
  assert.equal(resolveModelStatus({ ...probed, status: 'down' }, now), 'down')
})

test('a refusal earns one verdict, whatever path met it', () => {
  // The classification a live request's failure must be able to reuse: the same words produce the
  // same verdict whether a Test click met them or the router did while serving a turn. Before
  // this, a proxied failure was recorded as nothing at all, so the row stayed healthy (and kept
  // being selected) while every request silently failed over to another model.
  assert.equal(resolveRefusalVerdict("Model 'pixverse-modify' requires an active subscription or a positive Pay-As-You-Go balance.", 402), 'paid')
  assert.equal(resolveRefusalVerdict('Model does not exist. Please check it carefully.', 400), 'dead')
  assert.equal(resolveRefusalVerdict("Model 'seedance-2.0-fast' does not support chat endpoints.", 400), 'incompatible')
  assert.equal(resolveRefusalVerdict('Rate limit exceeded. Please try again later.', 429), 'rate-limited')
  assert.equal(resolveRefusalVerdict('Too many requests.', 400), 'rate-limited')
  assert.equal(resolveRefusalVerdict('Model is overloaded right now.', 503), 'overloaded')
  assert.equal(resolveRefusalVerdict('Invalid API key provided.', 401), 'noauth')
  assert.equal(resolveRefusalVerdict('Request timed out after 60s.', 0), 'timeout')
  assert.equal(resolveRefusalVerdict('The request could not reach the provider.', 0), 'down')
  assert.equal(resolveRefusalVerdict('Unsupported parameter: tool_choice.', 400), 'down')
})

test('fallback evidence remains relevant only while the model it replaced cannot', () => {
  // The router moved off this model mid-request because the model refused it. That move is a
  // selection change, so it is shown in the KPI and both plots — and it lasts exactly as long as
  // its reason does. A throttled model coming back is the case that ends it: the selection is a
  // claim about which model should serve, and a model that is serving again has a claim of its own.
  const rows = [
    { providerKey: 'googleai', modelId: 'models/gemini-3.5-flash-lite', status: 'down' },
    { providerKey: 'openrouter', modelId: 'nex-agi/nex-n2.5-mini:free', status: 'up' },
  ];
  const selection = {
    modelId: 'nex-agi/nex-n2.5-mini:free',
    providerKey: 'openrouter',
    fromModelId: 'models/gemini-3.5-flash-lite',
    fromProviderKey: 'googleai',
  };
  assert.equal(isFallbackSelectionActive(selection, rows), true)

  // The model it replaced is serving again: the override has done its job.
  const recovered = rows.map(r => (r.modelId === 'models/gemini-3.5-flash-lite' ? { ...r, status: 'up' } : r))
  assert.equal(isFallbackSelectionActive(selection, recovered), false)

  // The fallback row itself failed too — nothing left to protect.
  const fallbackFailed = rows.map(r => (r.providerKey === 'openrouter' ? { ...r, status: 'rate-limited' } : r))
  assert.equal(isFallbackSelectionActive(selection, fallbackFailed), false)

  // A row the router will not route is not a row this may hand it, however 'up' it reads.
  assert.equal(isFallbackSelectionActive(selection, rows, (r) => r.providerKey !== 'openrouter'), false)

  // The model it replaced is gone from the list (a provider refresh), and no selection at all.
  assert.equal(isFallbackSelectionActive(selection, [rows[1]]), false)
  assert.equal(isFallbackSelectionActive(null, rows), false)
})

test('a failed slope winner falls through to the next slope candidate', () => {
  // The retry path must re-run the same slope rule with the failed model excluded. A fallback
  // is evidence that this model answered the previous request; it is not a new selection rule.
  const rows = [
    { modelId: 'failed', providerKey: 'a', status: 'up', aa: 90, ttft: 100, tps: 1000 },
    { modelId: 'next-slope', providerKey: 'b', status: 'up', aa: 80, ttft: 100, tps: 800 },
    { modelId: 'intelligence-best', providerKey: 'c', status: 'up', aa: 99, ttft: 1000, tps: 100 },
  ];
  const first = selectModelBySlope(rows, { slope: 1 });
  assert.equal(first.model.modelId, 'failed');
  const retry = selectModelBySlope(rows, { slope: 1, excludeModelIds: ['failed'] });
  assert.equal(retry.model.modelId, 'next-slope');
  // With no slope line, the ordinary intelligence ranking is the fallback.
  const ranked = rows.filter(r => r.status === 'up').sort((a, b) => b.aa - a.aa)[0];
  assert.equal(ranked.modelId, 'intelligence-best');
})

test('a fallback does not become the current selection after it is recorded', () => {
  // The server keeps fallback metadata for observability, but selection precedence is now
  // always pin > slope > ranking. This utility models the part of that contract that can be
  // pinned without booting the server: a fallback is not an argument to resolveSelectionSource.
  assert.equal(resolveSelectionSource({ slope: { modelId: 'slope-winner' }, ranked: { modelId: 'ranking-winner' } }), 'slope');
  assert.equal(resolveSelectionSource({ pinned: { modelId: 'pin' }, slope: { modelId: 'slope' }, ranked: { modelId: 'rank' } }), 'pin');
})

test('the selection names which rule chose the current model', () => {
  // The page draws one selection in two plots (and the KPI), so it has to be able to say which
  // rule produced it. A fallback is observability metadata and cannot become the current rule.
  assert.equal(resolveSelectionSource({ fallback: { a: 1 }, pinned: { b: 1 }, slope: { c: 1 }, ranked: { d: 1 } }), 'pin')
  assert.equal(resolveSelectionSource({ pinned: { b: 1 }, slope: { c: 1 }, ranked: { d: 1 } }), 'pin')
  assert.equal(resolveSelectionSource({ slope: { c: 1 }, ranked: { d: 1 } }), 'slope')
  assert.equal(resolveSelectionSource({ ranked: { d: 1 } }), 'ranked')
  assert.equal(resolveSelectionSource({}), null)
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

test('an unfunded account is Paid, not a quota on a clock', () => {
  // SiliconFlow answers a Test with HTTP 200 and the completion "Sorry, your account balance is
  // insufficient" (live 2026-09-23), which is an account refusal like a key-budget notice and
  // was read as one: the row went on the clock with a countdown to a window that never
  // reopens, over the one thing that would fix it — money. Nothing about the model is exhausted.
  const now = Date.now()
  const row = {
    modelId: 'qwen/qwen3.8-27b',
    providerKey: 'siliconflow',
    status: 'rate-limited',
    lastResponse: {
      ok: false,
      text: null,
      status: 200,
      error: 'Sorry, your account balance is insufficient',
      at: now,
    },
  }
  assert.equal(resolveModelStatus(row, now), 'paid')
  assert.equal(isPaymentRequiredError('Sorry, your account balance is insufficient', 200), true)
  assert.equal(isPaymentRequiredError('insufficient balance', 0), true)
  assert.equal(isPaymentRequiredError('Your credit balance is too low for this request.', 0), true)

  // Negative controls: a balance that is fine is not a wall, and neither is the free credit
  // allowance a quest refills — free credits are not money, so they keep their clock — nor the
  // key budget that is raised rather than topped up.
  assert.equal(isPaymentRequiredError('You have enough balance on your account to continue.', 0), false)
  assert.equal(isPaymentRequiredError("The account behind this API key doesn't have enough credits. Please top up or complete a quest, then try again.", 200), false)
  assert.equal(isPaymentRequiredError('The API key used for this request has reached its budget. Please raise the key budget, then try again.', 200), false)
  assert.equal(isPaymentRequiredError('A balance is a scale that measures mass.', 0), false)
})

// --- The output ceilings providers actually state -------------------------------------------
//
// Every body below is one Hammer has really been handed. Each one used to be delivered to the
// caller as a fatal 400 — the refusal was about *our* payload, not about the model, but nothing
// recognized it: no ceiling was learned (so the next request was illegal again), and the retry
// loop saw a non-retryable status (so the turn ended on the first attempt instead of failing
// over). Cohere's wording killed three consecutive turns of a Freebuff thread that way.

const COHERE_TOO_MANY_TOKENS = '{"error_type":"TOO_MANY_TOKENS","message":"too many tokens: max tokens must be less than or equal to 4096, the maximum output length for this model - received 393216."}'
const OLLAMA_TOO_MANY_TOKENS = '{"error":{"message":"max_tokens (393216) exceeds model\'s maximum output tokens (131072) for model nemotron-3-nano:30b"}}'
const GROQ_MAX_TOKENS_CAP = '`max_tokens` must be less than or equal to `16384`, the maximum value for `max_tokens` is less than the `context_window` for this model'
const GROQ_REDUCE_LENGTH = '{"error":{"message":"Please reduce the length of the messages or completion.","param":"messages"}}'
const OPENROUTER_CONTEXT = '{"error":{"message":"This endpoint\'s maximum context length is 262144 tokens. However, you requested about 406789 tokens (4228 of text input, 9345 of tool input, 393216 in the output)."}}'
const GROQ_OTPM_QUOTA = 'Request too large for model X in organization Y service tier Z on output tokens per minute (OTPM): Limit 1000, Requested 1413'
const VLLM_MODEL_LEN = 'max_tokens=16384 cannot be greater than max_model_len=max_total_tokens=8192'
const SEEDANCE_NO_CHAT = '{"error":{"message":"Model \'seedance-2.0-fast\' does not support chat endpoints."}}'

test('a stated output ceiling is read in every wording providers use', () => {
  // Cohere writes the noun as prose ("max tokens", "output length") and names the ceiling
  // before the number that was asked for.
  assert.equal(parseMaxTokensCapFromError(COHERE_TOO_MANY_TOKENS), 4096)
  // Ollama puts the requested budget in parentheses and the real ceiling after the verb; the
  // first number is what the caller asked for (393216), which would clamp to nothing.
  assert.equal(parseMaxTokensCapFromError(OLLAMA_TOO_MANY_TOKENS), 131072)
  // Groq's backticked form, which the old rules already read — kept as a regression pin.
  assert.equal(parseMaxTokensCapFromError(GROQ_MAX_TOKENS_CAP), 16384)
  // The shapes that follow the noun instead of preceding it.
  assert.equal(parseMaxTokensCapFromError('max_tokens: 393216 is greater than the maximum allowed 4096'), 4096)
  assert.equal(parseMaxTokensCapFromError('maxOutputTokens must be <= 65536'), 65536)
  assert.equal(parseMaxTokensCapFromError('maximum output tokens for this model is 4096'), 4096)
  assert.equal(parseMaxTokensCapFromError('Invalid max_tokens: must be <= 8192'), 8192)
  assert.equal(parseMaxTokensCapFromError(VLLM_MODEL_LEN), 8192)
})

test('a context statement and a throughput quota can never become an output ceiling', () => {
  // The whole point of learning a ceiling is that it trims every answer to that model: the
  // number must be the model's, never the request's, and never a quota.
  assert.equal(parseMaxTokensCapFromError(OPENROUTER_CONTEXT), null)
  assert.equal(parseContextLimitFromError(OPENROUTER_CONTEXT), 262144)
  assert.equal(parseMaxTokensCapFromError(GROQ_OTPM_QUOTA), null)
  // A body that is merely prose about budgets states no ceiling, and a refusal that is about
  // the model (it cannot take chat at all) states none either.
  assert.equal(parseMaxTokensCapFromError('An answer that mentions max tokens and output length.'), null)
  assert.equal(parseMaxTokensCapFromError(SEEDANCE_NO_CHAT), null)
})

test('a refusal of our payload is failed over, a refusal of the model is not', () => {
  // Failover-facing reading: every body that says our request does not fit this model, whether
  // or not it states a number.
  for (const body of [COHERE_TOO_MANY_TOKENS, OLLAMA_TOO_MANY_TOKENS, GROQ_MAX_TOKENS_CAP, GROQ_REDUCE_LENGTH, OPENROUTER_CONTEXT, GROQ_OTPM_QUOTA]) {
    assert.equal(isRequestTooLargeErrorText(body), true, body)
  }
  // A model that cannot serve chat is a fact about the model: swapping in another model would
  // hide it, and the row already gets its Incompatible verdict.
  assert.equal(isRequestTooLargeErrorText(SEEDANCE_NO_CHAT), false)
})

test('an output ceiling is evidence about the budget, never about the context window', () => {
  // recordContextObservation may only learn a ceiling from a context statement. Reading Cohere's
  // "maximum output length" as one would bound a row's window by its answer length.
  for (const body of [COHERE_TOO_MANY_TOKENS, OLLAMA_TOO_MANY_TOKENS, GROQ_MAX_TOKENS_CAP]) {
    assert.equal(isOutputCapOnlyErrorText(body), true, body)
    assert.equal(isContextOverflowErrorText(body), false, body)
    assert.equal(parseContextLimitFromError(body), null, body)
  }
  // The vLLM body names both, and the context cap is the one that may be recorded.
  assert.equal(parseContextLimitFromError(VLLM_MODEL_LEN), 8192)
})

test('a learned ceiling survives revalidation, and a quota-read one does not', () => {
  const cohere = accumulateOutputCapObservation(null, { cap: 4096, evidence: COHERE_TOO_MANY_TOKENS })
  assert.equal(cohere.maxOutputTokens, 4096)
  assert.equal(revalidateOutputCap(cohere).maxOutputTokens, 4096)
  // A number a previous build read out of a throughput quota is withdrawn at startup rather
  // than trimming that model's answers to 1000 tokens for good.
  const misread = { maxOutputTokens: 1000, maxOutputTokensEvidence: { text: GROQ_OTPM_QUOTA, parserVersion: 1, at: Date.now() } }
  assert.equal(revalidateOutputCap(misread).maxOutputTokens, undefined)
})

test('the budget a row can accept is the tightest fact known about it', () => {
  // A stated ceiling needs no window, a window needs no ceiling, and the tighter of the two
  // wins — the prompt's own room is what remains of the window.
  assert.equal(resolveOutputBudgetCap({ learnedCap: 4096 }), 4096)
  assert.equal(resolveOutputBudgetCap({ contextTokens: 4096, promptTokens: 500 }), 3596)
  assert.equal(resolveOutputBudgetCap({ learnedCap: 4096, contextTokens: 262144, promptTokens: 13573 }), 4096)
  assert.equal(resolveOutputBudgetCap({ learnedCap: 131072, contextTokens: 262144, promptTokens: 13573 }), 131072)
  // A row the router knows nothing about is left alone rather than given an invented ceiling.
  assert.equal(resolveOutputBudgetCap({}), null)
  assert.equal(resolveOutputBudgetCap({ learnedCap: null, contextTokens: null, promptTokens: 9000 }), null)
  // A prompt that already fills the window leaves no room; asking for zero tokens is not a
  // request any provider can answer, so the clamp floors and the request fails over instead.
  assert.equal(resolveOutputBudgetCap({ contextTokens: 4096, promptTokens: 20000 }), 256)
  // And the clamp only ever lowers what the caller asked for.
  assert.equal(withOutputBudgetCap({ max_tokens: 393216 }, 3596).body.max_tokens, 3596)
  assert.equal(withOutputBudgetCap({ max_tokens: 393216 }, 3596).applied, true)
  assert.equal(withOutputBudgetCap({ max_tokens: 100 }, 3596).applied, false)
})

test('a window ceiling is read from above, never from a lower bound', () => {
  // Cohere's row carries contextMin 6 — the smallest prompt that ever got through — and no
  // catalog window. deriveContextState shows that as the row's context, which is right for the
  // table and wrong for a clamp: using it capped a 4096-token model's answers at 256.
  assert.equal(deriveContextState(null, { contextMin: 6 }).tokens, 6)
  assert.equal(resolveContextUpperBound(null, { contextMin: 6 }), null)
  // A stated window is one, from either source, and the tighter of the two wins.
  assert.equal(resolveContextUpperBound('4k', { contextMin: 6 }), 4000)
  assert.equal(resolveContextUpperBound('262144', { contextMax: 262144, contextMaxExact: true }), 262144)
  // An observed maximum is the size of a prompt the model refused, so the window is at most
  // that — exact or not.
  assert.equal(resolveContextUpperBound('256k', { contextMax: 4096, contextMaxExact: false }), 4096)
  assert.equal(resolveContextUpperBound(null, null), null)
  assert.equal(resolveContextUpperBound(null, {}), null)
})
