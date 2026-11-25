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
import { translateUi, uiI18n } from "./ui";
import { toastError } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  languagePreference,
  LANGUAGE_SETTING,
  isLanguage,
  matchSystemLocale,
  readBrowserLocale,
  subscribeToBrowserLanguage,
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
  return subscribeToBrowserLanguage(notify);
}

function readSystemLocale() {
  const preferredLanguages = getRuntimeConfigSync().preferredLanguages;
  return preferredLanguages ? matchSystemLocale(preferredLanguages) : readBrowserLocale();
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const systemLocale = useSyncExternalStore(subscribeToLanguageChange, readSystemLocale);
  const [base] = systemLocale.split("-");
  const system = isLanguage(base) ? base : "en";
  const { data, isPending, error } = useGetWorkspaceSetting(LANGUAGE_SETTING);
  const preference = languagePreference(data?.value);
  const language = preference === "system" ? system : preference;
  const locale = preference === "system" ? systemLocale : preference;
  const state = useMemo(
    () => ({ preference, system, loading: isPending, error }),
    [preference, system, isPending, error],
  );
  useLayoutEffect(() => {
    if (uiI18n.language !== locale) void uiI18n.changeLanguage(locale);
  }, [locale]);
  useLayoutEffect(() => {
    void desktopBridge.setInterfaceLanguage(language).catch((error: unknown) => {
      toastError(
        error,
        translateUi("shell.language.nativeError", "Could not update the native menu language"),
      );
    });
  }, [language]);

  return (
    <SettingContext.Provider value={state}>
      <I18nextProvider i18n={uiI18n}>{children}</I18nextProvider>
    </SettingContext.Provider>
  );
}
