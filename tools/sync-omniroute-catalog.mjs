#!/usr/bin/env node
/**
 * ── Regenerate the vendored OmniRoute free-tier roster ─────────────────────────────────
 *
 * Vendoring the catalog as *data* (rather than scraping provider config at runtime) keeps
 * the import reproducible and diffable: a provider appearing or disappearing shows up as
 * a reviewable change rather than as routing that quietly behaves differently.
 *
 * Source: OmniRoute's `docs/reference/FREE_TIERS.md` (MIT), whose per-provider table is
 * generated from their canonical `open-sse/config/freeModelCatalog.ts`. Their own
 * methodology is preserved in what we store: one-time signup credits do NOT recur and are
 * kept separate from steady monthly grants, and providers that are rate-limited with no
 * published token cap are classified `permanent` and never summed into a headline.
 *
 * Notes already curated in the checked-in file are preserved across a refresh, because
 * they are human judgement (what a terms clause actually says) rather than something the
 * upstream table can regenerate.
 *
 * Usage:
 *   node tools/sync-omniroute-catalog.mjs            # fetch and rewrite the catalog
 *   node tools/sync-omniroute-catalog.mjs --check    # report drift, write nothing
 *   node tools/sync-omniroute-catalog.mjs --print    # print the parsed roster
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CATALOG_PATH = new URL('../lib/providers/omniroute-catalog.json', import.meta.url)
const SOURCE_DOC_URL =
  'https://raw.githubusercontent.com/diegosouzapw/OmniRoute/main/docs/reference/FREE_TIERS.md'

/**
 * 📖 The free-type column maps onto our access vocabulary. `one-time` and `uncapped` are
 * 📖 the two that most easily get misread: a one-time credit is not a recurring grant,
 * 📖 and "uncapped" means rate-limited with no published token budget.
 */
const ACCESS_BY_FREE_TYPE = {
  recurring: 'recurring',
  'one-time': 'signup-credit',
  uncapped: 'permanent',
  'signup credit': 'signup-credit',
  keyless: 'keyless',
}

/**
 * Providers explicitly removed from Hammer. Upstream still listing one does not make it a
 * Hammer provider, and keeping this exclusion in the sync prevents the next catalog refresh
 * from silently restoring its routing, quota, or key-page metadata.
 *
 * `liquid` joins it at the operator's instruction (2026-09-25). The roster row claims
 * `keyless` access, which hammer's own resolution already contradicted: `console.liquid.ai`
 * issues a bearer key for `inference.liquid.ai`. Liquid AI publishes no recurring free
 * hosted allowance — the free offer is a *licence* to self-host the LFM weights (free below
 * $10M annual revenue) plus the permanently-free LEAP tooling tier, neither of which is
 * metered inference — and hosted LFM access is free only through OpenRouter's `:free`
 * routing, which is OpenRouter's grant rather than Liquid's.
 *
 * `longcat` joins them at the operator's instruction (2026-09-25). Its access class was not
 * wrong — the row's `signup-credit` is exactly what LongCat offers — but a one-time voucher
 * is not the recurring access this roster exists to find. LongCat's only free value is a
 * **one-time 10M-token grant** unlocked after account signup plus KYC verification, and the
 * platform's own docs say it does not reset daily or monthly: the Quick Start page lists no
 * free allowance at all, and billing publishes exactly two modes — Token Pack (one-off,
 * valid 30 days) and Pay-As-You-Go against prepaid balance. The 150M/mo grant the row was
 * reclassified from was the LongCat-2.0-Preview allowance (5,000,000 tokens/day,
 * refreshable up to 120,000,000/day with model feedback, changelog 2026-04-20); it ended
 * when billing opened with LongCat-2.0 GA (changelog 2026-06-30), and the earlier
 * 100,000-tokens/day launch tier ended with the Flash models on 2026-05-29. Nothing here
 * recurs, so nothing here belongs in the import.
 *
 * `novita` joins them at the operator's instruction (2026-09-25). Its access class is not
 * wrong the way liquid's was — the roster's `signup-credit` is exactly what Novita offers —
 * but a one-time signup voucher is not the recurring free access this roster exists to find,
 * so it does not belong in the import. Novita's own docs publish no credit figure and frame
 * every request as credit-gated, its `$0/token` rows are badged "TIME LIMITED FREE" by
 * Novita itself, and the free set it listed in June 2026 has since been repriced — which is
 * to say nothing here recurs.
 *
 * The whole of bucket C of `docs/PROVIDER-FREE-TIER-AUDIT.md` — every provider whose free access
 * does *not* recur — joins them at the operator's instruction (2026-09-25). Those rows were
 * previously carried as a refusal or a staged row, which kept them in the roster and countable in
 * the registry while carrying no endpoint; excluding them instead removes every trace the way
 * `longcat` was removed, so nothing reaches a descriptor, a card, a key page or the dashboard.
 * Grouped by what the audit found:
 *
 * - **One-time grants, not tiers**: `scaleway` (1,000,000 tokens once, card required), `vertex`
 *   (a $300 / 90-day trial balance), `agentrouter` (a $200 signup coupon), `together` (which
 *   stopped offering trials altogether), `doubao` (a new-user grant), `ai21` ($10), `hyperbolic`
 *   ($1–$5), `nscale` ($5), `fireworks` ($1), `publicai` (a signup credit, then paid),
 *   `inference-net` ($25), `baichuan` (80 CNY), `sensenova` (an explicitly temporary public
 *   beta), `stepfun` (whose free model ended 2026-06-12), `cerebras` (whose $5 trial needs a
 *   payment method and answers 402 `payment_required`), `deepseek` (5M), `deepinfra` (one-time),
 *   and `freemodel-dev` ($300, on a row that claims to be keyless).
 * - **Free only inside the vendor's own client** (`opencode`, `opencode-zen`): Zen answers every
 *   other caller HTTP 403 `FreeTierError`, which no third-party client can clear.
 * - **Free somewhere else** (`arcee-ai`): Arcee's own API is key-only, and the `:free` claim
 *   refers to OpenRouter's routing, which is OpenRouter's grant rather than Arcee's.
 * - **A duplicate of a host hammer already routes** (`kilo-gateway`): the same chat endpoint and
 *   the same model list as hammer's own `kilocode`, so every row it reaches is a second copy.
 * - **Dead services** (`predibase`, `monsterapi`): neither host answers at all any more.
 *
 * `scaleway` is listed even though it is hammer's own row rather than an import. The roster lists
 * it, so leaving it out would let the import re-register it as an OmniRoute provider the moment
 * hammer's own descriptor is deleted — the exclusion is what makes the removal stick.
 */
