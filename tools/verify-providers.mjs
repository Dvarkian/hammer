#!/usr/bin/env node
/**
 * ── Provider conformance harness ───────────────────────────────────────────────────────
 *
 * Answers two different questions, and keeps them apart:
 *
 *   1. **Coverage** (always, no network): how many providers are registered, how many are
 *      still unresolved imports, and how the terms flags fall out. This is the number
 *      that tells you whether the catalog import actually landed.
 *
 *   2. **Confidence** (`--live`): does a provider answer? A provider is `verified` only
 *      after a real completion returns usable text — never because it was listed.
 *
 * Why `--live` is opt-in: probing sends real requests, and every probe spends token
 * budget and touches somebody else's service. Doing that silently on a 78-provider
 * registry would be both expensive and rude, so the default run is a dry plan.
 *
 * Two terms policies deliberately differ, and this is where they are kept apart. *Routing* to
 * an `avoid`-flagged provider is permitted — the catalog's own project treats the flag as
 * advisory and the operator of this instance has accepted that. *Probing* one is not, unless
 * `--allow-avoid` says so: a bulk sweep must not quietly start sending requests to a service
 * whose terms discourage it, so the harness gates its own network activity even though the
 * router does not gate a user's explicit choice of model.
 *
 * Usage:
 *   node tools/verify-providers.mjs                      # coverage only (no network)
 *   node tools/verify-providers.mjs --live               # probe every resolved, non-avoid provider
 *   node tools/verify-providers.mjs --live --provider groq
 *   node tools/verify-providers.mjs --live --allow-avoid --provider somekey
 *   node tools/verify-providers.mjs --json
 */

import { writeFileSync } from 'node:fs'

import { getApiKey, loadConfig } from '../lib/config.js'
import { listProviders, providerSummary } from '../lib/providers/index.js'
import { shapingReadiness } from '../lib/providers/adapters.js'

const REPORT_PATH = new URL('../lib/providers/verification-report.json', import.meta.url)
const DEFAULT_TIMEOUT_MS = 20_000

function parseArgs(argv) {
  const has = flag => argv.includes(flag)
  const valueOf = flag => {
    const index = argv.indexOf(flag)
    return index === -1 ? null : argv[index + 1] || null
  }
  return {
    live: has('--live'),
    json: has('--json'),
    allowAvoid: has('--allow-avoid'),
    provider: valueOf('--provider'),
    timeoutMs: Number.parseInt(valueOf('--timeout') || '', 10) || DEFAULT_TIMEOUT_MS,
  }
}

function authHeaderFor(descriptor, config) {
  if (descriptor.auth.kind === 'none' || descriptor.auth.optional) {
    const key = descriptor.auth.envVar ? process.env[descriptor.auth.envVar] : null
    return key ? { Authorization: `Bearer ${key}` } : {}
  }
  const key = descriptor.auth.envVar ? process.env[descriptor.auth.envVar] : null
  if (key) return { Authorization: `Bearer ${key}` }
  const fromConfig = getApiKey(config, descriptor.key)
  return fromConfig ? { Authorization: `Bearer ${fromConfig}` } : {}
}

/**
 * Asks a provider for its model list.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, models: number|null, error: string|null }>}
 */
async function probeDiscovery(descriptor, { config, timeoutMs }) {
  const url = descriptor.modelsUrl
  if (!url) return { ok: false, status: null, models: null, error: 'no models URL' }
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaderFor(descriptor, config) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, status: response.status, models: null, error: `HTTP ${response.status}` }
    const payload = await response.json()
    const models = Array.isArray(payload?.data) ? payload.data.length
      : Array.isArray(payload?.models) ? payload.models.length
        : null
    return { ok: true, status: response.status, models, error: null }
  } catch (error) {
    return { ok: false, status: null, models: null, error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error) }
  }
}

/**
 * Sends the smallest real completion that can distinguish "answers" from "does not".
 * The response body is classified with the same rule the router uses, so a provider that
 * returns HTTP 200 with no usable text is not counted as verified.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, usable: boolean, error: string|null }>}
 */
