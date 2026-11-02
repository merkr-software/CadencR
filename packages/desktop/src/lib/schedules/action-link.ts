/**
 * The Schedules page link that opens the editor on a new custom-action
 * schedule: `/schedules?action=<id>&project=<id>&feature=<id>`. The page reads
 * it once, opens the editor prefilled, and drops it from the URL.
 */

/** Search params of the `/schedules` route. */
export interface SchedulesSearch {
  action?: number;
  project?: number;
  feature?: number;
}

export interface ScheduleActionTarget {
  projectId: number;
  featureId?: number;
  actionId: number;
}

function positiveId(value: unknown): number | undefined {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** `validateSearch` for `/schedules`: unknown or malformed ids are dropped. */
export function parseSchedulesSearch(search: Record<string, unknown>): SchedulesSearch {
  const result: SchedulesSearch = {};
  const action = positiveId(search.action);
  const project = positiveId(search.project);
  const feature = positiveId(search.feature);
  if (action !== undefined) result.action = action;
  if (project !== undefined) result.project = project;
  if (feature !== undefined) result.feature = feature;
  return result;
}

/** The search that opens the editor on `target`. */
export function scheduleActionSearch(target: ScheduleActionTarget): SchedulesSearch {
  return {
    action: target.actionId,
    project: target.projectId,
    ...(target.featureId === undefined ? {} : { feature: target.featureId }),
  };
}

/** The preset a link asks for, or `null` without a complete action + project. */
export function actionTargetFromSearch(search: SchedulesSearch): ScheduleActionTarget | null {
  if (search.action === undefined || search.project === undefined) return null;
  return { actionId: search.action, projectId: search.project, featureId: search.feature };
}
