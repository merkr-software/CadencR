import { describe, expect, it } from "vitest";
import { fixedRowLines, hasOpenTodos, rowLayout } from "@/lib/sidebar-row-summary";

const options = {
  compactRows: false,
  uniformRows: true,
  titleLines: "one",
  rowHeight: "auto",
  preview: "none",
  todos: false,
  pendingRequest: true,
  branch: false,
  diff: true,
  pr: true,
  ports: true,
  activity: true,
  label: "chip",
  provider: "logo",
} as const;

describe("rowLayout", () => {
  it("folds the details beside a one-line title", () => {
    expect(rowLayout(options, "idle", false)).toEqual({
      compact: false,
      foldMeta: true,
      showsPreview: false,
      showsTodos: false,
      fixed: false,
      holdsNowLine: false,
      holdsCodeLane: false,
      holdsActivityLane: false,
    });
  });

  it("keeps the details on their own line for two-line titles and label edits", () => {
    expect(rowLayout({ ...options, titleLines: "two" }, "idle", false).foldMeta).toBe(false);
    expect(rowLayout(options, "idle", true).foldMeta).toBe(false);
    expect(rowLayout({ ...options, uniformRows: false }, "idle", false).foldMeta).toBe(false);
  });

  it("grows a compact row back while its conversation waits", () => {
    const compact = { ...options, compactRows: true };
    expect(rowLayout(compact, "working", false).compact).toBe(true);
    expect(rowLayout(compact, "unread", false).compact).toBe(true);
    expect(rowLayout(compact, "waiting", false).compact).toBe(false);
  });

  it("shows the preview and todos only when asked to, never on a compact row", () => {
    const both = { ...options, preview: "last_message", todos: true } as const;
    expect(rowLayout(both, "idle", false)).toMatchObject({ showsPreview: true, showsTodos: true });
    expect(rowLayout({ ...both, compactRows: true }, "idle", false)).toMatchObject({
      showsPreview: false,
      showsTodos: false,
    });
  });

  it("gives the preview's line to a pending request", () => {
    const preview = { ...options, preview: "last_message" } as const;
    expect(rowLayout(preview, "waiting", false).showsPreview).toBe(false);
    expect(rowLayout({ ...preview, pendingRequest: false }, "waiting", false).showsPreview).toBe(
      true,
    );
  });
});

describe("rowLayout with a fixed row height", () => {
  const fixed = {
    ...options,
    rowHeight: "fixed",
    uniformRows: false,
    preview: "last_message",
  } as const;

  it("holds the reply, code and activity lines on every row", () => {
    for (const state of ["idle", "working", "waiting", "unread"] as const) {
      expect(rowLayout(fixed, state, false)).toMatchObject({
        fixed: true,
        foldMeta: false,
        showsPreview: true,
        holdsNowLine: true,
        holdsCodeLane: true,
        holdsActivityLane: true,
      });
    }
  });

  it("holds only the lines the options can fill", () => {
    const noCode = { ...fixed, diff: false, pr: false } as const;
    expect(rowLayout(noCode, "idle", false)).toMatchObject({
      holdsCodeLane: false,
      holdsActivityLane: true,
    });
    expect(rowLayout({ ...noCode, branch: true }, "idle", false).holdsCodeLane).toBe(true);
    const noActivity = { ...fixed, ports: false, activity: false, label: "hidden" } as const;
    expect(rowLayout(noActivity, "idle", false)).toMatchObject({
      holdsCodeLane: true,
      holdsActivityLane: false,
    });
    expect(
      rowLayout({ ...noActivity, provider: "logo_model" }, "idle", false).holdsActivityLane,
    ).toBe(true);
  });

  it("puts the details beside the title without a reply to fill the lines", () => {
    for (const editing of [false, true]) {
      expect(rowLayout({ ...fixed, preview: "none" }, "waiting", editing)).toMatchObject({
        foldMeta: true,
        holdsNowLine: false,
        holdsCodeLane: false,
        holdsActivityLane: false,
      });
    }
  });

  it("keeps the details beside a uniform title, two-line option or not", () => {
    const uniform = { ...fixed, uniformRows: true, titleLines: "two" } as const;
    expect(rowLayout(uniform, "idle", false)).toMatchObject({
      foldMeta: true,
      holdsNowLine: true,
      holdsCodeLane: false,
      holdsActivityLane: false,
    });
  });

  it("never grows a compact row back", () => {
    const compact = rowLayout({ ...fixed, compactRows: true }, "waiting", false);
    expect(compact).toMatchObject({
      compact: true,
      holdsNowLine: false,
      holdsCodeLane: false,
      holdsActivityLane: false,
    });
  });
});

describe("fixedRowLines", () => {
  const layout = rowLayout(
    { ...options, rowHeight: "fixed", uniformRows: false, preview: "last_message" },
    "idle",
    false,
  );
  const bare = {
    namesNextAction: false,
    asks: false,
    code: false,
    activity: false,
    editingLabel: false,
  };

  it("wraps the reply over every line the details leave", () => {
    expect(fixedRowLines(layout, bare).replyLines).toBe(3);
    expect(fixedRowLines(layout, { ...bare, code: true }).replyLines).toBe(2);
    expect(fixedRowLines(layout, { ...bare, code: true, activity: true })).toEqual({
      asks: false,
      code: true,
      activity: true,
      replyLines: 1,
    });
  });

  it("gives a request and a next action lines of their own", () => {
    expect(fixedRowLines(layout, { ...bare, asks: true, code: true }).replyLines).toBe(1);
    // The next action names the request itself, and comes on a line the options add.
    expect(fixedRowLines(layout, { ...bare, namesNextAction: true, asks: true })).toEqual({
      asks: false,
      code: false,
      activity: false,
      replyLines: 3,
    });
  });

  it("lends a label being edited a line when the options hold no activity line", () => {
    const noActivity = rowLayout(
      {
        ...options,
        rowHeight: "fixed",
        uniformRows: false,
        preview: "last_message",
        ports: false,
        activity: false,
        todos: false,
        label: "hidden",
        provider: "logo",
      },
      "waiting",
      true,
    );
    expect(noActivity.holdsActivityLane).toBe(false);
    const editing = { ...bare, activity: true, editingLabel: true };
    expect(fixedRowLines(noActivity, editing)).toEqual({
      asks: false,
      code: false,
      activity: true,
      replyLines: 1,
    });
    // No reply line to spare: the editor takes the request's.
    expect(fixedRowLines(noActivity, { ...editing, code: true, asks: true })).toEqual({
      asks: false,
      code: true,
      activity: true,
      replyLines: 0,
    });
  });

  it("drops what the options hold no line for", () => {
    const uniform = rowLayout(
      { ...options, rowHeight: "fixed", preview: "last_message" },
      "idle",
      false,
    );
    expect(fixedRowLines(uniform, { ...bare, code: true, activity: true })).toEqual({
      asks: false,
      code: false,
      activity: false,
      replyLines: 1,
    });
  });
});

describe("hasOpenTodos", () => {
  it("counts a list only while some todos are left", () => {
    expect(hasOpenTodos({ done: 3, total: 7 })).toBe(true);
    expect(hasOpenTodos({ done: 7, total: 7 })).toBe(false);
    expect(hasOpenTodos({ done: 0, total: 0 })).toBe(false);
    expect(hasOpenTodos(null)).toBe(false);
  });
});
