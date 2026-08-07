export const NEWS_SCHEDULE_TIME_ZONE = "Europe/Madrid";
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 8;
export const QUIET_HOURS_LABEL = "22:00–08:00 Europe/Madrid";

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: NEWS_SCHEDULE_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

export function isQuietHoursAt(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Quiet-hours check requires a valid timestamp");
  }
  const hour = Number(hourFormatter.format(date));
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

export function shouldDeferScheduledNews(settings, value = new Date()) {
  return Boolean(settings?.quietHoursEnabled) && isQuietHoursAt(value);
}
