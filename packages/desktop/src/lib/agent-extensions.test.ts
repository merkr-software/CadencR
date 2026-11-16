import { describe, expect, it } from "vitest";
import type { ExtensionCliSummary, McpInstallOption, SkillListing } from "@/api/generated";
import {
  cliLabel,
  defaultServerName,
  isAgentExtensionKind,
  optionUnsupportedReason,
  skillCliStates,
  skillIsChangeable,
} from "./agent-extensions";

const claude: ExtensionCliSummary = {
  provider_id: "claude_code",
  label: "Claude",
  installed: true,
  version: "2.1.312",
  support: {
    mcp_transports: ["stdio", "http", "sse"],
    mcp_headers: true,
    skills: true,
    skill_update: true,
  },
};
const codex: ExtensionCliSummary = {
  provider_id: "codex_cli",
  label: "Codex CLI",
  installed: true,
  version: "0.165.0",
  support: {
    mcp_transports: ["stdio", "http"],
    mcp_headers: false,
    skills: true,
    skill_update: false,
  },
};

function option(overrides: Partial<McpInstallOption>): McpInstallOption {
  return {
    kind: "remote",
    transport: "http",
    summary: "https://x.example.com/mcp",
    identifier: null,
    version: null,
    url: "https://x.example.com/mcp",
    inputs: [],
    ...overrides,
  };
}

describe("agent extensions", () => {
  it("names a registry server after its last segment", () => {
    expect(defaultServerName("io.github.ChromeDevTools/chrome-devtools-mcp")).toBe(
      "chrome-devtools-mcp",
    );
    expect(defaultServerName("ai.smithery/@weird name!")).toBe("weird-name-");
    expect(defaultServerName("///")).toBe("mcp-server");
    expect(isAgentExtensionKind("mcp")).toBe(true);
    expect(isAgentExtensionKind("theme")).toBe(false);
  });

  it("explains which CLI cannot carry an option", () => {
    expect(optionUnsupportedReason(claude, option({ transport: "sse" }))).toBeNull();
    expect(optionUnsupportedReason(codex, option({ transport: "sse" }))).toMatch(/SSE/);
    const headers = option({
      inputs: [
        {
          key: "header:Authorization",
          kind: "header",
          label: "Authorization",
          required: true,
          secret: true,
        },
      ],
    });
    expect(optionUnsupportedReason(codex, headers)).toMatch(/headers/);
    const optional = option({
      inputs: [{ ...headers.inputs[0], required: false }],
    });
    expect(optionUnsupportedReason(codex, optional)).toBeNull();
    expect(
      optionUnsupportedReason(codex, optional, { "header:Authorization": "Bearer x" }),
    ).toMatch(/headers/);
    expect(optionUnsupportedReason({ ...claude, installed: false }, headers)).toMatch(
      /not installed/,
    );
  });

  it("pairs every skill-capable CLI with its offer and installs", () => {
    const listing: SkillListing = {
      key: "figma",
      name: "figma",
      offers: [
        {
          provider_id: "codex_cli",
          plugin_id: "figma@openai",
          marketplace: "openai",
        },
      ],
      installed: [
        {
          provider_id: "claude_code",
          id: "figma@official",
          name: "figma",
          source: "plugin",
        },
      ],
    };
    const states = skillCliStates(listing, [claude, codex]);
    expect(states.map((state) => [state.installed.length, !!state.offer])).toEqual([
      [1, false],
      [0, true],
    ]);
  });
});

describe("skillIsChangeable", () => {
  it("only lets Cadencr change user-scope marketplace packs", () => {
    expect(skillIsChangeable({ source: "plugin", scope: "user" })).toBe(true);
    expect(skillIsChangeable({ source: "plugin", scope: null })).toBe(true);
    expect(skillIsChangeable({ source: "plugin", scope: "project" })).toBe(false);
    expect(skillIsChangeable({ source: "local", scope: null })).toBe(false);
  });
});

describe("cliLabel", () => {
  it("falls back to the provider id for a CLI the list lacks", () => {
    expect(cliLabel([claude, codex], "codex_cli")).toBe("Codex CLI");
    expect(cliLabel([claude], "opencode")).toBe("opencode");
  });
});
