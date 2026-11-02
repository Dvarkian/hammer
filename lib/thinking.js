// @ts-check
/**
 * ── Thinking effort ─────────────────────────────────────────────────────────────────────
 *
 * A reasoning model accepts a hint about how hard to think before it answers, and every
 * vendor spells that hint differently: OpenAI-compatible endpoints take `reasoning_effort`,
 * OpenRouter takes `reasoning.effort`, and a few wires have no equivalent field at all. The
 * client that talks to Hammer asks once, in one vocabulary, and this module is the only place
 * that knows the difference.
 *
 * Two rules decide what a request actually carries:
 *
 *   1. **The model decides whether the field exists at all.** A model with no reasoning mode
 *      answers `400 "\`reasoning_effort\` is not supported with this model"`, and Hammer routes
 *      across a whole catalog — the same request may land on a thinking model and on a
 *      plain chat model. So the field is set only for families this module knows to reason,
 *      and it is *removed* otherwise. Hammer's agent declares `supportsReasoningEffort`, so it
 *      sends one on every turn; without this gate every non-reasoning model it routed to
 *      would fail once before the sanitizer healed the request.
 *
 *   2. **The caller's level wins over the configured default.** A client that asked for `high`
 *      gets `high` whatever `~/.hammer.json` says; the configured level is what a client that
 *      said nothing gets. `off` removes the field rather than sending it as `"off"`, because
 *      providers disagree about whether that word is a value or an error.
 *
 * The family list below is deliberately conservative: an unknown model is treated as a plain
 * chat model, which costs a thinking model some depth it never asked for and never costs a
 * plain model a failed request. Adding a family is one entry, not a code path.
 */

/** The levels a caller may ask for, quietest first. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']

/**
 * Spellings a client may use for a level. Providers and harnesses disagree (`none`, `false`,
 * `0`, `max`, `xhigh`), and the router is the one place that can absorb the difference.
 */
const ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['false', 'off'],
  ['0', 'off'],
  ['no', 'off'],
  ['disabled', 'off'],
  ['minimal', 'minimal'],
  ['min', 'minimal'],
  ['least', 'minimal'],
  ['low', 'low'],
  ['light', 'low'],
  ['medium', 'medium'],
  ['med', 'medium'],
  ['normal', 'medium'],
  ['default', 'medium'],
  ['high', 'high'],
  ['max', 'high'],
  ['maximum', 'high'],
  ['xhigh', 'high'],
  ['extra', 'high'],
  ['highest', 'high'],
])

/**
 * Families that reason, and the families that also accept `minimal` as a distinct step.
 *
 * Matched against the canonical model name (see {@link canonicalModelName}), so a provider
 * prefix (`openai/`, `z-ai/`) or a routing tag (`:free`, `-2024-08-06`) does not matter.
 */
const REASONING_FAMILIES = [
  /^gpt-5(?:[.-]|$)/,
  /^gpt-oss/,
  /^o[1-4](?:[.-]|$)/,
  /^deepseek-r1/,
  /^deepseek-reasoner/,
  /^deepseek-v3\.2/,
  /^qwen3(?:[.-]|$)/,
  /^qwen3\.\d/,
  /^qwq/,
  /^kimi-k2-thinking/,
  /^glm-(?:4\.5|4\.6|4\.7|5)/,
  /^glm5/,
  /^minimax-m[23]/,
  /^magistral/,
  /^gemini-(?:2\.5|3)/,
  /^grok-(?:3-mini|4)/,
  /^claude-(?:3-7|4|sonnet-4|opus-4)/,
  /^seed-oss/,
  /^hunyuan-a13b/,
  /^ernie-4\.5-thinking/,
  /^nemotron-3-(?:ultra|super|nano)/,
  /^step-3/,
]

/** Families that accept `minimal`; everything else is floored to `low` for that level. */
const MINIMAL_FAMILIES = [/^gpt-5(?:[.-]|$)/, /^gpt-oss/, /^o[1-4](?:[.-]|$)/]

/**
 * Providers whose wire Hammer builds itself, with no effort control in the payload it
 * constructs. Naming them is the point: sending an OpenAI field to a protobuf endpoint is not
 * a translation, it is a corrupt request.
 */
const NO_EFFORT_WIRES = new Set(['kiro', 'devin', 'gptfree', 'nlpcloud', 'openai-codex'])

/** The field this provider's wire uses. `none` means there is no such field. */
export const THINKING_STYLES = ['effort', 'openrouter', 'none']

/**
 * @param {unknown} providerKey
 * @returns {'effort'|'openrouter'|'none'}
 */
export function thinkingStyleFor(providerKey) {
  const key = String(providerKey || '').toLowerCase()
  if (NO_EFFORT_WIRES.has(key)) return 'none'
  // OpenRouter normalizes reasoning across its own catalog and reads `reasoning.effort`;
  // it also accepts `reasoning_effort`, but the object form is the documented one.
  if (key === 'openrouter') return 'openrouter'
  return 'effort'
}

/**
 * The model name with provider prefixes, routing tags and dated snapshots stripped, so a
 * family pattern matches whichever spelling the catalog happened to use.
 *
 * @param {unknown} modelId
 * @returns {string}
 */
