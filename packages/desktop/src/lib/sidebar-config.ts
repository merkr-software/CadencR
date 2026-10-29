import { z } from "zod";

/**
 * Sidebar display options: one typed workspace setting per option. The value
 * sets mirror the Rust validators in
 * `packages/service/src/domain/settings_store/registry/sidebar.rs`.
 */

interface EnumOption<V extends string> {
  kind: "enum";
  key: string;
  schema: z.ZodType<V>;
  fallback: V;
}

interface BoolOption {
  kind: "bool";
  key: string;
  fallback: boolean;
}

/**
 * A comma-separated list of ids. `complete` lists hold every id once, in the
 * user's order (missing ids join at their default place); others are any
 * subset.
 */
interface ListOption<V extends string> {
  kind: "list";
  key: string;
  values: readonly V[];
  complete: boolean;
  fallback: readonly V[];
}

type SidebarOption = EnumOption<string> | BoolOption | ListOption<string>;

function enumOption<const V extends string>(
  key: string,
  values: readonly [V, ...V[]],
  fallback: NoInfer<V>,
): EnumOption<V> {
  return { kind: "enum", key, schema: z.enum(values), fallback };
}

function boolOption(key: string, fallback: boolean): BoolOption {
  return { kind: "bool", key, fallback };
}

function listOption<const V extends string>(
  key: string,
  values: readonly [V, ...V[]],
  complete: boolean,
): ListOption<V> {
  return { kind: "list", key, values, complete, fallback: complete ? values : [] };
}

/**
 * The sidebar's sections, top to bottom by default: the blocks, then the
 * project list. The values of `sidebar_block_order` and `sidebar_folded_blocks`.
 */
export const SIDEBAR_SECTION_IDS = ["for-me", "working", "recent", "pinned", "projects"] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

export const SIDEBAR_OPTIONS = {
  density: enumOption("sidebar_density", ["compact", "comfortable", "spacious"], "comfortable"),
  fontSize: enumOption("sidebar_font_size", ["12", "12.5", "13", "14"], "12.5"),
  titleLines: enumOption("sidebar_title_lines", ["one", "two", "hover"], "one"),
  rowHeight: enumOption("sidebar_row_height", ["auto", "fixed"], "auto"),
  colorMode: enumOption("sidebar_color_mode", ["light", "increased"], "light"),
  titleSource: enumOption("sidebar_title_source", ["title", "branch", "folder"], "title"),
  status: enumOption("sidebar_row_status", ["shape", "dot", "hidden"], "shape"),
  time: enumOption("sidebar_row_time", ["none", "relative", "absolute"], "relative"),
  branch: boolOption("sidebar_row_branch", false),
  worktreeIcon: boolOption("sidebar_row_worktree_icon", true),
  diff: boolOption("sidebar_row_diff", true),
  pr: boolOption("sidebar_row_pr", true),
  ports: boolOption("sidebar_row_ports", true),
  activity: boolOption("sidebar_row_activity", true),
  label: enumOption("sidebar_row_label", ["chip", "dot", "hidden"], "chip"),
  provider: enumOption("sidebar_row_provider", ["logo", "logo_model", "hidden"], "logo"),
  typeToFilter: boolOption("sidebar_type_to_filter", true),
  pendingRequest: boolOption("sidebar_row_pending_request", true),
  preview: enumOption("sidebar_row_preview", ["none", "last_message"], "none"),
  todos: boolOption("sidebar_row_todos", false),
  uniformRows: boolOption("sidebar_uniform_rows", true),
  compactRows: boolOption("sidebar_compact_rows", false),
  projectBadges: enumOption("sidebar_project_badges", ["count", "dot", "none"], "count"),
  forMe: boolOption("sidebar_block_for_me", true),
  forMeLimit: enumOption("sidebar_for_me_limit", ["3", "5", "all"], "3"),
  forMeAck: enumOption("sidebar_for_me_ack", ["open", "manual"], "open"),
  dormantAfter: enumOption("sidebar_dormant_after", ["never", "3", "7", "14", "30"], "7"),
  revealActive: enumOption("sidebar_reveal_active", ["scroll", "expand", "off"], "scroll"),
  rail: enumOption("sidebar_rail", ["projects", "conversations", "attention", "none"], "projects"),
  workingBlock: boolOption("sidebar_block_working", false),
  recentBlock: boolOption("sidebar_block_recent", false),
  recentCount: enumOption("sidebar_recent_count", ["3", "5", "10"], "5"),
  blockCounts: enumOption("sidebar_block_counts", ["count", "dot", "none"], "count"),
  hideEmptyBlocks: boolOption("sidebar_hide_empty_blocks", true),
  gatePopover: enumOption("sidebar_gate_popover", ["auto", "hover", "click"], "auto"),
  flashOnChange: boolOption("sidebar_flash_on_change", true),
  autoCollapse: boolOption("sidebar_auto_collapse", false),
  lens: enumOption(
    "sidebar_lens",
    ["project", "status", "worktree", "provider", "label", "date", "flat"],
    "project",
  ),
  conversationSort: enumOption(
    "sidebar_conversation_sort",
    ["activity", "created", "title", "manual"],
    "activity",
  ),
  projectSort: enumOption("sidebar_project_sort", ["frozen", "live", "name"], "frozen"),
  stickyHeaders: boolOption("sidebar_sticky_headers", true),
  sectionOrder: listOption("sidebar_block_order", SIDEBAR_SECTION_IDS, true),
  foldedSections: listOption("sidebar_folded_blocks", SIDEBAR_SECTION_IDS, false),
} as const;

