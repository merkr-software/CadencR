import { describe, expect, it } from "vitest";
import {
  extractBashOutput,
  extractBashCommand,
  extractTaskOutput,
  isToolCallRunning,
  isToolCallError,
  extractInlineDiffPreview,
  extractInlineDiffPreviews,
  isFileChangeTool,
  isStructuredBashPayload,
  normalizeToolName,
} from "./tool-adapter";

describe("normalizeToolName", () => {
  it("normalizes apply_patch aliases to ApplyPatch", () => {
    expect(normalizeToolName("apply_patch")).toBe("ApplyPatch");
    expect(normalizeToolName("ApplyPatch")).toBe("ApplyPatch");
    expect(normalizeToolName("Patch")).toBe("ApplyPatch");
  });
});

describe("extractBashCommand", () => {
  it("joins array commands from Codex payloads", () => {
    expect(extractBashCommand(JSON.stringify({ command: ["pnpm", "test"] }))).toBe("pnpm test");
  });
});

describe("isFileChangeTool", () => {
  it("treats ApplyPatch alias as file-changing", () => {
    expect(isFileChangeTool("apply_patch")).toBe(true);
    expect(isFileChangeTool("ApplyPatch")).toBe(true);
    expect(isFileChangeTool("Patch")).toBe(true);
    expect(isFileChangeTool("Read")).toBe(false);
  });
});

describe("extractBashOutput", () => {
  it("extracts Codex command output from structured Bash payloads", () => {
    expect(
      extractBashOutput(
        JSON.stringify({
          command: "/bin/zsh -lc 'ls -l package.json'",
          cwd: "/repo",
          output: "-rw-r--r-- package.json\n",
          status: "completed",
        }),
      ),
    ).toBe("-rw-r--r-- package.json\n");
  });

  it("extracts generic output field", () => {
    expect(extractBashOutput(JSON.stringify({ command: "pwd", output: "/tmp/project\n" }))).toBe(
      "/tmp/project\n",
    );
  });

  it("extracts structured stdout output", () => {
    expect(extractBashOutput(JSON.stringify({ output: { stdout: "ok\n", stderr: "" } }))).toBe(
      "ok\n",
    );
  });

  it("extracts top-level stdout and stderr", () => {
    expect(
      extractBashOutput(
        JSON.stringify({ exitCode: 0, stdout: "lint passed\n", stderr: "$ pnpm lint\n" }),
      ),
    ).toBe("lint passed\n$ pnpm lint\n");
  });

  it("shows stderr when stdout is empty", () => {
    expect(
      extractBashOutput(JSON.stringify({ exitCode: 0, stdout: "", stderr: "$ tsc --noEmit\n" })),
    ).toBe("$ tsc --noEmit\n");
  });

  it("extracts legacy persisted OpenCode output fields", () => {
    expect(
      extractBashOutput(
        JSON.stringify({
          command: "pnpm test",
          __opencode_output: "legacy output\n",
        }),
      ),
    ).toBe("legacy output\n");
  });
});

describe("isStructuredBashPayload", () => {
  it("detects Codex Bash payloads even when output is null", () => {
    expect(
      isStructuredBashPayload(
        JSON.stringify({
          command: "sed -n '1,160p' .zed/settings.json",
          output: null,
          status: "completed",
        }),
      ),
    ).toBe(true);
  });

  it("detects commandActions-only Bash payloads", () => {
    expect(isStructuredBashPayload(JSON.stringify({ commandActions: ["read: src/main.ts"] }))).toBe(
      true,
    );
  });

  it("does not treat plain tool result text as structured Bash payload", () => {
    expect(isStructuredBashPayload("line1\nline2")).toBe(false);
  });
});

describe("extractTaskOutput", () => {
  it("extracts tagged task results from persisted output", () => {
    expect(
      extractTaskOutput(
        JSON.stringify({
          output: "task_id: ses_123\n\n<task_result>Top finding</task_result>",
        }),
      ),
    ).toBe("Top finding");
  });

  it("supports structured output payloads", () => {
    expect(extractTaskOutput(JSON.stringify({ output: { text: "Structured finding" } }))).toBe(
      "Structured finding",
    );
  });
});

