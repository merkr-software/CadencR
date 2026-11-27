import { afterEach, expect, it, vi } from "vitest";
import { formatClock } from "@/lib/format-clock";
import { formatExactNumber } from "@/lib/format-number";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("uses the first regional OS format before the interface language is set", async () => {
  vi.resetModules();
  const resolvedOptions = new Intl.NumberFormat("de-DE").resolvedOptions();
  vi.spyOn(Intl.NumberFormat.prototype, "resolvedOptions").mockReturnValue(resolvedOptions);
  const { formattingLocale } = await import("./formatting-locale");
  const locale = formattingLocale("");

  expect(locale).toBe("de-DE");
  expect(formatExactNumber(1_234_567, locale)).toBe("1.234.567");
  expect(formatClock(new Date(2026, 10, 25, 13, 5), locale)).toBe("13:05");
});

it("uses the active regional formats in production", async () => {
  vi.stubEnv("DEV", false);
  const { formattingLocale } = await import("./formatting-locale");

  expect(formattingLocale("fr-CA")).toBe("fr-CA");
  expect(formattingLocale("en-GB")).toBe("en-GB");
  expect(formattingLocale("pt-BR")).toBe("pt-BR");
});
