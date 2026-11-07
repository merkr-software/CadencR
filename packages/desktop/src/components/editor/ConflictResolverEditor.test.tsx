import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null as unknown,
    isFetching: false,
    refetch: vi.fn(),
  },
  stage: vi.fn(),
  fileContent: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  ConflictKind: { dd: "dd", du: "du", ud: "ud", uu: "uu" },
  useGetFileContent: (params: unknown) => {
    mocks.fileContent(params);
    return mocks.query;
  },
}));
vi.mock("@/components/diff/useGitFileIndexActions", () => ({
  useGitFileIndexActions: () => ({
    stage: mocks.stage,
    reset: vi.fn(),
    isPending: false,
    pendingAction: null,
    pendingPath: null,
    error: null,
  }),
}));
vi.mock("./ConflictResultResolver", () => ({
  default: ({ filePath, initialContent }: { filePath: string; initialContent: string }) => (
    <div>
      Writable resolver for {filePath}: {initialContent}
    </div>
  ),
}));

import ConflictResolverEditor from "./ConflictResolverEditor";

function renderResolver(kind: "uu" | "dd" | "du" | "ud" = "uu") {
  return render(
    <ConflictResolverEditor
      featureId={1}
      paneId="main"
      projectId={2}
      filePath="conflict.ts"
      gitFilePath="packages/app/conflict.ts"
      conflictKind={kind}
    />,
  );
}

beforeEach(() => {
  mocks.query.data = undefined;
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  mocks.query.error = null;
  mocks.query.isFetching = false;
  vi.clearAllMocks();
});

describe("ConflictResolverEditor", () => {
  it("loads the exact worktree Result through the shared file-content seam", () => {
    mocks.query.data = {
      old_content: "base",
      new_content: "result",
      old_size: 4,
      new_size: 6,
      is_binary: false,
      is_large: false,
    };
    renderResolver();
    expect(screen.getByText("Writable resolver for conflict.ts: result")).toBeInTheDocument();
    // Git reads the checkout-root path; the editor keeps its own path.
    expect(mocks.fileContent).toHaveBeenCalledWith({
      feature_id: 1,
      file_path: "packages/app/conflict.ts",
      mode: "uncommitted",
    });
  });

  it("opens a large text Result because the marker resolver does not run a comparison diff", () => {
    mocks.query.data = {
      old_content: "base",
      new_content: "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> main\n",
      old_size: 4,
      new_size: 300_000,
      is_binary: false,
      is_large: true,
    };
    renderResolver();
    expect(screen.getByText(/Writable resolver for conflict\.ts/)).toBeInTheDocument();
    expect(screen.queryByText(/too large for the marker resolver/i)).not.toBeInTheDocument();
  });

  it("shows binary guidance and keeps Stage explicit", async () => {
    mocks.query.data = {
      old_content: null,
      new_content: null,
      old_size: 2,
      new_size: 2,
      is_binary: true,
      is_large: false,
    };
    const { user } = renderResolver();
    expect(screen.getByText(/Binary content cannot be resolved safely/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stage" }));
    expect(mocks.stage).toHaveBeenCalledWith("packages/app/conflict.ts", { conflicted: true });
  });

  it.each(["dd", "du", "ud"] as const)(
    "preserves a %s deleted Result as explicit deletion guidance",
    async (kind) => {
      mocks.query.data = {
        old_content: "old",
        new_content: null,
        old_size: 3,
        new_size: 0,
        is_binary: false,
        is_large: false,
      };
      const { user } = renderResolver(kind);
      expect(screen.getByText(/worktree result is deleted/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Stage deletion" }));
      expect(mocks.stage).toHaveBeenCalledWith("packages/app/conflict.ts", { conflicted: true });
    },
  );

  it("surfaces unavailable content and offers retry without guessing", async () => {
    mocks.query.isError = true;
    mocks.query.error = new Error("worktree result unavailable");
    const { user } = renderResolver();
    expect(screen.getByRole("alert")).toHaveTextContent("worktree result unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
});
