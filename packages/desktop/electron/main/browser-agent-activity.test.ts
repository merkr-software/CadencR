import { describe, expect, it } from "vitest";

import { agentActivityFor } from "./browser-agent-activity";

describe("agentActivityFor", () => {
  it("tells opening a page apart from acting on one", () => {
    expect(agentActivityFor("browser_open_url", 4)).toEqual({ scopeId: 4, action: "open" });
    expect(agentActivityFor("browser_click", 4)).toEqual({ scopeId: 4, action: "interact" });
  });

  it("stays quiet without a feature pin or for tools that touch no in-app page", () => {
    expect(agentActivityFor("browser_open_url", undefined)).toBeNull();
    expect(agentActivityFor("browser_list_tabs", 4)).toBeNull();
    expect(agentActivityFor("browser_open_external_url", 4)).toBeNull();
  });
});
