import { createHash } from "node:crypto";
import {
  DISCOVERY_FILENAME,
  MAX_DISCOVERY_BYTES,
  validateDiscoveryBranch,
} from "../discovery-location.mjs";

const SHA = /^[a-f0-9]{40}$/;

function malformed(message = "GitHub discovery response is malformed") {
  return new Error(message);
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
  return value;
}

function validateRef(value, branch) {
  const ref = requireObject(value);
  const object = requireObject(ref.object);
  if (
    ref.ref !== `refs/heads/${branch}` ||
    object.type !== "commit" ||
    typeof object.sha !== "string" ||
    !SHA.test(object.sha)
  ) {
    throw malformed("GitHub discovery branch response is malformed");
  }
  return object.sha;
}

function validateCommit(value, commitSha) {
  const commit = requireObject(value);
  const tree = requireObject(commit.tree);
  if (commit.sha !== commitSha || typeof tree.sha !== "string" || !SHA.test(tree.sha)) {
    throw malformed("GitHub discovery commit response is malformed");
  }
  return tree.sha;
}

function validateTree(value, treeSha) {
  const tree = requireObject(value);
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw malformed("GitHub discovery tree response is malformed");
  }
  const matches = tree.tree.filter(
    (entry) => entry && typeof entry === "object" && entry.path === DISCOVERY_FILENAME,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw malformed("GitHub discovery tree response is malformed");
  const entry = matches[0];
  if (
    entry.type !== "blob" ||
    (entry.mode !== "100644" && entry.mode !== "100755") ||
    typeof entry.sha !== "string" ||
    !SHA.test(entry.sha) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > MAX_DISCOVERY_BYTES
  ) {
    throw malformed("GitHub discovery tree entry is malformed");
  }
  return { sha: entry.sha, size: entry.size };
}

function decodeContent(value) {
  const compact = value.replace(/\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw malformed();
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) throw malformed();
  return bytes;
}

function validateContent(value, expected) {
  const content = requireObject(value);
  if (
    content.type !== "file" ||
    content.path !== DISCOVERY_FILENAME ||
    content.name !== DISCOVERY_FILENAME ||
    content.encoding !== "base64" ||
    typeof content.sha !== "string" ||
    !SHA.test(content.sha) ||
    !Number.isSafeInteger(content.size) ||
    content.size < 0 ||
    content.size > MAX_DISCOVERY_BYTES ||
    typeof content.content !== "string" ||
    content.sha !== expected.sha ||
    content.size !== expected.size
  ) {
    throw malformed();
  }
  const bytes = decodeContent(content.content);
  if (bytes.length !== content.size || bytes.length > MAX_DISCOVERY_BYTES) throw malformed();
  const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blobSha !== content.sha) throw malformed("GitHub discovery blob hash does not match");
  return { sha: content.sha, bytes };
}

export function createDiscoveryMethods({ repository, request }) {
  async function getDiscovery(branch) {
    validateDiscoveryBranch(branch);
    const commitSha = await request(`/repos/${repository}/git/ref/heads/${branch}`).then((value) =>
      validateRef(value, branch),
    );
    const treeSha = await request(`/repos/${repository}/git/commits/${commitSha}`).then((value) =>
      validateCommit(value, commitSha),
    );
    const entry = await request(`/repos/${repository}/git/trees/${treeSha}`).then((value) =>
      validateTree(value, treeSha),
    );
    if (entry === null) return null;
    return validateContent(
      await request(
        `/repos/${repository}/contents/${DISCOVERY_FILENAME}?ref=${encodeURIComponent(commitSha)}`,
      ),
      entry,
    );
  }

  async function setDiscovery({ branch, bytes, expectedSha }) {
    validateDiscoveryBranch(branch);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DISCOVERY_BYTES) {
      throw new Error("GitHub discovery bytes are invalid");
    }
    if (expectedSha !== null && (typeof expectedSha !== "string" || !SHA.test(expectedSha))) {
      throw new Error("GitHub discovery expected SHA is invalid");
    }
    const body = {
      branch,
      message: "Update managed provider discovery index",
      content: Buffer.from(bytes).toString("base64"),
      ...(expectedSha === null ? {} : { sha: expectedSha }),
    };
    return request(`/repos/${repository}/contents/${DISCOVERY_FILENAME}`, {
      method: "PUT",
      body,
    });
  }

  return { getDiscovery, setDiscovery };
}
