# Nomination Paper (Form 2B) — Frontend Manual Entry Page

**Created by Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app)

## Overview

Build a **full-page manual data entry form** for the Indian Election Nomination Paper (**Form 2B — For Election to Vidhan Sabha**). This is the formal nomination that a candidate files before the Returning Officer. The form must capture **every single field** from the original DOCX template document (`NOMINATION FORM FOR VIDHAN SABHA WORD.docx`).

**Key rules:**

- **Admin-only page** — Only accessible to logged-in admin users (check JWT role).
- **No field is required** — Every field is optional. The user may fill some or all.
- **DOCX export must match exactly** — Data entered here fills the original DOCX template word-for-word. The backend handles DOCX generation.

---

## Backend API Endpoints

| Method   | Endpoint                                                     | Description                                                   |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `GET`    | `/nominations/form-schema`                                   | Returns the full form schema (sections, fields, table, types) |
| `POST`   | `/nominations/manual-entry`                                  | Create or update a nomination session                         |
| `GET`    | `/nominations/sessions`                                      | List all nomination sessions                                  |
| `GET`    | `/nominations/sessions/:id`                                  | Get session detail with all form data                         |
| `DELETE` | `/nominations/sessions/:id`                                  | Delete a session                                              |
| `PATCH`  | `/nominations/sessions/:id/rename`                           | Rename a session                                              |
| `GET`    | `/nominations/sessions/:id/export/docx`                      | Download filled DOCX                                          |
| `GET`    | `/nominations/search?candidate=&party=&constituency=&state=` | Search sessions                                               |

All endpoints require `Authorization: Bearer <token>` header (admin role).

---

## Form Structure — Complete Field Reference

The form has **7 parts** (Parts I through VI plus Part IIIA). Below is every section and field exactly matching the original **Form 2B DOCX template**.

---

### Header — Election Details

| Field Name | Label | Type | Notes                                                                        |
| ---------- | ----- | ---- | ---------------------------------------------------------------------------- |
| `state`    | State | text | e.g. "WEST BENGAL". Fills "Election to the Legislative Assembly of \_\_\_\_" |

---

### Part I — Nomination by Recognised Political Party

From the form: "For use only by a candidate set up by a recognised political party"

This section fills the paragraph: "We hereby nominate as a candidate for election to the Legislative Assembly from \_\_\_\_ Assembly Constituency the following person whose name is registered in the electoral roll for the \_\_\_\_ Assembly Constituency."

| Field Name                    | Label                                   | Type     | Notes                                           |
| ----------------------------- | --------------------------------------- | -------- | ----------------------------------------------- |
| `partI_constituency`          | Assembly Constituency                   | text     | Constituency name                               |
| `partI_candidateName`         | Candidate's Name                        | text     | Full name                                       |
| `partI_fatherName`            | Father's/Mother's/Husband's Name        | text     |                                                 |
| `partI_postalAddress`         | Postal Address                          | textarea | Full address                                    |
| `partI_candidateSlNo`         | Candidate's Sl. No. in Electoral Roll   | text     | Serial number                                   |
| `partI_candidatePartNo`       | Candidate's Part No. in Electoral Roll  | text     | Part number                                     |
| `partI_candidateConstituency` | Candidate's Electoral Roll Constituency | text     | Which constituency the candidate is enrolled in |
| `partI_proposerName`          | Proposer's Name                         | text     | Single proposer for recognised party            |
| `partI_proposerSlNo`          | Proposer's Sl. No. in Electoral Roll    | text     |                                                 |
| `partI_proposerPartNo`        | Proposer's Part No. in Electoral Roll   | text     |                                                 |
| `partI_proposerConstituency`  | Proposer's Electoral Roll Constituency  | text     |                                                 |
| `partI_date`                  | Date                                    | text     | DD/MM/YYYY                                      |

**Note from original form:** "Part I applies ONLY when the candidate is set up by a recognised political party (one proposer suffices)."

---

### Part II — Nomination by 10 Proposers

From the form: "For use only by a candidate NOT set up by a recognised political party"

The same candidate/address fields plus a **table of 10 proposers**.

**Candidate Fields:**

