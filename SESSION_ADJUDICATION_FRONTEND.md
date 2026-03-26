# Session Voter Adjudication Column Frontend Prompt

Use this in the frontend repo to implement a new voter-level adjudication column with OCR auto-fill for new uploads and manual checkbox editing fallback for existing records.

## Mission

Add a visible and editable "Under Adjudication" status for each voter row.

- Show a dedicated column in the voter table.
- Persist a boolean value per voter.
- Auto-detect value from OCR for newly uploaded data.
- Allow manual checkbox control in edit mode, especially for previous sessions where OCR data does not exist.

## Scope

Implement on the session voter list / voter table UI, edit mode UI, and save/update flow.

## Requirements

### 1) New Column: Under Adjudication

Add a new table column for every voter row:

- Header: `Under Adjudication`
- Display value in view mode:
  - `Yes` if voter is under adjudication
  - `No` otherwise
- Sort behavior (optional if table supports sorting): `Yes` rows first when sorting desc.

Data model in frontend state should include:

```ts
type VoterRow = {
  id: string;
  // existing fields...
  underAdjudication: boolean;
  adjudicationSource?: "ocr" | "manual" | "default";
};
```

### 2) Edit Mode Behavior (Manual Checkbox)

When row/table is in edit mode:

- Replace display text with a single checkbox input in this column.
- Checkbox label can be hidden if table already has clear column header.
- Checkbox checked means voter is under adjudication.
- On save, persist boolean to backend payload.
- On cancel, revert to last saved value.

View mode after save:

- Show `Yes` when checked.
- Show `No` when unchecked.

### 3) OCR Auto-fill for New Uploads

For newly uploaded voter-slip/session data:

- Use OCR output to detect adjudication markers (for example text patterns like `ADJUDICATION`).
- If detected, set `underAdjudication = true` and `adjudicationSource = "ocr"`.
- If not detected, set `underAdjudication = false` and `adjudicationSource = "ocr"` (or `default`, based on backend response contract).

Important:

- OCR auto-fill should run only for new uploads / newly parsed records.
- OCR confidence threshold and parsing logic should be backend-driven when possible.
- Frontend should trust backend field if already computed; do not duplicate heavy OCR logic in browser unless required.

### 4) Previous Sessions Fallback (Manual Required)

For records from previous sessions that do not contain adjudication value:

- Default to `No` in view mode.
- Allow user to enter edit mode and toggle checkbox manually.
- Save manual override normally.
- Mark source as `manual` after user save.

### 5) Payload + API Contract (Frontend Expectations)

Create/update request payload should include:

```ts
type VoterAdjudicationUpdate = {
  voterId: string;
  underAdjudication: boolean;
};
```

Session/voter fetch response should include `underAdjudication` boolean (and optionally source).

If backend returns null/undefined for old records:

- Normalize in frontend to `false` for rendering.
- Keep edit option available.

### 6) Visual Treatment

In view mode, make status easy to scan:

- `Yes`: emphasized badge/chip or strong text style.
- `No`: neutral style.

Do not add disruptive colors; keep consistent with current design system.

### 7) Validation + UX Safety

- No blocking validation needed beyond boolean handling.
- Save button should include adjudication changes together with other row edits.
- Show standard success/error toast on save.
- Prevent accidental data loss by warning on unsaved edits if user navigates away.

## Acceptance Checklist

1. Every voter row has an `Under Adjudication` column.
2. View mode always shows `Yes` or `No`.
3. Edit mode shows a checkbox for that column.
4. Checkbox changes are persisted on save and reverted on cancel.
5. New uploads are auto-populated from OCR result.
6. Previous sessions can be updated manually via checkbox.
7. Old/null values do not crash UI and render as `No` by default.

## QA Scenarios

1. New upload containing adjudication watermark/text is auto-marked `Yes`.
2. New upload without adjudication marker is auto-marked `No`.
3. Old session row without field shows `No`, can be edited to `Yes`, and persists after refresh.
4. Toggle checkbox `Yes -> No` and verify saved value after reload.
5. Cancel in edit mode reverts checkbox to last saved state.
6. Bulk table rendering still performs smoothly with the new column.

## Non-Goals

- Building OCR engine in frontend.
- Redesigning unrelated session/voter pages.
- Changing unrelated voter fields or workflow.

## Notes For Backend Coordination

Frontend assumes backend/parser layer will expose OCR-derived adjudication data for new uploads. If backend does not yet provide this field, frontend should still ship manual checkbox support and render `No` by default until OCR field is available.
