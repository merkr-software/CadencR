import { memo, useLayoutEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  ClipboardCopyIcon,
  Code2Icon,
  Loader2Icon,
  TerminalIcon,
} from "lucide-react";
import { getGetMessageFullContentQueryKey, getMessageFullContent } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi-to-html";
import { copyToClipboard } from "@/lib/clipboard";
import { extractBashResultOutput } from "@/lib/tool-adapter";
import { useControllableBoolean } from "@/hooks/useControllableBoolean";
import { useTouchSafeTriggerProps } from "@/hooks/useTouchSafeTriggerProps";
import { CollapsibleBlock } from "@/components/ui/collapsible-block";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";

/** Lines of tool output rendered before the "Show all" toggle collapses the
 * rest. Exported so in-conversation search counts the same visible tail. */
export const DEFAULT_BASH_LINES = 10;

/** Insert line breaks before shell operators for readability in the header. */
function formatShellCommand(cmd: string): string {
  return cmd.replace(/\s+(&&|\|\||[;&|])\s*/g, "\n  $1 ");
}

export interface BashBlockProps {
  command?: string;
  content?: string;
  running?: boolean;
  isError?: boolean;
  maxLines?: number;
  messageId?: number;
  truncatedContent?: boolean;
  bodyExtraClassName?: string;
  runningFooter?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
}

interface BashHeaderProps {
  command?: string;
  formattedCommand?: string;
  isError?: boolean;
  isBodyOpen: boolean;
}

function BashHeader({
  command,
  formattedCommand,
  isError,
  isBodyOpen,
}: BashHeaderProps): ReactElement {
  return (
    <>
      <TerminalIcon className="size-3 shrink-0" />
      <span
        className={cn("font-medium", isError ? "text-destructive" : "text-[var(--block-bash-fg)]")}
      >
        Bash
      </span>
      <pre
        className={cn(
          "min-w-0 flex-1 font-mono",
          isError ? "text-destructive" : "text-[var(--block-bash-fg)]",
          isBodyOpen ? "whitespace-pre-wrap break-all" : "truncate",
        )}
      >
        {(isBodyOpen ? formattedCommand : command) ?? "Running command…"}
      </pre>
    </>
  );
}

function BashHeaderToggle({
  isBodyOpen,
  onToggle,
}: {
  isBodyOpen: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="text-[var(--block-bash-muted-fg)] hover:text-[var(--block-bash-fg)]"
      aria-expanded={isBodyOpen}
      aria-label={isBodyOpen ? "Collapse output" : "Expand output"}
    >
      <ChevronRightIcon className={cn("size-3 transition-transform", isBodyOpen && "rotate-90")} />
    </button>
  );
}

function BashContextMenuItems({
  command,
  content,
  hasOutput,
}: Pick<BashBlockProps, "command" | "content"> & { hasOutput: boolean }): ReactElement {
  return (
    <>
      <ContextMenuActionItem
        icon={ClipboardCopyIcon}
        disabled={!hasOutput}
        onSelect={() => void copyToClipboard(content ?? "", "Output copied")}
      >
        Copy Output
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={TerminalIcon}
        disabled={!command}
        onSelect={() => void copyToClipboard(command ?? "", "Command copied")}
      >
        Copy Command
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={Code2Icon}
        disabled={!hasOutput}
        onSelect={() =>
          void copyToClipboard(
            "```bash\n" + (content ?? "") + "\n```",
            "Copied as Markdown code block",
          )
        }
      >
        Copy as Markdown Code Block
      </ContextMenuActionItem>
    </>
  );
}

