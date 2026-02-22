import express from "express";
import path from "path";
import fs from "fs-extra";
import { query } from "../db.js";
import {
  authenticate,
  adminOnly,
  getAllUsers,
  updateUserRole,
  deleteUser,
} from "../auth.js";

const router = express.Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(adminOnly);

/**
 * Get all sessions with full details (Admin only)
 */
router.get("/sessions", async (_req, res) => {
  try {
    const sql = `
      SELECT s.id, s.original_filename, s.status, s.total_pages, s.processed_pages, s.booth_name, s.created_at, s.updated_at,
             COUNT(DISTINCT p.id) AS page_count,
             COUNT(v.id) AS voter_count,
             COUNT(CASE WHEN v.is_printed = true THEN 1 END) AS printed_count
      FROM sessions s
      LEFT JOIN session_pages p ON p.session_id = s.id
      LEFT JOIN session_voters v ON v.session_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC;
    `;
    const result = await query(sql);
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get session details with all voters (Admin only)
 */
router.get("/sessions/:id", async (req, res) => {
  try {
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
      `SELECT id, page_number, assembly, part_number, section, serial_number, voter_id, name, 
              relation_type, relation_name, house_number, age, gender, religion, is_printed, 
              printed_at, created_at 
       FROM session_voters WHERE session_id=$1 ORDER BY page_number, serial_number`,
      [id],
    );

    res.json({
      session: session.rows[0],
      pages: pages.rows,
      voters: voters.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a session (Admin only)
 */
router.delete("/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const storageRoot = path.join(process.cwd(), "storage");

    const deleted = await query(
      "DELETE FROM sessions WHERE id=$1 RETURNING id",
      [id],
    );
    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const dir = path.join(storageRoot, id);
    await fs.remove(dir);

    res.json({
      deleted: id,
      message: "Session and all associated data deleted successfully",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get voters with advanced filtering (Admin only)
 * Supports: name, voterId, gender, age range, religion, assembly, partNumber, section, isPrinted
 */
router.get("/voters", async (req, res) => {
  try {
    const { where, values } = buildAdminVoterFilter(req.query);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT v.id, v.session_id, v.page_number, v.assembly, v.part_number, v.section, 
             v.serial_number, v.voter_id, v.name, v.relation_type, v.relation_name, 
             v.house_number, v.age, v.gender, v.religion, v.photo_url, v.is_printed, v.printed_at, v.created_at,
             s.original_filename as source_file, s.booth_name
      FROM session_voters v
      LEFT JOIN sessions s ON s.id = v.session_id
      ${whereSql}
      ORDER BY v.created_at DESC, v.assembly, v.part_number, v.serial_number
      LIMIT 1000;
    `;
    const result = await query(sql, values);
    res.json({ voters: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get voter by ID with full details (Admin only)
 * Accepts numeric DB id or alphanumeric voter_id
 */
router.get("/voters/:id(*)", async (req, res) => {
  try {
    const idParam = req.params.id || req.params[0];
    // Detect numeric (DB id) vs alphanumeric (voter_id)
    const isNumeric = /^\d+$/.test(idParam);
    const whereCol = isNumeric ? "v.id" : "v.voter_id";

    const result = await query(
      `SELECT v.*, s.original_filename as source_file, s.booth_name, u.name as printed_by_name, u.email as printed_by_email
       FROM session_voters v
       LEFT JOIN sessions s ON s.id = v.session_id
       LEFT JOIN users u ON u.id = v.printed_by
       WHERE ${whereCol} = $1
       ORDER BY v.created_at DESC
       LIMIT 1`,
      [idParam],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Voter not found" });
    }

    res.json({ voter: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get religion statistics (Admin only)
 */
router.get("/stats/religion", async (req, res) => {
  try {
    const { sessionId, assembly } = req.query;
    let whereClauses = [];
    let values = [];
    let idx = 1;

    if (sessionId) {
      whereClauses.push(`session_id = $${idx}`);
      values.push(sessionId);
      idx++;
    }
    if (assembly) {
      whereClauses.push(`LOWER(assembly) = LOWER($${idx})`);
      values.push(assembly);
      idx++;
    }

    const whereSQL = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const sql = `
      SELECT religion, COUNT(*)::int AS count
      FROM session_voters
      ${whereSQL}
      GROUP BY religion
      ORDER BY count DESC;
    `;
    const result = await query(sql, values);

    const total = result.rows.reduce((sum, row) => sum + row.count, 0);
    const stats = result.rows.map((row) => ({
      religion: row.religion,
      count: row.count,
      percentage: total > 0 ? ((row.count / total) * 100).toFixed(2) : "0.00",
    }));

    res.json({ total, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get gender statistics (Admin only)
 */
router.get("/stats/gender", async (req, res) => {
  try {
    const { sessionId, assembly } = req.query;
    let whereClauses = [];
    let values = [];
    let idx = 1;

    if (sessionId) {
      whereClauses.push(`session_id = $${idx}`);
      values.push(sessionId);
      idx++;
    }
    if (assembly) {
      whereClauses.push(`LOWER(assembly) = LOWER($${idx})`);
      values.push(assembly);
      idx++;
    }

    const whereSQL = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const sql = `
      SELECT gender, COUNT(*)::int AS count
      FROM session_voters
      ${whereSQL}
      GROUP BY gender
      ORDER BY count DESC;
    `;
    const result = await query(sql, values);

    const total = result.rows.reduce((sum, row) => sum + row.count, 0);
    const stats = result.rows.map((row) => ({
      gender: row.gender,
      count: row.count,
      percentage: total > 0 ? ((row.count / total) * 100).toFixed(2) : "0.00",
    }));

    res.json({ total, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get print statistics (Admin only)
 */
router.get("/stats/prints", async (req, res) => {
  try {
    const { sessionId, assembly } = req.query;
    let whereClauses = [];
    let values = [];
    let idx = 1;

    if (sessionId) {
      whereClauses.push(`session_id = $${idx}`);
      values.push(sessionId);
      idx++;
    }
    if (assembly) {
      whereClauses.push(`LOWER(assembly) = LOWER($${idx})`);
      values.push(assembly);
      idx++;
    }

    const whereSQL = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const countSql = `
      SELECT 
        COUNT(*)::int AS total_voters,
        COUNT(CASE WHEN is_printed = true THEN 1 END)::int AS printed_count,
        COUNT(CASE WHEN is_printed = false OR is_printed IS NULL THEN 1 END)::int AS not_printed_count
      FROM session_voters
      ${whereSQL};
    `;
    const countResult = await query(countSql, values);

    // Get recent prints
    const recentSql = `
      SELECT v.id, v.voter_id, v.name, v.assembly, v.part_number, v.printed_at, 
             u.name as printed_by_name
      FROM session_voters v
      LEFT JOIN users u ON u.id = v.printed_by
      WHERE v.is_printed = true
      ${sessionId ? `AND v.session_id = $${idx}` : ""}
      ORDER BY v.printed_at DESC
      LIMIT 50;
    `;
    const recentValues = sessionId ? [...values.slice(0, 1)] : [];
    const recentResult = await query(recentSql, recentValues);

    res.json({
      ...countResult.rows[0],
      recentPrints: recentResult.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all assemblies across all sessions (Admin only)
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
 * Get all users (Admin only)
 */
router.get("/users", async (_req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update user role (Admin only)
 */
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: "Role is required" });
    }

    const user = await updateUserRole(id, role);
    res.json({ message: "User role updated", user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Delete user (Admin only)
 */
router.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent admin from deleting themselves
    if (req.user.id === parseInt(id)) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    await deleteUser(id);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Build filter for admin voter search
 */
function buildAdminVoterFilter(params) {
  const where = [];
  const values = [];
  let idx = 1;

  if (params.sessionId) {
    where.push(`v.session_id = $${idx}`);
    values.push(params.sessionId);
    idx += 1;
  }

  if (params.name) {
    where.push(`LOWER(v.name) LIKE $${idx}`);
    values.push(`%${params.name.toLowerCase()}%`);
    idx += 1;
  }

  if (params.voterId) {
    where.push(`v.voter_id = $${idx}`);
    values.push(params.voterId);
    idx += 1;
  }

  if (params.gender) {
    where.push(`LOWER(v.gender) = $${idx}`);
    values.push(params.gender.toLowerCase());
    idx += 1;
  }

  if (params.assembly) {
    where.push(`LOWER(v.assembly) LIKE $${idx}`);
    values.push(`%${params.assembly.toLowerCase()}%`);
    idx += 1;
  }

  if (params.partNumber) {
    where.push(`v.part_number = $${idx}`);
    values.push(params.partNumber);
    idx += 1;
  }

  if (params.section) {
    where.push(`LOWER(v.section) LIKE $${idx}`);
    values.push(`%${params.section.toLowerCase()}%`);
    idx += 1;
  }

  if (params.religion) {
    where.push(`v.religion = $${idx}`);
    values.push(params.religion);
    idx += 1;
  }

  if (params.minAge !== undefined && params.minAge !== "") {
    const val = Number(params.minAge);
    if (!Number.isNaN(val)) {
      where.push(`v.age >= $${idx}`);
      values.push(val);
      idx += 1;
    }
  }

  if (params.maxAge !== undefined && params.maxAge !== "") {
    const val = Number(params.maxAge);
    if (!Number.isNaN(val)) {
      where.push(`v.age <= $${idx}`);
      values.push(val);
      idx += 1;
    }
  }

  if (params.isPrinted !== undefined) {
    const isPrinted = params.isPrinted === "true" || params.isPrinted === true;
    where.push(`v.is_printed = $${idx}`);
    values.push(isPrinted);
    idx += 1;
  }

  if (params.houseNumber) {
    where.push(`v.house_number = $${idx}`);
    values.push(params.houseNumber);
    idx += 1;
  }

  if (params.relationType) {
    where.push(`LOWER(v.relation_type) = $${idx}`);
    values.push(params.relationType.toLowerCase());
    idx += 1;
  }

  if (params.relationName) {
    where.push(`LOWER(v.relation_name) LIKE $${idx}`);
    values.push(`%${params.relationName.toLowerCase()}%`);
    idx += 1;
  }

  return { where, values };
}

export default router;
