import React from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { ModelSelector } from "./ModelSelector";

const toastSuccess = vi.fn();
const toastErrorSpy = vi.fn();
const invalidateQueries = vi.fn();
const workspaceProviderMutate = vi.fn();
const projectProviderMutate = vi.fn();
const projectModelMutate = vi.fn();

const {
  mockUseResolvedSelection,
  mockAgentCatalog,
  workspaceProviderMutationImpl,
  projectProviderMutationImpl,
} = vi.hoisted(() => ({
  mockUseResolvedSelection: vi.fn(
    (): { data?: unknown; isLoading: boolean; error: unknown | null } => ({
      data: undefined,
      isLoading: false,
      error: null,
    }),
  ),
  mockAgentCatalog: vi.fn<() => { data?: unknown; isLoading: boolean; error: unknown | null }>(
    () => ({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "opus", label: "Opus" }],
            default_model: "opus",
          },
          {
            id: "codex_cli",
            label: "Codex CLI",
            status: "coming_soon",
            models: [],
            default_model: null,
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  ),
  workspaceProviderMutationImpl: vi.fn(
    (options?: {
      onSuccess?: (_data: unknown, vars: { agentType: string; providerId: string }) => void;
      onError?: (_error: unknown, vars: { agentType: string; providerId: string }) => void;
    }) => ({
      mutate: (variables: { agentType: string; providerId: string }) => {
        workspaceProviderMutate(variables);
        options?.onSuccess?.({}, variables);
      },
    }),
  ),
  projectProviderMutationImpl: vi.fn(
    (options?: {
      onSuccess?: (
        _data: unknown,
        vars: { projectId: number; providerType: string; provider: string },
      ) => void;
      onError?: (
        _error: unknown,
        vars: { projectId: number; providerType: string; provider: string },
      ) => void;
    }) => ({
      mutate: (variables: { projectId: number; providerType: string; provider: string }) => {
        projectProviderMutate(variables);
        options?.onSuccess?.({}, variables);
      },
    }),
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastErrorSpy(...args),
  },
}));

vi.mock("../api/generated", () => ({
  useSetWorkspaceModelSetting: vi.fn(() => ({ mutate: vi.fn() })),
  getGetWorkspaceModelSettingsQueryKey: vi.fn(() => ["workspace", "model-settings"]),
  useSetProjectModelSetting: vi.fn(() => ({ mutate: projectModelMutate })),
  getGetProjectModelSettingsQueryKey: vi.fn((id: number) => ["project", "model-settings", id]),
  useSetFeatureModelSetting: vi.fn(() => ({ mutate: vi.fn() })),
  getGetFeatureModelSettingsQueryKey: vi.fn((id: number) => ["features", "model-settings", id]),
  getGetAgentSelectionQueryKey: vi.fn(() => ["/api/agent-runtime/selection"]),
  useSetWorkspaceSetting: vi.fn(() => ({ mutate: vi.fn() })),
  useSetProjectSetting: vi.fn(() => ({ mutate: vi.fn() })),
  useSetFeatureSetting: vi.fn(() => ({ mutate: vi.fn() })),
  getGetWorkspaceSettingQueryKey: vi.fn((key: string) => ["workspace", "setting", key]),
}));

vi.mock("@/api/agentSelection", () => ({
  useResolvedSelection: () => mockUseResolvedSelection(),
}));

vi.mock("@/api/settings", () => ({
  useGetWorkspaceSettings: () => ({ data: [], isLoading: false }),
  getWorkspaceSettingsQueryKey: () => ["workspace", "settings"],
  settingsArrayToMap: () => ({}),
}));

vi.mock("../api/agentRuntime", () => ({
  useAgentCatalog: () => mockAgentCatalog(),
  useSetWorkspaceProviderSetting: (options?: unknown) =>
    workspaceProviderMutationImpl(options as never),
  useSetProjectProviderSetting: (options?: unknown) =>
    projectProviderMutationImpl(options as never),
  useSetFeatureProviderSetting: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: vi.fn(() => ({ invalidateQueries })),
  };
});

