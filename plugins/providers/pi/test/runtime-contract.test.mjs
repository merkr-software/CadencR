import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime prerequisite and protocol reference match the pinned Pi candidate", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(metadata.engines.node, ">=22.19.0 <23.0.0");
  assert.ok(readme.includes(`Node.js \`${metadata.engines.node}\``));
  assert.ok(readme.includes("@earendil-works/pi-coding-agent@0.85.1"));
  assert.ok(readme.includes("/blob/v0.85.1/packages/coding-agent/package.json"));
  assert.ok(readme.includes("/blob/v0.85.1/packages/coding-agent/docs/rpc.md"));
  assert.ok(!readme.includes("https://pi.dev/docs/latest/rpc"));
});
