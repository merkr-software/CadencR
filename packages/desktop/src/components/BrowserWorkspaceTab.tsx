import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { desktopBridge, isDesktopShell, type BrowserTabMetadata } from "@/lib/desktop-bridge";
import { useBrowserDefaultMode, type CookieMode } from "@/lib/browser-settings";
import { useSuppressBrowserView } from "@/lib/browser-suppression";
import { BrowserAddressBar } from "./browser/BrowserAddressBar";
import { BrowserCommentDock } from "./browser/BrowserCommentDock";
import { BrowserCommentOverlay } from "./browser/BrowserCommentOverlay";
import { BrowserFindToolbar } from "./browser/BrowserFindToolbar";
import { BrowserDownloadsPanel } from "./browser/BrowserDownloadsPanel";
import { BrowserPermissionPrompt } from "./browser/BrowserPermissionPrompt";
import { BrowserPopupNotice } from "./browser/BrowserPopupNotice";
import { BrowserResponsiveToolbar } from "./browser/BrowserResponsiveToolbar";
import {
  BrowserResponsiveFrame,
  BrowserSnapshot,
  useBrowserResponsiveGeometry,
} from "./browser/BrowserResponsiveViewport";
import { BrowserSiteInformation } from "./browser/BrowserSiteInformation";
import {
  BrowserEmptyState,
  BrowserError,
  BrowserLoading,
  BrowserTabStrip,
} from "./browser/BrowserWorkspaceChrome";
import { showBrowserError } from "./browser/browser-errors";
import { useBrowserComments } from "./browser/useBrowserComments";
import { useBrowserKeyboard } from "./browser/useBrowserKeyboard";
import {
  useBrowserWorkspaceModel,
  type BrowserWorkspaceModel,
} from "./browser/useBrowserWorkspaceModel";

interface BrowserWorkspaceTabProps {
  /**
   * The feature-layout scope that owns this workspace's tabs. Tabs are isolated
   * per scope so a tab opened here never leaks into another feature's Browser.
   */
  scopeId: number;
  onSendContext: (message: string, images?: Array<{ base64: string; mimeType: string }>) => void;
}

export const BrowserWorkspaceTab = memo(function BrowserWorkspaceTab(
  props: BrowserWorkspaceTabProps,
): ReactElement {
  if (!isDesktopShell()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        The embedded browser is only available in the desktop app.
      </div>
    );
  }
  return <DesktopBrowserWorkspaceTab {...props} />;
});

const DesktopBrowserWorkspaceTab = memo(function DesktopBrowserWorkspaceTab({
  scopeId,
  onSendContext,
}: BrowserWorkspaceTabProps): ReactElement {
  // Resolve the user's default mode before mounting the workspace so the first
  // tab and the toolbar toggle both start from the saved preference.
  const { mode: defaultMode, isLoading } = useBrowserDefaultMode();
  if (isLoading) return <BrowserLoading />;
  return (
    <BrowserWorkspaceTabReady
      scopeId={scopeId}
      onSendContext={onSendContext}
      defaultMode={defaultMode}
    />
  );
});

const BrowserWorkspaceTabReady = memo(function BrowserWorkspaceTabReady({
  scopeId,
  onSendContext,
  defaultMode,
}: BrowserWorkspaceTabProps & { defaultMode: CookieMode }): ReactElement {
  const model = useBrowserWorkspaceModel(defaultMode, scopeId);
  const comments = useBrowserComments({ runForActive: model.runForActive, onSend: onSendContext });
  if (model.loading) return <BrowserLoading />;
  return <BrowserWorkspaceView scopeId={scopeId} model={model} comments={comments} />;
});

type CommentsController = ReturnType<typeof useBrowserComments>;

