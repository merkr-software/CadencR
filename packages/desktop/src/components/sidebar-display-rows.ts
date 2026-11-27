import { translateUi } from "@/lib/i18n/ui";
import { displayChoice, displayOption, type SidebarChoice } from "./sidebar-display-metadata";
import type { SegmentedOption } from "@/components/usage/UsageSegmentedControl";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { CONVERSATION_CHOICES } from "./sidebar-display-conversation-choices";

export type { ChoiceId, ChoiceRow } from "./sidebar-display-metadata";
export { ROW_ELEMENTS, SWITCH_ROWS, rowElementsDescription } from "./sidebar-display-toggles";

/** Choices shared by the display options and the Projects header menu. */
export const LENS_OPTIONS: readonly SegmentedOption<SidebarConfig["lens"]>[] = [
  displayOption("project", () =>
    translateUi("sidebar.display.lens.option.project.label", "Project"),
  ),
  displayOption("status", () => translateUi("sidebar.display.lens.option.status.label", "Status")),
  displayOption("worktree", () =>
    translateUi("sidebar.display.lens.option.worktree.label", "Worktree"),
  ),
  displayOption("provider", () =>
    translateUi("sidebar.display.lens.option.provider.label", "Provider"),
  ),
  displayOption("label", () => translateUi("sidebar.display.lens.option.label.label", "Label")),
  displayOption("date", () => translateUi("sidebar.display.lens.option.date.label", "Date")),
  displayOption("flat", () => translateUi("sidebar.display.lens.option.flat.label", "Flat list")),
];

