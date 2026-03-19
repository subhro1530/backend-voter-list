import path from "path";
import fs from "fs-extra";
import "regenerator-runtime/runtime.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getVoterSlipLayout } from "./voterSlipLayout.js";
import {
  getExistingVoterSlipTemplatePath,
  ensureVoterSlipTemplatePath,
} from "./voterSlipTemplate.js";

const localFontPath = path.join(
  process.cwd(),
  "storage",
  "fonts",
  "NotoSansBengali-Regular.ttf",
);

let templateBytesPromise = null;
let templateBytesPath = null;

let unicodeFontBytesPromise = null;

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function toAge(value) {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  if (Number.isNaN(n)) return normalizeText(value);
  return String(n);
}

function toGenderShort(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";
  if (
    raw.startsWith("m") ||
    raw.includes("male") ||
    raw.includes("পুরুষ") ||
    raw.includes("purush")
  ) {
    return "M";
  }
  if (
    raw.startsWith("f") ||
    raw.includes("female") ||
    raw.includes("মহিলা") ||
    raw.includes("নারী") ||
    raw.includes("mohila") ||
    raw.includes("nari")
  ) {
    return "F";
  }
  return "O";
}

function buildAddress(voter) {
  const house = normalizeText(voter.houseNumber);
  const section = normalizeText(voter.section);

  if (house && section) return `${house}, ${section}`;
  return house || section;
}