function BrowserWorkspaceView({
  scopeId,
  model,
  comments,
}: {
  scopeId: number;
  model: BrowserWorkspaceModel;
  comments: CommentsController;
}): ReactElement {
  const newTab = useCallback((): void => void model.newTab(), [model.newTab]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [permissionPromptOpen, setPermissionPromptOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [responsiveMenuOpen, setResponsiveMenuOpen] = useState(false);
  const responsiveGeometry = useBrowserResponsiveGeometry(containerRef, model.activeTab);
  const toggleDownloads = useCallback((): void => setDownloadsOpen((value) => !value), []);
  const openDownloads = useCallback((): void => setDownloadsOpen(true), []);
  useBrowserKeyboard(model, comments.addComment, toggleDownloads);
  // Freeze the native view (and show a snapshot) whenever a renderer overlay
  // needs to sit over the page region: the URL suggestions or a comment form.
  const overlayActive =
    suggestionsOpen ||
    siteOpen ||
    tabMenuOpen ||
    permissionPromptOpen ||
    downloadsOpen ||
    responsiveMenuOpen ||
    comments.draft !== null;
  const snapshot = useSuppressedBrowserSnapshot(overlayActive, model.activeTab);
  useSuppressBrowserView(snapshot.suppressNativeView);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <BrowserToolbar
        model={model}
        scopeId={scopeId}
        onAddComment={comments.addComment}
        onSuggestionOverlayOpenChange={setSuggestionsOpen}
        onSiteOverlayOpenChange={setSiteOpen}
        onChromeOverlayOpenChange={setTabMenuOpen}
        downloadsOpen={downloadsOpen}
        onDownloadsOpenChange={setDownloadsOpen}
        onOpenDownloads={openDownloads}
        responsiveDisplayScale={responsiveGeometry?.displayScale ?? null}
        onResponsiveOverlayOpenChange={setResponsiveMenuOpen}
      />
      {model.find.open ? <BrowserFindToolbar find={model.find} /> : null}
      {model.state.error ? (
        <BrowserError message={model.state.error} onDismiss={model.clearError} />
      ) : null}
      <BrowserPopupNotice scopeId={scopeId} activeTabId={model.state.activeTabId} />
      <BrowserCommentDock
        count={comments.comments.length}
        picking={comments.picking}
        onSend={comments.send}
        onDiscardAll={comments.discardAll}
      />
      <div
        ref={containerRef}
        className={`relative min-h-0 flex-1 ${responsiveGeometry ? "bg-muted/30" : ""}`}
      >
        {model.activeTab?.loading ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/15">
            <div className="h-full w-1/3 animate-[browser-progress_1.1s_ease-in-out_infinite] bg-primary" />
          </div>
        ) : null}
        <BrowserResponsiveFrame geometry={responsiveGeometry} />
        <div ref={model.viewportRef} className="absolute inset-0" />
        {overlayActive && snapshot.src ? (
          <BrowserSnapshot src={snapshot.src} geometry={responsiveGeometry} />
        ) : null}
        {comments.draft ? (
          <BrowserCommentOverlay
            draft={comments.draft}
            containerRef={containerRef}
            pageGeometry={responsiveGeometry}
            onSave={comments.saveDraft}
            onCancel={comments.cancelDraft}
            onToggleScreenshot={comments.toggleDraftScreenshot}
            onRemove={comments.removeComment}
          />
        ) : null}
        {model.activeTab ? null : (
          <BrowserEmptyState onNewTab={newTab} creating={model.creatingMode !== null} />
        )}
      </div>
      <BrowserPermissionPrompt scopeId={scopeId} onOpenChange={setPermissionPromptOpen} />
    </div>
  );
}

