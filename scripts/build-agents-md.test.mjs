import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildOutputs,
  demoteHeadings,
  mapRuleToDirs,
  parseRule,
  renderNested,
  renderRoot,
} from "./build-agents-md.mjs";

test("parseRule extracts the paths frontmatter list and trims the body", () => {
  const rule = parseRule(
    "example",
    ['---', 'paths:', '  - "packages/desktop/src/**"', "  - '**/*.ts'", "---", "", "Body text.", ""].join("\n"),
  );

  assert.deepEqual(rule.paths, ["packages/desktop/src/**", "**/*.ts"]);
  assert.equal(rule.body, "Body text.");
  assert.equal(rule.name, "example");
});

test("parseRule treats a file without frontmatter as unscoped", () => {
  const rule = parseRule("plain", "Just a rule body.\n");

  assert.deepEqual(rule.paths, []);
  assert.equal(rule.body, "Just a rule body.");
});

test("demoteHeadings shifts markdown headings by one level, skipping code fences", () => {
  const input = ["## Section", "text", "```", "## not a heading", "```", "### Deeper"].join("\n");

  assert.equal(
    demoteHeadings(input),
    ["### Section", "text", "```", "## not a heading", "```", "#### Deeper"].join("\n"),
  );
});

test("renderRoot replaces only the marked region and is idempotent", () => {
  const existing = [
    "# AGENTS.md",
    "",
    "Intro that must survive.",
    "",
    "## Rules",
    "",
    "<!-- begin:rules -->",
    "",
    "stale content",
    "",
    "<!-- end:rules -->",
    "",
    "## Trailer that must survive.",
    "",
  ].join("\n");

  const rules = [
    { name: "beta", paths: ["packages/service/migrations/**"], body: "Beta body." },
    { name: "alpha", paths: [], body: "## Nested\n\nAlpha body." },
  ];

  const first = renderRoot(existing, rules);

  assert.match(first, /Intro that must survive\./);
  assert.match(first, /## Trailer that must survive\./);
  // Sorted by name: alpha before beta.
  assert.ok(first.indexOf("### alpha") < first.indexOf("### beta"));
  // Unscoped rule gets no applies-to line; scoped rule does.
  assert.doesNotMatch(first.split("### beta")[0], /### alpha\n_Applies to/);
  assert.match(first, /### beta\n_Applies to: `packages\/service\/migrations\/\*\*`_/);
  // Heading inside a body is demoted.
  assert.match(first, /### Nested/);
  assert.doesNotMatch(first, /\n## Nested/);

  // Running again over the produced output changes nothing.
  assert.equal(renderRoot(first, rules), first);
});

test("renderRoot throws when the markers are missing", () => {
  assert.throws(() => renderRoot("# AGENTS.md\n\nno markers here\n", []), /markers/);
});

test("mapRuleToDirs routes globs to the deepest matching nested directory", () => {
  assert.deepEqual(mapRuleToDirs(["packages/desktop/src/components/**"]), [
    "packages/desktop/src/components",
  ]);
  assert.deepEqual(mapRuleToDirs(["packages/desktop/src/routes/**"]), ["packages/desktop/src/routes"]);
  assert.deepEqual(mapRuleToDirs(["packages/desktop/src/**"]), ["packages/desktop/src"]);
  assert.deepEqual(mapRuleToDirs(["packages/service/migrations/**"]), ["packages/service/migrations"]);
});

test("mapRuleToDirs sends generic TS extensions to the desktop src file", () => {
  assert.deepEqual(mapRuleToDirs(["**/*.ts", "**/*.tsx"]), ["packages/desktop/src"]);
  assert.deepEqual(mapRuleToDirs(["**/*.tsx"]), ["packages/desktop/src"]);
});

test("mapRuleToDirs keeps rust and broad or unmatched globs root-only", () => {
  assert.deepEqual(mapRuleToDirs(["**/*.rs"]), []);
  assert.deepEqual(mapRuleToDirs(["packages/desktop/**"]), []);
  assert.deepEqual(mapRuleToDirs([]), []);
  assert.deepEqual(
    mapRuleToDirs(["packages/service/src/shared/db.rs", "packages/service/migrations/**"]),
    ["packages/service/migrations"],
  );
});

test("renderNested keeps the intro, adds the auto-generated header, and lists scoped rules", () => {
  const out = renderNested("These rules apply to X.", [
    { name: "second", paths: ["**/*.ts", "**/*.tsx"], body: "Second body." },
    { name: "first", paths: ["packages/desktop/src/**"], body: "First body." },
  ]);

  assert.match(out, /^<!-- auto-generated from \.claude\/rules\//);
  assert.match(out, /These rules apply to X\./);
  assert.ok(out.indexOf("### first") < out.indexOf("### second"));
  assert.match(out, /### first\n_Applies to: `packages\/desktop\/src\/\*\*`_/);
  assert.match(out, /### second\n_Applies to: `\*\*\/\*\.ts`, `\*\*\/\*\.tsx`_/);
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"));
});

test("buildOutputs maps rules into the right files and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-agents-md-"));
  try {
    writeFileSync(
      join(root, "AGENTS.md"),
      "# AGENTS.md\n\nkeep me\n\n<!-- begin:rules -->\n\nold\n\n<!-- end:rules -->\n",
    );

    const rules = [
      { name: "components", paths: ["packages/desktop/src/components/**"], body: "Components body." },
      { name: "typing", paths: ["**/*.ts", "**/*.tsx"], body: "Typing body." },
      { name: "simplicity", paths: [], body: "Simplicity body." },
    ];

    const outputs = buildOutputs(root, rules);
    for (const out of outputs) {
      mkdirSync(join(out.path, ".."), { recursive: true });
      writeFileSync(out.path, out.content);
    }

    const rootContent = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(rootContent, /keep me/);
    // Every rule appears in the root, including the unscoped one.
    assert.match(rootContent, /### components/);
    assert.match(rootContent, /### typing/);
    assert.match(rootContent, /### simplicity/);

    const componentsFile = readFileSync(join(root, "packages/desktop/src/components/AGENTS.md"), "utf8");
    assert.match(componentsFile, /### components/);
    assert.doesNotMatch(componentsFile, /### typing/);

    const srcFile = readFileSync(join(root, "packages/desktop/src/AGENTS.md"), "utf8");
    assert.match(srcFile, /### typing/);
    assert.doesNotMatch(srcFile, /### components/);
    assert.doesNotMatch(srcFile, /### simplicity/);

    // Rebuilding over the written files produces identical content.
    const second = buildOutputs(root, rules);
    for (const out of second) {
      assert.equal(readFileSync(out.path, "utf8"), out.content);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
