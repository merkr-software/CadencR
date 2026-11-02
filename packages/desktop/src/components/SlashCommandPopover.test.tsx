import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { SlashCommandPopover } from "./SlashCommandPopover";

const commands = [
  {
    name: "commit",
    description: "Commit changes",
    kind: "command" as const,
    argumentHint: undefined,
  },
  {
    name: "plan",
    description: "Create a plan",
    kind: "skill" as const,
    argumentHint: "[description]",
  },
];

const cadencrCommand = {
  name: "cadencr:review",
  description: "Review this worktree",
  kind: "cadencr" as const,
  argumentHint: "[focus]",
};

describe("SlashCommandPopover", () => {
  it("does not show popover when closed", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={false}
        items={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.queryByText("/commit")).not.toBeInTheDocument();
  });

  it("shows a discovery error above the commands that remain usable", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[cadencrCommand]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
        error="Provider commands could not be loaded: timed out"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider commands could not be loaded: timed out",
    );
    expect(screen.getByText("/cadencr:review")).toBeInTheDocument();
  });

  it("shows the error instead of 'no matching commands' when nothing is left", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
        error="Provider commands could not be loaded: rejected"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("rejected");
    expect(screen.queryByText("No matching commands")).not.toBeInTheDocument();
  });

  it("shows commands when open", () => {
    const { container } = render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/plan")).toBeInTheDocument();
    expect(container.querySelector("[data-composer-popover]")).toBeInTheDocument();
  });

  it("applies viewport-aware maxHeight", () => {
    const { container } = render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
        maxHeight={180}
      />,
    );
    expect(container.querySelector(".glass-surface")).toHaveStyle({ maxHeight: "180px" });
  });

  it("does not render command kind badges", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.queryByText("command")).not.toBeInTheDocument();
    expect(screen.queryByText("skill")).not.toBeInTheDocument();
  });

  it("slides only the highlighted row's description", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    // SlidingText wraps its text in an inner span; the static rows truncate.
    expect(screen.getByText("Commit changes").parentElement).toHaveClass(
      "text-accent-foreground/80",
    );
    expect(screen.getByText("Create a plan")).toHaveClass("truncate", "text-muted-foreground");
  });

  it("groups contiguous kinds under labelled headers with listbox semantics", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[cadencrCommand, commands[1], commands[0]]}
        selectedIndex={1}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cadencr orchestration" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Commands" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.id)).toEqual(["cmds-opt-0", "cmds-opt-1", "cmds-opt-2"]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("drops headers when ranking interleaves kinds", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[commands[0], commands[1], { ...commands[0], name: "compact" }]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("renders skill trigger prefix when provided", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[commands[1]]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
        triggerChar="$"
      />,
    );
    expect(screen.getByText("$plan")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={true}
      />,
    );
    expect(screen.getByText(/loading commands/i)).toBeInTheDocument();
  });

  it("shows empty message when no commands", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/no matching commands/i)).toBeInTheDocument();
  });

  it("calls onSelect with command name on click", async () => {
    const onSelect = vi.fn();
    const { user } = render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={commands}
        selectedIndex={0}
        onSelect={onSelect}
        isLoading={false}
      />,
    );
    await user.pointer({ keys: "[MouseLeft>]", target: screen.getByText("/commit") });
    expect(onSelect).toHaveBeenCalledWith("commit");
  });

  it("keeps a standalone Cadencr skill usable while the MCP servers are off", () => {
    render(
      <SlashCommandPopover
        listId="cmds"
        open={true}
        items={[cadencrCommand, { ...cadencrCommand, name: "cadencr:side", standalone: true }]}
        selectedIndex={0}
        onSelect={vi.fn()}
        isLoading={false}
        cadencrDisabled
      />,
    );
    expect(screen.getByText("/cadencr:review").closest("[role=option]")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("/cadencr:side").closest("[role=option]")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
