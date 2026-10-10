import { describe, expect, it } from "vitest";
import { createSessionEntry, type SessionEntry } from "./ws-session-types";
import { statusSyncPatch } from "./ws-status-reconciliation";
import {
  anchorTurnTiming,
  reconcileTurnAnchor,
  startTurnTiming,
  suspendTurnTiming,
} from "./ws-turn-timing";
import { applyUpdate } from "./session-status-handlers";
import { buildResolvedGatePatch } from "./ws-gate-state";

const permission = (requestId: string) => ({
  requestId,
  toolName: "Bash",
  input: {},
  description: "",
  pattern: "",
});

describe("gate and turn reconciliation", () => {
  it.each([true, false])(
    "resolving A preserves B regardless of arrival order (B first: %s)",
    (first) => {
      let session: SessionEntry = {
        ...createSessionEntry(),
        pendingPermission: permission("a"),
        pendingRequestId: "a",
      };
      if (first) session.pendingPermissionQueue = [permission("b")];
      session = {
        ...session,
        ...statusSyncPatch(session, { status: "agent", kind: null, resolvedRequestId: "a" }),
      };
      if (!first)
        session = { ...session, pendingPermission: permission("b"), pendingRequestId: "b" };
      session = { ...session, ...buildResolvedGatePatch(session, "a") };
      expect(session.pendingPermission?.requestId).toBe("b");
      expect(session.pendingRequestId).toBe("b");
    },
  );

  it("adopts a server anchor without restarting a suspended observation", () => {
    const observed = { ...startTurnTiming(5_000), activeMs: 200, userPendingMs: 300 };
    const suspended = suspendTurnTiming(observed, { phase: "active" }, 6_000);
    expect(reconcileTurnAnchor(suspended, 1_000, 8_000)).toMatchObject({
      startedAt: 1_000,
      segmentStartedAt: null,
      activeMs: 1_200,
      userPendingMs: 300,
    });
  });

  it("resets buckets only for a different confirmed turn", () => {
    const observed = { ...anchorTurnTiming(1_000, 5_000), activeMs: 200, userPendingMs: 300 };
    expect(reconcileTurnAnchor(observed, 1_000, 8_000)).toBe(observed);
    expect(reconcileTurnAnchor(observed, 7_000, 8_000)).toMatchObject({
      startedAt: 7_000,
      segmentStartedAt: 8_000,
      activeMs: 0,
      userPendingMs: 0,
    });
  });

  it("advances identical status watermarks and retains the anchor across a gate", () => {
    const prev = {
      1: { status: "agent" as const, kind: null, featureId: 2, seq: 1, turnStartedAtMs: 1_000 },
    };
    const same = applyUpdate(prev, { session_id: 1, feature_id: 2, status: "agent", seq: 3 });
    expect(same.next?.[1]).toMatchObject({ seq: 3, turnStartedAtMs: 1_000 });
    expect(
      applyUpdate(same.next!, { session_id: 1, feature_id: 2, status: "idle", seq: 2 }).entry,
    ).toBeNull();
    const gate = applyUpdate(same.next!, {
      session_id: 1,
      feature_id: 2,
      status: "question",
      seq: 4,
    });
    expect(gate.next?.[1].turnStartedAtMs).toBe(1_000);
  });
});
