#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNamedArguments } from "./publication/cli.mjs";
import { createGitHubClient } from "./publication/github.mjs";
import { runPublicationPipeline } from "./publication/pipeline.mjs";

const FLAGS = [
  "--request",
  "--directory",
  "--repository",
  "--registry-commit",
  "--private-key",
  "--confirm-request-sha256",
];

export async function runRegistryPublisher(values, dependencies = {}) {
  const token = dependencies.token ?? process.env.CADENCR_REGISTRY_GITHUB_TOKEN;
  if (!token) throw new Error("CADENCR_REGISTRY_GITHUB_TOKEN is required");
  const client =
    dependencies.client ??
    createGitHubClient({
      repository: values.repository,
      token,
      fetchImpl: dependencies.fetchImpl,
    });
  return runPublicationPipeline({
    requestFile: values.request,
    directory: values.directory,
    repository: values.repository,
    registryCommit: values["registry-commit"],
    privateKeyFile: values["private-key"],
    confirmRequestSha256: values["confirm-request-sha256"],
    client,
    download: dependencies.download,
    downloadDiscovery: dependencies.downloadDiscovery,
    now: dependencies.now,
  });
}

async function main() {
  const values = parseNamedArguments(process.argv.slice(2), FLAGS);
  await runRegistryPublisher(values);
  console.log("registry publication and public discovery verified");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `publish-registry: ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    process.exitCode = 1;
  });
}