export const EXCLUDED_PROVIDER_KEYS = new Set([
  'nebius',
  'liquid',
  'novita',
  'longcat',
  // Bucket C of the free-tier audit: no recurring free usage.
  'scaleway',
  'vertex',
  'agentrouter',
  'together',
  'doubao',
  'ai21',
  'hyperbolic',
  'nscale',
  'fireworks',
  'publicai',
  'inference-net',
  'stepfun',
  'sensenova',
  'baichuan',
  'arcee-ai',
  'cerebras',
  'deepseek',
  'deepinfra',
  'freemodel-dev',
  'opencode',
  'opencode-zen',
  'kilo-gateway',
  'predibase',
  'monsterapi',
])

const TOKEN_MULTIPLIERS = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

/**
 * Parses a token figure like `~1.00B`, `~150M`, `800K`, `~25K`.
 *
 * @param {string} value
 * @returns {number|null} null for the `—` / `uncapped*` cells, which carry no figure
 */
export function parseTokenFigure(value) {
  const text = String(value || '')
    .trim()
    .replace(/[~,\s]/g, '')
  const match = text.match(/^([0-9]*\.?[0-9]+)([KkMmBb])$/)
  if (!match) return null
  const amount = Number.parseFloat(match[1])
  const multiplier = TOKEN_MULTIPLIERS[match[2].toLowerCase()]
  if (!Number.isFinite(amount) || !multiplier) return null
  return Math.round(amount * multiplier)
}

/** Reads `key: value` pairs out of the document's YAML frontmatter. */
export function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fields = {}
  for (const line of match[1].split('\n')) {
    const [rawKey, ...rest] = line.split(':')
    if (!rawKey || rest.length === 0) continue
    fields[rawKey.trim()] = rest.join(':').trim().replace(/^"|"$/g, '')
  }
  return fields
}

/**
 * Parses the per-provider table out of the document.
 *
 * The table's shape is `| \`key\` | free type | steady tokens/mo | first-month credit |
 * ToS | models |`. Rows are matched by their column count rather than by position in the
 * document, so an unrelated table above it cannot be mistaken for the roster.
 *
 * @param {string} markdown
 * @returns {object[]}
 */
