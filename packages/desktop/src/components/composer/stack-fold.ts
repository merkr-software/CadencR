import {
  createContext,
  type FocusEvent,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * Foldable sections from which the stack folds to one line each, but one: a
 * phone has the room for one section beside the prompt, a desktop for two.
 */
const FOLD_AT = { mobile: 2, desktop: 3 } as const;

interface StackFold {
  /** Too many sections: all but the open one show their one-line summary. */
  folding: boolean;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  register: (id: string, opensOnArrival: boolean) => () => void;
}

export const StackFoldContext = createContext<StackFold | null>(null);

interface Entry {
  id: string;
  opensOnArrival: boolean;
}

/** The stack's fold state: which foldable sections are up, which one is open. */
export function useStackFoldState(): StackFold {
  const mobile = useIsMobile();
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Mirrors `entries` for the unregister below, which runs outside a render.
  const entriesRef = useRef<readonly Entry[]>([]);
  const register = useCallback((id: string, opensOnArrival: boolean) => {
    entriesRef.current = [...entriesRef.current, { id, opensOnArrival }];
    setEntries(entriesRef.current);
    if (opensOnArrival) setOpenId(id);
    return () => {
      entriesRef.current = entriesRef.current.filter((entry) => entry.id !== id);
      setEntries(entriesRef.current);
      // The open one left: the latest arrival that opens takes its place.
      const next = entriesRef.current.findLast((entry) => entry.opensOnArrival)?.id ?? null;
      setOpenId((current) => (current === id ? next : current));
    };
  }, []);
  const folding = entries.length >= (mobile ? FOLD_AT.mobile : FOLD_AT.desktop);
  return useMemo(() => ({ folding, openId, setOpenId, register }), [folding, openId, register]);
}

/** One section's place in the fold. */
export interface SectionFold {
  /** The stack folds and this section takes part. */
  folding: boolean;
  /** Shown as its one-line summary. */
  folded: boolean;
  toggle: () => void;
}

/**
 * Registers a section in the fold. Only a section with a one-line summary
 * folds; the rest (a deferred request, a draft's helper) always show whole.
 */
export function useSectionFold(foldable: boolean, opensOnArrival: boolean): SectionFold {
  const stack = useContext(StackFoldContext);
  const id = useId();
  const register = stack?.register;
  // Before paint: a crowded stack never flashes its sections whole.
  useLayoutEffect(() => {
    if (!register || !foldable) return;
    return register(id, opensOnArrival);
  }, [foldable, id, opensOnArrival, register]);
  const folding = (stack?.folding ?? false) && foldable;
  const open = stack?.openId === id;
  const setOpenId = stack?.setOpenId;
  const toggle = useCallback(() => setOpenId?.(open ? null : id), [id, open, setOpenId]);
  return useMemo(() => ({ folding, folded: folding && !open, toggle }), [folding, open, toggle]);
}

/** Marks a section's fold toggle: the folded line, or the open header's chevron. */
const FOLD_TOGGLE_ATTR = "data-stack-fold-toggle";

/**
 * A section's fold as shown. It stays whole while it holds focus (a queued
 * message being edited, a control reached by Tab), so a section arriving
 * never folds away what the user is working in. Pressing a toggle unmounts
 * it, so focus moves to the other one.
 */
export function useShownFold(fold: SectionFold) {
  const sectionRef = useRef<HTMLElement>(null);
  const [holdsFocus, setHoldsFocus] = useState(false);
  const toggledRef = useRef(false);
  const folded = fold.folded && !holdsFocus;
  useLayoutEffect(() => {
    if (!toggledRef.current) return;
    toggledRef.current = false;
    sectionRef.current?.querySelector<HTMLElement>(`[${FOLD_TOGGLE_ATTR}]`)?.focus();
  }, [folded]);
  const { toggle: toggleOpen, folded: foldedInStack } = fold;
  const toggle = useCallback(() => {
    toggledRef.current = true;
    setHoldsFocus(false);
    // Whole only for the focus it held: letting go of it folds it.
    if (!(foldedInStack && holdsFocus)) toggleOpen();
  }, [foldedInStack, holdsFocus, toggleOpen]);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    setHoldsFocus(!(event.target as Element).closest(`[${FOLD_TOGGLE_ATTR}]`));
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoldsFocus(false);
  }, []);
  return { sectionRef, folded, toggle, onFocus, onBlur };
}
