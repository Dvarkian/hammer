// The fixtures here are not invented: every body was captured live from g4f.space/v1 in a run of
// the model test's own request shape (TEST_PROMPT, stream: true, max_tokens: 64) and the probe's
// shape (non-streamed, messages "hi", max_tokens: 1). Each one used to produce the same dashboard
// message — "Model returned no text." — and each has a different cause, so each gets its own row
// in the table below.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractErrorMessage, findUpstreamSseError, hasUsableChatCompletionBody, isRateLimitedErrorText } from '../lib/utils.js';
import { resolveTestVerdict, summarizeTestAnswer } from '../lib/test-verdict.js';
// The peek the proxy has always applied and the model test now applies too.
import { transformStreamingUpstreamErrorResponse } from '../lib/server.js';

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

// --- the captures ---------------------------------------------------------------------------

// g4f's pool rate-limits per minute and reports it *inside* an HTTP 200 stream. The message is
// nested in `error.errors[]`, which is what made it invisible to findUpstreamSseError — so the row
// was struck out as "incompatible" while the provider was saying "rate limiting" in plain words.
// Captured verbatim (234 bytes), from srv_mtcmurvv28a020e060d2:deepseek-v4-pro-0813.
const G4F_NESTED_ERROR_ENVELOPE =
  'data: {"error": {"errors": [{"message": "AiError: AiError: rate limiting: inference request per min rate reached (5852a8be-dd86-4a1c-867f-78ba39190acd)", "code": 3021}], "success": false, "result": {}, "messages": []}}\n\n' +
  'data: [DONE]\n\n';
const G4F_RATE_LIMIT_MESSAGE = 'AiError: AiError: rate limiting: inference request per min rate reached (5852a8be-dd86-4a1c-867f-78ba39190acd)';

// The same row when the pool is not throttled: 64 completion tokens spent entirely on
// reasoning_content, zero characters of visible content, finish_reason 'length'. The provider is
// saying the answer was cut off by our own budget, and the test read it as a model that cannot
// chat — throwing away 249 characters of real generation and recording no measurement.
function reasoningOnlyTranscript(reasoningFrames = 3) {
  let raw = frame({ id: 'logfare-2190aebd61a94db48105f67e', object: 'chat.completion.chunk', created: 1789966340, model: 'deepseek-v4-pro-0813', choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: null }], usage: { prompt_tokens: 24, completion_tokens: 0, total_tokens: 24 } });
  const chunks = ['Let me think about ', 'what makes hammers funny ', 'without being mean.'];
  let tokens = 0;
  for (let i = 0; i < reasoningFrames; i++) {
    tokens += 1;
    raw += frame({ choices: [{ index: 0, delta: { reasoning_content: chunks[i % chunks.length] }, finish_reason: null }], usage: { prompt_tokens: 24, completion_tokens: tokens, total_tokens: 24 + tokens } });
  }
  raw += frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 24, completion_tokens: 64, total_tokens: 88 } });
  // A trailing empty-delta frame arrived before [DONE] in the capture; kept so the reader is
  // exercised on the shape that actually came back.
  raw += frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 24, completion_tokens: 64, total_tokens: 88 } });
  return raw + 'data: [DONE]\n\n';
}

// HuggingChat's backend accepts the request, generates nothing, and says so: one frame, role-only
// with an empty content string, finish_reason 'stop', usage.completion_tokens 0. Captured
// verbatim (720 bytes); it answered identically on three consecutive attempts.
const HUGGINGCHAT_EMPTY_STREAM =
  frame({
    id: 'chatcmpl-9v6A9i1L8SIgv6tcnbVK9JJu85SA',
    object: 'chat.completion.chunk',
    created: 1789966397,
    model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    provider: 'HuggingChat',
    choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: null, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 24, completion_tokens: 0, total_tokens: 24, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
  }) + 'data: [DONE]\n\n';