describe("ModelSelector", () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastErrorSpy.mockReset();
    invalidateQueries.mockReset();
    workspaceProviderMutate.mockReset();
    projectProviderMutate.mockReset();
    projectModelMutate.mockReset();
    workspaceProviderMutationImpl.mockReset();
    projectProviderMutationImpl.mockReset();
    workspaceProviderMutationImpl.mockImplementation((options) => ({
      mutate: (variables) => {
        workspaceProviderMutate(variables);
        options?.onSuccess?.({}, variables);
      },
    }));
    projectProviderMutationImpl.mockImplementation((options) => ({
      mutate: (variables) => {
        projectProviderMutate(variables);
        options?.onSuccess?.({}, variables);
      },
    }));
    mockUseResolvedSelection.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "opus", label: "Opus" }],
            default_model: "opus",
          },
          {
            id: "codex_cli",
            label: "Codex CLI",
            status: "coming_soon",
            models: [],
            default_model: null,
          },
        ],
      },
      isLoading: false,
      error: null,
    });
  });

  it("renders only session and auto-naming at the global level", () => {
    render(<ModelSelector level="global" />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Auto-naming")).toBeInTheDocument();
    expect(screen.queryByText("QA")).not.toBeInTheDocument();
  });

  it("renders selects for the configurable agent types", () => {
    render(<ModelSelector level="global" />);
    // session + auto_name = 2 rows at the global level
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
  });

  it("shows an error state when the provider catalog fails", () => {
    mockAgentCatalog.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    });
    render(<ModelSelector level="global" />);
    expect(screen.getByText("Failed to load provider catalog.")).toBeInTheDocument();
  });

  it("renders at project level without errors", () => {
    render(<ModelSelector level="project" projectId={1} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("renders at feature level without errors", () => {
    render(<ModelSelector level="feature" featureId={1} projectId={1} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("uses mutation callbacks so provider success and error toasts track the actual result", async () => {
    const user = userEvent.setup();
    // Provider explicitly set at project level ("project" origin); model inherited
    // from a higher level ("global" origin) — matches the "inherit provider only"
    // scenario the old settings-diffing code exercised.
    mockUseResolvedSelection.mockReturnValue({
      data: {
        selections: {
          session: {
            provider_id: "claude_code",
            model_id: "opus",
            provider_origin: "project",
            model_origin: "global",
          },
        },
      },
      isLoading: false,
      error: null,
    });
    projectProviderMutationImpl.mockImplementation((options) => ({
      mutate: (variables) => {
        projectProviderMutate(variables);
        options?.onError?.(new Error("failed"), variables);
      },
    }));

    render(<ModelSelector level="project" projectId={42} />);
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(screen.getByText("Inherit selection"));

    expect(projectProviderMutate).toHaveBeenCalledWith({
      projectId: 42,
      providerType: "session",
      provider: "",
    });
    expect(toastErrorSpy).toHaveBeenCalledWith("Failed to save provider setting");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each(["project", "provider_default"])(
    "clears both stored overrides when inheriting a %s provider and a fallback model",
    async (providerOrigin) => {
      mockUseResolvedSelection.mockReturnValue({
        data: {
          selections: {
            session: {
              provider_id: "claude_code",
              model_id: "opus",
              provider_origin: providerOrigin,
              model_origin: "provider_default",
            },
          },
        },
        isLoading: false,
        error: null,
      });
      const user = userEvent.setup();
      render(<ModelSelector level="project" projectId={42} />);
      await user.click(screen.getAllByRole("combobox")[0]);
      await user.click(screen.getByText("Inherit selection"));

      expect(projectProviderMutate).toHaveBeenCalledWith({
        projectId: 42,
        providerType: "session",
        provider: "",
      });
      expect(projectModelMutate).toHaveBeenCalledWith({
        id: 42,
        data: { model_type: "session", model: "" },
      });
    },
  );

  it("hides unavailable and coming soon providers", async () => {
    const user = userEvent.setup();
    render(<ModelSelector level="global" />);

    await user.click(screen.getAllByRole("combobox")[0]);

    expect(screen.queryByText("Codex CLI (Coming soon)")).not.toBeInTheDocument();
  });

  it("uses the selected provider default model instead of inheriting a Claude model id", () => {
    mockUseResolvedSelection.mockReturnValue({
      data: {
        selections: {
          session: {
            provider_id: "opencode",
            model_id: "default/default",
            provider_origin: "global",
            model_origin: "provider_default",
          },
          auto_name: {
            provider_id: "opencode",
            model_id: "default/default",
            provider_origin: "global",
            model_origin: "provider_default",
          },
        },
      },
      isLoading: false,
      error: null,
    });
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "default", label: "Default" }],
            default_model: "default",
          },
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [{ id: "default/default", label: "Default" }],
            default_model: "default/default",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<ModelSelector level="global" />);

    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Default");
  });

  it("surfaces live model descriptions from the provider catalog", () => {
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "default", label: "Default", description: "Opus 4.7 with 1M context" }],
            default_model: "default",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<ModelSelector level="global" />);
    expect(screen.getAllByRole("combobox")[0]).toHaveAttribute("title", "Opus 4.7 with 1M context");
  });

  it("does not render standalone provider actions", async () => {
    const user = userEvent.setup();
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "default", label: "Default" }],
            default_model: "default",
          },
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [{ id: "default/default", label: "Default" }],
            default_model: "default/default",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<ModelSelector level="global" />);
    await user.click(screen.getAllByRole("combobox")[0]);

    expect(screen.getAllByRole("option", { name: "Default" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Use Claude Code/)).toBeNull();
    expect(screen.queryByText(/Use OpenCode/)).toBeNull();
  });

  it("auto-focuses search and filters provider/model options", async () => {
    const user = userEvent.setup();
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [{ id: "opus", label: "Opus", description: "Claude default" }],
            default_model: "opus",
          },
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [{ id: "gpt-5", label: "GPT-5", description: "Codex default" }],
            default_model: "gpt-5",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<ModelSelector level="global" />);
    await user.click(screen.getAllByRole("combobox")[0]);

    const searchInput = screen.getByPlaceholderText("Search providers or models...");
    await waitFor(() => expect(searchInput).toHaveFocus());

    await user.type(searchInput, "gpt");

    const optionTexts = screen.getAllByRole("option").map((element) => element.textContent ?? "");
    expect(screen.getByRole("option", { name: "GPT-5" })).toBeInTheDocument();
    expect(optionTexts.some((text) => text.includes("Claude / Opus"))).toBe(false);
  });
});
