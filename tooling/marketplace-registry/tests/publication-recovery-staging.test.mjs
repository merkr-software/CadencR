import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicationPlan } from "../scripts/publication/plan.mjs";
import { stagePipelinePublications } from "../scripts/publication/pipeline-staging.mjs";

const repository = "acme/registry";
const registryCommit = "b".repeat(40);
const bytes = Buffer.from("published inert archive");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "published-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const distribution = pkg.agent.distribution.binary["darwin-aarch64"];
  distribution.archive = "https://github.com/acme/provider/releases/download/v0.1.0/provider.tgz";
  distribution.sha256 = createHash("sha256").update(bytes).digest("hex");
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "recovery fixture",
  };
  const plan = createPublicationPlan(submission, repository);
  return { directory, submission, plan, registryCommit };
}

test("published releases stage missing bytes only from the reviewed mirror destination", async (t) => {
  const entry = await fixture(t);
  const urls = [];
  const client = {
    async findRelease(tag) {
      return {
        id: 17,
        draft: false,
        tag_name: tag,
        target_commitish: registryCommit,
      };
    },
    async getTagCommit() {
      return registryCommit;
    },
  };
  await stagePipelinePublications(
    {
      repository,
      client,
      download: async ({ url, outputPath }) => {
        urls.push(url);
        await writeFile(outputPath, bytes, { flag: "wx" });
        return { size: bytes.length };
      },
    },
    [entry],
  );
  assert.deepEqual(urls, [entry.plan.targets[0].destination_url]);
  assert.notEqual(urls[0], entry.plan.targets[0].source_url);
});

test("published staging accepts platform targets that share the same source archive", async (t) => {
  const entry = await fixture(t);
  entry.submission.package.agent.distribution.binary["linux-x86_64"] = structuredClone(
    entry.submission.package.agent.distribution.binary["darwin-aarch64"],
  );
  entry.plan = createPublicationPlan(entry.submission, repository);
  const urls = [];
  const client = {
    async findRelease(tag) {
      return { id: 17, draft: false, tag_name: tag, target_commitish: registryCommit };
    },
    async getTagCommit() {
      return registryCommit;
    },
  };
  await stagePipelinePublications(
    {
      repository,
      client,
      download: async ({ url, outputPath }) => {
        urls.push(url);
        await writeFile(outputPath, bytes, { flag: "wx" });
        return { size: bytes.length };
      },
    },
    [entry],
  );
  assert.equal(urls.length, 2);
  assert.deepEqual(new Set(urls), new Set([entry.plan.targets[0].destination_url]));
});

test("published mirror failures never fall back to the author URL", async (t) => {
  const entry = await fixture(t);
  const urls = [];
  const client = {
    async findRelease(tag) {
      return { id: 17, draft: false, tag_name: tag, target_commitish: registryCommit };
    },
    async getTagCommit() {
      return registryCommit;
    },
  };
  await assert.rejects(
    stagePipelinePublications(
      {
        repository,
        client,
        download: async ({ url }) => {
          urls.push(url);
          throw new Error("public mirror unavailable");
        },
      },
      [entry],
    ),
    /public mirror unavailable/,
  );
  assert.deepEqual(urls, [entry.plan.targets[0].destination_url]);
});

test("published staging validates release and resolved tag before downloading", async (t) => {
  const entry = await fixture(t);
  let downloads = 0;
  await assert.rejects(
    stagePipelinePublications(
      {
        repository,
        client: {
          async findRelease(tag) {
            return { id: 17, draft: false, tag_name: tag, target_commitish: registryCommit };
          },
          async getTagCommit() {
            return "c".repeat(40);
          },
        },
        download: async () => {
          downloads += 1;
        },
      },
      [entry],
    ),
    /does not resolve to registry commit/,
  );
  assert.equal(downloads, 0);
});

test("verified baseline entries fail closed before staging even with retained archives", async (t) => {
  for (const release of [null, { draft: true }]) {
    await t.test(release ? "draft" : "missing", async (t) => {
      const entry = await fixture(t);
      entry.requirePublished = true;
      await writeFile(path.join(entry.directory, entry.plan.targets[0].asset), bytes);
      let downloads = 0;
      await assert.rejects(
        stagePipelinePublications(
          {
            repository,
            client: {
              async findRelease() {
                return release;
              },
              async getTagCommit() {
                throw new Error("unreachable");
              },
            },
            download: async () => {
              downloads += 1;
            },
          },
          [entry],
        ),
        /verified baseline publication is missing or draft/,
      );
      assert.equal(downloads, 0);
    });
  }
});

test("latched published staging revalidates release state even when fully retained", async (t) => {
  const entry = await fixture(t);
  let lookups = 0;
  let downloads = 0;
  const options = {
    repository,
    client: {
      async findRelease(tag) {
        lookups += 1;
        return { id: 17, draft: false, tag_name: tag, target_commitish: registryCommit };
      },
      async getTagCommit() {
        lookups += 1;
        return registryCommit;
      },
    },
    download: async ({ outputPath }) => {
      downloads += 1;
      await writeFile(outputPath, bytes, { flag: "wx" });
      return { size: bytes.length };
    },
  };
  await stagePipelinePublications(options, [entry]);
  assert.equal(lookups, 2);
  await stagePipelinePublications(options, [entry]);
  assert.equal(lookups, 4);
  assert.equal(downloads, 1);
});
