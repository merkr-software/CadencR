import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { useSetting, type Setting } from "@/hooks/useSetting";
import { BrowserSection } from "./BrowserSection";

vi.mock("@/hooks/useSetting", () => ({
  useSetting: vi.fn(),
}));

type SettingSetter = Setting["setValue"];
type SettingSetterMock = Mock<SettingSetter>;

const setValueByKey = new Map<string, SettingSetterMock>();

function settingSetter(key: string): SettingSetterMock {
  const existing = setValueByKey.get(key);
  if (existing) return existing;
  const setter = vi.fn<SettingSetter>().mockResolvedValue(true);
  setValueByKey.set(key, setter);
  return setter;
}

describe("BrowserSection", () => {
  beforeEach(() => {
    setValueByKey.clear();
    vi.mocked(useSetting).mockImplementation((key: string) => ({
      value: key === "browser_default_mode" ? "normal" : null,
      setValue: settingSetter(key),
      isLoading: false,
      isFetched: true,
      isSaving: false,
    }));
  });

  it("only shows browser mode settings after MCP toggles move to their own section", () => {
    render(<BrowserSection />);

    expect(screen.getByRole("radiogroup", { name: /default browser mode/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /browser tools for agents/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /project coordination for agents/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /workspace memory for agents/i }),
    ).not.toBeInTheDocument();
  });

  it("persists a selected search engine through the non-optimistic settings writer", async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);

    await user.click(screen.getByRole("radio", { name: "DuckDuckGo" }));

    expect(settingSetter("browser_search_engine")).toHaveBeenCalledWith("duckduckgo");
    expect(vi.mocked(useSetting)).toHaveBeenCalledWith("browser_search_engine");
  });
});
