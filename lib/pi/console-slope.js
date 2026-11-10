// @ts-check
/**
 * @file console-slope.js
 * @description The intelligence-vs-speed slope of each conversation.
 *
 * Routing used to take one global slope from the dashboard's plot. Now that the control lives in
 * the composer, every console owns its own value, and several conversations can be answering on
 * different models at once. The value here is a **percentage** of the data's slope ceiling (see
 * `selectorSlopeCeiling` in lib/utils.js), so 0% is "the smartest model" and 100% is "the
 * fastest, whatever it costs in intelligence" at any point in time — an absolute slope would
 * mean something different as the catalog's speed range moves.
 *
 * A console key is the name the proxy receives in `X-Hammer-Pi-Console`: the router port for the
 * main console, and `<port>-<id>` for a parallel one (see lib/pi/agent-dir.js and makeBridge).
 */

import { SELECTOR_DEFAULT_PERCENT, clampSelectorPercent } from '../utils.js'

/** @type {Map<string, number>} console key -> percent, 0..100 */
const percents = new Map()

/**
 * Declares a console at the exported default, without overwriting a value it already chose.
 * @param {string|null|undefined} key
 * @param {number|null} [percent]
 * @returns {number|null} the percent it now holds
 */
export function registerConsoleSlope(key, percent = SELECTOR_DEFAULT_PERCENT) {
  const name = String(key || '').trim()
  if (!name) return null
  if (!percents.has(name)) {
    const value = clampSelectorPercent(percent)
    percents.set(name, value == null ? SELECTOR_DEFAULT_PERCENT : value)
  }
  return percents.get(name) ?? null
}

/**
 * The slope one conversation asked for.
 * @param {string|null|undefined} key
 * @param {number} percent a number in 0..100
 * @returns {number|null} what was stored, or null when the key or value is unusable
 */
export function setConsoleSlopePercent(key, percent) {
  const name = String(key || '').trim()
  const value = clampSelectorPercent(percent)
  if (!name || value == null) return null
  percents.set(name, value)
  return value
}

/**
 * @param {string|null|undefined} key
 * @returns {number|null} the stored percent, or null when this key has no conversation
 */
export function consoleSlopePercent(key) {
  const name = String(key || '').trim()
  if (!name) return null
  return percents.has(name) ? (percents.get(name) ?? null) : null
}

/** Every conversation the router is running, so the table can light all of their picks. */
export function listConsoleSlopes() {
  return Array.from(percents, ([consoleKey, percent]) => ({ consoleKey, percent }))
}

/** Forget every conversation. Tests only. */
export function resetConsoleSlopesForTests() {
  percents.clear()
}
