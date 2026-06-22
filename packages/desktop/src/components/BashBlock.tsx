import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, Loader2Icon, TerminalIcon } from "lucide-react";
import { getGetMessageFullContentQueryKey, getMessageFullContent } from "@/api/generated";
import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi-to-html";
import { copyToClipboard } from "@/lib/clipboard";
import { extractBashResultOutput } from "@/lib/tool-adapter";
import { useControllableBoolean } from "@/hooks/useControllableBoolean";
import { CollapsibleBlock } from "@/components/ui/collapsible-block";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

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
      <ContextMenuTrigger asChild>
        <div className="min-w-0 max-w-full">
          <CollapsibleBlock
            totalCount={totalLines}
            visibleCount={maxLines}
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
              <>
                <TerminalIcon className="size-3 shrink-0" />
                <span
                  className={cn(
                    "font-medium",
                    isError ? "text-destructive" : "text-[var(--block-bash-fg)]",
                  )}
                >
                  Bash
                </span>
                <pre
                  className={cn(
                    // Pin the command (and Bash label above) to the
                    // high-contrast fg so it stays readable on every theme,
                    // but stay in `text-destructive` on error so the whole
                    // header reads as one red row.
                    "min-w-0 flex-1 font-mono",
                    isError ? "text-destructive" : "text-[var(--block-bash-fg)]",
                    // Collapsed: single-line ellipsis with the full command on
                    // hover. Expanded: wrap with line breaks before shell
                    // operators (inserted by `formatShellCommand`).
                    isBodyOpen ? "whitespace-pre-wrap break-all" : "truncate",
                  )}
                  title={command ?? undefined}
                >
                  {(isBodyOpen ? formattedCommand : command) ?? "Running command…"}
                </pre>
              </>
            }
            // Rendered after the "Show all N / Show last N" toggle so the
            // fold chevron stays pinned to the very end of the header bar.
            headerTrailing={
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBodyOpen();
                }}
                className="text-[var(--block-bash-muted-fg)] hover:text-[var(--block-bash-fg)]"
                aria-expanded={isBodyOpen}
                aria-label={isBodyOpen ? "Collapse output" : "Expand output"}
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", isBodyOpen && "rotate-90")}
                />
              </button>
            }
          >
            {({ showAll }) =>
              hasOutput ? (
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
        <ContextMenuItem
          disabled={!hasOutput}
          onSelect={() => void copyToClipboard(content ?? "", "Output copied")}
        >
          Copy Output
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!command}
          onSelect={() => void copyToClipboard(command ?? "", "Command copied")}
        >
          Copy Command
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasOutput}
          onSelect={() =>
            void copyToClipboard(
              "```bash\n" + (content ?? "") + "\n```",
              "Copied as Markdown code block",
            )
          }
        >
          Copy as Markdown Code Block
        </ContextMenuItem>
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
    <ParsedBashBodyContent
      content={content}
      displayedContent={content}
      maxLines={maxLines}
      showAll={showAll}
      running={running}
      runningFooter={runningFooter}
    />
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
    // The full payload is immutable for a given message id, so once fetched
    // we don't need to refetch it. `cacheTime` (react-query v4) caps how long
    // an unmounted entry stays in cache — bash outputs can run into megabytes
    // per message, and a long session could otherwise accumulate the whole
    // transcript in memory after the user collapses each one.
    staleTime: Number.POSITIVE_INFINITY,
    cacheTime: 5 * 60 * 1000,
  });
  const fetchedContent = fullContentQuery.data
    ? extractBashResultOutput(fullContentQuery.data.content)
    : undefined;
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
        showAll={showAll}
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
  return error instanceof Error ? error.message : "unknown error";
}
