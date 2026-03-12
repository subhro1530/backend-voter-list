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
function replaceDotsBetween(xml, contextBefore, contextAfter, value) {
  if (!value) return xml;

  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAfter = contextAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Dot characters: … (U+2026) and . (period)
  const dotChars = `[…\\.]+`;
  // XML structure that may appear between dot runs (run boundaries + proofErr tags)
  const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;

  // Pattern: before + (dots with optional XML gaps between runs) + optional trailing whitespace/gap + after
  // Allow optional whitespace before contextAfter (common in template)
  const pattern = new RegExp(
    `(${escBefore})((?:${dotChars}${xmlGap})*${dotChars}(?:${xmlGap})?)\\s*(${escAfter})`,
    "s",
  );

  const match = xml.match(pattern);
  if (match) {
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
            return (openTag || "") + escapeXml(value) + (closeTag || "");
          }
          // Clear subsequent dot runs
          return (openTag || "") + (closeTag || "");
        },
      );
      return xml.replace(match[0], match[1] + dotsSection + " " + match[3]);
    }
    // Same-run: simple replacement
    return xml.replace(pattern, `$1${escapeXml(value)} $3`);
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
    return xml.replace(pattern, `$1${value}$3`);
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
  return xmlFragment.replace(/<[^>]+>/g, "").trim();
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
    // Replace the first empty or existing <w:t> content
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
  const dotChars = `[…\\.]+`;
  const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;

  const pattern = new RegExp(
    `(${escBefore})((?:${dotChars}${xmlGap})*${dotChars})`,
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
            return (openTag || "") + escapeXml(value) + (closeTag || "");
          }
          return (openTag || "") + (closeTag || "");
        },
      );
      return xml.replace(match[0], match[1] + dotsSection);
    }
    return xml.replace(match[0], `${match[1]}${escapeXml(value)}`);
  }
  return xml;
}

// ─────────────────────────────────────────────
// MAIN: TEXT PLACEHOLDER REPLACEMENT
// ─────────────────────────────────────────────

