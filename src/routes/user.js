import express from "express";
import path from "path";
import fs from "fs-extra";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db.js";
import { authenticate } from "../auth.js";
import {
  ensureVoterSlipTemplateExists,
  buildSingleVoterSlipPdf,
  buildMassVoterSlipPdfFile,
  buildMassSlipFilename,
} from "../voterSlipPdf.js";
import {
  getVoterSlipLayout,
  getVoterSlipLayoutPath,
  getDefaultVoterSlipLayout,
  clearVoterSlipLayoutCache,
  saveVoterSlipLayout,
  getRequiredVoterSlipFields,
  buildVoterSlipLayoutFromBoxes,
  suggestVoterSlipFieldsFromBoxes,
} from "../voterSlipLayout.js";
import {
  getConfiguredVoterSlipTemplatePath,
  getVoterSlipTemplatePublicHint,
} from "../voterSlipTemplate.js";
import {
  normalizeBoothNo,
  extractBoothNoFromFilename,
  extractAssemblyNameFromFilename,
  canonicalizeAssemblyName,
} from "../boothLinking.js";
import {
  getCalibrationState,
  getManualProfiles,
  saveCalibrationState,
  upsertManualProfile,
  applyManualProfile,
  getVoterSlipCalibrationStatePath,
  getVoterSlipManualProfilesPath,
} from "../voterSlipCalibrationStore.js";
import {
  buildPaginationMeta,
  buildVoterFilterClause,
  parsePaginationParams,
  VOTER_DEFAULT_ORDER_SQL,
} from "../voterSearchFilters.js";

const router = express.Router();
const execFileAsync = promisify(execFile);

const voterSlipJobs = new Map();
const voterSlipJobsRoot = path.join(
  process.cwd(),
  "storage",
  "voter-slips",
  "jobs",
);

async function cleanupVoterSlipJobsOnStartup() {
  await fs.remove(voterSlipJobsRoot).catch(() => null);
  await fs.ensureDir(voterSlipJobsRoot).catch(() => null);
}

// On each server relaunch, purge stale mass-slip artifacts from disk.
void cleanupVoterSlipJobsOnStartup();

async function deleteMassJobArtifacts(job) {
  if (!job?.filePath) return;

  const filePath = job.filePath;
  const jobDir = path.dirname(filePath);

  job.filePath = null;
  job.downloadUrl = null;

  await fs.remove(filePath).catch(() => null);
  await fs.remove(jobDir).catch(() => null);
}

async function cleanupOldVoterSlipJobs() {
  const now = Date.now();
  const ttlMs = Number(
    process.env.VOTER_SLIP_JOB_TTL_MS || 24 * 60 * 60 * 1000,
  );

  for (const [jobId, job] of voterSlipJobs.entries()) {
    if (!job.finishedAt) continue;
    const finishedAtMs = new Date(job.finishedAt).getTime();
    if (Number.isNaN(finishedAtMs)) continue;

    if (now - finishedAtMs > ttlMs) {
      voterSlipJobs.delete(jobId);
      await deleteMassJobArtifacts(job);
    }
  }
}

