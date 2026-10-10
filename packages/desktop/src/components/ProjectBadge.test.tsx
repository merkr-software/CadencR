// @vitest-environment jsdom
// Pinned to jsdom: asserts computed colors (happy-dom does not normalize them to rgb()) and the icon's blob-URL load.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { ProjectBadge } from "@/components/ProjectBadge";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  iconBlob: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useGetProjectSettings: () => mocks.settings(),
}));

vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  projectIconBlob: () => mocks.iconBlob(),
}));

/** Shape the project-settings query into the array the hooks read. */
function withSettings(entries: { key: string; value: string }[]): void {
  mocks.settings.mockReturnValue({ data: entries });
}

describe("ProjectBadge", () => {
  beforeEach(() => {
    // jsdom has no object-URL support; the badge only needs a stable string.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:icon"),
      revokeObjectURL: vi.fn(),
    });
    mocks.iconBlob.mockResolvedValue(new Blob(["<svg />"], { type: "image/svg+xml" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the color dot when no icon is configured", () => {
    withSettings([{ key: "color", value: "ff0000" }]);
    const { container } = render(<ProjectBadge projectId={1} />);

    const dot = container.querySelector("span");
    expect(dot).toBeTruthy();
    expect(dot?.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the icon instead of the dot once one is configured", async () => {
    withSettings([
      { key: "color", value: "ff0000" },
      { key: "icon_path", value: "public/logo.svg" },
    ]);
    const { container } = render(<ProjectBadge projectId={1} />);

    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:icon");
    // The dot must be gone — the icon replaces it rather than sitting beside it.
    expect(container.querySelector("span")).toBeNull();
  });

  it("falls back to the dot when the icon file cannot be read", async () => {
    withSettings([
      { key: "color", value: "00ff00" },
      { key: "icon_path", value: "missing.png" },
    ]);
    mocks.iconBlob.mockRejectedValue(new Error("not found"));

    const { container } = render(<ProjectBadge projectId={1} />);

    await waitFor(() => expect(container.querySelector("span")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    // No toast: a broken icon renders in many places at once, so it degrades
    // quietly to the accent dot.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
