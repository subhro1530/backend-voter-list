import "dotenv/config";
import {
  runStartupApiKeyAssessment,
  getApiKeyStatuses,
  persistAllApiKeyStates,
} from "../src/gemini.js";

async function main() {
  try {
    const assessment = await runStartupApiKeyAssessment();
    await persistAllApiKeyStates();

    const status = assessment?.status || getApiKeyStatuses();
    const free = status?.pools?.free || {};
    const paid = status?.pools?.paid || {};

    console.log("\n=== Gemini Startup Check ===");
    console.log(`Dispatch tier: ${status.activeDispatchTier}`);
    console.log(
      `Free pool: available=${free.available || 0}, active=${free.active || 0}, rateLimited=${free.rateLimited || 0}, exhausted=${free.exhausted || 0}`,
    );
    console.log(
      `Paid pool: available=${paid.available || 0}, active=${paid.active || 0}, rateLimited=${paid.rateLimited || 0}, exhausted=${paid.exhausted || 0}`,
    );

    if (status.allExhausted) {
      console.log(
        "⚠️ All keys appear exhausted at startup. OCR requests may pause until quota recovers.",
      );
    }

    console.log("=== End Gemini Startup Check ===\n");
  } catch (err) {
    // Do not block server boot; this check is an optimization pass.
    console.warn("⚠️ Gemini startup check failed:", err.message);
  }
}

await main();