function makeMassJobPublicView(job) {
  const canDownload =
    job.status === "completed" &&
    !job.downloadedAt &&
    !job.downloadFailedAt &&
    Boolean(job.filePath);

  return {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    filters: job.filters,
    fileName: job.fileName,
    downloadedAt: job.downloadedAt || null,
    downloadUrl: canDownload
      ? `/user/voterslips/mass/jobs/${job.id}/download`
      : null,
  };
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function cleanAssemblyDisplayLabel(value) {
  const text = normalizeText(value);
  if (!text) return "";

  return text
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:booth|part|no|number|ps)\b\s*[:#-]?\s*\d{1,4}[a-z]?/gi, " ")
    .replace(
      /(?:^|\s)(?:বুথ|পার্ট)\s*(?:নং|নম্বর)?\s*[:#-]?\s*\d{1,4}[a-z]?/gi,
      " ",
    )
    .replace(/^\s*\d{1,4}[a-z]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveAssemblyLabelFromRow(row) {
  const sessionAssembly = cleanAssemblyDisplayLabel(row.session_assembly);
  if (sessionAssembly) return sessionAssembly;

  const voterAssembly = cleanAssemblyDisplayLabel(row.voter_assembly);
  if (voterAssembly) return voterAssembly;

  return cleanAssemblyDisplayLabel(
    extractAssemblyNameFromFilename(row.original_filename),
  );
}

function isAdminUser(req) {
  return req?.user?.role === "admin";
}

function inferLayoutSource(layoutFileExists, layout) {
  if (!layoutFileExists) return "default";

  const version = String(layout?.version || "").toLowerCase();
  if (version.includes("gemini")) return "gemini";
  return "manual";
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}

function parseCalibrationMode(mode) {
  if (["manual", "gemini", "default"].includes(mode)) return mode;
  return null;
}

function summarizeManualProfiles(profiles) {
  return (profiles || []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
    source: profile.source || "manual-ui",
    version: profile?.layout?.version || null,
  }));
}

async function buildVoterSlipLayoutResponse(req) {
  const admin = isAdminUser(req);
  const layoutPath = getVoterSlipLayoutPath();
  const layoutFileExists = await fs.pathExists(layoutPath);
  const stat = layoutFileExists ? await fs.stat(layoutPath) : null;
  const layout = await getVoterSlipLayout();
  const source = inferLayoutSource(layoutFileExists, layout);
  const [calibrationState, manualProfiles] = await Promise.all([
    getCalibrationState(),
    admin ? getManualProfiles() : Promise.resolve([]),
  ]);

  return {
    layout,
    meta: {
      source,
      layoutFileExists,
      layoutPath: "storage/voter-slip-layout.json",
      templateFile: getVoterSlipTemplatePublicHint(),
      lastUpdated: stat ? stat.mtime.toISOString() : null,
      coordinateSystem: "normalized-bottom-left",
      permissions: {
        isAdmin: admin,
        canCalibrate: admin,
        canUseManualCalibration: admin,
      },
      calibration: {
        preferredMode: calibrationState.preferredMode,
        lastUsedMode: calibrationState.lastUsedMode,
        activeManualProfileId: admin
          ? calibrationState.activeManualProfileId
          : null,
        lastUsedManualProfileId: admin
          ? calibrationState.lastUsedManualProfileId
          : null,
        updatedAt: calibrationState.updatedAt,
        statePath: admin
          ? path
              .relative(process.cwd(), getVoterSlipCalibrationStatePath())
              .replaceAll("\\", "/")
          : null,
        profilesPath: admin
          ? path
              .relative(process.cwd(), getVoterSlipManualProfilesPath())
              .replaceAll("\\", "/")
          : null,
        profiles: admin ? summarizeManualProfiles(manualProfiles) : [],
        requiredFields: getRequiredVoterSlipFields(),
        endpoints: {
          getLayout: "/user/voterslips/layout",
          getTemplate: "/user/voterslips/layout/template.png",
          recalibrate: admin ? "/user/voterslips/layout/recalibrate" : null,
          reset: admin ? "/user/voterslips/layout/reset" : null,
          saveManual: admin ? "/user/voterslips/layout/manual" : null,
          autoLabelManualBoxes: admin
            ? "/user/voterslips/layout/manual/auto-labels"
            : null,
          applyManualProfile: admin
            ? "/user/voterslips/layout/manual/:profileId/apply"
            : null,
          listManualProfiles: admin
            ? "/user/voterslips/layout/manual/profiles"
            : null,
          setMode: admin ? "/user/voterslips/layout/mode" : null,
        },
      },
    },
  };
}

async function runVoterSlipCalibrationScript() {
  const scriptPath = path.join(
    process.cwd(),
    "scripts",
    "calibrateVoterSlipLayout.js",
  );

  return execFileAsync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });
}

function formatSerialSortSql(prefix = "v") {
  return `
    NULLIF(regexp_replace(${prefix}.serial_number, '[^0-9]', '', 'g'), '')::INT NULLS LAST,
    ${prefix}.serial_number,
    ${prefix}.id
  `;
}

function mapRowToSlipVoter(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    partNumber: row.part_number,
    boothNo: row.booth_no || row.part_number,
    boothName: row.booth_name,
    section: row.section,
    serialNumber: row.serial_number,
    name: row.name,
    relationName: row.relation_name,
    houseNumber: row.house_number,
    age: row.age,
    gender: row.gender,
  };
}

async function getVoterForSlipByParam(idParam) {
  const { column, value } = resolveVoterIdParam(idParam);
  const result = await query(
    `SELECT v.id, v.session_id, v.part_number, v.section, v.serial_number, v.name,
            v.relation_name, v.house_number, v.age, v.gender, v.voter_id,
            s.booth_no, s.booth_name
     FROM session_voters v
     LEFT JOIN sessions s ON s.id = v.session_id
     WHERE v.${column} = $1
     ORDER BY v.created_at DESC
     LIMIT 1`,
    [value],
  );

  if (result.rowCount === 0) return null;
  return mapRowToSlipVoter(result.rows[0]);
}

