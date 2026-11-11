// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useGateCloseFocus } from "./useGateCloseFocus";

function closeEvent(): Event {
  return new Event("focusScope.autoFocusOnUnmount", { cancelable: true });
}

beforeEach(() => {
  usePendingGatePopoverStore.setState({
    open: null,
    dismissedRequestIds: new Set(),
    planRequestIds: new Set(),
  });
  document.body.innerHTML = "";
});

describe("useGateCloseFocus", () => {
  it("keeps the focus to return while another quick reply took over, and returns it at the last close", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    const store = usePendingGatePopoverStore.getState();
    store.openGate({ featureId: 1, surface: "tree", origin: "user" });
    composer.blur();
    const { result: first } = renderHook(() => useGateCloseFocus("user"));

    // The queue moved on to another conversation: the first one closing gives nothing back.
    store.openGate({ featureId: 2, surface: "tree", origin: "user" });
    first.current(closeEvent());
    expect(document.activeElement).toBe(document.body);

    // The last one closes: focus goes back to where the user was.
    const { result: second } = renderHook(() => useGateCloseFocus("user"));
    store.closeGate("request-2");
    second.current(closeEvent());
    expect(document.activeElement).toBe(composer);
  });
});
