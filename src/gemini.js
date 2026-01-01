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
 * Classify religion based on names using Gemini API
 * @param {Array<{name: string, relationName?: string}>} voters - Array of voter objects with names
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<Array<string>>} - Array of religion classifications
 */
export async function classifyReligionByNames(voters, apiKey) {
  if (!voters || voters.length === 0) return [];

  const apiKeyToUse = apiKey || process.env.GEMINI_API_KEY;
  if (!apiKeyToUse) {
    throw new Error("GEMINI_API_KEY is missing");
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`Gemini religion classification error: ${res.status}`);
      return voters.map(() => "Other");
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
      return religions.map((r) => {
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
      });
    }

    return voters.map(() => "Other");
  } catch (err) {
    console.error("Religion classification failed:", err.message);
    return voters.map(() => "Other");
  }
}

export async function callGeminiWithFile(filePath, apiKeyFromRequest) {
  const apiKey = apiKeyFromRequest || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing (provide in request body as apiKey)"
    );
  }

  const data = await fs.readFile(filePath);
  const base64 = data.toString("base64");
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeByExt[ext] || "application/octet-stream";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const combinedText = parts
    .map((p) => (p.text ? p.text : ""))
    .join("\n")
    .trim();

  return { text: combinedText, full: json };
}
