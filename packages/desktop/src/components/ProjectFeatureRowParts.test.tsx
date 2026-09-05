import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@/test-utils";
import type { AllocatedPort, Feature, PrStatusSnapshot } from "@/api/generated";
import { FeatureRowMetaLine, FeatureRowProviderMark } from "./ProjectFeatureRowParts";

vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/SidebarPendingGatePopover", () => ({
  SidebarPendingGatePopover: ({ children }: { children?: ReactNode }) => (
    <div data-testid="pending-gate">{children ?? "default-gate"}</div>
  ),
}));

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 5,
    project_id: 1,
    title: "A feature",
    status: "active",
    type: "ws-session",
    label: null,
    is_pinned: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  } as Feature;
}

function snapshot(overrides: Partial<PrStatusSnapshot> = {}): PrStatusSnapshot {
  return {
    setup_required: false,
    feature_id: 5,
    fetched_at: 1,
    error: null,
    ci: { state: "none", checks: [] },
    pr: null,
    ...overrides,
  };
}

function port(overrides: Partial<AllocatedPort> = {}): AllocatedPort {
  return {
    port: 3000,
    pid: 999,
    process: "node",
    source: "agent",
    ...overrides,
  };
}

function renderLine(prStatus: PrStatusSnapshot | undefined, ports: readonly AllocatedPort[] = []) {
  return render(
    <FeatureRowMetaLine
      feature={feature()}
      prStatus={prStatus}
      gitStats={undefined}
      shellCount={0}
      browserCount={0}
      ports={ports}
      isEditingLabel={false}
      labelDraft=""
      labelSuggestions={[]}
      isSavingLabel={false}
      onLabelDraftChange={vi.fn()}
      onSaveLabel={vi.fn()}
      onCancelLabelEdit={vi.fn()}
      onOpenPort={vi.fn()}
    />,
  );
}

describe("FeatureRowMetaLine", () => {
  it("stays a single line when the row has nothing to show", () => {
    renderLine(undefined);

    expect(document.querySelector("[data-feature-meta-line]")).toBeNull();
  });

  it("mounts for a forge error even with no proposal, so it can't be swallowed", () => {
    renderLine(snapshot({ error: "Bad credentials" }));

    expect(document.querySelector("[data-feature-meta-line]")).not.toBeNull();
    expect(screen.getByLabelText("Forge status error: Bad credentials")).toBeInTheDocument();
  });

  it("stays hidden for a clean snapshot with neither proposal nor error", () => {
    renderLine(snapshot());

    expect(document.querySelector("[data-feature-meta-line]")).toBeNull();
  });

  it("mounts for an allocated port even when the row has nothing else to show", () => {
    renderLine(undefined, [port()]);

    expect(document.querySelector("[data-feature-meta-line]")).not.toBeNull();
    expect(screen.getByLabelText("Port 3000 in use")).toBeInTheDocument();
  });

  it("summarises several ports on one badge", () => {
    renderLine(undefined, [port(), port({ port: 5173, pid: 1000 })]);

    expect(screen.getByLabelText("Ports 3000, 5173 in use")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });
});

describe("FeatureRowProviderMark", () => {
  const mark = (status: "idle" | "agent" | "question", unread = false, provider = "claude_code") =>
    render(
      <FeatureRowProviderMark
        feature={feature({ runtime_provider: provider })}
        liveStatus={status}
        isActive={false}
        isUnread={unread}
        onOpenConversation={vi.fn()}
      />,
    );

  it("shows the idle provider mark without a reserved status column", () => {
    mark("idle");
    expect(screen.getByRole("img")).toHaveAttribute("data-provider-mark", "idle");
    expect(screen.queryByTestId("pending-gate")).not.toBeInTheDocument();
  });

  it("uses the working tinted mark instead of a separate bot icon", () => {
    mark("agent");
    const working = screen.getByRole("img", { name: /Working/ });
    expect(working).toHaveAttribute("data-provider-mark", "working");
    expect(working).toHaveClass("text-blue-500", "animate-pulse");
    expect(screen.queryByTestId("pending-gate")).not.toBeInTheDocument();
  });

  it.each(["claude_code", "external-connector"])(
    "wraps the %s mark in the pending-gate trigger while waiting",
    (provider) => {
      mark("question", false, provider);
      expect(screen.getByTestId("pending-gate")).toBeInTheDocument();
      expect(
        screen.getByTestId("pending-gate").querySelector("[data-provider-mark]"),
      ).toHaveAttribute("data-provider-mark", "waiting");
    },
  );
});
