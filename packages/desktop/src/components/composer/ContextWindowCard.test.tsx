import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { ContextUsageState } from "@/types/agent";
import { ContextWindowCard } from "./ContextWindowCard";

function usage(overrides: Partial<ContextUsageState>): ContextUsageState {
  return {
    inputTokens: 120_000,
    outputTokens: 0,
    contextWindow: 200_000,
    wasCompacted: false,
    ...overrides,
  };
}

describe("ContextWindowCard", () => {
  it("states the share used, the free room and a verdict", () => {
    render(<ContextWindowCard usage={usage({})} ratio={0.6} />);
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("Used").nextSibling).toHaveTextContent("120K");
    expect(screen.getByText("Free").nextSibling).toHaveTextContent("80K");
    expect(screen.getByText("Window").nextSibling).toHaveTextContent("200K");
    expect(screen.getByText("Over half used.")).toBeInTheDocument();
  });

  it("never invents a window the provider has not reported", () => {
    render(<ContextWindowCard usage={usage({ contextWindow: null })} ratio={null} />);
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    expect(screen.getByText(/reports the window size at the end of a turn/)).toBeInTheDocument();
  });

  it("notes an earlier compaction", () => {
    render(<ContextWindowCard usage={usage({ wasCompacted: true })} ratio={0.6} />);
    expect(screen.getByText("Compacted earlier in this conversation")).toBeInTheDocument();
  });
});
