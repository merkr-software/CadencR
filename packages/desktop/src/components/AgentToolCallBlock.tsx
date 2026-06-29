import { useState } from "react";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { cn, formatJson, toRelativePath } from "@/lib/utils";
import { parseCadencrMcpTool, parseToolCall } from "@/lib/tool-call-parser";
import { isFileChangeTool, normalizeToolName } from "@/lib/tool-adapter";
import { CadencrMcpBlock } from "@/components/CadencrMcpBlock";

/**
 * Generic collapsible tool-call row (the fallback for tool calls that don't get
 * a richer dedicated block like Bash, file-change diffs, or Plan). Split out of
 * `AgentBlock` to keep that hot-path switch component under the size budget.
 */
export function ToolCallBlock({
  name,
  args,
  basePath,
}: {
  name: string;
  args?: string;
  basePath?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canonicalName = normalizeToolName(name);
  const cadencrMcp = parseCadencrMcpTool(canonicalName, args);
  if (cadencrMcp) return <CadencrMcpBlock mcp={cadencrMcp} args={args} />;

  const summary = parseToolCall(canonicalName, args);
  const detail =
    summary?.detail && basePath ? toRelativePath(summary.detail, basePath) : summary?.detail;
  // File-patch tools (Edit / Write / ApplyPatch) get a distinct green "file
  // change" identity so they stand apart from generic tool calls, which keep the
  // neutral tool accent. The green is derived from each theme's --numstat-add-fg
  // (the diff "lines added" color), so it stays distinct in every theme without
  // per-theme tuning.
  const isEdit = isFileChangeTool(canonicalName);
  const toolColorClass = isEdit
    ? "text-[var(--numstat-add-fg)]"
    : "text-[var(--block-tool-accent)]";
  const wrapperClass = isEdit
    ? "border-[color-mix(in_srgb,var(--numstat-add-fg)_35%,transparent)] bg-[color-mix(in_srgb,var(--numstat-add-fg)_12%,var(--card))]"
    : "border-border bg-[var(--block-tool-bg)]";

  return (
    <div className={cn("my-1 rounded-md border", wrapperClass)}>
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
      {expanded && args && (
        <pre className="border-t border-border bg-muted/30 p-3 text-xs overflow-x-auto">
          {formatJson(args)}
        </pre>
      )}
    </div>
  );
}
