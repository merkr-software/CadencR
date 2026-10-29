import type { SegmentedOption } from "@/components/usage/UsageSegmentedControl";
import type { SidebarConfig, SidebarOptionId } from "@/lib/sidebar-config";

/**
 * The sidebar display options as the popover and the Settings section lay them
 * out: one segmented control per choice, one checkbox per row element, one
 * switch per block or behaviour.
 */

export type ChoiceId = {
  [K in SidebarOptionId]: SidebarConfig[K] extends string ? K : never;
}[SidebarOptionId];
export type ToggleId = {
  [K in SidebarOptionId]: SidebarConfig[K] extends boolean ? K : never;
}[SidebarOptionId];

export interface ChoiceRow<K extends ChoiceId> {
  id: K;
  label: string;
  /** Shown on the Settings page, where there is room to explain. */
  description: string;
  options: readonly SegmentedOption<SidebarConfig[K]>[];
  /** A dropdown instead of segments, for choices too many to sit side by side. */
  control?: "select";
}

/** The "Group by" choices, also listed by the Projects header's menu. */
export const LENS_OPTIONS: readonly SegmentedOption<SidebarConfig["lens"]>[] = [
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
  { value: "worktree", label: "Worktree" },
  { value: "provider", label: "Provider" },
  { value: "label", label: "Label" },
  { value: "date", label: "Date" },
  { value: "flat", label: "Flat list" },
];

