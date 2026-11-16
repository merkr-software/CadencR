import { useRef, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@/test-utils";
import { useSidebarRowShortcuts } from "@/components/SidebarShortcuts";
import { useRowReorder } from "@/hooks/useRowReorder";
import { dispatchSidebarRowAction } from "@/lib/sidebar-row-actions";
import { SidebarReorderProvider } from "@/components/SidebarReorderProvider";
import { useSidebarReorderStore } from "@/stores/sidebar-reorder-store";

const mocks = vi.hoisted(() => ({ move: vi.fn(), toastMessage: vi.fn() }));

vi.mock("@/hooks/useManualConversationOrder", () => ({
  moveConversation: mocks.move,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(actual.toast, { message: mocks.toastMessage }) };
});
vi.mock("@/lib/shortcuts/format", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PLATFORM_IS_MAC: true,
}));

function Row({ id }: { id: number }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const reorder = useRowReorder(ref, id);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      data-nav-type="feature"
      data-nav-id={String(id)}
      className="sidebar-row"
      {...reorder}
    >
      Row {id}
    </div>
  );
}

const GROUPS = [[1, 2, 3], [4, 5], [6]];
const OTHER_LIST = [[7, 8]];

/** Two sibling groups and a row alone in its own, like a project's tree, then another list. */
function List(): ReactElement {
  useSidebarRowShortcuts();
  return (
    <div data-focus-zone="left-sidebar">
      <SidebarReorderProvider groups={GROUPS}>
        {GROUPS.flat().map((id) => (
          <Row key={id} id={id} />
        ))}
      </SidebarReorderProvider>
      <SidebarReorderProvider groups={OTHER_LIST}>
        {OTHER_LIST.flat().map((id) => (
          <Row key={id} id={id} />
        ))}
      </SidebarReorderProvider>
    </div>
  );
}

function row(id: number): HTMLElement {
  return screen.getByRole("button", { name: `Row ${id}` });
}

