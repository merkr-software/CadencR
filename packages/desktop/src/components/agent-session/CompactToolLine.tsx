import { memo, useMemo, type ReactNode } from "react";
import {
  BotIcon,
  BrainIcon,
  PencilIcon,
  TerminalIcon,
  WrenchIcon,
  FilePlusIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { shouldGateFullContent } from "@/lib/agent-block-content";
import type { AgentBlockData } from "@/types/agent-block";
import { hasCompactLine } from "@/lib/agent-stream-display";
import { NumStat } from "@/components/NumStat";
import { thinkingPreview } from "@/components/ThinkingBlock";
import {
  extractBashCommand,
  isFileChangeTool,
  normalizeToolName,
  oneLineDetail,
  oneLineShellCommand,
} from "@/lib/tool-adapter";
import { parseMcpTool } from "@/lib/mcp-tool-parser";
import { parseToolCall } from "@/lib/tool-call-parser";
import { isSubagentToolName, semanticSkillPresentation } from "@/lib/tool-display-policy";
import { computeToolNumStat } from "@/lib/tool-numstat";
import { TOOL_ACCENT_CLASSES, type ToolAccent } from "@/lib/tool-accent";

interface CompactToolLineProps {
  block: AgentBlockData;
  basePath?: string;
}

/**
 * One line of the "Compact flow" verbosity mode: a tinted icon, the tool name
 * and a single truncated detail (command, path, pattern, thinking head), plus a
 * numstat for file changes. Lines are read-only summaries; Maximal and the
 * collapse modes show the full block. A wire preview (`shouldGateFullContent`)
 * shows its name only: its arguments are cut, so any detail could be wrong.
 */
export const CompactToolLine = memo(function CompactToolLine({
  block,
  basePath,
}: CompactToolLineProps) {
  if (!hasCompactLine(block)) return null;
  const gated = shouldGateFullContent(block);
  if (block.type === "thinking") {
    return (
      <BaseLine
        icon={BrainIcon}
        accent="thinking"
        label="Thinking"
        detail={gated ? undefined : thinkingPreview(block.content) || undefined}
        prose
      />
    );
  }
  if (gated) {
    const toolName = normalizeToolName(block.toolName ?? "Tool");
    return <BaseLine icon={WrenchIcon} accent="tool" label={toolName} />;
  }
  return <ToolCallLine block={block} basePath={basePath} />;
});

function ToolCallLine({ block, basePath }: CompactToolLineProps) {
  const rawToolName = block.toolName ?? "Tool";
  const skill = semanticSkillPresentation(rawToolName, block.toolArgs);
  if (skill) {
    return <BaseLine icon={WrenchIcon} accent="tool" label="Skill" detail={skill.name} />;
  }
  const toolName = normalizeToolName(rawToolName);
  // Branch before any parsing so each line shape only runs the helpers it
  // shows; the `useMemo`s stay hook-stable inside each branch component.
  if (toolName === "Bash") {
    return <BashLine toolArgs={block.toolArgs} basePath={basePath} />;
  }
  if (isFileChangeTool(toolName)) {
    return (
      <FileChangeLine
        rawToolName={rawToolName}
        toolName={toolName}
        toolArgs={block.toolArgs}
        basePath={basePath}
      />
    );
  }
  return <GenericToolLine toolName={toolName} toolArgs={block.toolArgs} basePath={basePath} />;
}

interface ToolLineProps {
  toolArgs: string | undefined;
  basePath: string | undefined;
}

function BashLine({ toolArgs, basePath }: ToolLineProps) {
  const command = useMemo(
    () => oneLineShellCommand(extractBashCommand(toolArgs), basePath),
    [toolArgs, basePath],
  );
  return <BaseLine icon={TerminalIcon} accent="bash" label="Bash" detail={command} />;
}

function FileChangeLine({
  rawToolName,
  toolName,
  toolArgs,
  basePath,
}: ToolLineProps & { rawToolName: string; toolName: string }) {
  const stats = useMemo(() => computeToolNumStat(rawToolName, toolArgs), [rawToolName, toolArgs]);
  const path = useMemo(
    () => oneLineDetail(parseToolCall(toolName, toolArgs)?.detail, basePath),
    [toolName, toolArgs, basePath],
  );
  return (
    <BaseLine
      icon={toolName === "Write" ? FilePlusIcon : PencilIcon}
      accent="edit"
      label={toolName}
      detail={path}
      trailing={
        stats ? (
          <NumStat additions={stats.additions} deletions={stats.deletions} hideZero />
        ) : undefined
      }
    />
  );
}

function GenericToolLine({ toolName, toolArgs, basePath }: ToolLineProps & { toolName: string }) {
  const presentation = useMemo(() => {
    const mcp = parseMcpTool(toolName, toolArgs);
    if (mcp) return { label: mcp.label, detail: oneLineDetail(mcp.detail, undefined), mcp: true };
    const detail = oneLineDetail(parseToolCall(toolName, toolArgs)?.detail, basePath);
    return { label: toolName, detail, mcp: false };
  }, [toolName, toolArgs, basePath]);
  const subagent = isSubagentToolName(toolName);
  return (
    <BaseLine
      icon={subagent ? BotIcon : WrenchIcon}
      accent={presentation.mcp ? "mcp" : "tool"}
      label={presentation.label}
      detail={presentation.detail}
    />
  );
}

interface BaseLineProps {
  icon: LucideIcon;
  accent: ToolAccent;
  label: string;
  /** Secondary text after the label (command, path, …), truncated to the line. */
  detail?: string;
  /** Trailing slot (e.g. NumStat). */
  trailing?: ReactNode;
  /** The detail is prose (thinking), not code: set it in the text face. */
  prose?: boolean;
}

function BaseLine({ icon: Icon, accent, label, detail, trailing, prose }: BaseLineProps) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className={cn("size-3 shrink-0", TOOL_ACCENT_CLASSES[accent].label)} />
      {/* Baseline, not center: the mono detail's taller x-height would ride high. */}
      <span className="flex min-w-0 items-baseline gap-1.5 leading-4">
        <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
        {detail && (
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground/70",
              prose ? "text-xs" : "font-mono text-[11px]",
            )}
          >
            {detail}
          </span>
        )}
        {trailing && <span className="shrink-0 text-[11px] tabular-nums">{trailing}</span>}
      </span>
    </span>
  );
}
