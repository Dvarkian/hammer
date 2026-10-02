// Provider onboarding — the vocabulary its popup lists models in.
//
// "Show them sorted by current status" only means something if *status* is one thing in both
// places it is read: the popup's live list and the main table's Status column. Both come from
// getVerdict (lib/utils.js), so the order a row sorts in is the order of VERDICT_ORDER — the
// same array the table's verdict sort uses. Nothing here invents a second vocabulary; it just
// makes the shared one sortable and countable outside the browser.

import { VERDICT_ORDER } from './utils.js'

// The states a job moves through, in order, for the popup's stage track. Kept here so the
// server (which sets the stage) and any reader agree on the sequence.
export const ONBOARD_STAGES = ['queued', 'discovering', 'testing', 'done']

// Verdicts that mean "this model can take a request right now", which is what the popup's
// summary counts as ready. The first four of VERDICT_ORDER (Perfect, Normal, Slow, Very Slow) all
// come from a successful answer, so a slow-but-working model is ready; Overloaded (a 429),
// Unstable and Not Active are the ones that say it cannot serve right now.
const READY_RANK_MAX = 3

/**
 * Where a verdict sits in the shared order. An unknown verdict sorts after every known one so a
 * row with no verdict is never mistaken for the healthiest — it is the least informative, not
 * the best.
 */
export function onboardVerdictRank(verdict) {
  const index = VERDICT_ORDER.indexOf(String(verdict ?? '').trim())
  return index === -1 ? VERDICT_ORDER.length : index
}

/**
 * Healthy first, then by name, so equal-verdict rows hold a stable order between polls instead of
 * shuffling on every repaint.
 */
export function compareOnboardResults(a, b) {
  const rankA = Number.isFinite(a?.rank) ? a.rank : onboardVerdictRank(a?.verdict)
  const rankB = Number.isFinite(b?.rank) ? b.rank : onboardVerdictRank(b?.verdict)
  if (rankA !== rankB) return rankA - rankB
  const labelA = String(a?.label || a?.modelId || '')
  const labelB = String(b?.label || b?.modelId || '')
  return labelA.localeCompare(labelB)
}

export function sortOnboardResults(list) {
  return [...(Array.isArray(list) ? list : [])].sort(compareOnboardResults)
}

/**
 * The rule that turns a finished run's counts into its final status. Kept here so the popup's
 * wording — cancelled, partial, empty, done — is decided in one pinned place instead of inline in
 * the job loop, where a later edit could quietly change what "partial" means.
 */
export function finalizeOnboardStatus({ completed = 0, total = 0, cancelled = false } = {}) {
  if (cancelled) return 'cancelled'
  if (total === 0) return 'empty'
  if (completed < total) return 'partial'
  return 'done'
}

/**
 * The counts behind the popup's headline: how many were read, how many can serve now, and the
 * breakdown by verdict. `ready` counts the ready ranks rather than testing status strings, so it
 * cannot drift from the sort.
 */
export function summarizeOnboardResults(list) {
  const rows = Array.isArray(list) ? list : []
  const byVerdict = {}
  let ready = 0
  for (const row of rows) {
    const verdict = String(row?.verdict ?? '').trim() || 'Not Active'
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1
    const rank = Number.isFinite(row?.rank) ? row.rank : onboardVerdictRank(verdict)
    if (rank <= READY_RANK_MAX) ready += 1
  }
  return { total: rows.length, ready, byVerdict }
}