| Field Name                     | Label                                   | Type     | Notes |
| ------------------------------ | --------------------------------------- | -------- | ----- |
| `partII_constituency`          | Assembly Constituency                   | text     |       |
| `partII_candidateName`         | Candidate's Name                        | text     |       |
| `partII_fatherName`            | Father's/Mother's/Husband's Name        | text     |       |
| `partII_postalAddress`         | Postal Address                          | textarea |       |
| `partII_candidateSlNo`         | Candidate's Sl. No. in Electoral Roll   | text     |       |
| `partII_candidatePartNo`       | Candidate's Part No. in Electoral Roll  | text     |       |
| `partII_candidateConstituency` | Candidate's Electoral Roll Constituency | text     |       |

**Proposers Table** — "Particulars of the Proposers and their Signatures"

A table with up to **10 rows** (one per proposer). From the form: "There should be ten electors of the constituency as proposers."

| Column                     | JSON Key    | Description                                               |
| -------------------------- | ----------- | --------------------------------------------------------- |
| Part No. of Electoral Roll | `partNo`    | Part number where the proposer is registered              |
| S.No. in that Part         | `slNo`      | Serial number in that part                                |
| Full Name                  | `fullName`  | Proposer's full name                                      |
| Signature                  | `signature` | Signature text (or mark as "Signed" / "Thumb Impression") |
| Date                       | `date`      | Date of signing (DD/MM/YYYY)                              |

**JSON structure for proposers:**

```json
{
  "proposers": [
    {
      "partNo": "45",
      "slNo": "1234",
      "fullName": "Amit Kumar Roy",
      "signature": "Signed",
      "date": "15/03/2026"
    },
    {
      "partNo": "45",
      "slNo": "1235",
      "fullName": "Priya Das",
      "signature": "Signed",
      "date": "15/03/2026"
    }
  ]
}
```

**UI suggestion:** Render a 10-row table (pre-rendered, not dynamic). Each row has 5 text inputs. All 10 rows visible by default since the form specifically requires 10.

**Note from original form:** "Part II applies ONLY when the candidate is NOT set up by a recognised political party. Requires 10 electors as proposers."

---

### Part III — Declaration by the Candidate

From the form: "I, a candidate at the above election, do hereby declare—"

| Field Name          | Label                                                    | Type | Notes                                                                                                                                          |
| ------------------- | -------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `age`               | Age (completed years)                                    | text | "(a) that I have completed \_\_\_\_ years of age"                                                                                              |
| `recognisedParty`   | Recognised National/State Party Name (c)(i)              | text | Fill if set up by recognised party. Leave blank otherwise.                                                                                     |
| `unrecognisedParty` | Unrecognised Party Name (c)(ii)                          | text | Fill if set up by a registered unrecognised party. Leave blank otherwise.                                                                      |
| `symbol1`           | Symbol Preference — First Choice                         | text | "(d) that the symbols I choose are, in order of preference — (i)"                                                                              |
| `symbol2`           | Symbol Preference — Second Choice                        | text | "(ii)"                                                                                                                                         |
| `symbol3`           | Symbol Preference — Third Choice                         | text | "(iii)"                                                                                                                                        |
| `language`          | Name spelt in (Language)                                 | text | "(e) that my name in \_\_\_\_ language is spelt as follows"                                                                                    |
| `casteTribe`        | Caste/Tribe                                              | text | "(f) that I belong to \_\_\_\_ Caste/Tribe which is a Scheduled Caste/Scheduled Tribe" (leave blank if not applicable)                         |
| `scStState`         | SC/ST of which State                                     | text | "of the State of \_\_\_\_"                                                                                                                     |
| `scStArea`          | SC/ST in relation to (Area)                              | text | "in relation to that State / in relation to \_\_\_\_ area"                                                                                     |
| `assemblyState`     | Not nominated from more than 2 constituencies in (State) | text | "(h) that I have not been nominated as a candidate at more than two Assembly Constituencies at this general election in the State of \_\_\_\_" |
| `partIII_date`      | Date                                                     | text | DD/MM/YYYY                                                                                                                                     |

**Original form clauses covered:**

- (a) Age declaration
- (b) Government servant status (covered by checkbox/text in Part IIIA)
- (c)(i) Recognised party candidate — (c)(ii) Unrecognised party
- (d) Symbol preferences (3 choices)
- (e) Name in specified language
- (f) Caste/Tribe declaration for SC/ST
- (g) No allegiance to foreign state
- (h) Not nominated from more than 2 constituencies

---

### Part IIIA — Criminal Record & Disqualification Declarations

