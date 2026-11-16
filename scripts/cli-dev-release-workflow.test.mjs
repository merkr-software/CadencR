import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/cli-dev-release.yml", import.meta.url), "utf8"),
);
const sha = "a".repeat(40);
const version = "0.13.1-dev.123.2";
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
const steps = workflow.jobs.publish.steps;
const validation = steps.find(
  (step) => step.name === "Validate candidate without executing it",
).run;
const publication = steps.find((step) => step.name === "Publish new immutable CLI prerelease").run;
const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "cli-dev-release-test-"));
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
      workflow: ".github/workflows/cli-dev-release.yml",
      asset,
      sha256: digest,
    }),
  );
  return dir;
}
test("workflow separates build and publication privileges with exact-source checkout", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write" });
  assert.equal(workflow.jobs.build.runs_on ?? workflow.jobs.build["runs-on"], "ubuntu-24.04");
  const checkout = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(
    steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    false,
  );
  for (const step of workflow.jobs.build.steps.filter((step) => step.run?.includes("cargo ")))
    assert.equal(step.env?.GH_TOKEN, undefined);
  assert.equal(steps.filter((step) => step.env?.GH_TOKEN).length, 1);
  assert.match(publication, /--draft --prerelease --latest=false/);
  assert.match(publication, /--draft=false --prerelease --latest=false/);
  assert.doesNotMatch(publication, /--clobber|delete|force/);
});
test("candidate validation binds all fields and never executes the binary", () => {
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
});
test("publish refuses existing identity and API errors; draft verifies bytes before promotion", () => {
  for (const state of [
    "tag-exists",
    "release-exists",
    "api-error",
    "wrong-tip",
    "tag-race",
    "tamper-download",
    "ok",
  ]) {
    const dir = candidate();
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
        'release create '*) :;;
        'release view '*) echo "$SOURCE_COMMIT";;
        'release download '*) mkdir downloaded; cp candidate/* downloaded/; if [ "$STATE" = tamper-download ]; then echo tamper >> downloaded/provenance.json; fi;;
        'release edit '*) :;;
        *) echo unexpected >&2; exit 3;;
      esac`,
    );
    const result = run(publication, dir, {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      STATE: state,
    });
    const calls = readFileSync(join(dir, "calls"), "utf8");
    assert.equal(result.status === 0, state === "ok", `${state}: ${result.stderr}`);
    assert.equal(calls.includes("release edit"), state === "ok");
    if (["tag-exists", "release-exists", "api-error", "wrong-tip", "tag-race"].includes(state))
      assert.equal(calls.includes("release create"), false);
  }
});
test("whole gate and metadata helpers fail closed with mocked read-only git and GitHub", () => {
  const helper = resolve("scripts/cli-dev-release.mts");
  const dir = temporary();
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "packages/cli"), { recursive: true });
  mkdirSync(join(dir, "dist-cli"));
  writeFileSync(join(dir, "packages/cli/Cargo.toml"), '[package]\nversion = "0.13.1"\n');
  command(join(dir, "bin", "git"), 'echo "$TIP"');
  command(
    join(dir, "bin", "gh"),
    `printf '%s\n' "$1" "$2" "$3" "$4" > gh-args
     if [ "$API_ERROR" = yes ]; then exit 1; fi; printf "%s" "$API_RESPONSE"`,
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
  assert.equal(spawnSync(process.execPath, [helper, "gate"], options).status, 0);
  assert.equal(readFileSync(join(dir, "output"), "utf8"), `version=${version}\ntag=${tag}\n`);
  const args = readFileSync(join(dir, "gh-args"), "utf8");
  assert.ok(
    args.startsWith(
      `api\nrepos/merkr-software/CadencR/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100\n--jq\n`,
    ),
  );
  assert.match(args, /head_sha == "a{40}"/);
  assert.match(args, /head_branch == "main"/);
  assert.match(args, /event == "push"/);
  assert.match(args, /repository.full_name == "merkr-software\/CadencR"/);
  assert.match(args, /all\(\.status == "completed" and \.conclusion == "success"\)/);

  cpSync(join(candidate(), "candidate", asset), join(dir, "dist-cli", asset));
  assert.equal(spawnSync(process.execPath, [helper, "metadata"], options).status, 0);
  assert.match(
    readFileSync(join(dir, "dist-cli/released-cli.env"), "utf8"),
    /CADENCR_RELEASE_SHA256=[a-f0-9]{64}\n$/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, "dist-cli/provenance.json"), "utf8")).source_commit,
    sha,
  );
  assert.notEqual(spawnSync(process.execPath, [helper, "metadata"], options).status, 0);
  for (const patch of [
    { TIP: "wrong" },
    { API_ERROR: "yes" },
    { API_RESPONSE: "false\n" },
    { API_RESPONSE: "true" },
    { API_RESPONSE: "true\nnoise" },
    { API_RESPONSE: " true\n" },
    { API_RESPONSE: '{"workflow_runs":[null]}' },
    { API_RESPONSE: '{"workflow_runs":[]}' },
  ]) {
    assert.notEqual(
      spawnSync(process.execPath, [helper, "gate"], {
        ...options,
        env: { ...options.env, ...patch },
      }).status,
      0,
    );
  }
});
