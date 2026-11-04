import { useMemo } from "react";
import type { PluginTabSummary } from "@/api/generated";
import type { PluginIdentity } from "@/lib/plugin-tabs/broker-runtime";
import type { PluginTabOwnShortcut } from "@/shared/plugin-tab-host";

/** Identity-stable while the fields the broker uses are unchanged. */
export function usePluginIdentity(
  summary: PluginTabSummary,
  shortcuts: readonly PluginTabOwnShortcut[],
): PluginIdentity {
  const { id, name } = summary;
  const version = summary.version ?? "0.0.0";
  const origins = summary.network.allowed_origins.join("\n");
  const hasCommands = summary.commands.length > 0;
  const hasBackend = summary.backend != null;
  const backendProtocol = summary.backend?.protocol;
  return useMemo(
    () => ({
      id,
      name,
      version,
      allowedOrigins: lines(origins),
      hasCommands,
      hasBackend,
      backendProtocol,
      shortcuts: shortcuts.map((shortcut) => shortcut.id),
    }),
    [id, name, origins, version, hasCommands, hasBackend, backendProtocol, shortcuts],
  );
}

function lines(joined: string): string[] {
  return joined === "" ? [] : joined.split("\n");
}