export function parseProviderRoster(markdown) {
  const providers = []
  const seen = new Set()

  for (const line of String(markdown).split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    // "| a | b |" splits into ['', 'a', 'b', ''] — six columns means eight parts.
    if (cells.length !== 8) continue

    const [, rawKey, rawFreeType, rawSteady, rawCredit, rawTos, rawModels] = cells
    const key = rawKey.replace(/`/g, '').trim()
    if (!key || !/^[a-z0-9][a-z0-9-]*$/.test(key)) continue

    const freeType = rawFreeType.toLowerCase()
    const access = ACCESS_BY_FREE_TYPE[freeType]
    if (!access) continue
    if (seen.has(key)) continue

    const tos = rawTos.toLowerCase()
    const modelCount = Number.parseInt(rawModels, 10)
    const steady = parseTokenFigure(rawSteady)
    const credit = parseTokenFigure(rawCredit)

    const entry = { key, access }
    if (steady != null) entry.steadyTokensPerMonth = steady
    if (credit != null) entry.signupCreditTokens = credit
    entry.tos = ['ok', 'caution', 'ambiguous', 'avoid', 'unknown'].includes(tos) ? tos : 'unknown'
    if (Number.isFinite(modelCount)) entry.modelCount = modelCount

    seen.add(key)
    providers.push(entry)
  }

  return providers
}

async function fetchSourceDoc() {
  const response = await fetch(SOURCE_DOC_URL)
  if (!response.ok) throw new Error(`could not fetch ${SOURCE_DOC_URL}: HTTP ${response.status}`)
  return response.text()
}

/** Notes are human judgement; carry them across a refresh instead of losing them. */
function existingNotes() {
  if (!existsSync(CATALOG_PATH)) return {}
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    return Object.fromEntries(
      (raw.providers || []).filter((p) => p.note).map((p) => [p.key, p.note]),
    )
  } catch {
    return {}
  }
}

function buildCatalog({ roster, frontmatter, previous }) {
  const notes = existingNotes()
  return {
    _source: {
      project: 'OmniRoute',
      license: 'MIT',
      repo: 'https://github.com/diegosouzapw/OmniRoute',
      document: 'docs/reference/FREE_TIERS.md',
      documentVersion: frontmatter.version || previous.documentVersion || null,
      documentLastUpdated: frontmatter.lastUpdated || previous.documentLastUpdated || null,
      fetchedAt: new Date().toISOString().slice(0, 10),
      canonicalCatalog: [
        'open-sse/config/freeModelCatalog.ts',
        'open-sse/config/freeTierCatalog.ts',
      ],
      attribution:
        "Free-tier roster, token economics and terms-of-service flags imported from OmniRoute (MIT). OmniRoute's own methodology: one-time signup credits do not recur and are reported separately from steady monthly grants; providers with rate limits but no published token cap are classified 'permanent' and deliberately never summed.",
      note: "This is the roster and its economics. It is NOT yet endpoint configuration: the per-provider base URL, credential shape and model list live in OmniRoute's `freeTierCatalog.ts` / `freeModelCatalog.ts`, which the sync tool resolves. Rows without a resolved endpoint register as `resolved: false` so the roster is visible and countable without pretending it is routable.",
    },
    providers: roster.map((entry) => {
      const note = notes[entry.key]
      return note ? { ...entry, note } : entry
    }),
  }
}

function describeDrift(previous, next) {
  const before = new Map((previous.providers || []).map((p) => [p.key, p]))
  const after = new Map(next.providers.map((p) => [p.key, p]))
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...after.keys()].filter((k) => {
    if (!before.has(k)) return false
    const a = { ...before.get(k) },
      b = { ...after.get(k) }
    delete a.note
    delete b.note
    return JSON.stringify(a) !== JSON.stringify(b)
  })
  return { added, removed, changed }
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const printOnly = args.includes('--print')

  const previous = existsSync(CATALOG_PATH)
    ? JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    : { providers: [] }

  const markdown = await fetchSourceDoc()
  const frontmatter = parseFrontmatter(markdown)
  const roster = parseProviderRoster(markdown).filter(
    (entry) => !EXCLUDED_PROVIDER_KEYS.has(entry.key),
  )

  if (roster.length === 0) {
    console.error('✖ parsed zero providers — the upstream document format has probably changed.')
    console.error('  The roster table is matched by column count; check whether its columns moved.')
    process.exit(1)
  }

  if (printOnly) {
    console.log(JSON.stringify(roster, null, 2))
    return
  }

  const next = buildCatalog({ roster, frontmatter, previous })
  const { added, removed, changed } = describeDrift(previous, next)

  console.log(
    `source: ${frontmatter.version || 'unknown'} (updated ${frontmatter.lastUpdated || 'unknown'})`,
  )
  console.log(`roster: ${roster.length} providers (checked in: ${previous.providers?.length || 0})`)
  console.log(`added:   ${added.length ? added.join(', ') : '(none)'}`)
  console.log(`removed: ${removed.length ? removed.join(', ') : '(none)'}`)
  console.log(`changed: ${changed.length ? changed.join(', ') : '(none)'}`)

  if (checkOnly) {
    const drifted = added.length + removed.length + changed.length
    if (drifted > 0) {
      console.error(`\n✖ vendored catalog has drifted from upstream in ${drifted} provider(s).`)
      process.exit(1)
    }
    console.log('\n✔ vendored catalog matches upstream.')
    return
  }

  writeFileSync(CATALOG_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`\n✔ wrote ${new URL(CATALOG_PATH).pathname}`)
  console.log(
    '  Run `node tools/verify-providers.mjs` to see which imported rows still lack an endpoint.',
  )
}

// Only run when invoked directly, so the parsers stay importable by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✖ ${error.message}`)
    process.exit(1)
  })
}
