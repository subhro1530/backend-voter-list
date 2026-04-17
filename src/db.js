import pkg from "pg";

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;

const DB_CONNECTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS || "60000",
  10,
);
const DB_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.DB_IDLE_TIMEOUT_MS || "60000",
  10,
);
const DB_POOL_MAX = Number.parseInt(process.env.DB_POOL_MAX || "20", 10);
const DB_QUERY_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.DB_QUERY_RETRIES || "3", 10),
);
const DB_QUERY_RETRY_DELAY_MS = Math.max(
  100,
  Number.parseInt(process.env.DB_QUERY_RETRY_DELAY_MS || "1500", 10),
);
const DB_RETRY_MAX_DELAY_MS = Math.max(
  DB_QUERY_RETRY_DELAY_MS,
  Number.parseInt(process.env.DB_QUERY_RETRY_MAX_DELAY_MS || "10000", 10),
);

const RETRYABLE_DB_CODES = new Set([
  "08P01", // protocol violation (can surface as auth timeout)
  "08000",
  "08001",
  "08003",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

const RETRYABLE_DB_MESSAGE_PATTERNS = [
  /authentication timed out/i,
  /connection terminated unexpectedly/i,
  /server closed the connection unexpectedly/i,
  /terminating connection due to administrator command/i,
  /connect\s+etimedout/i,
  /econnreset/i,
  /timeout/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelay(attempt) {
  const exponential =
    DB_QUERY_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, DB_RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 250);
  return capped + jitter;
}

async function connectWithRetry(maxRetries = DB_QUERY_RETRIES) {
  let attempt = 0;

  while (true) {
    try {
      return await pool.connect();
    } catch (error) {
      const retryable = isTransientDbError(error);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      attempt += 1;
      const delayMs = computeRetryDelay(attempt);
      console.warn(
        `Transient DB connect error (code=${error.code || "unknown"}). Retrying connect in ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
      );
      await sleep(delayMs);
    }
  }
}

export function isTransientDbError(error) {
  if (!error) return false;

  if (RETRYABLE_DB_CODES.has(String(error.code || ""))) {
    return true;
  }

  const message = String(error.message || "");
  return RETRYABLE_DB_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  max: DB_POOL_MAX,
  keepAlive: true,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

export async function query(text, params, options = {}) {
  const maxRetries = Number.isInteger(options?.retries)
    ? Math.max(0, options.retries)
    : DB_QUERY_RETRIES;

  let attempt = 0;

  while (true) {
    try {
      const res = await pool.query(text, params);
      return res;
    } catch (error) {
      const retryable = isTransientDbError(error);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      attempt += 1;
      const delayMs = computeRetryDelay(attempt);

      console.warn(
        `Transient DB error (code=${error.code || "unknown"}). Retrying query in ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
      );
      await sleep(delayMs);
    }
  }
}

export async function withTransaction(callback) {
  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
