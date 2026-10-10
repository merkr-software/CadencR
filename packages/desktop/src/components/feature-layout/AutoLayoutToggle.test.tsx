import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function pulseNow(): void {
  act(() => {
    useAutoLayoutStore.setState((s) => ({ pulsedAt: { ...s.pulsedAt, [FEATURE]: Date.now() } }));
  });
}

const ring = (container: HTMLElement): Element | null =>
  container.querySelector(".auto-layout-pulse");

describe("AutoLayoutToggle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAutoLayoutStore.setState({ pulsedAt: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("pulses for a reveal made while it is mounted", () => {
    const { container } = render(<AutoLayoutToggle featureId={FEATURE} />);
    expect(ring(container)).toBeNull();
    pulseNow();
    expect(ring(container)).not.toBeNull();
  });

  it("still pulses when the reveal itself remounts it", () => {
    pulseNow();
    const { container } = render(<AutoLayoutToggle featureId={FEATURE} />);
    expect(ring(container)).not.toBeNull();
  });

  it("doesn't replay an earlier reveal's pulse when it remounts later", () => {
    pulseNow();
    vi.advanceTimersByTime(5_000);
    const { container } = render(<AutoLayoutToggle featureId={FEATURE} />);
    expect(ring(container)).toBeNull();
  });
});
