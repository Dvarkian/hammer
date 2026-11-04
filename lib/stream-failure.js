// @ts-check
/**
 * @file stream-failure.js
 * @description What kind of failure a dropped model stream was, as a plain text label.
 *
 * Hammer relays other people's models, so its streams stop for reasons it did not cause and
 * cannot forecast: a provider that goes away mid-stream, a connection the relay resets, an
 * idle window that expires while a provider banks its answer. Two consumers need to tell
 * those apart from the failures that _are_ Hammer's answer, and each was doing it by pattern
 * matching a message locally:
 *
 * - the router's own **failover** (`lib/http/routes/proxy.js`) never re-prompts a client that
 *   is already streaming, but it does record what it saw, and
 * - the **agent** (`lib/pi/bridge.js`) has to decide whether a turn that ended in an error
 *   should be tried again on the next provider.
 *
 * The agent's case is the one that matters most: Pi decides this on its own behalf, from the
 * error text we hand it, and it has to reach the same verdict the router would. Two different
 * answers to "was that the provider, or was that the plan?" is how one turn gets retried
 * forever while another is never retried at all. So the rule lives here, in one place, with
 * no dependency on either caller — a pure function over a string.
 *
 * A transport failure is retryable and advances to the next candidate. Everything else —
 * a refusal, a quota the account has spent, a policy gate, the user cancelling — is a
 * verdict about the request, and retrying it is just asking again with a different name.
 *
 * Note that this is deliberately *not* Pi's own classifier (`isRetryableAssistantError` in
 * pi-ai). Pi guards a single provider call. Hammer guards a turn that may span several
 * providers, and it refuses from evidence it has already collected rather than re-reading a
 * string.
 */

/**
 * Text that names a transport-level failure: the connection, or the provider's own ability
 * to answer, went away while the stream was open. These are the ones worth trying again.
 *
 * Read as a whole message, case-insensitively. Each entry is a regular expression source and
 * the set is compiled into one pattern, so `stream.?ended` matches both spellings.
 * @type {readonly string[]}
 */
const TRANSPORT_FAILURE_PATTERNS = [
  // The generic shapes pi-ai itself emits, so a provider that reaches Hammer already
  // normalized is recognised either way: "Connection error.", "fetch failed",
  // "socket hang up", "other side closed", "connection refused", "getaddrinfo ENOTFOUND".
  'connection error',
  'connection refused',
  'connection lost',
  'connection reset',
  'socket hang up',
  'socket connection was closed',
  'other side closed',
  'fetch failed',
  'network error',
  'getaddrinfo',
  'enotfound',
  'eai_again',
  'upstream connect',
  // Resets and terminations, however far the relay was from the real provider.
  'terminated',
  'terminated early',
  'terminated unexpectedly',
  'reset before headers',
  'econnreset',
  'epipe',
  // A provider that was reached but would not, or could not, finish.
  'stream interrupted',
  'stream stalled',
  'idle timeout',
  'stream ended without',
  'stream ended before',
  'ended without a terminal response event',
  'terminated \\(etimedout',
  'etimedout',
  'terminated due to timeout',
  'incomplete chunked',
  // Load and capacity, from the provider's side rather than the plan's.
  'overloaded',
  'service unavailable',
  'service?.unavailable',
  'rate.?limit',
  'too many requests',
  'provider.?returned error',
]

/**
 * HTTP status numbers that mean "the provider dropped it", as a prefix. `5xx` is not in the
 * list below on purpose: a 500 can be a genuinely malformed request, and those are verdicts.
 * @type {readonly number[]}
 */
const TRANSPORT_FAILURE_STATUSES = [408, 502, 503, 504, 522, 524]

const TRANSPORT_FAILURE_RE = new RegExp(TRANSPORT_FAILURE_PATTERNS.join('|'), 'i')

/**
 * How many bytes of an error body are worth reading to classify it. A provider can return
 * a whole HTML page or a JSON array of failures; the transport vocabulary is in the opening.
 */
const ERROR_TEXT_LIMIT = 2_000

/** Pulls the readable text out of a JSON error body, an Error, or a plain string. */
function errorTextOf(error) {
  if (error == null) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || ''
  const message = typeof error === 'object' ? error.message : null
  if (typeof message === 'string' && message) return message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const statusOf = (value) => {
  const status = Number(typeof value === 'object' && value ? value.status : value)
  return Number.isInteger(status) && status > 0 ? status : 0
}

/**
 * True when the message reads as a transport failure rather than a verdict.
 * @param {unknown} error an Error, a JSON error body, a status number, or text
 */
export function isTransportStreamFailure(error) {
  const text = errorTextOf(error).slice(0, ERROR_TEXT_LIMIT)
  // A numeric status outranks the text: "503: {...}" is unambiguous even when the body inside
  // is about something else.
  const status = statusOf(error)
  if (status && TRANSPORT_FAILURE_STATUSES.includes(status)) return true
  if (!text) return false
  return TRANSPORT_FAILURE_RE.test(text)
}

/**
 * The phrase the agent turn should acknowledge an error with, said once per failure so a
 * reader knows a retry happened and is not left watching a stopped run.
 * @param {{ attempt?: number, of?: number }} [progress]
 */
export function autoRetryNote({ attempt = 1, of = 1 } = {}) {
  return attempt > 1
    ? `Retrying after a transport failure (attempt ${attempt} of ${of}).`
    : 'Retrying after a transport failure.'
}