function replaceTextPlaceholders(xml, fields, merged) {
  // 1. TO………………..(NAME OF THE HOUSE) → house/constituency
  const houseName =
    fields.houseName ||
    fields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "TO", "(NAME", houseName);

  // 2. FROM……………………………CONSTITUENCY → constituency
  const constituency =
    fields.constituency ||
    fields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "FROM", "CONSTITUENCY", constituency);

  // 3. I………………… **son/daughter/wife → candidate name
  const candidateName = fields.candidateName || "";
  xml = replaceDotsBetween(xml, "I", "**son", candidateName);

  // 4. of………………………….Aged → father/mother/husband name
  const parentName = fields.fatherMotherHusbandName || "";
  xml = replaceDotsBetween(xml, "of", "Aged", parentName);

  // 5. Aged…………………………….. → age
  // This appears as: ….Aged followed by dots in same/next run, then years
  const age = fields.age || "";
  if (age) {
    // Pattern in XML: Aged…………… then ….. then \nyears
    xml = replaceDotsBetween(xml, "Aged", "years", age + " ");
    // Also handle if Aged dots are in separate pattern
    xml = replaceDotsBetween(xml, "….Aged", "years", age + " ");
  }

  // 6. resident of…………………………(mention full postal address)
  const address = fields.postalAddress || "";
  xml = replaceDotsBetween(
    xml,
    "resident of",
    "(mention full postal address)",
    address,
  );

  // 7. set up by------------------------------ → party name
  const party = fields.party || "";
  xml = replaceDashesBetween(xml, "set up by", "\n", party);
  // Try alternative pattern
  if (party) {
    const dashPattern = /set up by(-{3,})/;
    const dashMatch = xml.match(dashPattern);
    if (dashMatch) {
      xml = xml.replace(dashMatch[0], `set up by ${escapeXml(party)}`);
    }
  }

  // 8. enrolled in…………………………………………(Name → constituency enrollment
  const enrolledIn =
    fields.enrolledConstituency ||
    fields.assemblyConstituency ||
    merged.constituency ||
    "";
  xml = replaceDotsBetween(xml, "enrolled in", "(", enrolledIn);

  // 9. Serial No……….in Part No → serial and part numbers
  const serialNo = fields.serialNumber || "";
  const partNo = fields.partNumber || "";
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
  const phone = fields.telephone || fields.contactNumber || "";
  xml = replaceDotsBetween(xml, "is/are", "and my e-mail", phone);

  // 11. e-mail id (if any) is…………………………… → email
  const email = fields.email || fields.emailId || "";
  xml = replaceDotsBetween(xml, "any) is", "and my social media", email);

  // 12. Social media accounts (i)…… (ii)……… (iii)………
  const social1 = fields.socialMedia1 || "";
  const social2 = fields.socialMedia2 || "";
  const social3 = fields.socialMedia3 || "";
  if (social1) {
    xml = replaceDotsBetween(xml, "(i)", "(ii)", social1 + "  ");
  }
  if (social2) {
    xml = replaceDotsBetween(xml, "(ii)", "(iii)", social2);
  }
  if (social3) {
    const dotChars = `[…\\.]+`;
    const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
    const s3Pattern = new RegExp(
      `(\\(iii\\))((?:${dotChars}${xmlGap})*${dotChars})`,
      "s",
    );
    const s3Match = xml.match(s3Pattern);
    if (s3Match) {
      xml = xml.replace(s3Match[0], `(iii) ${escapeXml(social3)}`);
    }
  }

  // 13. (a) Self……………… (b) Spouse ……………… (profession)
  const selfProfession = fields.selfProfession || fields.professionSelf || "";
  const spouseProfession =
    fields.spouseProfession || fields.professionSpouse || "";
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
  const selfIncome = fields.selfIncome || fields.sourceOfIncomeSelf || "";
  const spouseIncome = fields.spouseIncome || fields.sourceOfIncomeSpouse || "";
  const depIncome =
    fields.dependentIncome || fields.sourceOfIncomeDependents || "";
  if (selfIncome) {
    xml = replaceDotsBetween(xml, "Self ", "Spouse", selfIncome + "\n");
  }
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
      fields.contractsCandidate || "",
    ],
    [
      "details of contracts entered into by spouse",
      fields.contractsSpouse || "",
    ],
    [
      "details of contracts entered into by dependents",
      fields.contractsDependents || "",
    ],
  ];
  for (const [context, val] of contractFields) {
    if (val) {
      const dotChars = `[…\\.]+`;
      const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
      const cPattern = new RegExp(
        `(${context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})((?:${dotChars}${xmlGap})*${dotChars})`,
        "s",
      );
      const cMatch = xml.match(cPattern);
      if (cMatch) {
        xml = xml.replace(cMatch[0], `${context} ${escapeXml(val)}`);
      }
    }
  }

  // 16. Educational qualification ………………………
  const education = fields.educationalQualification || fields.education || "";
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
  }

  // 17. Verification: at………… this the……day of………
  const verifyPlace = fields.verificationPlace || fields.place || "";
  const verifyDate = fields.date || fields.verificationDate || "";
  if (verifyPlace) {
    xml = replaceDotsBetween(xml, "at", "this", verifyPlace);
  }
  if (verifyDate) {
    // Parse date to get day and month/year
    const dateParts = verifyDate.match(
      /(\d{1,2})[\/\-.](\d{1,2}|\w+)[\/\-.](\d{2,4})/,
    );
    if (dateParts) {
      xml = replaceDotsBetween(xml, "the", "day of", dateParts[1]);
      // month………. (trailing dots after "day of")
      const dotChars = `[…\\.]+`;
      const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;
      const monthPattern = new RegExp(
        `(day of)((?:${dotChars}${xmlGap})*${dotChars})`,
        "s",
      );
      const monthMatch = xml.match(monthPattern);
      if (monthMatch) {
        const monthYear = `${dateParts[2]}/${dateParts[3]}`;
        xml = xml.replace(monthMatch[0], `day of ${escapeXml(monthYear)}`);
      }
    }
  }

  // 18. Government accommodation details
  const govAccom =
    fields.governmentAccommodation || merged.governmentAccommodation || {};
  if (govAccom.address) {
    xml = replaceDotsAfter(xml, "accommodation", govAccom.address);
  }
  if (govAccom.duesDate) {
    xml = replaceDotsAfter(xml, "as on date", govAccom.duesDate);
  }

  // 19. Oath Commissioner / Notary details
  if (fields.oathCommissionerName) {
    xml = replaceDotsAfter(xml, "before me", fields.oathCommissionerName);
  }

  // 20. Disputed liabilities field
  if (fields.disputedLiabilities) {
    xml = replaceDotsAfter(xml, "disputed", fields.disputedLiabilities);
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
        const newCellXml = setCellText(row.cells[c].xml, dataRow[c]);
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
export async function fillAffidavitTemplate(merged) {
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
