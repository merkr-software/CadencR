import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import packageSchema from "../schemas/managed-provider-package-v1.schema.json" with { type: "json" };
import indexSchema from "../schemas/signed-managed-provider-index-v1.schema.json" with { type: "json" };

const TARGETS = new Set([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
]);
const RESERVED_ARGS = new Set(["version", "models", "run", "acp-v1", "--"]);
const CREDENTIAL_NAMES = [
  "accesstoken",
  "apikey",
  "auth",
  "authentication",
  "authmethod",
  "authmethods",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
];
const HOST_KEYS = new Set(Object.keys(packageSchema.properties.host.properties));
const COMPATIBILITY_KEYS = new Set(
  Object.keys(packageSchema.properties.host.properties.compatibility.properties),
);
const ASSET_KEYS = new Set(Object.keys(packageSchema.properties.host.properties.assets.properties));
const DISTRIBUTION_KEYS = new Set(Object.keys(packageSchema.$defs.distribution.properties));
const BINARY_KEYS = new Set(Object.keys(packageSchema.$defs.binaryTarget.properties));
const PACKAGE_DISTRIBUTION_KEYS = new Set(
  Object.keys(packageSchema.$defs.packageDistribution.properties),
);
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const MAX_INDEX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function loadPackages(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      return { file, value: JSON.parse(await readFile(file, "utf8")) };
    }),
  );
}

export function validatePackage(value, label = "package") {
  const errors = [];
  if (!isObject(value)) return [`${label} must be an object`];
  rejectUnknown(value, new Set(Object.keys(packageSchema.properties)), label, errors);
  const { agent, host } = value;
  if (!isObject(agent)) errors.push(`${label}.agent must be an object`);
  if (!isObject(host)) errors.push(`${label}.host must be an object`);
  if (isObject(agent)) validateAgent(agent, `${label}.agent`, errors);
  if (isObject(host)) validateHost(host, `${label}.host`, errors);
  return errors;
}

export function validateIndex(index, { now = new Date(), allowExpired = false } = {}) {
  const errors = [];
  if (!isObject(index)) return ["index must be an object"];
  rejectUnknown(
    index,
    new Set(Object.keys(indexSchema.properties.signed.properties)),
    "index",
    errors,
  );
  if (index.schema_version !== 1) errors.push("index.schema_version must equal 1");
  validatePublicationWindow(index, now, errors, { allowExpired });
  if (!Array.isArray(index.packages) || index.packages.length === 0) {
    errors.push("index.packages must be a non-empty array");
    return errors;
  }
  index.packages.forEach((entry, position) =>
    errors.push(...validatePackage(entry, `index.packages[${position}]`)),
  );
  if (errors.length > 0) return errors;
  const identities = index.packages.map(
    (entry) => `${entry?.agent?.id ?? ""}@${entry?.agent?.version ?? ""}`,
  );
  const sorted = [...index.packages]
    .sort(comparePackages)
    .map((entry) => `${entry.agent.id}@${entry.agent.version}`);
  if (new Set(identities).size !== identities.length)
    errors.push("index.packages contains duplicate id@version entries");
  if (identities.some((identity, position) => identity !== sorted[position])) {
    errors.push("index.packages must be sorted by provider id and semantic version");
  }
  return errors;
}

export function validateSignedIndex(envelope, options) {
  const errors = [];
  if (!isObject(envelope)) return ["signed index must be an object"];
  rejectUnknown(envelope, new Set(Object.keys(indexSchema.properties)), "envelope", errors);
  errors.push(...validateIndex(envelope.signed, options));
  const signature = envelope.signature;
  if (!isObject(signature)) return [...errors, "envelope.signature must be an object"];
  rejectUnknown(
    signature,
    new Set(Object.keys(indexSchema.properties.signature.properties)),
    "envelope.signature",
    errors,
  );
  if (signature.algorithm !== "ed25519")
    errors.push("envelope.signature.algorithm must equal ed25519");
  if (!validIdentifier(signature.key_id)) errors.push("envelope.signature.key_id is invalid");
  if (
    typeof signature.value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(signature.value)
  ) {
    errors.push("envelope.signature.value must be standard padded base64 encoding 64 bytes");
  }
  return errors;
}

