import { CodeIcon, GlobeIcon, TerminalIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import { phoneTabLabel, rovingTabIndex, splitPhoneTabs } from "./phone-tab-bar";
import type { FeatureTabs } from "./types";

const def = (label: string) => ({ label, Icon: TerminalIcon, content: null });

const tabs: FeatureTabs = {
  agent: def("Agent"),
  terminal: def("Terminal"),
  git: def("Git"),
  editor: { label: "Editor", Icon: CodeIcon, content: null },
  browser: { label: "Browser", Icon: GlobeIcon, content: null },
  preview: def("Preview"),
  "plugin:notes": def("Notes"),
};

describe("splitPhoneTabs", () => {
  it("keeps Agent, Terminal, Git and Files in the bar, in that order, whatever the layout order", () => {
    const groups = splitPhoneTabs(
      ["preview", "editor", "plugin:notes", "git", "browser", "terminal", "agent"],
      tabs,
    );
    expect(groups.bar).toEqual(["agent", "terminal", "git", "editor"]);
    expect(groups.more).toEqual(["preview", "plugin:notes", "browser"]);
  });

  it("leaves out tabs the layout doesn't hold and tabs without a definition", () => {
    const groups = splitPhoneTabs(["agent", "git", "plugin:gone"], tabs);
    expect(groups.bar).toEqual(["agent", "git"]);
    expect(groups.more).toEqual([]);
  });
});

describe("phoneTabLabel", () => {
  it("calls the editor Files and keeps every other label", () => {
    expect(phoneTabLabel("editor", tabs.editor)).toBe("Files");
    expect(phoneTabLabel("browser", tabs.browser)).toBe("Browser");
  });
});

describe("rovingTabIndex", () => {
  it("moves with the arrows, wrapping, and jumps with Home and End", () => {
    expect(rovingTabIndex("ArrowRight", 4, 5)).toBe(0);
    expect(rovingTabIndex("ArrowLeft", 0, 5)).toBe(4);
    expect(rovingTabIndex("Home", 3, 5)).toBe(0);
    expect(rovingTabIndex("End", 0, 5)).toBe(4);
    expect(rovingTabIndex("ArrowDown", 1, 5)).toBeNull();
    // The rail in a side strip runs top to bottom.
    expect(rovingTabIndex("ArrowDown", 1, 5, "vertical")).toBe(2);
    expect(rovingTabIndex("ArrowUp", 0, 5, "vertical")).toBe(4);
    expect(rovingTabIndex("ArrowRight", 0, 5, "vertical")).toBeNull();
    expect(rovingTabIndex("Enter", 0, 5)).toBeNull();
    expect(rovingTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
