import { afterEach, expect, it, vi } from "vitest";
import { useTranslation } from "react-i18next";
import { act, createTestQueryClient, render, screen } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { LanguageProvider } from "./LanguageProvider";
import { formatSidebarFullTime } from "@/lib/sidebar-time";
import { LANGUAGE_SETTING, matchSystemLocale } from "./languages";

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
  vi.restoreAllMocks();
});

it.each([
  { candidates: ["de-DE", "fr-CA", "en-GB"], expected: "fr-CA" },
  { candidates: ["fr_FR.UTF-8", "C"], expected: "fr-FR" },
  { candidates: ["en-US", "fr-FR"], expected: "en-US" },
  { candidates: ["de", "C"], expected: "en" },
  { candidates: [], expected: "en" },
])("resolves $candidates in priority order", ({ candidates, expected }) => {
  expect(matchSystemLocale(candidates)).toBe(expected);
});

const date = new Date(2026, 10, 25, 13, 30);

function Preview() {
  const { t } = useTranslation("language");
  return (
    <>
      <p>{t("preview")}</p>
      <input aria-label="Draft" />
      <time data-testid="activity-time">{formatSidebarFullTime(date)}</time>
    </>
  );
}

it("follows the confirmed setting and returns to the browser language without remounting", async () => {
  const setInterfaceLanguage = vi.fn().mockResolvedValue(undefined);
  setDesktopBridgeOverrideForTests({ setInterfaceLanguage });
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de", "fr-CA"]);
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { staleTime: Infinity } });
  const key = getGetWorkspaceSettingQueryKey(LANGUAGE_SETTING);
  queryClient.setQueryData(key, { value: null });
  const { user } = render(
    <LanguageProvider>
      <Preview />
    </LanguageProvider>,
    { queryClient },
  );

  expect(screen.getByText("Seul cet aperçu change de langue.")).toBeVisible();
  expect(screen.getByTestId("activity-time")).toHaveTextContent(
    new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium", timeStyle: "short" }).format(date),
  );
  const draft = screen.getByRole("textbox");
  await user.type(draft, "unfinished");
  act(() => {
    queryClient.setQueryData(key, { value: "en" });
  });
  expect(await screen.findByText("Only this preview changes language.")).toBeVisible();
  act(() => {
    queryClient.setQueryData(key, { value: "system" });
  });
  expect(await screen.findByText("Seul cet aperçu change de langue.")).toBeVisible();
  languages.mockReturnValue([]);
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
  act(() => {
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(await screen.findByText("Only this preview changes language.")).toBeVisible();
  expect(screen.getByTestId("activity-time")).toHaveTextContent(
    new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date),
  );
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("unfinished");
  expect(setInterfaceLanguage.mock.calls).toEqual([["fr"], ["en"], ["fr"], ["en"]]);
});