export function comparePackages(left, right) {
  const byId = left.agent.id < right.agent.id ? -1 : left.agent.id > right.agent.id ? 1 : 0;
  if (byId !== 0) return byId;
  return compareSemver(left.agent.version, right.agent.version);
}

function validatePublicationWindow(index, now, errors, { allowExpired }) {
  const generated = parseTimestamp(index.generated_at);
  const expires = parseTimestamp(index.expires_at);
  if (generated === null) errors.push("index.generated_at must be an RFC 3339 timestamp");
  if (expires === null) errors.push("index.expires_at must be an RFC 3339 timestamp");
  if (generated === null || expires === null) return;
  if (expires <= generated) errors.push("index.expires_at must follow generated_at");
  if (generated > now.getTime() + MAX_FUTURE_SKEW_MS)
    errors.push("index.generated_at is too far in the future");
  if (expires - generated > MAX_INDEX_AGE_MS) errors.push("index validity window exceeds 14 days");
  if (!allowExpired && now.getTime() >= expires) errors.push("index has expired");
}

function validateAgent(agent, label, errors) {
  if (typeof agent.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(agent.id))
    errors.push(`${label}.id is invalid`);
  for (const key of ["name", "description"])
    if (typeof agent[key] !== "string" || agent[key].length === 0)
      errors.push(`${label}.${key} must not be empty`);
  if (typeof agent.version !== "string" || !parseSemver(agent.version))
    errors.push(`${label}.version must be one exact semantic version`);
  for (const key of ["repository", "website"])
    if (agent[key] !== undefined && !validUrl(agent[key]))
      errors.push(`${label}.${key} must be a valid URI`);
  for (const key of ["license", "icon"])
    if (agent[key] !== undefined && typeof agent[key] !== "string")
      errors.push(`${label}.${key} must be a string`);
  if (
    agent.authors !== undefined &&
    (!Array.isArray(agent.authors) || agent.authors.some((author) => typeof author !== "string"))
  )
    errors.push(`${label}.authors must be an array of strings`);
  if (!isObject(agent.distribution)) errors.push(`${label}.distribution is required`);
  else validateDistribution(agent.distribution, `${label}.distribution`, errors);
  findCredentialKey(agent, label, errors, new Set(["distribution"]));
}

function validateDistribution(distribution, label, errors) {
  rejectUnknown(distribution, DISTRIBUTION_KEYS, label, errors);

  if (!isObject(distribution.binary) || Object.keys(distribution.binary).length === 0)
    errors.push(`${label}.binary must declare at least one target for managed packages`);
  if (isObject(distribution.binary))
    for (const [platform, target] of Object.entries(distribution.binary))
      validateBinary(platform, target, `${label}.binary.${platform}`, errors);
  for (const kind of ["npx", "uvx"])
    if (distribution[kind] !== undefined)
      validatePackageDistribution(distribution[kind], `${label}.${kind}`, errors);
}

function validateBinary(platform, target, label, errors) {
  if (!TARGETS.has(platform)) errors.push(`${label} uses an unsupported platform key`);
  if (!isObject(target)) return errors.push(`${label} must be an object`);
  rejectUnknown(target, BINARY_KEYS, label, errors);
  if (!validHttpsUrl(target.archive)) errors.push(`${label}.archive must be an absolute HTTPS URL`);
  validateRelativePath(target.cmd, `${label}.cmd`, errors);
  if (typeof target.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(target.sha256))
    errors.push(`${label}.sha256 must be 64 hex characters`);
  if (
    target.args !== undefined &&
    (!Array.isArray(target.args) || target.args.some((arg) => typeof arg !== "string"))
  ) {
    errors.push(`${label}.args must be an array of strings`);
    return;
  }
  for (const arg of target.args ?? []) {
    if (
      RESERVED_ARGS.has(arg) ||
      ["--protocol", "--cwd", "--format"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    )
      errors.push(`${label}.args contains reserved host argument ${JSON.stringify(arg)}`);
    if (credentialName(arg.replace(/^-+/, "").split("=", 1)[0]))
      errors.push(`${label}.args contains credential-bearing argument ${JSON.stringify(arg)}`);
  }
  validateEnv(target.env, `${label}.env`, errors);
}

function validatePackageDistribution(value, label, errors) {
  if (!isObject(value)) return errors.push(`${label} must be an object`);
  rejectUnknown(value, PACKAGE_DISTRIBUTION_KEYS, label, errors);
  if (typeof value.package !== "string" || value.package.length === 0)
    errors.push(`${label}.package must not be empty`);
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))
  ) {
    errors.push(`${label}.args must be an array of strings`);
    return;
  }
  validateEnv(value.env, `${label}.env`, errors);
  for (const arg of value.args ?? [])
    if (credentialName(String(arg).replace(/^-+/, "").split("=", 1)[0]))
      errors.push(`${label}.args contains credential-bearing data`);
}

