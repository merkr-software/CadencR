import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sentryApi(base, token, request) {
  return async (endpoint, { method = "GET", body, headers = {} } = {}) => {
    const response = await request(new URL(endpoint, base), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Sentry source-map upload failed (HTTP ${response.status})`);
    }
    return response;
  };
}

async function existingFiles(api, endpoint) {
  const files = [];
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const response = await api(
      `${endpoint}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Invalid Sentry release file listing");
    files.push(...batch);
    const next = response.headers
      .get("link")
      ?.split(",")
      .find((part) => part.includes('rel="next"') && part.includes('results="true"'));
    if (!next) return files;
    const match = next.match(/cursor="([^"]+)"/);
    if (!match || match[1] === cursor) throw new Error("Invalid Sentry release file pagination");
    cursor = match[1];
  }
  throw new Error("Too many Sentry release file pages");
}

function identicalFile(files, name, dist, bytes) {
  const existing = files.filter((file) => file?.name === name && file?.dist === dist);
  if (!existing.length) return false;
  const checksum = createHash("sha1").update(bytes).digest("hex");
  if (existing.length !== 1 || existing[0].sha1 !== checksum) {
    throw new Error(`Conflicting Sentry release artifact: ${name}`);
  }
  return true;
}

async function rendererFiles(assetDir) {
  const entries = await readdir(assetDir, { withFileTypes: true });
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = entries
    .filter((entry) => entry.isFile() && /^[\w.-]+\.js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!names.some((name) => /^index-.+\.js$/.test(name))) {
    throw new Error("Renderer entry bundle missing");
  }
  const files = [];
  for (const name of names) {
    const bundle = await readFile(path.join(assetDir, name));
    const mapEntry = byName.get(`${name}.map`);
    if (!mapEntry) {
      if (/^(?:index|notch)-.+\.js$/.test(name)) {
        throw new Error(`Renderer entry source map missing: ${name}.map`);
      }
      // Vendored workers can be emitted without maps, even in a mapped build.
      files.push({ name, bundle, map: null });
      continue;
    }
    if (!mapEntry.isFile()) throw new Error(`Source map is not a regular file: ${name}.map`);
    const map = await readFile(path.join(assetDir, `${name}.map`));
    const parsed = JSON.parse(map.toString("utf8"));
    if (parsed.version !== 3 || typeof parsed.mappings !== "string") {
      throw new Error(`Invalid source map: ${name}.map`);
    }
    files.push({ name, bundle, map });
  }
  return files;
}

/** Upload existing build bytes only; never inject, rebuild, delete or rewrite artifacts. */
export async function uploadSentryRendererMaps({
  rendererDir = "packages/desktop/out/renderer",
  env = process.env,
  request = fetch,
} = {}) {
  if (!env.SENTRY_AUTH_TOKEN) return { skipped: true };
  for (const key of ["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_URL"]) {
    if (!env[key]) throw new Error(`${key} is required when SENTRY_AUTH_TOKEN is set`);
  }
  const base = new URL(env.SENTRY_URL);
  if (
    base.protocol !== "https:" ||
    !["sentry.io", "us.sentry.io", "de.sentry.io"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.port ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error("SENTRY_URL must be the HTTPS origin of Sentry Cloud in the project's region");
  }
  const info = JSON.parse(await readFile(path.join(rendererDir, "build-info.json"), "utf8"));
  if (
    typeof info.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.version) ||
    typeof info.buildId !== "string" ||
    !/^[\w.-]{1,128}$/.test(info.buildId)
  ) {
    throw new Error("Invalid renderer build metadata");
  }
  // Read every bundle and validate every present map before the first request.
  const files = await rendererFiles(path.join(rendererDir, "assets"));
  const release = `cadencr@${info.version}`;
  const root = `/api/0/organizations/${encodeURIComponent(env.SENTRY_ORG)}/releases/`;
  const api = sentryApi(base, env.SENTRY_AUTH_TOKEN, request);
  const created = await api(root, {
    method: "POST",
    body: JSON.stringify({ version: release, projects: [env.SENTRY_PROJECT] }),
    headers: { "Content-Type": "application/json" },
  });
  if (!created.ok) throw new Error("Sentry release creation failed (HTTP 409)");
  await created.arrayBuffer();
  const endpoint = `${root}${encodeURIComponent(release)}/files/`;
  const existing = await existingFiles(api, endpoint);
  for (const file of files) {
    const artifacts = file.map
      ? [
          [".map", file.map],
          ["", file.bundle],
        ]
      : [["", file.bundle]];
    for (const [suffix, bytes] of artifacts) {
      const name = `~/assets/${file.name}${suffix}`;
      if (identicalFile(existing, name, info.buildId, bytes)) continue;
      const body = new FormData();
      body.set("name", name);
      body.set("dist", info.buildId);
      body.set("file", new Blob([bytes]), `${file.name}${suffix}`);
      if (!suffix && file.map) body.append("header", `Sourcemap:~/assets/${file.name}.map`);
      const response = await api(endpoint, { method: "POST", body });
      await response.arrayBuffer();
      if (
        response.status === 409 &&
        !identicalFile(await existingFiles(api, endpoint), name, info.buildId, bytes)
      ) {
        throw new Error(`Sentry artifact conflict could not be verified: ${name}`);
      }
    }
  }
  return {
    skipped: false,
    release,
    dist: info.buildId,
    files: files.reduce((count, file) => count + (file.map ? 2 : 1), 0),
    unmapped: files.filter((file) => !file.map).map((file) => file.name),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  uploadSentryRendererMaps()
    .then((result) => {
      console.log(result.skipped ? "Sentry source-map upload disabled" : JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Sentry source-map upload failed");
      process.exitCode = 1;
    });
}
