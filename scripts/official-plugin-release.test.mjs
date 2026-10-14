import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  realpathSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = resolve("scripts/official-plugin-release.sh");
const commit = "a".repeat(40);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-release-test-")));
  for (const dir of [
    "scripts",
    "tooling/marketplace-registry/scripts/ci",
    "tooling/marketplace-registry/ci",
    "mock",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  cpSync(source, join(root, "scripts/official-plugin-release.sh"));
  const files = {
    "plugins/release-policy.json": {
      schema_version: 1,
      themes: { graphite: "0.1.0" },
      publication: "PENDING",
    },
    "plugins/themes/graphite/theme.json": { label: "Graphite" },
    "plugins/providers/pi/package.json": { version: "0.4.0" },
    "plugins/themes/LICENSE": "Apache-2.0",
  };
  writeFileSync(join(root, "files.json"), JSON.stringify(files));
  writeFileSync(
    join(root, "mock/git"),
    `#!/usr/bin/env python3
import json,sys,os
args=sys.argv[3:]; files=json.load(open('${root}/files.json'))
if args[0]=='remote': print(os.environ.get('MOCK_ORIGIN','https://github.com/merkr-software/CadencR.git'))
elif args[0]=='rev-parse': print(os.environ.get('MOCK_TAG_COMMIT' if args[-1].startswith('refs/tags/') else 'MOCK_COMMIT','${commit}'))
elif args[0]=='ls-tree': print(os.environ.get('MOCK_MODE','100644')+' blob hash\\t'+args[-1])
else:
 v=files[args[-1].split(':',1)[1]]; print(json.dumps(v) if not isinstance(v,str) else v)
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(root, "cli"),
    `#!/usr/bin/env python3
import sys,json,pathlib,hashlib,os
assert 'SECRET_TEST' not in os.environ
if sys.argv[1]=='plugin': sys.exit(0)
p=pathlib.Path(sys.argv[-1]); b=b'canonical inert archive'; p.write_bytes(b)
print(json.dumps({'kind':'theme','archive':str(p),'size':len(b),'sha256':('0'*64 if pathlib.Path('${root}/bad-receipt').exists() else hashlib.sha256(b).hexdigest())}))
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(root, "tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh"),
    `#!/bin/sh
case "$1" in */cli-qualification.env) printf '%s\\n' '${root}/cli';; *) echo 'Released Cadencr CLI pin is PENDING.' >&2; exit 3;; esac
`,
  );
  function run(
    tag = "plugins/theme-graphite/v0.1.0",
    extra = {},
    qualification = true,
    requestedOutput,
  ) {
    const output = requestedOutput ?? join(root, "public-" + Math.random());
    const result = spawnSync(
      "sh",
      [
        join(root, "scripts/official-plugin-release.sh"),
        ...(qualification ? ["--qualification"] : []),
        root,
        commit,
        tag,
        output,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: join(root, "mock") + ":" + process.env.PATH,
          SECRET_TEST: "sensitive-marker",
          GITHUB_REPOSITORY: "merkr-software/CadencR",
          GITHUB_SHA: commit,
          GITHUB_REF: "refs/tags/" + tag,
          ...extra,
        },
      },
    );
    return { ...result, output };
  }
  return { run, root };
}
test("qualification packaging validates receipts and emits only public source binding", () => {
  const { run, root } = fixture();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(join(result.output, "release.json"), "utf8");
  const metadata = JSON.parse(text);
  assert.equal(metadata.source_commit, commit);
  assert.equal(metadata.source_repository, "merkr-software/CadencR");
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      "schema_version",
      "plugin",
      "version",
      "source_repository",
      "source_commit",
      "source_path",
      "tag",
      "archive",
      "sha256",
      "size",
      "publication",
      "authority",
    ].sort(),
  );
  assert.deepEqual(
    readdirSync(result.output).sort(),
    [metadata.archive, "SHA256SUMS", "release.json"].sort(),
  );
  assert.equal(metadata.source_path, "plugins/themes/graphite");
  assert.equal(metadata.authority, "qualification");
  assert.equal(metadata.size, readFileSync(join(result.output, metadata.archive)).length);
  assert.equal(text.includes(root), false);
  assert.equal(text.includes("sensitive-marker"), false);
  assert.equal(
    readFileSync(join(result.output, "SHA256SUMS"), "utf8"),
    `${metadata.sha256}  ${metadata.archive}\n`,
  );
});
test("rejects desktop tags, unknown paths, version drift, symlinks and commit drift", () => {
  for (const [tag, env] of [
    ["v0.1.0", {}],
    ["plugins/theme-unknown/v0.1.0", {}],
    ["plugins/theme-graphite/v0.2.0", {}],
    ["plugins/theme-graphite/v0.1.0", { MOCK_MODE: "120000" }],
    ["plugins/theme-graphite/v0.1.0", { MOCK_COMMIT: "b".repeat(40) }],
    ["plugins/theme-graphite/v0.1.0", { MOCK_TAG_COMMIT: "b".repeat(40) }],
    ["plugins/theme-graphite/v0.1.0", { MOCK_ORIGIN: "https://github.com/evil/repo.git" }],
    ["plugins/provider-pi/v0.4.0", {}],
  ]) {
    const result = fixture().run(tag, env);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.output), false);
  }
});
test("default production mode fails closed rather than using qualification CLI", () => {
  const result = fixture().run(undefined, {}, false);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.output), false);
  assert.match(result.stderr, /PENDING/);
});

