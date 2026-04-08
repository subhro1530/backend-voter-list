/**
 * Affidavit DOCX Template Filler
 *
 * Fills the original "AFFIDAVIT FORMAT WORD.docx" template with OCR-extracted data.
 * Preserves ALL original formatting, borders, fonts, tables, and layout.
 *
 * Strategy:
 *   1. Read the template DOCX (which is a ZIP containing XML)
 *   2. Parse OCR data fields
 *   3. Replace ellipsis/dot placeholders in document.xml with extracted values
 *   4. Fill empty table cells with extracted table data
 *   5. Return modified DOCX as Buffer
 */

import AdmZip from "adm-zip";
import path from "path";

const TEMPLATE_PATH = path.join(process.cwd(), "AFFIDAVIT FORMAT WORD.docx");

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Replace a text pattern inside <w:t> tags in the XML.
 * Works by finding the pattern in the raw XML string.
 */
function replaceInXml(xml, searchText, replacement) {
  // The search text may appear directly in <w:t> tags
  // We need to handle the case where it might span multiple runs
  // But first try simple replacement within a single <w:t>
  if (xml.includes(searchText)) {
    return xml.replace(searchText, replacement);
  }
  return xml;
}

/**
 * Replace ellipsis/dot patterns between context markers.
 * contextBefore and contextAfter identify the specific field.
 * The dots/ellipsis between them get replaced with the value.
 * Handles dots spanning multiple XML runs and optional whitespace.
 */
function replaceDotsBetween(
  xml,
  contextBefore,
  contextAfter,
  value,
  removeAfter = false,
) {
  if (!value) return xml;

  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAfter = contextAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shouldBoundBefore = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/.test(contextBefore);
  const shouldBoundAfter = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/.test(contextAfter);
  const beforeToken = shouldBoundBefore ? `\\b${escBefore}\\b` : escBefore;
  const afterToken = shouldBoundAfter ? `\\b${escAfter}\\b` : escAfter;

  // Dot characters: … (U+2026) and . (period)
  const dotChars = `[…\\.]+`;
  // XML structure that may appear between dot runs (run boundaries + proofErr tags)
  const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;

  const pattern = new RegExp(
    `(${beforeToken})(?:${xmlGap})?((?:${dotChars}${xmlGap})*${dotChars})(?:${xmlGap})?\\s*(${afterToken})`,
    "s",
  );

  const match = xml.match(pattern);
  if (match) {
    const afterText = removeAfter ? "" : match[3];
    // Check if the dots section contains XML tags (cross-run)
    if (match[2].includes("</w:t>")) {
      // Cross-run: put value in first text run, blank out dots in subsequent runs
      let dotsSection = match[2];
      let firstRun = true;
      dotsSection = dotsSection.replace(
        /(<w:t[^>]*>)?([…\\.]+)(<\/w:t>)?/g,
        (m, openTag, dots, closeTag) => {
          if (firstRun) {
            firstRun = false;
            return (
              (openTag
                ? openTag
                    .replace(/>$/, ' xml:space="preserve">')
                    .replace(
                      / xml:space="preserve" xml:space="preserve"/,
                      ' xml:space="preserve"',
                    )
                : "") +
              " " +
              escapeXml(value) +
              (closeTag || "")
            );
          }
          return (openTag || "") + (closeTag || "");
        },
      );
      return xml.replace(
        match[0],
        match[1] + dotsSection + (afterText ? " " + afterText : ""),
      );
    }
    // Same-run: simple replacement
    if (removeAfter) {
      return xml.replace(pattern, `$1 ${escapeXml(value)}`);
    }
    return xml.replace(pattern, `$1 ${escapeXml(value)} $3`);
  }
  return xml;
}

/**
 * Replace dashes between context markers (e.g., "set up by-----")
 */
function replaceDashesBetween(xml, contextBefore, contextAfter, value) {
  if (!value) return xml;
  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAfter = contextAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${escBefore})(-{3,})(${escAfter})`, "s");
  if (xml.match(pattern)) {
    return xml.replace(pattern, `$1 ${escapeXml(value)} $3`);
  }
  return xml;
}

/**
 * Find all table positions in the XML and return their start/end indices.
 */
function findTables(xml) {
  const tables = [];
  let pos = 0;
  while ((pos = xml.indexOf("<w:tbl>", pos)) !== -1) {
    const end = xml.indexOf("</w:tbl>", pos);
    if (end === -1) break;
    tables.push({ start: pos, end: end + 8 });
    pos = end + 8;
  }
  return tables;
}

/**
 * Extract text content from an XML fragment (strip all tags).
 */
function extractText(xmlFragment) {
  const raw = xmlFragment.replace(/<[^>]+>/g, "").trim();
  // Treat cells containing only dots, ellipsis, dashes or whitespace as empty
  if (/^[….\-\s]*$/.test(raw)) return "";
  return raw;
}

/**
 * Find all rows in a table XML fragment.
 * Returns array of { start, end, xml, cells: [{start, end, xml, text}] }
 */
function parseTableRows(tableXml) {
  const rows = [];
  let pos = 0;
  while (true) {
    const trStart = tableXml.indexOf("<w:tr ", pos);
    const trStartAlt = tableXml.indexOf("<w:tr>", pos);
    const startPos =
      trStart === -1 && trStartAlt === -1
        ? -1
        : trStart === -1
          ? trStartAlt
          : trStartAlt === -1
            ? trStart
            : Math.min(trStart, trStartAlt);

    if (startPos === -1) break;

    const trEnd = tableXml.indexOf("</w:tr>", startPos);
    if (trEnd === -1) break;

    const rowXml = tableXml.substring(startPos, trEnd + 7);
    const cells = parseTableCells(rowXml);
    rows.push({
      start: startPos,
      end: trEnd + 7,
      xml: rowXml,
      cells,
    });
    pos = trEnd + 7;
  }
  return rows;
}

/**
 * Find all cells in a row XML fragment.
 */
function parseTableCells(rowXml) {
  const cells = [];
  let pos = 0;
  while (true) {
    const tcStart = rowXml.indexOf("<w:tc>", pos);
    const tcStartAlt = rowXml.indexOf("<w:tc ", pos);
    const startPos =
      tcStart === -1 && tcStartAlt === -1
        ? -1
        : tcStart === -1
          ? tcStartAlt
          : tcStartAlt === -1
            ? tcStart
            : Math.min(tcStart, tcStartAlt);

    if (startPos === -1) break;

    const tcEnd = findMatchingClose(rowXml, startPos, "w:tc");
    if (tcEnd === -1) break;

    const cellXml = rowXml.substring(startPos, tcEnd + 7);
    cells.push({
      start: startPos,
      end: tcEnd + 7,
      xml: cellXml,
      text: extractText(cellXml),
    });
    pos = tcEnd + 7;
  }
  return cells;
}

/**
 * Find the matching closing tag for a nested XML element.
 */
function findMatchingClose(xml, startPos, tagName) {
  const openTag1 = `<${tagName}>`;
  const openTag2 = `<${tagName} `;
  const closeTag = `</${tagName}>`;
  let depth = 0;
  let pos = startPos;

  while (pos < xml.length) {
    const nextOpen1 = xml.indexOf(openTag1, pos + 1);
    const nextOpen2 = xml.indexOf(openTag2, pos + 1);
    const nextOpen =
      nextOpen1 === -1 && nextOpen2 === -1
        ? -1
        : nextOpen1 === -1
          ? nextOpen2
          : nextOpen2 === -1
            ? nextOpen1
            : Math.min(nextOpen1, nextOpen2);
    const nextClose = xml.indexOf(closeTag, pos + 1);

    if (nextClose === -1) return -1;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 1;
    } else {
      if (depth === 0) return nextClose;
      depth--;
      pos = nextClose + 1;
    }
  }
  return -1;
}

/**
 * Set text content of a table cell.
 * Finds the first <w:t> in the cell and sets its content,
 * or creates one if the cell is empty.
 */
function setCellText(cellXml, value) {
  if (!value && value !== 0) return cellXml;
  const strValue = String(value);

  // Find existing <w:t> tag
  const tMatch = cellXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
  if (tMatch) {
    // Replace the first <w:t> content (even if it has dots/ellipsis)
    return cellXml.replace(
      tMatch[0],
      `<w:t xml:space="preserve">${escapeXml(strValue)}</w:t>`,
    );
  }

  // If no <w:t> found, find a <w:p> and insert a run with text
  const pMatch = cellXml.match(/<w:p[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?/);
  if (pMatch) {
    const insertPos = cellXml.indexOf(pMatch[0]) + pMatch[0].length;
    const textRun = `<w:r><w:t xml:space="preserve">${escapeXml(strValue)}</w:t></w:r>`;
    return (
      cellXml.substring(0, insertPos) + textRun + cellXml.substring(insertPos)
    );
  }

  return cellXml;
}

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Replace trailing dot patterns after a context marker (no contextAfter needed).
 */
function replaceDotsAfter(xml, contextBefore, value) {
  if (!value) return xml;

  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shouldBoundBefore = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/.test(contextBefore);
  const beforeToken = shouldBoundBefore ? `\\b${escBefore}\\b` : escBefore;
  const dotChars = `[…\\.]+`;
  const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;

  const pattern = new RegExp(
    `(${beforeToken})(?:${xmlGap})?((?:${dotChars}${xmlGap})*${dotChars})`,
    "s",
  );

  const match = xml.match(pattern);
  if (match) {
    if (match[2].includes("</w:t>")) {
      let dotsSection = match[2];
      let firstRun = true;
      dotsSection = dotsSection.replace(
        /(<w:t[^>]*>)?([…\\.]+)(<\/w:t>)?/g,
        (m, openTag, dots, closeTag) => {
          if (firstRun) {
            firstRun = false;
            return (
              (openTag
                ? openTag
                    .replace(/>$/, ' xml:space="preserve">')
                    .replace(
                      / xml:space="preserve" xml:space="preserve"/,
                      ' xml:space="preserve"',
                    )
                : "") +
              " " +
              escapeXml(value) +
              (closeTag || "")
            );
          }
          return (openTag || "") + (closeTag || "");
        },
      );
      return xml.replace(match[0], match[1] + dotsSection);
    }
    return xml.replace(match[0], `${match[1]} ${escapeXml(value)}`);
  }
  return xml;
}

function replaceSegmentBetween(xml, contextBefore, contextAfter, value) {
  if (!value) return xml;

  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAfter = contextAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${escBefore})([\\s\\S]*?)(${escAfter})`, "i");

  if (!pattern.test(xml)) return xml;
  return xml.replace(pattern, `$1 ${escapeXml(value)} $3`);
}

