# Sessions Page Frontend Prompt: Sequential Booth Range Auto Download

Use this in the frontend repository only.

This file includes only the new change requested:

- Do not generate one big ZIP for booth range.
- Generate and download one booth PDF at a time.
- Move to next booth only after current download completes.
- Wait 15 seconds before starting the next booth.

## Why This Change

The previous high-load pattern can overload DB and memory during large range processing. We need to reduce concurrent load and avoid very large in-memory artifacts.

Observed high-load failures to prevent:

- transient DB failures (example code 08P01)
- large file/memory write failure:
  - RangeError [ERR_OUT_OF_RANGE]: The value of "length" is out of range

## New Flow (Frontend Orchestration Only)

For booth range input like 1-50:

1. Resolve booth list in range.
2. For each booth in order:
3. Find matching session for that booth.
4. Start single-booth mass PDF job.
5. Poll until completed or failed.
6. If completed, download that booth PDF immediately.
7. Wait exactly 15 seconds.
8. Continue to next booth.

Rules:

- Concurrency must be 1 (strictly sequential).
- Never start next booth before current booth is done.
- Keep process resumable after failures.

## APIs To Use

Use existing APIs only.

### Start Job For One Booth Session

- Method: POST
- URL: /user/voterslips/mass/sessions/:sessionId/start

Alternative supported (if your UI already stores current session id):

- Method: POST
- URL: /user/voterslips/mass/current-session/start
- Body: { "sessionId": "uuid" }

### Poll Job

- Method: GET
- URL: /user/voterslips/mass/jobs/:jobId

### Download Completed PDF

- Method: GET
- URL: /user/voterslips/mass/jobs/:jobId/download

Important:

- Download each booth PDF as soon as that booth job completes.
- Backend removes artifact after successful download; do not retry same download blindly.
- Expected downloaded filename format: voterslip-booth-<booth-no>.pdf

## Required Timing Control

Set frontend constant:

- NEXT_BOOTH_DELAY_MS = 15000

Behavior:

- After a booth download success: wait 15000 ms, then start next booth.
- After a booth failure: wait 15000 ms, then continue or retry based on retry policy.

## Retry Policy (Load-Safe)

Per booth:

- max 2 retries for start or polling failures
- exponential backoff for transient errors
- still keep 15s gap before next attempt

Treat as transient/load-related:

- 503 responses
- DB transient hints in message/code (for example 08P01)
- network timeout/reset

Do not retry more than configured max. Mark booth failed and continue.

## Sessions Page UX Update

### Input

- Booth Range input accepts:
  - 1-50
  - 5 to 20
  - 12

### Queue View (Per Booth)

Show one row per booth with status:

- pending
- processing
- downloaded
- failed
- skipped

For each booth row show:

- booth number
- session id (if resolved)
- job id
- attempt count
- status text
- error (if any)

### Global Progress

Show:

- total booths in range
- completed downloads count
- failed count
- current booth
- next booth ETA (15s cooldown timer)

### Control Buttons

- Start Auto Download
- Pause
- Resume
- Stop
- Retry Failed Booths

## Critical Business Rule (Still Required)

Part No displayed in generated mass slips is booth-context driven in backend mass flow.

Frontend must:

- display current booth clearly during sequential run
- avoid mixing booth identity across queue items

## Error Handling Matrix

- 400 on start: invalid input/session issue -> mark booth failed
- 404 on start: booth/session/voters not found -> mark booth skipped/failed
- 409 on download: job not completed -> continue polling
- 410 on download: already removed -> mark as downloaded-if-previously-successful else failed
- 500/503: transient retry with capped attempts

## Suggested Frontend State Shape

```ts
type BoothRunItem = {
  boothNo: string;
  sessionId: string | null;
  jobId: string | null;
  status: "pending" | "processing" | "downloaded" | "failed" | "skipped";
  attempts: number;
  error: string | null;
};

type BoothRangeAutoDownloadState = {
  rangeInput: string;
  isRunning: boolean;
  isPaused: boolean;
  currentBooth: string | null;
  cooldownMsRemaining: number;
  items: BoothRunItem[];
  totals: {
    total: number;
    downloaded: number;
    failed: number;
    skipped: number;
  };
};
```

## Acceptance Checklist

1. Range 1-50 is processed booth by booth in strict sequence.
2. Each completed booth PDF downloads immediately.
3. Next booth starts only after 15 second wait.
4. No parallel booth job starts at any time.
5. Transient failures retry with cap and do not block full run.
6. UI clearly shows per-booth status and global progress.
7. Flow reduces DB pressure versus previous bulk strategy.

## QA Scenarios

1. Run 1-5 and verify five separate booth PDFs download sequentially.
2. Confirm 15 second gap between booth completions and next booth start.
3. Simulate transient API failure and verify capped retry + continue behavior.
4. Include a booth with no session and verify skipped/failed handling without stopping run.
5. Pause/resume mid-run and verify queue state remains consistent.
