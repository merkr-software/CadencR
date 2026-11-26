import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import { desktopBridge, type BrowserAgentAccessRequest } from "@/lib/desktop-bridge";
import type { BrowserTabPrivacy } from "@/shared/browser-types";
import { formatBrowserIpcError, showBrowserError } from "./browser-errors";

type PendingDecision = "allow" | "deny" | null;

const BANNER_TONE = {
  warning: {
    container:
      "border-[color-mix(in_oklab,var(--acc-orange)_35%,transparent)] bg-[color-mix(in_oklab,var(--acc-orange)_8%,var(--card))]",
    icon: "text-[var(--acc-orange)]",
  },
  info: {
    container:
      "border-[color-mix(in_oklab,var(--acc-cyan)_35%,transparent)] bg-[color-mix(in_oklab,var(--acc-cyan)_8%,var(--card))]",
    icon: "text-[var(--acc-cyan)]",
  },
} as const;

const PRIVACY_DESCRIPTION: Record<BrowserTabPrivacy, string> = {
  normal:
    "Normal tab — the agent will be able to read and interact with your signed-in session on this origin until you navigate elsewhere, revoke access, or close the tab.",
  private:
    "Private tab — the agent will be able to read and interact with this tab on this origin until you revoke access or close it.",
  feature:
    "Feature session tab — the agent will be able to read and interact with this tab on this origin until you revoke access or close it.",
};

const DECISION_BUTTONS = [
  { key: "deny" as const, allowed: false, variant: "outline" as const, label: "Deny" },
  { key: "allow" as const, allowed: true, variant: "default" as const, label: "Allow access" },
];

function isStaleAccessRequestError(error: unknown): boolean {
  return /no longer active|expired|not found/i.test(formatBrowserIpcError(error));
}

function bannerHeading(request: BrowserAgentAccessRequest, isActiveTab: boolean): string {
  if (isActiveTab) {
    return request.targetUrl
      ? "Agent wants to open a page in this tab"
      : "Agent is requesting access to this tab";
  }
  const tabLabel = request.title || request.url || "another tab";
  return request.targetUrl
    ? `Agent wants to open a page in "${tabLabel}"`
    : `Agent is requesting access to "${tabLabel}"`;
}

interface AgentAccessBannerActionsProps {
  requestId: string;
  onResolved: (requestId: string) => void;
  onViewTab?: () => void;
}

function AgentAccessBannerActions({
  requestId,
  onResolved,
  onViewTab,
}: AgentAccessBannerActionsProps): ReactElement {
  const [pending, setPending] = useState<PendingDecision>(null);
  const operationPending = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const decide = async (allowed: boolean): Promise<void> => {
    if (operationPending.current) return;
    operationPending.current = true;
    setPending(allowed ? "allow" : "deny");
    try {
      await desktopBridge.resolveBrowserAgentAccessRequest(requestId, allowed);
      onResolved(requestId);
    } catch (error) {
      showBrowserError(
        error,
        allowed ? "Could not allow agent access" : "Could not deny agent access",
      );
      if (isStaleAccessRequestError(error)) onResolved(requestId);
    } finally {
      operationPending.current = false;
      if (mountedRef.current) setPending(null);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {onViewTab ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={onViewTab}
        >
          View tab
        </Button>
      ) : null}
      {DECISION_BUTTONS.map(({ key, allowed, variant, label }) => (
        <Button
          key={key}
          type="button"
          size="xs"
          variant={variant}
          disabled={pending !== null}
          aria-busy={pending === key}
          onClick={() => void decide(allowed)}
        >
          {pending === key ? <Loader2Icon className="animate-spin" /> : null}
          {label}
        </Button>
      ))}
    </div>
  );
}

function appendUniqueRequest(
  current: BrowserAgentAccessRequest[],
  next: BrowserAgentAccessRequest,
): BrowserAgentAccessRequest[] {
  if (current.some((item) => item.requestId === next.requestId)) return current;
  return [...current, next];
}

