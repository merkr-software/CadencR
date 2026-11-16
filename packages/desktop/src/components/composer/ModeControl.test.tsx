import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { PROVIDER_IDS } from "@/lib/providers";
import { ModeControl } from "./ModeControl";

describe("ModeControl", () => {
  it("names the mode with its provider-neutral autonomy level", () => {
    render(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="plan"
        onSelect={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Mode: Plan\. Read-only/ });
    expect(trigger).toHaveAttribute("data-risk", "read");
  });

  it("keeps each provider's own mode color", () => {
    const { rerender } = render(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="plan"
        onSelect={vi.fn()}
      />,
    );
    // Claude's Plan is green, as in its CLI; Codex's Plan stays fuchsia.
    expect(screen.getByRole("button", { name: /Mode: Plan/ }).style.color).toBe("var(--acc-green)");
    rerender(
      <ModeControl providerId={PROVIDER_IDS.CODEX_CLI} permissionMode="plan" onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Mode: Plan/ }).style.color).toBe(
      "var(--chip-fuchsia-fg)",
    );
  });

  it("lists every mode in a menu and jumps straight to the picked one", async () => {
    const onSelect = vi.fn();
    const { user } = render(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="acceptEdits"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Mode: Auto-Accept Edits/ }));
    expect(screen.getByRole("menuitem", { name: /Auto Acts on its own/ })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Plan Read-only/ }));
    expect(onSelect).toHaveBeenCalledWith("plan");
  });

  it("announces a change made elsewhere (Shift+Tab)", () => {
    const { rerender } = render(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="acceptEdits"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("");
    rerender(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="plan"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Mode changed to Plan: Read-only");
  });

  it("warns when the model can't hold the mode", () => {
    render(
      <ModeControl
        providerId={PROVIDER_IDS.CLAUDE_CODE}
        permissionMode="auto"
        onSelect={vi.fn()}
        incompatibleReason="This model can't run Auto"
      />,
    );
    expect(screen.getByLabelText("This model can't run Auto")).toBeInTheDocument();
  });
});
