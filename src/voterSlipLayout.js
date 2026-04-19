import path from "path";
import fs from "fs-extra";

const layoutPath = path.join(
  process.cwd(),
  "storage",
  "voter-slip-layout.json",
);

const REQUIRED_FIELDS = [
  "partNo",
  "serialNumber",
  "name",
  "father",
  "address",
  "sex",
  "age",
  "pollingStation",
];

const ALIGN_VALUES = ["left", "center", "right"];

const DEFAULT_LAYOUT = {
  version: "2026-03-default",
  fields: {
    // Normalized coordinates relative to full slip image dimensions.
    partNo: {
      x: 0.705,
      y: 0.713,
      width: 0.125,
      height: 0.052,
      align: "left",
      maxLines: 1,
      maxFontSize: 24,
      minFontSize: 14,
      paddingX: 0.008,
      paddingY: 0.01,
    },
    serialNumber: {
      x: 0.938,
      y: 0.713,
      width: 0.042,
      height: 0.05,
      align: "center",
      maxLines: 1,
      maxFontSize: 24,
      minFontSize: 14,
      paddingX: 0.002,
      paddingY: 0.01,
    },
    name: {
      x: 0.705,
      y: 0.636,
      width: 0.185,
      height: 0.05,
      align: "left",
      maxLines: 1,
      maxFontSize: 28,
      minFontSize: 16,
      paddingX: 0.008,
      paddingY: 0.01,
    },
    father: {
      x: 0.705,
      y: 0.568,
      width: 0.185,
      height: 0.05,
      align: "left",
      maxLines: 1,
      maxFontSize: 26,
      minFontSize: 15,
      paddingX: 0.008,
      paddingY: 0.01,
    },
    address: {
      x: 0.705,
      y: 0.495,
      width: 0.275,
      height: 0.095,
      align: "left",
      maxLines: 2,
      maxFontSize: 24,
      minFontSize: 14,
      paddingX: 0.008,
      paddingY: 0.012,
    },
    sex: {
      x: 0.962,
      y: 0.636,
      width: 0.018,
      height: 0.048,
      align: "center",
      maxLines: 1,
      maxFontSize: 22,
      minFontSize: 14,
      paddingX: 0.002,
      paddingY: 0.01,
    },
    age: {
      x: 0.962,
      y: 0.568,
      width: 0.018,
      height: 0.048,
      align: "center",
      maxLines: 1,
      maxFontSize: 22,
      minFontSize: 14,
      paddingX: 0.002,
      paddingY: 0.01,
    },
    pollingStation: {
      x: 0.705,
      y: 0.313,
      width: 0.275,
      height: 0.105,
      align: "left",
      maxLines: 2,
      maxFontSize: 24,
      minFontSize: 14,
      paddingX: 0.008,
      paddingY: 0.012,
    },
  },
};

let layoutCachePromise = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidField(field) {
  if (!field || typeof field !== "object") return false;

  const { x, y, width, height, maxLines } = field;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return false;
  }

  if (x < 0 || y < 0 || width <= 0 || height <= 0) return false;
  if (x + width > 1 || y + height > 1) return false;
  if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
    return false;
  }

  return true;
}

function isValidLayout(layout) {
  if (!layout || typeof layout !== "object" || !layout.fields) return false;
  return REQUIRED_FIELDS.every((name) => isValidField(layout.fields[name]));
}

function normalizeFieldWithFallback(inputField, fallbackField) {
  const raw = inputField && typeof inputField === "object" ? inputField : {};

  let width = asNumber(raw.width, fallbackField.width);
  let height = asNumber(raw.height, fallbackField.height);
  width = clamp(width, 0.005, 1);
  height = clamp(height, 0.005, 1);

  let x = asNumber(raw.x, fallbackField.x);
  let y = asNumber(raw.y, fallbackField.y);
  x = clamp(x, 0, 1 - width);
  y = clamp(y, 0, 1 - height);

  const align = ALIGN_VALUES.includes(raw.align)
    ? raw.align
    : fallbackField.align;

  const maxLinesRaw = Number(raw.maxLines);
  const maxLines =
    Number.isInteger(maxLinesRaw) && maxLinesRaw > 0
      ? maxLinesRaw
      : fallbackField.maxLines;

  const maxFontSize = clamp(
    asNumber(raw.maxFontSize, fallbackField.maxFontSize),
    6,
    64,
  );
  const minFontSize = clamp(
    asNumber(raw.minFontSize, fallbackField.minFontSize),
    5,
    maxFontSize,
  );

  const paddingX = clamp(
    asNumber(raw.paddingX, fallbackField.paddingX),
    0,
    0.08,
  );
  const paddingY = clamp(
    asNumber(raw.paddingY, fallbackField.paddingY),
    0,
    0.08,
  );

  return {
    x,
    y,
    width,
    height,
    align,
    maxLines,
    maxFontSize,
    minFontSize,
    paddingX,
    paddingY,
  };
}

function getFieldCenter(field) {
  return {
    x: field.x + field.width / 2,
    y: field.y + field.height / 2,
  };
}

