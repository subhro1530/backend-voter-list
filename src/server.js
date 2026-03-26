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
  processPagesBatch,
  chatWithGemini,
  setGlobalDispatchMode,
  getGlobalDispatchMode,
  getAllowedDispatchModes,
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
import nominationRoutes from "./routes/nomination.js";
import {
  normalizeBoothNo,
  extractBoothNoFromFilename,
  extractAssemblyNameFromFilename,
  normalizeAssemblyName,
  assemblyLooksRelated,
} from "./boothLinking.js";
import {
  buildPaginationMeta,
  buildVoterFilterClause,
  parsePaginationParams,
  VOTER_DEFAULT_ORDER_SQL,
} from "./voterSearchFilters.js";

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

function normalizeUnderAdjudication(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (["true", "yes", "y", "1", "under adjudication"].includes(normalized)) {
    return true;
  }
  if (
    ["false", "no", "n", "0", "not under adjudication"].includes(normalized)
  ) {
    return false;
  }

  return /\badjudication\b/i.test(value);
}

function parseVoterBulkPayload(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.updates)) return body.updates;
  if (Array.isArray(body?.voters)) return body.voters;
  if (body && typeof body === "object") {
    if (body.voterId !== undefined || body.id !== undefined) return [body];
  }
  return [];
}

function toNullableText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function toNullableInt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildAllowedVoterUpdates(
  rawUpdate,
  { adjudicationOnly = false } = {},
) {
  const candidate = rawUpdate && typeof rawUpdate === "object" ? rawUpdate : {};
  const updates = {};

  if (
    candidate.underAdjudication !== undefined ||
    candidate.under_adjudication !== undefined ||
    candidate.adjudication !== undefined
  ) {
    updates.under_adjudication = normalizeUnderAdjudication(
      candidate.underAdjudication ??
        candidate.under_adjudication ??
        candidate.adjudication,
    );
  }

  if (adjudicationOnly) return updates;

  const textFieldMap = {
    name: "name",
    relationType: "relation_type",
    relation_type: "relation_type",
    relationName: "relation_name",
    relation_name: "relation_name",
    houseNumber: "house_number",
    house_number: "house_number",
    gender: "gender",
    religion: "religion",
    voterId: "voter_id",
    voter_id: "voter_id",
  };

  for (const [clientKey, dbKey] of Object.entries(textFieldMap)) {
    const value = toNullableText(candidate[clientKey]);
    if (value !== undefined) {
      updates[dbKey] = value;
    }
  }

  const age = toNullableInt(candidate.age);
  if (age !== undefined) {
    updates.age = age;
  }

  return updates;
}

