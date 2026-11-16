/**
 * Workspace-setting keys for the per-provider "allow dangerous mode" toggles.
 *
 * Stored as `"true" | "false"` strings via the standard workspace settings
 * API (`useGetWorkspaceSetting`/`useSetWorkspaceSetting`). When the value
 * parses as `"true"`, Claude's `bypassPermissions` mode becomes part of the
 * Shift+Tab cycle.
 */
export const CLAUDE_BYPASS_PERMISSIONS_SETTING_KEY = "claude_bypass_permissions_enabled";

export const CODEX_PERMISSION_MODE_SETTING_KEY = "codex_permission_mode";
