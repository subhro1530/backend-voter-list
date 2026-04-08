# Affidavit Frontend Final Fix Script (Current Backend Aligned)

Implement and maintain affidavit frontend behavior so preview and export are contract-accurate with the current backend and remain patch-ready for future backend deltas.

## Mission

Deliver a stable manual-entry experience where:

- User input is never dropped.
- Preview is the actual backend-generated DOCX rendering.
- Export content matches preview content.
- Validation and persistence diagnostics are visible to users.
- No debug/summary overlays are injected by frontend into document pages.

## Locked Backend Contract (Current)

Use the following endpoints exactly:

1. `POST /affidavits/manual-entry`

- Saves/upserts session.
- Response includes `sessionId`, `exportUrl`, and `dbAudit`.
- `dbAudit` must be consumed in frontend and surfaced when missing fields are reported.

2. `POST /affidavits/manual-entry/preview/docx`

- Live payload preview.
- Accepts raw payload, `{ formData: { ... } }`, or `{ data: { ... } }`.
- Accepts dotted keys (example: `governmentAccommodation.address`).

3. `POST /affidavits/preview/docx`

- Alias endpoint for live preview.
- Same behavior as `manual-entry/preview/docx`.

4. `GET /affidavits/manual-entry/preview/docx?sessionId=<id>`

- Session-based GET fallback preview.

5. `GET /affidavits/sessions/:id/preview/docx`

- Session preview DOCX (`inline`).
- Includes validation headers:
  - `X-Affidavit-Validation`
  - `X-Affidavit-Missing-Required` (when invalid)

6. `GET /affidavits/sessions/:id/export/docx`

- Session export DOCX (`attachment`).
- Includes validation headers above.

7. `GET /affidavits/sessions/:id/validation`

- Returns `{ valid, missingRequired, totalFieldEntries, details, templateAudit }`.
- Optional template check via `?includeTemplateAudit=true`.

## Mandatory Data Rules

1. Never strip unknown keys from payload.
2. Preserve nested object shape and dotted field names exactly.
3. Do not auto-trim user values before sending to backend.
4. Preserve data types where possible (boolean/array/object/string).
5. On each debounced preview refresh, send the latest in-memory form state.
6. Missing required fields must show warnings, but preview must still run.

## Mandatory UI Rules

1. Render only backend DOCX pages in preview pane.
2. Do not render synthetic top summary blocks, callouts, or hint overlays.
3. Show stale-preview state whenever form changed after last successful preview render.
4. Show status line with:

- `Pages: N`
- `Current: P`
- `Last refreshed: <time>`
- `Validation: Valid | Needs attention`

5. Show DB persistence status from `dbAudit` after save.

## Required Patch Workflow (Run End-to-End)

1. Audit all affidavit frontend modules involved in:

- manual form state
- payload shaping
- save calls
- preview calls
- export calls
- validation UI

2. Patch all contract mismatches, not only one screen.
3. Keep changes minimal and scoped, but complete.
4. Re-test after each patch batch.
5. If new mismatch appears, continue patching until all checks pass.

## Implementation Checklist

1. API Layer

- Add/confirm methods for all endpoints above.
- Ensure preview endpoints request binary DOCX (`blob`/`arrayBuffer`).
- Capture validation headers from preview/export responses.

2. Save Flow

- Save via `POST /affidavits/manual-entry`.
- Persist `sessionId` in state.
- Display `dbAudit` summary:
  - expected persisted count
  - saved count
  - missing fields list (if any)

3. Preview Flow

- For unsaved or live edits: use `POST /affidavits/manual-entry/preview/docx` (or alias).
- For saved sessions: use `GET /affidavits/sessions/:id/preview/docx`.
- Debounce refresh (300-500ms).
- Cancel stale preview requests when newer edits occur.

4. Export Flow

- Use `GET /affidavits/sessions/:id/export/docx`.
- If no session exists yet, force save first.

5. Validation Flow

- Trigger `GET /affidavits/sessions/:id/validation` after save and before export.
- Optionally trigger `includeTemplateAudit=true` for strict QA mode.
- Present `missingRequired` and key `details` clearly.

6. Error Handling

- For non-200 API responses, show exact backend error message.
- For renderer failure, show fallback plus `Download Preview DOCX` action.
- Keep retry action visible and usable.

## Layout Requirements

Desktop:

- Left panel: form
- Right panel: DOCX page preview

Mobile:

- Tabs: `Form` and `Document Preview`
- Keep page tracking in preview tab.

## QA Runbook (Must Pass)

1. Enter candidate name, parent/spouse name, age, address, serial/part, verification details.
2. Save and confirm `dbAudit` shows expected persisted fields and no unexpected drops.
3. Preview and verify populated values appear in document pages.
4. Export and confirm content-equivalence with preview.
5. Confirm no top debug summary/callout artifacts appear.
6. Confirm validation warnings display correctly when required fields are missing.
7. Confirm dotted/nested keys survive round-trip save -> preview -> export.

## Definition of Done

Frontend fix is final only when all items below are true:

1. API contract fully aligned with current backend.
2. Preview/export parity verified.
3. Persistence diagnostics (`dbAudit`) visible.
4. Validation diagnostics visible and non-blocking for preview.
5. No synthetic preview overlays.
6. Mobile and desktop both functional.

## Ongoing Patch Policy

When backend affidavit contract changes again:

1. Re-audit endpoint shapes and headers.
2. Patch frontend API layer first.
3. Patch payload and UI flows next.
4. Re-run full QA runbook.
5. Keep patching until all done criteria pass.
