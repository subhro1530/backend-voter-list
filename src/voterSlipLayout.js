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
      maxFontSize: 20,
      minFontSize: 12,
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
      maxFontSize: 20,
      minFontSize: 12,
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
      maxFontSize: 22,
      minFontSize: 12,
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
      maxFontSize: 20,
      minFontSize: 12,
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
      maxFontSize: 18,
      minFontSize: 10,
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
      maxFontSize: 18,
      minFontSize: 12,
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
      maxFontSize: 18,
      minFontSize: 12,
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
      maxFontSize: 18,
      minFontSize: 11,
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