// Mapped per key, so each row's options must be that option's own values.
export const CHOICE_ROWS: readonly { [K in ChoiceId]: ChoiceRow<K> }[ChoiceId][] = [
  {
    id: "density",
    description: "Height of each row: 28, 36 or 44 px.",
    label: "Density",
    options: [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
      { value: "spacious", label: "Spacious" },
    ],
  },
  {
    id: "fontSize",
    description: "Size of conversation titles, in pixels.",
    label: "Text size",
    options: [
      { value: "12", label: "12" },
      { value: "12.5", label: "12.5" },
      { value: "13", label: "13" },
      { value: "14", label: "14" },
    ],
  },
  {
    id: "titleLines",
    description: "How much of a long title shows. A fixed row height keeps it to one line.",
    label: "Title",
    options: [
      { value: "one", label: "1 line" },
      { value: "two", label: "2 lines" },
      { value: "hover", label: "Full on hover", title: "One line, the full title on hover" },
    ],
  },
  {
    id: "rowHeight",
    description:
      "Fixed: every row the same height and every line filled: a one-line title, then the request, the last reply and the details, the reply wrapping over the lines a row's details leave. Without the reply (Preview: None), the details sit beside the title and a request shows as the status alone. Hovering a row never moves anything.",
    label: "Row height",
    options: [
      { value: "auto", label: "Auto", title: "Each row as tall as what it shows" },
      { value: "fixed", label: "Fixed", title: "Every row the same height" },
    ],
  },
  {
    id: "colorMode",
    description:
      "Light: color only where it carries a state (status, diff, pull request, label, request). Increased: every other detail takes a discreet color of its own too (time, reply, branch, model, todos, shells, tabs), so each one reads at a glance.",
    label: "Colors",
    options: [
      { value: "light", label: "Light", title: "Color only where it carries a state" },
      { value: "increased", label: "Increased", title: "A discreet color for every detail" },
    ],
  },
  {
    id: "titleSource",
    description: "Lead with the conversation title, its worktree branch, or its worktree folder.",
    label: "Title from",
    options: [
      { value: "title", label: "Title" },
      { value: "branch", label: "Branch", title: "The worktree branch, else the title" },
      { value: "folder", label: "Folder", title: "The worktree folder, else the title" },
    ],
  },
  {
    id: "status",
    description:
      "How working, unread and idle conversations show. Pending requests and failures always show.",
    label: "Status",
    options: [
      { value: "shape", label: "Shape" },
      { value: "dot", label: "Dot" },
      { value: "hidden", label: "Hidden", title: "Pending requests and failures stay visible" },
    ],
  },
  {
    id: "time",
    description: "Last activity on each row. Hovering a row swaps it for the row actions.",
    label: "Time",
    options: [
      { value: "none", label: "None" },
      { value: "relative", label: "Relative" },
      { value: "absolute", label: "Absolute" },
    ],
  },
  {
    id: "label",
    description: "How a conversation label shows under its title.",
    label: "Label",
    options: [
      { value: "chip", label: "Chip" },
      { value: "dot", label: "Dot" },
      { value: "hidden", label: "Hidden" },
    ],
  },
  {
    id: "provider",
    description:
      "The harness logo at the end of each row, optionally with the model under the title.",
    label: "Provider",
    options: [
      { value: "logo", label: "Logo" },
      { value: "logo_model", label: "Logo + model" },
      { value: "hidden", label: "Hidden" },
    ],
  },
  {
    id: "preview",
    description: "A line under the title with the start of the agent's last reply.",
    label: "Preview",
    options: [
      { value: "none", label: "None" },
      { value: "last_message", label: "Last reply" },
    ],
  },
  {
    id: "lens",
    description:
      "How conversations are grouped below the blocks: under their project, or across projects by status, worktree branch, provider, label or last activity, or one flat list.",
    label: "Group by",
    control: "select",
    options: LENS_OPTIONS,
  },
  {
    id: "conversationSort",
    description:
      "The order of conversations within a project or group. Dragging a conversation switches to Manual; the other sorts come back by choosing them.",
    label: "Sort conversations",
    options: [
      { value: "activity", label: "Activity", title: "Last message first" },
      { value: "created", label: "Created", title: "Newest conversation first" },
      { value: "title", label: "Title", title: "Alphabetical" },
      { value: "manual", label: "Manual", title: "The order you drag them into" },
    ],
  },
  {
    id: "projectSort",
    description:
      "The order of projects: by activity, re-sorted only when you ask (the refresh button in the Projects header), by activity as it happens, or by name.",
    label: "Sort projects",
    options: [
      { value: "frozen", label: "Frozen", title: "By activity, re-sorted when you ask" },
      { value: "live", label: "Live", title: "By activity, as it happens" },
      { value: "name", label: "Name", title: "Alphabetical" },
    ],
  },
  {
    id: "projectBadges",
    description:
      "What a collapsed project shows: pending requests and failures as strong pills, working agents and unread replies as quiet marks.",
    label: "Project badges",
    options: [
      { value: "count", label: "Count" },
      { value: "dot", label: "Dot", title: "One mark per state, without numbers" },
      { value: "none", label: "None" },
    ],
  },
  {
    id: "dormantAfter",
    description:
      "Fold conversations idle for this long into a Dormant section. Open, working, waiting and unread ones always stay.",
    label: "Fold idle after",
    options: [
      { value: "never", label: "Never" },
      { value: "3", label: "3d" },
      { value: "7", label: "7d" },
      { value: "14", label: "14d" },
      { value: "30", label: "30d" },
    ],
  },
  {
    id: "revealActive",
    description: "When a conversation opens, expand its project and scroll its row into view.",
    label: "Reveal open",
    options: [
      { value: "scroll", label: "Scroll" },
      { value: "expand", label: "Expand", title: "Expand its project without scrolling" },
      { value: "off", label: "Off" },
    ],
  },
  {
    id: "rail",
    description: "What stays visible when the sidebar is collapsed.",
    label: "Collapsed rail",
    options: [
      { value: "projects", label: "Projects" },
      {
        value: "conversations",
        label: "Active",
        title: "Every conversation with something going on",
      },
      { value: "attention", label: "Attention", title: "Only conversations waiting on you" },
      { value: "none", label: "None" },
    ],
  },
  {
    id: "gatePopover",
    description:
      "When a pending request's popover opens: by itself on the newest request, on pointing at its icon, or only on a click.",
    label: "Gate popover",
    options: [
      { value: "auto", label: "Auto", title: "Opens by itself on the newest pending request" },
      { value: "hover", label: "Hover", title: "Opens while you point at the pending icon" },
      { value: "click", label: "Click", title: "Opens only when you click the pending icon" },
    ],
  },
  {
    id: "blockCounts",
    description: "What the For me, In progress and Pinned headers show next to their name.",
    label: "Block counters",
    options: [
      { value: "count", label: "Count" },
      { value: "dot", label: "Dot", title: "A dot, amber when something needs an action" },
      { value: "none", label: "None" },
    ],
  },
  {
    id: "forMeLimit",
    description: "How many next actions the For me block lists before a Show more.",
    label: "For me shows",
    options: [
      { value: "3", label: "3" },
      { value: "5", label: "5" },
      { value: "all", label: "All" },
    ],
  },
  {
    id: "forMeAck",
    description:
      "When a For me entry leaves the list. When done: opening the conversation keeps it until you check it off or send a prompt.",
    label: "For me clears",
    options: [
      { value: "open", label: "On open", title: "Opening the conversation clears it" },
      { value: "manual", label: "When done", title: "Check it off or send a prompt" },
    ],
  },
  {
    id: "recentCount",
    description: "How many conversations the Recent block lists.",
    label: "Recent shows",
    options: [
      { value: "3", label: "3" },
      { value: "5", label: "5" },
      { value: "10", label: "10" },
    ],
  },
];

