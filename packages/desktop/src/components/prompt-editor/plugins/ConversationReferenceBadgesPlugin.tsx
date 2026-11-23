import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, type LexicalEditor, type NodeKey } from "lexical";
import { featureProjectIdQueryOptions } from "@/hooks/useFeatureProjectId";
import { useProjectColor } from "@/hooks/useProjectColor";
import { useProjectIconUrl } from "@/hooks/useProjectIcon";
import {
  $isConversationReferenceNode,
  applyConversationProjectBadge,
  ConversationReferenceNode,
} from "../nodes/ConversationReferenceNode";

interface MountedReference {
  featureId: number;
  /**
   * Editor-wide counter value of the node's last `created`/`updated` mutation.
   * Lexical gives a node a new element when undo/redo restores it or its parent
   * is re-created, and reports it as a mutation, so a new value means "paint the
   * badge again". Monotonic, so a key destroyed and recreated within one React
   * batch still reads as changed.
   */
  revision: number;
}

interface ProjectReferences {
  projectId: number;
  /** Node keys of this project's chips, space-separated: a stable effect dependency. */
  nodeKeys: string;
  /** Highest revision among them: grows whenever any of them is (re)created. */
  revision: number;
}

/**
 * Paints each `@@` chip with its project's badge (logo, else color dot).
 *
 * The chip is a Lexical text node, so React cannot render inside it: the badge
 * is a `::before` the node's class draws from CSS variables, and this plugin
 * sets those variables once the conversation's project is known. Chips are
 * grouped by project, so a project's logo is resolved once for all its chips.
 */
export function ConversationReferenceBadgesPlugin(): ReactNode {
  const [editor] = useLexicalComposerContext();
  const references = useMountedReferences(editor);
  const groups = useProjectReferences(references);
  return groups.map((group) => (
    <ProjectBadgeStyle key={group.projectId} editor={editor} {...group} />
  ));
}

function useMountedReferences(editor: LexicalEditor): ReadonlyMap<NodeKey, MountedReference> {
  const [references, setReferences] = useState<ReadonlyMap<NodeKey, MountedReference>>(
    () => new Map(),
  );
  const revisionRef = useRef(0);
  useEffect(
    () =>
      editor.registerMutationListener(ConversationReferenceNode, (mutations) => {
        const changes = new Map<NodeKey, MountedReference | null>();
        editor.getEditorState().read(() => {
          for (const [nodeKey, mutation] of mutations) {
            const node = mutation === "destroyed" ? null : $getNodeByKey(nodeKey);
            changes.set(
              nodeKey,
              $isConversationReferenceNode(node)
                ? { featureId: node.getFeatureId(), revision: ++revisionRef.current }
                : null,
            );
          }
        });
        setReferences((current) => {
          const next = new Map(current);
          for (const [nodeKey, reference] of changes) {
            if (reference === null) next.delete(nodeKey);
            else next.set(nodeKey, reference);
          }
          return next;
        });
      }),
    [editor],
  );
  return references;
}

/** Module-level, so `useQueries` keeps the same array while no result changes. */
function projectIdsOf(results: { data: number | undefined }[]): (number | null)[] {
  return results.map((result) => result.data ?? null);
}

function useProjectReferences(
  references: ReadonlyMap<NodeKey, MountedReference>,
): ProjectReferences[] {
  const queryClient = useQueryClient();
  const featureIds = useMemo(
    () => [...new Set(Array.from(references.values(), (reference) => reference.featureId))],
    [references],
  );
  const projectIds = useQueries({
    queries: featureIds.map((featureId) => featureProjectIdQueryOptions(queryClient, featureId)),
    combine: projectIdsOf,
  });
  return useMemo(() => {
    const projectByFeature = new Map(
      featureIds.map((featureId, index) => [featureId, projectIds[index]]),
    );
    const groups = new Map<number, { nodeKeys: NodeKey[]; revision: number }>();
    for (const [nodeKey, reference] of references) {
      const projectId = projectByFeature.get(reference.featureId);
      if (projectId == null) continue;
      const group = groups.get(projectId) ?? { nodeKeys: [], revision: 0 };
      group.nodeKeys.push(nodeKey);
      group.revision = Math.max(group.revision, reference.revision);
      groups.set(projectId, group);
    }
    return Array.from(groups, ([projectId, group]) => ({
      projectId,
      nodeKeys: group.nodeKeys.join(" "),
      revision: group.revision,
    }));
  }, [featureIds, projectIds, references]);
}

const ProjectBadgeStyle = memo(function ProjectBadgeStyle({
  editor,
  projectId,
  nodeKeys,
  revision,
}: ProjectReferences & { editor: LexicalEditor }): null {
  const color = useProjectColor(projectId);
  const iconUrl = useDecodableImageUrl(useProjectIconUrl(projectId));
  useLayoutEffect(() => {
    const elements = nodeKeys
      .split(" ")
      .map((nodeKey) => editor.getElementByKey(nodeKey))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of elements) applyConversationProjectBadge(element, { color, iconUrl });
    return () => {
      for (const element of elements) applyConversationProjectBadge(element, null);
    };
  }, [color, editor, iconUrl, nodeKeys, revision]);
  return null;
});

/**
 * `url`, unless the browser failed to decode it. A CSS background has no error
 * event, so this probes the image once and falls back to `null` (the color dot)
 * on failure, as `ProjectBadge`'s `onError` does — without delaying the logo.
 */
function useDecodableImageUrl(url: string | null): string | null {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const image = new Image();
    image.onerror = () => setFailedUrl(url);
    image.src = url;
    return () => {
      image.onerror = null;
    };
  }, [url]);
  return url !== failedUrl ? url : null;
}