function BrowserToolbar({
  model,
  scopeId,
  onAddComment,
  onSuggestionOverlayOpenChange,
  onSiteOverlayOpenChange,
  onChromeOverlayOpenChange,
  downloadsOpen,
  onDownloadsOpenChange,
  onOpenDownloads,
  responsiveDisplayScale,
  onResponsiveOverlayOpenChange,
}: {
  model: BrowserWorkspaceModel;
  scopeId: number;
  onAddComment: () => void;
  onSuggestionOverlayOpenChange: (open: boolean) => void;
  onSiteOverlayOpenChange: (open: boolean) => void;
  onChromeOverlayOpenChange: (open: boolean) => void;
  downloadsOpen: boolean;
  onDownloadsOpenChange: (open: boolean) => void;
  onOpenDownloads: () => void;
  responsiveDisplayScale: number | null;
  onResponsiveOverlayOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    // z-30 lifts the toolbar's stacking context (created by backdrop-blur) above
    // the page region, so the suggestions dropdown — trapped inside it — paints
    // over the (suppressed) viewport instead of behind its click-catching div.
    <div className="relative z-30 flex shrink-0 flex-col gap-1.5 border-b bg-card/95 px-2 pb-2 pt-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <BrowserTabStrip model={model} onChromeOverlayOpenChange={onChromeOverlayOpenChange} />
      <BrowserAddressBar
        urlInput={model.urlInput}
        pending={model.pending}
        activeTab={model.activeTab}
        tabs={model.state.tabs}
        inputRef={model.urlInputRef}
        onUrlChange={model.setUrlInput}
        onUrlEditingChange={model.setUrlEditing}
        onNavigate={(url) => void model.navigate(url)}
        onActivateTab={model.activateTab}
        onBack={model.back}
        onForward={model.forward}
        onReload={model.reload}
        onStop={model.stop}
        onZoomIn={model.zoomIn}
        onZoomOut={model.zoomOut}
        onZoomReset={model.zoomReset}
        onFind={model.find.openFind}
        onDevTools={model.devTools}
        onOpenExternal={model.openExternal}
        onAddComment={onAddComment}
        onResponsive={model.responsive.toggle}
        onSuggestionOverlayOpenChange={onSuggestionOverlayOpenChange}
        onDownloads={onOpenDownloads}
        downloadsControl={
          <BrowserDownloadsPanel
            scopeId={scopeId}
            open={downloadsOpen}
            onOpenChange={onDownloadsOpenChange}
          />
        }
        siteControl={
          <BrowserSiteInformation
            activeTab={model.activeTab}
            onOverlayOpenChange={onSiteOverlayOpenChange}
          />
        }
      />
      {model.activeTab?.responsive.enabled || model.activeTab?.responsive.status === "error" ? (
        <BrowserResponsiveToolbar
          tab={model.activeTab}
          pending={model.pending}
          displayScale={responsiveDisplayScale}
          onApply={model.responsive.apply}
          onOverlayOpenChange={onResponsiveOverlayOpenChange}
        />
      ) : null}
    </div>
  );
}

function useSuppressedBrowserSnapshot(
  active: boolean,
  activeTab: BrowserTabMetadata | null,
): { src: string | null; suppressNativeView: boolean } {
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);
  const [suppressNativeView, setSuppressNativeView] = useState(false);
  const activeTabId = activeTab?.id ?? null;
  useEffect(() => {
    if (!active || !activeTabId) {
      setSnapshotSrc(null);
      setSuppressNativeView(false);
      return;
    }
    let alive = true;
    setSnapshotSrc(null);
    setSuppressNativeView(false);
    // Capture while the native view is still attached (page visible), then show
    // the frozen still and detach the native view in the same commit. Replacing
    // the live page with an identical image avoids the blank flash that a
    // pre-emptive detach causes. An empty capture (blank/new tab) yields no
    // preview but still suppresses so the overlay can receive clicks.
    void desktopBridge
      .getBrowserScreenshot(activeTabId)
      .then(async (base64) => {
        if (!alive) return;
        if (!base64) {
          setSuppressNativeView(true);
          return;
        }
        // Decode the still off-DOM first so the <img> paints in the very frame
        // the native view detaches — otherwise there is a one-frame blank gap.
        const src = `data:image/png;base64,${base64}`;
        const probe = new Image();
        probe.src = src;
        try {
          await probe.decode();
        } catch {
          // No decode() (jsdom) or a decode error — fall through and show anyway.
        }
        if (!alive) return;
        setSnapshotSrc(src);
        setSuppressNativeView(true);
      })
      .catch((error: unknown) => {
        // Closing the overlay or navigating invalidates an in-flight native
        // capture. Its rejection belongs to the obsolete snapshot request,
        // not the now-visible page, so it must not surface as a user error.
        if (!alive) return;
        showBrowserError(error, "Could not preview Browser page");
        setSuppressNativeView(true);
      });
    return () => {
      alive = false;
    };
  }, [active, activeTabId]);
  return useMemo(
    () => ({ src: snapshotSrc, suppressNativeView }),
    [snapshotSrc, suppressNativeView],
  );
}
