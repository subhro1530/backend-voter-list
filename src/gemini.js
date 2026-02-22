import fs from "fs/promises";
import path from "path";

const model = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";

const mimeByExt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

/**
 * Load API keys from environment variables.
 * Dynamically detects all GEMINI_API_KEY_* variables
 * Also checks legacy GEMINI_API_KEY as a fallback
 */
function loadApiKeysFromEnv() {
  const keys = [];
  const seen = new Set();

  // Dynamically find all GEMINI_API_KEY_* environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GEMINI_API_KEY_") && value && value.trim()) {
      const trimmedValue = value.trim();
      if (!seen.has(trimmedValue)) {
        keys.push(trimmedValue);
        seen.add(trimmedValue);
      }
    }
  }

  // Also check legacy single key if no numbered keys found
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    const legacyKey = process.env.GEMINI_API_KEY.trim();
    if (!seen.has(legacyKey)) {
      keys.push(legacyKey);
    }
  }

  console.log(
    `🔑 Loaded ${keys.length} unique Gemini API keys from environment`,
  );
  return keys;
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
  API_KEYS = loadApiKeysFromEnv();
  apiKeyStatus.clear();
  engines.clear();

  API_KEYS.forEach((key, index) => {
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
      busy: false,
      processing: null,
      totalProcessed: 0,
    });
  });

  console.log(
    `🚀 Initialized ${API_KEYS.length} API engines for parallel processing`,
  );
  return API_KEYS.length;
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

/**
 * Mark an API key as rate limited (temporary) or exhausted (permanent)
 */
