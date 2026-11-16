import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { archiveRendererDiagnostics } from "../packages/desktop/scripts/archive-renderer-diagnostics.mjs";

for (const platform of ["darwin", "linux"]) {
  test(`archives exact ${platform} bundles, maps and hashes without changing packaged output`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cadencr-map-test-"));
    const rendererDir = path.join(root, "renderer");
    const lockfile = path.join(root, "pnpm-lock.yaml");
    await mkdir(path.join(rendererDir, "assets"), { recursive: true });
    await writeFile(lockfile, "lockfileVersion: 9");
    await writeFile(
      path.join(rendererDir, "build-info.json"),
      JSON.stringify({
        version: "0.15.0",
        platform,
        buildId: "exact-build",
        commit: "abc123",
      }),
    );
    const bundle = "console.log('same bytes as packaged');";
    await writeFile(path.join(rendererDir, "assets/index-abc.js"), bundle);
    const args = { rendererDir, outputDir: path.join(root, "archives"), lockfile };
    await assert.rejects(archiveRendererDiagnostics(args), /entry source map missing/);
    await writeFile(path.join(rendererDir, "assets/index-abc.js.map"), '{"version":3}');
    const archive = await archiveRendererDiagnostics(args);
    assert.match(archive, new RegExp(`-${platform}-renderer-diagnostics.tar.gz$`));
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" }),
    );
    assert.equal(manifest.buildId, "exact-build");
    const entry = manifest.files.find((file) => file.path.endsWith(".js"));
    assert.equal(entry.sha256, createHash("sha256").update(bundle).digest("hex"));
    assert.equal(execFileSync("tar", ["-xOf", archive, entry.path], { encoding: "utf8" }), bundle);
    assert.equal(await readFile(path.join(rendererDir, "assets/index-abc.js"), "utf8"), bundle);
  });
}

const { assertRendererHasNoSourceMaps } = createRequire(import.meta.url)(
  "../packages/desktop/build/assert-renderer-no-maps.cjs",
);
test("packaging refuses a source map leaked into nested renderer resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cadencr-pack-map-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/index.js"), "code");
  assert.doesNotThrow(() => assertRendererHasNoSourceMaps(root));
  await writeFile(path.join(root, "assets/index.js.map"), "{}");
  assert.throws(() => assertRendererHasNoSourceMaps(root), /Source map leaked/);
});
