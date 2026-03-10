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
  initializeKeyStatus,
  processPagesBatch,
  chatWithGemini,
  getAvailableEngines,
} from "./gemini.js";
import { parseGeminiStructured } from "./parser.js";
import { pool, query } from "./db.js";
import { authenticate, adminOnly } from "./auth.js";
import {
  processAgentQuery,
  getAgentStatus,
  getQuickSuggestions,
  getUserPermissions,
} from "./agent.js";

// Import route modules
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/admin.js";
import userRoutes from "./routes/user.js";
import electionResultRoutes from "./routes/electionResults.js";
import affidavitRoutes from "./routes/affidavit.js";
import {
  isCloudinaryConfigured,
  uploadBase64Image,
  extractVoterPhotosFromPage,
} from "./cloudinary.js";

/**
 * Sanitize voter ID: if it contains slashes (like WB/01/003/000070) it's
 * a location code, not a real EPIC number. Replace it with empty string
 * so the voter is stored without a fake ID.
 */
function sanitizeVoterId(rawId) {
  if (!rawId) return "";
  const trimmed = rawId.trim();
  // EPIC numbers are alphanumeric without slashes (e.g. XFB2313997)
  if (trimmed.includes("/")) return "";
  return trimmed;
}

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

// Mount route modules
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/user", userRoutes);
app.use("/election-results", electionResultRoutes);
app.use("/affidavits", affidavitRoutes);

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
  limits: { fileSize: 50 * 1024 * 1024 },
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
    "=",
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

// Session upload - Admin only
app.post(
  "/sessions",
  authenticate,
  adminOnly,
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
        [sessionId, originalName, "processing", 0],
      );

      const pageDir = path.join(storageRoot, sessionId, "pages");
      const pagePaths = await splitPdfToPages(pdfPath, pageDir);
      await query(
        "UPDATE sessions SET total_pages=$1, processed_pages=0, updated_at=now() WHERE id=$2",
        [pagePaths.length, sessionId],
      );

      console.log(
        `📄 Processing ${pagePaths.length} pages with parallel engines...`,
      );

      // Track progress
      let processedCount = 0;
      let errorCount = 0;
      let keySwitchCount = 0;
      let lastKeyUsed = null;

      // Process pages and save to database immediately on completion
      const savePageToDatabase = async (pageIndex, result, pagePath) => {
        const { text, keyUsed } = result;

        if (lastKeyUsed && keyUsed !== lastKeyUsed) {
          keySwitchCount++;
        }
        lastKeyUsed = keyUsed;

        const structured = parseGeminiStructured(text);

        // Extract booth name from the first page and save to session
        if (pageIndex === 0 && structured.boothName) {
          await query(
            "UPDATE sessions SET booth_name=$1, updated_at=now() WHERE id=$2",
            [structured.boothName, sessionId],
          );
          console.log(`🏫 Booth name detected: ${structured.boothName}`);
        }

        const pageRes = await query(
          "INSERT INTO session_pages (session_id, page_number, page_path, raw_text, structured_json) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [sessionId, pageIndex + 1, pagePath, text, structured],
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
          const religionResult = await classifyReligionByNames(voters, apiKey);
          religions = religionResult.religions;
        }

        // Extract voter photos from the page PDF via Cloudinary
        let photoMap = new Map();
        if (isCloudinaryConfigured() && voters.some((v) => v.hasPhoto)) {
          try {
            photoMap = await extractVoterPhotosFromPage(
              pagePath,
              voters,
              sessionId,
              pageIndex + 1,
            );
          } catch (photoErr) {
            console.warn(
              `⚠️ Photo extraction failed for page ${pageIndex + 1}: ${photoErr.message}`,
            );
          }
        }

        for (let i = 0; i < voters.length; i++) {
          const voter = voters[i];
          const religion = religions[i] || "Other";
          const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
          const age = Number.isNaN(ageValue) ? null : ageValue;

          // Get photo URL from extraction (or fallback to base64 upload if somehow available)
          let photoUrl = photoMap.get(i) || null;
          if (
            !photoUrl &&
            voter.hasPhoto &&
            voter.photoBase64 &&
            isCloudinaryConfigured()
          ) {
            try {
              const cloudResult = await uploadBase64Image(voter.photoBase64, {
                folder: `voter-list/${sessionId}`,
                publicId: `voter_${voter.voterId || voter.serialNumber || i}`,
              });
              photoUrl = cloudResult?.secure_url || null;
            } catch (photoErr) {
              console.warn(
                `⚠️ Photo upload failed for voter ${voter.name}: ${photoErr.message}`,
              );
            }
          }

          const cleanVoterId = sanitizeVoterId(voter.voterId);

          await query(
            "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, photo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
            [
              sessionId,
              pageId,
              pageIndex + 1,
              assembly,
              partNumber,
              section,
              voter.serialNumber || "",
              cleanVoterId,
              voter.name || "",
              voter.relationType || "",
              voter.relationName || "",
              voter.houseNumber || "",
              age,
              voter.gender || "",
              religion,
              photoUrl,
            ],
          );
        }

        processedCount++;
        await query(
          "UPDATE sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
          [processedCount, sessionId],
        );

        console.log(
          `✅ Page ${pageIndex + 1}/${pagePaths.length} saved to database (${
            voters.length
          } voters)`,
        );
      };

      // Use sequential batch processing with immediate database saves
      const batchResult = await processPagesBatch(
        pagePaths,
        0,
        async (progress) => {
          if (progress.type === "page_complete" && progress.result) {
            try {
              await savePageToDatabase(
                progress.pageIndex,
                progress.result,
                progress.pagePath,
              );
            } catch (err) {
              console.error(
                `Failed to save page ${progress.pageIndex + 1}:`,
                err.message,
              );
              errorCount++;
            }
          }
        },
      );

      // Check final status
      const finalStatus = await query(
        "SELECT processed_pages FROM sessions WHERE id=$1",
        [sessionId],
      );
      const finalProcessed = finalStatus.rows[0]?.processed_pages || 0;

      console.log(
        `📊 Session ${sessionId}: ${finalProcessed}/${pagePaths.length} pages processed, ${errorCount} errors`,
      );

      if (finalProcessed < pagePaths.length || errorCount > 0) {
        await query(
          "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
          ["paused", sessionId],
        );

        return res.status(207).json({
          sessionId,
          pages: pagePaths.length,
          processedPages: finalProcessed,
          errorPages: errorCount,
          status: "paused",
          message:
            "Session partially completed. Use POST /sessions/:id/resume to continue.",
          keySwitchCount,
          apiKeyStatus: getApiKeyStatuses(),
        });
      }

      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["completed", sessionId],
      );

      res.status(201).json({
        sessionId,
        pages: pagePaths.length,
        status: "completed",
        keySwitchCount,
        apiKeyStatus: getApiKeyStatuses(),
      });
    } catch (err) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["failed", sessionId],
      ).catch(() => {});
      console.error("Session processing failed:", err.message);
      res.status(500).json({
        error: "Processing failed",
        details: err.message,
        apiKeyStatus: getApiKeyStatuses(),
      });
    }
  },
);