async function probeCompletion(descriptor, { config, timeoutMs, model }) {
  if (!descriptor.chatUrl || !model) {
    return { ok: false, status: null, usable: false, error: 'no chat endpoint or model to test' }
  }
  try {
    const response = await fetch(descriptor.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaderFor(descriptor, config) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'reply OK' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { ok: false, status: response.status, usable: false, error: `HTTP ${response.status}` }
    }
    const payload = await response.json().catch(() => null)
    const text = payload?.choices?.[0]?.message?.content
    const usable = typeof text === 'string' && text.trim().length > 0
    return { ok: usable, status: response.status, usable, error: usable ? null : 'HTTP 200 with no usable text' }
  } catch (error) {
    return { ok: false, status: null, usable: false, error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error) }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const summary = providerSummary()
  const config = loadConfig()

  let targets = listProviders()
  if (args.provider) targets = targets.filter(d => d.key === args.provider)
  // Only `active` providers have an endpoint to call at all; `staged` and `refused` rows
  // are reported by coverage, not probed.
  if (!args.provider) targets = targets.filter(d => d.activation === 'active')

  const refused = targets.filter(d => d.tos === 'avoid' && !args.allowAvoid)
  const probeable = targets.filter(d => d.tos !== 'avoid' || args.allowAvoid)

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.live ? 'live' : 'coverage-only',
    coverage: summary,
    refusedForTerms: refused.map(d => d.key),
    results: [],
  }

  if (!args.live) {
    report.plannedProbes = probeable.map(d => ({
      key: d.key,
      origin: d.origin,
      tos: d.tos,
      discovery: Boolean(d.modelsUrl),
      completion: Boolean(d.chatUrl),
    }))
    emit(report, args)
    console.log(`\nCoverage: ${summary.total} providers (${summary.hammer} hammer, ${summary.imported} imported)`)
    console.log(`  routable:  ${summary.routable} (${summary.routableImported} of them imported)`)
    console.log(`  staged:    ${summary.activation.staged}  <- resolvable in principle, needs provider-specific work`)
    console.log(`  refused:   ${summary.activation.refused}  <- withheld by decision: the terms posture under --exclude-avoid, a row whose free-access premise does not hold, or a row duplicating a provider hammer already routes`)
    console.log(`  terms:     ok ${summary.tos.ok} / caution ${summary.tos.caution} / ambiguous ${summary.tos.ambiguous} / avoid ${summary.tos.avoid} / unknown ${summary.tos.unknown}`)
    const notActive = summary.blocked || []
    if (notActive.length) {
      console.log('\n  Not routable, and why:')
      for (const entry of notActive) {
        console.log(`   ${entry.activation === 'refused' ? '⊘' : '·'} ${entry.key.padEnd(20)} ${entry.reason || '(no reason recorded)'}`)
      }
    }

    // Routable is not the same as ready: a provider whose endpoint embeds an account id, a
    // project or a region has to be configured before its first request can succeed. Reporting
    // that separately is what separates "not imported" from "imported, waiting on one value".
    const unconfigured = listProviders()
      .filter(d => d.activation === 'active')
      .map(d => ({ key: d.key, needs: shapingReadiness(config, d.key) }))
      .filter(row => row.needs)
    if (unconfigured.length) {
      console.log('\n  Routable but not configured (the rest of their shape is already wired):')
      for (const row of unconfigured) console.log(`   · ${row.key.padEnd(20)} ${row.needs}`)
    }
    console.log(`\nDry run: would probe ${probeable.length} active provider(s). Pass --live to send requests.`)
    return
  }

  for (const descriptor of probeable) {
    const discovery = descriptor.modelsUrl ? await probeDiscovery(descriptor, args) : null
    const model = descriptor.models?.[0]?.[0] || null
    const completion = descriptor.chatUrl ? await probeCompletion(descriptor, { ...args, model }) : null
    const usable = completion ? completion.usable : false
    report.results.push({
      key: descriptor.key,
      origin: descriptor.origin,
      tos: descriptor.tos,
      discovery,
      completion,
      verification: usable ? 'verified' : 'failed',
    })
    const mark = usable ? '✔' : '✖'
    console.log(`${mark} ${descriptor.key.padEnd(20)} ${usable ? 'verified' : (completion?.error || discovery?.error || 'unverified')}`)
  }

  const verified = report.results.filter(r => r.verification === 'verified').length
  report.verified = verified
  console.log(`\n${verified}/${report.results.length} probed provider(s) answered with usable text.`)
  emit(report, args)
}

function emit(report, args) {
  // A coverage-only run carries no verification evidence, so writing it would overwrite the
  // last real result with "nothing was probed" — which reads identically to "everything
  // failed". The report is only written when it has something to say.
  if (args.live || args.json) writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  if (args.json) console.log(JSON.stringify(report, null, 2))
}

main().catch(error => {
  console.error(`✖ ${error.message}`)
  process.exit(1)
})
