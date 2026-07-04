import { describe, expect, it, vi } from "vitest";

const setApplicationMenu = vi.fn();
const buildFromTemplate = vi.fn((template: unknown) => template);

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    name: "Cadencr",
  },
  BrowserWindow: {
    fromId: vi.fn(),
  },
  Menu: {
    buildFromTemplate,
    setApplicationMenu,
  },
}));

describe("installApplicationMenu", () => {
  it("does not install Electron zoom role accelerators that bypass persisted app zoom", async () => {
    const { installApplicationMenu } = await import("./menu");

    installApplicationMenu(vi.fn());

    expect(JSON.stringify(buildFromTemplate.mock.calls[0]?.[0])).not.toContain("resetZoom");
    expect(JSON.stringify(buildFromTemplate.mock.calls[0]?.[0])).not.toContain("zoomIn");
    expect(JSON.stringify(buildFromTemplate.mock.calls[0]?.[0])).not.toContain("zoomOut");
    expect(setApplicationMenu).toHaveBeenCalledOnce();
  });

  it("does not install non-mac edit role accelerators that steal terminal Ctrl keys", async () => {
    const { installApplicationMenu } = await import("./menu");

    installApplicationMenu(vi.fn());

    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<{
      label?: string;
      submenu?: unknown[];
    }>;
    const editMenu = template.find((item) => item.label === "Edit");

    expect(JSON.stringify(editMenu)).not.toContain('"role":"copy"');
    expect(JSON.stringify(editMenu)).not.toContain('"role":"paste"');
    expect(JSON.stringify(editMenu)).not.toContain("accelerator");
  });
});
