/**
 * Nomination Paper (Form 2B) DOCX Template Filler
 *
 * Fills the original "NOMINATION FORM FOR VIDHAN SABHA WORD.docx" template.
 * Preserves ALL original formatting, borders, fonts, tables, and layout.
 *
 * Strategy:
 *   1. Read the template DOCX (which is a ZIP containing XML)
 *   2. Replace ellipsis/dot placeholders in document.xml with field values
 *   3. Fill the proposers table (10 rows × 6 columns)
 *   4. Return modified DOCX as Buffer
 */

import AdmZip from "adm-zip";
import path from "path";

const TEMPLATE_PATH = path.join(
  process.cwd(),
  "NOMINATION FORM FOR VIDHAN SABHA WORD.docx",
);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

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
 * Replace ellipsis/dot patterns between context markers.
 */
function replaceDotsBetween(xml, contextBefore, contextAfter, value) {
  if (!value) return xml;

  const escBefore = contextBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAfter = contextAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const dotChars = `[…\\.]+`;
  const xmlGap = `(?:</w:t></w:r>(?:<w:proofErr[^/]*/?>)*<w:r>(?:<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?<w:t[^>]*>)?`;

  const pattern = new RegExp(
    `(${escBefore})((?:${dotChars}${xmlGap})*${dotChars}(?:${xmlGap})?)\\s*(${escAfter})`,
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
      return xml.replace(match[0], match[1] + dotsSection + " " + match[3]);
    }
    return xml.replace(pattern, `$1${escapeXml(value)} $3`);
  }
  return xml;
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

function extractText(xmlFragment) {
  return xmlFragment.replace(/<[^>]+>/g, "").trim();
}

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
    rows.push({ start: startPos, end: trEnd + 7, xml: rowXml, cells });
    pos = trEnd + 7;
  }
  return rows;
}

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

