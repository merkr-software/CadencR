import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderCatalogResponseEntry } from "@/api/generated";
import { setProviderCatalogMetadata } from "./provider-catalog-registry";
import { getProviderMetadata } from "./providers";

describe("getProviderMetadata", () => {
  beforeEach(() => setProviderCatalogMetadata([]));

  it("prefers connector-owned catalog metadata without a static provider mapping", () => {
    setProviderCatalogMetadata([
      {
        id: "acme-agent",
        label: "Acme Agent",
        icon_data: "data:image/svg+xml;base64,PHN2Zy8+",
        origin: "installed_local",
        status: "available",
        models: [],
      } satisfies ProviderCatalogResponseEntry,
    ]);

    const metadata = getProviderMetadata("acme-agent", null, "mono");

    expect(metadata).toMatchObject({
      label: "Acme Agent",
      iconSrc: "data:image/svg+xml;base64,PHN2Zy8+",
      isMonochrome: false,
    });
  });
});
