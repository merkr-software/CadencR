import { useState } from "react";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { cn, formatJson, toRelativePath } from "@/lib/utils";
import { parseToolCall } from "@/lib/tool-call-parser";
import { isFileChangeTool, normalizeToolName } from "@/lib/tool-adapter";
import { parseMcpTool } from "@/lib/mcp-tool-parser";
import { McpToolBlock } from "@/components/McpToolBlock";

/**
 * Generic collapsible tool-call row (the fallback for tool calls that don't get
 * a richer dedicated block like Bash, file-change diffs, or Plan). Split out of
 * `AgentBlock` to keep that hot-path switch component under the size budget.
 */
export function ToolCallBlock({
  name,
  args,
  basePath,
  error,
}: {
  name: string;
  args?: string;
  basePath?: string;
  /** The message of the call's error result; set only when the call failed. */
  error?: string;
}) {
  const canonicalName = normalizeToolName(name);
  const mcp = parseMcpTool(canonicalName, args);
  if (mcp) return <McpToolBlock mcp={mcp} />;
  return (
    <GenericToolCallBlock name={canonicalName} args={args} basePath={basePath} error={error} />
  );
}

function GenericToolCallBlock({
  name: canonicalName,
  args,
  basePath,
  error,
}: {
  name: string;
  args?: string;
  basePath?: string;
  error?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const summary = parseToolCall(canonicalName, args);
  const detail =
    summary?.detail && basePath ? toRelativePath(summary.detail, basePath) : summary?.detail;
  // File-patch tools (Edit / Write / ApplyPatch) use a dedicated accent while
  // generic tool calls keep the neutral tool accent. Themes without the newer
  // edit token fall back to their existing diff-add color.
  const isEdit = isFileChangeTool(canonicalName);
  const failed = error !== undefined;
  // A failed call reads like a failed Bash card: destructive name and rim.
  const toolColorClass = failed
    ? "text-destructive"
    : isEdit
      ? "text-[var(--block-edit-accent,var(--numstat-add-fg))]"
      : "text-[var(--block-tool-accent)]";
  const wrapperClass = failed
    ? "border-destructive/40 bg-[var(--block-tool-bg)]"
    : isEdit
      ? "border-[color-mix(in_srgb,var(--block-edit-accent,var(--numstat-add-fg))_35%,transparent)] bg-[color-mix(in_srgb,var(--block-edit-accent,var(--numstat-add-fg))_12%,var(--card))]"
      : "border-[var(--block-tool-border,var(--border))] bg-[var(--block-tool-bg)]";

  return (
    <div
      data-tool-family={isEdit ? "edit" : "generic"}
      data-tool-failed={failed || undefined}
      className={cn("my-1 rounded-md border", wrapperClass)}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <WrenchIcon className={cn("size-3", toolColorClass)} />
        <span className={cn("font-medium", toolColorClass)}>{canonicalName}</span>
        {detail && <span className="truncate text-muted-foreground">{detail}</span>}
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {failed && (
        <pre className="whitespace-pre-wrap break-words border-t border-destructive/20 px-3 py-1.5 font-mono text-xs text-destructive">
          {error.trim() || "Failed"}
        </pre>
      )}
      {expanded && args && (
        <pre className="border-t border-[var(--block-tool-border,var(--border))] bg-muted/30 p-3 text-xs overflow-x-auto">
          {formatJson(args)}
        </pre>
      )}
    </div>
  );
}
