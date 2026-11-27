import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { RuntimeModelPicker } from "./RuntimeModelPicker";

const toggleFavorite = vi.fn();

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/useFavoriteModels", () => ({
  useFavoriteModels: () => ({ favorites: new Set<string>(), toggleFavorite, isLoading: false }),
}));

function Harness(props: { onSelect: (providerId: string, modelId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <RuntimeModelPicker
      open={open}
      onOpenChange={setOpen}
      providers={[
        {
          id: "claude_code",
          label: "Claude",
          disabled: false,
          models: [
            { id: "opus", label: "Opus" },
            { id: "haiku", label: "Haiku" },
          ],
        },
      ]}
      selectedProviderId="claude_code"
      selectedModelId="opus"
      onSelect={props.onSelect}
      onAfterSelectClose={afterSelectClose}
      trigger={<button type="button">Haiku 5.5</button>}
    />
  );
}

const afterSelectClose = vi.fn();

describe("RuntimeModelPicker in the phone layout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens as a bottom sheet without focusing its search field", async () => {
    const user = userEvent.setup();
    render(<Harness onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Haiku 5.5" }));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const sheet = await screen.findByRole("dialog", { name: "Model" });
    expect(sheet).toHaveAttribute("data-phone-sheet");
    const search = screen.getByPlaceholderText("Search providers or models...");
    expect(search).not.toHaveFocus();
    expect(document.activeElement?.tagName).not.toBe("INPUT");
  });

  it("selects a model, closes and gives focus back to the chip, not the composer", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const chip = screen.getByRole("button", { name: "Haiku 5.5" });

    await user.click(chip);
    await user.click(await screen.findByRole("option", { name: /^Haiku$/ }));

    expect(onSelect).toHaveBeenCalledWith("claude_code", "haiku");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(chip).toHaveFocus());
    expect(afterSelectClose).not.toHaveBeenCalled();
  });
});
