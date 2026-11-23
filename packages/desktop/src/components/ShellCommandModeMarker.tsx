import { useUiTranslation } from "@/lib/i18n/ui";
interface ShellCommandModeMarkerProps {
  onClear: () => void;
}

/**
 * Leading terminal-prompt caret (`❯`) rendered in the input's gutter in place of
 * the serialized, zero-width leading `!`. It is monospace text sharing the
 * command's exact font metrics and responsive size (`text-sm`, bumped to `1rem`
 * in the phone layout and on touch pointers like the editable), so caret and
 * command sit on one baseline and
 * read as a single terminal line. It is also the clear control: a labeled,
 * focusable button that exits shell mode while keeping the typed command. One
 * persistent glyph keeps the touch state unambiguous — a hover-reveal icon is
 * force-shown on touch (see the touch affordance rule in `touch-shell.css`).
 */
export function ShellCommandModeMarker({ onClear }: ShellCommandModeMarkerProps) {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={t(
        "conversation.composer.shellCommandModeMarker.exitShellCommandMode",
        "Exit shell command mode",
      )}
      title={t(
        "conversation.composer.shellCommandModeMarker.exitShellCommandModeAndKeepThe",
        "Exit shell command mode and keep the command text",
      )}
      className="mr-1.5 shrink-0 rounded-sm px-1 font-mono text-sm leading-[22px] text-primary transition-colors phone:text-base pointer-coarse:text-base hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      ❯
    </button>
  );
}
