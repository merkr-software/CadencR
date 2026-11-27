import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import type { ResolvedAttentionResult } from "@/hooks/useResolvedAttention";
import type { NextActionKind } from "@/lib/next-actions";
import { PhoneMenuAttentionDot } from "./PhoneMenuAttentionDot";

function attention(actions: [number, NextActionKind][]): ResolvedAttentionResult {
  return {
    entries: [],
    items: [],
    queue: [],
    byProject: new Map(),
    loadingStates: [],
    actionsLoading: false,
    actions: actions.map(([id, kind]) => ({ feature: { id, project_id: 1 } as Feature, kind })),
  };
}

function renderDot(actions: [number, NextActionKind][], exceptFeatureId: number | null) {
  return render(
    <SidebarAttentionContext.Provider value={attention(actions)}>
      <button type="button">
        Open menu
        <PhoneMenuAttentionDot exceptFeatureId={exceptFeatureId} />
      </button>
    </SidebarAttentionContext.Provider>,
  );
}

describe("PhoneMenuAttentionDot", () => {
  it("counts For me entries other than the conversation on screen", () => {
    const { container } = renderDot(
      [
        [1, "waiting"],
        [2, "review"],
        [3, "review"],
      ],
      1,
    );
    const dot = container.querySelector("[data-phone-menu-attention]");
    expect(dot).toHaveTextContent("2");
    expect(dot).toHaveAttribute("data-phone-menu-attention", "quiet");
    expect(screen.getByRole("button")).toHaveAccessibleName("Open menu , 2 for you");
  });

  it("turns amber when a request or a failure waits elsewhere", () => {
    const { container } = renderDot([[2, "failed"]], 1);
    expect(container.querySelector("[data-phone-menu-attention]")).toHaveAttribute(
      "data-phone-menu-attention",
      "strong",
    );
  });

  it("shows nothing when only the open conversation needs the user", () => {
    const { container } = renderDot([[1, "waiting"]], 1);
    expect(container.querySelector("[data-phone-menu-attention]")).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName("Open menu");
  });

  it("caps the count at 9+", () => {
    const many = Array.from({ length: 12 }, (_, i): [number, NextActionKind] => [i + 10, "review"]);
    const { container } = renderDot(many, null);
    expect(container.querySelector("[data-phone-menu-attention]")).toHaveTextContent("9+");
  });
});
