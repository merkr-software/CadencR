import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import type { PrStatusSnapshot } from "@/api/generated";
import { SidebarNextActionLine } from "./SidebarNextActionLine";

const mocks = vi.hoisted(() => ({
  pendingGate: vi.fn(() => ({ gate: null, errorMessage: null })),
  featureStatus: vi.fn(() => ({ status: "question", kind: "question" })),
}));

vi.mock("@/hooks/useFeaturePendingGate", () => ({ useFeaturePendingGate: mocks.pendingGate }));
vi.mock("@/stores/session-status-selectors", () => ({ useFeatureStatus: mocks.featureStatus }));

beforeEach(() => vi.clearAllMocks());

function line(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-feature-next-action-line]");
  if (!element) throw new Error("no next action line");
  return element;
}

describe("SidebarNextActionLine", () => {
  it("names a non-waiting action without subscribing to the request or the live status", () => {
    const { container } = render(
      <SidebarNextActionLine kind="review" featureId={3} prStatus={undefined} />,
    );
    expect(line(container)).toHaveTextContent("Review");
    expect(line(container)).toHaveAttribute("title", "The agent finished: its reply is unread");
    expect(container.querySelector('[data-feature-next-action="review"]')).toHaveClass(
      "font-medium",
    );
    expect(mocks.pendingGate).not.toHaveBeenCalled();
    expect(mocks.featureStatus).not.toHaveBeenCalled();
  });

  it("names a pull request action without fetching the request", () => {
    const prStatus = {
      feature_id: 3,
      prs: [],
    } as unknown as PrStatusSnapshot;
    const { container } = render(
      <SidebarNextActionLine kind="merge" featureId={3} prStatus={prStatus} />,
    );
    expect(line(container)).toHaveTextContent("Merge");
    expect(mocks.pendingGate).not.toHaveBeenCalled();
  });

  it("fetches the request of a waiting line only", () => {
    const { container } = render(
      <SidebarNextActionLine kind="waiting" featureId={3} prStatus={undefined} />,
    );
    expect(line(container)).toHaveTextContent("Answer");
    expect(mocks.pendingGate).toHaveBeenCalledWith({ featureId: 3, enabled: true });
    expect(mocks.featureStatus).toHaveBeenCalledWith(3);
  });
});
