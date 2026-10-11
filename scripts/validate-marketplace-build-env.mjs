import { createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TRUST_ENV = [
  "CADENCR_MANAGED_PROVIDER_KEY_ID",
  "CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64",
  "CADENCR_MANAGED_PROVIDER_INDEX_URL",
  "CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL",
];
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

export function validatedBuildEnv(env) {
  const output = { ...env };
  for (const name of [...TRUST_ENV, THEME_ENV, THEME_POLICY_ENV]) {
    if (!env[name]) delete output[name];
    else if (env[name].trim() !== env[name])
      throw new Error(`${name} must not contain surrounding whitespace`);
  }
  const configured = TRUST_ENV.filter((name) => output[name] !== undefined);
  if (configured.length && configured.length !== TRUST_ENV.length) {
    throw new Error(
      "provider key id, public key, index URL and blocklist URL must be configured together",
    );
  }
  if (!configured.length) {
    if (output[THEME_ENV] || output[THEME_POLICY_ENV])
      throw new Error("theme discovery requires the complete shared provider trust configuration");
    return output;
  }
  const keyId = output[TRUST_ENV[0]];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId))
    throw new Error("pinned key id is invalid");
  const encoded = output[TRUST_ENV[1]];
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("pinned Ed25519 public key must be canonical base64 for 32 bytes");
  createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    format: "der",
    type: "spki",
  });
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