// Sessions list - Admin only
app.get("/sessions", authenticate, adminOnly, async (_req, res) => {
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

// Session status - Admin only
app.get("/sessions/:id/status", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const session = await query(
    "SELECT id, status, total_pages, processed_pages, created_at, updated_at FROM sessions WHERE id=$1",
    [id],
  );
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const pages = await query(
    "SELECT COUNT(*)::int AS pages_done, COALESCE(MAX(page_number), 0) AS last_page FROM session_pages WHERE session_id=$1",
    [id],
  );
  const voters = await query(
    "SELECT COUNT(*)::int AS voter_count FROM session_voters WHERE session_id=$1",
    [id],
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

// Session detail - Admin only
app.get("/sessions/:id", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT * FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const pages = await query(
    "SELECT page_number, page_path, raw_text, structured_json, created_at FROM session_pages WHERE session_id=$1 ORDER BY page_number ASC",
    [id],
  );

  const voters = await query(
    "SELECT id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, photo_url, is_printed, printed_at, created_at FROM session_voters WHERE session_id=$1 ORDER BY page_number, serial_number",
    [id],
  );

  res.json({
    session: session.rows[0],
    pages: pages.rows,
    voters: voters.rows,
  });
});

// Session voters - Admin only
app.get("/sessions/:id/voters", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT 1 FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { where, values } = buildVoterFilter({ ...req.query, sessionId: id });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, photo_url, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY page_number, serial_number;
  `;
  const result = await query(sql, values);
  res.json({ voters: result.rows });
});

// Admin: Global voters search with full filtering
app.get("/voters/search", authenticate, adminOnly, async (req, res) => {
  const { where, values } = buildVoterFilter({ ...req.query });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT id, session_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, is_printed, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY created_at DESC, session_id, page_number, serial_number
    LIMIT 500;
  `;
  const result = await query(sql, values);
  res.json({ voters: result.rows });
});

// Session religion stats - Admin only
app.get(
  "/sessions/:id/stats/religion",
  authenticate,
  adminOnly,
  async (req, res) => {
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
  },
);

// Delete session - Admin only
app.delete("/sessions/:id", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const deleted = await query("DELETE FROM sessions WHERE id=$1 RETURNING id", [
    id,
  ]);
  if (deleted.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const dir = path.join(storageRoot, id);
  await fs.remove(dir);

  res.json({ deleted: id, message: "Session and all associated data deleted" });
});

// Rename session - Admin only
app.patch("/sessions/:id/rename", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "Name is required" });
  }

  const updated = await query(
    "UPDATE sessions SET original_filename=$1, updated_at=now() WHERE id=$2 RETURNING id, original_filename",
    [name.trim(), id],
  );

  if (updated.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    sessionId: id,
    name: updated.rows[0].original_filename,
    message: "Session renamed successfully",
  });
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