type OptionValue<O> =
  O extends EnumOption<infer V>
    ? V
    : O extends BoolOption
      ? boolean
      : O extends ListOption<infer V>
        ? readonly V[]
        : never;

export type SidebarOptionId = keyof typeof SIDEBAR_OPTIONS;
export type SidebarConfig = {
  [K in SidebarOptionId]: OptionValue<(typeof SIDEBAR_OPTIONS)[K]>;
};

/**
 * The single switch the sidebar had before the display options. Still read when
 * `sidebar_row_provider` is unset, so turning logos off keeps them off.
 */
export const LEGACY_PROVIDER_LOGOS_KEY = "sidebar_provider_logos";

const OPTION_IDS = Object.keys(SIDEBAR_OPTIONS) as SidebarOptionId[];

/** Every stored key the config reads, legacy switch included (reset clears it too). */
export const SIDEBAR_SETTING_KEYS: readonly string[] = [
  ...OPTION_IDS.map((id) => SIDEBAR_OPTIONS[id].key),
  LEGACY_PROVIDER_LOGOS_KEY,
];

const BOOL_SCHEMA = z.enum(["true", "false"]);

type OptionRawValue = string | boolean | readonly string[];

/** Known ids once each, in stored order; a complete list appends the missing ones. */
function parseList(option: ListOption<string>, raw: string | null | undefined): readonly string[] {
  if (raw == null) return option.fallback;
  const known = new Set(option.values);
  const listed = [...new Set(raw.split(","))].filter((id) => known.has(id));
  if (!option.complete) return listed;
  return [...listed, ...option.values.filter((id) => !listed.includes(id))];
}

function parseOption(option: SidebarOption, raw: string | null | undefined): OptionRawValue {
  if (option.kind === "list") return parseList(option, raw);
  if (option.kind === "bool") {
    const parsed = BOOL_SCHEMA.safeParse(raw);
    return parsed.success ? parsed.data === "true" : option.fallback;
  }
  const parsed = option.schema.safeParse(raw);
  return parsed.success ? parsed.data : option.fallback;
}

/** One option's stored value; unset or invalid takes the default. */
export function parseSidebarOption<K extends SidebarOptionId>(
  id: K,
  raw: string | null | undefined,
): SidebarConfig[K] {
  return parseOption(SIDEBAR_OPTIONS[id], raw) as SidebarConfig[K];
}

/** Builds the config from stored values; unset or invalid values take the default. */
export function parseSidebarConfig(
  read: (key: string) => string | null | undefined,
): SidebarConfig {
  const entries = OPTION_IDS.map((id) => {
    const option = SIDEBAR_OPTIONS[id];
    return [id, parseOption(option, read(option.key))];
  });
  const config = Object.fromEntries(entries) as SidebarConfig;
  if (read(SIDEBAR_OPTIONS.provider.key) == null && read(LEGACY_PROVIDER_LOGOS_KEY) === "false") {
    config.provider = "hidden";
  }
  return config;
}

export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = parseSidebarConfig(() => null);

export function serializeSidebarOption(value: OptionRawValue): string {
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : value.join(",");
}
