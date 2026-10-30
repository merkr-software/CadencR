import { memo, useMemo, type ReactElement } from "react";
import {
  BrainIcon,
  FilePlusIcon,
  PencilIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { AgentBlockData } from "@/components/AgentBlock";
import { Markdown } from "@/components/Markdown";
import { NumStat } from "@/components/NumStat";
import { thinkingPreview } from "@/components/ThinkingBlock";
import { truncateSubagentText, firstSubagentMarkdownLine } from "@/components/subagent-actions";
import { useStreamingMarkdownThrottle } from "@/hooks/useStreamingMarkdownThrottle";
import { cn } from "@/lib/utils";
import {
  extractBashCommand,
  isFileChangeTool,
  normalizeToolName,
  oneLineDetail,
  oneLineShellCommand,
} from "@/lib/tool-adapter";
import { parseMcpTool } from "@/lib/mcp-tool-parser";
import { parseToolCall } from "@/lib/tool-call-parser";
import { semanticSkillPresentation } from "@/lib/tool-display-policy";
import { computeToolNumStat } from "@/lib/tool-numstat";
import { TOOL_ACCENT_CLASSES, type ToolAccent } from "@/lib/tool-accent";

/** Compact markdown under a sub-agent — body ~11px, headings stay above body but small. */
const SUBAGENT_MARKDOWN_CLASS = cn(
  "text-[11px] leading-relaxed text-muted-foreground",
  "[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold",
  "[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold",
  "[&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_h3]:text-xs [&_h3]:font-semibold",
  "[&_h4]:mt-1 [&_h4]:mb-0.5 [&_h4]:text-xs [&_h4]:font-semibold",
  "[&_h5]:mt-1 [&_h5]:mb-0.5 [&_h5]:text-[11px] [&_h5]:font-semibold",
  "[&_h6]:mt-1 [&_h6]:mb-0.5 [&_h6]:text-[11px] [&_h6]:font-semibold",
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5",
  "[&_pre]:my-1 [&_pre]:text-[10px] [&_code]:text-[10px]",
);

const SUBAGENT_MARKDOWN_COLLAPSED_CLASS = cn(
  SUBAGENT_MARKDOWN_CLASS,
  "line-clamp-1 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_h4]:my-0 [&_h5]:my-0 [&_h6]:my-0 [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_h1]:text-[11px] [&_h2]:text-[11px] [&_h3]:text-[11px] [&_h4]:text-[11px] [&_h5]:text-[11px] [&_h6]:text-[11px]",
);

interface SubagentActionRowProps {
  block: AgentBlockData;
  basePath?: string;
  /** When true, prose blocks render their full content instead of a one-line preview. */
  expanded?: boolean;
  /** True for the latest in-flight action while the sub-agent is still running. */
  isStreaming?: boolean;
}

/**
 * Borderless one-line tool-like row for a sub-agent instruction. Matches the
 * visual language of a tool call (icon + name + detail) without card chrome.
 */
export const SubagentActionRow = memo(function SubagentActionRow({
  block,
  basePath,
  expanded = false,
  isStreaming = false,
}: SubagentActionRowProps): ReactElement | null {
  if (block.type === "text") {
    return <TextActionLine content={block.content} expanded={expanded} isStreaming={isStreaming} />;
  }
  if (block.type === "thinking") {
    return (
      <ThinkingActionLine content={block.content} expanded={expanded} isStreaming={isStreaming} />
    );
  }
  if (block.type !== "tool_call") return null;
  return <ToolActionLine block={block} basePath={basePath} />;
});

function TextActionLine({
  content,
  expanded,
  isStreaming,
}: {
  content: string;
  expanded: boolean;
  isStreaming: boolean;
}): ReactElement {
  const source = expanded ? content.trim() : firstSubagentMarkdownLine(content);
  const markdown = useStreamingMarkdownThrottle(source, isStreaming);
  return (
    <div className={cn("min-w-0 py-0.5", !expanded && "overflow-hidden")}>
      <Markdown
        content={markdown}
        isStreaming={isStreaming}
        className={expanded ? SUBAGENT_MARKDOWN_CLASS : SUBAGENT_MARKDOWN_COLLAPSED_CLASS}
      />
    </div>
  );
}

function ThinkingActionLine({
  content,
  expanded,
  isStreaming,
}: {
  content: string;
  expanded: boolean;
  isStreaming: boolean;
}): ReactElement {
  const displayContent = useStreamingMarkdownThrottle(content, isStreaming);
  if (expanded) {
    return (
      <div className="min-w-0 py-0.5 text-xs">
        <div className="flex items-center gap-1.5 leading-5">
          <BrainIcon
            className={cn("size-3 shrink-0", TOOL_ACCENT_CLASSES.thinking.label)}
            aria-hidden
          />
          <span className={cn("shrink-0 font-medium", TOOL_ACCENT_CLASSES.thinking.label)}>
            Thinking
          </span>
        </div>
        {displayContent.trim() && (
          <p className="mt-0.5 whitespace-pre-wrap break-words pl-4 text-[11px] leading-relaxed text-muted-foreground">
            {displayContent.trim()}
          </p>
        )}
      </div>
    );
  }
  const preview = truncateSubagentText(thinkingPreview(displayContent), 80);
  return (
    <ActionLine icon={BrainIcon} accent="thinking" label="Thinking" detail={preview || undefined} />
  );
}

function ToolActionLine({
  block,
  basePath,
}: {
  block: AgentBlockData;
  basePath?: string;
}): ReactElement {
  const rawToolName = block.toolName ?? "Tool";
  const skill = semanticSkillPresentation(rawToolName, block.toolArgs);
  if (skill) {
    return <ActionLine icon={WrenchIcon} accent="tool" label="Skill" detail={skill.name} />;
  }

  const toolName = normalizeToolName(rawToolName);
  if (toolName === "Bash") {
    return <BashActionLine toolArgs={block.toolArgs} basePath={basePath} />;
  }
  if (isFileChangeTool(toolName)) {
    return (
      <FileChangeActionLine
        rawToolName={rawToolName}
        toolName={toolName}
        toolArgs={block.toolArgs}
        basePath={basePath}
      />
    );
  }
  return <GenericActionLine toolName={toolName} toolArgs={block.toolArgs} basePath={basePath} />;
}

function BashActionLine({
  toolArgs,
  basePath,
}: {
  toolArgs: string | undefined;
  basePath: string | undefined;
}): ReactElement {
  const detail = useMemo(() => {
    const command = oneLineShellCommand(extractBashCommand(toolArgs), basePath);
    return truncateOptional(command, 90);
  }, [toolArgs, basePath]);
  return <ActionLine icon={TerminalIcon} accent="bash" label="Bash" detail={detail} />;
}

function FileChangeActionLine({
  rawToolName,
  toolName,
  toolArgs,
  basePath,
}: {
  rawToolName: string;
  toolName: string;
  toolArgs: string | undefined;
  basePath: string | undefined;
}): ReactElement {
  const { detail, stats } = useMemo(() => {
    const summary = parseToolCall(toolName, toolArgs);
    return {
      detail: truncateOptional(oneLineDetail(summary?.detail, basePath), 70),
      stats: computeToolNumStat(rawToolName, toolArgs),
    };
  }, [rawToolName, toolName, toolArgs, basePath]);
  const Icon = toolName === "Write" ? FilePlusIcon : PencilIcon;
  return (
    <ActionLine
      icon={Icon}
      accent="edit"
      label={toolName}
      detail={detail}
      trailing={
        stats ? (
          <NumStat additions={stats.additions} deletions={stats.deletions} hideZero />
        ) : undefined
      }
    />
  );
}

function GenericActionLine({
  toolName,
  toolArgs,
  basePath,
}: {
  toolName: string;
  toolArgs: string | undefined;
  basePath: string | undefined;
}): ReactElement {
  const { label, detail, accent } = useMemo(() => {
    const mcp = parseMcpTool(toolName, toolArgs);
    if (mcp) {
      return { label: mcp.label, detail: mcp.detail, accent: "mcp" as const };
    }
    const summary = parseToolCall(toolName, toolArgs);
    return {
      label: toolName,
      detail: oneLineDetail(summary?.detail, basePath),
      accent: "tool" as const,
    };
  }, [toolName, toolArgs, basePath]);
  return (
    <ActionLine
      icon={WrenchIcon}
      accent={accent}
      label={label}
      detail={truncateOptional(detail, 80)}
    />
  );
}

function ActionLine({
  icon: Icon,
  accent,
  label,
  detail,
  trailing,
}: {
  icon: LucideIcon;
  accent: ToolAccent;
  label: string;
  detail?: string;
  trailing?: ReactElement;
}): ReactElement {
  const classes = TOOL_ACCENT_CLASSES[accent];
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs leading-5">
      <Icon className={cn("size-3 shrink-0", classes.label)} aria-hidden />
      <span className={cn("shrink-0 font-medium", classes.label)}>{label}</span>
      {detail && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {detail}
        </span>
      )}
      {!detail && <span className="min-w-0 flex-1" />}
      {trailing}
    </div>
  );
}

function truncateOptional(text: string | undefined, maxLen: number): string | undefined {
  return text ? truncateSubagentText(text, maxLen) : undefined;
}
