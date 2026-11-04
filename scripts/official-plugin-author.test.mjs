import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fixture as releaseFixture } from "./official-plugin-fixtures.mjs";
import { fixture } from "./official-plugin-author-fixtures.mjs";
const sha = "a".repeat(40);
const zero = "0".repeat(64);
const hash = (data) => createHash("sha256").update(data).digest("hex");
test("network fixture preserves stdlib imports and mocks only HTTP access", () => {
  const f = fixture();
  f.approve();
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import json,pathlib,sys,urllib.parse,urllib.request
assert pathlib.Path('fixture').name == 'fixture'
assert urllib.parse.urlparse('https://example.test/path').hostname == 'example.test'
assert urllib.parse.quote('theme / graphite', safe='') == 'theme%20%2F%20graphite'
assert not pathlib.Path(urllib.request.__file__).resolve().is_relative_to(pathlib.Path(sys.argv[1]))
request=urllib.request.Request('https://api.github.com/repos/merkr-software/CadencR')
with urllib.request.build_opener().open(request) as response:
 assert json.load(response) == {'id':42,'full_name':'merkr-software/CadencR'}
`,
      f.root,
    ],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
test("current author pin and policy fail before candidate access", () => {
  const f = fixture();
  const r = f.stage();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AUTHOR_PUBLICATION_PENDING/);
  assert.equal(r.stdout, "");
});
test("gate rejects non-main and untrusted workflow contexts", () => {
  const f = fixture();
  f.approve();
  f.env.GITHUB_REF = "refs/tags/evil";
  assert.match(
    f.run("official-plugin-author-gate.sh", [sha, zero]).stderr,
    /AUTHOR_CONTEXT_INVALID/,
  );
  f.env.GITHUB_REF = "refs/heads/main";
  f.env.GITHUB_WORKFLOW_REF = "evil";
  assert.match(
    f.run("official-plugin-author-gate.sh", [sha, zero]).stderr,
    /AUTHOR_CONTEXT_INVALID/,
  );
});
test("mocked approved reconstruction is deterministic and confirmation rejects changed bytes", () => {
  const f = fixture();
  f.approve();
  const inspected = f.stage();
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /^[0-9a-f]{64}\n$/);
  const confirmed = f.stage(inspected.stdout.trim());
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.stdout, inspected.stdout);
  assert.match(f.stage("b".repeat(64)).stderr, /AUTHOR_REQUEST_DIGEST_MISMATCH/);
});
test("pin changes fail before preparation", () => {
  const f = fixture();
  f.approve();
  writeFileSync(join(f.root, "scripts/official-plugin-author-cli.env"), "changed");
  assert.match(f.stage().stderr, /AUTHOR_POLICY_INVALID/);
});
test("workflow has no artifact authority or write token and scopes author secret to final step", () => {
  const workflow = readFileSync(".github/workflows/official-plugin-author.yml", "utf8");
  assert.doesNotMatch(workflow, /download-artifact|contents: write|pull_request:/);
  assert.equal(workflow.match(/secrets\.CADENCR_AUTHOR_GITHUB_TOKEN/g)?.length, 1);
  assert.match(workflow, /environment: official-plugin-publication/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
});

test("tag mismatch and source policy drift fail before reconstruction", () => {
  const f = fixture();
  f.approve();
  writeFileSync(
    join(f.root, "mock/git"),
    `#!/bin/sh\ncase "$3" in\nls-tree) echo '100644 blob hash' ;;\nshow) cat '${join(f.root, "plugins/release-policy.json")}' ;;\nrev-parse) echo '${"b".repeat(40)}' ;;\nesac\n`,
    { mode: 0o700 },
  );
  assert.match(f.stage().stderr, /AUTHOR_TAG_INVALID/);
  writeFileSync(
    join(f.root, "mock/git"),
    `#!/bin/sh\ncase "$3" in\nls-tree) echo '100644 blob hash' ;;\nshow) echo '{}' ;;\nesac\n`,
    { mode: 0o700 },
  );
  assert.match(f.stage().stderr, /AUTHOR_POLICY_MISMATCH/);
});

test("unprotected environment and repository identity mismatch fail closed", () => {
  const f = fixture();
  f.approve();
  f.env.MOCK_ENV_UNPROTECTED = "1";
  assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_ID_MISMATCH/);
  delete f.env.MOCK_ENV_UNPROTECTED;
  f.env.MOCK_REPO_MISMATCH = "1";
  assert.match(f.stage().stderr, /AUTHOR_REPOSITORY_INVALID/);
});

