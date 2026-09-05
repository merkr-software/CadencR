import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateProviderWorkspaceDialog, providerIdError } from "./CreateProviderWorkspaceDialog";

describe("CreateProviderWorkspaceDialog", () => {
  it("derives an editable registry id and submits the connector identity", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <CreateProviderWorkspaceDialog isCreating={false} onCreate={onCreate} onClose={vi.fn()} />,
    );

    const submit = screen.getByRole("button", { name: "Create provider project" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Display name"), "Pi Connector");
    expect(screen.getByLabelText("Provider ID")).toHaveValue("pi-connector");
    await user.click(submit);

    expect(onCreate).toHaveBeenCalledWith({
      providerId: "pi-connector",
      displayName: "Pi Connector",
    });
  });

  it("keeps a manually edited id and exposes creation progress", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { rerender } = render(
      <CreateProviderWorkspaceDialog isCreating={false} onCreate={onCreate} onClose={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("Display name"), "Pi");
    await user.clear(screen.getByLabelText("Provider ID"));
    await user.type(screen.getByLabelText("Provider ID"), "pi-coding-agent");
    await user.type(screen.getByLabelText("Display name"), " Agent");
    expect(screen.getByLabelText("Provider ID")).toHaveValue("pi-coding-agent");

    rerender(<CreateProviderWorkspaceDialog isCreating onCreate={onCreate} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Creating project…" })).toBeDisabled();
    expect(
      screen.getByText("Creating the provider project and opening its conversation."),
    ).toBeInTheDocument();
  });
});

describe("providerIdError", () => {
  it("matches the backend registry id shape", () => {
    expect(providerIdError("pi-connector")).toBeNull();
    expect(providerIdError("Pi Connector")).toMatch(/lowercase/i);
    expect(providerIdError("2pi")).toMatch(/start with a letter/i);
  });
});
