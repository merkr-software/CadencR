import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  realpathSync,
  statSync,
  readlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { createHash } from "node:crypto";
import { requirePython } from "./python-requirement.mjs";

before(requirePython);

const script = new URL("./qualify-released-cli.sh", import.meta.url).pathname;
const pins = new URL("./cli-qualification.env", import.meta.url);
const workflow = new URL("../.github/workflows/cli-qualification.yml", import.meta.url);

test("offline qualification rejects unverified executables before execution or workspace creation", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-qualification-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "executed");
  const binary = path.join(root, "cadencr");
  writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const work = path.join(root, "work");
  const run = (cli, extra = {}) =>
    spawnSync("sh", [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CLI: cli, CLI_WORK_ROOT: work, ...extra },
    });
  assert.match(run(binary).stderr, /digest mismatch/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(work), false);
  const link = path.join(root, "link");
  symlinkSync(binary, link);
  assert.match(run(link).stderr, /non-symlink/);
  assert.match(
    run(binary, { CADENCR_REGISTRY_GITHUB_TOKEN: "not-a-real-token" }).stderr,
    /token forbidden/,
  );
  assert.match(run(binary, { GITHUB_TOKEN: "not-a-real-token" }).stderr, /token forbidden/);
  assert.match(run(binary, { GH_TOKEN: "not-a-real-token" }).stderr, /token forbidden/);
  assert.equal(existsSync(work), false);
});

test("offline qualification uses separate pins and never uploads generated keys", () => {
  assert.equal(
    readFileSync(pins, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join("\n"),
    "CADENCR_RELEASE_VERSION=0.15.4\nCADENCR_RELEASE_SHA256=d925f203c3fd2e51621ad00ef1413bb25fdf8bc25792dbec9d5d2a67b1d4244d\nCADENCR_RELEASE_TAG=cli/v0.15.4",
  );
  const yaml = readFileSync(workflow, "utf8");
  assert.match(yaml, /scripts\/cli-qualification\.env "\$CLI_ROOT"/);
  assert.doesNotMatch(yaml, /ci\/released-cli\.env/);
  assert.match(yaml, /runs-on: ubuntu-24\.04/);
  assert.match(yaml, /contents: read/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /sudo unshare --net -- setpriv/);
  assert.match(yaml, /--bounding-set=-all --no-new-privs/);
  assert.match(readFileSync(script, "utf8"), /value.get\('code'\)!=sys.argv\[2\]/);
  assert.match(
    yaml,
    /path: \$\{\{ runner.temp \}\}\/cli-offline-qualification\/evidence\/evidence.json/,
  );
  assert.doesNotMatch(yaml, /secrets\.|cargo|pull_request|schedule:|contents: write/);
  const shell = readFileSync(script, "utf8");
  assert.match(shell, /env -i PATH=/);
  assert.match(shell, /lifecycle_qualified':False/);
  assert.match(shell, /interruption_resume':'pending'/);
  assert.match(shell, /renewal':'pending'/);
  assert.doesNotMatch(
    shell,
    /registry (publish-registry|mirror-publication|promote-publication|advance-catalog)/,
  );
  assert.match(shell, /timeout --kill-after=2s 30s/);
  assert.match(shell, /ulimit -f 128/);
});

test("reviewed pin input is strictly bounded before executable invocation", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-reviewed-pins-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "cadencr");
  writeFileSync(binary, "\x7fELFinert fixture", { mode: 0o700 });
  const pin = path.join(root, "pins.env");
  const run = (content) => {
    writeFileSync(pin, content);
    return spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CLI: binary,
        CLI_WORK_ROOT: path.join(root, "work"),
        CLI_QUALIFICATION_PINS: pin,
      },
    });
  };
  const digest = "a".repeat(64);
  const base = `CADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1\nCADENCR_RELEASE_SHA256=${digest}`;
  for (const content of [
    base + "\nCADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1",
    base + `\nCADENCR_RELEASE_SHA256=${digest}`,
    base +
      "\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.39108033875.1\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.39108033875.1",
    ...["", "v0.13.1-dev.39108033875.1", "cli/v0.13.1-dev.39108033875.2", "$(touch bad)"].map(
      (tag) => base + `\nCADENCR_RELEASE_TAG=${tag}`,
    ),
    `CADENCR_RELEASE_VERSION=0.13.1\nCADENCR_RELEASE_SHA256=${digest}\nCADENCR_RELEASE_TAG=v0.13.1`,
    ...[
      "0.13.1-rc.1",
      "0.13.1-dev.0.1",
      "0.13.1-dev.1.0",
      "0.13.1-dev.01.1",
      "0.13.1-dev.1.01",
    ].map(
      (version) =>
        `CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_SHA256=${digest}\nCADENCR_RELEASE_TAG=cli/v${version}`,
    ),
    "CADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1\nCADENCR_RELEASE_SHA256=bad",
    `CADENCR_RELEASE_VERSION=00.99.0\nCADENCR_RELEASE_SHA256=${digest}`,
    `CADENCR_RELEASE_VERSION=0.13.1;echo bad\nCADENCR_RELEASE_SHA256=${digest}`,
    `CADENCR_RELEASE_VERSION=0.13.1\nCADENCR_RELEASE_SHA256=${digest}\nEXTRA=yes`,
    "x".repeat(1025),
  ]) {
    const result = run(content);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pins/);
    assert.equal(existsSync(path.join(root, "work")), false);
  }
  const acceptedShape = run(
    `CADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1\nCADENCR_RELEASE_SHA256=${digest}`,
  );
  assert.match(acceptedShape.stderr, /digest mismatch/);
  assert.match(
    run(base + "\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.39108033875.1").stderr,
    /digest mismatch/,
  );
  // A stable cli-release.yml pin uses the same cli/v namespace.
  assert.match(
    run(
      `CADENCR_RELEASE_VERSION=0.14.0\nCADENCR_RELEASE_SHA256=${digest}\nCADENCR_RELEASE_TAG=cli/v0.14.0`,
    ).stderr,
    /digest mismatch/,
  );
  assert.equal(existsSync(path.join(root, "work")), false);
});

