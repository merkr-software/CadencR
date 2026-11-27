import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { AlertTriangleIcon, GlobeIcon, Loader2Icon, PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export { BrowserTabStrip } from "./BrowserTabStrip";

export function BrowserLoading(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <GlobeIcon className="size-6 animate-pulse" />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin" />{" "}
        {t("workspace.tools.browserWorkspaceChrome.startingBrowser", "Starting browser…")}
      </div>
    </div>
  );
}

export function BrowserEmptyState({
  onNewTab,
  creating = false,
}: {
  onNewTab: () => void;
  creating?: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <GlobeIcon className="size-7" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t("workspace.tools.browserWorkspaceChrome.noBrowserTabOpen", "No browser tab open")}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t(
            "workspace.tools.browserWorkspaceChrome.openATabToPreviewYourApp",
            "Open a tab to preview your app, then send the page context straight to the agent.",
          )}
        </p>
      </div>
      <Button size="sm" onClick={onNewTab} disabled={creating} aria-busy={creating}>
        {creating ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <PlusIcon className="size-4" />
        )}
        {creating
          ? t("workspace.tools.browserWorkspaceChrome.openingTab", "Opening tab…")
          : t("workspace.browser.newTab", "New tab")}
      </Button>
    </div>
  );
}

export function BrowserError({
  title,
  message,
  onDismiss,
}: {
  title?: string;
  message: string;
  onDismiss: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-[color-mix(in_oklab,var(--destructive)_35%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_8%,var(--card))] px-3 py-2 text-xs text-foreground"
    >
      <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <div className="min-w-48 flex-1">
        {title ? (
          <>
            <p className="font-medium text-foreground">{title}</p>
            <p className="text-muted-foreground">{message}</p>
          </>
        ) : (
          <p className="truncate font-medium text-foreground">{message}</p>
        )}
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t(
          "workspace.tools.browserWorkspaceChrome.dismissBrowserError",
          "Dismiss browser error",
        )}
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}
