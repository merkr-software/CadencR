#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseNamedArguments, readSubmission } from "./publication/cli.mjs";
import { createPublicationPlan } from "./publication/plan.mjs";

const USAGE =
  "Usage: node scripts/plan-publication.mjs --submission FILE --repository owner/repo --output FILE";

try {
  const options = parseNamedArguments(process.argv.slice(2), [
    "--submission",
    "--repository",
    "--output",
  ]);
  const submission = await readSubmission(options.submission);
  const plan = createPublicationPlan(submission, options.repository);
  await writeFile(options.output, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.error(
    "Local plan only: no artifact was fetched, verified, mirrored, signed, or published.",
  );
  console.log(`publication plan: ${options.output}`);
} catch (error) {
  console.error(`publication planning failed: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
}
