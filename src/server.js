import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { splitPdfToPages } from "./pdf.js";
import {
  callGeminiWithFile,
  classifyReligionByNames,
  getApiKeyStatuses,
  resetAllApiKeys,
} from "./gemini.js";
import { parseGeminiStructured } from "./parser.js";
import { pool, query } from "./db.js";

const app = express();
const port = process.env.PORT || 3000;
const storageRoot = path.join(process.cwd(), "storage");
const pageDelayMs = Number(process.env.GEMINI_PAGE_DELAY_MS || 2000);

// Parse CORS origins from environment variable
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
      .map((o) => o.trim().replace(/\/$/, "")) // Remove trailing slashes
      .filter(Boolean)
  : [];

// CORS configuration with proper origin validation for production
const corsConfig = {
  origin: function (origin, callback) {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    // Remove trailing slash from origin for comparison
    const normalizedOrigin = origin.replace(/\/$/, "");

    // If no origins specified or wildcard, allow all
    if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    // Log blocked origin for debugging
    console.log(`CORS blocked origin: ${origin}`);
    console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);

    callback(new Error(`CORS not allowed for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Requested-With",
  ],
  credentials: true,
  optionsSuccessStatus: 200, // Some legacy browsers choke on 204
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig));
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
  maybeAdd(params.religion, "religion");

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
    const apiKey = req.body?.apiKey || req.body?.geminiApiKey;

    if (!pdfPath) {
      return res.status(400).json({ error: "PDF file is required" });
    }

    // API key is now optional - will use fallback keys
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

      let lastKeyUsed = null;
      let keySwitchCount = 0;

      for (const [idx, pagePath] of pagePaths.entries()) {
        try {
          const { text, keyUsed } = await callGeminiWithFile(pagePath, apiKey);

          // Track key switches
          if (lastKeyUsed && keyUsed !== lastKeyUsed) {
            keySwitchCount++;
            console.log(
              `Key switched during processing (switch #${keySwitchCount})`
            );
          }
          lastKeyUsed = keyUsed;

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

          // Classify religion for all voters on this page
          let religions = [];
          if (voters.length > 0) {
            const religionResult = await classifyReligionByNames(
              voters,
              apiKey
            );
            religions = religionResult.religions;
          }

          for (let i = 0; i < voters.length; i++) {
            const voter = voters[i];
            const religion = religions[i] || "Other";
            const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
            const age = Number.isNaN(ageValue) ? null : ageValue;

            await query(
              "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
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
                religion,
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
        } catch (pageErr) {
          // If all keys exhausted, mark session as paused (can be resumed later)
          if (pageErr.message.includes("ALL_KEYS_EXHAUSTED")) {
            await query(
              "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
              ["paused", sessionId]
            );
            return res.status(429).json({
              error: "All API keys exhausted",
              sessionId,
              processed_pages: idx,
              total_pages: pagePaths.length,
              message:
                "Session paused. Use POST /sessions/:id/resume to continue when keys are available.",
              apiKeyStatus: getApiKeyStatuses(),
            });
          }
          throw pageErr;
        }
      }

      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["completed", sessionId]
      );

      res.status(201).json({
        sessionId,
        pages: pagePaths.length,
        status: "completed",
        keySwitchCount,
      });
    } catch (err) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["failed", sessionId]
      ).catch(() => {});
      console.error("Session processing failed:", err.message);
      res.status(500).json({
        error: "Processing failed",
        details: err.message,
        apiKeyStatus: getApiKeyStatuses(),
      });
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
    "SELECT page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, created_at FROM session_voters WHERE session_id=$1 ORDER BY page_number, serial_number",
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
    SELECT page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, created_at
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
    SELECT session_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY created_at DESC, session_id, page_number, serial_number
    LIMIT 500;
  `;
  const result = await query(sql, values);
  res.json({ voters: result.rows });
});

app.get("/sessions/:id/stats/religion", async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT 1 FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const sql = `
    SELECT religion, COUNT(*)::int AS count
    FROM session_voters
    WHERE session_id = $1
    GROUP BY religion
    ORDER BY count DESC;
  `;
  const result = await query(sql, [id]);

  const total = result.rows.reduce((sum, row) => sum + row.count, 0);
  const stats = result.rows.map((row) => ({
    religion: row.religion,
    count: row.count,
    percentage: total > 0 ? ((row.count / total) * 100).toFixed(2) : "0.00",
  }));

  res.json({ sessionId: id, total, stats });
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

// Debug endpoint to check CORS configuration
app.get("/debug/cors", (req, res) => {
  res.json({
    configuredOrigins: allowedOrigins,
    requestOrigin: req.get("origin") || "none",
    env: process.env.CORS_ORIGINS || "not set",
  });
});

// API Key status endpoint
app.get("/api-keys/status", (_req, res) => {
  const status = getApiKeyStatuses();
  res.json(status);
});

// Reset all API keys (useful when quota resets daily)
app.post("/api-keys/reset", (_req, res) => {
  const status = resetAllApiKeys();
  res.json({ message: "All API keys have been reset to active", ...status });
});

// Resume a paused session
app.post("/sessions/:id/resume", async (req, res) => {
  const { id } = req.params;
  const apiKey = req.body?.apiKey || req.body?.geminiApiKey;

  try {
    // Check if session exists and is paused or failed
    const sessionRes = await query(
      "SELECT id, status, total_pages, processed_pages, original_filename FROM sessions WHERE id=$1",
      [id]
    );

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionRes.rows[0];

    if (session.status === "completed") {
      return res
        .status(400)
        .json({ error: "Session already completed", session });
    }

    if (session.status === "processing") {
      return res
        .status(400)
        .json({ error: "Session is already processing", session });
    }

    // Check API key availability
    const keyStatus = getApiKeyStatuses();
    if (keyStatus.allExhausted && !apiKey) {
      return res.status(429).json({
        error: "All API keys exhausted",
        message: "Please provide an API key or wait for quota reset",
        apiKeyStatus: keyStatus,
      });
    }

    // Get already processed page numbers
    const processedPagesRes = await query(
      "SELECT page_number FROM session_pages WHERE session_id=$1",
      [id]
    );
    const processedPageNumbers = new Set(
      processedPagesRes.rows.map((r) => r.page_number)
    );

    // Get page files from storage
    const pageDir = path.join(storageRoot, id, "pages");
    const pageFiles = await fs.readdir(pageDir);
    const pagePaths = pageFiles
      .filter(
        (f) =>
          f.endsWith(".png") ||
          f.endsWith(".jpg") ||
          f.endsWith(".jpeg") ||
          f.endsWith(".pdf")
      )
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)?.[0] || "0");
        const numB = parseInt(b.match(/\d+/)?.[0] || "0");
        return numA - numB;
      })
      .map((f) => path.join(pageDir, f));

    // Update session status to processing
    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "processing",
      id,
    ]);

    let resumedFromPage = session.processed_pages;
    let keySwitchCount = 0;
    let lastKeyUsed = null;

    // Process remaining pages
    for (const [idx, pagePath] of pagePaths.entries()) {
      const pageNumber = idx + 1;

      // Skip already processed pages
      if (processedPageNumbers.has(pageNumber)) {
        continue;
      }

      try {
        const { text, keyUsed } = await callGeminiWithFile(pagePath, apiKey);

        if (lastKeyUsed && keyUsed !== lastKeyUsed) {
          keySwitchCount++;
        }
        lastKeyUsed = keyUsed;

        const structured = parseGeminiStructured(text);
        const pageRes = await query(
          "INSERT INTO session_pages (session_id, page_number, page_path, raw_text, structured_json) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [id, pageNumber, pagePath, text, structured]
        );

        const pageId = pageRes.rows[0].id;
        const assembly = structured.assembly || "";
        const partNumber = structured.partNumber || "";
        const section = structured.section || "";
        const voters = Array.isArray(structured.voters)
          ? structured.voters
          : [];

        let religions = [];
        if (voters.length > 0) {
          const religionResult = await classifyReligionByNames(voters, apiKey);
          religions = religionResult.religions;
        }

        for (let i = 0; i < voters.length; i++) {
          const voter = voters[i];
          const religion = religions[i] || "Other";
          const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
          const age = Number.isNaN(ageValue) ? null : ageValue;

          await query(
            "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
            [
              id,
              pageId,
              pageNumber,
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
              religion,
            ]
          );
        }

        await query(
          "UPDATE sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
          [pageNumber, id]
        );

        if (pageDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
        }
      } catch (pageErr) {
        if (pageErr.message.includes("ALL_KEYS_EXHAUSTED")) {
          await query(
            "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
            ["paused", id]
          );
          return res.status(429).json({
            error: "All API keys exhausted",
            sessionId: id,
            processed_pages: pageNumber - 1,
            total_pages: pagePaths.length,
            resumed_from: resumedFromPage,
            message: "Session paused again. Resume when keys are available.",
            apiKeyStatus: getApiKeyStatuses(),
          });
        }
        throw pageErr;
      }
    }

    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "completed",
      id,
    ]);

    res.json({
      message: "Session resumed and completed",
      sessionId: id,
      resumed_from_page: resumedFromPage,
      total_pages: pagePaths.length,
      status: "completed",
      keySwitchCount,
    });
  } catch (err) {
    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "failed",
      id,
    ]).catch(() => {});
    console.error("Resume failed:", err.message);
    res.status(500).json({
      error: "Resume failed",
      details: err.message,
      apiKeyStatus: getApiKeyStatuses(),
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

process.on("SIGINT", () => {
  pool.end().then(() => process.exit(0));
});
