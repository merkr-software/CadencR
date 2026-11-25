import { afterEach, expect, it, vi } from "vitest";
import { formatClock } from "@/lib/format-clock";
import { formatExactNumber } from "@/lib/format-number";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("preserves the system's non-interface regional formats when the preview is gated", async () => {
  vi.resetModules();
  vi.stubEnv("DEV", false);
  const resolvedOptions = new Intl.NumberFormat("de-DE").resolvedOptions();
  vi.spyOn(Intl.NumberFormat.prototype, "resolvedOptions").mockReturnValue(resolvedOptions);
  const { formattingLocale } = await import("./formatting-locale");
  const locale = formattingLocale("en");

  expect(locale).toBe("de-DE");
  expect(formatExactNumber(1_234_567, locale)).toBe("1.234.567");
  expect(formatClock(new Date(2026, 10, 25, 13, 5), locale)).toBe("13:05");
});

it("keeps regional tags in the development preview", async () => {
  vi.stubEnv("DEV", true);
  const { formattingLocale } = await import("./formatting-locale");

  expect(formattingLocale("fr-CA")).toBe("fr-CA");
  expect(formattingLocale("en-GB")).toBe("en-GB");
});