export const BashBlock = memo(function BashBlock({
  command,
  content,
  running,
  isError,
  maxLines = DEFAULT_BASH_LINES,
  messageId,
  truncatedContent,
  bodyExtraClassName,
  runningFooter,
  expanded,
  onExpandedChange,
}: BashBlockProps): ReactElement {
  const lines = content?.split("\n") ?? [];
  const totalLines = lines.length;
  const triggerProps = useTouchSafeTriggerProps();

  const hasOutput = typeof content === "string" && content.length > 0;
  const formattedCommand = useMemo(
    () => (command ? formatShellCommand(command) : undefined),
    [command],
  );

  // `expanded` controls whether the body is rendered at all (the outer
  // fold toggle, mirrored at the end of the header bar). The internal
  // "Show last N / Show all N" button inside `CollapsibleBlock` keeps its
  // own state — those are two independent collapse axes.
  const { value: isBodyOpen, toggle: toggleBodyOpen } = useControllableBoolean({
    value: expanded,
    onChange: onExpandedChange,
    defaultValue: true,
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild {...triggerProps}>
        <div data-bash-block className="min-w-0 max-w-full">
          <CollapsibleBlock
            totalCount={totalLines}
            visibleCount={maxLines}
            hasMore={truncatedContent}
            unit="lines"
            onHeaderClick={toggleBodyOpen}
            className={isError ? "border-destructive/40" : "border-border"}
            headerClassName={cn(
              "bg-[var(--block-bash-header-bg)]",
              isError ? "text-destructive" : "text-[var(--block-bash-muted-fg)]",
            )}
            toggleClassName="text-[var(--block-bash-muted-fg)] hover:text-[var(--block-bash-fg)]"
            bodyClassName={cn(
              "px-3 py-2 text-xs leading-relaxed overflow-x-auto font-mono",
              "bg-[var(--block-bash-body-bg)]",
              isError ? "text-destructive" : "text-[var(--block-bash-fg)]",
              bodyExtraClassName,
            )}
            truncationClassName="text-[var(--block-bash-muted-fg)]/70"
            bodyHidden={!isBodyOpen}
            header={
              <BashHeader
                command={command}
                formattedCommand={formattedCommand}
                isError={isError}
                isBodyOpen={isBodyOpen}
              />
            }
            headerTrailing={<BashHeaderToggle isBodyOpen={isBodyOpen} onToggle={toggleBodyOpen} />}
          >
            {({ showAll }) =>
              hasOutput || truncatedContent ? (
                <BashBodyContent
                  content={content ?? ""}
                  maxLines={maxLines}
                  showAll={showAll}
                  running={running}
                  messageId={messageId}
                  truncatedContent={truncatedContent === true}
                  runningFooter={runningFooter}
                />
              ) : running ? (
                <div className="flex items-center gap-2 text-xs text-[var(--block-bash-muted-fg)]">
                  <Loader2Icon className="size-3 animate-spin" />
                  <span>Running…</span>
                </div>
              ) : (
                <div className="text-xs text-[var(--block-bash-muted-fg)]">No output</div>
              )
            }
          </CollapsibleBlock>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <BashContextMenuItems command={command} content={content} hasOutput={hasOutput} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface BashBodyContentProps {
  content: string;
  maxLines: number;
  showAll: boolean;
  running?: boolean;
  messageId?: number;
  truncatedContent: boolean;
  runningFooter?: ReactNode;
}

function BashBodyContent({
  content,
  maxLines,
  showAll,
  running,
  messageId,
  truncatedContent,
  runningFooter,
}: BashBodyContentProps): ReactElement {
  if (showAll && truncatedContent && messageId !== undefined) {
    return (
      <FetchedBashBodyContent
        content={content}
        maxLines={maxLines}
        showAll={showAll}
        running={running}
        messageId={messageId}
        runningFooter={runningFooter}
      />
    );
  }
  return (
    <>
      {showAll && truncatedContent && messageId === undefined && (
        <p role="alert" className="mb-2 text-destructive">
          Earlier output is unavailable until this message is synchronized. Reopen the conversation
          to retry.
        </p>
      )}
      <ParsedBashBodyContent
        content={content}
        displayedContent={content}
        maxLines={maxLines}
        showAll={showAll}
        running={running}
        runningFooter={runningFooter}
      />
    </>
  );
}

interface FetchedBashBodyContentProps {
  content: string;
  maxLines: number;
  showAll: boolean;
  running?: boolean;
  messageId: number;
  runningFooter?: ReactNode;
}

function FetchedBashBodyContent({
  content,
  maxLines,
  showAll,
  running,
  messageId,
  runningFooter,
}: FetchedBashBodyContentProps): ReactElement {
  const fullContentQuery = useQuery({
    queryKey: getGetMessageFullContentQueryKey(messageId),
    queryFn: ({ signal }) => getMessageFullContent(messageId, signal),
    // Full output lives only while the user is viewing earlier lines.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const fetchedContent = fullContentQuery.data
    ? extractBashResultOutput(fullContentQuery.data.content)
    : undefined;
  // The response can arrive after the click's suppression window. Keep this
  // user-requested height change from scrolling the card out of the virtual list.
  useLayoutEffect(() => {
    suppressAutoScrollPin();
  }, [fullContentQuery.data, fullContentQuery.isError]);
  return (
    <>
      {fullContentQuery.isFetching && (
        <div className="mb-2 flex items-center gap-2 text-xs text-[var(--block-bash-muted-fg)]">
          <Loader2Icon className="size-3 animate-spin" />
          <span>Loading full output…</span>
        </div>
      )}
      {fullContentQuery.isError && (
        <div className="mb-2 text-xs text-destructive">
          Could not load full output: {errorMessage(fullContentQuery.error)}
        </div>
      )}
      <ParsedBashBodyContent
        content={content}
        displayedContent={fetchedContent ?? content}
        maxLines={maxLines}
        showAll={showAll && fetchedContent !== undefined}
        running={running}
        runningFooter={runningFooter}
      />
    </>
  );
}

interface ParsedBashBodyContentProps {
  content: string;
  displayedContent: string;
  maxLines: number;
  showAll: boolean;
  running?: boolean;
  runningFooter?: ReactNode;
}

function ParsedBashBodyContent({
  content,
  displayedContent,
  maxLines,
  showAll,
  running,
  runningFooter,
}: ParsedBashBodyContentProps): ReactElement {
  const truncatedAnsi = useMemo(
    () => parseAnsi(content.split("\n").slice(-maxLines).join("\n")),
    [content, maxLines],
  );
  const fullAnsi = useMemo(
    () => (showAll ? parseAnsi(displayedContent) : null),
    [displayedContent, showAll],
  );
  return (
    <>
      <pre className="whitespace-pre">{showAll ? fullAnsi : truncatedAnsi}</pre>
      {running && runningFooter}
    </>
  );
}

function errorMessage(error: unknown): string {
  return apiErrorMessage(error, "unknown error");
}
