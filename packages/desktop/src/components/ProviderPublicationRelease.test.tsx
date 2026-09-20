import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test-utils";
import { bundleIdFromArchivePath, ProviderPublicationRelease } from "./ProviderPublicationRelease";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  previewHook: vi.fn(),
  previewMutate: vi.fn(),
  previewReset: vi.fn(),
  publishHook: vi.fn(),
  publishMutate: vi.fn(),
  publishReset: vi.fn(),
  contributionHook: vi.fn(),
  contributionMutate: vi.fn(),
  contributionReset: vi.fn(),
  registryPreviewHook: vi.fn(),
  registryPreviewMutate: vi.fn(),
  registryPreviewReset: vi.fn(),
  registrySubmitHook: vi.fn(),
  registrySubmitMutate: vi.fn(),
  registrySubmitReset: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  usePreviewPublicationRelease: mocks.previewHook,
  usePublishPublicationRelease: mocks.publishHook,
  usePreparePublicationContribution: mocks.contributionHook,
  usePreviewPublicationRegistry: mocks.registryPreviewHook,
  useSubmitPublicationRegistry: mocks.registrySubmitHook,
}));

vi.mock("@/lib/open-external", () => ({ openExternalUrl: mocks.openExternal }));

const preview = {
  project_id: 7,
  plugin_id: "example.agent",
  version: "1.2.3",
  bundle_id: "123e4567-e89b-42d3-a456-426614174000",
  repository: "acme/example-agent",
  tag: "v1.2.3",
  source_commit: "abc123def456",
  target: "darwin-aarch64",
  archive_name: "example-agent.tgz",
  archive_sha256: "archive-hash",
  archive_size: 2048,
  metadata_sha256: "metadata-hash",
  release_notes: "Exact release notes",
  account: "octocat",
  plan_sha256: "plan-hash",
  release_url: "https://github.com/acme/example-agent/releases/tag/v1.2.3",
  prerelease: false,
};

