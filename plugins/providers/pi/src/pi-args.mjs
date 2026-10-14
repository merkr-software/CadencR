const CONNECTOR_OWNED_FLAGS = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--",
  "--mode",
  "--print",
  "-p",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--fork",
  "--no-session",
]);

export function validatePiArgs(args) {
  if (!Array.isArray(args)) throw new Error("Pi arguments must be an array");
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("Pi arguments must be strings");
    const flag = arg.split("=", 1)[0];
    if (CONNECTOR_OWNED_FLAGS.has(flag)) {
      throw new Error(`Pi argument \`${arg}\` conflicts with the connector`);
    }
  }
  return args;
}

export function runtimeArgs(extraArgs, extensionPath, resumeSessionId) {
  validatePiArgs(extraArgs);
  const sessionArgs = resumeSessionId ? ["--session", resumeSessionId] : [];
  return ["--mode", "rpc", ...sessionArgs, "--approve", "--extension", extensionPath, ...extraArgs];
}