describe("isToolCallRunning", () => {
  it("treats missing status as running", () => {
    expect(isToolCallRunning(JSON.stringify({ command: "ls" }))).toBe(true);
  });

  it("treats completed status as not running", () => {
    expect(isToolCallRunning(JSON.stringify({ status: "completed" }))).toBe(false);
  });

  it("reads legacy persisted OpenCode status fields", () => {
    expect(isToolCallRunning(JSON.stringify({ __opencode_status: "completed" }))).toBe(false);
  });
});

describe("isToolCallError", () => {
  it("recognizes a failed Cadencr-managed Bash payload", () => {
    expect(isToolCallError(JSON.stringify({ status: "failed" }))).toBe(true);
    expect(isToolCallError(JSON.stringify({ status: "completed" }))).toBe(false);
  });
});

describe("extractInlineDiffPreview", () => {
  it("extracts Codex ApplyPatch previews from patch fields", () => {
    expect(
      extractInlineDiffPreview(
        "ApplyPatch",
        JSON.stringify({
          patch_text: "*** Begin Patch\n*** Add File: src/codex.txt\n+hello codex\n*** End Patch\n",
        }),
      ),
    ).toEqual({
      filePath: "src/codex.txt",
      oldContent: "",
      newContent: "hello codex",
    });
  });

  it("extracts patch preview from apply_patch args", () => {
    expect(
      extractInlineDiffPreview(
        "apply_patch",
        JSON.stringify({
          patch_text: "*** Begin Patch\n*** Add File: toto.txt\n+hello\n*** End Patch\n",
        }),
      ),
    ).toEqual({
      filePath: "toto.txt",
      oldContent: "",
      newContent: "hello",
    });
  });

  it("extracts update preview from ApplyPatch args", () => {
    expect(
      extractInlineDiffPreview(
        "ApplyPatch",
        JSON.stringify({
          patch_text:
            "*** Begin Patch\n*** Update File: /workspace/toto.txt\n@@\n-Hello Cadencr\n+Hello Cadencr 2\n*** End Patch",
        }),
      ),
    ).toEqual({
      filePath: "/workspace/toto.txt",
      oldContent: "Hello Cadencr",
      newContent: "Hello Cadencr 2",
    });
  });

  it("extracts update preview from canonical ApplyPatch args", () => {
    expect(
      extractInlineDiffPreview(
        "ApplyPatch",
        JSON.stringify({
          patch_text:
            "*** Begin Patch\n*** Update File: /workspace/toto.txt\n@@\n-before\n+after\n*** End Patch",
        }),
      ),
    ).toEqual({
      filePath: "/workspace/toto.txt",
      oldContent: "before",
      newContent: "after",
    });
  });

  it("extracts every OpenCode ApplyPatch preview from multi-file patchText args", () => {
    expect(
      extractInlineDiffPreviews(
        "ApplyPatch",
        JSON.stringify({
          patchText:
            "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-c\n+d\n*** End Patch",
        }),
      ),
    ).toEqual([
      { filePath: "src/a.ts", oldContent: "a", newContent: "b" },
      { filePath: "src/b.ts", oldContent: "c", newContent: "d" },
    ]);
  });

  it("keeps singular ApplyPatch preview behavior for multi-file patchText args", () => {
    expect(
      extractInlineDiffPreview(
        "ApplyPatch",
        JSON.stringify({
          patchText:
            "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-c\n+d\n*** End Patch",
        }),
      ),
    ).toBeNull();
  });

  it("falls back to the partial extractor for streaming ApplyPatch JSON", () => {
    // Truncated mid-string — JSON.parse fails, but the tolerant extractor
    // can still surface the partial diff so the inline view doesn't stay blank
    // for the duration of the stream.
    const partial =
      '{"patch_text": "*** Begin Patch\\n*** Update File: src/foo.ts\\n@@\\n-old\\n+new';
    expect(extractInlineDiffPreview("ApplyPatch", partial)).toEqual({
      filePath: "src/foo.ts",
      oldContent: "old",
      newContent: "new",
    });
  });

  it("returns null for non-ApplyPatch tools when args are unparseable", () => {
    expect(extractInlineDiffPreview("Edit", '{"file_path":')).toBeNull();
  });
});
