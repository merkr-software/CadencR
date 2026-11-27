import { translateUi } from "@/lib/i18n/ui";
import { displayToggle, type SidebarToggle } from "./sidebar-display-metadata";

export const SWITCH_ROWS: readonly SidebarToggle[] = [
  displayToggle(
    "uniformRows",
    () => translateUi("sidebar.display.uniformRows.label", "Uniform rows"),
    () =>
      translateUi(
        "sidebar.display.uniformRows.description",
        "Details sit beside the title when they fit, so every row is one line high; the ones that don't fit wait for a wider sidebar. Off: details get a line of their own. Two-line titles always keep it.",
      ),
  ),
  displayToggle(
    "compactRows",
    () => translateUi("sidebar.display.compactRows.label", "Compact rows"),
    () =>
      translateUi(
        "sidebar.display.compactRows.description",
        "Titles only. A row waiting on you grows back to show its request, details and preview.",
      ),
  ),
  displayToggle(
    "forMe",
    () => translateUi("sidebar.display.forMe.label", "For me block"),
    () =>
      translateUi(
        "sidebar.display.forMe.description",
        "Your next actions across every project: requests to answer, failures, pull requests to fix or merge, replies to read.",
      ),
  ),
  displayToggle(
    "workingBlock",
    () => translateUi("sidebar.display.workingBlock.label", "In progress block"),
    () =>
      translateUi(
        "sidebar.display.workingBlock.description",
        "Every agent at work, across every project.",
      ),
  ),
  displayToggle(
    "recentBlock",
    () => translateUi("sidebar.display.recentBlock.label", "Recent block"),
    () =>
      translateUi(
        "sidebar.display.recentBlock.description",
        "The conversations you touched last, across every project.",
      ),
  ),
  displayToggle(
    "hideEmptyBlocks",
    () => translateUi("sidebar.display.hideEmptyBlocks.label", "Hide empty blocks"),
    () =>
      translateUi(
        "sidebar.display.hideEmptyBlocks.description",
        "A block with nothing in it disappears instead of saying so.",
      ),
  ),
  displayToggle(
    "stickyHeaders",
    () => translateUi("sidebar.display.stickyHeaders.label", "Sticky headers"),
    () =>
      translateUi(
        "sidebar.display.stickyHeaders.description",
        "A project's or group's header stays at the top while you scroll through it.",
      ),
  ),
  displayToggle(
    "flashOnChange",
    () => translateUi("sidebar.display.flashOnChange.label", "Flash on change"),
    () =>
      translateUi(
        "sidebar.display.flashOnChange.description",
        "A row flashes once when its conversation starts waiting, fails or replies.",
      ),
  ),
  displayToggle(
    "autoCollapse",
    () => translateUi("sidebar.display.autoCollapse.label", "Auto-collapse"),
    () =>
      translateUi(
        "sidebar.display.autoCollapse.description",
        "Fold the sidebar away while the window is narrower than 1024 px; it comes back when the window widens.",
      ),
  ),
  displayToggle(
    "typeToFilter",
    () => translateUi("sidebar.display.typeToFilter.label", "Type to filter"),
    () =>
      translateUi(
        "sidebar.display.typeToFilter.description",
        "Typing while a sidebar row has focus filters conversations. Escape clears the filter.",
      ),
  ),
];

export function rowElementsDescription(): string {
  return translateUi(
    "sidebar.displayOptions.rowElementsDescription",
    "The worktree marker on the title line, and the details beside or under the title.",
  );
}

export const ROW_ELEMENTS: readonly SidebarToggle[] = [
  displayToggle(
    "pendingRequest",
    () => translateUi("sidebar.display.rowElement.pendingRequest.label", "Pending request"),
    () =>
      translateUi(
        "sidebar.display.rowElement.pendingRequest.description",
        "Under a waiting row, what it asks for: the command to allow or the question.",
      ),
  ),
  displayToggle(
    "worktreeIcon",
    () => translateUi("sidebar.display.rowElement.worktreeIcon.label", "Worktree icon"),
    () =>
      translateUi(
        "sidebar.display.rowElement.worktreeIcon.description",
        "A branch glyph before the title when the conversation has its own worktree.",
      ),
  ),
  displayToggle(
    "branch",
    () => translateUi("sidebar.display.rowElement.branch.label", "Branch"),
    () =>
      translateUi(
        "sidebar.display.rowElement.branch.description",
        "The worktree branch, under the title.",
      ),
  ),
  displayToggle(
    "diff",
    () => translateUi("sidebar.display.rowElement.diff.label", "Diff stats"),
    () =>
      translateUi(
        "sidebar.display.rowElement.diff.description",
        "Lines added and removed in the worktree, under the title.",
      ),
  ),
  displayToggle(
    "pr",
    () => translateUi("sidebar.display.rowElement.pr.label", "Pull request"),
    () =>
      translateUi(
        "sidebar.display.rowElement.pr.description",
        "The pull request opened from the conversation and its state, under the title.",
      ),
  ),
  displayToggle(
    "ports",
    () => translateUi("sidebar.display.rowElement.ports.label", "Ports"),
    () =>
      translateUi(
        "sidebar.display.rowElement.ports.description",
        "Ports the conversation's processes listen on, under the title. Click one to open it.",
      ),
  ),
  displayToggle(
    "activity",
    () => translateUi("sidebar.display.rowElement.activity.label", "Shells & tabs"),
    () =>
      translateUi(
        "sidebar.display.rowElement.activity.description",
        "Open shells, browser tabs and downloads, under the title.",
      ),
  ),
  displayToggle(
    "todos",
    () => translateUi("sidebar.display.rowElement.todos.label", "Todo progress"),
    () =>
      translateUi(
        "sidebar.display.rowElement.todos.description",
        "How many of the agent's todos are done, until it finishes them all.",
      ),
  ),
];
