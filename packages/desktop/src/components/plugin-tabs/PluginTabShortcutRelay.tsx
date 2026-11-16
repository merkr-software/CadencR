import { memo, useEffect } from "react";
import { toast } from "sonner";

import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { appShortcutBindings } from "@/lib/plugin-tabs/tab-shortcuts";
import { useShortcutOverridesStore } from "@/lib/shortcuts/overrides";
import type { PluginTabKeyInput } from "@/shared/plugin-tab-host";

/**
 * Run a Cadencr shortcut pressed in a focused custom tab as if it had been
 * pressed here: the same key, dispatched from the page body, reaches the
 * same handlers (capture-phase and bubbling alike) with the same layout
 * matching.
 */
export function replayAppShortcut(input: PluginTabKeyInput, target: EventTarget = document.body) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

/**
 * Keeps the main process's copy of Cadencr's shortcuts current — so a
 * focused custom tab gives way to every one of them, rebound or not — and
 * runs the ones it hands back (docs/CUSTOM_TABS.md §5.1). Renders nothing;
 * mount it once.
 */
export const PluginTabShortcutRelay = memo(function PluginTabShortcutRelay(): null {
  const desktop = pluginTabsAvailable();
  const overrides = useShortcutOverridesStore((state) => state.overrides);

  useEffect(() => {
    if (!desktop) return;
    const bindings = appShortcutBindings(overrides).map(({ keys, altKeys }) =>
      altKeys ? { keys, altKeys } : { keys },
    );
    desktopBridge.pluginTabs.setAppShortcuts(bindings).catch((error: unknown) =>
      toast.error("Custom tabs may keep Cadencr's shortcuts while focused", {
        id: "plugin-tab-shortcuts",
        description: apiErrorMessage(error, "The desktop shell did not answer"),
      }),
    );
  }, [desktop, overrides]);

  useEffect(() => {
    if (!desktop) return;
    return desktopBridge.pluginTabs.onAppShortcut((input) => replayAppShortcut(input));
  }, [desktop]);

  return null;
});
