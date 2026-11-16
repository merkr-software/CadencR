/**
 * One key of a `KbdShortcut` badge: a Lucide glyph for the keys macOS draws
 * as symbols, a readable word for everything else.
 *
 * Callers pass either registry tokens (`"mod"`, `"shift"`) or strings already
 * run through `formatCombo` (`"⌘"`, `"Shift"`), so both spellings resolve to
 * the same key. Platform is a parameter, not a module constant, so tests can
 * cover the macOS and Linux renderings side by side.
 */
import {
  ArrowBigUpIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronUpIcon,
  CommandIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  OptionIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

/** Keys drawn as a glyph on every platform. */
type GlyphKey = "backspace" | "up" | "down" | "left" | "right";
/** Keys drawn as a glyph on macOS and as a word elsewhere. */
type ModifierKey = "mod" | "alt" | "ctrl" | "shift" | "enter";
/** Keys always written out. */
type WordKey = "escape" | "tab" | "space";
type NamedKey = GlyphKey | ModifierKey | WordKey;

// A Map, not an object literal: arbitrary key text ("constructor") must not
// resolve through Object.prototype.
const ALIASES = new Map<string, NamedKey>([
  ["mod", "mod"],
  ["cmd", "mod"],
  ["command", "mod"],
  ["⌘", "mod"],
  ["alt", "alt"],
  ["opt", "alt"],
  ["option", "alt"],
  ["⌥", "alt"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["⌃", "ctrl"],
  ["shift", "shift"],
  ["⇧", "shift"],
  ["enter", "enter"],
  ["return", "enter"],
  ["↵", "enter"],
  ["⏎", "enter"],
  ["↩", "enter"],
  ["backspace", "backspace"],
  ["⌫", "backspace"],
  ["esc", "escape"],
  ["escape", "escape"],
  ["tab", "tab"],
  ["space", "space"],
  ["up", "up"],
  ["↑", "up"],
  ["down", "down"],
  ["↓", "down"],
  ["left", "left"],
  ["←", "left"],
  ["right", "right"],
  ["→", "right"],
]);

interface KeyGlyph {
  Icon: LucideIcon;
  label: string;
}

const GLYPHS: Record<GlyphKey, KeyGlyph> = {
  backspace: { Icon: DeleteIcon, label: "Backspace" },
  up: { Icon: ArrowUpIcon, label: "Up" },
  down: { Icon: ArrowDownIcon, label: "Down" },
  left: { Icon: ArrowLeftIcon, label: "Left" },
  right: { Icon: ArrowRightIcon, label: "Right" },
};

const WORDS: Record<ModifierKey | WordKey, string> = {
  mod: "Ctrl",
  alt: "Alt",
  ctrl: "Ctrl",
  shift: "Shift",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
};

/** How each named key renders: a glyph, or the word to write. */
type KeyRendering = Record<NamedKey, KeyGlyph | string>;

const LINUX_KEYS: KeyRendering = { ...GLYPHS, ...WORDS };

const MAC_KEYS: KeyRendering = {
  ...LINUX_KEYS,
  // Mac keyboards label ⌫ "delete".
  backspace: { Icon: DeleteIcon, label: "Delete" },
  mod: { Icon: CommandIcon, label: "Command" },
  alt: { Icon: OptionIcon, label: "Option" },
  ctrl: { Icon: ChevronUpIcon, label: "Control" },
  shift: { Icon: ArrowBigUpIcon, label: "Shift" },
  enter: { Icon: CornerDownLeftIcon, label: "Return" },
};

export function resolveKbdKey(
  key: string,
  isMac: boolean,
): { kind: "glyph"; glyph: KeyGlyph } | { kind: "text"; text: string } {
  const named = ALIASES.get(key.toLowerCase());
  if (named) {
    const rendering = (isMac ? MAC_KEYS : LINUX_KEYS)[named];
    return typeof rendering === "string"
      ? { kind: "text", text: rendering }
      : { kind: "glyph", glyph: rendering };
  }
  // Letter mnemonics ("p") and F-keys read as printed key caps.
  const isCap = /^[a-z]$|^f\d{1,2}$/.test(key);
  return { kind: "text", text: isCap ? key.toUpperCase() : key };
}

export function KbdKeyContent({ keyName, isMac }: { keyName: string; isMac: boolean }): ReactNode {
  const resolved = resolveKbdKey(keyName, isMac);
  if (resolved.kind === "text") {
    return <span className="inline-flex h-[1em] items-center leading-none">{resolved.text}</span>;
  }
  const { Icon, label } = resolved.glyph;
  return (
    // The badge decorates a control that already carries its own name, so the
    // glyph stays out of the accessibility tree; `data-kbd-key` names it.
    <span className="inline-flex h-[1em] items-center" data-kbd-key={label}>
      <Icon className="size-[1.1em] shrink-0" strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

/**
 * A chord as bare glyphs, without badge chrome — for menus, where shortcuts
 * sit right-aligned in muted text. Linux words are joined with `+`.
 */
export function KbdKeySequence({ keys, isMac }: { keys: string[]; isMac: boolean }): ReactNode {
  return keys.map((k, i) => (
    <Fragment key={i}>
      {i > 0 && !isMac ? <span className="leading-none">+</span> : null}
      <KbdKeyContent keyName={k} isMac={isMac} />
    </Fragment>
  ));
}
