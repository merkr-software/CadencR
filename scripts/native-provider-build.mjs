import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildConnector(root, { outputDirectory = resolve(root, "bin") } = {}) {
  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const manifest = await readFile(resolve(root, "Cargo.toml"), "utf8");
  const crate = manifest.match(/^name = "([^"]+)"/m)?.[1];
  const crateVersion = manifest.match(/^version = "([^"]+)"/m)?.[1];
  const binary = manifest.split(/^\[\[bin\]\]\s*$/m)[1]?.match(/^name = "([^"]+)"/m)?.[1];
  if (!crate || !binary || !crateVersion || crateVersion !== metadata.version) {
    throw new Error(
      `Invalid Cargo package or binary identity, or version mismatch with ${metadata.version}`,
    );
  }
  const build = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/cargo-env.mjs"),
      "cargo",
      "build",
      "--release",
      "--locked",
      "-p",
      crate,
      "--bin",
      binary,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`cargo build failed (${build.signal ?? build.status})`);

  await mkdir(outputDirectory, { recursive: true });
  const target = resolve(outputDirectory, "provider");
  // Replace the inode so the macOS signature cache sees the new executable.
  const staged = `${target}.${process.pid}.tmp`;
  await copyFile(resolve(repoRoot, "target/release", binary), staged);
  await chmod(staged, 0o755);
  await rename(staged, target);
  return ["provider"];
}

export async function packageConnector(root, args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== "--directory")) {
    throw new Error("usage: package [--directory <new-payload-directory>]");
  }
  const output = args.length ? resolve(args[1]) : resolve(root, "dist/payload");
  await mkdir(dirname(output), { recursive: true });
  // Exclusive mkdir refuses an existing directory, file, or symlink.
  await mkdir(output);
  const emitted = await buildConnector(root, { outputDirectory: resolve(output, "bin") });
  const files = [
    "LICENSE",
    "README.md",
    "icon.svg",
    ...emitted.map((name) => `bin/${name}`),
  ].sort();
  const hashes = [];
  for (const file of files) {
    if (!file.startsWith("bin/")) await copyFile(resolve(root, file), resolve(output, file));
    const bytes = await readFile(resolve(output, file));
    hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
  }
  await writeFile(`${output}.SHA256SUMS`, `${hashes.join("\n")}\n`, { flag: "wx" });
  console.log(`Candidate payload: ${output}`);
}
