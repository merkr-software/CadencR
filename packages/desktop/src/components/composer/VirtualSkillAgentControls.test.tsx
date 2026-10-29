import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { VirtualSkillAgentControls } from "./VirtualSkillAgentControls";

vi.mock("@/api/agentRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/agentRuntime")>()),
  useAgentCatalog: () => ({
    data: {
      default_provider: "claude_code",
      providers: [
        {
          id: "claude_code",
          label: "Claude Code",
          status: "available",
          default_model: "sonnet",
          models: [{ id: "haiku", label: "Haiku", supports_effort: false }],
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}));

describe("VirtualSkillAgentControls", () => {
  it("leaves the mode to the agent until the user picks one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const target = { providerId: "claude_code", modelId: "haiku" };
    render(
      <VirtualSkillAgentControls config={{ target }} onChange={onChange} shortcutsActive={false} />,
    );

    // A pinned model alone pins no mode: nothing would write `--mode=`.
    const agentPicks = screen.getByRole("button", { name: "Mode: the agent picks. Choose a mode" });
    await user.click(agentPicks);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ target, permissionMode: expect.any(String) }),
    );
  });
});
