# Nomination Frontend Final Fix Script (Current Backend Aligned)

Implement and maintain nomination slip/paper frontend behavior so save, preview-equivalent flow, and export stay aligned with the current backend and remain patch-ready for future backend upgrades.

## Mission

Deliver a stable nomination making workflow where:

- User input is never dropped.
- Candidate photo/signature upload is reliable.
- Session create/update is deterministic.
- Exported DOCX is always generated from latest saved state.
- Frontend is ready to adopt true preview/validation endpoints when they are added.

## Locked Backend Contract (Current)

Use these endpoints exactly:

1. `POST /nominations/manual-entry`

- Creates or updates nomination session.
- Update mode requires `sessionId` in payload.
- Response includes:
  - `sessionId`
  - `status`
  - `message`
  - `exportUrl`

2. `POST /nominations/upload-image`

- Multipart form-data with file field `image`.
- Body field `type`: `photo` or `signature`.
- Response includes `url`, `publicId`, `type`.

3. `GET /nominations/sessions`

- Returns nomination session list.

4. `GET /nominations/sessions/:id`

- Returns `session` and `formData`.

5. `PATCH /nominations/sessions/:id/rename`

- Body: `{ name }`.

6. `DELETE /nominations/sessions/:id`

- Deletes one session.

7. `GET /nominations/sessions/:id/export/docx`

- Returns DOCX attachment.

8. `GET /nominations/search`

- Query filters: `candidate`, `party`, `constituency`, `state`.

9. `GET /nominations/form-schema`

- Returns dynamic schema for frontend rendering.

## Important Current Backend Gaps (Must Handle in Frontend)

1. No dedicated live preview endpoint for unsaved payload.
2. No dedicated validation endpoint.
3. No `dbAudit` in save response.

Frontend must support current behavior now and be patch-ready for future parity upgrades.

## Mandatory Data Rules

1. Never strip unknown keys from nomination payload.
2. Preserve object/array/string/boolean types.
3. Do not auto-trim user values before submit.
4. Always persist and reuse `sessionId` after first save.
5. Keep top-level summary fields populated for session metadata:
   - `candidateName`
   - `fatherMotherHusbandName`
   - `postalAddress`
   - `party`
   - `constituency`
   - `state`
6. Also keep section fields populated (`partI_*`, `partII_*`, `partIII*`, `partIV*`, `partV*`, `partVI*`).
7. Keep `proposers` as array and cap to 10 rows.

## Preview-Equivalent Strategy (Current Backend)

Because there is no dedicated preview endpoint today:

1. Save latest payload via `POST /nominations/manual-entry`.
2. Use returned `sessionId`.
3. Fetch DOCX blob from `GET /nominations/sessions/:id/export/docx`.
4. Render DOCX pages in preview panel from this blob.

This is the required preview-equivalent flow until backend preview routes exist.

## Mandatory UI Rules

1. Render actual DOCX pages from export blob in preview panel.
2. Do not inject synthetic top summary or helper overlays inside document page canvas.
3. Show stale-preview badge when form changes after last save/export fetch.
4. Show status row with:
   - `Pages: N`
   - `Current: P`
   - `Last saved: <time>`
   - `Last rendered from session: <sessionId>`
5. Keep explicit action buttons:
   - `Save Nomination`
   - `Refresh Preview`
   - `Download DOCX`

## Required Checks Before and After Patches

1. Contract checks

- Save returns `sessionId` and `exportUrl`.
- Image upload returns `url` for both `photo` and `signature` types.
- Session detail returns persisted `formData`.
- Export returns DOCX binary.

2. Data checks

- Top-level summary fields are not blank when section fields are filled.
- `proposers` rows are preserved in order and count.
- Date/time text fields round-trip unchanged.

3. UX checks

- Preview-equivalent flow runs from latest saved payload.
- Stale state appears after edits and clears after re-save/re-render.
- Error messages show exact backend message on failure.

## Required Patch Workflow (Run End-to-End)

1. Audit all nomination frontend modules for:

- form state
- payload shaping
- image upload
- save calls
- export/preview rendering
- session fetch/edit flows

2. Patch all mismatches, not one screen only.
3. Re-test after each patch batch.
4. Continue patching until all checks pass.

## Implementation Checklist

1. API Layer

- Create typed API helpers for all endpoints above.
- Ensure DOCX request uses binary mode (`blob` or `arrayBuffer`).
- Normalize multipart upload handling for `upload-image`.

2. Save Flow

- On first save, create session and store `sessionId`.
- On later saves, include `sessionId` for update behavior.
- Keep top-level summary fields synced from UI state.

3. Image Flow

- Upload photo and signature separately.
- Store returned URLs in form state as:
  - `candidatePhotoUrl`
  - `candidateSignatureUrl`
- Reuse URLs on update save.

4. Preview/Render Flow

- Implement save then export render chain.
- Debounce refresh trigger (300-500ms).
- Cancel stale requests when newer edits occur.

5. Session Management

- Support session listing, search, open, rename, delete.
- When opening existing session, hydrate full form from `formData`.

6. Error Handling

- Show exact backend error for save/upload/export failures.
- Keep retry action visible.
- If renderer fails, provide fallback `Download DOCX` action.

## Layout Requirements

Desktop:

- Left panel: nomination form
- Right panel: DOCX page preview

Mobile:

- Tabs: `Form` and `Document Preview`
- Keep page tracking and refresh actions in preview tab.

## QA Runbook (Must Pass)

1. Create a fresh nomination with Part I fields and save.
2. Confirm returned `sessionId` is reused for update saves.
3. Fill Part II proposers and verify all rows persist after reopen.
4. Upload photo/signature and confirm URLs persist and render in export.
5. Export DOCX and verify key fields are present.
6. Edit one field, confirm stale badge appears, then save and refresh preview to clear it.
7. Search by candidate/constituency and confirm session discovery.

## Definition of Done

Nomination frontend fix is final only when all are true:

1. All nomination endpoints are integrated correctly.
2. Save-update cycle is deterministic via `sessionId`.
3. Exported DOCX reflects latest saved data.
4. Preview-equivalent render is stable and user-visible.
5. Image upload flow is reliable.
6. Session open/edit/rename/delete/search flows work.

## Future Parity Patch Policy (When Required)

When backend adds dedicated nomination preview and validation routes, patch frontend immediately in this order:

1. Switch preview source from export endpoint to dedicated preview endpoint.
2. Add validation panel if backend provides validation response.
3. Add persistence diagnostics panel if backend adds `dbAudit` or equivalent.
4. Keep export as final output path.
5. Re-run full QA runbook after migration.

## Suggested Future Backend Parity Targets

If backend work is requested, add nomination equivalents of:

1. `POST /nominations/manual-entry/preview/docx`
2. `GET /nominations/sessions/:id/preview/docx`
3. `GET /nominations/sessions/:id/validation`
4. Save response diagnostics for persisted field completeness

Frontend should be designed now so these additions are low-friction to adopt.
