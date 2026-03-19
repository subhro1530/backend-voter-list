import path from "path";
import fs from "fs-extra";
import {
  buildVoterSlipLayout,
  getDefaultVoterSlipLayout,
  saveVoterSlipLayout,
} from "./voterSlipLayout.js";

const calibrationStatePath = path.join(
  process.cwd(),
  "storage",
  "voter-slip-calibration-state.json",
);

const manualProfilesPath = path.join(
  process.cwd(),
  "storage",
  "voter-slip-manual-profiles.json",
);

const DEFAULT_STATE = {
  preferredMode: "default",
  lastUsedMode: "default",
  activeManualProfileId: null,
  lastUsedManualProfileId: null,
  updatedAt: null,
};

function toIsoNow() {
  return new Date().toISOString();
}

function sanitizeMode(mode) {
  return ["manual", "gemini", "default"].includes(mode) ? mode : "default";
}

async function readJsonOrFallback(filePath, fallback) {
  try {
    const exists = await fs.pathExists(filePath);
    if (!exists) return fallback;
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function getVoterSlipCalibrationStatePath() {
  return calibrationStatePath;
}

export function getVoterSlipManualProfilesPath() {
  return manualProfilesPath;
}

export async function getCalibrationState() {
  const saved = await readJsonOrFallback(calibrationStatePath, DEFAULT_STATE);
  return {
    ...DEFAULT_STATE,
    ...saved,
    preferredMode: sanitizeMode(saved.preferredMode),
    lastUsedMode: sanitizeMode(saved.lastUsedMode),
  };
}

export async function saveCalibrationState(patch) {
  const current = await getCalibrationState();
  const next = {
    ...current,
    ...(patch || {}),
    preferredMode: sanitizeMode(
      (patch || {}).preferredMode ?? current.preferredMode,
    ),
    lastUsedMode: sanitizeMode(
      (patch || {}).lastUsedMode ?? current.lastUsedMode,
    ),
    updatedAt: toIsoNow(),
  };
  await fs.outputJson(calibrationStatePath, next, { spaces: 2 });
  return next;
}

export async function getManualProfiles() {
  const list = await readJsonOrFallback(manualProfilesPath, []);
  return Array.isArray(list) ? list : [];
}

export async function saveManualProfiles(profiles) {
  const next = Array.isArray(profiles) ? profiles : [];
  await fs.outputJson(manualProfilesPath, next, { spaces: 2 });
  return next;
}

function normalizeProfileRecord(profile) {
  return {
    id: String(profile.id),
    name: String(profile.name || "Manual Layout"),
    createdAt: profile.createdAt || toIsoNow(),
    updatedAt: toIsoNow(),
    source: "manual-ui",
    layout: profile.layout,
  };
}

export async function upsertManualProfile({
  id,
  name,
  fields,
  activate = true,
  setPreferred = true,
}) {
  const profileId = String(id);
  const profileName = String(name || "Manual Layout").trim() || "Manual Layout";
  const layout = buildVoterSlipLayout(fields, {
    versionPrefix: "manual",
  });

  const profiles = await getManualProfiles();
  const existingIndex = profiles.findIndex((p) => String(p.id) === profileId);
  const nextRecord = normalizeProfileRecord({
    id: profileId,
    name: profileName,
    createdAt:
      existingIndex >= 0 ? profiles[existingIndex].createdAt : toIsoNow(),
    layout,
  });

  if (existingIndex >= 0) {
    profiles[existingIndex] = nextRecord;
  } else {
    profiles.push(nextRecord);
  }

  await saveManualProfiles(profiles);

  if (activate) {
    await saveVoterSlipLayout(layout);
  }

  const statePatch = {
    lastUsedManualProfileId: profileId,
    lastUsedMode: activate ? "manual" : undefined,
    activeManualProfileId: activate ? profileId : undefined,
    preferredMode: setPreferred ? "manual" : undefined,
  };

  const filteredStatePatch = Object.fromEntries(
    Object.entries(statePatch).filter(([, value]) => value !== undefined),
  );
  const state = await saveCalibrationState(filteredStatePatch);

  return {
    profile: nextRecord,
    state,
  };
}

export async function applyManualProfile(
  profileId,
  { setPreferred = true } = {},
) {
  const profiles = await getManualProfiles();
  const profile = profiles.find((p) => String(p.id) === String(profileId));
  if (!profile) return null;

  await saveVoterSlipLayout(profile.layout || getDefaultVoterSlipLayout());
  const state = await saveCalibrationState({
    lastUsedMode: "manual",
    activeManualProfileId: String(profile.id),
    lastUsedManualProfileId: String(profile.id),
    preferredMode: setPreferred ? "manual" : undefined,
  });

  return {
    profile,
    state,
  };
}