test("three-kind qualification invokes released semantic boundaries without executing fixtures", () => {
  const shell = readFileSync(script, "utf8");
  for (const kind of ["provider", "theme", "tab"])
    assert.match(shell, new RegExp(`registry pack-${kind}`));
  assert.match(shell, /plugin validate "\$CLI_WORK_ROOT\/qualification-tab" --kind tab/);
  assert.match(shell, /pack-tab --directory .* --package /);
  assert.match(shell, /for field in id name version api_version unknown nested malformed-envelope/);
  assert.match(shell, /TAB_PACKAGING_FAILED/);
  assert.match(shell, /run validate-contributions registry validate/);
  assert.match(shell, /schema_version':2,'package':value/);
  assert.match(shell, /len\(e\['signed'\]\['packages'\]\)!=3/);
  assert.match(shell, /cmp "\$CLI_WORK_ROOT\/tab-1.tar.gz" "\$CLI_WORK_ROOT\/tab-2.tar.gz"/);
  assert.match(shell, /fixture must never execute/);
  assert.match(shell, /CLI_QUALIFICATION_PINS/);
});

test("synthetic runner stops at version mismatch and emits key-free failed evidence", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-synthetic-runner-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "cadencr");
  const bytes = Buffer.from("\x7fELFsynthetic non-executable fixture");
  writeFileSync(binary, bytes, { mode: 0o700 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pin = path.join(root, "pins.env");
  writeFileSync(
    pin,
    `CADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1\nCADENCR_RELEASE_SHA256=${digest}\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.39108033875.1\n`,
  );
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  // Synthetic timeout stands in for an unavailable Linux execution surface.
  // It never executes the ELF or fixtures and cannot establish CLI qualification.
  writeFileSync(path.join(bin, "timeout"), "#!/bin/sh\nprintf 'cadencr 0.13.0\\n'\n", {
    mode: 0o700,
  });
  const work = path.join(root, "work");
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CLI: binary,
      CLI_WORK_ROOT: work,
      CLI_QUALIFICATION_PINS: pin,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(work, "provider")), false);
  const evidence = JSON.parse(readFileSync(path.join(work, "evidence/evidence.json"), "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.version, "0.13.1-dev.39108033875.1");
  assert.equal(evidence.cli_sha256, digest);
  assert.equal(evidence.lifecycle_qualified, false);
  assert.equal(existsSync(path.join(work, "keys/private.pem")), false);
  assert.equal(existsSync(path.join(work, "keys/public.pem")), false);
});

test("fixture generator submits all three kinds as new contributions", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-contribution-fixtures-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shell = readFileSync(script, "utf8");
  const marker = "python3 - <<'PY'\nimport os,pathlib,json,datetime,shutil\n";
  const body = shell.split(marker)[1].split("\nPY\n")[0];
  const result = spawnSync("python3", ["-c", "import os,pathlib,json,datetime,shutil\n" + body], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CLI_WORK_ROOT: root,
      SCRIPT_ROOT: path.dirname(script),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const [kind, original, limit] of [
    ["metadata", "provider-package.json", 32 * 1024 * 1024],
    ["submission", "submission-provider.json", 1024 * 1024],
    ["expiry", "expiry-healthy.json", 32 * 1024 * 1024],
  ]) {
    const oversized = path.join(root, `${kind}-oversized.json`);
    assert.ok(statSync(oversized).size > limit);
    assert.deepEqual(
      JSON.parse(readFileSync(oversized, "utf8")),
      JSON.parse(readFileSync(path.join(root, original), "utf8")),
    );
  }
  assert.equal(
    readlinkSync(path.join(root, "expiry-link.json")),
    path.join(root, "expiry-healthy.json"),
  );
  for (const [name, kind] of [
    ["example-provider-0.1.0.json", "provider"],
    ["qualification-1.0.0.json", "theme"],
    ["qualification-tab-1.0.0.json", "tab"],
  ]) {
    assert.equal(existsSync(path.join(root, "base/packages", name)), false);
    const pkg = JSON.parse(readFileSync(path.join(root, "candidate/packages", name), "utf8"));
    const submission = JSON.parse(
      readFileSync(path.join(root, "candidate/submissions", name), "utf8"),
    );
    assert.equal(pkg.kind, kind);
    assert.equal(submission.schema_version, 2);
    assert.deepEqual(submission.package, pkg);
    const descriptor = pkg.package[kind === "provider" ? "agent" : kind];
    assert.equal(submission.source.repository, descriptor.repository);
    assert.equal(submission.source.tag, `v${descriptor.version}`);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, `submission-${kind}.json`), "utf8")),
      submission,
    );
    const provenance = JSON.parse(
      readFileSync(path.join(root, `submission-${kind}-provenance.json`), "utf8"),
    );
    assert.notEqual(provenance.source.repository, descriptor.repository);
    const nested = JSON.parse(
      readFileSync(path.join(root, `submission-${kind}-nested.json`), "utf8"),
    );
    assert.deepEqual(nested.package.package, submission.package);
  }
});

