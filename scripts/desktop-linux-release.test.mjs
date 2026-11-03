import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const text = readFileSync(".github/workflows/desktop-linux-release.yml", "utf8");
const workflow = parse(text);

function step(job, name) {
  const found = workflow.jobs[job].steps.find((candidate) => candidate.name === name);
  assert.ok(found, `${job} has no step named ${name}`);
  return found;
}

/** Runs a step's script against a fake `gh` that logs its calls and prints `ghOutput`. */
function runWithFakeGh(script, { ghOutput = "", ghStatus = 0, notes = "" } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-linux-release-"));
  try {
    const callsFile = join(scratch, "gh-calls.txt");
    writeFileSync(callsFile, "");
    writeFileSync(
      join(scratch, "gh"),
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$GH_CALLS_FILE"',
        'case "$*" in',
        '  *"--notes-file"*) cp "${@: -1}" "$GH_SCRATCH/edited-notes.md" ;;',
        '  *"--json body"*) printf "%s\\n" "$GH_NOTES" ;;',
        '  *) printf "%b" "$GH_OUTPUT" ;;',
        "esac",
        'exit "$GH_STATUS"',
      ].join("\n"),
      { mode: 0o700 },
    );
    // BASH_ENV would let a developer's shell profile print into the notes.
    const { BASH_ENV: _ignored, ...inherited } = process.env;
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: {
        ...inherited,
        PATH: `${scratch}:${process.env.PATH}`,
        RUNNER_TEMP: scratch,
        GITHUB_REPOSITORY: "merkr-software/CadencR",
        GITHUB_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        RELEASE_TAG: "v0.15.0",
        GH_CALLS_FILE: callsFile,
        GH_SCRATCH: scratch,
        GH_OUTPUT: ghOutput,
        GH_STATUS: String(ghStatus),
        GH_NOTES: notes,
      },
      encoding: "utf8",
    });
    const edited = join(scratch, "edited-notes.md");
    const editedNotes = existsSync(edited) ? readFileSync(edited, "utf8") : null;
    const smoke = join(scratch, "cadencr-smoke-linux-packages.sh");
    const smokeScript = existsSync(smoke) ? readFileSync(smoke, "utf8") : null;
    return { result, calls: readFileSync(callsFile, "utf8"), editedNotes, smokeScript };
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

test("the Linux alpha only runs by hand, for an explicit tag, one run per tag", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
  assert.equal(workflow.env.RELEASE_TAG, "${{ inputs.release_tag }}");
  assert.match(workflow.concurrency.group, /inputs\.release_tag/);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["preflight", "build", "attach"]);
  assert.equal(workflow.jobs.build.needs, "preflight");
  assert.equal(workflow.jobs.attach.needs, "build");
});

