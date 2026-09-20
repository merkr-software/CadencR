import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/validate-provider-metadata.yml", import.meta.url);

const readWorkflow = () => readFile(workflowUrl, "utf8");

const jobSections = (workflow) => {
  const toolingStart = workflow.indexOf("  contributor-tooling:");
  assert.notEqual(toolingStart, -1, "contributor-tooling job must exist");
  return {
    inert: workflow.slice(0, toolingStart),
    tooling: workflow.slice(toolingStart),
  };
};

test("PR validation runs trusted base tooling against separately checked-out candidate metadata", async () => {
  const workflow = await readWorkflow();
  const { inert } = jobSections(workflow);

  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.base\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /path: trusted-registry/);
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: candidate-registry/);
  assert.match(
    inert,
    /sh trusted-registry\/scripts\/ci\/validate-provider-contribution\.sh\s+trusted-registry\/ci\/released-cli\.env\s+trusted-registry\s+candidate-registry\s+validate/,
  );
  assert.doesNotMatch(inert, /candidate-registry\/scripts\/|npm (?:test|run)/);
});

test("PR validation stays read-only and does not acquire credentials or privileged triggers", async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 4);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|workflow_dispatch/);
  assert.doesNotMatch(workflow, /secrets\.|contents:\s*write|id-token:\s*write/);
  const { inert } = jobSections(workflow);
  assert.doesNotMatch(inert, /download-artifact|curl|wget|npm\s+(?:ci|install)|pnpm|yarn/);
});

test("released CLI pin is wholly pending or exact and cannot supply a URL", async () => {
  const config = await readFile(new URL("../ci/released-cli.env", import.meta.url), "utf8");
  const version = config.match(/^CADENCR_RELEASE_VERSION=(\S+)$/m)?.[1];
  const digest = config.match(/^CADENCR_RELEASE_SHA256=(\S+)$/m)?.[1];
  assert.ok(
    (version === "PENDING" && digest === "PENDING") ||
      (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "") &&
        /^[0-9a-f]{64}$/.test(digest ?? "")),
    "release pin must be wholly pending or wholly provisioned",
  );
  assert.doesNotMatch(config, /URL|latest/);
});