test("standalone diagnostics qualify all kinds and preserve expiry output channels", () => {
  const shell = readFileSync(script, "utf8");
  assert.match(shell, /run "validate-metadata-\$kind" --json registry validate-metadata/);
  assert.match(shell, /run "validate-submission-\$kind" --json registry validate-submission/);
  assert.match(shell, /for label in nested unknown provenance/);
  assert.match(shell, /for label in link fifo oversized/);
  assert.match(shell, /os\.mkfifo/);

  assert.match(shell, /for state in expired renewal-due healthy/);
  assert.match(shell, /for mode in human json/);
  assert.match(shell, /entry\['authenticated'\] is False/);
  assert.match(shell, /diagnostic\['code'\]=='METADATA_RENEWAL_DUE'/);
  assert.match(shell, /assert code=='1'/);
  assert.match(shell, /assert code=='0' and stderr==''/);
  assert.match(shell, /test "\$result" -eq "\$expected_result"/);
  assert.match(shell, /test ! -s "\$CLI_WORK_ROOT\/logs\/\$name.out"/);
});

test("exact run/reject helpers fail closed on exit, stdout, and diagnostic corruption", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-helper-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "logs"));
  mkdirSync(path.join(root, "bin"));
  const shell = readFileSync(script, "utf8");
  const helpers = shell.slice(shell.indexOf("run() {"), shell.indexOf("run version --version"));
  const diagnostic = JSON.stringify({ ok: false, code: "REGISTRY_VALIDATION_FAILED" });
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const cases = [
    ["semantic", 1, "", diagnostic, true],
    ["write-failure", 3, "", JSON.stringify({ ok: false, code: "OUTPUT_WRITE_FAILED" }), true],
    ["timeout", 124, "", diagnostic, false],
    ["wrong-exit", 3, "", diagnostic, false],
    ["accepted", 0, "", diagnostic, false],
    ["stdout", 1, "unexpected", diagnostic, false],
    ["malformed", 1, "", "not JSON", false],
    ["wrong-code", 1, "", JSON.stringify({ ok: false, code: "OTHER" }), false],
  ];
  for (const [name, exit, stdout, stderr, accepted] of cases) {
    writeFileSync(
      path.join(root, "bin/timeout"),
      `#!/bin/sh\nprintf '%s' ${quote(stdout)}\nprintf '%s' ${quote(stderr)} >&2\nexit ${exit}\n`,
      { mode: 0o700 },
    );
    const code = name === "write-failure" ? "OUTPUT_WRITE_FAILED" : "REGISTRY_VALIDATION_FAILED";
    const result = spawnSync(
      "sh",
      ["-c", `set -eu\n${helpers}\nreject ${name} ${code} registry validate-metadata ignored`],
      {
        encoding: "utf8",
        env: { PATH: `${root}/bin:${process.env.PATH}`, CLI_WORK_ROOT: root, CLI: "/unused" },
      },
    );
    assert.equal(result.status === 0, accepted, `${name}: ${result.stderr}`);
  }
  // New success checks deliberately defer their marker until output assertions pass.
  writeFileSync(path.join(root, "bin/timeout"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const name of [
    "validate-metadata-provider",
    "validate-submission-tab",
    "expiry-healthy-json",
  ]) {
    const result = spawnSync("sh", ["-c", `set -eu\n${helpers}\nrun ${name}`], {
      env: { PATH: `${root}/bin:${process.env.PATH}`, CLI_WORK_ROOT: root, CLI: "/unused" },
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(path.join(root, `logs/${name}.passed`)), false);
  }
});

