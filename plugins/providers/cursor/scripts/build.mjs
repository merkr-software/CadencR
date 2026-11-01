// Build the host-native connector and install it as the package's `bin/provider`.
// Cross-target release artifacts are compiled per target in an isolated job
// (see README.md, "Release status"); this script never cross-compiles.
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "../../..");
const crate = "cadencr-plugin-provider-cursor";
const binary = "cadencr-cursor-provider";

export async function buildConnector({ outputDirectory = resolve(root, "bin") } = {}) {
  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const manifest = await readFile(resolve(root, "Cargo.toml"), "utf8");
  const crateVersion = manifest.match(/^version = "([^"]+)"/m)?.[1];
  if (crateVersion !== metadata.version) {
    throw new Error(`Cargo.toml ${crateVersion} != package.json ${metadata.version}`);
  }
  const build = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/cargo-env.mjs"), "cargo", "build", "--release", "--locked", "-p", crate],
    { cwd: root, stdio: "inherit" },
  );
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`cargo build exited with ${build.status}`);
  await mkdir(outputDirectory, { recursive: true });
  const target = resolve(outputDirectory, "provider");
  // Replace the file rather than rewriting it in place: macOS caches a
  // binary's code signature per inode and SIGKILLs a rewritten executable.
  const staged = `${target}.${process.pid}.tmp`;
  await copyFile(resolve(repoRoot, "target/release", binary), staged);
  await chmod(staged, 0o755);
  await rename(staged, target);
  return ["provider"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildConnector();
  console.log(`Built ${resolve(root, "bin/provider")}`);
}
