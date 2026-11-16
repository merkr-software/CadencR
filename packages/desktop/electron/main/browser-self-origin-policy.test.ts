import { afterEach, expect, it, vi } from "vitest";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import * as runtime from "./runtime-config";

afterEach(() => vi.restoreAllMocks());

it("updates cached rules immediately when a listener or tunnel changes", () => {
  const origins = vi
    .spyOn(runtime, "getBrowserDeniedOrigins")
    .mockReturnValue(["http://127.0.0.1:5106", "https://old.example.test"]);
  expect(isCadencrBrowserUrl("http://localhost:5106/")).toBe(true);
  expect(isCadencrBrowserUrl("https://old.example.test/")).toBe(true);
  origins.mockReturnValue(["http://127.0.0.1:5107", "https://new.example.test"]);
  expect(isCadencrBrowserUrl("http://localhost:5106/")).toBe(false);
  expect(isCadencrBrowserUrl("https://old.example.test/")).toBe(false);
  expect(isCadencrBrowserUrl("http://192.168.1.2:5107/")).toBe(true);
  expect(isCadencrBrowserUrl("https://new.example.test/")).toBe(true);
});

it("still denies requests when a protected origin cannot be parsed", () => {
  vi.spyOn(runtime, "getBrowserDeniedOrigins").mockReturnValue(["invalid protected origin"]);
  expect(isCadencrBrowserUrl("http://localhost:3000/")).toBe(true);
});
