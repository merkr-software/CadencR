import type { ReactNode } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settleExternalOpen, usePluginTabRuntimeStore } from "@/lib/plugin-tabs/runtime-store";

/**
 * Confirms a custom tab's `ui.openExternal` before the link leaves the app.
 * One request at a time per tab, oldest first; closing the dialog declines.
 * The dialog suppresses native views while open, so the guest can't cover it.
 */
export function PluginTabExternalOpenDialog({ instanceId }: { instanceId: string }): ReactNode {
  const request = usePluginTabRuntimeStore(
    (state) => state.externalOpens.find((entry) => entry.instanceId === instanceId) ?? null,
  );
  if (!request) return null;
  return (
    <ConfirmDialog
      key={request.id}
      open
      onOpenChange={(open) => {
        if (!open) settleExternalOpen(request.id, false);
      }}
      title="Open link in your browser?"
      description={`${request.pluginName} wants to open this page:`}
      confirmText="Open link"
      onConfirm={() => settleExternalOpen(request.id, true)}
    >
      <p className="rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 font-mono text-[12px] break-all text-foreground">
        {request.url}
      </p>
    </ConfirmDialog>
  );
}
