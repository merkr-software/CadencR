import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  desktopBridge,
  type BrowserStateSnapshot,
  type BrowserTabMetadata,
} from "@/lib/desktop-bridge";
import { PROFILE_ID, type CookieMode } from "@/lib/browser-settings";
import { useBrowserStore } from "@/stores/browser-store";
import { useBrowserViewportBounds } from "../useBrowserViewportBounds";
import { reportBrowserError, showBrowserError } from "./browser-errors";
import { useBrowserFind, type BrowserFindModel } from "./useBrowserFind";
import { useBrowserPageActions, type BrowserPageActions } from "./useBrowserPageActions";
import { useBrowserResponsive, type BrowserResponsiveModel } from "./useBrowserResponsive";
import {
  useBrowserTabOrganization,
  type BrowserTabOrganization,
} from "./useBrowserTabOrganization";

const EMPTY_STATE: BrowserStateSnapshot = {
  tabs: [],
  activeTabId: null,
  error: null,
};

export interface BrowserWorkspaceModel extends BrowserPageActions, BrowserTabOrganization {
  state: BrowserStateSnapshot;
  urlInput: string;
  defaultMode: CookieMode;
  creatingMode: CookieMode | null;
  loading: boolean;
  pending: boolean;
  activeTab: BrowserTabMetadata | null;
  urlInputRef: React.RefObject<HTMLInputElement | null>;
  viewportRef: (node: HTMLDivElement | null) => void;
  find: BrowserFindModel;
  responsive: BrowserResponsiveModel;
  setUrlInput: (value: string) => void;
  setUrlEditing: (editing: boolean) => void;
  clearError: () => void;
  focusUrlBar: () => void;
  navigate: (url: string) => Promise<void>;
  newTab: (mode?: CookieMode) => Promise<void>;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeActiveTab: () => void;
  runForActive: (action: (tab: BrowserTabMetadata) => Promise<void>) => Promise<void>;
}

// A blank tab shows an empty, focusable address bar rather than "about:blank".
function displayUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

type BrowserTabActions = Pick<
  BrowserWorkspaceModel,
  "navigate" | "newTab" | "activateTab" | "closeTab" | "closeActiveTab"
>;

function useBrowserTabActions(
  activeTab: BrowserTabMetadata | null,
  defaultMode: CookieMode,
  scopeId: number,
  runForActive: BrowserWorkspaceModel["runForActive"],
  setUrlInput: (url: string) => void,
  focusUrlBar: () => void,
  setDismissedError: (error: string | null) => void,
  setCreatingMode: (mode: CookieMode | null) => void,
): BrowserTabActions {
  const creatingRef = useRef(false);
  const createTab = useCallback(
    async (url: string | undefined, mode: CookieMode): Promise<boolean> => {
      if (creatingRef.current) return false;
      creatingRef.current = true;
      setCreatingMode(mode);
      try {
        await desktopBridge.createBrowserTab(url, PROFILE_ID[mode], scopeId);
        return true;
      } catch (error) {
        showBrowserError(error, "Could not open a new tab");
        return false;
      } finally {
        creatingRef.current = false;
        setCreatingMode(null);
      }
    },
    [scopeId, setCreatingMode],
  );
  const navigate = useCallback(
    async (url: string): Promise<void> => {
      setDismissedError(null);
      if (!activeTab) {
        await createTab(url, defaultMode);
        return;
      }
      await runForActive((tab) =>
        desktopBridge.navigateBrowserTab(tab.id, url).then(() => undefined),
      );
    },
    [activeTab, createTab, defaultMode, runForActive, setDismissedError],
  );
  const newTab = useCallback(
    async (mode: CookieMode = defaultMode): Promise<void> => {
      if (await createTab(undefined, mode)) {
        setUrlInput("");
        requestAnimationFrame(focusUrlBar);
      }
    },
    [createTab, defaultMode, focusUrlBar, setUrlInput],
  );
  const activateTab = useCallback(
    (tabId: string): void => void desktopBridge.activateBrowserTab(tabId).catch(reportBrowserError),
    [],
  );
  const closeTab = useCallback(
    (tabId: string): void => void desktopBridge.closeBrowserTab(tabId).catch(reportBrowserError),
    [],
  );
  const closeActiveTab = useCallback((): void => {
    if (activeTab) closeTab(activeTab.id);
  }, [activeTab, closeTab]);
  return useMemo(
    () => ({ navigate, newTab, activateTab, closeTab, closeActiveTab }),
    [activateTab, closeActiveTab, closeTab, navigate, newTab],
  );
}

