import { memo, useCallback, useState, type DragEvent, type ReactElement } from "react";
import {
  ChevronDownIcon,
  EyeOffIcon,
  GlobeIcon,
  Loader2Icon,
  PinIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";

import { AgentIcon } from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROFILE_ID, type CookieMode } from "@/lib/browser-settings";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { BrowserTabContextMenu, isAgentSharedTab } from "./BrowserTabContextMenu";
import { BrowserTabDragSurface, BROWSER_TAB_DRAG_TYPE } from "./BrowserTabDragSurface";
import { BrowserTabOverflow } from "./BrowserTabOverflow";
import { scrollBrowserTabs, useRevealActiveBrowserTab } from "./browser-tab-strip-rail";
import { BrowserPageIcon, BrowserTemporaryTabIcon } from "./BrowserTabIcons";
import type { BrowserWorkspaceModel } from "./useBrowserWorkspaceModel";

const MAX_VISIBLE_TABS = 20;

interface BrowserTabStripProps {
  model: BrowserWorkspaceModel;
  onChromeOverlayOpenChange?: (open: boolean) => void;
}

export function BrowserTabStrip({
  model,
  onChromeOverlayOpenChange,
}: BrowserTabStripProps): ReactElement {
  const busy = model.pendingAction !== null;
  const pinnedCount = model.state.tabs.findIndex((tab) => !tab.pinned);
  const pinnedEnd = pinnedCount < 0 ? model.state.tabs.length : pinnedCount;
  const unpinnedCount = model.state.tabs.length - pinnedEnd;
  const visibleTabs = boundedVisibleTabs(model.state.tabs, model.state.activeTabId);
  const tabScrollerRef = useRevealActiveBrowserTab(model.state.activeTabId);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const draggedTab = model.state.tabs.find((tab) => tab.id === draggedTabId);
  const finishDrag = useCallback((): void => {
    setDraggedTabId(null);
    setDropTargetId(null);
  }, []);
  const leaveDropTarget = useCallback((tabId: string): void => {
    setDropTargetId((current) => (current === tabId ? null : current));
  }, []);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div
          ref={tabScrollerRef}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onWheel={scrollBrowserTabs}
        >
          {visibleTabs.map(({ tab, index }) => (
            <BrowserTabPill
              key={tab.id}
              tab={tab}
              index={index}
              groupStart={tab.pinned ? 0 : pinnedEnd}
              groupEnd={tab.pinned ? pinnedEnd - 1 : model.state.tabs.length - 1}
              closableOthers={unpinnedCount > (tab.pinned ? 0 : 1)}
              busy={busy}
              onActivate={model.activateTab}
              onClose={model.closeTab}
              onSetPinned={model.setTabPinned}
              onDuplicate={model.duplicateTab}
              onReorder={model.reorderTab}
              onCloseOthers={model.closeOtherTabs}
              onRevokeAgentAccess={model.revokeAgentAccess}
              onMenuOpenChange={onChromeOverlayOpenChange}
              dragging={draggedTabId === tab.id}
              dropTarget={dropTargetId === tab.id && draggedTabId !== tab.id}
              acceptsDrop={Boolean(draggedTabId && draggedTab?.pinned === tab.pinned)}
              onDragStart={setDraggedTabId}
              onDragOver={setDropTargetId}
              onDragLeave={leaveDropTarget}
              onDragEnd={finishDrag}
            />
          ))}
        </div>
        <NewBrowserTabButton
          defaultMode={model.defaultMode}
          creatingMode={model.creatingMode}
          onNewTab={model.newTab}
          onOpenChange={onChromeOverlayOpenChange}
        />
      </div>
      {busy ? (
        <span role="status" className="shrink-0" aria-label={model.pendingAction ?? undefined}>
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
        </span>
      ) : null}
      <BrowserTabOverflow
        tabs={model.state.tabs}
        activeTabId={model.state.activeTabId}
        onActivate={model.activateTab}
        onClose={model.closeTab}
        onReopen={model.reopenLastClosedTab}
        busy={busy}
        onOpenChange={onChromeOverlayOpenChange}
      />
    </div>
  );
}

interface BrowserTabPillProps {
  tab: BrowserTabMetadata;
  index: number;
  groupStart: number;
  groupEnd: number;
  closableOthers: boolean;
  busy: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onSetPinned: (tabId: string, pinned: boolean) => void;
  onDuplicate: (tabId: string) => void;
  onReorder: (tabId: string, targetIndex: number) => void;
  onCloseOthers: (tabId: string) => void;
  onRevokeAgentAccess: (tab: BrowserTabMetadata) => void;
  onMenuOpenChange?: (open: boolean) => void;
  dragging: boolean;
  dropTarget: boolean;
  acceptsDrop: boolean;
  onDragStart: (tabId: string) => void;
  onDragOver: (tabId: string) => void;
  onDragLeave: (tabId: string) => void;
  onDragEnd: () => void;
}

