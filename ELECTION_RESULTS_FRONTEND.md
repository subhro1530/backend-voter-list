# Election Results + Voter Session Linking Frontend Prompt

Enhance the existing frontend only. Do not create a new interface, new page shell, or new layout system.

Keep current tables, filters, cards, and navigation structure. Add booth-level linking behavior inside the existing UI.

## Core Experience Goals

1. Filter election results by Assembly, Year, and Booth.
2. Show booth-wise results in a rich table.
3. For each booth row, show whether voter-list data exists.
4. If voter-list data exists, provide one-click navigation to that booth's voters.
5. In voter-list sessions, show booth + assembly identity and one-click navigation to matching booth result rows.

## UI Constraint

1. No visual redesign.
2. No new dashboard layout.
3. Reuse existing components and styles.
4. Only add new controls/columns/actions where needed.

## APIs to Integrate

All APIs require admin JWT bearer token.

### Election Results

1. GET /election-results/sessions?assembly=&year=&boothNo=

- Use this to populate/filter election sessions list.
- Supports combined filters.

2. GET /election-results/sessions/:id

- Use this to render full booth table.
- Each booth row now includes:
  - has_voter_list
  - voter_session_id
  - voter_session_name
  - voter_booth_name
  - voter_count

3. GET /election-results/sessions/:id/booths/:boothNo/voter-list

- Use when user clicks a booth row (or row action) in results table.
- Returns matched voter sessions and voters from the best session.
- Supports optional query params:
  - `limit` (default 200)
  - `voterSessionId` (preferred voter session for that booth)
- Response now includes `selectionSource` with values: `query`, `memory`, `auto`, `none`.

### Voter Sessions

1. GET /sessions

- Shows session metadata including assembly_name, booth_no, booth_name.

2. GET /sessions/:id/linked-election-results?year=

- Use when user is viewing a voter session and clicks "View Booth Result".
- Returns booth-only matched election result rows plus full booth election data.

## Required Enhancements In Existing Screens

### A) Existing Election Results Table

1. Keep existing filters and add Year if not present.
2. On row click in booth results table:

- Treat clicked row booth_no as active booth.
- Show only that booth detail (existing detail panel/modal/section).
- If has_voter_list is true, show action to open voters for that booth.

### B) Existing Voter Session List/Table

1. Keep existing list UI.
2. Add/keep button: "View Booth Result" for each voter session row/card.
3. Button calls GET /sessions/:id/linked-election-results?year=
4. Render full booth election payload from response.fullResults in existing modal/panel.
5. Show complete booth dataset for each matched election session:

- electionSession metadata
- boothResult row (candidate_votes, total_valid_votes, rejected_votes, nota, total_votes, tendered_votes)
- candidates list
- totals rows (evm/postal/total)

## UX Rules

1. Booth number is primary identity.
   Always display booth number prominently.

2. Assembly context is mandatory.
   Never show a booth link result from a different assembly without warning.

3. Empty states:

- No filtered sessions.
- No booth rows.
- Booth has no linked voter list.
- Voter session has no linked election result.

4. Loading states:

- Skeleton cards for session rail.
- Skeleton rows for booth table.

5. Error states:

- Toast with retry action.
- Keep previous data on filter failure.

## Component Rule

Do not create a brand new component architecture. Extend your current components with the minimum required props and handlers.

## Data Contracts to Model in Frontend Types

1. Election session list item:

- id
- constituency
- election_year
- status
- booth_count
- candidate_count

2. Booth row:

- booth_no
- serial_no
- candidate_votes
- total_votes
- has_voter_list
- voter_session_id
- voter_session_name
- voter_count

3. Linked voter response:

- electionSession
- boothNo
- voterSessions[]
- selectedSession
- voters[]

4. Linked election response from voter session:

- session
- linkedResults[]
- fullResults[]
- fullResults[].electionSession
- fullResults[].boothResult
- fullResults[].candidates[]
- fullResults[].totals[]

## Interaction Rules

1. Election result row click must focus one booth only.
2. "View Voters" must open voters of that same booth only.
3. "View Booth Result" from voter session must show full booth election data from fullResults.
4. Keep assembly context strict; do not cross-show another assembly booth.

## Performance + Session Memory Behavior

1. Persist the last selected voter session per booth in frontend storage.

- Key format: `booth-selection:${electionSessionId}:${normalizedBooth}`
- Value: selected `voterSessionId`

2. On clicking "View Voters":

- Read stored `voterSessionId` for this booth.
- Call `GET /election-results/sessions/:id/booths/:boothNo/voter-list?voterSessionId=<storedId>&limit=200`.
- If API returns 400, retry once without `voterSessionId`.

3. After successful response:

- Save `selectedSession.id` back to storage using the same key.
- If `selectionSource` is `memory`, show a subtle label like "Opened last used voter session".

4. If multiple `voterSessions` are returned, provide a session switcher (dropdown/chips) in the existing panel.

- On switch, call same endpoint with chosen `voterSessionId`.
- Update stored key immediately.

## Acceptance Criteria

1. Admin can filter election sessions by assembly + year + booth together.
2. Admin can open a session and see booth rows with voter-list link status.
3. Clicking "View Voters" on a booth row shows voters only for that booth.
4. Voter sessions display booth and assembly metadata clearly.
5. Clicking "View Booth Result" from a voter session shows only matching booth result rows from the same assembly context.
6. Existing UI remains intact; only enhanced behavior is added.
