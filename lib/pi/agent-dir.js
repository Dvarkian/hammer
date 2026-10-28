// @ts-check
/**
 * @file agent-dir.js
 * @description The Pi configuration the console runs on.
 *
 * Pi reads its providers from `models.json` inside an agent directory, and
 * `PI_CODING_AGENT_DIR` relocates that directory. The console therefore runs on a private
 * one containing a single `hammer` provider that points at this router, with one model:
 * `best`, Hammer's own routing alias.
 *
 * That is what makes the agent's model *the one Hammer selected*: the agent asks for the
 * alias, so every call is routed by the router at the moment it is made. A pin, a slope
 * change, a model that starts timing out, a provider that is benched — the agent follows,
 * because no model id is ever snapshotted here. Naming a concrete model instead would pin
 * the agent to it and take it off the router's selection the moment that changed.
 *
 * The directory is Hammer's, not the user's: `~/.pi/agent` is left untouched, nothing in it
 * is read, and deleting this directory simply returns Pi to its own settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HAMMER_PROVIDER = 'hammer'
export const HAMMER_MODEL = 'best'
export const DEFAULT_AGENT_DIR = join(homedir(), '.hammer', 'pi-agent')

/**
 * One directory per router port. Two Hammer instances — the one already running and a
 * second on another port — would otherwise keep overwriting each other's base URL, and a
 * Pi started by one would call the other.
 * @param {string} baseUrl
 */
export function defaultAgentDirFor(baseUrl) {
  const url = new URL(baseUrl)
  return join(DEFAULT_AGENT_DIR, url.port || (url.protocol === 'https:' ? '443' : '80'))
}

/**
 * A router alias has no single model's limits. These are the numbers Pi plans compaction
 * against and asks for as output budget; Hammer clamps `max_tokens` to whatever model it
 * actually serves, so a generous figure is safe and a small one would cost the agent its
 * context for nothing.
 */
const CONTEXT_WINDOW = 131072
const MAX_TOKENS = 8192

/**
 * The `models.json` Pi needs, as a plain object so a test can read it without a file.
 * @param {string} baseUrl the router's OpenAI-compatible base, e.g. http://127.0.0.1:7352/v1
 */
export function hammerModelsConfig(baseUrl) {
  return {
    providers: {
      [HAMMER_PROVIDER]: {
        name: 'Hammer',
        baseUrl,
        // Loopback clients need no credential (see the router's apiGuard); Pi still wants
        // one to consider the provider usable.
        apiKey: 'hammer-local',
        api: 'openai-completions',
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
        },
        models: [
          {
            id: HAMMER_MODEL,
            name: "Hammer's selected model",
            reasoning: false,
            input: ['text'],
            contextWindow: CONTEXT_WINDOW,
            maxTokens: MAX_TOKENS,
          },
        ],
      },
    },
  }
}

/**
 * Writes that configuration and returns what the child needs to use it.
 * @param {{ baseUrl: string, agentDir?: string }} options
 */
export function prepareHammerAgentDir({ baseUrl, agentDir = defaultAgentDirFor(baseUrl) }) {
  const json = `${JSON.stringify(hammerModelsConfig(baseUrl), null, 2)}\n`
  mkdirSync(agentDir, { recursive: true })
  const modelsPath = join(agentDir, 'models.json')
  let current = null
  try {
    current = readFileSync(modelsPath, 'utf8')
  } catch {
    // First run: there is nothing to compare against.
  }
  // Rewritten only when it changed, so a restart does not churn a file Pi watches.
  if (current !== json) writeFileSync(modelsPath, json, { mode: 0o600 })
  return {
    agentDir,
    modelsPath,
    args: ['--provider', HAMMER_PROVIDER, '--model', HAMMER_MODEL],
    env: { PI_CODING_AGENT_DIR: agentDir },
  }
}
