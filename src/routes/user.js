import express from "express";
import path from "path";
import os from "os";
import fs from "fs-extra";
import multer from "multer";
import AdmZip from "adm-zip";
import { execFile, fork } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db.js";
import { authenticate } from "../auth.js";
import { splitPdfToPages } from "../pdf.js";
import { callGeminiWithFile, getGlobalDispatchMode } from "../gemini.js";
import { parseGeminiStructured } from "../parser.js";
import {
  ensureVoterSlipTemplateExists,
  buildSingleVoterSlipPdf,
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
const boothRangeMaxSpan = Math.max(
  Number(process.env.VOTER_SLIP_RANGE_MAX_SPAN || 200),
  1,
);
const boothRangePerSlipPauseMs = Math.max(
  Number(process.env.VOTER_SLIP_RANGE_FILE_PAUSE_MS || 0),
  0,
);
const boothRangePerBoothPauseMs = Math.max(
  Number(process.env.VOTER_SLIP_RANGE_BOOTH_PAUSE_MS || 0),
  0,
);
const massSlipWorkerScriptPath = path.join(
  process.cwd(),
  "src",
  "workers",
  "massVoterSlipWorker.js",
);
const massSlipJobQueue = [];
let activeMassSlipWorkers = 0;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const massSlipJobConcurrency = parsePositiveInt(
  process.env.VOTER_SLIP_MASS_JOB_CONCURRENCY,
  Math.max(1, Math.min(2, os.cpus()?.length || 1)),
);
const massSlipProgressStep = parsePositiveInt(
  process.env.VOTER_SLIP_MASS_PROGRESS_STEP,
  20,
);
const maxUploadMb = Math.max(Number(process.env.MAX_UPLOAD_MB || 150), 10);
const maxUploadBytes = maxUploadMb * 1024 * 1024;

const specificVoterSlipUploadRoot = path.join(
  process.cwd(),
  "storage",
  "voter-slips",
  "specific-uploads",
);
const specificUploadAllowedMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);
const specificUploadAllowedExtensions = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
]);

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeVoterId(rawId) {
  const trimmed = normalizeText(rawId);
  if (!trimmed) return "";
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

function normalizeSerialNumberForLookup(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return String(parsed);
}

function isAcceptedSpecificUploadFieldName(fieldName) {
  const normalized = String(fieldName || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "files" ||
    normalized === "file" ||
    /^files\[\d*\]$/.test(normalized)
  );
}

function getSpecificUploadFieldCounts(reqFiles) {
  const counts = {};
  for (const item of reqFiles || []) {
    const key = String(item?.fieldname || "");
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isAcceptedSpecificUploadFile(file) {
  const mime = String(file?.mimetype || "")
    .trim()
    .toLowerCase();
  if (specificUploadAllowedMimeTypes.has(mime)) {
    return true;
  }

  const ext = path.extname(String(file?.originalname || "")).toLowerCase();
  return specificUploadAllowedExtensions.has(ext);
}

function isImageSpecificUpload(inputMimeType, fileNameOrPath = "") {
  const normalizedMime = String(inputMimeType || "")
    .trim()
    .toLowerCase();
  if (normalizedMime.startsWith("image/")) {
    return true;
  }

  const ext = path.extname(String(fileNameOrPath || "")).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

const specificVoterSlipUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const uploadId = req.specificSlipUploadId || uuidv4();
        req.specificSlipUploadId = uploadId;
        const dest = path.join(
          specificVoterSlipUploadRoot,
          uploadId,
          "uploads",
        );
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
    if (!isAcceptedSpecificUploadFile(file)) {
      cb(new Error("Only PDF, PNG, JPG, JPEG uploads are allowed"));
      return;
    }
    cb(null, true);
  },
  limits: {
    fileSize: maxUploadBytes,
    files: 80,
  },
});

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

async function deleteMassJobPayload(job) {
  if (!job?.payloadPath) return;

  const payloadPath = job.payloadPath;
  job.payloadPath = null;

  await fs.remove(payloadPath).catch(() => null);
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
  const queuePosition =
    job.status === "queued"
      ? massSlipJobQueue.findIndex((queuedJob) => queuedJob.id === job.id) + 1
      : null;
  const canDownload =
    job.status === "completed" &&
    !job.downloadedAt &&
    !job.downloadFailedAt &&
    Boolean(job.filePath);

  return {
    id: job.id,
    jobType: job.jobType || "mass-pdf",
    status: job.status,
    total: job.total,
    processed: job.processed,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    filters: job.filters,
    boothRange: job.boothRange || null,
    progress: job.progress || null,
    queuePosition: queuePosition > 0 ? queuePosition : null,
    fileName: job.fileName,
    contentType: job.contentType || "application/pdf",
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

function sanitizeFilenameToken(value, fallback = "unknown") {
  const text = normalizeText(value);
  if (!text) return fallback;

  const cleaned = text
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return cleaned || fallback;
}

function parseBoothNumber(value) {
  const normalized = normalizeBoothNo(value);
  if (!normalized) return null;

  const digits = normalized.match(/\d+/)?.[0];
  if (!digits) return null;

  const parsed = Number.parseInt(digits, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveSessionBoothNo(sessionLike) {
  const fromSession = normalizeBoothNo(sessionLike?.booth_no || "");
  if (fromSession) return fromSession;

  const fromFilename = normalizeBoothNo(
    extractBoothNoFromFilename(sessionLike?.original_filename || ""),
  );
  if (fromFilename) return fromFilename;

  return "";
}

function parseBoothRangePayload(body) {
  const source = body && typeof body === "object" ? body : {};

  let fromBoothNo = parseBoothNumber(
    source.fromBoothNo ?? source.from ?? source.start,
  );
  let toBoothNo = parseBoothNumber(source.toBoothNo ?? source.to ?? source.end);

  const rangeText = normalizeText(
    source.boothRange ?? source.range ?? source.boothNoRange,
  );

  if (rangeText && (fromBoothNo === null || toBoothNo === null)) {
    const rangeMatch = rangeText.match(/^(\d{1,4})\s*(?:-|to|:)\s*(\d{1,4})$/i);
    if (rangeMatch) {
      fromBoothNo = Number.parseInt(rangeMatch[1], 10);
      toBoothNo = Number.parseInt(rangeMatch[2], 10);
    } else {
      const singleBoothNo = parseBoothNumber(rangeText);
      if (singleBoothNo !== null) {
        fromBoothNo = singleBoothNo;
        toBoothNo = singleBoothNo;
      }
    }
  }

  if (fromBoothNo === null || toBoothNo === null) {
    return {
      error:
        "Invalid booth range. Provide boothRange like '1-50' or fromBoothNo/toBoothNo",
    };
  }

  if (fromBoothNo > toBoothNo) {
    [fromBoothNo, toBoothNo] = [toBoothNo, fromBoothNo];
  }

  const span = toBoothNo - fromBoothNo + 1;
  if (span > boothRangeMaxSpan) {
    return {
      error: `Booth range too large. Maximum allowed span is ${boothRangeMaxSpan}`,
      maxSpan: boothRangeMaxSpan,
    };
  }

  return {
    fromBoothNo,
    toBoothNo,
    span,
  };
}

function buildBoothRangeZipFilename(fromBoothNo, toBoothNo) {
  const fromToken = sanitizeFilenameToken(fromBoothNo, "from");
  const toToken = sanitizeFilenameToken(toBoothNo, "to");
  return `voterslips-booths-${fromToken}-${toToken}.zip`;
}

function withBoothPartNo(voter, boothNo) {
  const resolvedBoothNo =
    normalizeBoothNo(boothNo) ||
    normalizeBoothNo(voter?.boothNo) ||
    normalizeBoothNo(voter?.partNumber) ||
    normalizeText(boothNo);

  if (!resolvedBoothNo) return voter;

  return {
    ...voter,
    boothNo: resolvedBoothNo,
    partNumber: resolvedBoothNo,
  };
}

function buildRangeZipEntryName({ boothNo, voter, index }) {
  const safeBooth = sanitizeFilenameToken(boothNo, "unknown");
  const safeSerial = sanitizeFilenameToken(voter?.serialNumber, "na");
  const safeVoterId = sanitizeFilenameToken(voter?.id || index + 1, "voter");

  return `booth-${safeBooth}/voterslip-booth-${safeBooth}-serial-${safeSerial}-voter-${safeVoterId}.pdf`;
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
    underAdjudication: row.under_adjudication === true,
  };
}

async function getVoterForSlipByParam(idParam) {
  const { column, value } = resolveVoterIdParam(idParam);
  const result = await query(
    `SELECT v.id, v.session_id, v.part_number, v.section, v.serial_number, v.name,
            v.relation_name, v.house_number, v.age, v.gender, v.voter_id,
            v.under_adjudication,
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
           v.relation_name, v.house_number, v.age, v.gender, v.under_adjudication,
           s.booth_no, s.booth_name
    FROM session_voters v
    LEFT JOIN sessions s ON s.id = v.session_id
    WHERE ${where.join(" AND ")}
      AND COALESCE(v.under_adjudication, FALSE) = FALSE;
  `;

  const result = await query(sql, values);
  return result.rows.map(mapRowToSlipVoter);
}

async function getMassSlipVotersBySessionIds(sessionIds) {
  const votersBySession = new Map();
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return votersBySession;
  }

  const result = await query(
    `SELECT v.id, v.session_id, v.part_number, v.section, v.serial_number, v.name,
            v.relation_name, v.house_number, v.age, v.gender, v.under_adjudication,
            s.booth_no, s.booth_name
     FROM session_voters v
     LEFT JOIN sessions s ON s.id = v.session_id
     WHERE v.session_id = ANY($1::uuid[])
       AND COALESCE(v.under_adjudication, FALSE) = FALSE
     ORDER BY v.session_id, ${formatSerialSortSql("v")};`,
    [sessionIds],
  );

  for (const row of result.rows) {
    const voter = mapRowToSlipVoter(row);
    const existing = votersBySession.get(voter.sessionId);
    if (existing) {
      existing.push(voter);
      continue;
    }

    votersBySession.set(voter.sessionId, [voter]);
  }

  return votersBySession;
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

function scheduleMassSlipWorkers() {
  while (
    activeMassSlipWorkers < massSlipJobConcurrency &&
    massSlipJobQueue.length > 0
  ) {
    const nextJob = massSlipJobQueue.shift();
    if (!nextJob) break;
    void runMassSlipWorkerJob(nextJob);
  }
}

function runMassSlipWorkerProcess(job) {
  return new Promise((resolve, reject) => {
    const worker = fork(massSlipWorkerScriptPath, [], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let settled = false;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    worker.on("message", (message) => {
      const type = message?.type;

      if (type === "progress") {
        const processed = Number(message?.processed);
        const total = Number(message?.total);

        if (Number.isFinite(processed)) {
          job.processed = Math.max(0, Math.trunc(processed));
        }
        if (Number.isFinite(total)) {
          job.total = Math.max(0, Math.trunc(total));
        }
        return;
      }

      if (type === "completed") {
        const total = Number(message?.total);
        if (Number.isFinite(total)) {
          job.total = Math.max(0, Math.trunc(total));
        }
        job.processed = job.total;
        finishResolve();
        return;
      }

      if (type === "failed") {
        finishReject(
          new Error(message?.error || "Mass slip generation worker failed"),
        );
      }
    });

    worker.on("error", (error) => {
      finishReject(error);
    });

    worker.on("exit", (code, signal) => {
      if (settled) return;

      if (code === 0) {
        finishResolve();
        return;
      }

      const signalText = signal ? ` signal=${signal}` : "";
      finishReject(
        new Error(
          `Mass slip worker exited with code=${code ?? "unknown"}${signalText}`,
        ),
      );
    });

    worker.send({
      type: "start",
      payloadPath: job.payloadPath,
      outputPath: job.filePath,
      progressStep: massSlipProgressStep,
    });
  });
}

async function runMassSlipWorkerJob(job) {
  activeMassSlipWorkers += 1;

  try {
    job.status = "processing";
    await runMassSlipWorkerProcess(job);
    job.status = "completed";
    job.error = null;
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error = error?.message || "Mass slip generation failed";
    job.finishedAt = new Date().toISOString();
  } finally {
    await deleteMassJobPayload(job);
    activeMassSlipWorkers = Math.max(0, activeMassSlipWorkers - 1);
    scheduleMassSlipWorkers();
  }
}

async function queueMassVoterSlipJob({
  voters,
  filters,
  requestedBy,
  boothNoForName,
  partNoOverride,
  jobType = "mass-pdf",
}) {
  const resolvedBoothNo =
    normalizeBoothNo(boothNoForName || "") || normalizeText(boothNoForName);
  const resolvedPartNo =
    normalizeBoothNo(partNoOverride || "") || normalizeText(partNoOverride);
  const votersForPdf = resolvedPartNo
    ? voters.map((voter) => withBoothPartNo(voter, resolvedPartNo))
    : voters;

  const fileName = buildMassSlipFilename(
    resolvedBoothNo || resolvedPartNo || "unknown",
  );
  const jobId = uuidv4();
  const filePath = path.join(voterSlipJobsRoot, jobId, fileName);
  const payloadPath = path.join(voterSlipJobsRoot, jobId, "payload.json");

  const job = {
    id: jobId,
    jobType,
    contentType: "application/pdf",
    status: "queued",
    total: votersForPdf.length,
    processed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    filters: {
      ...filters,
      partNoOverride: resolvedPartNo || null,
    },
    fileName,
    filePath,
    payloadPath,
    downloadedAt: null,
    downloadFailedAt: null,
    requestedBy,
  };
  voterSlipJobs.set(jobId, job);

  try {
    await fs.outputJson(payloadPath, {
      voters: votersForPdf,
    });
  } catch (error) {
    voterSlipJobs.delete(jobId);
    throw error;
  }

  massSlipJobQueue.push(job);
  scheduleMassSlipWorkers();

  return job;
}

async function getLatestSessionsForBoothRange({ fromBoothNo, toBoothNo }) {
  const result = await query(
    `WITH normalized AS (
       SELECT s.id,
              s.status,
              s.booth_no,
              s.booth_name,
              s.assembly_name,
              s.original_filename,
              s.created_at,
              s.updated_at,
              NULLIF(
                regexp_replace(COALESCE(NULLIF(s.booth_no, ''), ''), '[^0-9]', '', 'g'),
                ''
              )::INT AS numeric_booth_no
       FROM sessions s
     ),
     ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY numeric_booth_no
                ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
              ) AS booth_rank
       FROM normalized
       WHERE numeric_booth_no BETWEEN $1 AND $2
     )
     SELECT id, status, booth_no, booth_name, assembly_name, original_filename,
            created_at, updated_at, numeric_booth_no
     FROM ranked
     WHERE booth_rank = 1
     ORDER BY numeric_booth_no ASC`,
    [fromBoothNo, toBoothNo],
  );

  const sessionByBooth = new Map();

  for (const row of result.rows) {
    const numericBoothNo = Number(row.numeric_booth_no);
    if (!Number.isFinite(numericBoothNo)) continue;

    const resolvedBoothNo =
      normalizeBoothNo(row.booth_no || "") || String(numericBoothNo);

    sessionByBooth.set(numericBoothNo, {
      ...row,
      resolvedBoothNo,
      numericBoothNo,
    });
  }

  const missingBoothSet = new Set();
  for (let boothNo = fromBoothNo; boothNo <= toBoothNo; boothNo += 1) {
    if (!sessionByBooth.has(boothNo)) {
      missingBoothSet.add(boothNo);
    }
  }

  // Fallback for legacy rows where booth number exists only in filename.
  if (missingBoothSet.size > 0) {
    const fallbackResult = await query(
      `SELECT id, status, booth_no, booth_name, assembly_name, original_filename,
              created_at, updated_at
       FROM sessions
       WHERE booth_no IS NULL OR booth_no = ''
       ORDER BY COALESCE(updated_at, created_at) DESC`,
    );

    for (const row of fallbackResult.rows) {
      const resolvedBoothNo = resolveSessionBoothNo(row);
      const numericBoothNo = parseBoothNumber(resolvedBoothNo);
      if (numericBoothNo === null) continue;
      if (!missingBoothSet.has(numericBoothNo)) continue;

      sessionByBooth.set(numericBoothNo, {
        ...row,
        resolvedBoothNo,
        numericBoothNo,
      });
      missingBoothSet.delete(numericBoothNo);

      if (missingBoothSet.size === 0) break;
    }
  }

  const sessions = [];
  const missingBooths = [];

  for (let boothNo = fromBoothNo; boothNo <= toBoothNo; boothNo += 1) {
    const found = sessionByBooth.get(boothNo);
    if (found) {
      sessions.push(found);
    } else {
      missingBooths.push(String(boothNo));
    }
  }

  return {
    sessions,
    missingBooths,
  };
}

async function getSessionVoterCountsBySessionIds(sessionIds) {
  const counts = new Map();
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return counts;
  }

  const result = await query(
    `SELECT session_id, COUNT(*)::int AS voter_count
     FROM session_voters
     WHERE session_id = ANY($1::uuid[])
       AND COALESCE(under_adjudication, FALSE) = FALSE
     GROUP BY session_id`,
    [sessionIds],
  );

  for (const row of result.rows) {
    counts.set(row.session_id, Number(row.voter_count || 0));
  }

  return counts;
}

async function queueBoothRangeZipJob({
  boothRange,
  boothSessions,
  missingBooths,
  requestedBy,
  filters,
  voterCountsBySessionId,
}) {
  const fileName = buildBoothRangeZipFilename(
    boothRange.fromBoothNo,
    boothRange.toBoothNo,
  );
  const jobId = uuidv4();
  const filePath = path.join(voterSlipJobsRoot, jobId, fileName);
  const requestedBooths = boothRange.toBoothNo - boothRange.fromBoothNo + 1;
  const totalFiles = boothSessions.reduce(
    (sum, session) => sum + (voterCountsBySessionId.get(session.id) || 0),
    0,
  );

  const job = {
    id: jobId,
    jobType: "booth-range-zip",
    contentType: "application/zip",
    status: "queued",
    total: totalFiles,
    processed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    filters,
    boothRange,
    progress: {
      requestedBooths,
      matchedBooths: boothSessions.length,
      missingBooths,
      processedBooths: 0,
      currentBooth: null,
      totalFiles,
      processedFiles: 0,
      generatedFiles: 0,
      boothsWithNoVoters: [],
    },
    fileName,
    filePath,
    downloadedAt: null,
    downloadFailedAt: null,
    requestedBy,
  };

  voterSlipJobs.set(jobId, job);

  setImmediate(async () => {
    const zip = new AdmZip();

    try {
      job.status = "processing";

      const votersBySessionId = await getMassSlipVotersBySessionIds(
        boothSessions.map((session) => session.id),
      );

      for (const boothSession of boothSessions) {
        const boothNo =
          normalizeBoothNo(boothSession.resolvedBoothNo || "") ||
          String(boothSession.numericBoothNo || "");
        job.progress.currentBooth = boothNo || null;

        const voters = votersBySessionId.get(boothSession.id) || [];
        const votersForBooth = voters.map((voter) =>
          withBoothPartNo(voter, boothNo),
        );

        if (!votersForBooth.length) {
          job.progress.boothsWithNoVoters.push(boothNo || "unknown");
          job.progress.processedBooths += 1;
          if (boothRangePerBoothPauseMs > 0) {
            await sleepMs(boothRangePerBoothPauseMs);
          }
          continue;
        }

        for (let i = 0; i < votersForBooth.length; i += 1) {
          const voter = votersForBooth[i];
          const pdfBytes = await buildSingleVoterSlipPdf(voter);
          const entryName = buildRangeZipEntryName({
            boothNo,
            voter,
            index: job.progress.generatedFiles,
          });

          zip.addFile(entryName, Buffer.from(pdfBytes));

          job.processed += 1;
          job.progress.processedFiles = job.processed;
          job.progress.generatedFiles += 1;

          if (boothRangePerSlipPauseMs > 0) {
            await sleepMs(boothRangePerSlipPauseMs);
          }

          if (job.progress.generatedFiles % 20 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }

        job.progress.processedBooths += 1;

        if (boothRangePerBoothPauseMs > 0) {
          await sleepMs(boothRangePerBoothPauseMs);
        }
      }

      job.progress.currentBooth = null;
      await fs.outputFile(filePath, zip.toBuffer());
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "Booth-range zip generation failed";
      job.finishedAt = new Date().toISOString();
      job.progress.currentBooth = null;
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
    partNoOverride: boothNoForName,
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

function buildSpecificSlipDedupeKey(voter) {
  const serialKey = normalizeSerialNumberForLookup(voter?.serialNumber);
  if (serialKey) return `serial:${serialKey}`;

  const voterIdKey = sanitizeVoterId(voter?.voterId).toUpperCase();
  if (voterIdKey) return `voter-id:${voterIdKey}`;

  const name = normalizeText(voter?.name).toLowerCase();
  if (!name) return null;

  const relationName = normalizeText(voter?.relationName).toLowerCase();
  const houseNumber = normalizeText(voter?.houseNumber).toLowerCase();
  const section = normalizeText(voter?.section).toLowerCase();
  return `name:${name}|relation:${relationName}|house:${houseNumber}|section:${section}`;
}

function dedupeSpecificSlipVoters(voters) {
  const deduped = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const voter of voters) {
    const key = buildSpecificSlipDedupeKey(voter);
    if (!key) {
      deduped.push(voter);
      continue;
    }

    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    deduped.push(voter);
  }

  return {
    voters: deduped,
    duplicateCount,
  };
}

function buildSpecificSlipVoterFromOcr({
  voter,
  structured,
  requiredPartNo,
  sourceFileName,
  sourcePageNumber,
  sequenceNo,
}) {
  const rawVoter = voter && typeof voter === "object" ? voter : {};

  const serialNumber = normalizeText(
    rawVoter.serialNumber ||
      rawVoter.serial_number ||
      rawVoter.slNo ||
      rawVoter.sl_no ||
      "",
  );
  const voterId = sanitizeVoterId(rawVoter.voterId || rawVoter.voter_id || "");
  const name = normalizeText(rawVoter.name || rawVoter.voterName || "");
  const relationName = normalizeText(
    rawVoter.relationName || rawVoter.relation_name || "",
  );
  const houseNumber = normalizeText(
    rawVoter.houseNumber || rawVoter.house_number || "",
  );
  const gender = normalizeText(rawVoter.gender || "");
  const ageText = normalizeText(rawVoter.age || "");
  const ageValue = ageText ? Number.parseInt(ageText, 10) : Number.NaN;
  const age = Number.isNaN(ageValue) ? ageText : ageValue;

  if (!serialNumber && !voterId && !name) {
    return null;
  }

  const partNumber =
    normalizeBoothNo(requiredPartNo) || normalizeText(requiredPartNo);

  const underAdjudication = normalizeUnderAdjudication(
    rawVoter.underAdjudication ??
      rawVoter.under_adjudication ??
      rawVoter.isUnderAdjudication ??
      rawVoter.adjudication,
  );

  return {
    id: `specific-ocr-${sequenceNo}`,
    partNumber,
    boothNo: partNumber,
    boothName: normalizeText(structured?.boothName || ""),
    section: normalizeText(structured?.section || rawVoter.section || ""),
    serialNumber,
    voterId,
    name,
    relationName,
    houseNumber,
    age,
    gender,
    underAdjudication,
    sourceFileName,
    sourcePageNumber,
  };
}

function buildSpecificSlipTableRows(voters) {
  return voters.map((voter, index) => ({
    rowNo: index + 1,
    serialNumber: normalizeText(voter.serialNumber),
    voterId: normalizeText(voter.voterId),
    name: normalizeText(voter.name),
    relationName: normalizeText(voter.relationName),
    houseNumber: normalizeText(voter.houseNumber),
    age: voter.age ?? "",
    gender: normalizeText(voter.gender),
    section: normalizeText(voter.section),
    partNumber: normalizeText(voter.partNumber),
    sourceFileName: normalizeText(voter.sourceFileName),
    sourcePageNumber: voter.sourcePageNumber || null,
  }));
}

async function extractSpecificSlipVotersFromUploads({
  files,
  requiredPartNo,
  apiKey,
}) {
  const collectedVoters = [];
  const failedPages = [];

  let pagesProcessed = 0;
  let extractedCount = 0;
  let skippedUnderAdjudicationCount = 0;
  let sequenceNo = 1;

  for (const file of files) {
    const sourceFileName = path.basename(
      file.originalname || file.filename || "upload.pdf",
    );
    const inputIsImage = isImageSpecificUpload(file.mimetype, sourceFileName);

    let pagePaths = [];
    let tempPageDir = "";

    try {
      if (inputIsImage) {
        pagePaths = [file.path];
      } else {
        const fileToken = sanitizeFilenameToken(
          path.parse(file.filename || sourceFileName).name,
          "file",
        );
        tempPageDir = path.join(path.dirname(file.path), `${fileToken}-pages`);
        pagePaths = await splitPdfToPages(file.path, tempPageDir);
      }

      if (!pagePaths.length) {
        failedPages.push({
          fileName: sourceFileName,
          pageNumber: null,
          error: "No pages found in uploaded file",
        });
        continue;
      }

      for (let pageIndex = 0; pageIndex < pagePaths.length; pageIndex += 1) {
        const pagePath = pagePaths[pageIndex];
        const sourcePageNumber = pageIndex + 1;

        try {
          const ocrResult = await callGeminiWithFile(
            pagePath,
            apiKey || undefined,
          );
          const structured = parseGeminiStructured(ocrResult?.text || "");
          const voters = Array.isArray(structured?.voters)
            ? structured.voters
            : [];

          extractedCount += voters.length;

          for (const voter of voters) {
            const normalizedVoter = buildSpecificSlipVoterFromOcr({
              voter,
              structured,
              requiredPartNo,
              sourceFileName,
              sourcePageNumber,
              sequenceNo,
            });

            if (!normalizedVoter) continue;

            sequenceNo += 1;

            if (normalizedVoter.underAdjudication) {
              skippedUnderAdjudicationCount += 1;
              continue;
            }

            collectedVoters.push(normalizedVoter);
          }

          pagesProcessed += 1;
        } catch (err) {
          failedPages.push({
            fileName: sourceFileName,
            pageNumber: sourcePageNumber,
            error: err?.message || "OCR failed for page",
          });
        }
      }
    } finally {
      if (tempPageDir) {
        await fs.remove(tempPageDir).catch(() => null);
      }
    }
  }

  const deduped = dedupeSpecificSlipVoters(collectedVoters);

  return {
    voters: deduped.voters,
    pagesProcessed,
    extractedCount,
    acceptedBeforeDedupeCount: collectedVoters.length,
    duplicateCount: deduped.duplicateCount,
    skippedUnderAdjudicationCount,
    failedPages,
  };
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
      `SELECT id, is_printed, under_adjudication FROM session_voters WHERE ${column} = $1 LIMIT 1`,
      [value],
    );
    if (voterCheck.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    if (voterCheck.rows[0].under_adjudication === true) {
      return res.status(403).json({
        error: "Voter slip cannot be printed for voters under adjudication",
      });
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
              relation_type, relation_name, house_number, age, gender, photo_url,
              under_adjudication
       FROM session_voters 
       WHERE ${column} = $1
       LIMIT 1`,
      [value],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    const voter = result.rows[0];
    if (voter.under_adjudication === true) {
      return res.status(403).json({
        error: "Voter slip cannot be printed for voters under adjudication",
      });
    }

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

    if (voter.underAdjudication === true) {
      return res.status(403).json({
        error: "Voter slip cannot be printed for voters under adjudication",
      });
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
    const shouldOverridePartNo = Boolean(
      filters.sessionId || filters.boothNo || filters.partNumber,
    );
    const partNoOverride = shouldOverridePartNo
      ? normalizeBoothNo(boothNoForName || "") || normalizeText(boothNoForName)
      : "";

    const job = await queueMassVoterSlipJob({
      voters,
      filters,
      requestedBy: req.user.id,
      boothNoForName,
      partNoOverride,
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
 * Start async generation for a specific set of voters extracted from
 * uploaded screenshots/PDF snippets using Gemini OCR.
 * Body (multipart/form-data):
 * - partNo/partNumber/boothNo: required user-provided part number
 * - files/file: one or many image/PDF files (required)
 * - apiKey or geminiApiKey: optional API key override
 */
router.post(
  "/voterslips/specific/start",
  specificVoterSlipUpload.any(),
  async (req, res) => {
    const uploadId = normalizeText(req.specificSlipUploadId);

    try {
      await cleanupOldVoterSlipJobs();

      const hasTemplate = await ensureVoterSlipTemplateExists();
      if (!hasTemplate) {
        return res.status(500).json({
          error: "Voter slip template not found",
          expectedPath: getVoterSlipTemplatePublicHint(),
        });
      }

      const partNo =
        normalizeBoothNo(
          req.body?.partNo || req.body?.partNumber || req.body?.boothNo || "",
        ) ||
        normalizeText(
          req.body?.partNo || req.body?.partNumber || req.body?.boothNo,
        );
      if (!partNo) {
        return res.status(400).json({
          error: "partNo (or partNumber/boothNo) is required",
          example: {
            partNo: "42",
            files: "<multiple screenshots/pdfs>",
          },
        });
      }

      const partDisplay = normalizeText(partNo);
      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
      const acceptedFiles = uploadedFiles.filter((file) =>
        isAcceptedSpecificUploadFieldName(file?.fieldname),
      );

      if (!acceptedFiles.length) {
        return res.status(400).json({
          error:
            "No files received. Use multipart field name 'files' (or 'file') for screenshot uploads.",
          fieldCounts: getSpecificUploadFieldCounts(uploadedFiles),
        });
      }

      const apiKey = normalizeText(req.body?.apiKey || req.body?.geminiApiKey);
      const ocr = await extractSpecificSlipVotersFromUploads({
        files: acceptedFiles,
        requiredPartNo: partNo,
        apiKey,
      });

      const tableRows = buildSpecificSlipTableRows(ocr.voters);

      if (!ocr.voters.length) {
        return res.status(404).json({
          error: "No voters could be extracted from uploaded files",
          partNo: partDisplay,
          ocr: {
            uploadId: uploadId || null,
            filesReceived: uploadedFiles.length,
            filesAccepted: acceptedFiles.length,
            pagesProcessed: ocr.pagesProcessed,
            extractedCount: ocr.extractedCount,
            acceptedCount: 0,
            skippedUnderAdjudicationCount: ocr.skippedUnderAdjudicationCount,
            duplicateRowsSkipped: ocr.duplicateCount,
            failedPages: ocr.failedPages.length,
            dispatchMode: getGlobalDispatchMode(),
            tableColumns: [
              "rowNo",
              "serialNumber",
              "voterId",
              "name",
              "relationName",
              "houseNumber",
              "age",
              "gender",
              "section",
              "partNumber",
              "sourceFileName",
              "sourcePageNumber",
            ],
            tableRows,
          },
          failedPages: ocr.failedPages,
        });
      }

      const job = await queueMassVoterSlipJob({
        voters: ocr.voters,
        filters: {
          mode: "specific-ocr",
          partNo: partDisplay,
          uploadId: uploadId || null,
          filesAccepted: acceptedFiles.length,
          extractedCount: ocr.extractedCount,
          acceptedBeforeDedupeCount: ocr.acceptedBeforeDedupeCount,
        },
        requestedBy: req.user.id,
        boothNoForName: partDisplay,
        partNoOverride: partDisplay,
        jobType: "specific-ocr-pdf",
      });

      return res.status(202).json({
        message: "Specific voter slip generation started",
        partNo: partDisplay,
        ocr: {
          uploadId: uploadId || null,
          filesReceived: uploadedFiles.length,
          filesAccepted: acceptedFiles.length,
          pagesProcessed: ocr.pagesProcessed,
          extractedCount: ocr.extractedCount,
          acceptedBeforeDedupeCount: ocr.acceptedBeforeDedupeCount,
          acceptedCount: ocr.voters.length,
          skippedUnderAdjudicationCount: ocr.skippedUnderAdjudicationCount,
          duplicateRowsSkipped: ocr.duplicateCount,
          failedPages: ocr.failedPages.length,
          dispatchMode: getGlobalDispatchMode(),
          tableColumns: [
            "rowNo",
            "serialNumber",
            "voterId",
            "name",
            "relationName",
            "houseNumber",
            "age",
            "gender",
            "section",
            "partNumber",
            "sourceFileName",
            "sourcePageNumber",
          ],
          tableRows,
        },
        failedPages: ocr.failedPages,
        job: makeMassJobPublicView(job),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    } finally {
      if (uploadId) {
        await fs
          .remove(path.join(specificVoterSlipUploadRoot, uploadId))
          .catch(() => null);
      }
    }
  },
);

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
 * Start async booth-range generation of individual voter slips in one ZIP.
 * Body example: { boothRange: "1-50" }
 */
router.post("/voterslips/mass/booth-range/start", async (req, res) => {
  try {
    await cleanupOldVoterSlipJobs();

    const hasTemplate = await ensureVoterSlipTemplateExists();
    if (!hasTemplate) {
      return res.status(500).json({
        error: "Voter slip template not found",
        expectedPath: getVoterSlipTemplatePublicHint(),
      });
    }

    const parsedRange = parseBoothRangePayload(req.body);
    if (parsedRange.error) {
      return res.status(400).json({
        error: parsedRange.error,
        maxSpan: parsedRange.maxSpan || boothRangeMaxSpan,
        example: {
          boothRange: "1-50",
        },
      });
    }

    const { sessions: boothSessions, missingBooths } =
      await getLatestSessionsForBoothRange(parsedRange);
    if (!boothSessions.length) {
      return res.status(404).json({
        error: "No sessions found in booth range",
        boothRange: `${parsedRange.fromBoothNo}-${parsedRange.toBoothNo}`,
        missingBooths,
      });
    }

    const voterCountsBySessionId = await getSessionVoterCountsBySessionIds(
      boothSessions.map((session) => session.id),
    );
    const totalVoters = boothSessions.reduce(
      (sum, session) => sum + (voterCountsBySessionId.get(session.id) || 0),
      0,
    );

    if (totalVoters === 0) {
      return res.status(404).json({
        error: "No voters found for selected booth range",
        boothRange: `${parsedRange.fromBoothNo}-${parsedRange.toBoothNo}`,
      });
    }

    const filters = {
      fromBoothNo: String(parsedRange.fromBoothNo),
      toBoothNo: String(parsedRange.toBoothNo),
      boothRange: `${parsedRange.fromBoothNo}-${parsedRange.toBoothNo}`,
    };

    const job = await queueBoothRangeZipJob({
      boothRange: {
        fromBoothNo: parsedRange.fromBoothNo,
        toBoothNo: parsedRange.toBoothNo,
      },
      boothSessions,
      missingBooths,
      requestedBy: req.user.id,
      filters,
      voterCountsBySessionId,
    });

    return res.status(202).json({
      message: "Booth-range voter slip ZIP generation started",
      summary: {
        boothRange: `${parsedRange.fromBoothNo}-${parsedRange.toBoothNo}`,
        requestedBooths: parsedRange.span,
        matchedBooths: boothSessions.length,
        missingBooths,
        totalVoters,
      },
      job: makeMassJobPublicView(job),
    });
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
 * Download completed mass generation output file.
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
        error: "This generated file was already downloaded and removed",
        job: makeMassJobPublicView(job),
      });
    }

    const exists = await fs.pathExists(job.filePath);
    if (!exists) {
      return res.status(404).json({
        error: "Generated file not found on disk",
      });
    }

    const contentType =
      job.contentType ||
      (String(job.fileName || "")
        .toLowerCase()
        .endsWith(".zip")
        ? "application/zip"
        : "application/pdf");

    res.setHeader("Content-Type", contentType);
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
