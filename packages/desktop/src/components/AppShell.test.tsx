import { createRef, useEffect, type ReactNode } from "react";
import type { GroupProps, PanelImperativeHandle, PanelProps } from "react-resizable-panels";
import { render, act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";

/**
 * These tests guard the controlled collapsibility contract for the global
 * sidebar.
 *
 * Mechanism: every resize handle in the app shares one global "is a drag in
 * progress?" flag (`resize-coordinator`). The editor sidebar pushes that flag
 * to freeze its heavy children while dragging. The global sidebar reads the
 * same flag to suspend fluid layout transitions. It must not change the real
 * Panel's `collapsible` constraint during pointerdown: doing so churns the
 * library's document handlers before the only mounted Group can start a drag.
 * The controlled `collapsed` state alone owns that constraint.
 *
 * We mock `ui/resizable` to record the props handed to the sidebar panel, then
 * drive the *real* `resize-coordinator` (via `pushResize`) to simulate the
 * editor sidebar's drag — exactly the path that triggered the bug.
 */

interface AppShellGroupProps extends GroupProps {
  "data-app-shell-resize"?: string;
}

const appShellGroupProps: AppShellGroupProps[] = [];
const sidebarPanelProps: PanelProps[] = [];

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: (props: AppShellGroupProps) => {
    appShellGroupProps.push(props);
    return <div>{props.children}</div>;
  },
  ResizablePanel: (props: PanelProps) => {
    if (props.id === "sidebar") sidebarPanelProps.push(props);
    return <div data-testid={`panel-${props.id}`}>{props.children}</div>;
  },
  ResizableHandle: () => <div data-testid="handle" />,
}));

vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <button data-testid="sidebar-content">Drawer content</button>,
}));

vi.mock("@/components/SidebarRail", () => ({
  SidebarRail: () => <nav data-testid="sidebar-rail" />,
}));
vi.mock("@/components/SidebarAttentionProvider", () => ({
  SidebarAttentionProvider: ({ children }: { children: ReactNode }) => children,
}));

import { AppShell } from "./AppShell";
import { isResizing, popResize, pushResize } from "@/lib/resize-coordinator";

function renderShell(collapsed: boolean, isMobile = false, setCollapsed = () => {}) {
  return render(
    <AppShell
      isMobile={isMobile}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      onSearch={() => {}}
      sidebarPanelRef={createRef<PanelImperativeHandle | null>()}
      leftSidebarRef={createRef<HTMLDivElement | null>()}
      defaultLeftSize="256px"
      onLayoutChanged={() => {}}
      onSidebarResize={() => {}}
    >
      <div>main</div>
    </AppShell>,
  );
}

it("localizes the mounted mobile drawer without closing it or moving focus", async () => {
  const setCollapsed = vi.fn();
  uiI18n.addResourceBundle("fr", "ui", { shell: { navigation: { closeMenu: "Fermer le menu" } } });

  try {
    renderShell(false, true, setCollapsed);
    const backdrop = screen.getByRole("button", { name: "Close menu" });
    const drawerContent = screen.getByTestId("sidebar-content");
    drawerContent.focus();

    await act(() => uiI18n.changeLanguage("fr"));
    expect(screen.getByRole("button", { name: "Fermer le menu" })).toBe(backdrop);
    expect(drawerContent).toHaveFocus();
    expect(setCollapsed).not.toHaveBeenCalled();

    await act(() => uiI18n.changeLanguage("en"));
    expect(screen.getByRole("button", { name: "Close menu" })).toBe(backdrop);
    fireEvent.click(backdrop);
    expect(setCollapsed).toHaveBeenCalledWith(true);
  } finally {
    await act(() => uiI18n.changeLanguage("en"));
    uiI18n.removeResourceBundle("fr", "ui");
  }
});

function latestCollapsible(): boolean | undefined {
  return sidebarPanelProps.at(-1)?.collapsible;
}

describe("AppShell global sidebar collapsible", () => {
  beforeEach(() => {
    appShellGroupProps.length = 0;
    sidebarPanelProps.length = 0;
  });

  afterEach(() => {
    cleanup();
    // Drain the shared coordinator so a leaked drag doesn't bleed into the next
    // test (the flag is a module singleton).
    while (isResizing()) popResize();
  });

  it("keeps a collapsed sidebar collapsible while a foreign resize is in progress", () => {
    renderShell(true);
    // Baseline: no drag → collapsible.
    expect(latestCollapsible()).toBe(true);

    // Simulate the editor sidebar starting a drag: it pushes the shared flag.
    act(() => {
      pushResize();
    });

    // The collapsed global sidebar must stay collapsible so the panel is not
    // force-expanded out from under its `collapsedSize={0}`.
    expect(latestCollapsible()).toBe(true);
  });

  it("keeps an expanded sidebar non-collapsible throughout a resize", () => {
    renderShell(false);
    expect(latestCollapsible()).toBe(false);

    // While expanded, remaining non-collapsible hard-clamps pointer and keyboard
    // resizing to [minSize, maxSize] without re-registering the Panel mid-event.
    act(() => {
      pushResize();
    });

    expect(latestCollapsible()).toBe(false);
  });

  it("animates programmatic layout changes but not manual resize drags", () => {
    renderShell(false);
    expect(appShellGroupProps.at(-1)?.["data-app-shell-resize"]).toBe("fluid");

    act(() => {
      pushResize();
    });

    expect(appShellGroupProps.at(-1)?.["data-app-shell-resize"]).toBeUndefined();
  });
});

