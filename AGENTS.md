# Agent Instructions

## Post-Feature Testing

After completing any feature or fix, the agent MUST:

1. Run `pnpm test` to verify the complete unit-test suite passes
2. If any test fails, fix the issue immediately
3. Re-run `pnpm test` until all tests pass

This ensures the codebase remains in a working state at all times.

## Git Commits

When making a commit on behalf of the user, NEVER prefix your commit message with `fix:`, `feature:`, `feat:`, `chore:`, or any other prefix. 
Just write a descriptive sentence of what was changed.

## Test Architecture

- Tests live in `test/test.js` using Node.js built-in `node:test` + `node:assert` (zero deps)
- Pure logic functions are in `lib/utils.js` (extracted from the main CLI for testability)
- The main CLI (`bin/hammer.js`) imports from `lib/utils.js`; the README documents how to run it
- If you add new pure logic (calculations, parsing, filtering), add it to `lib/utils.js` and write tests
- If you modify existing logic in `lib/utils.js`, update the corresponding tests

### What's tested:
- **sources.js data integrity** — model structure, valid tiers, no duplicates, count consistency
- **Core logic** — getAvg, getVerdict, getUptime, sortResults, findBestModel
- **CLI arg parsing** — current router flags (`--port`, `--no-log`, `--ban`, `--onboard`)
- **Tool wiring** — CLI arg parsing, server routes, config normalization

## Model Quality Scores

Model quality is refreshed from OpenRouter's public Models API at runtime and cached for 24 hours. The 0–1 score hierarchy, in order:

1. LMArena (text leaderboard) Elo, normalized as a board percentile
2. `benchmarks.artificial_analysis.coding_index / 100`
3. Design Arena `models/codecategories` Elo converted to a 0–1 coding score by the regression trained from catalog models that have both values
4. The bounded metadata estimate in `lib/model-quality.js` (popularity, recency, coding capabilities, and context length)
5. `scores.js` as an offline fallback
6. No score at all (`null`) when no catalog match or local fallback exists — the dashboard renders it as `—`, never a placeholder value

Everything the dashboard displays is on one Elo-like scale. Real LMArena ratings (`lmarena-overall`/`lmarena-coding` in the model rows) are shown plain; the coding board is marked `Code`; every other display value is an estimate marked with a `*`:

- Artificial Analysis coding indexes are mapped onto the Elo scale by the anchor regression fit from catalog models that have both an AA index and an LMArena rating (`fitAAEloRegression`), clamped to the observed anchor range.
- Design Arena models show their raw Design Arena Elo rating.
- Metadata and offline (`scores.js`) estimates show the board Elo at their score's percentile (`eloForPercentile`, the inverse of `normalizeLMarenaElo`).

These estimates MUST remain labeled (the `*` marker and the hover source/detail) and never be described as verified. Never silently substitute an invented benchmark.

### Audit Command

From the project checkout, always run the source version of the command—not a globally installed package:

```powershell
node .\bin\hammer.js refresh-scores
```

The command requires network access. It prints every configured or discovered model in descending score order, the source used, fallback markers, source counts, and provider-discovery warnings. A provider warning means the audit is incomplete; do not conclude that all models were checked.

When model aliases appear as separate rows, add canonical aliases in `sources.js` and a dated offline fallback in `scores.js`, then rerun the command. Keep score computation in `lib/model-quality.js` and add pure-logic tests in `test/test.js` whenever the hierarchy, matching, regression, or metadata formula changes.
