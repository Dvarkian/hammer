// What did a response body actually contain, and did it carry an answer at all?
//
// These two functions used to live inside lib/server.js's test handler, which made the rule that
// produced "Model returned no text." impossible to test against a captured body. The rule is
// shared wider than the manual test — the probe's classifyProbeResponseBody and the proxy's
// refusal scan both read the same bodies — so it lives here, where a test can pin it.

import { findUpstreamSseError, hasUsableChatCompletionBody, isAccountBudgetRefusalText, isEmptyModelResponseText } from './utils.js'

/**
 * The answer inside a response, from whichever shape the provider sent: an SSE transcript (the
 * streamed case) or a plain JSON completion (a relay that ignored `stream: true`). Reads what the
 * proxy's stream capture reads out of the frames — content, streamed reasoning and tool-call
 * arguments all count as output, because they are.
 *
 * `streamed` reports whether the provider answered in frames at all — an SSE transcript, as
 * opposed to one JSON body. A stream is then measured the way the proxy measures a stream: a
 * generation window when the answer's own frames give one, and the whole request duration when
 * they do not (see resolveStreamGenerationMs). A single body offers no first token to time and no
 * window to divide by, so it yields a duration and nothing else.
 *
 * `text` is visible content only, while `outputText` is everything the model emitted. They are
 * deliberately separate: the dashboard shows an answer, not a reasoning trace, but a response that
 * emitted only reasoning still answered — see resolveTestVerdict, where the two are weighed.
 */
export function summarizeTestAnswer(transcript) {
  const raw = String(transcript || '');
  const answer = {
    text: '',
    outputText: '',
    reportedCompletionTokens: null,
    reportedPromptTokens: null,
    reportedTotalTokens: null,
    streamed: false,
    parsed: false,
    // Why the provider stopped, when it said so. 'length' means the answer ran into the output
    // budget rather than reaching its own end. A test asks for the largest budget the model allows
    // (see TEST_OUTPUT_BUDGET in lib/server.js), so a 'length' it sees is the provider's own
    // ceiling — and the row is shown as truncated rather than as a model that returned no text.
    finishReason: null,
  };
  // The frames decide which reader this is: a relay that ignored `stream: true` answers with
  // one plain JSON body, which carries no `data:` line, so it is read below as the completion
  // it is. Deliberately *not* the per-chunk OUTPUT_FRAME_RE hit: where the network cut the
  // bytes is a coin flip, and a frame split across two chunks can leave no chunk matching the
  // regex at all (the reply's first frame opening in one chunk and closing in the next) — the
  // proxy parses the accumulated transcript for exactly that reason (see captureStream), and
  // gating on the regex would turn such a split into "unparseable body, show it raw" with no
  // measurement, while the proxy records a rate for the same response.
  const frames = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) frames.push(trimmed.slice(5).trim());
  }
  if (frames.length > 0) {
    answer.streamed = true;
    for (const frame of frames) {
      if (!frame || frame === '[DONE]') continue;
      let data = null;
      try { data = JSON.parse(frame); } catch { continue; }
      const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || null;
      if (delta) {
        answer.parsed = true;
        if (typeof delta.content === 'string') { answer.text += delta.content; answer.outputText += delta.content; }
        if (typeof delta.reasoning_content === 'string') answer.outputText += delta.reasoning_content;
        else if (typeof delta.reasoning === 'string') answer.outputText += delta.reasoning;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (typeof tc?.function?.arguments === 'string') answer.outputText += tc.function.arguments;
          }
        }
        if (typeof delta.function_call?.arguments === 'string') answer.outputText += delta.function_call.arguments;
      }
      const finish = data?.choices?.[0]?.finish_reason;
      if (typeof finish === 'string' && finish) answer.finishReason = finish;
      if (data?.usage) {
        if (data.usage.completion_tokens != null) answer.reportedCompletionTokens = data.usage.completion_tokens;
        if (data.usage.prompt_tokens != null) answer.reportedPromptTokens = data.usage.prompt_tokens;
        if (data.usage.total_tokens != null) answer.reportedTotalTokens = data.usage.total_tokens;
      }
    }
    return answer;
  }
  // Not streamed to us: an ordinary completion body, read the way this path always read it.
  try {
    const data = JSON.parse(raw);
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    answer.parsed = Array.isArray(data?.choices) && data.choices.length > 0;
    answer.text = typeof content === 'string' ? content : (content == null ? '' : JSON.stringify(content));
    const reasoning = typeof message?.reasoning_content === 'string'
      ? message.reasoning_content
      : (typeof message?.reasoning === 'string' ? message.reasoning : '');
    const toolArgs = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map(tc => (typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '')).join('')
      : '';
    const fnArgs = typeof message?.function_call?.arguments === 'string' ? message.function_call.arguments : '';
    answer.outputText = `${answer.text}${reasoning}${toolArgs}${fnArgs}`;
    const finish = data?.choices?.[0]?.finish_reason;
    if (typeof finish === 'string' && finish) answer.finishReason = finish;
    answer.reportedCompletionTokens = data?.usage?.completion_tokens ?? null;
    answer.reportedPromptTokens = data?.usage?.prompt_tokens ?? null;
    answer.reportedTotalTokens = data?.usage?.total_tokens ?? null;
  } catch {
    // A non-JSON success body: the caller shows it raw, exactly as before.
  }
  return answer;
}

