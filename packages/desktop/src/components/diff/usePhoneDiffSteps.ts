import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChangedFile } from "@/api/generated";
import type { ReviewNavigationTarget } from "@/lib/pr-review-threads";
import type { GitFileActionEntry } from "./gitFileActions";
import type { GitNavigationAdapter, GitNavigationAdapterRegistrar } from "./gitNavigation";
import type { PhoneDiffListScrollTarget } from "./PhoneDiffFileList";

/**
 * Review targets a phone Git list has already opened. A target is shown once:
 * the list is remounted on every view switch, and the PR view keeps the same
 * target active, so without this Back and a view switch would open its file
 * again. A newly picked thread is a new target.
 */
const shownReviewTargets = new WeakSet<ReviewNavigationTarget>();

export interface PhoneDiffSteps {
  /** The file on screen, if any: always one of the list's files. */
  file: ChangedFile | undefined;
  index: number;
  /** Where the list opens on Back. */
  scrollTarget: PhoneDiffListScrollTarget;
  open: (path: string, scrollTop: number) => void;
  /** Previous or next file; `false` at either end or on the list. */
  step: (offset: -1 | 1) => boolean;
  /** Back to the list; `false` when already there. */
  back: () => boolean;
}

/**
 * The phone Git diff's two steps: the list, or one file of it. A file that
 * leaves the list (committed, discarded) sends the step back to the list,
 * and does not come back with the file. A review thread picked elsewhere
 * opens its file, once. Stepping moves the list's scroll target along, so
 * Back shows the file last on screen.
 */
export function usePhoneDiffSteps(
  ordered: readonly ChangedFile[],
  reviewTarget: ReviewNavigationTarget | null | undefined,
): PhoneDiffSteps {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<PhoneDiffListScrollTarget>({ top: 0 });
  const index = openPath === null ? -1 : ordered.findIndex((file) => file.file === openPath);
  const file = index >= 0 ? ordered[index] : undefined;

  useEffect(() => {
    if (openPath !== null && index < 0) setOpenPath(null);
  }, [index, openPath]);

  useEffect(() => {
    if (!reviewTarget || shownReviewTargets.has(reviewTarget)) return;
    const targetIndex = ordered.findIndex((entry) => entry.file === reviewTarget.filePath);
    if (targetIndex < 0) return;
    shownReviewTargets.add(reviewTarget);
    setOpenPath(reviewTarget.filePath);
    setScrollTarget({ index: targetIndex });
  }, [ordered, reviewTarget]);

  const open = useCallback((path: string, scrollTop: number) => {
    setScrollTarget({ top: scrollTop });
    setOpenPath(path);
  }, []);
  const step = useCallback(
    (offset: -1 | 1): boolean => {
      const next = index < 0 ? undefined : ordered[index + offset];
      if (!next) return false;
      setOpenPath(next.file);
      setScrollTarget({ index: index + offset });
      return true;
    },
    [index, ordered],
  );
  const back = useCallback((): boolean => {
    if (openPath === null) return false;
    setOpenPath(null);
    return true;
  }, [openPath]);
  return useMemo(
    () => ({ file, index, scrollTarget, open, step, back }),
    [back, file, index, open, scrollTarget, step],
  );
}

interface PhoneNavigationState {
  steps: PhoneDiffSteps;
  /** The open file's actions (`gitFileActions`); empty on the list. */
  entries: readonly GitFileActionEntry[];
  viewed: { isViewed: boolean; pending: boolean; mark: () => void; unmark: () => void } | undefined;
  diffAreaRef: RefObject<HTMLDivElement | null>;
}

function runEntry(state: PhoneNavigationState, id: "stage" | "reset" | "open-in-editor"): boolean {
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!state.steps.file || entry?.kind !== "action" || entry.disabled) return false;
  entry.run();
  return true;
}

/**
 * The Git keyboard commands on the phone layout, for the file on screen
 * only: move is the previous / next file of the step, back returns to the
 * list, and stage, unstage, viewed and open in editor act on the open file.
 * On the list nothing is selected, so they do nothing there.
 */
export function usePhoneNavigationAdapter(
  register: GitNavigationAdapterRegistrar | undefined,
  state: PhoneNavigationState,
): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const adapter = useMemo<GitNavigationAdapter>(
    () => ({
      getActiveItem: () => stateRef.current.steps.file?.file ?? null,
      moveSelection: (offset) => stateRef.current.steps.step(offset),
      open: () => false,
      back: () => stateRef.current.steps.back(),
      toggleViewed: () => {
        const { steps, viewed } = stateRef.current;
        if (!steps.file || !viewed || viewed.pending) return false;
        if (viewed.isViewed) viewed.unmark();
        else viewed.mark();
        return true;
      },
      stage: () => runEntry(stateRef.current, "stage"),
      reset: () => runEntry(stateRef.current, "reset"),
      openInEditor: () => runEntry(stateRef.current, "open-in-editor"),
      scrollHalfPage: (direction) => {
        const area = stateRef.current.diffAreaRef.current;
        if (!stateRef.current.steps.file || !area) return false;
        area.scrollBy({ top: direction * (area.clientHeight / 2), behavior: "smooth" });
        return true;
      },
    }),
    [],
  );
  useEffect(() => register?.(adapter), [adapter, register]);
}
