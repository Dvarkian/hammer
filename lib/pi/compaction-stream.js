/**
 * @file lib/pi/compaction-stream.js
 * @description Which console owns a compaction summary stream.
 *
 * Pi announces a compaction with `compaction_start` and then says nothing until
 * `compaction_end` — the summary itself is not an event. It is an ordinary completion, though,
 * and Pi sends it through this router, so the proxy can see the text being written. To put that
 * text in the right transcript, the proxy needs the console the request came from: Pi's private
 * model configuration carries the console key as a header (see `hammerModelsConfig`), and this
 * registry turns that key back into the bridge.
 *
 * The key is the router port, which is also the console's name on disk. A parallel console has
 * a key of its own and is deliberately not registered: it shares the port, so a header alone
 * could not tell the two apart, and attributing one console's summary to another would be worse
 * than showing no summary at all.
 */

/** @type {Map<string, any>} */
const bridges = new Map()

/**
 * @param {string} key the console key (the router port)
 * @param {any} bridge
 * @returns {any} the bridge, so a caller can wrap its construction
 */
export function registerPiBridgeConsole(key, bridge) {
  const name = String(key || '').trim()
  if (name && bridge) bridges.set(name, bridge)
  return bridge
}

/**
 * The bridge a compaction request belongs to, or null when the key names no console this
 * process runs.
 * @param {string} key
 * @returns {any|null}
 */
export function piBridgeForConsole(key) {
  return bridges.get(String(key || '').trim()) || null
}

/** Forget every console. Tests only. */
export function resetPiCompactionStreamsForTests() {
  bridges.clear()
}