/**
 * Everything the test path decides about a response body, in one place:
 *
 * - `answer`     the parsed answer (null when the transport already failed)
 * - `upstreamError`  an error envelope folded into a success status (see findUpstreamSseError)
 * - `accountRefusal` the gateway refusing for an account reason inside an otherwise valid answer
 * - `usableSuccess`  the transport said success and nothing above contradicts it
 * - `text`       the answer to show, or null when there is nothing to show
 * - `reasoningOnly` `text` is output the model emitted outside the content channel
 * - `truncated`  the provider stopped because the output budget ran out
 * - `empty`      the response emitted nothing at all, in any channel
 *
 * `empty` is the only case "Model returned no text." describes, and it has to be judged on
 * everything the model emitted rather than on the visible content alone. A reasoning model that
 * spends its whole budget before reaching the content channel answered — that is what the proxy's
 * promote path and the probe already say about the same bytes (see hasUsableChatCompletionBody,
 * which counts streamed reasoning, array-shaped content parts and legacy `choices[].text`), and a
 * test that disagreed was the source of a row reading 100% uptime beside "Model returned no text."
 */
export function resolveTestVerdict({ ok, transcript }) {
  const answer = ok === true ? summarizeTestAnswer(transcript) : null;
  // Some relays fold a backend fault into a success status, so the body — not the status line —
  // decides. An error envelope is a transient provider-side failure, never a verdict about the
  // model, which is why it is read before any structural check (see findUpstreamSseError).
  const upstreamError = findUpstreamSseError(transcript);
  // A gateway can also refuse for an account reason inside a *successful* body, with the refusal
  // as the assistant's message: "The API key used for this request has reached its budget…". That
  // body has choices, a message and real content, so every structural check calls it an answer —
  // which is how a refusal came to promote a row to Up and be measured as if the model had
  // generated its words (see isAccountBudgetRefusalText).
  const accountRefusal = answer && isAccountBudgetRefusalText(answer.text) ? answer.text.trim() : null;
  const usableSuccess = ok === true && !upstreamError && !accountRefusal;

  const visible = answer ? answer.text.trim() : '';
  const emitted = Boolean(answer && answer.outputText.trim());
  const truncated = Boolean(answer && answer.finishReason === 'length');

  let text = null;
  let reasoningOnly = false;
  if (usableSuccess) {
    if (visible) {
      text = answer.text;
    } else if (emitted) {
      // The model answered, the visible channel just never opened: a reasoning trace that used the
      // whole budget, or tool-call arguments. Show what it produced instead of discarding it.
      text = answer.outputText;
      reasoningOnly = true;
    } else if (!answer.streamed && !answer.parsed && transcript) {
      // An unparseable non-SSE success body has always been shown raw: it is at least the gateway
      // saying something about this request. Gated on `!parsed` so that a parsed body with an
      // genuinely empty message stays empty rather than being repainted as its own JSON.
      text = transcript;
    } else if (hasUsableChatCompletionBody(transcript)) {
      // A stream whose frames this reader could not reconstruct. The proxy's own verdict on the
      // same transcript decides whether it carried an answer in a shape this reader does not
      // decode, or none at all — a role-only or usage-only stream must not be persisted as a
      // success whose "answer" is the frames themselves.
      text = transcript || null;
    }
  }

  return {
    answer,
    upstreamError,
    accountRefusal,
    usableSuccess,
    text,
    reasoningOnly,
    truncated,
    empty: usableSuccess && isEmptyModelResponseText(text),
  };
}
