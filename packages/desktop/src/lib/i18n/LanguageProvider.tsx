import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { getRuntimeConfigSync } from "@/api/client";
import { useGetWorkspaceSetting } from "@/api/generated";
import en from "./catalogs/en.json";
import fr from "./catalogs/fr.json";
import {
  languagePreference,
  LANGUAGE_SETTING,
  matchSystemLanguage,
  type Language,
} from "./languages";

const resources = { en: { language: en }, fr: { language: fr } } satisfies Record<
  Language,
  { language: typeof en }
>;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "language";
    resources: typeof resources.en;
  }
}

interface LanguageSettingState {
  preference: Language | "system";
  system: Language;
  loading: boolean;
  error: unknown;
}

const SettingContext = createContext<LanguageSettingState | null>(null);

export function useLanguageSettingState() {
  const state = useContext(SettingContext);
  if (!state) throw new Error("Language settings require a LanguageProvider");
  return state;
}

function subscribeToLanguageChange(notify: () => void) {
  // Electron supplies the OS preference at startup. Browsers can change it while open.
  if (getRuntimeConfigSync().preferredLanguages) return () => {};
  window.addEventListener("languagechange", notify);
  return () => window.removeEventListener("languagechange", notify);
}

function readSystemLanguage() {
  return matchSystemLanguage(getRuntimeConfigSync().preferredLanguages ?? navigator.languages);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const system = useSyncExternalStore(subscribeToLanguageChange, readSystemLanguage);
  const { data, isPending, error } = useGetWorkspaceSetting(LANGUAGE_SETTING);
  const preference = languagePreference(data?.value);
  const language = preference === "system" ? system : preference;
  const state = useMemo(
    () => ({ preference, system, loading: isPending, error }),
    [preference, system, isPending, error],
  );
  const [i18n] = useState(() => {
    const instance = createInstance();
    void instance.init({
      lng: language,
      fallbackLng: "en",
      initAsync: false,
      ns: ["language"],
      defaultNS: "language",
      resources,
      interpolation: { escapeValue: false },
    });
    return instance;
  });

  useLayoutEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);

  return (
    <SettingContext.Provider value={state}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </SettingContext.Provider>
  );
}
