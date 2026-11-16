import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@/test-utils";
import type { PluginTabConfiguration } from "@/api/generated";
import { projectFixture, tabFixture } from "./custom-tabs-fixtures";
import { CustomTabConfiguration } from "./CustomTabConfiguration";
import { KeptDraftsProvider } from "./kept-drafts";

const mocks = vi.hoisted(() => ({
  stored: { global: {} } as PluginTabConfiguration,
  put: vi.fn(),
  /** When set, the next reload waits for it. */
  reloadGate: null as Promise<void> | null,
}));

vi.mock("@/api/generated", async (importOriginal) => {
  const { useMutation, useQuery } = await import("@tanstack/react-query");
  return {
    ...(await importOriginal<typeof import("@/api/generated")>()),
    usePluginTabGetConfiguration: (id: string) =>
      useQuery({
        queryKey: [`/api/plugin-tabs/${id}/configuration`],
        queryFn: async () => {
          if (mocks.reloadGate) await mocks.reloadGate;
          return structuredClone(mocks.stored);
        },
      }),
    usePluginTabPutConfiguration: () => useMutation({ mutationFn: mocks.put }),
  };
});

const TAB = tabFixture({
  configuration: [{ key: "token", type: "secret", label: "Access token", scope: "global" }],
});

describe("CustomTabConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reloadGate = null;
  });

  it("clears a replaced secret once it is saved, though the masked value is unchanged", async () => {
    mocks.stored = { fields: TAB.configuration, global: { token: { is_set: true } } };
    mocks.put.mockResolvedValue(undefined);
    const { user } = render(<CustomTabConfiguration tab={TAB} projects={[]} />);

    await user.click(await screen.findByRole("button", { name: "Replace Access token" }));
    await user.type(screen.getByLabelText("Access token"), "n3w-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({ data: { values: { token: "n3w-secret" } } }),
      expect.anything(),
    );

    // The service answers `{is_set: true}` again: the form must still start over.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(screen.queryByDisplayValue("n3w-secret")).toBeNull();
    expect(screen.getByText("Set")).toBeInTheDocument();
  });

  it("keeps the form locked until the reload after a save settles", async () => {
    mocks.stored = { fields: TAB.configuration, global: { token: { is_set: true } } };
    mocks.reloadGate = null;
    let finishReload: () => void = () => {};
    mocks.put.mockImplementation(async () => {
      mocks.reloadGate = new Promise<void>((resolve) => {
        finishReload = resolve;
      });
    });
    const { user } = render(<CustomTabConfiguration tab={TAB} projects={[]} />);
    await user.click(await screen.findByRole("button", { name: "Replace Access token" }));
    await user.type(screen.getByLabelText("Access token"), "n3w-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Saved, reload pending: nothing can be edited (and then reset) meanwhile.
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(screen.getByLabelText("Access token")).toBeDisabled();
    finishReload();
    mocks.reloadGate = null;
    await waitFor(() => expect(screen.getByText("Set")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Replace Access token" })).toBeEnabled();
  });

  it("keeps one scope locked while the other scope's save settles", async () => {
    const tab = tabFixture({
      configuration: [
        { key: "team", type: "string", label: "Team", scope: "global" },
        { key: "repo", type: "string", label: "Repository", scope: "project" },
      ],
    });
    mocks.stored = { fields: tab.configuration, global: {}, project: {} };
    mocks.reloadGate = null;
    let finishReload: () => void = () => {};
    mocks.put.mockImplementation(async () => {
      mocks.reloadGate ??= new Promise<void>((resolve) => {
        finishReload = resolve;
      });
    });
    const { user } = render(
      <CustomTabConfiguration tab={tab} projects={[projectFixture(1, "app")]} />,
    );
    const [saveGlobal, saveProject] = await screen.findAllByRole("button", { name: "Save" });
    await user.type(screen.getByLabelText("Team"), "core");
    await user.click(saveGlobal!);
    await waitFor(() => expect(screen.getByLabelText("Team")).toBeDisabled());
    await user.type(screen.getByLabelText("Repository"), "acme/app");
    await user.click(saveProject!);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    // The project save starting (or ending) does not unlock the global form.
    expect(screen.getByLabelText("Team")).toBeDisabled();
    finishReload();
    mocks.reloadGate = null;
    await waitFor(() => expect(screen.getByLabelText("Team")).toBeEnabled());
  });
  it("comes back locked when the card remounts while its save is pending", async () => {
    const tab = tabFixture({
      configuration: [{ key: "team", type: "string", label: "Review team", scope: "global" }],
    });
    mocks.stored = { fields: tab.configuration, global: { team: "core" } };
    let finishPut: () => void = () => {};
    mocks.put.mockImplementation(
      (variables: { data: { values: Record<string, unknown> } }) =>
        new Promise<void>((resolve) => {
          finishPut = () => {
            mocks.stored = { ...mocks.stored, global: variables.data.values };
            resolve();
          };
        }),
    );
    // Stands in for the virtualized list scrolling the card out and back.
    function Scrollable() {
      const [shown, setShown] = useState(true);
      return (
        <KeptDraftsProvider>
          <button type="button" onClick={() => setShown((value) => !value)}>
            Scroll
          </button>
          {shown ? <CustomTabConfiguration tab={tab} projects={[]} /> : null}
        </KeptDraftsProvider>
      );
    }
    const { user } = render(<Scrollable />);
    const field = await screen.findByLabelText("Review team");
    await user.clear(field);
    await user.type(field, "First save");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Scroll" }));
    expect(screen.queryByLabelText("Review team")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scroll" }));
    // Still saving: nothing can be typed that the save's reload would discard.
    expect(await screen.findByDisplayValue("First save")).toBeDisabled();

    finishPut();
    await waitFor(() => expect(screen.getByLabelText("Review team")).toBeEnabled());
    expect(screen.getByLabelText("Review team")).toHaveValue("First save");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
