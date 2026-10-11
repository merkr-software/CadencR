import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, validatePackage } from "../lib.mjs";
import { providerIdentifierKey, validateSubmission } from "../submission.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_ROOT_BYTES = 32 * 1024 * 1024;

export async function validateContribution(base, candidate) {
  const errors = [];
  const [baseTree, candidateTree] = await Promise.all([
    loadTree(base, "base", errors),
    loadTree(candidate, "candidate", errors),
  ]);
  if (!baseTree || !candidateTree || errors.length > 0) return errors;

  validateImmutableSet(baseTree.packages, candidateTree.packages, "package", errors);
  validateImmutableSet(baseTree.submissions, candidateTree.submissions, "submission", errors);

  for (const [name, entry] of candidateTree.packages) {
    errors.push(...validatePackage(entry.value, `candidate packages/${name}`));
    const identity = packageIdentity(entry.value);
    if (!identity) continue;
    const expected = `${identity.id}-${identity.version}.json`;
    if (name !== expected) errors.push(`packages/${name}: filename must be ${expected}`);
  }
  for (const [name, entry] of candidateTree.submissions) {
    errors.push(...validateSubmission(entry.value).map((error) => `submissions/${name}: ${error}`));
    const identity = packageIdentity(entry.value?.package);
    if (!identity) continue;
    const expected = `${identity.id}-${identity.version}.json`;
    if (name !== expected) errors.push(`submissions/${name}: filename must be ${expected}`);
    const packageEntry = candidateTree.packages.get(expected);
    if (!packageEntry)
      errors.push(`submissions/${name}: orphan submission has no packages/${expected}`);
    else if (canonicalJson(packageEntry.value) !== canonicalJson(entry.value.package)) {
      errors.push(
        `submissions/${name}: submission.package must exactly match packages/${expected}`,
      );
    }
    if (!baseTree.submissions.has(name) && baseTree.packages.has(name)) {
      errors.push(
        `submissions/${name}: retroactive provenance claims for legacy packages are not allowed`,
      );
    }
  }

  const baseProviders = providerOwners(baseTree.packages);
  const baseIdentities = new Set(
    [...baseTree.packages.values()]
      .map(({ value }) => packageIdentity(value))
      .filter(Boolean)
      .map(({ id, version }) => `${id}\0${version}`),
  );
  const candidateOwners = new Map(baseProviders);
  for (const [name, entry] of candidateTree.packages) {
    if (baseTree.packages.has(name)) continue;
    const identity = packageIdentity(entry.value);
    if (!identity) continue;
    const submission = candidateTree.submissions.get(name);
    if (!submission) {
      errors.push(`packages/${name}: new package versions require submissions/${name}`);
      continue;
    }
    if (baseTree.submissions.has(name)) continue;
    if (baseIdentities.has(`${identity.id}\0${identity.version}`)) {
      errors.push(
        `submissions/${name}: retroactive provenance claims for legacy packages are not allowed`,
      );
      continue;
    }
    const proposedOwner = {
      publisher: entry.value?.host?.publisher,
      repository: submission.value?.source?.repository,
    };
    const owner = candidateOwners.get(identity.id);
    if (owner) {
      if (entry.value?.host?.publisher !== owner.publisher)
        errors.push(
          `packages/${name}: host.publisher must remain ${JSON.stringify(owner.publisher)}`,
        );
      if (submission.value?.source?.repository !== owner.repository)
        errors.push(
          `submissions/${name}: source.repository must remain ${JSON.stringify(owner.repository)}`,
        );
    } else candidateOwners.set(identity.id, proposedOwner);
  }

  validateNormalizedCollisions(candidateTree.packages, errors);
  return errors;
}

function validateImmutableSet(base, candidate, kind, errors) {
  for (const [name, entry] of base) {
    const next = candidate.get(name);
    if (!next) errors.push(`${kind}s/${name}: deletion is not allowed`);
    else if (canonicalJson(entry.value) !== canonicalJson(next.value))
      errors.push(`${kind}s/${name}: existing ${kind}s are immutable`);
  }
}

function providerOwners(packages) {
  const result = new Map();
  for (const { value } of packages.values()) {
    const identity = packageIdentity(value);
    if (!identity || result.has(identity.id)) continue;
    result.set(identity.id, {
      publisher: value?.host?.publisher,
      repository: value?.agent?.repository,
    });
  }
  return result;
}

