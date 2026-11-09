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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HAMMER_PROVIDER = 'hammer'
export const HAMMER_MODEL = 'best'
export const DEFAULT_AGENT_DIR = join(homedir(), '.hammer', 'pi', 'agent')

/**
 * Pi's own compaction budgets, mirrored from
 * `packages/coding-agent/src/core/compaction/compaction.ts`.
 *
 * They are the *numbers*, not the policy: Hammer declares no compaction rule of its own
 * here. Writing a `compaction` block at all would break the alias contract, because
 * `settings.json` is global to the agent directory and would then apply to any model a
 * user names — so a block is only emitted when the user actually set a value, and only
 * the fields they set are written (see `writeCompactionSettings`).
 */
export const PI_COMPACTION_DEFAULTS = Object.freeze({
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
})

/**
 * One directory per router port. Two Hammer instances — the one already running and a
 * second on another port — would otherwise keep overwriting each other's base URL, and a
 * Pi started by one would call the other.
 * @param {string} root
 * @param {string} baseUrl
 */
export function agentDirFor(root, baseUrl) {
  const url = new URL(baseUrl)
  return join(root, url.port || (url.protocol === 'https:' ? '443' : '80'))
}

/** @param {string} baseUrl */
export function defaultAgentDirFor(baseUrl) {
  return agentDirFor(DEFAULT_AGENT_DIR, baseUrl)
}

/**
 * A router alias has no single model's limits. These are the numbers Pi plans compaction
 * against and asks for as output budget; Hammer clamps `max_tokens` to whatever model it
 * actually serves, so a generous figure is safe and a small one would cost the agent its
 * context for nothing.
 */
const CONTEXT_WINDOW = 131072
/**
 * The smallest output budget the alias declares. A turn asks for this many tokens; the alias
 * has no single model's limits, so it states a turn-sized number rather than a model's.
 */
const MIN_MAX_TOKENS = 16384

/**
 * What Pi will ask a summarization to produce, given the reserve it compacts against.
 *
 * Pi's own formula (`generateSummaryWithUsage`): `min(0.8 * reserveTokens, model.maxTokens)`,
 * floored. It aborts the compaction outright when that response stops on `length`, because a
 * truncated summary must not become a session checkpoint (`getSummarizationFailure`).
 * @param {number|null} [reserveTokens]
 */
export function summarizationOutputBudget(reserveTokens) {
  const reserve =
    Number(reserveTokens) > 0 ? Number(reserveTokens) : PI_COMPACTION_DEFAULTS.reserveTokens
  return Math.floor(0.8 * reserve)
}

/**
 * The output budget the alias declares to Pi.
 *
 * It has to clear the summarization budget, or Hammer's declaration becomes a ceiling that
 * cuts every summary of a large session short — Pi then fails the compaction with "generation
 * hit the token cap and the summary is incomplete", which reads like a model limit and is not
 * one. It is derived from the reserve Pi is actually configured with rather than guessed, so a
 * user who raises `pi.compaction.reserveTokens` gets the larger budget the setting promises.
 * The router still clamps `max_tokens` down to whatever the served model accepts.
 * @param {number|null} [reserveTokens]
 */
export function declaredOutputBudget(reserveTokens) {
  return Math.max(MIN_MAX_TOKENS, summarizationOutputBudget(reserveTokens) + 1)
}

/**
 * The `models.json` Pi needs, as a plain object so a test can read it without a file.
 * @param {string} baseUrl the router's OpenAI-compatible base, e.g. http://127.0.0.1:7352/v1
 * @param {{ reserveTokens?: number|null }} [options] the compaction reserve Pi will run with,
 *   so the declared output budget can be sized from the summary it will ask for
 */
export function hammerModelsConfig(baseUrl, { reserveTokens = null } = {}) {
  const maxTokens = declaredOutputBudget(reserveTokens)
  // The console this configuration belongs to: the router port, which is also its name on disk.
  // It travels as a header because a compaction summary arrives at the router as an ordinary
  // completion, and that header is the only thing that says which transcript it belongs to.
  const consoleKey = (() => {
    try {
      return new URL(baseUrl).port || 'default'
    } catch {
      return ''
    }
  })()
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
          // Pi will only send a thinking level if the endpoint can express one, and the
          // router's `best` can serve a reasoning model. Declaring it is what makes
          // `pi.thinking` (or `set_thinking_level`) produce real thinking blocks instead of
          // silently clamping to off. Off is still the start-up level, so nothing is spent on
          // reasoning until it is asked for.
          supportsReasoningEffort: true,
          maxTokensField: 'max_tokens',
        },
        models: [
          {
            id: HAMMER_MODEL,
            name: "Hammer's selected model",
            // An alias has no fixed capabilities either: whether the routed model can think
            // is only known per request. Advertising it lets the console show thinking when
            // the selection supports it; a selection that does not simply ignores the level.
            reasoning: true,
            input: ['text'],
            contextWindow: CONTEXT_WINDOW,
            maxTokens,
            // The console this model answers for. It goes on the model, not the provider,
            // because Pi carries model-level headers into the compaction summarization
            // request (`resolveConfiguredModelHeaders` reads only those) and the router needs
            // the key to attach that summary to the transcript that asked for it.
            ...(consoleKey ? { headers: { 'X-Hammer-Pi-Console': consoleKey } } : {}),
          },
        ],
      },
    },
  }
}

