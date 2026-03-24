# Voter List OCR Backend (Node.js + Gemini)

**Created by Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app) | © 2026 All Rights Reserved

Backend API to ingest PDF voter lists, split them into per-page PDFs, process pages with **7 parallel Gemini API engines**, store structured voter rows in Neon, and expose session CRUD + search endpoints. Features role-based access control with Admin and User roles, plus an **intelligent NLP chatbot**.

## ✨ Key Features

- **7 Parallel Processing Engines** - Each API key runs as an independent engine
- **Automatic Engine Recovery** - Exhausted engines recover after 60 seconds
- **Never Stops Processing** - A 44-page PDF processes completely with smart batching
- **Intelligent Chatbot** - Natural language queries with role-based actions
- **Real-time Engine Status** - Monitor all 7 engines with detailed metrics

## Stack

- Node.js 18+ (uses built-in `fetch`)
- Express + Multer for upload
- pdf-lib (pure JS) for PDF page splitting (no Poppler/ImageMagick)
- Gemini API for OCR/structuring (7 parallel engines)
- Neon (PostgreSQL) for persistence
- JWT for authentication
- bcryptjs for password hashing

## Quick start

1. **Install deps**

   ```sh
   npm install
   ```

2. **Configure env**
   - Copy `.env.example` → `.env` and fill:
     - `DATABASE_URL` (Neon connection string)
     - `GEMINI_API_KEY_1` through `GEMINI_API_KEY_7` (7 keys for parallel processing)
     - `GEMINI_MODEL` (default works)

- `GEMINI_ALLOW_PAID_FALLBACK=false` to prevent automatic paid-key usage in `auto` mode
  - `JWT_SECRET` (change this in production!)

  **7 Parallel API Engines**: Add 7 Gemini API keys for maximum parallel processing. Each key becomes an independent engine that can process pages simultaneously.

3. **Initialize DB schema**

   ```sh
   npm run db:init
   ```

4. **Run server**
   ```sh
   npm run dev
   ```
   Server defaults to `http://localhost:4000`.

`npm start` now runs a Gemini startup assessment before boot:

1. `scripts/initDb.js`
2. `scripts/checkGeminiKeysOnStartup.js`
3. `src/server.js`

This pre-marks exhausted/rate-limited keys and reduces wasteful retry cycles.

## Cost Control (Recommended)

- Keep `GEMINI_DISPATCH_MODE=auto` for normal operation, but set `GEMINI_ALLOW_PAID_FALLBACK=false` so paid keys are not used automatically.
- Use `PATCH /api-keys/dispatch-mode` with `paid-only` only when you explicitly want to spend paid quota for urgent workloads.
- Keep `OCR_ENABLE_RELIGION_CLASSIFICATION=false` unless that field is required, since it adds extra AI calls per page.

## 🤖 Chatbot

The intelligent chatbot understands natural language and executes role-based actions:

### Chat Endpoint

```sh
curl -X POST "http://localhost:4000/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Find voters named Kumar"}'
```

### Example Queries:

- "Search for voter with ID ABC123"
- "Show me all sessions" (admin only)
- "What are the religion statistics?"
- "Check API status"
- "Show my profile"

## 🚀 API Engine Status

Check the status of all 7 processing engines:

```sh
curl -s "http://localhost:4000/api-keys/status" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Response:

```json
{
  "totalEngines": 7,
  "activeEngines": 7,
  "exhaustedEngines": 0,
  "busyEngines": 3,
  "availableEngines": 4,
  "engines": [...]
}
```

## Frontend Prompt (Copy-Paste) - Free -> Paid Fallback UX

Use this prompt in your frontend repository with Copilot to build a clean production UX for engine fallback:

```md
You are working in an existing frontend app for the Voter List OCR backend.

Goal:
Implement OCR engine observability UI where FREE Gemini keys are used first, and PAID keys are automatically used only when free pool is unavailable.

