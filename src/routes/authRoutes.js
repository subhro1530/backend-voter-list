import express from "express";
import { registerUser, loginUser, authenticate, getUserById } from "../auth.js";

const router = express.Router();

/**
 * Register a new user
 * POST /auth/register
 */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Regular users can only create 'user' accounts
    // Admin accounts must be created by existing admins
    const user = await registerUser(email, password, name, phone, "user");

    res.status(201).json({
      message: "Registration successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    if (err.message === "Email already registered") {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * Register an admin (only existing admins can do this)
 * POST /auth/register/admin
 */
router.post("/register/admin", authenticate, async (req, res) => {
  try {
    // Only admins can create admin accounts
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Only admins can create admin accounts" });
    }

    const { email, password, name, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const user = await registerUser(email, password, name, phone, "admin");

    res.status(201).json({
      message: "Admin registration successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    if (err.message === "Email already registered") {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * Login
 * POST /auth/login
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const { user, token } = await loginUser(email, password);

    res.json({
      message: "Login successful",
      user,
      token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * Get current user info
 * GET /auth/me
 */
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Verify token is valid
 * GET /auth/verify
 */
router.get("/verify", authenticate, (req, res) => {
  res.json({
    valid: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      name: req.user.name,
    },
  });
});

export default router;
