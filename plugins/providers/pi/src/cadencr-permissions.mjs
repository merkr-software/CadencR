const SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);

export default function cadencrPermissions(pi) {
  pi.on("tool_call", async (event, context) => {
    if (SAFE_TOOLS.has(event.toolName)) return;
    if (!context.hasUI || context.mode !== "rpc") {
      return {
        block: true,
        reason: "Cadencr could not request permission for this Pi tool call",
      };
    }

    const envelope = Buffer.from(
      JSON.stringify({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      }),
      "utf8",
    ).toString("base64url");
    const allowed = await context.ui.confirm(
      `Allow Pi to use ${event.toolName}?`,
      `CADENCR_PERMISSION:${envelope}`,
      { signal: context.signal },
    );
    if (!allowed) {
      return {
        block: true,
        reason: `User denied Pi tool \`${event.toolName}\``,
      };
    }
  });
}
