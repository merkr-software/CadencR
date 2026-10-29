import type { TodoProgress } from "@/api/generated";
import type { AttentionState } from "@/lib/sidebar-attention";
import type { SidebarConfig } from "@/lib/sidebar-config";

/** What a row previews of its conversation: the agent's last reply and its todo progress. */
export interface RowSummary {
  preview: string | null;
  todos: TodoProgress | null;
  /** Why the summary couldn't load; the preview line and todo chip say so. */
  error: string | null;
}

/** How a row lays out its lines, from the display options and the row's state. */
export interface RowLayout {
  /** Title line only (compact rows), unless the conversation waits on you. */
  compact: boolean;
  /** The details sit beside the title instead of on their own line (uniform rows). */
  foldMeta: boolean;
  /** The agent's last reply under the title. */
  showsPreview: boolean;
  /** The todo progress among the details. */
  showsTodos: boolean;
  /** Fixed row height: every row as tall as the lines its options can fill, each one filled. */
  fixed: boolean;
  /** Fixed: the agent's last reply (or request) under the title, stretched over the lines the details leave. */
  holdsNowLine: boolean;
  /** Fixed: a line for the code (branch, then diff and pull request). */
  holdsCodeLane: boolean;
  /** Fixed: a line for what goes on around it (label, todos, shells and tabs, ports, model). */
  holdsActivityLane: boolean;
}

type LayoutOptions = Pick<
  SidebarConfig,
  | "compactRows"
  | "uniformRows"
  | "titleLines"
  | "rowHeight"
  | "preview"
  | "todos"
  | "pendingRequest"
  | "branch"
  | "diff"
  | "pr"
  | "ports"
  | "activity"
  | "label"
  | "provider"
>;

/** Whether the code lane can show anything (the options, not this row's data). */
function showsCodeDetail(options: LayoutOptions): boolean {
  return options.branch || options.diff || options.pr;
}

/** Whether the activity lane can show anything (the options, not this row's data). */
function showsActivityDetail(options: LayoutOptions): boolean {
  return (
    options.ports ||
    options.activity ||
    options.todos ||
    options.label !== "hidden" ||
    options.provider === "logo_model"
  );
}

/**
 * Compact rows grow back when their conversation waits, so the request shows.
 * Two-line titles keep the details on their own line: there is no single line
 * to share. A label being edited needs the room of its own line too. A pending
 * request takes the preview's line: it is what the agent says now.
 *
 * A fixed row height holds the same lines on every row, from the options alone
 * (never the row's own data), so no row is taller than another and nothing
 * moves when a request arrives or a reply lands: what the agent says now, the
 * code, then the activity around it. Its title keeps to one line, and the
 * agent's last reply fills whatever lines a row's details leave
 * (`fixedRowLines`), so no line is ever empty. Without a reply to fill them,
 * the details sit beside the title. Compact rows then stay compact even while
 * waiting: the status says so.
 */
export function rowLayout(
  options: LayoutOptions,
  state: AttentionState,
  editingLabel: boolean,
): RowLayout {
  const fixed = options.rowHeight === "fixed";
  const compact = options.compactRows && (fixed || state !== "waiting");
  const showsRequest = state === "waiting" && options.pendingRequest;
  const reply = !compact && options.preview !== "none";
  const foldMeta = fixed
    ? options.uniformRows || !reply
    : options.uniformRows && options.titleLines !== "two" && !editingLabel;
  const lanes = fixed && !compact && !foldMeta;
  return {
    compact,
    foldMeta,
    showsPreview: reply && (fixed || !showsRequest),
    showsTodos: !compact && options.todos,
    fixed,
    holdsNowLine: fixed && reply,
    holdsCodeLane: lanes && showsCodeDetail(options),
    holdsActivityLane: lanes && showsActivityDetail(options),
  };
}

/** What a fixed row has to show besides its reply, from its own data. */
export interface FixedRowContent {
  /** A "For me" row names its next action. */
  namesNextAction: boolean;
  /** The conversation waits and the request option is on. */
  asks: boolean;
  code: boolean;
  activity: boolean;
  /** Its label is being edited: the editor needs the activity line. */
  editingLabel: boolean;
}

/** How a fixed row spends its lines: each kind of content on its own, the reply on the rest. */
export interface FixedRowLines {
  asks: boolean;
  code: boolean;
  activity: boolean;
  /** How many lines the last reply wraps over (0: none left). */
  replyLines: number;
}

/** The lines a fixed row holds under its title, from its options (and the "For me" block). */
export function fixedRowLineCount(layout: RowLayout, namesNextAction: boolean): number {
  return [
    namesNextAction,
    layout.holdsNowLine,
    layout.holdsCodeLane,
    layout.holdsActivityLane,
  ].filter(Boolean).length;
}

/**
 * Fills a fixed row's lines with what this row has: its next action, its
 * request, its code and its activity each take a line, and the reply wraps
 * over every line they leave, so a row with fewer details reads more of the
 * agent's reply instead of showing an empty line. A label being edited
 * borrows a reply line (or the request's) when the options hold no activity
 * line, so "Set label" always shows its editor.
 */
export function fixedRowLines(layout: RowLayout, content: FixedRowContent): FixedRowLines {
  const lines = {
    asks: layout.holdsNowLine && !content.namesNextAction && content.asks,
    code: layout.holdsCodeLane && content.code,
    activity: layout.holdsActivityLane && content.activity,
  };
  const taken = [content.namesNextAction, lines.asks, lines.code, lines.activity].filter(
    Boolean,
  ).length;
  let replyLines = layout.holdsNowLine
    ? fixedRowLineCount(layout, content.namesNextAction) - taken
    : 0;
  // Folded details (uniform rows) carry the editor beside the title.
  if (content.editingLabel && !lines.activity && layout.holdsNowLine && !layout.foldMeta) {
    if (replyLines > 0) replyLines -= 1;
    else lines.asks = false;
    lines.activity = true;
  }
  return { ...lines, replyLines };
}

/** Todos count while some are left; a finished list says nothing more. */
export function hasOpenTodos(todos: TodoProgress | null | undefined): todos is TodoProgress {
  return todos != null && todos.total > 0 && todos.done < todos.total;
}
