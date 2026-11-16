import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const readUrl = (relative) => new URL(relative, import.meta.url);
const source = readFileSync(readUrl("../.github/workflows/renew-protected-catalog.yml"), "utf8");
const publisherSource = readFileSync(
  readUrl("../.github/workflows/publish-protected-catalog.yml"),
  "utf8",
);
const prepareSource = readFileSync(
  readUrl("../.github/workflows/prepare-protected-publication.yml"),
  "utf8",
);
const workflow = parse(source);
const publisher = parse(publisherSource);
const script = readUrl("../scripts/ci/registry-feeds.sh").pathname;
const defaultBranch = "github.ref_name == github.event.repository.default_branch";

test("renewal runs on a daily schedule (a no-op until due) or manual dispatch, with no inputs or other triggers", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule.length, 1);
  const [minute, hour, day, month, weekday] = workflow.on.schedule[0].cron.split(" ");
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  assert.deepEqual([day, month, weekday], ["*", "*", "*"], "daily, so failures are retried");
  // A dispatch carries no operator input that could steer the request.
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.doesNotMatch(source, /\binputs\./);
  assert.doesNotMatch(source, /^  (pull_request|push|workflow_run):/m);
});

test("renewal shares the publication concurrency lane and never cancels", () => {
  assert.deepEqual(workflow.concurrency, publisher.concurrency);
  assert.deepEqual(workflow.concurrency, {
    group: "marketplace-publication",
    "cancel-in-progress": false,
  });
  assert.match(prepareSource, /group: marketplace-publication/);
  // The supersede trade-off of the shared lane is documented where it is set.
  assert.match(
    source,
    /supersedes that\n  # pending publication, which must then be re-dispatched/,
  );
});

test("renewal uses its own protected environment, distinct from publication", () => {
  const publication = publisher.jobs.publish.environment;
  assert.equal(workflow.jobs.renew.environment, "protected-marketplace-renewal");
  // Up to four published files, each waiting out the raw CDN cache (~6 min).
  assert.equal(workflow.jobs.renew["timeout-minutes"], 60);
  assert.notEqual(workflow.jobs.renew.environment, publication);
  assert.equal(workflow.jobs.gate.environment, undefined, "gate needs no environment");
  assert.match(source, /default branch/);
  // The gate is the single default-branch check; `renew` can only run after it.
  assert.equal(workflow.jobs.gate.if, defaultBranch);
  assert.equal(workflow.jobs.renew.needs, "gate");
  assert.equal(workflow.jobs.renew.if, "needs.gate.outputs.configured == 'true'");
});

test("permissions are minimal and secrets appear only in the key and publish steps", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions, undefined);
  assert.doesNotMatch(source, /id-token|contents: write|upload-artifact|download-artifact/);
  assert.equal(JSON.stringify(workflow.jobs.gate).includes("secrets."), false);
  const holders = workflow.jobs.renew.steps.filter((step) =>
    JSON.stringify(step).includes("secrets."),
  );
  assert.deepEqual(
    holders.map((step) => step.name),
    [
      "Materialize protected signing key",
      "Renew the signed catalog",
      "Renew the revocation policies",
    ],
  );
  const lifecycle = workflow.jobs.renew.steps.filter((s) =>
    /(?:materialize|remove)-key/.test(s.run ?? ""),
  );
  assert.deepEqual(
    lifecycle.map((s) => s.run),
    [
      "sh scripts/ci/registry-feeds.sh materialize-key marketplace-renewal-secret-",
      "sh scripts/ci/registry-feeds.sh remove-key marketplace-renewal-secret-",
    ],
  );
  assert.equal([...source.matchAll(/secrets\.CADENCR_REGISTRY_PRIVATE_KEY_PEM/g)].length, 1);
  // The token feeds the catalog step and the policy step, nothing else.
  assert.equal([...source.matchAll(/secrets\.CADENCR_REGISTRY_GITHUB_TOKEN/g)].length, 2);
  const names = workflow.jobs.renew.steps.map((step) => step.name ?? step.uses);
  assert.ok(
    names.indexOf("Select verified publisher runtime") <
      names.indexOf("Materialize protected signing key"),
  );
  assert.ok(
    names.indexOf("Build renewal-only request") <
      names.indexOf("Materialize protected signing key"),
  );
  // Policies are planned (no secrets) before the key exists, renewed after the catalog.
  assert.ok(
    names.indexOf("Plan revocation policy renewals") <
      names.indexOf("Materialize protected signing key"),
  );
  assert.ok(
    names.indexOf("Renew the signed catalog") < names.indexOf("Renew the revocation policies"),
  );
  assert.ok(
    names.indexOf("Renew the revocation policies") <
      names.indexOf("Remove materialized signing key"),
  );
});

test("renewal is inert until configured and fails loudly afterwards", () => {
  assert.equal(workflow.jobs.renew.needs, "gate");
  assert.equal(workflow.jobs.renew.if.includes("needs.gate.outputs.configured == 'true'"), true);
  assert.match(workflow.jobs.gate.steps.at(-1).run, /registry-feeds\.sh gate renewal/);
  const steps = Object.fromEntries(workflow.jobs.renew.steps.map((step) => [step.name, step]));
  const runs = "!cancelled()";
  assert.equal(
    steps["Materialize protected signing key"].if,
    `\${{ ${runs} && steps.publisher_runtime.outcome == 'success' && (steps.request.outputs.needed == 'true' || steps.policies.outputs.needed == 'true') }}`,
  );
  assert.equal(
    steps["Renew the signed catalog"].if,
    `\${{ ${runs} && steps.request.outputs.needed == 'true' && steps.materialize_key.outputs.private_key_file != '' }}`,
  );
  assert.equal(
    steps["Renew the revocation policies"].if,
    `\${{ ${runs} && steps.policies.outputs.needed == 'true' && steps.materialize_key.outputs.private_key_file != '' }}`,
  );
  assert.equal(JSON.stringify(workflow).includes("continue-on-error"), false);
});

