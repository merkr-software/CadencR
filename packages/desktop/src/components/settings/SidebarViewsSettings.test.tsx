import { afterEach, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { act, render, screen } from "@/test-utils";
import { SidebarViewsSettings } from "./SidebarViewsSettings";

const saveViews = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", () => ({ useListProjects: () => ({}) }));
vi.mock("@/hooks/useCrossProjectConversations", () => {
  const noMatches = { features: [], isPending: false };
  return { useCrossProjectConversations: () => noMatches };
});

vi.mock("@/hooks/useSidebarViews", () => {
  const state = {
    views: [{ id: "existing", name: "New view", query: "/status:waiting /project:Équipe" }],
    activeView: null,
    loaded: true,
    saveViews,
    showView: vi.fn(),
  };
  return { useSidebarViews: () => state };
});

afterEach(async () => {
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
});

it("keeps existing fields in place, uses plural zero, and seeds a new name in the active language", async () => {
  const { user } = render(<SidebarViewsSettings />);
  const name = screen.getByRole("textbox", { name: "View name" });
  const query = screen.getByRole("textbox", { name: "View query" });
  await user.click(query);
  expect(screen.getByText("0 matches")).toBeVisible();

  uiI18n.addResourceBundle("fr", "ui", {
    sidebar: {
      settings: {
        views: {
          name: "Nom de la vue",
          query: "Requête de la vue",
          add: "Ajouter une vue",
          newName: "Nouvelle vue",
          matchCount_zero: "Aucun résultat",
          matchCount_one: "{{count, number}} résultat",
        },
      },
    },
  });
  await act(() => uiI18n.changeLanguage("fr-CA"));

  expect(screen.getByRole("textbox", { name: "Nom de la vue" })).toBe(name);
  expect(name).toHaveValue("New view");
  expect(screen.getByRole("textbox", { name: "Requête de la vue" })).toBe(query);
  expect(query).toHaveValue("/status:waiting /project:Équipe");
  expect(query).toHaveFocus();
  expect(screen.getByText("Aucun résultat")).toBeVisible();
  expect(saveViews).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Ajouter une vue" }));
  expect(saveViews).toHaveBeenCalledWith([
    { id: "existing", name: "New view", query: "/status:waiting /project:Équipe" },
    { id: expect.any(String), name: "Nouvelle vue", query: "" },
  ]);
});
