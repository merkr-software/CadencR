import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen } from "@/test-utils";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { BrowserSection } from "./BrowserSection";

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: vi.fn(),
}));

type SettingSetter = (value: string) => void;
type SettingSetterMock = Mock<SettingSetter>;

const setValueByKey = new Map<string, SettingSetterMock>();

function settingSetter(key: string): SettingSetterMock {
  const existing = setValueByKey.get(key);
  if (existing) return existing;
  const setter = vi.fn<SettingSetter>();
  setValueByKey.set(key, setter);
  return setter;
}

describe("BrowserSection", () => {
  beforeEach(() => {
    setValueByKey.clear();
    vi.mocked(useDebouncedSetting).mockImplementation((key: string) => ({
      value: key === "browser_default_mode" ? "normal" : null,
      setValue: settingSetter(key),
      isLoading: false,
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
});
