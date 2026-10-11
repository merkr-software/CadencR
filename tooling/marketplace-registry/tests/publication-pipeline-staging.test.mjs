import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ARCHIVE_BYTES } from "../scripts/publication/download.mjs";
import { createPublicationPlan } from "../scripts/publication/plan.mjs";
import { stagePipelinePublications } from "../scripts/publication/pipeline-staging.mjs";
import { captureArchives, releaseArchives } from "../scripts/publication/pipeline-archives.mjs";

const repository = "acme/registry";
const bytes = Buffer.from("inert fixture");
const client = {
  async findRelease() {
    return null;
  },
  async getTagCommit() {
    throw new Error("unreachable");
  },
};

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

test("sequential publication staging does not impose a cumulative historical cap", async (t) => {
  const entries = await entriesFixture(t);
  const limits = [];
  for (const entry of entries) {
    await stagePipelinePublications(
      {
        repository,
        client,
        download: async ({ maxBytes, outputPath }) => {
          limits.push(maxBytes);
          await writeFile(outputPath, bytes, { flag: "wx" });
          return { size: MAX_ARCHIVE_BYTES };
        },
      },
      [entry],
    );
  }
  assert.deepEqual(limits, Array(5).fill(MAX_ARCHIVE_BYTES));
});

test("staging refuses simultaneous multiple publications before any download", async (t) => {
  const entries = await entriesFixture(t);
  let downloads = 0;
  await assert.rejects(
    stagePipelinePublications(
      {
        repository,
        client,
        download: async () => {
          downloads += 1;
        },
      },
      entries,
    ),
    /exactly one publication/,
  );
  assert.equal(downloads, 0);
});

test("verified transient cleanup preserves an inode replacement and receipts", async (t) => {
  const [entry] = await entriesFixture(t);
  await stagePipelinePublications(
    {
      repository,
      client,
      download: async ({ outputPath }) => {
        await writeFile(outputPath, bytes, { flag: "wx" });
        return { size: bytes.length };
      },
    },
    [entry],
  );
  const receipt = await readFile(path.join(entry.directory, "staging-receipt.json"));
  const owned = await captureArchives(entry);
  const file = owned[0].file;
  await rename(file, `${file}.old-inode`);
  await writeFile(file, "replacement", { flag: "wx" });
  await releaseArchives(owned);
  assert.equal(await readFile(file, "utf8"), "replacement");
  assert.deepEqual(await readFile(path.join(entry.directory, "staging-receipt.json")), receipt);
});
