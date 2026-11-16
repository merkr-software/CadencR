// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_TAB_KINDS, type TabKind } from "@/stores/feature-layout-schema";

import {
  releaseFocusOutsideTab,
  restoreTabFocus,
  useTabFocusMemory,
} from "./tab-focus-preservation";

function setup() {
  const mounts = {} as Record<TabKind, HTMLDivElement>;
  for (const tab of BUILTIN_TAB_KINDS) {
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

/** Agent and Git mounts side by side, as in a split — both visible. */
function setupSplit() {
  const mount = (tab: TabKind, child: HTMLElement): HTMLElement => {
    const el = document.createElement("div");
    el.setAttribute("data-tab-mount", tab);
    el.append(child);
    document.body.append(el);
    return child;
  };
  const prompt = mount("agent", document.createElement("textarea"));
  const gitButton = mount("git", document.createElement("button"));
  return { prompt, gitButton };
}

describe("releaseFocusOutsideTab", () => {
  it("takes the caret out of a still-visible prompt when Git is activated", () => {
    const { prompt } = setupSplit();
    prompt.focus();

    releaseFocusOutsideTab("git");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps focus that is already inside the activated tab", () => {
    const { gitButton } = setupSplit();
    gitButton.focus();

    releaseFocusOutsideTab("git");
    expect(document.activeElement).toBe(gitButton);
  });

  it("leaves focus outside every tab alone", () => {
    setupSplit();
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();

    releaseFocusOutsideTab("git");
    expect(document.activeElement).toBe(search);
  });
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
