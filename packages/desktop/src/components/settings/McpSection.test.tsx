import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen } from "@/test-utils";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { McpSection } from "./McpSection";

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

describe("McpSection", () => {
  beforeEach(() => {
    setValueByKey.clear();
    vi.mocked(useDebouncedSetting).mockImplementation((key: string) => ({
      value: null,
      setValue: settingSetter(key),
      isLoading: false,
    }));
  });

  it("shows each MCP family in its own settings section without per-row MCP chips", () => {
    const { container } = render(<McpSection />);

    expect(screen.getByRole("heading", { name: "MCP" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /browser tools for agents/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /project coordination for agents/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /workspace memory for agents/i })).toBeChecked();
    expect(screen.queryByTestId("mcp-row-tag")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".lucide")).toHaveLength(3);
  });

  it("persists project and workspace MCP toggle changes", async () => {
    const user = userEvent.setup();
    render(<McpSection />);

    await user.click(screen.getByRole("switch", { name: /project coordination for agents/i }));
    await user.click(screen.getByRole("switch", { name: /workspace memory for agents/i }));

    expect(settingSetter("project_mcp_enabled")).toHaveBeenCalledWith("false");
    expect(settingSetter("workspace_mcp_enabled")).toHaveBeenCalledWith("false");
  });
});
