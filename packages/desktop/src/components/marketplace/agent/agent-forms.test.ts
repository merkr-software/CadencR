import { describe, expect, it } from "vitest";
import type { McpInstallOption } from "@/api/generated";
import { actionKey } from "./AgentExtensionActions";
import { missingInputs, SERVER_NAME_PATTERN } from "./McpInstallForm";

const option: McpInstallOption = {
  kind: "npm",
  transport: "stdio",
  summary: "npx -y acme@1.0.0",
  identifier: "acme",
  version: "1.0.0",
  inputs: [
    { key: "env:TOKEN", kind: "env", label: "TOKEN", required: true, secret: true },
    {
      key: "env:REGION",
      kind: "env",
      label: "REGION",
      required: true,
      secret: false,
      default: "eu",
    },
    { key: "arg:0", kind: "argument", label: "path", required: false, secret: false },
  ],
};

describe("MCP install form", () => {
  it("asks only for required values without a default", () => {
    expect(missingInputs(option, {}).map((input) => input.key)).toEqual(["env:TOKEN"]);
    expect(missingInputs(option, { "env:TOKEN": "  " })).toHaveLength(1);
    expect(missingInputs(option, { "env:TOKEN": "t" })).toHaveLength(0);
  });

  it("accepts server names every CLI takes", () => {
    expect(SERVER_NAME_PATTERN.test("chrome-devtools")).toBe(true);
    expect(SERVER_NAME_PATTERN.test("-flag")).toBe(false);
    expect(SERVER_NAME_PATTERN.test("has space")).toBe(false);
  });
});

describe("agent extension actions", () => {
  it("keys a change by CLI and target, so CLIs never block each other", () => {
    const base = { label: "Acme", cliLabel: "Claude" };
    expect(
      actionKey({
        ...base,
        kind: "mcp-install",
        request: {
          provider_id: "claude_code",
          registry_name: "a/acme",
          option: 0,
          server_name: "acme",
        },
      }),
    ).toBe(
      actionKey({ ...base, kind: "mcp-remove", providerId: "claude_code", serverName: "acme" }),
    );
    expect(
      actionKey({ ...base, kind: "skill-install", providerId: "codex_cli", pluginId: "acme@m" }),
    ).not.toBe(
      actionKey({ ...base, kind: "skill-install", providerId: "claude_code", pluginId: "acme@m" }),
    );
  });
});
