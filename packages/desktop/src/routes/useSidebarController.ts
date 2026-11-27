import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { useSetting } from "@/hooks/useSetting";
import { useSidebarAutoCollapse } from "@/hooks/useSidebarAutoCollapse";

/** A resize emits a layout change per step; only the width it settles on is saved. */
const WIDTH_SAVE_DEBOUNCE_MS = 300;

function clampSidebarWidth(raw: string | null): number {
  const saved = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(saved)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, saved));
}

/**
 * Owns the global sidebar's width and collapse state.
 *
 * The persisted width is the single restore target. react-resizable-panels'
 * own "expand to previous size" memory lives in per-registration mutable state
 * that a Panel prop change wipes, so expanding through it could land on
 * `minSize` and then persist that. Instead the Panel's `defaultSize` is frozen
 * at mount, the stored width is applied imperatively once it loads, and every
 * expand resizes back to it. Layout events are ignored until that first load
 * has been applied, so the mount-time `onLayoutChanged` cannot overwrite the
 * stored width with the default. A narrow window can fold the sidebar on top
 * of the stored state (A8, never persisted).
 *
 * The phone layout has no sidebar panel. When the layout flips back, the panel
 * mounts at the state it will show (collapsed at 0px when the desktop state is
 * collapsed, so no expanded frame paints) and is driven only once it is ready
 * (`useSidebarPanelReady`).
 *
 * A docked phone sidebar (`useDockedSidebar`: a foldable on its side) has its
 * own collapsed state, the rail, kept apart from the drawer's and from the
 * desktop's persisted one: it starts expanded and follows the user's toggles
 * for the session.
 */
export function useSidebarController(isMobile: boolean, docked = false) {
  const leftWidth = useSetting("sidebar_left_width");
  const collapsedSetting = useSetting("sidebar_collapsed");
  const phone = usePhoneSidebarState(docked);
  const setPhoneCollapsed = phone.setCollapsed;
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<PanelImperativeHandle>(null);
  const autoCollapse = useSidebarAutoCollapse(isMobile);
  const desktopCollapsed = collapsedSetting.value === "true" || autoCollapse.autoCollapsed;
  const collapsed = isMobile ? phone.collapsed : desktopCollapsed;
  const storedWidth = clampSidebarWidth(leftWidth.value);
  const defaultLeftSize = usePanelMountSize(isMobile, desktopCollapsed ? 0 : storedWidth);
  const widthAppliedRef = useRef(false);
  const {
    ready: panelSettled,
    readyRef: panelReadyRef,
    onPanelResize,
  } = useSidebarPanelReady(isMobile);

  const restoreWidth = useCallback(
    (panel: PanelImperativeHandle): void => {
      panel.resize(`${storedWidth}px`);
    },
    [storedWidth],
  );

  const setCollapsed = useCallback(
    (nextCollapsed: boolean): void => {
      if (isMobile) setPhoneCollapsed(nextCollapsed);
      else {
        // Resize while the Panel is still collapsible; the next render makes
        // it non-collapsible so pointer and keyboard resizing clamp at minSize.
        // Not ready yet (the layout just flipped back): the collapse effect
        // applies the width once it is.
        const panel = panelReadyRef.current ? sidebarPanelRef.current : null;
        if (!nextCollapsed && panel) restoreWidth(panel);
        if (autoCollapse.onUserToggle(nextCollapsed)) return;
        void collapsedSetting.setValue(nextCollapsed ? "true" : "false");
      }
    },
    [autoCollapse, collapsedSetting, isMobile, panelReadyRef, restoreWidth, setPhoneCollapsed],
  );
  const closeMobileDrawer = phone.closeDrawer;
  useCollapsedAttribute(collapsed);

  // The panel comes back with its mount-time default after the phone layout:
  // ignore its layout events until the stored width is applied again.
  useEffect(() => {
    if (isMobile) widthAppliedRef.current = false;
  }, [isMobile]);
  useEffect(() => {
    if (isMobile || !panelSettled || !leftWidth.isFetched || !collapsedSetting.isFetched) return;
    if (widthAppliedRef.current) return;
    widthAppliedRef.current = true;
    const panel = sidebarPanelRef.current;
    if (panel && !collapsed) restoreWidth(panel);
  }, [
    collapsed,
    collapsedSetting.isFetched,
    isMobile,
    leftWidth.isFetched,
    panelSettled,
    restoreWidth,
  ]);

  // A changed `collapsible` reaches the Panel one render later, so the
  // `collapse()` riding the same commit no-ops and the sidebar keeps its width.
  // Retry once it lands; re-setting the same flag bails out instead of looping.
  const [retryCollapse, setRetryCollapse] = useState(false);
  useEffect(() => {
    if (isMobile || !panelSettled || !collapsedSetting.isFetched) return;
    const panel = sidebarPanelRef.current;
    if (!panel || panel.isCollapsed() === collapsed) {
      setRetryCollapse(false);
      return;
    }
    if (collapsed) panel.collapse();
    else restoreWidth(panel);
    setRetryCollapse(collapsed && !panel.isCollapsed());
  }, [collapsed, collapsedSetting.isFetched, isMobile, panelSettled, restoreWidth, retryCollapse]);
  useEffect(() => {
    leftSidebarRef.current?.focus();
  }, []);

  const handleLayoutChanged = useSidebarWidthWrites({
    panelRef: sidebarPanelRef,
    panelReadyRef,
    widthAppliedRef,
    storedWidth,
    setStoredWidth: leftWidth.setValue,
    restoreWidth,
  });

  return useMemo(
    () => ({
      closeMobileDrawer,
      collapsed,
      defaultLeftSize,
      handleLayoutChanged,
      leftSidebarRef,
      onSidebarResize: onPanelResize,
      setCollapsed,
      sidebarPanelRef,
    }),
    [
      closeMobileDrawer,
      collapsed,
      defaultLeftSize,
      handleLayoutChanged,
      onPanelResize,
      setCollapsed,
    ],
  );
}

