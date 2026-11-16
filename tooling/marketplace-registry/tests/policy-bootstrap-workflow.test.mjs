import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const readUrl = (relative) => new URL(relative, import.meta.url);
const source = readFileSync(readUrl("../.github/workflows/bootstrap-revocation-policies.yml"), "utf8");
const publisherSource = readFileSync(
  readUrl("../.github/workflows/publish-protected-catalog.yml"),
  "utf8",
);
const workflow = parse(source);
const publisher = parse(publisherSource);
const script = readUrl("../scripts/ci/registry-feeds.sh").pathname;
const defaultBranch = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const confirmation = "bootstrap-empty-policies";
const keyPrefix = "marketplace-publisher-secret-";
const bootstrap = workflow.jobs.bootstrap;
const step = (name) => bootstrap.steps.find((s) => s.name === name);

// ---- workflow structure ------------------------------------------------------

test("bootstrap is dispatch-only with one required confirmation input", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["confirm"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm.type, "string");
  assert.doesNotMatch(source, /^  (schedule|pull_request|push|workflow_run):/m);
  // The input is only ever read through the environment, never interpolated into a script.
  for (const job of Object.values(workflow.jobs))
    for (const s of job.steps) assert.doesNotMatch(s.run ?? "", /\$\{\{/);
});

test("bootstrap runs only on the default branch, in the reviewed environment, after a secret-free preflight", () => {
  assert.equal(workflow.jobs.preflight.if, defaultBranch);
  assert.equal(workflow.jobs.preflight.environment, undefined);
  assert.equal(JSON.stringify(workflow.jobs.preflight).includes("secrets."), false);
  assert.equal(bootstrap.needs, "preflight");
  assert.equal(bootstrap.if, `needs.preflight.result == 'success' && ${defaultBranch}`);
  assert.equal(bootstrap.if.split("&&")[1].trim(), publisher.jobs.publish.if.split("&&")[1].trim());
  assert.equal(bootstrap.environment, "protected-marketplace-publisher");
  assert.equal(bootstrap.environment, publisher.jobs.publish.environment);
  assert.notEqual(bootstrap.environment, "protected-marketplace-renewal");
  // Three files, each read-back may wait out the raw CDN cache (about 6 minutes).
  assert.equal(bootstrap["timeout-minutes"], 30);
  assert.match(
    workflow.jobs.preflight.steps.at(-1).run,
    /^sh scripts\/ci\/registry-feeds\.sh bootstrap-check$/,
  );
});

test("permissions are minimal and the publication lane is shared and never cancelled", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions, undefined);
  assert.doesNotMatch(source, /id-token|contents: write|upload-artifact|download-artifact/);
  assert.deepEqual(workflow.concurrency, publisher.concurrency);
  assert.deepEqual(workflow.concurrency, {
    group: "marketplace-publication",
    "cancel-in-progress": false,
  });
  assert.equal(JSON.stringify(workflow).includes("continue-on-error"), false);
});

