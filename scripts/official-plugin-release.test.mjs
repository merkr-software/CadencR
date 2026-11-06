import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { fixture, checkNamespacedTagBinding } from "./official-plugin-fixtures.mjs";
const commit = "a".repeat(40);
const hash = (data) => createHash("sha256").update(data).digest("hex");
for (const kind of ["theme", "provider", "tab"]) {
  test(`${kind}: deterministic metadata-complete preparation never executes candidate payloads`, () => {
    const f = fixture(kind);
    const a = f.run();
    const b = f.run();
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const release = JSON.parse(readFileSync(join(a.output, "release.json")));
    assert.equal(release.source_commit, commit);
    assert.equal(release.source_repository, "merkr-software/CadencR");
    assert.equal(release.authority, "qualification");
    assert.equal(release.archives.length, kind === "provider" ? 2 : 1);
    assert.equal(release.package.sha256, hash(readFileSync(join(a.output, "package.json"))));
    assert.deepEqual(
      readdirSync(a.output).sort(),
      [
        ...release.archives.map((archive) => archive.name),
        "SHA256SUMS",
        "release.json",
        "package.json",
        "submission.json",
      ].sort(),
    );
    for (const name of readdirSync(a.output))
      assert.deepEqual(readFileSync(join(a.output, name)), readFileSync(join(b.output, name)));
    const metadata = JSON.parse(readFileSync(join(a.output, "package.json")));
    assert.equal(metadata.kind, kind);
    const submission = JSON.parse(readFileSync(join(a.output, "submission.json")));
    assert.deepEqual(submission.package, metadata);
    assert.equal(submission.source.tag, `plugins/${f.plugin}/v1.0.0`);
    assert.equal(readFileSync(join(a.output, "release.json"), "utf8").includes(f.root), false);
    const calls = readFileSync(join(f.root, "calls"), "utf8");
    assert.match(calls, /plan-publication/);
    assert.doesNotMatch(calls, /publish-release/);
  });
}

test("rejects invalid tags, unknown plugins, version/source/origin drift before output", () => {
  for (const [tag, env] of [
    ["v1.0.0", {}],
    ["plugins/theme-unknown/v1.0.0", {}],
    ["plugins/tab-inert/v1.0.0", {}],
    ["plugins/theme-graphite/v2.0.0", {}],
    [undefined, { MOCK_MODE: "120000" }],
    [undefined, { MOCK_COMMIT: "b".repeat(40) }],
    [undefined, { MOCK_TAG_COMMIT: "b".repeat(40) }],
    [undefined, { MOCK_ORIGIN: "https://github.com/evil/repo.git" }],
  ]) {
    const result = fixture().run(tag, env);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.output), false);
  }
});

test("all kinds reject changed, extra, missing, symlinked, unreviewed, and mode-drift payloads", () => {
  for (const kind of ["theme", "provider", "tab"])
    for (const change of ["changed", "extra", "missing", "symlink", "unapproved", "mode"]) {
      const f = fixture(kind);
      const payload = Object.values(f.entry.payloads)[0];
      const name = Object.keys(payload.files)[0];
      const path = `${payload.directory}/${name}`;
      if (change === "changed") f.files[path] += "changed";
      if (change === "extra") f.files[`${payload.directory}/extra.txt`] = "unreviewed";
      if (change === "missing") delete f.files[path];
      if (change === "symlink") f.modes[path] = "120000";
      if (change === "mode") f.modes[path] = f.modes[path] === "100755" ? "100644" : "100755";
      if (change === "unapproved") {
        f.entry.preparation = "PENDING";
        f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
      }
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0, `${kind} ${change}`);
      assert.equal(existsSync(result.output), false);
    }
});

