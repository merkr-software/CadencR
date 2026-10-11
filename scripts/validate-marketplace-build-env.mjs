import { createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TRUST_ENV = [
  "CADENCR_MANAGED_PROVIDER_KEY_ID",
  "CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64",
  "CADENCR_MANAGED_PROVIDER_INDEX_URL",
  "CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL",
];
export const GENERATION_ENV = [
  "CADENCR_REGISTRY_TRUST_MANIFEST_JSON",
  "CADENCR_REGISTRY_ROOT_KEY_ID",
  "CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64",
];
export const MIN_GENERATION_ENV = "CADENCR_REGISTRY_TRUST_MIN_GENERATION";
export const THEME_ENV = "CADENCR_MANAGED_THEME_INDEX_URL";
export const THEME_POLICY_ENV = "CADENCR_MANAGED_THEME_BLOCKLIST_URL";

function httpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port
  ) {
    throw new Error(`${name} must be credential-free HTTPS without port, query or fragment`);
  }
  return url;
}

function validateKey(keyId, encoded) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId))
    throw new Error("pinned key id is invalid");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("pinned Ed25519 public key must be canonical base64 for 32 bytes");
  createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    format: "der",
    type: "spki",
  });
}

function validateGeneration(output) {
  const minimum = output[MIN_GENERATION_ENV] ?? "1";
  if (!/^[1-9][0-9]*$/.test(minimum) || BigInt(minimum) > 18446744073709551615n)
    throw new Error("minimum trust generation must be a positive u64");
  const manifest = output[GENERATION_ENV[0]];
  if (Buffer.byteLength(manifest) > 64 * 1024)
    throw new Error("registry trust manifest exceeds the byte limit");
  const envelope = JSON.parse(manifest);
  if (
    envelope?.signed?.kind !== "registry-trust" ||
    envelope?.signed?.schema_version !== 1 ||
    !Number.isSafeInteger(envelope?.signed?.generation) ||
    BigInt(envelope.signed.generation) < BigInt(minimum)
  )
    throw new Error("registry trust manifest shape or minimum generation is invalid");
  // Rust verifies the independent root signature and full closed schema before admission.
}

export function validatedBuildEnv(env) {
  const output = { ...env };
  for (const name of [
    ...TRUST_ENV,
    ...GENERATION_ENV,
    MIN_GENERATION_ENV,
    THEME_ENV,
    THEME_POLICY_ENV,
  ]) {
    if (!env[name]) delete output[name];
    else if (env[name].trim() !== env[name])
      throw new Error(`${name} must not contain surrounding whitespace`);
  }
  const generation = GENERATION_ENV.filter((name) => output[name] !== undefined);
  if (generation.length && generation.length !== GENERATION_ENV.length)
    throw new Error("registry trust manifest and offline root pins must be configured together");
  if (!generation.length && output[MIN_GENERATION_ENV])
    throw new Error("minimum trust generation requires offline root configuration");
  const legacy = TRUST_ENV.slice(0, 2).filter((name) => output[name] !== undefined);
  const feeds = TRUST_ENV.slice(2).filter((name) => output[name] !== undefined);
  if (generation.length && legacy.length)
    throw new Error("select root-authorized trust or legacy trust, not both");
  if (
    (!generation.length && legacy.length !== 2 && legacy.length) ||
    (feeds.length && feeds.length !== 2) ||
    ((generation.length || legacy.length) && feeds.length !== 2) ||
    (feeds.length && !generation.length && !legacy.length)
  )
    throw new Error(
      "provider key id, public key, index URL and blocklist URL must be configured together",
    );
  if (!feeds.length) {
    if (output[THEME_ENV] || output[THEME_POLICY_ENV])
      throw new Error("theme discovery requires the complete shared provider trust configuration");
    return output;
  }
  const names = generation.length ? GENERATION_ENV.slice(1) : TRUST_ENV.slice(0, 2);
  validateKey(output[names[0]], output[names[1]]);
  if (generation.length) validateGeneration(output);
  httpsUrl(output[TRUST_ENV[2]], TRUST_ENV[2]);
  httpsUrl(output[TRUST_ENV[3]], TRUST_ENV[3]);
  if (Boolean(output[THEME_ENV]) !== Boolean(output[THEME_POLICY_ENV])) {
    throw new Error("theme catalog and signed revocation policy URLs must be configured together");
  }
  if (output[THEME_ENV]) {
    const theme = httpsUrl(output[THEME_ENV], THEME_ENV);
    if (
      theme.hostname !== "raw.githubusercontent.com" ||
      !/^\/[^/]+\/[^/]+\/refs\/heads\/marketplace-v2\/managed-index\.json$/.test(theme.pathname)
    ) {
      throw new Error(
        "theme discovery must use the schema-2 marketplace-v2 branch managed-index.json feed",
      );
    }
  }
  if (output[THEME_POLICY_ENV]) {
    const policy = httpsUrl(output[THEME_POLICY_ENV], THEME_POLICY_ENV);
    if (
      policy.hostname !== "raw.githubusercontent.com" ||
      !/^\/[^/]+\/[^/]+\/refs\/heads\/marketplace-v2\/managed-theme-blocklist\.json$/.test(
        policy.pathname,
      )
    ) {
      throw new Error(
        "theme revocations must use the separate marketplace-v2 managed-theme-blocklist.json feed",
      );
    }
    const catalog = new URL(output[THEME_ENV]);
    if (
      policy.pathname.split("/").slice(0, 3).join("/") !==
      catalog.pathname.split("/").slice(0, 3).join("/")
    ) {
      throw new Error(
        "theme catalog and revocations must belong to the same reviewed registry repository",
      );
    }
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = validatedBuildEnv(process.env);
    const args = process.argv.slice(2);
    if (args.length) {
      if (args.shift() !== "--" || !args.length)
        throw new Error("usage: validate-marketplace-build-env.mjs [-- command args...]");
      const child = spawnSync(args.shift(), args, { env, stdio: "inherit" });
      if (child.error) throw child.error;
      process.exitCode = child.status ?? 1;
    } else console.log("Marketplace build configuration is valid; unset feeds remain disabled.");
  } catch (error) {
    console.error(`Marketplace build configuration rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
