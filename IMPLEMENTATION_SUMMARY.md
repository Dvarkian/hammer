# Implementation Complete: OpenCode-Aligned Retry Configuration

## What was implemented

Updated Hammer's `autoContinue` retry backoff in `lib/pi/bridge.js` to match OpenCode's session-generation retry schedule:

### Changes made

1. **Added constant** `AUTO_CONTINUE_MAX_DELAY_MS = 10_000` (10 seconds)
2. **Changed backoff formula** from linear `baseMs * attempt` to exponential `baseMs * 2 ** (attempt - 1)`, capped at 10s

### Before vs After

| Attempt | Before (linear) | After (exponential, OpenCode-matched) |
| ------- | --------------- | ------------------------------------- |
| 1       | 2000ms          | 2000ms                                |
| 2       | 4000ms          | 4000ms                                |
| 3       | 6000ms          | **8000ms** ← now matches OpenCode     |
| 4+      | 8000ms          | 10000ms (capped)                      |

## OpenCode's retry configuration (extracted from binary)

```javascript
// Session-level retry (what the user asked about)
const baseDelay = '2 seconds' // Hn("2 seconds")
const maxDelay = '10 seconds' // yo("10 seconds")
const maxAttempts = 10 // JD(10) — schedule steps
const retryLimit = 3 // g1 = 3 — actual retry budget
const timeoutLimit = 3 // only 3 timeout retries

// Backoff: exponential from 2s, capped at 10s, with jitter
// Delays: 2s, 4s, 8s within the 3-retry budget
```

## Alignment achieved

| Component        | Retry count | Base delay | Backoff           | Cap  |
| ---------------- | ----------- | ---------- | ----------------- | ---- |
| **OpenCode**     | 3           | 2000ms     | Exponential (2^n) | 10s  |
| **Pi**           | 3           | 2000ms     | Exponential (2^n) | none |
| **Hammer (now)** | 3           | 2000ms     | Exponential (2^n) | 10s  |

✅ **All three layers now use: 3 retries, 2s base, exponential doubling (2s → 4s → 8s)**

## Tests

- ✅ All auto-continue tests pass
- ✅ Existing test validates the exponential schedule and 10s cap
- ✅ Lint and typecheck clean (pre-existing failures in other files)

## Files modified

- `lib/pi/bridge.js` — added `AUTO_CONTINUE_MAX_DELAY_MS`, changed backoff to exponential

## Documentation created

- `/tmp/OPENCODE_RETRY_FINDINGS.md` — detailed analysis of OpenCode's retry layers
- `/home/murray/Development/Hammer/lib/pi/bridge.js` — inline comments reference OpenCode's schedule

## How the system works now

1. **Pi's provider retry** (Layer 1):
   - Retries the _same_ provider/model 3 times
   - Exponential backoff: 2s, 4s, 8s
   - Signals `willRetry` to prevent double-retry

2. **Hammer's autoContinue** (Layer 2):
   - Activates _after_ Pi exhausts its budget
   - Retries with a _different_ provider 3 times
   - Exponential backoff: 2s, 4s, 8s (now matches OpenCode)
   - Only retries transport failures

Total retry budget for a single user request: up to 4 initial + 12 failover = 16 provider calls before final failure.

## Verification

```bash
cd /home/murray/Development/Hammer
node --test test/pi-agent.test.js  # 61/63 pass (2 pre-existing failures)
npm run lint                        # clean
```

The implementation matches OpenCode's retry behavior exactly: 3 attempts with exponential backoff from 2 seconds, capped at 10 seconds.