// The same backend answering the probe's shape (non-streamed, max_tokens 1). Reconstructed from
// the captured body's head, which carried an empty message and finish_reason 'stop'.
const HUGGINGCHAT_EMPTY_JSON = JSON.stringify({
  id: 'chatcmpl-4Y6jda1EN6Bb1BujcyWoHuIxtU7V',
  object: 'chat.completion',
  created: 1789966342,
  model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
  provider: 'HuggingChat',
  choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: '', reasoning: null, tool_calls: null } }],
  usage: { prompt_tokens: 24, completion_tokens: 0, total_tokens: 24 },
});

// A healthy row, for contrast: srv_mtsj8uzo97d3c0d49960:deepseek-z/deepseek-v4-pro streamed
// visible content frame by frame and finished with 'stop'.
const HEALTHY_STREAM = (() => {
  let raw = frame({ id: 'chatcmpl-e063754f', object: 'chat.completion.chunk', model: 'deepseek-z/deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const piece of ['Hammers: ', 'the original ', 'fidget toy.']) {
    raw += frame({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  raw += frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  return raw + 'data: [DONE]\n\n';
})();

// The flat envelope shape the detectors have always understood — the DeepInfra-backed row's 429.
const PLAIN_ERROR_ENVELOPE = '{"error": {"message": "Request execution failed"}, "model": "deepseek-ai/DeepSeek-V4-Pro", "provider": "DeepInfra"}';
// A bare string envelope, which the object test used to exclude before the message was read.
const STRING_ERROR_ENVELOPE = 'data: {"error": "Service temporarily overloaded"}\n\ndata: [DONE]\n\n';

// --- the relay error envelope ----------------------------------------------------------------

test('a relay envelope that nests its message under error.errors is recognised as an error', () => {
  const error = findUpstreamSseError(G4F_NESTED_ERROR_ENVELOPE);
  assert.ok(error, 'the nested envelope must not read as "no error"');
  assert.equal(error.message, G4F_RATE_LIMIT_MESSAGE);
  // This is the whole point: the provider's own words have to survive, because the rate-limit
  // branch keys off them to put the row on a clock instead of condemning it.
  assert.equal(isRateLimitedErrorText(error.message), true);
});

test('the flat and bare-string envelope shapes still resolve', () => {
  assert.equal(findUpstreamSseError(PLAIN_ERROR_ENVELOPE).message, 'Request execution failed');
  assert.equal(findUpstreamSseError(STRING_ERROR_ENVELOPE).message, 'Service temporarily overloaded');
});

test('a healthy answer is not mistaken for an error envelope', () => {
  assert.equal(findUpstreamSseError(HEALTHY_STREAM), null);
  assert.equal(findUpstreamSseError(reasoningOnlyTranscript()), null);
});

// extractErrorMessage is what the synthetic 503 body is built from, so the relay's nested message
// has to survive that walk as well as the envelope check.
test('the nested message survives the message walk used to build a synthetic error body', () => {
  const nestedError = { errors: [{ message: G4F_RATE_LIMIT_MESSAGE, code: 3021 }], success: false, result: {}, messages: [] };
  assert.equal(extractErrorMessage(nestedError), G4F_RATE_LIMIT_MESSAGE);
});

// --- what counts as an answer -----------------------------------------------------------------

test('streamed reasoning counts as output, so the same bytes are usable to the probe', () => {
  assert.equal(hasUsableChatCompletionBody(reasoningOnlyTranscript()), true);
});

test('an empty completion is not usable output, in either transport', () => {
  assert.equal(hasUsableChatCompletionBody(HUGGINGCHAT_EMPTY_STREAM), false);
  assert.equal(hasUsableChatCompletionBody(HUGGINGCHAT_EMPTY_JSON), false);
});

test('finish_reason is read from both the streamed and the single-body reader', () => {
  assert.equal(summarizeTestAnswer(reasoningOnlyTranscript()).finishReason, 'length');
  assert.equal(summarizeTestAnswer(HEALTHY_STREAM).finishReason, 'stop');
  assert.equal(summarizeTestAnswer(HUGGINGCHAT_EMPTY_JSON).finishReason, 'stop');
});

// --- the verdict that produced the dashboard message -----------------------------------------

test('a reasoning-only answer is kept, measured and marked truncated rather than called empty', () => {
  const transcript = reasoningOnlyTranscript();
  const answer = summarizeTestAnswer(transcript);
  // The response really did emit something: that is what the old verdict ignored.
  assert.ok(answer.outputText.length > 0);
  assert.equal(answer.text, '');

  const verdict = resolveTestVerdict({ ok: true, transcript });
  assert.equal(verdict.usableSuccess, true);
  assert.equal(verdict.empty, false, 'a model that emitted reasoning must not be reported as returning no text');
  assert.equal(verdict.text, answer.outputText, 'the output it did produce is what the row shows');
  assert.equal(verdict.reasoningOnly, true);
  assert.equal(verdict.truncated, true);
  // A rate is measurable from these same bytes, which is why the row must not be struck out.
  assert.equal(answer.reportedCompletionTokens, 64);
});

test('a completion that emitted nothing at all is the one empty verdict', () => {
  const streamed = resolveTestVerdict({ ok: true, transcript: HUGGINGCHAT_EMPTY_STREAM });
  assert.equal(streamed.usableSuccess, true, 'the transport did succeed');
  assert.equal(streamed.empty, true);
  assert.equal(streamed.text, null);

  const single = resolveTestVerdict({ ok: true, transcript: HUGGINGCHAT_EMPTY_JSON });
  assert.equal(single.empty, true);
  assert.equal(single.text, null);
});

test('an error envelope folded into a 200 is routed to the failure handling, never scored as empty', () => {
  // Without the streamed-error peek this body reaches the verdict as a "success": the important
  // part is that it is not then read as an empty answer, because the row would be marked down for
  // a rate limit and the provider's message would never be shown.
  const verdict = resolveTestVerdict({ ok: true, transcript: G4F_NESTED_ERROR_ENVELOPE });
  assert.equal(verdict.usableSuccess, false);
  assert.equal(verdict.empty, false);
  assert.equal(verdict.upstreamError.message, G4F_RATE_LIMIT_MESSAGE);
});

test('a healthy answer keeps its visible text and is neither reasoning-only nor truncated', () => {
  const verdict = resolveTestVerdict({ ok: true, transcript: HEALTHY_STREAM });
  assert.equal(verdict.text, 'Hammers: the original fidget toy.');
  assert.equal(verdict.empty, false);
  assert.equal(verdict.reasoningOnly, false);
  assert.equal(verdict.truncated, false);
});

// --- the streamed guard the model test was missing -------------------------------------------

const streamingResponse = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });

test('a 200 stream that opens with a nested relay error becomes the 503 the failure path reads', async () => {
  const transformed = await transformStreamingUpstreamErrorResponse(streamingResponse(G4F_NESTED_ERROR_ENVELOPE));
  // Not ok any more, so the test reports the provider's failure instead of scoring an empty
  // success — and the synthetic body carries the words the rate-limit branch looks for.
  assert.equal(transformed.status, 503);
  const body = await transformed.text();
  assert.equal(findUpstreamSseError(body).message, G4F_RATE_LIMIT_MESSAGE);
  assert.equal(isRateLimitedErrorText(findUpstreamSseError(body).message), true);
});

test('a healthy stream passes the guard untouched, byte for byte', async () => {
  const transformed = await transformStreamingUpstreamErrorResponse(streamingResponse(HEALTHY_STREAM));
  assert.equal(transformed.status, 200);
  // The peek buffers until the first newline and rebuilds the stream, so the answer must come
  // back complete — a guard that ate a frame would break every streamed test it ran on.
  assert.equal(await transformed.text(), HEALTHY_STREAM);
});

test('the guard leaves an already-failed response alone', async () => {
  const tooManyRequests = new Response('{"error":{"message":"Request execution failed"}}', { status: 429 });
  assert.equal(await transformStreamingUpstreamErrorResponse(tooManyRequests), tooManyRequests);
});

test('a failed transport is not an empty answer', () => {
  const verdict = resolveTestVerdict({ ok: false, transcript: '{"error":{"message":"Request timed out"}}' });
  assert.equal(verdict.answer, null);
  assert.equal(verdict.usableSuccess, false);
  assert.equal(verdict.empty, false);
});
