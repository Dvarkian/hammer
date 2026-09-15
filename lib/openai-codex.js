/**
 * @file lib/openai-codex.js
 * @description OpenAI Codex (ChatGPT subscription OAuth) wire support.
 *
 * Codex is not an OpenAI-compatible chat endpoint: it authenticates with a
 * ChatGPT OAuth access token, carries the workspace id in a `chatgpt-account-id`
 * header, and speaks the Responses API (`/codex/responses`) with SSE only. This
 * module owns the two translations that let an OpenAI chat-completions client
 * (which is what hammer proxies) talk to it:
 *
 *   → buildCodexRequestPayload  — chat.completions request → Responses request
 *   → transformCodexResponse    — Responses SSE → chat.completion(.chunk)
 *
 * plus the ChatGPT account identity carried by the access token's JWT claims.
 * Behavior mirrors oh-my-pi's openai-codex provider.
 *
 * @exports CODEX_DEFAULT_BASE_URL, CODEX_CLIENT_VERSION, CODEX_CLIENT_ID
 * @exports decodeCodexJwt, extractCodexAccountIdentity
 * @exports buildCodexRequestPayload, transformCodexResponse
 * @exports extractCodexModelRecords, parseCodexRateLimits
 */

// ── Wire constants ──────────────────────────────────────────────────────────
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
export const CODEX_RESPONSES_PATH = '/codex/responses';
export const CODEX_MODELS_PATHS = ['/codex/models', '/models'];
/**
 * Pinned Codex client version. The backend version-gates model availability
 * against this value (both on the model list and on /responses), so an older
 * pin silently hides newer SKUs from discovery.
 */
