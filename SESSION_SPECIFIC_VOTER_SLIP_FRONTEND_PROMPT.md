# Specific Voter Slip Frontend Prompt

Use this in the frontend repository only.

This is a standalone flow. It must not map to any existing voter-list session and must not modify session data.

## Feature Name

Use navbar label:

- Specific Voter Slip

Suggested route:

- /specific-voter-slip

## Goal

Build a backup flow for missed voters:

1. User enters Part No manually.
2. User pastes multiple screenshot snippets from clipboard (or uploads files).
3. Frontend sends all snippets together for Gemini OCR.
4. Backend extracts voters from only those snippets and returns them as table rows.
5. Backend starts PDF generation for only those extracted rows.
6. Frontend polls job status and downloads the final PDF.

## Important Rule

- Do not show any session dropdown in this page.
- Do not send sessionId for this flow.
- This flow must be isolated from session upload/adjudication flows.

## Backend Route To Use

1. Start specific OCR-based voter slip job

- Method: POST
- URL: /user/voterslips/specific/start
- Auth: same user auth as other /user routes
- Content-Type: multipart/form-data
- Body fields:
  - partNo (required)
  - files (preferred, multiple)
  - file (also accepted)
  - apiKey or geminiApiKey (optional)

Supported file types:

- application/pdf
- image/png
- image/jpeg
- image/jpg

2. Poll job status

- Method: GET
- URL: /user/voterslips/mass/jobs/:jobId

3. Download generated PDF

- Method: GET
- URL: /user/voterslips/mass/jobs/:jobId/download

## Start Response Contract (Implemented)

HTTP 202:

```json
{
  "message": "Specific voter slip generation started",
  "partNo": "42",
  "ocr": {
    "uploadId": "uuid",
    "filesReceived": 8,
    "filesAccepted": 8,
    "pagesProcessed": 8,
    "extractedCount": 32,
    "acceptedBeforeDedupeCount": 30,
    "acceptedCount": 26,
    "skippedUnderAdjudicationCount": 1,
    "duplicateRowsSkipped": 3,
    "failedPages": 0,
    "dispatchMode": "auto",
    "tableColumns": [
      "rowNo",
      "serialNumber",
      "voterId",
      "name",
      "relationName",
      "houseNumber",
      "age",
      "gender",
      "section",
      "partNumber",
      "sourceFileName",
      "sourcePageNumber"
    ],
    "tableRows": [
      {
        "rowNo": 1,
        "serialNumber": "101",
        "voterId": "ABC1234567",
        "name": "...",
        "relationName": "...",
        "houseNumber": "...",
        "age": 43,
        "gender": "Male",
        "section": "...",
        "partNumber": "42",
        "sourceFileName": "pasted-snippet-1.png",
        "sourcePageNumber": 1
      }
    ]
  },
  "failedPages": [],
  "job": {
    "id": "uuid",
    "jobType": "specific-ocr-pdf",
    "status": "queued",
    "total": 26,
    "processed": 0,
    "downloadUrl": null
  }
}
```

## Error Handling Contract

- 400: missing partNo or no files in accepted field name
- 404: no voters could be extracted
- 413: file too large
- 500: OCR/job start failure

## Required UI Tasks

1. Add navbar entry Specific Voter Slip.
2. Build a page with:

- Required Part No input box (text/number)
- Multi-file input (accept .pdf,.png,.jpg,.jpeg)
- Clipboard paste zone for multiple images
- Uploaded snippet list with remove action per item
- Button: Start Generating Voter Slips
- OCR summary panel
- OCR extracted rows table panel
- Job progress panel
- Download button when completed

3. Clipboard behavior

- Allow repeated paste operations while page/modal is open.
- Each paste image should be appended as a new File item.
- Do not replace previously pasted images.
- Show thumbnail + filename + size per pasted file.
- Allow clearing all files.

4. Submit behavior

- Build FormData with partNo + all files under files[] or files.
- Disable submit while request is in progress.
- After 202 response, render OCR table from ocr.tableRows.
- Start polling using job.id.

5. Job polling behavior

- Poll every 1-2 seconds while status is queued/processing.
- Stop polling when status is completed or failed.
- If completed and downloadUrl exists, show Download PDF button.

6. Download behavior

- Download endpoint is single-use (file is removed after successful download).
- After successful download, refresh job state once and disable repeat download.

## Frontend State Suggestion

```ts
type SpecificVoterSlipState = {
  partNo: string;
  files: File[];
  isSubmitting: boolean;
  submitError: string | null;
  ocrSummary: {
    filesReceived: number;
    filesAccepted: number;
    pagesProcessed: number;
    extractedCount: number;
    acceptedBeforeDedupeCount: number;
    acceptedCount: number;
    skippedUnderAdjudicationCount: number;
    duplicateRowsSkipped: number;
    failedPages: number;
  } | null;
  ocrTableRows: Array<{
    rowNo: number;
    serialNumber: string;
    voterId: string;
    name: string;
    relationName: string;
    houseNumber: string;
    age: number | string;
    gender: string;
    section: string;
    partNumber: string;
    sourceFileName: string;
    sourcePageNumber: number | null;
  }>;
  failedPages: Array<{
    fileName: string;
    pageNumber: number | null;
    error: string;
  }>;
  job: {
    id: string;
    status: "queued" | "processing" | "completed" | "failed";
    total: number;
    processed: number;
    downloadUrl: string | null;
    error?: string | null;
  } | null;
};
```

## UX Copy

Use helper text near uploader:

- This flow is independent of uploaded sessions.
- Enter the Part No manually before generating slips.
- Paste multiple voter snippets from clipboard or upload files.
- Only OCRed voters from these snippets will be used.

## Acceptance Checklist

1. Navbar has Specific Voter Slip.
2. No session selector is shown.
3. Part No input is mandatory.
4. Multiple pasted screenshots are accumulated and visible.
5. Start button sends one multipart request with partNo and all snippets.
6. OCR summary and OCR table rows are shown from backend response.
7. Job status updates until completion/failure.
8. Download works when completed.
9. Failed pages (if any) are visible to user.

## QA Scenarios

1. Paste 3 screenshots with Part No 42, generate slips, download PDF.
2. Mix image + PDF in one request.
3. Submit without partNo -> 400 shown.
4. Use wrong field name intentionally -> frontend still sends files properly.
5. OCR returns no voters -> 404 handled with friendly message.
6. Some pages fail OCR -> failedPages list shown.
7. Completed download then click download again -> handle single-use response gracefully.