function markKeyRateLimited(apiKey, errorMessage, isPermanent = false) {
  const status = apiKeyStatus.get(apiKey);
  if (status) {
    if (isPermanent) {
      // Permanent exhaustion - don't auto-recover
      apiKeyStatus.set(apiKey, {
        ...status,
        status: "exhausted",
        exhaustedAt: new Date().toISOString(),
        lastError: errorMessage,
        recoveryTime: null, // Manual reset required
        failureCount: (status.failureCount || 0) + 1,
      });
      console.log(
        `❌ API Key ${apiKey.slice(
          0,
          10,
        )}... PERMANENTLY EXHAUSTED (daily quota reached)`,
      );
    } else {
      // Temporary rate limit - recover after 15 seconds (shorter for different projects)
      const recoveryTime = new Date(Date.now() + 15000).toISOString();
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
        )}... rate limited (will retry after 15s)`,
      );
    }
  }
}

// Keep the old function name for backward compatibility
function markKeyExhausted(apiKey, errorMessage) {
  markKeyRateLimited(apiKey, errorMessage, true);
}

/**
 * Try to recover rate-limited keys after their recovery time
 */
function tryRecoverExhaustedKeys() {
  const now = new Date();
  let recoveredCount = 0;

  API_KEYS.forEach((key) => {
    const status = apiKeyStatus.get(key);
    // Recover rate_limited keys (temporary) after their recovery time
    if (status?.status === "rate_limited" && status.recoveryTime) {
      const recoveryTime = new Date(status.recoveryTime);
      if (now >= recoveryTime) {
        apiKeyStatus.set(key, {
          ...status,
          status: "active",
          lastError: null,
          recoveryTime: null,
        });
        console.log(
          `✅ API Key ${key.slice(0, 10)}... recovered from rate limit`,
        );
        recoveredCount++;
      }
    }
    // Note: "exhausted" keys (permanent) don't auto-recover
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
export function getAvailableEngines() {
  tryRecoverExhaustedKeys();

  const available = [];
  engines.forEach((engine, index) => {
    const keyStatus = apiKeyStatus.get(engine.apiKey);
    // Active status means ready to use
    if (keyStatus?.status === "active" && !engine.busy) {
      available.push({ ...engine, index });
    }
  });
  return available;
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
  tryRecoverExhaustedKeys();

  const available = [];
  engines.forEach((engine, index) => {
    const keyStatus = apiKeyStatus.get(engine.apiKey);
    if (keyStatus?.status === "active" && !engine.busy) {
      available.push({ ...engine, index });
    }
  });

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

/**
 * Get the current active API key (first one that's still active)
 */
export function getCurrentApiKey() {
  if (API_KEYS.length === 0) {
    initializeKeyStatus();
  }

  tryRecoverExhaustedKeys();

  const activeKey = API_KEYS.find(
    (key) => apiKeyStatus.get(key)?.status === "active",
  );
  return activeKey || null;
}

/**
 * Get status of all API keys with enhanced metrics
 */
export function getApiKeyStatuses() {
  if (API_KEYS.length === 0) {
    initializeKeyStatus();
  }

  tryRecoverExhaustedKeys();

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

  return {
    totalEngines: API_KEYS.length,
    activeEngines: activeCount,
    rateLimitedEngines: rateLimitedCount,
    exhaustedEngines: exhaustedCount,
    busyEngines: busyCount,
    availableEngines: activeCount - busyCount,
    allExhausted: activeCount === 0 && rateLimitedCount === 0, // Only exhausted when no active and no rate-limited
    engines: statuses,
  };
}

/**
 * Reset all API keys to active status (useful for daily reset)
 */
export function resetAllApiKeys() {
  initializeKeyStatus();
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
      "hasPhoto": true or false (whether this voter entry has a photograph/image visible)
    }
  ]
}

IMPORTANT:
1. For each voter, check if there is a passport-size photograph/image next to their details. Set "hasPhoto" to true if yes, false if no photo is visible.
2. The "boothName" is typically the name of the building/location used as the polling booth, often found near the top of the first page after "Part No." section.
3. "voterId" MUST be the EPIC number (e.g. XFB2313997, ABC1234567). It is printed below or near the voter's photo. Do NOT use location codes like "WB/01/003/000070" — those are NOT voter IDs. If the EPIC number is not clearly readable, return an empty string "".
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
) {
  const results = [];
  const errors = [];

  // FAST processing - each key is from a different project with independent limits
  // 2-3 seconds between requests PER ENGINE is enough with different projects
  const PER_ENGINE_DELAY = parseInt(process.env.GEMINI_PAGE_DELAY_MS) || 2000; // 2 seconds per engine
  const RATE_LIMIT_WAIT = 15000; // 15 seconds when rate limited (shorter since different projects)
  const MAX_RETRIES_PER_PAGE = 5;

  // Get number of available engines
  const totalEngines = engines.size;
  console.log(
    `🚀 Starting PARALLEL processing of ${pagePaths.length} pages with ${totalEngines} engines...`,
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
      const engineIndex = batchIndex % totalEngines;

      let success = false;
      let retries = 0;
      let lastError = null;

      while (!success && retries < MAX_RETRIES_PER_PAGE) {
        tryRecoverExhaustedKeys();

        // Find an available engine (try assigned first, then any available)
        let useEngineIndex = engineIndex;
        const assignedStatus = apiKeyStatus.get(
          engines.get(useEngineIndex)?.apiKey,
        );

        // If assigned engine is exhausted, find another
        if (assignedStatus?.status === "exhausted") {
          for (let e = 0; e < totalEngines; e++) {
            const status = apiKeyStatus.get(engines.get(e)?.apiKey);
            if (status?.status === "active") {
              useEngineIndex = e;
              break;
            }
          }
        }

        const engine = engines.get(useEngineIndex);
        if (!engine) {
          retries++;
          continue;
        }

        const keyStatus = apiKeyStatus.get(engine.apiKey);

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
            await staggeredDelay(waitTime + 2000);
            tryRecoverExhaustedKeys();
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
          retries++;

          if (err.message.includes("ENGINE_RATE_LIMITED")) {
            console.log(
              `⚠️ Engine ${useEngineIndex + 1} rate limited, waiting ${
                RATE_LIMIT_WAIT / 1000
              }s...`,
            );
            await staggeredDelay(RATE_LIMIT_WAIT);
          } else if (err.message.includes("ENGINE_EXHAUSTED")) {
            console.log(
              `❌ Engine ${useEngineIndex + 1} exhausted, trying another...`,
            );
            await staggeredDelay(1000);
          } else {
            console.error(
              `❌ Page ${pageIndex + 1} error: ${err.message.slice(0, 80)}`,
            );
            await staggeredDelay(3000);
          }
        }
      }

      // Failed after all retries
      console.log(
        `❌ Page ${pageIndex + 1} FAILED after ${MAX_RETRIES_PER_PAGE} attempts`,
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
export async function classifyReligionByNames(voters, apiKeyFromRequest) {
  if (!voters || voters.length === 0) return { religions: [], keyUsed: null };

  let apiKeyToUse = getCurrentApiKey();

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

        if (isQuotaExhaustedError(res.status, errorText)) {
          markKeyExhausted(
            apiKeyToUse,
            `Status ${res.status}: ${errorText.slice(0, 200)}`,
          );
          const nextKey = getCurrentApiKey();

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
      const nextKey = getCurrentApiKey();
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
      "hasPhoto": true or false
    }
  ]
}
IMPORTANT: "voterId" MUST be the EPIC number (e.g. XFB2313997, ABC1234567) printed below the voter photo. Do NOT use location codes like "WB/01/003/000070". If EPIC number is not readable, return empty string.
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
    if (isQuotaExhaustedError(res.status, errorText)) {
      markKeyExhausted(
        apiKeyToUse,
        `Status ${res.status}: ${errorText.slice(0, 200)}`,
      );
      throw new Error("ALL_KEYS_EXHAUSTED: API key exhausted");
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
        if (isQuotaExhaustedError(res.status, errorText)) {
          markKeyExhausted(apiKeyToUse, errorText.slice(0, 200));
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
