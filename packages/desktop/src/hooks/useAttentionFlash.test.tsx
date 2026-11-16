import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { AttentionState } from "@/lib/sidebar-attention";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useAttentionFlash } from "./useAttentionFlash";

function Row({ state }: { state: AttentionState }) {
  const ref = useRef<HTMLSpanElement>(null);
  useAttentionFlash(ref, state);
  return (
    <div data-nav-type="feature" data-testid="row">
      <span ref={ref} />
    </div>
  );
}

function animationEnd(element: Element, animationName: string): void {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(element, event);
}

beforeEach(() => {
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
});

describe("useAttentionFlash", () => {
  it("never flashes on mount", () => {
    const { getByTestId } = render(<Row state="waiting" />);
    expect(getByTestId("row")).not.toHaveAttribute("data-sidebar-flash");
  });

  it("flashes the row in the new state's color until its own animation ends", () => {
    const { getByTestId, rerender } = render(<Row state="working" />);
    rerender(<Row state="unread" />);
    const row = getByTestId("row");
    expect(row).toHaveAttribute("data-sidebar-flash", "unread");

    animationEnd(row, "sidebar-status-spin");
    expect(row).toHaveAttribute("data-sidebar-flash", "unread");
    animationEnd(row, "sidebar-row-flash");
    expect(row).not.toHaveAttribute("data-sidebar-flash");
  });

  it("stays quiet for working or idle, and when switched off", () => {
    const { getByTestId, rerender } = render(<Row state="idle" />);
    rerender(<Row state="working" />);
    expect(getByTestId("row")).not.toHaveAttribute("data-sidebar-flash");

    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, flashOnChange: false },
    });
    rerender(<Row state="failed" />);
    expect(getByTestId("row")).not.toHaveAttribute("data-sidebar-flash");
  });
});
