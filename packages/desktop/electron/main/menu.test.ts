import { describe, expect, it, vi } from "vitest";

const setApplicationMenu = vi.fn();
const buildFromTemplate = vi.fn((template: unknown) => template);
const getFocusedWebContents = vi.fn();
const fromId = vi.fn();

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    name: "Cadencr",
  },
  BrowserWindow: {
    fromId,
  },
  Menu: {
    buildFromTemplate,
    setApplicationMenu,
  },
  webContents: {
    getFocusedWebContents,
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

  it("retains the native macOS Hide role alongside the Git-scoped Mod+H renderer binding", async () => {
    const { installApplicationMenu } = await import("./menu");

    installApplicationMenu(vi.fn());

    if (process.platform === "darwin") {
      expect(JSON.stringify(buildFromTemplate.mock.calls.at(-1)?.[0])).toContain('"role":"hide"');
    }
  });

  it("does not install non-mac edit role accelerators that steal terminal Ctrl keys", async () => {
    const editMenu = await editMenuFor("linux");

    expect(editMenu).not.toContain('"role":"copy"');
    expect(editMenu).not.toContain('"role":"paste"');
    expect(editMenu).not.toContain("accelerator");
    expect(editMenu).toContain('"label":"Paste"');
  });

  it("runs non-mac edit commands on the focused webContents, such as an embedded browser page", async () => {
    const guest = { paste: vi.fn() };
    const host = { paste: vi.fn() };
    getFocusedWebContents.mockReturnValue(guest);
    fromId.mockReturnValue({ webContents: host });

    clickEditItem(await editMenuTemplateFor("linux"), "Paste", { id: 1 });

    expect(guest.paste).toHaveBeenCalledOnce();
    expect(host.paste).not.toHaveBeenCalled();
  });

  it("falls back to the focused window's webContents when no webContents has focus", async () => {
    const host = { copy: vi.fn() };
    getFocusedWebContents.mockReturnValue(null);
    fromId.mockReturnValue({ webContents: host });

    clickEditItem(await editMenuTemplateFor("linux"), "Copy", { id: 1 });

    expect(fromId).toHaveBeenCalledWith(1);
    expect(host.copy).toHaveBeenCalledOnce();
  });

  it("offers the macOS-only window zoom role only on macOS", async () => {
    expect(await menuFor("darwin", "Window")).toContain('"role":"zoom"');
    expect(await menuFor("linux", "Window")).not.toContain('"role":"zoom"');
    expect(await menuFor("linux", "Window")).toContain('"role":"togglefullscreen"');
  });

  it("keeps native edit roles on macOS", async () => {
    const editMenu = await editMenuFor("darwin");

    expect(editMenu).toContain('"role":"copy"');
    expect(editMenu).toContain('"role":"paste"');
  });
});

async function editMenuFor(platform: NodeJS.Platform): Promise<string> {
  return menuFor(platform, "Edit");
}

interface MenuEntry {
  label?: string;
  submenu?: MenuEntry[];
  click?: (item: unknown, window: unknown) => void;
}

async function editMenuTemplateFor(platform: NodeJS.Platform): Promise<MenuEntry> {
  await menuFor(platform, "Edit");
  const template = buildFromTemplate.mock.calls.at(-1)?.[0] as MenuEntry[];
  const editMenu = template.find((item) => item.label === "Edit");
  if (!editMenu) throw new Error("no Edit menu");
  return editMenu;
}

function clickEditItem(editMenu: MenuEntry, label: string, window: { id: number }): void {
  const item = editMenu.submenu?.find((entry) => entry.label === label);
  if (!item?.click) throw new Error(`no clickable ${label} item`);
  item.click({}, window);
}

async function menuFor(platform: NodeJS.Platform, label: string): Promise<string> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const { installApplicationMenu } = await import("./menu");
    installApplicationMenu(vi.fn());
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
  const template = buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string }>;
  return JSON.stringify(template.find((item) => item.label === label));
}
