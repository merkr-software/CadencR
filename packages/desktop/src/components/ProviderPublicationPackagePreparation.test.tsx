import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test-utils";
import { ProviderPublicationPackagePreparation } from "./ProviderPublicationPackagePreparation";

const generatedMocks = vi.hoisted(() => ({
  hook: vi.fn(),
  readiness: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  usePreparePublicationPackage: generatedMocks.hook,
  useGetProjectPublicationReadiness: generatedMocks.readiness,
}));

const idleMutation = {
  error: null,
  isError: false,
  isPending: false,
  mutate: generatedMocks.mutate,
  reset: generatedMocks.reset,
};

describe("ProviderPublicationPackagePreparation", () => {
  beforeEach(() => {
    generatedMocks.mutate.mockReset();
    generatedMocks.reset.mockReset();
    generatedMocks.hook.mockReset();
    generatedMocks.hook.mockReturnValue(idleMutation);
    generatedMocks.readiness.mockReturnValue({
      data: { supported_package_targets: ["linux-aarch64", "darwin-aarch64"] },
      error: null,
      isError: false,
      isLoading: false,
    });
  });

  it("submits a valid, explicitly reviewed form", async () => {
    const { user } = render(<ProviderPublicationPackagePreparation projectId={7} enabled />);

    fireEvent.change(screen.getByLabelText(/^Managed package metadata JSON/), {
      target: { value: '{"name":"agent"}' },
    });
    await user.type(screen.getByLabelText(/^Dedicated staging directory/), "/tmp/staging");
    screen.getByLabelText("Binary target").focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("option", { name: "linux-aarch64" }));
    await user.click(screen.getByRole("checkbox", { name: /reviewed staging/i }));
    await user.click(screen.getByRole("button", { name: "Prepare local bundle" }));

    expect(generatedMocks.mutate).toHaveBeenCalledWith({
      id: 7,
      data: {
        metadata_json: '{"name":"agent"}',
        staging_directory: "/tmp/staging",
        target: "linux-aarch64",
      },
    });
  });

  it("disables the whole form and shows progress while pending", () => {
    generatedMocks.hook.mockReturnValue({ ...idleMutation, isPending: true });
    render(<ProviderPublicationPackagePreparation projectId={7} enabled />);

    expect(screen.getByRole("group")).toBeDisabled();
    expect(screen.getByRole("button", { name: /preparing local bundle/i })).toBeDisabled();
  });

  it("shows target loading and readiness errors instead of the form", () => {
    generatedMocks.readiness.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    });
    const { rerender } = render(<ProviderPublicationPackagePreparation projectId={7} enabled />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading supported targets");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();

    generatedMocks.readiness.mockReturnValue({
      data: undefined,
      error: new Error("readiness unavailable"),
      isError: true,
      isLoading: false,
    });
    rerender(<ProviderPublicationPackagePreparation projectId={7} enabled />);
    expect(screen.getByRole("alert")).toHaveTextContent("readiness unavailable");
  });

  it("shows a prepared local-only result", () => {
    let success: ((result: object) => void) | undefined;
    generatedMocks.hook.mockImplementation((options) => {
      success = options.mutation.onSuccess;
      return idleMutation;
    });
    render(<ProviderPublicationPackagePreparation projectId={7} enabled />);
    act(() => {
      success?.({
        project_id: 7,
        plugin_id: "example.agent",
        target: "darwin-aarch64",
        archive_path: "/tmp/output/agent.tar.gz",
        metadata_path: "/tmp/output/package.json",
        sha256: "abc123",
        size: 2048,
      });
    });

    expect(screen.getByText("Local bundle prepared")).toBeInTheDocument();
    expect(screen.getByText("/tmp/output/agent.tar.gz")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText(/local files only/i)).toBeInTheDocument();
  });

  it("surfaces a structured backend error and permits retry", () => {
    const error = new AxiosError("Request failed");
    error.response = {
      data: { error: "metadata target does not match" },
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    generatedMocks.hook.mockReturnValue({ ...idleMutation, error, isError: true });
    render(<ProviderPublicationPackagePreparation projectId={7} enabled />);

    expect(screen.getByRole("alert")).toHaveTextContent("metadata target does not match");
    expect(screen.getByRole("button", { name: "Prepare local bundle" })).toBeInTheDocument();
  });

  it("clears a stale prepared result when an input changes", async () => {
    let success: ((result: object) => void) | undefined;
    generatedMocks.hook.mockImplementation((options) => {
      success = options.mutation.onSuccess;
      return idleMutation;
    });
    render(<ProviderPublicationPackagePreparation projectId={7} enabled />);
    act(() => {
      success?.({
        project_id: 7,
        plugin_id: "example.agent",
        target: "linux-x86_64",
        archive_path: "/tmp/output/agent.tar.gz",
        metadata_path: "/tmp/output/package.json",
        sha256: "abc123",
        size: 42,
      });
    });
    expect(screen.getByText("Local bundle prepared")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Managed package metadata JSON/), {
      target: { value: "{" },
    });

    expect(screen.queryByText("Local bundle prepared")).not.toBeInTheDocument();
    expect(generatedMocks.reset).toHaveBeenCalled();
  });
});
