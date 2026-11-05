/**
 * `CadencrWorkspace` is the `@codemirror/lsp-client` `Workspace` impl that
 * bridges LSP-driven cross-file navigation (`jumpToDefinition`,
 * `findReferences`, …) into Cadencr's tab system.
 *
 * The default workspace shipped with `@codemirror/lsp-client` errors on
 * multi-view of the same file and has no way to *open* a file the user hasn't
 * opened yet — both required for go-to-definition. We mirror its
 * single-editor-per-URI tracking and override `displayFile(uri)` to delegate
 * tab-opening to a host-provided callback (typically `useEditorStore.openFile`
 * via the LSP client manager).
 */
import { Workspace, LSPPlugin, type WorkspaceFile, type LSPClient } from "@codemirror/lsp-client";
import { ChangeSet, type Extension, type Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { fileUriToPath } from "./file-uri";

/** Mirrors the un-exported `WorkspaceFileUpdate` type from `@codemirror/lsp-client`. */
interface WorkspaceFileUpdate {
  file: WorkspaceFile;
  prevDoc: Text;
  changes: ChangeSet;
}

class CadencrWorkspaceFile implements WorkspaceFile {
  changes: ChangeSet;

  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView,
  ) {
    this.changes = ChangeSet.empty(doc.length);
  }

  getView(): EditorView | null {
    return this.view;
  }
}

/**
 * Host hook the workspace calls when LSP requests displaying a file the user
 * hasn't opened yet. Implementations should open the file in the appropriate
 * pane and resolve to its `EditorView` once mounted; resolve `null` if the
 * file can't be displayed (path outside workspace, etc.).
 *
 * @public
 */
export type DisplayFileHandler = (absPath: string) => Promise<EditorView | null>;

/**
 * How long `displayFile` will wait for the editor for a newly-opened tab to
 * mount before giving up and resolving to `null`. The CodeMirror editor is
 * lazy-loaded behind Suspense — first navigation can take a beat — but if
 * mount never happens, the click should silently no-op rather than hang.
 */
const DISPLAY_FILE_TIMEOUT_MS = 5_000;

/** @public */
export class CadencrWorkspace extends Workspace {
  files: CadencrWorkspaceFile[] = [];
  private fileVersions: Record<string, number> = Object.create(null);
  private displayFileHandler: DisplayFileHandler | null = null;
  /** URIs awaiting their editor view to be created by `openFile`. */
  private pendingDisplays = new Map<string, ((view: EditorView | null) => void)[]>();

  constructor(client: LSPClient) {
    super(client);
  }

  /** CodeMirror deduplicates the stock LSP view plugin. Each additional client
   * still needs its own document lifecycle and pending edits. */
  editorPlugin(uri: string, languageId: string): Extension {
    const lifecycle = ViewPlugin.define((view) => {
      this.openFile(uri, languageId, view);
      return {
        update: (update: ViewUpdate): void => {
          if (!update.docChanged) return;
          const file = this.files.find((entry) => entry.uri === uri);
          if (file?.view === update.view) file.changes = file.changes.compose(update.changes);
        },
        destroy: (): void => this.closeFile(uri, view),
      };
    });
    return [lifecycle, this.client.plugin(uri, languageId)];
  }

  /** Set the host-provided file-opener used by `displayFile`. */
  setDisplayFileHandler(handler: DisplayFileHandler | null): void {
    this.displayFileHandler = handler;
  }

  private nextFileVersion(uri: string): number {
    const next = (this.fileVersions[uri] ?? -1) + 1;
    this.fileVersions[uri] = next;
    return next;
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const result: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const changes = file.changes;
      if (changes.empty) continue;
      result.push({ changes, file, prevDoc: file.doc });
      file.doc = file.view.state.doc;
      file.version = this.nextFileVersion(file.uri);
      file.changes = ChangeSet.empty(file.doc.length);
      const plugin = LSPPlugin.get(file.view);
      if (plugin?.client === this.client) plugin.clear();
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    // Single-view-per-URI: if another pane already shows this file, ignore the
    // second LSP plugin mount rather than throw. The first view drives sync;
    // the second still gets syntax highlighting + plain editing.
    if (!this.getFile(uri)) {
      const file = new CadencrWorkspaceFile(
        uri,
        languageId,
        this.nextFileVersion(uri),
        view.state.doc,
        view,
      );
      this.files.push(file);
      this.client.didOpen(file);
    }
    this.resolvePendingDisplay(uri, view);
  }

  private resolvePendingDisplay(uri: string, view: EditorView | null): void {
    const resolvers = this.pendingDisplays.get(uri);
    if (!resolvers) return;
    this.pendingDisplays.delete(uri);
    for (const resolve of resolvers) resolve(view);
  }

  private waitForDisplay(uri: string): Promise<EditorView | null> {
    return new Promise((resolve) => {
      const arr = this.pendingDisplays.get(uri) ?? [];
      arr.push(resolve);
      this.pendingDisplays.set(uri, arr);
      setTimeout(() => {
        const current = this.pendingDisplays.get(uri);
        if (!current) return;
        const remaining = current.filter((r) => r !== resolve);
        if (remaining.length === 0) {
          this.pendingDisplays.delete(uri);
        } else {
          this.pendingDisplays.set(uri, remaining);
        }
        resolve(null);
      }, DISPLAY_FILE_TIMEOUT_MS);
    });
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.files.find((f) => f.uri === uri);
    if (!file || file.view !== view) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(uri);
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const existing = this.getFile(uri);
    if (existing) return existing.getView();
    const absPath = fileUriToPath(uri);
    if (!absPath) return null;
    if (!this.displayFileHandler) return null;
    // Host has two ways to satisfy the request: return the view directly if
    // it already knows it (rare), or trigger an async tab-open and let our
    // `openFile` resolve the pending entry when CodeMirror mounts the new
    // editor. The race is fine — whichever finishes first wins.
    const waitPromise = this.waitForDisplay(uri);
    const direct = await this.displayFileHandler(absPath);
    if (direct) {
      this.resolvePendingDisplay(uri, direct);
      return direct;
    }
    return await waitPromise;
  }
}
