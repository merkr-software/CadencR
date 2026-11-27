import { afterEach, expect, it } from "vitest";
import { changeUiLanguage } from "@/shared/ui-i18n";
import { autoNameWarningMessage } from "./auto-name-errors";

afterEach(async () => changeUiLanguage("en-US"));

it("translates an automatic naming warning and preserves other session diagnostics", async () => {
  await changeUiLanguage("fr-FR");
  const code = "RUNTIME_CLOSE_FAILED";
  const raw =
    "Could not auto-name this conversation. The auto-naming provider did not close in time. Try again.";
  expect(autoNameWarningMessage(code, raw, "close_timeout")).toBe(
    "Impossible de renommer automatiquement cette conversation. Le fournisseur de renommage automatique ne s’est pas arrêté à temps. Réessayez.",
  );
  const diagnostic = "The session runtime did not close: pipe ended";
  expect(autoNameWarningMessage(code, diagnostic)).toBe(diagnostic);
  expect(autoNameWarningMessage(code, diagnostic, "unknown_reason")).toBe(diagnostic);

  await changeUiLanguage("en-US");
  expect(autoNameWarningMessage(code, raw, "close_timeout")).toBe(raw);
});
