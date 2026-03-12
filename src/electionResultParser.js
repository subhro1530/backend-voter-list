/**
 * Election Result Parser
 * Parses OCR output from Form 20 Final Result Sheet PDFs
 * Extracts booth-wise voting data with dynamic candidate names and vote counts
 *
 * Created by: Shaswata Saha | ssaha.vercel.app
 */

function cleanJsonText(text) {
  if (!text) return "";
  let cleaned = text.trim();
  // Remove markdown code fences
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  // Remove any leading/trailing junk before/after JSON
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

/**
 * Parse election result data from Gemini OCR output
 */
export function parseElectionResult(text) {
  const empty = {
    constituency: "",
    assemblyName: "",
    totalElectors: null,
    candidates: [],
    boothResults: [],
    totals: null,
    pageNumber: null,
  };

  if (!text) return empty;

  const cleaned = cleanJsonText(text);

  try {
    const parsed = JSON.parse(cleaned);

    // Normalize the parsed data
    const result = {
      constituency:
        parsed.constituency ||
        parsed.assemblyConstituency ||
        parsed.assembly_constituency ||
        parsed.nameOfAssembly ||
        parsed.name_of_assembly ||
        "",
      assemblyName:
        parsed.assemblyName ||
        parsed.assembly_name ||
        parsed.assembly ||
        parsed.assemblySegment ||
        "",
      totalElectors:
        parsed.totalElectors ||
        parsed.total_electors ||
        parsed.totalNoOfElectors ||
        parsed.total_no_of_electors ||
        null,
      candidates: [],
      boothResults: [],
      totals: parsed.totals || parsed.summary || null,
      pageNumber: parsed.pageNumber || parsed.page_number || null,
    };

    // If constituency empty, try assemblyName
    if (!result.constituency && result.assemblyName) {
      result.constituency = result.assemblyName;
    }

    // Parse totalElectors as number
    if (typeof result.totalElectors === "string") {
      result.totalElectors =
        parseInt(result.totalElectors.replace(/[,\s]/g, "")) || null;
    }

    // Extract candidates from multiple possible locations
    let rawCandidates =
      parsed.candidates ||
      parsed.candidateNames ||
      parsed.candidate_names ||
      [];

    // If candidates is an array of objects, extract names
    if (
      Array.isArray(rawCandidates) &&
      rawCandidates.length > 0 &&
      typeof rawCandidates[0] === "object"
    ) {
      rawCandidates = rawCandidates.map(
        (c) => c.name || c.candidateName || c.candidate_name || "",
      );
    }

    result.candidates = Array.isArray(rawCandidates)
      ? rawCandidates.filter((c) => c && typeof c === "string" && c.trim())
      : [];

    // Process booth results
    const rawResults =
      parsed.boothResults ||
      parsed.booth_results ||
      parsed.results ||
      parsed.rows ||
      parsed.data ||
      parsed.pollingStationResults ||
      [];

    if (Array.isArray(rawResults)) {
      result.boothResults = rawResults
        .map((row) => {
          if (!row || typeof row !== "object") return null;

          // Extract candidate votes - try multiple field names
          let candidateVotes =
            row.candidateVotes ||
            row.candidate_votes ||
            row.votes ||
            row.votesReceived ||
            row.votes_received ||
            {};

          // If candidateVotes is an array, convert to object using candidate names
          if (Array.isArray(candidateVotes) && result.candidates.length > 0) {
            const obj = {};
            candidateVotes.forEach((v, i) => {
              if (i < result.candidates.length) {
                obj[result.candidates[i]] =
                  typeof v === "number" ? v : parseInt(v) || 0;
              }
            });
            candidateVotes = obj;
          }

          // Ensure all vote values are numbers
          const cleanedVotes = {};
          for (const [key, val] of Object.entries(candidateVotes)) {
            cleanedVotes[key] =
              typeof val === "number" ? val : parseInt(val) || 0;
          }

          const serialNo =
            row.serialNo ?? row.serial_no ?? row.sl ?? row.slNo ?? null;
          const boothNo =
            row.boothNo ||
            row.booth_no ||
            row.pollingStation ||
            row.polling_station ||
            row.pollingStationNo ||
            row.polling_station_no ||
            "";

          return {
            serialNo:
              typeof serialNo === "number"
                ? serialNo
                : parseInt(serialNo) || null,
            boothNo: String(boothNo),
            candidateVotes: cleanedVotes,
            totalValidVotes:
              parseInt(
                row.totalValidVotes ??
                  row.total_valid_votes ??
                  row.validVotes ??
                  0,
              ) || 0,
            rejectedVotes:
              parseInt(
                row.rejectedVotes ?? row.rejected_votes ?? row.rejected ?? 0,
              ) || 0,
            nota: parseInt(row.nota ?? row.NOTA ?? 0) || 0,
            totalVotes:
              parseInt(row.totalVotes ?? row.total_votes ?? row.total ?? 0) ||
              0,
            tenderedVotes:
              parseInt(
                row.tenderedVotes ?? row.tendered_votes ?? row.tendered ?? 0,
              ) || 0,
          };
        })
        .filter(Boolean);
    }

    // Extract candidate names from booth results if not found at top level
    if (result.candidates.length === 0 && result.boothResults.length > 0) {
      // Use the first row's keys (left-to-right order preserved)
      const firstRow = result.boothResults[0];
      if (firstRow) {
        result.candidates = Object.keys(firstRow.candidateVotes);
      }
    }

    // Sanity check: ensure booth candidateVotes keys match candidates array
    // If candidates array exists and booths have different keys, re-key booths by position
    if (result.candidates.length > 0 && result.boothResults.length > 0) {
      for (const booth of result.boothResults) {
        const boothKeys = Object.keys(booth.candidateVotes || {});
        const boothValues = Object.values(booth.candidateVotes || {});

        // If keys don't match candidates but count matches, re-key by position
        if (boothKeys.length === result.candidates.length) {
          const keysMatch = boothKeys.every(
            (k, i) => k === result.candidates[i],
          );
          if (!keysMatch) {
            const newVotes = {};
            for (let i = 0; i < result.candidates.length; i++) {
              newVotes[result.candidates[i]] = boothValues[i] || 0;
            }
            booth.candidateVotes = newVotes;
          }
        }
      }
    }

    // Process totals - normalize structure
    if (result.totals && typeof result.totals === "object") {
      const normalized = {};
      const totalMapping = {
        evmVotes: [
          "evmVotes",
          "evm_votes",
          "evm",
          "totalEVMVotes",
          "total_evm_votes",
        ],
        postalVotes: [
          "postalVotes",
          "postal_votes",
          "postal",
          "postalBallotVotes",
          "postal_ballot_votes",
        ],
        totalVotesPolled: [
          "totalVotesPolled",
          "total_votes_polled",
          "total",
          "grandTotal",
          "grand_total",
        ],
      };

      for (const [normalKey, aliases] of Object.entries(totalMapping)) {
        for (const alias of aliases) {
          if (result.totals[alias]) {
            normalized[normalKey] = result.totals[alias];
            break;
          }
        }
      }

      // If totals has direct candidate data (not nested), treat as totalVotesPolled
      if (Object.keys(normalized).length === 0) {
        const metaFields = new Set([
          "totalValidVotes",
          "total_valid_votes",
          "rejectedVotes",
          "rejected_votes",
          "nota",
          "NOTA",
          "totalVotes",
          "total_votes",
          "tenderedVotes",
          "tendered_votes",
        ]);
        const hasCandidate = Object.keys(result.totals).some(
          (k) => !metaFields.has(k),
        );
        if (hasCandidate) {
          normalized.totalVotesPolled = result.totals;
        }
      }

      result.totals = Object.keys(normalized).length > 0 ? normalized : null;
    }

    return result;
  } catch (err) {
    console.error("Election result JSON parse error:", err.message);
    console.error("Raw text (first 500 chars):", text.substring(0, 500));
    // Try plain text parsing as fallback
    return parseElectionResultFromText(text);
  }
}

/**
 * Fallback plain text parser for election results
 */
function parseElectionResultFromText(text) {
  const constituency =
    pullValue(/(?:Name\s+of\s+Assembly[/]?segment)[^.]*\.{2,}\s*(.+)/i, text) ||
    pullValue(/(?:Assembly|Constituency)[^:]*[:.]+\s*(.+)/i, text);
  const totalElectorsStr =
    pullValue(/Total\s+No\.?\s+of\s+Electors[^.]*\.{2,}\s*(\d[\d,]*)/i, text) ||
    pullValue(/Total\s+No\.?\s+of\s+Electors[^:]*:\s*(\d[\d,]*)/i, text);

  return {
    constituency: constituency || "",
    assemblyName: "",
    totalElectors: totalElectorsStr
      ? parseInt(totalElectorsStr.replace(/,/g, ""))
      : null,
    candidates: [],
    boothResults: [],
    totals: null,
    pageNumber: null,
  };
}

function pullValue(pattern, source) {
  const match = source.match(pattern);
  return match ? match[1].trim() : "";
}

/**
 * Build the OCR prompt for election result pages.
 * The prompt is designed to extract the exact Form 20 structure.
 * @param {boolean} isFirstPage - Whether this is the first page of the PDF
 * @param {string[]} page1Candidates - Candidate names extracted from page 1 (used for continuation pages)
 */
export function getElectionResultOCRPrompt(
  isFirstPage = false,
  page1Candidates = [],
) {
  if (isFirstPage) {
    return `You are an expert OCR data extractor. You are analyzing Page 1 of an Indian Election Commission "FORM 20 - FINAL RESULT SHEET" PDF.

LOOK AT THE DOCUMENT CAREFULLY. At the top you will find:
- "Total No. of Electors in Assembly Constituency/segment ....NUMBER"
- "Name of Assembly/segment ...NAME Assembly Election"

The table has these EXACT columns (left to right):
- Column 1: "Sl. No." or "Serial No. Of Polling Station" (the serial/row number)
- Column 2: The booth/polling station number (may be like 1, 2, 3, 5(A), 7(A), 10(A), etc.)
- THEN several columns under the header "No of Valid Votes Cast in favour of" — each sub-column has a CANDIDATE NAME as its header. These names are DIFFERENT for every PDF. Extract them EXACTLY as printed.
- After the candidate columns: "Total of Valid Votes"
- Then: "No. Of Rejected Votes (Test Votes)"
- Then: "Votes for NOTA option"
- Then: "Total Votes"
- Then: "No. Of Tendered Votes"

CRITICAL — READ THE HEADER ROW CAREFULLY:
- The candidate names are in the table header cells in the row below the "No of Valid Votes Cast in favour of" merged header.
- They may span 2-3 lines within a single cell. Combine them into one name. For example if a header cell says "DR KAKOLI" on line 1, "GHOSH" on line 2, "DASTIDAR" on line 3, the candidate name is "DR KAKOLI GHOSH DASTIDAR".
- Count the EXACT number of candidate columns by looking at the header cells between "Booth No." and "Total of Valid Votes". Each cell is ONE candidate.
- DO NOT split a single candidate's name into multiple candidates. A multi-line name in ONE cell = ONE candidate.
- DO NOT invent or hallucinate candidate names. Only extract names that are ACTUALLY PRINTED in the header cells.
- The number of numeric vote columns in each data row MUST equal the number of candidate name columns in the header.

Return ONLY valid JSON (no markdown, no explanation, no prose):
{
  "constituency": "exact text from header area, e.g. '100-HABRA'",
  "totalElectors": 248989,
  "candidates": ["FULL NAME 1", "FULL NAME 2", "FULL NAME 3", ...],
  "boothResults": [
    {
      "serialNo": 1,
      "boothNo": "1",
      "candidateVotes": {"FULL NAME 1": 633, "FULL NAME 2": 31, "FULL NAME 3": 85, ...},
      "totalValidVotes": 1074,
      "rejectedVotes": 0,
      "nota": 9,
      "totalVotes": 1083,
      "tenderedVotes": 0
    }
  ],
  "totals": null
}

RULES:
1. "candidates" array MUST contain ONLY the candidate names from the column headers, in left-to-right order. Do NOT add any names that are not in the header.
2. In each booth row, "candidateVotes" keys MUST exactly match the strings in "candidates". The number of keys must equal candidates.length.
3. ALL values must be numbers, NOT strings. Parse "226,465" as 226465.
4. Extract EVERY data row on the page. Do not skip any.
5. The "serialNo" is the first column (1, 2, 3...) and "boothNo" is the second column (could be 1, 2, 5(A), 7(A), etc.). They may differ!
6. Set "totals" to null on this page unless there are summary rows at the bottom.
7. Return ONLY the JSON object — no markdown fences, no text before or after.
8. VERIFY: count the candidate columns in the header, count the vote number columns in row 1. They MUST be equal. If they differ, you miscounted — recount.`;
  }

  // Continuation page prompt — with page 1 candidates if available
  if (page1Candidates.length > 0) {
    const candidateList = page1Candidates
      .map((c, i) => `  ${i + 1}. "${c}"`)
      .join("\n");
    const candidateJSON = JSON.stringify(page1Candidates);
    const exampleVotes = page1Candidates.map((c) => `"${c}": 0`).join(", ");

    return `You are an expert OCR data extractor analyzing a continuation page from an Indian Election Commission "FORM 20 - FINAL RESULT SHEET" PDF.

THE CANDIDATE NAMES WERE ALREADY EXTRACTED FROM PAGE 1. There are exactly ${page1Candidates.length} candidates:
${candidateList}

You MUST use these EXACT candidate names as keys. Do NOT rename, rearrange, abbreviate, split, merge, or add any candidate names. The vote columns in the table correspond to these candidates in this exact left-to-right order.

The table columns are (left to right):
- Column 1: Sl. No. / Serial No. of Polling Station
- Column 2: Booth/Polling Station number
- Columns 3 to ${2 + page1Candidates.length}: Vote counts for each candidate (in the order listed above)
- Then: Total of Valid Votes
- Then: No. Of Rejected Votes
- Then: Votes for NOTA option
- Then: Total Votes
- Then: No. Of Tendered Votes

ALSO look for summary rows at the bottom of the page (these are NOT booth rows):
- "Total of votes recorded on EVM" or "Total EVM Votes"
- "Total of Postal Ballot Votes"
- "Total Votes Polled"
These should go in "totals", NOT in "boothResults".

Return ONLY valid JSON:
{
  "constituency": "",
  "totalElectors": null,
  "candidates": ${candidateJSON},
  "boothResults": [
    {
      "serialNo": 1,
      "boothNo": "1",
      "candidateVotes": {${exampleVotes}},
      "totalValidVotes": 0,
      "rejectedVotes": 0,
      "nota": 0,
      "totalVotes": 0,
      "tenderedVotes": 0
    }
  ],
  "totals": null
}

RULES:
1. "candidates" MUST be exactly ${candidateJSON} — do NOT change it.
2. "candidateVotes" keys MUST exactly match those ${page1Candidates.length} names. No extra keys, no missing keys.
3. Map vote columns left-to-right: column 3 → "${page1Candidates[0]}", column 4 → "${page1Candidates[1] || ""}", etc.
4. ALL values must be integer numbers, NOT strings.
5. Extract ALL data rows. Do NOT skip any booth row.
6. Summary/total rows go in "totals", NOT in boothResults.
7. Return ONLY the JSON — no markdown, no prose, no explanation.`;
  }

  // Fallback continuation prompt when page 1 candidates are not available
  return `You are an expert OCR data extractor analyzing a continuation page from an Indian Election Commission "FORM 20 - FINAL RESULT SHEET" PDF.

This is NOT the first page. The table continues from previous pages with the same column structure:
- Sl. No. / Serial No. of Polling Station (row number)
- Booth/Polling Station number
- Multiple candidate vote columns (under "No of Valid Votes Cast in favour of")
- Total of Valid Votes
- No. Of Rejected Votes
- Votes for NOTA option
- Total Votes
- No. Of Tendered Votes

If candidate names are visible in the header on this page, extract them EXACTLY as printed. Count the header cells carefully — each cell is one candidate.

If the header row is not repeated on this page, count the number of numeric columns between "Booth No." and "Total Valid Votes" to determine the candidate count. Use "Candidate1", "Candidate2", etc. as placeholder keys, in left-to-right order.

ALSO look for summary rows at the bottom:
- "Total of votes recorded on EVM" or "Total EVM Votes"
- "Total of Postal Ballot Votes"
- "Total Votes Polled"
These should go in "totals", NOT in "boothResults".

Return ONLY valid JSON:
{
  "constituency": "",
  "totalElectors": null,
  "candidates": ["NAME1", "NAME2", ...],
  "boothResults": [
    {
      "serialNo": 1,
      "boothNo": "1",
      "candidateVotes": {"NAME1": 0, "NAME2": 0, ...},
      "totalValidVotes": 0,
      "rejectedVotes": 0,
      "nota": 0,
      "totalVotes": 0,
      "tenderedVotes": 0
    }
  ],
  "totals": null
}

RULES:
1. Do NOT invent or hallucinate candidate names. Only use names visible in the header, or use "Candidate1", "Candidate2", etc.
2. "candidateVotes" keys MUST exactly match "candidates" array. Same count, same spelling.
3. ALL values must be integer numbers, NOT strings.
4. Extract ALL data rows. Do NOT skip any.
5. Summary/total rows go in "totals", NOT in boothResults.
6. Return ONLY the JSON — no markdown, no prose.`;
}

/**
 * Compute string similarity (Dice coefficient) between two strings.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  a = a
    .toUpperCase()
    .replace(/[^A-Z ]/g, "")
    .trim();
  b = b
    .toUpperCase()
    .replace(/[^A-Z ]/g, "")
    .trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    const count = bigrams.get(bigram) || 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2 * intersectionSize) / (a.length - 1 + (b.length - 1));
}

/**
 * Normalize a candidate name for comparison:
 * Remove honorifics, extra spaces, and standardize.
 */
function normalizeName(name) {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given a list of canonical candidate names from page 1 and a non-canonical name
 * from another page, find the best matching canonical name.
 * Returns the canonical name if similarity > threshold, otherwise null.
 */
function findBestCandidateMatch(name, canonicalNames, threshold = 0.6) {
  if (!name || canonicalNames.length === 0) return null;
  const normalizedName = normalizeName(name);
  let bestMatch = null;
  let bestScore = 0;

  for (const canonical of canonicalNames) {
    const normalizedCanonical = normalizeName(canonical);
    const score = stringSimilarity(normalizedName, normalizedCanonical);
    // Also check if one contains the other (handles partial matches)
    const containsMatch =
      normalizedCanonical.includes(normalizedName) ||
      normalizedName.includes(normalizedCanonical);
    const effectiveScore = containsMatch ? Math.max(score, 0.75) : score;

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestMatch = canonical;
    }
  }

  return bestScore >= threshold ? bestMatch : null;
}

/**
 * Deduplicate a list of candidate names, merging similar names.
 * Returns the deduplicated list and a mapping from original → canonical name.
 */
function deduplicateCandidates(allNames) {
  const canonical = [];
  const mapping = new Map(); // original name → canonical name

  for (const name of allNames) {
    if (mapping.has(name)) continue;

    const match = findBestCandidateMatch(name, canonical, 0.65);
    if (match) {
      mapping.set(name, match);
    } else {
      canonical.push(name);
      mapping.set(name, name);
    }
  }

  return { canonical, mapping };
}

/**
 * Merge results from multiple pages into a single election result.
 * Handles candidate name reconciliation across pages.
 */
export function mergeElectionResults(pageResults) {
  if (!pageResults || pageResults.length === 0) {
    return {
      constituency: "",
      assemblyName: "",
      totalElectors: null,
      candidates: [],
      boothResults: [],
      totals: null,
    };
  }

  // Get constituency & electors from first page that has them
  const constituency =
    pageResults.find((p) => p.constituency)?.constituency || "";
  const assemblyName =
    pageResults.find((p) => p.assemblyName)?.assemblyName || "";
  const totalElectors =
    pageResults.find((p) => p.totalElectors)?.totalElectors || null;

  // Get the canonical candidate list — prefer page 1 (first page with real names)
  let candidates = [];
  for (const page of pageResults) {
    if (page.candidates && page.candidates.length > 0) {
      // Prefer lists with real names over "Candidate1" placeholders
      const hasRealNames = page.candidates.every(
        (c) => !c.match(/^Candidate\d+$/i),
      );
      if (hasRealNames && page.candidates.length > candidates.length) {
        candidates = page.candidates;
        break; // Use the FIRST page with real names (page 1), don't keep looking for longer lists
      }
    }
  }

  // If no real names found, use whatever we have
  if (candidates.length === 0) {
    for (const page of pageResults) {
      if (page.candidates && page.candidates.length > candidates.length) {
        candidates = page.candidates;
      }
    }
  }

  // Collect ALL unique candidate names across all pages to build dedup mapping
  const allCandidateNames = new Set();
  for (const page of pageResults) {
    for (const booth of page.boothResults || []) {
      for (const key of Object.keys(booth.candidateVotes || {})) {
        allCandidateNames.add(key);
      }
    }
  }

  // Build a mapping from any variant name → canonical name
  const nameMapping = new Map();
  for (const name of allCandidateNames) {
    // If it's already a canonical name, map to itself
    if (candidates.includes(name)) {
      nameMapping.set(name, name);
      continue;
    }
    // Check if it's a generic placeholder
    const genericMatch = name.match(/^Candidate(\d+)$/i);
    if (genericMatch) {
      const idx = parseInt(genericMatch[1]) - 1;
      if (idx < candidates.length) {
        nameMapping.set(name, candidates[idx]);
      }
      continue;
    }
    // Try fuzzy matching to a canonical name
    const bestMatch = findBestCandidateMatch(name, candidates, 0.55);
    if (bestMatch) {
      nameMapping.set(name, bestMatch);
      console.log(`📛 Candidate name reconciled: "${name}" → "${bestMatch}"`);
    } else {
      // Unknown name not similar to any canonical — likely hallucinated, skip it
      console.log(
        `⚠️ Candidate name "${name}" doesn't match any page 1 candidate — discarding`,
      );
      nameMapping.set(name, null); // null = discard
    }
  }

  // Reconcile booth results using the mapping
  const allBoothResults = [];
  for (const page of pageResults) {
    for (const booth of page.boothResults || []) {
      const reconciledVotes = {};

      for (const [key, val] of Object.entries(booth.candidateVotes || {})) {
        const canonicalName = nameMapping.get(key);
        if (canonicalName === null || canonicalName === undefined) {
          // Discarded hallucinated name — skip
          continue;
        }
        // If multiple source names map to the same canonical, keep the larger value
        // (handles duplicate columns that shouldn't exist)
        if (reconciledVotes[canonicalName] !== undefined) {
          reconciledVotes[canonicalName] = Math.max(
            reconciledVotes[canonicalName],
            val,
          );
        } else {
          reconciledVotes[canonicalName] = val;
        }
      }

      allBoothResults.push({
        ...booth,
        candidateVotes: reconciledVotes,
      });
    }
  }

  // Get totals — last page that has them, reconcile names too
  let totals = null;
  const lastTotals = pageResults
    .slice()
    .reverse()
    .find((p) => p.totals);

  if (lastTotals?.totals) {
    totals = {};
    for (const [totalKey, totalData] of Object.entries(lastTotals.totals)) {
      if (!totalData || typeof totalData !== "object") continue;
      const reconciled = {};
      for (const [key, val] of Object.entries(totalData)) {
        // Non-candidate meta fields (totalValidVotes, etc.) pass through
        const metaFields = new Set([
          "totalValidVotes",
          "total_valid_votes",
          "validVotes",
          "rejectedVotes",
          "rejected_votes",
          "nota",
          "NOTA",
          "totalVotes",
          "total_votes",
          "tenderedVotes",
          "tendered_votes",
        ]);
        if (metaFields.has(key)) {
          reconciled[key] = val;
          continue;
        }
        // Try mapping via our name mapping
        const canonicalName = nameMapping.get(key);
        if (canonicalName === null || canonicalName === undefined) {
          // Try fuzzy match directly
          const bestMatch = findBestCandidateMatch(key, candidates, 0.55);
          if (bestMatch) {
            reconciled[bestMatch] = val;
          }
          // else discard
        } else {
          reconciled[canonicalName] = val;
        }
      }
      totals[totalKey] = reconciled;
    }
  }

  return {
    constituency,
    assemblyName,
    totalElectors,
    candidates,
    boothResults: allBoothResults,
    totals,
  };
}
