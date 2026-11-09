import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { useSetting, type Setting } from "@/hooks/useSetting";
import type { ContextUsageState } from "@/types/agent";
import { ContextMeter } from "./ContextMeter";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";

vi.mock("@/hooks/useSetting", () => ({ useSetting: vi.fn() }));

const setValue = vi.fn<Setting["setValue"]>().mockResolvedValue(true);

function mockDisplay(value: string | null): void {
  vi.mocked(useSetting).mockReturnValue({
    value,
    setValue,
    isLoading: false,
    isFetched: true,
    isSaving: false,
  });
}

function renderMeter(contextWindow: number | undefined = 200_000) {
  const contextUsage: ContextUsageState = {
    inputTokens: 50_000,
    outputTokens: 0,
    contextWindow,
    wasCompacted: false,
  };
  const value = { contextUsage, isRunning: false } as unknown as ComposerContextValue;
  return render(
    <ComposerContextProvider value={value}>
      <ContextMeter />
    </ComposerContextProvider>,
  );
}

describe("ContextMeter", () => {
  beforeEach(() => setValue.mockClear());

  it.each([
    [null, "25%"],
    ["percent", "25%"],
    ["tokens", "50K / 200K"],
    ["left", "150K left"],
  ])("reads %s as %s", (display, label) => {
    mockDisplay(display);
    renderMeter();
    expect(screen.getByRole("button")).toHaveTextContent(label);
  });

  it("shows the bar alone without a label", () => {
    mockDisplay("bar");
    renderMeter();
    expect(screen.getByRole("button")).toHaveTextContent("");
  });

  it("falls back to tokens used until the window is reported", () => {
    mockDisplay("left");
    renderMeter(undefined);
    expect(screen.getByRole("button")).toHaveTextContent("50K");
  });

  it("saves the next display on click", async () => {
    mockDisplay("percent");
    const { user } = renderMeter();
    await user.click(screen.getByRole("button", { name: /click to change/ }));
    expect(setValue).toHaveBeenCalledWith("tokens");
  });
});
