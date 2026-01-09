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
- `GET /user/voters/search` - Search voters (params: name, voterId, assembly, partNumber, section, relationName)
- `GET /user/voters/:id` - Get voter details by database ID
- `GET /user/voters/by-voter-id/:voterId` - Get voter by their voter ID
- `GET /user/voters/:id/print-data` - Get print-ready voter card data
- `POST /user/voters/:id/print` - Mark voter as printed
- `GET /user/profile` - Get own profile
- `PATCH /user/profile` - Update own profile

### Admin Endpoints (requires admin authentication)

#### Engine Management

- `GET /api-keys/status` - Get status of all 7 engines with metrics
- `POST /api-keys/reset` - Reset all engines to active

#### Session Management

- `POST /sessions` - Upload PDF (processed with 7 parallel engines!)
- `GET /sessions` - List all sessions
- `GET /sessions/:id` - Get session details
- `GET /sessions/:id/status` - Get session processing status
- `GET /sessions/:id/voters` - Get voters in session with filtering
- `DELETE /sessions/:id` - Delete session and all data
- `POST /sessions/:id/resume` - Resume paused session

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
