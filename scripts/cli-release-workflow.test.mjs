import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = read(".github/workflows/cli-release.yml");
const workflow = parse(text);
const sha = "a".repeat(40);
const version = "0.14.0";
const tag = `cli/v${version}`;
const asset = `cadencr-v${version}-x86_64-unknown-linux-gnu`;
const sums = `cadencr-v${version}-SHA256SUMS`;
const env = {
  ...process.env,
  BASH_ENV: undefined,
  ENV: undefined,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "merkr-software/CadencR",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  SOURCE_COMMIT: sha,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  VERSION: version,
  TAG: tag,
  GH_REPO: "merkr-software/CadencR",
};
const { build, publish } = workflow.jobs;
const step = (job, name) => job.steps.find((candidate) => candidate.name === name).run;
const validation = step(publish, "Validate candidate without executing it");
const publication = step(publish, "Publish new immutable CLI release, never latest");
const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "cli-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
function command(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}
function run(script, cwd, extra = {}) {
  return spawnSync("bash", ["-e", "-c", script], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
}
function candidate() {
  const dir = temporary();
  mkdirSync(join(dir, "candidate"));
  const binary = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(binary);
  binary[18] = 0x3e;
  const digest = createHash("sha256").update(binary).digest("hex");
  writeFileSync(join(dir, "candidate", asset), binary);
  writeFileSync(join(dir, "candidate", sums), `${digest}  ${asset}\n`);
  writeFileSync(
    join(dir, "candidate", "released-cli.env"),
    `CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_TAG=${tag}\nCADENCR_RELEASE_SHA256=${digest}\n`,
  );
  writeFileSync(
    join(dir, "candidate", "provenance.json"),
    JSON.stringify({
      repository: env.GITHUB_REPOSITORY,
      source_commit: sha,
      version,
      tag,
      run_id: "123",
      run_attempt: "2",
      workflow: ".github/workflows/cli-release.yml",
      asset,
      sha256: digest,
    }),
  );
  return dir;
}

test("manual dispatch from main only, dry-run by default, protected publication", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const { inputs } = workflow.on.workflow_dispatch;
  assert.equal(inputs.source_commit.required, true);
  assert.equal(inputs.dry_run.default, true);
  assert.equal(inputs.dry_run.type, "boolean");
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.match(build.if, /github\.repository == 'merkr-software\/CadencR'/);
  assert.match(build.if, /github\.ref == 'refs\/heads\/main'/);
  assert.equal(publish.needs, "build");
  assert.match(publish.if, /!inputs\.dry_run/);
  assert.match(publish.if, /github\.ref == 'refs\/heads\/main'/);
  assert.equal(publish.environment, "cli-release");
  assert.deepEqual(publish.permissions, { contents: "write" });
  assert.equal(build.permissions, undefined, "the build job keeps the read-only default");
  assert.doesNotMatch(text, /secrets\./);
});

test("build reuses the reviewed-main-tip gate and today's Linux packaging", () => {
  const checkout = build.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const runs = build.steps.map((s) => s.run ?? "").join("\n");
  assert.match(runs, /git fetch --no-tags https:\/\/github.com\/merkr-software\/CadencR.git main/);
  assert.match(runs, /node scripts\/cli-release\.mts gate/);
  assert.match(runs, /cargo test --locked -p cadencr-cli/);
  assert.match(
    runs,
    /cargo build --locked --release -p cadencr-cli --target x86_64-unknown-linux-gnu/,
  );
  assert.match(runs, /bash scripts\/package-cli-release\.sh "v\$VERSION" x86_64-unknown-linux-gnu/);
  assert.match(runs, /node scripts\/cli-release\.mts metadata/);
  assert.doesNotMatch(runs, /CADENCR_CLI_RELEASE_VERSION/, "stable builds report the manifest");
  for (const s of build.steps.filter((s) => s.run?.includes("cargo "))) {
    assert.equal(s.env?.GH_TOKEN, undefined);
  }
});

