import { translateUi as t } from "../../src/shared/ui-i18n";

export const browserLibraryErrors = {
  bookmarkLimit: (limit: number) =>
    t("workspace.browser.bookmarks.limit", "Browser bookmarks are limited to {{limit}} entries.", {
      limit,
    }),
  fileTooLarge: () =>
    t("workspace.browser.library.fileTooLarge", "Browser library file exceeds its size limit."),
  invalidData: () =>
    t(
      "workspace.browser.library.invalidData",
      "Browser history and bookmarks could not be read: invalid data.",
    ),
  storageLimit: () =>
    t(
      "workspace.browser.library.storageLimit",
      "Browser history and bookmarks exceed their storage limit.",
    ),
  bookmarkStorageFull: () =>
    t(
      "workspace.browser.bookmarks.storageFull",
      "Browser bookmark storage is full. Remove a bookmark before saving another.",
    ),
  unsupportedData: () =>
    t(
      "workspace.browser.library.unsupportedData",
      "Browser history and bookmarks could not be read: unsupported data.",
    ),
  historyAddressTooLong: (limit: number) =>
    t(
      "workspace.browser.history.addressTooLong",
      "Page could not be saved to recent history: address exceeds {{limit}} characters.",
      { limit },
    ),
  bookmarkAddressTooLong: (limit: number) =>
    t(
      "workspace.browser.bookmarks.addressTooLong",
      "Page could not be bookmarked: address exceeds {{limit}} characters.",
      { limit },
    ),
  invalidUrl: () =>
    t(
      "workspace.browser.history.invalidUrl",
      "Only valid HTTP or HTTPS pages can be saved to browser history.",
    ),
  unsupportedUrl: () =>
    t(
      "workspace.browser.history.unsupportedUrl",
      "Only HTTP or HTTPS pages can be saved to browser history.",
    ),
  invalidEntry: () =>
    t(
      "workspace.browser.library.invalidEntry",
      "Browser history and bookmarks could not be read: invalid entry.",
    ),
};
