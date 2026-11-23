/**
 * Inline keyboard shortcut badge for buttons.
 * Accepts an array of key tokens: "cmd", "shift", "enter", or any letter/symbol.
 * Renders platform-aware modifier glyphs/labels and text for letters.
 *
 * Callers that pre-format via `formatCombo` pass glyphs (`⌘`, `⇧`, `↵`) or
 * words (`Ctrl`, `Shift`); `kbd-key.tsx` resolves both spellings to one key.
 *
 * Every badge but the `modal` key cap is a hint and carries `data-kbd-hint`,
 * which hides it wherever the primary pointer is touch (`touch-shell.css`). A
 * wrapper that holds nothing but a hint carries the attribute too, so a flex
 * row doesn't keep the gap of an empty child.
 */
import { useIsTabFocused } from "@/hooks/useScopedHotkeys";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { TabKind } from "@/stores/feature-layout-schema";
import { cn } from "@/lib/utils";
import { KbdKeyContent } from "./kbd-key";

// One badge grammar: sans digits and words at 11px, Lucide glyphs sized in
// `em` so they track the text. Variants only change the chrome around it.
// `font-sans` is explicit because browsers style `<kbd>` as monospace.
const VARIANT_CLASSES = {
  inline:
    "ml-2 font-sans inline-flex h-[18px] items-center gap-px rounded border border-current/20 bg-current/10 px-1 text-[11px] font-medium leading-none text-current",
  "inline-sm":
    "ml-1 font-sans inline-flex h-4 items-center gap-px rounded border border-current/20 bg-current/10 px-1 text-[10px] font-medium leading-none text-current",
  square:
    "mr-1.5 font-sans inline-flex h-6 min-w-6 items-center justify-center gap-px rounded border border-border bg-card px-1 text-[11px] font-medium leading-none text-foreground",
  modal:
    "font-sans inline-flex h-5 min-w-5 items-center justify-center gap-px rounded border border-border bg-card px-1.5 text-[11px] font-medium leading-none text-foreground shadow-[0_1px_0_var(--border)]",
  hint: "font-sans inline-flex h-[18px] min-w-[18px] items-center justify-center gap-px rounded border border-current/25 bg-transparent px-1 text-[11px] font-medium leading-none text-current",
} as const;

type Variant = keyof typeof VARIANT_CLASSES;

/** Spread on an element that only shows a keyboard hint: touch pointers hide it. */
export const KBD_HINT_PROPS = { "data-kbd-hint": "" } as const;

interface KbdShortcutProps {
  keys: string[];
  size?: "default" | "sm";
  variant?: Variant;
  /**
   * When set, the badge subscribes to the focused-tab state and renders a
   * muted `-` placeholder whenever the named tab isn't focused — making it
   * explicit that the keys won't fire right now.
   */
  scope?: TabKind;
  /**
   * Forces the muted `-` placeholder regardless of `scope` — for shortcuts
   * that stay registered but are temporarily inert (e.g. digit selectors
   * while a free-text input is focused).
   */
  disabled?: boolean;
  /**
   * Keeps the badge on touch pointers: it answers a key the user just pressed
   * (so a keyboard is there), or spells a character typed on any keyboard.
   */
  persistent?: boolean;
}

export function KbdShortcut({
  keys,
  size = "default",
  variant,
  scope,
  disabled,
  persistent = false,
}: KbdShortcutProps) {
  const resolvedVariant = variant ?? (size === "sm" ? "inline-sm" : "inline");
  const className = VARIANT_CLASSES[resolvedVariant];
  // The `modal` cap spells a key in a reference list (the shortcuts modal),
  // which stays on touch; every other variant is a hint.
  const hint = resolvedVariant !== "modal" && !persistent;

  if (disabled) {
    return <KbdPlaceholder className={className} />;
  }
  if (scope !== undefined) {
    return <ScopedKbdShortcut keys={keys} className={className} scope={scope} hint={hint} />;
  }
  return <KbdContent keys={keys} className={className} hint={hint} />;
}

function KbdPlaceholder({ className }: { className: string }) {
  return (
    <kbd {...KBD_HINT_PROPS} className={cn(className, "opacity-50")}>
      <span className="leading-none">-</span>
    </kbd>
  );
}

interface ScopedProps {
  keys: string[];
  className: string;
  scope: TabKind;
  hint: boolean;
}

// Split into its own component so unscoped badges don't subscribe to the
// feature-layout store on every render. Out of focus, the keys stay visible
// but faded: a bare `-` on every unfocused card read as a rendering bug,
// while faded keys still say "these work once you're in this pane".
function ScopedKbdShortcut({ keys, className, scope, hint }: ScopedProps) {
  const isActive = useIsTabFocused(scope);
  return (
    <KbdContent
      keys={keys}
      className={isActive ? className : cn(className, "opacity-35")}
      hint={hint}
    />
  );
}

interface KbdContentProps {
  keys: string[];
  className: string;
  hint: boolean;
}

/**
 * Badge for a registry shortcut. Resolves the combo through the override
 * store, so the hint keeps matching the binding after a user rebinds it —
 * always prefer this over hardcoding key tokens.
 */
export function ResolvedShortcutHint({ shortcutId }: { shortcutId: ShortcutId }) {
  return <KeyboardOnlyShortcutHint keys={useShortcutKeys(shortcutId)} />;
}

/**
 * A hint badge in its own wrapper, beside a control that also works without a
 * keyboard (a dialog's Cancel / submit, a menu row, a field's access key).
 * Hidden when the primary pointer is touch, where no key can trigger it
 * (`data-kbd-hint`, like every hint).
 */
export function KeyboardOnlyShortcutHint({
  keys,
  disabled,
  className,
}: {
  keys: string[];
  /** Dimmed: the key doesn't act right now (a text field has the keyboard). */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span {...KBD_HINT_PROPS} aria-hidden="true" className={cn("shrink-0", className)}>
      <KbdShortcut keys={keys} variant="hint" disabled={disabled} />
    </span>
  );
}

/**
 * A chord as one key cap per key (`⌘` `⇧` `/`), for reference lists such as
 * the shortcuts modal where each key reads as a physical key.
 */
export function KbdChord({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((k, i) => (
        <KbdShortcut key={i} keys={[k]} variant="modal" />
      ))}
    </span>
  );
}

/** `KbdChord` for a registry shortcut, following the user's rebinds. */
export function ResolvedKbdChord({ shortcutId }: { shortcutId: ShortcutId }) {
  return <KbdChord keys={useShortcutKeys(shortcutId)} />;
}

function KbdContent({ keys, className, hint }: KbdContentProps) {
  return (
    <kbd {...(hint ? KBD_HINT_PROPS : undefined)} className={className}>
      {keys.map((k, i) => (
        <KbdKeyContent key={i} keyName={k} isMac={PLATFORM_IS_MAC} />
      ))}
    </kbd>
  );
}
