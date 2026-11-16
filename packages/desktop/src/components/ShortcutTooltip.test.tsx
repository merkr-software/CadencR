import { beforeEach, describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { focusFollowedKeyboardNavigation } from "@/lib/focus-navigation";
import { ShortcutTooltip } from "./ShortcutTooltip";

function tooltipContent(): HTMLElement {
  const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
  expect(content).not.toBeNull();
  return content!;
}

describe("ShortcutTooltip", () => {
  // Reading consumes any recorded keyboard-navigation intent, so a case that
  // pressed Tab can't leak that intent into the next one.
  beforeEach(() => {
    focusFollowedKeyboardNavigation();
  });

  it("renders children", () => {
    render(
      <ShortcutTooltip label="Test" keys={["cmd", "K"]}>
        <button>Click me</button>
      </ShortcutTooltip>,
    );
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });

  it("does not show tooltip initially", () => {
    render(
      <ShortcutTooltip label="Test" keys={["cmd", "K"]}>
        <button>Click me</button>
      </ShortcutTooltip>,
    );
    expect(screen.queryByText("Test")).not.toBeInTheDocument();
  });

  it("shows tooltip on hover and hides on leave", () => {
    render(
      <ShortcutTooltip label="My label" keys={["cmd", "S"]}>
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    const wrapper = screen.getByText("Btn").parentElement!;
    fireEvent.mouseEnter(wrapper);
    expect(tooltipContent()).toHaveTextContent("My label");

    fireEvent.mouseLeave(wrapper);
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("ignores programmatic focus so a restored tab focus can't pop the bubble", () => {
    render(
      <ShortcutTooltip label="Git" keys={["cmd", "shift", "G"]}>
        <button>Git</button>
      </ShortcutTooltip>,
    );
    const trigger = screen.getByText("Git");

    trigger.focus();
    fireEvent.focus(trigger);

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("shows the bubble when the user tabbed to the trigger", () => {
    render(
      <ShortcutTooltip label="Git" keys={["cmd", "shift", "G"]}>
        <button>Git</button>
      </ShortcutTooltip>,
    );
    const trigger = screen.getByText("Git");

    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(trigger);

    expect(tooltipContent()).toHaveTextContent("Git");
  });

  it("closes a keyboard-opened bubble on Esc, so the next Esc reaches the page", () => {
    render(
      <ShortcutTooltip label="Model" keys={["cmd", "P"]}>
        <button>Model</button>
      </ShortcutTooltip>,
    );
    const trigger = screen.getByText("Model");
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(trigger);
    expect(tooltipContent()).toHaveTextContent("Model");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("ignores focus a pane shortcut moved for us", () => {
    render(
      <ShortcutTooltip label="Git" keys={["cmd", "shift", "G"]}>
        <button>Git</button>
      </ShortcutTooltip>,
    );
    const trigger = screen.getByText("Git");

    fireEvent.keyDown(window, { key: "g", metaKey: true, shiftKey: true });
    fireEvent.focus(trigger);

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("renders without a keys row when keys is empty or omitted", () => {
    render(
      <ShortcutTooltip label="No keys">
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    const wrapper = screen.getByText("Btn").parentElement!;
    fireEvent.mouseEnter(wrapper);
    const bubble = tooltipContent();
    expect(bubble.querySelector("kbd")).toBeNull();
  });

  it("applies className to wrapper", () => {
    render(
      <ShortcutTooltip label="Test" className="flex-1">
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    const wrapper = screen.getByText("Btn").parentElement!;
    expect(wrapper.className).toContain("flex-1");
  });

  it("positions tooltip above the trigger when above prop is set", () => {
    render(
      <ShortcutTooltip label="Above" keys={["cmd", "B"]} above>
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Btn").parentElement!);

    const bubble = tooltipContent();
    expect(bubble).toHaveAttribute("data-side", "top");
  });

  it("positions tooltip below the trigger by default", () => {
    render(
      <ShortcutTooltip label="Below" keys={["cmd", "B"]}>
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Btn").parentElement!);

    const bubble = tooltipContent();
    expect(bubble).toHaveAttribute("data-side", "bottom");
  });

  it("positions the bubble to the right when toRight is set", () => {
    render(
      <ShortcutTooltip label="Side" keys={["cmd", "B"]} toRight>
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Btn").parentElement!);

    const bubble = tooltipContent();
    expect(bubble).toHaveAttribute("data-side", "right");
  });

  it("portals the bubble outside the wrapper so ancestor overflow can't clip it", () => {
    render(
      <ShortcutTooltip label="Portaled">
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    const wrapper = screen.getByText("Btn").parentElement!;
    fireEvent.mouseEnter(wrapper);
    const bubble = tooltipContent();
    // The bubble lives directly under `document.body`, not inside the wrapper.
    expect(wrapper.contains(bubble)).toBe(false);
    expect(bubble.parentElement?.parentElement).toBe(document.body);
  });

  it("caps the portal content to the viewport width", () => {
    render(
      <ShortcutTooltip label="Contained">
        <button>Btn</button>
      </ShortcutTooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Btn").parentElement!);

    expect(tooltipContent()).toHaveClass("max-w-[calc(100vw-1rem)]");
  });
});
