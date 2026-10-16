import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--directory")) {
  throw new Error("usage: package [--directory <new-payload-directory>]");
}
const output = args.length ? resolve(args[1]) : resolve(root, "dist/payload");
await mkdir(dirname(output), { recursive: true });
// Exclusive mkdir refuses an existing directory, file, or symlink without deletion.
await mkdir(output);
await mkdir(resolve(output, "bin"));
const emitted = await buildRuntime({ outputDirectory: resolve(output, "bin") });
const files = ["LICENSE", "README.md", "icon.svg", ...emitted.map((name) => `bin/${name}`)].sort();
const hashes = [];
for (const file of files) {
  if (!file.startsWith("bin/")) await copyFile(resolve(root, file), resolve(output, file));
  const bytes = await readFile(resolve(output, file));
  hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
await writeFile(`${output}.SHA256SUMS`, `${hashes.join("\n")}\n`, { flag: "wx" });
console.log(`Candidate payload: ${output}`);
