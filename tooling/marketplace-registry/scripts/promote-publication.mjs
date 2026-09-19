#!/usr/bin/env node
import { parseNamedArguments, readSubmission } from "./publication/cli.mjs";
import { isExactCommit } from "./publication/commit.mjs";
import { createGitHubClient } from "./publication/github.mjs";
import { createPublicationPlan, validPublicationRepository } from "./publication/plan.mjs";
import { promotePublication } from "./publication/promote.mjs";

const FLAGS = [
  "--submission",
  "--repository",
  "--registry-commit",
  "--directory",
  "--confirm-repository",
  "--confirm-publish",
];
const USAGE = `Usage: node scripts/promote-publication.mjs ${FLAGS.join(" VALUE ")}`;

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
  const plannedTag = createPublicationPlan(submission, options.repository).release.tag;
  if (options["confirm-publish"] !== plannedTag) {
    throw new Error("publish confirmation must exactly match the planned release tag");
  }
  const token = process.env.CADENCR_REGISTRY_GITHUB_TOKEN;
  if (!token) throw new Error("CADENCR_REGISTRY_GITHUB_TOKEN is required");
  const client = createGitHubClient({ repository: options.repository, token });
  const receipt = await promotePublication({
    submission,
    repository: options.repository,
    registryCommit: options["registry-commit"],
    directory: options.directory,
    client,
  });
  console.log(`published and verified release ${receipt.release_tag}`);
} catch (error) {
  console.error(`publication promotion failed: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
}