function replaceFirstDotRunInXml(fragment, value) {
  if (!value) return fragment;
  let replaced = false;

  let updated = fragment.replace(
    /(<w:t[^>]*>)([…\.]{4,})(<\/w:t>)/g,
    (m, a, b, c) => {
      if (replaced) return m;
      replaced = true;
      return `${a}${escapeXml(value)}${c}`;
    },
  );

  if (replaced) return updated;

  updated = updated.replace(
    /<w:t([^>]*)>([^<]*?)([…\.]{4,})([^<]*?)<\/w:t>/g,
    (m, attrs, beforeText, dots, afterText) => {
      if (replaced) return m;
      replaced = true;
      return `<w:t${attrs}>${beforeText}${escapeXml(value)}${afterText}</w:t>`;
    },
  );

  return updated;
}

function removeDotOnlyTextRuns(fragment) {
  return fragment.replace(
    /(<w:t[^>]*>)[…\.]{3,}(<\/w:t>)/g,
    (m, a, b) => `${a}${b}`,
  );
}

function replaceDotsInParagraphByMarker(xml, marker, replacementValues) {
  if (!marker) return xml;
  const values = Array.isArray(replacementValues)
    ? replacementValues.filter(Boolean)
    : [replacementValues].filter(Boolean);
  if (values.length === 0) return xml;

  const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paraPattern = new RegExp(
    `(<w:p[^>]*>(?:(?!<\\/w:p>)[\\s\\S])*?${escMarker}(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>)`,
    "i",
  );
  const paraMatch = xml.match(paraPattern);
  if (!paraMatch) return xml;

  let updatedParagraph = paraMatch[1];
  for (const value of values) {
    updatedParagraph = replaceFirstDotRunInXml(updatedParagraph, value);
  }

  return xml.replace(paraMatch[1], updatedParagraph);
}

