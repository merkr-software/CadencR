import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  productionLines,
  providerBoundaryManifest,
  scanProviderBoundaries,
  stringLiterals,
} from "./check-provider-boundaries.mjs";

test("stringLiterals ignores comments and finds exact provider ids", () => {
  assert.deepEqual(stringLiterals('let provider = "claude_code"; // "opencode"'), ["claude_code"]);
  assert.deepEqual(stringLiterals('const value = "not-opencode";'), ["not-opencode"]);
  assert.deepEqual(
    stringLiterals('let value: Cow<\'static, str> = Cow::Borrowed("opencode");', ".rs"),
    ["opencode"],
    "a Rust lifetime must not mask a later string literal",
  );
});

test("productionLines omits cfg-test blocks but resumes after cfg-test declarations", () => {
  const source = [
    'const LIVE: &str = "claude_code";',
    "#[cfg(test)]",
    "mod tests {",
    '  const FIXTURE: &str = "opencode";',
    "}",
    "#[cfg(test)]",
    "mod fixture;",
    'const ALSO_LIVE: &str = "codex_cli";',
  ].join("\n");
  const kept = productionLines(source, ".rs").map(({ text }) => text);
  assert.deepEqual(kept, [
    'const LIVE: &str = "claude_code";',
    'const ALSO_LIVE: &str = "codex_cli";',
  ]);
});

test("the repository has no unreviewed provider ids or dependencies", () => {
  assert.deepEqual(scanProviderBoundaries(), []);
});

test("new registry entries extend id and grouped-import enforcement automatically", (context) => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-provider-boundaries-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const write = (path, source) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  };
  write(
    "packages/service/src/domain/agents/providers/registry.rs",
    "static BUILTIN_PROVIDERS: &[BuiltinProvider] = &[BuiltinProvider { id: super::super::acme::PROVIDER_ID }];",
  );
  write(
    "packages/service/src/domain/agents/acme/mod.rs",
    'pub const PROVIDER_ID: &str = "acme_cli";',
  );
  write(
    "packages/service/src/shared/leak.rs",
    [
      "use crate::domain::agents::{",
      "    acme,",
      "    adapter::RuntimeError,",
      "};",
      "fn direct() { let _ = acme_sdk_rs::Client; }",
    ].join("\n"),
  );
  write(
    "packages/service/src/domain/agents/shared_relative.rs",
    "fn leak() { let _ = super::acme::Adapter; }",
  );
  write("packages/desktop/src/leak.ts", 'export const provider = "acme_cli";');
  write(
    "packages/acme-sdk-rs/Cargo.toml",
    '[package]\nname = "acme-sdk-rs"\n[dependencies]\ncadencr-service = { path = "../service" }\n',
  );

  assert.deepEqual(providerBoundaryManifest(root).modules, ["acme"]);
  assert.deepEqual(providerBoundaryManifest(root).ids, ["acme_cli"]);
  const violations = scanProviderBoundaries(root);
  assert.ok(
    violations.some(
      ({ path, providerId, kind }) =>
        path.endsWith("shared/leak.rs") && providerId === "acme" && kind === "dependency",
    ),
    "grouped provider-module imports must be rejected",
  );
  assert.ok(
    violations.some(
      ({ path, providerId, kind }) =>
        path.endsWith("domain/agents/shared_relative.rs") &&
        providerId === "acme" &&
        kind === "dependency",
    ),
    "relative provider-module imports must be rejected",
  );
  assert.ok(
    violations.some(
      ({ path, providerId, kind }) =>
        path.endsWith("shared/leak.rs") && providerId === "acme_sdk_rs" && kind === "dependency",
    ),
    "new SDK crate names must be rejected outside provider boundaries",
  );
  assert.ok(
    violations.some(
      ({ path, providerId, kind }) =>
        path.endsWith("desktop/src/leak.ts") && providerId === "acme_cli" && kind === undefined,
    ),
    "new provider ids must be rejected outside approved boundaries",
  );
  assert.ok(
    violations.some(
      ({ path, providerId, kind }) =>
        path.endsWith("acme-sdk-rs/Cargo.toml") &&
        providerId === "cadencr-service" &&
        kind === "dependency",
    ),
    "new SDK manifests must not depend on the service",
  );
});

test("the custom-tab backend SDK is not treated as a provider SDK", () => {
  const crates = providerBoundaryManifest().sdk.map(({ crate }) => crate);
  assert.ok(!crates.includes("cadencr_tab_backend"), crates.join(", "));
  assert.ok(crates.length > 0, "provider SDK crates must still be collected");
});
