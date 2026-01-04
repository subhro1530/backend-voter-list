import "dotenv/config";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || "Administrator";

async function createAdmin() {
  const client = await pool.connect();

  try {
    // Check if admin already exists
    const existing = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [DEFAULT_ADMIN_EMAIL.toLowerCase()]
    );

    if (existing.rowCount > 0) {
      console.log(`Admin user already exists: ${DEFAULT_ADMIN_EMAIL}`);
      return;
    }

    // Create admin user
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const result = await client.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role",
      [
        DEFAULT_ADMIN_EMAIL.toLowerCase(),
        passwordHash,
        DEFAULT_ADMIN_NAME,
        "admin",
      ]
    );

    console.log("Admin user created successfully:");
    console.log(`  Email: ${result.rows[0].email}`);
    console.log(`  Name: ${result.rows[0].name}`);
    console.log(`  Role: ${result.rows[0].role}`);
    console.log("");
    console.log(
      "⚠️  IMPORTANT: Change the password immediately after first login!"
    );
    console.log("");
    console.log(
      "To customize admin credentials, set these environment variables:"
    );
    console.log("  ADMIN_EMAIL=your-email@example.com");
    console.log("  ADMIN_PASSWORD=your-secure-password");
    console.log("  ADMIN_NAME=Your Name");
  } catch (err) {
    console.error("Failed to create admin:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

createAdmin().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
