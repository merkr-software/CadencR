import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useRef, type ReactElement } from "react";
import {
  BugIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  MonitorSmartphoneIcon,
  MoreHorizontalIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { BrowserExternalButton } from "./BrowserExternalButton";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

interface BrowserToolbarActionsProps {
  activeTab: BrowserTabMetadata | null;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomIn: () => void;
  onDevTools: () => void;
  onOpenExternal: () => void;
  onFind: () => void;
  onAddComment: () => void;
  onResponsive: () => void;
  /** Open the Downloads popover; listed in the overflow menu once its button folds away. */
  onDownloads: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

function BrowserZoomMenuItems(props: BrowserToolbarActionsProps): ReactElement {
  const { t } = useUiTranslation();
  const disabled = !props.activeTab;
  const zoomPercent = props.activeTab?.zoomPercent ?? 100;
  return (
    <>
      <DropdownMenuItem disabled={disabled} onSelect={props.onZoomOut}>
        <MinusIcon /> {t("workspace.tools.browserToolbarActions.zoomOut", "Zoom out")}
      </DropdownMenuItem>
      <DropdownMenuItem
        aria-label={t(
          "workspace.tools.browserToolbarActions.resetZoomPercent",
          "Reset zoom ({{percent}}%)",
          { percent: zoomPercent },
        )}
        disabled={disabled}
        onSelect={props.onZoomReset}
      >
        {t("workspace.tools.browserToolbarActions.resetZoom", "Reset zoom")}
        <span className="ml-auto min-w-10 text-right font-mono text-[10px] text-muted-foreground">
          {zoomPercent}%
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={props.onZoomIn}>
        <PlusIcon /> {t("workspace.tools.browserToolbarActions.zoomIn", "Zoom in")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

function BrowserOverflowMenu(
  props: BrowserToolbarActionsProps & { devToolsShortcut: string; downloadsShortcut: string },
): ReactElement {
  const { t } = useUiTranslation();
  // Find and Downloads take focus themselves, so they run once the menu has
  // closed instead of fighting its focus restore.
  const afterClose = useRef<(() => void) | null>(null);
  const disabled = !props.activeTab;
  function runAfterClose(action: () => void): void {
    afterClose.current = action;
  }
  function handleCloseAutoFocus(event: Event): void {
    const action = afterClose.current;
    if (!action) return;
    afterClose.current = null;
    event.preventDefault();
    action();
  }
  return (
    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="hidden shrink-0 @max-[50rem]:inline-flex"
          // Stays enabled without a tab: Downloads belong to the scope, not the
          // tab. The Downloads popover returns focus here while its own button
          // is folded away.
          data-browser-overflow-trigger=""
          aria-label={t(
            "workspace.tools.browserToolbarActions.moreBrowserActions",
            "More Browser actions",
          )}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={handleCloseAutoFocus}>
        <BrowserZoomMenuItems {...props} />
        <DropdownMenuItem disabled={disabled} onSelect={() => runAfterClose(props.onFind)}>
          <SearchIcon /> {t("workspace.tools.browserToolbarActions.findInPage", "Find in page")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={props.onResponsive}>
          <MonitorSmartphoneIcon />
          {props.activeTab?.responsive.enabled
            ? t("workspace.tools.browserToolbarActions.exitResponsiveMode", "Exit responsive mode")
            : t("workspace.tools.browserToolbarActions.responsiveMode", "Responsive mode")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={props.onDevTools}>
          <BugIcon /> {t("workspace.tools.browserToolbarActions.devTools", "DevTools")}
          {props.devToolsShortcut ? (
            <span className="ml-auto text-xs tracking-widest text-muted-foreground">
              {props.devToolsShortcut}
            </span>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={props.onOpenExternal}
          title={t(
            "workspace.tools.browserToolbarActions.cookiesAndSignInStateAreNotTransferred",
            "Cookies and sign-in state are not transferred",
          )}
        >
          <ExternalLinkIcon />{" "}
          {t(
            "workspace.tools.browserToolbarActions.openInDefaultBrowser",
            "Open in default browser",
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runAfterClose(props.onDownloads)}>
          <DownloadIcon /> {t("workspace.tools.browserToolbarActions.downloads", "Downloads")}
          {props.downloadsShortcut ? (
            <span className="ml-auto text-xs tracking-widest text-muted-foreground">
              {props.downloadsShortcut}
            </span>
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const BrowserToolbarActions = memo(function BrowserToolbarActions(
  props: BrowserToolbarActionsProps,
): ReactElement {
  const { t } = useUiTranslation();
  const disabled = !props.activeTab;
  const responsive = props.activeTab?.responsive.enabled === true;
  const devToolsShortcut = useShortcutLabel("browser-devtools");
  const downloadsShortcut = useShortcutLabel("browser-downloads");
  return (
    <>
      <BrowserZoomButtons {...props} />
      <div className="flex shrink-0 items-center gap-1.5 @max-[50rem]:hidden">
        <BrowserExternalButton disabled={disabled} onClick={props.onOpenExternal} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={props.onFind}
          aria-label={t("workspace.tools.browserToolbarActions.findInPage", "Find in page")}
        >
          <SearchIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant={responsive ? "secondary" : "ghost"}
          size="icon-sm"
          disabled={disabled}
          onClick={props.onResponsive}
          aria-label={
            responsive
              ? t(
                  "workspace.tools.browserToolbarActions.exitResponsiveMode",
                  "Exit responsive mode",
                )
              : t(
                  "workspace.tools.browserToolbarActions.openResponsiveMode",
                  "Open responsive mode",
                )
          }
          aria-pressed={responsive}
        >
          <MonitorSmartphoneIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={props.onDevTools}
          aria-label={t("workspace.tools.browserToolbarActions.devTools", "DevTools")}
          title={
            devToolsShortcut
              ? t(
                  "workspace.tools.browserToolbarActions.devToolsShortcut",
                  "DevTools ({{shortcut}})",
                  { shortcut: devToolsShortcut },
                )
              : t("workspace.tools.browserToolbarActions.devTools", "DevTools")
          }
        >
          <BugIcon className="size-4" />
        </Button>
      </div>
      {/* Commenting is the main way to steer the agent from a page, so it stays
          on the toolbar at every width and only drops its label when cramped. */}
      <Button
        type="button"
        size="sm"
        className="shrink-0 @max-[36rem]:px-2"
        disabled={disabled}
        onClick={props.onAddComment}
        aria-label={t("workspace.tools.browserToolbarActions.addComment", "Add comment")}
      >
        <MessageSquarePlusIcon className="size-3.5" />
        <span className="@max-[36rem]:sr-only">
          {t("workspace.tools.browserToolbarActions.addComment", "Add comment")}
        </span>
      </Button>
      <BrowserOverflowMenu
        {...props}
        devToolsShortcut={devToolsShortcut}
        downloadsShortcut={downloadsShortcut}
      />
    </>
  );
});

function BrowserZoomButtons(props: BrowserToolbarActionsProps): ReactElement {
  const { t } = useUiTranslation();
  const disabled = !props.activeTab;
  return (
    <div className="flex shrink-0 items-center rounded-md bg-muted/50 p-0.5 @max-[28rem]:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        onClick={props.onZoomOut}
        aria-label={t("workspace.tools.browserToolbarActions.zoomOut", "Zoom out")}
      >
        <MinusIcon className="size-3" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={props.onZoomReset}
        aria-label={t(
          "workspace.tools.browserToolbarActions.resetPageZoomTo100",
          "Reset page zoom to 100%",
        )}
        className="min-w-11 px-1 font-mono text-[10px]"
      >
        {props.activeTab?.zoomPercent ?? 100}%
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        onClick={props.onZoomIn}
        aria-label={t("workspace.tools.browserToolbarActions.zoomIn", "Zoom in")}
      >
        <PlusIcon className="size-3" />
      </Button>
    </div>
  );
}
