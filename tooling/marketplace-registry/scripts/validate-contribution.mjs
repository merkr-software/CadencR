#!/usr/bin/env node
import process from "node:process";
import { validateContribution } from "./contribution/validate.mjs";

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--base" || argv[2] !== "--candidate") {
    throw new Error("usage: validate-contribution.mjs --base DIRECTORY --candidate DIRECTORY");
  }
  if (!argv[1] || !argv[3]) throw new Error("--base and --candidate require non-empty directories");
  return { base: argv[1], candidate: argv[3] };
}

try {
  const { base, candidate } = parseArguments(process.argv.slice(2));
  const errors = await validateContribution(base, candidate);
  if (errors.length > 0) {
    console.error(`Contribution validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Contribution validation passed.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
