/**
 * Shared "attributed color" system for tool calls.
 *
 * The Compact-flow lines (icon only) and the Summary-mode recap chips paint tools with the
 * same accent so a given tool reads consistently across both: edit for file
 * edits, terminal grey for Bash, blue for generic tools, violet for thinking,
 * and brand purple for our own MCP servers. Colors come from per-theme tokens so
 * they stay correct in every theme without per-theme tuning here. (The full
 * `.cds-tool` row in `AgentToolCallBlock` still hand-rolls the equivalent classes.)
 */
export type ToolAccent = "thinking" | "bash" | "edit" | "tool" | "mcp";

export interface ToolAccentClasses {
  /** Border + background for the pill/tile wrapper (pair with a `border` util). */
  wrapper: string;
  /** Text/icon color for the label. */
  label: string;
}

export const TOOL_ACCENT_CLASSES: Record<ToolAccent, ToolAccentClasses> = {
  thinking: {
    wrapper: "border-border bg-[var(--block-thinking-bg)]",
    label: "text-[var(--block-thinking-accent)]",
  },
  bash: {
    wrapper: "border-border bg-[var(--block-bash-header-bg)]",
    label: "text-[var(--block-bash-fg)]",
  },
  edit: {
    wrapper:
      "border-border bg-[color-mix(in_srgb,var(--block-edit-accent,var(--numstat-add-fg))_13%,var(--card))]",
    label: "text-[var(--block-edit-accent,var(--numstat-add-fg))]",
  },
  tool: {
    wrapper: "border-border bg-[var(--block-tool-bg)]",
    label: "text-[var(--block-tool-accent)]",
  },
  mcp: {
    // Brand purple — mirrors `McpToolBlock` so MCP tools keep their
    // identity wherever they surface. `--primary` is the reserved brand color.
    wrapper: "border-primary/30 bg-primary/5",
    label: "text-primary",
  },
};
