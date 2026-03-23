# Multi Voterlist Upload Frontend Prompt

Use this in your frontend repo to add true multi-file voter list upload with one-click batch session creation.

## Mission

Allow admins to upload multiple voter list PDFs in one action, create one backend session per file, and track all runs from a batch dashboard.

## Core Requirement

When user selects N PDF files and clicks start, frontend must call one API request and receive N session results.

- Endpoint: `POST /sessions/bulk`
- Form field: `files` (multiple)
- One created session per uploaded PDF

## API Contract

### 1) Bulk create sessions

`POST /sessions/bulk` (multipart/form-data)

Fields:

- `files`: multiple PDF files
- `dispatchMode`: optional (`paid-only` | `auto` | `free-only`)

Notes:

- Send all selected PDFs under `files`
- Backend also accepts `files[]` for compatibility
- One accepted uploaded file creates one session

Success responses:

- `201`: all sessions completed
- `207`: mixed outcome (`completed`/`paused`/`failed`)

Response shape:

```json
{
  "totalFiles": 3,
  "dispatchMode": "auto",
  "workerCount": 4,
  "summary": {
    "completed": 2,
    "paused": 1,
    "failed": 0
  },
  "sessions": [
    {
      "fileName": "part-11.pdf",
      "sessionId": "uuid",
      "status": "completed",
      "pages": 56,
      "httpStatus": 201
    },
    {
      "fileName": "part-12.pdf",
      "sessionId": "uuid",
      "status": "paused",
      "processedPages": 42,
      "pages": 56,
      "httpStatus": 207,
      "message": "Session partially completed after automatic retries. Use POST /sessions/:id/resume to continue."
    },
    {
      "fileName": "part-13.pdf",
      "status": "failed",
      "httpStatus": 500,
      "error": "Processing failed",
      "details": "..."
    }
  ],
  "apiKeyStatus": {
    "activeDispatchTier": "free"
  }
}
```

### 2) Session status polling

Use existing endpoint for each created session:

- `GET /sessions/:id/status`

## UI Requirements

### A) Multi-file picker

- Accept `.pdf` only
- Enable selecting multiple files at once
- Show selected file chips/list with remove action per file
- Show total files + total size before submit

### B) Batch submit flow

- Build `FormData` with all files under key `files`
- Include optional `dispatchMode`
- Disable submit during upload
- Add cancel support via `AbortController`

### C) Batch result panel

Show one row per file with:

- file name
- session id (if created)
- status chip (`completed` | `paused` | `failed`)
- quick actions:
  - open session details
  - resume if paused
  - retry single file if failed

### D) Polling strategy (lightweight)

- Poll each active session every 2s while status is `processing`
- Stop polling when terminal: `completed` | `failed` | `paused`
- Pause polling in hidden tab; resume on visible
- Use memoized status map to reduce re-renders

### E) Dispatch mode selector

Use canonical values only:

```ts
const OCR_MODE_OPTIONS = [
  { label: "Turbo (paid-only)", value: "paid-only" },
  { label: "Balanced (auto)", value: "auto" },
  { label: "Cost Save (free-only)", value: "free-only" },
] as const;
```

## Suggested Frontend Types

```ts
type SessionRunStatus = "completed" | "paused" | "failed";

interface BulkSessionRow {
  fileName: string;
  sessionId?: string;
  status: SessionRunStatus;
  pages?: number;
  processedPages?: number;
  httpStatus: number;
  error?: string;
  details?: string;
  message?: string;
}

interface BulkSessionResponse {
  totalFiles: number;
  dispatchMode: "paid-only" | "auto" | "free-only";
  workerCount: number;
  summary: { completed: number; paused: number; failed: number };
  sessions: BulkSessionRow[];
}
```

## UX Copy

- On submit: `Creating sessions for selected voter lists...`
- On mixed result (`207`): `Batch completed with partial results. Some files need resume/retry.`
- On all success (`201`): `All voter lists processed successfully.`
- On free-only pressure: `Switch to Turbo for faster completion.`

## Guardrails

- Never expose API keys in UI logs
- Keep per-row rendering cheap and memoized
- Do not block whole page on one row failure
- Keep retry/resume per file session, not full batch restart

## QA Checklist

1. Select 5 PDFs and submit once; verify 5 session rows returned.
2. Confirm each row maps to one backend `sessionId`.
3. Confirm paused row shows Resume action.
4. Confirm failed row can retry with only that file.
5. Confirm tab hide/show pauses and resumes polling correctly.
6. Confirm request uses `files` array form-data field, not repeated single uploads.
