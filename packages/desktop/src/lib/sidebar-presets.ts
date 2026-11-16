import {
  DEFAULT_SIDEBAR_CONFIG,
  LEGACY_PROVIDER_LOGOS_KEY,
  serializeSidebarOption,
  SIDEBAR_OPTIONS,
  type SidebarConfig,
  type SidebarOptionId,
} from "@/lib/sidebar-config";

export type SidebarPresetId = "classic" | "focus" | "supervise" | "detailed";

interface SidebarPresetDefinition {
  id: SidebarPresetId;
  label: string;
  /** The preset's intent in a few words, under its name. */
  tagline: string;
  /** What it shows, where there is room to say it. */
  description: string;
  /** What the preset changes from the defaults; every other display option is reset. */
  overrides: Partial<SidebarConfig>;
}

export interface SidebarPreset extends SidebarPresetDefinition {
  /** The whole display configuration: the overrides over the defaults. */
  config: SidebarConfig;
}

/**
 * Built-in sidebar presets (L1), one per way of working, each a full display
 * configuration: applying one resets every display option it doesn't set.
 * Classic is the defaults, so it is also what a new user gets. Behaviour
 * switches are left alone. They differ on purpose: Focus strips rows to their
 * status, Supervise is about the agents (replies, todos, who is at work),
 * Detailed shows everything at once, in rows of one fixed height.
 */
const PRESET_DEFINITIONS: readonly SidebarPresetDefinition[] = [
  {
    id: "classic",
    label: "Classic",
    tagline: "Balanced defaults",
    description:
      "Status shapes, relative times, and each worktree's diff, PR and ports in its row.",
    overrides: {},
  },
  {
    id: "focus",
    label: "Focus",
    tagline: "Only what needs you",
    description:
      "Titles and a status dot. A row grows back only when it waits on you; idle ones fold after 3 days.",
    overrides: {
      status: "dot",
      time: "none",
      compactRows: true,
      worktreeIcon: false,
      label: "dot",
      provider: "hidden",
      projectBadges: "dot",
      blockCounts: "dot",
      flashOnChange: false,
      dormantAfter: "3",
      rail: "attention",
    },
  },
  {
    id: "supervise",
    label: "Supervise",
    tagline: "Many agents at once",
    description:
      "Each agent's model, last reply and todo progress, an In progress block on top, every next action in For me. Git details step aside.",
    overrides: {
      preview: "last_message",
      todos: true,
      provider: "logo_model",
      workingBlock: true,
      forMeLimit: "all",
      diff: false,
      pr: false,
      ports: false,
      activity: false,
      dormantAfter: "3",
      rail: "conversations",
    },
  },
  {
    id: "detailed",
    label: "Detailed",
    tagline: "Every detail, fixed rows",
    description:
      "Every row four lines high and every line filled: the title, the request, the agent's last reply over the lines the details leave, the code (branch, diff, PR), then the activity (label, todos, shells, ports), each detail in a color of its own. Absolute times, a Recent block.",
    overrides: {
      fontSize: "12",
      rowHeight: "fixed",
      colorMode: "increased",
      worktreeIcon: false,
      preview: "last_message",
      todos: true,
      branch: true,
      uniformRows: false,
      time: "absolute",
      recentBlock: true,
    },
  },
];

export const SIDEBAR_PRESETS: readonly SidebarPreset[] = PRESET_DEFINITIONS.map((preset) => ({
  ...preset,
  config: { ...DEFAULT_SIDEBAR_CONFIG, ...preset.overrides },
}));

/** How the sidebar behaves rather than looks: no preset sets or resets these. */
const BEHAVIOUR_OPTIONS: ReadonlySet<SidebarOptionId> = new Set([
  "typeToFilter",
  "revealActive",
  "gatePopover",
  "autoCollapse",
  "lens",
  "conversationSort",
  "projectSort",
  "stickyHeaders",
  "forMeAck",
  "sectionOrder",
  "foldedSections",
]);

const PRESET_OPTION_IDS = (Object.keys(SIDEBAR_OPTIONS) as SidebarOptionId[]).filter(
  (id) => !BEHAVIOUR_OPTIONS.has(id),
);

export interface SidebarPresetMatch {
  /** The preset the display options are, or are closest to. */
  preset: SidebarPreset;
  /** How many display options differ from it: 0 when it is the preset itself. */
  changes: number;
}

/**
 * The preset the display options are closest to, and by how many options they
 * differ from it: a customized sidebar still says which preset it came from.
 * Ties go to the earlier preset, so Classic wins them.
 */
export function nearestSidebarPreset(config: SidebarConfig): SidebarPresetMatch {
  return SIDEBAR_PRESETS.map((preset) => ({
    preset,
    changes: PRESET_OPTION_IDS.filter((id) => config[id] !== preset.config[id]).length,
  })).reduce((best, match) => (match.changes < best.changes ? match : best));
}

/** The preset the display options match exactly, else null (customized). */
export function matchSidebarPreset(config: SidebarConfig): SidebarPresetId | null {
  const { preset, changes } = nearestSidebarPreset(config);
  return changes === 0 ? preset.id : null;
}

/** The batch write that applies a preset: its own values, the defaults for the rest. */
export function sidebarPresetValues(presetId: SidebarPresetId): Record<string, string | null> {
  const preset = SIDEBAR_PRESETS.find((candidate) => candidate.id === presetId);
  return sidebarDisplayValues(preset?.config ?? DEFAULT_SIDEBAR_CONFIG);
}

/**
 * The batch write that puts a config's display options in place (a preset, or
 * the options a preset replaced, when it is undone). Options at their default
 * are cleared rather than stored, legacy switch included, so they keep
 * following the defaults.
 */
export function sidebarDisplayValues(config: SidebarConfig): Record<string, string | null> {
  const written: Record<string, string | null> = { [LEGACY_PROVIDER_LOGOS_KEY]: null };
  for (const id of PRESET_OPTION_IDS) {
    const value = config[id];
    written[SIDEBAR_OPTIONS[id].key] =
      value === DEFAULT_SIDEBAR_CONFIG[id] ? null : serializeSidebarOption(value);
  }
  return written;
}
