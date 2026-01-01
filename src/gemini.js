import fs from "fs/promises";
import path from "path";

const model = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";

const mimeByExt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

// Hardcoded API keys for fallback
const FALLBACK_API_KEYS = [
  "AIzaSyCCAqGzF27PTQy7rsFyx0tf9aUFyIAFINw",
  "AIzaSyB5pQN6soz5eFXzaR9kfxkLgFqKv8_T884",
  "AIzaSyB8zuU8Ik1Dq_2CjcPq3KyuD46NqjL_Hnk",
  "AIzaSyCDu2hKo8zB3lt5OeZC6ba5mBfe9cw8vDk",
  "AIzaSyD4BOIN08XQbSQaoL1Z2UUUzgMK_u-DcAw",
  "AIzaSyB2RFM5ZzA9WXkyx2ynTMrkqDqxiReV_8E",
  "AIzaSyB2RFM5ZzA9WXkyx2ynTMrkqDqxiReV_8E",
];

// Track API key status - key -> { status: 'active'|'exhausted', exhaustedAt: Date, lastError: string }
const apiKeyStatus = new Map();

// Initialize all keys as active
FALLBACK_API_KEYS.forEach((key) => {
  if (!apiKeyStatus.has(key)) {
    apiKeyStatus.set(key, {
      status: "active",
      exhaustedAt: null,
      lastError: null,
    });
  }
});

// Current active key index
let currentKeyIndex = 0;

/**
 * Check if an error indicates quota exhaustion
 */
function isQuotaExhaustedError(statusCode, errorText) {
  const quotaErrorPatterns = [
    "RESOURCE_EXHAUSTED",
    "quota",
    "rate limit",
    "429",
    "too many requests",
    "exceeded",
    "limit exceeded",
  ];
  const lowerError = (errorText || "").toLowerCase();
  return (
    statusCode === 429 ||
    statusCode === 403 ||
    quotaErrorPatterns.some((pattern) =>
      lowerError.includes(pattern.toLowerCase())
    )
  );
}

/**
 * Mark an API key as exhausted
 */
function markKeyExhausted(apiKey, errorMessage) {
  apiKeyStatus.set(apiKey, {
    status: "exhausted",
    exhaustedAt: new Date().toISOString(),
    lastError: errorMessage,
  });
  console.log(
    `API Key ${apiKey.slice(0, 10)}... marked as EXHAUSTED: ${errorMessage}`
  );
}

/**
 * Get the next available API key
 */
function getNextAvailableKey(excludeKey = null) {
  const availableKeys = FALLBACK_API_KEYS.filter((key) => {
    const status = apiKeyStatus.get(key);
    return status?.status === "active" && key !== excludeKey;
  });

  if (availableKeys.length === 0) {
    return null;
  }

  // Round-robin through available keys
  currentKeyIndex = (currentKeyIndex + 1) % FALLBACK_API_KEYS.length;
  while (
    apiKeyStatus.get(FALLBACK_API_KEYS[currentKeyIndex])?.status !== "active"
  ) {
    currentKeyIndex = (currentKeyIndex + 1) % FALLBACK_API_KEYS.length;
    // Safety check to prevent infinite loop
    if (!availableKeys.includes(FALLBACK_API_KEYS[currentKeyIndex])) {
      return availableKeys[0];
    }
  }

  return FALLBACK_API_KEYS[currentKeyIndex];
}

/**
 * Get the current active API key (first one that's still active)
 */
export function getCurrentApiKey() {
  const activeKey = FALLBACK_API_KEYS.find(
    (key) => apiKeyStatus.get(key)?.status === "active"
  );
  return activeKey || null;
}

/**
 * Get status of all API keys
 */
export function getApiKeyStatuses() {
  const statuses = FALLBACK_API_KEYS.map((key, index) => {
    const status = apiKeyStatus.get(key) || {
      status: "active",
      exhaustedAt: null,
      lastError: null,
    };
    return {
      keyIndex: index + 1,
      keyPreview: `${key.slice(0, 10)}...${key.slice(-4)}`,
      fullKey: key,
      status: status.status,
      exhaustedAt: status.exhaustedAt,
      lastError: status.lastError,
    };
  });

  const activeCount = statuses.filter((s) => s.status === "active").length;
  const exhaustedCount = statuses.filter(
    (s) => s.status === "exhausted"
  ).length;

  return {
    totalKeys: FALLBACK_API_KEYS.length,
    activeKeys: activeCount,
    exhaustedKeys: exhaustedCount,
    allExhausted: activeCount === 0,
    keys: statuses,
  };
}

/**
 * Reset all API keys to active status (useful for daily reset)
 */
export function resetAllApiKeys() {
  FALLBACK_API_KEYS.forEach((key) => {
    apiKeyStatus.set(key, {
      status: "active",
      exhaustedAt: null,
      lastError: null,
    });
  });
  currentKeyIndex = 0;
  console.log("All API keys have been reset to active status");
  return getApiKeyStatuses();
}

