import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { splitPdfToPages } from "./pdf.js";
import { callGeminiWithFile } from "./gemini.js";
import { parseGeminiStructured } from "./parser.js";
import { pool, query } from "./db.js";

const app = express();
const port = process.env.PORT || 3000;
const storageRoot = path.join(process.cwd(), "storage");
const pageDelayMs = Number(process.env.GEMINI_PAGE_DELAY_MS || 2000);

app.use(express.json({ limit: "1mb" }));

function sessionIdMiddleware(req, _res, next) {
  req.sessionId = uuidv4();
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const sessionId = req.sessionId || uuidv4();
      req.sessionId = sessionId;
      const dest = path.join(storageRoot, sessionId, "pdf");
      try {
        fs.ensureDirSync(dest);
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      cb(null, file.originalname || "original.pdf");
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF uploads are allowed"));
    } else {
      cb(null, true);
    }
  },
  limits: { fileSize: 25 * 1024 * 1024 },
});

function buildVoterFilter(params, startIndex = 1) {
  const where = [];
  const values = [];
  let idx = startIndex;

  if (params.sessionId) {
    where.push(`session_id = $${idx}`);
    values.push(params.sessionId);
    idx += 1;
  }

  const maybeAdd = (field, column, comparator = "=") => {
    if (field !== undefined && field !== "") {
      where.push(`${column} ${comparator} $${idx}`);
      values.push(field);
      idx += 1;
    }
  };

  if (params.name) {
    where.push(`LOWER(name) LIKE $${idx}`);
    values.push(`%${params.name.toLowerCase()}%`);
    idx += 1;
  }

  maybeAdd(params.voterId, "voter_id");
  maybeAdd(
    params.gender ? params.gender.toLowerCase() : undefined,
    "LOWER(gender)",
    "="
  );
  maybeAdd(params.houseNumber, "house_number");
  maybeAdd(params.relationType, "relation_type");
  maybeAdd(params.partNumber, "part_number");
  maybeAdd(params.section, "section");
  maybeAdd(params.assembly, "assembly");
  maybeAdd(params.serialNumber, "serial_number");

  if (params.minAge !== undefined && params.minAge !== "") {
    const val = Number(params.minAge);
    if (!Number.isNaN(val)) {
      where.push(`age >= $${idx}`);
      values.push(val);
      idx += 1;
    }
  }
  if (params.maxAge !== undefined && params.maxAge !== "") {
    const val = Number(params.maxAge);
    if (!Number.isNaN(val)) {
      where.push(`age <= $${idx}`);
      values.push(val);
      idx += 1;
    }
  }

  return { where, values };
}

app.post(
  "/sessions",
  sessionIdMiddleware,
  upload.single("file"),
  async (req, res) => {
    const sessionId = req.sessionId;
    const pdfPath = req.file?.path;
    const originalName = req.file?.originalname || "upload.pdf";

    if (!pdfPath) {
      return res.status(400).json({ error: "PDF file is required" });
    }

    try {
      await query(
        "INSERT INTO sessions (id, original_filename, status, processed_pages) VALUES ($1, $2, $3, $4)",
        [sessionId, originalName, "processing", 0]
      );

      const pageDir = path.join(storageRoot, sessionId, "pages");
      const pagePaths = await splitPdfToPages(pdfPath, pageDir);
      await query(
        "UPDATE sessions SET total_pages=$1, processed_pages=0, updated_at=now() WHERE id=$2",
        [pagePaths.length, sessionId]
      );

      for (const [idx, pagePath] of pagePaths.entries()) {
        const { text } = await callGeminiWithFile(pagePath);
        const structured = parseGeminiStructured(text);
        const pageRes = await query(
          "INSERT INTO session_pages (session_id, page_number, page_path, raw_text, structured_json) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [sessionId, idx + 1, pagePath, text, structured]
        );

        const pageId = pageRes.rows[0].id;
        const assembly = structured.assembly || "";
        const partNumber = structured.partNumber || "";
        const section = structured.section || "";
        const voters = Array.isArray(structured.voters)
          ? structured.voters
          : [];

        for (const voter of voters) {
          const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
          const age = Number.isNaN(ageValue) ? null : ageValue;

          await query(
            "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
            [
              sessionId,
              pageId,
              idx + 1,
              assembly,
              partNumber,
              section,
              voter.serialNumber || "",
              voter.voterId || "",
              voter.name || "",
              voter.relationType || "",
              voter.relationName || "",
              voter.houseNumber || "",
              age,
              voter.gender || "",
            ]
          );
        }

        await query(
          "UPDATE sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
          [idx + 1, sessionId]
        );

        if (pageDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
        }
      }

      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["completed", sessionId]
      );

      res
        .status(201)
        .json({ sessionId, pages: pagePaths.length, status: "completed" });
    } catch (err) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["failed", sessionId]
      ).catch(() => {});
      console.error("Session processing failed:", err.message);
      res
        .status(500)
        .json({ error: "Processing failed", details: err.message });
    }
  }
);