function dataTransfer(): DataTransfer {
  return {
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: "none",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

/** happy-dom's drag events drop `clientY` from their init, so set it on the event. */
function dragAt(
  type: "dragOver" | "drop",
  element: HTMLElement,
  transfer: DataTransfer,
  y: number,
) {
  const event = createEvent[type](element, { dataTransfer: transfer });
  Object.defineProperty(event, "clientY", { value: y });
  return fireEvent(element, event);
}

/** happy-dom drops `relatedTarget` from a drag event's init too. */
function dragLeaveTo(element: HTMLElement, relatedTarget: Node | null) {
  const event = createEvent.dragLeave(element);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  return fireEvent(element, event);
}

/** Rows 20px tall, stacked from the top: row n spans [20(n-1), 20n). */
function stubLayout(): void {
  for (const id of [...GROUPS.flat(), ...OTHER_LIST.flat()]) {
    vi.spyOn(row(id), "getBoundingClientRect").mockReturnValue({
      top: (id - 1) * 20,
      height: 20,
      bottom: id * 20,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: (id - 1) * 20,
      toJSON: () => ({}),
    });
  }
}

beforeEach(() => {
  mocks.move.mockReset();
  mocks.move.mockResolvedValue(undefined);
  mocks.toastMessage.mockReset();
  useSidebarReorderStore.getState().clear();
});

describe("useRowReorder drag and drop", () => {
  it("drops a row before a sibling of its group, showing the line while hovering", () => {
    render(<List />);
    stubLayout();
    const transfer = dataTransfer();
    fireEvent.dragStart(row(3), { dataTransfer: transfer });
    expect(row(3)).toHaveAttribute("data-dragging");

    // Upper half of row 1: before it.
    const accepted = dragAt("dragOver", row(1), transfer, 4);
    expect(accepted).toBe(false); // preventDefault: the drop is allowed
    expect(row(1)).toHaveAttribute("data-drop-position", "before");

    dragAt("drop", row(1), transfer, 4);
    expect(mocks.move).toHaveBeenCalledWith([1, 2, 3], 3, { targetId: 1, position: "before" });
    expect(row(1)).not.toHaveAttribute("data-drop-position");
    expect(row(3)).not.toHaveAttribute("data-dragging");
  });

  it("refuses a drop on another group's row", () => {
    render(<List />);
    stubLayout();
    const transfer = dataTransfer();
    fireEvent.dragStart(row(1), { dataTransfer: transfer });
    const accepted = dragAt("dragOver", row(4), transfer, 64);
    expect(accepted).toBe(true); // not prevented: the cursor says "not allowed"
    expect(row(4)).not.toHaveAttribute("data-drop-position");
    dragAt("drop", row(4), transfer, 64);
    expect(mocks.move).not.toHaveBeenCalled();
  });

  it("takes the line away when the pointer leaves the row or moves to another list", () => {
    render(<List />);
    stubLayout();
    const transfer = dataTransfer();
    fireEvent.dragStart(row(3), { dataTransfer: transfer });
    dragAt("dragOver", row(1), transfer, 4);
    expect(row(1)).toHaveAttribute("data-drop-position", "before");
    // Into the row's own content: the line stays.
    dragLeaveTo(row(1), row(1).firstChild);
    expect(row(1)).toHaveAttribute("data-drop-position", "before");
    dragLeaveTo(row(1), document.body);
    expect(row(1)).not.toHaveAttribute("data-drop-position");

    dragAt("dragOver", row(1), transfer, 4);
    const accepted = dragAt("dragOver", row(7), transfer, 124);
    expect(accepted).toBe(true);
    expect(row(1)).not.toHaveAttribute("data-drop-position");
    expect(row(7)).not.toHaveAttribute("data-drop-position");
  });

  it("shows no line where the drop would leave the row in place", () => {
    render(<List />);
    stubLayout();
    const transfer = dataTransfer();
    fireEvent.dragStart(row(2), { dataTransfer: transfer });
    // Lower half of row 1 is where row 2 already sits.
    dragAt("dragOver", row(1), transfer, 15);
    expect(row(1)).not.toHaveAttribute("data-drop-position");
    dragAt("dragOver", row(3), transfer, 55);
    expect(row(3)).toHaveAttribute("data-drop-position", "after");
  });

  it("cancels the drag of a row alone in its group, and clears on dragend", () => {
    render(<List />);
    const transfer = dataTransfer();
    const started = fireEvent.dragStart(row(6), { dataTransfer: transfer });
    expect(started).toBe(false);
    expect(useSidebarReorderStore.getState().drag).toBeNull();

    fireEvent.dragStart(row(4), { dataTransfer: transfer });
    expect(useSidebarReorderStore.getState().drag?.id).toBe(4);
    fireEvent.dragEnd(row(4), { dataTransfer: transfer });
    expect(useSidebarReorderStore.getState().drag).toBeNull();
  });

  it("is not draggable outside a reorder scope, or in a list that can't reorder", () => {
    render(
      <>
        <Row id={9} />
        <SidebarReorderProvider groups={null}>
          <Row id={10} />
        </SidebarReorderProvider>
      </>,
    );
    expect(row(9)).not.toHaveAttribute("draggable");
    expect(row(10)).not.toHaveAttribute("draggable");
  });
});

describe("useRowReorder keyboard moves", () => {
  it("moves the focused row one step within its group with ⌥⇧⌘↑ / ⌥⇧⌘↓", async () => {
    const { user } = render(<List />);
    row(2).focus();
    await user.keyboard("{Meta>}{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}{/Meta}");
    expect(mocks.move).toHaveBeenLastCalledWith([1, 2, 3], 2, { direction: "up" });
    await user.keyboard("{Meta>}{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}{/Meta}");
    expect(mocks.move).toHaveBeenLastCalledWith([1, 2, 3], 2, { direction: "down" });
    await waitFor(() => expect(row(2)).toHaveFocus());
  });

  it("does nothing at the group's edge and says so for a row that can't move", () => {
    render(<List />);
    expect(dispatchSidebarRowAction(row(1), "move-up")).toBe(true);
    expect(dispatchSidebarRowAction(row(5), "move-down")).toBe(true);
    expect(mocks.move).not.toHaveBeenCalled();
    expect(dispatchSidebarRowAction(row(6), "move-up")).toBe(false);
  });
});
