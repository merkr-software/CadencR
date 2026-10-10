import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import {
  isPlaceholderToken,
  portMismatches,
  setEnvValues,
  updateEnvFile,
  urlPort,
} from "./dev-env.mjs";
import { gitCheckout } from "./git-worktrees.mts";
import { copyMissingEnvFiles, planTokenSync, syncTokens } from "./setup-dev.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "cadencr-setup-dev-"));
  for (const pkg of ["service", "desktop"]) {
    mkdirSync(join(root, "packages", pkg), { recursive: true });
    const example = readFileSync(join(repoRoot, "packages", pkg, ".env.example"), "utf8");
    writeFileSync(join(root, "packages", pkg, ".env.example"), example);
  }
  return root;
}
const read = (root, pkg) => readFileSync(join(root, "packages", pkg, ".env"), "utf8");
const token = (root, pkg, key) => read(root, pkg).match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

test("the shipped .env.example tokens count as placeholders", () => {
  assert.ok(isPlaceholderToken("replace-with-a-random-local-token"));
  assert.ok(isPlaceholderToken("replace-with-the-same-local-token"));
  assert.ok(isPlaceholderToken(undefined));
  assert.ok(isPlaceholderToken("  "));
  assert.ok(!isPlaceholderToken("3f1c"));
});

test("token sync plans: generate, copy one way, keep, or refuse a mismatch", () => {
  const writes = (service, desktop, options) =>
    planTokenSync(service, desktop, { newToken: () => "new", ...options }).writes.map(
      ({ key, value }) => `${key}=${value}`,
    );
  assert.deepEqual(writes(undefined, "replace-with-x"), [
    "CADENCR_AUTH_TOKEN=new",
    "VITE_API_TOKEN=new",
  ]);
  assert.deepEqual(writes("abc", undefined), ["VITE_API_TOKEN=abc"]);
  assert.deepEqual(writes("", "def"), ["CADENCR_AUTH_TOKEN=def"]);
  assert.deepEqual(writes("abc", "abc"), []);
  assert.deepEqual(writes("abc", "abc", { fixToken: true }), []);
  assert.deepEqual(writes("abc", "def"), []);
  assert.equal(planTokenSync("abc", "def").ok, false);
  assert.deepEqual(writes("abc", "def", { fixToken: true }), ["VITE_API_TOKEN=abc"]);
});

test("setEnvValues rewrites in place, appends missing keys and keeps `$` literal", () => {
  const text = "# comment\nA=1\nB=2\n";
  assert.equal(setEnvValues(text, { B: "x$&y", C: "3" }), "# comment\nA=1\nB='x$&y'\nC=3\n");
});

test("setEnvValues quotes values a .env reader would otherwise cut or change", () => {
  for (const value of ["abc#def=ghi", "a b", 'say "hi"', "x$&y", "plain-123_./:@"]) {
    assert.equal(parseEnv(setEnvValues("", { K: value })).K, value, value);
  }
  assert.equal(setEnvValues("", { K: "abc#def" }), "\nK='abc#def'\n");
  assert.throws(() => setEnvValues("", { K: "it's" }), /unambiguously/);
});

test("setEnvValues removes a key given `undefined`, and ignores an absent one", () => {
  assert.equal(setEnvValues("A=1\nB=2\nC=3\n", { B: undefined }), "A=1\nC=3\n");
  assert.equal(setEnvValues("A=1\nB=2", { B: undefined, Z: undefined }), "A=1\n");
});

