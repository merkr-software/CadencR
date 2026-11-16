import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/test-utils";
import type { UsageStatsEntry } from "@/api/generated";
import { SessionUsageChart } from "./SessionUsageChart";

const useGetUsageStats = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

vi.mock("@/api/generated", () => ({
  useGetUsageStats: (...args: unknown[]) => useGetUsageStats(...args),
}));

const END_DAY = "2026-07-25";

function entry(overrides: Partial<UsageStatsEntry>): UsageStatsEntry {
  return {
    day: END_DAY,
    provider_id: "claude_code",
    model_id: "claude-opus-4-8",
    thinking_effort: "high",
    input_tokens: 400,
    output_tokens: 600,
    user_messages: 2,
    ...overrides,
  };
}

function respond(state: { data?: unknown; isLoading?: boolean; error?: unknown }): void {
  useGetUsageStats.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    ...state,
  });
}

describe("SessionUsageChart", () => {
  beforeEach(() => {
    useGetUsageStats.mockReset();
    window.localStorage.clear();
  });

  it("asks for the trailing 30 days, the same query the Settings 30d range uses", () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [] } });
    render(<SessionUsageChart />);

    expect(useGetUsageStats).toHaveBeenCalledWith({ days: 30 });
  });

  it("renders nothing when there is no usage, so the tips stay the whole empty state", () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [] } });
    render(<SessionUsageChart />);

    expect(screen.queryByLabelText("Messages sent over the last 30 days")).not.toBeInTheDocument();
  });

  it("names its unit, and switches to tokens and back from a discreet toggle", async () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [entry({})] } });
    const user = userEvent.setup();
    render(<SessionUsageChart />);

    expect(screen.getByText("Messages sent over the last 30 days")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Messages" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Tokens" }));

    expect(screen.getByText("Tokens exchanged over the last 30 days")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Jul 25: 1,000 tokens exchanged" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Messages" }));

    expect(screen.getByRole("img", { name: "Jul 25: 2 messages sent" })).toBeInTheDocument();
  });

  it("remembers the measure picked last", async () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [entry({})] } });
    const { unmount } = render(<SessionUsageChart />);
    await userEvent.setup().click(screen.getByRole("radio", { name: "Tokens" }));
    unmount();

    render(<SessionUsageChart />);

    expect(screen.getByRole("radio", { name: "Tokens" })).toHaveAttribute("aria-checked", "true");
  });

  it("says so when the pick cannot be remembered, and still applies it", async () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [entry({})] } });
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SessionUsageChart />);

    await userEvent.setup().click(screen.getByRole("radio", { name: "Tokens" }));

    expect(toastError).toHaveBeenCalledWith(
      "Could not remember the chart measure. It resets on the next session.",
    );
    expect(screen.getByText("Tokens exchanged over the last 30 days")).toBeInTheDocument();
    setItem.mockRestore();
  });

  it("keeps the toggle when the measure on screen has nothing to chart", async () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [entry({ user_messages: 0 })] } });
    render(<SessionUsageChart />);

    expect(screen.getByText("No messages sent in the last 30 days.")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("radio", { name: "Tokens" }));

    expect(screen.getAllByRole("img")).toHaveLength(30);
  });

  it("charts messages sent per provider and model, with thinking levels folded together", async () => {
    respond({
      data: {
        days: 30,
        end_day: END_DAY,
        entries: [
          entry({ thinking_effort: "low", user_messages: 3 }),
          entry({ thinking_effort: "high", user_messages: 4 }),
          entry({
            provider_id: "codex_cli",
            model_id: "gpt-5-codex",
            thinking_effort: "medium",
            // Far more tokens, fewer prompts: the chart counts prompts.
            input_tokens: 90_000,
            output_tokens: 90_000,
            user_messages: 2,
          }),
        ],
      },
    });
    render(<SessionUsageChart />);

    expect(screen.getByRole("img", { name: "Jul 25: 9 messages sent" })).toBeInTheDocument();
    // The overview is the grid alone: the breakdown waits in the hover card.
    await userEvent.setup().hover(screen.getByRole("img", { name: /Jul 25/ }));
    const card = await screen.findByText("Claude · claude-opus-4-8");
    const claude = card.closest("li")!;
    // Two providers, not three rows: the two Claude efforts share one series.
    expect(within(claude).getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Codex · gpt-5-codex")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps the breakdown out of the page until a day is hovered", () => {
    respond({ data: { days: 30, end_day: END_DAY, entries: [entry({})] } });
    render(<SessionUsageChart />);

    expect(screen.getAllByRole("img")).toHaveLength(30);
    expect(screen.queryByText("Claude · claude-opus-4-8")).not.toBeInTheDocument();
  });

  it("shows a loading state while the first response is pending", () => {
    respond({ isLoading: true });
    render(<SessionUsageChart />);

    expect(screen.getByLabelText("Loading usage")).toHaveAttribute("aria-busy", "true");
  });

  it("surfaces a failed first load instead of hiding the chart silently", () => {
    respond({ error: new Error("Network unavailable") });
    render(<SessionUsageChart />);

    expect(screen.getByText(/Usage is unavailable right now/)).toHaveTextContent(
      "Usage is unavailable right now. Network unavailable",
    );
  });

  it("keeps the last loaded chart and says so when a refresh fails", () => {
    respond({
      data: { days: 30, end_day: END_DAY, entries: [entry({})] },
      error: new Error("Network unavailable"),
    });
    render(<SessionUsageChart />);

    expect(screen.getByText(/Could not refresh usage/)).toHaveTextContent(
      "Could not refresh usage. Showing the last loaded data. Network unavailable",
    );
    expect(screen.getByLabelText("Messages sent over the last 30 days")).toBeInTheDocument();
  });
});