async function applySessionVoterUpdates(sessionId, rawUpdates, options = {}) {
  const updatesList = parseVoterBulkPayload(rawUpdates);
  if (updatesList.length === 0) {
    return {
      updatedCount: 0,
      updatedVoters: [],
      rejected: [{ reason: "No voter updates provided" }],
    };
  }

  const client = await pool.connect();
  const updatedVoters = [];
  const rejected = [];

  try {
    await client.query("BEGIN");

    for (const rawUpdate of updatesList) {
      const voterId = rawUpdate?.voterId ?? rawUpdate?.id;
      if (!voterId) {
        rejected.push({ reason: "Missing voterId", payload: rawUpdate });
        continue;
      }

      const allowed = buildAllowedVoterUpdates(rawUpdate, options);
      const entries = Object.entries(allowed);
      if (entries.length === 0) {
        rejected.push({ reason: "No editable fields", voterId });
        continue;
      }

      const setSql = entries.map(([key], i) => `${key} = $${i + 1}`).join(", ");
      const values = entries.map(([, value]) => value);

      values.push(sessionId, voterId);

      const result = await client.query(
        `UPDATE session_voters
         SET ${setSql}
         WHERE session_id = $${entries.length + 1} AND id = $${entries.length + 2}
         RETURNING id, session_id, under_adjudication, name, relation_type, relation_name, house_number, age, gender, religion, voter_id`,
        values,
      );

      if (result.rowCount === 0) {
        rejected.push({ reason: "Voter not found in session", voterId });
        continue;
      }

      updatedVoters.push(result.rows[0]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    updatedCount: updatedVoters.length,
    updatedVoters,
    rejected,
  };
}

const app = express();
const port = process.env.PORT || 3000;
const storageRoot = path.join(process.cwd(), "storage");
const pageDelayMs = Number(process.env.GEMINI_PAGE_DELAY_MS || 2000);
const requestBodyLimitMb = Math.max(
  Number(process.env.REQUEST_BODY_LIMIT_MB || 10),
  1,
);
const maxUploadMb = Math.max(Number(process.env.MAX_UPLOAD_MB || 150), 10);
const maxUploadBytes = maxUploadMb * 1024 * 1024;
const autoResumeRounds = Math.max(
  Number(process.env.AUTO_RESUME_ROUNDS || 6),
  1,
);
const autoResumeDelayMs = Math.max(
  Number(process.env.AUTO_RESUME_DELAY_MS || 5000),
  1000,
);
const bulkProcessingWorkers = Math.max(
  Number(process.env.BULK_PROCESSING_WORKERS || 4),
  1,
);
const voterPhotoPlaceholderUrl =
  process.env.VOTER_PHOTO_PLACEHOLDER_URL || "placeholder://voter-photo";
const enableReligionClassification =
  String(process.env.OCR_ENABLE_RELIGION_CLASSIFICATION || "false")
    .trim()
    .toLowerCase() === "true";

// Parse CORS origins from environment variable
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
      .map((o) => o.trim().replace(/\/$/, "").toLowerCase()) // Remove trailing slashes
      .filter(Boolean)
  : [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dispatchModeAliasMap = new Map([
  ["auto", "auto"],
  ["balanced", "auto"],
  ["balanced auto", "auto"],
  ["free", "free-only"],
  ["free only", "free-only"],
  ["cost save", "free-only"],
  ["cost-save", "free-only"],
  ["paid", "paid-only"],
  ["paid only", "paid-only"],
  ["turbo", "paid-only"],
  ["turbo mode", "paid-only"],
]);

function parseDispatchMode(input) {
  const normalizedRaw = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2015]/g, "-");

  if (!normalizedRaw) return null;

  const allowed = getAllowedDispatchModes();
  if (allowed.includes(normalizedRaw)) return normalizedRaw;

  const extracted = normalizedRaw.match(
    /\b(auto|free[\s-]*only|paid[\s-]*only)\b/,
  );
  if (extracted?.[1]) {
    const canonical = extracted[1].replace(/\s+/g, "-");
    if (allowed.includes(canonical)) return canonical;
  }

  const compact = normalizedRaw
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const aliasResolved = dispatchModeAliasMap.get(compact);
  if (aliasResolved && allowed.includes(aliasResolved)) {
    return aliasResolved;
  }

  const dashCompact = compact.replace(/\s+/g, "-");
  if (allowed.includes(dashCompact)) return dashCompact;

  return null;
}

function resolvePlaceholderPhotoUrl() {
  return voterPhotoPlaceholderUrl;
}

function extractOriginHost(originValue) {
  try {
    const parsed = new URL(originValue);
    return parsed.hostname.toLowerCase();
  } catch {
    return String(originValue || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
  }
}

function isOriginAllowed(origin) {
  if (!origin) return true;

  const normalizedOrigin = origin.replace(/\/$/, "").toLowerCase();

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    return true;
  }

  if (allowedOrigins.includes(normalizedOrigin)) {
    return true;
  }

  const originHost = extractOriginHost(normalizedOrigin);

  for (const allowedEntry of allowedOrigins) {
    const allowed = String(allowedEntry || "").toLowerCase();

    // Exact host match when allowed list contains bare domains
    const allowedHost = extractOriginHost(allowed);
    if (originHost === allowedHost) {
      return true;
    }

    // Wildcard support: *.example.com or .example.com
    if (allowed.startsWith("*.") || allowed.startsWith(".")) {
      const suffix = allowed.replace(/^\*?\./, "");
      if (originHost === suffix || originHost.endsWith(`.${suffix}`)) {
        return true;
      }
    }
  }

  return false;
}

async function getPendingPagePaths(sessionId, allPagePaths, pathToPageNumber) {
  const processedPagesRes = await query(
    "SELECT page_number FROM session_pages WHERE session_id=$1",
    [sessionId],
  );
  const processedSet = new Set(
    processedPagesRes.rows.map((r) => r.page_number),
  );
  return allPagePaths.filter(
    (pagePath) => !processedSet.has(pathToPageNumber.get(pagePath)),
  );
}

async function syncSessionProcessedPages(sessionId) {
  const countRes = await query(
    "SELECT COUNT(*)::int AS pages_done FROM session_pages WHERE session_id=$1",
    [sessionId],
  );
  const pagesDone = countRes.rows[0]?.pages_done || 0;

  await query(
    "UPDATE sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
    [pagesDone, sessionId],
  );

  return pagesDone;
}

// CORS configuration with proper origin validation for production
const corsConfig = {
  origin: function (origin, callback) {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    // Log blocked origin for debugging
    console.log(`CORS blocked origin: ${origin}`);
    console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);

    // Return false instead of throwing to keep error responses consistent
    callback(null, false);
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
app.use(express.json({ limit: `${requestBodyLimitMb}mb` }));
app.use(
  express.urlencoded({ extended: true, limit: `${requestBodyLimitMb}mb` }),
);

// Mount route modules
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/user", userRoutes);
app.use("/election-results", electionResultRoutes);
app.use("/affidavits", affidavitRoutes);
app.use("/nominations", nominationRoutes);

function sessionIdMiddleware(req, _res, next) {
  req.sessionId = uuidv4();
  next();
}

function isAcceptedBulkFileFieldName(fieldName) {
  const normalized = String(fieldName || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "files" ||
    normalized === "file" ||
    /^files\[\d*\]$/.test(normalized)
  );
}

function getBulkFieldCounts(reqFiles) {
  const counts = {};
  for (const item of reqFiles || []) {
    const key = String(item?.fieldname || "");
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
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
  limits: { fileSize: maxUploadBytes },
});

const bulkUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const requestId = req.bulkRequestId || uuidv4();
        req.bulkRequestId = requestId;
        const dest = path.join(storageRoot, "voter-slips", "jobs", requestId);
        await fs.ensureDir(dest);
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const safeBaseName = path.basename(file.originalname || "upload.pdf");
      const uniquePrefix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniquePrefix}-${safeBaseName}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF uploads are allowed"));
    } else {
      cb(null, true);
    }
  },
  limits: { fileSize: maxUploadBytes },
});