// API Key status endpoint - Admin only
app.get("/api-keys/status", authenticate, adminOnly, (_req, res) => {
  const status = getApiKeyStatuses();
  res.json(status);
});

// Reset all API keys (useful when quota resets daily) - Admin only
app.post("/api-keys/reset", authenticate, adminOnly, (_req, res) => {
  const status = resetAllApiKeys();
  res.json({ message: "All API keys have been reset to active", ...status });
});

// Stop/Cancel a processing session - Admin only
app.post("/sessions/:id/stop", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    const sessionRes = await query(
      "SELECT id, status, total_pages, processed_pages FROM sessions WHERE id=$1",
      [id],
    );

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionRes.rows[0];

    if (session.status !== "processing") {
      return res.status(400).json({
        error: "Session is not currently processing",
        currentStatus: session.status,
      });
    }

    // Update session status to paused
    await query(
      "UPDATE sessions SET status='paused', updated_at=now() WHERE id=$1",
      [id],
    );

    console.log(`🛑 Session ${id} stopped by user`);

    res.json({
      message: "Session processing stopped",
      sessionId: id,
      status: "paused",
      processed_pages: session.processed_pages,
      total_pages: session.total_pages,
      canResume: true,
    });
  } catch (err) {
    console.error("Stop session failed:", err.message);
    res
      .status(500)
      .json({ error: "Failed to stop session", details: err.message });
  }
});

