import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const exampleUrl = new URL("../examples/workflows/publish-protected-catalog.yml", import.meta.url);
const activeUrl = new URL("../.github/workflows/publish-protected-catalog.yml", import.meta.url);
const hasExample = existsSync(exampleUrl);
const source = readFileSync(hasExample ? exampleUrl : activeUrl, "utf8");
// The key lifecycle is one implementation shared with the renewal workflow.
const feedsScript = new URL("../scripts/ci/registry-feeds.sh", import.meta.url);
const feeds = readFileSync(feedsScript, "utf8");
const publisherPrefix = "marketplace-publisher-secret-";

test("exported protected workflow remains an inert example", () => {
  if (hasExample)
    assert.equal(
      existsSync(activeUrl),
      false,
      "protected workflow must not be activated by export",
    );
});

const occurrences = (pattern) => [...source.matchAll(pattern)].length;

function inlineNodeScript(stepName) {
  const start = source.indexOf(`      - name: ${stepName}`);
  const end = source.indexOf("\n      - name:", start + 1);
  const step = source.slice(start, end < 0 ? undefined : end);
  const match = step.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(match, `missing inline Node script for ${stepName}`);
  return match[1].replace(/^ {10}/gm, "");
}

function runInline(stepName, env) {
  return spawnSync(process.execPath, ["-e", inlineNodeScript(stepName)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runKeyHelper(mode, env, prefix = publisherPrefix) {
  return spawnSync("sh", [feedsScript.pathname, mode, prefix], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("publisher is a manually dispatched, default-branch-only protected workflow", () => {
  assert.match(source, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(source, /^  (pull_request|push|workflow_run):/m);
  assert.match(
    source,
    /confirm-request-sha256:\n        description:[^\n]+\n        required: true/,
  );
  assert.match(source, /^permissions:\n  contents: read$/m);
  assert.match(
    source,
    /^concurrency:\n  group: marketplace-publication\n  cancel-in-progress: false$/m,
  );
  assert.equal(
    occurrences(
      /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/g,
    ),
    2,
  );
  assert.match(source, /environment: protected-marketplace-publisher/);
  assert.match(source, /required\n    # external reviewers/);
});

test("both jobs checkout only the dispatched commit without credentials", () => {
  assert.equal(occurrences(/uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/g), 2);
  assert.equal(occurrences(/ref: \$\{\{ github\.sha \}\}/g), 2);
  assert.equal(occurrences(/persist-credentials: false/g), 2);
  assert.doesNotMatch(source, /github\.event\.pull_request|head\.sha|checkout@(?:main|master)/);
});

test("digest preflight is bounded and precedes every privileged operation", () => {
  const preflight = source.indexOf("jobs:\n  preflight:");
  const protectedJob = source.indexOf("\n  publish:");
  const secret = source.indexOf("secrets.CADENCR_REGISTRY_PRIVATE_KEY_PEM");
  const token = source.indexOf("secrets.CADENCR_REGISTRY_GITHUB_TOKEN");
  assert.ok(preflight >= 0 && protectedJob > preflight);
  assert.ok(
    source.indexOf("reviewed publication request digest mismatch", preflight) < protectedJob,
  );
  assert.ok(source.indexOf("metadata.size > 1024 * 1024", preflight) < protectedJob);
  assert.ok(source.indexOf("metadata.isSymbolicLink()", preflight) < protectedJob);
  assert.ok(secret > protectedJob && token > secret);
  assert.equal(occurrences(/secrets\.CADENCR_REGISTRY_GITHUB_TOKEN/g), 1);
  assert.equal(occurrences(/secrets\.CADENCR_REGISTRY_PRIVATE_KEY_PEM/g), 1);
});

test("privileged command uses repository-bound environment values and reviewed config", () => {
  const command = inlineNodeScript("Publish reviewed registry request");
  assert.match(command, /\["registry", "publish-registry"\]/);
  for (const argument of [
    "request",
    "directory",
    "repository",
    "registry-commit",
    "private-key",
    "confirm-request-sha256",
  ])
    assert.ok(command.includes(`"--${argument}"`));
  assert.match(command, /spawnSync\(command, \[\.\.\.prefix, \.\.\.args\]/);
  assert.doesNotMatch(
    source,
    /scripts\/publish-registry\.mjs|mode === "legacy"|--public-key|npm (?:install|ci|test)|pnpm|yarn/,
  );
  assert.doesNotMatch(source, /\$\{\{ inputs\.confirm-request-sha256 \}\}[^\n]*--/);
});

test("private key stays outside recoverable state and is cleaned on every outcome", () => {
  assert.match(feeds, /writeFileSync\(file, key, \{ flag: "wx", mode: 0o600 \}\)/);
  assert.match(feeds, /Buffer\.byteLength\(key, "utf8"\) > 16 \* 1024/);
  assert.match(
    feeds,
    /appendFileSync\(process\.env\.GITHUB_OUTPUT, `private_key_file=\$\{file\}\\n`\)/,
  );
  assert.match(feeds, /unlinkSync\(file\)/);
  // Both steps call the shared implementation with this workflow's own prefix.
  assert.match(
    source,
    /name: Materialize protected signing key\n(?:.*\n)*?        run: sh scripts\/ci\/registry-feeds\.sh materialize-key marketplace-publisher-secret-\n/,
  );
  assert.match(
    source,
    /name: Remove materialized signing key\n        if: \$\{\{ always\(\) && steps\.materialize_key\.outputs\.private_key_file != '' \}\}/,
  );
  assert.match(
    source,
    /run: sh scripts\/ci\/registry-feeds\.sh remove-key marketplace-publisher-secret-\n/,
  );
  assert.doesNotMatch(source, /unlinkSync|writeFileSync\(file, key|mkdtempSync/);
  assert.doesNotMatch(source, /path:.*private\.pem/);
  assert.doesNotMatch(source, /upload-artifact|include-hidden-files/);
});

test("materialization and cleanup scripts enforce owned private key lifecycle at runtime", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publisher-workflow-test-"));
  const output = path.join(root, "github-output");
  writeFileSync(output, "");
  const created = runKeyHelper("materialize-key", {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "test-private-key",
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: output,
  });
  assert.equal(created.status, 0, created.stderr);
  const file = readFileSync(output, "utf8").trim().slice("private_key_file=".length);
  assert.equal(path.basename(path.dirname(file)).startsWith(publisherPrefix), true);
  assert.equal(readFileSync(file, "utf8"), "test-private-key");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // A directory owned by the other workflow's prefix is not this workflow's to clean.
  const otherOwned = runKeyHelper(
    "remove-key",
    { PRIVATE_KEY_FILE: file, PRIVATE_KEY_ROOT: root },
    "marketplace-renewal-secret-",
  );
  assert.notEqual(otherOwned.status, 0);
  assert.equal(readFileSync(file, "utf8"), "test-private-key");

  const cleaned = runKeyHelper("remove-key", { PRIVATE_KEY_FILE: file, PRIVATE_KEY_ROOT: root });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.throws(() => statSync(file), { code: "ENOENT" });

  const foreign = path.join(root, "private.pem");
  writeFileSync(foreign, "operator-owned");
  const refused = runKeyHelper("remove-key", {
    PRIVATE_KEY_FILE: foreign,
    PRIVATE_KEY_ROOT: root,
  });
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(foreign, "utf8"), "operator-owned");

  const external = mkdtempSync(path.join(os.tmpdir(), "publisher-workflow-external-"));
  const externalKey = path.join(external, "private.pem");
  writeFileSync(externalKey, "foreign-through-parent");
  const linkedParent = path.join(root, "marketplace-publisher-secret-linked");
  symlinkSync(external, linkedParent, "dir");
  const refusedParent = runKeyHelper("remove-key", {
    PRIVATE_KEY_FILE: path.join(linkedParent, "private.pem"),
    PRIVATE_KEY_ROOT: root,
  });
  assert.notEqual(refusedParent.status, 0);
  assert.equal(readFileSync(externalKey, "utf8"), "foreign-through-parent");

  const oversizedOutput = path.join(root, "oversized-output");
  writeFileSync(oversizedOutput, "");
  const oversized = runKeyHelper("materialize-key", {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "x".repeat(16 * 1024 + 1),
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: oversizedOutput,
  });
  assert.notEqual(oversized.status, 0);
  assert.equal(readFileSync(oversizedOutput, "utf8"), "");

  const badPrefix = runKeyHelper(
    "materialize-key",
    {
      CADENCR_REGISTRY_PRIVATE_KEY_PEM: "k",
      PRIVATE_KEY_ROOT: root,
      GITHUB_OUTPUT: oversizedOutput,
    },
    "../escape-",
  );
  assert.notEqual(badPrefix.status, 0);
  assert.equal(readFileSync(oversizedOutput, "utf8"), "");
});

test("raw recovery state is never uploaded or restored", () => {
  assert.match(source, /timeout-minutes: 45/);
  assert.doesNotMatch(source, /actions\/(?:upload|download)-artifact/);
  assert.match(source, /Fresh runners reconstruct published provider state only after tag/);
});

test("each runner selects a verified runtime before state and secrets", () => {
  assert.equal(occurrences(/name: Select verified publisher runtime/g), 2);
  const publish = source.slice(source.indexOf("\n  publish:"));
  assert.ok(
    publish.indexOf("Select verified publisher runtime") < publish.indexOf("Create bounded"),
  );
  assert.ok(publish.indexOf("Select verified publisher runtime") < publish.indexOf("secrets."));
  assert.equal(occurrences(/run: sh scripts\/ci\/select-publisher-runtime.sh/g), 2);
  assert.equal(occurrences(/node-version: 22.19.0/g), 2);
  assert.doesNotMatch(source.slice(0, source.indexOf("\n  publish:")), /secrets\./);
  for (const action of source.matchAll(/uses: ([^\n ]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
});

function fixtureSelection(t, body) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "publisher-selection-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "scripts", "ci"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts", "ci", "fetch-released-cli.sh"), body);
  const root = path.join(cwd, "verified");
  const output = path.join(cwd, "output");
  writeFileSync(output, "");
  const result = spawnSync(
    "sh",
    [new URL("../scripts/ci/select-publisher-runtime.sh", import.meta.url).pathname],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLI_ROOT: root, GITHUB_OUTPUT: output },
    },
  );
  return { result, output: readFileSync(output, "utf8"), root };
}

test("PENDING, malformed pins and verification failures fail closed", (t) => {
  const pending = fixtureSelection(t, "exit 3\n");
  assert.notEqual(pending.result.status, 0);
  assert.equal(pending.output, "");
  for (const body of ["exit 2\n", "exit 1\n", "printf injected; exit 3\n", "exit 0\n"]) {
    const failed = fixtureSelection(t, body);
    assert.notEqual(failed.result.status, 0);
    assert.equal(failed.output, "");
  }
});

test("verified CLI output must name exactly one owned executable, without output injection", (t) => {
  const body =
    'mkdir "$2"\nprintf "#!/bin/sh\\nexit 0\\n" > "$2/cadencr"\nchmod 700 "$2/cadencr"\nprintf "%s/cadencr\\n" "$2"\n';
  const verified = fixtureSelection(t, body);
  assert.equal(verified.result.status, 0, verified.result.stderr);
  assert.equal(verified.output, `cli_file=${verified.root}/cadencr\n`);
  for (const suffix of ['printf "mode=legacy\\n"\n', 'printf "extra"\n']) {
    const injected = fixtureSelection(t, body + suffix);
    assert.notEqual(injected.result.status, 0);
    assert.equal(injected.output, "");
  }
});

test("released invocation preserves all six argument values without shell evaluation", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publisher-invocation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "cadencr");
  const output = path.join(root, "arguments");
  writeFileSync(
    binary,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.ARGS_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(binary, 0o700);
  const digest = "$(touch injected);\nmode=legacy";
  const result = runInline("Publish reviewed registry request", {
    PUBLISHER_MODE: "released",
    VERIFIED_CLI: binary,
    RUNNER_TEMP: root,
    GITHUB_REPOSITORY: "owner/registry",
    GITHUB_SHA: "a".repeat(40),
    PRIVATE_KEY_FILE: "/separate/key.pem",
    CONFIRM_REQUEST_SHA256: digest,
    ARGS_OUTPUT: output,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [
    "registry",
    "publish-registry",
    "--request",
    "publication-request.json",
    "--directory",
    path.join(root, "marketplace-publication-state"),
    "--repository",
    "owner/registry",
    "--registry-commit",
    "a".repeat(40),
    "--private-key",
    "/separate/key.pem",
    "--confirm-request-sha256",
    digest,
  ]);
});

test("a verified older CLI lacking publication orchestration fails before secrets", (t) => {
  const failed = fixtureSelection(
    t,
    'mkdir "$2"\nprintf "#!/bin/sh\\nexit 1\\n" > "$2/cadencr"\nchmod 700 "$2/cadencr"\nprintf "%s/cadencr\\n" "$2"\n',
  );
  assert.notEqual(failed.result.status, 0);
  assert.equal(failed.output, "");
  assert.match(failed.result.stderr, /lacks registry publisher command/);
});

test("selector preserves helper diagnostics without permitting fallback", (t) => {
  const failed = fixtureSelection(t, 'printf "released CLI checksum mismatch\\n" >&2; exit 1\n');
  assert.notEqual(failed.result.status, 0);
  assert.equal(failed.output, "");
  assert.match(failed.result.stderr, /released CLI checksum mismatch/);
});

test("selector binds the same committed pin and owned destination", (t) => {
  const pending = fixtureSelection(
    t,
    '[ "$1" = "ci/released-cli.env" ] || exit 2\ncase "$2" in /*/verified) ;; *) exit 2 ;; esac\nexit 3\n',
  );
  assert.notEqual(pending.result.status, 0);
  assert.equal(pending.output, "");
});

// The registry repository allows only these exact action pins (Settings →
// Actions → "Allow select actions", SHA pinning required). A workflow using any
// other action is refused at dispatch, so every deployed workflow must stay
// inside this list. prepare-protected-publication is not deployed: its unsigned
// index upload needs actions/upload-artifact, which the registry does not allow.
test("deployed workflows use only the registry's allowed action pins", () => {
  const allowed = new Set([
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  ]);
  const directory = new URL("../.github/workflows/", import.meta.url);
  for (const name of [
    "validate-provider-metadata.yml",
    "publish-protected-catalog.yml",
    "bootstrap-revocation-policies.yml",
    "renew-protected-catalog.yml",
    "watch-registry-expiry.yml",
  ]) {
    const uses = [...readFileSync(new URL(name, directory), "utf8").matchAll(/uses:\s*(\S+)/g)];
    assert.ok(uses.length > 0, name);
    for (const [, action] of uses) assert.ok(allowed.has(action), `${name}: ${action}`);
  }
});
