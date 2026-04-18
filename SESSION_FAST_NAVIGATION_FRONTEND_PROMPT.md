# Session Fast Navigation Frontend Prompt

Use this in the frontend repository only.

This feature adds instant previous and next navigation buttons on session detail view so users can move booth-by-booth quickly (example: 1 -> 2 -> 3, then back to 2).

## Goal

When a user opens any session detail page, show visible navigation controls immediately:

- Previous Session button
- Next Session button

Navigation must follow booth order and support both ascending and descending traversal.

## Backend APIs To Use

1. Session detail with embedded navigation:

- Method: GET
- URL: /sessions/:id
- Optional query params:
  - order=asc or desc
  - sortOrder=asc or desc (alias)
  - boothOrder=asc or desc (alias)

This now returns a navigation object together with session/pages/voters.

2. Navigation-only endpoint (lightweight refresh):

- Method: GET
- URL: /sessions/:id/navigation
- Optional query params:
  - order=asc or desc
  - sortOrder=asc or desc (alias)
  - boothOrder=asc or desc (alias)

## Navigation Response Shape

```json
{
  "sessionId": "uuid",
  "order": "asc",
  "totalSessions": 250,
  "currentIndex": 22,
  "currentSession": {
    "id": "uuid",
    "originalFilename": "booth-22.pdf",
    "status": "completed",
    "boothNo": "22",
    "boothName": "Primary School",
    "assemblyName": "Assembly X",
    "created_at": "...",
    "updated_at": "..."
  },
  "previousSession": {
    "id": "uuid",
    "originalFilename": "booth-21.pdf",
    "boothNo": "21",
    "boothName": "...",
    "assemblyName": "..."
  },
  "nextSession": {
    "id": "uuid",
    "originalFilename": "booth-23.pdf",
    "boothNo": "23",
    "boothName": "...",
    "assemblyName": "..."
  }
}
```

Notes:

- previousSession can be null for first item.
- nextSession can be null for last item.

## Required UI Tasks

1. Show navigation bar at top of session detail page:

- Previous button (left)
- Next button (right)
- Optional center label: Booth X of Y

2. Add order toggle control:

- Asc
- Desc

3. On page open:

- Fetch session detail using selected order.
- Render buttons immediately from navigation payload.

4. Button behavior:

- Previous click: route to previousSession.id
- Next click: route to nextSession.id
- Keep same order query param while navigating

5. Disabled states:

- Disable Previous when previousSession is null
- Disable Next when nextSession is null

6. Prefetch optimization:

- Prefetch previous and next session detail in background after initial render (optional but recommended for fast transitions).

7. Loading behavior:

- Keep navigation bar stable while data refreshes.
- Show skeleton/spinner inside content area, not replacing nav controls.

## UX Requirements

- Buttons must be visible as soon as session detail opens.
- Display booth references on buttons when available:
  - Previous: Booth <boothNo>
  - Next: Booth <boothNo>
- Preserve keyboard accessibility:
  - Buttons reachable via tab
  - Enter/Space activates navigation

## State Shape Suggestion

```ts
type SessionNavItem = {
  id: string;
  originalFilename: string;
  status: string;
  boothNo: string;
  boothName: string;
  assemblyName: string;
};

type SessionNavigationState = {
  order: "asc" | "desc";
  totalSessions: number;
  currentIndex: number;
  currentSession: SessionNavItem | null;
  previousSession: SessionNavItem | null;
  nextSession: SessionNavItem | null;
  isLoading: boolean;
  error: string | null;
};
```

## Error Handling

- 404 from /sessions/:id or /sessions/:id/navigation:
  - show not found message
  - disable nav buttons

- Network/server error:
  - keep current session content visible when possible
  - show non-blocking toast and retry option

## Acceptance Checklist

1. Previous and Next buttons are visible on session open.
2. Buttons navigate to adjacent sessions instantly.
3. Asc/Desc order toggle changes traversal direction.
4. Buttons disable correctly at boundaries.
5. Booth labels update correctly while navigating.
6. Session detail and navigation stay in sync.

## QA Scenarios

1. Open booth 2 in asc order:

- Previous shows booth 1
- Next shows booth 3

2. Switch to desc order at same booth:

- Previous/Next direction flips correctly

3. Open first booth in asc:

- Previous disabled

4. Open last booth in asc:

- Next disabled

5. Click next repeatedly through multiple booths:

- Navigation remains fast and consistent

6. Navigate forward then backward:

- Booth sequence is correct in both directions
