#!/usr/bin/env node
import { parseNamedArguments, readSubmission } from "./publication/cli.mjs";
import { isExactCommit } from "./publication/commit.mjs";
import { createGitHubClient } from "./publication/github.mjs";
import { mirrorPublication } from "./publication/mirror.mjs";
import { validPublicationRepository } from "./publication/plan.mjs";

const FLAGS = [
  "--submission",
  "--repository",
  "--registry-commit",
  "--directory",
  "--confirm-repository",
];
const USAGE = `Usage: node scripts/mirror-publication.mjs ${FLAGS.join(" VALUE ")}`;

try {
  const options = parseNamedArguments(process.argv.slice(2), FLAGS);
  if (!validPublicationRepository(options.repository)) throw new Error("invalid repository");
  if (options["confirm-repository"] !== options.repository) {
    throw new Error("repository confirmation must exactly match --repository");
  }
  if (!isExactCommit(options["registry-commit"])) {
    throw new Error("registry commit must be 40 lowercase hex characters");
  }
  const submission = await readSubmission(options.submission);
  const token = process.env.CADENCR_REGISTRY_GITHUB_TOKEN;
  if (!token) throw new Error("CADENCR_REGISTRY_GITHUB_TOKEN is required");
  const client = createGitHubClient({ repository: options.repository, token });
  const receipt = await mirrorPublication({
    submission,
    repository: options.repository,
    registryCommit: options["registry-commit"],
    directory: options.directory,
    client,
  });
  console.log(
    `verified draft release ${receipt.release_tag} with ${receipt.artifacts.length} assets`,
  );
} catch (error) {
  console.error(`publication mirroring failed: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
}
