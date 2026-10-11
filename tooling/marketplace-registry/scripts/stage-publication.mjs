#!/usr/bin/env node
import { parseNamedArguments, readSubmission } from "./publication/cli.mjs";
import { stagePublication } from "./publication/stage.mjs";

const USAGE =
  "Usage: node scripts/stage-publication.mjs --submission FILE --repository owner/repo --directory DIR";

try {
  const options = parseNamedArguments(process.argv.slice(2), [
    "--submission",
    "--repository",
    "--directory",
  ]);
  const submission = await readSubmission(options.submission);
  const receipt = await stagePublication(submission, options.repository, options.directory);
  console.log(`staged ${receipt.artifacts.length} verified publication artifacts`);
} catch (error) {
  console.error(`publication staging failed: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
}