Do NOT hardcode API keys in frontend.
Read only from backend APIs.

Backend contracts:

1. GET /api-keys/status (admin auth)
2. GET /api-keys/dispatch-status (authenticated; frontend-safe)
3. GET /api-keys/dispatch-mode (authenticated)
4. PATCH /api-keys/dispatch-mode (admin auth; body: `{ mode: "auto" | "free-only" | "paid-only" }`)
5. GET /sessions/:id/status (admin auth)
6. POST /sessions and POST /sessions/:id/resume support optional `dispatchMode` and run with backend auto-retry logic.
7. Exhausted keys are persisted in DB and skipped until recovery window (daily reset).

Important status fields from /api-keys/status:

- totalEngines, activeEngines, rateLimitedEngines, exhaustedEngines, busyEngines, availableEngines
- configuredDispatchMode: "auto" | "free-only" | "paid-only"
- activeDispatchTier: "free" | "paid"
- pools.free and pools.paid with: total, active, rateLimited, exhausted, busy, available
- engines[] with: engineId, tier, status, busy, keyPreview, metrics.totalRequests, metrics.successCount

UI requirements:

1. Add a "Gemini Engine Monitor" card in admin upload/session screen.
2. Show top badges:

- Current Tier: FREE or PAID
- Free Pool: available/active/rate_limited/exhausted
- Paid Pool: available/active/rate_limited/exhausted

3. If activeDispatchTier === "paid", show a prominent warning/info strip:

- "Paid Gemini fallback is active. Free pool is unavailable."

Also support reading the same fallback flag from /api-keys/dispatch-status:

- paidFallbackActive: boolean

4. Add table columns: Engine, Tier, Status, Busy, Requests, Success.
5. Add color coding:

- active=green
- rate_limited=amber
- exhausted=red
- busy=true adds spinner/dot pulse

6. Poll /api-keys/status every 5 seconds while a session is processing.
7. Stop polling when session status becomes completed/failed and keep last snapshot.
8. For session cards, add line:

- "Dispatch tier used: FREE/PAID" (based on latest status payload)

9. In upload/resume success toasts, include automaticRetryRounds when present.

Implementation constraints:

- Keep existing design system/components intact.
- Use existing auth token handling.
- Add strict TypeScript types/interfaces for status payload.
- Handle API failures gracefully with retry + backoff (2s, 4s, 8s max 30s).
- Never expose full keys; show backend-provided masked keyPreview only.

Deliverables:

1. Engine monitor component
2. Hook/service for polling status
3. Type definitions for status payload
4. Session UI integration (tier badge + retry rounds)
5. Minimal tests for mapper/state transitions (if test setup exists)
```

Recommended frontend mapping for `activeDispatchTier`:

- `free` -> `FREE (Primary)`
- `paid` -> `PAID (Fallback Active)`

## Authentication

The API uses JWT-based authentication with two roles:

### User Registration & Login

- `POST /auth/register` - Register a new user (default role: "user")
  ```json
  {
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe",
    "phone": "1234567890"
  }
  ```
- `POST /auth/login` - Login and get JWT token
  ```json
  { "email": "user@example.com", "password": "password123" }
  ```
- `GET /auth/me` - Get current user info (requires token)
- `GET /auth/verify` - Verify token is valid

### Admin Registration (Admin only)

- `POST /auth/register/admin` - Create admin account (requires admin token)

## API Endpoints

### Public Endpoints

- `GET /health` - Health check
- `GET /debug/cors` - Check CORS configuration

### Chatbot Endpoints

- `POST /chat` - Chat with the intelligent assistant
- `GET /chat/actions` - Get available chat actions for your role
- `GET /system/info` - Get system information with author credits

### User Endpoints (requires authentication)

Users can search across ALL assemblies regardless of which session they were uploaded in.

- `GET /user/assemblies` - List all available assemblies
- `GET /user/assemblies/:assembly/parts` - Get part numbers for an assembly
- `GET /user/assemblies?sessionId=<sessionId>` - Session-scoped, cleaned assembly list for current session UI
- `GET /user/assemblies/:assembly/parts?sessionId=<sessionId>` - Session-scoped booth/part list for selected assembly
- `GET /user/voters/search` - Search voters (params: name, voterId, assembly, partNumber, section, relationName)
- `GET /user/voters/:id` - Get voter details by database ID
- `GET /user/voters/by-voter-id/:voterId` - Get voter by their voter ID
- `GET /user/voters/:id/print-data` - Get print-ready voter card data
- `GET /user/voters/voterslip.pdf?id=<idOrVoterId>` - Download single voter slip PDF in the latest template
- `GET /user/voters/:id/voterslip.pdf` - Alternate path for single voter slip PDF
- `POST /user/voterslips/mass/start` - Start async mass voter slip PDF generation (returns job id)
- `POST /user/voterslips/mass/sessions/:sessionId/start` - One-click mass generation for a specific session (no extra filters required)
- `POST /user/voterslips/mass/current-session/start` - Body-based alias for one-click session generation (`{ sessionId }`)
- `GET /user/voterslips/mass/jobs/:jobId` - Poll mass-generation status/progress
- `GET /user/voterslips/mass/jobs/:jobId/download` - Download generated mass voter slip PDF
- `GET /user/voterslips/layout` - Get active voter slip field-box layout + metadata
- `GET /user/voterslips/layout/template.png` - Get voter slip template image for overlay UIs
- `POST /user/voterslips/layout/recalibrate` - Recalibrate layout with Gemini OCR (admin only)
- `POST /user/voterslips/layout/manual` - Save manual layout boxes from UI and optionally set as preferred (admin only)
- `POST /user/voterslips/layout/manual/auto-labels` - Auto-generate field labels from selected manual boxes (admin only)
- `POST /user/voterslips/layout/manual/:profileId/apply` - Apply a saved manual layout profile (admin only)
- `GET /user/voterslips/layout/manual/profiles` - List saved manual layout profiles + persisted calibration state (admin only)
- `PATCH /user/voterslips/layout/mode` - Persist preferred mode (`manual|gemini|default`) so UI does not ask every time
- `POST /user/voterslips/layout/reset` - Revert to default layout (admin only)
- `POST /user/voters/:id/print` - Mark voter as printed
- `GET /user/profile` - Get own profile
- `PATCH /user/profile` - Update own profile
- `PATCH /sessions/:id/metadata` - Admin-only manual correction for `assembly_name`, `booth_no`, `booth_name` used in election-result mapping

### Mass Voter Slip Job Flow

1. Start job:
   ```sh
   curl -X POST "http://localhost:4000/user/voterslips/mass/start" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"boothNo":"42","assembly":"Barasat"}'
   ```
2. Poll progress (`queued` -> `processing` -> `completed`):
   ```sh
   curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/mass/jobs/<jobId>"
   ```
3. Download when completed:
   ```sh
   curl -L -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/mass/jobs/<jobId>/download" \
     -o voterslips.pdf
   ```

### One-Click Session Mass Slip Flow

Start directly from current voter-list session id (no assembly/part/section needed):

```sh
curl -X POST "http://localhost:4000/user/voterslips/mass/sessions/<sessionId>/start" \
  -H "Authorization: Bearer $TOKEN"
