import { create } from "zustand";
import { desktopBridge, type UpdateEvent } from "@/lib/desktop-bridge";
import { apiErrorMessage } from "@/lib/api-errors";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  /**
   * In-app updates are disabled for an unrecognized/custom Linux install.
   * Official AppImage, DEB, and RPM packages all use electron-updater.
   */
  | "unsupported";

interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  /** Markdown body fetched from the GitHub release, or `null` if not yet/never available. */
  changelogMarkdown: string | null;
  /** True while the main process is fetching the changelog for `version` from GitHub. */
  changelogLoading: boolean;
  /** Download percent, 0–100. */
  progress: number;
  error: string | null;
  /** Human-readable explanation when `status === "unsupported"`. */
  unsupportedMessage: string | null;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  applyEvent: (event: UpdateEvent) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: "idle",
  version: null,
  changelogMarkdown: null,
  changelogLoading: false,
  progress: 0,
  error: null,
  unsupportedMessage: null,
  checkForUpdates: async () => {
    set({ status: "checking", error: null });
    try {
      await desktopBridge.checkForUpdates();
    } catch (err) {
      set({ status: "error", error: apiErrorMessage(err, String(err)) });
    }
  },
  installUpdate: async () => {
    try {
      await desktopBridge.installUpdate();
    } catch (err) {
      set({ status: "error", error: apiErrorMessage(err, String(err)) });
    }
  },
  applyEvent: (event) => {
    switch (event.kind) {
      case "checking":
        set({ status: "checking", error: null });
        return;
      case "available":
        set({
          status: "downloading",
          version: event.version,
          changelogMarkdown: null,
          changelogLoading: true,
          progress: 0,
          error: null,
        });
        return;
      case "changelog":
        // Ignore stale changelogs that arrive after the user moved on to a
        // different update cycle.
        set((prev) =>
          prev.version === event.version
            ? { changelogMarkdown: event.markdown, changelogLoading: false }
            : prev,
        );
        return;
      case "not-available":
        set({ status: "up-to-date", version: event.version, error: null });
        return;
      case "download-progress":
        set({ status: "downloading", progress: event.percent, error: null });
        return;
      case "downloaded":
        set({ status: "downloaded", version: event.version, progress: 100, error: null });
        return;
      case "error":
        set({ status: "error", error: event.message });
        return;
      case "unsupported":
        // Init-time announce + every check-for-updates call both fire this,
        // so the same payload can arrive multiple times. Returning `prev`
        // unchanged short-circuits Zustand's subscriber notification.
        set((prev) =>
          prev.status === "unsupported" && prev.unsupportedMessage === event.message
            ? prev
            : { ...prev, status: "unsupported", unsupportedMessage: event.message, error: null },
        );
        return;
    }
  },
}));
