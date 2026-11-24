import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useState, type ReactElement } from "react";
import { ArrowLeft, Keyboard, MoreHorizontal } from "lucide-react";
import {
  AdaptivePopover,
  AdaptivePopoverContent,
  AdaptivePopoverTrigger,
} from "@/components/PhoneSheetMenu";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { SessionInfoPanel } from "../agent-session/SessionInfoChip";
import { ComposerHelp } from "./ComposerHelp";
import { useComposerContext } from "./ComposerContext";

/**
 * The composer's "…": one click shows the session's details right away —
 * provider, MCP servers, profile, ids, resume, sync — with the composer's
 * keys and syntax one step further down. Before a session exists, it opens
 * straight on the keys.
 */
export const AssistMenu = memo(function AssistMenu(): ReactElement {
  const { t } = useUiTranslation();
  const { sessionInfo, editor } = useComposerContext();
  const [open, setOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const helpShown = showHelp || !sessionInfo;
  // The phone sheet hands focus back to "…": focusing the prompt would raise the keyboard.
  const phone = useIsMobile();

  return (
    <AdaptivePopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        setShowHelp(false);
        if (!phone) requestAnimationFrame(() => editor.focus());
      }}
    >
      <AdaptivePopoverTrigger asChild>
        <button
          type="button"
          aria-label={t(
            "conversation.composer.assistMenu.moreComposerActions",
            "More composer actions",
          )}
          className="composer-instrument composer-instrument-icon text-muted-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </AdaptivePopoverTrigger>
      <AdaptivePopoverContent
        sheetTitle={helpShown ? "Composer keys & syntax" : "Session details"}
        // The session panel's controls are desktop-sized: 44px targets in the sheet.
        // Its bottom padding replaces the sheet's, so it keeps the home-indicator inset.
        sheetClassName={cn(
          "[&_button]:min-h-11 [&_button]:min-w-11",
          helpShown
            ? "overflow-y-auto"
            : "min-h-0 gap-3 overflow-y-auto px-4 pb-[max(0.75rem,var(--app-inset-bottom))]",
        )}
        side="top"
        align="end"
        className={
          helpShown
            ? "w-[min(24rem,calc(100vw-1.5rem))] p-0"
            : "flex max-h-[min(70vh,var(--radix-popover-content-available-height))] min-h-0 w-80 flex-col gap-3 overflow-hidden"
        }
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {helpShown ? (
          <>
            {sessionInfo && (
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="mx-1.5 mt-1.5 inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground phone:h-11 phone:px-3 phone:text-sm"
              >
                <ArrowLeft className="size-3" />
                {t("conversation.composer.assistMenu.session", "Session")}
              </button>
            )}
            <ComposerHelp />
          </>
        ) : (
          sessionInfo && (
            <>
              <SessionInfoPanel {...sessionInfo} />
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                className="-mx-1.5 -mb-1.5 flex shrink-0 items-center gap-2 border-t border-border/70 px-1.5 pt-2.5 pb-1.5 text-left text-xs text-muted-foreground hover:text-foreground phone:min-h-11 phone:text-sm"
              >
                <Keyboard className="size-3.5" />
                {t("conversation.composer.assistMenu.keysSyntax", "Keys & syntax")}
              </button>
            </>
          )
        )}
      </AdaptivePopoverContent>
    </AdaptivePopover>
  );
});