test("updateEnvFile rewrites one file in place", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-setup-dev-"));
  try {
    writeFileSync(join(root, ".env"), "# keep\nA=1\n");
    updateEnvFile(root, ".env", { A: 2, B: "x" });
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "# keep\nA=2\nB=x\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urlPort falls back to the scheme's default port", () => {
  assert.equal(urlPort("http://127.0.0.1:5005"), 5005);
  assert.equal(urlPort("http://localhost"), 80);
  assert.equal(urlPort("https://localhost/api"), 443);
  assert.equal(urlPort("nonsense"), null);
  assert.equal(urlPort(undefined), null);
});

test("port mismatches compare the renderer port and the service URL", () => {
  const service = { CADENCR_FRONTEND_PORT: "1420", CADENCR_RUST_PORT: "5005" };
  const good = { VITE_FRONTEND_PORT: "1420", VITE_API_URL: "http://127.0.0.1:5005" };
  assert.deepEqual(portMismatches(service, good), []);
  const bad = portMismatches(service, { VITE_FRONTEND_PORT: "1421", VITE_API_URL: "nonsense" });
  assert.equal(bad.length, 2);
  assert.match(bad[1], /VITE_API_URL=nonsense/);
});

test("a fresh checkout gets both .env files and one shared random token", () => {
  const root = checkout();
  try {
    assert.deepEqual(copyMissingEnvFiles(root), ["packages/service/.env", "packages/desktop/.env"]);
    const result = syncTokens(root, { newToken: () => "fresh-token" });
    assert.equal(result.ok, true);
    assert.equal(token(root, "service", "CADENCR_AUTH_TOKEN"), "fresh-token");
    assert.equal(token(root, "desktop", "VITE_API_TOKEN"), "fresh-token");
    // Comments and other settings from the example survive.
    assert.match(read(root, "service"), /^CADENCR_DB_PATH=\.\/cadencr\.local\.db$/m);
    assert.match(read(root, "service"), /^# Required for service dev/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rerunning is idempotent and never overwrites an existing .env", () => {
  const root = checkout();
  try {
    copyMissingEnvFiles(root);
    syncTokens(root, { newToken: () => "first" });
    const before = [read(root, "service"), read(root, "desktop")];
    assert.deepEqual(copyMissingEnvFiles(root), []);
    assert.equal(syncTokens(root, { newToken: () => "second" }).message, "tokens already match");
    assert.deepEqual([read(root, "service"), read(root, "desktop")], before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("differing real tokens are reported, and only --fix-token aligns them", () => {
  const root = checkout();
  try {
    copyMissingEnvFiles(root);
    writeFileSync(join(root, "packages/service/.env"), "CADENCR_AUTH_TOKEN=service\n");
    writeFileSync(join(root, "packages/desktop/.env"), "VITE_API_TOKEN=desktop\n");
    const refused = syncTokens(root);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /--fix-token/);
    assert.equal(token(root, "desktop", "VITE_API_TOKEN"), "desktop");
    assert.equal(syncTokens(root, { fixToken: true }).ok, true);
    assert.equal(token(root, "desktop", "VITE_API_TOKEN"), "service");
    assert.equal(token(root, "service", "CADENCR_AUTH_TOKEN"), "service");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup never creates a database file", () => {
  const root = checkout();
  try {
    copyMissingEnvFiles(root);
    syncTokens(root);
    assert.deepEqual(
      readdirSync(join(root, "packages/service")).filter((name) => name.includes(".db")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitCheckout tells the main checkout from a linked worktree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cadencr-setup-dev-git-")));
  const git = (cwd, ...args) => {
    const config = [
      "user.name=t",
      "user.email=t@t",
      "commit.gpgsign=false",
      "core.hooksPath=/dev/null",
    ];
    const result = spawnSync("git", [...config.flatMap((c) => ["-c", c]), ...args], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "--quiet");
    git(main, "commit", "--quiet", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "--quiet", "-b", "feature", join(root, "feature"));
    assert.deepEqual(gitCheckout(main), {
      gitDir: join(main, ".git"),
      commonDir: join(main, ".git"),
      linkedWorktree: false,
    });
    const linked = gitCheckout(join(root, "feature"));
    assert.equal(linked.commonDir, join(main, ".git"));
    assert.equal(linked.linkedWorktree, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
