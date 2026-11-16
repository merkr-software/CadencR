import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { EmbeddedFeatureHeader } from "./EmbeddedFeatureHeader";

const attention = vi.hoisted(() => ({
  state: "idle" as string,
  kind: null as string | null,
}));

vi.mock("@/hooks/useFeatureAttention", () => ({
  useFeatureAttention: () => ({ state: attention.state, sourceFeatureId: 7 }),
}));

vi.mock("@/stores/session-status-selectors", () => ({
  useFeatureStatus: () => ({ status: "idle", kind: attention.kind }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { ...props, href: to }, children);
  },
}));

vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: () => null,
}));

const LONG_TITLE =
  "Refactor the cart pricing engine so promotions, taxes and shipping share a single pipeline";

function renderHeader(): void {
  render(
    <EmbeddedFeatureHeader
      featureId={7}
      projectId={1}
      projectName="Orbit Shop"
      title={LONG_TITLE}
      label="refactor"
      lastActivityAt="2026-03-04T23:20:00Z"
      onTogglePin={vi.fn()}
      onExclude={vi.fn()}
    />,
  );
}

describe("EmbeddedFeatureHeader", () => {
  beforeEach((): void => {
    attention.state = "idle";
    attention.kind = null;
  });

  it("gives the title its own line, whole, as the card's heading", () => {
    renderHeader();
    const heading = screen.getByRole("heading", { name: LONG_TITLE });
    expect(heading).toHaveAttribute("title", LONG_TITLE);
    expect(screen.getByText("Orbit Shop")).toBeInTheDocument();
    expect(screen.getByText("refactor")).toBeInTheDocument();
  });

  it("shows the last activity while the agent is idle", () => {
    renderHeader();
    expect(screen.getByText(/ago$|just now/)).toBeInTheDocument();
  });

  it("names what a waiting agent asks for instead of its time", () => {
    attention.state = "waiting";
    attention.kind = "permission";
    renderHeader();
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  it("labels the open action for assistive tech", () => {
    renderHeader();
    expect(screen.getByRole("link", { name: "Open feature page" })).toHaveAttribute(
      "href",
      "/projects/$projectId/features/$featureId",
    );
  });
});
