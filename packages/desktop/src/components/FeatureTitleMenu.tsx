import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useRef, useState, type ReactElement } from "react";
import { CopyIcon, PencilIcon, WandSparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { FeatureRenameForm } from "./FeatureRenamePopover";

interface FeatureTitleMenuProps {
  featureId: number;
  title: string;
  canAutoRename: boolean;
  isAutoRenamePending: boolean;
  onAutoRename: () => void;
  className?: string;
}

export function FeatureTitleMenu({
  featureId,
  title,
  canAutoRename,
  isAutoRenamePending,
  onAutoRename,
  className,
}: FeatureTitleMenuProps): ReactElement {
  const { t } = useUiTranslation();
  const [renameOpen, setRenameOpen] = useState(false);
  // Opening the popover synchronously from `onSelect` races with the menu's
  // own dismissal (focus + pointer events dispatched during teardown dismiss
  // the freshly-mounted popover). Defer to `onCloseAutoFocus`, which fires
  // after the menu has fully unmounted.
  const openRenameOnMenuCloseRef = useRef(false);

  const handleCopy = (): void => {
    void copyToClipboard(
      title,
      translateUi("conversation.featureTopBar.copiedFeatureName", "Copied feature name"),
    );
  };

  const handleMenuCloseAutoFocus = (event: Event): void => {
    if (!openRenameOnMenuCloseRef.current) return;
    openRenameOnMenuCloseRef.current = false;
    // Keep focus out of the h1 so the popover's FocusScope can claim the input.
    event.preventDefault();
    setRenameOpen(true);
  };

  return (
    <Popover open={renameOpen} onOpenChange={setRenameOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild>
            <h1
              className={cn("min-w-0 cursor-default truncate text-lg font-semibold", className)}
              onDoubleClick={() => setRenameOpen(true)}
            >
              {title}
            </h1>
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
          <ContextMenuActionItem icon={CopyIcon} onSelect={handleCopy}>
            {t("conversation.featureTopBar.copy", "Copy")}
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={PencilIcon}
            onSelect={() => {
              openRenameOnMenuCloseRef.current = true;
            }}
          >
            {t("conversation.featureTopBar.rename", "Rename…")}
          </ContextMenuActionItem>
          {canAutoRename && (
            <ContextMenuActionItem
              icon={WandSparklesIcon}
              disabled={isAutoRenamePending}
              onSelect={onAutoRename}
            >
              {t("conversation.featureTopBar.autoRename", "Auto-rename")}
            </ContextMenuActionItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent align="start" className="w-80">
        <FeatureRenameForm
          featureId={featureId}
          currentTitle={title}
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