This is the most detailed section. From the form: "To be filled by the candidate"

#### Criminal Record

| Field Name  | Label                             | Type   | Options/Notes |
| ----------- | --------------------------------- | ------ | ------------- |
| `convicted` | Has the candidate been convicted? | select | "No" / "Yes"  |

**If "Yes", show these fields:**

| Field Name                   | Label                             | Type     | Description (from form)                                                                                         |
| ---------------------------- | --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `criminal_firNos`            | Case/FIR No./Nos.                 | textarea | Case number(s) and FIR number(s)                                                                                |
| `criminal_policeStation`     | Police Station(s)                 | text     | Name and address of Police Station                                                                              |
| `criminal_district`          | District(s)                       | text     |                                                                                                                 |
| `criminal_state`             | State(s)                          | text     |                                                                                                                 |
| `criminal_sections`          | Section(s) and description        | textarea | "Section(s) of the concerned Act(s) under which the offence is punishable and brief description of the offence" |
| `criminal_convictionDates`   | Date(s) of conviction(s)          | text     |                                                                                                                 |
| `criminal_courts`            | Court(s) which convicted          | text     | Name of convicting court(s)                                                                                     |
| `criminal_punishment`        | Punishment(s) imposed             | textarea | "Punishment imposed including period of imprisonment and/or fine"                                               |
| `criminal_releaseDates`      | Date(s) of release from prison    | text     |                                                                                                                 |
| `criminal_appealFiled`       | Appeal(s)/Revision(s) filed?      | select   | "No" / "Yes"                                                                                                    |
| `criminal_appealParticulars` | Date and particulars of appeal(s) | textarea |                                                                                                                 |
| `criminal_appealCourts`      | Court(s) for appeal(s)            | text     |                                                                                                                 |
| `criminal_appealStatus`      | Appeal status                     | text     | "disposed of / pending"                                                                                         |
| `criminal_disposalDates`     | Date(s) of disposal               | text     |                                                                                                                 |
| `criminal_orderNature`       | Nature of order(s) passed         | textarea |                                                                                                                 |

#### Disqualification Declarations

Each item below is a Yes/No question. If "Yes", an additional detail field appears.

| Field Name               | Label                                                    | Type            | Detail Field                | Detail Label                       |
| ------------------------ | -------------------------------------------------------- | --------------- | --------------------------- | ---------------------------------- |
| `officeOfProfit`         | Holding office of profit under Government?               | select (No/Yes) | `officeOfProfit_details`    | Details of office held             |
| `insolvency`             | Declared insolvent / undischarged?                       | select (No/Yes) | `insolvency_discharged`     | Discharged from insolvency? (text) |
| `foreignAllegiance`      | Under allegiance to foreign country?                     | select (No/Yes) | `foreignAllegiance_details` | Foreign allegiance details         |
| `disqualification_8A`    | Disqualified under Section 8A of RP Act?                 | select (No/Yes) | `disqualification_period`   | Period of disqualification         |
| `dismissalForCorruption` | Dismissed for corruption/disloyalty to State?            | select (No/Yes) | `dismissal_date`            | Date of dismissal                  |
| `govContracts`           | Subsisting government contracts?                         | select (No/Yes) | `govContracts_details`      | Government contract details        |
| `managingAgent`          | Managing agent/manager/secretary of company/corporation? | select (No/Yes) | `managingAgent_details`     | Company/Corporation details        |
| `disqualification_10A`   | Disqualified under Section 10A?                          | select (No/Yes) | `section10A_date`           | Date of disqualification under 10A |

**Original form context:** These declarations correspond to grounds for disqualification under the Representation of the People Act, 1951 (Sections 8, 8A, 9, 9A, 10, 10A).

---

### Part IV — Returning Officer's Record

From the form: "To be filled in by the Returning Officer"

| Field Name           | Label                          | Type | Notes                                                |
| -------------------- | ------------------------------ | ---- | ---------------------------------------------------- |
| `partIV_serialNo`    | Serial No. of Nomination Paper | text | "The nomination paper of \_\_\_\_ (serial number)"   |
| `partIV_hour`        | Hour of delivery               | text | "was delivered to me at my office at \_\_\_\_ hours" |
| `partIV_date`        | Date of delivery               | text | DD/MM/YYYY — "on the \_\_\_\_ day of \_\_\_\_"       |
| `partIV_deliveredBy` | Delivered by                   | text | "by the candidate / by \_\_\_\_ the proposer"        |
| `partIV_roDate`      | Returning Officer Date         | text | DD/MM/YYYY                                           |

