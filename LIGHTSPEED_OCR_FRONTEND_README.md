# Lightspeed OCR Frontend README Prompt

Use this in your frontend repo to implement the fastest stable OCR UX for backend-voter-list.

## Mission

Maximize OCR throughput and minimize latency spikes.

1. Prefer paid capacity when speed is critical.
2. Avoid expensive non-essential work during OCR.
3. Keep UI loops lightweight and fail-safe.

## Product Decisions (Speed First)

1. OCR session processing is text-data first.
2. Photo extraction/upload is disabled from live OCR flow.
3. Voter photos are placeholder-only for now.
4. Detailed image pipeline can be added later behind a separate async workflow.

## Required Frontend Features

### A) Processing Mode Selector

Add mode selector near upload and resume actions:

1. `Turbo (paid-only)`
2. `Balanced (auto)`
3. `Cost Save (free-only)`

Persist the selected value in local state and include it in requests.

Important: UI label and API value must be separated. Always send canonical values only.

```ts
const OCR_MODE_OPTIONS = [
  { label: "Turbo (paid-only)", value: "paid-only" },
  { label: "Balanced (auto)", value: "auto" },
  { label: "Cost Save (free-only)", value: "free-only" },
] as const;

// PATCH /api-keys/dispatch-mode
// body: { mode: selected.value }
```

### B) API Integration Contract

1. Read mode: `GET /api-keys/dispatch-mode`
2. Update mode: `PATCH /api-keys/dispatch-mode`
3. Start session: `POST /sessions` with optional `dispatchMode`
4. Resume session: `POST /sessions/:id/resume` with optional `dispatchMode`
5. Runtime health: `GET /api-keys/dispatch-status`
6. Session status: `GET /sessions/:id/status`

### C) Placeholder Photo Rendering

Implement one photo adapter function:

```ts
function resolveVoterPhoto(url?: string | null): string {
  if (!url) return "/images/voter-placeholder.png";
  if (url.startsWith("placeholder://")) return "/images/voter-placeholder.png";
  return url;
}
```

Use this in every voter row/card and remove all client-side upload/extraction hooks from session processing pages.

### D) Polling Strategy

1. Session status every 2s while processing.
2. Dispatch status every 4s while processing.
3. Pause polling on hidden tab.
4. Resume polling on visible tab.
5. Stop polling on terminal status (`completed|failed|paused`).

### E) UX Messaging

1. `Turbo mode active: paid pool prioritized for speed.`
2. `Balanced mode active: free first, paid fallback.`
3. `Cost Save mode active: free pool only.`
4. When blocked in free-only: `Switch to Turbo for faster completion.`

## Guardrails

1. Never hardcode retry intervals in user text.
2. Never expose API keys.
3. Keep engine table collapsed by default; open on demand.
4. Keep render cycles lean: memoize status transforms.

## Suggested QA Checklist

1. Change mode and verify backend reflects it.
2. Start OCR with Turbo and confirm tier behavior updates in status panel.
3. Resume paused session with same mode.
4. Confirm voter list always renders placeholder when `photo_url` is placeholder/null.
5. Confirm no photo upload/extraction network calls happen from OCR UI flow.

## Non-Goals (for now)

1. No live Cloudinary image extraction in OCR hot path.
2. No per-voter image processing during page parsing.
3. No blocking UI work unrelated to text extraction.