/**
 * Writes that configuration and returns what the child needs to use it.
 * @param {{ baseUrl: string, agentDir?: string, compaction?: { enabled?: boolean, reserveTokens?: number|null, keepRecentTokens?: number|null } }} options
 *   `compaction` is the normalised `pi.compaction` block; an absent or all-default block
 *   leaves pi on its own budgets (see hammerCompactionSettings)
 */
/**
 * The compaction block pi should read, or null when it should read its own defaults.
 *
 * A block is only produced when a budget was actually set. An "all defaults" block would
 * pin pi's defaults into the file, so a later pi release that changed them would be
 * silently overridden by numbers this router never chose. Absence means "use whatever
 * this pi does", which is the only thing a router can honestly say on an alias's behalf.
 * @param {{ enabled?: boolean, reserveTokens?: number|null, keepRecentTokens?: number|null }} [compaction]
 * @returns {{ enabled: boolean, reserveTokens?: number, keepRecentTokens?: number }|null}
 */
/**
 * The compaction block Pi will read, or null when there is nothing to write.
 *
 * Null is the important answer: an absent file lets Pi keep whatever defaults it ships, which
 * is what survives a Pi upgrade. Writing `{compaction:{enabled:true}}` — or spelling out both
 * defaults in full — pins this install to today's numbers for a user who set nothing.
 *
 * The one setting worth writing with no budget attached is `enabled: false`: Pi's default is
 * to compact on its own, so a user who wants a context that grows needs it said.
 * @param {{ enabled?: boolean, reserveTokens?: number|null, keepRecentTokens?: number|null }} [compaction]
 */
export function hammerCompactionSettings(compaction) {
  const block = compaction && typeof compaction === 'object' ? compaction : {}
  const reserve = Number(block.reserveTokens)
  const keep = Number(block.keepRecentTokens)
  const settings = {}
  // `enabled: false` is a decision; `enabled: true` is Pi's own default and is left unwritten.
  if (block.enabled === false) settings.enabled = false
  // Only the budgets actually set. The rest are Pi's, not Hammer's, to choose.
  if (Number.isFinite(reserve) && reserve > 0) settings.reserveTokens = Math.floor(reserve)
  if (Number.isFinite(keep) && keep > 0) settings.keepRecentTokens = Math.floor(keep)
  const wrote = Object.keys(settings).length > 0
  return wrote ? settings : null
}

/**
 * Merges a requested block over Pi's defaults, for the file that is written.
 *
 * The defaults appear here, one time, on the way out — so the file always states a full,
 * readable block, and the in-memory normalised settings stay free of defaults an absent
 * block would otherwise be indistinguishable from.
 * @param {{ enabled?: boolean, reserveTokens?: number|null, keepRecentTokens?: number|null }} [compaction]
 */
export function compactionSettingsForFile(compaction) {
  const chosen = hammerCompactionSettings(compaction)
  if (!chosen) return null
  const enabled = chosen.enabled === false ? false : PI_COMPACTION_DEFAULTS.enabled
  return {
    enabled,
    reserveTokens:
      typeof chosen.reserveTokens === 'number'
        ? chosen.reserveTokens
        : PI_COMPACTION_DEFAULTS.reserveTokens,
    keepRecentTokens:
      typeof chosen.keepRecentTokens === 'number'
        ? chosen.keepRecentTokens
        : PI_COMPACTION_DEFAULTS.keepRecentTokens,
  }
}

/**
 * Writes the compaction block, and only when it differs from what is on disk.
 * @param {string} agentDir
 * @param {{ enabled: boolean, reserveTokens?: number, keepRecentTokens?: number }|null} block
 */
function writeCompactionSettings(agentDir, block) {
  const path = join(agentDir, 'settings.json')
  // Nothing to write and nothing written: remove a stale file so an old config cannot keep
  // compacting on budgets the user has since cleared.
  if (!block) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // A file that cannot be removed is a file pi will ignore; nothing here can act on it.
    }
    return null
  }
  const json = `${JSON.stringify({ compaction: block }, null, 2)}\n`
  let current = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // First run, or a settings file pi itself owns: no comparison is possible.
  }
  // Rewritten only when it changed, so a restart does not churn a file pi watches.
  if (current !== json) writeFileSync(path, json, { mode: 0o600 })
  return path
}

export function prepareHammerAgentDir({
  baseUrl,
  agentDir = defaultAgentDirFor(baseUrl),
  compaction,
}) {
  const json = `${JSON.stringify(
    hammerModelsConfig(baseUrl, { reserveTokens: compaction?.reserveTokens ?? null }),
    null,
    2,
  )}\n`
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
  const settingsPath = writeCompactionSettings(agentDir, compactionSettingsForFile(compaction))
  return {
    agentDir,
    modelsPath,
    settingsPath,
    args: ['--provider', HAMMER_PROVIDER, '--model', HAMMER_MODEL],
    env: { PI_CODING_AGENT_DIR: agentDir },
  }
}
