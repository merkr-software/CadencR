import { forwardRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { AtSignIcon, ChevronRightIcon, HashIcon, SearchIcon } from "lucide-react";
import type { PaletteScope, PrefixMode } from "@/lib/command-palette/palette-query";
import { formatCombo, formatCompactCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import { ComboCap } from "./PaletteText";

export const MODE_LABEL: Record<PrefixMode, string> = {
  commands: "Commands",
  files: "Files",
  messages: "Messages",
};

export const MODE_ICON: Record<PrefixMode, ReactNode> = {
  commands: <ChevronRightIcon />,
  files: <AtSignIcon />,
  messages: <HashIcon />,
};

const SCOPE_LABEL: Record<PaletteScope, string> = {
  all: "Everything",
  project: "This project",
  active: "Active only",
};

const SCOPE_TITLE: Record<PaletteScope, string> = {
  all: "Searching every conversation, archives included (ranked lower)",
  project: "Searching this project's conversations only",
  active: "Searching active conversations only, archives left out",
};

function ScopeButton({
  scope,
  onCycle,
}: {
  scope: PaletteScope;
  onCycle: () => void;
}): ReactElement {
  const { keys } = useResolvedShortcut("palette-scope");
  return (
    <button
      type="button"
      tabIndex={-1}
      className="cp-scope"
      data-scope={scope}
      title={`${SCOPE_TITLE[scope]} (${formatCompactCombo(keys)} to change)`}
      onClick={onCycle}
    >
      {SCOPE_LABEL[scope]}
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
