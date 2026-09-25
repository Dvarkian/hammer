import { randomUUID } from 'node:crypto'

export const NLPCLOUD_PROVIDER_KEY = 'nlpcloud'
export const NLPCLOUD_DEFAULT_BASE_URL = 'https://api.nlpcloud.io/v1/gpu'
export const NLPCLOUD_DEFAULT_CHAT_URL = `${NLPCLOUD_DEFAULT_BASE_URL}/{model}/chatbot`

/**
 * NLP Cloud routes by model and task instead of exposing OpenAI's chat-completions path.
 * The model therefore belongs in the URL, not only in the JSON body.
 */
export function buildNlpCloudUrl(modelId, baseUrl = NLPCLOUD_DEFAULT_BASE_URL) {
  const model = String(modelId || '').trim()
  if (!model) return null
  const root = String(baseUrl || NLPCLOUD_DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (!root) return null
  return `${root}/${model.split('/').map(encodeURIComponent).join('/')}/chatbot`
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .filter(part => part && typeof part === 'object' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

/**
 * Converts OpenAI chat messages into NLP Cloud's `{ input, context, history }` shape.
 * System/developer turns become context; earlier user/assistant pairs become history.
 */
export function buildNlpCloudRequestBody(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  let inputIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      inputIndex = index
      break
    }
  }
  if (inputIndex < 0) inputIndex = messages.length - 1

  const context = []
  const history = []
  let pendingInput = null
  for (let index = 0; index < inputIndex; index += 1) {
    const message = messages[index] || {}
    const text = messageText(message.content).trim()
    if (!text) continue
    if (message.role === 'user') {
      pendingInput = text
    } else if (message.role === 'assistant' && pendingInput != null) {
      history.push({ input: pendingInput, response: text })
      pendingInput = null
    } else {
      context.push(`${message.role || 'message'}: ${text}`)
    }
  }

  const input = inputIndex >= 0 ? messageText(messages[inputIndex]?.content).trim() : ''
  return {
    input,
    context: context.length > 0 ? context.join('\n\n') : null,
    history,
  }
}

function completionPayload(content, modelId) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }
}

function streamPayloads(content, modelId) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const frame = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  return [
    frame({ role: 'assistant', content: '' }),
    frame({ content }),
    frame({}, 'stop'),
  ]
}

function rateLimitHeaders(response) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-ratelimit-') || name === 'retry-after') headers.set(name, value)
  }
  return headers
}

/**
 * Converts NLP Cloud's non-streaming `{ response, history }` body into the OpenAI shape.
 * When the caller requested streaming, the single completed answer is emitted as a short
 * SSE sequence because NLP Cloud's chatbot endpoint does not expose a streaming mode.
 */
export async function transformNlpCloudResponse(response, modelId, stream = false) {
  if (!response?.ok) return response
  let payload
  try {
    payload = await response.json()
  } catch {
    return new Response(JSON.stringify({ error: { message: 'NLP Cloud returned malformed JSON.', type: 'provider_error' } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const content = typeof payload?.response === 'string' ? payload.response : ''
  if (!content) {
    return new Response(JSON.stringify({ error: { message: 'NLP Cloud returned no response text.', type: 'provider_error' } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!stream) {
    return new Response(JSON.stringify(completionPayload(content, modelId)), {
      status: 200,
      headers: rateLimitHeaders(response),
    })
  }

  const frames = streamPayloads(content, modelId)
    .map(payload => `data: ${JSON.stringify(payload)}\n\n`)
    .join('')
  const headers = rateLimitHeaders(response)
  headers.set('Content-Type', 'text/event-stream')
  headers.set('Cache-Control', 'no-cache')
  return new Response(`${frames}data: [DONE]\n\n`, { status: 200, headers })
}
