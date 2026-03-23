# Session Mass Voter Slip Frontend Prompt (One-Click)

Use this prompt directly in your frontend repo with Copilot.

---

You are working in the existing frontend codebase. Implement one-click mass voter slip generation from the current voter-list session page.

## Goal

On the session details screen, user should click one button and generate voter slips for that exact session.

The UI must not ask for:

1. Assembly
2. Part number / booth filter input
3. Section

All of these should be derived from backend session context automatically.

Booth number handling must be robust because booth is critical for:

1. Linking voter session to election results
2. Naming/tracking generated mass voter slip output

## Backend APIs

All endpoints require JWT bearer token.

1. `POST /user/voterslips/mass/sessions/:sessionId/start`
2. `POST /user/voterslips/mass/current-session/start` (alias, body `{ sessionId }`)
3. `GET /user/voterslips/mass/jobs/:jobId`
4. `GET /user/voterslips/mass/jobs/:jobId/download`
5. `GET /user/assemblies?sessionId=:sessionId` (use session-scoped assembly list)
6. `GET /user/assemblies/:assembly/parts?sessionId=:sessionId` (use session-scoped booth/part list)
7. `PATCH /sessions/:sessionId/metadata` (admin correction for wrong booth/assembly)

Use endpoint #1 as primary.

For any dropdowns on session page, always pass `sessionId` so only that session's cleaned assembly/booth metadata appears.

## Required UI Changes

### A) Replace Filtered Mass Panel with Session Button

In the session details page (where session id is already known), add one action button:

- Button label: `Generate Session Voter Slips PDF`

Remove/disable filter inputs for assembly/booth/section for this flow.

### A1) Canonical Booth Resolution (Required)

Always compute and store a canonical booth number in frontend state for the current session.

Priority order:

1. `session.booth_no` (or `session.boothNo`)
2. `job/session` metadata returned from mass-start response (`res.data.session.boothNo`)
3. Parse from `session.original_filename` (renamed file fallback)

Use this normalization in frontend:

1. Uppercase
2. Remove non-alphanumeric chars
3. Keep numeric part plus optional alpha suffix (`119`, `119A`)

Example parser guidance:

1. Prefer explicit tokens like `booth`, `part`, `booth no`, `part no`
2. If not found, fallback to first `1-4` digit token with optional alpha suffix

Show a warning banner if booth still cannot be resolved:

- `Booth number missing for this session. Please verify session file name or reprocess metadata.`

### A2) Session Metadata Correction UI (Required for Admin)

If booth/assembly looks wrong or missing, show `Fix Session Metadata` action for admins.

Modal fields:

1. Assembly Name
2. Booth No
3. Booth Name (optional)

On submit:

1. Call `PATCH /sessions/:sessionId/metadata`
2. Refresh session detail
3. Refresh linked election-result data
4. Refresh session-scoped assemblies/parts cache

### B) Start Job on Single Click

On button click:

1. Call `POST /user/voterslips/mass/sessions/:sessionId/start`
2. Save `job.id` from response
3. Immediately render progress panel

Also update booth state from returned session metadata if provided:

1. `res.data.session.boothNo`
2. `res.data.session.boothName`

No modal asking for assembly/part/section.

### C) Poll Job Status

Poll every 1500-2000ms using `GET /user/voterslips/mass/jobs/:jobId`.

Status behavior:

1. `queued` -> show waiting indicator
2. `processing` -> show `processed / total` progress bar
3. `completed` -> show `Download PDF` button
4. `failed` -> show error and `Retry` button (restarts with same sessionId)

Stop polling when status is `completed` or `failed`.

### D) Download Output

When completed:

1. Enable `Download PDF`
2. Call `GET /user/voterslips/mass/jobs/:jobId/download`
3. Download file as blob (preserve backend filename)
4. After download, backend may invalidate artifact; do not retry same download blindly

### E) UX/State Rules

1. Disable generate button while job is active (`queued|processing`)
2. Keep session metadata visible (session id, booth, status)
3. Show non-blocking toast for start/success/error
4. Preserve existing app design system and spacing

## Suggested State Shape

```json
{
  "sessionMassSlip": {
    "sessionId": "",
    "boothNo": "",
    "boothName": "",
    "boothSource": "session|response|filename|missing",
    "jobId": "",
    "status": "idle|queued|processing|completed|failed",
    "processed": 0,
    "total": 0,
    "error": null,
    "fileName": "",
    "downloadUrl": null,
    "isStarting": false,
    "isDownloading": false
  }
}
```

## Pseudocode

```ts
async function startSessionMassSlip(sessionId: string) {
  setState({ isStarting: true, error: null });
  const res = await api.post(
    `/user/voterslips/mass/sessions/${sessionId}/start`,
  );
  const job = res.data.job;
  const sessionMeta = res.data.session || {};
  setState({
    sessionId,
    boothNo: resolveBoothNo(currentSession, sessionMeta),
    boothName: sessionMeta.boothName || currentSession?.booth_name || "",
    boothSource: resolveBoothSource(currentSession, sessionMeta),
    jobId: job.id,
    status: job.status,
    processed: job.processed,
    total: job.total,
    fileName: job.fileName,
    downloadUrl: job.downloadUrl,
    isStarting: false,
  });
  pollJob(job.id);
}

function pollJob(jobId: string) {
  const timer = setInterval(async () => {
    const res = await api.get(`/user/voterslips/mass/jobs/${jobId}`);
    const job = res.data.job;
    setState({
      status: job.status,
      processed: job.processed,
      total: job.total,
      error: job.error,
      fileName: job.fileName,
      downloadUrl: job.downloadUrl,
    });

    if (job.status === "completed" || job.status === "failed") {
      clearInterval(timer);
    }
  }, 1800);
}
```

## Error Handling

1. `400`: show invalid request/session message
2. `404` from start: session not found or no voters in session
3. `403`: permission/access issue for job
4. `409` on download: still processing, continue polling
5. `410` on download: file already downloaded/expired, ask user to regenerate
6. `500`: generic server error with retry action

Metadata correction errors:

1. `400`: invalid booth format -> show inline field validation
2. `403`: hide correction controls for non-admin users
3. `404`: session not found -> show stale session warning

Booth-specific guard:

1. If booth is missing in current session card, still allow mass generation by session id.
2. But show warning that election-result linking may fail until booth metadata is resolved.

## Acceptance Criteria

1. Single button click starts session-scoped generation
2. No assembly/part/section input required
3. Progress updates live without page refresh
4. Completed jobs can be downloaded from UI
5. Failed jobs can be retried with same session id
6. Existing page style/layout remains intact
7. Canonical booth number is always tracked in session UI state
8. If booth is absent in payload, frontend attempts filename fallback parsing before warning
9. Session page assembly dropdown shows only cleaned session-scoped entries (not global noisy values)
10. Booth numbers (including 1..7) appear consistently in part/booth options
11. Admin can correct wrong session booth/assembly and mapping refreshes correctly
