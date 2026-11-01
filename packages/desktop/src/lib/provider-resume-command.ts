import type { ProviderResumeCommand } from "@/api/generated";

export interface ResumeCommandInput {
  /** The provider's catalog-declared resume command; absent = unsupported. */
  resumeCommand: ProviderResumeCommand | null | undefined;
  sessionId: string;
  cwd: string | undefined;
}

export interface ResumeCommandResult {
  command: string;
  supported: boolean;
}

const SESSION_ID_PLACEHOLDER = "{session_id}";
/** Tokens a POSIX shell reads literally, emitted bare to keep commands readable. */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._:/=@%+-]+$/;

function quote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")}"`;
}

function withCd(command: string, cwd: string | undefined): string {
  return cwd ? `cd ${quote(cwd)} && ${command}` : command;
}

function literalToken(token: string): string {
  return SHELL_SAFE_TOKEN.test(token) ? token : quote(token);
}

/** An argument carrying the session id is always quoted: the id is runtime data. */
function argToken(arg: string, sessionId: string): string {
  if (!arg.includes(SESSION_ID_PLACEHOLDER)) return literalToken(arg);
  return quote(arg.split(SESSION_ID_PLACEHOLDER).join(sessionId));
}

/**
 * Shell command that resumes `sessionId` in a terminal, from the provider's
 * declared `{program, args}` template (built-ins and installed providers
 * alike), prefixed with `cd <cwd> &&` when the directory is known.
 */

export function buildResumeCommand({
  resumeCommand,
  sessionId,
  cwd,
}: ResumeCommandInput): ResumeCommandResult {
  if (!resumeCommand)
    return {
      command: "",
      supported: false,
    };
  const tokens = [
    literalToken(resumeCommand.program),
    ...resumeCommand.args.map((arg) => argToken(arg, sessionId)),
  ];
  return { command: withCd(tokens.join(" "), cwd), supported: true };
}
