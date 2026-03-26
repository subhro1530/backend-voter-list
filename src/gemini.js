import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { query } from "./db.js";

const model = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";

const mimeByExt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

const KEY_TIERS = {
  FREE: "free",
  PAID: "paid",
};

const DISPATCH_MODES = {
  AUTO: "auto",
  FREE_ONLY: "free-only",
  PAID_ONLY: "paid-only",
};

const KEY_STATE_TABLE = "gemini_api_key_states";
let keyStateHydrationPromise = null;
let startupAssessmentPromise = null;

const RATE_LIMIT_BASE_DELAY_MS = Math.max(
  Number.parseInt(process.env.GEMINI_RATE_LIMIT_BASE_DELAY_MS || "15000", 10),
  5000,
);
const RATE_LIMIT_MAX_DELAY_MS = Math.max(
  Number.parseInt(process.env.GEMINI_RATE_LIMIT_MAX_DELAY_MS || "180000", 10),
  RATE_LIMIT_BASE_DELAY_MS,
);
const STARTUP_KEY_CHECK_ENABLED =
  String(process.env.GEMINI_STARTUP_KEY_CHECK || "true").toLowerCase() !==
  "false";
const STARTUP_KEY_CHECK_CONCURRENCY = Math.max(
  Number.parseInt(process.env.GEMINI_STARTUP_KEY_CHECK_CONCURRENCY || "4", 10),
  1,
);
const STARTUP_KEY_CHECK_TIMEOUT_MS = Math.max(
  Number.parseInt(
    process.env.GEMINI_STARTUP_KEY_CHECK_TIMEOUT_MS || "7000",
    10,
  ),
  3000,
);
const ALLOW_PAID_FALLBACK_IN_AUTO =
  String(process.env.GEMINI_ALLOW_PAID_FALLBACK || "false")
    .trim()
    .toLowerCase() === "true";

let globalDispatchMode = (() => {
  const raw = String(process.env.GEMINI_DISPATCH_MODE || "auto")
    .trim()
    .toLowerCase();
  if (
    raw === DISPATCH_MODES.AUTO ||
    raw === DISPATCH_MODES.FREE_ONLY ||
    raw === DISPATCH_MODES.PAID_ONLY
  ) {
    return raw;
  }
  return DISPATCH_MODES.AUTO;
})();

const keyMetaByApiKey = new Map();

function getKeyHash(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function nextQuotaResetTimeIso() {
  const resetHour = Number.parseInt(
    process.env.GEMINI_DAILY_RESET_HOUR_UTC || "0",
    10,
  );
  const resetMinute = Number.parseInt(
    process.env.GEMINI_DAILY_RESET_MINUTE_UTC || "0",
    10,
  );

  const normalizedHour = Number.isFinite(resetHour)
    ? Math.min(Math.max(resetHour, 0), 23)
    : 0;
  const normalizedMinute = Number.isFinite(resetMinute)
    ? Math.min(Math.max(resetMinute, 0), 59)
    : 0;

  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      normalizedHour,
      normalizedMinute,
      0,
      0,
    ),
  );

  if (now >= next) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.toISOString();
}

async function persistSingleKeyState(apiKey) {
  const status = apiKeyStatus.get(apiKey);
  if (!status) return;

  const meta = keyMetaByApiKey.get(apiKey) || {};
  const keyPreview = `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`;

  await query(
    `INSERT INTO ${KEY_STATE_TABLE} (
       key_hash,
       key_preview,
       env_name,
       tier,
       status,
       exhausted_at,
       recovery_time,
       last_error,
       request_count,
       success_count,
       failure_count,
       last_used,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()
     )
     ON CONFLICT (key_hash)
     DO UPDATE SET
       key_preview = EXCLUDED.key_preview,
       env_name = EXCLUDED.env_name,
       tier = EXCLUDED.tier,
       status = EXCLUDED.status,
       exhausted_at = EXCLUDED.exhausted_at,
       recovery_time = EXCLUDED.recovery_time,
       last_error = EXCLUDED.last_error,
       request_count = EXCLUDED.request_count,
       success_count = EXCLUDED.success_count,
       failure_count = EXCLUDED.failure_count,
       last_used = EXCLUDED.last_used,
       updated_at = now()`,
    [
      getKeyHash(apiKey),
      keyPreview,
      meta.envName || null,
      meta.tier || KEY_TIERS.FREE,
      status.status || "active",
      status.exhaustedAt || null,
      status.recoveryTime || null,
      status.lastError || null,
      status.requestCount || 0,
      status.successCount || 0,
      status.failureCount || 0,
      status.lastUsed || null,
    ],
  );
}

function queuePersistKeyState(apiKey) {
  void persistSingleKeyState(apiKey).catch((err) => {
    // DB persistence must never block OCR processing.
    console.warn("⚠️ Failed to persist Gemini key status:", err.message);
  });
}

export async function persistAllApiKeyStates() {
  if (API_KEYS.length === 0) return;

  await Promise.all(
    API_KEYS.map((key) =>
      persistSingleKeyState(key).catch((err) => {
        console.warn(
          `⚠️ Failed to persist key state for ${key.slice(0, 10)}...: ${err.message}`,
        );
      }),
    ),
  );
}

function hydrateKeyStatusesFromDb() {
  if (keyStateHydrationPromise) return keyStateHydrationPromise;

  keyStateHydrationPromise = (async () => {
    if (API_KEYS.length === 0) return;

    const hashToKey = new Map(API_KEYS.map((key) => [getKeyHash(key), key]));
    const hashes = [...hashToKey.keys()];

    try {
      const res = await query(
        `SELECT key_hash, status, exhausted_at, recovery_time, last_error,
                request_count, success_count, failure_count, last_used
         FROM ${KEY_STATE_TABLE}
         WHERE key_hash = ANY($1::text[])`,
        [hashes],
      );

      const now = Date.now();
      let restored = 0;

      for (const row of res.rows) {
        const apiKey = hashToKey.get(row.key_hash);
        if (!apiKey) continue;

        const existing = apiKeyStatus.get(apiKey);
        if (!existing) continue;

        const recoveryMs = row.recovery_time
          ? new Date(row.recovery_time).getTime()
          : null;
        const canRecoverNow = recoveryMs !== null && recoveryMs <= now;

        const nextStatus =
          (row.status === "rate_limited" || row.status === "exhausted") &&
          !canRecoverNow
            ? row.status
            : "active";

        apiKeyStatus.set(apiKey, {
          ...existing,
          status: nextStatus,
          exhaustedAt: row.exhausted_at || null,
          recoveryTime:
            nextStatus === "active" ? null : row.recovery_time || null,
          lastError: nextStatus === "active" ? null : row.last_error || null,
          requestCount: row.request_count || 0,
          successCount: row.success_count || 0,
          failureCount: row.failure_count || 0,
          lastUsed: row.last_used || null,
        });

        restored++;
      }

      if (restored > 0) {
        console.log(`💾 Restored ${restored} Gemini key states from database`);
      }
    } catch (err) {
      // First run may happen before DB migration creates the table.
      console.warn("⚠️ Gemini key state hydration skipped:", err.message);
    }
  })();

  return keyStateHydrationPromise;
}

