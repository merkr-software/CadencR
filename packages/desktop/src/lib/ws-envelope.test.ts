import { describe, it, expect } from "vitest";
import {
  createEnvelope,
  parseEnvelope,
  createSessionInit,
  createPromptSend,
  createCommandsGet,
  createPermissionRespond,
  createInterrupt,
  createDestroy,
} from "./ws-envelope";

describe("ws-envelope", () => {
  describe("createEnvelope", () => {
    it("produces valid envelope with id, domain, action, payload", () => {
      const env = createEnvelope("app", "subscribe.session_status", {});
      expect(env.id).toBeDefined();
      expect(env.domain).toBe("app");
      expect(env.action).toBe("subscribe.session_status");
      expect(env.payload).toEqual({});
    });
  });

  describe("parseEnvelope", () => {
    it("parses valid JSON envelope", () => {
      const raw = JSON.stringify({
        id: "abc",
        domain: "session",
        action: "message",
        payload: { blocks: [] },
      });
      const env = parseEnvelope(raw);
      expect(env.id).toBe("abc");
      expect(env.domain).toBe("session");
      expect(env.action).toBe("message");
    });

    it("throws on malformed JSON", () => {
      expect(() => parseEnvelope("not json")).toThrow();
    });

    it("accepts a null reply reference as an uncorrelated envelope", () => {
      const value = {
        id: "a",
        domain: "session",
        action: "compact.started",
        ref: null,
        payload: null,
      };
      expect(parseEnvelope(JSON.stringify(value))).toEqual({ ...value, ref: undefined });
    });

    it.each([
      null,
      [],
      {},
      { domain: "session", action: "message", payload: {} },
      { id: "a", action: "message", payload: {} },
      { id: "a", domain: "session", payload: {} },
      { id: "", domain: "session", action: "message", payload: {} },
      { id: 1, domain: "session", action: "message", payload: {} },
      { id: "a", domain: true, action: "message", payload: {} },
      { id: "a", domain: "session", action: 1, payload: {} },
      { id: "a", domain: "session", action: "message", ref: 12, payload: {} },
      { id: "a", domain: "session", action: "message", ref: {}, payload: {} },
      { id: "a", domain: "session", action: "message", ref: [], payload: {} },
      { id: "a", domain: "session", action: "message" },
    ])("rejects malformed envelope %j", (value) => {
      expect(() => parseEnvelope(JSON.stringify(value))).toThrow();
    });

    it.each([
      null,
      [],
      ["opaque", { provider: true }],
      "raw provider event",
      17,
      false,
      {
        nested: { provider_extension: [null, { future: "value" }] },
      },
    ])("preserves opaque payload %j and future domain/action strings", (payload) => {
      const value = {
        id: "future-id",
        domain: "future.domain",
        action: "future.action",
        ref: "request",
        payload,
      };
      expect(parseEnvelope(JSON.stringify(value))).toEqual(value);
    });

    it("throws on missing domain", () => {
      const raw = JSON.stringify({ id: "a", domain: "", action: "init", payload: {} });
      expect(() => parseEnvelope(raw)).toThrow();
    });

    it("throws on missing action", () => {
      const raw = JSON.stringify({ id: "a", domain: "session", action: "", payload: {} });
      expect(() => parseEnvelope(raw)).toThrow();
    });
  });

  describe("convenience constructors", () => {
    it("createSessionInit", () => {
      const env = createSessionInit({ model: "opus", cwd: "/tmp" });
      expect(env.domain).toBe("session");
      expect(env.action).toBe("init");
      expect(env.payload).toMatchObject({ model: "opus", cwd: "/tmp" });
    });

    it("createPromptSend", () => {
      const env = createPromptSend("s1", "hello");
      expect(env.domain).toBe("session");
      expect(env.action).toBe("prompt.send");
      expect(env.payload).toEqual({
        session_id: "s1",
        text: "hello",
        message_uuid: expect.any(String),
      });
    });

    it("createPromptSend includes provider-aware attachments", () => {
      const env = createPromptSend("s1", "hello", {
        attachments: [
          { base64: "abc", fileName: "brief.pdf", kind: "document", mimeType: "application/pdf" },
        ],
      });
      expect(env.payload).toEqual({
        session_id: "s1",
        text: "hello",
        message_uuid: expect.any(String),
        attachments: [
          { base64: "abc", fileName: "brief.pdf", kind: "document", mimeType: "application/pdf" },
        ],
      });
    });

    it("createPromptSend maps a worktree branchSetup to use_worktree", () => {
      const env = createPromptSend("s1", "hello", { branchSetup: { kind: "worktree" } });
      expect(env.payload).toEqual({
        session_id: "s1",
        text: "hello",
        message_uuid: expect.any(String),
        use_worktree: true,
      });
    });

    it("createPromptSend maps a project_branch branchSetup to new_project_branch", () => {
      const withBase = createPromptSend("s1", "hello", {
        branchSetup: { kind: "project_branch", base: "develop" },
      });
      expect(withBase.payload).toEqual({
        session_id: "s1",
        text: "hello",
        message_uuid: expect.any(String),
        new_project_branch: { base: "develop" },
      });
      // A null base forks from the project's current HEAD.
      const fromHead = createPromptSend("s1", "hello", {
        branchSetup: { kind: "project_branch", base: null },
      });
      expect(fromHead.payload).toEqual({
        session_id: "s1",
        text: "hello",
        message_uuid: expect.any(String),
        new_project_branch: { base: null },
      });
    });

    it("createCommandsGet includes provider", () => {
      const env = createCommandsGet("/repo", "codex_cli");
      expect(env.domain).toBe("commands");
      expect(env.action).toBe("get");
      expect(env.payload).toEqual({ cwd: "/repo", provider: "codex_cli" });
    });

    it("createCommandsGet scopes discovery to the selected profile", () => {
      const env = createCommandsGet("/repo", "codex_cli", "work-id");
      expect(env.payload).toEqual({ cwd: "/repo", provider: "codex_cli", profile: "work-id" });
    });

    it("createPermissionRespond", () => {
      const env = createPermissionRespond("s1", "r1", "allow_once");
      expect(env.domain).toBe("session");
      expect(env.action).toBe("permission.respond");
      expect(env.payload).toEqual({ session_id: "s1", request_id: "r1", decision: "allow_once" });
    });

    it("createPermissionRespond includes native option id", () => {
      const env = createPermissionRespond("s1", "r1", "allow_once", { optionId: "codex:1" });
      expect(env.payload).toEqual({
        session_id: "s1",
        request_id: "r1",
        decision: "allow_once",
        option_id: "codex:1",
      });
    });

    it("createInterrupt", () => {
      const env = createInterrupt("s1");
      expect(env.domain).toBe("session");
      expect(env.action).toBe("interrupt");
      expect(env.payload).toEqual({ session_id: "s1" });
    });

    it("createDestroy", () => {
      const env = createDestroy("s1");
      expect(env.domain).toBe("session");
      expect(env.action).toBe("destroy");
      expect(env.payload).toEqual({ session_id: "s1" });
    });
  });
});
