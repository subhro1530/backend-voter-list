/**
 * Election Results Routes — Parallel Processing, Candidate Extraction, Excel Export
 *
 * Mirrors the voter-list parallel engine architecture:
 *   - Uses ALL available Gemini API keys in parallel (one engine per key)
 *   - Processes pages in batches with retry & rate-limit handling
 *   - Stores results progressively (DB updated after every page)
 *   - Returns immediately after upload; processing runs in background
 *
 * Created by: Shaswata Saha | ssaha.vercel.app
 */

import express from "express";
import path from "path";
import fs from "fs-extra";
import fsPromises from "fs/promises";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import ExcelJS from "exceljs";
import { query } from "../db.js";
import { authenticate, adminOnly } from "../auth.js";
import { splitPdfToPages } from "../pdf.js";
import {
  getAvailableEngines,
  getApiKeyStatuses,
  getCurrentApiKey,
  initializeKeyStatus,
} from "../gemini.js";
import {
  parseElectionResult,
  getElectionResultOCRPrompt,
  mergeElectionResults,
} from "../electionResultParser.js";

const router = express.Router();

// All election result routes require admin
router.use(authenticate);
router.use(adminOnly);

const storageRoot = path.join(process.cwd(), "storage", "elections");

// Track active processing sessions for stop/status
const activeElectionSessions = new Map();

// Prevent duplicate concurrent uploads
const recentUploads = new Map(); // filename → timestamp

// ============================================
// GEMINI ENGINE INTERNALS (election-specific)
// ============================================

const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";

const mimeByExt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

/**
 * Check if an error is a quota/rate-limit issue
 */
function classifyGeminiError(statusCode, errorText) {
  const lower = (errorText || "").toLowerCase();
  const permanentPatterns = [
    "quota exceeded",
    "daily limit",
    "monthly limit",
    "billing",
    "payment required",
  ];
  const tempPatterns = [
    "rate limit",
    "too many requests",
    "resource_exhausted",
    "try again",
    "retry",
  ];

  if (statusCode === 403 && permanentPatterns.some((p) => lower.includes(p))) {
    return "permanent";
  }
  if (statusCode === 429 || tempPatterns.some((p) => lower.includes(p))) {
    return "temporary";
  }
  return "other";
}

/**
 * Call Gemini API with a specific API key and an election-result prompt.
 * This is our own engine that doesn't use the voter-list prompt from gemini.js.
 */
