import { lstat } from "node:fs/promises";
import path from "node:path";
import { buildPublicationBinding } from "./binding.mjs";
import { validateResourceBudget } from "./catalog.mjs";
import { downloadVerifiedArchive, MAX_ARCHIVE_BYTES } from "./download.mjs";
import { stagePublication } from "./stage.mjs";

const LIMIT = 1024 * 1024 * 1024;

export async function stagePipelinePublications(options, entries) {
  let remaining = LIMIT - (await retainedBytes(entries));
  const download = options.download ?? downloadVerifiedArchive;
  const boundedDownload = async (input) => {
    const maxBytes = Math.min(input.maxBytes ?? MAX_ARCHIVE_BYTES, remaining);
    const result = await download({ ...input, maxBytes });
    if (!Number.isSafeInteger(result?.size) || result.size < 0 || result.size > maxBytes) {
      throw new Error("pipeline source download exceeds remaining staging budget");
    }
    remaining -= result.size;
    return result;
  };
  const staged = [];
  const artifacts = [];
  for (const entry of entries) {
    const receipt = await stagePublication(entry.submission, options.repository, entry.directory, {
      download: boundedDownload,
    });
    staged.push(receipt);
    artifacts.push(
      ...buildPublicationBinding(receipt, options.repository, entry.registryCommit, entry.directory)
        .expected,
    );
    validateResourceBudget(artifacts);
  }
  return staged;
}

async function retainedBytes(entries) {
  const retained = [];
  for (const entry of entries) {
    for (const target of entry.plan.targets) {
      let metadata;
      try {
        metadata = await lstat(path.join(entry.directory, target.asset));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_ARCHIVE_BYTES) {
        throw new Error("pipeline retained archive must be a bounded regular file");
      }
      retained.push({ size: metadata.size });
    }
  }
  return validateResourceBudget(retained);
}
