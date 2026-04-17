# Frontend Prompt: Bulk Under Adjudication by SL No (Tag Input)

Use this in the frontend repo to add a fast bulk adjudication flow by serial number (SL No) for a selected voter list session/booth.

## Goal

Allow admins to enter multiple SL numbers using Enter-key tags and set all matching voters to `Under Adjudication = Yes` in one click.

Keep the current per-row checkbox edit flow exactly as-is (backup/manual mode).

## Backend Endpoint (already available)

- `PATCH /sessions/:sessionId/voters/adjudication/by-serial`

Body:

```json
{
  "serialNumbers": ["12", "13", "14"],
  "partNumber": "125",
  "boothNo": "125"
}
```

Accepted serial input aliases (backend):

- `serialNumbers` (preferred)
- `serials`, `serialNos`, `slNos`, `slNumbers`, `slNoList`
- string input is also accepted (comma/newline/space separated)

Behavior:

- Deduplicates SL numbers.
- Invalid tokens are ignored and returned in `invalidTokens`.
- Non-existing SL numbers are ignored and returned in `ignoredSerialNumbers`.
- Matching voters are set to `under_adjudication = true`.
- Already-true rows stay true.

Success response shape:

```ts
type BulkBySerialResponse = {
  message: string;
  boothNo: string | null;
  partNumber: string | null;
  requestedSerialCount: number;
  matchedCount: number;
  updatedCount: number;
  alreadyUnderAdjudicationCount: number;
  ignoredSerialNumbers: string[];
  invalidTokens: string[];
  voters: Array<{
    id: string | number;
    session_id: string;
    part_number: string | null;
    serial_number: string | null;
    under_adjudication: boolean;
  }>;
};
```

## UI Requirements

### 1) Add bulk adjudication panel in voter list view

Place a compact panel above the table (or near current edit controls):

- Title: `Bulk Under Adjudication (SL No)`
- Subtitle: `Enter SL numbers and press Enter`
- Input placeholder: `Type SL No and press Enter`
- Tag list/chips showing entered SL numbers
- Button per tag: remove (`x`)
- Clear all action
- Primary button: `Make Under Adjudication`

### 2) Enter key -> tag behavior

Input interaction:

- On Enter, parse current token and add as tag.
- Accept separators: Enter, comma, space, newline, semicolon.
- Only positive integers allowed.
- Deduplicate tags.
- Reject invalid token with inline warning toast/message.

### 3) Submission behavior

On clicking `Make Under Adjudication`:

1. If no tags, show validation message and stop.
2. Disable submit button and show loading state.
3. Call API with:
   - `serialNumbers: tags`
   - `partNumber`: currently selected part filter if available
   - `boothNo`: current session booth number if available
4. On success:
   - Auto-refresh voter table/list from backend OR patch local rows using returned `voters` IDs.
   - Show success summary with counts:
     - `updatedCount`
     - `alreadyUnderAdjudicationCount`
     - `ignoredSerialNumbers.length`
     - `invalidTokens.length`
5. Keep tags after success (so user can adjust and retry) unless user clicks clear.

### 4) Do not break existing checkbox flow

- Existing row-level checkbox toggle/save must remain unchanged.
- This bulk panel is an additional faster path only.

### 5) Error handling

For API errors:

- 400: show backend error text and preserve tags.
- 404: show `Session not found` style message.
- 503: show retry-friendly message (`Database temporarily unavailable. Please retry.`).
- Other: generic fallback with status code.

Always re-enable button after request completes.

## Example API helper

```ts
async function bulkSetAdjudicationBySerial(
  sessionId: string,
  payload: {
    serialNumbers: string[];
    partNumber?: string;
    boothNo?: string;
  },
): Promise<BulkBySerialResponse> {
  const res = await api.patch(
    `/sessions/${sessionId}/voters/adjudication/by-serial`,
    payload,
  );
  return res.data;
}
```

## Suggested Component State

```ts
type BulkAdjState = {
  input: string;
  serialTags: string[];
  loading: boolean;
  lastResult?: BulkBySerialResponse;
};
```

## Acceptance Checklist

1. User can add SL numbers quickly via Enter-key tags.
2. User can remove individual tags and clear all.
3. Clicking `Make Under Adjudication` updates all matching rows to `Yes`.
4. Missing SL numbers are ignored without failing the entire action.
5. Existing checkbox edit/save still works exactly as before.
6. Table reflects latest adjudication state immediately after bulk action.
