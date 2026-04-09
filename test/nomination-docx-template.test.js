import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import {
  fillNominationTemplate,
  nominationTemplateExists,
} from "../src/nominationDocxTemplate.js";

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxPlainText(buffer) {
  const zip = new AdmZip(buffer);
  const xml = zip.readAsText("word/document.xml");
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\/?\s*>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

test(
  "nomination DOCX contains core manual-entry values",
  { skip: !nominationTemplateExists() },
  async () => {
    const unique = Date.now();
    const candidateName = `Nomination Candidate ${unique}`;
    const fatherName = `Parent Name ${unique}`;
    const postalAddress = `Address ${unique} Main Road`;
    const proposerName = `Proposer ${unique}`;

    const merged = {
      formType: "Form 2B",
      documentTitle: "NOMINATION PAPER",
      fields: {
        state: "WEST BENGAL",
        partI_constituency: "Sample Constituency",
        partI_candidateName: candidateName,
        partI_fatherName: fatherName,
        partI_postalAddress: postalAddress,
        partI_date: "01/01/2026",
        partII_candidateName: candidateName,
        partII_fatherName: fatherName,
        partII_postalAddress: postalAddress,
        partVI_candidateName: candidateName,
        partV_decision: "Accepted",
      },
      proposers: [
        {
          partNo: "12",
          slNo: "45",
          fullName: proposerName,
          signature: "Signed",
          date: "01/01/2026",
        },
      ],
    };

    const buffer = await fillNominationTemplate(merged);

    assert.ok(Buffer.isBuffer(buffer), "Generated file must be a Buffer");
    assert.ok(buffer.length > 0, "Generated DOCX must not be empty");

    const plainText = extractDocxPlainText(buffer).toLowerCase();
    assert.ok(
      plainText.includes(candidateName.toLowerCase()),
      "Candidate name should be present in DOCX",
    );
    assert.ok(
      plainText.includes(fatherName.toLowerCase()),
      "Father/Mother/Husband name should be present in DOCX",
    );
    assert.ok(
      plainText.includes(postalAddress.toLowerCase()),
      "Postal address should be present in DOCX",
    );
    assert.ok(
      plainText.includes(proposerName.toLowerCase()),
      "Proposer name should be present in DOCX",
    );
  },
);
