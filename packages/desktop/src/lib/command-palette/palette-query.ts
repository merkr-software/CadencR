/**
 * What the palette searches. `all` mixes conversations, projects, commands and
 * settings (plus message hits once the query is long enough); a prefix typed
 * first narrows to one kind, shown as a chip in the input.
 */
export type PaletteMode = "all" | "commands" | "files" | "messages";

/** A mode a prefix selects. */
export type PrefixMode = Exclude<PaletteMode, "all">;

export const PREFIX_BY_MODE: Record<PrefixMode, string> = {
  commands: ">",
  files: "@",
  messages: "#",
};

export const PREFIX_MODES = Object.keys(PREFIX_BY_MODE) as PrefixMode[];

const MODE_BY_PREFIX = new Map(PREFIX_MODES.map((mode) => [PREFIX_BY_MODE[mode], mode]));

/** The mixed search also looks in messages from this many characters. */
export const MESSAGE_SEARCH_MIN_CHARS = 3;
/** `#` searches messages from this many characters. */
export const MESSAGES_MODE_MIN_CHARS = 2;

/**
 * Applies a typed value: in `all`, a leading prefix switches the mode and is
 * dropped from the text (typing or pasting "#deploy" alike).
 */
export function applyPaletteInput(
  mode: PaletteMode,
  value: string,
): { mode: PaletteMode; text: string } {
  if (mode !== "all") return { mode, text: value };
  const prefixed = MODE_BY_PREFIX.get(value[0] ?? "");
  if (prefixed) return { mode: prefixed, text: value.slice(1).trimStart() };
  return { mode, text: value };
}

/**
 * Where the palette looks for conversations: everything (archives ranked
 * lower), the open project only, or active conversations only.
 */
export type PaletteScope = "all" | "project" | "active";

const SCOPE_ORDER: readonly PaletteScope[] = ["all", "project", "active"];

export function nextScope(scope: PaletteScope, hasProject: boolean): PaletteScope {
  const order = hasProject ? SCOPE_ORDER : SCOPE_ORDER.filter((value) => value !== "project");
  return order[(order.indexOf(scope) + 1) % order.length] ?? "all";
}
