import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ARCHIVE_BYTES } from "../scripts/publication/download.mjs";
import { createPublicationPlan } from "../scripts/publication/plan.mjs";
import { stagePipelinePublications } from "../scripts/publication/pipeline-staging.mjs";

const repository = "acme/registry";
const bytes = Buffer.from("inert fixture");

async function entriesFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const distribution = pkg.agent.distribution.binary["darwin-aarch64"];
  distribution.archive = "https://github.com/acme/provider/releases/download/v0.1.0/provider.tgz";
  distribution.sha256 = createHash("sha256").update(bytes).digest("hex");
  const entries = [];
  for (let index = 0; index < 5; index += 1) {
    const submission = {
      schema_version: 1,
      package: structuredClone(pkg),
      source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
      changelog: "budget fixture",
    };
    submission.package.agent.id = `provider-${index}`;
    const directory = path.join(root, String(index));
    await mkdir(directory);
    entries.push({
      directory,
      submission,
      plan: createPublicationPlan(submission, repository),
      registryCommit: "b".repeat(40),
    });
  }
  return entries;
}

test("source transfers receive a shared decrementing cap, not a fresh 1 GiB per publication", async (t) => {
  const entries = await entriesFixture(t);
  const limits = [];
  await assert.rejects(
    stagePipelinePublications(
      {
        repository,
        download: async ({ maxBytes, outputPath }) => {
          limits.push(maxBytes);
          // Simulate full-size transfer accounting without allocating GiB fixtures.
          await writeFile(outputPath, bytes, { flag: "wx" });
          return { size: MAX_ARCHIVE_BYTES };
        },
      },
      entries,
    ),
    /remaining staging budget/,
  );
  assert.deepEqual(limits, [
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_BYTES,
    0,
  ]);
});

test("oversized retained archives exhaust the aggregate budget before any new download", async (t) => {
  const entries = await entriesFixture(t);
  for (const entry of entries) {
    const handle = await open(path.join(entry.directory, entry.plan.targets[0].asset), "wx");
    try {
      await handle.truncate(MAX_ARCHIVE_BYTES);
    } finally {
      await handle.close();
    }
  }
  let downloads = 0;
  await assert.rejects(
    stagePipelinePublications(
      {
        repository,
        download: async () => {
          downloads += 1;
        },
      },
      entries,
    ),
    /aggregate size limit/,
  );
  assert.equal(downloads, 0);
});
