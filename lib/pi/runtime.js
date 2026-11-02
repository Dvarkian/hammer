// @ts-check
/**
 * @file runtime.js
 * @description Finding a Pi that will actually run, and turning settings into a launch.
 *
 * The `pi` on PATH is a shim whose shebang is `#!/usr/bin/env node`. If that resolves to a
 * Node older than 22, pi dies on import (`node:fs` has no `globSync`) — a failure that looks
 * like "the agent is broken" rather than "the wrong interpreter". Hunter learned this the
 * hard way; the resolver below is its answer, kept: never exec the shim, exec a Node new
 * enough beside it, and say so in a note when none is found.
 *
 * `planPiLaunch` is the one place that decides what the child is: the routing provider when
 * this router has an origin, a named model when the settings name one, or a replacement brain
 * when one is configured.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HAMMER_MODEL, HAMMER_PROVIDER, agentDirFor, prepareHammerAgentDir } from './agent-dir.js'

/** pi imports APIs Node 18 does not have; the shim's interpreter is not good enough. */
export const MIN_NODE_MAJOR = 22

const MAX_NOTES = 8

/**
 * @param {string} nodePath
 * @returns {number} the major version, or 0 when it cannot be run
 */
export function nodeMajor(nodePath) {
  // In a desktop build process.execPath is the Hammer app, not an interpreter. Probing it with
  // `-v` relaunches Hammer, which then waits behind the single-instance lock while this
  // execFileSync waits for it to exit: the window would hang on the splash forever. The app
  // binary is never the answer to "find a Node for pi", so it is not a candidate here.
  if (process.versions?.electron && nodePath === process.execPath) return 0
  try {
    const raw = execFileSync(nodePath, ['-v'], { encoding: 'utf8' }).trim()
    return Number.parseInt(raw.replace(/^v/, ''), 10) || 0
  } catch {
    return 0
  }
}

/**
 * A spawn's cwd has to be a real directory. Pointing one at a file — an asar archive, a typo in
 * `~/.hammer.json` — makes spawn fail with ENOTDIR before the child exists, and the error names
 * the command rather than the directory, which sends you debugging the interpreter. The home
 * directory is the one fallback that always exists.
 * @param {string} dir
 * @param {string[]} [notes]
 * @returns {string}
 */
export function usableWorkspace(dir, notes = []) {
  try {
    if (statSync(dir).isDirectory()) return dir
  } catch {
    // Missing and not-a-directory are the same problem here: nothing can start in it.
  }
  const fallback = homedir()
  notes.push(`the workspace ${dir} is not a directory; working in ${fallback}`)
  return fallback
}

/**
 * Every place a pi entry point may live, most specific first.
 * @param {import('./settings.js').PiSettings} settings
 * @returns {string[]}
 */
function candidateEntrypoints(settings) {
  const candidates = []
  if (settings.command !== 'auto') {
    candidates.push(settings.command)
    return candidates
  }
  try {
    const which = execFileSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' }).trim()
    if (which) candidates.push(which)
  } catch {
    // No shell, no PATH answer; the pi-node installs below are the other door.
  }
  const root = join(homedir(), '.local', 'share', 'pi-node')
  if (existsSync(root)) {
    for (const dir of readdirSync(root).sort().reverse()) {
      const shim = join(root, dir, 'bin', 'pi')
      if (existsSync(shim)) candidates.push(shim)
    }
  }
  return candidates
}

/**
 * @typedef {object} PiRuntime
 * @property {string|null} entrypoint the pi bundle/executable to run
 * @property {string|null} node the interpreter to run it with
 * @property {string[]} notes what had to be skipped, for the status card
 */

/**
 * @param {import('./settings.js').PiSettings} settings
 * @returns {PiRuntime}
 */
