import type { ReactElement } from "react";
import { CopyIcon, PinIcon, PinOffIcon } from "lucide-react";

import { AgentIcon } from "@/components/AgentIcon";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { isHttpBrowserUrl } from "@/shared/browser-url";

export function isAgentSharedTab(tab: Pick<BrowserTabMetadata, "agentAccess">): boolean {
  return tab.agentAccess === "shared" || tab.agentAccess === "agent";
}

export interface BrowserTabContextMenuProps {
  tab: BrowserTabMetadata;
  index: number;
  groupStart: number;
  groupEnd: number;
  closableOthers: boolean;
  busy: boolean;
  onSetPinned: (tabId: string, pinned: boolean) => void;
  onDuplicate: (tabId: string) => void;
  onReorder: (tabId: string, targetIndex: number) => void;
  onCloseOthers: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onRevokeAgentAccess: (tab: BrowserTabMetadata) => void;
}

export function BrowserTabContextMenu({
  tab,
  index,
  groupStart,
  groupEnd,
  closableOthers,
  busy,
  onSetPinned,
  onDuplicate,
  onReorder,
  onCloseOthers,
  onClose,
  onRevokeAgentAccess,
}: BrowserTabContextMenuProps): ReactElement {
  const canRevokeAgent = isAgentSharedTab(tab) && isHttpBrowserUrl(tab.url);

  return (
    <ContextMenuContent className="min-w-52">
      <ContextMenuItem disabled={busy} onSelect={() => onSetPinned(tab.id, !tab.pinned)}>
        {tab.pinned ? <PinOffIcon /> : <PinIcon />}
        {tab.pinned ? "Unpin tab" : "Pin tab"}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={busy || tab.temporary === true}
        title={
          tab.temporary ? "Temporary sign-in tabs cannot be replayed as GET requests" : undefined
        }
        onSelect={() => onDuplicate(tab.id)}
      >
        <CopyIcon />
        Duplicate tab
      </ContextMenuItem>
      {canRevokeAgent ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={busy} onSelect={() => onRevokeAgentAccess(tab)}>
            <AgentIcon />
            Revoke agent access
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={busy || index <= groupStart}
        onSelect={() => onReorder(tab.id, index - 1)}
      >
        Move left
      </ContextMenuItem>
      <ContextMenuItem
        disabled={busy || index >= groupEnd}
        onSelect={() => onReorder(tab.id, index + 1)}
      >
        Move right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={busy || !closableOthers} onSelect={() => onCloseOthers(tab.id)}>
        Close other unpinned tabs
      </ContextMenuItem>
      <ContextMenuItem disabled={busy} variant="destructive" onSelect={() => onClose(tab.id)}>
        Close tab
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