test("released CLI bytes are verified before the offline fixture is executed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-cli-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = path.join(directory, "tools");
  await mkdir(tools);
  const marker = path.join(directory, "invocation.txt");
  const bytes = Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 'cadencr 1.2.3'\n  exit 0\nfi\nprintf '%s\\n' "$@" > '${marker}'\n`,
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const binary = path.join(directory, "fixture-cadencr");
  const pin = path.join(directory, "pin.env");
  await writeFile(binary, bytes, { mode: 0o700 });
  await writeFile(pin, `CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=${sha256}\n`);
  const requestedUrl = path.join(directory, "requested-url.txt");
  await writeFile(
    path.join(tools, "curl"),
    `#!/bin/sh\nout=''\nheaders=''\nlast=''\nwhile [ "$#" -gt 0 ]; do\n  last=$1\n  case "$1" in\n    --output) out=$2; shift 2 ;;\n    --dump-header) headers=$2; shift 2 ;;\n    *) shift ;;\n  esac\ndone\nprintf '%s' "$last" > '${requestedUrl}'\nif [ "\${FIXTURE_REDIRECT:-}" = 1 ] && [ ! -e '${path.join(directory, "redirected")}' ]; then\n  touch '${path.join(directory, "redirected")}'\n  printf 'Location: https://release-assets.githubusercontent.com/fixture/cadencr\\r\\n' > "$headers"\n  printf 302\n  exit 0\nfi\ncp "\${FIXTURE_BINARY:-${binary}}" "$out"\nprintf 200\n`,
    { mode: 0o700 },
  );
  await writeFile(path.join(tools, "sha256sum"), '#!/bin/sh\nshasum -a 256 "$1"\n', {
    mode: 0o700,
  });
  await writeFile(
    path.join(tools, "date"),
    "#!/bin/sh\ncase \"$*\" in *'+7 days'*) echo 2026-01-08T00:00:00Z ;; *) echo 2026-01-01T00:00:00Z ;; esac\n",
    { mode: 0o700 },
  );
  await writeFile(
    path.join(tools, "npm"),
    `#!/bin/sh\necho npm-ran > '${path.join(directory, "npm-ran")}'\nexit 99\n`,
    { mode: 0o700 },
  );
  const script = new URL("../scripts/ci/validate-provider-contribution.sh", import.meta.url);
  const run = (pinPath, environment = {}) =>
    spawnSync(
      "/bin/sh",
      [script.pathname, pinPath, "/trusted/base", "/candidate/metadata", "validate"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          ...environment,
        },
      },
    );
  const valid = run(pin);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    await readFile(requestedUrl, "utf8"),
    "https://github.com/merkr-software/CadencR/releases/download/v1.2.3/cadencr-v1.2.3-x86_64-unknown-linux-gnu",
  );
  assert.equal(
    await readFile(marker, "utf8"),
    "registry\nvalidate\n--base\n/trusted/base\n--candidate\n/candidate/metadata\n",
  );
  await rm(marker);
  await rm(requestedUrl);

  const redirected = run(pin, { FIXTURE_REDIRECT: "1" });
  assert.equal(redirected.status, 0, redirected.stderr);
  assert.equal(
    await readFile(requestedUrl, "utf8"),
    "https://release-assets.githubusercontent.com/fixture/cadencr",
  );
  await rm(marker);
  await rm(requestedUrl);

  const wrongVersionBinary = path.join(directory, "wrong-version-cadencr");
  const wrongVersionBytes = Buffer.from(
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'cadencr 9.9.9\'; exit 0; fi\nexit 99\n',
  );
  await writeFile(wrongVersionBinary, wrongVersionBytes, { mode: 0o700 });
  const wrongVersionPin = path.join(directory, "wrong-version-pin.env");
  await writeFile(
    wrongVersionPin,
    `CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=${createHash("sha256").update(wrongVersionBytes).digest("hex")}\n`,
  );
  const wrongVersion = run(wrongVersionPin, { FIXTURE_BINARY: wrongVersionBinary });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /version mismatch/);
  await assert.rejects(readFile(marker), /ENOENT/);
  await rm(requestedUrl);

  const populatedCandidate = path.join(directory, "populated-candidate");
  await mkdir(path.join(populatedCandidate, "packages"), { recursive: true });
  await writeFile(path.join(populatedCandidate, "packages/provider.json"), "{}");
  const tooling = spawnSync(
    "/bin/sh",
    [script.pathname, pin, "/trusted/base", populatedCandidate, "tooling"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, RUNNER_TEMP: directory },
    },
  );
  assert.equal(tooling.status, 0, tooling.stderr);
  assert.equal(
    await readFile(marker, "utf8"),
    `registry\nbuild-index\n--packages\n${populatedCandidate}/packages\n--generated-at\n2026-01-01T00:00:00Z\n--expires-at\n2026-01-08T00:00:00Z\n--output\n${directory}/managed-index.json\n`,
  );
  await assert.rejects(readFile(path.join(directory, "npm-ran")), /ENOENT/);
  await rm(marker);
  await rm(requestedUrl);

  const emptyCandidate = path.join(directory, "empty-candidate");
  await mkdir(path.join(emptyCandidate, "packages"), { recursive: true });
  const emptyTooling = spawnSync(
    "/bin/sh",
    [script.pathname, pin, "/trusted/base", emptyCandidate, "tooling"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, RUNNER_TEMP: directory },
    },
  );
  assert.equal(emptyTooling.status, 0, emptyTooling.stderr);
  assert.match(emptyTooling.stdout, /No publishable package JSON; skipping index assembly/);
  assert.equal(
    await readFile(marker, "utf8"),
    `registry\nvalidate\n--base\n/trusted/base\n--candidate\n${emptyCandidate}\n`,
  );
  await assert.rejects(readFile(path.join(directory, "npm-ran")), /ENOENT/);
  await assert.rejects(readFile(path.join(directory, "managed-index.json")), /ENOENT/);
  await rm(marker);
  await rm(requestedUrl);

  const badPin = path.join(directory, "bad-pin.env");
  await writeFile(
    badPin,
    `CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=${"0".repeat(64)}\n`,
  );
  const tampered = run(badPin);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /SHA-256 mismatch/);
  await assert.rejects(readFile(marker), /ENOENT/);
  await rm(requestedUrl);

  const untrusted = path.join(directory, "untrusted.env");
  await writeFile(
    untrusted,
    `CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=${sha256}\nCADENCR_RELEASE_URL=https://example.invalid/tool\n`,
  );
  const refused = run(untrusted);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unexpected field/);

  const missing = path.join(directory, "missing.env");
  await writeFile(missing, "CADENCR_RELEASE_VERSION=1.2.3\n");
  const missingResult = run(missing);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /unexpected field/);

  const moving = path.join(directory, "moving.env");
  await writeFile(moving, `CADENCR_RELEASE_VERSION=latest\nCADENCR_RELEASE_SHA256=${sha256}\n`);
  const movingResult = run(moving);
  assert.notEqual(movingResult.status, 0);
  assert.match(movingResult.stderr, /exact semver/);
  await assert.rejects(readFile(requestedUrl), /ENOENT/);
});

test("candidate tooling check cuts over without changing its required-check name", async () => {
  const workflow = await readWorkflow();
  const { tooling } = jobSections(workflow);

  assert.match(
    tooling,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(tooling, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(
    tooling,
    /repository: \$\{\{ github\.event\.pull_request\.base\.repo\.full_name \}\}/,
  );
  assert.match(tooling, /path: trusted-registry/);
  assert.match(
    tooling,
    /sh trusted-registry\/scripts\/ci\/validate-provider-contribution\.sh\s+trusted-registry\/ci\/released-cli\.env\s+trusted-registry\s+candidate-registry\s+tooling/,
  );
  assert.doesNotMatch(
    tooling,
    /candidate-registry\/scripts|working-directory: candidate-registry|needs:|environment:|secrets\.|cache:|upload-artifact/,
  );
});

test("all registry contribution and CI changes trigger validation", async () => {
  const workflow = await readWorkflow();

  // An unfiltered pull_request trigger covers packages/, submissions/, workflow,
  // validator, package manifest, and test changes without a drifting path list.
  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
});

test("bootstrap bounds the fixed official download and contains both tooling paths", async () => {
  const script = await readFile(
    new URL("../scripts/ci/validate-provider-contribution.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /https:\/\/github\.com\/merkr-software\/CadencR\/releases\/download\/v/);
  assert.match(script, /--max-filesize 134217728/);
  assert.match(script, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(script, /registry build-index --packages/);
});