/**
 * Load API keys from environment variables.
 * Dynamically detects all GEMINI_API_KEY_* variables
 * Also checks legacy GEMINI_API_KEY as a fallback
 */
function loadApiKeysFromEnv() {
  const entries = [];
  const seen = new Set();

  const freeEntries = [];
  const paidEntries = [];
  const extraFreeEntries = [];

  // Find keys by explicit tiers so paid keys are only used as fallback.
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !value.trim()) continue;

    const trimmedValue = value.trim();

    if (/^GEMINI_API_KEY_PAID_\d+$/i.test(key)) {
      const order = parseInt(key.split("_").pop(), 10) || 9999;
      paidEntries.push({
        envName: key,
        apiKey: trimmedValue,
        tier: KEY_TIERS.PAID,
        order,
      });
      continue;
    }

    if (/^GEMINI_API_KEY_\d+$/i.test(key)) {
      const order = parseInt(key.split("_").pop(), 10) || 9999;
      freeEntries.push({
        envName: key,
        apiKey: trimmedValue,
        tier: KEY_TIERS.FREE,
        order,
      });
      continue;
    }

    if (key === "GEMINI_API_KEY") {
      extraFreeEntries.push({
        envName: key,
        apiKey: trimmedValue,
        tier: KEY_TIERS.FREE,
        order: 99999,
      });
      continue;
    }

    if (key.startsWith("GEMINI_API_KEY_")) {
      extraFreeEntries.push({
        envName: key,
        apiKey: trimmedValue,
        tier: KEY_TIERS.FREE,
        order: 50000,
      });
    }
  }

  freeEntries.sort((a, b) => a.order - b.order);
  paidEntries.sort((a, b) => a.order - b.order);

  const ordered = [...freeEntries, ...extraFreeEntries, ...paidEntries];

  for (const item of ordered) {
    if (seen.has(item.apiKey)) continue;
    seen.add(item.apiKey);
    entries.push(item);
  }

  const freeCount = entries.filter(
    (entry) => entry.tier === KEY_TIERS.FREE,
  ).length;
  const paidCount = entries.filter(
    (entry) => entry.tier === KEY_TIERS.PAID,
  ).length;

  console.log(
    `🔑 Loaded ${entries.length} unique Gemini API keys (${freeCount} free + ${paidCount} paid fallback)`,
  );

  return entries;
}

// API keys loaded from environment variables
let API_KEYS = [];

// Track API key status - Enhanced tracking for parallel engines
const apiKeyStatus = new Map();

// Engine tracking - each key becomes an independent processing engine
const engines = new Map();

/**
 * Initialize or reinitialize API key status tracking
 * Creates independent engines for parallel processing
 */
export function initializeKeyStatus() {
  const loadedEntries = loadApiKeysFromEnv();
  API_KEYS = loadedEntries.map((entry) => entry.apiKey);
  apiKeyStatus.clear();
  engines.clear();
  keyMetaByApiKey.clear();

  loadedEntries.forEach((entry, index) => {
    const key = entry.apiKey;
    keyMetaByApiKey.set(key, {
      envName: entry.envName,
      tier: entry.tier,
    });

    apiKeyStatus.set(key, {
      status: "active",
      exhaustedAt: null,
      lastError: null,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsed: null,
      recoveryTime: null,
    });

    // Create engine for each key
    engines.set(index, {
      keyIndex: index,
      apiKey: key,
      tier: entry.tier,
      envName: entry.envName,
      busy: false,
      processing: null,
      totalProcessed: 0,
    });
  });

  console.log(
    `🚀 Initialized ${API_KEYS.length} API engines for parallel processing`,
  );

  keyStateHydrationPromise = null;
  void hydrateKeyStatusesFromDb().then(() => {
    void runStartupApiKeyAssessment().catch((err) => {
      console.warn("⚠️ Startup key assessment failed:", err.message);
    });
  });

  return API_KEYS.length;
}

function getKeyTier(apiKey) {
  return keyMetaByApiKey.get(apiKey)?.tier || KEY_TIERS.FREE;
}

export function getAllowedDispatchModes() {
  return Object.values(DISPATCH_MODES);
}

function normalizeDispatchMode(mode) {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (getAllowedDispatchModes().includes(normalized)) {
    return normalized;
  }
  return null;
}

function resolveDispatchMode(modeOverride) {
  const normalized = normalizeDispatchMode(modeOverride);
  if (normalized) return normalized;
  return globalDispatchMode;
}

function isPaidAllowedForDispatchMode(modeOverride = null) {
  const mode = resolveDispatchMode(modeOverride);
  if (mode === DISPATCH_MODES.PAID_ONLY) return true;
  if (mode === DISPATCH_MODES.FREE_ONLY) return false;
  return ALLOW_PAID_FALLBACK_IN_AUTO;
}

export function getGlobalDispatchMode() {
  return globalDispatchMode;
}

export function setGlobalDispatchMode(mode) {
  const normalized = normalizeDispatchMode(mode);
  if (!normalized) {
    throw new Error(
      `Invalid dispatch mode. Allowed: ${getAllowedDispatchModes().join(", ")}`,
    );
  }
  globalDispatchMode = normalized;
  return globalDispatchMode;
}

function getTierBreakdown() {
  const toCounters = () => ({
    total: 0,
    active: 0,
    rateLimited: 0,
    exhausted: 0,
    busy: 0,
    available: 0,
  });

  const pools = {
    free: toCounters(),
    paid: toCounters(),
  };

  engines.forEach((engine) => {
    const tier = engine.tier || KEY_TIERS.FREE;
    const keyStatus = apiKeyStatus.get(engine.apiKey);
    const pool = pools[tier] || pools.free;

    pool.total += 1;
    if (engine.busy) pool.busy += 1;

    if (keyStatus?.status === "active") {
      pool.active += 1;
      if (!engine.busy) pool.available += 1;
    } else if (keyStatus?.status === "rate_limited") {
      pool.rateLimited += 1;
    } else if (keyStatus?.status === "exhausted") {
      pool.exhausted += 1;
    }
  });

  return pools;
}

