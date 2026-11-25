import { afterEach, expect, it, vi } from "vitest";
import { useTranslation } from "react-i18next";
import { act, createTestQueryClient, render, screen } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { LanguageProvider } from "./LanguageProvider";
import { LANGUAGE_SETTING, matchSystemLanguage } from "./languages";

afterEach(() => vi.restoreAllMocks());

it.each([
  { candidates: ["de-DE", "fr-CA", "en-GB"], expected: "fr" },
  { candidates: ["fr_FR.UTF-8", "C"], expected: "fr" },
  { candidates: ["en-US", "fr-FR"], expected: "en" },
  { candidates: ["de", "C"], expected: "en" },
  { candidates: [], expected: "en" },
])("resolves $candidates in priority order", ({ candidates, expected }) => {
  expect(matchSystemLanguage(candidates)).toBe(expected);
});

function Preview() {
  const { t } = useTranslation("language");
  return (
    <>
      <p>{t("preview")}</p>
      <input aria-label="Draft" />
    </>
  );
}

it("follows the confirmed setting and returns to the browser language without remounting", async () => {
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
  languages.mockReturnValue(["en-AU"]);
  act(() => {
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(await screen.findByText("Only this preview changes language.")).toBeVisible();
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("unfinished");
});
