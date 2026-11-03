// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageServerSettings } from "./LanguageServerSettings";

const mocks = vi.hoisted(() => ({
  global: {
    data: [] as { key: string; value: string }[],
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
  project: {
    data: [] as { key: string; value: string }[],
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
  saveProject: vi.fn(),
  saveGlobal: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/api/generated", () => ({
  useGetProjectSettings: () => mocks.project,
  setProjectSetting: mocks.saveProject,
  setWorkspaceSetting: mocks.saveGlobal,
  getGetProjectSettingsQueryKey: (id: number) => ["project", id],
}));
vi.mock("@/api/settings", () => ({
  useGetWorkspaceSettings: () => mocks.global,
  getWorkspaceSettingsQueryKey: () => ["global"],
  settingsArrayToMap: (data: { key: string; value: string }[] = []) =>
    Object.fromEntries(data.map(({ key, value }) => [key, value])),
}));
vi.mock("@/hooks/useLspMarketplace", () => ({
  useLspMarketplace: () => ({
    catalog: { isPending: false },
    inventory: { isPending: false, data: { servers: [{ language_ids: ["custom"] }] } },
  }),
}));
vi.mock("@/lib/lsp/useLspResolution", () => ({
  useLspResolution: () => ({
    data: {
      primary: "checker",
      candidates: [{ lsp_id: "checker", name: "Checker", role: "general" }],
      linters: ["missing"],
    },
    isPending: false,
  }),
}));
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

function mount(projectId?: number) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <LanguageServerSettings projectId={projectId} />
    </QueryClientProvider>,
  );
}
function selectPrimary() {
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "checker" } });
}

describe("language server settings writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.global.data = [];
    mocks.project.data = [];
    mocks.global.isPending = mocks.project.isPending = false;
    mocks.global.isError = mocks.project.isError = false;
    mocks.global.error = mocks.project.error = null;
  });
  afterEach(cleanup);

  it("writes project scope and preserves every other language", async () => {
    mocks.project.data = [
      {
        key: "editor_lsp_languages",
        value: JSON.stringify({ other: { primary: null, linters: ["existing"] } }),
      },
    ];
    mount(7);
    selectPrimary();
    await waitFor(() => expect(mocks.saveProject).toHaveBeenCalledOnce());
    expect(mocks.saveGlobal).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.saveProject.mock.calls[0][1].value)).toEqual({
      other: { primary: null, linters: ["existing"] },
      custom: { primary: "checker" },
    });
  });

  it("writes the workspace default only from global settings", async () => {
    mount();
    selectPrimary();
    await waitFor(() => expect(mocks.saveGlobal).toHaveBeenCalledOnce());
    expect(mocks.saveProject).not.toHaveBeenCalled();
  });

  it.each(["parse", "fetch"])("prevents replacement after a %s error", (kind) => {
    mocks.project.data = [
      { key: "editor_lsp_languages", value: kind === "parse" ? "{broken" : "{}" },
    ];
    if (kind === "fetch") {
      mocks.project.isError = true;
      mocks.project.error = new Error("Settings offline");
    }
    mount(7);
    expect(screen.getAllByRole("combobox")[1]).toBeDisabled();
    expect(screen.getByRole("alert")).toBeVisible();
    expect(mocks.saveProject).not.toHaveBeenCalled();
  });

  it("restores ignored suggestions for this project", async () => {
    mocks.project.data = [{ key: "editor_lsp_ignored_languages", value: '["custom","other"]' }];
    mount(7);
    fireEvent.click(screen.getByRole("button", { name: "Show language suggestions again" }));
    await waitFor(() =>
      expect(mocks.saveProject).toHaveBeenCalledWith(7, {
        key: "editor_lsp_ignored_languages",
        value: "[]",
      }),
    );
    expect(mocks.saveGlobal).not.toHaveBeenCalled();
  });

  it("can remove inherited linters that are no longer installed", async () => {
    mount(7);
    fireEvent.click(screen.getByLabelText("missing (saved, not installed)"));
    await waitFor(() => expect(mocks.saveProject).toHaveBeenCalledOnce());
    expect(JSON.parse(mocks.saveProject.mock.calls[0][1].value)).toEqual({
      custom: { linters: [] },
    });
  });
});
