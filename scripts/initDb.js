import "dotenv/config";
import { pool } from "../src/db.js";

const sql = `
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  original_filename TEXT,
  status TEXT DEFAULT 'processing',
  total_pages INT,
  processed_pages INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_pages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  page_path TEXT NOT NULL,
  raw_text TEXT,
  structured_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_pages_session_id ON session_pages(session_id);

CREATE TABLE IF NOT EXISTS session_voters (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  page_id BIGINT REFERENCES session_pages(id) ON DELETE CASCADE,
  page_number INT,
  assembly TEXT,
  part_number TEXT,
  section TEXT,
  serial_number TEXT,
  voter_id TEXT,
  name TEXT,
  relation_type TEXT,
  relation_name TEXT,
  house_number TEXT,
  age INT,
  gender TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_voters_session_id ON session_voters(session_id);
CREATE INDEX IF NOT EXISTS idx_session_voters_voter_id ON session_voters(voter_id);
CREATE INDEX IF NOT EXISTS idx_session_voters_name ON session_voters(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_session_voters_part_section ON session_voters(part_number, section);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_pages' AND column_name = 'image_path'
  ) THEN
    ALTER TABLE session_pages RENAME COLUMN image_path TO page_path;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'total_pages'
  ) THEN
    ALTER TABLE sessions ADD COLUMN total_pages INT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'processed_pages'
  ) THEN
    ALTER TABLE sessions ADD COLUMN processed_pages INT DEFAULT 0;
  END IF;
END $$;
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("Database initialized.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});
