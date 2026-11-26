import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";
import { getRuntimeConfigSync } from "@/api/client";
import { useGetWorkspaceSetting } from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { uiI18n, useUiTranslation } from "./ui";
import {
  catalogLanguage,
  languagePreference,
  LANGUAGE_SETTING,
  subscribeToBrowserLanguage,
  type Language,
} from "./languages";
import { applyRendererLanguage } from "./language-document";
import { readSystemLocale, syncNativeLanguage } from "./renderer-language";

interface LanguageSettingState {
  preference: Language | "system";
  system: Language;
  loading: boolean;
  applying: boolean;
  error: unknown;
  loadError: Error | undefined;
  retry: () => void;
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

export function LanguageProvider({ children }: { children: ReactNode }) {
  const systemLocale = useSyncExternalStore(subscribeToLanguageChange, readSystemLocale);
  const system = catalogLanguage(systemLocale);
  const { data, isPending, error } = useGetWorkspaceSetting(LANGUAGE_SETTING);
  const { i18n } = useUiTranslation();
  const preference = languagePreference(data?.value);
  const locale = preference === "system" ? systemLocale : preference;
  const [failure, setFailure] = useState<{ locale: string; error: Error }>();
  const [attempt, setAttempt] = useState(0);
  const loadError = failure?.locale === locale ? failure.error : undefined;
  const applying = i18n.language !== locale && !loadError;
  const state = useMemo(
    () => ({
      preference,
      system,
      loading: isPending,
      applying,
      error,
      loadError,
      retry: () => setAttempt((n) => n + 1),
    }),
    [preference, system, isPending, applying, error, loadError],
  );
  useLayoutEffect(() => {
    let current = true;
    setFailure(undefined);
    void applyRendererLanguage(locale).then(
      () => {
        if (current) void syncNativeLanguage(locale);
      },
      (error: unknown) => {
        if (current) {
          const reason = error instanceof Error ? error : new Error(String(error));
          setFailure({ locale, error: reason });
          toastError(reason, "");
        }
      },
    );
    return () => {
      current = false;
    };
  }, [locale, attempt]);

  return (
    <SettingContext.Provider value={state}>
      <I18nextProvider i18n={uiI18n}>{children}</I18nextProvider>
    </SettingContext.Provider>
  );
}
