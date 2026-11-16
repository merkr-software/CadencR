import { app } from "electron";
import type { ChangelogImageBytes } from "../../src/shared/changelog-image";
import { declaredTooLarge, readBounded } from "./bounded-body";
import { GH_OWNER, GH_REPO } from "./release-repo";

/**
 * Images embedded in release notes. The renderer can't load them itself (see
 * `src/components/ChangelogImage.tsx`), so the main process fetches the bytes.
 * The release body comes from the network, so this only ever reaches files
 * committed to Cadencr's own public repository — never an arbitrary host.
 */

const RAW_HOST = "raw.githubusercontent.com";
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

/**
 * Map an image source from the release notes to the raw file URL it names, or
 * `null` when it doesn't point inside Cadencr's repository. Accepts the raw URL
 * itself and the `github.com/<owner>/<repo>/{blob,raw}/<ref>/<path>` page forms
 * GitHub's UI hands out (which redirect to the same raw file).
 */
export function resolveChangelogImageUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;

  // `URL` has already collapsed any `..` segments, so the prefix checks below
  // can't be escaped through a traversal.
  const [owner, repo, ...rest] = url.pathname.split("/").filter(Boolean);
  if (owner?.toLowerCase() !== GH_OWNER || repo?.toLowerCase() !== GH_REPO) return null;

  let refAndPath: string[];
  if (url.hostname === RAW_HOST) {
    refAndPath = rest;
  } else if (url.hostname === "github.com" && (rest[0] === "blob" || rest[0] === "raw")) {
    refAndPath = rest.slice(1);
  } else {
    return null;
  }
  if (refAndPath.length < 2) return null;
  return `https://${RAW_HOST}/${GH_OWNER}/${GH_REPO}/${refAndPath.join("/")}`;
}

/**
 * Fetch an image referenced by the release notes. Throws with a message fit
 * for the user when the source is outside the repository, the file is missing,
 * or the response isn't an image.
 */
export async function fetchChangelogImage(src: string): Promise<ChangelogImageBytes> {
  const url = resolveChangelogImageUrl(src);
  if (!url) {
    throw new Error(`Only images committed to the ${GH_OWNER}/${GH_REPO} repository can be shown.`);
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    // The raw host serves files directly; a redirect would lead off the
    // allowlisted origin.
    redirect: "error",
    headers: { "User-Agent": `Cadencr/${app.getVersion()}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GitHub returned HTTP ${res.status} for this image.`);
  }

  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    await res.body?.cancel();
    throw new Error(`Unsupported image type: ${mimeType || "unknown"}.`);
  }
  if (declaredTooLarge(res.headers.get("content-length"), MAX_IMAGE_BYTES)) {
    await res.body?.cancel();
    throw new Error("Image is too large to display.");
  }
  const data = await readBounded(res.body, MAX_IMAGE_BYTES);
  if (!data) throw new Error("Image is too large to display.");
  return { data, mimeType };
}
