import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { createTestQueryClient } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { SidebarPendingRequestLine } from "./SidebarPendingRequestLine";

function clientWithGate() {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  client.setQueryData(["/api/features", 1, "pending-gate", "req-1"], {
    request_id: "req-1",
    kind: "permission",
    payload: { tool_name: "Bash", tool_input: { command: "pnpm test" } },
  });
  return client;
}

beforeEach(() => {
  useSessionStatusStore.setState({
    bySession: {
      10: { featureId: 1, status: "question", kind: "permission", requestId: "req-1", seq: 1 },
    },
  });
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
});

const WAITING = { state: "waiting", sourceFeatureId: 1 } as const;

describe("SidebarPendingRequestLine", () => {
  it("names the pending request under the title", () => {
    render(<SidebarPendingRequestLine attention={WAITING} />, { queryClient: clientWithGate() });
    expect(screen.getByText(/^Bash: /)).toHaveTextContent("pnpm test");
  });

  it("says only that a plan is ready for review, not what the plan holds", () => {
    const queryClient = clientWithGate();
    queryClient.setQueryData(["/api/features", 1, "pending-gate", "req-1"], {
      request_id: "req-1",
      kind: "plan",
      payload: { tool_name: "ExitPlanMode", description: "Refactor the whole thing" },
    });
    render(<SidebarPendingRequestLine attention={WAITING} />, { queryClient });
    expect(screen.getByText("Plan ready for review")).toHaveAttribute(
      "data-feature-pending-request",
    );
    expect(screen.queryByText(/Refactor/)).not.toBeInTheDocument();
  });

  it("says a fixed row waits, as a placeholder, when the request has no prompt", () => {
    const queryClient = clientWithGate();
    queryClient.setQueryData(["/api/features", 1, "pending-gate", "req-1"], null);
    render(<SidebarPendingRequestLine attention={WAITING} fillsLine />, { queryClient });
    expect(screen.getByText("Waiting for you")).toHaveAttribute(
      "data-feature-pending-request",
      "empty",
    );
  });

  it("stays out when the row element is switched off", () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, pendingRequest: false },
    });
    const { container } = render(<SidebarPendingRequestLine attention={WAITING} />, {
      queryClient: clientWithGate(),
    });
    expect(container).toBeEmptyDOMElement();
  });
});
