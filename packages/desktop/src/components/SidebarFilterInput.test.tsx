import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { useSidebarFilterStore } from "@/stores/sidebar-filter-store";
import { handleSidebarTypeToFilter, SidebarFilterInput } from "./SidebarFilterInput";

function SidebarHarness({ onOpen }: { onOpen: () => void }) {
  return (
    <aside data-app-sidebar onKeyDown={handleSidebarTypeToFilter}>
      <SidebarFilterInput />
      <div role="button" tabIndex={0} data-nav-type="feature" data-nav-id="1" onClick={onOpen}>
        Fix login
      </div>
      <input aria-label="Rename" />
    </aside>
  );
}

beforeEach(() => useSidebarFilterStore.getState().close());

describe("sidebar type-to-filter", () => {
  it("opens the field with the typed character and keeps typing in it", async () => {
    const { user } = render(<SidebarHarness onOpen={vi.fn()} />);
    screen.getByRole("button", { name: "Fix login" }).focus();
    await user.keyboard("fi");
    const field = screen.getByRole("textbox", { name: "Filter conversations" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("fi");
    expect(useSidebarFilterStore.getState().query).toBe("fi");
  });

  it("leaves shortcuts, Space and other fields alone", async () => {
    const { user } = render(<SidebarHarness onOpen={vi.fn()} />);
    screen.getByRole("button", { name: "Fix login" }).focus();
    await user.keyboard("{Meta>}k{/Meta} ");
    screen.getByRole("textbox", { name: "Rename" }).focus();
    await user.keyboard("x");
    expect(useSidebarFilterStore.getState().isOpen).toBe(false);
  });

  it("clears on Escape and hands focus back to the row", async () => {
    const { user } = render(<SidebarHarness onOpen={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Fix login" });
    row.focus();
    await user.keyboard("f{Escape}");
    expect(useSidebarFilterStore.getState()).toMatchObject({ isOpen: false, query: "" });
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("opens the first result on Enter and moves into the results on ↓", async () => {
    const onOpen = vi.fn();
    const { user } = render(<SidebarHarness onOpen={onOpen} />);
    screen.getByRole("button", { name: "Fix login" }).focus();
    await user.keyboard("f{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Fix login" })).toHaveFocus();
  });

  it("keeps the query when typing resumes from a result row", async () => {
    const { user } = render(<SidebarHarness onOpen={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Fix login" });
    row.focus();
    await user.keyboard("f{ArrowDown}i");
    const field = screen.getByRole("textbox", { name: "Filter conversations" });
    expect(field).toHaveValue("fi");
    expect(field).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe("sidebar filter focus return", () => {
  it("finds the row again when filtering re-mounted it", async () => {
    function Remounting() {
      const query = useSidebarFilterStore((state) => state.query);
      return (
        <aside data-app-sidebar onKeyDown={handleSidebarTypeToFilter}>
          <SidebarFilterInput />
          <div key={query} role="button" tabIndex={0} data-nav-type="feature" data-nav-id="7">
            Row
          </div>
        </aside>
      );
    }
    const { user } = render(<Remounting />);
    screen.getByRole("button", { name: "Row" }).focus();
    await user.keyboard("r{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Row" })).toHaveFocus());
  });
});
