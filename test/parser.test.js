import test from "node:test";
import assert from "node:assert/strict";

import { parseGeminiStructured } from "../src/parser.js";

test("parseGeminiStructured filters deleted and jurisdiction-marked voters", () => {
  const raw = JSON.stringify({
    assembly: "Demo Assembly",
    partNumber: "44",
    section: "North",
    boothName: "Primary School",
    voters: [
      {
        serialNumber: "1",
        voterId: "ABC1234567",
        name: "Regular Voter",
        relationType: "father",
        relationName: "Parent One",
        houseNumber: "10",
        age: "35",
        gender: "male",
      },
      {
        serialNumber: "2",
        voterId: "BCD2345678",
        name: "Deleted After Adjudication by Judicial Officiers",
        relationType: "father",
        relationName: "Parent Two",
        houseNumber: "11",
        age: "42",
        gender: "female",
      },
      {
        serialNumber: "3",
        voterId: "CDE3456789",
        name: "Stamp On Card",
        status: "Under Jurisdiction",
        relationType: "mother",
        relationName: "Parent Three",
        houseNumber: "12",
        age: "50",
        gender: "female",
      },
      {
        serialNumber: "4",
        voterId: "DEF4567890",
        name: "Still Valid",
        underAdjudication: true,
        relationType: "father",
        relationName: "Parent Four",
        houseNumber: "13",
        age: "28",
        gender: "male",
      },
      {
        serialNumber: "5",
        voterId: "EFG5678901",
        name: "Explicit Deleted Flag",
        isDeleted: true,
        relationType: "father",
        relationName: "Parent Five",
        houseNumber: "14",
        age: "39",
        gender: "male",
      },
    ],
  });

  const parsed = parseGeminiStructured(raw);

  assert.equal(parsed.voters.length, 2);
  assert.deepEqual(
    parsed.voters.map((voter) => voter.serialNumber),
    ["1", "4"],
  );
  assert.equal(parsed.voters[1].underAdjudication, true);
});

test("parseGeminiStructured plain-text fallback also removes deleted stamps", () => {
  const raw = `Assembly Constituency: Demo AC
Part No.: 21
Section: East

1
Name: Valid Name
Fathers Name: Parent A
House Number: 100
Age: 27
Gender: Male

2
Name: DELETED
Fathers Name: Parent B
House Number: 101
Age: 44
Gender: Female`;

  const parsed = parseGeminiStructured(raw);

  assert.equal(parsed.voters.length, 1);
  assert.equal(parsed.voters[0].name, "Valid Name");
  assert.equal(parsed.voters[0].serialNumber, "1");
});
