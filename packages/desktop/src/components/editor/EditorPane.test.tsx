// `render` comes from test-utils, not testing-library directly: the level-0 and
// mobile branches mount `EditorSubTabs`, which needs a QueryClientProvider.
import { render, screen } from "@/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useVimModeLevel", () => ({ useVimModeLevel: vi.fn() }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: vi.fn() }));
vi.mock("./neovim/NeovimPane", () => ({
  default: ({ featureId }: { featureId: number }) => (
    <div data-testid="neovim-pane">neovim pane for {featureId}</div>
  ),
}));
vi.mock("@/stores/editor-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/editor-store")>();
  return {
    ...actual,
    useEditorStore: vi.fn(() => null),
  };
});

const { useVimModeLevel } = await import("@/hooks/useVimModeLevel");
const { useIsMobile } = await import("@/hooks/useIsMobile");
const { default: EditorPane } = await import("./EditorPane");

describe("EditorPane vim level branching", () => {
  // `NeovimPane` is `lazy()`-loaded behind Suspense, so it only appears after
  // the dynamic import resolves — `findBy*`, never `getBy*`.
  it("renders NeovimPane full-frame at level 2 on desktop", async () => {
    vi.mocked(useVimModeLevel).mockReturnValue("2");
    vi.mocked(useIsMobile).mockReturnValue(false);
    render(<EditorPane featureId={1} paneId="main" projectId={1} />);
    expect(await screen.findByTestId("neovim-pane")).toBeInTheDocument();
  });

  it("shows the mobile fallback banner at level 2 on mobile, without mounting NeovimPane", async () => {
    vi.mocked(useVimModeLevel).mockReturnValue("2");
    vi.mocked(useIsMobile).mockReturnValue(true);
    render(<EditorPane featureId={1} paneId="main" projectId={1} />);
    expect(await screen.findByText(/not available on mobile/i)).toBeInTheDocument();
    expect(screen.queryByTestId("neovim-pane")).not.toBeInTheDocument();
  });

  it("renders the normal editor content at level 0", () => {
    vi.mocked(useVimModeLevel).mockReturnValue("0");
    vi.mocked(useIsMobile).mockReturnValue(false);
    render(<EditorPane featureId={1} paneId="main" projectId={1} />);
    expect(screen.queryByTestId("neovim-pane")).not.toBeInTheDocument();
  });
});
