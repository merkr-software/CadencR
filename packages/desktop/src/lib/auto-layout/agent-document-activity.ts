import { isDocumentFile } from "@/lib/document-file";
import { openDocumentPreview } from "@/lib/open-document-preview";
import type { SessionStatusEntry } from "@/stores/session-status-store";

/**
 * The agent counterpart of clicking a document link: when a PDF / Office / CSV file
 * is written in a feature's tree while its agent is running, show it in the
 * Preview tab. Auto layout's agent guards apply (one reveal per turn, held
 * while the user is arranging panes); with auto layout off the tab only swaps
 * its document, it doesn't take focus.
 *
 * Fed by `editor/file_tree.changed`, whose payload lists the documents written
 * since the previous event (`documents`, most recent last) for the watched
 * feature (`feature_id`).
 */
export function revealAgentDocument(
  payload: Record<string, unknown>,
  bySession: Record<number, SessionStatusEntry>,
): void {
  const featureId = payload.feature_id;
  if (typeof featureId !== "number") return;
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const latest = documents
    .filter((path): path is string => typeof path === "string" && isDocumentFile(path))
    .at(-1);
  if (!latest || !isAgentRunning(featureId, bySession)) return;
  openDocumentPreview({ featureId, layoutFeatureId: featureId, filePath: latest, source: "agent" });
}

function isAgentRunning(featureId: number, bySession: Record<number, SessionStatusEntry>): boolean {
  return Object.values(bySession).some(
    (entry) => entry.featureId === featureId && entry.status === "agent",
  );
}