test("exact expiry assertion enforces report state, exit, trust, and channels", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-expiry-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shell = readFileSync(script, "utf8");
  const body = shell.split("prefix,state,mode,code=sys.argv[1:]\n")[1].split("\nPY\n")[0];
  const assertion = "import json,pathlib,sys\nprefix,state,mode,code=sys.argv[1:]\n" + body;
  const report = (state, authenticated = false) =>
    JSON.stringify({
      diagnostic_only: true,
      results: [{ status: state, authenticated, remaining_hours: 24 }],
    });
  const diagnostic = JSON.stringify({ ok: false, code: "METADATA_RENEWAL_DUE" });
  const cases = [
    ["healthy", "json", "0", report("healthy"), "", true],
    ["expired", "json", "1", report("expired"), diagnostic, true],
    ["renewal-due", "human", "1", report("renewal-due"), "error[METADATA_RENEWAL_DUE]", true],
    ["healthy", "json", "1", report("healthy"), "", false],
    ["expired", "json", "0", report("expired"), diagnostic, false],
    ["expired", "json", "124", report("expired"), diagnostic, false],
    ["expired", "json", "1", report("healthy"), diagnostic, false],
    ["expired", "json", "1", report("expired", true), diagnostic, false],
    ["expired", "json", "1", diagnostic, report("expired"), false],
    ["expired", "json", "1", report("expired"), "malformed", false],
    [
      "expired",
      "json",
      "1",
      report("expired"),
      JSON.stringify({ ok: false, code: "OTHER" }),
      false,
    ],
    ["healthy", "json", "0", report("healthy"), diagnostic, false],
    ["expired", "json", "1", report("expired") + "\n{}", diagnostic, false],
  ];
  for (const [state, mode, exit, stdout, stderr, accepted] of cases) {
    const prefix = path.join(root, "report");
    writeFileSync(prefix + ".out", stdout);
    writeFileSync(prefix + ".err", stderr);
    const result = spawnSync("python3", ["-c", assertion, prefix, state, mode, exit], {
      encoding: "utf8",
    });
    assert.equal(result.status === 0, accepted, `${state}/${mode}/${exit}: ${result.stderr}`);
  }
});

test("repository qualification pins select the exact namespaced released asset without network or execution", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-qualification-fetch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools");
  mkdirSync(tools);
  const requests = path.join(root, "requests");
  // Stop at the download boundary: no bytes, digest bypass, or ELF execution.
  writeFileSync(
    path.join(tools, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${requests}'\nprintf 404\n`,
    { mode: 0o700 },
  );
  const fetcher = new URL(
    "../tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh",
    import.meta.url,
  ).pathname;
  const result = spawnSync("sh", [fetcher, pins.pathname, path.join(root, "output")], {
    encoding: "utf8",
    env: { PATH: `${tools}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /download failed with HTTP 404/);
  const args = readFileSync(requests, "utf8").trim().split("\n");
  assert.equal(
    args.at(-1),
    "https://github.com/merkr-software/CadencR/releases/download/cli/v0.15.4/cadencr-v0.15.4-x86_64-unknown-linux-gnu",
  );
  assert.equal(existsSync(path.join(root, "output/cadencr")), false);
});
