// @ts-check
/**
 * @file error-envelope.js
 * @description Puts a relayed upstream error into the envelope the client's SDK reads.
 *
 * Hammer relays many providers, and they do not agree on how an error is shaped. OpenAI,
 * Anthropic and their SDKs read `{"error": {"message": ...}}`. NIM/DeepSeek answer with
 * `{"message": ..., "type": "Bad Request", "code": 400}` instead. Relayed verbatim, the
 * SDK finds no `error` member and renders it as "400 status code (no body)" — the status is
 * all the caller learns, even though the provider named the exact problem (a malformed value
 * in message 38, say). The failure then looks like a dead session rather than a fixable one.
 *
 * This is deliberately a pure text-in/text-out function: the streaming relay keeps the raw
 * bytes for the request log (evidence), and only the bytes sent to the client are rewritten.
 */

/**
 * Rewrites an upstream error body that lacks the OpenAI `error` member.
 *
 * Only JSON objects that actually state a `message` are touched. An HTML error page, an SSE
 * frame, or an already-correct envelope is returned unchanged (null), so a relay never turns
 * a body it does not understand into one it invents.
 *
 * @param {string} text the upstream body
 * @returns {string | null} the normalized body, or null when it should be relayed as-is
 */
export function normalizeErrorEnvelope(text) {
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.error) return null
  const message = typeof parsed.message === 'string' ? parsed.message : ''
  if (!message) return null
  /** @type {{ message: string, type?: unknown, code?: unknown }} */
  const error = { message }
  if (parsed.type != null) error.type = parsed.type
  if (parsed.code != null) error.code = parsed.code
  return JSON.stringify({ error })
}
