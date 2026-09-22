#!/usr/bin/env node
/**
 * ── Key-page link checker ──────────────────────────────────────────────────────────────
 *
 * `lib/providers/key-pages.json` claims that each URL is where a provider issues its
 * credential. That claim is only worth anything if it is checked, and links to credential
 * pages rot constantly — consoles get reorganised, products get moved, free tiers get
 * retired. This harness is what keeps the table honest:
 *
 *   - It re-checks every URL and reports the HTTP status and the *final* URL after
 *     redirects. A redirect is signal, not noise: a page that now resolves somewhere else
 *     is either a fine move or a dead product.
 *   - `--write` stamps `verifiedAt` and `httpStatus` back into the JSON. Those two fields
 *     are machine-owned; `url` and `evidence` are hand-owned. Keeping the ownership split
 *     explicit is why this tool never edits a URL on its own.
 *   - It cross-checks the table against the registry, because the failure that actually
 *     matters is not a 404 — it is an imported provider whose card silently has nowhere to
 *     send the user. Rows with no key page are listed by name so the gap is visible rather
 *     than discovered later in the dashboard.
 *
 * Requests are sequential and politely spaced. An earlier bulk pass ran these in parallel
 * and collected a pile of connection-level failures that all succeeded when retried one at
 * a time — the throttling was ours, not theirs.
 *
 * Usage:
 *   node tools/verify-key-pages.mjs             # check, report, change nothing
 *   node tools/verify-key-pages.mjs --write     # also stamp verifiedAt/httpStatus
 *   node tools/verify-key-pages.mjs --json      # machine-readable report
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { listProviders } from '../lib/providers/index.js'

const KEY_PAGES_URL = new URL('../lib/providers/key-pages.json', import.meta.url)
const DEFAULT_TIMEOUT_MS = 15_000
const SPACING_MS = 400

function parseArgs(argv) {
  return {
    write: argv.includes('--write'),
    json: argv.includes('--json'),
    timeoutMs: Number.parseInt(argv[argv.indexOf('--timeout') + 1] || '', 10) || DEFAULT_TIMEOUT_MS,
  }
}

function loadKeyPages() {
  return JSON.parse(readFileSync(KEY_PAGES_URL, 'utf8'))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Follows a URL and reports where it ended up.
 *
 * The response body is cancelled as soon as the headers arrive: this is a link check, not a
 * page fetch, and reading 52 full consoles would be both slow and rude.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, finalUrl: string|null, error: string|null }>}
 */
async function checkUrl(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        // A plain Node user agent gets blocked by a few of these consoles, which would show
        // up as a false 403 and send someone hunting for a URL that never broke.
        'User-Agent': 'Mozilla/5.0 (compatible; hammer-key-page-check/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const result = { ok: response.ok, status: response.status, finalUrl: response.url || url, error: null }
    await response.body?.cancel()
    return result
  } catch (error) {
    const name = error?.name
    return {
      ok: false,
      status: null,
      finalUrl: null,
      error: name === 'TimeoutError' ? 'timeout' : String(error?.cause?.code || error?.message || error),
    }
  }
}

/**
 * Providers a user could actually be sent to for a credential, and which have nowhere to go.
 *
 * This reads the registry rather than the file above, so it measures the thing that matters:
 * whether a card has a link once every source is merged. Refused rows are excluded — they
 * cannot route at all, so a missing page is not the same kind of gap.
 */
function keyPageCoverage(keyPages) {
  const all = listProviders()
  const needsPage = all.filter(p => p.activation !== 'refused')
  const curated = new Set(Object.keys(keyPages))
  return {
    covered: needsPage.filter(p => p.signupUrl),
    missing: needsPage.filter(p => !p.signupUrl).map(p => ({ key: p.key, activation: p.activation })),
    // Curated rows nothing in the registry claimed: either a typo in a key, or a provider
    // that was dropped upstream and left its link behind.
    orphans: [...curated].filter(key => !all.some(p => p.key === key)),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const document = loadKeyPages()
  const pages = document.pages || {}
  const keys = Object.keys(pages)

  const report = []
  for (const [index, key] of keys.entries()) {
    const entry = pages[key]
    const check = await checkUrl(entry.url, options.timeoutMs)
    report.push({ key, url: entry.url, ...check })
    if (!options.json) {
      const state = check.ok ? `HTTP ${check.status}` : check.status ? `HTTP ${check.status}` : `FAILED (${check.error})`
      const moved = check.finalUrl && check.finalUrl !== entry.url ? ` -> ${check.finalUrl}` : ''
      process.stdout.write(`  ${String(index + 1).padStart(2)}. ${key.padEnd(16)} ${state.padEnd(12)} ${entry.url}${moved}\n`)
    }
    if (index < keys.length - 1) await sleep(SPACING_MS)
  }

  const coverage = keyPageCoverage(pages)
  const unreachable = report.filter(row => !row.ok)
  const moved = report.filter(row => row.finalUrl && row.finalUrl !== row.url)

  if (options.write) {
    const stamp = new Date().toISOString().slice(0, 10)
    const next = { ...document, pages: { ...pages } }
    for (const row of report) {
      next.pages[row.key] = {
        ...next.pages[row.key],
        // Only a reachable page is stamped as verified. Recording a date against a URL that
        // did not answer would be worse than recording nothing.
        verifiedAt: row.ok ? stamp : next.pages[row.key].verifiedAt || null,
        httpStatus: row.status,
      }
    }
    writeFileSync(KEY_PAGES_URL, `${JSON.stringify(next, null, 2)}\n`)
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ checked: keys.length, report, coverage, wrote: options.write }, null, 2)}\n`)
    return
  }

  process.stdout.write(`\nChecked ${keys.length} key pages: ${report.length - unreachable.length} reachable, ${unreachable.length} unreachable\n`)
  if (unreachable.length) {
    process.stdout.write(`\nUnreachable (fix or remove — a card linking nowhere is worse than a plain heading):\n`)
    for (const row of unreachable) process.stdout.write(`  ${row.key.padEnd(16)} ${row.status || row.error}  ${row.url}\n`)
  }
  if (moved.length) {
    process.stdout.write(`\nResolves elsewhere (check the destination is the credential page before trusting it):\n`)
    for (const row of moved) process.stdout.write(`  ${row.key.padEnd(16)} ${row.url} -> ${row.finalUrl}\n`)
  }
  process.stdout.write(`\nRegistry coverage: ${coverage.covered.length} providers have a key page, ${coverage.missing.length} do not.\n`)
  if (coverage.missing.length) {
    process.stdout.write(`\nWithout a key page (these render as plain headings):\n`)
    for (const row of coverage.missing) process.stdout.write(`  ${row.key.padEnd(16)} ${row.activation}\n`)
  }
  if (coverage.orphans.length) {
    process.stdout.write(`\nCurated but not registered (stale keys):\n`)
    for (const key of coverage.orphans) process.stdout.write(`  ${key}\n`)
  }
}

await main()
