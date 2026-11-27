import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuLabel,
  AdaptiveMenuTrigger,
  AdaptivePopover,
  AdaptivePopoverContent,
  AdaptivePopoverTrigger,
} from "./PhoneSheetMenu";

const mocks = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.phone }));

function SearchPopover({ onOpenAutoFocus }: { onOpenAutoFocus: (event: Event) => void }) {
  return (
    <AdaptivePopover>
      <AdaptivePopoverTrigger asChild>
        <button type="button">Open</button>
      </AdaptivePopoverTrigger>
      <AdaptivePopoverContent sheetTitle="Pick one" onOpenAutoFocus={onOpenAutoFocus}>
        <input aria-label="Search" autoFocus={false} />
      </AdaptivePopoverContent>
    </AdaptivePopover>
  );
}

function Menu({ onPick, keepOpen = false }: { onPick: () => void; keepOpen?: boolean }) {
  return (
    <AdaptiveMenu>
      <AdaptiveMenuTrigger asChild>
        <button type="button">Mode</button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent sheetTitle="Mode">
        <AdaptiveMenuLabel>Autonomy</AdaptiveMenuLabel>
        <AdaptiveMenuItem
          onSelect={(event) => {
            if (keepOpen) event.preventDefault();
            onPick();
          }}
        >
          Plan
        </AdaptiveMenuItem>
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}

describe("AdaptivePopover", () => {
  beforeEach(() => {
    mocks.phone = false;
  });

  it("is a popover on desktop, its own autofocus intact", async () => {
    const user = userEvent.setup();
    const onOpenAutoFocus = vi.fn();
    render(<SearchPopover onOpenAutoFocus={onOpenAutoFocus} />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("textbox", { name: "Search" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector("[data-phone-sheet]")).toBeNull();
    expect(onOpenAutoFocus).toHaveBeenCalled();
  });

  it("is a bottom sheet on phone: grab handle, a name, nothing focused, focus back on close", async () => {
    mocks.phone = true;
    const user = userEvent.setup();
    const onOpenAutoFocus = vi.fn();
    render(<SearchPopover onOpenAutoFocus={onOpenAutoFocus} />);
    const trigger = screen.getByRole("button", { name: "Open" });

    await user.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Pick one" });
    expect(sheet).toHaveAttribute("data-phone-sheet");
    expect(sheet.querySelector('[aria-hidden="true"].rounded-full')).not.toBeNull();
    expect(onOpenAutoFocus).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Search" })).not.toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("AdaptiveMenu", () => {
  beforeEach(() => {
    mocks.phone = false;
  });

  it("is a dropdown menu on desktop", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "Mode" }));
    await user.click(await screen.findByRole("menuitem", { name: "Plan" }));

    expect(onPick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a sheet of 44px rows on phone that runs the item and closes", async () => {
    mocks.phone = true;
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "Mode" }));
    expect(await screen.findByRole("dialog", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Autonomy" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Plan" });
    expect(row).toHaveClass("min-h-11");

    await user.click(row);

    expect(onPick).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stays open on phone when the item prevents its select event", async () => {
    mocks.phone = true;
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Menu onPick={onPick} keepOpen />);

    await user.click(screen.getByRole("button", { name: "Mode" }));
    await user.click(await screen.findByRole("button", { name: "Plan" }));

    expect(onPick).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Mode" })).toBeInTheDocument();
  });
});
