import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type BrowserAgentAccessRequest,
} from "@/lib/desktop-bridge";
import { BrowserAgentAccessBanner } from "./BrowserAgentAccessBanner";

function makeRequest(
  overrides: Partial<BrowserAgentAccessRequest> = {},
): BrowserAgentAccessRequest {
  return {
    requestId: "req-1",
    tabId: "tab-1",
    scopeId: 1,
    origin: "https://app.example.com",
    url: "https://app.example.com/dashboard",
    title: "Dashboard",
    privacy: "normal",
    ...overrides,
  };
}

describe("BrowserAgentAccessBanner", () => {
  beforeEach(() => clearDesktopBridgeOverrideForTests());
  afterEach(() => clearDesktopBridgeOverrideForTests());

  it("fetches pending requests on mount and shows normal-tab copy", async () => {
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [makeRequest()]),
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);

    expect(await screen.findByText("Agent is requesting access to this tab")).toBeVisible();
    expect(screen.getByText("https://app.example.com")).toBeVisible();
    expect(
      screen.getByText(
        /Normal tab — the agent will be able to read and interact with your signed-in session on this origin until you navigate elsewhere, revoke access, or close the tab\./,
      ),
    ).toBeVisible();
  });

  it("shows private-tab copy and targetUrl copy when opening a page", async () => {
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [
        makeRequest({
          privacy: "private",
          targetUrl: "https://docs.example.com/guide",
        }),
      ]),
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);

    expect(await screen.findByText("Agent wants to open a page in this tab")).toBeVisible();
    expect(screen.getByText("https://docs.example.com/guide")).toBeVisible();
    expect(
      screen.getByText(
        /Private tab — the agent will be able to read and interact with this tab on this origin until you revoke access or close it\./,
      ),
    ).toBeVisible();
  });

  it("shows feature-session-tab copy for feature privacy tabs", async () => {
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [
        makeRequest({
          privacy: "feature",
        }),
      ]),
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);

    expect(await screen.findByText("Agent is requesting access to this tab")).toBeVisible();
    expect(
      screen.getByText(
        /Feature session tab — the agent will be able to read and interact with this tab on this origin until you revoke access or close it\./,
      ),
    ).toBeVisible();
  });

  it("identifies inactive tabs by title/url and offers a View tab button", async () => {
    const onActivateTab = vi.fn();
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [
        makeRequest({
          tabId: "tab-2",
          title: "Billing Settings",
          url: "https://app.example.com/billing",
        }),
      ]),
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(
      <BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" onActivateTab={onActivateTab} />,
    );

    expect(
      await screen.findByText('Agent is requesting access to "Billing Settings"'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View tab" }));
    expect(onActivateTab).toHaveBeenCalledWith("tab-2");
  });

  it("handles live requests, deduplicates, filters by scope, and handles cancellation", async () => {
    let emitRequest: ((req: BrowserAgentAccessRequest) => void) | null = null;
    let emitCancelled: ((event: { requestId: string }) => void) | null = null;
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => []),
      onBrowserAgentAccessRequest: vi.fn((cb) => {
        emitRequest = cb;
        return () => undefined;
      }),
      onBrowserAgentAccessRequestCancelled: vi.fn((cb) => {
        emitCancelled = cb;
        return () => undefined;
      }),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Wrong scope is ignored.
    act(() => emitRequest?.(makeRequest({ requestId: "req-other", scopeId: 2 })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Matching scope appears and duplicates do not inflate count.
    const liveReq = makeRequest({ requestId: "req-live", tabId: "tab-2" });
    act(() => {
      emitRequest?.(liveReq);
      emitRequest?.(liveReq);
    });
    // Falls back to requests[0] when activeTabId ("tab-1") doesn't match yet.
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText('Agent is requesting access to "Dashboard"')).toBeVisible();
    expect(screen.queryByText(/\+1 more/)).not.toBeInTheDocument();

    // Cancellation removes the banner.
    act(() => emitCancelled?.({ requestId: "req-live" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resolves with allowed=true on Allow access click and shows busy state", async () => {
    let finishResolve: (() => void) | undefined;
    const resolveReq = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishResolve = resolve;
        }),
    );
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [makeRequest()]),
      resolveBrowserAgentAccessRequest: resolveReq,
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);
    const allowBtn = await screen.findByRole("button", { name: "Allow access" });
    const denyBtn = screen.getByRole("button", { name: "Deny" });

    fireEvent.click(allowBtn);
    fireEvent.click(allowBtn);
    expect(resolveReq).toHaveBeenCalledTimes(1);
    expect(resolveReq).toHaveBeenCalledWith("req-1", true);
    expect(allowBtn).toBeDisabled();
    expect(denyBtn).toBeDisabled();
    expect(allowBtn).toHaveAttribute("aria-busy", "true");

    finishResolve?.();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("resolves with allowed=false on Deny click", async () => {
    const resolveReq = vi.fn(async () => undefined);
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [makeRequest()]),
      resolveBrowserAgentAccessRequest: resolveReq,
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    await waitFor(() => expect(resolveReq).toHaveBeenCalledWith("req-1", false));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("dismisses a stale banner when resolve rejects because the request is no longer active", async () => {
    const resolveReq = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'browser:resolve-agent-access-request': Error: This agent access request is no longer active.",
      );
    });
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn(async () => [makeRequest()]),
      resolveBrowserAgentAccessRequest: resolveReq,
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow access" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("drops stale scope fetch results after rerender", async () => {
    let resolveScope1: ((items: BrowserAgentAccessRequest[]) => void) | undefined;
    setDesktopBridgeOverrideForTests({
      listBrowserAgentAccessRequests: vi.fn((scopeId: number) => {
        if (scopeId === 2) {
          return Promise.resolve([
            makeRequest({ requestId: "req-2", scopeId: 2, origin: "https://scope2.example.com" }),
          ]);
        }
        return new Promise<BrowserAgentAccessRequest[]>((resolve) => {
          resolveScope1 = resolve;
        });
      }),
      onBrowserAgentAccessRequest: vi.fn(() => () => undefined),
      onBrowserAgentAccessRequestCancelled: vi.fn(() => () => undefined),
    });

    const view = render(<BrowserAgentAccessBanner scopeId={1} activeTabId="tab-1" />);
    view.rerender(<BrowserAgentAccessBanner scopeId={2} activeTabId="tab-1" />);

    expect(await screen.findByText("https://scope2.example.com")).toBeVisible();
    resolveScope1?.([
      makeRequest({ requestId: "req-1", scopeId: 1, origin: "https://stale.example.com" }),
    ]);
    await Promise.resolve();
    expect(screen.queryByText("https://stale.example.com")).not.toBeInTheDocument();
  });
});
