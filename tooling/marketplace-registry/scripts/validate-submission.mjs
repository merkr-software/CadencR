#!/usr/bin/env node
import { open } from "node:fs/promises";
import { validateSubmission } from "./submission.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/validate-submission.mjs <submission.json> [...files]");
  process.exitCode = 1;
}

for (const file of files) {
  try {
    const handle = await open(file, "r");
    let value;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        throw new Error("submission must be a regular JSON file no larger than 1 MiB");
      }
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error("submission exceeds 1 MiB");
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    const errors = validateSubmission(value);
    if (errors.length) throw new Error(errors.join("\n  - "));
    console.log(`valid submission: ${file}`);
  } catch (error) {
    console.error(`invalid submission: ${file}\n  - ${error.message}`);
    process.exitCode = 1;
  }
}
