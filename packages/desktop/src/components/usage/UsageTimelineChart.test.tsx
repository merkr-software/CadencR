import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { UsageTimelineChart } from "./UsageTimelineChart";
import type { UsageChartData } from "./usage-stats-model";

function chartOf(days: string[]): UsageChartData {
  return {
    series: [{ key: "claude", colorIndex: 0, inputTokens: 0, outputTokens: 0, userMessages: 0 }],
    days: days.map((day, index) => ({
      day,
      total: (index + 1) * 1_000,
      segments: [{ key: "claude", colorIndex: 0, value: (index + 1) * 1_000 }],
    })),
    max: days.length * 1_000,
    foldedCount: 0,
  };
}

const THREE_DAYS = chartOf(["2026-07-23", "2026-07-24", "2026-07-25"]);

function renderChart(data: UsageChartData) {
  return render(
    <UsageTimelineChart
      data={data}
      labelOf={String}
      density="comfortable"
      scale="absolute"
      metric="total"
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

  it("translates a focused day while keeping its date, count and tab stop", async () => {
    const user = userEvent.setup();
    renderChart(THREE_DAYS);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    const focused = column(/Jul 24/);

    uiI18n.addResourceBundle("fr", "ui", {
      system: {
        usage: {
          dailyTokens: "Jetons quotidiens",
          dayTokens_other: "{{formattedCount}} jetons échangés le {{date}}",
        },
      },
    });
    try {
      const locale = "fr-CA";
      await act(() => uiI18n.changeLanguage(locale));
      const date = new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date("2026-07-24T00:00:00Z"));
      const exact = new Intl.NumberFormat(locale).format(2000);
      expect(screen.getByRole("group", { name: "Jetons quotidiens" })).toBeVisible();
      expect(focused).toHaveFocus();
      expect(focused).toHaveAttribute("aria-label", `${exact} jetons échangés le ${date}`);
      expect(focused).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("tooltip")).toHaveTextContent(date);
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
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
        labelOf={String}
        density="comfortable"
        scale="absolute"
        metric="total"
      />,
    );

    expect(column(/Jul 25/)).toHaveAttribute("tabindex", "0");
  });

  it("stacks the largest series at the base of each column", () => {
    renderChart({
      series: [
        { key: "big", colorIndex: 0, inputTokens: 0, outputTokens: 0, userMessages: 0 },
        { key: "small", colorIndex: 1, inputTokens: 0, outputTokens: 0, userMessages: 0 },
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
      foldedCount: 0,
    });

    // The column stacks bottom-up from its first cell.
    const cells = [...column(/Jul 25/).children] as HTMLElement[];
    expect(cells[0]!.style.backgroundColor).toBe("var(--chart-1)");
    expect(cells.at(-1)!.style.backgroundColor).toBe("var(--chart-4)");
  });
});