function removeRequestById(
  current: BrowserAgentAccessRequest[],
  requestId: string,
): BrowserAgentAccessRequest[] {
  if (!current.some((item) => item.requestId === requestId)) return current;
  return current.filter((item) => item.requestId !== requestId);
}

function mergeRequests(
  fetched: BrowserAgentAccessRequest[],
  current: BrowserAgentAccessRequest[],
): BrowserAgentAccessRequest[] {
  if (fetched.length === 0) return current;
  const currentIds = new Set(current.map((item) => item.requestId));
  if (fetched.every((item) => currentIds.has(item.requestId))) return current;
  const merged = [...fetched];
  for (const item of current) {
    if (!merged.some((existing) => existing.requestId === item.requestId)) {
      merged.push(item);
    }
  }
  return merged;
}

export const BrowserAgentAccessBanner = memo(function BrowserAgentAccessBanner({
  scopeId,
  activeTabId,
  onActivateTab,
}: {
  scopeId: number;
  activeTabId: string | null;
  onActivateTab?: (tabId: string) => void;
}): ReactElement | null {
  const [requests, setRequests] = useState<BrowserAgentAccessRequest[]>([]);

  useEffect(() => {
    let alive = true;
    let initialLoaded = false;
    const cancelledIds = new Set<string>();
    setRequests((current) => (current.length === 0 ? current : []));

    void desktopBridge
      .listBrowserAgentAccessRequests(scopeId)
      .then((initial) => {
        if (!alive) return;
        const liveInitial = initial.filter((item) => !cancelledIds.has(item.requestId));
        initialLoaded = true;
        cancelledIds.clear();
        setRequests((current) => mergeRequests(liveInitial, current));
      })
      .catch((error: unknown) => {
        initialLoaded = true;
        cancelledIds.clear();
        if (alive) showBrowserError(error, "Could not read agent access requests");
      });

    const offRequest = desktopBridge.onBrowserAgentAccessRequest((next) => {
      if (next.scopeId !== scopeId) return;
      if (!initialLoaded) cancelledIds.delete(next.requestId);
      setRequests((current) => appendUniqueRequest(current, next));
    });

    const offCancelled = desktopBridge.onBrowserAgentAccessRequestCancelled(({ requestId }) => {
      if (!initialLoaded) cancelledIds.add(requestId);
      setRequests((current) => removeRequestById(current, requestId));
    });

    return () => {
      alive = false;
      cancelledIds.clear();
      offRequest();
      offCancelled();
    };
  }, [scopeId]);

  const handleResolved = useCallback((requestId: string): void => {
    setRequests((current) => removeRequestById(current, requestId));
  }, []);

  const request = requests.find((item) => item.tabId === activeTabId) ?? requests[0] ?? null;
  if (!request) return null;

  const isActiveTab = request.tabId === activeTabId;
  const tone = BANNER_TONE[request.privacy === "normal" ? "warning" : "info"];
  const count = requests.length;
  const locationLabel = request.origin ?? (request.url || "about:blank");

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2.5 border-b px-3 py-2 text-xs text-foreground ${tone.container}`}
    >
      <AgentIcon aria-hidden="true" className={`size-4 shrink-0 ${tone.icon}`} />
      <div className="min-w-48 flex-1 space-y-0.5">
        <p className="font-medium">
          {bannerHeading(request, isActiveTab)}
          {count > 1 ? ` (+${count - 1} more)` : ""}
        </p>
        <p className="truncate font-mono text-[11px] text-foreground">
          {request.targetUrl ? request.targetUrl : locationLabel}
        </p>
        {request.targetUrl && request.origin ? (
          <p className="truncate text-[11px] text-muted-foreground">
            Current origin: <span className="font-mono">{request.origin}</span>
          </p>
        ) : null}
        <p className="text-muted-foreground">{PRIVACY_DESCRIPTION[request.privacy]}</p>
      </div>
      <AgentAccessBannerActions
        key={request.requestId}
        requestId={request.requestId}
        onResolved={handleResolved}
        onViewTab={!isActiveTab && onActivateTab ? () => onActivateTab(request.tabId) : undefined}
      />
    </div>
  );
});
