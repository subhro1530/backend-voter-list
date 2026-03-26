function cleanJsonText(text) {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/```json|```/g, "").trim();
  return withoutFence;
}

function parseBlocks(text) {
  const normalized = text.replace(/\r/g, "");
  return normalized
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

function pullValue(pattern, source) {
  const match = source.match(pattern);
  return match ? match[1].trim() : "";
}

function parseBooleanish(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (["true", "yes", "y", "1", "under adjudication"].includes(normalized)) {
    return true;
  }

  if (
    ["false", "no", "n", "0", "not under adjudication"].includes(normalized)
  ) {
    return false;
  }

  return null;
}

function detectAdjudicationFromText(value) {
  if (typeof value !== "string") return false;
  return /\badjudication\b/i.test(value);
}

function normalizeVoter(voter) {
  const safeVoter = voter && typeof voter === "object" ? voter : {};

  const explicitFlag =
    parseBooleanish(safeVoter.underAdjudication) ??
    parseBooleanish(safeVoter.under_adjudication) ??
    parseBooleanish(safeVoter.isUnderAdjudication) ??
    parseBooleanish(safeVoter.adjudication);

  if (explicitFlag !== null) {
    return {
      ...safeVoter,
      underAdjudication: explicitFlag,
    };
  }

  const textSignals = [
    safeVoter.adjudicationText,
    safeVoter.status,
    safeVoter.remarks,
    safeVoter.note,
    safeVoter.name,
  ];

  const inferred = textSignals.some(detectAdjudicationFromText);

  return {
    ...safeVoter,
    underAdjudication: inferred,
  };
}

function parseVoterBlock(block) {
  const serial = pullValue(/^\s*(\d+)/m, block);
  const voterId = pullValue(/\b([A-Z0-9/]{5,})\b/, block);
  const name = pullValue(/Name\s*:\s*(.+)/i, block);

  let relationType = "";
  let relationName = "";
  const relation = block.match(/(Fathers|Husbands|Mothers)\s+Name\s*:\s*(.+)/i);
  if (relation) {
    const rel = relation[1].toLowerCase();
    relationType =
      rel === "husbands" ? "husband" : rel === "fathers" ? "father" : "mother";
    relationName = relation[2].trim();
  }

  const houseNumber = pullValue(/House Number\s*:\s*(.+)/i, block)
    .replace(/\s+/g, " ")
    .trim();
  const age = pullValue(/Age\s*:\s*(\d{1,3})/i, block);
  const gender = pullValue(/Gender\s*:\s*([A-Za-z]+)/i, block);
  const underAdjudication = /\badjudication\b/i.test(block);

  return {
    serialNumber: serial,
    voterId,
    name,
    relationType,
    relationName,
    houseNumber,
    age,
    gender,
    underAdjudication,
  };
}

function parseFromPlainText(text) {
  const assembly = pullValue(/Assembly Constituency[^:]*:\s*(.+)/i, text);
  const partNumber = pullValue(/Part No\.?\s*:\s*(.+)/i, text);
  const section = pullValue(/Section[^:]*:\s*(.+)/i, text);
  const boothName = pullValue(/(?:Polling Station|Booth)[^:]*:\s*(.+)/i, text);

  const blocks = parseBlocks(text);
  const voters = blocks
    .map(parseVoterBlock)
    .filter((v) => v.name || v.voterId || v.serialNumber);

  return { assembly, partNumber, section, boothName, voters };
}

export function parseGeminiStructured(text) {
  if (!text)
    return {
      assembly: "",
      partNumber: "",
      section: "",
      boothName: "",
      voters: [],
    };

  const cleaned = cleanJsonText(text);
  try {
    const parsed = JSON.parse(cleaned);
    return {
      assembly: parsed.assembly || parsed.constituency || "",
      partNumber: parsed.partNumber || parsed.part || "",
      section: parsed.section || "",
      boothName:
        parsed.boothName || parsed.booth_name || parsed.pollingStation || "",
      voters: Array.isArray(parsed.voters)
        ? parsed.voters.map(normalizeVoter)
        : [],
    };
  } catch (err) {
    return parseFromPlainText(text);
  }
}
