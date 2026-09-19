import { isExactCommit } from "../commit.mjs";
import { validateId, validateText } from "./validation.mjs";

const MAX_TAG_HOPS = 5;

function encodedPathSegment(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub ${label} response is malformed`);
  }
  return value;
}

function requireTarget(value, label) {
  const target = requireObject(value, label);
  if (!isExactCommit(target.sha) || (target.type !== "commit" && target.type !== "tag")) {
    throw new Error(`GitHub ${label} response is malformed`);
  }
  return target;
}

export function createPromotionMethods({ repository, request, requireRelease }) {
  async function getTagCommit(tag) {
    validateText(tag, "release tag");
    const reference = requireObject(
      await request(`/repos/${repository}/git/ref/tags/${encodedPathSegment(tag)}`),
      "tag reference",
    );
    if (reference.ref !== `refs/tags/${tag}`) {
      throw new Error("GitHub tag reference does not match");
    }

    let target = requireTarget(reference.object, "tag reference");
    const visited = new Set();
    for (let hop = 0; target.type === "tag"; hop += 1) {
      if (hop >= MAX_TAG_HOPS) throw new Error("GitHub annotated tag chain limit exceeded");
      if (visited.has(target.sha)) throw new Error("GitHub annotated tag cycle detected");
      visited.add(target.sha);
      const annotated = requireObject(
        await request(`/repos/${repository}/git/tags/${target.sha}`),
        "annotated tag",
      );
      if (annotated.sha !== target.sha) {
        throw new Error("GitHub annotated tag does not match");
      }
      target = requireTarget(annotated.object, "annotated tag");
    }
    return target.sha;
  }

  async function publishDraft(releaseId) {
    validateId(releaseId, "release id");
    return requireRelease(
      await request(`/repos/${repository}/releases/${releaseId}`, {
        method: "PATCH",
        body: { draft: false, make_latest: "false" },
      }),
    );
  }

  return { getTagCommit, publishDraft };
}
