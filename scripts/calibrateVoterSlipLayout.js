import "dotenv/config";
import fs from "fs-extra";
import {
  getVoterSlipLayoutPath,
  getDefaultVoterSlipLayout,
} from "../src/voterSlipLayout.js";
import {
  getConfiguredVoterSlipTemplatePath,
  getVoterSlipTemplatePublicHint,
} from "../src/voterSlipTemplate.js";

const model = process.env.GEMINI_MODEL || "gemini-2.0-pro-exp";
const templatePath = getConfiguredVoterSlipTemplatePath();

function getGeminiKey() {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GEMINI_API_KEY_") && v && v.trim()) {
      return v.trim();
    }
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }

  return null;
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Gemini response did not contain JSON object");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateField(field) {
  if (!field || typeof field !== "object") return false;
  if (
    typeof field.x !== "number" ||
    typeof field.y !== "number" ||
    typeof field.width !== "number" ||
    typeof field.height !== "number"
  ) {
    return false;
  }

  if (field.x < 0 || field.y < 0 || field.width <= 0 || field.height <= 0) {
    return false;
  }

  if (field.x + field.width > 1 || field.y + field.height > 1) return false;

  return true;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isNearFallback(candidate, fallback) {
  const dx = Math.abs(candidate.x - fallback.x);
  const dy = Math.abs(candidate.y - fallback.y);
  const dw = Math.abs(candidate.width - fallback.width);
  const dh = Math.abs(candidate.height - fallback.height);
  // Reject wild jumps: they are almost always OCR hallucinations.
  return dx <= 0.22 && dy <= 0.22 && dw <= 0.2 && dh <= 0.2;
}

function sanitizeCandidateField(name, candidate, fallback) {
  if (!validateField(candidate)) return fallback;

  // All values are on the right half of this template. Left-half outputs are wrong.
  if (candidate.x < 0.5) return fallback;

  if (!isNearFallback(candidate, fallback)) return fallback;

  const x = clamp(
    candidate.x,
    Math.max(0.5, fallback.x - 0.08),
    fallback.x + 0.08,
  );
  const y = clamp(
    candidate.y,
    Math.max(0, fallback.y - 0.08),
    Math.min(1, fallback.y + 0.08),
  );
  const width = clamp(
    candidate.width,
    Math.max(0.03, fallback.width - 0.08),
    fallback.width + 0.08,
  );
  const height = clamp(
    candidate.height,
    Math.max(0.03, fallback.height - 0.05),
    fallback.height + 0.05,
  );

  // Ensure the clamped box is still inside normalized bounds.
  const safe = {
    ...candidate,
    x: clamp(x, 0, 1 - width),
    y: clamp(y, 0, 1 - height),
    width,
    height,
  };

  if (!validateField(safe)) return fallback;

  // Keep semantic constraints for known tight fields.
  if (name === "serialNumber") {
    if (safe.x < 0.9 || safe.width > 0.055) return fallback;
  }
  if (name === "sex" || name === "age") {
    if (safe.x < 0.94 || safe.width > 0.03) return fallback;
  }

  return safe;
}

function normalizeField(field, fallback) {
  const align = ["left", "center", "right"].includes(field.align)
    ? field.align
    : fallback.align || "left";

  return {
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    align,
    maxLines:
      Number.isInteger(field.maxLines) && field.maxLines > 0
        ? field.maxLines
        : fallback.maxLines,
    maxFontSize:
      typeof field.maxFontSize === "number"
        ? field.maxFontSize
        : fallback.maxFontSize,
    minFontSize:
      typeof field.minFontSize === "number"
        ? field.minFontSize
        : fallback.minFontSize,
    paddingX:
      typeof field.paddingX === "number" ? field.paddingX : fallback.paddingX,
    paddingY:
      typeof field.paddingY === "number" ? field.paddingY : fallback.paddingY,
  };
}

async function callGeminiForLayout(base64, apiKey) {
  const prompt = `You are calibrating text positions for a voter slip template image.

Return STRICT JSON only in this exact format:
{
  "fields": {
    "partNo": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 1 },
    "serialNumber": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "center", "maxLines": 1 },
    "name": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 1 },
    "father": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 1 },
    "address": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 2 },
    "sex": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 1 },
    "age": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 1 },
    "pollingStation": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "align": "left", "maxLines": 2 }
  }
}

Coordinates must be normalized 0..1 relative to the full image.
Coordinate system must be BOTTOM-LEFT origin (x to right, y upward), matching PDF coordinate systems.

Critical constraints:
- Every value field is in the RIGHT half of the card (x must be >= 0.50).
- Never return any field from the left photo/candidate area.
- Keep boxes tight around writable value zones only.

Map value zones to the right half labels:
- partNo -> value area after "Part:"
- serialNumber -> small top-right box
- name -> value area after "Name:"
- father -> value area after "Father:"
- address -> value area after "Address:"
- sex -> value area after "Sex:"
- age -> value area after "Age:"
- pollingStation -> value area after "Polling Station:"

Important:
- Keep each field area inside lines/boxes and avoid overlap.
- Do not include explanation text.`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/png",
              data: base64,
            },
          },
        ],
      },
    ],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini error ${response.status}: ${errText}`);
  }

  const json = await response.json();
  const text = (json?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  return extractJson(text);
}

function looksLikeTopLeftCoordinates(fields) {
  // In this template, partNo should be above pollingStation in bottom-left coordinates.
  if (!fields?.partNo || !fields?.pollingStation) return false;
  return fields.partNo.y < fields.pollingStation.y;
}

function convertTopLeftToBottomLeft(field) {
  return {
    ...field,
    y: 1 - (field.y + field.height),
  };
}

async function main() {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error("No Gemini API key found in environment");
  }

  const exists = await fs.pathExists(templatePath);
  if (!exists) {
    throw new Error(`Template not found: ${getVoterSlipTemplatePublicHint()}`);
  }

  const img = await fs.readFile(templatePath);
  const base64 = img.toString("base64");
  const result = await callGeminiForLayout(base64, apiKey);

  const fallback = getDefaultVoterSlipLayout();
  const output = {
    version: `gemini-calibrated-${new Date().toISOString()}`,
    fields: {},
  };

  const rawFields = result?.fields || {};
  const useTopLeftFix = looksLikeTopLeftCoordinates(rawFields);

  for (const [name, fallbackField] of Object.entries(fallback.fields)) {
    const candidateRaw = rawFields[name];
    const converted = useTopLeftFix
      ? convertTopLeftToBottomLeft(candidateRaw || {})
      : candidateRaw;
    const safeCandidate = sanitizeCandidateField(
      name,
      converted || {},
      fallbackField,
    );
    output.fields[name] = normalizeField(safeCandidate, fallbackField);
  }

  const outputPath = getVoterSlipLayoutPath();
  await fs.outputJson(outputPath, output, { spaces: 2 });
  console.log(`Calibrated voter slip layout saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