function validateHost(host, label, errors) {
  rejectUnknown(host, HOST_KEYS, label, errors);
  if (!validIdentifier(host.publisher)) errors.push(`${label}.publisher is invalid`);
  if (!isObject(host.compatibility)) errors.push(`${label}.compatibility must be an object`);
  else {
    rejectUnknown(host.compatibility, COMPATIBILITY_KEYS, `${label}.compatibility`, errors);
    const min = parseSemver(host.compatibility.min_app_version);
    const max =
      host.compatibility.max_app_version === undefined
        ? null
        : parseSemver(host.compatibility.max_app_version);
    if (!min) errors.push(`${label}.compatibility.min_app_version must be semantic version`);
    if (host.compatibility.max_app_version !== undefined && !max)
      errors.push(`${label}.compatibility.max_app_version must be semantic version`);
    if (
      min &&
      max &&
      compareSemver(host.compatibility.max_app_version, host.compatibility.min_app_version) < 0
    )
      errors.push(`${label}.compatibility maximum precedes minimum`);
  }
  if (!isObject(host.assets)) errors.push(`${label}.assets must be an object`);
  else {
    rejectUnknown(host.assets, ASSET_KEYS, `${label}.assets`, errors);
    for (const key of ["icon", "readme", "license"])
      if (key === "icon" || host.assets[key] !== undefined)
        validateRelativePath(host.assets[key], `${label}.assets.${key}`, errors);
    if (
      typeof host.assets.icon === "string" &&
      !IMAGE_EXTENSIONS.has(path.extname(host.assets.icon).toLowerCase())
    )
      errors.push(`${label}.assets.icon has an unsupported image extension`);
  }
}

function validateEnv(env, label, errors) {
  if (env === undefined) return;
  if (!isObject(env) || Object.values(env).some((value) => typeof value !== "string"))
    errors.push(`${label} must map strings to strings`);
  if (isObject(env))
    for (const key of Object.keys(env))
      if (credentialName(key)) errors.push(`${label}.${key} may carry credentials`);
}

function validateRelativePath(value, label, errors) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    errors.push(`${label} must be a bounded relative package path`);
}

function findCredentialKey(value, label, errors, skip = new Set()) {
  if (Array.isArray(value))
    return value.forEach((item, index) => findCredentialKey(item, `${label}[${index}]`, errors));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (skip.has(key)) continue;
    if (credentialName(key))
      errors.push(`${label}.${key} may carry credentials or authentication data`);
    findCredentialKey(child, `${label}.${key}`, errors);
  }
}

function rejectUnknown(value, allowed, label, errors) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
}
function credentialName(value) {
  const normalized = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    CREDENTIAL_NAMES.includes(normalized) ||
    ["apikey", "credential", "password", "privatekey", "secret", "token"].some((suffix) =>
      normalized.endsWith(suffix),
    )
  );
}
export function validIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function validUrl(value) {
  try {
    return typeof value === "string" && Boolean(new URL(value));
  } catch {
    return false;
  }
}
function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return null;
  const core = match.slice(1, 4).map(BigInt);
  if (core.some((identifier) => identifier > 18_446_744_073_709_551_615n)) return null;
  return { core, pre: match[4]?.split(".") ?? null };
}
function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftIdentifier = a.pre[index];
    const rightIdentifier = b.pre[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length - rightIdentifier.length;
      }
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}
function parseTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
    return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}
