import { useState } from "react";
import { cn, formatJson } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type { CadencrMcpTool } from "@/lib/tool-call-parser";

/** Full-size Cadencr MCP tool call block with primary purple color scheme and server badge. */
export function CadencrMcpBlock({ mcp, args }: { mcp: CadencrMcpTool; args?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-md border border-primary/30 bg-primary/5">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          {mcp.server}
        </span>
        <span className="shrink-0 whitespace-nowrap font-medium text-primary/80">{mcp.label}</span>
        {mcp.detail && <span className="truncate text-primary/50">{mcp.detail}</span>}
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 text-primary/40 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && args && (
        <pre className="border-t border-primary/20 bg-muted/30 p-3 text-xs overflow-x-auto">
          {formatJson(args)}
        </pre>
      )}
    </div>
  );
}
