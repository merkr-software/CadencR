import { MAX_JSON_BYTES, REQUEST_TIMEOUT_MS } from "./validation.mjs";

const API_VERSION = "2026-03-10";
const INTERNAL = Symbol("GitHub transport error");

function internalError(message) {
  const error = new Error(message);
  error[INTERNAL] = true;
  return error;
}

function httpError(status) {
  const error = internalError(`GitHub API request failed with status ${status}`);
  error.status = status;
  return error;
}

export async function readJson(response) {
  if (!response.body) throw internalError("GitHub API returned malformed JSON");
  const chunks = [];
  let size = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_JSON_BYTES) throw internalError("GitHub API response exceeds 2 MiB");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.[INTERNAL]) throw error;
    throw internalError("GitHub API response could not be read");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw internalError("GitHub API returned malformed JSON");
  }
}

export function createRequester({ token, fetchImpl }) {
  return async function request(path, { method = "GET", body, accept } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        redirect: "manual",
        signal: controller.signal,
        credentials: "omit",
        headers: {
          accept: accept ?? "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": API_VERSION,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      clearTimeout(timer);
      throw internalError(
        controller.signal.aborted ? "GitHub API request timed out" : "GitHub API request failed",
      );
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw httpError(response.status);
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw httpError(response.status);
      }
      const result = await readJson(response);
      if (controller.signal.aborted) throw internalError("GitHub API request timed out");
      return result;
    } catch (error) {
      if (error?.[INTERNAL]) throw error;
      throw internalError(
        controller.signal.aborted ? "GitHub API request timed out" : "GitHub API response failed",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

export { API_VERSION, INTERNAL, internalError };
