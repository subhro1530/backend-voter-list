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

export function normalizeBoothNo(value) {
  if (!value) return "";
  const cleaned = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";

  const match = cleaned.match(/^(\d+)([A-Z]*)$/);
  if (!match) return cleaned;

  const numeric = String(parseInt(match[1], 10));
  const suffix = match[2] || "";
  return `${numeric === "NaN" ? "" : numeric}${suffix}`;
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
