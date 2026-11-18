import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "linux-container.sh");

/** git with no signing or hooks from the user's config; fails with its stderr. */
function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

/** A main checkout holding a copy of the script, plus two linked worktrees
 * that share a directory name at different paths, under a temp root the test
 * removes even when building them fails. */
function checkouts(t) {
  const root = mkdtempSync(join(tmpdir(), "cadencr-linux-container-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  mkdirSync(join(main, "scripts"), { recursive: true });
  mkdirSync(join(main, "packages/desktop"), { recursive: true });
  copyFileSync(script, join(main, "scripts/linux-container.sh"));
  writeFileSync(join(main, "packages/desktop/package.json"), '{"version":"0.0.0"}');
  git(main, "init", "-q");
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const first = join(root, "a", "feature work");
  const second = join(root, "b", "feature work");
  git(main, "worktree", "add", "-q", "-b", "first", first);
  git(main, "worktree", "add", "-q", "-b", "second", second);
  return { main, first, second };
}

function volume(checkout, env = {}) {
  return execFileSync("bash", [join(checkout, "scripts/linux-container.sh"), "volume"], {
    encoding: "utf8",
    // No Docker needed: the arch is given.
    env: {
      ...process.env,
      BASH_ENV: "",
      CADENCR_LINUX_ARCH: "arm64",
      CADENCR_LINUX_SRC_VOLUME: "",
      ...env,
    },
  }).trim();
}

test("each worktree gets its own source volume; the main checkout keeps its name", (t) => {
  const { main, first, second } = checkouts(t);

  assert.equal(volume(main), "cadencr-linux-src-arm64");
  const firstVolume = volume(first);
  const secondVolume = volume(second);
  assert.match(firstVolume, /^cadencr-linux-src-arm64-feature-work-\d+$/);
  assert.notEqual(firstVolume, secondVolume, "same directory name, different paths");
  assert.equal(volume(first), firstVolume, "stable across runs");
  for (const name of [firstVolume, secondVolume]) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "a valid Docker volume name");
  }
});

test("CADENCR_LINUX_SRC_VOLUME picks the volume explicitly", (t) => {
  const { first } = checkouts(t);

  assert.equal(
    volume(first, { CADENCR_LINUX_SRC_VOLUME: "cadencr-linux-src-arm64" }),
    "cadencr-linux-src-arm64",
  );
});
