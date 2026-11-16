import type { RefObject } from "react";
import type { useNavigate } from "@tanstack/react-router";
import { useShortcut } from "@/hooks/useShortcut";
import { getActiveFocusZone } from "@/lib/focus-zones";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";

type Navigate = ReturnType<typeof useNavigate>;
type Direction = "up" | "down";

export function useSidebarKeyboardNavigation(
  sidebarRef: RefObject<HTMLElement | null>,
  navigate: Navigate,
  activeFeatureId: number | null,
): void {
  const getNavItems = (): HTMLElement[] =>
    sidebarRef.current ? collectSidebarNavItems(sidebarRef.current) : [];

  const moveFocus = (direction: Direction): void => {
    const items = getNavItems();
    if (items.length === 0) return;
    const focused = document.activeElement as HTMLElement | null;
    const currentItem = focused?.closest<HTMLElement>("[data-virtual-nav-list]") ?? focused;
    const currentIndex = items.findIndex((element) => element === currentItem);
    if (currentIndex >= 0 && focused && dispatchVirtualNavigation(focused, direction)) return;
    const nextIndex = nextNavigationIndex(currentIndex, items.length, direction);
    if (
      items[nextIndex].hasAttribute("data-virtual-nav-list") &&
      dispatchVirtualNavigation(items[nextIndex], direction)
    )
      return;
    items[nextIndex].focus({ focusVisible: true } as FocusOptions);
  };

  useShortcut("sidebar-focus-down", (event) => {
    if (getActiveFocusZone() !== "left-sidebar") return;
    event.preventDefault();
    moveFocus("down");
  });
  useShortcut("sidebar-focus-up", (event) => {
    if (getActiveFocusZone() !== "left-sidebar") return;
    event.preventDefault();
    moveFocus("up");
  });
  useShortcut(
    "sidebar-activate",
    (event) => {
      if (getActiveFocusZone() !== "left-sidebar") return;
      const focused = document.activeElement as HTMLElement | null;
      if (!focused?.hasAttribute("data-nav-item")) return;
      event.preventDefault();
      activateSidebarItem(focused, navigate, activeFeatureId);
    },
    { enableOnFormTags: false, enableOnContentEditable: false },
  );
}

function dispatchVirtualNavigation(element: HTMLElement, direction: Direction): boolean {
  const detail = { direction, handled: false };
  element.dispatchEvent(new CustomEvent("cadencr-sidebar-navigate", { bubbles: true, detail }));
  return detail.handled;
}

function nextNavigationIndex(current: number, count: number, direction: Direction): number {
  if (current === -1) return direction === "down" ? 0 : count - 1;
  if (direction === "down") return current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}

function activateSidebarItem(
  focused: HTMLElement,
  navigate: Navigate,
  activeFeatureId: number | null,
): void {
  const type = focused.getAttribute("data-nav-type");
  const id = focused.getAttribute("data-nav-id");
  const projectId = focused.getAttribute("data-nav-project-id");
  if (type === "feature" && id && projectId) {
    const focusTab = getFocusedTabForFeature(activeFeatureId);
    void navigate({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId, featureId: id },
      search: focusTab ? { focusTab } : undefined,
    });
  } else if (type === "project" && id) {
    focused.click();
  } else if (type === "marketplace") {
    void navigate({ to: "/marketplace" });
  } else if (type === "agents") {
    void navigate({ to: "/agents" });
  } else if (type === "schedules") {
    void navigate({ to: "/schedules" });
  } else if (type === null && focused instanceof HTMLButtonElement) {
    // Fold headers have no route type; dispatch their click because the
    // shortcut prevents Enter's native button activation.
    focused.click();
  }
}

export function collectSidebarNavItems(sidebar: HTMLElement): HTMLElement[] {
  return Array.from(
    sidebar.querySelectorAll<HTMLElement>("[data-nav-item], [data-virtual-nav-list]"),
  ).filter(
    (element) =>
      // Rows inside a closing CollapsibleSection stay mounted for the close
      // animation (200 ms) under aria-hidden; exclude them so keyboard focus
      // never lands on a row that is about to unmount.
      element.closest('[aria-hidden="true"]') == null &&
      (element.hasAttribute("data-virtual-nav-list") ||
        element.closest("[data-virtual-nav-list]") == null),
  );
}
