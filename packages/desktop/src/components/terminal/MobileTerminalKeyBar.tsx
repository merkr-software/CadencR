import { memo } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, type LucideIcon } from "lucide-react";
import { TERMINAL_KEYS } from "@/lib/terminal-keys";

interface MobileTerminalKeyBarProps {
  /** Whether the sticky Ctrl modifier is currently armed. */
  ctrlArmed: boolean;
  /** Toggle the sticky Ctrl modifier (folds into the next typed character). */
  onToggleCtrl: () => void;
  /** Send a raw byte sequence to the active pane (Esc/Tab/arrows). */
  onSendKey: (seq: string) => void;
}

const KEY_BTN_BASE =
  "flex h-9 min-w-9 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors";
const KEY_BTN_IDLE =
  "bg-[var(--terminal-panel-icon-bg-hover)] text-[var(--terminal-panel-icon-hover)] active:bg-[var(--terminal-panel-handle-bg-hover)]";
const KEY_BTN_ARMED = "bg-[var(--terminal-panel-icon-hover)] text-[var(--terminal-bg)]";

interface KeyDef {
  seq: string;
  label?: string;
  icon?: LucideIcon;
  ariaLabel?: string;
}

const TEXT_KEYS: KeyDef[] = [
  { seq: TERMINAL_KEYS.esc, label: "esc" },
  { seq: TERMINAL_KEYS.tab, label: "tab" },
];

const ARROW_KEYS: KeyDef[] = [
  { seq: TERMINAL_KEYS.arrowLeft, icon: ArrowLeft, ariaLabel: "Left" },
  { seq: TERMINAL_KEYS.arrowDown, icon: ArrowDown, ariaLabel: "Down" },
  { seq: TERMINAL_KEYS.arrowUp, icon: ArrowUp, ariaLabel: "Up" },
  { seq: TERMINAL_KEYS.arrowRight, icon: ArrowRight, ariaLabel: "Right" },
];

/**
 * Touch-keyboard accessory bar for the terminal: restores the keys a phone
 * soft keyboard lacks — Esc, Tab, arrows, and a sticky Ctrl that folds into the
 * next character typed (Ctrl+C, Ctrl+D, …). Mobile-only; rendered by
 * TerminalPanel below the split tree.
 */
export const MobileTerminalKeyBar = memo(function MobileTerminalKeyBar({
  ctrlArmed,
  onToggleCtrl,
  onSendKey,
}: MobileTerminalKeyBarProps) {
  // Fire on pointer-down and preventDefault so the xterm textarea keeps focus —
  // otherwise tapping a key would dismiss the on-screen keyboard.
  const press = (action: () => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    action();
  };

  const renderKey = ({ seq, label, icon: Icon, ariaLabel }: KeyDef) => (
    <button
      key={seq}
      type="button"
      aria-label={ariaLabel}
      className={`${KEY_BTN_BASE} ${KEY_BTN_IDLE}`}
      onPointerDown={press(() => onSendKey(seq))}
    >
      {Icon ? <Icon className="size-4" /> : label}
    </button>
  );

  return (
    // The shell no longer reserves a global safe-area strip, so this bottom bar
    // owns its own home-indicator clearance: its terminal-colored fill extends to
    // the screen edge while the tappable keys stay above the inset (`pb-[max(...)]`).
    <div
      className="flex shrink-0 items-center justify-center gap-1 overflow-x-auto border-t border-[var(--terminal-panel-handle-bg)] bg-[var(--terminal-bg)] px-2 pt-1.5 pb-[max(0.375rem,var(--app-inset-bottom))]"
      data-mobile-terminal-keybar
    >
      {TEXT_KEYS.map(renderKey)}
      <button
        type="button"
        aria-pressed={ctrlArmed}
        className={`${KEY_BTN_BASE} ${ctrlArmed ? KEY_BTN_ARMED : KEY_BTN_IDLE}`}
        onPointerDown={press(onToggleCtrl)}
      >
        ctrl
      </button>
      {ARROW_KEYS.map(renderKey)}
    </div>
  );
});
