import { describe, expect, it } from "vitest";
import type { RuntimeSessionConfigOption } from "@/api/generated";
import { isHostRenderedConfigOption } from "./host-rendered-config-options";

function select(
  overrides: Partial<RuntimeSessionConfigOption>,
  values: { value: string; _meta?: unknown }[],
): RuntimeSessionConfigOption {
  return {
    id: "option",
    name: "Option",
    type: "select",
    current_value: values[0]?.value ?? "",
    choices: {
      layout: "ungrouped",
      options: values.map((value) => ({ name: value.value, ...value })),
    },
    ...overrides,
  } as RuntimeSessionConfigOption;
}

describe("isHostRenderedConfigOption", () => {
  it("hides a mode selector whose values map to host permission modes", () => {
    const option = select({ id: "mode", category: "mode" }, [
      { value: "agent", _meta: { cadencr: { permissionMode: "default" } } },
      { value: "plan", _meta: { cadencr: { permissionMode: "plan" } } },
    ]);
    expect(isHostRenderedConfigOption(option)).toBe(true);
  });

  it("keeps an unmapped mode selector in the generic popover", () => {
    const option = select({ id: "mode", category: "mode" }, [{ value: "agent" }]);
    expect(isHostRenderedConfigOption(option)).toBe(false);
  });

  it("hides the option carrying the access-mode role", () => {
    const option = select({ id: "access", _meta: { cadencr: { role: "access_mode" } } }, [
      { value: "default" },
    ]);
    expect(isHostRenderedConfigOption(option)).toBe(true);
  });

  it("keeps unrelated options and tolerates malformed meta", () => {
    expect(isHostRenderedConfigOption(select({ id: "x", _meta: "nope" }, [{ value: "a" }]))).toBe(
      false,
    );
  });
});
