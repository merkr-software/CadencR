import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactNode } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settleExternalOpen, usePluginTabRuntimeStore } from "@/lib/plugin-tabs/runtime-store";

/**
 * Confirms a custom tab's `ui.openExternal` before the link leaves the app.
 * One request at a time per tab, oldest first; closing the dialog declines.
 * The dialog suppresses native views while open, so the guest can't cover it.
 */
export function PluginTabExternalOpenDialog({ instanceId }: { instanceId: string }): ReactNode {
  const { t } = useUiTranslation();
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
      title={t(
        "customTabs.pluginTabExternalOpenDialog.openLinkInYourBrowser",
        "Open link in your browser?",
      )}
      description={t("customTabs.externalOpen.description", "{{name}} wants to open this page:", {
        name: request.pluginName,
      })}
      confirmText={t("customTabs.externalOpen.confirm", "Open link")}
      onConfirm={() => settleExternalOpen(request.id, true)}
    >
      <p className="rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 font-mono text-[12px] break-all text-foreground">
        {request.url}
      </p>
    </ConfirmDialog>
  );
}
