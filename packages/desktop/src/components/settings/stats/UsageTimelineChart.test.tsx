import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { UsageTimelineChart } from "./UsageTimelineChart";
import type { UsageChartData } from "./usage-stats-model";

function chartOf(days: string[]): UsageChartData {
  return {
    series: [
      { key: "claude", label: "Claude", colorIndex: 0, inputTokens: 0, outputTokens: 0, value: 0 },
    ],
    days: days.map((day, index) => ({
      day,
      total: (index + 1) * 1_000,
      segments: [{ key: "claude", colorIndex: 0, value: (index + 1) * 1_000 }],
    })),
    max: days.length * 1_000,
    grandTotal: 0,
  };
}

const THREE_DAYS = chartOf(["2026-07-23", "2026-07-24", "2026-07-25"]);

function renderChart(data: UsageChartData) {
  return render(
    <UsageTimelineChart
      data={data}
      density="comfortable"
      scale="absolute"
      metricLabel="tokens exchanged"
    />,
  );
}

function column(name: RegExp): HTMLElement {
  return screen.getByRole("img", { name });
}

describe("UsageTimelineChart", () => {
  it("is one tab stop, and the arrow keys walk the days with the card following", async () => {
    const user = userEvent.setup();
    renderChart(THREE_DAYS);

    await user.tab();
    expect(column(/Jul 23/)).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Jul 23");

    await user.keyboard("{ArrowRight}");
    expect(column(/Jul 24/)).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jul 24");
    expect(column(/Jul 24/)).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);

    await user.keyboard("{End}");
    expect(column(/Jul 25/)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(column(/Jul 23/)).toHaveFocus();
    expect(screen.getAllByRole("img").filter((day) => day.tabIndex === 0)).toHaveLength(1);
  });

  it("opens one shared card on hover and closes it when the pointer leaves", async () => {
    const user = userEvent.setup();
    renderChart(THREE_DAYS);

    await user.hover(column(/Jul 24/));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Jul 24");
    await user.hover(column(/Jul 25/));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jul 25");

    await user.unhover(screen.getByRole("group"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps a tab stop when a shorter range drops the focused day", async () => {
    const user = userEvent.setup();
    const { rerender } = renderChart(THREE_DAYS);
    await user.tab();
    await user.keyboard("{End}");

    rerender(
      <UsageTimelineChart
        data={chartOf(["2026-07-25"])}
        density="comfortable"
        scale="absolute"
        metricLabel="tokens exchanged"
      />,
    );

    expect(column(/Jul 25/)).toHaveAttribute("tabindex", "0");
  });

  it("stacks the largest series at the base of each column", () => {
    renderChart({
      series: [
        { key: "big", label: "Big", colorIndex: 0, inputTokens: 0, outputTokens: 0, value: 0 },
        { key: "small", label: "Small", colorIndex: 1, inputTokens: 0, outputTokens: 0, value: 0 },
      ],
      days: [
        {
          day: "2026-07-25",
          total: 12,
          segments: [
            { key: "big", colorIndex: 0, value: 9 },
            { key: "small", colorIndex: 1, value: 3 },
          ],
        },
      ],
      max: 12,
      grandTotal: 12,
    });

    // The column stacks bottom-up from its first cell.
    const cells = [...column(/Jul 25/).children] as HTMLElement[];
    expect(cells[0]!.style.backgroundColor).toBe("var(--chart-1)");
    expect(cells.at(-1)!.style.backgroundColor).toBe("var(--chart-4)");
  });
});
