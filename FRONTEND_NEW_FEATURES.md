# Frontend Prompt — New Features

**For: Voter List Management System Frontend**
**Features: Election Results, Voter Photos (Cloudinary), Booth Names**
**Created by: Shaswata Saha | ssaha.vercel.app**

---

## 🎯 Summary of New Backend Features

Three major additions have been made to the backend:

1. **Election Results** — A completely separate entity (like voter list sessions) to OCR-process Form 20 election result PDFs, store booth-wise candidate vote data, and export to a styled Excel sheet.
2. **Voter Photo URLs (Cloudinary)** — Each voter in `session_voters` now has an optional `photo_url` field. During OCR, if a voter's photograph is detected, it is extracted and uploaded to Cloudinary automatically.
3. **Booth Name Tracking** — Each voter-list session now carries a `booth_name` field identifying the polling station or booth detected from the PDF.

All election result routes are **admin-only** (require JWT + admin role).

---

## 📊 Feature 1: Election Results

### New API Endpoints

All routes are prefixed with `/election-results` and require `Authorization: Bearer <token>` with an admin account.

| Method   | Endpoint                                      | Description                                       |
| -------- | --------------------------------------------- | ------------------------------------------------- |
| `POST`   | `/election-results/upload`                    | Upload & OCR-process an election PDF              |
| `GET`    | `/election-results/sessions`                  | List all election result sessions                 |
| `GET`    | `/election-results/sessions/:id`              | Full session details (booths, candidates, totals) |
| `DELETE` | `/election-results/sessions/:id`              | Delete a session and its storage                  |
| `GET`    | `/election-results/sessions/:id/export/excel` | Download styled `.xlsx` file                      |
| `GET`    | `/election-results/sessions/:id/stats`        | Per-candidate statistics (booths won, avg votes…) |
| `PATCH`  | `/election-results/sessions/:id/rename`       | Rename session (`{ "name": "..." }`)              |

---

### 1.1 Upload & Process Page

**Route:** `POST /election-results/upload`
**Content-Type:** `multipart/form-data`
**Field:** `file` (PDF, max 50 MB)

**Response (201):**

```json
{
  "sessionId": "uuid",
  "constituency": "123 - My Constituency",
  "totalElectors": 234567,
  "candidates": ["Candidate A", "Candidate B", "Candidate C"],
  "totalBooths": 42,
  "pages": 5,
  "status": "completed"
}
```

**Frontend Implementation:**

```jsx
// pages/admin/ElectionResultUpload.jsx
import { useState } from "react";
import axios from "axios";

export default function ElectionResultUpload() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await axios.post("/election-results/upload", fd, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Upload Election Result PDF</h1>
      <p className="text-gray-600 mb-6">
        Upload a Form 20 Final Result Sheet PDF. The system will OCR each page,
        extract booth-wise candidate votes, and store them for viewing &amp;
        Excel export.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files[0])}
        className="mb-4"
      />

      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="bg-blue-600 text-white px-6 py-2 rounded disabled:opacity-50"
      >
        {uploading
          ? "Processing… (this may take a few minutes)"
          : "Upload & Process"}
      </button>

      {error && <p className="text-red-500 mt-4">{error}</p>}

      {result && (
        <div className="mt-6 bg-green-50 p-4 rounded border border-green-200">
          <h2 className="font-semibold text-green-800">Processing Complete</h2>
          <p>Constituency: {result.constituency}</p>
          <p>Candidates: {result.candidates.join(", ")}</p>
          <p>
            Booths: {result.totalBooths} | Pages: {result.pages}
          </p>
        </div>
      )}
    </div>
  );
}
```

> **Note:** Processing is sequential and can take a few minutes for long PDFs (~2 sec per page plus OCR time). Show a loading indicator.

---

### 1.2 List Election Sessions Page

**Route:** `GET /election-results/sessions`

**Response:**

```json
{
  "sessions": [
    {
      "id": "uuid",
      "original_filename": "result.pdf",
      "constituency": "123 - Constituency Name",
      "total_electors": 234567,
      "status": "completed",
      "total_pages": 5,
      "processed_pages": 5,
      "created_at": "2025-01-01T00:00:00Z",
      "booth_count": "42",
      "candidate_count": "5"
    }
  ]
}
```

**Frontend Implementation:**

