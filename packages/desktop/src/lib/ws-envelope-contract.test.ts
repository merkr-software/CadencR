import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ModelSetPayload,
  PermissionRespondPayload,
  PromptSendPayload,
  SessionWarningPayload,
  WsSessionCommand,
  WsSessionEvent,
} from "@/api/generated";
import type { SessionActionName } from "@/stores/ws-session-action-names";
import {
  createEnvelope,
  createSessionEnvelope,
  createPermissionRespond,
  createPromptSend,
} from "./ws-envelope";

describe("generated session command contract", () => {
  it("derives payload types directly from the generated command union", () => {
    type Arguments = Parameters<typeof createSessionEnvelope>;
    expectTypeOf<
      Extract<Arguments, ["prompt.send", unknown]>[1]
    >().toEqualTypeOf<PromptSendPayload>();
    expectTypeOf<Extract<Arguments, ["model.set", unknown]>[1]>().toEqualTypeOf<ModelSetPayload>();
    expectTypeOf<Arguments[0]>().toEqualTypeOf<WsSessionCommand["action"]>();
    expectTypeOf<SessionActionName>().toEqualTypeOf<WsSessionEvent["action"]>();
    expectTypeOf<
      Extract<WsSessionEvent, { action: "warning" }>["payload"]
    >().toEqualTypeOf<SessionWarningPayload>();
    expectTypeOf<
      Extract<WsSessionEvent, { action: "compact.started" }>["payload"]
    >().toEqualTypeOf<null>();
    expectTypeOf<Parameters<typeof createPermissionRespond>[2]>().toEqualTypeOf<
      PermissionRespondPayload["decision"]
    >();
  });

  it("rejects typos, missing fields, and mismatched or uncorrelated action/payload pairs", () => {
    type Arguments = Parameters<typeof createSessionEnvelope>;
    expectTypeOf<["prompt.typo", PromptSendPayload]>().not.toExtend<Arguments>();
    expectTypeOf<["prompt.send", { session_id: string }]>().not.toExtend<Arguments>();
    expectTypeOf<["model.set", PromptSendPayload]>().not.toExtend<Arguments>();
    expectTypeOf<["model.set" | "prompt.send", PromptSendPayload]>().not.toExtend<Arguments>();
    expectTypeOf<"session">().not.toExtend<Parameters<typeof createEnvelope>[0]>();
  });

  it("constructs generated commands without changing their on-wire shape", () => {
    const command = {
      action: "prompt.send",
      payload: { session_id: "session", text: "hello", message_uuid: "stable-uuid" },
    } satisfies WsSessionCommand;
    expect(createSessionEnvelope(command.action, command.payload)).toEqual({
      id: expect.any(String),
      domain: "session",
      ...command,
    });
    expect(createPromptSend("session", "hello", { messageUuid: "stable-uuid" }).payload).toEqual(
      command.payload,
    );
  });
});
