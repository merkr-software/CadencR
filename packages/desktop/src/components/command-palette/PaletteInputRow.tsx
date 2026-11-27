import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { forwardRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { AtSignIcon, ChevronRightIcon, HashIcon, SearchIcon } from "lucide-react";
import type { PaletteScope, PrefixMode } from "@/lib/command-palette/palette-query";
import { formatCombo, formatCompactCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import { ComboCap } from "./PaletteText";

export function modeLabel(mode: PrefixMode, t: UiTranslator): string {
  switch (mode) {
    case "commands":
      return t("palette.mode.commands", "Commands");
    case "files":
      return t("palette.mode.files", "Files");
    case "messages":
      return t("palette.mode.messages", "Messages");
  }
}

export const MODE_ICON: Record<PrefixMode, ReactNode> = {
  commands: <ChevronRightIcon />,
  files: <AtSignIcon />,
  messages: <HashIcon />,
};

function scopeCopy(scope: PaletteScope, shortcut: string, t: UiTranslator) {
  switch (scope) {
    case "all":
      return {
        label: t("palette.scope.all.label", "Everything"),
        title: t(
          "palette.scope.all.hint",
          "Searching every conversation, archives included (ranked lower) ({{shortcut}} to change)",
          { shortcut },
        ),
      };
    case "project":
      return {
        label: t("palette.scope.project.label", "This project"),
        title: t(
          "palette.scope.project.hint",
          "Searching this project's conversations only ({{shortcut}} to change)",
          { shortcut },
        ),
      };
    case "active":
      return {
        label: t("palette.scope.active.label", "Active only"),
        title: t(
          "palette.scope.active.hint",
          "Searching active conversations only, archives left out ({{shortcut}} to change)",
          { shortcut },
        ),
      };
  }
}

function ScopeButton({
  scope,
  onCycle,
}: {
  scope: PaletteScope;
  onCycle: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const { keys } = useResolvedShortcut("palette-scope");
  const { label, title } = scopeCopy(scope, formatCompactCombo(keys), t);
  return (
    <button
      type="button"
      tabIndex={-1}
      className="cp-scope"
      data-scope={scope}
      title={title}
      onClick={onCycle}
    >
      {label}
      <ComboCap keys={formatCombo(keys)} />
    </button>
  );
}

export interface PaletteInputRowProps {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  /** The mode or step chip leading the input; none in the plain search. */
  chip: { icon: ReactNode; label: string } | null;
  /** Shown only where the scope applies (conversation and message search). */
  scope: PaletteScope | null;
  onCycleScope: () => void;
}

/** The search field, led by the current mode or step, with the scope at the far end. */
export const PaletteInputRow = forwardRef<HTMLInputElement, PaletteInputRowProps>(
  function PaletteInputRow(
    { value, onValueChange, onKeyDown, placeholder, chip, scope, onCycleScope },
    ref,
  ) {
    return (
      <div className="cp-input-row">
        {chip ? (
          <span className="cp-chip">
            {chip.icon}
            <span className="cp-chip-label">{chip.label}</span>
          </span>
        ) : (
          <SearchIcon aria-hidden />
        )}
        <CommandPrimitive.Input
          ref={ref}
          value={value}
          onValueChange={onValueChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="cp-input"
          aria-label={placeholder}
        />
        {scope && <ScopeButton scope={scope} onCycle={onCycleScope} />}
      </div>
    );
  },
);