/** The on/off switches, after the choices. */
export const SWITCH_ROWS: readonly { id: ToggleId; label: string; description: string }[] = [
  {
    id: "uniformRows",
    label: "Uniform rows",
    description:
      "Details sit beside the title when they fit, so every row is one line high; the ones that don't fit wait for a wider sidebar. Off: details get a line of their own. Two-line titles always keep it.",
  },
  {
    id: "compactRows",
    label: "Compact rows",
    description:
      "Titles only. A row waiting on you grows back to show its request, details and preview.",
  },
  {
    id: "forMe",
    label: "For me block",
    description:
      "Your next actions across every project: requests to answer, failures, pull requests to fix or merge, replies to read.",
  },
  {
    id: "workingBlock",
    label: "In progress block",
    description: "Every agent at work, across every project.",
  },
  {
    id: "recentBlock",
    label: "Recent block",
    description: "The conversations you touched last, across every project.",
  },
  {
    id: "hideEmptyBlocks",
    label: "Hide empty blocks",
    description: "A block with nothing in it disappears instead of saying so.",
  },
  {
    id: "stickyHeaders",
    label: "Sticky headers",
    description: "A project's or group's header stays at the top while you scroll through it.",
  },
  {
    id: "flashOnChange",
    label: "Flash on change",
    description: "A row flashes once when its conversation starts waiting, fails or replies.",
  },
  {
    id: "autoCollapse",
    label: "Auto-collapse",
    description:
      "Fold the sidebar away while the window is narrower than 1024 px; it comes back when the window widens.",
  },
  {
    id: "typeToFilter",
    label: "Type to filter",
    description:
      "Typing while a sidebar row has focus filters conversations. Escape clears the filter.",
  },
];

export const ROW_ELEMENTS_DESCRIPTION =
  "The worktree marker on the title line, and the details beside or under the title.";

export const ROW_ELEMENTS: readonly { id: ToggleId; label: string; description: string }[] = [
  {
    id: "pendingRequest",
    label: "Pending request",
    description: "Under a waiting row, what it asks for: the command to allow or the question.",
  },
  {
    id: "worktreeIcon",
    label: "Worktree icon",
    description: "A branch glyph before the title when the conversation has its own worktree.",
  },
  {
    id: "branch",
    label: "Branch",
    description: "The worktree branch, under the title.",
  },
  {
    id: "diff",
    label: "Diff stats",
    description: "Lines added and removed in the worktree, under the title.",
  },
  {
    id: "pr",
    label: "Pull request",
    description: "The pull request opened from the conversation and its state, under the title.",
  },
  {
    id: "ports",
    label: "Ports",
    description:
      "Ports the conversation's processes listen on, under the title. Click one to open it.",
  },
  {
    id: "activity",
    label: "Shells & tabs",
    description: "Open shells, browser tabs and downloads, under the title.",
  },
  {
    id: "todos",
    label: "Todo progress",
    description: "How many of the agent's todos are done, until it finishes them all.",
  },
];
