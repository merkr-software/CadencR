import { createRef, forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import type { FeatureTerminalTabHandle } from "@/components/FeatureTerminalTab";
import { LazyFeatureTerminalTab } from "./LazyFeatureTerminalTab";

const mocks = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { activate: vi.fn(), loaded, release: () => release() };
});

// The chunk resolves only once the test releases it.
vi.mock("@/components/FeatureTerminalTab", async () => {
  await mocks.loaded;
  return {
    FeatureTerminalTab: forwardRef<FeatureTerminalTabHandle, { featureId: number }>(
      function TerminalTabStub(_props, ref) {
        useImperativeHandle(ref, () => ({ activate: mocks.activate }));
        return <div data-testid="terminal-tab" />;
      },
    ),
  };
});

describe("LazyFeatureTerminalTab", () => {
  it("runs an activate that arrived while its chunk loaded once the terminal mounts", async () => {
    const ref = createRef<FeatureTerminalTabHandle>();
    render(<LazyFeatureTerminalTab ref={ref} featureId={4} projectId={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Terminal…");

    // A requested terminal focus on the conversation's first open.
    act(() => ref.current?.activate());
    expect(mocks.activate).not.toHaveBeenCalled();

    await act(async () => mocks.release());
    expect(await screen.findByTestId("terminal-tab")).toBeInTheDocument();
    expect(mocks.activate).toHaveBeenCalledTimes(1);

    // Once mounted, an activate goes straight through.
    act(() => ref.current?.activate());
    expect(mocks.activate).toHaveBeenCalledTimes(2);
  });
});
