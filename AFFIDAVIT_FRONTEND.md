# Affidavit (Form 26) — Frontend Manual Entry Page

**Created by Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app)

## Overview

Build a **full-page manual data entry form** for the Indian Election Affidavit (**Form 26**). This is the affidavit filed by a candidate alongside their nomination paper before the Returning Officer. The form is lengthy — it must capture **every single field** from the original DOCX template document (`AFFIDAVIT FORMAT WORD.docx`). No field should be omitted.

**Key rules:**

- **Admin-only page** — Only accessible to logged-in admin users (check JWT role).
- **No field is required** — Every field is optional. The user may fill some or all.
- **The form can be lengthy** — Don't try to make it short. The original document is 10+ pages. The web form will naturally be long.
- **DOCX export must match exactly** — Data entered here fills the original DOCX template word-for-word. The backend handles DOCX generation.

---

## Backend API Endpoints

| Method   | Endpoint                                                    | Description                                                    |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/affidavits/form-schema`                                   | Returns the full form schema (sections, fields, tables, types) |
| `POST`   | `/affidavits/manual-entry`                                  | Create or update an affidavit session                          |
| `POST`   | `/affidavits/upload-image`                                  | Upload candidate photo or signature to Cloudinary              |
| `GET`    | `/affidavits/sessions`                                      | List all affidavit sessions                                    |
| `GET`    | `/affidavits/sessions/:id`                                  | Get session detail with all form data                          |
| `DELETE` | `/affidavits/sessions/:id`                                  | Delete a session                                               |
| `PATCH`  | `/affidavits/sessions/:id/rename`                           | Rename a session                                               |
| `GET`    | `/affidavits/sessions/:id/export/docx`                      | Download filled DOCX                                           |
| `GET`    | `/affidavits/sessions/:id/entries`                          | Get entries by category                                        |
| `GET`    | `/affidavits/search?candidate=&party=&constituency=&state=` | Search sessions                                                |

All endpoints require `Authorization: Bearer <token>` header (admin role).

### Image Upload Endpoint

**`POST /affidavits/upload-image`** — Upload a candidate photograph or deponent signature image.

- **Content-Type:** `multipart/form-data`
- **Body:** A single file field named `image` (max 5 MB, JPEG or PNG)
- **Response:**

```json
{
  "url": "https://res.cloudinary.com/.../affidavit_images/abc123.jpg",
  "publicId": "affidavit_images/abc123"
}
```

**Usage:** Call this endpoint first to upload the image, then store the returned `url` in the form data as `candidatePhotoUrl` or `candidateSignatureUrl` before saving via `POST /affidavits/manual-entry`.

---

## Form Structure — Complete Field Reference

The form has **16 sections**. Below is every section and every field exactly as they appear in the original **Form 26 DOCX template**. The `name` is the JSON key to send to the backend.

---

### Section 1: Election Details (Header)

These fields fill the header of the Form: "AFFIDAVIT TO BE FILED BY THE CANDIDATE ALONGWITH NOMINATION PAPER BEFORE THE RETURNING OFFICER FOR ELECTION TO \_\_\_\_ (NAME OF THE HOUSE) FROM \_\_\_\_ CONSTITUENCY"

| Field Name     | Label             | Type | Placeholder/Notes           |
| -------------- | ----------------- | ---- | --------------------------- |
| `houseName`    | Name of the House | text | e.g. "Legislative Assembly" |
| `constituency` | Constituency Name | text | e.g. "116 BIDHANNAGAR"      |
| `state`        | State             | text | e.g. "WEST BENGAL"          |

---

### Section 2: Part A — Personal Details

These fields fill the opening paragraph: "I \_\_\_\_ son/daughter/wife of \_\_\_\_ Aged \_\_\_\_ years, resident of \_\_\_\_, a candidate set up by \_\_\_\_ / contesting as Independent..."

| Field Name                | Label                                | Type         | Placeholder/Notes                                                                          |
| ------------------------- | ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| `candidateName`           | Candidate Full Name                  | text         |                                                                                            |
| `fatherMotherHusbandName` | Father's / Mother's / Husband's Name | text         |                                                                                            |
| `age`                     | Age (years)                          | text         | Just the number                                                                            |
| `postalAddress`           | Full Postal Address                  | textarea     | "mention full postal address" per the form                                                 |
| `party`                   | Political Party Name                 | text         | Leave blank if independent                                                                 |
| `isIndependent`           | Contesting as Independent            | checkbox     | Strike-out alternative per form rules                                                      |
| `enrolledConstituency`    | Enrolled Constituency & State        | text         | "Name of the Constituency and the state"                                                   |
| `serialNumber`            | Serial No. in Electoral Roll         | text         |                                                                                            |
| `partNumber`              | Part No. in Electoral Roll           | text         |                                                                                            |
| `telephone`               | Telephone Number(s)                  | text         |                                                                                            |
| `email`                   | Email ID                             | text         | "if any" per the form                                                                      |
| `socialMedia1`            | Social Media Account (i)             | text         | "if any" per the form                                                                      |
| `socialMedia2`            | Social Media Account (ii)            | text         |                                                                                            |
| `socialMedia3`            | Social Media Account (iii)           | text         |                                                                                            |
| `candidatePhotoUrl`       | Candidate Photograph                 | image_upload | Upload passport-size photograph. Use `POST /affidavits/upload-image` first, store the URL. |
| `candidateSignatureUrl`   | Deponent Signature                   | image_upload | Upload scanned signature. Use `POST /affidavits/upload-image` first, store the URL.        |

**Image upload fields:** These are not text inputs. Render a file picker + upload button. When the user selects a file, call `POST /affidavits/upload-image`, then store the returned `url` in the form state under the corresponding field name. Display a thumbnail preview of the uploaded image.

---

### Section 3: PAN & Income Tax Details

This is a **table section**. The original form has a table titled: "Details of Permanent Account Number (PAN) and status of filing of Income tax return"

The table has **6 persons** (rows) × **up to 5 financial years** each:

**Persons (pre-filled row labels):**

1. Self
2. Spouse
3. HUF (If Candidate is Karta/Coparcener)
4. Dependent 1
5. Dependent 2
6. Dependent 3

**Per person, the columns are:**

| Column  | JSON Key | Description                           |
| ------- | -------- | ------------------------------------- |
| Sl. No. | `slNo`   | Pre-filled: 1-6                       |
| Names   | `name`   | Name of the person                    |
| PAN     | `pan`    | PAN number. "No PAN allotted" if none |

**Sub-table per person (up to 5 rows for last 5 financial years):**

| Column             | JSON Key | Description                       |
| ------------------ | -------- | --------------------------------- |
| Financial Year     | `year`   | e.g. "2024-25", "2023-24"         |
| Total Income (Rs.) | `income` | Income shown in ITR for that year |

**JSON structure to send:**

```json
{
  "panEntries": [
    {
      "slNo": "1",
      "name": "John Doe",
      "pan": "ABCDE1234F",
      "years": [
        { "year": "2024-25", "income": "500000" },
        { "year": "2023-24", "income": "450000" }
      ]
    },
    {
      "slNo": "2",
      "name": "Jane Doe",
      "pan": "FGHIJ5678K",
      "years": [{ "year": "2024-25", "income": "300000" }]
    }
  ]
}
```

**UI suggestion:** Render 6 collapsible sub-forms (one per person), each with name/PAN fields and a dynamic list of year+income rows (add/remove buttons).

**Note from original form:** "It is mandatory for PAN holder to mention PAN and in case of no PAN, it should be clearly stated 'No PAN allotted'."

---

### Section 4: Pending Criminal Cases

From the form: "(5) Pending criminal cases — (i) I declare that there is no pending criminal case against me. OR (ii) The following criminal cases are pending against me:"

| Field Name        | Label                       | Type         | Options      |
| ----------------- | --------------------------- | ------------ | ------------ |
| `hasPendingCases` | Any pending criminal cases? | select/radio | "No" / "Yes" |

**If "Yes", show a dynamic table** (user can add multiple rows):

| Column                  | JSON Key        | Description (from form)                                                                                  |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| (a) FIR No.             | `firNo`         | "FIR No. with name and address of Police Station concerned"                                              |
| (b) Case No.            | `caseNo`        | "Case No. with Name of the Court"                                                                        |
| (c) Sections            | `sections`      | "Section(s) of concerned Acts/Codes involved (give no. of the Section, e.g. Section… of IPC, etc.)"      |
| (d) Description         | `description`   | "Brief description of offence"                                                                           |
| (e) Charges Framed      | `chargesFramed` | "Whether charges have been framed (mention YES or NO)"                                                   |
| (f) Date Charges Framed | `chargesDate`   | "If answer against (e) above is YES, then give the date on which charges were framed"                    |
| (g) Appeal Filed        | `appealFiled`   | "Whether any Appeal/Application for revision has been filed against the proceedings (Mention YES or NO)" |

**JSON structure:**

```json
{
  "hasPendingCases": "Yes",
  "pendingCases": [
    {
      "firNo": "123/2024, PS Bidhannagar",
      "caseNo": "CC 456/2024, CJM Court",
      "sections": "Section 420 of IPC",
      "description": "Cheating",
      "chargesFramed": "Yes",
      "chargesDate": "15/03/2024",
      "appealFiled": "No"
    }
  ]
}
```

**Note from original form:** "Details should be entered clearly and legibly in BOLD letters. Details to be given separately for each case. Details should be given in reverse chronological order."

---

### Section 5: Cases of Conviction

From the form: "(6) Cases of conviction — (i) I declare that I have not been convicted for any criminal offence. OR (ii) I have been convicted for the offences mentioned below:"

| Field Name       | Label            | Type         | Options      |
| ---------------- | ---------------- | ------------ | ------------ |
| `hasConvictions` | Any convictions? | select/radio | "No" / "Yes" |

**If "Yes", show a dynamic table:**

| Column              | JSON Key         | Description (from form)                                                    |
| ------------------- | ---------------- | -------------------------------------------------------------------------- |
| (a) Case No.        | `caseNo`         | Case number                                                                |
| (b) Court Name      | `courtName`      | "Name of the Court"                                                        |
| (c) Sections        | `sections`       | "Sections of Acts/Codes involved"                                          |
| (d) Description     | `description`    | "Brief description of offence for which convicted"                         |
| (e) Conviction Date | `convictionDate` | "Dates of orders of conviction"                                            |
| (f) Punishment      | `punishment`     | "Punishment imposed"                                                       |
| (g) Appeal Filed    | `appealFiled`    | "Whether any Appeal has been filed against conviction order (YES or No)"   |
| (h) Appeal Status   | `appealStatus`   | "If answer to (g) above is YES, give details and present status of appeal" |

**JSON structure:**

```json
{
  "hasConvictions": "Yes",
  "convictions": [
    {
      "caseNo": "CC 789/2020",
      "courtName": "Sessions Court, Kolkata",
      "sections": "Section 302 IPC",
      "description": "...",
      "convictionDate": "10/05/2021",
      "punishment": "2 years imprisonment",
      "appealFiled": "Yes",
      "appealStatus": "Appeal pending in High Court"
    }
  ]
}
```

---

### Section 6: Party Information (6A)

From the form: "(6A) I have given full and up-to-date information to my political party about all pending criminal cases against me..."

| Field Name      | Label                                                     | Type     | Placeholder                                      |
| --------------- | --------------------------------------------------------- | -------- | ------------------------------------------------ |
| `informedParty` | Information given to political party about criminal cases | textarea | "Write NOT APPLICABLE if 5(i) and 6(i) selected" |

---

### Section 7: Movable Assets

This is a **grid/table** section. From the form: "(7) Details of the assets (movable and immovable etc.) of myself, my spouse and all dependents"

**The table has 9 rows × 6 person-columns:**

Person columns: **Self, Spouse, HUF, Dependent-1, Dependent-2, Dependent-3**

| Row    | Label (from form)                                                                                                                                                                          | JSON Keys (Self/Spouse/HUF/Dep1/Dep2/Dep3)                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| (i)    | Cash in hand                                                                                                                                                                               | `cashSelf`, `cashSpouse`, `cashHUF`, `cashDep1`, `cashDep2`, `cashDep3`             |
| (ii)   | Details of deposit in Bank accounts (FDRs, Term Deposits and all other types of deposits including saving accounts), Deposits with Financial Institutions, NBFCs and Cooperative societies | `bankSelf`, `bankSpouse`, `bankHUF`, `bankDep1`, `bankDep2`, `bankDep3`             |
| (iii)  | Details of investment in Bonds, Debentures/Shares and units in companies/Mutual Funds and others                                                                                           | `bondsSelf`, `bondsSpouse`, `bondsHUF`, `bondsDep1`, `bondsDep2`, `bondsDep3`       |
| (iv)   | Details of investment in NSS, Postal Saving, Insurance Policies and investment in any Financial instruments in Post office or Insurance Company                                            | `nssSelf`, `nssSpouse`, `nssHUF`, `nssDep1`, `nssDep2`, `nssDep3`                   |
| (v)    | Personal loans/advance given to any person or entity including firm, company, Trust etc. and other receivables from debtors                                                                | `loansSelf`, `loansSpouse`, `loansHUF`, `loansDep1`, `loansDep2`, `loansDep3`       |
| (vi)   | Motor Vehicles/Aircrafts/Yachts/Ships (Details of Make, registration number, year of purchase and amount)                                                                                  | `motorSelf`, `motorSpouse`, `motorHUF`, `motorDep1`, `motorDep2`, `motorDep3`       |
| (vii)  | Jewellery, bullion and valuable thing(s) (give details of weight and value)                                                                                                                | `jewellSelf`, `jewellSpouse`, `jewellHUF`, `jewellDep1`, `jewellDep2`, `jewellDep3` |
| (viii) | Any other assets such as value of claims/interest                                                                                                                                          | `otherSelf`, `otherSpouse`, `otherHUF`, `otherDep1`, `otherDep2`, `otherDep3`       |
| (ix)   | Gross Total value                                                                                                                                                                          | `totalSelf`, `totalSpouse`, `totalHUF`, `totalDep1`, `totalDep2`, `totalDep3`       |

**JSON structure:**

```json
{
  "movableAssets": {
    "cashSelf": "50000",
    "cashSpouse": "30000",
    "bankSelf": "1200000",
    "bankSpouse": "800000",
    "bondsSelf": "500000",
    "motorSelf": "Honda City, WB01AB1234, 2020, Rs.800000",
    "jewellSelf": "Gold 50g, Rs.300000",
    "totalSelf": "2850000",
    "totalSpouse": "830000"
  }
}
```

**UI suggestion:** Render as a scrollable table/grid with row labels on the left and 6 text input columns. Each cell is a text input.

**Notes from original form:**

1. "Assets in joint name indicating the extent of joint ownership will also have to be given."
2. "In case of deposit/Investment, the details including Serial Number, Amount, date of deposit, the scheme, Name of Bank/Institution and Branch are to be given."
3. "Value of Bonds/Share Debentures as per the current market value in Stock Exchange in respect of listed companies and as per books in case of non-listed companies should be given."
4. "'Dependent' means parents, son(s), daughter(s) of the candidate or spouse and any other person related to the candidate whether by blood or marriage, who have no separate means of income and who are dependent on the candidate for their livelihood."
5. "Details including amount is to be given separately in respect of each investment."
6. "Details should include the interest in or ownership of offshore assets."

---

### Section 8: Immovable Assets

From the form: "B. Details of Immovable assets"

This section has **5 property categories**, and within each category the user can add **multiple properties**. Each property has the same set of detail fields.

**Categories:**

| Category ID       | Label                                             |
| ----------------- | ------------------------------------------------- |
| `agricultural`    | (i) Agricultural Land                             |
| `nonAgricultural` | (ii) Non-Agricultural Land                        |
| `commercial`      | (iii) Commercial Buildings (including apartments) |
| `residential`     | (iv) Residential Buildings (including apartments) |
| `others`          | (v) Others (such as interest in property)         |

**Fields per property entry:**

| Field                | JSON Key       | Description (from form)                                                        |
| -------------------- | -------------- | ------------------------------------------------------------------------------ |
| Location             | `location`     | "Location(s)"                                                                  |
| Survey Number        | `surveyNo`     | "Survey number(s)"                                                             |
| Area                 | `area`         | "Area (total measurement in acres/sq.ft.)"                                     |
| Inherited?           | `inherited`    | "Whether inherited property (Yes or No)"                                       |
| Purchase Date        | `purchaseDate` | "Date of purchase in case of self-acquired property"                           |
| Purchase Cost        | `purchaseCost` | "Cost of Land/property (in case of purchase) at the time of purchase"          |
| Investment           | `investment`   | "Any Investment on the land/property by way of development, construction etc." |
| Current Market Value | `marketValue`  | "Approximate current market value"                                             |

**JSON structure:**

```json
{
  "immovableAssets": {
    "agricultural": [
      {
        "location": "Village Ramnagar, Dist. 24 Parganas",
        "surveyNo": "123/4",
        "area": "5 acres",
        "inherited": "No",
        "purchaseDate": "15/06/2015",
        "purchaseCost": "2000000",
        "investment": "500000",
        "marketValue": "5000000"
      }
    ],
    "residential": [
      {
        "location": "Flat 4A, Salt Lake Sector V",
        "surveyNo": "Plot 45",
        "area": "1200 sq.ft",
        "inherited": "Yes",
        "purchaseDate": "",
        "purchaseCost": "",
        "investment": "200000",
        "marketValue": "8000000"
      }
    ]
  }
}
```

**UI suggestion:** 5 collapsible sections (one per category). Within each, a list of property entries with add/remove buttons. Each entry is a card/group of the 8 fields above.

**Notes from original form:**

1. "Properties in joint ownership indicating the extent of joint ownership will also have to be indicated"
2. "Each land or building or apartment should be mentioned separately in this format"
3. "Details should include the interest in or ownership of offshore assets."

---

### Section 9: Liabilities

From the form: "I give herein below the details of liabilities/dues to public financial institutions and government"

**Same grid structure as movable assets — rows × 6 person-columns:**

| Row   | Label (from form)                                                                                                   | JSON Keys                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| (i)   | Loan or dues to Bank/Financial Institution(s) — Name of Bank or FI, Amount outstanding, Nature of loan              | `bankLoansSelf`, `bankLoansSpouse`, `bankLoansHUF`, `bankLoansDep1`, `bankLoansDep2`, `bankLoansDep3`       |
| (ii)  | Loan or dues to any other individuals/entity other than mentioned above — Names, Amount outstanding, nature of loan | `otherLoansSelf`, `otherLoansSpouse`, `otherLoansHUF`, `otherLoansDep1`, `otherLoansDep2`, `otherLoansDep3` |
| (iii) | Any other liability                                                                                                 | `otherLiabSelf`, `otherLiabSpouse`, `otherLiabHUF`, `otherLiabDep1`, `otherLiabDep2`, `otherLiabDep3`       |
| (iv)  | Grand total of liabilities                                                                                          | `totalSelf`, `totalSpouse`, `totalHUF`, `totalDep1`, `totalDep2`, `totalDep3`                               |

**JSON structure (nested under `liabilities`):**

```json
{
  "liabilities": {
    "bankLoansSelf": "SBI Home Loan, Rs.2500000",
    "bankLoansSpouse": "",
    "totalSelf": "2500000"
  }
}
```

**Note from original form:** "Please give separate details of name of bank, institution, entity or individual and amount before each item"

---

### Section 10: Government Dues

From the form: "(ii) Government Dues" — includes accommodation, transport, taxes, etc.

| Row    | Label (from form)                                                                          | JSON Keys                                                                                             |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| (iii)  | Dues to department dealing with Government transport (including aircrafts and helicopters) | `transportSelf`, `transportSpouse`, `transportHUF`, `transportDep1`, `transportDep2`, `transportDep3` |
| (iv)   | Income Tax dues                                                                            | `incomeTaxSelf`, `incomeTaxSpouse`, `incomeTaxHUF`, `incomeTaxDep1`, `incomeTaxDep2`, `incomeTaxDep3` |
| (v)    | GST dues                                                                                   | `gstSelf`, `gstSpouse`, `gstHUF`, `gstDep1`, `gstDep2`, `gstDep3`                                     |
| (vi)   | Municipal/Property tax dues                                                                | `municipalSelf`, `municipalSpouse`, `municipalHUF`, `municipalDep1`, `municipalDep2`, `municipalDep3` |
| (vii)  | Any other dues                                                                             | `otherSelf`, `otherSpouse`, `otherHUF`, `otherDep1`, `otherDep2`, `otherDep3`                         |
| (viii) | Grand total of all Government dues                                                         | `totalSelf`, `totalSpouse`, `totalHUF`, `totalDep1`, `totalDep2`, `totalDep3`                         |

**JSON structure (nested under `governmentDues`):**

```json
{
  "governmentDues": {
    "incomeTaxSelf": "150000",
    "municipalSelf": "25000",
    "totalSelf": "175000"
  }
}
```

---

### Section 10A: Disputed Liabilities

From the form: Any liabilities that are disputed by the candidate.

| Field Name            | Label                           | Type     | Placeholder                            |
| --------------------- | ------------------------------- | -------- | -------------------------------------- |
| `disputedLiabilities` | Details of disputed liabilities | textarea | "Write NIL if no disputed liabilities" |

---

### Section 11: Government Accommodation

From the form: "Dues to departments dealing with Government accommodation — Has the Deponent been in occupation of accommodation provided by the Government at any time during the last ten years?"

| Field Name                                | Label                                          | Type     | Options/Notes                                              |
| ----------------------------------------- | ---------------------------------------------- | -------- | ---------------------------------------------------------- |
| `governmentAccommodation.occupied`        | Occupied Govt. accommodation in last 10 years? | select   | "Yes" / "No"                                               |
| `governmentAccommodation.address`         | Address of Govt. accommodation                 | textarea | Only if Yes                                                |
| `governmentAccommodation.noDues`          | No dues payable as on date                     | select   | "Yes" / "No" — requires No Dues Certificate per form rules |
| `governmentAccommodation.duesDate`        | Dues payable as on date (if applicable)        | text     | DD/MM/YYYY — Only if `noDues` is "No"                      |
| `governmentAccommodation.rentDues`        | Rent dues (Rs.)                                | text     | Only if `noDues` is "No"                                   |
| `governmentAccommodation.electricityDues` | Electricity dues (Rs.)                         | text     | Only if `noDues` is "No"                                   |
| `governmentAccommodation.waterDues`       | Water dues (Rs.)                               | text     | Only if `noDues` is "No"                                   |
| `governmentAccommodation.telephoneDues`   | Telephone dues (Rs.)                           | text     | Only if `noDues` is "No"                                   |

**Conditional display:** Show the dues breakdown fields (`duesDate`, `rentDues`, `electricityDues`, `waterDues`, `telephoneDues`) only when `governmentAccommodation.noDues` is "No".

---

### Section 12: Profession & Income

From the form: "(8) Details of profession or occupation" and "(9A) Details of source(s) of income"

| Field Name         | Label                         | Type |
| ------------------ | ----------------------------- | ---- |
| `selfProfession`   | Profession — Self             | text |
| `spouseProfession` | Profession — Spouse           | text |
| `selfIncome`       | Source of Income — Self       | text |
| `spouseIncome`     | Source of Income — Spouse     | text |
| `dependentIncome`  | Source of Income — Dependents | text |

---

### Section 13: Contracts with Government

From the form: "(9B) Contracts with appropriate Government and any public company or companies"

| Field Name                  | Label                          | Type     | Description (from form)                                                                                                             |
| --------------------------- | ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `contractsCandidate`        | Contracts by Candidate         | textarea | "details of contracts entered by the candidate"                                                                                     |
| `contractsSpouse`           | Contracts by Spouse            | textarea | "details of contracts entered into by spouse"                                                                                       |
| `contractsDependents`       | Contracts by Dependents        | textarea | "details of contracts entered into by dependents"                                                                                   |
| `contractsHUF`              | Contracts by HUF/Trust         | textarea | "details of contracts entered into by Hindu Undivided Family or trust in which the candidate or spouse or dependents have interest" |
| `contractsPartnershipFirms` | Contracts by Partnership Firms | textarea | "details of contracts entered into by Partnership Firms in which candidate or spouse or dependents are partners"                    |
| `contractsPrivateCompanies` | Contracts by Private Companies | textarea | "details of contracts entered into by private companies in which candidate or spouse or dependents have share"                      |

---

### Section 14: Education

From the form: "(10) My educational qualification is as under"

| Field Name                 | Label                             | Type     | Placeholder                                                                                                                                                                                                    |
| -------------------------- | --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `educationalQualification` | Highest Educational Qualification | textarea | "Give details of highest School/University education mentioning the full form of the certificate/diploma/degree course, name of the School/College/University and the year in which the course was completed." |

---

### Section 15: Verification

From the form: "Verified at \_\_\_\_ this the \_\_\_\_ day of \_\_\_\_"

| Field Name          | Label                 | Type | Placeholder |
| ------------------- | --------------------- | ---- | ----------- |
| `verificationPlace` | Place of Verification | text |             |
| `verificationDate`  | Date of Verification  | text | DD/MM/YYYY  |

---

### Section 16: Oath Commissioner / Notary Details

From the form: "Before me, \_\_\_\_ (Name of the Oath Commissioner / Magistrate / Notary)"

The affidavit must be sworn before an Oath Commissioner, First Class Magistrate, or Notary Public. Their details are required.

| Field Name                    | Label                              | Type | Placeholder                                |
| ----------------------------- | ---------------------------------- | ---- | ------------------------------------------ |
| `oathCommissionerName`        | Name of Oath Commissioner / Notary | text |                                            |
| `oathCommissionerDesignation` | Designation                        | text | e.g. "Notary Public" / "Oath Commissioner" |
| `oathCommissionerSealNo`      | Seal / Registration No.            | text |                                            |

---

## Complete JSON Payload — Example `POST /affidavits/manual-entry`

```json
{
  "houseName": "Legislative Assembly",
  "constituency": "116 BIDHANNAGAR",
  "state": "WEST BENGAL",
  "candidateName": "RAJESH KUMAR SHARMA",
  "fatherMotherHusbandName": "LATE SURESH KUMAR SHARMA",
  "age": "52",
  "postalAddress": "Flat 3B, Block A, Salt Lake Sector II, Kolkata 700091",
  "party": "All India Trinamool Congress",
  "isIndependent": false,
  "enrolledConstituency": "116 Bidhannagar, West Bengal",
  "serialNumber": "1234",
  "partNumber": "45",
  "telephone": "9876543210",
  "email": "rajesh.sharma@example.com",
  "socialMedia1": "@rajeshsharma (Twitter)",
  "socialMedia2": "facebook.com/rajeshsharma",
  "socialMedia3": "",
  "candidatePhotoUrl": "https://res.cloudinary.com/.../affidavit_images/photo123.jpg",
  "candidateSignatureUrl": "https://res.cloudinary.com/.../affidavit_images/sig456.jpg",
  "panEntries": [
    {
      "slNo": "1",
      "name": "Rajesh Kumar Sharma",
      "pan": "ABCRS1234F",
      "years": [
        { "year": "2024-25", "income": "1500000" },
        { "year": "2023-24", "income": "1400000" },
        { "year": "2022-23", "income": "1300000" },
        { "year": "2021-22", "income": "1200000" },
        { "year": "2020-21", "income": "1100000" }
      ]
    },
    {
      "slNo": "2",
      "name": "Priya Sharma",
      "pan": "DEFPS5678K",
      "years": [{ "year": "2024-25", "income": "800000" }]
    }
  ],
  "hasPendingCases": "No",
  "pendingCases": [],
  "hasConvictions": "No",
  "convictions": [],
  "informedParty": "NOT APPLICABLE IN VIEW OF ENTRIES IN 5(i) and 6(i)",
  "movableAssets": {
    "cashSelf": "150000",
    "cashSpouse": "50000",
    "bankSelf": "3500000",
    "bankSpouse": "1200000",
    "bondsSelf": "800000",
    "motorSelf": "Honda City, WB01AB1234, 2020, Rs.800000",
    "jewellSelf": "Gold 100g approx Rs.600000",
    "totalSelf": "5850000",
    "totalSpouse": "1250000"
  },
  "immovableAssets": {
    "residential": [
      {
        "location": "Flat 3B, Block A, Salt Lake Sector II, Kolkata",
        "surveyNo": "Plot 45/B",
        "area": "1400 sq.ft",
        "inherited": "No",
        "purchaseDate": "20/03/2015",
        "purchaseCost": "4500000",
        "investment": "500000",
        "marketValue": "9500000"
      }
    ]
  },
  "liabilities": {
    "bankLoansSelf": "SBI Home Loan, Rs.2000000 outstanding",
    "totalSelf": "2000000"
  },
  "governmentDues": {
    "municipalSelf": "12000",
    "totalSelf": "12000"
  },
  "disputedLiabilities": "NIL",
  "governmentAccommodation": {
    "occupied": "No",
    "address": "",
    "noDues": "Yes",
    "duesDate": "",
    "rentDues": "",
    "electricityDues": "",
    "waterDues": "",
    "telephoneDues": ""
  },
  "selfProfession": "Advocate",
  "spouseProfession": "Homemaker",
  "selfIncome": "Legal Practice",
  "spouseIncome": "None",
  "dependentIncome": "",
  "contractsCandidate": "None",
  "contractsSpouse": "None",
  "contractsDependents": "None",
  "contractsHUF": "Not Applicable",
  "contractsPartnershipFirms": "Not Applicable",
  "contractsPrivateCompanies": "Not Applicable",
  "educationalQualification": "LL.B., University of Calcutta, 1998",
  "verificationPlace": "Kolkata",
  "verificationDate": "15/03/2026",
  "oathCommissionerName": "Mr. Sanjay Mukherjee",
  "oathCommissionerDesignation": "Notary Public",
  "oathCommissionerSealNo": "NP/KOL/2019/1234"
}
```

---

## UI/UX Guidelines

### Layout

- Use a **stepper/wizard** or a **scrollable single-page form** with section headers and anchor navigation on the side.
- Each section should have a clear heading matching the original form section titles.
- Show the original form note/instruction text in italics or as helper text under each section title.

### Form Controls

- All text inputs: Use Material UI / Chakra UI / Tailwind styled inputs.
- Textareas for multi-line fields (postalAddress, contract details, education, etc.).
- Select/radio for Yes/No questions (hasPendingCases, hasConvictions, etc.).
- Checkbox for `isIndependent`.
- **Conditional sections:** Show criminal case tables only when "Yes" is selected.
- **Dynamic tables:** Criminal cases, convictions, PAN entries, immovable assets — all need "Add Row" / "Remove Row" buttons.
- **Grid tables:** Movable assets, liabilities, government dues — render as spreadsheet-like grids with text inputs in cells.

### Actions

- **Save Draft** button — calls `POST /affidavits/manual-entry` with current data. Store the returned `sessionId` for future updates (pass `sessionId` in subsequent saves).
- **Export DOCX** button — calls `GET /affidavits/sessions/:id/export/docx` to download the filled document.
- **Edit existing** — Load data via `GET /affidavits/sessions/:id` and populate the form, then update via `POST /affidavits/manual-entry` with `sessionId`.

### Sessions List Page

- A separate page/panel listing all affidavit sessions (from `GET /affidavits/sessions`).
- Each row shows: candidate name, party, constituency, state, status, created date.
- Actions per row: Edit (opens form pre-filled), Export DOCX (download), Delete, Rename.
- Search bar filtering by candidate/party/constituency/state (calls `GET /affidavits/search`).

---

## Notes from the Original Form 26 DOCX

1. "Affidavit should be filed latest by 3.00 PM on the last day of filing nominations."
2. "Affidavit should be sworn before an Oath Commissioner or Magistrate of the First Class or before a Notary Public."
3. "All columns should be filled up and no column to be left blank. If there is no information to furnish in respect of any item, either 'Nil' or 'Not applicable', as the case may be, should be mentioned."
4. "The affidavit should be either typed or written legibly and neatly."
5. "Each page of the Affidavit should be signed by the deponent."
6. Part B (Abstract/Summary) is auto-filled by the template from Part A data — no separate user input needed for Part B unless overrides are required.
