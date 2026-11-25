import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";
import {
  CodeIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  LoaderCircle,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import type { PluginTabSummary } from "@/api/generated";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { IconTile } from "@/components/settings/IconTile";
import { SETTINGS_ANCHORS } from "@/components/settings/settings-anchor-ids";
import { useSetting } from "@/hooks/useSetting";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  builtinTabLabel,
  NO_TAB_REPLACEMENTS,
  REPLACEABLE_TABS,
  parseTabReplacements,
  readTabReplacements,
  serializeTabReplacements,
  TAB_REPLACEMENTS_KEY,
  withTabReplacement,
  type ReplaceableTab,
  type TabReplacementChoices,
} from "@/lib/plugin-tabs/tab-replacements";
import { cn } from "@/lib/utils";
import type { CustomTabsData } from "./useCustomTabsData";
import {
  candidateLabel,
  describeReplacement,
  replacementSlots,
  type ReplacementSlot,
} from "./replacement-model";
import { SuppressingSelect } from "./SuppressingSelect";

const BUILTIN_VALUE = "builtin";

const SLOT_ICONS: Record<ReplaceableTab, LucideIcon> = {
  terminal: TerminalIcon,
  git: GitCompareArrowsIcon,
  editor: CodeIcon,
  preview: FileTextIcon,
};

/**
 * Settings → Custom tabs → Replace built-in tabs: for each built-in a custom
 * tab says it can replace (`tab.replaces`), which one shows in its place
 * (docs/CUSTOM_TABS.md §10). One choice per built-in, and a tab replaces one
 * built-in at a time. Always rendered: search results scroll to it.
 */
export function CustomTabReplacements({ data }: { data: CustomTabsData }): React.JSX.Element {
  const { t } = useUiTranslation();
  const setting = useSetting(TAB_REPLACEMENTS_KEY);
  const { setValue } = setting;
  const stored = useMemo(() => readTabReplacements(setting.value, t), [setting.value, t]);
  const choices = stored.value ?? NO_TAB_REPLACEMENTS;
  // A list that failed to load would call every stored choice uninstalled.
  const slots = useMemo(
    () => (data.error ? [] : replacementSlots(data.tabs, choices)),
    [choices, data.error, data.tabs],
  );
  const choose = useCallback(
    (tab: ReplaceableTab, tabId: string | null) =>
      // From the confirmed value, so two quick choices both land.
      void setValue((confirmed) =>
        serializeTabReplacements(withTabReplacement(parseTabReplacements(confirmed), tab, tabId)),
      ),
    [setValue],
  );
  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.tabReplacements}
      title={t("customTabs.customTabReplacements.replaceBuiltInTabs", "Replace built-in tabs")}
      description={t(
        "customTabs.customTabReplacements.aCustomTabPickedHereTakesThe",
        "A custom tab picked here takes the built-in's place and shortcut in every conversation where it is on. Cadencr still opens the built-in when it has a file, pull request, document or command to show; switch back from the tab strip's + menu.",
      )}
    >
      <ReplacementsNotice
        loading={data.isLoading || setting.isLoading}
        error={
          data.error
            ? apiErrorMessage(
                data.error,
                t("customTabs.replacements.loadError", "Could not load your custom tabs."),
              )
            : stored.error &&
              t(
                "customTabs.replacements.storedChoiceIgnored",
                "The stored choice was ignored: {{error}}.",
                { error: stored.error },
              )
        }
        empty={slots.length === 0}
      />
      {slots.map((slot, index) => (
        <ReplacementRow
          key={slot.tab}
          slot={slot}
          tabs={data.tabs}
          choices={choices}
          overridesFor={data.overridesFor}
          saving={setting.isSaving || setting.isLoading}
          divided={index > 0}
          onChoose={choose}
        />
      ))}
    </SettingsGroup>
  );
}

function ReplacementsNotice({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
}): React.JSX.Element | null {
  const { t, i18n } = useUiTranslation();
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        {t("customTabs.replacements.loading", "Loading tab replacements…")}
      </p>
    );
  }
  if (error) return <p className="px-5 py-4 text-xs leading-snug text-destructive">{error}</p>;
  if (!empty) return null;
  return (
    <p className="px-5 py-4 text-xs leading-snug text-muted-foreground">
      <UiTrans
        i18nKey="customTabs.replacements.unavailableDescription"
        defaults="None of your custom tabs offers to replace {{tabs}}. A tab offers it with <property/> in its <file/>."
        values={{
          tabs: new Intl.ListFormat(i18n.language, { type: "disjunction" }).format(
            REPLACEABLE_TABS.map((tab) => builtinTabLabel(tab, t)),
          ),
        }}
        components={{
          property: <code className="font-mono">tab.replaces</code>,
          file: <code className="font-mono">tab.json</code>,
        }}
      />
    </p>
  );
}

function ReplacementRow({
  slot,
  tabs,
  choices,
  overridesFor,
  saving,
  divided,
  onChoose,
}: {
  slot: ReplacementSlot;
  tabs: readonly PluginTabSummary[];
  choices: TabReplacementChoices;
  overridesFor: CustomTabsData["overridesFor"];
  saving: boolean;
  divided: boolean;
  onChoose: (tab: ReplaceableTab, tabId: string | null) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const builtin = builtinTabLabel(slot.tab, t);
  const Icon = SLOT_ICONS[slot.tab];
  const status = describeReplacement(slot, tabs, overridesFor, t);
  const options = [
    {
      value: BUILTIN_VALUE,
      label: t("customTabs.replacements.builtinOption", "Built-in {{builtin}}", { builtin }),
    },
    ...slot.candidates.map((summary) => ({
      value: summary.id,
      label: candidateLabel(summary, slot.tab, choices, t),
    })),
    // A stored choice that is no longer a candidate stays selectable, so the
    // select shows it rather than going blank.
    ...(slot.chosenId && !slot.candidates.some((summary) => summary.id === slot.chosenId)
      ? [
          {
            value: slot.chosenId,
            label: tabs.find((summary) => summary.id === slot.chosenId)?.label ?? slot.chosenId,
          },
        ]
      : []),
  ];
  return (
    <SettingsRow
      divided={divided}
      align="start"
      icon={
        <IconTile>
          <Icon className="size-4" aria-hidden />
        </IconTile>
      }
      label={builtin}
      description={
        <span className={cn(status.tone === "warning" && "text-[var(--acc-orange)]")}>
          {status.text}
        </span>
      }
      control={
        <>
          {saving ? (
            <LoaderCircle
              className="size-3.5 animate-spin text-muted-foreground"
              aria-label={t(
                "customTabs.replacements.savingLabel",
                "Saving the {{builtin}} replacement",
                { builtin },
              )}
            />
          ) : null}
          <SuppressingSelect
            value={slot.chosenId ?? BUILTIN_VALUE}
            options={options}
            disabled={saving}
            ariaLabel={t(
              "customTabs.replacements.choiceLabel",
              "Tab shown in place of {{builtin}}",
              { builtin },
            )}
            onValueChange={(value) => onChoose(slot.tab, value === BUILTIN_VALUE ? null : value)}
          />
        </>
      }
    />
  );
}