async function processUploadedSessionFile({
  sessionId,
  pdfPath,
  originalName,
  apiKey,
  dispatchMode,
}) {
  const boothNoFromFilename = extractBoothNoFromFilename(originalName);

  try {
    await query(
      "INSERT INTO sessions (id, original_filename, status, processed_pages, booth_no) VALUES ($1, $2, $3, $4, $5)",
      [sessionId, originalName, "processing", 0, boothNoFromFilename || null],
    );

    if (boothNoFromFilename) {
      console.log(
        `🏷️ Booth number inferred from filename: booth_no="${boothNoFromFilename}" (${originalName})`,
      );
    }

    const pageDir = path.join(storageRoot, sessionId, "pages");
    const pagePaths = await splitPdfToPages(pdfPath, pageDir);
    const pagePathToNumber = new Map(
      pagePaths.map((pagePath, idx) => [pagePath, idx + 1]),
    );
    await query(
      "UPDATE sessions SET total_pages=$1, processed_pages=0, updated_at=now() WHERE id=$2",
      [pagePaths.length, sessionId],
    );

    console.log(
      `📄 Processing ${pagePaths.length} pages with parallel engines...`,
    );

    let errorCount = 0;
    let keySwitchCount = 0;
    let lastKeyUsed = null;

    const savePageToDatabase = async (pageIndex, result, pagePath) => {
      const { text, keyUsed } = result;
      const pageNumber = pageIndex + 1;

      const existingPage = await query(
        "SELECT id FROM session_pages WHERE session_id=$1 AND page_number=$2 LIMIT 1",
        [sessionId, pageNumber],
      );
      if (existingPage.rowCount > 0) {
        await syncSessionProcessedPages(sessionId);
        return;
      }

      if (lastKeyUsed && keyUsed !== lastKeyUsed) {
        keySwitchCount++;
      }
      lastKeyUsed = keyUsed;

      const structured = parseGeminiStructured(text);

      if (pageIndex === 0) {
        const firstAssembly = structured.assembly || "";
        const firstBoothNo = normalizeBoothNo(structured.partNumber || "");

        await query(
          `UPDATE sessions
           SET booth_name = COALESCE(NULLIF($1,''), booth_name),
               assembly_name = COALESCE(NULLIF($2,''), assembly_name),
               booth_no = COALESCE(NULLIF($3,''), booth_no),
               updated_at = now()
           WHERE id = $4`,
          [structured.boothName || "", firstAssembly, firstBoothNo, sessionId],
        );

        if (firstBoothNo || structured.boothName) {
          console.log(
            `🏫 Session tagged: assembly="${firstAssembly}", booth_no="${firstBoothNo}", booth_name="${structured.boothName || ""}"`,
          );
        }
      }

      const pageRes = await query(
        "INSERT INTO session_pages (session_id, page_number, page_path, raw_text, structured_json) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [sessionId, pageNumber, pagePath, text, structured],
      );

      const pageId = pageRes.rows[0].id;
      const assembly = structured.assembly || "";
      const partNumber = structured.partNumber || "";
      const section = structured.section || "";
      const voters = Array.isArray(structured.voters) ? structured.voters : [];

      let religions = [];
      if (enableReligionClassification && voters.length > 0) {
        const religionResult = await classifyReligionByNames(voters, apiKey, {
          dispatchMode,
        });
        religions = religionResult.religions;
      }

      for (let i = 0; i < voters.length; i++) {
        const voter = voters[i];
        const religion = religions[i] || "Other";
        const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
        const age = Number.isNaN(ageValue) ? null : ageValue;
        const photoUrl = resolvePlaceholderPhotoUrl();
        const underAdjudication = normalizeUnderAdjudication(
          voter.underAdjudication ??
            voter.under_adjudication ??
            voter.isUnderAdjudication ??
            voter.adjudication,
        );

        const cleanVoterId = sanitizeVoterId(voter.voterId);

        await query(
          "INSERT INTO session_voters (session_id, page_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, under_adjudication, photo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
          [
            sessionId,
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
            underAdjudication,
            photoUrl,
          ],
        );
      }

      const pagesDone = await syncSessionProcessedPages(sessionId);

      console.log(
        `✅ Page ${pageNumber}/${pagePaths.length} saved to database (${voters.length} voters). Progress: ${pagesDone}/${pagePaths.length}`,
      );
    };

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
      { dispatchMode },
    );

    let remainingPagePaths = await getPendingPagePaths(
      sessionId,
      pagePaths,
      pagePathToNumber,
    );
    let roundsDone = 0;

    while (remainingPagePaths.length > 0 && roundsDone < autoResumeRounds) {
      roundsDone++;
      console.log(
        `🔁 Auto-resume round ${roundsDone}/${autoResumeRounds}: ${remainingPagePaths.length} pages remaining`,
      );

      await sleep(autoResumeDelayMs);

      await processPagesBatch(
        remainingPagePaths,
        0,
        async (progress) => {
          if (progress.type === "page_complete" && progress.result) {
            const pageNumber = pagePathToNumber.get(progress.pagePath);
            if (pageNumber) {
              try {
                await savePageToDatabase(
                  pageNumber - 1,
                  progress.result,
                  progress.pagePath,
                );
              } catch (err) {
                console.error(
                  `Auto-resume save failed for page ${pageNumber}:`,
                  err.message,
                );
                errorCount++;
              }
            }
          }
        },
        { dispatchMode },
      );

      remainingPagePaths = await getPendingPagePaths(
        sessionId,
        pagePaths,
        pagePathToNumber,
      );
    }

    const finalStatus = await query(
      "SELECT processed_pages FROM sessions WHERE id=$1",
      [sessionId],
    );
    const finalProcessed = finalStatus.rows[0]?.processed_pages || 0;

    console.log(
      `📊 Session ${sessionId}: ${finalProcessed}/${pagePaths.length} pages processed, ${errorCount} errors`,
    );

    if (finalProcessed < pagePaths.length) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["paused", sessionId],
      );

      return {
        statusCode: 207,
        payload: {
          sessionId,
          pages: pagePaths.length,
          processedPages: finalProcessed,
          errorPages: errorCount,
          status: "paused",
          dispatchMode: dispatchMode || getGlobalDispatchMode(),
          message:
            "Session partially completed after automatic retries. Use POST /sessions/:id/resume to continue.",
          keySwitchCount,
          automaticRetryRounds: roundsDone,
          batchResult,
          apiKeyStatus: getApiKeyStatuses(),
        },
      };
    }

    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "completed",
      sessionId,
    ]);

    return {
      statusCode: 201,
      payload: {
        sessionId,
        pages: pagePaths.length,
        status: "completed",
        dispatchMode: dispatchMode || getGlobalDispatchMode(),
        keySwitchCount,
        automaticRetryRounds: roundsDone,
        apiKeyStatus: getApiKeyStatuses(),
      },
    };
  } catch (err) {
    await query("UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2", [
      "failed",
      sessionId,
    ]).catch(() => {});
    console.error("Session processing failed:", err.message);
    return {
      statusCode: 500,
      payload: {
        sessionId,
        status: "failed",
        error: "Processing failed",
        details: err.message,
        apiKeyStatus: getApiKeyStatuses(),
      },
    };
  }
}

