# Voter Slip Frontend Prompt

Enhance the existing frontend only. Do not create a separate app shell or redesign the whole system.

Build a polished voter slip experience with two actions:

1. Download one voter slip after searching a voter.
2. Mass-generate voter slips for a booth/filtered set and download one combined PDF when processing completes.

Use the backend voter-slip template already present on server:

- storage/voterslips/layout/template.png (default), or path set via VOTER_SLIP_TEMPLATE_PATH

The backend already fills this template and returns PDFs.
Backend now renders Unicode Bengali text directly using embedded Bengali-capable fonts.

---

## Product Goals

1. Make single voter slip download easy from voter search results.
2. Make mass voter slip generation reliable for large booth lists.
3. Show clear processing state for mass generation (queued -> processing -> completed/failed).
4. Keep the current UI style and layout; only add focused controls/panels.
5. Ensure admin and user workflows are both smooth and understandable.

---

## API Endpoints to Integrate

All endpoints require JWT bearer token.

### Single Slip Download

1. GET /user/voters/voterslip.pdf?id=:idOrVoterId

- Returns application/pdf as file download.
- id can be numeric DB id or voter_id.

2. GET /user/voters/:id/voterslip.pdf

- Alternate route for direct row action.

### Mass Slip Generation (Async Job)

1. POST /user/voterslips/mass/start

Request body:

{
"sessionId": "optional",
"boothNo": "recommended",
"partNumber": "optional alias of boothNo",
"assembly": "optional",
"section": "optional"
}

Response: 202 Accepted

{
"message": "Mass voter slip generation started",
"job": {
"id": "uuid",
"status": "queued",
"total": 123,
"processed": 0,
"startedAt": "ISO",
"finishedAt": null,
"error": null,
"filters": {},
"fileName": "voterslips-booth-42.pdf",
"downloadUrl": null
}
}

2. GET /user/voterslips/mass/jobs/:jobId

Response:

{
"job": {
"id": "uuid",
"status": "queued|processing|completed|failed",
"total": 123,
"processed": 87,
"startedAt": "ISO",
"finishedAt": "ISO|null",
"error": "string|null",
"filters": {},
"fileName": "...pdf",
"downloadUrl": "/user/voterslips/mass/jobs/:jobId/download" // present when completed
}
}

3. GET /user/voterslips/mass/jobs/:jobId/download

- Returns generated PDF when status is completed.
- For non-completed jobs backend returns 409.

### Layout + Calibration Endpoints (Admin Panel)

1. GET /user/voterslips/layout

- Returns active layout fields + metadata.
- Coordinates are normalized with BOTTOM-LEFT origin.

2. GET /user/voterslips/layout/template.png

- Returns the template image used by backend PDF rendering.
- Use this exact image in overlay preview.

3. POST /user/voterslips/layout/recalibrate

- Runs Gemini OCR calibration and persists updated layout.
- Admin-only endpoint.

4. POST /user/voterslips/layout/manual

- Saves manual field boxes selected by admin UI.
- Body supports: profileId, name, fields, activate (default true), setPreferred (default true).
- Manual fields can include x, y, width, height, align, maxLines, maxFontSize, minFontSize, paddingX, paddingY.

5. POST /user/voterslips/layout/manual/:profileId/apply

- Applies an existing manual profile as active layout.
- setPreferred can be passed in body (default true).

6. GET /user/voterslips/layout/manual/profiles

- Returns saved manual profiles plus calibration state.
- Admin-only endpoint.

7. PATCH /user/voterslips/layout/mode

- Persist preferred mode so UI does not ask every time.
- preferredMode must be manual|gemini|default.
- For manual mode, backend reapplies last-used manual profile automatically.

8. POST /user/voterslips/layout/reset

- Deletes custom layout and reverts to backend default layout.
- Admin-only endpoint.

### Backward-Compatible Aliases (Temporary)

Use only if the frontend still has old route wiring:

1. GET /user/voterslips/calibration (alias of /layout)
2. GET /user/voterslips/calibration/template.png (alias of /layout/template.png)
3. POST /user/voterslips/recalibrate (alias of /layout/recalibrate)
4. POST /user/voterslips/revert (alias of /layout/reset)

Migration rule:

