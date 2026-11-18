import { describe, expect, it, vi } from "vitest";
import { changeFastMode, handleModelChange } from "./WebSocketSessionAgentTab";

type Controls = Parameters<typeof handleModelChange>[2];

function makeControls(currentProviderId: string | undefined, supportsConfigInheritance = false) {
  const setProvider = vi.fn();
  const setModel = vi.fn();
  const setThinkingEffort = vi.fn();
  const setRuntimeOverrides = vi.fn().mockResolvedValue(undefined);
  const queueRuntimeOverride = vi.fn();
  const setFastMode = vi.fn().mockResolvedValue(undefined);
  const controls = {
    ws: {
      setProvider,
      setModel,
      setThinkingEffort,
      setRuntimeOverrides,
      queueRuntimeOverride,
      setFastMode,
      currentThinkingEffort: undefined,
      currentSelection: currentProviderId
        ? { providerId: currentProviderId, modelId: "old-model" }
        : undefined,
    },
    agentCatalog: { data: { providers: [] } },
    supportsConfigInheritance,
  } as unknown as Controls;
  return {
    controls,
    setProvider,
    setModel,
    setThinkingEffort,
    setRuntimeOverrides,
    queueRuntimeOverride,
    setFastMode,
  };
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

  it("leaves the thinking level to the backend on every model change", () => {
    const { controls, setThinkingEffort } = makeControls("claude_code");

    handleModelChange("claude_code", "sonnet", controls);
    handleModelChange("codex_cli", "gpt-5.6-sol", controls);

    expect(setThinkingEffort).not.toHaveBeenCalled();
  });

  it("queues an explicit model override only when config inheritance is supported", () => {
    const { controls, setModel, setRuntimeOverrides, queueRuntimeOverride } = makeControls(
      "codex_cli",
      true,
    );
    handleModelChange("codex_cli", "gpt-5.6-sol", controls);
    // Through the session command queue, so it waits for a reconnect like model.set.
    expect(queueRuntimeOverride).toHaveBeenCalledWith({ model: "gpt-5.6-sol" });
    expect(setRuntimeOverrides).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("changeFastMode", () => {
  it("queues a fast mode override like the model and effort ones", async () => {
    const { controls, setRuntimeOverrides, queueRuntimeOverride, setFastMode } = makeControls(
      "codex_cli",
      true,
    );
    await changeFastMode(controls, true);
    // Through the session command queue: no 10 s request, replayed after a reconnect.
    expect(queueRuntimeOverride).toHaveBeenCalledWith({ fast_mode: true });
    expect(setRuntimeOverrides).not.toHaveBeenCalled();
    expect(setFastMode).not.toHaveBeenCalled();
  });

  it("sends fast_mode.set when the provider has no runtime overrides", async () => {
    const { controls, queueRuntimeOverride, setFastMode } = makeControls("claude_code");
    await changeFastMode(controls, true);
    expect(setFastMode).toHaveBeenCalledWith(true);
    expect(queueRuntimeOverride).not.toHaveBeenCalled();
  });
});
