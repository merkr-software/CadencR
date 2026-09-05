import { describe, expect, it, vi } from "vitest";
import { handleModelChange } from "./WebSocketSessionAgentTab";

type Controls = Parameters<typeof handleModelChange>[2];

function makeControls(currentProviderId: string | undefined) {
  const setProvider = vi.fn();
  const setModel = vi.fn();
  const setThinkingEffort = vi.fn();
  const controls = {
    ws: {
      setProvider,
      setModel,
      setThinkingEffort,
      currentThinkingEffort: undefined,
      currentSelection: currentProviderId
        ? { providerId: currentProviderId, modelId: "old-model" }
        : undefined,
    },
    agentCatalog: { data: { providers: [] } },
    resolveModelThinkingEffort: () => undefined,
  } as unknown as Controls;
  return { controls, setProvider, setModel, setThinkingEffort };
}

describe("handleModelChange", () => {
  it("sends model.set when the provider has not changed", () => {
    const { controls, setProvider, setModel } = makeControls("claude_code");

    handleModelChange("claude_code", "sonnet", controls);

    expect(setModel).toHaveBeenCalledWith("sonnet", "claude_code");
    expect(setProvider).not.toHaveBeenCalled();
  });

  it("sends the atomic provider.set when the provider changes", () => {
    const { controls, setProvider, setModel } = makeControls("claude_code");

    handleModelChange("codex_cli", "gpt-5.6-sol", controls);

    expect(setProvider).toHaveBeenCalledWith("codex_cli", "gpt-5.6-sol");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("sends provider.set when there is no current selection yet", () => {
    const { controls, setProvider, setModel } = makeControls(undefined);

    handleModelChange("claude_code", "sonnet", controls);

    expect(setProvider).toHaveBeenCalledWith("claude_code", "sonnet");
    expect(setModel).not.toHaveBeenCalled();
  });
});
