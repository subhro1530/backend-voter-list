# Immediate View Voters Frontend Fix Prompt

Use this prompt in your frontend codebase to make the page change immediately on View Voters click.

## Goal

When user clicks View Voters for a booth row:

1. Open voters panel/page immediately (no waiting for full voter payload).
2. Show loading skeleton instantly.
3. Load booth session metadata first.
4. Then load voters list and hydrate UI.
5. Keep remembered booth session behavior.

## Integration Requirements

Use helper from scripts/electionResultsFrontendLinking.js.

API now supports:

- GET /election-results/sessions/:id/booths/voter-list?boothNo=&limit=&includeVoters=&voterSessionId=
- includeVoters=0 for fast metadata response
- includeVoters=1 for full voter rows

## Wiring Pattern

Use openBoothVoters with callbacks:

```js
import { openBoothVoters } from "./electionResultsFrontendLinking";

async function onClickViewVoters(row, electionSessionId) {
  await openBoothVoters({
    apiBaseUrl,
    token,
    electionSessionId,
    boothNo: row.booth_no,
    limit: 200,
    progressive: true,
    onStart: ({ boothNo }) => {
      setVoterPanelOpen(true); // immediate UI transition
      setVoterPanelState({
        phase: "loading",
        boothNo,
        selectedSession: null,
        voterSessions: [],
        voters: [],
      });
    },
    onMeta: (meta) => {
      setVoterPanelState((prev) => ({
        ...prev,
        phase: "loading-voters",
        selectedSession: meta.selectedSession,
        voterSessions: meta.voterSessions,
        selectionSource: meta.selectionSource,
      }));
    },
    onSuccess: (data) => {
      setVoterPanelState({
        phase: "ready",
        boothNo: data.boothNo,
        selectedSession: data.selectedSession,
        voterSessions: data.voterSessions,
        voters: data.voters,
        selectionSource: data.selectionSource,
      });
    },
    onError: (err) => {
      setVoterPanelState((prev) => ({
        ...prev,
        phase: "error",
        error: err.message || "Failed to load voters",
      }));
    },
  });
}
```

## Session Switcher Behavior

When user selects another voter session in dropdown/chips, call switchBoothVoterSession(...) and replace only voters list + selectedSession.

## UX Acceptance

1. Panel opens immediately on click.
2. No blocked click while fetch is running.
3. If request takes 2-5s, user still sees loading state in opened panel.
4. No full-page freeze.
5. Existing layout remains unchanged.
