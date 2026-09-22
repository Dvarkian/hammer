// Throwaway audit: resolves the network-plot icon for every model in sources.js
// using the exact getModelDomain code extracted from public/dashboard.js.
import fs from 'node:fs'
import { MODELS, MODEL_ID_ALIASES } from './sources.js'

const script = fs.readFileSync('public/dashboard.js', 'utf8')
const start = script.indexOf('const MODEL_DOMAINS = {')
const fnStart = script.indexOf('function getModelDomain(m)', start)
if (start === -1 || fnStart === -1) throw new Error('icon maps not found in public/dashboard.js')
const brace = script.indexOf('{', fnStart)
let depth = 0, end = -1
for (let i = brace; i < script.length; i++) {
  if (script[i] === '{') depth++
  else if (script[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
}
const { getModelDomain, MODEL_DOMAINS } = new Function(script.slice(start, end) + '; return { getModelDomain, MODEL_DOMAINS };')()

// Every model id that can appear as a node: MODELS entries + alias targets.
const aliasTargets = new Set(Object.values(MODEL_ID_ALIASES))
const byDomain = new Map()
const missing = []
for (const [modelId, label, , , providerKey] of MODELS) {
  const domain = getModelDomain({ modelId, model: modelId })
  if (!domain) missing.push([modelId, label, providerKey])
  else if (!byDomain.has(domain)) byDomain.set(domain, [[modelId, label, providerKey]])
  else byDomain.get(domain).push([modelId, label, providerKey])
}

console.log(`MODELS: ${MODELS.length} rows, ${new Set(MODELS.map(m => m[0])).size} unique ids`)
console.log(`MODEL_DOMAINS entries: ${Object.keys(MODEL_DOMAINS).length}`)
console.log(`\n=== MISSING ICON (resolve to '' → monogram fallback): ${missing.length} ===`)
for (const [id, label, prov] of missing) console.log(`  ${id}  (${label})  [${prov}]`)

console.log(`\n=== RESOLVED (${[...byDomain.keys()].length} distinct domains) ===`)
for (const [domain, rows] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${domain}  (${rows.length})`)
  for (const [id, label, prov] of rows) console.log(`    ${id}  (${label})  [${prov}]`)
}
