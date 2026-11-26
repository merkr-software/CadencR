import type { BackendModule } from "i18next";
import { afterEach, expect, it, vi } from "vitest";
import { changeUiLanguage, translateUi, uiI18n } from "./ui-i18n";

afterEach(async () => {
  await changeUiLanguage("en-US");
});

it("keeps the latest selection when an earlier locale is still loading", async () => {
  expect(uiI18n.hasResourceBundle("ja-JP", "ui")).toBe(false);
  const changes: string[] = [];
  const record = (locale: string) => changes.push(locale);
  uiI18n.on("languageChanged", record);
  try {
    await Promise.all([changeUiLanguage("ja-JP"), changeUiLanguage("en-US")]);
    expect(uiI18n.hasResourceBundle("ja-JP", "ui")).toBe(true);
    expect(uiI18n.language).toBe("en-US");
    expect(changes).toEqual([]);
  } finally {
    uiI18n.off("languageChanged", record);
  }
});

it("keeps the displayed language on a failed load and can retry the same catalog", async () => {
  const backend: BackendModule = uiI18n.services.backendConnector.backend;
  const failedRead = vi
    .spyOn(backend, "read")
    .mockImplementation((_locale, _namespace, callback) => {
      callback(new Error("Unavailable catalog"), undefined);
    });
  try {
    await expect(changeUiLanguage("pt-BR")).rejects.toThrow(
      "Could not load the interface language",
    );
    expect(uiI18n.language).toBe("en-US");
    expect(uiI18n.getFixedT(null, "language")("label")).toBe("Language");
  } finally {
    failedRead.mockRestore();
  }
  await changeUiLanguage("pt-BR");
  expect(uiI18n.resolvedLanguage).toBe("pt-BR");
  expect(uiI18n.getFixedT(null, "language")("label")).toBe("Idioma");
});

it.each([
  ["en-GB", "en-US", "Language"],
  ["es-MX", "es-ES", "Idioma"],
  ["de-DE", "de-DE", "Sprache"],
  ["ja-JP", "ja-JP", "言語"],
  ["fr-CA", "fr-FR", "Langue"],
  ["pt-PT", "pt-BR", "Idioma"],
])("loads the %s UI from the %s catalog using the i18next API", async (locale, catalog, label) => {
  await uiI18n.changeLanguage(locale);
  expect(uiI18n.language).toBe(locale);
  expect(uiI18n.resolvedLanguage).toBe(catalog);
  expect(uiI18n.hasResourceBundle(catalog, "ui")).toBe(true);
  expect(uiI18n.getFixedT(null, "language")("label")).toBe(label);
  expect(translateUi("test.missing", "Hello {{name}}", { name: "Ada" })).toBe("Hello Ada");
});

it("re-fetches the renderer catalog after a failed request and shares the read across namespaces", async () => {
  const fetchCatalog = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        language: { label: "Sprache", system: "System" },
        ui: { test: { greeting: "Hallo" } },
      }),
    );
  vi.stubGlobal("__CADENCR_RENDERER__", true);
  vi.stubGlobal("fetch", fetchCatalog);
  vi.resetModules();
  try {
    const { changeUiLanguage, translateUi, uiI18n } = await import("./ui-i18n");
    await expect(changeUiLanguage("de-DE")).rejects.toThrow(
      "Could not load the interface language",
    );
    expect(uiI18n.language).toBe("en-US");
    await changeUiLanguage("de-DE");
    expect(uiI18n.getFixedT(null, "language")("label")).toBe("Sprache");
    expect(translateUi("test.greeting", "Hello")).toBe("Hallo");
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    const [url] = fetchCatalog.mock.calls[0];
    expect(String(url)).toMatch(/\/catalogs\/de-DE\.json$/);
    expect(fetchCatalog).toHaveBeenLastCalledWith(url, { cache: "reload" });
  } finally {
    vi.unstubAllGlobals();
  }
});