export const CODEX_CLIENT_VERSION = '0.153.0';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CODEX_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
export const CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION}`;

const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';

/** Reasoning efforts the Codex wire accepts, in ascending order. */
const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Sampling controls the Codex backend rejects with 400 `Unsupported parameter`. */
const CODEX_UNSUPPORTED_PARAMS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty',
  'repetition_penalty', 'stop', 'logprobs', 'top_logprobs', 'logit_bias', 'n', 'seed',
  'user', 'response_format', 'max_tokens', 'max_completion_tokens', 'parallel_tool_calls',
];

// ── JWT identity ────────────────────────────────────────────────────────────

/** 📖 Decode a JWT payload without verifying the signature (claims are display/identity only). */
export function decodeCodexJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 📖 ChatGPT identity carried by a Codex token. The access token holds the
 *    workspace (`chatgpt_account_id`) that the subscription's limits belong to —
 *    one email can hold several — while `plan_type` often only rides the id_token.
 */
export function extractCodexAccountIdentity(accessToken, idToken = null) {
  const payload = decodeCodexJwt(accessToken);
  const idPayload = idToken ? decodeCodexJwt(idToken) : null;
  const auth = payload?.[JWT_AUTH_CLAIM];
  const idAuth = idPayload?.[JWT_AUTH_CLAIM];
  const accountId = auth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id ?? null;
  const email = payload?.[JWT_PROFILE_CLAIM]?.email ?? idPayload?.[JWT_PROFILE_CLAIM]?.email ?? null;
  const planType = auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type ?? null;
  const residency = auth?.chatgpt_data_residency ?? auth?.chatgpt_compute_residency ?? null;
  return {
    accountId: typeof accountId === 'string' && accountId ? accountId : null,
    email: typeof email === 'string' && email ? email.trim().toLowerCase() : null,
    planType: typeof planType === 'string' && planType ? planType.trim().toLowerCase() : null,
    residency: typeof residency === 'string' && residency ? residency.trim() : null,
  };
}

// ── Request translation ─────────────────────────────────────────────────────

function textFromChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    // Refusal parts carry no user-visible text; tool_result blocks are not valid
    // assistant/user message content on the Responses wire.
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

function toResponsesContent(role, content) {
  const parts = [];
  const list = Array.isArray(content)
    ? content
    : (typeof content === 'string' && content.length > 0 ? [{ type: 'text', text: content }] : []);
  for (const part of list) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
    } else if (part.type === 'image_url' && role === 'user') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts;
}

function toolOutputText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const texts = content
      .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : null))
      .filter(text => text !== null);
    return texts.length > 0 ? texts.join('\n') : JSON.stringify(content);
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** 📖 chat.completions tool definition → Responses function tool (flat, not nested). */
function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return null;
  const mapped = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') continue;
    const name = typeof tool.function.name === 'string' ? tool.function.name : '';
    if (!name) continue;
    const converted = { type: 'function', name };
    if (typeof tool.function.description === 'string') converted.description = tool.function.description;
    if (tool.function.parameters && typeof tool.function.parameters === 'object') converted.parameters = tool.function.parameters;
    mapped.push(converted);
  }
  return mapped.length > 0 ? mapped : null;
}

function toResponsesToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') {
    return ['auto', 'none', 'required'].includes(toolChoice) ? toolChoice : 'auto';
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const name = toolChoice.function?.name || toolChoice.name;
    if (typeof name === 'string' && name) return { type: 'function', name };
  }
  return undefined;
}

/**
 * 📖 Translate an OpenAI chat.completions request into a Codex Responses request.
 *    System/developer turns become `instructions`; assistant tool calls and tool
 *    results become the flat `function_call` / `function_call_output` input items;
 *    sampling controls are dropped because the backend rejects them outright.
 */
export function buildCodexRequestPayload(body, modelId = null, options = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const model = modelId || source.model || null;
  const messages = Array.isArray(source.messages) ? source.messages : [];

  const instructionParts = [];
  const input = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role === 'system' || role === 'developer') {
      const text = textFromChatContent(message.content);
      if (text.trim()) instructionParts.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const callId = message.tool_call_id || message.toolCallId || message.name || `call_${input.length}`;
      input.push({
        type: 'function_call_output',
        call_id: String(callId),
        output: toolOutputText(message.content),
      });
      continue;
    }
    if (role === 'assistant') {
      const content = toResponsesContent('assistant', message.content);
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const fn = call.function && typeof call.function === 'object' ? call.function : {};
        input.push({
          type: 'function_call',
          call_id: String(call.id || `call_${input.length}`),
          name: typeof fn.name === 'string' ? fn.name : 'tool',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    // user (and anything unrecognized) is carried as user input.
    const content = toResponsesContent('user', message.content);
    if (content.length > 0) input.push({ type: 'message', role: 'user', content });
  }

  const payload = {
    model,
    // The subscription backend keeps no server-side response state for this
    // surface: `store` must be false and the client owns the transcript.
    store: false,
    stream: true,
    input,
    include: ['reasoning.encrypted_content'],
  };
  if (instructionParts.length > 0) payload.instructions = instructionParts.join('\n\n');

  const tools = toResponsesTools(source.tools);
  if (tools) {
    payload.tools = tools;
    const toolChoice = toResponsesToolChoice(source.tool_choice);
    if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  }

  const effort = source.reasoning_effort ?? source.reasoning?.effort ?? options.reasoningEffort ?? null;
  if (typeof effort === 'string' && CODEX_EFFORTS.has(effort.toLowerCase())) {
    payload.reasoning = { effort: effort.toLowerCase(), summary: options.reasoningSummary || 'auto' };
  }
  if (options.promptCacheKey) payload.prompt_cache_key = options.promptCacheKey;

  // Belt and braces: the backend 400s on any sampling control, including ones a
  // client sent that we never mapped onto the Responses body.
  for (const param of CODEX_UNSUPPORTED_PARAMS) delete payload[param];
  return payload;
}

// ── Response translation ────────────────────────────────────────────────────

function codexUsageToOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens ?? (promptTokens + completionTokens)),
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(Number(usage.output_tokens_details?.reasoning_tokens ?? 0) > 0
      ? { completion_tokens_details: { reasoning_tokens: Number(usage.output_tokens_details.reasoning_tokens) } }
      : {}),
  };
}

function collectResponseOutput(output) {
  let text = '';
  const toolCalls = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
      continue;
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || `call_${toolCalls.length}`),
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : 'tool',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

function finishReasonFor(status, toolCallCount) {
  if (toolCallCount > 0) return 'tool_calls';
  if (status === 'incomplete') return 'length';
  if (status === 'failed') return 'stop';
  return 'stop';
}

/** 📖 Map a completed Responses payload onto an OpenAI chat.completion body. */
function codexResponseToChatCompletion(payload, modelId, responseId, created) {
  const { text, toolCalls } = collectResponseOutput(payload?.output);
  const message = { role: 'assistant', content: text || (toolCalls.length > 0 ? null : '') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const status = typeof payload?.status === 'string' ? payload.status : null;
  return {
    id: responseId,
    object: 'chat.completion',
    created,
    model: payload?.model || modelId,
    choices: [{ index: 0, message, finish_reason: finishReasonFor(status, toolCalls.length) }],
    ...(codexUsageToOpenAI(payload?.usage) ? { usage: codexUsageToOpenAI(payload.usage) } : {}),
  };
}

/**
 * 📖 SSE allows CRLF, LF, or CR line terminators, and a frame boundary is a blank
 *    line — so a CRLF stream only ever contains `\r\n\r\n`, never the `\n\n` the
 *    frame readers below split on. Normalizing the terminators first is what keeps a
 *    CRLF backend from collapsing every event into one unparseable frame (which reads
 *    as an empty reply, and gets the model marked incompatible).
 */
function normalizeSseText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function codexErrorBody(payload) {
  const err = payload?.error ?? payload?.response?.error ?? null;
  const message = typeof err?.message === 'string' ? err.message : null;
  const code = err?.code || err?.type || null;
  return { message: message || 'The Codex backend rejected the request.', code: code ? String(code) : null };
}

/**
 * 📖 Translate a Codex Responses response into the OpenAI chat shapes a hammer
 *    client expects. Upstream is SSE-only, so a non-streaming client's reply is
 *    assembled from the stream before it is returned.
 *
 * @param {Response} response upstream Codex response
 * @param {string} modelId model the client asked for
 * @param {boolean} stream whether the *client* asked to stream
 */
export async function transformCodexResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;

  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const contentType = response.headers?.get?.('content-type') || '';
  const isEventStream = contentType.includes('text/event-stream');

  // A JSON body (some failures, and older backends) is mapped directly.
  if (!isEventStream) {
    const raw = await response.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch { /* not JSON */ }
    if (!payload) return new Response(raw, { status: response.status, statusText: response.statusText, headers: { 'Content-Type': 'application/json' } });
    if (payload.error || payload.response?.error) {
      const { message, code } = codexErrorBody(payload);
      return new Response(JSON.stringify({ error: { message, ...(code ? { code, type: code } : {}), type: code || 'codex_error' } }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const completion = codexResponseToChatCompletion(payload.response || payload, modelId, responseId, created);
    return new Response(JSON.stringify(completion), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  const state = {
    text: '',
    toolCalls: [],
    usage: null,
    finishSent: false,
    chunkIndex: 0,
    status: null,
    error: null,
    failed: false,
  };

  const buildToolCallDelta = (call, index, includeRole) => ({
    id: responseId,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }],
      },
      finish_reason: null,
    }],
  });

  const buildFinishChunk = () => ({
    id: responseId,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReasonFor(state.status, state.toolCalls.length),
    }],
    ...(state.usage ? { usage: state.usage } : {}),
  });

  const handleEvent = (event, controller) => {
    const type = typeof event?.type === 'string' ? event.type : '';
    switch (type) {
      case 'response.output_text.delta': {
        if (typeof event.delta !== 'string' || !event.delta) return;
        state.text += event.delta;
        const chunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{ index: 0, delta: state.chunkIndex === 0 ? { role: 'assistant', content: event.delta } : { content: event.delta }, finish_reason: null }],
        };
        state.chunkIndex += 1;
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        return;
      }
      case 'response.output_item.done': {
        const item = event.item;
        if (!item || typeof item !== 'object' || item.type !== 'function_call') return;
        const call = {
          id: String(item.call_id || item.id || `call_${state.toolCalls.length}`),
          type: 'function',
          function: {
            name: typeof item.name === 'string' ? item.name : 'tool',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        };
        const index = state.toolCalls.length;
        state.toolCalls.push(call);
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify(buildToolCallDelta(call, index, state.chunkIndex === 0))}\n\n`));
        state.chunkIndex += 1;
        return;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const payload = event.response || {};
        state.status = typeof payload.status === 'string' ? payload.status : (type === 'response.incomplete' ? 'incomplete' : 'completed');
        state.usage = codexUsageToOpenAI(payload.usage) || state.usage;
        return;
      }
      case 'response.failed': {
        state.failed = true;
        state.error = codexErrorBody(event.response || {});
        return;
      }
      case 'error': {
        state.failed = true;
        state.error = codexErrorBody({ error: event });
        return;
      }
      default:
        return;
    }
  };

  if (!stream) {
    // Aggregate: read the whole SSE stream, then answer with one JSON body.
    const text = await response.text();
    for (const data of extractSseData(text)) {
      if (data === '[DONE]') continue;
      let event = null;
      try { event = JSON.parse(data); } catch { continue; }
      handleEvent(event, null);
    }
    if (state.failed && state.error) {
      return new Response(JSON.stringify({ error: { message: state.error.message, ...(state.error.code ? { code: state.error.code, type: state.error.code } : {}) } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const message = { role: 'assistant', content: state.text || (state.toolCalls.length > 0 ? null : '') };
    if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;
    const completion = {
      id: responseId,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReasonFor(state.status, state.toolCalls.length) }],
      ...(state.usage ? { usage: state.usage } : {}),
    };
    return new Response(JSON.stringify(completion), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let buffer = '';
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer = normalizeSseText(buffer + new TextDecoder().decode(chunk, { stream: true }));
      // SSE frames are separated by a blank line; keep the trailing partial. A chunk
      // boundary can split a CRLF pair, which the next chunk's arrival completes
      // before the normalization above runs again.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (data && data !== '[DONE]') {
          let event = null;
          try { event = JSON.parse(data); } catch { event = null; }
          if (event) handleEvent(event, controller);
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (state.failed && state.error && !state.finishSent) {
        state.finishSent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: state.error.message, ...(state.error.code ? { code: state.error.code, type: state.error.code } : {}) } })}\n\n`));
      }
    },
    flush(controller) {
      if (state.failed && state.error && !state.finishSent) {
        state.finishSent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: state.error.message, ...(state.error.code ? { code: state.error.code, type: state.error.code } : {}) } })}\n\n`));
      }
      if (!state.finishSent) {
        state.finishSent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(buildFinishChunk())}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });

  return new Response(response.body.pipeThrough(transformStream), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/** 📖 Collect the `data:` payloads of an SSE body (used when aggregating a stream). */
function extractSseData(text) {
  const out = [];
  for (const frame of normalizeSseText(text).split(/\n\n+/)) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
    if (data) out.push(data);
  }
  return out;
}

// ── Discovery + usage ───────────────────────────────────────────────────────

/** 📖 Codex's model list is `{models:[…]}` or `{data:[…]}` depending on the route. */
export function extractCodexModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

/**
 * 📖 Codex attaches a quota snapshot to every response as `x-codex-*` headers,
 *    which is the only place a subscription's remaining allowance is visible.
 */
export function parseCodexRateLimits(headers) {
  const get = (name) => {
    const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
    // Headers.get() returns null for an absent header, which must not read as 0.
    return value == null || value === '' ? null : value;
  };
  const toNumber = (value) => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const readWindow = (key) => {
    const usedPercent = toNumber(get(`x-codex-${key}-used-percent`));
    if (usedPercent == null) return null;
    const windowMinutes = toNumber(get(`x-codex-${key}-window-minutes`));
    const resetAt = toNumber(get(`x-codex-${key}-reset-at`));
    return {
      usedPercent,
      windowMinutes,
      resetsAt: resetAt == null ? null : resetAt * 1000,
    };
  };
  const primary = readWindow('primary');
  const secondary = readWindow('secondary');
  if (!primary && !secondary) return null;
  return { primary, secondary };
}