/**
 * Classify religion based on names using Gemini API with auto-fallback
 * @param {Array<{name: string, relationName?: string}>} voters - Array of voter objects with names
 * @param {string} apiKey - Gemini API key (optional, will use fallback keys)
 * @returns {Promise<{religions: Array<string>, keyUsed: string}>} - Array of religion classifications and key used
 */
export async function classifyReligionByNames(voters, apiKey) {
  if (!voters || voters.length === 0) return { religions: [], keyUsed: null };

  let apiKeyToUse = apiKey || getCurrentApiKey() || process.env.GEMINI_API_KEY;
  if (!apiKeyToUse) {
    throw new Error("No API keys available - all exhausted");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;

  // Prepare names list for classification
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

  const maxRetries = FALLBACK_API_KEYS.length;
  let lastError = null;

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
            `Status ${res.status}: ${errorText.slice(0, 200)}`
          );
          const nextKey = getNextAvailableKey(apiKeyToUse);

          if (nextKey) {
            console.log(
              `Switching to next API key for religion classification...`
            );
            apiKeyToUse = nextKey;
            continue;
          } else {
            throw new Error("All API keys exhausted");
          }
        }

        console.error(`Gemini religion classification error: ${res.status}`);
        return { religions: voters.map(() => "Other"), keyUsed: apiKeyToUse };
      }

      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .map((p) => p.text || "")
        .join("")
        .trim();

      // Parse the JSON response
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
      lastError = err;
      console.error("Religion classification attempt failed:", err.message);

      // Try next key if available
      const nextKey = getNextAvailableKey(apiKeyToUse);
      if (nextKey && attempt < maxRetries - 1) {
        apiKeyToUse = nextKey;
        continue;
      }
    }
  }

  console.error(
    "All religion classification attempts failed:",
    lastError?.message
  );
  return { religions: voters.map(() => "Other"), keyUsed: null };
}

/**
 * Call Gemini API with file for OCR, with auto-fallback to other API keys
 * @param {string} filePath - Path to the file to process
 * @param {string} apiKeyFromRequest - Optional API key from request
 * @returns {Promise<{text: string, full: object, keyUsed: string}>}
 */
export async function callGeminiWithFile(filePath, apiKeyFromRequest) {
  let apiKeyToUse =
    apiKeyFromRequest || getCurrentApiKey() || process.env.GEMINI_API_KEY;

  if (!apiKeyToUse) {
    const keyStatus = getApiKeyStatuses();
    if (keyStatus.allExhausted) {
      throw new Error(
        "ALL_KEYS_EXHAUSTED: All API keys have been exhausted. Please try again later or reset keys."
      );
    }
    throw new Error(
      "GEMINI_API_KEY is missing (provide in request body as apiKey)"
    );
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
            text: "You are parsing an Indian voter list page. Return only JSON with fields {assembly, partNumber, section, voters:[{serialNumber, voterId, name, relationType (father|mother|husband|guardian), relationName, houseNumber, age, gender}]}. No prose.",
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

  const maxRetries = FALLBACK_API_KEYS.length;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyToUse}`;

      console.log(
        `OCR attempt ${attempt + 1} with key ${apiKeyToUse.slice(0, 10)}...`
      );

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();

        // Check if quota exhausted
        if (isQuotaExhaustedError(res.status, errorText)) {
          markKeyExhausted(
            apiKeyToUse,
            `Status ${res.status}: ${errorText.slice(0, 200)}`
          );

          const nextKey = getNextAvailableKey(apiKeyToUse);
          if (nextKey) {
            console.log(`API key exhausted, switching to next key...`);
            apiKeyToUse = nextKey;
            continue;
          } else {
            throw new Error(
              "ALL_KEYS_EXHAUSTED: All API keys have been exhausted"
            );
          }
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
    } catch (err) {
      lastError = err;

      // If it's a quota error and we handled it, continue to next iteration
      if (err.message.includes("ALL_KEYS_EXHAUSTED")) {
        throw err;
      }

      // For other errors, try to switch key
      if (isQuotaExhaustedError(0, err.message)) {
        markKeyExhausted(apiKeyToUse, err.message.slice(0, 200));
        const nextKey = getNextAvailableKey(apiKeyToUse);
        if (nextKey) {
          console.log(`Error detected, switching to next API key...`);
          apiKeyToUse = nextKey;
          continue;
        }
      }

      // If we still have retries, try with the same or next key
      if (attempt < maxRetries - 1) {
        const nextKey = getNextAvailableKey(apiKeyToUse);
        if (nextKey) {
          apiKeyToUse = nextKey;
          continue;
        }
      }
    }
  }

  throw lastError || new Error("All Gemini API attempts failed");
}
