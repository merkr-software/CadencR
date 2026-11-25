import { useUiTranslation } from "@/lib/i18n/ui";
import * as React from "react";
import { Loader2Icon, MousePointerClickIcon, SendIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface BrowserCommentDockProps {
  count: number;
  /** True while the element picker is armed (show a spinner hint). */
  picking: boolean;
  onSend: () => void;
  onDiscardAll: () => void;
}

/**
 * A slim bar above the page region summarising pending comments. It lives in the
 * chrome (not over the native view, which would hide it) so the user can send or
 * discard the batch while the page stays live and the on-page badges show where
 * each comment is anchored.
 */
function BrowserCommentDockImpl(props: BrowserCommentDockProps): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const { count, picking, onSend, onDiscardAll } = props;
  if (count === 0 && !picking) return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/95 px-2 py-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {picking ? (
          <>
            <Loader2Icon className="size-3.5 animate-spin" />
            {t(
              "workspace.tools.browserCommentDock.clickAnElementToComment",
              "Click an element to comment…",
            )}
          </>
        ) : (
          <>
            <MousePointerClickIcon className="size-3.5" />
            {t("workspace.tools.browserCommentDock.commentsReady", {
              count: count,
              defaultValue_one: "{{count}} comment ready · click a circle to edit",
              defaultValue_other: "{{count}} comments ready · click a circle to edit",
            })}
          </>
        )}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscardAll}
          disabled={count === 0}
        >
          <XIcon className="size-3.5" />
          {t("workspace.tools.browserCommentDock.discard", "Discard")}
        </Button>
        <Button type="button" size="sm" onClick={onSend} disabled={count === 0}>
          <SendIcon className="size-3.5" />
          {t("workspace.tools.browserCommentDock.sendCount", "Send {{count}}", { count })}
        </Button>
      </div>
    </div>
  );
}

export const BrowserCommentDock = React.memo(BrowserCommentDockImpl);