// Resume a paused session - Admin only
app.post("/sessions/:id/resume", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const apiKey = req.body?.apiKey || req.body?.geminiApiKey;

  try {
    // Check if session exists and is paused or failed
    const sessionRes = await query(
      "SELECT id, status, total_pages, processed_pages, original_filename FROM sessions WHERE id=$1",
      [id],
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
      [id],
    );
    const processedPageNumbers = new Set(
      processedPagesRes.rows.map((r) => r.page_number),
    );

    // Get page files from storage
    const pageDir = path.join(storageRoot, id, "pages");
    const pageFiles = await fs.readdir(pageDir);
    const allPagePaths = pageFiles
      .filter(
        (f) =>
          f.endsWith(".png") ||
          f.endsWith(".jpg") ||
          f.endsWith(".jpeg") ||
          f.endsWith(".pdf"),
      )
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)?.[0] || "0");
        const numB = parseInt(b.match(/\d+/)?.[0] || "0");
        return numA - numB;
      })
      .map((f, idx) => ({ path: path.join(pageDir, f), pageNumber: idx + 1 }));

    // Filter out already processed pages
    const remainingPages = allPagePaths.filter(
      (p) => !processedPageNumbers.has(p.pageNumber),
    );

    if (remainingPages.length === 0) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["completed", id],
      );
      return res.json({
        message: "Session already completed",
        sessionId: id,
        status: "completed",
      });
    }

    // Update session status to processing
    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "processing",
      id,
    ]);

    let resumedFromPage = session.processed_pages;
    console.log(
      `📄 Resuming ${remainingPages.length} remaining pages with parallel engines...`,
    );

    // Use parallel batch processing with IMMEDIATE database saves
    const pagePaths = remainingPages.map((p) => p.path);
    const pageNumberMap = new Map(
      remainingPages.map((p) => [p.path, p.pageNumber]),
    );

    let keySwitchCount = 0;
    let lastKeyUsed = null;
    let processedCount = session.processed_pages || 0;

    // Save page to database immediately when completed
    const savePageToDatabase = async (pagePath, result) => {
      const { text, keyUsed } = result;
      const pageNumber = pageNumberMap.get(pagePath);

      if (lastKeyUsed && keyUsed !== lastKeyUsed) {
        keySwitchCount++;
      }
      lastKeyUsed = keyUsed;

      const structured = parseGeminiStructured(text);

      // Extract booth name from the first page and save to session
      if (pageNumber === 1 && structured.boothName) {
        await query(
          "UPDATE sessions SET booth_name=$1, updated_at=now() WHERE id=$2",
          [structured.boothName, id],
        );
        console.log(`🏫 Booth name detected: ${structured.boothName}`);
      }

      const pageRes = await query(
        "INSERT INTO session_pages (session_id, page_number, page_path, raw_text, structured_json) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [id, pageNumber, pagePath, text, structured],
      );

      const pageId = pageRes.rows[0].id;
      const assembly = structured.assembly || "";
      const partNumber = structured.partNumber || "";
      const section = structured.section || "";
      const voters = Array.isArray(structured.voters) ? structured.voters : [];

      let religions = [];
      if (voters.length > 0) {
        const religionResult = await classifyReligionByNames(voters, apiKey);
        religions = religionResult.religions;
      }

      // Extract voter photos from the page PDF via Cloudinary
      let photoMap = new Map();
      if (isCloudinaryConfigured() && voters.some((v) => v.hasPhoto)) {
        try {
          photoMap = await extractVoterPhotosFromPage(
            pagePath,
            voters,
            id,
            pageNumber,
          );
        } catch (photoErr) {
          console.warn(
            `⚠️ Photo extraction failed for page ${pageNumber}: ${photoErr.message}`,
          );
        }
      }

      for (let i = 0; i < voters.length; i++) {
        const voter = voters[i];
        const religion = religions[i] || "Other";
        const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
        const age = Number.isNaN(ageValue) ? null : ageValue;

        // Get photo URL from extraction
        let photoUrl = photoMap.get(i) || null;
        if (
          !photoUrl &&
          voter.hasPhoto &&
          voter.photoBase64 &&
          isCloudinaryConfigured()
        ) {
          try {
            const cloudResult = await uploadBase64Image(voter.photoBase64, {
              folder: `voter-list/${id}`,
              publicId: `voter_${voter.voterId || voter.serialNumber || i}`,
            });
            photoUrl = cloudResult?.secure_url || null;
          } catch (photoErr) {
            console.warn(`⚠️ Photo upload failed: ${photoErr.message}`);
          }
        }

        const cleanVoterId = sanitizeVoterId(voter.voterId);

        await query(
          "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, photo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
          [
            id,
            pageId,
            pageNumber,
            assembly,
            partNumber,
            section,
            voter.serialNumber || "",
            cleanVoterId,
            voter.name || "",
            voter.relationType || "",
            voter.relationName || "",
            voter.houseNumber || "",
            age,
            voter.gender || "",
            religion,
            photoUrl,
          ],
        );
      }

      processedCount++;
      await query(
        "UPDATE sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
        [processedCount, id],
      );

      console.log(
        `✅ Resume: Page ${pageNumber} saved to DB (${voters.length} voters)`,
      );
    };

    const batchResult = await processPagesBatch(
      pagePaths,
      0,
      async (progress) => {
        if (progress.type === "page_complete" && progress.result) {
          try {
            await savePageToDatabase(progress.pagePath, progress.result);
          } catch (err) {
            console.error(`Failed to save page during resume:`, err.message);
          }
        }
      },
    );

    // Check for errors
    if (
      batchResult.errors.length > 0 &&
      batchResult.processedCount < remainingPages.length
    ) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["paused", id],
      );
      return res.status(207).json({
        message: "Session partially resumed",
        sessionId: id,
        resumed_from_page: resumedFromPage,
        processed_in_resume: batchResult.processedCount,
        errors: batchResult.errors.length,
        total_remaining: remainingPages.length,
        status: "paused",
        keySwitchCount,
        apiKeyStatus: getApiKeyStatuses(),
      });
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

// ============================================
// CHATBOT ENDPOINT - Agentic NLP Interface
// ============================================

/**
 * Intelligent Chatbot - Understands natural language and executes actions
 * Supports both user and admin actions based on role
 */
