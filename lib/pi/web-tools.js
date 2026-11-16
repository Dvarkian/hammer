// @ts-check
/**
 * @file web-tools.js
 * @description Materializes Hammer's keyless web tools beside a Pi agent directory.
 *
 * Pi discovers `<PI_CODING_AGENT_DIR>/extensions/*.ts`. The source lives inside Hammer's
 * install (and, in the desktop app, inside app.asar), while Pi runs as a separate Node that
 * cannot read an asar. Copying it out is the same reason subagent.ts is materialized.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_EXTENSION_SOURCE = fileURLToPath(new URL('./extensions/web.ts', import.meta.url))

/** @param {string} agentDir */
export function webExtensionPath(agentDir) {
  return join(agentDir, 'extensions', 'web.ts')
}

/**
 * Copy the extension when its bytes changed, and return the path Pi should discover.
 * @param {string} agentDir
 */
export function materializeWebExtension(agentDir) {
  const source = readFileSync(WEB_EXTENSION_SOURCE, 'utf8')
  const target = webExtensionPath(agentDir)
  mkdirSync(dirname(target), { recursive: true })
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // First copy.
  }
  if (current !== source) writeFileSync(target, source, { mode: 0o600 })
  return target
}
