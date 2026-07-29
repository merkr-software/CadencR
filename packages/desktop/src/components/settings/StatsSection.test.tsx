import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { StatsBody } from "./StatsSection";

describe("StatsBody", () => {
  it("keeps cached usage visible when a background refresh fails", () => {
    render(
      <StatsBody isLoading={false} error={new Error("Network unavailable")} hasUsage>
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
      <StatsBody isLoading={false} error={new Error("Network unavailable")} hasUsage={false}>
        <p>Unavailable usage chart</p>
      </StatsBody>,
    );

    expect(screen.getByText(/Could not load usage stats/)).toBeVisible();
    expect(screen.queryByText("Unavailable usage chart")).not.toBeInTheDocument();
  });
});
