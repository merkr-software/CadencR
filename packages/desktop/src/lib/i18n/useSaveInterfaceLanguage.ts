import { useCallback, useMemo, useState } from "react";
import { useSettingWriter } from "@/hooks/useSetting";
import { toastError } from "@/lib/api-errors";
import { loadUiCatalog } from "@/shared/ui-i18n";
import { LANGUAGE_SETTING, type Language } from "./languages";

export function useSaveInterfaceLanguage(system: Language, expectedValue?: string) {
  const { setValue, isSaving } = useSettingWriter(LANGUAGE_SETTING);
  const [preparing, setPreparing] = useState(false);

  const save = useCallback(
    async (value: Language | "system") => {
      setPreparing(true);
      try {
        await loadUiCatalog(value === "system" ? system : value);
        await setValue({ value, expected_value: expectedValue });
      } catch (cause) {
        toastError(cause, "");
      } finally {
        setPreparing(false);
      }
    },
    [system, expectedValue, setValue],
  );

  return useMemo(() => ({ save, busy: preparing || isSaving }), [save, preparing, isSaving]);
}
