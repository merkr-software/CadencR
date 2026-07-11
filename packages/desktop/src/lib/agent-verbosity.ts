import { FoldVerticalIcon, LayoutGrid, ListTree, Minimize2, type LucideIcon } from "lucide-react";
import { isFileChangeTool } from "@/lib/tool-adapter";

export const AGENT_VERBOSITY_SETTING_KEY = "agent_stream_verbosity_mode";

export const AGENT_VERBOSITY_MODES = ["maximal", "auto_collapse", "collapsed", "compact"] as const;

export type AgentVerbosityMode = (typeof AGENT_VERBOSITY_MODES)[number];

export const DEFAULT_AGENT_VERBOSITY_MODE: AgentVerbosityMode = "maximal";

/**
 * Workspace setting key for "Summary mode". Independent of the verbosity mode
 * above: when enabled, each agent turn's tool calls are collapsed into a single
 * recap block (per-tool counts) followed by the turn's final message. Stored as
 * the string "true" / "false"; unset (null) resolves to `false`.
 */
export const AGENT_SUMMARY_MODE_SETTING_KEY = "agent_stream_summary_mode";

/** Parse the persisted `agent_stream_summary_mode` setting. Defaults to false. */
export function parseAgentSummaryMode(value: string | null | undefined): boolean {
  return value === "true";
}

/** Delay before a finished block auto-collapses in `auto_collapse` mode. */
export const AGENT_AUTO_COLLAPSE_DELAY_MS = 3000;

export interface AgentVerbosityOption {
  value: AgentVerbosityMode;
  label: string;
  description: string;
  icon: LucideIcon;
  iconColorVar: string;
}

export const AGENT_VERBOSITY_OPTIONS: readonly AgentVerbosityOption[] = [
  {
    value: "maximal",
    label: "Maximal",
    description:
      "Show every tool call, thinking step, and command output expanded by default. Best for inspecting agent behavior in detail.",
    icon: ListTree,
    iconColorVar: "var(--acc-blue)",
  },
  {
    value: "auto_collapse",
    label: "Auto-collapse",
    description:
      "Three seconds after each Bash command, Edit, or thinking step finishes running, fold its block so the stream stays scannable. Click any block to re-expand.",
    icon: Minimize2,
    iconColorVar: "var(--acc-yellow)",
  },
  {
    value: "collapsed",
    label: "Collapsed",
    description:
      "Bash commands, Edits, and thinking steps appear pre-folded so the stream stays compact from the start. Click any block to expand it.",
    icon: FoldVerticalIcon,
    iconColorVar: "var(--acc-orange)",
  },
  {
    value: "compact",
    label: "Compact flow",
    description:
      "Lay tools out as a flex-wrap of tiles between the agent's text blocks. Each tile shows just the tool name (plus the command for Bash or the numstat for Edit). Dense, glance-friendly view.",
    icon: LayoutGrid,
    iconColorVar: "var(--acc-green)",
  },
] as const;

export function parseAgentVerbosityMode(value: string | null | undefined): AgentVerbosityMode {
  return AGENT_VERBOSITY_MODES.includes(value as AgentVerbosityMode)
    ? (value as AgentVerbosityMode)
    : DEFAULT_AGENT_VERBOSITY_MODE;
}

/**
 * Tools whose output participates in auto-collapse. Only tools whose render
 * path threads the controlled `expanded` prop are included — listing a tool
 * here without wiring the prop is a silent no-op.
 *
 * Currently: `Bash` (BashBlock) and the file-change tools (InlineDiffBlock).
 * Thinking blocks are handled separately in `AgentStreamItem` because their
 * block type — not their tool name — gates the behavior.
 */
export function isToolAutoCollapsible(toolName: string | undefined): boolean {
  return toolName === "Bash" || isFileChangeTool(toolName);
}

/**
 * Modes that drive the controlled `expanded` prop on auto-collapsible blocks.
 * `auto_collapse` folds them 3 s after they finish; `collapsed` folds them
 * immediately when they appear. Other modes leave blocks uncontrolled so they
 * keep their own internal state.
 */
export function verbosityControlsCollapse(mode: AgentVerbosityMode): boolean {
  return mode === "auto_collapse" || mode === "collapsed";
}
