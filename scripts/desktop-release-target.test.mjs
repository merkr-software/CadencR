import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/desktop-release.yml", "utf8"));

test("manual release builds require an explicit existing version tag", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
  const steps = workflow.jobs.release.steps;
  const validationIndex = steps.findIndex((step) => step.name === "Validate release tag");
  const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(validationIndex >= 0 && validationIndex < checkoutIndex);

  for (const [tag, valid] of [
    ["v0.14.0", true],
    ["v1.2.3", true],
    ["", false],
    ["main", false],
    ["refs/heads/v0.14.0", false],
    ["../v0.14.0", false],
    ["v0.14.0; echo unexpected", false],
    ["v0.14.0\necho unexpected", false],
  ]) {
    const result = spawnSync("bash", ["-c", steps[validationIndex].run], {
      env: { ...process.env, RELEASE_TAG: tag },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, valid, `${JSON.stringify(tag)}: ${result.stderr}`);
  }
});

test("the release builds the tag rather than the workflow dispatch branch", () => {
  assert.equal(workflow.env.RELEASE_TAG, "${{ inputs.release_tag || github.ref_name }}");
  // The CLI ships through cli-release.yml; the app release is one job.
  assert.deepEqual(Object.keys(workflow.jobs), ["release"]);
  const checkout = workflow.jobs.release.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "refs/tags/${{ env.RELEASE_TAG }}");
  const create = workflow.jobs.release.steps.find(
    (step) => step.name === "Create draft GitHub release",
  );
  assert.match(create.run, /--verify-tag/);
});

