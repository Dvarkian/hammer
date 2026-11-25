// @ts-check
/**
 * @file extension.js
 * @description Copies the subagent extension and its child charter out of the install.
 *
 * Pi auto-discovers `extensions/subagent.ts` inside `PI_CODING_AGENT_DIR`. A packaged
 * Hammer keeps that source inside `app.asar`, which the external Node running Pi cannot
 * read, so the file is materialized beside the agent configuration first. This is the same
 * reason the supervisor script is materialized.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_TOOL_NAMES } from './policy.js'

const EXTENSION_SOURCE = fileURLToPath(new URL('../pi/extensions/subagent.ts', import.meta.url))

/** @param {string} agentDir */
export function subagentExtensionPath(agentDir) {
  return join(agentDir, 'extensions', 'subagent.ts')
}

/** @param {string} agentDir */
export function materializeSubagentExtension(agentDir) {
  const source = readFileSync(EXTENSION_SOURCE, 'utf8')
  const target = subagentExtensionPath(agentDir)
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

/**
 * The generic charter every child gets. It says what the role is and what the limits are;
 * it deliberately contains no reviewer/scout/worker personas.
 * @param {{ instructions?: string, cwd?: string, tools?: string[], grants?: any, depth?: number, maxDepth?: number }} options
 */
export function childCharter({
  instructions = '',
  cwd = '',
  tools = [],
  grants = {},
  depth = 1,
  maxDepth = 2,
} = {}) {
  const has = (name) => tools.includes(name)
  const canSpawn = grants?.spawn === true && Number(depth) < Number(maxDepth)
  const webTools = tools.filter((name) => WEB_TOOL_NAMES.includes(name))
  const hasWeb = webTools.length > 0
  const lines = [
    '# Hammer subagent',
    '',
    'You are a child agent working for a parent Hammer agent. Work only on the task you were',
    'given. Your final assistant message is your report to the parent: make it concise, state',
    'what you changed or found, the exact commands or files involved, and anything the parent',
    'must know before using the result.',
    '',
    cwd
      ? `Your working directory is ${cwd}. Paths outside it are not part of the delegated work.`
      : '',
    `The current date is ${new Date().toISOString().slice(0, 10)} (UTC). Use it for "today", "this week" and other relative dates instead of inferring them from search results.`,
    `You are at depth ${depth} of ${maxDepth}.`,
    canSpawn
      ? 'You may spawn child agents with the subagent tool. Pass the "spawn" capability in a child\'s tools only when that child must be able to spawn one level further; children at the maximum depth cannot be given it.'
      : 'You cannot spawn further subagents. Do not claim to have spawned one, and do not invent or claim use of a tool you were not given; if the task needs a child agent, report that the spawn capability was not granted.',
    has('bash')
      ? 'You have bash. This is a policy boundary, not a sandbox: you can read files and call loopback services the user can. Do not reach for sibling or parent context.'
      : hasWeb
        ? `You have web access through the granted web tools (${webTools.join(', ')}). Use only those tools for current external facts or to read a URL; do not answer current external questions from memory.`
        : 'You do not have bash or a web tool. Use the file tools you were given; if the task needs current external information, say the web tool was not granted instead of answering from memory.',
    '',
    'When one tool call depends on another, run them one at a time: wait for a write, edit or mkdir result before a later read or bash command that uses that path. Pi may run calls from the same assistant message concurrently, so a cat issued beside its write can race the file into existence.',
    '',
    'Do not ask for approval and do not wait for a user. If the task is impossible, finish with a clear report of the blocker and the evidence.',
    '',
    instructions ? '## Role instructions\n' : '',
    instructions || '',
  ]
  return `${lines.filter(Boolean).join('\n')}\n`
}

/** @param {string} agentDir @param {string} charter */
export function writeChildCharter(agentDir, charter) {
  const target = join(agentDir, 'APPEND_SYSTEM.md')
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // First write.
  }
  if (current !== charter) writeFileSync(target, charter, { mode: 0o600 })
  return existsSync(target) ? target : null
}
