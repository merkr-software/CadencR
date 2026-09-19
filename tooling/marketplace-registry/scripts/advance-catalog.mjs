#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNamedArguments } from "./publication/cli.mjs";
import { readPublicationManifest } from "./publication/catalog.mjs";
import { advanceCatalogDiscovery } from "./publication/discovery.mjs";
import { discoveryUrl, validateDiscoveryBranch } from "./publication/discovery-location.mjs";
import { createGitHubClient } from "./publication/github.mjs";
import { isExactCommit } from "./publication/commit.mjs";
import { validPublicationRepository } from "./publication/plan.mjs";
import { prepareCatalogSnapshot } from "./publication/snapshot.mjs";

const FLAGS = [
  "--catalog",
  "--previous-index",
  "--public-key",
  "--key-id",
  "--manifest",
  "--repository",
  "--registry-commit",
  "--directory",
  "--confirm-repository",
  "--confirm-publish",
  "--discovery-branch",
  "--confirm-discovery",
];
const USAGE = `Usage: node scripts/advance-catalog.mjs ${FLAGS.join(" VALUE ")}`;

export async function runCatalogAdvancer(values, dependencies = {}) {
  validateArguments(values);
  const options = {
    catalogFile: values.catalog,
    previousIndex: values["previous-index"],
    publicKeyFile: values["public-key"],
    keyId: values["key-id"],
    manifest: values.manifest,
    repository: values.repository,
    registryCommit: values["registry-commit"],
    directory: values.directory,
    discoveryBranch: values["discovery-branch"],
    download: dependencies.download,
    downloadDiscovery: dependencies.downloadDiscovery,
    now: dependencies.now,
  };
  const snapshot = await prepareCatalogSnapshot(options);
  const manifest = await readPublicationManifest(path.resolve(values.manifest));
  if (manifest.repository !== values.repository) {
    throw new Error("publication manifest repository does not match --repository");
  }
  const metadata = await lstat(values.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("catalog publication path must be a non-symlink directory");
  }
  if (values["confirm-publish"] !== snapshot.tag) {
    throw new Error("publish confirmation must exactly match the computed catalog tag");
  }
  const expectedUrl = discoveryUrl(values.repository, values["discovery-branch"]);
  if (values["confirm-discovery"] !== expectedUrl) {
    throw new Error("discovery confirmation must exactly match the raw discovery URL");
  }

  const token = dependencies.token ?? process.env.CADENCR_REGISTRY_GITHUB_TOKEN;
  if (!token) throw new Error("CADENCR_REGISTRY_GITHUB_TOKEN is required");
  const client =
    dependencies.client ??
    createGitHubClient({ repository: values.repository, token, fetchImpl: dependencies.fetchImpl });
  return advanceCatalogDiscovery({ ...options, client });
}

function validateArguments(values) {
  if (!validPublicationRepository(values.repository)) throw new Error("invalid repository");
  if (values["confirm-repository"] !== values.repository) {
    throw new Error("repository confirmation must exactly match --repository");
  }
  if (!isExactCommit(values["registry-commit"])) {
    throw new Error("registry commit must be 40 lowercase hex characters");
  }
  validateDiscoveryBranch(values["discovery-branch"]);
}

async function main() {
  const values = parseNamedArguments(process.argv.slice(2), FLAGS);
  const receipt = await runCatalogAdvancer(values);
  console.log(`advanced discovery ${receipt.branch} to ${receipt.snapshot_sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `advance-catalog: ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    console.error(USAGE);
    process.exitCode = 1;
  });
}
