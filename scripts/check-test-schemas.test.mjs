import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { scanTestSchemas } from "./check-test-schemas.mjs";

function fixtureRoot(context, files) {
  const root = mkdtempSync(join(tmpdir(), "cadencr-test-schemas-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "packages/service/src"), { recursive: true });
  mkdirSync(join(root, "packages/service/tests"), { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test("the repository matches the reviewed list of hand-written schemas", () => {
  assert.deepEqual(scanTestSchemas(), { added: [], converted: [] });
});

test("a new hand-written schema fails, in src/ or tests/", (context) => {
  const root = fixtureRoot(context, {
    "packages/service/src/domain/a.rs": 'sqlx::query("CREATE TABLE features (id INTEGER)")',
    "packages/service/tests/b.rs": "create table if not exists agent_sessions(id INTEGER)",
    "packages/service/src/domain/c.rs": "CREATE TABLE feature_settings (id INTEGER)",
  });
  assert.deepEqual(scanTestSchemas(root, new Set()), {
    added: ["packages/service/src/domain/a.rs", "packages/service/tests/b.rs"],
    converted: [],
  });
});

test("a converted legacy file must leave the list, so the ratchet only shrinks", (context) => {
  const root = fixtureRoot(context, {
    "packages/service/src/domain/a.rs": "let pool = migrated_pool().await;",
  });
  assert.deepEqual(scanTestSchemas(root, new Set(["packages/service/src/domain/a.rs"])), {
    added: [],
    converted: ["packages/service/src/domain/a.rs"],
  });
});

test("migration tests keep their historical schemas", (context) => {
  const root = fixtureRoot(context, {
    "packages/service/src/shared/migrate/old_tests.rs": "CREATE TABLE features (id INTEGER)",
  });
  assert.deepEqual(scanTestSchemas(root, new Set()), { added: [], converted: [] });
});
