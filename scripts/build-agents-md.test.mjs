import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  buildOutputs,
  mapRuleToDirs,
  parseRule,
  renderNested,
  renderRoot,
} from "./build-agents-md.mjs";

test("parseRule extracts the paths frontmatter list and trims the body", () => {
  const rule = parseRule(
    "example",
    [
      "---",
      "paths:",
      '  - "packages/desktop/src/**"',
      "  - '**/*.ts'",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n"),
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

test("renderRoot indexes every source without duplicating bodies or changing managed blocks", () => {
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
    "<!-- BEGIN:turborepo-agent-rules -->",
    "Version-matched Turbo guidance must survive.",
    "<!-- END:turborepo-agent-rules -->",
    "",
  ].join("\n");

  const rules = [
    { name: "beta", paths: ["packages/service/migrations/**"], body: "Beta body." },
    { name: "alpha", paths: [], body: "## Nested\n\nAlpha body." },
  ];

  const first = renderRoot(existing, rules);

  assert.match(first, /Intro that must survive\./);
  assert.ok(
    first.endsWith(existing.slice(existing.indexOf("<!-- BEGIN:turborepo-agent-rules -->"))),
  );
  // Sorted by name: alpha before beta.
  assert.ok(first.indexOf("[alpha]") < first.indexOf("[beta]"));
  assert.ok(first.includes("[alpha](.claude/rules/alpha.md) | Every task"));
  assert.ok(first.includes("[beta](.claude/rules/beta.md) | `packages/service/migrations/**`"));
  for (const rule of rules) assert.ok(!first.includes(rule.body));

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
  assert.deepEqual(mapRuleToDirs(["packages/desktop/src/routes/**"]), [
    "packages/desktop/src/routes",
  ]);
  assert.deepEqual(mapRuleToDirs(["packages/desktop/src/**"]), ["packages/desktop/src"]);
  assert.deepEqual(mapRuleToDirs(["packages/service/migrations/**"]), [
    "packages/service/migrations",
  ]);
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

test("renderNested uses portable relative links and preserves the original scopes", () => {
  const out = renderNested(
    "These rules apply to X.",
    [
      { name: "second", paths: ["**/*.ts", "**/*.tsx"], body: "Second body." },
      { name: "first", paths: ["packages/desktop/src/**"], body: "First body." },
    ],
    "packages/desktop/src",
  );

  assert.match(out, /^<!-- auto-generated from \.claude\/rules\//);
  assert.match(out, /These rules apply to X\./);
  assert.ok(out.indexOf("[first]") < out.indexOf("[second]"));
  assert.ok(out.includes("[first](../../../.claude/rules/first.md) | `packages/desktop/src/**`"));
  assert.ok(out.includes("[second](../../../.claude/rules/second.md) | `**/*.ts`, `**/*.tsx`"));
  assert.doesNotMatch(out, /First body|Second body/);
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
      {
        name: "components",
        paths: ["packages/desktop/src/components/**"],
        body: "Components body.",
      },
      { name: "typing", paths: ["**/*.ts", "**/*.tsx"], body: "Typing body." },
      { name: "rust", paths: ["**/*.rs"], body: "Rust body." },
      { name: "design", paths: ["packages/desktop/**"], body: "Design body." },
      { name: "simplicity", paths: [], body: "Simplicity body." },
    ];

    mkdirSync(join(root, ".claude/rules"), { recursive: true });
    for (const rule of rules)
      writeFileSync(join(root, ".claude/rules", `${rule.name}.md`), rule.body);

    const outputs = buildOutputs(root, rules);
    for (const out of outputs) {
      mkdirSync(join(out.path, ".."), { recursive: true });
      writeFileSync(out.path, out.content);
    }

    const rootContent = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(rootContent, /keep me/);
    // Root discovery covers every scope, including SDK Rust/TS and Electron,
    // even though those paths have no generated nested instruction file.
    for (const rule of rules) assert.ok(rootContent.includes(`[${rule.name}]`));

    const componentsFile = readFileSync(
      join(root, "packages/desktop/src/components/AGENTS.md"),
      "utf8",
    );
    assert.ok(componentsFile.includes("[components]"));
    assert.ok(!componentsFile.includes("[typing]"));

    const srcFile = readFileSync(join(root, "packages/desktop/src/AGENTS.md"), "utf8");
    assert.ok(srcFile.includes("[typing]"));
    assert.ok(!srcFile.includes("[components]"));
    assert.ok(!srcFile.includes("[simplicity]"));

    for (const out of outputs) {
      for (const rule of rules) assert.ok(!out.content.includes(rule.body));
      for (const [, name, link] of out.content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)) {
        assert.equal(resolve(dirname(out.path), link), join(root, ".claude/rules", `${name}.md`));
        assert.equal(
          readFileSync(resolve(dirname(out.path), link), "utf8"),
          `${name[0].toUpperCase()}${name.slice(1)} body.`,
        );
      }
    }

    // Rebuilding over the written files produces identical content.
    const second = buildOutputs(root, rules);
    for (const out of second) {
      assert.equal(readFileSync(out.path, "utf8"), out.content);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
