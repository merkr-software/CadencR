import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const exampleUrl = new URL(
  "../examples/workflows/prepare-protected-publication.yml",
  import.meta.url,
);
const activeUrl = new URL(
  "../.github/workflows/prepare-protected-publication.yml",
  import.meta.url,
);
const hasExample = existsSync(exampleUrl);
const source = readFileSync(hasExample ? exampleUrl : activeUrl, "utf8");

test("exported protected workflow remains an inert example", () => {
  if (hasExample)
    assert.equal(
      existsSync(activeUrl),
      false,
      "protected workflow must not be activated by export",
    );
});
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
  assert.equal(checkout?.uses, "actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
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
    [
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/upload-artifact@v4",
    ],
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
  assert.equal(commands.length, 3);
  assert.equal(commands[0], "sh scripts/ci/select-publisher-runtime.sh");
  assert.match(commands[1], /^echo "GENERATED_AT=.*\necho "EXPIRES_AT=.*\n$/);
  assert.match(commands[2], /registry build-index "\$@" --schema-version 2 --packages packages/);
  assert.doesNotMatch(commands.join("\n"), /npm|node .*scripts\//);
});

test("publication timestamps are whole-second UTC with a bounded seven-day expiry", () => {
  const windowStep = job.steps.find(({ name }) => name === "Choose bounded publication window");
  assert.match(windowStep?.run ?? "", /date -u \+%Y-%m-%dT%H:%M:%SZ/);
  assert.match(windowStep?.run ?? "", /date -u -d '\+7 days' \+%Y-%m-%dT%H:%M:%SZ/);

  const build = job.steps.find(({ name }) => name === "Build unsigned schema-2 input");
  assert.match(build?.run ?? "", /--generated-at "\$GENERATED_AT"/);
  assert.match(build?.run ?? "", /--expires-at "\$EXPIRES_AT"/);
});
