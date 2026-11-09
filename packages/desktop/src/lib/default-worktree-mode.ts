import { settingsArrayToMap, type SettingEntry } from "@/api/settings";

export const DEFAULT_WORKTREE_MODE_KEY = "default_worktree_mode";

export type DefaultWorktreeMode = "new" | "skip";

/** Marks a project's default-mode write, so the mode picker can show it's saving. */
export function defaultWorktreeModeMutationKey(projectId: number) {
  return ["project-setting", projectId, DEFAULT_WORKTREE_MODE_KEY] as const;
}

export function parseDefaultWorktreeMode(value: string | null | undefined): DefaultWorktreeMode {
  return value === "skip" ? "skip" : "new";
}

export function defaultWorktreeModeFromSettings(
  settings: SettingEntry[] | undefined,
  fallback: DefaultWorktreeMode = "new",
): DefaultWorktreeMode {
  const value = settingsArrayToMap(settings)[DEFAULT_WORKTREE_MODE_KEY];
  return value == null || value === "" ? fallback : parseDefaultWorktreeMode(value);
}
