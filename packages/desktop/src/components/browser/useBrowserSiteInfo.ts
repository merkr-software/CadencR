import { translateUi } from "@/lib/i18n/ui";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  desktopBridge,
  type BrowserSiteInfo,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision,
  type BrowserTabMetadata,
} from "@/lib/desktop-bridge";
import { showBrowserError } from "./browser-errors";

export interface BrowserSiteTarget {
  tabId: string;
  origin: string;
}

export interface BrowserSiteInfoController {
  info: BrowserSiteInfo | null;
  loading: boolean;
  action: "permission" | "sharing" | "clearing" | null;
  setPermission: (
    permission: BrowserSitePermission,
    decision: BrowserSitePermissionDecision,
  ) => Promise<void>;
  setSharing: (target: BrowserSiteTarget, shared: boolean) => Promise<void>;
  clearData: (target: BrowserSiteTarget) => Promise<void>;
}

interface BrowserSiteInfoQuery {
  info: BrowserSiteInfo | null;
  setInfo: Dispatch<SetStateAction<BrowserSiteInfo | null>>;
  loading: boolean;
  generationRef: MutableRefObject<number>;
  tabId: string | null;
}

function useBrowserSiteInfoQuery(
  activeTab: BrowserTabMetadata | null,
  enabled: boolean,
): BrowserSiteInfoQuery {
  const [info, setInfo] = useState<BrowserSiteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const tabId = activeTab?.id ?? null;
  const liveUrl = activeTab?.url ?? null;

  useEffect(() => {
    const generation = ++generationRef.current;
    setInfo(null);
    if (!enabled || !tabId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void desktopBridge
      .getBrowserSiteInfo(tabId)
      .then((next) => {
        if (generationRef.current === generation) setInfo(next);
      })
      .catch((error: unknown) => {
        if (generationRef.current === generation) {
          showBrowserError(
            error,
            translateUi(
              "workspace.tools.useBrowserSiteInfo.couldNotLoadSiteInformation",
              "Could not load site information",
            ),
          );
        }
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, liveUrl, tabId]);

  return { info, setInfo, loading, generationRef, tabId };
}

function useBrowserSiteActions(
  tabId: string | null,
  origin: string | null | undefined,
  generationRef: MutableRefObject<number>,
  setInfo: Dispatch<SetStateAction<BrowserSiteInfo | null>>,
): Pick<BrowserSiteInfoController, "action" | "setPermission" | "setSharing" | "clearData"> {
  const [action, setAction] = useState<BrowserSiteInfoController["action"]>(null);

  useEffect(() => setAction(null), [origin, tabId]);

  const setPermission = useCallback(
    async (
      permission: BrowserSitePermission,
      decision: BrowserSitePermissionDecision,
    ): Promise<void> => {
      if (!tabId || !origin) return;
      const generation = generationRef.current;
      setAction("permission");
      try {
        const next = await desktopBridge.setBrowserSitePermission(
          tabId,
          origin,
          permission,
          decision,
        );
        if (generationRef.current === generation) setInfo(next);
      } catch (error) {
        showBrowserError(
          error,
          translateUi(
            "workspace.tools.useBrowserSiteInfo.couldNotUpdateWebsitePermission",
            "Could not update website permission",
          ),
        );
      } finally {
        if (generationRef.current === generation) setAction(null);
      }
    },
    [generationRef, origin, setInfo, tabId],
  );

  const setSharing = useCallback(
    async (target: BrowserSiteTarget, shared: boolean): Promise<void> => {
      const generation = generationRef.current;
      setAction("sharing");
      try {
        const next = await desktopBridge.setBrowserAgentSharing(
          target.tabId,
          target.origin,
          shared,
        );
        if (generationRef.current === generation && next.tabId === tabId) setInfo(next);
      } catch (error) {
        showBrowserError(
          error,
          translateUi(
            "workspace.tools.useBrowserSiteInfo.couldNotUpdateAgentSharing",
            "Could not update agent sharing",
          ),
        );
      } finally {
        if (generationRef.current === generation) setAction(null);
      }
    },
    [generationRef, setInfo, tabId],
  );

  const clearData = useCallback(
    async (target: BrowserSiteTarget): Promise<void> => {
      const generation = generationRef.current;
      setAction("clearing");
      try {
        const next = await desktopBridge.clearBrowserSiteData(target.tabId, target.origin);
        const stillCurrent =
          generationRef.current === generation &&
          next.tabId === tabId &&
          next.origin === target.origin;
        if (stillCurrent) {
          await desktopBridge.browserReload(target.tabId);
          setInfo(next);
        }
      } catch (error) {
        showBrowserError(
          error,
          translateUi(
            "workspace.tools.useBrowserSiteInfo.couldNotClearSiteData",
            "Could not clear site data",
          ),
        );
      } finally {
        if (generationRef.current === generation) setAction(null);
      }
    },
    [generationRef, setInfo, tabId],
  );

  return useMemo(
    () => ({ action, setPermission, setSharing, clearData }),
    [action, clearData, setPermission, setSharing],
  );
}

export function useBrowserSiteInfo(
  activeTab: BrowserTabMetadata | null,
  enabled: boolean,
): BrowserSiteInfoController {
  const { info, setInfo, loading, generationRef, tabId } = useBrowserSiteInfoQuery(
    activeTab,
    enabled,
  );
  const actions = useBrowserSiteActions(tabId, info?.origin, generationRef, setInfo);

  return useMemo(() => ({ info, loading, ...actions }), [actions, info, loading]);
}
