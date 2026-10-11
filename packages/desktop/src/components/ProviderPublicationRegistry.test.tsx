import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { ProviderPublicationRegistry } from "./ProviderPublicationRegistry";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  previewHook: vi.fn(),
  previewMutate: vi.fn(),
  previewReset: vi.fn(),
  submitHook: vi.fn(),
  submitMutate: vi.fn(),
  submitReset: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  usePreviewPublicationRegistry: mocks.previewHook,
  useSubmitPublicationRegistry: mocks.submitHook,
}));
vi.mock("@/lib/open-external", () => ({ openExternalUrl: mocks.openExternal }));

const releasePreview = {
  project_id: 7,
  plugin_id: "example.agent",
  version: "1.2.3",
  bundle_id: "123e4567-e89b-42d3-a456-426614174000",
  repository: "acme/example-agent",
  tag: "v1.2.3",
  source_commit: "abc123",
  target: "darwin-aarch64",
  archive_name: "agent.tgz",
  archive_sha256: "archive-hash",
  archive_size: 2048,
  metadata_sha256: "metadata-hash",
  release_notes: "Exact release notes",
  account: "octocat",
  plan_sha256: "release-plan",
  release_url: "https://github.com/acme/example-agent/releases/tag/v1.2.3",
  prerelease: false,
};

const registryPlan = {
  project_id: 7,
  plugin_id: "example.agent",
  version: "1.2.3",
  bundle_id: releasePreview.bundle_id,
  release_notes: releasePreview.release_notes,
  account: "octocat",
  registry_repository: "merkr-software/cadencr-registry",
  base_branch: "main",
  base_commit: "base123",
  branch: "submit/example-agent-1.2.3",
  package_path: "packages/example.agent/1.2.3.json",
  submission_path: "submissions/example.agent-1.2.3.json",
  plan_sha256: "registry-plan",
};

describe("ProviderPublicationRegistry", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.previewHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    mocks.submitHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.submitMutate,
      reset: mocks.submitReset,
    });
  });

  it("reviews first, then requires and consumes distinct confirmation", async () => {
    let reviewed: ((value: typeof registryPlan) => void) | undefined;
    mocks.previewHook.mockImplementation((options) => {
      reviewed = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    const onPendingChange = vi.fn();
    const { user } = render(
      <ProviderPublicationRegistry
        projectId={7}
        preview={releasePreview}
        disabled={false}
        onPendingChange={onPendingChange}
      />,
    );

    expect(mocks.previewMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review registry submission" }));
    expect(mocks.previewMutate).toHaveBeenCalledWith({
      id: 7,
      data: { bundle_id: releasePreview.bundle_id, release_notes: releasePreview.release_notes },
    });
    expect(onPendingChange).toHaveBeenCalledWith(true);

    act(() => reviewed?.(registryPlan));
    expect(screen.getAllByText("merkr-software/cadencr-registry")).toHaveLength(2);
    expect(screen.getByText("main @ base123")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Create registry pull request" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /confirm this exact fork/i }));
    await user.click(submit);

    expect(mocks.submitMutate).toHaveBeenCalledWith({
      id: 7,
      data: {
        bundle_id: registryPlan.bundle_id,
        release_notes: registryPlan.release_notes,
        expected_plan_sha256: registryPlan.plan_sha256,
        confirmed: true,
      },
    });
    expect(screen.getByRole("checkbox", { name: /confirm this exact fork/i })).not.toBeChecked();
  });

  it("clears stale plan, result, and consent before every refreshed review", async () => {
    let reviewed: ((value: typeof registryPlan) => void) | undefined;
    let submitted:
      | ((value: {
          pull_request_url: string;
          pull_request_number: number;
          branch: string;
          reused: boolean;
        }) => void)
      | undefined;
    mocks.previewHook.mockImplementation((options) => {
      reviewed = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    mocks.submitHook.mockImplementation((options) => {
      submitted = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.submitMutate,
        reset: mocks.submitReset,
      };
    });
    const { user } = render(
      <ProviderPublicationRegistry
        projectId={7}
        preview={releasePreview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    act(() => reviewed?.(registryPlan));
    await user.click(screen.getByRole("checkbox", { name: /confirm this exact fork/i }));
    act(() =>
      submitted?.({
        pull_request_url: "https://github.com/merkr-software/cadencr-registry/pull/42",
        pull_request_number: 42,
        branch: registryPlan.branch,
        reused: false,
      }),
    );
    expect(screen.getByText(/Registry pull request created/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review registry submission" }));
    expect(screen.queryByText("Registry pull request preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/Registry pull request created/)).not.toBeInTheDocument();
    expect(mocks.previewReset).toHaveBeenCalled();
    expect(mocks.submitReset).toHaveBeenCalled();
  });

  it("locks controls, surfaces errors, and opens a successful pull request", async () => {
    mocks.previewHook.mockReturnValue({
      error: new Error("GitHub timed out"),
      isError: true,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    const view = render(
      <ProviderPublicationRegistry
        projectId={7}
        preview={releasePreview}
        disabled={true}
        onPendingChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Review registry submission" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub timed out");

    let submitted:
      | ((value: {
          pull_request_url: string;
          pull_request_number: number;
          branch: string;
          reused: boolean;
        }) => void)
      | undefined;
    mocks.previewHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    mocks.submitHook.mockImplementation((options) => {
      submitted = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.submitMutate,
        reset: mocks.submitReset,
      };
    });
    view.rerender(
      <ProviderPublicationRegistry
        projectId={7}
        preview={releasePreview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    const result = {
      pull_request_url: "https://github.com/merkr-software/cadencr-registry/pull/42",
      pull_request_number: 42,
      branch: registryPlan.branch,
      reused: true,
    };
    act(() => submitted?.(result));
    expect(screen.getByText(/Registry pull request reused/)).toBeInTheDocument();
    await view.user.click(screen.getByRole("button", { name: result.pull_request_url }));
    expect(mocks.openExternal).toHaveBeenCalledWith(
      result.pull_request_url,
      "Could not open the registry pull request.",
    );
  });
});
