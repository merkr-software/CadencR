// @vitest-environment happy-dom
import { StrictMode, useRef, type ReactElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useInitialFocus } from "./gate-keys";

function Body({ onMount, step }: { onMount: boolean; step: number }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useInitialFocus(root, "button", onMount, step);
  return (
    <div ref={root}>
      <button type="button">Allow once</button>
    </div>
  );
}

function renderStrict(onMount: boolean, step = 0) {
  return render(
    <StrictMode>
      <Body onMount={onMount} step={step} />
    </StrictMode>,
  );
}

describe("useInitialFocus", () => {
  it("never takes focus on mount when not asked, even with StrictMode's double effects", () => {
    renderStrict(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("takes focus on mount when asked", () => {
    const { getByRole } = renderStrict(true);
    expect(document.activeElement).toBe(getByRole("button"));
  });

  it("takes focus on a later step even when the mount didn't", () => {
    const { getByRole, rerender } = renderStrict(false);
    expect(document.activeElement).toBe(document.body);
    rerender(
      <StrictMode>
        <Body onMount={false} step={1} />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(getByRole("button"));
  });
});
