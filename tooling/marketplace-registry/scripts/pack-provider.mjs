#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { validatePackage } from "./lib.mjs";
import { assertPackageFiles, buildArchive, collectStaging } from "./pack-provider/archive.mjs";

try {
  const options = parseArguments(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(options.package, "utf8"));
  const errors = validatePackage(metadata);
  if (errors.length > 0) throw new Error(`invalid package metadata:\n- ${errors.join("\n- ")}`);
  const target = metadata.agent.distribution.binary[options.target];
  if (!target) throw new Error(`package metadata does not declare target ${options.target}`);

  const output = path.resolve(options.output);
  const collected = await collectStaging(options.directory);
  const canonicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
  if (isWithin(collected.root, canonicalOutput)) {
    throw new Error("output must not be inside staging directory");
  }
  await assertPackageFiles(
    collected.root,
    collected.entries,
    options.target,
    target,
    metadata.host.assets,
  );
  const result = await buildArchive(collected.root, collected.entries, output);
  console.log(
    JSON.stringify({
      target: options.target,
      archive: output,
      sha256: result.sha256,
      size: result.size,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        "usage: pack-provider --package FILE --target TARGET --directory DIR --output FILE.tar.gz",
      );
    }
    const key = flag.slice(2);
    if (!["package", "target", "directory", "output"].includes(key) || values[key]) {
      throw new Error(`unknown or duplicate option: ${flag}`);
    }
    values[key] = value;
  }
  for (const key of ["package", "target", "directory", "output"])
    if (!values[key]) throw new Error(`--${key} is required`);
  if (!values.output.endsWith(".tar.gz")) throw new Error("--output must end in .tar.gz");
  return values;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
