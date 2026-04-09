# Nomination Frontend Fix Prompt (Backend Parity v2)

Use this prompt in the frontend repository. Do not change affidavit pages/components. Fix nomination only.

## Objective

Make the nomination manual-entry experience feel and behave like affidavit:

1. same page rhythm and clarity
2. reliable live document preview
3. deterministic save/update using sessionId
4. correct DOCX download from latest saved data
5. visible validation + persistence status

## Important Scope Rule

- Touch only nomination frontend modules.
- Do not modify affidavit code paths.

## Backend Contract (Now Available)

Base path: `/nominations`

1. `POST /manual-entry`

- Create or update nomination session.
- Accept payload in flat or nested shape.
- Update mode when `sessionId` is present.
- Response includes:
  - `sessionId`
  - `status`
  - `message`
  - `exportUrl`
  - `previewUrl`
  - `validationUrl`
  - `dbAudit`

2. `POST /manual-entry/preview/docx`

- Live preview DOCX from current unsaved payload.
- Returns DOCX binary inline.
- Headers include:
  - `X-Nomination-Validation`
  - `X-Nomination-Missing-Required` (when invalid)
  - `X-Nomination-Template-Audit`
  - `X-Nomination-Template-Missing` (when audit fails)
  - `X-Nomination-Page-Count`

3. `GET /manual-entry/preview/docx?sessionId=<id>`

- Preview DOCX from saved session.

4. `GET /sessions/:id/preview/docx`

- Preview DOCX from saved session.

5. `GET /sessions/:id/export/docx`

- Download DOCX attachment.
- Optional strict guard:
  - `?strictTemplateAudit=true`
  - Returns 422 JSON when values fail template-placement audit.

6. `GET /sessions/:id/validation?includeTemplateAudit=true`

- Returns:
  - required-field validity
  - missing required labels
  - details list
  - `previewState` (pages and timestamps)
  - `validationSnapshot` (latest saved snapshot)
  - optional `templateAudit`

7. `GET /sessions/:id/preview/metadata?includeTemplateAudit=true`

- Lightweight metadata endpoint for preview panel status.

8. `POST /upload-image`

- multipart/form-data
- file field: `image`
- body field `type`: `photo` or `signature`
- returns `url`

9. `GET /sessions`
10. `GET /sessions/:id`
11. `PATCH /sessions/:id/rename`
12. `DELETE /sessions/:id`
13. `GET /search`
14. `GET /form-schema`

## UX Requirements

1. Visual feeling must match affidavit page style:

- left section list + form body
- right document preview card
- bottom action bar
- same information density and spacing rhythm

2. Preview behavior:

- show live preview from unsaved payload via `POST /manual-entry/preview/docx`
- no requirement to save before preview
- if live preview fails, show actionable error and fallback to session preview if sessionId exists

3. Stale-state behavior:

- when form changes after latest render, set stale badge
- clear stale badge after successful preview refresh

4. Status row must include:

- `Pages`
- `Current`
- `Last saved`
- `Last rendered from session`
- `Validation`
- `Template audit`

5. Buttons:

- `Preview Document`
- `Save Nomination`
- `Refresh Preview`
- `Download DOCX`

## Data Handling Rules

1. Never drop unknown payload keys.
2. Keep types intact (string/object/array/boolean).
3. Preserve `sessionId` after first save.
4. Keep summary fields synced:

- `candidateName`
- `fatherMotherHusbandName`
- `postalAddress`
- `party`
- `constituency`
- `state`

5. Keep section fields (`partI_*` to `partVI_*`) in state.
6. Keep `proposers` as ordered array, max 10 rows.
7. Persist and reuse image URLs:

- `candidatePhotoUrl`
- `candidateSignatureUrl`

## Frontend Technical Requirements

1. API layer:

- add typed helpers for all endpoints listed above
- binary handling for DOCX: blob/arrayBuffer
- parse diagnostic headers from preview/export responses

2. Save flow:

- first save: create session
- subsequent saves: include `sessionId`
- after save, refresh metadata panel using validation/metadata endpoint

3. Preview flow:

- primary: live payload preview endpoint
- secondary: session preview endpoint
- support cancellation/debouncing to avoid out-of-order render bugs

4. Validation panel:

- consume `GET /sessions/:id/validation`
- show required missing labels and template-audit warnings

5. Session management:

- list, search, open, rename, delete
- rehydrate full form from `formData`

## QA Checklist

1. New nomination:

- fill Part I fields
- preview renders without saving
- save returns `sessionId`

2. Update nomination:

- modify fields
- preview updates
- save reuses same `sessionId`

3. Proposers:

- fill multiple proposer rows
- save, reopen, verify order and values preserved

4. Images:

- upload photo + signature
- save
- preview/export reflect images

5. Validation:

- intentionally leave required fields blank
- check missing-required state from headers and validation endpoint

6. Template audit:

- run validation endpoint with `includeTemplateAudit=true`
- surface unresolved fields clearly in UI

7. Export:

- download docx
- verify key values are present

## Delivery

Provide:

1. changed nomination frontend files list
2. API integration summary
3. preview/validation behavior summary
4. known residual risks (if any)