test("the tag is validated before anything reads it", () => {
  const validate = step("preflight", "Validate release tag");
  assert.equal(workflow.jobs.preflight.steps[0], validate);
  for (const [tag, valid] of [
    ["v0.15.0", true],
    ["", false],
    ["main", false],
    ["v0.15.0; echo unexpected", false],
    ["v0.15.0\necho unexpected", false],
  ]) {
    const result = spawnSync("bash", ["-c", validate.run], {
      env: { ...process.env, RELEASE_TAG: tag },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, valid, `${JSON.stringify(tag)}: ${result.stderr}`);
  }
  const build = workflow.jobs.build.steps;
  const checkout = build.find((candidate) => candidate.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "refs/tags/${{ env.RELEASE_TAG }}");
});

test("preflight accepts only a published release without Linux packages", () => {
  const { run } = step("preflight", "Check the release can take the Linux alpha");
  for (const [ghOutput, ghStatus, accepted] of [
    ["false\\t0\\n", 0, true],
    ["true\\t0\\n", 0, false],
    ["false\\t1\\n", 0, false],
    ["false\\t4\\n", 0, false],
    ["", 1, false],
  ]) {
    const { result, calls } = runWithFakeGh(run, { ghOutput, ghStatus });
    assert.equal(result.status === 0, accepted, `${ghOutput}/${ghStatus}: ${result.stderr}`);
    assert.equal(calls.trim().split("\n").length, 1, "preflight only reads the release");
    assert.doesNotMatch(calls, /upload|edit|delete/);
  }
});

test("the build smoke-tests the packages on the oldest supported glibc", () => {
  assert.equal(workflow.jobs.build["runs-on"], "ubuntu-22.04");
  const names = workflow.jobs.build.steps.map((candidate) => candidate.name);
  const order = [
    "Validate marketplace build configuration",
    "Build Rust service sidecar (x64)",
    "Smoke test packaged service sidecar startup",
    "Build Linux AppImage, DEB, and RPM",
    "Smoke test Linux packages",
  ].map((name) => names.indexOf(name));
  assert.ok(
    order.every((index, position) => index > (order[position - 1] ?? -1)),
    `${order}`,
  );
  assert.match(step("build", "Build Linux AppImage, DEB, and RPM").run, /--publish never/);
  assert.ok(!text.includes("--publish always"));
  assert.ok(!text.includes("PRIVATE_KEY"));
});

test("Linux smoke orchestration comes from the workflow commit and download errors are fatal", () => {
  const load = step("build", "Load Linux smoke test from workflow commit");
  const source = readFileSync("scripts/smoke-linux-packages.sh", "utf8");
  const { result, calls, smokeScript } = runWithFakeGh(load.run, {
    ghOutput: Buffer.from(source).toString("base64"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(smokeScript, source);
  assert.match(calls, /smoke-linux-packages\.sh\?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  for (const options of [{ ghStatus: 1 }, { ghOutput: "" }]) {
    assert.notEqual(runWithFakeGh(load.run, options).result.status, 0);
  }
  const smoke = step("build", "Smoke test Linux packages");
  assert.match(smoke.run, /bash "\$RUNNER_TEMP\/cadencr-smoke-linux-packages\.sh"/);
  assert.equal(smoke["continue-on-error"], undefined);
});

test("attach uploads every updater target, verifies them, then flags the notes", () => {
  const names = workflow.jobs.attach.steps.map((candidate) => candidate.name);
  assert.deepEqual(names.slice(1), [
    "Upload Linux alpha assets",
    "Verify uploaded Linux alpha assets",
    "Flag the Linux packages as alpha in the release notes",
  ]);
  const upload = step("attach", "Upload Linux alpha assets").run;
  for (const asset of [
    "Cadencr-${version}-x86_64.AppImage",
    "Cadencr-${version}-amd64.deb",
    "Cadencr-${version}-x86_64.rpm",
    "latest-linux.yml",
  ]) {
    assert.ok(upload.includes(asset), asset);
  }
  assert.doesNotMatch(text, /AppImage\.blockmap/);
});

test("the release notes gain one alpha section, even when attach is re-run", () => {
  const { run } = step("attach", "Flag the Linux packages as alpha in the release notes");
  const first = runWithFakeGh(run, { notes: "## Added\n\n- Something." });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.match(first.editedNotes, /^## Added\n\n- Something\.\n\n## Linux \(alpha\)\n/);
  assert.equal(first.editedNotes.match(/## Linux \(alpha\)/g).length, 1);
  assert.match(first.editedNotes, /\*\*alpha\*\*/);
  for (const command of [
    "chmod +x Cadencr-0.15.0-x86_64.AppImage",
    "sudo apt install ./Cadencr-0.15.0-amd64.deb",
    "sudo dnf install ./Cadencr-0.15.0-x86_64.rpm",
    "sudo zypper install ./Cadencr-0.15.0-x86_64.rpm",
  ]) {
    assert.ok(first.editedNotes.includes(command), command);
  }
  assert.match(first.editedNotes, /\n```bash\n[^`]+\n```\n/);

  const again = runWithFakeGh(run, { notes: first.editedNotes });
  assert.equal(again.result.status, 0, again.result.stderr);
  assert.equal(again.editedNotes, null, "an already flagged release is left alone");
  assert.doesNotMatch(again.calls, /edit/);
});

test("the Linux sidecar gets the same public marketplace pins as macOS", () => {
  const macos = readFileSync(".github/workflows/desktop-release.yml", "utf8");
  const pins = macos.match(/CADENCR_[A-Z0-9_]+: \$\{\{ vars\.[A-Z0-9_]+ \}\}/g);
  assert.ok(pins.length >= 11, `${pins.length}`);
  for (const pin of pins) assert.ok(text.includes(pin), pin);
});
