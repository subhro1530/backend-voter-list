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
    const data = req.body || {};
    const sessionId = data.sessionId || uuidv4();
    const isUpdate = !!data.sessionId;

    const candidateName = data.candidateName || "";
    const fatherName = data.fatherMotherHusbandName || "";
    const postalAddress = data.postalAddress || "";
    const party = data.party || "";
    const constituency = data.constituency || "";
    const state = data.state || "";

    const formData = buildNominationFormData(data);
    const candidatePhotoUrl = data.candidatePhotoUrl || "";
    const candidateSignatureUrl = data.candidateSignatureUrl || "";

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

router.get("/sessions/:id/export/docx", async (req, res) => {
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

    if (!nominationTemplateExists()) {
      return res.status(500).json({
        error:
          "DOCX template file not found. Ensure 'NOMINATION FORM FOR VIDHAN SABHA WORD.docx' exists in the project root.",
      });
    }

    const merged = buildMergedStructure(formData, session);
    const buffer = await fillNominationTemplate(merged);

    const filename = session.candidate_name
      ? `Nomination_${session.candidate_name.replace(/[^a-zA-Z0-9]/g, "_")}.docx`
      : `Nomination_${id.slice(0, 8)}.docx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Nomination DOCX export error:", err);
    res.status(500).json({ error: err.message });
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

function buildNominationFormData(data) {
  return {
    // Header
    state: data.state || "",

    // Photo & Signature URLs
    candidatePhotoUrl: data.candidatePhotoUrl || "",
    candidateSignatureUrl: data.candidateSignatureUrl || "",

    // Part I — Recognised party nomination
    partI_constituency: data.partI_constituency || "",
    partI_candidateName: data.partI_candidateName || data.candidateName || "",
    partI_fatherName:
      data.partI_fatherName || data.fatherMotherHusbandName || "",
    partI_postalAddress: data.partI_postalAddress || data.postalAddress || "",
    partI_candidateSlNo: data.partI_candidateSlNo || "",
    partI_candidatePartNo: data.partI_candidatePartNo || "",
    partI_candidateConstituency: data.partI_candidateConstituency || "",
    partI_proposerName: data.partI_proposerName || "",
    partI_proposerSlNo: data.partI_proposerSlNo || "",
    partI_proposerPartNo: data.partI_proposerPartNo || "",
    partI_proposerConstituency: data.partI_proposerConstituency || "",
    partI_date: data.partI_date || "",

    // Part II — 10 proposers nomination
    partII_constituency: data.partII_constituency || "",
    partII_candidateName: data.partII_candidateName || data.candidateName || "",
    partII_fatherName:
      data.partII_fatherName || data.fatherMotherHusbandName || "",
    partII_postalAddress: data.partII_postalAddress || data.postalAddress || "",
    partII_candidateSlNo: data.partII_candidateSlNo || "",
    partII_candidatePartNo: data.partII_candidatePartNo || "",
    partII_candidateConstituency: data.partII_candidateConstituency || "",
    proposers: data.proposers || [],

    // Part III — Candidate declaration
    age: data.age || "",
    recognisedParty: data.recognisedParty || "",
    unrecognisedParty: data.unrecognisedParty || "",
    symbol1: data.symbol1 || "",
    symbol2: data.symbol2 || "",
    symbol3: data.symbol3 || "",
    language: data.language || "",
    casteTribe: data.casteTribe || "",
    scStState: data.scStState || "",
    scStArea: data.scStArea || "",
    assemblyState: data.assemblyState || "",
    partIII_date: data.partIII_date || "",

    // Part IIIA — Criminal record
    convicted: data.convicted || "No",
    criminal_firNos: data.criminal_firNos || "",
    criminal_policeStation: data.criminal_policeStation || "",
    criminal_district: data.criminal_district || "",
    criminal_state: data.criminal_state || "",
    criminal_sections: data.criminal_sections || "",
    criminal_convictionDates: data.criminal_convictionDates || "",
    criminal_courts: data.criminal_courts || "",
    criminal_punishment: data.criminal_punishment || "",
    criminal_releaseDates: data.criminal_releaseDates || "",
    criminal_appealFiled: data.criminal_appealFiled || "",
    criminal_appealParticulars: data.criminal_appealParticulars || "",
    criminal_appealCourts: data.criminal_appealCourts || "",
    criminal_appealStatus: data.criminal_appealStatus || "",
    criminal_disposalDates: data.criminal_disposalDates || "",
    criminal_orderNature: data.criminal_orderNature || "",

    officeOfProfit: data.officeOfProfit || "No",
    officeOfProfit_details: data.officeOfProfit_details || "",
    insolvency: data.insolvency || "No",
    insolvency_discharged: data.insolvency_discharged || "",
    foreignAllegiance: data.foreignAllegiance || "No",
    foreignAllegiance_details: data.foreignAllegiance_details || "",
    disqualification_8A: data.disqualification_8A || "No",
    disqualification_period: data.disqualification_period || "",
    dismissalForCorruption: data.dismissalForCorruption || "No",
    dismissal_date: data.dismissal_date || "",
    govContracts: data.govContracts || "No",
    govContracts_details: data.govContracts_details || "",
    managingAgent: data.managingAgent || "No",
    managingAgent_details: data.managingAgent_details || "",
    disqualification_10A: data.disqualification_10A || "No",
    section10A_date: data.section10A_date || "",
    partIIIA_place: data.partIIIA_place || "",
    partIIIA_date: data.partIIIA_date || "",

    // Part IV — Returning Officer
    partIV_serialNo: data.partIV_serialNo || "",
    partIV_hour: data.partIV_hour || "",
    partIV_date: data.partIV_date || "",
    partIV_deliveredBy: data.partIV_deliveredBy || "",
    partIV_roDate: data.partIV_roDate || "",

    // Part V — Decision
    partV_decision: data.partV_decision || "",
    partV_date: data.partV_date || "",

    // Part VI — Receipt
    partVI_serialNo: data.partVI_serialNo || "",
    partVI_candidateName: data.partVI_candidateName || data.candidateName || "",
    partVI_constituency: data.partVI_constituency || "",
    partVI_hour: data.partVI_hour || "",
    partVI_date: data.partVI_date || "",
    partVI_scrutinyHour: data.partVI_scrutinyHour || "",
    partVI_scrutinyDate: data.partVI_scrutinyDate || "",
    partVI_scrutinyPlace: data.partVI_scrutinyPlace || "",
    partVI_roDate: data.partVI_roDate || "",
  };
}

function buildMergedStructure(formData, session) {
  return {
    formType: "Form 2B",
    documentTitle: "NOMINATION PAPER",
    fields: {
      ...formData,
      candidatePhotoUrl:
        session.candidate_photo_url || formData.candidatePhotoUrl || "",
      candidateSignatureUrl:
        session.candidate_signature_url || formData.candidateSignatureUrl || "",
    },
    proposers: formData.proposers || [],
    state: session.state || formData.state || "",
    constituency:
      session.constituency ||
      formData.partI_constituency ||
      formData.partII_constituency ||
      "",
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
