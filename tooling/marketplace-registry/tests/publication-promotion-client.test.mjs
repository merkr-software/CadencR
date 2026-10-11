import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "../scripts/publication/github.mjs";

const REPOSITORY = "owner/repository";
const TOKEN = "secret-token";
const COMMIT = "a".repeat(40);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl) {
  return createGitHubClient({ repository: REPOSITORY, token: TOKEN, fetchImpl });
}

test("getTagCommit verifies an exact lightweight tag reference", async () => {
  let captured;
  const github = client(async (url, options) => {
    captured = { url, options };
    return json({ ref: "refs/tags/provider/x v1", object: { type: "commit", sha: COMMIT } });
  });

  assert.equal(await github.getTagCommit("provider/x v1"), COMMIT);
  assert.equal(
    captured.url,
    "https://api.github.com/repos/owner/repository/git/ref/tags/provider%2Fx%20v1",
  );
  assert.equal(captured.options.redirect, "manual");
  assert.equal(captured.options.headers["x-github-api-version"], "2026-03-10");
});

test("getTagCommit resolves bounded nested annotated tags", async () => {
  const first = "b".repeat(40);
  const second = "c".repeat(40);
  const calls = [];
  const github = client(async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return json({ ref: "refs/tags/v1", object: { type: "tag", sha: first } });
    }
    if (calls.length === 2) {
      return json({ sha: first, object: { type: "tag", sha: second } });
    }
    return json({ sha: second, object: { type: "commit", sha: COMMIT } });
  });

  assert.equal(await github.getTagCommit("v1"), COMMIT);
  assert.match(calls[1], new RegExp(`/git/tags/${first}$`));
  assert.match(calls[2], new RegExp(`/git/tags/${second}$`));
});

test("getTagCommit fails closed for missing, redirected, or mismatched tags", async () => {
  const missing = client(async () => json({ message: "secret tag missing" }, 404));
  const missingError = await missing.getTagCommit("v1").catch((error) => error);
  assert.equal(missingError.status, 404);
  assert.doesNotMatch(missingError.message, /secret tag|v1/);

  const redirected = client(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.invalid/?token=leaked" },
      }),
  );
  const redirectError = await redirected.getTagCommit("v1").catch((error) => error);
  assert.equal(redirectError.status, 302);
  assert.doesNotMatch(redirectError.message, /evil|leaked|token=/);

  const mismatched = client(async () =>
    json({ ref: "refs/tags/other-secret", object: { type: "commit", sha: COMMIT } }),
  );
  const mismatchError = await mismatched.getTagCommit("v1").catch((error) => error);
  assert.match(mismatchError.message, /does not match/);
  assert.doesNotMatch(mismatchError.message, /other-secret|v1/);
});

test("getTagCommit rejects malformed, uppercase, cyclic, and overlong tag chains", async () => {
  const malformed = client(async () =>
    json({ ref: "refs/tags/v1", object: { type: "commit", sha: "A".repeat(40) } }),
  );
  await assert.rejects(malformed.getTagCommit("v1"), /malformed/);

  const cycleSha = "d".repeat(40);
  const cyclic = client(async (url) =>
    url.includes("/git/ref/")
      ? json({ ref: "refs/tags/v1", object: { type: "tag", sha: cycleSha } })
      : json({ sha: cycleSha, object: { type: "tag", sha: cycleSha } }),
  );
  await assert.rejects(cyclic.getTagCommit("v1"), /cycle detected/);

  const shas = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(40));
  let index = 0;
  const overlong = client(async (url) => {
    if (url.includes("/git/ref/")) {
      return json({ ref: "refs/tags/v1", object: { type: "tag", sha: shas[0] } });
    }
    const sha = shas[index];
    index += 1;
    return json({ sha, object: { type: "tag", sha: shas[index] } });
  });
  await assert.rejects(overlong.getTagCommit("v1"), /chain limit/);
  assert.equal(index, 5);
});

test("publishDraft patches only the fixed promotion fields", async () => {
  let captured;
  const github = client(async (url, options) => {
    captured = { url, options };
    return json({ id: 17, tag_name: "v1", draft: false });
  });

  const release = await github.publishDraft(17);
  assert.equal(release.id, 17);
  assert.equal(captured.url, "https://api.github.com/repos/owner/repository/releases/17");
  assert.equal(captured.options.method, "PATCH");
  assert.deepEqual(JSON.parse(captured.options.body), { draft: false, make_latest: "false" });
  assert.deepEqual(Object.keys(JSON.parse(captured.options.body)).sort(), ["draft", "make_latest"]);
});

test("publishDraft validates ids and redacts transport failures", async () => {
  let fetches = 0;
  const invalid = client(async () => {
    fetches += 1;
    return json({});
  });
  await assert.rejects(invalid.publishDraft(0), /release id/);
  assert.equal(fetches, 0);

  const failed = client(async () => {
    throw new Error("token=transport-secret");
  });
  const error = await failed.publishDraft(1).catch((value) => value);
  assert.match(error.message, /request failed/);
  assert.doesNotMatch(error.message, /transport-secret|token=/);
});
