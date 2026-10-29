import type { ReactElement } from "react";
import {
  ChoiceControl,
  ResetDisplayOptionsButton,
  RowElementGrid,
  useSidebarDisplayForm,
  type SidebarDisplayForm,
} from "@/components/SidebarDisplayOptions";
import { ROW_ELEMENTS_DESCRIPTION } from "@/components/sidebar-display-rows";
import { SidebarConfiguratorSteps } from "@/components/SidebarConfiguratorSteps";
import {
  SECTION_ORDER_DESCRIPTION,
  SidebarSectionOrderList,
} from "@/components/SidebarSectionOrder";
import {
  DISPLAY_GROUPS,
  resolveDisplayItem,
  type DisplayItem,
} from "@/components/sidebar-display-groups";
import { useSidebarOptionHighlight } from "@/hooks/useSidebarOptionHighlight";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SidebarPreviewPanel } from "./SidebarPreviewPanel";

/** Rows a notch denser than the app's other settings: the section lists every display option. */
const DENSE_ROW = "py-3";

/** In a narrow card (beside the preview, or a small window) controls go under their description. */
const STACKED = `${DENSE_ROW} @max-xl:flex-col @max-xl:items-start @max-xl:gap-2`;

/**
 * The sidebar's display options as settings rows, grouped like the popover,
 * beside a live preview filled with sample conversations. The sidebar's header
 * popover edits the same values in a compact layout.
 */
export function SidebarSection(): ReactElement {
  const form = useSidebarDisplayForm();
  const highlight = useSidebarOptionHighlight();

  return (
    <SettingsSection
      id="sidebar-display"
      title="Sidebar"
      subtitle="Presets · Density · Rows · Blocks · Attention"
      description="Also available from the sliders button in the sidebar's Projects header. Changes apply immediately and follow you to remote devices. Point at an option to see what it changes in the preview."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
        <div className="lg:sticky lg:top-6 lg:order-last">
          <SidebarPreviewPanel />
        </div>
        {/* One card per group, its name above it: the groups read as a list of
            lists rather than one long card of look-alike rows. */}
        <fieldset
          disabled={form.disabled}
          className="@container flex min-w-0 flex-col gap-5"
          {...highlight}
        >
          <SidebarConfiguratorSteps form={form} wide>
            {DISPLAY_GROUPS.map((group) => (
              <section key={group.id} aria-label={group.label} className="flex flex-col gap-2">
                <h4 className="px-1 text-xs font-semibold text-muted-foreground">{group.label}</h4>
                <SettingsCard>
                  {group.items.map((item, index) => (
                    <SettingsItem key={item} form={form} item={item} divided={index > 0} />
                  ))}
                </SettingsCard>
              </section>
            ))}
          </SidebarConfiguratorSteps>
          <SettingsCard>
            <SettingsRow
              className={DENSE_ROW}
              label="Reset display options"
              description="Restore every option above to its default."
              control={<ResetDisplayOptionsButton form={form} variant="outline" size="sm" />}
            />
          </SettingsCard>
        </fieldset>
      </div>
    </SettingsSection>
  );
}

function SettingsItem({
  form,
  item,
  divided,
}: {
  form: SidebarDisplayForm;
  item: DisplayItem;
  divided: boolean;
}): ReactElement {
  const resolved = resolveDisplayItem(item);
  if (resolved.kind === "sectionOrder") {
    return (
      <div data-sidebar-option="sectionOrder">
        <SettingsRow
          divided={divided}
          align="start"
          className={STACKED}
          label="Block order"
          description={SECTION_ORDER_DESCRIPTION}
          control={
            <div className="w-56">
              <SidebarSectionOrderList form={form} />
            </div>
          }
        />
      </div>
    );
  }
  if (resolved.kind === "rowElements") {
    return (
      <SettingsRow
        divided={divided}
        align="start"
        className={STACKED}
        label="Show in rows"
        description={ROW_ELEMENTS_DESCRIPTION}
        control={<RowElementGrid form={form} className="gap-x-6 gap-y-2" />}
      />
    );
  }
  if (resolved.kind === "choice") {
    const { row } = resolved;
    return (
      <div data-sidebar-option={row.id}>
        <SettingsRow
          divided={divided}
          className={STACKED}
          label={row.label}
          description={row.description}
          control={<ChoiceControl form={form} row={row} />}
        />
      </div>
    );
  }
  const { row } = resolved;
  return (
    <div data-sidebar-option={row.id}>
      <SettingsSwitchRow
        divided={divided}
        className={DENSE_ROW}
        label={row.label}
        description={row.description}
        checked={form.config[row.id]}
        onCheckedChange={(checked) => form.setOption(row.id, checked)}
      />
    </div>
  );
}
