/**
 * Where the composer's keys go while a skill wizard is open. With focus in the
 * wizard — or in a picker one of its controls has open, which Radix portals
 * out of it — the composer shortcuts (mode, model, effort, worktree, Esc) set
 * the session the skill spawns; anywhere else they keep driving this
 * conversation's session, whose own handlers bail out on `focusInSkillWizard`.
 */
const WIZARD = "[data-virtual-skill-wizard]";
const PORTALED_POPOVER = "[data-radix-popper-content-wrapper]";

/** Whether focus on `target` belongs to `wizard`. */
export function wizardHolds(wizard: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (wizard.contains(target)) return true;
  // Only a picker this wizard opened: its trigger is the one left expanded.
  return (
    target.closest(PORTALED_POPOVER) !== null &&
    wizard.querySelector('[aria-expanded="true"]') !== null
  );
}

/** Whether `wizard` owns the composer's keys right now. */
export function wizardOwnsKeys(wizard: Element): boolean {
  const active = document.activeElement;
  // A control swapped under focus (a picked model replaces "Agent picks the
  // model") drops focus to <body> without a blur: the wizard that had the keys
  // keeps them until its focus is restored.
  if (active === document.body) return wizard.hasAttribute("data-keys-active");
  return wizardHolds(wizard, active);
}

/** Whether a skill wizard inside `scope` owns the keys; pass the composer's root. */
export function focusInSkillWizard(scope: ParentNode = document): boolean {
  return Array.from(scope.querySelectorAll(WIZARD)).some(wizardOwnsKeys);
}
