import type { BackendModule } from "i18next";

import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import { uiI18n } from "@/lib/i18n/ui";
import { API_BASE_URL, server } from "@/test/msw-server";
import { render, screen, within } from "@/test-utils";
import { LanguageSetting } from "./LanguageSetting";

afterEach(async () => {
  vi.unstubAllEnvs();
  await uiI18n.changeLanguage("en-US");
});

it("shows the confirmed preference after a cold read and waits for the write before translating", async () => {
  vi.stubEnv("DEV", false);
  const url = API_BASE_URL + "/api/workspace/settings/ui_language";
  const read = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  const requestValue = vi.fn();
  server.use(
    http.get(url, async () => {
      await read.promise;
      return HttpResponse.json({ value: "en" });
    }),
    http.put(url, async ({ request }) => {
      requestValue(await request.json());
      await write.promise;
      return HttpResponse.json({ value: "fr-FR" });
    }),
  );

  const { user } = render(
    <LanguageProvider>
      <LanguageSetting />
    </LanguageProvider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading language preference");
  expect(screen.queryByRole("combobox")).toBeNull();
  read.resolve();
  const trigger = await screen.findByRole("combobox");
  await user.click(trigger);
  const list = screen.getByRole("listbox");
  expect(list).toHaveAttribute("lang", "en-US");
  expect(within(list).getAllByRole("option")).toHaveLength(7);
  const labels = {
    us: "English (United States)",
    es: "Español (España)",
    de: "Deutsch (Deutschland)",
    jp: "日本語 (日本)",
    fr: "Français (France)",
    br: "Português (Brasil)",
  };
  for (const [flagCode, name] of Object.entries(labels)) {
    const option = within(list).getByRole("option", { name });
    const flag = option.querySelector("img");
    expect(flag).toHaveAttribute("src", expect.stringContaining(`/flags/${flagCode}.svg`));
    expect(flag).toHaveAttribute("alt", "");
    expect(flag).toHaveAttribute("aria-hidden", "true");
    expect(within(option).queryByRole("img")).toBeNull();
  }
  const french = within(list).getByRole("option", { name: "Français (France)" });
  expect(within(french).getByText("Français (France)").closest("[lang]")).toHaveAttribute(
    "lang",
    "fr-FR",
  );
  expect(
    within(list)
      .getByRole("option", { name: /System/ })
      .querySelector("img"),
  ).toBeNull();
  await user.click(french);
  await vi.waitFor(() => expect(requestValue).toHaveBeenCalledWith({ value: "fr-FR" }));
  expect(trigger).toBeDisabled();
  expect(screen.getByText("Language")).toBeVisible();
  write.resolve();
  expect(await screen.findByText("Langue")).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    expect.stringContaining("/flags/fr.svg"),
  );
  expect(within(trigger).queryByRole("img")).toBeNull();
  await user.click(trigger);
  expect(screen.getByRole("listbox")).toHaveAttribute("lang", "fr-FR");
});

it("preserves the confirmed setting on a failed catalog load and lets the user retry", async () => {
  const url = API_BASE_URL + "/api/workspace/settings/ui_language";
  const written = vi.fn();
  server.use(
    http.get(url, () => HttpResponse.json({ value: "en-US" })),
    http.put(url, async ({ request }) => {
      const setting = await request.json();
      written(setting);
      return HttpResponse.json(setting);
    }),
  );
  const { user } = render(
    <LanguageProvider>
      <LanguageSetting />
    </LanguageProvider>,
  );
  const trigger = await screen.findByRole("combobox");
  const selectGerman = async () => {
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Deutsch (Deutschland)" }));
  };
  const backend: BackendModule = uiI18n.services.backendConnector.backend;
  const failure = vi.spyOn(backend, "read").mockImplementation((_locale, _ns, callback) => {
    callback(new Error("Unavailable catalog"), undefined);
  });
  try {
    await selectGerman();
    await vi.waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveTextContent("English");
    expect(document.documentElement.lang).toBe("en-US");
    expect(written).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore();
  }
  await selectGerman();
  expect(await screen.findByText("Sprache")).toBeVisible();
  expect(written).toHaveBeenCalledWith({ value: "de-DE" });
});

it("can retry a saved preference that could not load at startup", async () => {
  const url = API_BASE_URL + "/api/workspace/settings/ui_language";
  server.use(http.get(url, () => HttpResponse.json({ value: "ja-JP" })));
  const backend: BackendModule = uiI18n.services.backendConnector.backend;
  const failure = vi.spyOn(backend, "read").mockImplementation((_locale, _ns, callback) => {
    callback(new Error("Unavailable catalog"), undefined);
  });
  try {
    const { user } = render(
      <LanguageProvider>
        <LanguageSetting />
      </LanguageProvider>,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("combobox")).toBeEnabled();
    failure.mockRestore();
    await user.click(retry);
    expect(await screen.findByText("言語")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    failure.mockRestore();
  }
});