// Evaluate a step `if` the way Actions does for the subset the workflow uses:
// status functions, step outcomes, step outputs, ==, !=, &&, || and !.
function simulateRenewJob(failing, { needed = true } = {}) {
  const outcomes = {};
  const outputs = {};
  const ran = [];
  let failed = false;
  for (const step of workflow.jobs.renew.steps) {
    const label = step.name ?? step.uses;
    const condition = step.if === undefined ? undefined : String(step.if);
    const hasStatus = /\b(?:always|cancelled|failure|success)\(\)/.test(condition ?? "");
    let run = true;
    if (condition !== undefined) {
      const expression = condition
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/always\(\)/g, "true")
        .replace(/!cancelled\(\)/g, "true")
        .replace(/steps\.(\w+)\.outcome/g, (_, id) => JSON.stringify(outcomes[id] ?? ""))
        .replace(/steps\.(\w+)\.outputs\.(\w+)/g, (_, id, name) =>
          JSON.stringify(outputs[id]?.[name] ?? ""),
        )
        .replace(/==/g, "===")
        .replace(/!=/g, "!==");
      run = Function(`return (${expression});`)();
    }
    if (!hasStatus && failed) run = false;
    const outcome = !run ? "skipped" : failing.has(label) ? "failure" : "success";
    if (step.id) outcomes[step.id] = outcome;
    if (run) ran.push(label);
    if (outcome === "failure") failed = true;
    if (outcome === "success" && needed) {
      if (step.id === "request" || step.id === "policies") outputs[step.id] = { needed: "true" };
      if (step.id === "materialize_key") outputs[step.id] = { private_key_file: "/tmp/key.pem" };
    }
  }
  return { ran, failed };
}

test("catalog and policy renewal are independent in both directions, and any failure fails the job", () => {
  const renewCatalog = "Renew the signed catalog";
  const renewPolicies = "Renew the revocation policies";
  const policyStages = [
    "Download the current published revocation policies",
    "Plan revocation policy renewals",
    renewPolicies,
  ];
  const catalogStages = [
    "Download the current published catalog",
    "Build renewal-only request",
    renewCatalog,
  ];
  const cleanup = "Remove materialized signing key";

  const healthy = simulateRenewJob(new Set());
  assert.equal(healthy.failed, false);
  for (const name of [...catalogStages, ...policyStages, cleanup])
    assert.ok(healthy.ran.includes(name), name);

  // Nothing due: no key is ever materialized.
  const idle = simulateRenewJob(new Set(), { needed: false });
  assert.equal(idle.ran.includes("Materialize protected signing key"), false);

  // A failure anywhere in the policy stages (e.g. a 404 on an un-bootstrapped
  // policy) still renews the catalog, and fails the job.
  for (const failing of policyStages) {
    const result = simulateRenewJob(new Set([failing]));
    assert.equal(result.failed, true, failing);
    for (const name of catalogStages)
      assert.ok(result.ran.includes(name), `${name} after ${failing}`);
    assert.ok(result.ran.includes(cleanup), failing);
  }
  // ... and the reverse: a catalog failure at any stage still renews the policies.
  for (const failing of catalogStages) {
    const result = simulateRenewJob(new Set([failing]));
    assert.equal(result.failed, true, failing);
    for (const name of policyStages)
      assert.ok(result.ran.includes(name), `${name} after ${failing}`);
    assert.ok(result.ran.includes(cleanup), failing);
  }
  // Without the verified CLI nothing is renewed or signed, but the key is never left behind.
  const noRuntime = simulateRenewJob(new Set(["Select verified publisher runtime"]));
  assert.equal(noRuntime.failed, true);
  for (const name of ["Materialize protected signing key", renewCatalog, renewPolicies]) {
    assert.equal(noRuntime.ran.includes(name), false, name);
  }
  // The stage conditions name only their own prerequisites.
  const condition = (name) => String(workflow.jobs.renew.steps.find((s) => s.name === name).if);
  for (const name of catalogStages.slice(1)) assert.doesNotMatch(condition(name), /polic/, name);
  for (const name of policyStages) assert.doesNotMatch(condition(name), /request|catalog/, name);
});

test("renewal pins the checkout and the exact released CLI through the trusted selector", () => {
  assert.equal(
    workflow.jobs.renew.steps.filter((s) => s.uses?.startsWith("actions/checkout@")).length,
    1,
  );
  const checkout = workflow.jobs.renew.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  for (const action of source.matchAll(/uses: ([^\n ]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
  const selector = workflow.jobs.renew.steps.find(
    (s) => s.name === "Select verified publisher runtime",
  );
  assert.equal(selector.run, "sh scripts/ci/select-publisher-runtime.sh");
  const publish = workflow.jobs.renew.steps.find((s) => s.name === "Renew the signed catalog");
  assert.equal(publish.env.VERIFIED_CLI, "${{ steps.publisher_runtime.outputs.cli_file }}");
  assert.doesNotMatch(source, /npm|pnpm|yarn|scripts\/[\w-]+\.mjs|cargo|releases\/download/);
});

test("the only publishing command is the guarded renewal helper, never a reviewed request", () => {
  const publish = workflow.jobs.renew.steps.find((s) => s.name === "Renew the signed catalog");
  assert.match(publish.run, /registry-feeds\.sh publish/);
  const policies = workflow.jobs.renew.steps.find(
    (s) => s.name === "Renew the revocation policies",
  );
  assert.match(policies.run, /registry-feeds\.sh renew-policies/);
  assert.equal(policies.env.VERIFIED_CLI, "${{ steps.publisher_runtime.outputs.cli_file }}");
  assert.doesNotMatch(source, /publish-registry|confirm-request-sha256|publication-request\.json/);
  const request = workflow.jobs.renew.steps.find((s) => s.name === "Build renewal-only request");
  assert.match(request.run, /registry-feeds\.sh prepare/);
  assert.doesNotMatch(JSON.stringify(workflow), /submission|mirror|promote|upload/i);
  const helper = readFileSync(script, "utf8");
  assert.match(helper, /request\.publications = \[\]/);
  assert.match(helper, /publications must be empty/);
});

// ---- executable behavior of the helper ----------------------------------

function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "renewal-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "github-output");
  writeFileSync(output, "");
  return { root, output };
}

function helper(args, env = {}, options = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("CADENCR_REGISTRY_")) delete clean[key];
  return spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { ...clean, ...env },
    ...options,
  });
}

