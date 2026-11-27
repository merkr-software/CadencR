import { createInstance, type BackendModule } from "i18next";
import { z } from "zod";
import enUS from "../lib/i18n/catalogs/en-US.json";
import {
  catalogByLanguage,
  catalogLanguage,
  DEFAULT_LANGUAGE,
  type Language,
} from "../lib/i18n/languages";

const catalogSchema = z.object({
  language: z.object({ label: z.string(), system: z.string() }),
  ui: z.custom<object>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  ),
});
type Catalog = z.infer<typeof catalogSchema>;
type LazyLanguage = Exclude<Language, typeof DEFAULT_LANGUAGE>;

declare const __CADENCR_RENDERER__: boolean;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "ui";
    resources: { language: Catalog["language"]; ui: Record<string, string> };
  }
}

const nativeCatalogLoaders: Readonly<Record<LazyLanguage, () => Promise<{ default: Catalog }>>> = {
  "es-ES": () => import("../lib/i18n/catalogs/es-ES.json"),
  "de-DE": () => import("../lib/i18n/catalogs/de-DE.json"),
  "ja-JP": () => import("../lib/i18n/catalogs/ja-JP.json"),
  "fr-FR": () => import("../lib/i18n/catalogs/fr-FR.json"),
  "pt-BR": () => import("../lib/i18n/catalogs/pt-BR.json"),
};

const rendererCatalogUrls: Readonly<Record<LazyLanguage, () => URL>> = {
  "es-ES": () => new URL("../lib/i18n/catalogs/es-ES.json", import.meta.url),
  "de-DE": () => new URL("../lib/i18n/catalogs/de-DE.json", import.meta.url),
  "ja-JP": () => new URL("../lib/i18n/catalogs/ja-JP.json", import.meta.url),
  "fr-FR": () => new URL("../lib/i18n/catalogs/fr-FR.json", import.meta.url),
  "pt-BR": () => new URL("../lib/i18n/catalogs/pt-BR.json", import.meta.url),
};
const rendererCatalogRequests = new Map<LazyLanguage, Promise<Catalog>>();
const failedRendererCatalogs = new Set<LazyLanguage>();

async function readRendererCatalog(locale: LazyLanguage): Promise<Catalog> {
  const url = rendererCatalogUrls[locale]();
  const response = await fetch(url, failedRendererCatalogs.has(locale) ? { cache: "reload" } : {});
  if (!response.ok) throw new Error(`Catalog ${locale}: HTTP ${response.status}`);
  return catalogSchema.parse(await response.json());
}

function loadCatalog(locale: LazyLanguage): Promise<Catalog> {
  if (typeof __CADENCR_RENDERER__ === "undefined" || !__CADENCR_RENDERER__) {
    return nativeCatalogLoaders[locale]().then(({ default: catalog }) => catalog);
  }
  const pending = rendererCatalogRequests.get(locale);
  if (pending) return pending;
  // A renderer module import caches a failed load for the lifetime of the
  // document. Fetch lets a later selection read the same packaged asset again.
  const request = readRendererCatalog(locale).then(
    (catalog) => {
      rendererCatalogRequests.delete(locale);
      return catalog;
    },
    (error: unknown) => {
      rendererCatalogRequests.delete(locale);
      failedRendererCatalogs.add(locale);
      throw error;
    },
  );
  rendererCatalogRequests.set(locale, request);
  return request;
}
const fallbackLng = {
  default: [DEFAULT_LANGUAGE],
  ...Object.fromEntries(
    Object.entries(catalogByLanguage).map(([base, locale]) => [base, [locale, DEFAULT_LANGUAGE]]),
  ),
};

const bundledCatalogs: BackendModule = {
  type: "backend",
  callbackApi: true,
  init: () => undefined,
  read(locale, namespace, callback) {
    // i18next also probes language-only and regional aliases. Its fallback
    // hierarchy reads the matching regional catalog for those aliases.
    const catalog = catalogLanguage(locale);
    if (
      catalog === DEFAULT_LANGUAGE ||
      catalog !== locale ||
      (namespace !== "ui" && namespace !== "language")
    ) {
      callback(null, undefined);
      return;
    }
    void loadCatalog(catalog).then(
      (catalog) => callback(null, catalog[namespace]),
      (error: unknown) => callback(error instanceof Error ? error : String(error), undefined),
    );
  },
};

/** Electron main, the app renderer and the Notch renderer each have their own instance. */
export const uiI18n = createInstance();
void uiI18n.use(bundledCatalogs).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng,
  ns: ["ui", "language"],
  defaultNS: "ui",
  resources: { [DEFAULT_LANGUAGE]: enUS },
  partialBundledLanguages: true,
  returnEmptyString: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});

export const translateUi = uiI18n.getFixedT(null, "ui");

/** An explicit load can retry a previous failed read without changing the active language. */
export async function loadUiCatalog(locale: string): Promise<void> {
  const catalog = catalogLanguage(locale);
  if (uiI18n.hasResourceBundle(catalog, "ui") && uiI18n.hasResourceBundle(catalog, "language"))
    return;
  await new Promise<void>((resolve, reject) => {
    void uiI18n.reloadResources([catalog], ["ui", "language"], (error?: unknown) => {
      if (error) {
        reject(
          new Error(
            translateUi("shell.language.loadError", "Could not load the interface language"),
            { cause: error },
          ),
        );
      } else resolve();
    });
  });
}

let requestedLocale: string | undefined;

export async function changeUiLanguage(locale: string): Promise<void> {
  requestedLocale = locale;
  await loadUiCatalog(locale);
  if (requestedLocale === locale && uiI18n.language !== locale) {
    await uiI18n.changeLanguage(locale);
  }
}
