// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { useTabHostRegistry } from "./tab-host-registry";

function reset(): void {
  useTabHostRegistry.setState({ hosts: {} });
}

describe("tab-host-registry", () => {
  beforeEach(reset);

  it("ignores stale unregisters after a newer host claimed the same key", () => {
    const oldHost = document.createElement("div");
    const nextHost = document.createElement("div");
    const store = useTabHostRegistry.getState();

    store.registerHost("root", oldHost);
    store.registerHost("root", nextHost);
    store.unregisterHost("root", oldHost);

    expect(useTabHostRegistry.getState().hosts.root).toBe(nextHost);
  });

  it("unregisters when the caller still owns the current host", () => {
    const host = document.createElement("div");
    const store = useTabHostRegistry.getState();

    store.registerHost("root", host);
    store.unregisterHost("root", host);

    expect(useTabHostRegistry.getState().hosts.root).toBeUndefined();
  });
});