test("rejects forged packaging receipt before public output", () => {
  const { run, root } = fixture();
  writeFileSync(join(root, "bad-receipt"), "yes");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.output), false);
  assert.match(result.stderr, /receipt mismatch/);
});

test("refuses existing outputs, symlinks and noncanonical output parents without mutation", () => {
  const { run, root } = fixture();
  const existing = join(root, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep"), "unchanged");
  const link = join(root, "link");
  symlinkSync(existing, link);
  for (const output of [existing, link, join(link, "new")]) {
    const result = run(undefined, {}, true, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new absolute canonical/);
    assert.equal(readFileSync(join(existing, "keep"), "utf8"), "unchanged");
    assert.equal(existsSync(join(existing, "new")), false);
  }
});
test("production requires matching GitHub repository, commit and tag context", () => {
  for (const extra of [
    { GITHUB_REPOSITORY: "evil/repo" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_REF: "refs/heads/main" },
  ]) {
    const result = fixture().run(undefined, extra, false);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.output), false);
    assert.match(result.stderr, /authoritative GitHub tag context/);
  }
});

test("shallow namespaced tag fetch preserves lightweight and annotated source binding", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-tag-fetch-test-")));
  const origin = join(root, "origin");
  mkdirSync(origin);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Synthetic fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  function git(directory, args, input) {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-C",
        directory,
        ...args,
      ],
      { encoding: "utf8", env, input, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(origin, ["init", "--bare"]);
  const tree = git(origin, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
  const parent = git(origin, ["commit-tree", tree], "synthetic parent\n");
  const expected = git(origin, ["commit-tree", tree, "-p", parent], "synthetic source\n");
  const tags = ["plugins/theme-graphite/v0.1.0", "plugins/theme-ember/v0.1.0"];
  git(origin, ["update-ref", "refs/tags/" + tags[0], expected]);
  git(origin, ["tag", "--no-sign", "-a", tags[1], expected, "-m", "synthetic annotated tag"]);
  assert.equal(git(origin, ["cat-file", "-t", "refs/tags/" + tags[1]]), "tag");
  for (const [index, tag] of tags.entries()) {
    const checkout = join(root, "checkout-" + index);
    mkdirSync(checkout);
    git(checkout, ["init"]);
    git(checkout, [
      "fetch",
      "--depth=1",
      "--no-tags",
      "file://" + origin,
      "+refs/tags/" + tag + ":refs/tags/" + tag,
    ]);
    assert.equal(git(checkout, ["rev-parse", "refs/tags/" + tag + "^{commit}"]), expected);
    assert.equal(git(checkout, ["rev-parse", "--is-shallow-repository"]), "true");
    assert.equal(git(checkout, ["rev-list", "--count", expected]), "1");
    assert.equal(readFileSync(join(checkout, ".git/shallow"), "utf8").trim(), expected);
  }
});
