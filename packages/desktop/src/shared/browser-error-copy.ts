import type { BrowserFailure, BrowserTabError } from "./browser-types";
import type { translateUi } from "./ui-i18n";

type ErrorCopy = Pick<BrowserTabError, "title" | "description">;

/** The bridge also carries a human-readable fallback for clients that only display text. */
export function localizedBrowserError(
  error: ErrorCopy & { failure?: BrowserFailure },
  t: typeof translateUi,
): ErrorCopy {
  return error.failure ? browserFailureCopy(error.failure, t, error.description) : error;
}

export function browserFailureCopy(
  failure: BrowserFailure,
  t: typeof translateUi,
  detail = "",
): ErrorCopy {
  const host = "host" in failure ? failure.host : undefined;
  return failureMessages[failure.reason](t, host, detail);
}

type FailureMessage = (
  t: typeof translateUi,
  host: string | undefined,
  detail: string,
) => ErrorCopy;

const failureMessages: Record<BrowserFailure["reason"], FailureMessage> = {
  localRefused: (t, host) => ({
    title: t("workspace.browser.error.localRefused.title", "Can't connect to {{host}}", {
      host: host || t("workspace.browser.error.thisSite", "this site"),
    }),
    description: t(
      "workspace.browser.error.localRefused.description",
      "Nothing is listening on this port. Make sure your dev server is running.",
    ),
  }),
  refused: (t, host) => ({
    title: t("workspace.browser.error.refused.title", "This site can't be reached"),
    description: t("workspace.browser.error.refused.description", "{{host}} refused to connect.", {
      host: host || t("workspace.browser.error.thisSite", "this site"),
    }),
  }),
  notFound: (t, host) => ({
    title: t("workspace.browser.error.notFound.title", "Site not found"),
    description: t(
      "workspace.browser.error.notFound.description",
      "Check the address for typos ({{host}}).",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  addressMissing: (t) => ({
    title: t("workspace.browser.error.notFound.title", "Site not found"),
    description: t(
      "workspace.browser.error.addressMissing.description",
      "Check the address for typos.",
    ),
  }),
  offline: (t) => ({
    title: t("workspace.browser.error.offline.title", "No internet connection"),
    description: t(
      "workspace.browser.error.offline.description",
      "Check your network connection and try again.",
    ),
  }),
  timeout: (t, host) => ({
    title: t("workspace.browser.error.timeout.title", "Connection timed out"),
    description: t(
      "workspace.browser.error.timeout.description",
      "{{host}} took too long to respond.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  interrupted: (t, host) => ({
    title: t("workspace.browser.error.interrupted.title", "Connection interrupted"),
    description: t(
      "workspace.browser.error.interrupted.description",
      "The connection to {{host}} was closed unexpectedly.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  emptyResponse: (t, host) => ({
    title: t("workspace.browser.error.emptyResponse.title", "No response from server"),
    description: t(
      "workspace.browser.error.emptyResponse.description",
      "{{host}} didn't send any data.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  redirectLoop: (t, host) => ({
    title: t("workspace.browser.error.redirectLoop.title", "Too many redirects"),
    description: t(
      "workspace.browser.error.redirectLoop.description",
      "{{host}} redirected you too many times.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  unreachable: (t, host) => ({
    title: t("workspace.browser.error.unreachable.title", "Address unreachable"),
    description: t("workspace.browser.error.unreachable.description", "Could not reach {{host}}.", {
      host: host || t("workspace.browser.error.thisSite", "this site"),
    }),
  }),
  fileMissing: (t) => ({
    title: t("workspace.browser.error.fileMissing.title", "File not found"),
    description: t(
      "workspace.browser.error.fileMissing.description",
      "The requested file could not be found.",
    ),
  }),
  unsafePort: (t) => ({
    title: t("workspace.browser.error.unsafePort.title", "Port blocked"),
    description: t(
      "workspace.browser.error.unsafePort.description",
      "This port is blocked for security reasons.",
    ),
  }),
  localCertificate: (t, host) => ({
    title: t("workspace.browser.error.localCertificate.title", "Connection isn't private"),
    description: t(
      "workspace.browser.error.localCertificate.description",
      "The local HTTPS certificate for {{host}} isn't trusted.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  certificate: (t, host) => ({
    title: t("workspace.browser.error.localCertificate.title", "Connection isn't private"),
    description: t(
      "workspace.browser.error.certificate.description",
      "The security certificate for {{host}} isn't trusted.",
      { host: host || t("workspace.browser.error.thisSite", "this site") },
    ),
  }),
  other: (t, host) => ({
    title: t("workspace.browser.error.other.title", "This page can't be loaded"),
    description: t("workspace.browser.error.other.description", "Could not load {{host}}.", {
      host: host || t("workspace.browser.error.thisPage", "this page"),
    }),
  }),
  outOfMemory: (t) => ({
    title: t("workspace.browser.error.outOfMemory.title", "This page ran out of memory"),
    description: t(
      "workspace.browser.error.outOfMemory.description",
      "Reload the tab to try again.",
    ),
  }),
  crash: (t) => ({
    title: t("workspace.browser.error.crash.title", "This page crashed"),
    description: t(
      "workspace.browser.error.crash.description",
      "Something went wrong while displaying this page. Reload to try again.",
    ),
  }),
  selfRedirect: (t) => ({
    title: t("workspace.browser.error.selfRedirect.title", "Navigation blocked"),
    description: t(
      "workspace.browser.error.selfRedirect.description",
      "Shared browser tabs cannot redirect to Cadencr's own interface.",
    ),
  }),
  internal: (t, _host, detail) => ({
    title: t("workspace.browser.error.internal.title", "Browser error"),
    description: detail,
  }),
};
