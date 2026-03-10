/**
 * Affidavit / Nomination Paper OCR Parser
 *
 * Parses Gemini OCR output for Form 2B (Nomination Papers),
 * affidavits, and similar legal/election documents.
 *
 * Created by: Shaswata Saha | ssaha.vercel.app
 */

/**
 * Build the OCR prompt sent to Gemini for affidavit pages.
 * Instructs the model to extract every detail faithfully.
 */
export function getAffidavitOCRPrompt(pageNumber) {
  return `You are an expert OCR engine for Indian election affidavits and nomination papers (Form 2B).
Carefully examine this scanned document page (page ${pageNumber}) and extract ALL content with perfect accuracy.

Return the result as a JSON object with this structure:
{
  "pageNumber": ${pageNumber},
  "formType": "Form 2B" or whatever form this is,
  "documentTitle": "NOMINATION PAPER" or whatever the title is,
  "state": "WEST BENGAL" or whatever state,
  "constituency": "116 BIDHANNAGAR" or the constituency name/number,
  "sections": [
    {
      "sectionTitle": "PART I" or "PART II" or "PART III" etc.,
      "sectionType": "nomination" | "declaration" | "proposers_table" | "affidavit" | "criminal_record" | "assets" | "liabilities" | "other",
      "content": [
        {
          "type": "text" | "field" | "table" | "checkbox" | "signature",
          "label": "field label if applicable",
          "value": "extracted value",
          "strikethrough": false,
          "handwritten": true
        }
      ]
    }
  ],
  "fields": {
    "candidateName": "Sri Sabyasachi Dutta" or extracted name,
    "fatherMotherHusbandName": "Late Gouri Sankar Dutta",
    "postalAddress": "DL 239, Sector II, Salt Lake City, Kolkata 700091",
    "serialNumber": "451",
    "partNumber": "201",
    "assemblyConstituency": "116 BIDHANNAGAR",
    "proposerName": "Gautam Kumar Gore",
    "proposerSerialNo": "743",
    "proposerPartNo": "125",
    "date": "24/03/2021",
    "party": "BHARATIYA JANATA PARTY",
    "age": "54",
    "language": "ENGLISH",
    "candidatePhoto": true or false
  },
  "tables": [
    {
      "tableTitle": "Elector Roll No. of Proposer" or description,
      "headers": ["Sl. No.", "Part No. of Electoral Roll", "S. No. in that Part", "Full Name", "Signature", "Date"],
      "rows": [
        ["1", "", "", "", "", ""],
        ["2", "", "", "", "", ""]
      ]
    }
  ],
  "criminalRecord": {
    "hasPendingCases": "Yes" or "No" or "NOT APPLICABLE",
    "pendingCaseDetails": "details or NOT APPLICABLE",
    "hasConvictions": "Yes" or "No" or "NOT APPLICABLE",
    "convictionDetails": "NOT APPLICABLE",
    "courtName": "NOT APPLICABLE",
    "punishment": "NOT APPLICABLE",
    "dateOfConviction": "NOT APPLICABLE",
    "dateOfRelease": "NOT APPLICABLE",
    "appealFiled": "NOT APPLICABLE",
    "appealParticulars": "NOT APPLICABLE",
    "appealCourtName": "NOT APPLICABLE",
    "appealDisposed": "NOT APPLICABLE",
    "disposalDate": "NOT APPLICABLE",
    "orderNature": "NOT APPLICABLE"
  },
  "officeOfProfit": {
    "holdsOffice": "Yes" or "No" or "NOT APPLICABLE",
    "officeDetails": "NOT APPLICABLE"
  },
  "insolvency": {
    "declaredInsolvent": "Yes" or "No" or "NOT APPLICABLE",
    "dischargeDetails": "NOT APPLICABLE"
  },
  "foreignAllegiance": {
    "hasAllegiance": "Yes" or "No" or "NOT APPLICABLE",
    "details": "NOT APPLICABLE"
  },
  "disqualification": {
    "disqualified": "Yes" or "No" or "NOT APPLICABLE",
    "period": "NOT APPLICABLE"
  },
  "dismissalForCorruption": {
    "dismissed": "Yes" or "No" or "NOT APPLICABLE",
    "dismissalDate": "NOT APPLICABLE"
  },
  "governmentContracts": {
    "hasContracts": "Yes" or "No" or "NOT APPLICABLE",
    "contractDetails": "NOT APPLICABLE"
  },
  "assets": {
    "movable": {
      "cashInHand": "",
      "bankDeposits": "",
      "investmentsShares": "",
      "nscPostalSavings": "",
      "loanToOthers": "",
      "motorVehicles": "",
      "jewellery": "",
      "otherAssets": ""
    },
    "immovable": {
      "agriculturalLand": "",
      "nonAgriculturalLand": "",
      "commercialBuildings": "",
      "residentialBuildings": "",
      "otherBuildings": ""
    }
  },
  "liabilities": {
    "loansFromBanks": "",
    "loansFromFinancialInstitutions": "",
    "governmentDues": "",
    "otherLiabilities": ""
  },
  "rawText": "Complete raw text of the entire page exactly as it appears"
}

CRITICAL INSTRUCTIONS:
1. Extract EVERY piece of text visible on the page — typed, printed, AND handwritten.
2. Distinguish between printed template text and handwritten fill-ins.
3. For struck-through text, mark strikethrough: true and still include both the struck and replacement text.
4. Tables must preserve exact structure with all rows and columns including empty cells.
5. For checkboxes or tick marks, indicate whether they are checked.
6. Capture signatures as "[Signature present]" with the signer's name if legible.
7. Include the candidate photo indicator if a photo box is visible.
8. NOT APPLICABLE / blank fields should be captured as-is.
9. Return ONLY valid JSON, no markdown fences.
10. If a field is not present on this page, omit it from the response (don't include empty strings for fields not on the page).
11. The "rawText" field must contain the complete text content in reading order.`;
}