```

Or body-based alias:

```sh
curl -X POST "http://localhost:4000/user/voterslips/mass/current-session/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<sessionId>"}'
```

Booth number reliability notes:

1. Backend stores `sessions.booth_no` from OCR page-1 part number when available.
2. If OCR misses booth number, backend now infers booth number from uploaded filename (renamed files supported).
3. Linked election-result mapping and session-based mass voter slip flows use this persisted/fallback booth number.
4. Booth normalization now supports Bengali digits, so booth numbers like ১..৭ normalize correctly.

Assembly/booth dropdown quality notes:

1. Use `sessionId` query on assemblies/parts endpoints to avoid global noisy values.
2. Backend deduplicates assembly variants using canonical normalization and filename/session fallbacks.
3. If session metadata is wrong, update it via `PATCH /sessions/:id/metadata` and refresh mapping.

### Voter Slip Calibration Flow (Admin)

Template location used by voter-slip rendering:

- Default: `storage/voterslips/layout/template.png`
- Override with env: `VOTER_SLIP_TEMPLATE_PATH` (absolute or workspace-relative)

1. Read active layout:
   ```sh
   curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/layout"
   ```
2. Recalibrate from template with Gemini:
   ```sh
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/layout/recalibrate"
   ```
3. Revert to default layout:
   ```sh
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/layout/reset"
   ```

### Manual Calibration Flow (Admin)

1. Preview auto labels from UI-selected boxes:

   ```sh
   curl -X POST "http://localhost:4000/user/voterslips/layout/manual/auto-labels" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "boxes": [
         {"x":0.70,"y":0.71,"width":0.13,"height":0.05},
         {"x":0.94,"y":0.71,"width":0.04,"height":0.05}
       ]
     }'
   ```

2. Save manual boxes selected in UI and set as preferred:
   ```sh
   curl -X POST "http://localhost:4000/user/voterslips/layout/manual" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "name":"Main Layout",
       "setPreferred":true,
       "activate":true,
       "fields": {
         "partNo": {"x":0.70,"y":0.71,"width":0.13,"height":0.05,"align":"left","maxLines":1,"maxFontSize":20,"minFontSize":12,"paddingX":0.008,"paddingY":0.01},
         "serialNumber": {"x":0.94,"y":0.71,"width":0.04,"height":0.05,"align":"center","maxLines":1,"maxFontSize":20,"minFontSize":12,"paddingX":0.002,"paddingY":0.01},
         "name": {"x":0.70,"y":0.63,"width":0.19,"height":0.05,"align":"left","maxLines":1,"maxFontSize":22,"minFontSize":12,"paddingX":0.008,"paddingY":0.01},
         "father": {"x":0.70,"y":0.56,"width":0.19,"height":0.05,"align":"left","maxLines":1,"maxFontSize":20,"minFontSize":12,"paddingX":0.008,"paddingY":0.01},
         "address": {"x":0.70,"y":0.49,"width":0.28,"height":0.09,"align":"left","maxLines":2,"maxFontSize":18,"minFontSize":10,"paddingX":0.008,"paddingY":0.012},
         "sex": {"x":0.96,"y":0.63,"width":0.02,"height":0.05,"align":"center","maxLines":1,"maxFontSize":18,"minFontSize":12,"paddingX":0.002,"paddingY":0.01},
         "age": {"x":0.96,"y":0.56,"width":0.02,"height":0.05,"align":"center","maxLines":1,"maxFontSize":18,"minFontSize":12,"paddingX":0.002,"paddingY":0.01},
         "pollingStation": {"x":0.70,"y":0.31,"width":0.28,"height":0.10,"align":"left","maxLines":2,"maxFontSize":18,"minFontSize":11,"paddingX":0.008,"paddingY":0.012}
       }
     }'
   ```
3. Load profiles for selector UI:
   ```sh
   curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/layout/manual/profiles"
   ```
4. Apply one saved profile:
   ```sh
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "http://localhost:4000/user/voterslips/layout/manual/<profileId>/apply"
   ```

### Admin Endpoints (requires admin authentication)

#### Engine Management

- `GET /api-keys/status` - Get status of all 7 engines with metrics
- `GET /api-keys/dispatch-mode` - Get configured dispatch mode (`auto`, `free-only`, `paid-only`)
- `PATCH /api-keys/dispatch-mode` - Set dispatch mode (`auto`, `free-only`, `paid-only`)
- `POST /api-keys/reset` - Reset all engines to active

#### Session Management

- `POST /sessions` - Upload PDF (processed with 7 parallel engines; optional `dispatchMode`)
- `GET /sessions` - List all sessions
- `GET /sessions/:id` - Get session details
- `GET /sessions/:id/status` - Get session processing status
- `GET /sessions/:id/voters` - Get voters in session with filtering
- `DELETE /sessions/:id` - Delete session and all data
- `POST /sessions/:id/resume` - Resume paused session (optional `dispatchMode`)

#### Voter Management

- `GET /voters/search` - Global voter search with all filters
- `GET /admin/voters` - Advanced voter search with all filters
- `GET /admin/voters/:id` - Get voter full details

#### Statistics

- `GET /sessions/:id/stats/religion` - Religion stats for session
- `GET /admin/stats/religion` - Religion stats (optional: sessionId, assembly)
- `GET /admin/stats/gender` - Gender stats (optional: sessionId, assembly)
- `GET /admin/stats/prints` - Print statistics

#### User Management

- `GET /admin/users` - List all users
- `PATCH /admin/users/:id/role` - Update user role
- `DELETE /admin/users/:id` - Delete user

#### API Key Management

- `GET /api-keys/status` - Check API key status
- `GET /api-keys/dispatch-mode` - Check configured dispatch mode
- `PATCH /api-keys/dispatch-mode` - Update dispatch mode
- `POST /api-keys/reset` - Reset all keys to active

## Creating the First Admin

After initializing the database, create the first admin user:

```sh
npm run create-admin
```

Default credentials:

- Email: `admin@example.com`
- Password: `admin123`

To customize, set environment variables before running:

```sh
ADMIN_EMAIL=your-email@example.com ADMIN_PASSWORD=secure-password ADMIN_NAME="Your Name" npm run create-admin
```

⚠️ **Change the default password immediately after first login!**

## How OCR/structuring works

- PDF saved under `storage/<sessionId>/pdf/original.pdf`.
- Pages split to single-page PDFs under `storage/<sessionId>/pages/page-<n>.pdf` (pure JS, no system deps).
- Each page is sent to Gemini with a prompt asking for structured JSON:
  ```json
  {
    "assembly": "",
    "partNumber": "",
    "section": "",
    "voters": [
      {
        "serialNumber": "",
        "voterId": "",
        "name": "",
        "relationType": "father|mother|husband|guardian",
        "relationName": "",
        "houseNumber": "",
        "age": "",
        "gender": ""
      }
    ]
  }
  ```
- The raw text and structured JSON per page are stored in `session_pages` and denormalized voter rows are stored in `session_voters` for fast filtering.

## Free storage + conversion tips

- Images live in local `storage/` to avoid paid object storage. Keep disk tidy:
  - Delete sessions via API when done (removes DB rows + folder).
  - For very large PDFs, consider offloading images to a free object store (e.g., S3-compatible MinIO, Cloudflare R2 free tier). Swap `image_path` to a URL; minimal code change in `savePageRecord`.
- Conversion is pure JS (pdf-lib) so it runs on Render/anywhere without Poppler/ImageMagick.

## Re-running OCR on the same PDF

- The PDF is converted to images once per session ID. To reprocess with different prompts, reuse stored images and rerun Gemini calls only (add a new endpoint if desired).

## Notes

- Keep your Gemini keys and DB URL out of version control (they're in `.gitignore`).
- The system automatically handles API key rotation when quotas are exhausted.
- Use `POST /api-keys/reset` to reset all keys to active status (useful after daily quota reset).
- Use `GET /api-keys/status` to check the status of all API keys.
- Use `POST /sessions/:id/resume` to resume a paused session from where it stopped.
- To change parsing heuristics, edit `src/parser.js`.