test("release preparation refuses every existing release without deleting it", () => {
  const prepare = workflow.jobs.release.steps.find(
    (step) => step.name === "Prepare GitHub release",
  );
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-release-target-"));
  try {
    writeFileSync(
      join(scratch, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS_FILE"\nprintf "%s" "$GH_RELEASES_OUTPUT"\n',
      { mode: 0o700 },
    );
    for (const existing of [
      "",
      "1\ttrue\t0\n",
      "1\tfalse\t0\n",
      "1\ttrue\t11\n",
      "1\tfalse\t11\n",
    ]) {
      const callsFile = join(scratch, "gh-calls.txt");
      writeFileSync(callsFile, "");
      const result = spawnSync("bash", ["-e", "-c", prepare.run], {
        env: {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          RUNNER_TEMP: scratch,
          GITHUB_REPOSITORY: "merkr-software/CadencR",
          RELEASE_TAG: "v0.14.0",
          GH_CALLS_FILE: callsFile,
          GH_RELEASES_OUTPUT: existing,
        },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, existing === "", result.stderr);
      assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);
      assert.doesNotMatch(readFileSync(callsFile, "utf8"), /DELETE/);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("packaging raises the descriptor limit inherited by pnpm", () => {
  const steps = workflow.jobs.release.steps;
  const packaging = steps.find((step) => step.name === "Build, sign, and notarize desktop app");
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-packaging-limit-"));
  try {
    writeFileSync(join(scratch, "pnpm"), '#!/bin/bash\nprintf "fd-limit=%s\\n" "$(ulimit -Sn)"\n', {
      mode: 0o700,
    });
    const result = spawnSync("bash", ["-e", "-c", `ulimit -Sn 256\n${packaging.run}`], {
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, RUNNER_TEMP: scratch },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const limit = result.stdout.match(/fd-limit=(\d+)/);
    assert.ok(limit, result.stdout);
    assert.ok(Number(limit[1]) >= 10240, result.stdout);
    const nativeIndex = steps.findIndex((step) => step.name?.startsWith("Build Rust service"));
    for (const name of ["Verify packaging dependency graph", "Build renderer + main bundles"]) {
      const index = steps.findIndex((step) => step.name === name);
      assert.ok(index >= 0 && index < nativeIndex, `${name} must fail before the native build`);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("CloudKit uses TCP without replacing firewall rules or bypassing failed setup", () => {
  const steps = workflow.jobs.release.steps;
  const setupIndex = steps.findIndex(
    (step) => step.name === "Route Apple CloudKit requests over HTTPS TCP",
  );
  const nativeIndex = steps.findIndex((step) => step.name?.startsWith("Build Rust service"));
  assert.ok(setupIndex >= 0 && setupIndex < nativeIndex);
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-cloudkit-transport-"));
  try {
    writeFileSync(join(scratch, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    writeFileSync(
      join(scratch, "pfctl"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$PF_CALLS_FILE"
case "$*" in
  -sr) printf '%s\\n' "$PF_RULESET"; exit "$PF_READ_EXIT" ;;
  '-a com.apple/000.cadencr-cloudkit -f -') cat > "$PF_ANCHOR_FILE"; exit "$PF_LOAD_EXIT" ;;
  -E) exit "$PF_ENABLE_EXIT" ;;
  *) exit 91 ;;
esac
`,
      { mode: 0o700 },
    );
    const read = ["-sr"];
    const load = [...read, "-a com.apple/000.cadencr-cloudkit -f -"];
    const enabled = [...load, "-E"];
    for (const { rules, readExit = 0, loadExit = 0, enableExit = 0, status, calls } of [
      { rules: 'anchor "com.apple/*" all', status: 0, calls: enabled },
      { rules: 'anchor "com.apple/*"', status: 0, calls: enabled },
      { rules: 'nat-anchor "com.apple/*" all', status: 1, calls: read },
      { rules: "pass out all", status: 1, calls: read },
      { rules: 'anchor "com.apple/*" all', readExit: 13, status: 13, calls: read },
      { rules: 'anchor "com.apple/*" all', loadExit: 17, status: 17, calls: load },
      { rules: 'anchor "com.apple/*" all', enableExit: 19, status: 19, calls: enabled },
    ]) {
      const callsFile = join(scratch, "calls");
      const anchorFile = join(scratch, "anchor");
      writeFileSync(callsFile, "");
      writeFileSync(anchorFile, "");
      const env = {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        PF_CALLS_FILE: callsFile,
        PF_ANCHOR_FILE: anchorFile,
        PF_RULESET: rules,
        PF_READ_EXIT: String(readExit),
        PF_LOAD_EXIT: String(loadExit),
        PF_ENABLE_EXIT: String(enableExit),
      };
      delete env.BASH_ENV;
      const result = spawnSync("bash", ["-e", "-c", steps[setupIndex].run], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, status, `${rules}\n${result.stdout}\n${result.stderr}`);
      assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), calls);
      assert.equal(
        readFileSync(anchorFile, "utf8"),
        calls.includes(load[1])
          ? "block return out quick proto udp from any to any port 443\n"
          : "",
      );
      if (status === 1)
        assert.match(result.stdout, /::error::.*refusing to replace firewall rules/);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("packaging retries only transient Apple stapling failures with a bounded backoff", () => {
  const packaging = workflow.jobs.release.steps.find(
    (step) => step.name === "Build, sign, and notarize desktop app",
  );
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-packaging-retry-"));
  try {
    writeFileSync(
      join(scratch, "pnpm"),
      `#!/bin/bash
count=$(cat "$ATTEMPTS_FILE")
count=$((count + 1))
printf '%s' "$count" > "$ATTEMPTS_FILE"
if [ "$count" -ge "$SUCCESS_AT" ]; then exit 0; fi
printf '%s\\n' "$BUILD_ERROR" >&2
exit 23
`,
      { mode: 0o700 },
    );
    writeFileSync(join(scratch, "sleep"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$DELAYS_FILE"\n', {
      mode: 0o700,
    });
    const transient =
      "Failed to staple your application with code: 68\n" +
      'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
    for (const { error, successAt, attempts, delays, status } of [
      { error: transient, successAt: 1, attempts: 1, delays: "", status: 0 },
      { error: transient, successAt: 2, attempts: 2, delays: "20\n", status: 0 },
      { error: transient, successAt: 4, attempts: 3, delays: "20\n40\n", status: 23 },
      { error: "Invalid signing identity", successAt: 2, attempts: 1, delays: "", status: 23 },
      {
        error: transient.replace("code: 68", "code: 65"),
        successAt: 2,
        attempts: 1,
        delays: "",
        status: 23,
      },
      {
        error: "Failed to staple your application with code: 68\nTicket missing",
        successAt: 2,
        attempts: 1,
        delays: "",
        status: 23,
      },
    ]) {
      const attemptsFile = join(scratch, "attempts");
      const delaysFile = join(scratch, "delays");
      writeFileSync(attemptsFile, "0");
      writeFileSync(delaysFile, "");
      const env = {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        RUNNER_TEMP: scratch,
        ATTEMPTS_FILE: attemptsFile,
        DELAYS_FILE: delaysFile,
        BUILD_ERROR: error,
        SUCCESS_AT: String(successAt),
      };
      delete env.BASH_ENV;
      const result = spawnSync("bash", ["-e", "-c", packaging.run], { env, encoding: "utf8" });
      assert.equal(result.status, status, `${error}\n${result.stdout}\n${result.stderr}`);
      assert.equal(Number(readFileSync(attemptsFile, "utf8")), attempts, error);
      assert.equal(readFileSync(delaysFile, "utf8"), delays, error);
      if (attempts > 1) assert.match(result.stdout, /::warning::/);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("only listing uses the patched pnpm with its pinned integrity", () => {
  const setup = workflow.jobs.release.steps.find(
    (step) => step.name === "Use bounded pnpm listing for packaging",
  );
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-packaging-pnpm-"));
  try {
    const upstream = join(scratch, "upstream");
    mkdirSync(upstream);
    const callsFile = join(scratch, "calls.txt");
    for (const command of ["pnpm", "corepack"]) {
      writeFileSync(
        join(upstream, command),
        '#!/bin/sh\nprintf "' + command + ':%s\\n" "$*" >> "$CALL_LOG"\n',
        { mode: 0o700 },
      );
    }
    const envFile = join(scratch, "github-env");
    const pathFile = join(scratch, "github-path");
    writeFileSync(envFile, "");
    writeFileSync(pathFile, "");
    const env = {
      ...process.env,
      PATH: upstream + ":" + process.env.PATH,
      RUNNER_TEMP: scratch,
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
      CALL_LOG: callsFile,
    };
    delete env.BASH_ENV;
    const installed = spawnSync("bash", ["-e", "-c", setup.run], { env, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const exported = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const wrapper = join(readFileSync(pathFile, "utf8").trim(), "pnpm");
    writeFileSync(callsFile, "");
    for (const args of [
      ["list", "--prod", "--json"],
      ["--filter", "@cadencr/desktop", "exec", "electron-builder"],
    ]) {
      const result = spawnSync(wrapper, args, { env: { ...env, ...exported }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const calls = readFileSync(callsFile, "utf8").trim().split("\n");
    assert.match(
      calls[0],
      /^corepack:pnpm@11\.13\.0\+sha512\.[a-f0-9]{128} --pm-on-fail=ignore list --prod --json$/,
    );
    assert.equal(calls[1], "pnpm:--filter @cadencr/desktop exec electron-builder");
    assert.equal(calls.length, 2);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
