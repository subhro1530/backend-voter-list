import express from "express";
import { query } from "../db.js";
import { authenticate } from "../auth.js";

const router = express.Router();

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
router.get("/assemblies", async (_req, res) => {
  try {
    const sql = `
      SELECT DISTINCT assembly, COUNT(*)::int as voter_count
      FROM session_voters
      WHERE assembly IS NOT NULL AND assembly != ''
      GROUP BY assembly
      ORDER BY assembly;
    `;
    const result = await query(sql);
    res.json({ assemblies: result.rows });
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
    const sql = `
      SELECT DISTINCT part_number, COUNT(*)::int as voter_count
      FROM session_voters
      WHERE LOWER(assembly) = LOWER($1) AND part_number IS NOT NULL AND part_number != ''
      GROUP BY part_number
      ORDER BY part_number;
    `;
    const result = await query(sql, [assembly]);
    res.json({ parts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Search voters across all sessions (User accessible)
 * Limited to: assembly, partNumber, section, name, voterId, relationName
 * Does NOT expose session information to users
 */
router.get("/voters/search", async (req, res) => {
  try {
    const {
      name,
      voterId,
      assembly,
      partNumber,
      section,
      relationName,
      page = 1,
      limit = 50,
    } = req.query;

    // At least one search parameter is required
    if (
      !name &&
      !voterId &&
      !assembly &&
      !partNumber &&
      !section &&
      !relationName
    ) {
      return res.status(400).json({
        error: "At least one search parameter is required",
        hint: "Use: name, voterId, assembly, partNumber, section, or relationName",
      });
    }

    const where = [];
    const values = [];
    let idx = 1;

    if (name) {
      where.push(`LOWER(name) LIKE $${idx}`);
      values.push(`%${name.toLowerCase()}%`);
      idx++;
    }

    if (voterId) {
      where.push(`voter_id = $${idx}`);
      values.push(voterId);
      idx++;
    }

    if (assembly) {
      where.push(`LOWER(assembly) LIKE $${idx}`);
      values.push(`%${assembly.toLowerCase()}%`);
      idx++;
    }

    if (partNumber) {
      where.push(`part_number = $${idx}`);
      values.push(partNumber);
      idx++;
    }

    if (section) {
      where.push(`LOWER(section) LIKE $${idx}`);
      values.push(`%${section.toLowerCase()}%`);
      idx++;
    }

    if (relationName) {
      where.push(`LOWER(relation_name) LIKE $${idx}`);
      values.push(`%${relationName.toLowerCase()}%`);
      idx++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Count total results
    const countSql = `SELECT COUNT(*)::int as total FROM session_voters ${whereSql}`;
    const countResult = await query(countSql, values);
    const total = countResult.rows[0].total;

    // Get paginated results - only expose necessary fields to users
    const sql = `
      SELECT id, assembly, part_number, section, serial_number, voter_id, name, 
             relation_type, relation_name, house_number, age, gender, photo_url
      FROM session_voters
      ${whereSql}
      ORDER BY assembly, part_number, serial_number
      LIMIT $${idx} OFFSET $${idx + 1};
    `;
    values.push(parseInt(limit), offset);

    const result = await query(sql, values);

    res.json({
      voters: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
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
