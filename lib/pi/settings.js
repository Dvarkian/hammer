// @ts-check
/**
 * @file settings.js
 * @description The console's settings, read the way the Hunter harness reads its `config.json`.
 *
 * A `pi` block in `~/.hammer.json` describes the agent: how to launch it, which model it may
 * use, where it works, and where its sessions live. Every field is optional; the defaults are
 * the console as it shipped, so an existing config keeps its behaviour and an absent block is
 * not an error.
 *
 *   "pi": {
 *     "command": "auto",             // "auto" | path to a pi entry point
 *     "node": "auto",                // "auto" | path to a Node >= 22
 *     "provider": null,              // set either to leave Hammer's routing and name a model
 *     "model": null,
 *     "thinking": null,
 *     "extraArgs": [],
 *     "brain": { "command": null, "args": [] },  // replace pi with any JSONL-speaking process
 *     "workspace": null,             // default: this Hammer install
 *     "sessions": null               // default: ~/.hammer/pi/sessions
 *   }
 *
 * The environment overrides the file for the launch and path fields, because a container or
 * a test needs to point the console somewhere without rewriting the user's config.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'

/**
 * Hammer's install root, not the directory the router happened to start in.
 *
 * In the packaged desktop app these modules live inside `resources/app.asar`, which makes the root
 * below the archive itself — a file. A file can never be a working directory: spawning the agent
 * there fails with ENOTDIR, and the error names the interpreter instead, so it reads as "node is
 * broken". The home directory is the one writable place we can name without guessing.
 */
export const PROJECT_ROOT = realInstallRoot()

/** @returns {string} the install root, never a path inside an asar archive */
function realInstallRoot() {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
  const inArchive = root.split(/[\\/]/).some((part) => part.endsWith('.asar'))
  return inArchive ? homedir() : root
}
/** Everything the console keeps: prepared agent config, sessions, and nothing else. */
export const HARNESS_ROOT = join(homedir(), '.hammer', 'pi')

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
/** @param {unknown} value */
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

/**
 * @typedef {object} PiSettings
 * @property {string} command  pi entry point, or `auto`
 * @property {string} node     Node to run it with, or `auto`
 * @property {string|null} provider  overrides Hammer's routing when set with `model`
 * @property {string|null} model
 * @property {string|null} thinking
 * @property {string[]} extraArgs
 * @property {{ command: string|null, args: string[] }} brain
 * @property {string} workspace  the directory the agent works in
 * @property {string} sessions   where pi keeps its session files
 * @property {string} agentRoot  where a prepared Pi configuration lives
 */

/**
 * Normalizes the `pi` block, so callers never branch on a missing field or a wrong type.
 * @param {any} raw the `pi` block as written
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PiSettings}
 */
export function normalizePiSettings(raw = {}, env = process.env) {
  const block = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const brain =
    block.brain && typeof block.brain === 'object' && !Array.isArray(block.brain) ? block.brain : {}
  const workspace = text(env.HAMMER_PI_WORKSPACE) || text(block.workspace) || '.'
  const sessions = text(env.HAMMER_PI_SESSIONS) || text(block.sessions) || 'sessions'
  return {
    command: text(env.HAMMER_PI_COMMAND) || text(block.command) || 'auto',
    node: text(env.HAMMER_PI_NODE) || text(block.node) || 'auto',
    provider: text(block.provider),
    model: text(block.model),
    thinking: text(block.thinking),
    extraArgs: strings(block.extraArgs),
    brain: {
      command: text(env.HAMMER_PI_BRAIN) || text(brain.command),
      args: strings(brain.args),
    },
    // Relative paths stay relative to the file they were written in: the workspace to the
    // install (where the agent works), the session store to the console's own data.
    workspace: resolve(PROJECT_ROOT, workspace),
    sessions: resolve(HARNESS_ROOT, sessions),
    agentRoot: text(env.HAMMER_PI_AGENT_DIR) || join(HARNESS_ROOT, 'agent'),
  }
}

/**
 * The settings in force, from `~/.hammer.json` and the environment.
 * @param {any} [config] a config object, for tests that must not read the real file
 */
export function readPiSettings(config = loadConfig()) {
  return normalizePiSettings(config?.pi ?? {})
}

/**
 * Creates what a launch needs. A workspace that does not exist is a mistake in a user's
 * config, not something to silently create — but the console's own directories are ours.
 * @param {PiSettings} settings
 */
export function ensureHarnessDirs(settings) {
  mkdirSync(settings.sessions, { recursive: true })
  mkdirSync(settings.agentRoot, { recursive: true })
  return { sessions: settings.sessions, agentRoot: settings.agentRoot }
}
