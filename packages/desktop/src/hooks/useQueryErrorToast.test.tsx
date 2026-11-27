import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { toast, Toaster } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiI18n, type UiTranslator } from "@/lib/i18n/ui";
import { useQueryErrorToast } from "./useQueryErrorToast";

const wrapper = ({ children }: React.PropsWithChildren) => (
  <>
    <Toaster closeButton />
    {children}
  </>
);
const blameUnavailable = (t: UiTranslator) =>
  t("workspace.editor.useCodeMirrorEditorController.blameUnavailable", "Git blame unavailable");

afterEach(async () => {
  act(() => toast.dismiss());
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
  vi.restoreAllMocks();
});

describe("useQueryErrorToast", () => {
  it("toasts a failed query once under its id, then dismisses it on recovery", async () => {
    const failed: { isError: boolean; error: unknown } = {
      isError: true,
      error: new Error("git ls-files failed"),
    };
    const report = vi.spyOn(toast, "error");
    const dismiss = vi.spyOn(toast, "dismiss");
    const { rerender } = renderHook(
      ({ query }) => useQueryErrorToast(query, blameUnavailable, "blame:1:a.ts"),
      { initialProps: { query: failed }, wrapper },
    );
    const message = await screen.findByText("Git blame unavailable: git ls-files failed");
    expect(message).toBeVisible();
    expect(report).toHaveBeenCalledWith(expect.anything(), { id: "blame:1:a.ts" });

    rerender({ query: { isError: true, error: new Error("git ls-files failed") } });
    expect(report).toHaveBeenCalledTimes(1);

    rerender({ query: { isError: false, error: null } });
    expect(dismiss).toHaveBeenCalledWith("blame:1:a.ts");
    await waitForElementToBeRemoved(message);
  });

  it("never touches the toaster for a query that has not failed", () => {
    const report = vi.spyOn(toast, "error");
    const dismiss = vi.spyOn(toast, "dismiss");
    const { unmount } = renderHook(() =>
      useQueryErrorToast({ isError: false, error: null }, blameUnavailable, "blame:1:b.ts"),
    );
    unmount();
    expect(report).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("retranslates an open notification without bringing it back after dismissal", async () => {
    uiI18n.addResourceBundle("fr", "ui", {
      common: { labelWithDetail: "{{label}} : {{detail}}", unknownError: "Erreur inconnue" },
      workspace: {
        editor: { useCodeMirrorEditorController: { blameUnavailable: "Git blame indisponible" } },
      },
    });
    const report = vi.spyOn(toast, "error");
    const { rerender } = renderHook(
      () => useQueryErrorToast({ isError: true, error: null }, blameUnavailable, "blame:1:c.ts"),
      { wrapper },
    );
    const message = await screen.findByText("Git blame unavailable: Unknown error");
    await act(() => uiI18n.changeLanguage("fr"));
    expect(screen.getByText("Git blame indisponible : Erreur inconnue")).toBe(message);

    fireEvent.click(screen.getByRole("button", { name: "Close toast" }));
    await waitForElementToBeRemoved(message);
    await act(() => uiI18n.changeLanguage("en"));
    rerender();
    expect(report).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Git blame unavailable: Unknown error")).toBeNull();
  });
});
