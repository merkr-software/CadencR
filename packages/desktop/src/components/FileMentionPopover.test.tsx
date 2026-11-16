import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { FileMentionPopover } from "./FileMentionPopover";

describe("FileMentionPopover", () => {
  it("renders files and folders as listbox options, name first", () => {
    render(
      <FileMentionPopover
        listId="files"
        items={[
          { path: "src/app.ts", isDir: false },
          { path: "src/components", isDir: true },
        ]}
        selectedIndex={0}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("listbox", { name: "Files" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("id", "files-opt-0");
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("components/")).toBeInTheDocument();
  });

  it("calls onSelect with the full path on mouse down", async () => {
    const onSelect = vi.fn();
    const { user } = render(
      <FileMentionPopover
        listId="files"
        items={[{ path: "src/utils.ts", isDir: false }]}
        selectedIndex={0}
        onSelect={onSelect}
      />,
    );
    await user.pointer({ keys: "[MouseLeft>]", target: screen.getByRole("option") });
    expect(onSelect).toHaveBeenCalledWith("src/utils.ts");
  });
});
