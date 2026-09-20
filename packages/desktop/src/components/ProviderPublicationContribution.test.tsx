import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import { ProviderPublicationContribution } from "./ProviderPublicationContribution";

const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  copy: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  usePreparePublicationContribution: mocks.hook,
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/lib/desktop-bridge", () => ({ desktopBridge: { revealInFinder: mocks.reveal } }));

const preview = {
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
  archive_size: 42,
  metadata_sha256: "metadata-hash",
  release_notes: "Exact notes",
  account: "octocat",
  plan_sha256: "plan-hash",
  release_url: "https://github.com/acme/example/releases/tag/v1.2.3",
  prerelease: false,
};

const idleMutation = {
  error: null,
  isError: false,
  isPending: false,
  mutate: mocks.mutate,
  reset: mocks.reset,
};

describe("ProviderPublicationContribution", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hook.mockReturnValue(idleMutation);
  });

  it("requires distinct confirmation and never calls automatically", async () => {
    const pending = vi.fn();
    const { user } = render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={pending}
      />,
    );
    const prepare = screen.getByRole("button", { name: "Prepare registry contribution" });
    expect(prepare).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /local file creation/i }));
    await user.click(prepare);

    expect(pending).toHaveBeenCalledWith(true);
    expect(mocks.mutate).toHaveBeenCalledWith({
      id: 7,
      data: {
        bundle_id: preview.bundle_id,
        release_notes: preview.release_notes,
        expected_plan_sha256: preview.plan_sha256,
        confirmed: true,
      },
    });
    expect(prepare).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /local file creation/i })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /local file creation/i }));
    expect(prepare).toBeEnabled();
  });

  it("locks its controls and shows progress while pending", () => {
    mocks.hook.mockReturnValue({ ...idleMutation, isPending: true });
    render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /local file creation/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /preparing registry contribution/i })).toBeDisabled();
  });

  it("surfaces preparation failures", () => {
    mocks.hook.mockReturnValue({
      ...idleMutation,
      error: new Error("published release does not match"),
      isError: true,
    });
    render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("published release does not match");
  });

  it("shows local paths with copy and reveal actions after success", async () => {
    let success: ((value: object) => void) | undefined;
    mocks.hook.mockImplementation((options) => {
      success = options.mutation.onSuccess;
      return idleMutation;
    });
    const { user } = render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    act(() =>
      success?.({
        project_id: 7,
        plugin_id: "example.agent",
        version: "1.2.3",
        release_url: preview.release_url,
        output_directory: "/tmp/contribution",
        package_path: "/tmp/contribution/package.json",
        submission_path: "/tmp/contribution/submission.json",
        pull_request_path: "/tmp/contribution/PULL_REQUEST.md",
      }),
    );

    expect(screen.getByText("Local contribution files prepared")).toBeInTheDocument();
    expect(
      screen.getByText(/No pull request was submitted, accepted, or signed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy package metadata" }));
    expect(mocks.copy).toHaveBeenCalledWith(
      "/tmp/contribution/package.json",
      "Package metadata copied",
    );
    await user.click(screen.getByRole("button", { name: "Reveal contribution files" }));
    expect(mocks.reveal).toHaveBeenCalledWith("/tmp/contribution");
    await user.click(screen.getByRole("checkbox", { name: /local file creation/i }));
    await user.click(screen.getByRole("button", { name: "Prepare registry contribution" }));
    expect(screen.queryByText("Local contribution files prepared")).not.toBeInTheDocument();
    expect(mocks.reset).toHaveBeenCalled();
  });

  it("unlocks sibling publication controls after a settled failure", () => {
    let settled: (() => void) | undefined;
    mocks.hook.mockImplementation((options) => {
      settled = options.mutation.onSettled;
      return { ...idleMutation, error: new Error("failed"), isError: true };
    });
    const pending = vi.fn();
    render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={pending}
      />,
    );

    settled?.();
    expect(pending).toHaveBeenCalledWith(false);
  });

  it("shows and locks the reveal action while Finder is opening", async () => {
    let success: ((value: object) => void) | undefined;
    let finishReveal: (() => void) | undefined;
    mocks.hook.mockImplementation((options) => {
      success = options.mutation.onSuccess;
      return idleMutation;
    });
    mocks.reveal.mockReturnValue(new Promise<void>((resolve) => (finishReveal = resolve)));
    const { user } = render(
      <ProviderPublicationContribution
        projectId={7}
        preview={preview}
        disabled={false}
        onPendingChange={vi.fn()}
      />,
    );
    act(() =>
      success?.({
        project_id: 7,
        plugin_id: "example.agent",
        version: "1.2.3",
        release_url: preview.release_url,
        output_directory: "/tmp/contribution",
        package_path: "/tmp/contribution/package.json",
        submission_path: "/tmp/contribution/submission.json",
        pull_request_path: "/tmp/contribution/PULL_REQUEST.md",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Reveal contribution files" }));
    expect(screen.getByRole("button", { name: "Revealing contribution files" })).toBeDisabled();
    act(() => finishReveal?.());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reveal contribution files" })).toBeEnabled(),
    );
  });
});