test("checkout and actions are pinned and the released CLI comes from the trusted selector", () => {
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  }
  for (const action of source.matchAll(/uses: ([^\n ]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
  const pins = (text) => [...text.matchAll(/uses: ([^\n ]+)/g)].map((m) => m[1]);
  for (const pin of pins(source)) assert.ok(pins(publisherSource).includes(pin), pin);
  const selector = step("Select verified publisher runtime");
  assert.equal(selector.run, "sh scripts/ci/select-publisher-runtime.sh");
  assert.equal(
    step("Sign and publish the missing empty policies").env.VERIFIED_CLI,
    "${{ steps.publisher_runtime.outputs.cli_file }}",
  );
  assert.doesNotMatch(source, /npm|pnpm|yarn|scripts\/[\w-]+\.mjs|cargo|releases\/download/);
  assert.doesNotMatch(source, /publish-registry|publication-request\.json/);
});

test("the key and token reach only their steps, and the key is removed even on failure", () => {
  const holders = bootstrap.steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    holders.map((s) => s.name),
    ["Materialize protected signing key", "Sign and publish the missing empty policies"],
  );
  assert.equal([...source.matchAll(/secrets\.CADENCR_REGISTRY_PRIVATE_KEY_PEM/g)].length, 1);
  assert.equal([...source.matchAll(/secrets\.CADENCR_REGISTRY_GITHUB_TOKEN/g)].length, 1);
  assert.equal(
    step("Materialize protected signing key").run,
    `sh scripts/ci/registry-feeds.sh materialize-key ${keyPrefix}`,
  );
  const removal = step("Remove materialized signing key");
  assert.equal(removal.run, `sh scripts/ci/registry-feeds.sh remove-key ${keyPrefix}`);
  assert.equal(
    removal.if,
    "${{ always() && steps.materialize_key.outputs.private_key_file != '' }}",
  );
  // The key stays a file path in the step environment; the only secret-bearing
  // step that signs is the guarded helper, which strips the token from the signer.
  const publish = step("Sign and publish the missing empty policies");
  assert.match(publish.run, /registry-feeds\.sh bootstrap-policies "\$RUNNER_TEMP\/[\w-]+"$/);
  assert.equal(publish.env.PRIVATE_KEY_FILE, "${{ steps.materialize_key.outputs.private_key_file }}");
  assert.equal(publish.env.CONFIRM_BOOTSTRAP, "${{ inputs.confirm }}");
  const names = bootstrap.steps.map((s) => s.name ?? s.uses);
  const order = [
    "Select verified publisher runtime",
    "Materialize protected signing key",
    "Sign and publish the missing empty policies",
    "Remove materialized signing key",
  ].map((n) => names.indexOf(n));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});

// Evaluate a step `if` the way Actions does for the subset the workflow uses.
test("a failing bootstrap step still runs the key removal", () => {
  const outcomes = {};
  const outputs = { materialize_key: { private_key_file: "/tmp/key.pem" } };
  const ran = [];
  let failed = false;
  for (const s of bootstrap.steps) {
    const label = s.name ?? s.uses;
    const condition = s.if === undefined ? undefined : String(s.if);
    const hasStatus = /\b(?:always|cancelled|failure|success)\(\)/.test(condition ?? "");
    let run = true;
    if (condition !== undefined) {
      const expression = condition
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/always\(\)/g, "true")
        .replace(/steps\.(\w+)\.outputs\.(\w+)/g, (_, id, name) =>
          JSON.stringify(outputs[id]?.[name] ?? ""),
        )
        .replace(/==/g, "===")
        .replace(/!=/g, "!==");
      run = Function(`return (${expression});`)();
    }
    if (!hasStatus && failed) run = false;
    if (run) ran.push(label);
    const outcome = !run ? "skipped" : label === "Sign and publish the missing empty policies" ? "failure" : "success";
    if (s.id) outcomes[s.id] = outcome;
    if (outcome === "failure") failed = true;
  }
  assert.ok(ran.includes("Sign and publish the missing empty policies"));
  assert.ok(ran.includes("Remove materialized signing key"));
});

// ---- executable behavior of the helper --------------------------------------

function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bootstrap-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "github-output");
  writeFileSync(output, "");
  return { root, output };
}

function helper(args, env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("CADENCR_REGISTRY_")) delete clean[key];
  return spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...clean, ...env } });
}

const pem =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAplaceholderplaceholderplaceholder0=\n-----END PUBLIC KEY-----";
const files = {
  provider: "managed-blocklist.json",
  theme: "managed-theme-blocklist.json",
  tab: "managed-tab-blocklist.json",
};
const feedUrl = (kind, branch = "marketplace-v2", repository = "acme/registry") =>
  `https://raw.githubusercontent.com/${repository}/refs/heads/${branch}/${files[kind]}`;
const configuration = (extra = {}) => ({
  GITHUB_REPOSITORY: "acme/registry",
  CONFIRM_BOOTSTRAP: confirmation,
  CADENCR_REGISTRY_KEY_ID: "registry-key-1",
  CADENCR_REGISTRY_PUBLIC_KEY_PEM: pem,
  ...extra,
});

