import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Project } from "@/api/generated";
import type { PersistedUnifiedAgentsFilters } from "@/components/UnifiedAgentsFilterState";
import type { UnifiedAgentsFilterInputHandle } from "@/components/UnifiedAgentsDynamicFilter";
import {
  parseUnifiedAgentsFilterText,
  serializeUnifiedAgentsFilterText,
} from "@/components/UnifiedAgentsFilterLanguage";
import { dedupeTitles } from "@/components/unified-agents-filter-values";
import { stringArraysEqual } from "@/lib/utils";

interface UnifiedAgentsFilterTextState {
  filterText: string;
  commitFilterText: (nextText: string) => void;
  excludeAgent: (title: string) => void;
  setExcludedTitles: (titles: string[]) => void;
}

/** Keeps the search-box text and the parsed filter in sync, and exposes the
 *  per-card exclude action. The box freezes external re-syncs after the first
 *  manual edit, so the exclude action updates state via `commitFilterText` and
 *  also pushes the text straight into the editor via the input handle. */
export function useUnifiedAgentsFilterText(
  filters: PersistedUnifiedAgentsFilters,
  setFilters: (update: PersistedUnifiedAgentsFilters) => void,
  projects: Project[],
  inputRef: RefObject<UnifiedAgentsFilterInputHandle | null>,
): UnifiedAgentsFilterTextState {
  const serializedFilterText = useMemo(
    () => serializeUnifiedAgentsFilterText(filters, projects),
    [filters, projects],
  );
  const [filterText, setFilterText] = useState(serializedFilterText);
  const filterTextEditedRef = useRef(false);
  useEffect((): void => {
    if (filterTextEditedRef.current) return;
    setFilterText(serializedFilterText);
  }, [serializedFilterText]);
  const commitFilterText = useCallback(
    (nextText: string): void => {
      filterTextEditedRef.current = true;
      setFilterText(nextText);
      setFilters(parseUnifiedAgentsFilterText(nextText, projects));
    },
    [projects, setFilters],
  );
  const setExcludedTitles = useCallback(
    (titles: string[]): void => {
      const nextExcluded = dedupeTitles(titles);
      // dedupeTitles drops empties and case-insensitive duplicates; a no-op
      // (same set) means there's nothing to commit.
      if (stringArraysEqual(nextExcluded, filters.excludedTitles)) return;
      const nextText = serializeUnifiedAgentsFilterText(
        { ...filters, excludedTitles: nextExcluded },
        projects,
      );
      // Update the filter state, then force the (unfocused) search box to
      // show the new token — its external-value sync ignores updates once the
      // box has been edited, so the parsed filter alone wouldn't reach it.
      commitFilterText(nextText);
      inputRef.current?.setValue(nextText);
    },
    [commitFilterText, filters, inputRef, projects],
  );
  const excludeAgent = useCallback(
    (title: string): void => setExcludedTitles([...filters.excludedTitles, title]),
    [filters.excludedTitles, setExcludedTitles],
  );
  return useMemo(
    () => ({ filterText, commitFilterText, excludeAgent, setExcludedTitles }),
    [filterText, commitFilterText, excludeAgent, setExcludedTitles],
  );
}
