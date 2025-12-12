import fs from "fs/promises";
import path from "path";

const model = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";
const apiKey = process.env.GEMINI_API_KEY;

const mimeByExt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

export async function callGeminiWithFile(filePath) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
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
