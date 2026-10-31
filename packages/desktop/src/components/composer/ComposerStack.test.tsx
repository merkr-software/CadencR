import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { ComposerStack, StackSection } from "./ComposerStack";

const mobile = vi.hoisted(() => ({ current: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.current }));

function Section({ name, ambient = false }: { name: string; ambient?: boolean }): ReactElement {
  return (
    <StackSection
      tone="queue"
      label={name}
      icon={null}
      title={name}
      summary={`${name} in one line`}
      opensOnArrival={!ambient}
    >
      <p>{name} in full</p>
    </StackSection>
  );
}

function Stack({ names }: { names: readonly string[] }): ReactElement {
  return (
    <ComposerStack>
      {names.map((name) => (
        <Section key={name} name={name} ambient={name === "Agents"} />
      ))}
    </ComposerStack>
  );
}

describe("ComposerStack folding", () => {
  it("shows two sections whole on a desktop", () => {
    mobile.current = false;
    render(<Stack names={["Agents", "Queued"]} />);
    expect(screen.getByText("Agents in full")).toBeInTheDocument();
    expect(screen.getByText("Queued in full")).toBeInTheDocument();
  });

  it("folds all but the newest arrival from the third section on", () => {
    mobile.current = false;
    const { rerender } = render(<Stack names={["Agents", "Scheduled"]} />);
    rerender(<Stack names={["Agents", "Scheduled", "Queued"]} />);
    expect(screen.getByText("Queued in full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agents in one line/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /Scheduled in one line/ })).toBeInTheDocument();
    expect(screen.queryByText("Agents in full")).not.toBeInTheDocument();
  });

  it("opens a folded section in place of the open one, and folds that one back", async () => {
    mobile.current = false;
    const { user } = render(<Stack names={["Agents", "Scheduled", "Queued"]} />);
    await user.click(screen.getByRole("button", { name: /Scheduled in one line/ }));
    expect(screen.getByText("Scheduled in full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Queued in one line/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fold Scheduled" }));
    expect(screen.queryByText(/in full/)).not.toBeInTheDocument();
  });

  it("folds from the second section on a phone", () => {
    mobile.current = true;
    render(<Stack names={["Scheduled", "Queued"]} />);
    expect(screen.getByText("Queued in full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scheduled in one line/ })).toBeInTheDocument();
  });

  it("does not let an ambient section's return take the open place", () => {
    mobile.current = false;
    function Toggle(): ReactElement {
      const [agents, setAgents] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setAgents((shown) => !shown)}>
            toggle agents
          </button>
          <Stack names={agents ? ["Agents", "Scheduled", "Queued"] : ["Scheduled", "Queued"]} />
        </>
      );
    }
    render(<Toggle />);
    fireEvent.click(screen.getByRole("button", { name: "toggle agents" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle agents" }));
    expect(screen.getByText("Queued in full")).toBeInTheDocument();
  });

  it("keeps whole a section the user is working in when the stack starts folding", () => {
    mobile.current = false;
    function Editable(): ReactElement {
      return (
        <StackSection tone="queue" label="Queued" icon={null} title="Queued" summary="one line">
          <textarea aria-label="Edit queued message" />
        </StackSection>
      );
    }
    function Crowd({ more }: { more: boolean }): ReactElement {
      return (
        <ComposerStack>
          <Editable />
          <Section name="Side" />
          {more && <Section name="Agents" ambient />}
        </ComposerStack>
      );
    }
    const { rerender } = render(<Crowd more={false} />);
    screen.getByRole("textbox", { name: "Edit queued message" }).focus();
    rerender(<Crowd more />);
    expect(screen.getByRole("textbox", { name: "Edit queued message" })).toHaveFocus();
  });

  it("hands focus to the other toggle when a section folds or opens", async () => {
    mobile.current = false;
    const { user } = render(<Stack names={["Agents", "Scheduled", "Queued"]} />);
    await user.click(screen.getByRole("button", { name: "Fold Queued" }));
    expect(screen.getByRole("button", { name: /Queued in one line/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Fold Queued" })).toHaveFocus();
  });

  it("opens the latest arrival that opens when the open section leaves", () => {
    mobile.current = false;
    const { rerender } = render(<Stack names={["Agents", "Scheduled", "Queued", "Side"]} />);
    rerender(<Stack names={["Agents", "Scheduled", "Queued"]} />);
    expect(screen.getByText("Queued in full")).toBeInTheDocument();
  });
});
