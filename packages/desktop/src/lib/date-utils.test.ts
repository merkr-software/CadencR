import { afterEach, describe, it, expect, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { formatCompactAge, parseUTCDateTime } from "./date-utils";

afterEach(() => vi.restoreAllMocks());

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