test("malformed dispatch input cannot reach source or environment inspection", () => {
  const f = fixture();
  f.approve();
  const result = f.run("official-plugin-author-gate.sh", ["bad\ninput", zero]);
  assert.match(result.stderr, /AUTHOR_INPUT_INVALID/);
  assert.equal(result.stdout, "");
});

test("qualification evidence must match the independently reviewed pin", () => {
  const f = fixture();
  f.approve();
  writeFileSync(join(f.root, "scripts/official-plugin-author-qualification.json"), "{}");
  assert.match(f.stage().stderr, /AUTHOR_QUALIFICATION_INVALID/);
});

test("environment identity binds reviewed no-bypass attestation", () => {
  const f = fixture();
  f.approve();
  // Documented normal response omits can_admins_bypass: explicit reviewed
  // attestation bound to the unchanged environment ID is required.
  assert.equal(f.stage().status, 0);
  f.env.MOCK_ENV_ID = "1";
  assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_ID_MISMATCH/);
  delete f.env.MOCK_ENV_ID;
  f.env.MOCK_ENV_BYPASS = "1";
  assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_UNPROTECTED/);
  delete f.env.MOCK_ENV_BYPASS;
  const policy = JSON.parse(readFileSync(f.policyPath, "utf8"));
  delete policy.admin_bypass_reviewed_disabled;
  writeFileSync(f.policyPath, JSON.stringify(policy));
  assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_REVIEW_REQUIRED/);
});

test("preparation mode flags are mutually exclusive", () => {
  for (const flags of [
    ["--qualification", "--author-approved"],
    ["--author-approved", "--qualification"],
  ]) {
    const result = spawnSync(
      "sh",
      [resolve("scripts/official-plugin-release.sh"), ...flags, "repo", sha, "tag", "out"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /mutually exclusive/);
  }
});

for (const kind of ["theme", "provider", "tab"]) {
  test(`${kind}: real trusted orchestrators reconstruct all metadata/assets and bind exact source content`, () => {
    const f = fixture();
    f.approve();
    const c = releaseFixture(kind);
    c.policy.publication = "APPROVED";
    c.files["plugins/release-policy.json"] = JSON.stringify(c.policy);
    c.save();
    writeFileSync(
      join(f.root, "plugins/release-policy.json"),
      c.files["plugins/release-policy.json"],
    );
    for (const name of [
      "official-plugin-release.sh",
      "official-plugin-prepare.py",
      "official_plugin_pack.py",
      "official_plugin_tags.py",
      "official_plugin_lsp.py",
      "official_plugin_lsp_archive.py",
    ])
      cpSync(resolve("scripts", name), join(f.root, "scripts", name));
    cpSync(join(c.root, "mock/git"), join(f.root, "mock/git"));
    const fetch = join(f.root, "tooling/marketplace-registry/scripts/ci");
    mkdirSync(fetch, { recursive: true });
    writeFileSync(
      join(fetch, "fetch-released-cli.sh"),
      `#!/bin/sh\nprintf '%s\\n' '${c.root}/cli'\n`,
    );
    const tag = `plugins/${c.plugin}/v${c.version}`;
    const inspected = f.stage(zero, tag);
    assert.equal(inspected.status, 0, inspected.stderr);
    const request = JSON.parse(readFileSync(join(inspected.output, "request.json")));
    assert.equal(
      request.metadata.name,
      "package.json",
      "opaque release receipt cannot replace registry metadata",
    );
    assert.equal(request.additional_archives.length, kind === "provider" ? 1 : 0);
    assert.equal(request.source_commit, sha);
    const confirmed = f.stage(inspected.stdout.trim(), tag);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.equal(confirmed.stdout, inspected.stdout);
    const payload = Object.values(c.entry.payloads)[0];
    const name = Object.keys(payload.files)[0];
    const path = `${payload.directory}/${name}`;
    c.files[path] += " changed reviewed content";
    payload.files[name].sha256 = hash(c.files[path]);
    c.files["plugins/release-policy.json"] = JSON.stringify(c.policy);
    c.save();
    writeFileSync(
      join(f.root, "plugins/release-policy.json"),
      c.files["plugins/release-policy.json"],
    );
    const changed = f.stage(inspected.stdout.trim(), tag);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /AUTHOR_REQUEST_DIGEST_MISMATCH/);
  });
}

test("author preparation rejects extra reconstructed content and unknown policy entries", () => {
  const f = fixture();
  f.approve();
  const script = join(f.root, "scripts/official-plugin-release.sh");
  writeFileSync(script, readFileSync(script, "utf8") + '\nprintf unreviewed > "$5/extra.txt"\n');
  assert.match(f.stage().stderr, /AUTHOR_EXTRA_CONTENT/);
  assert.match(f.stage(zero, "plugins/tab-unapproved/v0.1.0").stderr, /AUTHOR_PLUGIN_UNAPPROVED/);
});

