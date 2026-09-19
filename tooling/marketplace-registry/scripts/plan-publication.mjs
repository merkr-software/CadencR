#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { readBoundedRegularFile } from "./publication/io.mjs";
import { createPublicationPlan } from "./publication/plan.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const USAGE =
  "Usage: node scripts/plan-publication.mjs --submission FILE --repository owner/repo --output FILE";

try {
  const options = parseArguments(process.argv.slice(2));
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

function parseArguments(args) {
  const options = {};
  const allowed = new Set(["--submission", "--repository", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`invalid argument ${JSON.stringify(flag ?? "")}`);
    }
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new Error(`duplicate argument ${flag}`);
    options[key] = value;
  }
  for (const flag of allowed) {
    const key = flag.slice(2);
    if (options[key] === undefined) throw new Error(`missing required argument ${flag}`);
  }
  return options;
}

async function readSubmission(file) {
  const bytes = await readBoundedRegularFile(file, MAX_INPUT_BYTES, "submission");
  return JSON.parse(bytes.toString("utf8"));
}
