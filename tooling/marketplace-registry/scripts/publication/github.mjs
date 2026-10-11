import { downloadVerifiedArchive } from "./download.mjs";
import { isExactCommit } from "./commit.mjs";
import { createRequester } from "./github/request.mjs";
import { createDiscoveryMethods } from "./github/discovery.mjs";
import { createPromotionMethods } from "./github/promotion.mjs";
import { createTagMethods } from "./github/tags.mjs";
import { createUploader } from "./github/upload.mjs";
import {
  validateAsset,
  validateConfiguration,
  validateId,
  validateText,
} from "./github/validation.mjs";

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`GitHub ${label} response is malformed`);
  return value;
}

function requireRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub release response is malformed");
  }
  validateId(value.id, "release id");
  if (typeof value.tag_name !== "string") throw new Error("GitHub release response is malformed");
  return value;
}

export function createGitHubClient({ repository, token, fetchImpl = globalThis.fetch }) {
  validateConfiguration(repository, token, fetchImpl);
  const request = createRequester({ token, fetchImpl });
  const uploadAsset = createUploader({ repository, token, fetchImpl });
  const promotionMethods = createPromotionMethods({ repository, request, requireRelease });

  async function findRelease(tag) {
    validateText(tag, "release tag");
    const matches = [];
    for (let page = 1; page <= 10; page += 1) {
      const releases = requireArray(
        await request(`/repos/${repository}/releases?per_page=100&page=${page}`),
        "release list",
      );
      for (const release of releases) {
        requireRelease(release);
        if (release.tag_name === tag) matches.push(release);
      }
      if (releases.length < 100) break;
      if (page === 10) throw new Error("GitHub release pagination limit exceeded");
    }
    if (matches.length > 1) throw new Error("GitHub release tag is duplicated");
    return matches[0] ?? null;
  }

  async function createDraft({ tag, commit, body }) {
    validateText(tag, "release tag");
    if (!isExactCommit(commit)) {
      throw new Error("GitHub release commit is invalid");
    }
    if (typeof body !== "string") throw new Error("GitHub release body is invalid");
    return requireRelease(
      await request(`/repos/${repository}/releases`, {
        method: "POST",
        body: {
          tag_name: tag,
          target_commitish: commit,
          body,
          name: tag,
          draft: true,
          prerelease: false,
          make_latest: "false",
        },
      }),
    );
  }

  async function listAssets(releaseId) {
    validateId(releaseId, "release id");
    const result = [];
    for (let page = 1; page <= 10; page += 1) {
      const assets = requireArray(
        await request(
          `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        ),
        "asset list",
      );
      result.push(...assets.map(validateAsset));
      if (assets.length < 100) return result;
    }
    throw new Error("GitHub asset pagination limit exceeded");
  }

  async function verifyAsset({ asset, expectedUrl, sha256, size, outputPath }) {
    validateAsset(asset);
    if (asset.browser_download_url !== expectedUrl)
      throw new Error("GitHub asset URL does not match");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("GitHub asset size is invalid");
    if (asset.size !== size) throw new Error("GitHub asset size does not match");
    let first = true;
    const bridge = (url, options) => {
      if (!first) return fetchImpl(url, options);
      first = false;
      return fetchImpl(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, {
        ...options,
        method: "GET",
        headers: {
          ...options.headers,
          accept: "application/octet-stream",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2026-03-10",
        },
      });
    };
    const result = await downloadVerifiedArchive(
      { url: expectedUrl, sha256, outputPath, maxBytes: size },
      { fetchImpl: bridge },
    );
    if (result.size !== size) throw new Error("GitHub asset size does not match");
    return result;
  }

  return {
    findRelease,
    createDraft,
    listAssets,
    uploadAsset,
    verifyAsset,
    ...createDiscoveryMethods({ repository, request }),
    ...promotionMethods,
    ...createTagMethods({ repository, request, getTagCommit: promotionMethods.getTagCommit }),
  };
}
