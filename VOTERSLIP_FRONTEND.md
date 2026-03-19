# Voter Slip Frontend Prompt (Copilot-Ready)

Use the prompt below directly with GitHub Copilot in your frontend repository.

---

You are working inside the existing frontend codebase. Implement voter slip features without redesigning the app shell.

## Scope

1. Single voter slip download from search/list rows.
2. Mass voter slip generation with progress and download.
3. Admin-only calibration panel with manual box editing and auto-label flow.
4. Preserve Bengali text exactly as received; no translation/transliteration on client.

## Hard Constraints

1. Keep existing visual style and page structure.
2. Add focused UI controls only where needed.
3. Do not create a separate app or route unless existing app architecture already requires it.
4. For mass output preview, do not build custom 2x2 client print composition; rely on backend PDF output.

## APIs

All endpoints require JWT bearer token.

### Single Slip

1. `GET /user/voters/voterslip.pdf?id=:idOrVoterId`
2. `GET /user/voters/:id/voterslip.pdf`

### Mass Slips

1. `POST /user/voterslips/mass/start`
2. `GET /user/voterslips/mass/jobs/:jobId`
3. `GET /user/voterslips/mass/jobs/:jobId/download`

### Calibration

1. `GET /user/voterslips/layout`
2. `GET /user/voterslips/layout/template.png`
3. `POST /user/voterslips/layout/recalibrate` (admin)
4. `POST /user/voterslips/layout/reset` (admin)
5. `GET /user/voterslips/layout/manual/profiles` (admin)
6. `POST /user/voterslips/layout/manual` (admin)
7. `POST /user/voterslips/layout/manual/:profileId/apply` (admin)
8. `PATCH /user/voterslips/layout/mode` (admin)
9. `POST /user/voterslips/layout/manual/auto-labels` (admin)

Optional temporary alias fallback for one retry on `404`:

1. `GET /user/voterslips/calibration`
2. `GET /user/voterslips/calibration/template.png`
3. `POST /user/voterslips/recalibrate`
4. `POST /user/voterslips/revert`

## Required UI Work

### A) Single Download in Row

1. Add `Download Slip` button in voter row.
2. Call one of the single-slip endpoints.
3. Download as PDF via blob/object URL where required.
4. Show row-level loading and failure toast.

### B) Mass Generation Panel

Inputs:

1. Booth No (primary)
2. Session (optional)
3. Assembly (optional)
4. Section (optional)

Behavior:

1. Start job via `POST /mass/start`.
2. Poll status every 1500-2000 ms via `GET /mass/jobs/:jobId`.
3. Stop polling on `completed` or `failed`.
4. On completed, show `Download PDF` button.
5. On failed, show error + `Restart` action with same filters.

### C) Calibration Panel (Admin Advanced)

Panel name: `Voter Slip Position Calibration`

Read-only for all users:

1. Current layout version/source/last updated.
2. Overlay field boxes from backend layout.
3. Template preview from `/layout/template.png`.

Admin-only controls:

1. `Recalibrate with Gemini OCR` button.
2. `Revert to Default` button.
3. Manual edit mode toggle.
4. In edit mode: add/drag/resize/delete boxes.
5. Auto-label selected boxes via `/layout/manual/auto-labels`.
6. Show editable mapping table: field, box index, source, score.
7. Enforce one box per required field.
8. Edit text-fit settings per field:
   - align
   - maxLines
   - maxFontSize
   - minFontSize
   - paddingX
   - paddingY
9. Save manual profile via `/layout/manual` (with `fields` or raw `boxes`).
10. Load/apply profile via `/layout/manual/profiles` and `/layout/manual/:profileId/apply`.
11. Persist preferred mode via `/layout/mode` using `manual|gemini|default`.

### D) Popup Box Editor (Required)

Create a dedicated popup/modal for manual calibration editing so sizes are easy to understand.

Popup requirements:

1. Open from calibration panel with button text: `Open Box Editor`.
2. Use large modal layout (at least ~85vw x 85vh on desktop) with scroll safety on small screens.
3. Show template preview prominently in center.
4. Left side: field list and selected field controls.
5. Right side: live measurement panel for selected box.

Box and label behavior (must follow):

1. Label text must be rendered above each box, outside the box.
2. Label must never overlap the editable text area.
3. Box must cover only the text input area (not full row/line decorations).
4. Provide resize handles on all corners.
5. Provide keyboard nudging for precision:

- arrow keys: move 1px
- shift + arrow: move 5px
- alt + arrow: resize 1px

6. Show real-time dimensions for selected box:

- px: x, y, width, height
- normalized: x, y, width, height

7. Add `Snap to OCR/guide` toggle for easier alignment (optional enhancement, default off).
8. Add `Reset Selected Box` and `Reset All Unsaved` actions.

Sizing assist:

1. Add zoom controls in popup: `50%`, `75%`, `100%`, `125%`, `150%`, `Fit`.
2. Add optional fine grid overlay and ruler marks.
3. Keep selected box highlighted with stronger border.
4. Show minimum recommended height/width warning if box is too small for field text.

Save flow from popup:

1. `Auto Label Boxes` -> call `/layout/manual/auto-labels`.
2. Allow mapping corrections in popup before save.
3. `Save Profile` -> call `/layout/manual`.
4. Close popup only after successful save or explicit discard confirmation.

Admin gate rule:

1. Render manual controls only when `meta.permissions.canUseManualCalibration === true`.

## Coordinate Conversion (Must Follow)

Backend layout uses normalized bottom-left; CSS overlay uses top-left.

1. `left% = x * 100`
2. `top% = (1 - y - height) * 100`
3. `width% = width * 100`
4. `height% = height * 100`

Never use hardcoded box coordinates if API layout exists.

## Bengali Text Rule

1. Keep original Bengali/non-Latin text unchanged in UI and payloads.
2. Do not auto-translate or transliterate values.

## Error Handling

1. `400` on mass start: show filter validation message.
2. `404` on mass start: show no-voters message.
3. `409` on mass download: show still-processing message.
4. `403` on calibration actions: show admin-only message.
5. `500`: show generic failure toast with retry.
6. For calibration route `404`, retry alias once then show actionable error.

## Suggested State Shape

```json
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
```

## Acceptance Criteria

1. User can download one voter slip from search results.
2. User can run mass generation and see live progress without page refresh.
3. Completed mass job downloads correct backend PDF.
4. Admin can perform full manual calibration flow with auto-label + save/apply profile.
5. Non-admin users never see manual calibration actions.
6. Bengali text remains unchanged end-to-end.
7. Popup editor is available for admins and makes box sizing understandable with live metrics.
8. Every label is above its box and never drawn inside the editable text area.
9. Box boundaries tightly match text-only regions for each field.
10. Mass PDF view in frontend must rely on backend output format and must not force a client-side 2x2 composition.
