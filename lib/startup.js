const STARTUP_KIRO_WARN_INTERVAL_MS = 5 * 60_000

export function shouldEmitKiroOAuthWarning(status, details = '', now = Date.now(), previous = { key: null, at: 0 }) {
  const key = `${status}:${String(details || '').slice(0, 200)}`
  return !(previous?.key === key && now - Number(previous.at || 0) < STARTUP_KIRO_WARN_INTERVAL_MS)
}

export function formatStartupProviderResult(name, result = {}) {
  const label = String(name || 'provider')
  if (result.ok === false || result.error) return `✗ ${label} — ${result.error || 'discovery failed'}`
  // An explicit note (e.g. "no endpoints configured") replaces the count entirely.
  if (result.note) return `✓ ${label} — ${result.note}`
  // A null count means "nothing to count" (the model-quality index is not a provider),
  // not zero: Number(null) is 0 and 0 is finite, so reading the raw field printed a
  // bogus "— 0 models" for every provider-less discovery task.
  const count = result.count == null ? Number.NaN : Number(result.count)
  return `✓ ${label}${Number.isFinite(count) ? ` — ${count} model${count === 1 ? '' : 's'}` : ''}`
}