function setCellText(cellXml, value) {
  if (!value && value !== 0) return cellXml;
  const strValue = String(value);

  const tMatch = cellXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
  if (tMatch) {
    return cellXml.replace(
      tMatch[0],
      `<w:t xml:space="preserve">${escapeXml(strValue)}</w:t>`,
    );
  }

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

// ─────────────────────────────────────────────
// TEXT PLACEHOLDER REPLACEMENT
// ─────────────────────────────────────────────

function replaceTextPlaceholders(xml, fields) {
  // Header: Election to the Legislative Assembly of...........(State)
  xml = replaceDotsBetween(xml, "Assembly of", "(State", fields.state || "");

  // ── PART I ──

  // "from the.........Assembly Constituency" (Part I)
  if (fields.partI_constituency) {
    xml = replaceDotsBetween(
      xml,
      "from the",
      "Assembly Constituency",
      fields.partI_constituency,
    );
  }

  // "Candidate's name..............Father's" (Part I)
  if (fields.partI_candidateName) {
    xml = replaceDotsBetween(
      xml,
      "Candidate\u2019s name",
      "Father",
      fields.partI_candidateName,
    );
  }

  // "Father's/mother's/husband's name.................His postal" (Part I)
  if (fields.partI_fatherName) {
    xml = replaceDotsBetween(
      xml,
      "husband\u2019s name",
      "His postal",
      fields.partI_fatherName,
    );
  }

  // "His postal address……………………." (Part I)
  if (fields.partI_postalAddress) {
    xml = replaceDotsAfter(xml, "postal address", fields.partI_postalAddress);
  }

  // "at Sl. No..........in Part No" (Part I candidate)
  if (fields.partI_candidateSlNo) {
    xml = replaceDotsBetween(
      xml,
      "Sl. No",
      "in Part No",
      fields.partI_candidateSlNo,
    );
  }

  // "Part No................of the electoral roll for" (Part I candidate)
  if (fields.partI_candidatePartNo) {
    xml = replaceDotsBetween(
      xml,
      "Part No",
      "of the electoral roll for",
      fields.partI_candidatePartNo,
    );
  }

  // "for ...............Assembly constituency" (Part I candidate)
  if (fields.partI_candidateConstituency) {
    xml = replaceDotsBetween(
      xml,
      "roll for ",
      "Assembly constituency",
      fields.partI_candidateConstituency,
    );
  }

  // "My name is ..................and" (Part I proposer)
  if (fields.partI_proposerName) {
    xml = replaceDotsBetween(
      xml,
      "My name is ",
      "and",
      fields.partI_proposerName,
    );
  }

  // "Sl. No. ............in Part No" (Part I proposer)
  if (fields.partI_proposerSlNo) {
    xml = replaceDotsBetween(
      xml,
      "Sl. No. ",
      "in Part No",
      fields.partI_proposerSlNo,
    );
  }

  // "Part No................of the electoral roll for the" (Part I proposer)
  if (fields.partI_proposerPartNo) {
    xml = replaceDotsBetween(
      xml,
      "Part No",
      "of the electoral roll for the",
      fields.partI_proposerPartNo,
    );
  }

  // "for the.................................................Assembly constituency" (Part I proposer)
  if (fields.partI_proposerConstituency) {
    xml = replaceDotsBetween(
      xml,
      "for the",
      "Assembly constituency",
      fields.partI_proposerConstituency,
    );
  }

  // "Date ...................." (Part I)
  if (fields.partI_date) {
    xml = replaceDotsAfter(xml, "Date ", fields.partI_date);
  }

  // ── PART II ──

  // "from the..................Assembly Constituency" (Part II)
  if (fields.partII_constituency) {
    // This is the second occurrence — use a more unique context
    xml = replaceDotsBetween(
      xml,
      "from the",
      "Assembly Constituency",
      fields.partII_constituency,
    );
  }

  // Part II - candidate name, father name, address, sl no, part no, constituency
  // Same patterns repeat for Part II — they will be the NEXT occurrence after Part I was already filled
  if (fields.partII_candidateName) {
    xml = replaceDotsBetween(
      xml,
      "Candidate\u2019s name",
      "Father",
      fields.partII_candidateName,
    );
  }
  if (fields.partII_fatherName) {
    xml = replaceDotsBetween(
      xml,
      "husband\u2019s name",
      "His postal",
      fields.partII_fatherName,
    );
  }
  if (fields.partII_postalAddress) {
    xml = replaceDotsAfter(xml, "postal address", fields.partII_postalAddress);
  }
  if (fields.partII_candidateSlNo) {
    xml = replaceDotsBetween(
      xml,
      "Sl. No",
      "in Part No",
      fields.partII_candidateSlNo,
    );
  }
  if (fields.partII_candidatePartNo) {
    xml = replaceDotsBetween(
      xml,
      "Part No",
      "of the electoral roll for",
      fields.partII_candidatePartNo,
    );
  }
  if (fields.partII_candidateConstituency) {
    xml = replaceDotsBetween(
      xml,
      "roll for ",
      "Assembly constituency",
      fields.partII_candidateConstituency,
    );
  }

  // ── PART III ──

  // "completed.................years of age"
  if (fields.age) {
    xml = replaceDotsBetween(xml, "completed", "years of age", fields.age);
  }

  // "by the .......................party, which is recognised" (c)(i)
  if (fields.recognisedParty) {
    xml = replaceDotsBetween(
      xml,
      "by the ",
      "party, which is recogn",
      fields.recognisedParty,
    );
  }

  // "by the......................................party, which is a registered" (c)(ii)
  if (fields.unrecognisedParty) {
    xml = replaceDotsBetween(
      xml,
      "by the",
      "party, which is a registered",
      fields.unrecognisedParty,
    );
  }

  // symbols: (i).....(ii)......(iii).....
  if (fields.symbol1) {
    xml = replaceDotsBetween(xml, "(i)", "(ii)", fields.symbol1);
  }
  if (fields.symbol2) {
    xml = replaceDotsBetween(xml, "(ii)", "(iii)", fields.symbol2);
  }
  if (fields.symbol3) {
    xml = replaceDotsAfter(xml, "(iii)", fields.symbol3);
  }

  // "spelt out above in............................... (name of the language)"
  if (fields.language) {
    xml = replaceDotsBetween(
      xml,
      "above in",
      "(name of the language)",
      fields.language,
    );
  }

  // "member of the..........................Caste/tribe"
  if (fields.casteTribe) {
    xml = replaceDotsBetween(xml, "member of the", "Caste", fields.casteTribe);
  }
  // Can use ** prefix marker too
  if (fields.casteTribe) {
    xml = replaceDotsBetween(
      xml,
      "member of the",
      "**Caste",
      fields.casteTribe,
    );
  }

  // "State of.........................in relation to"
  if (fields.scStState) {
    xml = replaceDotsBetween(
      xml,
      "State of",
      "in relation to",
      fields.scStState,
    );
  }

  // "in relation to...............(area)"
  if (fields.scStArea) {
    xml = replaceDotsBetween(xml, "relation to", "(area)", fields.scStArea);
  }

  // "Legislative Assembly ............... of (State)"
  if (fields.assemblyState) {
    xml = replaceDotsBetween(
      xml,
      "Assembly ",
      " of (State)",
      fields.assemblyState,
    );
  }

  // "Date....................... " (Part III)
  if (fields.partIII_date) {
    xml = replaceDotsAfter(xml, "Date", fields.partIII_date);
  }

  // ── PART IIIA ── Place and Date at the end

  if (fields.partIIIA_place) {
    xml = replaceDotsAfter(xml, "Place:", fields.partIIIA_place);
  }
  if (fields.partIIIA_date) {
    xml = replaceDotsAfter(xml, "Date:", fields.partIIIA_date);
  }

  // Case/First information report No./Nos.
  if (fields.criminal_firNos) {
    xml = replaceDotsAfter(xml, "report No./Nos.", fields.criminal_firNos);
  }

  // Police station(s)………………District(s)…………………State(s)
  if (fields.criminal_policeStation) {
    xml = replaceDotsBetween(
      xml,
      "Police station(s)",
      "District(s)",
      fields.criminal_policeStation,
    );
  }
  if (fields.criminal_district) {
    xml = replaceDotsBetween(
      xml,
      "District(s)",
      "State(s)",
      fields.criminal_district,
    );
  }
  if (fields.criminal_state) {
    xml = replaceDotsAfter(xml, "State(s)", fields.criminal_state);
  }

  // Section(s) of the concerned Act(s) ... convicted
  if (fields.criminal_sections) {
    xml = replaceDotsAfter(
      xml,
      "which he has been convicted",
      fields.criminal_sections,
    );
  }

  // Date(s) of conviction(s)
  if (fields.criminal_convictionDates) {
    xml = replaceDotsAfter(
      xml,
      "Date(s) of conviction(s)",
      fields.criminal_convictionDates,
    );
  }

  // Court(s) which convicted the candidate
  if (fields.criminal_courts) {
    xml = replaceDotsAfter(
      xml,
      "convicted the candidate",
      fields.criminal_courts,
    );
  }

  // Punishment(s) imposed
  if (fields.criminal_punishment) {
    xml = replaceDotsAfter(xml, "of fine(s)]", fields.criminal_punishment);
  }

  // Date(s) of release from prison
  if (fields.criminal_releaseDates) {
    xml = replaceDotsAfter(
      xml,
      "release from prison",
      fields.criminal_releaseDates,
    );
  }

  // Date and particulars of the appeal(s)
  if (fields.criminal_appealParticulars) {
    xml = replaceDotsAfter(
      xml,
      "for revision filed",
      fields.criminal_appealParticulars,
    );
  }

  // Name of the court(s) before which the appeal(s)
  if (fields.criminal_appealCourts) {
    xml = replaceDotsAfter(
      xml,
      "for revision filed",
      fields.criminal_appealCourts,
    );
  }

  // Date(s) of disposal
  if (fields.criminal_disposalDates) {
    xml = replaceDotsAfter(
      xml,
      "Date(s) of disposal",
      fields.criminal_disposalDates,
    );
  }

  // Nature of order(s) passed
  if (fields.criminal_orderNature) {
    xml = replaceDotsAfter(xml, "order(s) passed", fields.criminal_orderNature);
  }

  // Office of profit details
  if (fields.officeOfProfit_details) {
    xml = replaceDotsAfter(xml, "office held", fields.officeOfProfit_details);
  }

  // Insolvency discharged
  if (fields.insolvency_discharged) {
    xml = replaceDotsAfter(
      xml,
      "discharged from insolvency",
      fields.insolvency_discharged,
    );
  }

  // Foreign allegiance details
  if (fields.foreignAllegiance_details) {
    xml = replaceDotsAfter(
      xml,
      "give details",
      fields.foreignAllegiance_details,
    );
  }

  // Disqualification period
  if (fields.disqualification_period) {
    xml = replaceDotsAfter(
      xml,
      "for which disqualified",
      fields.disqualification_period,
    );
  }

  // Dismissal date
  if (fields.dismissal_date) {
    xml = replaceDotsAfter(
      xml,
      "date of such dismissal",
      fields.dismissal_date,
    );
  }

  // Government contracts details
  if (fields.govContracts_details) {
    xml = replaceDotsAfter(
      xml,
      "subsisting contract(s)",
      fields.govContracts_details,
    );
  }

  // Managing agent details
  if (fields.managingAgent_details) {
    xml = replaceDotsAfter(
      xml,
      "the details thereof",
      fields.managingAgent_details,
    );
  }

  // Section 10A disqualification date
  if (fields.section10A_date) {
    xml = replaceDotsAfter(
      xml,
      "date of disqualification",
      fields.section10A_date,
    );
  }

  // ── PART IV ──

  // "Serial No. of nomination paper ................."
  if (fields.partIV_serialNo) {
    xml = replaceDotsAfter(xml, "nomination paper ", fields.partIV_serialNo);
  }

  // "at my office at..............(hour)"
  if (fields.partIV_hour) {
    xml = replaceDotsBetween(xml, "office at", "(hour)", fields.partIV_hour);
  }

  // "on............(date)"
  if (fields.partIV_date) {
    xml = replaceDotsBetween(xml, "on", "(date)", fields.partIV_date);
  }

  // "Date..................."
  if (fields.partIV_roDate) {
    xml = replaceDotsAfter(xml, "Date", fields.partIV_roDate);
  }

  // ── PART V ──

  // Decision text (the dots/ellipsis after "as follows:")
  if (fields.partV_decision) {
    xml = replaceDotsAfter(xml, "as follows:", fields.partV_decision);
  }

  // "Date.......... " (Part V)
  if (fields.partV_date) {
    xml = replaceDotsAfter(xml, "Date", fields.partV_date);
  }

  // ── PART VI ──

  // "Serial No. of nomination paper......................"
  if (fields.partVI_serialNo) {
    xml = replaceDotsAfter(xml, "nomination paper", fields.partVI_serialNo);
  }

  // "nomination paper of....................................a candidate"
  if (fields.partVI_candidateName) {
    xml = replaceDotsBetween(
      xml,
      "nomination paper of",
      "a candidate",
      fields.partVI_candidateName,
    );
  }

  // "from the................................Assembly constituency"
  if (fields.partVI_constituency) {
    xml = replaceDotsBetween(
      xml,
      "from the",
      "Assembly constituency",
      fields.partVI_constituency,
    );
  }

  // "at..............(hour)" (Part VI)
  if (fields.partVI_hour) {
    xml = replaceDotsBetween(xml, "at", "(hour)", fields.partVI_hour);
  }

  // "on......................(date)" (Part VI)
  if (fields.partVI_date) {
    xml = replaceDotsBetween(xml, "on", "(date)", fields.partVI_date);
  }

  // "at ..............(hour) on.....................(date) at.....(Place)"
  if (fields.partVI_scrutinyHour) {
    xml = replaceDotsBetween(
      xml,
      "scrutiny at ",
      "(hour)",
      fields.partVI_scrutinyHour,
    );
  }
  if (fields.partVI_scrutinyDate) {
    xml = replaceDotsBetween(xml, "on", "(date)", fields.partVI_scrutinyDate);
  }
  if (fields.partVI_scrutinyPlace) {
    xml = replaceDotsBetween(xml, "at", "(Place)", fields.partVI_scrutinyPlace);
  }

  // "Date..............."
  if (fields.partVI_roDate) {
    xml = replaceDotsAfter(xml, "Date", fields.partVI_roDate);
  }

  return xml;
}

// ─────────────────────────────────────────────
// PROPOSER PARAGRAPH FILLING
// ─────────────────────────────────────────────

/**
 * Fill proposer data into the numbered paragraphs (1. through 10.).
 * The DOCX template has numbered paragraphs "1. " "2. " ... "10. " (NOT table rows).
 * Each paragraph gets the proposer data appended as: "PartNo: X | S.No: Y | Name | Signature | Date"
 */
function fillProposerParagraphs(xml, merged) {
  const proposers = merged.proposers || [];
  if (proposers.length === 0) return xml;

  for (let i = 0; i < Math.min(proposers.length, 10); i++) {
    const p = proposers[i] || {};
    const num = i + 1;

    // Build the data string for this proposer
    const parts = [];
    if (p.partNo) parts.push(`Part No: ${p.partNo}`);
    if (p.slNo) parts.push(`S.No: ${p.slNo}`);
    if (p.fullName) parts.push(p.fullName);
    if (p.signature) parts.push(p.signature);
    if (p.date) parts.push(p.date);

    if (parts.length === 0) continue;

    const dataStr = parts.join("  |  ");
    const escapedData = escapeXml(dataStr);

    // Find the paragraph containing just "N. " or "N." and append data
    // Pattern: <w:t..."N. "</w:t> or <w:t>"N."</w:t>
    const numStr = String(num);
    const patterns = [
      // "N. " with xml:space="preserve"
      new RegExp(`(<w:t[^>]*>)(${numStr}\\. )(</w:t>)`, "s"),
      // "N." without trailing space
      new RegExp(`(<w:t[^>]*>)(${numStr}\\.)(</w:t>)`, "s"),
    ];

    let found = false;
    for (const pattern of patterns) {
      const match = xml.match(pattern);
      if (match) {
        // Replace the text content to include proposer data
        xml = xml.replace(
          match[0],
          `${match[1]}${match[2]}${escapedData} ${match[3]}`,
        );
        found = true;
        break;
      }
    }

    if (!found) {
      // Fallback: try to find "N." as standalone text run and append a new run after it
      const fallbackPattern = new RegExp(
        `(<w:r>(?:<w:rPr>[^]*?</w:rPr>)?<w:t[^>]*>${numStr}\\.\\s*</w:t></w:r>)`,
        "s",
      );
      const fallbackMatch = xml.match(fallbackPattern);
      if (fallbackMatch) {
        const newRun = `<w:r><w:t xml:space="preserve"> ${escapedData}</w:t></w:r>`;
        xml = xml.replace(fallbackMatch[0], fallbackMatch[0] + newRun);
      }
    }
  }

  return xml;
}

// ─────────────────────────────────────────────
// IMAGE EMBEDDING HELPER
// ─────────────────────────────────────────────

let imageCounter = 100; // start high to avoid conflicts with existing images

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
  const mediaPath = `word/media/custom_image${imageId}.${ext}`;
  zip.addFile(mediaPath, imageBuffer);

  // Add relationship
  let rels = zip.readAsText("word/_rels/document.xml.rels");
  const relId = `rIdCustomImg${imageId}`;
  const relEntry = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/custom_image${imageId}.${ext}"/>`;
  rels = rels.replace("</Relationships>", relEntry + "</Relationships>");
  zip.updateFile("word/_rels/document.xml.rels", Buffer.from(rels, "utf8"));

  return relId;
}