async function getMassSlipVoters(filters) {
  const where = [];
  const values = [];
  let idx = 1;

  if (filters.sessionId) {
    where.push(`v.session_id = $${idx}`);
    values.push(filters.sessionId);
    idx += 1;
  }

  const boothNo = normalizeText(filters.boothNo || filters.partNumber);
  if (boothNo) {
    where.push(`v.part_number = $${idx}`);
    values.push(boothNo);
    idx += 1;
  }

  if (filters.assembly) {
    where.push(`LOWER(v.assembly) LIKE $${idx}`);
    values.push(`%${String(filters.assembly).toLowerCase()}%`);
    idx += 1;
  }

  if (filters.section) {
    where.push(`LOWER(v.section) LIKE $${idx}`);
    values.push(`%${String(filters.section).toLowerCase()}%`);
    idx += 1;
  }

  if (where.length === 0) {
    throw new Error(
      "Mass generation needs at least boothNo/partNumber, sessionId, assembly, or section filter",
    );
  }

  const sql = `
    SELECT v.id, v.session_id, v.part_number, v.section, v.serial_number, v.name,
           v.relation_name, v.house_number, v.age, v.gender,
           s.booth_no, s.booth_name
    FROM session_voters v
    LEFT JOIN sessions s ON s.id = v.session_id
    WHERE ${where.join(" AND ")}
    ORDER BY ${formatSerialSortSql("v")};
  `;

  const result = await query(sql, values);
  return result.rows.map(mapRowToSlipVoter);
}

