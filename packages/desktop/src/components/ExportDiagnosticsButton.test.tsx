import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { ExportDiagnosticsButton } from "./ExportDiagnosticsButton";

beforeEach(() => clearDesktopBridgeOverrideForTests());

it("exports with visible loading and reports success only after saving", async () => {
  let finish!: (value: { canceled: boolean }) => void;
  const save = vi.fn(
    () =>
      new Promise<{ canceled: boolean }>((resolve) => {
        finish = resolve;
      }),
  );
  setDesktopBridgeOverrideForTests({ exportRendererDiagnostics: save });
  render(<ExportDiagnosticsButton />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostic report" }));
  expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ schemaVersion: 1, buildId: expect.any(String) }),
  );
  finish({ canceled: false });
  expect(await screen.findByRole("status")).toHaveTextContent("Diagnostic report exported");
});

it("keeps cancellation quiet and exposes a save failure inline", async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce({ canceled: true })
    .mockRejectedValueOnce(new Error("Disk full"));
  setDesktopBridgeOverrideForTests({ exportRendererDiagnostics: save });
  render(<ExportDiagnosticsButton />);
  const button = screen.getByRole("button", { name: "Export diagnostic report" });
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
});
