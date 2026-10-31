import { memo, useMemo, useState, type ReactElement } from "react";
import type { TabContext } from "@cadencr/tab-sdk/protocol";

import type { PluginTabSummary } from "@/api/generated";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import type { PluginIdentity } from "@/lib/plugin-tabs/broker-runtime";
import { pluginTabInstanceId } from "@/lib/plugin-tabs/instance-id";
import { refreshPluginTabsOrToast } from "@/lib/plugin-tabs/live-instances";
import { useOpenCustomTabProject } from "@/components/settings/custom-tabs/useOpenCustomTabProject";
import { useDocumentVisible } from "@/hooks/useDocumentVisible";
import type { PluginTabOwnShortcut } from "@/shared/plugin-tab-host";
import { pluginTabKind } from "@/stores/feature-layout-schema";
import {
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

import { PluginTabActivityDialog } from "./PluginTabActivityDialog";
import { PluginTabExternalOpenDialog } from "./PluginTabExternalOpenDialog";
import { PluginTabOverlay, type PluginTabOverlayState } from "./PluginTabOverlay";
import { backendPlatforms, backendUnavailableHere } from "./plugin-tab-access";
import { usePluginTabGuest, type GuestPhase } from "./usePluginTabGuest";
import { useActiveTabShortcuts } from "./useTabShortcuts";
import { usePluginTabNavigation } from "./usePluginTabNavigation";

export interface PluginTabViewProps {
  featureId: number;
  summary: PluginTabSummary;
  context: TabContext;
}

/**
 * Why no guest runs for this tab, or `null` when one should. A tab whose
 * backend can't run on this platform gets no guest either — so no broker —
 * rather than a page whose every backend call fails. The presence keeper
 * leases exactly the tabs with a backend this returns `null` for.
 */
export function staticOverlayState(
  summary: PluginTabSummary,
  desktop: boolean,
): PluginTabOverlayState | null {
  if (!desktop) return { kind: "remote" };
  // Blocked while open: `live` turns false, which disposes the guest and its broker.
  if (summary.status === "blocked")
    return { kind: "blocked", reason: summary.blocked_reason ?? null };
  if (summary.status === "invalid") return { kind: "invalid", errors: summary.errors };
  if (backendUnavailableHere(summary)) {
    return { kind: "unavailable", platforms: backendPlatforms(summary.backend) };
  }
  if (!summary.enablement.effective) return { kind: "disabled" };
  if (!summary.entry_present) {
    return {
      kind: "not-built",
      dir: summary.dir,
      canOpenProject: summary.authoring_project_id != null,
    };
  }
  return null;
}

function guestOverlayState(phase: GuestPhase): PluginTabOverlayState | null {
  switch (phase.kind) {
    case "ready":
      return null;
    case "loading":
    case "recycled":
      return { kind: "loading" };
    case "failed":
      return { kind: "failed", detail: phase.detail };
    case "crashed":
      return { kind: "crashed", detail: phase.detail };
  }
}

/**
 * Body of a `plugin:<id>` tab. A placeholder the native guest view is laid
 * over (§5.1); while there is no guest to show — loading, not built,
 * invalid, unavailable on this platform, off, failed, crashed, or outside
 * the desktop app — the placeholder renders that state instead and the view
 * stays hidden.
 */
export const PluginTabView = memo(function PluginTabView({
  featureId,
  summary,
  context,
}: PluginTabViewProps): ReactElement {
  const instanceId = pluginTabInstanceId(featureId, summary.id);
  const desktop = pluginTabsAvailable();
  const blocked = staticOverlayState(summary, desktop);
  const tabVisible = useFeatureLayoutStore((state) =>
    isTabVisible(selectFeatureLayout(featureId)(state), pluginTabKind(summary.id)),
  );
  const documentVisible = useDocumentVisible();
  const [placeholder, setPlaceholder] = useState<HTMLDivElement | null>(null);
  const shortcuts = useActiveTabShortcuts(summary.shortcuts);
  const plugin = usePluginIdentity(summary, shortcuts);
  const guest = usePluginTabGuest({
    instanceId,
    featureId,
    plugin,
    context,
    live: blocked === null,
    visible: tabVisible && documentVisible,
    placeholder,
    shortcuts,
  });
  const navigation = usePluginTabNavigation();
  const projectOpener = useOpenCustomTabProject();
  const overlay = blocked ?? guestOverlayState(guest.phase);
  // Without a guest, "Reload" re-reads the tab (a build the watcher missed, a fixed manifest).

  return (
    <div
      ref={setPlaceholder}
      data-plugin-tab={summary.id}
      data-plugin-tab-state={overlay?.kind ?? "ready"}
      className="relative h-full w-full overflow-hidden bg-background"
    >
      {overlay && (
        <div className="absolute inset-0 overflow-y-auto">
          <PluginTabOverlay
            state={overlay}
            name={summary.name}
            onReload={blocked ? refreshPluginTabsOrToast : guest.reload}
            onManage={navigation.openSettings}
            onOpenProject={() =>
              projectOpener.open(summary.id, "Could not open the custom tab's project")
            }
            openingProject={projectOpener.openingId === summary.id}
          />
        </div>
      )}
      {blocked === null && <PluginTabExternalOpenDialog instanceId={instanceId} />}
      <PluginTabActivityDialog instanceId={instanceId} featureId={featureId} summary={summary} />
    </div>
  );
});

/** Identity-stable while the fields the broker uses are unchanged. */
function usePluginIdentity(
  summary: PluginTabSummary,
  shortcuts: readonly PluginTabOwnShortcut[],
): PluginIdentity {
  const { id, name } = summary;
  const version = summary.version ?? "0.0.0";
  const origins = summary.network.allowed_origins.join("\n");
  const hasCommands = summary.commands.length > 0;
  const hasBackend = summary.backend != null;
  return useMemo(
    () => ({
      id,
      name,
      version,
      allowedOrigins: lines(origins),
      hasCommands,
      hasBackend,
      shortcuts: shortcuts.map((shortcut) => shortcut.id),
    }),
    [id, name, origins, version, hasCommands, hasBackend, shortcuts],
  );
}

function lines(joined: string): string[] {
  return joined === "" ? [] : joined.split("\n");
}