export function useBrowserWorkspaceModel(
  defaultMode: CookieMode,
  scopeId: number,
): BrowserWorkspaceModel {
  const [state, setState] = useState<BrowserStateSnapshot>(EMPTY_STATE);
  const [urlInput, setUrlInput] = useState("localhost:1420");
  const [creatingMode, setCreatingMode] = useState<CookieMode | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const urlEditingRef = useRef(false);
  const viewportRef = useBrowserViewportBounds(scopeId, reportBrowserError);

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs],
  );
  const setUrlEditing = useCallback((editing: boolean): void => {
    urlEditingRef.current = editing;
  }, []);
  useBrowserBootstrap({
    setState,
    setUrlInput,
    setLoading,
    urlEditingRef,
    urlInputRef,
    defaultMode,
    scopeId,
  });
  const runForActive = useRunForActive(activeTab, setPending);
  const find = useBrowserFind(activeTab);
  const organization = useBrowserTabOrganization(scopeId);

  const visibleState = useMemo<BrowserStateSnapshot>(
    () => ({ ...state, error: state.error === dismissedError ? null : state.error }),
    [dismissedError, state],
  );

  const focusUrlBar = useCallback((): void => {
    const input = urlInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const tabActions = useBrowserTabActions(
    activeTab,
    defaultMode,
    scopeId,
    runForActive,
    setUrlInput,
    focusUrlBar,
    setDismissedError,
    setCreatingMode,
  );
  const pageActions = useBrowserPageActions(runForActive);
  const responsive = useBrowserResponsive(activeTab, runForActive);
  const clearError = useCallback((): void => {
    if (state.error) setDismissedError(state.error);
  }, [state.error]);

  return useBrowserModelValue({
    activeTab,
    activateTab: tabActions.activateTab,
    back: pageActions.back,
    clearError,
    closeActiveTab: tabActions.closeActiveTab,
    closeTab: tabActions.closeTab,
    devTools: pageActions.devTools,
    defaultMode,
    creatingMode,
    closeOtherTabs: organization.closeOtherTabs,
    duplicateTab: organization.duplicateTab,
    focusUrlBar,
    find,
    forward: pageActions.forward,
    loading,
    navigate: tabActions.navigate,
    newTab: tabActions.newTab,
    openExternal: pageActions.openExternal,
    pending,
    pendingAction: organization.pendingAction,
    reload: pageActions.reload,
    responsive,
    reopenLastClosedTab: organization.reopenLastClosedTab,
    reorderTab: organization.reorderTab,
    runForActive,
    setUrlEditing,
    setTabPinned: organization.setTabPinned,
    setUrlInput,
    state: visibleState,
    stop: pageActions.stop,
    zoomIn: pageActions.zoomIn,
    zoomOut: pageActions.zoomOut,
    zoomReset: pageActions.zoomReset,
    urlInput,
    urlInputRef,
    viewportRef,
  });
}

function useBrowserModelValue(model: BrowserWorkspaceModel): BrowserWorkspaceModel {
  return useMemo(
    () => model,
    [
      model.activeTab,
      model.activateTab,
      model.back,
      model.clearError,
      model.closeActiveTab,
      model.closeTab,
      model.devTools,
      model.defaultMode,
      model.creatingMode,
      model.closeOtherTabs,
      model.duplicateTab,
      model.focusUrlBar,
      model.find,
      model.forward,
      model.loading,
      model.navigate,
      model.newTab,
      model.openExternal,
      model.pending,
      model.pendingAction,
      model.reload,
      model.responsive,
      model.reopenLastClosedTab,
      model.reorderTab,
      model.runForActive,
      model.setUrlEditing,
      model.setTabPinned,
      model.stop,
      model.zoomIn,
      model.zoomOut,
      model.zoomReset,
      model.state,
      model.urlInput,
      model.viewportRef,
    ],
  );
}

interface BrowserBootstrapArgs {
  setState: (state: BrowserStateSnapshot) => void;
  setUrlInput: (value: string) => void;
  setLoading: (value: boolean) => void;
  urlEditingRef: React.RefObject<boolean>;
  urlInputRef: React.RefObject<HTMLInputElement | null>;
  defaultMode: CookieMode;
  scopeId: number;
}

function useBrowserBootstrap(args: BrowserBootstrapArgs): void {
  const { setState, setUrlInput, setLoading, urlEditingRef, urlInputRef, defaultMode, scopeId } =
    args;
  // The default mode only seeds the very first tab; read it through a ref so a
  // later settings change (this tab can stay mounted in the background) doesn't
  // re-run the bootstrap and re-subscribe the state listener.
  const defaultModeRef = useRef(defaultMode);
  defaultModeRef.current = defaultMode;
  useEffect(() => {
    let alive = true;
    // True whenever the user is interacting with the address bar. The editing
    // ref can momentarily flip false on a transient blur (e.g. the native view
    // detach churns focus); the live focus check keeps a stray browser:state
    // event from replacing what the user is typing.
    const isUrlBarActive = (): boolean =>
      urlEditingRef.current || document.activeElement === urlInputRef.current;
    const applySnapshot = (next: BrowserStateSnapshot): void => {
      setState(next);
      useBrowserStore.getState().setSnapshot(next);
    };
    void desktopBridge
      .listBrowserTabs(scopeId)
      .then(async (snapshot) => {
        if (!alive) return;
        if (snapshot.tabs.length > 0) {
          applySnapshot(snapshot);
          const active = snapshot.tabs.find((tab) => tab.isActive) ?? snapshot.tabs[0];
          if (!isUrlBarActive()) setUrlInput(displayUrl(active.url));
          return;
        }
        await desktopBridge.createBrowserTab(
          undefined,
          PROFILE_ID[defaultModeRef.current],
          scopeId,
        );
      })
      .catch((error: unknown) => showBrowserError(error, "Browser unavailable"))
      .finally(() => alive && setLoading(false));
    const off = desktopBridge.onBrowserState((next) => {
      // The main process broadcasts one snapshot per feature scope; keep only
      // the one for this workspace so another feature's tabs never appear here.
      if (next.scopeId !== scopeId) return;
      applySnapshot(next);
      const active = next.tabs.find((tab) => tab.id === next.activeTabId);
      if (active && !isUrlBarActive()) setUrlInput(displayUrl(active.url));
    });
    return () => {
      alive = false;
      off();
      useBrowserStore.getState().setSnapshot(EMPTY_STATE);
    };
  }, [scopeId, setLoading, setState, setUrlInput, urlEditingRef, urlInputRef]);
}

function useRunForActive(
  activeTab: BrowserTabMetadata | null,
  setPending: (pending: boolean) => void,
): BrowserWorkspaceModel["runForActive"] {
  return useCallback(
    async (action: (tab: BrowserTabMetadata) => Promise<void>): Promise<void> => {
      if (!activeTab) return;
      setPending(true);
      try {
        await action(activeTab);
      } catch (error) {
        showBrowserError(error, "Browser action failed");
      } finally {
        setPending(false);
      }
    },
    [activeTab, setPending],
  );
}