function validateNormalizedCollisions(packages, errors) {
  const owners = new Map();
  for (const [name, { value }] of packages) {
    const id = value?.agent?.id;
    if (typeof id !== "string") continue;
    const key = providerIdentifierKey(id);
    const prior = owners.get(key);
    if (prior && prior !== id)
      errors.push(
        `packages/${name}: provider id ${JSON.stringify(id)} collides with ${JSON.stringify(prior)} after runtime normalization`,
      );
    else owners.set(key, id);
  }
}

function packageIdentity(value) {
  const id = value?.agent?.id;
  const version = value?.agent?.version;
  return typeof id === "string" && typeof version === "string" ? { id, version } : null;
}

async function loadTree(root, label, errors) {
  const rootStat = await safeStat(root, label, errors);
  if (!rootStat?.isDirectory()) {
    if (rootStat) errors.push(`${label}: must be a directory`);
    return null;
  }
  const budget = { bytes: 0 };
  const packages = await loadJsonDirectory(
    path.join(root, "packages"),
    `${label}/packages`,
    true,
    budget,
    errors,
  );
  const submissions = await loadJsonDirectory(
    path.join(root, "submissions"),
    `${label}/submissions`,
    false,
    budget,
    errors,
  );
  return packages && submissions ? { packages, submissions } : null;
}

async function loadJsonDirectory(directory, label, required, budget, errors) {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return new Map();
    errors.push(`${label}: ${required ? "directory is required" : error.message}`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    errors.push(`${label}: must be a real directory, not a symlink or special file`);
    return null;
  }
  const names = [];
  const directoryHandle = await opendir(directory);
  try {
    for await (const entry of directoryHandle) {
      names.push(entry.name);
      if (names.length > MAX_FILES) {
        errors.push(`${label}: exceeds the ${MAX_FILES} entry limit`);
        return null;
      }
    }
  } finally {
    await directoryHandle.close().catch((error) => {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  const result = new Map();
  for (const name of names.sort()) {
    const file = path.join(directory, name);
    if (name === ".gitkeep") {
      const placeholder = await lstat(file);
      if (placeholder.isSymbolicLink() || !placeholder.isFile())
        errors.push(
          `${label}/${name}: must be a regular file (symlinks and special files are forbidden)`,
        );
      continue;
    }
    if (!name.endsWith(".json")) {
      errors.push(`${label}/${name}: only .json files are allowed`);
      continue;
    }
    try {
      const pathStat = await lstat(file);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        errors.push(
          `${label}/${name}: must be a regular file (symlinks and special files are forbidden)`,
        );
        continue;
      }
      const content = await readBoundedRegularFile(file, pathStat);
      budget.bytes += content.bytes;
      if (budget.bytes > MAX_ROOT_BYTES) {
        errors.push(`${label}: root exceeds the ${MAX_ROOT_BYTES}-byte JSON total limit`);
        return result;
      }
      try {
        result.set(name, { value: JSON.parse(content.text) });
      } catch (error) {
        errors.push(`${label}/${name}: invalid JSON (${error.message})`);
      }
    } catch (error) {
      errors.push(`${label}/${name}: ${error.message}`);
    }
  }
  return result;
}

async function readBoundedRegularFile(file, pathStat) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("must be a regular file (symlinks and special files are forbidden)");
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)
      throw new Error("changed while being validated");
    if (stat.size > MAX_FILE_BYTES)
      throw new Error(`exceeds the ${MAX_FILE_BYTES}-byte file limit`);
    const chunks = [];
    let bytes = 0;
    while (bytes <= MAX_FILE_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error(`exceeds the ${MAX_FILE_BYTES}-byte file limit`);
    const text = Buffer.concat(chunks, bytes).toString("utf8");
    return { text, bytes };
  } catch (error) {
    if (["ELOOP", "EFTYPE", "ENXIO"].includes(error?.code))
      throw new Error("must be a regular file (symlinks and special files are forbidden)");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function safeStat(target, label, errors) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      errors.push(`${label}: symlinks are forbidden`);
      return null;
    }
    return stat;
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}