describe("AppShell layout flips", () => {
  afterEach(cleanup);

  let mounts = 0;
  function MainProbe(): ReactNode {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <div data-testid="main-probe">main</div>;
  }

  function shell(isMobile: boolean): ReactNode {
    return (
      <AppShell
        isMobile={isMobile}
        collapsed={false}
        setCollapsed={() => {}}
        onSearch={() => {}}
        sidebarPanelRef={createRef<PanelImperativeHandle | null>()}
        leftSidebarRef={createRef<HTMLDivElement | null>()}
        defaultLeftSize="256px"
        onLayoutChanged={() => {}}
        onSidebarResize={() => {}}
      >
        <MainProbe />
      </AppShell>
    );
  }

  it("keeps the main content mounted while only the sidebar's container changes", () => {
    mounts = 0;
    const view = render(shell(false));
    const probe = screen.getByTestId("main-probe");
    expect(screen.getByTestId("panel-sidebar")).toBeInTheDocument();
    expect(document.querySelector("[data-drawer-panel]")).toBeNull();

    // Desktop → phone (a window crossing 767px, a tablet rotating, a fold).
    view.rerender(shell(true));
    expect(screen.getByTestId("main-probe")).toBe(probe);
    expect(screen.queryByTestId("panel-sidebar")).not.toBeInTheDocument();
    expect(document.querySelector("[data-drawer-panel]")).not.toBeNull();
    expect(screen.getByRole("main").getAttribute("tabindex")).toBeNull();

    // And back.
    view.rerender(shell(false));
    expect(screen.getByTestId("main-probe")).toBe(probe);
    expect(probe.isConnected).toBe(true);
    expect(screen.getByTestId("panel-sidebar")).toBeInTheDocument();
    expect(screen.getByRole("main").getAttribute("tabindex")).toBe("0");
    expect(mounts).toBe(1);
  });

  it("does not animate the phone's lone main panel", () => {
    render(shell(true));
    expect(appShellGroupProps.at(-1)?.["data-app-shell-resize"]).toBeUndefined();
  });

  it("tints the status bar like the drawer while it is open", () => {
    const phone = (collapsed: boolean): ReactNode => (
      <AppShell
        isMobile
        collapsed={collapsed}
        setCollapsed={() => {}}
        onSearch={() => {}}
        sidebarPanelRef={createRef<PanelImperativeHandle | null>()}
        leftSidebarRef={createRef<HTMLDivElement | null>()}
        defaultLeftSize="256px"
        onLayoutChanged={() => {}}
        onSidebarResize={() => {}}
      >
        <div>main</div>
      </AppShell>
    );
    const view = render(phone(true));
    const sampler = document.querySelector(".mobile-status-bar");
    expect(sampler?.hasAttribute("data-drawer-open")).toBe(false);
    view.rerender(phone(false));
    expect(sampler?.hasAttribute("data-drawer-open")).toBe(true);
  });

  it("docks the sidebar beside the page on a wide touch screen, the rail once collapsed", () => {
    const docked = (collapsed: boolean): ReactNode => (
      <AppShell
        isMobile
        docked
        collapsed={collapsed}
        setCollapsed={() => {}}
        onSearch={() => {}}
        sidebarPanelRef={createRef<PanelImperativeHandle | null>()}
        leftSidebarRef={createRef<HTMLDivElement | null>()}
        defaultLeftSize="256px"
        onLayoutChanged={() => {}}
        onSidebarResize={() => {}}
      >
        <MainProbe />
      </AppShell>
    );
    mounts = 0;
    const view = render(docked(false));
    const probe = screen.getByTestId("main-probe");
    expect(document.querySelector("[data-drawer-panel]")).toBeNull();
    expect(document.querySelector("[data-docked-sidebar]")).toHaveClass("w-xs");
    expect(screen.queryByTestId("sidebar-rail")).not.toBeInTheDocument();

    view.rerender(docked(true));
    expect(screen.getByTestId("sidebar-rail")).toBeInTheDocument();
    // Still mounted at zero width behind the rail, as on the desktop.
    const dockedSidebar = document.querySelector("[data-docked-sidebar]");
    expect(dockedSidebar).toHaveClass("w-0");
    expect(dockedSidebar).toHaveAttribute("inert");
    expect(screen.getByTestId("main-probe")).toBe(probe);
    expect(mounts).toBe(1);
    // The status bar keeps the page's color: no drawer covers it.
    expect(document.querySelector(".mobile-status-bar")?.hasAttribute("data-drawer-open")).toBe(
      false,
    );
  });

  it("keeps the main content mounted as a foldable turns between the drawer and the docked sidebar", () => {
    const phone = (docked: boolean): ReactNode => (
      <AppShell
        isMobile
        docked={docked}
        collapsed
        setCollapsed={() => {}}
        onSearch={() => {}}
        sidebarPanelRef={createRef<PanelImperativeHandle | null>()}
        leftSidebarRef={createRef<HTMLDivElement | null>()}
        defaultLeftSize="256px"
        onLayoutChanged={() => {}}
        onSidebarResize={() => {}}
      >
        <MainProbe />
      </AppShell>
    );
    mounts = 0;
    const view = render(phone(false));
    const probe = screen.getByTestId("main-probe");
    expect(document.querySelector("[data-drawer-panel]")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-rail")).not.toBeInTheDocument();

    view.rerender(phone(true));
    expect(document.querySelector("[data-drawer-panel]")).toBeNull();
    expect(screen.getByTestId("sidebar-rail")).toBeInTheDocument();
    expect(screen.getByTestId("main-probe")).toBe(probe);

    view.rerender(phone(false));
    expect(document.querySelector("[data-drawer-panel]")).not.toBeNull();
    expect(screen.getByTestId("main-probe")).toBe(probe);
    expect(mounts).toBe(1);
  });
});
