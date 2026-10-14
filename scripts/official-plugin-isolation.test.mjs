import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = require("yaml");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const yaml = (path) => parse(readFileSync(join(root, path), "utf8"));
const providers = readdirSync(join(root, "plugins/providers"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => json(`plugins/providers/${entry.name}/package.json`));
const pluginNames = new Set(providers.map((manifest) => manifest.name));

test("official providers expose only dedicated tasks and share the root lockfile", () => {
  const generic = [
    "build",
    "build:local",
    "build:release",
    "dev",
    "test",
    "lint",
    "format",
    "format:check",
    "ts-check",
    "knip",
  ];
  const dedicated = [
    "build:plugin",
    "test:plugin",
    "lint:plugin",
    "format:plugin",
    "format:plugin:check",
    "package:plugin",
  ];
  for (const manifest of providers) {
    for (const task of generic)
      assert.equal(manifest.scripts[task], undefined, `${manifest.name}#${task}`);
    for (const task of dedicated) assert.ok(manifest.scripts[task], `${manifest.name}#${task}`);
  }
  assert.equal(existsSync(join(root, "plugins/providers/pi/pnpm-lock.yaml")), false);
  assert.ok(yaml("pnpm-workspace.yaml").packages.includes("plugins/providers/*"));
  const importer = yaml("pnpm-lock.yaml").importers["plugins/providers/pi"];
  assert.ok(importer.devDependencies.oxlint);
  assert.equal(importer.dependencies, undefined, "Pi bundles no npm runtime dependencies");
});

test("application workspace dependency edges never reach official provider sources", () => {
  const manifests = [json("package.json")];
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const path = `packages/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(join(root, path))) manifests.push(json(path));
  }
  for (const manifest of manifests) {
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        assert.equal(pluginNames.has(name), false, `${manifest.name} ${section}: ${name}`);
        for (const plugin of pluginNames)
          assert.equal(specifier.includes(plugin), false, `${manifest.name}: ${specifier}`);
        assert.doesNotMatch(specifier, /plugins\/providers\//, `${manifest.name}: ${specifier}`);
      }
    }
  }
});

test("real Turbo plans keep official providers out of executable application tasks", () => {
  const plans = [
    ["build", "dev", "--filter=@cadencr/desktop"],
    [
      "build",
      "build:local",
      "build:release",
      "dev",
      "test",
      "lint",
      "format:check",
      "ts-check",
      "knip",
    ],
  ];
  for (const tasks of plans) {
    const result = spawnSync(
      join(root, "node_modules/.bin/turbo"),
      ["run", ...tasks, "--dry=json"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.ok(plan.tasks.length > 0, "empty graph cannot prove isolation");
    // Turbo may retain placeholders for packages without the requested script.
    const executable = plan.tasks.filter((task) => task.command !== "<NONEXISTENT>");
    assert.ok(executable.some((task) => task.package === "@cadencr/desktop"));
    assert.equal(
      executable.some((task) => pluginNames.has(task.package)),
      false,
    );
  }
});

test("production and local Electron bundles retain explicit app-only resources", () => {
  for (const path of [
    "packages/desktop/electron-builder.yml",
    "packages/desktop/electron-builder.local.yml",
  ]) {
    const config = yaml(path);
    assert.deepEqual(config.files, ["out/**/*", "!out/renderer/**", "package.json"]);
    assert.deepEqual(config.extraResources, [
      { from: "resources/bin/cadencr-service", to: "cadencr-service" },
      { from: "out/renderer", to: "renderer" },
    ]);
  }
});

test("the root packaging command forwards options and emits only a separate Pi payload", (t) => {
  const work = mkdtempSync(join(tmpdir(), "cadencr-official-pi-command-"));
  t.after(() => {
    // Retain unexpected databases rather than deleting any persistent state.
    for (const entry of readdirSync(work, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      assert.doesNotMatch(entry.name, /\.(?:db|sqlite)(?:-(?:wal|shm))?$/i);
      const header = readFileSync(join(entry.parentPath, entry.name)).subarray(0, 16);
      assert.notEqual(header.toString(), "SQLite format 3\0", "unexpected database retained");
    }
    rmSync(work, { recursive: true, force: true });
  });
  const payload = join(work, "payload");
  const result = spawnSync("pnpm", ["run", "package:plugin:pi", "--directory", payload], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(payload).sort(), ["LICENSE", "README.md", "bin", "icon.svg"]);
  const version = spawnSync(join(payload, "bin/provider"), ["version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), providers[0].version);
  assert.ok(readFileSync(`${payload}.SHA256SUMS`, "utf8").includes("bin/provider"));
});

test("independent official plugin tag namespaces do not trigger desktop releases", () => {
  const desktopTags = yaml(".github/workflows/desktop-release.yml").on.push.tags;
  assert.deepEqual(desktopTags, ["v*"]);
  const tags = [
    ...providers.map((manifest) => `plugins/provider-pi/v${manifest.version}`),
    ...["graphite", "ember", "fjord"].map((name) => `plugins/theme-${name}/v0.1.0`),
  ];
  for (const tag of tags) {
    assert.equal(tag.startsWith("v"), false);
    assert.equal(spawnSync("git", ["check-ref-format", `refs/tags/${tag}`]).status, 0);
  }
  assert.equal(`v${json("packages/desktop/package.json").version}`.startsWith("v"), true);
});