const pem =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAplaceholderplaceholderplaceholder0=\n-----END PUBLIC KEY-----";
const url = (branch = "marketplace-v2", repository = "acme/registry") =>
  `https://raw.githubusercontent.com/${repository}/refs/heads/${branch}/managed-index.json`;
const policyFiles = {
  provider: "managed-blocklist.json",
  theme: "managed-theme-blocklist.json",
  tab: "managed-tab-blocklist.json",
};
const policyUrl = (kind, branch = "marketplace-v2", repository = "acme/registry") =>
  `https://raw.githubusercontent.com/${repository}/refs/heads/${branch}/${policyFiles[kind]}`;
const policyVars = () => ({
  CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: policyUrl("provider"),
  CADENCR_REGISTRY_THEME_BLOCKLIST_URL: policyUrl("theme"),
  CADENCR_REGISTRY_TAB_BLOCKLIST_URL: policyUrl("tab"),
});
const renewalVars = (extra = {}) => ({
  CADENCR_REGISTRY_CATALOG_URL: url(),
  ...policyVars(),
  CADENCR_REGISTRY_KEY_ID: "registry-key-1",
  CADENCR_REGISTRY_PUBLIC_KEY_PEM: pem,
  ...extra,
});

test("gate: unset is a notice and configured=false; partial configuration is an error", (t) => {
  const { output } = sandbox(t);
  const inert = helper(["gate", "renewal"], { GITHUB_OUTPUT: output });
  assert.equal(inert.status, 0, inert.stderr);
  assert.match(inert.stdout, /::notice title=Registry renewal is not configured::/);
  assert.equal(readFileSync(output, "utf8"), "configured=false\n");

  for (const missing of [
    "CADENCR_REGISTRY_KEY_ID",
    "CADENCR_REGISTRY_PUBLIC_KEY_PEM",
    "CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL",
    "CADENCR_REGISTRY_THEME_BLOCKLIST_URL",
    "CADENCR_REGISTRY_TAB_BLOCKLIST_URL",
  ]) {
    const { output: out } = sandbox(t);
    const vars = renewalVars();
    delete vars[missing];
    const partial = helper(["gate", "renewal"], { ...vars, GITHUB_OUTPUT: out });
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, new RegExp(`missing repository variables: ${missing}`));
    assert.equal(readFileSync(out, "utf8"), "");
  }

  const { output: half } = sandbox(t);
  const trust = helper(["gate", "renewal"], {
    ...renewalVars({ CADENCR_REGISTRY_ROOT_KEY_ID: "root-1" }),
    GITHUB_OUTPUT: half,
  });
  assert.notEqual(trust.status, 0);
  assert.match(trust.stderr, /configured together/);

  const { output: ok } = sandbox(t);
  const configured = helper(["gate", "renewal"], { ...renewalVars(), GITHUB_OUTPUT: ok });
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(readFileSync(ok, "utf8"), "configured=true\n");
});

test("fetch refuses non-GitHub, credentialed, query and fragment URLs before any request", (t) => {
  const { root } = sandbox(t);
  let index = 0;
  for (const bad of [
    "http://raw.githubusercontent.com/acme/registry/refs/heads/main/managed-index.json",
    "https://example.com/managed-index.json",
    "https://raw.githubusercontent.com@evil.example/x.json",
    "https://raw.githubusercontent.com/acme/registry/refs/heads/main/managed-index.json?token=1",
    "https://raw.githubusercontent.com/acme/registry/refs/heads/main/a b.json",
    "https://raw.githubusercontent.com/acme/registry/refs/heads/main/m.json#x",
  ]) {
    const result = helper(["fetch", path.join(root, `snapshot-${index++}`), "catalog"], {
      CADENCR_REGISTRY_CATALOG_URL: bad,
    });
    assert.notEqual(result.status, 0, bad);
    assert.match(result.stderr, /feed URL/);
  }
});

