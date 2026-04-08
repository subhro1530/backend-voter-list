# Affidavit Frontend Prompt (Full DOCX Page Preview, No OCR)

Implement the Affidavit Manual Entry UI so users preview the real generated Word document page-by-page before export. Do not use OCR flow for this feature.

## Primary Requirement

Replace column-style placement preview with full document preview:

- Show the actual filled `AFFIDAVIT FORMAT WORD.docx`
- Render page by page (Word-like pages), not table/column summaries
- Keep preview synced with current form state

## Backend Endpoints To Use

Use these APIs:

1. `POST /affidavits/manual-entry/preview/docx`

- Input: same payload as manual-entry form
- Output: generated DOCX binary (inline)
- Also accepted payload wrappers:
  - `{ formData: { ...allFields } }`
  - `{ data: { ...allFields } }`
- Dotted field names (for example `governmentAccommodation.address`) are accepted.

1A. `POST /affidavits/preview/docx`

- Generic alias of manual preview endpoint (useful when integrating quickly)
- Same payload behavior as above

2. `GET /affidavits/sessions/:id/preview/docx`

- Output: generated DOCX binary for saved session

2A. `GET /affidavits/manual-entry/preview/docx?sessionId=<id>`

- Session-based GET fallback if frontend cannot POST preview payload

3. Existing export endpoint remains:

- `GET /affidavits/sessions/:id/export/docx`

## Preview Renderer (Mandatory)

Use a DOCX renderer that supports page layout in browser (example: `docx-preview` / `docxjs`).

- Load DOCX blob from preview endpoint
- Render into a scroll container with visible page boundaries
- Preserve document flow, spacing, tables, headings, and inserted callouts
- Re-render on field edits with debounce (300-500ms)
- For authenticated requests:
  - If using cookies: `credentials: "include"`
  - If using token auth: include `Authorization: Bearer <token>`
- On non-200 response, surface API error message in toast/body.

## UX Requirements

1. Keep "Export Completeness" panel.
2. Add buttons:

- "Preview Document"
- "Refresh Preview"
- "Open Export DOCX"

3. In preview mode, show:

- Total pages
- Current page indicator while scrolling
- Last refreshed timestamp

4. Show warning badge if preview is stale after user edits.

## Layout Requirements

- Desktop: split view
  - Left: form sections
  - Right: full page-by-page DOCX preview
- Mobile:
  - Toggle tabs: "Form" and "Document Preview"
  - Preview must remain page-based

## Visual Direction

- Premium legal-tech style, clean and professional.
- Typography pairing: serif headings + readable sans body.
- Avoid generic dashboard look.
- Strong contrast for readability.
- Subtle motion only for panel/preview transitions.

## Data Integrity Rules

1. Any value typed in any input must be sent to preview API payload.
2. Do not drop unknown schema keys.
3. Preserve nested paths like `governmentAccommodation.*`.
4. Show clear fallback note if preview rendering library fails, with direct DOCX download option.
5. If preview API returns error, do not silently fail; show exact reason and preserve retry action.

## Validation and Behavior

- Keep strict validation for dynamic rows/tables.
- Missing high-impact fields should not block preview, but should show warnings.
- Preview should still generate using partial data.

## QA Checklist

1. Fill a few fields and confirm they appear in full DOCX preview pages.
2. Fill all major sections and confirm page count increases naturally when content grows.
3. Confirm tables render as document tables, not flattened rows.
4. Confirm preview and final exported DOCX match.
5. Confirm no OCR call is required for preview flow.

## Deliverables

- Full page-by-page DOCX preview UI
- Wired preview API integration for manual-entry and saved sessions
- Debounced live refresh
- Export consistency checks
- No regressions in existing affidavit admin workflow
