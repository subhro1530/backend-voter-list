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
      // Use the row with the most candidates
      let maxKeys = 0;
      let bestRow = null;
      for (const row of result.boothResults) {
        const keys = Object.keys(row.candidateVotes || {});
        if (keys.length > maxKeys) {
          maxKeys = keys.length;
          bestRow = row;
        }
      }
      if (bestRow) {
        result.candidates = Object.keys(bestRow.candidateVotes);
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
 */
export function getElectionResultOCRPrompt(isFirstPage = false) {
  if (isFirstPage) {
    return `You are an expert OCR data extractor. You are analyzing Page 1 of an Indian Election Commission "FORM 20 - FINAL RESULT SHEET" PDF.

LOOK AT THE DOCUMENT CAREFULLY. At the top you will find:
- "Total No. of Electors in Assembly Constituency/segment ....NUMBER"
- "Name of Assembly/segment ...NAME Assembly Election"

The table has these EXACT columns (left to right):
- Column 1: "Serial No. Of Polling Station" (the serial/row number)
- Column 2: The booth/polling station number (may be like 1, 2, 3, 5(A), 7(A), 10(A), etc.)
- THEN several columns under the header "No of Valid Votes Cast in favour of" — each sub-column has a CANDIDATE NAME as its header. These names are DIFFERENT for every PDF. Extract them EXACTLY as printed.
- After the candidate columns: "Total of Valid Votes"
- Then: "No. Of Rejected Votes"  
- Then: "NOTA"
- Then: "Total"
- Then: "No. Of Tendered Votes"

IMPORTANT: The candidate names are in the table header cells. They may span 2-3 lines in the header. Combine them into one name. For example if a header cell says "ADHIKARY" on line 1, "PARESH" on line 2, "CHANDRA" on line 3, the candidate name is "ADHIKARY PARESH CHANDRA".

Return ONLY valid JSON (no markdown, no explanation, no prose):
{
  "constituency": "exact text from 'Name of Assembly/segment' line, e.g. '1-Mekliganj (SC) Assembly Election'",
  "totalElectors": 226465,
  "candidates": ["FULL NAME 1", "FULL NAME 2", "FULL NAME 3", ...],
  "boothResults": [
    {
      "serialNo": 1,
      "boothNo": "1",
      "candidateVotes": {"FULL NAME 1": 338, "FULL NAME 2": 7, "FULL NAME 3": 5, ...},
      "totalValidVotes": 665,
      "rejectedVotes": 0,
      "nota": 8,
      "totalVotes": 673,
      "tenderedVotes": 0
    }
  ],
  "totals": null
}

RULES:
1. "candidates" array MUST contain ALL candidate names from the column headers, in left-to-right order.
2. In each booth row, "candidateVotes" keys MUST exactly match the strings in "candidates".
3. ALL values must be numbers, NOT strings. Parse "226,465" as 226465.
4. Extract EVERY row on the page. Do not skip any.
5. The "serialNo" is the first column (1, 2, 3...) and "boothNo" is the second column (could be 1, 2, 5(A), 7(A), etc.). They may differ!
6. Set "totals" to null on this page unless there are summary rows at the bottom.
7. Return ONLY the JSON object — no markdown fences, no text before or after.`;
  }

  return `You are an expert OCR data extractor analyzing a continuation page from an Indian Election Commission "FORM 20 - FINAL RESULT SHEET" PDF.

This is NOT the first page. The table continues from previous pages with the same column structure:
- Serial No. of Polling Station (row number)
- Booth/Polling Station number
- Multiple candidate vote columns (under "No of Valid Votes Cast in favour of")
- Total Valid Votes
- Rejected Votes
- NOTA
- Total
- Tendered Votes

If candidate names are visible in the header on this page, extract them. If the header is not repeated, identify the candidates by the number of numeric columns between booth number and total valid votes.

ALSO look for summary rows at the bottom of the page:
- "Total of votes recorded on EVM" or "Total EVM Votes"
- "Total of Postal Ballot Votes"  
- "Total Votes Polled"
These should go in "totals", NOT in "boothResults".

Return ONLY valid JSON:
{
  "constituency": "name if visible at top, else empty string",
  "totalElectors": number if visible else null,
  "candidates": ["NAME1", "NAME2", ...],
  "boothResults": [
    {
      "serialNo": number,
      "boothNo": "string",
      "candidateVotes": {"NAME1": votes, "NAME2": votes, ...},
      "totalValidVotes": number,
      "rejectedVotes": number,
      "nota": number,
      "totalVotes": number,
      "tenderedVotes": number
    }
  ],
  "totals": {
    "evmVotes": {"NAME1": number, ..., "totalValidVotes": number, "rejectedVotes": number, "nota": number, "totalVotes": number, "tenderedVotes": number},
    "postalVotes": {same structure or null},
    "totalVotesPolled": {same structure or null}
  }
}

RULES:
1. If candidates are visible in the header, include them in "candidates" array.
2. If no header is visible, use "Candidate1", "Candidate2", etc. as keys in left-to-right order. They will be reconciled later.
3. EVERY vote value must be an integer number, NOT a string.
4. Extract ALL data rows. Do NOT skip any booth row.
5. Summary/total rows go in "totals" object, NOT in boothResults.
6. If no summary rows exist on this page, set "totals" to null.
7. Return ONLY the JSON — no markdown, no prose.`;
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

  // Get the canonical candidate list — the longest non-generic list
  let candidates = [];
  for (const page of pageResults) {
    if (page.candidates && page.candidates.length > 0) {
      // Prefer lists with real names over "Candidate1" placeholders
      const hasRealNames = page.candidates.every(
        (c) => !c.match(/^Candidate\d+$/i),
      );
      if (hasRealNames && page.candidates.length > candidates.length) {
        candidates = page.candidates;
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

  // Reconcile booth results — rename generic "Candidate1" keys to real names
  const allBoothResults = [];
  for (const page of pageResults) {
    for (const booth of page.boothResults || []) {
      const reconciledVotes = {};
      const voteKeys = Object.keys(booth.candidateVotes || {});

      // Check if this booth uses generic names
      const usesGenericNames = voteKeys.some((k) => k.match(/^Candidate\d+$/i));

      if (usesGenericNames && candidates.length > 0) {
        // Map by index: Candidate1 → candidates[0], etc.
        for (const [key, val] of Object.entries(booth.candidateVotes)) {
          const match = key.match(/^Candidate(\d+)$/i);
          if (match) {
            const idx = parseInt(match[1]) - 1;
            if (idx < candidates.length) {
              reconciledVotes[candidates[idx]] = val;
            } else {
              reconciledVotes[key] = val;
            }
          } else {
            reconciledVotes[key] = val;
          }
        }
      } else if (candidates.length > 0) {
        // Real names — try to match to canonical names
        for (const [key, val] of Object.entries(booth.candidateVotes)) {
          const canonMatch = candidates.find(
            (c) =>
              c === key ||
              c.toLowerCase() === key.toLowerCase() ||
              c.includes(key) ||
              key.includes(c),
          );
          reconciledVotes[canonMatch || key] = val;
        }
      } else {
        Object.assign(reconciledVotes, booth.candidateVotes);
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
        const match = key.match(/^Candidate(\d+)$/i);
        if (match && candidates.length > 0) {
          const idx = parseInt(match[1]) - 1;
          reconciled[idx < candidates.length ? candidates[idx] : key] = val;
        } else if (candidates.length > 0) {
          const canonMatch = candidates.find(
            (c) =>
              c === key ||
              c.toLowerCase() === key.toLowerCase() ||
              c.includes(key) ||
              key.includes(c),
          );
          reconciled[canonMatch || key] = val;
        } else {
          reconciled[key] = val;
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
