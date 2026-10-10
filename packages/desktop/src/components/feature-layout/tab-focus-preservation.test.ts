import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ALL_TAB_KINDS, type TabKind } from "@/stores/feature-layout-schema";

import { restoreTabFocus, useTabFocusMemory } from "./tab-focus-preservation";

function setup() {
  const mounts = {} as Record<TabKind, HTMLDivElement>;
  for (const tab of ALL_TAB_KINDS) {
    const mount = document.createElement("div");
    mount.setAttribute("data-tab-mount", tab);
    mounts[tab] = mount;
  }
  const oldHost = document.createElement("div");
  const newHost = document.createElement("div");
  document.body.append(oldHost, newHost);
  const prompt = document.createElement("textarea");
  const link = document.createElement("button");
  mounts.agent.append(prompt, link);
  oldHost.append(mounts.agent);
  const { result } = renderHook(() => useTabFocusMemory(mounts));
  /** What a split does: the old host goes away, the mount lands in a new one. */
  const movePane = (): void => {
    oldHost.remove();
    newHost.append(mounts.agent);
  };
  const memory = () => result.current.current;
  return { memory, prompt, link, movePane };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tab focus preservation", () => {
  it("puts focus back in the prompt after a split moves its pane", () => {
    const { memory, prompt, movePane } = setup();
    prompt.focus();
    movePane();
    expect(document.activeElement).not.toBe(prompt);

    restoreTabFocus(memory());
    expect(document.activeElement).toBe(prompt);
  });

  it("leaves focus alone when the user last focused a link or button", () => {
    const { memory, prompt, link, movePane } = setup();
    prompt.focus();
    link.focus();
    movePane();

    restoreTabFocus(memory());
    expect(document.activeElement).not.toBe(prompt);
    expect(document.activeElement).not.toBe(link);
  });

  it("never pulls focus back from an element the user moved to", () => {
    const { memory, prompt, movePane } = setup();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    prompt.focus();
    movePane();
    elsewhere.focus();

    restoreTabFocus(memory());
    expect(document.activeElement).toBe(elsewhere);
  });
});
