import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from "react";
import { useIsRestoring } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { getRuntimeConfigSync } from "@/api/client";
import { useGetWorkspaceSetting } from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { uiI18n, useUiTranslation } from "./ui";
import {
  catalogLanguage,
  DEFAULT_LANGUAGE,
  languagePreference,
  LANGUAGE_SETTING,
  LEGACY_ENGLISH,
  subscribeToBrowserLanguage,
  type Language,
} from "./languages";
import { applyRendererLanguage } from "./language-document";
import { readSystemLocale, syncNativeLanguage } from "./renderer-language";

interface LanguageSettingState {
  preference: Language | "system";
  system: Language;
  suggestedLanguage: Language | undefined;
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
  const restoring = useIsRestoring();
  const { data, isPending, isFetchedAfterMount, fetchStatus, error, refetch } =
    useGetWorkspaceSetting(LANGUAGE_SETTING, {
      query: {
        // An old cached invitation must not override a choice saved while this window was closed.
        refetchOnMount: (query) => (query.state.data?.value === LEGACY_ENGLISH ? "always" : true),
      },
    });
  const { i18n } = useUiTranslation();
  const preference = languagePreference(data?.value);
  const preferenceLoaded = data !== undefined;
  const [verifiedLegacy, setVerifiedLegacy] = useState(false);
  useEffect(() => {
    if (!restoring && isFetchedAfterMount && fetchStatus === "idle" && !error) {
      setVerifiedLegacy(data?.value === LEGACY_ENGLISH);
    }
  }, [restoring, isFetchedAfterMount, fetchStatus, error, data?.value]);
  const suggestedLanguage =
    verifiedLegacy && !error && data?.value === LEGACY_ENGLISH && system !== DEFAULT_LANGUAGE
      ? system
      : undefined;
  const locale = preference === "system" ? systemLocale : preference;
  const [failure, setFailure] = useState<{ locale: string; error: Error }>();
  const [attempt, setAttempt] = useState(0);
  const loadError = failure?.locale === locale ? failure.error : undefined;
  const applying = preferenceLoaded && i18n.language !== locale && !loadError;
  const state = useMemo(
    () => ({
      preference,
      system,
      suggestedLanguage,
      loading: isPending,
      applying,
      error,
      loadError,
      retry: () => {
        if (error) void refetch();
        else setAttempt((n) => n + 1);
      },
    }),
    [preference, system, suggestedLanguage, isPending, applying, error, loadError, refetch],
  );
  useLayoutEffect(() => {
    // Keep the current language until we know whether this is an existing installation.
    if (!preferenceLoaded) return;
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
  }, [preferenceLoaded, locale, attempt]);

  return (
    <SettingContext.Provider value={state}>
      <I18nextProvider i18n={uiI18n}>{children}</I18nextProvider>
    </SettingContext.Provider>
  );
}
