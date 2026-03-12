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

// All affidavit routes require authentication + admin
router.use(authenticate);
router.use(adminOnly);

// ============================================
// MANUAL ENTRY — Create / Update Affidavit
// ============================================

router.post("/manual-entry", async (req, res) => {
  try {
    const data = req.body || {};
    const sessionId = data.sessionId || uuidv4();
    const isUpdate = !!data.sessionId;

    const candidateName = data.candidateName || "";
    const party = data.party || "";
    const constituency = data.constituency || data.assemblyConstituency || "";
    const state = data.state || "";

    const formData = buildAffidavitFormData(data);

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
        [candidateName, party, constituency, state, formData.candidatePhotoUrl || null, formData.candidateSignatureUrl || null, sessionId],
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
        [sessionId, "Manual Entry", candidateName, party, constituency, state, formData.candidatePhotoUrl || null, formData.candidateSignatureUrl || null],
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

// ============================================
// EXPORT AS DOCX (Template-based)
// ============================================

router.get("/sessions/:id/export/docx", async (req, res) => {
  try {
    const { id } = req.params;

    const session = await query(
      "SELECT * FROM affidavit_sessions WHERE id=$1",
      [id],
    );
    if (session.rowCount === 0)
      return res.status(404).json({ error: "Session not found" });

    const pages = await query(
      `SELECT page_number, raw_text, structured_json
       FROM affidavit_pages WHERE session_id=$1
       ORDER BY page_number`,
      [id],
    );

    const entries = await query(
      `SELECT field_name, field_value, field_category
       FROM affidavit_entries WHERE session_id=$1
       ORDER BY field_category, field_name`,
      [id],
    );

    const tables = await query(
      `SELECT table_title, headers, rows_data, page_number
       FROM affidavit_tables WHERE session_id=$1
       ORDER BY page_number`,
      [id],
    );

    let merged = {};

    if (pages.rows.length > 0) {
      const json =
        typeof pages.rows[0].structured_json === "string"
          ? JSON.parse(pages.rows[0].structured_json)
          : pages.rows[0].structured_json || {};
      merged = json;
    }

    if (
      Object.keys(merged.fields || {}).length === 0 &&
      entries.rows.length > 0
    ) {
      merged.fields = {};
      for (const entry of entries.rows) {
        merged.fields[entry.field_name] = entry.field_value;
      }
    }

    if (
      (!merged.tables || merged.tables.length === 0) &&
      tables.rows.length > 0
    ) {
      merged.tables = tables.rows.map((t) => ({
        tableTitle: t.table_title,
        headers:
          typeof t.headers === "string" ? JSON.parse(t.headers) : t.headers,
        rows:
          typeof t.rows_data === "string"
            ? JSON.parse(t.rows_data)
            : t.rows_data,
      }));
    }

    // Inject photo/signature URLs from session DB columns into merged fields
    if (!merged.fields) merged.fields = {};
    const sessRow = session.rows[0];
    if (sessRow.candidate_photo_url && !merged.fields.candidatePhotoUrl) {
      merged.fields.candidatePhotoUrl = sessRow.candidate_photo_url;
    }
    if (sessRow.candidate_signature_url && !merged.fields.candidateSignatureUrl) {
      merged.fields.candidateSignatureUrl = sessRow.candidate_signature_url;
    }

    if (!templateExists()) {
      return res.status(500).json({
        error:
          "DOCX template file not found. Ensure 'AFFIDAVIT FORMAT WORD.docx' exists in the project root.",
      });
    }

    const buffer = await fillAffidavitTemplate(merged);

    const filename = session.rows[0].candidate_name
      ? `Affidavit_${session.rows[0].candidate_name.replace(/[^a-zA-Z0-9]/g, "_")}.docx`
      : `Affidavit_${id.slice(0, 8)}.docx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("DOCX export error:", err);
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

function buildAffidavitFormData(data) {
  return {
    houseName: data.houseName || "",
    constituency: data.constituency || data.assemblyConstituency || "",
    candidateName: data.candidateName || "",
    fatherMotherHusbandName: data.fatherMotherHusbandName || "",
    age: data.age || "",
    postalAddress: data.postalAddress || "",
    party: data.party || "",
    isIndependent: data.isIndependent || false,
    enrolledConstituency: data.enrolledConstituency || "",
    serialNumber: data.serialNumber || "",
    partNumber: data.partNumber || "",
    telephone: data.telephone || "",
    email: data.email || "",
    socialMedia1: data.socialMedia1 || "",
    socialMedia2: data.socialMedia2 || "",
    socialMedia3: data.socialMedia3 || "",

    // Photo & Signature URLs
    candidatePhotoUrl: data.candidatePhotoUrl || "",
    candidateSignatureUrl: data.candidateSignatureUrl || "",

    panEntries: data.panEntries || [],
    hasPendingCases: data.hasPendingCases || "No",
    pendingCases: data.pendingCases || [],
    hasConvictions: data.hasConvictions || "No",
    convictions: data.convictions || [],
    informedParty: data.informedParty || "",
    movableAssets: data.movableAssets || {},
    immovableAssets: data.immovableAssets || {},
    liabilities: data.liabilities || {},
    disputedLiabilities: data.disputedLiabilities || "",
    governmentDues: data.governmentDues || {},
    governmentAccommodation: {
      occupied: data.governmentAccommodation?.occupied || "No",
      address: data.governmentAccommodation?.address || "",
      noDues: data.governmentAccommodation?.noDues || "Yes",
      duesDate: data.governmentAccommodation?.duesDate || "",
      rentDues: data.governmentAccommodation?.rentDues || "",
      electricityDues: data.governmentAccommodation?.electricityDues || "",
      waterDues: data.governmentAccommodation?.waterDues || "",
      telephoneDues: data.governmentAccommodation?.telephoneDues || "",
    },
    selfProfession: data.selfProfession || "",
    spouseProfession: data.spouseProfession || "",
    selfIncome: data.selfIncome || "",
    spouseIncome: data.spouseIncome || "",
    dependentIncome: data.dependentIncome || "",
    contractsCandidate: data.contractsCandidate || "",
    contractsSpouse: data.contractsSpouse || "",
    contractsDependents: data.contractsDependents || "",
    contractsHUF: data.contractsHUF || "",
    contractsPartnershipFirms: data.contractsPartnershipFirms || "",
    contractsPrivateCompanies: data.contractsPrivateCompanies || "",
    educationalQualification: data.educationalQualification || "",
    partBOverrides: data.partBOverrides || {},
    verificationPlace: data.verificationPlace || "",
    verificationDate: data.verificationDate || data.date || "",
    state: data.state || "",
    date: data.date || "",

    // Oath Commissioner
    oathCommissionerName: data.oathCommissionerName || "",
    oathCommissionerDesignation: data.oathCommissionerDesignation || "",
    oathCommissionerSealNo: data.oathCommissionerSealNo || "",
  };
}


function buildMergedStructure(formData) {
  const merged = {
    formType: "Form 26",
    documentTitle: "AFFIDAVIT",
    state: formData.state,
    constituency: formData.constituency,
    fields: {
      houseName: formData.houseName,
      candidateName: formData.candidateName,
      fatherMotherHusbandName: formData.fatherMotherHusbandName,
      age: formData.age,
      postalAddress: formData.postalAddress,
      assemblyConstituency: formData.constituency,
      enrolledConstituency:
        formData.enrolledConstituency || formData.constituency,
      serialNumber: formData.serialNumber,
      partNumber: formData.partNumber,
      party: formData.party,
      telephone: formData.telephone,
      email: formData.email,
      socialMedia1: formData.socialMedia1,
      socialMedia2: formData.socialMedia2,
      socialMedia3: formData.socialMedia3,
      selfProfession: formData.selfProfession,
      spouseProfession: formData.spouseProfession,
      selfIncome: formData.selfIncome,
      spouseIncome: formData.spouseIncome,
      dependentIncome: formData.dependentIncome,
      contractsCandidate: formData.contractsCandidate,
      contractsSpouse: formData.contractsSpouse,
      contractsDependents: formData.contractsDependents,
      contractsHUF: formData.contractsHUF,
      contractsPartnershipFirms: formData.contractsPartnershipFirms,
      contractsPrivateCompanies: formData.contractsPrivateCompanies,
      educationalQualification: formData.educationalQualification,
      verificationPlace: formData.verificationPlace,
      date: formData.verificationDate || formData.date,
      candidatePhotoUrl: formData.candidatePhotoUrl,
      candidateSignatureUrl: formData.candidateSignatureUrl,
      oathCommissionerName: formData.oathCommissionerName,
      oathCommissionerDesignation: formData.oathCommissionerDesignation,
      oathCommissionerSealNo: formData.oathCommissionerSealNo,
      disputedLiabilities: formData.disputedLiabilities,
    },
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
  const simpleKeys = [
    "houseName",
    "constituency",
    "candidateName",
    "fatherMotherHusbandName",
    "age",
    "postalAddress",
    "party",
    "enrolledConstituency",
    "serialNumber",
    "partNumber",
    "telephone",
    "email",
    "socialMedia1",
    "socialMedia2",
    "socialMedia3",
    "selfProfession",
    "spouseProfession",
    "selfIncome",
    "spouseIncome",
    "dependentIncome",
    "contractsCandidate",
    "contractsSpouse",
    "contractsDependents",
    "contractsHUF",
    "contractsPartnershipFirms",
    "contractsPrivateCompanies",
    "educationalQualification",
    "verificationPlace",
    "verificationDate",
    "state",
    "date",
    "hasPendingCases",
    "hasConvictions",
    "informedParty",
  ];
  for (const key of simpleKeys) {
    if (formData[key] !== undefined && formData[key] !== "") {
      flat[key] = String(formData[key]);
    }
  }
  if (formData.movableAssets) {
    for (const [k, v] of Object.entries(formData.movableAssets)) {
      if (v) flat[`asset_movable_${k}`] = String(v);
    }
  }
  if (
    formData.immovableAssets &&
    Object.keys(formData.immovableAssets).length > 0
  ) {
    flat["asset_immovable_data"] = JSON.stringify(formData.immovableAssets);
  }
  if (formData.liabilities) {
    for (const [k, v] of Object.entries(formData.liabilities)) {
      if (v) flat[`liability_${k}`] = String(v);
    }
  }
  if (formData.governmentDues) {
    for (const [k, v] of Object.entries(formData.governmentDues)) {
      if (v) flat[`govDues_${k}`] = String(v);
    }
  }
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
