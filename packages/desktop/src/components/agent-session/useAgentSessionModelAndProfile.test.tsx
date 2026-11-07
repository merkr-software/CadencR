import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@/test-utils";
import type { useAgentCatalog } from "../../api/agentRuntime";
import type { AgentSessionProps } from "./types";
import { useAgentSessionModelAndProfile } from "./useAgentSessionModelAndProfile";

vi.mock("./useClaudeProfileSelection", () => ({
  useClaudeProfileSelection: () => ({ selectedClaudeProfile: "work" }),
}));

const catalog = {
  default_provider: "claude_code",
  providers: [
    {
      id: "claude_code",
      label: "Claude",
      status: "available",
      models: [{ id: "haiku", label: "Haiku" }],
      default_model: "haiku",
      profile_capability: { supports_config_inheritance: false },
    },
  ],
} as unknown as NonNullable<ReturnType<typeof useAgentCatalog>["data"]>;

function sendWith(props: Partial<AgentSessionProps>) {
  const onSend = vi.fn();
  const { result } = renderHook(() =>
    useAgentSessionModelAndProfile(
      { blocks: [], onSend, ...props } as unknown as AgentSessionProps,
      catalog,
      vi.fn(),
    ),
  );
  void result.current.handleSend("hello");
  return onSend.mock.calls[0]?.[2];
}

describe("useAgentSessionModelAndProfile prompt profile", () => {
  it("attaches the profile when the session runs the provider the composer shows", () => {
    expect(
      sendWith({
        selection: { providerId: "claude_code", modelId: "haiku" },
        runtimeProvider: "claude_code",
      }),
    ).toBe("work");
  });

  it("drops the profile while the composer shows a fallback for another provider", () => {
    // OpenCode is missing from the catalog (unavailable), so the composer
    // falls back to Claude while the session still runs OpenCode.
    expect(
      sendWith({ selection: { providerId: "opencode", modelId: "" }, runtimeProvider: "opencode" }),
    ).toBeUndefined();
  });

  it("keeps a fresh session's pick before the session confirms its provider", () => {
    // `session.init` carries no profile, so the first prompt must.
    expect(sendWith({})).toBe("work");
  });
});
