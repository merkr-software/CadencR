import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { DateTimePicker } from "./DateTimePicker";

afterEach(async () => {
  await uiI18n.changeLanguage("en-US");
});

it.each([
  { locale: "en-US", next: "Go to the Next Month", selected: /, selected$/ },
  { locale: "es-MX", next: "Ir al mes siguiente", selected: /seleccionado$/ },
  { locale: "de-DE", next: "Zum nächsten Monat", selected: /ausgewählt$/ },
  { locale: "ja-JP", next: "次の月へ", selected: /選択済み$/ },
  { locale: "fr-CA", next: "Aller au mois suivant", selected: /sélectionné$/ },
  { locale: "pt-BR", next: "Ir para o próximo mês", selected: /selecionado$/ },
])("formats and announces the calendar for $locale", async ({ locale, next, selected }) => {
  await uiI18n.changeLanguage(locale);
  const value = new Date(2026, 10, 25, 13, 30);
  const { user } = render(<DateTimePicker value={value} onChange={vi.fn()} />);
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
  await user.click(screen.getByRole("button", { name: date }));
  expect(screen.getByRole("button", { name: next })).toBeVisible();
  expect(screen.getByRole("button", { name: selected })).toBeVisible();
});
