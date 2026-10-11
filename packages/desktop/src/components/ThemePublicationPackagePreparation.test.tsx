import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test-utils";
import { ThemePublicationPackagePreparation } from "./ThemePublicationPackagePreparation";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), readiness: vi.fn() }));
vi.mock("@/api/generated", async (original) => ({
  ...(await original<typeof import("@/api/generated")>()),
  useGetProjectPublicationReadiness: mocks.readiness,
  usePreparePublicationPackage: () => ({
    mutate: mocks.prepare,
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));
describe("declarative theme authoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readiness.mockReturnValue({ isSuccess: true, isLoading: false, isError: false });
  });
  it("prepares data without a staging path, binary target or extra platform bundle", () => {
    render(<ThemePublicationPackagePreparation projectId={2} enabled />);
    expect(screen.queryByText("Other platform bundle UUIDs")).not.toBeInTheDocument();
    expect(screen.queryByText("Binary target")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Theme package metadata JSON/), {
      target: { value: '{"kind":"theme"}' },
    });
    expect(screen.getByRole("button", { name: "Prepare theme bundle" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "I reviewed the theme data and metadata" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Prepare theme bundle" }));
    expect(mocks.prepare).toHaveBeenCalledWith({
      id: 2,
      data: { metadata_json: '{"kind":"theme"}' },
    });
  });
  it("keeps preparation unavailable while readiness is loading or failed", () => {
    mocks.readiness.mockReturnValue({ isSuccess: false, isLoading: true, isError: false });
    render(<ThemePublicationPackagePreparation projectId={2} enabled />);
    expect(screen.getByText("Checking theme project…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare theme bundle" })).toBeDisabled();
  });
});
