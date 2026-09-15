// Probe Google's favicon service for candidate domains; detect default-globe fallback via hash.
import crypto from 'node:crypto';

const REF = 'does-not-exist-abc123xyz123.com'; // guaranteed-unregistered reference domain

const candidates = [
  // currently resolved domains (verify they serve real icons)
  'openai.com','qwen.ai','meta.com','deepseek.com','mistral.ai','anthropic.com',
  'zhipuai.cn','moonshot.ai','ai.google.dev','minimax.chat','minimax.io','nvidia.com',
  'stepfun.com','microsoft.com','cognition.ai','xiaomi.com','x.ai','igenius.ai',
  'bytedance.com','stockmark.com','stockmark.ai','ibm.com','arcee.ai',
  // candidates for the 6 missing models
  'corethink.ai','corethink.ai.uk','gigapotato.ai','openrouter.ai','g4f.dev','g4f.ai',
  // suspects / alternates
  'lgai.research','lgresearch.ai','inclusionai.com','deepcogito.com','upstage.ai',
  'tii.ae','cohere.com','poolside.ai','canopylabs.ai','groq.com','ai21.com','allenai.org',
  'z.ai','hunyuan.tencent.com','chatgpt.com','openai.dev','codex.openai.com',
];

async function fetchHash(domain) {
  const url = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return `HTTP ${res.status}`;
    const buf = Buffer.from(await res.arrayBuffer());
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch (e) {
    return `ERR ${e.cause?.code || e.name}`;
  }
}

const refHash = await fetchHash(REF);
console.log(`reference (${REF}) md5 = ${refHash}\n`);

const results = await Promise.all(candidates.map(async (d) => [d, await fetchHash(d)]));

const real = [], globe = [], other = [];
for (const [d, h] of results) {
  if (h === refHash) globe.push(d);
  else if (/^(HTTP|ERR)/.test(h)) other.push(`${d} (${h})`);
  else real.push(`${d} (${h})`);
}
console.log('HAS REAL ICON:');
real.forEach((s) => console.log('  ' + s));
console.log('\nDEFAULT GLOBE (no icon):');
globe.forEach((s) => console.log('  ' + s));
console.log('\nERRORS:');
other.forEach((s) => console.log('  ' + s));
