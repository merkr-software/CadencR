import { describe, it, expect } from "vitest";
import { settingsArrayToMap } from "./settings";

describe("settingsArrayToMap", () => {
  it("maps key/value entries, defaulting null values to empty string", () => {
    expect(
      settingsArrayToMap([{ key: "a", value: "1" }, { key: "b", value: null }, { key: "c" }]),
    ).toEqual({ a: "1", b: "", c: "" });
  });

  it("returns an empty map for undefined or a not-yet-resolved query shape", () => {
    expect(settingsArrayToMap(undefined)).toEqual({});
    // react-query data is only an array once the request settles; a non-array
    // shape must not throw during render.
    expect(settingsArrayToMap({} as never)).toEqual({});
  });
});