```jsx
// pages/admin/ElectionResultList.jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";

export default function ElectionResultList() {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    axios
      .get("/election-results/sessions", {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      })
      .then(({ data }) => setSessions(data.sessions));
  }, []);

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this election result session?")) return;
    await axios.delete(`/election-results/sessions/${id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const handleExport = (id) => {
    window.open(`/election-results/sessions/${id}/export/excel`, "_blank");
    // Note: You may need to add auth header; use fetch + blob for authenticated downloads.
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Election Results</h1>
        <Link
          to="/admin/election-results/upload"
          className="bg-blue-600 text-white px-4 py-2 rounded"
        >
          + Upload New
        </Link>
      </div>

      <div className="grid gap-4">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="bg-white rounded-lg shadow p-5 flex justify-between items-center"
          >
            <div>
              <h2 className="font-semibold text-lg">
                {s.constituency || s.original_filename}
              </h2>
              <p className="text-gray-500 text-sm">
                {s.booth_count} booths · {s.candidate_count} candidates ·{" "}
                {s.total_electors?.toLocaleString()} electors
              </p>
              <p className="text-xs text-gray-400">
                {new Date(s.created_at).toLocaleDateString()} · {s.status}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                to={`/admin/election-results/${s.id}`}
                className="text-blue-600 hover:underline"
              >
                View
              </Link>
              <button
                onClick={() => handleExport(s.id)}
                className="text-green-600 hover:underline"
              >
                Excel
              </button>
              <button
                onClick={() => handleDelete(s.id)}
                className="text-red-600 hover:underline"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### 1.3 View Election Result Details Page

**Route:** `GET /election-results/sessions/:id`

**Response:**

```json
{
  "session": {
    "id": "uuid",
    "constituency": "123 - Name",
    "total_electors": 234567,
    "original_filename": "result.pdf",
    "status": "completed",
    "total_pages": 5,
    "processed_pages": 5
  },
  "candidates": [
    { "id": 1, "candidate_name": "Candidate A", "candidate_index": 0 },
    { "id": 2, "candidate_name": "Candidate B", "candidate_index": 1 }
  ],
  "boothResults": [
    {
      "id": 1,
      "serial_no": 1,
      "booth_no": "101",
      "candidate_votes": { "Candidate A": 312, "Candidate B": 287 },
      "total_valid_votes": 599,
      "rejected_votes": 3,
      "nota": 5,
      "total_votes": 607,
      "tendered_votes": 0,
      "page_number": 1
    }
  ],
  "totals": [
    {
      "total_type": "evm",
      "candidate_votes": { "Candidate A": 15000, "Candidate B": 14200 },
      "total_valid_votes": 29200,
      "rejected_votes": 120,
      "nota": 350,
      "total_votes": 29670,
      "tendered_votes": 2
    }
  ]
}
```

**Frontend Implementation:** Build a data table that mirrors the Form 20 layout.

```jsx
// pages/admin/ElectionResultDetail.jsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

export default function ElectionResultDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    axios
      .get(`/election-results/sessions/${id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      })
      .then(({ data }) => setData(data));
  }, [id]);

  if (!data) return <p className="p-6">Loading...</p>;

  const { session, candidates, boothResults, totals } = data;
  const totalLabels = {
    evm: "EVM Votes",
    postal: "Postal Votes",
    total: "Total Votes Polled",
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-2">
        {session.constituency || session.original_filename}
      </h1>
      <p className="text-gray-500 mb-6">
        Total Electors: {session.total_electors?.toLocaleString()}
      </p>

      {/* Results Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full border text-sm text-center">
          <thead className="bg-blue-900 text-white">
            <tr>
              <th className="border px-3 py-2">Sl.</th>
              <th className="border px-3 py-2">Booth</th>
              {candidates.map((c) => (
                <th key={c.id} className="border px-3 py-2">
                  {c.candidate_name}
                </th>
              ))}
              <th className="border px-3 py-2">Valid</th>
              <th className="border px-3 py-2">Rejected</th>
              <th className="border px-3 py-2">NOTA</th>
              <th className="border px-3 py-2">Total</th>
              <th className="border px-3 py-2">Tendered</th>
            </tr>
          </thead>
          <tbody>
            {boothResults.map((booth) => (
              <tr key={booth.id} className="odd:bg-gray-50">
                <td className="border px-3 py-1">{booth.serial_no}</td>
                <td className="border px-3 py-1">{booth.booth_no}</td>
                {candidates.map((c) => (
                  <td key={c.id} className="border px-3 py-1">
                    {(
                      booth.candidate_votes?.[c.candidate_name] || 0
                    ).toLocaleString()}
                  </td>
                ))}
                <td className="border px-3 py-1">{booth.total_valid_votes}</td>
                <td className="border px-3 py-1">{booth.rejected_votes}</td>
                <td className="border px-3 py-1">{booth.nota}</td>
                <td className="border px-3 py-1 font-semibold">
                  {booth.total_votes}
                </td>
                <td className="border px-3 py-1">{booth.tendered_votes}</td>
              </tr>
            ))}

            {/* Totals rows */}
            {totals.map((t) => (
              <tr key={t.total_type} className="bg-green-50 font-bold">
                <td className="border px-3 py-1" colSpan={2}>
                  {totalLabels[t.total_type] || t.total_type}
                </td>
                {candidates.map((c) => (
                  <td key={c.id} className="border px-3 py-1">
                    {(
                      t.candidate_votes?.[c.candidate_name] || 0
                    ).toLocaleString()}
                  </td>
                ))}
                <td className="border px-3 py-1">{t.total_valid_votes}</td>
                <td className="border px-3 py-1">{t.rejected_votes}</td>
                <td className="border px-3 py-1">{t.nota}</td>
                <td className="border px-3 py-1">{t.total_votes}</td>
                <td className="border px-3 py-1">{t.tendered_votes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### 1.4 Election Statistics Page

**Route:** `GET /election-results/sessions/:id/stats`

**Response:**

```json
{
  "session": { "id": "uuid", "constituency": "..." },
  "totalBooths": 42,
  "candidateStats": [
    {
      "candidateName": "Candidate A",
      "totalVotes": 15000,
      "boothsWon": 28,
      "boothsContested": 42,
      "averageVotes": 357,
      "highestVotes": 520,
      "highestBooth": "112",
      "lowestVotes": 180,
      "lowestBooth": "135"
    }
  ],
  "totals": [...]
}
```

**Frontend:** Display candidate stat cards with bar charts or progress indicators.

```jsx
// components/CandidateStatCard.jsx
export default function CandidateStatCard({ stat, totalBooths }) {
  const winRate = ((stat.boothsWon / totalBooths) * 100).toFixed(1);
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <h3 className="font-bold text-lg mb-2">{stat.candidateName}</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-gray-500">Total Votes</span>
          <p className="font-semibold text-xl">
            {stat.totalVotes.toLocaleString()}
          </p>
        </div>
        <div>
          <span className="text-gray-500">Booths Won</span>
          <p className="font-semibold text-xl">
            {stat.boothsWon}/{totalBooths} ({winRate}%)
          </p>
        </div>
        <div>
          <span className="text-gray-500">Avg Votes/Booth</span>
          <p className="font-semibold">{stat.averageVotes}</p>
        </div>
        <div>
          <span className="text-gray-500">Best Booth</span>
          <p className="font-semibold">
            #{stat.highestBooth} ({stat.highestVotes})
          </p>
        </div>
      </div>
      {/* Win-rate progress bar */}
      <div className="mt-3 bg-gray-200 rounded-full h-2">
        <div
          className="bg-blue-600 h-2 rounded-full"
          style={{ width: `${winRate}%` }}
        />
      </div>
    </div>
  );
}
```

---

### 1.5 Excel Export (Authenticated Download)

The export endpoint returns a binary `.xlsx` file. For authenticated downloads:

```jsx
const downloadExcel = async (sessionId) => {
  const res = await fetch(
    `/election-results/sessions/${sessionId}/export/excel`,
    {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    },
  );
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `election_result_${sessionId}.xlsx`;
  a.click();
  window.URL.revokeObjectURL(url);
};
```

The generated Excel has 3 sheets:

1. **Election Results** — Full booth-wise data table with styled headers & totals
2. **Summary** — Constituency info, candidate vote totals
3. **Booth Details** — Winner/runner-up/margin per booth

---

## 📸 Feature 2: Voter Photo Display (Cloudinary)

### What Changed

- `session_voters` now has a `photo_url` column (nullable TEXT)
- During OCR, if a voter photograph is detected, the image is uploaded to Cloudinary and the URL is stored
- The URL is a Cloudinary `secure_url` (HTTPS) with auto quality/format optimization

### API Changes

All existing voter endpoints now include `photo_url` in their response:

- `GET /sessions/:id/voters` → each voter object now has `photo_url`
- `GET /admin/voters` → each voter object now has `photo_url`
- `GET /admin/voters/:id` → the voter object now has `photo_url`
- `GET /sessions/:id` → each voter in the voters array now has `photo_url`

### Frontend Implementation

Display the voter photo when available:

```jsx
// components/VoterCard.jsx
export default function VoterCard({ voter }) {
  return (
    <div className="flex items-start gap-4 bg-white rounded-lg shadow p-4">
      {/* Voter Photo */}
      <div className="flex-shrink-0 w-20 h-24 rounded overflow-hidden bg-gray-100 flex items-center justify-center">
        {voter.photo_url ? (
          <img
            src={voter.photo_url}
            alt={`Photo of ${voter.name}`}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.target.style.display = "none";
              e.target.nextSibling.style.display = "flex";
            }}
          />
        ) : null}
        <div
          className={`w-full h-full items-center justify-center text-gray-400 text-xs ${
            voter.photo_url ? "hidden" : "flex"
          }`}
        >
          No Photo
        </div>
      </div>

      {/* Voter Info */}
      <div className="flex-1">
        <h3 className="font-semibold">{voter.name}</h3>
        <p className="text-sm text-gray-600">
          {voter.relation_type}: {voter.relation_name}
        </p>
        <p className="text-sm text-gray-500">
          Voter ID: {voter.voter_id} | Age: {voter.age} | {voter.gender}
        </p>
        <p className="text-xs text-gray-400">
          House: {voter.house_number} | Section: {voter.section}
        </p>
      </div>
    </div>
  );
}
```

### In Voter Table View

Add a photo column to the voter table:

```jsx
<th className="px-3 py-2">Photo</th>
// ...
<td className="px-3 py-2">
  {voter.photo_url ? (
    <img
      src={voter.photo_url}
      alt=""
      className="w-10 h-12 object-cover rounded"
    />
  ) : (
    <span className="text-gray-300 text-xs">—</span>
  )}
</td>
```

---

## 🏢 Feature 3: Booth Name Display

### What Changed

- `sessions` table now has a `booth_name` column (nullable TEXT)
- The booth/polling station name is detected from the voter-list PDF during OCR
- It is returned in session list and detail endpoints

### API Changes

- `GET /admin/sessions` → each session now has `booth_name`
- `GET /admin/voters` → each voter row now includes `booth_name` (from the joined session)
- `GET /admin/voters/:id` → includes `booth_name`

### Frontend Implementation

Show the booth name in session cards and voter details:

```jsx
// In session list
<p className="text-sm text-gray-500">
  {session.booth_name && <>Booth: {session.booth_name} · </>}
  {session.total_pages} pages · {session.status}
</p>;

// In voter detail
{
  voter.booth_name && (
    <p className="text-sm text-gray-500">Polling Station: {voter.booth_name}</p>
  );
}
```

---

## 🗺️ Suggested Routing

Add these routes to your React Router configuration:

```jsx
import ElectionResultUpload from "./pages/admin/ElectionResultUpload";
import ElectionResultList from "./pages/admin/ElectionResultList";
import ElectionResultDetail from "./pages/admin/ElectionResultDetail";

// Inside your admin route group:
<Route path="/admin/election-results" element={<ElectionResultList />} />
<Route path="/admin/election-results/upload" element={<ElectionResultUpload />} />
<Route path="/admin/election-results/:id" element={<ElectionResultDetail />} />
```

### Navigation

Add an "Election Results" link in the admin sidebar/nav:

```jsx
<NavLink to="/admin/election-results" className="...">
  📊 Election Results
</NavLink>
```

---

## 🔐 Environment Variables Required

Add to your `.env`:

```
# Cloudinary (for voter photo uploads)
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

If not configured, voter photos are silently skipped — the system works without Cloudinary.

---

## 📋 Database Migration

Run the updated init script to create the new tables and columns:

```bash
node scripts/initDb.js
```

This will:

- Create 5 new tables: `election_sessions`, `election_pages`, `election_candidates`, `election_booth_results`, `election_totals`
- Add `booth_name` column to `sessions` (if not exists)
- Add `photo_url` column to `session_voters` (if not exists)

---

## ✅ Checklist for Frontend Dev

- [ ] Add Election Results upload page (admin only)
- [ ] Add Election Results list page with delete & export buttons
- [ ] Add Election Result detail page with booth-wise data table
- [ ] Add Election Stats view with candidate comparison cards
- [ ] Implement authenticated Excel download (fetch + blob)
- [ ] Show voter photos from `photo_url` in voter list/detail views
- [ ] Show `booth_name` in session cards and voter details
- [ ] Add routing for `/admin/election-results/*`
- [ ] Add nav link for Election Results in admin sidebar
