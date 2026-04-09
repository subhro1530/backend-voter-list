/**
 * Nomination Routes — Manual Entry, Database Storage, DOCX Export
 *
 * Admin-only endpoints for:
 *   1. Manual entry of all Nomination Paper (Form 2B) fields
 *   2. Store structured data in PostgreSQL (nomination_sessions)
 *   3. Export as DOCX using the original template with exact formatting
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import AdmZip from "adm-zip";
import { query } from "../db.js";
import { authenticate, adminOnly } from "../auth.js";
import {
  fillNominationTemplate,
  nominationTemplateExists,
} from "../nominationDocxTemplate.js";
import { uploadImageBuffer } from "../cloudinary.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate);
router.use(adminOnly);

// ============================================
// MANUAL ENTRY — Create / Update Nomination
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

    const formData = buildNominationFormData(data);

    const candidateName = formData.candidateName || "";
    const fatherName = formData.fatherMotherHusbandName || "";
    const postalAddress = formData.postalAddress || "";
    const party = formData.party || "";
    const constituency = formData.constituency || "";
    const state = formData.state || "";

    const candidatePhotoUrl = formData.candidatePhotoUrl || "";
    const candidateSignatureUrl = formData.candidateSignatureUrl || "";

    if (isUpdate) {
      const existing = await query(
        "SELECT id FROM nomination_sessions WHERE id=$1",
        [sessionId],
      );
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      await query(
        `UPDATE nomination_sessions
         SET candidate_name=$1, father_mother_husband_name=$2,
             postal_address=$3, party=$4, constituency=$5, state=$6,
             form_data=$7, candidate_photo_url=$8, candidate_signature_url=$9,
             status='completed', updated_at=now()
         WHERE id=$10`,
        [
          candidateName,
          fatherName,
          postalAddress,
          party,
          constituency,
          state,
          JSON.stringify(formData),
          candidatePhotoUrl,
          candidateSignatureUrl,
          sessionId,
        ],
      );
    } else {
      await query(
        `INSERT INTO nomination_sessions
         (id, candidate_name, father_mother_husband_name, postal_address,
          party, constituency, state, form_data, candidate_photo_url,
          candidate_signature_url, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed')`,
        [
          sessionId,
          candidateName,
          fatherName,
          postalAddress,
          party,
          constituency,
          state,
          JSON.stringify(formData),
          candidatePhotoUrl,
          candidateSignatureUrl,
        ],
      );
    }

    const persisted = await query(
      `SELECT form_data FROM nomination_sessions WHERE id=$1`,
      [sessionId],
    );
    const savedFormData = parseMaybeJson(
      persisted.rows[0]?.form_data,
      persisted.rows[0]?.form_data || {},
    );

    const expectedFlat = flattenScalarFields(formData);
    const savedFlat = flattenScalarFields(savedFormData);
    const expectedKeys = Object.keys(expectedFlat);
    const missingPersistedFields = expectedKeys.filter(
      (key) => !(key in savedFlat),
    );
    const mismatchedPersistedFields = expectedKeys.filter(
      (key) =>
        key in savedFlat &&
        normalizeComparableValue(savedFlat[key]) !==
          normalizeComparableValue(expectedFlat[key]),
    );

    res.status(isUpdate ? 200 : 201).json({
      sessionId,
      candidateName,
      party,
      constituency,
      state,
      status: "completed",
      message: isUpdate
        ? "Nomination updated successfully"
        : "Nomination created successfully",
      exportUrl: `/nominations/sessions/${sessionId}/export/docx`,
      previewUrl: `/nominations/sessions/${sessionId}/preview/docx`,
      validationUrl: `/nominations/sessions/${sessionId}/validation`,
      dbAudit: {
        expectedPersistedFieldCount: expectedKeys.length,
        savedFieldCount: Object.keys(savedFlat).length,
        missingPersistedFieldCount: missingPersistedFields.length,
        missingPersistedFields,
        mismatchedPersistedFieldCount: mismatchedPersistedFields.length,
        mismatchedPersistedFields,
        allPersisted:
          missingPersistedFields.length === 0 &&
          mismatchedPersistedFields.length === 0,
      },
    });
  } catch (err) {
    console.error("Nomination manual entry error:", err);
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
      type === "signature" ? "nomination_signatures" : "nomination_photos";
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
    const result = await query(
      `SELECT id, candidate_name, father_mother_husband_name,
              postal_address, party, constituency, state,
              status, created_at, updated_at
       FROM nomination_sessions
       ORDER BY created_at DESC`,
    );
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
    const result = await query(
      "SELECT * FROM nomination_sessions WHERE id=$1",
      [id],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const session = result.rows[0];
    const formData =
      typeof session.form_data === "string"
        ? JSON.parse(session.form_data)
        : session.form_data || {};

    res.json({ session, formData });
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
      "DELETE FROM nomination_sessions WHERE id=$1 RETURNING id",
      [id],
    );
    if (deleted.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    res.json({ deleted: id, message: "Nomination session deleted" });
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
      "UPDATE nomination_sessions SET candidate_name=$1, updated_at=now() WHERE id=$2 RETURNING id, candidate_name",
      [name.trim(), id],
    );
    if (updated.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    res.json({
      sessionId: id,
      name: updated.rows[0].candidate_name,
      message: "Renamed successfully",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// EXPORT AS DOCX (Template-based)
// ============================================

async function buildNominationForSession(sessionId) {
  const result = await query("SELECT * FROM nomination_sessions WHERE id=$1", [
    sessionId,
  ]);
  if (result.rowCount === 0) {
    return { error: "Session not found", status: 404 };
  }

  const session = result.rows[0];
  const formData = parseMaybeJson(session.form_data, session.form_data || {});
  const merged = buildMergedStructure(formData, session);
  return { session, formData, merged };
}

async function buildNominationDocxBufferFromMerged(merged) {
  if (!nominationTemplateExists()) {
    return {
      error:
        "DOCX template file not found. Ensure 'NOMINATION FORM FOR VIDHAN SABHA WORD.docx' exists in the project root.",
      status: 500,
    };
  }
  const buffer = await fillNominationTemplate(merged);
  return { buffer };
}

function buildNominationFieldValidityReport(merged = {}, session = {}) {
  const fields =
    merged.fields && typeof merged.fields === "object" ? merged.fields : {};
  const checks = [
    {
      label: "Candidate Name",
      aliases: [
        "candidateName",
        "partI_candidateName",
        "partII_candidateName",
        "partVI_candidateName",
      ],
      required: true,
    },
    {
      label: "Father/Mother/Husband Name",
      aliases: [
        "fatherMotherHusbandName",
        "partI_fatherName",
        "partII_fatherName",
      ],
      required: true,
    },
    {
      label: "Postal Address",
      aliases: ["postalAddress", "partI_postalAddress", "partII_postalAddress"],
      required: true,
    },
    {
      label: "Constituency",
      aliases: [
        "constituency",
        "partI_constituency",
        "partII_constituency",
        "partVI_constituency",
      ],
      required: true,
    },
    { label: "State", aliases: ["state"], required: true },
  ];

  const details = [];
  const missingRequired = [];
  for (const check of checks) {
    const picked = pickFirstNonEmpty(fields, check.aliases);
    details.push({
      label: check.label,
      required: check.required,
      valid: check.required ? Boolean(picked.value) : true,
      sourceKey: picked.key,
      valuePreview: picked.value ? picked.value.slice(0, 80) : "",
    });
    if (check.required && !picked.value) {
      missingRequired.push(check.label);
    }
  }

  const sessionFallback = {
    candidateName: toTrimmedText(session.candidate_name),
    fatherName: toTrimmedText(session.father_mother_husband_name),
    postalAddress: toTrimmedText(session.postal_address),
    constituency: toTrimmedText(session.constituency),
    state: toTrimmedText(session.state),
  };
  if (sessionFallback.candidateName)
    removeMissingLabel(missingRequired, "Candidate Name");
  if (sessionFallback.fatherName)
    removeMissingLabel(missingRequired, "Father/Mother/Husband Name");
  if (sessionFallback.postalAddress)
    removeMissingLabel(missingRequired, "Postal Address");
  if (sessionFallback.constituency)
    removeMissingLabel(missingRequired, "Constituency");
  if (sessionFallback.state) removeMissingLabel(missingRequired, "State");

  const proposerCount = Array.isArray(fields.proposers)
    ? fields.proposers.length
    : 0;
  details.push({
    label: "Proposers Rows",
    required: false,
    valid: true,
    sourceKey: "proposers",
    valuePreview: String(proposerCount),
  });

  return {
    valid: missingRequired.length === 0,
    missingRequired,
    totalFieldEntries: Object.keys(flattenScalarFields(fields)).length,
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

function shouldCheckTemplateValue(rawValue) {
  const text = toTrimmedText(rawValue);
  if (!text) return false;
  const normalized = text.toLowerCase();
  if (["yes", "no", "n/a", "na", "none", "nil", "-"].includes(normalized)) {
    return false;
  }
  return normalized.length >= 2;
}

async function buildNominationTemplatePlacementAudit(merged) {
  const docxResult = await buildNominationDocxBufferFromMerged(merged);
  if (docxResult.error) {
    return { status: "error", error: docxResult.error };
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
  const flattened = flattenScalarFields(fields);
  const details = [];
  for (const [fieldName, value] of Object.entries(flattened)) {
    if (!shouldCheckTemplateValue(value)) continue;
    const normalizedValue = toTrimmedText(value).toLowerCase();
    details.push({
      field: fieldName,
      valuePresent: true,
      foundInDocument: plainTextLower.includes(normalizedValue),
      valuePreview: String(value).slice(0, 80),
    });
  }

  const missingPlacementFields = details
    .filter((item) => item.valuePresent && !item.foundInDocument)
    .map((item) => item.field);

  const unresolvedHintFragments = [
    "(State)",
    "(hour)",
    "(date)",
    "(Place)",
    "(name of the language)",
    "(mention full postal address)",
  ].filter((fragment) => plainTextLower.includes(fragment.toLowerCase()));

  const dotPlaceholderCount = plainText.match(/\.\.{2,}|…{2,}/g)?.length || 0;

  return {
    status: "ok",
    valid: missingPlacementFields.length === 0,
    missingPlacementFields,
    unresolvedHintFragments,
    dotPlaceholderCount,
    details,
  };
}

async function sendNominationManualPreviewDocx(req, res) {
  const data = normalizePreviewPayload(req.body || {});
  const formData = buildNominationFormData(data);
  const merged = buildMergedStructure(formData, {
    state: formData.state || "",
    constituency: formData.constituency || "",
    candidate_photo_url: formData.candidatePhotoUrl || "",
    candidate_signature_url: formData.candidateSignatureUrl || "",
  });

  const docxResult = await buildNominationDocxBufferFromMerged(merged);
  if (docxResult.error) {
    return res
      .status(docxResult.status || 500)
      .json({ error: docxResult.error });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    'inline; filename="Nomination_preview.docx"',
  );
  return res.send(docxResult.buffer);
}

async function sendNominationSessionDocx(
  req,
  res,
  sessionId,
  mode = "preview",
) {
  const sessionMerged = await buildNominationForSession(sessionId);
  if (sessionMerged.error) {
    return res
      .status(sessionMerged.status || 500)
      .json({ error: sessionMerged.error });
  }

  const validity = buildNominationFieldValidityReport(
    sessionMerged.merged,
    sessionMerged.session,
  );
  const docxResult = await buildNominationDocxBufferFromMerged(
    sessionMerged.merged,
  );
  if (docxResult.error) {
    return res
      .status(docxResult.status || 500)
      .json({ error: docxResult.error });
  }

  const safeName = sessionMerged.session.candidate_name
    ? `Nomination_${sessionMerged.session.candidate_name.replace(/[^a-zA-Z0-9]/g, "_")}`
    : `Nomination_${String(sessionId).slice(0, 8)}`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "X-Nomination-Validation",
    validity.valid ? "valid" : "invalid",
  );
  if (!validity.valid) {
    res.setHeader(
      "X-Nomination-Missing-Required",
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

router.post("/manual-entry/preview/docx", async (req, res) => {
  try {
    return await sendNominationManualPreviewDocx(req, res);
  } catch (err) {
    console.error("Nomination manual DOCX preview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/manual-entry/preview/docx", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (sessionId) {
      return await sendNominationSessionDocx(req, res, sessionId, "preview");
    }
    return res.status(400).json({
      error:
        "sessionId query param is required for GET preview. Use POST for live manual form preview payload.",
    });
  } catch (err) {
    console.error("Nomination GET DOCX preview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/preview/docx", async (req, res) => {
  try {
    return await sendNominationManualPreviewDocx(req, res);
  } catch (err) {
    console.error("Nomination generic DOCX preview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/preview/docx", async (req, res) => {
  try {
    return await sendNominationSessionDocx(req, res, req.params.id, "preview");
  } catch (err) {
    console.error("Nomination session DOCX preview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/export/docx", async (req, res) => {
  try {
    return await sendNominationSessionDocx(req, res, req.params.id, "export");
  } catch (err) {
    console.error("Nomination DOCX export error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/validation", async (req, res) => {
  try {
    const { id } = req.params;
    const includeTemplateAudit =
      String(req.query.includeTemplateAudit || "").toLowerCase() === "1" ||
      String(req.query.includeTemplateAudit || "").toLowerCase() === "true";

    const sessionMerged = await buildNominationForSession(id);
    if (sessionMerged.error) {
      return res
        .status(sessionMerged.status || 500)
        .json({ error: sessionMerged.error });
    }

    const validity = buildNominationFieldValidityReport(
      sessionMerged.merged,
      sessionMerged.session,
    );

    let templateAudit = null;
    if (includeTemplateAudit) {
      templateAudit = await buildNominationTemplatePlacementAudit(
        sessionMerged.merged,
      );
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
    console.error("Nomination validation error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// SEARCH NOMINATIONS
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
      SELECT id, candidate_name, father_mother_husband_name,
             party, constituency, state, status, created_at
      FROM nomination_sessions
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
// GET FORM SCHEMA (for frontend rendering)
// ============================================

router.get("/form-schema", async (_req, res) => {
  res.json({ schema: getNominationFormSchema() });
});

// ============================================
// HELPERS
// ============================================

function isJsonString(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
}

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!isJsonString(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function setNestedValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
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

function toArrayLike(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value, fallback);
    if (Array.isArray(parsed)) return parsed;
  }
  return fallback;
}

function pickFirstNonEmpty(data, aliases) {
  for (const key of aliases) {
    const text = toTrimmedText(data[key]);
    if (text) return { key, value: text };
  }
  return { key: null, value: "" };
}

function removeMissingLabel(list, label) {
  const index = list.indexOf(label);
  if (index >= 0) list.splice(index, 1);
}

function flattenScalarFields(input, prefix = "", out = {}) {
  if (input === null || input === undefined) return out;

  if (Array.isArray(input)) {
    input.forEach((item, idx) => {
      const nextPrefix = prefix ? `${prefix}[${idx}]` : `[${idx}]`;
      flattenScalarFields(item, nextPrefix, out);
    });
    return out;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenScalarFields(value, nextPrefix, out);
    }
    return out;
  }

  if (!prefix) return out;
  const text = String(input);
  if (!text.trim()) return out;
  out[prefix] = text;
  return out;
}

function normalizeComparableValue(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNominationFormData(data) {
  const input = data && typeof data === "object" ? data : {};
  const get = (...keys) => firstValue(input, keys, "");

  const formData = {
    // Session-summary level fields
    state: get("state"),
    candidateName: get(
      "candidateName",
      "partI_candidateName",
      "partII_candidateName",
      "partVI_candidateName",
    ),
    fatherMotherHusbandName: get(
      "fatherMotherHusbandName",
      "partI_fatherName",
      "partII_fatherName",
    ),
    postalAddress: get(
      "postalAddress",
      "partI_postalAddress",
      "partII_postalAddress",
    ),
    party: get("party"),
    constituency: get(
      "constituency",
      "partI_constituency",
      "partII_constituency",
      "partVI_constituency",
    ),

    // Photo & signature
    candidatePhotoUrl: get(
      "candidatePhotoUrl",
      "candidate_photo_url",
      "photoUrl",
    ),
    candidateSignatureUrl: get(
      "candidateSignatureUrl",
      "candidate_signature_url",
      "signatureUrl",
    ),

    // Part I
    partI_constituency: get("partI_constituency", "constituency"),
    partI_candidateName: get("partI_candidateName", "candidateName"),
    partI_fatherName: get("partI_fatherName", "fatherMotherHusbandName"),
    partI_postalAddress: get("partI_postalAddress", "postalAddress"),
    partI_candidateSlNo: get("partI_candidateSlNo"),
    partI_candidatePartNo: get("partI_candidatePartNo"),
    partI_candidateConstituency: get("partI_candidateConstituency"),
    partI_proposerName: get("partI_proposerName"),
    partI_proposerSlNo: get("partI_proposerSlNo"),
    partI_proposerPartNo: get("partI_proposerPartNo"),
    partI_proposerConstituency: get("partI_proposerConstituency"),
    partI_date: get("partI_date"),

    // Part II
    partII_constituency: get("partII_constituency", "constituency"),
    partII_candidateName: get("partII_candidateName", "candidateName"),
    partII_fatherName: get("partII_fatherName", "fatherMotherHusbandName"),
    partII_postalAddress: get("partII_postalAddress", "postalAddress"),
    partII_candidateSlNo: get("partII_candidateSlNo"),
    partII_candidatePartNo: get("partII_candidatePartNo"),
    partII_candidateConstituency: get("partII_candidateConstituency"),
    proposers: toArrayLike(input.proposers, []),

    // Part III
    age: get("age"),
    recognisedParty: get("recognisedParty"),
    unrecognisedParty: get("unrecognisedParty"),
    symbol1: get("symbol1"),
    symbol2: get("symbol2"),
    symbol3: get("symbol3"),
    language: get("language"),
    casteTribe: get("casteTribe"),
    scStState: get("scStState"),
    scStArea: get("scStArea"),
    assemblyState: get("assemblyState"),
    partIII_date: get("partIII_date"),

    // Part IIIA
    convicted: get("convicted") || "No",
    criminal_firNos: get("criminal_firNos"),
    criminal_policeStation: get("criminal_policeStation"),
    criminal_district: get("criminal_district"),
    criminal_state: get("criminal_state"),
    criminal_sections: get("criminal_sections"),
    criminal_convictionDates: get("criminal_convictionDates"),
    criminal_courts: get("criminal_courts"),
    criminal_punishment: get("criminal_punishment"),
    criminal_releaseDates: get("criminal_releaseDates"),
    criminal_appealFiled: get("criminal_appealFiled"),
    criminal_appealParticulars: get("criminal_appealParticulars"),
    criminal_appealCourts: get("criminal_appealCourts"),
    criminal_appealStatus: get("criminal_appealStatus"),
    criminal_disposalDates: get("criminal_disposalDates"),
    criminal_orderNature: get("criminal_orderNature"),
    officeOfProfit: get("officeOfProfit") || "No",
    officeOfProfit_details: get("officeOfProfit_details"),
    insolvency: get("insolvency") || "No",
    insolvency_discharged: get("insolvency_discharged"),
    foreignAllegiance: get("foreignAllegiance") || "No",
    foreignAllegiance_details: get("foreignAllegiance_details"),
    disqualification_8A: get("disqualification_8A") || "No",
    disqualification_period: get("disqualification_period"),
    dismissalForCorruption: get("dismissalForCorruption") || "No",
    dismissal_date: get("dismissal_date"),
    govContracts: get("govContracts") || "No",
    govContracts_details: get("govContracts_details"),
    managingAgent: get("managingAgent") || "No",
    managingAgent_details: get("managingAgent_details"),
    disqualification_10A: get("disqualification_10A") || "No",
    section10A_date: get("section10A_date"),
    partIIIA_place: get("partIIIA_place"),
    partIIIA_date: get("partIIIA_date"),

    // Part IV
    partIV_serialNo: get("partIV_serialNo"),
    partIV_hour: get("partIV_hour"),
    partIV_date: get("partIV_date"),
    partIV_deliveredBy: get("partIV_deliveredBy"),
    partIV_roDate: get("partIV_roDate"),

    // Part V
    partV_decision: get("partV_decision"),
    partV_date: get("partV_date"),

    // Part VI
    partVI_serialNo: get("partVI_serialNo"),
    partVI_candidateName: get("partVI_candidateName", "candidateName"),
    partVI_constituency: get("partVI_constituency", "constituency"),
    partVI_hour: get("partVI_hour"),
    partVI_date: get("partVI_date"),
    partVI_scrutinyHour: get("partVI_scrutinyHour"),
    partVI_scrutinyDate: get("partVI_scrutinyDate"),
    partVI_scrutinyPlace: get("partVI_scrutinyPlace"),
    partVI_roDate: get("partVI_roDate"),
  };

  const knownKeys = new Set([
    ...Object.keys(formData),
    "candidate_photo_url",
    "candidate_signature_url",
    "photoUrl",
    "signatureUrl",
    "formData",
    "data",
    "sessionId",
  ]);

  for (const [key, value] of Object.entries(input)) {
    if (knownKeys.has(key)) continue;
    if (value === undefined) continue;
    formData[key] = value;
  }

  return formData;
}

function buildMergedStructure(formData, session = {}) {
  const safeSession = session && typeof session === "object" ? session : {};
  const normalizedState =
    toTrimmedText(safeSession.state) || toTrimmedText(formData.state) || "";
  const normalizedConstituency =
    toTrimmedText(safeSession.constituency) ||
    toTrimmedText(formData.constituency) ||
    toTrimmedText(formData.partI_constituency) ||
    toTrimmedText(formData.partII_constituency) ||
    toTrimmedText(formData.partVI_constituency) ||
    "";

  return {
    formType: "Form 2B",
    documentTitle: "NOMINATION PAPER",
    fields: {
      ...formData,
      state: normalizedState,
      constituency: normalizedConstituency,
      candidatePhotoUrl:
        safeSession.candidate_photo_url || formData.candidatePhotoUrl || "",
      candidateSignatureUrl:
        safeSession.candidate_signature_url ||
        formData.candidateSignatureUrl ||
        "",
    },
    proposers: toArrayLike(formData.proposers, []),
    state: normalizedState,
    constituency: normalizedConstituency,
  };
}

function getNominationFormSchema() {
  return {
    title: "Form 2B — Nomination Paper",
    description: "Nomination Paper for Election to the Legislative Assembly",
    sections: [
      {
        id: "header",
        title: "Election Details",
        fields: [
          {
            name: "state",
            label: "State",
            type: "text",
            placeholder: "e.g. WEST BENGAL",
          },
          {
            name: "candidatePhotoUrl",
            label: "Candidate Passport Size Photograph",
            type: "image_upload",
            description:
              "Upload passport size photograph. Use POST /nominations/upload-image with type=photo",
          },
          {
            name: "candidateSignatureUrl",
            label: "Candidate Signature",
            type: "image_upload",
            description:
              "Upload candidate signature image. Use POST /nominations/upload-image with type=signature",
          },
        ],
      },
      {
        id: "partI",
        title: "Part I — Nomination by Recognised Party",
        description:
          "To be used by candidate set up by recognised political party",
        fields: [
          {
            name: "partI_constituency",
            label: "Assembly Constituency",
            type: "text",
          },
          {
            name: "partI_candidateName",
            label: "Candidate's Name",
            type: "text",
          },
          {
            name: "partI_fatherName",
            label: "Father's/Mother's/Husband's Name",
            type: "text",
          },
          {
            name: "partI_postalAddress",
            label: "Postal Address",
            type: "textarea",
          },
          {
            name: "partI_candidateSlNo",
            label: "Candidate's Sl. No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partI_candidatePartNo",
            label: "Candidate's Part No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partI_candidateConstituency",
            label: "Candidate's Electoral Roll Constituency",
            type: "text",
          },
          {
            name: "partI_proposerName",
            label: "Proposer's Name",
            type: "text",
          },
          {
            name: "partI_proposerSlNo",
            label: "Proposer's Sl. No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partI_proposerPartNo",
            label: "Proposer's Part No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partI_proposerConstituency",
            label: "Proposer's Electoral Roll Constituency",
            type: "text",
          },
          {
            name: "partI_date",
            label: "Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "partII",
        title: "Part II — Nomination with 10 Proposers",
        description:
          "For candidates not set up by a recognised political party",
        fields: [
          {
            name: "partII_constituency",
            label: "Assembly Constituency",
            type: "text",
          },
          {
            name: "partII_candidateName",
            label: "Candidate's Name",
            type: "text",
          },
          {
            name: "partII_fatherName",
            label: "Father's/Mother's/Husband's Name",
            type: "text",
          },
          {
            name: "partII_postalAddress",
            label: "Postal Address",
            type: "textarea",
          },
          {
            name: "partII_candidateSlNo",
            label: "Candidate's Sl. No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partII_candidatePartNo",
            label: "Candidate's Part No. in Electoral Roll",
            type: "text",
          },
          {
            name: "partII_candidateConstituency",
            label: "Candidate's Electoral Roll Constituency",
            type: "text",
          },
        ],
        table: {
          name: "proposers",
          label: "Particulars of the Proposers and their Signatures",
          description:
            "There should be ten electors of the constituency as proposers",
          columns: [
            { name: "partNo", label: "Part No. of Electoral Roll" },
            { name: "slNo", label: "S.No. in that Part" },
            { name: "fullName", label: "Full Name" },
            { name: "signature", label: "Signature" },
            { name: "date", label: "Date" },
          ],
          maxRows: 10,
        },
      },
      {
        id: "partIII",
        title: "Part III — Candidate Declaration",
        fields: [
          { name: "age", label: "Age (completed years)", type: "text" },
          {
            name: "recognisedParty",
            label: "Recognised National/State Party Name (c)(i)",
            type: "text",
            placeholder: "Leave blank if not applicable",
          },
          {
            name: "unrecognisedParty",
            label: "Unrecognised Party Name (c)(ii)",
            type: "text",
            placeholder: "Leave blank if independent / recognised party",
          },
          { name: "symbol1", label: "Symbol Preference (i)", type: "text" },
          { name: "symbol2", label: "Symbol Preference (ii)", type: "text" },
          { name: "symbol3", label: "Symbol Preference (iii)", type: "text" },
          {
            name: "language",
            label: "Name spelt in (Language)",
            type: "text",
            placeholder: "e.g. Hindi, Bengali, English",
          },
          {
            name: "casteTribe",
            label: "Caste/Tribe (if SC/ST)",
            type: "text",
            placeholder: "Leave blank if not applicable",
          },
          {
            name: "scStState",
            label: "SC/ST of State",
            type: "text",
            placeholder: "Leave blank if not applicable",
          },
          {
            name: "scStArea",
            label: "SC/ST in relation to (Area)",
            type: "text",
            placeholder: "Leave blank if not applicable",
          },
          {
            name: "assemblyState",
            label: "Not nominated from more than 2 constituencies in (State)",
            type: "text",
          },
          {
            name: "partIII_date",
            label: "Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "partIIIA",
        title: "Part IIIA — Criminal Record & Declarations",
        description: "To be filled by the candidate",
        fields: [
          {
            name: "convicted",
            label: "Has been convicted?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "criminal_firNos",
            label: "Case/FIR No./Nos.",
            type: "textarea",
          },
          {
            name: "criminal_policeStation",
            label: "Police Station(s)",
            type: "text",
          },
          { name: "criminal_district", label: "District(s)", type: "text" },
          { name: "criminal_state", label: "State(s)", type: "text" },
          {
            name: "criminal_sections",
            label: "Section(s) of Act(s) and brief description",
            type: "textarea",
          },
          {
            name: "criminal_convictionDates",
            label: "Date(s) of conviction(s)",
            type: "text",
          },
          {
            name: "criminal_courts",
            label: "Court(s) which convicted",
            type: "text",
          },
          {
            name: "criminal_punishment",
            label: "Punishment(s) imposed",
            type: "textarea",
          },
          {
            name: "criminal_releaseDates",
            label: "Date(s) of release from prison",
            type: "text",
          },
          {
            name: "criminal_appealFiled",
            label: "Appeal(s)/Revision(s) filed?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "criminal_appealParticulars",
            label: "Date and particulars of appeal(s)",
            type: "textarea",
          },
          {
            name: "criminal_appealCourts",
            label: "Court(s) for appeal(s)",
            type: "text",
          },
          {
            name: "criminal_appealStatus",
            label: "Appeal status (disposed/pending)",
            type: "text",
          },
          {
            name: "criminal_disposalDates",
            label: "Date(s) of disposal",
            type: "text",
          },
          {
            name: "criminal_orderNature",
            label: "Nature of order(s) passed",
            type: "textarea",
          },
          {
            name: "officeOfProfit",
            label: "Holding office of profit?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "officeOfProfit_details",
            label: "Details of office held",
            type: "textarea",
          },
          {
            name: "insolvency",
            label: "Declared insolvent?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "insolvency_discharged",
            label: "Discharged from insolvency?",
            type: "text",
          },
          {
            name: "foreignAllegiance",
            label: "Under allegiance to foreign country?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "foreignAllegiance_details",
            label: "Foreign allegiance details",
            type: "textarea",
          },
          {
            name: "disqualification_8A",
            label: "Disqualified under section 8A?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "disqualification_period",
            label: "Period of disqualification",
            type: "text",
          },
          {
            name: "dismissalForCorruption",
            label: "Dismissed for corruption/disloyalty?",
            type: "select",
            options: ["No", "Yes"],
          },
          { name: "dismissal_date", label: "Date of dismissal", type: "text" },
          {
            name: "govContracts",
            label: "Subsisting government contracts?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "govContracts_details",
            label: "Government contract details",
            type: "textarea",
          },
          {
            name: "managingAgent",
            label: "Managing agent/manager/secretary of company?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "managingAgent_details",
            label: "Company/Corporation details",
            type: "textarea",
          },
          {
            name: "disqualification_10A",
            label: "Disqualified under section 10A?",
            type: "select",
            options: ["No", "Yes"],
          },
          {
            name: "section10A_date",
            label: "Date of disqualification (10A)",
            type: "text",
          },
          {
            name: "partIIIA_place",
            label: "Place (Part IIIA)",
            type: "text",
            placeholder: "Place where declaration is made",
          },
          {
            name: "partIIIA_date",
            label: "Date (Part IIIA)",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "partIV",
        title: "Part IV — Returning Officer",
        description: "To be filled by the Returning Officer",
        fields: [
          {
            name: "partIV_serialNo",
            label: "Serial No. of Nomination Paper",
            type: "text",
          },
          { name: "partIV_hour", label: "Hour of delivery", type: "text" },
          {
            name: "partIV_date",
            label: "Date of delivery",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
          {
            name: "partIV_deliveredBy",
            label: "Delivered by (candidate/proposer name)",
            type: "text",
          },
          {
            name: "partIV_roDate",
            label: "Returning Officer Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "partV",
        title: "Part V — Decision of Returning Officer",
        fields: [
          {
            name: "partV_decision",
            label: "Decision (Accept/Reject with reasons)",
            type: "textarea",
          },
          {
            name: "partV_date",
            label: "Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
      {
        id: "partVI",
        title: "Part VI — Receipt for Nomination Paper",
        description:
          "Receipt to be handed over to the person presenting the nomination paper",
        fields: [
          {
            name: "partVI_serialNo",
            label: "Serial No. of Nomination Paper",
            type: "text",
          },
          {
            name: "partVI_candidateName",
            label: "Candidate Name",
            type: "text",
          },
          {
            name: "partVI_constituency",
            label: "Assembly Constituency",
            type: "text",
          },
          { name: "partVI_hour", label: "Hour of delivery", type: "text" },
          {
            name: "partVI_date",
            label: "Date of delivery",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
          { name: "partVI_scrutinyHour", label: "Scrutiny Hour", type: "text" },
          {
            name: "partVI_scrutinyDate",
            label: "Scrutiny Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
          {
            name: "partVI_scrutinyPlace",
            label: "Scrutiny Place",
            type: "text",
          },
          {
            name: "partVI_roDate",
            label: "Returning Officer Date",
            type: "text",
            placeholder: "DD/MM/YYYY",
          },
        ],
      },
    ],
  };
}

export default router;
