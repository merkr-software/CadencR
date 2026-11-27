import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import {
  PREFIX_BY_MODE,
  PREFIX_MODES,
  type PaletteMode,
  type PrefixMode,
} from "@/lib/command-palette/palette-query";
import type { PaletteEntry } from "@/lib/command-palette/palette-types";
import { KeyCaps, PaletteKeys } from "./PaletteText";
import { modeLabel } from "./PaletteInputRow";
import type { PaletteView } from "./usePaletteFlow";

type FooterContext = PaletteView["kind"];

/** What Enter does to the selected row, named in the footer. */
function enterLabel(entry: PaletteEntry | null, context: FooterContext, t: UiTranslator): string {
  if (context === "actions") return t("palette.footer.run", "Run");
  if (context === "step") return t("palette.footer.choose", "Choose");
  if (!entry) return t("palette.footer.open", "Open");
  if (entry.kind === "command") {
    if (entry.command.step || entry.command.mode) return t("palette.footer.continue", "Continue");
    return t("palette.footer.run", "Run");
  }
  if (entry.kind === "message") return t("palette.footer.openAndFind", "Open & find");
  return t("palette.footer.open", "Open");
}

export interface PaletteFooterProps {
  entry: PaletteEntry | null;
  context: FooterContext;
  mode: PaletteMode;
  /** Files need an open conversation's worktree. */
  filesAvailable: boolean;
  onMode: (mode: PrefixMode) => void;
  onActions: () => void;
}

/**
 * The keys that matter right now, then the prefixes as buttons: clicking
 * one does what typing it does, so the modes are discoverable without a manual.
 */
export function PaletteFooter({
  entry,
  context,
  mode,
  filesAvailable,
  onMode,
  onActions,
}: PaletteFooterProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <footer className="cp-footer">
      <span className="cp-hint">
        <KeyCaps keys={["up", "down"]} />
        {t("palette.footer.navigate", "Navigate")}
      </span>
      <span className="cp-hint">
        <KeyCaps keys={["enter"]} />
        {enterLabel(entry, context, t)}
      </span>
      {context === "search" && entry && (
        <button type="button" tabIndex={-1} className="cp-hint cp-hint-button" onClick={onActions}>
          <PaletteKeys id="palette-actions" />
          {t("palette.actions.title", "Actions")}
        </button>
      )}
      {context !== "search" && (
        <span className="cp-hint">
          <KeyCaps keys={["escape"]} />
          {t("palette.footer.back", "Back")}
        </span>
      )}
      {context === "search" && (
        <span
          className="cp-modes"
          role="group"
          aria-label={t("palette.footer.mode", "Search mode")}
        >
          {PREFIX_MODES.filter((value) => value !== "files" || filesAvailable).map((value) => (
            <button
              key={value}
              type="button"
              tabIndex={-1}
              className="cp-mode"
              data-active={mode === value}
              aria-pressed={mode === value}
              onClick={() => onMode(value)}
            >
              <span className="cp-mode-prefix">{PREFIX_BY_MODE[value]}</span>
              {modeLabel(value, t)}
            </button>
          ))}
        </span>
      )}
    </footer>
  );
}
