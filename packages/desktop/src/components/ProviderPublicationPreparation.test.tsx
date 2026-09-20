import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { render, screen } from "@/test-utils";
import { ProviderPublicationPreparation } from "./ProviderPublicationPreparation";

const generatedMocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetProjectPublicationReadiness: generatedMocks.readiness,
}));

describe("ProviderPublicationPreparation", () => {
  beforeEach(() => {
    generatedMocks.refetch.mockReset();
    generatedMocks.readiness.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
  });

  it("shows a visible loading state", () => {
    render(<ProviderPublicationPreparation projectId={7} enabled />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking local prerequisites");
  });

  it("surfaces backend details from Axios errors", () => {
    const error = new AxiosError("Request failed");
    error.response = {
      data: { error: "repository cannot be read" },
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    generatedMocks.readiness.mockReturnValue({
      data: undefined,
      error,
      isError: true,
      isLoading: false,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
    render(<ProviderPublicationPreparation projectId={7} enabled />);

    expect(screen.getByRole("alert")).toHaveTextContent("repository cannot be read");
  });

  it("renders blocked checks without offering publication", () => {
    generatedMocks.readiness.mockReturnValue({
      data: {
        project_id: 7,
        plugin_id: "example.provider",
        local_preparation: "blocked",
        summary: "Fix the failed local checks.",
        checks: [
          { id: "manifest", label: "Manifest", status: "fail", detail: "Missing manifest." },
        ],
      },
      error: null,
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
    render(<ProviderPublicationPreparation projectId={7} enabled />);

    expect(screen.getByText("Local preparation is blocked")).toBeInTheDocument();
    expect(screen.getByText("Missing manifest.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /publish/i })).not.toBeInTheDocument();
  });

  it("describes passing checks as local preparation only", () => {
    generatedMocks.readiness.mockReturnValue({
      data: {
        project_id: 7,
        plugin_id: "example.provider",
        local_preparation: "prepared",
        summary: "External review is still required.",
        checks: [
          { id: "manifest", label: "Manifest", status: "pass", detail: "Manifest is valid." },
        ],
      },
      error: null,
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
    render(<ProviderPublicationPreparation projectId={7} enabled />);

    expect(screen.getByText("All local preparation checks pass")).toBeInTheDocument();
    expect(screen.getByText(/does not mean the provider is published/i)).toBeInTheDocument();
  });

  it("does not present warning-only preparation as all checks passing", () => {
    generatedMocks.readiness.mockReturnValue({
      data: {
        project_id: 7,
        plugin_id: "example.provider",
        local_preparation: "prepared",
        summary: "Advisory review remains.",
        checks: [
          {
            id: "license",
            label: "License metadata",
            status: "warning",
            detail: "License metadata is missing.",
          },
        ],
      },
      error: null,
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
    render(<ProviderPublicationPreparation projectId={7} enabled />);

    expect(screen.getByText("No blocking local issues found")).toBeInTheDocument();
    expect(screen.queryByText(/all local preparation checks pass/i)).not.toBeInTheDocument();
  });

  it("refreshes checks manually", async () => {
    generatedMocks.readiness.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: generatedMocks.refetch,
    });
    const { user } = render(<ProviderPublicationPreparation projectId={7} enabled />);

    await user.click(screen.getByRole("button", { name: "Refresh checks" }));
    expect(generatedMocks.refetch).toHaveBeenCalledOnce();
  });
});
