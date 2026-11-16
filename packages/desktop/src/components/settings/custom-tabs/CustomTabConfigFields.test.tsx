import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { TabConfigField } from "@/api/generated";
import { CustomTabConfigFields } from "./CustomTabConfigFields";
import { KeptDraftsProvider } from "./kept-drafts";

// The generated type models `default` as a JSON object; a manifest default is any JSON value.
const NUMBER_DEFAULT = 20 as unknown as TabConfigField["default"];

const FIELDS: TabConfigField[] = [
  { key: "gitlab_url", type: "string", label: "GitLab URL", scope: "global" },
  { key: "gitlab_token", type: "secret", label: "Access token", scope: "global" },
  { key: "limit", type: "number", label: "Limit", scope: "global", default: NUMBER_DEFAULT },
  { key: "compact", type: "boolean", label: "Compact", scope: "global" },
];

const saved = () => vi.fn(async (_values: Record<string, unknown>) => true);

function renderForm(stored: Record<string, unknown>, error: string | null = null) {
  const onSave = saved();
  const view = render(
    <CustomTabConfigFields
      fields={FIELDS}
      stored={stored}
      saving={false}
      error={error}
      onSave={onSave}
    />,
  );
  return { ...view, onSave };
}

describe("CustomTabConfigFields", () => {
  it("shows a set secret as Set and never renders a value for it", () => {
    const { container } = renderForm({ gitlab_token: { is_set: true } });
    expect(screen.getByText("Set")).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.innerHTML).not.toContain("is_set");
  });

  it("saves only the fields that changed", async () => {
    const { user, onSave } = renderForm({
      gitlab_url: "https://old.example",
      gitlab_token: { is_set: true },
    });
    const url = screen.getByLabelText("GitLab URL");
    await user.clear(url);
    await user.type(url, "https://gitlab.example.com");
    await user.type(screen.getByLabelText("Limit"), "50");
    await user.click(screen.getByRole("switch", { name: "Compact" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      gitlab_url: "https://gitlab.example.com",
      limit: 50,
      compact: true,
    });
  });

  it("replaces and clears a secret by intent", async () => {
    const { user, onSave, unmount } = renderForm({ gitlab_token: { is_set: true } });
    await user.click(screen.getByRole("button", { name: "Replace Access token" }));
    const input = screen.getByLabelText("Access token");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    await user.type(input, "s3cret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith({ gitlab_token: "s3cret" });
    unmount();

    const second = renderForm({ gitlab_token: { is_set: true } });
    await second.user.click(screen.getByRole("button", { name: "Clear Access token" }));
    expect(screen.getByText("Cleared on save")).toBeInTheDocument();
    await second.user.click(screen.getByRole("button", { name: "Save" }));
    expect(second.onSave).toHaveBeenLastCalledWith({ gitlab_token: null });
  });

  it("keeps Save off until something changed and shows the service's verdict", () => {
    renderForm({}, "`limit` must be a number");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("`limit` must be a number");
    expect(screen.getByText("Default: 20")).toBeInTheDocument();
  });

  it("shows a field declared while the form is open and keeps the draft", async () => {
    const { user, rerender } = renderForm({});
    await user.type(screen.getByLabelText("GitLab URL"), "https://gitlab.example.com");
    const added: TabConfigField = { key: "team", type: "string", label: "Team", scope: "global" };
    rerender(
      <CustomTabConfigFields
        fields={[...FIELDS, added]}
        stored={{}}
        saving={false}
        error={null}
        onSave={saved()}
      />,
    );
    expect(screen.getByLabelText("Team")).toHaveValue("");
    expect(screen.getByLabelText("GitLab URL")).toHaveValue("https://gitlab.example.com");
  });

  it("finds its unsaved draft after unmounting until the stored values change", async () => {
    const form = (show: boolean, stored: Record<string, unknown>) => {
      const version = JSON.stringify(stored);
      return (
        <KeptDraftsProvider>
          {show ? (
            <CustomTabConfigFields
              key={version}
              fields={FIELDS}
              stored={stored}
              saving={false}
              error={null}
              onSave={saved()}
              draftSlot={{ id: "graph:global", version }}
            />
          ) : null}
        </KeptDraftsProvider>
      );
    };
    const url = () => screen.getByLabelText("GitLab URL");
    const { user, rerender } = render(form(true, { gitlab_url: "A" }));
    await user.clear(url());
    await user.type(url(), "B");
    rerender(form(false, { gitlab_url: "A" }));
    rerender(form(true, { gitlab_url: "A" }));
    expect(url()).toHaveValue("B");
    // Saved as B, then back to A: the old draft is retired, not revived.
    rerender(form(true, { gitlab_url: "B" }));
    expect(url()).toHaveValue("B");
    rerender(form(true, { gitlab_url: "A" }));
    expect(url()).toHaveValue("A");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("starts over once a save resolves, and keeps later edits while it scrolls away", async () => {
    const onSave = saved();
    const form = (show: boolean) => (
      <KeptDraftsProvider>
        {show ? (
          <CustomTabConfigFields
            fields={FIELDS}
            stored={{ gitlab_token: { is_set: true } }}
            saving={false}
            error={null}
            onSave={onSave}
            draftSlot={{ id: "graph:global", version: "v1" }}
          />
        ) : null}
      </KeptDraftsProvider>
    );
    const { user, rerender } = render(form(true));
    await user.click(screen.getByRole("button", { name: "Replace Access token" }));
    await user.type(screen.getByLabelText("Access token"), "n3w");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The masked answer is unchanged, yet the replaced secret is gone.
    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // An edit after that save survives unmounting.
    await user.type(screen.getByLabelText("GitLab URL"), "https://after.example");
    rerender(form(false));
    rerender(form(true));
    expect(screen.getByLabelText("GitLab URL")).toHaveValue("https://after.example");
  });
});
