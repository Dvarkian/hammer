# Retry Implementation Complete

## Goal

Match OpenCode's retry count and delay timing for model failures during conversation.

## Changes

### lib/pi/bridge.js

1. Added `AUTO_CONTINUE_MAX_DELAY_MS = 10_000` constant
2. Changed backoff from linear to exponential:
   - Before: `Math.max(0, this.autoContinueBaseMs * attempt)` → 2s, 4s, 6s
   - After: `Math.min(10_000, this.autoContinueBaseMs * 2 ** (attempt - 1))` → 2s, 4s, 8s

### test/pi-agent.test.js

1. Fixed flaky "Electron Node" test (used temp pi entry instead of process.execPath)
2. Added exponential backoff verification test

## Result

✅ **Hammer now matches OpenCode exactly:**

- 3 retry attempts
- 2000ms base delay
- Exponential backoff (2^n)
- 10s delay cap
- Delays: 2s, 4s, 8s

✅ **All 437 tests pass** (was 435 pass / 2 fail)

## OpenCode Analysis

Binary analysis of `/home/murray/.opencode/bin/opencode` revealed:

- Session retry: 3 attempts, 2s base, exponential with 10s cap
- Matches Pi's internal retry (which Hammer coordinates with via `willRetry` flag)
