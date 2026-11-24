import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { Route } from "./agents";

const mocks = vi.hoisted(() => ({ phone: false }));
vi.mock("@/lib/form-factor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/form-factor")>()),
  getPhoneShellSnapshot: () => mocks.phone,
}));

type BeforeLoad = NonNullable<typeof Route.options.beforeLoad>;
type BeforeLoadArgs = NonNullable<Parameters<BeforeLoad>[0]>;

function runBeforeLoad(): unknown {
  try {
    // It reads no argument: the layout is all it needs.
    (Route.options.beforeLoad as BeforeLoad)({} as BeforeLoadArgs);
    return null;
  } catch (thrown) {
    return thrown;
  }
}

describe("/agents before it loads", () => {
  it("sends the phone layout to the inbox before the grid's chunk loads", () => {
    mocks.phone = true;
    const thrown = runBeforeLoad();
    expect(isRedirect(thrown)).toBe(true);
    expect(isRedirect(thrown) && thrown.options.to).toBe("/");
  });

  it("lets any other layout through", () => {
    mocks.phone = false;
    expect(runBeforeLoad()).toBeNull();
  });
});
