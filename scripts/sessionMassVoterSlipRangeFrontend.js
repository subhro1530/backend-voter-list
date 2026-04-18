/*
  Frontend helper for Sessions page booth-range voter-slip ZIP generation.
  Use this in your frontend bundle (browser context).
*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiBaseUrl(apiBaseUrl) {
  return String(apiBaseUrl || "").replace(/\/$/, "");
}

function parseFilenameFromContentDisposition(contentDisposition) {
  const header = String(contentDisposition || "");
  if (!header) return "";

  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {
      return utfMatch[1];
    }
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || "";
}

function parseApiErrorPayload(payload, fallbackStatus) {
  if (!payload || typeof payload !== "object") {
    return {
      message: `Request failed (${fallbackStatus})`,
      details: payload,
    };
  }

  return {
    message:
      payload.error || payload.message || `Request failed (${fallbackStatus})`,
    details: payload,
  };
}

function parseBoothRangeInput(input) {
  const text = String(input || "").trim();
  if (!text) {
    const error = new Error("Booth range is required (example: 1-50)");
    error.status = 400;
    throw error;
  }

  const rangeMatch = text.match(/^(\d{1,4})\s*(?:-|to|:)\s*(\d{1,4})$/i);
  if (rangeMatch) {
    let from = Number.parseInt(rangeMatch[1], 10);
    let to = Number.parseInt(rangeMatch[2], 10);
    if (from > to) {
      [from, to] = [to, from];
    }

    return {
      boothRange: `${from}-${to}`,
      fromBoothNo: from,
      toBoothNo: to,
    };
  }

  const singleMatch = text.match(/^(\d{1,4})$/);
  if (singleMatch) {
    const boothNo = Number.parseInt(singleMatch[1], 10);
    return {
      boothRange: `${boothNo}-${boothNo}`,
      fromBoothNo: boothNo,
      toBoothNo: boothNo,
    };
  }

  const error = new Error("Invalid booth range. Use format like 1-50");
  error.status = 400;
  throw error;
}

async function apiJsonRequest({
  apiBaseUrl,
  token,
  urlPath,
  method = "GET",
  body,
  fetchImpl = window.fetch.bind(window),
}) {
  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}${urlPath}`;
  const response = await fetchImpl(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = parseApiErrorPayload(payload, response.status);
    const error = new Error(parsed.message);
    error.status = response.status;
    error.payload = parsed.details;
    throw error;
  }

  return payload;
}

export async function startBoothRangeZipJob({
  apiBaseUrl,
  token,
  boothRange,
  fetchImpl,
}) {
  const parsed = parseBoothRangeInput(boothRange);

  return apiJsonRequest({
    apiBaseUrl,
    token,
    urlPath: "/user/voterslips/mass/booth-range/start",
    method: "POST",
    body: {
      boothRange: parsed.boothRange,
    },
    fetchImpl,
  });
}

export async function fetchVoterSlipJob({
  apiBaseUrl,
  token,
  jobId,
  fetchImpl,
}) {
  return apiJsonRequest({
    apiBaseUrl,
    token,
    urlPath: `/user/voterslips/mass/jobs/${encodeURIComponent(jobId)}`,
    method: "GET",
    fetchImpl,
  });
}

export async function pollVoterSlipJob({
  apiBaseUrl,
  token,
  jobId,
  pollIntervalMs = 1200,
  maxTransientRetries = 3,
  transientRetryBaseMs = 800,
  maxTransientRetryMs = 5000,
  onProgress,
  onTransientError,
  fetchImpl,
}) {
  let transientRetries = 0;

  while (true) {
    try {
      const payload = await fetchVoterSlipJob({
        apiBaseUrl,
        token,
        jobId,
        fetchImpl,
      });

      const job = payload?.job;
      if (typeof onProgress === "function") {
        onProgress(job);
      }

      if (!job || ["completed", "failed"].includes(job.status)) {
        return job;
      }

      transientRetries = 0;
      await sleep(pollIntervalMs);
    } catch (error) {
      transientRetries += 1;

      if (typeof onTransientError === "function") {
        onTransientError(error, transientRetries);
      }

      if (transientRetries > maxTransientRetries) {
        throw error;
      }

      const backoffMs = Math.min(
        maxTransientRetryMs,
        transientRetryBaseMs * 2 ** (transientRetries - 1),
      );
      await sleep(backoffMs);
    }
  }
}

export async function downloadVoterSlipJobFile({
  apiBaseUrl,
  token,
  jobId,
  fallbackFileName = "voter-slips.zip",
  fetchImpl = window.fetch.bind(window),
}) {
  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/user/voterslips/mass/jobs/${encodeURIComponent(jobId)}/download`;

  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const parsed = parseApiErrorPayload(payload, response.status);
    const error = new Error(parsed.message);
    error.status = response.status;
    error.payload = parsed.details;
    throw error;
  }

  const blob = await response.blob();
  const fileName =
    parseFilenameFromContentDisposition(
      response.headers.get("content-disposition"),
    ) || fallbackFileName;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return {
    fileName,
    size: blob.size,
    mimeType: blob.type,
  };
}

export async function runBoothRangeZipFlow({
  apiBaseUrl,
  token,
  boothRange,
  autoDownload = true,
  onStart,
  onProgress,
  onComplete,
  onFailed,
  onTransientError,
  fetchImpl,
}) {
  const startPayload = await startBoothRangeZipJob({
    apiBaseUrl,
    token,
    boothRange,
    fetchImpl,
  });

  const startedJob = startPayload?.job;
  if (!startedJob?.id) {
    throw new Error("Backend did not return a valid job id");
  }

  if (typeof onStart === "function") {
    onStart(startPayload);
  }

  const finalJob = await pollVoterSlipJob({
    apiBaseUrl,
    token,
    jobId: startedJob.id,
    onProgress,
    onTransientError,
    fetchImpl,
  });

  if (!finalJob) {
    throw new Error("Job polling ended without a final job payload");
  }

  if (finalJob.status === "failed") {
    if (typeof onFailed === "function") {
      onFailed(finalJob);
    }
    return {
      startPayload,
      finalJob,
      download: null,
    };
  }

  let download = null;
  if (autoDownload) {
    download = await downloadVoterSlipJobFile({
      apiBaseUrl,
      token,
      jobId: finalJob.id,
      fallbackFileName: finalJob.fileName || "voter-slips.zip",
      fetchImpl,
    });
  }

  if (typeof onComplete === "function") {
    onComplete({ finalJob, download });
  }

  return {
    startPayload,
    finalJob,
    download,
  };
}
