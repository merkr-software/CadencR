import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import { API_BASE_URL, server } from "@/test/msw-server";
import { render, screen, within } from "@/test-utils";
import { LanguageSetting } from "./LanguageSetting";

it("shows the confirmed preference after a cold read and waits for the write before translating", async () => {
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
      return HttpResponse.json({ value: "fr" });
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
  expect(list).toHaveAttribute("lang", "en");
  const french = within(list).getByRole("option", { name: "Français" });
  expect(within(french).getByText("Français")).toHaveAttribute("lang", "fr");
  await user.click(french);
  await vi.waitFor(() => expect(requestValue).toHaveBeenCalledWith({ value: "fr" }));
  expect(trigger).toBeDisabled();
  expect(screen.getByText("Only this preview changes language.")).toBeVisible();
  write.resolve();
  const phrase = await screen.findByText("Seul cet aperçu change de langue.");
  expect(phrase.closest("[lang]")).toHaveAttribute("lang", "fr");
  expect(document.documentElement.lang).not.toBe("fr");
  await user.click(trigger);
  expect(screen.getByRole("listbox")).toHaveAttribute("lang", "fr");
});
