import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  SplitSquareHorizontalIcon,
  SplitSquareVerticalIcon,
  XIcon,
} from "lucide-react";
import { ContextMenuActionButton } from "@/components/ContextMenuActionItem";
import type { SplitOrientation } from "@/hooks/useTerminalState";
import { desktopBridge } from "@/lib/desktop-bridge";

interface TerminalPaneContextMenuProps {
  paneId: string;
  canClose: boolean;
  children: ReactNode;
  onOpen?: (paneId: string) => void;
  onSplit: (paneId: string, orientation: SplitOrientation) => void;
  onClose: (paneId: string) => void;
  onCopy: (paneId: string) => void;
  onPaste: (paneId: string) => void;
}

interface MenuPosition {
  x: number;
  y: number;
}

function TerminalContextMenuContent({
  paneId,
  canClose,
  menu,
  runAction,
  onSplit,
  onClose,
  onCopy,
  onPaste,
}: Omit<TerminalPaneContextMenuProps, "children" | "onOpen"> & {
  menu: MenuPosition;
  runAction: (action: () => void) => void;
}): ReactNode {
  const { t } = useUiTranslation();
  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[12rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ top: menu.y, left: menu.x }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ContextMenuActionButton
        icon={SplitSquareHorizontalIcon}
        shortcutId="terminal-split-h"
        onSelect={() => runAction(() => onSplit(paneId, "horizontal"))}
      >
        {t("workspace.tools.terminalPaneContextMenu.splitHorizontally", "Split horizontally")}
      </ContextMenuActionButton>
      <ContextMenuActionButton
        icon={SplitSquareVerticalIcon}
        shortcutId="terminal-split-v"
        onSelect={() => runAction(() => onSplit(paneId, "vertical"))}
      >
        {t("workspace.tools.terminalPaneContextMenu.splitVertically", "Split vertically")}
      </ContextMenuActionButton>
      <ContextMenuActionButton
        icon={XIcon}
        shortcutId="terminal-close"
        disabled={!canClose}
        onSelect={() => runAction(() => onClose(paneId))}
      >
        {t("workspace.tools.terminalPaneContextMenu.close", "Close")}
      </ContextMenuActionButton>
      <div role="separator" className="-mx-1 my-1 h-px bg-border" />
      <ContextMenuActionButton
        icon={ClipboardPasteIcon}
        shortcutKeys={["mod", "v"]}
        onSelect={() => runAction(() => onPaste(paneId))}
      >
        {t("workspace.tools.terminalPaneContextMenu.paste", "Paste")}
      </ContextMenuActionButton>
      <ContextMenuActionButton
        icon={ClipboardCopyIcon}
        shortcutKeys={["mod", "c"]}
        onSelect={() => runAction(() => onCopy(paneId))}
      >
        {t("workspace.tools.terminalPaneContextMenu.copy", "Copy")}
      </ContextMenuActionButton>
    </div>
  );
}

export function TerminalPaneContextMenu({
  paneId,
  canClose,
  children,
  onOpen,
  onSplit,
  onClose,
  onCopy,
  onPaste,
}: TerminalPaneContextMenuProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const isOpen = menu !== null;

  const openMenu = useCallback(
    (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      desktopBridge.suppressNextNativeContextMenu?.();
      onOpen?.(paneId);
      setMenu({ x: event.clientX, y: event.clientY });
    },
    [onOpen, paneId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("contextmenu", openMenu, { capture: true });
    return () => container.removeEventListener("contextmenu", openMenu, { capture: true });
  }, [openMenu]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, scrollOptions);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, scrollOptions);
    };
  }, [isOpen]);

  const runAction = (action: () => void): void => {
    action();
    setMenu(null);
  };

  return (
    <>
      <div ref={containerRef} className="contents">
        {children}
      </div>
      {menu &&
        createPortal(
          <TerminalContextMenuContent
            paneId={paneId}
            canClose={canClose}
            menu={menu}
            runAction={runAction}
            onSplit={onSplit}
            onClose={onClose}
            onCopy={onCopy}
            onPaste={onPaste}
          />,
          document.body,
        )}
    </>
  );
}
