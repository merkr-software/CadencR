import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoLayoutStore } from "@/stores/auto-layout-store";

import { AutoLayoutToggle } from "./AutoLayoutToggle";

vi.mock("@/lib/auto-layout/auto-layout-mode", () => ({
  useAutoLayoutMode: () => ({
    active: true,
    isLoading: false,
    error: null,
    isSaving: false,
    setActive: vi.fn(),
  }),
}));
vi.mock("@/hooks/useShortcut", () => ({ useShortcut: (): void => {} }));

const FEATURE = 9;

function bumpPulse(): void {
  act(() => {
    useAutoLayoutStore.setState((s) => ({
      pulse: { ...s.pulse, [FEATURE]: (s.pulse[FEATURE] ?? 0) + 1 },
    }));
  });
}

const ring = (container: HTMLElement): Element | null =>
  container.querySelector(".auto-layout-pulse");

describe("AutoLayoutToggle", () => {
  beforeEach(() => useAutoLayoutStore.setState({ pulse: {} }));

  it("pulses for a reveal made while it is mounted", () => {
    const { container } = render(<AutoLayoutToggle featureId={FEATURE} />);
    expect(ring(container)).toBeNull();
    bumpPulse();
    expect(ring(container)).not.toBeNull();
  });

  it("doesn't replay an earlier reveal's pulse when it remounts", () => {
    bumpPulse();
    bumpPulse();
    const { container } = render(<AutoLayoutToggle featureId={FEATURE} />);
    expect(ring(container)).toBeNull();
  });
});
