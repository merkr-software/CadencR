import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { PhoneFeatureTitle, type PhoneFeatureTitleProps } from "./PhoneFeatureTitle";

const mocks = vi.hoisted(() => ({ status: "idle" as "idle" | "agent" | "question" }));

vi.mock("@/stores/session-status-selectors", () => ({
  useFeatureStatus: () => ({ status: mocks.status, kind: null }),
}));
vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: () => <span data-testid="project-badge" />,
}));

function props(overrides: Partial<PhoneFeatureTitleProps> = {}): PhoneFeatureTitleProps {
  return {
    featureId: 1,
    projectId: 2,
    featureTitle: "Fix the inventory",
    isAutoNaming: false,
    canAutoRename: true,
    isAutoRenamePending: false,
    onAutoRename: vi.fn(),
    ...overrides,
  };
}

describe("PhoneFeatureTitle", () => {
  beforeEach(() => {
    mocks.status = "idle";
  });

  it("shows the title after the project badge while the agent is idle", () => {
    render(<PhoneFeatureTitle {...props()} />);
    expect(screen.getByRole("heading", { name: "Fix the inventory" })).toBeInTheDocument();
    expect(screen.getByTestId("project-badge")).toBeInTheDocument();
  });

  it("shows the agent's state in the status dot", () => {
    mocks.status = "agent";
    const view = render(<PhoneFeatureTitle {...props()} />);
    expect(screen.getByRole("img", { name: "Agent working" })).toBeInTheDocument();
    view.unmount();

    mocks.status = "question";
    render(<PhoneFeatureTitle {...props()} />);
    expect(screen.getByRole("img", { name: "Waiting on you" })).toBeInTheDocument();
  });
});
