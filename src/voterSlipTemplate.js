import path from "path";
import fs from "fs-extra";

const ROOT_TEMPLATE_RELATIVE_PATH = "sabyasachi_dutta_voterslip_format.png";

const FALLBACK_TEMPLATE_RELATIVE_PATH = path.join(
  "storage",
  "voterslips",
  "layout",
  "template.png",
);

function toAbsoluteTemplatePath(configuredPath) {
  const normalized = String(configuredPath || "").trim();
  if (!normalized) {
    return path.join(process.cwd(), ROOT_TEMPLATE_RELATIVE_PATH);
  }

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  return path.join(process.cwd(), normalized);
}

export function getConfiguredVoterSlipTemplatePath() {
  const configuredPath =
    process.env.VOTER_SLIP_TEMPLATE_PATH ||
    process.env.VOTER_SLIP_TEMPLATE_FILE;
  return toAbsoluteTemplatePath(configuredPath);
}

export async function getExistingVoterSlipTemplatePath() {
  const configuredPath = getConfiguredVoterSlipTemplatePath();
  const configuredExists = await fs.pathExists(configuredPath);
  if (configuredExists) return configuredPath;

  const fallbackPath = path.join(
    process.cwd(),
    FALLBACK_TEMPLATE_RELATIVE_PATH,
  );
  const fallbackExists = await fs.pathExists(fallbackPath);
  if (fallbackExists) return fallbackPath;

  return null;
}

export async function ensureVoterSlipTemplatePath() {
  const templatePath = await getExistingVoterSlipTemplatePath();
  if (!templatePath) {
    throw new Error(
      "Voter slip template not found. Place template at sabyasachi_dutta_voterslip_format.png (root) or set VOTER_SLIP_TEMPLATE_PATH.",
    );
  }
  return templatePath;
}

export function getVoterSlipTemplatePublicHint() {
  const templatePath = getConfiguredVoterSlipTemplatePath();
  return path.relative(process.cwd(), templatePath).replaceAll("\\", "/");
}