const BrowserTabPill = memo(function BrowserTabPill({
  tab,
  index,
  groupStart,
  groupEnd,
  closableOthers,
  busy,
  onActivate,
  onClose,
  onSetPinned,
  onDuplicate,
  onReorder,
  onCloseOthers,
  onRevokeAgentAccess,
  onMenuOpenChange,
  dragging,
  dropTarget,
  acceptsDrop,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
}: BrowserTabPillProps): ReactElement {
  const label = tab.title || "New tab";
  const isPrivate = tab.sessionProfileId === PROFILE_ID.private;
  const isAgentShared = isAgentSharedTab(tab);
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop) return;
    event.preventDefault();
    const draggedId = event.dataTransfer.getData(BROWSER_TAB_DRAG_TYPE);
    if (draggedId && draggedId !== tab.id) onReorder(draggedId, index);
    onDragEnd();
  };
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <BrowserTabDragSurface
          tabId={tab.id}
          busy={busy}
          active={tab.isActive}
          dragging={dragging}
          dropTarget={dropTarget}
          acceptsDrop={acceptsDrop}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDragEnd={onDragEnd}
          onDrop={drop}
        >
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5"
            onClick={() => onActivate(tab.id)}
            title={tab.suspended ? `${label} — opens when selected` : tab.title || tab.url}
          >
            <span className="flex shrink-0 items-center gap-1">
              {tab.pinned ? <PinIcon aria-label="Pinned tab" className="size-3" /> : null}
              <BrowserPageIcon tab={tab} />
              {isAgentShared ? (
                <span role="img" aria-label="Shared with agent" title="Shared with agent">
                  <AgentIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
                </span>
              ) : null}
              {isPrivate ? (
                <span role="img" aria-label="Private tab" title="Private tab">
                  <EyeOffIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
                </span>
              ) : null}
              {tab.temporary ? <BrowserTemporaryTabIcon /> : null}
            </span>
            <span className="truncate">{label}</span>
          </button>
          <button
            type="button"
            aria-label={`Close ${label}`}
            className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted-foreground/20 focus-visible:opacity-100 group-hover/tab:opacity-100"
            disabled={busy}
            onClick={() => onClose(tab.id)}
          >
            <XIcon className="size-3" />
          </button>
        </BrowserTabDragSurface>
      </ContextMenuTrigger>
      <BrowserTabContextMenu
        tab={tab}
        index={index}
        groupStart={groupStart}
        groupEnd={groupEnd}
        closableOthers={closableOthers}
        busy={busy}
        onSetPinned={onSetPinned}
        onDuplicate={onDuplicate}
        onReorder={onReorder}
        onCloseOthers={onCloseOthers}
        onClose={onClose}
        onRevokeAgentAccess={onRevokeAgentAccess}
      />
    </ContextMenu>
  );
});

const NewBrowserTabButton = memo(function NewBrowserTabButton({
  defaultMode,
  creatingMode,
  onNewTab,
  onOpenChange,
}: {
  defaultMode: CookieMode;
  creatingMode: CookieMode | null;
  onNewTab: (mode?: CookieMode) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
}): ReactElement {
  const creating = creatingMode !== null;
  const defaultLabel = defaultMode === "private" ? "Private" : "Normal";
  const primaryLabel = creating
    ? `Opening ${creatingMode === "private" ? "private " : ""}browser tab`
    : `New browser tab (default: ${defaultLabel})`;
  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-7 rounded-r-none px-1.5"
        disabled={creating}
        aria-busy={creating}
        aria-label={primaryLabel}
        title={primaryLabel}
        onClick={() => void onNewTab()}
      >
        {creating ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <PlusIcon className="size-4" />
        )}
      </Button>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-7 w-5 rounded-l-none border-l px-0"
            disabled={creating}
            aria-label="Choose browser tab type"
            title="Choose browser tab type"
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuItem onSelect={() => void onNewTab("normal")}>
            <GlobeIcon />
            New tab (normal)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onNewTab("private")}>
            <EyeOffIcon />
            New private tab
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

function boundedVisibleTabs(
  tabs: BrowserTabMetadata[],
  activeTabId: string | null,
): Array<{ tab: BrowserTabMetadata; index: number }> {
  const indexed = tabs.map((tab, index) => ({ tab, index }));
  if (indexed.length <= MAX_VISIBLE_TABS) return indexed;
  const visible = indexed.slice(0, MAX_VISIBLE_TABS);
  const active = indexed.find(({ tab }) => tab.id === activeTabId);
  if (active && active.index >= MAX_VISIBLE_TABS) visible[MAX_VISIBLE_TABS - 1] = active;
  return visible;
}
