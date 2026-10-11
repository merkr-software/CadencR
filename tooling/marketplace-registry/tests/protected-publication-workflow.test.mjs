import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const source = readFileSync(
  new URL("../.github/workflows/prepare-protected-publication.yml", import.meta.url),
  "utf8",
);
const workflow = parse(source);
const job = workflow.jobs["canonical-payload"];

test("runs only a pinned default-branch dispatch in one non-cancelling publication lane", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(
    job.if,
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
  );
  assert.deepEqual(workflow.concurrency, {
    group: "marketplace-publication",
    "cancel-in-progress": false,
  });

  const checkout = job.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.uses, "actions/checkout@v4");
  assert.deepEqual(checkout?.with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  assert.equal(job.environment, "protected-marketplace-publisher");
});

test("unsigned preparation has read-only permissions and no privileged inputs or commands", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(source.includes("pull_request"), false);
  assert.deepEqual(
    job.steps.flatMap(({ uses }) => (uses ? [uses] : [])),
    ["actions/checkout@v4", "actions/setup-node@v4", "actions/upload-artifact@v4"],
  );

  const serialized = JSON.stringify(workflow);
  for (const forbidden of [
    "secrets.",
    "id-token",
    "contents:write",
    "sign:index",
    "sign:publication-catalog",
    "mirror:publication",
    "promote:publication",
    "publish:catalog",
    "release create",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `unexpected privileged input: ${forbidden}`,
    );
  }

  const commands = job.steps.flatMap(({ run }) => (run ? [run] : []));
  assert.equal(commands.length, 4);
  assert.equal(commands[0], "npm test");
  assert.equal(commands[1], "npm run validate");
  assert.match(commands[2], /^echo "GENERATED_AT=.*\necho "EXPIRES_AT=.*\n$/);
  assert.match(commands[3], /^npm run build:index -- /);
});

test("publication timestamps are whole-second UTC with a bounded seven-day expiry", () => {
  const windowStep = job.steps.find(({ name }) => name === "Choose bounded publication window");
  assert.match(windowStep?.run ?? "", /date -u \+%Y-%m-%dT%H:%M:%SZ/);
  assert.match(windowStep?.run ?? "", /date -u -d '\+7 days' \+%Y-%m-%dT%H:%M:%SZ/);

  const build = job.steps.find(({ run }) => run?.startsWith("npm run build:index --"));
  assert.match(build?.run ?? "", /--generated-at "\$GENERATED_AT"/);
  assert.match(build?.run ?? "", /--expires-at "\$EXPIRES_AT"/);
});
