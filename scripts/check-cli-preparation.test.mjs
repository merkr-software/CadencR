import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliPreparation } from "./check-cli-preparation.mjs";

test("CLI preparation binds the exact source branch tip and package version", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cadencr-cli-preparation-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    mkdirSync(join(cwd, "packages/cli"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/cli/Cargo.toml"),
      '[package]\nname = "cadencr-cli"\nversion = "1.2.3"\n\n[dependencies]\n',
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    const sourceCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/cli-preparation/source", sourceCommit);
    const options = {
      cwd,
      sourceCommit,
      sourceBranch: "release/coordinated",
      releaseTag: "v1.2.3",
    };
    assert.equal(checkCliPreparation(options).publication, "not-authorized");
    assert.throws(
      () => checkCliPreparation({ ...options, sourceCommit: "HEAD" }),
      /full lowercase/,
    );
    assert.throws(
      () => checkCliPreparation({ ...options, sourceCommit: "f".repeat(40) }),
      /branch tip/,
    );
    assert.throws(() => checkCliPreparation({ ...options, sourceBranch: "../invalid" }));
    assert.throws(
      () => checkCliPreparation({ ...options, sourceBranch: undefined }),
      /explicitly provided/,
    );
    for (const releaseTag of ["v01.2.3", "v1.2.3-rc.1", "1.2.3", "v1.2.3;echo unsafe"]) {
      assert.throws(() => checkCliPreparation({ ...options, releaseTag }), /stable vX.Y.Z/);
    }
    assert.throws(
      () => checkCliPreparation({ ...options, releaseTag: "v1.2.4" }),
      /package version/,
    );
    writeFileSync(
      join(cwd, "packages/cli/Cargo.toml"),
      '[package]\nname = "cadencr-cli"\nversion = "1.2.4"\n',
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "advance");
    git("update-ref", "refs/remotes/cli-preparation/source", git("rev-parse", "HEAD"));
    assert.throws(() => checkCliPreparation(options), /branch tip/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preparation workflow cannot release desktop or publish CLI artifacts", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cli-preparation.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /\n  push:|contents: write|secrets\.|gh release|git push|git tag|pnpm install|electron-builder|notariz/i,
  );
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /git check-ref-format "refs\/heads\/\$SOURCE_BRANCH"/);
  assert.match(workflow, /node scripts\/check-cli-preparation\.mjs/);
  assert.match(workflow, /fetch-depth: 1/);
  assert.match(workflow, /git fetch --depth=1 --no-tags origin/);
  assert.match(workflow, /ref: \$\{\{ inputs.source_commit \}\}/);
  assert.match(workflow, /cargo test --locked/);
  assert.match(workflow, /cargo build --locked --release -p cadencr-cli/);
  assert.match(workflow, /scripts\/package-cli-release\.sh "\$RELEASE_TAG"/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});
