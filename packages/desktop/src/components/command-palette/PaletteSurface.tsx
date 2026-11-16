import { useRef, type ReactElement } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { PaletteFooter } from "./PaletteFooter";
import { PaletteInputRow } from "./PaletteInputRow";
import { PalettePreview } from "./PalettePreview";
import { PaletteResults } from "./PaletteResults";
import { usePaletteView, type PaletteSurfaceProps } from "./usePaletteView";

export type { PaletteSurfaceProps } from "./usePaletteView";

/** The palette's body: input, results beside the selection's preview, footer. */
export function PaletteSurface(props: PaletteSurfaceProps): ReactElement {
  const view = usePaletteView(props);
  const { flow, sources, now, sections, selected } = view;
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <CommandPrimitive
      shouldFilter={false}
      loop
      value={view.selectedKey}
      onValueChange={flow.setSelectedKey}
      label="Command palette"
    >
      <PaletteInputRow
        ref={inputRef}
        value={flow.text}
        onValueChange={flow.setText}
        onKeyDown={view.onKeyDown}
        placeholder={view.placeholder}
        chip={view.chip}
        scope={view.scope}
        onCycleScope={() => flow.cycleScope(props.activeProjectId != null)}
      />
      <div className="cp-body">
        <PaletteResults
          sections={sections}
          projectNames={sources.projectNames}
          now={now}
          onPick={flow.pick}
          fallback={view.fallback}
          emptyTitle={view.empty.title}
          emptyHint={view.empty.hint}
        />
        <aside className="cp-preview" aria-label="Preview">
          <PalettePreview
            entry={flow.view.kind === "actions" ? flow.view.entry : selected}
            projectNames={sources.projectNames}
            activeProjectId={props.activeProjectId}
            activeFeatureId={props.activeFeatureId}
            now={now}
          />
        </aside>
      </div>
      <PaletteFooter
        entry={selected}
        context={flow.view.kind}
        mode={flow.mode}
        filesAvailable={props.activeFeatureId != null}
        onMode={(mode) => {
          flow.setMode(flow.mode === mode ? "all" : mode, flow.text);
          inputRef.current?.focus();
        }}
        onActions={() =>
          selected && flow.push({ kind: "actions", entry: selected, query: flow.text.trim() })
        }
      />
    </CommandPrimitive>
  );
}
