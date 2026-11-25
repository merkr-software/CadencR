import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { localTimeZone } from "@/lib/schedules/recurrence";
import { useScheduleDraft } from "./useScheduleDraft";

afterEach(async () => {
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
  uiI18n.removeResourceBundle("fr", "ui");
});

it("retranslates branch validation without resetting a draft or a pending save", async () => {
  let finishSave = () => {};
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  const onOpenChange = vi.fn();
  const { result } = renderHook(() =>
    useScheduleDraft({
      open: true,
      initialPrompt: "Inspect @src/report.ts",
      projects: [],
      onSave,
      onOpenChange,
    }),
  );

  const runAt = new Date("2099-05-11T18:30:00Z");
  const formKey = result.current.formKey;
  act(() => {
    const draft = result.current;
    draft.setName("Nightly report");
    draft.setTarget({ kind: "new_conversation", project_id: 2, worktree_mode: "reuse" });
    draft.setPrompt("/review @src/report.ts\nKeep the output in English.");
    draft.setCondition({ enabled: true, command: "pnpm test -- report", timeoutSeconds: 120 });
    draft.setRecurrence({ ...draft.recurrence, runAt });
  });

  expect(result.current.worktreeError).toBe("Pick the branch whose worktree the run should use.");
  expect(result.current.canSave).toBe(false);
  uiI18n.addResourceBundle("fr", "ui", {
    schedules: { editor: { missingReuseBranch: "Sélectionnez la branche à réutiliser." } },
  });
  await act(async () => {
    await uiI18n.changeLanguage("fr");
  });
  expect(result.current.worktreeError).toBe("Sélectionnez la branche à réutiliser.");
  expect(result.current.formKey).toBe(formKey);
  expect(result.current.canSave).toBe(false);

  const target = { ...result.current.target, reuse_branch: "work/report" };
  act(() => result.current.setTarget(target));
  expect(result.current.canSave).toBe(true);

  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.save();
  });
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });

  expect(result.current.formKey).toBe(formKey);
  expect(result.current.busy).toBe(true);
  expect(result.current.canSave).toBe(false);
  expect(onSave).toHaveBeenCalledExactlyOnceWith(
    {
      name: "Nightly report",
      prompt: "/review @src/report.ts\nKeep the output in English.",
      target: {
        kind: "new_conversation",
        project_id: 2,
        worktree_mode: "reuse",
        reuse_branch: "work/report",
      },
      condition: { command: "pnpm test -- report", timeout_seconds: 120 },
      recurrence: { kind: "once", run_at: "2099-05-11T18:30:00.000Z", timezone: localTimeZone() },
      enabled: true,
    },
    undefined,
  );
  expect(onOpenChange).not.toHaveBeenCalled();

  await act(async () => {
    finishSave();
    await pending;
  });
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});
