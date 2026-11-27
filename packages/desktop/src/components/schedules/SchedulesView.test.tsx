import { afterEach, expect, it, vi } from "vitest";
import type { Schedule } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
import { act, render, screen } from "@/test-utils";
import { SchedulesView } from "./SchedulesView";

const { runNow } = vi.hoisted(() => ({ runNow: vi.fn() }));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListProjects: () => ({ data: [] }),
}));
vi.mock("@/hooks/useSchedules", () => ({
  fireAndForget: vi.fn(),
  useSchedules: () => ({ schedules, runNow }),
}));
vi.mock("./ScheduleEditorDialog", () => ({ ScheduleEditorDialog: () => null }));
vi.mock("./useActionPresetLink", () => ({ useActionPresetLink: vi.fn() }));

const schedule: Schedule = {
  id: 13,
  name: "Nightly recap",
  prompt: "Review recent changes",
  created_at: "2026-07-27T09:00:00Z",
  updated_at: "2026-07-27T09:00:00Z",
  completed: false,
  enabled: false,
  recurrence: { kind: "weekly", weekdays: [1, 2, 3, 4, 5], time_of_day: "09:00", timezone: "UTC" },
  target: { kind: "new_conversation" },
  context: {},
  condition: { command: "printf '<b>ready</b>'", timeout_seconds: null },
  run_count: 0,
};

const schedules = [schedule];

afterEach(async () => {
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
});

it("keeps the mounted search and filter while translating the schedule list and row actions", async () => {
  uiI18n.addResourceBundle("fr", "ui", {
    schedules: { page: { title: "Planifications" } },
    schedule: {
      list: {
        schedulesView: {
          noneUpcoming_one: "{{count, number}} planification · aucune à venir",
          searchSchedules: "Rechercher des planifications",
        },
        scheduleGroups: { other: "Autres" },
        scheduleRow: {
          runScheduleNow: "Exécuter {{name}} maintenant",
          ifCommandFails: "<command>{{command}}</command> échoue",
        },
        status: { paused: "En pause" },
      },
    },
  });
  const { user } = render(<SchedulesView />);
  expect(screen.getByRole("heading", { name: "Schedules" })).toBeVisible();
  expect(screen.getByText("1 schedule · none upcoming")).toBeVisible();
  const search = screen.getByRole("textbox", { name: "Search schedules" });
  const paused = screen.getByRole("button", { name: "Paused 1" });
  const run = screen.getByRole("button", { name: "Run Nightly recap now" });
  await user.type(search, "Nightly");
  await user.click(paused);

  await act(() => uiI18n.changeLanguage("fr"));

  expect(screen.getByRole("heading", { name: "Planifications" })).toBeVisible();
  expect(screen.getByText("1 planification · aucune à venir")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Rechercher des planifications" })).toBe(search);
  expect(search).toHaveValue("Nightly");
  expect(screen.getByRole("button", { name: "En pause 1" })).toBe(paused);
  expect(paused).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("heading", { name: "Autres 1" })).toBeVisible();
  expect(screen.getByText("Nightly recap")).toBeVisible();
  expect(screen.getByText("Review recent changes")).toBeVisible();
  expect(screen.getByText("printf '<b>ready</b>'")).toBeVisible();
  expect(screen.getByRole("button", { name: "Exécuter Nightly recap maintenant" })).toBe(run);
  await user.click(run);
  expect(runNow).toHaveBeenCalledWith(schedule);
});

it("refreshes search results from the translated recurrence on language change", async () => {
  uiI18n.addResourceBundle("fr", "ui", {
    schedules: { recurrence: { weekdaysAt: "En semaine à {{time}}" } },
  });
  const { user } = render(<SchedulesView />);
  const search = screen.getByRole("textbox", { name: "Search schedules" });
  await user.type(search, "weekdays");
  expect(screen.getByText("Nightly recap")).toBeVisible();

  await user.clear(search);
  await user.type(search, "en semaine");
  expect(screen.getByText("No schedules match")).toBeVisible();

  await act(() => uiI18n.changeLanguage("fr"));
  expect(search).toHaveValue("en semaine");
  expect(screen.getByText("Nightly recap")).toBeVisible();
});
