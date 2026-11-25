import { z } from "zod";
import { apiErrorMessage } from "@/lib/api-errors";
import { uiI18n, type UiTranslator } from "@/lib/i18n/ui";

const pairingIssue = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum([
      "invalidInput",
      "expired",
      "malformedResponse",
      "unsafeAddress",
      "malformedCode",
      "storageBlocked",
      "signInNotSaved",
      "failed",
    ]),
  }),
  z.object({ kind: z.literal("http"), status: z.number() }),
  z.object({ kind: z.literal("technical"), message: z.string() }),
]);

export type PairingIssue = z.infer<typeof pairingIssue>;

export function formatPairingError(issue: PairingIssue, t: UiTranslator): string {
  switch (issue.kind) {
    case "invalidInput":
      return t(
        "remote.pairing.error.invalidInput",
        "Paste the pairing link or code from your computer.",
      );
    case "expired":
      return t(
        "remote.pairing.error.expired",
        "This pairing code has expired. Generate a fresh one on the host computer.",
      );
    case "malformedResponse":
      return t("remote.pairing.error.malformedResponse", "The pairing response was malformed.");
    case "unsafeAddress":
      return t(
        "remote.pairing.error.unsafeAddress",
        "Could not remove the pairing code from this page's address. Pairing was stopped.",
      );
    case "malformedCode":
      return t(
        "remote.pairing.error.malformedCode",
        "The pairing code is malformed. Generate a new link on the host.",
      );
    case "storageBlocked":
      return t(
        "remote.pairing.error.storageBlocked",
        "Paired, but this browser blocks storage — you'll need to re-pair after a reload.",
      );
    case "signInNotSaved":
      return t(
        "remote.pairing.error.signInNotSaved",
        "Paired, but this browser couldn't save the sign-in. Try another browser.",
      );
    case "failed":
      return t("remote.pairing.error.failed", "Pairing failed.");
    case "http":
      return t("remote.pairing.error.http", "Pairing failed (HTTP {{status}}).", {
        status: issue.status,
      });
    case "technical":
      return issue.message;
  }
}

const englishText = uiI18n.getFixedT("en", "ui");

export class PairingError extends Error {
  constructor(readonly issue: PairingIssue) {
    super(formatPairingError(issue, englishText));
  }
}

export function pairingIssueFromError(error: unknown): PairingIssue {
  if (error instanceof PairingError) return error.issue;
  const message = apiErrorMessage(error, "");
  return message ? { kind: "technical", message } : { kind: "failed" };
}

export function parsePairingIssue(raw: string): PairingIssue {
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = pairingIssue.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch (error) {
    // Older renderers stored the plain error message for the next mount.
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { kind: "technical", message: raw };
}
