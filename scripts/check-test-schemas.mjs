// Ratchet for hand-written test schemas in the service crate.
//
// Tests that recreate `features` / `agent_sessions` by hand drift from the
// migrated schema and, above all, declare no foreign keys, so they cannot see
// integrity errors. New tests build their pool with
// `cadencr_service::shared::test_db::migrated_pool()` instead.
//
//   node scripts/check-test-schemas.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_ROOTS = ["packages/service/src", "packages/service/tests"];
// Migration tests model historical schema shapes on purpose.
const EXEMPT_PREFIX = "packages/service/src/shared/migrate/";
const HAND_WRITTEN_SCHEMA =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:features|agent_sessions)"?[\s(]/i;

// Files that still had a hand-written schema when the ratchet landed. The list
// only shrinks: convert a file to `migrated_pool()` and remove its entry.
export const LEGACY_FILES = new Set([
  "packages/service/src/domain/agents/claude_code/bypass_permissions.rs",
  "packages/service/src/domain/agents/selection.rs",
  "packages/service/src/domain/diff_comments/repository.rs",
  "packages/service/src/domain/features/archive.rs",
  "packages/service/src/domain/features/repository/feature_repository.rs",
  "packages/service/src/domain/git/repository.rs",
  "packages/service/src/domain/git/service/mod.rs",
  "packages/service/src/domain/git/watcher/registry.rs",
  "packages/service/src/domain/git/workflow_service/index.rs",
  "packages/service/src/domain/git/workflow_service/status.rs",
  "packages/service/src/domain/git/workflow_service/target_branch.rs",
  "packages/service/src/domain/git/workflow_service/update_branch/test_support.rs",
  "packages/service/src/domain/imports/persistence.rs",
  "packages/service/src/domain/imports/service.rs",
  "packages/service/src/domain/maintenance/retention/test_support.rs",
  "packages/service/src/domain/mcp/control.rs",
  "packages/service/src/domain/neovim/service.rs",
  "packages/service/src/domain/ports/repository.rs",
  "packages/service/src/domain/projects/service.rs",
  "packages/service/src/domain/session_status/broadcaster.rs",
  "packages/service/src/domain/session_status/journal.rs",
  "packages/service/src/domain/sessions/activity_digest.rs",
  "packages/service/src/domain/sessions/prompt_index.rs",
  "packages/service/src/domain/sessions/repository/conversation_references.rs",
  "packages/service/src/domain/sessions/repository/test_support.rs",
  "packages/service/src/domain/sessions/unified_agents.rs",
  "packages/service/src/domain/settings.rs",
  "packages/service/src/domain/workflow/worktree/db.rs",
  "packages/service/src/domain/workflow/worktree/replay.rs",
  "packages/service/src/domain/workflow/worktree/setup.rs",
  "packages/service/src/domain/ws_session/auto_name/title_state.rs",
  "packages/service/src/domain/ws_session/handler/session_branch/fork_db.rs",
  "packages/service/src/domain/ws_session/handler/session_branch/rewind_state.rs",
  "packages/service/src/domain/ws_session/handler/session_init_restore.rs",
  "packages/service/src/domain/ws_session/handler/tests/support.rs",
  "packages/service/src/domain/ws_session/persistence/pending_user_input.rs",
  "packages/service/src/domain/ws_session/persistence/reported_model.rs",
  "packages/service/src/domain/ws_session/persistence/session_archiving.rs",
  "packages/service/src/domain/ws_session/persistence/session_bootstrap.rs",
  "packages/service/src/domain/ws_session/persistence/session_cleanup.rs",
  "packages/service/src/domain/ws_session/persistence/session_queries.rs",
  "packages/service/src/domain/ws_session/persistence/session_state.rs",
  "packages/service/src/domain/ws_session/persistence/stream_writer/events.rs",
  "packages/service/src/domain/ws_session/persistence/stream_writer/subagents.rs",
  "packages/service/src/domain/ws_session/persistence/stream_writer/tool_reconciliation.rs",
  "packages/service/src/domain/ws_session/persistence_health.rs",
  "packages/service/src/domain/ws_session/runtime/application/control_dispatch_config.rs",
  "packages/service/src/domain/ws_session/runtime/application/pending_gate.rs",
  "packages/service/src/domain/ws_session/runtime/application/permission.rs",
  "packages/service/src/domain/ws_session/runtime/application/permission_pending.rs",
  "packages/service/src/domain/ws_session/runtime/post_plan_mode.rs",
  "packages/service/tests/common/mod.rs",
  "packages/service/tests/common/worktree.rs",
  "packages/service/tests/global_settings/workspace_mcp_activity.rs",
  "packages/service/tests/global_settings/workspace_mcp_tools.rs",
  "packages/service/tests/integration/mcp_spawn.rs",
  "packages/service/tests/integration/message_content_revision_migration.rs",
  "packages/service/tests/integration/project_mcp_compare.rs",
  "packages/service/tests/integration/project_mcp_links.rs",
  "packages/service/tests/integration/project_mcp_tail.rs",
  "packages/service/tests/integration/project_mcp_tools.rs",
  "packages/service/tests/integration/project_mcp_worktree.rs",
]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function scanTestSchemas(root = ROOT, legacyFiles = LEGACY_FILES) {
  const found = new Set();
  for (const scanRoot of SCAN_ROOTS) {
    for (const absolutePath of walk(join(root, scanRoot))) {
      const path = relative(root, absolutePath).split(sep).join("/");
      if (!path.endsWith(".rs") || path.startsWith(EXEMPT_PREFIX)) continue;
      if (HAND_WRITTEN_SCHEMA.test(readFileSync(absolutePath, "utf8"))) found.add(path);
    }
  }
  return {
    added: [...found].filter((path) => !legacyFiles.has(path)).sort(),
    converted: [...legacyFiles].filter((path) => !found.has(path)).sort(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { added, converted } = scanTestSchemas();
  for (const path of added) {
    console.error(
      `${path}: hand-written features/agent_sessions schema; build the pool with shared::test_db::migrated_pool()`,
    );
  }
  for (const path of converted) {
    console.error(`${path}: no hand-written schema left; remove it from LEGACY_FILES`);
  }
  if (added.length > 0 || converted.length > 0) process.exitCode = 1;
  else console.log("Test schema ratchet passed.");
}
