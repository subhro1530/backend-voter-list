# Frontend Fix Prompt: Adjudication Save API Alignment

Use this in the frontend repo to fix adjudication save failures caused by endpoint mismatch.

## Goal

Ensure edit-mode checkbox saves for `Under Adjudication` work reliably across current and older backend builds.

## Problem

Frontend currently calls PATCH endpoints that may differ across backend versions.

Observed routes in use:

- `PATCH /sessions/:sessionId/voters/adjudication`
- `PATCH /sessions/:sessionId/voters/bulk`
- `PATCH /sessions/:sessionId/voters`

Supported backend routes (latest):

- `PATCH /sessions/:sessionId/voters/:voterId/adjudication`
- `PATCH /sessions/:sessionId/voters/adjudication`
- `PATCH /sessions/:sessionId/voters`
- `PATCH /sessions/:sessionId/voters/bulk`

## Required Frontend Changes

### 1) Save strategy for checkbox edits

Implement this request order:

1. Preferred single-row save:
   - `PATCH /sessions/:sessionId/voters/:voterId/adjudication`
   - Body: `{ underAdjudication: boolean }`
2. Fallback batch save (if endpoint not found or disabled):
   - `PATCH /sessions/:sessionId/voters/adjudication`
   - Body: `{ updates: [{ voterId, underAdjudication }] }`
3. Legacy bulk fallback:
   - `PATCH /sessions/:sessionId/voters/bulk`
   - Body: `{ updates: [{ voterId, underAdjudication }] }`
4. Final compatibility fallback:
   - `PATCH /sessions/:sessionId/voters`
   - Body: `{ updates: [{ voterId, underAdjudication }] }`

Treat `404` and `405` as route-compatibility fallback triggers.

### 2) Payload shape normalization

Always send frontend payload keys as camelCase:

- `voterId`
- `underAdjudication`

Do not send only snake_case keys from UI state.

### 3) Response mapping

Backend may return snake_case field:

- `under_adjudication`

Map to frontend state:

- `underAdjudication = Boolean(row.underAdjudication ?? row.under_adjudication ?? false)`

### 4) Optimistic UI + rollback

- On checkbox toggle: optimistic row update.
- On save failure: rollback row value and show toast with endpoint + status code.
- Keep failed rows highlighted until retry succeeds.

### 5) Error messaging

Replace generic error with actionable message:

- `Could not save adjudication status. Retrying with compatibility endpoint...`
- Final failure:
  - `Save failed for adjudication after compatibility retries. Please contact admin.`

### 6) Type definitions

```ts
type VoterAdjudicationPatch = {
  voterId: string | number;
  underAdjudication: boolean;
};

type VoterSaveResponseRow = {
  id: string | number;
  session_id?: string;
  underAdjudication?: boolean;
  under_adjudication?: boolean;
};
```

### 7) API client helper

Create one reusable helper:

- `saveVoterAdjudication(sessionId, patch)`

It should:

- try endpoint chain in order,
- stop on first success,
- throw aggregated error details if all fail.

## Acceptance Checklist

1. Checkbox save works with primary endpoint.
2. If primary endpoint returns 404, frontend retries fallback endpoints automatically.
3. No 404 toast shown to users unless all compatibility endpoints fail.
4. Table reflects saved value after refresh.
5. Old records without value still render as `No` and can be toggled + saved.

## QA Steps

1. Edit one row and save -> confirm no 404.
2. Temporarily disable primary endpoint and verify fallback succeeds.
3. Bulk edit multiple adjudication checkboxes and confirm all persisted.
4. Refresh page and confirm values round-trip from backend.
