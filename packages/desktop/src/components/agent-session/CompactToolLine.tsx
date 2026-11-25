import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useMemo, type ReactNode } from "react";
import {
  BrainIcon,
  PencilIcon,
  TerminalIcon,
  WrenchIcon,
  FilePlusIcon,
  type LucideIcon,
} from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { cn } from "@/lib/utils";
import { shouldGateFullContent } from "@/lib/agent-block-content";
import type { AgentBlockData } from "@/types/agent-block";
import { hasCompactLine } from "@/lib/agent-stream-display";
import { NumStat } from "@/components/NumStat";
import { thinkingLiveLine, thinkingPreview } from "@/components/ThinkingBlock";
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
import { toolCallFailure, type ToolCallFailure } from "@/lib/tool-failure";

interface CompactToolLineProps {
  block: AgentBlockData;
  basePath?: string;
  /** The call's `tool_result`, when it has one: a failed one marks the line. */
  result?: AgentBlockData;
  /** The block still receives tokens: a thinking line follows its newest line. */
  streaming?: boolean;
  /**
   * A failure's reason gets a line of its own under the call. Off, the reason
   * stays in the tooltip and the line keeps its height: a head that steps
   * keep replacing must not grow and shrink under the reader.
   */
  reasonLine?: boolean;
}

/**
 * One line of the "Compact flow" verbosity mode: a tinted icon, the tool name
 * and a single truncated detail (command, path, pattern, thinking head), plus a
 * numstat for file changes. Lines are read-only summaries; Maximal and the
 * collapse modes show the full block. A wire preview (`shouldGateFullContent`)
 * shows its name only: its arguments are cut, so any detail could be wrong.
 * A failed call tints its icon red, and its failure's first line hangs under it
 * unless `reasonLine` is off.
 */
export const CompactToolLine = memo(function CompactToolLine({
  block,
  basePath,
  result,
  streaming = false,
  reasonLine = true,
}: CompactToolLineProps) {
  const { t } = useUiTranslation();
  const failure = useMemo(() => toolCallFailure(block, result), [block, result]);
  if (!hasCompactLine(block)) return null;
  const gated = shouldGateFullContent(block);
  if (block.type === "thinking") {
    // A wire preview shows its name only: its cut content could mislead.
    const detail = gated
      ? ""
      : streaming
        ? thinkingLiveLine(block.content)
        : thinkingPreview(block.content);
    return (
      <BaseLine
        icon={BrainIcon}
        accent="thinking"
        label={t("conversation.stream.compactToolLine.thinking", "Thinking")}
        detail={detail || undefined}
        prose
        live={streaming}
      />
    );
  }
  const call = gated ? (
    <BaseLine
      icon={WrenchIcon}
      accent="tool"
      label={
        block.toolName !== undefined
          ? normalizeToolName(block.toolName)
          : t("conversation.stream.compactToolLine.tool", "Tool")
      }
      failed={failure !== null}
    />
  ) : (
    <ToolCallLine block={block} basePath={basePath} failed={failure !== null} t={t} />
  );
  if (!failure) return call;
  return (
    <FailedCall failure={failure} reasonLine={reasonLine} t={t}>
      {call}
    </FailedCall>
  );
});

interface ToolCallLineProps {
  block: AgentBlockData;
  basePath: string | undefined;
  failed: boolean;
  t: UiTranslator;
}

function ToolCallLine({ block, basePath, failed, t }: ToolCallLineProps) {
  const rawToolName = block.toolName ?? "";
  const skill = semanticSkillPresentation(rawToolName, block.toolArgs);
  if (skill) {
    return (
      <BaseLine
        icon={WrenchIcon}
        accent="tool"
        label={t("conversation.stream.compactToolLine.skill", "Skill")}
        detail={skill.name}
        failed={failed}
      />
    );
  }
  const toolName = normalizeToolName(rawToolName);
  // Branch before any parsing so each line shape only runs the helpers it
  // shows; the `useMemo`s stay hook-stable inside each branch component.
  if (toolName === "Bash") {
    return (
      <BashLine
        toolArgs={block.toolArgs}
        basePath={basePath}
        failed={failed}
        label={t("conversation.stream.compactToolLine.bash", "Bash")}
      />
    );
  }
  if (isFileChangeTool(toolName)) {
    return (
      <FileChangeLine
        rawToolName={rawToolName}
        toolName={toolName}
        toolArgs={block.toolArgs}
        basePath={basePath}
        failed={failed}
      />
    );
  }
  return (
    <GenericToolLine
      toolName={
        block.toolName !== undefined
          ? toolName
          : t("conversation.stream.compactToolLine.tool", "Tool")
      }
      toolArgs={block.toolArgs}
      basePath={basePath}
      failed={failed}
      t={t}
    />
  );
}

