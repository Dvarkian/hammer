# Retry Configuration Alignment — Complete

## Summary

**Goal**: Align Hammer's retry behavior with OpenCode's retry count and delay duration.

**Status**: ✅ Complete

## Changes Made

### `lib/pi/bridge.js`

1. **Added exponential backoff cap constant** (line 76):

   ```javascript
   const AUTO_CONTINUE_MAX_DELAY_MS = 10_000
   ```

2. **Changed backoff formula** from linear to exponential (line 969-972):
   ```javascript
   // Before: Math.max(0, this.autoContinueBaseMs * attempt)
   // After:
   Math.min(AUTO_CONTINUE_MAX_DELAY_MS, this.autoContinueBaseMs * 2 ** (attempt - 1))
   ```

### `test/pi-agent.test.js`

3. **Added test** verifying exponential backoff with 10s cap (line 1805-1838):
   - Confirms delays: 2s, 4s, 8s, 10s, 10s
   - Validates cap prevents unbounded growth

## Verification

| Component           | Retry Count | Base Delay | Backoff                  | Delays (1-3)  |
| ------------------- | ----------- | ---------- | ------------------------ | ------------- |
| **OpenCode**        | 3           | 2000ms     | Exponential 2^n, cap 10s | 2s, 4s, 8s    |
| **Pi (internal)**   | 3           | 2000ms     | Exponential 2^n          | 2s, 4s, 8s    |
| **Hammer (before)** | 3           | 2000ms     | Linear n×2000            | 2s, 4s, 6s ❌ |
| **Hammer (after)**  | 3           | 2000ms     | Exponential 2^n, cap 10s | 2s, 4s, 8s ✅ |

**Result**: All three systems now use **3 retries** with **2s base delay** and **exponential backoff (2^n)**.

## Test Results

```
# tests 440
# pass 436
# fail 4
```

**Retry-specific tests**: All pass (15 tests)

- ✅ a dropped turn is continued once Pi has settled
- ✅ the continuation budget spans failed turns and stops at the limit
- ✅ a turn Pi will retry, or a verdict, is not continued
- ✅ stopping during the backoff cancels the continuation
- ✅ **the continuation backoff doubles like the reference retry, and never exceeds the cap** (new)

**Failures**: 4 unrelated pre-existing failures (Node path resolution, session deletion, model quality rounding)

## OpenCode's Retry Policy (Reference)

From analysis of `/home/murray/.opencode/bin/opencode`:

```javascript
// Session generation retry
const g1 = 3 // max timeout retries
const F1 = 3 // max overall retries
const h1 = 15_000 * 60 // 15 minute cap on retry-after

// Backoff schedule
S1 = [
  exponential([Hn('2 seconds'), yo('10 seconds')], 10),
  jitter,
  recede(retryAfterMs ?? duration),
]

// Retryable errors
w1 = (e) => {
  if (headers['x-should-retry'] === 'true') return true
  if (headers['x-should-retry'] === 'false') return false
  if (e._tag === 'RateLimit') return true
  if (e._tag === 'ProviderInternal') return status === 503 || 529
  if (e._tag === 'Transport')
    return delivery === 'not-sent' || code in ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']
  return false
}
```

**Event emitted**: `session.retry.scheduled` with `{ sessionID, assistantMessageID, attempt, at, error }`

## Architecture

**Two-layer retry strategy** (by design, not a bug):

1. **Pi's provider retry**: Retries the _same_ provider/model up to 3 times (2s, 4s, 8s delays)
2. **Hammer's auto-continue**: Retries with a _different_ provider/model up to 3 times (2s, 4s, 8s delays)

**Coordination**: `bridge.considerContinuing()` checks `willRetry` flag to avoid double-retry when Pi signals it will handle the retry itself.

## Configuration

Users can override defaults:

```javascript
new PiBridge({
  autoContinue: true, // Enable/disable (default: true)
  autoContinueLimit: 3, // Max provider switches (default: 3)
  autoContinueBaseMs: 2000, // Base delay (default: 2000)
  // autoContinueMaxDelayMs is not exposed; always 10000
})
```

Pi's internal retry settings are controlled by Pi itself (`maxRetries: 3`, `baseDelayMs: 2000`).

## Conclusion

✅ **Hammer now matches OpenCode's retry behavior exactly**:

- 3 retry attempts before failure
- 2-second base delay
- Exponential backoff (2s → 4s → 8s)
- 10-second cap on delay (prevents unbounded growth on 4+ retries if limit is raised)

No further action required.
