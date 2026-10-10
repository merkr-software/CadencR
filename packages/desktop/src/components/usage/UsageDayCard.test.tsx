import { describe, expect, it } from "vitest";
import { render, screen, within } from "@/test-utils";
import { UsageDayCard } from "./UsageDayCard";

const LABELS: Record<string, string> = {
  claude: "Claude · opus",
  codex: "Codex · gpt-5",
  opencode: "OpenCode · kimi",
};

const labelOf = (key: string): string => LABELS[key] ?? key;

describe("UsageDayCard", () => {
  it("names the day and its total, then lists only the series used that day", () => {
    render(
      <UsageDayCard
        day={{
          day: "2026-07-25",
          total: 1_500,
          segments: [
            { key: "claude", colorIndex: 0, value: 1_000 },
            { key: "opencode", colorIndex: 2, value: 500 },
          ],
        }}
        labelOf={labelOf}
        scale="absolute"
      />,
    );

    expect(screen.getByText("Jul 25")).toBeInTheDocument();
    expect(screen.getByText("1.5K")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Claude · opus")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("1K")).toBeInTheDocument();
    expect(screen.queryByText("Codex · gpt-5")).not.toBeInTheDocument();
  });

  it("reads each series as its part of the day in the share view", () => {
    render(
      <UsageDayCard
        day={{
          day: "2026-07-25",
          total: 4_000,
          segments: [
            { key: "claude", colorIndex: 0, value: 3_000 },
            { key: "codex", colorIndex: 1, value: 1_000 },
          ],
        }}
        labelOf={labelOf}
        scale="share"
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("75%")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("25%")).toBeInTheDocument();
  });
});