async function getSessionForMassSlip(sessionId) {
  const result = await query(
    `SELECT id, status, total_pages, processed_pages, assembly_name, booth_no, booth_name,
            original_filename,
            created_at, updated_at
     FROM sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId],
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

function buildSessionMassFilters(sessionId) {
  return {
    sessionId: normalizeText(sessionId),
    boothNo: "",
    partNumber: "",
    assembly: "",
    section: "",
  };
}

async function queueMassVoterSlipJob({
  voters,
  filters,
  requestedBy,
  boothNoForName,
}) {
  const fileName = buildMassSlipFilename(boothNoForName);
  const jobId = uuidv4();
  const filePath = path.join(voterSlipJobsRoot, jobId, fileName);

  const job = {
    id: jobId,
    status: "queued",
    total: voters.length,
    processed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    filters,
    fileName,
    filePath,
    downloadedAt: null,
    downloadFailedAt: null,
    requestedBy,
  };
  voterSlipJobs.set(jobId, job);

  setImmediate(async () => {
    try {
      job.status = "processing";
      await buildMassVoterSlipPdfFile(voters, filePath, {
        onProgress: (processed, total) => {
          job.processed = processed;
          job.total = total;
        },
      });
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "Mass slip generation failed";
      job.finishedAt = new Date().toISOString();
    }
  });

  return job;
}

async function startMassVoterSlipBySession(req, res, sessionIdInput) {
  await cleanupOldVoterSlipJobs();

  const hasTemplate = await ensureVoterSlipTemplateExists();
  if (!hasTemplate) {
    return res.status(500).json({
      error: "Voter slip template not found",
      expectedPath: getVoterSlipTemplatePublicHint(),
    });
  }

  const sessionId = normalizeText(sessionIdInput);
  if (!sessionId) {
    return res.status(400).json({
      error: "sessionId is required",
      example:
        "POST /user/voterslips/mass/sessions/:sessionId/start or body: { sessionId }",
    });
  }

  const session = await getSessionForMassSlip(sessionId);
  if (!session) {
    return res.status(404).json({
      error: "Session not found",
      sessionId,
    });
  }

  const filters = buildSessionMassFilters(sessionId);
  const voters = await getMassSlipVoters(filters);
  if (!voters.length) {
    return res.status(404).json({
      error: "No voters found for this session",
      sessionId,
    });
  }

  const boothNoForName =
    normalizeBoothNo(
      session.booth_no ||
        extractBoothNoFromFilename(session.original_filename) ||
        voters[0]?.boothNo ||
        voters[0]?.partNumber ||
        "",
    ) || "unknown";

  const job = await queueMassVoterSlipJob({
    voters,
    filters,
    requestedBy: req.user.id,
    boothNoForName,
  });

  return res.status(202).json({
    message: "Mass voter slip generation started for session",
    session: {
      id: session.id,
      status: session.status,
      totalPages: session.total_pages,
      processedPages: session.processed_pages,
      assemblyName: session.assembly_name,
      boothNo: session.booth_no,
      boothName: session.booth_name,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
    job: makeMassJobPublicView(job),
  });
}

// All user routes require authentication
router.use(authenticate);

/**
 * Helper: detect whether param is a numeric DB id or an alphanumeric voter_id.
 * Returns { column, value } for use in WHERE clause.
 */
function resolveVoterIdParam(idParam) {
  // Pure digits = numeric DB id; anything else = voter_id text
  if (/^\d+$/.test(idParam)) {
    return { column: "id", value: idParam };
  }
  return { column: "voter_id", value: idParam };
}

/**
 * Get all available assemblies (for dropdown/selection)
 * Users can search across all assemblies, regardless of sessions
 */
router.get("/assemblies", async (req, res) => {
  try {
    const sessionId = normalizeText(req.query?.sessionId);
    if (sessionId && !isUuidLike(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }

    const values = [];
    let where = "";
    if (sessionId) {
      values.push(sessionId);
      where = "WHERE s.id = $1";
    }

    const sql = `
      SELECT s.id AS session_id,
             s.original_filename,
             s.assembly_name AS session_assembly,
             v.assembly AS voter_assembly,
             COUNT(v.id)::int AS voter_count
      FROM sessions s
      LEFT JOIN session_voters v ON v.session_id = s.id
      ${where}
      GROUP BY s.id, s.original_filename, s.assembly_name, v.assembly
      ORDER BY s.created_at DESC;
    `;
    const result = await query(sql, values);

    const grouped = new Map();
    for (const row of result.rows) {
      const label = resolveAssemblyLabelFromRow(row);
      const key = canonicalizeAssemblyName(label);
      if (!key) continue;

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          assembly: label,
          voter_count: Number(row.voter_count || 0),
          session_count: 1,
          canonical_key: key,
        });
        continue;
      }

      existing.voter_count += Number(row.voter_count || 0);
      existing.session_count += 1;

      // Prefer shorter, cleaner labels when duplicates exist.
      if (
        label &&
        (existing.assembly.length > label.length ||
          existing.assembly.includes("-") ||
          existing.assembly.includes("_") ||
          /\d/.test(existing.assembly))
      ) {
        existing.assembly = label;
      }
    }

    const assemblies = [...grouped.values()].sort((a, b) =>
      a.assembly.localeCompare(b.assembly, undefined, { sensitivity: "base" }),
    );

    res.json({
      assemblies,
      meta: {
        source: sessionId ? "session-scoped" : "global",
        sessionId: sessionId || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all part numbers for a given assembly
 */
router.get("/assemblies/:assembly/parts", async (req, res) => {
  try {
    const { assembly } = req.params;
    const sessionId = normalizeText(req.query?.sessionId);
    if (sessionId && !isUuidLike(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }

    const targetKey = canonicalizeAssemblyName(assembly);
    if (!targetKey) {
      return res.json({ parts: [] });
    }

    const sql = `
      SELECT v.part_number,
             v.assembly AS voter_assembly,
             s.assembly_name AS session_assembly,
             s.original_filename,
             COUNT(v.id)::int AS voter_count
      FROM session_voters v
      LEFT JOIN sessions s ON s.id = v.session_id
      WHERE v.part_number IS NOT NULL AND v.part_number != ''
        AND ($1::uuid IS NULL OR v.session_id = $1)
      GROUP BY v.part_number, v.assembly, s.assembly_name, s.original_filename
      ORDER BY v.part_number;
    `;
    const result = await query(sql, [sessionId || null]);

    const grouped = new Map();
    for (const row of result.rows) {
      const label = resolveAssemblyLabelFromRow(row);
      const key = canonicalizeAssemblyName(label);
      if (key !== targetKey) continue;

      const normalizedPart = normalizeBoothNo(row.part_number);
      if (!normalizedPart) continue;

      const existing = grouped.get(normalizedPart) || {
        part_number: normalizedPart,
        voter_count: 0,
      };
      existing.voter_count += Number(row.voter_count || 0);
      grouped.set(normalizedPart, existing);
    }

    const parts = [...grouped.values()].sort((a, b) => {
      const aNum = Number.parseInt(String(a.part_number).match(/\d+/)?.[0], 10);
      const bNum = Number.parseInt(String(b.part_number).match(/\d+/)?.[0], 10);

      if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && aNum !== bNum) {
        return aNum - bNum;
      }

      return String(a.part_number).localeCompare(String(b.part_number));
    });

    res.json({
      parts,
      meta: {
        assembly,
        canonicalKey: targetKey,
        sessionId: sessionId || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Search voters across all sessions (User accessible)
 * Supports global voter filters with pagination.
 * Does NOT expose session information to users
 */
router.get("/voters/search", async (req, res) => {
  try {
    const { page, limit, offset } = parsePaginationParams(req.query, {
      defaultPage: 1,
      defaultLimit: 50,
      maxLimit: 200,
    });
    const { where, values, nextIndex } = buildVoterFilterClause(req.query, {
      startIndex: 1,
    });
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*)::int as total FROM session_voters ${whereSql}`;
    const countResult = await query(countSql, values);
    const total = countResult.rows[0].total;

    const sql = `
      SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
             relation_type, relation_name, house_number, age, gender, photo_url
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get voter details by Voter ID (the actual voter_id field)
 * MUST be registered BEFORE /voters/:id to avoid Express matching "by-voter-id" as :id
 */
router.get("/voters/by-voter-id/:voterId", async (req, res) => {
  try {
    const { voterId } = req.params;
    const result = await query(
      `SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
              relation_type, relation_name, house_number, age, gender, photo_url,
              religion, is_printed, printed_at, session_id
       FROM session_voters 
       WHERE voter_id = $1
       ORDER BY created_at DESC`,
      [voterId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    // If multiple records found (same voter in different uploads), return all
    res.json({
      voter: result.rows[0],
      allRecords: result.rows,
      count: result.rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Mark voter as printed (User accessible)
 * Records who printed and when
 * MUST be before the wildcard /voters/:id(*) route
 */
router.post("/voters/:id/print", async (req, res) => {
  try {
    const { column, value } = resolveVoterIdParam(req.params.id);
    const userId = req.user.id;

    // Get voter first
    const voterCheck = await query(
      `SELECT id, is_printed FROM session_voters WHERE ${column} = $1 LIMIT 1`,
      [value],
    );
    if (voterCheck.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    const dbId = voterCheck.rows[0].id;

    // Update print status using the resolved numeric id
    const result = await query(
      `UPDATE session_voters 
       SET is_printed = true, printed_at = now(), printed_by = $1 
       WHERE id = $2 
       RETURNING id, voter_id, name, assembly, part_number, is_printed, printed_at`,
      [userId, dbId],
    );

    res.json({
      message: "Voter marked as printed",
      voter: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get print-ready voter card data
 * MUST be before the wildcard /voters/:id(*) route
 */
router.get("/voters/:id/print-data", async (req, res) => {
  try {
    const { column, value } = resolveVoterIdParam(req.params.id);
    const result = await query(
      `SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
              relation_type, relation_name, house_number, age, gender, photo_url
       FROM session_voters 
       WHERE ${column} = $1
       LIMIT 1`,
      [value],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    const voter = result.rows[0];

    // Format data for printing
    const printData = {
      header: {
        title: "VOTER INFORMATION SLIP",
        assembly: voter.assembly,
        partNumber: voter.part_number,
        section: voter.section,
      },
      voter: {
        serialNumber: voter.serial_number,
        voterId: voter.voter_id,
        name: voter.name,
        relationType: voter.relation_type,
        relationName: voter.relation_name,
        houseNumber: voter.house_number,
        age: voter.age,
        gender: voter.gender,
      },
      footer: {
        generatedAt: new Date().toISOString(),
        disclaimer:
          "This is an unofficial voter information slip for reference purposes only.",
      },
    };

    res.json(printData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendSingleVoterSlip(req, res, idParam) {
  try {
    const idValue = idParam || req.query.id;
    if (!idValue) {
      return res.status(400).json({
        error: "id query parameter is required",
        example: "/user/voters/voterslip.pdf?id=123",
      });
    }

    const hasTemplate = await ensureVoterSlipTemplateExists();
    if (!hasTemplate) {
      return res.status(500).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }

    const voter = await getVoterForSlipByParam(idValue);
    if (!voter) {
      return res.status(404).json({ error: "Voter not found" });
    }

    const pdfBytes = await buildSingleVoterSlipPdf(voter);
    const serial = normalizeText(voter.serialNumber || "unknown");
    const partNo = normalizeText(
      voter.boothNo || voter.partNumber || "unknown",
    );
    const fileName = `voterslip-part-${partNo}-serial-${serial}.pdf`
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .toLowerCase();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Download a single voter slip PDF using the new template.
 * Works with DB numeric id OR voter id (including query param path-safe option).
 */
router.get("/voters/voterslip.pdf", async (req, res) => {
  return sendSingleVoterSlip(req, res, req.query.id);
});

/**
 * Alternate path form for single voter slip.
 */
router.get("/voters/:id/voterslip.pdf", async (req, res) => {
  return sendSingleVoterSlip(req, res, req.params.id);
});

/**
 * Get active voter slip layout metadata and field boxes for frontend overlay.
 */
router.get("/voterslips/layout", async (req, res) => {
  try {
    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Backward-compatible alias for older frontend path.
 */
router.get("/voterslips/calibration", async (req, res) => {
  try {
    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Serve the voter slip template image for calibration/overlay UIs.
 */
router.get("/voterslips/layout/template.png", async (_req, res) => {
  try {
    const templatePath = getConfiguredVoterSlipTemplatePath();
    const exists = await fs.pathExists(templatePath);
    if (!exists) {
      return res.status(404).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }
    return res.sendFile(templatePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Backward-compatible alias for older frontend path.
 */
router.get("/voterslips/calibration/template.png", async (_req, res) => {
  try {
    const templatePath = getConfiguredVoterSlipTemplatePath();
    const exists = await fs.pathExists(templatePath);
    if (!exists) {
      return res.status(404).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }
    return res.sendFile(templatePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get saved manual calibration profiles and preference state.
 */
router.get("/voterslips/layout/manual/profiles", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can view manual voter slip profiles",
      });
    }

    const [state, profiles] = await Promise.all([
      getCalibrationState(),
      getManualProfiles(),
    ]);

    return res.json({
      state,
      profiles: summarizeManualProfiles(profiles),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Preview auto-generated field labels from manually selected boxes.
 * Admin only.
 */
router.post("/voterslips/layout/manual/auto-labels", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can use manual auto-labels",
      });
    }

    const boxes = req.body?.boxes;
    if (!Array.isArray(boxes) || !boxes.length) {
      return res.status(400).json({
        error: "boxes array is required",
      });
    }

    const suggestion = suggestVoterSlipFieldsFromBoxes(boxes);
    return res.json({
      message: "Auto labels generated from selected boxes",
      fields: suggestion.fields,
      mapping: suggestion.mapping,
      missingInputCount: suggestion.missingInputCount,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Save a manual calibration layout from UI-selected boxes.
 * Admin only.
 */
router.post("/voterslips/layout/manual", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can save manual voter slip layouts",
      });
    }

    const fieldsInput = req.body?.fields;
    const boxesInput = req.body?.boxes;
    const hasFields = fieldsInput && typeof fieldsInput === "object";
    const hasBoxes = Array.isArray(boxesInput) && boxesInput.length > 0;

    if (!hasFields && !hasBoxes) {
      return res.status(400).json({
        error: "Either fields object or boxes array is required",
      });
    }

    let fields = fieldsInput;
    let autoLabelResult = null;
    if (!hasFields && hasBoxes) {
      autoLabelResult = buildVoterSlipLayoutFromBoxes(boxesInput, {
        versionPrefix: "manual-auto",
      });
      fields = autoLabelResult.layout.fields;
    }

    const profileId = normalizeText(req.body?.profileId) || uuidv4();
    const profileName = normalizeText(req.body?.name) || "Manual Layout";
    const activate = toBoolean(req.body?.activate, true);
    const setPreferred = toBoolean(req.body?.setPreferred, true);

    const { profile, state } = await upsertManualProfile({
      id: profileId,
      name: profileName,
      fields,
      activate,
      setPreferred,
    });

    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json({
      message: "Manual voter slip layout saved",
      profile: {
        id: profile.id,
        name: profile.name,
        version: profile?.layout?.version || null,
        updatedAt: profile.updatedAt,
      },
      autoLabel: autoLabelResult
        ? {
            mapping: autoLabelResult.mapping,
            missingInputCount: autoLabelResult.missingInputCount,
          }
        : null,
      state,
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Apply one of the saved manual layout profiles as active.
 * Admin only.
 */
router.post("/voterslips/layout/manual/:profileId/apply", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can apply manual voter slip layouts",
      });
    }

    const profileId = normalizeText(req.params.profileId);
    if (!profileId) {
      return res.status(400).json({ error: "profileId is required" });
    }

    const setPreferred = toBoolean(req.body?.setPreferred, true);
    const result = await applyManualProfile(profileId, { setPreferred });
    if (!result) {
      return res.status(404).json({ error: "Manual layout profile not found" });
    }

    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json({
      message: "Manual voter slip layout applied",
      profile: {
        id: result.profile.id,
        name: result.profile.name,
        version: result.profile?.layout?.version || null,
      },
      state: result.state,
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Persist preferred calibration mode so UI does not need to ask repeatedly.
 * Admin only.
 */
router.patch("/voterslips/layout/mode", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can change calibration mode",
      });
    }

    const mode = parseCalibrationMode(req.body?.preferredMode);
    if (!mode) {
      return res.status(400).json({
        error: "preferredMode must be one of: manual, gemini, default",
      });
    }

    if (mode === "manual") {
      const requestedProfileId = normalizeText(req.body?.profileId);
      const currentState = await getCalibrationState();
      const profileId =
        requestedProfileId ||
        currentState.activeManualProfileId ||
        currentState.lastUsedManualProfileId;

      if (!profileId) {
        return res.status(400).json({
          error: "No manual profile found. Save manual layout first.",
        });
      }

      const applied = await applyManualProfile(profileId, {
        setPreferred: true,
      });
      if (!applied) {
        return res.status(404).json({
          error: "Manual layout profile not found",
        });
      }
    } else if (mode === "default") {
      await saveVoterSlipLayout(getDefaultVoterSlipLayout());
      await saveCalibrationState({
        preferredMode: "default",
        lastUsedMode: "default",
        activeManualProfileId: null,
      });
    } else {
      await saveCalibrationState({
        preferredMode: "gemini",
        lastUsedMode: "gemini",
      });
    }

    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json({
      message: `Calibration mode updated to ${mode}`,
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Recalibrate layout using Gemini OCR script and return updated layout.
 * Admin only.
 */
router.post("/voterslips/layout/recalibrate", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can recalibrate voter slip layout",
      });
    }

    const hasTemplate = await ensureVoterSlipTemplateExists();
    if (!hasTemplate) {
      return res.status(500).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }

    let scriptOutput = "";
    try {
      const { stdout, stderr } = await runVoterSlipCalibrationScript();
      scriptOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
    } catch (scriptErr) {
      const stderr = scriptErr?.stderr ? String(scriptErr.stderr) : "";
      const stdout = scriptErr?.stdout ? String(scriptErr.stdout) : "";
      return res.status(500).json({
        error: "Gemini calibration failed",
        details:
          [stderr, stdout].filter(Boolean).join("\n").trim() ||
          scriptErr.message,
      });
    }

    clearVoterSlipLayoutCache();
    await saveCalibrationState({
      lastUsedMode: "gemini",
    });
    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json({
      message: "Voter slip layout recalibrated",
      scriptOutput,
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Backward-compatible alias for older frontend path.
 */
router.post("/voterslips/recalibrate", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can recalibrate voter slip layout",
      });
    }

    const hasTemplate = await ensureVoterSlipTemplateExists();
    if (!hasTemplate) {
      return res.status(500).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }

    let scriptOutput = "";
    try {
      const { stdout, stderr } = await runVoterSlipCalibrationScript();
      scriptOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
    } catch (scriptErr) {
      const stderr = scriptErr?.stderr ? String(scriptErr.stderr) : "";
      const stdout = scriptErr?.stdout ? String(scriptErr.stdout) : "";
      return res.status(500).json({
        error: "Gemini calibration failed",
        details:
          [stderr, stdout].filter(Boolean).join("\n").trim() ||
          scriptErr.message,
      });
    }

    clearVoterSlipLayoutCache();
    await saveCalibrationState({
      lastUsedMode: "gemini",
    });
    const payload = await buildVoterSlipLayoutResponse(req);
    return res.json({
      message: "Voter slip layout recalibrated",
      scriptOutput,
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Revert custom layout and force default layout usage.
 * Admin only.
 */
router.post("/voterslips/layout/reset", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can reset voter slip layout",
      });
    }

    const layoutPath = getVoterSlipLayoutPath();
    await fs.remove(layoutPath);
    clearVoterSlipLayoutCache();
    await saveCalibrationState({
      preferredMode: "default",
      lastUsedMode: "default",
      activeManualProfileId: null,
    });

    const payload = await buildVoterSlipLayoutResponse(req);

    return res.json({
      message: "Voter slip layout reverted to default",
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Backward-compatible alias for older frontend path.
 */
router.post("/voterslips/revert", async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only admin users can reset voter slip layout",
      });
    }

    const layoutPath = getVoterSlipLayoutPath();
    await fs.remove(layoutPath);
    clearVoterSlipLayoutCache();
    await saveCalibrationState({
      preferredMode: "default",
      lastUsedMode: "default",
      activeManualProfileId: null,
    });

    const payload = await buildVoterSlipLayoutResponse(req);

    return res.json({
      message: "Voter slip layout reverted to default",
      ...payload,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Start async mass generation of voter slips as one PDF.
 * Body example: { boothNo: "42", assembly: "Barasat", section: "A" }
 */
router.post("/voterslips/mass/start", async (req, res) => {
  try {
    await cleanupOldVoterSlipJobs();

    const hasTemplate = await ensureVoterSlipTemplateExists();
    if (!hasTemplate) {
      return res.status(500).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }

    const filters = {
      sessionId: normalizeText(req.body?.sessionId),
      boothNo: normalizeText(req.body?.boothNo),
      partNumber: normalizeText(req.body?.partNumber),
      assembly: normalizeText(req.body?.assembly),
      section: normalizeText(req.body?.section),
    };

    const voters = await getMassSlipVoters(filters);
    if (!voters.length) {
      return res.status(404).json({
        error: "No voters found for selected filters",
        filters,
      });
    }

    const boothNoForName =
      filters.boothNo || filters.partNumber || voters[0].boothNo;
    const job = await queueMassVoterSlipJob({
      voters,
      filters,
      requestedBy: req.user.id,
      boothNoForName,
    });

    return res.status(202).json({
      message: "Mass voter slip generation started",
      job: makeMassJobPublicView(job),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Start async mass generation for an exact voter-list session.
 * This route does not require assembly/part/section in request body.
 */
router.post("/voterslips/mass/sessions/:sessionId/start", async (req, res) => {
  try {
    return await startMassVoterSlipBySession(req, res, req.params.sessionId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Body-based alias for frontend flows that already keep sessionId in state.
 * Body example: { sessionId: "uuid" }
 */
router.post("/voterslips/mass/current-session/start", async (req, res) => {
  try {
    return await startMassVoterSlipBySession(req, res, req.body?.sessionId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Poll status for mass generation jobs.
 */
router.get("/voterslips/mass/jobs/:jobId", async (req, res) => {
  try {
    await cleanupOldVoterSlipJobs();

    const job = voterSlipJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.requestedBy !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "You cannot access this job" });
    }

    return res.json({ job: makeMassJobPublicView(job) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Download completed mass generation output PDF.
 */
router.get("/voterslips/mass/jobs/:jobId/download", async (req, res) => {
  try {
    await cleanupOldVoterSlipJobs();

    const job = voterSlipJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.requestedBy !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "You cannot access this job" });
    }

    if (job.status !== "completed") {
      return res.status(409).json({
        error: "Job is not completed yet",
        job: makeMassJobPublicView(job),
      });
    }

    if (job.downloadedAt) {
      return res.status(410).json({
        error: "This generated PDF was already downloaded and removed",
        job: makeMassJobPublicView(job),
      });
    }

    const exists = await fs.pathExists(job.filePath);
    if (!exists) {
      return res.status(404).json({
        error: "Generated file not found on disk",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${job.fileName}"`,
    );

    return res.download(job.filePath, job.fileName, async (err) => {
      if (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: err.message || "Download failed" });
        }
        return;
      }

      job.downloadedAt = new Date().toISOString();
      job.downloadFailedAt = null;
      await deleteMassJobArtifacts(job);
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Catch-all for voter IDs — handles both normal IDs and IDs with slashes
 * (e.g. WB/01/003/000070). Express treats slashes as path separators,
 * so this wildcard route catches everything.
 * MUST be LAST among /voters/* routes to avoid eating /print, /print-data etc.
 */
router.get("/voters/:id(*)", async (req, res) => {
  try {
    const rawId = req.params.id || req.params[0];
    const { column, value } = resolveVoterIdParam(rawId);
    const result = await query(
      `SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
              relation_type, relation_name, house_number, age, gender, photo_url,
              religion, is_printed, printed_at, session_id
       FROM session_voters 
       WHERE ${column} = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [value],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Voter not found",
        voterId: rawId,
        note: "This voter ID may not be a valid EPIC number. Try searching by name instead.",
      });
    }

    res.json({ voter: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get user's own profile
 */
router.get("/profile", async (req, res) => {
  try {
    const result = await query(
      "SELECT id, email, name, phone, role, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update user's own profile
 */
router.patch("/profile", async (req, res) => {
  try {
    const { name, phone } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx}`);
      values.push(name);
      idx++;
    }

    if (phone !== undefined) {
      updates.push(`phone = $${idx}`);
      values.push(phone);
      idx++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push(`updated_at = now()`);
    values.push(req.user.id);

    const sql = `UPDATE users SET ${updates.join(
      ", ",
    )} WHERE id = $${idx} RETURNING id, email, name, phone, role`;
    const result = await query(sql, values);

    res.json({ message: "Profile updated", user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
