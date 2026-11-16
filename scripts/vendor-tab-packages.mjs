#!/usr/bin/env node
// Builds @cadencr/tab-sdk and @cadencr/tab-kit, packs them, and copies the
// tarballs to packages/service/resources/plugin-tabs/vendor/, where the
// service embeds them into every custom-tab scaffold (until both packages are
// on npm). Each tarball is checked to install standalone with npm: no
// `workspace:` specifiers and entry points under dist/ that exist.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(repoRoot, "packages/service/resources/plugin-tabs/vendor");

const PACKAGES = [
  { name: "@cadencr/tab-sdk", dir: "packages/tab-sdk", tarball: "cadencr-tab-sdk.tgz" },
  { name: "@cadencr/tab-kit", dir: "packages/tab-kit", tarball: "cadencr-tab-kit.tgz" },
];

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Every path a manifest's `exports` map points at. */
function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

function verify(tarball, name) {
  const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]));
  const files = new Set(
    run("tar", ["-tzf", tarball])
      .split("\n")
      .filter(Boolean)
      .map((path) => path.replace(/^package\//, "./")),
  );
  const problems = [];
  if (manifest.name !== name) problems.push(`name is ${manifest.name}`);
  if (JSON.stringify(manifest).includes("workspace:")) problems.push("a workspace: specifier");
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    problems.push(`runtime dependencies ${Object.keys(manifest.dependencies).join(", ")}`);
  }
  if (manifest.scripts?.postinstall || manifest.scripts?.install) problems.push("install scripts");
  for (const target of exportTargets(manifest.exports)) {
    if (!files.has(target)) problems.push(`exports target ${target} is not in the tarball`);
  }
  if (problems.length > 0) throw new Error(`${name} tarball: ${problems.join("; ")}`);
}

mkdirSync(vendorDir, { recursive: true });
for (const pkg of PACKAGES) {
  run("pnpm", ["--filter", pkg.name, "run", "build"]);
  const packDir = mkdtempSync(join(tmpdir(), "cadencr-vendor-"));
  try {
    run("pnpm", ["pack", "--pack-destination", packDir], join(repoRoot, pkg.dir));
    const [packed] = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
    if (!packed) throw new Error(`pnpm pack produced no tarball for ${pkg.name}`);
    verify(join(packDir, packed), pkg.name);
    copyFileSync(join(packDir, packed), join(vendorDir, pkg.tarball));
    console.log(
      `${pkg.name} → ${join("packages/service/resources/plugin-tabs/vendor", pkg.tarball)}`,
    );
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}
