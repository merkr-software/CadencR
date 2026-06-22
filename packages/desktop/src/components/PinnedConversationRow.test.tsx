import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Feature } from "@/api/generated";

const mocks = vi.hoisted(() => ({
  title: { title: null as string | null, isAutoNaming: false },
  status: "idle" as "idle" | "agent" | "question",
  isUnread: false,
  prefetch: vi.fn(),
}));

vi.mock("@/hooks/useFeatureTitle", () => ({
  useFeatureTitle: () => mocks.title,
}));

vi.mock("@/stores/session-status-selectors", () => ({
  useFeatureStatus: () => ({ status: mocks.status }),
}));

vi.mock("@/stores/unread-store", () => ({
  useIsFeatureUnread: () => mocks.isUnread,
}));

vi.mock("@/hooks/useFeaturePrefetch", () => ({
  useFeaturePrefetch: () => mocks.prefetch,
}));

vi.mock("@/hooks/useProjectColor", () => ({
  ProjectColorDot: () => <span data-testid="color-dot" />,
}));

vi.mock("@/components/ProjectFeatureRow", () => ({
  shouldIgnoreFeatureRowKeyDown: () => false,
}));

import { PinnedConversationRow } from "./PinnedConversationRow";

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    project_id: 7,
    title: "REST Title",
    status: "active",
    type: "ws-session",
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: true,
    ...overrides,
  } as unknown as Feature;
}

function renderRow(props: Partial<React.ComponentProps<typeof PinnedConversationRow>> = {}) {
  const onNavigate = vi.fn();
  const onUnpin = vi.fn();
  render(
    <PinnedConversationRow
      feature={feature()}
      activeFeatureId={null}
      onNavigate={onNavigate}
      onUnpin={onUnpin}
      {...props}
    />,
  );
  return { onNavigate, onUnpin };
}

describe("PinnedConversationRow", () => {
  beforeEach(() => {
    mocks.title = { title: null, isAutoNaming: false };
    mocks.status = "idle";
    mocks.isUnread = false;
    mocks.prefetch.mockClear();
  });

  it("falls back to the REST title when no live title has arrived", () => {
    renderRow();
    expect(screen.getByText("REST Title")).toBeInTheDocument();
  });

  it("prefers the live WS-pushed title when present", () => {
    mocks.title = { title: "Live Title", isAutoNaming: false };
    renderRow();
    expect(screen.getByText("Live Title")).toBeInTheDocument();
    expect(screen.queryByText("REST Title")).not.toBeInTheDocument();
  });

  it("shows a skeleton instead of the title while auto-naming", () => {
    mocks.title = { title: null, isAutoNaming: true };
    renderRow();
    expect(screen.queryByText("REST Title")).not.toBeInTheDocument();
  });

  it("navigates on row click", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderRow();
    await user.click(screen.getByText("REST Title"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when the row is already active", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderRow({ activeFeatureId: 1 });
    await user.click(screen.getByText("REST Title"));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("unpins without navigating when the unpin button is clicked", async () => {
    const user = userEvent.setup();
    const { onNavigate, onUnpin } = renderRow();
    await user.click(screen.getByRole("button", { name: "Unpin" }));
    expect(onUnpin).toHaveBeenCalledWith(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
