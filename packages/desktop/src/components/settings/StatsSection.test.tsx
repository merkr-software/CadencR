import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { StatsBody, StatsSection } from "./StatsSection";

const useGetUsageStats = vi.fn();

vi.mock("@/api/generated", () => ({
  useGetUsageStats: (...args: unknown[]) => useGetUsageStats(...args),
}));

describe("StatsSection", () => {
  it("keeps the last range on screen while the next one loads", async () => {
    // The 30-day response, still served as placeholder data after 90d is picked.
    useGetUsageStats.mockReturnValue({
      data: {
        days: 30,
        end_day: "2026-07-25",
        entries: [
          {
            day: "2026-07-25",
            provider_id: "claude_code",
            model_id: "opus",
            thinking_effort: "high",
            input_tokens: 10,
            output_tokens: 20,
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<StatsSection />);

    await userEvent.setup().click(screen.getByRole("radio", { name: "90d" }));

    expect(useGetUsageStats).toHaveBeenLastCalledWith({ days: 90 }, expect.anything());
    expect(screen.getAllByRole("img", { name: /tokens exchanged/ })).toHaveLength(30);
  });
});

describe("StatsBody", () => {
  it("keeps cached usage visible when a background refresh fails", () => {
    render(
      <StatsBody
        windowDays={30}
        isLoading={false}
        error={new Error("Network unavailable")}
        hasUsage
      >
        <p>Cached usage chart</p>
      </StatsBody>,
    );

    expect(screen.getByText("Cached usage chart")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not refresh usage stats. Showing the last loaded data. Network unavailable",
    );
  });

  it("uses the blocking error state when there is no usable data", () => {
    render(
      <StatsBody
        windowDays={30}
        isLoading={false}
        error={new Error("Network unavailable")}
        hasUsage={false}
      >
        <p>Unavailable usage chart</p>
      </StatsBody>,
    );

    expect(screen.getByText(/Could not load usage stats/)).toBeVisible();
    expect(screen.queryByText("Unavailable usage chart")).not.toBeInTheDocument();
  });
});
