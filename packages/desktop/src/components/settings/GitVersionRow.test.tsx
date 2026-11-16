import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { GitVersionRow } from "./GitVersionRow";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/api/generated", () => ({
  useGetGitVersion: () => mocks.query(),
}));

function answer(data: unknown): void {
  mocks.query.mockReturnValue({ data, isError: false, error: null });
}

describe("GitVersionRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a current Git", () => {
    answer({ version: "2.54.0", error: null, unsupported: [] });
    render(<GitVersionRow />);
    expect(screen.getByText("2.54.0")).toBeInTheDocument();
    expect(screen.getByText("Every Git feature is available.")).toBeInTheDocument();
  });

  it("names what an old Git cannot do and the version each needs", () => {
    answer({
      version: "2.34.1",
      error: null,
      unsupported: [{ label: "Merge conflict preview", minimum_version: "2.38.0" }],
    });
    render(<GitVersionRow />);
    expect(screen.getByText("2.34.1")).toBeInTheDocument();
    expect(
      screen.getByText("Too old for: Merge conflict preview (Git 2.38.0). Update Git to use them."),
    ).toBeInTheDocument();
  });

  it("explains a missing Git", () => {
    answer({ version: null, error: "Git could not be started: not found", unsupported: [] });
    render(<GitVersionRow />);
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getByText(/Git could not be started: not found/)).toBeInTheDocument();
  });

  it("surfaces a failed request", () => {
    mocks.query.mockReturnValue({ data: undefined, isError: true, error: new Error("offline") });
    render(<GitVersionRow />);
    expect(screen.getByText("Could not read the Git version: offline")).toBeInTheDocument();
  });

  it("shows that detection is pending", () => {
    mocks.query.mockReturnValue({ data: undefined, isError: false, error: null });
    render(<GitVersionRow />);
    expect(screen.getByText("Detecting the installed Git…")).toBeInTheDocument();
  });
});
