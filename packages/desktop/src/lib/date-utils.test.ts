import { afterEach, describe, it, expect, vi } from "vitest";
import { dateLocale } from "@/lib/i18n/date-locale";
import { uiI18n } from "@/lib/i18n/ui";
import { formatCompactAge, formatRelativeDistance, parseUTCDateTime } from "./date-utils";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["en-US", "2 days ago"],
  ["es-ES", "hace 2 días"],
  ["de-DE", "vor 2 Tagen"],
  ["ja-JP", "2日前"],
  ["fr-FR", "il y a 2 jours"],
  ["pt-BR", "há 2 dias"],
  ["fr-CA", "il y a 2 jours"],
  ["pt-PT", "há 2 dias"],
  ["es-MX", "hace 2 días"],
])("formats relative dates for %s", (language, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 25, 12));
  expect(formatRelativeDistance(new Date(Date.UTC(2026, 10, 23, 12)), language)).toBe(expected);
});

it.each([
  ["en-CA", "en-CA"],
  ["en-GB", "en-GB"],
  ["fr-CA", "fr-CA"],
  ["pt-PT", "pt"],
  ["es-MX", "es"],
])("resolves the date locale for %s to %s", (language, expected) => {
  expect(dateLocale(language).code).toBe(expected);
});

describe("parseUTCDateTime", () => {
  it("parses SQLite datetime string as UTC", () => {
    const date = parseUTCDateTime("2026-03-04 23:25:33");
    expect(date.toISOString()).toBe("2026-03-04T23:25:33.000Z");
  });

  it("passes through strings that already have a Z suffix", () => {
    const date = parseUTCDateTime("2026-03-04T23:25:33.000Z");
    expect(date.toISOString()).toBe("2026-03-04T23:25:33.000Z");
  });

  it("passes through strings with timezone offset", () => {
    const date = parseUTCDateTime("2026-03-04T23:25:33+05:00");
    expect(date.toISOString()).toBe("2026-03-04T18:25:33.000Z");
  });

  it.each(["2026-03-04 23:25:33z", "2026-03-05 00:25:33+0100"])(
    "normalizes the SQLite separator in a timestamp with a zone: %s",
    (value) => {
      expect(parseUTCDateTime(value).toISOString()).toBe("2026-03-04T23:25:33.000Z");
    },
  );
});

it.each([
  { seconds: -10, connection: "just now", remote: "just now" },
  { seconds: 4, connection: "just now", remote: "just now" },
  { seconds: 5, connection: "5s ago", remote: "just now" },
  { seconds: 59, connection: "59s ago", remote: "just now" },
  { seconds: 60, connection: "1 min ago", remote: "1 min ago" },
  { seconds: 3599, connection: "59 min ago", remote: "59 min ago" },
  { seconds: 3600, connection: "1h ago", remote: "1h ago" },
  { seconds: 86399, connection: "23h ago", remote: "23h ago" },
  { seconds: 86400, connection: "24h ago", remote: "1d ago" },
])("keeps each surface's age format at $seconds seconds", ({ seconds, connection, remote }) => {
  const now = Date.UTC(2026, 2, 4);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const t = uiI18n.getFixedT("en", "ui");
  const timestamp = now - seconds * 1000;
  expect(formatCompactAge(timestamp, t, "en", { showSeconds: true })).toBe(connection);
  expect(formatCompactAge(timestamp, t, "en", { showDays: true })).toBe(remote);
});
