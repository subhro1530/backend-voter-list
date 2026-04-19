import fs from "fs-extra";
import { buildMassVoterSlipPdfFile } from "../voterSlipPdf.js";

function safeSend(payload) {
  if (typeof process.send === "function") {
    process.send(payload);
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function runMassSlipRender(message) {
  const payloadPath = String(message?.payloadPath || "").trim();
  const outputPath = String(message?.outputPath || "").trim();
  const progressStep = parsePositiveInt(message?.progressStep, 20);

  if (!payloadPath) {
    throw new Error("payloadPath is required");
  }
  if (!outputPath) {
    throw new Error("outputPath is required");
  }

  const payload = await fs.readJson(payloadPath);
  const voters = Array.isArray(payload?.voters) ? payload.voters : [];

  if (voters.length === 0) {
    throw new Error("No voters available for mass slip generation");
  }

  let lastReported = 0;

  await buildMassVoterSlipPdfFile(voters, outputPath, {
    onProgress: (processed, total) => {
      const current = Math.max(0, Number(processed) || 0);
      const final = Math.max(0, Number(total) || 0);
      const shouldReport =
        current <= 1 ||
        current === final ||
        current - lastReported >= progressStep;

      if (!shouldReport) return;

      lastReported = current;
      safeSend({
        type: "progress",
        processed: current,
        total: final,
      });
    },
  });

  safeSend({
    type: "completed",
    total: voters.length,
  });
}

process.on("message", async (message) => {
  if (!message || message.type !== "start") return;

  try {
    await runMassSlipRender(message);
    process.exit(0);
  } catch (error) {
    safeSend({
      type: "failed",
      error: error?.message || "Mass slip worker failed",
    });
    process.exit(1);
  }
});
