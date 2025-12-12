import fs from "fs-extra";
import path from "path";
import { PDFDocument } from "pdf-lib";

export async function splitPdfToPages(pdfPath, outputDir) {
  await fs.ensureDir(outputDir);

  const pdfBytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();
  const pagePaths = [];

  for (let i = 0; i < totalPages; i += 1) {
    const newPdf = await PDFDocument.create();
    const [page] = await newPdf.copyPages(pdfDoc, [i]);
    newPdf.addPage(page);
    const bytes = await newPdf.save();

    const outPath = path.resolve(outputDir, `page-${i + 1}.pdf`);
    await fs.writeFile(outPath, bytes);
    pagePaths.push(outPath);
  }

  return pagePaths;
}
