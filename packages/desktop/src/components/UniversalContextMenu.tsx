import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopyIcon, FileTextIcon, MailIcon, MessageSquareIcon } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { rangeToEmailHtml } from "@/lib/email-export";
import { copyAs, type ExportFormat } from "@/lib/markdown-export";
import {
  captureSelectionSnapshot,
  selectionSnapshotToMarkdown,
  type SelectionSnapshot,
} from "@/lib/selection-to-markdown";
import { cn } from "@/lib/utils";
import { ContextMenuActionButton } from "@/components/ContextMenuActionItem";

interface UniversalContextMenuProps {
  children: ReactNode;
}

interface MenuPosition {
  x: number;
  y: number;
  text: string;
  richSelection?: SelectionSnapshot;
}

/**
 * App-wide fallback context menu for a non-empty text selection anywhere no
 * more specific menu handles it. Surfaces marked with `data-rich-copy` also
 * receive the rich Markdown, Slack, and email export actions.
 *
 * Design notes — this MUST NOT wrap the app in a Radix `ContextMenu` /
 * `ContextMenuTrigger`. Doing so puts a `data-slot="context-menu-trigger"`
 * marker on the wrapper that matches `Element.closest()` for every event
 * target in the app, and any capture-phase handler on the wrapper kills the
 * event before per-area Radix triggers (sidebar, file-tree, agent stream)
 * can run their own `onContextMenu` → the OS native menu wins everywhere.
 *
 * Instead we attach a single document-level listener on the *bubble* phase.
 * By the time it runs, any per-area Radix trigger has already called
 * `preventDefault()` on the event; we read `e.defaultPrevented` and bail.
 *
 * Coexistence:
 *   - Inner Radix menus (sidebar / file-tree / agent / tabs / search / bash):
 *     they preventDefault → we bail.
 *   - Native form fields (`input`, `textarea`, `[contenteditable=true]`):
 *     we bail so the OS shows spellcheck / undo / autofill.
 *   - Empty text selection: we bail so right-click on bare whitespace falls
 *     through to the browser default (no-op in the desktop webview).
 */
export default function UniversalContextMenu({ children }: UniversalContextMenuProps) {
  const [menu, setMenu] = useState<MenuPosition | null>(null);

  useEffect(() => {
    function onContextMenu(e: MouseEvent): void {
      if (e.defaultPrevented) return;

      const target = e.target as Element | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;

      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      if (!text.trim()) return;

      e.preventDefault();
      const richSelection =
        sel && target?.closest("[data-rich-copy='true']")
          ? captureSelectionSnapshot(sel)
          : undefined;
      setMenu({ x: e.clientX, y: e.clientY, text, richSelection });
    }

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Dismiss the floating menu on outside click, Escape, or scroll.
  useEffect(() => {
    if (!menu) return;
    function close(): void {
      setMenu(null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setMenu(null);
    }
    const scrollOpts: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, scrollOpts);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, scrollOpts);
    };
  }, [menu]);

  async function handleCopy(format: ExportFormat): Promise<void> {
    if (!menu) return;
    if (format === "plain")
      await copyToClipboard(menu.text, translateUi("clipboard.copied", "Copied"));
    else if (menu.richSelection) {
      const markdown = selectionSnapshotToMarkdown(menu.richSelection);
      const emailHtml =
        format === "email"
          ? menu.richSelection.ranges.map((range) => rangeToEmailHtml(range)).join("")
          : undefined;
      await copyAs(format, markdown, emailHtml);
    }
    setMenu(null);
  }

  return (
    <>
      {children}
      <SelectionMenu menu={menu} onCopy={(format) => void handleCopy(format)} />
    </>
  );
}

function SelectionMenu({
  menu,
  onCopy,
}: {
  menu: MenuPosition | null;
  onCopy: (format: ExportFormat) => void;
}): ReactNode {
  const { t } = useUiTranslation();
  if (!menu) return null;
  return createPortal(
    <div
      role="menu"
      data-slot="context-menu-content"
      className={cn(
        "bg-popover text-popover-foreground fixed z-50 min-w-[8rem] rounded-md border p-1 shadow-md",
      )}
      style={{ top: menu.y, left: menu.x }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ContextMenuActionButton
        icon={ClipboardCopyIcon}
        shortcutKeys={["mod", "c"]}
        onSelect={() => onCopy("plain")}
      >
        {t("clipboard.copy", "Copy")}
      </ContextMenuActionButton>
      {menu.richSelection && (
        <>
          <div className="bg-border -mx-1 my-1 h-px" role="separator" />
          <ContextMenuActionButton icon={FileTextIcon} onSelect={() => onCopy("markdown")}>
            {t("clipboard.copyMarkdown", "Copy as Markdown")}
          </ContextMenuActionButton>
          <ContextMenuActionButton icon={MessageSquareIcon} onSelect={() => onCopy("slack")}>
            {t("clipboard.copySlack", "Copy for Slack")}
          </ContextMenuActionButton>
          <ContextMenuActionButton icon={MailIcon} onSelect={() => onCopy("email")}>
            {t("clipboard.copyEmail", "Copy for email")}
          </ContextMenuActionButton>
        </>
      )}
    </div>,
    document.body,
  );
}
