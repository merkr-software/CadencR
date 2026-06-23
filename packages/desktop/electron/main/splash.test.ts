import { describe, expect, it } from "vitest";
import { renderSplashHtml } from "./splash";

describe("renderSplashHtml", () => {
  it("renders recovery action links without an open-folder action", () => {
    const html = renderSplashHtml("0.6.1", {
      title: "Cadencr can't open this database safely",
      detail: "Install the latest version to continue.",
      actions: [
        { id: "download_latest", label: "Download latest Cadencr", primary: true },
        { id: "copy_diagnostics", label: "Copy diagnostics" },
        { id: "quit", label: "Quit" },
      ],
    });

    expect(html).toContain("Cadencr can't open this database safely");
    expect(html).toContain("Download latest Cadencr");
    expect(html).toContain('href="cadencr-splash://action/download_latest"');
    expect(html).toContain("Copy diagnostics");
    expect(html).toContain("Quit");
    expect(html).not.toContain("Open data folder");
  });

  it("keeps long startup errors accessible with a scrollable detail area", () => {
    const html = renderSplashHtml("0.6.1", {
      title: "Cadencr can't open this database safely",
      detail:
        "This is a long startup error that must remain readable even when recovery actions are visible. ".repeat(
          8,
        ),
      actions: [{ id: "copy_diagnostics", label: "Copy diagnostics" }],
    });

    expect(html).toContain("overflow-y: auto");
    expect(html).toContain("max-height:");
    expect(html).not.toContain("-webkit-line-clamp");
  });
});