function buildVoterFilter(params, startIndex = 1) {
  return buildVoterFilterClause(params, { startIndex });
}

async function getSessionBoothMeta(sessionId) {
  const result = await query(
    `SELECT s.id,
            s.original_filename,
            s.assembly_name,
            s.booth_no,
            s.booth_name,
            sv.assembly AS fallback_assembly,
            sv.part_number AS fallback_booth
     FROM sessions s
     LEFT JOIN LATERAL (
       SELECT v.assembly, v.part_number
       FROM session_voters v
       WHERE v.session_id = s.id
       ORDER BY v.page_number ASC, v.id ASC
       LIMIT 1
     ) sv ON true
     WHERE s.id = $1`,
    [sessionId],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const assembly =
    row.assembly_name ||
    row.fallback_assembly ||
    extractAssemblyNameFromFilename(row.original_filename) ||
    "";
  const boothFromFilename = extractBoothNoFromFilename(row.original_filename);
  const boothNo = normalizeBoothNo(
    row.booth_no || row.fallback_booth || boothFromFilename || "",
  );

  return {
    id: row.id,
    originalFilename: row.original_filename,
    boothName: row.booth_name || "",
    assembly,
    boothNo,
    normalizedAssembly: normalizeAssemblyName(assembly),
  };
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
    const requestedDispatchMode = req.body?.dispatchMode;
    const dispatchMode = requestedDispatchMode
      ? parseDispatchMode(requestedDispatchMode)
      : null;

    if (requestedDispatchMode && !dispatchMode) {
      return res.status(400).json({
        error: `Invalid dispatchMode. Allowed: ${getAllowedDispatchModes().join(", ")}`,
      });
    }

    if (!pdfPath) {
      return res.status(400).json({ error: "PDF file is required" });
    }

    const result = await processUploadedSessionFile({
      sessionId,
      pdfPath,
      originalName,
      apiKey,
      dispatchMode,
    });

    res.status(result.statusCode).json(result.payload);
  },
);