function fieldDistanceScore(box, fallbackField) {
  const a = getFieldCenter(box);
  const b = getFieldCenter(fallbackField);

  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const centerDistance = Math.sqrt(dx * dx + dy * dy);

  const widthDiff = Math.abs(box.width - fallbackField.width);
  const heightDiff = Math.abs(box.height - fallbackField.height);

  // Center position should dominate matching; size is a small tie-breaker.
  return centerDistance + widthDiff * 0.35 + heightDiff * 0.35;
}

function normalizeInputBoxes(boxes, fallback = DEFAULT_LAYOUT) {
  if (!Array.isArray(boxes)) return [];

  return boxes
    .map((box, index) => {
      if (!box || typeof box !== "object") return null;

      const baseFallback = fallback.fields.name;
      const normalized = normalizeFieldWithFallback(box, baseFallback);

      const rawLabel = String(box.label || box.field || box.name || "")
        .trim()
        .toLowerCase();
      const label = REQUIRED_FIELDS.find(
        (field) => field.toLowerCase() === rawLabel,
      );

      return {
        index,
        ...normalized,
        label: label || null,
      };
    })
    .filter(Boolean);
}

export function suggestVoterSlipFieldsFromBoxes(
  boxes,
  fallback = DEFAULT_LAYOUT,
) {
  const normalizedBoxes = normalizeInputBoxes(boxes, fallback);

  const assigned = new Map();
  const usedBoxIndexes = new Set();
  const mapping = [];

  // Pass 1: trust explicit labels if valid.
  normalizedBoxes.forEach((box) => {
    if (!box.label || assigned.has(box.label)) return;
    assigned.set(box.label, box);
    usedBoxIndexes.add(box.index);
    mapping.push({
      boxIndex: box.index,
      field: box.label,
      source: "explicit",
      score: 0,
    });
  });

  // Pass 2: greedy nearest-match for remaining fields.
  const unassignedFields = REQUIRED_FIELDS.filter(
    (field) => !assigned.has(field),
  );
  const freeBoxes = normalizedBoxes.filter(
    (box) => !usedBoxIndexes.has(box.index),
  );

  unassignedFields.forEach((fieldName) => {
    if (!freeBoxes.length) return;

    let bestIdx = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < freeBoxes.length; i += 1) {
      const score = fieldDistanceScore(
        freeBoxes[i],
        fallback.fields[fieldName],
      );
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const selected = freeBoxes.splice(bestIdx, 1)[0];
      assigned.set(fieldName, selected);
      usedBoxIndexes.add(selected.index);
      mapping.push({
        boxIndex: selected.index,
        field: fieldName,
        source: "auto-nearest",
        score: Number(bestScore.toFixed(6)),
      });
    }
  });

  const fields = {};
  REQUIRED_FIELDS.forEach((name) => {
    fields[name] = normalizeFieldWithFallback(
      assigned.get(name),
      fallback.fields[name],
    );
  });

  return {
    fields,
    mapping,
    missingInputCount: Math.max(
      0,
      REQUIRED_FIELDS.length - normalizedBoxes.length,
    ),
  };
}

export function normalizeVoterSlipLayoutFields(
  fields,
  fallback = DEFAULT_LAYOUT,
) {
  const safeFields = {};
  const input = fields && typeof fields === "object" ? fields : {};

  REQUIRED_FIELDS.forEach((name) => {
    safeFields[name] = normalizeFieldWithFallback(
      input[name],
      fallback.fields[name],
    );
  });

  return safeFields;
}

export function buildVoterSlipLayout(fields, options = {}) {
  const fallback = options.fallbackLayout || DEFAULT_LAYOUT;
  const versionPrefix = options.versionPrefix || "manual";
  const version =
    options.version || `${versionPrefix}-${new Date().toISOString()}`;

  return {
    version,
    fields: normalizeVoterSlipLayoutFields(fields, fallback),
  };
}

export function buildVoterSlipLayoutFromBoxes(boxes, options = {}) {
  const fallback = options.fallbackLayout || DEFAULT_LAYOUT;
  const versionPrefix = options.versionPrefix || "manual";
  const version =
    options.version || `${versionPrefix}-${new Date().toISOString()}`;

  const { fields, mapping, missingInputCount } =
    suggestVoterSlipFieldsFromBoxes(boxes, fallback);

  return {
    layout: {
      version,
      fields,
    },
    mapping,
    missingInputCount,
  };
}

export async function saveVoterSlipLayout(layout) {
  await fs.outputJson(layoutPath, layout, { spaces: 2 });
  clearVoterSlipLayoutCache();
  return layout;
}

async function loadLayoutInternal() {
  try {
    const exists = await fs.pathExists(layoutPath);
    if (!exists) return DEFAULT_LAYOUT;

    const raw = await fs.readFile(layoutPath, "utf8");
    const parsed = JSON.parse(raw);

    if (isValidLayout(parsed)) {
      return parsed;
    }

    return DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export async function getVoterSlipLayout() {
  if (!layoutCachePromise) {
    layoutCachePromise = loadLayoutInternal();
  }
  return layoutCachePromise;
}

export function clearVoterSlipLayoutCache() {
  layoutCachePromise = null;
}

export function getVoterSlipLayoutPath() {
  return layoutPath;
}

export function getDefaultVoterSlipLayout() {
  return DEFAULT_LAYOUT;
}

export function getRequiredVoterSlipFields() {
  return [...REQUIRED_FIELDS];
}
