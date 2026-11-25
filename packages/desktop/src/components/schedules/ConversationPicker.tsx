import { useUiTranslation } from "@/lib/i18n/ui";
import { useMemo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { useListFeatures } from "@/api/generated";
import { PickerPlaceholder, SchedulePicker } from "./SchedulePicker";

export interface ConversationPickerProps {
  /** Project whose conversations are listed; unset until one is picked. */
  projectId?: number | null;
  featureId?: number | null;
  /** Title of the selected conversation, for when it isn't in the listed set
   *  (archived, or belonging to another project). */
  fallbackTitle?: string | null;
  onChange: (featureId: number) => void;
}

/** Searchable list of a project's conversations. */
export function ConversationPicker({
  projectId,
  featureId,
  fallbackTitle,
  onChange,
}: ConversationPickerProps): ReactElement {
  const { t } = useUiTranslation();
  const query = useListFeatures(
    { project_id: projectId ?? 0 },
    { query: { enabled: projectId != null } },
  );
  const options = useMemo(
    () =>
      (Array.isArray(query.data) ? query.data : []).map((feature) => ({
        value: feature.id,
        label: feature.title,
      })),
    [query.data],
  );

  if (projectId == null) {
    return (
      <PickerPlaceholder>
        {t("schedules.picker.chooseProjectFirst", "Pick a project first.")}
      </PickerPlaceholder>
    );
  }
  if (query.isLoading) {
    return (
      <PickerPlaceholder aria-busy="true">
        <Loader2 className="size-3.5 animate-spin" />
        {t("schedules.picker.loadingConversations", "Loading conversations…")}
      </PickerPlaceholder>
    );
  }
  if (query.isError) {
    return (
      <PickerPlaceholder className="border-destructive/40 text-destructive">
        {t(
          "schedules.picker.loadConversationsFailed",
          "Could not load this project's conversations.",
        )}
      </PickerPlaceholder>
    );
  }
  if (options.length === 0) {
    return (
      <PickerPlaceholder>
        {t("schedules.picker.noConversations", "This project has no conversations yet.")}
      </PickerPlaceholder>
    );
  }

  return (
    <SchedulePicker
      ariaLabel={t("schedules.editor.conversation", "Conversation")}
      searchLabel={t("schedules.picker.searchConversation", "Search conversation")}
      options={options}
      value={featureId}
      fallbackLabel={fallbackTitle}
      placeholder={t("schedules.picker.chooseConversation", "Pick a conversation…")}
      searchPlaceholder={t(
        "schedules.picker.searchConversationsPlaceholder",
        "Search conversations…",
      )}
      emptyLabel={t("schedules.picker.noMatchingConversations", "No matching conversations.")}
      onChange={onChange}
    />
  );
}
