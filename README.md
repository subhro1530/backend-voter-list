# Voter List OCR Backend (Node.js + Gemini)

Backend API to ingest PDF voter lists, split them into per-page PDFs, send pages to Gemini OCR, store structured voter rows in Neon, and expose session CRUD + search endpoints.

## Stack

- Node.js 18+ (uses built-in `fetch`)
- Express + Multer for upload
- pdf-lib (pure JS) for PDF page splitting (no Poppler/ImageMagick)
- Gemini API for OCR/structuring
- Neon (PostgreSQL) for persistence

## Quick start

1. **Install deps**

   ```sh
   npm install
   ```

2. **Configure env**

   - Copy `.env.example` → `.env` and fill:
     - `DATABASE_URL` (Neon connection string)
     - `GEMINI_API_KEY`
     - `GEMINI_MODEL` (default works)
   - `GEMINI_PAGE_DELAY_MS` (optional, default 2000ms) to slow between Gemini calls and avoid timeouts

3. **Initialize DB schema**

   ```sh
   npm run db:init
   ```

4. **Run server**
   ```sh
   npm run dev
   ```
   Server defaults to `http://localhost:3000`.

## API

- `POST /sessions` (multipart/form-data) field `file`: upload a PDF, splits to per-page PDFs once, runs Gemini OCR+structuring with an optional delay between pages, stores page blobs plus per-voter rows.
- `GET /sessions`: list sessions with status, page_count, voter_count.
- `GET /sessions/:id`: fetch session with pages and all voters.
- `GET /sessions/:id/voters`: filter voters within a session (query params: name, voterId, gender, minAge, maxAge, houseNumber, relationType, partNumber, section, assembly, serialNumber).
- `GET /voters/search`: global voter search across all sessions (same filters, optional `sessionId`).
- `DELETE /sessions/:id`: delete session data and its stored files.

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

- Keep your Gemini key and DB URL out of version control.
- If you hit Gemini rate limits, add simple retry/backoff in `callGemini`.
- To change parsing heuristics, edit `src/parser.js`.
