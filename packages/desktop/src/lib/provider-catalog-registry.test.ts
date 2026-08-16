import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogResponseEntry } from "@/api/generated";
import {
  getCatalogProviderMetadata,
  setProviderCatalogMetadata,
  subscribeProviderCatalog,
} from "./provider-catalog-registry";

function provider(id: string, label: string, iconData?: string): ProviderCatalogResponseEntry {
  return {
    id,
    label,
    icon_data: iconData,
    origin: "installed_local",
    status: "available",
    models: [],
  };
}

describe("provider catalog metadata registry", () => {
  beforeEach(() => setProviderCatalogMetadata([]));

  it("publishes generic provider labels and icon data", () => {
    setProviderCatalogMetadata([provider("acme", "Acme Agent", "data:image/svg+xml;base64,AA==")]);

    expect(getCatalogProviderMetadata("acme")).toEqual({
      label: "Acme Agent",
      iconData: "data:image/svg+xml;base64,AA==",
    });
  });

  it("does not notify hot-path icon subscribers for model-only catalog changes", () => {
    const listener = vi.fn();
    setProviderCatalogMetadata([provider("acme", "Acme Agent")]);
    const snapshot = getCatalogProviderMetadata("acme");
    const unsubscribe = subscribeProviderCatalog("acme", listener);

    setProviderCatalogMetadata([
      { ...provider("acme", "Acme Agent"), models: [{ id: "next", label: "Next" }] },
    ]);

    expect(getCatalogProviderMetadata("acme")).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies only the provider whose identity changed", () => {
    setProviderCatalogMetadata([provider("acme", "Acme Agent"), provider("other", "Other")]);
    const acmeListener = vi.fn();
    const otherListener = vi.fn();
    const unsubscribeAcme = subscribeProviderCatalog("acme", acmeListener);
    const unsubscribeOther = subscribeProviderCatalog("other", otherListener);

    setProviderCatalogMetadata([
      provider("acme", "Acme Agent", "data:image/svg+xml;base64,AA=="),
      provider("other", "Other"),
    ]);

    expect(acmeListener).toHaveBeenCalledOnce();
    expect(otherListener).not.toHaveBeenCalled();
    unsubscribeAcme();
    unsubscribeOther();
  });
});