// Bulk session upload - Admin only
app.post(
  "/sessions/bulk",
  authenticate,
  adminOnly,
  (req, _res, next) => {
    req.bulkRequestId = uuidv4();
    next();
  },
  bulkUpload.any(),
  async (req, res) => {
    const incomingFiles = Array.isArray(req.files) ? req.files : [];
    const files = incomingFiles.filter((file) =>
      isAcceptedBulkFileFieldName(file?.fieldname),
    );
    const fieldCounts = getBulkFieldCounts(incomingFiles);
    const apiKey = req.body?.apiKey || req.body?.geminiApiKey;
    const requestedDispatchMode = req.body?.dispatchMode;
    const dispatchMode = requestedDispatchMode
      ? parseDispatchMode(requestedDispatchMode)
      : null;
    const workerCount = bulkProcessingWorkers;
    const expectedFileCountRaw = req.body?.expectedFileCount;
    const expectedFileCount = Number.isFinite(Number(expectedFileCountRaw))
      ? Number(expectedFileCountRaw)
      : null;

    if (requestedDispatchMode && !dispatchMode) {
      return res.status(400).json({
        error: `Invalid dispatchMode. Allowed: ${getAllowedDispatchModes().join(", ")}`,
      });
    }

    if (files.length === 0) {
      return res.status(400).json({
        error:
          "At least one PDF is required under multipart field names like 'files', 'files[]', or 'files[0]'.",
        receivedFields: fieldCounts,
      });
    }

    if (
      expectedFileCount !== null &&
      expectedFileCount > 0 &&
      files.length !== expectedFileCount
    ) {
      return res.status(400).json({
        error:
          "Uploaded file count mismatch. Retry upload with the same field name for all selected files.",
        expectedFileCount,
        receivedFileCount: files.length,
        receivedFields: fieldCounts,
      });
    }

    const tasks = files.map((file, index) => ({ file, index }));
    const taskResults = [];
    let cursor = 0;

    async function worker() {
      while (cursor < tasks.length) {
        const nextIndex = cursor;
        cursor += 1;

        const task = tasks[nextIndex];
        if (!task) break;

        const sessionId = uuidv4();
        const safeOriginalName =
          path.basename(task.file.originalname || "upload.pdf") || "upload.pdf";
        const pdfPath = task.file.path;

        try {
          const result = await processUploadedSessionFile({
            sessionId,
            pdfPath,
            originalName: safeOriginalName,
            apiKey,
            dispatchMode,
          });

          taskResults[task.index] = {
            uploadIndex: task.index,
            fileName: safeOriginalName,
            ...result.payload,
            httpStatus: result.statusCode,
          };

          await fs.remove(pdfPath).catch(() => {});
        } catch (err) {
          console.error(
            `Bulk upload failed for file ${safeOriginalName}:`,
            err.message,
          );
          taskResults[task.index] = {
            uploadIndex: task.index,
            fileName: safeOriginalName,
            status: "failed",
            error: "Bulk file handling failed",
            details: err.message,
            httpStatus: 500,
          };

          await fs.remove(pdfPath).catch(() => {});
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const completed = taskResults.filter(
      (r) => r?.status === "completed",
    ).length;
    const paused = taskResults.filter((r) => r?.status === "paused").length;
    const failed = taskResults.filter((r) => r?.status === "failed").length;

    const allCompleted = completed === taskResults.length;
    const responseCode = allCompleted ? 201 : 207;
    const requestUploadDir = path.join(
      storageRoot,
      "voter-slips",
      "jobs",
      req.bulkRequestId || "",
    );

    await fs.remove(requestUploadDir).catch(() => {});

    return res.status(responseCode).json({
      uploadBatchId: req.bulkRequestId,
      totalFiles: files.length,
      acceptedFileCount: files.length,
      receivedFields: fieldCounts,
      dispatchMode: dispatchMode || getGlobalDispatchMode(),
      workerCount,
      summary: {
        completed,
        paused,
        failed,
      },
      sessions: taskResults,
      apiKeyStatus: getApiKeyStatuses(),
    });
  },
);

// Sessions list - Admin only
app.get("/sessions", authenticate, adminOnly, async (_req, res) => {
  const sql = `
      SELECT s.id, s.original_filename, s.status, s.total_pages, s.processed_pages,
        s.assembly_name, s.booth_no, s.booth_name,
        s.created_at, s.updated_at,
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
  const dispatchStatus = getApiKeyStatuses();

  res.json({
    sessionId: id,
    status,
    total_pages,
    processed_pages,
    pages_done,
    last_page_processed,
    current_page,
    voter_count,
    activeDispatchTier: dispatchStatus.activeDispatchTier,
    paidFallbackActive: dispatchStatus.activeDispatchTier === "paid",
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
    "SELECT id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, under_adjudication, photo_url, is_printed, printed_at, created_at FROM session_voters WHERE session_id=$1 ORDER BY page_number, serial_number",
    [id],
  );

  res.json({
    session: session.rows[0],
    pages: pages.rows,
    voters: voters.rows,
  });
});

// Session metadata correction - Admin only
app.patch(
  "/sessions/:id/metadata",
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params;
      const sessionCheck = await query(
        "SELECT id, original_filename FROM sessions WHERE id=$1",
        [id],
      );
      if (sessionCheck.rowCount === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      const assemblyNameInput = req.body?.assemblyName;
      const boothNoInput = req.body?.boothNo;
      const boothNameInput = req.body?.boothName;

      const hasAssembly = assemblyNameInput !== undefined;
      const hasBoothNo = boothNoInput !== undefined;
      const hasBoothName = boothNameInput !== undefined;

      if (!hasAssembly && !hasBoothNo && !hasBoothName) {
        return res.status(400).json({
          error: "Provide at least one field: assemblyName, boothNo, boothName",
        });
      }

      const assemblyName = hasAssembly
        ? String(assemblyNameInput || "").trim()
        : null;
      const boothNo = hasBoothNo ? normalizeBoothNo(boothNoInput) : null;
      const boothName = hasBoothName
        ? String(boothNameInput || "").trim()
        : null;

      if (hasBoothNo && !boothNo) {
        return res.status(400).json({
          error:
            "Invalid boothNo. Expected digits with optional suffix (e.g. 7, 45A)",
        });
      }

      const updates = [];
      const values = [];
      let idx = 1;

      if (hasAssembly) {
        updates.push(`assembly_name = $${idx}`);
        values.push(assemblyName || null);
        idx += 1;
      }
      if (hasBoothNo) {
        updates.push(`booth_no = $${idx}`);
        values.push(boothNo || null);
        idx += 1;
      }
      if (hasBoothName) {
        updates.push(`booth_name = $${idx}`);
        values.push(boothName || null);
        idx += 1;
      }

      updates.push(`updated_at = now()`);
      values.push(id);

      const updated = await query(
        `UPDATE sessions
       SET ${updates.join(", ")}
       WHERE id = $${idx}
       RETURNING id, original_filename, assembly_name, booth_no, booth_name, updated_at`,
        values,
      );

      const meta = await getSessionBoothMeta(id);

      return res.json({
        message: "Session metadata updated",
        session: updated.rows[0],
        mappingMeta: meta,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  },
);

// Session voters - Admin only
app.get("/sessions/:id/voters", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const session = await query("SELECT 1 FROM sessions WHERE id=$1", [id]);
  if (session.rowCount === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { page, limit, offset } = parsePaginationParams(req.query, {
    defaultPage: 1,
    defaultLimit: 50,
    maxLimit: 200,
  });
  const { where, values, nextIndex } = buildVoterFilterClause(req.query, {
    startIndex: 1,
    forceSessionId: id,
  });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*)::int as total FROM session_voters ${whereSql}`;
  const countResult = await query(countSql, values);
  const total = countResult.rows[0].total;

  const sql = `
    SELECT id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, under_adjudication, photo_url, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY ${VOTER_DEFAULT_ORDER_SQL}
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1};
  `;
  const result = await query(sql, [...values, limit, offset]);
  res.json({
    voters: result.rows,
    pagination: buildPaginationMeta({ page, limit, total }),
  });
});

// Linked election results for the same assembly + booth as this voter session
app.get(
  "/sessions/:id/linked-election-results",
  authenticate,
  adminOnly,
  async (req, res) => {
    const { id } = req.params;
    const year = req.query.year ? Number(req.query.year) : null;

    if (year !== null && Number.isNaN(year)) {
      return res.status(400).json({ error: "Invalid year filter" });
    }

    const meta = await getSessionBoothMeta(id);
    if (!meta) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (!meta.boothNo) {
      return res.status(400).json({
        error: "Booth number not detected for this session",
        hint: "Booth number is derived from part number on page 1",
      });
    }

    const rows = await query(
      `SELECT es.id AS election_session_id,
              es.original_filename,
              es.constituency,
              es.election_year,
              es.status,
              es.created_at,
              eb.id AS booth_result_id,
              eb.serial_no,
              eb.booth_no,
              eb.candidate_votes,
              eb.total_valid_votes,
              eb.rejected_votes,
              eb.nota,
              eb.total_votes,
              eb.tendered_votes
       FROM election_sessions es
       JOIN election_booth_results eb ON eb.session_id = es.id
       WHERE ($1::INT IS NULL OR es.election_year = $1)
       ORDER BY es.created_at DESC, eb.serial_no ASC`,
      [year],
    );

    const linkedRows = rows.rows.filter((row) => {
      const sameBooth = normalizeBoothNo(row.booth_no) === meta.boothNo;
      if (!sameBooth) return false;
      if (!meta.assembly) return true;
      return assemblyLooksRelated(meta.assembly, row.constituency || "");
    });

    const uniqueElectionSessionIds = [
      ...new Set(linkedRows.map((row) => row.election_session_id)),
    ];

    const fullResults = [];

    for (const electionSessionId of uniqueElectionSessionIds) {
      const sessionInfoRes = await query(
        `SELECT id, original_filename, constituency, election_year, total_electors,
                status, total_pages, processed_pages, created_at, updated_at
         FROM election_sessions
         WHERE id = $1`,
        [electionSessionId],
      );

      if (sessionInfoRes.rowCount === 0) continue;

      const candidatesRes = await query(
        `SELECT id, candidate_name, party, candidate_index, created_at
         FROM election_candidates
         WHERE session_id = $1
         ORDER BY candidate_index`,
        [electionSessionId],
      );

      const totalsRes = await query(
        `SELECT id, total_type, candidate_votes, total_valid_votes,
                rejected_votes, nota, total_votes, tendered_votes, created_at
         FROM election_totals
         WHERE session_id = $1
         ORDER BY total_type`,
        [electionSessionId],
      );

      const boothRow = linkedRows.find(
        (row) => row.election_session_id === electionSessionId,
      );

      if (!boothRow) continue;

      fullResults.push({
        electionSession: sessionInfoRes.rows[0],
        boothResult: {
          id: boothRow.booth_result_id,
          serial_no: boothRow.serial_no,
          booth_no: boothRow.booth_no,
          candidate_votes: boothRow.candidate_votes,
          total_valid_votes: boothRow.total_valid_votes,
          rejected_votes: boothRow.rejected_votes,
          nota: boothRow.nota,
          total_votes: boothRow.total_votes,
          tendered_votes: boothRow.tendered_votes,
        },
        candidates: candidatesRes.rows,
        totals: totalsRes.rows,
      });
    }

    res.json({
      session: meta,
      filters: { year },
      linkedResults: linkedRows,
      fullResults,
      fullCount: fullResults.length,
      count: linkedRows.length,
    });
  },
);

// Admin: Global voters search with full filtering
app.get("/voters/search", authenticate, adminOnly, async (req, res) => {
  const { page, limit, offset } = parsePaginationParams(req.query, {
    defaultPage: 1,
    defaultLimit: 50,
    maxLimit: 200,
  });
  const { where, values, nextIndex } = buildVoterFilter({ ...req.query });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*)::int as total FROM session_voters ${whereSql}`;
  const countResult = await query(countSql, values);
  const total = countResult.rows[0].total;

  const sql = `
    SELECT id, session_id, page_number, assembly, part_number, section, serial_number, voter_id, name, relation_type, relation_name, house_number, age, gender, religion, under_adjudication, is_printed, created_at
    FROM session_voters
    ${whereSql}
    ORDER BY ${VOTER_DEFAULT_ORDER_SQL}
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1};
  `;
  const result = await query(sql, [...values, limit, offset]);
  res.json({
    voters: result.rows,
    pagination: buildPaginationMeta({ page, limit, total }),
  });
});

// Update voter adjudication flag - Admin only
app.patch(
  "/sessions/:id/voters/:voterId/adjudication",
  authenticate,
  adminOnly,
  async (req, res) => {
    const { id, voterId } = req.params;
    const { underAdjudication } = req.body || {};

    if (typeof underAdjudication !== "boolean") {
      return res.status(400).json({
        error: "underAdjudication must be a boolean",
      });
    }

    const updated = await query(
      `UPDATE session_voters
       SET under_adjudication = $1
       WHERE session_id = $2 AND id = $3
       RETURNING id, session_id, under_adjudication`,
      [underAdjudication, id, voterId],
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found in this session" });
    }

    return res.json({
      message: "Voter adjudication updated",
      voter: updated.rows[0],
    });
  },
);

// Bulk/single adjudication update compatibility route - Admin only
app.patch(
  "/sessions/:id/voters/adjudication",
  authenticate,
  adminOnly,
  async (req, res) => {
    const { id } = req.params;

    try {
      const outcome = await applySessionVoterUpdates(id, req.body, {
        adjudicationOnly: true,
      });

      if (outcome.updatedCount === 0) {
        return res.status(400).json({
          error: "No adjudication updates were applied",
          rejected: outcome.rejected,
        });
      }

      return res.json({
        message: "Adjudication updates applied",
        updatedCount: outcome.updatedCount,
        voters: outcome.updatedVoters,
        rejected: outcome.rejected,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  },
);

// Bulk voter updates (legacy/frontend compatibility) - Admin only
app.patch("/sessions/:id/voters", authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    const outcome = await applySessionVoterUpdates(id, req.body, {
      adjudicationOnly: false,
    });

    if (outcome.updatedCount === 0) {
      return res.status(400).json({
        error: "No voter updates were applied",
        rejected: outcome.rejected,
      });
    }

    return res.json({
      message: "Voter updates applied",
      updatedCount: outcome.updatedCount,
      voters: outcome.updatedVoters,
      rejected: outcome.rejected,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Explicit bulk alias used by some frontend builds - Admin only
app.patch(
  "/sessions/:id/voters/bulk",
  authenticate,
  adminOnly,
  async (req, res) => {
    const { id } = req.params;

    try {
      const outcome = await applySessionVoterUpdates(id, req.body, {
        adjudicationOnly: false,
      });

      if (outcome.updatedCount === 0) {
        return res.status(400).json({
          error: "No voter updates were applied",
          rejected: outcome.rejected,
        });
      }

      return res.json({
        message: "Bulk voter updates applied",
        updatedCount: outcome.updatedCount,
        voters: outcome.updatedVoters,
        rejected: outcome.rejected,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  },
);

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

// Current dispatch mode - Authenticated users
app.get("/api-keys/dispatch-mode", authenticate, (_req, res) => {
  res.json({
    mode: getGlobalDispatchMode(),
    allowedModes: getAllowedDispatchModes(),
  });
});

// Set dispatch mode globally at runtime - Admin only
app.patch("/api-keys/dispatch-mode", authenticate, adminOnly, (req, res) => {
  const mode = parseDispatchMode(req.body?.mode);
  if (!mode) {
    return res.status(400).json({
      error: `Invalid mode. Allowed: ${getAllowedDispatchModes().join(", ")}`,
    });
  }

  const applied = setGlobalDispatchMode(mode);
  const status = getApiKeyStatuses();
  return res.json({
    message: `Dispatch mode set to ${applied}`,
    mode: applied,
    status,
  });
});

// Frontend-safe Gemini dispatch status (no key previews) - Authenticated users
app.get("/api-keys/dispatch-status", authenticate, (_req, res) => {
  const status = getApiKeyStatuses();
  res.json({
    configuredDispatchMode: status.configuredDispatchMode,
    paidFallbackEnabledInAuto: status.paidFallbackEnabledInAuto,
    paidAllowedForCurrentMode: status.paidAllowedForCurrentMode,
    activeDispatchTier: status.activeDispatchTier,
    paidFallbackActive: status.activeDispatchTier === "paid",
    totalEngines: status.totalEngines,
    activeEngines: status.activeEngines,
    rateLimitedEngines: status.rateLimitedEngines,
    exhaustedEngines: status.exhaustedEngines,
    busyEngines: status.busyEngines,
    availableEngines: status.availableEngines,
    pools: status.pools,
    allExhausted: status.allExhausted,
    updatedAt: new Date().toISOString(),
  });
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
  const requestedDispatchMode = req.body?.dispatchMode;
  const dispatchMode = requestedDispatchMode
    ? parseDispatchMode(requestedDispatchMode)
    : null;

  if (requestedDispatchMode && !dispatchMode) {
    return res.status(400).json({
      error: `Invalid dispatchMode. Allowed: ${getAllowedDispatchModes().join(", ")}`,
    });
  }

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
    const pagePathToNumber = new Map(
      allPagePaths.map((entry) => [entry.path, entry.pageNumber]),
    );

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

    // Save page to database immediately when completed
    const savePageToDatabase = async (pagePath, result) => {
      const { text, keyUsed } = result;
      const pageNumber = pageNumberMap.get(pagePath);

      if (!pageNumber) {
        return;
      }

      const existingPage = await query(
        "SELECT id FROM session_pages WHERE session_id=$1 AND page_number=$2 LIMIT 1",
        [id, pageNumber],
      );
      if (existingPage.rowCount > 0) {
        await syncSessionProcessedPages(id);
        return;
      }

      if (lastKeyUsed && keyUsed !== lastKeyUsed) {
        keySwitchCount++;
      }
      lastKeyUsed = keyUsed;

      const structured = parseGeminiStructured(text);

      // First page carries authoritative booth + assembly metadata.
      if (pageNumber === 1) {
        const firstAssembly = structured.assembly || "";
        const firstBoothNo = normalizeBoothNo(structured.partNumber || "");

        await query(
          `UPDATE sessions
           SET booth_name = COALESCE(NULLIF($1,''), booth_name),
               assembly_name = COALESCE(NULLIF($2,''), assembly_name),
               booth_no = COALESCE(NULLIF($3,''), booth_no),
               updated_at = now()
           WHERE id = $4`,
          [structured.boothName || "", firstAssembly, firstBoothNo, id],
        );
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
      if (enableReligionClassification && voters.length > 0) {
        const religionResult = await classifyReligionByNames(voters, apiKey, {
          dispatchMode,
        });
        religions = religionResult.religions;
      }

      for (let i = 0; i < voters.length; i++) {
        const voter = voters[i];
        const religion = religions[i] || "Other";
        const ageValue = voter.age ? Number.parseInt(voter.age, 10) : null;
        const age = Number.isNaN(ageValue) ? null : ageValue;
        const photoUrl = resolvePlaceholderPhotoUrl();

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

      const pagesDone = await syncSessionProcessedPages(id);

      console.log(
        `✅ Resume: Page ${pageNumber} saved to DB (${voters.length} voters). Progress: ${pagesDone}/${allPagePaths.length}`,
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
      { dispatchMode },
    );

    // Automatic recovery rounds during resume flow.
    let remainingPagePaths = await getPendingPagePaths(
      id,
      allPagePaths.map((p) => p.path),
      pagePathToNumber,
    );
    let roundsDone = 0;

    while (remainingPagePaths.length > 0 && roundsDone < autoResumeRounds) {
      roundsDone++;
      console.log(
        `🔁 Resume auto-round ${roundsDone}/${autoResumeRounds}: ${remainingPagePaths.length} pages remaining`,
      );

      await sleep(autoResumeDelayMs);

      await processPagesBatch(
        remainingPagePaths,
        0,
        async (progress) => {
          if (progress.type === "page_complete" && progress.result) {
            try {
              await savePageToDatabase(progress.pagePath, progress.result);
            } catch (err) {
              console.error(
                "Failed to save page during resume auto-round:",
                err.message,
              );
            }
          }
        },
        { dispatchMode },
      );

      remainingPagePaths = await getPendingPagePaths(
        id,
        allPagePaths.map((p) => p.path),
        pagePathToNumber,
      );
    }

    // Check for errors
    if (remainingPagePaths.length > 0) {
      await query(
        "UPDATE sessions SET status=$1, updated_at=now() WHERE id=$2",
        ["paused", id],
      );
      return res.status(207).json({
        message: "Session partially resumed",
        sessionId: id,
        resumed_from_page: resumedFromPage,
        processed_in_resume: batchResult.processedCount,
        errors: remainingPagePaths.length,
        total_remaining: remainingPagePaths.length,
        status: "paused",
        dispatchMode: dispatchMode || getGlobalDispatchMode(),
        automaticRetryRounds: roundsDone,
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
      dispatchMode: dispatchMode || getGlobalDispatchMode(),
      automaticRetryRounds: roundsDone,
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
      if (status.activeDispatchTier) {
        formattedResponse += `- **Current Dispatch Tier:** ${status.activeDispatchTier}\n`;
      }
      if (status.pools) {
        formattedResponse += `- **Free Pool:** ${status.pools.free?.available || 0} available / ${status.pools.free?.active || 0} active\n`;
        formattedResponse += `- **Paid Pool:** ${status.pools.paid?.available || 0} available / ${status.pools.paid?.active || 0} active\n\n`;
      }
      formattedResponse += "| Engine | Tier | Status | Requests | Success |\n";
      formattedResponse += "|--------|------|--------|----------|--------|\n";
      status.engines.forEach((e) => {
        const statusIcon = e.status === "active" ? "✅" : "❌";
        formattedResponse += `| ${e.engineId} | ${e.tier || "free"} | ${statusIcon} ${e.status} | ${e.metrics.totalRequests} | ${e.metrics.successCount} |\n`;
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

// Unified error handler for CORS/multer/runtime errors
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);

  const requestOrigin = req.get("origin");
  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "Uploaded file is too large",
        code: err.code,
        maxUploadMb,
      });
    }

    return res.status(400).json({
      error: err.message || "Upload error",
      code: err.code || "MULTER_ERROR",
    });
  }

  const msg = err.message || "Unexpected server error";

  if (msg.includes("CORS")) {
    return res.status(403).json({
      error: "Origin not allowed",
      details: msg,
      requestOrigin: requestOrigin || null,
      configuredOrigins: allowedOrigins,
    });
  }

  console.error("Unhandled server error:", msg);
  return res.status(500).json({
    error: "Internal server error",
    details: msg,
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