1. Prefer canonical `/layout/*` endpoints for all new code.
2. Keep alias fallback for one release only, then remove alias usage.

---

## Required UI Enhancements

### A) Voter Search Result Row Action (Single Download)

In existing voter table/list:

1. Add button: Download Slip
2. Clicking button should call one of:
   - /user/voters/:id/voterslip.pdf
   - or /user/voters/voterslip.pdf?id=:id
3. Trigger browser file download directly.
4. Show compact loading state on that row while request starts.
5. On failure, show toast with error text and retry action.

### B) Mass Generate Panel

Add a panel/modal in existing voter list screen with fields:

1. Booth No (primary field)
2. Session (optional select if available in UI)
3. Assembly (optional)
4. Section (optional)

Actions:

1. Start Mass Generate
2. Cancel/Close (UI only, no backend cancel required)

Behavior:

1. On Start, call POST /user/voterslips/mass/start.
2. Store returned job.id in local state.
3. Immediately open a progress area/card.

### C) Progress UI (Important)

Show a dedicated status card while mass generation runs:

1. Status badge: Queued / Processing / Completed / Failed
2. Numeric progress: processed / total
3. Progress bar: percent = processed / total \* 100
4. Polling every 1.5 to 2 seconds using GET /jobs/:jobId
5. Stop polling when status is completed or failed
6. On completed:
   - show Download PDF button
   - button calls /jobs/:jobId/download
7. On failed:
   - show backend error message
   - show Restart button that re-submits previous filters

If total is 0 or missing, show indeterminate progress bar with Processing label.

### D) OCR-Based Position Calibration (Gemini) [Admin Advanced]

Add an advanced admin-only section for calibration support so text placement can be fixed quickly when template changes.

UI block name:

1. Voter Slip Position Calibration

What to show:

1. Current layout version (from loaded JSON metadata if available).
2. Read-only list of field boxes:
   - partNo
   - serialNumber
   - name
   - father
   - address
   - sex
   - age
   - pollingStation
3. Overlay preview on the template image showing each field rectangle.
4. Live sample data preview rendered into those boxes.
5. Manual calibration editor (admin only):
   - drag/resize boxes on template
   - edit per-field text-fit settings (`align`, `maxLines`, `maxFontSize`, `minFontSize`, `paddingX`, `paddingY`)
   - save profile via `POST /user/voterslips/layout/manual`
   - apply existing profile via `POST /user/voterslips/layout/manual/:profileId/apply`

Calibration action:

1. Button: Recalibrate with Gemini OCR
2. Trigger backend API `POST /user/voterslips/layout/recalibrate`.
3. Show processing state while OCR calibration runs.
4. Reload layout JSON after success and repaint overlay + preview.

Fallback + safety:

1. If calibrated file is missing or invalid, show warning and use default layout.
2. Keep a Revert to Default button in UI calling `POST /user/voterslips/layout/reset`.
3. Display last calibration timestamp and source (default/manual/gemini).
4. Default UI behavior should use `meta.calibration.preferredMode`; manual should remain selected after user saves one manual profile.

Backend endpoints to use for this block:

1. `GET /user/voterslips/layout`
2. `GET /user/voterslips/layout/template.png`
3. `POST /user/voterslips/layout/recalibrate` (admin only)
4. `POST /user/voterslips/layout/reset` (admin only)
5. `GET /user/voterslips/layout/manual/profiles` (admin only)
6. `POST /user/voterslips/layout/manual` (admin only)
7. `POST /user/voterslips/layout/manual/:profileId/apply` (admin only)
8. `PATCH /user/voterslips/layout/mode` (admin only)

If canonical route returns 404, retry once with compatibility alias path before showing error.

Expected shape from `GET /user/voterslips/layout`:

{
"layout": {
"version": "string",
"fields": {
"partNo": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left" }
}
},
"meta": {
"source": "default|manual|gemini",
"layoutFileExists": true,
"layoutPath": "storage/voter-slip-layout.json",
"templateFile": "storage/voterslips/layout/template.png",
"lastUpdated": "ISO|null",
"coordinateSystem": "normalized-bottom-left",
"permissions": {
"isAdmin": true,
"canCalibrate": true,
"canUseManualCalibration": true
},
"calibration": {
"requiredFields": ["partNo","serialNumber","name","father","address","sex","age","pollingStation"],
"endpoints": {
"saveManual": "/user/voterslips/layout/manual"
}
}
}
}

