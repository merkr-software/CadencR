import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime prerequisite and protocol reference match the pinned Pi candidate", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(metadata.engines.node, ">=22.19.0 <23.0.0");
  assert.ok(readme.includes(`Node.js \`${metadata.engines.node}\``));
  assert.ok(readme.includes("@earendil-works/pi-coding-agent@0.85.1"));
  assertPinnedReferences(readme);
});

const pinnedReferences = [
  "https://github.com/badlogic/pi-mono/blob/v0.85.1/packages/coding-agent/package.json",
  "https://github.com/badlogic/pi-mono/blob/v0.85.1/packages/coding-agent/docs/rpc.md",
];
const movingReference = "https://pi.dev/docs/latest/rpc";

// This parses the simple inline Markdown links used by this README, not provenance.
function assertPinnedReferences(markdown) {
  const destinations = new Set(
    Array.from(markdown.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g), (match) => match[1]),
  );
  for (const reference of pinnedReferences) {
    assert.ok(destinations.has(reference), `Missing exact pinned reference: ${reference}`);
  }
  assert.ok(
    !destinations.has(movingReference),
    "RPC documentation must not use the moving latest ref",
  );
}

function referenceMarkdown(references) {
  return references.map((reference) => `[reference](${reference})`).join("\n");
}

test("documentation references require whole pinned Markdown destinations", () => {
  assert.doesNotThrow(() => assertPinnedReferences(referenceMarkdown(pinnedReferences)));
  for (const [index, reference] of pinnedReferences.entries()) {
    for (const deceptive of [
      `https://example.invalid/${reference}`,
      `${reference}.extra`,
      reference.replace("github.com", "example.invalid"),
    ]) {
      const references = [...pinnedReferences];
      references[index] = deceptive;
      assert.throws(() => assertPinnedReferences(referenceMarkdown(references)), {
        code: "ERR_ASSERTION",
      });
    }
  }
  assert.throws(
    () => assertPinnedReferences(referenceMarkdown([...pinnedReferences, movingReference])),
    { code: "ERR_ASSERTION" },
  );
});
