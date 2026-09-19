import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { API_VERSION, INTERNAL, internalError, readJson } from "./request.mjs";
import {
  MAX_ASSET_BYTES,
  REQUEST_TIMEOUT_MS,
  validateAsset,
  validateId,
  validateText,
} from "./validation.mjs";

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function* fileBytes(handle, expectedSize) {
  let total = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    total += chunk.length;
    if (total > expectedSize) throw new Error("GitHub upload file size changed");
    yield chunk;
  }
  if (total !== expectedSize) throw new Error("GitHub upload file size changed");
}

export function createUploader({ repository, token, fetchImpl }) {
  return async function uploadAsset({ releaseId, name, file, size }) {
    validateId(releaseId, "release id");
    validateText(name, "asset name");
    if (name.includes("/") || name.includes("\\")) throw new Error("GitHub asset name is invalid");
    if (typeof file !== "string" || file.length === 0)
      throw new Error("GitHub upload file is invalid");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ASSET_BYTES) {
      throw new Error("GitHub upload size is invalid");
    }
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== size) {
      throw new Error("GitHub upload file is invalid or has the wrong size");
    }
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let result;
    let primary;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened) || opened.size !== size) {
        throw new Error("GitHub upload file changed");
      }
      const url = new URL(
        `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets`,
      );
      url.searchParams.set("name", name);
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          credentials: "omit",
          duplex: "half",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-length": String(size),
            "content-type": "application/octet-stream",
            "x-github-api-version": API_VERSION,
          },
          body: fileBytes(handle, size),
        });
      } catch {
        throw internalError(
          controller.signal.aborted ? "GitHub upload timed out" : "GitHub upload failed",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        const error = internalError(`GitHub upload failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      result = validateAsset(await readJson(response));
      if (controller.signal.aborted) throw internalError("GitHub upload timed out");
    } catch (error) {
      primary = error?.[INTERNAL]
        ? error
        : internalError(
            controller.signal.aborted ? "GitHub upload timed out" : "GitHub upload failed",
          );
    } finally {
      clearTimeout(timer);
    }
    try {
      await handle.close();
    } catch {
      const closeError = internalError("GitHub upload file close failed");
      if (primary) {
        throw new AggregateError(
          [primary, closeError],
          `${primary.message}; GitHub upload file close failed`,
          { cause: primary },
        );
      }
      throw closeError;
    }
    if (primary) throw primary;
    return result;
  };
}
