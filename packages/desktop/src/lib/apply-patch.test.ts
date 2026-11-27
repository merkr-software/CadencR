import { describe, expect, it } from "vitest";
import {
  extractApplyPatchPreview,
  extractApplyPatchPreviewPartial,
  extractApplyPatchPreviews,
  extractApplyPatchPreviewsPartial,
  extractApplyPatchPrimaryPath,
  parseApplyPatchChanges,
} from "./apply-patch";

describe("parseApplyPatchChanges", () => {
  it("parses add and update file markers", () => {
    const changes = parseApplyPatchChanges(
      "*** Begin Patch\n*** Add File: src/new.ts\n+hello\n*** Update File: src/existing.ts\n@@\n-old\n+new\n*** End Patch\n",
    );

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      kind: "add",
      filePath: "src/new.ts",
      addedLines: ["hello"],
    });
    expect(changes[1]).toMatchObject({ kind: "update", filePath: "src/existing.ts" });
  });
});

describe("extractApplyPatchPrimaryPath", () => {
  it("extracts the first patched path from patchText", () => {
    expect(
      extractApplyPatchPrimaryPath({
        patchText: "*** Begin Patch\n*** Add File: toto.txt\n+hello\n*** End Patch\n",
      }),
    ).toBe("toto.txt");
  });

  it("extracts the first patched path from Codex input", () => {
    expect(
      extractApplyPatchPrimaryPath({
        input: "*** Begin Patch\n*** Add File: codex.txt\n+hello\n*** End Patch\n",
      }),
    ).toBe("codex.txt");
  });
});

describe("extractApplyPatchPreview", () => {
  it("builds a write-like preview for add file patches", () => {
    expect(
      extractApplyPatchPreview({
        patchText: "*** Begin Patch\n*** Add File: toto.txt\n+hello\n+world\n*** End Patch\n",
      }),
    ).toEqual({
      filePath: "toto.txt",
      oldContent: "",
      newContent: "hello\nworld",
    });
  });

  it("builds an edit-like preview for update patches", () => {
    expect(
      extractApplyPatchPreview({
        patchText: "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-old\n+new\n*** End Patch\n",
      }),
    ).toEqual({
      filePath: "src/foo.ts",
      oldContent: "old",
      newContent: "new",
    });
  });

  it("builds a visible create preview when add patch has no added hunk lines", () => {
    expect(
      extractApplyPatchPreview({
        patchText: "*** Begin Patch\n*** Add File: toto.txt\n*** End Patch\n",
      }),
    ).toEqual({
      filePath: "toto.txt",
      oldContent: "",
      newContent: "(file created)",
      emptyFileAction: "created",
    });
  });

  it("builds a visible delete preview when delete patch has no removed hunk lines", () => {
    expect(
      extractApplyPatchPreview({
        patchText: "*** Begin Patch\n*** Delete File: toto.txt\n*** End Patch\n",
      }),
    ).toEqual({
      filePath: "toto.txt",
      oldContent: "(file deleted)",
      emptyFileAction: "deleted",
      newContent: "",
    });
  });

  it("keeps legacy singular behavior for multi-file patches", () => {
    expect(
      extractApplyPatchPreview({
        patchText:
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-c\n+d\n*** End Patch",
      }),
    ).toBeNull();
  });
});

describe("extractApplyPatchPreviews", () => {
  it("builds previews for every file in a multi-file patchText payload", () => {
    expect(
      extractApplyPatchPreviews({
        patchText:
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old a\n+new a\n*** Update File: src/b.ts\n@@\n-old b\n+new b\n*** End Patch",
      }),
    ).toEqual([
      {
        filePath: "src/a.ts",
        oldContent: "old a",
        newContent: "new a",
      },
      {
        filePath: "src/b.ts",
        oldContent: "old b",
        newContent: "new b",
      },
    ]);
  });
});

