import { memo, useState, type ReactElement } from "react";
import { ArrowLeft, Keyboard, MoreHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const { sessionInfo, editor } = useComposerContext();
  const [open, setOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const helpShown = showHelp || !sessionInfo;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        setShowHelp(false);
        requestAnimationFrame(() => editor.focus());
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More composer actions"
          className="composer-instrument composer-instrument-icon text-muted-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
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
                className="mx-1.5 mt-1.5 inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="size-3" />
                Session
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
                className="-mx-1.5 -mb-1.5 flex shrink-0 items-center gap-2 border-t border-border/70 px-1.5 pt-2.5 pb-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <Keyboard className="size-3.5" />
                Keys & syntax
              </button>
            </>
          )
        )}
      </PopoverContent>
    </Popover>
  );
});