test("reviewed schema-2 policy passes only the activation gate, without publication", () => {
  const f = fixture();
  f.approve();
  const result = f.run("official-plugin-author-gate.sh", [sha, zero]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "AUTHOR_ACTIVATION_APPROVED\n");
});

function setReviewPolicy(f, review) {
  const policy = JSON.parse(readFileSync(f.policyPath, "utf8"));
  policy.environment_review_policy = review;
  writeFileSync(f.policyPath, JSON.stringify(policy));
}
const reviewedPolicy = (prevent = false) => ({
  environment_id: 123,
  prevent_self_review: prevent,
  reviewers: [{ type: "User", id: 1 }],
});
const remoteRule = (prevent = false, reviewers = [{ type: "User", reviewer: { id: 1 } }]) => [
  { type: "required_reviewers", prevent_self_review: prevent, reviewers },
];

test("explicit reviewed self-review settings accept exactly both boolean configurations", () => {
  for (const prevent of [false, true]) {
    const f = fixture();
    f.approve();
    setReviewPolicy(f, reviewedPolicy(prevent));
    f.env.MOCK_REVIEW_RULE = JSON.stringify(remoteRule(prevent));
    assert.equal(f.stage().status, 0);
    f.env.MOCK_REVIEW_RULE = JSON.stringify(remoteRule(!prevent));
    assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_UNPROTECTED/);
  }
});

test("review policy requires explicit valid identities, boolean and pinned environment", () => {
  for (const invalid of [
    undefined,
    null,
    "PENDING",
    {},
    { ...reviewedPolicy(), environment_id: 124 },
    { ...reviewedPolicy(), environment_id: "123" },
    { ...reviewedPolicy(), prevent_self_review: undefined },
    { ...reviewedPolicy(), prevent_self_review: "false" },
    { ...reviewedPolicy(), reviewers: [] },
    { ...reviewedPolicy(), reviewers: [{ type: "User", id: "1" }] },
    { ...reviewedPolicy(), reviewers: [{ type: "User", id: true }] },
    { ...reviewedPolicy(), reviewers: [{ type: "User", id: 0 }] },
    { ...reviewedPolicy(), reviewers: [{ type: "Other", id: 1 }] },
    { ...reviewedPolicy(), reviewers: [{ type: "User", id: 1, login: "owner" }] },
    {
      ...reviewedPolicy(),
      reviewers: [
        { type: "User", id: 1 },
        { type: "User", id: 1 },
      ],
    },
    { ...reviewedPolicy(), unreviewed: true },
  ]) {
    const f = fixture();
    f.approve();
    setReviewPolicy(f, invalid);
    assert.match(f.stage().stderr, /AUTHOR_REVIEW_POLICY_INVALID/);
  }
});

test("remote required reviewers fail closed on missing, invalid, extra or mismatched identities", () => {
  for (const rules of [
    [],
    [...remoteRule(true), ...remoteRule(true)],
    [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] }],
    remoteRule(true, []),
    remoteRule(true, null),
    remoteRule(true, [{ type: "User", reviewer: { id: "1" } }]),
    remoteRule(true, [{ type: "User", reviewer: { id: 2 } }]),
    remoteRule(true, [{ type: "Team", reviewer: { id: 1 } }]),
    remoteRule(true, [{ type: "Other", reviewer: { id: 1 } }]),
    remoteRule(true, [{ type: "User", id: 1 }]),
    remoteRule(true, [
      { type: "User", reviewer: { id: 1 } },
      { type: "User", reviewer: { id: 2 } },
    ]),
    remoteRule(true, [
      { type: "User", reviewer: { id: 1 } },
      { type: "User", reviewer: { id: 1 } },
    ]),
  ]) {
    const f = fixture();
    f.approve();
    f.env.MOCK_REVIEW_RULE = JSON.stringify(rules);
    assert.match(f.stage().stderr, /AUTHOR_ENVIRONMENT_UNPROTECTED/);
  }
});

test("reviewed User and Team identities are compared as an exact unordered set", () => {
  const f = fixture();
  f.approve();
  setReviewPolicy(f, {
    ...reviewedPolicy(),
    reviewers: [
      { type: "User", id: 1 },
      { type: "Team", id: 2 },
    ],
  });
  f.env.MOCK_REVIEW_RULE = JSON.stringify(
    remoteRule(false, [
      { type: "Team", reviewer: { id: 2, slug: "reviewed-team" } },
      { type: "User", reviewer: { id: 1, login: "owner" } },
    ]),
  );
  assert.equal(f.stage().status, 0);
});
