import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/**
 * Hash a password
 */
export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compare password with hash
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Authentication middleware - validates JWT token
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = decoded;
  next();
}

/**
 * Admin-only middleware - must be used after authenticate
 */
export function adminOnly(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

/**
 * User registration
 */
export async function registerUser(
  email,
  password,
  name,
  phone,
  role = "user"
) {
  // Check if user already exists
  const existing = await query("SELECT id FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  if (existing.rowCount > 0) {
    throw new Error("Email already registered");
  }

  const passwordHash = await hashPassword(password);
  const result = await query(
    "INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, phone, role, created_at",
    [email.toLowerCase(), passwordHash, name, phone, role]
  );

  return result.rows[0];
}

/**
 * User login
 */
export async function loginUser(email, password) {
  const result = await query(
    "SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1",
    [email.toLowerCase()]
  );

  if (result.rowCount === 0) {
    throw new Error("Invalid email or password");
  }

  const user = result.rows[0];
  const isValid = await comparePassword(password, user.password_hash);

  if (!isValid) {
    throw new Error("Invalid email or password");
  }

  const token = generateToken(user);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
    },
    token,
  };
}

/**
 * Get user by ID
 */
export async function getUserById(id) {
  const result = await query(
    "SELECT id, email, name, phone, role, created_at FROM users WHERE id = $1",
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get all users (admin only)
 */
export async function getAllUsers() {
  const result = await query(
    "SELECT id, email, name, phone, role, created_at FROM users ORDER BY created_at DESC"
  );
  return result.rows;
}

/**
 * Update user role (admin only)
 */
export async function updateUserRole(userId, newRole) {
  if (!["user", "admin"].includes(newRole)) {
    throw new Error("Invalid role");
  }

  const result = await query(
    "UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, email, name, role",
    [newRole, userId]
  );

  if (result.rowCount === 0) {
    throw new Error("User not found");
  }

  return result.rows[0];
}

/**
 * Delete user (admin only)
 */
export async function deleteUser(userId) {
  const result = await query("DELETE FROM users WHERE id = $1 RETURNING id", [
    userId,
  ]);
  if (result.rowCount === 0) {
    throw new Error("User not found");
  }
  return true;
}
