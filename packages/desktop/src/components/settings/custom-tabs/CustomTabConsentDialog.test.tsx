import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@/test-utils";
import type { PluginTabBackendBinary } from "@/api/generated";
import { pendingUpdateFixture, tabFixture } from "./custom-tabs-fixtures";
import { CustomTabConsentDialog } from "./CustomTabConsentDialog";
import type { ConsentRequest } from "./useCustomTabEnablement";

const COMMANDS = tabFixture({
  name: "Reviewers",
  access_level: "commands",
  commands: [{ program: "git", reasoning: "Reads who changed these files." }],
});

const BACKEND = tabFixture({
  name: "Port monitor",
  access_level: "backend",
  backend: {
    protocol: 1,
    binary: { "darwin-aarch64": "bin/darwin-aarch64/ports" },
    reasoning: "Lists the processes listening on local ports.",
  },
});

function request(tab: ConsentRequest["tab"]): ConsentRequest {
  return { tab, enable: { projectId: null }, stale: false, update: null };
}

function renderDialog(tab: ConsentRequest["tab"]) {
  const onAccept = vi.fn();
  render(
    <CustomTabConsentDialog
      request={request(tab)}
      accepting={false}
      onAccept={onAccept}
      onCancel={vi.fn()}
    />,
  );
  return { onAccept, dialog: screen.getByRole("dialog") };
}

describe("CustomTabConsentDialog levels", () => {
  it("says a read-only tab only reads, with no acknowledgment", async () => {
    const { onAccept, dialog } = renderDialog(tabFixture());
    expect(within(dialog).getByText("Read-only")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByText(/Runs commands on your computer/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Allow and turn on" }));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("lists the programs a tab runs and needs the same trust as native code", async () => {
    const { onAccept, dialog } = renderDialog(COMMANDS);
    expect(within(dialog).getAllByText("Runs commands").length).toBeGreaterThan(0);
    const commands = within(dialog).getByRole("list", { name: "Commands" });
    expect(within(commands).getByText("git")).toBeInTheDocument();
    expect(within(commands).getByText("Reads who changed these files.")).toBeInTheDocument();
    expect(within(dialog).getByText(/without a shell, in this conversation/)).toBeInTheDocument();
    // The tab picks the arguments, and most programs run any code from them.
    expect(within(dialog).getByText(/which can make them run any code/)).toBeInTheDocument();
    const allow = within(dialog).getByRole("button", { name: "Allow and turn on" });
    expect(allow).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    await userEvent.click(allow);
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("needs an explicit acknowledgment before allowing native code", async () => {
    const { onAccept, dialog } = renderDialog(BACKEND);
    expect(within(dialog).getByText("Native code")).toBeInTheDocument();
    expect(
      within(dialog).getByText("bin/darwin-aarch64/ports (darwin-aarch64)"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Cadencr does not sandbox it/)).toBeInTheDocument();
    const allow = within(dialog).getByRole("button", { name: "Allow and turn on" });
    expect(allow).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    expect(allow).toBeEnabled();
    await userEvent.click(allow);
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(true);
  });
});

const BINARY: PluginTabBackendBinary = {
  platform: "darwin-aarch64",
  protocol: 1,
  executable_sha256: "a1".repeat(32),
};

function renderUpdate(tab: ConsentRequest["tab"], update: ConsentRequest["update"]) {
  render(
    <CustomTabConsentDialog
      request={{ tab, enable: null, stale: false, update }}
      accepting={false}
      onAccept={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  return screen.getByRole("dialog");
}

describe("CustomTabConsentDialog reviewing an update", () => {
  it("shows a binary-only update's new program, digests old → new", () => {
    const installed = { ...BACKEND, managed: true, backend_binary: BINARY };
    const dialog = renderUpdate(
      installed,
      pendingUpdateFixture({
        permissions: installed.permissions,
        backend_binary: { ...BINARY, protocol: 2, executable_sha256: "b2".repeat(32) },
      }),
    );
    const changes = within(dialog).getByRole("region", { name: "What changes" });
    expect(within(changes).getByText("The native program changes")).toBeInTheDocument();
    expect(within(changes).getByText("a1a1a1a1a1a1")).toBeInTheDocument();
    expect(within(changes).getByText("b2b2b2b2b2b2")).toBeInTheDocument();
    expect(within(changes).getByText("Protocol 1 → 2")).toBeInTheDocument();
    expect(within(changes).getByText("It asks for nothing new since 0.1.0.")).toBeInTheDocument();
    expect(within(dialog).queryByText("New")).toBeNull();
  });

  it("marks the permissions, sites, commands and program the update adds", () => {
    const dialog = renderUpdate(
      tabFixture({ network: { allowed_origins: ["https://a.example"], reasoning: "Docs." } }),
      pendingUpdateFixture({
        permissions: ["features:read", "workspace:read"],
        network: {
          allowed_origins: ["https://a.example", "https://b.example"],
          reasoning: "Docs.",
        },
        commands: [{ program: "git", reasoning: "Reads history." }],
        backend_binary: BINARY,
      }),
    );
    const changes = within(dialog).getByRole("region", { name: "What changes" });
    expect(within(changes).getByText("Adds a native program")).toBeInTheDocument();
    expect(within(changes).getByText(/It asks for more since 0.1.0/)).toBeInTheDocument();
    const permissions = within(dialog).getByRole("list", { name: "Permissions" });
    const workspace = within(permissions).getByText("workspace:read").closest("li");
    const features = within(permissions).getByText("features:read").closest("li");
    expect(workspace && within(workspace).queryByText("New")).toBeInTheDocument();
    expect(features && within(features).queryByText("New")).toBeNull();
    const sites = within(dialog).getByRole("list", { name: "Allowed sites" });
    expect(within(sites).getAllByText("New")).toHaveLength(1);
    expect(within(sites).getByText("https://b.example")).toContainElement(
      within(sites).getByText("New"),
    );
    const commands = within(dialog).getByRole("list", { name: "Commands" });
    expect(within(commands).getByText("New")).toBeInTheDocument();
    expect(within(dialog).getAllByText("New")).toHaveLength(4);
  });

  it("says nothing about the program when it is the same build", () => {
    const installed = { ...BACKEND, managed: true, backend_binary: BINARY };
    const dialog = renderUpdate(
      installed,
      pendingUpdateFixture({ permissions: installed.permissions, backend_binary: BINARY }),
    );
    expect(within(dialog).queryByText("The native program changes")).toBeNull();
    expect(within(dialog).getByText("It asks for nothing new since 0.1.0.")).toBeInTheDocument();
  });
});
