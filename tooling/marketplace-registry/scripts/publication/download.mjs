import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const MAX_REDIRECTS = 3;
const BODY_HANDLED = Symbol("archive response body handled");

function fail(message) {
  return new Error(`archive download: ${message}`);
}

function validateUrl(value, initial) {
  if (typeof value !== "string") throw fail("invalid URL");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail("invalid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    !REDIRECT_HOSTS.has(parsed.hostname)
  ) {
    throw fail("URL is not permitted");
  }
  if (initial) {
    if (
      parsed.hostname !== "github.com" ||
      !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+(?:\/.*)?$/.test(parsed.pathname)
    ) {
      throw fail("URL is not a GitHub release archive");
    }
  }
  return parsed;
}

function validateOptions({ url, sha256, outputPath, maxBytes, timeoutMs }) {
  const parsedUrl = validateUrl(url, true);
  if (typeof sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw fail("invalid SHA-256");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw fail("invalid output path");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARCHIVE_BYTES) {
    throw fail("invalid size limit");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw fail("invalid timeout");
  }
  return { parsedUrl, expectedHash: sha256.toLowerCase() };
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
    return undefined;
  } catch {
    return fail("could not cancel response body");
  }
}

async function rejectResponse(response, primary) {
  const cancellation = await cancelBody(response);
  if (cancellation) {
    const combined = new AggregateError(
      [primary, cancellation],
      `${primary.message}; response cancellation failed`,
      { cause: primary },
    );
    combined[BODY_HANDLED] = true;
    throw combined;
  }
  primary[BODY_HANDLED] = true;
  throw primary;
}

async function fetchFinal(fetchImpl, initialUrl, signal) {
  let current = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current.href, {
        redirect: "manual",
        signal,
        credentials: "omit",
        headers: { "accept-encoding": "identity" },
      });
    } catch {
      throw fail(signal.aborted ? "timed out" : "request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const cancellation = await cancelBody(response);
      if (cancellation) throw cancellation;
      if (redirects >= MAX_REDIRECTS) throw fail("too many redirects");
      if (!location) throw fail("redirect has no location");
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw fail("redirect URL is invalid");
      }
      current = validateUrl(next.href, false);
      continue;
    }
    return response;
  }
}

async function validateResponse(response, maxBytes) {
  if (response.status !== 200) {
    await rejectResponse(response, fail("server returned an unexpected status"));
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    await rejectResponse(response, fail("encoded responses are not permitted"));
  }
  const length = response.headers.get("content-length");
  if (length !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(length)) {
      await rejectResponse(response, fail("invalid content length"));
    }
    const numericLength = Number(length);
    if (!Number.isSafeInteger(numericLength) || numericLength > maxBytes) {
      await rejectResponse(response, fail("archive exceeds the size limit"));
    }
    return numericLength;
  }
  return undefined;
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) throw fail("could not write archive");
    offset += bytesWritten;
  }
}

async function streamArchive(response, handle, maxBytes, signal) {
  const hash = createHash("sha256");
  let size = 0;
  if (!response.body) return { sha256: hash.digest("hex"), size };
  try {
    for await (const value of response.body) {
      if (signal.aborted) throw fail("timed out");
      const chunk = Buffer.from(value);
      if (size + chunk.length > maxBytes) throw fail("archive exceeds the size limit");
      await writeAll(handle, chunk);
      hash.update(chunk);
      size += chunk.length;
    }
  } catch (error) {
    const primary =
      error instanceof Error && error.message.startsWith("archive download:")
        ? error
        : fail(signal.aborted ? "timed out" : "response stream failed");
    await rejectResponse(response, primary);
  }
  if (signal.aborted) throw fail("timed out");
  return { sha256: hash.digest("hex"), size };
}

async function removePartial(outputPath, primary) {
  try {
    await unlink(outputPath);
  } catch (cleanup) {
    throw new AggregateError(
      [primary, cleanup],
      `${primary.message}; archive partial cleanup failed`,
      {
        cause: primary,
      },
    );
  }
  throw primary;
}

export async function downloadVerifiedArchive(
  { url, sha256, outputPath, maxBytes = MAX_ARCHIVE_BYTES, timeoutMs = 120_000 },
  { fetchImpl = globalThis.fetch } = {},
) {
  const { parsedUrl, expectedHash } = validateOptions({
    url,
    sha256,
    outputPath,
    maxBytes,
    timeoutMs,
  });
  if (typeof fetchImpl !== "function") throw fail("fetch implementation is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  let created = false;
  let response;
  try {
    response = await fetchFinal(fetchImpl, parsedUrl, controller.signal);
    const declaredSize = await validateResponse(response, maxBytes);
    handle = await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    created = true;
    const result = await streamArchive(response, handle, maxBytes, controller.signal);
    if (declaredSize !== undefined && result.size !== declaredSize) {
      throw fail("content length does not match response body");
    }
    if (result.sha256 !== expectedHash) throw fail("SHA-256 mismatch");
    if (controller.signal.aborted) throw fail("timed out");
    await handle.sync();
    if (controller.signal.aborted) throw fail("timed out");
    await handle.close();
    handle = undefined;
    if (controller.signal.aborted) throw fail("timed out");
    return result;
  } catch (error) {
    let primary = error instanceof Error ? error : fail("unknown failure");
    const cancellation = primary[BODY_HANDLED] ? undefined : await cancelBody(response);
    if (cancellation) {
      primary = new AggregateError(
        [primary, cancellation],
        `${primary.message}; response cancellation failed`,
        { cause: primary },
      );
    }
    try {
      await handle?.close();
    } catch (closeError) {
      primary = new AggregateError(
        [primary, closeError],
        `${primary.message}; archive close failed`,
        {
          cause: primary,
        },
      );
    }
    if (created) return removePartial(outputPath, primary);
    throw primary;
  } finally {
    clearTimeout(timer);
  }
}
