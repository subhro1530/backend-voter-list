# Session Additional Voters Upload Frontend Prompt

Use this in the frontend repository only.

This feature is now available in backend-voter-list and appends new voters into an existing session from either:

- an additional PDF (typically 1-2 pages)
- a pasted/uploaded screenshot image (PNG/JPG/JPEG)

using Gemini OCR.

## Goal

Inside each voter-list session, provide an Upload Additional Voters action that:

- uploads a PDF or image to that specific session
- runs OCR and extracts voter rows
- inserts only new voters into that session
- skips duplicates by SL No
- keeps existing voters untouched

## Core Rules

1. Append only:

- Never delete or overwrite existing session voters.

2. Unique key:

- SL No is treated as unique key for this append flow.
- Existing SL No in session -> skip.
- Duplicate SL No inside same upload -> skip after first one.

3. Session isolation:

- Upload must affect only selected session id.

4. Add to end:

- New rows are inserted as additional rows/pages after current data.

## Backend Routes To Use

1. Start additional upload:

- Method: POST
- URL: /sessions/:id/voters/additional/upload
- Auth: Admin-authenticated (same auth as other /sessions admin routes)
- Content-Type: multipart/form-data
- Body fields:
  - file (required, PDF or image)
  - apiKey or geminiApiKey (optional)
  - dispatchMode (optional)

Supported file types for `file`:

- application/pdf
- image/png
- image/jpeg
- image/jpg

2. Refresh voters after upload:

- Method: GET
- URL: /sessions/:id/voters
- Optional query: pagination/filter params as used by existing voter list UI

3. Optional session detail refresh:

- Method: GET
- URL: /sessions/:id

## Response Contract (Implemented)

Success can be full or partial:

- HTTP 200: completed
- HTTP 207: partial

Response shape:

```json
{
  "message": "Additional voters processed",
  "sessionId": "uuid",
  "status": "completed",
  "originalFilename": "new-voters.pdf",
  "summary": {
    "pagesProcessed": 2,
    "extractedCount": 38,
    "insertedCount": 31,
    "skippedExistingCount": 6,
    "skippedDuplicateInUploadCount": 1,
    "skippedInvalidCount": 0
  },
  "insertedVoters": [
    {
      "id": 12345,
      "session_id": "uuid",
      "page_number": 24,
      "serial_number": "512",
      "voter_id": "ABC1234567",
      "name": "..."
    }
  ],
  "skippedSerialNumbers": ["401", "402", "(missing)"],
  "skipped": {
    "existing": ["401"],
    "duplicateInUpload": ["402"],
    "invalid": ["(missing)"]
  },
  "keySwitchCount": 0,
  "automaticRetryRounds": 0,
  "errorPages": 0,
  "dispatchMode": "auto",
  "apiKeyStatus": {
    "activeDispatchTier": "free"
  }
}
```

## Error Handling Contract

- 400: invalid file type or invalid dispatchMode
- 404: session not found
- 409: session currently processing another job
- 413: file too large (multer limit)
- 429: key/rate-limit related (from OCR stack)
- 500: processing failure

## Required UI Tasks

1. Add Upload Additional Voters action in session list row actions.
2. Add same action in session detail header.
3. Build modal with:

- File input (single) with `accept=".pdf,image/png,image/jpeg"`
- Paste screenshot support (Ctrl+V / Cmd+V) inside modal
- Optional apiKey input
- Optional dispatchMode selector
- Upload and Append button
- Cancel button

Clipboard behavior:

- Listen for paste events in modal when open.
- If clipboard contains image, convert to `File` object (for example `pasted-voter-page.png`).
- Set that file as current upload source and show small preview + file badge.
- If clipboard does not contain image, show non-blocking help text.

4. On submit, call POST /sessions/:id/voters/additional/upload.
5. Show in-modal progress state while uploading.
6. On success (200 or 207):

- Show inserted/skipped counts from summary
- Show skipped serial lists (collapsed by default)
- Refresh session voters with GET /sessions/:id/voters

7. On error:

- Show toast and inline error text
- Keep existing voter table state intact

8. Prevent duplicate submit while request is in progress.

## Frontend State Suggestion

```ts
type AdditionalVotersUploadState = {
  isOpen: boolean;
  isUploading: boolean;
  sessionId: string | null;
  file: File | null;
  sourceType: "pdf" | "image" | null;
  pastedPreviewUrl: string | null;
  apiKey: string;
  dispatchMode: "auto" | "free-only" | "paid-only" | "";
  error: string | null;
  result: {
    status: "completed" | "partial";
    summary: {
      pagesProcessed: number;
      extractedCount: number;
      insertedCount: number;
      skippedExistingCount: number;
      skippedDuplicateInUploadCount: number;
      skippedInvalidCount: number;
    };
    skipped: {
      existing: string[];
      duplicateInUpload: string[];
      invalid: string[];
    };
  } | null;
};
```

## UX Copy

Show this helper text in modal:

- Existing voters will not be modified.
- Duplicate SL No entries are skipped automatically.
- You can upload PDF or paste screenshot image.
- Recommended upload size: 1-2 voter pages.

## Acceptance Checklist

1. Upload action is available inside each session context.
2. Upload always targets selected session id.
3. Existing voters remain unchanged.
4. Newly added voters appear in same session after refresh.
5. Existing/duplicate SL No values are skipped.
6. Success state shows summary counts from backend.
7. Error state does not wipe current table rows.

## QA Scenarios

1. Upload file with only new SL No values -> all inserted.
2. Upload file with some existing SL No -> existing skipped, rest inserted.
3. Upload file with repeated SL No in same file -> duplicates skipped.
4. Paste screenshot image from clipboard -> processed successfully.
5. Upload while session is processing -> 409 handling shown.
6. Upload same file twice -> second run mostly/all skipped.
7. Upload unsupported format (for example .docx) -> blocked/400.
