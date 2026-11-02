import { describe, it, expect } from "vitest";
import { buildResumeCommand } from "./provider-resume-command";

// The templates the built-in adapters declare in the catalog (`resume_command`).
const CLAUDE = { program: "claude", args: ["--resume", "{session_id}"] };
const OPENCODE = { program: "opencode", args: ["--session", "{session_id}"] };
const CODEX = { program: "codex", args: ["resume", "{session_id}"] };

describe("buildResumeCommand", () => {
  it("builds the Claude resume command with cwd", () => {
    const result = buildResumeCommand({
      resumeCommand: CLAUDE,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/home/user/project",
    });
    expect(result.supported).toBe(true);
    expect(result.command).toBe(
      'cd "/home/user/project" && claude --resume "11111111-1111-4111-8111-111111111111"',
    );
  });

  it("omits cd when cwd is missing", () => {
    const result = buildResumeCommand({
      resumeCommand: CLAUDE,
      sessionId: "abc",
      cwd: undefined,
    });
    expect(result.command).toBe('claude --resume "abc"');
    expect(result.supported).toBe(true);
  });

  it("escapes double quotes in cwd", () => {
    const result = buildResumeCommand({
      resumeCommand: CLAUDE,
      sessionId: "abc",
      cwd: '/tmp/weird"dir',
    });
    expect(result.command).toBe('cd "/tmp/weird\\"dir" && claude --resume "abc"');
  });

  it("escapes shell metacharacters in resume ids", () => {
    const result = buildResumeCommand({
      resumeCommand: CODEX,
      sessionId: 'abc"; echo $HOME `pwd`',
      cwd: "/tmp",
    });
    expect(result.command).toBe('cd "/tmp" && codex resume "abc\\"; echo \\$HOME \\`pwd\\`"');
  });

  it("builds the OpenCode resume command with the --session flag", () => {
    const result = buildResumeCommand({
      resumeCommand: OPENCODE,
      sessionId: "ses_abc123",
      cwd: "/home/user/project",
    });
    expect(result.command).toBe('cd "/home/user/project" && opencode --session "ses_abc123"');
  });

  it("builds the Codex resume command", () => {
    const result = buildResumeCommand({
      resumeCommand: CODEX,
      sessionId: "abc",
      cwd: "/tmp",
    });
    expect(result.command).toBe('cd "/tmp" && codex resume "abc"');
  });

  it("builds an installed provider's declared resume command", () => {
    const result = buildResumeCommand({
      resumeCommand: { program: "agent", args: ["--resume", "{session_id}"] },
      sessionId: "chat-123",
      cwd: "/tmp/project",
    });
    expect(result.supported).toBe(true);
    expect(result.command).toBe('cd "/tmp/project" && agent --resume "chat-123"');
  });

  it("substitutes the placeholder inside an argument and quotes unsafe literals", () => {
    const result = buildResumeCommand({
      resumeCommand: {
        program: "acme",
        args: ["--session={session_id}", "two words", "$X"],
      },
      sessionId: "s1",
      cwd: undefined,
    });
    expect(result.command).toBe('acme "--session=s1" "two words" "\\$X"');
  });

  it("marks providers without a declared resume command as unsupported", () => {
    for (const resumeCommand of [undefined, null]) {
      const result = buildResumeCommand({
        resumeCommand,
        sessionId: "abc",
        cwd: "/tmp",
      });
      expect(result).toEqual({ command: "", supported: false });
    }
  });
});