function removeParagraphContaining(xml, textFragment, flags = "i") {
  if (!textFragment) return xml;
  const esc = textFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<w:p[^>]*>(?:(?!<\\/w:p>)[\\s\\S])*?${esc}(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>`,
    flags,
  );
  return xml.replace(pattern, "");
}

function removeTabHintRunsInParagraph(paragraphXml, words) {
  let updated = paragraphXml;
  for (const word of words) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const runPattern = new RegExp(
      `<w:r>(?:<w:rPr>[\\s\\S]*?<\\/w:rPr>)?<w:tab\\/><w:t[^>]*>\\s*${esc}\\s*<\\/w:t><\\/w:r>`,
      "gi",
    );
    updated = updated.replace(runPattern, "");
  }
  return updated;
}

function cleanupTopHeaderHintRuns(xml) {
  const toParaMatch = xml.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\bTO\b(?:(?!<\/w:p>)[\s\S])*?HOUSE\)(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (toParaMatch) {
    const cleanedTo = removeTabHintRunsInParagraph(toParaMatch[1], [
      "OF",
      "THE",
      "HOUSE)",
    ]);
    xml = xml.replace(toParaMatch[1], cleanedTo);
  }

  const fromParaMatch = xml.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\bFROM\b(?:(?!<\/w:p>)[\s\S])*?CONSTITUENCY(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (fromParaMatch) {
    const cleanedFrom = removeTabHintRunsInParagraph(fromParaMatch[1], [
      "(NAME",
      "OF",
      "THE",
    ]);
    xml = xml.replace(fromParaMatch[1], cleanedFrom);
  }

  return xml;
}

function replaceSocialMediaDots(xml, social1, social2, social3) {
  const anchorIndex = xml.indexOf("any) is/are");
  if (anchorIndex === -1) return xml;

  let afterAnchor = xml.slice(anchorIndex);

  const paraWithIi = afterAnchor.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\(ii\)(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (paraWithIi) {
    let updated = paraWithIi[1];
    updated = replaceFirstDotRunInXml(updated, social1);
    updated = replaceFirstDotRunInXml(updated, social2);
    updated = removeDotOnlyTextRuns(updated);
    afterAnchor = afterAnchor.replace(paraWithIi[1], updated);
  }

  const paraWithIii = afterAnchor.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\(iii\)(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (paraWithIii && social3) {
    const updated = removeDotOnlyTextRuns(
      replaceFirstDotRunInXml(paraWithIii[1], social3),
    );
    afterAnchor = afterAnchor.replace(paraWithIii[1], updated);
  }

  return xml.slice(0, anchorIndex) + afterAnchor;
}

function replaceIncomeSourceDots(xml, selfIncome, spouseIncome) {
  const anchorIndex = xml.indexOf("(9A) Details of source(s) of income:");
  if (anchorIndex === -1) return xml;

  let afterAnchor = xml.slice(anchorIndex);

  const selfLine = afterAnchor.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\bSelf\b(?:(?!<\/w:p>)[\s\S])*?[…\.]{4,}(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (selfLine && selfIncome) {
    const updated = removeDotOnlyTextRuns(
      replaceFirstDotRunInXml(selfLine[1], selfIncome),
    );
    afterAnchor = afterAnchor.replace(selfLine[1], updated);
  }

  const spouseLine = afterAnchor.match(
    /(<w:p[^>]*>(?:(?!<\/w:p>)[\s\S])*?\bSpouse\b(?:(?!<\/w:p>)[\s\S])*?[…\.]{4,}(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)/i,
  );
  if (spouseLine && spouseIncome) {
    const updated = removeDotOnlyTextRuns(
      replaceFirstDotRunInXml(spouseLine[1], spouseIncome),
    );
    afterAnchor = afterAnchor.replace(spouseLine[1], updated);
  }

  return xml.slice(0, anchorIndex) + afterAnchor;
}

function toNonEmptyString(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text;
}

function normalizeAffidavitFields(rawFields) {
  const input = rawFields && typeof rawFields === "object" ? rawFields : {};
  const get = (...keys) => {
    for (const key of keys) {
      const value = input[key];
      const text = toNonEmptyString(value);
      if (text) return text;
    }
    return "";
  };

  const normalized = {
    ...input,
    houseName: get("houseName", "house_name"),
    constituency: get("constituency"),
    assemblyConstituency: get(
      "assemblyConstituency",
      "assembly_constituency",
      "constituencyName",
    ),
    candidateName: get("candidateName", "candidate_name", "name"),
    relationType: get("relationType", "relation_type", "parentSpouseRelation"),
    fatherMotherHusbandName: get(
      "fatherMotherHusbandName",
      "father_name",
      "spouse_name",
      "parentSpouseName",
    ),
    age: get("age"),
    postalAddress: get("postalAddress", "address", "postal_address"),
    party: get("party", "politicalPartyName", "political_party"),
    enrolledConstituency: get("enrolledConstituency", "enrolled_constituency"),
    serialNumber: get("serialNumber", "serial_no", "electoralSerialNo"),
    partNumber: get("partNumber", "part_no", "electoralPartNo"),
    telephone: get("telephone", "contactNumber", "phone"),
    email: get("email", "emailId", "email_id"),
    socialMedia1: get("socialMedia1", "social_media_1"),
    socialMedia2: get("socialMedia2", "social_media_2"),
    socialMedia3: get("socialMedia3", "social_media_3"),
    selfProfession: get("selfProfession", "professionSelf"),
    spouseProfession: get("spouseProfession", "professionSpouse"),
    selfIncome: get("selfIncome", "sourceOfIncomeSelf"),
    spouseIncome: get("spouseIncome", "sourceOfIncomeSpouse"),
    dependentIncome: get("dependentIncome", "sourceOfIncomeDependents"),
    educationalQualification: get(
      "educationalQualification",
      "education",
      "qualification",
    ),
    verificationPlace: get("verificationPlace", "place"),
    verificationDate: get("verificationDate", "date", "verification_date"),
    oathCommissionerName: get("oathCommissionerName", "oath_commissioner_name"),
    disputedLiabilities: get("disputedLiabilities"),
  };

  if (normalized.isIndependent === undefined) {
    normalized.isIndependent =
      input.isIndependent === true ||
      input.isIndependent === "true" ||
      input.isIndependent === "1";
  }

  if (
    typeof input.governmentAccommodation === "string" &&
    input.governmentAccommodation.trim()
  ) {
    normalized.governmentAccommodation = parseMaybeJson(
      input.governmentAccommodation,
      {},
    );
  }

  return normalized;
}

function parseVerificationDateParts(rawDate) {
  const value = toNonEmptyString(rawDate);
  if (!value) return null;

  const numeric = value.match(/(\d{1,2})[\/\-.](\d{1,2}|\w+)[\/\-.](\d{2,4})/);
  if (numeric) {
    return {
      day: numeric[1],
      monthYear: `${numeric[2]}/${numeric[3]}`,
    };
  }

  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    const day = (parts[0].match(/\d{1,2}/) || [""])[0];
    if (day) {
      return {
        day,
        monthYear: parts.slice(1).join(" "),
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// MAIN: TEXT PLACEHOLDER REPLACEMENT
// ─────────────────────────────────────────────

function replaceTextPlaceholders(xml, fields, merged) {
  const normalizedFields = normalizeAffidavitFields(fields);

  // 1. TO………………..(NAME OF THE HOUSE) → house/constituency
  const houseName =
    normalizedFields.houseName ||
    normalizedFields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "TO", "(NAME", houseName, true);
  xml = xml.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*OF\s*<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*THE\s*<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*HOUSE\)\s*<\/w:t><\/w:r>/gi,
    "",
  );

  // 2. FROM……………………………CONSTITUENCY → constituency
  const constituency =
    normalizedFields.constituency ||
    normalizedFields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "FROM", "CONSTITUENCY", constituency);
  xml = xml.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*\(NAME\s*<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*OF\s*<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><w:t[^>]*>\s*THE\s*<\/w:t><\/w:r>/gi,
    "",
  );
  xml = removeParagraphContaining(xml, "CONSTITUENCY)");

  // 3. I………………… **son/daughter/wife → candidate name
  const candidateName = normalizedFields.candidateName || "";
  xml = replaceDotsBetween(xml, "I", "**son", candidateName);
  const relationType = toNonEmptyString(
    normalizedFields.relationType,
  ).toLowerCase();
  let relationLabel = "son/daughter/wife";
  if (/(husband|spouse)/.test(relationType)) {
    relationLabel = "wife";
  } else if (/(father|mother|guardian|parent)/.test(relationType)) {
    relationLabel = "son/daughter";
  }
  xml = xml.replace(/\*\*\s*son\/daughter\/wife/gi, relationLabel);

  // 4. of………………………….Aged → father/mother/husband name
  const parentName = normalizedFields.fatherMotherHusbandName || "";
  xml = replaceDotsBetween(xml, "of", "Aged", parentName);

  // 5. Aged…………………………….. → age
  // This appears as: ….Aged followed by dots in same/next run, then years
  const age = normalizedFields.age || "";
  if (age) {
    // Pattern in XML: Aged…………… then ….. then \nyears
    xml = replaceDotsBetween(xml, "Aged", "years", age + " ");
    // Also handle if Aged dots are in separate pattern
    xml = replaceDotsBetween(xml, "….Aged", "years", age + " ");
    xml = replaceDotsAfter(xml, "Aged", age);
  }

  // 6. resident of…………………………(mention full postal address)
  const address = normalizedFields.postalAddress || "";
  xml = replaceDotsBetween(xml, "resident of", "(mention", address, true);
  xml = replaceSegmentBetween(
    xml,
    "resident of",
    "a candidate at the above election",
    `${address},`,
  );

  // 7. set up by------------------------------ → party name
  const party =
    normalizedFields.party ||
    (normalizedFields.isIndependent ? "INDEPENDENT" : "");
  if (party) {
    // Match dashes pattern within <w:t> tags
    const dashPattern = /set up by-{3,}[\s\S]*?(?=<\/w:t>|$)/;
    const dashMatch = xml.match(dashPattern);
    if (dashMatch) {
      xml = xml.replace(dashMatch[0], `set up by ${escapeXml(party)}`);
    } else {
      xml = replaceDashesBetween(xml, "set up by", "\n", party);
    }

    xml = removeParagraphContaining(xml, "**name of the political party");
    xml = removeParagraphContaining(
      xml,
      "**strike out whichever is not applicable",
    );
  }

  // 8. enrolled in…………………………………………(Name → constituency enrollment
  const enrolledIn =
    normalizedFields.enrolledConstituency ||
    normalizedFields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "enrolled in", "(", enrolledIn, true);
  xml = replaceSegmentBetween(
    xml,
    "enrolled in",
    "at Serial",
    `${enrolledIn},`,
  );

  // 9. Serial No……….in Part No → serial and part numbers
  const serialNo = normalizedFields.serialNumber || "";
  const partNo = normalizedFields.partNumber || "";
  if (serialNo) {
    xml = replaceDotsBetween(xml, "No", "in Part", serialNo);
  }
  if (partNo) {
    // Part No…………….. at end of paragraph — use direct pattern
    const dotChars = `[…\\.]+`;
    const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    const partPattern = new RegExp(
      `(Part No)((?:${dotChars}${xmlGap})*${dotChars})`,
      "s",
    );
    const partMatch = xml.match(partPattern);
    if (partMatch) {
      xml = xml.replace(partMatch[0], `Part No ${escapeXml(partNo)}`);
    }
  }

  // 10. telephone number(s) is/are……………………… → phone
  const phone = normalizedFields.telephone || "";
  xml = replaceDotsBetween(xml, "is/are", "and my e-mail", phone);

  // 11. e-mail id (if any) is…………………………… → email
  const email = normalizedFields.email || "";
  xml = replaceDotsBetween(xml, "any) is", "and my social media", email);

  // 12. Social media accounts (i)…… (ii)……… (iii)………
  const social1 = normalizedFields.socialMedia1 || "";
  const social2 = normalizedFields.socialMedia2 || "";
  const social3 = normalizedFields.socialMedia3 || "";
  xml = replaceSocialMediaDots(xml, social1, social2, social3);

  // 13. (a) Self……………… (b) Spouse ……………… (profession)
  const selfProfession = normalizedFields.selfProfession || "";
  const spouseProfession = normalizedFields.spouseProfession || "";
  if (selfProfession) {
    xml = replaceDotsBetween(xml, "Self", "(b)", selfProfession + "       ");
  }
  if (spouseProfession) {
    // Spouse ………………………………………….
    const dotChars = `[…\\.]+`;
    const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    const spouseProf = new RegExp(
      `(Spouse )((?:${dotChars}${xmlGap})*${dotChars})`,
      "s",
    );
    const spouseMatch = xml.match(spouseProf);
    if (spouseMatch) {
      xml = xml.replace(
        spouseMatch[0],
        `Spouse ${escapeXml(spouseProfession)}`,
      );
    }
  }

  // 14. Source of income: Self …………….. / Spouse ………… / dependents,…………
  const selfIncome = normalizedFields.selfIncome || "";
  const spouseIncome = normalizedFields.spouseIncome || "";
  const depIncome = normalizedFields.dependentIncome || "";
  if (selfIncome) {
    xml = replaceDotsBetween(xml, "Self ", "Spouse", selfIncome + "\n");
  }
  if (spouseIncome) {
    xml = replaceDotsBetween(xml, "Spouse", "dependents", spouseIncome + " ");
  }
  xml = replaceIncomeSourceDots(xml, selfIncome, spouseIncome);
  if (depIncome) {
    const dotChars = `[…\\.]+`;
    const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    const depPattern = new RegExp(
      `(dependents,)((?:${dotChars}${xmlGap})*${dotChars})`,
      "s",
    );
    const depMatch = xml.match(depPattern);
    if (depMatch) {
      xml = xml.replace(depMatch[0], `dependents, ${escapeXml(depIncome)}`);
    }
  }

  // 15. Contracts fields
  const contractFields = [
    [
      "details of contracts entered by the candidate",
      normalizedFields.contractsCandidate || fields.contractsCandidate || "",
    ],
    [
      "details of contracts entered into by spouse",
      normalizedFields.contractsSpouse || fields.contractsSpouse || "",
    ],
    [
      "details of contracts entered into by dependents",
      normalizedFields.contractsDependents || fields.contractsDependents || "",
    ],
    [
      "details of contracts entered into by Hindu Undivided Family",
      normalizedFields.contractsHUF || fields.contractsHUF || "",
    ],
    [
      "details of contracts entered into by Hindu Undivided Family or trust in which the candidate or spouse or dependents have interest",
      normalizedFields.contractsHUF || fields.contractsHUF || "",
    ],
    [
      "details of contracts entered into by partnership firms",
      normalizedFields.contractsPartnershipFirms ||
        fields.contractsPartnershipFirms ||
        "",
    ],
    [
      "details of contracts, entered into by Partnership Firms in which candidate or spouse or dependents are partners",
      normalizedFields.contractsPartnershipFirms ||
        fields.contractsPartnershipFirms ||
        "",
    ],
    [
      "details of contracts entered into by private companies",
      normalizedFields.contractsPrivateCompanies ||
        fields.contractsPrivateCompanies ||
        "",
    ],
    [
      "details of contracts, entered into by private companies in which candidate or spouse or dependents have share",
      normalizedFields.contractsPrivateCompanies ||
        fields.contractsPrivateCompanies ||
        "",
    ],
  ];
  for (const [context, val] of contractFields) {
    if (val) {
      const dotChars = `[…\\.]+`;
      const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
      const cPattern = new RegExp(
        `(${context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*((?:${dotChars}${xmlGap})*${dotChars})`,
        "si",
      );
      const cMatch = xml.match(cPattern);
      if (cMatch) {
        xml = xml.replace(cMatch[0], `${context} ${escapeXml(val)}`);
      }
    }
  }

  // 16. Educational qualification ………………………
  const education = normalizedFields.educationalQualification || "";
  if (education) {
    // Find the dots after "educational qualification" text (may be on next paragraph)
    const dotChars = `[…\\.]+`;
    const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    // Also allow paragraph boundaries between the label and the dots
    const paraGap = `(?:</w:t></w:r></w:p><w:p[^>]*>(?:<w:pPr>(?:[^<]|<(?!/w:pPr>))*</w:pPr>)?<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    const eduPattern = new RegExp(
      `(My educational qualification is as under:(?:${paraGap})?\\s*)((?:${dotChars}${xmlGap})*${dotChars})`,
      "s",
    );
    const eduMatch = xml.match(eduPattern);
    if (eduMatch) {
      xml = xml.replace(eduMatch[0], `${eduMatch[1]}${escapeXml(education)}`);
    }
    xml = replaceSegmentBetween(
      xml,
      "My educational qualification is as under:",
      "(Give details",
      education,
    );
    xml = replaceDotsInParagraphByMarker(
      xml,
      "My educational qualification is as under:",
      [education],
    );
  }

  // 17. Verification: at………… this the……day of………
  const verifyPlace = normalizedFields.verificationPlace || "";
  const verifyDate = normalizedFields.verificationDate || "";
  if (verifyPlace) {
    xml = replaceDotsBetween(xml, "at", "this", verifyPlace);
  }
  if (verifyDate) {
    const dateParts = parseVerificationDateParts(verifyDate);
    if (dateParts) {
      xml = replaceDotsBetween(xml, "the", "day of", dateParts.day);
      // month………. (trailing dots after "day of")
      const dotChars = `[…\\.]+`;
      const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
      const monthPattern = new RegExp(
        `(day of)((?:${dotChars}${xmlGap})*${dotChars})`,
        "s",
      );
      const monthMatch = xml.match(monthPattern);
      if (monthMatch) {
        xml = xml.replace(
          monthMatch[0],
          `day of ${escapeXml(dateParts.monthYear)}`,
        );
      }
    }
  }

  // 18. Government accommodation details
  const govAccom = parseMaybeJson(
    normalizedFields.governmentAccommodation,
    parseMaybeJson(merged.governmentAccommodation, {}),
  );
  if (govAccom.address) {
    xml = replaceDotsAfter(xml, "accommodation:", govAccom.address);
  }
  if (govAccom.duesDate) {
    xml = replaceDotsBetween(xml, "as on", "(date)", govAccom.duesDate, true);
    xml = replaceDotsAfter(xml, "as on", govAccom.duesDate);
  }

  // 19. Oath Commissioner / Notary details
  if (normalizedFields.oathCommissionerName) {
    xml = replaceDotsAfter(
      xml,
      "before me",
      normalizedFields.oathCommissionerName,
    );
  }

  // 20. Disputed liabilities field
  if (normalizedFields.disputedLiabilities) {
    xml = replaceDotsAfter(
      xml,
      "disputed",
      normalizedFields.disputedLiabilities,
    );
  }

  return xml;
}

// ─────────────────────────────────────────────
// MAIN: TABLE CELL FILLING
// ─────────────────────────────────────────────

function fillTableCells(xml, merged) {
  const tables = findTables(xml);
  if (tables.length < 10) return xml;

  // Process tables from last to first so indices don't shift
  // Table 1: PAN / Income Tax (rows: header + 30 data rows for Self/Spouse/HUF/Dep1-3, 5 years each)
  xml = fillPanTable(xml, tables[0], merged);

  // Table 2: Pending Criminal Cases (FIR details)
  xml = fillCriminalPendingTable(xml, tables[1], merged);

  // Table 3: Cases of Conviction
  xml = fillConvictionTable(xml, tables[2], merged);

  // Table 4: Movable Assets
  xml = fillMovableAssetsTable(xml, tables[3], merged);

  // Tables 5-7: Immovable Assets (split across multiple tables in template)
  xml = fillImmovableAssetsTables(
    xml,
    [tables[4], tables[5], tables[6]],
    merged,
  );

  // Table 8: Liabilities (loans)
  xml = fillLiabilitiesTable(xml, tables[7], merged);

  // Table 9: Government Dues
  xml = fillGovDuesTable(xml, tables[8], merged);

  // Table 10: Part B Summary
  xml = fillPartBSummary(xml, tables[9], merged);

  return xml;
}

/**
 * Check if a cell is a vertical merge continuation (should be skipped for filling).
 * Returns true if cell has vMerge without val="restart".
 */
function isVMergeContinuation(cellXml) {
  if (!cellXml.includes("vMerge")) return false;
  return !cellXml.includes('vMerge w:val="restart"');
}

/**
 * Fill PAN/Income Tax table (Table 1).
 * Template: 31 rows. Row 0=header, then 5 rows per person (Self, Spouse, HUF, Dep1-3).
 * Each person group: first row has vMerge=restart for cells 0-3 (Sl.No, Name, PAN, FinYear),
 * cell 4 = year number "(i)", cell 5 = income. Continuation rows have vMerge for 0-3.
 * OCR data: [SlNo, Name, PAN, FinYear, Income] for first row, [FinYear, Income] for rest.
 */
function fillPanTable(xml, tablePos, merged) {
  const tableXml = xml.substring(tablePos.start, tablePos.end);
  const rows = parseTableRows(tableXml);
  if (rows.length < 2) return xml;

  const panData = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("pan") ||
      t.tableTitle?.toLowerCase().includes("income tax") ||
      t.tableTitle?.toLowerCase().includes("permanent account"),
  );

  if (!panData?.rows) return xml;

  let newTableXml = tableXml;
  for (let i = 1; i < rows.length && i - 1 < panData.rows.length; i++) {
    const dataRow = panData.rows[i - 1];
    if (!Array.isArray(dataRow) || dataRow.length === 0) continue;

    const row = rows[i];
    const isRestartRow = row.cells.some((c) =>
      c.xml.includes('vMerge w:val="restart"'),
    );

    if (isRestartRow && dataRow.length >= 4) {
      // First row of a person group — fill merged cells and income
      // Cell 0: Sl.No
      if (!row.cells[0].text && dataRow[0]) {
        const nc = setCellText(row.cells[0].xml, dataRow[0]);
        newTableXml = newTableXml.replace(row.cells[0].xml, nc);
      }
      // Cell 1: Name (may have "Self"/"Spouse" — overwrite)
      if (dataRow[1]) {
        const nc = setCellText(row.cells[1].xml, dataRow[1]);
        newTableXml = newTableXml.replace(row.cells[1].xml, nc);
      }
      // Cell 2: PAN
      if (!row.cells[2].text && dataRow[2]) {
        const nc = setCellText(row.cells[2].xml, dataRow[2]);
        newTableXml = newTableXml.replace(row.cells[2].xml, nc);
      }
      // Last cell: Income amount
      const lastCell = row.cells[row.cells.length - 1];
      if (!lastCell.text && dataRow[dataRow.length - 1]) {
        const nc = setCellText(lastCell.xml, dataRow[dataRow.length - 1]);
        newTableXml = newTableXml.replace(lastCell.xml, nc);
      }
    } else {
      // Continuation row — fill only non-merged empty cells
      const fillable = row.cells.filter(
        (c) => !isVMergeContinuation(c.xml) && !c.text,
      );
      let dIdx = 0;
      for (const fc of fillable) {
        if (dIdx < dataRow.length && dataRow[dIdx]) {
          const nc = setCellText(fc.xml, dataRow[dIdx]);
          newTableXml = newTableXml.replace(fc.xml, nc);
        }
        dIdx++;
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Criminal Cases Pending table (Table 2).
 */
function fillCriminalPendingTable(xml, tablePos, merged) {
  const cr = merged.criminalRecord || {};
  const pendingTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("pending") ||
      t.tableTitle?.toLowerCase().includes("fir"),
  );

  if (!pendingTable?.rows && !cr.hasPendingCases) return xml;

  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  if (pendingTable?.rows) {
    for (let i = 0; i < rows.length && i < pendingTable.rows.length; i++) {
      const dataRow = pendingTable.rows[i];
      if (!Array.isArray(dataRow)) continue;
      const row = rows[i];
      let dataIdx = 0;
      for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
        if (isVMergeContinuation(row.cells[c].xml)) continue;
        if (row.cells[c].text) continue;
        const cellValue = dataRow[dataIdx++];
        if (cellValue) {
          const newCellXml = setCellText(row.cells[c].xml, cellValue);
          newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
        }
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Conviction table (Table 3).
 */
function fillConvictionTable(xml, tablePos, merged) {
  const convTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("conviction") ||
      t.tableTitle?.toLowerCase().includes("convicted"),
  );

  if (!convTable?.rows) return xml;

  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  for (let i = 0; i < rows.length && i < convTable.rows.length; i++) {
    const dataRow = convTable.rows[i];
    if (!Array.isArray(dataRow)) continue;
    const row = rows[i];
    let dataIdx = 0;
    for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
      if (isVMergeContinuation(row.cells[c].xml)) continue;
      if (row.cells[c].text) continue;
      const cellValue = dataRow[dataIdx++];
      if (cellValue) {
        const newCellXml = setCellText(row.cells[c].xml, cellValue);
        newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Movable Assets table (Table 4).
 * Columns: S.No | Description | Self | Spouse | HUF | Dep-1 | Dep-2 | Dep-3
 * Rows: (i) Cash, (ii) Bank deposits, (iii) Bonds/Shares, (iv) NSS/Postal,
 *        (v) Personal loans, (vi) Motor vehicles, (vii) Jewellery, (viii) Other, (ix) Gross Total
 */
function fillMovableAssetsTable(xml, tablePos, merged) {
  const assets = merged.assets?.movable || {};
  const movableTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("movable") ||
      t.tableTitle?.toLowerCase().includes("moveable"),
  );

  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  // Map asset fields to row indices (0 = header, 1 = Cash in hand, etc.)
  const assetMapping = [
    null, // header row
    assets.cashInHand,
    assets.bankDeposits,
    assets.investmentsShares || assets.bondsDebentures,
    assets.nscPostalSavings || assets.insurancePolicies,
    assets.loanToOthers || assets.personalLoans,
    assets.motorVehicles,
    assets.jewellery,
    assets.otherAssets,
    assets.grossTotal || assets.totalMovable,
  ];

  // If we have table data from OCR, use that instead
  if (movableTable?.rows) {
    for (let i = 0; i < rows.length && i < movableTable.rows.length; i++) {
      const dataRow = movableTable.rows[i];
      if (!Array.isArray(dataRow)) continue;
      const row = rows[i];
      let dataIdx = 0;
      for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
        if (isVMergeContinuation(row.cells[c].xml)) continue;
        if (row.cells[c].text) continue;
        const cellValue = dataRow[dataIdx++];
        if (cellValue) {
          const newCellXml = setCellText(row.cells[c].xml, cellValue);
          newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
        }
      }
    }
  } else {
    // Use individual asset fields — fill the "Self" column (index 2)
    for (let i = 1; i < rows.length && i < assetMapping.length; i++) {
      const value = assetMapping[i];
      if (!value) continue;
      const row = rows[i];
      if (row.cells.length > 2 && !row.cells[2].text) {
        const newCellXml = setCellText(row.cells[2].xml, value);
        newTableXml = newTableXml.replace(row.cells[2].xml, newCellXml);
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Immovable Assets tables (Tables 5, 6, 7).
 */
function fillImmovableAssetsTables(xml, tablePositions, merged) {
  const immovableTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("immovable") ||
      t.tableTitle?.toLowerCase().includes("immoveable"),
  );

  if (!immovableTable?.rows) return xml;

  // Process from last to first to preserve indices
  for (let ti = tablePositions.length - 1; ti >= 0; ti--) {
    const tablePos = tablePositions[ti];
    const tableXml = xml.substring(tablePos.start, tablePos.end);
    let newTableXml = tableXml;
    const rows = parseTableRows(tableXml);

    // Calculate offset into the immovable data rows
    let dataOffset = 0;
    for (let prev = 0; prev < ti; prev++) {
      const prevXml = xml.substring(
        tablePositions[prev].start,
        tablePositions[prev].end,
      );
      dataOffset += parseTableRows(prevXml).length;
    }

    for (let i = 0; i < rows.length; i++) {
      const dataIdx = dataOffset + i;
      if (dataIdx >= immovableTable.rows.length) break;
      const dataRow = immovableTable.rows[dataIdx];
      if (!Array.isArray(dataRow)) continue;

      const row = rows[i];
      let dIdx = 0;
      for (let c = 0; c < row.cells.length && dIdx < dataRow.length; c++) {
        if (isVMergeContinuation(row.cells[c].xml)) continue;
        if (row.cells[c].text) continue;
        const cellValue = dataRow[dIdx++];
        if (cellValue) {
          const newCellXml = setCellText(row.cells[c].xml, cellValue);
          newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
        }
      }
    }

    xml =
      xml.substring(0, tablePos.start) +
      newTableXml +
      xml.substring(tablePos.end);
  }

  return xml;
}

/**
 * Fill Liabilities table (Table 8).
 */
function fillLiabilitiesTable(xml, tablePos, merged) {
  const liabilities = merged.liabilities || {};
  const liabTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("liabilit") ||
      t.tableTitle?.toLowerCase().includes("loan") ||
      t.tableTitle?.toLowerCase().includes("dues to"),
  );

  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  if (liabTable?.rows) {
    for (let i = 0; i < rows.length && i < liabTable.rows.length; i++) {
      const dataRow = liabTable.rows[i];
      if (!Array.isArray(dataRow)) continue;
      const row = rows[i];
      let dataIdx = 0;
      for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
        if (isVMergeContinuation(row.cells[c].xml)) continue;
        if (row.cells[c].text) continue;
        const cellValue = dataRow[dataIdx++];
        if (cellValue) {
          const newCellXml = setCellText(row.cells[c].xml, cellValue);
          newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
        }
      }
    }
  } else {
    // Fill from individual fields — Self column (index 2)
    const liabMapping = [
      null, // header
      liabilities.loansFromBanks,
      liabilities.loansFromOthers || liabilities.loansFromFinancialInstitutions,
      liabilities.otherLiabilities,
      liabilities.grandTotal || liabilities.totalLiabilities,
    ];

    for (let i = 1; i < rows.length && i < liabMapping.length; i++) {
      const value = liabMapping[i];
      if (!value) continue;
      const row = rows[i];
      if (row.cells.length > 2 && !row.cells[2].text) {
        const newCellXml = setCellText(row.cells[2].xml, value);
        newTableXml = newTableXml.replace(row.cells[2].xml, newCellXml);
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Government Dues table (Table 9).
 */
function fillGovDuesTable(xml, tablePos, merged) {
  const govTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("government") ||
      t.tableTitle?.toLowerCase().includes("dues"),
  );

  if (!govTable?.rows) return xml;

  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  for (let i = 0; i < rows.length && i < govTable.rows.length; i++) {
    const dataRow = govTable.rows[i];
    if (!Array.isArray(dataRow)) continue;
    const row = rows[i];
    let dataIdx = 0;
    for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
      if (isVMergeContinuation(row.cells[c].xml)) continue;
      if (row.cells[c].text) continue;
      const cellValue = dataRow[dataIdx++];
      if (cellValue) {
        const newCellXml = setCellText(row.cells[c].xml, cellValue);
        newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

/**
 * Fill Part B Summary table (Table 10).
 * Structure: Name, Address, Constituency, Party, Criminal cases, PAN abstract,
 *            Assets/Liabilities summary, Education
 */
function fillPartBSummary(xml, tablePos, merged) {
  const fields = merged.fields || {};
  const tableXml = xml.substring(tablePos.start, tablePos.end);
  let newTableXml = tableXml;
  const rows = parseTableRows(tableXml);

  // Row mapping for Part B summary (based on template structure):
  // Row 0: Name of candidate → Cell with "Sh./Smt./Kum." should be filled
  // Row 1: Postal address
  // Row 2: Constituency and State
  // Row 3: Political party
  // Row 4: Total pending criminal cases
  // Row 5: Total convictions
  // Rows 6-10: PAN/Income summary (Candidate, Spouse, HUF, Dependent)
  // Rows 11+: Assets and liabilities summary

  const summaryMapping = {
    0: fields.candidateName || "", // Name
    1: fields.postalAddress || "", // Address
    2: [fields.assemblyConstituency, merged.state].filter(Boolean).join(", "), // Constituency
    3: fields.party || "", // Party
    4:
      merged.criminalRecord?.hasPendingCases === "No"
        ? "NIL"
        : merged.criminalRecord?.totalPendingCases || "", // Pending cases
    5:
      merged.criminalRecord?.hasConvictions === "No"
        ? "NIL"
        : merged.criminalRecord?.totalConvictions || "", // Convictions
  };

  for (const [rowIdxStr, value] of Object.entries(summaryMapping)) {
    const rowIdx = parseInt(rowIdxStr);
    if (!value || rowIdx >= rows.length) continue;
    const row = rows[rowIdx];
    // Fill last cell in the row (the value cell)
    const lastCell = row.cells[row.cells.length - 1];
    if (lastCell && !lastCell.text.trim()) {
      const newCellXml = setCellText(lastCell.xml, value);
      newTableXml = newTableXml.replace(lastCell.xml, newCellXml);
    }
  }

  // Fill education (last row)
  const education = fields.educationalQualification || fields.education || "";
  if (education && rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    const lastCell = lastRow.cells[lastRow.cells.length - 1];
    if (lastCell) {
      const newCellXml = setCellText(lastCell.xml, education);
      newTableXml = newTableXml.replace(lastCell.xml, newCellXml);
    }
  }

  // Fill asset/liability summary rows using table data from OCR
  const summaryTable = merged.tables?.find(
    (t) =>
      t.tableTitle?.toLowerCase().includes("abstract") ||
      t.tableTitle?.toLowerCase().includes("summary") ||
      t.tableTitle?.toLowerCase().includes("part b"),
  );
  if (summaryTable?.rows) {
    // Start after the basic info rows (row 6 onwards for PAN, then assets)
    for (let i = 6; i < rows.length && i - 6 < summaryTable.rows.length; i++) {
      const dataRow = summaryTable.rows[i - 6];
      if (!Array.isArray(dataRow)) continue;
      const row = rows[i];
      let dataIdx = 0;
      for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
        if (isVMergeContinuation(row.cells[c].xml)) continue;
        if (row.cells[c].text) continue;
        const cellValue = dataRow[dataIdx++];
        if (cellValue) {
          const newCellXml = setCellText(row.cells[c].xml, cellValue);
          newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
        }
      }
    }
  }

  return (
    xml.substring(0, tablePos.start) + newTableXml + xml.substring(tablePos.end)
  );
}

// ─────────────────────────────────────────────
// FALLBACK: Fill generic tables from OCR data
// ─────────────────────────────────────────────

/**
 * For any OCR tables that weren't matched to a specific template table,
 * try to fill them by matching table titles/headers.
 */
function fillGenericTables(xml, merged) {
  const tables = findTables(xml);

  for (const ocrTable of merged.tables || []) {
    if (!ocrTable.rows || ocrTable.rows.length === 0) continue;

    // Try to find matching template table by title keywords
    const titleLower = (ocrTable.tableTitle || "").toLowerCase();
    const keywords = titleLower.split(/\s+/).filter((w) => w.length > 3);
    if (keywords.length === 0) continue;

    for (const tablePos of tables) {
      const tableXml = xml.substring(tablePos.start, tablePos.end);
      const tableText = extractText(tableXml).toLowerCase();

      // Check if this table matches by keywords
      const matchCount = keywords.filter((kw) => tableText.includes(kw)).length;
      if (matchCount < Math.ceil(keywords.length * 0.5)) continue;

      const rows = parseTableRows(tableXml);
      let modified = false;
      let newTableXml = tableXml;

      for (let i = 0; i < rows.length && i < ocrTable.rows.length; i++) {
        const dataRow = ocrTable.rows[i];
        if (!Array.isArray(dataRow)) continue;
        const row = rows[i];
        let dataIdx = 0;
        for (let c = 0; c < row.cells.length && dataIdx < dataRow.length; c++) {
          if (isVMergeContinuation(row.cells[c].xml)) continue;
          if (row.cells[c].text) continue;
          const cellValue = dataRow[dataIdx++];
          if (cellValue) {
            const newCellXml = setCellText(row.cells[c].xml, cellValue);
            newTableXml = newTableXml.replace(row.cells[c].xml, newCellXml);
            modified = true;
          }
        }
      }

      if (modified) {
        xml =
          xml.substring(0, tablePos.start) +
          newTableXml +
          xml.substring(tablePos.end);
        break; // Only fill once per OCR table
      }
    }
  }

  return xml;
}

// ─────────────────────────────────────────────
// CRIMINAL RECORD TEXT DECLARATIONS
// ─────────────────────────────────────────────

/**
 * Fill criminal record declaration text (pending cases / conviction checkboxes).
 */
function fillCriminalDeclarations(xml, merged) {
  const cr = merged.criminalRecord || {};

  // If has pending cases = No, we might want to mark the "(i) I declare..." option
  // If has pending cases = Yes, mark "(ii) The following criminal cases..."
  // For the template format, these are just text — we leave them as-is
  // The actual data goes into the table cells which we already handle

  // Fill 6A text about informing political party
  if (cr.hasPendingCases === "No" && cr.hasConvictions === "No") {
    xml = replaceInXml(
      xml,
      "NOT APPLICABLE IN VIEW OF ENTRIES IN 5(i) and 6(i), above",
      "NOT APPLICABLE IN VIEW OF ENTRIES IN 5(i) and 6(i), above",
    );
  }

  return xml;
}

// ─────────────────────────────────────────────
// IMAGE EMBEDDING HELPER
// ─────────────────────────────────────────────

let affImageCounter = 200; // start high to avoid conflicts

async function downloadImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function addImageToDocx(zip, imageBuffer, imageId) {
  const ext = "png";
  const mediaPath = `word/media/aff_image${imageId}.${ext}`;
  zip.addFile(mediaPath, imageBuffer);

  let rels = zip.readAsText("word/_rels/document.xml.rels");
  const relId = `rIdAffImg${imageId}`;
  const relEntry = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/aff_image${imageId}.${ext}"/>`;
  rels = rels.replace("</Relationships>", relEntry + "</Relationships>");
  zip.updateFile("word/_rels/document.xml.rels", Buffer.from(rels, "utf8"));

  return relId;
}

function getInlineImageXml(relId, widthCm, heightCm) {
  const cx = Math.round(widthCm * 360000);
  const cy = Math.round(heightCm * 360000);
  const docPrId = affImageCounter++;
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="Image${docPrId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="img${docPrId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

async function embedImages(zip, xml, merged) {
  const fields = merged.fields || {};

  // Candidate photograph — near "passport size photograph" text
  if (fields.candidatePhotoUrl) {
    const imgBuf = await downloadImage(fields.candidatePhotoUrl);
    if (imgBuf) {
      const relId = addImageToDocx(zip, imgBuf, 1);
      const imgXml = getInlineImageXml(relId, 2, 2.5);
      const photoMatch = xml.match(/(<w:p [^>]*>[^]*?photograph[^]*?<\/w:p>)/i);
      if (photoMatch) {
        const imgPara = `<w:p><w:r>${imgXml}</w:r></w:p>`;
        xml = xml.replace(photoMatch[0], imgPara + photoMatch[0]);
      }
    }
  }

  // Deponent signature — near "DEPONENT" text
  if (fields.candidateSignatureUrl || fields.deponentSignatureUrl) {
    const sigUrl = fields.candidateSignatureUrl || fields.deponentSignatureUrl;
    const imgBuf = await downloadImage(sigUrl);
    if (imgBuf) {
      const relId = addImageToDocx(zip, imgBuf, 2);
      const imgXml = getInlineImageXml(relId, 4, 1.5);
      const sigMatch = xml.match(/(<w:p [^>]*>[^]*?DEPONENT[^]*?<\/w:p>)/);
      if (sigMatch) {
        const imgPara = `<w:p><w:r>${imgXml}</w:r></w:p>`;
        xml = xml.replace(sigMatch[0], imgPara + sigMatch[0]);
      }
    }
  }

  return xml;
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

/**
 * Fill the DOCX template with OCR-extracted data.
 *
 * @param {Object} merged - Merged affidavit data from mergeAffidavitPages()
 * @returns {Buffer} - The filled DOCX file as a buffer
 */
// ─────────────────────────────────────────────
// BRACKET HINT CLEANUP
// ─────────────────────────────────────────────

/**
 * Remove parenthetical hint text from the filled document.
 * Only removes hints where the corresponding field has been filled (no dots remain).
 * Handles both inline hints (within same <w:t> tag) and cross-run hints
 * (e.g., "(NAME " + "OF " + "THE " + "HOUSE) " in separate <w:r> blocks).
 */
function cleanupBracketHints(xml) {
  // Step 1: Remove standalone bracket-hint <w:r> runs
  // These are runs that contain ONLY a bracket-hint fragment (with optional tab)
  // Pattern: <w:r><rPr/><tab?/><w:t>(NAME </w:t></w:r>
  const standaloneHints = [
    "\\(NAME ",
    "HOUSE\\) ",
    "HOUSE\\)",
    "CONSTITUENCY\\) ",
    "CONSTITUENCY\\)",
  ];
  for (const hint of standaloneHints) {
    // Remove entire <w:r> block containing only the hint
    const runPattern = new RegExp(
      `<w:r>(?:<w:rPr>[\\s\\S]*?</w:rPr>)?(?:<w:tab/>)?<w:t[^>]*>${hint}</w:t></w:r>`,
      "g",
    );
    xml = xml.replace(runPattern, "");
  }

  // Remove "OF " and "THE " runs that appear with <w:tab/> (bracket hint context)
  const tabHints = ["OF ", "THE "];
  for (const hint of tabHints) {
    const escHint = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tabRunPattern = new RegExp(
      `<w:r>(?:<w:rPr>[\\s\\S]*?</w:rPr>)?<w:tab/><w:t[^>]*>${escHint}</w:t></w:r>`,
      "g",
    );
    xml = xml.replace(tabRunPattern, "");
  }

  // Step 2: Remove inline bracket hints from <w:t> content
  // These appear within the same <w:t> tag as other text
  xml = xml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (match, attrs, content) => {
    let newContent = content;

    // Remove known inline bracket hints
    const inlinePatterns = [
      [/\s*\(hour\)/g, ""],
      [/\s*\(date\)/g, ""],
      [/\s*\(Place\)/g, ""],
      [/\s*\(State\)/g, ""],
      [/\s*\(area\)/g, ""],
      [/\s*\(Name\)/g, ""],
      [/\s*\(name of the language\)/gi, ""],
      [/\(mention full postal address\),?/gi, ""],
      [/mention full postal address\),?/gi, ""],
      [/\(Name of the Constituency and the state\),?/gi, ""],
      [/Name of the Constituency and the state\),?/gi, ""],
      [/\(\*\*name of the political party\)/gi, ""],
      [/\*\*strike out whichever is not applicable/gi, ""],
    ];

    // Only remove inline hints if the text around them has NO remaining dots
    // (meaning the field was filled)
    const hasDots = /[…]{2,}|\.{4,}/.test(content);
    if (!hasDots) {
      for (const [pattern, replacement] of inlinePatterns) {
        newContent = newContent.replace(pattern, replacement);
      }
    }

    if (newContent !== content) {
      return `<w:t xml:space="preserve">${newContent}</w:t>`;
    }
    return match;
  });

  // Step 3: Remove standalone bracket runs for nomination-style "(State)" split as "(", "State", ")"
  // Pattern: <w:r><w:t>(</w:t></w:r> followed by <w:r>...<w:t>State</w:t></w:r> followed by <w:r><w:t>)  </w:t></w:r>
  xml = xml.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\(<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>State<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\)\s*<\/w:t><\/w:r>/g,
    "",
  );

  // Step 4: Remove leftover split hint fragments around enrolled constituency and address labels.
  xml = xml.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>…+\(<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\s*Name of the\s*<\/w:t><\/w:r>/gi,
    "",
  );
  xml = xml.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>…+\(<\/w:t><\/w:r>\s*<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\s*mention full postal address\),?\s*<\/w:t><\/w:r>/gi,
    "",
  );

  return xml;
}

function parseMaybeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function addSummaryLine(lines, label, value) {
  if (value === null || value === undefined) return;
  const text = String(value).trim();
  if (!text) return;
  lines.push(`${label}: ${text}`);
}

function tryParseJsonString(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function pushFlattenedKeyValue(lines, prefix, value) {
  if (value === null || value === undefined) return;

  const parsed = tryParseJsonString(value);
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return;
    parsed.forEach((item, index) => {
      pushFlattenedKeyValue(lines, `${prefix}[${index}]`, item);
    });
    return;
  }

  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length === 0) return;
    keys.sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      pushFlattenedKeyValue(lines, `${prefix}.${key}`, parsed[key]);
    }
    return;
  }

  const text = String(parsed).trim();
  if (!text) return;
  lines.push(`${prefix}: ${text}`);
}

function buildInputSummaryLines(merged) {
  const fields = merged.fields || {};
  const lines = [];

  lines.push("AFFIDAVIT INPUT SUMMARY");
  lines.push("Candidate & Election Details");
  addSummaryLine(lines, "Name", fields.candidateName);
  addSummaryLine(lines, "Parent/Spouse Name", fields.fatherMotherHusbandName);
  addSummaryLine(lines, "Age", fields.age);
  addSummaryLine(lines, "House", fields.houseName);
  addSummaryLine(
    lines,
    "Constituency",
    fields.constituency || fields.assemblyConstituency || merged.constituency,
  );
  addSummaryLine(lines, "State", merged.state || fields.state);
  addSummaryLine(lines, "Postal Address", fields.postalAddress);
  addSummaryLine(
    lines,
    "Party",
    fields.party || (fields.isIndependent ? "INDEPENDENT" : ""),
  );
  addSummaryLine(lines, "Electoral Roll Serial No", fields.serialNumber);
  addSummaryLine(lines, "Electoral Roll Part No", fields.partNumber);
  addSummaryLine(lines, "Telephone", fields.telephone || fields.contactNumber);
  addSummaryLine(lines, "Email", fields.email || fields.emailId);
  addSummaryLine(lines, "Social Media 1", fields.socialMedia1);
  addSummaryLine(lines, "Social Media 2", fields.socialMedia2);
  addSummaryLine(lines, "Social Media 3", fields.socialMedia3);

  lines.push("Profession, Income & Education");
  addSummaryLine(
    lines,
    "Profession (Self)",
    fields.selfProfession || fields.professionSelf,
  );
  addSummaryLine(
    lines,
    "Profession (Spouse)",
    fields.spouseProfession || fields.professionSpouse,
  );
  addSummaryLine(
    lines,
    "Income Source (Self)",
    fields.selfIncome || fields.sourceOfIncomeSelf,
  );
  addSummaryLine(
    lines,
    "Income Source (Spouse)",
    fields.spouseIncome || fields.sourceOfIncomeSpouse,
  );
  addSummaryLine(
    lines,
    "Income Source (Dependents)",
    fields.dependentIncome || fields.sourceOfIncomeDependents,
  );
  addSummaryLine(
    lines,
    "Educational Qualification",
    fields.educationalQualification || fields.education,
  );

  lines.push("Contracts / Government / Verification");
  addSummaryLine(lines, "Contracts (Candidate)", fields.contractsCandidate);
  addSummaryLine(lines, "Contracts (Spouse)", fields.contractsSpouse);
  addSummaryLine(lines, "Contracts (Dependents)", fields.contractsDependents);
  addSummaryLine(lines, "Contracts (HUF)", fields.contractsHUF);
  addSummaryLine(
    lines,
    "Contracts (Partnership Firms)",
    fields.contractsPartnershipFirms,
  );
  addSummaryLine(
    lines,
    "Contracts (Private Companies)",
    fields.contractsPrivateCompanies,
  );

  const govAcc = parseMaybeJson(
    fields.governmentAccommodation,
    merged.governmentAccommodation || {},
  );
  if (govAcc && typeof govAcc === "object") {
    addSummaryLine(lines, "Govt Accommodation Occupied", govAcc.occupied);
    addSummaryLine(lines, "Govt Accommodation Address", govAcc.address);
    addSummaryLine(lines, "Govt Accommodation No-Dues", govAcc.noDues);
    addSummaryLine(lines, "Govt Accommodation Dues Date", govAcc.duesDate);
    addSummaryLine(lines, "Govt Accommodation Rent Dues", govAcc.rentDues);
    addSummaryLine(
      lines,
      "Govt Accommodation Electricity Dues",
      govAcc.electricityDues,
    );
    addSummaryLine(lines, "Govt Accommodation Water Dues", govAcc.waterDues);
    addSummaryLine(
      lines,
      "Govt Accommodation Telephone Dues",
      govAcc.telephoneDues,
    );
  }

  addSummaryLine(lines, "Disputed Liabilities", fields.disputedLiabilities);
  addSummaryLine(
    lines,
    "Verification Place",
    fields.verificationPlace || fields.place,
  );
  addSummaryLine(
    lines,
    "Verification Date",
    fields.verificationDate || fields.date,
  );
  addSummaryLine(lines, "Oath Commissioner Name", fields.oathCommissionerName);
  addSummaryLine(
    lines,
    "Oath Commissioner Designation",
    fields.oathCommissionerDesignation,
  );
  addSummaryLine(
    lines,
    "Oath Commissioner Seal No",
    fields.oathCommissionerSealNo,
  );

  if (Array.isArray(merged.tables) && merged.tables.length > 0) {
    lines.push("Captured Tables");
    for (const table of merged.tables) {
      const title = String(table?.tableTitle || "Untitled Table").trim();
      const rowCount = Array.isArray(table?.rows) ? table.rows.length : 0;
      lines.push(`${title} - rows: ${rowCount}`);
    }
  }

  lines.push("All Raw Input Fields");
  const allFieldKeys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
  for (const key of allFieldKeys) {
    pushFlattenedKeyValue(lines, key, fields[key]);
  }

  if (merged.criminalRecord && typeof merged.criminalRecord === "object") {
    const keys = Object.keys(merged.criminalRecord).sort((a, b) =>
      a.localeCompare(b),
    );
    for (const key of keys) {
      pushFlattenedKeyValue(
        lines,
        `criminalRecord.${key}`,
        merged.criminalRecord[key],
      );
    }
  }

  if (merged.assets && typeof merged.assets === "object") {
    pushFlattenedKeyValue(lines, "assets", merged.assets);
  }

  if (merged.liabilities && typeof merged.liabilities === "object") {
    pushFlattenedKeyValue(lines, "liabilities", merged.liabilities);
  }

  if (
    merged.governmentAccommodation &&
    typeof merged.governmentAccommodation === "object"
  ) {
    pushFlattenedKeyValue(
      lines,
      "governmentAccommodation",
      merged.governmentAccommodation,
    );
  }

  return lines;
}

function buildInputCalloutParagraph(label, value) {
  const text = `${label}: ${value}`;
  return `<w:p><w:pPr><w:spacing w:before="30" w:after="30"/><w:ind w:left="300"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="1" w:color="2F5597"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EAF3FF"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="1F3763"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function insertCalloutAboveDottedLine(xml, marker, label, value) {
  if (!value) return xml;
  const raw = String(value).trim();
  if (!raw) return xml;
  const escapedText = escapeXml(`${label}: ${raw}`);
  if (xml.includes(escapedText)) return xml;

  const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dottedParaPattern = new RegExp(
    `(<w:p[^>]*>[\\s\\S]*?${escMarker}[\\s\\S]*?(?:[…]{2,}|\\.{4,})[\\s\\S]*?<\\/w:p>)`,
    "i",
  );

  const callout = buildInputCalloutParagraph(label, raw);
  if (dottedParaPattern.test(xml)) {
    return xml.replace(dottedParaPattern, `${callout}$1`);
  }

  const markerParaPattern = new RegExp(
    `(<w:p[^>]*>[\\s\\S]*?${escMarker}[\\s\\S]*?<\\/w:p>)`,
    "i",
  );
  if (markerParaPattern.test(xml)) {
    return xml.replace(markerParaPattern, `${callout}$1`);
  }

  return xml;
}

function insertInputCalloutsNearDottedText(xml, merged) {
  const fields = merged.fields || {};
  const calloutMap = [
    [
      "TO",
      "House",
      fields.houseName || fields.assemblyConstituency || merged.constituency,
    ],
    [
      "FROM",
      "Constituency",
      fields.constituency || fields.assemblyConstituency || merged.constituency,
    ],
    ["**son", "Candidate", fields.candidateName],
    ["Aged", "Parent/Spouse Name", fields.fatherMotherHusbandName],
    ["years", "Age", fields.age],
    ["resident of", "Postal Address", fields.postalAddress],
    [
      "set up by",
      "Party",
      fields.party || (fields.isIndependent ? "INDEPENDENT" : ""),
    ],
    ["Serial No", "Electoral Roll Serial", fields.serialNumber],
    ["Part No", "Electoral Roll Part", fields.partNumber],
    ["telephone number", "Telephone", fields.telephone || fields.contactNumber],
    ["e-mail", "Email", fields.email || fields.emailId],
    ["Social media", "Social Media (i)", fields.socialMedia1],
    ["Social media", "Social Media (ii)", fields.socialMedia2],
    ["Social media", "Social Media (iii)", fields.socialMedia3],
    [
      "Self",
      "Profession (Self)",
      fields.selfProfession || fields.professionSelf,
    ],
    [
      "Spouse",
      "Profession (Spouse)",
      fields.spouseProfession || fields.professionSpouse,
    ],
    [
      "Source of income",
      "Income Source (Self)",
      fields.selfIncome || fields.sourceOfIncomeSelf,
    ],
    [
      "Source of income",
      "Income Source (Spouse)",
      fields.spouseIncome || fields.sourceOfIncomeSpouse,
    ],
    [
      "dependents",
      "Income Source (Dependents)",
      fields.dependentIncome || fields.sourceOfIncomeDependents,
    ],
    [
      "educational qualification",
      "Education",
      fields.educationalQualification || fields.education,
    ],
    ["before me", "Oath Commissioner", fields.oathCommissionerName],
    ["disputed", "Disputed Liabilities", fields.disputedLiabilities],
  ];

  for (const [marker, label, value] of calloutMap) {
    xml = insertCalloutAboveDottedLine(xml, marker, label, value);
  }

  return xml;
}

function appendInputSummarySection(xml, merged) {
  const lines = buildInputSummaryLines(merged);
  if (!Array.isArray(lines) || lines.length === 0) return xml;

  const paragraphs = lines
    .map((line, idx) => {
      const safe = escapeXml(line);
      if (idx === 0) {
        return `<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:after="160"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="30"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
      }
      const isSectionTitle =
        line === "Candidate & Election Details" ||
        line === "Profession, Income & Education" ||
        line === "Contracts / Government / Verification" ||
        line === "Captured Tables";
      if (isSectionTitle) {
        return `<w:p><w:pPr><w:spacing w:before="140" w:after="80"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
      }
      return `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    })
    .join("");

  return xml.replace("</w:body>", `${paragraphs}</w:body>`);
}

export async function fillAffidavitTemplate(merged, options = {}) {
  const zip = new AdmZip(TEMPLATE_PATH);
  let xml = zip.readAsText("word/document.xml");

  const fields = merged.fields || {};

  // Step 1: Replace text placeholders (……… patterns)
  xml = replaceTextPlaceholders(xml, fields, merged);

  // Step 2: Fill criminal record declarations
  xml = fillCriminalDeclarations(xml, merged);

  // Step 3: Fill specific template tables
  xml = fillTableCells(xml, merged);

  // Step 4: Fill any remaining generic tables from OCR
  xml = fillGenericTables(xml, merged);

  // Step 5: Embed images (photo, signature) if URLs provided
  xml = await embedImages(zip, xml, merged);

  // Step 6: Optional hint cleanup (disabled by default to preserve original template wording).
  if (options.cleanupHints === true) {
    xml = cleanupBracketHints(xml);
  }

  // Optional debug overlays are disabled by default to keep exported DOCX identical to template layout.
  if (options.includeDebugOverlay === true) {
    xml = insertInputCalloutsNearDottedText(xml, merged);
    xml = appendInputSummarySection(xml, merged);
  }

  // Write back modified XML
  zip.updateFile("word/document.xml", Buffer.from(xml, "utf8"));

  return zip.toBuffer();
}

/**
 * Check if the template file exists.
 */
export function templateExists() {
  try {
    const AdmZipCheck = AdmZip;
    new AdmZipCheck(TEMPLATE_PATH);
    return true;
  } catch {
    return false;
  }
}