test("production pin remains fail-closed, receipts are exact, outputs never overwrite", () => {
  assert.match(fixture().run(undefined, {}, false).stderr, /PENDING/);
  const f = fixture();
  writeFileSync(join(f.root, "bad-receipt"), "yes");
  assert.match(f.run().stderr, /receipt mismatch/);
  const existing = join(f.root, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep"), "unchanged");
  const link = join(f.root, "link");
  symlinkSync(existing, link);
  for (const output of [existing, link, join(link, "new")]) {
    assert.notEqual(f.run(undefined, {}, true, output).status, 0);
    assert.equal(readFileSync(join(existing, "keep"), "utf8"), "unchanged");
  }
});

test("production and author modes require authoritative contexts and reviewed policy", () => {
  for (const env of [
    { GITHUB_REPOSITORY: "evil/repo" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_REF: "refs/heads/main" },
  ])
    assert.match(fixture().run(undefined, env, false).stderr, /authoritative GitHub tag context/);
  const f = fixture();
  const context = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" };
  assert.match(f.run(undefined, context, "author-approved").stderr, /unreviewed release policy/);
  f.policy.publication = "APPROVED";
  f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
  f.save();
  assert.match(f.run(undefined, {}, "author-approved").stderr, /trusted main dispatch/);
});

for (const kind of ["theme", "provider", "tab"]) {
  test(
    `${kind}: source-bound preparation through the real shared Rust CLI`,
    { skip: !process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI },
    () => {
      const cli = realpathSync(process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI);
      const f = fixture(kind, cli);
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      const metadata = JSON.parse(readFileSync(join(result.output, "package.json")));
      assert.equal(metadata.kind, kind);
      const release = JSON.parse(readFileSync(join(result.output, "release.json")));
      for (const archive of release.archives) {
        const bytes = readFileSync(join(result.output, archive.name));
        assert.equal(hash(bytes), archive.sha256);
        assert.equal(bytes.length, archive.size);
      }
    },
  );
}

test("reviewed source mappings copy interpreted modules without running author builds", () => {
  const f = fixture("provider");
  for (const payload of Object.values(f.entry.payloads)) {
    const old = `${payload.directory}/bin/provider`;
    f.files[`${payload.directory}/src/provider.mjs`] = f.files[old];
    f.modes[`${payload.directory}/src/provider.mjs`] = "100644";
    delete f.files[old];
    delete f.modes[old];
    payload.files["bin/provider"].source = "src/provider.mjs";
    payload.files["bin/provider"].source_mode = "100644";
    payload.closed_directories = ["src"];
    f.files[`${payload.directory}/scripts/build.mjs`] =
      "throw new Error('never execute contributor build')";
  }
  f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
  f.save();
  assert.equal(f.run().status, 0);
  const payload = Object.values(f.entry.payloads)[0];
  f.files[`${payload.directory}/src/extra.mjs`] = "unreviewed runtime module";
  f.save();
  assert.match(f.run().stderr, /extra source content/);
});

test("checked-in official policy hashes match actual sources and approve no tab", () => {
  const policy = JSON.parse(readFileSync("plugins/release-policy.json"));
  assert.equal(policy.schema_version, 2);
  assert.equal(policy.publication, "APPROVED");
  assert.deepEqual(Object.keys(policy.plugins).sort(), [
    "lsp-astro-ls",
    "lsp-bash-language-server",
    "lsp-biome",
    "lsp-clangd",
    "lsp-css-language-server",
    "lsp-docker-langserver",
    "lsp-eslint",
    "lsp-gopls",
    "lsp-graphql-language-server",
    "lsp-html-language-server",
    "lsp-json-language-server",
    "lsp-lua-language-server",
    "lsp-marksman",
    "lsp-oxlint",
    "lsp-pyright",
    "lsp-ruff",
    "lsp-rust-analyzer",
    "lsp-svelte-language-server",
    "lsp-tailwindcss-language-server",
    "lsp-taplo",
    "lsp-terraform-ls",
    "lsp-tsgo",
    "lsp-typescript-language-server",
    "lsp-vue-language-server",
    "lsp-yaml-language-server",
    "provider-pi",
    "theme-ember",
    "theme-fjord",
    "theme-graphite",
  ]);
  for (const entry of Object.values(policy.plugins)) {
    assert.equal(
      entry.preparation,
      "READY",
      "source shape is distinct from runtime/publication qualification",
    );
    const metadata = JSON.parse(readFileSync(entry.package));
    assert.equal(metadata.kind, entry.kind);
    const identity = metadata.package[entry.kind === "provider" ? "agent" : entry.kind];
    assert.equal(identity.id, entry.id);
    assert.equal(identity.version, entry.version);
    assert.equal(metadata.package.host.publisher, entry.kind === "lsp" ? "merkr-software" : "cadencr");
    assert.equal(metadata.package.host.compatibility.min_app_version, entry.kind === "lsp" ? "0.16.1" : "0.15.0");
    for (const payload of Object.values(entry.payloads))
      for (const [name, declaration] of Object.entries(payload.files))
        assert.equal(
          hash(readFileSync(join(payload.directory, declaration.source ?? name))),
          declaration.sha256,
        );
  }
});

test(
  "shallow namespaced tag fetch preserves lightweight and annotated source binding",
  checkNamespacedTagBinding,
);

for (const kind of ["theme", "provider", "tab"]) {
  test(
    `${kind}: shared Rust validation rejects invalid payload/metadata before public output`,
    { skip: !process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI },
    () => {
      const f = fixture(kind, realpathSync(process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI));
      const payload = Object.values(f.entry.payloads)[0];
      if (kind === "theme") {
        const path = `${payload.directory}/theme.json`;
        f.files[path] = '{"label":false}';
        payload.files["theme.json"].sha256 = hash(f.files[path]);
      } else if (kind === "tab") {
        const path = `${payload.directory}/tab.json`;
        const manifest = JSON.parse(f.files[path]);
        manifest.id = "changed-runtime";
        f.files[path] = JSON.stringify(manifest);
        payload.files["tab.json"].sha256 = hash(f.files[path]);
      } else {
        const metadata = JSON.parse(f.files[f.entry.package]);
        delete metadata.package.agent.distribution.binary["linux-x86_64"].cmd;
        f.files[f.entry.package] = JSON.stringify(metadata);
      }
      f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(result.output), false);
    },
  );
}

