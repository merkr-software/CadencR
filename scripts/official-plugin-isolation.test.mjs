import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
// `@cadencr/<id>-provider` → the `plugins/provider-<id>/v<version>` tag namespace.
const providerTagId = (manifest) =>
  manifest.name.replace(/^@cadencr\//, "").replace(/-provider$/, "");

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
  assert.ok(yaml("pnpm-workspace.yaml").packages.includes("plugins/providers/*"));
  const importers = yaml("pnpm-lock.yaml").importers;
  for (const manifest of providers) {
    const path = `plugins/providers/${providerTagId(manifest)}`;
    assert.equal(existsSync(join(root, path, "pnpm-lock.yaml")), false);
    assert.ok(importers[path], `${path} shares the root lockfile`);
  }
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

const sidecarSources = ["resources/bin/cadencr-service", "resources/bin/${arch}/cadencr-service"];
// The notch-island AppKit addon (packages/desktop/electron/mac-native-addon.ts).
const macWindowAddon = { from: "resources/native", to: "native", filter: ["*.node"] };
// The Linux BrowserWindow icon (packages/desktop/electron/main/app-icon.ts).
const linuxWindowIcon = { from: "icons/512x512.png", to: "icons/512x512.png" };

// Both reviewed desktop layouts are app-only; no other source is admitted.
export function assertAppOnlyResources(config) {
  assert.deepEqual(config.files, ["out/**/*", "!**/*.map", "!out/renderer/**", "package.json"]);
  const source = config.extraResources?.[0]?.from;
  assert.ok(sidecarSources.includes(source), `unreviewed sidecar source: ${source}`);
  assert.deepEqual(config.extraResources, [
    { from: source, to: "cadencr-service" },
    { from: "out/renderer", to: "renderer", filter: ["**/*", "!**/*.map"] },
    macWindowAddon,
    linuxWindowIcon,
  ]);
}

const resourceFixture = (source) => ({
  files: ["out/**/*", "!**/*.map", "!out/renderer/**", "package.json"],
  extraResources: [
    { from: source, to: "cadencr-service" },
    { from: "out/renderer", to: "renderer", filter: ["**/*", "!**/*.map"] },
    { ...macWindowAddon, filter: [...macWindowAddon.filter] },
    { ...linuxWindowIcon },
  ],
});

test("app-only resource guard accepts only the reviewed sidecar layouts", () => {
  for (const source of sidecarSources) assertAppOnlyResources(resourceFixture(source));
});

test("app-only resource guard rejects plugins, extra resources and changed bundle paths", () => {
  for (const source of sidecarSources) {
    const invalid = [
      { ...resourceFixture(source), files: ["**/*"] },
      { ...resourceFixture(source), files: [...resourceFixture(source).files, "plugins/**"] },
      resourceFixture("plugins/providers/inert/bin/provider"),
      resourceFixture("resources/bin/${arch}/plugins/provider"),
      resourceFixture("resources/bin/arbitrary/cadencr-service"),
      {
        ...resourceFixture(source),
        extraResources: resourceFixture(source).extraResources.slice(0, 1),
      },
    ];
    for (const resource of [
      { from: "plugins/providers/inert", to: "plugins/inert" },
      { from: "resources/extra", to: "extra" },
    ]) {
      const fixture = resourceFixture(source);
      fixture.extraResources.push(resource);
      invalid.push(fixture);
    }
    for (const [index, field, value] of [
      [0, "to", "plugins/service"],
      [1, "from", "plugins/themes"],
      [1, "to", "plugins/themes"],
      [0, "filter", ["**/*"]],
      [2, "filter", ["**/*"]],
      [2, "from", "plugins/providers/inert"],
      [3, "from", "plugins/providers/inert"],
      [3, "to", "plugins/icon"],
    ]) {
      const fixture = resourceFixture(source);
      fixture.extraResources[index][field] = value;
      invalid.push(fixture);
    }
    for (const fixture of invalid) assert.throws(() => assertAppOnlyResources(fixture));
  }
});

test("production and local Electron bundles retain explicit app-only resources", () => {
  for (const path of [
    "packages/desktop/electron-builder.yml",
    "packages/desktop/electron-builder.local.yml",
  ]) {
    const config = yaml(path);
    assertAppOnlyResources(config);
  }
});

test("independent official plugin tag namespaces do not trigger desktop releases", () => {
  const desktopTags = yaml(".github/workflows/desktop-release.yml").on.push.tags;
  assert.deepEqual(desktopTags, ["v*"]);
  const tags = [
    ...providers.map(
      (manifest) => `plugins/provider-${providerTagId(manifest)}/v${manifest.version}`,
    ),
    ...["graphite", "ember", "fjord"].map((name) => `plugins/theme-${name}/v0.1.0`),
  ];
  for (const tag of tags) {
    assert.equal(tag.startsWith("v"), false);
    assert.equal(spawnSync("git", ["check-ref-format", `refs/tags/${tag}`]).status, 0);
  }
  assert.equal(`v${json("packages/desktop/package.json").version}`.startsWith("v"), true);
});

test("isolated plugin CI validates themes with the pinned CLI", () => {
  const workflow = yaml(".github/workflows/ci.yml");
  const job = workflow.jobs.plugins;
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.environment, undefined, "candidate checks have no production authority");
  const steps = job.steps;
  const fetch = steps.findIndex((step) => step.run?.includes("fetch-released-cli.sh"));
  const pack = steps.findIndex(
    (step) => step.name === "Canonical theme validation and deterministic packaging",
  );
  assert.ok(fetch >= 0 && pack > fetch, "theme packaging requires the verified download");
  assert.match(steps[fetch].run, /scripts\/cli-qualification\.env/);
  assert.ok(workflow.jobs["precommit-checks"].needs.includes("plugins"));
});
