import { lstat } from "node:fs/promises";
import path from "node:path";
import { buildPublicationBinding } from "./binding.mjs";
import { validateResourceBudget } from "./catalog.mjs";
import { downloadVerifiedArchive, MAX_ARCHIVE_BYTES } from "./download.mjs";
import { stagePublication } from "./stage.mjs";
import { readBoundedRegularFile } from "./io.mjs";

const LIMIT = 1024 * 1024 * 1024;

export async function inspectPipelinePublications(options, entries) {
  const inspected = [];
  for (const entry of entries)
    inspected.push(await releaseDownloadForEntry(options.client, entry, options.repository));
  return inspected;
}

export async function stagePipelinePublications(options, entries, inspected) {
  if (entries.length !== 1) throw new Error("pipeline stages exactly one publication at a time");
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
  const releaseDownloads = inspected ?? (await inspectPipelinePublications(options, entries));
  for (const [index, entry] of entries.entries()) {
    if (releaseDownloads[index]) entry.requirePublished = true;
  }
  const staged = [];
  const artifacts = [];
  for (const [index, entry] of entries.entries()) {
    const receipt = await stagePublication(entry.submission, options.repository, entry.directory, {
      download: (input) =>
        boundedDownload(rewriteDownload(input, entry.plan.targets, releaseDownloads[index])),
    });
    staged.push(receipt);
    artifacts.push(...receipt.artifacts);
    validateResourceBudget(artifacts);
  }
  return staged;
}

async function releaseDownloadForEntry(client, entry, repository) {
  if (typeof client?.findRelease !== "function" || typeof client?.getTagCommit !== "function")
    throw new Error("pipeline staging client is missing release discovery methods");
  const { tag } = entry.plan.release;
  let historical = entry.requirePublished;
  for (const name of ["publication-receipt.json", "mirror-receipt.json"]) {
    const file = path.join(entry.directory, name);
    try {
      await lstat(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const bytes = await readBoundedRegularFile(file, 4 * 1024 * 1024, "publication proof");
    const receipt = JSON.parse(bytes.toString("utf8"));
    historical ||= name === "publication-receipt.json" || receipt.status === "published_recovered";
  }
  const release = await client.findRelease(tag);
  if (!release || release.draft === true) {
    if (historical) {
      throw new Error("verified baseline publication is missing or draft");
    }
    return null;
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0)
    throw new Error("published release id is invalid");
  if (release.tag_name !== tag) throw new Error("published release tag does not match");
  if (release.target_commitish !== entry.registryCommit)
    throw new Error("published release target commit does not match");
  if (release.draft !== false) throw new Error("published release draft state is invalid");
  const binding = buildPublicationBinding(
    { plan: entry.plan, artifacts: [] },
    repository,
    entry.registryCommit,
    entry.directory,
  );
  if (release.body !== binding.body) throw new Error("published release marker does not match");
  if ((await client.getTagCommit(tag)) !== entry.registryCommit)
    throw new Error("published release tag does not resolve to registry commit");
  return true;
}

function rewriteDownload(input, targets, usePublishedRelease) {
  if (!usePublishedRelease) return input;
  const matches = targets.filter(
    (target) => target.source_url === input.url && target.sha256 === input.sha256,
  );
  if (matches.length === 0) throw new Error("published archive source mapping is missing");
  // Multiple platforms may intentionally share one archive. Every match has the
  // same reviewed digest, and published recovery separately verifies the full asset set.
  return { ...input, url: matches[0].destination_url };
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