Important implementation detail for overlay:

1. Backend field coordinates use normalized BOTTOM-LEFT origin.
2. CSS absolute positioning uses TOP-LEFT origin.
3. Convert each box with:
   - left% = x \* 100
   - top% = (1 - y - height) \* 100
   - width% = width \* 100
   - height% = height \* 100
4. Never render calibration overlay using hardcoded local coordinates when API data is available.
5. If `GET /layout` fails, show warning banner and disable recalibration buttons until retry succeeds.
6. If API succeeds but returns `meta.source = default`, show non-blocking note: "Using safe default layout; recalibration did not produce valid boxes.".
7. Render manual calibration controls only when `meta.permissions.canUseManualCalibration === true`.
8. For non-admin users, never show Recalibrate/Reset/Manual save/apply buttons.

Acceptance for calibration UI:

1. Admin can visually confirm every field region before generating slips.
2. Recalibration updates positions without frontend redeploy.
3. Generated slips align with labels and box boundaries after recalibration.

---

## UX Rules

1. Keep current page layout and visual language.
2. Do not force navigation to a new page for this feature.
3. Keep actions near voter list/table where users already work.
4. Use clear, non-technical text:
   - Starting generation...
   - Generating slips for booth X...
   - Completed. Ready to download.
5. Always show booth number clearly in the mass job card.

---

## Suggested Frontend State Shape

{
"singleDownloadLoadingByVoterId": { "123": true },
"massSlip": {
"filters": {
"boothNo": "",
"sessionId": "",
"assembly": "",
"section": ""
},
"jobId": "",
"status": "idle|queued|processing|completed|failed",
"processed": 0,
"total": 0,
"error": null,
"downloadUrl": null,
"fileName": ""
}
}

---

## Polling Logic

1. Start polling only after successful POST /mass/start.
2. Poll with interval 1500 to 2000 ms.
3. If status is completed:
   - update UI to success
   - stop polling
4. If status is failed:
   - show error
   - stop polling
5. If request fails transiently:
   - retry silently up to 3 times
   - after that show warning toast and let user click Retry Status

---

## Error Handling

Handle these server responses gracefully:

1. 400 from /mass/start:
   - Show message: Please provide at least one filter (Booth No recommended).
2. 404 from /mass/start:
   - Show message: No voters found for selected filters.
3. 409 from /download:
   - Show message: Job still processing. Please wait.
4. 500:
   - Show generic toast + expandable technical detail.
5. 403 from calibration endpoints:
   - Show message: Only admin users can recalibrate or reset voter slip layout.
6. 404 from calibration endpoints:
   - Retry compatible alias endpoints once.
   - If still 404, show message: Calibration API not reachable; check backend deployment and route prefix.

---

## Acceptance Criteria

1. User can download a single voter slip directly from search results.
2. User can start mass generation by booth and see live progress.
3. Progress updates until completed/failed without page refresh.
4. Completed job shows working Download PDF action.
5. Failed job shows clear error and restart option.
6. Existing UI remains intact; only targeted feature additions are made.

---

## Implementation Notes

1. For file download requests, use blob handling if fetch does not auto-download in your stack.
2. Keep polling logic isolated in a hook/service to avoid memory leaks.
3. Clear polling interval on unmount.
4. Debounce Start button to prevent duplicate job creation.
5. Disable Start while one active job is queued/processing unless you intentionally support multiple concurrent jobs.
6. Calibration panel should call `GET /user/voterslips/layout` on mount and on every Recalibrate/Reset success.
7. Keep `layout.meta.source` and `layout.meta.lastUpdated` as the only source-of-truth in UI status labels.
8. Do not assume top-left coordinates from OCR; always use backend-converted values from `/layout`.
9. Never trust client-side OCR boxes; backend layout response is the single source of truth.
10. Keep original Bengali/non-Latin text in UI and API payloads; do not transliterate on client.
11. Keep original Bengali/non-Latin text in UI and API payloads; do not transliterate on client.
12. Mass PDF output must remain fixed at exactly 4 slips per page (2x2 grid) in backend output.
