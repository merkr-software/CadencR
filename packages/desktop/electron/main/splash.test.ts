import { uiI18n } from "../../src/shared/ui-i18n";
import { buildStartupRecovery } from "./startup-recovery";
import { splashProgressDetail } from "./splash-progress";
import { describe, expect, it } from "vitest";
import { renderSplashHtml } from "./splash";
import { splashCopyForPhase } from "./splash-copy";

describe("splashCopyForPhase", () => {
  it("preserves the original neutral copy while waiting for the development service", () => {
    expect(splashCopyForPhase("waiting_for_service")).toEqual({
      title: "Starting Cadencr",
      detail: "Preparing the workspace…",
    });
    expect(splashCopyForPhase("waiting_for_service")).toEqual(splashCopyForPhase("starting"));
  });

  it("explains the exact lossless storage operation when the service reports it", () => {
    expect(splashCopyForPhase("optimizing_storage")).toEqual({
      title: "Optimizing conversation storage",
      detail: expect.stringContaining("Conversations are preserved"),
    });
  });
});

describe("renderSplashHtml", () => {
  it("announces startup status while keeping a single activity animation", () => {
    const html = renderSplashHtml("0.11.0");

    expect(html).toContain('role="status" aria-live="polite"');
    expect(html.match(/@keyframes/g)).toHaveLength(1);
  });

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

describe("startup progress language", () => {
  it("localizes a structured heartbeat and preserves the diagnostic for recovery", async () => {
    const progress =
      '@progress {"operation":{"step":"create_backup","bytes":1610612736},"elapsed":125}';
    expect(splashProgressDetail(progress)).toBe(
      "Creating a 1.5 GB safety copy before applying database updates. Elapsed: 2m 05s.",
    );
    const language = uiI18n.language;
    try {
      await uiI18n.changeLanguage("cimode");
      expect(splashProgressDetail(progress)).toBe("system.startup.elapsed");
      expect(renderSplashHtml("0.16")).toContain('<html lang="cimode">');
      expect(renderSplashHtml("0.16")).toContain("system.startup.starting.title");
      const failure = "Erreur SQL /tmp/échantillon: disk I/O error";
      expect(splashProgressDetail(failure)).toBe(failure);
      expect(splashProgressDetail("@progress invalid")).toBe("@progress invalid");
      const diagnostic = "This database was updated by a newer version of Cadencr";
      const recovery = buildStartupRecovery({
        appVersion: "0.16",
        getDbPath: () => "",
        message: diagnostic,
        now: new Date(0),
        platform: "darwin",
      });
      expect(recovery.title).toBe("system.recovery.newerTitle");
      expect(recovery.actions.map((action) => action.id)).toContain("download_latest");
      expect(recovery.diagnostics).toContain(diagnostic);
    } finally {
      await uiI18n.changeLanguage(language);
    }
  });
});
