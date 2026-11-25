import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";
import { getRuntimeConfigSync } from "@/api/client";
import { useGetWorkspaceSetting } from "@/api/generated";
import { uiI18n } from "./ui";
import {
  languagePreference,
  LANGUAGE_SETTING,
  matchSystemLanguage,
  type Language,
} from "./languages";

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
  useLayoutEffect(() => {
    if (uiI18n.language !== language) void uiI18n.changeLanguage(language);
  }, [language]);

  return (
    <SettingContext.Provider value={state}>
      <I18nextProvider i18n={uiI18n}>{children}</I18nextProvider>
    </SettingContext.Provider>
  );
}