// A fake released CLI. It records every call with the token it saw and the
// payload it was asked to sign. `present` kinds already have a published policy.
function runBootstrap(t, { behavior = {}, env = {}, reuseWork } = {}) {
  const { root } = sandbox(t);
  const cli = path.join(root, "cadencr");
  const record = path.join(root, "calls.jsonl");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const [, ...args] = process.argv.slice(2);
const behavior = JSON.parse(process.env.CLI_BEHAVIOR);
if (args.includes("--help")) {
  if (behavior.lacks === args[0]) process.exit(2);
  process.stdout.write(args[0] === "publish-policy" && behavior.lacks !== "--bootstrap" ? "--bootstrap --renewal\\n" : "usage\\n");
  process.exit(0);
}
const flag = (name) => args[args.indexOf(name) + 1];
const kind = args[0] === "fetch-policy" || args[0] === "publish-policy" ? flag("--kind") : args[0].split("-")[1];
const call = { args, token: process.env.CADENCR_REGISTRY_GITHUB_TOKEN };
if (args[0].startsWith("sign-")) call.payload = JSON.parse(fs.readFileSync(flag("--payload"), "utf8"));
if (args[0].startsWith("sign-") && fs.existsSync(flag("--private-key"))) call.keyBytes = fs.readFileSync(flag("--private-key"), "utf8");
fs.appendFileSync(process.env.CALLS, JSON.stringify(call) + "\\n");
if (behavior.fail === args[0].split("-")[0] + ":" + kind) process.exit(1);
if (args[0] === "fetch-policy") {
  if (!behavior.present?.includes(kind)) { process.stderr.write("managed-" + kind + " does not exist on marketplace-v2\\nsecond line\\n"); process.exit(1); }
  fs.writeFileSync(flag("--output"), "{}");
}
if (args[0].startsWith("sign-")) fs.writeFileSync(flag("--output"), "{}");
if (args[0] === "publish-policy" && args.includes("--receipt")) fs.writeFileSync(flag("--receipt"), "{}");
`,
  );
  chmodSync(cli, 0o700);
  const work = reuseWork ?? path.join(root, "work");
  const before = Math.floor(Date.now() / 1000);
  const result = helper(["bootstrap-policies", work], {
    ...configuration(),
    CADENCR_REGISTRY_GITHUB_TOKEN: "test-token-value",
    PRIVATE_KEY_FILE: path.join(root, "private.pem"),
    VERIFIED_CLI: cli,
    CALLS: record,
    CLI_BEHAVIOR: JSON.stringify(behavior),
    ...env,
  });
  const after = Math.ceil(Date.now() / 1000);
  const calls = existsSync(record)
    ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { result, calls, work, root, before, after };
}

const flagOf = (call, name) => call.args[call.args.indexOf(name) + 1];
const summary = (calls) => calls.map((c) => `${c.args[0]}${c.args.includes("--kind") ? ":" + flagOf(c, "--kind") : ""}`);

test("bootstrap-check demands the exact confirmation and a configuration on the fixed branch", (t) => {
  const ok = helper(["bootstrap-check"], configuration());
  assert.equal(ok.status, 0, ok.stderr);
  // Policy URLs are optional (the catalog may not exist yet), but a configured one must fit.
  const all = helper(["bootstrap-check"], configuration({
    CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: feedUrl("provider"),
    CADENCR_REGISTRY_THEME_BLOCKLIST_URL: feedUrl("theme"),
    CADENCR_REGISTRY_TAB_BLOCKLIST_URL: feedUrl("tab"),
  }));
  assert.equal(all.status, 0, all.stderr);
  const refused = {
    "no confirmation": { CONFIRM_BOOTSTRAP: "" },
    "a near-miss confirmation": { CONFIRM_BOOTSTRAP: "bootstrap-empty-policies " },
    "another confirmation": { CONFIRM_BOOTSTRAP: "yes" },
    "no key id": { CADENCR_REGISTRY_KEY_ID: "" },
    "no public key": { CADENCR_REGISTRY_PUBLIC_KEY_PEM: "" },
    "no repository": { GITHUB_REPOSITORY: "" },
    "a foreign repository URL": { CADENCR_REGISTRY_TAB_BLOCKLIST_URL: feedUrl("tab", "marketplace-v2", "evil/registry") },
    "another branch": { CADENCR_REGISTRY_THEME_BLOCKLIST_URL: feedUrl("theme", "main") },
    "another kind's file": { CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: feedUrl("theme") },
    "a non-GitHub URL": { CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: "https://example.com/managed-blocklist.json" },
    "a query string": { CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: feedUrl("provider") + "?x=1" },
  };
  for (const [label, extra] of Object.entries(refused)) {
    const result = helper(["bootstrap-check"], configuration(extra));
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /policy bootstrap guard/, label);
  }
});

test("bootstrap signs, verifies and bootstrap-publishes an empty policy of each kind with fixed arguments", (t) => {
  const run = runBootstrap(t, {
    env: {
      CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: feedUrl("provider"),
      CADENCR_REGISTRY_THEME_BLOCKLIST_URL: feedUrl("theme"),
      CADENCR_REGISTRY_TAB_BLOCKLIST_URL: feedUrl("tab"),
    },
  });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(summary(run.calls), [
    "fetch-policy:provider", "sign-provider-blocklist", "verify-provider-blocklist", "publish-policy:provider",
    "fetch-policy:theme", "sign-theme-blocklist", "verify-theme-blocklist", "publish-policy:theme",
    "fetch-policy:tab", "sign-tab-blocklist", "verify-tab-blocklist", "publish-policy:tab",
  ]);
  for (const kind of ["provider", "theme", "tab"]) {
    const [fetch, sign, verify, publish] = run.calls.filter(
      (c) => c.args.includes(kind) || c.args[0].includes(`-${kind}-`),
    );
    assert.ok(fetch && sign && verify && publish, kind);
    // Entries are empty; only the theme and tab policies carry a kind.
    const { payload } = sign;
    assert.equal(payload.schema_version, 1);
    assert.deepEqual(payload.entries, []);
    assert.deepEqual(
      Object.keys(payload),
      kind === "provider"
        ? ["schema_version", "generated_at", "expires_at", "entries"]
        : ["schema_version", "kind", "generated_at", "expires_at", "entries"],
    );
    if (kind !== "provider") assert.equal(payload.kind, `${kind}-blocklist`);
    // Canonical whole-second UTC, now, and the renewal's 13 day horizon (max 14).
    for (const stamp of [payload.generated_at, payload.expires_at])
      assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const generated = Date.parse(payload.generated_at) / 1000;
    assert.ok(generated >= run.before - 1 && generated <= run.after, "generated_at is now");
    assert.equal(Date.parse(payload.expires_at) - Date.parse(payload.generated_at), 13 * 24 * 3600 * 1000);
    // Fixed arguments.
    assert.equal(flagOf(fetch, "--repository"), "acme/registry");
    assert.equal(flagOf(fetch, "--discovery-branch"), "marketplace-v2");
    assert.equal(flagOf(sign, "--payload"), path.join(run.work, `${kind}-payload.json`));
    assert.equal(flagOf(sign, "--private-key"), path.join(run.root, "private.pem"));
    assert.equal(flagOf(sign, "--key-id"), "registry-key-1");
    assert.equal(flagOf(verify, "--index"), flagOf(sign, "--output"));
    assert.equal(flagOf(verify, "--public-key"), path.join(run.work, "public.pem"));
    assert.equal(flagOf(verify, "--key-id"), "registry-key-1");
    assert.equal(flagOf(publish, "--signed"), flagOf(sign, "--output"));
    assert.equal(flagOf(publish, "--repository"), "acme/registry");
    assert.equal(flagOf(publish, "--discovery-branch"), "marketplace-v2");
    assert.equal(flagOf(publish, "--public-key"), flagOf(verify, "--public-key"));
    assert.equal(flagOf(publish, "--key-id"), "registry-key-1");
    assert.ok(publish.args.includes("--bootstrap"));
    assert.ok(!publish.args.includes("--renewal"));
    // The token reaches only the calls that talk to GitHub, through the environment.
    assert.equal(fetch.token, "test-token-value");
    assert.equal(sign.token, undefined);
    assert.equal(verify.token, undefined);
    assert.equal(publish.token, "test-token-value");
  }
  assert.equal(readFileSync(path.join(run.work, "public.pem"), "utf8"), pem + "\n");
  assert.equal(statSync(run.work).mode & 0o777, 0o700);
  for (const call of run.calls) assert.equal(call.args.join(" ").includes("test-token-value"), false);
  assert.match(run.result.stdout, /Bootstrapping policy/);
});

test("a policy already on the branch is skipped, never signed or replaced", (t) => {
  const run = runBootstrap(t, { behavior: { present: ["theme"] } });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(summary(run.calls), [
    "fetch-policy:provider", "sign-provider-blocklist", "verify-provider-blocklist", "publish-policy:provider",
    "fetch-policy:theme",
    "fetch-policy:tab", "sign-tab-blocklist", "verify-tab-blocklist", "publish-policy:tab",
  ]);
  assert.match(run.result.stdout, /::notice title=Policy already published::the theme policy/);
  const all = runBootstrap(t, { behavior: { present: ["provider", "theme", "tab"] } });
  assert.equal(all.result.status, 0, all.result.stderr);
  assert.deepEqual(summary(all.calls), ["fetch-policy:provider", "fetch-policy:theme", "fetch-policy:tab"]);
});

test("every policy is attempted after a failure, which then fails the step", (t) => {
  for (const [fail, stopsAfter] of [
    ["sign:provider", "sign-provider-blocklist"],
    ["verify:provider", "verify-provider-blocklist"],
    ["publish:provider", "publish-policy:provider"],
  ]) {
    const run = runBootstrap(t, { behavior: { fail } });
    assert.notEqual(run.result.status, 0, fail);
    assert.match(run.result.stderr, /policy bootstrap failed for: provider$/m);
    assert.match(run.result.stdout, /::error title=Policy bootstrap failed::the provider policy/);
    const done = summary(run.calls);
    assert.equal(done.indexOf(stopsAfter) >= 0, true, fail);
    assert.equal(done.at(done.indexOf(stopsAfter) + 1), "fetch-policy:theme", `nothing after ${fail}`);
    assert.ok(done.includes("publish-policy:theme") && done.includes("publish-policy:tab"), fail);
  }
  const several = runBootstrap(t, { behavior: { fail: "sign:theme" } });
  assert.match(several.result.stderr, /policy bootstrap failed for: theme$/m);
  assert.ok(!summary(several.calls).includes("publish-policy:theme"), "never publishes an unsigned policy");
});

test("an unreadable policy still goes through bootstrap, which is what refuses an existing one", (t) => {
  // The fake fetch fails for every kind, whatever the reason: the bootstrap flag
  // is the authority, so the existence check alone can never overwrite.
  const run = runBootstrap(t);
  assert.equal(run.result.status, 0, run.result.stderr);
  for (const call of run.calls.filter((c) => c.args[0] === "publish-policy"))
    assert.ok(call.args.includes("--bootstrap"));
  assert.match(run.result.stdout, /refuses an existing policy/);
});

test("bootstrap fails closed on bad configuration before touching the CLI", (t) => {
  const cases = {
    "no confirmation": { CONFIRM_BOOTSTRAP: "" },
    "a wrong confirmation": { CONFIRM_BOOTSTRAP: "yes" },
    "a foreign policy URL": { CADENCR_REGISTRY_THEME_BLOCKLIST_URL: feedUrl("theme", "marketplace-v2", "evil/registry") },
    "another branch": { CADENCR_REGISTRY_TAB_BLOCKLIST_URL: feedUrl("tab", "main") },
    "no token": { CADENCR_REGISTRY_GITHUB_TOKEN: "" },
    "no key file": { PRIVATE_KEY_FILE: "" },
    "no key id": { CADENCR_REGISTRY_KEY_ID: "" },
    "no cli": { VERIFIED_CLI: "" },
  };
  for (const [label, env] of Object.entries(cases)) {
    const run = runBootstrap(t, { env });
    assert.notEqual(run.result.status, 0, label);
    assert.match(run.result.stderr, /policy bootstrap guard/, label);
    assert.deepEqual(run.calls, [], `${label} must not reach the CLI`);
    assert.equal(existsSync(run.work), false, label);
  }
});

test("bootstrap names an old pinned CLI instead of failing obscurely", (t) => {
  for (const [lacks, missing] of [
    ["fetch-policy", "fetch-policy"],
    ["publish-policy", "publish-policy"],
    ["--bootstrap", "publish-policy --bootstrap"],
    ["sign-tab-blocklist", "sign-tab-blocklist"],
    ["verify-provider-blocklist", "verify-provider-blocklist"],
  ]) {
    const run = runBootstrap(t, { behavior: { lacks } });
    assert.notEqual(run.result.status, 0, lacks);
    assert.match(run.result.stderr, new RegExp(`lacks registry ${missing}; update ci/released-cli\\.env`));
    assert.deepEqual(run.calls, []);
  }
});

test("bootstrap refuses an existing work directory", (t) => {
  const first = runBootstrap(t);
  assert.equal(first.result.status, 0, first.result.stderr);
  const again = runBootstrap(t, { reuseWork: first.work });
  assert.notEqual(again.result.status, 0);
});

test("the key written for the run is gone afterwards, also when the bootstrap fails", (t) => {
  for (const behavior of [{}, { fail: "publish:tab" }]) {
    const { root, output } = sandbox(t);
    const created = helper(["materialize-key", keyPrefix], {
      CADENCR_REGISTRY_PRIVATE_KEY_PEM: "test-private-key",
      PRIVATE_KEY_ROOT: root,
      GITHUB_OUTPUT: output,
    });
    assert.equal(created.status, 0, created.stderr);
    const file = readFileSync(output, "utf8").trim().slice("private_key_file=".length);
    const run = runBootstrap(t, { behavior, env: { PRIVATE_KEY_FILE: file } });
    assert.equal(run.result.status === 0, behavior.fail === undefined);
    // The signer is handed the key by path and reads the materialized bytes.
    assert.equal(run.calls.find((c) => c.args[0] === "sign-provider-blocklist").keyBytes, "test-private-key");
    const cleaned = helper(["remove-key", keyPrefix], { PRIVATE_KEY_FILE: file, PRIVATE_KEY_ROOT: root });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(file), false);
    // The key is never copied into the work directory.
    assert.equal(existsSync(path.join(run.work, "private.pem")), false);
    assert.doesNotMatch(readFileSync(path.join(run.work, "provider-payload.json"), "utf8"), /test-private-key/);
  }
});