export const CHOICE_ROWS: readonly SidebarChoice[] = [
  ...CONVERSATION_CHOICES,
  displayChoice(
    "lens",
    () => translateUi("sidebar.display.lens.label", "Group by"),
    () =>
      translateUi(
        "sidebar.display.lens.description",
        "How conversations are grouped below the blocks: under their project, or across projects by status, worktree branch, provider, label or last activity, or one flat list.",
      ),
    LENS_OPTIONS,
    "select",
  ),
  displayChoice(
    "conversationSort",
    () => translateUi("sidebar.display.conversationSort.label", "Sort conversations"),
    () =>
      translateUi(
        "sidebar.display.conversationSort.description",
        "The order of conversations within a project or group. Dragging a conversation switches to Manual; the other sorts come back by choosing them.",
      ),
    [
      displayOption(
        "activity",
        () => translateUi("sidebar.display.conversationSort.option.activity.label", "Activity"),
        () =>
          translateUi(
            "sidebar.display.conversationSort.option.activity.title",
            "Last message first",
          ),
      ),
      displayOption(
        "created",
        () => translateUi("sidebar.display.conversationSort.option.created.label", "Created"),
        () =>
          translateUi(
            "sidebar.display.conversationSort.option.created.title",
            "Newest conversation first",
          ),
      ),
      displayOption(
        "title",
        () => translateUi("sidebar.display.conversationSort.option.title.label", "Title"),
        () => translateUi("sidebar.display.conversationSort.option.title.title", "Alphabetical"),
      ),
      displayOption(
        "manual",
        () => translateUi("sidebar.display.conversationSort.option.manual.label", "Manual"),
        () =>
          translateUi(
            "sidebar.display.conversationSort.option.manual.title",
            "The order you drag them into",
          ),
      ),
    ],
  ),
  displayChoice(
    "projectSort",
    () => translateUi("sidebar.display.projectSort.label", "Sort projects"),
    () =>
      translateUi(
        "sidebar.display.projectSort.description",
        "The order of projects: by activity, re-sorted only when you ask (the refresh button in the Projects header), by activity as it happens, or by name.",
      ),
    [
      displayOption(
        "frozen",
        () => translateUi("sidebar.display.projectSort.option.frozen.label", "Frozen"),
        () =>
          translateUi(
            "sidebar.display.projectSort.option.frozen.title",
            "By activity, re-sorted when you ask",
          ),
      ),
      displayOption(
        "live",
        () => translateUi("sidebar.display.projectSort.option.live.label", "Live"),
        () =>
          translateUi(
            "sidebar.display.projectSort.option.live.title",
            "By activity, as it happens",
          ),
      ),
      displayOption(
        "name",
        () => translateUi("sidebar.display.projectSort.option.name.label", "Name"),
        () => translateUi("sidebar.display.projectSort.option.name.title", "Alphabetical"),
      ),
    ],
  ),
  displayChoice(
    "projectBadges",
    () => translateUi("sidebar.display.projectBadges.label", "Project badges"),
    () =>
      translateUi(
        "sidebar.display.projectBadges.description",
        "What a collapsed project shows: pending requests and failures as strong pills, working agents and unread replies as quiet marks.",
      ),
    [
      displayOption("count", () =>
        translateUi("sidebar.display.projectBadges.option.count.label", "Count"),
      ),
      displayOption(
        "dot",
        () => translateUi("sidebar.display.projectBadges.option.dot.label", "Dot"),
        () =>
          translateUi(
            "sidebar.display.projectBadges.option.dot.title",
            "One mark per state, without numbers",
          ),
      ),
      displayOption("none", () =>
        translateUi("sidebar.display.projectBadges.option.none.label", "None"),
      ),
    ],
  ),
  displayChoice(
    "dormantAfter",
    () => translateUi("sidebar.display.dormantAfter.label", "Fold idle after"),
    () =>
      translateUi(
        "sidebar.display.dormantAfter.description",
        "Fold conversations idle for this long into a Dormant section. Open, working, waiting and unread ones always stay.",
      ),
    [
      displayOption("never", () =>
        translateUi("sidebar.display.dormantAfter.option.never.label", "Never"),
      ),
      displayOption("3", () => translateUi("sidebar.time.days", "{{count}}d", { count: 3 })),
      displayOption("7", () => translateUi("sidebar.time.days", "{{count}}d", { count: 7 })),
      displayOption("14", () => translateUi("sidebar.time.days", "{{count}}d", { count: 14 })),
      displayOption("30", () => translateUi("sidebar.time.days", "{{count}}d", { count: 30 })),
    ],
  ),
  displayChoice(
    "revealActive",
    () => translateUi("sidebar.display.revealActive.label", "Reveal open"),
    () =>
      translateUi(
        "sidebar.display.revealActive.description",
        "When a conversation opens, expand its project and scroll its row into view.",
      ),
    [
      displayOption("scroll", () =>
        translateUi("sidebar.display.revealActive.option.scroll.label", "Scroll"),
      ),
      displayOption(
        "expand",
        () => translateUi("sidebar.display.revealActive.option.expand.label", "Expand"),
        () =>
          translateUi(
            "sidebar.display.revealActive.option.expand.title",
            "Expand its project without scrolling",
          ),
      ),
      displayOption("off", () =>
        translateUi("sidebar.display.revealActive.option.off.label", "Off"),
      ),
    ],
  ),
  displayChoice(
    "rail",
    () => translateUi("sidebar.display.rail.label", "Collapsed rail"),
    () =>
      translateUi(
        "sidebar.display.rail.description",
        "What stays visible when the sidebar is collapsed.",
      ),
    [
      displayOption("projects", () =>
        translateUi("sidebar.display.rail.option.projects.label", "Projects"),
      ),
      displayOption(
        "conversations",
        () => translateUi("sidebar.display.conversations.label", "Active"),
        () =>
          translateUi(
            "sidebar.display.conversations.title",
            "Every conversation with something going on",
          ),
      ),
      displayOption(
        "attention",
        () => translateUi("sidebar.display.rail.option.attention.label", "Attention"),
        () =>
          translateUi(
            "sidebar.display.rail.option.attention.title",
            "Only conversations waiting on you",
          ),
      ),
      displayOption("none", () => translateUi("sidebar.display.rail.option.none.label", "None")),
    ],
  ),
  displayChoice(
    "gatePopover",
    () => translateUi("sidebar.display.gatePopover.label", "Quick reply"),
    () =>
      translateUi(
        "sidebar.display.gatePopover.description",
        "How a waiting conversation's quick reply opens: by itself on the newest request, on pointing at its icon, only on a click, or never.",
      ),
    [
      displayOption(
        "auto",
        () => translateUi("sidebar.display.gatePopover.option.auto.label", "Auto"),
        () =>
          translateUi(
            "sidebar.display.gatePopover.option.auto.title",
            "Opens by itself on the newest request",
          ),
      ),
      displayOption(
        "hover",
        () => translateUi("sidebar.display.gatePopover.option.hover.label", "Hover"),
        () =>
          translateUi(
            "sidebar.display.gatePopover.option.hover.title",
            "Opens while you point at the pending icon",
          ),
      ),
      displayOption(
        "click",
        () => translateUi("sidebar.display.gatePopover.option.click.label", "Click"),
        () =>
          translateUi(
            "sidebar.display.gatePopover.option.click.title",
            "Opens only when you click the pending icon",
          ),
      ),
      displayOption(
        "off",
        () => translateUi("sidebar.display.gatePopover.option.off.label", "Off"),
        () =>
          translateUi(
            "sidebar.display.gatePopover.option.off.title",
            "Never: answer in the conversation",
          ),
      ),
    ],
  ),
  displayChoice(
    "blockCounts",
    () => translateUi("sidebar.display.blockCounts.label", "Block counters"),
    () =>
      translateUi(
        "sidebar.display.blockCounts.description",
        "What the For me, In progress and Pinned headers show next to their name.",
      ),
    [
      displayOption("count", () =>
        translateUi("sidebar.display.blockCounts.option.count.label", "Count"),
      ),
      displayOption(
        "dot",
        () => translateUi("sidebar.display.blockCounts.option.dot.label", "Dot"),
        () =>
          translateUi(
            "sidebar.display.blockCounts.option.dot.title",
            "A dot, amber when something needs an action",
          ),
      ),
      displayOption("none", () =>
        translateUi("sidebar.display.blockCounts.option.none.label", "None"),
      ),
    ],
  ),
  displayChoice(
    "forMeLimit",
    () => translateUi("sidebar.display.forMeLimit.label", "For me shows"),
    () =>
      translateUi(
        "sidebar.display.forMeLimit.description",
        "How many next actions the For me block lists before a Show more.",
      ),
    [
      { value: "3", label: "3" },
      { value: "5", label: "5" },
      displayOption("all", () => translateUi("sidebar.display.forMeLimit.option.all.label", "All")),
    ],
  ),
  displayChoice(
    "forMeAck",
    () => translateUi("sidebar.display.forMeAck.label", "For me clears"),
    () =>
      translateUi(
        "sidebar.display.forMeAck.description",
        "When a For me entry leaves the list. When done: opening the conversation keeps it until you check it off or send a prompt.",
      ),
    [
      displayOption(
        "open",
        () => translateUi("sidebar.display.forMeAck.option.open.label", "On open"),
        () =>
          translateUi(
            "sidebar.display.forMeAck.option.open.title",
            "Opening the conversation clears it",
          ),
      ),
      displayOption(
        "manual",
        () => translateUi("sidebar.display.forMeAck.option.manual.label", "When done"),
        () =>
          translateUi(
            "sidebar.display.forMeAck.option.manual.title",
            "Check it off or send a prompt",
          ),
      ),
    ],
  ),
  displayChoice(
    "recentCount",
    () => translateUi("sidebar.display.recentCount.label", "Recent shows"),
    () =>
      translateUi(
        "sidebar.display.recentCount.description",
        "How many conversations the Recent block lists.",
      ),
    [
      { value: "3", label: "3" },
      { value: "5", label: "5" },
      { value: "10", label: "10" },
    ],
  ),
];