export function resolvePiRuntime(settings) {
  const notes = []
  for (const candidate of candidateEntrypoints(settings)) {
    let entrypoint
    try {
      entrypoint = realpathSync(candidate)
    } catch {
      notes.push(`pi at ${candidate} could not be resolved`)
      continue
    }
    /** @type {string[]} */
    const interpreters = []
    if (settings.node !== 'auto') interpreters.push(settings.node)
    const beside = join(dirname(candidate), 'node')
    if (existsSync(beside)) interpreters.push(beside)
    interpreters.push(process.execPath, '/usr/local/bin/node', '/usr/bin/node')

    for (const node of interpreters) {
      // A configured interpreter is used if it runs at all; anything pi cannot import is not
      // an interpreter, it is the failure this resolver exists to prevent.
      if (existsSync(node) && nodeMajor(node) >= MIN_NODE_MAJOR) {
        return { entrypoint, node, notes: notes.slice(-MAX_NOTES) }
      }
    }
    notes.push(`pi at ${candidate} needs Node >= ${MIN_NODE_MAJOR}; none was found beside it`)
  }
  return { entrypoint: null, node: null, notes: notes.slice(-MAX_NOTES) }
}

/**
 * @typedef {object} PiLaunch
 * @property {string|null} command executable to spawn
 * @property {string[]} args
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {string[]} notes
 * @property {boolean} routed whether the child calls this router for its model
 * @property {string|null} error why it cannot be launched at all, if it cannot
 */

/**
 * Turns settings into exactly what the bridge should spawn.
 * @param {import('./settings.js').PiSettings} settings
 * @param {{ baseUrl?: string, agentDir?: string }} [options]
 * @returns {PiLaunch}
 */
export function planPiLaunch(settings, { baseUrl = '', agentDir = '' } = {}) {
  /** @type {string[]} */
  const notes = []
  const base = {
    cwd: usableWorkspace(settings.workspace, notes),
    env: /** @type {Record<string, string>} */ ({}),
    notes,
    routed: false,
    error: null,
  }

  // A replacement brain speaks the JSONL subset itself; nothing else is known about it, so
  // nothing else is passed to it.
  if (settings.brain.command) {
    notes.push('a replacement brain is configured; pi is not used')
    return {
      ...base,
      command: settings.brain.command,
      args: settings.brain.args,
    }
  }

  const runtime = resolvePiRuntime(settings)
  if (!runtime.entrypoint || !runtime.node) {
    notes.push(...runtime.notes)
    return {
      ...base,
      command: null,
      args: [],
      error: `Could not find a runnable pi (it needs Node >= ${MIN_NODE_MAJOR}). Set "pi.command" and "pi.node" in ~/.hammer.json.`,
    }
  }

  const args = [runtime.entrypoint, '--mode', 'rpc', '--session-dir', settings.sessions]
  notes.push(...runtime.notes)

  // Naming a provider or a model is a deliberate step off Hammer's routing; otherwise the
  // child is pointed at this router and asks for its alias (see agent-dir.js).
  const named = Boolean(settings.provider || settings.model)
  let provider = settings.provider
  let model = settings.model
  let env = {}
  let routed = false

  if (!named && baseUrl) {
    const target = agentDir || agentDirFor(settings.agentRoot, baseUrl)
    try {
      const prepared = prepareHammerAgentDir({ baseUrl, agentDir: target })
      env = prepared.env
      provider = HAMMER_PROVIDER
      model = HAMMER_MODEL
      routed = true
    } catch (err) {
      return {
        ...base,
        command: null,
        args: [],
        notes,
        error: `Could not write the Pi configuration for Hammer: ${/** @type {Error} */ (err)?.message || err}`,
      }
    }
  } else if (!named) {
    notes.push('no router address was given, so pi runs on its own configured model')
  }

  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  if (settings.thinking) args.push('--thinking', settings.thinking)
  args.push(...settings.extraArgs)

  return { ...base, command: runtime.node, args, env, notes: notes.slice(-MAX_NOTES), routed }
}