const stamp = (hours) =>
  new Date(Math.floor(Date.now() / 1000) * 1000 + hours * 3600000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
const catalog = (remainingHours, extra = {}) =>
  JSON.stringify({
    signed: {
      schema_version: 2,
      generated_at: stamp(remainingHours - 24 * 13),
      expires_at: stamp(remainingHours),
      packages: [],
      ...extra,
    },
    signature: {},
  });

function prepare(t, catalogBytes, env = {}) {
  const { root, output } = sandbox(t);
  const snapshot = path.join(root, "snapshot");
  mkdirSync(snapshot);
  writeFileSync(path.join(snapshot, "managed-index.json"), catalogBytes);
  const request = path.join(root, "request");
  const result = helper(["prepare", snapshot, request], {
    GITHUB_REPOSITORY: "acme/registry",
    GITHUB_OUTPUT: output,
    ...renewalVars(env),
  });
  return { result, request, output: readFileSync(output, "utf8"), snapshot };
}

test("prepare skips a healthy catalog and writes nothing", (t) => {
  const healthy = prepare(t, catalog(12 * 24));
  assert.equal(healthy.result.status, 0, healthy.result.stderr);
  assert.equal(healthy.output, "needed=false\n");
  assert.throws(() => statSync(healthy.request), { code: "ENOENT" });
});

test("prepare builds exactly a renewal-only request from the authenticated baseline inputs", (t) => {
  const due = prepare(t, catalog(60));
  assert.equal(due.result.status, 0, due.result.stderr);
  assert.equal(due.output, "needed=true\n");
  assert.deepEqual(
    readFileSync(path.join(due.request, "publication-request.json"), "utf8").split("\n").length > 1,
    true,
  );
  const request = JSON.parse(
    readFileSync(path.join(due.request, "publication-request.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(request), [
    "schema_version",
    "repository",
    "key_id",
    "discovery_branch",
    "generated_at",
    "expires_at",
    "previous_index",
    "public_key",
    "publications",
  ]);
  assert.deepEqual(request.publications, []);
  assert.equal(request.schema_version, 2);
  assert.equal(request.discovery_branch, "marketplace-v2");
  assert.equal(request.repository, "acme/registry");
  assert.equal(request.allow_schema_upgrade, undefined);
  const window = Date.parse(request.expires_at) - Date.parse(request.generated_at);
  assert.equal(window, 13 * 24 * 3600 * 1000);
  assert.equal(
    readFileSync(path.join(due.request, "previous-index.json"), "utf8"),
    readFileSync(path.join(due.snapshot, "managed-index.json"), "utf8"),
  );
  assert.equal(statSync(path.join(due.request, "publication-request.json")).mode & 0o777, 0o600);

  const expired = prepare(t, catalog(-5));
  assert.equal(expired.result.status, 0, expired.result.stderr);
  assert.equal(expired.output, "needed=true\n");
});

test("prepare carries an optional root trust profile and refuses mismatched inputs", (t) => {
  const trusted = prepare(t, catalog(60), {
    CADENCR_REGISTRY_TRUST_MANIFEST_JSON: '{"signed":{},"signature":{}}',
    CADENCR_REGISTRY_ROOT_KEY_ID: "root-1",
    CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM: pem,
    CADENCR_REGISTRY_TRUST_MIN_GENERATION: "3",
  });
  assert.equal(trusted.result.status, 0, trusted.result.stderr);
  const request = JSON.parse(
    readFileSync(path.join(trusted.request, "publication-request.json"), "utf8"),
  );
  assert.deepEqual(request.trust, {
    manifest: "trust-manifest.json",
    root_public_key: "root-public.pem",
    root_key_id: "root-1",
    minimum_generation: 3,
  });
  assert.deepEqual(request.publications, []);

  for (const [label, bytes, env] of [
    [
      "foreign repository",
      catalog(60),
      { CADENCR_REGISTRY_CATALOG_URL: url("marketplace-v2", "evil/registry") },
    ],
    ["schema/branch mismatch", catalog(60), { CADENCR_REGISTRY_CATALOG_URL: url("main") }],
    ["unsupported schema", catalog(60, { schema_version: 3 }), {}],
    ["noncanonical time", catalog(60, { expires_at: "2099-01-01T00:00:00.000Z" }), {}],
    ["not an envelope", "{}", {}],
    ["malformed json", "{", {}],
    ["future generation", catalog(60, { generated_at: stamp(48) }), {}],
    [
      "bad trust generation",
      catalog(60),
      {
        CADENCR_REGISTRY_TRUST_MANIFEST_JSON: "{}",
        CADENCR_REGISTRY_ROOT_KEY_ID: "root-1",
        CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM: pem,
        CADENCR_REGISTRY_TRUST_MIN_GENERATION: "0",
      },
    ],
  ]) {
    const refused = prepare(t, bytes, env);
    assert.notEqual(refused.result.status, 0, label);
    assert.equal(refused.output, "", label);
  }
});

// ---- the renewal-only guard ------------------------------------------------

function renewalDirectory(t, mutate = () => {}) {
  const ready = prepare(t, catalog(60));
  assert.equal(ready.result.status, 0, ready.result.stderr);
  mutate(ready.request);
  const cli = path.join(path.dirname(ready.request), "cadencr");
  const record = path.join(path.dirname(ready.request), "arguments");
  writeFileSync(
    cli,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.ARGS_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(cli, 0o700);
  const state = path.join(path.dirname(ready.request), "state");
  const result = helper(["publish", ready.request, state], {
    GITHUB_REPOSITORY: "acme/registry",
    GITHUB_SHA: "a".repeat(40),
    PRIVATE_KEY_FILE: "/separate/key.pem",
    VERIFIED_CLI: cli,
    ARGS_OUTPUT: record,
  });
  return { result, ready, record, state };
}

const editRequest = (change) => (directory) => {
  const file = path.join(directory, "publication-request.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

test("publish forwards the exact digest of a renewal-only request to the released CLI", (t) => {
  const run = renewalDirectory(t);
  assert.equal(run.result.status, 0, run.result.stderr);
  const requestFile = path.join(run.ready.request, "publication-request.json");
  assert.deepEqual(JSON.parse(readFileSync(run.record, "utf8")), [
    "registry",
    "publish-registry",
    "--request",
    requestFile,
    "--directory",
    run.state,
    "--repository",
    "acme/registry",
    "--registry-commit",
    "a".repeat(40),
    "--private-key",
    "/separate/key.pem",
    "--confirm-request-sha256",
    createHash("sha256").update(readFileSync(requestFile)).digest("hex"),
  ]);
});

test("publish fails closed on any package, submission or request change", (t) => {
  const cases = {
    "a publication entry": editRequest((r) => {
      r.publications = [{ submission: "s.json" }];
    }),
    "a missing publications field": editRequest((r) => {
      delete r.publications;
    }),
    "null publications": editRequest((r) => {
      r.publications = null;
    }),
    "a schema upgrade": editRequest((r) => {
      r.allow_schema_upgrade = true;
    }),
    "an unknown field": editRequest((r) => {
      r.extra = 1;
    }),
    bootstrap: editRequest((r) => {
      r.previous_index = "bootstrap";
    }),
    "another baseline path": editRequest((r) => {
      r.previous_index = "../other.json";
    }),
    "another repository": editRequest((r) => {
      r.repository = "evil/registry";
    }),
    "a window over fourteen days": editRequest((r) => {
      r.expires_at = stamp(15 * 24);
    }),
    "an unexpected trust object": editRequest((r) => {
      r.trust = { manifest: "x" };
    }),
    "a smuggled submission file": (d) => writeFileSync(path.join(d, "submission.json"), "{}"),
    "a stray trust file": (d) => writeFileSync(path.join(d, "trust-manifest.json"), "{}"),
    "a symlinked baseline": (d) => {
      rmSync(path.join(d, "previous-index.json"));
      symlinkSync("/etc/hosts", path.join(d, "previous-index.json"));
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const run = renewalDirectory(t, mutate);
    assert.notEqual(run.result.status, 0, label);
    assert.match(run.result.stderr, /renewal-only guard/, label);
    assert.throws(
      () => readFileSync(run.record),
      { code: "ENOENT" },
      `${label} must not reach the CLI`,
    );
    assert.throws(() => statSync(run.state), { code: "ENOENT" }, label);
  }
});

test("signing key materialization and cleanup are owned, private and refuse foreign paths", (t) => {
  const { root, output } = sandbox(t);
  const created = helper(["materialize-key", "marketplace-renewal-secret-"], {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "test-private-key",
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: output,
  });
  assert.equal(created.status, 0, created.stderr);
  const file = readFileSync(output, "utf8").trim().slice("private_key_file=".length);
  assert.equal(readFileSync(file, "utf8"), "test-private-key");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);

  const cleaned = helper(["remove-key", "marketplace-renewal-secret-"], {
    PRIVATE_KEY_FILE: file,
    PRIVATE_KEY_ROOT: root,
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.throws(() => statSync(file), { code: "ENOENT" });

  const foreign = path.join(root, "private.pem");
  writeFileSync(foreign, "operator-owned");
  const refused = helper(["remove-key", "marketplace-renewal-secret-"], {
    PRIVATE_KEY_FILE: foreign,
    PRIVATE_KEY_ROOT: root,
  });
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(foreign, "utf8"), "operator-owned");

  const { output: oversized } = sandbox(t);
  const large = helper(["materialize-key", "marketplace-renewal-secret-"], {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "x".repeat(16 * 1024 + 1),
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: oversized,
  });
  assert.notEqual(large.status, 0);
  assert.equal(readFileSync(oversized, "utf8"), "");
  const unknown = helper(["bogus"]);
  assert.notEqual(unknown.status, 0);
});

// ---- bounded, status-checked downloads (fake curl) -------------------------

function fakeCurl(t, behavior, scope = "catalog") {
  const { root } = sandbox(t);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const record = path.join(root, "curl-arguments");
  writeFileSync(
    path.join(bin, "curl"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CURL_ARGS, JSON.stringify(args));
const behavior = JSON.parse(process.env.CURL_BEHAVIOR);
if (behavior.exit) process.exit(behavior.exit);
fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.alloc(behavior.bytes, "x"));
process.stdout.write(String(behavior.status));
`,
  );
  chmodSync(path.join(bin, "curl"), 0o700);
  const snapshot = path.join(root, "snapshot");
  const result = helper(["fetch", snapshot, scope], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CURL_ARGS: record,
    CURL_BEHAVIOR: JSON.stringify(behavior),
    CADENCR_REGISTRY_CATALOG_URL: url(),
    ...policyVars(),
  });
  return { result, record, snapshot, file: path.join(snapshot, "managed-index.json") };
}

test("fetch accepts only HTTP 200 with a bounded body and never follows redirects", (t) => {
  const ok = fakeCurl(t, { status: 200, bytes: 10 });
  assert.equal(ok.result.status, 0, ok.result.stderr);
  assert.equal(statSync(ok.file).size, 10);
  assert.deepEqual(
    readdirSync(ok.snapshot),
    ["managed-index.json"],
    "catalog scope fetches only the catalog",
  );
  const args = JSON.parse(readFileSync(ok.record, "utf8"));
  assert.ok(args.includes("--fail"));
  assert.ok(!args.includes("--location") && !args.includes("-L"));
  assert.equal(args[args.indexOf("--max-redirs") + 1], "0");
  assert.equal(args[args.indexOf("--proto") + 1], "=https");
  assert.equal(args[args.indexOf("--max-filesize") + 1], String(32 * 1024 * 1024));
  assert.equal(args.at(-1), url());

  // curl exits 0 on a 3xx when redirects are not followed; the status gate catches it.
  for (const status of [301, 302, 204]) {
    const refused = fakeCurl(t, { status, bytes: 10 });
    assert.notEqual(refused.result.status, 0, String(status));
    assert.match(refused.result.stderr, new RegExp(`unexpected HTTP status ${status}`));
    assert.throws(() => statSync(refused.file), { code: "ENOENT" }, "no redirect body is kept");
  }

  const failed = fakeCurl(t, { exit: 22 });
  assert.notEqual(failed.result.status, 0);
  assert.match(failed.result.stderr, /could not download/);

  // A body past the cap is refused even when curl could not enforce it (no Content-Length).
  const oversized = fakeCurl(t, { status: 200, bytes: 32 * 1024 * 1024 + 1 });
  assert.notEqual(oversized.result.status, 0);
  assert.match(oversized.result.stderr, /exceeds 33554432 bytes/);
  assert.throws(() => statSync(oversized.file), { code: "ENOENT" });
  const atCap = fakeCurl(t, { status: 200, bytes: 32 * 1024 * 1024 });
  assert.equal(atCap.result.status, 0, atCap.result.stderr);

  const empty = fakeCurl(t, { status: 200, bytes: 0 });
  assert.notEqual(empty.result.status, 0);
  assert.match(empty.result.stderr, /empty download/);
});

test("fetch scopes: policies downloads exactly the three revocation feeds, unknown scopes fail first", (t) => {
  const policies = fakeCurl(t, { status: 200, bytes: 10 }, "policies");
  assert.equal(policies.result.status, 0, policies.result.stderr);
  assert.deepEqual(readdirSync(policies.snapshot).sort(), Object.values(policyFiles).sort());
  const all = fakeCurl(t, { status: 200, bytes: 10 }, "all");
  assert.equal(all.result.status, 0, all.result.stderr);
  assert.equal(readdirSync(all.snapshot).length, 4);
  const unknown = fakeCurl(t, { status: 200, bytes: 10 }, "everything");
  assert.notEqual(unknown.result.status, 0);
  assert.match(unknown.result.stderr, /unknown fetch scope/);
  assert.throws(
    () => statSync(unknown.snapshot),
    { code: "ENOENT" },
    "no directory for a bad scope",
  );
  const foreign = helper(["fetch", path.join(sandbox(t).root, "snapshot"), "policies"], {
    ...policyVars(),
    CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: "https://example.com/managed-blocklist.json",
  });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /feed URL/);
});

// ---- revocation policy renewal --------------------------------------------

const policy = (remainingHours, extra = {}) =>
  JSON.stringify({
    signed: {
      schema_version: 1,
      generated_at: stamp(remainingHours - 24 * 13),
      expires_at: stamp(remainingHours),
      entries: [],
      ...extra,
    },
    signature: {},
  });

function planPolicies(t, remaining, env = {}, mutate = () => {}) {
  const { root, output } = sandbox(t);
  const snapshot = path.join(root, "snapshot");
  mkdirSync(snapshot);
  for (const [kind, file] of Object.entries(policyFiles)) {
    writeFileSync(path.join(snapshot, file), policy(remaining[kind] ?? 12 * 24));
  }
  mutate(snapshot);
  const work = path.join(root, "work");
  const result = helper(["prepare-policies", snapshot, work], {
    GITHUB_REPOSITORY: "acme/registry",
    GITHUB_OUTPUT: output,
    CADENCR_REGISTRY_CATALOG_URL: url(),
    CADENCR_REGISTRY_PUBLIC_KEY_PEM: pem,
    ...policyVars(),
    ...env,
  });
  return {
    result,
    work,
    snapshot,
    root,
    output: readFileSync(output, "utf8"),
    logs: result.stdout,
  };
}

test("prepare-policies skips healthy policies and writes nothing", (t) => {
  const healthy = planPolicies(t, {});
  assert.equal(healthy.result.status, 0, healthy.result.stderr);
  assert.equal(healthy.output, "needed=false\n");
  assert.throws(() => statSync(healthy.work), { code: "ENOENT" });
  // Exactly the threshold (8 days) is due; one hour more is not.
  assert.equal(planPolicies(t, { theme: 8 * 24 + 1 }).output, "needed=false\n");
  assert.equal(planPolicies(t, { theme: 8 * 24 }).output, "needed=true\n");
});

test("prepare-policies plans each due policy independently, expired ones included", (t) => {
  for (const [remaining, expected] of [
    [{ provider: 60 }, ["provider"]],
    [{ theme: 100 }, ["theme"]],
    [{ tab: -5 }, ["tab"]],
    [{ provider: 10, theme: -1, tab: 190 }, ["provider", "theme", "tab"]],
  ]) {
    const plan = planPolicies(t, remaining);
    assert.equal(plan.result.status, 0, plan.result.stderr);
    assert.equal(plan.output, "needed=true\n");
    const written = JSON.parse(readFileSync(path.join(plan.work, "plan.json"), "utf8"));
    assert.deepEqual(
      written.policies.map((entry) => entry.kind),
      expected,
    );
    for (const entry of written.policies) {
      assert.deepEqual(entry, {
        kind: entry.kind,
        file: policyFiles[entry.kind],
        branch: "marketplace-v2",
      });
    }
    assert.equal(statSync(path.join(plan.work, "plan.json")).mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(plan.work, "public.pem"), "utf8"), /BEGIN PUBLIC KEY/);
  }
  // Every policy lives on the catalog's own branch.
  for (const kind of Object.keys(policyFiles)) {
    const other = planPolicies(
      t,
      { [kind]: 10 },
      { [`CADENCR_REGISTRY_${kind.toUpperCase()}_BLOCKLIST_URL`]: policyUrl(kind, "main") },
    );
    assert.notEqual(other.result.status, 0, `${kind} on main`);
    assert.match(other.result.stderr, /must name the catalog's discovery branch marketplace-v2/);
    assert.equal(other.output, "", kind);
    assert.throws(() => statSync(other.work), { code: "ENOENT" });
  }
  // On a catalog branch other than marketplace-v2 all policies follow it.
  const moved = planPolicies(
    t,
    { provider: 10 },
    {
      CADENCR_REGISTRY_CATALOG_URL: url("release-2"),
      CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: policyUrl("provider", "release-2"),
      CADENCR_REGISTRY_THEME_BLOCKLIST_URL: policyUrl("theme", "release-2"),
      CADENCR_REGISTRY_TAB_BLOCKLIST_URL: policyUrl("tab", "release-2"),
    },
  );
  assert.equal(moved.result.status, 0, moved.result.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(moved.work, "plan.json"), "utf8")).policies[0].branch,
    "release-2",
  );
});

test("prepare-policies refuses foreign, mis-named, malformed or future policies", (t) => {
  const cases = {
    "a foreign repository": [
      {},
      {
        CADENCR_REGISTRY_THEME_BLOCKLIST_URL: policyUrl("theme", "marketplace-v2", "evil/registry"),
      },
    ],
    "another file name": [{}, { CADENCR_REGISTRY_TAB_BLOCKLIST_URL: policyUrl("theme") }],
    "a query string": [
      {},
      { CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: `${policyUrl("provider")}?x=1` },
    ],
    "a nested branch": [
      {},
      { CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: policyUrl("provider", "a/b") },
    ],
    "a future generation": [
      { theme: 60 },
      {},
      (d) =>
        writeFileSync(path.join(d, policyFiles.theme), policy(60, { generated_at: stamp(48) })),
    ],
    "noncanonical time": [
      { theme: 60 },
      {},
      (d) =>
        writeFileSync(
          path.join(d, policyFiles.theme),
          policy(60, { expires_at: "2099-01-01T00:00:00.000Z" }),
        ),
    ],
    "no signed payload": [{}, {}, (d) => writeFileSync(path.join(d, policyFiles.tab), "{}")],
    "malformed json": [{}, {}, (d) => writeFileSync(path.join(d, policyFiles.provider), "{")],
    "a missing file": [{}, {}, (d) => rmSync(path.join(d, policyFiles.tab))],
    "a symlinked file": [
      {},
      {},
      (d) => {
        rmSync(path.join(d, policyFiles.tab));
        symlinkSync("/etc/hosts", path.join(d, policyFiles.tab));
      },
    ],
  };
  for (const [label, [remaining, env, mutate]] of Object.entries(cases)) {
    const plan = planPolicies(t, remaining, env, mutate);
    assert.notEqual(plan.result.status, 0, label);
    assert.equal(plan.output, "", label);
    assert.throws(() => statSync(plan.work), { code: "ENOENT" }, label);
  }
});

function renewPolicies(t, remaining, { mutatePlan = () => {}, cliBehavior = {}, env = {} } = {}) {
  const plan = planPolicies(t, remaining);
  assert.equal(plan.result.status, 0, plan.result.stderr);
  mutatePlan(plan.work);
  const cli = path.join(plan.root, "cadencr");
  const record = path.join(plan.root, "calls.jsonl");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const [, ...args] = process.argv.slice(2);
const behavior = JSON.parse(process.env.CLI_BEHAVIOR);
if (args.includes("--help")) {
  if (behavior.lacks === args[0]) process.exit(2);
  // The usage of publish-policy names its renewal mode unless the CLI is older.
  process.stdout.write(args[0] === "publish-policy" && behavior.lacks !== "--renewal" ? "--renewal\\n" : "usage\\n");
  process.exit(0);
}
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, token: process.env.CADENCR_REGISTRY_GITHUB_TOKEN }) + "\\n");
const kind = args[args.indexOf("--kind") + 1];
if (behavior.fail === args[0] + ":" + kind) process.exit(1);
if (["fetch-policy", "renew-policy"].includes(args[0])) fs.writeFileSync(args[args.indexOf("--output") + 1], "{}");
if (args[0] === "publish-policy" && args.includes("--receipt")) fs.writeFileSync(args[args.indexOf("--receipt") + 1], "{}");
`,
  );
  chmodSync(cli, 0o700);
  const result = helper(["renew-policies", plan.work], {
    GITHUB_REPOSITORY: "acme/registry",
    CADENCR_REGISTRY_CATALOG_URL: url(),
    CADENCR_REGISTRY_KEY_ID: "registry-key-1",
    CADENCR_REGISTRY_GITHUB_TOKEN: "test-token-value",
    PRIVATE_KEY_FILE: "/separate/key.pem",
    VERIFIED_CLI: cli,
    CALLS: record,
    CLI_BEHAVIOR: JSON.stringify(cliBehavior),
    ...env,
  });
  // No file means the CLI never ran.
  const calls = existsSync(record)
    ? readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { result, plan, calls };
}

test("renew-policies fetches, renews then publishes each due policy with fixed arguments", (t) => {
  const run = renewPolicies(t, { provider: 10, theme: -3 });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    run.calls.map((call) => call.args.slice(0, 3)),
    [
      ["fetch-policy", "--kind", "provider"],
      ["renew-policy", "--kind", "provider"],
      ["publish-policy", "--kind", "provider"],
      ["fetch-policy", "--kind", "theme"],
      ["renew-policy", "--kind", "theme"],
      ["publish-policy", "--kind", "theme"],
    ],
  );
  const [fetch, renew, publish] = run.calls;
  const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
  // The baseline is the branch head read through the API, never the lagging CDN copy.
  assert.equal(flag(fetch, "--repository"), "acme/registry");
  assert.equal(flag(fetch, "--discovery-branch"), "marketplace-v2");
  assert.equal(flag(fetch, "--output"), path.join(run.plan.work, "provider-baseline.json"));
  assert.equal(flag(renew, "--current"), flag(fetch, "--output"));
  assert.ok(!renew.args.includes(path.join(run.plan.snapshot, "managed-blocklist.json")));
  assert.equal(flag(renew, "--private-key"), "/separate/key.pem");
  assert.equal(flag(renew, "--key-id"), "registry-key-1");
  assert.equal(flag(renew, "--public-key"), path.join(run.plan.work, "public.pem"));
  const window = Date.parse(flag(renew, "--expires-at")) - Date.now();
  assert.ok(
    window > 12.99 * 24 * 3600 * 1000 && window <= 13 * 24 * 3600 * 1000,
    "a 13 day window",
  );
  assert.equal(flag(publish, "--signed"), flag(renew, "--output"));
  assert.equal(flag(publish, "--repository"), "acme/registry");
  assert.equal(flag(publish, "--discovery-branch"), "marketplace-v2");
  // A renewal never bootstraps and never replaces entries.
  assert.ok(publish.args.includes("--renewal"));
  for (const call of run.calls) {
    assert.ok(!call.args.includes("--bootstrap"));
    assert.equal(call.args.join(" ").includes("test-token-value"), false);
  }
  // The token reaches only the CLI calls that talk to GitHub, through the
  // environment; the signing call never sees it.
  assert.equal(fetch.token, "test-token-value");
  assert.equal(renew.token, undefined);
  assert.equal(publish.token, "test-token-value");
});

test("renew-policies runs every due policy even after one fails, then fails the step", (t) => {
  for (const fail of [
    "fetch-policy:provider",
    "renew-policy:provider",
    "publish-policy:provider",
  ]) {
    const run = renewPolicies(t, { provider: 10, theme: 10, tab: 10 }, { cliBehavior: { fail } });
    assert.notEqual(run.result.status, 0, fail);
    assert.match(run.result.stderr, /policy renewal failed for: provider/);
    assert.match(run.result.stdout, /::error title=Policy renewal failed::the provider policy/);
    const done = run.calls.map((call) => `${call.args[0]}:${call.args[2]}`);
    assert.ok(done.includes("renew-policy:theme") && done.includes("publish-policy:theme"), fail);
    assert.ok(done.includes("renew-policy:tab") && done.includes("publish-policy:tab"), fail);
    assert.equal(
      done.includes("renew-policy:provider"),
      fail !== "fetch-policy:provider",
      "no renewal without its baseline",
    );
    assert.equal(
      done.includes("publish-policy:provider"),
      fail === "publish-policy:provider",
      "no publish after a failed baseline or renewal",
    );
  }
});

test("renew-policies fails closed on a tampered plan or work directory before running the CLI", (t) => {
  const editPlan = (change) => (work) => {
    const file = path.join(work, "plan.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    change(value);
    writeFileSync(file, JSON.stringify(value));
  };
  const cases = {
    "a mismatched file": editPlan((p) => {
      p.policies[0].file = "managed-index.json";
    }),
    "another kind's file": editPlan((p) => {
      p.policies[0].file = policyFiles.theme;
    }),
    "an unknown kind": editPlan((p) => {
      p.policies[0].kind = "catalog";
    }),
    "a hostile branch": editPlan((p) => {
      p.policies[0].branch = "main;rm";
    }),
    "a branch other than the catalog's": editPlan((p) => {
      p.policies[0].branch = "main";
    }),
    "an extra field": editPlan((p) => {
      p.policies[0].bootstrap = true;
    }),
    "an empty plan": editPlan((p) => {
      p.policies = [];
    }),
    "a duplicate kind": editPlan((p) => {
      p.policies.push({ ...p.policies[0] });
    }),
    "an extra top-level field": editPlan((p) => {
      p.extra = 1;
    }),
    "a smuggled file": (work) => writeFileSync(path.join(work, "provider-renewed.json"), "{}"),
  };
  for (const [label, mutatePlan] of Object.entries(cases)) {
    const run = renewPolicies(t, { provider: 10 }, { mutatePlan });
    assert.notEqual(run.result.status, 0, label);
    assert.match(run.result.stderr, /policy renewal guard/, label);
    assert.deepEqual(run.calls, [], `${label} must not reach the CLI`);
  }
  const noToken = renewPolicies(
    t,
    { provider: 10 },
    { env: { CADENCR_REGISTRY_GITHUB_TOKEN: "" } },
  );
  assert.notEqual(noToken.result.status, 0);
  assert.match(noToken.result.stderr, /CADENCR_REGISTRY_GITHUB_TOKEN is required/);
});

test("renew-policies names an old pinned CLI instead of failing obscurely", (t) => {
  for (const [lacks, missing] of [
    ["fetch-policy", "fetch-policy"],
    ["renew-policy", "renew-policy"],
    ["publish-policy", "publish-policy"],
    ["--renewal", "publish-policy --renewal"],
  ]) {
    const run = renewPolicies(t, { provider: 10 }, { cliBehavior: { lacks } });
    assert.notEqual(run.result.status, 0, lacks);
    assert.match(
      run.result.stderr,
      new RegExp(`lacks registry ${missing}; update ci/released-cli\\.env`),
    );
    assert.deepEqual(run.calls, []);
  }
});

test("optional LSP policy participates in planning only when configured", (t) => {
  const file = "managed-lsp-blocklist.json";
  const configured = {
    CADENCR_REGISTRY_LSP_BLOCKLIST_URL: `https://raw.githubusercontent.com/acme/registry/refs/heads/marketplace-v2/${file}`,
  };
  const plan = planPolicies(t, {}, configured, (snapshot) => {
    writeFileSync(path.join(snapshot, file), policy(1, { kind: "lsp-blocklist" }));
  });
  assert.equal(plan.result.status, 0, plan.result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(plan.work, "plan.json"), "utf8")).policies, [
    { kind: "lsp", file, branch: "marketplace-v2" },
  ]);
  const missing = planPolicies(t, {}, configured);
  assert.notEqual(missing.result.status, 0);
  const foreign = planPolicies(
    t,
    {},
    {
      CADENCR_REGISTRY_LSP_BLOCKLIST_URL: configured.CADENCR_REGISTRY_LSP_BLOCKLIST_URL.replace(
        "acme/registry",
        "other/registry",
      ),
    },
  );
  assert.notEqual(foreign.result.status, 0);
  for (const name of [
    "Download the current published revocation policies",
    "Plan revocation policy renewals",
    "Renew the revocation policies",
  ]) {
    assert.equal(
      workflow.jobs.renew.steps.find((step) => step.name === name).env
        .CADENCR_REGISTRY_LSP_BLOCKLIST_URL,
      "${{ vars.CADENCR_REGISTRY_LSP_BLOCKLIST_URL }}",
    );
  }
});