app.post("/chat", authenticate, async (req, res) => {
  const { message, conversationHistory = [] } = req.body;
  const userRole = req.user.role;
  const isAdmin = userRole === "admin";

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    // Get NLP response from Gemini
    const nlpResponse = await chatWithGemini(message, {
      userRole,
      isAdmin,
      conversationHistory,
    });

    let actionResult = null;
    let actionExecuted = false;

    // Execute action based on detected intent
    if (nlpResponse.action) {
      try {
        switch (nlpResponse.action) {
          case "SEARCH_VOTERS": {
            const params = nlpResponse.actionParams || {};
            const where = [];
            const values = [];
            let idx = 1;

            if (params.name) {
              where.push(`LOWER(name) LIKE $${idx}`);
              values.push(`%${params.name.toLowerCase()}%`);
              idx++;
            }
            if (params.voterId) {
              where.push(`voter_id = $${idx}`);
              values.push(params.voterId);
              idx++;
            }
            if (params.assembly) {
              where.push(`LOWER(assembly) LIKE $${idx}`);
              values.push(`%${params.assembly.toLowerCase()}%`);
              idx++;
            }
            if (params.partNumber) {
              where.push(`part_number = $${idx}`);
              values.push(params.partNumber);
              idx++;
            }

            const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
            const sql = `
              SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
                     relation_type, relation_name, house_number, age, gender
              FROM session_voters
              ${whereSql}
              ORDER BY assembly, part_number, serial_number
              LIMIT 20;
            `;
            const result = await query(sql, values);
            actionResult = {
              type: "voters",
              data: result.rows,
              count: result.rowCount,
            };
            actionExecuted = true;
            break;
          }

          case "VIEW_SESSIONS": {
            if (!isAdmin) {
              actionResult = {
                type: "error",
                message: "Admin access required to view sessions",
              };
            } else {
              const sql = `
                SELECT id, original_filename, status, total_pages, processed_pages, created_at
                FROM sessions
                ORDER BY created_at DESC
                LIMIT 10;
              `;
              const result = await query(sql);
              actionResult = {
                type: "sessions",
                data: result.rows,
                count: result.rowCount,
              };
              actionExecuted = true;
            }
            break;
          }

          case "VIEW_STATS": {
            const statsType = nlpResponse.actionParams?.type || "religion";
            let sql;

            if (statsType === "gender") {
              sql = `
                SELECT gender, COUNT(*)::int AS count
                FROM session_voters
                GROUP BY gender
                ORDER BY count DESC;
              `;
            } else {
              sql = `
                SELECT religion, COUNT(*)::int AS count
                FROM session_voters
                GROUP BY religion
                ORDER BY count DESC;
              `;
            }

            const result = await query(sql);
            const total = result.rows.reduce((sum, row) => sum + row.count, 0);
            actionResult = {
              type: "stats",
              statsType,
              data: result.rows.map((row) => ({
                ...row,
                percentage:
                  total > 0 ? ((row.count / total) * 100).toFixed(2) : "0.00",
              })),
              total,
            };
            actionExecuted = true;
            break;
          }

          case "VIEW_API_STATUS": {
            if (!isAdmin) {
              actionResult = {
                type: "error",
                message: "Admin access required to view API status",
              };
            } else {
              actionResult = {
                type: "api_status",
                data: getApiKeyStatuses(),
              };
              actionExecuted = true;
            }
            break;
          }

          case "RESET_API_KEYS": {
            if (!isAdmin) {
              actionResult = {
                type: "error",
                message: "Admin access required to reset API keys",
              };
            } else {
              const status = resetAllApiKeys();
              actionResult = {
                type: "api_reset",
                data: status,
                message: "All API keys have been reset to active status",
              };
              actionExecuted = true;
            }
            break;
          }

          case "VIEW_PROFILE": {
            const result = await query(
              "SELECT id, email, name, phone, role, created_at FROM users WHERE id = $1",
              [req.user.id],
            );
            actionResult = {
              type: "profile",
              data: result.rows[0],
            };
            actionExecuted = true;
            break;
          }

          case "VIEW_ASSEMBLIES": {
            const sql = `
              SELECT DISTINCT assembly, COUNT(*)::int as voter_count
              FROM session_voters
              WHERE assembly IS NOT NULL AND assembly != ''
              GROUP BY assembly
              ORDER BY voter_count DESC
              LIMIT 20;
            `;
            const result = await query(sql);
            actionResult = {
              type: "assemblies",
              data: result.rows,
              count: result.rowCount,
            };
            actionExecuted = true;
            break;
          }

          default:
            actionResult = null;
        }
      } catch (actionErr) {
        console.error("Action execution error:", actionErr);
        actionResult = {
          type: "error",
          message: actionErr.message,
        };
      }
    }

    // Format response with markdown tables if we have data
    let formattedResponse = nlpResponse.response;

    if (
      actionResult &&
      actionResult.type === "voters" &&
      actionResult.data.length > 0
    ) {
      formattedResponse += "\n\n**Search Results:**\n\n";
      formattedResponse +=
        "| # | Name | Voter ID | Assembly | Part | Age | Gender |\n";
      formattedResponse +=
        "|---|------|----------|----------|------|-----|--------|\n";
      actionResult.data.slice(0, 10).forEach((v, i) => {
        formattedResponse += `| ${i + 1} | ${v.name || "-"} | ${
          v.voter_id || "-"
        } | ${v.assembly || "-"} | ${v.part_number || "-"} | ${
          v.age || "-"
        } | ${v.gender || "-"} |\n`;
      });
      if (actionResult.count > 10) {
        formattedResponse += `\n*Showing 10 of ${actionResult.count} results*`;
      }
    }

    if (
      actionResult &&
      actionResult.type === "sessions" &&
      actionResult.data.length > 0
    ) {
      formattedResponse += "\n\n**Sessions:**\n\n";
      formattedResponse +=
        "| Status | Filename | Pages | Progress | Created |\n";
      formattedResponse +=
        "|--------|----------|-------|----------|--------|\n";
      actionResult.data.forEach((s) => {
        const progress = s.total_pages
          ? `${s.processed_pages}/${s.total_pages}`
          : "N/A";
        const created = new Date(s.created_at).toLocaleDateString();
        formattedResponse += `| ${s.status} | ${
          s.original_filename || "Unknown"
        } | ${s.total_pages || 0} | ${progress} | ${created} |\n`;
      });
    }

    if (actionResult && actionResult.type === "stats") {
      const label = actionResult.statsType === "gender" ? "Gender" : "Religion";
      formattedResponse += `\n\n**${label} Statistics:**\n\n`;
      formattedResponse += `| ${label} | Count | Percentage |\n`;
      formattedResponse += "|----------|-------|------------|\n";
      actionResult.data.forEach((row) => {
        const key = row.gender || row.religion || "Unknown";
        formattedResponse += `| ${key} | ${row.count} | ${row.percentage}% |\n`;
      });
      formattedResponse += `\n**Total:** ${actionResult.total}`;
    }

    if (actionResult && actionResult.type === "api_status") {
      const status = actionResult.data;
      formattedResponse += "\n\n**API Engine Status:**\n\n";
      formattedResponse += `- **Total Engines:** ${status.totalEngines}\n`;
      formattedResponse += `- **Active:** ${status.activeEngines}\n`;
      formattedResponse += `- **Exhausted:** ${status.exhaustedEngines}\n`;
      formattedResponse += `- **Busy:** ${status.busyEngines}\n\n`;
      formattedResponse += "| Engine | Status | Requests | Success |\n";
      formattedResponse += "|--------|--------|----------|--------|\n";
      status.engines.forEach((e) => {
        const statusIcon = e.status === "active" ? "✅" : "❌";
        formattedResponse += `| ${e.engineId} | ${statusIcon} ${e.status} | ${e.metrics.totalRequests} | ${e.metrics.successCount} |\n`;
      });
    }

    if (actionResult && actionResult.type === "profile") {
      const p = actionResult.data;
      formattedResponse += "\n\n**Your Profile:**\n\n";
      formattedResponse += `- **Name:** ${p.name || "Not set"}\n`;
      formattedResponse += `- **Email:** ${p.email}\n`;
      formattedResponse += `- **Phone:** ${p.phone || "Not set"}\n`;
      formattedResponse += `- **Role:** ${p.role}\n`;
      formattedResponse += `- **Member since:** ${new Date(
        p.created_at,
      ).toLocaleDateString()}\n`;
    }

    if (actionResult && actionResult.type === "assemblies") {
      formattedResponse += "\n\n**Available Assemblies:**\n\n";
      formattedResponse += "| Assembly | Voter Count |\n";
      formattedResponse += "|----------|-------------|\n";
      actionResult.data.forEach((a) => {
        formattedResponse += `| ${a.assembly} | ${a.voter_count} |\n`;
      });
    }

    res.json({
      success: true,
      intent: nlpResponse.intent,
      action: nlpResponse.action,
      actionExecuted,
      response: formattedResponse,
      suggestions: nlpResponse.suggestions || [],
      actionResult: actionResult,
      userRole,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      response:
        "I apologize, but I encountered an error processing your request. Please try again or rephrase your question.",
      suggestions: ["Search for a voter", "View statistics", "Help"],
    });
  }
});

