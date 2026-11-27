import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { parseThinkingEffort, type ThinkingEffortLevel } from "@/shared/thinking-effort";
import { ThinkingEffortSegment } from "./ThinkingEffortSegment";

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));

function level(value: string): ThinkingEffortLevel {
  const parsed = parseThinkingEffort(value);
  if (!parsed) throw new Error(`invalid level ${value}`);
  return parsed;
}

const levels = [level("low"), level("medium"), level("high")];

describe("ThinkingEffortSegment in the phone layout", () => {
  it("lists every level in a sheet, the selected one announced, and picks another", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCycle = vi.fn();
    render(
      <ThinkingEffortSegment
        displayedThinkingEffort={levels[1]}
        selectedThinkingEffort={levels[1]}
        supportedThinkingEfforts={levels}
        onCycle={onCycle}
        onChange={onChange}
        trailingSegment
      />,
    );

    await user.click(screen.getByRole("button", { name: "Thinking effort" }));
    await screen.findByRole("dialog", { name: "Thinking effort" });

    const medium = screen.getByRole("button", { name: /Medium/ });
    expect(medium).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /High/ })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: /High/ }));
    expect(onChange).toHaveBeenCalledWith(levels[2]);
    expect(onCycle).not.toHaveBeenCalled();
  });
});
