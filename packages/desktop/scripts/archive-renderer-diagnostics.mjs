import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collectFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, name)));
    else if (entry.isFile() && /\.(?:js|css|map)$/.test(name)) files.push(name);
  }
  return files.sort();
}

/** Archive the SAME output electron-builder consumes; never rebuild or strip it. */
export async function archiveRendererDiagnostics({ rendererDir, outputDir, lockfile }) {
  const buildInfo = JSON.parse(await readFile(path.join(rendererDir, "build-info.json"), "utf8"));
  if (!/^[\w.-]+$/.test(buildInfo.version) || !["darwin", "linux"].includes(buildInfo.platform)) {
    throw new Error("Invalid renderer build metadata");
  }
  const names = await collectFiles(rendererDir);
  const maps = names.filter((name) => name.endsWith(".map"));
  if (!maps.some((name) => /(?:^|\/)index-[^/]+\.js\.map$/.test(name))) {
    throw new Error("Renderer entry source map missing; build with CADENCR_RENDERER_SOURCEMAPS=1");
  }
  for (const map of maps) {
    if (!names.includes(map.slice(0, -4))) throw new Error(`Map has no matching bundle: ${map}`);
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "cadencr-renderer-diagnostics-"));
  try {
    const files = [];
    for (const name of names) {
      const bytes = await readFile(path.join(rendererDir, name));
      const target = path.join(staging, "renderer", name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files.push({ path: `renderer/${name}`, sha256: sha256(bytes), bytes: bytes.length });
    }
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(
        {
          ...buildInfo,
          lockfileSha256: sha256(await readFile(lockfile)),
          files,
        },
        null,
        2,
      ),
    );
    await mkdir(outputDir, { recursive: true });
    const archive = path.resolve(
      outputDir,
      `Cadencr-${buildInfo.version}-${buildInfo.platform}-renderer-diagnostics.tar.gz`,
    );
    execFileSync("tar", ["-czf", archive, "-C", staging, "manifest.json", "renderer"]);
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    await archiveRendererDiagnostics({
      rendererDir: path.join(desktop, "out/renderer"),
      outputDir: path.join(desktop, "diagnostics"),
      lockfile: path.join(desktop, "../../pnpm-lock.yaml"),
    }),
  );
}
