import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageOrigin } from "@/api/generated";
import { useSidebarPointedFeatureStore } from "@/stores/sidebar-pointed-feature-store";
import { AgentMessageSender } from "./AgentMessageSender";

const { navigate, useGetFeature } = vi.hoisted(() => ({
  navigate: vi.fn(),
  useGetFeature: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetFeature,
}));

const origin: AgentMessageOrigin = {
  originKind: "session_generated",
  sourceSessionId: 123,
  sourceFeatureId: 45,
  sourceProjectId: 6,
  sourceMessageId: 789,
  note: "spawned helper",
  createdAt: "2026-06-18T12:00:00Z",
};

describe("AgentMessageSender", () => {
  beforeEach(() => {
    navigate.mockReset();
    useGetFeature.mockReturnValue({ data: undefined, isError: false, isLoading: false });
    useSidebarPointedFeatureStore.getState().setPointedFeature(null);
  });

  it("names the sending conversation, lights it up in the sidebar on hover and opens it", async () => {
    const user = userEvent.setup();
    useGetFeature.mockReturnValue({
      data: { id: 45, project_id: 6, title: "Investigate flaky tests", runtime_provider: null },
      isError: false,
      isLoading: false,
    });
    render(<AgentMessageSender origin={origin} />);

    const sender = screen.getByRole("button", {
      name: "Sent by Investigate flaky tests. Open conversation",
    });
    expect(sender).toHaveTextContent("Investigate flaky tests");

    await user.hover(sender);
    expect(useSidebarPointedFeatureStore.getState().pointedFeatureId).toBe(45);
    await user.unhover(sender);
    expect(useSidebarPointedFeatureStore.getState().pointedFeatureId).toBeNull();

    await user.click(sender);
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "6", featureId: "45" },
    });
  });

  it("releases the sidebar highlight when it unmounts under the pointer", async () => {
    const user = userEvent.setup();
    useGetFeature.mockReturnValue({
      data: { id: 45, project_id: 6, title: "Investigate flaky tests", runtime_provider: null },
      isError: false,
      isLoading: false,
    });
    const { unmount } = render(<AgentMessageSender origin={origin} />);
    await user.hover(screen.getByRole("button"));
    expect(useSidebarPointedFeatureStore.getState().pointedFeatureId).toBe(45);

    unmount();
    expect(useSidebarPointedFeatureStore.getState().pointedFeatureId).toBeNull();
  });

  it("falls back to a non-clickable session label when the conversation is unavailable", () => {
    useGetFeature.mockReturnValue({ data: undefined, isError: true, isLoading: false });
    render(<AgentMessageSender origin={origin} />);

    const label = screen.getByText("Session 123");
    expect(label).toHaveAttribute("title", "Conversation could not be loaded · spawned helper");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows that the sender is loading", () => {
    useGetFeature.mockReturnValue({ data: undefined, isError: false, isLoading: true });
    render(<AgentMessageSender origin={origin} />);

    expect(screen.getByText("Loading sender…")).toBeInTheDocument();
  });

  it("labels the tab as an agent's and ends it with the time", () => {
    useGetFeature.mockReturnValue({
      data: { id: 45, project_id: 6, title: "Investigate flaky tests", runtime_provider: null },
      isError: false,
      isLoading: false,
    });
    render(<AgentMessageSender origin={origin} sentAt="2020-01-02 09:05:00" />);

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText(/^2020\/01\/02 \d{2}:\d{2}$/)).toBeInTheDocument();
  });
});