test("publication never checks out code and never becomes the latest release", () => {
  assert.equal(
    publish.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    false,
  );
  assert.equal(publish.steps.filter((s) => s.env?.GH_TOKEN).length, 1);
  assert.match(publication, /gh release create "\$TAG"[^\n]*\\\n[^\n]*--draft --latest=false/);
  assert.match(publication, /--draft=false --prerelease=false --latest=false/);
  assert.doesNotMatch(publication, /--latest(?!=false)/);
  assert.doesNotMatch(publication, /--prerelease(?!=false)/);
  assert.doesNotMatch(publication, /--clobber|delete|force/);
});

test("candidate validation binds all fields, refuses dev versions and never executes", () => {
  assert.equal(run(validation, candidate()).status, 0);
  for (const mutation of [
    (dir) => writeFileSync(join(dir, "candidate", "extra"), ""),
    (dir) => writeFileSync(join(dir, "candidate", sums), "corrupt"),
    (dir) => writeFileSync(join(dir, "candidate", "released-cli.env"), "corrupt"),
    (dir) => writeFileSync(join(dir, "candidate", "provenance.json"), "{}"),
    (dir) => writeFileSync(join(dir, "candidate", asset), "#!/bin/sh\ntouch executed\n"),
  ]) {
    const dir = candidate();
    mutation(dir);
    assert.notEqual(run(validation, dir).status, 0);
  }
  assert.notEqual(run(validation, candidate(), { GITHUB_RUN_ATTEMPT: "3" }).status, 0);
  assert.notEqual(run(validation, candidate(), { SOURCE_COMMIT: "b".repeat(40) }).status, 0);
  assert.notEqual(run(validation, candidate(), { TAG: `v${version}` }).status, 0);
  const dev = "0.14.0-dev.123.2";
  assert.notEqual(run(validation, candidate(), { VERSION: dev, TAG: `cli/v${dev}` }).status, 0);
});

function publicationStub(dir) {
  mkdirSync(join(dir, "bin"));
  command(
    join(dir, "bin", "gh"),
    `
    echo "$*" >> calls
    case "$*" in
      'api --include '*git/ref/tags*)
        if [ "$STATE" = tag-exists ]; then exit 0; fi
        if [ "$STATE" = api-error ]; then echo 'HTTP 500' >&2; exit 1; fi
        echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
      'api --include '*releases/tags*)
        if [ "$STATE" = release-exists ]; then exit 0; fi
        echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
      'api '*git/ref/heads/main*)
        if [ "$STATE" = wrong-tip ]; then echo wrong; else echo "$SOURCE_COMMIT"; fi;;
      'api --method POST '*git/refs*) if [ "$STATE" = tag-race ]; then exit 1; fi; echo tag-created > tag-created;;
      'api '*git/ref/tags*) test -f tag-created || exit 1; echo "$SOURCE_COMMIT";;
      'api '*releases/latest*) if [ "$STATE" = became-latest ]; then echo "$TAG"; else echo v0.14.0; fi;;
      'release create '*) :;;
      'release view '*) echo "$SOURCE_COMMIT";;
      'release download '*) mkdir downloaded; cp candidate/* downloaded/; if [ "$STATE" = tamper-download ]; then echo tamper >> downloaded/provenance.json; fi;;
      'release edit '*) :;;
      *) echo unexpected >&2; exit 3;;
    esac`,
  );
}

test("publish refuses existing identity and API errors; verifies bytes and latest", () => {
  for (const state of [
    "tag-exists",
    "release-exists",
    "api-error",
    "wrong-tip",
    "tag-race",
    "tamper-download",
    "became-latest",
    "ok",
  ]) {
    const dir = candidate();
    publicationStub(dir);
    const result = run(publication, dir, {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      STATE: state,
    });
    const calls = readFileSync(join(dir, "calls"), "utf8");
    assert.equal(result.status === 0, state === "ok", `${state}: ${result.stderr}`);
    assert.equal(calls.includes("release edit"), ["ok", "became-latest"].includes(state));
    if (["tag-exists", "release-exists", "api-error", "wrong-tip", "tag-race"].includes(state))
      assert.equal(calls.includes("release create"), false);
    if (state === "ok") assert.match(result.stdout, /the latest release is still v0\.14\.0/);
  }
});

