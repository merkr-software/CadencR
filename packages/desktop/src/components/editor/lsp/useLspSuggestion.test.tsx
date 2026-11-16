// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useLspSuggestion } from "./useLspSuggestion";
import type { LspResolution } from "@/lib/lsp/useLspResolution";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), mutate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("sonner", () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/hooks/useLspMarketplace", () => ({
  useLspMarketplace: () => ({ mutation: { mutate: mocks.mutate, isPending: false, error: null } }),
}));
vi.mock("@/api/generated", () => ({
  useGetProjectSettings: () => ({ data: [], isPending: false }),
  setProjectSetting: vi.fn(),
  getGetProjectSettingsQueryKey: () => ["settings"],
}));

function resolution(ids = ["first"]): LspResolution {
  return {
    language_id: "custom",
    servers: [],
    candidates: [],
    primary: null,
    linters: [],
    primary_disabled: false,
    ignored: false,
    error: null,
    suggestions: ids.map((id) => ({ lsp_id: id, version: "1.0.0", reason: "compatible" })),
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}
function renderPrompt() {
  const renderToast = vi.mocked(toast.custom).mock.calls.at(-1)?.[0];
  if (!renderToast) throw new Error("Suggestion was not shown");
  return render(renderToast("prompt"), { wrapper });
}

describe("project language suggestions", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("shares one toast id across tabs and dismisses after every tab becomes ineligible", () => {
    const first = renderHook(({ value }) => useLspSuggestion(31, value), {
      initialProps: { value: resolution() },
    });
    const second = renderHook(({ value }) => useLspSuggestion(31, value), {
      initialProps: { value: resolution() },
    });
    expect(vi.mocked(toast.custom).mock.calls.map(([, options]) => options?.id)).toEqual([
      "lsp-suggestion:31:custom",
      "lsp-suggestion:31:custom",
    ]);
    first.rerender({ value: resolution([]) });
    expect(toast.dismiss).not.toHaveBeenCalled();
    second.rerender({ value: { ...resolution(), ignored: true } });
    expect(toast.dismiss).toHaveBeenCalledWith("lsp-suggestion:31:custom");
  });

  it("does not retain a stale shown marker after the last editor closes", () => {
    const first = renderHook(() => useLspSuggestion(32, resolution()));
    first.unmount();
    renderHook(() => useLspSuggestion(32, resolution()));
    expect(toast.custom).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit choice for equally compatible servers", () => {
    renderHook(() => useLspSuggestion(33, resolution(["first", "second"])));
    renderPrompt();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Language server to install" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("installs a sole suggestion only after clicking Install", () => {
    renderHook(() => useLspSuggestion(34, resolution()));
    renderPrompt();
    expect(mocks.mutate).not.toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Install" })));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { kind: "install", id: "first", version: "1.0.0" },
      expect.any(Object),
    );
  });
});
