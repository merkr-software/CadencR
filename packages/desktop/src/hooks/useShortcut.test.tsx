import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { act, fireEvent, render } from "@/test-utils";
import { useShortcutOverridesStore } from "@/lib/shortcuts/overrides";
import { useGlobalShortcutById, useShortcut } from "./useShortcut";

// `test-setup.ts` pins `navigator.platform = "MacIntel"`, so `mod` resolves
// to `meta` and these tests fire `metaKey: true`. Cross-platform coverage
// (mod → ctrl) lives in `lib/shortcuts/resolve.test.ts`.

afterEach(() => {
  useShortcutOverridesStore.getState().resetAll();
});

function Harness({ onFire }: { onFire: () => void }): ReactElement {
  useShortcut("toggle-sidebar", onFire);
  return <div data-testid="harness" tabIndex={0} />;
}

function PaneAgentHarness({ onFire }: { onFire: () => void }): ReactElement {
  useShortcut("pane-agent", onFire);
  return <div data-testid="pane-agent-harness" tabIndex={0} />;
}

function ZoomResetHarness({ onFire }: { onFire: () => void }): ReactElement {
  useShortcut("zoom-reset", onFire);
  return <div data-testid="zoom-reset-harness" tabIndex={0} />;
}

function ZoomInHarness({ onFire }: { onFire: () => void }): ReactElement {
  useShortcut("zoom-in", onFire);
  return <div data-testid="zoom-in-harness" tabIndex={0} />;
}

function ZoomOutHarness({ onFire }: { onFire: () => void }): ReactElement {
  useShortcut("zoom-out", onFire);
  return <div data-testid="zoom-out-harness" tabIndex={0} />;
}

function GlobalHarness({ onFire }: { onFire: () => void }): ReactElement {
  useGlobalShortcutById("shortcuts-help", onFire);
  return <div data-testid="g" tabIndex={0} />;
}

describe("useShortcut", () => {
  it("binds the registry default combo for the given id", () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    fireEvent.keyDown(document.body, { key: "b", metaKey: true, code: "KeyB" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("re-binds when the user overrides the combo (future customization path)", () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    act(() => {
      useShortcutOverridesStore.getState().setOverride("toggle-sidebar", {
        keys: ["mod", "shift", "b"],
      });
    });

    fireEvent.keyDown(document.body, { key: "b", metaKey: true, code: "KeyB" });
    expect(onFire).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, {
      key: "B",
      metaKey: true,
      shiftKey: true,
      code: "KeyB",
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fires from inside a text input (form-tag default = true)", () => {
    const onFire = vi.fn();
    const { container } = render(
      <>
        <Harness onFire={onFire} />
        <input data-testid="ip" />
      </>,
    );
    const input = container.querySelector("input")!;
    input.focus();

    fireEvent.keyDown(input, { key: "b", metaKey: true, code: "KeyB" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fires Cmd+Shift+A on the labelled A key for AZERTY layouts", () => {
    const onFire = vi.fn();
    render(<PaneAgentHarness onFire={onFire} />);

    fireEvent.keyDown(document.body, {
      key: "A",
      metaKey: true,
      shiftKey: true,
      code: "KeyQ",
    });

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fires Cmd+0 from the digit character even when Shift produces it", () => {
    const onFire = vi.fn();
    render(<ZoomResetHarness onFire={onFire} />);

    fireEvent.keyDown(document.body, {
      key: "0",
      metaKey: true,
      shiftKey: true,
      code: "Digit0",
    });

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fires Cmd+Plus from the plus character, not the equals character", () => {
    const onFire = vi.fn();
    render(<ZoomInHarness onFire={onFire} />);

    fireEvent.keyDown(document.body, { key: "=", metaKey: true, code: "Equal" });
    expect(onFire).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, {
      key: "+",
      metaKey: true,
      shiftKey: true,
      code: "Equal",
    });
    expect(onFire).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, {
      key: "=",
      metaKey: true,
      shiftKey: true,
      code: "Equal",
    });
    expect(onFire).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document.body, { key: "+", metaKey: true, code: "Slash" });
    expect(onFire).toHaveBeenCalledTimes(3);
  });

  it("does not fire Cmd+Minus from shifted underscore", () => {
    const onFire = vi.fn();
    render(<ZoomOutHarness onFire={onFire} />);

    fireEvent.keyDown(document.body, { key: "-", metaKey: true, code: "Minus" });
    expect(onFire).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, {
      key: "-",
      metaKey: true,
      shiftKey: true,
      code: "Minus",
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("useGlobalShortcutById", () => {
  it("does NOT open shortcuts-help on ⌘+/ — that combo belongs to the editor's Toggle Line Comment", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    fireEvent.keyDown(window, { key: "/", metaKey: true, code: "Slash" });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("opens shortcuts-help on AZERTY-FR via the labelled `?` key (Shift+,)", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    // AZERTY-FR: the labelled "?" key is physically the comma key with Shift.
    // event.key === "?", code === "Comma", shiftKey === true.
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
      code: "Comma",
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("also opens shortcuts-help on QWERTY via ⌘+Shift+/", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    // QWERTY users producing "?" the other way (Shift+/) should also work.
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
      code: "Slash",
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("opens shortcuts-help on QWERTY when macOS mangles event.key to '/' under Cmd", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    // Under Cmd, macOS reports the base char ("/") for QWERTY's Shift+Slash.
    // The `/` variant matches that event.key so help still opens.
    fireEvent.keyDown(window, { key: "/", metaKey: true, shiftKey: true, code: "Slash" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("opens shortcuts-help on AZERTY when macOS mangles event.key to ',' under Cmd", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    // AZERTY's labelled "?" is Shift+Comma; under Cmd, macOS reports the base
    // char (","). The `,` variant matches that event.key so help still opens.
    fireEvent.keyDown(window, { key: ",", metaKey: true, shiftKey: true, code: "Comma" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("opens shortcuts-help on ⌘? without Shift (layouts where ? is a base char)", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    fireEvent.keyDown(window, { key: "?", metaKey: true, code: "Slash" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT open shortcuts-help on QWERTY ⌘+Shift+, (the '<' key)", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    // The `,` variant's exactKeys pins it to event.key === ",", so a real
    // shifted comma ("<") on QWERTY must not trigger the help modal.
    fireEvent.keyDown(window, { key: "<", metaKey: true, shiftKey: true, code: "Comma" });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("re-binds when the override changes", () => {
    const onFire = vi.fn();
    render(<GlobalHarness onFire={onFire} />);

    act(() => {
      useShortcutOverridesStore.getState().setOverride("shortcuts-help", {
        keys: ["mod", "shift", "h"],
      });
    });

    fireEvent.keyDown(window, { key: "?", metaKey: true, shiftKey: true, code: "Slash" });
    expect(onFire).not.toHaveBeenCalled();

    fireEvent.keyDown(window, {
      key: "h",
      metaKey: true,
      shiftKey: true,
      code: "KeyH",
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
