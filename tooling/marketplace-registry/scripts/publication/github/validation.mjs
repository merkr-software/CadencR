import { validPublicationRepository } from "../plan.mjs";
import { MAX_ARCHIVE_BYTES } from "../download.mjs";

export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_BYTES = MAX_ARCHIVE_BYTES;
export const REQUEST_TIMEOUT_MS = 120_000;

export function validateConfiguration(repository, token, fetchImpl) {
  if (!validPublicationRepository(repository)) {
    throw new Error("GitHub repository is invalid");
  }
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/.test(token)) {
    throw new Error("GitHub token is invalid");
  }
  if (typeof fetchImpl !== "function")
    throw new Error("GitHub fetch implementation is unavailable");
}

export function validateId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitHub ${label} is invalid`);
  return value;
}

export function validateText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`GitHub ${label} is invalid`);
  }
  return value;
}

export function validateAsset(asset) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new Error("GitHub asset is malformed");
  }
  validateId(asset.id, "asset id");
  if (
    typeof asset.name !== "string" ||
    asset.name.length === 0 ||
    typeof asset.state !== "string" ||
    asset.state.length === 0 ||
    typeof asset.browser_download_url !== "string" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0 ||
    asset.size > MAX_ASSET_BYTES
  ) {
    throw new Error("GitHub asset is malformed");
  }
  return asset;
}
