import { isExactCommit } from "../commit.mjs";

const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const PROVIDER_TAG = new RegExp(`^provider-[a-z][a-z0-9-]*-v(${SEMVER})$`);
const CATALOG_TAG = /^catalog-[a-f0-9]{64}$/;
const MAX_TAG_LENGTH = 255;
const MAX_U64 = 18_446_744_073_709_551_615n;

function encodedPathSegment(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function validatePublicationTag(tag) {
  if (typeof tag !== "string" || tag.length > MAX_TAG_LENGTH) {
    throw new Error("GitHub publication tag is invalid");
  }
  if (CATALOG_TAG.test(tag)) return;
  const provider = PROVIDER_TAG.exec(tag);
  const core = provider?.[1].split(/[+-]/, 1)[0].split(".").map(BigInt);
  if (!core || core.some((identifier) => identifier > MAX_U64)) {
    throw new Error("GitHub publication tag is invalid");
  }
}

function requireCreatedReference(value, tag, commit) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.ref !== `refs/tags/${tag}` ||
    !value.object ||
    typeof value.object !== "object" ||
    Array.isArray(value.object) ||
    value.object.type !== "commit" ||
    value.object.sha !== commit
  ) {
    throw new Error("GitHub created tag reference is malformed");
  }
}

export function createTagMethods({ repository, request, getTagCommit }) {
  async function reconcileFailedCreation(tag, commit, creationError) {
    let observed;
    try {
      observed = await getTagCommit(tag);
    } catch {
      throw creationError;
    }
    if (observed !== commit) throw new Error("GitHub publication tag commit conflicts");
    return commit;
  }

  async function ensurePublicationTag({ tag, commit } = {}) {
    validatePublicationTag(tag);
    if (!isExactCommit(commit)) throw new Error("GitHub publication tag commit is invalid");

    // Probe the reference endpoint itself before resolving it. A 404 while
    // following an existing annotated tag is not permission to create/replace
    // the reference.
    try {
      await request(`/repos/${repository}/git/ref/tags/${encodedPathSegment(tag)}`);
    } catch (error) {
      if (error?.status !== 404) throw error;
      return createMissingTag(tag, commit);
    }

    const observed = await getTagCommit(tag);
    if (observed !== commit) throw new Error("GitHub publication tag commit conflicts");
    return commit;
  }

  async function createMissingTag(tag, commit) {
    let created;
    try {
      created = await request(`/repos/${repository}/git/refs`, {
        method: "POST",
        body: { ref: `refs/tags/${tag}`, sha: commit },
      });
    } catch (error) {
      return reconcileFailedCreation(tag, commit, error);
    }
    requireCreatedReference(created, tag, commit);
    return commit;
  }

  return { ensurePublicationTag };
}