---

### Part V — Decision of Returning Officer on Scrutiny

From the form: "I have examined this nomination paper in accordance with section 36 of the Representation of the People Act, 1951 and decide as follows:—"

| Field Name       | Label                                 | Type     | Notes                                           |
| ---------------- | ------------------------------------- | -------- | ----------------------------------------------- |
| `partV_decision` | Decision (Accept/Reject with reasons) | textarea | "accepted" or "rejected on grounds of \_\_\_\_" |
| `partV_date`     | Date                                  | text     | DD/MM/YYYY                                      |

---

### Part VI — Receipt for Nomination Paper and Notice of Scrutiny

From the form: receipt to be handed over to the person presenting the nomination paper.

| Field Name             | Label                          | Type | Notes                                                                 |
| ---------------------- | ------------------------------ | ---- | --------------------------------------------------------------------- |
| `partVI_serialNo`      | Serial No. of Nomination Paper | text | "Nomination paper (Serial No......)"                                  |
| `partVI_candidateName` | Candidate Name                 | text | "of Shri/Smt. \_\_\_\_"                                               |
| `partVI_constituency`  | Assembly Constituency          | text | "a candidate for election from \_\_\_\_ Constituency"                 |
| `partVI_hour`          | Hour of delivery               | text | "has been delivered to me at \_\_\_\_ hours"                          |
| `partVI_date`          | Date of delivery               | text | DD/MM/YYYY — "on the \_\_\_\_ day of \_\_\_\_"                        |
| `partVI_scrutinyHour`  | Scrutiny Hour                  | text | "The scrutiny of nomination papers will take place at \_\_\_\_ hours" |
| `partVI_scrutinyDate`  | Scrutiny Date                  | text | DD/MM/YYYY — "on the \_\_\_\_ day of \_\_\_\_"                        |
| `partVI_scrutinyPlace` | Scrutiny Place                 | text | "at (place) \_\_\_\_"                                                 |
| `partVI_roDate`        | Returning Officer Date         | text | DD/MM/YYYY                                                            |

---

## Complete JSON Payload — Example `POST /nominations/manual-entry`

```json
{
  "state": "WEST BENGAL",
  "candidateName": "RAJESH KUMAR SHARMA",
  "fatherMotherHusbandName": "LATE SURESH KUMAR SHARMA",
  "postalAddress": "Flat 3B, Block A, Salt Lake Sector II, Kolkata 700091",
  "party": "All India Trinamool Congress",
  "constituency": "116 BIDHANNAGAR",

  "partI_constituency": "116 BIDHANNAGAR",
  "partI_candidateName": "RAJESH KUMAR SHARMA",
  "partI_fatherName": "LATE SURESH KUMAR SHARMA",
  "partI_postalAddress": "Flat 3B, Block A, Salt Lake Sector II, Kolkata 700091",
  "partI_candidateSlNo": "1234",
  "partI_candidatePartNo": "45",
  "partI_candidateConstituency": "116 BIDHANNAGAR",
  "partI_proposerName": "AMIT KUMAR ROY",
  "partI_proposerSlNo": "5678",
  "partI_proposerPartNo": "45",
  "partI_proposerConstituency": "116 BIDHANNAGAR",
  "partI_date": "15/03/2026",

  "partII_constituency": "",
  "partII_candidateName": "",
  "partII_fatherName": "",
  "partII_postalAddress": "",
  "partII_candidateSlNo": "",
  "partII_candidatePartNo": "",
  "partII_candidateConstituency": "",
  "proposers": [],

  "age": "52",
  "recognisedParty": "All India Trinamool Congress",
  "unrecognisedParty": "",
  "symbol1": "Jora Ghash Phool",
  "symbol2": "",
  "symbol3": "",
  "language": "Bengali",
  "casteTribe": "",
  "scStState": "",
  "scStArea": "",
  "assemblyState": "WEST BENGAL",
  "partIII_date": "15/03/2026",

  "convicted": "No",
  "criminal_firNos": "",
  "criminal_policeStation": "",
  "criminal_district": "",
  "criminal_state": "",
  "criminal_sections": "",
  "criminal_convictionDates": "",
  "criminal_courts": "",
  "criminal_punishment": "",
  "criminal_releaseDates": "",
  "criminal_appealFiled": "No",
  "criminal_appealParticulars": "",
  "criminal_appealCourts": "",
  "criminal_appealStatus": "",
  "criminal_disposalDates": "",
  "criminal_orderNature": "",

  "officeOfProfit": "No",
  "officeOfProfit_details": "",
  "insolvency": "No",
  "insolvency_discharged": "",
  "foreignAllegiance": "No",
  "foreignAllegiance_details": "",
  "disqualification_8A": "No",
  "disqualification_period": "",
  "dismissalForCorruption": "No",
  "dismissal_date": "",
  "govContracts": "No",
  "govContracts_details": "",
  "managingAgent": "No",
  "managingAgent_details": "",
  "disqualification_10A": "No",
  "section10A_date": "",

  "partIV_serialNo": "1",
  "partIV_hour": "11:00",
  "partIV_date": "15/03/2026",
  "partIV_deliveredBy": "Candidate",
  "partIV_roDate": "15/03/2026",

  "partV_decision": "",
  "partV_date": "",

  "partVI_serialNo": "1",
  "partVI_candidateName": "RAJESH KUMAR SHARMA",
  "partVI_constituency": "116 BIDHANNAGAR",
  "partVI_hour": "11:00",
  "partVI_date": "15/03/2026",
  "partVI_scrutinyHour": "11:00",
  "partVI_scrutinyDate": "17/03/2026",
  "partVI_scrutinyPlace": "Office of Returning Officer, Bidhannagar",
  "partVI_roDate": "15/03/2026"
}
```

