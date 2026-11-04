import type { PluginTabSummary } from "@/api/generated";
import { backendUnavailableHere } from "@/components/plugin-tabs/plugin-tab-access";

export const EDITOR_BACKEND_KEY = "editor_backend";

export type EditorTarget =
  | { kind: "loading"; id: string }
  | { kind: "codemirror"; id: string; reason?: string }
  | { kind: "neovim"; id: "neovim" }
  | { kind: "plugin"; id: string; plugin: PluginTabSummary };

/** An explicit editor choice is independent of CodeMirror's Vim motions. */
export function resolveEditorId(value: string | null | undefined, vimLevel: string): string {
  return value ?? (vimLevel === "2" ? "neovim" : "codemirror");
}

export function pluginEditorUnavailable(plugin: PluginTabSummary): string | undefined {
  if (!plugin.editor || !plugin.backend) return "This plugin does not contribute an editor.";
  if (plugin.status === "blocked") return "The selected editor plugin is blocked.";
  if (plugin.status !== "valid") return "The selected editor plugin is invalid.";
  if (!plugin.enablement.effective)
    return "The selected editor plugin is disabled or needs consent.";
  if (backendUnavailableHere(plugin)) return "The selected editor is unavailable on this platform.";
  if (!plugin.entry_present) return "The selected editor plugin has not been built.";
  return undefined;
}

export function resolveEditorTarget({
  id,
  plugins,
  desktop,
  mobile,
  loading = false,
}: {
  id: string;
  plugins: readonly PluginTabSummary[];
  desktop: boolean;
  mobile: boolean;
  loading?: boolean;
}): EditorTarget {
  const fallback = (reason: string): EditorTarget => ({ kind: "codemirror", id, reason });
  if (loading) return { kind: "loading", id };
  if (id === "codemirror") return { kind: "codemirror", id };
  if (id !== "neovim" && !id.startsWith("plugin:"))
    return fallback("The selected editor is unknown. Showing CodeMirror.");
  if (mobile) return fallback("The selected editor is unavailable on mobile. Showing CodeMirror.");
  // The built-in Neovim editor runs in non-mobile browsers too; only plugin
  // surfaces require the desktop shell.
  if (id === "neovim") return { kind: "neovim", id };
  if (!desktop)
    return fallback("The selected editor requires the desktop app. Showing CodeMirror.");
  const plugin = plugins.find((candidate) => candidate.id === id.slice("plugin:".length));
  if (!plugin) return fallback("The selected editor plugin is not installed. Showing CodeMirror.");
  const reason = pluginEditorUnavailable(plugin);
  return reason ? fallback(`${reason} Showing CodeMirror.`) : { kind: "plugin", id, plugin };
}
