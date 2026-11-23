import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { devEngines } from "../package.json";

it("runs landing scripts with the workspace's pinned Node.js version", () => {
  const nodeVersion = readFileSync(new URL("../../../.nvmrc", import.meta.url), "utf8").trim();

  expect(devEngines.runtime.version).toBe(nodeVersion);
  expect(process.versions.node).toBe(nodeVersion);
});
