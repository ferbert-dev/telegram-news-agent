/**
 * Typed twin of `src/quiet-hours.js`.
 *
 * The legacy module stays unchanged as the rollback until the legacy runtime
 * is retired (see CLAUDE.md, "Architecture"). This file is a line-for-line
 * port -- same exported names, constants, defaults, and behaviour, with
 * strict types and no `any`. Do not let the two drift; if a real change is
 * needed here, it needs to be needed in the legacy module too, and that is a
 * deliberate, separately reviewed step.
 */

export const NEWS_SCHEDULE_TIME_ZONE = "Europe/Madrid";
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 8;
export const QUIET_HOURS_LABEL = "22:00–08:00 Europe/Madrid";

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: NEWS_SCHEDULE_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

export function isQuietHoursAt(value: Date | string | number = new Date()): boolean {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Quiet-hours check requires a valid timestamp");
  }
  const hour = Number(hourFormatter.format(date));
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

export interface QuietHoursSettings {
  quietHoursEnabled?: boolean;
}

export function shouldDeferScheduledNews(
  settings: QuietHoursSettings | null | undefined,
  value: Date | string | number = new Date(),
): boolean {
  return Boolean(settings?.quietHoursEnabled) && isQuietHoursAt(value);
}
