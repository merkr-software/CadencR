import { memo, useMemo, useState } from "react";
import type { TabContext } from "@cadencr/tab-sdk/protocol";
import type { PluginTabSummary } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentVisible } from "@/hooks/useDocumentVisible";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { pluginEditorInstanceId } from "@/lib/plugin-tabs/instance-id";
import { staticOverlayState } from "../plugin-tabs/PluginTabView";
import { PluginTabExternalOpenDialog } from "../plugin-tabs/PluginTabExternalOpenDialog";
import { useActiveTabShortcuts } from "../plugin-tabs/useTabShortcuts";
import { useEditorAppearance } from "./useEditorAppearance";
import { usePluginIdentity } from "./usePluginIdentity";
import { usePluginSurface } from "./usePluginSurface";

export interface PluginEditorSurfaceProps {
  featureId: number;
  summary: PluginTabSummary;
  context: TabContext;
  visible: boolean;
}

/** @public Host primitive consumed by editor routing independently of the tab strip. */
export const PluginEditorSurface = memo(function PluginEditorSurface({
  featureId,
  summary,
  context,
  visible,
}: PluginEditorSurfaceProps) {
  const instanceId = pluginEditorInstanceId(featureId, summary.id);
  const surface = useMemo(() => ({ kind: "editor" as const, instanceId }), [instanceId]);
  const [placeholder, setPlaceholder] = useState<HTMLDivElement | null>(null);
  const shortcuts = useActiveTabShortcuts(summary.shortcuts);
  const plugin = usePluginIdentity(summary, shortcuts);
  const appearance = useEditorAppearance();
  const documentVisible = useDocumentVisible();
  const blocked = staticOverlayState(summary, pluginTabsAvailable());
  const live = blocked === null && summary.editor != null;
  const guest = usePluginSurface({
    instanceId,
    featureId,
    plugin,
    context,
    surface,
    appearance,
    live,
    visible: visible && documentVisible,
    placeholder,
    shortcuts,
  });
  const loading = live && (guest.phase.kind === "loading" || guest.phase.kind === "recycled");
  const failure = !live
    ? "This plugin editor is unavailable. Check its enablement, consent and platform in Settings."
    : guest.phase.kind === "failed" || guest.phase.kind === "crashed"
      ? (guest.phase.detail ?? "The plugin editor stopped.")
      : null;
  return (
    <div
      ref={setPlaceholder}
      data-plugin-editor={summary.id}
      className="relative h-full w-full overflow-hidden bg-background"
    >
      {loading && (
        <div
          role="status"
          aria-label={`Loading ${summary.editor?.label ?? summary.name}`}
          className="p-3"
        >
          <Skeleton className="h-4 w-40" />
        </div>
      )}
      {failure && (
        <div role="alert" className="space-y-3 p-3 text-sm">
          <p>{failure}</p>
          {live && (
            <Button variant="outline" size="sm" onClick={guest.reload}>
              Reload editor
            </Button>
          )}
        </div>
      )}
      {live && <PluginTabExternalOpenDialog instanceId={instanceId} />}
    </div>
  );
});