function getActiveDispatchTier(modeOverride = null) {
  const pools = getTierBreakdown();
  const mode = resolveDispatchMode(modeOverride);
  const allowPaid = isPaidAllowedForDispatchMode(mode);

  if (mode === DISPATCH_MODES.FREE_ONLY) return KEY_TIERS.FREE;
  if (mode === DISPATCH_MODES.PAID_ONLY) return KEY_TIERS.PAID;

  if (pools.free.available > 0 || pools.free.active > 0) return KEY_TIERS.FREE;
  if (allowPaid && (pools.paid.available > 0 || pools.paid.active > 0)) {
    return KEY_TIERS.PAID;
  }
  return KEY_TIERS.FREE;
}

function getDispatchEngines(availableOnly = false, options = {}) {
  tryRecoverExhaustedKeys();
  const mode = resolveDispatchMode(options.dispatchMode);
  const allowPaid = isPaidAllowedForDispatchMode(mode);

  const activeEngines = [];
  engines.forEach((engine, index) => {
    const keyStatus = apiKeyStatus.get(engine.apiKey);
    if (keyStatus?.status === "active") {
      if (!availableOnly || !engine.busy) {
        activeEngines.push({ ...engine, index });
      }
    }
  });

  const freeEngines = activeEngines.filter(
    (engine) => engine.tier === KEY_TIERS.FREE,
  );
  const paidEngines = activeEngines.filter(
    (engine) => engine.tier === KEY_TIERS.PAID,
  );

  if (mode === DISPATCH_MODES.FREE_ONLY) return freeEngines;
  if (mode === DISPATCH_MODES.PAID_ONLY) return paidEngines;

  if (freeEngines.length > 0) return freeEngines;

  if (allowPaid && paidEngines.length > 0) return paidEngines;

  return [];
}

// Initialize all keys as active on startup
initializeKeyStatus();

/**
 * Check if an error indicates PERMANENT quota exhaustion (daily limit)
 * vs temporary rate limiting (per-minute/per-second limits)
 */
function isQuotaExhaustedError(statusCode, errorText) {
  const lowerError = (errorText || "").toLowerCase();

  // PERMANENT quota exhaustion patterns (daily/monthly limits)
  const permanentQuotaPatterns = [
    "quota exceeded",
    "daily limit",
    "monthly limit",
    "billing",
    "payment required",
    "account",
  ];

  // Check for permanent exhaustion (403 with quota message)
  if (
    statusCode === 403 &&
    permanentQuotaPatterns.some((p) => lowerError.includes(p))
  ) {
    return { permanent: true, temporary: false };
  }

  // TEMPORARY rate limiting patterns (per-minute/per-second)
  const temporaryRateLimitPatterns = [
    "rate limit",
    "too many requests",
    "resource_exhausted",
    "try again",
    "retry",
  ];

  // 429 is always temporary rate limiting
  if (statusCode === 429) {
    return { permanent: false, temporary: true };
  }

  // Check for temporary rate limiting
  if (temporaryRateLimitPatterns.some((p) => lowerError.includes(p))) {
    return { permanent: false, temporary: true };
  }

  return { permanent: false, temporary: false };
}

function computeRateLimitDelayMs(status) {
  const failures = Math.max(Number(status?.failureCount || 0), 0);
  const multiplier = Math.min(1 + failures, 6);
  const nextDelay = RATE_LIMIT_BASE_DELAY_MS * multiplier;
  return Math.max(
    RATE_LIMIT_BASE_DELAY_MS,
    Math.min(nextDelay, RATE_LIMIT_MAX_DELAY_MS),
  );
}

/**
 * Mark an API key as rate limited (temporary) or exhausted (permanent)
 */
function markKeyRateLimited(apiKey, errorMessage, isPermanent = false) {
  const status = apiKeyStatus.get(apiKey);
  if (status) {
    if (isPermanent) {
      // Daily quota exhaustion - recover after next configured reset window.
      const recoveryTime = nextQuotaResetTimeIso();
      apiKeyStatus.set(apiKey, {
        ...status,
        status: "exhausted",
        exhaustedAt: new Date().toISOString(),
        lastError: errorMessage,
        recoveryTime,
        failureCount: (status.failureCount || 0) + 1,
      });
      console.log(
        `❌ API Key ${apiKey.slice(
          0,
          10,
        )}... EXHAUSTED (daily quota reached, retry after ${recoveryTime})`,
      );
    } else {
      // Adaptive cooldown avoids hammering temporarily blocked keys repeatedly.
      const delayMs = computeRateLimitDelayMs(status);
      const recoveryTime = new Date(Date.now() + delayMs).toISOString();
      apiKeyStatus.set(apiKey, {
        ...status,
        status: "rate_limited",
        lastError: errorMessage,
        recoveryTime: recoveryTime,
        failureCount: (status.failureCount || 0) + 1,
      });
      console.log(
        `⏳ API Key ${apiKey.slice(
          0,
          10,
        )}... rate limited (will retry after ${Math.ceil(delayMs / 1000)}s)`,
      );
    }

    queuePersistKeyState(apiKey);
  }
}

// Keep the old function name for backward compatibility
function markKeyExhausted(apiKey, errorMessage) {
  markKeyRateLimited(apiKey, errorMessage, true);
}