interface ToolLineProps {
  toolArgs: string | undefined;
  basePath: string | undefined;
  failed: boolean;
}

function BashLine({ toolArgs, basePath, failed, label }: ToolLineProps & { label: string }) {
  const command = useMemo(
    () => oneLineShellCommand(extractBashCommand(toolArgs), basePath),
    [toolArgs, basePath],
  );
  return (
    <BaseLine icon={TerminalIcon} accent="bash" label={label} detail={command} failed={failed} />
  );
}

function FileChangeLine({
  rawToolName,
  toolName,
  toolArgs,
  basePath,
  failed,
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
      failed={failed}
      trailing={
        stats ? (
          <NumStat additions={stats.additions} deletions={stats.deletions} hideZero />
        ) : undefined
      }
    />
  );
}

function GenericToolLine({
  toolName,
  toolArgs,
  basePath,
  failed,
  t,
}: ToolLineProps & { toolName: string; t: UiTranslator }) {
  const presentation = useMemo(() => {
    const mcp = parseMcpTool(toolName, toolArgs, t);
    if (mcp) return { label: mcp.label, detail: oneLineDetail(mcp.detail, undefined), mcp: true };
    const detail = oneLineDetail(parseToolCall(toolName, toolArgs, t)?.detail, basePath);
    return { label: toolName, detail, mcp: false };
  }, [toolName, toolArgs, basePath, t]);
  const subagent = isSubagentToolName(toolName);
  return (
    <BaseLine
      icon={subagent ? AgentIcon : WrenchIcon}
      accent={presentation.mcp ? "mcp" : "tool"}
      label={presentation.label}
      detail={presentation.detail}
      failed={failed}
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
  /** The call failed: a red icon. */
  failed?: boolean;
  /** Tokens are still arriving: the label glows like the full thinking block's. */
  live?: boolean;
}

function BaseLine({
  icon: Icon,
  accent,
  label,
  detail,
  trailing,
  prose,
  failed = false,
  live,
}: BaseLineProps) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        className={cn(
          "size-3 shrink-0",
          failed ? "text-(--acc-red)" : TOOL_ACCENT_CLASSES[accent].label,
        )}
      />
      {/* Baseline, not center: the mono detail's taller x-height would ride high. */}
      <span className="flex min-w-0 items-baseline gap-1.5 leading-4">
        <span className={cn("shrink-0 font-medium text-muted-foreground", live && "thinking-glow")}>
          {label}
        </span>
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

interface FailedCallProps {
  failure: ToolCallFailure;
  reasonLine: boolean;
  children: ReactNode;
  t: UiTranslator;
}

/**
 * A failed call's line and its reason. The reason gets a line of its own under
 * the label, so the call keeps its detail and the reason its width; `py-1`
 * keeps the call line where a single 24px row centers it. Without the reason
 * line, the reason stays in the tooltip and for screen readers.
 */
function FailedCall({ failure, reasonLine, children, t }: FailedCallProps) {
  return (
    <span
      className={cn("flex min-w-0", reasonLine && "flex-col py-1")}
      title={failure.reason ?? t("common.failed", "Failed")}
    >
      {children}
      {/* `pl-[18px]` = icon (12px) + gap (6px): the reason hangs on the label column. */}
      <span
        className={
          reasonLine
            ? "min-w-0 truncate pl-[18px] text-[11px] leading-4 text-(--acc-red)/80"
            : "sr-only"
        }
      >
        {failure.reason ? (
          <>
            <span className="sr-only">
              {t("conversation.stream.compactToolLine.failed", "Failed:")}{" "}
            </span>
            {failure.reason}
          </>
        ) : (
          t("common.failed", "Failed")
        )}
      </span>
    </span>
  );
}
