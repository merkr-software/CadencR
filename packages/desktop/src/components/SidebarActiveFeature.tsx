import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { PendingGateHost } from "@/components/sidebar-gate-popover/PendingGateHost";
import { SidebarAttentionShortcuts } from "@/components/SidebarShortcuts";
import { SidebarSections } from "@/components/SidebarSections";
import { useIsHomeRoute, useRouteFeatureId, useRouteProjectId } from "@/hooks/useRouteFeatureIds";
import { useSidebarKeyboardNavigation } from "@/hooks/useSidebarKeyboardNavigation";

interface SidebarSelection {
  /** The last active conversation: remembered on non-home pages (e.g. Settings), cleared on `/`. */
  selectedFeatureId: number | null;
}

type SidebarSelectionStore = StoreApi<SidebarSelection>;

const SidebarSelectionContext = createContext<SidebarSelectionStore | null>(null);

/**
 * Holds the sidebar's selected row outside its render. Selecting a row (every
 * click on one) used to set state on the whole sidebar; the store is read only
 * by the parts that show the active conversation, through the hooks below.
 */
export function SidebarActiveFeatureProvider({ children }: { children: ReactNode }): ReactElement {
  const [store] = useState(() =>
    createStore<SidebarSelection>(() => ({ selectedFeatureId: null })),
  );
  return (
    <SidebarSelectionContext.Provider value={store}>
      <SidebarSelectionRouteSync />
      {children}
    </SidebarSelectionContext.Provider>
  );
}

/**
 * Keeps the remembered sidebar selection in sync with route navigations that
 * bypass row clicks (such as archiving or deleting the open conversation), and
 * clears it on the home screen where no conversation is open.
 */
function SidebarSelectionRouteSync(): null {
  const store = useSelectionStore();
  const routeFeatureId = useRouteFeatureId();
  const isHome = useIsHomeRoute();
  useEffect(() => {
    const current = store.getState().selectedFeatureId;
    const next = routeFeatureId ?? (isHome ? null : current);
    if (next !== current) store.setState({ selectedFeatureId: next });
  }, [isHome, routeFeatureId, store]);
  return null;
}

function useSelectionStore(): SidebarSelectionStore {
  const store = useContext(SidebarSelectionContext);
  if (!store) throw new Error("Sidebar active-feature hooks need a SidebarActiveFeatureProvider");
  return store;
}

interface SidebarActiveIds {
  activeProjectId: number | null;
  /** The conversation on screen (the route's); null on any other page. */
  routeFeatureId: number | null;
  /** The route's conversation, else the row last selected (null on the home screen). */
  effectiveFeatureId: number | null;
}

/** The sidebar's active project and conversation; re-renders only when one of them changes. */
function useSidebarActiveIds(): SidebarActiveIds {
  const activeProjectId = useRouteProjectId();
  const routeFeatureId = useRouteFeatureId();
  const isHome = useIsHomeRoute();
  const effectiveFeatureId = useStore(
    useSelectionStore(),
    (state) => routeFeatureId ?? (isHome ? null : state.selectedFeatureId),
  );
  return useMemo(
    () => ({ activeProjectId, routeFeatureId, effectiveFeatureId }),
    [activeProjectId, effectiveFeatureId, routeFeatureId],
  );
}

/** Stable: rows call it on every open, and it re-renders only what shows the selection. */
function useSelectSidebarFeature(): (featureId: number) => void {
  const store = useSelectionStore();
  return useMemo(
    () => (featureId: number) => store.setState({ selectedFeatureId: featureId }),
    [store],
  );
}

/**
 * The sections with the active row. Its own component, so a conversation
 * switch re-renders the lists that show it, not the sidebar around them.
 */
export function ActiveSidebarSections({ showsSamples }: { showsSamples: boolean }): ReactElement {
  const { activeProjectId, effectiveFeatureId } = useSidebarActiveIds();
  const select = useSelectSidebarFeature();
  return (
    <SidebarSections
      showsSamples={showsSamples}
      activeProjectId={activeProjectId}
      activeFeatureId={effectiveFeatureId}
      onSelectFeature={select}
    />
  );
}

/** The attention shortcuts with the active row; `children` keeps its identity when this re-renders. */
export function ActiveAttentionShortcuts({ children }: { children: ReactNode }): ReactElement {
  const { routeFeatureId, effectiveFeatureId } = useSidebarActiveIds();
  const select = useSelectSidebarFeature();
  return (
    <SidebarAttentionShortcuts
      activeFeatureId={effectiveFeatureId}
      openFeatureId={routeFeatureId}
      onSelectFeature={select}
    >
      {children}
    </SidebarAttentionShortcuts>
  );
}

export function ActivePendingGateHost(): ReactElement {
  const { effectiveFeatureId } = useSidebarActiveIds();
  const select = useSelectSidebarFeature();
  return <PendingGateHost activeFeatureId={effectiveFeatureId} onSelectFeature={select} />;
}

/** The sidebar's arrow-key navigation, mounted as a leaf: it reads the active row. */
export function SidebarKeyboardNavigation({
  sidebarRef,
}: {
  sidebarRef: RefObject<HTMLElement | null>;
}): null {
  const navigate = useNavigate();
  const { effectiveFeatureId } = useSidebarActiveIds();
  useSidebarKeyboardNavigation(sidebarRef, navigate, effectiveFeatureId);
  return null;
}
