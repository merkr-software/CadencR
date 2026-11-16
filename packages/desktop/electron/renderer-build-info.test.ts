import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { rendererBuildInfo } from "./renderer-build-info";

it("refuses to copy a retained diagnostic probe into ordinary renderer output", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cadencr-probe-guard-"));
  mkdirSync(path.join(root, "public/react-depth-probe-123"), { recursive: true });
  writeFileSync(path.join(root, "index.js"), "export const value = 1;");
  const options = {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    build: { write: false, rollupOptions: { input: path.join(root, "index.js") } },
  };
  await expect(build({ ...options, plugins: [rendererBuildInfo("test").plugin] })).rejects.toThrow(
    /diagnostic probes must not ship/,
  );
  // The probe itself disables public copying, so it can still be built repeatedly.
  await expect(
    build({ ...options, publicDir: false, plugins: [rendererBuildInfo("test").plugin] }),
  ).resolves.toBeDefined();
});
