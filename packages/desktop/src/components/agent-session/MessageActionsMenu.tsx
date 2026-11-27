import { memo, type ReactElement, type ReactNode, type RefObject } from "react";
import { CopyIcon, EllipsisIcon } from "lucide-react";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuLabel,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { COPY_AS_FORMATS, CopyAsItems, copyMessageAs } from "./CopyAsMenu";

/** "Copy" already copies Markdown, so the sheet's Copy as list starts after it. */
const SHEET_COPY_AS_FORMATS = COPY_AS_FORMATS.filter(({ format }) => format !== "markdown");

interface MessageActionsMenuProps {
  /**
   * The message source, read when an action runs: a streaming reply's deltas
   * reach the copy without re-rendering the control.
   */
  contentRef: RefObject<string>;
  /** Rendered message body, serialized for the rich email format. */
  sourceRef: RefObject<HTMLElement | null>;
  /** Lists the other Copy as formats (off while the reply still streams). */
  copyAsFormats: boolean;
  /** Which side of the message the control sits on: under a prompt, right; under a reply, left. */
  side: "start" | "end";
  /** Further actions (Retry, Fork, Rewind) as `AdaptiveMenuItem`s. */
  children?: ReactNode;
}

/**
 * The phone layout's message actions: one "…" under the message in place of
 * the desktop's row of text buttons. The glyph is a 24px chip at the top of a
 * 44px square button whose negative bottom margin keeps the line it holds in
 * the transcript at 24px: the target reaches down into the gap after the
 * message, never up over its text. It opens a bottom sheet (44px rows) whose
 * content mounts only while open. No long-press binding: a long-press on the
 * message keeps selecting its text. Memoized: a streaming reply re-renders
 * its block on every delta, not this control.
 */
export const MessageActionsMenu = memo(function MessageActionsMenu({
  contentRef,
  sourceRef,
  copyAsFormats,
  side,
  children,
}: MessageActionsMenuProps): ReactElement {
  const { t } = useUiTranslation();
  const getContent = (): string => contentRef.current;
  const title = t("conversation.stream.messageActionsMenu.messageActions", "Message actions");
  return (
    <AdaptiveMenu>
      <AdaptiveMenuTrigger asChild>
        <button
          type="button"
          aria-label={title}
          data-message-actions-trigger=""
          className={cn(
            "group/msgactions relative -mb-5 flex size-11 shrink-0 items-start text-muted-foreground outline-none",
            side === "end" ? "justify-end self-end" : "justify-start self-start",
          )}
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-8 items-center justify-center rounded-md transition-colors group-active/msgactions:bg-accent group-focus-visible/msgactions:ring-2 group-focus-visible/msgactions:ring-ring"
          >
            <EllipsisIcon className="size-4" />
          </span>
        </button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent sheetTitle={title}>
        <AdaptiveMenuItem onSelect={() => copyMessageAs("markdown", getContent(), sourceRef)}>
          <CopyIcon />
          {t("common.copy", "Copy")}
        </AdaptiveMenuItem>
        {copyAsFormats && (
          <>
            <AdaptiveMenuLabel>
              {t("conversation.stream.copyAsMenu.copyAs", "Copy as")}
            </AdaptiveMenuLabel>
            <CopyAsItems
              formats={SHEET_COPY_AS_FORMATS}
              getContent={getContent}
              sourceRef={sourceRef}
            />
          </>
        )}
        {children}
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
});
