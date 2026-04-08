/**
 * Affidavit Routes — Manual Entry, Database Storage, DOCX Export
 *
 * Admin-only endpoints for:
 *   1. Manual entry of all affidavit (Form 26) fields
 *   2. Store structured data in PostgreSQL
 *   3. Export as DOCX using the original template with exact formatting
 *
 * Created by: Shaswata Saha | ssaha.vercel.app
 */

import express from "express";
import path from "path";
import fs from "fs-extra";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { query } from "../db.js";
import { authenticate, adminOnly } from "../auth.js";
import {
  fillAffidavitTemplate,
  templateExists,
} from "../affidavitDocxTemplate.js";
import { uploadImageBuffer } from "../cloudinary.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const affidavitStorageRoot = path.join(process.cwd(), "storage", "affidavits");
const STORAGE_RETENTION_MS = Math.max(
  Number(process.env.STORAGE_RETENTION_MS) || 24 * 60 * 60 * 1000,
  60 * 60 * 1000,
);
const STORAGE_CLEANUP_INTERVAL_MS = Math.max(
  Number(process.env.STORAGE_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000,
  10 * 60 * 1000,
);

async function cleanupAffidavitStorage() {
  try {
    await fs.ensureDir(affidavitStorageRoot);

    const [dirs, sessions] = await Promise.all([
      fs.readdir(affidavitStorageRoot),
      query("SELECT id, status, updated_at FROM affidavit_sessions"),
    ]);

    const now = Date.now();
    const sessionMap = new Map(
      sessions.rows.map((row) => [
        String(row.id),
        {
          status: String(row.status || ""),
          updatedAtMs: new Date(row.updated_at).getTime(),
        },
      ]),
    );

    for (const dirName of dirs) {
      const dirPath = path.join(affidavitStorageRoot, dirName);
      const stat = await fs.stat(dirPath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const sessionMeta = sessionMap.get(dirName);
      if (!sessionMeta) {
        const orphanAgeMs = now - stat.mtimeMs;
        if (orphanAgeMs > STORAGE_RETENTION_MS) {
          await fs.remove(dirPath).catch(() => null);
        }
        continue;
      }

      if (sessionMeta.status === "completed") {
        await fs.remove(dirPath).catch(() => null);
        continue;
      }

      const fallbackAgeMs = now - stat.mtimeMs;
      const updatedAgeMs = Number.isNaN(sessionMeta.updatedAtMs)
        ? fallbackAgeMs
        : now - sessionMeta.updatedAtMs;

      if (updatedAgeMs > STORAGE_RETENTION_MS) {
        await fs.remove(dirPath).catch(() => null);
      }
    }
  } catch (err) {
    console.warn("Affidavit storage cleanup skipped:", err.message);
  }
}

void cleanupAffidavitStorage();
setInterval(() => {
  void cleanupAffidavitStorage();
}, STORAGE_CLEANUP_INTERVAL_MS);

// All affidavit routes require authentication + admin
router.use(authenticate);
router.use(adminOnly);

// ============================================
// MANUAL ENTRY — Create / Update Affidavit
// ============================================

router.post("/manual-entry", async (req, res) => {
  try {
    const data = normalizePreviewPayload(req.body || {});
    const incomingSessionId =
      req.body?.sessionId ||
      req.body?.formData?.sessionId ||
      req.body?.data?.sessionId ||
      data.sessionId;
    const sessionId = incomingSessionId || uuidv4();
    const isUpdate = !!incomingSessionId;

    const formData = buildAffidavitFormData(data);

    const candidateName = formData.candidateName || "";
    const party = formData.party || "";
    const constituency = formData.constituency || "";
    const state = formData.state || "";

    if (isUpdate) {
      const existing = await query(
        "SELECT id FROM affidavit_sessions WHERE id=$1",
        [sessionId],
      );
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      await query(
        `UPDATE affidavit_sessions
         SET candidate_name=$1, party=$2, constituency=$3, state=$4,
             candidate_photo_url=$5, candidate_signature_url=$6,
             status='completed', total_pages=0, processed_pages=0, updated_at=now()
         WHERE id=$7`,
        [
          candidateName,
          party,
          constituency,
          state,
          formData.candidatePhotoUrl || null,
          formData.candidateSignatureUrl || null,
          sessionId,
        ],
      );

      await query("DELETE FROM affidavit_entries WHERE session_id=$1", [
        sessionId,
      ]);
      await query("DELETE FROM affidavit_tables WHERE session_id=$1", [
        sessionId,
      ]);
      await query("DELETE FROM affidavit_pages WHERE session_id=$1", [
        sessionId,
      ]);
    } else {
      await query(
        `INSERT INTO affidavit_sessions
         (id, original_filename, candidate_name, party, constituency, state,
          candidate_photo_url, candidate_signature_url,
          status, total_pages, processed_pages)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', 0, 0)`,
        [
          sessionId,
          "Manual Entry",
          candidateName,
          party,
          constituency,
          state,
          formData.candidatePhotoUrl || null,
          formData.candidateSignatureUrl || null,
        ],
      );
    }

    const structuredJson = buildMergedStructure(formData);
    const pageRes = await query(
      `INSERT INTO affidavit_pages
       (session_id, page_number, page_path, raw_text, structured_json)
       VALUES ($1, 1, 'manual-entry', 'Manual entry by admin', $2)
       RETURNING id`,
      [sessionId, JSON.stringify(structuredJson)],
    );
    const pageId = pageRes.rows[0].id;

    const allFields = flattenFields(formData);
    for (const [fieldName, fieldValue] of Object.entries(allFields)) {
      if (fieldValue === undefined || fieldValue === null || fieldValue === "")
        continue;
      await query(
        `INSERT INTO affidavit_entries
         (session_id, page_id, page_number, field_name, field_value, field_category)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (session_id, field_name) DO UPDATE SET
           field_value = EXCLUDED.field_value,
           page_id = EXCLUDED.page_id,
           page_number = EXCLUDED.page_number`,
        [
          sessionId,
          pageId,
          fieldName,
          String(fieldValue),
          categorizeField(fieldName),
        ],
      );
    }

    const persisted = await query(
      `SELECT field_name FROM affidavit_entries WHERE session_id=$1`,
      [sessionId],
    );
    const savedFieldNames = new Set(
      persisted.rows.map((row) => String(row.field_name)),
    );
    const expectedPersistedFieldNames = Object.entries(allFields)
      .filter(
        ([, value]) =>
          value !== undefined && value !== null && String(value) !== "",
      )
      .map(([name]) => name);
    const missingPersistedFields = expectedPersistedFieldNames.filter(
      (name) => !savedFieldNames.has(name),
    );

    const tables = buildAffidavitTables(formData);
    for (const table of tables) {
      await query(
        `INSERT INTO affidavit_tables
         (session_id, page_id, page_number, table_title, headers, rows_data)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [
          sessionId,
          pageId,
          table.tableTitle,
          JSON.stringify(table.headers),
          JSON.stringify(table.rows),
        ],
      );
    }

    res.status(isUpdate ? 200 : 201).json({
      sessionId,
      candidateName,
      party,
      constituency,
      state,
      status: "completed",
      message: isUpdate
        ? "Affidavit updated successfully"
        : "Affidavit created successfully",
      exportUrl: `/affidavits/sessions/${sessionId}/export/docx`,
      dbAudit: {
        expectedPersistedFieldCount: expectedPersistedFieldNames.length,
        savedFieldCount: savedFieldNames.size,
        missingPersistedFieldCount: missingPersistedFields.length,
        missingPersistedFields,
        allPersisted: missingPersistedFields.length === 0,
      },
    });
  } catch (err) {
    console.error("Manual entry error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// UPLOAD PHOTO/SIGNATURE
// ============================================

router.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No image file provided" });
    const { type } = req.body; // "photo" or "signature"
    const folder =
      type === "signature" ? "affidavit_signatures" : "affidavit_photos";
    const result = await uploadImageBuffer(req.file.buffer, { folder });
    res.json({ url: result.secure_url, publicId: result.public_id, type });
  } catch (err) {
    console.error("Image upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// LIST SESSIONS
// ============================================

router.get("/sessions", async (_req, res) => {
  try {
    const sql = `
      SELECT s.id, s.original_filename, s.candidate_name, s.party,
             s.constituency, s.state, s.status,
             s.total_pages, s.processed_pages,
             s.created_at, s.updated_at,
             COUNT(DISTINCT e.id) AS field_count,
             COUNT(DISTINCT t.id) AS table_count
      FROM affidavit_sessions s
      LEFT JOIN affidavit_entries e ON e.session_id = s.id
      LEFT JOIN affidavit_tables t ON t.session_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC;
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

    const session = await query(
      "SELECT * FROM affidavit_sessions WHERE id=$1",
      [id],
    );
    if (session.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const entries = await query(
      `SELECT id, page_number, field_name, field_value, field_category, created_at
       FROM affidavit_entries WHERE session_id=$1 ORDER BY field_category, field_name`,
      [id],
    );

    const tables = await query(
      `SELECT id, page_number, table_title, headers, rows_data, created_at
       FROM affidavit_tables WHERE session_id=$1 ORDER BY page_number`,
      [id],
    );

    const entriesByCategory = {};
    for (const entry of entries.rows) {
      const cat = entry.field_category || "general";
      if (!entriesByCategory[cat]) entriesByCategory[cat] = [];
      entriesByCategory[cat].push(entry);
    }

    const formData = {};
    for (const entry of entries.rows) {
      formData[entry.field_name] = entry.field_value;
    }

    res.json({
      session: session.rows[0],
      entries: entries.rows,
      entriesByCategory,
      tables: tables.rows,
      formData,
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

    const deleted = await query(
      "DELETE FROM affidavit_sessions WHERE id=$1 RETURNING id",
      [id],
    );
    if (deleted.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    res.json({ deleted: id, message: "Affidavit session deleted" });
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
      "UPDATE affidavit_sessions SET original_filename=$1, updated_at=now() WHERE id=$2 RETURNING id, original_filename",
      [name.trim(), id],
    );
    if (updated.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    res.json({
      sessionId: id,
      name: updated.rows[0].original_filename,
      message: "Renamed successfully",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function buildMergedForSession(sessionId) {
  const session = await query("SELECT * FROM affidavit_sessions WHERE id=$1", [
    sessionId,
  ]);
  if (session.rowCount === 0) {
    return { error: "Session not found", status: 404 };
  }

  const pages = await query(
    `SELECT page_number, raw_text, structured_json
     FROM affidavit_pages WHERE session_id=$1
     ORDER BY page_number`,
    [sessionId],
  );

  const entries = await query(
    `SELECT field_name, field_value, field_category
     FROM affidavit_entries WHERE session_id=$1
     ORDER BY field_category, field_name`,
    [sessionId],
  );

  const tables = await query(
    `SELECT table_title, headers, rows_data, page_number
     FROM affidavit_tables WHERE session_id=$1
     ORDER BY page_number`,
    [sessionId],
  );

  let merged = {};
  if (pages.rows.length > 0) {
    const json =
      typeof pages.rows[0].structured_json === "string"
        ? JSON.parse(pages.rows[0].structured_json)
        : pages.rows[0].structured_json || {};
    merged = json;
  }

  if (!merged.fields) merged.fields = {};
  if (entries.rows.length > 0) {
    for (const entry of entries.rows) {
      const key = entry.field_name;
      const value = entry.field_value;
      if (value === null || value === undefined || value === "") continue;
      const parsedValue = isJsonString(value) ? JSON.parse(value) : value;
      if (String(key).includes(".")) {
        setNestedValue(merged.fields, key, parsedValue);
      } else {
        merged.fields[key] = parsedValue;
      }
    }
  }

  if (!Array.isArray(merged.tables)) merged.tables = [];
  if (tables.rows.length > 0) {
    const dbTables = tables.rows.map((t) => ({
      tableTitle: t.table_title,
      headers:
        typeof t.headers === "string" ? JSON.parse(t.headers) : t.headers,
      rows:
        typeof t.rows_data === "string" ? JSON.parse(t.rows_data) : t.rows_data,
    }));

    const byTitle = new Map();
    for (const table of merged.tables) {
      const title = String(table?.tableTitle || "")
        .trim()
        .toLowerCase();
      if (!title) continue;
      byTitle.set(title, table);
    }
    for (const table of dbTables) {
      const title = String(table?.tableTitle || "")
        .trim()
        .toLowerCase();
      if (!title) {
        merged.tables.push(table);
        continue;
      }
      byTitle.set(title, table);
    }

    const mergedByTitle = Array.from(byTitle.values());
    const untitled = dbTables.filter(
      (t) => !String(t?.tableTitle || "").trim(),
    );
    merged.tables = [...mergedByTitle, ...untitled];
  }

  const sessRow = session.rows[0];
  if (sessRow.candidate_photo_url && !merged.fields.candidatePhotoUrl) {
    merged.fields.candidatePhotoUrl = sessRow.candidate_photo_url;
  }
  if (sessRow.candidate_signature_url && !merged.fields.candidateSignatureUrl) {
    merged.fields.candidateSignatureUrl = sessRow.candidate_signature_url;
  }

  return { session: sessRow, merged };
}

async function buildDocxBufferFromMerged(merged) {
  if (!templateExists()) {
    return {
      error:
        "DOCX template file not found. Ensure 'AFFIDAVIT FORMAT WORD.docx' exists in the project root.",
      status: 500,
    };
  }
  const buffer = await fillAffidavitTemplate(merged);
  return { buffer };
}

function isJsonString(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
}

function setNestedValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cursor[k] || typeof cursor[k] !== "object") cursor[k] = {};
    cursor = cursor[k];
  }
  cursor[parts[parts.length - 1]] = value;
}

function normalizePreviewPayload(rawInput) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const source =
    input.formData && typeof input.formData === "object"
      ? input.formData
      : input.data && typeof input.data === "object"
        ? input.data
        : input;

  const normalized = {};
  for (const [key, rawValue] of Object.entries(source)) {
    const value = isJsonString(rawValue) ? JSON.parse(rawValue) : rawValue;
    if (String(key).includes(".")) {
      setNestedValue(normalized, key, value);
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

function toTrimmedText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function pickFirstNonEmpty(fields, aliases) {
  for (const key of aliases) {
    const text = toTrimmedText(fields[key]);
    if (text) return { key, value: text };
  }
  return { key: null, value: "" };
}

function buildSessionFieldValidityReport(merged = {}, session = {}) {
  const fields =
    merged.fields && typeof merged.fields === "object" ? merged.fields : {};
  const checks = [
    {
      label: "Candidate Name",
      aliases: ["candidateName", "candidate_name", "name"],
      required: true,
    },
    {
      label: "Parent/Spouse Name",
      aliases: [
        "fatherMotherHusbandName",
        "parentSpouseName",
        "father_name",
        "spouse_name",
      ],
      required: true,
    },
    { label: "Age", aliases: ["age"], required: true },
    { label: "House", aliases: ["houseName", "house_name"], required: true },
    {
      label: "Constituency",
      aliases: [
        "constituency",
        "assemblyConstituency",
        "assembly_constituency",
      ],
      required: true,
    },
    {
      label: "Postal Address",
      aliases: ["postalAddress", "postal_address", "address"],
      required: true,
    },
    {
      label: "Party",
      aliases: ["party", "politicalPartyName", "political_party"],
      required: false,
    },
    {
      label: "Electoral Serial Number",
      aliases: ["serialNumber", "serial_no", "electoralSerialNo"],
      required: true,
    },
    {
      label: "Electoral Part Number",
      aliases: ["partNumber", "part_no", "electoralPartNo"],
      required: true,
    },
    {
      label: "Telephone",
      aliases: ["telephone", "contactNumber", "phone"],
      required: false,
    },
    {
      label: "Email",
      aliases: ["email", "emailId", "email_id"],
      required: false,
    },
    {
      label: "Verification Place",
      aliases: ["verificationPlace", "place"],
      required: true,
    },
    {
      label: "Verification Date",
      aliases: ["verificationDate", "date", "verification_date"],
      required: true,
    },
  ];

  const details = [];
  const missingRequired = [];

  for (const check of checks) {
    const picked = pickFirstNonEmpty(fields, check.aliases);
    const hasValue = Boolean(picked.value);
    details.push({
      label: check.label,
      required: check.required,
      valid: check.required ? hasValue : true,
      sourceKey: picked.key,
      valuePreview: hasValue ? picked.value.slice(0, 80) : "",
    });
    if (check.required && !hasValue) {
      missingRequired.push(check.label);
    }
  }

  const govAccCandidate =
    fields.governmentAccommodation || merged.governmentAccommodation || null;
  const govAcc = parseJsonObject(govAccCandidate);
  const govAccValid =
    !!govAcc &&
    typeof govAcc === "object" &&
    (toTrimmedText(govAcc.occupied) || toTrimmedText(govAcc.address));
  details.push({
    label: "Government Accommodation",
    required: false,
    valid: true,
    sourceKey: toTrimmedText(fields.governmentAccommodation)
      ? "governmentAccommodation"
      : merged.governmentAccommodation
        ? "merged.governmentAccommodation"
        : null,
    valuePreview: govAccValid ? "present" : "",
  });

  const fallbackCandidateName = toTrimmedText(session.candidate_name);
  if (fallbackCandidateName && missingRequired.includes("Candidate Name")) {
    const idx = missingRequired.indexOf("Candidate Name");
    missingRequired.splice(idx, 1);
  }

  return {
    valid: missingRequired.length === 0,
    missingRequired,
    totalFieldEntries: Object.keys(fields).length,
    details,
  };
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function buildTemplatePlacementAudit(merged) {
  const docxResult = await buildDocxBufferFromMerged(merged);
  if (docxResult.error) {
    return {
      status: "error",
      error: docxResult.error,
    };
  }

  const zip = new AdmZip(docxResult.buffer);
  const xml = zip.readAsText("word/document.xml");
  const plainText = decodeXmlEntities(
    xml
      .replace(/<w:tab\/?\s*>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const plainTextLower = plainText.toLowerCase();

  const fields =
    merged?.fields && typeof merged.fields === "object" ? merged.fields : {};
  const checks = [
    {
      label: "Candidate Name",
      value: firstValue(
        fields,
        ["candidateName", "candidate_name", "name"],
        "",
      ),
    },
    {
      label: "Parent/Spouse Name",
      value: firstValue(
        fields,
        [
          "fatherMotherHusbandName",
          "parentSpouseName",
          "father_name",
          "spouse_name",
        ],
        "",
      ),
    },
    { label: "Age", value: firstValue(fields, ["age"], "") },
    {
      label: "Postal Address",
      value: firstValue(
        fields,
        ["postalAddress", "address", "postal_address"],
        "",
      ),
    },
    {
      label: "Party",
      value: firstValue(
        fields,
        ["party", "politicalPartyName", "political_party"],
        "",
      ),
    },
    {
      label: "Enrolled Constituency",
      value: firstValue(
        fields,
        ["enrolledConstituency", "constituency", "assemblyConstituency"],
        "",
      ),
    },
    {
      label: "Electoral Serial Number",
      value: firstValue(
        fields,
        ["serialNumber", "serial_no", "electoralSerialNo"],
        "",
      ),
    },
    {
      label: "Electoral Part Number",
      value: firstValue(
        fields,
        ["partNumber", "part_no", "electoralPartNo"],
        "",
      ),
    },
    {
      label: "Telephone",
      value: firstValue(fields, ["telephone", "contactNumber", "phone"], ""),
    },
    {
      label: "Email",
      value: firstValue(fields, ["email", "emailId", "email_id"], ""),
    },
    {
      label: "Education",
      value: firstValue(
        fields,
        ["educationalQualification", "education", "qualification"],
        "",
      ),
    },
  ];

  const details = checks.map((check) => {
    const textValue = toTrimmedText(check.value);
    const valuePresent = !!textValue;
    const foundInDocument =
      !valuePresent || plainTextLower.includes(textValue.toLowerCase());
    return {
      label: check.label,
      valuePresent,
      foundInDocument,
      valuePreview: valuePresent ? textValue.slice(0, 80) : "",
    };
  });

  const missingPlacementLabels = details
    .filter((item) => item.valuePresent && !item.foundInDocument)
    .map((item) => item.label);

  const unresolvedHintFragments = [
    "NAME OF THE HOUSE",
    "mention full postal address",
    "Name of the Constituency and the state",
    "**name of the political party",
  ].filter((hint) => plainTextLower.includes(hint.toLowerCase()));

  return {
    status: "ok",
    valid: missingPlacementLabels.length === 0,
    missingPlacementLabels,
    unresolvedHintFragments,
    details,
  };
}

async function sendManualPreviewDocx(req, res) {
  const data = normalizePreviewPayload(req.body || {});
  const formData = buildAffidavitFormData(data);
  const merged = buildMergedStructure(formData);

  const result = await buildDocxBufferFromMerged(merged);
  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    'inline; filename="Affidavit_preview.docx"',
  );
  return res.send(result.buffer);
}

async function sendSessionPreviewDocx(req, res, sessionId, mode = "preview") {
  const sessionMerged = await buildMergedForSession(sessionId);
  if (sessionMerged.error) {
    return res
      .status(sessionMerged.status || 500)
      .json({ error: sessionMerged.error });
  }

  const validity = buildSessionFieldValidityReport(
    sessionMerged.merged,
    sessionMerged.session,
  );

  const docxResult = await buildDocxBufferFromMerged(sessionMerged.merged);
  if (docxResult.error) {
    return res
      .status(docxResult.status || 500)
      .json({ error: docxResult.error });
  }

  const safeName = sessionMerged.session.candidate_name
    ? `Affidavit_${sessionMerged.session.candidate_name.replace(/[^a-zA-Z0-9]/g, "_")}`
    : `Affidavit_${String(sessionId).slice(0, 8)}`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader("X-Affidavit-Validation", validity.valid ? "valid" : "invalid");
  if (!validity.valid) {
    res.setHeader(
      "X-Affidavit-Missing-Required",
      validity.missingRequired.join(", "),
    );
  }
  if (mode === "export") {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.docx"`,
    );
  } else {
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeName}_preview.docx"`,
    );
  }
  return res.send(docxResult.buffer);
}

// ============================================
// EXPORT AS DOCX (Template-based)
// ============================================

router.post("/manual-entry/preview/docx", async (req, res) => {
  try {
    return await sendManualPreviewDocx(req, res);
  } catch (err) {
    console.error("Manual DOCX preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/manual-entry/preview/docx", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (sessionId) {
      return await sendSessionPreviewDocx(req, res, sessionId, "preview");
    }
    return res.status(400).json({
      error:
        "sessionId query param is required for GET preview. Use POST for live manual form preview payload.",
    });
  } catch (err) {
    console.error("Manual GET DOCX preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/preview/docx", async (req, res) => {
  try {
    // Generic alias for frontend integration simplicity.
    return await sendManualPreviewDocx(req, res);
  } catch (err) {
    console.error("Generic DOCX preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/preview/docx", async (req, res) => {
  try {
    const { id } = req.params;
    return await sendSessionPreviewDocx(req, res, id, "preview");
  } catch (err) {
    console.error("Session DOCX preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/export/docx", async (req, res) => {
  try {
    const { id } = req.params;
    return await sendSessionPreviewDocx(req, res, id, "export");
  } catch (err) {
    console.error("DOCX export error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/validation", async (req, res) => {
  try {
    const { id } = req.params;
    const includeTemplateAudit =
      String(req.query.includeTemplateAudit || "").toLowerCase() === "1" ||
      String(req.query.includeTemplateAudit || "").toLowerCase() === "true";

    const sessionMerged = await buildMergedForSession(id);
    if (sessionMerged.error) {
      return res
        .status(sessionMerged.status || 500)
        .json({ error: sessionMerged.error });
    }

    const validity = buildSessionFieldValidityReport(
      sessionMerged.merged,
      sessionMerged.session,
    );

    let templateAudit = null;
    if (includeTemplateAudit) {
      templateAudit = await buildTemplatePlacementAudit(sessionMerged.merged);
    }

    return res.json({
      sessionId: id,
      valid: validity.valid,
      missingRequired: validity.missingRequired,
      totalFieldEntries: validity.totalFieldEntries,
      details: validity.details,
      templateAudit,
    });
  } catch (err) {
    console.error("Session validation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SEARCH ACROSS ALL AFFIDAVITS
// ============================================

router.get("/search", async (req, res) => {
  try {
    const { candidate, party, constituency, state } = req.query;
    const where = [];
    const values = [];
    let idx = 1;

    if (candidate) {
      where.push(`LOWER(candidate_name) LIKE $${idx}`);
      values.push(`%${candidate.toLowerCase()}%`);
      idx++;
    }
    if (party) {
      where.push(`LOWER(party) LIKE $${idx}`);
      values.push(`%${party.toLowerCase()}%`);
      idx++;
    }
    if (constituency) {
      where.push(`LOWER(constituency) LIKE $${idx}`);
      values.push(`%${constituency.toLowerCase()}%`);
      idx++;
    }
    if (state) {
      where.push(`LOWER(state) LIKE $${idx}`);
      values.push(`%${state.toLowerCase()}%`);
      idx++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT id, original_filename, candidate_name, party,
             constituency, state, status,
             total_pages, processed_pages, created_at
      FROM affidavit_sessions
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT 100;
    `;
    const result = await query(sql, values);
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET ENTRIES FOR A SESSION
// ============================================

router.get("/sessions/:id/entries", async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.query;

    let sql = `SELECT * FROM affidavit_entries WHERE session_id=$1`;
    const values = [id];

    if (category) {
      sql += ` AND field_category=$2`;
      values.push(category);
    }

    sql += ` ORDER BY field_category, field_name`;

    const result = await query(sql, values);
    const categories = [...new Set(result.rows.map((r) => r.field_category))];

    res.json({
      entries: result.rows,
      categories,
      total: result.rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET FORM SCHEMA (for frontend rendering)
// ============================================

router.get("/form-schema", async (_req, res) => {
  res.json({ schema: getAffidavitFormSchema() });
});

// ============================================
// HELPERS
// ============================================

function firstValue(data, keys, fallback = "") {
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      if (!value.trim()) continue;
      return value;
    }
    return value;
  }
  return fallback;
}

function toBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function toObjectLike(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return fallback;
      }
    }
  }
  return fallback;
}

function toArrayLike(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return fallback;
      }
    }
  }
  return fallback;
}

function buildAffidavitFormData(data) {
  const input = data && typeof data === "object" ? data : {};
  const governmentAccommodation = toObjectLike(
    input.governmentAccommodation,
    {},
  );

  const formData = {
    houseName: firstValue(input, ["houseName", "house_name", "house"], ""),
    constituency: firstValue(
      input,
      ["constituency", "assemblyConstituency", "assembly_constituency"],
      "",
    ),
    candidateName: firstValue(
      input,
      ["candidateName", "candidate_name", "name"],
      "",
    ),
    fatherMotherHusbandName: firstValue(
      input,
      [
        "fatherMotherHusbandName",
        "parentSpouseName",
        "father_name",
        "spouse_name",
      ],
      "",
    ),
    age: firstValue(input, ["age"], ""),
    postalAddress: firstValue(
      input,
      ["postalAddress", "address", "postal_address"],
      "",
    ),
    party: firstValue(
      input,
      ["party", "politicalPartyName", "political_party"],
      "",
    ),
    isIndependent: toBooleanLike(
      firstValue(
        input,
        ["isIndependent", "independent", "is_independent"],
        false,
      ),
      false,
    ),
    enrolledConstituency: firstValue(
      input,
      ["enrolledConstituency", "enrolled_constituency"],
      "",
    ),
    serialNumber: firstValue(
      input,
      ["serialNumber", "serial_no", "electoralSerialNo"],
      "",
    ),
    partNumber: firstValue(
      input,
      ["partNumber", "part_no", "electoralPartNo"],
      "",
    ),
    telephone: firstValue(
      input,
      ["telephone", "contactNumber", "phone", "telephoneNumber"],
      "",
    ),
    email: firstValue(input, ["email", "emailId", "email_id"], ""),
    socialMedia1: firstValue(input, ["socialMedia1", "social_media_1"], ""),
    socialMedia2: firstValue(input, ["socialMedia2", "social_media_2"], ""),
    socialMedia3: firstValue(input, ["socialMedia3", "social_media_3"], ""),

    // Photo & Signature URLs
    candidatePhotoUrl: firstValue(
      input,
      ["candidatePhotoUrl", "candidate_photo_url", "photoUrl"],
      "",
    ),
    candidateSignatureUrl: firstValue(
      input,
      ["candidateSignatureUrl", "candidate_signature_url", "signatureUrl"],
      "",
    ),

    panEntries: toArrayLike(input.panEntries, []),
    hasPendingCases: firstValue(input, ["hasPendingCases"], "No"),
    pendingCases: toArrayLike(input.pendingCases, []),
    hasConvictions: firstValue(input, ["hasConvictions"], "No"),
    convictions: toArrayLike(input.convictions, []),
    informedParty: firstValue(input, ["informedParty"], ""),
    movableAssets: toObjectLike(input.movableAssets, {}),
    immovableAssets: toObjectLike(input.immovableAssets, {}),
    liabilities: toObjectLike(input.liabilities, {}),
    disputedLiabilities: firstValue(input, ["disputedLiabilities"], ""),
    governmentDues: toObjectLike(input.governmentDues, {}),
    governmentAccommodation: {
      occupied: firstValue(governmentAccommodation, ["occupied"], "No"),
      address: firstValue(governmentAccommodation, ["address"], ""),
      noDues: firstValue(governmentAccommodation, ["noDues"], "Yes"),
      duesDate: firstValue(governmentAccommodation, ["duesDate"], ""),
      rentDues: firstValue(governmentAccommodation, ["rentDues"], ""),
      electricityDues: firstValue(
        governmentAccommodation,
        ["electricityDues"],
        "",
      ),
      waterDues: firstValue(governmentAccommodation, ["waterDues"], ""),
      telephoneDues: firstValue(governmentAccommodation, ["telephoneDues"], ""),
    },
    selfProfession: firstValue(input, ["selfProfession", "professionSelf"], ""),
    spouseProfession: firstValue(
      input,
      ["spouseProfession", "professionSpouse"],
      "",
    ),
    selfIncome: firstValue(input, ["selfIncome", "sourceOfIncomeSelf"], ""),
    spouseIncome: firstValue(
      input,
      ["spouseIncome", "sourceOfIncomeSpouse"],
      "",
    ),
    dependentIncome: firstValue(
      input,
      ["dependentIncome", "sourceOfIncomeDependents"],
      "",
    ),
    contractsCandidate: firstValue(input, ["contractsCandidate"], ""),
    contractsSpouse: firstValue(input, ["contractsSpouse"], ""),
    contractsDependents: firstValue(input, ["contractsDependents"], ""),
    contractsHUF: firstValue(input, ["contractsHUF"], ""),
    contractsPartnershipFirms: firstValue(
      input,
      ["contractsPartnershipFirms"],
      "",
    ),
    contractsPrivateCompanies: firstValue(
      input,
      ["contractsPrivateCompanies"],
      "",
    ),
    educationalQualification: firstValue(
      input,
      ["educationalQualification", "education", "qualification"],
      "",
    ),
    partBOverrides: toObjectLike(input.partBOverrides, {}),
    verificationPlace: firstValue(input, ["verificationPlace", "place"], ""),
    verificationDate: firstValue(
      input,
      ["verificationDate", "date", "verification_date"],
      "",
    ),
    state: firstValue(input, ["state"], ""),
    date: firstValue(input, ["date", "verificationDate"], ""),

    // Oath Commissioner
    oathCommissionerName: firstValue(
      input,
      ["oathCommissionerName", "oath_commissioner_name"],
      "",
    ),
    oathCommissionerDesignation: firstValue(
      input,
      ["oathCommissionerDesignation", "oath_commissioner_designation"],
      "",
    ),
    oathCommissionerSealNo: firstValue(
      input,
      ["oathCommissionerSealNo", "oath_commissioner_seal_no"],
      "",
    ),
  };

  const knownKeys = new Set([
    ...Object.keys(formData),
    "house_name",
    "house",
    "assembly_constituency",
    "candidate_name",
    "name",
    "parentSpouseName",
    "father_name",
    "spouse_name",
    "address",
    "postal_address",
    "politicalPartyName",
    "political_party",
    "independent",
    "is_independent",
    "enrolled_constituency",
    "serial_no",
    "electoralSerialNo",
    "part_no",
    "electoralPartNo",
    "contactNumber",
    "phone",
    "telephoneNumber",
    "emailId",
    "email_id",
    "social_media_1",
    "social_media_2",
    "social_media_3",
    "candidate_photo_url",
    "photoUrl",
    "candidate_signature_url",
    "signatureUrl",
    "professionSelf",
    "professionSpouse",
    "sourceOfIncomeSelf",
    "sourceOfIncomeSpouse",
    "sourceOfIncomeDependents",
    "education",
    "qualification",
    "verification_date",
    "oath_commissioner_name",
    "oath_commissioner_designation",
    "oath_commissioner_seal_no",
  ]);

  for (const [key, value] of Object.entries(input)) {
    if (knownKeys.has(key)) continue;
    if (value === undefined) continue;
    formData[key] = value;
  }

  return formData;
}

function buildMergedStructure(formData) {
  const mergedFields = {
    ...formData,
    assemblyConstituency: formData.constituency,
    enrolledConstituency:
      formData.enrolledConstituency || formData.constituency,
    date: formData.verificationDate || formData.date,
  };

  const merged = {
    formType: "Form 26",
    documentTitle: "AFFIDAVIT",
    state: formData.state,
    constituency: formData.constituency,
    fields: mergedFields,
    criminalRecord: {
      hasPendingCases: formData.hasPendingCases,
      hasConvictions: formData.hasConvictions,
    },
    tables: [],
    sections: [],
    assets: {
      movable: formData.movableAssets || {},
      immovable: formData.immovableAssets || {},
    },
    liabilities: formData.liabilities || {},
    governmentAccommodation: formData.governmentAccommodation || {},
  };

  merged.tables = buildAffidavitTables(formData);
  return merged;
}

function buildAffidavitTables(formData) {
  const tables = [];

  // PAN / Income Tax
  if (formData.panEntries && formData.panEntries.length > 0) {
    const panRows = [];
    for (const entry of formData.panEntries) {
      if (entry.years && entry.years.length > 0) {
        for (let i = 0; i < entry.years.length; i++) {
          const yr = entry.years[i];
          if (i === 0) {
            panRows.push([
              entry.slNo || "",
              entry.name || "",
              entry.pan || "",
              yr.year || "",
              yr.income || "",
            ]);
          } else {
            panRows.push([yr.year || "", yr.income || ""]);
          }
        }
      } else {
        panRows.push([
          entry.slNo || "",
          entry.name || "",
          entry.pan || "",
          "",
          "",
        ]);
      }
    }
    tables.push({
      tableTitle:
        "Details of Permanent Account Number (PAN) and Income Tax Return",
      headers: [
        "Sl. No.",
        "Names",
        "PAN",
        "Financial Year",
        "Total Income (Rs.)",
      ],
      rows: panRows,
    });
  }

  // Pending Criminal Cases
  if (
    formData.hasPendingCases === "Yes" &&
    formData.pendingCases &&
    formData.pendingCases.length > 0
  ) {
    tables.push({
      tableTitle: "Pending Criminal Cases",
      headers: [
        "(a) FIR No.",
        "(b) Case No.",
        "(c) Sections",
        "(d) Description",
        "(e) Charges framed",
        "(f) Charges date",
        "(g) Appeal filed",
      ],
      rows: formData.pendingCases.map((c) => [
        c.firNo || "",
        c.caseNo || "",
        c.sections || "",
        c.description || "",
        c.chargesFramed || "",
        c.chargesDate || "",
        c.appealFiled || "",
      ]),
    });
  }

  // Convictions
  if (
    formData.hasConvictions === "Yes" &&
    formData.convictions &&
    formData.convictions.length > 0
  ) {
    tables.push({
      tableTitle: "Cases of Conviction",
      headers: [
        "(a) Case No.",
        "(b) Court Name",
        "(c) Sections",
        "(d) Description",
        "(e) Conviction Date",
        "(f) Punishment",
        "(g) Appeal filed",
        "(h) Appeal status",
      ],
      rows: formData.convictions.map((c) => [
        c.caseNo || "",
        c.courtName || "",
        c.sections || "",
        c.description || "",
        c.convictionDate || "",
        c.punishment || "",
        c.appealFiled || "",
        c.appealStatus || "",
      ]),
    });
  }

  // Movable Assets
  if (
    formData.movableAssets &&
    Object.keys(formData.movableAssets).length > 0
  ) {
    const ma = formData.movableAssets;
    tables.push({
      tableTitle: "Movable Assets",
      headers: [
        "S.No.",
        "Description",
        "Self",
        "Spouse",
        "HUF",
        "Dep-1",
        "Dep-2",
        "Dep-3",
      ],
      rows: [
        [
          "(i)",
          "Cash in hand",
          ma.cashSelf || "",
          ma.cashSpouse || "",
          ma.cashHUF || "",
          ma.cashDep1 || "",
          ma.cashDep2 || "",
          ma.cashDep3 || "",
        ],
        [
          "(ii)",
          "Bank deposits",
          ma.bankSelf || "",
          ma.bankSpouse || "",
          ma.bankHUF || "",
          ma.bankDep1 || "",
          ma.bankDep2 || "",
          ma.bankDep3 || "",
        ],
        [
          "(iii)",
          "Bonds/Shares/Debentures",
          ma.bondsSelf || "",
          ma.bondsSpouse || "",
          ma.bondsHUF || "",
          ma.bondsDep1 || "",
          ma.bondsDep2 || "",
          ma.bondsDep3 || "",
        ],
        [
          "(iv)",
          "NSS/Postal/Insurance",
          ma.nssSelf || "",
          ma.nssSpouse || "",
          ma.nssHUF || "",
          ma.nssDep1 || "",
          ma.nssDep2 || "",
          ma.nssDep3 || "",
        ],
        [
          "(v)",
          "Personal loans/advances",
          ma.loansSelf || "",
          ma.loansSpouse || "",
          ma.loansHUF || "",
          ma.loansDep1 || "",
          ma.loansDep2 || "",
          ma.loansDep3 || "",
        ],
        [
          "(vi)",
          "Motor vehicles",
          ma.motorSelf || "",
          ma.motorSpouse || "",
          ma.motorHUF || "",
          ma.motorDep1 || "",
          ma.motorDep2 || "",
          ma.motorDep3 || "",
        ],
        [
          "(vii)",
          "Jewellery",
          ma.jewellSelf || "",
          ma.jewellSpouse || "",
          ma.jewellHUF || "",
          ma.jewellDep1 || "",
          ma.jewellDep2 || "",
          ma.jewellDep3 || "",
        ],
        [
          "(viii)",
          "Other assets",
          ma.otherSelf || "",
          ma.otherSpouse || "",
          ma.otherHUF || "",
          ma.otherDep1 || "",
          ma.otherDep2 || "",
          ma.otherDep3 || "",
        ],
        [
          "(ix)",
          "Gross Total",
          ma.totalSelf || "",
          ma.totalSpouse || "",
          ma.totalHUF || "",
          ma.totalDep1 || "",
          ma.totalDep2 || "",
          ma.totalDep3 || "",
        ],
      ],
    });
  }

  // Immovable Assets
  if (
    formData.immovableAssets &&
    Object.keys(formData.immovableAssets).length > 0
  ) {
    const ia = formData.immovableAssets;
    const rows = [];
    const types = [
      { key: "agricultural", label: "Agricultural Land" },
      { key: "nonAgricultural", label: "Non-Agricultural Land" },
      { key: "commercial", label: "Commercial Building" },
      { key: "residential", label: "Residential Building" },
      { key: "others", label: "Others" },
    ];
    for (const { key, label } of types) {
      if (ia[key]) {
        for (const item of Array.isArray(ia[key]) ? ia[key] : [ia[key]]) {
          rows.push([
            label,
            item.location || "",
            item.surveyNo || "",
            item.area || "",
            item.inherited || "",
            item.purchaseDate || "",
            item.purchaseCost || "",
            item.investment || "",
            item.marketValue || "",
          ]);
        }
      }
    }
    if (rows.length > 0) {
      tables.push({
        tableTitle: "Immovable Assets",
        headers: [
          "Type",
          "Location",
          "Survey No.",
          "Area",
          "Inherited",
          "Purchase Date",
          "Purchase Cost",
          "Investment",
          "Market Value",
        ],
        rows,
      });
    }
  }

  // Liabilities
  if (formData.liabilities && Object.keys(formData.liabilities).length > 0) {
    const lb = formData.liabilities;
    tables.push({
      tableTitle: "Liabilities",
      headers: [
        "S.No.",
        "Description",
        "Self",
        "Spouse",
        "HUF",
        "Dep-1",
        "Dep-2",
        "Dep-3",
      ],
      rows: [
        [
          "(i)",
          "Loans from Banks/FIs",
          lb.bankLoansSelf || "",
          lb.bankLoansSpouse || "",
          lb.bankLoansHUF || "",
          lb.bankLoansDep1 || "",
          lb.bankLoansDep2 || "",
          lb.bankLoansDep3 || "",
        ],
        [
          "(ii)",
          "Loans from others",
          lb.otherLoansSelf || "",
          lb.otherLoansSpouse || "",
          lb.otherLoansHUF || "",
          lb.otherLoansDep1 || "",
          lb.otherLoansDep2 || "",
          lb.otherLoansDep3 || "",
        ],
        [
          "(iii)",
          "Other liabilities",
          lb.otherLiabSelf || "",
          lb.otherLiabSpouse || "",
          lb.otherLiabHUF || "",
          lb.otherLiabDep1 || "",
          lb.otherLiabDep2 || "",
          lb.otherLiabDep3 || "",
        ],
        [
          "(iv)",
          "Grand Total",
          lb.totalSelf || "",
          lb.totalSpouse || "",
          lb.totalHUF || "",
          lb.totalDep1 || "",
          lb.totalDep2 || "",
          lb.totalDep3 || "",
        ],
      ],
    });
  }

  // Government Dues
  if (
    formData.governmentDues &&
    Object.keys(formData.governmentDues).length > 0
  ) {
    const gd = formData.governmentDues;
    tables.push({
      tableTitle: "Government Dues",
      headers: [
        "S.No.",
        "Description",
        "Self",
        "Spouse",
        "HUF",
        "Dep-1",
        "Dep-2",
        "Dep-3",
      ],
      rows: [
        [
          "(iii)",
          "Transport dues",
          gd.transportSelf || "",
          gd.transportSpouse || "",
          gd.transportHUF || "",
          gd.transportDep1 || "",
          gd.transportDep2 || "",
          gd.transportDep3 || "",
        ],
        [
          "(iv)",
          "Income Tax dues",
          gd.incomeTaxSelf || "",
          gd.incomeTaxSpouse || "",
          gd.incomeTaxHUF || "",
          gd.incomeTaxDep1 || "",
          gd.incomeTaxDep2 || "",
          gd.incomeTaxDep3 || "",
        ],
        [
          "(v)",
          "GST dues",
          gd.gstSelf || "",
          gd.gstSpouse || "",
          gd.gstHUF || "",
          gd.gstDep1 || "",
          gd.gstDep2 || "",
          gd.gstDep3 || "",
        ],
        [
          "(vi)",
          "Municipal/Property tax",
          gd.municipalSelf || "",
          gd.municipalSpouse || "",
          gd.municipalHUF || "",
          gd.municipalDep1 || "",
          gd.municipalDep2 || "",
          gd.municipalDep3 || "",
        ],
        [
          "(vii)",
          "Other dues",
          gd.otherSelf || "",
          gd.otherSpouse || "",
          gd.otherHUF || "",
          gd.otherDep1 || "",
          gd.otherDep2 || "",
          gd.otherDep3 || "",
        ],
        [
          "(viii)",
          "Grand total",
          gd.totalSelf || "",
          gd.totalSpouse || "",
          gd.totalHUF || "",
          gd.totalDep1 || "",
          gd.totalDep2 || "",
          gd.totalDep3 || "",
        ],
      ],
    });
  }

  return tables;
}

function flattenFields(formData) {
  const flat = {};

  const saveField = (path, value) => {
    if (!path) return;
    if (value === undefined || value === null) return;

    if (typeof value === "string") {
      if (!value.trim()) return;
      flat[path] = value;
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      flat[path] = String(value);
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      flat[path] = JSON.stringify(value);
      return;
    }

    if (typeof value === "object") {
      if (Object.keys(value).length === 0) return;
      flat[path] = JSON.stringify(value);
    }
  };

  const walk = (value, path = "") => {
    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      if (path) saveField(path, value);
      value.forEach((item, index) => {
        const itemPath = path ? `${path}[${index}]` : `[${index}]`;
        walk(item, itemPath);
      });
      return;
    }

    if (typeof value === "object") {
      if (path) saveField(path, value);
      for (const [key, nestedValue] of Object.entries(value)) {
        const nestedPath = path ? `${path}.${key}` : key;
        walk(nestedValue, nestedPath);
      }
      return;
    }

    saveField(path, value);
  };

  walk(formData);
  return flat;
}

function categorizeField(fieldName) {
  if (fieldName.startsWith("criminal_")) return "criminal_record";
  if (fieldName.startsWith("officeOfProfit_")) return "office_of_profit";
  if (fieldName.startsWith("insolvency_")) return "insolvency";
  if (fieldName.startsWith("foreignAllegiance_")) return "foreign_allegiance";
  if (fieldName.startsWith("disqualification_")) return "disqualification";
  if (fieldName.startsWith("dismissalForCorruption_"))
    return "dismissal_corruption";
  if (fieldName.startsWith("governmentContracts_"))
    return "government_contracts";
  if (fieldName.startsWith("asset_movable_")) return "assets_movable";
  if (fieldName.startsWith("asset_immovable_")) return "assets_immovable";
  if (fieldName.startsWith("liability_")) return "liabilities";
  if (fieldName.startsWith("govDues_")) return "government_dues";
  if (
    [
      "candidateName",
      "fatherMotherHusbandName",
      "postalAddress",
      "serialNumber",
      "partNumber",
      "assemblyConstituency",
      "party",
      "age",
      "date",
      "language",
      "constituency",
      "state",
      "telephone",
      "email",
      "enrolledConstituency",
    ].includes(fieldName)
  )
    return "candidate_info";
  return "general";
}

function getAffidavitFormSchema() {
  return {
    title: "Form 26 — Affidavit",
    description:
      "Affidavit to be filed by the candidate along with nomination paper before the Returning Officer",
    sections: [
      {
        id: "header",
        title: "Election Details",
        fields: [
          {
            name: "houseName",
            label: "Name of the House",
            type: "text",
            placeholder: "e.g. Legislative Assembly",
          },
          {
            name: "constituency",
            label: "Constituency Name",
            type: "text",
            placeholder: "e.g. 116 BIDHANNAGAR",
          },
          {
            name: "state",
            label: "State",
            type: "text",
            placeholder: "e.g. WEST BENGAL",
          },
        ],
      },
      {
        id: "personal",
        title: "Part A — Personal Details",
        fields: [
          { name: "candidateName", label: "Candidate Full Name", type: "text" },
          {
            name: "fatherMotherHusbandName",
            label: "Father's/Mother's/Husband's Name",
            type: "text",
          },
          { name: "age", label: "Age (years)", type: "text" },
          {
            name: "postalAddress",
            label: "Full Postal Address",
            type: "textarea",
          },
          {
            name: "party",
            label: "Political Party Name",
            type: "text",
            placeholder: "Leave blank if independent",
          },
          {
            name: "isIndependent",
            label: "Contesting as Independent",
            type: "checkbox",
          },
          {
            name: "enrolledConstituency",
            label: "Enrolled Constituency & State",
            type: "text",
          },
          {
            name: "serialNumber",
            label: "Serial No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partNumber",
            label: "Part No. in Electoral Roll",
            type: "text",
          },
          { name: "telephone", label: "Telephone Number(s)", type: "text" },
          { name: "email", label: "Email ID", type: "text" },
          {
            name: "socialMedia1",
            label: "Social Media Account (i)",
            type: "text",
          },
          {
            name: "socialMedia2",
            label: "Social Media Account (ii)",
            type: "text",
          },
          {
            name: "socialMedia3",
            label: "Social Media Account (iii)",
            type: "text",
          },
          {
            name: "candidatePhotoUrl",
            label: "Candidate Photograph",
            type: "image_upload",
            accept: "image/jpeg,image/png",
            description: "Upload passport-size photograph of the candidate",
          },
          {
            name: "candidateSignatureUrl",
            label: "Candidate Signature",
            type: "image_upload",
            accept: "image/jpeg,image/png",
            description: "Upload scanned signature of the deponent",
          },
        ],
      },
      {
        id: "pan_income",
        title: "PAN & Income Tax Details",
        description:
          "Details of PAN and last 5 years income tax returns for Self, Spouse, HUF, and Dependents",
        type: "table",
        tableConfig: {
          name: "panEntries",
          columns: [
            { name: "slNo", label: "Sl. No." },
            { name: "name", label: "Name" },
            { name: "pan", label: "PAN" },
          ],
          subTable: {
            name: "years",
            label: "Financial Year & Income (up to 5 entries)",
            columns: [
              { name: "year", label: "Financial Year" },
              { name: "income", label: "Total Income (Rs.)" },
            ],
            maxRows: 5,
          },
          defaultRows: [
            { slNo: "1", label: "Self" },
            { slNo: "2", label: "Spouse" },
            { slNo: "3", label: "HUF" },
            { slNo: "4", label: "Dependent 1" },
            { slNo: "5", label: "Dependent 2" },
            { slNo: "6", label: "Dependent 3" },
          ],
        },
      },
      {
        id: "criminal_pending",
        title: "Pending Criminal Cases",
        fields: [
          {
            name: "hasPendingCases",
            label: "Any pending criminal cases?",
            type: "select",
            options: ["No", "Yes"],
          },
        ],
        conditionalTable: {
          showWhen: { field: "hasPendingCases", value: "Yes" },
          name: "pendingCases",
          label: "Details of Pending Cases",
          columns: [
            { name: "firNo", label: "(a) FIR No. with Police Station" },
            { name: "caseNo", label: "(b) Case No. with Court Name" },
            { name: "sections", label: "(c) Sections of Acts" },
            { name: "description", label: "(d) Brief Description" },
            { name: "chargesFramed", label: "(e) Charges Framed? (Yes/No)" },
            { name: "chargesDate", label: "(f) Date Charges Framed" },
            { name: "appealFiled", label: "(g) Appeal Filed? (Yes/No)" },
          ],
        },
      },
      {
        id: "criminal_conviction",
        title: "Cases of Conviction",
        fields: [
          {
            name: "hasConvictions",
            label: "Any convictions?",
            type: "select",
            options: ["No", "Yes"],
          },
        ],
        conditionalTable: {
          showWhen: { field: "hasConvictions", value: "Yes" },
          name: "convictions",
          label: "Details of Convictions",
          columns: [
            { name: "caseNo", label: "(a) Case No." },
            { name: "courtName", label: "(b) Court Name" },
            { name: "sections", label: "(c) Sections" },
            { name: "description", label: "(d) Description" },
            { name: "convictionDate", label: "(e) Conviction Date" },
            { name: "punishment", label: "(f) Punishment" },
            { name: "appealFiled", label: "(g) Appeal Filed?" },
            { name: "appealStatus", label: "(h) Appeal Status" },
          ],
        },
      },
      {
        id: "party_info",
        title: "Party Information (6A)",
        fields: [
          {
            name: "informedParty",
            label: "Information given to political party about criminal cases",
            type: "textarea",
            placeholder: "Write NOT APPLICABLE if 5(i) and 6(i) selected",
          },
        ],
      },
      {
        id: "movable_assets",
        title: "Movable Assets",
        description:
          "Details of movable assets of Self, Spouse, HUF, and Dependents",
        type: "asset_table",
        tableConfig: {
          name: "movableAssets",
          personColumns: ["Self", "Spouse", "HUF", "Dep-1", "Dep-2", "Dep-3"],
          rows: [
            {
              id: "cash",
              label: "(i) Cash in hand",
              keys: [
                "cashSelf",
                "cashSpouse",
                "cashHUF",
                "cashDep1",
                "cashDep2",
                "cashDep3",
              ],
            },
            {
              id: "bank",
              label: "(ii) Bank deposits",
              keys: [
                "bankSelf",
                "bankSpouse",
                "bankHUF",
                "bankDep1",
                "bankDep2",
                "bankDep3",
              ],
            },
            {
              id: "bonds",
              label: "(iii) Bonds/Shares/Debentures",
              keys: [
                "bondsSelf",
                "bondsSpouse",
                "bondsHUF",
                "bondsDep1",
                "bondsDep2",
                "bondsDep3",
              ],
            },
            {
              id: "nss",
              label: "(iv) NSS/Postal/Insurance",
              keys: [
                "nssSelf",
                "nssSpouse",
                "nssHUF",
                "nssDep1",
                "nssDep2",
                "nssDep3",
              ],
            },
            {
              id: "loans",
              label: "(v) Personal loans/advances",
              keys: [
                "loansSelf",
                "loansSpouse",
                "loansHUF",
                "loansDep1",
                "loansDep2",
                "loansDep3",
              ],
            },
            {
              id: "motor",
              label: "(vi) Motor vehicles",
              keys: [
                "motorSelf",
                "motorSpouse",
                "motorHUF",
                "motorDep1",
                "motorDep2",
                "motorDep3",
              ],
            },
            {
              id: "jewell",
              label: "(vii) Jewellery/bullion",
              keys: [
                "jewellSelf",
                "jewellSpouse",
                "jewellHUF",
                "jewellDep1",
                "jewellDep2",
                "jewellDep3",
              ],
            },
            {
              id: "other",
              label: "(viii) Other assets",
              keys: [
                "otherSelf",
                "otherSpouse",
                "otherHUF",
                "otherDep1",
                "otherDep2",
                "otherDep3",
              ],
            },
            {
              id: "total",
              label: "(ix) Gross Total",
              keys: [
                "totalSelf",
                "totalSpouse",
                "totalHUF",
                "totalDep1",
                "totalDep2",
                "totalDep3",
              ],
            },
          ],
        },
      },
      {
        id: "immovable_assets",
        title: "Immovable Assets",
        description:
          "Details of each immovable property (land, buildings, apartments)",
        type: "dynamic_table",
        tableConfig: {
          name: "immovableAssets",
          categories: [
            { id: "agricultural", label: "Agricultural Land" },
            { id: "nonAgricultural", label: "Non-Agricultural Land" },
            { id: "commercial", label: "Commercial Buildings" },
            { id: "residential", label: "Residential Buildings" },
            { id: "others", label: "Others" },
          ],
          fieldsPerEntry: [
            { name: "location", label: "Location" },
            { name: "surveyNo", label: "Survey Number" },
            { name: "area", label: "Area" },
            { name: "inherited", label: "Inherited? (Yes/No)" },
            { name: "purchaseDate", label: "Purchase Date" },
            { name: "purchaseCost", label: "Purchase Cost" },
            { name: "investment", label: "Investment on property" },
            { name: "marketValue", label: "Current Market Value" },
          ],
        },
      },
      {
        id: "liabilities",
        title: "Liabilities",
        type: "asset_table",
        tableConfig: {
          name: "liabilities",
          personColumns: ["Self", "Spouse", "HUF", "Dep-1", "Dep-2", "Dep-3"],
          rows: [
            {
              id: "bankLoans",
              label: "(i) Loans from Banks/FIs",
              keys: [
                "bankLoansSelf",
                "bankLoansSpouse",
                "bankLoansHUF",
                "bankLoansDep1",
                "bankLoansDep2",
                "bankLoansDep3",
              ],
            },
            {
              id: "otherLoans",
              label: "(ii) Loans from others",
              keys: [
                "otherLoansSelf",
                "otherLoansSpouse",
                "otherLoansHUF",
                "otherLoansDep1",
                "otherLoansDep2",
                "otherLoansDep3",
              ],
            },
            {
              id: "otherLiab",
              label: "(iii) Other liabilities",
              keys: [
                "otherLiabSelf",
                "otherLiabSpouse",
                "otherLiabHUF",
                "otherLiabDep1",
                "otherLiabDep2",
                "otherLiabDep3",
              ],
            },
            {
              id: "total",
              label: "(iv) Grand Total",
              keys: [
                "totalSelf",
                "totalSpouse",
                "totalHUF",
                "totalDep1",
                "totalDep2",
                "totalDep3",
              ],
            },
          ],
        },
      },
      {
        id: "gov_dues",
        title: "Government Dues",
        type: "asset_table",
        tableConfig: {
          name: "governmentDues",
          personColumns: ["Self", "Spouse", "HUF", "Dep-1", "Dep-2", "Dep-3"],
          rows: [
            {
              id: "transport",
              label: "(iii) Transport dues",
              keys: [
                "transportSelf",
                "transportSpouse",
                "transportHUF",
                "transportDep1",
                "transportDep2",
                "transportDep3",
              ],
            },
            {
              id: "incomeTax",
              label: "(iv) Income Tax dues",
              keys: [
                "incomeTaxSelf",
                "incomeTaxSpouse",
                "incomeTaxHUF",
                "incomeTaxDep1",
                "incomeTaxDep2",
                "incomeTaxDep3",
              ],
            },
            {
              id: "gst",
              label: "(v) GST dues",
              keys: [
                "gstSelf",
                "gstSpouse",
                "gstHUF",
                "gstDep1",
                "gstDep2",
                "gstDep3",
              ],
            },
            {
              id: "municipal",
              label: "(vi) Municipal/Property tax",
              keys: [
                "municipalSelf",
                "municipalSpouse",
                "municipalHUF",
                "municipalDep1",
                "municipalDep2",
                "municipalDep3",
              ],
            },
            {
              id: "other",
              label: "(vii) Other dues",
              keys: [
                "otherSelf",
                "otherSpouse",
                "otherHUF",
                "otherDep1",
                "otherDep2",
                "otherDep3",
              ],
            },
            {
              id: "total",
              label: "(viii) Grand total",
              keys: [
                "totalSelf",
                "totalSpouse",
                "totalHUF",
                "totalDep1",
                "totalDep2",
                "totalDep3",
              ],
            },
          ],
        },
      },
      {
        id: "disputed_liabilities",
        title: "Disputed Liabilities",
        fields: [
          {
            name: "disputedLiabilities",
            label: "Details of disputed liabilities (if any)",
            type: "textarea",
            placeholder: "Write NIL if no disputed liabilities",
          },
        ],
      },
      {
        id: "gov_accommodation",
        title: "Government Accommodation",
        fields: [
          {
            name: "governmentAccommodation.occupied",
            label: "Occupied Govt. accommodation in last 10 years?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "governmentAccommodation.address",
            label: "Address of Govt. accommodation",
            type: "textarea",
          },
          {
            name: "governmentAccommodation.noDues",
            label: "No dues payable as on date",
            type: "select",
            options: ["Yes", "No"],
          },
          {
            name: "governmentAccommodation.duesDate",
            label: "Dues payable as on date (if applicable)",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
          {
            name: "governmentAccommodation.rentDues",
            label: "Rent dues (Rs.)",
            type: "text",
          },
          {
            name: "governmentAccommodation.electricityDues",
            label: "Electricity dues (Rs.)",
            type: "text",
          },
          {
            name: "governmentAccommodation.waterDues",
            label: "Water dues (Rs.)",
            type: "text",
          },
          {
            name: "governmentAccommodation.telephoneDues",
            label: "Telephone dues (Rs.)",
            type: "text",
          },
        ],
      },
      {
        id: "profession",
        title: "Profession & Income",
        fields: [
          { name: "selfProfession", label: "Profession — Self", type: "text" },
          {
            name: "spouseProfession",
            label: "Profession — Spouse",
            type: "text",
          },
          {
            name: "selfIncome",
            label: "Source of Income — Self",
            type: "text",
          },
          {
            name: "spouseIncome",
            label: "Source of Income — Spouse",
            type: "text",
          },
          {
            name: "dependentIncome",
            label: "Source of Income — Dependents",
            type: "text",
          },
        ],
      },
      {
        id: "contracts",
        title: "Contracts with Government",
        fields: [
          {
            name: "contractsCandidate",
            label: "Contracts by Candidate",
            type: "textarea",
          },
          {
            name: "contractsSpouse",
            label: "Contracts by Spouse",
            type: "textarea",
          },
          {
            name: "contractsDependents",
            label: "Contracts by Dependents",
            type: "textarea",
          },
          {
            name: "contractsHUF",
            label: "Contracts by HUF/Trust",
            type: "textarea",
          },
          {
            name: "contractsPartnershipFirms",
            label: "Contracts by Partnership Firms",
            type: "textarea",
          },
          {
            name: "contractsPrivateCompanies",
            label: "Contracts by Private Companies",
            type: "textarea",
          },
        ],
      },
      {
        id: "education",
        title: "Education",
        fields: [
          {
            name: "educationalQualification",
            label: "Highest Educational Qualification",
            type: "textarea",
            placeholder:
              "Full form of certificate/diploma/degree, name of School/College/University, year completed",
          },
        ],
      },
      {
        id: "verification",
        title: "Verification",
        fields: [
          {
            name: "verificationPlace",
            label: "Place of Verification",
            type: "text",
          },
          {
            name: "verificationDate",
            label: "Date of Verification",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "oath_commissioner",
        title: "Oath Commissioner / Notary Details",
        fields: [
          {
            name: "oathCommissionerName",
            label: "Name of Oath Commissioner / Notary",
            type: "text",
          },
          {
            name: "oathCommissionerDesignation",
            label: "Designation",
            type: "text",
            placeholder: "e.g. Notary Public / Oath Commissioner",
          },
          {
            name: "oathCommissionerSealNo",
            label: "Seal / Registration No.",
            type: "text",
          },
        ],
      },
    ],
  };
}

export default router;
