import { describe, expect, it } from "vitest";
import type { NotchAgent } from "@/shared/notch";
import { ambientAgents, compactDots } from "./notch-ambient";

function agent(featureId: number, status: NotchAgent["status"], unread = false): NotchAgent {
  return {
    featureId,
    projectId: 1,
    title: `Agent ${featureId}`,
    projectName: "cadencr",
    status,
    pendingKind: status === "question" ? "permission" : null,
    providerLabel: null,
    providerIconSrc: null,
    providerIconMono: false,
    turnStartedAtMs: null,
    lastActivityAtMs: null,
    lastAction: null,
    preview: null,
    unread,
  };
}

describe("ambientAgents", () => {
  it("keeps working, waiting and unread agents, drops read finished ones", () => {
    const agents = [
      agent(1, "running"),
      agent(2, "question"),
      agent(3, "done", true),
      agent(4, "done"),
    ];
    expect(ambientAgents(agents).map((a) => a.featureId)).toEqual([1, 2, 3]);
  });

  it("is empty once the last agent finished and was read", () => {
    expect(ambientAgents([agent(4, "done")])).toEqual([]);
  });
});

describe("compactDots", () => {
  it.each([
    [4, 4, 0],
    [5, 3, 2],
    [12, 3, 9],
    [13, 2, 11],
    [102, 1, 101],
  ])("fits %i agents as %i dots + %i more", (count, dots, extra) => {
    const agents = Array.from({ length: count }, (_, i) => agent(i, "running"));
    expect(compactDots(agents)).toEqual({ shown: agents.slice(0, dots), extra });
  });
});
