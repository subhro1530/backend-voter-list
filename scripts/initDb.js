import "dotenv/config";
import { pool } from "../src/db.js";

const sql = `
-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  original_filename TEXT,
  status TEXT DEFAULT 'processing',
  total_pages INT,
  processed_pages INT DEFAULT 0,
  booth_name TEXT,
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
  religion TEXT DEFAULT 'Other',
  photo_url TEXT,
  is_printed BOOLEAN DEFAULT FALSE,
  printed_at TIMESTAMPTZ,
  printed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_voters_session_id ON session_voters(session_id);
CREATE INDEX IF NOT EXISTS idx_session_voters_voter_id ON session_voters(voter_id);
CREATE INDEX IF NOT EXISTS idx_session_voters_name ON session_voters(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_session_voters_part_section ON session_voters(part_number, section);
CREATE INDEX IF NOT EXISTS idx_session_voters_assembly ON session_voters(assembly);

-- ============================================
-- ELECTION RESULT TABLES (Separate Entity)
-- ============================================

-- Election result sessions (separate from voter list sessions)
CREATE TABLE IF NOT EXISTS election_sessions (
  id UUID PRIMARY KEY,
  original_filename TEXT,
  constituency TEXT,
  total_electors INT,
  status TEXT DEFAULT 'processing',
  total_pages INT,
  processed_pages INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_election_sessions_constituency ON election_sessions(constituency);

-- Election result pages
CREATE TABLE IF NOT EXISTS election_pages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES election_sessions(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  page_path TEXT NOT NULL,
  raw_text TEXT,
  structured_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_election_pages_session_id ON election_pages(session_id);

-- Candidates for each election session (dynamic - names come from OCR)
CREATE TABLE IF NOT EXISTS election_candidates (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES election_sessions(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  party TEXT,
  candidate_index INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, candidate_name)
);

CREATE INDEX IF NOT EXISTS idx_election_candidates_session_id ON election_candidates(session_id);

-- Booth-wise election results
CREATE TABLE IF NOT EXISTS election_booth_results (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES election_sessions(id) ON DELETE CASCADE,
  page_id BIGINT REFERENCES election_pages(id) ON DELETE CASCADE,
  serial_no INT,
  booth_no TEXT NOT NULL,
  candidate_votes JSONB NOT NULL DEFAULT '{}',
  total_valid_votes INT,
  rejected_votes INT DEFAULT 0,
  nota INT DEFAULT 0,
  total_votes INT,
  tendered_votes INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_election_booth_results_session_id ON election_booth_results(session_id);
CREATE INDEX IF NOT EXISTS idx_election_booth_results_booth_no ON election_booth_results(booth_no);

-- Election totals (EVM, Postal, Grand Total per session)
CREATE TABLE IF NOT EXISTS election_totals (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES election_sessions(id) ON DELETE CASCADE,
  total_type TEXT NOT NULL CHECK (total_type IN ('evm', 'postal', 'total')),
  candidate_votes JSONB NOT NULL DEFAULT '{}',
  total_valid_votes INT,
  rejected_votes INT DEFAULT 0,
  nota INT DEFAULT 0,
  total_votes INT,
  tendered_votes INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, total_type)
);

CREATE INDEX IF NOT EXISTS idx_election_totals_session_id ON election_totals(session_id);

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

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_voters' AND column_name = 'religion'
  ) THEN
    ALTER TABLE session_voters ADD COLUMN religion TEXT DEFAULT 'Other';
  END IF;

  -- Add booth_name to sessions if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'booth_name'
  ) THEN
    ALTER TABLE sessions ADD COLUMN booth_name TEXT;
  END IF;

  -- Add photo_url to session_voters if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_voters' AND column_name = 'photo_url'
  ) THEN
    ALTER TABLE session_voters ADD COLUMN photo_url TEXT;
  END IF;

  -- Add is_printed column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_voters' AND column_name = 'is_printed'
  ) THEN
    ALTER TABLE session_voters ADD COLUMN is_printed BOOLEAN DEFAULT FALSE;
  END IF;

  -- Add printed_at column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_voters' AND column_name = 'printed_at'
  ) THEN
    ALTER TABLE session_voters ADD COLUMN printed_at TIMESTAMPTZ;
  END IF;

  -- Add printed_by column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_voters' AND column_name = 'printed_by'
  ) THEN
    ALTER TABLE session_voters ADD COLUMN printed_by BIGINT;
  END IF;
END $$;

-- Create indexes after columns are ensured to exist
CREATE INDEX IF NOT EXISTS idx_session_voters_religion ON session_voters(religion);
CREATE INDEX IF NOT EXISTS idx_session_voters_is_printed ON session_voters(is_printed);
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