async function callGeminiForElection(
  filePath,
  apiKey,
  isFirstPage,
  engineLabel = "",
) {
  const data = await fsPromises.readFile(filePath);
  const base64 = data.toString("base64");
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeByExt[ext] || "application/octet-stream";

  const prompt = getElectionResultOCRPrompt(isFirstPage);

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: base64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 16384,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  console.log(`📊 ${engineLabel} sending election OCR request...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    const errType = classifyGeminiError(res.status, errorText);
    const err = new Error(
      `GEMINI_${errType === "permanent" ? "EXHAUSTED" : errType === "temporary" ? "RATE_LIMITED" : "ERROR"}: ${res.status} - ${errorText.slice(0, 300)}`,
    );
    err.geminiErrorType = errType;
    throw err;
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const combinedText = parts
    .map((p) => (p.text ? p.text : ""))
    .join("\n")
    .trim();

  return { text: combinedText, keyUsed: apiKey };
}

/**
 * Helper: staggered delay with jitter to avoid thundering herd
 */
function staggeredDelay(ms) {
  const jitter = Math.floor(Math.random() * 1500);
  return new Promise((r) => setTimeout(r, ms + jitter));
}

/**
 * Process election pages using controlled parallelism.
 *
 * Key design decisions learned from debugging:
 *   1. Process page 1 FIRST alone (extracts candidate names from headers)
 *   2. Limit concurrency to MAX_CONCURRENT (not all keys at once)
 *   3. Each page gets a DEDICATED key (round-robin), with fallback rotation
 *   4. Rate-limit catch WAITS inline (like the voter-list engine does)
 *   5. 10 retries with proper backoff between each
 *   6. Stagger requests within a batch (1s apart) to avoid bursts
 */
async function processElectionPagesParallel(pagePaths, sessionId, onPageDone) {
  // ── Gather API keys ──
  const actualKeys = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GEMINI_API_KEY_") && value && value.trim()) {
      const trimmed = value.trim();
      if (!seen.has(trimmed)) {
        actualKeys.push(trimmed);
        seen.add(trimmed);
      }
    }
  }
  if (actualKeys.length === 0 && process.env.GEMINI_API_KEY) {
    actualKeys.push(process.env.GEMINI_API_KEY.trim());
  }
  if (actualKeys.length === 0) {
    throw new Error("No Gemini API keys available");
  }

  const totalKeys = actualKeys.length;
  const RATE_LIMIT_WAIT = 20000; // 20s cooldown on rate limit
  const MAX_RETRIES = 10; // generous retries
  const STAGGER_DELAY = 1500; // 1.5s between requests in a batch
  // Limit concurrency — 5 or totalKeys, whichever is smaller
  const MAX_CONCURRENT = Math.min(
    parseInt(process.env.ELECTION_MAX_CONCURRENT) || 5,
    totalKeys,
  );

  // Per-key cooldown timestamps (shared across all pages)
  const keyCooldownUntil = new Map(); // apiKey → timestamp
  const keyExhausted = new Set(); // permanently dead keys

  console.log(
    `🚀 Election parallel processing: ${pagePaths.length} pages, ${totalKeys} keys, concurrency=${MAX_CONCURRENT}`,
  );

  /**
   * Pick the best available key. Prefers the one assigned to this slot,
   * then round-robins through others, skipping exhausted/cooling keys.
   * If all cooling, returns { key, waitMs } for the soonest-available.
   */
  function pickKey(preferSlot) {
    const now = Date.now();
    // Try preferred key
    const pref = actualKeys[preferSlot % totalKeys];
    if (!keyExhausted.has(pref) && (keyCooldownUntil.get(pref) || 0) <= now) {
      return { key: pref, waitMs: 0 };
    }
    // Try any available key (starting from a random offset to spread load)
    const offset = Math.floor(Math.random() * totalKeys);
    for (let i = 0; i < totalKeys; i++) {
      const k = actualKeys[(offset + i) % totalKeys];
      if (!keyExhausted.has(k) && (keyCooldownUntil.get(k) || 0) <= now) {
        return { key: k, waitMs: 0 };
      }
    }
    // All cooling — find soonest recovery
    let soonest = Infinity;
    let soonestKey = actualKeys[0];
    for (const k of actualKeys) {
      if (keyExhausted.has(k)) continue;
      const until = keyCooldownUntil.get(k) || 0;
      if (until < soonest) {
        soonest = until;
        soonestKey = k;
      }
    }
    // If ALL exhausted permanently, return any key (will fail but that's OK)
    if (keyExhausted.size >= totalKeys) {
      return { key: actualKeys[0], waitMs: 0 };
    }
    return { key: soonestKey, waitMs: Math.max(0, soonest - now) + 2000 };
  }

  /**
   * Process a single page with retries and key rotation
   */
  async function processOnePage(pageIndex, pagePath, isFirstPage, keySlot) {
    let retries = 0;
    let lastError = null;

    while (retries < MAX_RETRIES) {
      // Check stop signal
      const sessionState = activeElectionSessions.get(sessionId);
      if (sessionState?.stopped)
        return { success: false, pageIndex, error: "Stopped by user" };

      const { key, waitMs } = pickKey(keySlot + retries);

      // Wait if all keys on cooldown
      if (waitMs > 0) {
        console.log(
          `⏳ Page ${pageIndex + 1}: all keys cooling, waiting ${Math.ceil(waitMs / 1000)}s...`,
        );
        await staggeredDelay(waitMs);
      }

      try {
        const engineLabel = `Key-${(actualKeys.indexOf(key) % totalKeys) + 1}`;
        const result = await callGeminiForElection(
          pagePath,
          key,
          isFirstPage,
          engineLabel,
        );
        const parsed = parseElectionResult(result.text);

        console.log(
          `✅ Page ${pageIndex + 1}/${pagePaths.length} done — ${(parsed.boothResults || []).length} booths, ${(parsed.candidates || []).length} candidates`,
        );

        if (onPageDone) {
          await onPageDone(pageIndex, pagePath, parsed, result.text);
        }
        return { success: true, pageIndex, parsed, rawText: result.text };
      } catch (err) {
        lastError = err.message;
        retries++;

        if (err.geminiErrorType === "permanent") {
          keyExhausted.add(key);
          console.log(
            `❌ Key ${key.slice(0, 12)}... exhausted permanently (${keyExhausted.size}/${totalKeys} dead)`,
          );
          // Don't wait — immediately try next key
          await staggeredDelay(500);
        } else if (
          err.geminiErrorType === "temporary" ||
          err.message.includes("RATE_LIMITED")
        ) {
          // Mark key on cooldown AND wait before retrying (critical fix!)
          keyCooldownUntil.set(key, Date.now() + RATE_LIMIT_WAIT);
          console.log(
            `⏳ Key ${key.slice(0, 12)}... rate-limited, cooling ${RATE_LIMIT_WAIT / 1000}s (attempt ${retries}/${MAX_RETRIES})`,
          );
          // Actually wait here like the voter-list engine does
          await staggeredDelay(RATE_LIMIT_WAIT);
        } else {
          console.error(
            `❌ Page ${pageIndex + 1} error (attempt ${retries}): ${err.message.slice(0, 150)}`,
          );
          await staggeredDelay(3000);
        }
      }
    }

    console.error(
      `❌ Page ${pageIndex + 1} FAILED after ${MAX_RETRIES} attempts`,
    );
    return {
      success: false,
      pageIndex,
      error: lastError || "Max retries exceeded",
    };
  }

  const results = [];
  const errors = [];

  // ── Step 1: Process page 1 ALONE first (gets candidate names & constituency) ──
  if (pagePaths.length > 0) {
    console.log(`📋 Processing page 1 first (extracts candidate names)...`);
    const page1Result = await processOnePage(0, pagePaths[0], true, 0);
    if (page1Result.success) {
      results.push(page1Result);
      console.log(
        `📋 Page 1 done. Candidates: ${(page1Result.parsed.candidates || []).join(", ")}`,
      );
    } else {
      errors.push(page1Result);
      console.log(`⚠️ Page 1 failed, continuing with remaining pages...`);
    }
  }

  // ── Step 2: Process remaining pages in controlled parallel batches ──
  const remainingPaths = pagePaths.slice(1);
  if (remainingPaths.length > 0) {
    console.log(
      `📦 Processing remaining ${remainingPaths.length} pages (concurrency=${MAX_CONCURRENT})...`,
    );

    for (
      let batchStart = 0;
      batchStart < remainingPaths.length;
      batchStart += MAX_CONCURRENT
    ) {
      const sessionState = activeElectionSessions.get(sessionId);
      if (sessionState?.stopped) {
        console.log(`⏹️ Session ${sessionId} stopped by user`);
        break;
      }

      const batchEnd = Math.min(
        batchStart + MAX_CONCURRENT,
        remainingPaths.length,
      );
      const batchPaths = remainingPaths.slice(batchStart, batchEnd);
      const batchNum = Math.floor(batchStart / MAX_CONCURRENT) + 1;
      const totalBatches = Math.ceil(remainingPaths.length / MAX_CONCURRENT);

      console.log(
        `📦 Batch ${batchNum}/${totalBatches}: pages ${batchStart + 2}-${batchEnd + 1}/${pagePaths.length}`,
      );

      // Stagger start times within batch to avoid burst
      const batchPromises = batchPaths.map(async (pagePath, idx) => {
        // Stagger: each page in the batch starts 1.5s after the previous
        if (idx > 0) {
          await new Promise((r) => setTimeout(r, STAGGER_DELAY * idx));
        }
        const pageIndex = batchStart + idx + 1; // +1 because page 0 already done
        return processOnePage(pageIndex, pagePath, false, idx);
      });

      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        if (r.success) results.push(r);
        else errors.push(r);
      }

      // Delay between batches
      if (batchEnd < remainingPaths.length) {
        console.log(`⏰ Batch delay before next batch...`);
        await staggeredDelay(3000);
      }
    }
  }

  console.log(
    `📊 Election processing done: ${results.length} success, ${errors.length} errors out of ${pagePaths.length} pages`,
  );
  return { results, errors };
}

// ============================================
// MULTER CONFIG
// ============================================

const electionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const sessionId = req.electionSessionId || uuidv4();
      req.electionSessionId = sessionId;
      const dest = path.join(storageRoot, sessionId, "pdf");
      try {
        fs.ensureDirSync(dest);
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      cb(null, file.originalname || "election-result.pdf");
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

// ============================================
// UPLOAD & PROCESS (background, like voter list)
// ============================================

/**
 * POST /election-results/upload
 * Upload and start processing an election result PDF.
 * Returns immediately with sessionId; processing continues in background.
 */
router.post(
  "/upload",
  (req, _res, next) => {
    req.electionSessionId = uuidv4();
    next();
  },
  electionUpload.single("file"),
  async (req, res) => {
    const sessionId = req.electionSessionId;
    const pdfPath = req.file?.path;
    const originalName = req.file?.originalname || "election-result.pdf";

    if (!pdfPath) {
      return res.status(400).json({ error: "PDF file is required" });
    }

    // Prevent duplicate rapid uploads of the same file
    const lastUpload = recentUploads.get(originalName);
    if (lastUpload && Date.now() - lastUpload < 30000) {
      return res.status(429).json({
        error:
          "This file was just uploaded. Please wait before uploading again.",
      });
    }
    recentUploads.set(originalName, Date.now());
    // Clean old entries
    for (const [name, ts] of recentUploads) {
      if (Date.now() - ts > 60000) recentUploads.delete(name);
    }

    try {
      // Create session in DB
      await query(
        `INSERT INTO election_sessions (id, original_filename, status, processed_pages, total_pages)
         VALUES ($1, $2, 'processing', 0, 0)`,
        [sessionId, originalName],
      );

      // Split PDF
      const pageDir = path.join(storageRoot, sessionId, "pages");
      const pagePaths = await splitPdfToPages(pdfPath, pageDir);

      await query(
        "UPDATE election_sessions SET total_pages=$1, updated_at=now() WHERE id=$2",
        [pagePaths.length, sessionId],
      );

      // Return immediately
      res.status(201).json({
        sessionId,
        originalFilename: originalName,
        totalPages: pagePaths.length,
        status: "processing",
        message: `Processing ${pagePaths.length} pages in background with parallel engines`,
      });

      // ---- Background processing ----
      activeElectionSessions.set(sessionId, { stopped: false });

      let processedCount = 0;
      const allPageResults = [];

      // This callback is invoked for each page that completes
      const onPageDone = async (pageIndex, pagePath, parsed, rawText) => {
        try {
          // Save page to DB
          const pageRes = await query(
            `INSERT INTO election_pages
             (session_id, page_number, page_path, raw_text, structured_json)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              sessionId,
              pageIndex + 1,
              pagePath,
              rawText,
              JSON.stringify(parsed),
            ],
          );
          const pageId = pageRes.rows[0].id;

          // Save booth results
          for (const booth of parsed.boothResults || []) {
            await query(
              `INSERT INTO election_booth_results
               (session_id, page_id, serial_no, booth_no, candidate_votes,
                total_valid_votes, rejected_votes, nota, total_votes, tendered_votes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                sessionId,
                pageId,
                booth.serialNo,
                booth.boothNo,
                JSON.stringify(booth.candidateVotes),
                booth.totalValidVotes,
                booth.rejectedVotes,
                booth.nota,
                booth.totalVotes,
                booth.tenderedVotes,
              ],
            );
          }

          // Save candidates discovered on this page (upsert)
          for (let ci = 0; ci < (parsed.candidates || []).length; ci++) {
            const name = parsed.candidates[ci];
            if (!name) continue;
            await query(
              `INSERT INTO election_candidates (session_id, candidate_name, candidate_index)
               VALUES ($1, $2, $3)
               ON CONFLICT (session_id, candidate_name) DO UPDATE SET candidate_index = LEAST(election_candidates.candidate_index, $3)`,
              [sessionId, name, ci],
            );
          }

          // Update constituency + total_electors if found
          if (parsed.constituency || parsed.totalElectors) {
            const updates = [];
            const vals = [];
            let idx = 1;
            if (parsed.constituency) {
              updates.push(
                `constituency = COALESCE(NULLIF(constituency,''), $${idx})`,
              );
              vals.push(parsed.constituency);
              idx++;
            }
            if (parsed.totalElectors) {
              updates.push(
                `total_electors = COALESCE(total_electors, $${idx})`,
              );
              vals.push(parsed.totalElectors);
              idx++;
            }
            if (updates.length > 0) {
              vals.push(sessionId);
              await query(
                `UPDATE election_sessions SET ${updates.join(", ")}, updated_at=now() WHERE id=$${idx}`,
                vals,
              );
            }
          }

          processedCount++;
          allPageResults[pageIndex] = parsed;

          await query(
            "UPDATE election_sessions SET processed_pages=$1, updated_at=now() WHERE id=$2",
            [processedCount, sessionId],
          );
        } catch (dbErr) {
          console.error(
            `❌ DB save error for election page ${pageIndex + 1}:`,
            dbErr.message,
          );
        }
      };

      // Run parallel processing
      const { results, errors } = await processElectionPagesParallel(
        pagePaths,
        sessionId,
        onPageDone,
      );

      // ---- Post-processing: merge & save totals ----
      const validResults = allPageResults.filter(Boolean);
      const merged = mergeElectionResults(validResults);

      // Determine final status
      let finalStatus = "completed";
      if (results.length === 0 && errors.length > 0) finalStatus = "failed";
      else if (errors.length > 0 && results.length > 0) finalStatus = "partial";

      // Update session final info
      await query(
        `UPDATE election_sessions
         SET constituency = COALESCE(NULLIF(constituency,''), $1),
             total_electors = COALESCE(total_electors, $2),
             status = $3,
             processed_pages = $4,
             updated_at = now()
         WHERE id = $5`,
        [
          merged.constituency || null,
          merged.totalElectors || null,
          finalStatus,
          processedCount,
          sessionId,
        ],
      );

      // Reconcile candidate names across all pages
      // The merge gives us the canonical candidate list; ensure DB has them
      for (let ci = 0; ci < merged.candidates.length; ci++) {
        await query(
          `INSERT INTO election_candidates (session_id, candidate_name, candidate_index)
           VALUES ($1, $2, $3)
           ON CONFLICT (session_id, candidate_name) DO UPDATE SET candidate_index = $3`,
          [sessionId, merged.candidates[ci], ci],
        );
      }

      // Reconcile booth candidate_votes keys to canonical names
      if (merged.candidates.length > 0) {
        const boothRows = await query(
          "SELECT id, candidate_votes FROM election_booth_results WHERE session_id=$1",
          [sessionId],
        );
        for (const row of boothRows.rows) {
          const votes = row.candidate_votes || {};
          const keys = Object.keys(votes);
          const hasGeneric = keys.some((k) => /^Candidate\d+$/i.test(k));
          if (hasGeneric) {
            const reconciled = {};
            for (const [k, v] of Object.entries(votes)) {
              const m = k.match(/^Candidate(\d+)$/i);
              if (m) {
                const idx = parseInt(m[1]) - 1;
                reconciled[
                  idx < merged.candidates.length ? merged.candidates[idx] : k
                ] = v;
              } else {
                reconciled[k] = v;
              }
            }
            await query(
              "UPDATE election_booth_results SET candidate_votes=$1 WHERE id=$2",
              [JSON.stringify(reconciled), row.id],
            );
          }
        }
      }

      // Save totals
      if (merged.totals) {
        const totalTypes = [
          { key: "evmVotes", type: "evm" },
          { key: "postalVotes", type: "postal" },
          { key: "totalVotesPolled", type: "total" },
        ];
        for (const { key, type } of totalTypes) {
          const totalData = merged.totals[key];
          if (!totalData || typeof totalData !== "object") continue;

          const metaKeys = new Set([
            "totalValidVotes",
            "total_valid_votes",
            "rejectedVotes",
            "rejected_votes",
            "nota",
            "NOTA",
            "totalVotes",
            "total_votes",
            "tenderedVotes",
            "tendered_votes",
          ]);

          const candidateVotes = {};
          let totalValidVotes = null;
          let rejectedVotes = 0;
          let nota = 0;
          let totalVotes = null;
          let tenderedVotes = 0;

          for (const [k, v] of Object.entries(totalData)) {
            if (k === "totalValidVotes" || k === "total_valid_votes")
              totalValidVotes = v;
            else if (k === "rejectedVotes" || k === "rejected_votes")
              rejectedVotes = v;
            else if (k === "nota" || k === "NOTA") nota = v;
            else if (k === "totalVotes" || k === "total_votes") totalVotes = v;
            else if (k === "tenderedVotes" || k === "tendered_votes")
              tenderedVotes = v;
            else candidateVotes[k] = v;
          }

          await query(
            `INSERT INTO election_totals
             (session_id, total_type, candidate_votes, total_valid_votes,
              rejected_votes, nota, total_votes, tendered_votes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (session_id, total_type) DO UPDATE SET
               candidate_votes=$3, total_valid_votes=$4, rejected_votes=$5,
               nota=$6, total_votes=$7, tendered_votes=$8`,
            [
              sessionId,
              type,
              JSON.stringify(candidateVotes),
              totalValidVotes,
              rejectedVotes,
              nota,
              totalVotes,
              tenderedVotes,
            ],
          );
        }
      }

      activeElectionSessions.delete(sessionId);
      console.log(
        `🏁 Election session ${sessionId} complete [${finalStatus}] — ${results.length}/${pagePaths.length} pages OK, ${merged.candidates.length} candidates, ${merged.boothResults.length} booths`,
      );
      if (errors.length > 0) {
        console.log(
          `⚠️ Failed pages: ${errors.map((e) => e.pageIndex + 1).join(", ")}`,
        );
      }
    } catch (err) {
      activeElectionSessions.delete(sessionId);
      await query(
        "UPDATE election_sessions SET status='failed', updated_at=now() WHERE id=$1",
        [sessionId],
      ).catch(() => {});
      console.error("Election result processing failed:", err.message);
      // Response already sent, so just log the error
    }
  },
);

// ============================================
// STOP PROCESSING
// ============================================

router.post("/sessions/:id/stop", async (req, res) => {
  const { id } = req.params;
  const sessionState = activeElectionSessions.get(id);
  if (!sessionState) {
    return res
      .status(404)
      .json({ error: "No active processing for this session" });
  }
  sessionState.stopped = true;
  await query(
    "UPDATE election_sessions SET status='paused', updated_at=now() WHERE id=$1",
    [id],
  );
  res.json({ message: "Processing stopped", sessionId: id });
});

// ============================================
// LIST SESSIONS
// ============================================

router.get("/sessions", async (_req, res) => {
  try {
    const sql = `
      SELECT es.id, es.original_filename, es.constituency, es.total_electors,
             es.status, es.total_pages, es.processed_pages,
             es.created_at, es.updated_at,
             COUNT(DISTINCT eb.id) AS booth_count,
             COUNT(DISTINCT ec.id) AS candidate_count
      FROM election_sessions es
      LEFT JOIN election_booth_results eb ON eb.session_id = es.id
      LEFT JOIN election_candidates ec ON ec.session_id = es.id
      GROUP BY es.id
      ORDER BY es.created_at DESC;
    `;
    const result = await query(sql);
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SESSION DETAIL
// ============================================

router.get("/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const session = await query("SELECT * FROM election_sessions WHERE id=$1", [
      id,
    ]);
    if (session.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const candidates = await query(
      "SELECT * FROM election_candidates WHERE session_id=$1 ORDER BY candidate_index",
      [id],
    );

    const boothResults = await query(
      `SELECT eb.*, ep.page_number
       FROM election_booth_results eb
       LEFT JOIN election_pages ep ON ep.id = eb.page_id
       WHERE eb.session_id=$1
       ORDER BY eb.serial_no, eb.booth_no`,
      [id],
    );

    const totals = await query(
      "SELECT * FROM election_totals WHERE session_id=$1 ORDER BY total_type",
      [id],
    );

    res.json({
      session: session.rows[0],
      candidates: candidates.rows,
      boothResults: boothResults.rows,
      totals: totals.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DELETE SESSION
// ============================================

router.delete("/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // Stop if processing
    const sessionState = activeElectionSessions.get(id);
    if (sessionState) sessionState.stopped = true;

    const deleted = await query(
      "DELETE FROM election_sessions WHERE id=$1 RETURNING id",
      [id],
    );
    if (deleted.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const dir = path.join(storageRoot, id);
    await fs.remove(dir).catch(() => {});

    res.json({ deleted: id, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// RENAME SESSION
// ============================================

router.patch("/sessions/:id/rename", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "Name is required" });

    const updated = await query(
      "UPDATE election_sessions SET original_filename=$1, updated_at=now() WHERE id=$2 RETURNING id, original_filename",
      [name.trim(), id],
    );
    if (updated.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    res.json({ sessionId: id, name: updated.rows[0].original_filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STATISTICS
// ============================================

router.get("/sessions/:id/stats", async (req, res) => {
  try {
    const { id } = req.params;
    const session = await query("SELECT * FROM election_sessions WHERE id=$1", [
      id,
    ]);
    if (session.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const candidates = await query(
      "SELECT * FROM election_candidates WHERE session_id=$1 ORDER BY candidate_index",
      [id],
    );
    const boothResults = await query(
      "SELECT * FROM election_booth_results WHERE session_id=$1 ORDER BY serial_no",
      [id],
    );
    const totals = await query(
      "SELECT * FROM election_totals WHERE session_id=$1",
      [id],
    );

    const candidateStats = candidates.rows.map((candidate) => {
      let totalVotes = 0;
      let boothsWon = 0;
      let highestVotes = 0;
      let lowestVotes = Infinity;
      let highestBooth = "";
      let lowestBooth = "";

      for (const booth of boothResults.rows) {
        const votes =
          (booth.candidate_votes || {})[candidate.candidate_name] || 0;
        totalVotes += votes;

        if (votes > highestVotes) {
          highestVotes = votes;
          highestBooth = booth.booth_no;
        }
        if (votes < lowestVotes) {
          lowestVotes = votes;
          lowestBooth = booth.booth_no;
        }

        const allVotes = Object.entries(booth.candidate_votes || {});
        const maxV = Math.max(...allVotes.map(([, v]) => v || 0));
        if (votes === maxV && votes > 0) boothsWon++;
      }

      return {
        candidateName: candidate.candidate_name,
        totalVotes,
        boothsWon,
        boothsContested: boothResults.rows.length,
        averageVotes:
          boothResults.rows.length > 0
            ? Math.round(totalVotes / boothResults.rows.length)
            : 0,
        highestVotes,
        highestBooth,
        lowestVotes: lowestVotes === Infinity ? 0 : lowestVotes,
        lowestBooth: lowestVotes === Infinity ? "" : lowestBooth,
      };
    });

    candidateStats.sort((a, b) => b.totalVotes - a.totalVotes);

    res.json({
      session: session.rows[0],
      totalBooths: boothResults.rows.length,
      candidateStats,
      totals: totals.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// EXCEL EXPORT — styled exactly like the Form 20 image
// ============================================

router.get("/sessions/:id/export/excel", async (req, res) => {
  try {
    const { id } = req.params;

    const sessionRes = await query(
      "SELECT * FROM election_sessions WHERE id=$1",
      [id],
    );
    if (sessionRes.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });
    const session = sessionRes.rows[0];

    const candidatesRes = await query(
      "SELECT * FROM election_candidates WHERE session_id=$1 ORDER BY candidate_index",
      [id],
    );
    const candidates = candidatesRes.rows;

    const boothRes = await query(
      "SELECT * FROM election_booth_results WHERE session_id=$1 ORDER BY serial_no, booth_no",
      [id],
    );
    const boothResults = boothRes.rows;

    const totalsRes = await query(
      "SELECT * FROM election_totals WHERE session_id=$1 ORDER BY total_type",
      [id],
    );
    const totals = totalsRes.rows;

    // ---- Build workbook ----
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Voter List Management System";
    workbook.created = new Date();

    const numCandidates = candidates.length;
    // Total columns: Sl.No + Booth + N candidates + Valid + Rejected + NOTA + Total + Tendered
    const totalCols = 2 + numCandidates + 5;
    const lastColLetter = colLetter(totalCols);

    // ======== SHEET 1: Full Results (mirrors Form 20 exactly) ========
    const ws = workbook.addWorksheet("Election Results", {
      properties: { tabColor: { argb: "FF1F4E79" } },
    });

    // Styles
    const headerFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E79" },
    };
    const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    const thinBorder = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
    const centerAlign = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };

    // ---- Row 1: "FORM 20 / FINAL RESULT SHEET" ----
    ws.mergeCells(`A1:${lastColLetter}1`);
    const r1 = ws.getCell("A1");
    r1.value = "FORM 20 — FINAL RESULT SHEET";
    r1.font = { bold: true, size: 14, color: { argb: "FF1F4E79" } };
    r1.alignment = { horizontal: "center" };
    ws.getRow(1).height = 24;

    // ---- Row 2: "ELECTION TO THE LEGISLATIVE ASSEMBLY" ----
    ws.mergeCells(`A2:${lastColLetter}2`);
    const r2 = ws.getCell("A2");
    r2.value = "ELECTION TO THE LEGISLATIVE ASSEMBLY";
    r2.font = { bold: true, size: 12 };
    r2.alignment = { horizontal: "center" };

    // ---- Row 3: Constituency + Electors ----
    ws.mergeCells(`A3:${lastColLetter}3`);
    const r3 = ws.getCell("A3");
    r3.value = `Total No. of Electors in Assembly Constituency/segment ....${session.total_electors?.toLocaleString() || "N/A"}`;
    r3.font = { bold: true, size: 11 };
    r3.alignment = { horizontal: "center" };

    // ---- Row 4: Assembly Name ----
    ws.mergeCells(`A4:${lastColLetter}4`);
    const r4 = ws.getCell("A4");
    r4.value = `Name of Assembly/segment ...${session.constituency || "N/A"}`;
    r4.font = { bold: true, size: 11 };
    r4.alignment = { horizontal: "center" };

    // ---- Row 5: Empty spacer ----
    ws.getRow(5).height = 6;

    // ---- Row 6: Header row 1 — merged groups ----
    // Columns: A=Sl, B=Booth, C...(C+N-1)=candidates, then Valid, Rejected, NOTA, Total, Tendered
    const candidateStartCol = 3; // Column C
    const candidateEndCol = 2 + numCandidates; // Last candidate column
    const validCol = candidateEndCol + 1;
    const rejectedCol = validCol + 1;
    const notaCol = rejectedCol + 1;
    const totalCol = notaCol + 1;
    const tenderedCol = totalCol + 1;

    // First header row: "Serial No. Of Polling Station" merged with row below,
    // then "No of Valid Votes Cast in favour of" merged across all candidate columns
    const headerRow1 = 6;
    const headerRow2 = 7;

    // Merge A6:A7 = "Serial No. Of Polling Station"
    ws.mergeCells(`A${headerRow1}:A${headerRow2}`);
    const slHeader = ws.getCell(`A${headerRow1}`);
    slHeader.value = "Serial\nNo. Of\nPolling\nStation";
    slHeader.font = headerFont;
    slHeader.fill = headerFill;
    slHeader.alignment = centerAlign;
    slHeader.border = thinBorder;

    // Merge B6:B7 (not used in original but we need booth no)
    ws.mergeCells(`B${headerRow1}:B${headerRow2}`);
    const boothHeader = ws.getCell(`B${headerRow1}`);
    boothHeader.value = "Booth\nNo.";
    boothHeader.font = headerFont;
    boothHeader.fill = headerFill;
    boothHeader.alignment = centerAlign;
    boothHeader.border = thinBorder;

    // Merge candidate columns in row 6: "No of Valid Votes Cast in favour of"
    if (numCandidates > 0) {
      ws.mergeCells(
        `${colLetter(candidateStartCol)}${headerRow1}:${colLetter(candidateEndCol)}${headerRow1}`,
      );
      const votesHeader = ws.getCell(
        `${colLetter(candidateStartCol)}${headerRow1}`,
      );
      votesHeader.value = "No of Valid Votes Cast in favour of";
      votesHeader.font = headerFont;
      votesHeader.fill = headerFill;
      votesHeader.alignment = centerAlign;
      votesHeader.border = thinBorder;
    }

    // Row 7 = individual candidate names under the merged header
    for (let ci = 0; ci < numCandidates; ci++) {
      const col = candidateStartCol + ci;
      const cell = ws.getCell(`${colLetter(col)}${headerRow2}`);
      cell.value = candidates[ci].candidate_name;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
      cell.fill = headerFill;
      cell.alignment = centerAlign;
      cell.border = thinBorder;
    }

    // Merge remaining headers across rows 6-7
    const rightHeaders = [
      { col: validCol, label: "Total\nof\nValid\nVotes" },
      { col: rejectedCol, label: "No. Of\nRejected\nVotes" },
      { col: notaCol, label: "NOTA" },
      { col: totalCol, label: "Total" },
      { col: tenderedCol, label: "No. Of\nTendered\nVotes" },
    ];

    for (const { col, label } of rightHeaders) {
      const letter = colLetter(col);
      ws.mergeCells(`${letter}${headerRow1}:${letter}${headerRow2}`);
      const cell = ws.getCell(`${letter}${headerRow1}`);
      cell.value = label;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.alignment = centerAlign;
      cell.border = thinBorder;
    }

    ws.getRow(headerRow1).height = 30;
    ws.getRow(headerRow2).height = 50;

    // ---- Column widths ----
    ws.getColumn(1).width = 8; // Sl
    ws.getColumn(2).width = 10; // Booth
    for (let ci = 0; ci < numCandidates; ci++) {
      const nameLen = candidates[ci].candidate_name.length;
      ws.getColumn(candidateStartCol + ci).width = Math.max(12, nameLen + 2);
    }
    ws.getColumn(validCol).width = 12;
    ws.getColumn(rejectedCol).width = 10;
    ws.getColumn(notaCol).width = 8;
    ws.getColumn(totalCol).width = 10;
    ws.getColumn(tenderedCol).width = 10;

    // ---- Data rows ----
    for (const booth of boothResults) {
      const votes = booth.candidate_votes || {};
      const rowData = [
        booth.serial_no,
        booth.booth_no,
        ...candidates.map((c) => votes[c.candidate_name] ?? 0),
        booth.total_valid_votes,
        booth.rejected_votes,
        booth.nota,
        booth.total_votes,
        booth.tendered_votes,
      ];
      const dataRow = ws.addRow(rowData);
      dataRow.eachCell((cell, colNum) => {
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = thinBorder;
        if (colNum >= candidateStartCol && colNum <= candidateEndCol) {
          cell.numFmt = "#,##0";
        }
      });
    }

    // ---- Totals rows ----
    const totalTypeLabels = {
      evm: "Total of votes recorded on EVM",
      postal: "Total of Postal Ballot Votes",
      total: "Total Votes Polled",
    };

    const totalFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE2EFDA" },
    };

    for (const total of totals) {
      const votes = total.candidate_votes || {};
      const rowData = [
        "",
        totalTypeLabels[total.total_type] || total.total_type,
        ...candidates.map((c) => votes[c.candidate_name] ?? 0),
        total.total_valid_votes,
        total.rejected_votes,
        total.nota,
        total.total_votes,
        total.tendered_votes,
      ];
      const totalRow = ws.addRow(rowData);
      totalRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = totalFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "medium" },
          left: { style: "thin" },
          bottom: { style: "medium" },
          right: { style: "thin" },
        };
      });
    }

    // ======== SHEET 2: Summary ========
    const sumWs = workbook.addWorksheet("Summary", {
      properties: { tabColor: { argb: "FF2E75B6" } },
    });
    sumWs.getColumn(1).width = 35;
    sumWs.getColumn(2).width = 25;

    sumWs.addRow(["Election Result Summary"]).font = { bold: true, size: 14 };
    sumWs.addRow([]);
    sumWs.addRow(["Constituency / Assembly", session.constituency || "N/A"]);
    sumWs.addRow([
      "Total Electors",
      session.total_electors?.toLocaleString() || "N/A",
    ]);
    sumWs.addRow(["Total Booths", boothResults.length]);
    sumWs.addRow(["Total Candidates", candidates.length]);
    sumWs.addRow(["Source File", session.original_filename || "N/A"]);
    sumWs.addRow([
      "Processed On",
      session.created_at
        ? new Date(session.created_at).toLocaleDateString()
        : "N/A",
    ]);
    sumWs.addRow([]);

    // Candidate-wise summary
    sumWs.addRow(["Candidate-wise Total Votes"]).font = {
      bold: true,
      size: 12,
    };
    const sumHeaderRow = sumWs.addRow(["Candidate Name", "Total Votes"]);
    sumHeaderRow.font = { bold: true };
    sumHeaderRow.eachCell((c) => {
      c.fill = headerFill;
      c.font = headerFont;
      c.border = thinBorder;
    });

    // Calculate totals from booth data
    for (const candidate of candidates) {
      let sum = 0;
      for (const booth of boothResults) {
        sum += (booth.candidate_votes || {})[candidate.candidate_name] || 0;
      }
      const r = sumWs.addRow([candidate.candidate_name, sum]);
      r.getCell(2).numFmt = "#,##0";
      r.eachCell((c) => (c.border = thinBorder));
    }

    // ======== SHEET 3: Booth Analysis ========
    const bWs = workbook.addWorksheet("Booth Analysis", {
      properties: { tabColor: { argb: "FF548235" } },
    });

    const bHeaders = [
      "Sl. No.",
      "Booth No.",
      "Winner",
      "Winner Votes",
      "Runner Up",
      "Runner Up Votes",
      "Margin",
      "Total Valid",
      "Total Votes",
    ];
    const bhRow = bWs.addRow(bHeaders);
    bhRow.eachCell((cell) => {
      cell.font = headerFont;
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF548235" },
      };
      cell.alignment = centerAlign;
      cell.border = thinBorder;
    });
    bHeaders.forEach((_, i) => {
      bWs.getColumn(i + 1).width = i <= 1 ? 10 : 18;
    });

    for (const booth of boothResults) {
      const votes = booth.candidate_votes || {};
      const sorted = Object.entries(votes).sort(
        ([, a], [, b]) => (b || 0) - (a || 0),
      );
      const winner = sorted[0] || ["N/A", 0];
      const runnerUp = sorted[1] || ["N/A", 0];
      const margin = (winner[1] || 0) - (runnerUp[1] || 0);

      const r = bWs.addRow([
        booth.serial_no,
        booth.booth_no,
        winner[0],
        winner[1],
        runnerUp[0],
        runnerUp[1],
        margin,
        booth.total_valid_votes,
        booth.total_votes,
      ]);
      r.eachCell((c) => {
        c.alignment = { horizontal: "center" };
        c.border = thinBorder;
      });
    }

    // ---- Send ----
    const fileName = `election_result_${(session.constituency || "unknown").replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const buffer = await workbook.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Excel export error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HELPER
// ============================================

function colLetter(num) {
  let s = "";
  while (num > 0) {
    const mod = (num - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

export default router;
