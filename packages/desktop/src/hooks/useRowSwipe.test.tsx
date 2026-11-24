import { useRef, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { PinIcon } from "lucide-react";
import { act, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test-utils";
import { MobileDrawer } from "@/components/MobileDrawer";
import { SidebarRowSwipeTray, type RowSwipeAction } from "@/components/SidebarRowSwipeTray";
import { classify, useRowSwipe } from "./useRowSwipe";

const TRAY_WIDTH = 112;

function Row({
  onNavigate,
  actions,
}: {
  onNavigate: () => void;
  actions: RowSwipeAction[];
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useRowSwipe({ ref, enabled: true, trayWidth: TRAY_WIDTH });
  return (
    <div ref={ref} role="button" data-testid="row" data-open={swipe.open} onClick={onNavigate}>
      Conversation
      <SidebarRowSwipeTray featureId={7} swipe={swipe} actions={actions} />
    </div>
  );
}

function setup(actions: RowSwipeAction[] = []) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const view = render(
    <MobileDrawer collapsed={false} onClose={onClose} closeLabel="Close menu">
      <div data-testid="drawer-body">
        <Row onNavigate={onNavigate} actions={actions} />
        <div data-testid="outside">Header</div>
      </div>
    </MobileDrawer>,
  );
  return { ...view, onClose, onNavigate, row: screen.getByTestId("row") };
}

function trayOf(row: HTMLElement): HTMLElement {
  const tray = row.querySelector("[data-row-swipe-tray]");
  if (!(tray instanceof HTMLElement)) throw new Error("tray not found");
  return tray;
}

const offsetOf = (row: HTMLElement): string => trayOf(row).style.getPropertyValue("--row-swipe-x");

/** One finger from the first point through the rest, then lifted. */
function drag(el: HTMLElement, points: Array<[number, number]>): void {
  const at = ([clientX, clientY]: [number, number]) => ({ touches: [{ clientX, clientY }] });
  const [start, ...moves] = points;
  fireEvent.touchStart(el, at(start));
  for (const point of moves) fireEvent.touchMove(el, at(point));
  fireEvent.touchEnd(el, { touches: [] });
}

describe("useRowSwipe", () => {
  it("opens the tray on a left swipe without closing the drawer", () => {
    const { row, onClose } = setup();
    drag(row, [
      [250, 100],
      [235, 101],
      [200, 102],
      [150, 102],
    ]);
    expect(row).toHaveAttribute("data-open", "true");
    expect(offsetOf(row)).toBe(`${TRAY_WIDTH}px`);
    // Past the drawer's own 48px swipe threshold, yet the drawer stayed open.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("springs back when released before half the tray", () => {
    const { row } = setup();
    drag(row, [
      [250, 100],
      [235, 100],
      [210, 100],
    ]);
    expect(row).toHaveAttribute("data-open", "false");
    expect(offsetOf(row)).toBe("");
  });

  it("writes nothing on mount: a closed tray reads the stylesheet's default", () => {
    const { row } = setup();
    expect(offsetOf(row)).toBe("");
    expect(row.style.getPropertyValue("--row-swipe-x")).toBe("");
  });

  it("settles the drag as a release when a second finger lands", () => {
    const { row } = setup();
    const at = (clientX: number) => ({ touches: [{ clientX, clientY: 100 }] });
    fireEvent.touchStart(row, at(250));
    fireEvent.touchMove(row, at(235));
    fireEvent.touchMove(row, at(150));
    expect(trayOf(row)).toHaveAttribute("data-dragging");
    fireEvent.touchStart(row, {
      touches: [
        { clientX: 150, clientY: 100 },
        { clientX: 60, clientY: 120 },
      ],
    });
    expect(trayOf(row)).not.toHaveAttribute("data-dragging");
    expect(row).toHaveAttribute("data-open", "true");
    expect(offsetOf(row)).toBe(`${TRAY_WIDTH}px`);
    // Later moves of either finger no longer drag the tray.
    fireEvent.touchMove(row, at(240));
    expect(offsetOf(row)).toBe(`${TRAY_WIDTH}px`);
  });

  it("settles the drag when a second finger lands on another row", () => {
    const { row } = setup();
    const at = (clientX: number) => ({ touches: [{ clientX, clientY: 100 }] });
    fireEvent.touchStart(row, at(250));
    fireEvent.touchMove(row, at(235));
    fireEvent.touchMove(row, at(150));
    // The other finger's touchstart fires on another row; this row only sees
    // its own finger move with two touches down.
    fireEvent.touchMove(row, {
      touches: [
        { clientX: 150, clientY: 100 },
        { clientX: 60, clientY: 300 },
      ],
    });
    expect(trayOf(row)).not.toHaveAttribute("data-dragging");
    expect(row).toHaveAttribute("data-open", "true");
  });

  it("snaps the tray closed when the touch is cancelled, however far it went", () => {
    const { row } = setup();
    const at = (clientX: number) => ({ touches: [{ clientX, clientY: 100 }] });
    fireEvent.touchStart(row, at(250));
    fireEvent.touchMove(row, at(235));
    fireEvent.touchMove(row, at(120));
    fireEvent.touchCancel(row, { touches: [] });
    expect(row).toHaveAttribute("data-open", "false");
    expect(offsetOf(row)).toBe("");
    expect(trayOf(row)).not.toHaveAttribute("data-dragging");
  });

  it("reads a diagonal drag that has gone the intent distance as a scroll, for good", () => {
    const { row } = setup();
    // 12px down and 14px left: not clearly horizontal, so the list scrolls...
    drag(row, [
      [250, 100],
      [236, 112],
      // ...and a later sideways run of the same touch never swipes.
      [150, 114],
    ]);
    expect(row).toHaveAttribute("data-open", "false");
    expect(offsetOf(row)).toBe("");
  });

  it("leaves a vertical drag to the scroll and the drawer's swipe to the rest of the panel", () => {
    const { row, onClose } = setup();
    drag(row, [
      [250, 100],
      [248, 115],
      [180, 160],
    ]);
    expect(row).toHaveAttribute("data-open", "false");

    drag(screen.getByTestId("outside"), [
      [250, 300],
      [235, 300],
      [180, 300],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a rightward drag on a closed row", () => {
    const { row, onClose } = setup();
    drag(row, [
      [100, 100],
      [115, 100],
      [180, 100],
    ]);
    expect(row).toHaveAttribute("data-open", "false");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("swallows the click a swipe leaves behind and closes on a tap instead of opening", () => {
    const { row, onNavigate } = setup();
    drag(row, [
      [250, 100],
      [235, 100],
      [150, 100],
    ]);
    fireEvent.click(row);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("data-open", "true");

    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    fireEvent.click(row);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("data-open", "false");

    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("closes when a touch lands elsewhere", () => {
    const { row } = setup();
    drag(row, [
      [250, 100],
      [235, 100],
      [150, 100],
    ]);
    fireEvent.touchStart(screen.getByTestId("outside"), { touches: [{ clientX: 5, clientY: 5 }] });
    expect(row).toHaveAttribute("data-open", "false");
  });
});

describe("classify", () => {
  it("waits, swipes, or scrolls", () => {
    expect(classify(-6, 2, 0)).toBe("pending");
    expect(classify(-20, 4, 0)).toBe("drag");
    expect(classify(20, 4, 0)).toBe("scroll");
    expect(classify(20, 4, TRAY_WIDTH)).toBe("drag");
    expect(classify(-12, 10, 0)).toBe("scroll");
    expect(classify(-4, 12, 0)).toBe("scroll");
  });
});

describe("SidebarRowSwipeTray", () => {
  it("runs an action without opening the conversation and opens on keyboard focus", () => {
    const onSelect = vi.fn();
    const { row, onNavigate } = setup([
      { key: "archive", label: "Archive", ariaLabel: "Archive “Chat”", icon: PinIcon, onSelect },
    ]);
    const button = screen.getByRole("button", { name: "Archive “Chat”" });
    act(() => button.focus());
    expect(row).toHaveAttribute("data-open", "true");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("data-open", "false");
  });

  it("stays open and busy while its write is in flight, closing once the backend answers", async () => {
    const queryClient = createTestQueryClient();
    let answer: () => void = () => {};
    const onSelect = vi.fn(() => {
      const mutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey: ["updateFeaturePinned"],
        mutationFn: () => new Promise<void>((resolve) => (answer = resolve)),
      });
      void mutation.execute({ id: 7, data: { pinned: true } });
    });
    const onClose = vi.fn();
    render(
      <MobileDrawer collapsed={false} onClose={onClose} closeLabel="Close menu">
        <Row
          onNavigate={vi.fn()}
          actions={[
            {
              key: "pin",
              label: "Pin",
              ariaLabel: "Pin “Chat”",
              icon: PinIcon,
              onSelect,
              mutationKey: ["updateFeaturePinned"],
            },
          ]}
        />
      </MobileDrawer>,
      { queryClient },
    );
    const row = screen.getByTestId("row");
    const pin = screen.getByRole("button", { name: "Pin “Chat”" });
    act(() => pin.focus());
    fireEvent.click(pin);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(pin).toHaveAttribute("aria-busy", "true");
    expect(pin).toBeDisabled();
    expect(row).toHaveAttribute("data-open", "true");

    // The write reaches its request once the mutation's start hooks have run.
    await act(async () => {});
    act(() => answer());
    await waitFor(() => expect(pin).not.toHaveAttribute("aria-busy"));
    expect(row).toHaveAttribute("data-open", "false");
  });

  it("stays closed when focus comes back to an action without a keyboard", () => {
    const { row } = setup([
      {
        key: "archive",
        label: "Archive",
        ariaLabel: "Archive “Chat”",
        icon: PinIcon,
        onSelect: vi.fn(),
      },
    ]);
    const button = screen.getByRole("button", { name: "Archive “Chat”" });
    // A dialog closing after a tap hands focus back: not `:focus-visible`.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ":focus-visible" ? false : matches.call(this, selector);
    });
    act(() => button.focus());
    expect(row).toHaveAttribute("data-open", "false");
    vi.restoreAllMocks();
  });
});
