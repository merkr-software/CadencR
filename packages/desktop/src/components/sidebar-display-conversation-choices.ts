import { translateUi } from "@/lib/i18n/ui";
import { displayChoice, displayOption, type SidebarChoice } from "./sidebar-display-metadata";

export const CONVERSATION_CHOICES: readonly SidebarChoice[] = [
  displayChoice(
    "density",
    () => translateUi("sidebar.display.density.label", "Density"),
    () =>
      translateUi("sidebar.display.density.description", "Height of each row: 28, 36 or 44 px."),
    [
      displayOption("compact", () =>
        translateUi("sidebar.display.density.option.compact.label", "Compact"),
      ),
      displayOption("comfortable", () =>
        translateUi("sidebar.display.density.option.comfortable.label", "Comfortable"),
      ),
      displayOption("spacious", () =>
        translateUi("sidebar.display.density.option.spacious.label", "Spacious"),
      ),
    ],
  ),
  displayChoice(
    "fontSize",
    () => translateUi("sidebar.display.fontSize.label", "Text size"),
    () =>
      translateUi(
        "sidebar.display.fontSize.description",
        "Size of conversation titles, in pixels.",
      ),
    [
      { value: "12", label: "12" },
      { value: "12.5", label: "12.5" },
      { value: "13", label: "13" },
      { value: "14", label: "14" },
    ],
  ),
  displayChoice(
    "titleLines",
    () => translateUi("sidebar.display.titleLines.label", "Title"),
    () =>
      translateUi(
        "sidebar.display.titleLines.description",
        "How much of a long title shows. A fixed row height keeps it to one line.",
      ),
    [
      displayOption("one", () =>
        translateUi("sidebar.display.titleLines.option.one.label", "1 line"),
      ),
      displayOption("two", () =>
        translateUi("sidebar.display.titleLines.option.two.label", "2 lines"),
      ),
      displayOption(
        "hover",
        () => translateUi("sidebar.display.titleLines.option.hover.label", "Full on hover"),
        () =>
          translateUi(
            "sidebar.display.titleLines.option.hover.title",
            "One line, the full title on hover",
          ),
      ),
    ],
  ),
  displayChoice(
    "rowHeight",
    () => translateUi("sidebar.display.rowHeight.label", "Row height"),
    () =>
      translateUi(
        "sidebar.display.rowHeight.description",
        "Fixed: every row the same height and every line filled: a one-line title, then the request, the last reply and the details, the reply wrapping over the lines a row's details leave. Without the reply (Preview: None), the details sit beside the title and a request shows as the status alone. Hovering a row never moves anything.",
      ),
    [
      displayOption(
        "auto",
        () => translateUi("sidebar.display.rowHeight.option.auto.label", "Auto"),
        () =>
          translateUi(
            "sidebar.display.rowHeight.option.auto.title",
            "Each row as tall as what it shows",
          ),
      ),
      displayOption(
        "fixed",
        () => translateUi("sidebar.display.rowHeight.option.fixed.label", "Fixed"),
        () =>
          translateUi("sidebar.display.rowHeight.option.fixed.title", "Every row the same height"),
      ),
    ],
  ),
  displayChoice(
    "colorMode",
    () => translateUi("sidebar.display.colorMode.label", "Colors"),
    () =>
      translateUi(
        "sidebar.display.colorMode.description",
        "Light: color only where it carries a state (status, diff, pull request, label, request). Increased: the time takes the status's color, and the branch, todos, shells and tabs a hue of their own, counts without their box, so each one reads at a glance while the title and reply stay in neutral ink.",
      ),
    [
      displayOption(
        "light",
        () => translateUi("sidebar.display.colorMode.option.light.label", "Light"),
        () =>
          translateUi(
            "sidebar.display.colorMode.option.light.title",
            "Color only where it carries a state",
          ),
      ),
      displayOption(
        "increased",
        () => translateUi("sidebar.display.colorMode.option.increased.label", "Increased"),
        () =>
          translateUi(
            "sidebar.display.colorMode.option.increased.title",
            "A color for each kind of detail",
          ),
      ),
    ],
  ),
  displayChoice(
    "titleSource",
    () => translateUi("sidebar.display.titleSource.label", "Title from"),
    () =>
      translateUi(
        "sidebar.display.titleSource.description",
        "Lead with the conversation title, its worktree branch, or its worktree folder.",
      ),
    [
      displayOption("title", () =>
        translateUi("sidebar.display.titleSource.option.title.label", "Title"),
      ),
      displayOption(
        "branch",
        () => translateUi("sidebar.display.titleSource.option.branch.label", "Branch"),
        () =>
          translateUi(
            "sidebar.display.titleSource.option.branch.title",
            "The worktree branch, else the title",
          ),
      ),
      displayOption(
        "folder",
        () => translateUi("sidebar.display.titleSource.option.folder.label", "Folder"),
        () =>
          translateUi(
            "sidebar.display.titleSource.option.folder.title",
            "The worktree folder, else the title",
          ),
      ),
    ],
  ),
  displayChoice(
    "status",
    () => translateUi("sidebar.display.status.label", "Status"),
    () =>
      translateUi(
        "sidebar.display.status.description",
        "How working, unread and idle conversations show. Pending requests and failures always show.",
      ),
    [
      displayOption("shape", () =>
        translateUi("sidebar.display.status.option.shape.label", "Shape"),
      ),
      displayOption("dot", () => translateUi("sidebar.display.status.option.dot.label", "Dot")),
      displayOption(
        "hidden",
        () => translateUi("sidebar.display.status.option.hidden.label", "Hidden"),
        () =>
          translateUi(
            "sidebar.display.status.option.hidden.title",
            "Pending requests and failures stay visible",
          ),
      ),
    ],
  ),
  displayChoice(
    "time",
    () => translateUi("sidebar.display.time.label", "Time"),
    () =>
      translateUi(
        "sidebar.display.time.description",
        "Last activity on each row. Hovering a row swaps it for the row actions.",
      ),
    [
      displayOption("none", () => translateUi("sidebar.display.time.option.none.label", "None")),
      displayOption("relative", () =>
        translateUi("sidebar.display.time.option.relative.label", "Relative"),
      ),
      displayOption("absolute", () =>
        translateUi("sidebar.display.time.option.absolute.label", "Absolute"),
      ),
    ],
  ),
  displayChoice(
    "label",
    () => translateUi("sidebar.display.label.label", "Label"),
    () =>
      translateUi(
        "sidebar.display.label.description",
        "How a conversation label shows under its title.",
      ),
    [
      displayOption("chip", () => translateUi("sidebar.display.label.option.chip.label", "Chip")),
      displayOption("dot", () => translateUi("sidebar.display.label.option.dot.label", "Dot")),
      displayOption("hidden", () =>
        translateUi("sidebar.display.label.option.hidden.label", "Hidden"),
      ),
    ],
  ),
  displayChoice(
    "provider",
    () => translateUi("sidebar.display.provider.label", "Provider"),
    () =>
      translateUi(
        "sidebar.display.provider.description",
        "The harness logo at the end of each row, optionally with the model under the title.",
      ),
    [
      displayOption("logo", () =>
        translateUi("sidebar.display.provider.option.logo.label", "Logo"),
      ),
      displayOption("logo_model", () =>
        translateUi("sidebar.display.provider.option.logo_model.label", "Logo + model"),
      ),
      displayOption("hidden", () =>
        translateUi("sidebar.display.provider.option.hidden.label", "Hidden"),
      ),
    ],
  ),
  displayChoice(
    "preview",
    () => translateUi("sidebar.display.preview.label", "Preview"),
    () =>
      translateUi(
        "sidebar.display.preview.description",
        "A line under the title with the start of the agent's last reply.",
      ),
    [
      displayOption("none", () => translateUi("sidebar.display.preview.option.none.label", "None")),
      displayOption("last_message", () =>
        translateUi("sidebar.display.preview.option.last_message.label", "Last reply"),
      ),
    ],
  ),
];
