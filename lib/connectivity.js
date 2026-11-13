// @ts-check
/**
 * @file connectivity.js
 * @description Whether a failure means "this machine has no internet", as opposed to "this
 * provider did not answer".
 *
 * The two look alike from the router's side — a request produced no response — but they are
 * different facts, and only one of them is actionable by the person reading the screen. A
 * provider that refuses or times out is one row to avoid; a machine with no link has no rows at
 * all, and telling that user "No models currently available" sends them looking for a broken
 * provider that is fine.
 *
 * Only failures that happen *before* any byte moves and that name the network are read this way:
 * DNS (`ENOTFOUND`, `EAI_AGAIN`), a missing route (`ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`) and
 * the browser's own "you are offline" error. A timeout is deliberately *not* here — a provider
 * that is slow to answer is a provider problem — and neither is a refused connection: a closed
 * port means something is listening on the other side of a working link.
 */

/** Names that can only mean the local machine has no path to the network. @type {readonly string[]} */
const NO_INTERNET_CODES = Object.freeze([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
])

/**
 * Text that names the same condition when no code survived. Node's undici wraps the real cause
 * and only the message is left by the time some callers see it; Chromium says it in words.
 * @type {readonly string[]}
 */
const NO_INTERNET_TEXT = Object.freeze([
  'network is unreachable',
  'no internet',
  'internet disconnected',
  'getaddrinfo',
  'name or service not known',
])

/**
 * What the router answers with when every candidate failed at the connection itself. One
 * sentence, addressed to the person who can fix it, because the next thing they will do is
 * check their connection and every alternative wording wastes that step.
 */
export const NO_INTERNET_MESSAGE =
  'No internet connection — Hammer could not reach any model provider. Check the connection and try again.'

/**
 * @param {unknown} code
 * @returns {boolean} whether this error code names a missing internet connection.
 */
export function isNoInternetCode(code) {
  const value = String(code || '')
    .trim()
    .toUpperCase()
  return Boolean(value) && NO_INTERNET_CODES.includes(value)
}

/**
 * Whether a failed attempt was the connection rather than the provider.
 *
 * Accepts either the shape an attempt records (`{ code, message }`) or the message alone, since
 * the two arrive from different places: the proxy keeps the transport code beside the text, the
 * dashboard only ever has text.
 *
 * @param {{ code?: unknown, message?: unknown } | string | null | undefined} failure
 * @returns {boolean}
 */
export function isNoInternetFailure(failure) {
  if (!failure) return false
  if (typeof failure === 'string') return matchesText(failure)
  return isNoInternetCode(failure.code) || matchesText(String(failure.message || ''))
}

/** @param {string} text */
function matchesText(text) {
  const value = text.toLowerCase()
  if (!value) return false
  return NO_INTERNET_TEXT.some((needle) => value.includes(needle))
}

/**
 * Whether every recorded attempt failed for lack of a connection.
 *
 * The empty list is false on purpose: a request that never tried anything is a routing problem
 * ("no models available"), not a connectivity one, and claiming otherwise would blame the user's
 * network for the router's own empty candidate list.
 *
 * @param {ReadonlyArray<{ status?: unknown, code?: unknown, error?: unknown }>} attempts
 * @returns {boolean}
 */
export function everyAttemptLostConnection(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return false
  return attempts.every(
    (attempt) =>
      attempt &&
      String(attempt.status || '') === 'ERR' &&
      isNoInternetFailure({ code: attempt.code, message: attempt.error }),
  )
}
