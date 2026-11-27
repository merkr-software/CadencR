import { http, HttpResponse } from "msw";
import { dehydrate } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { afterEach, expect, it, vi } from "vitest";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { LanguageProvider, useLanguageSettingState } from "@/lib/i18n/LanguageProvider";
import { uiI18n } from "@/lib/i18n/ui";
import { API_BASE_URL, server } from "@/test/msw-server";
import { createTestQueryClient, render, screen, waitFor } from "@/test-utils";
import { LanguageUpgradeSuggestion } from "./LanguageUpgradeSuggestion";

const url = API_BASE_URL + "/api/workspace/settings/ui_language";

function Ready() {
  const { loading, applying } = useLanguageSettingState();
  return !loading && !applying ? <p>Preferences ready</p> : null;
}

function mount(queryClient = createTestQueryClient()) {
  return render(
    <LanguageProvider>
      <input aria-label="Draft" />
      <Ready />
      <LanguageUpgradeSuggestion />
    </LanguageProvider>,
    { queryClient },
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await uiI18n.changeLanguage("en-US");
});

it("revalidates a cached invitation before showing it", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  const previous = createTestQueryClient();
  previous.setQueryData(getGetWorkspaceSettingQueryKey("ui_language"), { value: "legacy-english" });
  const persisted = { buster: "", timestamp: Date.now(), clientState: dehydrate(previous) };
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity } });
  const pending = Promise.withResolvers<void>();
  const started = vi.fn();
  server.use(
    http.get(url, async () => {
      started();
      await pending.promise;
      return HttpResponse.json({ value: "de-DE" });
    }),
  );
  render(
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister: {
          restoreClient: async () => persisted,
          persistClient: vi.fn(),
          removeClient: vi.fn(),
        },
      }}
    >
      <LanguageProvider>
        <LanguageUpgradeSuggestion />
      </LanguageProvider>
    </PersistQueryClientProvider>,
  );
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
  pending.resolve();
  await waitFor(() => expect(document.documentElement.lang).toBe("de-DE"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each([
  { action: "Français", expected: "fr-FR" },
  { action: "Keep English", expected: "en-US" },
  { action: "Escape", expected: "en-US" },
])(
  "keeps the workspace in English until $action is confirmed, and remembers it",
  async ({ action, expected }) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-CA"]);
    let stored = "legacy-english";
    const firstRead = Promise.withResolvers<void>();
    const pendingWrite = Promise.withResolvers<void>();
    server.use(
      http.get(url, async () => {
        await firstRead.promise;
        return HttpResponse.json({ value: stored });
      }),
      http.put(url, async ({ request }) => {
        const payload = await request.json();
        expect(payload).toEqual({ value: expected, expected_value: "legacy-english" });
        await pendingWrite.promise;
        stored = expected;
        return HttpResponse.json({ value: stored });
      }),
    );
    const view = mount();
    const draft = screen.getByRole("textbox");
    await view.user.type(draft, "unfinished");
    expect(uiI18n.language).toBe("en-US");
    expect(screen.queryByRole("dialog")).toBeNull();
    firstRead.resolve();
    expect(await screen.findByRole("dialog", { name: "Switch to French?" })).toBeVisible();
    if (action === "Escape") await view.user.keyboard("{Escape}");
    else await view.user.click(screen.getByRole("button", { name: action }));
    expect(screen.getByRole("button", { name: "Keep English" })).toBeDisabled();
    expect(stored).toBe("legacy-english");
    pendingWrite.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.documentElement.lang).toBe(expected));
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("unfinished");
    view.unmount();
    mount();
    await screen.findByText("Preferences ready");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored).toBe(expected);
  },
);

it.each([
  ["legacy-english", "en-GB", "en-US"],
  ["legacy-english", "nl-NL", "en-US"],
  ["en", "fr-CA", "en-US"],
  ["system", "fr-CA", "fr-FR"],
  ["de-DE", "fr-CA", "de-DE"],
])("skips the prompt for %s on %s", async (value, system, expected) => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue([system]);
  server.use(http.get(url, () => HttpResponse.json({ value })));
  await uiI18n.changeLanguage("ja-JP");
  mount();
  await screen.findByText("Preferences ready");
  await waitFor(() => expect(document.documentElement.lang).toBe(expected));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the choice available if saving fails", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  server.use(
    http.get(url, () => HttpResponse.json({ value: "legacy-english" })),
    http.put(url, () => HttpResponse.json({ error: "Unable to write" }, { status: 500 })),
  );
  const { user } = mount();
  const accept = await screen.findByRole("button", { name: "Français" });
  await user.click(accept);
  await waitFor(() => expect(accept).toBeEnabled());
  expect(document.documentElement.lang).toBe("en-US");
  server.use(http.put(url, () => HttpResponse.json({ value: "fr-FR" })));
  await user.click(accept);
  await waitFor(() => expect(document.documentElement.lang).toBe("fr-FR"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("applies a newer choice from another client when the invitation loses the race", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  server.use(
    http.get(url, () => HttpResponse.json({ value: "legacy-english" })),
    http.put(url, () => HttpResponse.json({ value: "de-DE" })),
  );
  const { user } = mount();
  await user.click(await screen.findByRole("button", { name: "Français" }));
  await waitFor(() => expect(document.documentElement.lang).toBe("de-DE"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
