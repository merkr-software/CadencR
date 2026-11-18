import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cadencr-linux-container-")));
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
  return { root, main, first, second };
}

/** Run the checkout's copy of the script; no Docker needed when the arch is given. */
function run(checkout, args, env = {}) {
  const result = spawnSync("bash", [join(checkout, "scripts/linux-container.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASH_ENV: "",
      CADENCR_LINUX_ARCH: "arm64",
      CADENCR_LINUX_SRC_VOLUME: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, `linux-container.sh ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const volume = (checkout, env) => run(checkout, ["volume"], env).trim();

test("each worktree gets its own source volume; the main checkout keeps its name", (t) => {
  const { main, first, second } = checkouts(t);

  assert.equal(volume(main), "cadencr-linux-src-arm64");
  const firstVolume = volume(first);
  const secondVolume = volume(second);
  assert.match(firstVolume, /^cadencr-linux-src-arm64-w\d+-feature-work-\d+$/);
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

/** Docker's volume commands over a JSON file of volume labels; every call is logged. */
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(state + "/calls", args.join(" ") + "\\n");
const volumes = JSON.parse(fs.readFileSync(state + "/volumes.json", "utf8"));
const [group, action, ...rest] = args;
if (group === "volume" && action === "ls") {
  const at = rest.indexOf("--filter");
  const [key, ...value] = at < 0 ? [] : rest[at + 1].replace(/^label=/, "").split("=");
  for (const [name, labels] of Object.entries(volumes)) {
    const matches = key === undefined || (key in labels && (!value.length || labels[key] === value.join("=")));
    if (matches) console.log(name);
  }
} else if (group === "volume" && action === "inspect") {
  const name = rest.at(-1);
  if (!(name in volumes)) process.exit(1);
  if (rest[0] === "-f") {
    const key = /"([^"]+)"/.exec(rest[1])[1];
    const labels = volumes[name];
    console.log(key in labels ? labels[key] : Object.keys(labels).length ? "<no value>" : "");
  }
} else if (group === "volume" && action === "rm") {
  delete volumes[rest[0]];
  fs.writeFileSync(state + "/volumes.json", JSON.stringify(volumes));
} else {
  console.error("fake docker: unsupported " + args.join(" "));
  process.exit(2);
}
`;

function fakeDocker(root, volumes) {
  const bin = join(root, "fake-bin");
  const state = join(root, "fake-docker");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(state, "volumes.json"), JSON.stringify(volumes));
  writeFileSync(join(state, "calls"), "");
  return {
    env: { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: state },
    volumes: () => Object.keys(JSON.parse(readFileSync(join(state, "volumes.json"), "utf8"))),
    calls: () => readFileSync(join(state, "calls"), "utf8").trim().split("\n"),
  };
}

test("prune removes only this repository's volume of a worktree git no longer knows", (t) => {
  const { root, main, first } = checkouts(t);
  const repo = realpathSync(join(main, ".git"));
  // A worktree removed through git: gone from disk and from `git worktree list`.
  const gone = join(root, "c", "gone");
  git(main, "worktree", "add", "-q", "-b", "gone", gone);
  const orphan = volume(gone);
  git(main, "worktree", "remove", "--force", gone);
  // A worktree git still knows whose folder is missing (an unmounted disk).
  const unmounted = join(root, "d", "unmounted");
  git(main, "worktree", "add", "-q", "-b", "unmounted", unmounted);
  const unmountedVolume = volume(unmounted);
  rmSync(unmounted, { recursive: true, force: true });
  const prefix = /^cadencr-linux-src-arm64-w\d+-/.exec(volume(first))[0];
  const labels = (checkout, ofRepo = repo) => ({
    "cadencr.checkout": checkout,
    "cadencr.repo": ofRepo,
  });
  const docker = fakeDocker(root, {
    [orphan]: labels(gone),
    [unmountedVolume]: labels(unmounted),
    [volume(first)]: labels(first),
    "cadencr-linux-src-arm64": labels(join(root, "absent-main")),
    [`${prefix}main-1`]: labels(main),
    [`${prefix}other-repo-1`]: labels(join(root, "absent"), join(root, "elsewhere/.git")),
    [`${prefix}unlabelled-1`]: {},
    "unrelated-project-volume": { "cadencr.checkout": join(root, "absent") },
  });
  const before = docker.volumes();

  const listed = run(main, ["prune", "--dry-run"], docker.env);
  assert.match(listed, new RegExp(`orphan ${orphan} `));
  assert.equal(listed.match(/orphan /g)?.length, 1, listed);
  assert.match(listed, /dry run, nothing removed/);
  assert.deepEqual(docker.volumes(), before);
  assert.ok(
    docker.calls().every((call) => /^volume (ls|inspect) /.test(call)),
    `a dry run only reads: ${docker.calls().join(" | ")}`,
  );

  const removed = run(first, ["prune"], docker.env);
  assert.match(removed, new RegExp(`removed ${orphan}$`, "m"));
  assert.deepEqual(
    docker.volumes(),
    before.filter((name) => name !== orphan),
  );
});

test("prune refuses arguments it does not know", (t) => {
  const { root, main } = checkouts(t);
  const docker = fakeDocker(root, {});
  const result = spawnSync(
    "bash",
    [join(main, "scripts/linux-container.sh"), "prune", "--force"],
    { encoding: "utf8", env: { ...process.env, BASH_ENV: "", CADENCR_LINUX_ARCH: "arm64", ...docker.env } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: .* prune \[--dry-run\]/);
  assert.deepEqual(docker.calls(), [""]);
});
