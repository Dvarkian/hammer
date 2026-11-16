// @ts-check
/**
 * @file live.js
 * @description The running subagent manager, reachable from the proxy without a module cycle.
 *
 * The proxy is registered before the Pi console routes, but a subagent pool is owned by the
 * manager the console route creates. One process-wide slot bridges the two. It carries no
 * policy: the manager decides the pool, and the proxy simply asks for it.
 */

/** @type {any} */
let active = null

/** @param {any} manager */
export function setActiveSubagentManager(manager) {
  active = manager
}

export function activeSubagentManager() {
  return active
}

/**
 * Resolve a `sub-…` console header to the record whose pool should serve the request.
 * @param {string} consoleKey
 */
export function subagentForConsole(consoleKey) {
  if (!active || !consoleKey) return null
  try {
    return active.recordForConsoleKey(consoleKey)
  } catch {
    return null
  }
}

/**
 * The proxy reports the row it actually picked. The manager resolves it against the
 * record's primary route and appends a fallback trace when they differ.
 * @param {string} consoleKey
 * @param {any} row
 */
export function noteSubagentRoute(consoleKey, row) {
  if (!active || !consoleKey || !row) return
  try {
    active.noteRoute(consoleKey, row)
  } catch {
    // Routing must not fail because the UI's trace did.
  }
}
