# Session Page + Mass Voter Slip Frontend Prompt

Use this in the frontend repo to implement session listing performance fixes, pagination, and production-safe voter-slip UX for Unicode errors.

## Mission

Improve session browsing UX and speed by defaulting to recent data, add practical filters (including booth number), and prevent silent voter-slip failures by handling Unicode-related backend errors cleanly on UI.

## Scope

Implement all items below on the Sessions page and Mass Voter Slip flow.

## Requirements

### 1) Sessions Filters (mandatory)

Add a filter bar on Sessions page with at least:

- Booth No
- Assembly
- Voter List
- Section
- Date range (from/to)
- Status (if available)

Behavior:

- Filters must be server-driven (send query params to sessions list API).
- Debounce text input fields (300-500ms).
- Reset page to 1 whenever filters change.
- Keep filters in URL query string for shareable state.

Example query format:

- `/sessions?boothNo=123&assembly=Barasat&voterList=all&section=A&page=1&limit=10&sort=createdAt:desc`

### 2) Pagination: 10 Per Page + Next/Prev

Sessions list must:

- Show exactly 10 rows per page.
- Include Previous and Next controls.
- Disable Previous on first page.
- Disable Next when no more data.
- Show page indicator (example: `Page 2`).

API assumptions:

- Use server pagination (`page`, `limit=10`).
- If API returns total count, compute `hasNext` from total.
- If no total count, infer `hasNext` when returned row count is 10.

### 3) Initial Load Optimization (only recent 10)

On initial Sessions page load:

- Fetch only the latest 10 sessions sorted by newest first.
- Do not prefetch older pages until user clicks Next.
- Use skeleton loaders only for visible rows.
- Keep last successful page response in local state cache to avoid refetch on quick back/next.

Performance goals:

- Time-to-first-list render should improve by avoiding full history fetch.
- API calls should be minimal and deterministic.

### 4) Mass Voter Slip Unicode Error UX (production issue)

Current backend error example:

- `PDF generation failed due to font encoding on backend. Please use a Unicode-capable embedded font...`

Frontend must:

- Detect this error string (or backend error code if provided).
- Show a clear actionable message in job status panel.
- Expose details in expandable technical panel.
- Keep `Restart with Previous Filters` CTA visible.

### 5) Frontend Data Sanitization Before Submit

Before sending voter-slip generation payload:

- Normalize text fields to NFC.
- Remove control characters except newline/tab.
- Trim repeated whitespace.
- If sanitization changes user input, show non-blocking warning:
  - `Some unsupported characters were removed to make PDF generation safer.`

Important:

- Do not strip valid Bengali or other Unicode letters.
- Do not mutate display labels; sanitize request payload values used by backend PDF generator.

### 6) Resilience + Retry

For voter-slip job polling:

- Retry transient polling failures with exponential backoff (max 3 retries).
- Stop polling on terminal states: completed, failed, cancelled.
- Preserve last known progress UI even if polling request fails once.

## Suggested Frontend Types

```ts
type SessionFilterState = {
  boothNo?: string;
  assembly?: string;
  voterList?: string;
  section?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
};

type SessionListQuery = SessionFilterState & {
  page: number;
  limit: 10;
  sort: "createdAt:desc";
};

type SanitizationResult = {
  value: string;
  changed: boolean;
};
```

## Acceptance Checklist

1. Sessions page loads only 10 latest records initially.
2. Filters include booth number and are reflected in URL.
3. Pagination works with Next/Previous and 10 rows per page.
4. Changing any filter resets to page 1.
5. Unicode backend failure is shown with a clear actionable UI message.
6. Payload sanitization runs before submit and shows warning when data changes.
7. Polling remains stable under temporary network failures.

## QA Scenarios

1. Apply booth filter, reload page, verify same filter persists from URL.
2. Navigate to page 2 and back to page 1, verify no duplicate flicker and preserved state.
3. Trigger Unicode backend failure and verify user sees actionable error + technical details.
4. Submit input containing hidden control chars, verify warning appears and request succeeds.
5. Verify Bengali names remain intact after sanitization.

## Non-Goals

- No backend schema changes in this task.
- No redesign of unrelated pages.
