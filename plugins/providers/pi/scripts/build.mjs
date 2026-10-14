import { chmod, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONNECTOR_VERSION } from "../src/version.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildRuntime({
  outputDirectory = resolve(root, "bin"),
  sourceDirectory = resolve(root, "src"),
} = {}) {
  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (metadata.version !== CONNECTOR_VERSION) throw new Error("Package/runtime version mismatch");
  const entries = (await readdir(sourceDirectory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) {
      throw new Error(`Runtime source must contain regular .mjs files only: ${entry.name}`);
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  const emitted = [];
  for (const entry of entries) {
    const outputName = entry.name === "provider.mjs" ? "provider" : entry.name;
    await copyFile(resolve(sourceDirectory, entry.name), resolve(outputDirectory, outputName));
    emitted.push(outputName);
  }
  await chmod(resolve(outputDirectory, "provider"), 0o755);
  return emitted;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildRuntime();
  console.log(`Built ${resolve(root, "bin/provider")}`);
}
