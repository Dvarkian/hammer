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
const SOURCE_DOC_URL = 'https://raw.githubusercontent.com/diegosouzapw/OmniRoute/main/docs/reference/FREE_TIERS.md'

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

const TOKEN_MULTIPLIERS = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

/**
 * Parses a token figure like `~1.00B`, `~150M`, `800K`, `~25K`.
 *
 * @param {string} value
 * @returns {number|null} null for the `—` / `uncapped*` cells, which carry no figure
 */
export function parseTokenFigure(value) {
  const text = String(value || '').trim().replace(/[~,\s]/g, '')
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
    const cells = line.split('|').map(cell => cell.trim())
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
      (raw.providers || []).filter(p => p.note).map(p => [p.key, p.note]),
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
        'Free-tier roster, token economics and terms-of-service flags imported from OmniRoute (MIT). OmniRoute\'s own methodology: one-time signup credits do not recur and are reported separately from steady monthly grants; providers with rate limits but no published token cap are classified \'permanent\' and deliberately never summed.',
      note:
        'This is the roster and its economics. It is NOT yet endpoint configuration: the per-provider base URL, credential shape and model list live in OmniRoute\'s `freeTierCatalog.ts` / `freeModelCatalog.ts`, which the sync tool resolves. Rows without a resolved endpoint register as `resolved: false` so the roster is visible and countable without pretending it is routable.',
    },
    providers: roster.map(entry => {
      const note = notes[entry.key]
      return note ? { ...entry, note } : entry
    }),
  }
}

function describeDrift(previous, next) {
  const before = new Map((previous.providers || []).map(p => [p.key, p]))
  const after = new Map(next.providers.map(p => [p.key, p]))
  const added = [...after.keys()].filter(k => !before.has(k))
  const removed = [...before.keys()].filter(k => !after.has(k))
  const changed = [...after.keys()].filter(k => {
    if (!before.has(k)) return false
    const a = { ...before.get(k) }, b = { ...after.get(k) }
    delete a.note; delete b.note
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
  const roster = parseProviderRoster(markdown)

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

  console.log(`source: ${frontmatter.version || 'unknown'} (updated ${frontmatter.lastUpdated || 'unknown'})`)
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
  console.log('  Run `node tools/verify-providers.mjs` to see which imported rows still lack an endpoint.')
}

// Only run when invoked directly, so the parsers stay importable by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`✖ ${error.message}`)
    process.exit(1)
  })
}
