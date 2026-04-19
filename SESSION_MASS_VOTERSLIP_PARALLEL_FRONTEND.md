# Sessions Page Frontend Prompt: Parallel Booth Downloads (DB-Safe)

Use this in the frontend repository only.

## Goal

Increase booth-range voter-slip throughput by running multiple booth jobs in parallel while avoiding DB/API overload.

Backend now supports controlled parallel mass rendering workers. Frontend must stop strict serial orchestration to benefit.

## Required Frontend Change

Replace strict one-by-one booth processing with capped concurrency.

Set constants:

```ts
const MAX_PARALLEL_BOOTHS = 3; // recommended start value: 2 or 3
const POLL_INTERVAL_MS = 1200;
const RETRY_LIMIT = 2;
const START_STAGGER_MS = 500; // spread start calls slightly
```

Rules:

1. Maintain a shared queue of booth items (`pending`, `processing`, `downloaded`, `failed`, `skipped`).
2. Start up to `MAX_PARALLEL_BOOTHS` items at once.
3. Each booth item still uses existing endpoints:
   - `POST /user/voterslips/mass/sessions/:sessionId/start`
   - `GET /user/voterslips/mass/jobs/:jobId`
   - `GET /user/voterslips/mass/jobs/:jobId/download`
4. As soon as a booth job is `completed`, download immediately.
5. On booth completion (downloaded/failed/skipped), pull next pending booth into active slot.
6. Do not block all remaining booths because one booth fails.
7. Keep Pause/Resume/Stop behavior at orchestrator level:
   - Pause: stop dispatching new booth starts; continue polling active jobs.
   - Stop: stop dispatching new booth starts and stop polling once active jobs settle.

## Backpressure + Transient Error Handling

For `500/503`, timeout, reset, or transient DB hints:

1. Retry the current booth up to `RETRY_LIMIT`.
2. Use exponential backoff for retries (`800ms`, `1600ms`, `3200ms`).
3. If 2 or more active booths fail with transient errors in short succession, temporarily lower dispatch:
   - Reduce active target from `MAX_PARALLEL_BOOTHS` to `1` for 20-30 seconds.
   - Then restore gradually (`1 -> 2 -> 3`).

This dynamic backoff prevents DB pressure spikes while preserving parallel speed gains.

## Queue UI Additions

Per booth row show:

1. `attempts`
2. `jobId`
3. `status`
4. `statusText`
5. `error`

Global summary show:

1. `total`
2. `processing`
3. `downloaded`
4. `failed`
5. `pending`
6. `maxParallel`

## Optional: Use Backend Queue Position

`GET /user/voterslips/mass/jobs/:jobId` now may include `job.queuePosition` when status is `queued`.

Display this for better operator visibility when backend worker slots are full.

## Recommended Rollout

1. Start with `MAX_PARALLEL_BOOTHS = 2` in production.
2. If stable for large ranges, increase to `3`.
3. Avoid jumping directly to very high concurrency.

## Expected Outcome

1. Booth-range completion time drops significantly vs strict serial flow.
2. API and DB remain responsive during printing.
3. Transient DB errors reduce due capped parallelism + backpressure.
