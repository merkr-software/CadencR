// @vitest-environment jsdom
// Pinned to jsdom: react-resizable-panels needs jsdom's layout and pointer semantics.
import { createRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isResizing,
  popResize,
  pushResize,
  registerHandle,
  unregisterHandle,
} from "@/lib/resize-coordinator";
import { AppShell } from "./AppShell";

vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-content" />,
}));

vi.mock("@/components/MobileDrawer", () => ({
  MobileDrawer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const GROUP_WIDTH = 800;
const GROUP_HEIGHT = 600;
const DEFAULT_WIDTH = 256;

function panelWidth(element: HTMLElement): number {
  const flexGrow = Number.parseFloat(element.style.flexGrow);
  if (Number.isFinite(flexGrow) && !(element.id === "main" && flexGrow === 1)) {
    return (flexGrow / 100) * GROUP_WIDTH;
  }

  const flexBasis = Number.parseFloat(element.style.flexBasis);
  if (Number.isFinite(flexBasis) && flexBasis > 0) return flexBasis;

  return element.id === "sidebar" ? DEFAULT_WIDTH : GROUP_WIDTH - DEFAULT_WIDTH;
}

function elementWidth(element: HTMLElement): number {
  if (element.hasAttribute("data-panel")) return panelWidth(element);
  if (element.hasAttribute("data-separator")) return 1;
  return GROUP_WIDTH;
}

function elementLeft(element: HTMLElement): number {
  if (element.id === "sidebar") return 0;
  if (element.hasAttribute("data-separator") || element.id === "main") {
    const sidebar = document.querySelector<HTMLElement>("#sidebar");
    return sidebar ? panelWidth(sidebar) : DEFAULT_WIDTH;
  }
  return 0;
}

function shell(collapsed = false, panelRef = createRef<PanelImperativeHandle | null>()) {
  return (
    <AppShell
      isMobile={false}
      collapsed={collapsed}
      setCollapsed={() => {}}
      onSearch={() => {}}
      sidebarPanelRef={panelRef}
      leftSidebarRef={createRef<HTMLDivElement | null>()}
      defaultLeftSize={`${DEFAULT_WIDTH}px`}
      onLayoutChanged={() => {}}
    >
      <div>main</div>
    </AppShell>
  );
}

function renderShell() {
  return render(shell());
}

function appShellSeparator(): HTMLElement {
  const separator = screen.getByRole("separator");
  // jsdom does not implement the reflected ARIA element properties used by
  // react-resizable-panels' hit-test. Match the browser's absent-attribute
  // behavior so the real library does not mistake this separator for disabled.
  Object.defineProperty(separator, "ariaDisabled", {
    configurable: true,
    get: () => separator.getAttribute("aria-disabled"),
  });
  return separator;
}

function pointerDown(separator: HTMLElement): boolean {
  return fireEvent.pointerDown(separator, {
    button: 0,
    buttons: 1,
    clientX: DEFAULT_WIDTH,
    clientY: 100,
    pointerId: 1,
    pointerType: "mouse",
  });
}

function pointerMove(clientX: number): void {
  fireEvent.pointerMove(document, {
    buttons: 1,
    clientX,
    clientY: 100,
    movementX: clientX - DEFAULT_WIDTH,
    movementY: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
}

function pointerUp(clientX: number): void {
  fireEvent.pointerUp(document, {
    button: 0,
    clientX,
    clientY: 100,
    pointerId: 1,
    pointerType: "mouse",
  });
}

describe("AppShell real resize lifecycle", () => {
  let sentinelHandle: HTMLDivElement;
  let originalOffsetHeight: PropertyDescriptor | undefined;
  let originalOffsetLeft: PropertyDescriptor | undefined;
  let originalOffsetWidth: PropertyDescriptor | undefined;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    originalOffsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperties(HTMLElement.prototype, {
      offsetHeight: { configurable: true, get: () => GROUP_HEIGHT },
      offsetLeft: {
        configurable: true,
        get(this: HTMLElement) {
          return elementLeft(this);
        },
      },
      offsetWidth: {
        configurable: true,
        get(this: HTMLElement) {
          return elementWidth(this);
        },
      },
    });
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBoundingClientRect(this: HTMLElement): DOMRect {
        return new DOMRect(elementLeft(this), 0, elementWidth(this), GROUP_HEIGHT);
      });

    // Install the coordinator before react-resizable-panels installs its own
    // document listener. This recreates the long-lived app lifecycle where the
    // coordinator runs first during the initiating capture-phase pointerdown.
    sentinelHandle = document.createElement("div");
    sentinelHandle.setAttribute("aria-orientation", "vertical");
    sentinelHandle.getBoundingClientRect = () => new DOMRect(-100, 0, 1, 1);
    registerHandle(sentinelHandle);
  });

  afterEach(() => {
    cleanup();
    unregisterHandle(sentinelHandle);
    rectSpy.mockRestore();
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight ?? {});
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", originalOffsetLeft ?? {});
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth ?? {});
    while (isResizing()) popResize();
  });

  it("starts and clamps a pointer resize with no other panel group mounted", () => {
    renderShell();
    const separator = appShellSeparator();
    const initialValue = Number(separator.getAttribute("aria-valuenow"));
    expect(initialValue).toBe(32);

    const pointerDownWasNotCancelled = pointerDown(separator);
    act(() => {
      pointerMove(-100);
    });

    expect(pointerDownWasNotCancelled).toBe(false);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(27.5);

    act(() => {
      pointerMove(700);
    });

    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(50);
    pointerUp(700);
  });

  it("clamps keyboard resizing to the same bounds", () => {
    renderShell();
    const separator = appShellSeparator();

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(37);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(27.5);

    fireEvent.keyDown(separator, { key: "End" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(50);
  });

  it("preserves the expanded width across collapse and a foreign resize", () => {
    const panelRef = createRef<PanelImperativeHandle | null>();
    const { rerender } = render(shell(false, panelRef));
    let separator = appShellSeparator();
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(37);

    rerender(shell(true, panelRef));
    act(() => panelRef.current?.collapse());
    expect(panelRef.current?.isCollapsed()).toBe(true);

    act(() => pushResize());
    expect(panelRef.current?.isCollapsed()).toBe(true);
    act(() => popResize());

    // The controller expands before it publishes `collapsed=false`, while the
    // real Panel still has the collapsible constraint needed by expand().
    act(() => panelRef.current?.expand());
    rerender(shell(false, panelRef));
    separator = appShellSeparator();
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(37);
  });
});