describe("extractApplyPatchPreviewPartial", () => {
  it("returns a preview from a JSON tail missing the closing quote and brace", () => {
    const partial =
      '{"patch_text": "*** Begin Patch\\n*** Update File: src/foo.ts\\n@@\\n-old\\n+new';
    expect(extractApplyPatchPreviewPartial(partial)).toEqual({
      filePath: "src/foo.ts",
      oldContent: "old",
      newContent: "new",
    });
  });

  it("returns null when the patch_text key is absent", () => {
    expect(extractApplyPatchPreviewPartial('{"file_path":')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractApplyPatchPreviewPartial("")).toBeNull();
  });

  it("round-trips a fully complete JSON to the same result as extractApplyPatchPreview", () => {
    const args = {
      patch_text: "*** Begin Patch\n*** Add File: x.ts\n+hi\n*** End Patch\n",
    };
    const raw = JSON.stringify(args);
    expect(extractApplyPatchPreviewPartial(raw)).toEqual(extractApplyPatchPreview(args));
  });

  it("decodes escaped newlines so parseApplyPatchChanges sees real lines", () => {
    const partial = '{"patch_text":"*** Begin Patch\\n*** Add File: foo.txt\\n+a\\n+b';
    expect(extractApplyPatchPreviewPartial(partial)).toEqual({
      filePath: "foo.txt",
      oldContent: "",
      newContent: "a\nb",
    });
  });

  it("recognises the camelCase patchText key as well", () => {
    const partial = '{"patchText":"*** Begin Patch\\n*** Update File: bar.ts\\n@@\\n-x\\n+y';
    expect(extractApplyPatchPreviewPartial(partial)).toEqual({
      filePath: "bar.ts",
      oldContent: "x",
      newContent: "y",
    });
  });

  it("recognises Codex input key as patch text", () => {
    const partial = '{"input":"*** Begin Patch\\n*** Update File: input.ts\\n@@\\n-a\\n+b';
    expect(extractApplyPatchPreviewPartial(partial)).toEqual({
      filePath: "input.ts",
      oldContent: "a",
      newContent: "b",
    });
  });

  it("decodes \\uXXXX escapes inline with surrounding text", () => {
    // + == '+', - == '-' — exercises the unicode branch + surrounding runs.
    const partial =
      '{"patch_text":"*** Begin Patch\\n*** Update File: u.ts\\n@@\\n\\u002Dold\\n\\u002Bnew';
    expect(extractApplyPatchPreviewPartial(partial)).toEqual({
      filePath: "u.ts",
      oldContent: "old",
      newContent: "new",
    });
  });

  it("drops a trailing lone backslash and partial \\uXXX silently", () => {
    // Truncated `\\u00` and trailing lone `\\` must not crash or corrupt the
    // preview — the next streaming chunk will resupply the bytes.
    const truncatedUnicode =
      '{"patch_text":"*** Begin Patch\\n*** Update File: t.ts\\n@@\\n-old\\n+new\\u00';
    expect(extractApplyPatchPreviewPartial(truncatedUnicode)).toEqual({
      filePath: "t.ts",
      oldContent: "old",
      newContent: "new",
    });

    const trailingBackslash =
      '{"patch_text":"*** Begin Patch\\n*** Update File: t.ts\\n@@\\n-old\\n+new\\';
    expect(extractApplyPatchPreviewPartial(trailingBackslash)).toEqual({
      filePath: "t.ts",
      oldContent: "old",
      newContent: "new",
    });
  });

  it("keeps legacy singular behavior for multi-file patchText JSON", () => {
    const raw = JSON.stringify({
      patchText:
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-c\n+d\n*** End Patch",
    });

    expect(extractApplyPatchPreviewPartial(raw)).toBeNull();
  });
});

describe("extractApplyPatchPreviewsPartial", () => {
  it("recognises camelCase multi-file patchText JSON", () => {
    const raw = JSON.stringify({
      patchText:
        "*** Begin Patch\n*** Update File: provider_hooks.rs\n@@\n-RuntimeSlashCommand\n+RuntimeSlashCommand, RuntimeUsage\n*** Update File: turn_result.rs\n@@\n-usage: None\n+usage\n*** End Patch",
    });

    expect(extractApplyPatchPreviewsPartial(raw)).toEqual([
      {
        filePath: "provider_hooks.rs",
        oldContent: "RuntimeSlashCommand",
        newContent: "RuntimeSlashCommand, RuntimeUsage",
      },
      {
        filePath: "turn_result.rs",
        oldContent: "usage: None",
        newContent: "usage",
      },
    ]);
  });
});