/**
 * Get available chat actions based on user role
 */
app.get("/chat/actions", authenticate, (req, res) => {
  const isAdmin = req.user.role === "admin";

  const userActions = [
    {
      action: "SEARCH_VOTERS",
      description: "Search voters by name, ID, assembly",
      example: "Find voters named Kumar in assembly 123",
    },
    {
      action: "VIEW_PROFILE",
      description: "View your profile",
      example: "Show my profile",
    },
    {
      action: "VIEW_ASSEMBLIES",
      description: "List all assemblies",
      example: "What assemblies are available?",
    },
    {
      action: "HELP",
      description: "Get help with commands",
      example: "Help me",
    },
  ];

  const adminActions = [
    {
      action: "VIEW_SESSIONS",
      description: "View uploaded PDF sessions",
      example: "Show me all sessions",
    },
    {
      action: "VIEW_STATS",
      description: "View voter statistics",
      example: "Show religion statistics",
    },
    {
      action: "VIEW_API_STATUS",
      description: "Check API engine status",
      example: "What's the API status?",
    },
    {
      action: "RESET_API_KEYS",
      description: "Reset exhausted API keys",
      example: "Reset all API keys",
    },
  ];

  res.json({
    userRole: req.user.role,
    actions: isAdmin ? [...userActions, ...adminActions] : userActions,
  });
});

