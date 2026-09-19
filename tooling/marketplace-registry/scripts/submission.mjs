import { validatePackage } from "./lib.mjs";

const SUBMISSION_KEYS = new Set(["schema_version", "package", "source", "changelog"]);
const SOURCE_KEYS = new Set(["repository", "commit", "tag"]);
// Normalized with the same ASCII-alphanumeric key used by provider_identifier_key
// in the runtime registry. These are the distinct keys produced by the built-in
// canonical ids and aliases in registry/builtin_metadata.rs.
const RESERVED_PROVIDER_KEYS = new Set([
  "anthropic",
  "claude",
  "claudecode",
  "codex",
  "codexcli",
  "cursor",
  "open",
  "openai",
  "opencode",
]);
const MAX_CHANGELOG_LENGTH = 16_384;

export function validateSubmission(value) {
  const errors = [];
  if (!isObject(value)) return ["submission must be an object"];
  rejectUnknown(value, SUBMISSION_KEYS, "submission", errors);

  if (value.schema_version !== 1) errors.push("submission.schema_version must equal 1");
  errors.push(...validatePackage(value.package, "submission.package"));
  validateMarketplacePackage(value.package, errors);
  validateSource(value.source, value.package, errors);
  validateChangelog(value.changelog, errors);

  if (
    isObject(value.package?.agent) &&
    isObject(value.source) &&
    typeof value.package.agent.repository === "string" &&
    typeof value.source.repository === "string" &&
    value.package.agent.repository !== value.source.repository
  ) {
    errors.push("submission.package.agent.repository must equal submission.source.repository");
  }

  return errors;
}

function validateMarketplacePackage(value, errors) {
  if (!isObject(value) || !isObject(value.agent)) return;
  if (typeof value.agent.repository !== "string") {
    errors.push("submission.package.agent.repository is required");
  }
  if (typeof value.agent.license !== "string" || value.agent.license.trim().length === 0) {
    errors.push("submission.package.agent.license must be a non-empty declared license");
  }
  if (
    typeof value.agent.id === "string" &&
    RESERVED_PROVIDER_KEYS.has(providerIdentifierKey(value.agent.id))
  ) {
    errors.push("submission.package.agent.id is reserved by a built-in provider");
  }
  const distribution = value.agent.distribution;
  const assets = value.host?.assets;
  if (isObject(assets)) {
    for (const key of ["readme", "license"])
      if (typeof assets[key] !== "string" || assets[key].trim().length === 0) {
        errors.push(`submission.package.host.assets.${key} is required`);
      }
  }
  if (!isObject(distribution)) return;
  for (const runner of ["npx", "uvx"])
    if (distribution[runner] !== undefined) {
      errors.push(
        `submission.package.agent.distribution.${runner} is not supported by marketplace v1`,
      );
    }
}

function validateSource(source, packageValue, errors) {
  if (!isObject(source)) {
    errors.push("submission.source must be an object");
    return;
  }
  rejectUnknown(source, SOURCE_KEYS, "submission.source", errors);
  if (!canonicalGitHubRepository(source.repository)) {
    errors.push(
      "submission.source.repository must be a canonical HTTPS GitHub owner/repository URL",
    );
  }
  if (typeof source.commit !== "string" || !/^[0-9a-f]{40}$/.test(source.commit)) {
    errors.push("submission.source.commit must be a 40-character lowercase hexadecimal commit");
  }
  if (!validGitTag(source.tag))
    errors.push("submission.source.tag must be a safe non-empty git tag");

  if (!canonicalGitHubRepository(source.repository) || !validGitTag(source.tag)) return;
  const binary = packageValue?.agent?.distribution?.binary;
  if (!isObject(binary)) return;
  for (const [platform, target] of Object.entries(binary)) {
    if (isObject(target)) {
      validateReleaseArchive(
        target.archive,
        source,
        `submission.package.agent.distribution.binary.${platform}`,
        errors,
      );
    }
  }
}

function validateChangelog(value, errors) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_CHANGELOG_LENGTH ||
    value.includes("\0")
  ) {
    errors.push(
      `submission.changelog must be a non-empty string of at most ${MAX_CHANGELOG_LENGTH} characters`,
    );
  }
}

function validateReleaseArchive(value, source, label, errors) {
  if (typeof value !== "string") return;
  const expectedPrefix = `${source.repository}/releases/download/${encodeURIComponent(source.tag)}/`;
  if (!value.startsWith(expectedPrefix)) {
    errors.push(
      `${label}.archive must be an HTTPS GitHub Release asset for submission.source repository and tag`,
    );
    return;
  }
  const asset = value.slice(expectedPrefix.length);
  if (!asset || asset.includes("/") || hasTraversal(asset)) {
    errors.push(`${label}.archive must name one safe GitHub Release asset`);
    return;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value ||
      hasControlCharacters(value)
    )
      throw new Error();
  } catch {
    errors.push(`${label}.archive must be a canonical HTTPS GitHub Release URL`);
  }
}

function canonicalGitHubRepository(value) {
  if (typeof value !== "string") return false;
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!.*\.git$)[A-Za-z0-9._-]+$/.test(
      value,
    )
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function validGitTag(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(value) &&
    value
      .split("/")
      .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

function hasControlCharacters(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) return true;
  try {
    return /[\x00-\x1f\x7f]/.test(decodeURIComponent(value));
  } catch {
    return true;
  }
}

function hasTraversal(value) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  } catch {
    return true;
  }
}

function rejectUnknown(value, allowed, label, errors) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerIdentifierKey(value) {
  return [...value]
    .filter((character) => /^[A-Za-z0-9]$/.test(character))
    .join("")
    .toLowerCase();
}