function serialSortKey(value) {
  const text = normalizeText(value);
  if (!text) return Number.POSITIVE_INFINITY;
  const match = text.match(/\d+/);
  if (!match) return Number.POSITIVE_INFINITY;
  const parsed = Number(match[0]);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function sortVotersBySerial(voters) {
  return [...voters].sort((a, b) => {
    const aNum = serialSortKey(a?.serialNumber);
    const bNum = serialSortKey(b?.serialNumber);
    if (aNum !== bNum) return aNum - bNum;

    const aText = normalizeText(a?.serialNumber);
    const bText = normalizeText(b?.serialNumber);
    if (aText !== bText) return aText.localeCompare(bText);

    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

export async function ensureVoterSlipTemplateExists() {
  const existingPath = await getExistingVoterSlipTemplatePath();
  return Boolean(existingPath);
}

async function getTemplateBytes() {
  const templatePath = await ensureVoterSlipTemplatePath();
  if (!templateBytesPromise || templateBytesPath !== templatePath) {
    templateBytesPromise = fs.readFile(templatePath);
    templateBytesPath = templatePath;
  }
  return templateBytesPromise;
}

function getUnicodeFontCandidates() {
  const configured = process.env.VOTER_SLIP_FONT_PATH
    ? [process.env.VOTER_SLIP_FONT_PATH]
    : [];

  return [
    ...configured,
    localFontPath,
    "C:/Windows/Fonts/Nirmala.ttf",
    "C:/Program Files/Microsoft Office/root/vfs/Fonts/private/NIRMALA.TTF",
    "C:/Program Files/Microsoft Office/root/vfs/Fonts/private/NIRMALAB.TTF",
    "C:/Windows/Fonts/vrinda.ttf",
    "C:/Windows/Fonts/arialuni.ttf",
  ];
}

async function getUnicodeFontBytes() {
  if (unicodeFontBytesPromise) return unicodeFontBytesPromise;

  unicodeFontBytesPromise = (async () => {
    const candidates = getUnicodeFontCandidates();
    for (const fontPath of candidates) {
      if (!fontPath) continue;
      const exists = await fs.pathExists(fontPath);
      if (exists) {
        return fs.readFile(fontPath);
      }
    }
    return null;
  })();

  return unicodeFontBytesPromise;
}

function hasNonAscii(value) {
  return /[^\x00-\x7F]/.test(String(value ?? ""));
}

function voterNeedsUnicodeFont(voter) {
  return [
    voter?.partNumber,
    voter?.boothNo,
    voter?.serialNumber,
    voter?.name,
    voter?.relationName,
    voter?.houseNumber,
    voter?.section,
    voter?.gender,
    voter?.age,
    voter?.boothName,
  ].some(hasNonAscii);
}

async function embedSlipFont(pdfDoc, requiresUnicode = false) {
  pdfDoc.registerFontkit(fontkit);
  const unicodeBytes = await getUnicodeFontBytes();
  if (unicodeBytes) {
    return pdfDoc.embedFont(unicodeBytes, { subset: true });
  }
  if (requiresUnicode) {
    throw new Error(
      "Unicode font not found for Bengali text. Set VOTER_SLIP_FONT_PATH or place NotoSansBengali-Regular.ttf in storage/fonts.",
    );
  }
  return pdfDoc.embedFont(StandardFonts.Helvetica);
}

function wrapTextToWidth(font, text, fontSize, maxWidth, maxLines) {
  const safeText = normalizeText(text);
  if (!safeText) return [];

  const words = safeText.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, fontSize);

    if (width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (!current) {
      lines.push(word);
    } else {
      lines.push(current);
      current = word;
    }

    if (lines.length >= maxLines) return lines.slice(0, maxLines);
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.slice(0, maxLines);
}

function drawTextInBox(page, text, options) {
  const {
    font,
    x,
    y,
    width,
    height,
    align = "left",
    maxLines = 1,
    maxFontSize = 24,
    minFontSize = 10,
    paddingX = 4,
    paddingY = 4,
    color = rgb(0, 0, 0),
  } = options;

  const safeText = normalizeText(text);
  if (!safeText) return;

  const contentWidth = Math.max(1, width - paddingX * 2);
  const contentHeight = Math.max(1, height - paddingY * 2);

  let fontSize = Math.max(minFontSize, maxFontSize);
  let lines = [];

  while (fontSize >= minFontSize) {
    lines = wrapTextToWidth(font, safeText, fontSize, contentWidth, maxLines);
    const lineHeight = fontSize * 1.18;
    const totalHeight = lines.length * lineHeight;
    const widestLine = lines.reduce(
      (max, line) => Math.max(max, font.widthOfTextAtSize(line, fontSize)),
      0,
    );

    if (totalHeight <= contentHeight && widestLine <= contentWidth) {
      break;
    }

    fontSize -= 1;
  }

  const finalLineHeight = fontSize * 1.18;
  const usedHeight = lines.length * finalLineHeight;
  let baselineY =
    y + height - paddingY - (contentHeight - usedHeight) / 2 - fontSize;

  lines.forEach((line, idx) => {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    let drawX = x + paddingX;

    if (align === "center") {
      drawX = x + (width - lineWidth) / 2;
    } else if (align === "right") {
      drawX = x + width - paddingX - lineWidth;
    }

    page.drawText(line, {
      x: drawX,
      y: baselineY - idx * finalLineHeight,
      size: fontSize,
      font,
      color,
    });
  });
}

function mapSlipData(voter) {
  const partNo = normalizeText(voter.partNumber || voter.boothNo);
  const serialNumber = normalizeText(voter.serialNumber);
  const name = normalizeText(voter.name);
  const father = normalizeText(voter.relationName);
  const address = buildAddress(voter);
  const sex = toGenderShort(voter.gender);
  const age = toAge(voter.age);
  const pollingStation = normalizeText(voter.boothName || voter.section);

  return {
    partNo,
    serialNumber,
    name,
    father,
    address,
    sex,
    age,
    pollingStation,
  };
}

function drawSlipOnPage(page, image, font, x, y, width, height, voter, layout) {
  page.drawImage(image, {
    x,
    y,
    width,
    height,
  });

  const d = mapSlipData(voter);

  const fieldValues = {
    partNo: d.partNo,
    serialNumber: d.serialNumber,
    name: d.name,
    father: d.father,
    address: d.address,
    sex: d.sex,
    age: d.age,
    pollingStation: d.pollingStation,
  };

  Object.entries(fieldValues).forEach(([fieldName, value]) => {
    const field = layout.fields[fieldName];
    if (!field) return;

    drawTextInBox(page, value, {
      font,
      x: x + width * field.x,
      y: y + height * field.y,
      width: width * field.width,
      height: height * field.height,
      align: field.align || "left",
      maxLines: field.maxLines || 1,
      maxFontSize: field.maxFontSize || 24,
      minFontSize: field.minFontSize || 10,
      paddingX: width * (field.paddingX || 0.006),
      paddingY: height * (field.paddingY || 0.008),
    });
  });
}

async function buildTemplateEmbed(pdfDoc) {
  const imageBytes = await getTemplateBytes();
  const image = await pdfDoc.embedPng(imageBytes);

  return {
    image,
    width: image.width,
    height: image.height,
  };
}

export async function buildSingleVoterSlipPdf(voter) {
  const pdfDoc = await PDFDocument.create();
  const font = await embedSlipFont(pdfDoc, voterNeedsUnicodeFont(voter));
  const layout = await getVoterSlipLayout();

  const tpl = await buildTemplateEmbed(pdfDoc);
  const page = pdfDoc.addPage([tpl.width, tpl.height]);

  drawSlipOnPage(
    page,
    tpl.image,
    font,
    0,
    0,
    tpl.width,
    tpl.height,
    voter,
    layout,
  );

  return pdfDoc.save();
}

function formatBoothFilename(boothNo) {
  return normalizeText(boothNo || "unknown")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function buildMassSlipFilename(boothNo) {
  const safeBooth = formatBoothFilename(boothNo);
  return `voterslips-booth-${safeBooth || "unknown"}.pdf`;
}

export async function buildMassVoterSlipPdfFile(
  voters,
  outputPath,
  options = {},
) {
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : () => {};

  const orderedVoters = sortVotersBySerial(voters);
  const requiresUnicode = orderedVoters.some(voterNeedsUnicodeFont);

  const pdfDoc = await PDFDocument.create();
  const font = await embedSlipFont(pdfDoc, requiresUnicode);
  const layout = await getVoterSlipLayout();
  const tpl = await buildTemplateEmbed(pdfDoc);

  // Always keep 4 slips per page: fixed 2x2 grid on A4 landscape.
  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 18;
  const marginY = 18;
  const gapX = 14;
  const gapY = 14;

  const cols = 2;
  const rows = 2;
  const slipsPerPage = cols * rows;

  const availableCellWidth =
    (pageWidth - marginX * 2 - gapX * (cols - 1)) / cols;
  const availableCellHeight =
    (pageHeight - marginY * 2 - gapY * (rows - 1)) / rows;

  const templateAspect = tpl.width / tpl.height;
  let cardWidth = availableCellWidth;
  let cardHeight = cardWidth / templateAspect;

  // Fit card inside cell while preserving template aspect ratio.
  if (cardHeight > availableCellHeight) {
    cardHeight = availableCellHeight;
    cardWidth = cardHeight * templateAspect;
  }

  // Extra shrink to guarantee clean 4-up layout even with printer scaling.
  const cardScale = 0.92;
  cardWidth *= cardScale;
  cardHeight *= cardScale;

  let page = null;

  for (let i = 0; i < orderedVoters.length; i += 1) {
    const idxInPage = i % slipsPerPage;
    if (idxInPage === 0) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
    }

    const row = Math.floor(idxInPage / cols);
    const col = idxInPage % cols;

    const cellX = marginX + col * (availableCellWidth + gapX);
    const cellY =
      pageHeight - marginY - (row + 1) * availableCellHeight - row * gapY;

    // Center card inside each cell.
    const x = cellX + (availableCellWidth - cardWidth) / 2;
    const y = cellY + (availableCellHeight - cardHeight) / 2;

    drawSlipOnPage(
      page,
      tpl.image,
      font,
      x,
      y,
      cardWidth,
      cardHeight,
      orderedVoters[i],
      layout,
    );

    onProgress(i + 1, orderedVoters.length);

    if (i > 0 && i % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fs.outputFile(outputPath, Buffer.from(pdfBytes));
}
