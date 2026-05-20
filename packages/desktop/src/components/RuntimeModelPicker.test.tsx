import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { RuntimeModelPicker } from "./RuntimeModelPicker";

function Harness(props: {
  onSelect?: (providerId: string, modelId: string) => void;
  onAfterSelectClose?: () => void;
  models?: Array<{ id: string; label: string }>;
}) {
  const {
    models = [{ id: "opus", label: "Opus" }],
    onSelect = vi.fn(),
    onAfterSelectClose = vi.fn(),
  } = props;
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
          models,
        },
      ]}
      selectedProviderId="claude_code"
      selectedModelId="opus"
      onSelect={onSelect}
      onAfterSelectClose={onAfterSelectClose}
      trigger={<button type="button">Open picker</button>}
    />
  );
}

describe("RuntimeModelPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the post-close callback after selecting a model", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onAfterSelectClose = vi.fn();

    render(<Harness onSelect={onSelect} onAfterSelectClose={onAfterSelectClose} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await user.click(screen.getByRole("option", { name: /Claude \/ Opus/i }));

    expect(onSelect).toHaveBeenCalledWith("claude_code", "opus");
    await waitFor(() => expect(onAfterSelectClose).toHaveBeenCalled());
  });

  it("focuses and scrolls to the selected model when opened", async () => {
    const user = userEvent.setup();
    const models = [
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
      })),
      { id: "opus", label: "Opus" },
    ];

    render(<Harness models={models} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const selectedOption = screen.getByRole("option", { name: /Claude \/ Opus/i });
    await waitFor(() => expect(selectedOption).toHaveAttribute("data-selected", "true"));
    await waitFor(() =>
      expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      }),
    );
  });

  it("resets the results scroll position when the filter changes", async () => {
    const user = userEvent.setup();
    const models = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${index}`,
      label: index === 29 ? "Opus Max" : `Model ${index}`,
    }));

    render(<Harness models={models} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const list = document.querySelector('[data-slot="command-list"]');
    expect(list).toBeInstanceOf(HTMLElement);
    const commandList = list as HTMLElement;
    commandList.scrollTop = 240;

    await user.type(screen.getByPlaceholderText("Search providers or models..."), "Op");

    await waitFor(() => expect(commandList.scrollTop).toBe(0));
  });
});
