import { memo, type ReactElement } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Loader2Icon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { PaletteEntry, PaletteSection } from "@/lib/command-palette/palette-types";
import { PaletteRow } from "./PaletteRows";

const SKELETON_ROWS = 4;

function SectionState({ section }: { section: PaletteSection }): ReactElement | null {
  if (section.error) {
    return (
      <div className="cp-section-note" data-tone="error" role="alert">
        {section.error}
      </div>
    );
  }
  if (!section.loading || section.entries.length > 0) return null;
  if (section.loading === "skeleton") {
    return (
      <>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="cp-skeleton-row" aria-hidden>
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3" style={{ width: `${62 - index * 9}%` }} />
          </div>
        ))}
      </>
    );
  }
  return (
    <div className="cp-section-note">
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      Searching…
    </div>
  );
}

export interface PaletteResultsProps {
  sections: readonly PaletteSection[];
  projectNames: ReadonlyMap<number, string>;
  now: number;
  onPick: (entry: PaletteEntry) => void;
  /** Rows offered when nothing matched (search messages, widen the scope…). */
  fallback: readonly PaletteEntry[];
  emptyTitle: string;
  emptyHint: string;
}

/**
 * The result groups. A group whose request is still running keeps its place
 * with a skeleton or a spinner line, so late answers never shift the rows the
 * user is aiming at; an error stays inline where its rows would be.
 */
export const PaletteResults = memo(function PaletteResults({
  sections,
  projectNames,
  now,
  onPick,
  fallback,
  emptyTitle,
  emptyHint,
}: PaletteResultsProps): ReactElement {
  const visible = sections.filter(
    (section) => section.entries.length > 0 || section.loading || section.error,
  );
  return (
    <CommandPrimitive.List className="cp-list" label="Results">
      {visible.length === 0 && (
        <>
          <div className="cp-empty">
            <span className="cp-empty-title">{emptyTitle}</span>
            <span className="cp-empty-hint">{emptyHint}</span>
          </div>
          {fallback.length > 0 && (
            <CommandPrimitive.Group className="cp-group" heading="Try">
              {fallback.map((entry) => (
                <PaletteRow
                  key={entry.key}
                  entry={entry}
                  projectName={undefined}
                  now={now}
                  onPick={onPick}
                />
              ))}
            </CommandPrimitive.Group>
          )}
        </>
      )}
      {visible.map((section) => (
        <CommandPrimitive.Group
          key={section.id}
          className="cp-group"
          heading={
            <>
              <span>{section.title}</span>
              {section.entries.length > 0 && (
                <span className="cp-group-count">{section.entries.length}</span>
              )}
            </>
          }
        >
          <SectionState section={section} />
          {section.entries.map((entry) => (
            <PaletteRow
              key={entry.key}
              entry={entry}
              projectName={entryProjectName(entry, projectNames)}
              now={now}
              onPick={onPick}
            />
          ))}
        </CommandPrimitive.Group>
      ))}
    </CommandPrimitive.List>
  );
});

function entryProjectName(
  entry: PaletteEntry,
  projectNames: ReadonlyMap<number, string>,
): string | undefined {
  if (entry.kind === "conversation") return projectNames.get(entry.conversation.project_id);
  if (entry.kind === "message") return projectNames.get(entry.hit.project_id);
  return undefined;
}
