/*
  Frontend helper for Election Results -> View Voters linkage.
  Use this in your frontend bundle (browser context).
*/

function normalizeBoothNo(value) {
  const bengaliToAsciiDigits = {
    "০": "0",
    "১": "1",
    "২": "2",
    "৩": "3",
    "৪": "4",
    "৫": "5",
    "৬": "6",
    "৭": "7",
    "৮": "8",
    "৯": "9",
  };

  const ascii = String(value || "")
    .split("")
    .map((ch) => bengaliToAsciiDigits[ch] || ch)
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!ascii) return "";

  const match = ascii.match(/(\d{1,4}[A-Z]?)/);
  return match ? match[1] : ascii;
}

function extractBoothNoFromFilename(filename) {
  const text = String(filename || "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!text) return "";

  const explicit = text.match(
    /\b(?:booth|part|ps|polling\s*station)\s*(?:no|number)?\s*[:#-]?\s*(\d{1,4}[A-Z]?)\b/i,
  );
  if (explicit?.[1]) return normalizeBoothNo(explicit[1]);

  const fallback = text.match(/\b(\d{1,4}[A-Z]?)\b/i);
  return fallback?.[1] ? normalizeBoothNo(fallback[1]) : "";
}

export function resolveSessionBoothNo(sessionLike, responseSessionLike) {
  const fromSession = normalizeBoothNo(
    sessionLike?.booth_no || sessionLike?.boothNo || "",
  );
  if (fromSession) {
    return { boothNo: fromSession, source: "session" };
  }

  const fromResponse = normalizeBoothNo(
    responseSessionLike?.booth_no || responseSessionLike?.boothNo || "",
  );
  if (fromResponse) {
    return { boothNo: fromResponse, source: "response" };
  }

  const fromFilename = extractBoothNoFromFilename(
    sessionLike?.original_filename ||
      sessionLike?.originalFilename ||
      responseSessionLike?.original_filename ||
      responseSessionLike?.originalFilename ||
      "",
  );
  if (fromFilename) {
    return { boothNo: fromFilename, source: "filename" };
  }

  return { boothNo: "", source: "missing" };
}

function getSelectionKey(electionSessionId, boothNo) {
  return `booth-selection:${electionSessionId}:${normalizeBoothNo(boothNo)}`;
}

function readRememberedSelection(electionSessionId, boothNo) {
  try {
    const key = getSelectionKey(electionSessionId, boothNo);
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeRememberedSelection(electionSessionId, boothNo, voterSessionId) {
  if (!voterSessionId) return;
  try {
    const key = getSelectionKey(electionSessionId, boothNo);
    window.localStorage.setItem(key, voterSessionId);
  } catch {
    // Ignore storage failures in private mode or restricted contexts.
  }
}

async function fetchBoothVoters({
  apiBaseUrl,
  token,
  electionSessionId,
  boothNo,
  voterSessionId,
  limit = 200,
  includeVoters = true,
  fetchImpl = window.fetch.bind(window),
}) {
  const canonicalBoothNo = normalizeBoothNo(boothNo);
  if (!canonicalBoothNo) {
    const error = new Error("Booth number is required");
    error.status = 400;
    throw error;
  }

  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/election-results/sessions/${encodeURIComponent(electionSessionId)}/booths/voter-list`,
  );
  url.searchParams.set("boothNo", canonicalBoothNo);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("includeVoters", includeVoters ? "1" : "0");
  if (voterSessionId) {
    url.searchParams.set("voterSessionId", voterSessionId);
  }

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.error || `Request failed: ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

/*
  Main action for the View Voters button:
  1) Try remembered voter session for this booth.
  2) If backend returns 400 for stale selection, retry once without voterSessionId.
  3) Persist selected session from response.
*/
export async function openBoothVoters({
  apiBaseUrl,
  token,
  electionSessionId,
  boothNo,
  limit = 200,
  progressive = true,
  onStart,
  onMeta,
  onSuccess,
  onError,
  fetchImpl,
}) {
  const canonicalBoothNo = normalizeBoothNo(boothNo);
  const remembered = readRememberedSelection(
    electionSessionId,
    canonicalBoothNo,
  );

  try {
    if (typeof onStart === "function") {
      onStart({
        electionSessionId,
        boothNo: canonicalBoothNo,
        rememberedVoterSessionId: remembered || null,
      });
    }

    if (progressive) {
      const meta = await fetchBoothVoters({
        apiBaseUrl,
        token,
        electionSessionId,
        boothNo: canonicalBoothNo,
        voterSessionId: remembered || "",
        limit: 0,
        includeVoters: false,
        fetchImpl,
      });

      if (meta?.selectedSession?.id) {
        writeRememberedSelection(
          electionSessionId,
          canonicalBoothNo,
          meta.selectedSession.id,
        );
      }

      if (typeof onMeta === "function") {
        onMeta({
          ...meta,
          openedFromMemory: meta.selectionSource === "memory",
        });
      }

      const selectedId = meta?.selectedSession?.id || remembered || "";
      const fullData = await fetchBoothVoters({
        apiBaseUrl,
        token,
        electionSessionId,
        boothNo: canonicalBoothNo,
        voterSessionId: selectedId,
        limit,
        includeVoters: true,
        fetchImpl,
      });

      if (fullData?.selectedSession?.id) {
        writeRememberedSelection(
          electionSessionId,
          canonicalBoothNo,
          fullData.selectedSession.id,
        );
      }

      const result = {
        ...fullData,
        openedFromMemory: fullData.selectionSource === "memory",
      };

      if (typeof onSuccess === "function") {
        onSuccess(result);
      }

      return result;
    }
    const data = await fetchBoothVoters({
      apiBaseUrl,
      token,
      electionSessionId,
      boothNo: canonicalBoothNo,
      voterSessionId: remembered || "",
      limit,
      includeVoters: true,
      fetchImpl,
    });

    if (data?.selectedSession?.id) {
      writeRememberedSelection(
        electionSessionId,
        canonicalBoothNo,
        data.selectedSession.id,
      );
    }

    const result = {
      ...data,
      openedFromMemory: data.selectionSource === "memory",
    };

    if (typeof onSuccess === "function") {
      onSuccess(result);
    }

    return result;
  } catch (err) {
    const shouldRetryWithoutSelection =
      err?.status === 400 && Boolean(remembered);
    if (!shouldRetryWithoutSelection) {
      if (typeof onError === "function") {
        onError(err);
      }
      throw err;
    }

    const retryData = await fetchBoothVoters({
      apiBaseUrl,
      token,
      electionSessionId,
      boothNo: canonicalBoothNo,
      voterSessionId: "",
      limit,
      includeVoters: true,
      fetchImpl,
    });

    if (retryData?.selectedSession?.id) {
      writeRememberedSelection(
        electionSessionId,
        canonicalBoothNo,
        retryData.selectedSession.id,
      );
    }

    const result = {
      ...retryData,
      openedFromMemory: retryData.selectionSource === "memory",
      retriedWithoutRememberedSelection: true,
    };

    if (typeof onSuccess === "function") {
      onSuccess(result);
    }

    return result;
  }
}

export async function switchBoothVoterSession({
  apiBaseUrl,
  token,
  electionSessionId,
  boothNo,
  voterSessionId,
  limit = 200,
  fetchImpl,
}) {
  const canonicalBoothNo = normalizeBoothNo(boothNo);
  const data = await fetchBoothVoters({
    apiBaseUrl,
    token,
    electionSessionId,
    boothNo: canonicalBoothNo,
    voterSessionId,
    limit,
    includeVoters: true,
    fetchImpl,
  });

  if (data?.selectedSession?.id) {
    writeRememberedSelection(
      electionSessionId,
      canonicalBoothNo,
      data.selectedSession.id,
    );
  }

  return data;
}
