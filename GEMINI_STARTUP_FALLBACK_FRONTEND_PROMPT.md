# Gemini Startup Fallback + Lightspeed OCR Frontend Prompt

Use this prompt directly in your frontend repository.

---

You are working in an existing frontend app for the voter-list backend.
Implement a speed-first OCR control plane that prioritizes throughput and zero-waste API behavior.

## Core Objective

Deliver the fastest possible end-to-end OCR while reducing retries and unnecessary API usage.

1. Remove all image/photo extraction logic from live OCR flow.
2. Use placeholder image rendering only in UI.
3. Let admin force dispatch mode (`paid-only`, `free-only`, `auto`) instantly.
4. Keep polling lean and adaptive to avoid frontend overhead.

## Backend Facts You Must Respect

1. Backend runs startup Gemini key assessment before server boot.
2. Backend persists key state and skips unhealthy keys.
3. Backend supports dispatch modes:
   - `auto` (free first, paid fallback)
   - `free-only`
   - `paid-only`
4. OCR flow is photo-free now (no Cloudinary extraction/upload in hot path).
5. Voter photo field should be treated as placeholder metadata.

## APIs to Use

1. `GET /api-keys/status` (admin)
2. `GET /api-keys/dispatch-status` (authenticated)
3. `GET /api-keys/dispatch-mode` (authenticated)
4. `PATCH /api-keys/dispatch-mode` (admin, body: `{ "mode": "auto|free-only|paid-only" }`)
5. `POST /sessions` (optional `dispatchMode`)
6. `POST /sessions/:id/resume` (optional `dispatchMode`)
7. `GET /sessions/:id/status` (admin)

## Required UX Changes

### 1) Turbo Dispatch Control

Add a segmented control at upload/resume level:

1. `Paid Only (Turbo)`
2. `Auto`
3. `Free Only`

Rules:

1. Default to backend current mode from `GET /api-keys/dispatch-mode`.
2. On selection change, call `PATCH /api-keys/dispatch-mode`.
3. Include selected mode in every `POST /sessions` and `POST /sessions/:id/resume` request payload.
4. Show toast for each change:
   - `Turbo mode enabled: paid-only`
   - `Auto mode enabled`
   - `Free-only mode enabled`

### 2) No-Image OCR Policy in UI

Remove/disable UI features that suggest live photo extraction during OCR.

1. Do not show progress for photo extraction/upload.
2. Do not trigger any client flow that uploads voter photos during session processing.
3. Render voter photo with static placeholder strategy:
   - If `photo_url` starts with `placeholder://`, render local placeholder asset.
   - If `photo_url` is empty/null, render same placeholder.

### 3) Status Panel (High Signal, Low Noise)

Display only the metrics that matter for speed decisions:

1. `configuredDispatchMode`
2. `activeDispatchTier`
3. Free pool `available/rateLimited/exhausted`
4. Paid pool `available/rateLimited/exhausted`
5. `allExhausted`

Do not overload UI with verbose per-engine details by default.

### 4) Smart Polling

While session is `processing`:

1. Poll `GET /sessions/:id/status` every 2s.
2. Poll `GET /api-keys/dispatch-status` every 4s.
3. Pause both polls when tab is hidden.
4. Resume immediately on tab focus.
5. Stop all polls once status becomes `completed|failed|paused`.

### 5) Actionable Delay Messages

1. If `dispatchMode=free-only` and free pool unavailable, show CTA: `Switch to Paid Only (Turbo)`.
2. If `dispatchMode=paid-only` and paid pool cooling down, show: `Paid keys cooling down, retrying automatically.`
3. Never show fixed retry text like `retry after 15s`.

## Suggested Types

```ts
type DispatchMode = "auto" | "free-only" | "paid-only";

type DispatchStatus = {
  configuredDispatchMode: DispatchMode;
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

## Acceptance Criteria

1. Admin can force `paid-only` in one click and upload/resume with that mode.
2. UI no longer includes photo extraction/upload behavior in OCR workflow.
3. Placeholder image is consistently used for voter cards/lists.
4. Polling is efficient and auto-pauses when tab is hidden.
5. Session processing UX explains pool/mode transitions clearly.
6. No hardcoded fixed-delay messaging anywhere.