/**
 * Parse Gemini OCR response for an affidavit page.
 * Returns a structured object with all extracted data.
 */
export function parseAffidavitResult(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { error: "Empty response", rawText: "" };
  }

  // Strip markdown code fences if present
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch {
    // Try to extract JSON from mixed content
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return { error: "Failed to parse JSON", rawText: cleaned };
      }
    }
    return { error: "No JSON found", rawText: cleaned };
  }
}

/**
 * Merge parsed results from multiple pages of the same affidavit session
 * into a consolidated affidavit record.
 */
export function mergeAffidavitPages(pageResults) {
  if (!pageResults || pageResults.length === 0) {
    return { pages: [], fields: {}, tables: [], sections: [] };
  }

  const merged = {
    formType: "",
    documentTitle: "",
    state: "",
    constituency: "",
    fields: {},
    tables: [],
    sections: [],
    criminalRecord: {},
    officeOfProfit: {},
    insolvency: {},
    foreignAllegiance: {},
    disqualification: {},
    dismissalForCorruption: {},
    governmentContracts: {},
    assets: { movable: {}, immovable: {} },
    liabilities: {},
    pages: [],
  };

  for (const page of pageResults) {
    if (!page || page.error) continue;

    merged.pages.push(page);

    // Take first non-empty values for top-level fields
    if (page.formType && !merged.formType) merged.formType = page.formType;
    if (page.documentTitle && !merged.documentTitle)
      merged.documentTitle = page.documentTitle;
    if (page.state && !merged.state) merged.state = page.state;
    if (page.constituency && !merged.constituency)
      merged.constituency = page.constituency;

    // Merge fields (first non-empty wins)
    if (page.fields) {
      for (const [key, value] of Object.entries(page.fields)) {
        if (value && !merged.fields[key]) {
          merged.fields[key] = value;
        }
      }
    }

    // Collect all tables
    if (page.tables && Array.isArray(page.tables)) {
      merged.tables.push(...page.tables);
    }

    // Collect all sections
    if (page.sections && Array.isArray(page.sections)) {
      merged.sections.push(...page.sections);
    }

    // Merge criminal record fields
    if (page.criminalRecord) {
      for (const [k, v] of Object.entries(page.criminalRecord)) {
        if (v && !merged.criminalRecord[k]) merged.criminalRecord[k] = v;
      }
    }

    // Merge other declaration sections
    const declarationSections = [
      "officeOfProfit",
      "insolvency",
      "foreignAllegiance",
      "disqualification",
      "dismissalForCorruption",
      "governmentContracts",
    ];
    for (const section of declarationSections) {
      if (page[section]) {
        for (const [k, v] of Object.entries(page[section])) {
          if (v && !merged[section][k]) merged[section][k] = v;
        }
      }
    }

    // Merge assets
    if (page.assets) {
      if (page.assets.movable) {
        for (const [k, v] of Object.entries(page.assets.movable)) {
          if (v && !merged.assets.movable[k]) merged.assets.movable[k] = v;
        }
      }
      if (page.assets.immovable) {
        for (const [k, v] of Object.entries(page.assets.immovable)) {
          if (v && !merged.assets.immovable[k]) merged.assets.immovable[k] = v;
        }
      }
    }

    // Merge liabilities
    if (page.liabilities) {
      for (const [k, v] of Object.entries(page.liabilities)) {
        if (v && !merged.liabilities[k]) merged.liabilities[k] = v;
      }
    }
  }

  return merged;
}