// ============================================================================
// AI DATABASE AGENT ENDPOINTS
// ============================================================================

/**
 * Main agent query endpoint
 * POST /agent/query
 *
 * Process natural language queries about the database
 */
app.post("/agent/query", authenticate, async (req, res) => {
  try {
    const { message, isConfirmation } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        error: "Please provide a message to query",
      });
    }

    const result = await processAgentQuery(message, req.user, {
      isConfirmation,
    });

    // Log agent usage for analytics
    console.log(
      `🤖 Agent query from ${req.user.email} (${
        req.user.role
      }): "${message.slice(0, 50)}..."`,
    );

    res.json(result);
  } catch (error) {
    console.error("Agent query error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process your query",
      type: "system_error",
    });
  }
});

/**
 * Agent status and capabilities
 * GET /agent/status
 */
app.get("/agent/status", authenticate, (req, res) => {
  const status = getAgentStatus();
  const userPermissions = getUserPermissions(req.user.role);

  res.json({
    ...status,
    currentUser: {
      role: req.user.role,
      permissions: userPermissions,
    },
  });
});

/**
 * Get quick suggestions based on user role
 * GET /agent/suggestions
 */
app.get("/agent/suggestions", authenticate, (req, res) => {
  const suggestions = getQuickSuggestions(req.user.role);

  res.json({
    suggestions,
    role: req.user.role,
  });
});

/**
 * Get agent help and documentation
 * GET /agent/help
 */
app.get("/agent/help", authenticate, async (req, res) => {
  try {
    const result = await processAgentQuery("help", req.user);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to get help information",
    });
  }
});

/**
 * Confirm a pending agent query
 * POST /agent/confirm
 */
app.post("/agent/confirm", authenticate, async (req, res) => {
  try {
    const { confirm } = req.body;
    const message = confirm ? "yes" : "no";

    const result = await processAgentQuery(message, req.user, {
      isConfirmation: true,
    });
    res.json(result);
  } catch (error) {
    console.error("Agent confirm error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process confirmation",
    });
  }
});

/**
 * Get predefined query templates
 * GET /agent/templates
 */
app.get("/agent/templates", authenticate, (req, res) => {
  const isAdmin = req.user.role === "admin";

  const templates = {
    statistics: [
      { label: "Total Voters", query: "How many voters are in the database?" },
      {
        label: "Voters by Assembly",
        query: "Show voter count grouped by assembly",
      },
      {
        label: "Gender Distribution",
        query: "What is the gender distribution of voters?",
      },
      { label: "Religion Breakdown", query: "Show voter count by religion" },
      {
        label: "Age Statistics",
        query: "What is the average, minimum, and maximum age of voters?",
      },
    ],
    sessions: [
      {
        label: "Total Sessions",
        query: "How many sessions have been created?",
      },
      { label: "Session Status", query: "Show session count by status" },
      {
        label: "Total Pages",
        query: "How many pages have been processed in total?",
      },
    ],
    demographics: [
      { label: "Young Voters", query: "How many voters are aged 18 to 25?" },
      {
        label: "Senior Voters",
        query: "How many voters are 60 years or older?",
      },
      { label: "Age Groups", query: "Show voter distribution by age groups" },
    ],
  };

  if (isAdmin) {
    templates.admin = [
      {
        label: "Top Assemblies",
        query: "Show top 10 assemblies by voter count",
      },
      {
        label: "Unprinted Slips",
        query: "How many voter slips have not been printed?",
      },
      {
        label: "Recent Voters",
        query: "Show the 10 most recently added voters",
      },
      {
        label: "All Assemblies",
        query: "List all unique assemblies in the database",
      },
    ];
  }

  res.json({
    templates,
    role: req.user.role,
  });
});

/**
 * Execute a predefined safe query (no AI, direct database)
 * GET /agent/quick/:queryType
 */