describe("ProviderPublicationRelease", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.previewHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    mocks.publishHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.publishMutate,
      reset: mocks.publishReset,
    });
    mocks.contributionHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.contributionMutate,
      reset: mocks.contributionReset,
    });
    mocks.registryPreviewHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.registryPreviewMutate,
      reset: mocks.registryPreviewReset,
    });
    mocks.registrySubmitHook.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mocks.registrySubmitMutate,
      reset: mocks.registrySubmitReset,
    });
  });

  it("opens the published release through the external browser bridge", async () => {
    let published: ((value: { release_url: string }) => void) | undefined;
    mocks.publishHook.mockImplementation((options) => {
      published = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.publishMutate,
        reset: mocks.publishReset,
      };
    });
    const { user } = render(<ProviderPublicationRelease projectId={7} />);
    act(() => published?.({ release_url: preview.release_url }));
    await user.click(screen.getByRole("button", { name: preview.release_url }));
    expect(mocks.openExternal).toHaveBeenCalledWith(
      preview.release_url,
      "Could not open the GitHub release.",
    );
  });

  it("derives only a canonical UUID from the archive parent folder", () => {
    expect(
      bundleIdFromArchivePath(
        "/tmp/provider-publication-bundles/123e4567-e89b-42d3-a456-426614174000/agent.tgz",
      ),
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(bundleIdFromArchivePath("/tmp/output/agent.tgz")).toBe("");
    expect(bundleIdFromArchivePath("/tmp/123E4567-E89B-42D3-A456-426614174000/agent.tgz")).toBe("");
  });

  it("does not contact GitHub until the author explicitly requests a review", async () => {
    const view = render(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );
    const { user } = view;

    expect(mocks.previewMutate).not.toHaveBeenCalled();
    expect(mocks.publishMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review GitHub publication" })).toBeDisabled();

    await user.type(screen.getByLabelText("Release notes"), "Ship this version");
    await user.click(screen.getByRole("button", { name: "Review GitHub publication" }));
    mocks.previewHook.mockReturnValue({
      error: new Error("GitHub preview failed"),
      isError: true,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    view.rerender(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("GitHub preview failed");
    expect(mocks.previewMutate).toHaveBeenCalledWith({
      id: 7,
      data: {
        bundle_id: "123e4567-e89b-42d3-a456-426614174000",
        release_notes: "Ship this version",
      },
    });
    expect(mocks.publishMutate).not.toHaveBeenCalled();
  });

  it("shows the exact plan and requires a separate confirmation before publishing", async () => {
    let previewSuccess: ((value: typeof preview) => void) | undefined;
    mocks.previewHook.mockImplementation((options) => {
      previewSuccess = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    const view = render(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );
    const { user } = view;
    act(() => previewSuccess?.(preview));

    expect(screen.getByText("acme/example-agent")).toBeInTheDocument();
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(screen.getByText("archive-hash")).toBeInTheDocument();
    expect(screen.getByText("example-agent.tgz")).toBeInTheDocument();
    expect(screen.getByText("2,048 bytes")).toBeInTheDocument();
    expect(screen.getByText("metadata-hash")).toBeInTheDocument();
    expect(screen.getByText("darwin-aarch64")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(screen.getByText("Exact release notes")).toBeInTheDocument();
    const publish = screen.getByRole("button", { name: "Publish GitHub release" });
    expect(publish).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /confirm this exact/i }));
    await user.click(publish);
    expect(mocks.publishMutate).toHaveBeenCalledWith({
      id: 7,
      data: {
        bundle_id: preview.bundle_id,
        release_notes: preview.release_notes,
        expected_plan_sha256: "plan-hash",
        confirmed: true,
      },
    });
  });

  it("invalidates review and confirmation when an input changes", async () => {
    let previewSuccess: ((value: typeof preview) => void) | undefined;
    mocks.previewHook.mockImplementation((options) => {
      previewSuccess = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    const view = render(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );
    const { user } = view;
    act(() => previewSuccess?.(preview));
    await user.click(screen.getByRole("checkbox", { name: /confirm this exact/i }));

    fireEvent.change(screen.getByLabelText("Release notes"), { target: { value: "Changed" } });

    expect(screen.queryByText("GitHub publication preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Prepare a local registry contribution")).not.toBeInTheDocument();
    expect(mocks.previewReset).toHaveBeenCalled();
    expect(mocks.publishReset).toHaveBeenCalled();
  });

  it("locks sibling release and contribution controls during a registry request", async () => {
    let previewSuccess: ((value: typeof preview) => void) | undefined;
    mocks.previewHook.mockImplementation((options) => {
      previewSuccess = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    const { user } = render(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );
    act(() => previewSuccess?.(preview));

    await user.click(screen.getByRole("button", { name: "Review registry submission" }));

    expect(screen.getByPlaceholderText("00000000-0000-4000-8000-000000000000")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish GitHub release" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /local file creation/i })).toBeDisabled();
    expect(mocks.registryPreviewMutate).toHaveBeenCalled();
  });

  it("removes the prior approval before a refreshed review request", async () => {
    let previewSuccess: ((value: typeof preview) => void) | undefined;
    mocks.previewHook.mockImplementation((options) => {
      previewSuccess = options.mutation.onSuccess;
      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: mocks.previewMutate,
        reset: mocks.previewReset,
      };
    });
    const view = render(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );
    const { user } = view;
    await user.type(screen.getByLabelText("Release notes"), preview.release_notes);
    act(() => previewSuccess?.(preview));
    await user.click(screen.getByRole("checkbox", { name: /confirm this exact/i }));

    await user.click(screen.getByRole("button", { name: "Review GitHub publication" }));
    mocks.previewHook.mockReturnValue({
      error: new Error("Refreshed preview failed"),
      isError: true,
      isPending: false,
      mutate: mocks.previewMutate,
      reset: mocks.previewReset,
    });
    view.rerender(
      <ProviderPublicationRelease
        projectId={7}
        initialBundleId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Refreshed preview failed");
    expect(screen.queryByText("GitHub publication preview")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Publish GitHub release" }),
    ).not.toBeInTheDocument();
    expect(mocks.previewReset).toHaveBeenCalled();
    expect(mocks.publishReset).toHaveBeenCalled();
  });
});
