import {
  createRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";

import { animationsDisabled } from "@/lib/animations/animations-disabled";
import { isPluginTabKind, type LayoutLeaf, type LayoutSplit } from "@/stores/feature-layout-schema";
import { popChildIndex } from "@/stores/feature-layout-tree";

/**
 * Size of a folded pop pane (its header) until the pane has measured the one
 * its theme draws.
 */
const DEFAULT_FOLDED_PX = 40;

/** Length of a pop pane's slide, matching `[data-pop-motion]` in index.css. */
const POP_MOTION_MS = 220;

/**
 * Off by more than this many pixels, a folded panel is folded again. Under a
 * device pixel: a window resize scales the folded panel with the group, and
 * what it keeps shows as the card lifting off the edge its neighbours line up on.
 */
const FOLDED_SLACK_PX = 0.25;

/**
 * Smallest share (%) a pop pane opens at: dragged down to its header while
 * open, it would otherwise reopen looking folded.
 */
const MIN_OPEN_SHARE = 10;

export interface PopPanel {
  /** The child of the split that pops, if any. */
  index: 0 | 1 | null;
  /** The pane is not focused: its panel is (or is sliding to) its header size. */
  folded: boolean;
  /** Folded and done sliding: the pane renders as its header. */
  collapsed: boolean;
  /**
   * While the pane slides in or out: its open size in pixels. The pane is laid
   * out at that size and clipped by the moving panel, so its content (a
   * terminal, an editor) never reflows frame by frame.
   */
  slidingPx: number | null;
  /** The folded size, as a panel size (`"40px"`). */
  foldedSize: string;
  /** Takes the folded header's measured size (see `useReportFoldedSize`). */
  onFoldedSize: (px: number) => void;
  /** Handles of the split's two panels, by child index. */
  panelRefs: readonly [
    RefObject<PanelImperativeHandle | null>,
    RefObject<PanelImperativeHandle | null>,
  ];
  /** The split's two panel elements, by child index (see `onResize`). */
  elementRefs: readonly [RefObject<HTMLDivElement | null>, RefObject<HTMLDivElement | null>];
  /** Re-folds the panel whenever the group lays it out at another size. */
  onResize: (size: PanelSize) => void;
}

/**
 * An element's length along a split's axis, to the fraction of a pixel zoom
 * lays out (`offsetHeight` rounds it).
 */
export function axisLength(el: Element, horizontal: boolean): number {
  const rect = el.getBoundingClientRect();
  return horizontal ? rect.width : rect.height;
}

/** The pane's open size in pixels, from the panel's size before it toggles. */
function openPixels(before: PanelSize, folded: boolean, share: number): number {
  if (folded) return before.inPixels;
  if (before.asPercentage <= 0) return 0;
  return (before.inPixels / before.asPercentage) * share;
}

/**
 * Native views (the browser, custom tabs) are placed by bounds, not clipped by
 * the panel: a pane showing one opens and folds without sliding.
 */
function slides(leaf: LayoutLeaf): boolean {
  return leaf.activeTabId !== "browser" && !isPluginTabKind(leaf.activeTabId);
}

/**
 * Drives the popping child of `split`: folded to its header unless it is
 * the focused pane, else at its stored share. The panel is resized in place
 * (never remounted) so the pane's tab content keeps its state. The group lays
 * panels out again on its own (its first measure, a window resize scaling
 * relative sizes), so a folded panel is re-folded from `onResize` too.
 *
 * With animations on, opening and folding slide: the group transitions its
 * panels' weights (`data-pop-motion`) while the pane holds its open size.
 */
export function usePopPanel(split: LayoutSplit, focusedPaneId: string): PopPanel {
  const index = popChildIndex(split);
  const child = index === null ? null : split.children[index];
  const leaf = child?.type === "leaf" ? child : null;
  const folded = leaf !== null && leaf.id !== focusedPaneId;
  const canSlide = leaf !== null && slides(leaf);
  const horizontal = split.orientation === "horizontal";
  const share = index === null ? null : Math.max(split.sizes?.[index] ?? 50, MIN_OPEN_SHARE);
  // One per child: a pane that stops popping is resized back as well.
  const [panelRefs] = useState(
    () => [createRef<PanelImperativeHandle>(), createRef<PanelImperativeHandle>()] as const,
  );
  // Also one per child: a panel attaches its element once, at mount, and
  // either child may pop later.
  const [elementRefs] = useState(
    () => [createRef<HTMLDivElement>(), createRef<HTMLDivElement>()] as const,
  );
  // The child that popped at the last layout, and whether it was folded.
  const popped = useRef<{ index: 0 | 1; folded: boolean } | null>(null);
  // The running slide's open size, which the pane holds.
  const [slidingPx, setSlidingPx] = useState<number | null>(null);
  // The same, for effects and callbacks between renders.
  const slideRef = useRef<number | null>(null);
  // Ends the running slide once its transition has run.
  const slideEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [foldedPx, setFoldedPx] = useState(DEFAULT_FOLDED_PX);
  const foldedSize = `${foldedPx}px`;
  const onFoldedSize = useCallback((px: number): void => {
    // Fractional, as laid out (zoom makes it so): rounding up to whole pixels
    // would leave the card short of the panel's far edge.
    if (px > 0) setFoldedPx(Math.ceil(px * 100) / 100);
  }, []);

  const endSlide = useCallback((): void => {
    clearTimeout(slideEnd.current);
    slideRef.current = null;
    setSlidingPx(null);
  }, []);
  // Timed from the resize that starts the transition, not from the toggle.
  const endSlideAfterMotion = useCallback((): void => {
    clearTimeout(slideEnd.current);
    slideEnd.current = setTimeout(endSlide, POP_MOTION_MS);
  }, [endSlide]);
  useEffect(() => () => clearTimeout(slideEnd.current), []);

  useLayoutEffect(() => {
    const last = popped.current;
    popped.current = index === null ? null : { index, folded };
    // A pane that stops popping while folded (unpinned, or its sibling
    // flagged instead) opens at its share again — so does one stopping
    // mid-slide, whose deferred resize the cleanup just cancelled.
    if (last && last.index !== index && (last.folded || slideRef.current !== null)) {
      panelRefs[last.index].current?.resize(`${split.sizes?.[last.index] ?? 50}%`);
    }
    const panel = index === null ? null : panelRefs[index].current;
    if (share === null || !panel) {
      if (slideRef.current !== null) endSlide();
      return;
    }
    // A native view turned up mid-slide: it is not clipped, so stop holding.
    if (!canSlide && slideRef.current !== null) endSlide();
    const toggled = last?.index === index && last.folded !== folded;
    const animate = toggled && canSlide && !animationsDisabled();
    // Reversed mid-slide, the panel measures mid-transition: keep the open
    // size the running slide holds.
    const openPx = animate ? (slideRef.current ?? openPixels(panel.getSize(), folded, share)) : 0;
    const target = folded ? `${foldedPx}px` : `${share}%`;
    if (openPx <= foldedPx) {
      panel.resize(target);
      // A slide whose deferred resize this re-run cancelled still has to end.
      if (slideRef.current !== null) endSlideAfterMotion();
      return;
    }
    // Set before paint: the slide's first frame already holds the pane. A
    // slide reversed midway waits for its new resize to time its end.
    slideRef.current = Math.round(openPx);
    setSlidingPx(slideRef.current);
    clearTimeout(slideEnd.current);
    // Move two frames later, not in this commit. A focus change re-renders
    // whatever follows the focused tab, and a transition is timed from its
    // frame's vsync: the first frame after that work still carries the vsync
    // from before it, so a transition started there (or here) is mostly spent
    // when it first paints and the pane snaps. The held pane shows no change
    // meanwhile. Re-run first (focus flips back), the effect resizes itself.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        panel.resize(target);
        endSlideAfterMotion();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    index,
    folded,
    share,
    foldedPx,
    canSlide,
    panelRefs,
    split.sizes,
    endSlide,
    endSlideAfterMotion,
  ]);

  const onResize = useCallback(
    (size: PanelSize): void => {
      // A slide reports every frame of its transition; it ends folded anyway.
      if (!folded || slideRef.current !== null) return;
      if (index === null) return;
      // The group reports whole pixels (`offsetHeight`): read the fraction too.
      const el = elementRefs[index].current;
      const px = el ? axisLength(el, horizontal) : size.inPixels;
      if (Math.abs(px - foldedPx) <= FOLDED_SLACK_PX) return;
      panelRefs[index].current?.resize(`${foldedPx}px`);
    },
    [index, folded, foldedPx, horizontal, panelRefs, elementRefs],
  );
  return {
    index,
    folded,
    collapsed: folded && slidingPx === null,
    slidingPx,
    foldedSize,
    onFoldedSize,
    panelRefs,
    elementRefs,
    onResize,
  };
}