function getInlineImageXml(relId, widthCm, heightCm) {
  // 1 cm = 360000 EMU
  const cx = Math.round(widthCm * 360000);
  const cy = Math.round(heightCm * 360000);
  const docPrId = imageCounter++;
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="Image${docPrId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="img${docPrId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

/**
 * Embed images (photograph, signature) into the DOCX.
 * Inserts them at known placeholder locations in the document.
 */
async function embedImages(zip, xml, merged) {
  const fields = merged.fields || {};

  // Candidate photograph — insert near "stamp size" text or at beginning
  if (fields.candidatePhotoUrl) {
    const imgBuf = await downloadImage(fields.candidatePhotoUrl);
    if (imgBuf) {
      const relId = addImageToDocx(zip, imgBuf, 1);
      const imgXml = getInlineImageXml(relId, 2, 2.5); // 2cm x 2.5cm as per form
      // Find "photograph" text and insert image run before that paragraph
      const photoMatch = xml.match(/(<w:p [^>]*>[^]*?photograph[^]*?<\/w:p>)/i);
      if (photoMatch) {
        const imgPara = `<w:p><w:r>${imgXml}</w:r></w:p>`;
        xml = xml.replace(photoMatch[0], imgPara + photoMatch[0]);
      }
    }
  }

  // Candidate signature — insert near "Signature of Candidate" or "Signature of candidate"
  if (fields.candidateSignatureUrl) {
    const imgBuf = await downloadImage(fields.candidateSignatureUrl);
    if (imgBuf) {
      const relId = addImageToDocx(zip, imgBuf, 2);
      const imgXml = getInlineImageXml(relId, 4, 1.5); // signature size
      // Find first "Signature of Candidate" and insert image before it
      const sigMatch = xml.match(
        /(<w:p [^>]*>[^]*?Signature of (?:the )?[Cc]andidate[^]*?<\/w:p>)/,
      );
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

export async function fillNominationTemplate(merged) {
  const zip = new AdmZip(TEMPLATE_PATH);
  let xml = zip.readAsText("word/document.xml");

  const fields = merged.fields || {};

  // Step 1: Replace text placeholders
  xml = replaceTextPlaceholders(xml, fields);

  // Step 2: Fill proposer paragraphs (1. through 10.)
  xml = fillProposerParagraphs(xml, merged);

  // Step 3: Embed images (photo, signature) if URLs provided
  xml = await embedImages(zip, xml, merged);

  // Write back modified XML
  zip.updateFile("word/document.xml", Buffer.from(xml, "utf8"));

  return zip.toBuffer();
}

export function nominationTemplateExists() {
  try {
    new AdmZip(TEMPLATE_PATH);
    return true;
  } catch {
    return false;
  }
}
