import { afterEach, expect, it, vi } from "vitest";
import { useTranslation } from "react-i18next";
import { act, createTestQueryClient, render, screen, waitFor } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { LanguageProvider } from "./LanguageProvider";
import { formatSidebarFullTime } from "@/lib/sidebar-time";
import {
  catalogLanguage,
  LANGUAGE_SETTING,
  languagePreference,
  matchSystemLocale,
} from "./languages";
import { uiI18n } from "./ui";

afterEach(async () => {
  clearDesktopBridgeOverrideForTests();
  vi.restoreAllMocks();
  await uiI18n.changeLanguage("en-US");
});

it.each([
  { candidates: ["it-IT", "fr-CA", "en-GB"], expected: "fr-CA" },
  { candidates: ["fr_FR.UTF-8", "C"], expected: "fr-FR" },
  { candidates: ["en-US", "fr-FR"], expected: "en-US" },
  { candidates: ["de", "C"], expected: "de-DE" },
  { candidates: ["C", "es_MX.UTF-8", "fr-FR"], expected: "es-MX" },
  { candidates: ["pt-PT", "es-ES"], expected: "pt-PT" },
  { candidates: [], expected: "en-US" },
])("resolves $candidates in priority order", ({ candidates, expected }) => {
  expect(matchSystemLocale(candidates)).toBe(expected);
});

it.each([
  ["en", "en-US"],
  ["fr", "fr-FR"],
  ["es-MX", "es-ES"],
  ["ja_JP.UTF-8", "ja-JP"],
  ["pt-PT", "pt-BR"],
])("selects the regional catalog %s → %s", (preference, catalog) => {
  expect(languagePreference(preference)).toBe(catalog);
  expect(catalogLanguage(matchSystemLocale([preference]))).toBe(catalog);
});

const date = new Date(2026, 10, 25, 13, 30);

function LanguageProbe() {
  const { t } = useTranslation("language");
  return (
    <>
      <p>{t("label")}</p>
      <input aria-label="Draft" />
      <time data-testid="activity-time">{formatSidebarFullTime(date)}</time>
    </>
  );
}

it("follows the confirmed setting and returns to the browser language without remounting", async () => {
  const setInterfaceLanguage = vi.fn().mockResolvedValue(undefined);
  setDesktopBridgeOverrideForTests({ setInterfaceLanguage });
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["it-IT", "fr-CA"]);
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { staleTime: Infinity } });
  const key = getGetWorkspaceSettingQueryKey(LANGUAGE_SETTING);
  queryClient.setQueryData(key, { value: null });
  const { user } = render(
    <LanguageProvider>
      <LanguageProbe />
    </LanguageProvider>,
    { queryClient },
  );

  expect(await screen.findByText("Langue")).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
  expect(screen.getByTestId("activity-time")).toHaveTextContent(
    new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium", timeStyle: "short" }).format(date),
  );
  const draft = screen.getByRole("textbox");
  await user.type(draft, "unfinished");
  act(() => {
    queryClient.setQueryData(key, { value: "en" });
  });
  expect(await screen.findByText("Language")).toBeVisible();
  act(() => {
    queryClient.setQueryData(key, { value: "system" });
  });
  expect(await screen.findByText("Langue")).toBeVisible();
  languages.mockReturnValue([]);
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
  act(() => {
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(await screen.findByText("Language")).toBeVisible();
  expect(screen.getByTestId("activity-time")).toHaveTextContent(
    new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date),
  );
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("unfinished");
  await waitFor(() =>
    expect(setInterfaceLanguage.mock.calls).toEqual([["fr-CA"], ["en-US"], ["fr-CA"], ["en-GB"]]),
  );
});
