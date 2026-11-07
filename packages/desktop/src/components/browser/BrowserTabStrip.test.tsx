import { describe, expect, it, vi } from "vitest";

import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { fireEvent, render, screen } from "@/test-utils";
import { BrowserTabStrip } from "./BrowserTabStrip";
import type { BrowserWorkspaceModel } from "./useBrowserWorkspaceModel";

function tab(index: number, activeIndex: number): BrowserTabMetadata {
  return {
    id: `tab-${index}`,
    title: `Tab ${index}`,
    url: `https://tab-${index}.example/`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: "default",
    isActive: index === activeIndex,
    devToolsOpen: false,
    pinned: false,
    suspended: false,
    zoomPercent: 100,
    responsive: {
      enabled: false,
      preset: "mobile",
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      colorScheme: "system",
      status: "ready",
    },
    scopeId: 1,
  };
}

function model(activeIndex: number): BrowserWorkspaceModel {
  const tabs = Array.from({ length: 25 }, (_, index) => tab(index + 1, activeIndex));
  return {
    state: {
      tabs,
      activeTabId: `tab-${activeIndex}`,
      error: null,
    },
    pendingAction: null,
    defaultMode: "normal",
    creatingMode: null,
    newTab: vi.fn(async () => undefined),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    setTabPinned: vi.fn(),
    duplicateTab: vi.fn(),
    reorderTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    reopenLastClosedTab: vi.fn(),
  } as unknown as BrowserWorkspaceModel;
}

describe("BrowserTabStrip", () => {
  it("keeps the tab context-menu trigger wired through the drag surface", () => {
    render(<BrowserTabStrip model={model(1)} />);
    const tabPill = screen.getByText("Tab 1").closest<HTMLElement>("[draggable='true']");
    fireEvent.contextMenu(tabPill as HTMLElement);
    expect(screen.getByRole("menuitem", { name: "Pin tab" })).toBeInTheDocument();
  });

  it("keeps creation controls outside the hidden-scrollbar tab rail and reveals the active tab", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(<BrowserTabStrip model={model(25)} />);

    const activePill = screen.getByText("Tab 25").closest<HTMLElement>("[aria-current='page']");
    const tabRail = activePill?.parentElement;
    const newTabButton = screen.getByRole("button", { name: /New browser tab/ });
    expect(tabRail).not.toBeNull();
    expect(tabRail?.contains(newTabButton)).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    Object.defineProperty(tabRail, "scrollWidth", { configurable: true, value: 1_000 });
    Object.defineProperty(tabRail, "clientWidth", { configurable: true, value: 300 });
    fireEvent.wheel(tabRail as HTMLElement, { deltaX: 0, deltaY: 40 });
    expect(tabRail?.scrollLeft).toBe(40);
  });

  it("shows drag and drop-target feedback until a reorder is dropped", () => {
    const workspace = model(1);
    render(<BrowserTabStrip model={workspace} />);
    const source = screen.getByText("Tab 1").closest<HTMLElement>("[draggable='true']");
    const target = screen.getByText("Tab 2").closest<HTMLElement>("[draggable='true']");
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };

    fireEvent.dragStart(source as HTMLElement, { dataTransfer });
    expect(source).toHaveAttribute("data-dragging", "true");
    fireEvent.dragOver(target as HTMLElement, { dataTransfer });
    expect(target).toHaveAttribute("data-drop-target", "true");
    fireEvent.dragLeave(target as HTMLElement);
    expect(target).not.toHaveAttribute("data-drop-target");
    fireEvent.dragOver(target as HTMLElement, { dataTransfer });

    fireEvent.drop(target as HTMLElement, { dataTransfer });
    expect(workspace.reorderTab).toHaveBeenCalledWith("tab-1", 1);
    expect(source).not.toHaveAttribute("data-dragging");
    expect(target).not.toHaveAttribute("data-drop-target");
  });

  it("does not advertise or accept external and cross-group drops", () => {
    const workspace = model(1);
    workspace.state.tabs[0] = { ...workspace.state.tabs[0], pinned: true };
    render(<BrowserTabStrip model={workspace} />);
    const source = screen.getByText("Tab 1").closest<HTMLElement>("[draggable='true']");
    const target = screen.getByText("Tab 2").closest<HTMLElement>("[draggable='true']");
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };

    fireEvent.dragOver(target as HTMLElement, { dataTransfer });
    expect(target).not.toHaveAttribute("data-drop-target");
    fireEvent.dragStart(source as HTMLElement, { dataTransfer });
    fireEvent.dragOver(target as HTMLElement, { dataTransfer });
    fireEvent.drop(target as HTMLElement, { dataTransfer });
    expect(target).not.toHaveAttribute("data-drop-target");
    expect(workspace.reorderTab).not.toHaveBeenCalled();
  });

  it("keeps feedback within the target and clears it when a drag is cancelled", () => {
    const workspace = model(1);
    render(<BrowserTabStrip model={workspace} />);
    const source = screen.getByText("Tab 1").closest<HTMLElement>("[draggable='true']")!;
    const target = screen.getByText("Tab 2").closest<HTMLElement>("[draggable='true']")!;
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    const leave = new Event("dragleave", { bubbles: true });
    Object.defineProperty(leave, "relatedTarget", { value: screen.getByText("Tab 2") });
    fireEvent(target, leave);
    expect(target).toHaveAttribute("data-drop-target", "true");
    fireEvent.dragEnd(source);
    expect(source).not.toHaveAttribute("data-dragging");
    expect(target).not.toHaveAttribute("data-drop-target");
    expect(workspace.reorderTab).not.toHaveBeenCalled();
  });
});