---

## UI/UX Guidelines

### Layout

- Use a **tabbed layout** or **stepper/wizard** with one tab/step per Part (Part I, Part II, Part III, Part IIIA, Part IV, Part V, Part VI).
- Alternative: A single scrollable page with sticky section navigation sidebar.
- **Part I vs Part II:** Show both, but add a note: "Fill Part I if set up by recognised party, OR Part II if not. Fill only one."

### Form Controls

- All text inputs: Standard text fields.
- Textareas for: `postalAddress`, `criminal_sections`, `criminal_punishment`, `officeOfProfit_details`, `govContracts_details`, `managingAgent_details`, `partV_decision`.
- **Select dropdowns** for all Yes/No fields: `convicted`, `criminal_appealFiled`, `officeOfProfit`, `insolvency`, `foreignAllegiance`, `disqualification_8A`, `dismissalForCorruption`, `govContracts`, `managingAgent`, `disqualification_10A`.
- **Conditional fields:** Show detail/sub-fields only when parent select is "Yes". For example, `criminal_firNos` through `criminal_orderNature` only appear when `convicted == "Yes"`.
- **Proposers table:** A fixed 10-row table with 5 columns. Pre-render all 10 rows (as empty inputs). Don't use dynamic add/remove — the form specifically requires 10 proposers.

### Actions

- **Save Draft** — `POST /nominations/manual-entry` with all form data. Store returned `sessionId` for future updates (include `sessionId` in subsequent saves).
- **Export DOCX** — `GET /nominations/sessions/:id/export/docx` to download the filled document.
- **Edit existing** — Load data via `GET /nominations/sessions/:id`, populate form, then save with `sessionId`.

### Sessions List Page

- A separate page/panel listing all nomination sessions (from `GET /nominations/sessions`).
- Each row shows: candidate name, father's name, party, constituency, state, status, created date.
- Actions per row: Edit (opens form pre-filled), Export DOCX (download), Delete, Rename.
- Search bar filtering by candidate/party/constituency/state (calls `GET /nominations/search`).

---

## Notes from the Original Form 2B DOCX

1. The form title is: "FORM 2B — NOMINATION PAPER — [See rule 4 (1)] — Election to the Legislative Assembly"
2. Parts I and II are mutually exclusive — Part I for recognised party candidates (1 proposer), Part II for others (10 proposers).
3. Part III is filled by the candidate directly.
4. Part IIIA contains criminal record and disqualification declarations — critical legal section.
5. Parts IV, V, and VI are filled by the Returning Officer, but the admin data-entry interface should include them since the DOCX template has them.
6. Original form has tick-mark/strike-out options for alternatives (e.g., "candidate/proposer"). The DOCX template handles this formatting.
7. All dates should follow DD/MM/YYYY format as per Indian election norms.