app.get("/agent/quick/:queryType", authenticate, async (req, res) => {
  const { queryType } = req.params;
  const isAdmin = req.user.role === "admin";

  // Predefined safe queries - no user input, no SQL injection possible
  const quickQueries = {
    "total-voters": {
      sql: "SELECT COUNT(*) as total FROM session_voters",
      label: "Total Voters",
    },
    "voters-by-gender": {
      sql: "SELECT gender, COUNT(*) as count FROM session_voters GROUP BY gender ORDER BY count DESC",
      label: "Voters by Gender",
    },
    "voters-by-religion": {
      sql: "SELECT religion, COUNT(*) as count FROM session_voters GROUP BY religion ORDER BY count DESC",
      label: "Voters by Religion",
    },
    "voters-by-assembly": {
      sql: "SELECT assembly, COUNT(*) as count FROM session_voters GROUP BY assembly ORDER BY count DESC LIMIT 20",
      label: "Top 20 Assemblies",
    },
    "age-stats": {
      sql: "SELECT MIN(age) as min_age, MAX(age) as max_age, ROUND(AVG(age))::INT as avg_age FROM session_voters WHERE age IS NOT NULL",
      label: "Age Statistics",
    },
    "session-summary": {
      sql: "SELECT status, COUNT(*) as count, SUM(total_pages) as total_pages, SUM(processed_pages) as processed_pages FROM sessions GROUP BY status",
      label: "Session Summary",
    },
    "total-sessions": {
      sql: "SELECT COUNT(*) as total FROM sessions",
      label: "Total Sessions",
    },
    "age-distribution": {
      sql: `SELECT 
        CASE 
          WHEN age BETWEEN 18 AND 25 THEN '18-25'
          WHEN age BETWEEN 26 AND 35 THEN '26-35'
          WHEN age BETWEEN 36 AND 45 THEN '36-45'
          WHEN age BETWEEN 46 AND 55 THEN '46-55'
          WHEN age BETWEEN 56 AND 65 THEN '56-65'
          WHEN age > 65 THEN '65+'
          ELSE 'Unknown'
        END as age_group,
        COUNT(*) as count
      FROM session_voters
      WHERE age IS NOT NULL
      GROUP BY 1
      ORDER BY 1`,
      label: "Age Distribution",
    },
  };

  // Admin-only queries
  const adminQueries = {
    "unprinted-count": {
      sql: "SELECT COUNT(*) as unprinted FROM session_voters WHERE is_printed = FALSE OR is_printed IS NULL",
      label: "Unprinted Slips",
    },
    "all-assemblies": {
      sql: "SELECT DISTINCT assembly, COUNT(*) as voter_count FROM session_voters WHERE assembly IS NOT NULL AND assembly != '' GROUP BY assembly ORDER BY voter_count DESC",
      label: "All Assemblies",
    },
  };

  const allQueries = isAdmin
    ? { ...quickQueries, ...adminQueries }
    : quickQueries;

  if (!allQueries[queryType]) {
    return res.status(404).json({
      success: false,
      error: `Unknown query type: ${queryType}`,
      available: Object.keys(allQueries),
    });
  }

  try {
    const queryConfig = allQueries[queryType];
    const result = await query(queryConfig.sql);

    res.json({
      success: true,
      label: queryConfig.label,
      data: result.rows,
      rowCount: result.rowCount,
    });
  } catch (error) {
    console.error(`Quick query error (${queryType}):`, error);
    res.status(500).json({
      success: false,
      error: "Query execution failed",
    });
  }
});

/**
 * System info endpoint
 */
app.get("/system/info", authenticate, (req, res) => {
  const isAdmin = req.user.role === "admin";

  res.json({
    name: "Voter List Management System",
    version: "2.0.0",
    author: {
      name: "Shaswata Saha",
      website: "https://ssaha.vercel.app",
    },
    copyright: `© ${new Date().getFullYear()} Shaswata Saha. All rights reserved.`,
    features: [
      "PDF Voter List OCR with 7 parallel API engines",
      "Automatic API key rotation and recovery",
      "Intelligent NLP Chatbot",
      "Religion classification",
      "Role-based access control",
    ],
    apiEngines: isAdmin
      ? getApiKeyStatuses()
      : { totalEngines: getApiKeyStatuses().totalEngines },
  });
});

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown - pause all processing sessions
async function gracefulShutdown(signal) {
  console.log(`\n⚠️ ${signal} received. Pausing all processing sessions...`);

  try {
    // Pause all sessions that are currently processing
    await query(
      "UPDATE sessions SET status='paused', updated_at=now() WHERE status='processing'",
    );
    console.log("✅ All processing sessions paused");
  } catch (err) {
    console.error("Failed to pause sessions:", err.message);
  }

  // Close server gracefully
  server.close(() => {
    console.log("🛑 HTTP server closed");
    pool.end().then(() => {
      console.log("🗄️ Database pool closed");
      process.exit(0);
    });
  });

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("⏱️ Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
