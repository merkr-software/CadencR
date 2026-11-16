// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useSlashCommand, type SlashCommand } from "./useSlashCommand";

const commands: SlashCommand[] = [
  { name: "commit", description: "Create a git commit", kind: "command" },
  { name: "review", description: "Start a code review", kind: "command" },
  { name: "plan", description: "Create a development plan", kind: "skill" },
];

describe("useSlashCommand", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.filteredItems).toEqual([]);
  });

  it("opens when / is typed at position 0", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.filteredItems).toHaveLength(commands.length);
  });

  it("filters by command name", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/commit", 7);
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].name).toBe("commit");
  });

  it("filters by description", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/git", 4);
    });
    expect(result.current.filteredItems.some((c) => c.name === "commit")).toBe(true);
  });

  it("ranks exact and prefix name matches before description-only matches", () => {
    const mixedCommands: SlashCommand[] = [
      {
        name: "first-description-hit",
        description: "Contains brainstorm in description",
        kind: "command",
      },
      {
        name: "superpowers:brainstorming",
        description: "Create ideas",
        kind: "command",
      },
      {
        name: "brainstorm",
        description: "Best direct match",
        kind: "command",
      },
    ];
    const { result } = renderHook(() => useSlashCommand(mixedCommands));

    act(() => {
      result.current.handleChange("/brain", 6);
    });

    expect(result.current.filteredItems.map((item) => item.name)).toEqual([
      "brainstorm",
      "superpowers:brainstorming",
      "first-description-hit",
    ]);
    expect(result.current.selectedIndex).toBe(0);
  });

  it("closes when text does not start with /", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/commit", 7);
    });
    act(() => {
      result.current.handleChange("hello", 5);
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when cursor moves past the command portion (after space)", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/commit msg", 11);
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes on close()", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("confirm inserts selected command", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    let confirmed: { newText: string; newCursorPos: number } | null = null;
    act(() => {
      confirmed = result.current.confirm("/");
    });
    expect(confirmed).not.toBeNull();
    expect(confirmed!.newText).toMatch(/^\/\w+ $/);
  });

  it("confirm by specific command name", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    let confirmed: { newText: string; newCursorPos: number } | null = null;
    act(() => {
      confirmed = result.current.confirm("/", "review");
    });
    expect(confirmed!.newText).toBe("/review ");
  });

  it("supports dollar-prefixed skill insertion", () => {
    const { result } = renderHook(() => useSlashCommand(commands, "$"));
    act(() => {
      result.current.handleChange("$plan", 5);
    });

    let confirmed: { newText: string; newCursorPos: number } | null = null;
    act(() => {
      confirmed = result.current.confirm("$plan", "plan");
    });

    expect(confirmed).toEqual({ newText: "$plan ", newCursorPos: 6 });
  });

  it("confirm returns null when not open", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    expect(result.current.confirm("")).toBeNull();
  });

  it("ArrowDown moves selectedIndex", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    act(() => {
      result.current.handleKeyDown(
        { key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "/",
      );
    });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("ArrowUp wraps around", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    act(() => {
      result.current.handleKeyDown(
        { key: "ArrowUp", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "/",
      );
    });
    expect(result.current.selectedIndex).toBe(commands.length - 1);
  });

  it("Enter confirms selection", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    let res: ReturnType<typeof result.current.handleKeyDown> | undefined;
    act(() => {
      res = result.current.handleKeyDown(
        { key: "Enter", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "/",
      );
    });
    expect(typeof res).toBe("object");
    expect(result.current.isOpen).toBe(false);
  });

  it("Escape closes dropdown", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    act(() => {
      result.current.handleChange("/", 1);
    });
    act(() => {
      result.current.handleKeyDown(
        { key: "Escape", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "/",
      );
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("returns false from handleKeyDown when not open", () => {
    const { result } = renderHook(() => useSlashCommand(commands));
    const res = result.current.handleKeyDown(
      { key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
      "hello",
    );
    expect(res).toBe(false);
  });

  it("handles undefined commands", () => {
    const { result } = renderHook(() => useSlashCommand(undefined));
    act(() => {
      result.current.handleChange("/", 1);
    });
    expect(result.current.filteredItems).toEqual([]);
  });
});