export type SidebarController = ReturnType<typeof useSidebarController>;

/** Mirrors the sidebar's collapsed state on `<html data-sidebar-collapsed>` for the stylesheets. */
function useCollapsedAttribute(collapsed: boolean): void {
  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = collapsed ? "true" : "false";
  }, [collapsed]);
}

interface PhoneSidebarState {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Closes the drawer (a navigation); leaves a docked sidebar as it is. */
  closeDrawer: () => void;
}

/**
 * The phone layout's collapsed states: the drawer's (closed = collapsed) and,
 * docked, the rail's. Two states, so turning the foldable back upright does
 * not open the drawer because the docked sidebar was expanded.
 */
function usePhoneSidebarState(docked: boolean): PhoneSidebarState {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dockedRail, setDockedRail] = useState(false);
  const setCollapsed = useCallback(
    (next: boolean): void => {
      if (docked) setDockedRail(next);
      else setDrawerOpen(!next);
    },
    [docked],
  );
  const closeDrawer = useCallback((): void => setDrawerOpen(false), []);
  const collapsed = docked ? dockedRail : !drawerOpen;
  return useMemo(
    () => ({ collapsed, setCollapsed, closeDrawer }),
    [closeDrawer, collapsed, setCollapsed],
  );
}

/**
 * The sidebar panel's `defaultSize`, frozen while it is mounted (a Panel prop
 * change wipes its registration) and following the desktop state while the
 * phone layout has no panel, so it mounts at what it will show: `0px`
 * (collapsed) or the stored width.
 */
function usePanelMountSize(isMobile: boolean, width: number): string {
  const next = `${width}px`;
  const [size, setSize] = useState(next);
  if (isMobile && size !== next) setSize(next);
  return size;
}

interface SidebarPanelReady {
  /** Re-renders when the panel becomes ready or goes away. */
  ready: boolean;
  /** The same, for handlers and promise callbacks. */
  readyRef: RefObject<boolean>;
  /** The sidebar Panel's `onResize`. */
  onPanelResize: () => void;
}

/**
 * Whether the sidebar panel can be driven (`collapse`, `resize`,
 * `isCollapsed`). The phone layout has no sidebar panel: when the layout flips
 * back, the panel joins a panel group that stayed mounted (`AppShell` keeps
 * one tree), and its handle throws until the group has derived its
 * constraints. The group does that in the same observer callback that reports
 * the panel's first size, so the panel's first `onResize` is the signal.
 */
function useSidebarPanelReady(isMobile: boolean): SidebarPanelReady {
  const [ready, setReady] = useState(!isMobile);
  const readyRef = useRef(ready);
  if (isMobile && ready) setReady(false);
  // In the commit that unmounts the panel, before any promise callback runs.
  useLayoutEffect(() => {
    if (isMobile) readyRef.current = false;
  }, [isMobile]);
  const onPanelResize = useCallback((): void => {
    if (readyRef.current) return;
    readyRef.current = true;
    setReady(true);
  }, []);
  return { ready: ready && !isMobile, readyRef, onPanelResize };
}

interface SidebarWidthWrites {
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelReadyRef: RefObject<boolean>;
  widthAppliedRef: RefObject<boolean>;
  storedWidth: number;
  setStoredWidth: (width: string) => Promise<boolean>;
  restoreWidth: (panel: PanelImperativeHandle) => void;
}

/**
 * Saves the width a resize settles on. The panel follows the drag itself; that
 * is the only preview. The stored width moves once the backend confirms the new
 * one, and a failed write puts the panel back at the width it still holds.
 */
function useSidebarWidthWrites({
  panelRef,
  panelReadyRef,
  widthAppliedRef,
  storedWidth,
  setStoredWidth,
  restoreWidth,
}: SidebarWidthWrites): () => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingWidthRef = useRef<number | null>(null);
  // Read when a write fails, after the render that may have changed the width.
  const restoreWidthRef = useRef(restoreWidth);
  restoreWidthRef.current = restoreWidth;

  useEffect(
    () => (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback((): void => {
    if (!widthAppliedRef.current) return;
    const size = panelRef.current?.getSize();
    if (!size || size.inPixels < 50) return;
    const width = Math.round(size.inPixels);
    // Percent-based layout rounds a restored width by a pixel; persisting that
    // would shrink the sidebar a little on every launch.
    if (Math.abs(width - storedWidth) <= 1) {
      sendingWidthRef.current = null;
      return;
    }
    // The layout can report that width again while it's being written, or
    // while a failed write animates the panel back: send it once.
    if (width === sendingWidthRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendingWidthRef.current = width;
      void setStoredWidth(String(width)).then((saved) => {
        if (saved) sendingWidthRef.current = null;
        // The layout may have flipped to the phone one meanwhile: no panel to put back.
        const panel = panelReadyRef.current ? panelRef.current : null;
        if (!saved && panel && !panel.isCollapsed()) restoreWidthRef.current(panel);
      });
    }, WIDTH_SAVE_DEBOUNCE_MS);
  }, [panelReadyRef, panelRef, setStoredWidth, storedWidth, widthAppliedRef]);
}
