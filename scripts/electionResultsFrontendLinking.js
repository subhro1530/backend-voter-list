/*
  Frontend helper for Election Results -> View Voters linkage.
  Use this in your frontend bundle (browser context).
*/

function normalizeBoothNo(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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
  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/election-results/sessions/${encodeURIComponent(electionSessionId)}/booths/voter-list`,
  );
  url.searchParams.set("boothNo", String(boothNo || ""));
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
  const remembered = readRememberedSelection(electionSessionId, boothNo);

  try {
    if (typeof onStart === "function") {
      onStart({
        electionSessionId,
        boothNo,
        rememberedVoterSessionId: remembered || null,
      });
    }

    if (progressive) {
      const meta = await fetchBoothVoters({
        apiBaseUrl,
        token,
        electionSessionId,
        boothNo,
        voterSessionId: remembered || "",
        limit: 0,
        includeVoters: false,
        fetchImpl,
      });

      if (meta?.selectedSession?.id) {
        writeRememberedSelection(
          electionSessionId,
          boothNo,
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
        boothNo,
        voterSessionId: selectedId,
        limit,
        includeVoters: true,
        fetchImpl,
      });

      if (fullData?.selectedSession?.id) {
        writeRememberedSelection(
          electionSessionId,
          boothNo,
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
      boothNo,
      voterSessionId: remembered || "",
      limit,
      includeVoters: true,
      fetchImpl,
    });

    if (data?.selectedSession?.id) {
      writeRememberedSelection(
        electionSessionId,
        boothNo,
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
      boothNo,
      voterSessionId: "",
      limit,
      includeVoters: true,
      fetchImpl,
    });

    if (retryData?.selectedSession?.id) {
      writeRememberedSelection(
        electionSessionId,
        boothNo,
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
  const data = await fetchBoothVoters({
    apiBaseUrl,
    token,
    electionSessionId,
    boothNo,
    voterSessionId,
    limit,
    includeVoters: true,
    fetchImpl,
  });

  if (data?.selectedSession?.id) {
    writeRememberedSelection(
      electionSessionId,
      boothNo,
      data.selectedSession.id,
    );
  }

  return data;
}
