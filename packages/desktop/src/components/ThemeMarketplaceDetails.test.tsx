import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test-utils";
import { ThemeMarketplaceDetails } from "./ThemeMarketplaceDetails";
import type { useThemeMarketplace } from "@/hooks/useThemeMarketplace";
import type { ThemeMarketplacePackage } from "@/lib/theme-marketplace";

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/api/generated", async (original) => ({
  ...(await original<typeof import("@/api/generated")>()),
  previewManagedThemePackage: mocks.preview,
}));
const mutate = vi.fn();
function packages(): ThemeMarketplacePackage[] {
  return ["1.0.0", "2.0.0"].map((version) => ({
    theme: {
      id: "midnight",
      name: "Midnight",
      description: "Declarative",
      version,
      repository: "https://github.com/acme/theme",
      license: "MIT",
      document_version: 1,
      distribution: {
        archive: "https://github.com/acme/theme/releases/download/v1/theme.tgz",
        sha256: "a".repeat(64),
      },
    },
    host: { publisher: "acme", compatibility: { min_app_version: "0.12.0" } },
  }));
}
function state(installedVersion?: string): ReturnType<typeof useThemeMarketplace> {
  return {
    inventory: {
      data: installedVersion ? [{ id: "midnight", version: installedVersion }] : [],
      isSuccess: true,
    },
    catalog: {
      data: {
        verified: true,
        recommended_versions: { midnight: "2.0.0" },
        index: { signed: { schema_version: 2, expires_at: "2099-01-01T00:00:00Z", packages: [] } },
      },
    },
    mutation: { isPending: false, mutate },
  } as unknown as ReturnType<typeof useThemeMarketplace>;
}
describe("theme exact version selection", () => {
  beforeEach(() => {
    mutate.mockReset();
    mocks.preview.mockReset();
  });
  it("recommends the backend version rather than the first historical version", () => {
    render(<ThemeMarketplaceDetails packages={packages()} state={state()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Install theme 2.0.0" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Install theme 1.0.0" })).not.toBeInTheDocument();
    expect(screen.getByText(/Installation does not activate/)).toBeInTheDocument();
  });
  it("preserves an installed version absent from the catalog", () => {
    render(
      <ThemeMarketplaceDetails packages={packages()} state={state("3.0.0")} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Theme version installed" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveTextContent("3.0.0");
  });
  it("preserves a late arriving installation instead of proposing a downgrade", () => {
    const view = render(
      <ThemeMarketplaceDetails packages={packages()} state={state()} onClose={vi.fn()} />,
    );
    view.rerender(
      <ThemeMarketplaceDetails packages={packages()} state={state("3.0.0")} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Theme version installed" })).toBeDisabled();
  });
  it("aborts and ignores an in-flight preview when catalog identity changes", async () => {
    let resolvePreview: ((value: unknown) => void) | undefined;
    mocks.preview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const initial = state();
    const view = render(
      <ThemeMarketplaceDetails packages={packages()} state={initial} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview theme" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce());
    const signal = mocks.preview.mock.calls[0][1] as AbortSignal;
    const replacement = state();
    if (replacement.catalog.data?.index)
      replacement.catalog.data.index.signature = {
        algorithm: "ed25519",
        key_id: "next",
        value: "new-signature",
      };
    view.rerender(
      <ThemeMarketplaceDetails packages={packages()} state={replacement} onClose={vi.fn()} />,
    );
    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview theme" })).toBeEnabled(),
    );
    await act(async () => {
      resolvePreview?.({});
    });
    expect(screen.queryByText(/Verified archive preview/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
