import { afterEach, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { emptyDraft } from "@/lib/schedules/recurrence";
import { act, fireEvent, render, screen } from "@/test-utils";
import { ConditionEditor } from "./ConditionEditor";
import { RecurrenceEditor } from "./RecurrenceEditor";

afterEach(async () => {
  await act(async () => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
});

it("updates the open date picker and the preview on a regional language change", async () => {
  const now = new Date(2027, 0, 4, 9);
  const draft = emptyDraft(now);
  const onChange = vi.fn();
  const { user } = render(<RecurrenceEditor value={draft} now={now} onChange={onChange} />);

  await user.click(screen.getByRole("button", { name: "Mon, Jan 4, 2027" }));
  expect(screen.getByRole("button", { name: /next month/i })).toBeVisible();
  expect(screen.getByText(/10:00 AM/)).toBeVisible();

  uiI18n.addResourceBundle("fr", "ui", {
    schedules: { date: { hour: "Heure" }, preview: { sends: "Envoi" } },
  });
  await act(async () => uiI18n.changeLanguage("fr-CA"));

  expect(screen.getByRole("button", { name: /mois suivant/i })).toBeVisible();
  expect(screen.getByRole("button", { name: "lun. 4 janv. 2027" })).toBeVisible();
  expect(screen.getByText("Envoi:")).toBeVisible();
  expect(screen.getByText(/10 h 00/)).toBeVisible();
  expect(onChange).not.toHaveBeenCalled();
});

it("retains the focused timeout input and the original shell command when its label changes", async () => {
  const onChange = vi.fn();
  const value = { enabled: true, command: "pnpm test", timeoutSeconds: 60 };
  render(<ConditionEditor value={value} targetsExistingConversation onChange={onChange} />);

  const initial = screen.getByRole("spinbutton", { name: "Command timeout in seconds" });
  initial.focus();
  expect(initial).toHaveValue(60);
  uiI18n.addResourceBundle("fr", "ui", {
    schedules: {
      condition: {
        timeoutAria: "Délai avant expiration",
        command: "Commande à vérifier",
      },
    },
  });
  await act(async () => uiI18n.changeLanguage("fr-CA"));

  const timeout = screen.getByRole("spinbutton", { name: "Délai avant expiration" });
  expect(timeout).toHaveValue(60);
  expect(timeout).toBe(initial);
  expect(timeout).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Commande à vérifier" })).toHaveValue("pnpm test");
  fireEvent.change(timeout, { target: { value: "45" } });
  expect(onChange).toHaveBeenCalledWith({ ...value, timeoutSeconds: 45 });
});
