const ASSEMBLY_STOPWORDS = new Set([
  "ASSEMBLY",
  "CONSTITUENCY",
  "SEGMENT",
  "ELECTION",
  "VIDHAN",
  "SABHA",
  "TO",
  "THE",
  "OF",
  "NAME",
]);

const BENGALI_DIGITS_MAP = {
  "০": "0",
  "১": "1",
  "২": "2",
  "৩": "3",
  "৪": "4",
  "৫": "5",
  "৬": "6",
  "৭": "7",
  "৮": "8",
  "৯": "9",
};

function toAsciiDigits(value) {
  return String(value || "")
    .split("")
    .map((ch) => BENGALI_DIGITS_MAP[ch] || ch)
    .join("");
}

function stripExtension(filename) {
  return String(filename || "").replace(/\.[^.]+$/, "");
}

function stripLooseTokens(text, tokens) {
  let output = String(text || "");
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "giu");
    output = output.replace(pattern, " ");
  }
  return output;
}

export function normalizeBoothNo(value) {
  if (!value) return "";
  const upper = toAsciiDigits(value).toUpperCase();

  // Prefer extracting a booth token from mixed text like "Booth 7" or "Part-45A".
  const tokenMatch = upper.match(
    /(?:^|[^A-Z0-9])(\d{1,4})([A-Z]?)(?:[^A-Z0-9]|$)/,
  );
  if (tokenMatch) {
    const numeric = String(parseInt(tokenMatch[1], 10));
    const suffix = tokenMatch[2] || "";
    return `${numeric === "NaN" ? "" : numeric}${suffix}`;
  }

  const cleaned = upper.replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";

  const match = cleaned.match(/^(\d+)([A-Z]*)$/);
  if (!match) return cleaned;

  const numeric = String(parseInt(match[1], 10));
  const suffix = match[2] || "";
  return `${numeric === "NaN" ? "" : numeric}${suffix}`;
}

export function extractBoothNoFromFilename(filename) {
  const text = toAsciiDigits(stripExtension(filename)).trim();
  if (!text) return "";

  const normalizedText = text.replace(/[_-]+/g, " ");

  // Prefer explicit booth/part markers in renamed filenames.
  const explicitPatterns = [
    /\b(?:booth|part|ps|polling\s*station)\s*(?:no|number)?\s*[:#-]?\s*(\d{1,4}[A-Z]?)\b/i,
    /\b(?:বুথ|পার্ট)\s*(?:নং|নম্বর)?\s*[:#-]?\s*(\d{1,4}[A-Z]?)\b/i,
    /\b(?:no|number)\s*[:#-]?\s*(\d{1,4}[A-Z]?)\b/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalizedText.match(pattern);
    if (match?.[1]) {
      return normalizeBoothNo(match[1]);
    }
  }

  // Fallback: use first small numeric token if no explicit marker was found.
  const fallback = normalizedText.match(/\b(\d{1,4}[A-Z]?)\b/i);
  if (!fallback?.[1]) return "";

  return normalizeBoothNo(fallback[1]);
}

export function extractAssemblyNameFromFilename(filename) {
  const raw = toAsciiDigits(stripExtension(filename));
  if (!raw) return "";

  let text = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  const boothTokenPatterns = [
    /\b(?:booth|part|ps|polling\s*station)\s*(?:no|number)?\s*[:#-]?\s*\d{1,4}[A-Z]?\b/gi,
    /\b(?:বুথ|পার্ট)\s*(?:নং|নম্বর)?\s*[:#-]?\s*\d{1,4}[A-Z]?\b/gi,
  ];
  for (const pattern of boothTokenPatterns) {
    text = text.replace(pattern, " ");
  }

  text = stripLooseTokens(text, ["বুথ", "পার্ট", "নং", "নম্বর"]);

  text = text
    .replace(/\b\d{1,4}[A-Z]?\b/g, " ")
    .replace(/\b(?:final|revised|roll|revision|voter|list|pdf)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

export function canonicalizeAssemblyName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let ascii = toAsciiDigits(raw)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:booth|part|no|number|ps)\b/g, " ")
    .replace(/\b\d{1,4}[a-z]?\b/g, " ")
    .replace(/[^\p{L}\p{M}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  ascii = stripLooseTokens(ascii, ["বুথ", "পার্ট", "নং", "নম্বর"])
    .replace(/\s+/g, " ")
    .trim();

  return ascii;
}

export function normalizeAssemblyName(value) {
  if (!value) return "";
  const tokens = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !ASSEMBLY_STOPWORDS.has(token));

  return tokens.join(" ").trim();
}

export function assemblyLooksRelated(a, b) {
  const left = normalizeAssemblyName(a);
  const right = normalizeAssemblyName(b);
  if (!left || !right) return false;

  if (left === right) return true;

  if (left.includes(right) || right.includes(left)) return true;

  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap >= Math.min(2, Math.min(leftTokens.size, rightTokens.size));
}

export function autoSessionName(
  assemblyName,
  boothNo,
  fallbackName = "Session",
) {
  const parts = [];

  if (assemblyName) {
    parts.push(String(assemblyName).trim().replace(/\s+/g, " "));
  }
  if (boothNo) {
    parts.push(`Booth ${boothNo}`);
  }

  if (parts.length === 0) return fallbackName;
  return parts.join(" - ");
}

export function extractElectionYear(...texts) {
  for (const text of texts) {
    if (!text) continue;
    const match = String(text).match(/\b(19\d{2}|20\d{2})\b/);
    if (match) {
      const year = Number(match[1]);
      if (year >= 1950 && year <= 2100) return year;
    }
  }
  return null;
}
