import { describe, expect, it, vi, beforeEach } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { toast } from "sonner";
import { fireEvent, render, screen, waitFor } from "@/test-utils";
import { CustomActionButton } from "./CustomActionButton";
import { useTerminalStore } from "@/hooks/useTerminalState";
import type { CustomAction } from "@/api/generated";

const mockRunCustomAction = vi.hoisted(() => vi.fn());
const runMutationOptions = vi.hoisted(() => ({ onError: undefined as unknown }));
const mockResolveCommand = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", () => ({
  getGetCustomActionRunsQueryKey: vi.fn(() => ["custom-action-runs"]),
  getListCustomActionsQueryKey: vi.fn(() => ["custom-actions"]),
  useRunCustomAction: vi.fn((options: { mutation: { onError: unknown } }) => {
    runMutationOptions.onError = options.mutation.onError;
    return { mutate: mockRunCustomAction, isPending: false };
  }),
  resolveCommand: mockResolveCommand,
}));

function makeAction(): CustomAction {
  return {
    id: 7,
    name: "Deploy",
    command: "pnpm deploy",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    position: 0,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: [],
    icon_data: null,
    last_run: null,
  };
}

describe("CustomActionButton", () => {
  beforeEach((): void => {
    mockRunCustomAction.mockClear();
    mockResolveCommand.mockReset();
  });

  it("runs the action from the main icon button", async (): Promise<void> => {
    const { user } = render(
      <CustomActionButton
        action={makeAction()}
        featureId={42}
        projectId={1}
        onOpenDetails={vi.fn()}
        detailsOpen={false}
      />,
    );

    await user.click(screen.getByTitle("Run Deploy"));

    expect(mockRunCustomAction).toHaveBeenCalledWith({
      id: 7,
      params: { feature_id: 42 },
    });
  });

  it("opens the shared details surface from the chevron, not from right click", async (): Promise<void> => {
    const onOpenDetails = vi.fn();
    const action = makeAction();
    const { user } = render(
      <CustomActionButton
        action={action}
        featureId={42}
        projectId={1}
        onOpenDetails={onOpenDetails}
        detailsOpen={false}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle("Run Deploy"));
    expect(onOpenDetails).not.toHaveBeenCalled();

    await user.click(screen.getByTitle("Open Deploy details"));

    expect(onOpenDetails).toHaveBeenCalledWith(action);
  });

  it("spawns the resolved command in a terminal split when run_in_terminal is set", async (): Promise<void> => {
    mockResolveCommand.mockResolvedValue({ command: "npm run dev", cwd: "/repo" });
    const sendToTerminal = vi.fn();
    useTerminalStore.setState({ sendToTerminal });

    const { user } = render(
      <CustomActionButton
        action={{ ...makeAction(), run_in_terminal: true }}
        featureId={42}
        projectId={1}
        onOpenDetails={vi.fn()}
        detailsOpen={false}
      />,
    );

    await user.click(screen.getByTitle("Run Deploy in terminal"));

    // The resolved command is handed to the terminal split with a trailing
    // newline so the PTY executes it; no background run is started.
    expect(mockResolveCommand).toHaveBeenCalledWith(7, { feature_id: 42 });
    await waitFor(() => expect(sendToTerminal).toHaveBeenCalledWith(42, "npm run dev\n"));
    expect(mockRunCustomAction).not.toHaveBeenCalled();
  });

  it("names the run button after the action and its last result, not the status dot", (): void => {
    render(
      <CustomActionButton
        action={{ ...makeAction(), last_run: { exit_code: 2, ended_at: "2026-01-01T00:01:00Z" } }}
        featureId={42}
        projectId={1}
        onOpenDetails={vi.fn()}
        detailsOpen
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run Deploy. Last run failed (exit 2)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Deploy details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("draws no status dot for an action that has never run", (): void => {
    render(
      <CustomActionButton
        action={makeAction()}
        featureId={42}
        projectId={1}
        onOpenDetails={vi.fn()}
        detailsOpen={false}
      />,
    );

    const runButton = screen.getByRole("button", { name: "Run Deploy" });
    expect(runButton.querySelector(".rounded-full")).toBeNull();
  });

  it("surfaces the backend's error message when a run is rejected", (): void => {
    const toastError = vi.spyOn(toast, "error");
    render(
      <CustomActionButton
        action={makeAction()}
        featureId={42}
        projectId={1}
        onOpenDetails={vi.fn()}
        detailsOpen={false}
      />,
    );
    const error = new AxiosError("Request failed with status code 400");
    error.response = {
      data: { error: "Bad request: Missing values for variables: ENV", code: "BAD_REQUEST" },
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    const onError = runMutationOptions.onError;
    if (typeof onError !== "function") throw new Error("run mutation has no onError");
    onError(error);

    expect(toastError).toHaveBeenCalledWith(
      "Deploy failed: Bad request: Missing values for variables: ENV",
    );
    toastError.mockRestore();
  });
});
