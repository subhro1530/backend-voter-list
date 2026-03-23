# Gemini Startup Check + Smart Fallback Frontend Prompt

Use this prompt directly in your frontend repository.

---

You are working in an existing frontend app for the voter-list backend.
Implement a next-gen Gemini engine monitor that reflects startup key assessment and free->paid fallback clearly.

## Goal

Minimize user-visible OCR delays by making dispatch behavior transparent:

1. Free keys are primary.
2. Exhausted/rate-limited keys are skipped based on backend startup assessment.
3. If free pool is unavailable, backend auto-switches to paid pool.
4. UI must explain this instantly during upload/session processing.

## Backend Behavior You Must Reflect

Backend now does:

1. Startup key assessment script before server start (`scripts/checkGeminiKeysOnStartup.js`).
2. Persists key state to DB and skips unusable keys quickly.
3. Uses adaptive cooldown (not fixed 15s) for temporary rate limits.
4. Uses dispatch tier policy:
   - Prefer `free`
   - Fall back to `paid` when free not available

## APIs to Use

1. `GET /api-keys/status` (admin)
2. `GET /api-keys/dispatch-status` (authenticated)
3. `GET /sessions/:id/status` (admin)
4. `GET /api-keys/dispatch-mode` (authenticated)
5. `PATCH /api-keys/dispatch-mode` (admin, body: `{ "mode": "auto|free-only|paid-only" }`)
6. `POST /sessions` with optional `dispatchMode`
7. `POST /sessions/:id/resume` with optional `dispatchMode`

## Required UI

### A) Dispatch Banner

Show a top banner in OCR/session pages:

1. If `activeDispatchTier === "free"`: `Using FREE Gemini pool`
2. If `activeDispatchTier === "paid"`: `FREE pool unavailable. Using PAID fallback pool`

Also show current configured dispatch mode:

1. `auto`
2. `free-only`
3. `paid-only`

### A1) Dispatch Mode Toggle (Required)

Add a segmented toggle in admin upload/session controls:

1. `Auto (Free -> Paid Fallback)`
2. `Free Only`
3. `Paid Only (Fastest)`

Behavior:

1. Read current mode from `GET /api-keys/dispatch-mode`
2. On toggle change call `PATCH /api-keys/dispatch-mode`
3. Refresh `/api-keys/status` snapshot immediately
4. Show toast:

- `Dispatch mode set to paid-only`
- `Dispatch mode set to free-only`
- `Dispatch mode set to auto`

When starting/resuming a session, include selected mode in payload:

1. `POST /sessions` -> include `dispatchMode`
2. `POST /sessions/:id/resume` -> include `dispatchMode`

### B) Startup Assessment Snapshot

After page load, fetch `GET /api-keys/dispatch-status` immediately and render:

1. Active dispatch tier
2. Free pool counters (available/active/rateLimited/exhausted)
3. Paid pool counters (available/active/rateLimited/exhausted)

### C) Processing-Aware Polling

While session is `processing`:

1. Poll `/api-keys/status` every 5s (admin) or `/api-keys/dispatch-status` every 5s (non-admin)
2. Poll `/sessions/:id/status` every 3s
3. Stop polling once session is `completed|failed|paused`

### D) Explain Delays Properly

When many keys are rate-limited:

1. Show info text: `Backend is waiting for key cooldown windows; retries are adaptive.`
2. Do NOT show misleading fixed timer like `retry after 15s`

If mode is `free-only` and pool is heavily limited, show CTA:

1. `Switch to paid-only for faster OCR`

### E) Engine Table (Admin)

Columns:

1. Engine
2. Tier
3. Status (`active|rate_limited|exhausted`)
4. Busy
5. Requests
6. Success
7. Recovery time

## Suggested Frontend Types

```ts
type DispatchStatus = {
  configuredDispatchMode: "auto" | "free-only" | "paid-only";
  activeDispatchTier: "free" | "paid";
  paidFallbackActive: boolean;
  totalEngines: number;
  activeEngines: number;
  rateLimitedEngines: number;
  exhaustedEngines: number;
  busyEngines: number;
  availableEngines: number;
  pools: {
    free: PoolCounters;
    paid: PoolCounters;
  };
  allExhausted: boolean;
  updatedAt?: string;
};

type PoolCounters = {
  total: number;
  active: number;
  rateLimited: number;
  exhausted: number;
  busy: number;
  available: number;
};
```

## Error and Edge Cases

1. If status API fails, keep last snapshot and show `Engine status temporarily unavailable`.
2. If `allExhausted === true`, show CTA: `Wait for quota recovery or add more paid keys`.
3. If dispatch tier flips free->paid during processing, show toast `Switched to paid fallback for continuity`.
4. If mode is `paid-only` but paid pool has no available keys, show `Paid pool currently cooling down`.

## Acceptance Criteria

1. User can clearly see why OCR is waiting or switching pools.
2. UI reflects startup key assessment result at app load.
3. UI reflects live tier transitions during processing.
4. No hardcoded `15s` messaging anywhere.
5. Admin can inspect per-engine recovery states in table.
6. Admin can force `paid-only` mode from UI and start/resume sessions with that mode.
