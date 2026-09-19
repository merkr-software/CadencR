import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "../scripts/publication/github.mjs";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const TAG = "provider-acme-agent-v1.2.3";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function reference(tag = TAG, commit = COMMIT, type = "commit") {
  return { ref: `refs/tags/${tag}`, object: { type, sha: commit } };
}

function client(fetchImpl) {
  return createGitHubClient({ repository: "owner/repository", token: "token", fetchImpl });
}

test("ensurePublicationTag creates only a missing bounded publication tag", async () => {
  const calls = [];
  const github = client(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({}, 404);
    return json(reference());
  });

  assert.equal(await github.ensurePublicationTag({ tag: TAG, commit: COMMIT }), COMMIT);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/git\/ref\/tags\/provider-acme-agent-v1\.2\.3$/);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "https://api.github.com/repos/owner/repository/git/refs");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    ref: `refs/tags/${TAG}`,
    sha: COMMIT,
  });
});

test("ensurePublicationTag performs no write when the tag already resolves to the commit", async () => {
  let calls = 0;
  const github = client(async () => {
    calls += 1;
    return json(reference());
  });
  assert.equal(await github.ensurePublicationTag({ tag: TAG, commit: COMMIT }), COMMIT);
  assert.equal(calls, 2);
});

test("ensurePublicationTag rejects an existing tag resolving to another commit", async () => {
  let calls = 0;
  const github = client(async () => {
    calls += 1;
    return json(reference(TAG, OTHER_COMMIT));
  });
  await assert.rejects(github.ensurePublicationTag({ tag: TAG, commit: COMMIT }), /conflicts/);
  assert.equal(calls, 2);
});

test("ensurePublicationTag reconciles a lost response or race without overwriting", async () => {
  for (const failure of [new Error("token=lost-secret"), json({}, 403)]) {
    const calls = [];
    const github = client(async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return json({}, 404);
      if (calls.length === 2) {
        if (failure instanceof Response) return failure;
        throw failure;
      }
      return json(reference());
    });
    assert.equal(await github.ensurePublicationTag({ tag: TAG, commit: COMMIT }), COMMIT);
    assert.deepEqual(
      calls.map(({ options }) => options.method),
      ["GET", "POST", "GET"],
    );
  }
});

test("ensurePublicationTag preserves sanitized creation errors when reconciliation fails", async () => {
  let calls = 0;
  const github = client(async () => {
    calls += 1;
    if (calls === 1) return json({}, 404);
    if (calls === 2) return json({ message: "secret" }, 403);
    return json({}, 404);
  });
  const error = await github
    .ensurePublicationTag({ tag: TAG, commit: COMMIT })
    .catch((value) => value);
  assert.equal(error.status, 403);
  assert.doesNotMatch(error.message, /secret|token/);
});

test("ensurePublicationTag rejects a conflicting race and malformed inputs before writes", async () => {
  let calls = 0;
  const racing = client(async () => {
    calls += 1;
    if (calls === 1) return json({}, 404);
    if (calls === 2) return json({}, 403);
    return json(reference(TAG, OTHER_COMMIT));
  });
  await assert.rejects(racing.ensurePublicationTag({ tag: TAG, commit: COMMIT }), /conflicts/);

  const invalid = client(async () => {
    throw new Error("must not fetch");
  });
  for (const tag of [
    "v1.2.3",
    "provider-acme/v1.2.3",
    "provider-acme-v01.2.3",
    "provider-acme-v18446744073709551616.0.0",
    `catalog-${"A".repeat(64)}`,
  ]) {
    await assert.rejects(invalid.ensurePublicationTag({ tag, commit: COMMIT }), /tag is invalid/);
  }
  await assert.rejects(
    invalid.ensurePublicationTag({ tag: TAG, commit: "A".repeat(40) }),
    /commit is invalid/,
  );
});

test("ensurePublicationTag accepts the catalog digest tag form", async () => {
  const tag = `catalog-${"c".repeat(64)}`;
  const github = client(async () => json(reference(tag)));
  assert.equal(await github.ensurePublicationTag({ tag, commit: COMMIT }), COMMIT);
});

test("ensurePublicationTag never creates when an existing annotated tag target is missing", async () => {
  const tagObject = "d".repeat(40);
  const calls = [];
  const github = client(async (url, options) => {
    calls.push({ url, options });
    if (calls.length <= 2) return json(reference(TAG, tagObject, "tag"));
    return json({}, 404);
  });
  const error = await github
    .ensurePublicationTag({ tag: TAG, commit: COMMIT })
    .catch((value) => value);
  assert.equal(error.status, 404);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.method === "GET"));
});