async function assessSingleApiKeyAtStartup(apiKey) {
  const status = apiKeyStatus.get(apiKey);
  if (!status) return { apiKey, checked: false, reason: "missing-status" };

  // Respect persisted cooldown/exhaustion instead of forcing immediate probe.
  if (
    (status.status === "rate_limited" || status.status === "exhausted") &&
    status.recoveryTime &&
    Date.now() < new Date(status.recoveryTime).getTime()
  ) {
    return {
      apiKey,
      checked: false,
      reason: `${status.status}-until-${status.recoveryTime}`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    STARTUP_KEY_CHECK_TIMEOUT_MS,
  );

  try {
    const probePayload = {
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(probePayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const quota = isQuotaExhaustedError(response.status, errorText);

      if (quota.permanent) {
        markKeyExhausted(
          apiKey,
          `startup-check status ${response.status}: ${errorText.slice(0, 180)}`,
        );
        return { apiKey, checked: true, status: "exhausted" };
      }

      if (quota.temporary) {
        markKeyRateLimited(
          apiKey,
          `startup-check status ${response.status}: ${errorText.slice(0, 180)}`,
          false,
        );
        return { apiKey, checked: true, status: "rate_limited" };
      }

      return {
        apiKey,
        checked: true,
        status: "active",
        note: `non-quota error ignored (${response.status})`,
      };
    }

    const current = apiKeyStatus.get(apiKey) || status;
    apiKeyStatus.set(apiKey, {
      ...current,
      status: "active",
      exhaustedAt: null,
      lastError: null,
      recoveryTime: null,
    });
    queuePersistKeyState(apiKey);

    return { apiKey, checked: true, status: "active" };
  } catch (error) {
    if (error?.name === "AbortError") {
      markKeyRateLimited(apiKey, "startup-check timeout", false);
      return { apiKey, checked: true, status: "rate_limited", note: "timeout" };
    }

    return {
      apiKey,
      checked: true,
      status: "active",
      note: `startup-check skipped: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runStartupApiKeyAssessment() {
  if (!STARTUP_KEY_CHECK_ENABLED) {
    return {
      skipped: true,
      reason: "GEMINI_STARTUP_KEY_CHECK=false",
      status: getApiKeyStatuses(),
    };
  }

  if (startupAssessmentPromise) {
    return startupAssessmentPromise;
  }

  startupAssessmentPromise = (async () => {
    if (API_KEYS.length === 0) {
      return {
        skipped: true,
        reason: "no-api-keys",
        status: getApiKeyStatuses(),
      };
    }

    await hydrateKeyStatusesFromDb();

    const queue = [...API_KEYS];
    const checks = [];
    const workers = Array.from(
      { length: Math.min(STARTUP_KEY_CHECK_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length) {
          const key = queue.shift();
          if (!key) break;
          const result = await assessSingleApiKeyAtStartup(key);
          checks.push(result);
        }
      },
    );

    await Promise.all(workers);
    await persistAllApiKeyStates();

    const status = getApiKeyStatuses();
    const summary = {
      checked: checks.filter((c) => c.checked).length,
      skipped: checks.filter((c) => !c.checked).length,
      activeDispatchTier: status.activeDispatchTier,
      freeAvailable: status.pools?.free?.available || 0,
      paidAvailable: status.pools?.paid?.available || 0,
      allExhausted: status.allExhausted,
    };

    console.log(
      `🧪 Startup Gemini key assessment complete: checked=${summary.checked}, skipped=${summary.skipped}, dispatch=${summary.activeDispatchTier}, freeAvailable=${summary.freeAvailable}, paidAvailable=${summary.paidAvailable}`,
    );

    return { skipped: false, checks, summary, status };
  })();

  try {
    return await startupAssessmentPromise;
  } finally {
    startupAssessmentPromise = null;
  }
}

/**
 * Try to recover rate-limited keys after their recovery time
 */
function tryRecoverExhaustedKeys() {
  const now = new Date();
  let recoveredCount = 0;

  API_KEYS.forEach((key) => {
    const status = apiKeyStatus.get(key);
    // Recover keys after recovery time (rate_limited or exhausted daily quota).
    if (
      (status?.status === "rate_limited" || status?.status === "exhausted") &&
      status.recoveryTime
    ) {
      const recoveryTime = new Date(status.recoveryTime);
      if (now >= recoveryTime) {
        apiKeyStatus.set(key, {
          ...status,
          status: "active",
          exhaustedAt: null,
          lastError: null,
          recoveryTime: null,
        });
        console.log(
          `✅ API Key ${key.slice(0, 10)}... recovered and returned to active`,
        );
        queuePersistKeyState(key);
        recoveredCount++;
      }
    }
  });

  return recoveredCount;
}

/**
 * Get all active API keys
 */
function getActiveKeys() {
  // First try to recover any exhausted keys
  tryRecoverExhaustedKeys();

  return API_KEYS.filter((key) => {
    const status = apiKeyStatus.get(key);
    return status?.status === "active";
  });
}

/**
 * Get available engines for parallel processing
 */
export function getAvailableEngines(options = {}) {
  return getDispatchEngines(true, options);
}

/**
 * Add a delay between API calls to avoid hitting rate limits
 */
function staggeredDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the next available engine (round-robin with rate limit awareness)
 */
function getNextAvailableEngine() {
  const available = getDispatchEngines(true);

  // Return the engine with lowest request count (load balancing)
  if (available.length > 0) {
    available.sort((a, b) => {
      const statusA = apiKeyStatus.get(a.apiKey);
      const statusB = apiKeyStatus.get(b.apiKey);
      return (statusA?.requestCount || 0) - (statusB?.requestCount || 0);
    });
    return available[0];
  }

  return null;
}

function getSoonestRecoveryWaitMs(defaultWaitMs = 15000) {
  const now = Date.now();
  const waits = [];

  API_KEYS.forEach((key) => {
    const status = apiKeyStatus.get(key);
    if (status?.status === "rate_limited" && status.recoveryTime) {
      const remaining = new Date(status.recoveryTime).getTime() - now;
      waits.push(Math.max(remaining, 0));
    }
  });

  if (waits.length === 0) return defaultWaitMs;
  return Math.max(Math.min(...waits), 500);
}

/**
 * Get the current active API key (first one that's still active)
 */
export function getCurrentApiKey(options = {}) {
  if (API_KEYS.length === 0) {
    initializeKeyStatus();
  }

  tryRecoverExhaustedKeys();

  const dispatchMode = resolveDispatchMode(options.dispatchMode);
  const allowPaid = isPaidAllowedForDispatchMode(dispatchMode);
  const dispatchTier = getActiveDispatchTier(dispatchMode);
  let activeKey = API_KEYS.find(
    (key) =>
      apiKeyStatus.get(key)?.status === "active" &&
      getKeyTier(key) === dispatchTier,
  );

  if (dispatchMode === DISPATCH_MODES.FREE_ONLY) {
    return activeKey || null;
  }

  if (dispatchMode === DISPATCH_MODES.PAID_ONLY) {
    return activeKey || null;
  }

  // If the preferred pool is not available, use any active key.
  if (!activeKey && allowPaid) {
    activeKey = API_KEYS.find(
      (key) => apiKeyStatus.get(key)?.status === "active",
    );
  }

  return activeKey || null;
}

/**
 * Get status of all API keys with enhanced metrics
 */
export function getApiKeyStatuses(options = {}) {
  if (API_KEYS.length === 0) {
    initializeKeyStatus();
  }

  tryRecoverExhaustedKeys();
  const dispatchMode = resolveDispatchMode(options.dispatchMode);
  const allowPaid = isPaidAllowedForDispatchMode(dispatchMode);

  const statuses = API_KEYS.map((key, index) => {
    const status = apiKeyStatus.get(key) || {
      status: "active",
      exhaustedAt: null,
      lastError: null,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsed: null,
      recoveryTime: null,
    };
    const engine = engines.get(index);

    return {
      engineId: index + 1,
      keyIndex: index + 1,
      keyPreview: `${key.slice(0, 10)}...${key.slice(-4)}`,
      tier: engine?.tier || getKeyTier(key),
      envName: engine?.envName || keyMetaByApiKey.get(key)?.envName || null,
      status: status.status,
      busy: engine?.busy || false,
      exhaustedAt: status.exhaustedAt,
      lastError: status.lastError,
      recoveryTime: status.recoveryTime,
      metrics: {
        totalRequests: status.requestCount || 0,
        successCount: status.successCount || 0,
        failureCount: status.failureCount || 0,
        lastUsed: status.lastUsed,
        engineProcessed: engine?.totalProcessed || 0,
      },
    };
  });

  const activeCount = statuses.filter((s) => s.status === "active").length;
  const rateLimitedCount = statuses.filter(
    (s) => s.status === "rate_limited",
  ).length;
  const exhaustedCount = statuses.filter(
    (s) => s.status === "exhausted",
  ).length;
  const busyCount = statuses.filter((s) => s.busy).length;
  const pools = getTierBreakdown();
  const dispatchTier = getActiveDispatchTier(dispatchMode);

  return {
    totalEngines: API_KEYS.length,
    activeEngines: activeCount,
    rateLimitedEngines: rateLimitedCount,
    exhaustedEngines: exhaustedCount,
    busyEngines: busyCount,
    availableEngines: activeCount - busyCount,
    configuredDispatchMode: dispatchMode,
    paidFallbackEnabledInAuto: ALLOW_PAID_FALLBACK_IN_AUTO,
    paidAllowedForCurrentMode: allowPaid,
    activeDispatchTier: dispatchTier,
    pools,
    allExhausted: activeCount === 0 && rateLimitedCount === 0, // Only exhausted when no active and no rate-limited
    engines: statuses,
  };
}

/**
 * Reset all API keys to active status (useful for daily reset)
 */
export function resetAllApiKeys() {
  initializeKeyStatus();
  API_KEYS.forEach((key) => queuePersistKeyState(key));
  console.log(
    `🔄 All ${API_KEYS.length} API engines have been reset to active status`,
  );
  return getApiKeyStatuses();
}

/**
 * Process a single page with a specific engine
 */
async function processWithEngine(engineIndex, filePath, retryCount = 0) {
  const engine = engines.get(engineIndex);
  if (!engine) {
    throw new Error(`Engine ${engineIndex} not found`);
  }

  const apiKey = engine.apiKey;
  const status = apiKeyStatus.get(apiKey);

  // Check if key is active
  if (status?.status !== "active") {
    if (status?.status === "rate_limited") {
      throw new Error(
        `ENGINE_RATE_LIMITED: Engine ${engineIndex} temporarily rate limited`,
      );
    }
    throw new Error(`ENGINE_EXHAUSTED: Engine ${engineIndex} is exhausted`);
  }

  // Mark engine as busy
  engine.busy = true;
  engine.processing = filePath;

  try {
    const data = await fs.readFile(filePath);
    const base64 = data.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeByExt[ext] || "application/octet-stream";

    const payload = {
      contents: [
        {
          parts: [
            {
              text: `You are parsing an Indian voter list page. Return only JSON with fields:
{
  "assembly": "assembly/constituency name",
  "partNumber": "part number",
  "section": "section name/number",
  "boothName": "booth name or polling station name if visible at the top of the page (e.g. 'XYZ Primary School', 'ABC Community Hall'). Look for it near Part No. or Section header. If not visible, return empty string.",
  "voters": [
    {
      "serialNumber": "serial number",
      "voterId": "EPIC number (the alphanumeric voter ID like XFB2313997, ABC1234567 etc.)",
      "name": "voter name",
      "relationType": "father|mother|husband|guardian",
      "relationName": "relation name",
      "houseNumber": "house number",
      "age": "age",
      "gender": "male|female",
      "underAdjudication": "true if this specific voter card has ADJUDICATION watermark/text, else false"
    }
  ]
}

IMPORTANT:
1. The "boothName" is typically the name of the building/location used as the polling booth, often found near the top of the first page after "Part No." section.
2. "voterId" MUST be the EPIC number (e.g. XFB2313997, ABC1234567). It is printed below or near the voter's photo. Do NOT use location codes like "WB/01/003/000070" — those are NOT voter IDs. If the EPIC number is not clearly readable, return an empty string "".
3. Set "underAdjudication" per voter row. Use true only when the adjudication mark/watermark belongs to that voter card; otherwise false.
4. No prose - ONLY valid JSON.`,
            },
            {
              inline_data: {
                mime_type: mime,
                data: base64,
              },
            },
          ],
        },
      ],
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Update request count
    apiKeyStatus.set(apiKey, {
      ...status,
      requestCount: (status.requestCount || 0) + 1,
      lastUsed: new Date().toISOString(),
    });
    queuePersistKeyState(apiKey);

    console.log(
      `🔧 Engine ${engineIndex + 1} processing: ${path.basename(filePath)}`,
    );

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      const quotaError = isQuotaExhaustedError(res.status, errorText);

      if (quotaError.permanent) {
        // Permanent quota exhaustion - mark as exhausted
        markKeyExhausted(
          apiKey,
          `Status ${res.status}: ${errorText.slice(0, 200)}`,
        );
        throw new Error(
          `ENGINE_EXHAUSTED: Engine ${engineIndex} permanently exhausted`,
        );
      } else if (quotaError.temporary) {
        // Temporary rate limit - mark as rate limited (short recovery)
        markKeyRateLimited(
          apiKey,
          `Status ${res.status}: ${errorText.slice(0, 200)}`,
          false,
        );
        throw new Error(
          `ENGINE_RATE_LIMITED: Engine ${engineIndex} temporarily rate limited`,
        );
      }

      throw new Error(`Gemini error ${res.status}: ${errorText}`);
    }

    const json = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const combinedText = parts
      .map((p) => (p.text ? p.text : ""))
      .join("\n")
      .trim();

    // Update success count
    const currentStatus = apiKeyStatus.get(apiKey);
    apiKeyStatus.set(apiKey, {
      ...currentStatus,
      successCount: (currentStatus.successCount || 0) + 1,
    });
    queuePersistKeyState(apiKey);

    engine.totalProcessed++;
    engine.busy = false;
    engine.processing = null;

    return {
      text: combinedText,
      full: json,
      keyUsed: apiKey,
      engineId: engineIndex + 1,
    };
  } catch (err) {
    engine.busy = false;
    engine.processing = null;

    // If engine exhausted or rate limited, propagate the error
    if (
      err.message.includes("ENGINE_EXHAUSTED") ||
      err.message.includes("ENGINE_RATE_LIMITED")
    ) {
      throw err;
    }

    // For other errors, check if quota related
    const quotaError = isQuotaExhaustedError(0, err.message);
    if (quotaError.permanent) {
      markKeyExhausted(apiKey, err.message.slice(0, 200));
      throw new Error(
        `ENGINE_EXHAUSTED: Engine ${engineIndex} permanently exhausted`,
      );
    } else if (quotaError.temporary) {
      markKeyRateLimited(apiKey, err.message.slice(0, 200), false);
      throw new Error(
        `ENGINE_RATE_LIMITED: Engine ${engineIndex} temporarily rate limited`,
      );
    }

    throw err;
  }
}

/**
 * Process pages in TRUE PARALLEL using multiple engines from DIFFERENT Google Cloud projects
 * Each project has its own independent rate limit (2-15 RPM depending on tier)
 * With N keys from N different projects, we get Nx the throughput!
 */
export async function processPagesBatch(
  pagePaths,
  startIndex = 0,
  onProgress = null,
  options = {},
) {
  const results = [];
  const errors = [];

  // FAST processing - each key is from a different project with independent limits
  // 2-3 seconds between requests PER ENGINE is enough with different projects
  const PER_ENGINE_DELAY = parseInt(process.env.GEMINI_PAGE_DELAY_MS) || 2000; // 2 seconds per engine
  const RATE_LIMIT_WAIT = RATE_LIMIT_BASE_DELAY_MS;
  const MAX_RETRIES_PER_PAGE = Math.max(
    parseInt(process.env.GEMINI_MAX_RETRIES_PER_PAGE || "8", 10),
    3,
  );
  const MAX_PAGE_WAIT_MS = Math.max(
    parseInt(process.env.GEMINI_MAX_PAGE_WAIT_MS || "900000", 10),
    120000,
  );

  // Select dispatch pool (free first, paid fallback).
  const dispatchMode = resolveDispatchMode(options.dispatchMode);
  const dispatchPool = getDispatchEngines(false, { dispatchMode });
  const totalEngines = dispatchPool.length;
  const dispatchTier = getActiveDispatchTier(dispatchMode);

  if (totalEngines === 0) {
    const status = getApiKeyStatuses({ dispatchMode });
    const noFreeAvailable = (status.pools?.free?.active || 0) === 0;
    const paidBlocked =
      dispatchMode === DISPATCH_MODES.AUTO &&
      !status.paidAllowedForCurrentMode &&
      (status.pools?.paid?.active || 0) > 0;

    const reason = paidBlocked
      ? "Free pool unavailable and paid fallback is disabled (GEMINI_ALLOW_PAID_FALLBACK=false)."
      : noFreeAvailable
        ? "No active engines available in selected dispatch mode."
        : "No engines available for processing.";

    return {
      results: [],
      errors: pagePaths.map((pagePath, index) => ({
        success: false,
        pageIndex: startIndex + index,
        error: reason,
        pagePath,
        canRetryLater: true,
      })),
      processedCount: 0,
      errorCount: pagePaths.length,
      totalCount: pagePaths.length,
      allKeysExhausted: status.allExhausted,
      blockedByCostGuard: paidBlocked,
    };
  }

  console.log(
    `🚀 Starting PARALLEL processing of ${pagePaths.length} pages with ${totalEngines} engines (tier: ${dispatchTier}, mode: ${dispatchMode})...`,
  );
  console.log(
    `⚡ Using ${
      PER_ENGINE_DELAY / 1000
    }s delay per engine (independent project quotas)`,
  );

  // Process pages in batches equal to number of engines (TRUE PARALLEL)
  const batchSize = Math.min(totalEngines, pagePaths.length);

  for (
    let batchStart = 0;
    batchStart < pagePaths.length;
    batchStart += batchSize
  ) {
    const batchEnd = Math.min(batchStart + batchSize, pagePaths.length);
    const batchPaths = pagePaths.slice(batchStart, batchEnd);

    console.log(
      `\n📦 Processing batch ${Math.floor(batchStart / batchSize) + 1}: pages ${
        batchStart + 1
      }-${batchEnd}/${pagePaths.length}`,
    );

    // Process this batch in parallel
    const batchPromises = batchPaths.map(async (pagePath, batchIndex) => {
      const pageIndex = batchStart + batchIndex;
      const assignedEngine = dispatchPool.length
        ? dispatchPool[batchIndex % dispatchPool.length]
        : null;
      const engineIndex = assignedEngine?.index ?? batchIndex % totalEngines;

      let success = false;
      let retries = 0;
      let lastError = null;
      const startedAt = Date.now();

      while (!success) {
        if (Date.now() - startedAt > MAX_PAGE_WAIT_MS) {
          lastError =
            lastError ||
            `Timed out waiting for available engine after ${Math.ceil(
              MAX_PAGE_WAIT_MS / 1000,
            )}s`;
          break;
        }

        tryRecoverExhaustedKeys();

        // Find an available engine (try assigned first, then any available)
        let useEngineIndex = engineIndex;

        const assignedEngineRef = engines.get(useEngineIndex);
        const assignedStatus = apiKeyStatus.get(assignedEngineRef?.apiKey);

        // If assigned engine is unavailable, find another engine from dispatch pool.
        if (
          !assignedEngineRef ||
          assignedEngineRef.busy ||
          assignedStatus?.status !== "active"
        ) {
          const availableDispatchEngines = getDispatchEngines(true, {
            dispatchMode,
          });
          if (availableDispatchEngines.length > 0) {
            availableDispatchEngines.sort((a, b) => {
              const statusA = apiKeyStatus.get(a.apiKey);
              const statusB = apiKeyStatus.get(b.apiKey);
              return (
                (statusA?.requestCount || 0) - (statusB?.requestCount || 0)
              );
            });
            useEngineIndex = availableDispatchEngines[0].index;
          }
        }

        const engine = engines.get(useEngineIndex);
        if (!engine) {
          const waitMs = getSoonestRecoveryWaitMs(RATE_LIMIT_WAIT);
          console.log(
            `⏳ No engine available, waiting ${Math.ceil(waitMs / 1000)}s...`,
          );
          await staggeredDelay(waitMs + 500);
          continue;
        }

        const keyStatus = apiKeyStatus.get(engine.apiKey);

        if (keyStatus?.status === "exhausted") {
          const activeCount = API_KEYS.filter(
            (key) => apiKeyStatus.get(key)?.status === "active",
          ).length;
          const rateLimitedCount = API_KEYS.filter(
            (key) => apiKeyStatus.get(key)?.status === "rate_limited",
          ).length;

          if (activeCount === 0 && rateLimitedCount === 0) {
            lastError =
              lastError ||
              "All API keys are exhausted. Add more keys or wait for quota reset.";
            break;
          }

          await staggeredDelay(1000);
          continue;
        }

        // Wait if rate limited
        if (keyStatus?.status === "rate_limited" && keyStatus.recoveryTime) {
          const waitTime = Math.max(
            0,
            new Date(keyStatus.recoveryTime) - new Date(),
          );
          if (waitTime > 0) {
            console.log(
              `⏳ Engine ${
                useEngineIndex + 1
              } rate limited, waiting ${Math.ceil(waitTime / 1000)}s...`,
            );
            await staggeredDelay(waitTime + 1000);
            tryRecoverExhaustedKeys();
            continue;
          }
        }

        try {
          console.log(
            `🔧 Engine ${useEngineIndex + 1} → page-${
              pageIndex + 1
            }.pdf (attempt ${retries + 1})`,
          );

          const result = await processWithEngine(useEngineIndex, pagePath);

          console.log(
            `✅ Page ${pageIndex + 1}/${pagePaths.length} DONE by Engine ${
              useEngineIndex + 1
            }`,
          );

          // Notify progress immediately
          if (onProgress) {
            await onProgress({
              type: "page_complete",
              pageIndex: startIndex + pageIndex,
              engineId: result.engineId,
              total: pagePaths.length,
              completed: results.filter((r) => r.success).length + 1,
              result: result,
              pagePath: pagePath,
            });
          }

          return {
            success: true,
            pageIndex: startIndex + pageIndex,
            result,
            pagePath,
          };
        } catch (err) {
          lastError = err.message;

          if (err.message.includes("ENGINE_RATE_LIMITED")) {
            const status = apiKeyStatus.get(engine.apiKey);
            const waitMs = status?.recoveryTime
              ? Math.max(
                  0,
                  new Date(status.recoveryTime).getTime() - Date.now(),
                )
              : RATE_LIMIT_WAIT;
            console.log(
              `⚠️ Engine ${useEngineIndex + 1} rate limited, waiting ${Math.ceil(
                waitMs / 1000,
              )}s...`,
            );
            await staggeredDelay(Math.max(waitMs, 500));
          } else if (err.message.includes("ENGINE_EXHAUSTED")) {
            console.log(
              `❌ Engine ${useEngineIndex + 1} exhausted, trying another...`,
            );
            await staggeredDelay(1000);
          } else {
            retries++;
            console.error(
              `❌ Page ${pageIndex + 1} error: ${err.message.slice(0, 80)}`,
            );

            if (retries >= MAX_RETRIES_PER_PAGE) {
              break;
            }

            await staggeredDelay(3000);
          }
        }
      }

      // Failed after all retries
      console.log(
        `❌ Page ${pageIndex + 1} FAILED: ${lastError || "unknown reason"}`,
      );

      if (onProgress) {
        await onProgress({
          type: "page_error",
          pageIndex: startIndex + pageIndex,
          error: lastError || "Unknown error",
        });
      }

      return {
        success: false,
        pageIndex: startIndex + pageIndex,
        error: lastError || `Failed after ${MAX_RETRIES_PER_PAGE} retries`,
        pagePath,
        canRetryLater: true,
      };
    });

    // Wait for entire batch to complete
    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.success) {
        results.push(result);
      } else {
        errors.push(result);
      }
    }

    // Brief delay between batches to be nice to APIs
    if (batchEnd < pagePaths.length) {
      console.log(
        `⏰ Short delay (${PER_ENGINE_DELAY / 1000}s) before next batch...`,
      );
      await staggeredDelay(PER_ENGINE_DELAY);
    }
  }

  console.log(
    `\n📊 Processing complete: ${results.length} success, ${errors.length} errors`,
  );

  return {
    results,
    errors,
    processedCount: results.length,
    errorCount: errors.length,
    totalCount: pagePaths.length,
    allKeysExhausted: getApiKeyStatuses().allExhausted,
  };
}

/**
 * Classify religion based on names using Gemini API with engine rotation
 */
export async function classifyReligionByNames(
  voters,
  apiKeyFromRequest,
  options = {},
) {
  if (!voters || voters.length === 0) return { religions: [], keyUsed: null };

  let apiKeyToUse = getCurrentApiKey(options);

  if (!apiKeyToUse) {
    apiKeyToUse = apiKeyFromRequest || process.env.GEMINI_API_KEY;
  }

  if (!apiKeyToUse) {
    console.log(
      "No API keys available for religion classification, using 'Other'",
    );
    return { religions: voters.map(() => "Other"), keyUsed: null };
  }

  const namesList = voters
    .map((v, idx) => {
      const names = [v.name, v.relationName].filter(Boolean).join(", ");
      return `${idx + 1}. ${names}`;
    })
    .join("\n");

  const prompt = `You are an expert in Indian names and their religious/cultural origins.
Given the following list of Indian names (person name and their father/mother/husband name), classify each entry's likely religion.

Rules:
- Respond ONLY with a JSON array of strings
- Each element should be one of: "Muslim", "Hindu", "Christian", "Sikh", "Buddhist", "Jain", "Other"
- Base classification on common naming patterns:
  - Muslim names often include: Khan, Ahmed, Mohammad, Ali, Begum, Fatima, Sheikh, Ansari, Siddiqui, etc.
  - Hindu names often include: Sharma, Verma, Kumar, Singh (also Sikh), Devi, Gupta, Patel, Rao, etc.
  - Sikh names often include: Singh, Kaur with Punjabi first names like Gurpreet, Harjit, Manpreet, etc.
  - Christian names often include: John, Joseph, Mary, David, Thomas, George, etc.
- If uncertain, use "Other"
- The array length MUST match the number of entries (${voters.length})

Names to classify:
${namesList}

Respond with ONLY the JSON array, no explanation.`;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
  };

  const maxRetries = Math.max(API_KEYS.length, 3);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const currentUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;

      const res = await fetch(currentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();

        const quotaError = isQuotaExhaustedError(res.status, errorText);
        if (quotaError.permanent) {
          markKeyExhausted(
            apiKeyToUse,
            `Status ${res.status}: ${errorText.slice(0, 200)}`,
          );
          const nextKey = getCurrentApiKey(options);

          if (nextKey && nextKey !== apiKeyToUse) {
            apiKeyToUse = nextKey;
            continue;
          }
        }

        if (quotaError.temporary) {
          markKeyRateLimited(
            apiKeyToUse,
            `Status ${res.status}: ${errorText.slice(0, 200)}`,
            false,
          );
          const nextKey = getCurrentApiKey(options);

          if (nextKey && nextKey !== apiKeyToUse) {
            apiKeyToUse = nextKey;
            continue;
          }
        }

        return { religions: voters.map(() => "Other"), keyUsed: apiKeyToUse };
      }

      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .map((p) => p.text || "")
        .join("")
        .trim();

      const cleaned = text.replace(/```json|```/g, "").trim();
      const religions = JSON.parse(cleaned);

      if (Array.isArray(religions) && religions.length === voters.length) {
        return {
          religions: religions.map((r) => {
            const valid = [
              "Muslim",
              "Hindu",
              "Christian",
              "Sikh",
              "Buddhist",
              "Jain",
              "Other",
            ];
            return valid.includes(r) ? r : "Other";
          }),
          keyUsed: apiKeyToUse,
        };
      }

      return { religions: voters.map(() => "Other"), keyUsed: apiKeyToUse };
    } catch (err) {
      console.error("Religion classification attempt failed:", err.message);
      const nextKey = getCurrentApiKey(options);
      if (nextKey && nextKey !== apiKeyToUse && attempt < maxRetries - 1) {
        apiKeyToUse = nextKey;
        continue;
      }
    }
  }

  return { religions: voters.map(() => "Other"), keyUsed: null };
}

/**
 * Call Gemini API with file for OCR - uses engine rotation
 */
export async function callGeminiWithFile(filePath, apiKeyFromRequest) {
  // Get available engines
  const availableEngines = getAvailableEngines();

  if (availableEngines.length > 0) {
    // Use the first available engine
    try {
      return await processWithEngine(availableEngines[0].index, filePath);
    } catch (err) {
      if (err.message.includes("ENGINE_EXHAUSTED")) {
        // Try other engines
        for (let i = 1; i < availableEngines.length; i++) {
          try {
            return await processWithEngine(availableEngines[i].index, filePath);
          } catch (innerErr) {
            if (!innerErr.message.includes("ENGINE_EXHAUSTED")) {
              throw innerErr;
            }
          }
        }
        // All engines exhausted
        throw new Error(
          "ALL_KEYS_EXHAUSTED: All API engines have been exhausted",
        );
      }
      throw err;
    }
  }

  // Fallback to legacy single-key method
  let apiKeyToUse =
    getCurrentApiKey() || apiKeyFromRequest || process.env.GEMINI_API_KEY;

  if (!apiKeyToUse) {
    throw new Error("ALL_KEYS_EXHAUSTED: All API keys have been exhausted");
  }

  const data = await fs.readFile(filePath);
  const base64 = data.toString("base64");
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeByExt[ext] || "application/octet-stream";

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `You are parsing an Indian voter list page. Return only JSON with fields:
{
  "assembly": "assembly/constituency name",
  "partNumber": "part number",
  "section": "section name/number",
  "boothName": "booth/polling station name if visible at the top of the page, else empty string",
  "voters": [
    {
      "serialNumber": "serial number",
      "voterId": "EPIC number (alphanumeric voter ID like XFB2313997)",
      "name": "voter name",
      "relationType": "father|mother|husband|guardian",
      "relationName": "relation name",
      "houseNumber": "house number",
      "age": "age",
      "gender": "male|female",
      "underAdjudication": "true if this specific voter card has ADJUDICATION watermark/text, else false"
    }
  ]
}
IMPORTANT: "voterId" MUST be the EPIC number (e.g. XFB2313997, ABC1234567) printed below the voter photo. Do NOT use location codes like "WB/01/003/000070". If EPIC number is not readable, return empty string.
Set "underAdjudication" per voter row. Use true only when the adjudication mark/watermark belongs to that voter card; otherwise false.
No prose - ONLY valid JSON.`,
          },
          {
            inline_data: {
              mime_type: mime,
              data: base64,
            },
          },
        ],
      },
    ],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    const quotaError = isQuotaExhaustedError(res.status, errorText);
    if (quotaError.permanent) {
      markKeyExhausted(
        apiKeyToUse,
        `Status ${res.status}: ${errorText.slice(0, 200)}`,
      );
      throw new Error("ALL_KEYS_EXHAUSTED: API key exhausted");
    }
    if (quotaError.temporary) {
      markKeyRateLimited(
        apiKeyToUse,
        `Status ${res.status}: ${errorText.slice(0, 200)}`,
        false,
      );
      throw new Error(
        "ALL_KEYS_RATE_LIMITED: API key temporarily rate limited",
      );
    }
    throw new Error(`Gemini error ${res.status}: ${errorText}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const combinedText = parts
    .map((p) => (p.text ? p.text : ""))
    .join("\n")
    .trim();

  return { text: combinedText, full: json, keyUsed: apiKeyToUse };
}

/**
 * Chat with Gemini for NLP processing
 */
export async function chatWithGemini(message, context = {}) {
  let apiKeyToUse = getCurrentApiKey() || process.env.GEMINI_API_KEY;

  if (!apiKeyToUse) {
    throw new Error("No API keys available for chat");
  }

  const systemPrompt = `You are an intelligent assistant for a Voter List Management System. 
Your role is to understand user queries in natural language and help them navigate the system.

Available actions you can suggest:
1. SEARCH_VOTERS - Search for voters by name, voter ID, assembly, etc.
2. VIEW_SESSIONS - View uploaded PDF sessions
3. VIEW_STATS - View statistics (religion, gender, prints)
4. UPLOAD_PDF - Upload a new voter list PDF
5. VIEW_API_STATUS - Check API key status
6. RESET_API_KEYS - Reset exhausted API keys
7. VIEW_PROFILE - View user profile
8. HELP - Show available commands

When responding:
1. Identify the user's intent
2. Provide helpful information in a structured format
3. Use markdown tables for data when appropriate
4. Be concise but informative
5. If the user wants to perform an action, indicate the ACTION type

Current context:
- User Role: ${context.userRole || "user"}
- Has Admin Access: ${context.isAdmin ? "Yes" : "No"}

Respond in this JSON format:
{
  "intent": "detected intent",
  "action": "ACTION_TYPE or null",
  "actionParams": { params if applicable },
  "response": "Your formatted response with markdown",
  "suggestions": ["list", "of", "suggestions"]
}`;

  const payload = {
    contents: [
      {
        parts: [{ text: systemPrompt }, { text: `User message: ${message}` }],
      },
    ],
  };

  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const quotaError = isQuotaExhaustedError(res.status, errorText);
        if (quotaError.permanent) {
          markKeyExhausted(apiKeyToUse, errorText.slice(0, 200));
          apiKeyToUse = getCurrentApiKey();
          if (apiKeyToUse) continue;
        }
        if (quotaError.temporary) {
          markKeyRateLimited(apiKeyToUse, errorText.slice(0, 200), false);
          apiKeyToUse = getCurrentApiKey();
          if (apiKeyToUse) continue;
        }
        throw new Error(`Chat API error: ${res.status}`);
      }

      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .map((p) => p.text || "")
        .join("")
        .trim();

      // Try to parse as JSON
      try {
        const cleaned = text.replace(/```json|```/g, "").trim();
        return JSON.parse(cleaned);
      } catch {
        // Return as plain response if not JSON
        return {
          intent: "general",
          action: null,
          response: text,
          suggestions: [],
        };
      }
    } catch (err) {
      if (attempt === maxRetries - 1) {
        throw err;
      }
      apiKeyToUse = getCurrentApiKey();
      if (!apiKeyToUse) throw err;
    }
  }
}