app.get("/sessions", async (_req, res) => {
  const sql = `
    SELECT s.id, s.original_filename, s.status, s.total_pages, s.processed_pages, s.created_at, s.updated_at,
           COUNT(DISTINCT p.id) AS page_count,
           COUNT(v.id) AS voter_count
    FROM sessions s
    LEFT JOIN session_pages p ON p.session_id = s.id
    LEFT JOIN session_voters v ON v.session_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC;
  `;
  const result = await query(sql);
  res.json({ sessions: result.rows });
});

app.get("/sessions/:id/status", async (req, res) => {
  const { id } = req.params;
  const session = await query(
    "SELECT id, status, total_pages, processed_pages, created_at, updated_at FROM sessions WHERE id=$1",
    [id]
  );
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const pages = await query(
    "SELECT COUNT(*)::int AS pages_done, COALESCE(MAX(page_number), 0) AS last_page FROM session_pages WHERE session_id=$1",
    [id]
  );
  const voters = await query(
    "SELECT COUNT(*)::int AS voter_count FROM session_voters WHERE session_id=$1",
    [id]
  );

  const { status, total_pages, processed_pages, created_at, updated_at } =
    session.rows[0];
  const pages_done = pages.rows[0].pages_done;
  const last_page_processed = pages.rows[0].last_page;
  const voter_count = voters.rows[0].voter_count;
  const current_page =
    status === "processing" && total_pages
      ? Math.min(processed_pages + 1, total_pages)
      : null;

  res.json({
    sessionId: id,
    status,
    total_pages,
    processed_pages,
    pages_done,
    last_page_processed,
    current_page,
    voter_count,
    created_at,
    updated_at,
  });
});

app.get("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT * FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const pages = await query(
    "SELECT page_number, page_path, raw_text, structured_json, created_at FROM session_pages WHERE session_id=$1 ORDER BY page_number ASC",
    [id]
  );

  const voters = await query(
    "SELECT page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, created_at FROM session_voters WHERE session_id=$1 ORDER BY page_number, serial_number",
    [id]
  );

  res.json({
    session: session.rows[0],
    pages: pages.rows,
    voters: voters.rows,
  });
});

app.get("/sessions/:id/voters", async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT 1 FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { where, values } = buildVoterFilter({ ...req.query, sessionId: id });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY page_number, serial_number;
  `;
  const result = await query(sql, values);
  res.json({ voters: result.rows });
});

app.get("/voters/search", async (req, res) => {
  const { where, values } = buildVoterFilter({ ...req.query });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT session_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY created_at DESC, session_id, page_number, serial_number
    LIMIT 500;
  `;
  const result = await query(sql, values);
  res.json({ voters: result.rows });
});

app.delete("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const deleted = await query("DELETE FROM sessions WHERE id=$1 RETURNING id", [
    id,
  ]);
  if (deleted.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const dir = path.join(storageRoot, id);
  await fs.remove(dir);

  res.json({ deleted: id });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

process.on("SIGINT", () => {
  pool.end().then(() => process.exit(0));
});