test("provider source version manifest drift fails before packaging", () => {
  const f = fixture("provider");
  f.entry.version_file = `${f.entry.source_path}/package.json`;
  f.files[f.entry.version_file] = JSON.stringify({ version: "2.0.0" });
  f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
  f.save();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source plugin version mismatch/);
  assert.equal(existsSync(result.output), false);
});

test("failed Rust commands expose only stage/code and retain bounded diagnostics privately", () => {
  const f = fixture();
  writeFileSync(join(f.root, "bad-cli"), "yes");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin validate failed \(INERT_FIXTURE_FAILURE\)/);
  assert.equal(result.stderr.includes("sensitive-marker"), false);
  assert.equal(result.stderr.includes("PRIVATE_DIAG_MARKER"), false);
  const scratch = /Private preparation scratch retained: (.+)/.exec(result.stderr)?.[1];
  assert.ok(scratch);
  const log = readFileSync(join(scratch, "cli-diagnostics.log"));
  assert.ok(log.length <= 65536);
  assert.ok(log.includes(Buffer.from("PRIVATE_DIAG_MARKER")));
  assert.equal(existsSync(result.output), false);
});

for (const kind of ["theme", "provider", "tab"]) {
  test(`${kind}: nested duplicate source metadata keys cannot bypass pending decisions`, () => {
    const f = fixture(kind, process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI);
    f.files[f.entry.package] = f.files[f.entry.package].replace(
      '"publisher":"fixture"',
      '"publisher":"PENDING","publisher":"fixture"',
    );
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.output), false);
    assert.equal(
      existsSync(join(f.root, "calls")),
      false,
      "malformed source is rejected before CLI execution",
    );
  });
}

test("duplicate nested release-policy and source-version keys are rejected before packaging", () => {
  for (const location of ["policy", "version"]) {
    const f = fixture("provider");
    if (location === "policy") {
      f.files["plugins/release-policy.json"] = f.files["plugins/release-policy.json"].replace(
        '"preparation":"READY"',
        '"preparation":"PENDING","preparation":"READY"',
      );
    } else {
      f.entry.version_file = `${f.entry.source_path}/package.json`;
      f.files[f.entry.version_file] = '{"version":"2.0.0","version":"1.0.0"}';
      f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
    }
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0, location);
    assert.equal(existsSync(result.output), false);
    assert.equal(existsSync(join(f.root, "calls")), false);
  }
});

test("every source JSON boundary rejects non-finite constants and numeric overflow", () => {
  for (const location of ["policy", "version", "metadata"])
    for (const number of ["NaN", "Infinity", "-Infinity", "1e400"]) {
      const f = fixture("provider");
      let path = location === "policy" ? "plugins/release-policy.json" : f.entry.package;
      if (location === "version") {
        path = `${f.entry.source_path}/package.json`;
        f.entry.version_file = path;
        f.files[path] = '{"version":"1.0.0"}';
        f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
      }
      f.files[path] = f.files[path].slice(0, -1) + ',"untrusted_number":' + number + "}";
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0, `${location} ${number}`);
      assert.equal(existsSync(result.output), false);
      assert.equal(existsSync(join(f.root, "calls")), false);
    }
});

test("CLI receipt JSON rejects duplicate keys, non-finite constants and overflow", () => {
  for (const invalid of ["duplicate", "NaN", "Infinity", "-Infinity", "1e400"]) {
    const f = fixture();
    writeFileSync(join(f.root, "invalid-receipt-json"), invalid);
    const result = f.run();
    assert.notEqual(result.status, 0, invalid);
    assert.equal(existsSync(result.output), false);
    assert.doesNotMatch(
      result.stderr,
      /packaging receipt mismatch/,
      "strict JSON decoding rejects ambiguity before receipt comparison",
    );
  }
});

test("many-file payload uses one bounded Git batch instead of per-file subprocesses", () => {
  const f = fixture("tab", process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI);
  const payload = f.entry.payloads.tab;
  for (let index = 0; index < 256; index += 1) {
    const name = `dist/asset-${index}.txt`;
    const bytes = `inert asset ${index}`;
    f.files[`${payload.directory}/${name}`] = bytes;
    payload.files[name] = { mode: "100644", sha256: hash(bytes) };
  }
  f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(f.root, "git-calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    calls.filter((args) => args[0] === "cat-file" && args.includes("--batch")).length,
    1,
  );
  assert.ok(calls.length < 15, `expected bounded Git process count, got ${calls.length}`);
  assert.equal(
    calls.filter((args) => args[0] === "show").length,
    2,
    "only policy and metadata use individual source reads",
  );
});

test("Git batch headers enforce per-blob limits before body reads and reject truncation", () => {
  for (const size of [
    "33554433",
    "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
    "invalid",
    "4",
  ]) {
    const f = fixture("tab");
    writeFileSync(join(f.root, "batch-size"), size);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.output), false);
    assert.equal(
      existsSync(join(f.root, "calls")),
      false,
      "invalid snapshots never reach Rust packaging",
    );
  }
});