function helperFixture() {
  const dir = temporary();
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "packages/cli"), { recursive: true });
  mkdirSync(join(dir, "dist-cli"));
  writeFileSync(join(dir, "packages/cli/Cargo.toml"), `[package]\nversion = "${version}"\n`);
  writeFileSync(join(dir, "packages/cli/package.json"), JSON.stringify({ version }));
  command(join(dir, "bin", "git"), 'echo "$TIP"');
  command(
    join(dir, "bin", "gh"),
    `case "$2" in
       --include) printf '%s\\n' "$3" >> existence-checks
         if [ "$EXISTING" = "$3" ]; then exit 0; fi
         if [ "$API_ERROR" = existence ]; then echo 'HTTP 502' >&2; exit 1; fi
         echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
       *) printf '%s\\n' "$2" > ci-args
         if [ "$API_ERROR" = ci ]; then exit 1; fi; printf "%s" "$API_RESPONSE";;
     esac`,
  );
  const options = {
    cwd: dir,
    env: {
      ...env,
      TIP: sha,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      API_RESPONSE: "true\n",
      GITHUB_OUTPUT: join(dir, "output"),
    },
    encoding: "utf8",
  };
  return { dir, options };
}

test("gate and metadata helpers fail closed on context, CI, versions and existing tags", () => {
  const helper = resolve("scripts/cli-release.mts");
  const { dir, options } = helperFixture();
  const node = (mode, patch = {}) =>
    spawnSync(process.execPath, [helper, mode], { ...options, env: { ...options.env, ...patch } });
  const gated = node("gate");
  assert.equal(gated.status, 0, gated.stderr);
  assert.equal(readFileSync(join(dir, "output"), "utf8"), `version=${version}\ntag=${tag}\n`);
  assert.match(
    readFileSync(join(dir, "ci-args"), "utf8"),
    /ci\.yml\/runs\?head_sha=a{40}&event=push/,
  );
  assert.deepEqual(
    readFileSync(join(dir, "existence-checks"), "utf8").trim().split("\n").slice(0, 2),
    [
      `repos/merkr-software/CadencR/git/ref/tags/${tag}`,
      `repos/merkr-software/CadencR/releases/tags/${tag}`,
    ],
  );
  cpSync(join(candidate(), "candidate", asset), join(dir, "dist-cli", asset));
  assert.equal(node("metadata").status, 0);
  assert.match(
    readFileSync(join(dir, "dist-cli/released-cli.env"), "utf8"),
    new RegExp(
      `^CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_TAG=cli/v${version}\nCADENCR_RELEASE_SHA256=[a-f0-9]{64}\n$`,
    ),
  );
  const provenance = JSON.parse(readFileSync(join(dir, "dist-cli/provenance.json"), "utf8"));
  assert.equal(provenance.workflow, ".github/workflows/cli-release.yml");
  assert.equal(provenance.source_commit, sha);
  assert.notEqual(node("metadata").status, 0, "metadata is never overwritten");
  for (const patch of [
    { TIP: "wrong" },
    { GITHUB_REF: "refs/heads/feature" },
    { API_ERROR: "ci" },
    { API_RESPONSE: "false\n" },
    { API_ERROR: "existence" },
    { EXISTING: `repos/merkr-software/CadencR/git/ref/tags/${tag}` },
    { EXISTING: `repos/merkr-software/CadencR/releases/tags/${tag}` },
  ]) {
    assert.notEqual(node("gate", patch).status, 0, JSON.stringify(patch));
  }
  writeFileSync(join(dir, "packages/cli/package.json"), JSON.stringify({ version: "0.14.1" }));
  assert.notEqual(node("gate").status, 0, "manifests must agree");
});

test("CLI, npm and crate tag namespaces never trigger the desktop release", () => {
  const desktop = parse(read(".github/workflows/desktop-release.yml"));
  assert.deepEqual(desktop.on.push.tags, ["v*"]);
  for (const independent of [tag, "tab-sdk-v0.1.0", "cadencr-tab-backend-v0.1.0"]) {
    assert.equal(independent.startsWith("v"), false, independent);
    assert.equal(spawnSync("git", ["check-ref-format", `refs/tags/${independent}`]).status, 0);
  }
});