export function canonicalModelName(modelId) {
  let name = String(modelId || '')
    .trim()
    .toLowerCase()
  if (!name) return ''
  const slash = name.lastIndexOf('/')
  if (slash >= 0) name = name.slice(slash + 1)
  name = name.replace(/@.*$/, '')
  name = name.replace(/:(free|beta|latest|thinking|online|extended)$/, '')
  // `-2024-08-06`, `-20250601`, `-v1:0` — a dated snapshot is the same family as its base.
  name = name.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '')
  name = name.replace(/-v\d+(?::\d+)?$/, '')
  return name
}

/**
 * Whether this model has a reasoning mode at all. Unknown models are `false`: a dropped
 * level costs depth, a sent one costs a failed request.
 *
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function modelTakesThinking(modelId) {
  const name = canonicalModelName(modelId)
  if (!name) return false
  return REASONING_FAMILIES.some((pattern) => pattern.test(name))
}

/**
 * The level a request should carry: what the caller asked for, else the configured default.
 *
 * Reads both spellings a caller may use — `reasoning_effort` (OpenAI) and `reasoning.effort`
 * (OpenRouter) — so a client written against either one works unchanged. Returns `null` when
 * neither side stated anything, which means "do not touch the body": an absence of opinion is
 * not the same instruction as `off`.
 *
 * @param {Record<string, any>|null|undefined} body
 * @param {unknown} [fallback] the configured default
 * @returns {string|null}
 */
export function resolveThinkingLevel(body, fallback = null) {
  const asked =
    body && typeof body === 'object'
      ? (body.reasoning_effort ?? body.reasoning?.effort ?? body.thinking_level)
      : null
  if (normalizeThinkingLevel(asked)) return normalizeThinkingLevel(asked)
  return normalizeThinkingLevel(fallback)
}

/**
 * @param {unknown} value
 * @returns {string|null} a level from {@link THINKING_LEVELS}, or null when unrecognized
 */
export function normalizeThinkingLevel(value) {
  if (value === true) return 'medium'
  if (value === false) return 'off'
  if (typeof value === 'number' && Number.isFinite(value)) {
    // A numeric scale is a client's own: 0 is off, and past 2 is as hard as it gets.
    if (value <= 0) return 'off'
    if (value <= 1) return 'low'
    if (value <= 2) return 'medium'
    return 'high'
  }
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!text) return null
  return ALIASES.get(text) || null
}

/**
 * The effort word this model accepts for a level. `minimal` is an OpenAI-reasoning-model step;
 * everywhere else the quietest real setting is `low`.
 *
 * @param {string} level
 * @param {string} modelId
 * @returns {string}
 */
function effortFor(level, modelId) {
  if (level !== 'minimal') return level
  const name = canonicalModelName(modelId)
  return MINIMAL_FAMILIES.some((pattern) => pattern.test(name)) ? 'minimal' : 'low'
}

/** @param {Record<string, any>} body */
function withoutEffort(body) {
  const next = { ...body }
  delete next.reasoning_effort
  delete next.thinking_level
  if (next.reasoning && typeof next.reasoning === 'object' && 'effort' in next.reasoning) {
    const { effort, ...rest } = next.reasoning
    void effort
    if (Object.keys(rest).length > 0) next.reasoning = rest
    else delete next.reasoning
  }
  return next
}

/**
 * What one request to one provider will actually carry.
 *
 * @typedef {object} ThinkingApplication
 * @property {Record<string, any>} body  the body to send
 * @property {boolean} applied           true when an effort field was set
 * @property {string|null} level         the level after normalization
 * @property {'effort'|'openrouter'|'none'} style
 * @property {string|null} reason        why nothing was set, when nothing was
 */

/**
 * Translates a level into the provider's own field, or removes it when the model cannot use it.
 *
 * Never throws and never mutates its input: the proxy rebuilds a body per attempt, and a
 * translation that edited the client's payload would leak into the next candidate model.
 *
 * @param {unknown} providerKey
 * @param {Record<string, any>} body
 * @param {unknown} level
 * @param {unknown} [modelId]
 * @returns {ThinkingApplication}
 */
export function applyThinkingLevel(providerKey, body, level, modelId = null) {
  const style = thinkingStyleFor(providerKey)
  const resolved = normalizeThinkingLevel(level)
  const base = body && typeof body === 'object' ? body : {}
  const model = modelId || base.model || ''

  if (style === 'none') {
    // Nothing to translate to. The field is removed anyway: a client that sends it must not
    // get a 400 from a wire that has no idea what it means.
    return {
      body: withoutEffort(base),
      applied: false,
      level: resolved,
      style,
      reason: 'this provider has no effort control',
    }
  }

  if (!resolved || resolved === 'off') {
    return {
      body: withoutEffort(base),
      applied: false,
      level: resolved || 'off',
      style,
      reason: 'thinking is off',
    }
  }

  if (!modelTakesThinking(model)) {
    return {
      body: withoutEffort(base),
      applied: false,
      level: resolved,
      style,
      reason: `\`${model || 'this model'}\` has no reasoning mode`,
    }
  }

  const effort = effortFor(resolved, String(model))
  const next = withoutEffort(base)
  if (style === 'openrouter') {
    const reasoning = base.reasoning && typeof base.reasoning === 'object' ? base.reasoning : {}
    next.reasoning = { ...reasoning, effort }
  } else {
    next.reasoning_effort = effort
  }
  return { body: next, applied: true, level: resolved, style, reason: null }
}
